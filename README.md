# Kachu Phul — Online Judgment Card Game

Real-time multiplayer implementation of the **Judgment / Kachu Phul** card game, playable in any browser over a local network or the internet.

---

## Features

- **Google OAuth authentication** — sign in with Google; no passwords
- **Persistent accounts** — game name (3–16 chars, alphanumeric + `_`) stored in MongoDB and renameable at any time
- **Friends system** — send/accept friend requests, see online/in-game status, get live status updates
- **Direct invites** — invite online friends to your lobby from the menu or the waiting room
- **Spectator mode** — join any active game as a read-only observer; watch all hands and the full scoreboard
- **Shareable room codes** — 6-character codes; no login required to join (guests use a display name only)
- **Configurable rounds** — host selects Full / ¾ / Half / Quick or a custom count before starting
- **Trump rotation** — ♠ → ♦ → ♣ → ♥ → ♠ … cycles across rounds
- **Sealed bidding** — bids hidden until everyone submits, then revealed simultaneously
- **Suit-following enforcement** — server-side validation; must follow lead suit if able
- **Trick resolution** — animated delay after all cards are played before moving to the next trick
- **In-game chat** — floating panel with unread badge and pop-up bubble notifications
- **Play Again** — unanimous vote spins up a fresh lobby without losing the group
- **Vote-kick** — players vote to remove a disconnected opponent mid-game
- **Lobby kick** — host can remove any player before the game starts
- **Auto-reconnect** — players who disconnect mid-game rejoin via stored session token or Google ID
- **Inline SVG icon set** — custom outline icons (no external CDN required)

---

## Project Structure

```
kachufool/
├── server.js             ← Node.js backend: game logic, Socket.io, REST API, MongoDB
├── package.json
├── .env.example          ← Environment variable reference
├── public/
│   ├── index.html        ← Single-page frontend (all screens)
│   ├── css/
│   │   └── style.css     ← All styles (~41 KB)
│   └── js/
│       └── app.js        ← All client-side logic (~60 KB)
└── README.md
```

---

## Requirements

- **Node.js ≥ 18**
- **MongoDB Atlas** (or any MongoDB URI) — required for auth and friends; game rooms work without it
- **Google OAuth Client ID** — required for Google sign-in; guest play works without it

---

## Local Setup

### 1. Install Node.js

Download the LTS release from https://nodejs.org.

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and set at minimum:

```
MONGO_URI=mongodb+srv://<user>:<pass>@cluster.mongodb.net/?retryWrites=true&w=majority
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
```

Leave either blank to run without auth/friends (game rooms still work).

### 4. Start the server

```bash
npm start          # production
npm run dev        # auto-reload via nodemon
```

You should see: `🎴 Kachu Phul on port 3000`

### 5. Open in browser

- Local machine: `http://localhost:3000`
- Other devices on the same WiFi: `http://<YOUR_IP>:3000`
  - Windows: `ipconfig` → IPv4 Address
  - Mac/Linux: `ifconfig` / `ip addr` → `inet` under your WiFi adapter

---

## Hosting Online

### Railway (recommended)

1. Push the repo to GitHub.
2. Go to https://railway.app → New Project → Deploy from GitHub repo.
3. Set env vars: `MONGO_URI`, `GOOGLE_CLIENT_ID`, `ALLOWED_ORIGINS`, `NODE_ENV=production`.
4. Railway auto-detects Node.js and runs `npm start`.
5. Share the generated URL.

### Render

1. New → Web Service → connect the GitHub repo.
2. Build command: `npm install`
3. Start command: `node server.js`
4. Add environment variables in the Render dashboard.

> Free tier instances sleep after 15 minutes of inactivity. The first request after sleep can take ~30 s.

### Fly.io

```bash
npm install -g flyctl
fly auth login
fly launch
fly deploy
```

### VPS (DigitalOcean / Hetzner / Linode)

```bash
npm install -g pm2
pm2 start server.js --name kachuphul
pm2 startup && pm2 save
```

Open port 3000 in the firewall, or place nginx in front as a reverse proxy on port 80/443.

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP/WebSocket port |
| `NODE_ENV` | `development` | Set to `production` to suppress debug logs |
| `MONGO_URI` | — | MongoDB connection string |
| `GOOGLE_CLIENT_ID` | — | Google OAuth 2.0 client ID |
| `ALLOWED_ORIGINS` | — | Comma-separated allowed origins |
| `DEBUG_TIMING` | `false` | Set to `true` to log DB and socket handler timing |

---

## How to Play

1. Sign in with Google (or enter a display name as a guest).
2. **Create** a room — share the 6-letter code — or **Join** with someone else's code.
3. Host selects the number of rounds and clicks **Start Game**.
4. Play order is randomised at game start and fixed for the session.

### Each Round

| Phase | What happens |
|---|---|
| **Bidding** | Each player privately enters how many tricks they expect to win (0 – cards in hand). Bids are hidden until all players submit. |
| **Playing** | Players take turns leading or following. You **must** follow the lead suit if you hold any card of that suit. Otherwise play any card, including trump. |
| **Resolution** | After all cards are played the trick is awarded ~1 second later. Trump beats non-trump; higher rank wins within the same suit. |
| **Round end** | Scores are displayed before the next round begins. |

### Scoring

| Bid | Result | Points |
|---|---|---|
| 0 | 0 tricks won | **1** |
| N | Exactly N tricks won | **N** |
| Any | Missed bid (over or under) | **0** |

### Trump Suit Order

| Round | Trump |
|---|---|
| 1, 5, 9, … | ♠ Spades |
| 2, 6, 10, … | ♦ Diamonds |
| 3, 7, 11, … | ♣ Clubs |
| 4, 8, 12, … | ♥ Hearts |

Cards dealt decreases by 1 per round (e.g. 4 players, 13 rounds: Round 1 = 13 cards, Round 13 = 1 card).

---

## Configuration Reference

### Hard Limits

| Setting | Value | Location |
|---|---|---|
| Max players per room | 7 | `server.js` — `joinRoom` handler |
| Max rounds | `floor(52 / playerCount)` | Computed at game start |
| Trick resolve delay | 1 000 ms | `resolveTrick()` |
| Round end → next round | 4 000 ms | `endRound()` |
| Game over → scoreboard delay | 500 ms | Client `gameOver` handler |
| Chat history per room | 50 messages | `chatMessage` handler |
| Disconnect grace period | 5 000 ms | `disconnect` handler |
| Socket ping timeout | 60 000 ms | `io` constructor |

### Changing the Port

Set the `PORT` environment variable, or edit the fallback in `server.js`:

```js
const PORT = process.env.PORT || 3000;
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js ≥ 18 |
| HTTP server | Express 4 |
| Real-time | Socket.io 4 |
| Database | MongoDB 6 (official driver) |
| Auth | Google Identity Services (GSI) + google-auth-library |
| Sessions | Crypto random tokens stored in MongoDB |
| Unique IDs | uuid v9 |
| Frontend | Vanilla HTML / CSS / JavaScript (no build step) |
| Dev reload | nodemon |
