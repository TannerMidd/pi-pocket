# ADR format

Architecture Decision Records live in `docs-dev/adr/`.

## When to write one

Write an ADR only when ALL three hold:

1. The decision is hard to reverse.
2. The decision would be surprising without context.
3. The decision is the result of a real trade-off.

Otherwise skip it.

## Naming

`docs-dev/adr/NNNN-slug.md`

- `NNNN` — sequential, zero-padded to 4 digits. Scan the directory for the highest existing
  number and add 1. Numbering is global across features.
- `slug` — kebab-case short descriptor.

## Template

```md
# NNNN. Title of the decision

## Status

Accepted <!-- proposed | accepted | deprecated | superseded by ADR-NNNN -->

## Context

What is the issue we are seeing that motivates this decision?

## Decision

What is the change we are proposing or making?

## Consequences

What becomes easier or harder, and what costs are introduced?
```

## Lifecycle

- ADRs are never deleted.
- A superseded ADR keeps its file; update its `Status` to `superseded by ADR-NNNN` and add a
  pointer to the new record.
- Commit each ADR separately: `docs: add ADR-NNNN <slug>`.