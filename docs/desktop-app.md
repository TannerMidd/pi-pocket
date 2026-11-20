# The desktop apps

The Windows installer and the macOS package install a desktop app: **Pi Pocket**. It opens like any other app, with no console or Terminal window. It runs the server on this computer only, shows Pi Pocket in a window of its own that is already signed in, and puts an icon in the notification area (Windows) or the menu bar (macOS) with **Open**, **Restart server**, and **Quit**. [windows.md](windows.md) and [macos.md](macos.md) say how to install and remove it; this page says how it works.

The console launcher stays, as **Pi Pocket (console)**: it has the access menu (the local network, a Cloudflare tunnel, Tailscale), the keys, and the sign-in QR code.

## How it opens

|                       | Windows                                                                             | macOS                                                                                          |
| --------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| The app               | `Pi Pocket.exe`, C# for the .NET Framework 4.x that Windows has                     | `Pi Pocket.app`, Swift and AppKit, one file for Apple silicon and Intel                        |
| Its source            | [`packaging/windows/PiPocket.cs`](../packaging/windows/PiPocket.cs)                 | [`packaging/macos/app/main.swift`](../packaging/macos/app/main.swift)                          |
| The window            | Edge in app mode (`msedge --app`), with a profile of its own                        | A `WKWebView` window, with the app bridge ([embedders.md](embedders.md)): badge, notifications |
| Its icon              | The notification area. A click opens the window                                     | **π** in the menu bar. Closing the window keeps it there; the Dock icon goes with the window   |
| At sign-in (optional) | The Startup shortcut runs `Pi Pocket.exe --hidden`: the icon only                   | A LaunchAgent runs `open -g -a Pi Pocket.app --args --hidden`: the menu bar item only          |
| The log               | `%LOCALAPPDATA%\Pi Pocket\launcher.log`, and `launcher.old.log` from the run before | `~/Library/Logs/Pi Pocket/launcher.log`, and `launcher.old.log`                                |

1. **One app per user.** A second start (the Start menu again, Spotlight, the Dock) asks the first one to show its window, then exits. Windows uses a named mutex and event in the session's `Local\` namespace; macOS a distributed notification. `--quit` asks the running one to quit, as its **Quit** does; the installers use it.
2. **A server that runs already is used.** Each launcher writes `launcher-running.json` in the data folder when its server is ready, and removes it when it quits ([`src/launcher/desktop.ts`](../src/launcher/desktop.ts)): its process, the server's local address, and whether a desktop app started it. The app uses that server when the process is there and `GET /api/pocket/info` answers. **Quit** then leaves it running: another launcher, such as Pi Pocket (console), started it.
3. **Otherwise the app checks the package, then starts a launcher.** It reads the version in the `package.json` of the `pi-pocket` package in `app\` (Windows) or `app/` (macOS). When there is none, it is older than the app's own version, or (on Windows) `app\setup-finished.txt` is missing, which Setup writes after it copied the package, it shows a message that says what is wrong and to run Setup or the package again, writes it to the log, and starts nothing: a launcher older than the app does not know `--desktop`, and would fail with only "Unknown argument" in the log. A newer package is an in-app update, and starts. The installers put their own package in place, so only an install that did not finish leaves an older one. Then the app starts `pi-pocket --desktop`, with the install's own Node.js. `--desktop` means: this device only (unless `--access` says otherwise), no access menu, no keys, no sign-in link and no QR code in its output, and the choice is not saved as the console's last one. It stops when its standard input closes. The app holds that input: **Quit** closes it, and so does the end of the app, also when it crashes.
4. **The window signs in.** See below.

On Windows the launcher and everything it starts (the server, the commands of the agents, the Edge window) are in a job object that ends with the app, so nothing runs on after it, even when the app is killed. Edge's window closes on **Quit**, with the server it shows. Without Edge, the default browser opens the one-time link; it is not in the job, and stays.

On macOS the app starts the launcher through the user's login shell (`zsh -l`, or the user's own `bash`, `sh`, `ksh`, or `dash`), so the `PATH` of `~/.zprofile` (Homebrew, for example) reaches the sessions, as it does in Terminal. **Quit**, a logout, and a `SIGTERM` (from the installer) close the launcher's input and send it `SIGTERM`; after 20 seconds it gets `SIGKILL`.

## Sign-in

The owner's token is the key to the whole server, so it is never on a command line, in a window title, in the log, or in a crash report. The app reads it from `config.json` in the data folder, which only this user can read, and asks the server for a one-time sign-in link:

```
POST /api/sign-in-link          Authorization: Bearer <owner token>, X-Pocket: 1
→ { "path": "/login?once=<code>", "expiresInMs": 60000 }
```

Only the owner can ask. The code is 32 random bytes, works once, and ends after a minute; the server keeps it only in memory, and at most 8 wait at once. `GET /login?once=<code>` sets the owner's sign-in cookie and goes on to the app, like the owner's `/login?token=` link. It does not ask before it switches a browser that is signed in as someone else (that question would put the token in the page): the app's window is the owner's own.

On Windows the one-time link is on Edge's command line, and only there: it is spent within a second, and then worth nothing. Edge's profile (`%LOCALAPPDATA%\Pi Pocket\Edge profile`) keeps the cookie, as a browser does; the uninstaller deletes it. On macOS the link goes straight into the window. `WKWebView` keeps the cookie in the app's own website data.

**Restart server** sends `POST /api/restart` with the same bearer token.

## What the apps rely on

A newer installer replaces the app and its package; Menu → **Update Pi Pocket** replaces only the package. So an installed app runs against newer `pi-pocket` packages, never older ones (it refuses them), and these stay as they are: `--desktop`, `launcher-running.json` (its fields only grow), `/api/pocket/info`, `/api/sign-in-link`, `/login?once=`, and `/api/restart`.

## What the window does not do yet

- macOS: no Web Push in a `WKWebView`, so notifications come through the app bridge while the app runs. Approvals in a notification have no **Allow** or **Deny** buttons: a click opens the session.
- Windows: Edge's app window is Edge. It has Edge's notifications, downloads, and file dialogs.
- A server on a Unix socket (`--socket`) has no address for the window: the app cannot use it, and its own launcher cannot start while that one runs.

## How it is tested

[`test/launcher-desktop.test.ts`](../test/launcher-desktop.test.ts) runs `--desktop`: `launcher-running.json`, the one-time link, no token in the output, and the stop when its input closes. On each pull request, [`windows.yml`](../.github/workflows/windows.yml) and [`macos.yml`](../.github/workflows/macos.yml) install the app, open it as the Start menu or Finder does, and check: no console or Terminal window, the server on this computer only, a window that signed in (on Windows, Edge spent the one-time link; on macOS, the window's own `/api/me` answers 200), no token in the log or on a command line, one instance only, and **Quit** that stops the launcher, the server, and the window. They also take a screenshot of the window. Then they write an older version into the package's `package.json`, and check that the app shows its message, writes it to the log, and starts no launcher. Nobody has tried them yet on a real PC or Mac, only on GitHub's runners.
