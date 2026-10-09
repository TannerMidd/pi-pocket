// Find in session: messages, commands, and files, through the whole history.
import { useEffect, useRef, useState } from "preact/hooks";
import { jumpToEntry } from "../chat.js";
import { actions, closeSheet, isRow, store } from "../store.js";
import { html, Marked, plainText, Sheet, Spinner, writtenText } from "../ui.js";

/** How many entries a page of earlier history has (`app.history` on the server), and how many pages find reads. */
const HISTORY_PAGE = 400;

const FIND_PAGES = 25;

/** What an entry says, to find text in: messages, Pi's calls' paths and commands, commands people ran, notes. */
function searchText(entry) {
    switch (entry.kind) {
        case "user":
            return writtenText(entry);
        case "assistant":
            return entry.blocks
                .map((block) =>
                    block.type === "text"
                        ? plainText(block.text)
                        : block.type === "toolCall"
                          ? [block.args?.path, block.args?.command, block.args?.url]
                                .filter(Boolean)
                                .join(" ")
                          : "",
                )
                .filter(Boolean)
                .join("\n");
        case "shell":
        case "command":
            return `${entry.command}\n${entry.output}`;
        case "note":
            return `${entry.name} ${entry.text}`;
        case "compaction":
            return entry.summary;
        case "reset":
            return entry.text ?? "";
        default:
            return "";
    }
}

/** Who an entry is from, for a find result. */
function speaker(entry) {
    const { view, users, me } = store.state;

    if (entry.kind === "assistant") {
        return "Pi";
    }

    if (entry.kind === "shell" || entry.kind === "command" || entry.kind === "note") {
        return entry.name;
    }

    if (entry.kind !== "user") {
        return "Context";
    }

    const userId = view.authors?.[entry.id];

    if (userId === me?.id) {
        return "You";
    }

    return users.find((user) => user.id === userId)?.name ?? entry.from ?? "You";
}

/**
 * Find in this session: every message it has, earlier history included, newest first. The browser's own find misses
 * the messages the transcript has not drawn. Picking one scrolls the transcript to it.
 */
export function FindSheet({ initial }) {
    const { view } = store.state;
    const [query, setQuery] = useState(initial);
    const [pick, setPick] = useState(0);
    // History before a compaction or a new context, page by page, oldest first; `done` once all of it (or as much as
    // is searched) is here.
    const [earlier, setEarlier] = useState({ entries: [], done: false, all: true });
    const box = useRef(null);
    const first = view.order.length > 0 ? view.entries.get(view.order[0]) : undefined;

    useEffect(() => box.current?.focus(), []);
    useEffect(() => {
        if (!first || (first.kind !== "compaction" && first.kind !== "reset")) {
            return setEarlier({ entries: [], done: true, all: true });
        }

        let live = true;

        (async () => {
            let entries = [];
            let before = first.id;

            for (let page = 0; page < FIND_PAGES; page++) {
                const batch = await actions.history(before);

                if (!live) {
                    return;
                }

                entries = [...batch, ...entries];
                const last = batch.length < HISTORY_PAGE;

                setEarlier({ entries, done: last, all: last });

                if (last) {
                    return;
                }

                before = batch[0].id;
            }

            setEarlier({ entries, done: true, all: false });
        })().catch(() => live && setEarlier((current) => ({ ...current, done: true, all: false })));

        return () => {
            live = false;
        };
    }, []);

    /**
     * Jump to a result. One in earlier history first shows that history from a little before it, and the transcript
     * from its first row on: earlier history shows above the rows of now only when they all show.
     */
    const jump = (entry) => {
        const at = earlier.entries.findIndex((each) => each.id === entry.id);

        if (at !== -1 && !document.getElementById(`entry-${entry.id}`)) {
            const firstRow = view.order
                .map((id) => view.entries.get(id))
                .find((each) => each && isRow(each));

            store.set({
                history: earlier.entries.slice(Math.max(0, at - 10)),
                ...(firstRow ? { transcriptFrom: firstRow.id } : {}),
            });
        }

        requestAnimationFrame(() => jumpToEntry(entry.id));
    };

    const needle = query.trim().toLowerCase();
    const results = [];

    if (needle !== "") {
        const entries = [
            ...earlier.entries,
            ...view.order.map((id) => view.entries.get(id)),
        ].filter((entry) => entry && isRow(entry));

        for (let index = entries.length - 1; index >= 0 && results.length < 100; index--) {
            const text = searchText(entries[index]).replace(/\s+/g, " ");
            const at = text.toLowerCase().indexOf(needle);

            if (at === -1) {
                continue;
            }

            const start = Math.max(0, at - 50);
            const snippet = `${start > 0 ? "…" : ""}${text.slice(start, at + needle.length + 90)}`;
            const from = at - start + (start > 0 ? 1 : 0);

            results.push({
                entry: entries[index],
                snippet,
                hits: Array.from({ length: needle.length }, (_, offset) => from + offset),
            });
        }
    }

    const chosen = results[Math.min(pick, results.length - 1)];

    const onKey = (event) => {
        const move = { ArrowDown: 1, ArrowUp: -1 }[event.key];

        if (move !== undefined && results.length > 0) {
            event.preventDefault();
            setPick((Math.min(pick, results.length - 1) + move + results.length) % results.length);
        } else if (event.key === "Enter" && chosen) {
            event.preventDefault();
            jump(chosen.entry);
        }
    };

    return html`<${Sheet} title="Find in session" onClose=${closeSheet}>
        <input
            class="find-input"
            ref=${box}
            type="search"
            placeholder="Words in a message, a command, a file…"
            value=${query}
            onInput=${(event) => {
                setQuery(event.currentTarget.value);
                setPick(0);
            }}
            onKeyDown=${onKey}
        />
        ${
            needle !== "" &&
            results.length === 0 &&
            earlier.done &&
            html`<p class="muted">Nothing here says “${query.trim()}”.</p>`
        }
        ${
            !earlier.done &&
            html`<p class="muted small"><${Spinner} /> Searching earlier history too…</p>`
        }
        ${
            earlier.done &&
            !earlier.all &&
            html`<p class="muted small">
                The oldest history was not searched: only the newest ${earlier.entries.length} earlier entries.
            </p>`
        }
        ${results.length === 100 && html`<p class="muted small">The newest 100 are listed.</p>`}
        <div class="find-results">
            ${results.map(
                (result) => html`<button
                    key=${result.entry.id}
                    class=${`find-result ${result === chosen ? "on" : ""}`}
                    onClick=${() => jump(result.entry)}
                >
                    <span class="find-who">${speaker(result.entry)}</span>
                    <span class="find-snippet">
                        <${Marked} text=${result.snippet} hits=${result.hits} />
                    </span>
                </button>`,
            )}
        </div>
    <//>`;
}
