// Game relay server for ascoding11.com: Colyseus rooms that stand in for the Firebase Realtime Database rooms the
// Back Room games use (rooms/<prefix>-<code>). See README.md.
import { Server, matchMaker } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { RelayRoom, live, ROOM_KEY } from './RelayRoom.js';
import { makeVerifier } from './auth.js';
import { splitPath, getAt } from './tree.js';

const env = process.env;
const PORT = Number(env.PORT || 2567);
const AUTH_MODE = env.AUTH_MODE || 'firebase';
const ORIGINS = (env.ALLOWED_ORIGINS ||
  'https://ascoding11.com,https://www.ascoding11.com,https://ascoding11.github.io,http://localhost:8000,http://127.0.0.1:8000')
  .split(',').map(s => s.trim()).filter(Boolean);

if (AUTH_MODE === 'off' && env.ALLOW_INSECURE_AUTH !== '1') {
  console.error('AUTH_MODE=off lets anyone pretend to be anyone. Set ALLOW_INSECURE_AUTH=1 too if this is a local test.');
  process.exit(1);
}

export async function start({ port = PORT, verify } = {}) {
  RelayRoom.verify = verify || makeVerifier({ projectId: env.FIREBASE_PROJECT_ID || 'rumblekarts', mode: AUTH_MODE });

  const server = new Server({
    transport: new WebSocketTransport({ pingInterval: 5000, pingMaxRetries: 3 }),
    greet: false,
    express: app => {
      app.use((req, res, next) => {
        const o = req.headers.origin;
        if (o && ORIGINS.includes(o)) {
          res.setHeader('Access-Control-Allow-Origin', o);
          res.setHeader('Vary', 'Origin');
          res.setHeader('Access-Control-Allow-Headers', 'Authorization');
        }
        if (req.method === 'OPTIONS') return res.status(204).end();
        next();
      });
      app.get('/health', (req, res) => res.json({ ok: true, rooms: live.size }));
      // The page's clock offset is worked out from this, the way Firebase's .info/serverTimeOffset works.
      app.get('/time', (req, res) => { res.setHeader('Cache-Control', 'no-store'); res.json({ now: Date.now() }); });
      // Read part of a room without joining it (a game counting players before it joins, or the lobby).
      app.get('/peek', async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        try {
          const tok = String(req.headers.authorization || '').replace(/^Bearer /, '');
          await RelayRoom.verify(tok);
        } catch (e) { return res.status(401).json({ error: 'Sign in first' }); }
        const key = String(req.query.room || '');
        if (!ROOM_KEY.test(key)) return res.status(400).json({ error: 'Bad room code' });
        const r = live.get(key);
        res.json({ v: r ? getAt(r.tree, splitPath(String(req.query.path || ''))) : null });
      });
    },
  });
  server.define('relay', RelayRoom).filterBy(['room']);
  await server.listen(port);
  console.log('Game relay listening on port ' + port + ' (auth: ' + (verify ? 'custom' : AUTH_MODE) + ')');
  return server;
}

