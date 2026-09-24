const socket = io();

let myId = null;
let roomCode = null;
let myHand = [];
let myGroups = []; // array of arrays of card objects — current on-screen arrangement
let latestRoomState = null;
let timerInterval = null;
let dragCardId = null;

function suitSymbol(s) { return { S: '♠', H: '♥', D: '♦', C: '♣' }[s] || ''; }
function isRed(s) { return s === 'H' || s === 'D'; }

function show(screenId) {
  document.querySelectorAll('.screen').forEach(el => el.classList.remove('active'));
  document.getElementById(screenId).classList.add('active');
}

function cardEl(card, opts = {}) {
  const div = document.createElement('div');
  div.className = 'card' + (opts.small ? ' small' : '');
  div.draggable = !!opts.draggable;
  div.dataset.cardId = card.id;
  if (card.isPrintedJoker) {
    div.textContent = 'JOKER';
    div.style.fontSize = '0.7rem';
  } else {
    div.classList.add(isRed(card.suit) ? 'red' : 'black');
    div.innerHTML = `${card.rank}<br>${suitSymbol(card.suit)}`;
    div.style.fontSize = opts.small ? '0.75rem' : '1rem';
  }
  return div;
}

// ---------- HOME ----------
document.getElementById('createBtn').onclick = () => {
  const name = document.getElementById('nameInput').value.trim() || 'Player';
  socket.emit('createRoom', { name, maxPlayers: 6 }, res => {
    if (!res.ok) return (document.getElementById('homeError').textContent = res.error);
    myId = res.playerId;
    roomCode = res.code;
    show('screen-lobby');
  });
};

document.getElementById('joinBtn').onclick = () => {
  const name = document.getElementById('nameInput').value.trim() || 'Player';
  const code = document.getElementById('codeInput').value.trim().toUpperCase();
  socket.emit('joinRoom', { name, code }, res => {
    if (!res.ok) return (document.getElementById('homeError').textContent = res.error);
    myId = res.playerId;
    roomCode = res.code;
    show('screen-lobby');
  });
};

const urlParams = new URLSearchParams(window.location.search);
if (urlParams.get('room')) {
  document.getElementById('codeInput').value = urlParams.get('room').toUpperCase();
}

// ---------- LOBBY ----------
document.getElementById('copyLinkBtn').onclick = () => {
  const link = `${window.location.origin}${window.location.pathname}?room=${roomCode}`;
  navigator.clipboard.writeText(link);
  document.getElementById('copyLinkBtn').textContent = 'Copied!';
  setTimeout(() => (document.getElementById('copyLinkBtn').textContent = 'Copy Invite Link'), 1500);
};

document.getElementById('startBtn').onclick = () => socket.emit('startGame');

// ---------- SOCKET: ROOM STATE ----------
socket.on('roomUpdate', state => {
  latestRoomState = state;
  roomCode = state.code;
  document.getElementById('lobbyCode').textContent = state.code;

  if (state.status === 'lobby') {
    show('screen-lobby');
    const list = document.getElementById('lobbyPlayers');
    list.innerHTML = '';
    state.players.forEach(p => {
      const li = document.createElement('li');
      li.textContent = `${p.name}${p.id === state.hostId ? ' (Host)' : ''}${p.connected ? '' : ' — disconnected'}`;
      list.appendChild(li);
    });
    document.getElementById('startBtn').style.display = state.hostId === myId ? 'block' : 'none';
  } else if (state.status === 'playing') {
    show('screen-game');
    renderTurnIndicator(state);
    renderPiles(state);
    renderScoresTable(state);
  }
});

function renderTurnIndicator(state) {
  const turnPlayer = state.players[state.turnIndex];
  document.getElementById('turnIndicator').textContent =
    turnPlayer.id === myId ? "Your turn" : `${turnPlayer.name}'s turn`;
}

function renderPiles(state) {
  const discardPile = document.getElementById('discardPile');
  discardPile.innerHTML = '';
  if (state.discardTop) discardPile.appendChild(cardEl(state.discardTop));

  const wildEl = document.getElementById('wildJokerCard');
  wildEl.innerHTML = '';
  if (state.wildJokerRank) {
    const label = document.createElement('div');
    label.textContent = state.wildJokerRank;
    label.style.fontWeight = '700';
    wildEl.appendChild(label);
  }
}

// ---------- LIVE POINTS TABLE ----------
document.getElementById('toggleScoresBtn').onclick = () => {
  document.getElementById('scoresPanel').classList.toggle('open');
};

let myDeadwood = null;

function renderScoresTable(state) {
  const body = document.getElementById('scoresTableBody');
  body.innerHTML = '';
  const sorted = [...state.players].sort((a, b) => a.score - b.score);
  const minScore = sorted.length ? sorted[0].score : 0;
  sorted.forEach(p => {
    const tr = document.createElement('tr');
    if (state.players[state.turnIndex] && state.players[state.turnIndex].id === p.id) tr.classList.add('active-turn');
    if (p.score === minScore) tr.classList.add('leader');
    const handValueText = p.id === myId && myDeadwood !== null ? myDeadwood : '—';
    tr.innerHTML = `<td>${p.name}</td><td>${p.score}</td><td>${handValueText}</td>`;
    body.appendChild(tr);
  });
}

// ---------- TURN TIMER ----------
const CIRCUMFERENCE = 163.36; // 2 * PI * 26
socket.on('turnTimer', ({ deadline, seconds }) => {
  clearInterval(timerInterval);
  const progressEl = document.getElementById('timerProgress');
  const textEl = document.getElementById('timerText');

  function tick() {
    const remaining = Math.max(0, Math.round((deadline - Date.now()) / 1000));
    textEl.textContent = remaining;
    const fraction = remaining / seconds;
    progressEl.style.strokeDashoffset = CIRCUMFERENCE * (1 - fraction);
    progressEl.classList.toggle('urgent', remaining <= 10);
    if (remaining <= 0) clearInterval(timerInterval);
  }
  tick();
  timerInterval = setInterval(tick, 1000);
});

socket.on('turnTimedOut', ({ playerId, playerName }) => {
  const msg = playerId === myId ? 'You ran out of time — a card was auto-discarded.' : `${playerName} ran out of time.`;
  flashMessage(msg);
});

function flashMessage(text) {
  let el = document.getElementById('flashMsg');
  if (!el) {
    el = document.createElement('div');
    el.id = 'flashMsg';
    el.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);background:#1b1b1b;border:1px solid #d4af37;padding:8px 16px;border-radius:8px;z-index:999;font-size:0.9rem;';
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.style.opacity = '1';
  clearTimeout(el._t);
  el._t = setTimeout(() => (el.style.opacity = '0'), 3000);
}

// ---------- PILES ----------
document.getElementById('stockPile').onclick = () => socket.emit('drawStock');
document.getElementById('discardPile').onclick = () => socket.emit('drawDiscard');

// ---------- HAND + GROUPING ----------
socket.on('yourHand', ({ hand, deadwood, groups }) => {
  myHand = hand;
  myDeadwood = deadwood !== undefined ? deadwood : myDeadwood;
  document.getElementById('deadwoodLabel').textContent =
    myDeadwood !== null ? `Hand value: ${myDeadwood} pts if you declared now` : 'Hand value: —';

  if (groups) {
    myGroups = groups.map(ids => ids.map(id => hand.find(c => c.id === id)).filter(Boolean));
  } else {
    const knownIds = new Set(myGroups.flat().map(c => c.id));
    myGroups = myGroups
      .map(g => g.filter(c => hand.some(h => h.id === c.id)))
      .filter(g => g.length > 0);
    hand.forEach(c => {
      if (!knownIds.has(c.id)) myGroups.push([c]);
    });
  }
  renderHand();
  if (latestRoomState) renderScoresTable(latestRoomState);
});

document.getElementById('sortBtn').onclick = () => socket.emit('requestArrange');

function renderHand() {
  const container = document.getElementById('handCards');
  container.innerHTML = '';
  myGroups.forEach((group, gIndex) => {
    const groupEl = document.createElement('div');
    groupEl.className = 'card-group' + (group.length > 1 ? ' multi' : '');
    groupEl.dataset.groupIndex = gIndex;

    group.forEach(card => {
      const el = cardEl(card, { draggable: true });
      el.addEventListener('dragstart', () => { dragCardId = card.id; el.classList.add('dragging'); });
      el.addEventListener('dragend', () => el.classList.remove('dragging'));
      el.addEventListener('dblclick', () => {
        socket.emit('discardCard', { cardId: card.id });
      });
      groupEl.appendChild(el);
    });

    groupEl.addEventListener('dragover', e => { e.preventDefault(); groupEl.classList.add('drag-over'); });
    groupEl.addEventListener('dragleave', () => groupEl.classList.remove('drag-over'));
    groupEl.addEventListener('drop', e => {
      e.preventDefault();
      groupEl.classList.remove('drag-over');
      moveCardToGroup(dragCardId, gIndex);
    });

    container.appendChild(groupEl);
  });

  const newZone = document.createElement('div');
  newZone.className = 'card-group';
  newZone.style.cssText = 'min-width:40px;min-height:100px;border:1px dashed rgba(255,255,255,0.2);';
  newZone.addEventListener('dragover', e => e.preventDefault());
  newZone.addEventListener('drop', e => {
    e.preventDefault();
    moveCardToGroup(dragCardId, -1);
  });
  container.appendChild(newZone);
}

function moveCardToGroup(cardId, targetGroupIndex) {
  if (!cardId) return;
  let moving = null;
  myGroups = myGroups.map(g => {
    const idx = g.findIndex(c => c.id === cardId);
    if (idx !== -1) {
      moving = g[idx];
      const copy = [...g];
      copy.splice(idx, 1);
      return copy;
    }
    return g;
  }).filter(g => g.length > 0);

  if (!moving) return;

  if (targetGroupIndex === -1) {
    myGroups.push([moving]);
  } else {
    myGroups[targetGroupIndex].push(moving);
  }
  renderHand();
}

// ---------- DECLARE ----------
document.getElementById('declareBtn').onclick = () => {
  if (myHand.length !== 13) {
    alert('You can only declare with exactly 13 cards in hand (discard first if you drew).');
    return;
  }
  if (!confirm('Declare now with your current card groupings?')) return;
  socket.emit('declare', { groups: myGroups });
};

socket.on('roundResult', result => {
  clearInterval(timerInterval);
  show('screen-result');
  document.getElementById('resultTitle').textContent = result.winnerId
    ? `${result.winnerName} wins the round!`
    : `Invalid declare — ${result.reason}`;
  const list = document.getElementById('resultScores');
  list.innerHTML = '';
  [...result.scores].sort((a, b) => a.score - b.score).forEach(p => {
    const li = document.createElement('li');
    li.textContent = `${p.name}: ${p.score} pts`;
    list.appendChild(li);
  });
});

document.getElementById('nextRoundBtn').onclick = () => socket.emit('nextRound');
