import { t } from "../i18n.js";
// The menu: what can be done in this session and in the app.
import { browserAvailable, displayUrl, setBrowserOpen } from "../browser.js";
import { chatUnread } from "../chat.js";
import { schedulesAvailable } from "../commands.js";
import { filesAvailable, setFilesOpen } from "../files-panel.js";
import { peeksOn, togglePeeks } from "../peeks.js";
import { setArchived } from "../sessions.js";
import {
    actions,
    api,
    attempt,
    canSteer,
    closeSheet,
    collab,
    navigate,
    notify,
    openSheet,
    scoped,
    store,
} from "../store.js";
import { isPinned, paletteOf, togglePin } from "../theme.js";
import { currentTrust, trustAvailable } from "../trust.js";
import { branchAvailable } from "./branch.js";
import { defaultLabel, defaultsKept } from "./model.js";
import { copyText, html, Icon, item, Sheet, shortPath } from "../ui.js";

/**
 * The session's places as big tiles at the top of the menu: Files, Changes, the browser, artifacts, the chat, find,
 * the branch, and peek tiles. The top bar keeps only the buttons with something to say; these are always here, a
 * thumb's width each.
 */
function Places() {
    const { view, browser, browserOpen, server } = store.state;
    const conversation = view.conversation;

    if (!conversation) {
        return null;
    }

    const live = browser?.open && browser.url !== "" && browser.url !== "about:blank";
    const unread = collab() ? chatUnread() : 0;
    const places = [
        filesAvailable() && {
            id: "files",
            icon: "folder",
            label: t("Files"),
            run: () => setFilesOpen(true, "files"),
        },
        filesAvailable() && {
            id: "changes",
            icon: "diff",
            label: t("Changes"),
            run: () => setFilesOpen(true, "changes"),
        },
        browserAvailable() && {
            id: "browser",
            icon: "globe",
            label: t("Browser"),
            on: browserOpen,
            dot: live,
            run: () => {
                setBrowserOpen(true);
                closeSheet();
            },
        },
        {
            id: "artifacts",
            icon: "artifact",
            label: t("Artifacts"),
            count: view.artifacts.length,
            run: () => openSheet({ type: "artifacts" }),
        },
        collab() && {
            id: "chat",
            icon: "chat",
            label: t("Chat"),
            count: unread,
            counted: "unread",
            run: () => openSheet({ type: "chat" }),
        },
        { id: "find", icon: "search", label: t("Find"), run: () => openSheet({ type: "find" }) },
        branchAvailable() && {
            id: "branch",
            icon: "fork",
            label: t("Branch"),
            run: () => openSheet({ type: "branch" }),
        },
        server?.peeks === true && {
            id: "peeks",
            icon: "tiles",
            label: t("Peeks"),
            on: peeksOn(),
            run: () => {
                togglePeeks();
                closeSheet();
            },
        },
    ].filter(Boolean);

    return html`<nav class="places" aria-label=${t("Places")}>
        ${places.map(
            (place) => html`<button
                key=${place.id}
                type="button"
                class=${`place ${place.on ? "on" : ""}`}
                data-place=${place.id}
                aria-label=${place.count > 0 ? t("{{label}}, {{count}} {{kind}}", { label: place.label, count: place.count, kind: t(place.counted ?? "") }).trim() : place.dot ? t("{{label}}, a page open", { label: place.label }) : place.label}
                aria-pressed=${place.on === undefined ? undefined : place.on ? "true" : "false"}
                onClick=${place.run}
            >
                <span class="place-icon badge-host">
                    <${Icon} name=${place.icon} size=${22} />
                    ${place.count > 0 && html`<span class="badge">${place.count}</span>`}
                    ${place.dot && html`<span class="browser-dot" aria-hidden="true"></span>`}
                </span>
                <span class="place-label">${place.label}</span>
            </button>`,
        )}
    </nav>`;
}

/**
 * The places alone, in a short sheet that stays near the bottom edge: what the button beside the message box and a
 * swipe up from it open on a phone, a thumb's reach away. The rest of the menu is a row below.
 */
export function PlacesSheet() {
    const conversation = store.state.view.conversation;

    return html`<${Sheet} title=${conversation?.title ?? t("Open")} onClose=${closeSheet}>
        <${Places} />
        ${item(t("Session menu"), () => openSheet({ type: "menu" }), t("rename, context, settings"))}
    <//>`;
}

/** The project's trust in a word, once the server said. */
function trustHint() {
    const info = currentTrust();

    if (!info) {
        return "";
    }

    if (info.ask) {
        return "not decided";
    }

    // No decision, and nothing waiting for one: there is nothing to say.
    if (info.saved === null && info.defaultProjectTrust === "ask") {
        return "";
    }

    return info.trusted ? "trusted" : "not trusted";
}

export function MenuSheet() {
    const { view, me, server } = store.state;
    const conversation = view.conversation;
    const steer = canSteer();
    const session = conversation?.kind === "session";
    const turns = view.turns;
    // While take turns is on, settings belong to the driver. Turning it off also works for the owner, or when the
    // driver has left: the same rules the server applies.
    const driving = !turns?.on || turns.driver === me?.id;
    const canStopTurns =
        driving ||
        me?.role === "owner" ||
        !turns.driver ||
        !store.state.presence.some((person) => person.id === turns.driver);
    const instructions = view.agent?.instructions;

    return html`<${Sheet} title=${conversation?.title ?? t("Menu")} onClose=${closeSheet}>
        <${Places} />
        ${
            conversation &&
            collab() &&
            steer &&
            (!turns?.on || canStopTurns) &&
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
        ${conversation && trustAvailable() && item(t("Project trust"), () => openSheet({ type: "trust" }), trustHint())}
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
        ${conversation && steer && driving && item(t("Compact context"), () => openSheet({ type: "compact" }), t("summarize older messages"))}
        ${conversation && steer && driving && item(t("New context"), () => openSheet({ type: "reset" }), t("Pi starts fresh; history stays"))}
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
        ${
            view.subagents.length > 0 &&
            html`<div class="group">
                <div class="group-title">${t("Subagents")}</div>
                ${view.subagents.map((agent) =>
                    item(
                        html`${agent.busy ? html`<span class="pulse"></span> ` : ""}${agent.name}`,
                        () => navigate(agent.conversationId),
                        t(agent.busy ? "working" : "idle"),
                    ),
                )}
            </div>`
        }
        <div class="group">
            <div class="group-title">${t("App")}</div>
            ${item(t("Appearance"), () => openSheet({ type: "appearance" }), paletteOf().name)}
            ${
                me?.role === "owner" &&
                defaultsKept() &&
                item(
                    t("Default model"),
                    () => openSheet({ type: "model", id: "default", forDefault: true }),
                    defaultLabel(server?.defaultModel, store.state.models) ||
                        t("the last one picked"),
                )
            }
            ${item(t("Your name"), () => openSheet({ type: "name" }), me?.name)}
            ${collab() ? item(t("People"), () => openSheet({ type: "people" }), me?.role === "viewer" ? t("you can view") : "") : item(t("Sign in another device"), () => openSheet({ type: "invite" }))}
            ${collab() && item(t("Notifications"), () => openSheet({ type: "notifications" }), t("Pi finished, approvals, chat"))}
            ${item(t("Running now"), () => openSheet({ type: "running" }), t("everything Pi is doing"))}
            ${item(t("Spend"), () => openSheet({ type: "spend" }), me?.role === "owner" ? t("by person and session, limits") : t("yours"))}
            ${item(t("Providers"), () => openSheet({ type: "providers" }))}
            ${item(t("Extensions"), () => openSheet({ type: "extensions" }), store.state.guard?.enabled ? t("Lancet Guard on") : store.state.guard?.available ? t("Lancet Guard off") : "")}

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
            ${item(t("Sign out"), () =>
                attempt(async () => {
                    await api("logout", {});
                    location.href = "/";
                }),
            )}
        </div>
    <//>`;
}
