# Pi Pocket

A durable, multiplayer, mobile-first web app for Pi agents, built on [Pi Durable](https://earendil.com/posts/pi-durable/).

It is a clone of what Mario Zechner showed in [this post](https://x.com/badlogicgames/status/2106452296087302173): a "Claude for Android" replacement that runs directly on the phone (no cloud VM), lets you pick any provider and model, is multiplayer, can be live-edited from inside itself, has subagents, and has artifacts. His version is a personal project and is not public, so this one was rebuilt from the video, his earlier post, and Pi Durable's documentation and examples.

## What it does

- **Durable runs.** Every model request, tool call, queued message, and subagent is a durable task in one SQLite file. Kill the server mid-run and start it again: the run continues. A tool call that was cut off reruns if it is safe to; otherwise the model is told it was interrupted.
- **Its own theme.** Tokyo Night colors with Omarchy's shapes: square tiles, thin borders, no shadows, JetBrains Mono throughout (bundled in `web/fonts/` under the SIL Open Font License), and Omarchy's cyan-to-green active border on the message box while you type.
- **Chat UI for phones.** Sessions, streaming answers, collapsible thinking, and tool cards for read, write, edit (with diffs), and bash (with live output). While Pi works you can **steer** the run or **queue a follow-up**, withdraw queued messages, or stop.
- **Any provider or model.** Uses Pi's own model runtime and sign-ins (`~/.pi/agent/auth.json`): pick a model and thinking level per session, and sign in to providers (API key or subscription) from the Providers sheet.
- **Multiplayer.** Any number of browsers can watch and steer the same session live. The status line shows connected clients, cache hit rate, context use, and cost. "Sign in another device" makes a one-time invite link and QR code. Messages show who sent them.
- **Working together.** The top bar shows who else is in the session (dimmed when their tab is in the background), and "Alex is writing to Pi…" warns before two people steer at once. The **People** panel has:
  - **Chat** for the people in the session, which Pi does not see. Type `@` to mention someone (they get a notice wherever they are), tap **Discuss** under a reply of Pi's to quote it, and tap a chat message to **Send to Pi**, pin, or copy it. Changes show up here as activity lines ("Alex stopped the run", "Tanner switched the model to …", "Alex allowed the bash call: …"), and as a notice to everyone else in the session.
  - **Pinned** replies and chat messages.
  - **Notes**: one shared page per session. Saving over someone else's newer save asks first.
  - Under Pi's answers: emoji reactions, **Discuss**, and **Pin**. Queued messages show who queued them. Approved or denied tool calls show who decided.
- **Take turns.** Menu → **Take turns**: one person drives and only they send to Pi or change its settings. Others tap **Ask to drive**, the driver hands over, and anyone can take the wheel when the driver has left (the owner always can). Anyone who can steer can still stop a run.
- **Roles and invites.** An invite can let someone **steer** or make them **view only** (they read, react, and chat, but cannot send to Pi, approve, or upload). It can cover **every session** or **only this session**. Menu → **People** lists everyone, who is online, and when the others were last here. The owner can change what each person may do or remove them. The session list shows who is in each session, and a dot marks new chat messages.
- **Notifications.** Menu → **Notifications** turns on push notifications for a device: Pi finished, Pi needs approval, someone @mentioned you, or a chat message in a session you take part in. You only get them while you are not looking at that session. They need an https address (Cloudflare Tunnel, or Tailscale with https). On iPhone, add Pi Pocket to the home screen first. The server signs pushes with its own keys in `~/.pi-pocket/push.json`.
- **Artifacts.** The `artifact` tool publishes versioned HTML pages, Markdown documents, or SVG images that open in a sandboxed viewer (or their own tab). Artifacts cannot reach the app or its cookies.
- **Background subagents.** The `subagent` tool spawns named subagents that work in their own conversations while you keep talking. Open one to watch it or talk to it; its answer is reported back to the main agent. Optional per-subagent model, thinking level, and tool list.
- **Live editing.** No build step. Edit a file in `web/` and every open browser reloads. Edit a file in `src/server/extensions/` and it is reinstalled into the running server (a running tool call finishes on the old code). For core server changes, use **Restart server** in the menu: running work resumes after the restart.
- **Lancet Guard.** If `specpi-lancet-guard` is installed in Pi and turned on, its rules and classifier check every bash, write, and edit call. A "risky" or "unsure" verdict shows Allow/Deny buttons to everyone in the session; the answer survives restarts.
- **Extensions sheet.** Menu → **Extensions** (or tap "guard" in the status line) lists Pi Pocket's extensions with their tools and any load error. The owner can turn Artifacts, Subagents, or Lancet Guard off and on, or reload one; the change applies to every session at once, stays after restarts (`disabledExtensions` in `~/.pi-pocket/config.json`), and everyone in a session sees who changed what. Turning Lancet Guard off here leaves Pi's own setting (`~/.pi/lancet-guard.json`) alone. The system prompt cannot be turned off.
- **Uploads.** Attach files (or paste images). Files are saved on the server and their paths are given to the agent; images also go straight to models that accept them.
- **Images inline.** Attached images show as thumbnails (also in the composer before you send). When Pi writes `![description](path)` with a path on the server (absolute, `~/…`, or relative to the session's folder), the image shows in its reply. Images a tool returns and SVG artifacts show inline too. Tap any image to see it full screen. Only real image files are shown: the server checks a file's bytes, not just its name.
- **Launcher.** `npm start` asks how your devices should reach Pi Pocket: this device only, the local network, a Cloudflare Tunnel, or Tailscale. It then shows the address and a QR code to sign in your phone, and keeps running with keys to restart the server or change access.

## Run it

Needs Node.js 22.18 or newer (26 recommended). Sign in to a provider with Pi first (`pi`, then `/login`), or use the Providers sheet later.

```bash
cd pi-pocket
npm install
npm start                    # pick how devices connect; new sessions start in the current directory
# or skip the menu: node bin/pi-pocket.js --access cloudflare --cwd ~/projects
```

The launcher asks how your devices should reach the server (arrow keys, Enter), remembers the answer, and then shows the address, a sign-in link, and a QR code to scan with your phone. Open the sign-in link once per browser; the cookie lasts a year. Keep the link private: it is the owner's key. `--rotate-token` replaces it and signs out every device that used the old one.

While it runs, press **q** to quit, **r** to restart the server (running work resumes), **a** to change access, **o** to open the app in this machine's browser, and **s** to show the sign-in QR code again.

Options: `--access local|lan|cloudflare|tailscale` (skip the menu), `-y` (use the last choice), `--port` (default `8787`), `--cwd` (default folder for new sessions), `--data` (default `~/.pi-pocket`), `--host` (listen on a specific address instead of choosing access), `--rotate-token`. Without a terminal (for example under systemd), it uses `--access` or the last choice. Environment: `PI_POCKET_ACCESS`, `PI_POCKET_DIR`, `PI_POCKET_HOST`, `PI_POCKET_PORT`, `PI_POCKET_GUARD=off`.

### On an Android phone (Termux)

```bash
pkg update && pkg upgrade
pkg install nodejs git
npm install -g --ignore-scripts @earendil-works/pi-coding-agent   # Pi, for /login
pi                                                                 # /login, then quit
# copy the pi-pocket folder to the phone, then:
cd pi-pocket && npm install --ignore-scripts && npm start
```

Open the printed link in Chrome, then "Add to Home screen" for an app-like window. Run `termux-wake-lock` so Android does not stop Termux while it works.

Lancet Guard needs ONNX Runtime, which may not load on Android. When the guard is on but cannot load, it fails closed and blocks commands its rules cannot clear. Either keep it off in `~/.pi/lancet-guard.json` on the phone, or start with `PI_POCKET_GUARD=off`.

### Reaching it from other devices

Pick one in the launcher, or with `--access`:

| Access | Who can connect | How |
| --- | --- | --- |
| This device only (`local`) | This machine | Listens on `127.0.0.1` |
| Local network (`lan`) | Devices on the same network | Listens on all addresses; plain http |
| Cloudflare Tunnel (`cloudflare`) | Anyone with a link, from anywhere | A free Cloudflare quick tunnel to `127.0.0.1`: an https `….trycloudflare.com` address, no account needed. The address is new each time the launcher starts, but stays the same across server restarts |
| Tailscale (`tailscale`) | Devices on your tailnet | Listens on this machine's Tailscale address only; plain http inside the encrypted tailnet |

Cloudflare needs `cloudflared`. If it is missing, the launcher offers to download Cloudflare's official release into `~/.pi-pocket/bin` (Linux), or tells you how to install it (`brew install cloudflared`, `pkg install cloudflared` on Termux). Its log goes to `~/.pi-pocket/cloudflared.log`. Invites made on this machine use the tunnel's address automatically.

For other tunnels (ngrok, `tailscale serve` for https), choose **This device only** and point the tunnel at port 8787, then make invites from the tunnel's address.

Anyone who joins with steering rights can make the agent run commands on the server. Only invite people you trust that much. An invite to one session limits what they see in the app, not what Pi can reach on the machine. View-only people cannot make Pi do anything.

## How it is built

| Path | Role |
| --- | --- |
| `bin/pi-pocket.js` | Entry point: checks the Node version and runs the launcher |
| `src/launcher/` | The launcher: access menu, server supervisor (restarts on exit code 75 or a crash), Cloudflare tunnel, keys, QR code |
| `src/server/main.ts` | Arguments, HTTP server, file watchers, shutdown |
| `src/server/app.ts` | The Harness over `pocket.sqlite`, sessions, live views shared by clients, commands, provider sign-in |
| `src/server/http.ts` | Routes: web files, JSON API, server-sent events, uploads, images, artifacts, invites |
| `src/server/projection.ts` | Turns committed conversation state into compact JSON for browsers |
| `src/server/docs.ts` | Pi Pocket's durable documents: sessions, authors, artifacts, subagents, chat, reactions, pins, notes, take turns, guard decisions |
| `src/server/push.ts` | Web Push without dependencies: message encryption (RFC 8291), VAPID (RFC 8292), subscriptions and preferences |
| `src/server/extensions/` | Live-reloaded extensions: system prompt, artifacts, subagents, Lancet Guard hook |
| `src/server/lancet.ts` | Loads the Lancet Guard installed in Pi |
| `web/` | The app: Preact and htm as plain ES modules, no build step |

The browser only renders committed state: each session's Pi Durable view (`viewState()`), coalesced and sent as small updates over server-sent events. Anything shown has already been stored, so a reconnecting or late-joining device sees exactly what the others see.

## Checks

```bash
npm run check   # TypeScript
npm test        # server tests with a scripted model: sessions, artifacts, subagents, reopen
```

## Limits

- Pi Durable is experimental; its API can change between releases. Versions are pinned in `package.json`.
- One server process owns the database at a time.
- No forks or branch navigation in the UI yet, and no Pi extensions, prompt templates, or slash commands: Pi Pocket runs its own extensions on Pi Durable, not Pi's.
- Artifacts run in a sandbox with an opaque origin, so `localStorage` and cookies are unavailable inside them.
