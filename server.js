const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

// Game rooms storage
const rooms = {};

function generateRoomId() {
  return crypto.randomBytes(3).toString('hex').toUpperCase();
}

function createRoom(roomId) {
  rooms[roomId] = {
    id: roomId,
    players: {},       // socketId -> { name, role, eliminated[], secretBrawler }
    state: 'waiting',  // waiting | playing | finished
    currentTurn: null,
    winner: null,
    createdAt: Date.now()
  };
  return rooms[roomId];
}

io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  // Create new room
  socket.on('create_room', ({ playerName }) => {
    const roomId = generateRoomId();
    const room = createRoom(roomId);
    room.players[socket.id] = {
      name: playerName || 'Jugador 1',
      role: 'host',
      eliminated: [],
      secretBrawler: null,
      ready: false
    };
    socket.join(roomId);
    socket.roomId = roomId;
    socket.emit('room_created', { roomId, role: 'host' });
    console.log(`Room created: ${roomId}`);
  });

  // Join existing room
  socket.on('join_room', ({ roomId, playerName }) => {
    const room = rooms[roomId];
    if (!room) {
      socket.emit('error', { message: 'Sala no encontrada' });
      return;
    }
    if (Object.keys(room.players).length >= 2) {
      socket.emit('error', { message: 'La sala está llena' });
      return;
    }
    if (room.state !== 'waiting') {
      socket.emit('error', { message: 'El juego ya comenzó' });
      return;
    }

    room.players[socket.id] = {
      name: playerName || 'Jugador 2',
      role: 'guest',
      eliminated: [],
      secretBrawler: null,
      ready: false
    };
    socket.join(roomId);
    socket.roomId = roomId;

    const playerList = Object.values(room.players).map(p => ({ name: p.name, role: p.role }));
    socket.emit('room_joined', { roomId, role: 'guest', players: playerList });
    socket.to(roomId).emit('player_joined', { name: playerName || 'Jugador 2', players: playerList });
    console.log(`Player joined room: ${roomId}`);
  });

  // Player picks secret brawler and marks ready
  socket.on('set_secret', ({ brawlerId, brawlerName, brawlerImage }) => {
    const roomId = socket.roomId;
    const room = rooms[roomId];
    if (!room || !room.players[socket.id]) return;

    room.players[socket.id].secretBrawler = { id: brawlerId, name: brawlerName, image: brawlerImage };
    room.players[socket.id].ready = true;

    // Tell the other player someone is ready (without revealing who)
    socket.to(roomId).emit('opponent_ready');

    // Check if both ready
    const allReady = Object.values(room.players).every(p => p.ready);
    if (allReady && Object.keys(room.players).length === 2) {
      room.state = 'playing';
      // Host goes first
      const hostId = Object.entries(room.players).find(([, p]) => p.role === 'host')[0];
      room.currentTurn = hostId;
      io.to(roomId).emit('game_start', {
        currentTurn: hostId,
        players: Object.entries(room.players).reduce((acc, [id, p]) => {
          acc[id] = { name: p.name, role: p.role };
          return acc;
        }, {})
      });
    }
  });

  // Player eliminates a brawler on their own board
  socket.on('eliminate_brawler', ({ brawlerId }) => {
    const roomId = socket.roomId;
    const room = rooms[roomId];
    if (!room || !room.players[socket.id]) return;

    if (!room.players[socket.id].eliminated.includes(brawlerId)) {
      room.players[socket.id].eliminated.push(brawlerId);
    }
    // Sync elimination only to the sender (each player manages their own board)
    socket.emit('elimination_confirmed', { brawlerId });
  });

  // Player asks a question (text only, for log)
  socket.on('ask_question', ({ question }) => {
    const roomId = socket.roomId;
    const room = rooms[roomId];
    if (!room) return;
    if (room.currentTurn !== socket.id) {
      socket.emit('error', { message: 'No es tu turno' });
      return;
    }

    io.to(roomId).emit('question_asked', {
      from: socket.id,
      fromName: room.players[socket.id]?.name,
      question
    });
  });

  // Opponent answers yes/no; turn passes
  socket.on('answer_question', ({ answer }) => {
    const roomId = socket.roomId;
    const room = rooms[roomId];
    if (!room) return;

    const playerIds = Object.keys(room.players);
    const askerId = playerIds.find(id => id !== socket.id);

    io.to(roomId).emit('question_answered', {
      from: socket.id,
      fromName: room.players[socket.id]?.name,
      answer
    });

    // Pass turn to the answerer
    room.currentTurn = socket.id;
    io.to(roomId).emit('turn_changed', { currentTurn: socket.id });
  });

  // Player guesses the secret brawler
  socket.on('make_guess', ({ brawlerId, brawlerName }) => {
    const roomId = socket.roomId;
    const room = rooms[roomId];
    if (!room) return;
    if (room.currentTurn !== socket.id) {
      socket.emit('error', { message: 'No es tu turno' });
      return;
    }

    const playerIds = Object.keys(room.players);
    const opponentId = playerIds.find(id => id !== socket.id);
    const opponentSecret = room.players[opponentId]?.secretBrawler;

    const correct = opponentSecret && opponentSecret.id === brawlerId;

    if (correct) {
      room.state = 'finished';
      room.winner = socket.id;
      io.to(roomId).emit('game_over', {
        winnerId: socket.id,
        winnerName: room.players[socket.id]?.name,
        secretBrawler: opponentSecret
      });
    } else {
      // Wrong guess: opponent wins
      room.state = 'finished';
      room.winner = opponentId;
      io.to(roomId).emit('game_over', {
        winnerId: opponentId,
        winnerName: room.players[opponentId]?.name,
        secretBrawler: opponentSecret,
        wrongGuess: { brawlerId, brawlerName }
      });
    }
  });

  // Rematch request
  socket.on('request_rematch', () => {
    const roomId = socket.roomId;
    const room = rooms[roomId];
    if (!room) return;
    room.players[socket.id].rematch = true;
    socket.to(roomId).emit('rematch_requested', { fromName: room.players[socket.id]?.name });

    const allWantRematch = Object.values(room.players).every(p => p.rematch);
    if (allWantRematch) {
      // Reset room
      Object.values(room.players).forEach(p => {
        p.eliminated = [];
        p.secretBrawler = null;
        p.ready = false;
        p.rematch = false;
      });
      room.state = 'waiting';
      room.winner = null;
      room.currentTurn = null;
      io.to(roomId).emit('rematch_start');
    }
  });

  socket.on('disconnect', () => {
    const roomId = socket.roomId;
    if (roomId && rooms[roomId]) {
      socket.to(roomId).emit('opponent_disconnected');
      delete rooms[roomId].players[socket.id];
      if (Object.keys(rooms[roomId].players).length === 0) {
        delete rooms[roomId];
      }
    }
    console.log('Disconnected:', socket.id);
  });
});

// Cleanup old empty rooms every 30 minutes
setInterval(() => {
  const now = Date.now();
  Object.entries(rooms).forEach(([id, room]) => {
    if (now - room.createdAt > 30 * 60 * 1000 && Object.keys(room.players).length === 0) {
      delete rooms[id];
    }
  });
}, 30 * 60 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🎮 Brawl Guess running on port ${PORT}`));
