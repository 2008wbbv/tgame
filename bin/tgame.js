#!/usr/bin/env node
// Terminal client. Plays solo entirely offline, or connects to a server for
// ranked races and chaos rooms. Raw-mode input so vim keys work properly.

import readline from 'node:readline';
import { stdin, stdout } from 'node:process';

import { Shell, COMMAND_NAMES } from '../engine/shell.js';
import { MISSIONS } from '../engine/missions.js';
import { VimEditor } from '../engine/editor.js';
import { complete } from '../engine/complete.js';

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', cyan: '\x1b[36m', inv: '\x1b[7m',
};
const paint = (s, c) => (process.env.NO_COLOR ? s : c + s + C.reset);

function usage() {
  console.log(`tgame - competitive linux sysadmin

  tgame solo                     practice offline, no account
  tgame play  [--server URL]     ranked race (asks for login)
  tgame chaos [CODE] [--server]  shared-filesystem room; omit CODE to create

  --user NAME --pass PW          skip the login prompts
  --server URL                   default http://localhost:3000
`);
}

// ----------------------------------------------------------------- terminal

class Term {
  constructor() {
    this.line = '';
    this.history = [];
    this.hIndex = 0;
    this.prompt = '$ ';
    this.onLine = () => {};
    this.onComplete = () => {};
    this.onRawKey = null; // set while the editor is open
    readline.emitKeypressEvents(stdin);
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.on('keypress', (ch, key) => this.key(ch, key));
  }

  key(ch, key) {
    if (key && key.ctrl && key.name === 'c') {
      this.write('\n');
      process.exit(0);
    }
    // While vim is open it takes every keystroke.
    if (this.onRawKey) return this.onRawKey(ch, key);

    if (!key) return;
    switch (key.name) {
      case 'return':
      case 'enter': {
        this.write('\n');
        const line = this.line;
        this.line = '';
        if (line.trim()) {
          this.history.push(line);
          this.hIndex = this.history.length;
        }
        this.onLine(line);
        return;
      }
      case 'backspace':
        this.line = this.line.slice(0, -1);
        return this.redraw();
      case 'tab':
        return this.onComplete(this.line);
      case 'up':
        if (this.hIndex > 0) this.line = this.history[--this.hIndex] ?? '';
        return this.redraw();
      case 'down':
        if (this.hIndex < this.history.length) {
          this.hIndex++;
          this.line = this.history[this.hIndex] ?? '';
        }
        return this.redraw();
      default:
        if (ch && !key.ctrl && !key.meta && ch >= ' ') {
          this.line += ch;
          this.redraw();
        }
    }
  }

  write(s) {
    stdout.write(s);
  }

  /** Reprints the prompt line in place. */
  redraw() {
    readline.clearLine(stdout, 0);
    readline.cursorTo(stdout, 0);
    this.write(this.prompt + this.line);
  }

  /** Prints output above the prompt without disturbing what is being typed. */
  print(text, colour) {
    if (text === undefined || text === '') return;
    readline.clearLine(stdout, 0);
    readline.cursorTo(stdout, 0);
    const body = text.endsWith('\n') ? text.slice(0, -1) : text;
    this.write((colour ? paint(body, colour) : body) + '\n');
    this.redraw();
  }

  setPrompt(p) {
    this.prompt = p;
    this.redraw();
  }
}

// -------------------------------------------------------------------- vim

/**
 * Translates a keypress into editor key names.
 *
 * Node cannot know whether a lone ESC is a keypress or the start of an escape
 * sequence, so it waits for the next byte and reports the pair as `meta`.
 * That is exactly "pressed Escape, then a key", so we unpack it back into two.
 * Returns an array because of that one-to-many case.
 */
function keyNames(ch, key) {
  if (!key) return ch && ch >= ' ' ? [ch] : [];

  if (key.name === 'escape') return ['Escape'];

  if (key.meta && typeof key.sequence === 'string' && key.sequence.startsWith('\x1b')) {
    const rest = key.sequence.slice(1);
    if (rest === '') return ['Escape'];
    if (rest === '\r' || rest === '\n') return ['Escape', 'Enter'];
    if (rest === '\x7f') return ['Escape', 'Backspace'];
    return rest >= ' ' ? ['Escape', rest] : ['Escape'];
  }

  if (key.name === 'return' || key.name === 'enter') return ['Enter'];
  if (key.name === 'backspace') return ['Backspace'];
  if (key.ctrl) return [];
  return ch && ch >= ' ' ? [ch] : [];
}

/**
 * Runs the editor in the terminal, taking over the keyboard until it exits.
 * `save` returns a promise resolving to {ok}|{error}.
 */
function runEditor(term, { path, content, sudo }, save, done) {
  const ed = new VimEditor(path, content);
  ed.sudo = !!sudo;

  const render = () => {
    // Redraw the whole screen, like a real full-screen editor.
    stdout.write('\x1b[2J\x1b[H');
    const rows = Math.max(10, (stdout.rows || 24) - 3);
    for (let y = 0; y < rows; y++) {
      if (y < ed.lines.length) {
        const text = ed.lines[y];
        if (y === ed.cy) {
          const at = text[ed.cx] ?? ' ';
          stdout.write(
            text.slice(0, ed.cx) + paint(at, C.inv) + text.slice(ed.cx + 1) + '\n'
          );
        } else stdout.write(text + '\n');
      } else stdout.write(paint('~', C.blue) + '\n');
    }
    stdout.write(paint(ed.status(), C.dim));
  };

  const finish = () => {
    stdout.write('\x1b[2J\x1b[H');
    term.onRawKey = null;
    done();
  };

  term.onRawKey = async (ch, key) => {
    for (const name of keyNames(ch, key)) {
      const action = ed.handleKey(name);
      render();
      if (!action) continue;

      if (action.type === 'quit') return finish();
      if (action.type === 'write' || action.type === 'write-quit') {
        const res = await save(ed.path, ed.content, ed.sudo);
        if (res.error) {
          ed.message = res.error;
          render();
          continue;
        }
        ed.dirty = false;
        ed.message = `"${ed.path}" ${res.bytes ?? ed.content.length}B written`;
        if (action.type === 'write-quit') return finish();
        render();
      }
    }
  };

  render();
}

// -------------------------------------------------------------------- solo

function playSolo() {
  const term = new Term();
  let index = 0;
  let shell = null;

  const load = () => {
    if (index >= MISSIONS.length) {
      term.print(paint('\nall missions complete. nice work.', C.green));
      process.exit(0);
    }
    const m = MISSIONS[index];
    const w = m.setup();
    shell = new Shell({ vfs: w.vfs, procs: w.procs, cwd: w.cwd, user: 'op' });
    term.print(`\n${paint(`[${index + 1}/${MISSIONS.length}] ${m.title}`, C.bold)}`);
    term.print(m.brief);
    term.setPrompt(`op@web01:${shell.cwd}$ `);
  };

  const checkMission = () => {
    const m = MISSIONS[index];
    if (!m || !m.check(shell)) return;
    term.print(paint(`* solved: ${m.title}`, C.green));
    index++;
    load();
  };

  term.onComplete = (line) => {
    const { line: done, matches } = complete(
      { vfs: shell.vfs, cwd: shell.cwd, user: shell.user, commands: COMMAND_NAMES },
      line
    );
    if (matches.length > 1) term.print(paint(matches.join('  '), C.dim));
    term.line = done;
    term.redraw();
  };

  term.onLine = (line) => {
    const cmd = line.trim();
    if (!cmd) return term.redraw();
    if (cmd === 'quit' || cmd === 'exit') process.exit(0);
    if (cmd === 'hint') return term.print(paint(`hint: ${MISSIONS[index].hint}`, C.yellow));
    if (cmd === 'skip') {
      index++;
      return load();
    }

    const res = shell.run(cmd);
    if (res.editor) {
      return runEditor(
        term,
        res.editor,
        async (path, content, sudo) => shell.writeFile(path, content, { sudo }),
        () => {
          term.print('');
          checkMission();
          term.setPrompt(`op@web01:${shell.cwd}$ `);
        }
      );
    }
    term.print(res.out);
    term.setPrompt(`op@web01:${shell.cwd}$ `);
    checkMission();
  };

  term.print(paint('tgame solo — type `hint`, `skip` or `quit`. Tab completes.', C.dim));
  load();
}

// ------------------------------------------------------------ online modes

async function playOnline({ server, mode, code, user, pass }) {
  const { WebSocket } = await import('ws');

  const creds = {
    username: user || (await ask('username: ')),
    password: pass || (await ask('password: ', true)),
  };

  // Register on demand: logging in fails first for a brand new name.
  let auth = await post(server, '/api/login', creds);
  if (auth.error) {
    const reg = await post(server, '/api/register', creds);
    if (reg.error) {
      console.error(paint(`login failed: ${auth.error} / ${reg.error}`, C.red));
      process.exit(1);
    }
    auth = reg;
    console.log(paint('registered a new account.', C.dim));
  }

  const wsUrl = server.replace(/^http/, 'ws') + `/ws?token=${encodeURIComponent(auth.token)}`;
  const ws = new WebSocket(wsUrl);
  const send = (m) => ws.send(JSON.stringify(m));

  const term = new Term();
  let saveResolve = null;
  let host = mode === 'chaos' ? 'shared' : 'web01';

  ws.on('open', () => {
    if (mode === 'chaos') send(code ? { type: 'chaos_join', code } : { type: 'chaos_create' });
    else send({ type: 'queue' });
  });

  ws.on('close', () => {
    term.print(paint('\ndisconnected.', C.red));
    process.exit(0);
  });

  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    switch (m.type) {
      case 'hello':
        term.print(paint(`signed in as ${m.username} — ${m.elo} elo (${m.rank})`, C.dim));
        break;
      case 'queued':
        term.print('searching for an opponent…');
        break;
      case 'race_start':
        term.print(paint(`\nmatched vs ${m.opponent.username} (${m.opponent.elo} elo)`, C.yellow));
        term.print(`${m.missionCount} missions — go!`);
        printMission(term, m.mission);
        break;
      case 'output':
        if (m.editor) {
          return runEditor(term, m.editor, remoteSave, () => {
            term.print('');
            term.setPrompt(`${creds.username}@${host}:${m.cwd || '~'}$ `);
          });
        }
        term.print(m.out);
        if (m.advanced) term.print(paint(`* solved (${m.solved})`, C.green));
        if (m.mission) printMission(term, m.mission);
        if (m.cwd) term.setPrompt(`${creds.username}@${host}:${m.cwd}$ `);
        break;
      case 'editor_saved':
        if (saveResolve) saveResolve(m.error ? { error: m.error } : { ok: true, bytes: m.bytes });
        saveResolve = null;
        if (!m.error && m.advanced) term.print(paint(`* solved (${m.solved})`, C.green));
        break;
      case 'completion':
        if (m.matches && m.matches.length > 1) term.print(paint(m.matches.join('  '), C.dim));
        term.line = m.line ?? term.line;
        term.redraw();
        break;
      case 'opponent_progress':
        term.print(paint(`opponent: ${m.solved}/${m.total}`, C.yellow));
        break;
      case 'opponent_finished':
        term.print(paint('opponent finished!', C.yellow));
        break;
      case 'race_over':
        term.print(
          paint(`\n== ${m.outcome.toUpperCase()} (${m.reason}) ==`, m.outcome === 'win' ? C.green : C.red)
        );
        term.print(`you ${m.solved}/${m.total} — opponent ${m.opponentSolved}/${m.total}`);
        term.print(`elo ${m.eloBefore} -> ${m.eloAfter} (${m.eloDelta >= 0 ? '+' : ''}${m.eloDelta})`);
        process.exit(0);
        break;
      case 'chaos_joined':
        term.print(paint(`\njoined room ${m.code}`, C.yellow));
        term.print(`objective: ${m.objective}`);
        term.print(`players: ${m.players.join(', ')}`);
        term.setPrompt(`${creds.username}@shared:~$ `);
        break;
      case 'chaos_join':
        term.print(paint(`${m.username} joined`, C.yellow));
        break;
      case 'chaos_leave':
        term.print(paint(`${m.username} left`, C.yellow));
        break;
      case 'chaos_feed':
        term.print(paint(`[${m.username}] ${m.line}`, C.yellow));
        break;
      case 'chaos_scores':
        break;
      case 'chaos_over':
        term.print(paint('\n== time ==', C.yellow));
        for (const s of m.scores) term.print(`  ${s.username.padEnd(16)} ${s.files}`);
        term.print(paint(m.winner ? `winner: ${m.winner}` : 'a draw', C.green));
        process.exit(0);
        break;
      case 'error':
        term.print(paint(`* ${m.error}`, C.red));
        break;
    }
  });

  const remoteSave = (path, content, sudo) =>
    new Promise((resolve) => {
      saveResolve = resolve;
      send({ type: 'editor_save', path, content, sudo });
    });

  term.onComplete = (line) => send({ type: 'complete', line });
  term.onLine = (line) => {
    const cmd = line.trim();
    if (cmd === 'quit' || cmd === 'exit') {
      send({ type: 'leave' });
      process.exit(0);
    }
    if (!cmd) return term.redraw();
    send({ type: 'cmd', line: cmd });
  };
}

// The server echoes the current mission with every message; only announce it
// when it actually changes, or the brief scrolls past after each command.
let lastMissionKey = null;

function printMission(term, mission) {
  if (!mission) return;
  const key = `${mission.index}:${mission.id}`;
  if (key === lastMissionKey) return;
  lastMissionKey = key;
  term.print(
    `\n${paint(`[${mission.index + 1}/${mission.total}] ${mission.title}`, C.bold)}`
  );
  term.print(mission.brief);
}

async function post(server, path, body) {
  try {
    const res = await fetch(server + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return await res.json();
  } catch (e) {
    return { error: `cannot reach ${server}: ${e.message}` };
  }
}

/** One-shot prompt used before the raw-mode terminal takes over. */
function ask(question, hidden = false) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: stdin, output: stdout, terminal: true });
    if (hidden) {
      // Suppress echo so the password is not printed.
      const onData = () => rl.output.write('\x1b[2K\x1b[200D' + question);
      rl.input.on('data', onData);
      rl.question(question, (a) => {
        rl.input.off('data', onData);
        rl.close();
        stdout.write('\n');
        resolve(a);
      });
    } else {
      rl.question(question, (a) => {
        rl.close();
        resolve(a);
      });
    }
  });
}

// -------------------------------------------------------------------- main

/**
 * Splits argv into flags and positional words. Flags that take a value consume
 * the following token, so `chaos --server URL` does not mistake URL for a room
 * code.
 */
function parseArgs(argv) {
  const VALUE_FLAGS = new Set(['server', 'user', 'pass']);
  const flags = {};
  const words = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const name = arg.slice(2);
      if (VALUE_FLAGS.has(name)) flags[name] = argv[++i];
      else flags[name] = true;
    } else if (arg === '-h') {
      flags.help = true;
    } else {
      words.push(arg);
    }
  }
  return { flags, words };
}

const { flags, words } = parseArgs(process.argv.slice(2));
const command = words[0] || 'solo';
const server = flags.server || process.env.TGAME_SERVER || 'http://localhost:3000';
const { user, pass } = flags;

if (flags.help || command === 'help') {
  usage();
} else if (command === 'solo') {
  playSolo();
} else if (command === 'play') {
  playOnline({ server, mode: 'race', user, pass });
} else if (command === 'chaos') {
  playOnline({ server, mode: 'chaos', code: words[1], user, pass });
} else {
  usage();
  process.exit(1);
}
