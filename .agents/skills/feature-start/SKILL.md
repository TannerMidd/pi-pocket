---
name: feature-start
description: "Scaffold a new feature and write its spec: call grill-me first if the idea isn't sharp yet, then create <docs_folder>/features/<slug>/ and write spec.md. Use when starting work on a new feature or issue."
slash: true
---

Turn an issue or loose idea into a scaffolded feature with a written spec.

## Process

1. **Reach shared understanding first.** If the feature isn't already sharp from the
   conversation, call the Skill tool for `grill-me` and interview the user until the frontier is
   empty. Do NOT proceed to writing the spec on a fuzzy idea.

2. **Derive and confirm the slug.** Slugify the issue title (kebab-case, `[a-z0-9-]` only, ~50
   chars max). Confirm it with the user before creating anything.

3. **Explore the codebase** to understand the current state, if you haven't already. Use the
   project's domain glossary vocabulary (see `CONTEXT.md` if it exists) throughout the
   spec, and respect any ADRs in the area you're touching.

4. **Sketch the seams** at which you're going to test the feature. Prefer existing seams; the
   fewer seams across the codebase, the better. Check with the user that these seams match their
   expectations.

5. **Scaffold the folder** `docs-dev/features/<slug>/` and write `spec.md` using the
   template below.

6. **Commit**: `docs(<slug>): add feature spec`.

## spec.md template

```md
---
status: draft
issue: <issue reference, e.g. #123, or leave blank>
---

# <Short title>

## Problem Statement

The problem the user is facing, from the user's perspective.

## Solution

The solution to the problem, from the user's perspective.

## User Stories

A numbered list, each in the form: "As a <actor>, I want a <feature>, so that <benefit>."
Cover all aspects of the feature.

## Implementation Decisions

Modules to be built/modified, their interfaces, technical clarifications, architectural
decisions, schema changes, API contracts. Reference an ADR by number where one exists, e.g.
`ADR-0003`. No specific file paths or code snippets — they go stale fast.

## Testing Decisions

What makes a good test here (external behaviour, not implementation details); which modules will
be tested; prior art for similar tests in the codebase.

## Out of Scope

Explicitly excluded work, and why.

## Further Notes

Anything else worth recording.
```

`status` starts at `draft`. It moves to `in-progress` once `feature-plan` has written tasks, and
to `done` once `feature-close` verifies every task is done.