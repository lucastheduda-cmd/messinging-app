// server.js - The main server file
// This is the "brain" of the app. It:
//   1. Serves the HTML/CSS/JS files to your browser
//   2. Handles login and registration
//   3. Manages real-time messaging with Socket.io

require('dotenv').config(); // Load variables from our .env file

const express = require('express');   // Web server framework
const http = require('http');         // Node's built-in HTTP module
const { Server } = require('socket.io'); // Real-time communication
const bcrypt = require('bcryptjs');   // For hashing passwords safely
const jwt = require('jsonwebtoken');  // For creating login tokens
const path = require('path');
const db = require('./db');

const app = express();
// We wrap express in http.createServer so Socket.io can share the same port
const server = http.createServer(app);
const io = new Server(server);

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';
const PORT = process.env.PORT || 3000;

// Tell Express to parse JSON request bodies and serve static files
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Start database ───────────────────────────────────────────────────────────

db.init().then(() => {
  console.log('Database ready');
}).catch(err => {
  console.error('Database error:', err.message);
  process.exit(1);
});

// ─── Auth routes ──────────────────────────────────────────────────────────────
// These are HTTP endpoints. Your browser calls them when registering/logging in.

// POST /api/register - Create a new account
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;

  // Validate input
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }
  if (username.length < 3) {
    return res.status(400).json({ error: 'Username must be at least 3 characters' });
  }
  if (!/^[a-zA-Z0-9_]+$/.test(username)) {
    return res.status(400).json({ error: 'Username can only contain letters, numbers, and underscores' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  try {
    // Hash the password before saving - NEVER store plain text passwords!
    // bcrypt makes it impossible to reverse-engineer the original password.
    const passwordHash = await bcrypt.hash(password, 10);
    const user = await db.createUser(username, passwordHash);

    // Create a JWT (JSON Web Token) - a signed "pass" the browser holds on to.
    // The server can verify it's real without storing sessions.
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET);
    res.json({ token, username: user.username, id: user.id });
  } catch (err) {
    // Error code 23505 = unique constraint violation = username taken
    if (err.code === '23505') {
      return res.status(400).json({ error: 'That username is already taken' });
    }
    console.error(err);
    res.status(500).json({ error: 'Server error, try again' });
  }
});

// POST /api/login - Log in with existing account
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  try {
    const user = await db.getUserByUsername(username);

    // We give the same error for wrong username OR wrong password.
    // This stops people from guessing which usernames exist.
    if (!user) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET);
    res.json({ token, username: user.username, id: user.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error, try again' });
  }
});

// ─── Socket.io (real-time messaging) ─────────────────────────────────────────
// Socket.io keeps a permanent two-way connection between the server and browser.
// This lets messages appear instantly without refreshing the page.

// Track which sockets belong to which user (for DM notifications)
const userSockets = new Map(); // userId -> Set of socket IDs

io.on('connection', (socket) => {
  // A user just connected! But we don't know who they are yet.
  // They must send an "authenticate" event with their JWT token.

  socket.on('authenticate', async (token) => {
    try {
      // Verify the token is real and hasn't been tampered with
      const decoded = jwt.verify(token, JWT_SECRET);

      // Load the full user from DB so we have their avatar info too
      const user = await db.getUserById(decoded.id);
      if (!user) throw new Error('User not found');
      socket.user = user;

      // Track this socket under the user's ID
      if (!userSockets.has(user.id)) {
        userSockets.set(user.id, new Set());
      }
      userSockets.get(user.id).add(socket.id);

      // Put this socket in the "general" room automatically
      socket.join('general');

      socket.emit('authenticated', { success: true });

      // Tell everyone this user is now online (include avatar so sidebar updates)
      io.emit('user_online', { id: user.id, username: user.username, avatar_color: user.avatar_color, avatar_emoji: user.avatar_emoji });

      // Send the full user list so they can see who to DM
      const users = await db.getAllUsers();
      socket.emit('users_list', users);

    } catch (err) {
      socket.emit('authenticated', { success: false, error: 'Invalid token, please log in again' });
    }
  });

  // Browser is asking for message history for a room
  socket.on('get_messages', async (room) => {
    if (!socket.user) return;

    // Security check: for DMs, only allow the two people involved
    if (room.startsWith('dm:')) {
      const [, id1, id2] = room.split(':').map(Number);
      if (socket.user.id !== id1 && socket.user.id !== id2) return;
    }

    const messages = await db.getMessages(room);
    socket.emit('message_history', { room, messages });
  });

  // User is switching to a different room - join it
  socket.on('join_room', (room) => {
    if (!socket.user) return;
    socket.join(room);
  });

  // User sent a message
  socket.on('send_message', async ({ room, content }) => {
    if (!socket.user) return;
    if (!content || !content.trim()) return;

    // Security: for DMs, only allow the two people involved
    if (room.startsWith('dm:')) {
      const [, id1, id2] = room.split(':').map(Number);
      if (socket.user.id !== id1 && socket.user.id !== id2) return;
    }

    try {
      // Save message to database so it's there when people reload
      const saved = await db.saveMessage(socket.user.id, room, content.trim());

      const messageData = {
        id: saved.id,
        sender_id: socket.user.id,
        sender_username: socket.user.username,
        avatar_color: socket.user.avatar_color,
        avatar_emoji: socket.user.avatar_emoji,
        room,
        content: content.trim(),
        created_at: saved.created_at
      };

      // For DMs: make sure the recipient's socket is in this room
      // so they receive the message even if they haven't clicked on the DM yet
      if (room.startsWith('dm:')) {
        const [, id1, id2] = room.split(':').map(Number);
        const recipientId = socket.user.id === id1 ? id2 : id1;
        const recipientSockets = userSockets.get(recipientId) || new Set();

        for (const socketId of recipientSockets) {
          io.sockets.sockets.get(socketId)?.join(room);
        }
      }

      // Send the message to everyone in the room (including the sender, for confirmation)
      io.to(room).emit('message', messageData);

    } catch (err) {
      console.error('Error saving message:', err);
      socket.emit('error', 'Failed to send message');
    }
  });

  // User disconnected (closed tab, lost internet, etc.)
  socket.on('disconnect', () => {
    if (!socket.user) return;

    const sockets = userSockets.get(socket.user.id);
    if (sockets) {
      sockets.delete(socket.id);
      if (sockets.size === 0) {
        userSockets.delete(socket.user.id);
        // Tell everyone they went offline (only if ALL their tabs closed)
        io.emit('user_offline', { id: socket.user.id, username: socket.user.username });
      }
    }
  });
});

// ─── Avatar route ─────────────────────────────────────────────────────────────

// PUT /api/avatar - Save a user's chosen color and emoji
// This requires a valid JWT token in the Authorization header
app.put('/api/avatar', async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Not logged in' });
  }

  try {
    const user = jwt.verify(auth.slice(7), JWT_SECRET);
    const { color, emoji } = req.body;

    // Basic validation
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) {
      return res.status(400).json({ error: 'Invalid color' });
    }

    await db.updateUserAvatar(user.id, color, emoji || '');

    // Tell everyone in real-time that this user updated their avatar
    // so their avatar changes everywhere without a page refresh
    io.emit('avatar_updated', { id: user.id, avatar_color: color, avatar_emoji: emoji || '' });

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Start server ─────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
