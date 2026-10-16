// Navigation between ordinary peer chats. Only the server's per-person session list may name a linked chat.
import { navigate, store } from "./store.js";
import { html, Icon } from "./ui.js";

export function LinkedChats() {
    const { conversationId, sessions, sessionsLoaded } = store.state;

    if (!sessionsLoaded) {
        return null;
    }

    const current = sessions.find((chat) => chat.id === conversationId);
    const origin =
        current?.linkedFrom && sessions.find((chat) => chat.id === current.linkedFrom.id);
    const started = sessions.filter((chat) => chat.linkedFrom?.id === conversationId);

    if (!origin && !current?.linkedOrigin && !current?.linkedFrom && started.length === 0) {
        return null;
    }

    const link = (chat, label) => html`<button
        class="breadcrumb"
        key=${chat.id}
        onClick=${() => navigate(chat.id)}
    >
        <${Icon} name="fork" size=${14} />
        <span>${label}: ${chat.title ?? "New session"}</span>
    </button>`;

    return html`<nav class="linked-chats" aria-label="Linked chats">
        ${
            origin
                ? link(origin, "Started from")
                : (current?.linkedOrigin || current?.linkedFrom) &&
                  html`<p class="muted small">
                Started from another chat
            </p>`
        }
        ${started.map((chat) => link(chat, "Linked chat"))}
    </nav>`;
}
