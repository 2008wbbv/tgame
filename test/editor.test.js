import { test } from 'node:test';
import assert from 'node:assert/strict';

import { VimEditor, NORMAL, INSERT, COMMAND } from '../engine/editor.js';
import { complete } from '../engine/complete.js';
import { Shell, COMMAND_NAMES } from '../engine/shell.js';
import { MISSIONS } from '../engine/missions.js';

/** Feeds a string of single-character keys, plus named keys via <...>. */
function keys(ed, s) {
  for (const k of s.match(/<[^>]+>|[\s\S]/g) || []) {
    ed.handleKey(k.startsWith('<') ? k.slice(1, -1) : k);
  }
  return ed;
}

const newShell = () => {
  const w = MISSIONS[0].setup();
  return new Shell({ vfs: w.vfs, procs: w.procs, cwd: w.cwd, user: 'op' });
};

// ------------------------------------------------------------------- editor

test('editor opens a buffer and reports its shape', () => {
  const ed = new VimEditor('/tmp/a.txt', 'one\ntwo\n');
  assert.deepEqual(ed.lines, ['one', 'two'], 'trailing newline is a terminator');
  assert.equal(ed.mode, NORMAL);
  assert.equal(ed.content, 'one\ntwo\n', 'content round-trips');

  // An empty file is one empty line, not zero lines.
  assert.deepEqual(new VimEditor('/tmp/new', '').lines, ['']);
});

test('hjkl, 0, $, gg, G and word motions move the cursor', () => {
  const ed = new VimEditor('/f', 'hello world\nsecond line\nthird\n');
  keys(ed, 'll');
  assert.deepEqual([ed.cy, ed.cx], [0, 2]);
  keys(ed, 'j');
  assert.equal(ed.cy, 1);
  keys(ed, '$');
  assert.equal(ed.cx, 'second line'.length - 1);
  keys(ed, '0');
  assert.equal(ed.cx, 0);
  keys(ed, 'G');
  assert.equal(ed.cy, 2);
  keys(ed, 'gg');
  assert.deepEqual([ed.cy, ed.cx], [0, 0]);

  keys(ed, 'w');
  assert.equal(ed.cx, 6, 'w jumps to the next word');
  keys(ed, 'b');
  assert.equal(ed.cx, 0, 'b jumps back');

  // Cursor cannot escape the buffer.
  keys(ed, 'hhhkkk');
  assert.deepEqual([ed.cy, ed.cx], [0, 0]);
});

test('i, a, I, A, o and O enter insert mode in the right place', () => {
  const ed = new VimEditor('/f', 'abc\n');
  keys(ed, 'A!');
  assert.equal(ed.lines[0], 'abc!');
  assert.equal(ed.mode, INSERT);

  keys(ed, '<Escape>I>');
  assert.equal(ed.lines[0], '>abc!');

  keys(ed, '<Escape>o');
  assert.deepEqual(ed.lines, ['>abc!', '']);
  keys(ed, 'new');
  assert.deepEqual(ed.lines, ['>abc!', 'new']);

  keys(ed, '<Escape>O');
  assert.deepEqual(ed.lines, ['>abc!', '', 'new']);
});

test('insert mode handles typing, Enter, Backspace and line joins', () => {
  const ed = new VimEditor('/f', '');
  keys(ed, 'ihello<Enter>world');
  assert.deepEqual(ed.lines, ['hello', 'world']);

  keys(ed, '<Backspace><Backspace>');
  assert.deepEqual(ed.lines, ['hello', 'wor']);

  // Backspace at column 0 joins with the previous line.
  keys(ed, '<Escape>0i');
  keys(ed, '<Backspace>');
  assert.deepEqual(ed.lines, ['hellowor']);
  assert.equal(ed.dirty, true);
});

test('x, dd and p edit text', () => {
  const ed = new VimEditor('/f', 'abc\ndef\nghi\n');
  keys(ed, 'x');
  assert.equal(ed.lines[0], 'bc');

  keys(ed, 'dd');
  assert.deepEqual(ed.lines, ['def', 'ghi']);

  keys(ed, 'p');
  assert.deepEqual(ed.lines, ['def', 'bc', 'ghi'], 'dd yanks, p puts it back');

  // Deleting every line leaves one empty line, like vim.
  keys(ed, 'gg dddddd'.replace(/ /g, ''));
  assert.deepEqual(ed.lines, ['']);
});

test('Escape from insert steps the cursor back, like vim', () => {
  const ed = new VimEditor('/f', 'ab\n');
  keys(ed, 'A');
  assert.equal(ed.cx, 2, 'insert may sit one past the end');
  keys(ed, '<Escape>');
  assert.equal(ed.cx, 1, 'normal mode clamps back onto the last char');
});

test(':w, :wq, :q and :q! return the right actions', () => {
  const ed = new VimEditor('/f', 'x\n');
  assert.equal(ed.handleKey(':'), null);
  assert.equal(ed.mode, COMMAND);
  assert.deepEqual(keysAction(ed, 'w<Enter>'), { type: 'write' });

  const ed2 = new VimEditor('/f', 'x\n');
  assert.deepEqual(keysAction(ed2, ':wq<Enter>'), { type: 'write-quit' });

  // A clean buffer quits freely.
  const ed3 = new VimEditor('/f', 'x\n');
  assert.deepEqual(keysAction(ed3, ':q<Enter>'), { type: 'quit' });

  // A dirty one refuses, and needs q! to force.
  const ed4 = new VimEditor('/f', 'x\n');
  keys(ed4, 'ihello<Escape>');
  const refused = keysAction(ed4, ':q<Enter>');
  assert.equal(refused.type, 'error');
  assert.match(refused.message, /No write since last change/);
  assert.deepEqual(keysAction(ed4, ':q!<Enter>'), { type: 'quit' });

  const ed5 = new VimEditor('/f', 'x\n');
  assert.match(keysAction(ed5, ':nope<Enter>').message, /Not an editor command/);
});

function keysAction(ed, s) {
  let action = null;
  for (const k of s.match(/<[^>]+>|[\s\S]/g) || []) {
    action = ed.handleKey(k.startsWith('<') ? k.slice(1, -1) : k) || action;
  }
  return action;
}

test('Escape and Backspace abandon the command line', () => {
  const ed = new VimEditor('/f', 'x\n');
  keys(ed, ':w<Escape>');
  assert.equal(ed.mode, NORMAL);
  assert.equal(ed.cmdline, '');

  keys(ed, ':<Backspace>');
  assert.equal(ed.mode, NORMAL, 'backspacing past the colon leaves command mode');
});

test('status line reflects mode and dirtiness', () => {
  const ed = new VimEditor('/tmp/f', 'x\n');
  assert.match(ed.status(), /"\/tmp\/f"/);
  keys(ed, 'i');
  assert.equal(ed.status(), '-- INSERT --');
  keys(ed, 'z<Escape>');
  assert.match(ed.status(), /\[\+\]/, 'modified buffers are flagged');
});

// ---------------------------------------------------------- shell <-> editor

test('vim asks the host to open a file and respects permissions', () => {
  const sh = newShell();
  const r = sh.run('vim notes.txt');
  assert.equal(r.code, 0);
  assert.equal(r.editor.path, '/home/op/notes.txt');
  assert.match(r.editor.content, /check \/var\/log\/auth\.log/);

  // A new file opens an empty buffer rather than failing.
  assert.equal(sh.run('vim brand-new.txt').editor.content, '');

  assert.match(sh.run('vim /var/log').out, /Is a directory/);
  assert.match(sh.run('vim').out, /usage/);
  assert.equal(sh.run('vi notes.txt').editor.path, '/home/op/notes.txt', 'vi is an alias');
});

test('saving from the editor enforces permissions', () => {
  const sh = newShell();
  const open = sh.run('vim notes.txt');
  const ed = new VimEditor(open.editor.path, open.editor.content);
  keys(ed, 'ggdd');
  keys(ed, ' irewritten<Escape>'.replace(' ', ''));

  const res = sh.writeFile(ed.path, ed.content);
  assert.equal(res.ok, true);
  assert.match(sh.run('cat notes.txt').out, /rewritten/);

  // op cannot save into root-owned /etc...
  assert.match(sh.writeFile('/etc/passwd', 'x\n').error, /Permission denied/);
  // ...but sudo vim can.
  const sudoOpen = sh.run('sudo vim /etc/passwd');
  assert.equal(sudoOpen.editor.sudo, true);
  assert.equal(sh.writeFile('/etc/passwd', 'rooted\n', { sudo: true }).ok, true);
  assert.match(sh.run('cat /etc/passwd').out, /rooted/);

  // Saving into a directory that does not exist fails cleanly.
  assert.match(sh.writeFile('/nope/deep/f', 'x').error, /No such file/);
});

test('a full edit-and-save round trip through the shell', () => {
  const sh = newShell();
  const open = sh.run('vim /home/op/todo.txt');
  const ed = new VimEditor(open.editor.path, open.editor.content);
  keys(ed, 'ibuy milk<Enter>fix nginx<Escape>');
  const action = keysAction(ed, ':wq<Enter>');
  assert.equal(action.type, 'write-quit');
  assert.equal(sh.writeFile(ed.path, ed.content).ok, true);
  assert.equal(sh.run('cat /home/op/todo.txt').out, 'buy milk\nfix nginx\n');
});

// --------------------------------------------------------------- completion

const stateFor = (sh) => ({ vfs: sh.vfs, cwd: sh.cwd, user: sh.user, commands: COMMAND_NAMES });

test('completes command names', () => {
  const sh = newShell();
  assert.equal(complete(stateFor(sh), 'chm').line, 'chmod ');

  // Ambiguous prefixes fill in what is shared and offer the rest.
  const c = complete(stateFor(sh), 'ch');
  assert.deepEqual(c.matches, ['chmod', 'chown']);
  assert.equal(c.line, 'ch', 'nothing more is shared beyond "ch"');

  assert.deepEqual(complete(stateFor(sh), 'zzz').matches, []);
});

test('completes paths, including after sudo and across directories', () => {
  const sh = newShell();
  assert.equal(complete(stateFor(sh), 'cat not').line, 'cat notes.txt ');
  assert.equal(complete(stateFor(sh), 'cat /var/lo').line, 'cat /var/log/');
  assert.equal(complete(stateFor(sh), 'cat /var/log/au').line, 'cat /var/log/auth.log ');

  // Directories keep a trailing slash so you can keep typing.
  const varDir = complete(stateFor(sh), 'ls /va');
  assert.equal(varDir.line, 'ls /var/');

  // sudo defers to the command list, not paths.
  assert.equal(complete(stateFor(sh), 'sudo chm').line, 'sudo chmod ');

  const logs = complete(stateFor(sh), 'cat /var/log/');
  assert.deepEqual(logs.matches, ['/var/log/auth.log', '/var/log/syslog']);
});

test('completion hides dotfiles until the dot is typed', () => {
  const w = MISSIONS.find((m) => m.id === 'fix-perms').setup();
  const sh = new Shell({ vfs: w.vfs, procs: w.procs, cwd: w.cwd, user: 'op' });

  const plain = complete(stateFor(sh), 'ls ');
  assert.ok(!plain.matches.some((m) => m.startsWith('.')), 'dotfiles stay hidden');

  assert.equal(complete(stateFor(sh), 'ls .ss').line, 'ls .ssh/');
  assert.equal(complete(stateFor(sh), 'ls .ssh/id').line, 'ls .ssh/id_rsa ');
});

test('completion respects directory read permission', () => {
  const sh = newShell();
  sh.run('sudo mkdir /srv/secret');
  sh.run('sudo chmod 000 /srv/secret');
  assert.deepEqual(complete(stateFor(sh), 'ls /srv/secret/').matches, []);
});
