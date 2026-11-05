// PiP, "Pi in Pocket": the owner's assistant, in a small window over whatever is open, or (Appearance → PiP → Board)
// opened as a conversation in the session's place, with its top bar, menu, and every step. It stays out of the way until
// called: Alt+A, the rail's PiP button, the places, the launcher, or `/pip`; and a small mark in the corner shows only
// while PiP works, or has something new. The panel watches PiP's conversation through a view of its own (`pipview`
// events), so the session behind it stays as it was.
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { followUpText } from "./artifact-bridge.js";
import { useBack } from "./back.js";
import { boxKey, keyBox } from "./box-keys.js";
import { useDragToClose } from "./gestures.js";
import { createPipDraft } from "./pip-attachments.js";
import { personStorage } from "./person-storage.js";
import { splitQuote, withQuote } from "./quote-text.js";
import { usePipResize } from "./pip-window.js";
import {
    api,
    attempt,
    giveBackQuote,
    isRow,
    navigate,
    notify,
    openSheet,
    dropQuote,
    onItsWay,
    showsPip,
    store,
    takeInsert,
    uid,
} from "./store.js";
import { spendTap } from "./taps.js";
import { prefs } from "./theme.js";
import { memoryAvailable, PendingMemories } from "./sheets/memory.js";
import { itemsOf, says, summarize } from "./turns.js";
import {
    attachedPictureSrc,
    contextLevel,
    entryImageUrl,
    formatBytes,
    formatTokens,
    html,
    Icon,
    Markdown,
    modelLabel,
    railState,
    readable,
    Spinner,
    splitAttachments,
    Thumb,
    usePresence,
} from "./ui.js";
import { MicButton, useDictation } from "./voice.js";

const OPEN_KEY = "pocket.pip";
const SEEN_KEY = "pocket.pip.seen";
const DRAFT_KEY = "pip.draft";
// Image previews and in-flight work outlive the panel, but never their PiP/account scope.
const composerDraft = createPipDraft({
    loadText: () => personStorage.get(DRAFT_KEY) ?? "",
    saveText: (text) => personStorage.set(DRAFT_KEY, text || null),
    upload: (id, file) => api(`c/${id}/upload?name=${encodeURIComponent(file.name)}`, file),
    onError: (message) => notify("error", message),
});

const syncDraftScope = (state) => {
    // Before the first hello, a signed-out/unknown bootstrap is not this tab logging out.
    const changed = composerDraft.scope(
        state.me === undefined || (state.me === null && !state.server)
            ? undefined
            : (state.me?.id ?? null),
        state.pip?.id,
    );

    // The quote over PiP's box goes with its draft's files: to another person, or another PiP, it was never theirs.
    const stale = state.pipQuote;

    if (changed && stale) {
        // Out of this `set`: a change made from inside one reaches the listeners after it out of order. Only that quote:
        // one put there meanwhile is the new person's.
        queueMicrotask(() => {
            if (store.state.pipQuote === stale) {
                store.set({ pipQuote: null });
            }
        });
    }
};

syncDraftScope(store.state);
/** How many of PiP's newest rows the panel shows: it is for the moment, and the full conversation is a tap away. */
const ROWS = 80;
/** Below this width the panel is a sheet from the bottom edge; above it, a window in the corner. */
const NARROW = matchMedia("(max-width: 699px)");
const REPORT = "[report] ";
/**
 * What came from outside, as PiP gets it: a post to one of the person's webhooks (`hooks.ts`), or what happened on a
 * repository they watch (`repo-watches.ts`). Which one, then the instructions and what came.
 */
const WEBHOOK = /^\[via webhook ([^\]\n]{1,300})\] /;
const REPO_WATCH = /^\[via watch ([^\]\n]{1,300})\] /;

/**
 * A webhook's post or a watch's news for reading: the person's instructions, and what came as plain text (never
 * Markdown: it is anyone's), without the note to PiP about it.
 */
function post(text) {
    const body = text.replace(
        /\n?What came between <(?:webhook-payload|github-event)> tags[^\n]*$/,
        "",
    );
    const data = /<(webhook-payload|github-event)[^>]*>\n?([\s\S]*?)\n?<\/\1>/.exec(body);

    return data
        ? { text: body.slice(0, data.index).trim(), data: readable(data[2]) }
        : { text: body, data: null };
}

const SCHEDULED = "[scheduled] ";

const INTRO =
    "I keep an eye on your sessions and repositories: ask what’s going on, start new work, have me check back later, or watch a repository and act when something happens.";

/** Things to ask PiP on its first open: sent at once, or (ending in "…") put in the box to finish. */
const SUGGESTIONS = [
    "What needs me?",
    "What happened today?",
    "Start a session to …",
    "Every weekday at 9:00, tell me what changed overnight",
    "When CI fails on main in …",
];

/** The server lets this person have a PiP: the owner, while its extension is on. */
export const pipAvailable = () => store.state.server?.pip === true;

let seq = 0;
/** The connection the panel's last "open" went to: a new one (a reconnect) is told again. */
let toldConnection = null;
/** The server's answer to the last "open": PiP's state, with its conversation's id. */
let opening = null;
/** PiP's box is to take the focus as it shows, also on a phone (`focusComposer`). */
let focusWanted = false;

/** Tell the server whether this tab's panel shows: while it does, the server sends PiP's conversation. */
function tellServer(on) {
    const connection = store.state.streamId;

    if (!connection) {
        return Promise.resolve(null);
    }

    toldConnection = on ? connection : null;
    const asked = api("pip", { connection, on, seq: ++seq }).then(
        (answer) => {
            if (answer.pip) {
                store.set({ pip: answer.pip });
            }

            return answer.pip ?? null;
        },
        (error) => {
            if (on) {
                closePip();
                notify("error", error.message ?? String(error));
            }

            return null;
        },
    );

    if (on) {
        opening = asked;
    }

    return asked;
}

/** Where PiP opens, as Appearance says: `"floating"` (the corner, or a phone's sheet), or `"board"`. */
export const pipPlace = () => (prefs()?.pip === "board" ? "board" : "floating");

/**
 * PiP open as a board: its conversation is the route (`showsPip`), in the session's place, with nothing (Running now, an
 * extension's page) over that place.
 */
export const pipBoard = (state = store.state) =>
    showsPip(state) && !state.board && state.page === null;

/** PiP shows, in either place: its floating panel open, or its conversation in the session's place. */
export const pipShown = (state = store.state) => state.pipOpen || pipBoard(state);

/** The place the open panel is in, so a change of the setting moves it. */
let place = pipPlace();
/** PiP was turned off in Extensions, as the server last said: the change closes the board, once. */
let turnedOff = false;

// A floating panel kept open across a reload, where PiP now opens as a board: its conversation's route is what is kept.
if (store.state.pipOpen && place === "board") {
    sessionStorage.removeItem(OPEN_KEY);
    store.set({ pipOpen: false });
}

// A reconnect (or the first connection, with the panel kept open across a reload) gets the panel's view again; PiP
// turned off in Extensions closes the panel, and the board. The setting changed while PiP shows moves it to the other
// place.
store.subscribe((state) => {
    syncDraftScope(state);

    const board = pipBoard(state);
    const off = Boolean(state.server) && !pipAvailable();

    if (off !== turnedOff) {
        turnedOff = off;

        if (off && board) {
            closePip();

            return;
        }
    }

    if (board && state.pip?.endedAt !== undefined) {
        // Its conversation in view counts as seen, as the panel does.
        markSeen();
    }

    const now = pipPlace();

    if (now !== place) {
        place = now;

        // Moved after this change has reached every listener (a change made from inside one would reach the listeners
        // after it out of order), and only if the setting and PiP's place are still what they were by then. PiP's quote
        // is PiP's wherever it shows, so it stays as it is.
        if (now === "board" && state.pipOpen) {
            queueMicrotask(() => {
                if (pipPlace() === "board" && store.state.pipOpen) {
                    closePip();
                    openBoard(true);
                }
            });

            return;
        }

        if (now === "floating" && board) {
            queueMicrotask(() => {
                if (pipPlace() === "floating" && pipBoard()) {
                    closePip();
                    openPip();
                }
            });

            return;
        }
    }

    if (!state.pipOpen) {
        return;
    }

    if (state.server && !pipAvailable()) {
        closePip();
    } else if (state.streamId && state.streamId !== toldConnection) {
        tellServer(true);
    }
});

// A PiP notification tapped while a window is open: the worker asks that window for the panel (`sw.js`).
navigator.serviceWorker?.addEventListener("message", (event) => {
    if (event.data?.type === "pocket.pip") {
        openPip();
    }
});

/** PiP's answers seen up to now: what the panel last showed, by the server's clock. */
function markSeen() {
    const ended = store.state.pip?.endedAt;

    if (ended !== undefined && ended > Number(localStorage.getItem(SEEN_KEY) ?? 0)) {
        localStorage.setItem(SEEN_KEY, String(ended));
    }
}

/** PiP answered since this browser last looked, and is not at work. */
export function pipUnread(state = store.state) {
    const pip = state.pip;

    return Boolean(
        pip &&
        !pipShown(state) &&
        !pip.busy &&
        pip.endedAt !== undefined &&
        pip.endedAt > Number(localStorage.getItem(SEEN_KEY) ?? 0),
    );
}

/** How long PiP's board waits for the tab to know who it is and to connect, as a page opens from a notification. */
const CONNECT_MS = 15_000;

/** Resolves once the tab knows its person and has a connection to the server, or after `CONNECT_MS` anyway. */
function connected() {
    const ready = (state) => state.me?.id !== undefined && Boolean(state.streamId);

    if (ready(store.state)) {
        return Promise.resolve();
    }

    return new Promise((resolve) => {
        const done = () => {
            clearTimeout(timer);
            stop();
            resolve();
        };

        const stop = store.subscribe((state) => ready(state) && done());
        const timer = setTimeout(done, CONNECT_MS);
    });
}

/**
 * PiP's conversation's id, for the person signed in now; asked of the server (which makes PiP the first time) when this
 * tab does not know it yet. Undefined when there is none, or the person changed meanwhile.
 */
async function pipConversation() {
    await connected();
    const account = store.state.me?.id;
    let id = store.state.pip?.id;

    if (id === undefined) {
        id = (await tellServer(true))?.id;

        // Asked only for the id: no panel shows, so the server sends no view of it.
        if (!store.state.pipOpen) {
            tellServer(false);
        }
    }

    return account !== undefined && account === store.state.me?.id ? id : undefined;
}

/** What is in the session's place now, to see whether the person went somewhere else while PiP's id came. */
const placeNow = () => {
    const { conversationId, board, page } = store.state;

    return `${conversationId}:${board}:${page?.module}:${page?.id}`;
};

/**
 * Open PiP's conversation in the session's place, as a session opens. What is over that place goes, as for Running now,
 * but with `keepSheet` the sheet that moved it there (Appearance) stays.
 */
async function openBoard(keepSheet = false) {
    const before = placeNow();
    const id = await pipConversation();

    // Nothing to open, or the person went elsewhere (or chose Floating) while the id came: they are not taken back.
    if (id === undefined || !pipAvailable() || pipPlace() !== "board" || placeNow() !== before) {
        return;
    }

    // Also when its conversation is under Running now, or an extension's page: they give the place back. A sheet kept
    // stays over the new route. Its new entry keeps the route it was opened over, for closing it.
    navigate(id, {
        ...(keepSheet ? { sheet: store.state.sheet } : {}),
        over: { id: store.state.conversationId },
    });
    store.set({
        launcher: false,
        drawer: false,
        page: null,
        ...(keepSheet ? {} : { sheet: null }),
    });
}

/** Open PiP where Appearance says; with `text`, put it in PiP's message box. Resolves once it is open as a board. */
export function openPip(text) {
    // A focus asked for before, by an open that did not show PiP, is not this one's.
    focusWanted = false;

    if (!pipAvailable()) {
        return Promise.resolve();
    }

    // PiP's box takes it as it shows, in either place.
    if (text) {
        store.set({ pipDraft: { text, n: (store.state.pipDraft?.n ?? 0) + 1 } });
    }

    if (pipPlace() === "board") {
        return openBoard();
    }

    if (store.state.pipOpen) {
        focusComposer();

        return Promise.resolve();
    }

    sessionStorage.setItem(OPEN_KEY, "1");
    // The subscriber above tells the server, from inside this `set`: once, not twice.
    store.set({ pipOpen: true, launcher: false, drawer: false });

    return Promise.resolve();
}

/**
 * Ask PiP about a passage of Pi's reply in session `session` (or none): a quote strip over PiP's box holds it, and the
 * next message to PiP goes with it quoted first. The server tells PiP, unseen, which session it came from.
 */
export async function quotePip(passage, session) {
    store.set({
        pipQuote: { text: passage, ...(typeof session === "number" ? { session } : {}) },
    });
    await openPip();
    focusComposer();
}

/** Close PiP in either place: its conversation in the session's place gives way to what was there before. */
export function closePip() {
    const open = store.state.pipOpen;

    if (pipBoard()) {
        // Back to the route it was opened over (`over`, kept on its history entry through back, forward, and a reload),
        // so no entry of PiP's stays to come back to; a sheet still open (Appearance, moving PiP to the corner) stays
        // over it. Reached another way (the address), it gives the place to the home screen.
        const { over: from, sheet } = store.state;

        navigate(from?.id ?? null, { sheet, back: from !== null });
    }

    if (!open || !store.state.pipOpen) {
        return;
    }

    sessionStorage.removeItem(OPEN_KEY);
    markSeen();
    store.set({ pipOpen: false });
    tellServer(false);
}

export const togglePip = () => (pipShown() ? closePip() : openPip());

/** Put `text` in PiP's box, after what is there, and open PiP. */
function draftPip(text) {
    const draft = personStorage.get(DRAFT_KEY)?.trim();

    openPip(draft ? `${draft}\n\n${text}` : text);
}

/** Send PiP a message from anywhere (`/pip …`), and open the panel to show what it says; true when it went. */
export async function askPip(text) {
    if (!pipAvailable()) {
        notify("error", "PiP is not on here.");

        return false;
    }

    const account = store.state.me?.id;

    await openPip();
    const pip = store.state.pip ?? (await opening);

    if (account !== store.state.me?.id) {
        return false;
    }

    if (!pip) {
        notify("error", "PiP is not ready yet: your message waits in its box.");
    }

    // Not sent: the words wait in PiP's box rather than be lost (`send` said why), after what was there already.
    if (pip && (await send(pip.id, text, false))) {
        return true;
    }

    if (account === store.state.me?.id && (!pip || store.state.pip?.id === pip.id)) {
        draftPip(text);
    }

    return false;
}

const PIP_UNAVAILABLE = "PiP is not available";

/**
 * What `pocket.pip.ask` does for the browser module `source` names: put its text in PiP's box for the person to read,
 * edit, and send; or, with `send` and only just after a tap or a key press, send it as the person's own message. The
 * text starts with where it came from, as an artifact's follow-up does, so it never reads as a command. The answer says
 * why nothing happened, or whether the message went (`sent` is false when it waits in the box).
 */
export async function askPipFrom(source, text, send) {
    if (!pipAvailable()) {
        return { ok: false, reason: PIP_UNAVAILABLE };
    }

    const words = followUpText(text.trim(), undefined, source);

    if (!send) {
        draftPip(words);

        return { ok: true, sent: false };
    }

    if (!spendTap()) {
        return { ok: false, reason: "Sending needs a click or a key press just before" };
    }

    return { ok: true, sent: await askPip(words) };
}

/** Send PiP a message; false when it did not go (a notice says why). PiP made just now is waited for. */
async function send(id, text, busy, attachments = [], about = undefined) {
    const account = store.state.me?.id;
    const target = id ?? store.state.pip?.id ?? (await opening)?.id;

    if (account !== store.state.me?.id || (id !== undefined && store.state.pip?.id !== id)) {
        return false;
    }

    if (target === undefined) {
        notify("error", "PiP is not ready yet. Try again in a moment.");

        return false;
    }

    const sent = await attempt(() =>
        api(`c/${target}/submit`, {
            text,
            ...(attachments.length > 0 ? { attachments } : {}),
            ...(about === undefined ? {} : { about }),
            requestId: uid(),
            // Words for PiP while it works change what it does now, rather than wait for it.
            ...(busy ? { mode: "steer" } : {}),
        }),
    );

    return sent !== undefined;
}

/**
 * Compact PiP's context: older messages become a summary PiP writes without what came from outside (`pip-compact.ts`).
 * `focus`, the person's words, is what the summary should keep in mind. A notice says when it is done.
 */
function compactPip(id, focus) {
    return attempt(() => api(`c/${id}/compact`, focus ? { instructions: focus } : {}));
}

/** `/compact`, or `/compact what to keep in mind`, typed in PiP's box. */
const COMPACT = /^\/compact(?:\s+([\s\S]*))?$/;

/** How close PiP is to its own compaction limit, never beyond the model's context window. */
function PipContext({ stats, window }) {
    if (!window || stats?.contextTokens === undefined) {
        return null;
    }

    const used = stats.contextTokens;
    const at = store.state.server?.pipCompactAt;
    const limit = at > 0 ? Math.min(at, window) : window;
    const percent = Math.min(100, Math.round((used / limit) * 100));
    const about = stats.contextEstimated ? "~" : "";
    const tokens = `${about}${formatTokens(used)} of ${formatTokens(limit)} tokens in PiP's context.`;
    const when =
        at > window
            ? `PiP's idle compaction limit is ${formatTokens(at)} tokens.`
            : at > 0
              ? `PiP compacts itself above ${formatTokens(at)} once idle.`
              : "Compact it when it grows.";
    const cap = at > window ? " The meter is capped at the model's context window." : "";
    const title = `${tokens} ${when}${cap}`;

    return html`<span
        class="pip-context"
        role="img"
        aria-label=${`Context ${about}${percent}% full`}
        title=${title}
    >
        <span class=${`meter ${contextLevel(percent)}`}><span style=${`width:${percent}%`}></span></span>
        ${about}${percent}%
    </span>`;
}

/** Focus PiP's box: now, or as it shows, when its conversation comes after the route (the board's first open). */
function focusComposer() {
    focusWanted = true;
    requestAnimationFrame(() => {
        const box = document.querySelector(".pip-composer textarea");

        if (box) {
            focusWanted = false;
            box.focus();
        }
    });
}

/** A message in PiP's conversation without the "[from: Name]" a server with several people puts first. */
const written = (text) => text.replace(/^\[from: [^\]\n]{1,60}\] /, "");

/**
 * PiP's words with bare session addresses (`/s/12`, as reports and tool results write them) made links named after
 * their sessions. Links already written stay as they are.
 */
function linkSessions(text) {
    // What sessions said comes fenced for PiP (`pip.ts`); people read it as it is.
    text = text.replace(/\n?<\/?session-output>\n?/g, "\n");
    // `“Title” (/s/12)`, as reports name a session: one link.
    const named = text.replace(/“([^”\n[\]]{1,120})” \(\/s\/(\d+)\)/g, "[$1](/s/$2)");

    return named.replace(/(?<!\]\()(?<![\w/.])\/s\/(\d+)\b(?![\w/])/g, (_, id) => {
        const title = store.state.sessions.find((session) => session.id === Number(id))?.title;
        const label = (title ?? `/s/${id}`).replace(/[[\]]/g, "");

        return `[${label}](/s/${id})`;
    });
}

/** The session a link in PiP's words opens: `/s/12`, written whole or as an address of this app. */
function sessionOf(anchor) {
    const href = anchor.getAttribute("href") ?? "";
    const match = /^(?:https?:\/\/[^/]+)?\/s\/(\d+)\/?$/.exec(href);

    return match && (!/^https?:/.test(href) || new URL(href).origin === location.origin)
        ? Number(match[1])
        : null;
}

// ─── The panel ──────────────────────────────────────────────────────────────

/** A report from a session PiP follows, or a webhook's post (with what came as `data`): folded until opened. */
function Report({ text, label = "Report", data = null, conversationId }) {
    const [open, setOpen] = useState(false);

    return html`<div class=${`pip-report ${open ? "open" : ""}`}>
        <button
            type="button"
            class="pip-report-head"
            aria-expanded=${open}
            onClick=${() => setOpen(!open)}
        >
            <${Icon} name="pulse" size=${13} />
            <span>${label}</span>
            <${Icon} name="down" size=${13} class="pip-report-fold" />
        </button>
        <${Markdown}
            text=${linkSessions(text)}
            class="pip-report-text"
            conversationId=${conversationId}
        />
        ${data !== null && html`<pre class="pip-report-data">${data}</pre>`}
    </div>`;
}

/**
 * A message's list of attached files (`splitAttachments`). Uploaded names can contain commas or parentheses: find the
 * name repeated at the end of its saved path.
 */
function attachedFiles(block) {
    if (block === undefined) {
        return [];
    }

    return block.split("\n").flatMap((line) => {
        const suffix = /^- (.*), ([^,]*), (\d+) bytes\)( \[Image: .*)?$/.exec(line);

        if (!suffix) {
            return [];
        }

        const candidates = [...suffix[1].matchAll(/ \(/g)].map((separator) => ({
            path: suffix[1].slice(0, separator.index),
            name: suffix[1].slice(separator.index + 2),
            mime: suffix[2],
            size: Number(suffix[3]),
            noted: suffix[4] !== undefined,
        }));
        const file = candidates.find((candidate) => candidate.path.endsWith(candidate.name));

        return file ? [file] : [];
    });
}

/** One of the panel's rows: a message, a report, a group of PiP's calls, or its words. */
function Item({ item, last, busy, conversationId }) {
    if (item.type === "row") {
        const entry = item.entry;

        if (entry.kind === "user") {
            // Reports, posts, and scheduled messages whole: what came from outside may hold anything, an attachment
            // heading too, and is read only as the plain data it is.
            const body = written(entry.text);

            if (body.startsWith(REPORT)) {
                return html`<${Report}
                    text=${body.slice(REPORT.length)}
                    conversationId=${conversationId}
                />`;
            }

            const hook = WEBHOOK.exec(body);
            const watched = hook ? null : REPO_WATCH.exec(body);
            const outside = hook ?? watched;

            if (outside) {
                const posted = post(body.slice(outside[0].length));

                return html`<${Report}
                    label=${`${watched ? "GitHub" : "Webhook"}: ${outside[1]}`}
                    text=${posted.text}
                    data=${posted.data}
                    conversationId=${conversationId}
                />`;
            }

            if (body.startsWith(SCHEDULED)) {
                return html`<div class="pip-event">
                    <${Icon} name="pulse" size=${13} />
                    <span>${body.slice(SCHEDULED.length)}</span>
                </div>`;
            }

            const [text, block] = splitAttachments(body);
            // Uploaded pictures also remain readable when the chosen model cannot take inline images.
            const files = attachedFiles(block);
            // A browser cannot show a HEIC photo: it shows the JPEG the model got, or goes as a file.
            const pictures = files.flatMap((file) => {
                const src = attachedPictureSrc(file, files, entry, conversationId);

                return src === null ? [] : [{ file, src }];
            });
            const others = files.filter(
                (file) => !pictures.some((picture) => picture.file === file),
            );

            // A passage asked about (Ask PiP) shows as a quote block above the words, as in a session.
            const quote = splitQuote(text);

            return html`<div class="pip-you">
                ${
                    quote
                        ? html`<blockquote class="reply-quote" data-part="reply-quote">
                                  ${quote.passage}
                              </blockquote>
                              ${quote.rest && html`<div>${quote.rest}</div>`}`
                        : text && html`<div>${text}</div>`
                }
                ${
                    others.length > 0 &&
                    html`<div class="attachments">
                        ${others.map((file) => html`<span class="chip">📎 ${file.name}</span>`)}
                    </div>`
                }
                ${
                    (pictures.length > 0 || entry.images > 0) &&
                    html`<div class="thumbs">
                        ${
                            pictures.length > 0
                                ? pictures.map(
                                      ({ file, src }) => html`<${Thumb}
                                          src=${src}
                                          alt=${file.name}
                                      />`,
                                  )
                                : Array.from(
                                      { length: entry.images },
                                      (_, index) => html`<${Thumb}
                                          src=${entryImageUrl(entry.id, index, conversationId)}
                                          alt=${`Image ${index + 1}`}
                                      />`,
                                  )
                        }
                    </div>`
                }
            </div>`;
        }

        const line =
            entry.kind === "reset"
                ? "Fresh start"
                : entry.kind === "compaction"
                  ? "Earlier messages summarized"
                  : entry.kind === "note"
                    ? `${entry.name} ${entry.text}`
                    : null;

        return line && html`<div class="pip-event"><span>${line}</span></div>`;
    }

    // A page it showed in a reply (an old `artifact_inline` call): in this panel, a line like its other work.
    if (item.type === "inline") {
        return html`<div class="pip-steps">
            <span class="pip-tick"><${Icon} name="check" size=${10} /></span>
            <span>${summarize([item.step], false)}</span>
        </div>`;
    }

    if (item.type === "activity") {
        const thinking =
            item.steps.at(-1)?.streaming && item.steps.at(-1).block.type === "thinking";
        const working = busy && last;

        return html`<div class=${`pip-steps ${working ? "working" : ""}`}>
            ${working ? html`<${Spinner} hidden=${true} />` : html`<span class="pip-tick"><${Icon} name="check" size=${10} /></span>`}
            <span>${summarize(item.steps, thinking)}</span>
        </div>`;
    }

    if (item.type === "reply") {
        const text = item.blocks.map((each) => each.block.text).join("\n\n");
        const growing = item.blocks.some((each) => each.growing);
        const entry = item.entry;

        return html`<div class="pip-reply">
            ${
                text.trim() !== "" &&
                html`<${Markdown}
                    text=${linkSessions(text)}
                    cache=${!growing}
                    conversationId=${conversationId}
                />`
            }
            ${entry?.stopReason === "aborted" && html`<div class="pip-event"><span>Stopped</span></div>`}
            ${
                entry?.stopReason === "error" &&
                html`<div class="pip-error">${entry.error ?? "The model request failed."}</div>`
            }
        </div>`;
    }

    return null;
}

function Welcome({ id, name, hasModel }) {
    const first = (name ?? "").split(/\s+/)[0];

    return html`<div class="pip-welcome">
        <p class="pip-hello">Hi${first ? ` ${first}` : ""}. I’m PiP.</p>
        <p class="pip-intro">${INTRO}</p>
        ${
            !hasModel &&
            html`<p class="pip-intro">
                <button
                    type="button"
                    class="button small"
                    onClick=${() => openSheet({ type: "model", pipId: id })}
                >
                    Choose a model to use these suggestions
                </button>
            </p>`
        }
        <div class="pip-chips">
            ${SUGGESTIONS.map(
                (suggestion) => html`<button
                    type="button"
                    class="pip-chip"
                    key=${suggestion}
                    disabled=${!hasModel && !suggestion.endsWith("…")}
                    onClick=${() =>
                        suggestion.endsWith("…")
                            ? openPip(suggestion.slice(0, -1))
                            : send(id, suggestion, false)}
                >
                    ${suggestion}
                </button>`,
            )}
        </div>
    </div>`;
}

/**
 * PiP's one message box, with its one draft (`composerDraft`): in its panel, or with `board` in the session's place,
 * where it takes what is put into that place's box (`insertIntoComposer`) and has the session box's theme parts.
 */
function Composer({ id, busy, board = false }) {
    const [saved, setSaved] = useState(() => {
        composerDraft.syncText();

        return composerDraft.state;
    });
    const { text, files, pending } = saved;
    const ref = useRef(null);
    const picker = useRef(null);
    const draft = store.state.pipDraft;
    // A passage to ask about (Ask PiP by a selection): it goes quoted before the next message.
    const quote = store.state.pipQuote;
    const change = composerDraft.changeText;
    const uploading = files.some((file) => file.state === "uploading");
    const hasMessage = text.trim() !== "" || files.length > 0 || Boolean(quote);
    const sendDisabled =
        !hasMessage || (uploading && !COMPACT.test(text.trim())) || Boolean(pending);

    useLayoutEffect(() => {
        const unsubscribe = composerDraft.subscribe(setSaved);

        setSaved(composerDraft.state);

        return unsubscribe;
    }, []);

    const fit = () => {
        const box = ref.current;

        if (box) {
            box.style.height = "auto";
            box.style.height = `${Math.min(box.scrollHeight, 160)}px`;
        }
    };

    // PiP's box takes Alt+V while it shows, over the session's.
    const dictation = useDictation(ref, change, { top: true });

    useLayoutEffect(fit, [text]);
    // A phone's keyboard would cover the panel as it opens: there, the box waits for a tap, unless one asked for the
    // focus (Ask PiP). Elsewhere it takes the focus as it mounts, in the same task as the key that opened it, so the
    // next keys land here.
    useLayoutEffect(() => {
        if (!NARROW.matches || focusWanted) {
            focusWanted = false;
            ref.current?.focus({ preventScroll: true });
        }
    }, []);
    useEffect(() => {
        if (draft) {
            change(draft.text);
            ref.current?.focus();
            // Used: opened again later, the box keeps what was typed since.
            store.set({ pipDraft: null });
        }
    }, [draft?.n]);

    const insert = board ? store.state.composerInsert : null;

    useEffect(() => {
        const taken = insert && takeInsert(composerDraft.state.text, store.state.conversationId);

        if (taken?.files.length > 0) {
            composerDraft.addFiles(taken.files);
        }

        if (taken?.text) {
            change(taken.text);
            ref.current?.focus();
        }
    }, [insert?.n]);

    const submit = async (event) => {
        event?.preventDefault();
        // Read the durable-in-this-tab draft, not a render's text or an old panel's queue.
        const message = composerDraft.state.text.trim();
        const compact = COMPACT.exec(message);
        const quoted = store.state.pipQuote;

        if (message === "" && composerDraft.state.files.length === 0 && !quoted) {
            return;
        }

        if (compact && quoted) {
            notify("info", "A quote cannot go with a command. Remove the quote to run it.");

            return;
        }

        if (compact && id === undefined) {
            notify("error", "PiP is not ready yet. Try again in a moment.");

            return;
        }

        const token = composerDraft.begin(Boolean(compact));

        if (!token) {
            return;
        }

        // What shows is what goes: words still coming would land in the emptied box. The quote goes with the words, out
        // of PiP's box at once, so neither of PiP's places offers it again while it goes.
        dictation.stop(true);
        dropQuote(quoted);
        let success = false;

        try {
            // Compact never sends or removes the attachments waiting in the box.
            success = compact
                ? (await compactPip(id, compact[1]?.trim())) !== undefined
                : await send(
                      id,
                      quoted ? withQuote(quoted.text, message) : message,
                      busy,
                      token.files.map((file) => file.attachment),
                      quoted?.session === undefined ? undefined : { session: quoted.session },
                  );
        } finally {
            composerDraft.finish(token, success);
        }

        if (!success) {
            giveBackQuote(quoted, true);
        }
    };

    const onPaste = (event) => {
        const pasted = [...(event.clipboardData?.files ?? [])];

        if (pasted.length === 0) {
            return; // Normal text paste retains the browser's caret/selection behavior.
        }

        event.preventDefault();
        composerDraft.addFiles(pasted);
        const words = event.clipboardData?.getData("text/plain") ?? "";
        const box = event.currentTarget;

        if (words) {
            const at = box.selectionStart;
            const end = box.selectionEnd;
            const current = composerDraft.state.text;

            change(`${current.slice(0, at)}${words}${current.slice(end)}`);
            requestAnimationFrame(() =>
                box.setSelectionRange(at + words.length, at + words.length),
            );
        }
    };

    return html`<div
        class="pip-composer-wrap"
        onDragOver=${(event) => {
            if ([...(event.dataTransfer?.types ?? [])].includes("Files")) {
                event.preventDefault();
            }
        }}
        onDrop=${(event) => {
            const dropped = [...(event.dataTransfer?.files ?? [])];

            if (dropped.length > 0) {
                event.preventDefault();
                composerDraft.addFiles(dropped);
            }
        }}
    >
        ${
            id !== undefined &&
            store.state.me?.role === "owner" &&
            memoryAvailable(id) &&
            html`<${PendingMemories} id=${id} before=${board ? undefined : closePip} />`
        }
        ${
            files.length > 0 &&
            html`<div class="pip-attachments" aria-label="Files attached to PiP">
                ${files.map(
                    (file) => html`<div class="pip-attachment" key=${file.key}>
                        ${file.preview && html`<${Thumb} src=${file.preview} alt=${file.name} />`}
                        <span class="pip-attachment-name">${file.name}</span>
                        <span class="muted">${formatBytes(file.size)}</span>
                        ${
                            file.state === "uploading" &&
                            html`<${Spinner} label=${`Uploading ${file.name}`} />`
                        }
                        <button
                            type="button"
                            class="icon-button pip-attachment-remove"
                            aria-label=${`Remove ${file.name}`}
                            disabled=${onItsWay(pending?.files, file)}
                            onClick=${() => composerDraft.removeFile(file.key)}
                        >
                            <${Icon} name="close" size=${14} />
                        </button>
                    </div>`,
                )}
            </div>`
        }
        ${
            quote &&
            html`<div class="quote-strip pip-quote-strip" data-part="quote-strip">
                <${Icon} name="reply" size=${13} />
                <span class="quote-strip-text">${quote.text}</span>
                <button
                    type="button"
                    class="icon-button small"
                    aria-label="Remove the quote"
                    onClick=${() => dropQuote(quote)}
                >
                    <${Icon} name="close" size=${12} />
                </button>
            </div>`
        }
        <form
            class="pip-composer"
            data-part=${board ? "message-box" : undefined}
            onSubmit=${submit}
        >
            <input
                class="pip-file-picker"
                ref=${picker}
                type="file"
                multiple
                hidden
                disabled=${id === undefined}
                onChange=${(event) => {
                    composerDraft.addFiles([...(event.currentTarget.files ?? [])]);
                    event.currentTarget.value = "";
                }}
            />
            <button
                type="button"
                class="icon-button pip-attach"
                aria-label="Attach files to PiP"
                title="Attach files. Images need an image-capable model to be read inline."
                disabled=${id === undefined}
                onClick=${() => picker.current?.click()}
            >
                <${Icon} name="clip" size=${18} />
            </button>
            <textarea
                ref=${ref}
                rows="1"
                value=${text}
                placeholder=${dictation.listening ? "Listening…" : busy ? "Tell PiP more…" : "Ask PiP…"}
                aria-label="Message to PiP"
                enterkeyhint="send"
                onInput=${(event) => change(event.currentTarget.value)}
                onPaste=${onPaste}
                onKeyDown=${(event) => {
                    // A module's key (`pocket.composerKey`) comes first, as in the session's box.
                    const keyed = keyBox(event.currentTarget, "pip", (value, start, end) => {
                        change(value);
                        requestAnimationFrame(() => ref.current?.setSelectionRange(start, end));
                    });

                    if (boxKey(event, keyed)) {
                        event.preventDefault();

                        return;
                    }

                    if (
                        event.key === "Enter" &&
                        !event.shiftKey &&
                        !event.isComposing &&
                        event.keyCode !== 229
                    ) {
                        submit(event);
                    }
                }}
            ></textarea>
            <${MicButton} dictation=${dictation} class="pip-mic" size=${18} />
            ${
                busy && !hasMessage && !pending
                    ? html`<button
                          type="button"
                          class="icon-button pip-send"
                          aria-label="Stop PiP"
                          title="Stop"
                          onClick=${() => attempt(() => api(`c/${id}/abort`, {}))}
                      >
                          <${Icon} name="stop" size=${18} />
                      </button>`
                    : html`<button
                          type="submit"
                          class="icon-button pip-send"
                          data-part=${board ? "send-button" : undefined}
                          aria-label="Send to PiP"
                          disabled=${sendDisabled}
                      >
                          <${Icon} name="send" size=${18} />
                      </button>`
            }
        </form>
    </div>`;
}

/** When PiP takes a message that waits: a steer at its next pause, a queued one when it finishes its work. */
const pendingWhen = (item, busy) =>
    !busy
        ? "Waiting for PiP"
        : item.mode === "steer"
          ? "PiP reads this at its next pause"
          : "PiP reads this when it finishes";

/** Who sent a message, as the server writes it at the start when several people use Pi (`FROM_PREFIX`). */
const FROM = /^\[from: [^\]\n]{1,60}\] /;

/** Your messages in `view` (PiP's) that wait while PiP works: shown at once, as waiting, until PiP takes them. */
function Waiting({ id, view, busy }) {
    const me = store.state.me;

    return (view.inbox ?? [])
        .filter((item) => item.by === me?.id && (item.mode === "steer" || item.mode === "followUp"))
        .map(
            (item) => html`<div class="pip-you pending" key=${`pending-${item.id}`}>
                <div>
                    ${
                        typeof item.label === "string" && item.label !== ""
                            ? `▸ ${item.label}${item.summary ? `: ${item.summary}` : ""}`
                            : (item.text ?? "").replace(FROM, "")
                    }
                </div>
                <div class="pip-pending-line">
                    <span>${pendingWhen(item, busy)}</span>
                    <button
                        type="button"
                        class="pip-pending-withdraw"
                        onClick=${() =>
                            attempt(() => api(`c/${id}/withdraw`, { submissionId: item.id }))}
                    >
                        Withdraw
                    </button>
                </div>
            </div>`,
        );
}

/**
 * PiP's conversation as a board: in the session composer's place, PiP's own box (the panel's, with the same draft),
 * the messages that wait over it, and `children` (the status line) under it.
 */
export function PipBoardBox({ children }) {
    const { view, pip } = store.state;
    const busy = view.live.busy === true;

    return html`<footer class="composer-wrap pip-board-box" data-part="composer">
        <div class="pip-waiting"><${Waiting} id=${pip?.id} view=${view} busy=${busy} /></div>
        <${Composer} id=${pip?.id} busy=${busy} board=${true} />
        ${children}
    </footer>`;
}

function PipPanel({ leaving, scrim }) {
    const { pip, pipView: view, me } = store.state;
    const ref = useRef(null);
    const body = useRef(null);
    const pinned = useRef(true);
    const id = pip?.id;
    const ready = id !== undefined && view.conversation?.id === id;
    const live = ready ? view.live : { busy: false };
    const rows = ready
        ? view.order
              .map((entryId) => view.entries.get(entryId))
              .filter((entry) => entry && isRow(entry))
              .slice(-ROWS)
        : [];
    const blocks = live.generation?.message?.blocks ?? [];
    const items = itemsOf(rows, blocks.length > 0 ? { kind: "assistant", blocks } : null);
    const speaking = blocks.some(says);
    const busy = live.busy === true;
    const model = modelLabel(view.agent);
    const thinking = view.agent?.thinkingLevel === "off" ? "" : (view.agent?.thinkingLevel ?? "");
    // Calls of PiP's held for approval: the panel cannot answer them, so it says so and leads to where they can be.
    const waiting = ready ? (view.approvals ?? []) : [];
    const compacting = ready && (live.compactions ?? []).length > 0;
    const status =
        waiting.length > 0 ? "needs you" : compacting ? "compacting…" : busy ? "working…" : "";
    // Where the focus was before the panel: read as it first renders, before its box takes the focus.
    const [before] = useState(() => document.activeElement);

    usePipResize(ref, me?.id);
    useDragToClose(ref, { dir: "down", onClose: closePip, enabled: NARROW.matches, scrim });
    // Focus goes back where it was when the panel closes.
    useEffect(() => {
        const panel = ref.current;

        return () => {
            const active = document.activeElement;

            if (
                before instanceof HTMLElement &&
                before.isConnected &&
                (active === document.body || panel?.contains(active))
            ) {
                before.focus({ preventScroll: true });
            }
        };
    }, []);
    // What shows now counts as seen.
    useEffect(markSeen, [pip?.endedAt]);
    // Stay at the newest words while they come, unless someone scrolled up to read.
    useLayoutEffect(() => {
        const box = body.current;

        if (box && pinned.current) {
            box.scrollTop = box.scrollHeight;
        }
    });

    const openLink = (event) => {
        const anchor = event.target.closest?.("a[href]");
        const session = anchor ? sessionOf(anchor) : null;

        if (session === null) {
            return;
        }

        event.preventDefault();
        navigate(session);

        // On a phone the session is behind the panel: it steps aside.
        if (NARROW.matches) {
            closePip();
        }
    };

    return html`<section
        class=${`pip-panel ${leaving ? "leaving" : ""}`}
        data-part="pip"
        data-state=${leaving ? "closing" : undefined}
        ref=${ref}
        role="dialog"
        aria-modal=${NARROW.matches ? "true" : undefined}
        aria-label="PiP, your assistant"
    >
        <div class="pip-resize pip-resize-left" data-pip-resize="left" aria-hidden="true"></div>
        <div class="pip-resize pip-resize-top" data-pip-resize="top" aria-hidden="true"></div>
        <div class="pip-resize pip-resize-corner" data-pip-resize="corner" aria-hidden="true"></div>
        <header class="pip-head">
            <div class="grip"></div>
            <span class=${`pip-mark ${busy ? "working" : ""}`} aria-hidden="true">
                <${Icon} name="pip" size=${18} />
            </span>
            <div class="pip-heading">
                <div class="pip-title-line">
                    <h2>PiP</h2>
                    <span class="pip-status" aria-live="polite">${status}</span>
                </div>
                <button
                    class="model-chip pip-model"
                    disabled=${!ready || busy || compacting}
                    aria-label=${`PiP model: ${model}${thinking ? ` · ${thinking}` : ""}`}
                    title="Change PiP's model and thinking level"
                    onClick=${() => openSheet({ type: "model", pipId: id })}
                >
                    <span class="model-name">
                        ${model.replace(/^(?:anthropic:\s*)?claude\s+/i, "")}
                    </span>
                    ${thinking && html`<span class="model-level">${thinking}</span>`}
                </button>
            </div>
            ${
                ready &&
                html`<${PipContext} stats=${view.stats} window=${view.agent?.contextWindow} />`
            }
            <button
                class="icon-button"
                aria-label="Compact"
                title="Compact: PiP keeps a summary of older messages, and reads less each time"
                disabled=${!ready || busy || compacting || rows.length === 0}
                onClick=${() => compactPip(id)}
            >
                <${Icon} name="compact" size=${18} />
            </button>
            <button
                class="icon-button"
                aria-label="Start fresh"
                title="Start fresh: PiP forgets this conversation"
                disabled=${!ready || busy || rows.length === 0}
                onClick=${() =>
                    confirm("Start fresh? PiP forgets this conversation; you can still read it.") &&
                    attempt(() => api(`c/${id}/reset`, {}))}
            >
                <${Icon} name="reload" size=${18} />
            </button>
            <button class="icon-button" aria-label="Close PiP" title="Close (Esc)" onClick=${closePip}>
                <${Icon} name="close" size=${18} />
            </button>
        </header>
        <div
            class="pip-body"
            ref=${body}
            onClick=${openLink}
            onScroll=${(event) => {
                const box = event.currentTarget;

                pinned.current = box.scrollHeight - box.scrollTop - box.clientHeight < 48;
            }}
        >
            ${
                !ready
                    ? html`<div class="pip-loading"><${Spinner} label="Waking PiP" /></div>`
                    : rows.length === 0 && !busy
                      ? html`<${Welcome}
                            id=${id}
                            name=${me?.name}
                            hasModel=${Boolean(view.agent?.model)}
                        />`
                      : items.map(
                            (item, index) =>
                                html`<${Item}
                                    key=${item.key}
                                    item=${item}
                                    last=${index === items.length - 1}
                                    busy=${busy}
                                    conversationId=${id}
                                />`,
                        )
            }
            ${
                ready &&
                busy &&
                !speaking &&
                items.at(-1)?.type !== "activity" &&
                html`<div class="pip-steps working">
                    <${Spinner} hidden=${true} />
                    <span>Thinking</span>
                </div>`
            }
            ${ready && html`<${Waiting} id=${id} view=${view} busy=${busy} />`}
        </div>
        ${
            waiting.length > 0 &&
            html`<div class="pip-approval" role="status">
                <${Icon} name="shield" size=${14} />
                <span class="grow">PiP waits for your approval: ${waiting[0].tool}</span>
                <button
                    type="button"
                    class="button small"
                    onClick=${() => {
                        closePip();
                        navigate(id);
                    }}
                >
                    Review
                </button>
            </div>`
        }
        <${Composer} id=${id} busy=${busy} />
    </section>`;
}

/** The mark in the corner: only while PiP works, or has something new. */
function PipBubble() {
    const { pip } = store.state;
    const unread = pipUnread();
    // Its conversation in view says the same.
    const [kept, leaving] = usePresence(
        pip && !pipBoard() && (pip.busy || unread) ? (pip.busy ? "busy" : "news") : null,
        150,
    );

    if (kept === null) {
        return null;
    }

    return html`<button
        class=${`pip-bubble ${kept} ${leaving ? "leaving" : ""}`}
        aria-label=${kept === "busy" ? "PiP is working: open PiP" : "PiP has something new: open PiP"}
        title="PiP (Alt+A)"
        onClick=${() => openPip()}
    >
        <${Icon} name="pip" size=${22} />
        ${kept === "news" && html`<span class="pip-dot" aria-hidden="true"></span>`}
    </button>`;
}

/** PiP's panel while it is open (kept a moment after, to animate out), or its mark while it is not. */
export function PipHost() {
    // Never in both places: while PiP's conversation is in the session's place (moving from there to the corner, say),
    // the panel waits.
    const open = store.state.pipOpen && pipAvailable() && !pipBoard();
    const [kept, leaving] = usePresence(open || null, 180);
    // What a drag on the sheet dims as it goes: the scrim, not the app behind it.
    const scrim = useRef(null);

    // Back closes it, as it closes a sheet.
    useBack(Boolean(open), closePip);

    // As a board, not even the floating panel on its way out.
    if (!pipAvailable() || pipBoard()) {
        return null;
    }

    if (!kept) {
        return html`<${PipBubble} />`;
    }

    // On phones a scrim dims what is behind the sheet, and a tap on it closes it; wide screens have none.
    return html`<div
            class=${`pip-scrim ${leaving ? "leaving" : ""}`}
            ref=${scrim}
            aria-hidden="true"
            onClick=${closePip}
        ></div>
        <${PipPanel} leaving=${leaving} scrim=${scrim} />`;
}

/** PiP in the rail: the way to it that is always there, marked while it works or has something new. */
export function PipRailButton() {
    if (!pipAvailable()) {
        return null;
    }

    const { pip } = store.state;
    const pipOpen = pipShown();
    const unread = pipUnread();

    return html`<button
        class=${`rail-button rail-pip ${pip?.busy ? "lit" : ""} ${pipOpen ? "open" : ""}`}
        data-part="rail-button"
        data-state=${railState(pipOpen, Boolean(pip?.busy))}
        title="PiP, your assistant (Alt+A)"
        aria-label=${["PiP", pip?.busy && "working", unread && "something new"].filter(Boolean).join(", ")}
        aria-pressed=${pipOpen}
        onClick=${togglePip}
    >
        <${Icon} name="pip" size=${18} />
        ${unread && html`<span class="rail-news" aria-hidden="true"></span>`}
    </button>`;
}
