// games/kaaliTeeri.js
// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const SUITS = ['spades', 'diamonds', 'clubs', 'hearts'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

// Card POINT values — used ONLY for scoring, never for trick comparison
function getCardPoints(card) {
  if (card.rank === '3' && card.suit === 'spades') return 30; // Kaali Teeri = 30 pts
  if (card.rank === '5') return 5;                             // all 5s = 5 pts
  if (['10', 'J', 'Q', 'K', 'A'].includes(card.rank)) return 10; // face/ten = 10 pts
  return 0;
}
// Total deck points = 30 + (4×5) + (4×5×10) = 30 + 20 + 200 = 250

// Card RANK values — used ONLY for trick comparison, never for scoring
const RANK_ORDER = {
  '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7,
  '8': 8, '9': 9, '10': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14,
};

const MIN_BID = 150;
const MAX_BID = 250;
const BID_INCREMENT = 5;

const PHASES = {
  WAITING: 'waiting',
  DEALING: 'dealing',
  BIDDING: 'bidding',
  TRUMP_SELECT: 'trump_select',
  PARTNER_SELECT: 'partner_select',
  PLAYING: 'playing',
  SCORING: 'scoring',
  GAME_OVER: 'game_over',
};

// ─── DECK & DEAL ──────────────────────────────────────────────────────────────
function createDeck(playerCount) {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      if (playerCount === 6 && rank === '2') continue; // 6 players: remove 2s
      deck.push({ suit, rank, id: `${rank}_${suit}` });
    }
  }
  return deck;
}

function shuffle(d) {
  const a = [...d];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function dealCards(playerCount) {
  const deck = shuffle(createDeck(playerCount));
  const cardsPerPlayer = playerCount === 4 ? 13 : 8;
  const hands = {};
  for (let i = 0; i < playerCount; i++) {
    hands[i] = deck.slice(i * cardsPerPlayer, (i + 1) * cardsPerPlayer);
  }
  return hands;
}

// ─── VALIDATION ───────────────────────────────────────────────────────────────
function validateStart(room) {
  const count = room.players.filter(p => p.connected).length;
  if (count !== 4 && count !== 6) {
    return 'Kaali Teeri requires exactly 4 or 6 players';
  }
  return null;
}

// ─── INIT GAME ────────────────────────────────────────────────────────────────
function initGame(room, io, broadcastGameState) {
  const playerCount = room.players.length;

  // Shuffle player order
  const indices = room.players.map((_, i) => i);
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }

  room.playerOrder = indices;
  room.gameType = 'kaaliTeeri';

  // Initialize Kaali Teeri state
  room.kt = {
    phase: PHASES.BIDDING,
    playerCount,

    // Bidding
    currentBidderIndex: 0,       // index into biddingOrder
    highestBid: 0,
    highestBidder: null,
    bidPassed: {},               // playerIndex → true if passed
    biddingOrder: [...indices],  // bid order follows player order

    // Trump
    trumpSuit: null,

    // Partners
    partnerCards: [],             // card IDs selected as partner cards
    partnerOwners: {},            // cardId → playerIndex (SERVER ONLY, never sent to clients)
    revealedPartners: [],         // [{ playerIndex, cardId }] — only when card is played
    partnerPlayerIndices: [],     // actual partner player indices (server only until revealed)
    bidWinnerIndex: null,

    // Trick-taking
    currentTrick: [],
    currentLeader: null,
    leadSuit: null,
    tricksPlayed: 0,

    // Won cards (for scoring)
    wonCards: {},                 // playerIndex → array of won cards

    // Teams (server only until game over)
    bidWinnerTeam: [],
    defenderTeam: [],

    // Result
    result: null,
  };

  // Deal cards
  room.hands = dealCards(playerCount);

  // Initialize won cards storage
  for (let i = 0; i < playerCount; i++) {
    room.kt.wonCards[i] = [];
  }

  room.state = 'playing'; // generic room state for platform layer
  broadcastGameState(room);
}

// ─── BIDDING ──────────────────────────────────────────────────────────────────
function advanceBidder(kt) {
  let next = (kt.currentBidderIndex + 1) % kt.biddingOrder.length;
  let attempts = 0;
  while (kt.bidPassed[kt.biddingOrder[next]] && attempts < kt.biddingOrder.length) {
    next = (next + 1) % kt.biddingOrder.length;
    attempts++;
  }
  kt.currentBidderIndex = next;
}

function handleBid(room, playerIndex, { action, amount }, io, broadcastGameState) {
  const kt = room.kt;
  if (kt.phase !== PHASES.BIDDING) return 'Not in bidding phase';

  const expectedBidder = kt.biddingOrder[kt.currentBidderIndex];
  if (playerIndex !== expectedBidder) return 'Not your turn to bid';

  if (action === 'pass') {
    kt.bidPassed[playerIndex] = true;

    const activeBidders = kt.biddingOrder.filter(i => !kt.bidPassed[i]);

    if (activeBidders.length === 1) {
      kt.bidWinnerIndex = activeBidders[0];
      // If nobody actually bid, force last player to bid MIN_BID
      if (kt.highestBid === 0) {
        kt.highestBid = MIN_BID;
        kt.highestBidder = kt.bidWinnerIndex;
      }
      kt.phase = PHASES.TRUMP_SELECT;
      broadcastGameState(room);
      return null;
    }

    advanceBidder(kt);
    broadcastGameState(room);
    return null;
  }

  if (action === 'bid') {
    if (typeof amount !== 'number') return 'Invalid bid';
    if (amount % BID_INCREMENT !== 0) return `Bid must be in increments of ${BID_INCREMENT}`;
    if (amount < MIN_BID) return `Minimum bid is ${MIN_BID}`;
    if (amount > MAX_BID) return `Maximum bid is ${MAX_BID}`;
    if (kt.highestBid > 0 && amount <= kt.highestBid) return `Must bid higher than ${kt.highestBid}`;

    kt.highestBid = amount;
    kt.highestBidder = playerIndex;

    // Max bid — bidding ends immediately
    if (amount >= MAX_BID) {
      kt.bidWinnerIndex = playerIndex;
      kt.phase = PHASES.TRUMP_SELECT;
      broadcastGameState(room);
      return null;
    }

    advanceBidder(kt);
    broadcastGameState(room);
    return null;
  }

  return 'Invalid action';
}

// ─── TRUMP SELECTION ──────────────────────────────────────────────────────────
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

// ─── PARTNER SELECTION ────────────────────────────────────────────────────────
function handlePartnerSelect(room, playerIndex, { partnerCards }, io, broadcastGameState) {
  const kt = room.kt;
  if (kt.phase !== PHASES.PARTNER_SELECT) return 'Not in partner selection phase';
  if (playerIndex !== kt.bidWinnerIndex) return 'Only the bid winner can select partner cards';

  const expectedCount = kt.playerCount === 4 ? 1 : 2;
  if (!Array.isArray(partnerCards) || partnerCards.length !== expectedCount) {
    return `Must select exactly ${expectedCount} partner card(s)`;
  }

  for (const cardId of partnerCards) {
    const inBidWinnerHand = room.hands[kt.bidWinnerIndex].some(c => c.id === cardId);
    if (inBidWinnerHand) return 'Cannot select a card from your own hand as partner card';

    let found = false;
    for (let i = 0; i < kt.playerCount; i++) {
      if (room.hands[i].some(c => c.id === cardId)) { found = true; break; }
    }
    if (!found) return `Card ${cardId} not found in any player's hand`;
  }

  kt.partnerCards = partnerCards;

  // Track who owns partner cards — SERVER ONLY, never sent to clients
  kt.partnerOwners = {};
  for (const cardId of partnerCards) {
    for (let i = 0; i < kt.playerCount; i++) {
      if (room.hands[i].some(c => c.id === cardId)) {
        kt.partnerOwners[cardId] = i;
        break;
      }
    }
  }

  // Determine partner player indices (server only, never revealed until card played)
  const partnerSet = new Set(Object.values(kt.partnerOwners));
  partnerSet.delete(kt.bidWinnerIndex);
  kt.partnerPlayerIndices = [...partnerSet];

  // Build teams server-side
  kt.bidWinnerTeam = [kt.bidWinnerIndex, ...kt.partnerPlayerIndices];
  kt.defenderTeam = [];
  for (let i = 0; i < kt.playerCount; i++) {
    if (!kt.bidWinnerTeam.includes(i)) kt.defenderTeam.push(i);
  }

  // Start playing — bid winner leads first trick
  kt.phase = PHASES.PLAYING;
  kt.currentLeader = kt.bidWinnerIndex;
  broadcastGameState(room);
  return null;
}

// ─── TRICK COMPARISON ─────────────────────────────────────────────────────────
function trickCompareValue(card, leadSuit, trumpSuit) {
  if (card.suit === trumpSuit) return 1000 + RANK_ORDER[card.rank];
  if (card.suit === leadSuit) return RANK_ORDER[card.rank];
  return 0; // off-suit non-trump — cannot win
}

// ─── GET CURRENT TURN ─────────────────────────────────────────────────────────
function getCurrentTurn(room) {
  const kt = room.kt;
  if (!kt || kt.phase !== PHASES.PLAYING) return null;

  const leaderPos = room.playerOrder.indexOf(kt.currentLeader);
  const trickPos = kt.currentTrick.length;
  return room.playerOrder[(leaderPos + trickPos) % room.playerOrder.length];
}

// ─── PLAY CARD ────────────────────────────────────────────────────────────────
function handlePlayCard(room, playerIndex, { cardId }, io, broadcastGameState) {
  const kt = room.kt;
  if (kt.phase !== PHASES.PLAYING) return 'Not in playing phase';

  const expectedTurn = getCurrentTurn(room);
  if (playerIndex !== expectedTurn) return 'Not your turn';

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

  // Set lead suit on first card
  if (kt.currentTrick.length === 0) {
    kt.leadSuit = card.suit;
  }

  hand.splice(cardIdx, 1);
  kt.currentTrick.push({ playerIndex, card });

  // *** PARTNER REVEAL CHECK ***
  if (kt.partnerCards.includes(cardId)) {
    kt.revealedPartners.push({ playerIndex, cardId });

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

// ─── TRICK RESOLUTION ────────────────────────────────────────────────────────
function resolveTrick(room, io, broadcastGameState) {
  const kt = room.kt;

  // Find winner
  let bestIdx = 0;
  let bestVal = trickCompareValue(kt.currentTrick[0].card, kt.leadSuit, kt.trumpSuit);
  for (let i = 1; i < kt.currentTrick.length; i++) {
    const val = trickCompareValue(kt.currentTrick[i].card, kt.leadSuit, kt.trumpSuit);
    if (val > bestVal) { bestVal = val; bestIdx = i; }
  }

  const winnerPlayerIndex = kt.currentTrick[bestIdx].playerIndex;

  // All cards in this trick go to the winner's won-cards pile
  for (const entry of kt.currentTrick) {
    kt.wonCards[winnerPlayerIndex].push(entry.card);
  }

  io.to(room.id).emit('ktTrickWon', {
    winnerIndex: winnerPlayerIndex,
    winnerName: room.players[winnerPlayerIndex].name,
    trick: [...kt.currentTrick],
  });

  kt.tricksPlayed++;

  setTimeout(() => {
    kt.currentTrick = [];
    kt.leadSuit = null;
    kt.currentLeader = winnerPlayerIndex;

    const cardsLeft = Object.values(room.hands).reduce((sum, h) => sum + h.length, 0);
    if (cardsLeft === 0) {
      setTimeout(() => endGame(room, io, broadcastGameState), 1500);
    } else {
      broadcastGameState(room);
    }
  }, 2000);
}

// ─── SCORING & GAME OVER ──────────────────────────────────────────────────────
function calculateTeamPoints(room, teamIndices) {
  let total = 0;
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

  const bidWinnerTeamPoints = calculateTeamPoints(room, kt.bidWinnerTeam);
  const defenderTeamPoints = calculateTeamPoints(room, kt.defenderTeam);
  const bidWinnerTeamWins = bidWinnerTeamPoints >= kt.highestBid;

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
    playerScores: {},
  };

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
  kt.result = result;
  room.playAgainVotes = new Set();

  io.to(room.id).emit('ktGameOver', result);
  broadcastGameState(room);
}

// ─── BUILD PLAYER STATE ───────────────────────────────────────────────────────
function buildPlayerState(room, playerIndex) {
  const kt = room.kt;

  return {
    roomId: room.id,
    gameType: 'kaaliTeeri',
    state: room.state,
    phase: kt.phase,
    playerCount: kt.playerCount,

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

    myIndex: playerIndex,
    myHand: room.hands[playerIndex] || [],

    bidding: {
      currentBidder: kt.biddingOrder[kt.currentBidderIndex],
      highestBid: kt.highestBid,
      highestBidder: kt.highestBidder,
      highestBidderName: kt.highestBidder !== null ? room.players[kt.highestBidder]?.name : null,
      passed: { ...kt.bidPassed },
      isMyTurnToBid: kt.phase === PHASES.BIDDING && kt.biddingOrder[kt.currentBidderIndex] === playerIndex,
      myHasPassed: !!kt.bidPassed[playerIndex],
    },

    trumpSuit: kt.trumpSuit,

    // Partner info — only what clients are allowed to see
    partnerCards: kt.partnerCards,        // everyone sees which card IDs were requested (once set)
    revealedPartners: kt.revealedPartners, // only actually revealed ones
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

    spectatorCount: (room.spectators || []).length,

    playAgainVotes: room.playAgainVotes
      ? [...room.playAgainVotes].map(i => room.players[i]?.name).filter(Boolean)
      : [],
  };
}

// ─── BUILD SPECTATOR STATE ────────────────────────────────────────────────────
function buildSpectatorState(room) {
  const state = buildPlayerState(room, -1);
  state.myHand = [];
  state.myIndex = -1;
  state.isSpectator = true;
  state.allHands = {};
  room.players.forEach((_, i) => { state.allHands[i] = room.hands[i] || []; });
  return state;
}

module.exports = {
  validateStart,
  initGame,
  handleBid,
  handleTrumpSelect,
  handlePartnerSelect,
  handlePlayCard,
  buildPlayerState,
  buildSpectatorState,
  getCurrentTurn,
};
