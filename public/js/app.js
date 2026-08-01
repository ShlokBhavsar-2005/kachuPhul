// ═══════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════
let socket = null;
let myPlayerIndex = null, myRoomId = null, myGameName = '', myPicture = '', myGoogleId = '', mySessionToken = '';
let isSpectator = false;
let currentGameState = null, selectedBid = null, lastRoundEndShown = -1;
let customHandOrder = [], sortMode = 'custom', pendingCardId = null;
let chosenRounds = null, maxRoundsAvailable = 0, bidPanelOpen = false;
let pendingGoogleId = '', pendingCredential = '', pendingPicture = '';
let playedCardIds = new Set();
let trickWinData = null;
let matchPlayerCount = 0;
let chatMessages = [], chatOpen = false, unreadChat = 0;
let kickVoteState = {};

const SUIT_COLORS = { spades: 'suit-spades', diamonds: 'suit-diamonds', clubs: 'suit-clubs', hearts: 'suit-hearts' };
const SUIT_SYM = { spades: '♠', diamonds: '♦', clubs: '♣', hearts: '♥' };
const SUIT_ORDER = { spades: 0, diamonds: 1, clubs: 2, hearts: 3 };
const RANK_ORDER = { '2': 0, '3': 1, '4': 2, '5': 3, '6': 4, '7': 5, '8': 6, '9': 7, '10': 8, 'J': 9, 'Q': 10, 'K': 11, 'A': 12 };
const AVATAR_COLS = ['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6'];
const TRUMP_SEQ = ['spades', 'diamonds', 'clubs', 'hearts'];
const COLORS = { gold: 'var(--gold)', green: 'var(--green)', red: 'var(--red)' };

// ═══════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════
const $ = id => document.getElementById(id);
function showScreen(id) { document.querySelectorAll('.screen').forEach(s => s.classList.remove('active')); $(id)?.classList.add('active'); }
function showErr(id, msg) { const e = $(id); if (!e) return; e.textContent = msg; e.classList.remove('hidden'); setTimeout(() => e.classList.add('hidden'), 4000); }
function notify(msg, type = 'info') {
  document.querySelectorAll('.notif').forEach(n => n.remove());
  const el = document.createElement('div'); el.className = `notif ${type}`; el.textContent = msg;
  document.body.appendChild(el); setTimeout(() => el.remove(), 3200);
}

let _coldStartTimer = null;
function hideLoading() { clearTimeout(_coldStartTimer); $('loading-screen').classList.add('hidden'); }
function setLoading(msg) {
  $('loading-text').textContent = msg || 'Connecting…';
  $('loading-screen').classList.remove('hidden');
  clearTimeout(_coldStartTimer);
  _coldStartTimer = setTimeout(() => {
    const ls = $('loading-screen');
    if (ls && !ls.classList.contains('hidden')) {
      $('loading-text').textContent = 'Waking up server… (free tier spin up)';
    }
  }, 2000);
}

const _actionLocks = new Map();
function isThrottled(actionKey, delayMs = 1000) {
  const now = Date.now();
  const last = _actionLocks.get(actionKey) || 0;
  if (now - last < delayMs) return true;
  _actionLocks.set(actionKey, now);
  return false;
}

// ═══════════════════════════════════════════════
// SESSION (localStorage)
// ═══════════════════════════════════════════════
const SESS_KEY = 'kp_game_session';
const AUTH_KEY = 'kp_auth';
function saveGameSession(d) { try { localStorage.setItem(SESS_KEY, JSON.stringify(d)); } catch (e) { } }
function loadGameSession() { try { const s = localStorage.getItem(SESS_KEY); return s ? JSON.parse(s) : null; } catch (e) { return null; } }
function clearGameSession() { try { localStorage.removeItem(SESS_KEY); } catch (e) { } }
function saveAuth(d) { try { localStorage.setItem(AUTH_KEY, JSON.stringify(d)); } catch (e) { } }
function loadAuth() { try { const s = localStorage.getItem(AUTH_KEY); return s ? JSON.parse(s) : null; } catch (e) { return null; } }
function clearAuth() { try { localStorage.removeItem(AUTH_KEY); } catch (e) { } }

// ═══════════════════════════════════════════════
// GOOGLE LOGIN
// ═══════════════════════════════════════════════
function startGoogleLogin() {
  fetch('/auth/status').then(r => r.json()).then(d => {
    if (!d.configured || !d.clientId) { showErr('home-error', 'Google login not configured — set GOOGLE_CLIENT_ID and MONGO_URI in Render env vars'); return; }
    window._googleClientId = d.clientId;
    if (window._gsiLoaded) { triggerGsiPrompt(); return; }
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true; script.defer = true;
    script.onload = () => { window._gsiLoaded = true; triggerGsiPrompt(); };
    script.onerror = () => showErr('home-error', 'Failed to load Google script');
    document.head.appendChild(script);
  }).catch(() => showErr('home-error', 'Cannot reach server'));
}

function triggerGsiPrompt() {
  google.accounts.id.initialize({ client_id: window._googleClientId, callback: handleGoogleCredential, auto_select: false, cancel_on_tap_outside: true, use_fedcm_for_prompt: false });
  google.accounts.id.prompt(notification => {
    if (notification.isNotDisplayed() || notification.isSkippedMoment()) {
      const c = document.getElementById('google-btn-container');
      if (c) { c.style.display = 'block'; google.accounts.id.renderButton(c, { theme: 'filled_blue', size: 'large', width: 280 }); }
    }
  });
}

async function handleGoogleCredential(response) {
  setLoading('Signing in…');
  try {
    const res = await fetch('/auth/google', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ credential: response.credential }) });
    const data = await res.json();
    if (data.status === 'ok') {
      setAuthUser(data); saveAuth({ sessionToken: data.sessionToken, gameName: data.gameName, googleId: data.googleId, picture: data.picture || '' }); connectSocket();
    } else if (data.status === 'new') {
      pendingGoogleId = data.googleId; pendingCredential = response.credential; pendingPicture = data.picture || '';
      hideLoading(); showScreen('name-screen');
    } else { hideLoading(); showErr('home-error', data.error || 'Login failed'); }
  } catch (e) { hideLoading(); showErr('home-error', 'Network error — try again'); }
}

function setAuthUser(data) {
  mySessionToken = data.sessionToken; myGameName = data.gameName; myGoogleId = data.googleId; myPicture = data.picture || '';
  $('nav-name').textContent = myGameName;
  if (myPicture) { $('nav-avatar').src = myPicture; $('nav-avatar').classList.remove('hidden'); }
}

async function submitGameName() {
  const name = $('game-name-input').value.trim();
  if (!name) return;
  const btn = $('name-submit-btn'); btn.disabled = true; btn.textContent = 'Claiming…';
  try {
    const res = await fetch('/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ googleId: pendingGoogleId, gameName: name, credential: pendingCredential, picture: pendingPicture }) });
    const data = await res.json();
    if (data.status === 'ok') { setAuthUser(data); saveAuth({ sessionToken: data.sessionToken, gameName: data.gameName, googleId: data.googleId, picture: myPicture }); connectSocket(); }
    else { showErr('name-error', data.error || 'Error'); btn.disabled = false; btn.textContent = 'Claim My Name →'; }
  } catch (e) { showErr('name-error', 'Network error'); btn.disabled = false; btn.textContent = 'Claim My Name →'; }
}

function signOut() {
  clearAuth(); clearGameSession(); stopPolling();
  if (socket) { socket.off(); socket.disconnect(); socket = null; }
  mySessionToken = ''; myGameName = ''; myGoogleId = ''; myPicture = '';
  showScreen('home-screen');
}

// ═══════════════════════════════════════════════
// SOCKET
// ═══════════════════════════════════════════════
function connectSocket() {
  if (socket) { socket.off(); socket.disconnect(); socket = null; }
  socket = io({
    transports: ['websocket'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    timeout: 20000
  });

  socket.on('connect', () => {
    console.log('socket connected', socket.id);
    if (mySessionToken) socket.emit('authenticate', { sessionToken: mySessionToken });
    const gs = loadGameSession();
    if (gs) socket.emit('rejoinRoom', { roomId: gs.roomId, playerToken: gs.playerToken });
    else { hideLoading(); showMenuAndLoad(); }
  });

  socket.on('reconnect', () => {
    notify('Reconnected ✓', 'win');
    if (mySessionToken) socket.emit('authenticate', { sessionToken: mySessionToken });
    const gs = loadGameSession();
    if (gs) socket.emit('rejoinRoom', { roomId: gs.roomId, playerToken: gs.playerToken });
    else loadFriends();
  });

  socket.on('connect_error', () => { hideLoading(); notify('Connection lost — retrying…', 'err'); });
  socket.on('error', msg => notify(msg, 'err'));
  socket.on('authenticated', ({ gameName }) => {
    myGameName = gameName;
    $('nav-name').textContent = gameName;
    loadFriends();
  });

  socket.on('joinedRoom', ({ roomId, playerIndex, playerToken, playerName, isRejoin }) => {
    myRoomId = roomId; myPlayerIndex = playerIndex; myGameName = playerName; isSpectator = false;
    saveGameSession({ roomId, playerIndex, playerToken, playerName });
    $('display-room-code').textContent = roomId;
    hideLoading();
    if (!isRejoin) showScreen('waiting-screen');
    $('chat-fab').classList.remove('hidden');
  });

  socket.on('yourIndex', idx => { myPlayerIndex = idx; const g = loadGameSession(); if (g) { g.playerIndex = idx; saveGameSession(g); } });
  socket.on('rejoinFailed', () => { clearGameSession(); hideLoading(); showMenuAndLoad(); notify('Session expired', 'err'); });
  socket.on('kicked', msg => { clearGameSession(); hideLoading(); showMenuAndLoad(); notify(msg || 'Removed from room', 'err'); });

  socket.on('roomUpdate', room => {
    hideLoading();
    if (!currentGameState || room.state === 'lobby') { if (!isSpectator) showScreen('waiting-screen'); renderWaitingRoom(room); }
    $('chat-fab').classList.remove('hidden');
  });

  socket.on('gameState', state => {
    hideLoading();
    $('chat-fab').classList.remove('hidden');
    if (state.isSpectator) { renderSpectatorState(state); return; }
    if (matchPlayerCount === 0) matchPlayerCount = state.players.length;
    syncCustomOrder(state.myHand);
    const prevTurn = currentGameState?.currentTurnIndex;
    currentGameState = state;
    playedCardIds = new Set(state.currentTrick.map(t => t.card.id));
    renderGameState(state);
    const trickFull = state.currentTrick && state.currentTrick.length >= state.players.length;
    if (state.state === 'playing' && state.currentTurnIndex === myPlayerIndex && prevTurn !== myPlayerIndex && !trickFull) showYourTurnFlash();
  });

  socket.on('spectating', ({ roomId }) => {
    isSpectator = true; myRoomId = roomId;
    showScreen('game-screen'); $('spec-badge').classList.remove('hidden'); $('my-hand-section').classList.add('hidden');
    ['arrange-banner', 'bid-overlay', 'confirm-banner'].forEach(id => $(id).classList.add('hidden'));
    notify('Spectating room ' + roomId, 'info');
  });

  socket.on('trickWon', ({ winnerName, winnerIndex, winningCard, trick }) => {
    trickWinData = { winnerIndex, winningCard, trick };
    if (currentGameState) renderTrick(currentGameState);
    setTimeout(() => { trickWinData = null; }, 2200);
  });

  socket.on('roundEnd', ({ roundIndex, results }) => {
    if (roundIndex !== lastRoundEndShown) { lastRoundEndShown = roundIndex; showRoundEnd(roundIndex, results); }
  });

  socket.on('gameOver', ({ finalScores }) => setTimeout(() => showGameOver(finalScores), 500));
  socket.on('playerDisconnected', ({ name }) => notify(`${name} disconnected`, 'err'));
  socket.on('playerRejoined', ({ name }) => { notify(`${name} rejoined ✓`, 'win'); kickVoteState = {}; });
  socket.on('spectatorJoined', ({ gameName }) => notify(`${gameName} is spectating`, 'info'));
  socket.on('playerRemoved', ({ name }) => { notify(`${name} was kicked from the game`, 'info'); kickVoteState = {}; });
  socket.on('playerLeft', ({ name }) => notify(`${name} left the game`, 'info'));

  socket.on('kickVoteUpdate', ({ targetIndex, targetName, votes, needed, voters }) => {
    kickVoteState[targetIndex] = { votes, needed, voters, targetName };
    if (currentGameState) renderSeats(currentGameState);
    notify(`Vote to kick ${targetName}: ${votes}/${needed}`, 'info');
  });

  socket.on('newLobby', ({ roomId, playerIndex, playerToken, playerName }) => {
    myRoomId = roomId; myPlayerIndex = playerIndex; myGameName = playerName; isSpectator = false;
    matchPlayerCount = 0; lastRoundEndShown = -1; currentGameState = null;
    trickWinData = null; playedCardIds = new Set(); customHandOrder = [];
    selectedBid = null; bidPanelOpen = false; chosenRounds = null;
    chatMessages = []; unreadChat = 0; kickVoteState = {}; updateChatBadge();
    saveGameSession({ roomId, playerIndex, playerToken, playerName });
    $('display-room-code').textContent = roomId;
    $('game-over-overlay').classList.add('hidden');
    showScreen('waiting-screen'); $('chat-fab').classList.remove('hidden');
  });

  socket.on('playAgainUpdate', ({ votes, total }) => {
    const el = $('play-again-votes');
    if (el) el.innerHTML = `<strong>${votes.length}/${total}</strong> voted: ${votes.join(', ')}`;
  });

  socket.on('friendRequest', ({ from, picture }) => {
    showToast('👥 Friend Request', `<strong>${from}</strong> wants to be friends`,
      [{ label: '✓ Accept', color: COLORS.green, fn: `acceptFriendReq('${from}')` }, { label: '✕ Dismiss', color: '', fn: 'dismissToast()' }], 15000);
    showNotifDot(); loadFriends();
  });

  socket.on('friendAccepted', ({ gameName }) => { notify(`${gameName} accepted your request! 🎉`, 'win'); loadFriends(); });
  socket.on('friendStatusUpdate', () => { loadFriends(); refreshLobbyInvitePanel(); });
  socket.on('inviteSent', ({ to }) => notify(`Invite sent to ${to} 📨`, 'win'));
  socket.on('chatMessage', (entry) => onChatMessage(entry));
  socket.on('chatHistory', ({ messages }) => { chatMessages = messages || []; renderChatMessages(); });
  socket.on('gameInvite', ({ from, roomId, roomPlayerCount }) => showInviteBanner(from, roomId, roomPlayerCount || '?'));
}

// ═══════════════════════════════════════════════
// AUTO-REFRESH POLLING (Event-driven, no recurring timers)
// ═══════════════════════════════════════════════
function startFriendsPoll() { }
function stopFriendsPoll() { }
function startLobbyPoll() { }
function stopLobbyPoll() { }
function stopPolling() { }

function showMenuAndLoad() {
  $('nav-name').textContent = myGameName;
  if (myPicture) { $('nav-avatar').src = myPicture; $('nav-avatar').classList.remove('hidden'); }
  showScreen('menu-screen'); loadFriends(); startFriendsPoll(); stopLobbyPoll();
}

// ═══════════════════════════════════════════════
// INVITE BANNER
// ═══════════════════════════════════════════════
let _inviteTimer = null, _inviteInterval = null;
function showInviteBanner(from, roomId, playerCount) {
  dismissInviteBanner();
  const DURATION = 25;
  const el = document.createElement('div'); el.className = 'invite-banner'; el.id = 'active-invite-banner';
  el.innerHTML = `<div class="invite-banner-header"><div class="invite-banner-icon"><svg width="24" height="24" style="color:var(--gold)"><use href="#icon-person-add"/></svg></div><div><div class="invite-banner-title">Game Invite</div><div class="invite-banner-from">${from}</div><div class="invite-banner-sub">${playerCount} player${playerCount !== 1 ? 's' : ''} in room &bull; Tap to join!</div></div></div><div class="invite-banner-timer"><div class="invite-banner-timer-bar" id="invite-timer-bar" style="width:100%"></div></div><div class="invite-banner-btns"><button class="invite-accept-btn" onclick="acceptInvite('${roomId}')">Join Room</button><button class="invite-decline-btn" onclick="dismissInviteBanner()">✕ Decline</button></div>`;
  document.body.appendChild(el);
  let remaining = DURATION;
  _inviteInterval = setInterval(() => { remaining--; const bar = $('invite-timer-bar'); if (bar) bar.style.width = (remaining / DURATION * 100) + '%'; if (remaining <= 0) dismissInviteBanner(); }, 1000);
  _inviteTimer = setTimeout(dismissInviteBanner, DURATION * 1000);
}
function dismissInviteBanner() { clearTimeout(_inviteTimer); clearInterval(_inviteInterval); $('active-invite-banner')?.remove(); }

// ── Toast (friend requests) ──
let toastTimer = null;
function showToast(title, bodyHtml, btns, duration = 10000) {
  dismissToast();
  const el = document.createElement('div'); el.className = 'toast'; el.id = 'active-toast';
  el.innerHTML = `<h4>${title}</h4><p>${bodyHtml}</p><div class="toast-btns">${btns.map(b => `<button onclick="${b.fn}" style="${b.color ? 'background:' + b.color + ';color:' + (b.color === COLORS.gold ? '#1a1000' : '#fff') : ''}">${b.label}</button>`).join('')}</div>`;
  document.body.appendChild(el); toastTimer = setTimeout(dismissToast, duration);
}
function dismissToast() { clearTimeout(toastTimer); $('active-toast')?.remove(); }
function acceptFriendReq(from) { dismissToast(); respondFriend(from, 'accept'); }
function acceptInvite(roomId) { dismissInviteBanner(); dismissToast(); isSpectator = false; socket.emit('joinRoom', { roomId, playerName: myGameName }); }

// ═══════════════════════════════════════════════
// FRIENDS
// ═══════════════════════════════════════════════
function toggleFriends() { const fc = $('friends-card'); fc.style.display = fc.style.display === 'none' ? '' : 'none'; $('notif-dot').classList.add('hidden'); }
function showNotifDot() { $('notif-dot').classList.remove('hidden'); }

async function loadFriends() {
  if (!mySessionToken) return;
  try {
    const res = await fetch('/friends/list', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionToken: mySessionToken }) });
    const data = await res.json();
    if (!data.friends) return;
    renderFriends(data.friends, data.pending || []);
  } catch (e) { }
}

function renderFriends(friends, pending) {
  const reqEl = $('friend-requests-section'), listEl = $('friends-list-section');
  const incoming = pending.filter(p => p.to === myGameName);
  if (incoming.length) {
    showNotifDot();
    reqEl.innerHTML = `<div style="font-size:.72rem;color:var(--text2);text-transform:uppercase;letter-spacing:.08em;margin-bottom:.4rem;">Incoming Requests</div>` +
      incoming.map(r => `<div class="req-item"><div class="friend-av">${r.from[0].toUpperCase()}</div><div class="friend-info"><div class="friend-name">${r.from}</div><div class="friend-status">wants to be friends</div></div><div class="req-btns"><button class="btn-accept" onclick="respondFriend('${r.from}','accept')">✓</button><button class="btn-decline" onclick="respondFriend('${r.from}','reject')">✕</button></div></div>`).join('');
  } else { reqEl.innerHTML = ''; }

  const onlineCount = friends.filter(f => f.online).length;
  const oc = $('friends-online-count'); if (oc) oc.textContent = onlineCount > 0 ? `● ${onlineCount} online` : '';

  if (!friends.length) { listEl.innerHTML = `<div class="empty-friends"><svg width="32" height="32" style="color:var(--text2);margin-bottom:.3rem;display:block;margin-left:auto;margin-right:auto;"><use href="#icon-people"/></svg>No squad yet — add friends above</div>`; return; }
  listEl.innerHTML = friends.map(f => {
    let statusText = '○ Offline', statusCls = '';
    if (f.online && f.inGame) { statusText = '🎮 In Game'; statusCls = 'in-game'; }
    else if (f.online) { statusText = '● Online'; statusCls = 'online'; }
    const av = f.picture ? `<img src="${f.picture}" alt="${f.gameName}">` : f.gameName[0].toUpperCase();
    const canInvite = f.online && !f.inGame && myRoomId && !isSpectator;
    const canWatch = f.inGame && f.roomId;
    return `<div class="friend-item"><div class="friend-av">${av}</div><div class="friend-info"><div class="friend-name">${f.gameName}</div><div class="friend-status ${statusCls}">${statusText}</div></div><div class="friend-btns">${canInvite ? `<button class="btn-invite" onclick="inviteFriend('${f.gameName}')">Invite</button>` : ''}${canWatch ? `<button class="btn-watch" onclick="spectateRoom('${f.roomId}')" style="display:inline-flex;align-items:center;gap:.2rem;"><svg width='13' height='13'><use href='#icon-eye'/></svg>Watch</button>` : ''}</div></div>`;
  }).join('');
}

async function sendFriendReq() {
  const name = $('add-friend-input').value.trim(); if (!name) return;
  try {
    const res = await fetch('/friends/request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionToken: mySessionToken, gameName: name }) });
    const data = await res.json();
    if (data.status === 'ok') { notify(`Request sent to ${name}`, 'info'); $('add-friend-input').value = ''; }
    else notify(data.error || 'Error', 'err');
  } catch (e) { notify('Network error', 'err'); }
}

async function respondFriend(from, action) {
  try {
    await fetch('/friends/respond', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionToken: mySessionToken, from, action }) });
    if (action === 'accept') notify(`You and ${from} are now friends! 🎉`, 'win');
    loadFriends();
  } catch (e) { }
}

function inviteFriend(gameName) {
  if (!myRoomId) return notify('Create or join a room first', 'err');
  if (isThrottled(`invite_${gameName}`, 1000)) return;
  socket.emit('inviteFriend', { targetGameName: gameName });
}
function spectateRoom(roomId) { isSpectator = true; clearGameSession(); socket.emit('spectateRoom', { roomId }); }

// ═══════════════════════════════════════════════
// RENAME MODAL
// ═══════════════════════════════════════════════
function showRenameModal() { if (!mySessionToken) return; $('rename-input').value = myGameName; $('rename-error').classList.add('hidden'); $('rename-modal').classList.remove('hidden'); setTimeout(() => $('rename-input').focus(), 100); }
function hideRenameModal() { $('rename-modal').classList.add('hidden'); }
function handleRenameOverlayClick(e) { if (e.target === $('rename-modal')) hideRenameModal(); }
async function submitRename() {
  const name = $('rename-input').value.trim(); if (!name) return;
  const btn = $('rename-submit-btn'); btn.disabled = true; btn.textContent = 'Saving…';
  try {
    const res = await fetch('/auth/rename', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionToken: mySessionToken, gameName: name }) });
    const data = await res.json();
    if (data.status === 'ok') {
      myGameName = data.gameName; $('nav-name').textContent = data.gameName;
      const auth = loadAuth(); if (auth) { auth.gameName = data.gameName; saveAuth(auth); }
      hideRenameModal(); notify(`Name changed to ${data.gameName} ✓`, 'win');
    } else { const err = $('rename-error'); err.textContent = data.error || 'Error'; err.classList.remove('hidden'); }
  } catch (e) { const err = $('rename-error'); err.textContent = 'Network error'; err.classList.remove('hidden'); }
  btn.disabled = false; btn.textContent = 'Save Name →';
}

// ═══════════════════════════════════════════════
// ROOM ACTIONS
// ═══════════════════════════════════════════════
function createRoom() { if (!socket) return; isSpectator = false; socket.emit('createRoom', { playerName: myGameName }); stopFriendsPoll(); startLobbyPoll(); }
function joinRoom() {
  const code = $('room-code-input').value.trim().toUpperCase();
  if (!code || code.length < 4) { showErr('menu-error', 'Enter a valid room code'); return; }
  isSpectator = false; socket.emit('joinRoom', { roomId: code, playerName: myGameName }); stopFriendsPoll(); startLobbyPoll();
}
function copyRoomCode() { navigator.clipboard.writeText(myRoomId).then(() => notify('Code copied!', 'info')); }
function startGame() { if (!chosenRounds || chosenRounds < 1) { notify('Select rounds first', 'err'); return; } socket.emit('startGame', { totalRounds: chosenRounds }); }

// ── Lobby invite panel ──
let _lobbyInvitePanelOpen = false;
function toggleLobbyInvitePanel() {
  const panel = $('lobby-invite-panel'); _lobbyInvitePanelOpen = !_lobbyInvitePanelOpen;
  if (_lobbyInvitePanelOpen) { panel.classList.remove('hidden'); refreshLobbyInvitePanel(); } else panel.classList.add('hidden');
}
async function refreshLobbyInvitePanel() {
  if (!_lobbyInvitePanelOpen || !mySessionToken || !myRoomId) return;
  try {
    const res = await fetch('/friends/list', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionToken: mySessionToken }) });
    const data = await res.json(); if (!data.friends) return;
    const el = $('lobby-invite-list'); if (!el) return;
    const roomPlayerNames = new Set();
    document.querySelectorAll('#player-list .player-item-name').forEach(el => roomPlayerNames.add(el.textContent));
    const available = data.friends.filter(f => f.online && !f.inGame && !roomPlayerNames.has(f.gameName));
    if (!available.length) { el.innerHTML = `<div style="color:var(--text2);font-size:.85rem;text-align:center;padding:.5rem 0;">No online friends to invite right now</div>`; return; }
    el.innerHTML = available.map(f => {
      const av = f.picture ? `<img src="${f.picture}" alt="" style="width:28px;height:28px;border-radius:50%;object-fit:cover;">` : `<div style="width:28px;height:28px;border-radius:50%;background:var(--bg);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;font-size:.85rem;font-weight:800;">${f.gameName[0].toUpperCase()}</div>`;
      return `<div class="lobby-invite-item">${av}<div style="flex:1;font-weight:700;font-size:.88rem;">${f.gameName}</div><button onclick="inviteFriend('${f.gameName}')" style="background:rgba(240,192,64,.15);border:1.5px solid var(--gold);color:var(--gold);border-radius:7px;padding:.28rem .65rem;font-family:'Baloo 2',cursive;font-size:.8rem;font-weight:700;cursor:pointer;">📨 Invite</button></div>`;
    }).join('');
  } catch (e) { }
}

// ═══════════════════════════════════════════════
// WAITING ROOM
// ═══════════════════════════════════════════════
function renderWaitingRoom(room) {
  $('player-list').innerHTML = room.players.map((p, i) => `<div class="player-item"><div class="player-avatar ${AVATAR_COLS[i % 7]}">${p.name[0].toUpperCase()}</div><div class="player-item-name">${p.name}</div>${p.isHost ? '<span class="badge">HOST</span>' : ''}${!p.connected ? '<span class="badge" style="background:var(--red)">OFFLINE</span>' : ''}${room.isHost && !p.isHost ? `<button onclick="kickPlayer(${i})" style="margin-left:auto;background:rgba(224,80,80,.15);border:1px solid var(--red);color:var(--red);border-radius:6px;padding:.2rem .5rem;font-size:.72rem;cursor:pointer;font-family:'Baloo 2',cursive;font-weight:700;">✕ Kick</button>` : ''}</div>`).join('');

  const si = $('spectator-info');
  if (room.spectatorCount > 0) { si.innerHTML = `<span style="display:inline-flex;align-items:center;gap:.3rem;"><svg width="13" height="13"><use href="#icon-eye"/></svg>${room.spectatorCount} spectator${room.spectatorCount > 1 ? 's' : ''} watching</span>`; si.classList.remove('hidden'); } else si.classList.add('hidden');

  const n = room.players.length, maxR = room.maxRounds || 0;
  if (!chosenRounds || chosenRounds > maxR) { chosenRounds = maxR; } maxRoundsAvailable = maxR;
  $('game-info-preview').textContent = n >= 2 ? `${n} players · up to ${maxR} rounds` : 'Need at least 2 players';

  if (room.isHost) { $('start-btn-wrap').classList.remove('hidden'); $('wait-msg').classList.add('hidden'); renderRoundsSelector(maxR); }
  else { $('start-btn-wrap').classList.add('hidden'); $('wait-msg').classList.remove('hidden'); }
}

function renderRoundsSelector(maxR) {
  $('chosen-rounds').textContent = chosenRounds; $('rounds-max-label').textContent = `/ ${maxR} max`;
  $('rounds-hint').textContent = `Cards: ${chosenRounds}→1 · Last trump: ${['♠', '♦', '♣', '♥'][(chosenRounds - 1) % 4]}`;
  const arrows = document.querySelectorAll('.rounds-arrow'); arrows[0].disabled = chosenRounds <= 1; arrows[1].disabled = chosenRounds >= maxR;
  const presets = [{ l: 'Full', v: maxR }, { l: '¾', v: Math.max(1, Math.round(maxR * .75)) }, { l: 'Half', v: Math.max(1, Math.round(maxR * .5)) }, { l: 'Quick', v: Math.max(1, Math.round(maxR * .25)) }];
  const seen = new Set();
  $('rounds-presets').innerHTML = presets.filter(p => { if (seen.has(p.v)) return false; seen.add(p.v); return true; }).map(p => `<button class="preset-btn ${chosenRounds === p.v ? 'active' : ''}" onclick="setRounds(${p.v})">${p.l} (${p.v})</button>`).join('');
}
function changeRounds(d) { chosenRounds = Math.max(1, Math.min(maxRoundsAvailable, chosenRounds + d)); renderRoundsSelector(maxRoundsAvailable); }
function setRounds(v) { chosenRounds = Math.max(1, Math.min(maxRoundsAvailable, v)); renderRoundsSelector(maxRoundsAvailable); }

// ═══════════════════════════════════════════════
// HAND MANAGEMENT
// ═══════════════════════════════════════════════
function syncCustomOrder(hand) {
  const ids = hand.map(c => c.id);
  customHandOrder = customHandOrder.filter(id => ids.includes(id));
  ids.forEach(id => { if (!customHandOrder.includes(id)) customHandOrder.push(id); });
}
function setSortMode(mode) {
  sortMode = mode; document.querySelectorAll('.sort-btn').forEach(b => b.classList.remove('active'));
  $('sort-' + mode)?.classList.add('active'); if (currentGameState) renderHand(currentGameState);
}
function getSortedHand(hand, trump) {
  if (sortMode === 'custom') return customHandOrder.map(id => hand.find(c => c.id === id)).filter(Boolean);
  const a = [...hand];
  if (sortMode === 'suit') a.sort((x, y) => SUIT_ORDER[x.suit] !== SUIT_ORDER[y.suit] ? SUIT_ORDER[x.suit] - SUIT_ORDER[y.suit] : RANK_ORDER[x.rank] - RANK_ORDER[y.rank]);
  else if (sortMode === 'value') a.sort((x, y) => RANK_ORDER[y.rank] - RANK_ORDER[x.rank]);
  else if (sortMode === 'trump') a.sort((x, y) => { const xt = x.suit === trump ? 1 : 0, yt = y.suit === trump ? 1 : 0; if (xt !== yt) return yt - xt; return SUIT_ORDER[x.suit] - SUIT_ORDER[y.suit] || RANK_ORDER[x.rank] - RANK_ORDER[y.rank]; });
  return a;
}
function moveCard(cardId, dir) {
  if (sortMode !== 'custom') { if (currentGameState) customHandOrder = getSortedHand(currentGameState.myHand, currentGameState.trumpSuit).map(c => c.id); setSortMode('custom'); return; }
  const i = customHandOrder.indexOf(cardId); if (i === -1) return;
  const ni = i + dir; if (ni < 0 || ni >= customHandOrder.length) return;
  [customHandOrder[i], customHandOrder[ni]] = [customHandOrder[ni], customHandOrder[i]];
  if (currentGameState) renderHand(currentGameState);
}

// ═══════════════════════════════════════════════
// GAME RENDER
// ═══════════════════════════════════════════════
function renderGameState(state) {
  showScreen('game-screen'); $('spec-badge').classList.add('hidden'); $('my-hand-section').classList.remove('hidden');
  if (state.state === 'bidding') { $('round-end-overlay').classList.add('hidden'); cancelPlay(); if (!currentGameState || currentGameState.currentRound !== state.currentRound) bidPanelOpen = false; }
  updateTopBar(state); renderSeats(state); renderTrick(state); renderTurnIndicator(state); renderHand(state); renderBidPanel(state); renderArrangeBanner(state);
}

function renderSpectatorState(state) {
  currentGameState = state; showScreen('game-screen'); $('spec-badge').classList.remove('hidden'); $('my-hand-section').classList.add('hidden');
  ['arrange-banner', 'bid-overlay', 'confirm-banner'].forEach(id => $(id).classList.add('hidden'));
  updateTopBar(state); renderSeats(state); renderTrick(state); renderTurnIndicator(state);
}

function updateTopBar(state) {
  const ts = $('top-trump-sym'); ts.textContent = SUIT_SYM[state.trumpSuit] || '?'; ts.className = `trump-symbol ${SUIT_COLORS[state.trumpSuit] || ''}`;
  $('top-trump-name').textContent = state.trumpName || state.trumpSuit || '—';
  $('top-round').textContent = state.currentRound + 1; $('top-total-rounds').textContent = state.totalRounds;
  $('top-cards').textContent = state.totalRounds - state.currentRound;
}

function renderSeats(state) {
  const myIdx = isSpectator ? -1 : myPlayerIndex, playerCount = state.players.length;
  const po = state.playerOrder || state.players.map((_, i) => i), sc = $('seats-container');
  const topCount = Math.ceil(playerCount / 2), topPlayers = po.slice(0, topCount), bottomPlayers = po.slice(topCount).reverse();
  let html = '<div class="seats-row">';
  topPlayers.forEach((pIdx, i) => { html += seatHTML(state, pIdx, myIdx); if (i < topPlayers.length - 1) html += '<div class="loop-arrow">→</div>'; });
  html += '</div>';
  if (bottomPlayers.length > 0) {
    html += '<div class="loop-sides"><div class="loop-arrow">↑</div><div class="loop-arrow">↓</div></div><div class="seats-row">';
    bottomPlayers.forEach((pIdx, i) => { html += seatHTML(state, pIdx, myIdx); if (i < bottomPlayers.length - 1) html += '<div class="loop-arrow">←</div>'; });
    html += '</div>';
  }
  sc.innerHTML = html;
}

function seatHTML(state, pIdx, myIdx) {
  const p = state.players[pIdx], isMine = pIdx === myIdx, isTurn = state.currentTurnIndex === pIdx, isOffline = !p.connected, canKick = isOffline && !isMine && !isSpectator;
  const cls = ['seat', isMine ? 'my-seat' : '', isTurn ? 'current-turn' : '', isOffline ? 'disconnected' : '', canKick ? 'kickable' : ''].filter(Boolean).join(' ');
  const clickAttr = canKick ? `onclick="voteKickOffline(${pIdx})"` : '';
  let meta = `<span class="m-score">${p.score || 0} pts</span>`;
  if (state.state === 'bidding') meta += p.bidReady ? ' · <span class="m-bid">✓ Ready</span>' : ' · thinking…';
  else if (['playing', 'round_end', 'game_over'].includes(state.state)) meta += ` · <span class="m-bid">Bid ${p.bid ?? '?'} · Won ${p.tricksWon || 0}</span>`;
  let kickBar = '';
  if (isOffline) {
    const kv = kickVoteState[pIdx];
    if (kv) kickBar = `<div class="kick-vote-bar"><span class="kick-vote-count">⚡ Kick ${kv.votes}/${kv.needed}</span></div>`;
    else if (canKick) kickBar = `<div class="kick-vote-bar"><span style="font-size:.58rem;color:var(--red);">OFFLINE · tap to kick</span></div>`;
  }
  return `<div class="${cls}" ${clickAttr}><div class="seat-avatar ${AVATAR_COLS[pIdx % 7]}">${p.name[0].toUpperCase()}${isTurn ? '<div class="turn-dot"></div>' : ''}</div><div class="seat-info"><div class="seat-name">${p.name}${isMine ? ' ★' : ''}${p.isHost ? ' ♛' : ''}</div><div class="seat-meta">${meta}</div>${kickBar}</div></div>`;
}

function renderTrick(state) {
  const el = $('trick-cards'), st = $('trick-status'), totalPlayers = state.players.length;
  const po = state.playerOrder || state.players.map((_, i) => i), leaderIdx = po.indexOf(state.currentLeader);
  const handOrder = []; for (let i = 0; i < totalPlayers; i++) handOrder.push(po[(leaderIdx + i) % po.length]);
  const isBidding = state.state === 'bidding'; let html = '';
  for (let i = 0; i < totalPlayers; i++) {
    const pIdx = handOrder[i], playerName = state.players[pIdx]?.name || '?', played = state.currentTrick.find(t => t.playerIndex === pIdx);
    const isWinner = trickWinData && trickWinData.winnerIndex === pIdx, isLoser = trickWinData && trickWinData.winnerIndex !== pIdx && played;
    const slotCls = ['trick-card-slot', isWinner ? 'winner-highlight' : '', isLoser ? 'loser-dim' : ''].filter(Boolean).join(' ');
    if (played) html += `<div class="${slotCls}" data-player="${pIdx}">${isWinner ? '<div class="winner-crown">★</div>' : ''}<div class="trick-player-name">${playerName}</div>${cardHTML(played.card, 'size-md', state.trumpSuit, false, false)}</div>`;
    else html += `<div class="trick-card-slot" data-player="${pIdx}"><div class="card-empty"></div>${!isBidding ? `<div class="trick-player-name">${playerName}</div>` : ''}</div>`;
  }
  el.innerHTML = html; st.textContent = state.leadSuit ? `Lead: ${SUIT_SYM[state.leadSuit]} ${state.leadSuit}` : '';
}

function renderTurnIndicator(state) {
  const el = $('turn-indicator');
  if (state.state !== 'playing') { el.textContent = ''; el.className = 'turn-indicator'; return; }
  const ti = state.currentTurnIndex; if (ti === null || ti === undefined) { el.textContent = ''; return; }
  const trickComplete = state.currentTrick && state.currentTrick.length >= state.players.length;
  if (trickComplete) { el.textContent = 'Resolving hand…'; el.className = 'turn-indicator other-turn'; return; }
  const myIdx = isSpectator ? -1 : myPlayerIndex;
  if (ti === myIdx) { el.textContent = '⚡ Your turn — play a card!'; el.className = 'turn-indicator my-turn'; }
  else { el.textContent = `Waiting for ${state.players[ti]?.name || '?'}…`; el.className = 'turn-indicator other-turn'; }
}

function renderHand(state) {
  if (isSpectator) return;
  const hand = state.myHand || [], visibleHand = hand.filter(c => !playedCardIds.has(c.id));
  const trickComplete = state.currentTrick && state.currentTrick.length >= state.players.length;
  const isMyTurn = state.state === 'playing' && state.currentTurnIndex === myPlayerIndex && !trickComplete;
  const hasLeadSuit = isMyTurn && state.currentTrick.length > 0 && visibleHand.some(c => c.suit === state.leadSuit);
  const sorted = getSortedHand(visibleHand, state.trumpSuit);
  $('my-hand').innerHTML = sorted.map((card, si) => {
    const isPlayable = isMyTurn && canPlayCard(card, state), isDisabled = !isMyTurn || (isMyTurn && !isPlayable), isSuitLocked = isMyTurn && hasLeadSuit && !isPlayable;
    return `<div class="card-slot"><div class="card-arrows"><button class="arrow-btn" onclick="moveCard('${card.id}',-1)" ${si === 0 ? 'disabled' : ''}>◀</button><button class="arrow-btn" onclick="moveCard('${card.id}',+1)" ${si === sorted.length - 1 ? 'disabled' : ''}>▶</button></div>${cardHTML(card, 'size-lg', state.trumpSuit, isPlayable, isDisabled, `selectCard('${card.id}')`, isSuitLocked)}</div>`;
  }).join('');
  const badge = $('hand-trump-badge'); badge.style.display = state.trumpSuit ? '' : 'none';
  if (state.trumpSuit) { const sym = $('hand-trump-sym'); if (sym) { sym.textContent = SUIT_SYM[state.trumpSuit] || ''; sym.className = SUIT_COLORS[state.trumpSuit] || ''; } }
}

function canPlayCard(card, state) {
  if (state.state !== 'playing' || state.currentTurnIndex !== myPlayerIndex) return false;
  const trickComplete = state.currentTrick && state.currentTrick.length >= state.players.length;
  if (trickComplete) return false;
  if (!state.currentTrick.length) return true;
  const hasLead = state.myHand.some(c => c.suit === state.leadSuit);
  return !hasLead || card.suit === state.leadSuit;
}

function cardHTML(card, size, trump, playable, disabled, onclick = '', suitLocked = false) {
  const sc = SUIT_COLORS[card.suit] || '', isTrump = card.suit === trump;
  const cls = ['card', size, sc, playable ? 'playable' : '', isTrump ? 'trump-card' : '', disabled ? 'disabled' : '', (disabled && suitLocked) ? 'suit-locked' : ''].filter(Boolean).join(' ');
  return `<div class="${cls}" id="card-${card.id}" ${onclick ? `onclick="${onclick}"` : ''}><div class="card-inner"><div class="card-rank">${card.rank}</div><div class="card-suit-sym">${SUIT_SYM[card.suit]}</div></div></div>`;
}

function renderArrangeBanner(state) {
  const banner = $('arrange-banner');
  if (state.state === 'bidding' && !state.myBidReady && !bidPanelOpen) {
    document.body.classList.add('banner-visible'); banner.classList.remove('hidden');
    const ow = state.players.filter((_, i) => i !== myPlayerIndex && !state.players[i]?.bidReady).length;
    $('arrange-banner-sub').textContent = ow > 0 ? `${ow} other${ow > 1 ? 's' : ''} also arranging` : 'Take your time to arrange';
  } else { document.body.classList.remove('banner-visible'); banner.classList.add('hidden'); }
}

function renderBidPanel(state) {
  if (state.state !== 'bidding') { $('bid-overlay').classList.add('hidden'); return; }
  if (!bidPanelOpen) return;
  const maxBid = state.totalRounds - state.currentRound;
  $('bid-subtitle').textContent = `Trump: ${SUIT_SYM[state.trumpSuit]} ${state.trumpName} · Bid 0–${maxBid}`;
  $('bid-buttons').innerHTML = Array.from({ length: maxBid + 1 }, (_, i) => `<button class="bid-btn ${selectedBid === i ? 'selected' : ''}" onclick="selectBid(${i})">${i}</button>`).join('');
  $('bid-status-chips').innerHTML = state.players.map((p, i) => `<div class="bid-status-chip ${p.bidReady ? 'ready' : 'waiting'}"><div class="dot"></div><span>${p.name}</span></div>`).join('');
  const cb = $('bid-confirm-btn'); cb.disabled = selectedBid === null; cb.textContent = selectedBid !== null ? `Confirm Bid: ${selectedBid}` : 'Select a bid';
}

// ═══════════════════════════════════════════════
// BID ACTIONS
// ═══════════════════════════════════════════════
function openBidPanel() { bidPanelOpen = true; selectedBid = null; $('arrange-banner').classList.add('hidden'); $('bid-overlay').classList.remove('hidden'); if (currentGameState) renderBidPanel(currentGameState); }
function closeBidPanel() { bidPanelOpen = false; $('bid-overlay').classList.add('hidden'); if (currentGameState) renderArrangeBanner(currentGameState); }
function selectBid(n) { selectedBid = n; if (currentGameState) renderBidPanel(currentGameState); }
function confirmBid() { if (selectedBid === null) return; socket.emit('submitBid', { bid: selectedBid }); bidPanelOpen = false; $('bid-overlay').classList.add('hidden'); selectedBid = null; }

// ═══════════════════════════════════════════════
// CARD PLAY
// ═══════════════════════════════════════════════
function selectCard(cardId) {
  if (!currentGameState || currentGameState.state !== 'playing' || currentGameState.currentTurnIndex !== myPlayerIndex) return;
  const card = currentGameState.myHand.find(c => c.id === cardId);
  if (!card || !canPlayCard(card, currentGameState)) return;
  document.querySelectorAll('.card.selected-to-play').forEach(c => c.classList.remove('selected-to-play'));
  $(`card-${cardId}`)?.classList.add('selected-to-play');
  pendingCardId = cardId; $('confirm-banner').classList.remove('hidden');
  $('confirm-banner-text').textContent = `Play ${card.rank} ${SUIT_SYM[card.suit]}?`;
  $('confirm-banner-card').innerHTML = cardHTML(card, 'size-sm', currentGameState.trumpSuit, false, false);
  document.body.classList.add('banner-visible');
}
function confirmPlay() { if (!pendingCardId) return; socket.emit('playCard', { cardId: pendingCardId }); cancelPlay(); }
function cancelPlay() { pendingCardId = null; document.querySelectorAll('.card.selected-to-play').forEach(c => c.classList.remove('selected-to-play')); $('confirm-banner')?.classList.add('hidden'); document.body.classList.remove('banner-visible'); }

// ═══════════════════════════════════════════════
// BANNERS / OVERLAYS
// ═══════════════════════════════════════════════
function showTrickWonBanner(w) {
  document.querySelectorAll('.trick-won-banner').forEach(e => e.remove());
  const el = document.createElement('div'); el.className = 'trick-won-banner'; el.textContent = `${w} wins the trick!`;
  document.body.appendChild(el); setTimeout(() => el.remove(), 1600);
}
function showYourTurnFlash() {
  document.querySelectorAll('.your-turn-flash').forEach(e => e.remove());
  const el = document.createElement('div'); el.className = 'your-turn-flash';
  el.innerHTML = '<div class="your-turn-flash-inner"><span>YOUR TURN!</span><small>Tap a card to play</small></div>';
  document.body.appendChild(el); setTimeout(() => el.remove(), 1400);
}
function showRoundEnd(ri, results) {
  $('round-end-overlay').classList.remove('hidden'); $('round-end-title').textContent = `Round ${ri + 1} Results`;
  $('round-end-results').innerHTML = results.sort((a, b) => b.points - a.points).map(r => {
    const hit = r.bid === r.actual, zero = r.bid === 0 && r.actual === 0;
    return `<div class="result-row"><div class="result-name">${r.name}</div><div class="result-bid">Bid ${r.bid} · Won ${r.actual}</div><div class="result-pts ${zero || hit ? 'hit' : 'miss'}">+${r.points}</div></div>`;
  }).join('');
}
function showScoreboard() {
  if (!currentGameState) return;
  $('score-overlay').classList.remove('hidden');
  const state = currentGameState, players = state.players, total = state.totalRounds;
  let thead = `<tr><th class="name-col">Round</th>${players.map(p => `<th>${p.name}</th>`).join('')}</tr>`, tbody = '';
  for (let r = 0; r < total; r++) {
    const played = r < state.roundScores.length, trump = TRUMP_SEQ[r % 4];
    let row = `<td class="name-cell"><div>${SUIT_SYM[trump]}</div><div style="font-size:.62rem;color:var(--text2)">${total - r}c</div></td>`;
    players.forEach((_, pi) => {
      if (!played) { row += '<td style="opacity:.2">·</td>'; return; }
      const res = state.roundScores[r]?.find(x => x.playerIndex === pi);
      if (!res) { row += '<td>—</td>'; return; }
      const hit = res.bid === res.actual, zero = res.bid === 0 && res.actual === 0;
      row += `<td class="pts-cell ${zero ? 'zero-bid' : hit ? 'hit' : 'miss'}" title="Bid ${res.bid}, Got ${res.actual}"><div style="font-size:.85rem;font-weight:700">+${res.points}</div><div style="font-size:.62rem;color:var(--text2)">${res.bid}→${res.actual}</div></td>`;
    });
    tbody += `<tr>${row}</tr>`;
  }
  let totalRow = `<td class="name-cell" style="font-weight:800">Total</td>`;
  players.forEach((_, pi) => { const t = state.roundScores.reduce((s, rnd) => { const r = rnd?.find(x => x.playerIndex === pi); return s + (r ? r.points : 0); }, 0); totalRow += `<td style="font-weight:800;color:var(--gold);font-size:1rem;text-align:center">${t}</td>`; });
  $('score-table-wrap').innerHTML = `<table class="score-table"><thead>${thead}</thead><tbody>${tbody}<tr class="total-row">${totalRow}</tr></tbody></table><p style="text-align:center;color:var(--text2);font-size:.75rem;margin-top:.7rem;">Green=hit · Red=missed · Gold=0bid0won=1pt</p>`;
}
function hideScoreboard() { $('score-overlay').classList.add('hidden'); }
function showGameOver(fs) {
  $('round-end-overlay').classList.add('hidden'); $('game-over-overlay').classList.remove('hidden');
  const paBtn = document.querySelector('[onclick="votePlayAgain()"]'); if (paBtn) { paBtn.disabled = false; paBtn.innerHTML = '<svg width="16" height="16" style="flex-shrink:0;vertical-align:middle;"><use href="#icon-refresh"/></svg> Play Again'; }
  $('winner-name').textContent = `★ ${fs[0].name} wins with ${fs[0].score} pts!`;
  $('podium-list').innerHTML = fs.map((p, i) => `<div class="podium-item"><div class="podium-rank">${['🥇', '🥈', '🥉'][i] || (i + 1) + '.'}</div><div class="podium-name">${p.name}</div><div class="podium-score">${p.score} pts</div></div>`).join('');
}

// ═══════════════════════════════════════════════
// MISC ACTIONS
// ═══════════════════════════════════════════════
function kickPlayer(idx) {
  if (isThrottled(`kick_${idx}`, 1000)) return;
  const playerItems = document.querySelectorAll('#player-list .player-item');
  if (playerItems[idx]) {
    playerItems[idx].style.opacity = '0.35';
    playerItems[idx].style.pointerEvents = 'none';
  }
  socket?.emit('kickPlayer', { playerIndex: idx });
}
function voteKickOffline(targetIndex) {
  if (!socket || !currentGameState) return;
  const target = currentGameState.players[targetIndex];
  if (!target || target.connected) return notify('Player is online', 'err');
  showKickConfirm(targetIndex, target.name);
}
function showKickConfirm(targetIndex, targetName) {
  dismissKickConfirm();
  const el = document.createElement('div'); el.className = 'kick-confirm-overlay'; el.id = 'kick-confirm-overlay';
  el.onclick = (e) => { if (e.target === el) dismissKickConfirm(); };
  el.innerHTML = `<div class="kick-confirm-panel"><h3>👢 Vote to Kick?</h3><p><strong>${targetName}</strong> is offline.<br>Vote to remove them from the game?</p><div class="kick-confirm-btns"><button class="kick-confirm-yes" onclick="confirmKickVote(${targetIndex})">Yes, Kick</button><button class="kick-confirm-no" onclick="dismissKickConfirm()">Cancel</button></div></div>`;
  document.body.appendChild(el);
}
function dismissKickConfirm() { document.getElementById('kick-confirm-overlay')?.remove(); }
function confirmKickVote(targetIndex) { dismissKickConfirm(); if (!socket) return; socket.emit('voteKickPlayer', { targetIndex }); }
function votePlayAgain() { socket?.emit('playAgain'); const b = document.querySelector('[onclick="votePlayAgain()"]'); if (b) { b.disabled = true; b.textContent = '✓ Voted!'; } }
function doEndGame() {
  clearGameSession(); if (socket) socket.emit('leaveRoom');
  myRoomId = null; myPlayerIndex = null; currentGameState = null; lastRoundEndShown = -1;
  matchPlayerCount = 0; trickWinData = null; playedCardIds = new Set(); chatMessages = []; unreadChat = 0; kickVoteState = {}; updateChatBadge();
  $('chat-fab').classList.add('hidden'); ['game-over-overlay', 'round-end-overlay', 'score-overlay'].forEach(id => $(id).classList.add('hidden'));
  showMenuAndLoad();
}
function confirmLeave() { $('leave-overlay').classList.remove('hidden'); }
function cancelLeave() { $('leave-overlay').classList.add('hidden'); }
function doLeave() {
  if (isThrottled('leave_room', 1000)) return;
  clearGameSession(); if (socket) socket.emit('leaveRoom');
  isSpectator = false; myRoomId = null; myPlayerIndex = null; currentGameState = null; lastRoundEndShown = -1;
  matchPlayerCount = 0; trickWinData = null; playedCardIds = new Set(); kickVoteState = {};
  chatMessages = []; unreadChat = 0; updateChatBadge(); $('chat-fab').classList.add('hidden');
  $('leave-overlay')?.classList.add('hidden');
  ['arrange-banner', 'bid-overlay', 'confirm-banner', 'round-end-overlay', 'score-overlay', 'game-over-overlay'].forEach(id => $(id)?.classList.add('hidden'));
  showMenuAndLoad();
}

// ═══════════════════════════════════════════════
// CHAT
// ═══════════════════════════════════════════════
function openChat() { chatOpen = true; unreadChat = 0; updateChatBadge(); $('chat-overlay').classList.remove('hidden'); renderChatMessages(); const msgEl = $('chat-messages'); msgEl.scrollTop = msgEl.scrollHeight; }
function closeChat() { chatOpen = false; $('chat-overlay').classList.add('hidden'); $('chat-input').blur(); }
function chatOverlayClick(e) { if (e.target === $('chat-overlay')) closeChat(); }
function sendChat() { const input = $('chat-input'), msg = (input.value || '').trim(); if (!msg || !socket) return; socket.emit('chatMessage', { message: msg }); input.value = ''; input.focus(); }
function onChatMessage(entry) {
  chatMessages.push(entry); if (chatMessages.length > 50) chatMessages.shift();
  if (chatOpen) { renderChatMessages(); const msgEl = $('chat-messages'); msgEl.scrollTop = msgEl.scrollHeight; }
  else { unreadChat++; updateChatBadge(); showChatBubble(entry); }
}
function updateChatBadge() { const badge = $('chat-unread'); if (!badge) return; if (unreadChat > 0) { badge.textContent = unreadChat > 9 ? '9+' : unreadChat; badge.classList.remove('hidden'); } else badge.classList.add('hidden'); }
function renderChatMessages() {
  const el = $('chat-messages');
  if (!chatMessages.length) { el.innerHTML = '<div class="chat-empty">No messages yet. Say hi! 👋</div>'; return; }
  el.innerHTML = chatMessages.map(m => {
    const pIdx = m.playerIndex ?? 0, col = AVATAR_COLS[Math.abs(pIdx) % 7], t = new Date(m.time), timeStr = t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return `<div class="chat-msg"><div class="chat-msg-avatar ${col}">${(m.name || '?')[0].toUpperCase()}</div><div class="chat-msg-body"><div class="chat-msg-name">${m.name}</div><div class="chat-msg-text">${escapeHTML(m.message)}</div></div><div class="chat-msg-time">${timeStr}</div></div>`;
  }).join('');
}
function escapeHTML(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function showChatBubble(entry) {
  const container = $('chat-bubbles'), el = document.createElement('div'); el.className = 'chat-bubble';
  el.innerHTML = `<div class="cb-name">${escapeHTML(entry.name)}</div><div class="cb-text">${escapeHTML(entry.message)}</div>`;
  container.appendChild(el);
  requestAnimationFrame(() => { while (container.scrollHeight > container.clientHeight && container.children.length > 1) container.removeChild(container.firstChild); });
  while (container.children.length > 4) container.removeChild(container.firstChild);
  setTimeout(() => { if (el.parentNode) el.remove(); }, 5000);
}

// ═══════════════════════════════════════════════
// INPUT EVENTS
// ═══════════════════════════════════════════════
$('room-code-input')?.addEventListener('input', e => { e.target.value = e.target.value.toUpperCase(); });
$('room-code-input')?.addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom(); });
$('game-name-input')?.addEventListener('keydown', e => { if (e.key === 'Enter') submitGameName(); });
$('add-friend-input')?.addEventListener('keydown', e => { if (e.key === 'Enter') sendFriendReq(); });
$('rename-input')?.addEventListener('keydown', e => { if (e.key === 'Enter') submitRename(); });
$('chat-input')?.addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); if (e.key === 'Escape') closeChat(); });

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && socket) {
    if (!socket.connected) { socket.connect(); }
    else { if (mySessionToken) socket.emit('authenticate', { sessionToken: mySessionToken }); const gs = loadGameSession(); if (gs) socket.emit('rejoinRoom', { roomId: gs.roomId, playerToken: gs.playerToken }); else { loadFriends(); refreshLobbyInvitePanel(); } }
  }
});
document.addEventListener('focus', () => { if (mySessionToken && !loadGameSession()) loadFriends(); });
window.addEventListener('online', () => { notify('Back online ✓', 'win'); if (socket && !socket.connected) socket.connect(); });
window.addEventListener('offline', () => notify('No internet connection', 'err'));

// ═══════════════════════════════════════════════
// BOOT
// ═══════════════════════════════════════════════
(async function boot() {
  const auth = loadAuth();
  if (auth?.sessionToken) {
    try {
      const res = await fetch('/auth/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionToken: auth.sessionToken }) });
      const data = await res.json();
      if (data.status === 'ok') { setAuthUser({ ...data, sessionToken: auth.sessionToken }); connectSocket(); return; }
    } catch (e) { }
    clearAuth();
  }
  hideLoading(); showScreen('home-screen');
})();
