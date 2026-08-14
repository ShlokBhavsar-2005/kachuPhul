# Implementation Plan: Kaali Teeri / 3 of Spades — Multi-Game Platform

## Overview

Add **Kaali Teeri (3 of Spades)** as a second playable card game inside the existing **Kachu Phul** platform. The existing game becomes "Kachu Phul" mode and this becomes "Kaali Teeri" mode. The login, home, rooms, friends, chat, spectating, and multiplayer infrastructure stay shared. Only game-specific logic (dealing, bidding, trump, partners, trick-taking, scoring) differs per mode.

---

## Existing Codebase Summary (What We're Working With)

### Files

| File | Purpose | Approx Size |
|---|---|---|
| `server.js` | Express + Socket.IO server. Auth, rooms, game logic, broadcast. | ~1041 lines |
| `public/index.html` | Single HTML file with all screens (home, name, menu, waiting, game, overlays). | ~363 lines |
| `public/js/app.js` | Client-side state, socket handlers, all rendering functions. | ~868 lines |
| `public/css/style.css` | All CSS styling. | ~41KB |
| `package.json` | Node deps: express, socket.io, mongodb, google-auth-library, uuid. | — |

### Current Architecture

- **Auth**: Google OAuth → MongoDB user record → session token → stored in `localStorage`.
- **Rooms**: In-memory `rooms` object keyed by room ID. Room has `players[]`, `state`, `hostSocketId`, etc.
- **Game flow**: `lobby` → `bidding` → `playing` → `round_end` → `game_over`. Repeats for N rounds.
- **Existing game (Kachu Phul)**: Classic Judgment/Oh Hell — each round has a trump, players bid how many tricks they'll win, scoring = bid if exact, 0 otherwise. Rounds decrease in card count.
- **No `gameType` field exists on rooms currently.**
- **All game logic is inline in `server.js`** — no modules/files separation.
- **Client rendering is entirely in `app.js`** — `renderGameState()`, `renderBidPanel()`, `renderSeats()`, etc.

### Key Existing Functions That Will Be Affected

**Server (`server.js`):**
- `createDeck()` (line 149) — creates 52-card deck
- `shuffle()` (line 154) — Fisher-Yates shuffle
- `dealCards()` (line 161) — deals cards for Kachu Phul's round system
- `cardValue()` (line 165) — determines trick winner by comparing card rank + suit
- `trickWinner()` (line 170) — finds trick winner
- `roundScore()` (line 175) — Kachu Phul scoring: bid===actual → points
- `startRound()` (line 958) — begins a Kachu Phul round
- `resolveTrick()` (line 967) — resolves a completed trick
- `endRound()` (line 987) — scores round, starts next or ends game
- `endGame()` (line 999) — marks game over
- `buildPlayerState()` (line 1008) — constructs state sent to each client
- `buildSpectatorState()` (line 1026) — constructs spectator state
- `sanitizeRoom()` (line 1032) — room info for lobby
- `socket 'startGame'` handler (line 722) — starts the game
- `socket 'submitBid'` handler (line 745) — handles bid submission
- `socket 'playCard'` handler (line 759) — handles card play
- `getCurrentTurn()` (line 176) — determines whose turn it is

**Client (`app.js`):**
- `renderGameState()` (line 493) — main render dispatcher
- `renderBidPanel()` (line 669) — bid UI
- `renderSeats()` (line 512) — player seats
- `renderHand()` (line 630) — player's hand
- `renderTrick()` (line 604) — trick area
- `updateTopBar()` (line 505) — trump/round info bar
- `showGameOver()` (line 747) — game over overlay
- `showRoundEnd()` (line 718) — round results
- `startGame()` (line 409) — emits startGame

---

## Architecture: Multi-Game Support Strategy

### Principle: Game Type Registry

Do NOT hard-code Kaali Teeri logic into the existing Kachu Phul functions. Instead, create a game-type abstraction:

```
room.gameType = 'kachuPhul' | 'kaaliTeeri'
```

### Server-Side Structure

Create separate game logic modules. The server.js file is already ~1000 lines. Adding another game's worth of logic inline would be unmanageable. **Create a `games/` directory:**

```
kachufool/
├── server.js                    ← main server (auth, rooms, sockets — SHARED)
├── games/
│   ├── gameRegistry.js          ← [NEW] maps gameType → handler module
│   ├── kachuPhul.js             ← [NEW] extract existing Kachu Phul logic
│   └── kaaliTeeri.js            ← [NEW] Kaali Teeri game logic
├── public/
│   ├── index.html               ← [MODIFY] add game selection UI, KT-specific overlays
│   ├── css/style.css            ← [MODIFY] add KT-specific styles
│   └── js/
│       ├── app.js               ← [MODIFY] add game-type dispatching, KT rendering
│       └── kaaliTeeri.js        ← [NEW] KT-specific client rendering/logic
```

### Client-Side Structure

Keep `app.js` as the shared platform layer (auth, room, socket, etc.). Add `kaaliTeeri.js` for game-specific UI. Use a simple dispatcher pattern:

```javascript
// In app.js
function renderGameState(state) {
  if (state.gameType === 'kaaliTeeri') return renderKaaliTeeriState(state); // from kaaliTeeri.js
  renderKachuPhulState(state); // existing logic, renamed
}
```

---

## Detailed Implementation Tasks

---

### PHASE 1: Server Refactoring — Extract Game Logic into Modules

#### Task 1.1: Create `games/gameRegistry.js`

**Purpose:** Central registry that maps `gameType` strings to game handler objects.

```javascript
// games/gameRegistry.js
const kachuPhul = require('./kachuPhul');
const kaaliTeeri = require('./kaaliTeeri');

const GAMES = {
  kachuPhul: {
    name: 'Kachu Phul',
    description: 'Classic bidding card game',
    minPlayers: 2,
    maxPlayers: 7,
    handler: kachuPhul,
  },
  kaaliTeeri: {
    name: 'Kaali Teeri',
    description: '3 of Spades — team bidding game',
    minPlayers: 4,
    maxPlayers: 6,
    allowedPlayerCounts: [4, 6], // only exactly 4 or 6
    handler: kaaliTeeri,
  },
};

module.exports = { GAMES };
```

Each handler module exports a standard interface:

```javascript
module.exports = {
  validateStart(room),           // check player count, return error string or null
  initGame(room),                // set up initial game state
  handleBid(room, playerIndex, bidData),
  handleTrumpSelect(room, playerIndex, suit),
  handlePartnerSelect(room, playerIndex, partnerCards),
  handlePlayCard(room, playerIndex, cardId),
  buildPlayerState(room, playerIndex),
  buildSpectatorState(room),
  getCurrentTurn(room),
};
```

#### Task 1.2: Create `games/kachuPhul.js` — Extract Existing Logic

Move these functions OUT of `server.js` into this module:
- `createDeck()`, `shuffle()`, `getTrump()`, `getCardsForRound()`, `dealCards()`
- `cardValue()`, `trickWinner()`, `roundScore()`
- `startRound()`, `resolveTrick()`, `endRound()`, `endGame()`
- `buildPlayerState()`, `buildSpectatorState()`
- `getCurrentTurn()`

The module receives `io` and `rooms` references via an `init(io, rooms)` call or by accepting them as parameters on each function call.

**Keep `server.js` as the orchestrator:** It still handles socket events, but dispatches to the correct game handler:

```javascript
// server.js (modified startGame handler)
socket.on('startGame', ({ totalRounds, gameType }) => {
  const room = rooms[socket.data.roomId];
  if (!room || room.hostSocketId !== socket.id) return;
  
  const game = GAMES[gameType || room.gameType || 'kachuPhul'];
  if (!game) return socket.emit('error', 'Unknown game type');
  
  const err = game.handler.validateStart(room);
  if (err) return socket.emit('error', err);
  
  room.gameType = gameType || room.gameType || 'kachuPhul';
  game.handler.initGame(room, { totalRounds });
});
```

#### Task 1.3: Modify `server.js` — Room Gets `gameType` Field

When a room is created, default `gameType` to `null` (not yet selected). Add a `gameType` field to the room object:

```javascript
rooms[roomId] = {
  id: roomId,
  hostSocketId: socket.id,
  gameType: null,  // ← NEW: set when host selects game
  players: [...],
  // ... rest unchanged
};
```

Add a new socket event for the host to select the game type:

```javascript
socket.on('selectGameType', ({ gameType }) => {
  const room = rooms[socket.data.roomId];
  if (!room || room.hostSocketId !== socket.id) return;
  if (room.state !== 'lobby') return;
  if (!GAMES[gameType]) return socket.emit('error', 'Unknown game type');
  room.gameType = gameType;
  broadcastRoomUpdate(room);
});
```

Update `sanitizeRoom()` to include `gameType`:

```javascript
function sanitizeRoom(room, forSocketId) {
  return {
    id: room.id,
    state: room.state,
    gameType: room.gameType,  // ← NEW
    players: room.players.map(p => ({ ... })),
    // ... rest unchanged
  };
}
```

---

### PHASE 2: Kaali Teeri Server-Side Game Logic

#### Task 2.1: Create `games/kaaliTeeri.js` — Core Module

This is the largest single file. Structure it as follows:

##### Constants

```javascript
const SUITS = ['spades', 'diamonds', 'clubs', 'hearts'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

// Card POINT values (for scoring) — separate from rank comparison
const CARD_POINTS = {
  '3_spades': 30,  // Special: 3 of Spades = 30 points
  // All 5s = 5 points
  '5_spades': 5, '5_diamonds': 5, '5_clubs': 5, '5_hearts': 5,
  // 10, J, Q, K, A = 10 points each (any suit)
  // All others = 0
};

function getCardPoints(card) {
  // Check special card first
  if (card.rank === '3' && card.suit === 'spades') return 30;
  if (card.rank === '5') return 5;
  if (['10', 'J', 'Q', 'K', 'A'].includes(card.rank)) return 10;
  return 0;
}

// TOTAL POINTS IN DECK:
// 3♠ = 30
// 4 × 5 = 20
// 4 × 10 = 40
// 4 × J = 40
// 4 × Q = 40
// 4 × K = 40
// 4 × A = 40
// Total = 250

// Card RANK values (for trick comparison — completely separate from points!)
const RANK_ORDER = {
  '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7,
  '8': 8, '9': 9, '10': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14
};

const MIN_BID = 150;
const MAX_BID = 250;
const BID_INCREMENT = 5;
```

**CRITICAL DESIGN DECISION:** Card point values (for scoring) and card rank values (for trick comparison) MUST be kept as separate systems. `getCardPoints()` is only used at the end for scoring. `RANK_ORDER` is only used in `trickCompareValue()` for determining who wins a trick.

##### Game Phases (as an enum-like object)

```javascript
const PHASES = {
  WAITING: 'waiting',
  DEALING: 'dealing',
  BIDDING: 'bidding',
  BID_WON: 'bid_won',
  TRUMP_SELECT: 'trump_select',
  PARTNER_SELECT: 'partner_select',
  PLAYING: 'playing',
  SCORING: 'scoring',
  GAME_OVER: 'game_over',
};
```

##### Deck Creation

```javascript
function createDeck(playerCount) {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      // For 6 players: remove all 2s
      if (playerCount === 6 && rank === '2') continue;
      deck.push({ suit, rank, id: `${rank}_${suit}` });
    }
  }
  return deck;
}
// 4 players: 52 cards, 13 each
// 6 players: 48 cards (no 2s), 8 each
```

##### Dealing

```javascript
function dealCards(playerCount) {
  const deck = shuffle(createDeck(playerCount));
  const cardsPerPlayer = playerCount === 4 ? 13 : 8;
  const hands = {};
  for (let i = 0; i < playerCount; i++) {
    hands[i] = deck.slice(i * cardsPerPlayer, (i + 1) * cardsPerPlayer);
  }
  return hands;
}
```

##### validateStart

```javascript
function validateStart(room) {
  const count = room.players.filter(p => p.connected).length;
  if (count !== 4 && count !== 6) {
    return 'Kaali Teeri requires exactly 4 or 6 players';
  }
  return null;
}
```

##### initGame — Set Up the Entire Game State

```javascript
function initGame(room, io, broadcastGameState) {
  const playerCount = room.players.length;
  
  // Shuffle player order for turn sequence
  const indices = room.players.map((_, i) => i);
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  
  room.playerOrder = indices;
  room.gameType = 'kaaliTeeri';
  
  // Kaali Teeri specific state
  room.kt = {
    phase: PHASES.DEALING,
    playerCount: playerCount,
    
    // Bidding
    currentBidderIndex: 0,       // index into playerOrder
    highestBid: 0,
    highestBidder: null,
    bidPassed: {},               // playerIndex → true if passed
    biddingOrder: [...indices],  // who bids in what order
    
    // Trump
    trumpSuit: null,
    
    // Partners
    partnerCards: [],             // array of card IDs requested as partner cards
    revealedPartners: [],         // array of { playerIndex, cardId }
    partnerPlayerIndices: [],     // actual partner player indices (computed from card ownership)
    bidWinnerIndex: null,
    
    // Trick-taking
    currentTrick: [],
    currentLeader: null,         // who leads current trick
    leadSuit: null,
    tricksPlayed: 0,
    
    // Won cards tracking (for scoring)
    wonCards: {},                 // playerIndex → array of cards won
    
    // Teams (computed at end)
    bidWinnerTeam: [],           // array of player indices
    defenderTeam: [],            // array of player indices
  };
  
  // Deal cards
  room.hands = dealCards(playerCount);
  
  // Initialize won cards
  for (let i = 0; i < playerCount; i++) {
    room.kt.wonCards[i] = [];
  }
  
  // Move to bidding phase
  room.kt.phase = PHASES.BIDDING;
  room.kt.currentBidderIndex = 0;
  room.state = 'playing'; // generic room state for the platform
  
  broadcastGameState(room);
}
```

#### Task 2.2: Bidding System

The bidding is SEQUENTIAL (one player at a time), not simultaneous like Kachu Phul.

```javascript
// socket event: 'ktBid'
// data: { action: 'bid' | 'pass', amount: number }

function handleBid(room, playerIndex, { action, amount }, io, broadcastGameState) {
  const kt = room.kt;
  if (kt.phase !== PHASES.BIDDING) return 'Not in bidding phase';
  
  // Verify it's this player's turn to bid
  const expectedBidder = kt.biddingOrder[kt.currentBidderIndex];
  if (playerIndex !== expectedBidder) return 'Not your turn to bid';
  
  if (action === 'pass') {
    kt.bidPassed[playerIndex] = true;
    
    // Check if only one player remains who hasn't passed
    const activeBidders = kt.biddingOrder.filter(i => !kt.bidPassed[i]);
    
    if (activeBidders.length === 1) {
      // That player wins the bid
      kt.bidWinnerIndex = activeBidders[0];
      kt.phase = PHASES.BID_WON;
      
      // If no one actually bid (everyone passed except one), 
      // the remaining player must bid at least MIN_BID
      if (kt.highestBid === 0) {
        kt.highestBid = MIN_BID;
        kt.highestBidder = kt.bidWinnerIndex;
      }
      
      // Move to trump selection
      kt.phase = PHASES.TRUMP_SELECT;
      broadcastGameState(room);
      return null;
    }
    
    // Move to next active bidder
    advanceBidder(kt);
    broadcastGameState(room);
    return null;
  }
  
  if (action === 'bid') {
    // Validate bid
    if (typeof amount !== 'number') return 'Invalid bid';
    if (amount % BID_INCREMENT !== 0) return 'Bid must be in increments of 5';
    if (amount < MIN_BID) return `Minimum bid is ${MIN_BID}`;
    if (amount > MAX_BID) return `Maximum bid is ${MAX_BID}`;
    if (kt.highestBid > 0 && amount <= kt.highestBid) return `Must bid higher than ${kt.highestBid}`;
    
    kt.highestBid = amount;
    kt.highestBidder = playerIndex;
    
    // If bid is MAX, bidding is over
    if (amount >= MAX_BID) {
      kt.bidWinnerIndex = playerIndex;
      kt.phase = PHASES.TRUMP_SELECT;
      broadcastGameState(room);
      return null;
    }
    
    // Move to next active bidder
    advanceBidder(kt);
    broadcastGameState(room);
    return null;
  }
  
  return 'Invalid action';
}

function advanceBidder(kt) {
  let next = (kt.currentBidderIndex + 1) % kt.biddingOrder.length;
  let attempts = 0;
  while (kt.bidPassed[kt.biddingOrder[next]] && attempts < kt.biddingOrder.length) {
    next = (next + 1) % kt.biddingOrder.length;
    attempts++;
  }
  kt.currentBidderIndex = next;
}
```

#### Task 2.3: Trump Selection

```javascript
// socket event: 'ktSelectTrump'
// data: { suit: 'spades' | 'diamonds' | 'clubs' | 'hearts' }

function handleTrumpSelect(room, playerIndex, { suit }, io, broadcastGameState) {
  const kt = room.kt;
  if (kt.phase !== PHASES.TRUMP_SELECT) return 'Not in trump selection phase';
  if (playerIndex !== kt.bidWinnerIndex) return 'Only the bid winner can select trump';
  if (!SUITS.includes(suit)) return 'Invalid suit';
  
  kt.trumpSuit = suit;
  kt.phase = PHASES.PARTNER_SELECT;
  broadcastGameState(room);
  return null;
}
```

#### Task 2.4: Partner Card Selection

```javascript
// socket event: 'ktSelectPartners'
// data: { partnerCards: ['A_spades'] } for 4-player
//    or { partnerCards: ['A_spades', 'K_hearts'] } for 6-player

function handlePartnerSelect(room, playerIndex, { partnerCards }, io, broadcastGameState) {
  const kt = room.kt;
  if (kt.phase !== PHASES.PARTNER_SELECT) return 'Not in partner selection phase';
  if (playerIndex !== kt.bidWinnerIndex) return 'Only the bid winner can select partner cards';
  
  const expectedCount = kt.playerCount === 4 ? 1 : 2;
  if (!Array.isArray(partnerCards) || partnerCards.length !== expectedCount) {
    return `Must select exactly ${expectedCount} partner card(s)`;
  }
  
  // Validate each card exists in the game (and is not in bid winner's own hand)
  for (const cardId of partnerCards) {
    const inBidWinnerHand = room.hands[kt.bidWinnerIndex].some(c => c.id === cardId);
    if (inBidWinnerHand) return 'Cannot select a card from your own hand as partner card';
    
    // Verify card exists in some player's hand
    let found = false;
    for (let i = 0; i < kt.playerCount; i++) {
      if (room.hands[i].some(c => c.id === cardId)) { found = true; break; }
    }
    if (!found) return `Card ${cardId} not found in any player's hand`;
  }
  
  kt.partnerCards = partnerCards;
  
  // Internally track who owns the partner cards (but DO NOT reveal to clients)
  kt.partnerOwners = {}; // cardId → playerIndex (server-side only, never sent to clients)
  for (const cardId of partnerCards) {
    for (let i = 0; i < kt.playerCount; i++) {
      if (room.hands[i].some(c => c.id === cardId)) {
        kt.partnerOwners[cardId] = i;
        break;
      }
    }
  }
  
  // Determine unique partner player indices (for server-side team calculation only)
  // DO NOT reveal this to clients yet
  const partnerSet = new Set(Object.values(kt.partnerOwners));
  partnerSet.delete(kt.bidWinnerIndex); // bid winner can't be their own partner
  kt.partnerPlayerIndices = [...partnerSet];
  
  // Build teams (server-side only for now)
  kt.bidWinnerTeam = [kt.bidWinnerIndex, ...kt.partnerPlayerIndices];
  kt.defenderTeam = [];
  for (let i = 0; i < kt.playerCount; i++) {
    if (!kt.bidWinnerTeam.includes(i)) kt.defenderTeam.push(i);
  }
  
  // Start gameplay
  kt.phase = PHASES.PLAYING;
  kt.currentLeader = kt.bidWinnerIndex; // Bid winner leads first trick
  broadcastGameState(room);
  return null;
}
```

#### Task 2.5: Trick-Taking (Play Card)

```javascript
// socket event: 'ktPlayCard'  (or reuse 'playCard' with game-type dispatch)
// data: { cardId: 'A_spades' }

function handlePlayCard(room, playerIndex, { cardId }, io, broadcastGameState) {
  const kt = room.kt;
  if (kt.phase !== PHASES.PLAYING) return 'Not in playing phase';
  
  // Verify turn
  const expectedTurn = getCurrentTurn(room);
  if (playerIndex !== expectedTurn) return 'Not your turn';
  
  // Verify card in hand
  const hand = room.hands[playerIndex];
  const cardIdx = hand.findIndex(c => c.id === cardId);
  if (cardIdx === -1) return 'Card not in your hand';
  const card = hand[cardIdx];
  
  // Validate suit following
  if (kt.currentTrick.length > 0) {
    const hasLeadSuit = hand.some(c => c.suit === kt.leadSuit);
    if (hasLeadSuit && card.suit !== kt.leadSuit) {
      return `Must follow suit: ${kt.leadSuit}`;
    }
  }
  
  // Play the card
  if (kt.currentTrick.length === 0) {
    kt.leadSuit = card.suit;
  }
  
  hand.splice(cardIdx, 1);
  kt.currentTrick.push({ playerIndex, card });
  
  // *** PARTNER REVEAL CHECK ***
  if (kt.partnerCards.includes(cardId)) {
    // This card is a partner card! Reveal the partnership.
    kt.revealedPartners.push({ playerIndex, cardId });
    
    // Emit partner reveal event to ALL clients
    io.to(room.id).emit('ktPartnerRevealed', {
      partnerPlayerIndex: playerIndex,
      partnerPlayerName: room.players[playerIndex].name,
      bidWinnerPlayerIndex: kt.bidWinnerIndex,
      bidWinnerPlayerName: room.players[kt.bidWinnerIndex].name,
      partnerCardId: cardId,
    });
  }
  
  broadcastGameState(room);
  
  // Check if trick is complete
  if (kt.currentTrick.length === kt.playerCount) {
    setTimeout(() => resolveTrick(room, io, broadcastGameState), 1500);
  }
  
  return null;
}

function getCurrentTurn(room) {
  const kt = room.kt;
  if (kt.phase !== PHASES.PLAYING) return null;
  
  const leaderPos = room.playerOrder.indexOf(kt.currentLeader);
  const trickPos = kt.currentTrick.length;
  return room.playerOrder[(leaderPos + trickPos) % room.playerOrder.length];
}
```

#### Task 2.6: Trick Resolution

```javascript
function trickCompareValue(card, leadSuit, trumpSuit) {
  // Trump cards beat all; within suit, rank determines winner
  if (card.suit === trumpSuit) return 1000 + RANK_ORDER[card.rank];
  if (card.suit === leadSuit) return RANK_ORDER[card.rank];
  return 0; // off-suit, non-trump = can't win
}

function resolveTrick(room, io, broadcastGameState) {
  const kt = room.kt;
  
  // Find trick winner
  let bestIdx = 0;
  let bestVal = trickCompareValue(kt.currentTrick[0].card, kt.leadSuit, kt.trumpSuit);
  for (let i = 1; i < kt.currentTrick.length; i++) {
    const val = trickCompareValue(kt.currentTrick[i].card, kt.leadSuit, kt.trumpSuit);
    if (val > bestVal) { bestVal = val; bestIdx = i; }
  }
  
  const winnerPlayerIndex = kt.currentTrick[bestIdx].playerIndex;
  
  // Add ALL cards from this trick to the winner's won-cards pile
  for (const entry of kt.currentTrick) {
    kt.wonCards[winnerPlayerIndex].push(entry.card);
  }
  
  // Emit trick won event
  io.to(room.id).emit('ktTrickWon', {
    winnerIndex: winnerPlayerIndex,
    winnerName: room.players[winnerPlayerIndex].name,
    trick: [...kt.currentTrick],
  });
  
  kt.tricksPlayed++;
  
  // Clear trick after a delay for animation
  setTimeout(() => {
    kt.currentTrick = [];
    kt.leadSuit = null;
    kt.currentLeader = winnerPlayerIndex;
    
    // Check if all cards have been played
    const cardsLeft = Object.values(room.hands).reduce((sum, h) => sum + h.length, 0);
    if (cardsLeft === 0) {
      // Game over — calculate scores
      setTimeout(() => endGame(room, io, broadcastGameState), 1500);
    } else {
      broadcastGameState(room);
    }
  }, 2000);
}
```

#### Task 2.7: Scoring & End Game

```javascript
function calculateTeamPoints(room, teamIndices) {
  let total = 0;
  // Use a Set to avoid double-counting if same player appears twice
  const uniqueIndices = [...new Set(teamIndices)];
  for (const idx of uniqueIndices) {
    const wonCards = room.kt.wonCards[idx] || [];
    for (const card of wonCards) {
      total += getCardPoints(card);
    }
  }
  return total;
}

function endGame(room, io, broadcastGameState) {
  const kt = room.kt;
  kt.phase = PHASES.SCORING;
  
  // Calculate bid winner team points
  const bidWinnerTeamPoints = calculateTeamPoints(room, kt.bidWinnerTeam);
  
  // Calculate defender team points
  const defenderTeamPoints = calculateTeamPoints(room, kt.defenderTeam);
  
  // Determine winner
  const bidWinnerTeamWins = bidWinnerTeamPoints >= kt.highestBid;
  
  // Build result object
  const result = {
    winningTeam: bidWinnerTeamWins ? 'bidWinner' : 'defenders',
    bidWinnerTeamPoints,
    defenderTeamPoints,
    winningBid: kt.highestBid,
    bidWinner: {
      playerIndex: kt.bidWinnerIndex,
      name: room.players[kt.bidWinnerIndex].name,
    },
    partners: kt.partnerPlayerIndices.map(i => ({
      playerIndex: i,
      name: room.players[i].name,
    })),
    bidWinnerTeam: kt.bidWinnerTeam.map(i => ({
      playerIndex: i,
      name: room.players[i].name,
    })),
    defenderTeam: kt.defenderTeam.map(i => ({
      playerIndex: i,
      name: room.players[i].name,
    })),
    partnerCards: kt.partnerCards,
    trumpSuit: kt.trumpSuit,
    
    // Per-player breakdown
    playerScores: {},
  };
  
  // Per-player won card details
  for (let i = 0; i < kt.playerCount; i++) {
    const wonCards = kt.wonCards[i] || [];
    let points = 0;
    for (const card of wonCards) points += getCardPoints(card);
    result.playerScores[i] = {
      name: room.players[i].name,
      wonCardCount: wonCards.length,
      points,
      team: kt.bidWinnerTeam.includes(i) ? 'bidWinner' : 'defenders',
    };
  }
  
  kt.phase = PHASES.GAME_OVER;
  room.state = 'game_over';
  room.kt.result = result;
  
  io.to(room.id).emit('ktGameOver', result);
  broadcastGameState(room);
}
```

#### Task 2.8: Build Player State for Kaali Teeri

The `buildPlayerState` for KT must send different data than Kachu Phul:

```javascript
function buildPlayerState(room, playerIndex) {
  const kt = room.kt;
  
  return {
    roomId: room.id,
    gameType: 'kaaliTeeri',
    state: room.state,
    phase: kt.phase,
    playerCount: kt.playerCount,
    
    // Players info
    playerOrder: room.playerOrder,
    players: room.players.map((p, i) => ({
      index: i,
      name: p.name,
      connected: p.connected,
      isHost: room.hostSocketId === p.socketId,
      isBidWinner: i === kt.bidWinnerIndex,
      isRevealed: kt.revealedPartners.some(rp => rp.playerIndex === i),
      isOnBidWinnerTeam: kt.revealedPartners.some(rp => rp.playerIndex === i) || i === kt.bidWinnerIndex,
      cardsInHand: room.hands[i] ? room.hands[i].length : 0,
      wonCardCount: (kt.wonCards[i] || []).length,
    })),
    
    // My info
    myIndex: playerIndex,
    myHand: room.hands[playerIndex] || [],
    
    // Bidding state
    bidding: {
      currentBidder: kt.biddingOrder[kt.currentBidderIndex],
      highestBid: kt.highestBid,
      highestBidder: kt.highestBidder,
      highestBidderName: kt.highestBidder !== null ? room.players[kt.highestBidder]?.name : null,
      passed: { ...kt.bidPassed },
      isMyTurnToBid: kt.phase === PHASES.BIDDING && kt.biddingOrder[kt.currentBidderIndex] === playerIndex,
      myHasPassed: !!kt.bidPassed[playerIndex],
    },
    
    // Trump
    trumpSuit: kt.trumpSuit,
    
    // Partner info (what clients are allowed to see)
    partnerCards: kt.partnerCards,  // everyone sees which cards were requested
    revealedPartners: kt.revealedPartners, // only revealed ones
    bidWinnerIndex: kt.bidWinnerIndex,
    bidWinnerName: kt.bidWinnerIndex !== null ? room.players[kt.bidWinnerIndex]?.name : null,
    winningBid: kt.highestBid,
    
    // Trick state
    currentTrick: kt.currentTrick,
    leadSuit: kt.leadSuit,
    currentLeader: kt.currentLeader,
    currentTurnIndex: getCurrentTurn(room),
    
    // Game result (only when game is over)
    result: kt.phase === PHASES.GAME_OVER ? kt.result : null,
    
    // Spectator count
    spectatorCount: (room.spectators || []).length,
    
    // Play again
    playAgainVotes: room.playAgainVotes 
      ? [...room.playAgainVotes].map(i => room.players[i]?.name).filter(Boolean) 
      : [],
  };
}
```

**IMPORTANT SECURITY NOTE:** Never send `kt.partnerOwners` to clients. The only way clients learn who the partners are is through `revealedPartners[]` which only gets populated when the partner card is physically played.

#### Task 2.9: Server Socket Event Routing

In `server.js`, add new socket event handlers that dispatch to the KT handler:

```javascript
// New Kaali Teeri socket events
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
```

Modify the existing `startGame` handler to dispatch based on `gameType`:

```javascript
socket.on('startGame', ({ totalRounds, gameType }) => {
  const room = rooms[socket.data.roomId];
  if (!room || room.hostSocketId !== socket.id) return;
  
  const selectedType = gameType || room.gameType || 'kachuPhul';
  room.gameType = selectedType;
  
  if (selectedType === 'kaaliTeeri') {
    room.players = room.players.filter(p => p.connected);
    const err = kaaliTeeri.validateStart(room);
    if (err) return socket.emit('error', err);
    
    room.players.forEach((p, i) => io.to(p.socketId).emit('yourIndex', i));
    kaaliTeeri.initGame(room, io, broadcastGameState);
    return;
  }
  
  // ... existing Kachu Phul startGame logic unchanged
});
```

Modify `broadcastGameState` to dispatch:

```javascript
function broadcastGameState(room) {
  if (room.gameType === 'kaaliTeeri') {
    room.players.forEach((p, i) => {
      if (p.connected) io.to(p.socketId).emit('gameState', kaaliTeeri.buildPlayerState(room, i));
    });
    (room.spectators || []).forEach(s => {
      io.to(s.socketId).emit('gameState', kaaliTeeri.buildSpectatorState(room));
    });
    return;
  }
  // ... existing broadcast for Kachu Phul
  room.players.forEach((p, i) => {
    if (p.connected) io.to(p.socketId).emit('gameState', buildPlayerState(room, i));
  });
  (room.spectators || []).forEach(s => {
    io.to(s.socketId).emit('gameState', buildSpectatorState(room));
  });
}
```

---

### PHASE 3: Client-Side — Lobby Game Selection UI

#### Task 3.1: Add Game Selection to Waiting Room (index.html)

Inside the `#waiting-screen` → `.waiting-card`, BEFORE the rounds selector, add a game selection section. This is only visible to the host.

```html
<!-- GAME TYPE SELECTOR (host only) -->
<div id="game-type-selector" class="hidden">
  <div class="game-type-label">Select Game Mode</div>
  <div class="game-type-options" id="game-type-options">
    <button class="game-type-btn active" data-game="kachuPhul" onclick="selectGameType('kachuPhul')">
      <div class="game-type-icon">♠♦♣♥</div>
      <div class="game-type-name">Kachu Phul</div>
      <div class="game-type-desc">Classic bidding · 2–7 players</div>
    </button>
    <button class="game-type-btn" data-game="kaaliTeeri" onclick="selectGameType('kaaliTeeri')">
      <div class="game-type-icon">3♠</div>
      <div class="game-type-name">Kaali Teeri</div>
      <div class="game-type-desc">Team bidding · 4 or 6 players</div>
    </button>
  </div>
</div>
```

**Placement:** This goes right after the `spectator-info` div and before `game-info-preview`.

#### Task 3.2: Lobby Rendering Changes (app.js)

In `renderWaitingRoom()`:
- Show/hide game type selector for host
- When `kaaliTeeri` is selected, hide the rounds selector (KT is single-round)
- Update `game-info-preview` text based on selected game
- Validate player count and show warnings

```javascript
let selectedGameType = 'kachuPhul'; // default

function selectGameType(type) {
  selectedGameType = type;
  socket.emit('selectGameType', { gameType: type });
  // Update UI
  document.querySelectorAll('.game-type-btn').forEach(b => b.classList.remove('active'));
  document.querySelector(`[data-game="${type}"]`)?.classList.add('active');
  // Re-render waiting room with current room data
  if (currentRoomData) renderWaitingRoom(currentRoomData);
}
```

In `renderWaitingRoom(room)`:
```javascript
// Show game type selector for host
if (room.isHost) {
  $('game-type-selector').classList.remove('hidden');
} else {
  $('game-type-selector').classList.add('hidden');
}

// Update selected game type from server
if (room.gameType) selectedGameType = room.gameType;

// If Kaali Teeri selected:
if (selectedGameType === 'kaaliTeeri') {
  // Hide rounds selector (single round game)
  document.querySelector('.rounds-selector')?.classList.add('hidden');
  
  // Show player count validation
  const n = room.players.length;
  if (n !== 4 && n !== 6) {
    $('game-info-preview').textContent = `Kaali Teeri needs exactly 4 or 6 players (currently ${n})`;
    $('game-info-preview').style.color = 'var(--red)';
  } else {
    $('game-info-preview').textContent = `${n} players · Kaali Teeri · ${n === 4 ? '13' : '8'} cards each`;
    $('game-info-preview').style.color = 'var(--text2)';
  }
} else {
  // Show rounds selector for Kachu Phul
  document.querySelector('.rounds-selector')?.classList.remove('hidden');
  // ... existing Kachu Phul preview text
}

// Show game type to non-host players
// Add a badge showing current game type to all players
```

Modify `startGame()`:
```javascript
function startGame() {
  if (selectedGameType === 'kaaliTeeri') {
    socket.emit('startGame', { gameType: 'kaaliTeeri' });
    return;
  }
  // ... existing Kachu Phul start logic
  if (!chosenRounds || chosenRounds < 1) { notify('Select rounds first', 'err'); return; }
  socket.emit('startGame', { totalRounds: chosenRounds, gameType: 'kachuPhul' });
}
```

---

### PHASE 4: Client-Side — Kaali Teeri Game Rendering

#### Task 4.1: Create `public/js/kaaliTeeri.js`

This file contains ALL Kaali Teeri-specific rendering functions. It's loaded after `app.js` and uses the same global helpers (`$`, `showScreen`, `notify`, `cardHTML`, `SUIT_SYM`, etc.).

##### Game State Dispatcher

In `app.js`, modify the `socket.on('gameState')` handler:

```javascript
socket.on('gameState', state => {
  hideLoading();
  $('chat-fab').classList.remove('hidden');
  
  if (state.isSpectator) {
    if (state.gameType === 'kaaliTeeri') return renderKTSpectatorState(state);
    renderSpectatorState(state); return;
  }
  
  if (state.gameType === 'kaaliTeeri') {
    currentGameState = state;
    renderKTGameState(state);
    return;
  }
  
  // ... existing Kachu Phul rendering
});
```

##### Main KT Render Function

```javascript
// In kaaliTeeri.js
function renderKTGameState(state) {
  showScreen('game-screen');
  $('spec-badge').classList.add('hidden');
  $('my-hand-section').classList.remove('hidden');
  
  updateKTTopBar(state);
  renderKTSeats(state);
  renderKTInfoPanel(state);
  
  switch (state.phase) {
    case 'bidding':
      renderKTBidding(state);
      break;
    case 'trump_select':
      renderKTTrumpSelect(state);
      break;
    case 'partner_select':
      renderKTPartnerSelect(state);
      break;
    case 'playing':
      renderKTPlaying(state);
      break;
    case 'game_over':
      renderKTGameOver(state);
      break;
  }
  
  renderKTHand(state);
}
```

#### Task 4.2: KT Top Bar

Modify the top bar or add a KT-specific info section. Reuse existing `top-bar` structure but show different info:

```javascript
function updateKTTopBar(state) {
  // Trump suit (if selected)
  if (state.trumpSuit) {
    $('top-trump-sym').textContent = SUIT_SYM[state.trumpSuit];
    $('top-trump-sym').className = `trump-symbol ${SUIT_COLORS[state.trumpSuit]}`;
    $('top-trump-name').textContent = state.trumpSuit.charAt(0).toUpperCase() + state.trumpSuit.slice(1);
  } else {
    $('top-trump-sym').textContent = '?';
    $('top-trump-name').textContent = 'Pending';
  }
  
  // Repurpose round/cards badges for KT info
  $('top-round').textContent = state.winningBid || '—';
  $('top-total-rounds').parentElement.innerHTML = `Bid: <span id="top-round">${state.winningBid || '—'}</span>`;
  $('top-cards').parentElement.innerHTML = `<span>${state.phase}</span>`;
}
```

**Better approach:** Add a KT-specific info bar that overlays/replaces the Kachu Phul one:

```html
<!-- KT INFO BAR (add to index.html, hidden by default) -->
<div class="kt-info-bar hidden" id="kt-info-bar">
  <div class="kt-info-item">
    <span class="kt-info-label">TRUMP</span>
    <span class="kt-info-value" id="kt-trump-display">—</span>
  </div>
  <div class="kt-info-item">
    <span class="kt-info-label">BID</span>
    <span class="kt-info-value" id="kt-bid-display">—</span>
  </div>
  <div class="kt-info-item">
    <span class="kt-info-label">BID WINNER</span>
    <span class="kt-info-value" id="kt-bidwinner-display">—</span>
  </div>
  <div class="kt-info-item">
    <span class="kt-info-label">PARTNER CARD 1</span>
    <span class="kt-info-value" id="kt-partner1-display">—</span>
  </div>
  <div class="kt-info-item kt-6p-only hidden" id="kt-partner2-wrap">
    <span class="kt-info-label">PARTNER CARD 2</span>
    <span class="kt-info-value" id="kt-partner2-display">—</span>
  </div>
</div>
```

#### Task 4.3: KT Bidding UI

Create a bidding overlay for sequential bidding (different from Kachu Phul's simultaneous bid):

```html
<!-- KT BIDDING OVERLAY (add to index.html) -->
<div class="kt-bid-overlay hidden" id="kt-bid-overlay">
  <div class="kt-bid-panel">
    <h2>Bidding</h2>
    <div id="kt-bid-current-info">
      <!-- Shows: Current highest bid, who bid it, whose turn it is -->
    </div>
    <div id="kt-bid-controls" class="hidden">
      <!-- Bid amount slider/buttons + Pass button. Only shown when it's your turn -->
      <div class="kt-bid-amount-row">
        <button onclick="ktChangeBid(-5)">−5</button>
        <span id="kt-bid-amount">150</span>
        <button onclick="ktChangeBid(+5)">+5</button>
      </div>
      <div class="kt-bid-actions">
        <button class="btn btn-gold" onclick="ktSubmitBid()">Bid <span id="kt-bid-submit-amount">150</span></button>
        <button class="btn btn-outline" onclick="ktPassBid()">Pass</button>
      </div>
    </div>
    <div id="kt-bid-waiting" class="hidden">
      <!-- "Waiting for [Player] to bid..." -->
    </div>
    <div id="kt-bid-log" class="kt-bid-log">
      <!-- Scrolling log of all bids/passes -->
    </div>
  </div>
</div>
```

Client-side logic:

```javascript
let ktSelectedBid = 150;

function renderKTBidding(state) {
  $('kt-bid-overlay').classList.remove('hidden');
  
  // Current bid info
  const info = $('kt-bid-current-info');
  if (state.bidding.highestBid > 0) {
    info.innerHTML = `<div class="kt-current-bid">Current Bid: <strong>${state.bidding.highestBid}</strong> by <strong>${state.bidding.highestBidderName}</strong></div>`;
  } else {
    info.innerHTML = `<div class="kt-current-bid">Opening bid: ${MIN_BID}</div>`;
  }
  
  // Is it my turn?
  if (state.bidding.isMyTurnToBid && !state.bidding.myHasPassed) {
    $('kt-bid-controls').classList.remove('hidden');
    $('kt-bid-waiting').classList.add('hidden');
    
    // Set minimum selectable bid
    const minAllowed = Math.max(150, (state.bidding.highestBid || 145) + 5);
    if (ktSelectedBid < minAllowed) ktSelectedBid = minAllowed;
    $('kt-bid-amount').textContent = ktSelectedBid;
    $('kt-bid-submit-amount').textContent = ktSelectedBid;
  } else {
    $('kt-bid-controls').classList.add('hidden');
    $('kt-bid-waiting').classList.remove('hidden');
    
    const currentBidderName = state.players[state.bidding.currentBidder]?.name || '?';
    $('kt-bid-waiting').innerHTML = state.bidding.myHasPassed 
      ? `You passed. Waiting for ${currentBidderName}…`
      : `Waiting for <strong>${currentBidderName}</strong> to bid…`;
  }
  
  // Show who has passed
  // (render as chips/badges under the bid panel)
}

function ktChangeBid(delta) {
  const state = currentGameState;
  const minAllowed = Math.max(150, (state.bidding.highestBid || 145) + 5);
  ktSelectedBid = Math.max(minAllowed, Math.min(250, ktSelectedBid + delta));
  $('kt-bid-amount').textContent = ktSelectedBid;
  $('kt-bid-submit-amount').textContent = ktSelectedBid;
}

function ktSubmitBid() {
  socket.emit('ktBid', { action: 'bid', amount: ktSelectedBid });
}

function ktPassBid() {
  socket.emit('ktBid', { action: 'pass' });
}
```

#### Task 4.4: KT Trump Selection UI

```html
<!-- KT TRUMP SELECT OVERLAY -->
<div class="kt-trump-overlay hidden" id="kt-trump-overlay">
  <div class="kt-trump-panel">
    <h2>Select Trump Suit</h2>
    <p>You won the bid! Choose the trump suit.</p>
    <div class="kt-trump-options">
      <button class="kt-trump-btn" onclick="ktSelectTrump('spades')">♠<br>Spades</button>
      <button class="kt-trump-btn" onclick="ktSelectTrump('diamonds')">♦<br>Diamonds</button>
      <button class="kt-trump-btn" onclick="ktSelectTrump('clubs')">♣<br>Clubs</button>
      <button class="kt-trump-btn" onclick="ktSelectTrump('hearts')">♥<br>Hearts</button>
    </div>
  </div>
</div>
```

Only visible to the bid winner. Others see "Waiting for [BidWinner] to select trump…"

```javascript
function renderKTTrumpSelect(state) {
  if (state.myIndex === state.bidWinnerIndex) {
    $('kt-trump-overlay').classList.remove('hidden');
  } else {
    $('kt-trump-overlay').classList.add('hidden');
    // Show waiting message in a different element or reuse bid panel area
  }
}

function ktSelectTrump(suit) {
  socket.emit('ktSelectTrump', { suit });
  $('kt-trump-overlay').classList.add('hidden');
}
```

#### Task 4.5: KT Partner Card Selection UI

This needs a card picker. The bid winner selects 1 card (4-player) or 2 cards (6-player) from the full deck (excluding their own hand).

```html
<!-- KT PARTNER SELECT OVERLAY -->
<div class="kt-partner-overlay hidden" id="kt-partner-overlay">
  <div class="kt-partner-panel">
    <h2>Choose Partner Card<span id="kt-partner-count-label">s</span></h2>
    <p id="kt-partner-instructions">Select the card(s) whose owner will be your partner.</p>
    <div id="kt-partner-card-grid" class="kt-partner-grid">
      <!-- Populated dynamically with all cards NOT in bid winner's hand -->
    </div>
    <div id="kt-partner-selected">
      <!-- Shows selected card(s) -->
    </div>
    <button class="btn btn-gold" id="kt-partner-confirm" onclick="ktConfirmPartners()" disabled>Confirm Partner Card(s)</button>
  </div>
</div>
```

```javascript
let ktSelectedPartnerCards = [];

function renderKTPartnerSelect(state) {
  if (state.myIndex === state.bidWinnerIndex) {
    $('kt-partner-overlay').classList.remove('hidden');
    const maxPartners = state.playerCount === 4 ? 1 : 2;
    $('kt-partner-count-label').textContent = maxPartners > 1 ? 's' : '';
    $('kt-partner-instructions').textContent = maxPartners === 1 
      ? 'Select the card whose owner will be your partner.'
      : 'Select 2 cards. Their owners will be your partners.';
    
    // Build card grid (all cards NOT in my hand)
    // The bid winner knows their own cards, so show all other possible cards
    // Use suit grouping for easy selection
    const allCardIds = new Set(state.myHand.map(c => c.id));
    const allPossibleCards = [];
    
    const suits = ['spades', 'diamonds', 'clubs', 'hearts'];
    const ranks = state.playerCount === 6 
      ? ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'] // no 2s in 6p
      : ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
    
    for (const suit of suits) {
      for (const rank of ranks) {
        const id = `${rank}_${suit}`;
        if (!allCardIds.has(id)) {
          allPossibleCards.push({ suit, rank, id });
        }
      }
    }
    
    // Render card grid
    $('kt-partner-card-grid').innerHTML = allPossibleCards.map(card => {
      const selected = ktSelectedPartnerCards.includes(card.id);
      return `<div class="kt-partner-card-option ${selected ? 'selected' : ''}" onclick="ktTogglePartnerCard('${card.id}')">
        ${cardHTML(card, 'size-sm', state.trumpSuit, false, false)}
      </div>`;
    }).join('');
    
    // Update confirm button
    $('kt-partner-confirm').disabled = ktSelectedPartnerCards.length !== maxPartners;
  } else {
    $('kt-partner-overlay').classList.add('hidden');
    // Show waiting message
  }
}

function ktTogglePartnerCard(cardId) {
  const state = currentGameState;
  const maxPartners = state.playerCount === 4 ? 1 : 2;
  
  if (ktSelectedPartnerCards.includes(cardId)) {
    ktSelectedPartnerCards = ktSelectedPartnerCards.filter(id => id !== cardId);
  } else {
    if (ktSelectedPartnerCards.length >= maxPartners) {
      // Replace last selected
      ktSelectedPartnerCards.pop();
    }
    ktSelectedPartnerCards.push(cardId);
  }
  renderKTPartnerSelect(state);
}

function ktConfirmPartners() {
  socket.emit('ktSelectPartners', { partnerCards: ktSelectedPartnerCards });
  $('kt-partner-overlay').classList.add('hidden');
  ktSelectedPartnerCards = [];
}
```

#### Task 4.6: KT Playing Phase — Trick Rendering

Reuse the existing `trick-cards` area and hand rendering, but adapt:

```javascript
function renderKTPlaying(state) {
  // Hide all KT overlays
  ['kt-bid-overlay', 'kt-trump-overlay', 'kt-partner-overlay'].forEach(id => $(id)?.classList.add('hidden'));
  
  // Render trick area (reuse existing trick-cards element)
  renderKTTrick(state);
  renderKTTurnIndicator(state);
}

function renderKTTrick(state) {
  // Very similar to existing renderTrick() but uses KT state
  const el = $('trick-cards');
  const po = state.playerOrder;
  const leaderIdx = po.indexOf(state.currentLeader);
  
  const handOrder = [];
  for (let i = 0; i < state.players.length; i++) {
    handOrder.push(po[(leaderIdx + i) % po.length]);
  }
  
  let html = '';
  for (let i = 0; i < state.players.length; i++) {
    const pIdx = handOrder[i];
    const playerName = state.players[pIdx]?.name || '?';
    const played = state.currentTrick.find(t => t.playerIndex === pIdx);
    
    if (played) {
      html += `<div class="trick-card-slot" data-player="${pIdx}">
        <div class="trick-player-name">${playerName}</div>
        ${cardHTML(played.card, 'size-md', state.trumpSuit, false, false)}
      </div>`;
    } else {
      html += `<div class="trick-card-slot" data-player="${pIdx}">
        <div class="card-empty"></div>
        <div class="trick-player-name">${playerName}</div>
      </div>`;
    }
  }
  el.innerHTML = html;
  
  const st = $('trick-status');
  st.textContent = state.leadSuit ? `Lead: ${SUIT_SYM[state.leadSuit]} ${state.leadSuit}` : '';
}
```

#### Task 4.7: KT Seat Rendering — Bid Winner & Partner Highlights

The seat rendering needs to show:
- **Bid winner highlight** (gold border/glow)
- **Revealed partner highlight** (same gold treatment)
- **Unrevealed partners** look like normal players

```javascript
function renderKTSeats(state) {
  // Reuse existing seat layout logic but with KT-specific decorations
  const myIdx = isSpectator ? -1 : myPlayerIndex;
  const po = state.playerOrder;
  
  // Use existing renderSeats layout algorithm but replace seatHTML with ktSeatHTML
  // ... (reuse the existing seats-container layout logic from renderSeats())
  
  // The key difference is in the individual seat:
}

function ktSeatHTML(state, pIdx, myIdx) {
  const p = state.players[pIdx];
  const isMine = pIdx === myIdx;
  const isTurn = state.currentTurnIndex === pIdx;
  const isBidWinner = p.isBidWinner;
  const isRevealed = p.isRevealed;
  const isOffline = !p.connected;
  
  const cls = [
    'seat',
    isMine ? 'my-seat' : '',
    isTurn ? 'current-turn' : '',
    isOffline ? 'disconnected' : '',
    isBidWinner ? 'kt-bid-winner' : '',      // ← NEW CSS class
    isRevealed ? 'kt-partner-revealed' : '',  // ← NEW CSS class
  ].filter(Boolean).join(' ');
  
  // Meta info
  let meta = '';
  if (isBidWinner) meta += `<span class="kt-badge kt-badge-bidwinner">★ Bid Winner</span>`;
  if (isRevealed) meta += `<span class="kt-badge kt-badge-partner">🤝 Partner</span>`;
  meta += `<span class="m-score">${p.wonCardCount || 0} cards won</span>`;
  
  return `<div class="${cls}">
    <div class="seat-avatar ${AVATAR_COLS[pIdx % 7]}">${p.name[0].toUpperCase()}${isTurn ? '<div class="turn-dot"></div>' : ''}</div>
    <div class="seat-info">
      <div class="seat-name">${p.name}${isMine ? ' ★' : ''}${p.isHost ? ' ♛' : ''}</div>
      <div class="seat-meta">${meta}</div>
    </div>
  </div>`;
}
```

#### Task 4.8: KT Persistent Info Panel

Always visible during gameplay, showing key game info:

```javascript
function renderKTInfoPanel(state) {
  $('kt-info-bar').classList.remove('hidden');
  
  // Trump
  if (state.trumpSuit) {
    $('kt-trump-display').innerHTML = `<span class="${SUIT_COLORS[state.trumpSuit]}">${SUIT_SYM[state.trumpSuit]}</span> ${state.trumpSuit}`;
  }
  
  // Bid
  $('kt-bid-display').textContent = state.winningBid || '—';
  
  // Bid winner
  $('kt-bidwinner-display').textContent = state.bidWinnerName || '—';
  
  // Partner cards
  if (state.partnerCards.length > 0) {
    const [rank1, suit1] = parseCardId(state.partnerCards[0]);
    $('kt-partner1-display').innerHTML = `<span class="${SUIT_COLORS[suit1]}">${rank1}${SUIT_SYM[suit1]}</span>`;
    
    if (state.partnerCards.length > 1) {
      $('kt-partner2-wrap').classList.remove('hidden');
      const [rank2, suit2] = parseCardId(state.partnerCards[1]);
      $('kt-partner2-display').innerHTML = `<span class="${SUIT_COLORS[suit2]}">${rank2}${SUIT_SYM[suit2]}</span>`;
    }
  }
}

function parseCardId(cardId) {
  const parts = cardId.split('_');
  return [parts[0], parts[1]]; // [rank, suit]
}
```

#### Task 4.9: KT Partner Reveal Event Handler

```javascript
// In app.js socket handlers:
socket.on('ktPartnerRevealed', ({ partnerPlayerName, bidWinnerPlayerName, partnerCardId }) => {
  // Show notification banner
  notify(`${partnerPlayerName} is partner of ${bidWinnerPlayerName}!`, 'win');
  
  // Show a more prominent reveal animation
  showKTPartnerReveal(partnerPlayerName, bidWinnerPlayerName);
});

// In kaaliTeeri.js:
function showKTPartnerReveal(partnerName, bidWinnerName) {
  const el = document.createElement('div');
  el.className = 'kt-partner-reveal-banner';
  el.innerHTML = `<div class="kt-partner-reveal-inner">
    <div class="kt-partner-reveal-text">🤝 <strong>${partnerName}</strong> is partner of <strong>${bidWinnerName}</strong></div>
  </div>`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}
```

#### Task 4.10: KT Game Over Display

```html
<!-- KT GAME OVER OVERLAY (add to index.html) -->
<div class="kt-game-over-overlay hidden" id="kt-game-over-overlay">
  <div class="kt-game-over-panel">
    <h1 id="kt-winner-title">Game Over!</h1>
    <div class="kt-result-summary" id="kt-result-summary"></div>
    <div class="kt-score-breakdown" id="kt-score-breakdown"></div>
    <div id="kt-play-again-votes" class="play-again-votes"></div>
    <div style="display:flex;gap:.6rem;margin-top:.8rem;">
      <button class="btn btn-gold" style="flex:1;" onclick="votePlayAgain()">Play Again</button>
      <button class="btn btn-outline" style="flex:1" onclick="doEndGame()">Menu</button>
    </div>
  </div>
</div>
```

```javascript
function renderKTGameOver(state) {
  const result = state.result;
  if (!result) return;
  
  $('kt-game-over-overlay').classList.remove('hidden');
  
  // Title
  if (result.winningTeam === 'bidWinner') {
    $('kt-winner-title').textContent = `${result.bidWinner.name}'s Team Wins! 🎉`;
  } else {
    $('kt-winner-title').textContent = 'Defender Team Wins! 🛡️';
  }
  
  // Summary
  $('kt-result-summary').innerHTML = `
    <div class="kt-result-row">
      <span>Winning Bid</span>
      <strong>${result.winningBid}</strong>
    </div>
    <div class="kt-result-row">
      <span>Bid Winner's Team Points</span>
      <strong>${result.bidWinnerTeamPoints}</strong>
    </div>
    <div class="kt-result-row">
      <span>Defender Team Points</span>
      <strong>${result.defenderTeamPoints}</strong>
    </div>
    <div class="kt-result-row">
      <span>Bid Winner</span>
      <strong>${result.bidWinner.name}</strong>
    </div>
    <div class="kt-result-row">
      <span>Partner(s)</span>
      <strong>${result.partners.map(p => p.name).join(', ') || 'None revealed'}</strong>
    </div>
  `;
  
  // Per-player breakdown
  $('kt-score-breakdown').innerHTML = `
    <h3>Player Breakdown</h3>
    <div class="kt-player-scores">
      ${Object.values(result.playerScores).map(ps => `
        <div class="kt-player-score-row ${ps.team === 'bidWinner' ? 'kt-team-bidwinner' : 'kt-team-defender'}">
          <span class="kt-ps-name">${ps.name}</span>
          <span class="kt-ps-cards">${ps.wonCardCount} cards</span>
          <span class="kt-ps-points">${ps.points} pts</span>
          <span class="kt-ps-team">${ps.team === 'bidWinner' ? '★' : '🛡️'}</span>
        </div>
      `).join('')}
    </div>
  `;
}
```

#### Task 4.11: KT Trick Won Event

```javascript
// In app.js socket handlers:
socket.on('ktTrickWon', ({ winnerName, winnerIndex, trick }) => {
  // Similar to existing trickWon handler
  trickWinData = { winnerIndex, trick };
  if (currentGameState) renderKTTrick(currentGameState);
  
  // Show trick won banner
  showTrickWonBanner(winnerName);
  
  setTimeout(() => { trickWinData = null; }, 2200);
});
```

---

### PHASE 5: CSS Styling

#### Task 5.1: Add KT-Specific Styles to `style.css`

Add the following CSS classes. These should match the existing design language (dark theme, gold accents, `var(--gold)`, `var(--bg3)`, `var(--border)`, `var(--text2)`, etc.):

```css
/* ─── GAME TYPE SELECTOR ──────────────────────── */
.game-type-label { /* matches .rounds-label style */ }
.game-type-options { display: flex; gap: .6rem; }
.game-type-btn { /* card-like button, matches .preset-btn but larger */ }
.game-type-btn.active { border-color: var(--gold); background: rgba(240,192,64,.12); }
.game-type-icon { font-size: 1.3rem; }
.game-type-name { font-weight: 700; }
.game-type-desc { font-size: .72rem; color: var(--text2); }

/* ─── KT INFO BAR ─────────────────────────────── */
.kt-info-bar { /* horizontal bar below top-bar */ }
.kt-info-item { /* inline badge-like items */ }
.kt-info-label { font-size: .62rem; text-transform: uppercase; color: var(--text2); }
.kt-info-value { font-weight: 700; }

/* ─── KT BID WINNER / PARTNER HIGHLIGHTS ──────── */
.seat.kt-bid-winner {
  border-color: var(--gold);
  box-shadow: 0 0 12px rgba(240, 192, 64, 0.3);
}
.seat.kt-partner-revealed {
  border-color: var(--gold);
  box-shadow: 0 0 12px rgba(240, 192, 64, 0.3);
}
.kt-badge {
  font-size: .65rem;
  padding: .1rem .4rem;
  border-radius: 4px;
  font-weight: 700;
}
.kt-badge-bidwinner {
  background: rgba(240, 192, 64, .2);
  color: var(--gold);
}
.kt-badge-partner {
  background: rgba(240, 192, 64, .2);
  color: var(--gold);
}

/* ─── KT BIDDING PANEL ────────────────────────── */
.kt-bid-overlay { /* matches existing .bid-overlay pattern */ }
.kt-bid-panel { /* matches existing .bid-panel */ }
.kt-bid-amount-row { display: flex; align-items: center; gap: 1rem; justify-content: center; }
.kt-bid-log { max-height: 150px; overflow-y: auto; }

/* ─── KT TRUMP SELECT ────────────────────────── */
.kt-trump-overlay { /* same overlay pattern */ }
.kt-trump-options { display: grid; grid-template-columns: 1fr 1fr; gap: .6rem; }
.kt-trump-btn { /* large suit buttons with suit colors */ }

/* ─── KT PARTNER SELECT ──────────────────────── */
.kt-partner-overlay { /* same overlay pattern */ }
.kt-partner-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(50px, 1fr)); gap: .3rem; }
.kt-partner-card-option.selected { border: 2px solid var(--gold); }

/* ─── KT PARTNER REVEAL BANNER ───────────────── */
.kt-partner-reveal-banner {
  position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
  z-index: 2000; animation: ktRevealPop .4s ease-out;
}
@keyframes ktRevealPop { from { transform: translate(-50%, -50%) scale(0.5); opacity: 0; } to { transform: translate(-50%, -50%) scale(1); opacity: 1; } }

/* ─── KT GAME OVER ───────────────────────────── */
.kt-game-over-overlay { /* matches existing .game-over-overlay */ }
.kt-result-row { display: flex; justify-content: space-between; padding: .3rem 0; }
.kt-team-bidwinner { border-left: 3px solid var(--gold); }
.kt-team-defender { border-left: 3px solid var(--text2); }
```

---

### PHASE 6: Reconnection & State Recovery

#### Task 6.1: Handle Rejoin for Kaali Teeri Games

The existing `rejoinRoom` handler already sends `gameState` to reconnecting players. Since `buildPlayerState` for KT returns all necessary state, reconnection should work if:

1. The `broadcastGameState` dispatch correctly uses the KT builder.
2. The client detects `state.gameType === 'kaaliTeeri'` and renders accordingly.

Ensure `kaaliTeeri.buildPlayerState()` includes ALL information needed to reconstruct the UI from scratch:
- Current phase
- Hand
- Trick in progress
- All bidding history
- Trump
- Partner cards (the card IDs, not owners)
- Revealed partners
- Bid winner
- Current turn

This is already covered by the `buildPlayerState` design in Task 2.8.

#### Task 6.2: Handle Player Disconnect During KT Game

If a player disconnects during:
- **Bidding**: Their turn is skipped (auto-pass) after a timeout, or wait for reconnect.
- **Trump/Partner selection**: If the bid winner disconnects, wait for reconnect (can't auto-select).
- **Playing**: Their turn is skipped after a timeout, or wait for reconnect.

**Decision for implementer:** The simplest approach is to wait for reconnect (consistent with existing Kachu Phul behavior where disconnected players just hold up the game until they reconnect or are vote-kicked). The existing vote-kick system already handles removing offline players.

If a player is kicked during KT, the game may need special handling:
- If the kicked player is the bid winner → game should end (cannot continue without bid winner).
- If the kicked player is a partner → partner's won cards stay as-is, game continues.
- If a defender is kicked → game continues.

**Recommendation:** For V1, if any player is removed from a KT game, end the game immediately and return to lobby. KT is a team game and removing a player fundamentally changes the game dynamics. This is simpler and avoids complex edge cases.

---

### PHASE 7: index.html Updates

#### Task 7.1: Add KT Script Tag

```html
<script src="/js/app.js"></script>
<script src="/js/kaaliTeeri.js"></script>  <!-- NEW -->
```

#### Task 7.2: Add KT-Specific HTML Elements

Add these elements to `index.html` (after the existing overlays, before the loading screen):

1. `kt-info-bar` — persistent game info (see Task 4.2)
2. `kt-bid-overlay` — bidding UI (see Task 4.3)
3. `kt-trump-overlay` — trump selection (see Task 4.4)
4. `kt-partner-overlay` — partner card selection (see Task 4.5)
5. `kt-game-over-overlay` — game results (see Task 4.10)
6. Game type selector in waiting room (see Task 3.1)

#### Task 7.3: Update Page Title/Meta (Optional)

Update `<title>` to something like "Kachu Phul — Card Games" since it's now a multi-game platform. Or keep as-is per "do not change the existing home page" rule.

---

## File Change Summary

| File | Action | What Changes |
|---|---|---|
| `server.js` | **MODIFY** | Add `gameType` to room, add `selectGameType` socket event, modify `startGame` to dispatch by game type, modify `broadcastGameState` to dispatch, add KT-specific socket events (`ktBid`, `ktSelectTrump`, `ktSelectPartners`, `ktPlayCard`), require game modules. Extract Kachu Phul helpers into module. |
| `games/gameRegistry.js` | **NEW** | Game type definitions and metadata |
| `games/kachuPhul.js` | **NEW** | Extracted Kachu Phul game logic (moved from server.js) |
| `games/kaaliTeeri.js` | **NEW** | Complete Kaali Teeri game logic: deck, dealing, bidding, trump, partners, trick-taking, scoring, state building |
| `public/index.html` | **MODIFY** | Add game type selector in waiting room, add KT overlays (bid, trump, partner select, game over, info bar), add KT script tag |
| `public/js/app.js` | **MODIFY** | Add game-type dispatching in `renderGameState`, `startGame`, `renderWaitingRoom`. Add KT socket event handlers. Store `selectedGameType`. |
| `public/js/kaaliTeeri.js` | **NEW** | All KT-specific client rendering: bidding UI, trump select, partner select, trick rendering, seat rendering with highlights, game over, partner reveal animation, persistent info panel |
| `public/css/style.css` | **MODIFY** | Add KT-specific CSS classes (game type selector, info bar, bid winner/partner highlights, overlays, partner reveal animation, game over styling) |

---

## Verification Plan

### Automated Tests

No existing test framework is present. For the implementer:

1. **Manual server-side validation test:** Create a test script (`test-kt.js`) that simulates a 4-player and 6-player game by directly calling the game logic functions and verifying:
   - Deck size: 52 for 4p, 48 for 6p
   - Cards per player: 13 for 4p, 8 for 6p
   - Point calculation: total points = 250 for both modes
   - Bidding validation: rejects bids < 150, non-multiples of 5, bids <= current highest
   - Partner card validation: rejects bid winner's own cards
   - Trick winner calculation: trump beats lead suit, lead suit beats off-suit
   - Team score calculation: won cards assigned to trick winner, not original owner
   - Win condition: bidWinnerTeamPoints >= winningBid → bidWinner wins

### Manual Verification

1. **4-Player Game Flow:**
   - Create room → select Kaali Teeri → add 4 players → start game
   - Verify 13 cards dealt to each
   - Complete bidding → verify bid winner determined
   - Select trump → verify displayed to all
   - Select 1 partner card → verify hidden until played
   - Play tricks → verify partner revealed when partner card played
   - Complete all tricks → verify scoring and win/loss

2. **6-Player Game Flow:**
   - Same as above but with 6 players
   - Verify 8 cards each, no 2s in deck
   - Select 2 partner cards → verify both can be from same player
   - Verify each partner revealed independently

3. **Edge Cases:**
   - Try starting KT with 3 or 5 players → should show error
   - Try bidding out of turn → should be rejected
   - Try playing wrong suit when you have lead suit → should be rejected
   - Disconnect and reconnect → should restore full game state
   - Bid winner team gets exactly the bid amount → should win
   - Bid winner team gets 1 less than bid → defenders win

4. **UI Verification:**
   - Game type selector visible in lobby for host only
   - All KT overlays show/hide at correct phases
   - Bid winner golden highlight visible
   - Partner highlight appears on reveal
   - Trump and partner cards visible throughout game
   - Existing Kachu Phul game still works unchanged after refactor

---

## Implementation Order (Recommended)

1. **Phase 1** (Server refactoring) — most critical, highest risk
2. **Phase 2** (KT server logic) — can be developed in parallel with Phase 3
3. **Phase 3** (Lobby game selection)
4. **Phase 4** (KT client rendering) — largest effort
5. **Phase 5** (CSS)
6. **Phase 6** (Reconnection)
7. **Phase 7** (HTML updates) — done incrementally alongside Phase 4

**Total estimated scope:** ~1500-2000 lines of new code across all files, ~200 lines of modifications to existing files.

---

## Critical Reminders for Implementer

1. **DO NOT touch the login page or home page.** Zero changes to `#home-screen` or auth flow.
2. **DO NOT redesign the existing UI.** Match existing patterns for every new element.
3. **Keep card POINTS separate from card RANK.** `getCardPoints()` for scoring, `RANK_ORDER` for trick comparison. Never mix these.
4. **Partner identity is SECRET until the card is played.** The server must never send `partnerOwners` to clients. Only `revealedPartners[]` is sent.
5. **Server is the source of truth.** All validation happens server-side. Client validation is only for UX.
6. **Won cards belong to the trick winner, not the original card owner.** This is fundamental to scoring.
7. **Existing Kachu Phul must continue working identically.** Test both games after implementation.
8. **Bidding is SEQUENTIAL in KT** (one at a time, clockwise), NOT simultaneous like Kachu Phul.
9. **6-player games remove all four 2s** from the deck before dealing.
10. **Both requested partner cards can belong to the same player** — do not assume 2 cards = 2 different partners.
