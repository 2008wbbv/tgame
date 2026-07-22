import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Shell } from '../engine/shell.js';
import { MISSIONS, missionSet, byId } from '../engine/missions.js';
import { VFS, dir, file } from '../engine/vfs.js';
import { SOLUTIONS } from './solutions.js';

function shellFor(mission) {
  const w = mission.setup();
  return new Shell({ vfs: w.vfs, procs: w.procs, cwd: w.cwd, user: 'op' });
}

test('every mission has a solution and starts unsolved', () => {
  for (const m of MISSIONS) {
    assert.ok(SOLUTIONS[m.id], `mission ${m.id} has no solution in the test`);
    assert.equal(m.check(shellFor(m)), false, `mission ${m.id} is already solved at setup`);
  }
});

test('each mission is solved by its intended commands', () => {
  for (const m of MISSIONS) {
    const sh = shellFor(m);
    for (const cmd of SOLUTIONS[m.id]) {
      const r = sh.run(cmd);
      assert.equal(r.code, 0, `${m.id}: "${cmd}" failed: ${r.out}`);
    }
    assert.equal(m.check(sh), true, `mission ${m.id} not solved by its solution`);
  }
});

test('alternate routes to the same state also count', () => {
  // read-the-log via a pipe rather than grep-on-file
  const m = byId('read-the-log');
  const sh = shellFor(m);
  sh.run('cat /var/log/auth.log | grep Failed > /home/op/failed.txt');
  assert.equal(m.check(sh), true);

  // organise via cd + relative paths
  const m2 = byId('organise');
  const sh2 = shellFor(m2);
  sh2.run('mkdir -p /srv/archive');
  sh2.run('cd /tmp');
  sh2.run('mv nginx.log ../srv/archive');
  sh2.run('mv cron.log /srv/archive/cron.log');
  assert.equal(m2.check(sh2), true);
});

test('permissions are enforced', () => {
  const w = MISSIONS[0].setup();
  const sh = new Shell({ vfs: w.vfs, procs: w.procs, cwd: w.cwd, user: 'op' });

  // op may not write into root-owned /etc (mode 755)
  assert.match(sh.run('echo hi > /etc/hosts').out, /Permission denied/);
  assert.equal(sh.run('rm /var/log/auth.log').code, 1);
  // ...but sudo may
  assert.equal(sh.run('sudo echo hi > /etc/hosts').code, 0);
  assert.equal(sh.vfs.get('/etc/hosts').content, 'hi\n');

  // non-root cannot chown
  assert.match(sh.run('chown op /etc/passwd').out, /not permitted/);
});

test('shell basics: pipes, quotes, append, history, errors', () => {
  const w = MISSIONS[0].setup();
  const sh = new Shell({ vfs: w.vfs, procs: w.procs, cwd: w.cwd, user: 'op' });

  assert.equal(sh.run('echo hello world').out, 'hello world\n');
  assert.equal(sh.run('echo "a b"  c').out, 'a b c\n');
  assert.equal(sh.run('pwd').out, '/home/op\n');

  sh.run('echo one > f.txt');
  sh.run('echo two >> f.txt');
  assert.equal(sh.run('cat f.txt').out, 'one\ntwo\n');
  assert.equal(sh.run('cat f.txt | grep two').out, 'two\n');
  assert.equal(sh.run('grep -n one f.txt').out, '1:one\n');
  assert.equal(sh.run('grep -v one f.txt').out, 'two\n');

  assert.equal(sh.run('nope').code, 127);
  assert.match(sh.run('cat missing.txt').out, /No such file/);
  assert.match(sh.run('cd /nowhere').out, /No such file/);
  assert.ok(sh.history.length > 0);

  // cd/.. and ~ resolution
  sh.run('cd /var/log');
  assert.equal(sh.run('pwd').out, '/var/log\n');
  sh.run('cd ..');
  assert.equal(sh.run('pwd').out, '/var\n');
  sh.run('cd ~');
  assert.equal(sh.run('pwd').out, '/home/op\n');
});

test('ls -l renders mode, owner and name', () => {
  const vfs = new VFS(dir('root', 0o755, {
    home: dir('root', 0o755, {
      op: dir('op', 0o755, { 'a.txt': file('hello\n', 'op', 0o644) }),
    }),
  }));
  const sh = new Shell({ vfs, cwd: '/home/op', user: 'op' });
  assert.match(sh.run('ls -l').out, /^-rw-r--r-- op\s+6 a\.txt$/m);
  sh.run('chmod 750 a.txt');
  assert.match(sh.run('ls -l').out, /^-rwxr-x--- op/m);
});

test('kill respects ownership and ps lists processes', () => {
  const m = byId('kill-the-miner');
  const sh = shellFor(m);
  assert.match(sh.run('ps').out, /xmrig/);
  // the miner runs as `nobody`, so op alone cannot kill it
  assert.match(sh.run('kill 4471').out, /not permitted/);
  assert.match(sh.run('kill 99999').out, /No such process/);
  assert.equal(m.check(sh), false);
  assert.equal(sh.run('sudo kill 4471').code, 0);
  assert.equal(m.check(sh), true);
});

test('missionSet is deterministic per seed and distinct across seeds', () => {
  assert.deepEqual(missionSet(42, 5), missionSet(42, 5));
  assert.equal(new Set(missionSet(42, 5)).size, 5, 'no duplicate missions in a set');
  assert.notDeepEqual(missionSet(42, 5), missionSet(7, 5));
  for (const id of missionSet(123, 5)) assert.ok(byId(id), `${id} is a real mission`);
});

test('VFS survives a JSON round trip', () => {
  const m = byId('kill-the-miner');
  const sh = shellFor(m);
  sh.run('echo marker > /home/op/x.txt');
  const revived = VFS.fromJSON(JSON.parse(JSON.stringify(sh.vfs.toJSON())));
  assert.equal(revived.get('/home/op/x.txt').content, 'marker\n');
  assert.equal(revived.get('/var/log/auth.log').owner, 'root');
});
