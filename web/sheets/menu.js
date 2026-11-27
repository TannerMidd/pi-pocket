// The menu: what can be done in this session and in the app.
import { useLayoutEffect, useRef } from "preact/hooks";
import { browserAvailable, displayUrl, setBrowserOpen } from "../browser.js";
import { chatUnread } from "../chat.js";
import { schedulesAvailable, triggersOn, watchAvailable, watchPr } from "../commands.js";
import { extensionMenuItems, safeMode } from "../extension-ui.js";
import { hostMenu } from "../embedder.js";
import { useChanges } from "../diff.js";
import { filesAvailable, setFilesOpen } from "../files-panel.js";
import { peeksOn, togglePeeks } from "../peeks.js";
import { modelRefreshAvailable, refreshModels } from "../model-refresh.js";
import { openPip, pipAvailable, pipUnread } from "../pip.js";
import { setArchived } from "../sessions.js";
import { openSubagent } from "../subagents.js";
import {
    actions,
    api,
    attempt,
    canSteer,
    canToggleTurns,
    closeSheet,
    collab,
    navigate,
    notify,
    openSheet,
    scoped,
    setUnread,
    store,
} from "../store.js";
import { defineItem, slotItems } from "../slots.js";
import { isPinned, lookLabel, togglePin } from "../theme.js";
import { currentTrust, trustAvailable } from "../trust.js";
import { branchAvailable } from "./branch.js";
import { memoryAvailable, memoryHint, useMemory } from "./memory.js";
import { defaultLabel, defaultsKept } from "./model.js";
import { copyText, html, Icon, item, PlaceTile, Sheet, shortPath } from "../ui.js";

// Key hints are for people with a keyboard: a touch screen has none.
const touch = matchMedia("(pointer: coarse)").matches;

/** The menu's word on the session's schedules: how many go out, and how many are paused. */
function schedulesHint(schedules) {
    const paused = schedules.filter((each) => each.paused !== undefined).length;
    const coming = schedules.length - paused;

    if (schedules.length === 0) {
        return "none";
    }

    return [coming > 0 && `${coming} coming`, paused > 0 && `${paused} paused`]
        .filter(Boolean)
        .join(" · ");
}

function extensionsHint() {
    const { guard } = store.state;

    return [
        safeMode() && "browser parts off here",
        guard?.enabled ? "Lancet Guard on" : guard?.available ? "Lancet Guard off" : "",
    ]
        .filter(Boolean)
        .join(" · ");
}

/**
 * The session's places as big tiles at the top of the menu: Files, Changes, the browser, artifacts, the chat, find,
 * the branch, and peek tiles. The top bar keeps only the buttons with something to say; these are always here, a
 * thumb's width each.
 */
function Places({ common = false }) {
    if (!store.state.view.conversation) {
        return null;
    }

    return filesAvailable()
        ? html`<${PlacesWithChanges} common=${common} />`
        : html`<${PlacesGrid} common=${common} />`;
}

/** Only people who can open Files request its shared changes data, just as the top bar does. */
function PlacesWithChanges({ common }) {
    const { changes } = useChanges();

    return html`<${PlacesGrid} changes=${changes} common=${common} />`;
}

/**
 * The app's own places, items of the `places` slot (slots.js), which a person can hide and reorder in Appearance, with
 * extensions' panels after them. Each gets `{ changes }`: the folder's changes, for the count on Changes.
 */
const PLACES = [
    {
        id: "core:files",
        label: "Files",
        place: () =>
            filesAvailable() && {
                icon: "folder",
                on: store.state.filesOpen && store.state.filesTab === "files",
                run: () => setFilesOpen(true, "files"),
            },
    },
    {
        id: "core:changes",
        label: "Changes",
        place({ changes }) {
            // Match the top bar: uncommitted files in a repository, Pi's edits elsewhere, plus any unlisted files.
            const count = changes
                ? changes.files.length +
                  (changes.repo ? 0 : changes.piOnly.length) +
                  (changes.more ?? 0)
                : 0;

            return (
                filesAvailable() && {
                    icon: "diff",
                    count,
                    counted: count === 1 ? "changed file" : "changed files",
                    on: store.state.filesOpen && store.state.filesTab === "changes",
                    run: () => setFilesOpen(true, "changes"),
                }
            );
        },
    },
    {
        id: "core:browser",
        label: "Browser",
        place() {
            const { browser, browserOpen } = store.state;

            return (
                browserAvailable() && {
                    icon: "globe",
                    on: browserOpen,
                    dot: browser?.open && browser.url !== "" && browser.url !== "about:blank",
                    run: () => {
                        setBrowserOpen(true);
                        closeSheet();
                    },
                }
            );
        },
    },
    {
        id: "core:artifacts",
        label: "Artifacts",
        place: () => ({
            icon: "artifact",
            count: store.state.view.artifacts.length,
            run: () => openSheet({ type: "artifacts" }),
        }),
    },
    {
        id: "core:chat",
        label: "Chat",
        place: () =>
            collab() && {
                icon: "chat",
                count: chatUnread(),
                counted: "unread",
                run: () => openSheet({ type: "chat" }),
            },
    },
    {
        id: "core:find",
        label: "Find",
        place: () => ({ icon: "search", run: () => openSheet({ type: "find" }) }),
    },
    {
        // Ctrl K's launcher, for touch screens that have no keyboard to open it.
        id: "core:launcher",
        label: "Launcher",
        place: () =>
            touch && {
                icon: "command",
                run: () => {
                    closeSheet();
                    store.set({ launcher: true });
                },
            },
    },
    {
        id: "core:branch",
        label: "Branch",
        place: () =>
            branchAvailable() && { icon: "fork", run: () => openSheet({ type: "branch" }) },
    },
    {
        id: "core:pip",
        label: "PiP",
        place: () =>
            pipAvailable() && {
                icon: "pip",
                dot: pipUnread(),
                dotLabel: "something new",
                run: () => {
                    openPip();
                    closeSheet();
                },
            },
    },
    {
        id: "core:peeks",
        label: "Peeks",
        place: () =>
            store.state.server?.peeks === true && {
                icon: "tiles",
                on: peeksOn(),
                run: () => {
                    togglePeeks();
                    closeSheet();
                },
            },
    },
];

PLACES.forEach(({ id, label, place }, index) =>
    defineItem("places", {
        id,
        label,
        order: (index + 1) * 100,
        render(context) {
            const shown = place(context);

            // As before slots: `data-place="files"`, which tests and themes may select.
            return (
                shown &&
                html`<${PlaceTile} place=${{ id: id.replace(/^core:/, ""), label, ...shown }} />`
            );
        },
    }),
);

const COMMON = new Set(["core:files", "core:changes", "core:find"]);

function PlacesGrid({ changes = null, common }) {
    const places = slotItems("places", { changes });
    const shown = common ? places.filter(({ id }) => COMMON.has(id)) : places;

    return shown.length > 0
        ? html`<nav class="places" aria-label="Places">${shown.map(({ node }) => node)}</nav>`
        : !common && html`<p class="muted small">No places are visible in this session.</p>`;
}

/**
 * The places alone, in a short sheet that stays near the bottom edge: what the button beside the message box and a
 * swipe up from it open on a phone, a thumb's reach away. The rest of the menu is a row below.
 */
export function PlacesSheet() {
    const conversation = store.state.view.conversation;

    return html`<${Sheet}
        title=${conversation?.title ?? "Open"}
        onClose=${closeSheet}
        className="places-sheet"
    >
        <${Places} />
        ${item("Session menu", () => openSheet({ type: "menu", fromPlaces: true }), "rename, context, settings")}
    <//>`;
}

// Back restores the same sheet object. Opening the page again creates a new one.
const bookmarks = new WeakMap();
const menuControls = "button:not([disabled]), a[href]";
const controlName = (node) =>
    node.dataset.place ??
    node.getAttribute("aria-label") ??
    node.querySelector(".menu-name, :scope > span:first-child")?.textContent.trim() ??
    node.textContent.trim();

function menuKeys(event) {
    if (
        event.defaultPrevented ||
        event.isComposing ||
        event.keyCode === 229 ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        !["Home", "End", "ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(event.key) ||
        event.target.closest("input, textarea, select, [contenteditable]")
    ) {
        return;
    }

    const body = event.currentTarget.querySelector(".sheet-body");
    const items = [...body.querySelectorAll(menuControls)];
    const index = items.indexOf(document.activeElement);
    const forward = event.key === "ArrowDown" || event.key === "ArrowRight";
    const vertical = event.key === "ArrowDown" || event.key === "ArrowUp";
    let next;

    if (event.key === "Home" || event.key === "End" || index < 0) {
        next = event.key === "Home" || forward ? 0 : items.length - 1;
    } else {
        const grid = items[index].closest(".places");
        const step =
            grid && vertical ? getComputedStyle(grid).gridTemplateColumns.split(" ").length : 1;

        next = index + (forward ? step : -step);

        if (grid && vertical && !grid.contains(items[next])) {
            const tiles = items.filter((node) => grid.contains(node));

            next = forward ? items.indexOf(tiles.at(-1)) + 1 : items.indexOf(tiles[0]) - 1;
        }
    }

    const target = items[(next + items.length) % items.length];

    if (target) {
        event.preventDefault();
        target.focus();
    }
}

export function MenuFrame({ title, eyebrow = "Pi Pocket", children }) {
    const ref = useRef(null);
    const sheet = store.state.sheet;

    useLayoutEffect(() => {
        if (!sheet) {
            return undefined;
        }

        const host = ref.current;
        const body = host.querySelector(".sheet-body");
        const saved = bookmarks.get(sheet);
        let name = saved?.name;

        if (saved) {
            body.scrollTop = saved.top;
            const target = [...host.querySelectorAll(menuControls)].find(
                (node) => controlName(node) === name,
            );

            target?.focus({ preventScroll: true });
        }

        const remember = (event) => {
            const node = event.target.closest(menuControls);

            if (node) {
                name = controlName(node);
            }
        };

        host.addEventListener("focusin", remember);
        host.addEventListener("click", remember, true);

        return () => {
            bookmarks.set(sheet, { name, top: body.scrollTop });
            host.removeEventListener("focusin", remember);
            host.removeEventListener("click", remember, true);
        };
    }, [sheet]);

    return html`<div class="nav-menu-host" data-part="menu" ref=${ref} onKeyDown=${menuKeys}>
        <${Sheet}
            title=${title}
            eyebrow=${eyebrow}
            onClose=${closeSheet}
            className="nav-menu grouped-menu"
        >
            ${children}
        <//>
    </div>`;
}

export function menuGroup(title, rows, extra = null) {
    const visible = [rows].flat(Infinity).filter(Boolean);

    if (!visible.length && !extra) {
        return null;
    }

    return html`<section class="group menu-group">
        ${
            (title || extra) &&
            html`<div class="menu-group-head">
            ${title && html`<h3 class="group-title">${title}</h3>`}
            ${extra}
        </div>`
        }
        ${visible}
    </section>`;
}

const menuPaths = {
    rename: "m4 16 .1 4 4-.2L20 7.7a1.7 1.7 0 0 0-3.8-3.3z M14.6 6l3.3 3.4",
    link: "m9.7 14.3 4.6-4.6 M9.2 10.1l-2.1 2.1a3.8 3.8 0 0 0 5.4 5.4l2.1-2.1 M14.8 13.9l2.1-2.1a3.8 3.8 0 0 0-5.4-5.4L9.4 8.5",
    sliders: "M4 6h6m4 0h6M4 12h10m4 0h2M4 18h3m4 0h9 M10 4v4 M16 10v4 M9 16v4",
};

export function menuRow(label, run, { icon, hint, next = false } = {}) {
    return html`<button type="button" class="list-item menu-row" onClick=${run}>
        ${icon && html`<${Icon} name=${icon} path=${menuPaths[icon]} size=${19} stroke=${1.65} />`}
        <span class="menu-row-label">
            <span class="menu-name">${label}</span>${hint && html`<small>${hint}</small>`}
        </span>
        ${next && html`<${Icon} class="menu-chevron" name="chevron" size=${16} stroke=${1.65} />`}
    </button>`;
}

const TITLES = {
    all: "All places",
    commands: "Session commands",
    manage: "Manage session",
    context: "Pi and context",
    settings: "App settings",
    ext: "Extensions and integrations",
};

const openSection = (section) => openSheet({ type: "menu", section });
const sectionRow = (section, icon, label = TITLES[section]) =>
    menuRow(label, () => openSection(section), { icon, next: true });

function trustHint() {
    const info = currentTrust();

    if (!info || (info.saved === null && !info.ask && info.defaultProjectTrust === "ask")) {
        return "";
    }

    return info.ask ? "not decided" : info.trusted ? "trusted" : "not trusted";
}

function sessionAccess() {
    const { me, view } = store.state;
    const { conversation, turns } = view;
    const steer = canSteer();
    const driving = !turns?.on || turns.driver === me?.id;

    return { conversation, session: conversation?.kind === "session", steer, driving };
}

function quickRows() {
    const { conversation, session, steer } = sessionAccess();

    return [
        session &&
            steer &&
            menuRow("Rename", () => openSheet({ type: "rename" }), { icon: "rename" }),
        session &&
            menuRow(
                isPinned(conversation.id) ? "Unpin from the top" : "Pin to the top",
                () => {
                    togglePin(conversation.id);
                    closeSheet();
                },
                { icon: "pin" },
            ),
        conversation &&
            menuRow(
                "Copy link",
                () =>
                    copyText(location.href).then(
                        () => notify("info", "Link copied. Other signed-in devices can open it."),
                        () => notify("error", "Could not copy."),
                    ),
                { icon: "link" },
            ),
    ];
}

function overview(places) {
    const { conversation } = store.state.view;
    const all = html`<button class="menu-all" onClick=${() => openSection("all")}>
        All places <${Icon} name="chevron" size=${16} />
    </button>`;

    return [
        conversation && places && menuGroup("Places", html`<${Places} common />`, all),
        conversation &&
            menuGroup("This session", [
                ...quickRows(),
                // A module's session rows (`pocket.menu` with `group: "session"`) show here, one tap from the menu.
                ...(conversation.kind === "session"
                    ? extensionMenuItems("session").map((each) =>
                          menuRow(each.label, each.run, { icon: "grid", hint: each.hint }),
                      )
                    : []),
                sectionRow("commands", "more", "More session commands"),
            ]),
        menuGroup("Application", [
            menuRow("Appearance", () => openSheet({ type: "appearance" }), {
                icon: "palette",
                next: true,
            }),
            sectionRow("settings", "sliders"),
        ]),
    ];
}

function workspaceGroups() {
    const { server, view } = store.state;
    const { conversation, session, steer, driving } = sessionAccess();
    const { turns } = view;

    return [
        menuGroup("Workspace", [
            conversation?.worktree && steer
                ? item(
                      "Worktree",
                      () => openSheet({ type: "worktree" }),
                      conversation.worktree.branch,
                  )
                : conversation &&
                  steer &&
                  driving &&
                  !scoped() &&
                  item(
                      "Working directory",
                      () => openSheet({ type: "cwd", mode: "change" }),
                      shortPath(view.agent?.cwd, server?.home),
                  ),
            conversation &&
                trustAvailable() &&
                item("Project trust", () => openSheet({ type: "trust" }), trustHint()),
            conversation &&
                browserAvailable() &&
                store.state.browserOpen &&
                item(
                    "Close the browser",
                    () => {
                        setBrowserOpen(false);
                        closeSheet();
                    },
                    store.state.browser?.open && displayUrl(store.state.browser.url),
                ),
        ]),
        menuGroup("Collaboration", [
            conversation &&
                collab() &&
                canToggleTurns() &&
                item(
                    turns?.on ? "Turn off take turns" : "Take turns",
                    () =>
                        attempt(async () => {
                            await actions.turns(turns?.on ? "off" : "on");
                            closeSheet();
                        }),
                    turns?.on
                        ? "anyone here can send to Pi again"
                        : "one person drives Pi at a time",
                ),
        ]),
        menuGroup(
            "Subagents",
            view.subagents.map((agent) =>
                item(
                    html`${agent.busy ? html`<span class="pulse"></span> ` : ""}${agent.name}`,
                    () => openSubagent(agent.conversationId),
                    agent.busy ? "working" : "idle",
                ),
            ),
        ),
    ];
}

function contextGroups(memory) {
    const { view } = store.state;
    const { conversation, steer, driving, session } = sessionAccess();

    return [
        menuGroup("Agent", [
            session &&
                steer &&
                driving &&
                item(
                    "Instructions for Pi",
                    () => openSheet({ type: "instructions" }),
                    view.agent?.instructions ? "on" : "none",
                ),
            conversation &&
                steer &&
                driving &&
                item(
                    "Compact context",
                    () => openSheet({ type: "compact" }),
                    "summarize older messages",
                ),
            conversation &&
                steer &&
                driving &&
                item(
                    "New context",
                    () => openSheet({ type: "reset" }),
                    "Pi starts fresh; history stays",
                ),
            conversation &&
                memoryAvailable() &&
                item("Memory", () => openSheet({ type: "memory" }), memoryHint(memory)),
        ]),
        menuGroup("Automation", [
            schedulesAvailable() &&
                item(
                    "Scheduled messages",
                    () => openSheet({ type: "schedules" }),
                    schedulesHint(view.schedules),
                ),
            watchAvailable() &&
                steer &&
                view.watch?.status !== "watching" &&
                item(
                    "Watch pull request",
                    () => {
                        closeSheet();
                        attempt(() => watchPr());
                    },
                    "fix CI, answer reviews",
                ),
        ]),
    ];
}

function ContextPage() {
    return contextGroups(useMemory());
}

function commands() {
    const { conversation, session, steer } = sessionAccess();

    return [
        menuGroup("Organize", [
            ...quickRows(),
            session &&
                item(
                    "Mark unread",
                    () => {
                        setUnread(conversation.id, true);
                        closeSheet();
                        navigate(null);
                    },
                    "this browser; opening it again clears it",
                ),
            conversation &&
                html`<a class="list-item" href=${`/api/c/${conversation.id}/export`} download>
                    <span>Export as Markdown</span>
                    <span class="muted small">the whole history</span>
                </a>`,
            session &&
                steer &&
                item(conversation.archived ? "Unarchive" : "Archive", () => {
                    closeSheet();
                    setArchived([conversation.id], !conversation.archived);
                }),
        ]),
        menuGroup("Session setup", [
            workspaceGroups().some(Boolean) && sectionRow("manage", "folder"),
            contextGroups(null).some(Boolean) && sectionRow("context", "sliders"),
        ]),
    ];
}

function settings() {
    const { me, server } = store.state;
    const embedder = hostMenu();
    const owner = me?.role === "owner";

    return [
        menuGroup("Preferences", [
            item("Appearance", () => openSheet({ type: "appearance" }), lookLabel()),
            !touch && item("Keyboard shortcuts", () => openSheet({ type: "shortcuts" }), "?"),
            owner &&
                defaultsKept() &&
                item(
                    "Default model",
                    () => openSheet({ type: "model", id: "default", forDefault: true }),
                    defaultLabel(server?.defaultModel, store.state.models) ||
                        "project, last picked, then Pi global",
                ),
            collab() &&
                item(
                    "Notifications",
                    () => openSheet({ type: "notifications" }),
                    "Pi finished, approvals, chat",
                ),
        ]),
        menuGroup("Administration", [
            collab()
                ? item(
                      "People",
                      () => openSheet({ type: "people" }),
                      me?.role === "viewer" ? "you can view" : "",
                  )
                : item("Sign in another device", () => openSheet({ type: "invite" })),
            item(
                "Spend",
                () => openSheet({ type: "spend" }),
                owner ? "by person and session, limits" : "yours",
            ),
            owner && item("Providers", () => openSheet({ type: "providers" })),
            modelRefreshAvailable() &&
                item(
                    "Refresh models",
                    refreshModels,
                    store.state.modelRefresh.loading ? "refreshing…" : "models.json and providers",
                ),
            sectionRow("ext"),
        ]),
        menuGroup(
            "Server",
            owner &&
                server?.supervised &&
                item(
                    "Restart server",
                    () =>
                        attempt(async () => {
                            await api("restart", {});
                            closeSheet();
                            notify("info", "Restarting. Running work continues after the restart.");
                        }),
                    "running work resumes",
                ),
        ),
        menuGroup(
            embedder.title,
            embedder.items.map((each) => item(each.label, each.run, each.hint)),
        ),
    ];
}

function extensionGroup() {
    return menuGroup("Application", [
        item("Extensions", () => openSheet({ type: "extensions" }), extensionsHint()),
        triggersOn() &&
            store.state.me?.role !== "viewer" &&
            item(
                "Webhooks and watches",
                () => openSheet({ type: "hooks" }),
                "GitHub, other services",
            ),
        extensionMenuItems().map((each) => item(each.label, each.run, each.hint)),
    ]);
}

export function MenuSheet({ section = "menu", places = true }) {
    let body;
    let eyebrow = "Session menu";

    switch (section) {
        case "all":
            body = menuGroup("In this session", html`<${Places} />`);
            break;
        case "commands":
            body = commands();
            break;
        case "manage":
            eyebrow = TITLES.commands;
            body = workspaceGroups();
            break;
        case "context":
            eyebrow = TITLES.commands;
            body = html`<${ContextPage} />`;
            break;
        case "settings":
            eyebrow = "Pi Pocket";
            body = settings();
            break;
        case "ext":
            eyebrow = TITLES.settings;
            body = extensionGroup();
            break;
        default:
            body = overview(places);
    }

    return html`<${MenuFrame}
        title=${TITLES[section] ?? store.state.view.conversation?.title ?? "Menu"}
        eyebrow=${eyebrow}
    >
        ${body}
    <//>`;
}
