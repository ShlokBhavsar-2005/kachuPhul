# 🎴 Judgment Card Game — Setup & Hosting Guide

## What is this?
A real-time multiplayer online version of the **Judgment** card game (also called "Bluff" / "Call Break" variant).
- Room system with shareable codes — no login needed
- Cards dealt automatically per round
- Trump suit rotates: ♠ → ♦ → ♣ → ♥ → ♠ …
- Bids are private until everyone submits
- Full card validation (must follow led suit)
- Live scoreboard, round results, game over screen

---

## 📁 Project Structure

```
judgment-game/
├── server.js          ← Node.js backend (game logic + Socket.io)
├── package.json       ← Dependencies
├── public/
│   └── index.html     ← The entire frontend (one file)
└── README.md
```

---

## 🖥️ LOCAL SETUP (Play on same WiFi)

### Step 1 — Install Node.js
Download from https://nodejs.org (choose LTS version)

### Step 2 — Install dependencies
Open terminal in the `judgment-game` folder:
```bash
npm install
```

### Step 3 — Start the server
```bash
npm start
```
You'll see: `🎴 Judgment Game server running on port 3000`

### Step 4 — Find your local IP
- **Windows**: Run `ipconfig` in CMD → look for IPv4 Address (e.g. `192.168.1.5`)
- **Mac/Linux**: Run `ifconfig` or `ip addr` → look for `inet` under your WiFi adapter

### Step 5 — Share with friends (same WiFi)
Everyone on the same network opens: `http://YOUR_IP:3000`  
Example: `http://192.168.1.5:3000`

---

## 🌐 HOSTING ONLINE (Play from anywhere)

### Option A — Railway (Easiest, Free)
1. Go to https://railway.app — sign up with GitHub
2. Create a new project → "Deploy from GitHub repo"
3. Push your `judgment-game` folder to a GitHub repo
4. Railway auto-detects Node.js and runs `npm start`
5. You get a public URL like `https://judgment-xyz.up.railway.app`
6. Share that URL with friends — done!

### Option B — Render (Free tier)
1. Go to https://render.com — sign up
2. New → Web Service → Connect your GitHub repo
3. Build command: `npm install`
4. Start command: `node server.js`
5. Environment: Node
6. Free tier URL: `https://your-app.onrender.com`
> Note: Free tier sleeps after 15 min inactivity. First load is slow.

### Option C — Fly.io (Free, always on)
```bash
npm install -g flyctl
fly auth login
fly launch      # follow prompts
fly deploy
```

### Option D — VPS (DigitalOcean / Hetzner / Linode)
1. Get a cheap VPS (~$4/month)
2. SSH in, install Node.js
3. Clone/upload your project
4. Run with PM2 for persistence:
```bash
npm install -g pm2
pm2 start server.js --name judgment
pm2 startup   # auto-start on reboot
pm2 save
```
5. Open port 3000 in firewall, or set up nginx as reverse proxy on port 80

---

## 🎮 HOW TO PLAY

1. One player creates a room → shares the 6-letter code
2. All players join with the code
3. Host clicks **Start Game**
4. Players are randomly seated (order is fixed throughout game)
5. Each player sees their own cards and the trump suit
6. **Bidding phase**: Enter how many tricks you think you'll win → Confirm
   - Other players' bids are hidden until all have bid
7. **Playing phase**: Click a card to play it
   - You MUST follow the led suit if you have it
   - Otherwise play any card (including trump)
8. **Scoring**: Bid exactly right → get those points (0 bid → 1 point!)
9. Game ends after all rounds are complete

---

## ⚙️ CONFIGURATION

Edit `server.js` to change:
- `PORT` (default 3000) — or set `PORT` environment variable
- Max players: currently 7 (limited by 52 cards / min deal)
- Trick resolution delay: `1500ms` — adjust in `resolveTrick()`

---

## 🃏 TRUMP SUIT ORDER
Round 1: ♠ Spades  
Round 2: ♦ Diamonds  
Round 3: ♣ Clubs  
Round 4: ♥ Hearts  
Round 5: ♠ Spades (loops)  
…and so on

## 📊 SCORING RULES
| Bid | Tricks Won | Points |
|-----|-----------|--------|
| 0   | 0         | **1** (special rule!) |
| 3   | 3         | **3** |
| 5   | 4 or 6    | **0** (missed) |
| 2   | 0         | **0** (missed) |
