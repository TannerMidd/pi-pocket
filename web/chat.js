// People working together beside Pi: who is here, who is typing, and a side panel Pi does not see, with the chat,
// pinned messages, and shared notes.

import { Component } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { Avatar, initials, personColor } from "./avatar.js";
import {
    actions,
    attempt,
    canSteer,
    chatLogShown,
    closePeople,
    closeSheet,
    collab,
    drafts,
    insertIntoComposer,
    markChatRead,
    notify,
    openSheet,
    peopleDocked,
    revealEntry,
    store,
    typing,
} from "./store.js";
import { copyText, html, Icon, Loader, Sheet, Spinner, timeAgo } from "./ui.js";

const coarse = matchMedia("(pointer: coarse)").matches;

/** Chat messages from others that this browser has not seen yet. Activity lines do not count. */
function chatUnread(state = store.state) {
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
    const unread = chatUnread();
    const docked = peopleDocked();
    const label =
        others.length === 0
            ? "Chat"
            : `Chat with ${others.map((person) => person.name).join(", ")}`;

    return html`<button
        class=${`people-button badge-host ${docked ? "on" : ""}`}
        aria-label=${label}
        aria-pressed=${docked}
        title=${label}
        onClick=${() => (docked ? closePeople() : openSheet({ type: "chat" }))}
    >
        ${
            others.length === 0
                ? html`<${Icon} name="chat" />`
                : html`<span class="avatars">
                    ${others
                        .slice(0, 3)
                        .map(
                            (person) =>
                                html`<${Avatar} key=${person.id} person=${person} size=${22} />`,
                        )}
                    ${
                        others.length > 3 &&
                        html`<span class="avatar more">+${others.length - 3}</span>`
                    }
                </span>`
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

function clock(at) {
    const date = new Date(at);
    const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

    return date.toDateString() === new Date().toDateString()
        ? time
        : `${date.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

/** Close the sheet and scroll the transcript to a message, briefly highlighted. The docked People panel stays. */
export function jumpToEntry(entryId) {
    closeSheet();
    // A message above the rows the transcript shows: show from it down. The render runs before the next frame.
    revealEntry(entryId);
    requestAnimationFrame(() => {
        const element = document.getElementById(`entry-${entryId}`);

        if (!element) {
            notify(
                "info",
                "That message is in earlier history: use “Show earlier messages” at the top.",
            );

            return;
        }

        element.scrollIntoView({ block: "center", behavior: "smooth" });
        element.classList.remove("flash");
        void element.offsetWidth;
        element.classList.add("flash");
    });
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
            class=${`chat-msg ${grouped ? "grouped" : ""} ${open ? "open" : ""} ${message.mentions?.includes(me?.id) ? "mentions-me" : ""}`}
            style=${`--who:${personColor(message.userId)}`}
        >
            ${
                !grouped &&
                html`<div class="chat-meta">
                    <span class="chat-name">${mine ? "You" : senderName(message, users)}</span>
                    <span class="muted">${clock(message.at)}</span>
                    ${pinned && html`<span class="muted">📌</span>`}
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
    const { chat, presence, me, users, conversationId, chatQuote, view } = store.state;
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
    useLayoutEffect(() => {
        const element = log.current;

        if (!element) {
            return;
        }

        const target = highlight && element.querySelector(`[data-chat="${CSS.escape(highlight)}"]`);

        if (target) {
            target.scrollIntoView({ block: "center" });
        } else {
            element.scrollTop = element.scrollHeight;
        }
    }, [newest]);
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

    return html`<div class="chat-here">
        ${presence.map(
            (person) =>
                html`<span class=${`chip ${person.away ? "away" : ""}`} key=${person.id}>
                    <${Avatar} person=${person} size=${18} /> ${person.name}
                    ${person.id === me?.id ? " (you)" : person.away ? " · away" : ""}
                </span>`,
        )}
    </div>
    <div class="chat-log" ref=${log}>
        ${
            chat.length === 0 &&
            html`<div class="muted">No messages yet. Pi does not see this chat.</div>`
        }
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
            placeholder=${collab() ? "Message the people here… @ to mention" : "Message the people here…"}
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

/** Chat, pinned, and notes: the People sheet's on phones, the People panel's on wide screens. `ask` picks what shows first. */
function PeopleTabs({ ask, focus }) {
    const { view } = store.state;
    const [tab, setTab] = useState(ask.tab ?? "chat");
    const [highlight, setHighlight] = useState(ask.highlight ?? null);
    const pins = view.pins?.length ?? 0;
    const tabs = collab()
        ? html`<div class="segmented tabs">
            <button class=${tab === "chat" ? "on" : ""} onClick=${() => setTab("chat")}>
                Chat
            </button>
            <button class=${tab === "pins" ? "on" : ""} onClick=${() => setTab("pins")}>
                Pinned${pins > 0 ? ` ${pins}` : ""}
            </button>
            <button class=${tab === "notes" ? "on" : ""} onClick=${() => setTab("notes")}>
                Notes
            </button>
        </div>`
        : null;

    return html`${tabs}
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
    ${tab === "notes" && html`<${NotesTab} />`}`;
}

export function ChatSheet() {
    // While the sheet animates out, the store has no sheet any more.
    const sheet = store.state.sheet ?? {};

    return html`<${Sheet} title="People" onClose=${closeSheet}>
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
        aria-label="People"
        inert=${leaving}
        onKeyDown=${keepEscape}
    >
        <header class="sheet-head">
            <h2>People</h2>
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
