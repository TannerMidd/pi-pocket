// A session's actions from its row in the session list, for touch screens, which cannot hover to show them.
import { selectFromList, setArchived } from "../sessions.js";
import { canSteer, closeSheet, isUnread, setUnread, store } from "../store.js";
import { isPinned, togglePin } from "../theme.js";
import { html, item, Sheet } from "../ui.js";

/**
 * What a finger held on a row offers: pin it, mark it unread (or read), archive it or bring it back, or select it to
 * act on more at once.
 */
export function SessionSheet({ id }) {
    const session = store.state.sessions.find((each) => each.id === id);
    const steer = canSteer();

    const then = (run) => () => {
        closeSheet();
        run();
    };

    return html`<${Sheet} title=${session.title ?? "New session"} onClose=${closeSheet}>
        <div class="sheet-list">
        ${
            steer &&
            item(
                "Edit tags",
                () => store.set({ sheet: { type: "session-tags", ids: [id] } }),
                "shared session tags",
            )
        }
        ${
            !session.archived &&
            item(
                isPinned(id) ? "Unpin from the top" : "Pin to the top",
                then(() => togglePin(id)),
                "this browser",
            )
        }
        ${
            !session.archived &&
            item(
                isUnread(id) ? "Mark read" : "Mark unread",
                then(() => setUnread(id, !isUnread(id))),
                "this browser",
            )
        }
        ${
            steer &&
            item(
                session.archived ? "Unarchive" : "Archive",
                then(() => setArchived([id], !session.archived)),
            )
        }
        ${item(
            "Select",
            then(() => selectFromList(id)),
            "then tap others to add them",
        )}
        </div>
    <//>`;
}
