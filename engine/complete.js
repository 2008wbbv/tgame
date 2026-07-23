// Tab completion for commands and paths. Pure function of (state, line) so the
// browser can call it locally and the server can answer it over the socket.

import { DIR, resolvePath } from './vfs.js';

const HOME = '/home/op';

/** Longest string that all candidates start with. */
function commonPrefix(items) {
  if (!items.length) return '';
  let prefix = items[0];
  for (const item of items) {
    while (!item.startsWith(prefix)) prefix = prefix.slice(0, -1);
  }
  return prefix;
}

/**
 * @param state  {vfs, cwd, user, commands: string[]}
 * @param line   the full input line
 * @returns {line, matches} - `line` has the common prefix filled in, and
 *          `matches` is populated only when the choice is ambiguous.
 */
export function complete(state, line) {
  const { vfs, cwd, user, commands } = state;

  // The token under the cursor is whatever follows the last space.
  const lastSpace = line.lastIndexOf(' ');
  const head = lastSpace === -1 ? '' : line.slice(0, lastSpace + 1);
  const token = line.slice(lastSpace + 1);

  const firstWord = head.trim() === '' || /^\s*sudo\s+$/.test(head);
  const candidates = firstWord
    ? completeCommand(commands, token)
    : completePath(vfs, cwd, user, token);

  if (!candidates.length) return { line, matches: [] };

  if (candidates.length === 1) {
    // A unique match gets a trailing space so the next word can be typed -
    // except a directory, which keeps its slash so you can descend into it.
    const only = candidates[0];
    return { line: head + only + (only.endsWith('/') ? '' : ' '), matches: [] };
  }

  const prefix = commonPrefix(candidates);
  return {
    line: prefix.length > token.length ? head + prefix : line,
    matches: candidates,
  };
}

function completeCommand(commands, token) {
  return commands.filter((c) => c.startsWith(token)).sort();
}

function completePath(vfs, cwd, user, token) {
  // Split into the directory being listed and the fragment being matched.
  const slash = token.lastIndexOf('/');
  const dirPart = slash === -1 ? '' : token.slice(0, slash + 1);
  const frag = slash === -1 ? token : token.slice(slash + 1);

  const abs = resolvePath(cwd, dirPart === '' ? '.' : dirPart, HOME);
  const node = vfs.get(abs);
  if (!node || node.type !== DIR) return [];
  if (!vfs.can(node, user, 'r')) return [];

  return Object.entries(node.children)
    .filter(([name]) => name.startsWith(frag))
    // Hidden files only show up once you have typed the dot.
    .filter(([name]) => frag.startsWith('.') || !name.startsWith('.'))
    .map(([name, child]) => dirPart + name + (child.type === DIR ? '/' : ''))
    .sort();
}
