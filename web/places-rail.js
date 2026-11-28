// Destinations of the labeled rail. The place slot supplies the same actions as All places.
import { schedulesAvailable } from "./commands.js";
import { useChanges } from "./diff.js";
import { extensionRailItems } from "./extension-ui.js";
import { filesAvailable } from "./files-panel.js";
import { PeeksRailButton } from "./peeks.js";
import { PipRailButton } from "./pip.js";
import { prefetchRunning } from "./running-board.js";
import { subagentTotals, toggleBoard } from "./sessions.js";
import { menuGroup, menuRow, MenuFrame } from "./sheets/menu.js";
import { slotItems } from "./slots.js";
import { closeSheet, collab, openSheet, signOut, store } from "./store.js";
import { html } from "./ui.js";

// Boards and extension pages replace the conversation but leave its view in the store.
const sessionShown = () => {
    const { board, page, view, missing } = store.state;

    return !board && !page && !missing && Boolean(view.conversation);
};

const sheetRow = (label, icon, type, hint) =>
    menuRow(label, () => openSheet({ type }), { icon, hint, next: true });

const menuSection = (label, icon, section) =>
    menuRow(label, () => openSheet({ type: "menu", section }), { icon, next: true });

function Activity() {
    const { sessions, board } = store.state;
    const busy = sessions.filter((session) => session.busy || session.background > 0).length;
    const agents = subagentTotals(sessions);
    const failed = agents.failed - agents.dealt;
    const summary = [
        agents.working && `${agents.working} working`,
        agents.waiting && `${agents.waiting} waiting for approval`,
        failed > 0 && `${failed} failed`,
    ]
        .filter(Boolean)
        .join(" · ");

    const select = (which) => {
        closeSheet();
        toggleBoard(which);
    };

    return [
        menuGroup("Across sessions", [
            html`<div
                onPointerDown=${() => board !== "running" && prefetchRunning().catch(() => undefined)}
            >
                ${menuRow("Running now", () => select("running"), {
                    icon: "pulse",
                    hint: busy ? `${busy} ${busy === 1 ? "session" : "sessions"} at work` : null,
                    next: true,
                })}
            </div>`,
            menuRow("Subagents", () => select("subagents"), {
                icon: "fork",
                hint: summary,
                next: true,
            }),
        ]),
        sessionShown() &&
            menuGroup("This session", [
                sheetRow("Background", "terminal", "background", "Job status and command output"),
                schedulesAvailable() && sheetRow("Scheduled messages", "clock", "schedules"),
            ]),
    ];
}

const quick = new Set(["core:files", "core:browser", "core:artifacts"]);

function ToolGroups({ changes = null }) {
    const conversation = sessionShown();
    const places = conversation ? slotItems("places", { changes }) : [];
    const rail = extensionRailItems();
    const visible = new Set(places.map(({ id }) => id));
    const rows = (show) =>
        places
            .filter(({ id }) => show(id))
            .map(({ id, node }) => {
                const buttons = rail.filter(({ panelPlace }) => panelPlace === id);

                return buttons.length
                    ? buttons.map((button) => button.node)
                    : html`<div key=${id} class="tool-place-row">${node}</div>`;
            });

    return [
        conversation &&
            menuGroup("Session results", [
                rows((id) => id === "core:changes"),
                sheetRow("Background", "terminal", "background", "Job status and command output"),
            ]),
        conversation &&
            menuGroup("Session places", [
                rows((id) => quick.has(id) || id.startsWith("ext:")),
                menuSection("All places", "grid", "all"),
            ]),
        menuGroup("Application", [
            menuSection("App settings", "sliders", "settings"),
            sheetRow("Extensions", "grid", "extensions"),
        ]),
        menuGroup("Across sessions", [
            sheetRow("All artifacts", "artifact", "all-artifacts"),
            html`<${PipRailButton} />`,
            html`<${PeeksRailButton} />`,
            rail.filter(({ panelPlace }) => !visible.has(panelPlace)).map(({ node }) => node),
        ]),
    ];
}

// No changes request goes out for a viewer or a remote workspace.
function ToolsWithChanges() {
    const { changes } = useChanges();

    return html`<${ToolGroups} changes=${changes} />`;
}

function Tools() {
    return sessionShown() && filesAvailable()
        ? html`<${ToolsWithChanges} />`
        : html`<${ToolGroups} />`;
}

function Account() {
    const { me } = store.state;

    return [
        menuGroup("Your account", [
            sheetRow("Your name", "users", "name", me?.name),
            collab()
                ? sheetRow("People", "users", "people")
                : sheetRow("Sign in another device", "phone", "invite"),
            collab() && sheetRow("Notifications", "unread", "notifications"),
            menuRow("Sign out", signOut, { icon: "logout" }),
        ]),
        menuGroup("Preferences", [
            sheetRow("Appearance", "palette", "appearance"),
            menuSection("App settings", "sliders", "settings"),
        ]),
    ];
}

const sections = {
    activity: ["Activity", Activity],
    tools: ["Tools", Tools],
    account: ["Account", Account],
};

export function RailPage({ type }) {
    const [title, Body] = sections[type];

    return html`<${MenuFrame} title=${title}><${Body} /><//>`;
}
