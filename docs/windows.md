# The Windows installer

Each release has `Pi-Pocket-Setup-<version>.exe` on its [GitHub release page](https://github.com/TannerMidd/pi-pocket/releases), with a `.sha256` file beside it. It installs Pi Pocket for your Windows account, with no admin rights and no Node.js of your own. Windows 10 (1809) or newer on x64, or Windows 11 on Arm through x64 emulation.

The installer is thin: it puts Node.js and a small start script on the disk, then installs the `pi-pocket` npm package. Setup needs the internet for that step.

## SmartScreen

The installer is not code-signed yet, so Windows SmartScreen says "Windows protected your PC" the first time. To run it, select **More info**, then **Run anyway**. Download it only from the release page, and compare its SHA256 with the `.sha256` file if you want to be sure that it is the same file:

```powershell
Get-FileHash .\Pi-Pocket-Setup-0.29.0.exe -Algorithm SHA256
```

## What it installs, and where

Everything goes in `%LOCALAPPDATA%\Pi Pocket` (`C:\Users\<you>\AppData\Local\Pi Pocket`):

| Folder or file              | What it is                                                                                                                                                                   |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node\`                     | A portable Node.js LTS, the official `win-x64` zip. The build checks its SHA256 against the value pinned in [`packaging/windows/build.ps1`](../packaging/windows/build.ps1). |
| `app\`                      | A private npm prefix that holds the `pi-pocket` package. It is yours, so updates from the app work.                                                                          |
| `pi-pocket.cmd`             | Starts the launcher with that Node.js and prefix. Arguments go to `pi-pocket` (`pi-pocket.cmd --help`).                                                                      |
| `npm-cache\`, `install.log` | npm's cache, and what npm printed during Setup.                                                                                                                              |

Setup always uses its own Node.js, also when you have one: an update of your Node.js, or its removal, does not break Pi Pocket, and in-app updates always have a prefix that they can write. Your own Node.js and npm are not changed.

Your data (sessions, sign-ins, settings, extensions) stays in `%USERPROFILE%\.pi-pocket`, as with every other install.

Setup also makes:

- a Start menu entry, **Pi Pocket**, which opens the launcher in a console window. New sessions start in your user folder.
- with the task **Start Pi Pocket when I sign in to Windows** (off by default), a shortcut in your Startup folder. It starts the launcher minimized with `--yes`, so it uses the last access mode without asking.

Close the console window, or press **q** in it, to stop Pi Pocket.

Inside sessions, `node` and `npm` are the installer's own, and a global npm install (`npm install -g …`) goes into Pi Pocket's prefix. Pi's `bash` tool needs [Git for Windows](https://git-scm.com/download/win), or another `bash.exe` on `PATH` (Pi's own Windows guide is `docs/windows.md` in the `@earendil-works/pi-coding-agent` package). Setup says so at the end when it cannot find Git Bash.

Background tasks (Pi's `background` tool) work on Windows since 0.30.0, with Git Bash. Windows has no process groups or signals, so Pi Pocket follows a task's processes another way: a small Windows PowerShell helper (no admin rights) reads the process table, puts each task in a job object, and ends a process only after it checks the process's start time. What is weaker than on Linux and macOS:

- A stop ends the processes by force at once, with no polite stop first.
- A process that leaves a task's job and its tree (a program started through a service, or one that asks to leave its job) is not followed, and a task does not say what it left running.
- The task's first process holds a handle to its job, so a restarted server finds the job again while that process runs. Once it ended, a restarted server knows the processes found before the restart, and what they start directly; a process started through Git Bash (which starts a program as a new process) is then not followed.
- A PowerShell in Constrained Language mode (a locked-down machine) cannot load the helper: then background tasks do not start, and say why.

## Updates

Menu → **Update Pi Pocket** updates the package in `app\`, as for any global npm install, and restarts. The Node.js in `node\` stays the one that Setup installed. A newer installer brings a newer Node.js; run it over the old install. It stops a running Pi Pocket first (it asks), and it keeps a newer package that the app already updated to.

## Uninstall

Settings → Apps → Installed apps → **Pi Pocket** → Uninstall. It stops a running Pi Pocket, with each command that its agents run, and removes `%LOCALAPPDATA%\Pi Pocket` and the shortcuts. Then it asks whether to delete your data in `%USERPROFILE%\.pi-pocket`. The default is No: your sessions and settings stay for the next install. A silent uninstall (`unins000.exe /VERYSILENT`) always keeps them. Only the default data folder is offered: one chosen with `PI_POCKET_DIR` or `--data` stays, and so does a `.pi-pocket` that another Pi Pocket install on the same account uses.

## Silent install

```powershell
.\Pi-Pocket-Setup-0.29.0.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /TASKS=startup
```

Leave out `/TASKS=startup` for no sign-in shortcut. The exit code is 20 when the npm step fails; `install.log` says why.

## How it is built

[`.github/workflows/windows-installer.yml`](../.github/workflows/windows-installer.yml) builds it on GitHub's Windows runner for each published release, with Inno Setup (its installer checked against a pinned SHA256 too), and attaches it to the release. It runs beside the npm publish and does not wait for it. Only a release build is signed, and only when the `windows-signing` environment has the signing secrets that the workflow names; limit that environment to `v*` tags and give it a reviewer.

[`.github/workflows/windows.yml`](../.github/workflows/windows.yml) runs on each pull request: it builds the installer with a package packed from the pull request, installs it silently, starts Pi Pocket, checks that it answers HTTP and that the sign-in link works, and uninstalls it while it runs. It also runs `npm run check` and the part of the test suite that passes on Windows.

Windows is still the least tested platform. The browser tests and most of the test suite do not run on Windows yet.
