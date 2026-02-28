// server.js - The main server file

require('dotenv').config();

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const path       = require('path');
const db         = require('./db');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';
const PORT       = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' })); // Allow large bodies for base64 images
app.use(express.static(path.join(__dirname, 'public')));

// ─── Database ─────────────────────────────────────────────────────────────────
db.init().then(() => console.log('Database ready')).catch(err => {
  console.error('Database error:', err.message);
  process.exit(1);
});

// ─── Auth middleware ──────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Not logged in' });
  try { req.user = jwt.verify(auth.slice(7), JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
}

async function requireAdmin(req, res, next) {
  const user = await db.getUserById(req.user.id);
  if (!user?.is_admin) return res.status(403).json({ error: 'Admin only' });
  next();
}

// ─── Auth routes ──────────────────────────────────────────────────────────────
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });
  if (username.length < 3) return res.status(400).json({ error: 'Username must be at least 3 characters' });
  if (!/^[a-zA-Z0-9_]+$/.test(username)) return res.status(400).json({ error: 'Letters, numbers, and underscores only' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  try {
    const passwordHash = await bcrypt.hash(password, 10);
    const user = await db.createUser(username, passwordHash);
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET);
    res.json({ token, username: user.username, id: user.id });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'That username is already taken' });
    console.error(err); res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });
  try {
    const user = await db.getUserByUsername(username);
    if (!user) return res.status(401).json({ error: 'Invalid username or password' });
    if (user.is_banned) return res.status(403).json({ error: 'Your account has been banned.' });
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid username or password' });
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET);
    res.json({ token, username: user.username, id: user.id });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Server error' });
  }
});

// ─── Socket.io ────────────────────────────────────────────────────────────────
const userSockets = new Map();

io.on('connection', (socket) => {

  socket.on('authenticate', async (token) => {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      const user = await db.getUserById(decoded.id);
      if (!user) throw new Error('User not found');
      if (user.is_banned) { socket.emit('banned'); return; }

      socket.user = user;
      if (!userSockets.has(user.id)) userSockets.set(user.id, new Set());
      userSockets.get(user.id).add(socket.id);

      socket.join('general');
      socket.emit('authenticated', { success: true, isAdmin: user.is_admin });
      io.emit('user_online', {
        id: user.id, username: user.username,
        avatar_color: user.avatar_color, avatar_emoji: user.avatar_emoji, avatar_image: user.avatar_image
      });
      socket.emit('users_list', await db.getAllUsers());
    } catch {
      socket.emit('authenticated', { success: false, error: 'Invalid token' });
    }
  });

  socket.on('get_messages', async (room) => {
    if (!socket.user) return;
    if (room.startsWith('dm:')) {
      const [, id1, id2] = room.split(':').map(Number);
      if (socket.user.id !== id1 && socket.user.id !== id2) return;
    }
    socket.emit('message_history', { room, messages: await db.getMessages(room) });
  });

  socket.on('join_room', (room) => { if (socket.user) socket.join(room); });

  // ── Send message (now supports optional image) ────────────────────────────
  socket.on('send_message', async ({ room, content, imageData }) => {
    if (!socket.user) return;
    if (!content?.trim() && !imageData) return; // must have text or image

    // Reject suspiciously large images (over ~3MB of base64)
    if (imageData && imageData.length > 3_000_000) {
      socket.emit('error', 'Image is too large. Please use a smaller image.');
      return;
    }

    if (room.startsWith('dm:')) {
      const [, id1, id2] = room.split(':').map(Number);
      if (socket.user.id !== id1 && socket.user.id !== id2) return;
    }

    try {
      const saved = await db.saveMessage(socket.user.id, room, content?.trim() || '', imageData || null);
      const messageData = {
        id: saved.id,
        sender_id: socket.user.id,
        sender_username: socket.user.username,
        avatar_color: socket.user.avatar_color,
        avatar_emoji: socket.user.avatar_emoji,
        avatar_image: socket.user.avatar_image,
        room, content: content?.trim() || '',
        image_data: imageData || null,
        edited: false,
        reactions: [],
        created_at: saved.created_at
      };

      if (room.startsWith('dm:')) {
        const [, id1, id2] = room.split(':').map(Number);
        const recipientId = socket.user.id === id1 ? id2 : id1;
        for (const socketId of userSockets.get(recipientId) || []) {
          io.sockets.sockets.get(socketId)?.join(room);
        }
      }
      io.to(room).emit('message', messageData);
    } catch (err) { console.error('Send error:', err); }
  });

  // ── Edit message ──────────────────────────────────────────────────────────
  socket.on('edit_message', async ({ messageId, content }) => {
    if (!socket.user || !content?.trim()) return;
    try {
      const msg = await db.editMessage(messageId, socket.user.id, content.trim());
      if (!msg) return;
      io.to(msg.room).emit('message_edited', { messageId, content: content.trim() });
    } catch (err) { console.error('Edit error:', err); }
  });

  // ── Delete message ────────────────────────────────────────────────────────
  socket.on('delete_message', async ({ messageId }) => {
    if (!socket.user) return;
    try {
      const msg = await db.deleteMessage(messageId, socket.user.id, socket.user.is_admin);
      if (!msg) return;
      io.to(msg.room).emit('message_deleted', { messageId });
    } catch (err) { console.error('Delete error:', err); }
  });

  // ── React to a message ────────────────────────────────────────────────────
  socket.on('toggle_reaction', async ({ messageId, emoji }) => {
    if (!socket.user) return;
    try {
      await db.toggleReaction(messageId, socket.user.id, emoji);
      const reactions = await db.getReactionsForMessage(messageId);
      const room = await db.getMessageRoom(messageId);
      if (room) io.to(room).emit('reaction_updated', { messageId, reactions });
    } catch (err) { console.error('Reaction error:', err); }
  });

  socket.on('disconnect', () => {
    if (!socket.user) return;
    const sockets = userSockets.get(socket.user.id);
    if (sockets) {
      sockets.delete(socket.id);
      if (sockets.size === 0) {
        userSockets.delete(socket.user.id);
        io.emit('user_offline', { id: socket.user.id });
      }
    }
  });
});

// ─── Avatar route ─────────────────────────────────────────────────────────────
app.put('/api/avatar', requireAuth, async (req, res) => {
  const { color, emoji, image } = req.body;
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) return res.status(400).json({ error: 'Invalid color' });
  // Reject images over ~500KB of base64 (profile pictures)
  if (image && image.length > 700_000) return res.status(400).json({ error: 'Profile picture too large' });
  try {
    await db.updateUserAvatar(req.user.id, color, emoji || '', image || null);
    io.emit('avatar_updated', { id: req.user.id, avatar_color: color, avatar_emoji: emoji || '', avatar_image: image || null });
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// ─── Admin routes ─────────────────────────────────────────────────────────────
app.post('/api/admin/ban/:userId', requireAuth, requireAdmin, async (req, res) => {
  const targetId = Number(req.params.userId);
  if (targetId === req.user.id) return res.status(400).json({ error: "You can't ban yourself" });
  const target = await db.getUserById(targetId);
  if (!target) return res.status(404).json({ error: 'User not found' });
  const newBanned = !target.is_banned;
  await db.setBanned(targetId, newBanned);
  if (newBanned) {
    for (const socketId of userSockets.get(targetId) || []) {
      const s = io.sockets.sockets.get(socketId);
      if (s) { s.emit('banned'); s.disconnect(); }
    }
  }
  io.emit('users_list', await db.getAllUsers());
  res.json({ success: true, banned: newBanned });
});

app.delete('/api/admin/clear/:room', requireAuth, requireAdmin, async (req, res) => {
  try {
    await db.clearRoom(req.params.room);
    io.to(req.params.room).emit('room_cleared', { room: req.params.room });
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// ─── Start server ─────────────────────────────────────────────────────────────
server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
