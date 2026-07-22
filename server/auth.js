// Passwords via scrypt, sessions via an HMAC-signed token. Both from node:crypto,
// so there is no auth dependency to keep patched.

import { randomBytes, scryptSync, timingSafeEqual, createHmac } from 'node:crypto';
import { createUser, getUserByName } from './db.js';

const SECRET =
  process.env.TGAME_SECRET ||
  // Ephemeral in dev: restarting the server just invalidates old sessions.
  randomBytes(32).toString('hex');

const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const candidate = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

const sign = (payload) => createHmac('sha256', SECRET).update(payload).digest('hex');

export function issueToken(userId) {
  const payload = `${userId}.${Date.now() + TOKEN_TTL_MS}`;
  return `${payload}.${sign(payload)}`;
}

/** @returns userId, or null when the token is absent, forged or expired. */
export function verifyToken(token) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [id, expiry, sig] = parts;
  const expected = sign(`${id}.${expiry}`);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (Date.now() > Number(expiry)) return null;
  return Number(id);
}

export const USERNAME_RE = /^[a-zA-Z0-9_-]{3,16}$/;

/** @returns {{user}|{error}} */
export function register(db, username, password) {
  if (!USERNAME_RE.test(username || '')) {
    return { error: 'username must be 3-16 chars: letters, numbers, _ or -' };
  }
  if (!password || password.length < 6) {
    return { error: 'password must be at least 6 characters' };
  }
  if (getUserByName(db, username)) return { error: 'username is taken' };
  return { user: createUser(db, username, hashPassword(password)) };
}

export function login(db, username, password) {
  const user = getUserByName(db, username);
  // Same message either way, so the endpoint does not confirm which names exist.
  if (!user || !verifyPassword(password, user.password_hash)) {
    return { error: 'invalid username or password' };
  }
  return { user };
}
