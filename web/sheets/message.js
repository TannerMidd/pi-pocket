// What a message's menu does: copy, fork from here, send again (with this model or another), and undo the last one.
import { useEffect, useRef, useState } from "preact/hooks";
import {
    actions,
    attempt,
    canSteer,
    closeSheet,
    insertIntoComposer,
    navigate,
    notify,
    openSheet,
    scoped,
    store,
} from "../store.js";
import {
    copyText,
    html,
    Icon,
    item,
    modelLabel,
    replyText,
    Sheet,
    Switch,
    writtenText,
} from "../ui.js";
import {
    choosePresentationMode,
    onPresentationMode,
    PRESENTATION_MODES,
    presentationMode,
    promptBefore,
    resendable,
} from "../entry-presentation.js";
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

/** The newest prompt, even if Pi's replies or a note came after it. */
function newestPrompt(view, history) {
    // Only pi.user entries project to user rows in this view.
    return (
        view.order.findLast((id) => view.entries.get(id)?.kind === "user") ??
        history?.findLast((entry) => entry.kind === "user")?.id
    );
}

/**
 * Whether Pi's answer to the newest prompt failed: its last reply after `entryId` ended in an error (the request did
 * not go through), or the run failed. Undo then reads as Retry: the same action, named for what the person wants.
 */
function answerFailed(view, entryId) {
    const at = view.order.indexOf(entryId);

    if (at === -1) {
        return false;
    }

    const reply = view.order
        .slice(at + 1)
        .map((id) => view.entries.get(id))
        .findLast((each) => each?.kind === "assistant");

    // A run can also fail with no answer that says so (its compaction failed, say): the session's row says it, and
    // the conversation shows its "Run failed" line.
    return (
        reply?.stopReason === "error" ||
        store.state.sessions.some(
            (each) => each.id === view.conversation.id && each.failed === true,
        )
    );
}

/**
 * Undo on the newest message to Pi (Retry when Pi's answer failed), for a person who may start sessions: `null` where
 * it is not offered, else whether it reads Retry, and `blocked`: why it cannot be pressed now. A blocked one shows
 * greyed out with that reason under it, rather than not at all, so nobody is left looking for it.
 */
function undoOffer(view, entry) {
    const { conversation } = view;

    if (
        !resendable(entry) ||
        !canSteer() ||
        scoped() ||
        (conversation.kind !== "session" && conversation.kind !== "subagent") ||
        newestPrompt(view, store.state.history) !== entry.id
    ) {
        return null;
    }

    return {
        retry: answerFailed(view, entry.id),
        // The server refuses the same: only sessions are copied, and PiP's never.
        blocked:
            conversation.kind === "subagent"
                ? "Not in a subagent"
                : conversation.pip
                  ? "Not in PiP"
                  : view.live.busy || view.live.compactions?.length
                    ? "Pi is working"
                    : // Stopped with messages held in the queue: an undo would drop them.
                      view.inbox.length > 0
                      ? "A message is queued"
                      : undefined,
    };
}

/** An undo on its way: a second tap waits for it. */
let undoing = false;

/**
 * Open a copy of the session without its last message `entryId`, archive the session, and put the message back in the
 * box. A second tap while the first is on its way does nothing.
 */
const undo = (entryId, retry = false) => {
    if (undoing) {
        return;
    }

    undoing = true;
    attempt(async () => {
        const { id, text, attachments, attachmentsOmitted } = await actions.undo(entryId);

        navigate(id);
        insertIntoComposer(text, [], { attachments });
        notify(
            "info",
            retry
                ? "Your message is back in the box to send again. The original is archived."
                : "Undid your last message. The original is archived.",
        );

        if (attachmentsOmitted) {
            notify("warning", "Some attachments could not be restored.");
        }
    }).finally(() => {
        undoing = false;
    });
};

/** A small action beside another under the list, each taking an equal share of the row, with a hint below it. */
const Minor = ({ label, hint, run, disabled = false }) => html`<button
    type="button"
    class="message-minor"
    aria-label=${label}
    disabled=${disabled}
    onClick=${run}
>
    <span>${label}</span>
    <span class="message-minor-hint">${hint}</span>
</button>`;

/** A fork or a send again on its way: a second tap waits for it. */
let branching = false;

/** Make a new session from this one and open it. A second tap while the first is on its way does nothing. */
const openBranch = (run) => {
    if (branching) {
        return;
    }

    branching = true;
    attempt(async () => {
        const created = await run();

        navigate(created.id);
        notify("info", "Opened the new session. The original is unchanged.");
    }).finally(() => {
        branching = false;
    });
};

/**
 * A field that shows in a sheet already open takes the keys, where a keyboard is at hand: the sheet focused its field
 * marked autofocus only when it opened.
 */
function useFocus(ref, shown) {
    useEffect(() => {
        if (shown && !matchMedia("(pointer: coarse)").matches) {
            ref.current?.focus({ preventScroll: true });
        }
    }, [shown]);
}

/** Send a message to Pi again in a fork: with this session's model, or another one. */
function SendAgain({ prompt, worktree }) {
    const { models, view } = store.state;
    const [choosing, setChoosing] = useState(false);
    const [query, setQuery] = useState("");
    const search = useRef(null);

    useFocus(search, choosing);
    const current = view.agent?.model;
    const needle = query.trim().toLowerCase();
    const others = models.filter(
        (model) =>
            !(model.provider === current?.provider && model.id === current?.modelId) &&
            (needle === "" ||
                `${model.provider}/${model.id} ${model.name}`.toLowerCase().includes(needle)),
    );

    return html`<div class="group-title">Send again in a new session</div>
    ${item(`With ${modelLabel(view.agent)}`, () => openBranch(() => actions.resend(prompt.id, { worktree })), "same model")}
    ${
        choosing
            ? html`<div class="message-model-search">
                <label class="search">
                    <${Icon} name="search" size=${16} />
                    <input
                        ref=${search}
                        placeholder="Search models"
                        value=${query}
                        onInput=${(event) => setQuery(event.currentTarget.value)}
                    />
                </label>
            </div>
            ${others.map((model) =>
                item(
                    model.name,
                    () =>
                        openBranch(() =>
                            actions.resend(prompt.id, {
                                model: { provider: model.provider, modelId: model.id },
                                worktree,
                            }),
                        ),
                    html`<span class="mono">${model.provider}</span>`,
                ),
            )}`
            : item("With another model…", () => setChoosing(true))
    }`;
}

/** What can be done with one message: fork from it, edit it, send it again, or copy it. */
export function MessageSheet({ entryId }) {
    const { view } = store.state;
    const entry =
        view.entries.get(entryId) ?? store.state.history?.find((each) => each.id === entryId);
    const [draft, setDraft] = useState(null);
    const [worktree, setWorktree] = useState(false);
    // A presented input the view clipped: its whole text, for Copy and Remember.
    const [whole, setWhole] = useState(undefined);
    const field = useRef(null);
    const clipped = entry?.kind === "user" && entry.presentation?.clipped !== undefined;

    useFocus(field, draft !== null);
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

    // Forks are new sessions: who may start one may fork.
    const canBranch = canSteer() && !scoped() && view.conversation?.kind === "session";
    // A message to Pi (from anyone), or one of its replies.
    const toPi = entry.kind === "user";
    // An input a module stored as its own kind is shown, copied, and remembered, never sent again.
    const again = !toPi || resendable(entry);
    const text = toPi ? (whole ?? writtenText(entry)) : replyText(entry);
    // Until its whole text is here, a clipped input has nothing to copy or remember.
    const waiting = clipped && whole === undefined;
    // A message of files alone has no words: its preview says so, and there is nothing to copy or remember.
    const filesAlone = toPi && text.trim() === "";
    const prompt = toPi ? entry : promptBefore(entryId, view);
    // Undo (or Retry) on the last message to Pi: greyed out with the reason when it cannot be pressed now.
    const offer = toPi && !waiting ? undoOffer(view, entry) : null;

    const copy = () => {
        closeSheet();
        copyText(text).then(
            () => notify("info", "Copied."),
            () => notify("error", "Could not copy."),
        );
    };

    if (draft !== null) {
        return html`<${Sheet} title="Edit and send again" onClose=${closeSheet}>
            <p class="muted small">
                Pi gets the edited message in a new session that forks just before the original. The original stays as it is.
            </p>
            <textarea
                ref=${field}
                rows="6"
                value=${draft}
                onInput=${(event) => setDraft(event.currentTarget.value)}
            ></textarea>
            <div class="row">
                <button class="button" onClick=${() => setDraft(null)}>Back</button>
                <button
                    class="button primary grow"
                    onClick=${() => openBranch(() => actions.resend(entry.id, { text: draft, worktree }))}
                >
                    Send in a new session
                </button>
            </div>
        <//>`;
    }

    return html`<${Sheet} title=${toPi ? "Message" : "Reply"} onClose=${closeSheet}>
        <div class="message-preview">${filesAlone ? "(attachments)" : text}</div>
        ${toPi && entry.presentation && html`<${PresentationChoice} presentation=${entry.presentation} />`}
        ${
            canBranch &&
            view.conversation.inRepository &&
            html`<div class="sheet-list">
                <div class="extension message-worktree">
                    <div class="extension-main">New sessions get a git worktree of their own</div>
                    <${Switch}
                        on=${worktree}
                        label="New sessions get a git worktree of their own"
                        onChange=${() => setWorktree(!worktree)}
                    />
                </div>
            </div>`
        }
        <div class="sheet-list message-actions">
            ${canBranch && !toPi && item("Fork from here", () => openBranch(() => actions.fork(entry.id, { worktree })), "everything up to this reply")}
            ${canBranch && toPi && again && !waiting && item("Edit and send again…", () => setDraft(text))}
            ${canBranch && again && prompt && html`<${SendAgain} prompt=${prompt} worktree=${worktree} />`}
            ${
                memoryAvailable() &&
                canSteer() &&
                !filesAlone &&
                !waiting &&
                item(
                    "Remember…",
                    () => openSheet({ type: "memory", draft: lessonFrom(text) }),
                    "keep it as a lesson for Pi",
                )
            }
            ${!offer && !filesAlone && !waiting && item("Copy text", copy)}
        </div>
        ${
            offer &&
            html`<div class="message-minors">
                <${Minor}
                    label=${offer.retry ? "Retry" : "Undo"}
                    hint=${offer.blocked ?? (offer.retry ? "Unsend and try again" : "Unsend and edit")}
                    disabled=${offer.blocked !== undefined}
                    run=${() => undo(entry.id, offer.retry)}
                />
                ${!filesAlone && html`<${Minor} label="Copy text" hint="As written" run=${copy} />`}
            </div>`
        }
    <//>`;
}
