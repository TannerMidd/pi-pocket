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
| `Pi Pocket.command`, `Pi Pocket at sign-in.command`  | What Terminal runs for the app and for the sign-in item.                                                                                                                                                                                                                                                        |
| `uninstall.sh`, `login-item.sh`, `stop-pi-pocket.sh` | The uninstaller, the switch of the sign-in item, and what stops a running Pi Pocket for the installer and the uninstaller.                                                                                                                                                                                      |
| `install-app.mjs`                                    | Installs the `pi-pocket` npm package into `app/` during the install.                                                                                                                                                                                                                                            |
| `npm-cache/`, `install.log`                          | npm's cache, and what npm printed during the install.                                                                                                                                                                                                                                                           |

The package always uses its own Node.js, also when you have one (from Homebrew, nvm, or nodejs.org): an update of your Node.js, or its removal, does not break Pi Pocket, and in-app updates always have a prefix that they can write. Your own Node.js and npm are not changed.

Your data (sessions, sign-ins, settings, extensions) stays in `~/.pi-pocket`, as with every other install.

The package also makes:

- **Pi Pocket.app** in the Applications folder of your home folder (`~/Applications`). If another app of that name is there, the installer leaves it, and Pi Pocket.app stays in the install folder. Spotlight and Launchpad find it. It opens the launcher in a Terminal window, in your login shell, so your `PATH` from `~/.zprofile` (Homebrew, for example) reaches the sessions. New sessions start in your home folder.
- with the choice **Start Pi Pocket when I sign in** (off by default, and on when an earlier install has it on; select **Customize** on the Installation Type page), a LaunchAgent, `~/Library/LaunchAgents/io.github.tannermidd.pi-pocket.plist`. From the next sign-in, it opens the launcher in Terminal with `--yes`, so it uses the last access mode without asking. macOS lists it in System Settings → General → Login Items. To turn it on or off later:

```sh
"$HOME/Library/Application Support/Pi Pocket/login-item.sh" on   # or off
```

Press **q** in the Terminal window, or close it, to stop Pi Pocket. A GUI install starts Pi Pocket at the end.

Inside sessions, `node` and `npm` are the package's own, and a global npm install (`npm install -g …`) goes into Pi Pocket's prefix. Pi's tools work best with git: macOS asks to install the Xcode Command Line Tools the first time something runs `git`, or run `xcode-select --install`.

## Updates

Menu → **Update Pi Pocket** updates the package in `app/`, as for any global npm install, and restarts. The Node.js in `node/` stays the one that the package installed. A newer package brings a newer Node.js; install it over the old one. It stops a running Pi Pocket first (work in progress continues when Pi Pocket starts again), and it keeps a newer `pi-pocket` that the app already updated to.

## Uninstall

A macOS package has no uninstaller of its own. Run this in Terminal:

```sh
"$HOME/Library/Application Support/Pi Pocket/uninstall.sh"
```

Run it in Terminal, not from a Pi Pocket session: it must stop Pi Pocket, so it refuses to run inside it. It asks first. It stops a running Pi Pocket, with each command that its agents run, and removes `~/Library/Application Support/Pi Pocket`, Pi Pocket.app, the sign-in item, and the package receipts. Then it asks whether to delete your data in `~/.pi-pocket`. The default is No: your sessions and settings stay for the next install. `--yes` skips the first question; without a terminal it asks nothing and keeps the data, unless you add `--delete-data`. Only the default data folder is offered: one chosen with `PI_POCKET_DIR` or `--data` stays. Another Pi Pocket install on the same account (npm, or a git checkout) uses the same `~/.pi-pocket`: the question says so, and a yes deletes it for that install too.

## Install from Terminal

```sh
installer -pkg Pi-Pocket-0.29.0.pkg -target CurrentUserHomeDirectory
```

No `sudo`: the package refuses to install as root. For the sign-in item too, pass `-applyChoiceChangesXML` with a file that selects the choice `login`, as [`.github/workflows/macos.yml`](../.github/workflows/macos.yml) does. The install fails when the npm step fails; `install.log` says why.

## How it is built

[`.github/workflows/macos-installer.yml`](../.github/workflows/macos-installer.yml) builds it on GitHub's macOS runner for each published release with `pkgbuild` and `productbuild`, and attaches it to the release. It runs beside the npm publish and does not wait for it. Only a release build is signed, and only when the `macos-signing` environment has the "Developer ID Installer" certificate that the workflow names; with the notary secrets too, it is notarized and stapled. Limit that environment to `v*` tags and give it a reviewer.

[`.github/workflows/macos.yml`](../.github/workflows/macos.yml) runs on each pull request, on Apple silicon and on Intel: it builds the package with a package packed from the pull request, installs it without `sudo`, starts Pi Pocket, checks that it answers HTTP and that the sign-in link works, and uninstalls it while it runs. Then it installs it again with the sign-in item, opens Pi Pocket.app, starts the sign-in item, installs over the running Pi Pocket (which keeps the sign-in item), and uninstalls it with the data. It also runs `npm run check`. It also runs the background task tests (`test/background-platforms.test.ts`) and the quiet-limit tests (`test/deadlines.test.ts`). The rest of the test suite does not pass on macOS yet: some tests compare `/var` paths with their real `/private/var` paths, and some read Linux's `/proc`.

Background tasks work on macOS since 0.30.0: Pi Pocket reads the process table with `ps`, and the environment of your own processes with `ps -E`, to follow a task's processes.

The install through the Installer app (a double-click), the Gatekeeper steps, signing, and notarization are not tested in CI.
