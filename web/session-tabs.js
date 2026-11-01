// Session tabs: Appearance's "Tabs" switcher puts the sessions in a strip of segments above the conversation's top bar,
// as the folded sidebar numbers them (`workspaceOrder`: Alt+1…9). One segment each, in the session's folder color; the
// open one fills, one that works pulses, one that waits for you shows in the warning color.
import { useEffect, useRef } from "preact/hooks";
import { folderColor } from "./avatar.js";
import { isUnread, navigate, store, workspaceOrder } from "./store.js";
import { TAB_MAX, tabSessions, tabState } from "./tab-order.js";
import { drawnFor, html } from "./ui.js";

const STATE_WORDS = { waiting: ", needs you", working: ", working", unread: ", unread", idle: "" };

function Tabs() {
    const { conversationId } = store.state;
    const order = workspaceOrder();
    const tabs = tabSessions(order, conversationId, TAB_MAX, store.state.sessions);
    const strip = useRef(null);

    // A strip that scrolls (a phone, many tabs) keeps the open one in view.
    useEffect(() => {
        strip.current
            ?.querySelector('[aria-current="page"]')
            ?.scrollIntoView({ inline: "center", block: "nearest" });
    }, [conversationId]);

    return html`<nav
        class="tabstrip"
        data-part="tabstrip"
        aria-label="Sessions"
        ref=${strip}
    >
        ${tabs.map((session) => {
            const open = session.id === conversationId;
            const state = tabState(session, open, isUnread(session.id));
            const title = session.title ?? "New session";
            const number = order.findIndex((each) => each.id === session.id) + 1;

            return html`<button
                key=${session.id}
                class=${`tabstrip-tab ${open ? "on" : ""}`}
                data-part="tabstrip-tab"
                data-state=${state}
                aria-current=${open ? "page" : undefined}
                aria-label=${`${title}${STATE_WORDS[state]}`}
                title=${`${title}${number <= TAB_MAX ? ` (Alt+${number})` : ""}`}
                style=${`--folder:${folderColor(session.cwd)}`}
                onClick=${() => navigate(session.id)}
            >
                <span class="tabstrip-bar" aria-hidden="true"></span>
                <span class="tabstrip-name" data-part="tabstrip-name">${title}</span>
            </button>`;
        })}
    </nav>`;
}

const KEYS = ["sessions", "pinned", "unread", "conversationId", "foldedLinked"];

/** Drawn again only when the sessions, the open one, or what is unread changes: not as an answer streams. */
export const SessionTabs = drawnFor(KEYS, Tabs);
