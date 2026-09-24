// server.js — Rummy Friends multiplayer server
// No login/OTP: players just enter a display name + room code.

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { dealRound, validateDeclaration, scoreLoserHand, isWildJoker, autoArrangeHand } = require('./rummyEngine');

const TURN_SECONDS = 60;

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

// ---- In-memory room store (fine for a small free-tier deployment) ----
// rooms[code] = {
//   code, players: [{id, socketId, name, score, hand, connected}],
//   status: 'lobby'|'playing'|'roundEnd',
//   turnIndex, stock, discard, wildJokerRank, hostId, maxPlayers
// }
const rooms = {};

function makeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no confusing chars
  let code;
  do {
    code = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms[code]);
  return code;
}

function publicRoomState(room) {
  return {
    code: room.code,
    status: room.status,
    players: room.players.map(p => ({
      id: p.id, name: p.name, score: p.score,
      cardCount: p.hand ? p.hand.length : 0, connected: p.connected,
    })),
    turnIndex: room.turnIndex,
    discardTop: room.discard ? room.discard[room.discard.length - 1] : null,
    stockCount: room.stock ? room.stock.length : 0,
    wildJokerRank: room.wildJokerRank,
    hostId: room.hostId,
    turnDeadline: room.turnDeadline || null,
  };
}

function broadcastRoom(room) {
  io.to(room.code).emit('roomUpdate', publicRoomState(room));
}

function sendPrivateHands(room) {
  room.players.forEach(p => {
    if (p.socketId) {
      const arranged = autoArrangeHand(p.hand, room.wildJokerRank);
      io.to(p.socketId).emit('yourHand', { hand: p.hand, deadwood: arranged.deadwood });
    }
  });
}

function sendHandTo(room, player) {
  if (!player.socketId) return;
  const arranged = autoArrangeHand(player.hand, room.wildJokerRank);
  io.to(player.socketId).emit('yourHand', { hand: player.hand, deadwood: arranged.deadwood });
}

// ---- Turn timer: 60s per player. On timeout the player forfeits the turn —
// server auto-draws from stock (if they hadn't drawn) and auto-discards
// their single highest-value deadwood card, then play passes on. ----
function clearTurnTimer(room) {
  if (room.turnTimer) {
    clearTimeout(room.turnTimer);
    room.turnTimer = null;
  }
}

function startTurnTimer(room) {
  clearTurnTimer(room);
  room.turnDeadline = Date.now() + TURN_SECONDS * 1000;
  io.to(room.code).emit('turnTimer', { deadline: room.turnDeadline, seconds: TURN_SECONDS });
  room.turnTimer = setTimeout(() => handleTurnTimeout(room), TURN_SECONDS * 1000);
}

function handleTurnTimeout(room) {
  if (room.status !== 'playing') return;
  const player = room.players[room.turnIndex];
  if (!player) return;

  // Draw from stock if hand is below 14 (i.e. they hadn't drawn yet this turn)
  if (player.hand.length < 14 && room.stock.length > 0) {
    player.hand.push(room.stock.pop());
  }

  // Auto-discard the single card that hurts least to keep: pick from the
  // "deadwood" bucket of the auto-arrange, highest value first.
  const arranged = autoArrangeHand(player.hand, room.wildJokerRank);
  const deadwoodGroup = arranged.groups[arranged.groups.length - 1] || player.hand;
  const worst = [...deadwoodGroup].filter(c => !c.isPrintedJoker)
    .sort((a, b) => require('./rummyEngine').deadwoodValue(b) - require('./rummyEngine').deadwoodValue(a))[0]
    || player.hand[player.hand.length - 1];

  const idx = player.hand.findIndex(c => c.id === worst.id);
  if (idx !== -1) {
    const [card] = player.hand.splice(idx, 1);
    room.discard.push(card);
  }

  room.turnIndex = (room.turnIndex + 1) % room.players.length;
  io.to(room.code).emit('turnTimedOut', { playerId: player.id, playerName: player.name });
  sendHandTo(room, player);
  broadcastRoom(room);
  startTurnTimer(room);
}

io.on('connection', socket => {
  let currentRoomCode = null;
  let playerId = null;

  socket.on('createRoom', ({ name, maxPlayers }, cb) => {
    const code = makeRoomCode();
    playerId = socket.id;
    const room = {
      code,
      players: [{ id: playerId, socketId: socket.id, name: name || 'Player', score: 0, hand: [], connected: true }],
      status: 'lobby',
      turnIndex: 0,
      stock: [], discard: [], wildJokerRank: null,
      hostId: playerId,
      maxPlayers: Math.min(Math.max(maxPlayers || 4, 2), 6),
    };
    rooms[code] = room;
    currentRoomCode = code;
    socket.join(code);
    cb({ ok: true, code, playerId });
    broadcastRoom(room);
  });

  socket.on('joinRoom', ({ code, name }, cb) => {
    const room = rooms[(code || '').toUpperCase()];
    if (!room) return cb({ ok: false, error: 'Room not found' });
    if (room.status !== 'lobby') return cb({ ok: false, error: 'Game already in progress' });
    if (room.players.length >= room.maxPlayers) return cb({ ok: false, error: 'Room is full' });

    playerId = socket.id;
    room.players.push({ id: playerId, socketId: socket.id, name: name || 'Player', score: 0, hand: [], connected: true });
    currentRoomCode = room.code;
    socket.join(room.code);
    cb({ ok: true, code: room.code, playerId });
    broadcastRoom(room);
  });

  socket.on('startGame', () => {
    const room = rooms[currentRoomCode];
    if (!room || room.hostId !== playerId) return;
    if (room.players.length < 2) return;

    const ids = room.players.map(p => p.id);
    const { hands, wildJokerRank, stock, discard } = dealRound(ids);
    room.players.forEach(p => (p.hand = hands[p.id]));
    room.wildJokerRank = wildJokerRank;
    room.stock = stock;
    room.discard = discard;
    room.status = 'playing';
    room.turnIndex = 0;

    broadcastRoom(room);
    sendPrivateHands(room);
    startTurnTimer(room);
  });

  socket.on('drawStock', () => {
    const room = rooms[currentRoomCode];
    if (!room || room.status !== 'playing') return;
    const player = room.players[room.turnIndex];
    if (player.id !== playerId) return; // not your turn
    if (room.stock.length === 0) return;
    const card = room.stock.pop();
    player.hand.push(card);
    io.to(player.socketId).emit('yourHand', { hand: player.hand });
    broadcastRoom(room);
  });

  socket.on('drawDiscard', () => {
    const room = rooms[currentRoomCode];
    if (!room || room.status !== 'playing') return;
    const player = room.players[room.turnIndex];
    if (player.id !== playerId || room.discard.length === 0) return;
    const card = room.discard.pop();
    player.hand.push(card);
    io.to(player.socketId).emit('yourHand', { hand: player.hand });
    broadcastRoom(room);
  });

  socket.on('discardCard', ({ cardId }) => {
    const room = rooms[currentRoomCode];
    if (!room || room.status !== 'playing') return;
    const player = room.players[room.turnIndex];
    if (player.id !== playerId) return;
    const idx = player.hand.findIndex(c => c.id === cardId);
    if (idx === -1) return;
    const [card] = player.hand.splice(idx, 1);
    room.discard.push(card);
    room.turnIndex = (room.turnIndex + 1) % room.players.length;
    sendHandTo(room, player);
    broadcastRoom(room);
    startTurnTimer(room);
  });

  // Client asks server to auto-arrange the player's own hand into
  // best-guess sequences/sets — used by the "Sort" button and to show
  // live deadwood points as the hand changes.
  socket.on('requestArrange', () => {
    const room = rooms[currentRoomCode];
    if (!room || room.status !== 'playing') return;
    const player = room.players.find(p => p.id === playerId);
    if (!player) return;
    const arranged = autoArrangeHand(player.hand, room.wildJokerRank);
    const orderedHand = [].concat(...arranged.groups);
    player.hand = orderedHand;
    io.to(player.socketId).emit('yourHand', { hand: player.hand, deadwood: arranged.deadwood, groups: arranged.groups.map(g => g.map(c => c.id)) });
  });

  socket.on('declare', ({ groups }) => {
    const room = rooms[currentRoomCode];
    if (!room || room.status !== 'playing') return;
    const player = room.players[room.turnIndex];
    if (player.id !== playerId) return;

    const result = validateDeclaration(groups, room.wildJokerRank);
    clearTurnTimer(room);

    if (!result.valid) {
      player.score += 80; // wrong declare penalty
      room.status = 'roundEnd';
      io.to(room.code).emit('roundResult', {
        winnerId: null, invalidDeclareBy: player.id, reason: result.reason,
        scores: room.players.map(p => ({ id: p.id, name: p.name, score: p.score })),
      });
      broadcastRoom(room);
      return;
    }

    // Winner declared validly — score everyone else's current hand as deadwood (simplified: full hand as one group)
    room.players.forEach(p => {
      if (p.id === player.id) return;
      const loserPoints = scoreLoserHand([p.hand], room.wildJokerRank);
      p.score += loserPoints;
    });

    room.status = 'roundEnd';
    io.to(room.code).emit('roundResult', {
      winnerId: player.id, winnerName: player.name,
      scores: room.players.map(p => ({ id: p.id, name: p.name, score: p.score })),
    });
    broadcastRoom(room);
  });

  socket.on('nextRound', () => {
    const room = rooms[currentRoomCode];
    if (!room || room.hostId !== playerId) return;
    room.status = 'lobby';
    broadcastRoom(room);
  });

  socket.on('disconnect', () => {
    const room = rooms[currentRoomCode];
    if (!room) return;
    const player = room.players.find(p => p.id === playerId);
    if (player) player.connected = false;
    broadcastRoom(room);
    // Clean up empty rooms after a delay
    setTimeout(() => {
      const r = rooms[currentRoomCode];
      if (r && r.players.every(p => !p.connected)) {
        clearTurnTimer(r);
        delete rooms[currentRoomCode];
      }
    }, 5 * 60 * 1000);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Rummy Friends server running on port ${PORT}`));
