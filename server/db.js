// Persistence, on Node's built-in SQLite. No ORM, no migrations framework -
// the schema is small enough to declare once, idempotently.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const START_ELO = 1200;

export function openDb(path = process.env.TGAME_DB || './data/tgame.db') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      elo           INTEGER NOT NULL DEFAULT ${START_ELO},
      wins          INTEGER NOT NULL DEFAULT 0,
      losses        INTEGER NOT NULL DEFAULT 0,
      draws         INTEGER NOT NULL DEFAULT 0,
      created_at    INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS matches (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      p1_id         INTEGER NOT NULL REFERENCES users(id),
      p2_id         INTEGER NOT NULL REFERENCES users(id),
      winner_id     INTEGER REFERENCES users(id),
      p1_elo_before INTEGER NOT NULL,
      p2_elo_before INTEGER NOT NULL,
      p1_elo_after  INTEGER NOT NULL,
      p2_elo_after  INTEGER NOT NULL,
      p1_solved     INTEGER NOT NULL,
      p2_solved     INTEGER NOT NULL,
      missions      TEXT NOT NULL,
      duration_ms   INTEGER NOT NULL,
      created_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_matches_p1 ON matches(p1_id);
    CREATE INDEX IF NOT EXISTS idx_matches_p2 ON matches(p2_id);
  `);
  return db;
}

export function createUser(db, username, passwordHash) {
  const info = db
    .prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)')
    .run(username, passwordHash, Date.now());
  return getUserById(db, Number(info.lastInsertRowid));
}

export const getUserByName = (db, username) =>
  db.prepare('SELECT * FROM users WHERE username = ?').get(username);

export const getUserById = (db, id) =>
  db.prepare('SELECT * FROM users WHERE id = ?').get(id);

export const setElo = (db, id, elo) =>
  db.prepare('UPDATE users SET elo = ? WHERE id = ?').run(elo, id);

export function recordResult(db, id, outcome) {
  const col = { win: 'wins', loss: 'losses', draw: 'draws' }[outcome];
  db.prepare(`UPDATE users SET ${col} = ${col} + 1 WHERE id = ?`).run(id);
}

export function recordMatch(db, m) {
  db.prepare(
    `INSERT INTO matches
      (p1_id, p2_id, winner_id, p1_elo_before, p2_elo_before, p1_elo_after,
       p2_elo_after, p1_solved, p2_solved, missions, duration_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    m.p1Id, m.p2Id, m.winnerId, m.p1EloBefore, m.p2EloBefore, m.p1EloAfter,
    m.p2EloAfter, m.p1Solved, m.p2Solved, JSON.stringify(m.missions),
    m.durationMs, Date.now()
  );
}

export const leaderboard = (db, limit = 25) =>
  db
    .prepare(
      `SELECT username, elo, wins, losses, draws FROM users
       ORDER BY elo DESC, wins DESC, username ASC LIMIT ?`
    )
    .all(limit);

/** Recent matches for one player, newest first, with opponent names resolved. */
export const matchHistory = (db, userId, limit = 20) =>
  db
    .prepare(
      `SELECT m.*, u1.username AS p1_name, u2.username AS p2_name
       FROM matches m
       JOIN users u1 ON u1.id = m.p1_id
       JOIN users u2 ON u2.id = m.p2_id
       WHERE m.p1_id = ? OR m.p2_id = ?
       ORDER BY m.created_at DESC LIMIT ?`
    )
    .all(userId, userId, limit);
