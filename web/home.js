// The wide home screen, shown beside the session list when no session is open.

import { workspaceOrder } from "./sessions.js";
import { canSteer, navigate, openSheet, scoped, store } from "./store.js";
import { paletteOf, prefs } from "./theme.js";
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
    const palette = paletteOf();
    const p = prefs();
    const busy = sessions.filter((session) => session.busy).length;
    const recent = workspaceOrder().slice(0, 5);
    const rows = [
        ["theme", `${palette.name}${p.theme === "desktop" && palette.desktop ? " (desktop)" : ""}`],
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

    return html`<div class="splash">
        <div class="fetch">
            <pre class="fetch-logo" aria-hidden="true">${LOGO}</pre>
            <div class="fetch-info">
                <div class="fetch-title" style=${`--i:${line++}`}>
                    <b>${(me?.name ?? "you").toLowerCase().replace(/\s+/g, "-")}</b>@<b>pi-pocket</b>
                </div>
                <div class="fetch-rule" style=${`--i:${line++}`}>${"─".repeat(30)}</div>
                ${rows.map(
                    ([key, value]) => html`<dl class="fetch-row" style=${`--i:${line++}`}>
                        <dt>${key}</dt>
                        <dd>${value}</dd>
                    </dl>`,
                )}
                <div class="fetch-colors" style=${`--i:${line++}`}>
                    ${colors.map((name) => html`<span style=${`background:var(${name})`}></span>`)}
                </div>
            </div>
        </div>
        <div class="splash-actions">
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
            html`<div class="splash-recent">
                <div class="group-title">Jump back in</div>
                ${recent.map(
                    (
                        session,
                        index,
                    ) => html`<button class="list-item" onClick=${() => navigate(session.id)}>
                        <span><kbd>${index + 1}</kbd>${session.title ?? "New session"}</span>
                        <span class="muted small mono">
                            ${session.busy ? "working · " : ""}
                            ${timeAgo(session.updatedAt)}
                        </span>
                    </button>`,
                )}
            </div>`
        }
    </div>`;
}
