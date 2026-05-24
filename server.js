const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};

function generateRoomId() {
  return crypto.randomBytes(3).toString('hex').toUpperCase();
}

io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  socket.on('create_room', ({ playerName }) => {
    const roomId = generateRoomId();
    rooms[roomId] = {
      id: roomId,
      players: {
        [socket.id]: { name: playerName || 'Jugador 1', role: 'host', eliminated: [], secretBrawler: null, ready: false }
      },
      state: 'waiting',
      currentTurn: null,
      createdAt: Date.now()
    };
    socket.join(roomId);
    socket.roomId = roomId;
    socket.emit('room_created', { roomId, role: 'host' });
  });

  socket.on('join_room', ({ roomId, playerName }) => {
    const room = rooms[roomId];
    if (!room) { socket.emit('error', { message: 'Sala no encontrada' }); return; }
    if (Object.keys(room.players).length >= 2) { socket.emit('error', { message: 'La sala está llena' }); return; }
    if (room.state !== 'waiting') { socket.emit('error', { message: 'El juego ya comenzó' }); return; }

    room.players[socket.id] = { name: playerName || 'Jugador 2', role: 'guest', eliminated: [], secretBrawler: null, ready: false };
    socket.join(roomId);
    socket.roomId = roomId;

    const players = Object.entries(room.players).reduce((a, [id, p]) => { a[id] = { name: p.name, role: p.role }; return a; }, {});
    socket.emit('room_joined', { roomId, role: 'guest', players });
    socket.to(roomId).emit('player_joined', { name: playerName || 'Jugador 2', players });
  });

  socket.on('set_secret', ({ brawlerId, brawlerName, brawlerImage }) => {
    const room = rooms[socket.roomId];
    if (!room || !room.players[socket.id]) return;
    room.players[socket.id].secretBrawler = { id: brawlerId, name: brawlerName, image: brawlerImage };
    room.players[socket.id].ready = true;
    socket.to(socket.roomId).emit('opponent_ready');

    const allReady = Object.values(room.players).every(p => p.ready) && Object.keys(room.players).length === 2;
    if (allReady) {
      room.state = 'playing';
      const hostId = Object.entries(room.players).find(([, p]) => p.role === 'host')[0];
      room.currentTurn = hostId;
      const players = Object.entries(room.players).reduce((a, [id, p]) => { a[id] = { name: p.name, role: p.role }; return a; }, {});
      io.to(socket.roomId).emit('game_start', { currentTurn: hostId, players });
    }
  });

  // Player eliminates on their own board (no turn change)
  socket.on('eliminate_brawler', ({ brawlerId }) => {
    const room = rooms[socket.roomId];
    if (!room) return;
    socket.emit('elimination_confirmed', { brawlerId });
  });

  // Pass turn to the other player
  socket.on('pass_turn', () => {
    const room = rooms[socket.roomId];
    if (!room || room.currentTurn !== socket.id) return;
    const ids = Object.keys(room.players);
    room.currentTurn = ids.find(id => id !== socket.id);
    io.to(socket.roomId).emit('turn_changed', { currentTurn: room.currentTurn });
  });

  // Guess the secret brawler
  socket.on('make_guess', ({ brawlerId, brawlerName }) => {
    const room = rooms[socket.roomId];
    if (!room || room.state !== 'playing') return;
    if (room.currentTurn !== socket.id) { socket.emit('error', { message: 'No es tu turno' }); return; }

    const opponentId = Object.keys(room.players).find(id => id !== socket.id);
    const opponentSecret = room.players[opponentId]?.secretBrawler;
    const correct = opponentSecret && opponentSecret.id === brawlerId;

    room.state = 'finished';
    if (correct) {
      io.to(socket.roomId).emit('game_over', {
        winnerId: socket.id,
        winnerName: room.players[socket.id]?.name,
        secretBrawler: opponentSecret
      });
    } else {
      io.to(socket.roomId).emit('game_over', {
        winnerId: opponentId,
        winnerName: room.players[opponentId]?.name,
        secretBrawler: opponentSecret,
        wrongGuess: { brawlerId, brawlerName }
      });
    }
  });

  socket.on('request_rematch', () => {
    const room = rooms[socket.roomId];
    if (!room) return;
    room.players[socket.id].rematch = true;
    socket.to(socket.roomId).emit('rematch_requested', { fromName: room.players[socket.id]?.name });

    if (Object.values(room.players).every(p => p.rematch)) {
      Object.values(room.players).forEach(p => {
        p.eliminated = []; p.secretBrawler = null; p.ready = false; p.rematch = false;
      });
      room.state = 'waiting';
      room.currentTurn = null;
      io.to(socket.roomId).emit('rematch_start');
    }
  });

  socket.on('disconnect', () => {
    const roomId = socket.roomId;
    if (roomId && rooms[roomId]) {
      socket.to(roomId).emit('opponent_disconnected');
      delete rooms[roomId].players[socket.id];
      if (Object.keys(rooms[roomId].players).length === 0) delete rooms[roomId];
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🎮 Brawl Guess on port ${PORT}`));
