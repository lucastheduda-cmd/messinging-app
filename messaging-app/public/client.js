// client.js - Everything the browser does on the chat page

// ── State ─────────────────────────────────────────────────────────────────────
const token  = localStorage.getItem('token');
const myId   = Number(localStorage.getItem('userId'));
const myName = localStorage.getItem('username');

let currentRoom     = 'general';
let allUsers        = [];
let unreadRooms     = new Set();

// My current avatar settings (updated when server confirms a save)
let myAvatarColor = '#7289da';
let myAvatarEmoji = '';

// Temporary selections inside the modal (not saved yet)
let pendingColor = myAvatarColor;
let pendingEmoji = myAvatarEmoji;

if (!token) window.location.href = '/index.html';

// ── Initial UI setup ──────────────────────────────────────────────────────────
document.getElementById('my-username').textContent = myName;
renderAvatar(document.getElementById('my-avatar'), myAvatarColor, myAvatarEmoji, myName);

// ── Socket connection ─────────────────────────────────────────────────────────
const socket = io();

socket.on('connect', () => socket.emit('authenticate', token));

socket.on('authenticated', ({ success }) => {
  if (!success) { logout(); return; }
  socket.emit('get_messages', 'general');
});

socket.on('disconnect', () => showSystemMessage('Disconnected. Reconnecting...'));

// ── User list ─────────────────────────────────────────────────────────────────
socket.on('users_list', (users) => {
  allUsers = users;

  // Pull our own avatar settings out of the list
  const me = users.find(u => u.id === myId);
  if (me) {
    myAvatarColor = me.avatar_color || '#7289da';
    myAvatarEmoji = me.avatar_emoji || '';
    pendingColor  = myAvatarColor;
    pendingEmoji  = myAvatarEmoji;
    renderAvatar(document.getElementById('my-avatar'), myAvatarColor, myAvatarEmoji, myName);
  }

  renderDmList(users);
});

socket.on('user_online', ({ id, username, avatar_color, avatar_emoji }) => {
  const dot = document.querySelector(`.status-dot[data-uid="${id}"]`);
  if (dot) dot.classList.add('online');
  // Update avatar in the DM list in case it changed
  const miniAvatar = document.querySelector(`.dm-mini-avatar[data-uid="${id}"]`);
  if (miniAvatar) renderAvatar(miniAvatar, avatar_color, avatar_emoji, username);
});

socket.on('user_offline', ({ id }) => {
  const dot = document.querySelector(`.status-dot[data-uid="${id}"]`);
  if (dot) dot.classList.remove('online');
});

// Someone updated their avatar — update everywhere without refreshing
socket.on('avatar_updated', ({ id, avatar_color, avatar_emoji }) => {
  // Update in our local allUsers cache
  const user = allUsers.find(u => u.id === id);
  if (user) { user.avatar_color = avatar_color; user.avatar_emoji = avatar_emoji; }

  // If it's us, update our own avatar in the sidebar footer
  if (id === myId) {
    myAvatarColor = avatar_color;
    myAvatarEmoji = avatar_emoji;
    renderAvatar(document.getElementById('my-avatar'), myAvatarColor, myAvatarEmoji, myName);
  }

  // Update the small avatar in the DM list
  const miniAvatar = document.querySelector(`.dm-mini-avatar[data-uid="${id}"]`);
  if (miniAvatar) renderAvatar(miniAvatar, avatar_color, avatar_emoji, user?.username || '?');

  // Update any visible message avatars for this user
  document.querySelectorAll(`.message-avatar[data-uid="${id}"]`).forEach(el => {
    renderAvatar(el, avatar_color, avatar_emoji, user?.username || '?');
  });
});

// ── Messages ───────────────────────────────────────────────────────────────────
socket.on('message_history', ({ room, messages }) => {
  if (room !== currentRoom) return;
  const area = document.getElementById('messages-area');
  area.innerHTML = '';

  if (messages.length === 0) {
    area.innerHTML = '<p class="messages-placeholder">No messages yet. Say hi! 👋</p>';
    return;
  }

  let lastDate = null;
  for (const msg of messages) {
    const msgDate = formatDate(msg.created_at);
    if (msgDate !== lastDate) { area.appendChild(createDivider(msgDate)); lastDate = msgDate; }
    area.appendChild(createMessageEl(msg));
  }
  scrollToBottom();
});

socket.on('message', (msg) => {
  if (msg.room === currentRoom) {
    const area = document.getElementById('messages-area');
    area.querySelector('.messages-placeholder')?.remove();
    area.appendChild(createMessageEl(msg));
    scrollToBottom();
  } else {
    markUnread(msg.room, msg.sender_username);
  }
});

// ── Building message elements ─────────────────────────────────────────────────
function createMessageEl(msg) {
  const isMe = msg.sender_id === myId;

  const wrapper = document.createElement('div');
  wrapper.className = `message ${isMe ? 'mine' : 'theirs'}`;

  // Show a small avatar to the left of messages from other people
  if (!isMe) {
    const avatarEl = document.createElement('div');
    avatarEl.className = 'message-avatar';
    avatarEl.dataset.uid = msg.sender_id;
    // Look up current avatar in case it changed since message was sent
    const user = allUsers.find(u => u.id === msg.sender_id);
    const color = user?.avatar_color || msg.avatar_color || '#7289da';
    const emoji = user?.avatar_emoji || msg.avatar_emoji || '';
    renderAvatar(avatarEl, color, emoji, msg.sender_username);
    wrapper.appendChild(avatarEl);
  }

  const content = document.createElement('div');

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
  bubble.textContent = msg.content; // .textContent keeps us safe from XSS attacks

  content.appendChild(header);
  content.appendChild(bubble);
  wrapper.appendChild(content);
  return wrapper;
}

function createDivider(dateLabel) {
  const div = document.createElement('div');
  div.className = 'day-divider';
  div.textContent = dateLabel;
  return div;
}

function showSystemMessage(text) {
  const div = document.createElement('p');
  div.className = 'messages-placeholder';
  div.textContent = text;
  document.getElementById('messages-area').appendChild(div);
}

// ── Sending messages ──────────────────────────────────────────────────────────
function sendMessage() {
  const input = document.getElementById('message-input');
  const content = input.value.trim();
  if (!content) return;
  socket.emit('send_message', { room: currentRoom, content });
  input.value = '';
  input.focus();
}

document.getElementById('message-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});

// ── Room switching ────────────────────────────────────────────────────────────
function openRoom(room, displayName) {
  if (room === currentRoom) { closeSidebar(); return; }
  currentRoom = room;
  document.getElementById('chat-title').textContent = displayName;
  document.getElementById('message-input').placeholder = `Message ${displayName}`;
  document.querySelectorAll('.room-btn, .dm-btn').forEach(b => b.classList.remove('active'));
  document.getElementById(`room-${room}`)?.classList.add('active');
  clearUnread(room);
  document.getElementById('messages-area').innerHTML = '<p class="messages-placeholder">Loading messages...</p>';
  socket.emit('join_room', room);
  socket.emit('get_messages', room);
  closeSidebar();
}

function openDm(otherUser) {
  const dmRoom = `dm:${Math.min(myId, otherUser.id)}:${Math.max(myId, otherUser.id)}`;
  openRoom(dmRoom, `@ ${otherUser.username}`);
}

// ── Rendering the DM user list ────────────────────────────────────────────────
function renderDmList(users) {
  const list = document.getElementById('dm-list');
  list.innerHTML = '';

  for (const user of users) {
    if (user.id === myId) continue;

    const dmRoom = `dm:${Math.min(myId, user.id)}:${Math.max(myId, user.id)}`;

    const btn = document.createElement('button');
    btn.className = 'dm-btn';
    btn.id = `room-${dmRoom}`;
    btn.onclick = () => openDm(user);

    // Small avatar circle
    const mini = document.createElement('div');
    mini.className = 'dm-mini-avatar';
    mini.dataset.uid = user.id;
    mini.style.cssText = 'width:20px;height:20px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:0.6rem;font-weight:700;color:white;flex-shrink:0';
    renderAvatar(mini, user.avatar_color, user.avatar_emoji, user.username);

    const dot = document.createElement('span');
    dot.className = 'status-dot';
    dot.dataset.uid = user.id;

    const name = document.createElement('span');
    name.textContent = user.username;

    btn.appendChild(mini);
    btn.appendChild(dot);
    btn.appendChild(name);
    list.appendChild(btn);
  }
}

// ── Unread badges ─────────────────────────────────────────────────────────────
function markUnread(room, senderName) {
  unreadRooms.add(room);
  const btn = document.getElementById(`room-${room}`);
  if (!btn) return;
  btn.querySelector('.unread-badge')?.remove();
  const badge = document.createElement('span');
  badge.className = 'unread-badge';
  badge.textContent = '!';
  btn.appendChild(badge);
  document.title = `(!) ChatApp - ${senderName}`;
}

function clearUnread(room) {
  unreadRooms.delete(room);
  document.getElementById(`room-${room}`)?.querySelector('.unread-badge')?.remove();
  document.title = 'ChatApp';
}

// ── Avatar customization modal ────────────────────────────────────────────────

const COLORS = [
  '#7289da', '#43b581', '#f04747', '#faa61a',
  '#ff73fa', '#1abc9c', '#e91e63', '#9c27b0',
  '#3f51b5', '#00bcd4', '#ff5722', '#607d8b'
];

const EMOJIS = [
  '😀','😎','🤩','😈','👻','🐱','🐶','🦊',
  '🐼','🐸','🦁','🐯','🦄','🐲','🦋','🌸',
  '⭐','🔥','💎','🎮','🚀','⚡','🌊','🍕'
];

function openAvatarModal() {
  pendingColor = myAvatarColor;
  pendingEmoji = myAvatarEmoji;

  // Build color grid
  const colorGrid = document.getElementById('color-grid');
  colorGrid.innerHTML = '';
  for (const color of COLORS) {
    const swatch = document.createElement('div');
    swatch.className = 'color-swatch' + (color === pendingColor ? ' selected' : '');
    swatch.style.background = color;
    swatch.onclick = () => {
      pendingColor = color;
      colorGrid.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'));
      swatch.classList.add('selected');
      updatePreview();
    };
    colorGrid.appendChild(swatch);
  }

  // Build emoji grid — first button is "None" (shows your initial)
  const emojiGrid = document.getElementById('emoji-grid');
  emojiGrid.innerHTML = '';

  const noneBtn = document.createElement('button');
  noneBtn.className = 'emoji-btn' + (pendingEmoji === '' ? ' selected' : '');
  noneBtn.textContent = myName[0].toUpperCase();
  noneBtn.title = 'Use your initial';
  noneBtn.onclick = () => {
    pendingEmoji = '';
    emojiGrid.querySelectorAll('.emoji-btn').forEach(b => b.classList.remove('selected'));
    noneBtn.classList.add('selected');
    updatePreview();
  };
  emojiGrid.appendChild(noneBtn);

  for (const emoji of EMOJIS) {
    const btn = document.createElement('button');
    btn.className = 'emoji-btn' + (emoji === pendingEmoji ? ' selected' : '');
    btn.textContent = emoji;
    btn.onclick = () => {
      pendingEmoji = emoji;
      emojiGrid.querySelectorAll('.emoji-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      updatePreview();
    };
    emojiGrid.appendChild(btn);
  }

  updatePreview();
  document.getElementById('avatar-modal').classList.remove('hidden');
  document.getElementById('avatar-modal-backdrop').classList.remove('hidden');
}

function updatePreview() {
  renderAvatar(document.getElementById('avatar-preview'), pendingColor, pendingEmoji, myName);
}

function closeAvatarModal() {
  document.getElementById('avatar-modal').classList.add('hidden');
  document.getElementById('avatar-modal-backdrop').classList.add('hidden');
}

async function saveAvatar() {
  try {
    const res = await fetch('/api/avatar', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`  // Send our login token to prove who we are
      },
      body: JSON.stringify({ color: pendingColor, emoji: pendingEmoji })
    });

    if (res.ok) {
      myAvatarColor = pendingColor;
      myAvatarEmoji = pendingEmoji;
      closeAvatarModal();
    } else {
      alert('Failed to save avatar, try again.');
    }
  } catch {
    alert('Could not connect to server.');
  }
}

// ── Avatar rendering helper ───────────────────────────────────────────────────
// This function sets up any avatar element with the right color and emoji/initial.
// We reuse it everywhere: sidebar, messages, modal preview, DM list.
function renderAvatar(el, color, emoji, username) {
  el.style.background = color || '#7289da';
  el.textContent = emoji || (username ? username[0].toUpperCase() : '?');
}

// ── Sidebar toggle (mobile) ───────────────────────────────────────────────────
function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('open');
  document.getElementById('sidebar-overlay').classList.toggle('visible');
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

// ── Helpers ───────────────────────────────────────────────────────────────────
function scrollToBottom() {
  const area = document.getElementById('messages-area');
  area.scrollTop = area.scrollHeight;
}

function formatTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDate(timestamp) {
  const date = new Date(timestamp);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return 'Today';
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}
