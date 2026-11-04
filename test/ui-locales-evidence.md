# Stage 1 UI locale test evidence

## Scope and snapshot

- The tests exercise the real validator, `UiLocales`, `ExtensionWebs`, and `ExtensionLoader` with a real `Registry` and temporary modules. They do not mock core.
- The main repository is `/home/xianbei233/Work/pi-pocket-pr` on `feat/ui-locale-packs`. The base is `db1e531d492f9ce231ba7a9761c52c0ebc7becc0`.
- The owner approved the disposable worktree `result-ui-locales-red` under the main repository. It was detached at the base. The implementation and the tests were copied into it, without a commit.
- The last green run and the mutations used the same file bytes in both worktrees. SHA-256 values are below. The mutations restored their source files in `finally`.
- No business file in the main worktree was changed by this test task. The existing `specs/DICTIONARY-*` and `specs/tools/*` files were not created or changed by this test task.

| File                            | SHA-256                                                            |
| ------------------------------- | ------------------------------------------------------------------ |
| `src/server/ui-locales.ts`      | `623faef37b067b7896533ab90b8b0c28baeb29e6775fb5ca367a1362229ea1ce` |
| `src/server/extension-web.ts`   | `1fe6f3140e5b8f1966c6bb5888c88e396d6fac2ddeec29b4213c9298fea256f9` |
| `src/server/reload.ts`          | `13ce8e7e8d1b3e9c823d7c1404503daa5f3f9448d7fe9f89e406f913310c7604` |
| `src/server/host.ts`            | `597fb48a08413f91e79ba80b941d7090f1f73c3a783950cbe7e1ec6f80fdd9bf` |
| `web/locale.js`                 | `7ffaccb4324c6e0c03a71c473bf3649e356b82a5f221d098c2e81850214c58f5` |
| `web/locales/en.js`             | `0b4571b4a2a08ce46fa288f5526baa3f75cfba307760f1bbf688a416fb581e98` |
| `types/pocket.d.ts`             | `5b588454f29ec68a3dfe75ab2c1a8a6a124c99f1dbe53a0e4ee095d8035b39b9` |
| `test/ui-locales.test.ts`       | `6573d11ba7dadf80ef011eaafa37feec9efc0ecb5fbf5957f21fcd6b9d3f67f2` |
| `test/locale-lookup.test.ts`    | `74b1a43b78510b4c650c686ed1877350ea5e9e80d314ac2763175b359b2d4a5a` |
| `test/extension-loader.test.ts` | `26754b40932ccd3f4d9ed2fe2d45f5091b489e37bb09ab1b8afbf08908e26755` |
| `test/extension-web.test.ts`    | `04ed2649888d8aadd9cc632e49d50e861c6a08259df20bdcb645ab585c06f1f4` |
| `test/public-types.ts`          | `315a0540688f5ee02b59bca7a3da4ae8f862c23c87e178e2eeb66667cab0ed37` |
| `test/ui-locales-mutate.cjs`    | `d322fb6beed1445bb7e0ccfb2558bcf0cb254f0b815b91042d36c59a448b5104` |

## Green commands

- Main worktree: `node --test test/ui-locales.test.ts test/locale-lookup.test.ts test/extension-loader.test.ts test/extension-web.test.ts` — exit 0; 58 passed; 0 failed; 0 skipped.
- The same command from `result-ui-locales-red` — exit 0; 58 passed; 0 failed; 0 skipped. This is the control for the mutation runs.
- Main worktree: `npm run check` — exit 0. It runs TypeScript, the public declaration check, and the documentation reference check.
- Main worktree: `npx eslint test/ui-locales.test.ts test/locale-lookup.test.ts test/extension-loader.test.ts test/extension-web.test.ts test/public-types.ts test/ui-locales-mutate.cjs` — exit 0.
- Main worktree: `npx prettier --check test/ui-locales.test.ts test/locale-lookup.test.ts test/extension-loader.test.ts test/extension-web.test.ts test/public-types.ts test/ui-locales-mutate.cjs` — exit 0.
- Main worktree: `git diff --check` — exit 0.

## Red commands and named failures

Run each mutation only inside the disposable worktree:

`node test/ui-locales-mutate.cjs <risk>`

The exact reversible replacement, test file, and test-name pattern are in `test/ui-locales-mutate.cjs`. Each row below exited 1 on the named behavioral assertion. The mutations ran one at a time and restored the source before the next run. None uses a missing module or import as behavioral evidence.

| Risk      | Mutation                                                                    | Red failure assertion                                                                                                    |
| --------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| R01       | `R01`: allow empty `messages`                                               | `Missing expected exception: empty messages`                                                                             |
| R01 / R05 | `R01T`: skip type validation for an unknown object                          | `Missing expected exception: unknown objects are rejected even if they act like strings`                                 |
| R02       | `R02`: read the declaration array with `Array.from`                         | `Missing expected exception: array-element getter`                                                                       |
| R03       | `R03`: raise the value limit by one byte                                    | `Missing expected exception: 8193 ASCII bytes`                                                                           |
| R03       | `R03A`: count filtered instead of declared messages in the committed budget | `Missing expected exception: unknown messages count before they are ignored`                                             |
| R04       | `R04`: accept an empty string as a translation                              | `'' !== 'Close'`                                                                                                         |
| R05       | `R05`: return the unknown key instead of call-site English                  | `'future.unknown' !== 'The explicit English'`                                                                            |
| R06       | `R06`: disable the placeholder-set comparison                               | `Missing expected exception: a missing placeholder is rejected`                                                          |
| R06       | `R06I`: apply interpolation twice                                           | An inserted `{other}` changed to `done`, instead of remaining literal.                                                   |
| R07       | `R07`: allow the reserved `en` ID                                           | `Missing expected exception: reserved en`                                                                                |
| R07       | `R07C`: return the original ID instead of the canonical ID                  | The lookup for `fr-CA` returned `undefined`, not `Quitter`.                                                              |
| R08       | `R08`: do not count locales in `WebPart.empty`                              | `Got unwanted rejection: a valid locale-only module installs without a synthetic extension`                              |
| R08       | `R08D`: omit locale IDs from the module description                         | The description had `[]`, not `['fr']`.                                                                                  |
| R09       | `R09`: merge by insertion order, not loader order                           | The resulting label was `Lower`, not `Higher`.                                                                           |
| R10       | `R10`: publish a discarded stage                                            | `a rejected package retains the old catalog and revision` failed; the old French layer disappeared and revision changed. |
| R16       | `R16`: leave the checked declaration array mutable                          | `Missing expected exception: the checked declaration array cannot be changed`                                            |
| R16       | `R16C`: retain the caller's mutable message object                          | The published message changed to `Changed`, instead of staying `Fermer`.                                                 |
| R17       | `R17`: retain the locale layer on module removal                            | The label stayed `Drop Z`, instead of exposing `Drop A revised`.                                                         |

Batch command, run in the disposable worktree:

`for risk in R01 R01T R02 R03 R03A R04 R05 R06 R06I R07 R07C R08 R08D R09 R10 R16 R16C R17; do node test/ui-locales-mutate.cjs "$risk" > "/tmp/ui-locales-mutation-$risk.log" 2>&1; status=$?; printf '%s exit=%s\n' "$risk" "$status"; done`

Each listed mutation exited 1. The log files contain the test runner's actual output. They are temporary machine files, not required to interpret the assertions above.

## R18 baseline interface evidence

At the detached base, before the implementation was copied into the disposable worktree:

`cp test/public-types.ts result-ui-locales-red/test/public-types.ts; (cd result-ui-locales-red && ../node_modules/.bin/tsc --noEmit -p .)`

Exit 2. The compiler reported that `UiLocalePack` was not exported and that `uiLocales` did not exist on `ExtensionWeb` or `Web`. This proves interface absence only. It is not red evidence for R01–R10 or R16–R17. The final `npm run check` above passed with the implementation.

## Defects and limits

- The earlier snapshot accepted an array-element getter, an overlong raw label, and a raw declaration over 1 MiB after label trimming. The current implementation passes the retained assertions for all 3.
- No implementation defect remains in the tested stage 1 scope. The tests also check timeout and stale loads, overlay removal, exact 4 MiB boundaries, unknown keys, notifications, and type compatibility.
- The committed 4 MiB budget includes unknown messages before filtering, as documented in the current limits reference. The separate 1 MiB test uses the original declaration bytes.
- `npm test`, `npm run format`, stages 2 and 3, browser tests, HTTP locale delivery, and SSR locale behavior were not run. This report does not claim those checks passed.
- No Chinese package or example was created. `git worktree remove --force result-ui-locales-red` exited 0 after the evidence was recorded. The worktree no longer exists.
