# 06: Ready to share

**What to build:** the drop-in is safe and easy to try. Its description says in 1 sentence what
it does and what it reads (its own settings, which Pi Pocket keeps; no file, no session, and no
other service). A person can copy the 2 files into `~/.pi-pocket/extensions/` by the steps in a
README, turn it on, and hear an answer. The module loads clean on a fresh copy of Pi Pocket: no
error in the log, and nothing in the Extensions sheet but the module and its 2 settings.

**Blocked by:** 05.

**Status:** done

- [x] The module's first comment gives the description that the Extensions sheet shows, in 1 sentence, and it matches what the code does.
- [x] A README beside the spec tells how to copy the files in, turn it on, and read an answer, and what the tab and the owner each choose.
- [x] A test loads the module as a drop-in, turns it on, and finds its page and its settings in the app, with no error.
- [x] `npm run check`, `npm run lint`, and `npm test` pass; the 7 tests of `test/voice-output.test.ts` pass.
      _(`test/voice-output.test.ts` and `test/voice-output/voice-output/` were removed later, on the branch
      `pocket/upgrade-fork-to-newest-pi-pocket-pi-6c2a3e`, at the request of the owner.)_
      _(`npm test` has 7 failures in tests this feature does not touch — `model-scope`, `branches`, `mobile-ui`, the browser's saved state — and `git stash` shows the same failures without this branch.)_
