// call-webrtc.js — real peer-to-peer audio/video calling.
// Uses call-signaling.js's WebSocket relay for the handshake (offer/answer/ICE),
// then WebRTC connects directly between the two browsers.
// Known limitation: only a public STUN server is configured (no TURN), so calls
// across some strict/symmetric NATs may fail to connect directly — a TURN
// relay server would fix that but isn't free to run, so it's not included.

let callSocket = null;
let peerConnection = null;
let localStream = null;
let currentCallPartner = null;
let currentCallMode = null; // 'audio' | 'video'
let callTimerHandle = null;
let callSeconds = 0;

const RTC_CONFIG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

function injectCallBannerStyles(){
  if(document.getElementById('call-banner-styles')) return;
  const style = document.createElement('style');
  style.id = 'call-banner-styles';
  style.textContent = `
    .call-banner{
      position:sticky; top:0; z-index:60; display:none;
      background:linear-gradient(90deg,#1c1533,#2a1e4d); color:#fff;
      padding:10px 20px; align-items:center; gap:14px; font-family:inherit;
    }
    .call-banner.show{ display:flex; }
    .call-banner .cb-avatar{ width:34px; height:34px; border-radius:50%; background:linear-gradient(135deg,#8b5cf6,#ec4899); display:flex; align-items:center; justify-content:center; font-weight:800; flex-shrink:0; }
    .call-banner .cb-info{ flex:1; min-width:0; }
    .call-banner .cb-name{ font-weight:700; font-size:14px; }
    .call-banner .cb-status{ font-size:11.5px; color:#c9c2e0; }
    .call-banner .cb-btn{ width:34px; height:34px; border-radius:9px; border:none; background:rgba(255,255,255,0.12); color:#fff; font-size:14px; cursor:pointer; }
    .call-banner .cb-btn.off{ background:#e14545; }
    .call-banner .cb-btn.hangup{ background:#e14545; }
    .call-banner video.cb-video{ width:64px; height:48px; border-radius:8px; object-fit:cover; background:#000; }
    .incoming-call-toast{
      position:fixed; top:16px; right:16px; z-index:9999; background:#1c1533; color:#fff;
      padding:16px 18px; border-radius:14px; box-shadow:0 20px 50px rgba(0,0,0,0.35); width:260px;
    }
    .incoming-call-toast .ic-name{ font-weight:800; margin-bottom:2px; }
    .incoming-call-toast .ic-sub{ font-size:12px; color:#c9c2e0; margin-bottom:12px; }
    .incoming-call-toast .ic-actions{ display:flex; gap:8px; }
    .incoming-call-toast button{ flex:1; padding:8px 0; border:none; border-radius:8px; font-weight:700; cursor:pointer; }
    .incoming-call-toast .ic-accept{ background:#16a34a; color:#fff; }
    .incoming-call-toast .ic-decline{ background:#e14545; color:#fff; }
  `;
  document.head.appendChild(style);
}

function ensureCallBanner(){
  injectCallBannerStyles();
  let banner = document.getElementById('call-banner');
  if(!banner){
    banner = document.createElement('div');
    banner.id = 'call-banner';
    banner.className = 'call-banner';
    banner.innerHTML = `
      <div class="cb-avatar" id="cb-avatar">?</div>
      <div class="cb-info">
        <div class="cb-name" id="cb-name">—</div>
        <div class="cb-status" id="cb-status">—</div>
      </div>
      <video class="cb-video" id="cb-remote-video" autoplay playsinline style="display:none;"></video>
      <button class="cb-btn" id="cb-mic" title="Mute">🎤</button>
      <button class="cb-btn" id="cb-cam" title="Camera" style="display:none;">📹</button>
      <button class="cb-btn hangup" id="cb-hangup" title="Hang up">📞</button>
    `;
    document.body.insertBefore(banner, document.body.firstChild);
    document.getElementById('cb-hangup').addEventListener('click', endCall);
    document.getElementById('cb-mic').addEventListener('click', toggleMic);
    document.getElementById('cb-cam').addEventListener('click', toggleCam);
  }
  return banner;
}

function showBanner(name, status){
  const banner = ensureCallBanner();
  document.getElementById('cb-avatar').textContent = (name||'?').charAt(0).toUpperCase();
  document.getElementById('cb-name').textContent = name;
  document.getElementById('cb-status').textContent = status;
  banner.classList.add('show');
}
function hideBanner(){
  const banner = document.getElementById('call-banner');
  if(banner) banner.classList.remove('show');
}

function connectCallSignaling(token){
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  callSocket = new WebSocket(`${proto}//${window.location.host}/ws/call`);
  callSocket.addEventListener('open', () => {
    callSocket.send(JSON.stringify({ type:'identify', token }));
  });
  callSocket.addEventListener('message', (evt) => handleSignal(JSON.parse(evt.data)));
  callSocket.addEventListener('close', () => { setTimeout(() => connectCallSignaling(token), 3000); }); // auto-reconnect
}

async function handleSignal(msg){
  if(msg.type === 'call-offer'){
    showIncomingCallToast(msg.from, msg.sdp, msg.mode || 'audio');
  } else if(msg.type === 'call-answer'){
    if(peerConnection){
      await peerConnection.setRemoteDescription({ type:'answer', sdp: msg.sdp });
      showBanner(currentCallPartner, 'Connected');
      startCallTimer();
    }
  } else if(msg.type === 'ice-candidate'){
    if(peerConnection && msg.candidate){
      try{ await peerConnection.addIceCandidate(msg.candidate); }catch(e){}
    }
  } else if(msg.type === 'call-end' || msg.type === 'call-decline'){
    cleanupCall(msg.type === 'call-decline' ? `${msg.from} declined the call.` : `${msg.from} ended the call.`);
  } else if(msg.type === 'call-failed'){
    cleanupCall(msg.reason || 'Call failed.');
  }
}

function showIncomingCallToast(fromUsername, offerSdp, mode){
  const existing = document.getElementById('incoming-call-toast');
  if(existing) existing.remove();
  const toast = document.createElement('div');
  toast.id = 'incoming-call-toast';
  toast.className = 'incoming-call-toast';
  toast.innerHTML = `
    <div class="ic-name">${fromUsername}</div>
    <div class="ic-sub">Incoming ${mode === 'video' ? 'video' : 'audio'} call…</div>
    <div class="ic-actions">
      <button class="ic-accept">Accept</button>
      <button class="ic-decline">Decline</button>
    </div>
  `;
  document.body.appendChild(toast);
  toast.querySelector('.ic-accept').addEventListener('click', async () => {
    toast.remove();
    await answerCall(fromUsername, offerSdp, mode);
  });
  toast.querySelector('.ic-decline').addEventListener('click', () => {
    toast.remove();
    callSocket.send(JSON.stringify({ type:'call-decline', to: fromUsername }));
  });
}

async function startCall(targetUsername, mode){
  currentCallPartner = targetUsername;
  currentCallMode = mode;
  try{
    localStream = await navigator.mediaDevices.getUserMedia({ audio:true, video: mode === 'video' });
  }catch(e){
    alert("Couldn't access microphone/camera: " + e.message);
    return;
  }
  peerConnection = new RTCPeerConnection(RTC_CONFIG);
  localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));
  peerConnection.onicecandidate = (e) => {
    if(e.candidate) callSocket.send(JSON.stringify({ type:'ice-candidate', to: targetUsername, candidate: e.candidate }));
  };
  peerConnection.ontrack = (e) => attachRemoteStream(e.streams[0]);

  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);
  callSocket.send(JSON.stringify({ type:'call-offer', to: targetUsername, sdp: offer.sdp, mode }));
  showBanner(targetUsername, 'Ringing…');
}

async function answerCall(fromUsername, offerSdp, mode){
  currentCallPartner = fromUsername;
  currentCallMode = mode;
  try{
    localStream = await navigator.mediaDevices.getUserMedia({ audio:true, video: mode === 'video' });
  }catch(e){
    alert("Couldn't access microphone/camera: " + e.message);
    callSocket.send(JSON.stringify({ type:'call-decline', to: fromUsername }));
    return;
  }
  peerConnection = new RTCPeerConnection(RTC_CONFIG);
  localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));
  peerConnection.onicecandidate = (e) => {
    if(e.candidate) callSocket.send(JSON.stringify({ type:'ice-candidate', to: fromUsername, candidate: e.candidate }));
  };
  peerConnection.ontrack = (e) => attachRemoteStream(e.streams[0]);

  await peerConnection.setRemoteDescription({ type:'offer', sdp: offerSdp });
  const answer = await peerConnection.createAnswer();
  await peerConnection.setLocalDescription(answer);
  callSocket.send(JSON.stringify({ type:'call-answer', to: fromUsername, sdp: answer.sdp }));
  showBanner(fromUsername, 'Connected');
  startCallTimer();
  if(mode === 'video') document.getElementById('cb-cam').style.display = 'inline-block';
}

function attachRemoteStream(stream){
  const videoEl = document.getElementById('cb-remote-video');
  videoEl.srcObject = stream;
  if(currentCallMode === 'video'){
    videoEl.style.display = 'inline-block';
  } else {
    videoEl.style.display = 'none';
  }
}

function startCallTimer(){
  callSeconds = 0;
  clearInterval(callTimerHandle);
  callTimerHandle = setInterval(() => {
    callSeconds++;
    const m = String(Math.floor(callSeconds/60)).padStart(2,'0');
    const s = String(callSeconds%60).padStart(2,'0');
    const statusEl = document.getElementById('cb-status');
    if(statusEl) statusEl.textContent = `Connected ${m}:${s}`;
  }, 1000);
}

function endCall(){
  if(currentCallPartner && callSocket && callSocket.readyState === WebSocket.OPEN){
    callSocket.send(JSON.stringify({ type:'call-end', to: currentCallPartner }));
  }
  cleanupCall();
}

function cleanupCall(message){
  clearInterval(callTimerHandle);
  if(peerConnection){ peerConnection.close(); peerConnection = null; }
  if(localStream){ localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  currentCallPartner = null;
  hideBanner();
  const cam = document.getElementById('cb-cam');
  if(cam) cam.style.display = 'none';
  if(message) showTemporaryNotice(message);
}

function showTemporaryNotice(text){
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed; top:16px; left:50%; transform:translateX(-50%); background:#1c1533; color:#fff; padding:10px 18px; border-radius:10px; z-index:9999; font-size:13px;';
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

function toggleMic(){
  if(!localStream) return;
  const track = localStream.getAudioTracks()[0];
  if(!track) return;
  track.enabled = !track.enabled;
  document.getElementById('cb-mic').classList.toggle('off', !track.enabled);
}
function toggleCam(){
  if(!localStream) return;
  const track = localStream.getVideoTracks()[0];
  if(!track) return;
  track.enabled = !track.enabled;
  document.getElementById('cb-cam').classList.toggle('off', !track.enabled);
}

// Backward-compatible name used by existing call buttons in chat-room.html/pm.html.
function openCallModal(targetUsername, mode){
  startCall(targetUsername, mode);
}
