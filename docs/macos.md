# The macOS package

Each release has `Pi-Pocket-<version>.pkg` on its [GitHub release page](https://github.com/TannerMidd/pi-pocket/releases), with a `.sha256` file beside it. It installs Pi Pocket for your macOS account, with no admin password and no Node.js of your own. macOS 13.5 (Ventura) or newer, on Apple silicon or Intel: one package fits both.

The package is thin: it puts Node.js and a small launcher on the disk, then installs the `pi-pocket` npm package. The installer needs the internet for that step.

## Gatekeeper

The package is not signed or notarized yet, so macOS does not open it with a double-click: it says that Apple could not check it for malicious software. To install it anyway:

1. Double-click the package, and select **Done** (or **OK**) in the warning.
2. Open **System Settings → Privacy & Security**. Near the bottom, it says that "Pi-Pocket-….pkg" was blocked. Select **Open Anyway**, and confirm with your password or Touch ID. This allows only this file; the install itself asks for no admin rights.

On macOS 14 and older, Control-click the package in Finder, select **Open**, then **Open** again. Download it only from the release page, and compare its SHA256 with the `.sha256` file if you want to be sure that it is the same file:

```sh
shasum -a 256 ~/Downloads/Pi-Pocket-0.29.0.pkg
```

## What it installs, and where

The installer has one place to install: **Install for me only**. Everything goes in `~/Library/Application Support/Pi Pocket`:

| Folder or file                                       | What it is                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node/`                                              | Node.js, from the official `darwin-arm64` and `darwin-x64` tarballs. The build checks each against the SHA256 pinned in [`packaging/macos/build.sh`](../packaging/macos/build.sh), and joins their two `node` files into one universal file; each half is the official file, byte for byte, with its signature. |
| `app/`                                               | A private npm prefix that holds the `pi-pocket` package. It is yours, so updates from the app work.                                                                                                                                                                                                             |
| `pi-pocket`                                          | Starts the launcher with that Node.js and prefix. Arguments go to `pi-pocket` (`pi-pocket --help`).                                                                                                                                                                                                             |
| `Pi Pocket.command`                                  | What Terminal runs for Pi Pocket (console).                                                                                                                                                                                                                                                                     |
| `uninstall.sh`, `login-item.sh`, `stop-pi-pocket.sh` | The uninstaller, the switch of the sign-in item, and what stops a running Pi Pocket for the installer and the uninstaller.                                                                                                                                                                                      |
| `install-app.mjs`                                    | Installs the `pi-pocket` npm package into `app/` during the install.                                                                                                                                                                                                                                            |
| `npm-cache/`, `install.log`                          | npm's cache, and what npm printed during the install.                                                                                                                                                                                                                                                           |

The package always uses its own Node.js, also when you have one (from Homebrew, nvm, or nodejs.org): an update of your Node.js, or its removal, does not break Pi Pocket, and in-app updates always have a prefix that they can write. Your own Node.js and npm are not changed.

Your data (sessions, sign-ins, settings, extensions) stays in `~/.pi-pocket`, as with every other install.

The package also makes:

- **Pi Pocket.app** in the Applications folder of your home folder (`~/Applications`), the desktop app. It opens Pi Pocket in a window of its own, already signed in, with no Terminal window, and puts **π** in the menu bar with **Open Pi Pocket**, **Restart Server**, and **Quit Pi Pocket**. The server listens on this Mac only. To sign in your phone, use Menu → **Sign in another device** in the window. Close the window and Pi Pocket keeps running in the menu bar; open the app again to show it. A second server never starts. The window shows the Dock badge and notifications while the app runs. It starts the launcher in your login shell, so your `PATH` from `~/.zprofile` (Homebrew, for example) reaches the sessions. [desktop-app.md](desktop-app.md) says how it works.
- **Pi Pocket (console).app** beside it, which opens the launcher in a Terminal window, as Pi Pocket.app did before: there you choose how other devices reach Pi Pocket (the local network, a Cloudflare tunnel, Tailscale), and it shows the sign-in link and its QR code. Press **q** in the Terminal window, or close it, to stop it. When it runs, Pi Pocket.app uses its server instead of starting one.
- If another app of either name is in `~/Applications`, the installer leaves it, and Pi Pocket's app stays in the install folder. Spotlight and Launchpad find both. New sessions start in your home folder.
- with the choice **Start Pi Pocket when I sign in** (off by default, and on when an earlier install has it on; select **Customize** on the Installation Type page), a LaunchAgent, `~/Library/LaunchAgents/io.github.tannermidd.pi-pocket.plist`. From the next sign-in, it starts Pi Pocket.app in the menu bar, without a window. macOS lists it in System Settings → General → Login Items. To turn it on or off later:

```sh
"$HOME/Library/Application Support/Pi Pocket/login-item.sh" on   # or off
```

**Quit Pi Pocket** (in the menu bar, or ⌘Q) stops the server, with each command that its agents run, and closes the window. A GUI install opens Pi Pocket.app at the end. The app's log is `~/Library/Logs/Pi Pocket/launcher.log`; it has no sign-in link.

Inside sessions, `node` and `npm` are the package's own, and a global npm install (`npm install -g …`) goes into Pi Pocket's prefix. Pi's tools work best with git: macOS asks to install the Xcode Command Line Tools the first time something runs `git`, or run `xcode-select --install`.

## Updates

Menu → **Update Pi Pocket** updates the package in `app/`, as for any global npm install, and restarts. The Node.js in `node/` stays the one that the package installed. A newer package brings a newer Node.js; install it over the old one. It stops a running Pi Pocket first (work in progress continues when Pi Pocket starts again), and it keeps a newer `pi-pocket` that the app already updated to.

## Uninstall

A macOS package has no uninstaller of its own. Run this in Terminal:

```sh
"$HOME/Library/Application Support/Pi Pocket/uninstall.sh"
```

Run it in Terminal, not from a Pi Pocket session: it must stop Pi Pocket, so it refuses to run inside it. It asks first. It quits Pi Pocket.app, stops a running Pi Pocket, with each command that its agents run, and removes `~/Library/Application Support/Pi Pocket`, Pi Pocket.app, Pi Pocket (console).app, the sign-in item, and the package receipts. Then it asks whether to delete your data in `~/.pi-pocket`. The default is No: your sessions and settings stay for the next install. `--yes` skips the first question; without a terminal it asks nothing and keeps the data, unless you add `--delete-data`. Only the default data folder is offered: one chosen with `PI_POCKET_DIR` or `--data` stays. Another Pi Pocket install on the same account (npm, or a git checkout) uses the same `~/.pi-pocket`: the question says so, and a yes deletes it for that install too.

## Install from Terminal

```sh
installer -pkg Pi-Pocket-0.29.0.pkg -target CurrentUserHomeDirectory
```

No `sudo`: the package refuses to install as root. For the sign-in item too, pass `-applyChoiceChangesXML` with a file that selects the choice `login`, as [`.github/workflows/macos.yml`](../.github/workflows/macos.yml) does. The install fails when the npm step fails; `install.log` says why.

## How it is built

[`.github/workflows/macos-installer.yml`](../.github/workflows/macos-installer.yml) builds it on GitHub's macOS runner for each published release with `pkgbuild` and `productbuild`, and attaches it to the release. Pi Pocket.app is compiled there with `swiftc` for arm64 and x86_64, joined with `lipo`, and signed ad hoc, unless the `macos-signing` environment also has a "Developer ID Application" certificate (`MACOS_APPLICATION_CERTIFICATE` and `MACOS_APPLICATION_PASSWORD`): then it is signed with it and the hardened runtime. Without that certificate the package is not notarized, as notarization refuses code that is signed ad hoc. It runs beside the npm publish and does not wait for it. Only a release build is signed, and only when the `macos-signing` environment has the "Developer ID Installer" certificate that the workflow names; with the notary secrets too, it is notarized and stapled. Limit that environment to `v*` tags and give it a reviewer.

[`.github/workflows/macos.yml`](../.github/workflows/macos.yml) runs on each pull request, on Apple silicon and on Intel: it builds the package with a package packed from the pull request, installs it without `sudo`, starts the console launcher, checks that it answers HTTP and that the sign-in link works, and uninstalls it while it runs. Then it installs it again with the sign-in item and opens Pi Pocket.app: it checks that no Terminal opens, that the window signed in with a one-time link, that a second start opens the first, and that **Quit** stops everything. It starts the sign-in item, installs over the running Pi Pocket (which keeps the sign-in item), and uninstalls it with the data. It also runs `npm run check` and the test suite, without the tests that do not pass on macOS yet. The workflow skips them by name, and `test/pip-board-ui.test.ts` as a whole:

- Tests that press Ctrl or Alt for a shortcut. On a Mac the app takes ⌘ and Option instead (`APPLE` in `web/ui.js`), so the shortcut does not come. The PiP board tests stop at their first Alt+A, and each later test in that file needs the page that it left.
- Time limits and animations: the performance limits of the design lint and the RSS parser, the stall limits of helpers, and the glide of new rows. The macOS runner is slower than these limits allow.
- Some browser tests of the design workspace, drafts, linked sessions, and Markdown extension points, which time out on the runner. Nobody has looked into them yet.

Tests that need Linux's `/proc` skip by themselves on macOS.

Background tasks work on macOS since 0.30.0: Pi Pocket reads the process table with `ps`, and the environment of your own processes with `ps -E`, to follow a task's processes.

The install through the Installer app (a double-click), the Gatekeeper steps, signing, and notarization are not tested in CI, and the app has been tried only on GitHub's runners, not yet on a Mac of its own.
