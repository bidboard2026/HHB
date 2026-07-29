const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
const db = require('./db');
const captcha = require('./captcha');
const { attachCallSignaling } = require('./call-signaling');

const app = express();
app.set('trust proxy', true);

// Lock CORS to your real domain in production by setting CORS_ORIGIN
// (e.g. CORS_ORIGIN=https://chat.bidboard.info). Defaults to "allow everything"
// if unset, which is fine for local testing but looser than needed once live.
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
app.use(cors({ origin: CORS_ORIGIN }));

app.use(express.json({ limit: '8mb' })); // higher limit so PM image attachments (base64) fit

// Serve the frontend (pages/ sits next to server/) so the whole site is one deployment.
app.use(express.static(path.join(__dirname, '../pages')));

const ADMIN_KEY = process.env.ADMIN_KEY || null; // optional master override, off by default

// Wraps an async route handler so thrown errors become a 500 instead of crashing the process.
function h(fn) {
  return (req, res) => fn(req, res).catch(err => {
    console.error(err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  });
}

async function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (token) {
    const admin = await db.getAdminByToken(token);
    if (admin) { req.admin = admin; return next(); }
  }
  if (ADMIN_KEY && req.headers['x-admin-key'] === ADMIN_KEY) return next();
  return res.status(401).json({ error: 'Not authorized. Please log in to the control panel again.' });
}

async function requireAuth(req, res, next) {
  const token = req.headers['x-auth-token'] || req.body.token || req.query.token;
  if (!token) return res.status(401).json({ error: 'Missing auth token.' });
  const user = await db.getUserByToken(token);
  if (!user) return res.status(401).json({ error: 'Invalid session, please log in again.' });
  req.user = user;
  req.token = token;
  next();
}

// ---------- Captcha ----------

app.get('/api/captcha', (req, res) => {
  res.json(captcha.generateCaptcha());
});

// ---------- Auth ----------

app.post('/api/register', h(async (req, res) => {
  const { username, password, email, gender, roomId, captchaId, captchaAnswer } = req.body;
  if (!captcha.verifyCaptcha(captchaId, captchaAnswer)) {
    return res.status(400).json({ error: 'Captcha incorrect or expired. Please try again.' });
  }
  if (!username || !password || password.length < 6) {
    return res.status(400).json({ error: 'Nickname and a 6+ character password are required.' });
  }
  const result = await db.createUser({ username, password, isGuest: false, email, gender, roomId });
  if (result.error) return res.status(400).json({ error: result.error });

  const geoResult = await db.refreshUserGeo(username, req.ip, req.headers['user-agent']);
  const finalUser = geoResult ? geoResult.user : result.user;
  if (roomId) await db.recordRoomLogin(roomId, finalUser, { ip: req.ip, userAgent: req.headers['user-agent'], geo: geoResult ? geoResult.geo : null });

  res.json({ token: finalUser.token, user: db.publicProfile(finalUser) });
}));

app.post('/api/login', h(async (req, res) => {
  const { username, password, roomId } = req.body;
  if (!username) return res.status(400).json({ error: 'Nickname is required.' });
  const result = await db.login({ username, password, roomId, ip: req.ip, userAgent: req.headers['user-agent'] });
  if (result.error) return res.status(400).json({ error: result.error });
  res.json({ token: result.user.token, user: db.publicProfile(result.user) });
}));

// ---------- Profile ----------

app.get('/api/profile', requireAuth, h(async (req, res) => {
  res.json({ user: db.publicProfile(req.user) });
}));

app.post('/api/profile', requireAuth, h(async (req, res) => {
  const result = await db.updateUser(req.token, req.body);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json({ user: db.publicProfile(result.user) });
}));

app.post('/api/settings', requireAuth, h(async (req, res) => {
  const { fontFamily, fontSize, fontColor, blockPm, scrollMode, whisperPolicy } = req.body;
  const result = await db.updateUser(req.token, { fontFamily, fontSize, fontColor, blockPm, scrollMode, whisperPolicy });
  if (result.error) return res.status(400).json({ error: result.error });
  res.json({ user: db.publicProfile(result.user) });
}));

app.post('/api/heartbeat', requireAuth, h(async (req, res) => {
  const result = await db.heartbeat(req.token, req.body.roomId);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json({ user: db.publicProfile(result.user) });
}));

// ---------- Users / presence ----------

app.get('/api/users', h(async (req, res) => {
  res.json({ users: await db.listUsers(req.query.roomId) });
}));

// ---------- Public room info (for room-specific login pages / embeds) ----------

app.get('/api/rooms/default', h(async (req, res) => {
  const rooms = await db.listRooms();
  if (!rooms.length) return res.status(404).json({ error: 'No rooms exist yet.' });
  res.json({ id: rooms[0].id });
}));

app.get('/api/rooms/public', h(async (req, res) => {
  const rooms = await db.listRooms();
  res.json({ rooms: rooms.map(r => ({ id: r.id, name: r.name, category: r.category, topic: r.topic })) });
}));

app.get('/api/rooms/:id/public', h(async (req, res) => {
  const room = await db.getRoom(req.params.id);
  if (!room) return res.status(404).json({ error: 'Room not found.' });
  res.json({ room: { id: room.id, name: room.name, topic: room.topic, theme: room.theme, config: { lockRoom: room.config.lockRoom, disableGuestChat: room.config.disableGuestChat } } });
}));

// ---------- Messages ----------

app.get('/api/messages', requireAuth, h(async (req, res) => {
  const room = req.query.room;
  const since = Number(req.query.since || 0);
  if (!room) return res.status(400).json({ error: 'Missing room id.' });
  res.json({ messages: await db.getMessages(room, since, req.user.username) });
}));

app.post('/api/messages', requireAuth, h(async (req, res) => {
  const { room, text, replyToId } = req.body;
  if (!room) return res.status(400).json({ error: 'Missing room id.' });
  const result = await db.addMessage({ token: req.token, room, text: text || '', replyToId });
  if (result.error) return res.status(400).json({ error: result.error });
  if (result.notice) return res.json({ notice: result.notice });
  res.json({ message: result.message });
}));

app.delete('/api/messages/:id', requireAuth, h(async (req, res) => {
  const result = await db.deleteMessage(req.token, Number(req.params.id));
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result);
}));

app.patch('/api/messages/:id', requireAuth, h(async (req, res) => {
  const result = await db.editMessage(req.token, Number(req.params.id), req.body.text);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result);
}));

app.post('/api/messages/:id/react', requireAuth, h(async (req, res) => {
  const result = await db.reactToMessage(req.token, Number(req.params.id), req.body.reaction);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result);
}));

// ---------- Ignore / Block list ----------

app.post('/api/ignore', requireAuth, h(async (req, res) => {
  const result = await db.toggleIgnore(req.token, req.body.targetUsername);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result);
}));

app.get('/api/ignore-info', requireAuth, h(async (req, res) => {
  res.json(await db.getIgnoreInfo(req.user.username));
}));

app.get('/api/users/:username/public', requireAuth, h(async (req, res) => {
  const result = await db.getPublicUserProfile(req.params.username);
  if (result.error) return res.status(404).json({ error: result.error });
  res.json(result);
}));

// ---------- Selected badge tag ----------

app.post('/api/select-tag', requireAuth, h(async (req, res) => {
  const result = await db.setSelectedTag(req.token, req.body.tag);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result);
}));

// ---------- Private Messages ----------

app.get('/api/pms/threads', requireAuth, h(async (req, res) => {
  res.json({ threads: await db.listPmThreads(req.user.username) });
}));

app.get('/api/pms/unread-count', requireAuth, h(async (req, res) => {
  res.json({ count: await db.unreadPmCount(req.user.username) });
}));

app.get('/api/pms', requireAuth, h(async (req, res) => {
  const partner = req.query.with;
  const since = Number(req.query.since || 0);
  if (!partner) return res.status(400).json({ error: 'Missing "with" user.' });
  res.json({ messages: await db.getPmThread(req.user.username, partner, since) });
}));

app.post('/api/pms', requireAuth, h(async (req, res) => {
  const { toUsername, text, imageUrl } = req.body;
  const result = await db.sendPm({ token: req.token, toUsername, text, imageUrl });
  if (result.error) return res.status(400).json({ error: result.error });
  res.json({ pm: result.pm });
}));

app.post('/api/pms/read', requireAuth, h(async (req, res) => {
  await db.markPmRead(req.user.username, req.body.partner);
  res.json({ ok: true });
}));

// ---------- Tag-based moderation (owner/admin/etc. acting inside the chat room) ----------

app.post('/api/mod/mute', requireAuth, h(async (req, res) => {
  const result = await db.modMute({ token: req.token, targetUsername: req.body.targetUsername }, req.body.muted);
  if (result.error) return res.status(403).json({ error: result.error });
  res.json(result);
}));

app.post('/api/mod/kick', requireAuth, h(async (req, res) => {
  const result = await db.modKick({ token: req.token, targetUsername: req.body.targetUsername });
  if (result.error) return res.status(403).json({ error: result.error });
  res.json(result);
}));

app.post('/api/mod/ban', requireAuth, h(async (req, res) => {
  const result = await db.modBanFromRoom({ token: req.token, targetUsername: req.body.targetUsername, roomId: req.body.roomId });
  if (result.error) return res.status(403).json({ error: result.error });
  res.json(result);
}));

app.post('/api/mod/setlevel', requireAuth, h(async (req, res) => {
  const result = await db.modSetLevel({ token: req.token, targetUsername: req.body.targetUsername }, req.body.level);
  if (result.error) return res.status(403).json({ error: result.error });
  res.json(result);
}));

app.get('/api/mod/my-powers', requireAuth, h(async (req, res) => {
  res.json({
    canModerate: db.hasModPower(req.user, db.MOD_TAGS),
    canChangeLevel: db.hasModPower(req.user, db.LEVEL_CHANGE_TAGS),
    capabilities: db.userCapabilities(req.user)
  });
}));

app.get('/api/tag-badges', h(async (req, res) => {
  res.json({ badges: db.TAG_BADGES });
}));

// ---------- Reactions (gifts / likes / dislikes) ----------

app.post('/api/react', requireAuth, h(async (req, res) => {
  const { targetUsername, type } = req.body;
  if (!['like', 'dislike'].includes(type)) return res.status(400).json({ error: 'Invalid reaction type.' });
  const result = await db.addReaction({ token: req.token, targetUsername, type });
  if (result.error) return res.status(400).json({ error: result.error });
  res.json({ target: result.target });
}));

// ---------- Leaderboards ----------

app.get('/api/leaderboard/points', h(async (req, res) => {
  res.json({ leaderboard: await db.leaderboardByPoints() });
}));

app.get('/api/leaderboard/likes', h(async (req, res) => {
  res.json({ leaderboard: await db.leaderboardByLikes() });
}));

// ---------- Admin Auth ----------

app.post('/api/admin/login', h(async (req, res) => {
  if (!captcha.verifyCaptcha(req.body.captchaId, req.body.captchaAnswer)) {
    return res.status(400).json({ error: 'Captcha incorrect or expired. Please try again.' });
  }
  const result = await db.adminLogin({ username: req.body.username, password: req.body.password });
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result);
}));

app.get('/api/admin/me', requireAdmin, h(async (req, res) => {
  res.json({ admin: req.admin ? { username: req.admin.username } : { username: 'master-key' } });
}));

app.post('/api/admin/change-password', requireAdmin, h(async (req, res) => {
  const token = req.headers['x-admin-token'];
  const result = await db.adminChangePassword(token, req.body.password);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result);
}));

// ---------- Admin Dashboard ----------

app.get('/api/admin/stats', requireAdmin, h(async (req, res) => {
  res.json(await db.dashboardStats());
}));

// ---------- Admin: Rooms ----------

app.get('/api/admin/rooms', requireAdmin, h(async (req, res) => {
  res.json({ rooms: await db.listRooms() });
}));

app.post('/api/admin/rooms', requireAdmin, h(async (req, res) => {
  const result = await db.createRoom({ name: req.body.name, category: req.body.category });
  res.json(result);
}));

app.get('/api/admin/rooms/:id', requireAdmin, h(async (req, res) => {
  const room = await db.getRoom(req.params.id);
  if (!room) return res.status(404).json({ error: 'Room not found.' });
  res.json({ room });
}));

app.post('/api/admin/rooms/:id', requireAdmin, h(async (req, res) => {
  const result = await db.updateRoom(req.params.id, req.body);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result);
}));

app.delete('/api/admin/rooms/:id', requireAdmin, h(async (req, res) => {
  res.json(await db.deleteRoom(req.params.id));
}));

// ---------- Admin: Room bans ----------

app.get('/api/admin/rooms/:id/bans', requireAdmin, h(async (req, res) => {
  res.json({ bans: await db.getRoomBans(req.params.id) });
}));

app.post('/api/admin/rooms/:id/bans/:type', requireAdmin, h(async (req, res) => {
  const result = await db.addRoomBan(req.params.id, req.params.type, req.body.value);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result);
}));

app.delete('/api/admin/rooms/:id/bans/:type/:value', requireAdmin, h(async (req, res) => {
  const result = await db.removeRoomBan(req.params.id, req.params.type, decodeURIComponent(req.params.value));
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result);
}));

// ---------- Admin: Live users / recent logins ----------

app.get('/api/admin/rooms/:id/live', requireAdmin, h(async (req, res) => {
  res.json({ users: await db.liveUsersForRoom(req.params.id) });
}));

app.get('/api/admin/rooms/:id/recent-logins', requireAdmin, h(async (req, res) => {
  res.json({ logins: await db.recentLoginsForRoom(req.params.id) });
}));

// ---------- Admin: Users ----------

app.get('/api/admin/users', requireAdmin, h(async (req, res) => {
  res.json({ users: await db.adminSearchUsers({ username: req.query.username, roomId: req.query.roomId }) });
}));

app.post('/api/admin/users', requireAdmin, h(async (req, res) => {
  const { username, password, email, gender, points, tags, roomId, allowEmojis, accountActive } = req.body;
  if (!username) return res.status(400).json({ error: 'Username is required.' });
  const result = await db.createUser({ username, password, isGuest: false, email, gender, points, tags, roomId, allowEmojis, accountActive });
  if (result.error) return res.status(400).json({ error: result.error });
  res.json({ user: db.publicProfile(result.user) });
}));

app.post('/api/admin/dummy-users', requireAdmin, h(async (req, res) => {
  const count = Math.min(Math.max(Number(req.body.count) || 1, 1), 50);
  const created = [];
  for (let i = 0; i < count; i++) {
    const result = await db.adminCreateDummyUser(count === 1 ? req.body.name : null, req.body.roomId);
    if (result.error) return res.status(400).json({ error: result.error, created });
    created.push(result.user);
  }
  res.json({ users: created });
}));

app.delete('/api/admin/users/:username', requireAdmin, h(async (req, res) => {
  res.json(await db.adminDeleteUser(req.params.username));
}));

app.post('/api/admin/setlevel', requireAdmin, h(async (req, res) => {
  const result = await db.adminSetLevel(req.body.username, req.body.level);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result);
}));

app.post('/api/admin/setpoints', requireAdmin, h(async (req, res) => {
  const result = await db.adminSetPoints(req.body.username, req.body.points);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result);
}));

app.post('/api/admin/flag', requireAdmin, h(async (req, res) => {
  // body: { username, flag: 'banned'|'muted'|'allowEmojis'|'restricted'|'accountActive', value: true|false }
  const result = await db.adminSetFlag(req.body.username, req.body.flag, req.body.value);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result);
}));

app.post('/api/admin/kick', requireAdmin, h(async (req, res) => {
  const result = await db.adminKick(req.body.username);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result);
}));

app.post('/api/admin/set-rate-limit', requireAdmin, h(async (req, res) => {
  const result = await db.adminSetRateLimit(req.body.username, req.body.seconds);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result);
}));

app.get('/api/admin/ip-history/:ip', requireAdmin, h(async (req, res) => {
  res.json({ history: await db.ipHistory(req.params.ip) });
}));

app.post('/api/admin/clear', requireAdmin, h(async (req, res) => {
  await db.clearMessages(req.body.room);
  res.json({ ok: true });
}));

const PORT = process.env.PORT || 3000;
const httpServer = http.createServer(app);
attachCallSignaling(httpServer, db);

db.initSchema()
  .then(() => {
    httpServer.listen(PORT, () => {
      console.log(`BidBoard server running on http://localhost:${PORT}`);
      console.log(`Call signaling available at ws://localhost:${PORT}/ws/call`);
      console.log(`Control panel login: username "admin", password "admin123" (change this immediately in Settings).`);
      if (ADMIN_KEY) console.log(`Master admin key override is also active via ADMIN_KEY.`);
    });
  })
  .catch(err => {
    console.error('Failed to set up the database. Check your DB_HOST/DB_USER/DB_PASSWORD/DB_NAME environment variables.');
    console.error(err);
    process.exit(1);
  });
