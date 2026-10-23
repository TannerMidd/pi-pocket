// A session's actions from its row in the session list, for touch screens, which cannot hover to show them.
import { sessionActions } from "../extension-ui.js";
import { t } from "../i18n.js";
import { selectFromList, setArchived } from "../sessions.js";
import { canSteer, closeSheet, isUnread, setUnread, store } from "../store.js";
import { isPinned, togglePin } from "../theme.js";
import { html, item, Sheet } from "../ui.js";

/**
 * What a finger held on a row offers: pin it, mark it unread (or read), archive it or bring it back, extensions' actions
 * (`pocket.sessionAction`), or select it to act on more at once.
 */
export function SessionSheet({ id }) {
    const session = store.state.sessions.find((each) => each.id === id);
    const steer = canSteer();

    const then = (run) => () => {
        closeSheet();
        run();
    };

    return html`<${Sheet} title=${session.title ?? t("New session")} onClose=${closeSheet}>
        <div class="sheet-list">
        ${
            !session.archived &&
            item(
                t(isPinned(id) ? "Unpin from the top" : "Pin to the top"),
                then(() => togglePin(id)),
                t("this browser"),
            )
        }
        ${
            !session.archived &&
            item(
                t(isUnread(id) ? "Mark read" : "Mark unread"),
                then(() => setUnread(id, !isUnread(id))),
                t("this browser"),
            )
        }
        ${
            steer &&
            item(
                t(session.archived ? "Unarchive" : "Archive"),
                then(() => setArchived([id], !session.archived)),
            )
        }
        ${sessionActions().map((action) =>
            item(
                action.label,
                then(() => action.run([id])),
                action.module,
            ),
        )}
        ${item(
            t("Select"),
            then(() => selectFromList(id)),
            t("then tap others to add them"),
        )}
        </div>
    <//>`;
}
