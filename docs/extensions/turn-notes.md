# Turn notes

An extension can add a short note for the model to a person's message. For example, a note can say how much time has passed since the last activity in the session. Use `host.annotateTurns`. Its shape is in [the host reference](reference/host.md#annotateturns).

**Experimental, since 0.30.0.** It can change in a minor release, but never in a patch release ([API stability](policies/api-stability.md#experimental)). A module for an older server checks that `host.annotateTurns` is there, and a gallery entry that needs it sets `minPocket` to `0.30.0`.

## What a note is

- A note is a separate entry in the transcript, right after the person's message. The person's message, its attachments, and its sender do not change.
- Pi Pocket stores the note in the same commit as the message. A restart cannot lose it or write it two times. A retry of a message that is already stored does not ask the annotators again. Two tries of one message at the same moment can both ask them, but only one note is stored.
- The model reads the note as a user message, on this turn and on all later turns, until compaction or a reset removes it. Compaction treats it like any other entry.
- The model reads the note's source first: `Note from extension <name>:` on its own line, then the text. `<name>` is the name the module gave to `annotateTurns`, and a note cannot change it. So a note that tries to look like a person or another source still shows where it came from. Pi Pocket writes this label into the stored entry one time, when it stores the note.
- A note never starts a run. The person's message starts the run, as usual.
- Pi Pocket writes the text one time and does not compute it again. Nothing older in the transcript changes, so the provider's prompt cache stays valid for each earlier request.
- The transcript shows the note as "Note for Pi from `name`", with its first 3 lines of text. A tap shows all of it. It never shows as a person's words.

## Which messages get notes

Only a message that Pi Pocket can place at once gets notes. That is a message to a session where Pi does not work and nothing is queued.

- **A queued message gets no note.** Pi Durable puts a queued message in the context when it is its turn: at the end of the run for a follow-up, or after the tool round for a steer. A note could not go into the context at the same time, so Pi Pocket does not ask the annotators.
- A message sent with **Interrupt** gets no note, because it stops a run first.
- Notes come for every message that goes through Pi Pocket's message path: messages that people send in the app, a plan that a person approves, and messages sent for a person by PiP, by a linked session, by `host.sessions.start`, by `host.inbox` (webhooks, the relay), and by PR and repository watches. `turn.via` names what sent a message for a person.
- Scheduled messages, a message sent again (Resend), reports of background tasks and subagents, and PiP's own conversation get no notes.

## The annotator

`annotate(turn)` gets the session, the person, the message's text, when it came (`at`), and the newest time of a message, an answer, or a tool result among the session's last 32 entries (`previousActivityAt`). These entries can come from before a reset. It returns the note's text, or `undefined` for no note. It can be `async`.

- Keep it fast. The message waits for the annotators, for 2 seconds at most together. An annotator that is late, throws, or returns more than 4,000 characters adds nothing, and the session shows a warning. The message goes on.
- `turn.signal` aborts when the 2 seconds end.
- Several modules can add annotators. Their notes come in the order the modules added them.
- The note's text is model input. Write it for the model, and do not put a value there that people must not see: everyone in the session can read the note.

## An example: time gaps

This module tells the model when a person writes after a long silence.

```typescript title="time-gap.ts"
/**
 * Time gap: tells Pi how long a session was quiet when a person writes after a long silence.
 */
import type { Host, Turn, Web } from "./_pocket.d.ts";

const HOUR = 3_600_000;

function gap(turn: Turn): string | undefined {
    if (turn.previousActivityAt === undefined) {
        return undefined;
    }

    const hours = (turn.at - turn.previousActivityAt) / HOUR;

    if (hours < 3) {
        return undefined;
    }

    const days = Math.round(hours / 24);

    return hours < 36 ? `About ${Math.round(hours)} hours` : `About ${days} days`;
}

export default function createTimeGap(host: Host, web: Web) {
    // A server older than 0.30.0 has no turn notes: do nothing there.
    if (typeof host.annotateTurns !== "function") {
        return;
    }

    web.onDispose(
        host.annotateTurns("time-gap", (turn) => {
            const passed = gap(turn);

            return passed === undefined
                ? undefined
                : `<system-reminder>\n${passed} have passed since the previous message.\n</system-reminder>`;
        }),
    );
}
```

The same module is in [examples/time-gap.ts](../examples/time-gap.ts).
