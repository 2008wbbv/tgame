// The terminal widget: an output pane plus an input line with shell history.

export class Terminal {
  constructor(outEl, inputEl, promptEl) {
    this.out = outEl;
    this.input = inputEl;
    this.promptEl = promptEl;
    this.history = [];
    this.cursor = 0;
    this.onCommand = () => {};

    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const line = this.input.value;
        this.input.value = '';
        if (line.trim()) {
          this.history.push(line);
          this.cursor = this.history.length;
        }
        this.echo(`${this.prompt} ${line}`);
        this.onCommand(line);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (this.cursor > 0) this.input.value = this.history[--this.cursor] ?? '';
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (this.cursor < this.history.length) {
          this.cursor++;
          this.input.value = this.history[this.cursor] ?? '';
        }
      } else if (e.key === 'l' && e.ctrlKey) {
        e.preventDefault();
        this.clear();
      }
    });
  }

  set prompt(text) {
    this._prompt = text;
    this.promptEl.textContent = text;
  }

  get prompt() {
    return this._prompt || '$';
  }

  /** Appends text, optionally wrapped in a class for colour. */
  echo(text, cls) {
    if (text === undefined || text === '') return;
    const node = document.createElement(cls ? 'span' : 'span');
    if (cls) node.className = cls;
    node.textContent = text.endsWith('\n') ? text : text + '\n';
    this.out.appendChild(node);
    this.out.scrollTop = this.out.scrollHeight;
  }

  clear() {
    this.out.textContent = '';
  }

  focus() {
    this.input.focus();
  }
}
