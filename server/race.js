// Ranked 1v1 races. The server owns the shell for each player, so mission
// completion is verified here - a client cannot simply claim it won.

import { Shell, COMMAND_NAMES } from '../engine/shell.js';
import { complete } from '../engine/complete.js';
import { missionSet, byId } from '../engine/missions.js';
import { updateElo, scoreRace } from './elo.js';
import { getUserById, setElo, recordMatch, recordResult } from './db.js';

export const RACE_MISSIONS = 5;
export const RACE_TIME_MS = 8 * 60 * 1000;
const COUNTDOWN_MS = 3000;

export class RaceManager {
  constructor(db, { timeLimitMs = RACE_TIME_MS, countdownMs = COUNTDOWN_MS } = {}) {
    this.db = db;
    this.queue = []; // [{ userId, username, elo, send }]
    this.races = new Map(); // raceId -> race
    this.byUser = new Map(); // userId -> raceId
    this.timeLimitMs = timeLimitMs;
    this.countdownMs = countdownMs;
    this.nextId = 1;
  }

  /** Adds a player to matchmaking; pairs immediately if someone is waiting. */
  enqueue(player) {
    if (this.byUser.has(player.userId)) return { error: 'already in a race' };
    if (this.queue.some((p) => p.userId === player.userId)) {
      return { error: 'already queued' };
    }
    this.queue.push(player);

    if (this.queue.length < 2) {
      player.send({ type: 'queued', position: this.queue.length });
      return { queued: true };
    }
    // Pair the new player with the closest rating waiting.
    const idx = this.queue.indexOf(player);
    let bestIdx = -1;
    let bestGap = Infinity;
    this.queue.forEach((p, i) => {
      if (i === idx) return;
      const gap = Math.abs(p.elo - player.elo);
      if (gap < bestGap) {
        bestGap = gap;
        bestIdx = i;
      }
    });
    const opponent = this.queue[bestIdx];
    this.queue = this.queue.filter((p) => p !== player && p !== opponent);
    return { race: this.start(opponent, player) };
  }

  /**
   * Removes a player from the queue. When `connId` is given only that specific
   * connection is removed, so a stale duplicate tab cannot evict the session
   * that is actually waiting.
   */
  dequeue(userId, connId = null) {
    this.queue = this.queue.filter(
      (p) => p.userId !== userId || (connId !== null && p.connId !== connId)
    );
  }

  start(p1, p2) {
    const id = this.nextId++;
    const seed = (Math.random() * 0xffffffff) >>> 0;
    const missions = missionSet(seed, RACE_MISSIONS);

    const mk = (p) => {
      const state = {
        ...p,
        index: 0,
        solved: 0,
        finishedAt: null,
        shell: null,
      };
      loadMission(state, missions[0]);
      return state;
    };

    const race = {
      id,
      missions,
      players: [mk(p1), mk(p2)],
      startsAt: Date.now() + this.countdownMs,
      endsAt: Date.now() + this.countdownMs + this.timeLimitMs,
      over: false,
      timer: null,
    };
    this.races.set(id, race);
    for (const p of race.players) this.byUser.set(p.userId, id);

    for (const p of race.players) {
      const other = race.players.find((x) => x !== p);
      p.send({
        type: 'race_start',
        raceId: id,
        opponent: { username: other.username, elo: other.elo },
        missionCount: missions.length,
        countdownMs: this.countdownMs,
        timeLimitMs: this.timeLimitMs,
        mission: briefFor(p, missions),
      });
    }

    race.timer = setTimeout(() => this.finish(id, 'time'), this.countdownMs + this.timeLimitMs);
    if (race.timer.unref) race.timer.unref();
    return race;
  }

  raceFor(userId) {
    const id = this.byUser.get(userId);
    return id === undefined ? null : this.races.get(id);
  }

  /** Resolves the player whose turn it is to act, or an error. */
  activePlayer(userId) {
    const race = this.raceFor(userId);
    if (!race || race.over) return { error: 'not in a race' };
    if (Date.now() < race.startsAt) return { error: 'race has not started' };
    const me = race.players.find((p) => p.userId === userId);
    if (me.finishedAt) return { error: 'you already finished' };
    return { race, me };
  }

  /** Runs one command for a player and reports progress to both sides. */
  command(userId, line) {
    const found = this.activePlayer(userId);
    if (found.error) return found;
    const { race, me } = found;

    const result = me.shell.run(line);
    const advanced = this.checkProgress(race, me);

    me.send({
      type: 'output',
      out: result.out,
      code: result.code,
      cwd: me.shell.cwd,
      solved: me.solved,
      advanced,
      mission: me.finishedAt ? null : briefFor(me, race.missions),
      // Tells the client to open its editor on this buffer.
      editor: result.editor || null,
    });

    this.settleIfDone(race, me, advanced);
    return { ok: true };
  }

  /** Saves an editor buffer. Editing a file can itself complete a mission. */
  save(userId, { path, content, sudo }) {
    const found = this.activePlayer(userId);
    if (found.error) return found;
    const { race, me } = found;

    const res = me.shell.writeFile(path, content ?? '', { sudo });
    if (res.error) {
      me.send({ type: 'editor_saved', path, error: res.error });
      return { ok: true };
    }

    const advanced = this.checkProgress(race, me);
    me.send({
      type: 'editor_saved',
      path,
      bytes: res.bytes,
      solved: me.solved,
      advanced,
      mission: me.finishedAt ? null : briefFor(me, race.missions),
    });

    this.settleIfDone(race, me, advanced);
    return { ok: true };
  }

  complete(userId, line) {
    const found = this.activePlayer(userId);
    if (found.error) return found;
    const { me } = found;
    me.send({ type: 'completion', ...completeFor(me.shell, line) });
    return { ok: true };
  }

  /** Advances the player if the current mission is now satisfied. */
  checkProgress(race, me) {
    const mission = byId(race.missions[me.index]);
    if (!mission || !mission.check(me.shell)) return false;
    me.solved++;
    me.index++;
    if (me.index >= race.missions.length) me.finishedAt = Date.now();
    else loadMission(me, race.missions[me.index]);
    return true;
  }

  settleIfDone(race, me, advanced) {
    const other = race.players.find((p) => p !== me);
    if (advanced) {
      other.send({ type: 'opponent_progress', solved: me.solved, total: race.missions.length });
    }
    // Everyone done, or this player finished first - settle it.
    if (race.players.every((p) => p.finishedAt)) this.finish(race.id, 'complete');
    else if (me.finishedAt) {
      other.send({ type: 'opponent_finished', solved: me.solved });
      this.finish(race.id, 'complete');
    }
  }

  /**
   * Treat a disconnect as a forfeit so the opponent is not left hanging - but
   * only when it is the connection actually playing the race that dropped.
   */
  disconnect(userId, connId = null) {
    this.dequeue(userId, connId);
    const race = this.raceFor(userId);
    if (!race || race.over) return;
    const player = race.players.find((p) => p.userId === userId);
    if (connId !== null && player && player.connId !== connId) return;
    this.finish(race.id, 'forfeit', userId);
  }

  finish(raceId, reason, forfeiterId = null) {
    const race = this.races.get(raceId);
    if (!race || race.over) return;
    race.over = true;
    clearTimeout(race.timer);

    const [p1, p2] = race.players;
    const now = Date.now();
    // Unfinished players are ranked by missions solved, with no finish time.
    const stat = (p) => ({ solved: p.solved, finishedAt: p.finishedAt ?? Infinity });

    let s1;
    if (reason === 'forfeit') s1 = forfeiterId === p1.userId ? 0 : 1;
    else s1 = scoreRace(stat(p1), stat(p2));

    const u1 = getUserById(this.db, p1.userId);
    const u2 = getUserById(this.db, p2.userId);
    const before1 = u1.elo;
    const before2 = u2.elo;
    const { a: after1, b: after2 } = updateElo(before1, before2, s1);

    setElo(this.db, p1.userId, after1);
    setElo(this.db, p2.userId, after2);
    recordResult(this.db, p1.userId, s1 === 1 ? 'win' : s1 === 0 ? 'loss' : 'draw');
    recordResult(this.db, p2.userId, s1 === 0 ? 'win' : s1 === 1 ? 'loss' : 'draw');

    const winnerId = s1 === 0.5 ? null : s1 === 1 ? p1.userId : p2.userId;
    recordMatch(this.db, {
      p1Id: p1.userId, p2Id: p2.userId, winnerId,
      p1EloBefore: before1, p2EloBefore: before2,
      p1EloAfter: after1, p2EloAfter: after2,
      p1Solved: p1.solved, p2Solved: p2.solved,
      missions: race.missions,
      durationMs: now - race.startsAt,
    });

    const results = [
      { p: p1, before: before1, after: after1, score: s1 },
      { p: p2, before: before2, after: after2, score: 1 - s1 },
    ];
    for (const { p, before, after, score } of results) {
      const other = results.find((r) => r.p !== p);
      p.send({
        type: 'race_over',
        reason,
        outcome: score === 1 ? 'win' : score === 0 ? 'loss' : 'draw',
        solved: p.solved,
        opponentSolved: other.p.solved,
        total: race.missions.length,
        eloBefore: before,
        eloAfter: after,
        eloDelta: after - before,
      });
      this.byUser.delete(p.userId);
    }
    this.races.delete(raceId);
  }
}

/** Shared by both modes: completion always reflects the server's filesystem. */
export function completeFor(shell, line) {
  const { line: completed, matches } = complete(
    { vfs: shell.vfs, cwd: shell.cwd, user: shell.user, commands: COMMAND_NAMES },
    line || ''
  );
  return { line: completed, matches };
}

function loadMission(player, missionId) {
  const m = byId(missionId);
  const w = m.setup();
  player.shell = new Shell({ vfs: w.vfs, procs: w.procs, cwd: w.cwd, user: 'op' });
}

function briefFor(player, missions) {
  const m = byId(missions[player.index]);
  return {
    index: player.index,
    total: missions.length,
    id: m.id,
    title: m.title,
    brief: m.brief,
    hint: m.hint,
  };
}
