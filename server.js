require('dotenv').config();
const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const crypto   = require('crypto');
const path     = require('path');
const { MongoClient } = require('mongodb');
const { OAuth2Client } = require('google-auth-library');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*' },
  pingTimeout:  60000,   // 60s — keeps mobile connections alive
  pingInterval: 25000,
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── ENV ──────────────────────────────────────────────────────────────────────
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const MONGO_URI        = process.env.MONGO_URI || process.env.MONGODB_URI || '';
const PORT             = process.env.PORT || 3000;

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
    await db.collection('friendRequests').createIndex({ from: 1, to: 1 }, { unique: true });
    console.log('✅ MongoDB connected');
  } catch (e) {
    console.error('❌ MongoDB error:', e.message);
  }
}
connectDB();

// ─── GAME CONSTANTS ───────────────────────────────────────────────────────────
const SUITS        = ['spades', 'diamonds', 'clubs', 'hearts'];
const SUIT_SYMBOLS = { spades:'♠', diamonds:'♦', clubs:'♣', hearts:'♥' };
const SUIT_NAMES   = { spades:'Spades', diamonds:'Diamonds', clubs:'Clubs', hearts:'Hearts' };
const RANKS        = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const RANK_VALUE   = {'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14};

// ─── IN-MEMORY ────────────────────────────────────────────────────────────────
const rooms       = {};   // roomId → room
const onlineUsers = {};   // googleId → { socketId, gameName, roomId, status }

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function genId(len=6)  { return Math.random().toString(36).substring(2, 2+len).toUpperCase(); }
function genToken()    { return crypto.randomBytes(16).toString('hex'); }
function createDeck()  {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push({ suit:s, rank:r, id:`${r}_${s}` });
  return d;
}
function shuffle(d) {
  const a = [...d];
  for (let i = a.length-1; i>0; i--) { const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; }
  return a;
}
function getTrump(ri)                    { return SUITS[ri % 4]; }
function getCardsForRound(total, ri)     { return total - ri; }
function dealCards(pc, total, ri) {
  const n = getCardsForRound(total, ri), deck = shuffle(createDeck());
  return Array.from({length:pc}, (_,i) => deck.slice(i*n, (i+1)*n));
}
function cardValue(card, lead, trump) {
  if (card.suit === trump) return 1000 + RANK_VALUE[card.rank];
  if (card.suit === lead)  return RANK_VALUE[card.rank];
  return 0;
}
function trickWinner(trick, lead, trump) {
  let best=0, bestVal=cardValue(trick[0].card, lead, trump);
  for (let i=1;i<trick.length;i++) { const v=cardValue(trick[i].card,lead,trump); if(v>bestVal){bestVal=v;best=i;} }
  return trick[best].playerIndex;
}
function roundScore(bid, actual) { return bid===actual ? (bid===0?1:bid) : 0; }
function getCurrentTurn(room) {
  if (room.state !== 'playing') return null;
  const leaderIdx = room.playerOrder.indexOf(room.currentLeader);
  return room.playerOrder[(leaderIdx + room.currentTrick.length) % room.playerOrder.length];
}

// ─── AUTH API ──────────────────────────────────────────────────────────────────

// Check if configured
app.get('/auth/status', (req, res) => {
  res.json({ configured: !!(GOOGLE_CLIENT_ID && db), clientId: GOOGLE_CLIENT_ID });
});

// Google token login
app.post('/auth/google', async (req, res) => {
  if (!GOOGLE_CLIENT_ID) return res.status(503).json({ error: 'Google auth not configured' });
  if (!db)               return res.status(503).json({ error: 'Database not connected' });
  const { credential } = req.body;
  if (!credential) return res.status(400).json({ error: 'No credential' });
  try {
    const ticket  = await googleClient.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
    const payload = ticket.getPayload();
    const googleId = payload.sub;
    const picture  = payload.picture || '';
    const name     = payload.name || '';

    let user = await db.collection('users').findOne({ googleId });
    if (!user) {
      return res.json({ status: 'new', googleId, picture, name });
    }

    const sessionToken = crypto.randomBytes(24).toString('hex');
    await db.collection('users').updateOne({ googleId }, {
      $set: { sessionToken, lastSeen: new Date(), picture }
    });
    return res.json({ status: 'ok', sessionToken, gameName: user.gameName, googleId, picture });
  } catch(e) {
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
    const ticket  = await googleClient.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
    const payload = ticket.getPayload();
    if (payload.sub !== googleId) return res.status(401).json({ error: 'Token mismatch' });

    const sessionToken = crypto.randomBytes(24).toString('hex');
    await db.collection('users').insertOne({
      googleId, gameName: name, picture: picture||'',
      sessionToken, friends: [], createdAt: new Date(), lastSeen: new Date(),
    });
    return res.json({ status: 'ok', sessionToken, gameName: name, googleId });
  } catch(e) {
    if (e.code === 11000) return res.status(409).json({ error: 'Name already taken — try another' });
    return res.status(500).json({ error: e.message });
  }
});

// Validate session
app.post('/auth/session', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'DB not available' });
  const { sessionToken } = req.body;
  if (!sessionToken) return res.status(400).json({ error: 'No token' });
  const user = await db.collection('users').findOne({ sessionToken });
  if (!user) return res.status(401).json({ error: 'Invalid session' });
  await db.collection('users').updateOne({ sessionToken }, { $set: { lastSeen: new Date() } });
  return res.json({ status: 'ok', gameName: user.gameName, googleId: user.googleId, picture: user.picture });
});

// ─── FRIENDS API ──────────────────────────────────────────────────────────────
async function userFromSession(token) {
  if (!db || !token) return null;
  return db.collection('users').findOne({ sessionToken: token });
}

app.post('/friends/list', async (req, res) => {
  const user = await userFromSession(req.body.sessionToken);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const friendDocs = await db.collection('users').find({ gameName: { $in: user.friends||[] } }).toArray();
  const list = friendDocs.map(f => {
    const online = onlineUsers[f.googleId];
    return {
      gameName: f.gameName, picture: f.picture||'',
      online: !!online,
      inGame: online ? !!online.roomId : false,
      roomId: online?.roomId || null,
      status: online ? (online.roomId ? 'in-game' : 'online') : 'offline',
    };
  }).sort((a,b) => {
    if (a.online && !b.online) return -1;
    if (!a.online && b.online) return 1;
    return a.gameName.localeCompare(b.gameName);
  });

  const pending = await db.collection('friendRequests').find({
    $or: [{ from: user.gameName }, { to: user.gameName }], status: 'pending'
  }).toArray();

  res.json({ friends: list, pending });
});

app.post('/friends/request', async (req, res) => {
  const user = await userFromSession(req.body.sessionToken);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const target = (req.body.gameName || '').trim();
  if (!target || target === user.gameName) return res.status(400).json({ error: 'Invalid target' });

  const targetUser = await db.collection('users').findOne({ gameName: { $regex: `^${target}$`, $options:'i' } });
  if (!targetUser) return res.status(404).json({ error: 'Player not found' });
  if ((user.friends||[]).includes(targetUser.gameName)) return res.status(409).json({ error: 'Already friends' });

  try {
    await db.collection('friendRequests').insertOne({
      from: user.gameName, to: targetUser.gameName, status: 'pending', createdAt: new Date()
    });
  } catch(e) {
    if (e.code === 11000) return res.status(409).json({ error: 'Request already sent' });
    return res.status(500).json({ error: e.message });
  }

  const targetOnline = onlineUsers[targetUser.googleId];
  if (targetOnline) io.to(targetOnline.socketId).emit('friendRequest', { from: user.gameName, picture: user.picture||'' });
  res.json({ status: 'ok' });
});

app.post('/friends/respond', async (req, res) => {
  const user = await userFromSession(req.body.sessionToken);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const { from, action } = req.body;
  const request = await db.collection('friendRequests').findOne({ from, to: user.gameName, status: 'pending' });
  if (!request) return res.status(404).json({ error: 'Request not found' });

  await db.collection('friendRequests').updateOne({ _id: request._id }, { $set: { status: action } });
  if (action === 'accept') {
    await db.collection('users').updateOne({ gameName: user.gameName }, { $addToSet: { friends: from } });
    await db.collection('users').updateOne({ gameName: from }, { $addToSet: { friends: user.gameName } });
    const fromUser = await db.collection('users').findOne({ gameName: from });
    const fromOnline = fromUser ? onlineUsers[fromUser.googleId] : null;
    if (fromOnline) io.to(fromOnline.socketId).emit('friendAccepted', { gameName: user.gameName, picture: user.picture||'' });
  }
  res.json({ status: 'ok' });
});

// ─── SOCKET ───────────────────────────────────────────────────────────────────
io.on('connection', socket => {
  console.log('connect', socket.id);

  // ── AUTH ─────────────────────────────────────────────────────────────────────
  socket.on('authenticate', async ({ sessionToken }) => {
    if (!db || !sessionToken) return;
    const user = await db.collection('users').findOne({ sessionToken });
    if (!user) return;
    socket.data.googleId = user.googleId;
    socket.data.gameName = user.gameName;
    socket.data.sessionToken = sessionToken;
    onlineUsers[user.googleId] = { socketId: socket.id, gameName: user.gameName, roomId: null, status: 'online' };
    broadcastFriendStatus(user.gameName);
    socket.emit('authenticated', { gameName: user.gameName });
  });

  // ── INVITE FRIEND ─────────────────────────────────────────────────────────────
  socket.on('inviteFriend', async ({ targetGameName }) => {
    const roomId = socket.data.roomId;
    const gameName = socket.data.gameName;
    if (!roomId || !gameName || !db) return;
    const room = rooms[roomId];
    if (!room || room.state !== 'lobby') return socket.emit('error', 'Room not in lobby');

    const targetUser = await db.collection('users').findOne({ gameName: targetGameName });
    if (!targetUser) return socket.emit('error', 'Player not found');
    const targetOnline = onlineUsers[targetUser.googleId];
    if (!targetOnline) return socket.emit('error', `${targetGameName} is offline`);

    io.to(targetOnline.socketId).emit('gameInvite', { from: gameName, roomId });
    socket.emit('inviteSent', { to: targetGameName });
  });

  // ── CREATE ROOM ───────────────────────────────────────────────────────────────
  socket.on('createRoom', ({ playerName }) => {
    const displayName = socket.data.gameName || (playerName||'').trim();
    if (!displayName) return socket.emit('error', 'Name required');

    const roomId = genId();
    const token  = genToken();
    rooms[roomId] = {
      id: roomId, hostSocketId: socket.id,
      players: [{ socketId:socket.id, name:displayName, gameName:socket.data.gameName||null, googleId:socket.data.googleId||null, connected:true, token }],
      spectators: [],
      state: 'lobby', currentRound:0, totalRounds:0,
      playerOrder:[], hands:{}, bids:{}, bidsReady:{},
      tricks:{}, currentTrick:[], currentLeader:0,
      leadSuit:null, trumpSuit:null, scores:{}, roundScores:[],
    };
    socket.join(roomId);
    socket.data.roomId = roomId; socket.data.playerIndex = 0; socket.data.token = token; socket.data.isSpectator = false;
    if (socket.data.googleId) { onlineUsers[socket.data.googleId] = { ...onlineUsers[socket.data.googleId], roomId, status:'in-lobby' }; broadcastFriendStatus(displayName); }
    socket.emit('joinedRoom', { roomId, playerIndex:0, playerToken:token, playerName:displayName });
    broadcastRoomUpdate(rooms[roomId]);
  });

  // ── JOIN ROOM ─────────────────────────────────────────────────────────────────
  socket.on('joinRoom', ({ roomId, playerName }) => {
    const code = (roomId||'').trim().toUpperCase();
    const name = socket.data.gameName || (playerName||'').trim();
    if (!code) return socket.emit('error', 'Room code required');
    if (!name) return socket.emit('error', 'Name required');

    const room = rooms[code];
    if (!room)                    return socket.emit('error', 'Room not found');
    if (room.state !== 'lobby')   return socket.emit('error', 'Game already started');
    if (room.players.length >= 7) return socket.emit('error', 'Room is full (max 7)');

    // Check if already in this room
    const existByToken = socket.data.token ? room.players.findIndex(p => p.token === socket.data.token) : -1;
    const existByGoogle = socket.data.googleId ? room.players.findIndex(p => p.googleId === socket.data.googleId) : -1;
    const existIdx = existByToken !== -1 ? existByToken : existByGoogle;

    if (existIdx !== -1) {
      const p = room.players[existIdx];
      p.socketId = socket.id; p.connected = true;
      socket.join(code); socket.data.roomId = code; socket.data.playerIndex = existIdx; socket.data.token = p.token; socket.data.isSpectator = false;
      socket.emit('joinedRoom', { roomId:code, playerIndex:existIdx, playerToken:p.token, playerName:p.name, isRejoin:true });
      broadcastRoomUpdate(room); return;
    }

    const token = genToken(), playerIndex = room.players.length;
    room.players.push({ socketId:socket.id, name, gameName:socket.data.gameName||null, googleId:socket.data.googleId||null, connected:true, token });
    socket.join(code); socket.data.roomId = code; socket.data.playerIndex = playerIndex; socket.data.token = token; socket.data.isSpectator = false;
    if (socket.data.googleId) { onlineUsers[socket.data.googleId] = { ...onlineUsers[socket.data.googleId], roomId:code, status:'in-lobby' }; broadcastFriendStatus(name); }
    socket.emit('joinedRoom', { roomId:code, playerIndex, playerToken:token, playerName:name });
    broadcastRoomUpdate(room);
    console.log(`${name} joined ${code}`);
  });

  // ── REJOIN ROOM ───────────────────────────────────────────────────────────────
  socket.on('rejoinRoom', ({ roomId, playerToken }) => {
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
      onlineUsers[player.googleId] = { socketId:socket.id, gameName:player.gameName, roomId, status: room.state==='lobby'?'in-lobby':'in-game' };
    }

    socket.emit('joinedRoom', { roomId, playerIndex, playerToken:player.token, playerName:player.name, isRejoin:true });
    if (room.state === 'lobby') broadcastRoomUpdate(room);
    else { socket.emit('gameState', buildPlayerState(room, playerIndex)); io.to(roomId).emit('playerRejoined', { playerIndex, name:player.name }); }
    console.log(`${player.name} rejoined ${roomId}`);
  });

  // ── SPECTATE ──────────────────────────────────────────────────────────────────
  socket.on('spectateRoom', ({ roomId }) => {
    const code = (roomId||'').trim().toUpperCase();
    const room = rooms[code];
    if (!room) return socket.emit('error', 'Room not found');

    const gameName = socket.data.gameName || ('Guest_' + socket.id.slice(0,4));
    room.spectators = (room.spectators||[]).filter(s => s.socketId !== socket.id);
    room.spectators.push({ socketId:socket.id, gameName });

    socket.join(code); socket.data.roomId = code; socket.data.isSpectator = true;
    socket.emit('spectating', { roomId: code });
    if (room.state === 'lobby') socket.emit('roomUpdate', sanitizeRoom(room, null));
    else socket.emit('gameState', buildSpectatorState(room));
    io.to(code).emit('spectatorJoined', { gameName });
  });

  // ── KICK ──────────────────────────────────────────────────────────────────────
  socket.on('kickPlayer', ({ playerIndex }) => {
    const room = rooms[socket.data.roomId];
    if (!room || room.state !== 'lobby') return;
    if (room.hostSocketId !== socket.id) return socket.emit('error', 'Only host can kick');
    if (playerIndex <= 0 || playerIndex >= room.players.length) return;
    const kicked = room.players[playerIndex];
    if (kicked.connected) io.to(kicked.socketId).emit('kicked', 'You were removed by the host');
    room.players.splice(playerIndex, 1);
    broadcastRoomUpdate(room);
  });

  // ── START GAME ────────────────────────────────────────────────────────────────
  socket.on('startGame', ({ totalRounds: chosen }) => {
    const room = rooms[socket.data.roomId];
    if (!room || room.hostSocketId !== socket.id) return;
    room.players = room.players.filter(p => p.connected);
    if (room.players.length < 2) return socket.emit('error', 'Need at least 2 players');

    const maxRounds  = Math.floor(52 / room.players.length);
    const totalRounds = (chosen && chosen >= 1 && chosen <= maxRounds) ? chosen : maxRounds;

    room.totalRounds = totalRounds; room.currentRound = 0; room.scores = {}; room.roundScores = [];
    // Shuffle player order
    const indices = room.players.map((_,i) => i);
    for (let i=indices.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[indices[i],indices[j]]=[indices[j],indices[i]];}
    room.playerOrder = indices;
    room.players.forEach((_,i) => { room.scores[i]=0; });
    room.players.forEach((p,i) => io.to(p.socketId).emit('yourIndex', i));
    room.players.forEach(p => { if (p.googleId && onlineUsers[p.googleId]) { onlineUsers[p.googleId].status='in-game'; } });
    broadcastFriendStatuses();
    startRound(room);
    console.log(`game started ${room.id}: ${totalRounds} rounds`);
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
    if (room.players.every((_,i) => room.bidsReady[i])) { setTimeout(() => { room.state='playing'; broadcastGameState(room); }, 300); }
  });

  // ── PLAY CARD ─────────────────────────────────────────────────────────────────
  socket.on('playCard', ({ cardId }) => {
    const room = rooms[socket.data.roomId];
    const pIdx = socket.data.playerIndex;
    if (!room || room.state !== 'playing') return;
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
    room.currentTrick.push({ playerIndex:pIdx, card });
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
        id:newRoomId, hostSocketId:null,
        players:[], spectators:[],
        state:'lobby', currentRound:0, totalRounds:0,
        playerOrder:[], hands:{}, bids:{}, bidsReady:{},
        tricks:{}, currentTrick:[], currentLeader:0,
        leadSuit:null, trumpSuit:null, scores:{}, roundScores:[],
      };
      room.players.forEach((p,i) => {
        const newToken = genToken();
        newRoom.players.push({...p, token:newToken});
        if (i===0) newRoom.hostSocketId = p.socketId;
        if (p.connected) io.to(p.socketId).emit('newLobby', { roomId:newRoomId, playerIndex:i, playerToken:newToken, playerName:p.name });
      });
      const first = newRoom.players.find(p => p.connected);
      if (first) newRoom.hostSocketId = first.socketId;
      rooms[newRoomId] = newRoom;
      newRoom.players.forEach((p,i) => {
        if (p.connected) {
          const s = io.sockets.sockets.get(p.socketId);
          if (s) { s.leave(room.id); s.join(newRoomId); s.data.roomId=newRoomId; s.data.playerIndex=i; }
        }
      });
      newRoom.players.forEach(p => { if(p.connected) io.to(p.socketId).emit('roomUpdate', sanitizeRoom(newRoom, p.socketId)); });
      delete rooms[room.id];
    }
  });

  // ── DISCONNECT ────────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;

    // Remove from spectators
    if (socket.data.isSpectator && roomId && rooms[roomId]) {
      rooms[roomId].spectators = (rooms[roomId].spectators||[]).filter(s => s.socketId !== socket.id);
      broadcastRoomUpdate(rooms[roomId]);
    }

    if (roomId && rooms[roomId] && !socket.data.isSpectator) {
      const room = rooms[roomId];
      const player = room.players[socket.data.playerIndex];
      if (player && player.socketId === socket.id) {
        player.connected = false;
        io.to(roomId).emit('playerDisconnected', { playerIndex:socket.data.playerIndex, name:player.name });
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
  room.players.forEach(p => { if(p.connected) io.to(p.socketId).emit('roomUpdate', sanitizeRoom(room, p.socketId)); });
  (room.spectators||[]).forEach(s => io.to(s.socketId).emit('roomUpdate', sanitizeRoom(room, null)));
}
function broadcastGameState(room) {
  room.players.forEach((p,i) => { if(p.connected) io.to(p.socketId).emit('gameState', buildPlayerState(room,i)); });
  (room.spectators||[]).forEach(s => io.to(s.socketId).emit('gameState', buildSpectatorState(room)));
}
async function broadcastFriendStatus(gameName) {
  if (!db || !gameName) return;
  try {
    const user = await db.collection('users').findOne({ gameName });
    if (!user) return;
    for (const friendName of (user.friends||[])) {
      const fd = await db.collection('users').findOne({ gameName: friendName });
      if (!fd) continue;
      const fo = onlineUsers[fd.googleId];
      if (fo) {
        const mine = onlineUsers[user.googleId];
        io.to(fo.socketId).emit('friendStatusUpdate', { gameName, online:!!mine, status:mine?.status||'offline', roomId:mine?.roomId||null });
      }
    }
  } catch(e) {}
}
function broadcastFriendStatuses() {
  for (const gid of Object.keys(onlineUsers)) { const info = onlineUsers[gid]; if(info?.gameName) broadcastFriendStatus(info.gameName); }
}

// ─── GAME LOGIC ───────────────────────────────────────────────────────────────
function startRound(room) {
  room.state='bidding'; room.bids={}; room.bidsReady={}; room.tricks={}; room.currentTrick=[]; room.leadSuit=null;
  room.trumpSuit = getTrump(room.currentRound);
  room.players.forEach((_,i) => { room.tricks[i]=0; room.bidsReady[i]=false; });
  const hands = dealCards(room.players.length, room.totalRounds, room.currentRound);
  room.players.forEach((_,i) => { room.hands[i]=hands[i]; });
  room.currentLeader = room.playerOrder[room.currentRound % room.playerOrder.length];
  broadcastGameState(room);
}
function resolveTrick(room) {
  const winner = trickWinner(room.currentTrick, room.leadSuit, room.trumpSuit);
  room.tricks[winner] = (room.tricks[winner]||0) + 1;
  io.to(room.id).emit('trickWon', { winnerIndex:winner, winnerName:room.players[winner].name });
  room.currentTrick=[]; room.leadSuit=null; room.currentLeader=winner;
  const cardsLeft = Object.values(room.hands).reduce((s,h) => s+h.length, 0);
  if (cardsLeft===0) setTimeout(() => endRound(room), 1000);
  else broadcastGameState(room);
}
function endRound(room) {
  const results = room.players.map((p,i) => {
    const bid=room.bids[i]??0, actual=room.tricks[i]??0, points=roundScore(bid,actual);
    room.scores[i]=(room.scores[i]||0)+points;
    return { playerIndex:i, name:p.name, bid, actual, points, totalScore:room.scores[i] };
  });
  room.roundScores.push(results); room.state='round_end';
  io.to(room.id).emit('roundEnd', { roundIndex:room.currentRound, results, scores:{...room.scores} });
  room.currentRound++;
  if (room.currentRound >= room.totalRounds) setTimeout(() => endGame(room), 3000);
  else setTimeout(() => startRound(room), 4000);
}
function endGame(room) {
  room.state='game_over'; room.playAgainVotes=new Set();
  const finalScores = room.players.map((p,i) => ({ playerIndex:i, name:p.name, score:room.scores[i]||0 })).sort((a,b) => b.score-a.score);
  io.to(room.id).emit('gameOver', { finalScores });
  broadcastGameState(room);
  room.players.forEach(p => { if(p.googleId && onlineUsers[p.googleId]) { onlineUsers[p.googleId].status='online'; onlineUsers[p.googleId].roomId=null; } });
  broadcastFriendStatuses();
}

function buildPlayerState(room, pIdx) {
  return {
    roomId:room.id, state:room.state, currentRound:room.currentRound, totalRounds:room.totalRounds,
    trumpSuit:room.trumpSuit, trumpSymbol:SUIT_SYMBOLS[room.trumpSuit]||'', trumpName:SUIT_NAMES[room.trumpSuit]||'',
    playerOrder:room.playerOrder,
    players: room.players.map((p,i) => ({
      index:i, name:p.name, connected:p.connected, isHost:room.hostSocketId===p.socketId,
      score:room.scores[i]||0, bidReady:!!room.bidsReady[i],
      bid:(i===pIdx||['playing','round_end','game_over'].includes(room.state))?(room.bids[i]??null):null,
      tricksWon:room.tricks[i]||0, cardsInHand:room.hands[i]?room.hands[i].length:0,
    })),
    myIndex:pIdx, myHand:room.hands[pIdx]||[], myBid:room.bids[pIdx]??null, myBidReady:!!room.bidsReady[pIdx],
    currentTrick:room.currentTrick, leadSuit:room.leadSuit, currentLeader:room.currentLeader,
    currentTurnIndex:getCurrentTurn(room), roundScores:room.roundScores, scores:{...room.scores},
    spectatorCount:(room.spectators||[]).length,
    playAgainVotes:room.playAgainVotes?[...room.playAgainVotes].map(i=>room.players[i]?.name).filter(Boolean):[],
  };
}
function buildSpectatorState(room) {
  const s = buildPlayerState(room, -1);
  s.myHand=[]; s.myBid=null; s.myIndex=-1; s.isSpectator=true;
  s.allHands={}; room.players.forEach((_,i) => { s.allHands[i]=room.hands[i]||[]; });
  return s;
}
function sanitizeRoom(room, forSocketId) {
  return {
    id:room.id, state:room.state,
    players:room.players.map(p => ({ name:p.name, connected:p.connected, isHost:p.socketId===room.hostSocketId })),
    isHost:room.hostSocketId===forSocketId, maxRounds:room.players.length>0?Math.floor(52/room.players.length):0,
    spectatorCount:(room.spectators||[]).length,
  };
}

server.listen(PORT, () => console.log(`🎴 Kachu Phul on port ${PORT}`));