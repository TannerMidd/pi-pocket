import { useEffect, useLayoutEffect, useRef } from "preact/hooks";
import { sessionActions } from "../extension-ui.js";
import { deselectInList, selectedInList, selectFromList, setArchived } from "../sessions.js";
import {
    actions,
    attempt,
    canSteer,
    closeSheet,
    collab,
    isUnread,
    navigate,
    notify,
    scoped,
    setUnread,
    store,
} from "../store.js";
import { isPinned, movePin, togglePin } from "../theme.js";
import { copyText, html, item, scrimPress, Sheet } from "../ui.js";
import { t } from "../ui-locale.js";

const linkOf = (id) => `${location.origin}/s/${id}`;

const copy = (text, what) =>
    copyText(text).then(
        () => notify("info", t("web.sheets.session.copy.copied", "Copied the {what}.", { what })),
        () =>
            notify(
                "error",
                t("web.sheets.session.copy.not-copy", "Could not copy the {what}.", { what }),
            ),
    );

let forking = false;

function fork(id) {
    if (forking) {
        return;
    }

    forking = true;
    attempt(async () => {
        const created = await actions.forkSession(id);

        navigate(created.id);
        notify(
            "info",
            t(
                "web.sheets.session.fork.text.opened-fork-original-unchanged",
                "Opened the fork. The original is unchanged.",
            ),
        );
    }).finally(() => {
        forking = false;
    });
}

const newIn = (cwd) =>
    attempt(async () => {
        const created = await actions.createSession(cwd);

        navigate(created.id);
    });

function sessionItems(session) {
    const { id } = session;
    const steer = canSteer();
    // People invited to one session start none, and invite nobody.
    const starts = steer && !scoped();
    const pinned = !session.archived && isPinned(id);
    const pins = store.state.pinned.filter((each) =>
        store.state.sessions.some((one) => one.id === each && !one.archived),
    );

    return [
        [
            {
                label: t("web.sheets.session.session-items.label.open-new-tab", "Open in new tab"),
                run: () => window.open(linkOf(id), "_blank", "noopener"),
            },
            {
                label: t("web.sheets.session.session-items.label.copy-link", "Copy link"),
                run: () => copy(linkOf(id), t("web.sheets.session.session-items.run.link", "link")),
            },
            {
                label: t(
                    "web.sheets.session.session-items.label.copy-folder-path",
                    "Copy folder path",
                ),
                run: () =>
                    copy(
                        session.cwd,
                        t("web.sheets.session.session-items.run.folder-path", "folder path"),
                    ),
            },
        ],
        [
            steer && {
                label: t("web.sheets.session.session-items.label.rename", "Rename"),
                opens: true,
                run: () => store.set({ sheet: { type: "rename", id } }),
            },
            starts && {
                label: t("web.sheets.session.session-items.label.fork", "Fork"),
                hint: t(
                    "web.sheets.session.session-items.hint.up-last-reply",
                    "up to the last reply",
                ),
                run: () => fork(id),
            },
            starts && {
                label: t(
                    "web.sheets.session.session-items.label.new-session-folder",
                    "New session in this folder",
                ),
                run: () => newIn(session.cwd),
            },
            starts &&
                collab() && {
                    label: t("web.sheets.session.session-items.label.share", "Share"),
                    hint: t(
                        "web.sheets.session.session-items.hint.invite-someone",
                        "invite someone",
                    ),
                    opens: true,
                    run: () => store.set({ sheet: { type: "invite", session: id } }),
                },
        ],
        [
            !session.archived && {
                label: pinned
                    ? t("web.sheets.session.session-items.label.unpin-top", "Unpin from the top")
                    : t("web.sheets.session.session-items.label.pin-top", "Pin to the top"),
                hint: t("web.sheets.session.session-items.hint.this-browser", "this browser"),
                run: () => togglePin(id),
            },
            pinned &&
                pins[0] !== id && {
                    label: t("web.sheets.session.session-items.label.move-top", "Move to top"),
                    hint: t("web.sheets.session.session-items.hint.pinned", "of the pinned"),
                    run: () => movePin(id, false),
                },
            pinned &&
                pins.at(-1) !== id && {
                    label: t(
                        "web.sheets.session.session-items.label.move-bottom",
                        "Move to bottom",
                    ),
                    hint: t("web.sheets.session.session-items.hint.pinned", "of the pinned"),
                    run: () => movePin(id, true),
                },
            !session.archived && {
                label: isUnread(id)
                    ? t("web.sheets.session.session-items.label.mark-read", "Mark read")
                    : t("web.sheets.session.session-items.label.mark-unread", "Mark unread"),
                hint: t("web.sheets.session.session-items.hint.this-browser", "this browser"),
                run: () => setUnread(id, !isUnread(id)),
            },
        ],
        sessionActions().map((action) => ({
            label: action.label,
            hint: action.module,
            run: () => action.run([id]),
        })),
        [
            selectedInList() > 0
                ? {
                      label: t("web.sheets.session.session-items.label.deselect", "Deselect all"),
                      hint: t(
                          "web.sheets.session.session-items.hint.selected-count",
                          "{count} selected",
                          { count: selectedInList() },
                      ),
                      run: deselectInList,
                  }
                : {
                      label: t("web.sheets.session.session-items.label.select", "Select"),
                      hint: t(
                          "web.sheets.session.session-items.hint.add-others",
                          "then add others",
                      ),
                      run: () => selectFromList(id),
                  },
            steer && {
                label: session.archived
                    ? t("web.sheets.session.session-items.label.unarchive", "Unarchive")
                    : t("web.sheets.session.session-items.label.archive", "Archive"),
                run: () => setArchived([id], !session.archived),
            },
        ],
    ]
        .map((group) => group.filter(Boolean))
        .filter((group) => group.length > 0);
}

const runItem = (each) => () => {
    if (!each.opens) {
        closeSheet();
    }

    each.run();
};

export function SessionSheet({ id, at = null }) {
    const session = store.state.sessions.find((each) => each.id === id);
    const groups = sessionItems(session);
    const title =
        session.title ?? t("web.sheets.session.session-sheet.text.new-session", "New session");

    if (at) {
        return html`<${SessionMenu} title=${title} groups=${groups} at=${at} />`;
    }

    return html`<${Sheet} title=${title} onClose=${closeSheet}>
        <div class="sheet-list">
            ${groups.flat().map((each) => item(each.label, runItem(each), each.hint))}
        </div>
    <//>`;
}

function SessionMenu({ title, groups, at }) {
    const box = useRef(null);

    useLayoutEffect(() => {
        const menu = box.current;
        // Unscaled: the opening animation scales the menu, and a scaled size is a little short.
        const width = menu.offsetWidth;
        const height = menu.offsetHeight;
        const left = at.x + width + 8 > innerWidth ? Math.max(8, at.x - width) : at.x;
        const top = at.y + height + 8 > innerHeight ? Math.max(8, at.y - height) : at.y;

        menu.style.left = `${left}px`;
        menu.style.top = `${top}px`;
        menu.focus({ preventScroll: true });
    }, [at.x, at.y]);

    useEffect(() => {
        const onKey = (event) =>
            event.key === "Escape" && !event.isComposing && event.keyCode !== 229 && closeSheet();

        addEventListener("keydown", onKey);

        return () => removeEventListener("keydown", onKey);
    }, []);

    const onKeyDown = (event) => {
        // Here as well as on the window: the menu has the focus from its first frame, before effects run.
        if (event.key === "Escape" && !event.isComposing && event.keyCode !== 229) {
            event.preventDefault();
            closeSheet();

            return;
        }

        const items = [...box.current.querySelectorAll("button")];
        const index = items.indexOf(document.activeElement);
        let target;

        if (event.key === "ArrowDown") {
            target = items[(index + 1) % items.length];
        } else if (event.key === "ArrowUp") {
            target = items[(index - 1 + items.length) % items.length];
        } else if (event.key === "Home") {
            target = items[0];
        } else if (event.key === "End") {
            target = items.at(-1);
        } else if (event.key === "Tab") {
            target = items[(index + (event.shiftKey ? -1 : 1) + items.length) % items.length];
        }

        if (target) {
            event.preventDefault();
            target.focus();
        }
    };

    const onScrimMenu = (event) => {
        if (event.target === event.currentTarget) {
            event.preventDefault();
            closeSheet();
        }
    };

    return html`<div
        class="overlay pop-overlay"
        onMouseDown=${scrimPress(closeSheet)}
        onContextMenu=${onScrimMenu}
    >
        <section
            class="pop-menu session-menu"
            data-part="session-menu"
            ref=${box}
            role="menu"
            aria-label=${title}
            tabindex="-1"
            onKeyDown=${onKeyDown}
            onContextMenu=${(event) => event.preventDefault()}
        >
            ${groups.map(
                (group) => html`<div class="session-menu-group" role="group">
                    ${group.map(
                        (each) => html`<button
                            class="session-menu-item"
                            role="menuitem"
                            onClick=${runItem(each)}
                        >
                            <span>${each.label}</span>
                            ${each.hint && html`<span class="session-menu-hint">${each.hint}</span>`}
                        </button>`,
                    )}
                </div>`,
            )}
        </section>
    </div>`;
}
