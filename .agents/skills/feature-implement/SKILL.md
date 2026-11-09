---
name: feature-implement
description: "Claim and build the next available task from tasks/INDEX.md, test-first at agreed seams, one task at a time. Use when implementing a feature that already has a spec and tasks."
slash: true
---

Implement the next frontier task from `docs-dev/features/<slug>/tasks/`.

## Process

1. **Load the frontier.** Read `tasks/INDEX.md`. The frontier is every task whose `Blocked by`
   tasks are all `Status: done`, and that isn't already `in-progress`.

2. **Claim a task.** Pick the first frontier task (or the one the user named). Set its `Status:
   in-progress` in its own file and in `INDEX.md`, before doing any work.

3. **Implement it.** Use the `tdd` skill where available, at the seams agreed in `spec.md`.
   Prefer existing seams. Run typechecking and the relevant test files regularly; run the full
   test suite once at the end of the task.

4. **When a decision surfaces** that is hard to reverse, surprising without context, and the
   result of a real trade-off, call the Skill tool for `domain-modeling` to write an ADR before
   continuing. When project terminology is unclear or contradicts `CONTEXT.md`, also call
   `domain-modeling` to sharpen it.

5. **Commit per step**, Conventional Commits (`feat`/`fix`/`test`/`refactor` as appropriate), not
   one giant commit per task.

6. **Update task status.** Check off the task's Acceptance Criteria, set `Status: done` in the
   task file and in `tasks/INDEX.md`'s table and Frontier section.

7. **Repeat** from step 1 while the frontier is non-empty.

8. **When no tasks remain**, tell the user the implementation loop is done and that
   `feature-close` should run next. Do not run `feature-close` yourself unless explicitly asked —
   it does not auto-invoke on purpose.

If a session ends before the frontier is empty, call the Skill tool for `session-handoff` before
finishing.