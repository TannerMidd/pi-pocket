# Request locale pages: baseline evidence

- Repository: `/home/xianbei233/Work/pi-pocket-pr`, branch `feat/ui-locale-packs`, HEAD `5e8e2de8`.
- Before the HTTP implementation, `node --test --test-name-pattern='^one public link keeps overlapping' test/request-locale-pages.test.ts` exited 1. The parent session reran this real pre-edit case after taking over the stopped test agent.
- The named assertion `French request receives its own locale` failed: actual `lang: en`, `text: Menu`; expected `lang: fr`, `text: Menu français`.
- Both requests used the same real public-link path. Both reached the asynchronous handler gate before release, and both responses returned HTTP 200.
- The test used the real extension loader, a synthetic French pack, a temporary app and a real HTTP server. No core component was mocked.
- Final directed regression: `node --test test/request-locale-pages.test.ts test/public-links.test.ts test/design-system-routes.test.ts test/design-docsite.test.ts test/design-docsite-sanitize.test.ts` exited 0: 65 passed, 0 failed, 0 skipped. The 8 new request-locale cases all passed.
- The later delayed-body test uses a 100 ms pause after the client socket is assigned. It verifies that the viewer-authorized request remains open with an incomplete body, but it is not a direct server-side read barrier.
- The design-doc test uses the existing `app.menu` key for actual registered translation. The additional `server.design.docsite.*` call-site keys require the integration session's EN regeneration. This task did not edit `web/**` and does not claim those new keys are registered.
- The public overlap test checks that `request.locale` exists and is frozen, including for English. It attempts to change its `lang` and checks the resulting value.
- The four-request overlap holds all four real public handlers at one gate. Its expected status vector is 200/200/200/200, with English/French/English/French snapshots.
- The document-route test reads each artifact body from `ArtifactBodyDoc`. It checks a hostile project name and a hostile `app.menu` translation in the stored HTML.

## Final checks and limits

- `node --check` exited 0 for `src/server/host.ts`, `src/server/http.ts`, `src/server/http/locale.ts`, `src/server/http/extension-routes.ts`, `src/server/http/link-routes.ts`, `src/server/extensions/design/system-routes.ts`, `src/server/design/docsite.ts`, `types/pocket.d.ts`, and `test/request-locale-pages.test.ts`.
- `npm run check` last exited 2. Its only reported errors are in foreign `test/wp2-*`, `test/wp4-*`, and `test/wp5-localization-ui.test.ts`; no current task file has a reported diagnostic. The exact diagnostics are in `/tmp/pi-pocket-request-locale-check.log`. This is not a full-project type-check pass.
- The first type-check also reported one optional assertion-message type in this task test. It was fixed with an explicit fallback before the successful 65-test run.
- Baseline output: `/tmp/pi-pocket-request-locale-red.log`; final directed output: `/tmp/pi-pocket-request-locale-directed.log`.
- Existing concurrent WP6 edits in `design/docsite.ts` and its helper files were retained. This task completed the shared request wiring and same-file fixed-text lookups, without editing the other helper files.
- No global format, ESLint, full `npm test`, staging, commit, push or production-service operation was performed.

## Export and PR-watch follow-up

The new rendering arguments are optional request-level `RequestLocale` values. `transcriptMarkdown(input, locale?)` and `endedText(watch, locale?)` keep their old English behavior when the argument is absent. They keep no current language in process state. User titles, compaction content and an explicit watch error reason remain literal. The exported HTML summary uses the existing `http/io.ts` `escapeHtml`; `endedText` still returns plain text for its caller to escape in the output context.

| Key                                   | English                          | Simplified Chinese         |
| ------------------------------------- | -------------------------------- | -------------------------- |
| `server.export.context-compacted`     | `Context compacted`              | `上下文已压缩`             |
| `server.watches.ended.failed`         | `until it had to stop: {reason}` | `直到不得不停下：{reason}` |
| `server.watches.ended.unknown-reason` | `something went wrong`           | `出现了问题`               |

- Before implementation: `node --test test/request-locale-export-watch.test.ts` exited 1. The named behavioral failure was `Chinese request gets its translated export heading`; the translated-heading escaping assertion also failed. This was not an import or type failure. Output: `/tmp/pi-pocket-export-watch-red.log`.
- After implementation: `node --test test/request-locale-export-watch.test.ts test/request-locale-pages.test.ts` exited 0: 10 passed, 0 failed, 0 skipped. Output: `/tmp/pi-pocket-export-watch-green.log`.
- The new HTTP test sends `pocket_locale=en` and `pocket_locale=zh-CN` to the same temporary `/render` path. Both reach one asynchronous barrier before either renders. They use real `requestLocale`, `transcriptMarkdown` and `endedText`, with a fixed immutable test snapshot. The English output contains `Context compacted` and `until it had to stop: something went wrong`; the Chinese output contains `上下文已压缩` and `直到不得不停下：出现了问题`. Both responses are 200. This test server is a rendering harness, not the application’s existing export route.
- Hostile translated headings are escaped; a hostile explicit watch reason remains raw text until the existing HTML escaper runs. Old one-argument calls remain English.
- `node --check src/server/export.ts`, `node --check src/server/watches.ts`, and `node --check test/request-locale-export-watch.test.ts` all exited 0.
- The final `npm run check` exited 0, including TypeScript, declaration validation and reference checks. Diagnostics for this follow-up’s files: 0. Output: `/tmp/pi-pocket-export-watch-check.log`. This later result supersedes the earlier shared-tree check failure above.
- Scope limit: this follow-up did not change `transcripts.ts`, HTTP conversation routes, watch tool callers or `web/**`. Existing product callers omit the new optional argument and remain English until the integration session passes its request locale. The test snapshot supplies the 3 new translations directly; integration must add the keys to the canonical English catalog before a real locale pack can register them.
