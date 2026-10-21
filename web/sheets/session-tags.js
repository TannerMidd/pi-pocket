// Shared session tags: personal list filters and explicit, cancelable tag patches.
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { canSteer, closeSheet, notify, store } from "../store.js";
import { html, Icon, Sheet } from "../ui.js";

const tagsOf = (session) => session.tags ?? [];
const vocabulary = () => [...new Set(store.state.sessions.flatMap(tagsOf))].sort();

/** Filters narrow the current search/view immediately; closing does not undo them. */
export function SessionTagFilter({ tags, onChange, scope: currentScope, scopeName }) {
    const [selected, setSelected] = useState(tags);
    const [query, setQuery] = useState("");
    const searchRef = useRef(null);
    const selectedRef = useRef(null);

    useChipTrayFocus(selectedRef, selected.length > 0);

    const scope = currentScope();
    const matches = scope.filter((session) =>
        selected.every((tag) => tagsOf(session).includes(tag)),
    );
    const allOptions = [...new Set([...vocabulary(), ...selected])].sort();
    const options = allOptions.filter((tag) => tag.includes(query.trim().toLowerCase()));

    const change = (next) => {
        setSelected(next);
        onChange(next);
    };

    const removeSelected = (event, tag) => {
        const button = event.currentTarget;
        const siblings = [...button.parentElement.querySelectorAll("button")];
        const index = siblings.indexOf(button);
        const host = button.closest(".sheet-host");
        const sheet = store.state.sheet;
        const keyboard = event.detail === 0 && document.activeElement === button;

        change(selected.filter((each) => each !== tag));

        if (keyboard) {
            requestAnimationFrame(() => {
                if (
                    store.state.sheet !== sheet ||
                    !host?.isConnected ||
                    host.classList.contains("leaving") ||
                    (document.activeElement !== document.body && document.activeElement !== button)
                ) {
                    return;
                }

                const next = [siblings[index + 1], siblings[index - 1], searchRef.current].find(
                    (control) => control?.isConnected && control.closest(".sheet-host") === host,
                );

                next?.focus();
            });
        }
    };

    return html`<${Sheet} title="Filter sessions" onClose=${closeSheet} className="session-tag-filter-sheet">
        <div class="tag-filter-content">
            <p class="muted small">${scopeName} · Match all selected tags. Changes apply immediately.</p>
            <input
                type="search"
                ref=${searchRef}
                aria-label="Search tags"
                placeholder="Search tags"
                autocomplete="off"
                value=${query}
                onInput=${(event) => setQuery(event.currentTarget.value)}
            />
            ${
                selected.length > 0 &&
                html`<div class="tag-filter-pending">
                <p class="small">Selected · ${selected.length}</p>
                <div class="tag-filter-selected" ref=${selectedRef}>
                    ${selected.map(
                        (tag) => html`<button
                        class="chip"
                        key=${tag}
                        aria-label=${`Remove ${tag} filter`}
                        onClick=${(event) => removeSelected(event, tag)}
                    ><span dir="auto">${tag}</span><${Icon} name="close" size=${12} /></button>`,
                    )}
                </div>
            </div>`
            }
            <div class="sheet-list tag-options tag-filter-results">
                ${options.map(
                    (
                        tag,
                    ) => html`<label class=${`list-item check${selected.includes(tag) ? " marked" : ""}`} key=${tag}>
                    <span dir="auto">${tag}</span>
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
                ${options.length === 0 && html`<p class="muted small tag-empty">${allOptions.length === 0 ? "No tags yet. Add tags from a session's actions." : "No matching tags."}</p>`}
            </div>
        </div>
        <div class="tag-filter-footer">
            <p class="small" role="status" aria-live="polite">
                ${matches.length} matching ${matches.length === 1 ? "session" : "sessions"} in this view
            </p>
            <div class="sheet-actions">
                <button class="button" onClick=${() => change([])} disabled=${selected.length === 0}>
                    Clear tags
                </button>
                <button class="button primary" onClick=${closeSheet}>Done</button>
            </div>
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
    const [removalQuery, setRemovalQuery] = useState("");
    const inputRef = useRef(null);
    const removalSearchRef = useRef(null);
    const removalListRef = useRef(null);
    const removalDraftRef = useRef(null);

    useChipTrayFocus(removalDraftRef, remove.length > 0);

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
    const suggestions = vocabulary().filter(
        (tag) =>
            !draft.includes(tag) &&
            !remove.includes(tag) &&
            (!batch || !targets.every((session) => session.tags.includes(tag))) &&
            tag.includes(input.trim().toLowerCase()),
    );
    const removalOptions = union.filter((tag) => tag.includes(removalQuery.trim().toLowerCase()));

    // Removing a focused chip must not strand keyboard focus on the document body.
    const cancelQueued = (event, tag, removal = false) => {
        const button = event.currentTarget;
        const siblings = [...button.parentElement.querySelectorAll("button")];
        const index = siblings.indexOf(button);
        const host = button.closest(".sheet-host");
        const sheet = store.state.sheet;
        const restore = event.detail === 0 && document.activeElement === button;

        if (removal) {
            setRemove(remove.filter((each) => each !== tag));
        } else {
            setDraft(draft.filter((each) => each !== tag));
        }

        if (restore) {
            requestAnimationFrame(() => {
                if (
                    store.state.sheet !== sheet ||
                    !host?.isConnected ||
                    host.classList.contains("leaving") ||
                    (document.activeElement !== document.body && document.activeElement !== button)
                ) {
                    return;
                }

                const fallback = removal
                    ? (removalSearchRef.current ??
                      removalListRef.current?.querySelector("input:not(:disabled)"))
                    : inputRef.current;
                const next = [siblings[index + 1], siblings[index - 1], fallback].find(
                    (control) =>
                        control?.isConnected &&
                        !control.disabled &&
                        control.closest(".sheet-host") === host,
                );

                next?.focus();
            });
        }
    };

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
        <div class="tag-editor-content">
            ${!batch && html`<p class="muted small">${targets[0].title}</p>`}
            <p class="muted small">Shared with everyone who can see these sessions.</p>
            <div class="field">
                <label class="label" for="session-tag-input">${batch ? "Add to selected sessions" : "Add a tag"}</label>
                <form class="tag-add" onSubmit=${(event) => {
                    event.preventDefault();
                    queue(input);
                }}>
                    <input
                        id="session-tag-input"
                        ref=${inputRef}
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
                    onClick=${(event) => cancelQueued(event, tag)}
                >
                    <span>${tag}</span><${Icon} name="close" size=${12} />
                </button>`,
                )}
                ${!batch && draft.length === 0 && html`<p class="muted small">No tags yet.</p>`}
            </div>
            <div class="tag-suggestions">
                ${suggestions.slice(0, 6).map(
                    (tag) => html`<button
                    class="chip"
                    key=${tag}
                    disabled=${saving}
                    aria-label=${`Add ${tag}`}
                    onClick=${() => queue(tag)}
                >+ ${tag}</button>`,
                )}
            </div>
            ${suggestions.length > 6 && html`<p class="muted small tag-suggestion-hint">Type to find more tags.</p>`}
            ${
                batch &&
                html`<section class="field tag-remove" aria-labelledby="tag-remove-heading">
                    <h3 class="label" id="tag-remove-heading">Remove from selected sessions</h3>
                    ${
                        union.length > 8 &&
                        html`<input
                        id="session-tag-remove-search"
                        ref=${removalSearchRef}
                        type="search"
                        aria-label="Find tags to remove"
                        placeholder="Find a tag"
                        autocomplete="off"
                        value=${removalQuery}
                        disabled=${saving}
                        onInput=${(event) => setRemovalQuery(event.currentTarget.value)}
                    />`
                    }
                    ${
                        remove.length > 0 &&
                        html`<div class="tag-remove-pending">
                        <p class="small tag-remove-count">Will remove · ${remove.length}</p>
                        <div class="tag-remove-draft" ref=${removalDraftRef}>
                            ${remove.map(
                                (tag) => html`<button
                                class="chip"
                                key=${tag}
                                aria-label=${`Cancel removing ${tag}`}
                                disabled=${saving}
                                onClick=${(event) => cancelQueued(event, tag, true)}
                            ><span dir="auto">${tag}</span><${Icon} name="close" size=${12} /></button>`,
                            )}
                        </div>
                    </div>`
                    }
                    <div class="sheet-list tag-options tag-remove-options" ref=${removalListRef}>
                        ${removalOptions.map(
                            (
                                tag,
                            ) => html`<label class=${`list-item check${remove.includes(tag) ? " marked" : ""}`} key=${tag}>
                            <span class="tag-membership">
                                <span dir="auto">${tag}</span>
                                <small class="muted">${targets.filter((session) => session.tags.includes(tag)).length} of ${targets.length}</small>
                                ${remove.includes(tag) && html`<small class="tag-remove-intent">Will remove</small>`}
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
                        ${removalOptions.length === 0 && html`<p class="muted small tag-empty">${union.length === 0 ? "No tags to remove." : "No matching tags."}</p>`}
                    </div>
                </section>`
            }
            <p class="tag-error small" role="alert">${
                error ||
                (!available
                    ? "A selected session is no longer available. Close this editor and select again."
                    : tooMany
                      ? "A session would exceed 10 tags. Adjust the changes before saving."
                      : "")
            }</p>
        </div>
        <div class="tag-save">
            <p class="muted small" role="status" aria-live="polite">${
                changed
                    ? `${changed} ${changed === 1 ? "session" : "sessions"} will change.`
                    : "No changes to save."
            }${batch && (add.length > 0 || removed.length > 0) && html`<span> · ${add.length} to add · ${removed.length} to remove</span>`}</p>
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

/** Keep a focused chip visible when its bounded tray reflows, without moving focus. */
function useChipTrayFocus(ref, hasChips) {
    useLayoutEffect(() => {
        const tray = ref.current;
        const sheet = store.state.sheet;

        if (!tray) {
            return;
        }

        const observer = new ResizeObserver(() => {
            const focused = document.activeElement;

            if (
                store.state.sheet === sheet &&
                tray.isConnected &&
                tray.closest(".sheet-host:not(.leaving)") &&
                tray.contains(focused)
            ) {
                focused.scrollIntoView({ block: "nearest", inline: "nearest" });
            }
        });

        observer.observe(tray);

        return () => observer.disconnect();
    }, [hasChips]);
}
