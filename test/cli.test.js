import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createServer } from '../server/index.js';
import { openDb } from '../server/db.js';

const CLI = fileURLToPath(new URL('../bin/tgame.js', import.meta.url));
const strip = (s) => s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');

/**
 * Runs the CLI, feeding keystrokes with a pause between them so the program
 * can react. Returns everything it printed, with ANSI codes stripped.
 */
function drive(args, keys, { timeout = 8000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));

    const done = (code) => {
      clearTimeout(timer);
      // Strip ANSI escapes so assertions match plain text.
      resolve({ out: out.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, ''), code });
    };
    child.on('exit', done);
    const timer = setTimeout(() => {
      child.kill();
      done(null);
    }, timeout);

    (async () => {
      for (const k of keys) {
        await new Promise((r) => setTimeout(r, 90));
        if (!child.killed) child.stdin.write(k);
      }
    })();
  });
}

test('cli prints usage', async () => {
  const { out } = await drive(['--help'], []);
  assert.match(out, /tgame solo/);
  assert.match(out, /tgame chaos/);
});

test('cli solo runs commands and solves a mission', async () => {
  const { out } = await drive(
    ['solo'],
    ['ls\r', 'pwd > recon.txt\r', 'quit\r']
  );
  assert.match(out, /\[1\/11\] Recon/, 'shows the first mission');
  assert.match(out, /notes\.txt/, 'ls output is printed');
  assert.match(out, /solved: Recon/, 'the mission completes');
  assert.match(out, /\[2\/11\]/, 'and it advances to the next one');
});

test('cli solo supports hint and tab completion', async () => {
  const { out } = await drive(['solo'], ['hint\r', 'cat not\t\r', 'quit\r']);
  assert.match(out, /hint: pwd > recon\.txt/);
  // Tab expanded `not` to notes.txt, so cat printed the file.
  assert.match(out, /check \/var\/log\/auth\.log/);
});

test('cli solo runs vim: edit, save and quit', async () => {
  const { out, code } = await drive(
    ['solo'],
    [
      'vim /home/op/hello.txt\r', // open the editor
      'i',                        // insert mode
      'hello from vim',
      '\x1b',                     // Escape
      ':wq\r',                    // write and quit
      'cat /home/op/hello.txt\r',
      'quit\r',
    ]
  );
  // Exiting cleanly proves the editor actually handed control back, rather
  // than the test merely timing out with text on screen.
  assert.equal(code, 0, 'the CLI exited on `quit`');
  assert.match(out, /-- INSERT --/, 'insert mode is shown');
  assert.match(out, /hello from vim/, 'the edit was saved and read back');
});

test('cli solo vim can solve a mission by writing a file', async () => {
  const { out, code } = await drive(
    ['solo'],
    ['vim recon.txt\r', 'i', '/home/op', '\x1b', ':wq\r', 'quit\r']
  );
  assert.equal(code, 0);
  assert.match(out, /solved: Recon/, 'writing the right content in vim solves it');
});

test('cli solo vim refuses to quit a dirty buffer', async () => {
  const { out, code } = await drive(
    ['solo'],
    ['vim /home/op/x.txt\r', 'iabc', '\x1b', ':q\r', ':q!\r', 'quit\r']
  );
  assert.equal(code, 0, ':q! forced the exit');
  assert.match(out, /No write since last change/);
});

// ---------------------------------------------------------------- online cli

/** A CLI child process whose output can be awaited by pattern. */
class CliProcess {
  constructor(args) {
    this.out = '';
    this.waiters = [];
    this.exitCode = undefined;
    this.child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const onData = (d) => {
      this.out += strip(String(d));
      for (const w of this.waiters.slice()) {
        if (w.re.test(this.out)) {
          this.waiters.splice(this.waiters.indexOf(w), 1);
          w.resolve(this.out);
        }
      }
    };
    this.child.stdout.on('data', onData);
    this.child.stderr.on('data', onData);
    this.child.on('exit', (c) => (this.exitCode = c));
  }

  until(re, timeout = 10000) {
    if (re.test(this.out)) return Promise.resolve(this.out);
    return new Promise((resolve, reject) => {
      const w = { re, resolve };
      this.waiters.push(w);
      setTimeout(() => {
        if (this.waiters.includes(w)) {
          this.waiters.splice(this.waiters.indexOf(w), 1);
          reject(new Error(`timed out waiting for ${re}\n--- got ---\n${this.out}`));
        }
      }, timeout).unref?.();
    });
  }

  type(s) {
    this.child.stdin.write(s);
  }

  exited(timeout = 5000) {
    if (this.exitCode !== undefined) return Promise.resolve(this.exitCode);
    return new Promise((resolve) => {
      this.child.on('exit', resolve);
      setTimeout(() => resolve(this.exitCode), timeout).unref?.();
    });
  }

  kill() {
    if (this.exitCode === undefined) this.child.kill();
  }
}

async function withLiveServer(fn) {
  const db = openDb(':memory:');
  const { server, wss } = createServer({
    db,
    raceOpts: { countdownMs: 0, timeLimitMs: 60_000 },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(url);
  } finally {
    for (const c of wss.clients) c.terminate();
    await new Promise((r) => server.close(r));
  }
}

test('cli plays a ranked race against a live server', async () => {
  await withLiveServer(async (url) => {
    const alice = new CliProcess(['play', '--server', url, '--user', 'alice', '--pass', 'hunter22']);
    const bob = new CliProcess(['play', '--server', url, '--user', 'bob', '--pass', 'hunter22']);

    try {
      // Unknown accounts are registered on the spot.
      await alice.until(/registered a new account/);

      // Both get matched and see the same opening mission. (Whichever player
      // queues second is matched instantly, so neither is guaranteed to see
      // the "searching" message.)
      await alice.until(/matched vs bob/);
      await bob.until(/matched vs alice/);
      await alice.until(/\[1\/5\]/);

      // The shell works over the socket.
      alice.type('whoami\r');
      await alice.until(/\bop\b/);

      alice.type('cat /var/log/auth.log\r');
      await alice.until(/Failed password/);

      // Tab completion is answered by the server. Wait for the completion to
      // land before pressing Enter - it is a round trip, not a local expansion.
      bob.type('cat /var/log/au\t');
      await bob.until(/cat \/var\/log\/auth\.log/);
      bob.type('\r');
      await bob.until(/Failed password/);

      // Bob walks out, which forfeits and settles elo for both.
      bob.type('quit\r');
      await alice.until(/== WIN \(forfeit\) ==/);
      await alice.until(/elo 1200 -> 1216 \(\+16\)/);

      assert.equal(await alice.exited(), 0, 'alice exits once the race is over');
    } finally {
      alice.kill();
      bob.kill();
    }
  });
});

test('cli joins a chaos room and shares the filesystem', async () => {
  await withLiveServer(async (url) => {
    const alice = new CliProcess(['chaos', '--server', url, '--user', 'alice', '--pass', 'hunter22']);
    let bob;
    try {
      const joined = await alice.until(/joined room [A-Z2-9]{4}/);
      const code = /joined room ([A-Z2-9]{4})/.exec(joined)[1];

      bob = new CliProcess(['chaos', code, '--server', url, '--user', 'bob', '--pass', 'hunter22']);
      await bob.until(new RegExp(`joined room ${code}`));
      await alice.until(/bob joined/);

      // Alice writes a file with vim, over the wire. The editor only opens once
      // the server has sent the buffer back, so wait for it to appear.
      alice.type('vim /srv/shared/plan\r');
      await alice.until(/"\/srv\/shared\/plan"/);
      alice.type('i');
      await alice.until(/-- INSERT --/);
      alice.type('take the box');
      alice.type('\x1b');
      alice.type(':wq\r');

      // Bob sees her write land, and can destroy it.
      await bob.until(/\[alice\] :w \/srv\/shared\/plan/);
      bob.type('cat /srv/shared/plan\r');
      await bob.until(/take the box/);

      bob.type('rm /srv/shared/plan\r');
      await alice.until(/\[bob\] rm \/srv\/shared\/plan/);

      alice.type('cat /srv/shared/plan\r');
      await alice.until(/No such file or directory/);
    } finally {
      alice.kill();
      bob?.kill();
    }
  });
});
