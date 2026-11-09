---
name: domain-modeling
description: "Build and sharpen a project's domain model. Use when discussing codebase terminology, writing or editing the domain glossary, or recording or superseding an ADR."
slash: true
---

Actively build and sharpen the project's domain model as you design: challenge terms, invent
edge-case scenarios, and write the glossary and decisions down the moment they crystallise.
(Merely *reading* `CONTEXT.md` for vocabulary is not this skill — that's a one-line habit
any skill can do. This skill is for when you're *changing* the model.)

## File structure

Most repos have a single context: `CONTEXT.md` at the repo root, plus
`docs-dev/adr/` for decisions.

If a `CONTEXT-MAP.md` exists at the root, the repo has multiple contexts — see
[CONTEXT-FORMAT.md](CONTEXT-FORMAT.md) for that structure.

Create files lazily: only when you have something to write. If no `CONTEXT.md` exists,
create it when the first term is resolved. If no `docs-dev/adr/` exists, create it when
the first ADR is needed.



## During the session

### Challenge against the glossary

When the user uses a term that conflicts with `CONTEXT.md`, call it out immediately.
"Your glossary defines 'cancellation' as X, but you seem to mean Y. Which is it?"

### Sharpen fuzzy language

When the user uses vague or overloaded terms, propose a precise canonical term. "You're saying
'account': do you mean the Customer or the User? Those are different things."

### Discuss concrete scenarios

Stress-test domain relationships with specific scenarios. Invent edge cases that force precision
about the boundaries between concepts.

### Cross-reference with code

When the user states how something works, check whether the code agrees. Surface contradictions:
"Your code cancels entire Orders, but you just said partial cancellation is possible. Which is
right?"

### Update the glossary inline

When a term is resolved, update `CONTEXT.md` right there — don't batch this up. Use the
format in [CONTEXT-FORMAT.md](CONTEXT-FORMAT.md). `CONTEXT.md` is a glossary and nothing
else: no implementation details, no spec content, no scratch notes.

### Offer ADRs sparingly

Only offer to write an ADR when all three hold:

1. **Hard to reverse**: the cost of changing your mind later is meaningful.
2. **Surprising without context**: a future reader will wonder "why did they do it this way?"
3. **The result of a real trade-off**: there were genuine alternatives, picked for specific
   reasons.

If any is missing, skip it. Use the format in [ADR-FORMAT.md](ADR-FORMAT.md).