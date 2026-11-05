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
import { t } from "../ui-locale.js";

// Key hints are for people with a keyboard: a touch screen has none.
const touch = matchMedia("(pointer: coarse)").matches;

/** The Extensions row's hint: that this tab loads none of their browser parts (safe mode), and Lancet Guard. */
function extensionsHint() {
    const { guard } = store.state;

    return [
        safeMode() &&
            t("web.sheets.menu.extensions-hint.text.browser-parts-off", "browser parts off here"),
        guard?.enabled
            ? t("web.sheets.menu.extensions-hint.text.lancet-guard", "Lancet Guard on")
            : guard?.available
              ? t("web.sheets.menu.extensions-hint.text.lancet-guard-off", "Lancet Guard off")
              : "",
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
        label: () => t("app.files", "Files"),
        place: () =>
            filesAvailable() && {
                icon: "folder",
                on: store.state.filesOpen && store.state.filesTab === "files",
                run: () => setFilesOpen(true, "files"),
            },
    },
    {
        id: "core:changes",
        label: () => t("app.changes", "Changes"),
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
                    counted:
                        count === 1
                            ? t("web.sheets.menu.place.counted.changed-file", "changed file")
                            : t("web.sheets.menu.place.counted.changed-files", "changed files"),
                    on: store.state.filesOpen && store.state.filesTab === "changes",
                    run: () => setFilesOpen(true, "changes"),
                }
            );
        },
    },
    {
        id: "core:browser",
        label: () => t("app.browser", "Browser"),
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
        label: () => t("app.artifacts", "Artifacts"),
        place: () => ({
            icon: "artifact",
            count: store.state.view.artifacts.length,
            run: () => openSheet({ type: "artifacts" }),
        }),
    },
    {
        id: "core:chat",
        label: () => t("menu.chat", "Chat"),
        place: () =>
            collab() && {
                icon: "chat",
                count: chatUnread(),
                counted: t("web.sheets.menu.place.counted.unread", "unread"),
                run: () => openSheet({ type: "chat" }),
            },
    },
    {
        id: "core:find",
        label: () => t("menu.find", "Find"),
        place: () => ({ icon: "search", run: () => openSheet({ type: "find" }) }),
    },
    {
        // Ctrl K's launcher, for touch screens that have no keyboard to open it.
        id: "core:launcher",
        label: () => t("menu.launcher", "Launcher"),
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
        label: () => t("menu.branch", "Branch"),
        place: () =>
            branchAvailable() && { icon: "fork", run: () => openSheet({ type: "branch" }) },
    },
    {
        id: "core:pip",
        label: () => t("menu.pip", "PiP"),
        place: () =>
            pipAvailable() && {
                icon: "pip",
                dot: pipUnread(),
                dotLabel: t("web.sheets.menu.place.dot-label.something-new", "something new"),
                run: () => {
                    openPip();
                    closeSheet();
                },
            },
    },
    {
        id: "core:peeks",
        label: () => t("menu.peeks", "Peeks"),
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
            // The label is read as the tile draws, so it follows the language now (`ui-locale.js`).
            const name = label();

            // As before slots: `data-place="files"`, which tests and themes may select.
            return (
                shown &&
                html`<${PlaceTile} place=${{ id: id.replace(/^core:/, ""), label: name, ...shown }} />`
            );
        },
    }),
);

function PlacesGrid({ changes = null }) {
    return html`<nav class="places" aria-label=${t("menu.places", "Places")}>
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
        title=${conversation?.title ?? t("menu.open", "Open")}
        onClose=${closeSheet}
        className="places-sheet"
    >
        <${Places} />
        ${item(
            t("app.session-menu", "Session menu"),
            () => openSheet({ type: "menu", fromPlaces: true }),
            t(
                "web.sheets.menu.places-sheet.text.rename-context-settings",
                "rename, context, settings",
            ),
        )}
    <//>`;
}

/** Keep Sheet's Esc, drag, and focus handling; the sheet trail already owns its back-stack layer. */
function MenuFrame({ title, children }) {
    const host = useRef(null);

    useLayoutEffect(() => {
        const element = host.current;
        // Not by its label: that is translated, and the button is the top bar's one dialog opener.
        const button = document.querySelector('.topbar [aria-haspopup="dialog"]');
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
        return t("web.sheets.menu.trust-hint.text.not-decided", "not decided");
    }

    // No decision, and nothing waiting for one: there is nothing to say.
    if (info.saved === null && info.defaultProjectTrust === "ask") {
        return "";
    }

    return info.trusted
        ? t("web.sheets.menu.trust-hint.text.trusted", "trusted")
        : t("web.sheets.menu.trust-hint.text.not-trusted", "not trusted");
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

    return html`<${MenuFrame} title=${conversation?.title ?? t("web.sheets.menu.menu-sheet.text.menu", "Menu")}>
        ${places && html`<${Places} />`}
        <div class="menu-session">
            ${
                conversation &&
                collab() &&
                canToggleTurns() &&
                item(
                    turns?.on
                        ? t(
                              "web.sheets.menu.menu-sheet.text.turn-off-take-turns",
                              "Turn off take turns",
                          )
                        : t("web.sheets.menu.menu-sheet.text.take-turns", "Take turns"),
                    () =>
                        attempt(async () => {
                            await actions.turns(turns?.on ? "off" : "on");
                            closeSheet();
                        }),
                    turns?.on
                        ? t(
                              "web.sheets.menu.menu-sheet.text.anyone-send-pi-again",
                              "anyone here can send to Pi again",
                          )
                        : t(
                              "web.sheets.menu.menu-sheet.text.one-person-drives-pi",
                              "one person drives Pi at a time",
                          ),
                )
            }
            ${session && steer && item(t("menu.rename", "Rename"), () => openSheet({ type: "rename" }))}
            ${
                session &&
                item(
                    isPinned(conversation.id)
                        ? t("web.sheets.menu.menu-sheet.text.unpin-top", "Unpin from the top")
                        : t("web.sheets.menu.menu-sheet.text.pin-top", "Pin to the top"),
                    () => {
                        togglePin(conversation.id);
                        closeSheet();
                    },
                    t("web.sheets.menu.menu-sheet.text.browser", "this browser"),
                )
            }
            ${
                session &&
                item(
                    t("web.sheets.menu.menu-sheet.text.mark-unread", "Mark unread"),
                    () => {
                        setUnread(conversation.id, true);
                        closeSheet();
                        navigate(null);
                    },
                    t(
                        "web.sheets.menu.menu-sheet.text.browser-opening-again-clears",
                        "this browser; opening it again clears it",
                    ),
                )
            }
            ${
                conversation?.worktree && steer
                    ? item(
                          t("web.sheets.menu.menu-sheet.text.worktree", "Worktree"),
                          () => openSheet({ type: "worktree" }),
                          conversation.worktree.branch,
                      )
                    : conversation &&
                      steer &&
                      driving &&
                      !scoped() &&
                      item(
                          t(
                              "web.sheets.menu.menu-sheet.text.working-directory",
                              "Working directory",
                          ),
                          () => openSheet({ type: "cwd", mode: "change" }),
                          shortPath(view.agent?.cwd, server?.home),
                      )
            }
            ${
                conversation &&
                browserAvailable() &&
                store.state.browserOpen &&
                item(
                    t("web.sheets.menu.menu-sheet.text.close-browser", "Close the browser"),
                    () => {
                        setBrowserOpen(false);
                        closeSheet();
                    },
                    store.state.browser?.open && displayUrl(store.state.browser.url),
                )
            }
            ${conversation && trustAvailable() && item(t("menu.trust", "Project trust"), () => openSheet({ type: "trust" }), trustHint())}
            ${session && extensionMenuItems("session").map((each) => item(each.label, each.run, each.hint))}
            ${
                session &&
                steer &&
                driving &&
                item(
                    t("menu.instructions", "Instructions for Pi"),
                    () => openSheet({ type: "instructions" }),
                    instructions
                        ? t("web.sheets.menu.menu-sheet.text.content", "on")
                        : t("web.sheets.menu.menu-sheet.text.none", "none"),
                )
            }
            ${
                conversation &&
                steer &&
                driving &&
                item(
                    t("menu.compact", "Compact context"),
                    () => openSheet({ type: "compact" }),
                    t(
                        "web.sheets.menu.menu-sheet.text.summarize-older-messages",
                        "summarize older messages",
                    ),
                )
            }
            ${
                conversation &&
                steer &&
                driving &&
                item(
                    t("menu.new-context", "New context"),
                    () => openSheet({ type: "reset" }),
                    t(
                        "web.sheets.menu.menu-sheet.text.pi-starts-fresh-history",
                        "Pi starts fresh; history stays",
                    ),
                )
            }
            ${conversation && memoryAvailable() && item(t("menu.memory", "Memory"), () => openSheet({ type: "memory" }), memoryHint(memory))}
            ${
                schedulesAvailable() &&
                item(
                    t("menu.schedules", "Scheduled messages"),
                    () => openSheet({ type: "schedules" }),
                    view.schedules.length === 0
                        ? t("web.sheets.menu.menu-sheet.text.none", "none")
                        : t("web.sheets.menu.menu-sheet.text.coming", "{count} coming", {
                              count: view.schedules.length,
                          }),
                )
            }
            ${
                watchAvailable() &&
                steer &&
                view.watch?.status !== "watching" &&
                item(
                    t("web.sheets.menu.menu-sheet.text.watch-pull-request", "Watch pull request"),
                    () => {
                        closeSheet();
                        attempt(() => watchPr());
                    },
                    t(
                        "web.sheets.menu.menu-sheet.text.fix-ci-answer-reviews",
                        "fix CI, answer reviews",
                    ),
                )
            }
            ${
                conversation &&
                item(t("menu.copy-link", "Copy link"), () =>
                    copyText(location.href).then(
                        () =>
                            notify(
                                "info",
                                t(
                                    "web.sheets.menu.menu-sheet.text.link-copied-other-signed",
                                    "Link copied. Other signed-in devices can open it.",
                                ),
                            ),
                        () =>
                            notify(
                                "error",
                                t("web.sheets.menu.menu-sheet.text.not-copy", "Could not copy."),
                            ),
                    ),
                )
            }
            ${
                conversation &&
                html`<a class="list-item" href=${`/api/c/${conversation.id}/export`} download>
                    <span>${t(
                        "web.sheets.menu.menu-sheet.span.export-as-markdown",
                        "Export as Markdown",
                    )}</span>
                    <span class="muted small">${t(
                        "web.sheets.menu.menu-sheet.span.the-whole-history",
                        "the whole history",
                    )}</span>
                </a>`
            }
            ${
                session &&
                steer &&
                item(
                    conversation.archived
                        ? t("web.sheets.menu.menu-sheet.text.unarchive", "Unarchive")
                        : t("web.sheets.menu.menu-sheet.text.archive", "Archive"),
                    () => {
                        closeSheet();
                        setArchived([conversation.id], !conversation.archived);
                    },
                )
            }
        </div>
        ${
            view.subagents.length > 0 &&
            html`<div class="group">
                <div class="group-title">${t(
                    "web.sheets.menu.menu-sheet.div.subagents",
                    "Subagents",
                )}</div>
                ${view.subagents.map((agent) =>
                    item(
                        html`${agent.busy ? html`<span class="pulse"></span> ` : ""}${agent.name}`,
                        () => openSubagent(agent.conversationId),
                        agent.busy
                            ? t("web.sheets.menu.menu-sheet.text.working", "working")
                            : t("web.sheets.menu.menu-sheet.text.idle", "idle"),
                    ),
                )}
            </div>`
        }
        <div class="group">
            <div class="group-title">${t("web.sheets.menu.menu-sheet.div.app", "App")}</div>
            ${item(t("menu.appearance", "Appearance"), () => openSheet({ type: "appearance" }), lookLabel())}
            ${!touch && item(t("menu.shortcuts", "Keyboard shortcuts"), () => openSheet({ type: "shortcuts" }), "?")}
            ${
                me?.role === "owner" &&
                defaultsKept() &&
                item(
                    t("web.sheets.menu.menu-sheet.text.default-model", "Default model"),
                    () => openSheet({ type: "model", id: "default", forDefault: true }),
                    defaultLabel(server?.defaultModel, store.state.models) ||
                        t(
                            "web.sheets.menu.menu-sheet.text.project-last-picked-pi",
                            "project, last picked, then Pi global",
                        ),
                )
            }
            ${item(t("menu.your-name", "Your name"), () => openSheet({ type: "name" }), me?.name)}
            ${collab() ? item(t("app.people", "People"), () => openSheet({ type: "people" }), me?.role === "viewer" ? t("web.sheets.menu.menu-sheet.text.view", "you can view") : "") : item(t("menu.devices", "Sign in another device"), () => openSheet({ type: "invite" }))}
            ${
                collab() &&
                item(
                    t("menu.notifications", "Notifications"),
                    () => openSheet({ type: "notifications" }),
                    t(
                        "web.sheets.menu.menu-sheet.text.pi-finished-approvals-chat",
                        "Pi finished, approvals, chat",
                    ),
                )
            }
            ${item(
                t("menu.running", "Running now"),
                () => openSheet({ type: "running" }),
                t("web.sheets.menu.menu-sheet.text.everything-pi-doing", "everything Pi is doing"),
            )}
            ${item(
                t("menu.spend", "Spend"),
                () => openSheet({ type: "spend" }),
                me?.role === "owner"
                    ? t(
                          "web.sheets.menu.menu-sheet.text.person-session-limits",
                          "by person and session, limits",
                      )
                    : t("web.sheets.menu.menu-sheet.text.yours", "yours"),
            )}
            ${
                triggersOn() &&
                me?.role !== "viewer" &&
                item(
                    t("menu.webhooks", "Webhooks and watches"),
                    () => openSheet({ type: "hooks" }),
                    t(
                        "web.sheets.menu.menu-sheet.text.git-hub-other-services",
                        "GitHub, other services",
                    ),
                )
            }
            ${me?.role === "owner" && item(t("menu.providers", "Providers"), () => openSheet({ type: "providers" }))}
            ${
                modelRefreshAvailable() &&
                item(
                    t("menu.refresh-models", "Refresh models"),
                    refreshModels,
                    store.state.modelRefresh.loading
                        ? t("web.sheets.menu.menu-sheet.text.refreshing", "refreshing…")
                        : t(
                              "web.sheets.menu.menu-sheet.text.models-json-providers",
                              "models.json and providers",
                          ),
                )
            }
            ${extensionMenuItems().map((each) => item(each.label, each.run, each.hint))}
            ${item(t("menu.extensions", "Extensions"), () => openSheet({ type: "extensions" }), extensionsHint())}
            ${
                me?.role === "owner" &&
                server?.supervised &&
                item(
                    t("web.sheets.menu.menu-sheet.text.restart-server", "Restart server"),
                    () =>
                        attempt(async () => {
                            await api("restart", {});
                            closeSheet();
                            notify(
                                "info",
                                t(
                                    "web.sheets.menu.menu-sheet.text.restarting-running-work-continues",
                                    "Restarting. Running work continues after the restart.",
                                ),
                            );
                        }),
                    t(
                        "web.sheets.menu.menu-sheet.text.running-work-resumes",
                        "running work resumes",
                    ),
                )
            }
            ${item(
                html`<span class="menu-signout">${t(
                    "web.sheets.menu.menu-sheet.span.sign-out",
                    "Sign out",
                )}</span>`,
                signOut,
            )}
        </div>
    <//>`;
}
