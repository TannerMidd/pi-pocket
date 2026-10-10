# Changing how Pi works, without code

Most changes people ask for ("always use pnpm", "review the way we do it here", "never touch the migrations") need no code. Pi Pocket reads the same files Pi does, so what is written for Pi works here too, and the other way round. Pi's own documentation covers each in full; its path is in the system prompt.

## Instructions for one session

Menu → **Instructions for Pi**, or `/instructions use pnpm, not npm`. Pi gets them with every message in that session, after the rest of the system prompt. Everyone in the session sees them. They are stored with the session, so they last across restarts, and a fork starts with its parent's.

Use them for rules that belong to one piece of work. You cannot set them with a tool: tell the person what to put there.

## AGENTS.md: rules for a project, or for everything

Pi loads context files the way Pi does:

- `~/.pi/agent/AGENTS.md`: for every session, whatever its folder.
- `AGENTS.md` (or `CLAUDE.md`) in the session's folder and each folder above it.

See Pi's `configuration.md` for the full list of names, including `AGENTS.override.md`. Pi Pocket reads them again at most 30 seconds after they change; the next request has them.

Keep them short and true: they go with every request, and a rule Pi cannot follow is worse than none.

## Skills: procedures Pi follows on request

A skill is a folder with a `SKILL.md`: a name and a description at the top, the steps below. Its name and description go into the system prompt; Pi reads the rest when a task matches it, or when someone sends `/skill:name what to do`.

Put one in `~/.pi/agent/skills/<name>/` or `~/.agents/skills/<name>/` (for every session), or in a project's `.pi/skills/` or `.agents/skills/` (for sessions in it). A project's `.agents/skills/` counts in the session's folder and each folder above it, up to the repository's root. Pi's settings can add more folders. Where two skills share a name, the project's wins. See Pi's `skills.md`. Like `AGENTS.md`, skills are read again within 30 seconds.

A project's `.agents/skills/` load only in a project Pi trusts. When a session's project has some and nobody has decided, Pi Pocket asks its owner above the message box; `/trust` (or Menu → **Project trust**) shows the answer and changes it. The answer goes where Pi's CLI keeps its own (`~/.pi/agent/trust.json`), so each goes by what was decided in the other; in the CLI, trust also loads the project's `.pi` settings, extensions, and packages. `"defaultProjectTrust": "always"` (or `"never"`) in `~/.pi/agent/settings.json` answers for every project nobody decided about. The CLI asks before a project's `.pi/skills/` too; Pi Pocket loads those until you answer "Don't trust" (or `defaultProjectTrust` is `"never"`), and then leaves them out too. **Not now** (×) puts the question off in that tab.

## Prompt templates: saved messages with blanks

A Markdown file in `~/.pi/agent/prompts/` (or a project's `.pi/prompts/`, unless Pi was told not to trust the project) becomes a slash command named after it: `review.md` is `/review`. `$1`, `$2`, … take the words after the command, `$@` all of them. See Pi's `prompt-templates.md`.

Use a template for a message people send often; use a skill for steps Pi should know how to take.

## Models and providers

People sign in to providers from Menu → **Providers**, and pick a model per session from the model chip in the message box. Pi Pocket uses Pi's sign-ins (`~/.pi/agent/auth.json`) and Pi's model list: to add a model or a provider Pi does not know, follow Pi's `models.md` and `custom-provider.md`.

## Other switches people have

These are in the app, not in files. Tell the person where they are rather than changing them some other way.

- **Plan mode** (the Plan chip): Pi plans and asks before it changes anything.
- **Done when** (`/until npm test`): Pi keeps working until a check passes.
- **Scheduled messages** (`/schedule in 2h check the deploy`): a message to Pi later, or on repeat. Pi has a `schedule` tool for its own.
- **Extensions** (Menu → Extensions, the owner): turn the browser, subagents, codemode, Lancet Guard, a drop-in, and the rest on and off for every session.
- **Lancet Guard and approvals** (Menu → Extensions): with the guard on, risky commands wait for a person to allow them; "Approvals need someone else" makes that someone other than who asked.

See [features.md](features.md) for each.

## When this is not enough

To give Pi a new tool, add a rule to its prompt that depends on the session's state, or check its tool calls, write an extension: [extensions.md](extensions.md).
