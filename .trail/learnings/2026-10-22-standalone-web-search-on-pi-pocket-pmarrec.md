---
title: Standalone web search on Pi Pocket 0.20
author: Pmarrec
date: 2026-10-22
branch: main
touches:
  - extensions/web-search/web-search.ts
  - extensions/web-search/web-search/manager.ts
---

## Decided
Keep web-search a standalone drop-in: only public Host/Web/Pocket APIs, own keys and state under host.dataDir/web-search, owner-default routes, fenced external tool output, and experimental host.fetchPublic with minPocket 0.20.0. The author fork can host the package without core changes.

## Tried and ruled out
No unrestricted fetch fallback, auth.json/environment credential fallback, core Providers-sheet integration, or automatic cross-tier escalation. Full-checkout trail check reports unrelated keyword matches in mixed local edits; the published tree includes only the standalone package and this learning, with no subscription/STT changes.

## Watch out
Provider API redirects are rejected; direct target redirects are host-checked. URL HEAD validation is counted but cannot control a remote provider. Research creation is not replay-safe. Tests load unmodified 0.20 with in-memory HTTP; Chromium cannot launch in the restricted environment. Do not replace the running checkout or install/enable the extension as part of packaging.
