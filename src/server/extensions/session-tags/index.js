// Session tags' browser module: each session's tags as chips on its row, as words for the session search and the
// launcher, a filter beside the search, and sheets to edit tags (Edit tags on a held row, or for selected sessions).
// It uses only `pocket`. Tags are shared; the filter is this tab's own.
export const pocketApi = 2;

/** Lucide's tag and list-filter icons. */
const TAG_PATH =
    "M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z M7.5 7.5h.01";
const FILTER_PATH = "M3 6h18 M7 12h10 M10 18h4";
const MAX_TAGS = 10;
const MAX_LENGTH = 32;
const SUGGESTIONS = 6;
/** Past this many tags, the filter sheet has a search field. */
const SEARCH_FROM = 8;
/** The tab keeps its filter here, across reloads, as long as the tab stays open. */
const KEPT = "pocket.session-tags.filter";

/** A tag as the server stores it, or "" when it is not one. */
function tagName(text) {
    const name = text.trim().toLowerCase();

    return name !== "" &&
        [...name].length <= MAX_LENGTH &&
        !/[\p{Cc}\p{Bidi_Control}\u2028\u2029]/u.test(name)
        ? name
        : "";
}

function readKept() {
    try {
        const kept = JSON.parse(sessionStorage.getItem(KEPT) ?? "[]");

        return Array.isArray(kept) ? kept.filter((name) => typeof name === "string") : [];
    } catch {
        return [];
    }
}

export default function setup(pocket) {
    const { html, useEffect, useMemo, useRef, useState } = pocket;

    // An app older than 0.20.0 has no place for tags in its session list.
    if (typeof pocket.sessionChips !== "function") {
        return;
    }

    /** Each session's tags, by id, for the sessions this person can see; and whether they came yet. */
    let tags = new Map();
    let loaded = false;
    /** The filter: a session shows when it has every one of these. */
    let chosen = new Set(readKept());
    /** The sheets that show tags, drawn again when they change. */
    const listeners = new Set();

    /** Every tag in use, with how many sessions have it, by name. */
    const vocabulary = () => {
        const counts = new Map();

        for (const names of tags.values()) {
            for (const name of names) {
                counts.set(name, (counts.get(name) ?? 0) + 1);
            }
        }

        return [...counts].sort(([a], [b]) => a.localeCompare(b));
    };

    const choose = (name, on = true) => {
        const next = new Set(chosen);

        if (on) {
            next.add(name);
        } else {
            next.delete(name);
        }

        setChosen(next);
    };

    const setChosen = (next) => {
        chosen = next;

        try {
            sessionStorage.setItem(KEPT, JSON.stringify([...chosen]));
        } catch {
            // A browser that keeps nothing: the filter lasts until the page loads again.
        }

        changed();
    };

    // New functions each time, so the session list draws again.
    const chipsOf = () => (session) =>
        (tags.get(session.id) ?? []).map((name) => ({
            label: name,
            title: chosen.has(name)
                ? `Tag: ${name}`
                : `Tag: ${name}. Tap to show only sessions with it`,
            run: () => choose(name),
        }));
    const wordsOf = () => (session) => tags.get(session.id) ?? [];

    // Off until the tags come: a filter kept from before would hide every session meanwhile, or for good if they fail.
    const matchOf = () =>
        chosen.size === 0 || !loaded
            ? null
            : (session) => {
                  const own = tags.get(session.id) ?? [];

                  return [...chosen].every((name) => own.includes(name));
              };

    const chips = pocket.sessionChips({ id: "tags", chips: chipsOf() });
    const words = pocket.sessionSearch({ id: "tags", words: wordsOf() });
    const filter = pocket.sessionFilter({
        id: "filter",
        title: "Filter by tag",
        iconPath: FILTER_PATH,
        sheet: "filter",
        badge: chosen.size,
        match: matchOf(),
        // New in the filtered list: the session gets the chosen tags, so it stays in the list.
        started: async (id) => {
            if (chosen.size > 0) {
                saved(await pocket.api("tags", { ids: [id], add: [...chosen] }));
            }
        },
    });

    function changed() {
        chips.update({ chips: chipsOf() });
        words.update({ words: wordsOf() });
        filter.update({ match: matchOf(), badge: chosen.size });

        for (const listener of [...listeners]) {
            listener();
        }
    }

    /**
     * What a save answered: those sessions' tags now. Shown at once, not only when the event comes, which a tab that
     * reconnects (a new session opening) can miss.
     */
    function saved(answer) {
        for (const [id, names] of Object.entries(answer?.tags ?? {})) {
            if (names.length === 0) {
                tags.delete(Number(id));
            } else {
                tags.set(Number(id), names);
            }
        }

        changed();
    }

    let told = false;
    // Only the newest load counts: an older answer that comes last would bring back tags from before.
    let loads = 0;

    async function load() {
        const mine = ++loads;

        try {
            const answer = await pocket.api("tags");

            if (mine !== loads) {
                return;
            }

            tags = new Map(
                Object.entries(answer.tags ?? {}).map(([id, names]) => [Number(id), names]),
            );
            loaded = true;

            // A tag kept from before that no session has now would hide every session, unseen.
            const known = new Set(vocabulary().map(([name]) => name));

            if ([...chosen].some((name) => !known.has(name))) {
                setChosen(new Set([...chosen].filter((name) => known.has(name))));
            } else {
                changed();
            }
        } catch (error) {
            if (mine !== loads) {
                return;
            }

            loaded = false;
            changed();

            if (!told) {
                told = true;
                pocket.notify("warning", `Session tags: ${error.message}`);
            }
        }
    }

    void load();
    pocket.onDispose(pocket.on("changed", () => void load()));

    // An event sent while the tab was away (asleep, or reconnecting) is lost: look again when it comes back.
    const back = () => document.visibilityState === "visible" && void load();

    document.addEventListener("visibilitychange", back);
    pocket.onDispose(() => document.removeEventListener("visibilitychange", back));

    /** Draw again when the tags or the filter change. */
    function useTags() {
        const [, bump] = useState(0);

        useEffect(() => {
            const listener = () => bump((n) => n + 1);

            listeners.add(listener);

            return () => listeners.delete(listener);
        }, []);
    }

    // ─── The filter ──────────────────────────────────────────────────────────

    function FilterSheet({ close }) {
        useTags();

        const [query, setQuery] = useState("");
        const all = vocabulary();
        const needle = query.trim().toLowerCase();
        const shown = all.filter(([name]) => needle === "" || name.includes(needle));

        return html`<div class="tags-sheet">
            ${
                all.length > SEARCH_FROM &&
                html`<input
                    class="tags-input"
                    type="search"
                    placeholder="Search tags"
                    aria-label="Search tags"
                    value=${query}
                    onInput=${(event) => setQuery(event.currentTarget.value)}
                />`
            }
            ${
                loaded && all.length === 0
                    ? html`<p class="muted">
                          No tags yet. Hold a session's row, or select sessions, and choose Edit
                          tags.
                      </p>`
                    : html`<div class="tags-choices" role="group" aria-label="Tags">
                          ${shown.map(
                              ([name, count]) =>
                                  html`<label key=${name} class="tags-choice">
                                      <input
                                          type="checkbox"
                                          checked=${chosen.has(name)}
                                          onChange=${(event) => choose(name, event.currentTarget.checked)}
                                      />
                                      <span class="tags-name">${name}</span>
                                      <span class="muted small">${count}</span>
                                  </label>`,
                          )}
                          ${
                              shown.length === 0 &&
                              all.length > 0 &&
                              html`<p class="muted small">No tags match.</p>`
                          }
                      </div>`
            }
            <p class="muted small">
                ${
                    chosen.size === 0
                        ? "Choose tags to show only the sessions that have all of them."
                        : `Showing sessions tagged ${[...chosen].join(" and ")}.`
                }
            </p>
            <div class="tags-buttons">
                ${
                    chosen.size > 0 &&
                    html`<button class="button" onClick=${() => setChosen(new Set())}>
                        Clear
                    </button>`
                }
                <button class="button primary" onClick=${close}>Done</button>
            </div>
        </div>`;
    }

    // ─── Editing ─────────────────────────────────────────────────────────────

    /** Tags as chips: each with a button that takes it out (or puts it back). */
    function Chip({ name, struck = false, label, onToggle }) {
        return html`<span class=${`tags-chip ${struck ? "struck" : ""}`}>
            <span>${name}</span>
            <button class="tags-chip-x" aria-label=${label} title=${label} onClick=${onToggle}>
                <${pocket.Icon} name=${struck ? "undo" : "close"} size=${12} />
            </button>
        </span>`;
    }

    function EditSheet({ close, sessions }) {
        useTags();

        const ids = useMemo(() => (Array.isArray(sessions) ? sessions : []), [sessions]);
        const [adding, setAdding] = useState([]);
        const [removing, setRemoving] = useState(() => new Set());
        const [text, setText] = useState("");
        const [error, setError] = useState(null);
        const [saving, setSaving] = useState(false);
        const input = useRef(null);

        // Ready to type with a keyboard; a phone's keyboard waits for a tap, so it does not cover the sheet.
        useEffect(() => {
            if (!matchMedia("(pointer: coarse)").matches) {
                input.current?.focus();
            }
        }, []);

        // The tags on any of these sessions, and on how many of them.
        const present = new Map();

        for (const id of ids) {
            for (const name of tags.get(id) ?? []) {
                present.set(name, (present.get(name) ?? 0) + 1);
            }
        }

        const name = tagName(text);
        const suggestions =
            text.trim() === ""
                ? []
                : vocabulary()
                      .map(([each]) => each)
                      .filter(
                          (each) =>
                              each.includes(text.trim().toLowerCase()) &&
                              !adding.includes(each) &&
                              (present.get(each) ?? 0) < ids.length,
                      )
                      .slice(0, SUGGESTIONS);

        const add = (value) => {
            const next = tagName(value);

            setError(null);

            if (next === "") {
                setError(`A tag is 1 to ${MAX_LENGTH} characters.`);

                return;
            }

            if (removing.has(next)) {
                const kept = new Set(removing);

                kept.delete(next);
                setRemoving(kept);
            } else if (!adding.includes(next) && (present.get(next) ?? 0) < ids.length) {
                setAdding([...adding, next]);
            }

            setText("");
            input.current?.focus();
        };

        const toggleRemove = (each) => {
            const next = new Set(removing);

            if (next.has(each)) {
                next.delete(each);
            } else {
                next.add(each);
            }

            setRemoving(next);
        };

        const save = async () => {
            setSaving(true);
            setError(null);

            try {
                saved(await pocket.api("tags", { ids, add: adding, remove: [...removing] }));
                close();
            } catch (failure) {
                setError(failure.message);
                setSaving(false);
            }
        };

        const unchanged = adding.length === 0 && removing.size === 0;
        // One session can say how many tags it will have; for more, the server checks each.
        const after = ids.length === 1 ? present.size - removing.size + adding.length : 0;

        return html`<div class="tags-sheet">
            ${
                ids.length > 1 &&
                html`<p class="muted small">
                    ${ids.length} sessions. Tags you add go on all of them; tags you take off come
                    off all of them.
                </p>`
            }
            <div class="tags-chips" aria-label="Tags">
                ${[...present].map(
                    ([each, count]) =>
                        html`<${Chip}
                            key=${each}
                            name=${ids.length > 1 && count < ids.length ? `${each} (${count} of ${ids.length})` : each}
                            struck=${removing.has(each)}
                            label=${removing.has(each) ? `Keep ${each}` : `Take off ${each}`}
                            onToggle=${() => toggleRemove(each)}
                        />`,
                )}
                ${adding.map(
                    (each) =>
                        html`<${Chip}
                            key=${`+${each}`}
                            name=${`+ ${each}`}
                            label=${`Do not add ${each}`}
                            onToggle=${() => setAdding(adding.filter((other) => other !== each))}
                        />`,
                )}
                ${
                    present.size === 0 &&
                    adding.length === 0 &&
                    html`<span class="muted small">No tags yet.</span>`
                }
            </div>
            <form
                class="tags-add"
                onSubmit=${(event) => {
                    event.preventDefault();
                    add(text);
                }}
            >
                <input
                    ref=${input}
                    class="tags-input"
                    placeholder="Add a tag"
                    aria-label="Add a tag"
                    maxlength=${MAX_LENGTH * 2}
                    value=${text}
                    onInput=${(event) => setText(event.currentTarget.value)}
                />
                <button class="button" type="submit" disabled=${name === ""}>Add</button>
            </form>
            ${
                suggestions.length > 0 &&
                html`<div class="tags-suggestions" aria-label="Tags in use">
                    ${suggestions.map(
                        (each) =>
                            html`<button
                                key=${each}
                                class="tags-suggestion"
                                onClick=${() => add(each)}
                            >
                                ${each}
                            </button>`,
                    )}
                </div>`
            }
            ${
                after > MAX_TAGS &&
                html`<p class="muted small">A session can have ${MAX_TAGS} tags at most.</p>`
            }
            ${error && html`<div class="error-box">${error}</div>`}
            <div class="tags-buttons">
                <button class="button" onClick=${close}>Cancel</button>
                <button
                    class="button primary"
                    disabled=${unchanged || saving || after > MAX_TAGS}
                    onClick=${save}
                >
                    ${saving ? "Saving…" : "Save"}
                </button>
            </div>
        </div>`;
    }

    pocket.style("style.css");
    pocket.sheet({ id: "filter", title: "Filter by tag", component: FilterSheet });
    pocket.launcher({
        id: "filter",
        label: "Filter sessions by tag",
        iconPath: FILTER_PATH,
        keywords: ["tags", "labels"],
        sheet: "filter",
    });

    // Viewers see tags, and filter by them; people who steer edit them (the app shows the action to them alone).
    pocket.sheet({ id: "edit", title: "Edit tags", component: EditSheet });
    pocket.sessionAction({ id: "edit", label: "Edit tags", iconPath: TAG_PATH, sheet: "edit" });

    if (pocket.me()?.role !== "viewer") {
        pocket.launcher({
            id: "edit",
            label: "Edit this session's tags",
            iconPath: TAG_PATH,
            keywords: ["tags", "labels"],
            run: () => {
                const id = pocket.conversationId();

                if (id === null) {
                    pocket.notify("info", "Open a session first, or select sessions in the list.");

                    return;
                }

                pocket.openSheet("edit", { sessions: [id] });
            },
        });
    }
}
