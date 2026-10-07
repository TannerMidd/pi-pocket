// The launcher, after Omarchy's Walker: one box for sessions, actions, and themes. Mod+K opens it anywhere. Arrowing
// onto a theme shows it at once; Enter keeps it, Escape goes back. Start with > for actions only, @ for sessions, # for
// themes.
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { browserAvailable, toggleBrowser } from "./browser.js";
import { planAvailable, schedulesAvailable } from "./commands.js";
import { filesAvailable, toggleFiles } from "./files-panel.js";
import { togglePeeks } from "./peeks.js";
import { setArchived, workspaceOrder } from "./sessions.js";
import { branchAvailable, headLabel } from "./sheets/branch.js";
import {
    actions,
    attempt,
    canSteer,
    collab,
    navigate,
    notify,
    openSheet,
    scoped,
    store,
} from "./store.js";
import {
    paletteOf,
    prefs,
    preview,
    setPrefs,
    THEMES,
    themeIds,
    themeVars,
    varsStyle,
} from "./theme.js";
import { copyText, html, Icon, Keys, Marked, shortPath, Slide, timeAgo, useSlide } from "./ui.js";

/**
 * How well `query` matches `text` as a subsequence: null for no match, else a score (higher is better) and the matched
 * places. Runs of letters, letters at word starts, and an early first letter count for more.
 */
function fuzzy(text, query) {
    if (query === "") {
        return { score: 0, hits: [] };
    }

    const hay = text.toLowerCase();
    const plain = hay.indexOf(query);

    if (plain !== -1) {
        const start = plain === 0 || /[\s/._-]/.test(hay[plain - 1]);

        return {
            score: 100 + query.length * 4 - plain + (start ? 30 : 0),
            hits: Array.from({ length: query.length }, (_, index) => plain + index),
        };
    }

    const hits = [];
    let score = 0;
    let from = 0;

    for (const char of query) {
        if (char === " ") {
            continue;
        }

        const at = hay.indexOf(char, from);

        if (at === -1) {
            return null;
        }

        const run = hits.length > 0 && hits[hits.length - 1] === at - 1;
        const start = at === 0 || /[\s/._-]/.test(hay[at - 1]);

        score += 1 + (run ? 5 : 0) + (start ? 8 : 0) - Math.min(at - from, 10) * 0.3;
        hits.push(at);
        from = at + 1;
    }

    return { score, hits };
}

/** The actions that make sense here, as launcher items. */
function actionItems() {
    const { view, conversationId, me } = store.state;
    const conversation = conversationId !== null ? view.conversation : null;
    const session = conversation?.kind === "session";
    const steer = canSteer();
    const canStart = steer && !scoped();
    const wide = matchMedia("(min-width: 960px)").matches;
    const list = [
        canStart && {
            label: "New session",
            icon: "plus",
            keys: "Alt N",
            run: () => openSheet({ type: "cwd", mode: "new" }),
        },
        conversationId !== null && {
            label: "All sessions",
            detail: "home",
            icon: "home",
            run: () => navigate(null),
        },
        wide && {
            label: prefs().sidebar === "rail" ? "Unfold the sidebar" : "Fold the sidebar",
            icon: "sidebar",
            keys: "Mod B",
            run: () => setPrefs({ sidebar: prefs().sidebar === "rail" ? "open" : "rail" }),
        },
        {
            label: "Appearance",
            detail: "theme, tiling, motion, text size",
            icon: "palette",
            run: () => openSheet({ type: "appearance" }),
        },
        wide && {
            label: prefs().tiling ? "Turn tiling off" : "Turn tiling on",
            detail: "gaps and window borders",
            icon: "swatch",
            run: () => setPrefs({ tiling: !prefs().tiling }),
        },
        {
            label: prefs().peeks ? "Hide peek tiles" : "Show peek tiles",
            detail: "other sessions' live work beside this one",
            icon: "tiles",
            keys: "Alt P",
            run: togglePeeks,
        },
        conversation &&
            steer && {
                label: "Switch model",
                icon: "sparkle",
                run: () => openSheet({ type: "model" }),
            },
        conversation &&
            browserAvailable() && {
                label: store.state.browserOpen ? "Close the browser" : "Open the browser",
                detail: "see and test pages with Pi",
                icon: "globe",
                keys: "Alt B",
                run: toggleBrowser,
            },
        conversation && {
            label: "Artifacts",
            icon: "artifact",
            run: () => openSheet({ type: "artifacts" }),
        },
        conversation &&
            filesAvailable() && {
                label:
                    store.state.filesOpen && store.state.filesTab === "files"
                        ? "Close the files"
                        : "Files",
                detail: "browse the folder, read files",
                icon: "folder",
                keys: "Alt E",
                run: () => toggleFiles("files"),
            },
        conversation &&
            filesAvailable() && {
                label: "Changes",
                detail: "review what changed, file by file",
                icon: "fork",
                run: () => toggleFiles("changes"),
            },
        conversation &&
            branchAvailable() && {
                label: "Switch branch",
                detail: `on ${headLabel(view.branch)}`,
                icon: "fork",
                run: () => openSheet({ type: "branch" }),
            },
        conversation &&
            collab() && {
                label: "Chat with people here",
                icon: "chat",
                run: () => openSheet({ type: "chat" }),
            },
        session &&
            steer && {
                label: "Rename session",
                icon: "sparkle",
                run: () => openSheet({ type: "rename" }),
            },
        session &&
            steer &&
            planAvailable() && {
                label: view.plan?.on ? "Turn plan mode off" : "Turn plan mode on",
                detail: "Pi proposes, changes nothing",
                icon: "shield",
                run: () => attempt(() => actions.setPlan(!view.plan?.on)),
            },
        schedulesAvailable() && {
            label: "Scheduled messages",
            icon: "pulse",
            run: () => openSheet({ type: "schedules" }),
        },
        conversation && {
            label: "Copy link to this session",
            icon: "external",
            run: () => copyText(location.href).then(() => notify("info", "Link copied.")),
        },
        conversation && {
            label: "Session menu",
            icon: "more",
            run: () => openSheet({ type: "menu" }),
        },
        session &&
            steer && {
                label: conversation.archived ? "Unarchive session" : "Archive session",
                icon: "archive",
                run: () => setArchived([conversation.id], !conversation.archived),
            },
        {
            label: "Running now",
            detail: "everything Pi is doing",
            icon: "pulse",
            run: () => openSheet({ type: "running" }),
        },
        {
            label: "Providers",
            detail: "sign in to model providers",
            icon: "key",
            run: () => openSheet({ type: "providers" }),
        },
        { label: "Extensions", icon: "shield", run: () => openSheet({ type: "extensions" }) },
        { label: "Spend", icon: "pulse", run: () => openSheet({ type: "spend" }) },
        collab()
            ? {
                  label: "People and invites",
                  icon: "users",
                  run: () => openSheet({ type: "people" }),
              }
            : {
                  label: "Sign in another device",
                  icon: "users",
                  run: () => openSheet({ type: "invite" }),
              },
        {
            label: "Keyboard shortcuts",
            icon: "keyboard",
            keys: "?",
            run: () => openSheet({ type: "shortcuts" }),
        },
        {
            label: "Your name",
            detail: me?.name,
            icon: "users",
            run: () => openSheet({ type: "name" }),
        },
    ];

    return list.filter(Boolean).map((item) => ({
        ...item,
        kind: "action",
        key: `action:${item.label}`,
        text: `${item.label} ${item.detail ?? ""}`,
    }));
}

function sessionItems() {
    const { sessions, server } = store.state;
    const order = workspaceOrder();
    const archived = sessions.filter((session) => session.archived);

    return [...order, ...archived].map((session) => {
        const number = order.indexOf(session);

        return {
            kind: "session",
            key: `session:${session.id}`,
            label: session.title ?? "New session",
            detail: `${shortPath(session.cwd, server?.home)} · ${session.busy ? "working" : timeAgo(session.updatedAt)}${session.archived ? " · archived" : ""}`,
            text: `${session.title ?? "New session"} ${shortPath(session.cwd, server?.home)}`,
            icon: session.waiting ? "shield" : session.busy ? "pulse" : "chat",
            keys: number >= 0 && number < 9 ? `Alt ${number + 1}` : undefined,
            rank: session.archived ? -20 : -number * 0.01,
            run: () => navigate(session.id),
            id: session.id,
        };
    });
}

function themeItems() {
    const desktop = store.state.desktopTheme;
    const ids = [...(desktop ? ["desktop"] : []), ...themeIds()];

    return ids.map((id) => {
        const palette = paletteOf(id);
        const name = id === "desktop" ? `Desktop · ${palette.name}` : THEMES[id].name;

        return {
            kind: "theme",
            key: `theme:${id}`,
            label: name,
            detail:
                id === "desktop"
                    ? "follows your Omarchy theme"
                    : palette.colors.mode === "light"
                      ? "light"
                      : "dark",
            text: `theme ${name} ${id}`,
            theme: id,
            vars: themeVars(palette),
        };
    });
}

const GROUP_NAMES = { session: "Sessions", action: "Actions", theme: "Themes" };
const PREFIXES = { ">": "action", "@": "session", "#": "theme" };

export function Launcher({ leaving }) {
    const [query, setQuery] = useState("");
    const [pick, setPick] = useState(0);
    const input = useRef(null);
    const list = useRef(null);
    const returnTo = useRef(document.activeElement);
    const chosen = useRef(false);

    const prefix = PREFIXES[query[0]];
    const needle = (prefix ? query.slice(1) : query).trim().toLowerCase();
    const { sessions, view, conversationId } = store.state;

    const groups = useMemo(() => {
        const all = [
            ...(prefix === undefined || prefix === "session" ? sessionItems() : []),
            ...(prefix === undefined || prefix === "action" ? actionItems() : []),
            ...(prefix === undefined || prefix === "theme" ? themeItems() : []),
        ];
        const scored = [];

        for (const item of all) {
            const match = fuzzy(item.text, needle);

            if (!match) {
                continue;
            }

            const hits = match.hits.filter((at) => at < item.label.length);

            scored.push({ ...item, score: match.score + (item.rank ?? 0), hits });
        }

        const byKind = new Map();

        for (const item of scored) {
            if (!byKind.has(item.kind)) {
                byKind.set(item.kind, []);
            }

            byKind.get(item.kind).push(item);
        }

        const out = [...byKind.entries()].map(([kind, items]) => {
            if (needle !== "") {
                items.sort((a, b) => b.score - a.score);
            }

            const limit =
                needle === "" && prefix === undefined
                    ? kind === "session"
                        ? 6
                        : kind === "theme"
                          ? 99
                          : 99
                    : 40;

            return { kind, items: items.slice(0, limit), best: items[0]?.score ?? 0 };
        });

        // With a query, the group with the best match comes first; without, sessions, then actions, then themes.
        if (needle !== "") {
            out.sort((a, b) => b.best - a.best);
        }

        return out;
    }, [
        needle,
        prefix,
        sessions,
        view.conversation,
        view.plan?.on,
        conversationId,
        store.state.desktopTheme,
        store.state.appearance,
    ]);

    const flat = groups.flatMap((group) => group.items);
    const index = Math.min(pick, Math.max(0, flat.length - 1));
    const selected = flat[index];
    const slide = useSlide(list, ".launcher-item.on");

    useEffect(() => {
        input.current?.focus();

        return () => {
            if (!chosen.current) {
                preview(null);
            }

            // Back to where focus was, or into the sheet an action opened.
            const sheet = document.querySelector(".sheet-host:not(.leaving) .sheet");
            const back = sheet ?? returnTo.current;

            if (back && back.isConnected && typeof back.focus === "function") {
                back.focus({ preventScroll: true });
            }
        };
    }, []);
    useEffect(() => setPick(0), [needle, prefix]);
    // Arrowing onto a theme shows it right away; anything else shows the theme in use.
    useEffect(() => {
        if (leaving) {
            if (!chosen.current) {
                preview(null);
            }

            return;
        }

        preview(selected?.kind === "theme" ? selected.theme : null);
    }, [selected?.key, leaving]);
    useEffect(() => {
        list.current?.querySelector(".launcher-item.on")?.scrollIntoView({ block: "nearest" });
    }, [index]);

    const close = () => store.set({ launcher: false });

    const run = (item, event) => {
        if (!item) {
            return;
        }

        chosen.current = item.kind === "theme";
        close();

        if (item.kind === "theme") {
            preview(null);

            if (item.theme !== prefs().theme) {
                setPrefs({ theme: item.theme });
            }

            return;
        }

        item.run(event);
    };

    const move = (by) => setPick((index + by + flat.length) % Math.max(1, flat.length));

    const onKey = (event) => {
        if (event.isComposing) {
            return;
        }

        const key = event.key;

        if (
            key === "ArrowDown" ||
            (event.ctrlKey && (key === "n" || key === "j")) ||
            (key === "Tab" && !event.shiftKey)
        ) {
            event.preventDefault();
            move(1);
        } else if (
            key === "ArrowUp" ||
            (event.ctrlKey && key === "p") ||
            (key === "Tab" && event.shiftKey)
        ) {
            event.preventDefault();
            move(-1);
        } else if (key === "PageDown") {
            event.preventDefault();
            move(8);
        } else if (key === "PageUp") {
            event.preventDefault();
            move(-8);
        } else if (key === "Enter") {
            event.preventDefault();
            run(selected, event);
        } else if (key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            close();
        }
    };

    let at = 0;
    const mode = prefix ? GROUP_NAMES[prefix] : null;

    return html`<div
        class=${`launcher-overlay ${leaving ? "leaving" : ""}`}
        inert=${leaving}
        onMouseDown=${(event) => event.target === event.currentTarget && close()}
    >
        <section
            class="launcher"
            role="dialog"
            aria-modal="true"
            aria-label="Launcher"
            onMouseDown=${(event) => event.target !== input.current && event.preventDefault()}
        >
            <label class="launcher-input">
                <span class="prompt" aria-hidden="true">❯</span>
                <input
                    ref=${input}
                    value=${query}
                    placeholder="Sessions, actions, themes…"
                    autocomplete="off"
                    autocapitalize="none"
                    spellcheck=${false}
                    role="combobox"
                    aria-expanded="true"
                    onInput=${(event) => setQuery(event.currentTarget.value)}
                    onKeyDown=${onKey}
                />
                ${mode && html`<span class="launcher-mode">${mode}</span>`}
            </label>
            <div class="launcher-list" ref=${list} role="listbox">
                <${Slide} box=${slide} />
                ${
                    flat.length === 0 &&
                    html`<div class="launcher-empty">Nothing matches “${needle}”.</div>`
                }
                ${groups.map(
                    (group) => html`<div class="launcher-group">${GROUP_NAMES[group.kind]}</div>
                    ${group.items.map((item) => {
                        const mine = at++;
                        const on = mine === index;

                        return html`<button
                            key=${item.key}
                            class=${`launcher-item ${on ? "on" : ""}`}
                            role="option"
                            aria-selected=${on}
                            onMouseMove=${() => mine !== index && setPick(mine)}
                            onClick=${(event) => run(item, event)}
                        >
                            ${
                                item.kind === "theme"
                                    ? html`<span class="swatch" style=${varsStyle(item.vars)}>
                                        <i style="background:var(--o-bg)"></i>
                                        <i style="background:var(--o-accent)"></i>
                                        <i style="background:var(--o-green)"></i>
                                        <i style="background:var(--o-red)"></i>
                                    </span>`
                                    : html`<span class="glyph">
                                        ${
                                            item.kind === "session" && item.id === conversationId
                                                ? "●"
                                                : html`<${Icon} name=${item.icon} size=${15} />`
                                        }
                                    </span>`
                            }
                            <span class="main">
                                <span><${Marked} text=${item.label} hits=${item.hits} /></span>
                                ${item.detail && html`<span class="detail">${item.detail}</span>`}
                            </span>
                            ${
                                item.kind === "theme" &&
                                item.theme === prefs().theme &&
                                html`<span class="hint">current</span>`
                            }
                            ${
                                item.keys &&
                                html`<span class="hint"><${Keys} keys=${item.keys} /></span>`
                            }
                        </button>`;
                    })}`,
                )}
            </div>
            <div class="launcher-foot">
                <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
                <span><kbd>↵</kbd> open</span>
                <span><kbd>esc</kbd> close</span>
                <span><kbd>></kbd> actions <kbd>@</kbd> sessions <kbd>#</kbd> themes</span>
            </div>
        </section>
    </div>`;
}
