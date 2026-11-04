# Stage 2 locale evidence — green after correction

## Environment and scope

- Stage 1 base: `7fef92bb88df27d70fdbddd75c6861c7a4f058c8`.
- Main repository: `/home/xianbei233/Work/pi-pocket-pr`. Tests use `openApp` with temporary data, real HTTP, real extension modules, a real Registry, and a scripted model.
- Chromium: `/usr/bin/chromium`, version `156.0.8078.79`. UI tests do not use a skip condition. Mobile viewport: 390 × 844. Desktop viewport: 1280 × 800.
- The approved disposable worktree was `result-ui-locales-red`, detached at the Stage 1 commit. Only copies inside that worktree were mutated. Every mutation script restores its input file in `finally`.
- No main business file, Stage 1 file, dictionary audit file, or `specs/` file was changed by the test agent.

## Results before the first fix batch

- `node --test test/ui-locale-ui.test.ts test/ui-locales-http.test.ts` — exit 1; 23 tests ran, 16 passed, 7 failed, 0 skipped. The actual Chromium UI suite ran at both viewport sizes. The 2 HTTP tests passed.
- `npm run check` — exit 0.
- `npx eslint test/ui-locale-ui.test.ts test/ui-locales-http.test.ts test/ui-locales-stage2-mutate.cjs` — exit 0.
- `npx prettier --check test/ui-locale-ui.test.ts test/ui-locales-http.test.ts test/ui-locales-stage2-mutate.cjs` — exit 0.
- `git diff --check` — exit 0.

## Defects before the first fix batch

1. A non-OK catalog response does not restore English. The 404 and 503 tests both observed `fr`, expected `en`. The rejection test passes. `web/ui-locale.js` calls `.then` on `undefined` for a non-OK response.
2. An initial held real catalog response can publish after an old-server hello. The named assertion observed `fr`, expected `en`.
3. Core `app.js` topbar labels and ARIA remain English. Both mobile and desktop fail `the menu's accessible name is translated`. The Appearance layout also fails `the core Files item label redraws inside Appearance layout`.
4. The fixed part of the document title remains `Pi Pocket`. The positive French test observed `Close · Pi Pocket`, expected `Close · Poche Pi`. The user's `Close` title remains unchanged.

The real same-revision restart test passed its live DOM checks in this snapshot: both an open Appearance sheet and a topbar control showed changed words from the second temporary app. The second app had the same numeric revision, and the same sheet node remained open. The current implementation does not increment its locale draw counter when that revision and the effective ID are equal; the live DOM happened to redraw during reconnect. A same-revision catalog/list change with no unrelated redraw remains a risk and needs an explicit implementation decision or a stronger deterministic case.

## Baseline red evidence

At Stage 1 base in the disposable worktree, before copying Stage 2 files:

- `node --test test/ui-locales-http.test.ts` — exit 1. R23 reported `catalog is public to anonymous: 404 !== 200`; R24 reported `the catalog GET exists: 404 !== 200`.
- `node --test test/ui-locale-ui.test.ts` — exit 1. Real Chromium ran once at 390 × 844 and once at 1280 × 800. Both failed `the language selector offers the installed French locale`. This is a capability gap, not a separate red assertion for every UI risk.

## Isolated mutation evidence

Each command below ran inside the disposable worktree as `node test/ui-locales-stage2-mutate.cjs <risk>`. The exact replacement and selected test are in that file. Every listed command exited 1 on the named assertion, not on an import or a missing file.

| Risk | Isolated mutation                                   | Named failure                                                               |
| ---- | --------------------------------------------------- | --------------------------------------------------------------------------- |
| R11  | Reload the page after choosing a language           | `the app page instance is not reloaded`: false, expected true.              |
| R12  | Make the topbar slot heading static                 | `the cached slot label redraws`: false, expected true.                      |
| R13  | Accept an old catalog response                      | The old upper text `Retour supérieur` replaced `Retour aux sessions`.       |
| R14  | Keep French effective after its providers disappear | `every role falls back after the last provider is disabled`: `fr !== en`.   |
| R15  | Do not reread the cookie on focus                   | `focus rereads the preferred language`: `en !== fr`.                        |
| R19  | Return a wrong default English Appearance title     | `the default Appearance title is English`: `Broken default !== Appearance`. |
| R20  | Ignore safe mode                                    | Safe mode showed `fr`, expected `en`.                                       |
| R21  | Disable the language selector                       | The selector's `disabled` flag was true, expected false.                    |
| R22  | Translate the user's `Close` title                  | `the user title remains literal`: false, expected true.                     |
| R23  | Add a private path to the catalog response          | The response had `privatePath`, which the exact field assertion rejected.   |
| R24  | Allow non-GET catalog methods                       | `POST is rejected` failed.                                                  |

The final mutation batch used:

`for risk in R11 R12 R13 R14 R15 R19 R20 R21 R22 R23 R24; do node test/ui-locales-stage2-mutate.cjs "$risk" > "/tmp/ui-locales-stage2-$risk.log" 2>&1; status=$?; printf '%s exit=%s\n' "$risk" "$status"; done`

The output records exit 1 for every named mutation. The mutation run is evidence that the assertions detect these regressions; it is not evidence that the current full suite is green.

## Focused same-revision redraw after the fix

- The test starts 2 real temporary apps with the same numeric locale revision and different French message bytes. It holds the second app's real catalog response until the first page's reconnect settles.
- The test then releases that response. It requires the existing Appearance sheet to redraw, the effective locale to remain French, and exactly 1 locale store update with no unrelated store update in this changed-catalog case.
- `node --test --test-name-pattern="R13: same-revision catalog bytes" test/ui-locale-ui.test.ts` — exit 0; 1 Chromium test passed at 1280 × 800.
- In the disposable worktree, `node test/ui-locales-stage2-mutate.cjs R13S` — exit 1. The reversible mutation excludes the accepted-response generation from the redraw key. The named assertion `the unchanged-revision catalog updates the live sheet` failed.
- This focused result used the first fix snapshot. The full corrected-snapshot result follows below.

## Recheck before the catalog-comparison correction

- `node --test test/ui-locale-ui.test.ts test/ui-locales-http.test.ts test/mobile-ui.test.ts` — exit 1; 45 tests ran; 44 passed; 1 failed; 0 skipped.
- All 25 Stage 2 locale UI and HTTP tests passed. Chromium ran real pages at 390 × 844 and 1280 × 800. The Places tile and the Appearance Places layout both showed the translated Files label.
- The existing mobile test `a reconnect that brings the same data keeps it, and draws no session row` failed its unchanged assertion: `no session row draws again` observed 3, expected 0. The assertion that equal data keeps its identity passed.
- The current implementation increments `localeRevision` on each accepted catalog response. The failure is consistent with that reconnect invalidation, but its precise cause has not been isolated. Do not weaken the existing assertion without an explicit owner decision.
- `npm run check` — exit 0. The test-only ESLint and Prettier checks and `git diff --check` also exited 0.
- The earlier 7 locale assertion failures are fixed in this snapshot. The suite is not green because of the independent mobile regression above.

## Corrected snapshot: final targeted recheck

- `node --test test/ui-locale-ui.test.ts test/ui-locales-http.test.ts test/mobile-ui.test.ts` — exit 0; 45 tests passed; 0 failed; 0 skipped. Chromium ran locale UI tests at 390 × 844 and 1280 × 800.
- The unchanged mobile reconnect assertion now passes: identical data produces no session-row redraw. The same-revision test with changed bytes from a second real app also passes, with no unrelated store update.
- The earlier 7 locale assertion failures remain fixed. The live Places tile and its Appearance layout label pass.
- The tested `web/ui-locale.js` SHA-256 was `4a4df8f83ee109d0a2f55891b7e27b1c8817a603086527b945df037e4aa9d963`. The tested `test/ui-locale-ui.test.ts` SHA-256 was `7b376f940c8039305af3884143d3efe021242e0eab46cd6f6f9f01ad5524167d`. The unchanged `test/mobile-ui.test.ts` SHA-256 was `d3a1774e553a436d574164077d7cf7a5ed86785136c0237f8a2fa4c9ce60f2f7`.
- No mutation was rerun for an unchanged risk. The prior `R13S` mutation targeted the earlier fix's `applied` key. The implementation now uses a catalog signature, so that old mutation is not claimed to replay on this corrected snapshot.
- `git worktree remove --force result-ui-locales-red` exited 0 after the green run. The disposable worktree no longer exists.

## Earlier snapshot fingerprints

| File                                | SHA-256                                                            |
| ----------------------------------- | ------------------------------------------------------------------ |
| `src/server/app.ts`                 | `fd518278325c665ebcda8951895f5dbf904d5c2f4ab90b18d44a1e4ac38a2be2` |
| `src/server/http.ts`                | `453162f9d1994c1d01596dafb9225cfcb653545ec5386c148fbf99722e21b25d` |
| `web/ui-locale.js`                  | `f168745cacaec26f53533ebb476653a9dd7b30941bc46204a9901c58ab3f9ead` |
| `web/app.js`                        | `479d7383774b3d348fdaa1e7e454dddd0aa730c03faf82fbb93ee5faa171df61` |
| `web/sheets/appearance.js`          | `4d6e70cd270532d6315707314bd689970c025058c4ad8ebbdcf0fb800995000e` |
| `web/sessions.js`                   | `3deaef93b7f0c0b17bf31ff90990fcb551036a4889eddd4f448cea16b69937e7` |
| `web/slots.js`                      | `8a06faf7f234a883b3b908b5be4d8e53fcdf78950385643b5ee3ef8dbb34d936` |
| `web/store.js`                      | `2e7ef1173327cbd1737188e160f254dee809021e6aed1f62afc1105aa5ad8ef7` |
| `test/ui-locale-ui.test.ts`         | `748f76f98aebed75ba9b2c603e87a1c25d1ce2befbefa06b2ffb84b0e9b5609a` |
| `test/ui-locales-http.test.ts`      | `f3037daa8c4584a840b3116200422c7a274cc886456f58170a94fe8208cd2c31` |
| `test/ui-locales-stage2-mutate.cjs` | `7385b4b19a3e545f1901638db306abbea952e30bf00c638423bb35fe0c3e65c0` |

## Not covered yet

- Full `npm test` and global format were not run. The final correction was checked by the targeted 3-file command, not by a new full-project check.
- Stage 3 SSR and Stage 4 Chinese package behavior were not started.
