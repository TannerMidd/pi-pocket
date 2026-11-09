---
name: session-handoff
description: "Read handoff.md, spec.md, tasks/INDEX.md, and relevant ADRs to resume a feature, or write/overwrite handoff.md when a session ends with work still in progress. Use when starting or resuming a feature session, or wrapping one up unfinished."
slash: true
---

Carry feature context across agent sessions via `docs-dev/features/<slug>/handoff.md`.
Unlike a generic handoff note, this one is **committed to the repo** (so it survives across
machines and sessions) but stays transient: it exists only while the feature is unfinished.

## Resuming a session

1. Read `handoff.md` if it exists.
2. Read `spec.md` and `tasks/INDEX.md`.
3. Read any ADR referenced from either.
4. Read `CONTEXT.md` for project vocabulary, if it exists.
5. Continue with `feature-implement` from the frontier task `handoff.md` pointed at, or the first
   frontier task if none was pointed at.

## Ending a session

Write or overwrite `handoff.md` whenever a session ends and the feature's tasks are not all done.

Include:

- **Current state**: what's done, what's in progress right now.
- **Next steps**: the immediate actions for the next session, in order — name the specific
  frontier task to pick up.
- **Open questions**: anything unresolved that the next session (or user) needs to weigh in on.
- **Suggested skills**: which skills the next session should call the Skill tool for.

Do not duplicate content already captured in `spec.md`, `tasks/`, ADRs, commits, or diffs —
reference them by path instead. Redact secrets, credentials, and personal information.

Commit: `docs(<slug>): update handoff notes`.

## Safety net

If you land on a feature at `status: done` with a leftover `handoff.md`, delete it as routine
housekeeping before doing anything else — don't wait to be asked.