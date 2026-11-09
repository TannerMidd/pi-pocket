// What a message's menu does: copy, fork from here, and send again (with this model or another).
import { useEffect, useRef, useState } from "preact/hooks";
import {
    actions,
    attempt,
    canSteer,
    closeSheet,
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
            ${!filesAlone && !waiting && item("Copy text", copy)}
        </div>
    <//>`;
}
