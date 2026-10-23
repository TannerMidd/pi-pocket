import { t } from "../i18n.js";
// The menu: what can be done in this session and in the app.
import { useLayoutEffect, useRef } from "preact/hooks";
import { browserAvailable, displayUrl, setBrowserOpen } from "../browser.js";
import { chatUnread } from "../chat.js";
import { schedulesAvailable, triggersOn, watchAvailable, watchPr } from "../commands.js";
import { extensionMenuItems, safeMode } from "../extension-ui.js";
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
    signOut,
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

/** The Extensions row's hint: that this tab loads none of their browser parts (safe mode), and Lancet Guard. */
function extensionsHint() {
    const { guard } = store.state;

    return [
        safeMode() && t("browser parts off here"),
        guard?.enabled ? t("Lancet Guard on") : guard?.available ? t("Lancet Guard off") : "",
    ]
        .filter(Boolean)
        .join(" · ");
}

/**
 * The session's places as big tiles at the top of the menu: Files, Changes, the browser, artifacts, the chat, find,
 * the branch, and peek tiles. The top bar keeps only the buttons with something to say; these are always here, a
 * thumb's width each.
 */
function Places() {
    if (!store.state.view.conversation) {
        return null;
    }

    return filesAvailable() ? html`<${PlacesWithChanges} />` : html`<${PlacesGrid} />`;
}

/** Only people who can open Files request its shared changes data, just as the top bar does. */
function PlacesWithChanges() {
    const { changes } = useChanges();

    return html`<${PlacesGrid} changes=${changes} />`;
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

function PlacesGrid({ changes = null }) {
    return html`<nav class="places" aria-label=${t("Places")}>
        ${slotItems("places", { changes }).map(({ node }) => node)}
    </nav>`;
}

/**
 * The places alone, in a short sheet that stays near the bottom edge: what the button beside the message box and a
 * swipe up from it open on a phone, a thumb's reach away. The rest of the menu is a row below.
 */
export function PlacesSheet() {
    const conversation = store.state.view.conversation;

    return html`<${Sheet}
        title=${conversation?.title ?? t("Open")}
        onClose=${closeSheet}
        className="places-sheet"
    >
        <${Places} />
        ${item(t("Session menu"), () => openSheet({ type: "menu", fromPlaces: true }), t("rename, context, settings"))}
    <//>`;
}

/** Keep Sheet's Esc, drag, and focus handling; the sheet trail already owns its back-stack layer. */
function MenuFrame({ title, children }) {
    const host = useRef(null);

    useLayoutEffect(() => {
        const element = host.current;
        const button = document.querySelector('.topbar [aria-label="Menu"]');
        const active = document.activeElement;
        const opener = active === document.body ? button : active;

        const place = () => {
            const rect = button?.getBoundingClientRect();
            const top = (rect?.bottom ?? 58) + 6;
            const bottom =
                (visualViewport?.offsetTop ?? 0) + (visualViewport?.height ?? innerHeight);
            const left = Math.max(
                8,
                Math.min((rect?.right ?? innerWidth - 8) - 360, innerWidth - 368),
            );

            element.style.setProperty("--menu-left", `${left}px`);
            element.style.setProperty("--menu-top", `${top}px`);
            element.style.setProperty("--menu-height", `${Math.max(100, bottom - top - 8)}px`);
        };

        const body = element.querySelector(".sheet-body");

        if (menuScroll !== null) {
            body.scrollTop = menuScroll;
            menuScroll = null;
        }

        place();
        addEventListener("resize", place);
        visualViewport?.addEventListener("resize", place);

        return () => {
            removeEventListener("resize", place);
            visualViewport?.removeEventListener("resize", place);

            // Another sheet open now: the menu is going back under it, not closing.
            if (store.state.sheet) {
                menuScroll = body.scrollTop;
            }

            const focused = document.activeElement;
            const back = opener?.isConnected ? opener : button;
            // As sheets.js does: not behind a sheet the menu opened, and not into a text field on a touch screen,
            // where its keyboard would pop up.
            const field =
                matchMedia("(pointer: coarse)").matches &&
                back?.matches("input, textarea, [contenteditable]");

            if (
                !store.state.sheet &&
                !field &&
                (focused === document.body || element.contains(focused)) &&
                back?.isConnected
            ) {
                back.focus({ preventScroll: true });
            }
        };
    }, []);

    const onKey = (event) => {
        if (
            event.defaultPrevented ||
            event.isComposing ||
            event.keyCode === 229 ||
            event.altKey ||
            event.ctrlKey ||
            event.metaKey
        ) {
            return;
        }

        const items = [...host.current.querySelectorAll(".place, .list-item")];
        const active = document.activeElement;
        const index = items.indexOf(active);
        let target;

        if (event.key === "Tab") {
            // Close stays reachable with Tab, but is not part of the menu's item navigation.
            const controls = [...items, ...host.current.querySelectorAll(".sheet-head button")];
            const at = controls.indexOf(active);
            const next =
                at < 0
                    ? event.shiftKey
                        ? controls.length - 1
                        : 0
                    : (at + (event.shiftKey ? -1 : 1) + controls.length) % controls.length;

            target = controls[next];
        } else if (event.key === "Home") {
            target = items[0];
        } else if (event.key === "End") {
            target = items.at(-1);
        } else if (["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft"].includes(event.key)) {
            const down = event.key === "ArrowDown" || event.key === "ArrowRight";
            const vertical = event.key === "ArrowDown" || event.key === "ArrowUp";
            const tiles = host.current.querySelectorAll(".place").length;
            const step = vertical && index >= 0 && index < tiles ? 3 : 1;
            let next = index < 0 ? (down ? 0 : items.length - 1) : index + (down ? step : -step);

            // Down from the grid's last row enters the first text row; Up from its first row wraps to the last item.
            if (vertical && index >= 0 && index < tiles) {
                next = next < 0 ? items.length - 1 : Math.min(next, tiles);
            }

            target = items[(next + items.length) % items.length];
        }

        if (target) {
            event.preventDefault();
            target.focus();
        }
    };

    return html`<div class="nav-menu-host" data-part="menu" ref=${host} onKeyDown=${onKey}>
        <${Sheet} title=${title} onClose=${closeSheet} className="nav-menu">
            ${children}
        <//>
    </div>`;
}

/** The menu's scroll, kept while a sheet it opened shows, so back finds the menu where it was left. */
let menuScroll = null;

store.subscribe(({ sheet }) => {
    if (!sheet) {
        menuScroll = null;
    }
});

/** The project's trust in a word, once the server said. */
function trustHint() {
    const info = currentTrust();

    if (!info) {
        return "";
    }

    if (info.ask) {
        return t("not decided");
    }

    // No decision, and nothing waiting for one: there is nothing to say.
    if (info.saved === null && info.defaultProjectTrust === "ask") {
        return "";
    }

    return t(info.trusted ? "trusted" : "not trusted");
}

/** The menu; `places` is false when it opens from the places sheet, which just showed the tiles. */
export function MenuSheet({ places = true }) {
    const { view, me, server } = store.state;
    const conversation = view.conversation;
    const steer = canSteer();
    const session = conversation?.kind === "session";
    const turns = view.turns;
    // While take turns is on, settings belong to the driver.
    const driving = !turns?.on || turns.driver === me?.id;
    const instructions = view.agent?.instructions;
    const memory = useMemory();

    return html`<${MenuFrame} title=${conversation?.title ?? t("Menu")}>
        ${places && html`<${Places} />`}
        <div class="menu-session">
        ${
            conversation &&
            collab() &&
            canToggleTurns() &&
            item(
                turns?.on ? t("Turn off take turns") : t("Take turns"),
                () =>
                    attempt(async () => {
                        await actions.turns(turns?.on ? "off" : "on");
                        closeSheet();
                    }),
                turns?.on
                    ? t("anyone here can send to Pi again")
                    : t("one person drives Pi at a time"),
            )
        }
        ${session && steer && item(t("Rename"), () => openSheet({ type: "rename" }))}
        ${
            session &&
            item(
                isPinned(conversation.id) ? t("Unpin from the top") : t("Pin to the top"),
                () => {
                    togglePin(conversation.id);
                    closeSheet();
                },
                t("this browser"),
            )
        }
        ${
            session &&
            item(
                t("Mark unread"),
                () => {
                    setUnread(conversation.id, true);
                    closeSheet();
                    navigate(null);
                },
                t("this browser; opening it again clears it"),
            )
        }
        ${
            conversation?.worktree && steer
                ? item(
                      t("Worktree"),
                      () => openSheet({ type: "worktree" }),
                      conversation.worktree.branch,
                  )
                : conversation &&
                  steer &&
                  driving &&
                  !scoped() &&
                  item(
                      t("Working directory"),
                      () => openSheet({ type: "cwd", mode: "change" }),
                      shortPath(view.agent?.cwd, server?.home),
                  )
        }
        ${
            conversation &&
            browserAvailable() &&
            store.state.browserOpen &&
            item(
                t("Close the browser"),
                () => {
                    setBrowserOpen(false);
                    closeSheet();
                },
                store.state.browser?.open && displayUrl(store.state.browser.url),
            )
        }
        ${
            conversation &&
            trustAvailable() &&
            item(t("Project trust"), () => openSheet({ type: "trust" }), trustHint())
        }
        ${
            session &&
            steer &&
            driving &&
            item(
                t("Instructions for Pi"),
                () => openSheet({ type: "instructions" }),
                instructions ? t("on") : t("none"),
            )
        }
        ${
            conversation &&
            steer &&
            driving &&
            item(
                t("Compact context"),
                () => openSheet({ type: "compact" }),
                t("summarize older messages"),
            )
        }
        ${
            conversation &&
            steer &&
            driving &&
            item(
                t("New context"),
                () => openSheet({ type: "reset" }),
                t("Pi starts fresh; history stays"),
            )
        }
        ${
            conversation &&
            memoryAvailable() &&
            item(t("Memory"), () => openSheet({ type: "memory" }), memoryHint(memory))
        }
        ${
            schedulesAvailable() &&
            item(
                t("Scheduled messages"),
                () => openSheet({ type: "schedules" }),
                view.schedules.length === 0
                    ? t("none")
                    : t("{{count}} coming", { count: view.schedules.length }),
            )
        }
        ${
            watchAvailable() &&
            steer &&
            view.watch?.status !== "watching" &&
            item(
                t("Watch pull request"),
                () => {
                    closeSheet();
                    attempt(() => watchPr());
                },
                t("fix CI, answer reviews"),
            )
        }
        ${
            conversation &&
            item(t("Copy link"), () =>
                copyText(location.href).then(
                    () => notify("info", t("Link copied. Other signed-in devices can open it.")),
                    () => notify("error", t("Could not copy.")),
                ),
            )
        }
        ${
            conversation &&
            html`<a class="list-item" href=${`/api/c/${conversation.id}/export`} download>
                <span>${t("Export as Markdown")}</span>
                <span class="muted small">${t("the whole history")}</span>
            </a>`
        }
        ${
            session &&
            steer &&
            item(conversation.archived ? t("Unarchive") : t("Archive"), () => {
                closeSheet();
                setArchived([conversation.id], !conversation.archived);
            })
        }
        </div>
        ${
            view.subagents.length > 0 &&
            html`<div class="group">
                <div class="group-title">${t("Subagents")}</div>
                ${view.subagents.map((agent) =>
                    item(
                        html`${agent.busy ? html`<span class="pulse"></span> ` : ""}${agent.name}`,

                        () => openSubagent(agent.conversationId),
                        t(agent.busy ? "working" : "idle"),
                    ),
                )}
            </div>`
        }
        <div class="group">
            <div class="group-title">${t("App")}</div>
            ${item(t("Appearance"), () => openSheet({ type: "appearance" }), lookLabel())}
            ${!touch && item(t("Keyboard shortcuts"), () => openSheet({ type: "shortcuts" }), "?")}
            ${
                me?.role === "owner" &&
                defaultsKept() &&
                item(
                    t("Default model"),
                    () => openSheet({ type: "model", id: "default", forDefault: true }),
                    defaultLabel(server?.defaultModel, store.state.models) ||
                        t("project, last picked, then Pi global"),
                )
            }
            ${item(t("Your name"), () => openSheet({ type: "name" }), me?.name)}
            ${collab() ? item(t("People"), () => openSheet({ type: "people" }), me?.role === "viewer" ? t("you can view") : "") : item(t("Sign in another device"), () => openSheet({ type: "invite" }))}
            ${collab() && item(t("Notifications"), () => openSheet({ type: "notifications" }), t("Pi finished, approvals, chat"))}
            ${item(t("Running now"), () => openSheet({ type: "running" }), t("everything Pi is doing"))}
            ${item(t("Spend"), () => openSheet({ type: "spend" }), me?.role === "owner" ? t("by person and session, limits") : t("yours"))}
            ${triggersOn() && me?.role !== "viewer" && item(t("Webhooks and watches"), () => openSheet({ type: "hooks" }), t("GitHub, other services"))}
            ${me?.role === "owner" && item(t("Providers"), () => openSheet({ type: "providers" }))}
            ${modelRefreshAvailable() && item(t("Refresh models"), refreshModels, store.state.modelRefresh.loading ? t("refreshing…") : t("models.json and providers"))}
            ${extensionMenuItems().map((each) => item(each.label, each.run, each.hint))}
            ${item(t("Extensions"), () => openSheet({ type: "extensions" }), extensionsHint())}
            ${
                me?.role === "owner" &&
                server?.supervised &&
                item(
                    t("Restart server"),
                    () =>
                        attempt(async () => {
                            await api("restart", {});
                            closeSheet();
                            notify(
                                "info",
                                t("Restarting. Running work continues after the restart."),
                            );
                        }),
                    t("running work resumes"),
                )
            }
            ${item(html`<span class="menu-signout">${t("Sign out")}</span>`, signOut)}
        </div>
    <//>`;
}
