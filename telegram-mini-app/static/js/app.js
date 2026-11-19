// Telegram Web App Client Logic
let tg = window.Telegram?.WebApp;
if (tg) {
  tg.expand();
  tg.ready();
}

// Extract table_id and user_id from Telegram initData or URL search params
const urlParams = new URLSearchParams(window.location.search);
const tableId = urlParams.get('table') || 'main_room';

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

// UI Elements
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

function connectWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws?table_id=${tableId}&user_id=${currentUser.id}&name=${encodeURIComponent(currentUser.name)}&avatar=${encodeURIComponent(currentUser.avatar)}`;

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    console.log('Connected to Poker Game Server');
    if (reconnectTimer) clearTimeout(reconnectTimer);
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'state') {
        renderGameState(msg.data);
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

  // Header & Pot
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
  // We arrange seats so current user is always seat-0 (bottom)
  const players = state.players || [];
  let userIdx = players.findIndex(p => p.user_id === currentUser.id);
  if (userIdx === -1) userIdx = 0;

  seatsContainerEl.innerHTML = '';
  const numPlayers = players.length;

  for (let i = 0; i < numPlayers; i++) {
    // Relative position
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

    // Configure Raise slider
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
}

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

// Initialize on page load
connectWebSocket();
