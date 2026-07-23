// A small modal editor with vim keybindings. Pure state machine: it takes key
// names and returns actions, so the browser and the terminal client can both
// drive it without sharing any rendering code.

export const NORMAL = 'normal';
export const INSERT = 'insert';
export const COMMAND = 'command';

export class VimEditor {
  constructor(path, content = '') {
    this.path = path;
    // A trailing newline is a line terminator, not an empty last line.
    this.lines = content === '' ? [''] : content.replace(/\n$/, '').split('\n');
    this.cy = 0;
    this.cx = 0;
    this.mode = NORMAL;
    this.cmdline = '';
    this.message = `"${path}" ${this.lines.length}L`;
    this.dirty = false;
    this.pending = null; // for two-key sequences like dd and gg
    this.clipboard = null;
  }

  get content() {
    return this.lines.join('\n') + '\n';
  }

  get line() {
    return this.lines[this.cy] ?? '';
  }

  set line(v) {
    this.lines[this.cy] = v;
  }

  /** Keeps the cursor inside the buffer; insert mode may sit one past the end. */
  clamp() {
    this.cy = Math.max(0, Math.min(this.cy, this.lines.length - 1));
    const max = this.mode === INSERT ? this.line.length : Math.max(0, this.line.length - 1);
    this.cx = Math.max(0, Math.min(this.cx, max));
  }

  /**
   * Feeds one key in. Key names: single printable chars, or 'Escape',
   * 'Enter', 'Backspace', 'Tab'.
   * @returns null, or an action: {type:'write'|'quit'|'write-quit'|'error'}
   */
  handleKey(key) {
    this.message = '';
    if (this.mode === INSERT) return this.insertKey(key);
    if (this.mode === COMMAND) return this.commandKey(key);
    return this.normalKey(key);
  }

  insertKey(key) {
    if (key === 'Escape') {
      this.mode = NORMAL;
      this.cx = Math.max(0, this.cx - 1);
      this.clamp();
      return null;
    }
    if (key === 'Enter') {
      const rest = this.line.slice(this.cx);
      this.line = this.line.slice(0, this.cx);
      this.lines.splice(this.cy + 1, 0, rest);
      this.cy++;
      this.cx = 0;
      this.dirty = true;
      return null;
    }
    if (key === 'Backspace') {
      if (this.cx > 0) {
        this.line = this.line.slice(0, this.cx - 1) + this.line.slice(this.cx);
        this.cx--;
      } else if (this.cy > 0) {
        // Join with the previous line.
        const prev = this.lines[this.cy - 1];
        this.cx = prev.length;
        this.lines[this.cy - 1] = prev + this.line;
        this.lines.splice(this.cy, 1);
        this.cy--;
      }
      this.dirty = true;
      return null;
    }
    if (key.length === 1) {
      this.line = this.line.slice(0, this.cx) + key + this.line.slice(this.cx);
      this.cx++;
      this.dirty = true;
    }
    return null;
  }

  commandKey(key) {
    if (key === 'Escape') {
      this.mode = NORMAL;
      this.cmdline = '';
      return null;
    }
    if (key === 'Backspace') {
      this.cmdline = this.cmdline.slice(0, -1);
      if (this.cmdline === '') this.mode = NORMAL;
      return null;
    }
    if (key === 'Enter') {
      const cmd = this.cmdline.slice(1).trim(); // drop the leading ':'
      this.cmdline = '';
      this.mode = NORMAL;
      return this.runExCommand(cmd);
    }
    if (key.length === 1) this.cmdline += key;
    return null;
  }

  runExCommand(cmd) {
    switch (cmd) {
      case 'w':
        return { type: 'write' };
      case 'wq':
      case 'x':
        return { type: 'write-quit' };
      case 'q':
        if (this.dirty) {
          this.message = 'E37: No write since last change (add ! to override)';
          return { type: 'error', message: this.message };
        }
        return { type: 'quit' };
      case 'q!':
        return { type: 'quit' };
      default:
        this.message = `E492: Not an editor command: ${cmd}`;
        return { type: 'error', message: this.message };
    }
  }

  normalKey(key) {
    // Resolve pending two-key sequences first.
    if (this.pending) {
      const p = this.pending;
      this.pending = null;
      if (p === 'd' && key === 'd') return this.deleteLine();
      if (p === 'g' && key === 'g') {
        this.cy = 0;
        this.cx = 0;
        return null;
      }
      // Anything else cancels the sequence and falls through.
    }

    switch (key) {
      case 'h': this.cx--; break;
      case 'l': this.cx++; break;
      case 'j': this.cy++; break;
      case 'k': this.cy--; break;
      case '0': this.cx = 0; break;
      case '$': this.cx = Math.max(0, this.line.length - 1); break;
      case 'G': this.cy = this.lines.length - 1; this.cx = 0; break;
      case 'w': this.wordForward(); break;
      case 'b': this.wordBack(); break;

      case 'i': this.mode = INSERT; break;
      case 'a': this.mode = INSERT; this.cx++; break;
      case 'I': this.mode = INSERT; this.cx = 0; break;
      case 'A': this.mode = INSERT; this.cx = this.line.length; break;

      case 'o':
        this.lines.splice(this.cy + 1, 0, '');
        this.cy++;
        this.cx = 0;
        this.mode = INSERT;
        this.dirty = true;
        break;
      case 'O':
        this.lines.splice(this.cy, 0, '');
        this.cx = 0;
        this.mode = INSERT;
        this.dirty = true;
        break;

      case 'x':
        if (this.line.length) {
          this.line = this.line.slice(0, this.cx) + this.line.slice(this.cx + 1);
          this.dirty = true;
        }
        break;

      case 'p':
        if (this.clipboard !== null) {
          this.lines.splice(this.cy + 1, 0, this.clipboard);
          this.cy++;
          this.cx = 0;
          this.dirty = true;
        }
        break;

      case 'd':
      case 'g':
        this.pending = key;
        return null;

      case ':':
        this.mode = COMMAND;
        this.cmdline = ':';
        return null;

      default:
        break;
    }
    this.clamp();
    return null;
  }

  deleteLine() {
    this.clipboard = this.line;
    this.lines.splice(this.cy, 1);
    if (!this.lines.length) this.lines = [''];
    this.dirty = true;
    this.clamp();
    return null;
  }

  wordForward() {
    const l = this.line;
    let i = this.cx;
    while (i < l.length && /\S/.test(l[i])) i++;
    while (i < l.length && /\s/.test(l[i])) i++;
    if (i >= l.length && this.cy < this.lines.length - 1) {
      this.cy++;
      this.cx = 0;
    } else this.cx = i;
  }

  wordBack() {
    const l = this.line;
    let i = this.cx - 1;
    while (i > 0 && /\s/.test(l[i])) i--;
    while (i > 0 && /\S/.test(l[i - 1])) i--;
    if (i < 0 && this.cy > 0) {
      this.cy--;
      this.cx = 0;
    } else this.cx = Math.max(0, i);
  }

  /** The status line vim shows at the bottom. */
  status() {
    if (this.mode === COMMAND) return this.cmdline;
    if (this.message) return this.message;
    if (this.mode === INSERT) return '-- INSERT --';
    return `"${this.path}"${this.dirty ? ' [+]' : ''}  ${this.cy + 1},${this.cx + 1}`;
  }
}
