// Links between linked sessions, above the transcript. Only the server's list for this person may name one.
import { useState } from "preact/hooks";
import { navigate, store } from "./store.js";
import { t } from "./i18n.js";
import { html, Icon } from "./ui.js";

/** Links shown before the rest fold into "+N more": a coordinator's transcript stays near the top on a phone. */
const SHOWN = 3;

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

    const link = (session, label) => html`<button
        class="breadcrumb"
        key=${session.id}
        onClick=${() => navigate(session.id)}
    >
        <${Icon} name="fork" size=${14} />
        <span>${label}: ${session.title ?? t("New session")}</span>
    </button>`;
    const shown = open || started.length <= SHOWN ? started : started.slice(0, SHOWN);

    return html`<nav class="linked-sessions" aria-label=${t("Linked sessions")}>
        ${
            origin
                ? link(origin, t("Started from"))
                : (current?.linkedOrigin || current?.linkedFrom) &&
                  html`<p class="muted small">
                ${t("Started from another session")}
            </p>`
        }
        ${shown.map((session) => link(session, t("Linked session")))}
        ${
            shown.length < started.length &&
            html`<button class="breadcrumb" onClick=${() => setOpenFor(conversationId)}>
                ${t("+{{count}} more", { count: started.length - shown.length })}
            </button>`
        }
    </nav>`;
}
