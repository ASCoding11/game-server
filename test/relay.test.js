// End-to-end tests: a real relay server, and several copies of the browser shim (netrelay.js) talking to it the way
// game pages would. Run with `npm test`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as Colyseus from '@colyseus/sdk';
import { start } from '../src/index.js';
import { live } from '../src/RelayRoom.js';

// Cut a player's connection from the server side, the way a Wi-Fi drop looks (no goodbye from the page).
function cut(key, uid) { for (const c of live.get(key).clients) if (c.userData.uid === uid) c.ref.terminate(); }

const PORT = 2601;
const SRC = fs.readFileSync(new URL('../client/netrelay.js', import.meta.url), 'utf8');
let server;
const pages = [];

// One "browser tab": its own copy of the shim, signed in as `uid`.
function page(uid) {
  const win = { Colyseus };
  new Function('window', SRC)(win);
  win.NetRelay.config({ url: 'ws://localhost:' + PORT, getToken: () => uid });
  const fbCalls = [];
  const fakeFirebase = { ref: p => { fbCalls.push(p); return { firebase: true, path: p }; } };
  const db = win.NetRelay.database(fakeFirebase, id => /^cl-/.test(id));
  const p = { uid, win, db, fbCalls };
  pages.push(p);
  return p;
}
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 3000) {
  const t = Date.now();
  while (Date.now() - t < ms) { if (fn()) return; await wait(20); }
  throw new Error('timed out waiting');
}

before(async () => {
  server = await start({ port: PORT, verify: async tok => ({ uid: String(tok) }) });
});
after(async () => {
  for (const p of pages) for (const c of Object.values(p.win.NetRelay._conns)) if (c.room) await c.room.leave(true).catch(() => {});
  await server.gracefullyShutdown(false);
});

test('players see each other join, move and leave', async () => {
  const a = page('alice'), b = page('bob');
  const seen = {}, removed = [];
  const players = b.db.ref('rooms/cl-1/players');
  players.on('child_added', s => { seen[s.key] = s.val(); });
  players.on('child_changed', s => { seen[s.key] = s.val(); });
  players.on('child_removed', s => { removed.push(s.key); delete seen[s.key]; });
  await a.db.ref('rooms/cl-1/players/alice').set({ x: 1, z: 2, n: 'Alice' });
  await until(() => seen.alice && seen.alice.x === 1);
  await a.db.ref('rooms/cl-1/players/alice').update({ x: 5 });
  await until(() => seen.alice.x === 5);
  assert.equal(seen.alice.n, 'Alice');
  await a.db.ref('rooms/cl-1/players/alice').remove();
  await until(() => removed.includes('alice'));
});

test('a value listener fires once at first, then on each change', async () => {
  const a = page('ann'), b = page('ben');
  const vals = [];
  b.db.ref('rooms/cl-2/round').on('value', s => vals.push(s.val()));
  await until(() => vals.length === 1);
  assert.equal(vals[0], null);
  await a.db.ref('rooms/cl-2/round').set({ id: 1, sz: 2 });
  await until(() => vals.length === 2);
  assert.deepEqual(vals[1], { id: 1, sz: 2 });
  await a.db.ref('rooms/cl-2/round').set({ id: 1, sz: 2 });   // same value: no extra event
  await wait(150);
  assert.equal(vals.length, 2);
});

test("you can't write someone else's player entry, but you can remove it", async () => {
  const a = page('amy'), b = page('bo');
  await a.db.ref('rooms/cl-3/players/amy').set({ x: 1 });
  await assert.rejects(b.db.ref('rooms/cl-3/players/amy').set({ x: 99 }), /PERMISSION_DENIED/);
  const s = await b.db.ref('rooms/cl-3/players/amy').once('value');
  assert.deepEqual(s.val(), { x: 1 });
  await b.db.ref('rooms/cl-3/players/amy').remove();
  await until(() => !a.win.NetRelay._conns['cl-3'].tree || !a.win.NetRelay._conns['cl-3'].tree.players);
  const s2 = await a.db.ref('rooms/cl-3/players/amy').once('value');
  assert.equal(s2.exists(), false);
});

test('server timestamps become the same number for everyone', async () => {
  const a = page('ali'), b = page('bea');
  let got = null;
  b.db.ref('rooms/cl-4/events').on('child_added', s => { got = s.val(); });
  const before = Date.now();
  a.db.ref('rooms/cl-4/events').push({ by: 'ali', t: { '.sv': 'timestamp' } });
  await until(() => got);
  assert.equal(typeof got.t, 'number');
  assert.ok(Math.abs(got.t - before) < 2000);
  const mine = (await a.db.ref('rooms/cl-4/events').once('value')).val();
  assert.equal(Object.values(mine)[0].t, got.t);
});

test('onDisconnect removes a player who leaves', async () => {
  const a = page('abe'), b = page('bill');
  const removed = [];
  b.db.ref('rooms/cl-5/players').on('child_removed', s => removed.push(s.key));
  const me = a.db.ref('rooms/cl-5/players/abe');
  await me.set({ x: 1 });
  await me.onDisconnect().remove();
  await wait(100);
  await a.win.NetRelay._conns['cl-5'].room.leave(true);
  await until(() => removed.includes('abe'));
});

test('onDisconnect().cancel() keeps the entry', async () => {
  const a = page('ava'), b = page('bree');
  const me = a.db.ref('rooms/cl-6/players/ava');
  await me.set({ x: 1 });
  await me.onDisconnect().remove();
  await me.onDisconnect().cancel();
  await b.db.ref('rooms/cl-6/players').once('value');
  await a.win.NetRelay._conns['cl-6'].room.leave(true);
  await wait(300);
  const s = await b.db.ref('rooms/cl-6/players/ava').once('value');
  assert.deepEqual(s.val(), { x: 1 });
});

test('transactions from two players never lose a count', async () => {
  const a = page('al'), b = page('bud');
  const inc = p => p.db.ref('rooms/cl-7/count').transaction(n => (n || 0) + 1);
  const jobs = [];
  for (let i = 0; i < 10; i++) { jobs.push(inc(a)); jobs.push(inc(b)); }
  const res = await Promise.all(jobs);
  assert.ok(res.every(r => r.committed));
  const s = await a.db.ref('rooms/cl-7/count').once('value');
  assert.equal(s.val(), 20);
});

test('reading a room before joining it (counting players) works', async () => {
  const a = page('ada'), b = page('bert');
  await a.db.ref('rooms/cl-8/players/ada').set({ ts: 1 });
  const s = await b.db.ref('rooms/cl-8/players').once('value');
  let n = 0; s.forEach(() => { n++; });
  assert.equal(n, 1);
  assert.equal(b.win.NetRelay._conns['cl-8'].room, null);   // peeked, didn't join
  const none = await b.db.ref('rooms/cl-99/players').once('value');
  assert.equal(none.exists(), false);
});

test('pushed events come in order, and key queries work', async () => {
  const a = page('aria'), b = page('ben2');
  const keys = [];
  b.db.ref('rooms/cl-9/events').on('child_added', s => keys.push(s.key));
  const pushed = [];
  for (let i = 0; i < 5; i++) pushed.push(a.db.ref('rooms/cl-9/events').push({ i }).key);
  await until(() => keys.length === 5);
  assert.deepEqual(keys, pushed);
  const last2 = await a.db.ref('rooms/cl-9/events').limitToLast(2).once('value');
  assert.deepEqual(Object.keys(last2.val()), pushed.slice(3));
  const from = await a.db.ref('rooms/cl-9/events').orderByKey().startAt(pushed[2]).once('value');
  assert.deepEqual(Object.keys(from.val()), pushed.slice(2));
});

test('other paths still go to Firebase, and the clock offset is known', async () => {
  const a = page('axel');
  const r = a.db.ref('rooms/sc-ratings/players/axel');
  assert.equal(r.firebase, true);
  assert.equal(a.db.ref('rooms/ol-lobby/players').firebase, true);
  const off = await a.db.ref('.info/serverTimeOffset').once('value');
  assert.equal(typeof off.val(), 'number');
  assert.ok(Math.abs(off.val()) < 1000);
});

test('a dropped connection gets a few seconds to come back before disconnect writes run', async () => {
  const a = page('dina'), b = page('dan');
  const removed = [];
  b.db.ref('rooms/cl-11/players').on('child_removed', s => removed.push(s.key));
  const me = a.db.ref('rooms/cl-11/players/dina');
  await me.set({ x: 1 });
  await me.onDisconnect().remove();
  a.win.NetRelay._conns['cl-11'].room.reconnection.enabled = false;   // a tab that vanished (closed laptop), not a blip
  cut('cl-11', 'dina');
  await wait(1500);
  assert.deepEqual(removed, []);            // still inside the reconnection window
  await until(() => removed.includes('dina'), 20000);
});

test('a Wi-Fi blip reconnects by itself and keeps the player in the room', async () => {
  const a = page('eve'), b = page('ed');
  const removed = [], seen = {};
  const list = b.db.ref('rooms/cl-12/players');
  list.on('child_removed', s => removed.push(s.key));
  list.on('child_changed', s => { seen[s.key] = s.val(); });
  const me = a.db.ref('rooms/cl-12/players/eve');
  await me.set({ x: 1 });
  await me.onDisconnect().remove();
  cut('cl-12', 'eve');
  me.set({ x: 2 }).catch(() => {});        // sent while reconnecting: should still arrive
  await until(() => seen.eve && seen.eve.x === 2, 10000);
  await wait(1000);
  assert.deepEqual(removed, []);
});

test('a room stays in memory briefly after everyone leaves', async () => {
  const a = page('april');
  await a.db.ref('rooms/cl-10/round').set({ id: 3 });
  await a.win.NetRelay._conns['cl-10'].room.leave(true);
  const b = page('brook');
  const s = await b.db.ref('rooms/cl-10/round').once('value');
  assert.deepEqual(s.val(), { id: 3 });
});
