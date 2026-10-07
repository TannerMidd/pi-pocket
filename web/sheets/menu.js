// The menu: what can be done in this session and in the app.
import { browserAvailable, displayUrl, setBrowserOpen } from "../browser.js";
import { schedulesAvailable } from "../commands.js";
import { filesAvailable, setFilesOpen } from "../files-panel.js";
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
import { branchAvailable, headLabel } from "./branch.js";
import { copyText, html, item, Sheet, shortPath } from "../ui.js";

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

    return html`<${Sheet} title=${conversation?.title ?? "Menu"} onClose=${closeSheet}>
        ${conversation && collab() && item("People here", () => openSheet({ type: "chat" }), "chat, pinned, notes")}
        ${
            conversation &&
            collab() &&
            steer &&
            (!turns?.on || canStopTurns) &&
            item(
                turns?.on ? "Turn off take turns" : "Take turns",
                () =>
                    attempt(async () => {
                        await actions.turns(turns?.on ? "off" : "on");
                        closeSheet();
                    }),
                turns?.on ? "anyone here can send to Pi again" : "one person drives Pi at a time",
            )
        }
        ${session && steer && item("Rename", () => openSheet({ type: "rename" }))}
        ${
            session &&
            item(
                isPinned(conversation.id) ? "Unpin from the top" : "Pin to the top",
                () => {
                    togglePin(conversation.id);
                    closeSheet();
                },
                "this browser",
            )
        }
        ${
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
                  )
        }
        ${
            conversation &&
            browserAvailable() &&
            item(
                store.state.browserOpen ? "Close the browser" : "Browser",
                () => {
                    setBrowserOpen(!store.state.browserOpen);
                    closeSheet();
                },
                (store.state.browser?.open && displayUrl(store.state.browser.url)) ||
                    "see and test pages with Pi",
            )
        }
        ${conversation && branchAvailable() && item("Branch", () => openSheet({ type: "branch" }), headLabel(view.branch))}
        ${conversation && item("Find in session", () => openSheet({ type: "find" }), "messages, commands, files")}
        ${conversation && filesAvailable() && item("Files", () => setFilesOpen(true, "files"), "browse the folder, read files")}
        ${conversation && filesAvailable() && item("Changes", () => setFilesOpen(true, "changes"), "review what changed")}
        ${session && steer && driving && item("Instructions for Pi", () => openSheet({ type: "instructions" }), instructions ? "on" : "none")}
        ${conversation && steer && driving && item("Compact context", () => openSheet({ type: "compact" }), "summarize older messages")}
        ${conversation && steer && driving && item("New context", () => openSheet({ type: "reset" }), "Pi starts fresh; history stays")}
        ${schedulesAvailable() && item("Scheduled messages", () => openSheet({ type: "schedules" }), view.schedules.length === 0 ? "none" : `${view.schedules.length} coming`)}
        ${
            conversation &&
            item("Copy link", () =>
                copyText(location.href).then(
                    () => notify("info", "Link copied. Other signed-in devices can open it."),
                    () => notify("error", "Could not copy."),
                ),
            )
        }
        ${
            conversation &&
            html`<a class="list-item" href=${`/api/c/${conversation.id}/export`} download>
                <span>Export as Markdown</span>
                <span class="muted small">the whole history</span>
            </a>`
        }
        ${
            session &&
            steer &&
            item(conversation.archived ? "Unarchive" : "Archive", () => {
                closeSheet();
                setArchived([conversation.id], !conversation.archived);
            })
        }
        ${
            view.subagents.length > 0 &&
            html`<div class="group">
                <div class="group-title">Subagents</div>
                ${view.subagents.map((agent) =>
                    item(
                        html`${agent.busy ? html`<span class="pulse"></span> ` : ""}${agent.name}`,
                        () => navigate(agent.conversationId),
                        agent.busy ? "working" : "idle",
                    ),
                )}
            </div>`
        }
        <div class="group">
            <div class="group-title">App</div>
            ${item("Appearance", () => openSheet({ type: "appearance" }), paletteOf().name)}
            ${item("Your name", () => openSheet({ type: "name" }), me?.name)}
            ${collab() ? item("People", () => openSheet({ type: "people" }), me?.role === "viewer" ? "you can view" : "") : item("Sign in another device", () => openSheet({ type: "invite" }))}
            ${collab() && item("Notifications", () => openSheet({ type: "notifications" }), "Pi finished, approvals, chat")}
            ${item("Running now", () => openSheet({ type: "running" }), "everything Pi is doing")}
            ${item("Spend", () => openSheet({ type: "spend" }), me?.role === "owner" ? "by person and session, limits" : "yours")}
            ${item("Providers", () => openSheet({ type: "providers" }))}
            ${item("Extensions", () => openSheet({ type: "extensions" }), store.state.guard?.enabled ? "Lancet Guard on" : store.state.guard?.available ? "Lancet Guard off" : "")}
            ${
                me?.role === "owner" &&
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
                )
            }
            ${item("Sign out", () =>
                attempt(async () => {
                    await api("logout", {});
                    location.href = "/";
                }),
            )}
        </div>
    <//>`;
}
