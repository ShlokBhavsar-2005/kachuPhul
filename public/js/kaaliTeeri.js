// ═══════════════════════════════════════════════════════════════════════════════
// public/js/kaaliTeeri.js  — Kaali Teeri client-side rendering
// Depends on: app.js (loaded first) — uses $, notify, showScreen, cardHTML,
//             SUIT_SYM, SUIT_COLORS, AVATAR_COLS, socket, myPlayerIndex,
//             isSpectator, trickWinData, showTrickWonBanner
// ═══════════════════════════════════════════════════════════════════════════════

const KT_MIN_BID = 150;
const KT_MAX_BID = 250;

let ktSelectedBid = 150;
let ktSelectedPartnerCards = [];
let ktBidLog = []; // local log of bid actions for display
let ktActiveSuitTab = 'spades'; // for partner selection UI

// ─── MAIN RENDER DISPATCHER ───────────────────────────────────────────────────
function renderKTGameState(state) {
  showScreen('game-screen');
  $('spec-badge').classList.add('hidden');
  $('my-hand-section').classList.remove('hidden');

  // Hide KP-specific UI that might be leftover
  ['arrange-banner', 'bid-overlay', 'confirm-banner', 'round-end-overlay'].forEach(id => $(id)?.classList.add('hidden'));

  // Show KT info bar
  $('kt-info-bar').classList.remove('hidden');

  updateKTTopBar(state);
  renderKTInfoPanel(state);
  renderKTSeats(state);

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
    case 'scoring':
    case 'game_over':
      renderKTGameOver(state);
      break;
  }

  renderKTHand(state);
}

// ─── SPECTATOR ────────────────────────────────────────────────────────────────
function renderKTSpectatorState(state) {
  showScreen('game-screen');
  $('spec-badge').classList.remove('hidden');
  $('my-hand-section').classList.add('hidden');
  ['arrange-banner', 'bid-overlay', 'confirm-banner'].forEach(id => $(id)?.classList.add('hidden'));
  $('kt-info-bar').classList.remove('hidden');
  updateKTTopBar(state);
  renderKTInfoPanel(state);
  renderKTSeats(state);
  renderKTTrick(state);
  renderKTTurnIndicator(state);
}

// ─── TOP BAR ──────────────────────────────────────────────────────────────────
function updateKTTopBar(state) {
  const ts = $('top-trump-sym');
  if (state.trumpSuit) {
    ts.textContent = SUIT_SYM[state.trumpSuit];
    ts.className = `trump-symbol ${SUIT_COLORS[state.trumpSuit]}`;
    $('top-trump-name').textContent = state.trumpSuit.charAt(0).toUpperCase() + state.trumpSuit.slice(1);
  } else {
    ts.textContent = '?';
    ts.className = 'trump-symbol';
    $('top-trump-name').textContent = 'Pending';
  }
  // Repurpose round badge to show bid target, cards badge to show phase
  $('top-round').textContent = state.winningBid || '—';
  $('top-total-rounds').textContent = '';
  const cardsBadge = $('top-cards').parentElement;
  if (cardsBadge) cardsBadge.style.display = 'none';
  const roundBadge = $('top-round').parentElement;
  if (roundBadge) {
    roundBadge.innerHTML = `Bid: <span id="top-round">${state.winningBid || '—'}</span>`;
  }
}

// ─── KT INFO PANEL ────────────────────────────────────────────────────────────
function renderKTInfoPanel(state) {
  const bar = $('kt-info-bar');
  if (!bar) return;

  // Trump
  if (state.trumpSuit) {
    $('kt-trump-display').innerHTML = `<span class="${SUIT_COLORS[state.trumpSuit]}">${SUIT_SYM[state.trumpSuit]}</span> ${state.trumpSuit.charAt(0).toUpperCase() + state.trumpSuit.slice(1)}`;
  } else {
    $('kt-trump-display').textContent = '—';
  }

  // Bid
  $('kt-bid-display').textContent = state.winningBid || '—';

  // Bid winner
  $('kt-bidwinner-display').textContent = state.bidWinnerName || '—';

  // Partner cards
  if (state.partnerCards && state.partnerCards.length > 0) {
    const [r1, s1] = parseKTCardId(state.partnerCards[0]);
    $('kt-partner1-display').innerHTML = `<span class="${SUIT_COLORS[s1]}">${r1}${SUIT_SYM[s1]}</span>`;

    if (state.partnerCards.length > 1) {
      $('kt-partner2-wrap').classList.remove('hidden');
      const [r2, s2] = parseKTCardId(state.partnerCards[1]);
      $('kt-partner2-display').innerHTML = `<span class="${SUIT_COLORS[s2]}">${r2}${SUIT_SYM[s2]}</span>`;
    } else {
      $('kt-partner2-wrap').classList.add('hidden');
    }
  } else {
    $('kt-partner1-display').textContent = '—';
    $('kt-partner2-wrap').classList.add('hidden');
  }
}

function parseKTCardId(cardId) {
  const parts = cardId.split('_');
  return [parts[0], parts[1]]; // [rank, suit]
}

// ─── SEAT RENDERING ───────────────────────────────────────────────────────────
function renderKTSeats(state) {
  const myIdx = isSpectator ? -1 : myPlayerIndex;
  const playerCount = state.players.length;
  const po = state.playerOrder || state.players.map((_, i) => i);
  const sc = $('seats-container');

  if (playerCount === 0) { sc.innerHTML = ''; return; }

  if (playerCount === 1) {
    sc.innerHTML = `<div class="seats-row single-seat-row"><div class="seat-col center-col">${ktSeatHTML(state, po[0], myIdx)}</div></div>`;
    return;
  }

  if (playerCount === 2) {
    sc.innerHTML = `
      <div class="seats-row">
        <div class="seat-col left-col">${ktSeatHTML(state, po[0], myIdx)}</div>
        <div class="seat-col center-col"><div class="loop-arrow">⇄</div></div>
        <div class="seat-col right-col">${ktSeatHTML(state, po[1], myIdx)}</div>
      </div>`;
    return;
  }

  const isEven = playerCount % 2 === 0;
  const numRows = isEven ? playerCount / 2 : Math.ceil(playerCount / 2);
  let html = '';

  for (let r = 0; r < numRows; r++) {
    if (r > 0) {
      html += `<div class="seats-connector-row"><div class="connector-col left-col"><div class="loop-arrow">↑</div></div><div class="connector-col center-col"></div><div class="connector-col right-col"><div class="loop-arrow">↓</div></div></div>`;
    }
    if (r === 0) {
      html += `<div class="seats-row"><div class="seat-col left-col">${ktSeatHTML(state, po[0], myIdx)}</div><div class="seat-col center-col"><div class="loop-arrow">→</div></div><div class="seat-col right-col">${ktSeatHTML(state, po[1], myIdx)}</div></div>`;
    } else if (r === numRows - 1) {
      if (isEven) {
        const rightPIdx = po[numRows];
        const leftPIdx = po[playerCount - (numRows - 1)];
        html += `<div class="seats-row"><div class="seat-col left-col">${ktSeatHTML(state, leftPIdx, myIdx)}</div><div class="seat-col center-col"><div class="loop-arrow">←</div></div><div class="seat-col right-col">${ktSeatHTML(state, rightPIdx, myIdx)}</div></div>`;
      } else {
        const centerPIdx = po[Math.ceil(playerCount / 2)];
        html += `<div class="seats-row single-seat-row"><div class="seat-col center-col">${ktSeatHTML(state, centerPIdx, myIdx)}</div></div>`;
      }
    } else {
      const rightPIdx = po[1 + r];
      const leftPIdx = po[playerCount - r];
      html += `<div class="seats-row"><div class="seat-col left-col">${ktSeatHTML(state, leftPIdx, myIdx)}</div><div class="seat-col center-col"></div><div class="seat-col right-col">${ktSeatHTML(state, rightPIdx, myIdx)}</div></div>`;
    }
  }

  sc.innerHTML = html;
}

function ktSeatHTML(state, pIdx, myIdx) {
  const p = state.players[pIdx];
  if (!p) return '';
  const isMine = pIdx === myIdx;
  const isTurn = state.currentTurnIndex === pIdx;
  const isBidWinner = p.isBidWinner;
  const isRevealed = p.isRevealed;
  const isOffline = !p.connected;
  const canKick = isOffline && !isMine && !isSpectator;

  const cls = [
    'seat',
    isMine ? 'my-seat' : '',
    isTurn ? 'current-turn' : '',
    isOffline ? 'disconnected' : '',
    isBidWinner ? 'kt-bid-winner' : '',
    isRevealed ? 'kt-partner-revealed' : '',
    canKick ? 'kickable' : '',
  ].filter(Boolean).join(' ');

  const clickAttr = canKick ? `onclick="voteKickOffline(${pIdx})"` : '';

  let meta = '';
  if (isBidWinner) meta += `<span class="kt-badge kt-badge-bidwinner">★ Bid Winner</span> `;
  if (isRevealed) meta += `<span class="kt-badge kt-badge-partner">🤝 Partner</span> `;
  meta += `<span class="m-score">${p.wonCardCount || 0} cards won</span>`;

  let kickBar = '';
  if (isOffline) {
    const kv = kickVoteState[pIdx];
    if (kv) kickBar = `<div class="kick-vote-bar"><span class="kick-vote-count">⚡ Kick ${kv.votes}/${kv.needed}</span></div>`;
    else if (canKick) kickBar = `<div class="kick-vote-bar"><span style="font-size:.58rem;color:var(--red);">OFFLINE · tap to kick</span></div>`;
  }

  return `<div class="${cls}" ${clickAttr}><div class="seat-avatar ${AVATAR_COLS[pIdx % 7]}">${p.name[0].toUpperCase()}${isTurn ? '<div class="turn-dot"></div>' : ''}</div><div class="seat-info"><div class="seat-name">${p.name}${isMine ? ' ★' : ''}${p.isHost ? ' ♛' : ''}</div><div class="seat-meta">${meta}</div>${kickBar}</div></div>`;
}

// ─── BIDDING PHASE ────────────────────────────────────────────────────────────
function renderKTBidding(state) {
  // Show bidding overlay, hide others
  $('kt-bid-overlay').classList.remove('hidden');
  $('kt-trump-overlay').classList.add('hidden');
  $('kt-partner-overlay').classList.add('hidden');

  // Current bid info
  const info = $('kt-bid-current-info');
  if (state.bidding.highestBid > 0) {
    info.innerHTML = `<div class="kt-current-bid">Current Bid: <strong>${state.bidding.highestBid}</strong> by <strong>${state.bidding.highestBidderName}</strong></div>`;
  } else {
    info.innerHTML = `<div class="kt-current-bid">Opening bid. Min: <strong>${KT_MIN_BID}</strong></div>`;
  }

  // Show passed players
  const passedNames = state.players
    .filter((_, i) => state.bidding.passed[i])
    .map(p => p.name);
  if (passedNames.length > 0) {
    info.innerHTML += `<div class="kt-passed-list">Passed: ${passedNames.join(', ')}</div>`;
  }

  if (state.bidding.isMyTurnToBid && !state.bidding.myHasPassed) {
    // It's my turn
    $('kt-bid-controls').classList.remove('hidden');
    $('kt-bid-waiting').classList.add('hidden');

    const minAllowed = Math.max(KT_MIN_BID, (state.bidding.highestBid || KT_MIN_BID - 5) + 5);
    if (ktSelectedBid < minAllowed) ktSelectedBid = minAllowed;
    $('kt-bid-amount').textContent = ktSelectedBid;
    $('kt-bid-submit-amount').textContent = ktSelectedBid;
  } else {
    $('kt-bid-controls').classList.add('hidden');
    $('kt-bid-waiting').classList.remove('hidden');

    const currentBidderName = state.players[state.bidding.currentBidder]?.name || '?';
    $('kt-bid-waiting').innerHTML = state.bidding.myHasPassed
      ? `You passed. Waiting for <strong>${currentBidderName}</strong>…`
      : `Waiting for <strong>${currentBidderName}</strong> to bid…`;
  }

  // Trick area
  renderKTTrick(state);
  renderKTTurnIndicator(state);
}

function ktChangeBid(delta) {
  if (!currentGameState) return;
  const minAllowed = Math.max(KT_MIN_BID, (currentGameState.bidding.highestBid || KT_MIN_BID - 5) + 5);
  ktSelectedBid = Math.max(minAllowed, Math.min(KT_MAX_BID, ktSelectedBid + delta));
  $('kt-bid-amount').textContent = ktSelectedBid;
  $('kt-bid-submit-amount').textContent = ktSelectedBid;
}

function ktSubmitBid() {
  socket.emit('ktBid', { action: 'bid', amount: ktSelectedBid });
}

function ktPassBid() {
  socket.emit('ktBid', { action: 'pass' });
}

// ─── TRUMP SELECTION PHASE ────────────────────────────────────────────────────
function renderKTTrumpSelect(state) {
  $('kt-bid-overlay').classList.add('hidden');
  $('kt-partner-overlay').classList.add('hidden');

  if (state.myIndex === state.bidWinnerIndex) {
    $('kt-trump-overlay').classList.remove('hidden');
  } else {
    $('kt-trump-overlay').classList.add('hidden');
    // Show waiting message in trick area
    const el = $('trick-status');
    if (el) el.textContent = `Waiting for ${state.bidWinnerName} to select trump…`;
    $('trick-cards').innerHTML = `<div style="color:var(--text2);text-align:center;font-size:.9rem;padding:1rem;">Waiting for <strong>${state.bidWinnerName}</strong> to pick trump…</div>`;
  }
  renderKTTurnIndicator(state);
}

function ktSelectTrump(suit) {
  socket.emit('ktSelectTrump', { suit });
  $('kt-trump-overlay').classList.add('hidden');
}

// ─── PARTNER SELECTION PHASE ──────────────────────────────────────────────────
function renderKTPartnerSelect(state) {
  $('kt-bid-overlay').classList.add('hidden');
  $('kt-trump-overlay').classList.add('hidden');

  if (state.myIndex === state.bidWinnerIndex) {
    $('kt-partner-overlay').classList.remove('hidden');

    const maxPartners = state.playerCount === 4 ? 1 : 2;
    $('kt-partner-count-label').textContent = maxPartners > 1 ? 's' : '';
    $('kt-partner-instructions').textContent = maxPartners === 1
      ? 'Select the card whose owner will be your partner.'
      : `Select 2 cards. Their owners will be your partners.`;

    // Build list of all card IDs in my hand
    const myCardIds = new Set((state.myHand || []).map(c => c.id));

    // All possible suits
    const suits = ['spades', 'diamonds', 'clubs', 'hearts'];
    // Ranks available (no 2s in 6-player)
    const ranks = state.playerCount === 6
      ? ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A']
      : ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

    // Suit tabs
    $('kt-partner-suit-tabs').innerHTML = suits.map(s =>
      `<button class="kt-suit-tab ${s === ktActiveSuitTab ? 'active' : ''} ${SUIT_COLORS[s]}" onclick="ktSetSuitTab('${s}')">${SUIT_SYM[s]} ${s.charAt(0).toUpperCase() + s.slice(1)}</button>`
    ).join('');

    // Cards for active suit tab
    const cardsInSuit = ranks
      .map(rank => ({ rank, suit: ktActiveSuitTab, id: `${rank}_${ktActiveSuitTab}` }))
      .filter(card => !myCardIds.has(card.id)); // exclude my own cards

    $('kt-partner-card-grid').innerHTML = cardsInSuit.map(card => {
      const selected = ktSelectedPartnerCards.includes(card.id);
      return `<div class="kt-partner-card-option ${selected ? 'selected' : ''}" onclick="ktTogglePartnerCard('${card.id}')">
        ${cardHTML(card, 'size-sm', state.trumpSuit, false, false)}
      </div>`;
    }).join('');

    // Show selected cards
    if (ktSelectedPartnerCards.length > 0) {
      $('kt-partner-selected').innerHTML = `<div class="kt-partner-sel-label">Selected:</div>` +
        ktSelectedPartnerCards.map(cid => {
          const [r, s] = parseKTCardId(cid);
          return `<span class="kt-partner-sel-chip ${SUIT_COLORS[s]}">${r}${SUIT_SYM[s]} <button onclick="ktRemovePartnerCard('${cid}')" style="background:none;border:none;color:inherit;cursor:pointer;font-size:.8rem;margin-left:.2rem;">✕</button></span>`;
        }).join('');
    } else {
      $('kt-partner-selected').innerHTML = '';
    }

    $('kt-partner-confirm').disabled = ktSelectedPartnerCards.length !== maxPartners;
  } else {
    $('kt-partner-overlay').classList.add('hidden');
    $('trick-cards').innerHTML = `<div style="color:var(--text2);text-align:center;font-size:.9rem;padding:1rem;">Waiting for <strong>${state.bidWinnerName}</strong> to choose partner card(s)…</div>`;
  }
  renderKTTurnIndicator(state);
}

function ktSetSuitTab(suit) {
  ktActiveSuitTab = suit;
  if (currentGameState) renderKTPartnerSelect(currentGameState);
}

function ktTogglePartnerCard(cardId) {
  if (!currentGameState) return;
  const maxPartners = currentGameState.playerCount === 4 ? 1 : 2;

  if (ktSelectedPartnerCards.includes(cardId)) {
    ktSelectedPartnerCards = ktSelectedPartnerCards.filter(id => id !== cardId);
  } else {
    if (ktSelectedPartnerCards.length >= maxPartners) {
      ktSelectedPartnerCards.pop(); // replace last if at max
    }
    ktSelectedPartnerCards.push(cardId);
  }
  renderKTPartnerSelect(currentGameState);
}

function ktRemovePartnerCard(cardId) {
  ktSelectedPartnerCards = ktSelectedPartnerCards.filter(id => id !== cardId);
  if (currentGameState) renderKTPartnerSelect(currentGameState);
}

function ktConfirmPartners() {
  socket.emit('ktSelectPartners', { partnerCards: ktSelectedPartnerCards });
  $('kt-partner-overlay').classList.add('hidden');
  ktSelectedPartnerCards = [];
}

// ─── PLAYING PHASE ────────────────────────────────────────────────────────────
function renderKTPlaying(state) {
  // Hide all KT overlays
  ['kt-bid-overlay', 'kt-trump-overlay', 'kt-partner-overlay'].forEach(id => $(id)?.classList.add('hidden'));

  renderKTTrick(state);
  renderKTTurnIndicator(state);
}

function renderKTTrick(state) {
  const el = $('trick-cards');
  const st = $('trick-status');
  if (!el) return;

  const po = state.playerOrder || state.players.map((_, i) => i);
  const leader = state.currentLeader;
  const leaderIdx = leader !== null && leader !== undefined ? po.indexOf(leader) : 0;

  const handOrder = [];
  for (let i = 0; i < state.players.length; i++) {
    handOrder.push(po[(leaderIdx + i) % po.length]);
  }

  let html = '';
  for (let i = 0; i < state.players.length; i++) {
    const pIdx = handOrder[i];
    const playerName = state.players[pIdx]?.name || '?';
    const played = (state.currentTrick || []).find(t => t.playerIndex === pIdx);
    const isWinner = trickWinData && trickWinData.winnerIndex === pIdx;
    const isLoser = trickWinData && trickWinData.winnerIndex !== pIdx && played;
    const slotCls = ['trick-card-slot', isWinner ? 'winner-highlight' : '', isLoser ? 'loser-dim' : ''].filter(Boolean).join(' ');

    if (played) {
      html += `<div class="${slotCls}" data-player="${pIdx}">${isWinner ? '<div class="winner-crown">★</div>' : ''}<div class="trick-player-name">${playerName}</div>${cardHTML(played.card, 'size-md', state.trumpSuit, false, false)}</div>`;
    } else {
      html += `<div class="trick-card-slot" data-player="${pIdx}"><div class="card-empty"></div><div class="trick-player-name">${playerName}</div></div>`;
    }
  }

  el.innerHTML = html;
  if (st) st.textContent = state.leadSuit ? `Lead: ${SUIT_SYM[state.leadSuit]} ${state.leadSuit}` : '';
}

function renderKTTurnIndicator(state) {
  const el = $('turn-indicator');
  if (!el) return;

  if (state.phase !== 'playing') {
    el.textContent = '';
    el.className = 'turn-indicator';
    return;
  }

  const ti = state.currentTurnIndex;
  if (ti === null || ti === undefined) { el.textContent = ''; return; }

  const trickComplete = (state.currentTrick || []).length >= state.players.length;
  if (trickComplete) { el.textContent = 'Resolving trick…'; el.className = 'turn-indicator other-turn'; return; }

  const myIdx = isSpectator ? -1 : myPlayerIndex;
  if (ti === myIdx) {
    el.textContent = '⚡ Your turn — play a card!';
    el.className = 'turn-indicator my-turn';
  } else {
    el.textContent = `Waiting for ${state.players[ti]?.name || '?'}…`;
    el.className = 'turn-indicator other-turn';
  }
}

// ─── HAND RENDERING ───────────────────────────────────────────────────────────
function renderKTHand(state) {
  if (isSpectator) return;
  const hand = state.myHand || [];

  const isMyTurn = state.phase === 'playing' && state.currentTurnIndex === myPlayerIndex;
  const trickComplete = (state.currentTrick || []).length >= state.players.length;
  const hasLeadSuit = isMyTurn && (state.currentTrick || []).length > 0 && hand.some(c => c.suit === state.leadSuit);

  const sorted = getSortedHand(hand, state.trumpSuit);

  $('my-hand').innerHTML = sorted.map((card, si) => {
    const isPlayable = isMyTurn && !trickComplete && canKTPlayCard(card, state);
    const isDisabled = !isPlayable;
    const isSuitLocked = isMyTurn && hasLeadSuit && !isPlayable;

    return `<div class="card-slot"><div class="card-arrows"><button class="arrow-btn" onclick="moveCard('${card.id}',-1)" ${si === 0 ? 'disabled' : ''}>◀</button><button class="arrow-btn" onclick="moveCard('${card.id}',+1)" ${si === sorted.length - 1 ? 'disabled' : ''}>▶</button></div>${cardHTML(card, 'size-lg', state.trumpSuit, isPlayable, isDisabled, `ktSelectCard('${card.id}')`, isSuitLocked)}</div>`;
  }).join('');

  const badge = $('hand-trump-badge');
  badge.style.display = state.trumpSuit ? '' : 'none';
  if (state.trumpSuit) {
    const sym = $('hand-trump-sym');
    if (sym) { sym.textContent = SUIT_SYM[state.trumpSuit] || ''; sym.className = SUIT_COLORS[state.trumpSuit] || ''; }
  }
}

function canKTPlayCard(card, state) {
  if (state.phase !== 'playing' || state.currentTurnIndex !== myPlayerIndex) return false;
  const trickComplete = (state.currentTrick || []).length >= state.players.length;
  if (trickComplete) return false;
  if (!(state.currentTrick || []).length) return true;
  const hasLead = (state.myHand || []).some(c => c.suit === state.leadSuit);
  return !hasLead || card.suit === state.leadSuit;
}

function ktSelectCard(cardId) {
  if (!currentGameState || currentGameState.phase !== 'playing' || currentGameState.currentTurnIndex !== myPlayerIndex) return;
  const card = (currentGameState.myHand || []).find(c => c.id === cardId);
  if (!card || !canKTPlayCard(card, currentGameState)) return;

  // Use existing confirm banner
  document.querySelectorAll('.card.selected-to-play').forEach(c => c.classList.remove('selected-to-play'));
  $(`card-${cardId}`)?.classList.add('selected-to-play');
  pendingCardId = cardId;
  $('confirm-banner').classList.remove('hidden');
  $('confirm-banner-text').textContent = `Play ${card.rank} ${SUIT_SYM[card.suit]}?`;
  $('confirm-banner-card').innerHTML = cardHTML(card, 'size-sm', currentGameState.trumpSuit, false, false);
  document.body.classList.add('banner-visible');
}

// Override confirmPlay to emit ktPlayCard instead of playCard for KT games
const _origConfirmPlay = window.confirmPlay;
window.confirmPlay = function () {
  if (currentGameState && currentGameState.gameType === 'kaaliTeeri') {
    if (!pendingCardId) return;
    socket.emit('ktPlayCard', { cardId: pendingCardId });
    cancelPlay();
    return;
  }
  if (_origConfirmPlay) _origConfirmPlay();
};

// ─── GAME OVER ────────────────────────────────────────────────────────────────
function renderKTGameOver(state) {
  const result = state.result;
  if (!result) return;

  $('kt-game-over-overlay').classList.remove('hidden');
  ['kt-bid-overlay', 'kt-trump-overlay', 'kt-partner-overlay'].forEach(id => $(id)?.classList.add('hidden'));

  // Winner title
  if (result.winningTeam === 'bidWinner') {
    $('kt-winner-title').textContent = `${result.bidWinner.name}'s Team Wins! 🎉`;
  } else {
    $('kt-winner-title').textContent = 'Defender Team Wins! 🛡️';
  }

  // Summary
  $('kt-result-summary').innerHTML = `
    <div class="kt-result-row"><span>Winning Bid</span><strong>${result.winningBid}</strong></div>
    <div class="kt-result-row"><span>Bid Winner's Team Points</span><strong>${result.bidWinnerTeamPoints}</strong></div>
    <div class="kt-result-row"><span>Defender Team Points</span><strong>${result.defenderTeamPoints}</strong></div>
    <div class="kt-result-row"><span>Bid Winner</span><strong>${result.bidWinner.name}</strong></div>
    <div class="kt-result-row"><span>Trump</span><strong><span class="${result.trumpSuit ? SUIT_COLORS[result.trumpSuit] : ''}">${result.trumpSuit ? SUIT_SYM[result.trumpSuit] + ' ' + result.trumpSuit : '—'}</span></strong></div>
    <div class="kt-result-row"><span>Partner(s)</span><strong>${result.partners.map(p => p.name).join(', ') || 'None revealed'}</strong></div>
  `;

  // Per-player breakdown
  $('kt-score-breakdown').innerHTML = `
    <h3>Player Breakdown</h3>
    <div class="kt-player-scores">
      ${Object.values(result.playerScores).map(ps => `
        <div class="kt-player-score-row ${ps.team === 'bidWinner' ? 'kt-team-bidwinner' : 'kt-team-defender'}">
          <span class="kt-ps-name">${ps.name}</span>
          <span class="kt-ps-team">${ps.team === 'bidWinner' ? '★ Bid Team' : '🛡️ Defenders'}</span>
          <span class="kt-ps-cards">${ps.wonCardCount} cards</span>
          <span class="kt-ps-points">${ps.points} pts</span>
        </div>
      `).join('')}
    </div>
  `;
}

function ktVotePlayAgain() {
  socket?.emit('ktPlayAgain');
  const b = document.querySelector('[onclick="ktVotePlayAgain()"]');
  if (b) { b.disabled = true; b.textContent = '✓ Voted!'; }
}

// ─── PARTNER REVEAL ANIMATION ─────────────────────────────────────────────────
function showKTPartnerReveal(partnerName, bidWinnerName) {
  document.querySelectorAll('.kt-partner-reveal-banner').forEach(e => e.remove());
  const el = document.createElement('div');
  el.className = 'kt-partner-reveal-banner';
  el.innerHTML = `<div class="kt-partner-reveal-inner"><div class="kt-partner-reveal-text">🤝 <strong>${partnerName}</strong> is partner of <strong>${bidWinnerName}</strong>!</div></div>`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}
