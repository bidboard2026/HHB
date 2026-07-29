// call-signaling.js — a real WebSocket relay for WebRTC call signaling.
// This does NOT carry audio/video itself (that's peer-to-peer once connected) —
// it only relays the handshake messages (offer/answer/ICE candidates) so two
// browsers can find each other and negotiate a direct connection.
//
// Known limitation: this uses only a public STUN server (for NAT discovery).
// On networks with strict/symmetric NAT (many corporate networks, some mobile
// carriers), a direct peer-to-peer connection can fail without a TURN relay
// server, which isn't free to run — flagging this rather than promising it
// always works everywhere.

const WebSocket = require('ws');

function attachCallSignaling(server, db) {
  const wss = new WebSocket.Server({ server, path: '/ws/call' });
  const socketsByUsername = new Map(); // username -> ws

  wss.on('connection', (ws) => {
    let identifiedAs = null;

    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch (e) { return; }

      if (msg.type === 'identify') {
        const user = await db.getUserByToken(msg.token);
        if (!user) { ws.send(JSON.stringify({ type: 'error', error: 'Invalid session.' })); return; }
        identifiedAs = user.username;
        socketsByUsername.set(identifiedAs, ws);
        ws.send(JSON.stringify({ type: 'identified', username: identifiedAs }));
        return;
      }

      if (!identifiedAs) return; // must identify first

      // All other message types just get relayed to the named target, with
      // the sender's identity attached so the target knows who it's from.
      if (['call-offer', 'call-answer', 'ice-candidate', 'call-end', 'call-decline'].includes(msg.type)) {
        const targetWs = socketsByUsername.get(msg.to);
        if (!targetWs || targetWs.readyState !== WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'call-failed', reason: `${msg.to} is not online.` }));
          return;
        }
        targetWs.send(JSON.stringify({ ...msg, from: identifiedAs }));
      }
    });

    ws.on('close', () => {
      if (identifiedAs && socketsByUsername.get(identifiedAs) === ws) {
        socketsByUsername.delete(identifiedAs);
      }
    });
  });

  return wss;
}

module.exports = { attachCallSignaling };
