// PiP, "Pi in Pocket": the owner's assistant, in a small window over whatever is open. It stays out of the way until
// called: Alt+A, the rail's PiP button, the places, the launcher, or `/pip`; and a small mark in the corner shows only
// while PiP works, or has something new. The panel watches PiP's conversation through a view of its own (`pipview`
// events), so the session behind it stays as it was.
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { useBack } from "./back.js";
import { useDragToClose } from "./gestures.js";
import { api, attempt, isRow, navigate, notify, store, uid } from "./store.js";
import { itemsOf, says, summarize } from "./turns.js";
import {
    contextLevel,
    formatTokens,
    html,
    Icon,
    Markdown,
    readable,
    Spinner,
    usePresence,
} from "./ui.js";
import { MicButton, useDictation } from "./voice.js";

const OPEN_KEY = "pocket.pip";
const SEEN_KEY = "pocket.pip.seen";
const DRAFT_KEY = "pocket.pip.draft";
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

// A reconnect (or the first connection, with the panel kept open across a reload) gets the panel's view again; PiP
// turned off in Extensions closes the panel.
store.subscribe((state) => {
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
        !state.pipOpen &&
        !pip.busy &&
        pip.endedAt !== undefined &&
        pip.endedAt > Number(localStorage.getItem(SEEN_KEY) ?? 0),
    );
}

/** Open the panel; with `text`, put it in PiP's message box. */
export function openPip(text) {
    if (!pipAvailable()) {
        return;
    }

    if (text) {
        store.set({ pipDraft: { text, n: (store.state.pipDraft?.n ?? 0) + 1 } });
    }

    if (store.state.pipOpen) {
        focusComposer();

        return;
    }

    sessionStorage.setItem(OPEN_KEY, "1");
    // The subscriber above tells the server, from inside this `set`: once, not twice.
    store.set({ pipOpen: true, launcher: false, drawer: false });
}

export function closePip() {
    if (!store.state.pipOpen) {
        return;
    }

    sessionStorage.removeItem(OPEN_KEY);
    markSeen();
    store.set({ pipOpen: false });
    tellServer(false);
}

export const togglePip = () => (store.state.pipOpen ? closePip() : openPip());

/** Send PiP a message from anywhere (`/pip …`), and open the panel to show what it says. */
export async function askPip(text) {
    if (!pipAvailable()) {
        notify("error", "PiP is not on here.");

        return;
    }

    openPip();
    const pip = store.state.pip ?? (await opening);

    if (!pip) {
        notify("error", "PiP is not ready yet: your message waits in its box.");
    }

    // Not sent: the words wait in PiP's box rather than be lost (`send` said why), after what was there already.
    if (!pip || !(await send(pip.id, text, false))) {
        const draft = localStorage.getItem(DRAFT_KEY)?.trim();

        openPip(draft ? `${draft}\n\n${text}` : text);
    }
}

/** Send PiP a message; false when it did not go (a notice says why). PiP made just now is waited for. */
async function send(id, text, busy) {
    const target = id ?? store.state.pip?.id ?? (await opening)?.id;

    if (target === undefined) {
        notify("error", "PiP is not ready yet. Try again in a moment.");

        return false;
    }

    const sent = await attempt(() =>
        api(`c/${target}/submit`, {
            text,
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

/** How full PiP's context is, as the status line shows a session's; its title says when PiP compacts itself. */
function PipContext({ stats, window }) {
    if (!window || stats?.contextTokens === undefined) {
        return null;
    }

    const used = stats.contextTokens;
    const percent = Math.min(100, Math.round((used / window) * 100));
    const at = store.state.server?.pipCompactAt;
    const about = stats.contextEstimated ? "~" : "";
    const tokens = `${about}${formatTokens(used)} of ${formatTokens(window)} tokens in PiP's context.`;
    const when =
        at > 0
            ? `PiP compacts itself above ${formatTokens(at)} once idle.`
            : "Compact it when it grows.";
    const title = `${tokens} ${when}`;

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

function focusComposer() {
    requestAnimationFrame(() => document.querySelector(".pip-composer textarea")?.focus());
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
function Report({ text, label = "Report", data = null }) {
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
        <${Markdown} text=${linkSessions(text)} class="pip-report-text" />
        ${data !== null && html`<pre class="pip-report-data">${data}</pre>`}
    </div>`;
}

/** One of the panel's rows: a message, a report, a group of PiP's calls, or its words. */
function Item({ item, last, busy }) {
    if (item.type === "row") {
        const entry = item.entry;

        if (entry.kind === "user") {
            const text = written(entry.text);

            if (text.startsWith(REPORT)) {
                return html`<${Report} text=${text.slice(REPORT.length)} />`;
            }

            const hook = WEBHOOK.exec(text);
            const watched = hook ? null : REPO_WATCH.exec(text);
            const outside = hook ?? watched;

            if (outside) {
                const posted = post(text.slice(outside[0].length));

                return html`<${Report}
                    label=${`${watched ? "GitHub" : "Webhook"}: ${outside[1]}`}
                    text=${posted.text}
                    data=${posted.data}
                />`;
            }

            if (text.startsWith(SCHEDULED)) {
                return html`<div class="pip-event">
                    <${Icon} name="pulse" size=${13} />
                    <span>${text.slice(SCHEDULED.length)}</span>
                </div>`;
            }

            return html`<div class="pip-you">${text}</div>`;
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

    if (item.type === "activity") {
        const thinking =
            item.steps.at(-1)?.streaming && item.steps.at(-1).block.type === "thinking";
        const working = busy && last;

        return html`<div class=${`pip-steps ${working ? "working" : ""}`}>
            ${working ? html`<${Spinner} hidden=${true} />` : html`<span class="pip-tick">·</span>`}
            <span>${summarize(item.steps, thinking)}</span>
        </div>`;
    }

    if (item.type === "reply") {
        const text = item.blocks.map((each) => each.block.text).join("\n\n");
        const growing = item.blocks.some((each) => each.growing);
        const entry = item.entry;

        return html`<div class="pip-reply">
            ${text.trim() !== "" && html`<${Markdown} text=${linkSessions(text)} cache=${!growing} />`}
            ${entry?.stopReason === "aborted" && html`<div class="pip-event"><span>Stopped</span></div>`}
            ${
                entry?.stopReason === "error" &&
                html`<div class="pip-error">${entry.error ?? "The model request failed."}</div>`
            }
        </div>`;
    }

    return null;
}

function Welcome({ id, name }) {
    const first = (name ?? "").split(/\s+/)[0];

    return html`<div class="pip-welcome">
        <p class="pip-hello">Hi${first ? ` ${first}` : ""}. I’m PiP.</p>
        <p class="pip-intro">${INTRO}</p>
        <div class="pip-chips">
            ${SUGGESTIONS.map(
                (suggestion) => html`<button
                    type="button"
                    class="pip-chip"
                    key=${suggestion}
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

function Composer({ id, busy }) {
    const [text, setText] = useState(() => localStorage.getItem(DRAFT_KEY) ?? "");
    const ref = useRef(null);
    const draft = store.state.pipDraft;

    const fit = () => {
        const box = ref.current;

        if (box) {
            box.style.height = "auto";
            box.style.height = `${Math.min(box.scrollHeight, 160)}px`;
        }
    };

    const change = (value) => {
        setText(value);

        if (value === "") {
            localStorage.removeItem(DRAFT_KEY);
        } else {
            localStorage.setItem(DRAFT_KEY, value);
        }
    };

    // PiP's box takes Alt+V while it shows, over the session's.
    const dictation = useDictation(ref, change, { top: true });

    useLayoutEffect(fit, [text]);
    // A phone's keyboard would cover the panel as it opens: there, the box waits for a tap. Elsewhere it takes the focus
    // as it mounts, in the same task as the key that opened it, so the next keys land here.
    useLayoutEffect(() => {
        if (!NARROW.matches) {
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

    const submit = async (event) => {
        event?.preventDefault();
        const message = text.trim();

        if (message === "") {
            return;
        }

        // What shows is what goes: words still coming would land in the emptied box.
        dictation.stop(true);
        change("");

        const compact = COMPACT.exec(message);

        // A command for the panel, not words for PiP.
        if (compact) {
            if ((await compactPip(id, compact[1]?.trim())) === undefined) {
                change(message);
            }

            return;
        }

        // Not sent: the words come back to the box, rather than be lost.
        if (!(await send(id, message, busy))) {
            change(message);
        }
    };

    return html`<form class="pip-composer" onSubmit=${submit}>
        <textarea
            ref=${ref}
            rows="1"
            value=${text}
            placeholder=${dictation.listening ? "Listening…" : busy ? "Tell PiP more…" : "Ask PiP…"}
            aria-label="Message to PiP"
            enterkeyhint="send"
            onInput=${(event) => change(event.currentTarget.value)}
            onKeyDown=${(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
                    submit(event);
                }
            }}
        ></textarea>
        <${MicButton} dictation=${dictation} class="pip-mic" size=${18} />
        ${
            busy && text.trim() === ""
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
                      aria-label="Send to PiP"
                      disabled=${text.trim() === ""}
                  >
                      <${Icon} name="send" size=${18} />
                  </button>`
        }
    </form>`;
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
    // Calls of PiP's held for approval: the panel cannot answer them, so it says so and leads to where they can be.
    const waiting = ready ? (view.approvals ?? []) : [];
    const compacting = ready && (live.compactions ?? []).length > 0;
    const status =
        waiting.length > 0 ? "needs you" : compacting ? "compacting…" : busy ? "working…" : "";
    // Where the focus was before the panel: read as it first renders, before its box takes the focus.
    const [before] = useState(() => document.activeElement);

    useDragToClose(ref, { dir: "down", onClose: closePip, enabled: NARROW.matches, scrim });
    // Focus goes back where it was when the panel closes.
    useEffect(
        () => () => {
            if (before instanceof HTMLElement && before.isConnected) {
                before.focus({ preventScroll: true });
            }
        },
        [],
    );
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
        ref=${ref}
        role="dialog"
        aria-modal=${NARROW.matches ? "true" : undefined}
        aria-label="PiP, your assistant"
    >
        <header class="pip-head">
            <div class="grip"></div>
            <span class=${`pip-mark ${busy ? "working" : ""}`} aria-hidden="true">
                <${Icon} name="pip" size=${18} />
            </span>
            <h2>PiP</h2>
            <span class="pip-status" aria-live="polite">${status}</span>
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
            <button
                class="icon-button"
                aria-label="Open as a conversation"
                title="Open as a conversation, with every step"
                disabled=${!ready}
                onClick=${() => {
                    closePip();
                    navigate(id);
                }}
            >
                <${Icon} name="external" size=${18} />
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
                      ? html`<${Welcome} id=${id} name=${me?.name} />`
                      : items.map(
                            (item, index) =>
                                html`<${Item}
                                    key=${item.key}
                                    item=${item}
                                    last=${index === items.length - 1}
                                    busy=${busy}
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
    const [kept, leaving] = usePresence(
        pip && (pip.busy || unread) ? (pip.busy ? "busy" : "news") : null,
        150,
    );

    if (kept === null) {
        return null;
    }

    return html`<button
        class=${`pip-bubble ${kept} ${leaving ? "leaving" : ""}`}
        aria-label=${kept === "busy" ? "PiP is working: open PiP" : "PiP has something new: open PiP"}
        title="PiP (Alt A)"
        onClick=${() => openPip()}
    >
        <${Icon} name="pip" size=${22} />
        ${kept === "news" && html`<span class="pip-dot" aria-hidden="true"></span>`}
    </button>`;
}

/** PiP's panel while it is open (kept a moment after, to animate out), or its mark while it is not. */
export function PipHost() {
    const open = store.state.pipOpen && pipAvailable();
    const [kept, leaving] = usePresence(open || null, 180);
    // What a drag on the sheet dims as it goes: the scrim, not the app behind it.
    const scrim = useRef(null);

    // Back closes it, as it closes a sheet.
    useBack(Boolean(open), closePip);

    if (!pipAvailable()) {
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

    const { pip, pipOpen } = store.state;
    const unread = pipUnread();

    return html`<button
        class=${`rail-button rail-pip ${pip?.busy ? "lit" : ""} ${pipOpen ? "open" : ""}`}
        title="PiP, your assistant (Alt A)"
        aria-label=${["PiP", pip?.busy && "working", unread && "something new"].filter(Boolean).join(", ")}
        aria-pressed=${pipOpen}
        onClick=${togglePip}
    >
        <${Icon} name="pip" size=${18} />
        ${unread && html`<span class="rail-news" aria-hidden="true"></span>`}
    </button>`;
}
