// captcha.js — a minimal, self-hosted math captcha.
// Honest scope: this deters simple signup/login bots. It is NOT equivalent to
// reCAPTCHA/hCaptcha (no behavioral/image analysis), and it does NOT protect
// against real network-level DDoS — that needs infrastructure like Cloudflare
// in front of the server, which is outside what an app-level captcha can do.

const crypto = require('crypto');

const challenges = new Map(); // id -> { answer, expiresAt }
const TTL_MS = 5 * 60 * 1000;

function generateCaptcha() {
  cleanup();
  const a = Math.floor(Math.random() * 8) + 1;
  const b = Math.floor(Math.random() * 8) + 1;
  const id = crypto.randomBytes(12).toString('hex');
  challenges.set(id, { answer: a + b, expiresAt: Date.now() + TTL_MS });
  return { id, question: `What is ${a} + ${b}?` };
}

function verifyCaptcha(id, answer) {
  const entry = challenges.get(id);
  if (!entry) return false;
  challenges.delete(id); // one-time use, whether it passes or not
  if (Date.now() > entry.expiresAt) return false;
  return Number(answer) === entry.answer;
}

function cleanup() {
  const now = Date.now();
  for (const [id, entry] of challenges) {
    if (now > entry.expiresAt) challenges.delete(id);
  }
}

module.exports = { generateCaptcha, verifyCaptcha };
