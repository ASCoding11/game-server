// One RelayRoom per game room code (for example "cl-4821"). It holds the same data the game used to keep under
// rooms/<code> in Firebase and passes every change on to the other players, the way Firebase did, but from a
// server near the players and without per-gigabyte download charges.
//
// Messages from the page (all answered, so the page knows each write landed):
//   op    {o:'s'|'u'|'r', p, v}         set / update / remove at path p (relative to the room)
//   cas   {p, expect, v}                write v only if the value at p is still `expect` (transactions)
//   od    {k:'s'|'u'|'r'|'c', p, v}     on-disconnect writes ('c' cancels the ones at or under p)
//   sync  {}                            the whole room again (after a reconnect)
//   time  {}                            the server clock
// Messages to the page:
//   hello {uid, now, tree}              sent once on join
//   x     op                            someone else's write, with server values filled in
import { Room } from '@colyseus/core';
import { splitPath, getAt, applyOp, resolveOp, expand, same, clean } from './tree.js';

// A room code: most games use <prefix>-<code> (cl-4821, ss-pub-2); Rumble Karts' codes have no prefix (lobby-2, maple42).
export const ROOM_KEY = /^[A-Za-z0-9][A-Za-z0-9_-]{0,44}$/;
export const live = new Map();          // room code -> RelayRoom, for /peek

const LINGER_MS = 2 * 60 * 1000;        // keep an empty room's data this long, like a refresh or a quick rejoin needs
const RECONNECT_S = 15;                 // a dropped player has this long to come back before their disconnect writes run
const MAX_OP_BYTES = 64 * 1024;
const MAX_ROOM_BYTES = 2 * 1024 * 1024;
const RATE = 120, BURST = 240;          // writes per second per player (games send 10-20)

export class RelayRoom extends Room {
  maxClients = 40;
  autoDispose = false;

  onCreate(options) {
    const key = options && options.room;
    if (typeof key !== 'string' || !ROOM_KEY.test(key)) throw new Error('Bad room code');
    if (live.has(key)) throw new Error('That room is full');
    this.key = key;
    this.tree = null;
    this.od = new Map();                // sessionId -> Map(path -> op)
    this.full = false;
    this.lingerT = null;
    live.set(key, this);
    this.setMetadata({ room: key });
    // Room size check every 10 s; a room that grows past the cap only accepts removals until it shrinks.
    this.clock.setInterval(() => { this.full = JSON.stringify(this.tree || {}).length > MAX_ROOM_BYTES; }, 10000);

    this.onMessage('op', (client, msg) => this.handleOp(client, msg));
    this.onMessage('cas', (client, msg) => this.handleCas(client, msg));
    this.onMessage('od', (client, msg) => this.handleOd(client, msg));
    this.onMessage('sync', () => ({ now: Date.now(), tree: this.tree }));
    this.onMessage('time', () => Date.now());
  }

  async onAuth(client, options) {
    const verify = this.constructor.verify;
    if (!verify) throw new Error('Server not configured');
    return verify(options && options.token);
  }

  onJoin(client, options, auth) {
    if (this.lingerT) { this.lingerT.clear(); this.lingerT = null; }
    client.userData = { uid: auth.uid, bucket: BURST, at: Date.now() };
    client.send('hello', { uid: auth.uid, now: Date.now(), tree: this.tree });
  }

  onDrop(client) {
    // Brief Wi-Fi drops shouldn't count as leaving: hold the seat and the disconnect writes for a few seconds.
    this.allowReconnection(client, RECONNECT_S);
  }

  onReconnect(client) {
    client.send('hello', { uid: client.userData.uid, now: Date.now(), tree: this.tree });
  }

  onLeave(client) {
    const ops = this.od.get(client.sessionId);
    this.od.delete(client.sessionId);
    if (ops) for (const op of ops.values()) this.commit(op, null);
    if (this.clients.length === 0) this.lingerT = this.clock.setTimeout(() => this.disconnect(), LINGER_MS);
  }

  onDispose() {
    if (live.get(this.key) === this) live.delete(this.key);
  }

  // ---- writes ----

  allowed(uid, op) {
    // A player may only write their own players/<uid> entry. Anyone may remove an entry or the whole room
    // (games clean up players who have gone), and anything else in the room is shared, as it was in Firebase.
    for (const [segs, v] of expand(op)) {
      const removing = clean(v) === null;
      if (segs.length === 0 && !removing) return false;
      if (segs[0] === 'players') {
        if (segs.length === 1 && !removing) return false;
        if (segs.length >= 2 && segs[1] !== uid && !removing) return false;
      }
    }
    return true;
  }

  check(client, msg) {
    const u = client.userData;
    const t = Date.now();
    u.bucket = Math.min(BURST, u.bucket + (t - u.at) * RATE / 1000);
    u.at = t;
    if (u.bucket < 1) return 'Too many writes';
    u.bucket -= 1;
    if (!msg || typeof msg !== 'object') return 'Bad write';
    if (typeof msg.p !== 'string' || msg.p.length > 512) return 'Bad path';
    let size = 0;
    try { size = JSON.stringify(msg).length; } catch (e) { return 'Bad value'; }
    if (size > MAX_OP_BYTES) return 'Write too large';
    return null;
  }

  validOp(msg) {
    return msg && (msg.o === 's' || msg.o === 'u' || msg.o === 'r') && typeof msg.p === 'string';
  }

  // Applies an op, tells everyone except `from`, and returns the op with server values filled in.
  commit(op, from) {
    const now = Date.now();
    const resolved = resolveOp(this.tree, { o: op.o, p: op.p, v: op.v }, now);
    this.tree = applyOp(this.tree, resolved, now);
    this.broadcast('x', resolved, from ? { except: from } : undefined);
    return resolved;
  }

  handleOp(client, msg) {
    const bad = this.check(client, msg) || (!this.validOp(msg) && 'Bad write');
    if (bad) return { err: bad };
    if (!this.allowed(client.userData.uid, msg)) return { err: 'permission_denied', cur: getAt(this.tree, splitPath(msg.p)) };
    if (this.full && !(msg.o === 'r' || (msg.o === 's' && clean(msg.v) === null))) return { err: 'Room is full of data' };
    const r = this.commit(msg, client);
    return r === msg || r.v === msg.v ? { ok: 1 } : { ok: 1, v: r.v };
  }

  handleCas(client, msg) {
    const bad = this.check(client, msg);
    if (bad) return { err: bad };
    const segs = splitPath(msg.p), cur = getAt(this.tree, segs);
    if (!same(clean(cur), clean(msg.expect))) return { err: 'conflict', cur };
    const op = { o: 's', p: msg.p, v: msg.v };
    if (!this.allowed(client.userData.uid, op)) return { err: 'permission_denied', cur };
    const r = this.commit(op, client);
    return { ok: 1, v: r.v };
  }

  handleOd(client, msg) {
    const bad = this.check(client, msg);
    if (bad) return { err: bad };
    let ops = this.od.get(client.sessionId);
    if (!ops) this.od.set(client.sessionId, ops = new Map());
    const p = splitPath(msg.p).join('/');
    if (msg.k === 'c') {
      for (const k of [...ops.keys()]) if (k === p || k.startsWith(p + '/') || p === '') ops.delete(k);
      return { ok: 1 };
    }
    const op = { o: msg.k, p, v: msg.v };
    if (!this.validOp(op)) return { err: 'Bad write' };
    if (!this.allowed(client.userData.uid, op)) return { err: 'permission_denied' };
    if (ops.size >= 32 && !ops.has(p)) return { err: 'Too many disconnect writes' };
    ops.set(p, op);
    return { ok: 1 };
  }
}
