---
name: code-review
description: "Review the changes since a fixed point (commit, branch, tag, or merge-base) along two axes: Standards (does the code follow this repo's documented coding standards?) and Spec (does the code match what the originating spec asked for?). Runs both reviews in parallel sub-agents and reports them side by side. Use when the user wants to review a branch, a PR, work-in-progress changes, or asks to review since X."
slash: true
---

Two-axis review of the diff between `HEAD` and a fixed point the caller supplies:

- **Standards**: does the code conform to this repo's documented coding standards?
- **Spec**: does the code faithfully implement the originating spec?

Both axes run as **parallel sub-agents** so they don't pollute each other's context, then this
skill aggregates their findings.

## Process

### 1. Pin the fixed point

Whatever the caller said is the fixed point (a commit SHA, branch name, tag, `main`, `HEAD~5`,
etc. — or `feature-close` passing a specific commit). If not specified, ask for it.

Capture the diff command once: `git diff <fixed-point>...HEAD` (three-dot, against the
merge-base). Also note `git log <fixed-point>..HEAD --oneline`.

Confirm the fixed point resolves (`git rev-parse <fixed-point>`) and the diff is non-empty before
going further — a bad ref or empty diff should fail here, not inside two parallel sub-agents.

### 2. Identify the spec source

In order:

1. A spec path the caller passed directly (`feature-close` always does this:
   `docs-dev/features/<slug>/spec.md`).
2. A spec file under `docs-dev/features/`, `specs/`, or `.scratch/` matching the branch
   name or feature.
3. If nothing is found, ask the user where the spec is. If they say there isn't one, the **Spec**
   sub-agent skips and reports "no spec available".

### 3. Identify the standards sources

Anything in the repo documenting how code should be written — `AGENTS.md`,
`CODING_STANDARDS.md`, `CONTRIBUTING.md`.

On top of whatever the repo documents, the Standards axis always carries the **smell baseline**
below: a fixed set of Fowler code smells (_Refactoring_, ch. 3) that applies even when a repo
documents nothing. Two rules bind it:

- **The repo overrides.** A documented repo standard always wins; where it endorses something the
  baseline would flag, suppress the smell.
- **Always a judgement call.** Each smell is a labelled heuristic, never a hard violation. Skip
  anything tooling already enforces.

- **Mysterious Name**: a name that doesn't reveal what it does or holds. → rename it.
- **Duplicated Code**: the same logic shape in more than one hunk/file. → extract the shared shape.
- **Feature Envy**: a method reaching into another object's data more than its own. → move it.
- **Data Clumps**: the same fields/params keep travelling together. → bundle them into one type.
- **Primitive Obsession**: a primitive standing in for a domain concept. → give it its own type.
- **Repeated Switches**: the same switch/if-cascade recurs across the change. → polymorphism or a
  shared map.
- **Shotgun Surgery**: one logical change forces scattered edits across many files. → gather what
  changes together.
- **Divergent Change**: one module edited for several unrelated reasons. → split it.
- **Speculative Generality**: abstraction added for needs the spec doesn't have. → delete it.
- **Message Chains**: long `a.b().c().d()` navigation. → hide the walk behind one method.
- **Middle Man**: a class/function that mostly just delegates onward. → cut it.
- **Refused Bequest**: a subclass that ignores most of what it inherits. → composition instead.

### 4. Spawn both sub-agents in parallel

**Standards sub-agent** gets: the diff command + commit list, the standards-source files found in
step 3 plus the full smell baseline, and the brief: "Report, per file/hunk, (a) every documented-
standard violation, citing the rule; (b) any baseline smell, named and quoted. Documented-standard
breaches can be hard violations; baseline smells are always judgement calls, and a documented
standard overrides the baseline. Skip anything tooling enforces. Under 400 words."

**Spec sub-agent** gets: the diff command + commit list, the spec path/contents, and the brief:
"Report: (a) requirements missing or partial; (b) behaviour not asked for (scope creep); (c)
requirements that look implemented but wrong. Quote the spec line for each finding. Under 400
words." If no spec was found, skip this sub-agent and note it in the final report.

### 5. Aggregate

Present both reports under `## Standards` and `## Spec` headings, verbatim or lightly cleaned. Do
**not** merge or rerank findings across axes — see _Why two axes_ below.

End with a one-line summary: total findings per axis, and the worst issue *within each axis*.

## Why two axes

A change can pass one axis and fail the other: code that follows every standard but implements
the wrong thing (Standards pass, Spec fail); code that does exactly what was asked but breaks
convention (Spec pass, Standards fail). Reporting them separately stops one axis from masking the
other.