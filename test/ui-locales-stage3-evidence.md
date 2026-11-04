# Stage 3 SSR locale evidence

## Scope

- Stage 2 baseline: `4882afc2469a569ca059128f45ade2ad718e235d`.
- Repository: `/home/xianbei233/Work/pi-pocket-pr`. The implementation was not committed by the test agent.
- The tests use a real temporary app, HTTP server, Registry, locale modules, and Chromium. The scripted model is the only simulated external model boundary.
- The title-lookup race delays the real `app.conversationTitle` call at its asynchronous boundary. It does not replace the catalog, loader, or snapshots.
- Chromium: `/usr/bin/chromium`, version `156.0.8078.79`. Locale UI tests have no skip condition. The Stage 3 SSR-to-app test ran once at 390 × 844 and once at 1280 × 800. The injection and blocked-cookie tests each ran once at desktop size. The existing sign-in regression also executed in Chromium.

## Green results

- `node --test test/ui-locales-http.test.ts test/ui-locale-ui.test.ts test/sign-in-ui.test.ts` — exit 0; 37 passed; 0 failed; 0 skipped.
- `npm run check` — exit 0.
- `npx eslint test/ui-locales-http.test.ts test/ui-locale-ui.test.ts test/ui-locales-stage3-mutate.cjs` — exit 0.
- `npx prettier --check test/ui-locales-http.test.ts test/ui-locale-ui.test.ts test/ui-locales-stage3-mutate.cjs` — exit 0.
- `git diff --check` — exit 0.
- In the isolated snapshot, `node --test --test-name-pattern="R25:|R26:|R27:|R28:" test/ui-locales-http.test.ts` — exit 0; 7 passed. This is the control for the mutations.

The tests cover catalog/SSR/browser wording and disable fallback; concurrent login/join/share cookies; missing, invalid, unavailable, canonical and safe-mode cookies; an overlapping catalog replacement; escaped translations, names, titles and attributes; and the login/invite security branches. They check actual response status, redirect, cookies, hidden values and resulting roles.

## Baseline behavioral red

At the detached Stage 2 baseline, before copying the Stage 3 implementation:

`node --test --test-name-pattern="R25: the installed pack|R26: concurrent|R27: translation text|R28: authentication" test/ui-locales-http.test.ts`

Exit 1. R25 and R26 expected `<html lang="fr">`, but the actual HTML had `<html lang="en">`. R28's French switch-account wording was absent. The first R27 fixture had an invalid JavaScript string and failed before its behavioral assertion; that particular failure is not counted as evidence. The corrected R27 assertion is supported by the isolated mutations below.

## Isolated mutations

The owner-approved worktree `result-ui-locales-red` was detached at the Stage 2 baseline. The implementation and tests were copied into it. Each command below ran there as `node test/ui-locales-stage3-mutate.cjs <risk>` and exited 1. The script records each exact replacement and restores the source in `finally`.

| Risk | Mutation                                                  | Named failure                                                                     |
| ---- | --------------------------------------------------------- | --------------------------------------------------------------------------------- |
| R25  | Make SSR read English instead of the selected pack        | `SSR uses the installed catalog wording` failed.                                  |
| R26  | Use French message data for every request                 | `en request has its own wording` failed.                                          |
| R26S | Read messages from mutable process-global state           | `the request retains its earlier snapshot` failed after a concurrent replacement. |
| R27T | Remove escaping from the translated heading               | `translation in the heading is escaped` failed.                                   |
| R27A | Remove escaping from the translated placeholder attribute | `translation in the placeholder attribute is escaped` failed.                     |
| R28C | Disable the login cross-site check                        | The status was 303, expected 403.                                                 |
| R28N | Use the unvalidated `next` value                          | The redirect was `//attacker.example/path`, expected `/`.                         |

Batch command, run inside the disposable worktree:

`for risk in R25 R26 R26S R27T R27A R28C R28N; do node test/ui-locales-stage3-mutate.cjs "$risk" > "/tmp/ui-locales-stage3-$risk.log" 2>&1; status=$?; printf '%s exit=%s\n' "$risk" "$status"; done`

The logged output reported exit 1 for every listed mutation. No Stage 1 or Stage 2 mutation was rerun.

## Tested snapshot

| File                                | SHA-256                                                            |
| ----------------------------------- | ------------------------------------------------------------------ |
| `src/server/http.ts`                | `14c9096383442ebb35b4d31f18211f4d5311dd3332c0e1d81b9e745dc4d62f63` |
| `src/server/http/sign-in.ts`        | `9bd0dddb2869caedac0e2021a9f134a51444ac9a2addeb146fd65ad103b1625b` |
| `src/server/ui-locales.ts`          | `b11e07ed5a5307392e9e1d1a39ed75ffa2765b16a63706cc7752c686b6e221e2` |
| `web/locales/en.js`                 | `b58ec6472af46230de2b04bd922b167aacffea096ca0e5609eb46819da42195c` |
| `test/ui-locales-http.test.ts`      | `6f3cce7aa7ac05e7e019ba13ad9766effd9066fc04c4236285d6f9bff4f49ff2` |
| `test/ui-locale-ui.test.ts`         | `b614fcf05e468a692fe91f3f5c66ae4c77db9923b5fc350ba651f0a6f09ba78f` |
| `test/ui-locales-stage3-mutate.cjs` | `1f12759a784cfbeb536b70f94e8c1669e4d4bc73c8bc00b24e53e6d49675f3ec` |
| `test/sign-in-ui.test.ts`           | `74421add5cadea1912ed86233d84babf714296f22593e179ac74fd6b8a5c910a` |

## Final launcher test correction

The owner's final `npm test` run exited 1 after 284 seconds. The failing assertion was `names.includes("Webhooks and watches") && names.includes("Take turns")` in `test/launcher-coverage.test.ts`. The test extractor did not recognize `item(t(key, english), ...)`. Before the correction, `node --test test/launcher-coverage.test.ts` exited 1 on that assertion.

The extractor now includes the explicit call-site English while retaining the existing literal and conditional cases. The two named checks and the full missing-action assertion remain unchanged. After the correction, `node --test test/launcher-coverage.test.ts` exited 0: 2 passed, 0 failed, 0 skipped. Scoped ESLint and Prettier checks exited 0. The full suite was not rerun by the test agent.

## Limits

- No business defect was found in the tested Stage 3 scope.
- Full `npm test`, global format, and Stage 4 Chinese package tests were not run.
- No business or authentication file was modified by the test agent, and no commit or push was made.
- `git worktree remove --force result-ui-locales-red` exited 0 after verification. The disposable worktree no longer exists.
