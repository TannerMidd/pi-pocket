---
name: feature-plan
description: "Break a feature's spec.md into dependency-ordered task files with a computed frontier. Use when a feature spec is ready and needs to be decomposed into buildable steps."
slash: true
---

Break `spec.md` into **tasks**: tracer-bullet vertical slices, each declaring the tasks that
**block** it.

## Process

1. **Gather context.** Read `docs-dev/features/<slug>/spec.md` in full.

2. **Explore the codebase** if you haven't already. Task titles and descriptions should use the
   project's domain glossary vocabulary (`CONTEXT.md`) and respect ADRs in the area
   you're touching. Look for prefactoring opportunities: "Make the change easy, then make the
   easy change."

3. **Draft vertical slices.** Break the work into tracer-bullet tasks:
   - Each slice cuts a narrow but COMPLETE path through every layer touched (schema, API, UI,
     tests) — vertical, not a horizontal slice of one layer.
   - A completed slice is demoable or verifiable on its own.
   - Each slice is sized to fit in a single fresh context window.
   - Any prefactoring is its own task, done first.

   Give each task its **blocking edges**: the other tasks that must complete before it can start.
   A task with no blockers can start immediately.

   **Wide refactors are the exception.** A wide refactor (rename a column, retype a shared
   symbol) whose blast radius fans across the whole codebase doesn't fit a vertical slice.
   Sequence it as expand → migrate (batched by blast radius, each batch its own task, blocked by
   the expand) → contract (blocked by every migrate batch).

4. **Quiz the user.** Present the proposed breakdown as a numbered list: title, blocked-by, what
   it delivers. Ask whether the granularity is right, whether the blocking edges are correct, and
   whether anything should merge or split. Iterate until approved.

5. **Write the task files** under `docs-dev/features/<slug>/tasks/`, numbered `01`, `02`,
   … in dependency order (blockers first), restarting at `01` for every feature. One task per
   file, never a combined file.

6. **Write `tasks/INDEX.md`**, the frontier table (template below).

7. **Set `spec.md`'s `status: in-progress`.**

8. **Commit**: `docs(<slug>): add feature tasks`.

## Task file template (`tasks/NN-slug.md`)

```md
# NN: <Task title>

**What to build:** the end-to-end behaviour this task makes work, from the user's perspective,
not a layer-by-layer implementation list.

**Blocked by:** the numbers/titles of the tasks that gate this one, or "None (can start
immediately)".

**Status:** ready | in-progress | done

- [ ] Acceptance criterion 1
- [ ] Acceptance criterion 2
```

## tasks/INDEX.md template

```md
# Tasks: <feature title>

## Dependency graph

```mermaid
graph LR
  T01[01: slug] --> T02[02: slug]
```

## Frontier

Tasks whose blockers are all `Status: done`, not yet claimed.

- 01: slug — ready

## All tasks

| # | Title | Blocked by | Status |
| --- | --- | --- | --- |
| 01 | slug | None | ready |
```

`feature-implement` updates this file's Status column and Frontier section as tasks complete;
`tasks/` and `INDEX.md` are never archived or deleted, even once the feature is done.