import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';

import { createServer } from '../server/index.js';
import { openDb, START_ELO } from '../server/db.js';
import { updateElo, expectedScore, scoreRace, rankFor } from '../server/elo.js';
import { SOLUTIONS } from './solutions.js';

// ---------------------------------------------------------------- elo maths

test('elo is zero-sum, rating-sensitive and symmetric', () => {
  const even = updateElo(1200, 1200, 1);
  assert.equal(even.a, 1216);
  assert.equal(even.b, 1184);
  assert.equal(even.a + even.b, 2400, 'points are conserved between equals');

  // Beating a stronger player is worth more than beating a weaker one.
  const upset = updateElo(1000, 1600, 1);
  const expected = updateElo(1600, 1000, 1);
  assert.ok(upset.a - 1000 > expected.a - 1600);

  const draw = updateElo(1200, 1200, 0.5);
  assert.deepEqual(draw, { a: 1200, b: 1200 }, 'even draw moves nobody');

  assert.ok(Math.abs(expectedScore(1200, 1200) - 0.5) < 1e-9);
  assert.ok(expectedScore(1600, 1000) > 0.9);
});

test('race scoring prefers missions solved, then speed', () => {
  assert.equal(scoreRace({ solved: 3, finishedAt: 999 }, { solved: 2, finishedAt: 1 }), 1);
  assert.equal(scoreRace({ solved: 2, finishedAt: 50 }, { solved: 2, finishedAt: 10 }), 0);
  assert.equal(scoreRace({ solved: 2, finishedAt: 10 }, { solved: 2, finishedAt: 50 }), 1);
  assert.equal(scoreRace({ solved: 0, finishedAt: Infinity }, { solved: 0, finishedAt: Infinity }), 0.5);
});

test('ranks climb with rating', () => {
  assert.equal(rankFor(800), 'Intern');
  assert.equal(rankFor(1200), 'Sysadmin');
  assert.equal(rankFor(2400), 'Root Wizard');
});

// ------------------------------------------------------------- test harness

async function withServer(fn, opts = {}) {
  const db = openDb(':memory:');
  const { server, ...rest } = createServer({
    db,
    raceOpts: { countdownMs: 0, timeLimitMs: 60_000 },
    chaosOpts: { timeLimitMs: 60_000 },
    ...opts,
  });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  try {
    return await fn({ base, port, db, server, ...rest });
  } finally {
    for (const c of rest.wss.clients) c.terminate();
    await new Promise((r) => server.close(r));
  }
}

const post = (base, path, body) =>
  fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

/** A WS client that queues incoming messages so tests can await specific types. */
class Client {
  constructor(port, token, username) {
    this.username = username;
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
    this.messages = [];
    this.waiters = [];
    this.ws.on('message', (raw) => {
      const msg = JSON.parse(raw);
      // Hand it to the first waiter that wants it; only buffer it if nobody
      // is waiting, so a message is never delivered twice.
      const w = this.waiters.find((x) => x.match(msg));
      if (w) {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        w.resolve(msg);
      } else {
        this.messages.push(msg);
      }
    });
  }

  open() {
    return new Promise((res, rej) => {
      this.ws.once('open', res);
      this.ws.once('error', rej);
    });
  }

  /** Resolves with the first message (past or future) matching `type`. */
  wait(type, timeout = 5000) {
    const match = (m) => (typeof type === 'function' ? type(m) : m.type === type);
    const existing = this.messages.find(match);
    if (existing) {
      this.messages.splice(this.messages.indexOf(existing), 1);
      return Promise.resolve(existing);
    }
    return new Promise((resolve, reject) => {
      const w = { match, resolve };
      this.waiters.push(w);
      setTimeout(() => {
        if (this.waiters.includes(w)) {
          this.waiters.splice(this.waiters.indexOf(w), 1);
          reject(new Error(`${this.username}: timed out waiting for ${type}`));
        }
      }, timeout).unref?.();
    });
  }

  send(msg) {
    this.ws.send(JSON.stringify(msg));
  }

  close() {
    this.ws.close();
  }
}

async function signUp({ base, port }, username, password = 'hunter22') {
  const { body } = await post(base, '/api/register', { username, password });
  assert.ok(body.token, `register failed: ${JSON.stringify(body)}`);
  const c = new Client(port, body.token, username);
  await c.open();
  await c.wait('hello');
  return { client: c, token: body.token, user: body.user };
}

/**
 * Runs one chaos command and drains both messages it produces, so the next
 * assertion always sees the scores for the command it just ran.
 */
async function chaosRun(client, line) {
  client.send({ type: 'cmd', line });
  const out = await client.wait('output');
  const { scores } = await client.wait('chaos_scores');
  return { out, scores };
}

const tally = (scores) => scores.map((s) => [s.username, s.files]).sort();

/** Plays a mission to completion, returning the race_over if it arrives. */
async function solve(client, mission) {
  for (const line of SOLUTIONS[mission.id]) {
    client.send({ type: 'cmd', line });
    const out = await client.wait((m) => m.type === 'output');
    if (out.advanced) return out;
  }
  return client.wait((m) => m.type === 'output' || m.type === 'race_over', 1000).catch(() => null);
}

// ----------------------------------------------------------------- auth API

test('register validates, rejects duplicates, and login round-trips', async () => {
  await withServer(async ({ base }) => {
    assert.equal((await post(base, '/api/register', { username: 'ab', password: 'hunter22' })).status, 400);
    assert.equal((await post(base, '/api/register', { username: 'good', password: 'x' })).status, 400);
    assert.match(
      (await post(base, '/api/register', { username: 'bad name!', password: 'hunter22' })).body.error,
      /username/
    );

    const first = await post(base, '/api/register', { username: 'alice', password: 'hunter22' });
    assert.equal(first.status, 200);
    assert.equal(first.body.user.elo, START_ELO);
    assert.equal(first.body.user.rank, 'Sysadmin');

    const dupe = await post(base, '/api/register', { username: 'alice', password: 'hunter22' });
    assert.match(dupe.body.error, /taken/);

    const good = await post(base, '/api/login', { username: 'alice', password: 'hunter22' });
    assert.equal(good.status, 200);
    assert.ok(good.body.token);

    const bad = await post(base, '/api/login', { username: 'alice', password: 'wrong' });
    assert.equal(bad.status, 400);
    // Unknown users and wrong passwords are indistinguishable.
    const ghost = await post(base, '/api/login', { username: 'nobody', password: 'wrong' });
    assert.equal(bad.body.error, ghost.body.error);

    // Protected routes need a valid token.
    assert.equal((await fetch(base + '/api/me')).status, 401);
    const me = await fetch(base + '/api/me', {
      headers: { authorization: `Bearer ${good.body.token}` },
    });
    assert.equal((await me.json()).user.username, 'alice');

    const forged = await fetch(base + '/api/me', { headers: { authorization: 'Bearer 1.9999999999999.deadbeef' } });
    assert.equal(forged.status, 401);
  });
});

test('websocket rejects a missing or forged token', async () => {
  await withServer(async ({ port }) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=nope`);
    const msg = await new Promise((res, rej) => {
      ws.on('message', (raw) => res(JSON.parse(raw)));
      ws.on('error', rej);
    });
    assert.equal(msg.error, 'unauthorized');
  });
});

// -------------------------------------------------------------- ranked race

test('a full race: matchmaking, server-verified missions, elo settlement', async () => {
  await withServer(async (ctx) => {
    const a = await signUp(ctx, 'alice');
    const b = await signUp(ctx, 'bob');

    a.client.send({ type: 'queue' });
    await a.client.wait('queued');
    b.client.send({ type: 'queue' });

    const startA = await a.client.wait('race_start');
    const startB = await b.client.wait('race_start');

    // Both players get the same mission set, and see each other.
    assert.equal(startA.opponent.username, 'bob');
    assert.equal(startB.opponent.username, 'alice');
    assert.equal(startA.mission.id, startB.mission.id);
    assert.equal(startA.missionCount, 5);

    // Alice solves everything; Bob solves nothing.
    let mission = startA.mission;
    for (let i = 0; i < startA.missionCount; i++) {
      const res = await solve(a.client, mission);
      assert.ok(res, `no response solving ${mission.id}`);
      assert.equal(res.advanced, true, `alice failed to solve ${mission.id}`);
      assert.equal(res.solved, i + 1);
      mission = res.mission;
      // Bob is told when Alice pulls ahead.
      const prog = await b.client.wait('opponent_progress');
      assert.equal(prog.solved, i + 1);
    }

    const overA = await a.client.wait('race_over');
    const overB = await b.client.wait('race_over');

    assert.equal(overA.outcome, 'win');
    assert.equal(overB.outcome, 'loss');
    assert.equal(overA.solved, 5);
    assert.equal(overB.solved, 0);
    assert.equal(overA.eloBefore, START_ELO);
    assert.equal(overA.eloAfter, 1216);
    assert.equal(overB.eloAfter, 1184);
    assert.equal(overA.eloDelta, 16);
    assert.equal(overB.eloDelta, -16);

    // ...and it is persisted, not just announced.
    const board = await (await fetch(ctx.base + '/api/leaderboard')).json();
    assert.deepEqual(
      board.leaderboard.map((r) => [r.username, r.elo, r.wins, r.losses]),
      [['alice', 1216, 1, 0], ['bob', 1184, 0, 1]]
    );

    const hist = await (
      await fetch(ctx.base + '/api/history', { headers: { authorization: `Bearer ${a.token}` } })
    ).json();
    assert.equal(hist.history.length, 1);
    assert.deepEqual(
      { ...hist.history[0], at: undefined },
      { opponent: 'bob', solved: 5, opponentSolved: 0, eloDelta: 16, outcome: 'win', at: undefined }
    );

    a.client.close();
    b.client.close();
  });
});

test('the server verifies missions - a client cannot claim a win', async () => {
  await withServer(async (ctx) => {
    const a = await signUp(ctx, 'alice');
    const b = await signUp(ctx, 'bob');
    a.client.send({ type: 'queue' });
    await a.client.wait('queued');
    b.client.send({ type: 'queue' });
    const start = await a.client.wait('race_start');
    await b.client.wait('race_start');

    // Forged progress messages are simply unknown message types.
    a.client.send({ type: 'race_over', outcome: 'win' });
    const err = await a.client.wait('error');
    assert.match(err.error, /unknown message/);

    // A wrong command does not advance the mission.
    a.client.send({ type: 'cmd', line: 'echo definitely-not-the-answer' });
    const out = await a.client.wait('output');
    assert.equal(out.advanced, false);
    assert.equal(out.solved, 0);
    assert.equal(out.mission.id, start.mission.id, 'still on the same mission');

    a.client.close();
    b.client.close();
  });
});

test('disconnecting mid-race forfeits it', async () => {
  await withServer(async (ctx) => {
    const a = await signUp(ctx, 'alice');
    const b = await signUp(ctx, 'bob');
    a.client.send({ type: 'queue' });
    await a.client.wait('queued');
    b.client.send({ type: 'queue' });
    await a.client.wait('race_start');
    await b.client.wait('race_start');

    b.client.close();
    const over = await a.client.wait('race_over');
    assert.equal(over.reason, 'forfeit');
    assert.equal(over.outcome, 'win');
    assert.ok(over.eloDelta > 0);
    a.client.close();
  });
});

test('leaving a live race forfeits it to the opponent', async () => {
  await withServer(async (ctx) => {
    const a = await signUp(ctx, 'alice');
    const b = await signUp(ctx, 'bob');
    a.client.send({ type: 'queue' });
    await a.client.wait('queued');
    b.client.send({ type: 'queue' });
    await a.client.wait('race_start');
    await b.client.wait('race_start');

    b.client.send({ type: 'leave' });

    const overA = await a.client.wait('race_over');
    const overB = await b.client.wait('race_over');
    assert.equal(overA.outcome, 'win');
    assert.equal(overB.outcome, 'loss');
    assert.equal(overA.reason, 'forfeit');
    assert.equal(overA.eloAfter, 1216);
    assert.equal(overB.eloAfter, 1184);

    a.client.close();
    b.client.close();
  });
});

test('queueing twice is rejected and cancelling works', async () => {
  await withServer(async (ctx) => {
    const a = await signUp(ctx, 'alice');
    a.client.send({ type: 'queue' });
    await a.client.wait('queued');
    a.client.send({ type: 'queue' });
    assert.match((await a.client.wait('error')).error, /already queued/);

    a.client.send({ type: 'cancel_queue' });
    await a.client.wait('queue_cancelled');

    // A command outside any game is refused.
    a.client.send({ type: 'cmd', line: 'ls' });
    assert.match((await a.client.wait('error')).error, /not in a game/);
    a.client.close();
  });
});

test('a second tab closing does not evict the live session', async () => {
  await withServer(async (ctx) => {
    const a = await signUp(ctx, 'alice');
    const b = await signUp(ctx, 'bob');

    a.client.send({ type: 'queue' });
    await a.client.wait('queued');

    // Alice opens a second tab on the same account, then closes it.
    const dupe = new Client(ctx.port, a.token, 'alice-tab2');
    await dupe.open();
    await dupe.wait('hello');
    dupe.close();
    await new Promise((r) => setTimeout(r, 100));

    // Her original session must still be queued and still matchable.
    b.client.send({ type: 'queue' });
    const start = await a.client.wait('race_start', 3000);
    assert.equal(start.opponent.username, 'bob');

    // Likewise, the duplicate closing mid-race must not forfeit it.
    const dupe2 = new Client(ctx.port, a.token, 'alice-tab3');
    await dupe2.open();
    await dupe2.wait('hello');
    dupe2.close();
    await new Promise((r) => setTimeout(r, 100));

    a.client.send({ type: 'cmd', line: 'whoami' });
    const out = await a.client.wait('output', 2000);
    assert.match(out.out, /op/, 'the race is still live');

    a.client.close();
    b.client.close();
  });
});

// ------------------------------------------------------- editor + completion

test('vim over the wire: the server owns the write', async () => {
  await withServer(async (ctx) => {
    const a = await signUp(ctx, 'alice');
    const b = await signUp(ctx, 'bob');
    a.client.send({ type: 'queue' });
    await a.client.wait('queued');
    b.client.send({ type: 'queue' });
    await a.client.wait('race_start');
    await b.client.wait('race_start');

    // Opening a file hands back its contents to edit.
    a.client.send({ type: 'cmd', line: 'vim /home/op/scratch.txt' });
    const opened = await a.client.wait('output');
    assert.ok(opened.editor, 'the client is told to open an editor');
    assert.equal(opened.editor.path, '/home/op/scratch.txt');
    assert.equal(opened.editor.content, '');

    // Saving it persists server-side.
    a.client.send({
      type: 'editor_save',
      path: '/home/op/scratch.txt',
      content: 'written in vim\n',
    });
    const saved = await a.client.wait('editor_saved');
    assert.equal(saved.error, undefined);
    assert.equal(saved.bytes, 15);

    a.client.send({ type: 'cmd', line: 'cat /home/op/scratch.txt' });
    assert.match((await a.client.wait('output')).out, /written in vim/);

    // A write the player has no permission for is refused by the server.
    a.client.send({ type: 'editor_save', path: '/etc/passwd', content: 'pwned\n' });
    const refused = await a.client.wait('editor_saved');
    assert.match(refused.error, /Permission denied/);

    // ...and sudo vim is honoured.
    a.client.send({ type: 'editor_save', path: '/etc/passwd', content: 'ok\n', sudo: true });
    assert.equal((await a.client.wait('editor_saved')).error, undefined);

    a.client.close();
    b.client.close();
  });
});

test('saving in vim can itself solve a mission', async () => {
  await withServer(async (ctx) => {
    const a = await signUp(ctx, 'alice');
    const b = await signUp(ctx, 'bob');
    a.client.send({ type: 'queue' });
    await a.client.wait('queued');
    b.client.send({ type: 'queue' });
    const start = await a.client.wait('race_start');
    await b.client.wait('race_start');

    // Drive whatever mission came up to a state vim can finish, then use vim
    // for the final write on the missions that are a file-content check.
    const writable = {
      recon: ['/home/op/recon.txt', '/home/op\n'],
      'count-attackers': ['/home/op/attacker.txt', '45.9.14.7\n'],
    };
    const target = writable[start.mission.id];
    if (!target) return; // this seed drew a mission vim cannot finish alone

    a.client.send({ type: 'editor_save', path: target[0], content: target[1] });
    const saved = await a.client.wait('editor_saved');
    assert.equal(saved.advanced, true, 'the save completed the mission');
    assert.equal(saved.solved, 1);

    a.client.close();
    b.client.close();
  });
});

test('tab completion is answered from the server filesystem', async () => {
  await withServer(async (ctx) => {
    const a = await signUp(ctx, 'alice');
    const b = await signUp(ctx, 'bob');
    a.client.send({ type: 'queue' });
    await a.client.wait('queued');
    b.client.send({ type: 'queue' });
    await a.client.wait('race_start');
    await b.client.wait('race_start');

    a.client.send({ type: 'complete', line: 'cat /var/log/au' });
    const one = await a.client.wait('completion');
    assert.equal(one.line, 'cat /var/log/auth.log ');

    a.client.send({ type: 'complete', line: 'ch' });
    const many = await a.client.wait('completion');
    assert.deepEqual(many.matches, ['chmod', 'chown']);

    a.client.close();
    b.client.close();
  });
});

test('chaos rooms support vim and completion on the shared filesystem', async () => {
  await withServer(async (ctx) => {
    const a = await signUp(ctx, 'alice');
    const b = await signUp(ctx, 'bob');

    a.client.send({ type: 'chaos_create' });
    const joined = await a.client.wait('chaos_joined');
    b.client.send({ type: 'chaos_join', code: joined.code });
    await b.client.wait('chaos_joined');
    await a.client.wait('chaos_join');

    // Alice writes a file with vim; it counts toward her score.
    a.client.send({ type: 'editor_save', path: '/srv/shared/notes', content: 'hi\n' });
    const saved = await a.client.wait('editor_saved');
    assert.equal(saved.bytes, 3);
    const scores = (await a.client.wait('chaos_scores')).scores;
    assert.equal(scores.find((s) => s.username === 'alice').files, 1);

    // Bob sees the write in his feed and can still delete it.
    const feed = await b.client.wait('chaos_feed');
    assert.match(feed.line, /:w \/srv\/shared\/notes/);
    const gone = await chaosRun(b.client, 'rm /srv/shared/notes');
    assert.equal(gone.out.code, 0);
    assert.equal(gone.scores.find((s) => s.username === 'alice').files, 0);

    // Completion sees the shared tree, including bob's own additions.
    await chaosRun(b.client, 'echo x > /srv/shared/bobfile');
    b.client.send({ type: 'complete', line: 'cat /srv/shared/bobf' });
    assert.equal((await b.client.wait('completion')).line, 'cat /srv/shared/bobfile ');

    a.client.close();
    b.client.close();
  });
});

// -------------------------------------------------------------- chaos rooms

test('chaos room: shared filesystem, mutual sabotage, scored by ownership', async () => {
  await withServer(async (ctx) => {
    const a = await signUp(ctx, 'alice');
    const b = await signUp(ctx, 'bob');

    a.client.send({ type: 'chaos_create' });
    const joined = await a.client.wait('chaos_joined');
    assert.match(joined.code, /^[A-Z2-9]{4}$/);
    assert.equal(joined.sharedPath, '/srv/shared');

    b.client.send({ type: 'chaos_join', code: joined.code });
    await b.client.wait('chaos_joined');
    await a.client.wait('chaos_join'); // alice is told bob arrived

    // Alice plants two files in the shared folder.
    await chaosRun(a.client, 'echo mine > /srv/shared/a1');
    const planted = await chaosRun(a.client, 'echo mine > /srv/shared/a2');
    assert.deepEqual(planted.scores.find((s) => s.username === 'alice'), {
      username: 'alice',
      files: 2,
    });

    // Bob sees Alice's commands in his feed - sabotage is visible, not silent.
    const feed = await b.client.wait('chaos_feed');
    assert.equal(feed.username, 'alice');
    assert.match(feed.line, /echo mine/);

    // Bob deletes one of Alice's files, then plants one of his own.
    const removed = await chaosRun(b.client, 'rm /srv/shared/a1');
    assert.equal(removed.out.code, 0, 'the shared dir is world-writable');
    const planted2 = await chaosRun(b.client, 'echo mine-now > /srv/shared/b1');
    assert.deepEqual(tally(planted2.scores), [['alice', 1], ['bob', 1]]);

    // Bob cannot escalate: sudo is off in chaos rooms.
    const sudo = await chaosRun(b.client, 'sudo chown bob /srv/shared/a2');
    assert.match(sudo.out.out, /not in the sudoers file/);

    // ...nor chown a file he does not own, so stealing ownership is out.
    const steal = await chaosRun(b.client, 'chown bob /srv/shared/a2');
    assert.match(steal.out.out, /not permitted/);
    assert.deepEqual(tally(steal.scores), [['alice', 1], ['bob', 1]]);

    // Both players are looking at the very same filesystem.
    const ls = await chaosRun(a.client, 'ls /srv/shared');
    assert.match(ls.out.out, /b1/, "alice sees bob's file");
    assert.doesNotMatch(ls.out.out, /a1/, 'the file bob deleted is gone for alice too');

    a.client.close();
    b.client.close();
  });
});

test('chaos rooms end with a winner and reject bad codes', async () => {
  await withServer(
    async (ctx) => {
      const a = await signUp(ctx, 'alice');
      a.client.send({ type: 'chaos_join', code: 'ZZZZ' });
      assert.match((await a.client.wait('error')).error, /no such room/);

      a.client.send({ type: 'chaos_create' });
      await a.client.wait('chaos_joined');
      a.client.send({ type: 'cmd', line: 'echo x > /srv/shared/win' });
      await a.client.wait('output');

      const over = await a.client.wait('chaos_over', 4000);
      assert.equal(over.winner, 'alice');
      assert.equal(over.scores[0].files, 1);
      a.client.close();
    },
    { chaosOpts: { timeLimitMs: 300 } }
  );
});
