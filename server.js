require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const path = require('path');
const { MongoClient } = require('mongodb');
const { OAuth2Client } = require('google-auth-library');
const kaaliTeeri = require('./games/kaaliTeeri');
const { GAMES } = require('./games/gameRegistry');

// ─── ENV & TIMING ─────────────────────────────────────────────────────────────
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI || '';
const PORT = process.env.PORT || 3000;
const DEBUG_TIMING = process.env.DEBUG_TIMING === 'true';
const IS_PROD = process.env.NODE_ENV === 'production';

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },        // open: this server serves its own frontend
  pingTimeout: 60000,           // 60s — keeps mobile connections alive
  pingInterval: 25000,
  perMessageDeflate: false,
  connectionStateRecovery: {},
});

app.use(express.json({ limit: '10kb' }));  // guard against large payload attacks
app.use(express.static(path.join(__dirname, 'public')));

function debugLog(...args) {
  if (!IS_PROD) console.log(...args);
}

async function timeQuery(label, fn) {
  if (!DEBUG_TIMING) return fn();
  const start = process.hrtime.bigint();
  try {
    return await fn();
  } finally {
    const end = process.hrtime.bigint();
    console.log(`[DB Timing] ${label}: ${(Number(end - start) / 1e6).toFixed(2)}ms`);
  }
}

const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

// ─── MONGODB ──────────────────────────────────────────────────────────────────
let db;
async function connectDB() {
  if (!MONGO_URI) { console.log('⚠️  No MONGO_URI — auth/friends disabled'); return; }
  try {
    const client = new MongoClient(MONGO_URI);
    await client.connect();
    db = client.db('kachuphul');
    await db.collection('users').createIndex({ googleId: 1 }, { unique: true });
    await db.collection('users').createIndex({ gameName: 1 }, { unique: true });
    // sparse:true must be in the SAME options object — passing it as a 3rd arg is silently ignored.
    // Drop the old broken index first so it is recreated correctly if it already exists.
    await db.collection('users').dropIndex('gameNameLower_1').catch(() => { /* index may not exist yet — safe to ignore */ });
    await db.collection('users').createIndex({ gameNameLower: 1 }, { unique: true, sparse: true });
    await db.collection('friendRequests').createIndex({ from: 1, to: 1 }, { unique: true });

    // Task 3: Backfill gameNameLower for existing users missing it
    const unindexedUsers = await db.collection('users').find({ gameNameLower: { $exists: false } }).toArray();
    for (const u of unindexedUsers) {
      if (u.gameName) {
        await db.collection('users').updateOne({ _id: u._id }, { $set: { gameNameLower: u.gameName.toLowerCase() } });
      }
    }

    // Task 2: Populate in-memory gameNameIndex
    const allUsers = await db.collection('users').find({}, { projection: { gameName: 1, googleId: 1, gameNameLower: 1 } }).toArray();
    gameNameIndex.clear();
    for (const u of allUsers) {
      if (u.gameName) {
        const lowerKey = (u.gameNameLower || u.gameName).toLowerCase();
        gameNameIndex.set(lowerKey, u.googleId);
      }
    }

    console.log(`✅ MongoDB connected — indexed ${gameNameIndex.size} users`);
  } catch (e) {
    console.error('❌ MongoDB error:', e.message);
  }
}

// ─── GAME CONSTANTS ───────────────────────────────────────────────────────────
const SUITS = ['spades', 'diamonds', 'clubs', 'hearts'];
const SUIT_SYMBOLS = { spades: '♠', diamonds: '♦', clubs: '♣', hearts: '♥' };
const SUIT_NAMES = { spades: 'Spades', diamonds: 'Diamonds', clubs: 'Clubs', hearts: 'Hearts' };
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const RANK_VALUE = { '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14 };

// ─── IN-MEMORY ────────────────────────────────────────────────────────────────
const rooms = {};   // roomId → room
const onlineUsers = {};   // googleId → { socketId, gameName, roomId, status }
const gameNameIndex = new Map(); // lowercase gameName → googleId

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function escapeRegex(str) { return (str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

async function findUserByGameName(nameInput) {
  if (!db || !nameInput) return null;
  const cleanName = (nameInput || '').trim();
  if (!cleanName) return null;
  const targetLower = cleanName.toLowerCase();

  // 1. Check in-memory gameNameIndex (cache hit)
  const cachedGoogleId = gameNameIndex.get(targetLower);
  if (cachedGoogleId) {
    const cachedUser = await timeQuery(`findOne user by googleId cacheHit (${cachedGoogleId})`, () =>
      db.collection('users').findOne({ googleId: cachedGoogleId })
    );
    if (cachedUser) return cachedUser;
  }

  // 2. Check by gameNameLower index
  let dbUser = await timeQuery(`findOne user by gameNameLower (${targetLower})`, () =>
    db.collection('users').findOne({ gameNameLower: targetLower })
  );
  if (dbUser) {
    gameNameIndex.set(targetLower, dbUser.googleId);
    return dbUser;
  }

  // 3. Fallback for existing users missing gameNameLower: case-insensitive query & self-heal
  dbUser = await timeQuery(`findOne user by gameName fallback (${targetLower})`, () =>
    db.collection('users').findOne({
      $or: [
        { gameName: cleanName },
        { gameName: { $regex: `^${escapeRegex(cleanName)}$`, $options: 'i' } }
      ]
    })
  );

  if (dbUser) {
    gameNameIndex.set(targetLower, dbUser.googleId);
    db.collection('users').updateOne({ _id: dbUser._id }, { $set: { gameNameLower: targetLower } }).catch(() => {});
  }

  return dbUser;
}

connectDB();

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function genId(len = 6) { return Math.random().toString(36).substring(2, 2 + len).toUpperCase(); }
function genToken() { return crypto.randomBytes(16).toString('hex'); }
function createDeck() {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push({ suit: s, rank: r, id: `${r}_${s}` });
  return d;
}
function shuffle(d) {
  const a = [...d];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function getTrump(ri) { return SUITS[ri % 4]; }
function getCardsForRound(total, ri) { return total - ri; }
function dealCards(pc, total, ri) {
  const n = getCardsForRound(total, ri), deck = shuffle(createDeck()).slice(0, pc * n);
  return Array.from({ length: pc }, (_, i) => deck.slice(i * n, (i + 1) * n));
}
function cardValue(card, lead, trump) {
  if (card.suit === trump) return 1000 + RANK_VALUE[card.rank];
  if (card.suit === lead) return RANK_VALUE[card.rank];
  return 0;
}
function trickWinner(trick, lead, trump) {
  let best = 0, bestVal = cardValue(trick[0].card, lead, trump);
  for (let i = 1; i < trick.length; i++) { const v = cardValue(trick[i].card, lead, trump); if (v > bestVal) { bestVal = v; best = i; } }
  return trick[best].playerIndex;
}
function roundScore(bid, actual) { return bid === actual ? (bid === 0 ? 1 : bid) : 0; }
function getCurrentTurn(room) {
  if (room.state !== 'playing') return null;
  const leaderIdx = room.playerOrder.indexOf(room.currentLeader);
  return room.playerOrder[(leaderIdx + room.currentTrick.length) % room.playerOrder.length];
}

// ─── REMOVE PLAYER FROM ACTIVE GAME ──────────────────────────────────────────
function removePlayerFromGame(room, removedIdx, reason = 'kicked') {
  const removedPlayer = room.players[removedIdx];
  const removedName = removedPlayer.name;
  const originalPlayerOrder = [...room.playerOrder];

  // If only 2 players remain, end the game after removal
  if (room.players.length <= 2) {
    room.players.splice(removedIdx, 1);
    room.scores = { 0: room.scores[removedIdx === 0 ? 1 : 0] || 0 };
    room.playerOrder = [0];
    room.players.forEach((p, i) => {
      if (p.connected) {
        const s = io.sockets.sockets.get(p.socketId);
        if (s) s.data.playerIndex = i;
        io.to(p.socketId).emit('yourIndex', i);
      }
    });
    io.to(room.id).emit(reason === 'left' ? 'playerLeft' : 'playerRemoved', { name: removedName });
    endGame(room);
    return;
  }

  // Build old→new index mapping
  const indexMap = {};
  let ni = 0;
  for (let i = 0; i < room.players.length; i++) {
    if (i === removedIdx) continue;
    indexMap[i] = ni++;
  }

  // Remove from players array
  room.players.splice(removedIdx, 1);

  // Rebuild playerOrder
  room.playerOrder = room.playerOrder
    .filter(idx => idx !== removedIdx)
    .map(idx => indexMap[idx]);

  // Rebuild all index-keyed maps
  function rebuildMap(old) {
    const m = {};
    for (const [k, v] of Object.entries(old)) {
      const oi = parseInt(k);
      if (oi === removedIdx) continue;
      m[indexMap[oi]] = v;
    }
    return m;
  }
  room.hands = rebuildMap(room.hands);
  room.bids = rebuildMap(room.bids);
  room.bidsReady = rebuildMap(room.bidsReady);
  room.tricks = rebuildMap(room.tricks);
  room.scores = rebuildMap(room.scores);

  // Rebuild roundScores history
  room.roundScores = room.roundScores.map(round =>
    round
      .filter(r => r.playerIndex !== removedIdx)
      .map(r => ({ ...r, playerIndex: indexMap[r.playerIndex] }))
  );

  // Remove cards from current trick played by removed player, remap indices
  room.currentTrick = room.currentTrick
    .filter(t => t.playerIndex !== removedIdx)
    .map(t => ({ ...t, playerIndex: indexMap[t.playerIndex] }));

  // Fix currentLeader
  if (room.currentLeader === removedIdx) {
    const posInOrder = originalPlayerOrder.indexOf(removedIdx);
    room.currentLeader = room.playerOrder[posInOrder % room.playerOrder.length];
  } else {
    room.currentLeader = indexMap[room.currentLeader];
  }

  // Fix host
  if (room.hostSocketId === removedPlayer.socketId) {
    const first = room.players.find(p => p.connected);
    if (first) room.hostSocketId = first.socketId;
  }

  // Clear kick votes
  room.kickVotes = {};

  // Rebuild playAgainVotes if present
  if (room.playAgainVotes) {
    const nv = new Set();
    for (const v of room.playAgainVotes) {
      if (v !== removedIdx && indexMap[v] !== undefined) nv.add(indexMap[v]);
    }
    room.playAgainVotes = nv;
  }

  // Update socket data for all remaining players
  room.players.forEach((p, i) => {
    if (p.connected) {
      const s = io.sockets.sockets.get(p.socketId);
      if (s) s.data.playerIndex = i;
    }
  });

  // Notify all players
  io.to(room.id).emit(reason === 'left' ? 'playerLeft' : 'playerRemoved', { name: removedName });
  room.players.forEach((p, i) => {
    if (p.connected) io.to(p.socketId).emit('yourIndex', i);
  });

  // Handle state transitions
  if (room.state === 'playing') {
    if (room.currentTrick.length >= room.players.length) {
      setTimeout(() => resolveTrick(room), 1000);
    } else {
      broadcastGameState(room);
    }
  } else if (room.state === 'bidding') {
    if (room.players.every((_, i) => room.bidsReady[i])) {
      setTimeout(() => { room.state = 'playing'; broadcastGameState(room); }, 300);
    } else {
      broadcastGameState(room);
    }
  } else {
    broadcastGameState(room);
  }

  console.log(`${removedName} removed from game ${room.id} (${room.players.length} remain)`);
}

// ─── AUTH API ──────────────────────────────────────────────────────────────────

// Check if configured
app.get('/auth/status', (req, res) => {
  res.json({ configured: !!(GOOGLE_CLIENT_ID && db), clientId: GOOGLE_CLIENT_ID });
});

// Google token login
app.post('/auth/google', async (req, res) => {
  if (!GOOGLE_CLIENT_ID) return res.status(503).json({ error: 'Google auth not configured' });
  if (!db) return res.status(503).json({ error: 'Database not connected' });
  const { credential } = req.body;
  if (!credential) return res.status(400).json({ error: 'No credential' });
  try {
    const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
    const payload = ticket.getPayload();
    const googleId = payload.sub;
    const picture = payload.picture || '';
    const name = payload.name || '';

    let user = await timeQuery('findOne user by googleId', () => db.collection('users').findOne({ googleId }));
    if (!user) {
      return res.json({ status: 'new', googleId, picture, name });
    }

    const sessionToken = crypto.randomBytes(24).toString('hex');
    await timeQuery('updateOne auth sessionToken', () => db.collection('users').updateOne({ googleId }, {
      $set: { sessionToken, lastSeen: new Date(), picture }
    }));
    return res.json({ status: 'ok', sessionToken, gameName: user.gameName, googleId, picture });
  } catch (e) {
    console.error('Auth error:', e.message);
    return res.status(401).json({ error: 'Invalid token' });
  }
});

// Register new user with game name
app.post('/auth/register', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'DB not available' });
  const { googleId, gameName, credential, picture } = req.body;
  const name = (gameName || '').trim();
  if (!name || name.length < 3 || name.length > 16)
    return res.status(400).json({ error: 'Name must be 3–16 characters' });
  if (!/^[a-zA-Z0-9_]+$/.test(name))
    return res.status(400).json({ error: 'Letters, numbers and _ only' });
  try {
    const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
    const payload = ticket.getPayload();
    if (payload.sub !== googleId) return res.status(401).json({ error: 'Token mismatch' });

    const sessionToken = crypto.randomBytes(24).toString('hex');
    const nameLower = name.toLowerCase();
    await timeQuery('insertOne register user', () => db.collection('users').insertOne({
      googleId, gameName: name, gameNameLower: nameLower, picture: picture || '',
      sessionToken, friends: [], createdAt: new Date(), lastSeen: new Date(),
    }));
    gameNameIndex.set(nameLower, googleId);
    return res.json({ status: 'ok', sessionToken, gameName: name, googleId });
  } catch (e) {
    if (e.code === 11000) return res.status(409).json({ error: 'Name already taken — try another' });
    return res.status(500).json({ error: e.message });
  }
});

// Validate session
app.post('/auth/session', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'DB not available' });
  const { sessionToken } = req.body;
  if (!sessionToken) return res.status(400).json({ error: 'No token' });
  const user = await timeQuery('findOne user by sessionToken', () => db.collection('users').findOne({ sessionToken }));
  if (!user) return res.status(401).json({ error: 'Invalid session' });
  await timeQuery('updateOne user lastSeen', () => db.collection('users').updateOne({ sessionToken }, { $set: { lastSeen: new Date() } }));
  return res.json({ status: 'ok', gameName: user.gameName, googleId: user.googleId, picture: user.picture });
});

// Rename game name
app.post('/auth/rename', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'DB not available' });
  const user = await userFromSession(req.body.sessionToken);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const newName = (req.body.gameName || '').trim();
  if (!newName || newName.length < 3 || newName.length > 16)
    return res.status(400).json({ error: 'Name must be 3–16 characters' });
  if (!/^[a-zA-Z0-9_]+$/.test(newName))
    return res.status(400).json({ error: 'Letters, numbers and _ only' });
  if (newName === user.gameName) return res.status(400).json({ error: 'That is already your name' });
  try {
    const oldName = user.gameName;
    const oldNameLower = oldName.toLowerCase();
    const newNameLower = newName.toLowerCase();
    await timeQuery('updateOne rename user', () => db.collection('users').updateOne({ sessionToken: req.body.sessionToken }, { $set: { gameName: newName, gameNameLower: newNameLower } }));
    gameNameIndex.delete(oldNameLower);
    gameNameIndex.set(newNameLower, user.googleId);

    // Update friends lists that reference old name
    await timeQuery('updateMany friends rename', () => db.collection('users').updateMany({ friends: oldName }, { $set: { 'friends.$': newName } }));
    // Update pending friend requests
    await timeQuery('updateMany friendRequests from rename', () => db.collection('friendRequests').updateMany({ from: oldName }, { $set: { from: newName } }));
    await timeQuery('updateMany friendRequests to rename', () => db.collection('friendRequests').updateMany({ to: oldName }, { $set: { to: newName } }));
    // Update onlineUsers map
    if (onlineUsers[user.googleId]) {
      onlineUsers[user.googleId].gameName = newName;
      const s = io.sockets.sockets.get(onlineUsers[user.googleId].socketId);
      if (s) { s.data.gameName = newName; }
    }
    return res.json({ status: 'ok', gameName: newName });
  } catch (e) {
    if (e.code === 11000) return res.status(409).json({ error: 'Name already taken — try another' });
    return res.status(500).json({ error: e.message });
  }
});

// ─── FRIENDS API ──────────────────────────────────────────────────────────────
async function userFromSession(token) {
  if (!db || !token) return null;
  return timeQuery('findOne userFromSession', () => db.collection('users').findOne({ sessionToken: token }));
}

app.post('/friends/list', async (req, res) => {
  const user = await userFromSession(req.body.sessionToken);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const friendDocs = await timeQuery('find friendDocs batch', () => db.collection('users').find({ gameName: { $in: user.friends || [] } }).toArray());
  const list = friendDocs.map(f => {
    const online = onlineUsers[f.googleId];
    return {
      gameName: f.gameName, picture: f.picture || '',
      online: !!online,
      inGame: online ? !!online.roomId : false,
      roomId: online?.roomId || null,
      status: online ? (online.roomId ? 'in-game' : 'online') : 'offline',
    };
  }).sort((a, b) => {
    if (a.online && !b.online) return -1;
    if (!a.online && b.online) return 1;
    return a.gameName.localeCompare(b.gameName);
  });

  const pending = await timeQuery('find pending friendRequests', () => db.collection('friendRequests').find({
    $or: [{ from: user.gameName }, { to: user.gameName }], status: 'pending'
  }).toArray());

  res.json({ friends: list, pending });
});

app.post('/friends/request', async (req, res) => {
  const user = await userFromSession(req.body.sessionToken);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const target = (req.body.gameName || '').trim();
  if (!target || target.toLowerCase() === user.gameName.toLowerCase()) return res.status(400).json({ error: 'Invalid target' });

  const targetUser = await findUserByGameName(target);
  if (!targetUser) return res.status(404).json({ error: 'Player not found' });
  if ((user.friends || []).includes(targetUser.gameName)) return res.status(409).json({ error: 'Already friends' });

  try {
    await timeQuery('insertOne friendRequest', () => db.collection('friendRequests').insertOne({
      from: user.gameName, to: targetUser.gameName, status: 'pending', createdAt: new Date()
    }));
  } catch (e) {
    if (e.code === 11000) return res.status(409).json({ error: 'Request already sent' });
    return res.status(500).json({ error: e.message });
  }

  const targetOnline = onlineUsers[targetUser.googleId];
  if (targetOnline) io.to(targetOnline.socketId).emit('friendRequest', { from: user.gameName, picture: user.picture || '' });
  res.json({ status: 'ok' });
});

app.post('/friends/respond', async (req, res) => {
  const user = await userFromSession(req.body.sessionToken);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const { from, action } = req.body;
  const request = await timeQuery('findOne friendRequest pending', () => db.collection('friendRequests').findOne({ from, to: user.gameName, status: 'pending' }));
  if (!request) return res.status(404).json({ error: 'Request not found' });

  await timeQuery('updateOne friendRequest status', () => db.collection('friendRequests').updateOne({ _id: request._id }, { $set: { status: action } }));
  if (action === 'accept') {
    await timeQuery('updateOne user friends accept 1', () => db.collection('users').updateOne({ gameName: user.gameName }, { $addToSet: { friends: from } }));
    await timeQuery('updateOne user friends accept 2', () => db.collection('users').updateOne({ gameName: from }, { $addToSet: { friends: user.gameName } }));
    const fromUser = await findUserByGameName(from);
    const fromOnline = fromUser ? onlineUsers[fromUser.googleId] : null;
    if (fromOnline) io.to(fromOnline.socketId).emit('friendAccepted', { gameName: user.gameName, picture: user.picture || '' });
  }
  res.json({ status: 'ok' });
});

// ─── SOCKET ───────────────────────────────────────────────────────────────────
function onTimed(socket, eventName, handler) {
  socket.on(eventName, async (...args) => {
    if (!DEBUG_TIMING) return handler(...args);
    const start = process.hrtime.bigint();
    try {
      await handler(...args);
    } finally {
      const end = process.hrtime.bigint();
      console.log(`[Socket Timing] ${eventName} (${socket.id}): ${(Number(end - start) / 1e6).toFixed(2)}ms`);
    }
  });
}

io.on('connection', socket => {
  debugLog('connect', socket.id);

  // ── AUTH ─────────────────────────────────────────────────────────────────────
  socket.on('authenticate', async ({ sessionToken }) => {
    if (!db || !sessionToken) return;
    const user = await timeQuery('findOne user authenticate', () => db.collection('users').findOne({ sessionToken }));
    if (!user) return;
    socket.data.googleId = user.googleId;
    socket.data.gameName = user.gameName;
    socket.data.sessionToken = sessionToken;
    onlineUsers[user.googleId] = { socketId: socket.id, gameName: user.gameName, roomId: null, status: 'online' };
    if (user.gameName) {
      gameNameIndex.set(user.gameName.toLowerCase(), user.googleId);
    }
    broadcastFriendStatus(user.gameName);
    socket.emit('authenticated', { gameName: user.gameName });
  });

  // ── INVITE FRIEND ─────────────────────────────────────────────────────────────
  onTimed(socket, 'inviteFriend', async ({ targetGameName }) => {
    const roomId = socket.data.roomId;
    const gameName = socket.data.gameName;
    if (!gameName || !db) return socket.emit('error', 'Not authenticated');
    if (!roomId) return socket.emit('error', 'You must be in a room to invite');
    const room = rooms[roomId];
    if (!room || room.state !== 'lobby') return socket.emit('error', 'Room not in lobby state');

    const cleanTarget = (targetGameName || '').trim();
    if (!cleanTarget) return socket.emit('error', 'Player name required');
    const targetLower = cleanTarget.toLowerCase();

    // 1. Direct memory check in onlineUsers (instant, 0 DB overhead)
    let targetOnline = Object.values(onlineUsers).find(u => u.gameName && u.gameName.toLowerCase() === targetLower);
    let targetUser = null;

    if (targetOnline) {
      const targetGId = Object.keys(onlineUsers).find(gid => onlineUsers[gid] === targetOnline);
      targetUser = { googleId: targetGId, gameName: targetOnline.gameName };
    } else {
      targetUser = await findUserByGameName(cleanTarget);
      if (targetUser) {
        targetOnline = onlineUsers[targetUser.googleId];
      }
    }

    if (!targetUser) return socket.emit('error', 'Player not found');
    if (!targetOnline) return socket.emit('error', `${targetUser.gameName || cleanTarget} is offline`);
    if (targetOnline.roomId) return socket.emit('error', `${targetUser.gameName || cleanTarget} is already in a room`);

    io.to(targetOnline.socketId).emit('gameInvite', { from: gameName, roomId, roomPlayerCount: room.players.length });
    socket.emit('inviteSent', { to: targetOnline.gameName || targetUser.gameName || cleanTarget });
  });

  // ── CREATE ROOM ───────────────────────────────────────────────────────────────
  socket.on('createRoom', ({ playerName }) => {
    const displayName = socket.data.gameName || (playerName || '').trim();
    if (!displayName) return socket.emit('error', 'Name required');

    const roomId = genId();
    const token = genToken();
    rooms[roomId] = {
      id: roomId, hostSocketId: socket.id,
      gameType: null,  // set when host selects game mode
      players: [{ socketId: socket.id, name: displayName, gameName: socket.data.gameName || null, googleId: socket.data.googleId || null, connected: true, token }],
      spectators: [],
      state: 'lobby', currentRound: 0, totalRounds: 0,
      playerOrder: [], hands: {}, bids: {}, bidsReady: {},
      tricks: {}, currentTrick: [], currentLeader: 0,
      leadSuit: null, trumpSuit: null, scores: {}, roundScores: [],
    };
    socket.join(roomId);
    socket.data.roomId = roomId; socket.data.playerIndex = 0; socket.data.token = token; socket.data.isSpectator = false;
    if (socket.data.googleId) { onlineUsers[socket.data.googleId] = { ...onlineUsers[socket.data.googleId], roomId, status: 'in-lobby' }; broadcastFriendStatus(displayName); }
    socket.emit('joinedRoom', { roomId, playerIndex: 0, playerToken: token, playerName: displayName });
    broadcastRoomUpdate(rooms[roomId]);
  });

  // ── JOIN ROOM ─────────────────────────────────────────────────────────────────
  onTimed(socket, 'joinRoom', ({ roomId, playerName }) => {
    const code = (roomId || '').trim().toUpperCase();
    const name = socket.data.gameName || (playerName || '').trim();
    if (!code) return socket.emit('error', 'Room code required');
    if (!name) return socket.emit('error', 'Name required');

    const room = rooms[code];
    if (!room) return socket.emit('error', 'Room not found');
    if (room.state !== 'lobby') return socket.emit('error', 'Game already started');
    if (room.players.length >= 7) return socket.emit('error', 'Room is full (max 7)');

    // Check if already in this room
    const existByToken = socket.data.token ? room.players.findIndex(p => p.token === socket.data.token) : -1;
    const existByGoogle = socket.data.googleId ? room.players.findIndex(p => p.googleId === socket.data.googleId) : -1;
    const existIdx = existByToken !== -1 ? existByToken : existByGoogle;

    if (existIdx !== -1) {
      const p = room.players[existIdx];
      p.socketId = socket.id; p.connected = true;
      socket.join(code); socket.data.roomId = code; socket.data.playerIndex = existIdx; socket.data.token = p.token; socket.data.isSpectator = false;
      socket.emit('joinedRoom', { roomId: code, playerIndex: existIdx, playerToken: p.token, playerName: p.name, isRejoin: true });
      broadcastRoomUpdate(room); return;
    }

    // Leave any previous room before joining a new one
    if (socket.data.roomId && socket.data.roomId !== code && rooms[socket.data.roomId]) {
      const oldRoom = rooms[socket.data.roomId];
      const oldIdx = oldRoom.players.findIndex(p => p.socketId === socket.id);
      if (oldIdx !== -1) { if (oldRoom.state === 'lobby') oldRoom.players.splice(oldIdx, 1); else oldRoom.players[oldIdx].connected = false; }
      socket.leave(socket.data.roomId);
      if (oldRoom.players.length) broadcastRoomUpdate(oldRoom);
    }

    const token = genToken(), playerIndex = room.players.length;
    room.players.push({ socketId: socket.id, name, gameName: socket.data.gameName || null, googleId: socket.data.googleId || null, connected: true, token });
    socket.join(code); socket.data.roomId = code; socket.data.playerIndex = playerIndex; socket.data.token = token; socket.data.isSpectator = false;
    if (socket.data.googleId) { onlineUsers[socket.data.googleId] = { ...onlineUsers[socket.data.googleId], roomId: code, status: 'in-lobby' }; broadcastFriendStatus(name); }
    socket.emit('joinedRoom', { roomId: code, playerIndex, playerToken: token, playerName: name });
    if (room.chatHistory?.length) socket.emit('chatHistory', { messages: room.chatHistory });
    broadcastRoomUpdate(room);
    debugLog(`${name} joined ${code}`);
  });

  // ── REJOIN ROOM ───────────────────────────────────────────────────────────────
  onTimed(socket, 'rejoinRoom', ({ roomId, playerToken }) => {
    const room = rooms[roomId];
    if (!room) return socket.emit('rejoinFailed', 'Room no longer exists');

    let playerIndex = room.players.findIndex(p => p.token === playerToken);
    // Fallback: find by googleId if token changed (e.g. after server restart)
    if (playerIndex === -1 && socket.data.googleId)
      playerIndex = room.players.findIndex(p => p.googleId === socket.data.googleId);
    if (playerIndex === -1) return socket.emit('rejoinFailed', 'Session not found');

    const player = room.players[playerIndex];
    const wasHost = room.hostSocketId === player.socketId;
    player.socketId = socket.id; player.connected = true;
    if (wasHost) room.hostSocketId = socket.id;

    socket.join(roomId); socket.data.roomId = roomId; socket.data.playerIndex = playerIndex;
    socket.data.token = player.token; socket.data.isSpectator = false;
    if (player.googleId) { socket.data.googleId = player.googleId; socket.data.gameName = player.gameName; }

    if (player.googleId) {
      onlineUsers[player.googleId] = { socketId: socket.id, gameName: player.gameName, roomId, status: room.state === 'lobby' ? 'in-lobby' : 'in-game' };
    }

    socket.emit('joinedRoom', { roomId, playerIndex, playerToken: player.token, playerName: player.name, isRejoin: true });
    if (room.chatHistory?.length) socket.emit('chatHistory', { messages: room.chatHistory });
    if (room.state === 'lobby') broadcastRoomUpdate(room);
    else {
      // Dispatch state builder based on game type
      if (room.gameType === 'kaaliTeeri') socket.emit('gameState', kaaliTeeri.buildPlayerState(room, playerIndex));
      else socket.emit('gameState', buildPlayerState(room, playerIndex));
      io.to(roomId).emit('playerRejoined', { playerIndex, name: player.name });
    }
    debugLog(`${player.name} rejoined ${roomId}`);
  });

  // ── SPECTATE ──────────────────────────────────────────────────────────────────
  socket.on('spectateRoom', ({ roomId }) => {
    const code = (roomId || '').trim().toUpperCase();
    const room = rooms[code];
    if (!room) return socket.emit('error', 'Room not found');

    const gameName = socket.data.gameName || ('Guest_' + socket.id.slice(0, 4));
    room.spectators = (room.spectators || []).filter(s => s.socketId !== socket.id);
    room.spectators.push({ socketId: socket.id, gameName });

    socket.join(code); socket.data.roomId = code; socket.data.isSpectator = true;
    socket.emit('spectating', { roomId: code });
    if (room.chatHistory?.length) socket.emit('chatHistory', { messages: room.chatHistory });
    if (room.state === 'lobby') socket.emit('roomUpdate', sanitizeRoom(room, null));
    else if (room.gameType === 'kaaliTeeri') socket.emit('gameState', kaaliTeeri.buildSpectatorState(room));
    else socket.emit('gameState', buildSpectatorState(room));
    io.to(code).emit('spectatorJoined', { gameName });
  });

  // ── KICK ──────────────────────────────────────────────────────────────────────
  onTimed(socket, 'kickPlayer', ({ playerIndex }) => {
    const room = rooms[socket.data.roomId];
    if (!room || room.state !== 'lobby') return;
    if (room.hostSocketId !== socket.id) return socket.emit('error', 'Only host can kick');
    if (playerIndex <= 0 || playerIndex >= room.players.length) return;
    const kicked = room.players[playerIndex];
    if (kicked.connected) io.to(kicked.socketId).emit('kicked', 'You were removed by the host');
    room.players.splice(playerIndex, 1);
    broadcastRoomUpdate(room);
  });

  // ── VOTE KICK OFFLINE PLAYER ──────────────────────────────────────────────────
  onTimed(socket, 'voteKickPlayer', ({ targetIndex }) => {
    const room = rooms[socket.data.roomId];
    if (!room || room.state === 'lobby') return;
    const pIdx = socket.data.playerIndex;
    if (pIdx === null || pIdx === undefined) return;
    const target = room.players[targetIndex];
    if (!target || target.connected) return socket.emit('error', 'Can only vote to kick offline players');
    if (targetIndex === pIdx) return;

    if (!room.kickVotes) room.kickVotes = {};
    if (!room.kickVotes[targetIndex]) room.kickVotes[targetIndex] = new Set();
    room.kickVotes[targetIndex].add(pIdx);

    const connectedCount = room.players.filter((p, i) => p.connected && i !== targetIndex).length;
    const votes = room.kickVotes[targetIndex].size;

    io.to(room.id).emit('kickVoteUpdate', {
      targetIndex, targetName: target.name,
      votes, needed: connectedCount,
      voters: [...room.kickVotes[targetIndex]].map(i => room.players[i]?.name).filter(Boolean),
    });

    if (votes >= connectedCount) {
      debugLog(`Vote kick passed for ${target.name} in ${room.id}`);
      removePlayerFromGame(room, targetIndex);
    }
  });

  // ── SELECT GAME TYPE (host only, in lobby) ────────────────────────────────────
  socket.on('selectGameType', ({ gameType }) => {
    const room = rooms[socket.data.roomId];
    if (!room || room.hostSocketId !== socket.id) return;
    if (room.state !== 'lobby') return;
    if (!GAMES[gameType]) return socket.emit('error', 'Unknown game type');
    room.gameType = gameType;
    broadcastRoomUpdate(room);
  });

  // ── START GAME ────────────────────────────────────────────────────────────────
  socket.on('startGame', ({ totalRounds: chosen, gameType: requestedType }) => {
    const room = rooms[socket.data.roomId];
    if (!room || room.hostSocketId !== socket.id) return;

    // Determine effective game type
    const selectedType = requestedType || room.gameType || 'kachuPhul';
    room.gameType = selectedType;

    // ── Kaali Teeri branch ──────────────────────────────────────────────────────
    if (selectedType === 'kaaliTeeri') {
      room.players = room.players.filter(p => p.connected);
      const err = kaaliTeeri.validateStart(room);
      if (err) return socket.emit('error', err);
      room.players.forEach((p, i) => io.to(p.socketId).emit('yourIndex', i));
      room.players.forEach(p => { if (p.googleId && onlineUsers[p.googleId]) { onlineUsers[p.googleId].status = 'in-game'; } });
      broadcastFriendStatuses();
      kaaliTeeri.initGame(room, io, broadcastGameState);
      debugLog(`KT game started ${room.id}`);
      return;
    }

    // ── Kachu Phul branch (existing logic) ──────────────────────────────────────
    room.players = room.players.filter(p => p.connected);
    if (room.players.length < 2) return socket.emit('error', 'Need at least 2 players');

    const maxRounds = Math.floor(52 / room.players.length);
    const totalRounds = (chosen && chosen >= 1 && chosen <= maxRounds) ? chosen : maxRounds;

    room.totalRounds = totalRounds; room.currentRound = 0; room.scores = {}; room.roundScores = [];
    // Shuffle player order
    const indices = room.players.map((_, i) => i);
    for (let i = indices.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[indices[i], indices[j]] = [indices[j], indices[i]]; }
    room.playerOrder = indices;
    room.players.forEach((_, i) => { room.scores[i] = 0; });
    room.players.forEach((p, i) => io.to(p.socketId).emit('yourIndex', i));
    room.players.forEach(p => { if (p.googleId && onlineUsers[p.googleId]) { onlineUsers[p.googleId].status = 'in-game'; } });
    broadcastFriendStatuses();
    startRound(room);
    debugLog(`game started ${room.id}: ${totalRounds} rounds`);
  });

  // ── KAALI TEERI EVENTS ────────────────────────────────────────────────────────
  socket.on('ktBid', (data) => {
    const room = rooms[socket.data.roomId];
    if (!room || room.gameType !== 'kaaliTeeri') return;
    const err = kaaliTeeri.handleBid(room, socket.data.playerIndex, data, io, broadcastGameState);
    if (err) socket.emit('error', err);
  });

  socket.on('ktSelectTrump', (data) => {
    const room = rooms[socket.data.roomId];
    if (!room || room.gameType !== 'kaaliTeeri') return;
    const err = kaaliTeeri.handleTrumpSelect(room, socket.data.playerIndex, data, io, broadcastGameState);
    if (err) socket.emit('error', err);
  });

  socket.on('ktSelectPartners', (data) => {
    const room = rooms[socket.data.roomId];
    if (!room || room.gameType !== 'kaaliTeeri') return;
    const err = kaaliTeeri.handlePartnerSelect(room, socket.data.playerIndex, data, io, broadcastGameState);
    if (err) socket.emit('error', err);
  });

  socket.on('ktPlayCard', (data) => {
    const room = rooms[socket.data.roomId];
    if (!room || room.gameType !== 'kaaliTeeri') return;
    const err = kaaliTeeri.handlePlayCard(room, socket.data.playerIndex, data, io, broadcastGameState);
    if (err) socket.emit('error', err);
  });

  // KT play-again (reuse existing playAgain socket event — handled below)
  socket.on('ktPlayAgain', () => {
    const room = rooms[socket.data.roomId];
    if (!room || room.gameType !== 'kaaliTeeri' || room.state !== 'game_over') return;
    const pIdx = socket.data.playerIndex;
    if (!room.playAgainVotes) room.playAgainVotes = new Set();
    room.playAgainVotes.add(pIdx);
    const votes = [...room.playAgainVotes].map(i => room.players[i]?.name).filter(Boolean);
    io.to(room.id).emit('playAgainUpdate', { votes, total: room.players.length });
    if (room.playAgainVotes.size === room.players.length) {
      const newRoomId = genId();
      const newRoom = {
        id: newRoomId, hostSocketId: null, gameType: 'kaaliTeeri',
        players: [], spectators: [],
        state: 'lobby', currentRound: 0, totalRounds: 0,
        playerOrder: [], hands: {}, bids: {}, bidsReady: {},
        tricks: {}, currentTrick: [], currentLeader: 0,
        leadSuit: null, trumpSuit: null, scores: {}, roundScores: [],
      };
      room.players.forEach((p, i) => {
        const newToken = genToken();
        newRoom.players.push({ ...p, token: newToken });
        if (i === 0) newRoom.hostSocketId = p.socketId;
        if (p.connected) io.to(p.socketId).emit('newLobby', { roomId: newRoomId, playerIndex: i, playerToken: newToken, playerName: p.name });
      });
      const first = newRoom.players.find(p => p.connected);
      if (first) newRoom.hostSocketId = first.socketId;
      rooms[newRoomId] = newRoom;
      newRoom.players.forEach((p, i) => {
        if (p.connected) {
          const s = io.sockets.sockets.get(p.socketId);
          if (s) { s.leave(room.id); s.join(newRoomId); s.data.roomId = newRoomId; s.data.playerIndex = i; s.data.token = p.token; }
        }
      });
      newRoom.players.forEach(p => { if (p.connected) io.to(p.socketId).emit('roomUpdate', sanitizeRoom(newRoom, p.socketId)); });
      delete rooms[room.id];
    }
  });

  // ── BID ───────────────────────────────────────────────────────────────────────
  socket.on('submitBid', ({ bid }) => {
    const room = rooms[socket.data.roomId];
    const pIdx = socket.data.playerIndex;
    if (!room || room.state !== 'bidding') return;
    if (typeof bid !== 'number' || bid < 0) return;
    if (room.bidsReady[pIdx]) return;
    const maxBid = room.hands[pIdx]?.length ?? 0;
    if (bid > maxBid) return socket.emit('error', `Max bid is ${maxBid}`);
    room.bids[pIdx] = bid; room.bidsReady[pIdx] = true;
    broadcastGameState(room);
    if (room.players.every((_, i) => room.bidsReady[i])) { setTimeout(() => { room.state = 'playing'; broadcastGameState(room); }, 300); }
  });

  // ── PLAY CARD ─────────────────────────────────────────────────────────────────
  socket.on('playCard', ({ cardId }) => {
    const room = rooms[socket.data.roomId];
    const pIdx = socket.data.playerIndex;
    if (!room || room.state !== 'playing') return;
    if (room.currentTrick.length >= room.players.length) return; // trick complete, waiting for resolution
    if (getCurrentTurn(room) !== pIdx) return socket.emit('error', 'Not your turn');

    const hand = room.hands[pIdx];
    const cardIdx = hand?.findIndex(c => c.id === cardId);
    if (cardIdx === -1 || cardIdx === undefined) return socket.emit('error', 'Card not in hand');
    const card = hand[cardIdx];

    if (room.currentTrick.length > 0) {
      const hasLead = hand.some(c => c.suit === room.leadSuit);
      if (hasLead && card.suit !== room.leadSuit) return socket.emit('error', `Must follow suit: ${room.leadSuit}`);
    }

    if (room.currentTrick.length === 0) room.leadSuit = card.suit;
    hand.splice(cardIdx, 1);
    room.currentTrick.push({ playerIndex: pIdx, card });
    broadcastGameState(room);
    if (room.currentTrick.length === room.players.length) setTimeout(() => resolveTrick(room), 1000);
  });

  // ── PLAY AGAIN ────────────────────────────────────────────────────────────────
  socket.on('playAgain', () => {
    const room = rooms[socket.data.roomId];
    if (!room || room.state !== 'game_over') return;
    const pIdx = socket.data.playerIndex;
    if (!room.playAgainVotes) room.playAgainVotes = new Set();
    room.playAgainVotes.add(pIdx);
    const votes = [...room.playAgainVotes].map(i => room.players[i]?.name).filter(Boolean);
    io.to(room.id).emit('playAgainUpdate', { votes, total: room.players.length });

    if (room.playAgainVotes.size === room.players.length) {
      const newRoomId = genId();
      const newRoom = {
        id: newRoomId, hostSocketId: null,
        players: [], spectators: [],
        state: 'lobby', currentRound: 0, totalRounds: 0,
        playerOrder: [], hands: {}, bids: {}, bidsReady: {},
        tricks: {}, currentTrick: [], currentLeader: 0,
        leadSuit: null, trumpSuit: null, scores: {}, roundScores: [],
      };
      room.players.forEach((p, i) => {
        const newToken = genToken();
        newRoom.players.push({ ...p, token: newToken });
        if (i === 0) newRoom.hostSocketId = p.socketId;
        if (p.connected) io.to(p.socketId).emit('newLobby', { roomId: newRoomId, playerIndex: i, playerToken: newToken, playerName: p.name });
      });
      const first = newRoom.players.find(p => p.connected);
      if (first) newRoom.hostSocketId = first.socketId;
      rooms[newRoomId] = newRoom;
      newRoom.players.forEach((p, i) => {
        if (p.connected) {
          const s = io.sockets.sockets.get(p.socketId);
          if (s) { s.leave(room.id); s.join(newRoomId); s.data.roomId = newRoomId; s.data.playerIndex = i; s.data.token = p.token; }
        }
      });
      newRoom.players.forEach(p => { if (p.connected) io.to(p.socketId).emit('roomUpdate', sanitizeRoom(newRoom, p.socketId)); });
      delete rooms[room.id];
    }
  });

  // ── CHAT ─────────────────────────────────────────────────────────────────────
  socket.on('chatMessage', ({ message }) => {
    const roomId = socket.data.roomId;
    if (!roomId || !rooms[roomId]) return;
    const room = rooms[roomId];
    const msg = (message || '').trim().slice(0, 200);
    if (!msg) return;
    const name = socket.data.gameName || 'Guest';
    const playerIndex = socket.data.playerIndex ?? -1;
    const chatEntry = { name, playerIndex, message: msg, time: Date.now() };
    if (!room.chatHistory) room.chatHistory = [];
    room.chatHistory.push(chatEntry);
    if (room.chatHistory.length > 50) room.chatHistory.shift();
    io.to(roomId).emit('chatMessage', chatEntry);
  });

  // ── LEAVE ROOM ────────────────────────────────────────────────────────────────
  onTimed(socket, 'leaveRoom', () => {
    const roomId = socket.data.roomId;
    if (!roomId || !rooms[roomId]) {
      if (socket.data.googleId && onlineUsers[socket.data.googleId]) {
        onlineUsers[socket.data.googleId].roomId = null;
        onlineUsers[socket.data.googleId].status = 'online';
        broadcastFriendStatus(socket.data.gameName);
      }
      socket.data.roomId = null;
      return;
    }
    const room = rooms[roomId];
    if (socket.data.isSpectator) {
      room.spectators = (room.spectators || []).filter(s => s.socketId !== socket.id);
    } else {
      const pIdx = room.players.findIndex(p => p.socketId === socket.id);
      if (pIdx !== -1) {
        if (room.state === 'lobby') {
          room.players.splice(pIdx, 1);
        } else {
          // Active game — remove player completely and return early
          socket.leave(roomId);
          socket.data.roomId = null;
          socket.data.playerIndex = null;
          socket.data.token = null;
          socket.data.isSpectator = false;
          if (socket.data.googleId && onlineUsers[socket.data.googleId]) {
            onlineUsers[socket.data.googleId].roomId = null;
            onlineUsers[socket.data.googleId].status = 'online';
            broadcastFriendStatus(socket.data.gameName);
          }
          removePlayerFromGame(room, pIdx, 'left');
          return;
        }
      }
    }
    socket.leave(roomId);
    socket.data.roomId = null;
    socket.data.playerIndex = null;
    socket.data.token = null;
    socket.data.isSpectator = false;
    if (socket.data.googleId && onlineUsers[socket.data.googleId]) {
      onlineUsers[socket.data.googleId].roomId = null;
      onlineUsers[socket.data.googleId].status = 'online';
      broadcastFriendStatus(socket.data.gameName);
    }
    if (room.players.length || (room.spectators || []).length) broadcastRoomUpdate(room);
  });

  // ── DISCONNECT ────────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;

    // Remove from spectators
    if (socket.data.isSpectator && roomId && rooms[roomId]) {
      rooms[roomId].spectators = (rooms[roomId].spectators || []).filter(s => s.socketId !== socket.id);
      broadcastRoomUpdate(rooms[roomId]);
    }

    if (roomId && rooms[roomId] && !socket.data.isSpectator) {
      const room = rooms[roomId];
      const player = room.players[socket.data.playerIndex];
      if (player && player.socketId === socket.id) {
        player.connected = false;
        io.to(roomId).emit('playerDisconnected', { playerIndex: socket.data.playerIndex, name: player.name });
        if (room.state === 'lobby') broadcastRoomUpdate(room);
      }
    }

    if (socket.data.googleId) {
      setTimeout(() => {
        const current = onlineUsers[socket.data.googleId];
        if (current && current.socketId === socket.id) {
          delete onlineUsers[socket.data.googleId];
          broadcastFriendStatus(socket.data.gameName);
        }
      }, 5000); // 5s grace for reconnect
    }

    console.log(`${socket.data.gameName || socket.id} disconnected`);
  });
});

// ─── BROADCAST HELPERS ────────────────────────────────────────────────────────
function broadcastRoomUpdate(room) {
  room.players.forEach(p => { if (p.connected) io.to(p.socketId).emit('roomUpdate', sanitizeRoom(room, p.socketId)); });
  (room.spectators || []).forEach(s => io.to(s.socketId).emit('roomUpdate', sanitizeRoom(room, null)));
}
function broadcastGameState(room) {
  if (room.gameType === 'kaaliTeeri') {
    room.players.forEach((p, i) => { if (p.connected) io.to(p.socketId).emit('gameState', kaaliTeeri.buildPlayerState(room, i)); });
    (room.spectators || []).forEach(s => io.to(s.socketId).emit('gameState', kaaliTeeri.buildSpectatorState(room)));
    return;
  }
  room.players.forEach((p, i) => { if (p.connected) io.to(p.socketId).emit('gameState', buildPlayerState(room, i)); });
  (room.spectators || []).forEach(s => io.to(s.socketId).emit('gameState', buildSpectatorState(room)));
}
async function broadcastFriendStatus(gameName) {
  if (!db || !gameName) return;
  try {
    const user = await timeQuery(`findOne broadcast target (${gameName})`, () =>
      findUserByGameName(gameName)
    );
    if (!user || !user.friends || user.friends.length === 0) return;

    const friendDocs = await timeQuery(`find friends batch (${user.friends.length})`, () =>
      db.collection('users').find({ gameName: { $in: user.friends } }).toArray()
    );

    for (const fd of friendDocs) {
      const fo = onlineUsers[fd.googleId];
      if (fo) {
        const mine = onlineUsers[user.googleId];
        io.to(fo.socketId).emit('friendStatusUpdate', { gameName, online: !!mine, status: mine?.status || 'offline', roomId: mine?.roomId || null });
      }
    }
  } catch (e) { }
}
function broadcastFriendStatuses() {
  for (const gid of Object.keys(onlineUsers)) { const info = onlineUsers[gid]; if (info?.gameName) broadcastFriendStatus(info.gameName); }
}

// ─── GAME LOGIC ───────────────────────────────────────────────────────────────
function startRound(room) {
  room.state = 'bidding'; room.bids = {}; room.bidsReady = {}; room.tricks = {}; room.currentTrick = []; room.leadSuit = null;
  room.trumpSuit = getTrump(room.currentRound);
  room.players.forEach((_, i) => { room.tricks[i] = 0; room.bidsReady[i] = false; });
  const hands = dealCards(room.players.length, room.totalRounds, room.currentRound);
  room.players.forEach((_, i) => { room.hands[i] = hands[i]; });
  room.currentLeader = room.playerOrder[room.currentRound % room.playerOrder.length];
  broadcastGameState(room);
}
function resolveTrick(room) {
  const winner = trickWinner(room.currentTrick, room.leadSuit, room.trumpSuit);
  room.tricks[winner] = (room.tricks[winner] || 0) + 1;
  // Find the winning card from the trick
  const winningEntry = room.currentTrick.find(t => t.playerIndex === winner);
  const winningCard = winningEntry ? winningEntry.card : null;
  io.to(room.id).emit('trickWon', {
    winnerIndex: winner,
    winnerName: room.players[winner].name,
    winningCard: winningCard,
    trick: [...room.currentTrick], // send full trick so client can show animation
  });
  // Delay clearing the trick so clients can animate the winning card
  setTimeout(() => {
    room.currentTrick = []; room.leadSuit = null; room.currentLeader = winner;
    const cardsLeft = Object.values(room.hands).reduce((s, h) => s + h.length, 0);
    if (cardsLeft === 0) setTimeout(() => endRound(room), 1000);
    else broadcastGameState(room);
  }, 2000);
}
function endRound(room) {
  const results = room.players.map((p, i) => {
    const bid = room.bids[i] ?? 0, actual = room.tricks[i] ?? 0, points = roundScore(bid, actual);
    room.scores[i] = (room.scores[i] || 0) + points;
    return { playerIndex: i, name: p.name, bid, actual, points, totalScore: room.scores[i] };
  });
  room.roundScores.push(results); room.state = 'round_end';
  io.to(room.id).emit('roundEnd', { roundIndex: room.currentRound, results, scores: { ...room.scores } });
  room.currentRound++;
  if (room.currentRound >= room.totalRounds) setTimeout(() => endGame(room), 3000);
  else setTimeout(() => startRound(room), 4000);
}
function endGame(room) {
  room.state = 'game_over'; room.playAgainVotes = new Set();
  const finalScores = room.players.map((p, i) => ({ playerIndex: i, name: p.name, score: room.scores[i] || 0 })).sort((a, b) => b.score - a.score);
  io.to(room.id).emit('gameOver', { finalScores });
  broadcastGameState(room);
  room.players.forEach(p => { if (p.googleId && onlineUsers[p.googleId]) { onlineUsers[p.googleId].status = 'online'; onlineUsers[p.googleId].roomId = null; } });
  broadcastFriendStatuses();
}

function buildPlayerState(room, pIdx) {
  return {
    roomId: room.id, state: room.state, currentRound: room.currentRound, totalRounds: room.totalRounds,
    trumpSuit: room.trumpSuit, trumpSymbol: SUIT_SYMBOLS[room.trumpSuit] || '', trumpName: SUIT_NAMES[room.trumpSuit] || '',
    playerOrder: room.playerOrder,
    players: room.players.map((p, i) => ({
      index: i, name: p.name, connected: p.connected, isHost: room.hostSocketId === p.socketId,
      score: room.scores[i] || 0, bidReady: !!room.bidsReady[i],
      bid: (i === pIdx || ['playing', 'round_end', 'game_over'].includes(room.state)) ? (room.bids[i] ?? null) : null,
      tricksWon: room.tricks[i] || 0, cardsInHand: room.hands[i] ? room.hands[i].length : 0,
    })),
    myIndex: pIdx, myHand: room.hands[pIdx] || [], myBid: room.bids[pIdx] ?? null, myBidReady: !!room.bidsReady[pIdx],
    currentTrick: room.currentTrick, leadSuit: room.leadSuit, currentLeader: room.currentLeader,
    currentTurnIndex: getCurrentTurn(room), roundScores: room.roundScores, scores: { ...room.scores },
    spectatorCount: (room.spectators || []).length,
    playAgainVotes: room.playAgainVotes ? [...room.playAgainVotes].map(i => room.players[i]?.name).filter(Boolean) : [],
  };
}
function buildSpectatorState(room) {
  const s = buildPlayerState(room, -1);
  s.myHand = []; s.myBid = null; s.myIndex = -1; s.isSpectator = true;
  s.allHands = {}; room.players.forEach((_, i) => { s.allHands[i] = room.hands[i] || []; });
  return s;
}
function sanitizeRoom(room, forSocketId) {
  return {
    id: room.id, state: room.state, gameType: room.gameType || 'kachuPhul',
    players: room.players.map(p => ({ name: p.name, connected: p.connected, isHost: p.socketId === room.hostSocketId })),
    isHost: room.hostSocketId === forSocketId, maxRounds: room.players.length > 0 ? Math.floor(52 / room.players.length) : 0,
    spectatorCount: (room.spectators || []).length,
  };
}

server.listen(PORT, () => console.log(`🎴 Kachu Phul on port ${PORT}`));