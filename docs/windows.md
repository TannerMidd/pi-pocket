# The Windows installer

Each release has `Pi-Pocket-Setup-<version>.exe` on its [GitHub release page](https://github.com/TannerMidd/pi-pocket/releases), with a `.sha256` file beside it. It installs Pi Pocket for your Windows account, with no admin rights and no Node.js of your own. Windows 10 (1809) or newer on x64, or Windows 11 on Arm through x64 emulation.

The installer holds everything: Node.js, the `pi-pocket` package of its release with its dependencies, and the desktop app. Setup needs no internet and no npm, so it works behind a company proxy or firewall that blocks npm, and as soon as the release is out, before npm has it.

## SmartScreen

The installer is not code-signed yet, so Windows SmartScreen says "Windows protected your PC" the first time. To run it, select **More info**, then **Run anyway**. Download it only from the release page, and compare its SHA256 with the `.sha256` file if you want to be sure that it is the same file:

```powershell
Get-FileHash .\Pi-Pocket-Setup-0.30.0.exe -Algorithm SHA256
```

## What it installs, and where

Everything goes in `%LOCALAPPDATA%\Pi Pocket` (`C:\Users\<you>\AppData\Local\Pi Pocket`):

| Folder or file       | What it is                                                                                                                                                                   |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node\`              | A portable Node.js LTS, the official `win-x64` zip. The build checks its SHA256 against the value pinned in [`packaging/windows/build.ps1`](../packaging/windows/build.ps1). |
| `app\`               | A private npm prefix that holds the `pi-pocket` package. It is yours, so updates from the app work. The installer's build made it with npm, as `npm install --global` does.  |
| `Pi Pocket.exe`      | The desktop app ([desktop-app.md](desktop-app.md)): the icon in the notification area and the window. Setup's build compiles it from `PiPocket.cs`.                          |
| `pi-pocket.cmd`      | Starts the launcher with that Node.js and prefix, in a console. Arguments go to `pi-pocket` (`pi-pocket.cmd --help`).                                                        |
| `stop-pi-pocket.ps1` | What stops a running Pi Pocket for Setup and the uninstaller: the app, its launcher and server with the agents' commands, the window's Edge, and the tunnel.                 |
| `Edge profile\`      | The Edge profile of the app's window, with its sign-in cookie.                                                                                                               |
| `launcher.log`       | What the app's launcher and server print, and `launcher.old.log` from the run before. It has no sign-in link.                                                                |
| `npm-cache\`         | npm's cache, for in-app updates.                                                                                                                                             |

Setup always uses its own Node.js, also when you have one: an update of your Node.js, or its removal, does not break Pi Pocket, and in-app updates always have a prefix that they can write. Your own Node.js and npm are not changed.

Your data (sessions, sign-ins, settings, extensions) stays in `%USERPROFILE%\.pi-pocket`, as with every other install.

Setup also makes:

- a Start menu entry, **Pi Pocket**, the desktop app. It opens Pi Pocket in a window of its own, already signed in, with no console window, and puts Pi Pocket's icon in the notification area: click it to open the window, or right-click it for **Open Pi Pocket**, **Restart server**, and **Quit Pi Pocket**. The server listens on this PC only. To sign in your phone, use Menu → **Sign in another device** in the window. Opening Pi Pocket again shows the window that runs; a second server never starts. The window is Microsoft Edge in app mode, with a profile of its own; without Edge, your default browser opens Pi Pocket. [desktop-app.md](desktop-app.md) says how it works.
- a Start menu entry, **Pi Pocket (console)**, which opens the launcher in a console window, as before: there you choose how other devices reach Pi Pocket (the local network, a Cloudflare tunnel, Tailscale), and it shows the sign-in link and its QR code. Close the console window, or press **q** in it, to stop it. When it runs, the app uses its server instead of starting one.
- with the task **Start Pi Pocket when I sign in to Windows** (off by default), a shortcut in your Startup folder. It starts the app with its icon only, without a window.

New sessions start in your user folder. **Quit Pi Pocket** stops the server, with each command that its agents run, and closes the window.

Inside sessions, `node` and `npm` are the installer's own, and a global npm install (`npm install -g …`) goes into Pi Pocket's prefix. Pi's `bash` tool needs [Git for Windows](https://git-scm.com/download/win), or another `bash.exe` on `PATH` (Pi's own Windows guide is `docs/windows.md` in the `@earendil-works/pi-coding-agent` package). Setup says so at the end when it cannot find Git Bash.

Background tasks (Pi's `background` tool) work on Windows since 0.30.0, with Git Bash. Windows has no process groups or signals, so Pi Pocket follows a task's processes another way: a small Windows PowerShell helper (no admin rights) reads the process table, puts each task in a job object, and ends a process only after it checks the process's start time. What is weaker than on Linux and macOS:

- A stop ends the processes by force at once, with no polite stop first.
- A task's job does not let its processes leave it (Git Bash leaves a job that allows it), so a program in a task that asks to start a process outside its job gets "access denied". A process started outside the task (through a service or the Task Scheduler) is not followed, and a task does not say what it left running.
- The task's first process holds a handle to its job, so a restarted server finds the job again while that process runs. Once it ended, a restarted server knows the processes found before the restart, and what they start directly; a process started through Git Bash (which starts a program as a new process) is then not followed.
- A PowerShell in Constrained Language mode (a locked-down machine) cannot load the helper: then background tasks do not start, and say why.

## Machines that block links

Some enterprise policies refuse links and junctions. Drop-in extensions work there too: Pi Pocket resolves the packages that they import (`@earendil-works/pi-mcp`, `preact`, and the rest) from its own packages, with no link. The drop-in folder then has no `node_modules` junction, and the server log says once why. `_pocket.d.ts` is a copy of the types file, and the folder's `tsconfig.json` gives an editor the packages' types. See [extensions/modules.md](extensions/modules.md) and [extensions/reference/types.md](extensions/reference/types.md).

## Updates

Menu → **Update Pi Pocket** updates the package in `app\`, as for any global npm install, and restarts; it needs npm's registry. The Node.js in `node\` stays the one that Setup installed. A newer installer brings a newer Node.js and its own package; run it over the old install. It stops a running Pi Pocket first (it asks), and it keeps a newer package that the app already updated to.

The desktop app checks the package before it starts it: when `app\` holds an older `pi-pocket` than the app itself (an install that did not finish), it says so in a message and starts nothing. Run the same Setup again to put its package back.

## Uninstall

Settings → Apps → Installed apps → **Pi Pocket** → Uninstall. It quits the app, stops a running Pi Pocket, with each command that its agents run, and removes `%LOCALAPPDATA%\Pi Pocket` (with the window's Edge profile) and the shortcuts. Then it asks whether to delete your data in `%USERPROFILE%\.pi-pocket`. The default is No: your sessions and settings stay for the next install. A silent uninstall (`unins000.exe /VERYSILENT /SUPPRESSMSGBOXES`) always keeps them. Only the default data folder is offered: one chosen with `PI_POCKET_DIR` or `--data` stays, and so does a `.pi-pocket` that another Pi Pocket install on the same account uses.

## Silent install

```powershell
.\Pi-Pocket-Setup-0.30.0.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /TASKS=startup
```

Leave out `/TASKS=startup` for no sign-in shortcut.

## How it is built

[`.github/workflows/windows-installer.yml`](../.github/workflows/windows-installer.yml) builds it on GitHub's Windows runner for each published release, with Inno Setup (its installer checked against a pinned SHA256 too), and attaches it to the release. [`packaging/bundle-app.mjs`](../packaging/bundle-app.mjs) makes `app\` there: with the pinned Node.js and its npm, it packs the release tag (with `npm-shrinkwrap.json`, as the npm release has it), installs that package globally into a new prefix without install scripts, and checks the version, the start script, the shrinkwrap, and that no dependency is for one platform only. `Pi Pocket.exe` is compiled with the C# compiler of the .NET Framework 4.x in Windows itself (`csc.exe`), so it needs no download. It runs beside the npm publish and does not need it. Only a release build is signed, and only when the `windows-signing` environment has the signing secrets that the workflow names; limit that environment to `v*` tags and give it a reviewer.

[`.github/workflows/windows.yml`](../.github/workflows/windows.yml) runs on each pull request: it builds the installer with the package of the pull request, blocks npm's registry (its names in `hosts`, and an `NPM_CONFIG_REGISTRY` that refuses), installs it silently, starts the console launcher, checks that it answers HTTP and that the sign-in link works, and stops it. Then it opens the app from its Start menu entry, and checks that no console window shows, that Edge's window signed in with a one-time link, that a second start opens the first, and that **Quit** stops everything. With an older version in the package's `package.json`, the app must show its message and start nothing, and Setup must put its own package back; with a newer one, Setup must keep it. It starts the app as the Startup shortcut does, and uninstalls it while it runs. It also runs `npm run check` and the part of the test suite that passes on Windows.

Windows is still the least tested platform. The browser tests and most of the test suite do not run on Windows yet, and the app has been tried only on GitHub's runners, not yet on a PC of its own.
