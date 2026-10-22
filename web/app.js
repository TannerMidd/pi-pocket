// Pi Pocket web app. No build step: edit a file under web/ and every open browser reloads.
import { render } from "preact";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { folderColor } from "./avatar.js";
import { canGoBack, goBack, replaceAddress, startHistory, useBack } from "./back.js";
import { BrowserButton, BrowserPanel } from "./browser-panel.js";
import { browserAvailable, setBrowserOpen, toggleBrowser } from "./browser.js";
import { PeopleButton, PeoplePanel } from "./chat.js";
import { Composer, openingByAlt } from "./composer.js";
import { useChanges } from "./diff.js";
import {
    FilesButton,
    FilesPanel,
    filesAvailable,
    setFilesOpen,
    toggleFiles,
} from "./files-panel.js";
import { ExtensionPage, ExtensionPanel, extPanelShown } from "./extension-ui.js";
import { startEdgeBack, startSwipes, useDragToClose } from "./gestures.js";
import { Splash } from "./home.js";
import { Launcher } from "./launcher.js";
import { registerWorker, updateBadge } from "./notify.js";
import {
    PEEK_WIDE,
    PeekHost,
    PeeksButton,
    PeekStrip,
    peekTiles,
    peeksWanted,
    togglePeeks,
} from "./peeks.js";
import { closePip, openPip, PipHost, pipAvailable, togglePip } from "./pip.js";
import { Drawer, RailNav, ResizeHandle, SessionList, toSessions } from "./sessions.js";
// Loaded for what it does: it gives replies' Markdown the component for pages, images, and diffs in code blocks.
import "./rich.js";
import { takeShare } from "./share.js";
import { Sheets } from "./sheets.js";
import { defineItem, slotItems } from "./slots.js";
import { branchAvailable, headLabel } from "./sheets/branch.js";
import { SignIn } from "./signin.js";
import { openSubagents } from "./subagents.js";
import { SubagentsBoard } from "./subagents-board.js";
import {
    actions,
    attempt,
    canSteer,
    dismiss,
    filesShown,
    holdNotice,
    navigate,
    notify,
    openSheet,
    panelsBeside,
    peopleDocked,
    scoped,
    start,
    store,
    workspaceOrder,
} from "./store.js";
import { prefs, setPrefs, startTheme } from "./theme.js";
import { Transcript } from "./transcript.js";
import {
    APPLE,
    Boot,
    BOTTOM_SHEETS,
    html,
    Icon,
    iconPath,
    shortPath,
    useEdge,
    usePresence,
    WIDE,
} from "./ui.js";
import { toggleDictation } from "./voice.js";

/** What changed in the session's folder: lines added and removed, and how many files. It opens Changes. */
function ChangesButton() {
    const { changes } = useChanges();
    // Outside a repository Pi's edits are all there is to review (in one, they are what was committed since).
    const files = [...(changes?.files ?? []), ...(changes?.repo ? [] : (changes?.piOnly ?? []))];

    if (files.length === 0) {
        return null;
    }

    // Git counts the lines of changed files, not of new or binary ones: each side shows when it has some.
    const added = files.reduce((sum, file) => sum + (file.added ?? 0), 0);
    const removed = files.reduce((sum, file) => sum + (file.removed ?? 0), 0);
    const lines = added > 0 || removed > 0;
    const count = files.length + (changes.more ?? 0);
    const counted = `${count} ${count === 1 ? "file" : "files"}`;

    return html`<button
        class="changes-button"
        title="Uncommitted changes in this session's folder"
        aria-label=${`Changes: ${counted}${lines ? `, ${added} lines added and ${removed} removed` : ""}`}
        onClick=${() => setFilesOpen(true, "changes")}
    >
        ${added > 0 && html`<span class="added">+${added}</span>`}
        ${removed > 0 && html`<span class="removed">−${removed}</span>`}
        <span class=${lines ? "changes-files" : ""}>${counted}</span>
    </button>`;
}

// The top bar's buttons after the title: the app's own items of the `topbar` slot (slots.js), which a person can hide
// and reorder in Appearance, with extensions' between them. The menu stays last.
defineItem("topbar", {
    id: "core:subagents",
    label: "Subagents working",
    order: 100,
    render() {
        const busy = (store.state.view.subagents ?? []).filter((agent) => agent.busy).length;

        return (
            busy > 0 &&
            html`<button
                class="icon-button"
                aria-label=${`Subagents: ${busy} working`}
                title="Subagents working"
                onClick=${openSubagents}
            >
                <span class="pulse"></span>
                <span class="count">${busy}</span>
            </button>`
        );
    },
});
defineItem("topbar", {
    id: "core:changes",
    label: "Changes",
    order: 200,
    render: () => filesAvailable() && html`<${ChangesButton} key=${store.state.conversationId} />`,
});
defineItem("topbar", {
    id: "core:peeks",
    label: "Peek tiles",
    order: 300,
    render: () => html`<${PeeksButton} />`,
});
defineItem("topbar", {
    id: "core:files",
    label: "Files",
    order: 400,
    render: () => html`<${FilesButton} />`,
});
defineItem("topbar", {
    id: "core:browser",
    label: "Browser",
    order: 500,
    render: () => html`<${BrowserButton} />`,
});
defineItem("topbar", {
    id: "core:artifacts",
    label: "Artifacts",
    order: 600,
    render() {
        const artifacts = store.state.view.artifacts?.length ?? 0;

        return html`<button
            class=${`icon-button badge-host ${artifacts > 0 ? "quiet-phone" : "quiet"}`}
            aria-label="Artifacts"
            title="Artifacts"
            onClick=${() => openSheet({ type: "artifacts" })}
        >
            <${Icon} name="artifact" />
            ${artifacts > 0 && html`<span class="badge">${artifacts}</span>`}
        </button>`;
    },
});
defineItem("topbar", {
    id: "core:people",
    label: "People",
    order: 700,
    render: () => html`<${PeopleButton} />`,
});
defineItem("topbar", {
    id: "core:menu",
    label: "Menu",
    order: 1000,
    fixed: true,
    render: () =>
        html`<button
            class="icon-button"
            aria-label="Menu"
            title="Menu"
            aria-haspopup="dialog"
            aria-expanded=${store.state.sheet?.type === "menu"}
            onClick=${() => openSheet({ type: "menu" })}
        >
            <${Icon} name="more" />
        </button>`,
});

function Topbar() {
    const { view, server } = store.state;
    const conversation = view.conversation;
    const cwd = view.agent?.cwd ?? conversation?.cwd;
    const folder = String(cwd ?? "")
        .replace(/\/+$/, "")
        .split("/")
        .pop();
    const branch = headLabel(view.branch) || conversation?.worktree?.branch;
    const { sessions, conversationId } = store.state;
    // The top bar draws with each update of the conversation, as an answer streams: the session list is looked
    // through again only when it changes.
    const { listed, waiting } = useMemo(
        () => ({
            listed: sessions.find((session) => session.id === conversationId)?.title,
            // Other sessions waiting for an approval, counted on the way back to them.
            waiting: sessions.filter(
                (session) => session.waiting && !session.archived && session.id !== conversationId,
            ).length,
        }),
        [sessions, conversationId],
    );
    const title = conversation?.title ?? listed ?? (store.state.missing ? "Not found" : "Loading…");
    // How far down it reaches: PiP's window on a short wide screen stops below its buttons.
    const edge = useEdge("--topbar-h", (rect) => rect.bottom);

    return html`<header class="topbar" data-part="topbar" ref=${edge}>
        <button
            class="icon-button badge-host topbar-back"
            aria-label=${waiting > 0 ? `Back to sessions, ${waiting} waiting for you` : "Back to sessions"}
            title="Sessions"
            onClick=${toSessions}
        >
            <${Icon} name="back" size=${22} />
            ${waiting > 0 && html`<span class="badge warn">${waiting}</span>`}
        </button>
        <div class="title">
            <button
                class="title-open"
                aria-label=${`${title}${folder ? `, in ${folder}` : ""}: session menu`}
                title=${cwd ? `${shortPath(cwd, server?.home)}\nSession menu` : "Session menu"}
                disabled=${!conversation}
                onClick=${() => openSheet({ type: "menu" })}
            ></button>
            <span class="title-main" data-part="topbar-title" aria-hidden="true">${title}</span>
            <span class="title-sub" data-part="topbar-sub">
                ${
                    folder &&
                    html`<span
                        class="folder-mark"
                        style=${`--folder:${folderColor(cwd)}`}
                        aria-hidden="true"
                    ></span>`
                }
                ${
                    conversation?.kind === "subagent"
                        ? html`<span class="title-folder title-parent">
                              subagent of ${conversation.parent?.title ?? "?"}
                          </span>`
                        : html`${
                              folder &&
                              html`<span class="title-folder" aria-hidden="true">${folder}</span>`
                          }
                          ${
                              branch &&
                              (branchAvailable()
                                  ? html`<button
                                        class="title-branch"
                                        aria-label=${view.branch?.detached ? `No branch, at ${branch}: switch to one` : `Branch ${branch}: switch or make a branch`}
                                        title=${view.branch?.detached ? "No branch: switch to one" : "Switch or make a branch"}
                                        onClick=${() => openSheet({ type: "branch" })}
                                    >
                                        <${Icon} name="fork" size=${10} /><span class="title-branch-name">${branch}</span>
                                    </button>`
                                  : html`<span class="title-branch" title="The git branch">
                                        <${Icon} name="fork" size=${10} /><span class="title-branch-name">${branch}</span>
                                    </span>`)
                          }
                          ${
                              conversation?.worktree &&
                              html`<span class="title-worktree" aria-hidden="true">worktree</span>`
                          }`
                }
            </span>
        </div>
        ${slotItems("topbar").map(({ node }) => node)}
    </header>`;
}

/**
 * A notice, as a small tile: a state square in its level's color, the message, and a countdown line until it goes. A
 * tap dismisses it, or does what it offers (a chevron says so); on a phone, a swipe up puts it away.
 */
function Notice({ notice, leaving }) {
    const ref = useRef(null);
    const [pointed, setPointed] = useState(false);
    const [focused, setFocused] = useState(false);
    const held = (pointed || focused) && !leaving;

    // Its countdown, and the line that shows it, wait while it is being read or reached for.
    useEffect(() => holdNotice(notice.id, held), [held]);

    useDragToClose(ref, {
        dir: "up",
        onClose: () => dismiss(notice.id),
        enabled: BOTTOM_SHEETS.matches,
        // It fades as it goes, not the stack behind it.
        scrim: ref,
    });

    return html`<button
        ref=${ref}
        class=${`notice ${notice.level} ${notice.action ? "acts" : ""} ${held ? "held" : ""} ${leaving ? "leaving" : ""}`}
        data-part="notice"
        style=${`--life:${notice.life ?? 4500}ms`}
        onPointerEnter=${() => setPointed(true)}
        onPointerLeave=${() => setPointed(false)}
        onFocus=${() => setFocused(true)}
        onBlur=${() => setFocused(false)}
        onClick=${() => {
            dismiss(notice.id);
            notice.action?.();
        }}
    >
        <span class="notice-mark" aria-hidden="true"></span>
        <span class="notice-text">${notice.message}</span>
        <${Icon} name=${notice.action ? "chevron" : "close"} size=${14} />
    </button>`;
}

/** Notices: each slides in, counts down, and slides out when it goes. */
function Notices() {
    const { notices } = store.state;
    const [gone, setGone] = useState([]);
    const before = useRef(notices);

    useEffect(() => {
        const removed = before.current.filter(
            (notice) => !notices.some((each) => each.id === notice.id),
        );

        before.current = notices;

        if (removed.length === 0) {
            return;
        }

        setGone((list) => [...list, ...removed]);
        setTimeout(
            () => setGone((list) => list.filter((notice) => !removed.includes(notice))),
            160,
        );
    }, [notices]);
    const all = [
        ...notices,
        ...gone.filter((notice) => !notices.some((each) => each.id === notice.id)),
    ].sort((a, b) => a.id - b.id);

    if (all.length === 0) {
        return null;
    }

    return html`<div class="notices" data-part="notices" role="status" aria-live="polite">
        ${all.map(
            (notice) =>
                html`<${Notice}
                    key=${notice.id}
                    notice=${notice}
                    leaving=${!notices.includes(notice)}
                />`,
        )}
    </div>`;
}

/** The launcher, kept on screen a moment after it closes so it can fade out. */
function LauncherHost() {
    const [opening, setOpening] = useState({ n: 0, returnTo: document.activeElement });
    const wasOpen = useRef(Boolean(store.state.launcher));

    // Observe logical openings before batched renders: even a close/reopen in one task gets a fresh launcher.
    // Issue #62, reported by @arunsathiya: a retained, inert launcher must not reopen without its input focused.
    useLayoutEffect(
        () =>
            store.subscribe((state) => {
                const next = Boolean(state.launcher);

                if (next && !wasOpen.current) {
                    const target = document.activeElement;

                    setOpening((previous) => ({
                        n: previous.n + 1,
                        returnTo:
                            target === document.body || target?.closest(".launcher-overlay")
                                ? previous.returnTo
                                : target,
                    }));
                }

                wasOpen.current = next;
            }),
        [],
    );

    const [open, leaving] = usePresence(store.state.launcher ? opening : null, 150);

    useBack(Boolean(store.state.launcher), () => store.set({ launcher: false }));

    return open
        ? html`<${Launcher} key=${open.n} leaving=${leaving} returnTo=${open.returnTo} />`
        : null;
}

/**
 * The People panel, kept on screen a moment after it closes so it can slide out. Not when the Browser panel or the Files
 * tile takes its place.
 */
function PeopleHost({ shown, replaced }) {
    const [kept, leaving] = usePresence(shown || null, 180);

    if (kept === null || (leaving && replaced)) {
        return null;
    }

    return html`<${PeoplePanel} leaving=${leaving} />`;
}

/**
 * The Browser panel or the Files tile. Where it covers the conversation it is a screen pushed over it, kept a moment
 * after it closes so it can slide away; beside the conversation it goes at once.
 */
function PanelHost({ shown, panel }) {
    const [kept, leaving] = usePresence(shown || null, 240);
    const covering = shown && !panelsBeside();

    // Over the conversation, keys go to the panel (a dialog then, with Tab kept in it), unless something in it already
    // took them; when it goes, they go back to what had them before, unless something else took them meanwhile.
    useLayoutEffect(() => {
        if (!covering) {
            return undefined;
        }

        const opener = document.activeElement;
        const box = document.querySelector(
            ".layout > :is(.files-tile, .browser, .ext-panel):not(.leaving)",
        );

        if (box && !box.contains(opener)) {
            box.focus({ preventScroll: true });
        }

        return () => {
            const active = document.activeElement;

            // Not into a text field on touch screens, where its keyboard would pop up.
            if (
                (active === null || active === document.body || box?.contains(active)) &&
                opener?.isConnected &&
                !box?.contains(opener) &&
                !(
                    matchMedia("(pointer: coarse)").matches &&
                    opener.matches("input, textarea, [contenteditable]")
                )
            ) {
                opener.focus({ preventScroll: true });
            }
        };
    }, [covering]);

    if (kept === null || (leaving && panelsBeside())) {
        return null;
    }

    return html`<${panel} leaving=${leaving} />`;
}

function App() {
    const state = store.state;

    useEffect(() => {
        document.title = state.view.conversation?.title
            ? `${state.view.conversation.title} · Pi Pocket`
            : "Pi Pocket";
    }, [state.view.conversation?.title]);

    if (state.me === undefined) {
        return html`<${Boot}
            caption=${state.notices.some((notice) => notice.level === "error") ? "waiting for the server" : "starting"}
        />
        <${Notices} />`;
    }

    if (state.me === null) {
        return html`<${SignIn} /><${Notices} />`;
    }

    const inConversation = state.conversationId !== null;
    const rail = prefs().sidebar === "rail";
    // The sidebar and the splash show only on wide screens (style.css): narrower, they are not drawn at all. A phone
    // drew the sidebar's session list beside its own, hidden, on each change and each Back.
    const sidebar = WIDE.matches;
    // The subagents board, or an extension's page, takes the conversation's place, and the panels beside it give it
    // their room.
    const board = state.board;
    const page = !board && state.page !== null;
    const placed = board || page;
    const browsing =
        inConversation && !placed && state.browserOpen && browserAvailable() && !state.missing;
    const filing = !placed && filesShown(state);
    // An extension's panel, in the same place: one panel at a time, so opening one closes the others.
    const paneling = !placed && !browsing && !filing && extPanelShown(state);
    const people = !placed && !browsing && !filing && !paneling && peopleDocked(state);
    const peeking = !placed && peeksWanted(state);
    const tiles = peeking ? peekTiles(state) : [];
    // The column takes the place beside the conversation when Browser and People leave it free; otherwise a strip,
    // which only shows when there are tiles.
    const peekColumn = peeking && PEEK_WIDE.matches && !browsing && !filing && !paneling && !people;

    return html`<div
        class=${`layout ${inConversation || placed ? "" : "home"} ${browsing ? "browsing" : ""} ${filing ? "filing" : ""} ${paneling ? "paneling" : ""}`}
        data-part="app"
    >
        <aside class="sidebar window" data-part="sidebar">
            ${
                sidebar &&
                html`<div class="sidebar-clip">
                        <${RailNav} foldable=${true} folded=${rail} />
                        ${!rail && html`<${SessionList} />`}
                    </div>
                    ${!rail && html`<${ResizeHandle} />`}`
            }
        </aside>
        <div class=${`pane window ${placed ? "boarded" : ""}`} data-part="pane">
            ${
                board
                    ? html`<${SubagentsBoard} />`
                    : page
                      ? html`<${ExtensionPage} key=${`${state.page.module}:${state.page.id}`} />`
                      : inConversation
                        ? html`<${Topbar} />
                    ${
                        peeking &&
                        tiles.length > 0 &&
                        !peekColumn &&
                        html`<${PeekStrip} tiles=${tiles} />`
                    }
                    <${Transcript} key=${state.conversationId} />
                    ${
                        state.view.conversation &&
                        !state.missing &&
                        html`<${Composer} key=${state.conversationId} />`
                    }`
                        : html`<div class="home-list" data-part="home-list">
                          <${RailNav} />
                          <${SessionList} />
                      </div>
                      ${sidebar && html`<${Splash} />`}`
            }
        </div>
        ${
            inConversation &&
            html`<${PeekHost}
                shown=${peekColumn}
                tiles=${tiles}
                replaced=${browsing || filing || paneling || people}
            />`
        }
        <${PanelHost}
            key=${`browser:${state.conversationId}`}
            shown=${browsing}
            panel=${BrowserPanel}
        />
        <${PanelHost} key=${`files:${state.conversationId}`} shown=${filing} panel=${FilesPanel} />
        <${PanelHost}
            key=${`ext:${state.conversationId}`}
            shown=${paneling}
            panel=${ExtensionPanel}
        />
        ${
            inConversation &&
            html`<${PeopleHost} shown=${people} replaced=${browsing || filing || paneling} />`
        }
        <${Drawer} />
        <${PipHost} />
        <${Sheets} />
        <${LauncherHost} />
        <${Notices} />
    </div>`;
}

// ─── Windows and keys ───────────────────────────────────────────────────────────

/** Which window has focus, as Hyprland shows it: the one under the mouse (Omarchy's follow_mouse), or that took a tap or a key. */
function focusWindow(event) {
    if (event.type === "pointerover" && event.pointerType !== "mouse") {
        return;
    }

    const win = event.target.closest?.(".window");

    if (!win) {
        return;
    }

    // By the window's part name, as themes know it: `sidebar`, `peeks`, `people-panel`, `browser-panel`, `files-panel`,
    // `extension-panel`.
    const name =
        [
            "sidebar",
            "peeks",
            "people-panel",
            "browser-panel",
            "files-panel",
            "extension-panel",
        ].find((each) => win.matches(`[data-part~="${each}"]`)) ?? "pane";

    if (document.documentElement.dataset.focus !== name) {
        document.documentElement.dataset.focus = name;
    }
}

// The conversation's window has the focus until another takes it: `data-focus` always names one, for themes too.
document.documentElement.dataset.focus ??= "pane";
document.addEventListener("pointerover", focusWindow, true);
document.addEventListener("pointerdown", focusWindow, true);
document.addEventListener("focusin", focusWindow, true);

const typingIn = (target) =>
    target instanceof HTMLElement &&
    (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
const wide = () => WIDE.matches;

/** Go to the session `by` places away in workspace order, wrapping around. */
function step(by) {
    const order = workspaceOrder();

    if (order.length === 0) {
        return;
    }

    const at = order.findIndex((session) => session.id === store.state.conversationId);

    const next = order[(at + by + order.length) % order.length].id;

    openingByAlt(next);
    navigate(next);
}

addEventListener("keydown", (event) => {
    if (event.isComposing) {
        return;
    }

    if (event.key === "Alt") {
        document.documentElement.dataset.alt = "on";
    }

    // Cmd on Apple keyboards, where Ctrl+K and Ctrl+B edit text; Ctrl elsewhere.
    const mod = APPLE ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
    const key = event.key.toLowerCase();

    if (event.defaultPrevented || !store.state.me) {
        return;
    }

    if (mod && !event.altKey && !event.shiftKey && key === "k") {
        event.preventDefault();
        store.set({ launcher: !store.state.launcher, drawer: false });

        return;
    }

    // Find in this session: the browser's own find misses the messages the transcript does not draw.
    if (
        mod &&
        !event.altKey &&
        !event.shiftKey &&
        key === "f" &&
        store.state.view.conversation &&
        !store.state.launcher &&
        !store.state.board &&
        !store.state.page
    ) {
        event.preventDefault();
        openSheet({ type: "find" });

        return;
    }

    if (mod && !event.altKey && !event.shiftKey && key === "b") {
        event.preventDefault();

        if (wide()) {
            setPrefs({ sidebar: prefs().sidebar === "rail" ? "open" : "rail" });
        } else {
            store.set({ drawer: !store.state.drawer });
        }

        return;
    }

    // Option types characters on Apple keyboards, and AltGr does on many layouts: no Alt shortcuts there while typing.
    const altTypes = event.getModifierState?.("AltGraph") || (APPLE && typingIn(event.target));

    if (event.altKey && !event.ctrlKey && !event.metaKey && !altTypes) {
        const digit = /^Digit([1-9])$/.exec(event.code);

        if (digit) {
            const session = workspaceOrder()[Number(digit[1]) - 1];

            event.preventDefault();

            if (session) {
                openingByAlt(session.id);
                navigate(session.id);
            }

            return;
        }

        if (event.code === "ArrowDown" || event.code === "ArrowUp") {
            event.preventDefault();
            step(event.code === "ArrowDown" ? 1 : -1);

            return;
        }

        if (event.code === "KeyN" && canSteer() && !scoped()) {
            event.preventDefault();
            openSheet({ type: "cwd", mode: "new" });

            return;
        }

        if (event.code === "KeyP" && store.state.server?.peeks === true) {
            event.preventDefault();
            togglePeeks();

            return;
        }

        if (event.code === "KeyT") {
            event.preventDefault();
            setPrefs({ showThinking: !prefs().showThinking });
            notify("info", `Show thinking: ${prefs().showThinking ? "on" : "off"}.`);

            return;
        }

        // The panels are not beside the subagents board, nor an extension's page.
        if (
            event.code === "KeyB" &&
            store.state.conversationId !== null &&
            !store.state.board &&
            !store.state.page &&
            browserAvailable()
        ) {
            event.preventDefault();
            toggleBrowser();

            return;
        }

        if (event.code === "KeyE" && !store.state.board && !store.state.page && filesAvailable()) {
            event.preventDefault();
            toggleFiles();

            return;
        }

        // PiP, the assistant over every screen; not under a sheet, where it would open unseen.
        if (event.code === "KeyA" && pipAvailable() && !store.state.sheet) {
            event.preventDefault();
            togglePip();

            return;
        }

        // Dictation into the message box in view: PiP's while it is open, else the session's.
        if (
            event.code === "KeyV" &&
            !store.state.sheet &&
            !store.state.launcher &&
            toggleDictation()
        ) {
            event.preventDefault();

            return;
        }
    }

    // Esc closes PiP first, unless a sheet or the launcher is over it: those close first.
    if (
        event.key === "Escape" &&
        !event.defaultPrevented &&
        store.state.pipOpen &&
        !store.state.sheet &&
        !store.state.launcher
    ) {
        event.preventDefault();
        closePip();

        return;
    }

    // Esc closes the Files tile or the Browser panel where it covers the conversation, as back does. What is inside
    // takes it first: a file open over the tree, the page in the panel, a field.
    const cover =
        event.key === "Escape" &&
        !event.defaultPrevented &&
        !store.state.sheet &&
        !store.state.launcher &&
        !store.state.drawer &&
        document.querySelector(
            '.layout > [aria-modal="true"]:is(.files-tile, .browser):not(.leaving)',
        );

    if (cover) {
        event.preventDefault();

        if (cover.classList.contains("files-tile")) {
            setFilesOpen(false);
        } else {
            setBrowserOpen(false);
        }

        return;
    }

    if (event.key === "Escape" && !event.defaultPrevented) {
        stopOnSecondEscape();
    }

    if (
        event.key === "?" &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !typingIn(event.target) &&
        !store.state.sheet &&
        !store.state.launcher
    ) {
        event.preventDefault();
        openSheet({ type: "shortcuts" });
    }
});
/** When Esc was last pressed while Pi worked: a second press soon after stops it. */
let escapedAt = 0;
/** The notice the first press shows. */
let escapeNotice = null;
const ESCAPE_TWICE_MS = 1500;

/** Esc twice stops Pi, as Esc does in other agents' terminals. Twice, since Esc also closes things and leaves fields. */
function stopOnSecondEscape() {
    const { view, sheet, launcher, board, page, drawer } = store.state;

    // Esc closes these first.
    if (sheet || launcher || board || page || drawer || !view.live?.busy || !canSteer()) {
        return;
    }

    if (Date.now() - escapedAt < ESCAPE_TWICE_MS) {
        escapedAt = 0;
        // Pressed again: what it asked for is done.
        dismiss(escapeNotice);
        attempt(actions.abort);

        return;
    }

    escapedAt = Date.now();
    const notice = (escapeNotice = notify("info", "Press Esc again to stop Pi."));

    // Up only while a second press stops Pi.
    setTimeout(() => dismiss(notice), ESCAPE_TWICE_MS);
}

const altUp = () => delete document.documentElement.dataset.alt;

addEventListener("keyup", (event) => event.key === "Alt" && altUp());
addEventListener("blur", altUp);

// The whole tree re-renders from the store; Preact's diff keeps that cheap. Batched per microtask.
startTheme();
// Where the session list is not beside the conversation, a conversation opened straight away gets it under it, so back
// goes to the list rather than out of the app.
startHistory({ home: !wide() });
startEdgeBack();
// One hand on a phone: on the conversation, swipe right to go back and left for the Files tile; swipe up from the
// message box for the places.
startSwipes((where) => {
    const { conversationId, view, missing } = store.state;

    // The subagents board or an extension's page in the conversation's place (or the home screen's): right goes back,
    // as its × does.
    if (where === "board") {
        return { right: { path: iconPath("back"), label: "Back", run: goBack } };
    }

    if (conversationId === null || !view.conversation || missing) {
        return {};
    }

    if (where === "files") {
        return { right: { path: iconPath("back"), label: "Back", run: goBack } };
    }

    // Back to the list, or to the session before when that is where back goes.
    const toList = !canGoBack() || history.state?.pocket?.back === 1;

    return {
        right: {
            path: iconPath("back"),
            label: toList ? "Sessions" : "Back",
            run: () => (canGoBack() ? goBack() : toSessions()),
        },
        left: filesAvailable()
            ? { path: iconPath("folder"), label: "Files", run: () => setFilesOpen(true) }
            : null,
        up: () => openSheet({ type: "places" }),
    };
});
const root = document.getElementById("app");
let queued = false;

store.subscribe(() => {
    if (queued) {
        return;
    }

    queued = true;
    queueMicrotask(() => {
        queued = false;
        render(html`<${App} />`, root);
    });
});
render(html`<${App} />`, root);

// A notification's link can ask for the chat: `/s/12?chat=1`.
if (new URLSearchParams(location.search).has("chat")) {
    replaceAddress(location.pathname);
    openSheet({ type: "chat" });
}

// PiP's notifications open its panel, over whatever was open: `/?pip=1`. Opened once the server says PiP is here.
if (new URLSearchParams(location.search).has("pip")) {
    replaceAddress(location.pathname);
    const stop = store.subscribe(() => {
        if (store.state.server) {
            stop();
            openPip();
        }
    });
}

// The worker shows notifications and receives what other apps share; it needs a secure page (https or localhost).
registerWorker();
store.subscribe(updateBadge);
start();
// Something shared from another app: the service worker kept it, and redirected here to choose where it goes.
const shared = new URLSearchParams(location.search).get("share");

if (shared !== null) {
    replaceAddress(location.pathname);
    takeShare(shared).then(
        (share) =>
            share
                ? store.set({ sheet: { type: "share", share } })
                : notify("error", "What was shared did not arrive. Share it again."),
        () => notify("error", "What was shared could not be read. Share it again."),
    );
}
