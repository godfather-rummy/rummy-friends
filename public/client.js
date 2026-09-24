const socket = io();

let myId = null;
let roomCode = null;
let isHost = false;
let myHand = [];
let selectedIds = new Set();
let groups = []; // array of arrays of card objects, built by user for declare

const RANK_LABEL = { JOKER: 'JK' };
function suitSymbol(s) { return { S: '♠', H: '♥', D: '♦', C: '♣' }[s] || ''; }
function isRed(s) { return s === 'H' || s === 'D'; }

function show(screenId) {
  document.querySelectorAll('.screen').forEach(el => el.classList.remove('active'));
  document.getElementById(screenId).classList.add('active');
}

function cardEl(card, opts = {}) {
  const div = document.createElement('div');
  div.className = 'card' + (opts.small ? ' small' : '');
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
    isHost = true;
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
    isHost = false;
    show('screen-lobby');
  });
};

// auto-join if opened via ?room=CODE
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

// ---------- SOCKET EVENTS ----------
socket.on('roomUpdate', state => {
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
    renderScoreboard(state);
    renderPiles(state);
  }
});

function renderScoreboard(state) {
  const board = document.getElementById('scoreboard');
  board.innerHTML = '';
  state.players.forEach((p, i) => {
    const chip = document.createElement('span');
    chip.className = 'score-chip' + (i === state.turnIndex ? ' active-turn' : '');
    chip.textContent = `${p.name}: ${p.score} pts (${p.cardCount})`;
    board.appendChild(chip);
  });
  const me = state.players.find(p => p.id === myId);
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

document.getElementById('stockPile').onclick = () => socket.emit('drawStock');
document.getElementById('discardPile').onclick = () => socket.emit('drawDiscard');

socket.on('yourHand', ({ hand }) => {
  myHand = hand;
  renderHand();
});

function renderHand() {
  const container = document.getElementById('handCards');
  container.innerHTML = '';
  myHand.forEach(card => {
    const el = cardEl(card);
    if (selectedIds.has(card.id)) el.classList.add('selected');
    el.onclick = () => toggleSelect(card, el);
    container.appendChild(el);
  });
}

function toggleSelect(card, el) {
  if (selectedIds.has(card.id)) {
    selectedIds.delete(card.id);
    el.classList.remove('selected');
  } else {
    selectedIds.add(card.id);
    el.classList.add('selected');
  }
}

// Right-click / long-press free area = discard selected single card (simplified: click a card then this button)
document.getElementById('handCards').addEventListener('dblclick', e => {
  const idx = [...document.getElementById('handCards').children].indexOf(e.target.closest('.card'));
  if (idx === -1) return;
  socket.emit('discardCard', { cardId: myHand[idx].id });
  selectedIds.clear();
});

// ---------- DECLARE ----------
// Simplified flow: player selects cards into groups sequentially.
// Selecting cards + clicking Declare treats each contiguous "selection batch" separately
// via prompt-based grouping to keep v1 simple and functional.
document.getElementById('declareBtn').onclick = () => {
  if (myHand.length !== 13) {
    alert('You can only declare with exactly 13 cards in hand (discard first if you drew).');
    return;
  }
  const groupInput = prompt(
    'Enter your groups as card IDs separated by | for each group, groups separated by ;\n' +
    'Simplify: just type "auto" to submit your whole hand as one group for now (basic test mode).'
  );
  if (!groupInput) return;

  let submittedGroups;
  if (groupInput.trim().toLowerCase() === 'auto') {
    submittedGroups = [myHand];
  } else {
    submittedGroups = groupInput.split(';').map(g =>
      g.split('|').map(id => myHand.find(c => c.id === id.trim())).filter(Boolean)
    );
  }
  socket.emit('declare', { groups: submittedGroups });
};

socket.on('roundResult', result => {
  show('screen-result');
  document.getElementById('resultTitle').textContent = result.winnerId
    ? `${result.winnerName} wins the round!`
    : `Invalid declare — ${result.reason}`;
  const list = document.getElementById('resultScores');
  list.innerHTML = '';
  result.scores.forEach(p => {
    const li = document.createElement('li');
    li.textContent = `${p.name}: ${p.score} pts`;
    list.appendChild(li);
  });
  selectedIds.clear();
});

document.getElementById('nextRoundBtn').onclick = () => socket.emit('nextRound');
