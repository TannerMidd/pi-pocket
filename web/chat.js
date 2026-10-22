// People working together beside Pi: who is here, who is typing, and a side panel Pi does not see, with the chat,
// pinned messages, and shared notes.

import { Component } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { Avatar, initials, personColor } from "./avatar.js";
import {
    actions,
    attempt,
    canSteer,
    canToggleTurns,
    chatLogShown,
    closePeople,
    closeSheet,
    collab,
    drafts,
    insertIntoComposer,
    isLoaded,
    loadEarlier,
    markChatRead,
    notify,
    openSheet,
    peopleDocked,
    revealEntry,
    store,
    typing,
} from "./store.js";
import { clockTime, copyText, html, Icon, Loader, Sheet, Spinner, timeAgo } from "./ui.js";

const coarse = matchMedia("(pointer: coarse)").matches;

/** Chat messages from others that this browser has not seen yet. Activity lines do not count. */
export function chatUnread(state = store.state) {
    return state.chat.filter(
        (message) =>
            message.kind !== "event" &&
            message.userId !== state.me?.id &&
            message.at > state.chatRead,
    ).length;
}

/** The current name of whoever sent a message, or the name they had when they sent it. */
function senderName(message, users) {
    return users.find((user) => user.id === message.userId)?.name ?? message.name;
}

/** Top bar: the other people in this session, and the chat with its unread count. Shows and hides the People panel. */
export function PeopleButton() {
    const { presence, me, server } = store.state;

    if (!server?.chat) {
        return null;
    }

    const others = presence.filter((person) => person.id !== me?.id);
    // The one shown: someone looking now, if anyone is.
    const shown = others.find((person) => !person.away) ?? others[0];
    const unread = chatUnread();
    const docked = peopleDocked();
    const label =
        others.length === 0
            ? "Chat"
            : `Chat with ${others.map((person) => person.name).join(", ")}`;

    // Quiet with no one else here and nothing unread, unless the panel is open: the menu has the chat.
    return html`<button
        class=${`people-button badge-host ${docked ? "on" : ""} ${others.length === 0 && unread === 0 && !docked ? "quiet" : ""}`}
        aria-label=${label}
        aria-pressed=${docked}
        title=${label}
        onClick=${() => (docked ? closePeople() : openSheet({ type: "chat" }))}
    >
        ${
            others.length === 0
                ? html`<${Icon} name="chat" />`
                : html`<span class="people-here">
                      <${Avatar} person=${shown} size=${28} />
                      <span
                          class=${`online-mark ${shown.away ? "away" : ""}`}
                          aria-hidden="true"
                      ></span>
                  </span>
                  ${others.length > 1 && html`<span class="people-more">+${others.length - 1}</span>`}`
        }
        ${unread > 0 && html`<span class="badge">${unread}</span>`}
    </button>`;
}

function typingText(people, where, me) {
    const names = people
        .filter((person) => person.typing === where && person.id !== me?.id)
        .map((person) => person.name);

    if (names.length === 0) {
        return null;
    }

    const who =
        names.length === 1
            ? names[0]
            : names.length === 2
              ? `${names[0]} and ${names[1]}`
              : `${names.length} people`;

    return `${who} ${names.length === 1 ? "is" : "are"} ${where === "pi" ? "writing to Pi" : "typing"}…`;
}

/** "Alex is writing to Pi…" above the message box, or "Alex is typing…" in the chat. */
export function TypingLine({ where }) {
    const { presence, me } = store.state;
    const text = typingText(presence, where, me);

    if (!text) {
        return null;
    }

    return html`<div class="typing-line" aria-live="polite">
        <span class="typing-dots"><span></span><span></span><span></span></span>
        ${text}
    </div>`;
}

const clock = (at) => clockTime(new Date(at));

/** The newest jump: an earlier one still loading gives way to it. */
let jumps = 0;

/**
 * Close the sheet and scroll the transcript to a message, briefly highlighted. The docked People panel stays. Resolves
 * true once it shows, false when it cannot: not in the session's transcript, the session changed, or a newer jump came.
 * `quiet` leaves the "earlier history" notice to the caller (`pocket.reveal`).
 */
export function jumpToEntry(entryId, { quiet = false } = {}) {
    closeSheet();
    const jump = ++jumps;
    const { view, conversationId } = store.state;
    const current = () => jump === jumps && store.state.conversationId === conversationId;

    // In the session but not loaded yet (a view brings only the newest): load back to it first.
    if (view.order.includes(entryId) && !isLoaded(view, entryId)) {
        return loadEarlier({ from: entryId }).then(
            () => current() && isLoaded(store.state.view, entryId) && show(entryId, jump, quiet),
            (error) => {
                notify("error", error.message ?? String(error));

                return false;
            },
        );
    }

    return show(entryId, jump, quiet);
}

/** The scroll and flash of a jump, once the entry is loaded. */
function show(entryId, jump, quiet) {
    // A message above the rows the transcript shows: show from it down. The render runs before the next frame.
    revealEntry(entryId);
    // An answer of only tool calls is a mark in a group of Pi's calls: the group opens (transcript.js).
    document.dispatchEvent(new CustomEvent("pocket:reveal", { detail: entryId }));

    return new Promise((resolve) =>
        requestAnimationFrame(() => {
            const found = document.getElementById(`entry-${entryId}`);

            if (jump !== jumps) {
                return resolve(false);
            }

            if (!found) {
                if (!quiet) {
                    notify(
                        "info",
                        "That message is in earlier history: use “Show earlier messages” at the top.",
                    );
                }

                return resolve(false);
            }

            // The mark has no size: its group's line is what shows.
            const element = found.classList.contains("entry-anchor")
                ? (found.closest(".activity")?.querySelector(".activity-head") ?? found)
                : found;

            // A long one from its top, where it starts: centered, its middle would show, and what was found may be above.
            const tall = element.getBoundingClientRect().height > innerHeight / 2;
            const still = document.documentElement.dataset.motion === "reduced";

            element.scrollIntoView({
                block: tall ? "start" : "center",
                behavior: still ? "auto" : "smooth",
            });
            element.classList.remove("flash");
            void element.offsetWidth;
            element.classList.add("flash");
            resolve(true);
        }),
    );
}

/** Chat text with `@Name` mentions of known people highlighted (and the reader's own name more so). */
function MessageText({ text, mentions, users, me }) {
    const named = users
        .filter((user) => mentions?.includes(user.id))
        .sort((a, b) => b.name.length - a.name.length);

    if (named.length === 0) {
        return text;
    }

    const parts = [];
    let rest = text;

    while (rest.length > 0) {
        const lower = rest.toLowerCase();
        let best = null;

        for (const user of named) {
            const at = lower.indexOf(`@${user.name.toLowerCase()}`);

            if (at !== -1 && (best === null || at < best.at)) {
                best = { at, user };
            }
        }

        if (best === null) {
            parts.push(rest);
            break;
        }

        parts.push(rest.slice(0, best.at));
        const length = best.user.name.length + 1;

        parts.push(
            html`<span class=${`mention ${best.user.id === me?.id ? "me" : ""}`}>
                ${rest.slice(best.at, best.at + length)}
            </span>`,
        );
        rest = rest.slice(best.at + length);
    }

    return parts;
}

/**
 * One line of the chat log. The whole app renders again on every update while Pi streams; a line renders again only
 * when something it shows changed, so a long chat stays light.
 */
class ChatLine extends Component {
    shouldComponentUpdate(next) {
        const now = this.props;

        return !["message", "grouped", "open", "pinned", "users", "me", "steer"].every(
            (key) => now[key] === next[key],
        );
    }

    render({ message, grouped, open, pinned, users, me, steer, onSelect }) {
        if (message.kind === "event") {
            return html`<div class="chat-event">
                <span style=${`color:${personColor(message.userId)}`}>${message.userId === me?.id ? "You" : senderName(message, users)}</span> ${message.text} · ${clock(message.at)}
            </div>`;
        }

        const mine = message.userId === me?.id;

        return html`<div
            data-chat=${message.id}
            class=${`chat-msg ${mine ? "mine" : ""} ${grouped ? "grouped" : ""} ${open ? "open" : ""} ${message.mentions?.includes(me?.id) ? "mentions-me" : ""}`}
            style=${`--who:${personColor(message.userId)}`}
        >
            ${
                !grouped &&
                html`<div class="chat-meta">
                    <span class="chat-name">${mine ? "You" : senderName(message, users)}</span>
                    <span class="muted">${clock(message.at)}</span>
                    ${pinned && html`<${Icon} name="pin" size=${11} class="muted" />`}
                </div>`
            }
            ${
                message.quote &&
                html`<button class="chat-quote" onClick=${() => jumpToEntry(message.quote.entryId)}>
                    ${message.quote.text}
                </button>`
            }
            <div class="chat-text" onClick=${() => collab() && onSelect(open ? null : message.id)}>
                <${MessageText}
                    text=${message.text}
                    mentions=${message.mentions}
                    users=${users}
                    me=${me}
                />
            </div>
            ${
                open &&
                html`<div class="chat-actions">
                    ${
                        steer &&
                        html`<button
                            class="link small"
                            onClick=${() => insertIntoComposer(`> ${senderName(message, users)}: ${message.text.replace(/\n/g, "\n> ")}\n\n`)}
                        >
                            Send to Pi
                        </button>`
                    }
                    <button
                        class="link small"
                        onClick=${() => attempt(() => actions.pin({ chatId: message.id }))}
                    >
                        ${pinned ? "Unpin" : "Pin"}
                    </button>
                    <button
                        class="link small"
                        onClick=${() =>
                            copyText(message.text).then(
                                () => notify("info", "Copied."),
                                () => notify("error", "Could not copy."),
                            )}
                    >
                        Copy
                    </button>
                </div>`
            }
        </div>`;
    }
}

/** The `@query` being typed right before the caret, if any. */
function mentionQuery(value, caret) {
    const before = value.slice(0, caret);
    const match = /(^|\s)@([^\s@]{0,30})$/.exec(before);

    return match ? { query: match[2], start: caret - match[2].length - 1 } : null;
}

/** The chat. `focus` puts the caret in its box on desktops: not when a reload brings back the People panel. */
function ChatTab({ highlight, focus }) {
    const { chat, me, users, conversationId, chatQuote, view } = store.state;
    const draftKey = `chat-${conversationId}`;
    const [text, setText] = useState(() => drafts.get(draftKey));
    const [sending, setSending] = useState(false);
    const [selected, setSelected] = useState(highlight ?? null);
    const [mention, setMention] = useState(null);
    const log = useRef(null);
    const box = useRef(null);
    const pinned = new Set((view.pins ?? []).map((pin) => pin.chatId).filter(Boolean));

    // The newest message, not the count: the chat keeps its last 500, so the count stops changing.
    const newest = chat.at(-1)?.id;

    useEffect(() => markChatRead(), [newest]);
    useEffect(() => chatLogShown(), []);
    // Whether the log follows its newest message, and where it last put itself: a scroll to anywhere else is the reader's.
    const follow = useRef({ on: !highlight, at: -1 });

    const stick = () => {
        const element = log.current;

        if (element && follow.current.on) {
            element.scrollTop = element.scrollHeight;
            follow.current.at = element.scrollTop;
        }
    };

    useLayoutEffect(() => {
        const element = log.current;

        if (!element) {
            return;
        }

        const target = highlight && element.querySelector(`[data-chat="${CSS.escape(highlight)}"]`);

        if (target) {
            follow.current.on = false;
            target.scrollIntoView({ block: "center" });
        } else {
            follow.current.on = true;
            stick();
        }
    }, [newest]);
    // Following, it stays at the bottom while things settle: the panel opening, a pin showing above it, the box under it
    // growing, a message taking its room.
    useEffect(() => {
        const element = log.current;

        if (!element) {
            return undefined;
        }

        const onScroll = () => {
            // Its own scroll, or the browser holding it at the end as the log grew: still following.
            if (Math.abs(element.scrollTop - follow.current.at) <= 1) {
                return;
            }

            follow.current.on =
                element.scrollHeight - element.scrollTop - element.clientHeight < 24;
        };

        const sizes = new ResizeObserver(stick);

        const watch = () => {
            for (const child of element.children) {
                sizes.observe(child);
            }

            stick();
        };

        const children = new MutationObserver(watch);

        element.addEventListener("scroll", onScroll, { passive: true });
        sizes.observe(element);
        children.observe(element, { childList: true });
        watch();

        return () => {
            element.removeEventListener("scroll", onScroll);
            sizes.disconnect();
            children.disconnect();
        };
    }, []);
    useEffect(() => {
        if (focus && !coarse) {
            box.current?.focus();
        }

        return () => typing(null);
    }, []);
    useEffect(() => {
        const element = box.current;

        if (!element) {
            return;
        }

        element.style.height = "auto";
        element.style.height = `${Math.min(element.scrollHeight, innerHeight * 0.3)}px`;
    }, [text]);

    const update = (value, caret = value.length) => {
        setText(value);
        drafts.set(draftKey, value);
        typing(value.trim() === "" ? null : "chat");
        setMention(collab() ? mentionQuery(value, caret) : null);
    };

    const candidates = mention
        ? users
              .filter(
                  (user) =>
                      user.id !== me?.id &&
                      user.name.toLowerCase().includes(mention.query.toLowerCase()),
              )
              .slice(0, 5)
        : [];

    const pick = (user) => {
        const element = box.current;
        const caret = element?.selectionStart ?? text.length;
        const value = `${text.slice(0, mention.start)}@${user.name} ${text.slice(caret)}`;

        update(value, mention.start + user.name.length + 2);
        setMention(null);
        requestAnimationFrame(() => {
            element?.focus();
            const at = mention.start + user.name.length + 2;

            element?.setSelectionRange(at, at);
        });
    };

    const send = async () => {
        if (text.trim() === "" || sending) {
            return;
        }

        setSending(true);
        const ok = await attempt(() => actions.chat(text, chatQuote));

        setSending(false);

        if (ok) {
            update("");
            store.set({ chatQuote: null });

            if (!coarse) {
                box.current?.focus();
            }
        }
    };

    return html`<div class="chat-label">
        <${Icon} name="eye" size=${12} />Side chat · Pi does not see this chat.
    </div>
    <div class="chat-log" ref=${log}>
        ${chat.length === 0 && html`<div class="muted">No messages yet.</div>`}
        ${chat.map((message, index) => {
            const previous = chat[index - 1];
            const grouped =
                message.kind !== "event" &&
                previous?.kind !== "event" &&
                previous?.userId === message.userId &&
                message.at - previous.at < 5 * 60_000 &&
                !message.quote;

            return html`<${ChatLine}
                key=${message.id}
                message=${message}
                grouped=${grouped}
                open=${selected === message.id}
                pinned=${pinned.has(message.id)}
                users=${users}
                me=${me}
                steer=${canSteer()}
                onSelect=${setSelected}
            />`;
        })}
    </div>
    <${TypingLine} where="chat" />
    ${
        chatQuote &&
        html`<div class="quote-draft">
            <span class="muted small">Discussing</span> <span class="quote-text">${chatQuote.text}</span>
            <button
                class="icon-button small"
                aria-label="Stop quoting"
                onClick=${() => store.set({ chatQuote: null })}
            >
                <${Icon} name="close" size=${12} />
            </button>
        </div>`
    }
    ${
        candidates.length > 0 &&
        html`<div class="mention-list">
            ${candidates.map(
                (user) =>
                    html`<button
                        class="list-item"
                        onMouseDown=${(event) => event.preventDefault()}
                        onClick=${() => pick(user)}
                    >
                        <span>
                            <span class="avatar" style=${`--who:${personColor(user.id)};width:20px;height:20px`}>${initials(user.name)}</span> ${user.name}
                        </span>
                        <span class="muted small">${user.online ? "online" : ""}</span>
                    </button>`,
            )}
        </div>`
    }
    <div class="chat-compose">
        <textarea
            ref=${box}
            rows="1"
            maxlength="4000"
            value=${text}
            placeholder=${collab() ? "Message… @ to mention" : "Message the people here…"}
            onInput=${(event) => update(event.currentTarget.value, event.currentTarget.selectionStart)}
            onKeyDown=${(event) => {
                if (
                    candidates.length > 0 &&
                    (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey))
                ) {
                    event.preventDefault();
                    pick(candidates[0]);

                    return;
                }

                if (event.key === "Escape" && mention) {
                    event.stopPropagation();
                    setMention(null);

                    return;
                }

                if (event.key === "Enter" && !event.shiftKey && !coarse && !event.isComposing) {
                    event.preventDefault();
                    send();
                }
            }}
            enterkeyhint=${coarse ? "enter" : "send"}
        ></textarea>
        <button
            class="round send"
            aria-label="Send"
            disabled=${text.trim() === "" || sending}
            onClick=${send}
        >
            ${sending ? html`<${Spinner} />` : html`<${Icon} name="send" size=${18} />`}
        </button>
    </div>`;
}

function PinsTab({ onShowChat }) {
    const { view, users } = store.state;
    const pins = [...(view.pins ?? [])].reverse();
    const by = (id) => users.find((user) => user.id === id)?.name ?? "someone";

    if (pins.length === 0) {
        return html`<p class="muted">
            Nothing pinned yet. Pin a reply of Pi's or a chat message to keep it at hand for everyone here.
        </p>`;
    }

    return html`<div class="pin-list">
        ${pins.map(
            (pin) => html`<div class="pin" key=${pin.id}>
                <button
                    class="pin-main"
                    onClick=${() => (pin.entryId !== undefined ? jumpToEntry(pin.entryId) : onShowChat(pin.chatId))}
                >
                    <div class="pin-meta">
                        <span
                            class="chat-name"
                            style=${`--who:${pin.author === "Pi" ? "var(--brand)" : personColor(users.find((user) => user.name === pin.author)?.id ?? pin.author)}`}
                        >
                            ${pin.author}
                        </span>
                        <span class="muted">
                            ${pin.chatId ? "in chat" : "in the conversation"} · pinned by ${by(pin.by)} ${timeAgo(pin.at)}
                        </span>
                    </div>
                    <div class="pin-text">${pin.text}</div>
                </button>
                <button
                    class="icon-button small"
                    title="Unpin"
                    aria-label="Unpin"
                    onClick=${() => attempt(() => actions.pin(pin.entryId !== undefined ? { entryId: pin.entryId } : { chatId: pin.chatId }))}
                >
                    <${Icon} name="close" size=${12} />
                </button>
            </div>`,
        )}
    </div>`;
}

function NotesTab() {
    const { notes, users } = store.state;
    const [draft, setDraft] = useState(null);
    const [base, setBase] = useState(notes?.rev ?? 0);
    const [saving, setSaving] = useState(false);

    if (notes === null) {
        return html`<${Loader} label="Loading notes" />`;
    }

    const editing = draft !== null;
    const changedMeanwhile = editing && notes.rev !== base;
    const by = notes.by ? (users.find((user) => user.id === notes.by)?.name ?? "someone") : null;

    const save = async (rev = base) => {
        setSaving(true);
        const saved = await attempt(() => actions.saveNotes(draft, rev));

        setSaving(false);

        if (saved) {
            setDraft(null);
            setBase(saved.rev);
        }
    };

    return html`<p class="muted small">
        One page of notes for everyone here: the plan, decisions, who does what. Pi does not see it unless you send it.
    </p>
    ${
        changedMeanwhile &&
        html`<div class="error-box small">
            ${by ?? "Someone"} saved the notes while you were editing.
            <button
                class="link small"
                onClick=${() => {
                    setDraft(null);
                    setBase(notes.rev);
                }}
            >
                Use theirs
            </button> · <button class="link small" onClick=${() => save(notes.rev)}>Keep mine</button>
        </div>`
    }
    <textarea
        class="notes"
        rows="10"
        value=${editing ? draft : notes.text}
        placeholder="Write the plan here…"
        onInput=${(event) => {
            if (!editing) {
                setBase(notes.rev);
            }

            setDraft(event.currentTarget.value);
        }}
    ></textarea>
    <div class="row">
        <span class="muted small grow">
            ${by ? `Saved by ${by} ${timeAgo(notes.at)}` : "Not saved yet"}
            ${editing ? " · unsaved changes" : ""}
        </span>
        ${
            canSteer() &&
            notes.text &&
            !editing &&
            html`<button
                class="button small"
                onClick=${() => insertIntoComposer(`Shared notes:\n\n${notes.text}\n\n`)}
            >
                Send to Pi
            </button>`
        }
        ${
            editing &&
            html`<button class="button small ghost" onClick=${() => setDraft(null)}>Cancel</button>`
        }
        <button
            class="button small primary"
            disabled=${!editing || saving || changedMeanwhile}
            onClick=${() => save()}
        >
            ${saving ? "Saving…" : "Save"}
        </button>
    </div>`;
}

/** The session's people and the same take-turns shortcut as the menu, with its driver permissions. */
function PeopleRoster() {
    const { presence, users, me, view } = store.state;
    const turns = view.turns;
    const driver = users.find((person) => person.id === turns?.driver)?.name ?? "No one";
    const canToggle = canToggleTurns();

    return html`<div class="people-roster">
        ${presence.map((person) => {
            const role = users.find((user) => user.id === person.id)?.role;
            const writing = person.typing && person.id !== me?.id;
            const state = writing
                ? person.typing === "pi"
                    ? "writing to Pi…"
                    : "typing…"
                : person.away
                  ? "away"
                  : person.id === me?.id
                    ? "here · you"
                    : "here";
            const roleLabel =
                role === "owner" ? "owner" : role === "viewer" ? "view only" : "can steer";

            return html`<div class="people-person" key=${person.id}>
                <span class="people-here">
                    <${Avatar} person=${person} size=${28} />
                    <span
                        class=${`online-mark ${person.away ? "away" : ""}`}
                        aria-hidden="true"
                    ></span>
                </span>
                <span class="people-person-info">
                    <span class="people-person-name">${person.name}</span>
                    <span class=${`people-person-state ${writing ? "typing" : ""}`}>
                        ${state}
                    </span>
                </span>
                <span class="people-role">${roleLabel}</span>
            </div>`;
        })}
    </div>
    ${
        collab() &&
        html`<div class="people-turns">
            <span class="grow">
                <span class="people-turns-title">
                    ${turns?.on ? `${driver} is driving` : "Take turns"}
                </span>
                <span class="people-turns-hint">
                    ${turns?.on ? "Only the driver can send to Pi" : "One person drives Pi at a time"}
                </span>
            </span>
            ${
                canToggle &&
                html`<button
                    class=${`button small ${turns?.on ? "" : "primary"}`}
                    onClick=${() => attempt(() => actions.turns(turns?.on ? "off" : "on"))}
                >
                    ${turns?.on ? "Turn off" : "Start"}
                </button>`
            }
        </div>`
    }`;
}

/** Chat, pinned, and notes: the People sheet's on phones, the People panel's on wide screens. `ask` picks what shows first. */
function PeopleTabs({ ask, focus }) {
    const { view, users } = store.state;
    const featured = view.pins?.at(-1);
    const pinnedBy = users.find((user) => user.id === featured?.by)?.name ?? "someone";
    const [tab, setTab] = useState(ask.tab ?? "chat");
    const [highlight, setHighlight] = useState(ask.highlight ?? null);
    const pins = view.pins?.length ?? 0;
    // Messages arriving while another tab is open: the top bar's badge counts them, and so does the tab.
    const unread = tab === "chat" ? 0 : chatUnread();
    const tabs = collab()
        ? html`<div class="segmented tabs">
            <button class=${tab === "chat" ? "on" : ""} onClick=${() => setTab("chat")}>
                Chat${unread > 0 ? ` ${unread}` : ""}
            </button>
            <button class=${tab === "pins" ? "on" : ""} onClick=${() => setTab("pins")}>
                Pinned${pins > 0 ? ` ${pins}` : ""}
            </button>
            <button class=${tab === "notes" ? "on" : ""} onClick=${() => setTab("notes")}>
                Notes
            </button>
        </div>`
        : null;

    return html`<div class="people-content">
        <${PeopleRoster} />
        ${tabs}
        ${
            tab === "chat" &&
            featured &&
            html`<button
                class="people-pin"
                onClick=${() => (featured.entryId !== undefined ? jumpToEntry(featured.entryId) : setHighlight(featured.chatId))}
            >
                <${Icon} name="pin" size=${13} />
                <span><b>Pinned by ${pinnedBy}</b> · ${featured.text}</span>
            </button>`
        }
        ${
            tab === "chat" &&
            html`<${ChatTab} key=${highlight ?? "chat"} highlight=${highlight} focus=${focus} />`
        }
        ${
            tab === "pins" &&
            html`<${PinsTab}
                onShowChat=${(chatId) => {
                    setHighlight(chatId);
                    setTab("chat");
                }}
            />`
        }
        ${tab === "notes" && html`<${NotesTab} />`}
    </div>`;
}

export function ChatSheet() {
    // While the sheet animates out, the store has no sheet any more.
    const sheet = store.state.sheet ?? {};

    return html`<${Sheet}
        title="People"
        className="people-sheet"
        onClose=${closeSheet}
        actions=${html`<span class="people-count">${store.state.presence.length}</span>`}
    >
        <${PeopleTabs} ask=${sheet} focus=${true} />
    <//>`;
}

/** Esc in the panel leaves its field, and never counts toward the two that stop Pi. */
function keepEscape(event) {
    if (event.key !== "Escape" || event.defaultPrevented) {
        return;
    }

    event.preventDefault();

    if (event.currentTarget.contains(document.activeElement)) {
        document.activeElement.blur();
    }
}

/** The last request to show the People panel that it answered. Outlives the panel: coming back to it is no request. */
let answeredAsk = 0;

/**
 * Wide screens: the People sheet as a window of its own beside the conversation, sliding in from the right. Each request
 * to show it (a pin, a link, Discuss) starts it afresh on what it asked for, with the caret in the chat; another session,
 * or the panel coming back after the home screen or a narrow window, starts it afresh too, but leaves the caret be.
 */
export function PeoplePanel({ leaving = false }) {
    const { peopleAsk, conversationId } = store.state;
    const focus = peopleAsk.n > answeredAsk;

    useEffect(() => {
        answeredAsk = peopleAsk.n;
    });

    return html`<section
        class=${`people window ${leaving ? "leaving" : ""}`}
        data-part="people-panel"
        data-state=${leaving ? "closing" : undefined}
        aria-label="People"
        inert=${leaving}
        onKeyDown=${keepEscape}
    >
        <header class="people-head">
            <h2>People</h2>
            <span class="people-count">${store.state.presence.length}</span>
            <button
                class="icon-button"
                aria-label="Close the People panel"
                title="Close"
                onClick=${closePeople}
            >
                <${Icon} name="close" />
            </button>
        </header>
        <div class="sheet-body">
            <${PeopleTabs}
                key=${`${conversationId}:${peopleAsk.n}`}
                ask=${peopleAsk}
                focus=${focus}
            />
        </div>
    </section>`;
}
