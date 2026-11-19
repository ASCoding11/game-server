// A room's data, kept the way the Firebase Realtime Database keeps it: one JSON tree where writing null removes a
// value and an object left with no children disappears too. Paths are "a/b/c" strings relative to the room.
// The same file runs in the browser (netrelay.js copies these functions), so it has no Node-only code.

export function splitPath(p) {
  if (p == null) return [];
  return String(p).split('/').filter(s => s.length);
}

export function joinPath(segs) { return segs.join('/'); }

const isObj = v => v !== null && typeof v === 'object';

// Firebase never stores null, undefined, empty objects or empty arrays. Clean a value the same way.
export function clean(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'object') return v;
  if (Array.isArray(v)) {
    const out = [];
    let any = false;
    for (let i = 0; i < v.length; i++) { const c = clean(v[i]); out.push(c); if (c !== null) any = true; }
    return any ? out : null;
  }
  const out = {};
  let any = false;
  for (const k of Object.keys(v)) {
    const c = clean(v[k]);
    if (c !== null) { out[k] = c; any = true; }
  }
  return any ? out : null;
}

export function getAt(tree, segs) {
  let cur = tree;
  for (const s of segs) {
    if (!isObj(cur)) return null;
    cur = cur[s];
    if (cur === undefined) return null;
  }
  return cur === undefined ? null : cur;
}

// Returns the new root (the root itself can become null).
export function setAt(tree, segs, value) {
  value = clean(value);
  if (!segs.length) return value;
  const root = isObj(tree) ? tree : {};
  const stack = [root];
  let cur = root;
  for (let i = 0; i < segs.length - 1; i++) {
    const s = segs[i];
    if (!isObj(cur[s])) {
      if (value === null) return isObj(tree) ? tree : null;   // removing something that isn't there
      cur[s] = {};
    }
    cur = cur[s];
    stack.push(cur);
  }
  const last = segs[segs.length - 1];
  if (value === null) delete cur[last];
  else cur[last] = value;
  // Prune parents left empty, from the bottom up.
  for (let i = segs.length - 1; i >= 1; i--) {
    const node = stack[i];
    if (isEmpty(node)) delete stack[i - 1][segs[i - 1]];
    else break;
  }
  return isEmpty(root) ? null : root;
}

function isEmpty(o) {
  if (Array.isArray(o)) return !o.some(x => x !== null && x !== undefined);
  for (const k in o) if (Object.prototype.hasOwnProperty.call(o, k)) return false;
  return true;
}

// Server values: {".sv":"timestamp"} becomes the server's clock; {".sv":{"increment":n}} adds n to what's there.
export function resolveSentinels(v, now, current) {
  if (!isObj(v)) return v;
  if (Object.prototype.hasOwnProperty.call(v, '.sv')) {
    const sv = v['.sv'];
    if (sv === 'timestamp') return now;
    if (isObj(sv) && typeof sv.increment === 'number') return (typeof current === 'number' ? current : 0) + sv.increment;
    return null;
  }
  const out = Array.isArray(v) ? [] : {};
  for (const k of Object.keys(v)) out[k] = resolveSentinels(v[k], now, isObj(current) ? current[k] : undefined);
  return out;
}

export function hasSentinel(v) {
  if (!isObj(v)) return false;
  if (Object.prototype.hasOwnProperty.call(v, '.sv')) return true;
  for (const k of Object.keys(v)) if (hasSentinel(v[k])) return true;
  return false;
}

// Firebase-style deep equality (arrays and objects with the same keys count as equal).
export function same(a, b) {
  if (a === b) return true;
  if (!isObj(a) || !isObj(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!same(a[k], b[k])) return false;
  return true;
}

// Turn an op into the list of [segments, value] writes it makes. Ops:
//   {o:'s', p, v}   set the value at p
//   {o:'u', p, v}   update: each key of v (which may itself be a path like "a/b") is set under p
//   {o:'r', p}      remove
export function expand(op) {
  const base = splitPath(op.p);
  if (op.o === 's') return [[base, op.v]];
  if (op.o === 'r') return [[base, null]];
  if (op.o === 'u') {
    if (!isObj(op.v)) return [];
    return Object.keys(op.v).map(k => [base.concat(splitPath(k)), op.v[k]]);
  }
  return [];
}

export function applyOp(tree, op, now) {
  for (const [segs, v0] of expand(op)) {
    const v = hasSentinel(v0) ? resolveSentinels(v0, now, getAt(tree, segs)) : v0;
    tree = setAt(tree, segs, v);
  }
  return tree;
}

// Rewrites an op with its server values filled in, so everyone stores the same numbers.
export function resolveOp(tree, op, now) {
  if (!hasSentinel(op.v)) return op;
  if (op.o === 's') return { o: 's', p: op.p, v: resolveSentinels(op.v, now, getAt(tree, splitPath(op.p))) };
  if (op.o === 'u') {
    const base = splitPath(op.p), v = {};
    for (const k of Object.keys(op.v)) v[k] = resolveSentinels(op.v[k], now, getAt(tree, base.concat(splitPath(k))));
    return { o: 'u', p: op.p, v };
  }
  return op;
}
