// A small POSIX-flavoured shell over the VFS. Supports quoting, pipes and
// output redirection. Every command is a pure function of (args, stdin, ctx),
// which keeps it testable and lets the server run it authoritatively.

import { VFS, DIR, FILE, dir, file, resolvePath, modeString } from './vfs.js';

const HOME = '/home/op';

/** Splits a line into tokens, honouring quotes and keeping shell operators. */
export function tokenize(line) {
  const tokens = [];
  let cur = '';
  let quote = null;
  let had = false; // distinguishes an empty quoted string from no token

  const push = () => {
    if (cur !== '' || had) tokens.push(cur);
    cur = '';
    had = false;
  };

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      had = true;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      push();
      continue;
    }
    if (ch === '|' || ch === '>') {
      push();
      if (ch === '>' && line[i + 1] === '>') {
        tokens.push('>>');
        i++;
      } else tokens.push(ch);
      continue;
    }
    cur += ch;
  }
  if (quote) throw new Error('unterminated quote');
  push();
  return tokens;
}

/** Groups tokens into a pipeline of commands plus an optional redirect. */
export function parse(line) {
  const tokens = tokenize(line);
  const stages = [[]];
  let redirect = null;

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '|') {
      stages.push([]);
    } else if (t === '>' || t === '>>') {
      const target = tokens[++i];
      if (!target) throw new Error('syntax error near unexpected token `newline\'');
      redirect = { target, append: t === '>>' };
    } else {
      stages[stages.length - 1].push(t);
    }
  }
  return { stages: stages.filter((s) => s.length), redirect };
}

const lines = (s) => (s === '' ? [] : s.replace(/\n$/, '').split('\n'));

/** Turns a glob like `*.log` into an anchored regex. */
function globToRegex(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp('^' + escaped.replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
}

function parseMode(spec, current, isDir) {
  if (/^[0-7]{3,4}$/.test(spec)) return parseInt(spec, 8);
  const m = /^([ugoa]*)([+\-=])([rwxX]+)$/.exec(spec);
  if (!m) return null;
  let [, who, op, perms] = m;
  if (!who || who === 'a') who = 'ugo';
  let mask = 0;
  for (const w of who) {
    const shift = { u: 6, g: 3, o: 0 }[w];
    for (const p of perms) {
      // `X` only sets the execute bit on directories, like real chmod.
      if (p === 'X' && !isDir) continue;
      mask |= { r: 4, w: 2, x: 1, X: 1 }[p] << shift;
    }
  }
  if (op === '+') return current | mask;
  if (op === '-') return current & ~mask;
  return mask;
}

const err = (msg) => ({ out: msg.endsWith('\n') ? msg : msg + '\n', code: 1 });
const ok = (out = '') => ({ out: out && !out.endsWith('\n') ? out + '\n' : out, code: 0 });

const COMMANDS = {
  pwd: (a, stdin, ctx) => ok(ctx.cwd),

  whoami: (a, stdin, ctx) => ok(ctx.user),

  echo: (args) => ok(args.join(' ')),

  cd(args, stdin, ctx) {
    const abs = resolvePath(ctx.cwd, args[0] || HOME, HOME);
    const node = ctx.vfs.get(abs);
    if (!node) return err(`cd: ${args[0] || HOME}: No such file or directory`);
    if (node.type !== DIR) return err(`cd: ${args[0]}: Not a directory`);
    if (!ctx.vfs.can(node, ctx.user, 'x')) return err(`cd: ${args[0]}: Permission denied`);
    ctx.cwd = abs;
    return ok();
  },

  ls(args, stdin, ctx) {
    const flags = args.filter((a) => a.startsWith('-')).join('');
    const paths = args.filter((a) => !a.startsWith('-'));
    const long = flags.includes('l');
    const all = flags.includes('a');
    const targets = paths.length ? paths : ['.'];
    const out = [];

    for (const p of targets) {
      const abs = resolvePath(ctx.cwd, p, HOME);
      const node = ctx.vfs.get(abs);
      if (!node) return err(`ls: cannot access '${p}': No such file or directory`);
      if (targets.length > 1) out.push(`${p}:`);

      if (node.type === FILE) {
        out.push(long ? longFormat(p.split('/').pop(), node) : p);
      } else {
        if (!ctx.vfs.can(node, ctx.user, 'r')) {
          return err(`ls: cannot open directory '${p}': Permission denied`);
        }
        const names = Object.keys(node.children).sort();
        for (const name of names) {
          if (!all && name.startsWith('.')) continue;
          out.push(long ? longFormat(name, node.children[name]) : name);
        }
      }
      if (targets.length > 1) out.push('');
    }
    return ok(out.join('\n'));
  },

  cat(args, stdin, ctx) {
    if (!args.length) return ok(stdin);
    const out = [];
    for (const p of args) {
      const abs = resolvePath(ctx.cwd, p, HOME);
      const node = ctx.vfs.get(abs);
      if (!node) return err(`cat: ${p}: No such file or directory`);
      if (node.type === DIR) return err(`cat: ${p}: Is a directory`);
      if (!ctx.vfs.can(node, ctx.user, 'r')) return err(`cat: ${p}: Permission denied`);
      out.push(node.content.replace(/\n$/, ''));
    }
    return ok(out.join('\n'));
  },

  touch(args, stdin, ctx) {
    for (const p of args) {
      const abs = resolvePath(ctx.cwd, p, HOME);
      if (ctx.vfs.exists(abs)) continue;
      const { parent, name } = ctx.vfs.parentOf(abs);
      if (!parent) return err(`touch: cannot touch '${p}': No such file or directory`);
      if (!ctx.vfs.can(parent, ctx.user, 'w')) {
        return err(`touch: cannot touch '${p}': Permission denied`);
      }
      parent.children[name] = file('', ctx.user);
    }
    return ok();
  },

  mkdir(args, stdin, ctx) {
    const parents = args.includes('-p');
    for (const p of args.filter((a) => !a.startsWith('-'))) {
      const abs = resolvePath(ctx.cwd, p, HOME);
      if (ctx.vfs.exists(abs)) {
        if (parents) continue;
        return err(`mkdir: cannot create directory '${p}': File exists`);
      }
      const segs = abs.split('/').filter(Boolean);
      let node = ctx.vfs.root;
      for (let i = 0; i < segs.length; i++) {
        const seg = segs[i];
        const last = i === segs.length - 1;
        if (!node.children[seg]) {
          if (!last && !parents) {
            return err(`mkdir: cannot create directory '${p}': No such file or directory`);
          }
          if (!ctx.vfs.can(node, ctx.user, 'w')) {
            return err(`mkdir: cannot create directory '${p}': Permission denied`);
          }
          node.children[seg] = dir(ctx.user);
        }
        node = node.children[seg];
        if (node.type !== DIR) return err(`mkdir: '${p}': Not a directory`);
      }
    }
    return ok();
  },

  rm(args, stdin, ctx) {
    const flags = args.filter((a) => a.startsWith('-')).join('');
    const recursive = flags.includes('r') || flags.includes('R');
    const force = flags.includes('f');
    for (const p of args.filter((a) => !a.startsWith('-'))) {
      const abs = resolvePath(ctx.cwd, p, HOME);
      const node = ctx.vfs.get(abs);
      if (!node) {
        if (force) continue;
        return err(`rm: cannot remove '${p}': No such file or directory`);
      }
      if (node.type === DIR && !recursive) {
        return err(`rm: cannot remove '${p}': Is a directory`);
      }
      const { parent, name } = ctx.vfs.parentOf(abs);
      if (!parent || !ctx.vfs.can(parent, ctx.user, 'w')) {
        return err(`rm: cannot remove '${p}': Permission denied`);
      }
      delete parent.children[name];
    }
    return ok();
  },

  mv(args, stdin, ctx) {
    const paths = args.filter((a) => !a.startsWith('-'));
    if (paths.length < 2) return err('mv: missing destination file operand');
    return moveOrCopy(paths, ctx, { remove: true, name: 'mv' });
  },

  cp(args, stdin, ctx) {
    const paths = args.filter((a) => !a.startsWith('-'));
    if (paths.length < 2) return err('cp: missing destination file operand');
    const recursive = args.some((a) => a.startsWith('-') && /[rR]/.test(a));
    return moveOrCopy(paths, ctx, { remove: false, recursive, name: 'cp' });
  },

  chmod(args, stdin, ctx) {
    const recursive = args.some((a) => a.startsWith('-') && /[rR]/.test(a));
    const rest = args.filter((a) => !a.startsWith('-'));
    const [spec, ...paths] = rest;
    if (!spec || !paths.length) return err('chmod: missing operand');

    for (const p of paths) {
      const abs = resolvePath(ctx.cwd, p, HOME);
      const node = ctx.vfs.get(abs);
      if (!node) return err(`chmod: cannot access '${p}': No such file or directory`);
      // Only the owner (or root) may change a mode, regardless of the w bit.
      if (ctx.user !== 'root' && node.owner !== ctx.user) {
        return err(`chmod: changing permissions of '${p}': Operation not permitted`);
      }
      const targets = recursive ? [...ctx.vfs.walk(abs, node)].map(([, n]) => n) : [node];
      for (const t of targets) {
        const mode = parseMode(spec, t.mode, t.type === DIR);
        if (mode === null) return err(`chmod: invalid mode: '${spec}'`);
        t.mode = mode;
      }
    }
    return ok();
  },

  chown(args, stdin, ctx) {
    const recursive = args.some((a) => a.startsWith('-') && /[rR]/.test(a));
    const rest = args.filter((a) => !a.startsWith('-'));
    const [spec, ...paths] = rest;
    if (!spec || !paths.length) return err('chown: missing operand');
    if (ctx.user !== 'root') {
      return err('chown: changing ownership: Operation not permitted');
    }
    const owner = spec.split(':')[0];
    for (const p of paths) {
      const abs = resolvePath(ctx.cwd, p, HOME);
      const node = ctx.vfs.get(abs);
      if (!node) return err(`chown: cannot access '${p}': No such file or directory`);
      const targets = recursive ? [...ctx.vfs.walk(abs, node)].map(([, n]) => n) : [node];
      for (const t of targets) t.owner = owner;
    }
    return ok();
  },

  grep(args, stdin, ctx) {
    const flags = args.filter((a) => a.startsWith('-')).join('');
    const rest = args.filter((a) => !a.startsWith('-'));
    const [pattern, ...paths] = rest;
    if (pattern === undefined) return err('usage: grep [-inv] PATTERN [FILE...]');

    let re;
    try {
      re = new RegExp(pattern, flags.includes('i') ? 'i' : '');
    } catch {
      return err(`grep: invalid pattern: ${pattern}`);
    }
    const invert = flags.includes('v');
    const number = flags.includes('n');
    const multi = paths.length > 1;
    const out = [];

    const scan = (text, label) => {
      lines(text).forEach((line, i) => {
        if (re.test(line) === invert) return;
        let prefix = multi ? `${label}:` : '';
        if (number) prefix += `${i + 1}:`;
        out.push(prefix + line);
      });
    };

    if (!paths.length) {
      scan(stdin, '');
    } else {
      for (const p of paths) {
        const abs = resolvePath(ctx.cwd, p, HOME);
        const node = ctx.vfs.get(abs);
        if (!node) return err(`grep: ${p}: No such file or directory`);
        if (node.type === DIR) return err(`grep: ${p}: Is a directory`);
        if (!ctx.vfs.can(node, ctx.user, 'r')) return err(`grep: ${p}: Permission denied`);
        scan(node.content, p);
      }
    }
    return { out: out.length ? out.join('\n') + '\n' : '', code: out.length ? 0 : 1 };
  },

  find(args, stdin, ctx) {
    const start = args[0] && !args[0].startsWith('-') ? args[0] : '.';
    const abs = resolvePath(ctx.cwd, start, HOME);
    const root = ctx.vfs.get(abs);
    if (!root) return err(`find: '${start}': No such file or directory`);

    let nameRe = null;
    let type = null;
    let user = null;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-name') nameRe = globToRegex(args[++i] || '');
      else if (args[i] === '-type') type = args[++i] === 'd' ? DIR : FILE;
      else if (args[i] === '-user') user = args[++i];
    }

    const out = [];
    for (const [path, node] of ctx.vfs.walk(abs, root)) {
      const base = path.split('/').pop() || '/';
      if (nameRe && !nameRe.test(base)) continue;
      if (type && node.type !== type) continue;
      if (user && node.owner !== user) continue;
      // Print paths the way the user addressed them: relative stays relative.
      out.push(start.startsWith('/') ? path : path.replace(ctx.cwd, '.').replace('//', '/'));
    }
    return ok(out.join('\n'));
  },

  du(args, stdin, ctx) {
    const start = args.find((a) => !a.startsWith('-')) || '.';
    const abs = resolvePath(ctx.cwd, start, HOME);
    const node = ctx.vfs.get(abs);
    if (!node) return err(`du: cannot access '${start}': No such file or directory`);
    const out = [];
    for (const [path, n] of ctx.vfs.walk(abs, node)) {
      if (n.type !== FILE) continue;
      out.push(`${String(n.content.length).padEnd(8)}${path}`);
    }
    return ok(out.join('\n'));
  },

  ps(args, stdin, ctx) {
    const out = ['  PID USER     %CPU COMMAND'];
    for (const p of ctx.procs) {
      out.push(
        `${String(p.pid).padStart(5)} ${p.user.padEnd(8)} ${String(p.cpu).padStart(4)} ${p.cmd}`
      );
    }
    return ok(out.join('\n'));
  },

  kill(args, stdin, ctx) {
    const pids = args.filter((a) => !a.startsWith('-'));
    if (!pids.length) return err('kill: usage: kill [-9] pid');
    for (const raw of pids) {
      const pid = Number(raw);
      const idx = ctx.procs.findIndex((p) => p.pid === pid);
      if (idx === -1) return err(`kill: (${raw}): No such process`);
      const proc = ctx.procs[idx];
      if (ctx.user !== 'root' && proc.user !== ctx.user) {
        return err(`kill: (${raw}): Operation not permitted`);
      }
      ctx.procs.splice(idx, 1);
    }
    return ok();
  },

  /**
   * Does not edit anything itself - it asks the host to open an editor, so the
   * same command works in the browser and in a real terminal.
   */
  vim(args, stdin, ctx) {
    const p = args.find((a) => !a.startsWith('-'));
    if (!p) return err('usage: vim FILE');
    const abs = resolvePath(ctx.cwd, p, HOME);
    const node = ctx.vfs.get(abs);
    if (node && node.type === DIR) return err(`vim: ${p}: Is a directory`);
    if (node && !ctx.vfs.can(node, ctx.user, 'r')) return err(`vim: ${p}: Permission denied`);
    return { out: '', code: 0, editor: { path: abs, content: node ? node.content : '' } };
  },

  help: () =>
    ok(
      [
        'commands: ls cd pwd cat echo touch mkdir rm mv cp chmod chown',
        '          grep find du ps kill vim sudo whoami help',
        'features: pipes (|), redirects (> >>), quotes, ~ and .. paths,',
        '          TAB completion, up/down history',
      ].join('\n')
    ),
};

COMMANDS.vi = COMMANDS.vim;

/** Command names available for tab completion. */
export const COMMAND_NAMES = [...Object.keys(COMMANDS), 'sudo'];

function longFormat(name, node) {
  const size = node.type === FILE ? node.content.length : Object.keys(node.children).length * 4;
  return `${modeString(node)} ${node.owner.padEnd(6)} ${String(size).padStart(6)} ${name}`;
}

function moveOrCopy(paths, ctx, { remove, recursive, name: cmd }) {
  const destRaw = paths.pop();
  const destAbs = resolvePath(ctx.cwd, destRaw, HOME);
  const destNode = ctx.vfs.get(destAbs);
  const intoDir = destNode && destNode.type === DIR;
  if (paths.length > 1 && !intoDir) {
    return err(`${cmd}: target '${destRaw}' is not a directory`);
  }

  for (const src of paths) {
    const srcAbs = resolvePath(ctx.cwd, src, HOME);
    const srcNode = ctx.vfs.get(srcAbs);
    if (!srcNode) return err(`${cmd}: cannot stat '${src}': No such file or directory`);
    if (srcNode.type === DIR && !remove && !recursive) {
      return err(`${cmd}: -r not specified; omitting directory '${src}'`);
    }
    if (!ctx.vfs.can(srcNode, ctx.user, 'r')) {
      return err(`${cmd}: cannot open '${src}': Permission denied`);
    }

    const base = srcAbs.split('/').pop();
    const targetAbs = intoDir ? `${destAbs === '/' ? '' : destAbs}/${base}` : destAbs;
    const { parent, name } = ctx.vfs.parentOf(targetAbs);
    if (!parent) return err(`${cmd}: cannot move '${src}': No such file or directory`);
    if (!ctx.vfs.can(parent, ctx.user, 'w')) {
      return err(`${cmd}: cannot create '${targetAbs}': Permission denied`);
    }

    if (remove) {
      const srcParent = ctx.vfs.parentOf(srcAbs);
      if (!ctx.vfs.can(srcParent.parent, ctx.user, 'w')) {
        return err(`${cmd}: cannot remove '${src}': Permission denied`);
      }
      parent.children[name] = srcNode;
      delete srcParent.parent.children[srcParent.name];
    } else {
      const copy = JSON.parse(JSON.stringify(srcNode));
      copy.owner = ctx.user;
      parent.children[name] = copy;
    }
  }
  return ok();
}

export class Shell {
  constructor({ vfs, user = 'op', cwd = HOME, procs = [], allowSudo = true } = {}) {
    this.vfs = vfs instanceof VFS ? vfs : new VFS(vfs);
    this.user = user;
    this.cwd = cwd;
    this.procs = procs;
    this.allowSudo = allowSudo;
    this.history = [];
  }

  /**
   * Writes a buffer back to the filesystem, enforcing the same permissions a
   * redirect would. Used by the editor's `:w`.
   * @returns {ok:true} or {error}
   */
  writeFile(abs, content, { sudo = false } = {}) {
    const writer = sudo && this.allowSudo ? 'root' : this.user;
    const existing = this.vfs.get(abs);
    if (existing && existing.type === DIR) return { error: `${abs}: Is a directory` };
    if (existing) {
      if (!this.vfs.can(existing, writer, 'w')) return { error: `${abs}: Permission denied` };
      existing.content = content;
      return { ok: true, bytes: content.length };
    }
    const { parent, name } = this.vfs.parentOf(abs);
    if (!parent) return { error: `${abs}: No such file or directory` };
    if (!this.vfs.can(parent, writer, 'w')) return { error: `${abs}: Permission denied` };
    parent.children[name] = file(content, writer);
    return { ok: true, bytes: content.length };
  }

  /** Runs one command line and returns its combined output. */
  run(line) {
    line = line.trim();
    if (!line) return { out: '', code: 0 };
    this.history.push(line);

    let parsed;
    try {
      parsed = parse(line);
    } catch (e) {
      return { out: `tsh: ${e.message}\n`, code: 2 };
    }
    const { stages, redirect } = parsed;
    if (!stages.length) return { out: '', code: 0 };

    let stdin = '';
    let code = 0;
    let sudoUsed = false;
    let editor = null;

    for (const stage of stages) {
      let [name, ...args] = stage;
      // `sudo` just re-runs the rest of the stage as root.
      let user = this.user;
      while (name === 'sudo') {
        if (!this.allowSudo) {
          return {
            out: `${this.user} is not in the sudoers file. This incident will be reported.\n`,
            code: 1,
          };
        }
        user = 'root';
        sudoUsed = true;
        [name, ...args] = args;
        if (!name) return { out: 'usage: sudo command\n', code: 2 };
      }

      const fn = COMMANDS[name];
      if (!fn) return { out: `tsh: ${name}: command not found\n`, code: 127 };

      const ctx = { vfs: this.vfs, user, cwd: this.cwd, procs: this.procs };
      const result = fn(args, stdin, ctx);
      this.cwd = ctx.cwd; // `cd` mutates through ctx
      stdin = result.out;
      code = result.code;
      // An editor request escapes the pipeline: it is for the host, not stdin.
      if (result.editor) {
        editor = result.editor;
        editor.sudo = sudoUsed;
      }
      if (code !== 0 && stages.length > 1) break;
    }

    if (editor) return { out: stdin, code, editor };

    if (redirect && code === 0) {
      // Unlike real bash, a `sudo` anywhere in the pipeline also elevates the
      // redirect. It is the behaviour players expect and spares them `tee`.
      const writer = sudoUsed ? 'root' : this.user;
      const abs = resolvePath(this.cwd, redirect.target, HOME);
      const { parent, name } = this.vfs.parentOf(abs);
      if (!parent) return { out: `tsh: ${redirect.target}: No such file or directory\n`, code: 1 };
      const existing = parent.children[name];
      if (existing) {
        if (existing.type === DIR) {
          return { out: `tsh: ${redirect.target}: Is a directory\n`, code: 1 };
        }
        if (!this.vfs.can(existing, writer, 'w')) {
          return { out: `tsh: ${redirect.target}: Permission denied\n`, code: 1 };
        }
        existing.content = redirect.append ? existing.content + stdin : stdin;
      } else {
        if (!this.vfs.can(parent, writer, 'w')) {
          return { out: `tsh: ${redirect.target}: Permission denied\n`, code: 1 };
        }
        parent.children[name] = file(stdin, writer);
      }
      return { out: '', code: 0 };
    }

    return { out: stdin, code };
  }
}
