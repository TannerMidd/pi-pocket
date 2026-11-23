// What tapping a message opens, in the copy sheet's layout (`copy.js`). Pi's reply: fork from it, to a computer, folder,
// and model of your choice; remember it; copy it. Your message: edit it at once and send it again in a new session,
// placed the same way; copy it. Each sheet offers only the action of what was tapped.
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { updateDraft } from "../copy-draft.js";
import {
    actions,
    attempt,
    canSteer,
    closeSheet,
    notify,
    openSheet,
    scoped,
    store,
} from "../store.js";
import { copyText, html, replyText, Sheet, writtenText } from "../ui.js";
import {
    choosePresentationMode,
    onPresentationMode,
    PRESENTATION_MODES,
    presentationMode,
    resendable,
} from "../entry-presentation.js";
import { PlaceRows, placeOf, startCopy, useMainKey, usePlace } from "./copy.js";
import { memoryAvailable } from "./memory.js";

/** What each mode is called where a person chooses it. */
const MODE_NAMES = { open: "Show", folded: "Fold", hidden: "Hide" };

/**
 * How this browser shows inputs of one kind a module presents: as messages, folded to a line, or hidden until Find.
 * It changes every row of that kind in this browser.
 */
function PresentationChoice({ presentation }) {
    const kind = presentation.entryKind;
    const [mode, setMode] = useState(() => presentationMode(kind));

    useEffect(
        () =>
            onPresentationMode((changed, next) => {
                if (changed === kind) {
                    setMode(next);
                }
            }),
        [kind],
    );

    return html`<div class="setting wrap presented-choice" data-part="presented-choice">
        <div class="grow">
            <div class="small">Show inputs like this</div>
            <div class="muted small">
                Every “${presentation.label}” in this browser. Pi still reads them in full.
            </div>
        </div>
        <div class="segmented" role="group" aria-label=${`Show “${presentation.label}” inputs`}>
            ${PRESENTATION_MODES.map(
                (value) => html`<button
                    type="button"
                    class=${mode === value ? "on" : ""}
                    aria-pressed=${mode === value ? "true" : "false"}
                    onClick=${() => attempt(async () => choosePresentationMode(kind, value))}
                >
                    ${MODE_NAMES[value]}
                </button>`,
            )}
        </div>
    </div>`;
}

/** A message as the start of a lesson: one line, cut to a lesson's length. */
function lessonFrom(text) {
    const flat = text.replace(/\s+/g, " ").trim();

    return flat.length > 300 ? `${flat.slice(0, 299)}…` : flat;
}

/** A small action under the main button: a link-like button with an optional hint. */
const Minor = ({ label, hint, run }) => html`<button
    type="button"
    class="copy-minor"
    title=${hint}
    onClick=${run}
>
    <span>${label}</span>
    ${hint && html`<span class="copy-minor-hint">${hint}</span>`}
</button>`;

/** Copy `text` and close the sheet. */
const copyAndClose = (text) => {
    closeSheet();
    copyText(text).then(
        () => notify("info", "Copied."),
        () => notify("error", "Could not copy."),
    );
};

/** What can be done with one message: Pi's reply (`ReplySheet`), or a message to Pi (`OwnMessageSheet`). */
export function MessageSheet({ entryId }) {
    const { view } = store.state;
    const entry =
        view.entries.get(entryId) ?? store.state.history?.find((each) => each.id === entryId);
    // A presented input the view clipped: its whole text, for Copy, Remember, and sending again.
    const [whole, setWhole] = useState(undefined);
    const clipped = entry?.kind === "user" && entry.presentation?.clipped !== undefined;

    useEffect(() => {
        if (!clipped) {
            return;
        }

        let gone = false;

        actions.fullEntry(entryId).then(
            (full) => {
                if (!gone && full?.kind === "user") {
                    setWhole(writtenText(full));
                }
            },
            () => {},
        );

        return () => {
            gone = true;
        };
    }, [entryId, clipped]);

    if (entry?.kind !== "user" && entry?.kind !== "assistant") {
        return html`<${Sheet} title="Message" onClose=${closeSheet}>
            <p class="muted">This message is not here anymore.</p>
        <//>`;
    }

    // Copies are new sessions: who may start one may make one.
    const canBranch = canSteer() && !scoped() && view.conversation?.kind === "session";

    if (entry.kind === "assistant") {
        return html`<${ReplySheet} entry=${entry} canBranch=${canBranch} />`;
    }

    return html`<${OwnMessageSheet}
        entry=${entry}
        canBranch=${canBranch}
        text=${whole ?? writtenText(entry)}
        waiting=${clipped && whole === undefined}
    />`;
}

/** Pi's reply: a short preview, fork from here with its place rows, then Remember and Copy. */
function ReplySheet({ entry, canBranch }) {
    const { view } = store.state;
    const sessionId = view.conversation.id;
    const text = replyText(entry);
    const empty = text.trim() === "";
    const draft = usePlace(sessionId, `reply:${sessionId}:${entry.id}`);
    const [busy, setBusy] = useState(false);
    const go = useCallback(() => {
        if (!canBranch || busy) {
            return;
        }

        setBusy(true);
        startCopy(
            (signal) => actions.fork(entry.id, { place: placeOf(draft) }, signal),
            "Opened the fork. The original is unchanged.",
            draft,
        ).finally(() => setBusy(false));
    }, [canBranch, busy, draft, entry.id]);

    useMainKey("message", go);

    return html`<${Sheet} title="Reply" onClose=${closeSheet} className="copy-sheet">
        <div class="copy-what copy-preview">${empty ? "(no text)" : text}</div>
        ${
            canBranch &&
            html`<${PlaceRows} sessionId=${sessionId} draft=${draft} verb="Fork" />
                <div class="copy-go">
                    <button
                        type="button"
                        class="button primary wide"
                        disabled=${busy}
                        onClick=${go}
                    >
                        Fork from here
                    </button>
                    <p class="muted small">
                        A new session with everything up to this reply. The original stays as it is.
                    </p>
                </div>`
        }
        <div class="copy-minors">
            ${
                memoryAvailable() &&
                canSteer() &&
                !empty &&
                html`<${Minor}
                    label="Remember…"
                    hint="Opens Memory with this reply as a draft lesson"
                    run=${() => openSheet({ type: "memory", draft: lessonFrom(text) })}
                />`
            }
            ${!empty && html`<${Minor} label="Copy text" hint="As Markdown" run=${() => copyAndClose(text)} />`}
        </div>
    <//>`;
}

/**
 * A message to Pi: its text, editable at once, send it again in a new session with its place rows, then Copy. An input
 * a module stored as its own kind is shown and copied, never sent again.
 */
function OwnMessageSheet({ entry, canBranch, text, waiting }) {
    const { view } = store.state;
    const sessionId = view.conversation.id;
    const again = canBranch && resendable(entry) && !waiting;
    // A message of files alone has no words: there is nothing to copy.
    const filesAlone = text.trim() === "";
    const draft = usePlace(sessionId, `message:${sessionId}:${entry.id}`, () => ({ text: null }));
    // The text as the person has it now: the original until they type (or until its whole text comes).
    const written = draft.text ?? text;
    const edited = draft.text !== null && draft.text !== text;
    const [busy, setBusy] = useState(false);
    const field = useRef(null);
    const go = useCallback(() => {
        if (!again || busy || (filesAlone && !edited)) {
            return;
        }

        setBusy(true);
        startCopy(
            (signal) =>
                actions.resend(
                    entry.id,
                    {
                        ...(edited ? { text: written } : {}),
                        place: placeOf(draft),
                    },
                    signal,
                ),
            "Opened the new session. The original is unchanged.",
            draft,
        ).finally(() => setBusy(false));
    }, [again, busy, draft, edited, written, entry.id, filesAlone]);

    useMainKey("message", go);

    return html`<${Sheet} title="Your message" onClose=${closeSheet} className="copy-sheet">
        ${
            again
                ? html`<textarea
                      ref=${field}
                      class="copy-text"
                      rows="5"
                      aria-label="Your message"
                      placeholder=${filesAlone ? "(attachments only)" : ""}
                      value=${written}
                      onInput=${(event) => updateDraft({ text: event.currentTarget.value })}
                  ></textarea>`
                : html`<div class="copy-what copy-preview">
                      ${filesAlone ? "(attachments)" : waiting ? "…" : text}
                  </div>`
        }
        ${entry.presentation && html`<${PresentationChoice} presentation=${entry.presentation} />`}
        ${
            again &&
            html`<${PlaceRows} sessionId=${sessionId} draft=${draft} verb="Send again" />
                <div class="copy-go">
                    <button
                        type="button"
                        class="button primary wide"
                        disabled=${busy || written.trim() === ""}
                        onClick=${go}
                    >
                        ${edited ? "Send edited in a new session" : "Send again in a new session"}
                    </button>
                    <p class="muted small">
                        Pi gets ${edited ? "the edited" : "this"} message in a new session that forks just before the
                        original. The original stays as it is.
                    </p>
                </div>`
        }
        <div class="copy-minors">
            ${!filesAlone && !waiting && html`<${Minor} label="Copy text" hint="As written" run=${() => copyAndClose(text)} />`}
        </div>
    <//>`;
}
