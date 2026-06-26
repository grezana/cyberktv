const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const os = require('os');

// Detect LAN IP (prefer Wi-Fi / Ethernet over virtual adapters)
function getLanIP() {
  const nets = os.networkInterfaces();
  const candidates = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        const priority = /wi.fi|ethernet|en\d|eth\d|wlan/i.test(name) ? 0 : 1;
        candidates.push({ ip: net.address, priority });
      }
    }
  }
  candidates.sort((a, b) => a.priority - b.priority);
  return candidates[0]?.ip || 'localhost';
}
const LAN_IP = getLanIP();

// PUBLIC_URL is set in production (e.g. Railway, Render).
// When set, QR codes and join links use this instead of the LAN IP.
const PUBLIC_URL = process.env.PUBLIC_URL
  ? process.env.PUBLIC_URL.replace(/\/$/, '')   // strip trailing slash
  : null;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 5000,   // detect dead connections within ~5s (default is 20s)
  pingInterval: 3000,
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.redirect('/tv.html'));

// Try to load youtube-sr for search
let YouTube = null;
try {
  YouTube = require('youtube-sr').default;
} catch (e) {
  console.warn('youtube-sr unavailable — search disabled, URL paste still works');
}

// In-memory room store
const rooms = new Map();

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function newRoom(code) {
  return {
    code,
    tvSocketId: null,
    queue: [],
    currentSong: null,
    isPlaying: false,
    currentTime: 0,
    duration: 0,
    volume: 80,
    theme: 'neon',
    showPlaylist: true,
    showQR: true,
    showRoomCode: true,
    showSongDetails: true,
    isMuted: false,
    clientCount: 0,
  };
}

function publicState(room) {
  return {
    roomCode: room.code,
    queue: room.queue,
    currentSong: room.currentSong,
    isPlaying: room.isPlaying,
    currentTime: room.currentTime,
    duration: room.duration,
    volume: room.volume,
    theme: room.theme,
    showPlaylist: room.showPlaylist,
    showQR: room.showQR,
    showRoomCode: room.showRoomCode,
    showSongDetails: room.showSongDetails,
    isMuted: room.isMuted,
  };
}

function extractVideoId(input) {
  if (!input) return null;
  const patterns = [
    /[?&]v=([a-zA-Z0-9_-]{11})/,
    /youtu\.be\/([a-zA-Z0-9_-]{11})/,
    /embed\/([a-zA-Z0-9_-]{11})/,
    /shorts\/([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/,
  ];
  for (const p of patterns) {
    const m = input.trim().match(p);
    if (m) return m[1];
  }
  return null;
}

io.on('connection', (socket) => {
  let roomCode = null;
  let userName = 'Guest';
  let isTV = false;

  // ── TV: Create room ───────────────────────────────────────────
  socket.on('create-room', () => {
    const code = generateCode();
    const room = newRoom(code);
    room.tvSocketId = socket.id;
    rooms.set(code, room);
    roomCode = code;
    isTV = true;
    socket.join(code);
    socket.emit('room-created', { roomCode: code, lanIP: LAN_IP, port: PORT, publicUrl: PUBLIC_URL });
    console.log(`[${code}] Room created`);
  });

  // ── Mobile: Join room ─────────────────────────────────────────
  socket.on('join-room', ({ code, name }) => {
    const upper = (code || '').toUpperCase().trim();
    const room = rooms.get(upper);
    if (!room) {
      socket.emit('join-error', { message: 'Room not found. Check the code and try again.' });
      return;
    }
    const isRejoin = roomCode === upper; // same socket already counted — sync button or re-emit
    roomCode = upper;
    userName = (name || 'Guest').trim().slice(0, 20) || 'Guest';
    isTV = false;
    socket.join(roomCode);
    if (!isRejoin) room.clientCount = (room.clientCount || 0) + 1;
    socket.emit('room-joined', { state: publicState(room), lanIP: LAN_IP, port: PORT });
    io.to(room.tvSocketId).emit('client-joined', { name: userName });
    io.to(roomCode).emit('client-count', { count: room.clientCount });
    console.log(`[${roomCode}] ${userName} ${isRejoin ? 're-synced' : 'joined'} (${room.clientCount} guests)`);
  });

  // ── Search songs ──────────────────────────────────────────────
  socket.on('search-songs', async ({ query }) => {
    if (!YouTube) {
      socket.emit('search-results', { results: [], error: 'Search unavailable on this server. Paste a YouTube URL below.' });
      return;
    }
    try {
      const results = await YouTube.search(`${query} karaoke`, { limit: 12, type: 'video' });
      socket.emit('search-results', {
        results: results.map(v => ({
          videoId: v.id,
          title: v.title,
          thumbnail: v.thumbnail?.url || `https://img.youtube.com/vi/${v.id}/mqdefault.jpg`,
          duration: v.durationFormatted || '',
          channel: v.channel?.name || '',
        })),
      });
    } catch (e) {
      console.error('Search error:', e.message);
      socket.emit('search-results', { results: [], error: 'Search failed. Try pasting a YouTube URL instead.' });
    }
  });

  // ── Fetch video info from URL ─────────────────────────────────
  socket.on('get-video-info', async ({ url }) => {
    const videoId = extractVideoId(url);
    if (!videoId) {
      socket.emit('video-info-result', { error: 'Invalid YouTube URL or video ID.' });
      return;
    }
    try {
      const res = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`);
      if (!res.ok) throw new Error('oEmbed failed');
      const data = await res.json();
      socket.emit('video-info-result', {
        videoId,
        title: data.title,
        thumbnail: `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`,
        channel: data.author_name || '',
        duration: '',
      });
    } catch (e) {
      socket.emit('video-info-result', { error: 'Could not fetch video info. Check the URL and try again.' });
    }
  });

  // ── Add song to queue ─────────────────────────────────────────
  socket.on('add-song', ({ videoId, title, thumbnail, singerName, duration, channel }) => {
    const room = rooms.get(roomCode);
    if (!room) return;
    const song = {
      id: uuidv4(),
      videoId,
      title: title || 'Unknown Title',
      thumbnail: thumbnail || `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`,
      singerName: (singerName || userName).trim() || 'Guest',
      duration: duration || '',
      channel: channel || '',
      addedBy: userName,
    };
    if (!room.currentSong) {
      room.currentSong = song;
      room.isPlaying = true;
      room.currentTime = 0;
      room.duration = 0;
      io.to(roomCode).emit('state-update', publicState(room));
    } else {
      room.queue.push(song);
      io.to(roomCode).emit('queue-update', { queue: room.queue });
    }
    // Notify everyone (especially TV) that a song was just added
    io.to(room.tvSocketId).emit('song-added', { title: song.title, singerName: song.singerName });
  });

  socket.on('reorder-queue', ({ queue }) => {
    const room = rooms.get(roomCode);
    if (!room) return;
    room.queue = queue;
    io.to(roomCode).emit('queue-update', { queue: room.queue });
  });

  socket.on('remove-song', ({ songId }) => {
    const room = rooms.get(roomCode);
    if (!room) return;
    room.queue = room.queue.filter(s => s.id !== songId);
    io.to(roomCode).emit('queue-update', { queue: room.queue });
  });

  socket.on('update-singer', ({ songId, singerName }) => {
    const room = rooms.get(roomCode);
    if (!room) return;
    const song = room.queue.find(s => s.id === songId);
    if (song) {
      song.singerName = (singerName || '').trim() || 'Guest';
      io.to(roomCode).emit('queue-update', { queue: room.queue });
    }
    if (room.currentSong && room.currentSong.id === songId) {
      room.currentSong.singerName = (singerName || '').trim() || 'Guest';
      io.to(roomCode).emit('current-singer-update', { singerName: room.currentSong.singerName });
    }
  });

  // ── Playback controls ─────────────────────────────────────────
  socket.on('play-pause', () => {
    const room = rooms.get(roomCode);
    if (!room || !room.currentSong) return;
    room.isPlaying = !room.isPlaying;
    io.to(roomCode).emit('playback-update', { isPlaying: room.isPlaying });
  });

  socket.on('next-song', () => advanceQueue(roomCode));

  socket.on('seek', ({ time }) => {
    const room = rooms.get(roomCode);
    if (!room) return;
    room.currentTime = time;
    io.to(room.tvSocketId).emit('do-seek', { time });
    socket.to(roomCode).emit('time-update', { currentTime: time, duration: room.duration });
  });

  socket.on('volume-change', ({ volume }) => {
    const room = rooms.get(roomCode);
    if (!room) return;
    room.volume = Math.max(0, Math.min(100, Math.round(volume)));
    io.to(roomCode).emit('volume-sync', { volume: room.volume });
  });

  socket.on('set-theme', ({ theme }) => {
    const room = rooms.get(roomCode);
    if (!room) return;
    if (!['neon', 'ktv', 'glass', 'retro'].includes(theme)) return;
    room.theme = theme;
    io.to(roomCode).emit('theme-changed', { theme });
  });

  socket.on('emoji-reaction', ({ emoji }) => {
    const room = rooms.get(roomCode);
    if (!room) return;
    io.to(roomCode).emit('emoji-reaction', { emoji, name: userName });
  });

  socket.on('toggle-playlist', () => {
    const room = rooms.get(roomCode);
    if (!room) return;
    room.showPlaylist = !room.showPlaylist;
    io.to(roomCode).emit('playlist-visibility', { show: room.showPlaylist });
  });

  // Combined QR + room-code toggle (both always in sync)
  socket.on('toggle-qr-room', () => {
    const room = rooms.get(roomCode);
    if (!room) return;
    const newVal = !room.showRoomCode;
    room.showQR = newVal;
    room.showRoomCode = newVal;
    io.to(roomCode).emit('qr-visibility', { show: newVal });
    io.to(roomCode).emit('room-code-visibility', { show: newVal });
  });

  socket.on('toggle-song-details', () => {
    const room = rooms.get(roomCode);
    if (!room) return;
    room.showSongDetails = !room.showSongDetails;
    io.to(roomCode).emit('song-details-visibility', { show: room.showSongDetails });
  });

  socket.on('mute-toggle', () => {
    const room = rooms.get(roomCode);
    if (!room) return;
    room.isMuted = !room.isMuted;
    io.to(roomCode).emit('mute-sync', { muted: room.isMuted });
  });

  socket.on('quit-room', () => {
    if (roomCode) socket.leave(roomCode);
    roomCode = null;
    socket.emit('quit-confirmed');
  });

  // TV reports time progress to mobile clients
  socket.on('time-update', ({ currentTime, duration }) => {
    const room = rooms.get(roomCode);
    if (!room || !isTV) return;
    room.currentTime = currentTime;
    room.duration = duration;
    socket.to(roomCode).emit('time-update', { currentTime, duration });
  });

  // TV reports song finished
  socket.on('song-ended', () => {
    const room = rooms.get(roomCode);
    if (!room || !isTV) return;
    if (room.currentSong) {
      const score = Math.floor(Math.random() * 25) + 75;
      const stars = score >= 95 ? 5 : score >= 88 ? 4 : score >= 80 ? 3 : score >= 75 ? 2 : 1;
      io.to(roomCode).emit('score-reveal', {
        singerName: room.currentSong.singerName,
        songTitle: room.currentSong.title,
        score,
        stars,
      });
    }
    setTimeout(() => advanceQueue(roomCode), 4500);
  });

  socket.on('disconnect', () => {
    if (roomCode && isTV) {
      setTimeout(() => {
        const room = rooms.get(roomCode);
        if (room && room.tvSocketId === socket.id) {
          rooms.delete(roomCode);
          console.log(`[${roomCode}] Room cleaned up (TV disconnected)`);
        }
      }, 30000);
    } else if (roomCode && !isTV) {
      const room = rooms.get(roomCode);
      if (room) {
        room.clientCount = Math.max(0, (room.clientCount || 1) - 1);
        io.to(roomCode).emit('client-count', { count: room.clientCount });
        io.to(room.tvSocketId).emit('client-left', { name: userName });
        console.log(`[${roomCode}] ${userName} left (${room.clientCount} guests)`);
      }
    }
  });

  function advanceQueue(code) {
    const room = rooms.get(code);
    if (!room) return;
    if (room.queue.length > 0) {
      room.currentSong = room.queue.shift();
      room.isPlaying = true;
      room.currentTime = 0;
      room.duration = 0;
    } else {
      room.currentSong = null;
      room.isPlaying = false;
    }
    io.to(code).emit('state-update', publicState(room));
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🎤  CyberKTV is live!`);
  console.log(`    TV screen : http://localhost:${PORT}/tv.html`);
  console.log(`    Mobile    : http://${LAN_IP}:${PORT}/mobile.html`);
  console.log(`    LAN IP    : ${LAN_IP}\n`);
});
