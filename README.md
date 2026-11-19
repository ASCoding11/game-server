# game-server

The multiplayer relay for the Back Room games on [ascoding11.com](https://ascoding11.com). Built on
[Colyseus](https://colyseus.io).

Today every online game sends its room traffic (player positions, events, rounds) through the Firebase Realtime
Database under `rooms/<prefix>-<code>`. That works, but:

- **It's expensive.** Firebase charges for every gigabyte it sends out. In November 2026 the site used 25.7 GB in
  18 days, 2.5× the free monthly amount.
- **It's slow.** The database is in Google's central-US region (Iowa), so each move goes New York → Iowa → New York.
- **It caps players.** The free plan allows 100 connections at once.

This relay does the same job from a small server near the players. Traffic is covered by the server's flat monthly
price, and a player's moves only go a few milliseconds away.

## How it works

- **`src/RelayRoom.js`**: one Colyseus room per game room code (for example `cl-4821`). It holds the same JSON data
  the game used to keep in Firebase, applies each write, and passes it on to everyone else in the room. It also
  supports the Firebase features the games rely on:
  - server timestamps
  - transactions
  - writes that run when a player disconnects
  - a 15-second grace period for Wi-Fi drops
- **`client/netrelay.js`**: a small browser file that makes the relay look like `firebase.database()` to a game.
  A game switches over by changing one line:

  ```js
  this.db = NetRelay.database(firebase.database(), /^cl-/);   // was: this.db = firebase.database();
  ```

  Only paths under `rooms/cl-…` go to the relay; everything else still goes to Firebase, and the game's network code
  stays the same. With no relay address configured, `NetRelay.database()` hands back Firebase's own object, so
  nothing changes.
- **Sign-in**: players keep using the Firebase sign-in they already have (anonymous or Google). The page sends its
  Firebase ID token when joining, and the server checks it against Google's keys, so a player can only be themselves.
- **Rules**:
  - A player may write only their own `players/<uid>` entry.
  - Anyone in the room may remove an entry (games clean up players who have gone).
  - Everything else in the room is shared, as it was in Firebase.
  - Per player: at most 120 writes a second and 64 KB per write. Per room: at most 2 MB of data and 40 players.

### What stays on Firebase

- **Everything that must outlast a match**: sign-in, Elo and ratings (`rooms/sc-ratings`, `rooms/lb-all`), the online
  lobby (`rooms/ol-lobby`), parties (`rooms/pt-…`), analytics and leaderboards.
- **Quarry.** Its worlds are stored in its room for days, and relay rooms only exist while someone is in them (plus
  2 minutes). A server restart also ends the matches that are on at that moment.

## Running it locally

```bash
npm install
npm test                                              # 17 tests: two simulated players per test, sign-in check
AUTH_MODE=off ALLOW_INSECURE_AUTH=1 npm start         # local only: the "token" is taken as the user id
```

`curl localhost:2567/health` should answer `{"ok":true,"rooms":0}`.

## Hosting

Any machine that runs Node 20+ and is reachable over HTTPS will do.

### A VPS (about $8/month)

1. Create an Ubuntu 24.04 server near New York. Good options are Hetzner (Ashburn), DigitalOcean (New York) and
   Vultr (New Jersey). The smallest plan is enough to start.
2. Point a subdomain at it: an `A` record for `play.yourdomain.com` → the server's IP address. On Cloudflare, set it
   to **DNS only** (grey cloud), so game traffic doesn't take a detour.
3. Open the server's console and run:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/ASCoding11/game-server/main/deploy/setup.sh | bash -s play.yourdomain.com
   ```

   This installs Node, PM2 (keeps the relay running) and Caddy (HTTPS), opens only the SSH and web ports, and prints
   three values for GitHub.
4. Add those values as repository secrets (`DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_KEY`). From then on, every push to
   `main` that passes the tests updates the server on its own (`.github/workflows/deploy.yml`).

### Colyseus Cloud (from $15/month, no server to look after)

Connect this repo in the Colyseus Cloud dashboard. It runs `npm start`, and the settings in `.env.example` go in its
environment.

### Container hosts

Fly.io, Render and Railway can use the `Dockerfile`. Avoid plans with throttled "shared" CPU: a game server needs
steady CPU, or it stutters.

## Switching a game over

The order:

1. Copy `client/colyseus.js` and `client/netrelay.js` into the site (for example `e63334287a3deaa3/`). Add
   `netrelay-config.js` holding the address:

   ```js
   NetRelay.config({ url: 'wss://play.yourdomain.com' });
   ```

   Blanking the address sends every game back to Firebase at once, which is the off switch if the server has trouble.
2. In a game, load those three files before its own script, and change its `firebase.database()` line as shown
   above. Keep `firebase.database.ServerValue.TIMESTAMP` as it is: the relay understands it.
3. The Back Room's "Playing now" list (`playingnow.js`) counts players by reading each room. It needs to read relay
   rooms through `NetRelay.database(...)` too, or it will show those rooms as empty.
4. Test two browser windows in the same room, as the site's `CLAUDE.md` says.

Coil has been tested this way against a local relay: two browsers in room `cl-relaytest` saw each other and the
host's bots move.

## Endpoints

| Path | What |
|---|---|
| `wss://…` | Colyseus. The page joins room type `relay` with `{ room: "cl-4821", token }` |
| `GET /health` | `{ ok, rooms }` |
| `GET /time` | The server clock, for the page's clock offset (like Firebase's `.info/serverTimeOffset`) |
| `GET /peek?room=…&path=…` | Read part of a room without joining it (`Authorization: Bearer <Firebase ID token>`) |

## Settings (`.env`)

| Name | Default | |
|---|---|---|
| `PORT` | `2567` | |
| `FIREBASE_PROJECT_ID` | `rumblekarts` | Whose sign-in tokens to accept |
| `ALLOWED_ORIGINS` | the site's domains + localhost:8000 | Pages allowed to call `/peek` and `/time` |
| `AUTH_MODE` | `firebase` | `off` only for local testing, and only together with `ALLOW_INSECURE_AUTH=1` |
