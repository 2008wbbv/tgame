// Chaos rooms: every player in the room shares ONE filesystem and process
// table. Whatever you make, anyone else can chmod, chown, move or delete.
//
// Objective: own the most files under /srv/shared when the clock runs out.
// That makes rm/chown/mv genuinely adversarial rather than decorative.
// sudo is disabled here - root would trivially chown the whole tree and win.

import { Shell } from '../engine/shell.js';
import { VFS, dir, file } from '../engine/vfs.js';
import { completeFor } from './race.js';

export const SHARED = '/srv/shared';
export const CHAOS_TIME_MS = 5 * 60 * 1000;

function chaosWorld() {
  return new VFS(
    dir('root', 0o755, {
      home: dir('root', 0o755, {}),
      etc: dir('root', 0o755, {
        motd: file('welcome to the shared box. play nice. (you will not.)\n', 'root'),
      }),
      srv: dir('root', 0o755, {
        // 0o777 so every player can create, and delete each other's, files.
        shared: dir('root', 0o777, {
          'README': file('own the most files in here when time runs out.\n', 'root'),
        }),
      }),
      tmp: dir('root', 0o777, {}),
    })
  );
}

export class ChaosRoom {
  constructor(code, { timeLimitMs = CHAOS_TIME_MS } = {}) {
    this.code = code;
    this.vfs = chaosWorld();
    this.procs = [
      { pid: 1, user: 'root', cpu: 0.0, cmd: '/sbin/init' },
      { pid: 640, user: 'root', cpu: 0.2, cmd: '/usr/sbin/sshd -D' },
    ];
    this.players = new Map(); // userId -> { username, shell, send }
    this.timeLimitMs = timeLimitMs;
    this.startedAt = Date.now();
    this.endsAt = Date.now() + timeLimitMs;
    this.over = false;
    this.timer = null;
    this.onEnd = null;
  }

  join(player) {
    if (this.over) return { error: 'room has finished' };
    if (this.players.has(player.userId)) return { error: 'already in this room' };

    // Each player gets a home dir and acts as their own unix user, so file
    // ownership - and therefore sabotage - is meaningful.
    const home = `/home/${player.username}`;
    const homes = this.vfs.get('/home');
    if (!homes.children[player.username]) {
      homes.children[player.username] = dir(player.username, 0o755, {});
    }
    const shell = new Shell({
      vfs: this.vfs,
      procs: this.procs,
      cwd: home,
      user: player.username,
      allowSudo: false,
    });

    const entry = { ...player, shell };
    this.players.set(player.userId, entry);
    this.broadcast({ type: 'chaos_join', username: player.username, scores: this.scores() });

    if (!this.timer) {
      this.timer = setTimeout(() => this.end(), this.timeLimitMs);
      if (this.timer.unref) this.timer.unref();
    }
    return { room: this, player: entry };
  }

  leave(userId) {
    const p = this.players.get(userId);
    if (!p) return;
    this.players.delete(userId);
    this.broadcast({ type: 'chaos_leave', username: p.username, scores: this.scores() });
  }

  /**
   * Runs a command against the SHARED filesystem. Every other player sees what
   * you did, which is what makes the sabotage social rather than invisible.
   */
  command(userId, line) {
    if (this.over) return { error: 'room has finished' };
    const me = this.players.get(userId);
    if (!me) return { error: 'not in this room' };

    const result = me.shell.run(line);
    me.send({
      type: 'output',
      out: result.out,
      code: result.code,
      cwd: me.shell.cwd,
      editor: result.editor || null,
    });

    const scores = this.scores();
    for (const [id, p] of this.players) {
      if (id === userId) p.send({ type: 'chaos_scores', scores });
      else {
        p.send({
          type: 'chaos_feed',
          username: me.username,
          line,
          scores,
        });
      }
    }
    return { ok: true };
  }

  /**
   * Saves an editor buffer to the shared filesystem. Announced to the room like
   * any other action - writing a file here is as contestable as deleting one.
   */
  save(userId, { path, content, sudo }) {
    if (this.over) return { error: 'room has finished' };
    const me = this.players.get(userId);
    if (!me) return { error: 'not in this room' };

    const res = me.shell.writeFile(path, content ?? '', { sudo });
    if (res.error) {
      me.send({ type: 'editor_saved', path, error: res.error });
      return { ok: true };
    }

    const scores = this.scores();
    me.send({ type: 'editor_saved', path, bytes: res.bytes });
    for (const [id, p] of this.players) {
      if (id === userId) p.send({ type: 'chaos_scores', scores });
      else p.send({ type: 'chaos_feed', username: me.username, line: `:w ${path}`, scores });
    }
    return { ok: true };
  }

  complete(userId, line) {
    const me = this.players.get(userId);
    if (!me) return { error: 'not in this room' };
    me.send({ type: 'completion', ...completeFor(me.shell, line) });
    return { ok: true };
  }

  /** Files under /srv/shared, counted by owner. */
  scores() {
    const counts = new Map();
    for (const { username } of this.players.values()) counts.set(username, 0);

    const node = this.vfs.get(SHARED);
    if (node) {
      for (const [path, n] of this.vfs.walk(SHARED, node)) {
        if (path === SHARED || n.type !== 'file') continue;
        if (counts.has(n.owner)) counts.set(n.owner, counts.get(n.owner) + 1);
      }
    }
    return [...counts.entries()]
      .map(([username, files]) => ({ username, files }))
      .sort((a, b) => b.files - a.files || a.username.localeCompare(b.username));
  }

  end() {
    if (this.over) return;
    this.over = true;
    clearTimeout(this.timer);
    const scores = this.scores();
    const top = scores[0];
    // A tie at the top means nobody takes it.
    const winner = top && scores.filter((s) => s.files === top.files).length === 1 ? top : null;
    this.broadcast({
      type: 'chaos_over',
      scores,
      winner: winner ? winner.username : null,
    });
    if (this.onEnd) this.onEnd(this);
  }

  broadcast(msg) {
    for (const p of this.players.values()) p.send(msg);
  }
}

export class ChaosManager {
  constructor({ timeLimitMs = CHAOS_TIME_MS } = {}) {
    this.rooms = new Map(); // code -> ChaosRoom
    this.byUser = new Map(); // userId -> code
    this.timeLimitMs = timeLimitMs;
  }

  static newCode() {
    // Ambiguous characters left out so codes survive being read aloud.
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    return Array.from({ length: 4 }, () =>
      alphabet[Math.floor(Math.random() * alphabet.length)]
    ).join('');
  }

  create(player) {
    let code;
    do code = ChaosManager.newCode();
    while (this.rooms.has(code));

    const room = new ChaosRoom(code, { timeLimitMs: this.timeLimitMs });
    room.onEnd = (r) => {
      for (const id of r.players.keys()) this.byUser.delete(id);
      this.rooms.delete(r.code);
    };
    this.rooms.set(code, room);
    return this.join(player, code);
  }

  join(player, code) {
    code = (code || '').toUpperCase();
    const room = this.rooms.get(code);
    if (!room) return { error: 'no such room' };
    if (this.byUser.has(player.userId) && this.byUser.get(player.userId) !== code) {
      return { error: 'already in another room' };
    }
    const res = room.join(player);
    if (res.error) return res;
    this.byUser.set(player.userId, code);

    player.send({
      type: 'chaos_joined',
      code,
      objective: `own the most files in ${SHARED} when the timer ends`,
      sharedPath: SHARED,
      endsAt: room.endsAt,
      players: [...room.players.values()].map((p) => p.username),
      scores: room.scores(),
    });
    return res;
  }

  roomFor(userId) {
    const code = this.byUser.get(userId);
    return code ? this.rooms.get(code) : null;
  }

  command(userId, line) {
    const room = this.roomFor(userId);
    if (!room) return { error: 'not in a room' };
    return room.command(userId, line);
  }

  save(userId, payload) {
    const room = this.roomFor(userId);
    if (!room) return { error: 'not in a room' };
    return room.save(userId, payload);
  }

  complete(userId, line) {
    const room = this.roomFor(userId);
    if (!room) return { error: 'not in a room' };
    return room.complete(userId, line);
  }

  leave(userId, connId = null) {
    const room = this.roomFor(userId);
    if (!room) return;
    // Ignore a stale duplicate connection dropping; only the live one leaves.
    const player = room.players.get(userId);
    if (connId !== null && player && player.connId !== connId) return;
    room.leave(userId);
    this.byUser.delete(userId);
    if (room.players.size === 0) {
      clearTimeout(room.timer);
      this.rooms.delete(room.code);
    }
  }
}
