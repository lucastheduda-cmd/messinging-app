// db.js - Database connection and queries

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function init() {
  // ── Users table ───────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(50) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_color VARCHAR(7) DEFAULT '#7289da'`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_emoji VARCHAR(10) DEFAULT ''`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_image TEXT`); // base64 profile picture
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT FALSE`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_banned BOOLEAN DEFAULT FALSE`);

  // ── Messages table ────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      sender_id INTEGER REFERENCES users(id),
      room VARCHAR(100) NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS edited BOOLEAN DEFAULT FALSE`);
  await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS image_data TEXT`); // base64 image in message
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room, created_at)`);

  // ── Reactions table ───────────────────────────────────────────────────────
  // Each row = one user reacting with one emoji to one message.
  // ON DELETE CASCADE means if the message is deleted, its reactions are deleted too.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reactions (
      message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id),
      emoji VARCHAR(10) NOT NULL,
      PRIMARY KEY (message_id, user_id, emoji)
    )
  `);

  console.log('Database tables ready!');
}

// ── Reaction helpers ──────────────────────────────────────────────────────────

// Turns a flat list of reaction rows into grouped format for the client:
// [ { emoji: '👍', count: 3, userIds: [1, 2, 3] }, ... ]
function formatReactions(rawReactions) {
  const byEmoji = {};
  for (const { emoji, user_id } of rawReactions) {
    if (!byEmoji[emoji]) byEmoji[emoji] = { emoji, count: 0, userIds: [] };
    byEmoji[emoji].count++;
    byEmoji[emoji].userIds.push(Number(user_id));
  }
  return Object.values(byEmoji);
}

// Fetch reactions for multiple messages at once (one DB query instead of many)
async function getReactionsForMessages(messageIds) {
  if (messageIds.length === 0) return {};
  const result = await pool.query(
    'SELECT message_id, user_id, emoji FROM reactions WHERE message_id = ANY($1)',
    [messageIds]
  );
  const grouped = {};
  for (const row of result.rows) {
    if (!grouped[row.message_id]) grouped[row.message_id] = [];
    grouped[row.message_id].push({ user_id: row.user_id, emoji: row.emoji });
  }
  return grouped;
}

// ── User functions ────────────────────────────────────────────────────────────

async function createUser(username, passwordHash) {
  const result = await pool.query(
    'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username, avatar_color, avatar_emoji, is_admin',
    [username, passwordHash]
  );
  return result.rows[0];
}

async function getUserByUsername(username) {
  const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
  return result.rows[0];
}

async function getUserById(id) {
  const result = await pool.query(
    'SELECT id, username, avatar_color, avatar_emoji, avatar_image, is_admin, is_banned FROM users WHERE id = $1',
    [id]
  );
  return result.rows[0];
}

async function getAllUsers() {
  const result = await pool.query(
    'SELECT id, username, avatar_color, avatar_emoji, avatar_image, is_admin, is_banned FROM users ORDER BY username ASC'
  );
  return result.rows;
}

// Save avatar color, emoji, AND optional profile picture
async function updateUserAvatar(userId, color, emoji, image) {
  await pool.query(
    'UPDATE users SET avatar_color = $1, avatar_emoji = $2, avatar_image = $3 WHERE id = $4',
    [color, emoji, image || null, userId]
  );
}

async function setBanned(userId, banned) {
  await pool.query('UPDATE users SET is_banned = $1 WHERE id = $2', [banned, userId]);
}

// ── Message functions ─────────────────────────────────────────────────────────

async function saveMessage(senderId, room, content, imageData) {
  const result = await pool.query(
    'INSERT INTO messages (sender_id, room, content, image_data) VALUES ($1, $2, $3, $4) RETURNING id, created_at',
    [senderId, room, content || '', imageData || null]
  );
  return result.rows[0];
}

// Only the message author can edit their own message
async function editMessage(messageId, userId, content) {
  const result = await pool.query(
    `UPDATE messages SET content = $1, edited = TRUE
     WHERE id = $2 AND sender_id = $3
     RETURNING id, room`,
    [content, messageId, userId]
  );
  return result.rows[0];
}

// Authors can delete their own; admins can delete anything
async function deleteMessage(messageId, userId, isAdmin) {
  const result = isAdmin
    ? await pool.query('DELETE FROM messages WHERE id = $1 RETURNING id, room', [messageId])
    : await pool.query('DELETE FROM messages WHERE id = $1 AND sender_id = $2 RETURNING id, room', [messageId, userId]);
  return result.rows[0];
}

async function clearRoom(room) {
  await pool.query('DELETE FROM messages WHERE room = $1', [room]);
}

// Toggle a reaction: if the row exists, delete it (un-react); if not, insert it (react)
async function toggleReaction(messageId, userId, emoji) {
  const del = await pool.query(
    'DELETE FROM reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3 RETURNING id',
    [messageId, userId, emoji]
  );
  if (del.rowCount > 0) return { added: false };
  await pool.query(
    'INSERT INTO reactions (message_id, user_id, emoji) VALUES ($1, $2, $3)',
    [messageId, userId, emoji]
  );
  return { added: true };
}

// Get formatted reactions for a single message (used after a toggle)
async function getReactionsForMessage(messageId) {
  const grouped = await getReactionsForMessages([messageId]);
  return formatReactions(grouped[messageId] || []);
}

async function getMessageRoom(messageId) {
  const result = await pool.query('SELECT room FROM messages WHERE id = $1', [messageId]);
  return result.rows[0]?.room;
}

// Fetch messages for a room, including reactions
async function getMessages(room) {
  const msgResult = await pool.query(
    `SELECT m.id, m.content, m.created_at, m.sender_id, m.edited, m.image_data,
            u.username AS sender_username, u.avatar_color, u.avatar_emoji, u.avatar_image
     FROM messages m
     JOIN users u ON m.sender_id = u.id
     WHERE m.room = $1
     ORDER BY m.created_at ASC
     LIMIT 50`,
    [room]
  );
  const messages = msgResult.rows;
  if (messages.length === 0) return [];

  const ids = messages.map(m => m.id);
  const rxGrouped = await getReactionsForMessages(ids);

  return messages.map(m => ({
    ...m,
    reactions: formatReactions(rxGrouped[m.id] || [])
  }));
}

module.exports = {
  init, createUser, getUserByUsername, getUserById, getAllUsers,
  updateUserAvatar, setBanned, clearRoom, saveMessage,
  editMessage, deleteMessage, toggleReaction, getReactionsForMessage,
  getMessageRoom, getMessages
};
