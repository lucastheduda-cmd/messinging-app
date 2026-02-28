// db.js - Database connection and queries

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function init() {
  // Users table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(50) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // Add avatar columns to existing users table if they don't exist yet.
  // "IF NOT EXISTS" means this is safe to run every time — it won't break anything.
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_color VARCHAR(7) DEFAULT '#7289da'`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_emoji VARCHAR(10) DEFAULT ''`);

  // Messages table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      sender_id INTEGER REFERENCES users(id),
      room VARCHAR(100) NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room, created_at)
  `);

  console.log('Database tables ready!');
}

async function createUser(username, passwordHash) {
  const result = await pool.query(
    'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username, avatar_color, avatar_emoji',
    [username, passwordHash]
  );
  return result.rows[0];
}

async function getUserByUsername(username) {
  const result = await pool.query(
    'SELECT * FROM users WHERE username = $1',
    [username]
  );
  return result.rows[0];
}

// Get a single user by their ID (used after login to load avatar info)
async function getUserById(id) {
  const result = await pool.query(
    'SELECT id, username, avatar_color, avatar_emoji FROM users WHERE id = $1',
    [id]
  );
  return result.rows[0];
}

// Get every user including their avatar info (for the sidebar list)
async function getAllUsers() {
  const result = await pool.query(
    'SELECT id, username, avatar_color, avatar_emoji FROM users ORDER BY username ASC'
  );
  return result.rows;
}

// Save updated avatar settings for a user
async function updateUserAvatar(userId, color, emoji) {
  await pool.query(
    'UPDATE users SET avatar_color = $1, avatar_emoji = $2 WHERE id = $3',
    [color, emoji, userId]
  );
}

async function saveMessage(senderId, room, content) {
  const result = await pool.query(
    'INSERT INTO messages (sender_id, room, content) VALUES ($1, $2, $3) RETURNING id, created_at',
    [senderId, room, content]
  );
  return result.rows[0];
}

// Get messages AND each sender's avatar info by joining the users table
async function getMessages(room) {
  const result = await pool.query(
    `SELECT m.id, m.content, m.created_at, m.sender_id,
            u.username AS sender_username, u.avatar_color, u.avatar_emoji
     FROM messages m
     JOIN users u ON m.sender_id = u.id
     WHERE m.room = $1
     ORDER BY m.created_at ASC
     LIMIT 50`,
    [room]
  );
  return result.rows;
}

module.exports = { init, createUser, getUserByUsername, getUserById, getAllUsers, updateUserAvatar, saveMessage, getMessages };
