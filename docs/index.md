# Pi Pocket's documentation

These pages are for agents and people who change how Pi works in Pi Pocket, extend Pi Pocket, or change its code. Pi's system prompt gives their full paths. The links here are relative to this folder.

## Where things are

- **The code** is in the folder above this one (`web/`, `src/`, `docs/`, `test/`). It runs directly from these files: there is no build.
- **The data** is in `~/.pi-pocket/`, or in `PI_POCKET_DIR`. The launcher shows it as **Data**.
    - `config.json` has the people, roles, tokens, invites, and settings.
    - `pocket.sqlite` has all sessions.
    - `extensions/` has the owner's drop-in extensions.
    - `themes/` has the owner's themes.
    - Change the data through the app, never in these files: the server keeps them in memory, and writes over them. There are two exceptions: `extensions/`, where drop-ins go ([extensions.md](extensions.md)), and `themes/`, where themes go ([extensions/themes.md](extensions/themes.md)).
- **Pi's own files** are in `~/.pi/agent/`: sign-ins, models, settings, `AGENTS.md`, skills, and prompt templates. Pi Pocket uses them as Pi does. It only reads Pi's sessions (`sessions/`), so that the owner can continue one here.

## Pick the lightest change

Each step goes further than the step before it, and needs more care. Use the first one that does the job.

| To change                                                          | Use                                                                             | Read                                         |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------- | -------------------------------------------- |
| How Pi works in one session                                        | The session's instructions (Menu → Instructions for Pi)                         | [customizing.md](customizing.md)             |
| How Pi works in a project, or everywhere                           | An `AGENTS.md` in the project, or Pi's own in `~/.pi/agent/`                    | [customizing.md](customizing.md)             |
| A procedure that Pi follows on request                             | A skill, or a prompt template: both become slash commands                       | [customizing.md](customizing.md)             |
| What Pi can do: a new tool, a rule in its prompt, a check on calls | A drop-in extension in `~/.pi-pocket/extensions/`, which the owner turns on     | [extensions.md](extensions.md)               |
| What the app shows: a page, a rail button, a route of your own     | The same drop-in, with a web part                                               | [extensions/app.md](extensions/app.md)       |
| How the app looks and is laid out                                  | A theme: a folder of CSS in `~/.pi-pocket/themes/`, from Appearance → Duplicate | [extensions/themes.md](extensions/themes.md) |
| Pi Pocket itself: its screens, its server, a built-in extension    | Its code, while it runs                                                         | [self-editing.md](self-editing.md)           |

A drop-in extension stays when Pi Pocket updates, and the owner can turn it off in the app. A change to Pi Pocket's code is for each person who uses this copy, and can break it for all of them.

## The documents

- [customizing.md](customizing.md): how to change how Pi works, without code.
- [extensions.md](extensions.md): how to write extensions: tools, prompt sections, hooks, and pages, buttons, and routes in the app. It is an index: read it, then the guides in [extensions/](extensions/) that your task needs.
    - The members of `host`, `web`, and `pocket` are in [extensions/reference/](extensions/reference/host.md).
    - The exact types are in [types/pocket.d.ts](../types/pocket.d.ts).
    - Working examples are in [examples/](examples/).
- [extensions/themes.md](extensions/themes.md): how to make a theme, which changes how the app looks and is laid out. Every token and part is in [extensions/reference/theme-surface.md](extensions/reference/theme-surface.md).
- [extensions/policies/](extensions/policies/index.md): the rules for extensions and changes to Pi Pocket: what belongs in core, the public API and how it changes, the security model for authors, and the gallery's review.
- [self-editing.md](self-editing.md): how to change Pi Pocket's code while it runs, check the change, and undo a change that breaks it.
- [docker.md](docker.md): running Pi Pocket in a container, with extensions, themes, Pi's folder, and the workspace mounted from the host.
- [systemd.md](systemd.md): running Pi Pocket as a systemd service, with a template unit whose instance name is the access mode.
- [map.md](map.md): where each part of the code is, and how to add the usual things.
- [architecture.md](architecture.md): how the parts depend on each other, and the orders that they need.
- [features.md](features.md): what each feature does, as people use it.
- [releases.md](releases.md): the weekly release on Fridays, the betas between releases, and how to run a beta.
- [release-notes.md](release-notes.md): how to write the notes of a release.
- [../SECURITY.md](../SECURITY.md): what Pi Pocket protects, and what it does not.

The same pages are on the web, with search: https://tannermidd.github.io/pi-pocket/docs/.

## Before you change anything

- **Ask first.** A change to Pi Pocket reaches each person who uses it, at once. Say what you will change and why. Then wait for a yes, unless the person asked for exactly that change.
- **Do not test on the live data.** Check a change on a copy of Pi Pocket with its own data folder ([self-editing.md](self-editing.md#check-it-on-a-copy)), not on the server that people use.
- **Do not restart while your own tool call runs**, and do not restart without asking. Tell the person to use Menu → Restart server.
