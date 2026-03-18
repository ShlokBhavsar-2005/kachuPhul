const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const path = require('path');
const { MongoClient, ObjectId } = require('mongodb');
const { OAuth2Client } = require('google-auth-library');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── ENV CONFIG ───────────────────────────────────────────────────────────────
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const MONGO_URI        = process.env.MONGO_URI        || '';
const PORT             = process.env.PORT             || 3000;

const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

// ─── MONGODB SETUP ────────────────────────────────────────────────────────────
let db;
async function connectDB() {
  try {
    const client = new MongoClient(MONGO_URI);
    await client.connect();
    db = client.db('kachuphul');
    console.log('✅ MongoDB connected');
    await db.collection('users').createIndex({ googleId: 1 }, { unique: true });
    await db.collection('users').createIndex({ gameName: 1 }, { unique: true });
    await db.collection('friendRequests').createIndex({ from: 1, to: 1 }, { unique: true });
  } catch (e) {
    console.error('❌ MongoDB connection failed:', e.message);
    console.log('⚠️  Running without DB — auth features disabled');
  }
}
connectDB();

// ─── GAME CONSTANTS ──────────────────────────────────────────────────────────
const SUITS       = ['spades', 'diamonds', 'clubs', 'hearts'];
const SUIT_SYMBOLS = { spades:'♠', diamonds:'♦', clubs:'♣', hearts:'♥' };
const SUIT_NAMES   = { spades:'Spades', diamonds:'Diamonds', clubs:'Clubs', hearts:'Hearts' };
const RANKS        = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const RANK_VALUE   = {'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14};

// ─── IN-MEMORY STORES ────────────────────────────────────────────────────────
const rooms   = {};    // roomId → room
const onlineUsers = {}; // googleId → { socketId, gameName, roomId, status }

// ─── AUTH API ─────────────────────────────────────────────────────────────────

// Verify Google ID token and login/register user
app.post('/auth/google', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'DB not available' });
  const { idToken } = req.body;
  if (!idToken) return res.status(400).json({ error: 'No token' });

  try {
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    const googleId = payload.sub;
    const email    = payload.email;
    const picture  = payload.picture;

    let user = await db.collection('users').findOne({ googleId });

    if (!user) {
      // New user — needs to pick a game name
      return res.json({ status: 'new', googleId, email, picture });
    }

    // Existing user — return session
    const sessionToken = crypto.randomBytes(24).toString('hex');
    await db.collection('users').updateOne({ googleId }, {
      $set: { sessionToken, lastSeen: new Date(), picture }
    });

    return res.json({
      status: 'ok',
      sessionToken,
      gameName: user.gameName,
      googleId,
      picture,
    });
  } catch (e) {
    console.error('Google auth error:', e.message);
    return res.status(401).json({ error: 'Invalid token' });
  }
});

// Register a game name for new user
app.post('/auth/register', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'DB not available' });
  const { googleId, gameName, idToken, picture } = req.body;

  if (!gameName || gameName.trim().length < 2 || gameName.trim().length > 16) {
    return res.status(400).json({ error: 'Game name must be 2–16 characters' });
  }
  if (!/^[a-zA-Z0-9_]+$/.test(gameName.trim())) {
    return res.status(400).json({ error: 'Only letters, numbers and underscore allowed' });
  }

  try {
    // Verify the token again for security
    const ticket = await googleClient.verifyIdToken({ idToken, audience: GOOGLE_CLIENT_ID });
    const payload = ticket.getPayload();
    if (payload.sub !== googleId) return res.status(401).json({ error: 'Token mismatch' });

    const sessionToken = crypto.randomBytes(24).toString('hex');
    await db.collection('users').insertOne({
      googleId,
      gameName: gameName.trim(),
      email: payload.email,
      picture: picture || '',
      sessionToken,
      friends: [],
      createdAt: new Date(),
      lastSeen: new Date(),
    });

    return res.json({ status: 'ok', sessionToken, gameName: gameName.trim(), googleId });
  } catch (e) {
    if (e.code === 11000) return res.status(409).json({ error: 'Game name already taken' });
    return res.status(500).json({ error: e.message });
  }
});

// Validate existing session token
app.post('/auth/session', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'DB not available' });
  const { sessionToken } = req.body;
  if (!sessionToken) return res.status(400).json({ error: 'No token' });

  const user = await db.collection('users').findOne({ sessionToken });
  if (!user) return res.status(401).json({ error: 'Invalid session' });

  await db.collection('users').updateOne({ sessionToken }, { $set: { lastSeen: new Date() } });
  return res.json({ status: 'ok', gameName: user.gameName, googleId: user.googleId, picture: user.picture });
});

// Check game name availability
app.get('/auth/check-name/:name', async (req, res) => {
  if (!db) return res.json({ available: true });
  const name = req.params.name;
  const exists = await db.collection('users').findOne({ gameName: name });
  res.json({ available: !exists });
});

// ─── FRIENDS API ──────────────────────────────────────────────────────────────

async function getUserFromSession(sessionToken) {
  if (!db || !sessionToken) return null;
  return db.collection('users').findOne({ sessionToken });
}

// Get friends list with online status
app.post('/friends/list', async (req, res) => {
  const user = await getUserFromSession(req.body.sessionToken);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const friends = user.friends || [];
  const friendDocs = await db.collection('users').find({ gameName: { $in: friends } }).toArray();

  const list = friendDocs.map(f => {
    const online = onlineUsers[f.googleId];
    return {
      gameName: f.gameName,
      picture: f.picture,
      online: !!online,
      inGame: online ? !!online.roomId : false,
      roomId: online?.roomId || null,
      status: online ? (online.roomId ? 'in-game' : 'online') : 'offline',
    };
  });

  // Sort: online first, then offline
  list.sort((a, b) => {
    if (a.online && !b.online) return -1;
    if (!a.online && b.online) return 1;
    return a.gameName.localeCompare(b.gameName);
  });

  // Also fetch pending requests
  const pending = await db.collection('friendRequests').find({
    $or: [{ from: user.gameName }, { to: user.gameName }],
    status: 'pending'
  }).toArray();

  res.json({ friends: list, pending });
});

// Send friend request
app.post('/friends/request', async (req, res) => {
  const user = await getUserFromSession(req.body.sessionToken);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const target = req.body.gameName?.trim();
  if (!target || target === user.gameName) return res.status(400).json({ error: 'Invalid target' });

  const targetUser = await db.collection('users').findOne({ gameName: target });
  if (!targetUser) return res.status(404).json({ error: 'Player not found' });

  // Already friends?
  if ((user.friends || []).includes(target)) return res.status(409).json({ error: 'Already friends' });

  try {
    await db.collection('friendRequests').insertOne({
      from: user.gameName,
      to: target,
      status: 'pending',
      createdAt: new Date(),
    });
  } catch (e) {
    if (e.code === 11000) return res.status(409).json({ error: 'Request already sent' });
    return res.status(500).json({ error: e.message });
  }

  // Notify target if online via socket
  const targetOnline = onlineUsers[targetUser.googleId];
  if (targetOnline) {
    io.to(targetOnline.socketId).emit('friendRequest', {
      from: user.gameName,
      picture: user.picture,
    });
  }

  res.json({ status: 'ok' });
});

// Accept / reject friend request
app.post('/friends/respond', async (req, res) => {
  const user = await getUserFromSession(req.body.sessionToken);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const { from, action } = req.body; // action: 'accept' | 'reject'
  const request = await db.collection('friendRequests').findOne({
    from, to: user.gameName, status: 'pending'
  });
  if (!request) return res.status(404).json({ error: 'Request not found' });

  await db.collection('friendRequests').updateOne({ _id: request._id }, { $set: { status: action } });

  if (action === 'accept') {
    // Add each other as friends
    await db.collection('users').updateOne({ gameName: user.gameName }, { $addToSet: { friends: from } });
    await db.collection('users').updateOne({ gameName: from }, { $addToSet: { friends: user.gameName } });

    // Notify the requester
    const fromUser = await db.collection('users').findOne({ gameName: from });
    const fromOnline = fromUser ? onlineUsers[fromUser.googleId] : null;
    if (fromOnline) {
      io.to(fromOnline.socketId).emit('friendAccepted', { gameName: user.gameName, picture: user.picture });
    }
  }

  res.json({ status: 'ok' });
});

// Remove friend
app.post('/friends/remove', async (req, res) => {
  const user = await getUserFromSession(req.body.sessionToken);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const target = req.body.gameName;
  await db.collection('users').updateOne({ gameName: user.gameName }, { $pull: { friends: target } });
  await db.collection('users').updateOne({ gameName: target }, { $pull: { friends: user.gameName } });

  res.json({ status: 'ok' });
});

// ─── GAME HELPERS ─────────────────────────────────────────────────────────────
function genId(len = 6) { return Math.random().toString(36).substring(2, 2 + len).toUpperCase(); }
function genToken()      { return crypto.randomBytes(16).toString('hex'); }
function createDeck()    {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push({ suit:s, rank:r, id:`${r}_${s}` });
  return d;
}
function shuffle(d) {
  const a = [...d];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function getTrump(roundIndex)                  { return SUITS[roundIndex % 4]; }
function getCardsForRound(totalRounds, roundIndex) { return totalRounds - roundIndex; }
function dealCards(playerCount, totalRounds, roundIndex) {
  const n    = getCardsForRound(totalRounds, roundIndex);
  const deck = shuffle(createDeck());
  return Array.from({ length: playerCount }, (_, i) => deck.slice(i * n, (i + 1) * n));
}
function cardValue(card, leadSuit, trumpSuit) {
  if (card.suit === trumpSuit) return 1000 + RANK_VALUE[card.rank];
  if (card.suit === leadSuit)  return RANK_VALUE[card.rank];
  return 0;
}
function trickWinner(trick, leadSuit, trumpSuit) {
  let best = 0, bestVal = cardValue(trick[0].card, leadSuit, trumpSuit);
  for (let i = 1; i < trick.length; i++) {
    const v = cardValue(trick[i].card, leadSuit, trumpSuit);
    if (v > bestVal) { bestVal = v; best = i; }
  }
  return trick[best].playerIndex;
}
function roundScore(bid, actual) {
  if (bid === actual) return bid === 0 ? 1 : bid;
  return 0;
}

// ─── ROOM BROADCAST ───────────────────────────────────────────────────────────
function broadcastRoomUpdate(room) {
  room.players.forEach(p => {
    if (p.connected) io.to(p.socketId).emit('roomUpdate', sanitizeRoom(room, p.socketId));
  });
  // Spectators also get update
  (room.spectators || []).forEach(s => {
    io.to(s.socketId).emit('roomUpdate', sanitizeRoom(room, null));
  });
}

function broadcastGameState(room) {
  room.players.forEach((player, pIdx) => {
    if (player.connected) io.to(player.socketId).emit('gameState', buildPlayerState(room, pIdx));
  });
  // Spectators get a sanitized view (no hand info)
  (room.spectators || []).forEach(s => {
    io.to(s.socketId).emit('gameState', buildSpectatorState(room));
  });
}

// ─── SOCKET EVENTS ────────────────────────────────────────────────────────────
io.on('connection', socket => {
  console.log('connect', socket.id);

  // ── AUTHENTICATE SOCKET (attach user identity) ──────────────────────────────
  socket.on('authenticate', async ({ sessionToken }) => {
    if (!db || !sessionToken) return;
    const user = await db.collection('users').findOne({ sessionToken });
    if (!user) return;

    socket.data.googleId  = user.googleId;
    socket.data.gameName  = user.gameName;
    socket.data.sessionToken = sessionToken;

    // Mark online
    onlineUsers[user.googleId] = {
      socketId: socket.id,
      gameName: user.gameName,
      roomId: null,
      status: 'online',
    };

    // Send current friend list snapshot
    broadcastFriendStatus(user.gameName);
    socket.emit('authenticated', { gameName: user.gameName });
  });

  // ── INVITE FRIEND TO ROOM ────────────────────────────────────────────────────
  socket.on('inviteFriend', async ({ targetGameName }) => {
    const roomId   = socket.data.roomId;
    const gameName = socket.data.gameName;
    if (!roomId || !gameName) return;
    const room = rooms[roomId];
    if (!room || room.state !== 'lobby') return;

    if (!db) return;
    const targetUser = await db.collection('users').findOne({ gameName: targetGameName });
    if (!targetUser) return;

    const targetOnline = onlineUsers[targetUser.googleId];
    if (!targetOnline) {
      socket.emit('error', `${targetGameName} is offline`);
      return;
    }

    io.to(targetOnline.socketId).emit('gameInvite', {
      from: gameName,
      roomId,
      fromPicture: '', // could add picture lookup
    });
  });

  // ── INVITE NON-FRIEND (just emit to them if online by name, else share code) ─
  socket.on('inviteByName', async ({ targetGameName }) => {
    if (!db) return;
    const roomId = socket.data.roomId;
    const gameName = socket.data.gameName;
    if (!roomId || !gameName) return;

    const targetUser = await db.collection('users').findOne({ gameName: targetGameName });
    if (!targetUser) { socket.emit('error', 'Player not found'); return; }

    const targetOnline = onlineUsers[targetUser.googleId];
    if (!targetOnline) { socket.emit('error', `${targetGameName} is offline`); return; }

    io.to(targetOnline.socketId).emit('gameInvite', {
      from: gameName,
      roomId,
    });
    socket.emit('inviteSent', { to: targetGameName });
  });

  // ── CREATE ROOM ──────────────────────────────────────────────────────────────
  socket.on('createRoom', ({ playerName }) => {
    const name   = (playerName || '').trim();
    if (!name) { socket.emit('error', 'Name required'); return; }

    const roomId = genId();
    const token  = genToken();
    const displayName = socket.data.gameName || name;

    const player = {
      socketId: socket.id,
      name: displayName,
      gameName: socket.data.gameName || null,
      googleId: socket.data.googleId || null,
      connected: true,
      token,
    };

    rooms[roomId] = {
      id: roomId,
      hostSocketId: socket.id,
      players: [player],
      spectators: [],
      state: 'lobby',
      currentRound: 0, totalRounds: 0,
      playerOrder: [], hands: {}, bids: {}, bidsReady: {},
      tricks: {}, currentTrick: [], currentLeader: 0,
      leadSuit: null, trumpSuit: null,
      scores: {}, roundScores: [],
    };

    socket.join(roomId);
    socket.data.roomId      = roomId;
    socket.data.playerIndex = 0;
    socket.data.token       = token;
    socket.data.isSpectator = false;

    if (socket.data.googleId) {
      onlineUsers[socket.data.googleId] = {
        ...onlineUsers[socket.data.googleId],
        roomId,
        status: 'in-lobby',
      };
      broadcastFriendStatus(socket.data.gameName);
    }

    socket.emit('joinedRoom', { roomId, playerIndex: 0, playerToken: token, playerName: displayName });
    broadcastRoomUpdate(rooms[roomId]);
    console.log(`room ${roomId} created by ${displayName}`);
  });

  // ── JOIN ROOM (clean, no bugs) ───────────────────────────────────────────────
  socket.on('joinRoom', ({ roomId, playerName }) => {
    const code = (roomId || '').trim().toUpperCase();
    const name = (playerName || '').trim();
    if (!code) { socket.emit('error', 'Room code required'); return; }
    if (!name)  { socket.emit('error', 'Name required'); return; }

    const room = rooms[code];
    if (!room)                      { socket.emit('error', 'Room not found'); return; }
    if (room.state !== 'lobby')     { socket.emit('error', 'Game already started'); return; }
    if (room.players.length >= 7)   { socket.emit('error', 'Room is full (max 7)'); return; }

    // Block joining if already in this room by token (stale rejoin attempt)
    const existingToken = socket.data.token;
    if (existingToken) {
      const existingIdx = room.players.findIndex(p => p.token === existingToken);
      if (existingIdx !== -1) {
        // Already in — just update socket and re-announce
        const p = room.players[existingIdx];
        p.socketId = socket.id;
        p.connected = true;
        socket.join(code);
        socket.data.roomId = code;
        socket.data.playerIndex = existingIdx;
        socket.data.isSpectator = false;
        socket.emit('joinedRoom', { roomId: code, playerIndex: existingIdx, playerToken: existingToken, playerName: p.name });
        broadcastRoomUpdate(room);
        return;
      }
    }

    // Check duplicate name in room
    const dupIdx = room.players.findIndex(p => p.name.toLowerCase() === name.toLowerCase());
    if (dupIdx !== -1) { socket.emit('error', 'Name already taken in this room'); return; }

    const token       = genToken();
    const playerIndex = room.players.length;
    const displayName = socket.data.gameName || name;

    const player = {
      socketId: socket.id,
      name: displayName,
      gameName: socket.data.gameName || null,
      googleId: socket.data.googleId || null,
      connected: true,
      token,
    };

    room.players.push(player);
    socket.join(code);
    socket.data.roomId      = code;
    socket.data.playerIndex = playerIndex;
    socket.data.token       = token;
    socket.data.isSpectator = false;

    if (socket.data.googleId) {
      onlineUsers[socket.data.googleId] = {
        ...onlineUsers[socket.data.googleId],
        roomId: code,
        status: 'in-lobby',
      };
      broadcastFriendStatus(socket.data.gameName);
    }

    socket.emit('joinedRoom', { roomId: code, playerIndex, playerToken: token, playerName: displayName });
    broadcastRoomUpdate(room);
    console.log(`${displayName} joined ${code}`);
  });

  // ── REJOIN ROOM (auto on reconnect) ─────────────────────────────────────────
  socket.on('rejoinRoom', ({ roomId, playerToken }) => {
    const room = rooms[roomId];
    if (!room) { socket.emit('rejoinFailed', 'Room no longer exists'); return; }

    const playerIndex = room.players.findIndex(p => p.token === playerToken);
    if (playerIndex === -1) { socket.emit('rejoinFailed', 'Session not found'); return; }

    const player  = room.players[playerIndex];
    const wasHost = room.hostSocketId === player.socketId;

    player.socketId  = socket.id;
    player.connected = true;
    if (wasHost) room.hostSocketId = socket.id;

    socket.join(roomId);
    socket.data.roomId      = roomId;
    socket.data.playerIndex = playerIndex;
    socket.data.token       = playerToken;
    socket.data.isSpectator = false;
    if (player.googleId) socket.data.googleId = player.googleId;
    if (player.gameName) socket.data.gameName = player.gameName;

    // Re-register online status
    if (player.googleId) {
      onlineUsers[player.googleId] = {
        socketId: socket.id,
        gameName: player.gameName,
        roomId,
        status: room.state === 'lobby' ? 'in-lobby' : 'in-game',
      };
    }

    socket.emit('joinedRoom', { roomId, playerIndex, playerToken, playerName: player.name, isRejoin: true });

    if (room.state === 'lobby') {
      broadcastRoomUpdate(room);
    } else {
      socket.emit('gameState', buildPlayerState(room, playerIndex));
      io.to(roomId).emit('playerRejoined', { playerIndex, name: player.name });
    }
    console.log(`${player.name} rejoined ${roomId}`);
  });

  // ── SPECTATE ROOM ────────────────────────────────────────────────────────────
  socket.on('spectateRoom', ({ roomId }) => {
    const code = (roomId || '').trim().toUpperCase();
    const room = rooms[code];
    if (!room) { socket.emit('error', 'Room not found'); return; }

    const gameName = socket.data.gameName || 'Guest';
    const spec = { socketId: socket.id, gameName };

    // Remove if already spectating
    room.spectators = (room.spectators || []).filter(s => s.socketId !== socket.id);
    room.spectators.push(spec);

    socket.join(code);
    socket.data.roomId      = code;
    socket.data.isSpectator = true;

    socket.emit('spectating', { roomId: code });

    if (room.state === 'lobby') {
      socket.emit('roomUpdate', sanitizeRoom(room, null));
    } else {
      socket.emit('gameState', buildSpectatorState(room));
    }

    io.to(code).emit('spectatorJoined', { gameName });
    console.log(`${gameName} is spectating ${code}`);
  });

  // ── KICK PLAYER (host only, lobby only) ──────────────────────────────────────
  socket.on('kickPlayer', ({ playerIndex }) => {
    const room = rooms[socket.data.roomId];
    if (!room || room.state !== 'lobby') return;
    if (room.hostSocketId !== socket.id) { socket.emit('error', 'Only host can kick'); return; }
    if (playerIndex === 0) { socket.emit('error', 'Cannot kick yourself'); return; }
    if (playerIndex < 0 || playerIndex >= room.players.length) return;

    const kicked = room.players[playerIndex];
    if (kicked.connected) io.to(kicked.socketId).emit('kicked', 'You were removed by the host');
    room.players.splice(playerIndex, 1);
    broadcastRoomUpdate(room);
    console.log(`${kicked.name} kicked from ${room.id}`);
  });

  // ── START GAME ───────────────────────────────────────────────────────────────
  socket.on('startGame', ({ totalRounds: chosenRounds }) => {
    const room = rooms[socket.data.roomId];
    if (!room) return;
    if (room.hostSocketId !== socket.id) { socket.emit('error', 'Only host can start'); return; }
    if (room.players.length < 2) { socket.emit('error', 'Need at least 2 players'); return; }

    room.players = room.players.filter(p => p.connected);
    if (room.players.length < 2) { socket.emit('error', 'Need at least 2 connected players'); return; }

    const maxRounds = Math.floor(52 / room.players.length);
    const totalRounds = (chosenRounds && chosenRounds >= 1 && chosenRounds <= maxRounds)
      ? chosenRounds : maxRounds;

    room.state        = 'playing_setup';
    room.totalRounds  = totalRounds;
    room.currentRound = 0;
    room.scores       = {};
    room.roundScores  = [];
    room.playerOrder  = room.players.map((_, i) => i);

    room.players.forEach((p, i) => {
      room.scores[i] = 0;
      if (p.googleId && onlineUsers[p.googleId]) {
        onlineUsers[p.googleId].status = 'in-game';
      }
    });

    broadcastFriendStatuses();
    startRound(room);
    console.log(`game started in ${room.id}: ${totalRounds} rounds, ${room.players.length} players`);
  });

  // ── PLACE BID ────────────────────────────────────────────────────────────────
  socket.on('placeBid', ({ bid }) => {
    const room  = rooms[socket.data.roomId];
    const pIdx  = socket.data.playerIndex;
    if (!room || room.state !== 'bidding') return;
    if (typeof bid !== 'number' || bid < 0) return;

    const maxBid = room.hands[pIdx]?.length ?? 0;
    if (bid > maxBid) return;

    if (room.bids[pIdx] !== undefined) return; // already bid

    room.bids[pIdx]      = bid;
    room.bidsReady[pIdx] = true;

    broadcastGameState(room);

    if (Object.keys(room.bids).length === room.players.length) {
      setTimeout(() => {
        room.state = 'playing';
        broadcastGameState(room);
      }, 500);
    }
  });

  // ── PLAY CARD ────────────────────────────────────────────────────────────────
  socket.on('playCard', ({ cardId }) => {
    const room = rooms[socket.data.roomId];
    const pIdx = socket.data.playerIndex;
    if (!room || room.state !== 'playing') return;
    if (getCurrentTurn(room) !== pIdx) { socket.emit('error', 'Not your turn'); return; }

    const hand = room.hands[pIdx];
    const cardIdx = hand?.findIndex(c => c.id === cardId);
    if (cardIdx === -1 || cardIdx === undefined) { socket.emit('error', 'Card not in hand'); return; }
    const card = hand[cardIdx];

    // Validate lead-suit rule
    if (room.currentTrick.length > 0) {
      const hasLead = hand.some(c => c.suit === room.leadSuit);
      if (hasLead && card.suit !== room.leadSuit) {
        socket.emit('error', `You must follow suit (${room.leadSuit})`);
        return;
      }
    }

    if (room.currentTrick.length === 0) room.leadSuit = card.suit;

    hand.splice(cardIdx, 1);
    room.currentTrick.push({ playerIndex: pIdx, card });

    broadcastGameState(room);

    if (room.currentTrick.length === room.players.length) {
      setTimeout(() => resolveTrick(room), 800);
    }
  });

  // ── PLAY AGAIN (vote) ────────────────────────────────────────────────────────
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
        id: newRoomId,
        hostSocketId: null,
        players: [],
        spectators: [],
        state: 'lobby',
        currentRound: 0, totalRounds: 0,
        playerOrder: [], hands: {}, bids: {}, bidsReady: {},
        tricks: {}, currentTrick: [], currentLeader: 0,
        leadSuit: null, trumpSuit: null,
        scores: {}, roundScores: [],
      };

      room.players.forEach((p, i) => {
        const newToken = genToken();
        newRoom.players.push({ ...p, token: newToken });
        if (i === 0) newRoom.hostSocketId = p.socketId;
        if (p.connected) {
          io.to(p.socketId).emit('newLobby', {
            roomId: newRoomId, playerIndex: i, playerToken: newToken, playerName: p.name
          });
        }
      });

      const firstConnected = newRoom.players.find(p => p.connected);
      if (firstConnected) newRoom.hostSocketId = firstConnected.socketId;

      rooms[newRoomId] = newRoom;

      newRoom.players.forEach((p, i) => {
        if (p.connected) {
          const s = io.sockets.sockets.get(p.socketId);
          if (s) {
            s.leave(room.id);
            s.join(newRoomId);
            s.data.roomId = newRoomId;
            s.data.playerIndex = i;
          }
          if (p.googleId && onlineUsers[p.googleId]) {
            onlineUsers[p.googleId].roomId = newRoomId;
            onlineUsers[p.googleId].status = 'in-lobby';
          }
        }
      });

      newRoom.players.forEach(p => {
        if (p.connected) io.to(p.socketId).emit('roomUpdate', sanitizeRoom(newRoom, p.socketId));
      });

      delete rooms[room.id];
      broadcastFriendStatuses();
      console.log(`play again: new room ${newRoomId}`);
    }
  });

  // ── DISCONNECT ───────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;

    // Handle spectator disconnect
    if (socket.data.isSpectator && roomId && rooms[roomId]) {
      rooms[roomId].spectators = (rooms[roomId].spectators || []).filter(s => s.socketId !== socket.id);
    }

    if (!roomId || !rooms[roomId]) {
      // Clean up online status
      if (socket.data.googleId) {
        delete onlineUsers[socket.data.googleId];
        broadcastFriendStatus(socket.data.gameName);
      }
      return;
    }

    const room = rooms[roomId];
    const pIdx = socket.data.playerIndex;
    const player = room.players[pIdx];

    if (player && player.socketId === socket.id) {
      player.connected = false;
      io.to(roomId).emit('playerDisconnected', { playerIndex: pIdx, name: player.name });
      if (room.state === 'lobby') broadcastRoomUpdate(room);
    }

    if (socket.data.googleId) {
      // Don't immediately delete — they might reconnect
      // But update roomId tracking
      if (onlineUsers[socket.data.googleId]) {
        onlineUsers[socket.data.googleId].roomId = null;
        onlineUsers[socket.data.googleId].status = 'offline';
        // Actually remove after brief delay
        setTimeout(() => {
          const current = onlineUsers[socket.data.googleId];
          if (current && current.socketId === socket.id) {
            delete onlineUsers[socket.data.googleId];
            broadcastFriendStatus(socket.data.gameName);
          }
        }, 5000);
      }
    }

    console.log(`${player?.name || '?'} disconnected from ${roomId}`);
  });
});

// ─── BROADCAST FRIEND ONLINE STATUS ──────────────────────────────────────────
async function broadcastFriendStatus(gameName) {
  if (!db || !gameName) return;
  try {
    const user = await db.collection('users').findOne({ gameName });
    if (!user) return;

    // Notify all online friends of status change
    for (const friendName of (user.friends || [])) {
      const friendDoc = await db.collection('users').findOne({ gameName: friendName });
      if (!friendDoc) continue;
      const friendOnline = onlineUsers[friendDoc.googleId];
      if (friendOnline) {
        const myOnline = onlineUsers[user.googleId];
        io.to(friendOnline.socketId).emit('friendStatusUpdate', {
          gameName,
          online: !!myOnline,
          status: myOnline?.status || 'offline',
          roomId: myOnline?.roomId || null,
        });
      }
    }
  } catch (e) {
    // silent
  }
}

function broadcastFriendStatuses() {
  for (const googleId of Object.keys(onlineUsers)) {
    const info = onlineUsers[googleId];
    if (info?.gameName) broadcastFriendStatus(info.gameName);
  }
}

// ─── GAME LOGIC ───────────────────────────────────────────────────────────────
function startRound(room) {
  room.state     = 'bidding';
  room.bids      = {};
  room.bidsReady = {};
  room.tricks    = {};
  room.currentTrick = [];
  room.leadSuit  = null;
  room.trumpSuit = getTrump(room.currentRound);

  room.players.forEach((_, i) => {
    room.tricks[i]    = 0;
    room.bidsReady[i] = false;
  });

  const hands = dealCards(room.players.length, room.totalRounds, room.currentRound);
  room.players.forEach((_, i) => { room.hands[i] = hands[i]; });

  room.currentLeader = room.playerOrder[room.currentRound % room.playerOrder.length];
  broadcastGameState(room);
}

function resolveTrick(room) {
  const winner = trickWinner(room.currentTrick, room.leadSuit, room.trumpSuit);
  room.tricks[winner] = (room.tricks[winner] || 0) + 1;

  io.to(room.id).emit('trickWon', { winnerIndex: winner, winnerName: room.players[winner].name });

  room.currentTrick  = [];
  room.leadSuit      = null;
  room.currentLeader = winner;

  const cardsLeft = Object.values(room.hands).reduce((s, h) => s + h.length, 0);
  if (cardsLeft === 0) setTimeout(() => endRound(room), 1000);
  else broadcastGameState(room);
}

function endRound(room) {
  const results = room.players.map((p, i) => {
    const bid    = room.bids[i] ?? 0;
    const actual = room.tricks[i] ?? 0;
    const points = roundScore(bid, actual);
    room.scores[i] = (room.scores[i] || 0) + points;
    return { playerIndex: i, name: p.name, bid, actual, points, totalScore: room.scores[i] };
  });

  room.roundScores.push(results);
  room.state = 'round_end';

  io.to(room.id).emit('roundEnd', { roundIndex: room.currentRound, results, scores: { ...room.scores } });

  room.currentRound++;
  if (room.currentRound >= room.totalRounds) setTimeout(() => endGame(room), 3000);
  else setTimeout(() => startRound(room), 4000);
}

function endGame(room) {
  room.state         = 'game_over';
  room.playAgainVotes = new Set();

  const finalScores = room.players
    .map((p, i) => ({ playerIndex: i, name: p.name, score: room.scores[i] || 0 }))
    .sort((a, b) => b.score - a.score);

  io.to(room.id).emit('gameOver', { finalScores });
  broadcastGameState(room);

  // Update online status
  room.players.forEach(p => {
    if (p.googleId && onlineUsers[p.googleId]) {
      onlineUsers[p.googleId].status = 'online';
      onlineUsers[p.googleId].roomId = null;
    }
  });
  broadcastFriendStatuses();
}

function getCurrentTurn(room) {
  if (room.state !== 'playing') return null;
  const seatPos  = room.currentTrick.length;
  const leaderIdx = room.playerOrder.indexOf(room.currentLeader);
  return room.playerOrder[(leaderIdx + seatPos) % room.playerOrder.length];
}

function buildPlayerState(room, pIdx) {
  return {
    roomId: room.id,
    state:  room.state,
    currentRound:  room.currentRound,
    totalRounds:   room.totalRounds,
    trumpSuit:     room.trumpSuit,
    trumpSymbol:   SUIT_SYMBOLS[room.trumpSuit] || '',
    trumpName:     SUIT_NAMES[room.trumpSuit]   || '',
    playerOrder:   room.playerOrder,
    players: room.players.map((p, i) => ({
      index:     i,
      name:      p.name,
      gameName:  p.gameName,
      connected: p.connected,
      isHost:    room.hostSocketId === p.socketId,
      score:     room.scores[i] || 0,
      bidReady:  !!room.bidsReady[i],
      bid: (i === pIdx || room.state === 'playing' || room.state === 'round_end' || room.state === 'game_over')
           ? (room.bids[i] ?? null) : null,
      tricksWon: room.tricks[i] || 0,
      cardsInHand: room.hands[i] ? room.hands[i].length : 0,
    })),
    myIndex:       pIdx,
    myHand:        room.hands[pIdx] || [],
    myBid:         room.bids[pIdx] ?? null,
    myBidReady:    !!room.bidsReady[pIdx],
    currentTrick:  room.currentTrick,
    leadSuit:      room.leadSuit,
    currentLeader: room.currentLeader,
    currentTurnIndex: getCurrentTurn(room),
    roundScores:   room.roundScores,
    scores:        { ...room.scores },
    spectatorCount: (room.spectators || []).length,
    playAgainVotes: room.playAgainVotes
      ? [...room.playAgainVotes].map(i => room.players[i]?.name).filter(Boolean)
      : [],
  };
}

function buildSpectatorState(room) {
  const state = buildPlayerState(room, -1);
  state.myHand    = [];
  state.myBid     = null;
  state.myIndex   = -1;
  state.isSpectator = true;
  // Show all hands to spectator
  state.allHands = {};
  room.players.forEach((_, i) => { state.allHands[i] = room.hands[i] || []; });
  return state;
}

function sanitizeRoom(room, forSocketId) {
  return {
    id:      room.id,
    state:   room.state,
    players: room.players.map(p => ({
      name:      p.name,
      gameName:  p.gameName,
      connected: p.connected,
      isHost:    p.socketId === room.hostSocketId,
    })),
    hostSocketId:   room.hostSocketId,
    isHost:         room.hostSocketId === forSocketId,
    maxRounds:      room.players.length > 0 ? Math.floor(52 / room.players.length) : 0,
    spectatorCount: (room.spectators || []).length,
  };
}

server.listen(PORT, () => console.log(`🎴 Kachu Phul server on port ${PORT}`));
