<div align="center">

<img src="web/icon.svg" alt="Pi Pocket" width="112">

# Pi Pocket

**Your Pi coding agent, in your pocket.**

A durable, multiplayer, mobile-first web app for Pi agents, built on [Pi Durable](https://earendil.com/posts/pi-durable/).<br>
Runs on your own machine or directly on your phone. No cloud VM.

[![Node.js 22.18+](https://img.shields.io/badge/node-%E2%89%A5%2022.18-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![Built on Pi Durable](https://img.shields.io/badge/built%20on-Pi%20Durable-ff9e64)](https://earendil.com/posts/pi-durable/)
![No build step](https://img.shields.io/badge/build%20step-none-7aa2f7)

[Quick start](#quick-start) · [Features](#features) · [Remote access](#remote-access) · [Architecture](#architecture)

</div>

<table>
<tr>
<td width="50%" valign="top">

**Durable**<br>
Every model call, tool call, and subagent is a durable task in SQLite. Restart the server mid-run and the work picks up where it left off.

</td>
<td width="50%" valign="top">

**Multiplayer**<br>
Share a live session across devices and people: steer, queue, chat, pin, react, and take turns.

</td>
</tr>
<tr>
<td valign="top">

**Any provider, any model**<br>
Uses Pi's own model runtime and sign-ins. Choose the model and thinking level per session.

</td>
<td valign="top">

**Built for phones**<br>
Streaming chat, tool cards with diffs and live output, push notifications, and a home-screen app.

</td>
</tr>
<tr>
<td valign="top">

**Live-editable**<br>
No build step. Edit the web app or an extension and it reloads in place, even while Pi is editing itself.

</td>
<td valign="top">

**Artifacts and subagents**<br>
Publish sandboxed HTML, Markdown, and SVG artifacts. Run background subagents you can open and talk to.

</td>
</tr>
</table>

## Quick start

Requires Node.js 22.18 or newer (26 recommended). Sign in to a provider with Pi first (`pi`, then `/login`), or later from the app's Providers sheet.

```bash
git clone https://github.com/TannerMidd/pi-pocket.git
cd pi-pocket
npm install
npm start
```

The launcher asks how your devices should connect, then prints the address, a sign-in link, and a QR code. Open the link once per browser; the cookie lasts a year. The link is the owner's key, so keep it private. `--rotate-token` replaces it and signs out every device.

While it runs: **q** quit · **r** restart server · **a** change access · **o** open in browser · **s** show QR code.

## Features

- **Durable runs.** An interrupted tool call reruns if that is safe; otherwise the model is told it was interrupted.
- **Steer or queue.** Redirect a running agent, queue follow-ups, withdraw them, or stop.
- **Collaboration.** Presence, typing notices, a side chat Pi does not see, @mentions, pins, reactions, and shared notes.
- **Take turns.** One person drives at a time; others ask to drive.
- **Roles and invites.** Steer or view-only access, to every session or just one, through one-time links and QR codes.
- **Push notifications.** When Pi finishes, needs approval, or someone mentions you (https required).
- **Lancet Guard.** Optional checks on bash, write, and edit calls. Risky calls wait for someone in the session to approve.
- **Extensions sheet.** The owner can turn Artifacts, Subagents, and Lancet Guard on or off, or reload them.
- **Uploads and images.** Attach or paste files. Images show inline and go straight to models that accept them.
- **Theme.** Tokyo Night colors, Omarchy's square shapes, JetBrains Mono.

The full tour is in [docs/features.md](docs/features.md).

## Remote access

Choose a mode in the launcher, or pass `--access`:

| Mode | Who can connect | Notes |
| --- | --- | --- |
| `local` | This machine | Listens on `127.0.0.1` |
| `lan` | Your local network | All addresses, plain http |
| `cloudflare` | Anyone with the link | Free quick tunnel with https, no account needed. The address changes each time the launcher starts but stays the same across server restarts. |
| `tailscale` | Your tailnet | Tailscale address only, encrypted by the tailnet |

Cloudflare mode needs `cloudflared`. On Linux the launcher can download the official release into `~/.pi-pocket/bin`. To use another tunnel (ngrok, `tailscale serve`), choose `local` and point the tunnel at port 8787.

> [!WARNING]
> Anyone with steering rights can make the agent run commands on this machine. A single-session invite limits what someone sees in the app, not what Pi can reach. Invite only people you trust with that access. View-only users cannot make Pi act.

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

Lancet Guard needs ONNX Runtime, which may not load on Android. If the guard is on but cannot load, it blocks every command its rules cannot clear. Turn it off in `~/.pi/lancet-guard.json`, or start with `PI_POCKET_GUARD=off`.

## Configuration

| Option | Default | Purpose |
| --- | --- | --- |
| `--access <mode>` | last choice | Skip the access menu |
| `-y` | | Reuse the last access choice |
| `--port` | `8787` | Port to listen on |
| `--cwd` | current folder | Default folder for new sessions |
| `--data` | `~/.pi-pocket` | Database, settings, uploads, and push keys |
| `--host` | | Listen on a specific address instead of choosing access |
| `--rotate-token` | | Issue a new owner link and sign out all devices |

Environment variables: `PI_POCKET_ACCESS`, `PI_POCKET_DIR`, `PI_POCKET_HOST`, `PI_POCKET_PORT`, `PI_POCKET_GUARD=off`. Without a terminal (under systemd, for example), the launcher uses `--access` or the last choice.

## Architecture

| Path | Role |
| --- | --- |
| `bin/pi-pocket.js` | Entry point: checks the Node version, starts the launcher |
| `src/launcher/` | Access menu, server supervisor, Cloudflare tunnel, keys, QR code |
| `src/server/app.ts` | Durable harness over `pocket.sqlite`, sessions, shared live views, commands |
| `src/server/http.ts` | Web files, JSON API, server-sent events, uploads, artifacts, invites |
| `src/server/projection.ts` | Turns committed conversation state into compact JSON for browsers |
| `src/server/docs.ts` | Durable documents: sessions, chat, pins, notes, artifacts, subagents, guard decisions |
| `src/server/push.ts` | Dependency-free Web Push (RFC 8291 and RFC 8292) |
| `src/server/extensions/` | Live-reloaded extensions: system prompt, artifacts, subagents, Lancet Guard |
| `web/` | The app: Preact and htm as plain ES modules |

Browsers render only committed state. Each session's Pi Durable view is coalesced and sent as small updates over server-sent events, so a device that reconnects or joins late sees exactly what everyone else sees.

## Development

```bash
npm run check   # type-check
npm test        # server tests with a scripted model
```

Changes to `web/` reload every open browser. Changes to `src/server/extensions/` are reinstalled into the running server. Other server changes need **Restart server** from the menu, and running work resumes afterward. [AGENTS.md](AGENTS.md) covers editing Pi Pocket safely from inside itself.

## Limitations

- Pi Durable is experimental, and its API can change between releases. Versions are pinned in `package.json`.
- Only one server process can use the database at a time.
- There are no forks or branch navigation yet. Pi extensions, prompt templates, and slash commands are not supported; Pi Pocket runs its own extensions on Pi Durable.
- Artifacts run in an opaque-origin sandbox, so `localStorage` and cookies are unavailable inside them.

## Credits

Inspired by [Mario Zechner's demo](https://x.com/badlogicgames/status/2106452296087302173) of his own Pi app. JetBrains Mono is bundled under the [SIL Open Font License](web/fonts/OFL.txt).
