// Virtual filesystem. Plain-data tree so it serializes with JSON.stringify and
// can be shipped over the wire to sync chaos rooms.

export const DIR = 'dir';
export const FILE = 'file';

export function dir(owner = 'root', mode = 0o755, children = {}) {
  return { type: DIR, owner, mode, children };
}

export function file(content = '', owner = 'root', mode = 0o644) {
  return { type: FILE, owner, mode, content };
}

/** Split a path into segments, resolving `.` and `..` against `cwd`. */
export function resolvePath(cwd, path, home = '/home/op') {
  if (path === undefined || path === '') path = '.';
  if (path === '~' || path.startsWith('~/')) path = home + path.slice(1);
  const base = path.startsWith('/') ? [] : cwd.split('/').filter(Boolean);
  const out = base.slice();
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return '/' + out.join('/');
}

export function modeString(node) {
  const m = node.mode;
  const bit = (b, ch) => (m & b ? ch : '-');
  return (
    (node.type === DIR ? 'd' : '-') +
    bit(0o400, 'r') + bit(0o200, 'w') + bit(0o100, 'x') +
    bit(0o040, 'r') + bit(0o020, 'w') + bit(0o010, 'x') +
    bit(0o004, 'r') + bit(0o002, 'w') + bit(0o001, 'x')
  );
}

export class VFS {
  constructor(root = dir()) {
    this.root = root;
  }

  static fromJSON(json) {
    return new VFS(typeof json === 'string' ? JSON.parse(json).root : json.root);
  }

  toJSON() {
    return { root: this.root };
  }

  clone() {
    return VFS.fromJSON(JSON.parse(JSON.stringify(this.toJSON())));
  }

  /** Returns the node at an absolute path, or null. */
  get(abs) {
    const segs = abs.split('/').filter(Boolean);
    let node = this.root;
    for (const seg of segs) {
      if (!node || node.type !== DIR) return null;
      node = node.children[seg];
    }
    return node || null;
  }

  parentOf(abs) {
    const segs = abs.split('/').filter(Boolean);
    const name = segs.pop();
    return { parent: this.get('/' + segs.join('/')), name };
  }

  exists(abs) {
    return this.get(abs) !== null;
  }

  /**
   * Permission check. `root` bypasses everything, matching sudo semantics.
   * Falls back to the "other" bits when the user does not own the node.
   */
  can(node, user, what) {
    if (!node) return false;
    if (user === 'root') return true;
    const shift = node.owner === user ? 6 : 0;
    const bit = { r: 0o4, w: 0o2, x: 0o1 }[what] << shift;
    return (node.mode & bit) !== 0;
  }

  /** Walks every node, yielding [absolutePath, node]. */
  *walk(abs = '/', node = this.root) {
    yield [abs, node];
    if (node.type !== DIR) return;
    for (const [name, child] of Object.entries(node.children)) {
      yield* this.walk(abs === '/' ? '/' + name : abs + '/' + name, child);
    }
  }
}
