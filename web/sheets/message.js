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
import { memoryAvailable } from "./memory.js";
import { t } from "../ui-locale.js";

/** The message to Pi a reply answers: the newest one before it. */
function promptBefore(entryId) {
    const { view } = store.state;

    for (let index = view.order.indexOf(entryId) - 1; index >= 0; index--) {
        const entry = view.entries.get(view.order[index]);

        if (entry?.kind === "user") {
            return entry;
        }
    }

    return undefined;
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
        notify(
            "info",
            t(
                "web.sheets.message.open-branch.opened-new-session-original",
                "Opened the new session. The original is unchanged.",
            ),
        );
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

    return html`<div class="group-title">${t(
        "web.sheets.message.send-again.div.send-again-new-session",
        "Send again in a new session",
    )}</div>
    ${item(
        t("web.sheets.message.send-again.text.content", "With {model}", {
            model: modelLabel(view.agent),
        }),
        () => openBranch(() => actions.resend(prompt.id, { worktree })),
        t("web.sheets.message.send-again.text.same-model", "same model"),
    )}
    ${
        choosing
            ? html`<div class="message-model-search">
                <label class="search">
                    <${Icon} name="search" size=${16} />
                    <input
                        ref=${search}
                        placeholder=${t(
                            "web.sheets.message.send-again.placeholder.search-models",
                            "Search models",
                        )}
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
            : item(
                  t("web.sheets.message.send-again.text.another-model", "With another model…"),
                  () => setChoosing(true),
              )
    }`;
}

/** What can be done with one message: fork from it, edit it, send it again, or copy it. */
export function MessageSheet({ entryId }) {
    const { view } = store.state;
    const entry =
        view.entries.get(entryId) ?? store.state.history?.find((each) => each.id === entryId);
    const [draft, setDraft] = useState(null);
    const [worktree, setWorktree] = useState(false);
    const field = useRef(null);

    useFocus(field, draft !== null);

    if (entry?.kind !== "user" && entry?.kind !== "assistant") {
        return html`<${Sheet} title=${t(
            "web.sheets.message.message-sheet.title.message",
            "Message",
        )} onClose=${closeSheet}>
            <p class="muted">${t(
                "web.sheets.message.message-sheet.p.message-not-anymore",
                "This message is not here anymore.",
            )}</p>
        <//>`;
    }

    // Forks are new sessions: who may start one may fork.
    const canBranch = canSteer() && !scoped() && view.conversation?.kind === "session";
    // A message to Pi (from anyone), or one of its replies.
    const toPi = entry.kind === "user";
    const text = toPi ? writtenText(entry) : replyText(entry);
    // A message of files alone has no words: its preview says so, and there is nothing to copy or remember.
    const filesAlone = toPi && text.trim() === "";
    const prompt = toPi ? entry : promptBefore(entryId);

    const copy = () => {
        closeSheet();
        copyText(text).then(
            () => notify("info", t("web.chat.render.text.copied", "Copied.")),
            () =>
                notify(
                    "error",
                    t("web.sheets.message.message-sheet.copy.not-copy", "Could not copy."),
                ),
        );
    };

    if (draft !== null) {
        return html`<${Sheet} title=${t(
            "web.sheets.message.message-sheet.title.edit-and-send-again",
            "Edit and send again",
        )} onClose=${closeSheet}>
            <p class="muted small">
                ${t("web.sheets.message.message-sheet.p.pi-gets-edited-message", "Pi gets the edited message in a new session that forks just before the original. The original stays as it is.")}
            </p>
            <textarea
                ref=${field}
                rows="6"
                value=${draft}
                onInput=${(event) => setDraft(event.currentTarget.value)}
            ></textarea>
            <div class="row">
                <button class="button" onClick=${() => setDraft(null)}>${t(
                    "web.sheets.message.message-sheet.button.back",
                    "Back",
                )}</button>
                <button
                    class="button primary grow"
                    onClick=${() => openBranch(() => actions.resend(entry.id, { text: draft, worktree }))}
                >
                    ${t(
                        "web.sheets.message.message-sheet.button.send-new-session",
                        "Send in a new session",
                    )}
                </button>
            </div>
        <//>`;
    }

    return html`<${Sheet} title=${
        toPi
            ? t("web.sheets.message.message-sheet.title.message", "Message")
            : t("web.sheets.message.message-sheet.title.reply", "Reply")
    } onClose=${closeSheet}>
        <div class="message-preview">${
            filesAlone
                ? t("web.sheets.message.message-sheet.text.attachments", "(attachments)")
                : text
        }</div>
        ${
            canBranch &&
            view.conversation.inRepository &&
            html`<div class="sheet-list">
                <div class="extension message-worktree">
                    <div class="extension-main">${t(
                        "web.sheets.message.message-sheet.div.new-sessions-get-git",
                        "New sessions get a git worktree of their own",
                    )}</div>
                    <${Switch}
                        on=${worktree}
                        label=${t(
                            "web.sheets.message.message-sheet.div.new-sessions-get-git",
                            "New sessions get a git worktree of their own",
                        )}
                        onChange=${() => setWorktree(!worktree)}
                    />
                </div>
            </div>`
        }
        <div class="sheet-list message-actions">
            ${
                canBranch &&
                !toPi &&
                item(
                    t("web.sheets.message.message-sheet.text.fork", "Fork from here"),
                    () => openBranch(() => actions.fork(entry.id, { worktree })),
                    t(
                        "web.sheets.message.message-sheet.text.everything-up-reply",
                        "everything up to this reply",
                    ),
                )
            }
            ${
                canBranch &&
                toPi &&
                item(
                    t(
                        "web.sheets.message.message-sheet.text.edit-send-again",
                        "Edit and send again…",
                    ),
                    () => setDraft(text),
                )
            }
            ${canBranch && prompt && html`<${SendAgain} prompt=${prompt} worktree=${worktree} />`}
            ${
                memoryAvailable() &&
                canSteer() &&
                !filesAlone &&
                item(
                    t("web.sheets.message.message-sheet.text.remember", "Remember…"),
                    () => openSheet({ type: "memory", draft: lessonFrom(text) }),
                    t(
                        "web.sheets.message.message-sheet.text.keep-lesson-pi",
                        "keep it as a lesson for Pi",
                    ),
                )
            }
            ${
                !filesAlone &&
                item(t("web.sheets.message.message-sheet.text.copy-text", "Copy text"), copy)
            }
        </div>
    <//>`;
}
