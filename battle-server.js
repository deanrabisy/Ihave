const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Store active rooms and their state
const rooms = {};

const BATTLE_WINDOW_MS = 330; // Race-click window for battle interception
const AUTO_PLAY_DELAY_MS = BATTLE_WINDOW_MS + 20; // Give edge-of-window plays time to arrive
const BATTLE_INTRO_MS = 1500; // Clear multi-hit collision beat before clicking starts
const PENDING_STALE_MS = AUTO_PLAY_DELAY_MS + 500;
let battleSequence = 0;

function emitBlockedPlay(roomId, playerId, card, reason, blockedByPlayerId = null, playId = null) {
  io.to(roomId).emit('card_play_blocked', {
    playerId,
    card,
    reason,
    blockedByPlayerId,
    playId
  });
}

function clearPendingPlay(room, playerId) {
  const pending = room.pendingPlays[playerId];
  if (pending && pending.timeout) clearTimeout(pending.timeout);
  delete room.pendingPlays[playerId];
}

function clearPendingPlays(room) {
  for (const playerId of Object.keys(room.pendingPlays)) {
    clearPendingPlay(room, playerId);
  }
}

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // Join a room
  socket.on('join_room', ({ roomId, playerId, isHost }) => {
    socket.join(roomId);
    
    if (!rooms[roomId]) {
      rooms[roomId] = {
        players: {},
        pendingPlays: {},
        activeBattle: null,
        awaitingFlip: false
      };
    }
    
    rooms[roomId].players[playerId] = {
      socketId: socket.id,
      playerId: playerId,
      isHost: isHost || false
    };
    
    console.log(`Player ${playerId} joined room ${roomId} (host: ${isHost})`);
  });

  // Card played - check for battle
  socket.on('card_played', ({ roomId, playerId, card, isHost, playId }) => {
    console.log(`\n========== CARD PLAYED ==========`);
    console.log(`Player: ${playerId}`);
    console.log(`Room: ${roomId}`);
    console.log(`Card: ${card.iHave}`);
    console.log(`IsHost: ${isHost}`);
    console.log(`PlayId: ${playId || 'none'}`);
    
    const room = rooms[roomId];
    if (!room) {
      console.log(`❌ Room ${roomId} not found!`);
      return;
    }

    const now = Date.now();
    console.log(`Received at: ${now}`);

    const rejectPlay = (reason, broadcastBlock = false) => {
      console.log(`Rejecting play from ${playerId}: ${reason}`);
      socket.emit('play_rejected', { reason, blockedByPlayerId: playerId, playId });
      if (broadcastBlock) {
        emitBlockedPlay(roomId, playerId, card, reason, playerId, playId);
      }
    };

    if (room.awaitingFlip) {
      rejectPlay('awaiting_flip', true);
      return;
    }

    if (room.activeBattle) {
      rejectPlay('battle_active', true);
      return;
    }

    const ownPending = room.pendingPlays[playerId];
    if (ownPending) {
      const ownPendingAge = now - ownPending.timestamp;
      const sameCard = ownPending.card && card && String(ownPending.card.id) === String(card.id);
      if (ownPendingAge > PENDING_STALE_MS) {
        console.log(`Clearing stale pending play from same player ${playerId}, age: ${ownPendingAge}ms`);
        clearPendingPlay(room, playerId);
      } else {
        console.log(`Ignoring ${sameCard ? 'duplicate' : 'extra'} pending play from ${playerId}, age: ${ownPendingAge}ms`);
        if (!sameCard) {
          socket.emit('play_rejected', { reason: 'pending_play', blockedByPlayerId: playerId, playId });
        }
        return;
      }
    }
    
    console.log(`Current pending plays:`, Object.keys(room.pendingPlays).map(pid => ({
      playerId: pid,
      age: now - room.pendingPlays[pid].timestamp
    })));
    
    // Check if another player has a pending play within battle window
    let battleOpponent = null;
    let blockedByPending = null;
    for (const [pid, pending] of Object.entries(room.pendingPlays)) {
      const age = now - pending.timestamp;
      console.log(`Checking pending play from ${pid}, age: ${age}ms`);
      
      if (age <= BATTLE_WINDOW_MS) {
        // Found a pending play within time window
        if (pid !== playerId) {
          // Different player - normal battle
          console.log(`✅ DIFFERENT PLAYER - Battle triggered!`);
          battleOpponent = { playerId: pid, card: pending.card, isHost: pending.isHost, playId: pending.playId };
          break;
        }
      } else {
        if (age > PENDING_STALE_MS) {
          console.log(`Clearing stale pending play from ${pid}, age: ${age}ms`);
          clearPendingPlay(room, pid);
          continue;
        }
        blockedByPending = { playerId: pid, age };
      }
    }

    if (battleOpponent) {
      // BATTLE!
      console.log(`🎮 BATTLE triggered between ${playerId} and ${battleOpponent.playerId}`);
      
      // Clear the timeout for the opponent pending play.
      const opponentPending = room.pendingPlays[battleOpponent.playerId];
      if (opponentPending && opponentPending.timeout) {
        console.log(`🔧 Clearing timeout for ${battleOpponent.playerId}'s pending play`);
        clearTimeout(opponentPending.timeout);
      }
      
      // Determine who is student and apply 1/3 chance bonus
      const player1IsStudent = !battleOpponent.isHost;
      const player2IsStudent = !isHost;
      const hasStudentBonus = Math.random() < 0.333;
      
      const battleId = `${Date.now()}-${++battleSequence}`;
      room.activeBattle = {
        id: battleId,
        player1: battleOpponent.playerId,
        player2: playerId,
        card1: battleOpponent.card,
        card2: card,
        play1Id: battleOpponent.playId,
        play2Id: playId,
        clicks1: 0,
        clicks2: 0,
        startTime: now + BATTLE_INTRO_MS,
        introMs: BATTLE_INTRO_MS,
        studentBonus: hasStudentBonus,
        student: player1IsStudent ? battleOpponent.playerId : (player2IsStudent ? playerId : null)
      };
      
      // Clear pending plays
      clearPendingPlays(room);
      
      // Notify both players battle started
      console.log(`📢 Emitting battle_start to room ${roomId}`);
      io.to(roomId).emit('battle_start', room.activeBattle);
      
    } else if (blockedByPending) {
      console.log(`Near click blocked for ${playerId}; ${blockedByPending.playerId} reserved center ${blockedByPending.age}ms ago`);
      emitBlockedPlay(roomId, playerId, card, 'center_reserved', blockedByPending.playerId, playId);
      socket.emit('play_rejected', { reason: 'center_reserved', blockedByPlayerId: blockedByPending.playerId, playId });
    } else {
      // No battle - add to pending
      console.log(`No battle opponent found, adding to pending plays`);
      io.to(roomId).emit('card_play_intent', {
        playerId,
        card,
        playId,
        timestamp: now
      });
      
      // Set timeout to auto-play just after the battle window if no battle occurs
      const timeoutId = setTimeout(() => {
        // Check if this pending play still exists and no battle started
        if (room.pendingPlays[playerId] && !room.activeBattle && !room.awaitingFlip) {
          console.log(`⏰ Timeout: Auto-playing card for ${playerId} (no battle occurred)`);
          const player = room.players[playerId];
          if (player && player.socketId) {
            room.awaitingFlip = true;
            io.to(player.socketId).emit('play_card_now', { card: card, playId });
          }
          clearPendingPlay(room, playerId);
        } else if (room.pendingPlays[playerId]) {
          const reason = room.activeBattle ? 'battle_active' : 'awaiting_flip';
          console.log(`Rejecting pending play for ${playerId}: ${reason}`);
          const player = room.players[playerId];
          if (player && player.socketId) {
            io.to(player.socketId).emit('play_rejected', { reason, blockedByPlayerId: playerId, playId });
          }
          if (reason === 'battle_active') {
            emitBlockedPlay(roomId, playerId, card, reason, playerId, playId);
          }
          clearPendingPlay(room, playerId);
        }
      }, AUTO_PLAY_DELAY_MS);
      
      room.pendingPlays[playerId] = {
        card: card,
        timestamp: now,
        isHost: isHost,
        playId,
        timeout: timeoutId
      };
      
      console.log(`⏳ Pending play registered, will auto-play in ${BATTLE_WINDOW_MS}ms if no battle. Pending count: ${Object.keys(room.pendingPlays).length}`);
    }
    console.log(`================================\n`);
  });

  // Battle click
  socket.on('battle_click', ({ roomId, playerId, battleId }) => {
    const room = rooms[roomId];
    if (!room || !room.activeBattle) return;
    
    const battle = room.activeBattle;
    if (battleId && battle.id && battleId !== battle.id) return;
    if (Date.now() < battle.startTime) return;
    
    if (battle.player1 === playerId) {
      battle.clicks1++;
    } else if (battle.player2 === playerId) {
      battle.clicks2++;
    }
    
    // Broadcast updated click counts
    io.to(roomId).emit('battle_update', {
      clicks1: battle.clicks1,
      clicks2: battle.clicks2
    });
  });

  socket.on('chain_played', ({ roomId, playerId }) => {
    const room = rooms[roomId];
    if (!room) return;
    clearPendingPlays(room);
    room.awaitingFlip = true;
    console.log(`Chain played by ${playerId}; room ${roomId} is awaiting flip`);
  });

  socket.on('chain_flipped', ({ roomId, playerId }) => {
    const room = rooms[roomId];
    if (!room) return;
    clearPendingPlays(room);
    room.awaitingFlip = false;
    console.log(`Chain flipped by ${playerId}; room ${roomId} is accepting plays`);
  });

  socket.on('local_card_blocked', ({ roomId, playerId, card, reason }) => {
    const room = rooms[roomId];
    if (!room || !card) return;
    console.log(`Relaying local blocked card from ${playerId}: ${reason || 'local_block'}`);
    socket.to(roomId).emit('card_play_blocked', {
      playerId,
      card,
      reason: reason || 'local_block',
      blockedByPlayerId: playerId,
      playId: null
    });
  });

  socket.on('game_reset', ({ roomId, playerId }) => {
    const room = rooms[roomId];
    if (!room) return;
    clearPendingPlays(room);
    room.activeBattle = null;
    room.awaitingFlip = false;
    console.log(`Game reset by ${playerId}; room ${roomId} is accepting plays`);
  });

  // Battle ended (time's up)
  socket.on('battle_end', ({ roomId, battleId }) => {
    const room = rooms[roomId];
    if (!room || !room.activeBattle) return;
    
    const battle = room.activeBattle;
    if (battleId && battle.id && battleId !== battle.id) return;
    if (battle.resolved) return;
    battle.resolved = true;
    
    // Apply student bonus (1.2x multiplier)
    let effectiveClicks1 = battle.clicks1;
    let effectiveClicks2 = battle.clicks2;
    
    if (battle.studentBonus && battle.student) {
      if (battle.student === battle.player1) {
        effectiveClicks1 = Math.round(battle.clicks1 * 1.2);
      } else if (battle.student === battle.player2) {
        effectiveClicks2 = Math.round(battle.clicks2 * 1.2);
      }
    }
    
    // Determine winner
    const winner = effectiveClicks1 > effectiveClicks2 ? battle.player1 : battle.player2;
    const winnerCard = effectiveClicks1 > effectiveClicks2 ? battle.card1 : battle.card2;
    
    console.log(`Battle resolved: ${winner} wins with ${effectiveClicks1} vs ${effectiveClicks2}`);
    
    // Notify both players
    io.to(roomId).emit('battle_result', {
      battleId: battle.id,
      winner: winner,
      winnerCard: winnerCard,
      clicks1: battle.clicks1,
      clicks2: battle.clicks2,
      effectiveClicks1: effectiveClicks1,
      effectiveClicks2: effectiveClicks2
    });
    room.awaitingFlip = true;
    
    // Clear battle
    room.activeBattle = null;
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    // Clean up player from rooms
    for (const roomId in rooms) {
      const disconnectedPlayers = [];
      for (const playerId in rooms[roomId].players) {
        if (rooms[roomId].players[playerId].socketId === socket.id) {
          disconnectedPlayers.push(playerId);
          delete rooms[roomId].players[playerId];
        }
      }
      // Clear any pending timeout for this player.
      for (const playerId of disconnectedPlayers) {
        if (rooms[roomId].pendingPlays[playerId]) {
          const pending = rooms[roomId].pendingPlays[playerId];
          if (pending.timeout) {
            clearTimeout(pending.timeout);
          }
          delete rooms[roomId].pendingPlays[playerId];
        }
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Battle server running on port ${PORT}`);
});
