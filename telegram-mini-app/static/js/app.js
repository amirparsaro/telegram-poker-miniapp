// Telegram Web App Client Logic
let tg = window.Telegram?.WebApp;
if (tg) {
  tg.expand();
  tg.ready();
}

// Extract table_id and user_id from Telegram initData or URL search params
const urlParams = new URLSearchParams(window.location.search);
let tableId = urlParams.get('table') || 'main_room';
let adminToken = urlParams.get('admin_token') || localStorage.getItem('poker_admin_token') || '';

// Telegram User info or Fallback
let currentUser = {
  id: Math.floor(100000 + Math.random() * 900000),
  name: 'Player ' + Math.floor(10 + Math.random() * 90),
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
const btnWinNextHand = document.getElementById('btn-win-next-hand');

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
        if (msg.tables) renderRoomsList(msg.tables);
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

  seatsContainerEl.innerHTML = '';
  const numPlayers = players.length;

  for (let i = 0; i < numPlayers; i++) {
    const relPos = (i - userIdx + 6) % 6;
    const player = players[i];
    const isTurn = state.in_hand && (i === state.turn_idx);
    const isDealer = state.in_hand && (i === state.dealer_idx);

    const seatEl = document.createElement('div');
    seatEl.className = `seat seat-${relPos} ${isTurn ? 'active-turn' : ''}`;

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

    let avatarImg = player.avatar 
      ? `<img src="${player.avatar}" alt="${player.name}"/>` 
      : (player.is_bot ? '🤖' : '👤');

    seatEl.innerHTML = `
      ${betChipHtml}
      <div class="player-avatar-box">
        <div class="player-avatar">${avatarImg}</div>
        ${dealerHtml}
      </div>
      ${foldBadgeHtml}
      <div class="player-info-pill">
        <div class="player-name">${player.name}${player.user_id === currentUser.id ? ' (You)' : ''}</div>
        <div class="player-chips">🪙 ${player.chips}</div>
      </div>
      ${handHtml}
    `;

    seatsContainerEl.appendChild(seatEl);
  }

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

    const raiseStep = state.raise_step || 20;
    raiseSlider.min = raiseStep;
    raiseSlider.step = raiseStep;
    raiseAmountVal.innerText = `+${raiseSlider.value}`;
  } else {
    controlsPlayingEl.style.display = 'none';
    controlsWaitingEl.style.display = 'block';

    btnStartGame.disabled = players.length < 2;
    btnStartGame.innerText = players.length < 2 
      ? `Waiting for players (${players.length}/2 min)...` 
      : `Deal New Hand (${players.length} Players)`;
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

  modalWinner.style.display = 'flex';
}

function renderRoomsList(tables) {
  availableTables = tables || [];
  roomsListContainer.innerHTML = '';
  
  if (availableTables.length === 0) {
    roomsListContainer.innerHTML = '<div style="color:var(--text-muted); font-size:12px; text-align:center; padding:10px;">No rooms found.</div>';
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
          ${!isCurrent ? `<button class="room-action-btn" onclick="switchTable('${t.table_id}')">Join</button>` : ''}
          ${canDelete && !isCurrent ? `<button class="room-action-btn danger" onclick="deleteTable('${t.table_id}')">Delete</button>` : ''}
        </div>
      </div>
      ${playersHtml}
    `;
    roomsListContainer.appendChild(item);
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
  if (confirm(`Remove ${name} from this table?`)) {
    ws.send(JSON.stringify({
      type: 'admin_remove_player',
      user_id: userId
    }));
  }
};

// Event Listeners
btnFold.addEventListener('click', () => sendAction('fold'));
btnCall.addEventListener('click', () => sendAction('call'));
btnRaise.addEventListener('click', () => {
  const raiseVal = parseInt(raiseSlider.value) || 20;
  sendAction('raise', raiseVal);
});

raiseSlider.addEventListener('input', (e) => {
  raiseAmountVal.innerText = `+${e.target.value}`;
  btnRaiseLabel.innerText = `Raise (+${e.target.value})`;
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

// Win Screen Dismiss & Auto Next Hand
btnWinNextHand.addEventListener('click', () => {
  modalWinner.style.display = 'none';
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'start_game' }));
  }
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
