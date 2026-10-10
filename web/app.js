// Pi Pocket web app. No build step: edit a file under web/ and every open browser reloads.
import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { canGoBack, goBack, goHome, replaceAddress, startHistory, useBack } from "./back.js";
import { BrowserButton, BrowserPanel } from "./browser-panel.js";
import { browserAvailable, toggleBrowser } from "./browser.js";
import { PeopleButton, PeoplePanel } from "./chat.js";
import { Composer } from "./composer.js";
import {
    FilesButton,
    FilesPanel,
    filesAvailable,
    setFilesOpen,
    toggleFiles,
} from "./files-panel.js";
import { startEdgeBack, startSwipes } from "./gestures.js";
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
import { Drawer, RailNav, ResizeHandle, SessionList, workspaceOrder } from "./sessions.js";
// Loaded for what it does: it gives replies' Markdown the component for pages, images, and diffs in code blocks.
import "./rich.js";
import { takeShare } from "./share.js";
import { Sheets } from "./sheets.js";
import { SignIn } from "./signin.js";
import { openSubagents } from "./subagents.js";
import { SubagentsBoard } from "./subagents-board.js";
import {
    actions,
    attempt,
    canSteer,
    dismiss,
    filesShown,
    navigate,
    notify,
    openSheet,
    panelsBeside,
    peopleDocked,
    scoped,
    start,
    store,
} from "./store.js";
import { prefs, setPrefs, startTheme } from "./theme.js";
import { Transcript } from "./transcript.js";
import { APPLE, Boot, html, Icon, iconPath, shortPath, usePresence } from "./ui.js";

/**
 * Back to the session list, where it is not beside the conversation: back past the sessions opened from it, as a
 * phone's back would go, or to it in this session's place when history does not lead there.
 */
const toSessions = () => goHome(() => navigate(null, { replace: true }));

function Topbar() {
    const { view, server } = store.state;
    const conversation = view.conversation;
    const artifacts = view.artifacts?.length ?? 0;
    const subtitle =
        conversation?.kind === "subagent"
            ? `subagent of ${conversation.parent?.title ?? "?"}`
            : conversation?.worktree
              ? `⎇ ${view.branch?.branch ?? conversation.worktree.branch}`
              : shortPath(view.agent?.cwd ?? conversation?.cwd, server?.home);
    const busySubagents = (view.subagents ?? []).filter((agent) => agent.busy).length;
    // Other sessions waiting for an approval, counted on the way back to them.
    const waiting = store.state.sessions.filter(
        (session) =>
            session.waiting && !session.archived && session.id !== store.state.conversationId,
    ).length;

    return html`<header class="topbar">
        <button
            class="icon-button badge-host topbar-back"
            aria-label=${waiting > 0 ? `Back to sessions, ${waiting} waiting for you` : "Back to sessions"}
            title="Sessions"
            onClick=${toSessions}
        >
            <${Icon} name="back" size=${22} />
            ${waiting > 0 && html`<span class="badge warn">${waiting}</span>`}
        </button>
        <button class="title" onClick=${() => conversation && openSheet({ type: "menu" })}>
            <div class="title-main">
                <span>
                    ${conversation?.title ?? store.state.sessions.find((session) => session.id === store.state.conversationId)?.title ?? "Loading…"}
                </span>
            </div>
            <div class="title-sub mono">${subtitle}</div>
        </button>
        ${
            busySubagents > 0 &&
            html`<button class="icon-button" title="Subagents working" onClick=${openSubagents}>
                <span class="pulse"></span>
                <span class="count">${busySubagents}</span>
            </button>`
        }
        <${PeeksButton} />
        <${PeopleButton} />
        <${FilesButton} />
        <${BrowserButton} />
        <button
            class=${`icon-button badge-host ${artifacts > 0 ? "" : "quiet"}`}
            aria-label="Artifacts"
            onClick=${() => openSheet({ type: "artifacts" })}
        >
            <${Icon} name="artifact" />
            ${artifacts > 0 && html`<span class="badge">${artifacts}</span>`}
        </button>
        <button class="icon-button" aria-label="Menu" onClick=${() => openSheet({ type: "menu" })}>
            <${Icon} name="more" />
        </button>
    </header>`;
}

/** Notices, Omarchy's notification style: each slides in, counts down, and slides out when it goes. */
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

    return html`<div class="notices" role="status" aria-live="polite">
        ${all.map((notice) => {
            const leaving = !notices.includes(notice);

            return html`<button
                key=${notice.id}
                class=${`notice ${notice.level} ${leaving ? "leaving" : ""}`}
                style=${`--life:${notice.level === "error" ? 9 : 4.5}s`}
                onClick=${() => {
                    dismiss(notice.id);
                    notice.action?.();
                }}
            >
                ${notice.message}
            </button>`;
        })}
    </div>`;
}

/** The launcher, kept on screen a moment after it closes so it can fade out. */
function LauncherHost() {
    const [open, leaving] = usePresence(store.state.launcher || null, 150);

    useBack(Boolean(store.state.launcher), () => store.set({ launcher: false }));

    return open ? html`<${Launcher} leaving=${leaving} />` : null;
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
    // The subagents board takes the conversation's place, and the panels beside it give it their room.
    const board = state.board;
    const browsing =
        inConversation && !board && state.browserOpen && browserAvailable() && !state.missing;
    const filing = !board && filesShown(state);
    const people = !board && !browsing && !filing && peopleDocked(state);
    const peeking = !board && peeksWanted(state);
    const tiles = peeking ? peekTiles(state) : [];
    // The column takes the place beside the conversation when Browser and People leave it free; otherwise a strip,
    // which only shows when there are tiles.
    const peekColumn = peeking && PEEK_WIDE.matches && !browsing && !filing && !people;

    return html`<div
        class=${`layout ${inConversation || board ? "" : "home"} ${browsing ? "browsing" : ""} ${filing ? "filing" : ""}`}
    >
        <aside class="sidebar window">
            <div class="sidebar-clip">
                <${RailNav} foldable=${true} folded=${rail} />
                ${!rail && html`<${SessionList} />`}
            </div>
            ${!rail && html`<${ResizeHandle} />`}
        </aside>
        <div class=${`pane window ${board ? "boarded" : ""}`}>
            ${
                board
                    ? html`<${SubagentsBoard} />`
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
                      : html`<div class="home-list">
                          <${RailNav} />
                          <${SessionList} />
                      </div>
                      <${Splash} />`
            }
        </div>
        ${
            inConversation &&
            html`<${PeekHost}
                shown=${peekColumn}
                tiles=${tiles}
                replaced=${browsing || filing || people}
            />`
        }
        <${PanelHost}
            key=${`browser:${state.conversationId}`}
            shown=${browsing}
            panel=${BrowserPanel}
        />
        <${PanelHost} key=${`files:${state.conversationId}`} shown=${filing} panel=${FilesPanel} />
        ${inConversation && html`<${PeopleHost} shown=${people} replaced=${browsing || filing} />`}
        <${Drawer} />
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

    const name =
        ["sidebar", "browser", "files-tile", "people", "peeks"].find((each) =>
            win.classList.contains(each),
        ) ?? "pane";

    if (document.documentElement.dataset.focus !== name) {
        document.documentElement.dataset.focus = name;
    }
}

document.addEventListener("pointerover", focusWindow, true);
document.addEventListener("pointerdown", focusWindow, true);
document.addEventListener("focusin", focusWindow, true);

const typingIn = (target) =>
    target instanceof HTMLElement &&
    (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
const wide = () => matchMedia("(min-width: 960px)").matches;

/** Go to the session `by` places away in workspace order, wrapping around. */
function step(by) {
    const order = workspaceOrder();

    if (order.length === 0) {
        return;
    }

    const at = order.findIndex((session) => session.id === store.state.conversationId);

    navigate(order[(at + by + order.length) % order.length].id);
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

    if (!store.state.me) {
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
        !store.state.board
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

        // The panels are not beside the subagents board.
        if (
            event.code === "KeyB" &&
            store.state.conversationId !== null &&
            !store.state.board &&
            browserAvailable()
        ) {
            event.preventDefault();
            toggleBrowser();

            return;
        }

        if (event.code === "KeyE" && !store.state.board && filesAvailable()) {
            event.preventDefault();
            toggleFiles();

            return;
        }
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
const ESCAPE_TWICE_MS = 1500;

/** Esc twice stops Pi, as Esc does in other agents' terminals. Twice, since Esc also closes things and leaves fields. */
function stopOnSecondEscape() {
    const { view, sheet, launcher, board } = store.state;

    // Esc closes these first.
    if (sheet || launcher || board || !view.live?.busy || !canSteer()) {
        return;
    }

    if (Date.now() - escapedAt < ESCAPE_TWICE_MS) {
        escapedAt = 0;
        attempt(actions.abort);

        return;
    }

    escapedAt = Date.now();
    notify("info", "Press Esc again to stop Pi.");
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

    // The subagents board in the conversation's place (or the home screen's): right goes back, as its × does.
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
