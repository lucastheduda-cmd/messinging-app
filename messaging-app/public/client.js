// client.js - Everything the browser does on the chat page

// ── State ─────────────────────────────────────────────────────────────────────
const token  = localStorage.getItem('token');
const myId   = Number(localStorage.getItem('userId'));
const myName = localStorage.getItem('username');

let currentRoom   = 'general';
let allUsers      = [];
let unreadRooms   = new Set();
let amIAdmin      = false;
let soundEnabled  = localStorage.getItem('sound') !== 'off'; // default: on
let pendingImage  = null; // base64 image waiting to be sent
let activeReactionMessageId = null; // which message the reaction picker is open for

// Avatar modal state
let myAvatarColor = '#7289da';
let myAvatarEmoji = '';
let myAvatarImage = null;
let pendingColor  = myAvatarColor;
let pendingEmoji  = myAvatarEmoji;
let pendingImage_pfp = undefined; // undefined = unchanged, null = remove, string = new image

if (!token) window.location.href = '/index.html';

// ── Initial UI ────────────────────────────────────────────────────────────────
document.getElementById('my-username').textContent = myName;
renderAvatar(document.getElementById('my-avatar'), myAvatarColor, myAvatarEmoji, myAvatarImage, myName);
updateSoundButton();

// ── Socket ────────────────────────────────────────────────────────────────────
const socket = io();
socket.on('connect', () => socket.emit('authenticate', token));

socket.on('authenticated', ({ success, isAdmin }) => {
  if (!success) { logout(); return; }
  amIAdmin = isAdmin;
  if (isAdmin) document.getElementById('clear-btn').classList.remove('hidden');
  socket.emit('get_messages', 'general');
});

socket.on('banned', () => { alert('Your account has been banned.'); logout(); });
socket.on('disconnect', () => showSystemMessage('Disconnected. Reconnecting...'));

// ── Users ─────────────────────────────────────────────────────────────────────
socket.on('users_list', (users) => {
  allUsers = users;
  const me = users.find(u => u.id === myId);
  if (me) {
    myAvatarColor = me.avatar_color || '#7289da';
    myAvatarEmoji = me.avatar_emoji || '';
    myAvatarImage = me.avatar_image || null;
    pendingColor = myAvatarColor;
    pendingEmoji = myAvatarEmoji;
    renderAvatar(document.getElementById('my-avatar'), myAvatarColor, myAvatarEmoji, myAvatarImage, myName);
  }
  renderDmList(users);
});

socket.on('user_online', ({ id, username, avatar_color, avatar_emoji, avatar_image }) => {
  document.querySelector(`.status-dot[data-uid="${id}"]`)?.classList.add('online');
  const mini = document.querySelector(`.dm-mini-avatar[data-uid="${id}"]`);
  if (mini) renderAvatar(mini, avatar_color, avatar_emoji, avatar_image, username);
});

socket.on('user_offline', ({ id }) => {
  document.querySelector(`.status-dot[data-uid="${id}"]`)?.classList.remove('online');
});

socket.on('avatar_updated', ({ id, avatar_color, avatar_emoji, avatar_image }) => {
  const user = allUsers.find(u => u.id === id);
  if (user) { user.avatar_color = avatar_color; user.avatar_emoji = avatar_emoji; user.avatar_image = avatar_image; }
  if (id === myId) {
    myAvatarColor = avatar_color; myAvatarEmoji = avatar_emoji; myAvatarImage = avatar_image;
    renderAvatar(document.getElementById('my-avatar'), myAvatarColor, myAvatarEmoji, myAvatarImage, myName);
  }
  const mini = document.querySelector(`.dm-mini-avatar[data-uid="${id}"]`);
  if (mini) renderAvatar(mini, avatar_color, avatar_emoji, avatar_image, user?.username || '?');
  document.querySelectorAll(`.message-avatar[data-uid="${id}"]`).forEach(el =>
    renderAvatar(el, avatar_color, avatar_emoji, avatar_image, user?.username || '?')
  );
});

// ── Messages ──────────────────────────────────────────────────────────────────
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
    const d = formatDate(msg.created_at);
    if (d !== lastDate) { area.appendChild(createDivider(d)); lastDate = d; }
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
    if (document.hidden && soundEnabled) playNotificationSound();
  } else {
    markUnread(msg.room, msg.sender_username);
    if (soundEnabled) playNotificationSound();
  }
});

// Someone edited a message — update it on screen
socket.on('message_edited', ({ messageId, content }) => {
  const bubble = document.querySelector(`.message-bubble[data-id="${messageId}"]`);
  if (!bubble) return;
  bubble.textContent = content;
  const header = bubble.closest('.message-content')?.querySelector('.message-header');
  if (header && !header.querySelector('.edited-label')) {
    const label = document.createElement('span');
    label.className = 'edited-label';
    label.textContent = '(edited)';
    header.appendChild(label);
  }
});

// Someone deleted a message — remove it from the DOM
socket.on('message_deleted', ({ messageId }) => {
  document.getElementById(`msg-${messageId}`)?.remove();
});

// Reactions updated — re-render the reactions bar on that message
socket.on('reaction_updated', ({ messageId, reactions }) => {
  const el = document.getElementById(`msg-${messageId}`);
  if (!el) return;
  let bar = el.querySelector('.reactions-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'reactions-bar';
    el.querySelector('.message-content').appendChild(bar);
  }
  renderReactionsBar(bar, messageId, reactions);
});

// Admin cleared chat
socket.on('room_cleared', ({ room }) => {
  if (room === currentRoom) {
    document.getElementById('messages-area').innerHTML =
      '<p class="messages-placeholder">Chat was cleared by an admin.</p>';
  }
});

// ── Building message elements ─────────────────────────────────────────────────
function createMessageEl(msg) {
  const isMe = msg.sender_id === myId;
  const wrapper = document.createElement('div');
  wrapper.className = `message ${isMe ? 'mine' : 'theirs'}`;
  wrapper.id = `msg-${msg.id}`;

  // Avatar (only for other people's messages)
  if (!isMe) {
    const avatarEl = document.createElement('div');
    avatarEl.className = 'message-avatar';
    avatarEl.dataset.uid = msg.sender_id;
    const user = allUsers.find(u => u.id === msg.sender_id);
    renderAvatar(avatarEl, user?.avatar_color || msg.avatar_color, user?.avatar_emoji || msg.avatar_emoji, user?.avatar_image || msg.avatar_image, msg.sender_username);
    wrapper.appendChild(avatarEl);
  }

  const content = document.createElement('div');
  content.className = 'message-content';

  // Header: username + time + (edited)
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
  if (msg.edited) {
    const editedLabel = document.createElement('span');
    editedLabel.className = 'edited-label';
    editedLabel.textContent = '(edited)';
    header.appendChild(editedLabel);
  }
  content.appendChild(header);

  // Image (if message has one)
  if (msg.image_data) {
    const img = document.createElement('img');
    img.className = 'message-image';
    img.src = msg.image_data;
    img.alt = 'Shared image';
    img.onclick = () => window.open(msg.image_data, '_blank'); // Click to open full size
    content.appendChild(img);
  }

  // Text bubble (if message has text)
  if (msg.content) {
    const bubble = document.createElement('div');
    bubble.className = 'message-bubble';
    bubble.dataset.id = msg.id;
    bubble.textContent = msg.content; // .textContent is safe against XSS
    content.appendChild(bubble);
  }

  // Reactions bar
  if (msg.reactions?.length > 0) {
    const bar = document.createElement('div');
    bar.className = 'reactions-bar';
    renderReactionsBar(bar, msg.id, msg.reactions);
    content.appendChild(bar);
  }

  // Action buttons (react, edit, delete) — appear on hover
  const actions = document.createElement('div');
  actions.className = 'message-actions';

  const reactBtn = document.createElement('button');
  reactBtn.className = 'action-btn';
  reactBtn.textContent = '😊';
  reactBtn.title = 'React';
  reactBtn.onclick = (e) => { e.stopPropagation(); openReactionPicker(msg.id, reactBtn); };
  actions.appendChild(reactBtn);

  if (isMe) {
    // Edit button (only for text messages you sent)
    if (msg.content) {
      const editBtn = document.createElement('button');
      editBtn.className = 'action-btn';
      editBtn.textContent = '✏️';
      editBtn.title = 'Edit';
      editBtn.onclick = () => startEdit(msg.id, msg.content);
      actions.appendChild(editBtn);
    }
    // Delete button
    const delBtn = document.createElement('button');
    delBtn.className = 'action-btn';
    delBtn.textContent = '🗑️';
    delBtn.title = 'Delete';
    delBtn.onclick = () => deleteMessage(msg.id);
    actions.appendChild(delBtn);
  } else if (amIAdmin) {
    // Admins can delete anyone's message
    const delBtn = document.createElement('button');
    delBtn.className = 'action-btn';
    delBtn.textContent = '🗑️';
    delBtn.title = 'Delete (admin)';
    delBtn.onclick = () => deleteMessage(msg.id);
    actions.appendChild(delBtn);
  }

  content.appendChild(actions);
  wrapper.appendChild(content);
  return wrapper;
}

function createDivider(label) {
  const div = document.createElement('div');
  div.className = 'day-divider';
  div.textContent = label;
  return div;
}

function showSystemMessage(text) {
  const p = document.createElement('p');
  p.className = 'messages-placeholder';
  p.textContent = text;
  document.getElementById('messages-area').appendChild(p);
}

// ── Sending messages ──────────────────────────────────────────────────────────
function sendMessage() {
  const input = document.getElementById('message-input');
  const content = input.value.trim();
  if (!content && !pendingImage) return;

  socket.emit('send_message', { room: currentRoom, content, imageData: pendingImage });
  input.value = '';
  clearPendingImage();
  input.focus();
}

document.getElementById('message-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});

// Handle pasting an image from clipboard (e.g. Ctrl+V a screenshot)
document.getElementById('message-input').addEventListener('paste', (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      e.preventDefault();
      compressImage(item.getAsFile(), setPendingImage);
    }
  }
});

// Handle picking a file with the 📎 button
function handleFileSelect(e) {
  const file = e.target.files[0];
  if (file) compressImage(file, setPendingImage);
  e.target.value = ''; // Reset so same file can be picked again
}

// Compress an image file and call the callback with base64 data URL
function compressImage(file, callback) {
  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      // Scale down to max 800px while keeping aspect ratio
      const scale = Math.min(1, 800 / img.width, 800 / img.height);
      canvas.width = img.width * scale;
      canvas.height = img.height * scale;
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      callback(canvas.toDataURL('image/jpeg', 0.75)); // 75% quality JPEG
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

function setPendingImage(dataUrl) {
  pendingImage = dataUrl;
  document.getElementById('image-preview').src = dataUrl;
  document.getElementById('image-preview-area').classList.remove('hidden');
}

function clearPendingImage() {
  pendingImage = null;
  document.getElementById('image-preview-area').classList.add('hidden');
  document.getElementById('image-preview').src = '';
}

// ── Edit & delete ─────────────────────────────────────────────────────────────

function startEdit(messageId, currentContent) {
  const bubble = document.querySelector(`.message-bubble[data-id="${messageId}"]`);
  if (!bubble) return;

  // Replace the bubble with an input field pre-filled with the current text
  const editInput = document.createElement('input');
  editInput.className = 'edit-input';
  editInput.value = currentContent;
  editInput.dataset.original = currentContent;

  editInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const newContent = editInput.value.trim();
      if (newContent && newContent !== currentContent) {
        socket.emit('edit_message', { messageId, content: newContent });
      }
      // Restore bubble (the server will update it via message_edited event)
      editInput.replaceWith(bubble);
    }
    if (e.key === 'Escape') {
      editInput.replaceWith(bubble); // Cancel edit
    }
  });

  bubble.replaceWith(editInput);
  editInput.focus();
  editInput.select();
}

function deleteMessage(messageId) {
  if (!confirm('Delete this message?')) return;
  socket.emit('delete_message', { messageId });
}

// ── Reactions ─────────────────────────────────────────────────────────────────

function openReactionPicker(messageId, anchorEl) {
  const picker = document.getElementById('reaction-picker');
  activeReactionMessageId = messageId;

  // Position the picker above the anchor button
  const rect = anchorEl.getBoundingClientRect();
  picker.style.left = `${rect.left}px`;
  picker.style.top  = `${rect.top - 50}px`;
  picker.classList.remove('hidden');
}

function pickReaction(emoji) {
  if (!activeReactionMessageId) return;
  socket.emit('toggle_reaction', { messageId: activeReactionMessageId, emoji });
  document.getElementById('reaction-picker').classList.add('hidden');
  activeReactionMessageId = null;
}

// Close reaction picker when clicking anywhere else
document.addEventListener('click', () => {
  document.getElementById('reaction-picker').classList.add('hidden');
  activeReactionMessageId = null;
});

function renderReactionsBar(bar, messageId, reactions) {
  bar.innerHTML = '';
  for (const { emoji, count, userIds } of reactions) {
    const pill = document.createElement('button');
    const isMine = userIds.includes(myId);
    pill.className = 'reaction-pill' + (isMine ? ' mine' : '');
    pill.textContent = `${emoji} ${count}`;
    pill.title = isMine ? 'Click to remove your reaction' : 'Click to react';
    pill.onclick = () => socket.emit('toggle_reaction', { messageId, emoji });
    bar.appendChild(pill);
  }
}

// ── Sound ─────────────────────────────────────────────────────────────────────
// We generate the sound with the Web Audio API — no audio files needed!
function playNotificationSound() {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.2, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.3);
  } catch { /* Audio not supported */ }
}

function toggleSound() {
  soundEnabled = !soundEnabled;
  localStorage.setItem('sound', soundEnabled ? 'on' : 'off');
  updateSoundButton();
}

function updateSoundButton() {
  const btn = document.getElementById('sound-toggle');
  btn.textContent = soundEnabled ? '🔔' : '🔕';
  btn.classList.toggle('muted', !soundEnabled);
  btn.title = soundEnabled ? 'Sound on (click to mute)' : 'Sound off (click to unmute)';
}

// ── Search ────────────────────────────────────────────────────────────────────
function toggleSearch() {
  const bar = document.getElementById('search-bar');
  bar.classList.toggle('hidden');
  if (!bar.classList.contains('hidden')) {
    document.getElementById('search-input').focus();
  } else {
    closeSearch();
  }
}

function closeSearch() {
  document.getElementById('search-bar').classList.add('hidden');
  document.getElementById('search-input').value = '';
  // Show all messages again
  document.querySelectorAll('.message').forEach(m => m.classList.remove('search-hidden'));
}

function searchMessages(query) {
  const q = query.toLowerCase().trim();
  document.querySelectorAll('.message').forEach(msg => {
    const bubble = msg.querySelector('.message-bubble');
    const text = bubble?.textContent?.toLowerCase() || '';
    msg.classList.toggle('search-hidden', q !== '' && !text.includes(q));
  });
}

// ── Room switching ────────────────────────────────────────────────────────────
function openRoom(room, displayName) {
  if (room === currentRoom) { closeSidebar(); return; }
  currentRoom = room;
  closeSearch();
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

// ── DM list ───────────────────────────────────────────────────────────────────
function renderDmList(users) {
  const list = document.getElementById('dm-list');
  list.innerHTML = '';
  for (const user of users) {
    if (user.id === myId) continue;
    const dmRoom = `dm:${Math.min(myId, user.id)}:${Math.max(myId, user.id)}`;
    const btn = document.createElement('button');
    btn.className = 'dm-btn' + (user.is_banned ? ' is-banned' : '');
    btn.id = `room-${dmRoom}`;
    btn.onclick = () => openDm(user);

    const mini = document.createElement('div');
    mini.className = 'dm-mini-avatar';
    mini.dataset.uid = user.id;
    mini.style.cssText = 'width:20px;height:20px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:0.6rem;font-weight:700;color:white;flex-shrink:0;overflow:hidden;';
    renderAvatar(mini, user.avatar_color, user.avatar_emoji, user.avatar_image, user.username);

    const dot = document.createElement('span');
    dot.className = 'status-dot';
    dot.dataset.uid = user.id;

    const name = document.createElement('span');
    name.textContent = user.username;

    btn.appendChild(mini);
    btn.appendChild(dot);
    btn.appendChild(name);

    if (user.is_admin) {
      const crown = document.createElement('span');
      crown.className = 'admin-crown';
      crown.textContent = '👑';
      btn.appendChild(crown);
    }

    if (amIAdmin && !user.is_admin) {
      const banBtn = document.createElement('button');
      banBtn.className = 'ban-btn' + (user.is_banned ? ' banned' : '');
      banBtn.title = user.is_banned ? 'Unban' : 'Ban';
      banBtn.textContent = user.is_banned ? '✓' : '🚫';
      banBtn.onclick = (e) => { e.stopPropagation(); toggleBan(user.id, user.username, user.is_banned); };
      btn.appendChild(banBtn);
    }

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

// ── Admin actions ─────────────────────────────────────────────────────────────
async function clearChat() {
  if (!confirm('Clear all messages in this room? This cannot be undone.')) return;
  const res = await fetch(`/api/admin/clear/${encodeURIComponent(currentRoom)}`, {
    method: 'DELETE', headers: { 'Authorization': `Bearer ${token}` }
  });
  if (!res.ok) alert('Failed to clear chat.');
}

async function toggleBan(userId, username, currentlyBanned) {
  const action = currentlyBanned ? 'Unban' : 'Ban';
  if (!confirm(`${action} ${username}?`)) return;
  const res = await fetch(`/api/admin/ban/${userId}`, {
    method: 'POST', headers: { 'Authorization': `Bearer ${token}` }
  });
  if (!res.ok) alert(`Failed to ${action.toLowerCase()} user.`);
}

// ── Avatar modal ──────────────────────────────────────────────────────────────
const COLORS = ['#7289da','#43b581','#f04747','#faa61a','#ff73fa','#1abc9c','#e91e63','#9c27b0','#3f51b5','#00bcd4','#ff5722','#607d8b'];
const EMOJIS = ['😀','😎','🤩','😈','👻','🐱','🐶','🦊','🐼','🐸','🦁','🐯','🦄','🐲','🦋','🌸','⭐','🔥','💎','🎮','🚀','⚡','🌊','🍕'];

function openAvatarModal() {
  pendingColor = myAvatarColor;
  pendingEmoji = myAvatarEmoji;
  pendingImage_pfp = undefined; // undefined = no change

  // Color grid
  const colorGrid = document.getElementById('color-grid');
  colorGrid.innerHTML = '';
  for (const color of COLORS) {
    const s = document.createElement('div');
    s.className = 'color-swatch' + (color === pendingColor ? ' selected' : '');
    s.style.background = color;
    s.onclick = () => {
      pendingColor = color;
      colorGrid.querySelectorAll('.color-swatch').forEach(x => x.classList.remove('selected'));
      s.classList.add('selected');
      updatePreview();
    };
    colorGrid.appendChild(s);
  }

  // Emoji grid
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

  // Show/hide remove photo button
  document.getElementById('pfp-remove-btn').style.display = myAvatarImage ? 'block' : 'none';

  updatePreview();
  document.getElementById('avatar-modal').classList.remove('hidden');
  document.getElementById('avatar-modal-backdrop').classList.remove('hidden');
}

function updatePreview() {
  const preview = document.getElementById('avatar-preview');
  // If a new PFP is staged, show it; if removing, show color/emoji; otherwise show current
  const imgToShow = pendingImage_pfp !== undefined ? (pendingImage_pfp || null) : myAvatarImage;
  renderAvatar(preview, pendingColor, pendingEmoji, imgToShow, myName);
}

function closeAvatarModal() {
  document.getElementById('avatar-modal').classList.add('hidden');
  document.getElementById('avatar-modal-backdrop').classList.add('hidden');
}

// User picked a profile picture file
function handlePfpUpload(event) {
  const file = event.target.files[0];
  if (!file) return;
  // Compress PFP to 128x128 for storage
  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = 128; canvas.height = 128;
      const ctx = canvas.getContext('2d');
      // Crop to square from center, then draw at 128x128
      const size = Math.min(img.width, img.height);
      const sx = (img.width - size) / 2;
      const sy = (img.height - size) / 2;
      ctx.drawImage(img, sx, sy, size, size, 0, 0, 128, 128);
      pendingImage_pfp = canvas.toDataURL('image/jpeg', 0.85);
      document.getElementById('pfp-remove-btn').style.display = 'block';
      updatePreview();
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
  event.target.value = '';
}

function removePfp() {
  pendingImage_pfp = null; // null = explicitly remove
  document.getElementById('pfp-remove-btn').style.display = 'none';
  updatePreview();
}

async function saveAvatar() {
  // pendingImage_pfp: undefined = keep existing, null = remove, string = new image
  const imageToSave = pendingImage_pfp !== undefined ? pendingImage_pfp : myAvatarImage;
  try {
    const res = await fetch('/api/avatar', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ color: pendingColor, emoji: pendingEmoji, image: imageToSave })
    });
    if (res.ok) { closeAvatarModal(); }
    else { alert('Failed to save avatar.'); }
  } catch { alert('Could not connect to server.'); }
}

// ── Avatar rendering ──────────────────────────────────────────────────────────
// This handles all three avatar types: photo, emoji, or color+initial
function renderAvatar(el, color, emoji, image, username) {
  el.style.background = color || '#7289da';
  el.innerHTML = ''; // Clear previous content

  if (image) {
    // Show the profile picture
    const img = document.createElement('img');
    img.src = image;
    img.alt = username || '?';
    img.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:50%;';
    el.appendChild(img);
  } else {
    // Show emoji or first letter of username
    el.textContent = emoji || (username ? username[0].toUpperCase() : '?');
  }
}

// ── Sidebar ───────────────────────────────────────────────────────────────────
function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('open');
  document.getElementById('sidebar-overlay').classList.toggle('visible');
}
function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebar-overlay').classList.remove('visible');
}

// ── Logout ────────────────────────────────────────────────────────────────────
function logout() { localStorage.clear(); window.location.href = '/index.html'; }

// ── Helpers ───────────────────────────────────────────────────────────────────
function scrollToBottom() {
  const area = document.getElementById('messages-area');
  area.scrollTop = area.scrollHeight;
}
function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function formatDate(ts) {
  const d = new Date(ts), today = new Date(), yest = new Date(today);
  yest.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yest.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}
