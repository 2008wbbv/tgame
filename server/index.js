// HTTP for auth + boards, WebSocket for live play. node:http directly - the
// route table is small enough that a framework would be the biggest dependency.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import { openDb, leaderboard, matchHistory, getUserById } from './db.js';
import { register, login, issueToken, verifyToken } from './auth.js';
import { RaceManager } from './race.js';
import { ChaosManager } from './chaos.js';
import { rankFor } from './elo.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = Number(process.env.PORT) || 3000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

export function createServer({ db = openDb(), raceOpts, chaosOpts } = {}) {
  const races = new RaceManager(db, raceOpts);
  const chaos = new ChaosManager(chaosOpts);
  let connCounter = 0;

  const server = http.createServer(async (req, res) => {
    try {
      if (req.url.startsWith('/api/')) return await api(req, res, db);
      return await serveStatic(req, res);
    } catch (e) {
      send(res, 500, { error: e.message });
    }
  });

  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    const userId = verifyToken(url.searchParams.get('token'));
    const user = userId && getUserById(db, userId);
    if (!user) {
      ws.send(JSON.stringify({ type: 'error', error: 'unauthorized' }));
      return ws.close();
    }

    const send = (msg) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
    };
    // Identifies this socket, so a second tab for the same account cannot
    // knock the live session out of its queue or race when it closes.
    const connId = ++connCounter;
    // Elo is read fresh per action; this snapshot is only for matchmaking.
    const player = { userId: user.id, username: user.username, elo: user.elo, send, connId };

    send({
      type: 'hello',
      username: user.username,
      elo: user.elo,
      rank: rankFor(user.elo),
    });

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return send({ type: 'error', error: 'malformed message' });
      }
      handle(msg);
    });

    function handle(msg) {
      const fail = (r) => r && r.error && send({ type: 'error', error: r.error });

      switch (msg.type) {
        case 'queue': {
          player.elo = getUserById(db, user.id).elo;
          return fail(races.enqueue(player));
        }
        case 'cancel_queue':
          races.dequeue(user.id, connId);
          return send({ type: 'queue_cancelled' });

        case 'chaos_create':
          return fail(chaos.create(player));

        case 'chaos_join':
          return fail(chaos.join(player, msg.code));

        case 'leave':
          // Walking out of a live race forfeits it, exactly like dropping.
          races.disconnect(user.id, connId);
          chaos.leave(user.id, connId);
          return send({ type: 'left' });

        case 'cmd': {
          // Route to whichever mode this player is currently in.
          if (races.raceFor(user.id)) return fail(races.command(user.id, msg.line || ''));
          if (chaos.roomFor(user.id)) return fail(chaos.command(user.id, msg.line || ''));
          return send({ type: 'error', error: 'not in a game' });
        }

        case 'editor_save': {
          // The buffer is edited client-side, but the write is checked here.
          const payload = { path: msg.path, content: msg.content, sudo: !!msg.sudo };
          if (races.raceFor(user.id)) return fail(races.save(user.id, payload));
          if (chaos.roomFor(user.id)) return fail(chaos.save(user.id, payload));
          return send({ type: 'error', error: 'not in a game' });
        }

        case 'complete': {
          if (races.raceFor(user.id)) return fail(races.complete(user.id, msg.line || ''));
          if (chaos.roomFor(user.id)) return fail(chaos.complete(user.id, msg.line || ''));
          return send({ type: 'error', error: 'not in a game' });
        }
        default:
          return send({ type: 'error', error: `unknown message: ${msg.type}` });
      }
    }

    ws.on('close', () => {
      races.disconnect(user.id, connId);
      chaos.leave(user.id, connId);
    });
  });

  return { server, db, races, chaos, wss };
}

async function api(req, res, db) {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;

  if (req.method === 'POST' && (path === '/api/register' || path === '/api/login')) {
    const body = await readBody(req);
    const { username, password } = body;
    const result =
      path === '/api/register'
        ? register(db, username, password)
        : login(db, username, password);
    if (result.error) return send(res, 400, { error: result.error });
    const u = result.user;
    return send(res, 200, {
      token: issueToken(u.id),
      user: { username: u.username, elo: u.elo, rank: rankFor(u.elo), wins: u.wins, losses: u.losses, draws: u.draws },
    });
  }

  if (req.method === 'GET' && path === '/api/me') {
    const u = requireUser(req, res, db);
    if (!u) return;
    return send(res, 200, {
      user: { username: u.username, elo: u.elo, rank: rankFor(u.elo), wins: u.wins, losses: u.losses, draws: u.draws },
    });
  }

  if (req.method === 'GET' && path === '/api/leaderboard') {
    const rows = leaderboard(db).map((r) => ({ ...r, rank: rankFor(r.elo) }));
    return send(res, 200, { leaderboard: rows });
  }

  if (req.method === 'GET' && path === '/api/history') {
    const u = requireUser(req, res, db);
    if (!u) return;
    const rows = matchHistory(db, u.id).map((m) => {
      const isP1 = m.p1_id === u.id;
      return {
        opponent: isP1 ? m.p2_name : m.p1_name,
        solved: isP1 ? m.p1_solved : m.p2_solved,
        opponentSolved: isP1 ? m.p2_solved : m.p1_solved,
        eloDelta: (isP1 ? m.p1_elo_after - m.p1_elo_before : m.p2_elo_after - m.p2_elo_before),
        outcome: m.winner_id === null ? 'draw' : m.winner_id === u.id ? 'win' : 'loss',
        at: m.created_at,
      };
    });
    return send(res, 200, { history: rows });
  }

  return send(res, 404, { error: 'not found' });
}

function requireUser(req, res, db) {
  const auth = req.headers.authorization || '';
  const id = verifyToken(auth.replace(/^Bearer /, ''));
  const user = id && getUserById(db, id);
  if (!user) {
    send(res, 401, { error: 'unauthorized' });
    return null;
  }
  return user;
}

async function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let path = url.pathname === '/' ? '/client/index.html' : url.pathname;

  // Only the client and the shared engine are public.
  if (!path.startsWith('/client/') && !path.startsWith('/engine/')) {
    path = '/client' + path;
  }
  const full = join(ROOT, normalize(path).replace(/^(\.\.[/\\])+/, ''));
  if (!full.startsWith(ROOT)) return send(res, 403, { error: 'forbidden' });

  try {
    const data = await readFile(full);
    res.writeHead(200, {
      'content-type': MIME[extname(full)] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(data);
  } catch {
    send(res, 404, { error: 'not found' });
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1e6) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

function send(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
  });
  res.end(data);
}

// Only listen when run directly, so tests can import createServer.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const { server } = createServer();
  server.listen(PORT, () => {
    console.log(`tgame listening on http://localhost:${PORT}`);
  });
}
