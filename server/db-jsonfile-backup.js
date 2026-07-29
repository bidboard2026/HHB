// db.js — a tiny persistent JSON-file database for BidBoard.
// Not a full SQL engine, but it IS real persistence: everything survives a server restart,
// lives in data/db.json, and is structured the same way SQL tables would be (users, messages, reactions).
// Swapping this for Postgres/MySQL later just means rewriting the functions below —
// nothing in server.js or the frontend needs to change.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');

const DB_PATH = path.join(__dirname, 'data', 'db.json');
const EMOJI_REGEX = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/u;

// ---------- IP Geolocation ----------
// Uses ip-api.com's free tier (no key, ~45 req/min). Real public IPs get a real
// country/city/ISP/proxy-flag lookup; private/local IPs (127.0.0.1, 192.168.x, etc.)
// are never sent out, since they can't be geolocated anyway.

const geoCache = new Map(); // ip -> { data, at }
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
            country: json.country || 'Unknown',
            countryCode: json.countryCode || '',
            city: json.city || 'Unknown',
            network: json.as || json.isp || 'Unknown',
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

function defaultDB() {
  return {
    users: [],
    messages: [],
    reactions: [],
    pms: [],
    rooms: [],
    roomBans: {},     // { [roomId]: { users:[], countries:[], cities:[], browsers:[], networks:[], ipRanges:[] } }
    recentLogins: [], // [{ roomId, username, time, ip, country, city, network, browser, fp }]
    admins: [],
    nextMessageId: 1,
    nextPmId: 1,
    nextRoomNumericId: 10000
  };
}

function load() {
  if (!fs.existsSync(DB_PATH)) {
    save(defaultDB());
  }
  const raw = fs.readFileSync(DB_PATH, 'utf-8');
  const db = JSON.parse(raw);
  // Migrate older db.json files that predate PMs / rooms / admin panel.
  if (!db.pms) db.pms = [];
  if (!db.nextPmId) db.nextPmId = 1;
  if (!db.rooms) db.rooms = [];
  if (!db.roomBans) db.roomBans = {};
  if (!db.recentLogins) db.recentLogins = [];
  if (!db.admins) db.admins = [];
  if (!db.nextRoomNumericId) db.nextRoomNumericId = 10000;

  let dirty = false;
  if (db.rooms.length === 0) {
    db.rooms.push(defaultRoomShape(db.nextRoomNumericId++, 'General Lounge', 'Entertainment'));
    dirty = true;
  }
  if (db.admins.length === 0) {
    db.admins.push({
      id: 1,
      username: 'admin',
      passwordHash: hashPassword('admin123'),
      token: null,
      createdAt: Date.now()
    });
    dirty = true;
  }
  if (dirty) save(db);

  // Backfill fields on any users created before this feature existed.
  let userDirty = false;
  db.users.forEach(u => {
    if (u.lastCountryCode === undefined) { u.lastCountryCode = ''; userDirty = true; }
    if (u.restricted === undefined) { u.restricted = false; userDirty = true; }
    if (u.rateLimitSeconds === undefined) { u.rateLimitSeconds = 0; userDirty = true; }
    if (u.lastMessageAt === undefined) { u.lastMessageAt = 0; userDirty = true; }
  });
  if (userDirty) save(db);

  return db;
}

function save(db) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

function hashPassword(pw) {
  return crypto.createHash('sha256').update(pw).digest('hex');
}

function makeToken() {
  return crypto.randomBytes(24).toString('hex');
}

// ---------- Users ----------

function findUserByUsername(db, username) {
  return db.users.find(u => u.username.toLowerCase() === username.toLowerCase());
}

function findUserByToken(db, token) {
  return db.users.find(u => u.token === token);
}

function createUser({ username, password, isGuest, email, gender, points, tags, roomId, allowEmojis, accountActive }) {
  const db = load();
  if (findUserByUsername(db, username)) {
    return { error: 'That nickname is already taken.' };
  }
  const user = {
    id: db.users.length ? Math.max(...db.users.map(u => u.id)) + 1 : 1,
    username,
    passwordHash: password ? hashPassword(password) : null,
    isGuest: !!isGuest,
    email: email || '',
    realName: '',
    age: '',
    gender: gender || 'Prefer not to say',
    statusMessage: '',
    avatarUrl: '',
    youtubeUrl: '',
    level: 1,
    points: points || 0,
    likes: 0,
    dislikes: 0,
    tags: Array.isArray(tags) ? tags : ['registered'],
    allowEmojis: allowEmojis !== undefined ? !!allowEmojis : true,
    accountActive: accountActive !== undefined ? !!accountActive : true,
    fontFamily: 'Inter',
    fontSize: 15,
    fontColor: '#232037',
    blockPm: 'Everyone', // 'Everyone' | 'Off'
    scrollMode: 'auto',  // 'auto' | 'freeze'
    banned: false,
    muted: false,
    currentRoom: roomId ? Number(roomId) : null,
    lastIp: 'Unknown',
    lastCountry: 'Unknown',
    lastCountryCode: '',
    lastCity: 'Unknown',
    lastNetwork: 'Unknown',
    isProxy: false,
    restricted: false,       // admin-set: limits activity (see rateLimitSeconds + allowEmojis)
    rateLimitSeconds: 0,     // minimum seconds required between messages
    lastMessageAt: 0,
    token: makeToken(),
    lastSeen: Date.now(),
    lastPointTick: Date.now(),
    createdAt: Date.now()
  };
  db.users.push(user);
  save(db);
  return { user };
}

async function login({ username, password, roomId, ip, userAgent }) {
  const db = load();
  const existing = findUserByUsername(db, username);

  const geo = (roomId !== undefined && roomId !== null && roomId !== '') ? await lookupGeo(ip) : null;

  if (roomId !== undefined && roomId !== null && roomId !== '') {
    const banCheck = checkRoomBan(db, roomId, { username, ip, userAgent, ...geo });
    if (banCheck.banned) return { error: `You are banned from this room (${banCheck.reason}).` };
  }

  if (!existing) {
    // Guest quick-join: no password, no existing account -> create an ephemeral guest.
    if (!password) {
      const result = createUser({ username, isGuest: true, roomId });
      if (result.user) {
        const freshDb = load();
        const freshUser = findUserByUsername(freshDb, username);
        applyGeoToUser(freshUser, ip, geo);
        save(freshDb);
        if (roomId) recordRoomLogin(roomId, freshUser, { ip, userAgent, geo });
        return { user: freshUser };
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

  existing.token = makeToken();
  existing.lastSeen = Date.now();
  applyGeoToUser(existing, ip, geo);
  save(db);
  if (roomId) recordRoomLogin(roomId, existing, { ip, userAgent, geo });
  return { user: existing };
}

function applyGeoToUser(user, ip, geo) {
  user.lastIp = ip || 'Unknown';
  if (geo) {
    user.lastCountry = geo.country;
    user.lastCountryCode = geo.countryCode || '';
    user.lastCity = geo.city;
    user.lastNetwork = geo.network;
    user.isProxy = geo.isProxy;
  }
}

async function refreshUserGeo(username, ip, userAgent) {
  const geo = await lookupGeo(ip);
  const freshDb = load();
  const freshUser = findUserByUsername(freshDb, username);
  if (!freshUser) return null;
  applyGeoToUser(freshUser, ip, geo);
  save(freshDb);
  return { user: freshUser, geo };
}

function getUserByToken(token) {
  const db = load();
  return findUserByToken(db, token);
}

function updateUser(token, patch) {
  const db = load();
  const user = findUserByToken(db, token);
  if (!user) return { error: 'Not logged in.' };
  if (user.banned) return { error: 'This account has been banned.' };

  if (patch.username && patch.username !== user.username) {
    if (findUserByUsername(db, patch.username)) return { error: 'That nickname is already taken.' };
    user.username = patch.username;
  }
  if (patch.password) user.passwordHash = hashPassword(patch.password);
  if (patch.realName !== undefined) user.realName = patch.realName;
  if (patch.age !== undefined) user.age = patch.age;
  if (patch.gender !== undefined) user.gender = patch.gender;
  if (patch.statusMessage !== undefined) user.statusMessage = patch.statusMessage;
  if (patch.avatarUrl !== undefined) user.avatarUrl = patch.avatarUrl;
  if (patch.youtubeUrl !== undefined) user.youtubeUrl = patch.youtubeUrl;
  if (patch.fontFamily !== undefined) user.fontFamily = patch.fontFamily;
  if (patch.fontSize !== undefined) user.fontSize = patch.fontSize;
  if (patch.fontColor !== undefined) user.fontColor = patch.fontColor;
  if (patch.blockPm !== undefined) user.blockPm = patch.blockPm;
  if (patch.scrollMode !== undefined) user.scrollMode = patch.scrollMode;

  save(db);
  return { user };
}

function heartbeat(token, roomId) {
  const db = load();
  const user = findUserByToken(db, token);
  if (!user) return { error: 'Not logged in.' };
  const now = Date.now();
  user.lastSeen = now;
  if (roomId !== undefined && roomId !== null && roomId !== '') user.currentRoom = Number(roomId);
  const elapsedMinutes = Math.floor((now - user.lastPointTick) / 60000);
  if (elapsedMinutes >= 1) {
    user.points += elapsedMinutes; // +1 pt per minute online
    user.lastPointTick = now;
  }
  save(db);
  return { user };
}

function listUsers(roomId) {
  const db = load();
  const ONLINE_WINDOW = 90 * 1000;
  const now = Date.now();
  let list = db.users;
  if (roomId !== undefined && roomId !== null && roomId !== '') {
    list = list.filter(u => u.currentRoom === Number(roomId) && (now - u.lastSeen) < ONLINE_WINDOW);
  }
  return list.map(u => ({
    username: u.username,
    isGuest: u.isGuest,
    level: u.level,
    points: u.points,
    likes: u.likes,
    dislikes: u.dislikes,
    statusMessage: u.statusMessage,
    avatarUrl: u.avatarUrl,
    online: (now - u.lastSeen) < ONLINE_WINDOW,
    muted: u.muted,
    banned: u.banned
  }));
}

function publicProfile(user) {
  if (!user) return null;
  const { passwordHash, token, ...rest } = user;
  return rest;
}

// ---------- Messages ----------

function parseMentions(text) {
  const matches = [...text.matchAll(/@([a-zA-Z0-9_]{2,32})/g)];
  return [...new Set(matches.map(m => m[1]))];
}

function addMessage({ token, room, text }) {
  const db = load();
  const user = findUserByToken(db, token);
  if (!user) return { error: 'Not logged in.' };
  if (user.banned) return { error: 'This account has been banned.' };
  if (user.muted) return { error: 'You are muted in this room.' };
  const banCheck = checkRoomBan(db, room, {
    username: user.username,
    ip: user.lastIp,
    country: user.lastCountry,
    city: user.lastCity,
    network: user.lastNetwork,
    isProxy: user.isProxy
  });
  if (banCheck.banned) return { error: `You are banned from this room (${banCheck.reason}).` };

  if (user.rateLimitSeconds > 0) {
    const waitMs = user.rateLimitSeconds * 1000 - (Date.now() - user.lastMessageAt);
    if (waitMs > 0) return { error: `You're sending messages too fast. Wait ${Math.ceil(waitMs / 1000)}s.` };
  }

  const trimmed = text.trim().slice(0, 1000);
  if (!trimmed) return { error: 'Message is empty.' };

  if (user.allowEmojis === false && EMOJI_REGEX.test(trimmed)) {
    return { error: 'Emojis are disabled for your account.' };
  }

  const msg = {
    id: db.nextMessageId++,
    room: String(room),
    username: user.username,
    text: trimmed,
    mentions: parseMentions(trimmed),
    fontFamily: user.fontFamily,
    fontColor: user.fontColor,
    createdAt: Date.now()
  };
  db.messages.push(msg);

  if (trimmed.length > 10) user.points += 5; // +5 pts per substantial message
  user.lastMessageAt = Date.now();

  save(db);
  return { message: msg };
}

function getMessages(room, sinceId) {
  const db = load();
  return db.messages
    .filter(m => m.room === String(room) && m.id > (sinceId || 0))
    .slice(-200);
}

function clearMessages(room) {
  const db = load();
  db.messages = db.messages.filter(m => m.room !== String(room));
  save(db);
}

// ---------- Private Messages ----------

function sendPm({ token, toUsername, text, imageUrl }) {
  const db = load();
  const from = findUserByToken(db, token);
  if (!from) return { error: 'Not logged in.' };
  if (from.banned) return { error: 'This account has been banned.' };

  const to = findUserByUsername(db, toUsername);
  if (!to) return { error: 'User not found.' };
  if (to.username === from.username) return { error: "You can't PM yourself." };
  if (to.blockPm === 'Off') return { error: `${to.username} has private messages turned off.` };

  const trimmedText = (text || '').trim().slice(0, 1000);
  if (!trimmedText && !imageUrl) return { error: 'Message is empty.' };

  const pm = {
    id: db.nextPmId++,
    from: from.username,
    to: to.username,
    text: trimmedText,
    imageUrl: imageUrl || '',
    createdAt: Date.now(),
    read: false
  };
  db.pms.push(pm);
  save(db);
  return { pm };
}

function getPmThread(userA, userB, sinceId) {
  const db = load();
  return db.pms
    .filter(p =>
      ((p.from === userA && p.to === userB) || (p.from === userB && p.to === userA)) &&
      p.id > (sinceId || 0)
    )
    .slice(-300);
}

function listPmThreads(username) {
  const db = load();
  const mine = db.pms.filter(p => p.from === username || p.to === username);
  const partners = {};
  mine.forEach(p => {
    const partner = p.from === username ? p.to : p.from;
    if (!partners[partner] || partners[partner].createdAt < p.createdAt) partners[partner] = p;
  });
  return Object.keys(partners).map(partner => ({
    partner,
    lastText: partners[partner].text || (partners[partner].imageUrl ? '📷 Photo' : ''),
    lastAt: partners[partner].createdAt,
    unread: mine.filter(p => p.to === username && p.from === partner && !p.read).length
  })).sort((a, b) => b.lastAt - a.lastAt);
}

function markPmRead(username, partner) {
  const db = load();
  db.pms.forEach(p => { if (p.to === username && p.from === partner) p.read = true; });
  save(db);
}

function unreadPmCount(username) {
  const db = load();
  return db.pms.filter(p => p.to === username && !p.read).length;
}



// ---------- Rooms ----------

function defaultRoomShape(id, name, category) {
  return {
    id,
    name: name || 'New Room',
    category: category || 'General',
    topic: 'Welcome to the room',
    radioIpPort: '',
    config: {
      disableLogout: false,
      lockRoom: false,
      autoBanButton: false,
      showNotices: false,
      restrictGuest: false,
      disableGuestChat: false,
      minPointsToWhisper: 0,
      whisperCost: 0
    },
    usersListConfig: {
      showRank: false,
      showRankCountry: false,
      showFlag: false,
      defaultAvatarMode: 'text' // 'text' | 'url'
    },
    theme: {
      chatBackground: '#ffffff',
      loginBackground: '#7b8099',
      chatHeaderBg: '#7b8099',
      tabColorActive: '#b95ac5',
      tabColorHover: '#7b8099'
    },
    shortcuts: '',
    banConfig: {
      network: false, tor: false, proxy: false, ipRange: false,
      city: false, country: false, browser: false, other: false
    },
    createdAt: Date.now()
  };
}

function listRooms() {
  const db = load();
  return db.rooms;
}

function getRoom(id) {
  const db = load();
  return db.rooms.find(r => r.id === Number(id));
}

function publicRoom(room) {
  if (!room) return null;
  // Everything except banConfig internals is safe to expose to the public login page.
  return room;
}

function createRoom({ name, category }) {
  const db = load();
  const id = db.nextRoomNumericId++;
  const room = defaultRoomShape(id, name, category);
  db.rooms.push(room);
  save(db);
  return { room };
}

function updateRoom(id, patch) {
  const db = load();
  const room = db.rooms.find(r => r.id === Number(id));
  if (!room) return { error: 'Room not found.' };

  if (patch.name !== undefined) room.name = patch.name;
  if (patch.category !== undefined) room.category = patch.category;
  if (patch.topic !== undefined) room.topic = patch.topic;
  if (patch.radioIpPort !== undefined) room.radioIpPort = patch.radioIpPort;
  if (patch.shortcuts !== undefined) room.shortcuts = patch.shortcuts;
  if (patch.config) Object.assign(room.config, patch.config);
  if (patch.usersListConfig) Object.assign(room.usersListConfig, patch.usersListConfig);
  if (patch.theme) Object.assign(room.theme, patch.theme);
  if (patch.banConfig) Object.assign(room.banConfig, patch.banConfig);

  save(db);
  return { room };
}

function deleteRoom(id) {
  const db = load();
  const numId = Number(id);
  db.rooms = db.rooms.filter(r => r.id !== numId);
  db.messages = db.messages.filter(m => m.room !== String(numId) && m.room !== numId);
  delete db.roomBans[numId];
  db.recentLogins = db.recentLogins.filter(l => l.roomId !== numId);
  save(db);
  return { ok: true };
}

// ---------- Room Bans ----------

const BAN_TYPES = ['users', 'countries', 'cities', 'browsers', 'networks', 'ipRanges'];

function ensureRoomBans(db, roomId) {
  const key = String(roomId);
  if (!db.roomBans[key]) {
    db.roomBans[key] = { users: [], countries: [], cities: [], browsers: [], networks: [], ipRanges: [] };
  }
  return db.roomBans[key];
}

function getRoomBans(roomId) {
  const db = load();
  return ensureRoomBans(db, roomId);
}

function addRoomBan(roomId, type, value) {
  if (!BAN_TYPES.includes(type)) return { error: 'Invalid ban type.' };
  const db = load();
  const bans = ensureRoomBans(db, roomId);
  if (bans[type].some(b => b.value.toLowerCase() === String(value).toLowerCase())) {
    return { error: 'Already banned.' };
  }
  bans[type].push({ value: String(value), bannedAt: Date.now() });
  save(db);
  return { bans: bans[type] };
}

function removeRoomBan(roomId, type, value) {
  if (!BAN_TYPES.includes(type)) return { error: 'Invalid ban type.' };
  const db = load();
  const bans = ensureRoomBans(db, roomId);
  bans[type] = bans[type].filter(b => b.value.toLowerCase() !== String(value).toLowerCase());
  save(db);
  return { bans: bans[type] };
}

// Real, enforced checks across every category. Each category (other than the
// Banned Users list, which is always active) only applies if the room's
// Ban Configuration toggle for it is switched on — matching the "master switch
// per category" behavior of the Ban Configuration panel.
// TOR is approximated using the same proxy/hosting signal as Proxy, since a
// dedicated Tor exit-node feed isn't wired in — swap in the Tor Project's
// bulk exit list if you want a precise Tor-only check.
function checkRoomBan(db, roomId, { username, ip, userAgent, country, city, network, isProxy }) {
  const room = db.rooms.find(r => r.id === Number(roomId));
  const cfg = room ? room.banConfig : {};
  const bans = ensureRoomBans(db, roomId);

  if (username && bans.users.some(b => b.value.toLowerCase() === username.toLowerCase())) {
    return { banned: true, reason: 'username' };
  }
  if (cfg.ipRange && ip && bans.ipRanges.some(b => ip.startsWith(b.value))) {
    return { banned: true, reason: 'IP range' };
  }
  if (cfg.browser && userAgent && bans.browsers.some(b => userAgent.toLowerCase().includes(b.value.toLowerCase()))) {
    return { banned: true, reason: 'browser' };
  }
  if (cfg.country && country && bans.countries.some(b => b.value.toLowerCase() === country.toLowerCase())) {
    return { banned: true, reason: 'country' };
  }
  if (cfg.city && city && bans.cities.some(b => b.value.toLowerCase() === city.toLowerCase())) {
    return { banned: true, reason: 'city' };
  }
  if (cfg.network && network && bans.networks.some(b => network.toLowerCase().includes(b.value.toLowerCase()))) {
    return { banned: true, reason: 'network' };
  }
  if ((cfg.proxy || cfg.tor) && isProxy) {
    return { banned: true, reason: cfg.tor && cfg.proxy ? 'proxy/TOR' : cfg.proxy ? 'proxy' : 'TOR (approximate)' };
  }
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

function recordRoomLogin(roomId, user, { ip, userAgent, geo }) {
  const db = load();
  db.recentLogins.push({
    roomId: Number(roomId),
    username: user.username,
    time: Date.now(),
    ip: ip || 'Unknown',
    country: geo ? geo.country : 'Unknown',
    countryCode: geo ? (geo.countryCode || '') : '',
    city: geo ? geo.city : 'Unknown',
    network: geo ? geo.network : 'Unknown',
    browser: parseBrowser(userAgent),
    fp: fingerprintFor(ip, userAgent)
  });
  db.recentLogins = db.recentLogins.slice(-2000);
  save(db);
}

function recentLoginsForRoom(roomId, limit = 200) {
  const db = load();
  return db.recentLogins
    .filter(l => l.roomId === Number(roomId))
    .sort((a, b) => b.time - a.time)
    .slice(0, limit);
}

function liveUsersForRoom(roomId) {
  const db = load();
  const ONLINE_WINDOW = 90 * 1000;
  const now = Date.now();
  return db.users
    .filter(u => u.currentRoom === Number(roomId) && (now - u.lastSeen) < ONLINE_WINDOW)
    .map(u => ({
      username: u.username, isGuest: u.isGuest, level: u.level, banned: u.banned, muted: u.muted,
      tags: u.tags || [],
      ip: u.lastIp, country: u.lastCountry, countryCode: u.lastCountryCode, city: u.lastCity,
      network: u.lastNetwork, isProxy: u.isProxy,
      restricted: u.restricted, rateLimitSeconds: u.rateLimitSeconds, allowEmojis: u.allowEmojis
    }));
}

// ---------- Tag-based moderation (owner/admin/etc. acting inside the chat room) ----------

const MOD_TAGS = ['owner', 'super_admin', 'admin', 'king', 'queen', 'rj_head'];
const LEVEL_CHANGE_TAGS = ['owner', 'super_admin'];

function hasModPower(user, tags) {
  return !!(user && Array.isArray(user.tags) && user.tags.some(t => tags.includes(t)));
}

function modAction({ token, targetUsername, roomId }, requiredTags) {
  const db = load();
  const actor = findUserByToken(db, token);
  if (!actor) return { error: 'Not logged in.', db: null, actor: null, target: null };
  if (!hasModPower(actor, requiredTags)) return { error: 'You do not have permission to do that.', db: null, actor: null, target: null };
  const target = findUserByUsername(db, targetUsername);
  if (!target) return { error: 'User not found.', db: null, actor: null, target: null };
  if (target.username === actor.username) return { error: "You can't moderate yourself.", db: null, actor: null, target: null };
  return { db, actor, target };
}

function modMute({ token, targetUsername }, muted) {
  const result = modAction({ token, targetUsername }, MOD_TAGS);
  if (result.error) return result;
  result.target.muted = !!muted;
  save(result.db);
  return { ok: true, target: publicProfile(result.target) };
}

function modKick({ token, targetUsername }) {
  const result = modAction({ token, targetUsername }, MOD_TAGS);
  if (result.error) return result;
  result.target.currentRoom = null;
  result.target.token = makeToken(); // invalidates their session; next request forces re-login
  save(result.db);
  return { ok: true };
}

function modBanFromRoom({ token, targetUsername, roomId }) {
  const result = modAction({ token, targetUsername, roomId }, MOD_TAGS);
  if (result.error) return result;
  return addRoomBan(roomId, 'users', targetUsername);
}

function modSetLevel({ token, targetUsername }, level) {
  const result = modAction({ token, targetUsername }, LEVEL_CHANGE_TAGS);
  if (result.error) return result;
  result.target.level = Number(level);
  save(result.db);
  return { ok: true, target: publicProfile(result.target) };
}



function adminLogin({ username, password }) {
  const db = load();
  const admin = db.admins.find(a => a.username.toLowerCase() === (username || '').toLowerCase());
  if (!admin) return { error: 'Invalid username or password.' };
  if (hashPassword(password || '') !== admin.passwordHash) return { error: 'Invalid username or password.' };
  admin.token = makeToken();
  save(db);
  return { token: admin.token, admin: { username: admin.username } };
}

function getAdminByToken(token) {
  const db = load();
  return db.admins.find(a => a.token === token);
}

function adminChangePassword(token, newPassword) {
  const db = load();
  const admin = db.admins.find(a => a.token === token);
  if (!admin) return { error: 'Not logged in.' };
  if (!newPassword || newPassword.length < 6) return { error: 'Password must be at least 6 characters.' };
  admin.passwordHash = hashPassword(newPassword);
  save(db);
  return { ok: true };
}

function dashboardStats() {
  const db = load();
  let activeBans = 0;
  Object.values(db.roomBans).forEach(rb => {
    BAN_TYPES.forEach(t => { activeBans += (rb[t] || []).length; });
  });
  activeBans += db.users.filter(u => u.banned).length;
  return {
    totalRooms: db.rooms.length,
    totalUsers: db.users.length,
    activeBans
  };
}


function addReaction({ token, targetUsername, type }) {
  const db = load();
  const fromUser = findUserByToken(db, token);
  if (!fromUser) return { error: 'Not logged in.' };
  const target = findUserByUsername(db, targetUsername);
  if (!target) return { error: 'User not found.' };
  if (target.username === fromUser.username) return { error: "You can't react to yourself." };

  const already = db.reactions.find(r => r.from === fromUser.username && r.to === target.username);
  if (already) {
    if (already.type === type) return { error: 'Already reacted.' };
    // switch reaction type
    if (already.type === 'like') target.likes = Math.max(0, target.likes - 1);
    if (already.type === 'dislike') target.dislikes = Math.max(0, target.dislikes - 1);
    already.type = type;
  } else {
    db.reactions.push({ from: fromUser.username, to: target.username, type });
  }

  if (type === 'like') target.likes += 1;
  if (type === 'dislike') target.dislikes += 1;

  save(db);
  return { target: publicProfile(target) };
}

// ---------- Leaderboards ----------

function leaderboardByPoints(limit = 50) {
  const db = load();
  return [...db.users]
    .sort((a, b) => b.points - a.points)
    .slice(0, limit)
    .map(u => ({ username: u.username, points: u.points, level: u.level }));
}

function leaderboardByLikes(limit = 50) {
  const db = load();
  return [...db.users]
    .sort((a, b) => b.likes - a.likes)
    .slice(0, limit)
    .map(u => ({ username: u.username, likes: u.likes }));
}

// ---------- Admin ----------

function adminKick(username) {
  const db = load();
  const user = findUserByUsername(db, username);
  if (!user) return { error: 'User not found.' };
  user.currentRoom = null;
  user.token = makeToken(); // invalidates their session immediately
  save(db);
  return { ok: true };
}

function adminSetRateLimit(username, seconds) {
  const db = load();
  const user = findUserByUsername(db, username);
  if (!user) return { error: 'User not found.' };
  user.rateLimitSeconds = Math.max(0, Number(seconds) || 0);
  save(db);
  return { user: publicProfile(user) };
}

// Everyone (accounts + guest sessions) who has ever logged in from this exact IP,
// most recent first — helps spot multi-accounting or ban evasion.
function ipHistory(ip) {
  const db = load();
  const fromLogins = db.recentLogins
    .filter(l => l.ip === ip)
    .map(l => ({ username: l.username, time: l.time, roomId: l.roomId }));
  const fromUsers = db.users
    .filter(u => u.lastIp === ip)
    .map(u => ({ username: u.username, time: u.lastSeen, roomId: u.currentRoom }));
  const combined = [...fromLogins, ...fromUsers];
  const seen = new Set();
  const deduped = [];
  combined.sort((a, b) => b.time - a.time).forEach(entry => {
    const key = entry.username + '|' + entry.time;
    if (!seen.has(key)) { seen.add(key); deduped.push(entry); }
  });
  return deduped;
}

function adminListUsers() {


  const db = load();
  return db.users.map(publicProfile);
}

function adminSetLevel(username, level) {
  const db = load();
  const user = findUserByUsername(db, username);
  if (!user) return { error: 'User not found.' };
  user.level = Number(level);
  save(db);
  return { user: publicProfile(user) };
}

function adminSetPoints(username, points) {
  const db = load();
  const user = findUserByUsername(db, username);
  if (!user) return { error: 'User not found.' };
  user.points = Number(points);
  save(db);
  return { user: publicProfile(user) };
}

function adminSetFlag(username, flag, value) {
  const db = load();
  const user = findUserByUsername(db, username);
  if (!user) return { error: 'User not found.' };
  user[flag] = !!value;
  save(db);
  return { user: publicProfile(user) };
}

function adminSearchUsers({ username, roomId }) {
  const db = load();
  let list = db.users;
  if (username) {
    const q = username.toLowerCase();
    list = list.filter(u => u.username.toLowerCase().includes(q));
  }
  if (roomId) {
    list = list.filter(u => u.currentRoom === Number(roomId));
  }
  return list.map(publicProfile);
}

function adminDeleteUser(username) {
  const db = load();
  const before = db.users.length;
  db.users = db.users.filter(u => u.username.toLowerCase() !== username.toLowerCase());
  save(db);
  return { ok: true, removed: before !== db.users.length };
}

module.exports = {
  createUser, login, getUserByToken, updateUser, heartbeat, listUsers, publicProfile,
  addMessage, getMessages, clearMessages,
  addReaction,
  sendPm, getPmThread, listPmThreads, markPmRead, unreadPmCount,
  leaderboardByPoints, leaderboardByLikes,
  adminListUsers, adminSetLevel, adminSetPoints, adminSetFlag, adminSearchUsers, adminDeleteUser,
  adminKick, adminSetRateLimit, ipHistory,
  listRooms, getRoom, publicRoom, createRoom, updateRoom, deleteRoom,
  getRoomBans, addRoomBan, removeRoomBan, BAN_TYPES,
  recentLoginsForRoom, liveUsersForRoom, recordRoomLogin,
  adminLogin, getAdminByToken, adminChangePassword, dashboardStats,
  hasModPower, modMute, modKick, modBanFromRoom, modSetLevel, MOD_TAGS, LEVEL_CHANGE_TAGS,
  lookupGeo, refreshUserGeo
};
