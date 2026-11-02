// The desktop app side of `web/host.js`: notifications, badge, tray, and links. docs/desktop.md describes it.
import { callHost, host, hostCan, onHost } from "./host.js";
import { openPip } from "./pip.js";
import { sessionMark } from "./sessions.js";
import { actions, attempt, navigate, notify, onDesktopNotify, store } from "./store.js";

/** The longest list of pinned sessions the host gets: a tray menu shows a few. */
const MAX_PINNED = 20;

export function openAddress(address) {
    let url;

    try {
        url = new URL(String(address ?? "/"), location.origin);
    } catch {
        return;
    }

    if (url.origin !== location.origin) {
        return;
    }

    if (url.searchParams.has("pip")) {
        openPip();

        return;
    }

    const match = /^\/s\/(\d+)$/.exec(url.pathname);

    navigate(match ? Number(match[1]) : null);
}

if (host !== null) {
    if (hostCan("notify")) {
        onDesktopNotify((message) => callHost("notify", message));
        onHost("open", (event) => openAddress(event.url));
        onHost("approve", (event) =>
            attempt(async () => {
                await actions.approve(String(event.id), event.allow === true);
            }).then(() => undefined),
        );
    } else if (hostCan("open")) {
        onHost("open", (event) => openAddress(event.url));
    }

    if (hostCan("pinned")) {
        let from = null;
        let pinnedSent = "";

        store.subscribe((state) => {
            if (
                !state.me ||
                (from?.sessions === state.sessions &&
                    from.pinned === state.pinned &&
                    from.unread === state.unread &&
                    from.peekSeen === state.peekSeen)
            ) {
                return;
            }

            from = {
                sessions: state.sessions,
                pinned: state.pinned,
                unread: state.unread,
                peekSeen: state.peekSeen,
            };

            const byId = new Map(state.sessions.map((session) => [session.id, session]));
            const pinned = state.pinned
                .map((id) => byId.get(id))
                .filter((session) => session !== undefined && !session.archived)
                .slice(0, MAX_PINNED)
                .map((session) => {
                    const mark = sessionMark(session);

                    return {
                        id: session.id,
                        title: session.title,
                        // The square's shape (`fresh`/`seen`), not the row's theme state (`done`/`idle`).
                        state: mark.shape.split(" ")[0],
                        label: mark.label,
                        url: `/s/${session.id}`,
                    };
                });
            const json = JSON.stringify(pinned);

            if (json !== pinnedSent) {
                pinnedSent = json;
                callHost("setPinned", pinned);
            }
        });
    }
}

export function hostMenuItems() {
    if (!hostCan("menu")) {
        return [];
    }

    const items = callHost("menuItems");

    return (Array.isArray(items) ? items : [])
        .filter((each) => typeof each?.id === "string" && typeof each?.label === "string")
        .map((each) => ({
            key: `host:${each.id}`,
            label: each.label,
            hint: typeof each.hint === "string" ? each.hint : "",
            run: () => {
                const done = callHost("invoke", each.id);

                if (done === false) {
                    notify("error", "The desktop app could not do that.");
                }
            },
        }));
}
