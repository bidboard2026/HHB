// admin-shell.js — shared across every /admin/*.html page.
// API_BASE is resolved relative to THIS SCRIPT's own location (one folder
// deeper than the main site), so it works whether the site is deployed at the
// domain root or a subfolder like /chat/ — same reasoning as pages/api.js.
const ADMIN_API_BASE = window.ADMIN_API_BASE || (function () {
  try {
    const scriptUrl = new URL(document.currentScript.src, window.location.href);
    return new URL('../api', scriptUrl).href.replace(/\/$/, '');
  } catch (e) {
    return window.location.origin + '/api'; // fallback
  }
})();

const AdminSession = {
  get(){ try{ return JSON.parse(sessionStorage.getItem('bidboard_admin')); } catch(e){ return null; } },
  set(session){ sessionStorage.setItem('bidboard_admin', JSON.stringify(session)); },
  clear(){ sessionStorage.removeItem('bidboard_admin'); },
  requireLogin(){
    const s = this.get();
    if(!s || !s.token){ window.location.href = 'admin-login.html'; return null; }
    return s;
  }
};

async function adminApi(path, options = {}){
  const session = AdminSession.get();
  const headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers || {});
  if(session && session.token) headers['x-admin-token'] = session.token;
  let res, data;
  try{
    res = await fetch(ADMIN_API_BASE + path, {
      method: options.method || 'GET',
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    data = await res.json();
  } catch(err){
    return { error: `Can't reach the BidBoard server at ${ADMIN_API_BASE}. Is it running?` };
  }
  if(res.status === 401){ AdminSession.clear(); window.location.href = 'admin-login.html'; return { error: 'Session expired.' }; }
  if(!res.ok) return { error: data.error || 'Request failed.' };
  return data;
}

function urlParam(name){ return new URLSearchParams(window.location.search).get(name); }

function flagEmoji(countryCode){
  if(!countryCode || countryCode.length !== 2) return '';
  return countryCode.toUpperCase().replace(/./g, c => String.fromCodePoint(127397 + c.charCodeAt()));
}

// Renders the full left sidebar (brand, per-room nav tree, users section) into containerEl.
// activeRoomId/activeKey highlight the current page. activeKey is one of:
// 'dashboard' | 'live' | 'recent' | 'bans:<type>' | 'settings' | 'search-users' | 'create-user'
async function renderAdminSidebar(containerEl, activeRoomId, activeKey){
  const result = await adminApi('/admin/rooms');
  const rooms = result.rooms || [];

  const banTypes = [
    ['users', 'Banned Users'],
    ['countries', 'Countries'],
    ['cities', 'Cities'],
    ['browsers', 'Browsers'],
    ['networks', 'Networks'],
    ['ipRanges', 'IP Ranges']
  ];

  function roomBlock(room){
    const isActiveRoom = Number(activeRoomId) === room.id;
    const items = isActiveRoom ? `
      <div class="sb-sub">
        <div class="sb-item ${activeKey==='live'?'active':''}" onclick="location.href='room-live.html?room=${room.id}'">📡 Live Users</div>
        <div class="sb-item ${activeKey==='recent'?'active':''}" onclick="location.href='room-recent-logins.html?room=${room.id}'">🕐 Recent Logins</div>
        <div class="sb-bans-label">BANS</div>
        ${banTypes.map(([type,label]) => `
          <div class="sb-item ${activeKey==='bans:'+type?'active':''}" onclick="location.href='room-bans.html?room=${room.id}&type=${type}'">🚫 ${label}</div>
        `).join('')}
        <div class="sb-item ${activeKey==='settings'?'active':''}" onclick="location.href='room-settings.html?room=${room.id}'">⚙️ Settings</div>
      </div>
    ` : '';
    return `
      <div class="sb-room" onclick="location.href='room-live.html?room=${room.id}'">
        <span>📶 ${room.name}</span>
        <span class="del" title="Delete room" onclick="event.stopPropagation(); deleteRoomPrompt(${room.id})">🗑</span>
      </div>
      ${items}
    `;
  }

  containerEl.innerHTML = `
    <div class="admin-brand">
      <div class="logo-ic">B</div>
      <div>
        <div class="name">BIDBOARD</div>
        <div class="sub">Control Panel</div>
      </div>
    </div>

    <div class="sb-item ${activeKey==='dashboard'?'active':''}" onclick="location.href='dashboard.html'">🏠 Dashboard</div>

    <div class="sb-section">ROOMS</div>
    <div class="sb-item" onclick="createRoomPrompt()">➕ New Room</div>
    ${rooms.map(roomBlock).join('')}

    <div class="sb-section">USERS</div>
    <div class="sb-item ${activeKey==='search-users'?'active':''}" onclick="location.href='users-search.html'">🔍 Search Users</div>
    <div class="sb-item ${activeKey==='create-user'?'active':''}" onclick="location.href='users-create.html'">➕ Create User</div>

    <div class="sb-section">&nbsp;</div>
    <div class="sb-item" onclick="location.href='../chat-room.html'">💬 Back to Site</div>
    <div class="sb-item" onclick="AdminSession.clear(); location.href='admin-login.html';">🚪 Log Out</div>
  `;
}

async function createRoomPrompt(){
  const name = prompt('Room name:');
  if(!name) return;
  const category = prompt('Category (e.g. Entertainment, Support, Gaming):', 'Entertainment') || 'General';
  const result = await adminApi('/admin/rooms', { method:'POST', body:{ name, category } });
  if(result.error){ alert(result.error); return; }
  window.location.href = `room-live.html?room=${result.room.id}`;
}

async function deleteRoomPrompt(roomId){
  if(!confirm('Delete this room? This also deletes its messages and ban lists. This cannot be undone.')) return;
  await adminApi(`/admin/rooms/${roomId}`, { method:'DELETE' });
  window.location.href = 'dashboard.html';
}

function renderTopbar(containerEl, breadcrumbHtml){
  const session = AdminSession.get();
  containerEl.innerHTML = `
    <div class="breadcrumb">${breadcrumbHtml}</div>
    <div class="topbar-right">
      <span class="live-badge"><span class="dot"></span> LIVE</span>
      <div class="admin-user">
        <div class="av">${(session && session.username ? session.username.charAt(0) : 'A').toUpperCase()}</div>
        ${session ? session.username : ''}
      </div>
    </div>
  `;
}
