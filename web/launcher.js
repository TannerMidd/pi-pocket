// The launcher, after Omarchy's Walker: one box for sessions, actions, and themes. Mod+K opens it anywhere. Arrowing
// onto a theme shows it at once; Enter keeps it, Escape goes back. Start with > for actions only, @ for sessions, # for
// themes.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { browserAvailable, toggleBrowser } from "./browser.js";
import { folderColor } from "./avatar.js";
import {
    planAvailable,
    schedulesAvailable,
    triggersOn,
    watchAvailable,
    watchPr,
} from "./commands.js";
import { extensionLauncherItems, sessionWords } from "./extension-ui.js";
import { filesAvailable, toggleFiles } from "./files-panel.js";
import { useDragToClose } from "./gestures.js";
import { togglePeeks } from "./peeks.js";
import { modelRefreshAvailable, refreshModels } from "./model-refresh.js";
import { openPip, pipAvailable } from "./pip.js";
import { setArchived, toggleBoard } from "./sessions.js";
import { branchAvailable, headLabel } from "./sheets/branch.js";
import { recentLabels } from "./sheets/folder.js";
import { galleryAvailable } from "./sheets/gallery.js";
import { memoryAvailable } from "./sheets/memory.js";
import { piSessionsAvailable } from "./sheets/pi-sessions.js";
import {
    actions,
    attempt,
    api,
    canSteer,
    canToggleTurns,
    collab,
    navigate,
    notify,
    openSheet,
    scoped,
    sessionOrder,
    setUnread,
    signOut,
    openId,
    store,
    workspaceOrder,
} from "./store.js";
import {
    BASE_LOOK,
    chooseLook,
    folderPaletteIds,
    isPinned,
    lookIds,
    paletteOf,
    prefs,
    preview,
    setPrefs,
    themeIds,
    themeVars,
    togglePin,
    varsStyle,
} from "./theme.js";
import { trustAvailable } from "./trust.js";
import {
    APPLE,
    BOTTOM_SHEETS,
    copyText,
    html,
    Icon,
    Keys,
    Marked,
    scrimPress,
    shortPath,
    timeAgo,
} from "./ui.js";
import { t } from "./ui-locale.js";

/** How far a letter that does not begin a word may be from the one before it, in a match that is not contiguous. */
const MAX_GAP = 3;

/**
 * How well `query` matches `text` as a subsequence: null for no match, else a score (higher is better) and the matched
 * places. Runs of letters, letters at word starts, and an early first letter count for more. Letters scattered through a
 * text must stay close (within a few characters) or begin a word, so "files" does not match "fix the login loop".
 */
function fuzzy(text, query) {
    if (query === "") {
        return { score: 0, hits: [] };
    }

    const hay = text.toLowerCase();
    const plain = hay.indexOf(query);

    if (plain !== -1) {
        const start = plain === 0 || /[\s/._-]/.test(hay[plain - 1]);

        return {
            score: 100 + query.length * 4 - plain + (start ? 30 : 0),
            hits: Array.from({ length: query.length }, (_, index) => plain + index),
        };
    }

    const hits = [];
    let score = 0;
    let from = 0;

    for (const char of query) {
        if (char === " ") {
            continue;
        }

        const at = hay.indexOf(char, from);

        if (at === -1) {
            return null;
        }

        const run = hits.length > 0 && hits[hits.length - 1] === at - 1;
        const start = at === 0 || /[\s/._-]/.test(hay[at - 1]);

        if (hits.length > 0 && !start && at - from > MAX_GAP) {
            return null;
        }

        score += 1 + (run ? 5 : 0) + (start ? 8 : 0) - Math.min(at - from, 10) * 0.3;
        hits.push(at);
        from = at + 1;
    }

    return { score, hits };
}

/** The actions that make sense here, as launcher items. */
function actionItems() {
    const { view, conversationId, me, folderFavorites, server } = store.state;
    const conversation = conversationId !== null ? view.conversation : null;
    const session = conversation?.kind === "session";
    const steer = canSteer();
    // While take turns is on, the session's settings are the driver's (as in the menu).
    const driving = !view.turns?.on || view.turns.driver === me?.id;
    const canStart = steer && !scoped();
    // The folder a session starts in "here": the one the open session works in. Issue #96, reported by @poncardasm.
    const here = view.agent?.cwd ?? conversation?.cwd ?? null;
    // As the folder picker names them: folders of one name get their parent's too.
    const favoriteNames = recentLabels(folderFavorites, server?.home);
    const wide = matchMedia("(min-width: 960px)").matches;
    const list = [
        canStart && {
            label: t("sessions.new", "New session"),
            icon: "plus",
            keys: "Alt N",
            run: () => openSheet({ type: "cwd", mode: "new" }),
        },
        canStart &&
            here !== null && {
                label: t("web.launcher.action-items.label.new-session-here", "New session here"),
                detail: shortPath(here, server?.home),
                keywords: "in this folder",
                icon: "plus",
                run: () =>
                    attempt(async () => {
                        const created = await actions.createSession(here);

                        navigate(created.id);
                    }),
            },
        piSessionsAvailable() && {
            label: t(
                "web.sheets.pi-sessions.pi-sessions-sheet.title.continue-a-pi-session",
                "Continue a Pi session",
            ),
            detail: t(
                "web.launcher.action-items.detail.from-pi-terminal",
                "from Pi in the terminal",
            ),
            icon: "terminal",
            run: () => openSheet({ type: "pi-sessions" }),
        },
        conversationId !== null && {
            label: t("web.sheets.people.people-list.button.all-sessions", "All sessions"),
            detail: t("web.launcher.action-items.detail.home", "home"),
            icon: "home",
            run: () => navigate(null),
        },
        wide && {
            label:
                prefs().sidebar === "rail"
                    ? t("web.launcher.action-items.label.unfold-sidebar", "Unfold the sidebar")
                    : t("web.launcher.action-items.label.fold-sidebar", "Fold the sidebar"),
            icon: "sidebar",
            keys: "Mod B",
            run: () => setPrefs({ sidebar: prefs().sidebar === "rail" ? "open" : "rail" }),
        },
        {
            label: t("menu.appearance", "Appearance"),
            detail: t(
                "web.launcher.action-items.detail.appearance",
                "theme, colors, tiling, motion, text size, thinking, reply speed",
            ),
            icon: "palette",
            run: () => openSheet({ type: "appearance" }),
        },
        wide && {
            label: prefs().tiling
                ? t("web.launcher.action-items.label.turn-tiling-off", "Turn tiling off")
                : t("web.launcher.action-items.label.turn-tiling-on", "Turn tiling on"),
            detail: t("web.launcher.action-items.detail.gaps-borders", "gaps and window borders"),
            icon: "swatch",
            run: () => setPrefs({ tiling: !prefs().tiling }),
        },
        {
            label: prefs().peeks
                ? t("web.launcher.action-items.label.hide-peek-tiles", "Hide peek tiles")
                : t("web.launcher.action-items.label.show-peek-tiles", "Show peek tiles"),
            detail: t(
                "web.launcher.action-items.detail.peeks-live-work",
                "Peeks: other sessions' live work beside this one",
            ),
            icon: "tiles",
            keys: "Alt P",
            run: togglePeeks,
        },
        {
            label: prefs().showThinking
                ? t("web.launcher.action-items.label.hide-thinking", "Hide thinking")
                : t("web.launcher.action-items.label.show-thinking", "Show thinking"),
            detail: t(
                "web.launcher.action-items.detail.thinking-above-line",
                "Pi's thoughts above the live line and in the conversation",
            ),
            icon: "sparkle",
            keys: "Alt T",
            run: () => setPrefs({ showThinking: !prefs().showThinking }),
        },
        {
            label: prefs().speed
                ? t("web.launcher.action-items.label.hide-reply-speed", "Hide reply speed")
                : t("web.launcher.action-items.label.show-reply-speed", "Show reply speed"),
            detail: t(
                "web.launcher.action-items.detail.reply-speed",
                "how fast the last answer came, under the message box",
            ),
            icon: "pulse",
            run: () => setPrefs({ speed: !prefs().speed }),
        },
        conversation &&
            steer && {
                label: t("web.launcher.action-items.label.switch-model", "Switch model"),
                icon: "sparkle",
                run: () => openSheet({ type: "model" }),
            },
        store.state.me?.role === "owner" &&
            store.state.server?.defaultModel !== undefined && {
                label: t("web.launcher.action-items.label.default-model", "Default model"),
                detail: t(
                    "web.launcher.action-items.detail.default-model-order",
                    "owner default first; otherwise project, last picked, then Pi global",
                ),
                icon: "sparkle",
                run: () => openSheet({ type: "model", id: "default", forDefault: true }),
            },
        conversation &&
            browserAvailable() && {
                label: store.state.browserOpen
                    ? t(
                          "web.browser-panel.browser-panel.aria-label.close-the-browser",
                          "Close the browser",
                      )
                    : t("web.launcher.action-items.label.open-the-browser", "Open the browser"),
                detail: t(
                    "web.launcher.action-items.detail.browser-pages",
                    "see and test pages with Pi",
                ),
                icon: "globe",
                keys: "Alt B",
                run: toggleBrowser,
            },
        conversation && {
            label: t("app.artifacts", "Artifacts"),
            icon: "artifact",
            run: () => openSheet({ type: "artifacts" }),
        },
        {
            label: t("web.launcher.all-artifacts", "All artifacts"),
            detail: t(
                "web.launcher.all-artifacts.detail",
                "every session, with its current version",
            ),
            icon: "artifact",
            run: () => openSheet({ type: "all-artifacts" }),
        },
        conversation &&
            filesAvailable() && {
                label:
                    store.state.filesOpen && store.state.filesTab === "files"
                        ? t(
                              "web.files-panel.files-panel.aria-label.close-the-files",
                              "Close the files",
                          )
                        : t("app.files", "Files"),
                detail: t(
                    "web.launcher.action-items.detail.browse-folder",
                    "browse the folder, read files",
                ),
                icon: "folder",
                keys: "Alt E",
                run: () => toggleFiles("files"),
            },
        conversation &&
            filesAvailable() && {
                label: t("app.changes", "Changes"),
                detail: t(
                    "web.launcher.action-items.detail.review-changes",
                    "review what changed, file by file",
                ),
                keywords: "diff",
                icon: "fork",
                run: () => toggleFiles("changes"),
            },
        conversation &&
            branchAvailable() && {
                label: t("web.launcher.action-items.label.switch-branch", "Switch branch"),
                detail: t("web.launcher.branch-current", "on {branch}", {
                    branch: headLabel(view.branch),
                }),
                icon: "fork",
                run: () => openSheet({ type: "branch" }),
            },
        conversation &&
            collab() && {
                label: t(
                    "web.launcher.action-items.label.chat-people-here",
                    "Chat with people here",
                ),
                icon: "chat",
                run: () => openSheet({ type: "chat" }),
            },
        conversation && {
            label: t("web.launcher.action-items.label.find-in-session", "Find in this session"),
            detail: t("web.launcher.action-items.detail.find-by-words", "messages, by words"),
            keywords: "search",
            icon: "search",
            keys: "Mod F",
            run: () => openSheet({ type: "find" }),
        },
        conversation &&
            collab() &&
            canToggleTurns() && {
                label: view.turns?.on
                    ? t(
                          "web.launcher.action-items.label.turn-off-take-turns",
                          "Turn off take turns",
                      )
                    : t("web.launcher.action-items.label.take-turns", "Take turns"),
                detail: view.turns?.on
                    ? t(
                          "web.launcher.action-items.detail.take-turns-on",
                          "anyone here can send to Pi again",
                      )
                    : t(
                          "web.launcher.action-items.detail.take-turns-off",
                          "one person drives Pi at a time",
                      ),
                icon: "users",
                run: () => attempt(() => actions.turns(view.turns?.on ? "off" : "on")),
            },
        session &&
            steer && {
                label: t("web.launcher.action-items.label.rename-session", "Rename session"),
                icon: "sparkle",
                run: () => openSheet({ type: "rename" }),
            },
        session &&
            steer &&
            planAvailable() && {
                label: view.plan?.on
                    ? t("web.launcher.action-items.label.turn-plan-off", "Turn plan mode off")
                    : t("web.launcher.action-items.label.turn-plan-on", "Turn plan mode on"),
                detail: t(
                    "web.launcher.action-items.detail.plan-mode",
                    "Pi proposes, changes nothing",
                ),
                icon: "shield",
                run: () => attempt(() => actions.setPlan(!view.plan?.on)),
            },
        session && {
            label: isPinned(conversation.id)
                ? t("web.launcher.action-items.label.unpin-from-top", "Unpin from the top")
                : t("web.sessions.session-row.title.pin-to-the-top", "Pin to the top"),
            detail: t("web.launcher.action-items.detail.this-browser", "this browser"),
            icon: "pin",
            run: () => togglePin(conversation.id),
        },
        session && {
            label: t("web.sessions.session-row.title.mark-unread", "Mark unread"),
            detail: t(
                "web.launcher.action-items.detail.mark-unread-browser",
                "this browser; opening it again clears it",
            ),
            icon: "chat",
            run: () => {
                setUnread(conversation.id, true);
                navigate(null);
            },
        },
        conversation?.worktree && steer
            ? {
                  label: t("web.sheets.worktree.worktree-sheet.title.worktree", "Worktree"),
                  detail: conversation.worktree.branch,
                  keywords: "git branch",
                  icon: "fork",
                  run: () => openSheet({ type: "worktree" }),
              }
            : conversation &&
              steer &&
              driving &&
              !scoped() && {
                  label: t(
                      "web.launcher.action-items.label.working-directory",
                      "Working directory",
                  ),
                  detail: shortPath(view.agent?.cwd, server?.home),
                  keywords: "folder cwd",
                  icon: "folder",
                  run: () => openSheet({ type: "cwd", mode: "change" }),
              },
        conversation &&
            trustAvailable() && {
                label: t("menu.trust", "Project trust"),
                detail: t(
                    "web.launcher.action-items.detail.project-skills",
                    "the project's own skills and model settings",
                ),
                icon: "shield",
                run: () => openSheet({ type: "trust" }),
            },
        session &&
            steer &&
            driving && {
                label: t("menu.instructions", "Instructions for Pi"),
                detail: view.agent?.instructions
                    ? t("web.launcher.action-items.detail.on", "on")
                    : t("web.launcher.action-items.detail.none", "none"),
                keywords: "prompt system",
                icon: "sparkle",
                run: () => openSheet({ type: "instructions" }),
            },
        conversation &&
            steer &&
            driving && {
                label: t("menu.compact", "Compact context"),
                detail: t(
                    "web.launcher.action-items.detail.summarize-older",
                    "summarize older messages",
                ),
                icon: "sparkle",
                run: () => openSheet({ type: "compact" }),
            },
        conversation &&
            steer &&
            driving && {
                label: t("menu.new-context", "New context"),
                detail: t(
                    "web.launcher.action-items.detail.pi-starts-fresh",
                    "Pi starts fresh; history stays",
                ),
                keywords: "reset clear",
                icon: "reload",
                run: () => openSheet({ type: "reset" }),
            },
        conversation &&
            memoryAvailable() && {
                label: t("menu.memory", "Memory"),
                detail: t(
                    "web.launcher.action-items.detail.lessons-across",
                    "lessons Pi keeps across sessions",
                ),
                icon: "sparkle",
                run: () => openSheet({ type: "memory" }),
            },
        watchAvailable() &&
            steer &&
            view.watch?.status !== "watching" && {
                label: t(
                    "web.launcher.action-items.label.watch-pull-request",
                    "Watch pull request",
                ),
                detail: t("web.launcher.action-items.detail.fix-ci", "fix CI, answer reviews"),
                keywords: "github pr",
                icon: "fork",
                run: () => attempt(() => watchPr()),
            },
        conversation && {
            label: t("web.sheets.menu.menu-sheet.span.export-as-markdown", "Export as Markdown"),
            detail: t("web.sheets.menu.menu-sheet.span.the-whole-history", "the whole history"),
            keywords: "download",
            icon: "external",
            run: () => {
                const link = document.createElement("a");

                link.href = `/api/c/${conversation.id}/export`;
                link.download = "";
                link.click();
            },
        },
        schedulesAvailable() && {
            label: t("menu.schedules", "Scheduled messages"),
            icon: "pulse",
            run: () => openSheet({ type: "schedules" }),
        },
        conversation && {
            label: t(
                "web.launcher.action-items.label.copy-link-session",
                "Copy link to this session",
            ),
            icon: "external",
            run: () => copyText(location.href).then(() => notify("info", "Link copied.")),
        },
        conversation && {
            label: t("app.session-menu", "Session menu"),
            icon: "more",
            run: () => openSheet({ type: "menu" }),
        },
        session &&
            steer && {
                label: conversation.archived
                    ? t("web.launcher.action-items.label.unarchive-session", "Unarchive session")
                    : t("web.launcher.action-items.label.archive-session", "Archive session"),
                icon: "archive",
                run: () => setArchived([conversation.id], !conversation.archived),
            },
        pipAvailable() && {
            label: t("web.launcher.action-items.label.ask-pip", "Ask PiP"),
            detail: t(
                "web.launcher.action-items.detail.ask-pip",
                "your assistant, over any screen",
            ),
            icon: "pip",
            keys: "Alt A",
            run: () => openPip(),
        },
        {
            label: t("menu.running", "Running now"),
            detail: t(
                "web.launcher.action-items.detail.everything-pi-doing",
                "everything Pi is doing",
            ),
            icon: "pulse",
            run: () => toggleBoard("running"),
        },
        session && {
            label: t("web.launcher.background", "Background"),
            detail: t("web.launcher.background.detail", "what commands print as they run"),
            icon: "terminal",
            run: () => openSheet({ type: "background" }),
        },
        {
            label:
                store.state.board === "subagents"
                    ? t(
                          "web.launcher.action-items.label.close-subagents-board",
                          "Close the subagents board",
                      )
                    : t("web.subagents-board.subagents-board.h2.subagents", "Subagents"),
            detail: t(
                "web.launcher.action-items.detail.subagents-every",
                "subagents in every session",
            ),
            icon: "fork",
            run: () => toggleBoard("subagents"),
        },
        collab() && {
            label: t("menu.notifications", "Notifications"),
            detail: t(
                "web.launcher.action-items.detail.notifications-kinds",
                "Pi finished, approvals, chat",
            ),
            icon: "pulse",
            run: () => openSheet({ type: "notifications" }),
        },
        triggersOn() &&
            me?.role !== "viewer" && {
                label: t("menu.webhooks", "Webhooks and watches"),
                detail: t(
                    "web.launcher.action-items.detail.github-services",
                    "GitHub, other services",
                ),
                keywords: "hooks triggers watch pull request",
                icon: "external",
                run: () => openSheet({ type: "hooks" }),
            },
        me?.role === "owner" && {
            label: t("menu.providers", "Providers"),
            detail: t(
                "web.launcher.action-items.detail.sign-in-providers",
                "sign in to model providers",
            ),
            icon: "key",
            run: () => openSheet({ type: "providers" }),
        },
        modelRefreshAvailable() && {
            label: t("menu.refresh-models", "Refresh models"),
            detail: store.state.modelRefresh.loading
                ? t("web.launcher.action-items.detail.refresh-in-progress", "refresh in progress")
                : t(
                      "web.launcher.action-items.detail.reload-models",
                      "reload configured models and check providers",
                  ),
            icon: "reload",
            run: refreshModels,
        },
        {
            label: t("web.sheets.extensions.extensions-sheet.title.extensions", "Extensions"),
            icon: "shield",
            run: () => openSheet({ type: "extensions" }),
        },
        galleryAvailable() && {
            label: t(
                "web.sheets.extensions.extensions-content.text.find-extensions",
                "Find extensions",
            ),
            detail: t(
                "web.launcher.action-items.detail.browse-drop-ins",
                "browse and install drop-ins",
            ),
            keywords: "gallery",
            icon: "search",
            run: () => openSheet({ type: "gallery" }),
        },
        { label: t("menu.spend", "Spend"), icon: "pulse", run: () => openSheet({ type: "spend" }) },
        collab()
            ? {
                  label: t("web.sessions.rail.title.people-and-invites", "People and invites"),
                  icon: "users",
                  run: () => openSheet({ type: "people" }),
              }
            : {
                  label: t("menu.devices", "Sign in another device"),
                  icon: "users",
                  run: () => openSheet({ type: "invite" }),
              },
        {
            label: t("menu.shortcuts", "Keyboard shortcuts"),
            icon: "keyboard",
            keys: "?",
            run: () => openSheet({ type: "shortcuts" }),
        },
        {
            label: t("menu.your-name", "Your name"),
            detail: me?.name,
            icon: "users",
            run: () => openSheet({ type: "name" }),
        },
        me?.role === "owner" &&
            server?.supervised && {
                label: t("web.launcher.action-items.label.restart-server", "Restart server"),
                detail: t(
                    "web.launcher.action-items.detail.running-work-resumes",
                    "running work resumes",
                ),
                icon: "reload",
                run: () =>
                    attempt(async () => {
                        await api("restart", {});
                        notify("info", "Restarting. Running work continues after the restart.");
                    }),
            },
        {
            label: t("web.sheets.menu.menu-sheet.span.sign-out", "Sign out"),
            detail: t("web.launcher.action-items.detail.this-browser", "this browser"),
            icon: "logout",
            run: signOut,
        },
        // What extensions' browser modules added (`extension-ui.js`).
        ...extensionLauncherItems(),
        // Last: a list that is cut keeps the actions above, however many favorites there are (up to 100).
        ...(canStart
            ? folderFavorites.map((path, index) => ({
                  key: `action:new-favorite:${path}`,
                  label: t(
                      "web.launcher.action-items.label.new-session-in",
                      "New session in {where}",
                      { where: favoriteNames[index] },
                  ),
                  detail: shortPath(path, server?.home),
                  icon: "star",
                  run: () =>
                      attempt(async () => {
                          const created = await actions.createSession(path);

                          navigate(created.id);
                      }),
              }))
            : []),
    ];

    return list.filter(Boolean).map((item) => ({
        ...item,
        kind: "action",
        key: item.key ?? `action:${item.label}`,
        text: `${item.label} ${item.detail ?? ""} ${item.keywords ?? ""}`,
    }));
}

function sessionItems() {
    const { sessions, server } = store.state;
    // Every session, folded ones too; the numbers are Alt's, which skip what a fold hides.
    const order = sessionOrder();
    const archived = sessions.filter((session) => session.archived);
    const numbers = new Map(workspaceOrder().map((session, index) => [session.id, index]));

    return [...order, ...archived].map((session) => {
        const number = numbers.get(session.id) ?? -1;
        // Words extensions give it (`pocket.sessionSearch`), such as tags: matched after the title and folder.
        const words = sessionWords(session);

        return {
            kind: "session",
            key: `session:${session.id}`,
            label: session.title ?? t("sessions.new", "New session"),
            detail: shortPath(session.cwd, server?.home),
            status:
                [
                    session.id === openId()
                        ? t("web.launcher.session-items.text.current", "Current")
                        : null,
                    session.waiting
                        ? t("web.launcher.session-items.text.waiting", "Waiting")
                        : session.busy
                          ? t("sessions.working", "Working")
                          : null,
                    session.archived
                        ? t("web.launcher.session-items.text.archived", "Archived")
                        : null,
                ]
                    .filter(Boolean)
                    .join(" · ") || timeAgo(session.updatedAt),
            text: `${session.title ?? t("sessions.new", "New session")} ${shortPath(session.cwd, server?.home)}${words.length > 0 ? ` ${words.join(" ")}` : ""}`,
            words,
            keys: number >= 0 && number < 9 ? `Alt ${number + 1}` : undefined,
            rank: session.archived ? -20 : -number * 0.01,
            run: () => navigate(session.id),
            folder: folderColor(session.cwd),
            tone: session.waiting ? "waiting" : session.busy ? "working" : "quiet",
        };
    });
}

/** Theme folders that change the look, as launcher items: no preview (their stylesheets load when chosen). */
function lookItems() {
    const vars = themeVars(paletteOf());

    return lookIds()
        .map(
            (id) =>
                store.state.themeList?.find((each) => each.id === id && each.usable) ??
                (id === BASE_LOOK ? { id, name: "Pocket", builtIn: true } : null),
        )
        .filter(Boolean)
        .map((look) => ({
            kind: "theme",
            key: `look:${look.id}`,
            label: look.name,
            detail: look.builtIn
                ? t("web.launcher.action-items.detail.theme-built-in", "theme, built in")
                : t("web.launcher.action-items.detail.theme", "theme"),
            text: `theme ${look.name} ${look.id}`,
            look: look.id,
            vars,
        }));
}

function themeItems() {
    const desktop = store.state.desktopTheme;
    const ids = [...(desktop ? ["desktop"] : []), ...themeIds(), ...folderPaletteIds()];

    return [
        ...lookItems(),
        ...ids.map((id) => {
            const palette = paletteOf(id);
            const name =
                id === "desktop"
                    ? t("web.sheets.appearance.desktop-name", "Desktop · {name}", {
                          name: palette.name,
                      })
                    : palette.name;

            return {
                kind: "theme",
                key: `theme:${id}`,
                label: name,
                detail:
                    id === "desktop"
                        ? t(
                              "web.launcher.action-items.detail.follows-omarchy",
                              "follows your Omarchy theme",
                          )
                        : palette.colors.mode === "light"
                          ? t("web.launcher.action-items.detail.light", "light")
                          : t("web.launcher.action-items.detail.dark", "dark"),
                text: `theme ${name} ${id}`,
                theme: id,
                vars: themeVars(palette),
            };
        }),
    ];
}

/** Each result group's name: its key and English, read when it draws so a new language shows at once. */
const GROUP_NAMES = {
    session: ["app.sessions", "Sessions"],
    action: ["web.launcher.launcher.text.actions", "Actions"],
    theme: ["web.sheets.gallery.gallery-sheet.title.themes", "Themes"],
};

/** The name of one group of results, in this language. */
function groupName(kind) {
    const [key, english] = GROUP_NAMES[kind];

    return t(key, english);
}

const PREFIXES = { ">": "action", "@": "session", "#": "theme" };

/** Hits in one displayed field, without changing the text or score used by the fuzzy matcher. */
function fieldHits(hits, start, length) {
    return hits.filter((at) => at >= start && at < start + length).map((at) => at - start);
}

/** Keep the distinguishing end of a long folder path; a match in the hidden prefix uses the full path instead. */
function resultDetail(item, hits) {
    const text = item.detail ?? "";

    if (item.kind !== "session") {
        return { text, hits };
    }

    const end = text.lastIndexOf("/");
    const start = text.lastIndexOf("/", end - 1) + 1;

    if (text.length < 32 || start < 3 || hits.some((at) => at < start)) {
        return { text, hits };
    }

    const prefix = text.startsWith("~/") ? "~/…/" : text.startsWith("/") ? "/…/" : "…/";

    return {
        text: prefix + text.slice(start),
        hits: hits.map((at) => prefix.length + at - start),
    };
}

const optionId = (item) => `launcher-option-${encodeURIComponent(item.key)}`;

export function Launcher({ leaving, returnTo }) {
    const [query, setQuery] = useState("");
    const [pick, setPick] = useState(0);
    const [announcement, setAnnouncement] = useState("");
    const input = useRef(null);
    const list = useRef(null);
    const dialog = useRef(null);
    const chosen = useRef(false);

    // Phones: a sheet from the bottom edge, which drags back down to close, as the app's other sheets do.
    useDragToClose(dialog, {
        dir: "down",
        onClose: () => store.set({ launcher: false }),
        enabled: BOTTOM_SHEETS.matches,
    });

    const prefix = PREFIXES[query[0]];
    const needle = (prefix ? query.slice(1) : query).trim().toLowerCase();
    const { sessions, view, conversationId } = store.state;

    const groups = useMemo(() => {
        const all = [
            ...(prefix === undefined || prefix === "session" ? sessionItems() : []),
            ...(prefix === undefined || prefix === "action" ? actionItems() : []),
            ...(prefix === undefined || prefix === "theme" ? themeItems() : []),
        ];
        const scored = [];

        for (const item of all) {
            const match = fuzzy(item.text, needle);

            if (!match) {
                continue;
            }

            // Themes' scorer text begins with "theme ", not with their displayed label.
            const hits = fieldHits(match.hits, item.kind === "theme" ? 6 : 0, item.label.length);
            const detailHits =
                item.kind === "theme"
                    ? []
                    : fieldHits(match.hits, item.label.length + 1, (item.detail ?? "").length);
            const detail = resultDetail(item, detailHits);
            const matchNote =
                match.hits.length > 0 && hits.length === 0 && detailHits.length === 0
                    ? item.kind === "theme"
                        ? t(
                              "web.launcher.result.text.theme-name-id-match",
                              "Theme name or ID match",
                          )
                        : (item.words?.find((word) => word.includes(needle)) ??
                          t("web.launcher.result.text.keyword-match", "Keyword match"))
                    : null;

            scored.push({
                ...item,
                score: match.score + (item.rank ?? 0),
                hits,
                fullDetail: item.detail,
                detail,
                matchNote,
            });
        }

        const byKind = new Map();

        for (const item of scored) {
            if (!byKind.has(item.kind)) {
                byKind.set(item.kind, []);
            }

            byKind.get(item.kind).push(item);
        }

        const out = [...byKind.entries()].map(([kind, items]) => {
            if (needle !== "") {
                items.sort((a, b) => b.score - a.score);
            }

            const limit =
                needle === "" && prefix === undefined ? (kind === "session" ? 6 : 99) : 40;

            return {
                kind,
                items: items.slice(0, limit),
                total: items.length,
                best: items[0]?.score ?? 0,
            };
        });

        // Preserve group-first ranking: with a query the best group's matches come first.
        if (needle !== "") {
            out.sort((a, b) => b.best - a.best);
        }

        return out;
    }, [
        needle,
        prefix,
        sessions,
        view.conversation,
        view.agent?.cwd,
        view.plan?.on,
        view.branch,
        conversationId,
        store.state.pinned,
        store.state.browserOpen,
        store.state.filesOpen,
        store.state.filesTab,
        store.state.desktopTheme,
        store.state.appearance,
        store.state.me,
        store.state.server,
        store.state.folderFavorites,
        store.state.extensionsRev,
        store.state.localeRevision,
    ]);

    const flat = useMemo(() => groups.flatMap((group) => group.items), [groups]);
    const index = Math.min(pick, Math.max(0, flat.length - 1));
    const selected = flat[index];
    const recent =
        needle === "" && prefix === undefined
            ? groups.find((group) => group.kind === "session")
            : null;

    const limitedRecent = recent && recent.total > recent.items.length;

    // Focus after inert is removed, not in a pending passive effect. LauncherHost keys every logical opening,
    // including a same-task reopen, so query, selection, and the theme commit flag cannot leak across openings.
    // Issue #62, reported by @arunsathiya.
    useLayoutEffect(() => {
        if (leaving) {
            return;
        }

        const overlay = input.current?.closest(".launcher-overlay");
        const parent = overlay?.parentElement;
        const blocked = new Map();
        // Touch screens: the launcher takes focus, not its field, so no keyboard covers the results; a tap on the
        // field brings it up. As Sheet does.
        const home = matchMedia("(pointer: coarse)").matches ? dialog.current : input.current;

        const restore = (child, { attribute, value }) => {
            if (value === null) {
                child.removeAttribute(attribute);
            } else {
                child.setAttribute(attribute, value);
            }
        };

        const rememberOwners = (records) => {
            for (const record of records) {
                const owner = blocked.get(record.target);

                if (record.type === "attributes" && record.attributeName === owner?.attribute) {
                    owner.value = record.target.getAttribute(owner.attribute);
                }
            }
        };

        const isolate = (records = []) => {
            rememberOwners([...records, ...owners.takeRecords()]);
            // Do not observe our own isolation writes. Retained layers can change their state while blocked.
            owners.disconnect();

            for (const record of records) {
                for (const child of record.removedNodes) {
                    if (blocked.has(child)) {
                        restore(child, blocked.get(child));
                        blocked.delete(child);
                    }
                }
            }

            for (const child of parent?.children ?? []) {
                if (child === overlay || child.classList.contains("launcher-overlay")) {
                    continue;
                }

                if (!blocked.has(child)) {
                    // Native inert is costly on a sidebar with thousands of controls. The large primary windows
                    // are hidden from AT instead; the overlay and focus guard block pointer and keyboard access.
                    const attribute = child.matches(".sidebar, .pane") ? "aria-hidden" : "inert";

                    blocked.set(child, { attribute, value: child.getAttribute(attribute) });
                }

                const { attribute } = blocked.get(child);

                child.setAttribute(attribute, attribute === "aria-hidden" ? "true" : "");
                owners.observe(child, { attributes: true, attributeFilter: [attribute] });
            }
        };

        const keepFocus = (event) => {
            if (!overlay?.contains(event.target)) {
                home?.focus({ preventScroll: true });
            }
        };

        const owners = new MutationObserver(isolate);
        const observer = new MutationObserver(isolate);

        // Move focus out before hiding its old ancestor from AT (Chromium rejects aria-hidden on focused content).
        document.addEventListener("focusin", keepFocus);
        home?.focus({ preventScroll: true });
        isolate();

        if (parent) {
            observer.observe(parent, { childList: true });
        }

        return () => {
            rememberOwners(owners.takeRecords());
            observer.disconnect();
            owners.disconnect();
            document.removeEventListener("focusin", keepFocus);

            for (const [child, owner] of blocked) {
                restore(child, owner);
            }
        };
    }, [leaving]);
    useEffect(
        () => () => {
            if (!chosen.current) {
                preview(null);
            }

            const active = document.activeElement;
            const lost =
                active === null ||
                active === document.body ||
                active === input.current ||
                active === dialog.current;
            const sheet = document.querySelector(".sheet-host:not(.leaving) .sheet");
            const back = sheet?.contains(returnTo) ? returnTo : (sheet ?? returnTo);

            // A new launcher or a destination that already took focus keeps it.
            if (
                !store.state.launcher &&
                lost &&
                back?.isConnected &&
                typeof back.focus === "function"
            ) {
                back.focus({ preventScroll: true });
            }
        },
        [],
    );
    useEffect(() => {
        if (leaving) {
            if (!chosen.current) {
                preview(null);
            }

            return;
        }

        preview(selected?.kind === "theme" && selected.theme ? selected.theme : null);
    }, [selected?.key, leaving]);
    useLayoutEffect(() => {
        if (!leaving) {
            list.current?.querySelector(".launcher-item.on")?.scrollIntoView({ block: "nearest" });
        }
    }, [selected?.key, index, needle, prefix, leaving]);
    useEffect(() => {
        const timer = setTimeout(() => {
            setAnnouncement(
                flat.length === 0
                    ? t("web.launcher.launcher.text.no-results", "No results for {needle}.", {
                          needle,
                      })
                    : prefix
                      ? t(
                            "web.launcher.launcher.text.results-in-group",
                            "{count} results in {group}.",
                            { count: flat.length, group: groupName(prefix).toLowerCase() },
                        )
                      : t("web.launcher.launcher.text.results", "{count} results.", {
                            count: flat.length,
                        }),
            );
        }, 150);

        return () => clearTimeout(timer);
    }, [flat.length, needle, prefix, store.state.localeRevision]);

    const changeQuery = (next) => {
        setQuery(next);
        setPick(0);
    };

    const chooseType = (next) => {
        changeQuery(next + (prefix ? query.slice(1) : query));
        input.current?.focus({ preventScroll: true });
    };

    const clear = () => {
        changeQuery("");
        input.current?.focus({ preventScroll: true });
    };

    const close = () => store.set({ launcher: false });

    const run = (item, event) => {
        if (!item) {
            return;
        }

        chosen.current = item.kind === "theme";
        close();

        if (item.kind === "theme") {
            preview(null);

            if (item.look) {
                chooseLook(item.look, event);

                return;
            }

            if (item.theme !== prefs().theme) {
                setPrefs({ theme: item.theme });
            }

            return;
        }

        item.run(event);
    };

    const move = (by) => {
        setPick((index + by + flat.length) % Math.max(1, flat.length));
        input.current?.focus({ preventScroll: true });
    };

    const onKey = (event) => {
        const key = event.key;
        // A touch screen with a keyboard: the launcher holds focus, not its field (see `home` above). Typing goes to the
        // field, which takes focus before the key lands: a letter, a dead key (an accent to come), an input method's
        // keys, or AltGr's (Ctrl+Alt on Windows); not a shortcut. The keys that move and open work from the launcher too.
        const onDialog = event.target === dialog.current;
        const composing = event.isComposing || event.keyCode === 229 || key === "Process";
        const altGr = event.ctrlKey && event.altKey;
        const typing =
            (key.length === 1 || key === "Backspace" || key === "Dead" || composing) &&
            !event.metaKey &&
            (altGr || (!event.ctrlKey && !event.altKey) || composing);

        if (onDialog && typing) {
            input.current?.focus({ preventScroll: true });

            return;
        }

        // The keys an input method uses to compose (Escape, Enter among them) are its own, not the launcher's.
        if (composing) {
            return;
        }

        if (key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            close();

            return;
        }

        // Toolbar buttons keep their native Enter/Space behavior; options and the input share navigation.
        if (
            !onDialog &&
            event.target !== input.current &&
            !event.target.closest(".launcher-item")
        ) {
            return;
        }

        if (
            key === "ArrowDown" ||
            (event.ctrlKey && (key === "n" || key === "j")) ||
            (key === "Tab" && !event.shiftKey)
        ) {
            event.preventDefault();
            move(1);
        } else if (
            key === "ArrowUp" ||
            (event.ctrlKey && key === "p") ||
            (key === "Tab" && event.shiftKey)
        ) {
            event.preventDefault();
            move(-1);
        } else if (key === "PageDown") {
            event.preventDefault();
            move(8);
        } else if (key === "PageUp") {
            event.preventDefault();
            move(-8);
        } else if (key === "Enter") {
            event.preventDefault();
            run(selected, event);
        }
    };

    let at = 0;

    return html`<div
        class=${`launcher-overlay ${leaving ? "leaving" : ""}`}
        data-part="scrim"
        data-for="launcher"
        inert=${leaving}
        onMouseDown=${scrimPress(close)}
    >
        <section
            class="launcher"
            data-part="launcher"
            data-state=${leaving ? "closing" : undefined}
            ref=${dialog}
            role="dialog"
            aria-modal="true"
            aria-label=${t("web.launcher.launcher.aria-label.launcher", "Launcher")}
            tabindex="-1"
            onKeyDown=${onKey}
            onMouseDown=${(event) => event.target !== input.current && event.preventDefault()}
        >
            <div class="grip" aria-hidden="true"></div>
            <div class="launcher-input" data-part="launcher-input">
                <span class="prompt" aria-hidden="true">❯</span>
                <input
                    ref=${input}
                    value=${query}
                    placeholder=${t(
                        "web.launcher.launcher.placeholder.sessions-actions-themes",
                        "Sessions, actions, themes…",
                    )}
                    aria-label=${t(
                        "web.launcher.launcher.aria-label.search-sessions-actions-themes",
                        "Search sessions, actions, and themes",
                    )}
                    autocomplete="off"
                    autocapitalize="none"
                    spellcheck=${false}
                    role="combobox"
                    aria-expanded="true"
                    aria-autocomplete="list"
                    aria-controls="launcher-results"
                    aria-activedescendant=${selected ? optionId(selected) : undefined}
                    onInput=${(event) => changeQuery(event.currentTarget.value)}
                />
                <kbd class="launcher-escape" aria-hidden="true">${t(
                    "web.launcher.launcher.kbd.esc",
                    "esc",
                )}</kbd>
                <button class="launcher-close" aria-label=${t(
                    "web.launcher.launcher.aria-label.close-launcher",
                    "Close launcher",
                )} onClick=${close}>
                    <${Icon} name="close" size=${18} />
                </button>
            </div>
            <div
                class="launcher-types"
                data-part="launcher-filters"
                role="group"
                aria-label=${t("web.launcher.launcher.aria-label.search-type", "Search type")}
            >
                ${[
                    ["", t("web.launcher.launcher.text.all", "All")],
                    ["@", t("app.sessions", "Sessions")],
                    [">", t("web.launcher.launcher.text.actions", "Actions")],
                    ["#", t("web.sheets.gallery.gallery-sheet.title.themes", "Themes")],
                ].map(
                    ([token, label]) => html`<button
                        aria-pressed=${(prefix ? query[0] : "") === token}
                        onClick=${() => chooseType(token)}
                    >
                        ${label}${token && html`<kbd aria-hidden="true">${token}</kbd>`}
                    </button>`,
                )}
            </div>
            ${
                limitedRecent &&
                html`<div
                    class="launcher-summary"
                    role="group"
                    aria-label=${t(
                        "web.launcher.launcher.aria-label.recent-session-options",
                        "Recent session options",
                    )}
                >
                    <div class="launcher-group" data-part="launcher-group">
                        <span id="launcher-group-session">${t(
                            "web.launcher.launcher.span.recent-sessions",
                            "Recent sessions",
                        )}</span>
                        <span class="launcher-count">
                            ${t("web.launcher.launcher.span.count-of-total", "{shown} of {total}", {
                                shown: recent.items.length,
                                total: recent.total,
                            })}
                        </span>
                    </div>
                    <button aria-label=${t(
                        "web.launcher.launcher.aria-label.show-all-sessions",
                        "Show all sessions",
                    )} onClick=${() => chooseType("@")}>
                        ${t(
                            "web.launcher.launcher.button.show-all",
                            "Show all",
                        )} <span aria-hidden="true">@</span>
                    </button>
                </div>`
            }
            <div
                class="launcher-list"
                id="launcher-results"
                ref=${list}
                role="listbox"
                aria-label=${t("web.launcher.launcher.aria-label.search-results", "Search results")}
            >
                ${groups.map(
                    (group) => html`
                        <div role="group" aria-labelledby=${`launcher-group-${group.kind}`}>
                            ${
                                !(group.kind === "session" && limitedRecent) &&
                                html`<div class="launcher-group" data-part="launcher-group">
                                    <span id=${`launcher-group-${group.kind}`}>
                                        ${
                                            group.kind === "session" && recent
                                                ? t(
                                                      "web.launcher.launcher.span.recent-sessions",
                                                      "Recent sessions",
                                                  )
                                                : groupName(group.kind)
                                        }
                                    </span>
                                    <span class="launcher-count">
                                        ${
                                            group.total > group.items.length
                                                ? t(
                                                      "web.launcher.launcher.span.count-of-total",
                                                      "{shown} of {total}",
                                                      {
                                                          shown: group.items.length,
                                                          total: group.total,
                                                      },
                                                  )
                                                : group.items.length
                                        }
                                    </span>
                                </div>`
                            }
                            ${group.items.map((item) => {
                                const mine = at++;
                                const on = mine === index;
                                const fullDetail = item.fullDetail;
                                const description = [
                                    item.label,
                                    fullDetail,
                                    item.status,
                                    item.matchNote,
                                    item.keys?.replace("Mod", APPLE ? "Command" : "Control"),
                                ]
                                    .filter(Boolean)
                                    .join(", ");

                                return html`<button
                                    key=${item.key}
                                    id=${optionId(item)}
                                    class=${`launcher-item ${on ? "on" : ""}`}
                                    data-part="launcher-row"
                                    role="option"
                                    tabindex="-1"
                                    aria-label=${description}
                                    aria-selected=${on}
                                    title=${description}
                                    onFocus=${() => mine !== index && setPick(mine)}
                                    onMouseMove=${() => mine !== index && setPick(mine)}
                                    onClick=${(event) => run(item, event)}
                                >
                                    ${
                                        item.kind === "theme"
                                            ? html`
                                                <span
                                                    class="swatch"
                                                    style=${varsStyle(item.vars)}
                                                    aria-hidden="true"
                                                >
                                                    <i style="background:var(--o-bg)"></i>
                                                    <i style="background:var(--o-accent)"></i>
                                                    <i style="background:var(--o-green)"></i>
                                                    <i style="background:var(--o-red)"></i>
                                                </span>
                                            `
                                            : html`
                                                <span class="glyph" aria-hidden="true">
                                                    ${
                                                        item.kind === "session"
                                                            ? html`<span
                                                                class="launcher-folder"
                                                                style=${`--folder:${item.folder}`}
                                                            ></span>`
                                                            : html`
                                                                <${Icon}
                                                                    name=${item.icon}
                                                                    path=${item.iconPath}
                                                                    size=${16}
                                                                />
                                                            `
                                                    }
                                                </span>
                                            `
                                    }
                                    <span class="main">
                                        <span class="launcher-title">
                                            <${Marked} text=${item.label} hits=${item.hits} />
                                        </span>
                                        ${
                                            (item.detail.text || item.matchNote) &&
                                            html`<span class="detail">
                                                <span
                                                    class=${`launcher-path ${item.kind === "session" ? "session-path" : ""}`}
                                                >
                                                    <${Marked}
                                                        text=${item.detail.text}
                                                        hits=${item.detail.hits}
                                                    />
                                                </span>
                                                ${
                                                    item.matchNote &&
                                                    html`<span class="launcher-match-note">
                                                        ${item.matchNote}
                                                    </span>`
                                                }
                                            </span>`
                                        }
                                    </span>
                                    ${
                                        item.status &&
                                        html`<span class=${`launcher-state ${item.tone}`}>
                                            ${item.status}
                                        </span>`
                                    }
                                    ${
                                        item.kind === "theme" &&
                                        (item.look
                                            ? item.look === prefs().look
                                            : item.theme === prefs().theme) &&
                                        html`<span class="hint">${t(
                                            "web.launcher.launcher.span.current",
                                            "current",
                                        )}</span>`
                                    }
                                    ${
                                        item.keys &&
                                        html`<span class="hint">
                                            <${Keys} keys=${item.keys} />
                                        </span>`
                                    }
                                </button>`;
                            })}
                        </div>
                    `,
                )}
            </div>
            ${
                flat.length === 0 &&
                html`<div class="launcher-empty">
                    <strong>${t(
                        "web.launcher.launcher.strong.no-matches",
                        "No matches for “{needle}”.",
                        { needle },
                    )}</strong>
                    <span>${t(
                        "web.launcher.launcher.span.try-fewer-words-search",
                        "Try fewer words, or search all types.",
                    )}</span>
                    <button class="button" onClick=${clear}>${t(
                        "web.launcher.launcher.button.clear-search",
                        "Clear search",
                    )}</button>
                </div>`
            }
            <div
                class="launcher-status"
                role="status"
                aria-live="polite"
                aria-atomic="true"
            >
                ${announcement}
            </div>
            <div class="launcher-foot">
                <span class="launcher-key-help">
                    <kbd>↑</kbd><kbd>↓</kbd> ${t(
                        "web.launcher.launcher.kbd.move",
                        "move",
                    )} <kbd>↵</kbd> ${t("web.launcher.launcher.kbd.open", "open")} <kbd>${t(
                        "web.launcher.launcher.kbd.esc",
                        "esc",
                    )}</kbd> ${t("web.launcher.launcher.kbd.close", "close")}
                </span>
                <span class="launcher-prefix-help">
                    <kbd>></kbd> ${t(
                        "web.launcher.launcher.kbd.actions",
                        "actions",
                    )} <kbd>@</kbd> ${t(
                        "web.launcher.launcher.kbd.sessions",
                        "sessions",
                    )} <kbd>#</kbd> ${t("web.launcher.launcher.kbd.themes", "themes")}
                </span>
                <span class="launcher-touch-help">
                    ${t(
                        "web.launcher.launcher.span.tap-result-actions-sessions",
                        "Tap a result · > actions, @ sessions, # themes",
                    )}
                </span>
            </div>
        </section>
    </div>`;
}
