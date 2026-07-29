// api.js — shared session + fetch helper for every BidBoard page.
// API_BASE is resolved relative to THIS SCRIPT's own location (not just the
// domain) so the exact same files work whether the site is deployed at the
// domain root (https://yourdomain.com/) or a subfolder (https://yourdomain.com/chat/).
// Override window.API_BASE before this script loads if your API lives elsewhere.
const API_BASE = window.API_BASE || (function () {
  try {
    const scriptUrl = new URL(document.currentScript.src, window.location.href);
    return new URL('api', scriptUrl).href.replace(/\/$/, '');
  } catch (e) {
    return window.location.origin + '/api'; // fallback
  }
})();

const Session = {
  get(){
    try { return JSON.parse(localStorage.getItem('bidboard_session')); }
    catch(e){ return null; }
  },
  set(session){ localStorage.setItem('bidboard_session', JSON.stringify(session)); },
  clear(){ localStorage.removeItem('bidboard_session'); },
  requireLogin(){
    const s = this.get();
    if(!s || !s.token){
      window.location.href = 'index.html';
      return null;
    }
    return s;
  }
};

async function api(path, options = {}){
  const session = Session.get();
  const headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers || {});
  if(session && session.token) headers['x-auth-token'] = session.token;

  let res, data;
  try{
    res = await fetch(API_BASE + path, {
      method: options.method || 'GET',
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    data = await res.json();
  } catch(err){
    return { error: `Can't reach the BidBoard server at ${API_BASE}. Is it running?` };
  }
  if(!res.ok){
    if(res.status === 401 && session){
      Session.clear();
      window.location.href = 'index.html';
    }
    return { error: data.error || 'Something went wrong.' };
  }
  return data;
}

function initials(name){ return (name || '?').trim().charAt(0).toUpperCase() || '?'; }

function urlParam(name){
  return new URLSearchParams(window.location.search).get(name);
}

const COLORS = ['#8b5cf6','#ec4899','#34a853','#4a90d9','#e0457a','#c2712f','#0aa5a0','#7c5cf0'];
function colorFor(name){
  let h = 0;
  for(let i=0;i<name.length;i++){ h = name.charCodeAt(i) + ((h<<5)-h); }
  return COLORS[Math.abs(h) % COLORS.length];
}

const TAG_BADGES = {
  owner: { label:'👑 Owner', color:'#f5b400' },
  super_admin: { label:'⭐ Super Admin', color:'#e0457a' },
  admin: { label:'🛡️ Admin', color:'#4a90d9' },
  king: { label:'♚ King', color:'#7c5cf0' },
  queen: { label:'♛ Queen', color:'#ec4899' },
  rj_head: { label:'🎙️ RJ Head', color:'#0aa5a0' },
  vip: { label:'⭐ VIP', color:'#e0457a' },
  platinum: { label:'💎 Platinum', color:'#4a90d9' },
  gold: { label:'🥇 Gold', color:'#d4a017' },
  silver: { label:'🥈 Silver', color:'#9aa5b1' },
  immune: { label:'🛡️ Immune', color:'#16a34a' },
  invisible: { label:'👻 Invisible', color:'#7c7495' }
};

function renderBadges(tags){
  if(!Array.isArray(tags)) return '';
  return tags
    .filter(t => TAG_BADGES[t])
    .map(t => `<span class="tag-badge" style="background:${TAG_BADGES[t].color}22; color:${TAG_BADGES[t].color};">${TAG_BADGES[t].label}</span>`)
    .join('');
}
