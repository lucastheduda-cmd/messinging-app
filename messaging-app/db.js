// db.js - Database connection and queries
// Think of this file as a "helper" that handles all communication with the database.
// The rest of the app just calls functions like db.saveMessage() without
// needing to know the details of how SQL works.

const { Pool } = require('pg');

// Pool = a group of database connections that get reused.
// The DATABASE_URL tells it where the database lives (set in .env file).
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // SSL is required when connecting to cloud databases like Neon.tech
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Creates the tables if they don't exist yet.
// This runs once when the server starts up.
async function init() {
  // Users table: stores accounts
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(50) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // Messages table: stores all chat messages
  // "room" is either "general" or "dm:1:2" (a DM between user #1 and user #2)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      sender_id INTEGER REFERENCES users(id),
      room VARCHAR(100) NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // An index makes looking up messages by room much faster
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room, created_at)
  `);

  console.log('Database tables ready!');
}

// Save a new user to the database
async function createUser(username, passwordHash) {
  const result = await pool.query(
    'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username',
    [username, passwordHash]
  );
  return result.rows[0];
}

// Find a user by their username (used during login)
async function getUserByUsername(username) {
  const result = await pool.query(
    'SELECT * FROM users WHERE username = $1',
    [username]
  );
  return result.rows[0]; // returns undefined if not found
}

// Get every user (for the DM list in the sidebar)
async function getAllUsers() {
  const result = await pool.query(
    'SELECT id, username FROM users ORDER BY username ASC'
  );
  return result.rows;
}

// Save a new message to the database
async function saveMessage(senderId, room, content) {
  const result = await pool.query(
    'INSERT INTO messages (sender_id, room, content) VALUES ($1, $2, $3) RETURNING id, created_at',
    [senderId, room, content]
  );
  return result.rows[0];
}

// Get the last 50 messages for a room (newest messages, oldest first)
async function getMessages(room) {
  const result = await pool.query(
    `SELECT m.id, m.content, m.created_at, m.sender_id, u.username AS sender_username
     FROM messages m
     JOIN users u ON m.sender_id = u.id
     WHERE m.room = $1
     ORDER BY m.created_at ASC
     LIMIT 50`,
    [room]
  );
  return result.rows;
}

module.exports = { init, createUser, getUserByUsername, getAllUsers, saveMessage, getMessages };
