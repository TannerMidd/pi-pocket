---
status: in-progress
issue:
---

# Voice output

## Problem Statement

Somebody who runs Pi Pocket mostly from a phone wants to hear Pi's answers instead of
reading them: while walking, while the phone is in a pocket, or while looking at something
else. Pi Pocket has no voice output. Reading the screen with the phone's own accessibility
features gives only a snapshot of what shows at the moment of the gesture. It never follows
answers that arrive later.

## Solution

A drop-in extension, `voice-output`, that reads Pi's answers aloud with the browser's own
speech (`speechSynthesis`). Each person turns it on with one tap in the tab they use, and
then:

- taps **Read aloud** under any answer of Pi to hear it; and
- can turn on **new answers**, so that each answer of Pi is read as it arrives, in the session
  that the tab shows, and only when that person is the one Pi answers there.

The owner chooses the voice and the speed once, in Menu → Extensions, under the module. The
voice and the speed are for every tab. The on/off choice, new answers, and whether code is
read belong to each tab.

The extension changes nothing in Pi Pocket's own code. It lives in `~/.pi-pocket/extensions/`
and the owner turns it on in Menu → Extensions. It is written so that it can become a built-in
module or a gallery entry later, with no change but a move.

## User Stories

1. As a person on a phone, I want one tap under an answer to hear it, so that I do not have to read a long one.
2. As a person with voice output on, I want each new answer of Pi read as it arrives, so that the phone can stay in my pocket.
3. As the owner, I want to choose the voice and the speed once, so that every tab of mine sounds the same.
4. As a person in a shared session, I want only the tab of the person Pi answers to read aloud, so that a phone in another room does not start talking.
5. As a person, I want a stop and a "hear it" button in the module's page, so that I can test a voice before I use it.
6. As a person, I want code blocks read as "bash code, 12 lines", so that an answer with code stays short to hear.
7. As a person whose answer starts with a long task, I want the voice to go on when the answer goes on after a tool call, so that I do not hear the start alone.
8. As a person in a browser with no voice, I want to be told, so that I do not wonder why nothing happens.

## Implementation Decisions

- **Two files in the drop-in folder.** `voice-output.ts` (the server module) and the
  `voice-output/` folder with `index.js` (the browser module). Pi Pocket names the module after
  the `.ts` file, which names both parts.
- **Server side is small.** It declares 2 settings (`voice`, a choice; `rate`, a number from
  0.5 to 2) with `web.settings`, and gives the browser module with `web.client`. It hears the
  app's `run.started` and `run.ended` events with `host.on`, and sends its tabs a `running`
  event (`true` at the start, `false` at the end) with the session's id. It adds no tool, hook,
  prompt section, document, route, or timer. It checks `host.pocketVersion` is 0.22.0 or later,
  the first version with settings and these events, and adds nothing on an older server.
- **A restart sends nothing.** Pi Durable can run an `onYield` hook again after a restart. A
  listener that only sends an event is replayed only when a person's message sent Pi on, so the
  event is harmless when it comes twice. There is no state to keep and no `api.memo`.
- **No routes.** The browser module gets the settings from `pocket.settings()` (it leaves a
  secret out, and these two are not secret), and hears changes with `pocket.onSettings`.
- **Engine, for now, is the browser's speech.** The reading is in a small class of its own
  (a queue of sentences) so that a server-side engine, such as Piper through an
  OpenAI-compatible endpoint, can replace it with no change to the rest. Piper is not built.
- **Sentence chunks.** Chromium stops `speechSynthesis` after about 15 seconds of one
  utterance. The reader speaks one sentence at a time, from one queue for the tab, so a second
  read replaces the first.
- **Markdown to words.** A function in the browser module turns an answer's Markdown into what
  is read: no markers, links, HTML tags, or emoji; headings and lists to sentences; a table
  says "Table."; fenced code and inline code say "bash code, 12 lines" unless the tab turns on
  reading code. It also drops the `[via …]` marker that a message from another agent starts with.
- **Where the tab is, and who it is.** New answers are read only when:
    - new answers is on in this tab;
    - the tab shows a session; and
    - the person in this tab is the person Pi works for in that session. The module reads it
      from `pocket.messages()` on load and on each change of session. There is no public host
      member to ask for it, so this is the one weak point: the check is as good as the last
      message that the tab read.
- **How a new answer is found.** No event in the browser says that Pi answered. The server
  hears `run.started` and `run.ended`, and sends its tabs a `running` event with the session's
  id (`true` at the start, `false` at the end). Its tabs read the session's newest messages
  then (`pocket.messages()`), which is 1 request at the start and 1 at the end of each run, and
  read the new answers by their id, each one time. A tab whose server has an older host, and so
  no listener for these events, says so in the page and reads no new answer.
- **An answer in parts is not waited for.** Reading a part does not hold back for the next
  part of the same answer: each part is read when the run ends, and the end of the run reads
  the parts that the start did not have, in order, one time each.
- **The parts of the app it uses:** `pocket.rail` with `page` (the page, with voice output,
  new answers, code, a field of text, Hear it and Stop), `pocket.replyAction` (Read aloud under
  each answer), `pocket.Switch`, `pocket.settings`, `pocket.onSettings`, `pocket.on`,
  `pocket.messages`, `pocket.onConversation`, `pocket.notify`.
- **Per-tab state** goes in `sessionStorage` under `x.voice-output.state`, one JSON object:
  `{ enabled, auto, voiceMode, rate, readCode }`. `voiceMode` is the last value that the owner's
  setting had, for a tab whose setting did not arrive.
- **The switch is the gesture.** iOS starts no speech without a tap. The tap on Voice output
  turns it on and unlocks the voice at the same time.

## Testing Decisions

Good tests check what a person hears and sees, not how the module is written:

- A helper that loads the module in a real Chromium (as `test/extension-ui.test.ts` does) and
  puts a fake `speechSynthesis` in the page before the module loads, which records each
  utterance's words, rate, and voice.
- **Server:** the module loads as a drop-in with 2 settings and a browser module, and adds
  nothing on a server older than 0.22.0.
- **Browser:** Read aloud under an answer reads its words with no Markdown in them; a code
  block says "code, N lines", or is read when code is on; the page's switch turns reading on;
  a second read replaces the first; new answers on reads the answers of a run when it ends, in
  order and one time each; a tab whose person is not Pi's in the session reads no new answer.
- **Unit:** the Markdown-to-words function alone, on the shapes that answers take.
- The 2 drop-in files live in `test/voice-output/` (`voice-output.ts` and the folder `voice-output/`),
  and they are the ones that a person copies into `~/.pi-pocket/extensions/`. The browser module
  `voice-output/index.js` and the test `test/voice-output.test.ts` were removed on the branch
  `pocket/upgrade-fork-to-newest-pi-pocket-pi-6c2a3e`, at the request of the owner.

The checks before a share: `npm run check`, `npm run lint`, and `npm test` in Pi Pocket, with
the module copied into `test/` for the run and removed after.

## Out of Scope

- **Server-side speech (Piper, OpenAI, ElevenLabs).** Later, behind the engine seam. It needs a
  service, a key, or a GPL dependency.
- **Reading while the screen is locked or the app is in the background.** A page in the
  background has its speech stopped by the browser. Only server-made audio with a real player
  would hold. Out of scope with server-side speech.
- **The host machine's speakers** (as the Pi coding-agent TTS extensions do). This is the
  browser that the person chats in.
- **Reading the answer as it streams, token by token.** One sentence at a time, from the
  answer's words when it is final, or as the run ends.
- **Any change to Pi Pocket's own code.** If the new-answers search must have a public event,
  this spec changes first (§Open questions).
- **Other languages' voices, and per-session voices.** The owner picks one voice for every tab.

## Further Notes

- Research: `~/Repos/lukas_ai/docs/research/voice-output/pi-voice-feasibility.md` (Path B: a
  Pi Pocket drop-in) and `voice-output-findings.md` (read-aloud, and how the missing pieces
  look elsewhere).
- The work in progress, before this spec, is in `.tmp-voice-output/` in the Pi Pocket folder.
  It is not part of the drop-in and goes when the tasks have their files.
- This is a drop-in (rule C11, `docs/extensions/policies/core-or-extension.md`): one person's
  preference, not a part that Pi Pocket must ship. It uses only `host` and `web` at run time
  (C14), so it can become built-in (C13) or a gallery entry (C12) later.
- A gallery entry needs a public repository, the pins of its files, and a review. Not in this
  feature.
