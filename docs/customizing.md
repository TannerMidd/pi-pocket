# Changing how Pi works, without code

Most changes that people ask for need no code: "always use pnpm", "review the way we do it here", "never touch the migrations". Pi Pocket reads the same files as Pi. So what you write for Pi works here too, and the other way round. Pi's own documentation tells all about each file; the system prompt gives its path.

## Instructions for one session

Use Menu → **Instructions for Pi**, or `/instructions use pnpm, not npm`.

- Pi gets the instructions with each message in that session, after the rest of the system prompt.
- All the people in the session see them.
- Pi Pocket stores them with the session, so they stay after restarts. A fork starts with its parent's instructions.

Use them for rules that belong to one piece of work. A tool cannot set them: tell the person what to put there.

## AGENTS.md: rules for a project, or for all sessions

Pi Pocket loads context files as Pi does:

- `~/.pi/agent/AGENTS.md`: for each session, in any folder.
- `AGENTS.md` (or `CLAUDE.md`) in the session's folder, and in each folder above it.

Pi's `configuration.md` gives the full list of names, with `AGENTS.override.md`. Pi Pocket reads the files again at most 30 seconds after they change. The next request has them.

Keep the files short and true. They go with each request, and a rule that Pi cannot obey is worse than no rule.

## Skills: procedures that Pi follows on request

A skill is a folder with a `SKILL.md`: a name and a description at the top, and the steps below. Its name and description go into the system prompt. Pi reads the rest when a task matches it, or when a person sends `/skill:name what to do`.

Put a skill in one of these folders:

- `~/.pi/agent/skills/<name>/` or `~/.agents/skills/<name>/`, for each session.
- A project's `.pi/skills/` or `.agents/skills/`, for the sessions in that project. A project's `.agents/skills/` counts in the session's folder, and in each folder above it, up to the repository's root.
- More folders that Pi's settings add.

When two skills have the same name, the project's skill wins. See Pi's `skills.md`. As for `AGENTS.md`, Pi Pocket reads skills again within 30 seconds.

### Project trust

A project's `.agents/skills/` load only in a project that Pi trusts.

- When a session's project has such skills and nobody decided about the project, Pi Pocket asks its owner above the message box.
- `/trust`, or Menu → **Project trust**, shows the answer and changes it.
- The answer goes where Pi's CLI keeps its own (`~/.pi/agent/trust.json`). So each app uses what was decided in the other. In the CLI, trust also loads the project's `.pi` settings, extensions, and packages.
- `"defaultProjectTrust": "always"` (or `"never"`) in `~/.pi/agent/settings.json` answers for each project that nobody decided about.
- The CLI also asks before a project's `.pi/skills/`. Pi Pocket loads those until you answer "Don't trust", or until `defaultProjectTrust` is `"never"`. Then it leaves them out too.
- **Not now** (×) puts the question off in that tab.

## Prompt templates: saved messages with blanks

A Markdown file in `~/.pi/agent/prompts/`, or in a project's `.pi/prompts/` (unless Pi was told not to trust the project), becomes a slash command with its name: `review.md` is `/review`. `$1`, `$2`, … take the words after the command, and `$@` takes all of them. See Pi's `prompt-templates.md`.

Use a template for a message that people send often. Use a skill for steps that Pi must know how to do.

## Models and providers

People sign in to providers in Menu → **Providers**, and pick a model for each session with the model chip in the message box. Pi Pocket uses Pi's sign-ins (`~/.pi/agent/auth.json`) and Pi's list of models. To add a model or a provider that Pi does not know, follow Pi's `models.md` and `custom-provider.md`.

Models are the person's choice, never Pi's:

- A subagent runs on its session's model, unless the owner allows models under **Models for subagents**, at the top of the Providers sheet. By default, there are none. Once some are allowed, subagents and linked sessions run only on those: on the session's model when it is one of them and Pi names none, else on a model Pi chooses from them (Pi must name one when the session's is not among them).
- PiP gives a model only when its person named it.

Instructions, skills, and `AGENTS.md` cannot change this. Tell the person where the setting is instead.

## Project model defaults for new sessions

Menu → **Default model** sets the owner's model and thinking level for the whole app. This always wins. To use project defaults, open that menu and choose **Clear owner default: use project defaults, then last picked**.

In the session folder's `.pi/settings.json`, set both `defaultProvider` and `defaultModel`. You can also set `defaultThinkingLevel`; without it, the level is `off`. For example:

```json
{
    "defaultProvider": "anthropic",
    "defaultModel": "claude-sonnet-4-5",
    "defaultThinkingLevel": "high"
}
```

Use a provider and model ID that Pi's list of models knows. Pi Pocket limits thinking to the levels that the model has. A project setting with only a thinking level does not change an owner default, or the last picked model and level.

Project defaults need trust:

- Each project with a `.pi/settings.json` can ask, also when it has no model keys. The same decision controls what Pi's terminal app loads.
- A project with only settings asks the owner above the message box. **Review**, or Menu → **Project trust**, explains the choice.
- Until the owner trusts the project, the usual order applies.
- After trust, only new sessions use project defaults: the open session does not change.
- No project setting can trust its own project. The decision is shared with Pi's terminal app. Pi Pocket reads `defaultProjectTrust` only from Pi's global settings.

Without an owner default, the order is: a pin from a trusted project, the last picked model, Pi's global default, and then no model.

- Pi Pocket reads the final folder after it makes a worktree, and fresh global defaults and trust policy, each time it makes a session.
- A worktree uses the files in that checkout, with the new files that it copied and that git does not ignore. It does not read its source folder separately.
- Bad JSON, a provider without a model (or a model without a provider), an unknown model, or a wrong thinking level in trusted settings stops the new session with an error. Pi Pocket does not change silently to a different model.
- A known model without a sign-in stays selected, and its next request shows the sign-in failure.
- When Pi Pocket cannot read Pi's global settings, it also stops a new session without an owner default, with a safe error: it must not guess the trust policy.

Existing sessions do not change when files or folders change. Imports, forks, subagents, models that a person chose, and PiP's own conversation work as before.

- A model that the person named to PiP overrides project settings.
- A session that PiP starts without a named model uses the same order as each new session, with trusted projects, also when the owner trusts all projects.

**Pi Pocket does not support these yet:** extra skill and prompt paths from each session folder's settings, and run policy per project (compaction, retries, stream timeouts, steering, and follow-up mode). The usual project folders for skills and prompts still work.

## Other switches

These are in the app, not in files. Tell the person where they are. Do not change them in another way.

- **Plan mode** (the Plan chip): Pi plans, and asks before it changes anything.
- **Done when** (`/until npm test`): Pi continues until a check passes.
- **Scheduled messages** (`/schedule in 2h check the deploy`): a message to Pi later, or again and again. Pi has a `schedule` tool for its own messages.
- **Extensions** (Menu → Extensions, for the owner): turn on or off the browser, subagents, codemode, Lancet Guard, a drop-in, and the rest, for all sessions.
- **Lancet Guard and approvals** (Menu → Extensions): when the guard is on, risky commands wait for a person to allow them. "Approvals need someone else" makes that person another than the one who asked.

See [features.md](features.md) for each of them.

## When this is not enough

To give Pi a new tool, add a rule to its prompt that depends on the session's state, or check its tool calls, write an extension: [extensions.md](extensions.md). An extension can also add a page, a rail button, or a route to the app ([Adding to the app](extensions/app.md)).
