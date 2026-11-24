// Links between linked sessions, above the transcript. Only the server's list for this person may name one.
import { useState } from "preact/hooks";
import { navigate, store } from "./store.js";
import { html, Icon } from "./ui.js";
import { t } from "./ui-locale.js";

/** Links shown before the rest fold into "+N more": a coordinator's transcript stays near the top on a phone. */
const SHOWN = 3;

/** The two links a session can have: a key and its English, looked up as they draw. */
const LINKS = {
    started: ["web.linked-sessions.linked-sessions.text.started", "Started from: {title}"],
    linked: ["web.linked-sessions.linked-sessions.text.linked-session", "Linked session: {title}"],
};

export function LinkedSessions() {
    const { conversationId, sessions, sessionsLoaded } = store.state;
    // Unfolded for one session: another one opens folded.
    const [openFor, setOpenFor] = useState(null);
    const open = openFor === conversationId;

    if (!sessionsLoaded) {
        return null;
    }

    const current = sessions.find((session) => session.id === conversationId);
    const origin =
        current?.linkedFrom && sessions.find((session) => session.id === current.linkedFrom.id);
    const started = sessions.filter((session) => session.linkedFrom?.id === conversationId);

    if (!origin && !current?.linkedOrigin && !current?.linkedFrom && started.length === 0) {
        return null;
    }

    // A session that has no title yet still needs a name in the link.
    const titleOf = (session) =>
        session.title ?? t("web.linked-sessions.linked-sessions.link.new-session", "New session");
    const link = (session, [key, english]) => html`<button
        class="breadcrumb"
        key=${session.id}
        onClick=${() => navigate(session.id)}
    >
        <${Icon} name="fork" size=${14} />
        <span>${t(key, english, { title: titleOf(session) })}</span>
    </button>`;
    const shown = open || started.length <= SHOWN ? started : started.slice(0, SHOWN);

    return html`<nav class="linked-sessions" aria-label=${t(
        "web.linked-sessions.linked-sessions.aria-label.linked-sessions",
        "Linked sessions",
    )}>
        ${
            origin
                ? link(origin, LINKS.started)
                : (current?.linkedOrigin || current?.linkedFrom) &&
                  html`<p class="muted small">
                ${t(
                    "web.linked-sessions.linked-sessions.p.started-from-another-session",
                    "Started from another session",
                )}
            </p>`
        }
        ${shown.map((session) => link(session, LINKS.linked))}
        ${
            shown.length < started.length &&
            html`<button class="breadcrumb" onClick=${() => setOpenFor(conversationId)}>
                ${t("web.linked-sessions.linked-sessions.button.more", "+{count} more", {
                    count: started.length - shown.length,
                })}
            </button>`
        }
    </nav>`;
}
