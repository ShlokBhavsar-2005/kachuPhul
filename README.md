# 🌸 Kachu Phul — Multiplayer Judgment Card Game

**Kachu Phul** is a real-time multiplayer online version of the classic **Judgment** (Kachu Phul / Call Break) card game.  
Built with **Node.js**, **Socket.io**, **MongoDB**, and a single-page vanilla HTML/CSS/JS frontend.

---

## ✨ Features

- 🔐 **Google Sign-In** — optional auth with persistent game names and session tokens
- 👥 **Friends System** — add friends, see who's online or in a game, send game invites
- 🏠 **Room System** — create or join rooms with a shareable 6-character code; no login required to play
- 👁️ **Spectator Mode** — watch any active game in real time without participating
- 💬 **In-Game Chat** — persistent per-room chat with a 50-message history
- 🃏 **Full Card Game Logic** — trump suit, suit-following rules, trick resolution, bidding phase
- 🔄 **Reconnect Support** — players who drop can rejoin a live game via token or Google ID
- 🗳️ **Vote-Kick** — collectively kick disconnected players from an active game
- 🎮 **Play Again** — unanimous vote creates a fresh lobby with the same players
- 📊 **Scoreboard** — round-by-round scoring with a final game-over screen
- ⚙️ **Configurable Rounds** — host chooses how many rounds to play (up to the card-deal maximum)

---

## 📁 Project Structure

```
kachufool/
├── server.js          ← Node.js + Express + Socket.io backend (all game logic)
├── package.json       ← Dependencies & scripts
├── .env               ← Environment variables (not committed)
├── public/
│   ├── index.html     ← Entire single-page frontend (HTML + CSS + JS)
│   ├── css/           ← (reserved, currently empty)
│   └── js/            ← (reserved, currently empty)
└── README.md
```

---

## 🚀 Quick Start (Local)

### 1. Install Node.js
Download from https://nodejs.org — **LTS version recommended** (Node ≥ 18 required).

### 2. Clone / download the project
```bash
git clone https://github.com/ShlokBhavsar-2005/kachufool.git
cd kachufool
```

### 3. Install dependencies
```bash
npm install
```

### 4. Configure environment variables
Create a `.env` file in the project root:

```env
# Required for Google Sign-In (optional feature)
GOOGLE_CLIENT_ID=your_google_oauth_client_id

# Required for friends system and auth persistence
MONGO_URI=mongodb+srv://user:pass@cluster.mongodb.net/?retryWrites=true

# Optional — defaults to 3000
PORT=3000
```

> **Without `.env`**: The game still works fully in guest mode (no auth, no friends list, no persistence).

### 5. Start the server
```bash
npm start
```
You should see:
```
✅ MongoDB connected
🎴 Kachu Phul on port 3000
```

### 6. Open in browser
- **Same machine**: http://localhost:3000
- **Local network**: find your IPv4 address (`ipconfig` on Windows / `ifconfig` on Mac/Linux) and open `http://YOUR_IP:3000`

---

## 🌐 Deploying Online

### Option A — Railway *(easiest)*
1. Push the repo to GitHub.
2. Go to https://railway.app → New Project → Deploy from GitHub.
3. Add environment variables in the Railway dashboard.
4. Railway auto-detects Node.js and runs `npm start`. You'll get a public URL.

### Option B — Render *(free tier)*
1. Go to https://render.com → New Web Service → connect your repo.
2. Build command: `npm install` | Start command: `node server.js`
3. Add env vars under **Environment**.
> Free tier spins down after 15 min of inactivity — first load will be slow.

### Option C — Fly.io *(always on)*
```bash
npm install -g flyctl
fly auth login
fly launch
fly deploy
```
Set secrets with `fly secrets set MONGO_URI=... GOOGLE_CLIENT_ID=...`.

### Option D — VPS (DigitalOcean / Hetzner / Linode)
```bash
npm install -g pm2
pm2 start server.js --name kachufool
pm2 startup && pm2 save
```
Open port 3000 in your firewall, or set up nginx as a reverse proxy on port 80/443.

---

## 🔐 Auth & User Accounts

Authentication is entirely **optional**. Players can join as guests with just a display name.

When Google Sign-In is configured:
- Players sign in with their Google account.
- On first login they choose a unique **game name** (3–16 chars, alphanumeric + `_`).
- A session token is stored in `localStorage` for automatic re-login.
- Game names can be renamed from the profile menu; all friend references update automatically.

### REST API endpoints
| Method | Route | Description |
|--------|-------|-------------|
| `GET` | `/auth/status` | Check if auth is configured |
| `POST` | `/auth/google` | Verify Google credential, return session |
| `POST` | `/auth/register` | Register new user with a game name |
| `POST` | `/auth/session` | Validate an existing session token |
| `POST` | `/auth/rename` | Rename your game name |
| `POST` | `/friends/list` | Fetch friends list + pending requests |
| `POST` | `/friends/request` | Send a friend request |
| `POST` | `/friends/respond` | Accept or decline a friend request |

---

## 🎮 How to Play

1. **Create or Join** — One player creates a room and shares the 6-letter code. Others join with the code.
2. **Lobby** — The host can set the number of rounds and click **Start Game** (min 2 players).
3. **Bidding Phase** — Each player sees their hand and the trump suit, then privately bids how many tricks they expect to win. Bids are hidden until everyone submits.
4. **Playing Phase** — Players take turns playing one card:
   - You **must follow the led suit** if you have it.
   - Otherwise play any card (trump or off-suit).
5. **Trick Resolution** — The highest trump wins; if no trump, the highest card of the led suit wins.
6. **Scoring** — Hit your bid exactly → earn that many points (bid 0 and win 0 → **1 point**). Miss your bid → **0 points**.
7. **Next Round** — Rounds continue with one fewer card dealt each round.
8. **Game Over** — After all rounds, final scores are shown. Players can vote to **Play Again**.

---

## 🃏 Trump Suit Order

| Round | Trump |
|-------|-------|
| 1 | ♠ Spades |
| 2 | ♦ Diamonds |
| 3 | ♣ Clubs |
| 4 | ♥ Hearts |
| 5 | ♠ Spades *(loops)* |

---

## 📊 Scoring Rules

| Bid | Tricks Won | Points |
|-----|-----------|--------|
| 0 | 0 | **1** *(special rule)* |
| N | N | **N** |
| N | ≠ N | **0** |

---

## ⚙️ Configuration

Edit `server.js` or use environment variables to tweak:

| Setting | Default | How to Change |
|---------|---------|---------------|
| Port | `3000` | `PORT` env var |
| Max players | `7` | Limited by 52 cards / min deal |
| Trick resolution delay | `1000ms` (play) + `2000ms` (animate) | `resolveTrick()` in `server.js` |
| Round end delay | `4000ms` | `endRound()` in `server.js` |
| Chat history length | 50 messages | `chatMessage` handler in `server.js` |
| Socket ping timeout | `60s` | `Server` constructor options |

---

## 🛠️ Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js ≥ 18 |
| Web framework | Express 4 |
| Real-time | Socket.io 4 |
| Database | MongoDB 6 (via official driver) |
| Auth | Google Identity Services + `google-auth-library` |
| IDs | `uuid`, `crypto` (built-in) |
| Frontend | Vanilla HTML + CSS + JS (single file) |
| Fonts | Google Fonts — *Baloo 2*, *Rajdhani* |
| Dev server | `nodemon` |

---

## 📝 License

MIT — feel free to fork and host your own instance.
