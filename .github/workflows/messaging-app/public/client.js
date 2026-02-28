// client.js - Everything the browser does on the chat page
// This file runs in YOUR BROWSER (not the server).
// It connects to the server via Socket.io and handles the UI.

// ── State (data our app keeps track of) ───────────────────────────────────────
const token    = localStorage.getItem('token');
const myId     = Number(localStorage.getItem('userId'));
const myName   = localStorage.getItem('username');

let currentRoom = 'general';       // Which room is open right now
let allUsers    = [];              // List of all users from the server
let unreadRooms = new Set();       // Rooms with unread messages

// If not logged in, kick back to the login page
if (!token) {
  window.location.href = '/index.html';
}

// ── Set up my own user info in the sidebar ────────────────────────────────────
document.getElementById('my-username').textContent = myName;
document.getElementById('my-avatar').textContent = myName[0].toUpperCase();

// ── Connect to the server via Socket.io ───────────────────────────────────────
const socket = io();

// As soon as we connect, send our token so the server knows who we are
socket.on('connect', () => {
  socket.emit('authenticate', token);
});

// Server confirmed we're authenticated
socket.on('authenticated', ({ success, error }) => {
  if (!success) {
    alert('Session expired, please log in again.');
    logout();
    return;
  }
  // Load messages for the default room (#general)
  socket.emit('get_messages', 'general');
});

// If we lose connection, Socket.io auto-reconnects and fires 'connect' again,
// which re-authenticates us. No extra code needed!
socket.on('disconnect', () => {
  showSystemMessage('Disconnected. Reconnecting...');
});

// ── User list (who can we DM?) ────────────────────────────────────────────────
socket.on('users_list', (users) => {
  allUsers = users;
  renderDmList(users);
});

// A user just came online
socket.on('user_online', ({ id, username }) => {
  // Update their status dot to green
  const dot = document.querySelector(`.status-dot[data-uid="${id}"]`);
  if (dot) dot.classList.add('online');
});

// A user went offline
socket.on('user_offline', ({ id }) => {
  const dot = document.querySelector(`.status-dot[data-uid="${id}"]`);
  if (dot) dot.classList.remove('online');
});

// ── Messages ───────────────────────────────────────────────────────────────────

// Server sent us history for a room
socket.on('message_history', ({ room, messages }) => {
  if (room !== currentRoom) return; // Ignore history for rooms we're not viewing

  const area = document.getElementById('messages-area');
  area.innerHTML = ''; // Clear the loading placeholder

  if (messages.length === 0) {
    area.innerHTML = '<p class="messages-placeholder">No messages yet. Say hi! 👋</p>';
    return;
  }

  let lastDate = null;
  for (const msg of messages) {
    // Insert a "Today" / "Yesterday" / date divider when the date changes
    const msgDate = formatDate(msg.created_at);
    if (msgDate !== lastDate) {
      area.appendChild(createDivider(msgDate));
      lastDate = msgDate;
    }
    area.appendChild(createMessageEl(msg));
  }
  scrollToBottom();
});

// A new real-time message arrived
socket.on('message', (msg) => {
  if (msg.room === currentRoom) {
    // We're viewing this room - show the message immediately
    const area = document.getElementById('messages-area');
    // Remove placeholder if present
    const placeholder = area.querySelector('.messages-placeholder');
    if (placeholder) placeholder.remove();

    area.appendChild(createMessageEl(msg));
    scrollToBottom();
  } else {
    // Message is for a different room - show a notification badge
    markUnread(msg.room, msg.sender_username);
  }
});

// ── Building message elements ─────────────────────────────────────────────────

function createMessageEl(msg) {
  const isMe = msg.sender_id === myId;

  const wrapper = document.createElement('div');
  wrapper.className = `message ${isMe ? 'mine' : 'theirs'}`;

  const header = document.createElement('div');
  header.className = 'message-header';

  const username = document.createElement('span');
  username.className = 'message-username';
  username.textContent = isMe ? 'You' : msg.sender_username;

  const time = document.createElement('span');
  time.className = 'message-time';
  time.textContent = formatTime(msg.created_at);

  header.appendChild(username);
  header.appendChild(time);

  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';
  bubble.textContent = msg.content; // .textContent is safe - won't run injected scripts!

  wrapper.appendChild(header);
  wrapper.appendChild(bubble);
  return wrapper;
}

function createDivider(dateLabel) {
  const div = document.createElement('div');
  div.className = 'day-divider';
  div.textContent = dateLabel;
  return div;
}

function showSystemMessage(text) {
  const area = document.getElementById('messages-area');
  const div = document.createElement('p');
  div.className = 'messages-placeholder';
  div.textContent = text;
  area.appendChild(div);
}

// ── Sending messages ──────────────────────────────────────────────────────────

function sendMessage() {
  const input = document.getElementById('message-input');
  const content = input.value.trim();
  if (!content) return;

  socket.emit('send_message', { room: currentRoom, content });
  input.value = ''; // Clear the input
  input.focus();
}

// Send on Enter key
document.getElementById('message-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

// ── Room switching ────────────────────────────────────────────────────────────

function openRoom(room, displayName) {
  if (room === currentRoom) {
    closeSidebar();
    return;
  }

  currentRoom = room;

  // Update the chat title at the top
  document.getElementById('chat-title').textContent = displayName;

  // Update the message input placeholder
  document.getElementById('message-input').placeholder = `Message ${displayName}`;

  // Highlight the active room button
  document.querySelectorAll('.room-btn, .dm-btn').forEach(b => b.classList.remove('active'));
  const btn = document.getElementById(`room-${room}`);
  if (btn) btn.classList.add('active');

  // Clear unread badge for this room
  clearUnread(room);

  // Clear the messages area while loading
  document.getElementById('messages-area').innerHTML =
    '<p class="messages-placeholder">Loading messages...</p>';

  // Tell the server we're joining this room and ask for its history
  socket.emit('join_room', room);
  socket.emit('get_messages', room);

  closeSidebar(); // Auto-close sidebar on mobile
}

function openDm(otherUser) {
  // DM room name: always smallest ID first so both users get the same room name
  const dmRoom = `dm:${Math.min(myId, otherUser.id)}:${Math.max(myId, otherUser.id)}`;
  openRoom(dmRoom, `@ ${otherUser.username}`);
}

// ── Rendering the DM user list ────────────────────────────────────────────────

function renderDmList(users) {
  const list = document.getElementById('dm-list');
  list.innerHTML = '';

  for (const user of users) {
    if (user.id === myId) continue; // Don't show yourself

    const dmRoom = `dm:${Math.min(myId, user.id)}:${Math.max(myId, user.id)}`;

    const btn = document.createElement('button');
    btn.className = 'dm-btn';
    btn.id = `room-${dmRoom}`;
    btn.onclick = () => openDm(user);

    // Status dot
    const dot = document.createElement('span');
    dot.className = 'status-dot';
    dot.dataset.uid = user.id;

    const name = document.createElement('span');
    name.textContent = user.username;

    btn.appendChild(dot);
    btn.appendChild(name);
    list.appendChild(btn);
  }
}

// Mark a room as having an unread message (shows a badge)
function markUnread(room, senderName) {
  unreadRooms.add(room);
  const btn = document.getElementById(`room-${room}`);
  if (!btn) return;

  // Remove old badge if there is one
  const old = btn.querySelector('.unread-badge');
  if (old) old.remove();

  const badge = document.createElement('span');
  badge.className = 'unread-badge';
  badge.textContent = '!';
  btn.appendChild(badge);

  // Flash the tab title so they notice
  document.title = `(!) ChatApp - ${senderName}`;
}

function clearUnread(room) {
  unreadRooms.delete(room);
  const btn = document.getElementById(`room-${room}`);
  if (btn) {
    const badge = btn.querySelector('.unread-badge');
    if (badge) badge.remove();
  }
  document.title = 'ChatApp';
}

// ── Sidebar toggle (mobile) ───────────────────────────────────────────────────

function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  sidebar.classList.toggle('open');
  overlay.classList.toggle('visible');
}

function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebar-overlay').classList.remove('visible');
}

// ── Logout ────────────────────────────────────────────────────────────────────

function logout() {
  localStorage.clear();
  window.location.href = '/index.html';
}

// ── Helper functions ──────────────────────────────────────────────────────────

function scrollToBottom() {
  const area = document.getElementById('messages-area');
  area.scrollTop = area.scrollHeight;
}

// Format a timestamp like "3:45 PM"
function formatTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// Format a date label like "Today", "Yesterday", or "Feb 25, 2026"
function formatDate(timestamp) {
  const date = new Date(timestamp);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);

  if (date.toDateString() === today.toDateString()) return 'Today';
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}
