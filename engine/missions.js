// Missions are verified against resulting VFS/process state, never against the
// literal command typed - so any legitimate route to the goal counts.

import { VFS, DIR, FILE, dir, file } from './vfs.js';

const AUTH_LOG = `Mar 11 03:12:01 web01 sshd[2211]: Accepted password for op from 10.0.0.4
Mar 11 03:14:22 web01 sshd[2213]: Failed password for invalid user admin from 45.9.14.7
Mar 11 03:14:25 web01 sshd[2213]: Failed password for invalid user admin from 45.9.14.7
Mar 11 03:14:31 web01 sshd[2215]: Failed password for invalid user root from 45.9.14.7
Mar 11 03:19:02 web01 sudo: op : TTY=pts/0 ; COMMAND=/usr/bin/systemctl restart nginx
Mar 11 03:41:11 web01 sshd[2290]: Failed password for invalid user postgres from 91.2.3.9
`;

/** Fresh base world. Every mission starts from this and layers its own state. */
function baseWorld() {
  const root = dir('root', 0o755, {
    home: dir('root', 0o755, {
      op: dir('op', 0o755, {
        'notes.txt': file('remember: check /var/log/auth.log after the incident\n', 'op'),
      }),
    }),
    etc: dir('root', 0o755, {
      passwd: file('root:x:0:0:root:/root:/bin/bash\nop:x:1000:1000:op:/home/op:/bin/bash\n', 'root'),
      hosts: file('127.0.0.1 localhost\n10.0.0.4 web01\n', 'root'),
    }),
    var: dir('root', 0o755, {
      log: dir('root', 0o755, {
        'auth.log': file(AUTH_LOG, 'root', 0o644),
        'syslog': file('Mar 11 03:00:01 web01 CRON[1010]: job finished\n', 'root'),
      }),
      www: dir('root', 0o755, {}),
    }),
    srv: dir('root', 0o777, {}),
    tmp: dir('root', 0o777, {}),
  });
  return { vfs: new VFS(root), procs: [], cwd: '/home/op' };
}

/** Convenience: walk to a dir and drop nodes into it. */
function put(vfs, path, entries) {
  const node = vfs.get(path);
  Object.assign(node.children, entries);
  return node;
}

export const MISSIONS = [
  {
    id: 'recon',
    title: 'Recon',
    brief: 'You just landed on web01. Prove you can look around: leave a file /home/op/recon.txt containing the output of `pwd`.',
    hint: 'pwd > recon.txt',
    setup: baseWorld,
    check: (sh) => {
      const n = sh.vfs.get('/home/op/recon.txt');
      return !!n && n.type === FILE && n.content.trim() === '/home/op';
    },
  },

  {
    id: 'read-the-log',
    title: 'Read the log',
    brief: 'Someone is brute-forcing SSH. Save every line of /var/log/auth.log that mentions a failed password into /home/op/failed.txt.',
    hint: 'grep "Failed password" /var/log/auth.log > ~/failed.txt',
    setup: baseWorld,
    check: (sh) => {
      const n = sh.vfs.get('/home/op/failed.txt');
      if (!n || n.type !== FILE) return false;
      const ls = n.content.trim().split('\n').filter(Boolean);
      return ls.length === 4 && ls.every((l) => l.includes('Failed password'));
    },
  },

  {
    id: 'count-attackers',
    title: 'Name the attacker',
    brief: 'The noisiest source IP hit us four times. Write just that IP address (nothing else) into /home/op/attacker.txt.',
    hint: 'The IP appearing most often in the failed-password lines is 45.9.14.7.',
    setup: baseWorld,
    check: (sh) => {
      const n = sh.vfs.get('/home/op/attacker.txt');
      return !!n && n.type === FILE && n.content.trim() === '45.9.14.7';
    },
  },

  {
    id: 'fix-perms',
    title: 'Lock down the key',
    brief: 'SSH refuses to use /home/op/.ssh/id_rsa because it is world-readable. Set its permissions to exactly 600.',
    hint: 'chmod 600 ~/.ssh/id_rsa',
    setup() {
      const w = baseWorld();
      put(w.vfs, '/home/op', {
        '.ssh': dir('op', 0o755, {
          id_rsa: file('-----BEGIN OPENSSH PRIVATE KEY-----\n', 'op', 0o644),
        }),
      });
      return w;
    },
    check: (sh) => {
      const n = sh.vfs.get('/home/op/.ssh/id_rsa');
      return !!n && (n.mode & 0o777) === 0o600;
    },
  },

  {
    id: 'make-it-run',
    title: 'Make it executable',
    brief: 'The deploy script /srv/deploy.sh cannot run. Give it the execute bit for everyone, keeping it readable.',
    hint: 'chmod +x /srv/deploy.sh',
    setup() {
      const w = baseWorld();
      put(w.vfs, '/srv', {
        'deploy.sh': file('#!/bin/sh\necho deploying\n', 'op', 0o644),
      });
      return w;
    },
    check: (sh) => {
      const n = sh.vfs.get('/srv/deploy.sh');
      return !!n && (n.mode & 0o111) === 0o111 && (n.mode & 0o400) !== 0;
    },
  },

  {
    id: 'organise',
    title: 'Tidy the drop zone',
    brief: 'Move every .log file in /tmp into a new directory /srv/archive. Leave the non-log files where they are.',
    hint: 'mkdir /srv/archive  then  mv /tmp/nginx.log /tmp/cron.log /srv/archive',
    setup() {
      const w = baseWorld();
      put(w.vfs, '/tmp', {
        'nginx.log': file('GET / 200\n', 'op'),
        'cron.log': file('job ok\n', 'op'),
        'readme.txt': file('leave me alone\n', 'op'),
      });
      return w;
    },
    check: (sh) => {
      const archive = sh.vfs.get('/srv/archive');
      const tmp = sh.vfs.get('/tmp');
      if (!archive || archive.type !== DIR) return false;
      const has = (n, f) => n.children[f] && n.children[f].type === FILE;
      return (
        has(archive, 'nginx.log') &&
        has(archive, 'cron.log') &&
        !tmp.children['nginx.log'] &&
        !tmp.children['cron.log'] &&
        has(tmp, 'readme.txt')
      );
    },
  },

  {
    id: 'free-the-disk',
    title: 'Free the disk',
    brief: 'The disk is full: /var/log/huge.log is a runaway 50MB file. Delete it - but do not touch auth.log or syslog.',
    hint: 'sudo rm /var/log/huge.log',
    setup() {
      const w = baseWorld();
      put(w.vfs, '/var/log', {
        'huge.log': file('x'.repeat(50000), 'root'),
      });
      return w;
    },
    check: (sh) =>
      !sh.vfs.exists('/var/log/huge.log') &&
      sh.vfs.exists('/var/log/auth.log') &&
      sh.vfs.exists('/var/log/syslog'),
  },

  {
    id: 'kill-the-miner',
    title: 'Kill the miner',
    brief: 'Something is eating the CPU. Find the crypto-miner process in the process table and kill it. Leave nginx and sshd running.',
    hint: 'ps  -> find the xmrig process -> sudo kill <pid>',
    setup() {
      const w = baseWorld();
      w.procs = [
        { pid: 1, user: 'root', cpu: 0.0, cmd: '/sbin/init' },
        { pid: 812, user: 'root', cpu: 0.3, cmd: 'nginx: master process' },
        { pid: 913, user: 'root', cpu: 0.1, cmd: '/usr/sbin/sshd -D' },
        { pid: 4471, user: 'nobody', cpu: 99.4, cmd: './xmrig --donate-level 1 -o pool.evil.tld' },
      ];
      return w;
    },
    check: (sh) =>
      !sh.procs.some((p) => p.cmd.includes('xmrig')) &&
      sh.procs.some((p) => p.cmd.includes('nginx')) &&
      sh.procs.some((p) => p.cmd.includes('sshd')),
  },

  {
    id: 'hand-over-webroot',
    title: 'Hand over the web root',
    brief: 'The web root /var/www/html exists but is owned by root, so the deploy user cannot write. Make op the owner of it and everything inside.',
    hint: 'sudo chown -R op /var/www/html',
    setup() {
      const w = baseWorld();
      put(w.vfs, '/var/www', {
        html: dir('root', 0o755, {
          'index.html': file('<h1>hello</h1>\n', 'root'),
          assets: dir('root', 0o755, { 'app.css': file('body{}\n', 'root') }),
        }),
      });
      return w;
    },
    check: (sh) => {
      const root = sh.vfs.get('/var/www/html');
      if (!root) return false;
      return [...sh.vfs.walk('/var/www/html', root)].every(([, n]) => n.owner === 'op');
    },
  },

  {
    id: 'audit-suid',
    title: 'Audit the stragglers',
    brief: 'Find every file under /srv still owned by root and list their paths into /home/op/audit.txt (one absolute path per line, any order).',
    hint: 'find /srv -type f -user root > ~/audit.txt',
    setup() {
      const w = baseWorld();
      put(w.vfs, '/srv', {
        app: dir('op', 0o755, {
          'server.js': file('listen(80)\n', 'op'),
          'secret.key': file('hunter2\n', 'root'),
        }),
        'backup.tar': file('...\n', 'root'),
        'notes.md': file('ok\n', 'op'),
      });
      return w;
    },
    check: (sh) => {
      const n = sh.vfs.get('/home/op/audit.txt');
      if (!n || n.type !== FILE) return false;
      const got = new Set(n.content.trim().split('\n').map((s) => s.trim()).filter(Boolean));
      const want = new Set(['/srv/app/secret.key', '/srv/backup.tar']);
      return got.size === want.size && [...want].every((p) => got.has(p));
    },
  },

  {
    id: 'restore-service',
    title: 'Restore the service',
    brief: 'Final call. nginx needs /etc/nginx/nginx.conf to exist and contain the line `listen 443;`, the config dir must be owned by root, and the stray /tmp/nginx.pid lock must be gone.',
    hint: 'sudo mkdir -p /etc/nginx  then  sudo echo "listen 443;" > /etc/nginx/nginx.conf  then  sudo rm /tmp/nginx.pid',
    setup() {
      const w = baseWorld();
      put(w.vfs, '/tmp', { 'nginx.pid': file('4471\n', 'root', 0o666) });
      return w;
    },
    check: (sh) => {
      const conf = sh.vfs.get('/etc/nginx/nginx.conf');
      const confDir = sh.vfs.get('/etc/nginx');
      return (
        !!conf &&
        conf.type === FILE &&
        conf.content.includes('listen 443;') &&
        !!confDir &&
        confDir.owner === 'root' &&
        !sh.vfs.exists('/tmp/nginx.pid')
      );
    },
  },
];

export const byId = (id) => MISSIONS.find((m) => m.id === id);

/** Deterministic mission set for a race, given a seed both players share. */
export function missionSet(seed, count = 5) {
  const ids = MISSIONS.map((m) => m.id);
  // xorshift keeps client and server picking identically from the same seed.
  let x = seed || 1;
  const rand = () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5; x >>>= 0;
    return x / 0xffffffff;
  };
  const pool = ids.slice();
  const out = [];
  while (out.length < count && pool.length) {
    out.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
  }
  return out;
}
