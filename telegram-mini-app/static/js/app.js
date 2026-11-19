// Telegram Web App Client Logic
let tg = window.Telegram?.WebApp;
if (tg) {
  tg.expand();
  tg.ready();
}

// Extract table_id and user_id from Telegram initData or URL search params
const urlParams = new URLSearchParams(window.location.search);
// Default to lobby unless a specific room is targeted in URL query
let tableId = urlParams.get('table') || 'lobby';
let userChips = 1000;
let adminToken = urlParams.get('admin_token') || localStorage.getItem('poker_admin_token') || '';

let persistentUserId = localStorage.getItem('poker_persistent_user_id');
if (!persistentUserId) {
  persistentUserId = Math.floor(100000 + Math.random() * 900000);
  localStorage.setItem('poker_persistent_user_id', persistentUserId);
} else {
  persistentUserId = parseInt(persistentUserId);
}

// Telegram User info or Fallback
let currentUser = {
  id: persistentUserId,
  name: 'Player ' + (persistentUserId % 1000),
  avatar: ''
};

if (tg && tg.initDataUnsafe && tg.initDataUnsafe.user) {
  const u = tg.initDataUnsafe.user;
  currentUser.id = u.id;
  currentUser.name = u.first_name || u.username || ('User_' + u.id);
  currentUser.avatar = u.photo_url || '';
} else if (urlParams.get('user_id')) {
  currentUser.id = parseInt(urlParams.get('user_id'));
  currentUser.name = urlParams.get('name') || ('Player_' + currentUser.id);
}

let ws = null;
let currentGameState = null;
let reconnectTimer = null;
let isAdmin = false;
let availableTables = [];
let lastShownWinnerId = null;
let previousPlayerIds = new Set();
let turnTimerInterval = null;
let previousStage = null;
let previousCommunityCount = 0;
let previousInHand = false;
let previousLastLog = null;

// Sound Effects System (Hybrid Web Audio API + HTML5 Audio + Synth Fallback)
let audioCtx = null;
const audioBuffers = {};
const audioUrls = {
  card: '/static/audio/card.wav',
  chips: '/static/audio/chips.wav',
  fold: '/static/audio/fold.wav',
  community: '/static/audio/community.wav',
  win: '/static/audio/win.wav'
};
const html5AudioElements = {};

function initAudioSystem() {
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass && !audioCtx) {
      audioCtx = new AudioContextClass();
    }
  } catch (e) {
    console.warn('AudioContext init error:', e);
  }

  // Pre-load WAV audio files for both Web Audio API buffers and HTML5 Audio
  for (const [key, url] of Object.entries(audioUrls)) {
    try {
      const a = new Audio(url);
      a.preload = 'auto';
      html5AudioElements[key] = a;
    } catch (e) {}

    if (audioCtx) {
      fetch(url)
        .then(res => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.arrayBuffer();
        })
        .then(arrayBuffer => audioCtx.decodeAudioData(arrayBuffer))
        .then(decoded => {
          audioBuffers[key] = decoded;
          console.log(`[Audio] Preloaded buffer: ${key}`);
        })
        .catch(err => {
          console.log(`[Audio] Buffer fetch/decode note for ${key}:`, err.message);
        });
    }
  }
}

// User-gesture audio unlock for Telegram WebViews and mobile browsers
function resumeAudioContext() {
  if (!audioCtx) {
    initAudioSystem();
  }
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
}

// Keep audio unlocked on all user touches/clicks
['pointerdown', 'touchstart', 'click'].forEach(evt => {
  document.addEventListener(evt, resumeAudioContext, { passive: true });
});

// Initialize audio early
initAudioSystem();

function playSound(type) {
  try {
    resumeAudioContext();
    console.log(`[Audio] Playing sound: ${type}`);

    // Tier 1: Zero-latency Web Audio API AudioBuffer
    if (audioCtx && audioBuffers[type]) {
      const source = audioCtx.createBufferSource();
      const gainNode = audioCtx.createGain();
      gainNode.gain.value = 0.85;
      source.buffer = audioBuffers[type];
      source.connect(gainNode);
      gainNode.connect(audioCtx.destination);
      source.start(0);
      return;
    }

    // Tier 2: HTML5 Audio clone
    const audio = html5AudioElements[type];
    if (audio) {
      const clone = audio.cloneNode();
      clone.volume = 0.85;
      const p = clone.play();
      if (p !== undefined) {
        p.catch(() => {
          // If HTML5 Audio was blocked, fallback to oscillator synth
          synthesizeSoundFallback(type);
        });
        return;
      }
    }

    // Tier 3: Realtime Web Audio oscillator synth fallback
    synthesizeSoundFallback(type);
  } catch (e) {
    console.warn('playSound error:', e);
    synthesizeSoundFallback(type);
  }
}

function synthesizeSoundFallback(type) {
  try {
    if (!audioCtx) return;
    if (audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }
    const t = audioCtx.currentTime;
    if (type === 'card') {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(480, t);
      osc.frequency.linearRampToValueAtTime(140, t + 0.14);
      gain.gain.setValueAtTime(0.4, t);
      gain.gain.linearRampToValueAtTime(0.001, t + 0.14);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(t);
      osc.stop(t + 0.14);
    } else if (type === 'chips') {
      [2200, 2900].forEach((freq, idx) => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'sine';
        const startT = t + idx * 0.05;
        osc.frequency.setValueAtTime(freq, startT);
        gain.gain.setValueAtTime(0.35, startT);
        gain.gain.linearRampToValueAtTime(0.001, startT + 0.08);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start(startT);
        osc.stop(startT + 0.08);
      });
    } else if (type === 'fold') {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(160, t);
      osc.frequency.linearRampToValueAtTime(45, t + 0.2);
      gain.gain.setValueAtTime(0.4, t);
      gain.gain.linearRampToValueAtTime(0.001, t + 0.2);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(t);
      osc.stop(t + 0.2);
    } else if (type === 'community') {
      [523.25, 659.25, 783.99].forEach((freq, idx) => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'sine';
        const startT = t + idx * 0.06;
        osc.frequency.setValueAtTime(freq, startT);
        gain.gain.setValueAtTime(0.3, startT);
        gain.gain.linearRampToValueAtTime(0.001, startT + 0.3);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start(startT);
        osc.stop(startT + 0.3);
      });
    } else if (type === 'win') {
      [523.25, 659.25, 783.99, 1046.50].forEach((freq, idx) => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'triangle';
        const startT = t + idx * 0.12;
        osc.frequency.setValueAtTime(freq, startT);
        gain.gain.setValueAtTime(0.35, startT);
        gain.gain.linearRampToValueAtTime(0.001, startT + 0.45);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start(startT);
        osc.stop(startT + 0.45);
      });
    }
  } catch (e) {}
}

// Views
const viewLobby = document.getElementById('view-lobby');
const viewGame = document.getElementById('view-game');

// Lobby Elements
const lobbyUserAvatar = document.getElementById('lobby-user-avatar');
const lobbyUserName = document.getElementById('lobby-user-name');
const lobbyUserChips = document.getElementById('lobby-user-chips');
const lobbyRoomsContainer = document.getElementById('lobby-rooms-container');
const lobbyNewRoomName = document.getElementById('lobby-new-room-name');
const btnLobbyCreateRoom = document.getElementById('btn-lobby-create-room');
const btnLobbyAdmin = document.getElementById('btn-lobby-admin');
const btnBackLobby = document.getElementById('btn-back-lobby');

// UI Elements
const tableDisplayNameEl = document.getElementById('table-display-name');
const potAmountEl = document.getElementById('pot-amount');
const communityCardsEl = document.getElementById('community-cards');
const seatsContainerEl = document.getElementById('seats-container');
const stageBadgeEl = document.getElementById('stage-badge');
const gameLogEl = document.getElementById('game-log');
const controlsPlayingEl = document.getElementById('controls-playing');
const controlsWaitingEl = document.getElementById('controls-waiting');
const btnFold = document.getElementById('btn-fold');
const btnCall = document.getElementById('btn-call');
const btnCallLabel = document.getElementById('btn-call-label');
const btnRaise = document.getElementById('btn-raise');
const btnRaiseLabel = document.getElementById('btn-raise-label');
const raiseSlider = document.getElementById('raise-slider');
const raiseAmountVal = document.getElementById('raise-amount-val');
const btnStartGame = document.getElementById('btn-start-game');
const btnAddBot = document.getElementById('btn-add-bot');

// Winner Modal Elements
const modalWinner = document.getElementById('modal-winner');
const winHeadline = document.getElementById('win-headline');
const winPotTag = document.getElementById('win-pot-tag');
const winDesc = document.getElementById('win-desc');
const winShowdownHands = document.getElementById('win-showdown-hands');
const winActionsContainer = document.getElementById('win-actions-container');

// Admin & Modal Elements
const modalRooms = document.getElementById('modal-rooms');
const roomsListContainer = document.getElementById('rooms-list-container');
const btnTables = document.getElementById('btn-tables');
const btnCloseRooms = document.getElementById('btn-close-rooms');

const modalAdmin = document.getElementById('modal-admin');
const btnAdminPanel = document.getElementById('btn-admin-panel');
const btnCloseAdmin = document.getElementById('btn-close-admin');
const adminLoginBox = document.getElementById('admin-login-box');
const adminActionsBox = document.getElementById('admin-actions-box');
const adminPassInput = document.getElementById('admin-pass-input');
const btnAdminSubmitPass = document.getElementById('btn-admin-submit-pass');
const btnAdminForceStart = document.getElementById('btn-admin-force-start');
const btnAdminResetHand = document.getElementById('btn-admin-reset-hand');
const btnAdminCreateRoom = document.getElementById('btn-admin-create-room');
const adminNewRoomName = document.getElementById('admin-new-room-name');
const adminPlayersList = document.getElementById('admin-players-list');

function connectWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws?table_id=${tableId}&user_id=${currentUser.id}&name=${encodeURIComponent(currentUser.name)}&avatar=${encodeURIComponent(currentUser.avatar)}&admin_token=${encodeURIComponent(adminToken)}`;

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    console.log('Connected to Poker Game Server');
    if (reconnectTimer) clearTimeout(reconnectTimer);
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'init') {
        if (msg.is_admin) setAdminAuthorized(true);
        if (msg.chips !== undefined) updateLobbyBalance(msg.chips);
        if (msg.tables) renderRoomsList(msg.tables);
        updateActiveView();
      } else if (msg.type === 'state') {
        renderGameState(msg.data);
      } else if (msg.type === 'tables_list') {
        renderRoomsList(msg.tables);
      } else if (msg.type === 'admin_auth_success') {
        setAdminAuthorized(true);
      } else if (msg.type === 'admin_logout_success') {
        setAdminAuthorized(false);
      } else if (msg.type === 'room_created') {
        switchTable(msg.table_id);
      } else if (msg.type === 'kicked') {
        alert(msg.message || 'You have been kicked from the table.');
        switchTable('lobby');
      } else if (msg.type === 'room_deleted') {
        alert(msg.message || 'This room was deleted. Returning to lobby.');
        switchTable('lobby');
      } else if (msg.type === 'error_redirect_lobby') {
        alert(msg.message || 'Cannot join room.');
        switchTable('lobby');
      } else if (msg.type === 'error') {
        alert(msg.message);
      }
    } catch (e) {
      console.error('Error parsing WS message:', e);
    }
  };

  ws.onclose = () => {
    console.log('WS connection closed. Reconnecting in 2s...');
    reconnectTimer = setTimeout(connectWebSocket, 2000);
  };

  ws.onerror = (err) => {
    console.error('WS error:', err);
  };
}

function sendAction(action, raiseAmount = 0) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({
    type: 'action',
    action: action,
    raise_amount: raiseAmount
  }));
}

function renderCard(card, isSmall = false) {
  if (!card) return '';
  if (card.hidden) {
    return `<div class="poker-card back ${isSmall ? 'small' : ''}"><div class="card-pattern"></div></div>`;
  }
  const suitClass = (card.suit === 'h' || card.suit === 'd') ? 'suit-h' : 'suit-s';
  return `
    <div class="poker-card ${suitClass} ${isSmall ? 'small' : ''}">
      <div class="card-top">
        <span>${card.rank_name}</span>
        <span>${card.suit_symbol}</span>
      </div>
      <div class="card-suit-big">${card.suit_symbol}</div>
      <div class="card-bottom">
        <span>${card.rank_name}</span>
        <span>${card.suit_symbol}</span>
      </div>
    </div>
  `;
}

function renderGameState(state) {
  currentGameState = state;

  tableDisplayNameEl.innerText = state.name ? `♠ ${state.name.toUpperCase()}` : '♠ TEXAS HOLD\'EM';
  stageBadgeEl.innerText = state.stage;
  potAmountEl.innerText = state.pot;
  gameLogEl.innerHTML = `<span>${state.last_log || 'Waiting for action...'}</span>`;

  // Community Cards
  if (state.community_cards && state.community_cards.length > 0) {
    communityCardsEl.innerHTML = state.community_cards.map(c => renderCard(c)).join('');
  } else {
    communityCardsEl.innerHTML = `<span style="color: rgba(255,255,255,0.3); font-size: 13px;">No community cards</span>`;
  }

  // Seats & Players
  const players = state.players || [];
  let userIdx = players.findIndex(p => p.user_id === currentUser.id);
  if (userIdx === -1) userIdx = 0;

  const currentIds = new Set(players.map(p => p.user_id));

  // Check if any previous players left - animate them out
  previousPlayerIds.forEach(oldId => {
    if (!currentIds.has(oldId)) {
      const existingEl = document.getElementById(`seat-player-${oldId}`);
      if (existingEl) {
        existingEl.classList.add('seat-leaving');
        setTimeout(() => {
          if (existingEl.parentNode) existingEl.parentNode.removeChild(existingEl);
        }, 380);
      }
    }
  });

  const numPlayers = players.length;

  for (let i = 0; i < numPlayers; i++) {
    const relPos = (i - userIdx + 6) % 6;
    const player = players[i];
    const isTurn = state.in_hand && (i === state.turn_idx);
    const isDealer = state.in_hand && (i === state.dealer_idx);
    const isNewJoin = !previousPlayerIds.has(player.user_id);

    let seatEl = document.getElementById(`seat-player-${player.user_id}`);
    const isCreating = !seatEl;
    if (isCreating) {
      seatEl = document.createElement('div');
      seatEl.id = `seat-player-${player.user_id}`;
    }

    seatEl.className = `seat seat-${relPos} ${isTurn ? 'active-turn' : ''} ${isNewJoin ? 'seat-joining' : ''}`;

    let handHtml = '';
    if (player.hand && player.hand.length > 0) {
      handHtml = `
        <div class="player-hand-preview">
          ${player.hand.map(c => renderCard(c, true)).join('')}
        </div>
      `;
    }

    let betChipHtml = player.current_bet > 0 
      ? `<div class="player-bet-chip">🪙 ${player.current_bet}</div>` 
      : '';

    let foldBadgeHtml = player.folded 
      ? `<div class="player-folded-badge">FOLDED</div>` 
      : '';

    let dealerHtml = isDealer ? `<div class="dealer-button">D</div>` : '';

    const canKickOthers = (isAdmin || (state.creator_id && state.creator_id === currentUser.id)) && player.user_id !== currentUser.id;
    let kickBtnHtml = canKickOthers ? `<button class="seat-kick-btn" onclick="event.stopPropagation(); kickPlayer(${player.user_id}, '${player.name}')">×</button>` : '';

    let avatarImg = player.avatar 
      ? `<img src="${player.avatar}" alt="${player.name}"/>` 
      : (player.is_bot ? '🤖' : '👤');

    let timerBadgeHtml = isTurn ? `<div class="seat-timer-badge" id="seat-timer-${player.user_id}">25s</div>` : '';

    seatEl.innerHTML = `
      ${betChipHtml}
      ${kickBtnHtml}
      <div class="player-avatar-box">
        <div class="player-avatar">${avatarImg}</div>
        ${dealerHtml}
        ${timerBadgeHtml}
      </div>
      ${foldBadgeHtml}
      <div class="player-info-pill">
        <div class="player-name">${player.name}${player.user_id === currentUser.id ? ' (You)' : ''}</div>
        <div class="player-chips">🪙 ${player.chips}</div>
      </div>
      ${handHtml}
    `;

    if (isCreating) {
      seatsContainerEl.appendChild(seatEl);
    }
  }

  previousPlayerIds = currentIds;

  // Update 25s Countdown Timer on active turn seat
  if (turnTimerInterval) {
    clearInterval(turnTimerInterval);
    turnTimerInterval = null;
  }

  if (state.in_hand && state.turn_deadline) {
    const updateCountdown = () => {
      const now = Date.now() / 1000;
      const remaining = Math.max(0, Math.ceil(state.turn_deadline - now));
      const activeTimerEl = document.getElementById(`seat-timer-${state.turn_user_id}`);
      if (activeTimerEl) {
        activeTimerEl.innerText = `${remaining}s`;
        if (remaining <= 5) {
          activeTimerEl.classList.add('urgent');
        } else {
          activeTimerEl.classList.remove('urgent');
        }
      }
      // If it's my turn and countdown reached 0, auto-fold client-side as safeguard
      if (remaining <= 0 && state.turn_user_id === currentUser.id && state.in_hand) {
        sendAction('fold');
      }
    };
    updateCountdown();
    turnTimerInterval = setInterval(updateCountdown, 500);
  }

  // Audio Triggers based on State Changes
  const communityCount = (state.community_cards || []).length;
  if (!previousInHand && state.in_hand) {
    playSound('card'); // Deal starting hands
  } else if (communityCount > previousCommunityCount) {
    playSound('community'); // Flop, Turn, or River deal
  }

  // Detect actions from any player or bot via state.last_log
  if (state.last_log && state.last_log !== previousLastLog) {
    const log = state.last_log.toLowerCase();
    if (log.includes('folded')) {
      playSound('fold');
    } else if (log.includes('called') || log.includes('raised') || log.includes('checked') || log.includes('blind')) {
      playSound('chips');
    }
    previousLastLog = state.last_log;
  }

  previousInHand = state.in_hand;
  previousCommunityCount = communityCount;
  previousStage = state.stage;

  // Action Panel Controls
  const isMyTurn = state.in_hand && (state.turn_user_id === currentUser.id);

  if (state.in_hand) {
    controlsPlayingEl.style.display = 'flex';
    controlsWaitingEl.style.display = 'none';

    btnFold.disabled = !isMyTurn;
    btnCall.disabled = !isMyTurn;
    btnRaise.disabled = !isMyTurn;
    raiseSlider.disabled = !isMyTurn;

    const toCall = state.to_call || 0;
    if (toCall === 0) {
      btnCallLabel.innerText = 'Check';
    } else {
      btnCallLabel.innerText = `Call (${toCall})`;
    }

    // Configure Raise Slider from 0 / step all the way up to ALL-IN (player's full chips)
    const myPlayer = players.find(p => p.user_id === currentUser.id);
    const maxChipsAvailable = myPlayer ? myPlayer.chips : 1000;
    const maxRaise = Math.max(0, maxChipsAvailable - toCall);
    const raiseStep = state.raise_step || 20;

    raiseSlider.min = 0;
    raiseSlider.max = maxRaise;
    raiseSlider.step = Math.min(raiseStep, Math.max(1, maxRaise));

    if (parseInt(raiseSlider.value) > maxRaise || parseInt(raiseSlider.value) === 0) {
      raiseSlider.value = Math.min(raiseStep, maxRaise);
    }

    const curVal = parseInt(raiseSlider.value);
    if (curVal >= maxRaise && maxRaise > 0) {
      raiseAmountVal.innerText = `ALL IN (${curVal})`;
      btnRaiseLabel.innerText = `ALL IN (${curVal})`;
    } else {
      raiseAmountVal.innerText = `+${curVal}`;
      btnRaiseLabel.innerText = `Raise (+${curVal})`;
    }
    btnRaise.disabled = !isMyTurn || maxRaise === 0;
  } else {
    controlsPlayingEl.style.display = 'none';
    controlsWaitingEl.style.display = 'block';

    const canManageRoom = isAdmin || (state.creator_id && state.creator_id === currentUser.id);

    // Hide or show the + Bot button depending on room permissions
    if (btnAddBot) {
      btnAddBot.style.display = canManageRoom ? 'inline-block' : 'none';
    }

    if (!canManageRoom) {
      btnStartGame.disabled = true;
      btnStartGame.innerText = `Waiting for creator to start... (${players.length} Players)`;
    } else {
      btnStartGame.disabled = players.length < 2;
      btnStartGame.innerText = players.length < 2 
        ? `Waiting for players (${players.length}/2 min)...` 
        : `Deal New Hand (${players.length} Players)`;
    }
  }

  // Check for winner celebration screen
  if (state.winner_info) {
    const winnerKey = JSON.stringify(state.winner_info);
    if (lastShownWinnerId !== winnerKey) {
      lastShownWinnerId = winnerKey;
      showWinnerModal(state.winner_info);
    }
  } else {
    modalWinner.style.display = 'none';
  }

  if (isAdmin) {
    renderAdminPlayers(players);
  }
}

function showWinnerModal(winInfo) {
  playSound('win');
  const winnerNames = winInfo.winners ? winInfo.winners.join(', ') : 'Player';
  winHeadline.innerText = `🏆 ${winnerNames} WON!`;
  winPotTag.innerText = `+${winInfo.pot} 🪙 POT`;
  winDesc.innerText = winInfo.description || 'Won the pot!';

  if (winInfo.type === 'showdown' && winInfo.hands && winInfo.hands.length > 0) {
    winShowdownHands.style.display = 'flex';
    winShowdownHands.innerHTML = winInfo.hands.map(h => `
      <div class="win-hand-item">
        <span style="font-weight:700;">${h.name}</span>
        <span style="color:var(--gold);">${h.desc}</span>
      </div>
    `).join('');
  } else {
    winShowdownHands.style.display = 'none';
  }

  // Populate dynamic action buttons based on player role
  const isCreatorOrAdmin = isAdmin || (currentGameState && currentGameState.creator_id === currentUser.id);

  if (isCreatorOrAdmin) {
    winActionsContainer.innerHTML = `
      <button class="modal-btn secondary-btn" onclick="onWinBackToLobby()" style="flex:1;">Back to Lobby</button>
      <button class="modal-btn win-btn" onclick="onWinStartNewGame()" style="flex:1.2;">Create New Game</button>
    `;
  } else {
    winActionsContainer.innerHTML = `
      <button class="modal-btn secondary-btn" onclick="onWinBackToLobby()" style="flex:1;">Back to Lobby</button>
      <button class="modal-btn win-btn" onclick="onWinStayInGame()" style="flex:1;">Stay in Game</button>
    `;
  }

  modalWinner.style.display = 'flex';
}

window.onWinBackToLobby = function() {
  modalWinner.style.display = 'none';
  switchTable('lobby');
};

window.onWinStayInGame = function() {
  modalWinner.style.display = 'none';
};

window.onWinStartNewGame = function() {
  modalWinner.style.display = 'none';
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'start_game' }));
  }
};

function updateAdminButtonsVisibility() {
  if (isAdmin) {
    // If user is admin, show admin control buttons everywhere (lobby & in-game)
    if (btnLobbyAdmin) btnLobbyAdmin.style.display = 'inline-block';
    if (btnAdminPanel) btnAdminPanel.style.display = 'inline-block';
  } else {
    // If not admin, only show the Admin login button in the main lobby menu
    if (btnLobbyAdmin) btnLobbyAdmin.style.display = 'inline-block';
    if (btnAdminPanel) btnAdminPanel.style.display = 'none';
  }
}

function updateActiveView() {
  if (tableId === 'lobby') {
    viewLobby.style.display = 'flex';
    viewGame.style.display = 'none';
  } else {
    viewLobby.style.display = 'none';
    viewGame.style.display = 'flex';
  }
  updateAdminButtonsVisibility();
}

function updateLobbyBalance(chips) {
  userChips = chips;
  lobbyUserChips.innerText = Number(chips).toLocaleString();
  lobbyUserName.innerText = currentUser.name;
  if (currentUser.avatar) {
    lobbyUserAvatar.innerHTML = `<img src="${currentUser.avatar}" alt="${currentUser.name}"/>`;
  }
}

function renderRoomsList(tables) {
  availableTables = tables || [];
  
  // Render to both containers: modal rooms container and main lobby container
  [roomsListContainer, lobbyRoomsContainer].forEach(container => {
    if (!container) return;
    container.innerHTML = '';
    
    if (availableTables.length === 0) {
      container.innerHTML = '<div style="color:var(--text-muted); font-size:12px; text-align:center; padding:15px;">No active tables found. Create one above!</div>';
      return;
    }

    availableTables.forEach(t => {
      const item = document.createElement('div');
      item.className = 'room-item';
      const isCurrent = t.table_id === tableId;
      const canDelete = isAdmin || (t.creator_id && t.creator_id === currentUser.id);

      // Build player profiles preview under room name
      let playersHtml = '';
      if (t.players && t.players.length > 0) {
        const tags = t.players.map(p => {
          const avatar = p.avatar 
            ? `<img src="${p.avatar}" alt="${p.name}"/>` 
            : (p.is_bot ? '🤖' : '👤');
          return `
            <div class="room-player-tag">
              <span class="room-player-avatar-small">${avatar}</span>
              <span>${p.name}</span>
            </div>
          `;
        }).join('');
        playersHtml = `<div class="room-players-preview">${tags}</div>`;
      } else {
        playersHtml = `<div class="room-players-preview" style="color:var(--text-muted); font-size:11px;">No players yet (Table empty)</div>`;
      }

      item.innerHTML = `
        <div class="room-header">
          <div class="room-info">
            <div class="room-name">${t.name} ${isCurrent ? '<span style="color:var(--gold); font-size:11px;">(Current)</span>' : ''}</div>
            <div class="room-sub">${t.player_count}/6 players • Stage: ${t.stage} • Pot: ${t.pot}🪙</div>
          </div>
          <div style="display:flex; gap:6px;">
            ${!isCurrent ? `<button class="room-action-btn" onclick="switchTable('${t.table_id}')">Join Table</button>` : `<button class="room-action-btn" style="background:var(--gold); color:#000;" onclick="switchTable('${t.table_id}')">Re-enter</button>`}
            ${canDelete && !isCurrent ? `<button class="room-action-btn danger" onclick="deleteTable('${t.table_id}')">Delete</button>` : ''}
          </div>
        </div>
        ${playersHtml}
      `;
      container.appendChild(item);
    });
  });
}

window.switchTable = function(newTableId) {
  tableId = newTableId;
  modalRooms.style.display = 'none';
  if (ws) ws.close();
  connectWebSocket();
};

window.deleteTable = function(delTableId) {
  if (confirm(`Delete table ${delTableId}?`)) {
    ws.send(JSON.stringify({ type: 'delete_room', table_id: delTableId }));
  }
};

function setAdminAuthorized(authorized) {
  isAdmin = authorized;
  if (authorized) {
    adminLoginBox.style.display = 'none';
    adminActionsBox.style.display = 'block';
    btnAdminPanel.style.borderColor = 'var(--gold)';
    btnAdminPanel.style.color = 'var(--gold)';
    if (currentGameState) renderAdminPlayers(currentGameState.players || []);
  } else {
    adminLoginBox.style.display = 'block';
    adminActionsBox.style.display = 'none';
    btnAdminPanel.style.borderColor = 'rgba(255, 255, 255, 0.15)';
    btnAdminPanel.style.color = '#fff';
    localStorage.removeItem('poker_admin_token');
    adminToken = '';
  }
  updateAdminButtonsVisibility();
  // Refresh rooms list so delete buttons reflect admin status
  renderRoomsList(availableTables);
}

function renderAdminPlayers(players) {
  adminPlayersList.innerHTML = '';
  if (!players || players.length === 0) {
    adminPlayersList.innerHTML = '<div style="color:var(--text-muted); font-size:12px;">No players at this table.</div>';
    return;
  }

  players.forEach(p => {
    const row = document.createElement('div');
    row.className = 'admin-player-row';
    row.innerHTML = `
      <div>
        <span style="font-weight:700;">${p.name}</span>
        <span style="font-size:11px; color:var(--text-muted);">(${p.chips} 🪙)</span>
      </div>
      <div style="display:flex; gap:4px;">
        <button class="admin-chip-btn" onclick="promptSetChips(${p.user_id}, ${p.chips})">✏️ Chips</button>
        <button class="admin-kick-btn" onclick="adminKickPlayer(${p.user_id}, '${p.name}')">❌ Kick</button>
      </div>
    `;
    adminPlayersList.appendChild(row);
  });
}

window.promptSetChips = function(userId, currentChips) {
  const val = prompt('Set new chip amount:', currentChips);
  if (val !== null && !isNaN(val)) {
    ws.send(JSON.stringify({
      type: 'admin_set_chips',
      user_id: userId,
      chips: parseInt(val)
    }));
  }
};

window.adminKickPlayer = function(userId, name) {
  kickPlayer(userId, name);
};

window.kickPlayer = function(userId, name) {
  if (confirm(`Kick ${name} from this room?`)) {
    ws.send(JSON.stringify({
      type: 'kick_player',
      user_id: userId
    }));
  }
};

// Event Listeners
btnFold.addEventListener('click', () => {
  playSound('fold');
  sendAction('fold');
});

btnCall.addEventListener('click', () => {
  playSound('chips');
  sendAction('call');
});

btnRaise.addEventListener('click', () => {
  playSound('chips');
  const raiseVal = parseInt(raiseSlider.value) || 20;
  sendAction('raise', raiseVal);
});

raiseSlider.addEventListener('input', (e) => {
  const val = parseInt(e.target.value);
  const max = parseInt(e.target.max);
  if (val >= max && max > 0) {
    raiseAmountVal.innerText = `ALL IN (${val})`;
    btnRaiseLabel.innerText = `ALL IN (${val})`;
  } else {
    raiseAmountVal.innerText = `+${val}`;
    btnRaiseLabel.innerText = `Raise (+${val})`;
  }
});

btnStartGame.addEventListener('click', () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'start_game' }));
  }
});

btnAddBot.addEventListener('click', () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'add_bot' }));
  }
});

// Lobby Action Listeners
btnLobbyCreateRoom.addEventListener('click', () => {
  const name = lobbyNewRoomName.value.trim();
  if (name) {
    ws.send(JSON.stringify({ type: 'create_room', name: name }));
    lobbyNewRoomName.value = '';
  }
});

btnLobbyAdmin.addEventListener('click', () => {
  adminPassInput.value = '';
  modalAdmin.style.display = 'flex';
});

btnBackLobby.addEventListener('click', () => {
  switchTable('lobby');
});

// Room Creation & Admin Logout Elements
const playerNewRoomName = document.getElementById('player-new-room-name');
const btnPlayerCreateRoom = document.getElementById('btn-player-create-room');
const btnAdminLogout = document.getElementById('btn-admin-logout');

// Player Create Room Listener
btnPlayerCreateRoom.addEventListener('click', () => {
  const name = playerNewRoomName.value.trim();
  if (name) {
    ws.send(JSON.stringify({ type: 'create_room', name: name }));
    playerNewRoomName.value = '';
  }
});

// Admin Logout Listener
btnAdminLogout.addEventListener('click', () => {
  if (confirm('Log out from administrator role?')) {
    ws.send(JSON.stringify({ type: 'admin_logout' }));
    setAdminAuthorized(false);
    modalAdmin.style.display = 'none';
  }
});

// Modals Open/Close
btnTables.addEventListener('click', () => { modalRooms.style.display = 'flex'; });
btnCloseRooms.addEventListener('click', () => { modalRooms.style.display = 'none'; });

btnAdminPanel.addEventListener('click', () => { 
  adminPassInput.value = '';
  modalAdmin.style.display = 'flex'; 
});
btnCloseAdmin.addEventListener('click', () => { modalAdmin.style.display = 'none'; });

// Admin Password Form
btnAdminSubmitPass.addEventListener('click', () => {
  const pass = adminPassInput.value.trim();
  if (pass) {
    adminToken = pass;
    localStorage.setItem('poker_admin_token', pass);
    ws.send(JSON.stringify({ type: 'admin_auth', token: pass }));
  }
});

btnAdminForceStart.addEventListener('click', () => {
  ws.send(JSON.stringify({ type: 'admin_force_start' }));
});

btnAdminResetHand.addEventListener('click', () => {
  if (confirm('Reset this table to initial state?')) {
    ws.send(JSON.stringify({ type: 'admin_reset_hand' }));
  }
});

btnAdminCreateRoom.addEventListener('click', () => {
  const name = adminNewRoomName.value.trim();
  if (name) {
    const id = 'room_' + Math.floor(100 + Math.random() * 900);
    ws.send(JSON.stringify({ type: 'admin_create_table', table_id: id, name: name }));
    adminNewRoomName.value = '';
    alert(`Created room "${name}"!`);
  }
});

// Initialize on page load
connectWebSocket();
