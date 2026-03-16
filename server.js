const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

// ─── Constants ────────────────────────────────────────────────────────────
const SUITS = ['spades', 'diamonds', 'clubs', 'hearts'];
const SUIT_SYMBOLS = { spades:'♠', diamonds:'♦', clubs:'♣', hearts:'♥' };
const SUIT_NAMES   = { spades:'Spades', diamonds:'Diamonds', clubs:'Clubs', hearts:'Hearts' };
const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const RANK_VALUE = {'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14};

// ─── In-memory store ──────────────────────────────────────────────────────
const rooms = {};

// ─── Helpers ─────────────────────────────────────────────────────────────
function genId(len=6) {
  return Math.random().toString(36).substring(2, 2+len).toUpperCase();
}
function genToken() {
  return crypto.randomBytes(16).toString('hex');
}
function createDeck() {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push({ suit:s, rank:r, id:`${r}_${s}` });
  return d;
}
function shuffle(d) {
  const a = [...d];
  for (let i = a.length-1; i>0; i--) {
    const j = Math.floor(Math.random()*(i+1));
    [a[i],a[j]] = [a[j],a[i]];
  }
  return a;
}
function getTrump(roundIndex) { return SUITS[roundIndex % 4]; }
function getCardsForRound(totalRounds, roundIndex) { return totalRounds - roundIndex; }
function dealCards(playerCount, totalRounds, roundIndex) {
  const n = getCardsForRound(totalRounds, roundIndex);
  const deck = shuffle(createDeck());
  return Array.from({length: playerCount}, (_, i) => deck.slice(i*n, (i+1)*n));
}
function cardValue(card, leadSuit, trumpSuit) {
  if (card.suit === trumpSuit) return 1000 + RANK_VALUE[card.rank];
  if (card.suit === leadSuit)  return RANK_VALUE[card.rank];
  return 0;
}
function trickWinner(trick, leadSuit, trumpSuit) {
  let best = 0, bestVal = cardValue(trick[0].card, leadSuit, trumpSuit);
  for (let i=1; i<trick.length; i++) {
    const v = cardValue(trick[i].card, leadSuit, trumpSuit);
    if (v > bestVal) { bestVal = v; best = i; }
  }
  return trick[best].playerIndex;
}
function roundScore(bid, actual) {
  if (bid === actual) return bid === 0 ? 1 : bid;
  return 0;
}
function broadcastRoomUpdate(room) {
  room.players.forEach(p => {
    if (p.connected) io.to(p.id).emit('roomUpdate', sanitizeRoom(room, p.id));
  });
}

// ─── Socket Events ────────────────────────────────────────────────────────
io.on('connection', socket => {
  console.log('connect', socket.id);

  // ── CREATE ROOM ──────────────────────────────────────────────────────────
  socket.on('createRoom', ({ playerName }) => {
    const roomId = genId();
    const token  = genToken();
    const player = { id: socket.id, name: playerName.trim(), connected: true, token };

    rooms[roomId] = {
      id: roomId, hostId: socket.id,
      players: [player],
      state: 'lobby',
      currentRound: 0, totalRounds: 0,
      playerOrder: [], hands: {}, bids: {}, bidsReady: {},
      tricks: {}, currentTrick: [], currentLeader: 0,
      leadSuit: null, trumpSuit: null,
      scores: {}, roundScores: [],
    };

    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.playerIndex = 0;
    socket.data.token = token;

    socket.emit('joinedRoom', { roomId, playerIndex:0, playerToken:token, playerName:player.name });
    broadcastRoomUpdate(rooms[roomId]);
    console.log(`room ${roomId} created by ${playerName}`);
  });

  // ── JOIN ROOM ────────────────────────────────────────────────────────────
  socket.on('joinRoom', ({ roomId, playerName }) => {
    const room = rooms[roomId];
    if (!room) { socket.emit('error', 'Room not found'); return; }
    if (room.state !== 'lobby') { socket.emit('error', 'Game already started'); return; }

    // ── KEY FIX: if this socket already has a session token from a previous
    // connection, check whether that player slot still exists in THIS room.
    // If it does, treat this as a rejoin rather than a new join.
    // This prevents the ghost-player bug where a player appears twice.
    const existingToken = socket.data.token;
    if (existingToken) {
      const existingIdx = room.players.findIndex(p => p.token === existingToken);
      if (existingIdx !== -1) {
        // Already in this room — just reconnect the slot
        const p = room.players[existingIdx];
        p.id = socket.id; p.connected = true;
        socket.join(roomId);
        socket.data.roomId = roomId;
        socket.data.playerIndex = existingIdx;
        socket.emit('joinedRoom', { roomId, playerIndex:existingIdx, playerToken:existingToken, playerName:p.name, isRejoin:true });
        broadcastRoomUpdate(room);
        return;
      }
    }

    if (room.players.length >= 7) { socket.emit('error', 'Room is full (max 7)'); return; }

    const token = genToken();
    const playerIndex = room.players.length;
    const player = { id: socket.id, name: playerName.trim(), connected: true, token };

    room.players.push(player);
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.playerIndex = playerIndex;
    socket.data.token = token;

    socket.emit('joinedRoom', { roomId, playerIndex, playerToken:token, playerName:player.name });
    broadcastRoomUpdate(room);
    console.log(`${playerName} joined ${roomId}`);
  });

  // ── REJOIN ROOM ──────────────────────────────────────────────────────────
  socket.on('rejoinRoom', ({ roomId, playerToken }) => {
    const room = rooms[roomId];
    if (!room) { socket.emit('rejoinFailed', 'Room no longer exists'); return; }

    const playerIndex = room.players.findIndex(p => p.token === playerToken);
    if (playerIndex === -1) { socket.emit('rejoinFailed', 'Session not found'); return; }

    const player = room.players[playerIndex];
    const wasHost = room.hostId === player.id;

    // Update socket ID
    player.id = socket.id;
    player.connected = true;
    if (wasHost) room.hostId = socket.id;

    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.playerIndex = playerIndex;
    socket.data.token = playerToken;

    socket.emit('joinedRoom', { roomId, playerIndex, playerToken, playerName:player.name, isRejoin:true });

    if (room.state === 'lobby') {
      broadcastRoomUpdate(room);
    } else {
      socket.emit('gameState', buildPlayerState(room, playerIndex));
      io.to(roomId).emit('playerRejoined', { playerIndex, name:player.name });
    }
    console.log(`${player.name} rejoined ${roomId}`);
  });

  // ── KICK PLAYER (host only, lobby only) ──────────────────────────────────
  socket.on('kickPlayer', ({ playerIndex }) => {
    const room = rooms[socket.data.roomId];
    if (!room || room.state !== 'lobby') return;
    if (room.hostId !== socket.id) { socket.emit('error', 'Only host can kick'); return; }
    if (playerIndex === 0) { socket.emit('error', 'Cannot kick yourself'); return; }
    if (playerIndex < 0 || playerIndex >= room.players.length) return;

    const kicked = room.players[playerIndex];
    // Tell the kicked player
    if (kicked.connected) io.to(kicked.id).emit('kicked', 'You were removed by the host');

    // Remove from array and reindex
    room.players.splice(playerIndex, 1);
    // Reassign tokens/indices are now stale — fix socket.data for remaining players
    // We broadcast fresh roomUpdate; clients re-seat by name order
    broadcastRoomUpdate(room);
    console.log(`${kicked.name} kicked from ${room.id}`);
  });

  // ── START GAME ───────────────────────────────────────────────────────────
  socket.on('startGame', ({ totalRounds: chosenRounds }) => {
    const room = rooms[socket.data.roomId];
    if (!room) return;
    if (room.hostId !== socket.id) { socket.emit('error', 'Only host can start'); return; }
    if (room.players.length < 2) { socket.emit('error', 'Need at least 2 players'); return; }

    // Remove disconnected players before starting
    room.players = room.players.filter(p => p.connected);
    if (room.players.length < 2) { socket.emit('error', 'Need at least 2 connected players'); return; }

    const n = room.players.length;
    const maxRounds = Math.floor(52 / n);
    const chosen = parseInt(chosenRounds);
    if (!chosen || chosen < 1 || chosen > maxRounds) {
      socket.emit('error', `Choose between 1 and ${maxRounds} rounds`); return;
    }

    // Shuffle seat order
    const indices = room.players.map((_, i) => i);
    for (let i = indices.length-1; i>0; i--) {
      const j = Math.floor(Math.random()*(i+1));
      [indices[i],indices[j]] = [indices[j],indices[i]];
    }
    room.playerOrder = indices;
    room.totalRounds = chosen;
    room.currentRound = 0;
    room.players.forEach((_, i) => { room.scores[i] = 0; });

    // Fix socket.data.playerIndex for all players (in case kick shifted indices)
    room.players.forEach((p, i) => {
      // Emit updated index to each player's socket
      io.to(p.id).emit('yourIndex', i);
    });

    startRound(room);
    console.log(`game started ${room.id} ${chosen}/${maxRounds} rounds`);
  });

  // ── SUBMIT BID ───────────────────────────────────────────────────────────
  socket.on('submitBid', ({ bid }) => {
    const room = rooms[socket.data.roomId];
    if (!room || room.state !== 'bidding') return;
    const pIdx = socket.data.playerIndex;
    if (room.bidsReady[pIdx]) return;
    if (typeof bid !== 'number' || bid < 0) { socket.emit('error', 'Invalid bid'); return; }
    const maxBid = getCardsForRound(room.totalRounds, room.currentRound);
    if (bid > maxBid) { socket.emit('error', `Max bid is ${maxBid}`); return; }

    room.bids[pIdx] = bid;
    room.bidsReady[pIdx] = true;
    broadcastGameState(room);

    if (room.players.every((_, i) => room.bidsReady[i])) {
      room.state = 'playing';
      broadcastGameState(room);
    }
  });

  // ── PLAY CARD ────────────────────────────────────────────────────────────
  socket.on('playCard', ({ cardId }) => {
    const room = rooms[socket.data.roomId];
    if (!room || room.state !== 'playing') return;
    const pIdx = socket.data.playerIndex;

    const seatPos = room.currentTrick.length;
    const expected = room.playerOrder[(room.playerOrder.indexOf(room.currentLeader) + seatPos) % room.playerOrder.length];
    if (pIdx !== expected) { socket.emit('error', 'Not your turn'); return; }

    const hand = room.hands[pIdx];
    const cardIndex = hand.findIndex(c => c.id === cardId);
    if (cardIndex === -1) { socket.emit('error', 'Card not in hand'); return; }

    const card = hand[cardIndex];
    if (room.currentTrick.length > 0) {
      const hasLead = hand.some(c => c.suit === room.leadSuit);
      if (hasLead && card.suit !== room.leadSuit) {
        socket.emit('error', `Must follow suit: ${room.leadSuit}`); return;
      }
    }

    hand.splice(cardIndex, 1);
    if (room.currentTrick.length === 0) room.leadSuit = card.suit;
    room.currentTrick.push({ playerIndex: pIdx, card });
    broadcastGameState(room);

    if (room.currentTrick.length === room.players.length) {
      setTimeout(() => resolveTrick(room), 1500);
    }
  });

  // ── PLAY AGAIN (vote to create new lobby) ────────────────────────────────
  socket.on('playAgain', () => {
    const room = rooms[socket.data.roomId];
    if (!room || room.state !== 'game_over') return;
    const pIdx = socket.data.playerIndex;
    const player = room.players[pIdx];
    if (!player) return;

    if (!room.playAgainVotes) room.playAgainVotes = new Set();
    room.playAgainVotes.add(pIdx);

    // Tell everyone who has voted
    const votes = [...room.playAgainVotes].map(i => room.players[i]?.name).filter(Boolean);
    io.to(room.id).emit('playAgainUpdate', { votes, total: room.players.length });

    // If everyone voted, create a fresh lobby with the same players
    if (room.playAgainVotes.size === room.players.length) {
      const newRoomId = genId();
      const newRoom = {
        id: newRoomId,
        hostId: null,
        players: [],
        state: 'lobby',
        currentRound: 0, totalRounds: 0,
        playerOrder: [], hands: {}, bids: {}, bidsReady: {},
        tricks: {}, currentTrick: [], currentLeader: 0,
        leadSuit: null, trumpSuit: null,
        scores: {}, roundScores: [],
      };

      // Carry over all players with fresh tokens
      room.players.forEach((p, i) => {
        const newToken = genToken();
        newRoom.players.push({ id: p.id, name: p.name, connected: p.connected, token: newToken });
        if (i === 0) newRoom.hostId = p.id;
        // Tell each player their new session
        if (p.connected) {
          io.to(p.id).emit('newLobby', { roomId: newRoomId, playerIndex: i, playerToken: newToken, playerName: p.name });
        }
      });
      // First connected player becomes host
      const firstConnected = newRoom.players.find(p => p.connected);
      if (firstConnected) newRoom.hostId = firstConnected.id;

      rooms[newRoomId] = newRoom;

      // Move all sockets to new room
      newRoom.players.forEach(p => {
        if (p.connected) {
          const s = io.sockets.sockets.get(p.id);
          if (s) {
            s.leave(room.id);
            s.join(newRoomId);
            s.data.roomId = newRoomId;
          }
        }
      });

      // Update playerIndex in socket.data for new room
      newRoom.players.forEach((p, i) => {
        const s = io.sockets.sockets.get(p.id);
        if (s) s.data.playerIndex = i;
      });

      // Broadcast lobby to new room
      newRoom.players.forEach(p => {
        if (p.connected) io.to(p.id).emit('roomUpdate', sanitizeRoom(newRoom, p.id));
      });

      delete rooms[room.id];
      console.log(`play again: new room ${newRoomId}`);
    }
  });

  // ── DISCONNECT ───────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    if (!roomId || !rooms[roomId]) return;
    const room = rooms[roomId];
    const player = room.players[socket.data.playerIndex];
    if (player && player.id === socket.id) {
      player.connected = false;
      io.to(roomId).emit('playerDisconnected', { playerIndex: socket.data.playerIndex, name: player.name });
      // If in lobby, refresh room so offline badge shows
      if (room.state === 'lobby') broadcastRoomUpdate(room);
    }
    console.log(`${player?.name || '?'} disconnected from ${roomId}`);
  });
});

// ─── Game Logic ───────────────────────────────────────────────────────────
function startRound(room) {
  room.state = 'bidding';
  room.bids = {}; room.bidsReady = {}; room.tricks = {};
  room.currentTrick = []; room.leadSuit = null;
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

  io.to(room.id).emit('trickWon', { winnerIndex: winner, winnerName: room.players[winner].name });

  room.currentTrick = [];
  room.leadSuit = null;
  room.currentLeader = winner;

  const cardsLeft = Object.values(room.hands).reduce((s, h) => s + h.length, 0);
  if (cardsLeft === 0) setTimeout(() => endRound(room), 1000);
  else broadcastGameState(room);
}

function endRound(room) {
  const results = room.players.map((p, i) => {
    const bid = room.bids[i] ?? 0;
    const actual = room.tricks[i] ?? 0;
    const points = roundScore(bid, actual);
    room.scores[i] = (room.scores[i] || 0) + points;
    return { playerIndex:i, name:p.name, bid, actual, points, totalScore:room.scores[i] };
  });
  room.roundScores.push(results);
  room.state = 'round_end';

  io.to(room.id).emit('roundEnd', { roundIndex: room.currentRound, results, scores: {...room.scores} });

  room.currentRound++;
  if (room.currentRound >= room.totalRounds) setTimeout(() => endGame(room), 3000);
  else setTimeout(() => startRound(room), 4000);
}

function endGame(room) {
  room.state = 'game_over';
  room.playAgainVotes = new Set();
  const finalScores = room.players
    .map((p, i) => ({ playerIndex:i, name:p.name, score:room.scores[i]||0 }))
    .sort((a, b) => b.score - a.score);

  io.to(room.id).emit('gameOver', { finalScores });
  broadcastGameState(room);
}

function broadcastGameState(room) {
  room.players.forEach((player, pIdx) => {
    if (player.connected) io.to(player.id).emit('gameState', buildPlayerState(room, pIdx));
  });
}

function buildPlayerState(room, pIdx) {
  return {
    roomId: room.id, state: room.state,
    currentRound: room.currentRound, totalRounds: room.totalRounds,
    trumpSuit: room.trumpSuit,
    trumpSymbol: SUIT_SYMBOLS[room.trumpSuit] || '',
    trumpName: SUIT_NAMES[room.trumpSuit] || '',
    playerOrder: room.playerOrder,
    players: room.players.map((p, i) => ({
      index: i, name: p.name, connected: p.connected,
      isHost: room.hostId === p.id,
      score: room.scores[i] || 0,
      bidReady: !!room.bidsReady[i],
      bid: (i === pIdx || room.state === 'playing' || room.state === 'round_end' || room.state === 'game_over')
           ? (room.bids[i] ?? null) : null,
      tricksWon: room.tricks[i] || 0,
      cardsInHand: room.hands[i] ? room.hands[i].length : 0,
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
    scores: {...room.scores},
    playAgainVotes: room.playAgainVotes ? [...room.playAgainVotes].map(i => room.players[i]?.name).filter(Boolean) : [],
  };
}

function getCurrentTurn(room) {
  if (room.state !== 'playing') return null;
  const seatPos = room.currentTrick.length;
  const leaderIdx = room.playerOrder.indexOf(room.currentLeader);
  return room.playerOrder[(leaderIdx + seatPos) % room.playerOrder.length];
}

function sanitizeRoom(room, forSocketId) {
  return {
    id: room.id, state: room.state,
    players: room.players.map(p => ({ name:p.name, connected:p.connected, isHost:p.id===room.hostId })),
    hostId: room.hostId,
    isHost: room.hostId === forSocketId,
    maxRounds: room.players.length > 0 ? Math.floor(52 / room.players.length) : 0,
  };
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🎴 Kachu Phul server on port ${PORT}`));