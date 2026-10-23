import { t } from "./i18n.js";
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
    setUnread,
    signOut,
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
import { APPLE, copyText, html, Icon, Keys, Marked, scrimPress, shortPath, timeAgo } from "./ui.js";

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
            label: t("New session"),
            icon: "plus",
            keys: "Alt N",
            run: () => openSheet({ type: "cwd", mode: "new" }),
        },
        canStart &&
            here !== null && {
                label: t("New session here"),
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
            label: t("Continue a Pi session"),
            detail: t("from Pi in the terminal"),
            icon: "terminal",
            run: () => openSheet({ type: "pi-sessions" }),
        },
        conversationId !== null && {
            label: t("All sessions"),
            detail: t("home"),
            icon: "home",
            run: () => navigate(null),
        },
        wide && {
            label: prefs().sidebar === "rail" ? t("Unfold the sidebar") : t("Fold the sidebar"),
            icon: "sidebar",
            keys: "Mod B",
            run: () => setPrefs({ sidebar: prefs().sidebar === "rail" ? "open" : "rail" }),
        },
        {
            label: t("Appearance"),
            detail: t("theme, colors, tiling, motion, text size, thinking, reply speed"),
            icon: "palette",
            run: () => openSheet({ type: "appearance" }),
        },
        wide && {
            label: t(prefs().tiling ? "Turn tiling off" : "Turn tiling on"),
            detail: t("gaps and window borders"),
            icon: "swatch",
            run: () => setPrefs({ tiling: !prefs().tiling }),
        },
        {
            label: t(prefs().peeks ? "Hide peek tiles" : "Show peek tiles"),
            detail: t("Peeks: other sessions' live work beside this one"),
            icon: "tiles",
            keys: "Alt P",
            run: togglePeeks,
        },
        {
            label: t(prefs().showThinking ? "Hide thinking" : "Show thinking"),
            detail: t("Pi's thoughts above the live line and in the conversation"),
            icon: "sparkle",
            keys: "Alt T",
            run: () => setPrefs({ showThinking: !prefs().showThinking }),
        },
        {
            label: t(prefs().speed ? "Hide reply speed" : "Show reply speed"),
            detail: t("how fast the last answer came, under the message box"),
            icon: "pulse",
            run: () => setPrefs({ speed: !prefs().speed }),
        },
        conversation &&
            steer && {
                label: t("Switch model"),
                icon: "sparkle",
                run: () => openSheet({ type: "model" }),
            },
        store.state.me?.role === "owner" &&
            store.state.server?.defaultModel !== undefined && {
                label: t("Default model"),
                detail: t("owner default first; otherwise project, last picked, then Pi global"),
                icon: "sparkle",
                run: () => openSheet({ type: "model", id: "default", forDefault: true }),
            },
        conversation &&
            browserAvailable() && {
                label: store.state.browserOpen ? t("Close the browser") : t("Open the browser"),
                detail: t("see and test pages with Pi"),
                icon: "globe",
                keys: "Alt B",
                run: toggleBrowser,
            },
        conversation && {
            label: t("Artifacts"),
            icon: "artifact",
            run: () => openSheet({ type: "artifacts" }),
        },
        conversation &&
            filesAvailable() && {
                label:
                    store.state.filesOpen && store.state.filesTab === "files"
                        ? t("Close the files")
                        : t("Files"),
                detail: t("browse the folder, read files"),
                icon: "folder",
                keys: "Alt E",
                run: () => toggleFiles("files"),
            },
        conversation &&
            filesAvailable() && {
                label: t("Changes"),
                detail: t("review what changed, file by file"),
                keywords: "diff",
                icon: "fork",
                run: () => toggleFiles("changes"),
            },
        conversation &&
            branchAvailable() && {
                label: t("Switch branch"),
                detail: t("on {{branch}}", { branch: headLabel(view.branch) }),
                icon: "fork",
                run: () => openSheet({ type: "branch" }),
            },
        conversation &&
            collab() && {
                label: t("Chat with people here"),
                icon: "chat",
                run: () => openSheet({ type: "chat" }),
            },
        conversation && {
            label: "Find in this session",
            detail: "messages, by words",
            keywords: "search",
            icon: "search",
            keys: "Mod F",
            run: () => openSheet({ type: "find" }),
        },
        conversation &&
            collab() &&
            canToggleTurns() && {
                label: view.turns?.on ? "Turn off take turns" : "Take turns",
                detail: view.turns?.on
                    ? "anyone here can send to Pi again"
                    : "one person drives Pi at a time",
                icon: "users",
                run: () => attempt(() => actions.turns(view.turns?.on ? "off" : "on")),
            },
        session &&
            steer && {
                label: t("Rename session"),
                icon: "sparkle",
                run: () => openSheet({ type: "rename" }),
            },
        session &&
            steer &&
            planAvailable() && {
                label: t(view.plan?.on ? "Turn plan mode off" : "Turn plan mode on"),
                detail: t("Pi proposes, changes nothing"),
                icon: "shield",
                run: () => attempt(() => actions.setPlan(!view.plan?.on)),
            },
        session && {
            label: isPinned(conversation.id) ? "Unpin from the top" : "Pin to the top",
            detail: "this browser",
            icon: "pin",
            run: () => togglePin(conversation.id),
        },
        session && {
            label: "Mark unread",
            detail: "this browser; opening it again clears it",
            icon: "chat",
            run: () => {
                setUnread(conversation.id, true);
                navigate(null);
            },
        },
        conversation?.worktree && steer
            ? {
                  label: "Worktree",
                  detail: conversation.worktree.branch,
                  keywords: "git branch",
                  icon: "fork",
                  run: () => openSheet({ type: "worktree" }),
              }
            : conversation &&
              steer &&
              driving &&
              !scoped() && {
                  label: "Working directory",
                  detail: shortPath(view.agent?.cwd, server?.home),
                  keywords: "folder cwd",
                  icon: "folder",
                  run: () => openSheet({ type: "cwd", mode: "change" }),
              },
        conversation &&
            trustAvailable() && {
                label: "Project trust",
                detail: "the project's own skills and model settings",
                icon: "shield",
                run: () => openSheet({ type: "trust" }),
            },
        session &&
            steer &&
            driving && {
                label: "Instructions for Pi",
                detail: view.agent?.instructions ? "on" : "none",
                keywords: "prompt system",
                icon: "sparkle",
                run: () => openSheet({ type: "instructions" }),
            },
        conversation &&
            steer &&
            driving && {
                label: "Compact context",
                detail: "summarize older messages",
                icon: "sparkle",
                run: () => openSheet({ type: "compact" }),
            },
        conversation &&
            steer &&
            driving && {
                label: "New context",
                detail: "Pi starts fresh; history stays",
                keywords: "reset clear",
                icon: "reload",
                run: () => openSheet({ type: "reset" }),
            },
        conversation &&
            memoryAvailable() && {
                label: "Memory",
                detail: "lessons Pi keeps across sessions",
                icon: "sparkle",
                run: () => openSheet({ type: "memory" }),
            },
        watchAvailable() &&
            steer &&
            view.watch?.status !== "watching" && {
                label: "Watch pull request",
                detail: "fix CI, answer reviews",
                keywords: "github pr",
                icon: "fork",
                run: () => attempt(() => watchPr()),
            },
        conversation && {
            label: "Export as Markdown",
            detail: "the whole history",
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
            label: t("Scheduled messages"),
            icon: "pulse",
            run: () => openSheet({ type: "schedules" }),
        },
        conversation && {
            label: t("Copy link to this session"),
            icon: "external",
            run: () => copyText(location.href).then(() => notify("info", t("Link copied."))),
        },
        conversation && {
            label: t("Session menu"),
            icon: "more",
            run: () => openSheet({ type: "menu" }),
        },
        session &&
            steer && {
                label: t(conversation.archived ? "Unarchive session" : "Archive session"),
                icon: "archive",
                run: () => setArchived([conversation.id], !conversation.archived),
            },
        pipAvailable() && {
            label: t("Ask PiP"),
            detail: t("your assistant, over any screen"),
            icon: "pip",
            keys: "Alt A",
            run: () => openPip(),
        },
        {
            label: t("Running now"),
            detail: t("everything Pi is doing"),
            icon: "pulse",
            run: () => openSheet({ type: "running" }),
        },
        {
            label: store.state.board ? "Close the subagents board" : "Subagents",
            detail: "subagents in every session",
            icon: "fork",
            run: toggleBoard,
        },
        collab() && {
            label: "Notifications",
            detail: "Pi finished, approvals, chat",
            icon: "pulse",
            run: () => openSheet({ type: "notifications" }),
        },
        triggersOn() &&
            me?.role !== "viewer" && {
                label: "Webhooks and watches",
                detail: "GitHub, other services",
                keywords: "hooks triggers watch pull request",
                icon: "external",
                run: () => openSheet({ type: "hooks" }),
            },
        me?.role === "owner" && {
            label: t("Providers"),
            detail: t("sign in to model providers"),
            icon: "key",
            run: () => openSheet({ type: "providers" }),
        },
        modelRefreshAvailable() && {
            label: t("Refresh models"),
            detail: store.state.modelRefresh.loading
                ? t("refresh in progress")
                : t("reload configured models and check providers"),
            icon: "reload",
            run: refreshModels,
        },
        { label: t("Extensions"), icon: "shield", run: () => openSheet({ type: "extensions" }) },
        galleryAvailable() && {
            label: t("Find extensions"),
            detail: t("browse and install drop-ins"),
            keywords: "gallery",
            icon: "search",
            run: () => openSheet({ type: "gallery" }),
        },
        { label: t("Spend"), icon: "pulse", run: () => openSheet({ type: "spend" }) },
        collab()
            ? {
                  label: t("People and invites"),
                  icon: "users",
                  run: () => openSheet({ type: "people" }),
              }
            : {
                  label: t("Sign in another device"),
                  icon: "users",
                  run: () => openSheet({ type: "invite" }),
              },
        {
            label: t("Keyboard shortcuts"),
            icon: "keyboard",
            keys: "?",
            run: () => openSheet({ type: "shortcuts" }),
        },
        {
            label: t("Your name"),
            detail: me?.name,
            icon: "users",
            run: () => openSheet({ type: "name" }),
        },
        me?.role === "owner" &&
            server?.supervised && {
                label: t("Restart server"),
                detail: t("running work resumes"),
                icon: "reload",
                run: () =>
                    attempt(async () => {
                        await api("restart", {});
                        notify("info", t("Restarting. Running work continues after the restart."));
                    }),
            },
        { label: t("Sign out"), detail: t("this browser"), icon: "logout", run: signOut },
        // What extensions' browser modules added (`extension-ui.js`).
        ...extensionLauncherItems(),
        // Last: a list that is cut keeps the actions above, however many favorites there are (up to 100).
        ...(canStart
            ? folderFavorites.map((path, index) => ({
                  key: `action:new-favorite:${path}`,
                  label: t("New session in {{folder}}", { folder: favoriteNames[index] }),
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
    const order = workspaceOrder();
    const archived = sessions.filter((session) => session.archived);
    const numbers = new Map(order.map((session, index) => [session.id, index]));

    return [...order, ...archived].map((session) => {
        const number = numbers.get(session.id) ?? -1;
        // Words extensions give it (`pocket.sessionSearch`), such as tags: matched after the title and folder.
        const words = sessionWords(session);

        return {
            kind: "session",
            key: `session:${session.id}`,
            label: session.title ?? t("New session"),
            detail: shortPath(session.cwd, server?.home),
            status:
                [
                    session.id === store.state.conversationId ? t("Current") : null,
                    session.waiting ? t("Waiting") : session.busy ? t("Working") : null,
                    session.archived ? t("Archived") : null,
                ]
                    .filter(Boolean)
                    .join(" · ") || timeAgo(session.updatedAt),
            text: `${session.title ?? "New session"} ${shortPath(session.cwd, server?.home)}${words.length > 0 ? ` ${words.join(" ")}` : ""}`,
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
            detail: t(look.builtIn ? "theme, built in" : "theme"),
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
                id === "desktop" ? t("Desktop · {{theme}}", { theme: palette.name }) : palette.name;

            return {
                kind: "theme",
                key: `theme:${id}`,
                label: name,
                detail:
                    id === "desktop"
                        ? t("follows your Omarchy theme")
                        : t(palette.colors.mode === "light" ? "light" : "dark"),
                text: `theme ${name} ${id}`,
                theme: id,
                vars: themeVars(palette),
            };
        }),
    ];
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
    const chosen = useRef(false);

    const prefix = PREFIXES[query[0]];
    const needle = (prefix ? query.slice(1) : query).trim().toLowerCase();
    const { sessions, view, conversationId, uiLocaleRevision } = store.state;
    const groupNames = { session: t("Sessions"), action: t("Actions"), theme: t("Themes") };

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
                        ? t("Theme name or ID match")
                        : (item.words?.find((word) => word.includes(needle)) ?? t("Keyword match"))
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
        uiLocaleRevision,
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
                input.current?.focus({ preventScroll: true });
            }
        };

        const owners = new MutationObserver(isolate);
        const observer = new MutationObserver(isolate);

        // Move focus out before hiding its old ancestor from AT (Chromium rejects aria-hidden on focused content).
        document.addEventListener("focusin", keepFocus);
        input.current?.focus({ preventScroll: true });
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
            const lost = active === null || active === document.body || active === input.current;
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
                    ? `No results for ${needle}.`
                    : `${flat.length} results${prefix ? ` in ${GROUP_NAMES[prefix].toLowerCase()}` : ""}.`,
            );
        }, 150);

        return () => clearTimeout(timer);
    }, [flat.length, needle, prefix]);

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
        if (event.isComposing || event.keyCode === 229) {
            return;
        }

        const key = event.key;

        if (key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            close();

            return;
        }

        // Toolbar buttons keep their native Enter/Space behavior; options and the input share navigation.
        if (event.target !== input.current && !event.target.closest(".launcher-item")) {
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
            role="dialog"
            aria-modal="true"
            aria-label=${t("Launcher")}
            onKeyDown=${onKey}
            onMouseDown=${(event) => event.target !== input.current && event.preventDefault()}
        >
            <div class="launcher-input" data-part="launcher-input">
                <span class="prompt" aria-hidden="true">❯</span>
                <input
                    ref=${input}
                    value=${query}
                    placeholder=${t("Sessions, actions, themes…")}
                    aria-label=${t("Search sessions, actions, and themes")}
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
                <kbd class="launcher-escape" aria-hidden="true">esc</kbd>
                <button class="launcher-close" aria-label=${t("Close launcher")} onClick=${close}>
                    <${Icon} name="close" size=${18} />
                </button>
            </div>
            <div
                class="launcher-types"
                data-part="launcher-filters"
                role="group"
                aria-label=${t("Search type")}
            >
                ${[
                    ["", t("All")],
                    ["@", t("Sessions")],
                    [">", t("Actions")],
                    ["#", t("Themes")],
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
                    aria-label=${t("Recent session options")}
                >
                    <div class="launcher-group" data-part="launcher-group">
                        <span id="launcher-group-session">${t("Recent sessions")}</span>
                        <span class="launcher-count">
                            ${t("{{shown}} of {{total}}", { shown: recent.items.length, total: recent.total })}
                        </span>
                    </div>
                    <button aria-label=${t("Show all sessions")} onClick=${() => chooseType("@")}>
                        ${t("Show all")} <span aria-hidden="true">@</span>
                    </button>
                </div>`
            }
            <div
                class="launcher-list"
                id="launcher-results"
                ref=${list}
                role="listbox"
                aria-label=${t("Search results")}
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
                                                ? t("Recent sessions")
                                                : groupNames[group.kind]
                                        }
                                    </span>
                                    <span class="launcher-count">
                                        ${group.items.length}${
                                            group.total > group.items.length
                                                ? ` ${t("of {{total}}", { total: group.total })}`
                                                : ""
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
                                        html`<span class="hint">${t("current")}</span>`
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
                    <strong>${t("No matches for “{{query}}”.", { query: needle })}</strong>
                    <span>${t("Try fewer words, or search all types.")}</span>
                    <button class="button" onClick=${clear}>${t("Clear search")}</button>
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
                    <kbd>↑</kbd><kbd>↓</kbd> ${t("move")} <kbd>↵</kbd> ${t("open")} <kbd>esc</kbd> ${t("close")}
                </span>
                <span class="launcher-prefix-help">
                    <kbd>></kbd> ${t("actions")} <kbd>@</kbd> ${t("sessions")} <kbd>#</kbd> ${t("themes")}
                </span>
                <span class="launcher-touch-help">
                    ${t("Tap a result · > actions, @ sessions, # themes")}
                </span>
            </div>
        </section>
    </div>`;
}
