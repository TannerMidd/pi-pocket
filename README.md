<div align="center">

# Pi Pocket

**Your Pi coding agent, in your pocket.**

Start a coding session on your computer, check its diff on your phone, and invite a teammate to the same conversation. Pi runs on your machine, in your project, with your models. No cloud VM required.

[![Release](https://img.shields.io/github/v/release/TannerMidd/pi-pocket?color=7aa2f7)](https://github.com/TannerMidd/pi-pocket/releases/latest)
[![Node.js 22.19+](https://img.shields.io/badge/node-%E2%89%A5%2022.19-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![MIT license](https://img.shields.io/badge/license-MIT-ff9e64)](LICENSE)

<a name="documentation"></a>

[Quick start](#quick-start) · [Highlights](#highlights) · [Feature tour](docs/features.md) · [Website](https://tannermidd.github.io/pi-pocket/) · [Docs](https://tannermidd.github.io/pi-pocket/docs/)

<img src="https://tannermidd.github.io/pi-pocket/shots/desktop.webp" alt="Desktop: review a test diff while another session waits for approval to push." width="74%"> <img src="https://tannermidd.github.io/pi-pocket/shots/pip-phone.webp" alt="Phone: check in on other sessions with PiP." width="21%">

</div>

## Highlights

- **Relay.** Connect a Discord, Slack, Telegram, or Matrix conversation to a Pi session. Ask Pi about a failing build in chat and get its reply there. The connector opens the connection from your machine; you don’t need a public server. [Relay setup](docs/extensions/relay.md).
- **Agent orchestration.** Give a subagent a focused job while you keep working. Enable **Agent Teams** when a task needs its own session: the parent can send follow-ups, and the linked session reports back. **PiP** can follow several sessions and tell you which one needs you.
- **Durable work.** Restart the server and [Pi Durable](https://earendil.com/posts/pi-durable/) resumes the run. Schedule a check for tomorrow or watch a pull request so failed checks and reviews come back to the session.
- **Multiplayer.** Invite a teammate to watch or steer. Review a diff on your phone, put a follow-up in the queue, or talk in a side chat Pi doesn’t read.
- **Browser and artifacts.** Watch Pi test a page in Chromium or open a diagram beside the conversation. To try another approach without changing the original files, fork the session into a git worktree.

**In the [0.31 beta](https://github.com/TannerMidd/pi-pocket/releases/tag/v0.31.0-beta.4): optional classification.** Relay triage can screen messages from unmarked senders and replies to them. Run outcomes can label a subagent’s or linked session’s report without replacing its answer. Both send text to the classifier provider you choose; with no classifier selected, neither makes a call. Jev Hub shows classifier activity. These features aren’t in the stable install below.

## Quick start

With **Node.js 22.19 or newer**:

```bash
npm install -g pi-pocket
pi-pocket
```

Or try `npx pi-pocket`. Choose how your devices should connect, then open the launcher’s sign-in link or scan its QR code. **Keep that link private: it signs you in as the owner.** In the app, open **Providers** to connect a model provider, or use an existing Pi sign-in. Start a session in the folder you want Pi to work in.

**Prefer a desktop app?** Download the [latest stable release](https://github.com/TannerMidd/pi-pocket/releases/latest). Both installers include Node.js and install for your account without admin rights. They are unsigned; the platform guides cover verification and first launch.

- <a name="windows-installer"></a>**Windows:** [`Pi-Pocket-Setup-<version>.exe`](docs/windows.md). Install Git for Windows if you need Pi’s shell tools and don’t already have Bash.
- <a name="macos-package"></a>**macOS:** [`Pi-Pocket-<version>.pkg`](docs/macos.md) for Apple silicon or Intel, macOS 13.5 or newer.
- <a name="other-ways-to-run-it"></a>**Other setups:** [Android with Termux](docs/running.md#android-termux) · [Docker or Podman](docs/docker.md) · [Nix](flake.nix) (`nix run github:TannerMidd/pi-pocket`) · [Linux systemd service](docs/systemd.md).

**Updates:** Menu → **Update Pi Pocket** handles supported installs. For local npm installs, `npx`, or rollback precautions, see [updates and backups](docs/running.md#updates-and-backups).

## Remote access

Choose `local` for this machine, `lan` for a trusted local network (plain HTTP), `tailscale` or `tailscale-serve` for your tailnet, or `cloudflare` for a public HTTPS tunnel that still requires sign-in. The [launcher guide](docs/running.md#remote-access) lists prerequisites and flags. In the desktop app, use **Menu → Sign in another device**.

> [!WARNING]
> Anyone who can steer Pi can run commands as your user. A session invite limits what someone sees in the app, not which files Pi can reach. Give steering access only to people you would trust at your keyboard. [Security model](SECURITY.md).

### Behind a reverse proxy on a Unix socket

On a shared host, use `--socket` in a protected directory rather than proxying to a TCP port another user could claim during a restart. See [socket permissions, Caddy, and nginx examples](docs/running.md#behind-a-reverse-proxy-on-a-unix-socket).

## Development

```bash
git clone https://github.com/TannerMidd/pi-pocket.git
cd pi-pocket
npm install
npm start
```

There’s no build step. Run `npm run check` for types and API references, `npm run lint` for style, and `npm test` for the test suite. Use `node test/serve.ts` to try changes on an isolated copy. See [Contributing](CONTRIBUTING.md), the [code map](docs/map.md), and [safe self-editing](docs/self-editing.md).

## Limitations

One server process owns the database. Git worktrees separate files; they are not sandboxes. The built-in browser needs a Chromium-based browser on the host. Pi Pocket has its own extension API; Pi CLI extensions do not run unchanged. [Full limitations](docs/features.md#limitations).

## Credits and license

Inspired by [Mario Zechner’s Pi app demo](https://x.com/badlogicgames/status/2106452296087302173). Pi Pocket is an independent project, not affiliated with Earendil. [MIT](LICENSE); the [bundled fonts](web/fonts/) and dependencies retain their own licenses, including [libheif-js](https://github.com/catdad-experiments/libheif-js) (LGPL-3.0). [Report a security problem privately](SECURITY.md#reporting-a-problem).
