<div align="center">

# Pi Pocket

**Your Pi coding agent, in your pocket.**

Start a coding session on your computer, check its diff on your phone, and invite a teammate to the same conversation. Pi runs on your machine, in your project, with your models. No cloud VM required.

[![Release](https://img.shields.io/github/v/release/TannerMidd/pi-pocket?color=7aa2f7)](https://github.com/TannerMidd/pi-pocket/releases/latest)
[![Node.js 22.19+](https://img.shields.io/badge/node-%E2%89%A5%2022.19-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![MIT license](https://img.shields.io/badge/license-MIT-ff9e64)](LICENSE)

[Quick start](#quick-start) · [Feature tour](docs/features.md) · [Website](https://tannermidd.github.io/pi-pocket/) · [Docs](https://tannermidd.github.io/pi-pocket/docs/)

<img src="https://tannermidd.github.io/pi-pocket/shots/desktop.webp" alt="Desktop: review a test diff while another session waits for approval to push." width="74%"> <img src="https://tannermidd.github.io/pi-pocket/shots/pip-phone.webp" alt="Phone: check in on other sessions with PiP." width="21%">

</div>

## Quick start

With **Node.js 22.19 or newer**:

```bash
npm install -g pi-pocket
pi-pocket
```

Or try `npx pi-pocket`. Choose how your devices should connect, then open the launcher’s sign-in link or scan its QR code. **Keep that link private: it signs you in as the owner.** In the app, open **Providers** to connect a model provider, or use an existing Pi sign-in. Start a session in the folder you want Pi to work in.

**Prefer a desktop app?** Download the [latest stable release](https://github.com/TannerMidd/pi-pocket/releases/latest). Both installers include Node.js and install for your account without admin rights. They are unsigned; the platform guides cover verification and first launch.

- **Windows:** [`Pi-Pocket-Setup-<version>.exe`](docs/windows.md). Install Git for Windows if you need Pi’s shell tools and don’t already have Bash.
- **macOS:** [`Pi-Pocket-<version>.pkg`](docs/macos.md) for Apple silicon or Intel, macOS 13.5 or newer.
- **Other setups:** [Android with Termux](docs/running.md#android-termux) · [Docker or Podman](docs/docker.md) · [Nix](flake.nix) (`nix run github:TannerMidd/pi-pocket`) · [Linux systemd service](docs/systemd.md).

**Updates:** Menu → **Update Pi Pocket** handles supported installs. For local npm installs, `npx`, or rollback precautions, see [updates and backups](docs/running.md#updates-and-backups).

## Highlights

- **Pick up where you left off.** [Pi Durable](https://earendil.com/posts/pi-durable/) stores runs as they happen. Restart the server and the run continues; a tool call that can’t safely repeat is reported as interrupted.
- **Know which session needs you.** The Priority view separates approvals and unread results from work still running. PiP can follow sessions and report back; push notifications let you put the phone away.
- **Work together.** Invite someone to watch or steer a session. The side chat stays between people. Queue a message for Pi, steer the current run, or interrupt to change direction.
- **Inspect the work.** Read files and diffs, watch Pi use the built-in browser, or open an interactive artifact beside the conversation. Fork a session into a separate git worktree to try another approach.
- **Use your own setup.** Choose a model per session. Bring Pi’s sign-ins, skills, and prompt templates. Add tools or themes from the extension gallery, or [write your own extension](docs/extensions.md).

The [feature tour](docs/features.md) also covers subagents, scheduled messages, optional chat relays, and cleaning up archived sessions.

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
