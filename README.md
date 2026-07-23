# tgame

Competitive Linux sysadmin practice. A simulated shell, real missions, Elo
ratings, and a shared-filesystem mode where players can delete each other's work.

Think chess.com or AoPS FTW, but the skill being ranked is fixing broken boxes.

```
npm install
npm start          # http://localhost:3000
npm test

npm run solo       # or play it right in your terminal
```

One dependency (`ws`). SQLite, crypto and HTTP all come from Node's standard
library. No build step, no bundler, no framework, barely any CSS.

## Modes

**Solo practice** — 11 missions, no account needed. Runs entirely in the browser.

**Ranked race** — Matchmaking pairs you with the closest available rating. Both
players get the same 5 missions at the same moment and race. More missions
solved wins; a tie breaks on time. Ratings update by standard Elo (K=32), and
the match is written to your history.

**Chaos room** — Everyone in the room shares *one* filesystem. Anything you
create, anyone else can `rm`, `mv`, `chmod` or overwrite. You own the most files
in `/srv/shared` when the timer ends, you win. `sudo` is disabled here — root
could trivially `chown -R` the whole tree and end the game.

## Missions

Missions are checked against the resulting filesystem and process table, never
against the command you typed — so any legitimate route to the goal counts.
`grep pattern file > out` and `cat file | grep pattern > out` both pass.

They cover reading logs, finding an attacker's IP, fixing key permissions,
making a script executable, tidying a drop zone, freeing a full disk, killing a
runaway miner, handing over a web root with `chown -R`, and auditing stray
root-owned files.

## Play in your terminal

The same game, without a browser:

```
tgame solo                          practice offline, no account
tgame play  --server URL            ranked race
tgame chaos [CODE] --server URL     shared room; omit CODE to create one
```

Add `--user NAME --pass PW` to skip the prompts. A username that does not exist
yet is registered for you. `--server` defaults to `http://localhost:3000`.

## The shell

`ls cd pwd cat echo touch mkdir rm mv cp chmod chown grep find du ps kill vim
sudo whoami help`, plus pipes (`|`), redirects (`>`, `>>`), quoting, `~` and
`..`, command history on ↑/↓, and **Tab completion** for commands and paths.

Completion is permission-aware (it will not list a directory you cannot read)
and hides dotfiles until you type the leading dot. In multiplayer it is answered
by the server, so it always reflects the real filesystem — including files an
opponent created seconds ago.

## vim

`vim FILE` (or `vi`) opens a real modal editor, in the browser and the terminal
alike:

| | |
|---|---|
| move | `h j k l` `0` `$` `gg` `G` `w` `b` |
| insert | `i` `a` `I` `A` `o` `O`, `Esc` to leave |
| edit | `x` `dd` `p` |
| exit | `:w` `:q` `:wq` `:x` `:q!` |

It refuses to `:q` a modified buffer, exactly like the real thing. `sudo vim`
writes as root.

Editing happens client-side, but **the save does not**: `:w` sends the buffer to
the server, which applies the same permission checks a redirect would. Since a
write can complete a mission, saving in vim can win you the race — and in a
chaos room, your `:w` shows up in everyone else's feed.

Permissions are modelled properly: mode bits, ownership, and `sudo`. You cannot
write to a root-owned directory, `chown` a file you do not own, or kill another
user's process. One deliberate deviation from bash — a `sudo` anywhere in the
pipeline also elevates the redirect, so `sudo echo x > /etc/f` works and players
don't need `tee`.

## Layout

```
engine/   isomorphic game core - vfs, shell, missions, vim, completion
server/   http + websockets, auth, elo, race matchmaking, chaos rooms
client/   the browser UI
bin/      the terminal client
test/     engine, editor, websocket integration and CLI end-to-end tests
```

The engine is shared: solo play imports it directly in the browser, while ranked
and chaos modes run the very same code server-side. That is what makes missions
tamper-proof — the server verifies completion itself rather than trusting a
client that says it won.

## Config

| var | default | meaning |
|---|---|---|
| `PORT` | `3000` | http port |
| `TGAME_DB` | `./data/tgame.db` | sqlite path, or `:memory:` |
| `TGAME_SECRET` | random per boot | session signing key; set it to survive restarts |
