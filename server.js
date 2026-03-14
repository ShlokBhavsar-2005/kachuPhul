const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

// ─── Game Constants ────────────────────────────────────────────────────────
const SUITS = ['spades', 'diamonds', 'clubs', 'hearts'];
const SUIT_SYMBOLS = { spades: '♠', diamonds: '♦', clubs: '♣', hearts: '♥' };
const SUIT_NAMES = { spades: 'Spades', diamonds: 'Diamonds', clubs: 'Clubs', hearts: 'Hearts' };
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const RANK_VALUE = { '2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14 };

// ─── In-memory store ───────────────────────────────────────────────────────
const rooms = {}; // roomId -> GameRoom

// ─── Helpers ───────────────────────────────────────────────────────────────
function generateRoomId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function createDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ suit, rank, id: `${rank}_${suit}` });
    }
  }
  return deck;
}

function shuffleDeck(deck) {
  const d = [...deck];
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

function getTrumpForRound(roundIndex) {
  return SUITS[roundIndex % 4];
}

function getCardsForRound(totalRounds, roundIndex) {
  // Always count down from totalRounds to 1
  return totalRounds - roundIndex;
}

function dealCards(playerCount, totalRounds, roundIndex) {
  const cardCount = getCardsForRound(totalRounds, roundIndex);
  const deck = shuffleDeck(createDeck());
  const hands = [];
  for (let i = 0; i < playerCount; i++) {
    hands.push(deck.slice(i * cardCount, (i + 1) * cardCount));
  }
  return hands;
}

function calcCardValue(card, leadSuit, trumpSuit) {
  if (card.suit === trumpSuit) return 1000 + RANK_VALUE[card.rank];
  if (card.suit === leadSuit) return RANK_VALUE[card.rank];
  return 0;
}

function determineHandWinner(trick, leadSuit, trumpSuit, playerOrder) {
  // trick = [{playerIndex, card}, ...]
  let bestIdx = 0;
  let bestVal = calcCardValue(trick[0].card, leadSuit, trumpSuit);
  for (let i = 1; i < trick.length; i++) {
    const val = calcCardValue(trick[i].card, leadSuit, trumpSuit);
    if (val > bestVal) { bestVal = val; bestIdx = i; }
  }
  return trick[bestIdx].playerIndex;
}

function calcRoundScore(bid, actual) {
  // 0 bid, 0 actual → 1 point
  // bid == actual → bid points (min 1)
  // mismatch → 0 points
  if (bid === actual) {
    return bid === 0 ? 1 : bid;
  }
  return 0;
}

// ─── Socket Events ─────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  // CREATE ROOM
  socket.on('createRoom', ({ playerName }) => {
    const roomId = generateRoomId();
    const playerToken = require('crypto').randomBytes(16).toString('hex');
    const player = {
      id: socket.id,
      name: playerName.trim(),
      ready: false,
      connected: true,
      token: playerToken
    };
    rooms[roomId] = {
      id: roomId,
      hostId: socket.id,
      players: [player],
      state: 'lobby', // lobby | bidding | playing | round_end | game_over
      currentRound: 0,
      totalRounds: 0,
      playerOrder: [], // fixed seat order (player indices)
      hands: {}, // playerIndex -> [cards]
      bids: {}, // playerIndex -> number
      bidsReady: {}, // playerIndex -> bool
      tricks: [], // tricks won this round per playerIndex
      currentTrick: [], // [{playerIndex, card}]
      currentLeader: 0, // index in playerOrder who leads this hand
      leadSuit: null,
      trumpSuit: null,
      scores: {}, // playerIndex -> total score
      roundScores: [], // [{playerIndex, bid, actual, points}] per round
    };
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.playerIndex = 0;
    io.to(roomId).emit('roomUpdate', sanitizeRoom(rooms[roomId], socket.id));
    socket.emit('joinedRoom', { roomId, playerIndex: 0, playerToken, playerName: player.name });
    console.log(`Room ${roomId} created by ${playerName}`);
  });

  // JOIN ROOM
  socket.on('joinRoom', ({ roomId, playerName }) => {
    const room = rooms[roomId];
    if (!room) { socket.emit('error', 'Room not found'); return; }
    if (room.state !== 'lobby') { socket.emit('error', 'Game already started'); return; }
    if (room.players.length >= 7) { socket.emit('error', 'Room is full (max 7)'); return; }

    const playerIndex = room.players.length;
    const playerToken = require('crypto').randomBytes(16).toString('hex');
    const player = {
      id: socket.id,
      name: playerName.trim(),
      ready: false,
      connected: true,
      token: playerToken
    };
    room.players.push(player);
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.playerIndex = playerIndex;
    room.players.forEach(p => { io.to(p.id).emit('roomUpdate', sanitizeRoom(room, p.id)); });
    socket.emit('joinedRoom', { roomId, playerIndex, playerToken, playerName: player.name });
    console.log(`${playerName} joined room ${roomId}`);
  });

  // START GAME (host only)
  socket.on('startGame', ({ totalRounds: chosenRounds }) => {
    const room = rooms[socket.data.roomId];
    if (!room) return;
    if (room.hostId !== socket.id) { socket.emit('error', 'Only host can start'); return; }
    if (room.players.length < 2) { socket.emit('error', 'Need at least 2 players'); return; }

    const n = room.players.length;
    const maxRounds = Math.floor(52 / n);

    // Validate chosen rounds: must be between 1 and maxRounds
    const chosen = parseInt(chosenRounds);
    if (!chosen || chosen < 1 || chosen > maxRounds) {
      socket.emit('error', `Choose between 1 and ${maxRounds} rounds`);
      return;
    }

    // Randomize seat order
    const indices = room.players.map((_, i) => i);
    for (let i = indices.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [indices[i], indices[j]] = [indices[j], indices[i]];
    }
    room.playerOrder = indices;

    room.totalRounds = chosen;
    room.currentRound = 0;

    // Init scores
    room.players.forEach((_, i) => { room.scores[i] = 0; });

    startRound(room);
    console.log(`Game started in room ${room.id} with ${chosen}/${maxRounds} rounds`);
  });

  // SUBMIT BID
  socket.on('submitBid', ({ bid }) => {
    const room = rooms[socket.data.roomId];
    if (!room || room.state !== 'bidding') return;
    const pIdx = socket.data.playerIndex;
    if (room.bidsReady[pIdx]) return; // already bid
    if (typeof bid !== 'number' || bid < 0) { socket.emit('error', 'Invalid bid'); return; }
    const maxBid = getCardsForRound(room.totalRounds, room.currentRound);
    if (bid > maxBid) { socket.emit('error', `Max bid is ${maxBid}`); return; }

    room.bids[pIdx] = bid;
    room.bidsReady[pIdx] = true;

    // Send confirmation only to this player (others see "ready" indicator)
    broadcastGameState(room);

    // Check if all players have bid
    const allBid = room.players.every((_, i) => room.bidsReady[i]);
    if (allBid) {
      room.state = 'playing';
      broadcastGameState(room);
    }
  });

  // PLAY CARD
  socket.on('playCard', ({ cardId }) => {
    const room = rooms[socket.data.roomId];
    if (!room || room.state !== 'playing') return;
    const pIdx = socket.data.playerIndex;

    // Check it's this player's turn
    const seatPos = room.currentTrick.length; // how many cards played so far in this trick
    const expectedPlayerIdx = room.playerOrder[(room.playerOrder.indexOf(room.currentLeader) + seatPos) % room.playerOrder.length];
    if (pIdx !== expectedPlayerIdx) {
      socket.emit('error', 'Not your turn');
      return;
    }

    const hand = room.hands[pIdx];
    const cardIndex = hand.findIndex(c => c.id === cardId);
    if (cardIndex === -1) { socket.emit('error', 'Card not in hand'); return; }

    const card = hand[cardIndex];

    // Validate: must follow lead suit if possible
    if (room.currentTrick.length > 0) {
      const hasLeadSuit = hand.some(c => c.suit === room.leadSuit);
      if (hasLeadSuit && card.suit !== room.leadSuit) {
        socket.emit('error', `You must follow suit: ${room.leadSuit}`);
        return;
      }
    }

    // Play the card
    hand.splice(cardIndex, 1);
    if (room.currentTrick.length === 0) {
      room.leadSuit = card.suit;
    }
    room.currentTrick.push({ playerIndex: pIdx, card });

    broadcastGameState(room);

    // If trick complete
    if (room.currentTrick.length === room.players.length) {
      setTimeout(() => resolveTrick(room), 1500);
    }
  });

  // REJOIN ROOM (player returning after disconnect)
  socket.on('rejoinRoom', ({ roomId, playerToken }) => {
    const room = rooms[roomId];
    if (!room) { socket.emit('rejoinFailed', 'Room no longer exists'); return; }

    // Find the player by token
    const playerIndex = room.players.findIndex(p => p.token === playerToken);
    if (playerIndex === -1) { socket.emit('rejoinFailed', 'Session not found'); return; }

    const player = room.players[playerIndex];

    // Update socket ID — old socket is gone
    const wasHost = room.hostId === player.id;
    player.id = socket.id;
    player.connected = true;
    if (wasHost) room.hostId = socket.id;

    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.playerIndex = playerIndex;

    // Tell this socket it's back in
    socket.emit('joinedRoom', { roomId, playerIndex, playerToken, playerName: player.name, isRejoin: true });

    // If game is in lobby, send roomUpdate to everyone
    if (room.state === 'lobby') {
      room.players.forEach(p => { if (p.connected) io.to(p.id).emit('roomUpdate', sanitizeRoom(room, p.id)); });
    } else {
      // Game already running — send full game state back to rejoining player
      const state = buildPlayerState(room, playerIndex);
      socket.emit('gameState', state);
      // Tell others this player is back
      io.to(roomId).emit('playerRejoined', { playerIndex, name: player.name });
    }

    console.log(`${player.name} rejoined room ${roomId} (was host: ${wasHost})`);
  });

  // DISCONNECT
  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    if (!roomId || !rooms[roomId]) return;
    const room = rooms[roomId];
    const player = room.players[socket.data.playerIndex];
    if (player) {
      player.connected = false;
      io.to(roomId).emit('playerDisconnected', { playerIndex: socket.data.playerIndex, name: player.name });
    }
    console.log(`${player?.name || 'Player'} disconnected from ${roomId}`);
  });
});

// ─── Game Logic Functions ──────────────────────────────────────────────────
function startRound(room) {
  const n = room.players.length;
  room.state = 'bidding';
  room.bids = {};
  room.bidsReady = {};
  room.tricks = {};
  room.currentTrick = [];
  room.leadSuit = null;
  room.trumpSuit = getTrumpForRound(room.currentRound);
  room.players.forEach((_, i) => {
    room.tricks[i] = 0;
    room.bidsReady[i] = false;
  });

  // Deal cards — card count goes from totalRounds down to 1
  const hands = dealCards(n, room.totalRounds, room.currentRound);
  room.players.forEach((_, i) => {
    room.hands[i] = hands[i];
  });

  // Who leads first: playerOrder[(currentRound) % n]
  const leaderSeatIndex = room.currentRound % room.playerOrder.length;
  room.currentLeader = room.playerOrder[leaderSeatIndex];

  broadcastGameState(room);
}

function resolveTrick(room) {
  const winner = determineHandWinner(room.currentTrick, room.leadSuit, room.trumpSuit, room.playerOrder);
  room.tricks[winner] = (room.tricks[winner] || 0) + 1;

  io.to(room.id).emit('trickWon', {
    winnerIndex: winner,
    winnerName: room.players[winner].name,
    trick: room.currentTrick
  });

  room.currentTrick = [];
  room.leadSuit = null;
  room.currentLeader = winner;

  const cardsLeft = Object.values(room.hands).reduce((sum, h) => sum + h.length, 0);

  if (cardsLeft === 0) {
    // Round over
    setTimeout(() => endRound(room), 1000);
  } else {
    broadcastGameState(room);
  }
}

function endRound(room) {
  const roundResult = [];
  room.players.forEach((p, i) => {
    const bid = room.bids[i] ?? 0;
    const actual = room.tricks[i] ?? 0;
    const points = calcRoundScore(bid, actual);
    room.scores[i] = (room.scores[i] || 0) + points;
    roundResult.push({ playerIndex: i, name: p.name, bid, actual, points, totalScore: room.scores[i] });
  });
  room.roundScores.push(roundResult);
  room.state = 'round_end';

  io.to(room.id).emit('roundEnd', {
    roundIndex: room.currentRound,
    results: roundResult,
    scores: { ...room.scores }
  });

  room.currentRound++;
  if (room.currentRound >= room.totalRounds) {
    setTimeout(() => endGame(room), 3000);
  } else {
    setTimeout(() => startRound(room), 4000);
  }
}

function endGame(room) {
  room.state = 'game_over';
  const finalScores = room.players.map((p, i) => ({
    playerIndex: i,
    name: p.name,
    score: room.scores[i] || 0
  })).sort((a, b) => b.score - a.score);

  io.to(room.id).emit('gameOver', { finalScores });
  broadcastGameState(room);
}

function broadcastGameState(room) {
  // Send personalized state to each player (hide others' hands & bids)
  room.players.forEach((player, pIdx) => {
    const socketId = player.id;
    const state = buildPlayerState(room, pIdx);
    io.to(socketId).emit('gameState', state);
  });
}

function buildPlayerState(room, pIdx) {
  const n = room.players.length;
  return {
    roomId: room.id,
    state: room.state,
    currentRound: room.currentRound,
    totalRounds: room.totalRounds,
    trumpSuit: room.trumpSuit,
    trumpSymbol: SUIT_SYMBOLS[room.trumpSuit] || '',
    trumpName: SUIT_NAMES[room.trumpSuit] || '',
    playerOrder: room.playerOrder,
    players: room.players.map((p, i) => ({
      index: i,
      name: p.name,
      connected: p.connected,
      isHost: room.hostId === p.id,
      score: room.scores[i] || 0,
      bidReady: !!room.bidsReady[i],
      // Only reveal your own bid during bidding phase
      bid: (i === pIdx || room.state === 'playing' || room.state === 'round_end' || room.state === 'game_over')
        ? (room.bids[i] ?? null) : null,
      tricksWon: room.tricks[i] || 0,
      cardsInHand: room.hands[i] ? room.hands[i].length : 0
    })),
    myIndex: pIdx,
    myHand: room.hands[pIdx] || [],
    myBid: room.bids[pIdx] ?? null,
    myBidReady: !!room.bidsReady[pIdx],
    currentTrick: room.currentTrick,
    leadSuit: room.leadSuit,
    currentLeader: room.currentLeader,
    currentTurnIndex: getCurrentTurn(room),
    roundScores: room.roundScores,
    scores: { ...room.scores }
  };
}

function getCurrentTurn(room) {
  if (room.state !== 'playing') return null;
  const seatPos = room.currentTrick.length;
  const leaderSeatIdx = room.playerOrder.indexOf(room.currentLeader);
  return room.playerOrder[(leaderSeatIdx + seatPos) % room.playerOrder.length];
}

function sanitizeRoom(room, forSocketId) {
  const maxRounds = room.players.length > 0 ? Math.floor(52 / room.players.length) : 0;
  return {
    id: room.id,
    state: room.state,
    players: room.players.map(p => ({ name: p.name, connected: p.connected, isHost: p.id === room.hostId })),
    hostId: room.hostId,
    isHost: room.hostId === forSocketId,
    maxRounds
  };
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🎴 Judgment Game server running on port ${PORT}`));