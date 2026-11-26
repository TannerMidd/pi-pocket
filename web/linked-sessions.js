// The server list is the only source of relationship names and counts. The transcript stays in its own session.
import { useMemo } from "preact/hooks";
import { descendantCount, familyAttention, familyIndex } from "./session-tree.js";
import { needOf } from "./sessions.js";
import { finishedUnseen } from "./seen.js";
import { collab, isUnread, navigate, openFamily, sessionUnread, store } from "./store.js";
import { drawnFor, html, Icon } from "./ui.js";

function Relationships() {
    const { conversationId, sessions, sessionsLoaded, unread, peekSeen, server } = store.state;
    const tree = familyIndex(sessions);
    const counts = useMemo(() => familyAttention(tree, needOf), [tree, unread, peekSeen, server]);
    const node = tree.nodes.get(conversationId);
    const lead = node?.parent?.session;
    const kids = descendantCount(node);

    const family = node?.children.length > 0;

    if (!sessionsLoaded || (!lead && !family)) {
        return null;
    }

    const fresh =
        lead && (isUnread(lead.id) || finishedUnseen(lead) || (collab() && sessionUnread(lead)));
    const info = counts.get(node);

    return html`<nav class="family-context" aria-label="Related sessions">
        ${
            lead &&
            html`<button class="lead-route" data-family-open="lead" onClick=${() => navigate(lead.id)}>
            <${Icon} name="fork" size=${14}/><span>Lead</span><strong>${lead.title ?? "New session"}</strong>
            ${fresh && html`<span class="lead-unread">Unread</span>`}<${Icon} name="chevron" size=${13}/>
        </button>`
        }
        ${
            family &&
            html`<button data-family-open="header-family" aria-label=${kids === 0 ? "Browse archived links" : "Browse " + kids + " linked sessions" + (info?.waiting ? ", " + info.waiting + " waiting" : "") + (info?.failed ? ", " + info.failed + " failed" : "")} onClick=${(event) => openFamily(conversationId, "", event.currentTarget, kids === 0 ? "archived" : "all")}>
            <${Icon} name="fork" size=${14}/><strong>${kids === 0 ? "Archived links" : kids.toLocaleString() + " linked"}</strong>
            ${info?.waiting > 0 && html`<span class="family-attn">${info.waiting} waiting</span>`}
            ${info?.failed > 0 && html`<span class="family-attn">${info.failed} failed</span>`}
            <${Icon} name="chevron" size=${13}/>
        </button>`
        }
    </nav>`;
}

export const LinkedSessions = drawnFor(
    [
        "sessions",
        "sessionsLoaded",
        "conversationId",
        "server",
        "me",
        "unread",
        "peekSeen",
        "chatRead",
        "chatReads",
    ],
    Relationships,
);
