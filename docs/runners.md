# Sessions on another computer

As the server owner, you link a computer with a one-time code:

1. In Pi Pocket, go to Menu → **Runners** → **Link a computer**. Enter a name, then choose **Get a link code**. The screen shows the server address and the code. The code works once and expires after 10 minutes.
2. Give them to the runner on that computer:
    - **With the Pi Pocket desktop app:** the app has the runner built in. In its settings, under **Runner**, enter the address and code, then choose **Link**. The app keeps the runner running while it is open.
    - **Any other computer:** install Node.js 22.19 or newer, then run:

        ```sh
        npm install -g pi-pocket@latest
        pi-pocket runner
        ```

        `pi-pocket runner` opens a menu: use the arrow keys and Enter. Choose **Link this computer**, enter the server address, such as `https://pocket.example.com`, then paste the code. The runner checks that Pi Pocket answers at that address and saves the link. Then choose **Start**, and leave the terminal open. Press Ctrl+C to stop the runner and its commands.

Only the server owner can link computers. Only link a server you trust: its session commands run as your user account on the linked computer.

**Wrong link codes.** The server counts wrong codes for each client address. Five wrong codes in 10 minutes lock that address out of linking for 10 minutes. The third lockout of an address bans it; its count starts over a week after its last lockout. A banned address gets the same answer as a wrong code. The ban stays until you lift it in **Runners**, under **Banned from linking**. The address of this server's own machine is never banned, because every client of an unnamed proxy shares it.

Above that, a ceiling catches guessing from many changing addresses: 50 wrong codes in 10 minutes from all addresses together pause new linking for 10 minutes and void every open code. Linked computers and their keys are not affected. **Runners** says when an address or the whole server is locked, and why.

The server takes the client address from the connection. It believes a proxy's header only for its own proxy: Cloudflare's `CF-Connecting-IP` behind the Cloudflare tunnel, and Tailscale Serve's `X-Forwarded-For` behind Tailscale Serve, when `tailscale whois` names that address as a device of the tailnet. Both only for requests from this machine. Without a working `tailscale` command, no address counts as a tailnet device.

The computer connects out to the server over a WebSocket. It needs no open port, SSH, or provider key. Pi, its models, the provider keys, and session history stay on the server. Sessions read and write files and run commands, including git, on the linked computer.

## Commands

Run these commands on the linked computer:

| Command                                        | What it does                                                                                                                                                                                                           |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pi-pocket runner`                             | In a terminal, opens a menu: link, start, settings, saved folders, approved sessions, unlink, and help.                                                                                                                |
| `pi-pocket runner start`                       | Runs with the saved link in this terminal or a program that runs the runner, such as the desktop app.                                                                                                                  |
| `pi-pocket runner link <server> <code>`        | Saves a link without questions. Use the server address and a one-time code from **Runners**.                                                                                                                           |
| `pi-pocket runner settings [--json]`           | Shows the settings. `settings stop-asking on\|off`, `settings totp-days 1\|7\|14\|30\|never`, `settings http allow\|refuse`, `settings network allow\|refuse`, and `settings downloads <folder>\|default` change them. |
| `pi-pocket runner folders [--json]`            | Lists saved folders, one per line, or "No saved folders yet.". A broad folder in the list is marked as ignored.                                                                                                        |
| `pi-pocket runner folders remove <folder>`     | Removes a saved folder. Unknown folders are an error. Approved sessions keep their approval.                                                                                                                           |
| `pi-pocket runner sessions [--json]`           | Lists approved sessions: id, folder, who, how they were approved, and when each expires.                                                                                                                               |
| `pi-pocket runner sessions revoke <id>\|all`   | Removes the approval of one session or all. Their next request asks again.                                                                                                                                             |
| `pi-pocket runner totp setup\|status [--json]` | Sets up an authenticator app, or shows whether one is set up.                                                                                                                                                          |
| `pi-pocket runner totp off <code> [--json]`    | Turns the authenticator off. It needs a code from it.                                                                                                                                                                  |
| `pi-pocket runner service [remove]`            | Runs as a systemd user service on Linux, or starts at sign-in with a Windows scheduled task or macOS launch agent. Needs an authenticator first. `service remove` stops and removes it and keeps the link.             |
| `pi-pocket runner status`                      | Shows the saved link, settings, and whether git and GitHub are ready. It does not check the connection.                                                                                                                |
| `pi-pocket runner unlink [--json]`             | Deletes the saved link and all runner settings on this computer. Also remove the computer in **Runners** to stop it and cancel its key.                                                                                |

The runner runs while its terminal or a program that runs the runner, such as the desktop app, is open, so that it can ask before a session starts.

### A computer nobody sits at (Linux)

`pi-pocket runner service` keeps the runner running as a systemd user service (`pi-pocket-runner.service`), for a computer such as a build server. With nobody at that computer, nobody can answer the question before a session or a folder. A code from an authenticator app, typed in Pi Pocket, is then the only way to approve one. So the service needs an authenticator on that computer: set it up first with `pi-pocket runner totp setup` in a terminal there. Without one, `pi-pocket runner service` refuses and says how to set it up, and the service itself refuses to start and is not restarted. Saved folders alone are not enough: a folder outside them could never be approved.

The service uses the Node.js, Pi Pocket, link file, and `PATH` of the shell that installed it. Install Pi Pocket with npm first (`npm install -g pi-pocket`): a copy in the npx cache is refused, because npm can clear it. Its log is in `journalctl --user -u pi-pocket-runner.service`. To keep it running while you are logged out, run `loginctl enable-linger $USER`. `pi-pocket runner service remove` stops and removes it.

### Start at sign-in (Windows and macOS)

On Windows and macOS, `pi-pocket runner service` starts the runner now and each time you sign in. These are per-user sign-in jobs, not system services: they do not run while you are signed out. As on Linux, you must first set up an authenticator on this computer with `pi-pocket runner totp setup`. Both installation and `runner start --service` refuse without one, with the same setup message. Approve sessions and folders in Pi Pocket with its codes. A copy of Pi Pocket in the npx cache is refused on all three systems; install with `npm install -g pi-pocket@latest` first.

- **Windows:** installs the **Pi Pocket runner** scheduled task in Task Scheduler. It runs as the current user at log-on, without admin rights or a password. It uses the selected Node.js, Pi Pocket, and link file, and starts in your home folder. The task can run on battery power, has no time limit, and retries failures up to 3 times, 1 minute apart. If Windows refuses registration, the command prints the PowerShell error and fails; it does not try another installation method. To check task history, open Task Scheduler → Task Scheduler Library → **Pi Pocket runner** → **History** (enable task history if needed). This history records task events; it does not save the runner's console output.
- **macOS:** writes `~/Library/LaunchAgents/dev.pi-pocket.runner.plist` and loads it into your signed-in GUI session. It uses the selected Node.js, Pi Pocket, link file, and the current shell's `PATH`. Both output and errors go to `~/Library/Logs/pi-pocket-runner.log`. launchd restarts failures with a 10-second throttle. A runner stopped permanently by the server, or missing an authenticator, prints its message and exits with code 0 in macOS service mode so launchd does not restart it. Other modes and platforms keep exit codes 3 and 4 for these cases.

`pi-pocket runner status` names a running scheduled task or launch agent. The terminal menu names the same mechanism. `pi-pocket runner service remove` stops and removes the scheduled task or launch agent, but keeps the saved link and settings.

For scripts, use `pi-pocket runner link <server> <code>`, then `pi-pocket runner start`.

The link file is `~/.pi-pocket/runner.json`. It contains this computer's key, and only your user account can read it. Do not share it. Use `--config FILE` or `PI_POCKET_RUNNER_CONFIG` to choose another file; `--config` takes priority. `PI_POCKET_RUNNER_DAEMON` selects a pi-env daemon instead of the packaged one.

Run `pi-pocket runner` again to start, change, or replace a saved link. Deleting the link file alone does not stop a runner that is already running.

If your server uses a build that is not on npm, set `PI_POCKET_RUNNER_PACKAGE` on the server. For example, use the URL of a fork's package tarball. This changes the install command shown in **Runners**.

## Approving sessions

The runner on the computer decides which sessions may use it. The server cannot decide for it.

### Folder permission

The first session in a folder asks for **folder permission**. It shows who asks, the server, and the folder. **Allow** saves the folder on this computer and approves this session. **Deny** is the default answer.

- In a terminal, the runner asks with a menu and a bell.
- In a program that runs the runner, such as the desktop app, a dialog asks.

A saved folder is permanent. Its subfolders count too. The list stays in the runner settings in its link file, not on the server, and the runner reads it again for each question. Existing folders are compared by their real paths (including symlinks); macOS and Windows comparisons ignore case. A deleted saved folder grants nothing.

A broad folder is never saved: a file system root, a drive root, your home folder, or a folder that contains your home. For one, the question offers **Allow this session only**. A broad folder found in the list is ignored, and `pi-pocket runner folders` says so. **Deny**, cancellation, and no answer save nothing.

Use **Saved folders** in the terminal menu, a program that runs the runner, or Pi Pocket's **Runners** to see the list and remove an entry. Removing needs no code. It makes future sessions there ask for folder permission again; sessions that are already approved keep their approval. There is no command to add a folder: answer a question on the computer, or enter a code from your authenticator in Pi Pocket.

### Session permission

A new session in a saved folder asks for **session permission**. **Allow** approves this session. A session's permission also covers its subagents and the linked sessions it starts in the same folder.

The setting **Stop asking on new sessions** (off by default) approves new sessions in saved folders without a question. A folder without permission still asks. The command `settings confirm on|off` is the same as `settings stop-asking off|on`.

A session's permission expires when the session is idle for a time:

- Approved at the computer, or without a question: 30 hours.
- Approved with a code from your authenticator: 7 days by default. The setting **Session expiry with a code** (`totp-days`) can be 1, 7, 14, or 30 days, or no expiry.

The clock starts when the session's last request on the computer finishes. A command that still runs keeps the session in use; a watch on files does not. The runner measures this itself.

When a session's permission expired, its next request waits, and the computer asks again. Pi Pocket shows the question in the session. **Deny** fails the request; **Cancel** in Pi Pocket cancels the question.

Use **Approved sessions** in the terminal menu, `pi-pocket runner sessions`, or Pi Pocket's **Runners** to see the approved sessions and when each expires. **Revoke** and **Revoke all** need no code. A revoked session's next request asks again.

### What a session can reach

Each request from the server names its session. The runner refuses a request before it reaches pi-env unless the session it names has a valid permission. Each path in the request must be in that permission's folder or below it, or in the session's own folders for its attached files, background task logs, browser downloads, and git worktrees (named by its permission id), or in the temporary folders the session made. Pi can also read, not change, its context files (`AGENTS.md`, `CLAUDE.md`) in the folders above, and the skills in `.agents/skills/` there and in your home folder. Commands run in the session's folder. Without a session permission, only the folder picker works: it lists folders.

This is not a sandbox. A command still runs as you, and it can read and change files outside its folder. A server that was broken into can name a session that has a valid permission; expiry limits how long that works.

### Waiting for an answer

If nobody answers within 2 minutes (5 minutes with an authenticator), the session does not start, or the waiting request fails. While the computer asks, the page shows a waiting dialog with the computer, folder, and time left. A quick answer skips the dialog. **Cancel** stops the request and cancels the question on the computer; no session starts, even if an answer comes later.

A network drop does not deny or approve a question. The question stays open in the computer's terminal or desktop app, with its original time limit, and requests waiting for approval keep waiting. When the link returns, Pi Pocket shows the open questions again, and an authenticator code can answer them. An answer to a new-session question made on the computer while offline is kept and sent after reconnecting.

## Continue a Pi session

Choose a computer in **New session**, then **Continue a Pi session…**. This lists Pi's terminal sessions on that computer. A continued session is a new Pocket session that runs on the same computer; Pi's original file is never changed.

| Step     | The server gets                                                                 | The computer asks?                                  |
| -------- | ------------------------------------------------------------------------------- | --------------------------------------------------- |
| List     | For each Pi session: path, Pi's session id, title, cwd, modified, message count | No                                                  |
| Search   | A filter on title and cwd only, done on the server over the list                | No                                                  |
| Preview  | That one session's model and last messages, as in a local preview               | Yes                                                 |
| Continue | That one session file                                                           | Yes: the normal new-session question for its folder |

The title is Pi's name for the session, or the first line of its first message, up to 80 characters. No other message text leaves the computer before approval. **Allow seeing a Pi session?** can be answered on the computer or with an authenticator code in Pocket. It saves no folder or session permission. The runner remembers a preview answer for that exact file for 10 minutes, only in memory. Cancel withdraws the question.

The runner looks in `PI_CODING_AGENT_SESSION_DIR`, then Pi's `sessionDir` setting, then Pi's default session folder. The list has at most 300 sessions, newest first, and is cached for 5 seconds. Preview and continue check Pi's list afresh. Continue first approves a new session in the Pi session's folder, then allows only that session to read that one Pi file for at most 5 minutes, never to write it. Revoking or expiring the session permission removes that access.

Files that extensions keep beside Pi's file come along too (with companion files, TannerMidd/pi-pocket#262), for example Billion Context's `.acp.json`. With the Pi file, Pocket names the suffixes the extensions here registered. The runner allows the session to read each of those that exists beside the file, the same way, and no other. Pocket reads each one, gives the extension a copy on the server, and removes the copy when the extension is done. A companion that cannot be read stays behind, and the session still opens. Runners from before this change allow only the Pi file, so nothing comes along.

## Authenticator codes

With an authenticator app (TOTP), you can approve sessions and folders, and change runner settings, from Pi Pocket without going to the computer. It is off by default. Each computer has its own.

Set it up on the computer: run `pi-pocket runner totp setup`, or choose **Authenticator** in the runner's **Settings** menu. The runner shows a QR code and an `otpauth://` link. Scan it with your authenticator app, then enter the code it shows. The runner saves the secret only when that code is right. Programs that run the runner can use `pi-pocket runner totp setup --json`: it prints `{ "secret", "link" }`, then reads one code per line on stdin and answers each with `{ "ok" }`.

With an authenticator set up:

- The waiting dialog in Pi Pocket has a field for the code from your authenticator. A right code approves the session, and saves the folder when the question was for folder permission. A wrong or used code shows "That code is wrong or used. Try the next one.", and the question stays.
- In **Runners**, each change to a setting asks for a code. One code makes one change.
- The linker and the people the owner chose can use a code to approve a session. Only the linker changes settings.

A code works once. Codes are 6 digits and change every 30 seconds; the code before and after the current one also work. After 5 wrong codes in 10 minutes, codes are refused for 10 minutes. Only the runner checks codes. The secret stays in the link file on the computer; the server never stores a code.

Turning the authenticator off needs a code too: `pi-pocket runner totp off <code>`, or the runner's **Settings** menu.

**Lost your authenticator?** Unlink this computer (`pi-pocket runner unlink`, or Unlink in a program that runs the runner, such as the desktop app), then link it again. Unlinking needs no code, because it only removes access. It deletes the link file, and with it all runner settings: the authenticator's secret, saved folders, approved sessions, and the other settings. To link again, get a new link code in Pi Pocket's **Runners**.

## Programs that run the runner

A program that runs the runner, such as the desktop app, starts it with `pi-pocket runner start --confirm-via stdio`. Each question is a line on stdout: `PI-POCKET-CONFIRM` and a JSON object with `id`, `server`, `computer`, `person`, `folder`, `kind` (`new`, `fork`, `move`, or `pi-preview`), and `broad`, and also:

- `permission`: `folder` (Allow saves the folder) or `session` (Allow approves this session). For `pi-preview`, it is `session`, but Allow permits only the preview and saves no folder or session permission; `title` names the Pi session.
- `expired`: true when an approved session's permission expired and it wants to continue.
- `session`: the id of the session's permission, as `pi-pocket runner sessions` lists it.
- `totp`: true when an authenticator is set up, so the question can also be answered in Pi Pocket.
- `expiresInMs`: how long the question waits for an answer.

The program answers with a JSON line on stdin: `{ "id": <id>, "allow": true }`. A `PI-POCKET-CONFIRM-END {"id":<id>}` line says the question no longer stands: it was answered (here or with a code in Pi Pocket), withdrawn, or timed out. For an ordinary session question, the runner saves the folder and the session before that line. A preview answer saves neither.

The runner also says when sessions work on the computer, for a tray icon, keeping the computer awake, or a warning on quit. It writes a line `PI-POCKET-ACTIVITY` and a JSON object, `{ "working": true, "folders": ["/Users/me/project"] }`, each time the state changes. The first line comes when work starts, so a program that saw none can take the runner as idle.

- `working`: sessions use this computer now.
- `folders`: the real folders of those sessions, sorted. Empty when `working` is false.

A file or command request of an approved session counts from when the runner sends it to the computer's tool process until its result, so a long command counts all the time it runs. Folder listings for the folder picker, file watches, and the browser's network connections do not count. The line says nothing about the commands, tools, or sessions themselves.

The state is smoothed, so short requests do not make it flicker. A folder shows after its work lasted 0.5 s, and stays 5 s after its last request ended, so the requests of one turn show as one stretch of work. When the runner stops, it writes a last line with `working` false if it was working.

`settings`, `folders`, `sessions`, `totp`, and `unlink` take `--json`, for programs. A command that fails with `--json` prints `{ "ok": false, "error": "..." }` and exits with code 1.

## Runner settings in Pi Pocket

**Runners** shows each computer's settings, saved folders, and approved sessions, with when each expires. Only owners see them.

- Without an authenticator, the row says "No authenticator set up. Set it up on this computer: `pi-pocket runner totp setup`", and the settings are greyed out: "Set up an authenticator for this runner to change its settings." Change them on the computer.
- With an authenticator, the row says "Authenticator set up". Each change opens a small dialog: "Enter the code from your authenticator for <computer>". **Cancel** puts the setting back.
- Removing a saved folder, and revoking one session or all, need no code.

## Plain HTTP

The runner sends this computer's key and every command to the server, so it uses HTTPS. It allows plain HTTP only:

- To this computer (`localhost`, `127.x`).
- To a device on your tailnet. The runner asks Tailscale itself (`tailscale whois`), so an address that only looks like a Tailscale address is not enough. Tailscale encrypts the traffic.

To link a server on another plain HTTP address, choose **Allow plain HTTP** when the runner asks, or run `pi-pocket runner settings http allow`. Do this only on a network you trust.

## What works in a session

In Menu → **Runners**, choose **New session** next to an online computer, then choose a folder on it. The session's title, top bar, and Pi's system prompt identify the computer. Forks keep the same computer, unless you choose another one in the fork sheet's **Computer** row. A copy can go from this server to a linked computer, back, or from one linked computer to another. A copy on a linked computer runs with that computer's list of extensions; a copy back on this server gets all extensions again. Pi gets a note with the new computer and folder, because paths earlier in the conversation were on the old ones.

Pi's `read`, `write`, `edit`, and `bash` tools run on that computer through Earendil's [pi-env](https://www.npmjs.com/package/@earendil-works/pi-env). They work as they do on the server. Goals, plans, questions, schedules, codemode, memory, PR watches, and [the browser](#the-browser) also work. Subagents and linked sessions that a session on a computer starts run on the same computer, and a linked session in the same folder starts without another question. A linked session in another folder asks as a new session does. Subagents and reconnects do not ask.

Lessons stay with each project on its own computer; worktrees of that project share them. In **Memory**, **From …** sections offer approved lessons from other copies of the same GitHub repository. Choose **Add** to save one in this project; they never apply here automatically. PR watches read the origin and current branch on the linked computer, but poll GitHub from the server with the server's `gh` sign-in, not the computer's.

The runner checks git, the GitHub CLI (`gh`), and its GitHub sign-in when it starts and reconnects. **Runners** and `pi-pocket runner status` show whether git and GitHub are ready, with an install command or `gh auth login` when needed. A computer without them still works.

These also work, on that computer:

- The **Files** and **Changes** panels, the branch list, and **Show in the file manager** (it opens there).
- **Git worktree** in the new-session and fork sheets. The worktree is made on that computer at `~/.pi-pocket/worktrees/<permission id>/<name>`, with a new branch, uncommitted changes, and up to 50 MiB of new files; ignored files stay out. A worktree keeps its session's permission, and a fork gets its own. Removing the worktree removes its folder there; its branch stays, as on the server. The approved folder must include the repository root, because git writes there.
- The folder's project context files (`AGENTS.md`, `CLAUDE.md`) and the skills there and in that computer's home folder. Project trust is kept for each computer.
- Files mentioned with `@`, read on that computer.
- Attachments: each is copied to `pi-pocket-uploads/<session>/` in that computer's temporary folder when the message is sent, and the message gives that path. `<session>` is the session's permission id on that computer, so a session reaches only its own attached files. The system can clear its temporary folder when the computer restarts: move a file you want to keep out of it.

Artifacts read their `path` and asset files on the session's computer, then keep the published bundle on the server. Automatic design-system attachments are not available there: give their files in `assets`. Images opened from that computer, or written with `write` or `edit`, are kept in the session's uploads for offline viewing (25 MiB per image, 500 MiB per session; the oldest copies are removed above that).

Background tasks run on the computer in the session's folder, on Linux, macOS, and Windows. The runner owns each task through a separate child process, not through the pi-env tool process. A network drop, a server restart, or a tool-process restart does not stop tasks. When the runner stops or crashes, its task processes stop too: on Linux and macOS, the task's process group gets a polite signal, then a forced stop after 5 seconds. On Windows, the host uses `taskkill /T /F`; a Windows Job Object also stops the process tree if the host dies. If the computer cannot set up that Job Object, the task does not start, with an error that says why: without it, a task could outlive the runner.

The shell's exit code is final when the shell ends, even if a descendant redirected its output and keeps running. The task host stays registered while the task's process group or Windows Job Object has processes left. The runner's task list marks that task with `ended: true`, and signals still reach its descendants. Linux and macOS hosts check the group about once a second. If Windows cannot inspect the remaining processes, the host stays until the runner stops. A process that leaves its group with `setsid` on Linux or macOS is outside the runner's reach.

Their logs and exit codes stay in `<temp>/pi-pocket-tasks/<permission id>/` on that computer, reachable only by their session. Running now and the log view read them there, with the same output limits as local tasks. While the computer is offline, its watch waits, then checks again when it reconnects. Completed output and exit codes reach the session when it is back. The runner checks a live session permission and the command's folder before it starts a task. On Linux and macOS, commands use Bash, or `sh` if Bash is absent. On Windows, they use an installed Bash (not the Windows WSL launcher), or `cmd.exe` if Bash is absent. Temporary files can disappear when the computer restarts.

A project's own `.pi/settings.json` and prompt templates on that computer are not read.

### Extensions

A session on another computer runs with the built-in extensions that work there, and with the drop-ins that say they do. A drop-in says so with one line in its module:

```ts
export const remoteSessions = true;
```

Other drop-ins load only in sessions on the server. A drop-in that the owner turns on or off, or that changes the line, is added to or taken out of every session on another computer, existing ones too.

The line is a promise by the module's author: its tools reach the session's files and commands only through the session (`api.env`), which is that computer's. What the module itself does with Node (`node:fs`, `node:child_process`) runs on the server, in the server's folders. A module that only works on the conversation (its history, compaction, prompts, models) needs nothing more.

## The browser

The browser tool and the **Browser** panel work in a session on another computer. Chromium runs on the server, but every connection of its pages goes out from the linked computer:

- `localhost:5173` is the linked computer's port 5173. The Browser panel lists the ports that the computer listens on (`lsof` on macOS, `/proc/net/tcp` or `ss` on Linux, `netstat` on Windows).
- Names resolve with the computer's DNS, and pages use its routes, VPN, and local network. Sites see the computer's IP address.
- Pi's model calls do not change: they go out from the server.
- File paths and `file://` addresses do not open, because the browser would read the server's disk. Serve the files instead, for example with `python3 -m http.server`.

How it works: these pages use a second Chromium on the server, with a proxy built into Pi Pocket. Each session's pages have their own proxy credentials, which name the computer. The proxy sends each connection to the runner over its link, and the runner opens the TCP connection on the computer. Chromium's own background traffic and anything without valid credentials go to a proxy that refuses everything. WebRTC sends no UDP outside the proxy, and QUIC is off. If the computer is offline, the page fails with "<name> is offline". Nothing goes out from the server.

To stop sharing the network, choose **Settings** → **Share the network with browsers** in the `pi-pocket runner` menu, or run `pi-pocket runner settings network refuse`. The runner then refuses every connection, and pages show "<name> does not share its network". The change takes effect without a restart.

The risk: pages in the browser of a session on a computer can reach that computer's network (its `localhost`, the home network, a tailnet, a VPN) like any program on it. This is part of the risk of a runner. Pi and anyone who can steer the session's Browser panel can open such pages. Link only a server you trust, and turn off network sharing if the computer must not do this. Other programs on the server cannot use the proxy, because they do not have the credentials.

**Downloads.** A file that a page downloads goes to the computer's temporary folder, in `pi-pocket-downloads/<session>/` (on macOS, the per-user `$TMPDIR`, not `/tmp`). `<session>` is the session's permission id on that computer: each session has its own folder, and the runner lets a session reach only its own, never another session's. The system can clear its temporary folder when the computer restarts, so move a file you want to keep out of it. To use another folder, run `pi-pocket runner settings downloads <folder>`. The files then go to `<folder>/<session>/`, and a session reaches only its own `<session>` folder there: the chosen folder itself, and anything else in it, stays out of reach. `pi-pocket runner settings downloads default` returns to the temporary folder. The runner tells the server about the folder when it connects, so a running runner uses a new folder after its next reconnect. The tool result gives the full path and the size. If the name is already used, the file gets a number, such as `report (2).pdf`. The bytes pass through the server: Chromium saves the file in the server's private temporary folder, Pi Pocket sends it over the runner link to the computer in parts, and then the server deletes its copy at once, also when the copy fails. Downloads larger than 2 GiB fail. In a session on the server, downloads go to `pi-pocket-downloads-<uid>/<session id>/` in the server's temporary folder. Only the server's user can open this folder (mode 0700). Pi Pocket refuses the folder if another user owns it or if it is a link.

**macOS desktop app.** On macOS 15 and later, connections to devices on the local network (not `localhost`) can need the **Local Network** permission. The desktop app runs the runner as a child process, so macOS can ask for this permission on behalf of the app. The app's `Info.plist` does not have an `NSLocalNetworkUsageDescription` yet, so the system prompt has no explanation. If pages on the local network fail with "No route to host", allow Pi Pocket in System Settings → Privacy & Security → Local Network. This was not tested on a Mac.

## Sharing

The person who linked a computer and the people the owner chose in Menu → **Runners** can start sessions on it, including forks. Their sessions run as the computer's user, with the same access to its files and commands. The linker alone changes its settings, its approvals, and who may use it. Sharing does not change this rule.

By default, a session on a linked computer is private to its creator. Other people cannot see it in their session list, open it, prompt it, or fork it. This includes other server owners. These access rules also protect a private session's forks and subagents.

The owner can turn on **Let others use these sessions** in Menu → **Runners** (`sharedRunnerSessions` in the server's `config.json`). These sessions then follow the usual sharing rules. People who can see a session can prompt it, and its commands run on the linked computer for them too. Turning sharing off closes those sessions in everyone else's tabs at once.

This setting applies to the whole server. A switch for each session (who can see it, who can prompt it, and whether tool calls need the linker's approval when someone else requested them) was considered. It was left out to keep sharing simple: Runners already holds the settings for all linked computers, so one setting there covers them.

## When the computer is offline

Offline is offline. While a linked computer is offline, its sessions are offline too: there is no grace period, and nothing fails because the computer is away. The server keeps the link's work and waits. The session shows "<computer> offline, reconnecting…", and its mark in the session list is dimmed.

| What happens                                             | What happens to the work                                                                                                                                            |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The connection drops, for any length of time             | Nothing is lost. Commands keep running on the computer. Their output arrives when the runner reconnects, and the session continues where it stopped.                |
| A tool call, or a message, while the computer is offline | It waits for the computer. Attached files are copied there when it is back. **Stop** ends the wait.                                                                 |
| The runner quits, or the computer restarts               | Commands and runner-owned background tasks stop. Commands come back as interrupted; task logs and exit codes remain. The session continues when the runner is back. |
| The server restarts                                      | Running commands return as interrupted. Background tasks keep running on the computer, and the session picks up their output when the runner reconnects.            |

Panels that show the computer's files (Files, Changes, the folder picker) say that the computer is offline instead of waiting. A new session, a fork, or a move to another folder on an offline computer cannot start: the computer must answer whether it allows the folder.

Removing a computer in **Runners** stops its runner and cancels its key. A runner that the server removed exits with code 3, except in macOS service mode, where it exits with code 0 so launchd does not restart it. The desktop app does not restart it.

## Later

- **The folder picker before any folder is approved.** Today the picker can list every folder on a linked computer before anyone approved a folder there. The linker and the people the owner chose can start sessions on it, so only they get its picker. Three ways to limit it were considered: (1) the home folder and the folders directly in it, plus approved folders and below, with a check that a typed path exists allowed anywhere; (2) all of the home folder, plus approved folders; (3) as (1), and the existence check limited the same way, so a deeper typed path is refused until approved. Deferred: no change yet.
