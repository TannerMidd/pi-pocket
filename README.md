<div align="center">

# Pi Pocket

**Your Pi coding agent, in your pocket.**

A durable, multiplayer, mobile-first web app for Pi agents, built on [Pi Durable](https://earendil.com/posts/pi-durable/).<br>
Runs on your own machine or directly on your phone. No cloud VM.

[![Release](https://img.shields.io/github/v/release/TannerMidd/pi-pocket?color=7aa2f7)](https://github.com/TannerMidd/pi-pocket/releases)
[![Node.js 22.19+](https://img.shields.io/badge/node-%E2%89%A5%2022.19-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![MIT license](https://img.shields.io/badge/license-MIT-ff9e64)](LICENSE)

[Website](https://tannermidd.github.io/pi-pocket/) · [Quick start](#quick-start) · [Features](#features) · [Remote access](#remote-access)

<img src="docs/showcase.png" alt="Pi Pocket in the Tokyo Night theme, on a desktop and a phone. On the desktop, the sidebar lists sessions by day while Pi fixes a sign-in redirect loop in tiled windows: a diff, 48 passing tests, and a teammate asking for the branch. On the phone, the same session waits for approval before git push." width="100%">

</div>

## Quick start

Requires Node.js 22.19 or newer. Runs on Linux, macOS, Windows, and Android (Termux); Linux is the most tested. Sign in to a provider with Pi first (`pi`, then `/login`), or later from the app's Providers sheet.

```bash
git clone https://github.com/TannerMidd/pi-pocket.git
cd pi-pocket
npm install
npm start
```

The launcher asks how your devices should connect, then prints the address, a sign-in link, and a QR code. Open the link once per browser; the cookie lasts a year. The link is the owner's key, so keep it private. `--rotate-token` replaces it and signs out every device that used the old link; people you invited stay signed in until you remove them under Menu → People.

While it runs: **q** quit · **r** restart server · **a** change access · **o** open in browser · **s** show QR code.

## Features

- **Durable.** Every model call, tool call, and subagent is stored as it happens. Restart the server mid-run and the work continues; a cut-off tool call reruns only if that is safe.
- **Multiplayer.** Share a live session: presence, a side chat Pi does not see, @mentions, pins, reactions, shared notes, and take turns.
- **Steer or queue.** Redirect Pi while it works, queue follow-ups, or stop it.
- **Forks.** Fork from any reply, edit a message and send it again, or retry it with another model. Each fork is a session of its own, optionally in a git worktree of its own.
- **Works while you're away.** Schedule messages to Pi (`/schedule every weekday 8:00 summarize CI`), and `/until npm test` keeps Pi going until the check passes.
- **Plan mode.** Pi reads and proposes a plan; nothing changes until someone approves it.
- **Any provider, any model.** Uses Pi's own model runtime and sign-ins, skills, and prompt templates, with the model and thinking level chosen per session.
- **Omarchy themes.** Every Omarchy theme, or follow your desktop's live; tiled Hyprland-style windows, a Walker-style launcher (Ctrl/⌘+K) with live theme previews, and Hyprland's motion.
- **Peek tiles.** One click (or Alt+P) shows your other sessions working beside the one you are in: approve their calls from there, and swap between them with a click. Only the tiles on screen stay live, so a long list scrolls cheaply.
- **Built for phones.** Streaming answers, Pi's tool calls folded into a timeline with diffs and live output, push notifications you can allow or deny from, sharing into Pi from other apps, and a home-screen app.
- **Files and review.** The Files tile (Alt+E) shows the session's folder beside the conversation, and Changes reviews every uncommitted change: word-level diffs, split or unified, and files you mark viewed. Code in Pi's replies is colored, and an HTML block previews inline, running on a tap in a sandbox.
- **Branches.** The git branch shows in the top bar, under the session's title, and follows any switch; tap it to switch to another branch, follow a remote one, or make a new one.
- **A built-in browser.** Pi opens, reads, clicks through, and screenshots pages in a real Chromium on the server, and you watch and use the same page in the Browser panel, from a phone too: your dev server on `localhost` included.
- **Artifacts and subagents.** Sandboxed HTML, Markdown, and SVG artifacts, and background subagents you can open and talk to.
- **Codemode.** On by default: Pi writes short scripts that call its tools, and every call still goes through the same checks.
- **Lancet Guard.** Off by default; turn it on in Menu → Extensions. With the [specpi-lancet-guard](https://github.com/TannerMidd/SpecPi) Pi package installed and on, risky bash, write, and edit calls wait for someone in the session to approve.
- **Roles, invites, and limits.** Steer or view-only access, to every session or just one, through one-time links and QR codes, with spend limits per person and per session.
- **Live-editable.** No build step: edit the web app or an extension and it reloads in place. Add your own extensions in `~/.pi-pocket/extensions/`.

The full tour is in [docs/features.md](docs/features.md).

## Remote access

Choose a mode in the launcher, or pass `--access`:

| Mode         | Who can connect      | Notes                                                                                                                                                                                                       |
| ------------ | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `local`      | This machine         | Listens on `127.0.0.1`                                                                                                                                                                                      |
| `lan`        | Your local network   | All addresses, plain http                                                                                                                                                                                   |
| `cloudflare` | Anyone with the link | Free quick tunnel with https, no account needed (Cloudflare offers quick tunnels for testing and development). The address changes each time the launcher starts but stays the same across server restarts. |
| `tailscale`  | Your tailnet         | Tailscale address only, encrypted by the tailnet                                                                                                                                                            |

Cloudflare mode needs `cloudflared`. On Linux the launcher can download the official release into `~/.pi-pocket/bin`. To use another tunnel (ngrok, `tailscale serve`), choose `local` and point the tunnel at port 8787.

> [!WARNING]
> Anyone with steering rights can make the agent run commands on this machine, as you. That reaches everything you can: your files, Pi Pocket's own settings and sign-in tokens, and its code. A single-session invite limits what someone sees in the app, not what Pi can reach, and Lancet Guard approvals can come from anyone who can steer, including the person who asked. People who can steer every session can also invite others. Invite only people you would trust at your keyboard. View-only users cannot make Pi act.

## Android (Termux)

```bash
pkg update && pkg upgrade
pkg install nodejs git
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
pi                      # /login, then quit
# copy or clone pi-pocket to the phone, then:
cd pi-pocket && npm install --ignore-scripts && npm start
```

Open the link in Chrome and choose **Add to Home screen**. Run `termux-wake-lock` so Android does not stop Termux.

Lancet Guard needs ONNX Runtime, which may not load on Android. If the guard is on but cannot load, Pi Pocket blocks bash, write, and edit calls (the status line shows "guard failed"). Turn it off in the app (Menu → Extensions), in `~/.pi/lancet-guard.json`, or by starting with `PI_POCKET_GUARD=off`.

## Configuration

| Option            | Default        | Purpose                                                           |
| ----------------- | -------------- | ----------------------------------------------------------------- |
| `--access <mode>` | last choice    | Skip the access menu                                              |
| `-y`              |                | Reuse the last access choice                                      |
| `--port`          | `8787`         | Port to listen on                                                 |
| `--cwd`           | current folder | Default folder for new sessions                                   |
| `--data`          | `~/.pi-pocket` | Database, settings, uploads, and push keys                        |
| `--host`          |                | Listen on a specific address instead of choosing access           |
| `--rotate-token`  |                | Issue a new owner link and sign out devices that used the old one |

Environment variables: `PI_POCKET_ACCESS`, `PI_POCKET_DIR`, `PI_POCKET_HOST`, `PI_POCKET_PORT`, `PI_POCKET_GUARD=off`, `PI_POCKET_BROWSER` (the browser to run, when Chromium or Chrome is not found by itself), and `PI_POCKET_BROWSER_ARGS` (extra flags for it, such as `--no-sandbox` where sandboxes are unavailable). Without a terminal (under systemd, for example), the launcher uses `--access` or the last choice.

## Architecture

| Path                                                                                           | Role                                                                                                                                        |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `bin/pi-pocket.js`                                                                             | Entry point: checks the Node version, starts the launcher                                                                                   |
| `src/launcher/`                                                                                | Access menu, server supervisor, Cloudflare tunnel, keys, QR code                                                                            |
| `src/server/app.ts`                                                                            | The core: the durable harness over `pocket.sqlite`, the coordinator every commit goes through, connected tabs, access, and the session list |
| `src/server/attribution.ts`, `workspace.ts`, `transcripts.ts`                                  | Who Pi works for; a conversation's folder and its stored history, as people reach them                                                      |
| `src/server/room.ts`                                                                           | One conversation's shared live view, sent to every tab watching it                                                                          |
| `src/server/commands.ts`                                                                       | What people ask of Pi: messages, forks, models, plan mode, goals, schedules, worktrees                                                      |
| `src/server/collab.ts`                                                                         | The people's side: chat, activity lines, reactions, pins, notes, take turns                                                                 |
| `src/server/http.ts`, `http/`                                                                  | Web files, JSON API, server-sent events, uploads, artifacts, invites, the Browser panel's frames and input                                  |
| `src/server/browser.ts`, `browser/`                                                            | The built-in browser: one headless Chromium over the DevTools protocol, a page per conversation                                             |
| `src/server/projection.ts`                                                                     | Turns committed conversation state into compact JSON for browsers                                                                           |
| `src/server/docs.ts`                                                                           | Durable documents: sessions, chat, pins, notes, artifacts, subagents, schedules, goals, spend                                               |
| `src/server/schedules.ts`, `goals.ts`, `spend.ts`, `changes.ts`, `branches.ts`, `worktrees.ts` | One feature each, with its durable tasks or git calls                                                                                       |
| `src/server/push.ts`, `alerts.ts`                                                              | Dependency-free Web Push (RFC 8291 and RFC 8292), and who gets which notification                                                           |
| `src/server/extensions/`                                                                       | Live-reloaded extensions: system prompt, artifacts, browser, subagents, schedules, goals, plan mode, Lancet Guard, codemode                 |
| `web/`                                                                                         | The app: Preact and htm as plain ES modules                                                                                                 |

Browsers render only committed state. Each session's Pi Durable view is coalesced and sent as small updates over server-sent events, so a device that reconnects or joins late sees exactly what everyone else sees. The [engineering page](https://tannermidd.github.io/pi-pocket/engineering.html) explains the design; [docs/map.md](docs/map.md) is a short map of the code.

## Development

```bash
npm run check   # type-check
npm test        # server tests with a scripted model
npm run format  # ESLint's layout fixes, then Prettier
npm run lint    # check the layout rules
```

Changes to `web/` reload every open browser. Changes to `src/server/extensions/` are reinstalled into the running server. Other server changes need **Restart server** from the menu, and running work resumes afterward. [AGENTS.md](AGENTS.md) covers editing Pi Pocket safely from inside itself, and `node test/serve.ts` runs a throwaway copy, with its own data and a scripted model, to check a change on.

Pi knows where Pi Pocket's own documentation is: [docs/index.md](docs/index.md) starts it, for agents and people who change how Pi works without code ([customizing](docs/customizing.md)), write extensions ([extensions](docs/extensions.md), with [tested examples](docs/examples/)), or change Pi Pocket itself while it runs ([self-editing](docs/self-editing.md)).

## Limitations

- Pi Durable is experimental, and its API can change between releases. Versions are pinned in `package.json`.
- Only one server process can use the database at a time.
- Forks are separate sessions; there is no branch tree to switch between inside one session.
- Pi's own extensions are not supported: Pi Pocket runs its own extensions on Pi Durable, and drop-ins from `~/.pi-pocket/extensions/`. Pi's prompt templates work as slash commands.
- A git worktree keeps a session's files apart; it is not a sandbox. Pi can still reach everything you can.
- Artifacts run in an opaque-origin sandbox, so `localStorage` and cookies are unavailable inside them.
- The browser needs Chromium, Chrome, Brave, or Edge on the server. Its pages live in memory: a restart opens each one again at its last address, but not what was typed into it. Each session's cookies are its own and last until the page closes. A browser installed as a snap (Ubuntu's Chromium) is used only when there is no other; it cannot open files outside your home folder. The list of servers running on the machine is Linux-only. Tested on Linux and macOS; not yet on Windows.

## Credits

Inspired by [Mario Zechner's demo](https://x.com/badlogicgames/status/2106452296087302173) of his own Pi app. Pi Pocket is an independent project, not affiliated with Earendil. JetBrains Mono is bundled under the [SIL Open Font License](web/fonts/OFL.txt).

## License

[MIT](LICENSE). To report a security problem, see [SECURITY.md](SECURITY.md).
