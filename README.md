<div align="center">

# Pi Pocket

**Your Pi coding agent, in your pocket.**

A durable, multiplayer, mobile-first web app for Pi agents, built on [Pi Durable](https://earendil.com/posts/pi-durable/).<br>
Runs on your own machine or directly on your phone. No cloud VM.

[![Release](https://img.shields.io/github/v/release/TannerMidd/pi-pocket?color=7aa2f7)](https://github.com/TannerMidd/pi-pocket/releases)
[![Node.js 22.19+](https://img.shields.io/badge/node-%E2%89%A5%2022.19-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![MIT license](https://img.shields.io/badge/license-MIT-ff9e64)](LICENSE)

[Website](https://tannermidd.github.io/pi-pocket/) · [Quick start](#quick-start) · [Feature tour](docs/features.md) · [Docs](https://tannermidd.github.io/pi-pocket/docs/)

<img src="docs/showcase-0.12.1.png" alt="Pi Pocket in the Tokyo Night theme, on a desktop and a phone. On the desktop, the session list beside a conversation where Pi has fixed a sign-in redirect loop, its edits and a passing run of 48 tests folded into a timeline. On the phone, the same session after a teammate, Alex, asks for the push: Lancet Guard waits for approval before git push." width="100%">

</div>

## Highlights

- **Durable.** Every model call, tool call, and subagent is stored as it happens. Restart the server mid-run, and the work continues.
- **Multiplayer.** Share a live session with presence, a side chat Pi does not see, invites, and roles.
- **Made for phones.** Push notifications, dictation, sharing into Pi from other apps, and a home-screen app.
- **PiP.** An assistant that starts, follows, and reports on your other sessions, and watches GitHub for you.
- **Your models.** Pi's own providers, sign-ins, skills, and prompt templates, with the model chosen per session.
- **Live-editable.** No build step. Pi can change Pi Pocket while it runs, and you can add your own extensions.

The [feature tour](docs/features.md) covers everything else, from plan mode and peek tiles to the built-in browser.

## Quick start

Requires Node.js 22.19 or newer. Runs on Linux, macOS, Windows, and Android (Termux); Linux is the most tested. Sign in to a provider with Pi first (`pi`, then `/login`), or later from the app's Providers sheet.

```bash
npm install -g pi-pocket
pi-pocket
```

Newer npm may print "install-scripts ... not yet covered by allowScripts" for `@google/genai` and `protobufjs`, which come from Pi's model library. The warning is expected: Pi Pocket needs neither script. `npm config set allow-scripts=@google/genai,protobufjs --location=user` quiets it by letting both run, which does no harm.

Or try it with `npx pi-pocket`. To change Pi Pocket's code, run a git checkout instead:

```bash
git clone https://github.com/TannerMidd/pi-pocket.git
cd pi-pocket
npm install
npm start
```

The launcher asks how your devices should connect, then prints a sign-in link and a QR code. The link is the owner's key: keep it private. `--rotate-token` replaces it and signs out every device that used it.

While it runs: **q** quit · **r** restart server · **a** change access · **o** open in browser · **s** show QR code.

**Updating:** Menu → **Update Pi Pocket** updates a git checkout run with `npm start`, or a global npm install (`npm install -g pi-pocket`) that your user can write, and restarts. It goes back by itself if the new version does not start ([features](docs/features.md)). A local install (`npm install pi-pocket` in a project) and `npx pi-pocket` do not update from the app: the sheet says what to run, `npm install pi-pocket@latest` or `npx pi-pocket@latest`. By hand: stop the server, back up `~/.pi-pocket`, pull, run `npm install`, and start again; for a global install, run `npm install -g pi-pocket@latest`. If the machine stops at the very moment of the switch, `pi-pocket` may not start; `npm install -g pi-pocket` restores it. Read the [release notes](https://github.com/TannerMidd/pi-pocket/releases) first: 0.21.0 upgrades the database one way, so going back needs the backup.

### Other ways to run it

- **Docker or Podman:** `docker compose up -d --build`. See [docs/docker.md](docs/docker.md).
- **Nix:** `nix run github:TannerMidd/pi-pocket`, or the NixOS module `services.pi-pocket.enable = true;` ([nix/module.nix](nix/module.nix)).
- **Android (Termux):**

    ```bash
    pkg update && pkg upgrade && pkg install nodejs git
    npm install -g --ignore-scripts @earendil-works/pi-coding-agent
    pi    # /login, then quit
    git clone https://github.com/TannerMidd/pi-pocket.git
    cd pi-pocket && npm install --ignore-scripts && termux-wake-lock && npm start
    ```

    Lancet Guard may not load on Android. If it is on but fails, start with `PI_POCKET_GUARD=off`.

## Remote access

Choose a mode in the launcher, or pass `--access`:

| Mode              | Who can connect      | Notes                                                      |
| ----------------- | -------------------- | ---------------------------------------------------------- |
| `local`           | This machine         | `127.0.0.1`; bring your own tunnel to port 8787            |
| `lan`             | Your local network   | Plain http                                                 |
| `cloudflare`      | Anyone with the link | Free https quick tunnel, no account; needs `cloudflared`   |
| `tailscale`       | Your tailnet         | Plain http on the tailnet address                          |
| `tailscale-serve` | Your tailnet         | https at the tailnet name; needs `tailscale` 1.52 or newer |

`tailscale-serve` needs the `tailscale` command on your `PATH`, signed in, with MagicDNS and HTTPS certificates enabled in the tailnet. It serves port 443 at the machine's tailnet name, and a server restart keeps the address. When the launcher quits it takes down the mount it made; one it found already in place is left where it is. Without the command the launcher says so and stops rather than falling back to this device only when nobody is there to pick another mode. `--host` cannot be combined with it: serve always listens on `127.0.0.1` and lets tailscaled reach it. For another tunnel (ngrok), choose `local` and point it at port 8787.

Other options: `--port` (8787), `--cwd`, `--data` (`~/.pi-pocket`), `--host`, and `-y` to reuse the last access choice. `--host` overrides the address a named mode would listen on, and one launcher runs per data folder (a second one says which pid holds it). `npm start -- --help` lists them all. `PI_POCKET_BROWSER` and `PI_POCKET_BROWSER_ARGS` pick the built-in browser and its flags when Chromium or Chrome is not found by itself. `PI_POCKET_PROMPT_DATE=1` puts today's date in Pi's system prompt; it is left out by default, so the prompt cache does not start over when the date changes. `PI_POCKET_SESSION_CACHE=off` keeps browsers from saving the sessions they open on the device (IndexedDB), so that they keep them in each tab's memory only; it is on by default. `PI_POCKET_CACHE_KEEPER=off` turns off the prompt cache keeper, which keeps a model's prompt cache warm while a run waits on a tool call ([features](docs/features.md)).

> [!WARNING]
> Anyone who can steer a session can make Pi run commands on this machine, as you. That reaches your files, Pi Pocket's own settings and tokens, and its code. Invite only people you would trust at your keyboard. View-only users cannot make Pi act. [SECURITY.md](SECURITY.md) says what is protected and what is not.

## Documentation

- [Feature tour](docs/features.md): every feature, in full.
- [Docs site](https://tannermidd.github.io/pi-pocket/docs/): customizing Pi without code, and writing extensions.
- [Engineering](https://tannermidd.github.io/pi-pocket/engineering.html) and [code map](docs/map.md): how Pi Pocket is built.

## Development

```bash
npm run check   # type-check
npm test        # server tests with a scripted model
npm run format  # ESLint's layout fixes, then Prettier
npm run lint    # check the layout rules
```

`web/` changes reload every open browser, and extensions reload into the running server. `node test/serve.ts` runs a throwaway copy to check a change on. [AGENTS.md](AGENTS.md) covers editing Pi Pocket safely from inside itself, and [CONTRIBUTING.md](CONTRIBUTING.md) how to send a change.

## Limitations

- Pi Durable is experimental, and its API can change between releases. Versions are pinned in `package.json`.
- Only one server process can use the database at a time.
- Pi's own extensions are not supported. Pi Pocket runs its own, on Pi Durable.
- A git worktree keeps a session's files apart; it is not a sandbox.
- The built-in browser needs Chromium, Chrome, Brave, or Edge on the server. It is tested on Linux and macOS.

The [full list](docs/features.md#limitations) has the details.

## Credits and license

Inspired by [Mario Zechner's demo](https://x.com/badlogicgames/status/2106452296087302173) of his own Pi app. Pi Pocket is an independent project, not affiliated with Earendil. The bundled fonts keep their own licenses, which are beside them in [web/fonts/](web/fonts/).

[MIT](LICENSE). To report a security problem, see [SECURITY.md](SECURITY.md).
