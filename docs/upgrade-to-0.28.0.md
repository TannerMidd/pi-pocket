# Upgrade the host to Pi Pocket 0.28.0

This document gives the steps to upgrade the live server to Pi Pocket 0.28.0 and Pi 1.5.0.
The host is the machine that runs the server. A person does these steps by hand.
Nobody has run them yet.

## What changes

- Pi Pocket goes from 0.27.0 to 0.28.0. The release is `v0.28.0` of `TannerMidd/pi-pocket`.
- Pi goes from 1.4.0 to 1.5.0. Pi is not a command on this machine: it ships inside Pi Pocket, as the packages `@earendil-works/pi-coding-agent`, `pi-ai`, `pi-durable`, `pi-codemode`, `pi-mcp`, `chord`, and `pi-schema`, pinned in `package.json`.
- The install grows by about 18 MB. The new packages are `katex`, `pele`, `heic-convert`, `minimatch`, `typebox`, and `@earendil-works/pi-schema`.
- **The data changes one way.** As soon as one session runs on 0.28, Pi Pocket 0.27 cannot open the data folder. You cannot go back to 0.27 with the same folder.
- The browser moves the drafts and the sent-text history of 0.27 to the person who signs in. Older history that belongs to no person is discarded.
- The first request of each session misses the prompt cache one time, because the prompt and the tools changed.

## Step 1: Back up the data folder

Stop the server first. A copy of a running SQLite database is not safe.

```bash
# In the terminal that runs the launcher, press Ctrl+C, and wait for it to exit.
cp -a /home/node/.pi-pocket /home/node/.pi-pocket.bak-$(date +%F)
```

The database is about 80 MB. Keep the copy until the new version runs well.

## Step 2: Update the code

The live checkout is `/home/node/Repos/pi-pocket`.

```bash
cd /home/node/Repos/pi-pocket
git switch main
git pull
npm ci
```

`npm ci` installs the new packages. It needs about 1 to 2 minutes on this machine.

## Step 3: Restart the server

Start the launcher again, the same way as before:

```bash
npm start
```

The launcher asks how your devices reach the server. Choose the same answer as before.
The server ran with `--access lan` and port 8787.

You can also restart from the app: Menu → Restart server. Use this only after `npm ci` is done.

**Downtime:** the restart alone takes about 5 to 10 seconds.
The whole upgrade takes about 2 minutes, and most of it is `npm ci`.
Running work continues after the restart. A tool call that the restart cuts off comes back as interrupted.

## Step 4: Check the new version

- Open the app. Menu → Extensions shows the version `0.28.0`.
- Open one session. Send one message, and read the answer.
- Open the Extensions sheet. The built-in modules load, and your drop-ins load.
- Look at the fork's own features:
    - Refresh models: run it, and read the Providers sheet for errors.
    - Watch a GitLab project: Menu → Webhooks and watches shows the watches.
    - The Docker tools image is unchanged.

## Rollback

The data folder is safe only from the backup. Do these steps in this order.

```bash
# 1. Stop the server: press Ctrl+C in the launcher.
# 2. Put the code back.
cd /home/node/Repos/pi-pocket
git switch main
git reset --hard 4f1b46e7
npm ci

# 3. Put the data folder back.
rm -rf /home/node/.pi-pocket
cp -a /home/node/.pi-pocket.bak-YYYY-MM-DD /home/node/.pi-pocket

# 4. Start the server again.
npm start
```

Rollback throws away every message and every schedule that came after the backup.
Do it only when 0.28 does not work.

## Notes

- The branch `pocket/upgrade-fork-to-newest-pi-pocket-pi-6c2a3e` holds the merge of `v0.28.0` into the fork.
- A person merges the pull request by hand. No pull request is merged now.
- `npm run check` and `npx eslint .` pass on that branch.
- `npm test` was not verified on this machine, because the machine is too weak to finish it. Run `npm test` on a stronger machine before the merge.
- Nobody ran the steps of this document. They are a plan.
