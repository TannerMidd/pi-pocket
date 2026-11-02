// The wide home screen, shown beside the session list when no session is open.

import { folderColor } from "./avatar.js";
import { useEffect, useRef } from "preact/hooks";
import { sessionMark } from "./sessions.js";
import { canSteer, navigate, openSheet, scoped, store, workspaceOrder } from "./store.js";
import { lookLabel, prefs } from "./theme.js";
import { html, Icon, Keys, shortPath, timeAgo } from "./ui.js";

const LOGO = [
    "▗▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▖",
    "▝▀▀▀▜██▀▀▀▀▀▀██▛▀▀▀▘",
    "    ▐██      ██▌   ",
    "    ▐██      ██▌   ",
    "    ▐██      ██▌   ",
    "    ▐██      ██▌   ",
    "   ▗██▘      ▝██▄▖ ",
    "  ▝▀▀          ▀▀▀▘",
].join("\n");

/** The home screen on wide screens: what fastfetch shows for a machine, for this Pi Pocket. */
export function Splash() {
    const { me, sessions, models, server, guard } = store.state;
    const p = prefs();
    const busy = sessions.filter((session) => session.busy && !session.archived).length;
    const recent = workspaceOrder().slice(0, 5);
    const splash = useRef(null);

    // The keys beside Jump back in: a digit opens its session, as Alt and the digit does anywhere. Only where they
    // show: on a narrow screen the home screen is hidden, and a digit there must do nothing.
    useEffect(() => {
        const onKey = (event) => {
            const target = event.target;
            const index = Number(event.key) - 1;

            if (
                event.defaultPrevented ||
                event.altKey ||
                event.ctrlKey ||
                event.metaKey ||
                !(index >= 0 && index < 5) ||
                target?.closest?.("input, textarea, select, [contenteditable]") ||
                store.state.sheet ||
                store.state.launcher ||
                !(
                    splash.current?.checkVisibility?.() ??
                    splash.current?.getClientRects().length > 0
                )
            ) {
                return;
            }

            const session = workspaceOrder()[index];

            if (session) {
                event.preventDefault();
                navigate(session.id);
            }
        };

        addEventListener("keydown", onKey);

        return () => removeEventListener("keydown", onKey);
    }, []);
    const rows = [
        ["theme", lookLabel()],
        [
            "layout",
            `${p.tiling ? "tiled windows" : "flat"}, sidebar ${p.sidebar === "rail" ? "folded" : "open"}`,
        ],
        [
            "sessions",
            `${sessions.filter((session) => !session.archived).length}${busy > 0 ? `, ${busy} running` : ""}`,
        ],
        ["models", String(models.length)],
        ["folder", shortPath(server?.defaultCwd, server?.home) || "~"],
        [
            "guard",
            guard?.enabled
                ? guard.available === false
                    ? "failed to load"
                    : "Lancet Guard on"
                : "off",
        ],
        ["you", `${me?.name ?? "?"} (${me?.role ?? "?"})`],
    ];
    const colors = [
        "--o-red",
        "--o-yellow",
        "--o-green",
        "--o-cyan",
        "--o-blue",
        "--o-magenta",
        "--o-accent",
        "--o-fg",
    ];
    const canStart = canSteer() && !scoped();
    let line = 0;

    return html`<div class="splash" data-part="home" ref=${splash}>
        <button
            class="icon-button splash-menu"
            data-part="home-menu"
            aria-label="Menu"
            title="Menu"
            aria-haspopup="dialog"
            aria-expanded=${store.state.sheet?.type === "menu"}
            onClick=${() => openSheet({ type: "menu" })}
        >
            <${Icon} name="more" />
        </button>
        <div class="fetch" data-part="home-facts">
            <pre class="fetch-logo" data-part="home-logo" aria-hidden="true">${LOGO}</pre>
            <div class="fetch-info">
                <div class="fetch-title" data-part="home-title" style=${`--i:${line++}`}>
                    <b>${(me?.name ?? "you").toLowerCase().replace(/\s+/g, "-")}</b>@<b>pi-pocket</b>
                </div>
                ${rows.map(
                    ([key, value]) => html`<dl
                        class="fetch-row"
                        data-part="home-fact"
                        style=${`--i:${line++}`}
                    >
                        <dt>${key}</dt>
                        <dd>${value}</dd>
                    </dl>`,
                )}
                <div class="fetch-colors" data-part="home-colors" style=${`--i:${line++}`}>
                    ${colors.map(
                        (name) =>
                            html`<span data-part="home-color" style=${`background:var(${name})`}></span>`,
                    )}
                </div>
            </div>
        </div>
        <div class="splash-actions" data-part="home-actions">
            ${
                canStart &&
                html`<button
                    class="button primary"
                    onClick=${() => openSheet({ type: "cwd", mode: "new" })}
                >
                    <${Icon} name="plus" size=${16} /> New session <${Keys} keys="Alt N" />
                </button>`
            }
            <button class="button" onClick=${() => store.set({ launcher: true })}>
                <${Icon} name="command" size=${16} /> Launcher <${Keys} keys="Mod K" />
            </button>
            <button class="button" onClick=${() => openSheet({ type: "appearance" })}>
                <${Icon} name="palette" size=${16} /> Appearance
            </button>
        </div>
        ${
            recent.length > 0 &&
            html`<div class="splash-recent" data-part="home-recent">
                <div class="splash-heading" data-part="home-heading">Jump back in</div>
                ${recent.map(
                    (session, index) => html`<button
                        class="splash-row"
                        data-part="home-recent-row"
                        onClick=${() => navigate(session.id)}
                    >
                        <span class="splash-key" data-part="home-recent-key">${index + 1}</span>
                        <span
                            class=${`state-mark ${sessionMark(session).shape}`}
                            data-part="session-mark"
                            style=${`--folder:${folderColor(session.cwd)}`}
                            aria-hidden="true"
                        ></span>
                        <span class="splash-title">${session.title ?? "New session"}</span>
                        <span class="splash-meta">
                            ${session.waiting ? html`<span class="session-needs">${canSteer() ? "needs you" : "waiting"}</span>` : session.busy ? "working · " : ""}
                            ${!session.waiting && timeAgo(session.updatedAt)}
                        </span>
                    </button>`,
                )}
            </div>`
        }
    </div>`;
}
