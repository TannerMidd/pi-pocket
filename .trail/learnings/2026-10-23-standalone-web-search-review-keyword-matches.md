---
title: Standalone web search review keyword matches
author: Pmarrec
date: 2026-10-23
touches:
    - extensions/web-search/web-search.ts
    - extensions/web-search/test/module.test.ts
---

## Decided

Publish the standalone package without core changes. A scoped trail check against
the PR base has no branch overlaps.

## Tried and ruled out

The scoped checker flags words from negative security assertions and mocked tests,
including unrestricted fetch fallback. These are false positives: production uses
only host.fetchPublic, missing transport fails closed, credentials resolve only
from extension storage, and tier exhaustion never escalates. Tests verify these
boundaries. Read the code before treating keyword matches as semantic conflicts.

## Watch out

Publishing from an isolated checkout keeps unrelated local work out of the PR.
The trail note CLI may fail registering a temporary clone when its home registry
is read-only; preserve the team note in the repository instead.
