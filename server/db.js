// db.js — MySQL-backed persistence layer for BidBoard.
// Same exported function names/behavior as the original JSON-file version
// (kept as db-jsonfile-backup.js for reference), but now backed by a real
// MySQL database — the kind bundled with most cPanel hosting plans.
//
// Configure via environment variables (set these in cPanel's "Setup Node.js App"
// screen, under "Environment Variables"):
//   DB_HOST      (default: localhost)
//   DB_PORT      (default: 3306)
//   DB_USER      (required — e.g. cpaneluser_bidboard)
//   DB_PASSWORD  (required)
//   DB_NAME      (required — e.g. cpaneluser_bidboard)

const crypto = require('crypto');
const http = require('http');
const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 8,
  namedPlaceholders: false
});

async function q(sql, params = []) {
  const [rows] = await pool.execute(sql, params);
  return rows;
}

// ---------- Schema setup (runs once at boot; safe to run every time) ----------

async function initSchema() {
  await q(`CREATE TABLE IF NOT EXISTS users (
    id INT PRIMARY KEY AUTO_INCREMENT,
    username VARCHAR(64) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NULL,
    is_guest TINYINT(1) DEFAULT 0,
    email VARCHAR(255) DEFAULT '',
    real_name VARCHAR(255) DEFAULT '',
    age VARCHAR(16) DEFAULT '',
    gender VARCHAR(32) DEFAULT 'Prefer not to say',
    status_message VARCHAR(255) DEFAULT '',
    avatar_url TEXT,
    youtube_url TEXT,
    level INT DEFAULT 1,
    points INT DEFAULT 0,
    likes INT DEFAULT 0,
    dislikes INT DEFAULT 0,
    tags JSON,
    allow_emojis TINYINT(1) DEFAULT 1,
    account_active TINYINT(1) DEFAULT 1,
    font_family VARCHAR(64) DEFAULT 'Inter',
    font_size INT DEFAULT 15,
    font_color VARCHAR(16) DEFAULT '#232037',
    block_pm VARCHAR(16) DEFAULT 'Everyone',
    scroll_mode VARCHAR(16) DEFAULT 'auto',
    banned TINYINT(1) DEFAULT 0,
    muted TINYINT(1) DEFAULT 0,
    current_room INT NULL,
    last_ip VARCHAR(64) DEFAULT 'Unknown',
    last_country VARCHAR(100) DEFAULT 'Unknown',
    last_country_code VARCHAR(4) DEFAULT '',
    last_city VARCHAR(100) DEFAULT 'Unknown',
    last_network VARCHAR(150) DEFAULT 'Unknown',
    is_proxy TINYINT(1) DEFAULT 0,
    restricted TINYINT(1) DEFAULT 0,
    rate_limit_seconds INT DEFAULT 0,
    last_message_at BIGINT DEFAULT 0,
    token VARCHAR(64),
    last_seen BIGINT,
    last_point_tick BIGINT,
    created_at BIGINT
  )`);

  await q(`CREATE TABLE IF NOT EXISTS messages (
    id INT PRIMARY KEY AUTO_INCREMENT,
    room VARCHAR(32),
    username VARCHAR(64),
    text TEXT,
    mentions JSON,
    font_family VARCHAR(64),
    font_color VARCHAR(16),
    created_at BIGINT,
    INDEX (room)
  )`);

  await q(`CREATE TABLE IF NOT EXISTS reactions (
    id INT PRIMARY KEY AUTO_INCREMENT,
    from_user VARCHAR(64),
    to_user VARCHAR(64),
    type VARCHAR(16),
    UNIQUE KEY uniq_pair (from_user, to_user)
  )`);

  await q(`CREATE TABLE IF NOT EXISTS pms (
    id INT PRIMARY KEY AUTO_INCREMENT,
    from_user VARCHAR(64),
    to_user VARCHAR(64),
    text TEXT,
    image_url MEDIUMTEXT,
    created_at BIGINT,
    is_read TINYINT(1) DEFAULT 0,
    INDEX (from_user), INDEX (to_user)
  )`);

  await q(`CREATE TABLE IF NOT EXISTS rooms (
    id INT PRIMARY KEY AUTO_INCREMENT,
    name VARCHAR(150),
    category VARCHAR(64),
    topic VARCHAR(255),
    radio_ip_port VARCHAR(64),
    config JSON,
    users_list_config JSON,
    theme JSON,
    shortcuts TEXT,
    ban_config JSON,
    created_at BIGINT
  ) AUTO_INCREMENT = 10000`);

  await q(`CREATE TABLE IF NOT EXISTS room_bans (
    id INT PRIMARY KEY AUTO_INCREMENT,
    room_id INT,
    type VARCHAR(16),
    value VARCHAR(255),
    banned_at BIGINT,
    UNIQUE KEY uniq_ban (room_id, type, value)
  )`);

  await q(`CREATE TABLE IF NOT EXISTS recent_logins (
    id INT PRIMARY KEY AUTO_INCREMENT,
    room_id INT,
    username VARCHAR(64),
    time BIGINT,
    ip VARCHAR(64),
    country VARCHAR(100),
    country_code VARCHAR(4),
    city VARCHAR(100),
    network VARCHAR(150),
    browser VARCHAR(32),
    fp VARCHAR(32),
    INDEX (ip), INDEX (room_id)
  )`);

  await q(`CREATE TABLE IF NOT EXISTS admins (
    id INT PRIMARY KEY AUTO_INCREMENT,
    username VARCHAR(64) UNIQUE,
    password_hash VARCHAR(255),
    token VARCHAR(64),
    created_at BIGINT
  )`);

  await q(`CREATE TABLE IF NOT EXISTS ignores (
    id INT PRIMARY KEY AUTO_INCREMENT,
    from_user VARCHAR(64),
    to_user VARCHAR(64),
    created_at BIGINT,
    UNIQUE KEY uniq_ignore (from_user, to_user)
  )`);

  await q(`CREATE TABLE IF NOT EXISTS message_reactions (
    id INT PRIMARY KEY AUTO_INCREMENT,
    message_id INT,
    username VARCHAR(64),
    reaction VARCHAR(8),
    UNIQUE KEY uniq_msg_react (message_id, username)
  )`);

  const roomCountRows = await q('SELECT COUNT(*) AS c FROM rooms');
  if (roomCountRows[0].c === 0) {
    await createRoom({ name: 'General Lounge', category: 'Entertainment' });
  }

  const adminCountRows = await q('SELECT COUNT(*) AS c FROM admins');
  if (adminCountRows[0].c === 0) {
    await q('INSERT INTO admins (username, password_hash, created_at) VALUES (?, ?, ?)',
      ['admin', hashPassword('admin123'), Date.now()]);
  }

  // Safe migrations for deployments that already had these tables before this feature existed.
  await addColumnIfMissing('users', "invisible TINYINT(1) DEFAULT 0");
  await addColumnIfMissing('users', "avatar_emoji VARCHAR(16) DEFAULT ''");
  await addColumnIfMissing('users', "whisper_policy VARCHAR(16) DEFAULT 'Everyone'");
  await addColumnIfMissing('users', "temp_admin_expires_at BIGINT NULL");
  await addColumnIfMissing('users', "selected_tag VARCHAR(32) DEFAULT ''");
  await addColumnIfMissing('users', "is_dummy TINYINT(1) DEFAULT 0");
  await addColumnIfMissing('messages', "whisper_to VARCHAR(64) NULL");
  await addColumnIfMissing('messages', "reply_to_id INT NULL");
  await addColumnIfMissing('messages', "edited TINYINT(1) DEFAULT 0");
  await addColumnIfMissing('messages', "deleted TINYINT(1) DEFAULT 0");
}

async function addColumnIfMissing(table, columnDef) {
  try {
    await q(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`);
  } catch (e) {
    if (e.code !== 'ER_DUP_FIELDNAME') throw e;
  }
}

function hashPassword(pw) {
  return crypto.createHash('sha256').update(pw).digest('hex');
}
function makeToken() {
  return crypto.randomBytes(24).toString('hex');
}

// ---------- Row <-> JS object mapping ----------

function rowToUser(r) {
  if (!r) return null;
  return {
    id: r.id, username: r.username, passwordHash: r.password_hash, isGuest: !!r.is_guest,
    email: r.email, realName: r.real_name, age: r.age, gender: r.gender, statusMessage: r.status_message,
    avatarUrl: r.avatar_url || '', youtubeUrl: r.youtube_url || '',
    level: r.level, points: r.points, likes: r.likes, dislikes: r.dislikes,
    tags: typeof r.tags === 'string' ? JSON.parse(r.tags) : (r.tags || []),
    allowEmojis: !!r.allow_emojis, accountActive: !!r.account_active,
    fontFamily: r.font_family, fontSize: r.font_size, fontColor: r.font_color,
    blockPm: r.block_pm, scrollMode: r.scroll_mode,
    banned: !!r.banned, muted: !!r.muted, currentRoom: r.current_room,
    lastIp: r.last_ip, lastCountry: r.last_country, lastCountryCode: r.last_country_code,
    lastCity: r.last_city, lastNetwork: r.last_network, isProxy: !!r.is_proxy,
    restricted: !!r.restricted, rateLimitSeconds: r.rate_limit_seconds, lastMessageAt: Number(r.last_message_at),
    invisible: !!r.invisible, avatarEmoji: r.avatar_emoji || '', whisperPolicy: r.whisper_policy || 'Everyone',
    tempAdminExpiresAt: r.temp_admin_expires_at ? Number(r.temp_admin_expires_at) : null,
    selectedTag: r.selected_tag || '', isDummy: !!r.is_dummy,
    token: r.token, lastSeen: Number(r.last_seen), lastPointTick: Number(r.last_point_tick),
    createdAt: Number(r.created_at)
  };
}

function rowToRoom(r) {
  if (!r) return null;
  const parse = v => (typeof v === 'string' ? JSON.parse(v) : v);
  return {
    id: r.id, name: r.name, category: r.category, topic: r.topic, radioIpPort: r.radio_ip_port || '',
    config: parse(r.config), usersListConfig: parse(r.users_list_config), theme: parse(r.theme),
    shortcuts: r.shortcuts || '', banConfig: parse(r.ban_config), createdAt: Number(r.created_at)
  };
}

function publicProfile(user) {
  if (!user) return null;
  const { passwordHash, token, ...rest } = user;
  return rest;
}

// ---------- IP Geolocation (unchanged logic, no DB dependency) ----------

const geoCache = new Map();
const GEO_CACHE_MS = 10 * 60 * 1000;
const GEO_TIMEOUT_MS = 2500;

function isPrivateIp(ip) {
  if (!ip) return true;
  const clean = ip.replace('::ffff:', '');
  return (
    clean === '::1' || clean === '127.0.0.1' || clean.startsWith('127.') ||
    clean.startsWith('10.') || clean.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(clean) || clean === 'Unknown'
  );
}

function lookupGeo(ip) {
  return new Promise((resolve) => {
    if (isPrivateIp(ip)) {
      return resolve({ country: 'Local', countryCode: '', city: 'Local', network: 'Local Network', isProxy: false });
    }
    const cached = geoCache.get(ip);
    if (cached && (Date.now() - cached.at) < GEO_CACHE_MS) return resolve(cached.data);

    const req = http.get({
      host: 'ip-api.com',
      path: `/json/${encodeURIComponent(ip)}?fields=status,country,countryCode,city,isp,as,proxy,hosting`,
      timeout: GEO_TIMEOUT_MS
    }, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          if (json.status !== 'success') throw new Error('lookup failed');
          const data = {
            country: json.country || 'Unknown', countryCode: json.countryCode || '',
            city: json.city || 'Unknown', network: json.as || json.isp || 'Unknown',
            isProxy: !!(json.proxy || json.hosting)
          };
          geoCache.set(ip, { data, at: Date.now() });
          resolve(data);
        } catch (e) {
          resolve({ country: 'Unknown', countryCode: '', city: 'Unknown', network: 'Unknown', isProxy: false });
        }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ country: 'Unknown', countryCode: '', city: 'Unknown', network: 'Unknown', isProxy: false }); });
    req.on('error', () => resolve({ country: 'Unknown', countryCode: '', city: 'Unknown', network: 'Unknown', isProxy: false }));
  });
}

const EMOJI_REGEX = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/u;

// ---------- Users ----------

async function expireTempAdminIfNeeded(user) {
  if (!user || !user.tempAdminExpiresAt) return user;
  if (Date.now() < user.tempAdminExpiresAt) return user;
  const newTags = (user.tags || []).filter(t => t !== 'admin');
  await q('UPDATE users SET tags=?, temp_admin_expires_at=NULL WHERE id=?', [JSON.stringify(newTags), user.id]);
  user.tags = newTags;
  user.tempAdminExpiresAt = null;
  return user;
}

async function findUserByUsername(username) {
  const rows = await q('SELECT * FROM users WHERE username = ?', [username]);
  return expireTempAdminIfNeeded(rowToUser(rows[0]));
}

async function findUserByToken(token) {
  const rows = await q('SELECT * FROM users WHERE token = ?', [token]);
  return expireTempAdminIfNeeded(rowToUser(rows[0]));
}

async function getUserByToken(token) {
  return findUserByToken(token);
}

async function createUser({ username, password, isGuest, email, gender, points, tags, roomId, allowEmojis, accountActive }) {
  const existing = await findUserByUsername(username);
  if (existing) return { error: 'That nickname is already taken.' };

  const now = Date.now();
  const token = makeToken();
  try {
    await q(
      `INSERT INTO users
      (username, password_hash, is_guest, email, gender, points, tags, current_room, allow_emojis, account_active,
       level, likes, dislikes, font_family, font_size, font_color, block_pm, scroll_mode, banned, muted,
       last_ip, last_country, last_country_code, last_city, last_network, is_proxy, restricted, rate_limit_seconds,
       last_message_at, token, last_seen, last_point_tick, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?, 1,0,0,'Inter',15,'#232037','Everyone','auto',0,0,
       'Unknown','Unknown','','Unknown','Unknown',0,0,0, 0, ?, ?, ?, ?)`,
      [
        username, password ? hashPassword(password) : null, isGuest ? 1 : 0, email || '',
        gender || 'Prefer not to say', points || 0, JSON.stringify(Array.isArray(tags) ? tags : ['registered']),
        roomId ? Number(roomId) : null, (allowEmojis !== undefined ? !!allowEmojis : true) ? 1 : 0,
        (accountActive !== undefined ? !!accountActive : true) ? 1 : 0,
        token, now, now, now
      ]
    );
    const user = await findUserByUsername(username);
    return { user };
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return { error: 'That nickname is already taken.' };
    return { error: 'Could not create user: ' + e.message };
  }
}

function applyGeoToUser(patch, ip, geo) {
  patch.last_ip = ip || 'Unknown';
  if (geo) {
    patch.last_country = geo.country;
    patch.last_country_code = geo.countryCode || '';
    patch.last_city = geo.city;
    patch.last_network = geo.network;
    patch.is_proxy = geo.isProxy ? 1 : 0;
  }
}

async function refreshUserGeo(username, ip, userAgent) {
  const geo = await lookupGeo(ip);
  const patch = {};
  applyGeoToUser(patch, ip, geo);
  await q(
    'UPDATE users SET last_ip=?, last_country=?, last_country_code=?, last_city=?, last_network=?, is_proxy=? WHERE username=?',
    [patch.last_ip, patch.last_country, patch.last_country_code, patch.last_city, patch.last_network, patch.is_proxy, username]
  );
  const user = await findUserByUsername(username);
  return { user, geo };
}

async function login({ username, password, roomId, ip, userAgent }) {
  const existing = await findUserByUsername(username);
  const geo = (roomId !== undefined && roomId !== null && roomId !== '') ? await lookupGeo(ip) : null;

  if (roomId !== undefined && roomId !== null && roomId !== '') {
    const banCheck = await checkRoomBan(roomId, { username, ip, userAgent, ...geo });
    if (banCheck.banned) return { error: `You are banned from this room (${banCheck.reason}).` };
  }

  if (!existing) {
    if (!password) {
      const result = await createUser({ username, isGuest: true, roomId });
      if (result.user) {
        const patch = {};
        applyGeoToUser(patch, ip, geo);
        await q('UPDATE users SET last_ip=?, last_country=?, last_country_code=?, last_city=?, last_network=?, is_proxy=? WHERE username=?',
          [patch.last_ip, patch.last_country, patch.last_country_code, patch.last_city, patch.last_network, patch.is_proxy, username]);
        const fresh = await findUserByUsername(username);
        if (roomId) await recordRoomLogin(roomId, fresh, { ip, userAgent, geo });
        return { user: fresh };
      }
      return result;
    }
    return { error: 'No account found with that nickname.' };
  }

  if (existing.banned) return { error: 'This account has been banned.' };
  if (existing.passwordHash) {
    if (!password || hashPassword(password) !== existing.passwordHash) {
      return { error: 'Incorrect password.' };
    }
  }

  const newToken = makeToken();
  const patch = {};
  applyGeoToUser(patch, ip, geo);
  await q(
    'UPDATE users SET token=?, last_seen=?, last_ip=?, last_country=?, last_country_code=?, last_city=?, last_network=?, is_proxy=? WHERE username=?',
    [newToken, Date.now(), patch.last_ip, patch.last_country, patch.last_country_code, patch.last_city, patch.last_network, patch.is_proxy, username]
  );
  const fresh = await findUserByUsername(username);
  if (roomId) await recordRoomLogin(roomId, fresh, { ip, userAgent, geo });
  return { user: fresh };
}

async function updateUser(token, patch) {
  const user = await findUserByToken(token);
  if (!user) return { error: 'Not logged in.' };
  if (user.banned) return { error: 'This account has been banned.' };

  if (patch.username && patch.username !== user.username) {
    const clash = await findUserByUsername(patch.username);
    if (clash) return { error: 'That nickname is already taken.' };
  }

  const sets = [];
  const vals = [];
  function set(col, val) { sets.push(`${col} = ?`); vals.push(val); }

  if (patch.username && patch.username !== user.username) set('username', patch.username);
  if (patch.password) set('password_hash', hashPassword(patch.password));
  if (patch.realName !== undefined) set('real_name', patch.realName);
  if (patch.age !== undefined) set('age', patch.age);
  if (patch.gender !== undefined) set('gender', patch.gender);
  if (patch.statusMessage !== undefined) set('status_message', patch.statusMessage);
  if (patch.avatarUrl !== undefined) set('avatar_url', patch.avatarUrl);
  if (patch.youtubeUrl !== undefined) set('youtube_url', patch.youtubeUrl);
  if (patch.fontFamily !== undefined) set('font_family', patch.fontFamily);
  if (patch.fontSize !== undefined) set('font_size', patch.fontSize);
  if (patch.fontColor !== undefined) set('font_color', patch.fontColor);
  if (patch.blockPm !== undefined) set('block_pm', patch.blockPm);
  if (patch.whisperPolicy !== undefined) set('whisper_policy', patch.whisperPolicy);
  if (patch.scrollMode !== undefined) set('scroll_mode', patch.scrollMode);

  if (!sets.length) return { user };
  vals.push(user.id);
  await q(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, vals);
  const fresh = await q('SELECT * FROM users WHERE id = ?', [user.id]);
  return { user: rowToUser(fresh[0]) };
}

async function heartbeat(token, roomId) {
  const user = await findUserByToken(token);
  if (!user) return { error: 'Not logged in.' };
  const now = Date.now();
  const elapsedMinutes = Math.floor((now - user.lastPointTick) / 60000);
  const newPoints = elapsedMinutes >= 1 ? user.points + elapsedMinutes : user.points;
  const newTick = elapsedMinutes >= 1 ? now : user.lastPointTick;
  const room = (roomId !== undefined && roomId !== null && roomId !== '') ? Number(roomId) : user.currentRoom;

  await q('UPDATE users SET last_seen=?, points=?, last_point_tick=?, current_room=? WHERE id=?',
    [now, newPoints, newTick, room, user.id]);
  const fresh = await q('SELECT * FROM users WHERE id = ?', [user.id]);
  return { user: rowToUser(fresh[0]) };
}

async function listUsers(roomId) {
  const ONLINE_WINDOW = 90 * 1000;
  const now = Date.now();
  let rows;
  if (roomId !== undefined && roomId !== null && roomId !== '') {
    rows = await q('SELECT * FROM users WHERE current_room = ? AND last_seen > ? AND invisible = 0', [Number(roomId), now - ONLINE_WINDOW]);
  } else {
    rows = await q('SELECT * FROM users WHERE invisible = 0', []);
  }
  return rows.map(r => {
    const u = rowToUser(r);
    return {
      username: u.username, isGuest: u.isGuest, level: u.level, points: u.points,
      likes: u.likes, dislikes: u.dislikes, statusMessage: u.statusMessage, avatarUrl: u.avatarUrl,
      avatarEmoji: u.avatarEmoji, tags: u.tags,
      online: (now - u.lastSeen) < ONLINE_WINDOW, muted: u.muted, banned: u.banned
    };
  });
}

// ---------- Messages ----------

function parseMentions(text) {
  const matches = [...text.matchAll(/@([a-zA-Z0-9_]{2,32})/g)];
  return [...new Set(matches.map(m => m[1]))];
}

async function addMessage({ token, room, text, replyToId }) {
  const user = await findUserByToken(token);
  if (!user) return { error: 'Not logged in.' };
  if (user.banned) return { error: 'This account has been banned.' };

  const raw = (text || '').trim();
  if (raw.startsWith('/')) {
    return processCommand(user, room, raw);
  }

  if (user.muted) return { error: 'You are muted in this room.' };

  const banCheck = await checkRoomBan(room, {
    username: user.username, ip: user.lastIp, country: user.lastCountry,
    city: user.lastCity, network: user.lastNetwork, isProxy: user.isProxy
  });
  if (banCheck.banned) return { error: `You are banned from this room (${banCheck.reason}).` };

  if (user.rateLimitSeconds > 0) {
    const waitMs = user.rateLimitSeconds * 1000 - (Date.now() - user.lastMessageAt);
    if (waitMs > 0) return { error: `You're sending messages too fast. Wait ${Math.ceil(waitMs / 1000)}s.` };
  }

  const trimmed = raw.slice(0, 1000);
  if (!trimmed) return { error: 'Message is empty.' };
  if (user.allowEmojis === false && EMOJI_REGEX.test(trimmed)) {
    return { error: 'Emojis are disabled for your account.' };
  }

  const now = Date.now();
  const mentions = parseMentions(trimmed);
  const result = await q(
    'INSERT INTO messages (room, username, text, mentions, font_family, font_color, created_at, reply_to_id) VALUES (?,?,?,?,?,?,?,?)',
    [String(room), user.username, trimmed, JSON.stringify(mentions), user.fontFamily, user.fontColor, now, replyToId || null]
  );

  const newPoints = trimmed.length > 10 ? user.points + 5 : user.points;
  await q('UPDATE users SET points=?, last_message_at=? WHERE id=?', [newPoints, now, user.id]);

  let replyTo = null;
  if (replyToId) {
    const rrows = await q('SELECT username, text FROM messages WHERE id=?', [replyToId]);
    if (rrows[0]) replyTo = { username: rrows[0].username, text: rrows[0].text };
  }

  return {
    message: {
      id: result.insertId, room: String(room), username: user.username, text: trimmed,
      mentions, fontFamily: user.fontFamily, fontColor: user.fontColor, createdAt: now, whisperTo: null,
      deleted: false, edited: false, replyTo, reactionSummary: {}, myReaction: null
    }
  };
}

// ---------- Chat commands ----------

async function processCommand(user, room, raw) {
  const parts = raw.slice(1).split(' ');
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1);

  if (cmd === 'whisper' || cmd === 'w') {
    const targetName = args[0];
    const text = args.slice(1).join(' ').trim();
    if (!targetName || !text) return { error: 'Usage: /whisper nickname message' };
    const target = await findUserByUsername(targetName);
    if (!target) return { error: 'User not found.' };
    if (target.username === user.username) return { error: "You can't whisper yourself." };
    if (target.whisperPolicy === 'Off') return { error: `${target.username} has whispers turned off.` };

    const now = Date.now();
    const trimmed = text.slice(0, 1000);
    const result = await q(
      'INSERT INTO messages (room, username, text, mentions, font_family, font_color, created_at, whisper_to) VALUES (?,?,?,?,?,?,?,?)',
      [String(room), user.username, trimmed, JSON.stringify([]), user.fontFamily, user.fontColor, now, target.username]
    );
    return {
      message: {
        id: result.insertId, room: String(room), username: user.username, text: trimmed,
        mentions: [], fontFamily: user.fontFamily, fontColor: user.fontColor, createdAt: now,
        whisperTo: target.username
      }
    };
  }

  if (cmd === 'clear') {
    if (!hasCapability(user, 'clear')) return { error: 'You do not have permission to clear this room.' };
    await clearMessages(room);
    return { notice: 'Chat cleared for everyone.' };
  }

  if (cmd === 'topic') {
    if (!hasCapability(user, 'changeTopic')) return { error: 'You do not have permission to change the topic.' };
    const newTopic = args.join(' ').trim();
    if (!newTopic) return { error: 'Usage: /topic your new topic text' };
    await updateRoom(room, { topic: newTopic });
    return { notice: `Topic changed to: "${newTopic}"` };
  }

  if (cmd === 'gift') {
    if (!hasCapability(user, 'givePoints')) return { error: 'You do not have permission to gift points.' };
    const targetName = args[0];
    const amount = Number(args[1]);
    if (!targetName || !amount || amount <= 0) return { error: 'Usage: /gift nickname amount' };
    const target = await findUserByUsername(targetName);
    if (!target) return { error: 'User not found.' };
    await q('UPDATE users SET points = points + ? WHERE username=?', [amount, target.username]);
    return { notice: `Gave ${amount} points to ${target.username}.` };
  }

  if (cmd === 'tag') {
    if (!hasCapability(user, 'changeTags')) return { error: 'You do not have permission to change tags.' };
    const targetName = args[0];
    const tagName = (args[1] || '').toLowerCase();
    if (!targetName || !tagName) return { error: 'Usage: /tag nickname tagname (toggles it on/off)' };
    const target = await findUserByUsername(targetName);
    if (!target) return { error: 'User not found.' };
    const hasTag = target.tags.includes(tagName);
    const newTags = hasTag ? target.tags.filter(t => t !== tagName) : [...target.tags, tagName];
    await q('UPDATE users SET tags=? WHERE username=?', [JSON.stringify(newTags), target.username]);
    return { notice: `${hasTag ? 'Removed' : 'Added'} tag "${tagName}" ${hasTag ? 'from' : 'to'} ${target.username}.` };
  }

  if (cmd === 'tempadmin') {
    if (!hasCapability(user, 'makeTempAdmin')) return { error: 'You do not have permission to grant temporary admin.' };
    const targetName = args[0];
    const minutes = Number(args[1]);
    if (!targetName || !minutes || minutes <= 0) return { error: 'Usage: /tempadmin nickname minutes' };
    const target = await findUserByUsername(targetName);
    if (!target) return { error: 'User not found.' };
    const newTags = target.tags.includes('admin') ? target.tags : [...target.tags, 'admin'];
    await q('UPDATE users SET tags=?, temp_admin_expires_at=? WHERE username=?',
      [JSON.stringify(newTags), Date.now() + minutes * 60000, target.username]);
    return { notice: `${target.username} is temporary admin for ${minutes} minute(s).` };
  }

  if (cmd === 'invisible') {
    if (!hasCapability(user, 'invisible')) return { error: 'You do not have permission to go invisible.' };
    const mode = (args[0] || '').toLowerCase();
    const newVal = mode === 'off' ? false : true;
    await q('UPDATE users SET invisible=? WHERE id=?', [newVal ? 1 : 0, user.id]);
    return { notice: newVal ? 'You are now invisible.' : 'You are visible again.' };
  }

  if (cmd === 'face') {
    const code = (args[0] || '').trim();
    if (code === 'clear') {
      await q('UPDATE users SET avatar_emoji=? WHERE id=?', ['', user.id]);
      return { notice: 'Avatar reset.' };
    }
    if (!code) return { error: 'Usage: /face :100  (or /face clear)' };
    await q('UPDATE users SET avatar_emoji=? WHERE id=?', [code, user.id]);
    return { notice: `Avatar updated.` };
  }

  if (cmd === 'mute' || cmd === 'unmute') {
    const result = await modMute({ token: user.token, targetUsername: args[0] }, cmd === 'mute');
    if (result.error) return { error: result.error };
    return { notice: `${args[0]} ${cmd === 'mute' ? 'muted' : 'unmuted'}.` };
  }

  if (cmd === 'kick') {
    const result = await modKick({ token: user.token, targetUsername: args[0] });
    if (result.error) return { error: result.error };
    return { notice: `${args[0]} was kicked.` };
  }

  if (cmd === 'ban') {
    const result = await modBanFromRoom({ token: user.token, targetUsername: args[0], roomId: room });
    if (result.error) return { error: result.error };
    return { notice: `${args[0]} was banned from this room.` };
  }

  return { error: `Unknown command: /${cmd}` };
}

async function getMessages(room, sinceId, viewerUsername) {
  const rows = await q(
    'SELECT * FROM messages WHERE room = ? AND id > ? ORDER BY id ASC LIMIT 200',
    [String(room), sinceId || 0]
  );
  const ignored = viewerUsername ? await getIgnoredUsernames(viewerUsername) : [];
  const visible = rows.filter(r =>
    (!r.whisper_to || r.username === viewerUsername || r.whisper_to === viewerUsername) &&
    !ignored.includes(r.username)
  );
  if (!visible.length) return [];

  const ids = visible.map(r => r.id);
  const reactionRows = await q(
    `SELECT * FROM message_reactions WHERE message_id IN (${ids.map(() => '?').join(',')})`, ids
  );
  const reactionsByMsg = {};
  reactionRows.forEach(r => {
    if (!reactionsByMsg[r.message_id]) reactionsByMsg[r.message_id] = [];
    reactionsByMsg[r.message_id].push({ username: r.username, reaction: r.reaction });
  });

  const replyIds = [...new Set(visible.filter(r => r.reply_to_id).map(r => r.reply_to_id))];
  let repliedTo = {};
  if (replyIds.length) {
    const replyRows = await q(`SELECT id, username, text FROM messages WHERE id IN (${replyIds.map(() => '?').join(',')})`, replyIds);
    replyRows.forEach(r => { repliedTo[r.id] = { username: r.username, text: r.text }; });
  }

  return visible.map(r => {
    const msgReactions = reactionsByMsg[r.id] || [];
    const summary = {};
    msgReactions.forEach(mr => { summary[mr.reaction] = (summary[mr.reaction] || 0) + 1; });
    return {
      id: r.id, room: r.room, username: r.username,
      text: r.deleted ? '' : r.text,
      deleted: !!r.deleted, edited: !!r.edited,
      mentions: typeof r.mentions === 'string' ? JSON.parse(r.mentions) : r.mentions,
      fontFamily: r.font_family, fontColor: r.font_color, createdAt: Number(r.created_at),
      whisperTo: r.whisper_to || null,
      replyTo: r.reply_to_id ? (repliedTo[r.reply_to_id] || null) : null,
      reactionSummary: summary,
      myReaction: (msgReactions.find(mr => mr.username === viewerUsername) || {}).reaction || null
    };
  });
}

async function deleteMessage(token, messageId) {
  const user = await findUserByToken(token);
  if (!user) return { error: 'Not logged in.' };
  const rows = await q('SELECT * FROM messages WHERE id=?', [messageId]);
  const msg = rows[0];
  if (!msg) return { error: 'Message not found.' };
  const isOwner = msg.username === user.username;
  const canModerate = hasCapability(user, 'clear') || hasCapability(user, 'ban');
  if (!isOwner && !canModerate) return { error: 'You cannot delete this message.' };
  await q('UPDATE messages SET deleted=1, text=? WHERE id=?', ['', messageId]);
  return { ok: true };
}

async function editMessage(token, messageId, newText) {
  const user = await findUserByToken(token);
  if (!user) return { error: 'Not logged in.' };
  const rows = await q('SELECT * FROM messages WHERE id=?', [messageId]);
  const msg = rows[0];
  if (!msg) return { error: 'Message not found.' };
  if (msg.username !== user.username) return { error: 'You can only edit your own messages.' };
  if (msg.deleted) return { error: 'This message was deleted.' };
  const trimmed = (newText || '').trim().slice(0, 1000);
  if (!trimmed) return { error: 'Message cannot be empty.' };
  await q('UPDATE messages SET text=?, edited=1 WHERE id=?', [trimmed, messageId]);
  return { ok: true };
}

async function reactToMessage(token, messageId, reaction) {
  const user = await findUserByToken(token);
  if (!user) return { error: 'Not logged in.' };
  const rows = await q('SELECT * FROM messages WHERE id=?', [messageId]);
  if (!rows[0]) return { error: 'Message not found.' };

  const existing = await q('SELECT * FROM message_reactions WHERE message_id=? AND username=?', [messageId, user.username]);
  if (existing.length) {
    if (existing[0].reaction === reaction) {
      await q('DELETE FROM message_reactions WHERE id=?', [existing[0].id]); // toggle off
    } else {
      await q('UPDATE message_reactions SET reaction=? WHERE id=?', [reaction, existing[0].id]);
    }
  } else {
    await q('INSERT INTO message_reactions (message_id, username, reaction) VALUES (?,?,?)', [messageId, user.username, reaction]);
  }
  return { ok: true };
}

async function clearMessages(room) {
  await q('DELETE FROM messages WHERE room = ?', [String(room)]);
}

// ---------- Ignore / Block list ----------

async function toggleIgnore(token, targetUsername) {
  const user = await findUserByToken(token);
  if (!user) return { error: 'Not logged in.' };
  const target = await findUserByUsername(targetUsername);
  if (!target) return { error: 'User not found.' };
  if (target.username === user.username) return { error: "You can't ignore yourself." };

  const existing = await q('SELECT * FROM ignores WHERE from_user=? AND to_user=?', [user.username, target.username]);
  if (existing.length) {
    await q('DELETE FROM ignores WHERE id=?', [existing[0].id]);
    return { ignoring: false };
  }
  await q('INSERT INTO ignores (from_user, to_user, created_at) VALUES (?,?,?)', [user.username, target.username, Date.now()]);
  return { ignoring: true };
}

async function getIgnoreInfo(username) {
  const ignoring = (await q('SELECT to_user FROM ignores WHERE from_user=?', [username])).map(r => r.to_user);
  const ignoredBy = (await q('SELECT from_user FROM ignores WHERE to_user=?', [username])).map(r => r.from_user);
  return { ignoring, ignoredBy };
}

async function getIgnoredUsernames(username) {
  return (await q('SELECT to_user FROM ignores WHERE from_user=?', [username])).map(r => r.to_user);
}

async function getPublicUserProfile(username) {
  const user = await findUserByUsername(username);
  if (!user) return { error: 'User not found.' };
  const ignoreInfo = await getIgnoreInfo(username);
  return {
    profile: {
      username: user.username, tags: user.tags, level: user.level, points: user.points,
      likes: user.likes, dislikes: user.dislikes, statusMessage: user.statusMessage,
      avatarUrl: user.avatarUrl, avatarEmoji: user.avatarEmoji, createdAt: user.createdAt,
      ignoring: ignoreInfo.ignoring, ignoredBy: ignoreInfo.ignoredBy
    }
  };
}



// ---------- Reactions (gifts / likes / dislikes) ----------

async function addReaction({ token, targetUsername, type }) {
  const fromUser = await findUserByToken(token);
  if (!fromUser) return { error: 'Not logged in.' };
  const target = await findUserByUsername(targetUsername);
  if (!target) return { error: 'User not found.' };
  if (target.username === fromUser.username) return { error: "You can't react to yourself." };

  const existing = await q('SELECT * FROM reactions WHERE from_user=? AND to_user=?', [fromUser.username, target.username]);

  if (existing.length) {
    if (existing[0].type === type) return { error: 'Already reacted.' };
    if (existing[0].type === 'like') await q('UPDATE users SET likes = GREATEST(0, likes-1) WHERE username=?', [target.username]);
    if (existing[0].type === 'dislike') await q('UPDATE users SET dislikes = GREATEST(0, dislikes-1) WHERE username=?', [target.username]);
    await q('UPDATE reactions SET type=? WHERE id=?', [type, existing[0].id]);
  } else {
    await q('INSERT INTO reactions (from_user, to_user, type) VALUES (?,?,?)', [fromUser.username, target.username, type]);
  }

  if (type === 'like') await q('UPDATE users SET likes = likes+1 WHERE username=?', [target.username]);
  if (type === 'dislike') await q('UPDATE users SET dislikes = dislikes+1 WHERE username=?', [target.username]);

  const fresh = await findUserByUsername(target.username);
  return { target: publicProfile(fresh) };
}

// ---------- Private Messages ----------

async function sendPm({ token, toUsername, text, imageUrl }) {
  const from = await findUserByToken(token);
  if (!from) return { error: 'Not logged in.' };
  if (from.banned) return { error: 'This account has been banned.' };

  const to = await findUserByUsername(toUsername);
  if (!to) return { error: 'User not found.' };
  if (to.username === from.username) return { error: "You can't PM yourself." };
  if (to.blockPm === 'Off') return { error: `${to.username} has private messages turned off.` };

  const trimmedText = (text || '').trim().slice(0, 1000);
  if (!trimmedText && !imageUrl) return { error: 'Message is empty.' };

  const now = Date.now();
  const result = await q(
    'INSERT INTO pms (from_user, to_user, text, image_url, created_at, is_read) VALUES (?,?,?,?,?,0)',
    [from.username, to.username, trimmedText, imageUrl || '', now]
  );
  return { pm: { id: result.insertId, from: from.username, to: to.username, text: trimmedText, imageUrl: imageUrl || '', createdAt: now, read: false } };
}

async function getPmThread(userA, userB, sinceId) {
  const rows = await q(
    `SELECT * FROM pms WHERE ((from_user=? AND to_user=?) OR (from_user=? AND to_user=?)) AND id > ?
     ORDER BY id ASC LIMIT 300`,
    [userA, userB, userB, userA, sinceId || 0]
  );
  return rows.map(r => ({
    id: r.id, from: r.from_user, to: r.to_user, text: r.text, imageUrl: r.image_url || '',
    createdAt: Number(r.created_at), read: !!r.is_read
  }));
}

async function listPmThreads(username) {
  const rows = await q(
    'SELECT * FROM pms WHERE from_user=? OR to_user=? ORDER BY id DESC',
    [username, username]
  );
  const partners = {};
  rows.forEach(r => {
    const partner = r.from_user === username ? r.to_user : r.from_user;
    if (!partners[partner]) partners[partner] = { lastText: r.text || (r.image_url ? '📷 Photo' : ''), lastAt: Number(r.created_at), unread: 0 };
    if (r.to_user === username && !r.is_read) partners[partner].unread++;
  });
  return Object.keys(partners).map(partner => ({ partner, ...partners[partner] })).sort((a, b) => b.lastAt - a.lastAt);
}

async function markPmRead(username, partner) {
  await q('UPDATE pms SET is_read=1 WHERE to_user=? AND from_user=?', [username, partner]);
}

async function unreadPmCount(username) {
  const rows = await q('SELECT COUNT(*) AS c FROM pms WHERE to_user=? AND is_read=0', [username]);
  return rows[0].c;
}

// ---------- Leaderboards ----------

async function leaderboardByPoints(limit = 50) {
  return q('SELECT username, points, level FROM users ORDER BY points DESC LIMIT ?', [limit]);
}

async function leaderboardByLikes(limit = 50) {
  return q('SELECT username, likes FROM users ORDER BY likes DESC LIMIT ?', [limit]);
}

// ---------- Rooms ----------

function defaultRoomJson() {
  return {
    config: JSON.stringify({
      disableLogout: false, lockRoom: false, autoBanButton: false, showNotices: false,
      restrictGuest: false, disableGuestChat: false, minPointsToWhisper: 0, whisperCost: 0
    }),
    usersListConfig: JSON.stringify({ showRank: false, showRankCountry: false, showFlag: false, defaultAvatarMode: 'text' }),
    theme: JSON.stringify({
      chatBackground: '#ffffff', loginBackground: '#7b8099', chatHeaderBg: '#7b8099',
      tabColorActive: '#b95ac5', tabColorHover: '#7b8099'
    }),
    banConfig: JSON.stringify({ network: false, tor: false, proxy: false, ipRange: false, city: false, country: false, browser: false, other: false })
  };
}

async function listRooms() {
  const rows = await q('SELECT * FROM rooms ORDER BY id ASC');
  return rows.map(rowToRoom);
}

async function getRoom(id) {
  const rows = await q('SELECT * FROM rooms WHERE id = ?', [Number(id)]);
  return rowToRoom(rows[0]);
}

function publicRoom(room) { return room; }

async function createRoom({ name, category }) {
  const d = defaultRoomJson();
  const result = await q(
    `INSERT INTO rooms (name, category, topic, radio_ip_port, config, users_list_config, theme, shortcuts, ban_config, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [name || 'New Room', category || 'General', 'Welcome to the room', '', d.config, d.usersListConfig, d.theme, '', d.banConfig, Date.now()]
  );
  const room = await getRoom(result.insertId);
  return { room };
}

async function updateRoom(id, patch) {
  const room = await getRoom(id);
  if (!room) return { error: 'Room not found.' };

  const sets = [];
  const vals = [];
  function set(col, val) { sets.push(`${col} = ?`); vals.push(val); }

  if (patch.name !== undefined) set('name', patch.name);
  if (patch.category !== undefined) set('category', patch.category);
  if (patch.topic !== undefined) set('topic', patch.topic);
  if (patch.radioIpPort !== undefined) set('radio_ip_port', patch.radioIpPort);
  if (patch.shortcuts !== undefined) set('shortcuts', patch.shortcuts);
  if (patch.config) set('config', JSON.stringify(Object.assign({}, room.config, patch.config)));
  if (patch.usersListConfig) set('users_list_config', JSON.stringify(Object.assign({}, room.usersListConfig, patch.usersListConfig)));
  if (patch.theme) set('theme', JSON.stringify(Object.assign({}, room.theme, patch.theme)));
  if (patch.banConfig) set('ban_config', JSON.stringify(Object.assign({}, room.banConfig, patch.banConfig)));

  if (sets.length) {
    vals.push(Number(id));
    await q(`UPDATE rooms SET ${sets.join(', ')} WHERE id = ?`, vals);
  }
  const fresh = await getRoom(id);
  return { room: fresh };
}

async function deleteRoom(id) {
  const numId = Number(id);
  await q('DELETE FROM rooms WHERE id = ?', [numId]);
  await q('DELETE FROM messages WHERE room = ?', [String(numId)]);
  await q('DELETE FROM room_bans WHERE room_id = ?', [numId]);
  await q('DELETE FROM recent_logins WHERE room_id = ?', [numId]);
  return { ok: true };
}

// ---------- Room Bans ----------

const BAN_TYPES = ['users', 'countries', 'cities', 'browsers', 'networks', 'ipRanges'];

async function getRoomBans(roomId) {
  const rows = await q('SELECT * FROM room_bans WHERE room_id = ?', [Number(roomId)]);
  const out = { users: [], countries: [], cities: [], browsers: [], networks: [], ipRanges: [] };
  rows.forEach(r => {
    if (out[r.type]) out[r.type].push({ value: r.value, bannedAt: Number(r.banned_at) });
  });
  return out;
}

async function addRoomBan(roomId, type, value) {
  if (!BAN_TYPES.includes(type)) return { error: 'Invalid ban type.' };
  try {
    await q('INSERT INTO room_bans (room_id, type, value, banned_at) VALUES (?,?,?,?)',
      [Number(roomId), type, String(value), Date.now()]);
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return { error: 'Already banned.' };
    return { error: e.message };
  }
  const bans = await getRoomBans(roomId);
  return { bans: bans[type] };
}

async function removeRoomBan(roomId, type, value) {
  if (!BAN_TYPES.includes(type)) return { error: 'Invalid ban type.' };
  await q('DELETE FROM room_bans WHERE room_id=? AND type=? AND value=?', [Number(roomId), type, String(value)]);
  const bans = await getRoomBans(roomId);
  return { bans: bans[type] };
}

async function checkRoomBan(roomId, { username, ip, userAgent, country, city, network, isProxy }) {
  const room = await getRoom(roomId);
  const cfg = room ? room.banConfig : {};
  const bans = await getRoomBans(roomId);

  if (username && bans.users.some(b => b.value.toLowerCase() === username.toLowerCase())) return { banned: true, reason: 'username' };
  if (cfg.ipRange && ip && bans.ipRanges.some(b => ip.startsWith(b.value))) return { banned: true, reason: 'IP range' };
  if (cfg.browser && userAgent && bans.browsers.some(b => userAgent.toLowerCase().includes(b.value.toLowerCase()))) return { banned: true, reason: 'browser' };
  if (cfg.country && country && bans.countries.some(b => b.value.toLowerCase() === country.toLowerCase())) return { banned: true, reason: 'country' };
  if (cfg.city && city && bans.cities.some(b => b.value.toLowerCase() === city.toLowerCase())) return { banned: true, reason: 'city' };
  if (cfg.network && network && bans.networks.some(b => network.toLowerCase().includes(b.value.toLowerCase()))) return { banned: true, reason: 'network' };
  if ((cfg.proxy || cfg.tor) && isProxy) return { banned: true, reason: cfg.tor && cfg.proxy ? 'proxy/TOR' : cfg.proxy ? 'proxy' : 'TOR (approximate)' };
  return { banned: false };
}

// ---------- Recent Logins / Live Users ----------

function parseBrowser(userAgent) {
  if (!userAgent) return 'Unknown';
  if (/edg/i.test(userAgent)) return 'Edge';
  if (/chrome/i.test(userAgent)) return 'Chrome';
  if (/firefox/i.test(userAgent)) return 'Firefox';
  if (/safari/i.test(userAgent)) return 'Safari';
  return 'Other';
}

function fingerprintFor(ip, userAgent) {
  return crypto.createHash('md5').update((ip || '') + '|' + (userAgent || '')).digest('hex').slice(0, 12);
}

async function recordRoomLogin(roomId, user, { ip, userAgent, geo }) {
  await q(
    `INSERT INTO recent_logins (room_id, username, time, ip, country, country_code, city, network, browser, fp)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [Number(roomId), user.username, Date.now(), ip || 'Unknown',
     geo ? geo.country : 'Unknown', geo ? (geo.countryCode || '') : '', geo ? geo.city : 'Unknown',
     geo ? geo.network : 'Unknown', parseBrowser(userAgent), fingerprintFor(ip, userAgent)]
  );
}

async function recentLoginsForRoom(roomId, limit = 200) {
  const rows = await q('SELECT * FROM recent_logins WHERE room_id=? ORDER BY time DESC LIMIT ?', [Number(roomId), limit]);
  return rows.map(r => ({
    roomId: r.room_id, username: r.username, time: Number(r.time), ip: r.ip, country: r.country,
    countryCode: r.country_code, city: r.city, network: r.network, browser: r.browser, fp: r.fp
  }));
}

async function liveUsersForRoom(roomId) {
  const ONLINE_WINDOW = 90 * 1000;
  const rows = await q('SELECT * FROM users WHERE current_room=? AND last_seen > ?', [Number(roomId), Date.now() - ONLINE_WINDOW]);
  return rows.map(r => {
    const u = rowToUser(r);
    return {
      username: u.username, isGuest: u.isGuest, level: u.level, banned: u.banned, muted: u.muted, tags: u.tags,
      ip: u.lastIp, country: u.lastCountry, countryCode: u.lastCountryCode, city: u.lastCity,
      network: u.lastNetwork, isProxy: u.isProxy, restricted: u.restricted, rateLimitSeconds: u.rateLimitSeconds,
      allowEmojis: u.allowEmojis
    };
  });
}

// ---------- Admin Auth ----------

async function adminLogin({ username, password }) {
  const rows = await q('SELECT * FROM admins WHERE username = ?', [username]);
  const admin = rows[0];
  if (!admin) return { error: 'Invalid username or password.' };
  if (hashPassword(password || '') !== admin.password_hash) return { error: 'Invalid username or password.' };
  const token = makeToken();
  await q('UPDATE admins SET token=? WHERE id=?', [token, admin.id]);
  return { token, admin: { username: admin.username } };
}

async function getAdminByToken(token) {
  const rows = await q('SELECT * FROM admins WHERE token = ?', [token]);
  return rows[0] ? { username: rows[0].username, token: rows[0].token } : null;
}

async function adminChangePassword(token, newPassword) {
  const rows = await q('SELECT * FROM admins WHERE token = ?', [token]);
  if (!rows[0]) return { error: 'Not logged in.' };
  if (!newPassword || newPassword.length < 6) return { error: 'Password must be at least 6 characters.' };
  await q('UPDATE admins SET password_hash=? WHERE id=?', [hashPassword(newPassword), rows[0].id]);
  return { ok: true };
}

async function dashboardStats() {
  const roomsRows = await q('SELECT COUNT(*) AS c FROM rooms');
  const usersRows = await q('SELECT COUNT(*) AS c FROM users');
  const bansRows = await q('SELECT COUNT(*) AS c FROM room_bans');
  const bannedRows = await q('SELECT COUNT(*) AS c FROM users WHERE banned=1');
  return {
    totalRooms: roomsRows[0].c,
    totalUsers: usersRows[0].c,
    activeBans: bansRows[0].c + bannedRows[0].c
  };
}

// ---------- Admin: Users ----------

async function adminCreateDummyUser(name, roomId) {
  const username = name && name.trim() ? name.trim() : `Guest${Math.floor(Math.random() * 9000 + 1000)}`;
  const result = await createUser({ username, isGuest: true, roomId, accountActive: true });
  if (result.error) return result;
  await q('UPDATE users SET is_dummy=1, last_seen=? WHERE username=?', [Date.now(), username]);
  return { user: publicProfile(await findUserByUsername(username)) };
}

async function adminSearchUsers({ username, roomId }) {
  let sql = 'SELECT * FROM users WHERE 1=1';
  const params = [];
  if (username) { sql += ' AND username LIKE ?'; params.push(`%${username}%`); }
  if (roomId) { sql += ' AND current_room = ?'; params.push(Number(roomId)); }
  const rows = await q(sql, params);
  return rows.map(r => publicProfile(rowToUser(r)));
}

async function adminDeleteUser(username) {
  const result = await q('DELETE FROM users WHERE username = ?', [username]);
  return { ok: true, removed: result.affectedRows > 0 };
}

async function adminSetLevel(username, level) {
  const user = await findUserByUsername(username);
  if (!user) return { error: 'User not found.' };
  await q('UPDATE users SET level=? WHERE username=?', [Number(level), username]);
  return { user: publicProfile(await findUserByUsername(username)) };
}

async function adminSetPoints(username, points) {
  const user = await findUserByUsername(username);
  if (!user) return { error: 'User not found.' };
  await q('UPDATE users SET points=? WHERE username=?', [Number(points), username]);
  return { user: publicProfile(await findUserByUsername(username)) };
}

async function adminSetFlag(username, flag, value) {
  const colMap = { banned: 'banned', muted: 'muted', allowEmojis: 'allow_emojis', restricted: 'restricted', accountActive: 'account_active' };
  if (!colMap[flag]) return { error: 'Invalid flag.' };
  const user = await findUserByUsername(username);
  if (!user) return { error: 'User not found.' };
  await q(`UPDATE users SET ${colMap[flag]} = ? WHERE username = ?`, [value ? 1 : 0, username]);
  return { user: publicProfile(await findUserByUsername(username)) };
}

async function adminKick(username) {
  const user = await findUserByUsername(username);
  if (!user) return { error: 'User not found.' };
  await q('UPDATE users SET current_room=NULL, token=? WHERE username=?', [makeToken(), username]);
  return { ok: true };
}

async function adminSetRateLimit(username, seconds) {
  const user = await findUserByUsername(username);
  if (!user) return { error: 'User not found.' };
  await q('UPDATE users SET rate_limit_seconds=? WHERE username=?', [Math.max(0, Number(seconds) || 0), username]);
  return { user: publicProfile(await findUserByUsername(username)) };
}

async function ipHistory(ip) {
  const fromLogins = (await q('SELECT username, time, room_id FROM recent_logins WHERE ip=?', [ip]))
    .map(r => ({ username: r.username, time: Number(r.time), roomId: r.room_id }));
  const fromUsers = (await q('SELECT username, last_seen, current_room FROM users WHERE last_ip=?', [ip]))
    .map(r => ({ username: r.username, time: Number(r.last_seen), roomId: r.current_room }));
  const combined = [...fromLogins, ...fromUsers];
  const seen = new Set();
  const deduped = [];
  combined.sort((a, b) => b.time - a.time).forEach(entry => {
    const key = entry.username + '|' + entry.time;
    if (!seen.has(key)) { seen.add(key); deduped.push(entry); }
  });
  return deduped;
}

// ---------- Tag-based permissions & badges ----------
// Each tag grants a specific set of capabilities. A user's total capabilities
// are the union of every tag they hold. "owner" and "super_admin" get
// everything; other tags get a smaller, sensible subset.

const ALL_CAPS = ['ban', 'kick', 'mute', 'changeTopic', 'invisible', 'givePoints', 'changeTags', 'makeTempAdmin', 'setLevel', 'clear'];

const TAG_CAPS = {
  owner: ALL_CAPS,
  super_admin: ALL_CAPS,
  admin: ['ban', 'kick', 'mute', 'clear'],
  king: ['ban', 'kick', 'mute'],
  queen: ['ban', 'kick', 'mute'],
  rj_head: ['mute']
};

const TAG_BADGES = {
  owner: { label: '👑 Owner', color: '#f5b400', category: 'staff' },
  super_admin: { label: '⭐ Super Admin', color: '#e0457a', category: 'staff' },
  admin: { label: '🛡️ Admin', color: '#4a90d9', category: 'staff' },
  king: { label: '♚ King', color: '#7c5cf0', category: 'staff' },
  queen: { label: '♛ Queen', color: '#ec4899', category: 'staff' },
  rj_head: { label: '🎙️ RJ Head', color: '#0aa5a0', category: 'staff' },
  vip: { label: '⭐ VIP', color: '#e0457a', category: 'status' },
  platinum: { label: '💎 Platinum', color: '#4a90d9', category: 'status' },
  gold: { label: '🥇 Gold', color: '#d4a017', category: 'status' },
  silver: { label: '🥈 Silver', color: '#9aa5b1', category: 'status' },
  immune: { label: '🛡️ Immune', color: '#16a34a', category: 'status' },
  invisible: { label: '👻 Invisible', color: '#7c7495', category: 'status' }
};

function userCapabilities(user) {
  const caps = new Set();
  (user && user.tags || []).forEach(t => (TAG_CAPS[t] || []).forEach(c => caps.add(c)));
  return [...caps];
}

function hasCapability(user, cap) {
  return userCapabilities(user).includes(cap);
}

async function setSelectedTag(token, tag) {
  const user = await findUserByToken(token);
  if (!user) return { error: 'Not logged in.' };
  if (tag && !user.tags.includes(tag)) return { error: "You don't have that tag." };
  await q('UPDATE users SET selected_tag=? WHERE id=?', [tag || '', user.id]);
  return { ok: true };
}

// Kept for backward compatibility with existing admin-panel calls.
const MOD_TAGS = ['owner', 'super_admin', 'admin', 'king', 'queen', 'rj_head'];
const LEVEL_CHANGE_TAGS = ['owner', 'super_admin'];

function hasModPower(user, tags) {
  return !!(user && Array.isArray(user.tags) && user.tags.some(t => tags.includes(t)));
}

async function modAction({ token, targetUsername }, requiredCap) {
  const actor = await findUserByToken(token);
  if (!actor) return { error: 'Not logged in.' };
  if (!hasCapability(actor, requiredCap)) return { error: 'You do not have permission to do that.' };
  const target = await findUserByUsername(targetUsername);
  if (!target) return { error: 'User not found.' };
  if (target.username === actor.username) return { error: "You can't moderate yourself." };
  return { actor, target };
}

async function modMute({ token, targetUsername }, muted) {
  const result = await modAction({ token, targetUsername }, 'mute');
  if (result.error) return result;
  await q('UPDATE users SET muted=? WHERE username=?', [muted ? 1 : 0, targetUsername]);
  return { ok: true, target: publicProfile(await findUserByUsername(targetUsername)) };
}

async function modKick({ token, targetUsername }) {
  const result = await modAction({ token, targetUsername }, 'kick');
  if (result.error) return result;
  await q('UPDATE users SET current_room=NULL, token=? WHERE username=?', [makeToken(), targetUsername]);
  return { ok: true };
}

async function modBanFromRoom({ token, targetUsername, roomId }) {
  const result = await modAction({ token, targetUsername }, 'ban');
  if (result.error) return result;
  return addRoomBan(roomId, 'users', targetUsername);
}

async function modSetLevel({ token, targetUsername }, level) {
  const result = await modAction({ token, targetUsername }, 'setLevel');
  if (result.error) return result;
  await q('UPDATE users SET level=? WHERE username=?', [Number(level), targetUsername]);
  return { ok: true, target: publicProfile(await findUserByUsername(targetUsername)) };
}

module.exports = {
  initSchema,
  createUser, login, getUserByToken, updateUser, heartbeat, listUsers, publicProfile,
  addMessage, getMessages, clearMessages, deleteMessage, editMessage, reactToMessage,
  addReaction,
  toggleIgnore, getIgnoreInfo, getPublicUserProfile,
  sendPm, getPmThread, listPmThreads, markPmRead, unreadPmCount,
  leaderboardByPoints, leaderboardByLikes,
  adminSetLevel, adminSetPoints, adminSetFlag, adminSearchUsers, adminDeleteUser, adminCreateDummyUser,
  adminKick, adminSetRateLimit, ipHistory,
  listRooms, getRoom, publicRoom, createRoom, updateRoom, deleteRoom,
  getRoomBans, addRoomBan, removeRoomBan, BAN_TYPES,
  recentLoginsForRoom, liveUsersForRoom, recordRoomLogin,
  adminLogin, getAdminByToken, adminChangePassword, dashboardStats,
  hasModPower, modMute, modKick, modBanFromRoom, modSetLevel, MOD_TAGS, LEVEL_CHANGE_TAGS,
  TAG_CAPS, TAG_BADGES, ALL_CAPS, userCapabilities, hasCapability, setSelectedTag,
  lookupGeo, refreshUserGeo
};
