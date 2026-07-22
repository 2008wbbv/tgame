// Client. Solo play runs the engine locally; ranked races and chaos rooms run
// on the server and this is just a terminal attached to a socket.

import { Shell } from '../engine/shell.js';
import { MISSIONS, byId } from '../engine/missions.js';
import { Terminal } from './term.js';

const $ = (id) => document.getElementById(id);
const show = (id, on) => $(id).classList.toggle('hide', !on);

const term = new Terminal($('out'), $('line'), $('prompt'));
let token = localStorage.getItem('tgame_token');
let me = null;
let ws = null;
let mode = null; // 'solo' | 'race' | 'chaos'
let solo = null; // { index, shell, mission }
let currentMission = null;
let timerHandle = null;

// ------------------------------------------------------------------ helpers

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `request failed (${res.status})`);
  return data;
}

function setUser(user) {
  me = user;
  $('whoami').textContent = user
    ? `${user.username} — ${user.elo} elo (${user.rank}) — ${user.wins}W ${user.losses}L ${user.draws}D`
    : 'not signed in';
}

function showBrief(m) {
  currentMission = m;
  if (!m) {
    $('brief').textContent = '';
    return;
  }
  $('brief').innerHTML = '';
  const h = document.createElement('h2');
  h.textContent = `[${m.index + 1}/${m.total}] ${m.title}`;
  const p = document.createElement('div');
  p.textContent = m.brief;
  $('brief').append(h, p);
}

function startTimer(endsAt, label) {
  clearInterval(timerHandle);
  timerHandle = setInterval(() => {
    const left = Math.max(0, endsAt - Date.now());
    const mm = String(Math.floor(left / 60000)).padStart(2, '0');
    const ss = String(Math.floor((left % 60000) / 1000)).padStart(2, '0');
    $('status').textContent = `${label}  ${mm}:${ss}`;
    if (left === 0) clearInterval(timerHandle);
  }, 250);
}

function toGame(modeName, helpText) {
  mode = modeName;
  show('auth', false);
  show('menu', false);
  show('game', true);
  term.clear();
  $('gameHelp').textContent = helpText;
  $('brief').textContent = '';
  $('status').textContent = '';
  term.focus();
}

function toMenu() {
  mode = null;
  solo = null;
  currentMission = null;
  clearInterval(timerHandle);
  show('game', false);
  show('auth', !me);
  show('menu', !!me);
  if (me) refreshBoards();
}

// --------------------------------------------------------------------- auth

async function authenticate(path) {
  $('authError').textContent = '';
  try {
    const data = await api(path, {
      method: 'POST',
      body: { username: $('username').value.trim(), password: $('password').value },
    });
    token = data.token;
    localStorage.setItem('tgame_token', token);
    setUser(data.user);
    connect();
    toMenu();
  } catch (e) {
    $('authError').textContent = e.message;
  }
}

$('login').onclick = () => authenticate('/api/login');
$('register').onclick = () => authenticate('/api/register');
$('password').addEventListener('keydown', (e) => e.key === 'Enter' && authenticate('/api/login'));

$('btnLogout').onclick = () => {
  localStorage.removeItem('tgame_token');
  token = null;
  setUser(null);
  if (ws) ws.close();
  ws = null;
  toMenu();
};

// ----------------------------------------------------------- boards

async function refreshBoards() {
  try {
    const { leaderboard } = await api('/api/leaderboard');
    $('board').innerHTML = '';
    const t = document.createElement('table');
    t.innerHTML =
      '<tr><th>#</th><th>player</th><th>elo</th><th>rank</th><th>W/L/D</th></tr>' +
      leaderboard
        .map(
          (r, i) =>
            `<tr><td>${i + 1}</td><td>${esc(r.username)}</td><td>${r.elo}</td>` +
            `<td>${esc(r.rank)}</td><td>${r.wins}/${r.losses}/${r.draws}</td></tr>`
        )
        .join('');
    $('board').append(t);
  } catch {
    $('board').textContent = 'could not load leaderboard';
  }

  try {
    const { history } = await api('/api/history');
    $('history').textContent = history.length ? '' : 'no matches yet';
    if (history.length) {
      const t = document.createElement('table');
      t.innerHTML = history
        .map(
          (h) =>
            `<tr><td class="${h.outcome === 'win' ? 'win' : h.outcome === 'loss' ? 'loss' : ''}">` +
            `${h.outcome}</td><td>vs ${esc(h.opponent)}</td>` +
            `<td>${h.solved}-${h.opponentSolved}</td>` +
            `<td>${h.eloDelta >= 0 ? '+' : ''}${h.eloDelta}</td></tr>`
        )
        .join('');
      $('history').append(t);
    }
  } catch {
    $('history').textContent = '—';
  }
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------------------------------------------------------------- websocket

function connect() {
  if (!token) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(token)}`);
  ws.onmessage = (e) => onMessage(JSON.parse(e.data));
  ws.onclose = () => {
    if (mode === 'race' || mode === 'chaos') {
      term.echo('* disconnected from server', 'loss');
    }
  };
}

const send = (msg) => ws && ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg));

function onMessage(m) {
  switch (m.type) {
    case 'hello':
      setUser({ ...m, wins: me?.wins ?? 0, losses: me?.losses ?? 0, draws: me?.draws ?? 0 });
      break;

    case 'error':
      if (mode) term.echo(`* ${m.error}`, 'loss');
      else $('authError').textContent = m.error;
      break;

    case 'queued':
      toGame('race', 'searching for an opponent…');
      term.echo('* in the matchmaking queue, waiting for an opponent…', 'muted');
      break;

    case 'queue_cancelled':
      toMenu();
      break;

    case 'race_start': {
      toGame('race', 'first to finish all missions wins. type `hint` for a nudge.');
      term.echo(`* matched vs ${m.opponent.username} (${m.opponent.elo} elo)`, 'warn');
      term.echo(`* ${m.missionCount} missions — go!`);
      term.prompt = 'op@web01:~$';
      showBrief(m.mission);
      startTimer(Date.now() + m.countdownMs + m.timeLimitMs, 'race');
      break;
    }

    case 'output':
      term.echo(m.out);
      if (m.advanced) term.echo(`* mission solved (${m.solved})`, 'win');
      if (m.mission) showBrief(m.mission);
      if (m.cwd) term.prompt = `${me.username}@${mode === 'chaos' ? 'shared' : 'web01'}:${m.cwd}$`;
      break;

    case 'opponent_progress':
      term.echo(`* opponent has solved ${m.solved}/${m.total}`, 'warn');
      break;

    case 'opponent_finished':
      term.echo('* opponent finished!', 'warn');
      break;

    case 'race_over': {
      clearInterval(timerHandle);
      const cls = m.outcome === 'win' ? 'win' : m.outcome === 'loss' ? 'loss' : 'warn';
      term.echo(`\n== ${m.outcome.toUpperCase()} (${m.reason}) ==`, cls);
      term.echo(`you ${m.solved}/${m.total} — opponent ${m.opponentSolved}/${m.total}`);
      term.echo(`elo ${m.eloBefore} -> ${m.eloAfter} (${m.eloDelta >= 0 ? '+' : ''}${m.eloDelta})`, cls);
      term.echo('type `menu` to go back.', 'muted');
      if (me) setUser({ ...me, elo: m.eloAfter });
      showBrief(null);
      break;
    }

    case 'chaos_joined':
      toGame('chaos', `room ${m.code} — ${m.objective}. no sudo in here.`);
      term.echo(`* joined room ${m.code}`, 'warn');
      term.echo(`* objective: ${m.objective}`);
      term.echo(`* players: ${m.players.join(', ')}`);
      term.prompt = `${me.username}@shared:~$`;
      startTimer(m.endsAt, `room ${m.code}`);
      renderScores(m.scores);
      break;

    case 'chaos_join':
      term.echo(`* ${m.username} joined`, 'warn');
      renderScores(m.scores);
      break;

    case 'chaos_leave':
      term.echo(`* ${m.username} left`, 'warn');
      renderScores(m.scores);
      break;

    case 'chaos_feed':
      term.echo(`[${m.username}] ${m.line}`, 'warn');
      renderScores(m.scores);
      break;

    case 'chaos_scores':
      renderScores(m.scores);
      break;

    case 'chaos_over':
      clearInterval(timerHandle);
      term.echo('\n== time ==', 'warn');
      for (const s of m.scores) term.echo(`  ${s.username.padEnd(16)} ${s.files} files`);
      term.echo(m.winner ? `winner: ${m.winner}` : 'a draw — nobody takes it', 'win');
      term.echo('type `menu` to go back.', 'muted');
      break;
  }
}

function renderScores(scores) {
  if (!scores) return;
  const line = scores.map((s) => `${s.username}:${s.files}`).join('  ');
  $('brief').textContent = `owned files — ${line}`;
}

// -------------------------------------------------------------------- solo

function startSolo() {
  toGame('solo', 'practice mode — no rating. `hint`, `skip`, `menu` also work.');
  solo = { index: 0 };
  loadSolo();
}

function loadSolo() {
  if (solo.index >= MISSIONS.length) {
    term.echo('\n== all missions complete ==', 'win');
    term.echo('type `menu` to go back.', 'muted');
    showBrief(null);
    return;
  }
  const m = MISSIONS[solo.index];
  const w = m.setup();
  solo.shell = new Shell({ vfs: w.vfs, procs: w.procs, cwd: w.cwd, user: 'op' });
  showBrief({ ...m, index: solo.index, total: MISSIONS.length });
  term.prompt = `op@web01:${solo.shell.cwd}$`;
}

function soloCommand(line) {
  const m = MISSIONS[solo.index];
  if (!m) return;
  const res = solo.shell.run(line);
  term.echo(res.out);
  term.prompt = `op@web01:${solo.shell.cwd}$`;
  if (m.check(solo.shell)) {
    term.echo(`* mission solved: ${m.title}`, 'win');
    solo.index++;
    loadSolo();
  }
}

// ------------------------------------------------------------ input routing

term.onCommand = (line) => {
  const cmd = line.trim();
  if (!cmd) return;

  // A few game-level commands work in every mode.
  if (cmd === 'menu' || cmd === 'quit') {
    if (mode === 'race' || mode === 'chaos') send({ type: 'leave' });
    return toMenu();
  }
  if (cmd === 'clear') return term.clear();
  if (cmd === 'hint') {
    const hint = mode === 'solo' ? MISSIONS[solo.index]?.hint : currentMission?.hint;
    return term.echo(hint ? `hint: ${hint}` : 'no hint here.', 'warn');
  }
  if (cmd === 'skip' && mode === 'solo') {
    solo.index++;
    return loadSolo();
  }

  if (mode === 'solo') return soloCommand(cmd);
  return send({ type: 'cmd', line: cmd });
};

$('btnHint').onclick = () => term.onCommand('hint');
$('btnQuit').onclick = () => term.onCommand('menu');
$('btnRanked').onclick = () => send({ type: 'queue' });
$('btnSolo').onclick = startSolo;
$('playSolo').onclick = (e) => {
  e.preventDefault();
  startSolo();
};
$('btnChaos').onclick = () => send({ type: 'chaos_create' });
$('btnJoin').onclick = () => send({ type: 'chaos_join', code: $('roomCode').value.trim() });

// ------------------------------------------------------------------- start

(async function init() {
  if (!token) return toMenu();
  try {
    const { user } = await api('/api/me');
    setUser(user);
    connect();
  } catch {
    localStorage.removeItem('tgame_token');
    token = null;
  }
  toMenu();
})();
