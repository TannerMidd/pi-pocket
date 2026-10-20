// Shared session tags: personal list filters and explicit, cancelable tag patches.
import { useState } from "preact/hooks";
import { canSteer, closeSheet, notify, store } from "../store.js";
import { html, Icon, Sheet } from "../ui.js";

const tagsOf = (session) => session.tags ?? [];
const vocabulary = () => [...new Set(store.state.sessions.flatMap(tagsOf))].sort();

/** Filters narrow the current search/view immediately; closing does not undo them. */
export function SessionTagFilter({ tags, onChange, scope: currentScope, scopeName }) {
    const [selected, setSelected] = useState(tags);
    const scope = currentScope();
    const matches = scope.filter((session) =>
        selected.every((tag) => tagsOf(session).includes(tag)),
    );
    const options = [...new Set([...vocabulary(), ...selected])].sort();

    const change = (next) => {
        setSelected(next);
        onChange(next);
    };

    return html`<${Sheet} title="Filter sessions" onClose=${closeSheet}>
        <p class="muted small">Match all selected tags. Changes apply immediately.</p>
        <p class="muted small">${scopeName}</p>
        <div class="sheet-list tag-options">
            ${options.map(
                (tag) => html`<label class="list-item check" key=${tag}>
                <span>${tag}</span>
                <input
                    type="checkbox"
                    checked=${selected.includes(tag)}
                    onChange=${(event) =>
                        change(
                            event.currentTarget.checked
                                ? [...selected, tag]
                                : selected.filter((each) => each !== tag),
                        )}
                />
            </label>`,
            )}
            ${options.length === 0 && html`<p class="muted small">No tags yet. Add tags from a session's actions.</p>`}
        </div>
        <p class="small" role="status" aria-live="polite">
            ${matches.length} matching ${matches.length === 1 ? "session" : "sessions"} in this view
        </p>
        <div class="sheet-actions">
            <button class="button" onClick=${() => change([])} disabled=${selected.length === 0}>
                Clear tags
            </button>
            <button class="button primary" onClick=${closeSheet}>Done</button>
        </div>
    <//>`;
}

/** IDs and original membership are captured once: list changes never widen an open edit. */
export function SessionTagsSheet({ ids, batch = false, submit }) {
    const [targets] = useState(() =>
        ids.map((id) => {
            const session = store.state.sessions.find((each) => each.id === id);

            return { id, title: session?.title ?? "New session", tags: [...(session?.tags ?? [])] };
        }),
    );
    const [draft, setDraft] = useState(() => (batch ? [] : [...targets[0].tags]));
    const [remove, setRemove] = useState([]);
    const [input, setInput] = useState("");
    const [error, setError] = useState("");
    const [saving, setSaving] = useState(false);
    const original = targets[0].tags;
    const union = [...new Set(targets.flatMap((session) => session.tags))].sort();
    const add = batch ? draft : draft.filter((tag) => !original.includes(tag));
    const removed = batch ? remove : original.filter((tag) => !draft.includes(tag));
    const project = (session, additions = add) => [
        ...new Set([...tagsOf(session).filter((tag) => !removed.includes(tag)), ...additions]),
    ];
    const current = targets.map((target) =>
        store.state.sessions.find((session) => session.id === target.id),
    );
    const available = current.every(Boolean);
    const changed = current.filter(
        (session) =>
            session &&
            (add.some((tag) => !tagsOf(session).includes(tag)) ||
                removed.some((tag) => tagsOf(session).includes(tag))),
    ).length;
    const tooMany = current.some((session) => session && project(session).length > 10);

    const queue = (value) => {
        const tag = value.trim().toLowerCase();

        setError("");

        if (!tag) {
            return;
        }

        if (tag.length > 32 || /[\p{Cc}\p{Bidi_Control}\u2028\u2029]/u.test(tag)) {
            setError("Use up to 32 characters, with no control characters.");

            return;
        }

        if (draft.includes(tag)) {
            setError("This tag is already added.");

            return;
        }

        if (remove.includes(tag)) {
            setError("Uncheck this tag in Remove before adding it.");

            return;
        }

        const additions = batch ? [...draft, tag] : [...add, tag];

        if (current.some((session) => session && project(session, additions).length > 10)) {
            setError("A session would exceed 10 tags. Remove a tag first.");

            return;
        }

        setDraft([...draft, tag]);
        setInput("");
    };

    const save = async () => {
        if (saving || !changed || !available || tooMany || !canSteer()) {
            return;
        }

        if (input.trim()) {
            setError("Use Add to include the tag you typed before saving.");

            return;
        }

        const sheet = store.state.sheet;

        setSaving(true);
        setError("");

        try {
            await submit({ ids: targets.map((target) => target.id), add, remove: removed });

            if (store.state.sheet === sheet) {
                closeSheet();
            }

            notify("info", "Tags saved.");
        } catch (cause) {
            setError(cause.message);
        } finally {
            setSaving(false);
        }
    };

    return html`<${Sheet}
        title=${batch ? `Edit tags · ${targets.length} ${targets.length === 1 ? "session" : "sessions"}` : "Edit tags"}
        onClose=${closeSheet}
        className="session-tags-sheet"
    >
        <p class="muted small">${
            batch
                ? "Only the selected sessions shown when you opened this editor are included. Other tags stay unchanged."
                : targets[0].title
        }</p>
        <p class="muted small">Shared with everyone who can see these sessions.</p>
        ${
            batch &&
            html`<details class="tag-targets">
            <summary>Review ${targets.length} selected ${targets.length === 1 ? "session" : "sessions"}</summary>
            <ul>${targets.map(
                (session) => html`<li key=${session.id}>
                <strong>${session.title}</strong>
                <span class="muted small">${session.tags.join(", ") || "No tags"}</span>
            </li>`,
            )}</ul>
        </details>`
        }
        <div class="field">
            <label class="label" for="session-tag-input">${batch ? "Add to selected sessions" : "Add a tag"}</label>
            <form class="tag-add" onSubmit=${(event) => {
                event.preventDefault();
                queue(input);
            }}>
                <input
                    id="session-tag-input"
                    value=${input}
                    autofocus
                    autocomplete="off"
                    placeholder="Tag name"
                    disabled=${saving}
                    onInput=${(event) => setInput(event.currentTarget.value)}
                />
                <button class="button" disabled=${saving || !input.trim()} type="submit">Add</button>
            </form>
        </div>
        <div class="tag-draft">
            ${draft.map(
                (tag) => html`<button
                class="chip"
                key=${tag}
                disabled=${saving}
                aria-label=${batch ? `Cancel adding ${tag}` : `Remove tag ${tag}`}
                onClick=${() => setDraft(draft.filter((each) => each !== tag))}
            >
                <span>${tag}</span><${Icon} name="close" size=${12} />
            </button>`,
            )}
            ${!batch && draft.length === 0 && html`<p class="muted small">No tags yet.</p>`}
        </div>
        <div class="tag-suggestions">
            ${vocabulary()
                .filter((tag) => !draft.includes(tag) && !remove.includes(tag))
                .map(
                    (tag) => html`<button
                class="chip"
                key=${tag}
                disabled=${saving}
                aria-label=${`Add ${tag}`}
                onClick=${() => queue(tag)}
            >+ ${tag}</button>`,
                )}
        </div>
        ${
            batch &&
            html`<div class="label">Remove from selected sessions</div>
            <div class="sheet-list tag-options">
                ${union.map(
                    (tag) => html`<label class="list-item check" key=${tag}>
                    <span class="tag-membership">
                        <span>${tag}</span>
                        <small class="muted">On ${targets.filter((session) => session.tags.includes(tag)).length} of ${targets.length} ${targets.length === 1 ? "session" : "sessions"}</small>
                    </span>
                    <input
                        type="checkbox"
                        disabled=${saving || draft.includes(tag)}
                        checked=${remove.includes(tag)}
                        onChange=${(event) =>
                            setRemove(
                                event.currentTarget.checked
                                    ? [...remove, tag]
                                    : remove.filter((each) => each !== tag),
                            )}
                    />
                </label>`,
                )}
                ${union.length === 0 && html`<p class="muted small">These sessions have no tags to remove.</p>`}
            </div>`
        }
        <p class="tag-error small" role="alert">${
            error ||
            (!available
                ? "A selected session is no longer available. Close this editor and select again."
                : tooMany
                  ? "A session would exceed 10 tags. Adjust the changes before saving."
                  : "")
        }</p>
        <div class="tag-save">
            <p class="muted small" role="status" aria-live="polite">${
                changed
                    ? `${changed} ${changed === 1 ? "session" : "sessions"} will change. Other tags stay.`
                    : "No changes to save."
            }</p>
            <div class="sheet-actions">
                <button class="button" onClick=${closeSheet}>Cancel</button>
                <button
                    class="button primary"
                    disabled=${saving || !changed || !available || tooMany || !canSteer()}
                    onClick=${save}
                >${saving ? "Saving…" : "Save tags"}</button>
            </div>
        </div>
    <//>`;
}
