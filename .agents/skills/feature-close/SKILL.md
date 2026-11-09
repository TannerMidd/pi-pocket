---
name: feature-close
description: "Finish a feature: run code-review, verify every task is done, mark the spec done, and remove handoff notes. Use when all of a feature's tasks are complete and it's ready to be marked done."
slash: true
metadata:
  opencode/autoinvoke: false
---

Close out a feature once every task is done. This is the one step in the bundle that only runs
when the user explicitly asks for it (`/feature-close`) — finishing a feature's documented state
is a deliberate decision, not something to trigger on your own read of the conversation.

## Process

1. **Verify every task is done.** Read `docs-dev/features/<slug>/tasks/INDEX.md`. If any
   task isn't `Status: done`, stop and tell the user what's outstanding — do not proceed.

2. **Run a review.** Call the Skill tool for `code-review`, passing:
   - Fixed point: the commit where `feature-plan` added `tasks/INDEX.md` (or whatever point the
     user specifies).
   - Spec source: `docs-dev/features/<slug>/spec.md` directly — don't make code-review
     search for it.

3. **If code-review reports findings**, hand them back: tell the user what needs fixing and stop
   here. Re-run `feature-close` once `feature-implement` has addressed them.

4. **If the review is clean**, set `spec.md`'s `status: done`.

5. **Delete `docs-dev/features/<slug>/handoff.md`** if it exists.

6. **Commit**: `docs(<slug>): mark feature done, remove handoff notes`.

`spec.md`, `tasks/`, and any ADRs stay in place forever — only `handoff.md` is ever deleted.

## Safety net

If you ever find a feature at `status: done` with a leftover `handoff.md` (e.g. step 5 was missed
in the past), delete the stale file as routine housekeeping the moment you notice, without
waiting to be asked.