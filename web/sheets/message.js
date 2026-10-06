// What a message's menu does: copy, fork from here, and send again (with this model or another).
import { useState } from "preact/hooks";
import {
    actions,
    attempt,
    canSteer,
    closeSheet,
    navigate,
    notify,
    scoped,
    store,
} from "../store.js";
import { copyText, html, Icon, item, modelLabel, replyText, Sheet, writtenText } from "../ui.js";

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

/** Send a message to Pi again in a fork: with this session's model, or another one. */
function SendAgain({ prompt, worktree }) {
    const { models, view } = store.state;
    const [choosing, setChoosing] = useState(false);
    const [query, setQuery] = useState("");
    const current = view.agent?.model;
    const needle = query.trim().toLowerCase();
    const others = models.filter(
        (model) =>
            !(model.provider === current?.provider && model.id === current?.modelId) &&
            (needle === "" ||
                `${model.provider}/${model.id} ${model.name}`.toLowerCase().includes(needle)),
    );

    return html`<div class="group">
        <div class="group-title">Send again in a new session</div>
        ${item(`With ${modelLabel(view.agent)}`, () => openBranch(() => actions.resend(prompt.id, { worktree })), "same model")}
        ${
            choosing
                ? html`<label class="search">
                    <${Icon} name="search" size=${16} />
                    <input
                        autofocus
                        placeholder="Search models"
                        value=${query}
                        onInput=${(event) => setQuery(event.currentTarget.value)}
                    />
                </label>
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
        }
    </div>`;
}

/** What can be done with one message: fork from it, edit it, send it again, or copy it. */
export function MessageSheet({ entryId }) {
    const { view } = store.state;
    const entry =
        view.entries.get(entryId) ?? store.state.history?.find((each) => each.id === entryId);
    const [draft, setDraft] = useState(null);
    const [worktree, setWorktree] = useState(false);

    if (entry?.kind !== "user" && entry?.kind !== "assistant") {
        return html`<${Sheet} title="Message" onClose=${closeSheet}>
            <p class="muted">This message is not here anymore.</p>
        <//>`;
    }

    // Forks are new sessions: who may start one may fork.
    const canBranch = canSteer() && !scoped() && view.conversation?.kind === "session";
    // A message to Pi (from anyone), or one of its replies.
    const toPi = entry.kind === "user";
    const text = toPi ? writtenText(entry) : replyText(entry);
    const prompt = toPi ? entry : promptBefore(entryId);
    const copy = () =>
        copyText(text).then(
            () => notify("info", "Copied."),
            () => notify("error", "Could not copy."),
        );

    if (draft !== null) {
        return html`<${Sheet} title="Edit and send again" onClose=${closeSheet}>
            <p class="muted small">
                Pi gets the edited message in a new session that forks just before the original. The original stays as it is.
            </p>
            <textarea
                rows="6"
                autofocus
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
        ${
            canBranch &&
            view.conversation.inRepository &&
            html`<label class="check">
                <input type="checkbox" checked=${worktree} onChange=${(event) => setWorktree(event.currentTarget.checked)} /> New sessions get a git worktree of their own
            </label>`
        }
        ${canBranch && !toPi && item("Fork from here", () => openBranch(() => actions.fork(entry.id, { worktree })), "everything up to this reply")}
        ${canBranch && toPi && item("Edit and send again…", () => setDraft(text))}
        ${canBranch && prompt && html`<${SendAgain} prompt=${prompt} worktree=${worktree} />`}
        ${item("Copy text", copy)}
    <//>`;
}
