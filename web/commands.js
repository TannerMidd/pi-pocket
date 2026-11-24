import { t } from "./ui-locale.js";
// Slash commands in the message box ("/compact", "/model sonnet", …). They run here in the app and are never sent to Pi.
import { browserAvailable, openInBrowser, toggleBrowser } from "./browser.js";
import { filesAvailable, toggleFiles } from "./files-panel.js";
import { branchAvailable } from "./sheets/branch.js";
import { levelLabel } from "./sheets/model.js";
import { memoryAvailable, remember } from "./sheets/memory.js";
import { togglePeeks } from "./peeks.js";
import { askPip, openPip, pipAvailable } from "./pip.js";
import { actions, collab, navigate, notify, openSheet, scoped, store } from "./store.js";
import {
    BASE_LOOK,
    chooseLook,
    chooseTheme,
    folderPaletteIds,
    lookIds,
    paletteOf,
    THEMES,
} from "./theme.js";
import { trustAvailable } from "./trust.js";
import { copyText, formatTokens, formatWhen, modelLabel, replyText, shortPath } from "./ui.js";

const agent = () => store.state.view.agent;
const isSession = () => store.state.view.conversation?.kind === "session";

/** Plan mode needs its extension, which the owner can turn off. */
export const planAvailable = () => store.state.server?.extensions?.includes("pocket-plan") === true;
/** Scheduled messages need theirs, and a session; so do goals. */
export const schedulesAvailable = () =>
    isSession() && store.state.server?.extensions?.includes("pocket-schedules") === true;
const goalsAvailable = () =>
    isSession() && store.state.server?.extensions?.includes("pocket-goals") === true;

/** Webhooks need the triggers extension; so does watching a PR, which is for sessions other than PiP. */
export const triggersOn = () =>
    store.state.server?.extensions?.includes("pocket-triggers") === true;
export const watchAvailable = () =>
    isSession() && !store.state.view.conversation?.pip && triggersOn();

/** Watch this session's pull request (its branch's, or `pr`), and say what that means. */
export async function watchPr(pr) {
    const { number } = await actions.watchPr(pr);

    notify(
        "info",
        `Watching PR #${number}: Pi hears when its checks fail, it has conflicts, or reviewers comment, until it is merged.`,
    );
}

/** How long a list of prompt templates is used before it is fetched again: someone may be writing one. */
const TEMPLATES_FOR_MS = 30_000;

/**
 * Fetch Pi's prompt templates for this conversation, unless a fresh list is here. Call when someone types a command. A
 * list is for a folder too: the session moved (`/cwd`, a worktree) has another project's templates and skills.
 */
export function loadTemplates() {
    const id = store.state.conversationId;
    const cwd = store.state.view.agent?.cwd;
    const cached = store.state.templates;
    const same = cached?.conversationId === id && cached?.cwd === cwd;

    if (id === null || (same && Date.now() - cached.at < TEMPLATES_FOR_MS)) {
        return;
    }

    store.set({
        templates: { conversationId: id, cwd, at: Date.now(), list: same ? cached.list : [] },
    });
    actions.prompts().then(
        (list) =>
            store.state.templates?.conversationId === id &&
            store.state.templates?.cwd === cwd &&
            store.set({ templates: { ...store.state.templates, list } }),
        () => {},
    );
}

/** The prompt templates and skills (`skill:name`) known for this conversation, as entries like the app's commands. */
function templates() {
    const cached = store.state.templates;

    if (
        cached?.conversationId !== store.state.conversationId ||
        cached.cwd !== store.state.view.agent?.cwd
    ) {
        return [];
    }

    return cached.list.map((template) => ({
        name: template.name,
        args: template.argumentHint ?? "",
        description: template.description,
        template: true,
        skill: template.skill === true,
    }));
}

/** A path as the conversation means it: absolute, `~/…`, or relative to its working directory. */
function pathFrom(arg) {
    if (arg.startsWith("/") || arg.startsWith("~")) {
        return arg;
    }

    const cwd = agent()?.cwd ?? store.state.server?.defaultCwd ?? "~";

    return `${cwd.replace(/\/$/, "")}/${arg}`;
}

/** Models matching what someone typed: exact ids or names first, then every word anywhere in the name. */
function findModels(query) {
    const needle = query.toLowerCase();
    const { models } = store.state;
    const exact = models.filter((model) =>
        [`${model.provider}/${model.id}`, model.id, model.name].some(
            (each) => each.toLowerCase() === needle,
        ),
    );

    if (exact.length > 0) {
        return exact;
    }

    const words = needle.split(/\s+/);

    return models.filter((model) => {
        const haystack = `${model.provider}/${model.id} ${model.name}`.toLowerCase();

        return words.every((word) => haystack.includes(word));
    });
}

async function switchModel(arg) {
    if (arg === "") {
        return openSheet({ type: "model" });
    }

    let found = findModels(arg);

    // The same model from several providers: keep the current provider.
    if (found.length > 1 && found.every((model) => model.id === found[0].id)) {
        const current = found.find((model) => model.provider === agent()?.model?.provider);

        if (current) {
            found = [current];
        }
    }

    if (found.length !== 1) {
        if (found.length === 0) {
            notify("info", `No model matches “${arg}”.`);
        }

        return openSheet({ type: "model", query: found.length === 0 ? "" : arg });
    }

    await actions.configure({ model: { provider: found[0].provider, modelId: found[0].id } });
}

async function setThinking(arg) {
    if (arg === "") {
        return openSheet({ type: "model" });
    }

    const levels = agent()?.levels ?? ["off"];
    const level = arg.toLowerCase();

    if (!levels.includes(level)) {
        throw new Error(
            levels.length > 1
                ? `Thinking can be ${levels.join(", ")}.`
                : `${modelLabel(agent())} does not think.`,
        );
    }

    await actions.configure({ thinkingLevel: level });
}

async function newSession(arg) {
    const cwd = arg === "" ? agent()?.cwd : pathFrom(arg);
    const created = await actions.createSession(cwd);

    navigate(created.id);
}

async function copyLast() {
    const { view } = store.state;

    for (let index = view.order.length - 1; index >= 0; index--) {
        const entry = view.entries.get(view.order[index]);

        if (entry?.kind !== "assistant") {
            continue;
        }

        const text = replyText(entry).trim();

        if (text === "") {
            continue;
        }

        await copyText(text);

        return notify("info", "Copied Pi’s last reply.");
    }

    notify("info", t("web.commands.no-reply", "Pi has not replied yet."));
}

function showSession() {
    const { view, server } = store.state;
    const stats = view.stats ?? {};
    const window = view.agent?.contextWindow;
    const level =
        view.agent?.reasoning && view.agent.thinkingLevel !== "off"
            ? ` (${levelLabel(view.agent.thinkingLevel)})`
            : "";
    const parts = [`${modelLabel(view.agent)}${level}`];

    if (window) {
        parts.push(
            t("web.commands.context-use", "context {percent}% of {window}", {
                percent: Math.round(((stats.contextTokens ?? 0) / window) * 100),
                window: formatTokens(window),
            }),
        );
    }

    parts.push(`$${(stats.cost ?? 0).toFixed(2)}`, shortPath(view.agent?.cwd, server?.home));
    notify("info", parts.join(" · "));
}

/**
 * `args` in brackets is optional. `available` hides a command where it does not apply. Keep the names the same as
 * `BUILT_IN_COMMANDS` in `src/server/extension-web.ts`, which keeps them from extensions' commands.
 */
const commands = () => [
    {
        name: "compact",
        args: t("builtin.command.copy-1", "[what to keep]"),
        description: t("builtin.command.copy-0", "Summarize older messages to free up context"),
        run: (arg) => actions.compact(arg || undefined),
    },
    {
        name: "reset",
        args: t("builtin.command.copy-3", "[handoff note]"),
        description: t(
            "builtin.command.copy-2",
            "Start a new context: Pi starts fresh, history stays",
        ),
        run: (arg) => actions.reset(arg || undefined),
    },
    {
        name: "instructions",
        args: t("builtin.command.copy-5", "[text]"),
        description: t("builtin.command.copy-4", "Set what Pi is told with every message here"),
        available: isSession,
        run: (arg) =>
            arg === "" ? openSheet({ type: "instructions" }) : actions.setInstructions(arg),
    },
    {
        name: "model",
        args: t("builtin.command.copy-7", "[name]"),
        description: t("builtin.command.copy-6", "Switch the model"),
        run: switchModel,
    },
    {
        name: "thinking",
        args: t("builtin.command.copy-9", "[level]"),
        description: t("builtin.command.copy-8", "Set the thinking level"),
        run: setThinking,
    },
    {
        name: "new",
        args: t("builtin.command.copy-11", "[folder]"),
        description: t("builtin.command.copy-10", "Start a new session in this folder"),
        available: () => !scoped(),
        run: newSession,
    },
    {
        name: "name",
        args: t("builtin.command.copy-13", "[title]"),
        description: t("builtin.command.copy-12", "Rename this session"),
        available: isSession,
        run: (arg) =>
            arg === ""
                ? openSheet({ type: "rename" })
                : actions.updateSession(store.state.view.conversation.id, { title: arg }),
    },
    {
        name: "cwd",
        args: t("builtin.command.copy-11", "[folder]"),
        description: t("builtin.command.copy-14", "Change the working directory"),
        run: (arg) =>
            arg === ""
                ? openSheet({ type: "cwd", mode: "change" })
                : actions.configure({ cwd: pathFrom(arg) }),
    },
    {
        name: "plan",
        description: t(
            "builtin.command.copy-15",
            "Plan mode on or off: Pi reads and proposes, and changes nothing",
        ),
        available: () => planAvailable() && isSession(),
        run: async () => {
            const on = !store.state.view.plan?.on;

            await actions.setPlan(on);
            notify(
                "info",
                on
                    ? "Plan mode is on: Pi proposes a plan and changes nothing until you approve it."
                    : "Plan mode is off.",
            );
        },
    },
    {
        name: "schedule",
        args: t("builtin.command.copy-17", "<when> <message>"),
        description: t(
            "builtin.command.copy-16",
            "Send Pi a message later or on repeat: in 2h …, tomorrow 9:00 …, every weekday 8:00 …",
        ),
        available: schedulesAvailable,
        run: async (arg) => {
            if (arg === "") {
                return openSheet({ type: "schedules" });
            }

            const added = await actions.schedule(arg);

            notify("info", `Scheduled for ${formatWhen(added.next)}.`);
        },
    },
    {
        name: "remember",
        args: t("builtin.command.copy-19", "<lesson>"),
        description: t(
            "builtin.command.copy-18",
            "Keep a lesson for Pi in every session of this project",
        ),
        available: () => memoryAvailable() && store.state.me?.role !== "viewer",
        run: async (arg) => {
            if (arg === "") {
                return openSheet({ type: "memory" });
            }

            const lesson = await remember(arg);

            notify(
                "info",
                lesson.pending
                    ? "Remembered. Pi uses it once the owner approves it."
                    : "Remembered. Pi gets it from its next message.",
            );
        },
    },
    {
        name: "until",
        args: t("builtin.command.copy-21", "<command>"),
        description: t(
            "builtin.command.copy-20",
            "Pi keeps going until a check passes, such as npm test (5 checks at most)",
        ),
        available: goalsAvailable,
        run: async (arg) => {
            if (arg === "") {
                throw new Error("Say which command has to pass, such as /until npm test.");
            }

            await actions.setGoal(arg);
            notify("info", `Pi keeps going until ${arg} passes, checked after each answer.`);
        },
    },
    {
        name: "watch",
        args: t("builtin.command.copy-23", "[PR number or URL]"),
        description: t(
            "builtin.command.copy-22",
            "Watch this session's pull request: Pi fixes failed checks and answers reviews until it is merged",
        ),
        available: watchAvailable,
        run: (arg) => watchPr(arg),
    },
    {
        name: "stop",
        description: t("builtin.command.copy-24", "Stop the current run"),
        run: () => actions.abort(),
    },
    {
        name: "copy",
        description: t("builtin.command.copy-25", "Copy Pi’s last reply"),
        run: copyLast,
    },
    {
        name: "find",
        args: t("builtin.command.copy-5", "[text]"),
        description: t("builtin.command.copy-26", "Find in this session’s messages"),
        run: (arg) => openSheet({ type: "find", query: arg }),
    },
    {
        name: "session",
        description: t("builtin.command.copy-27", "Show the model, context use, and cost"),
        run: showSession,
    },
    {
        name: "export",
        description: t("builtin.command.copy-28", "Download this conversation as Markdown"),
        run: () => location.assign(`/api/c/${store.state.view.conversation.id}/export`),
    },
    {
        name: "resume",
        description: t("builtin.command.copy-29", "Switch to another session"),
        run: () => store.set({ drawer: true }),
    },
    {
        name: "chat",
        description: t("builtin.command.copy-30", "Open the people chat"),
        available: collab,
        run: () => openSheet({ type: "chat" }),
    },
    {
        name: "browser",
        args: t("builtin.command.copy-32", "[address]"),
        description: t(
            "builtin.command.copy-31",
            "Open the browser Pi uses, or an address in it, such as localhost:5173",
        ),
        available: browserAvailable,
        run: (arg) => (arg === "" ? toggleBrowser() : openInBrowser(arg)),
    },
    {
        name: "files",
        description: t(
            "builtin.command.copy-33",
            "Show or hide the Files tile: the folder's files, and what changed",
        ),
        available: filesAvailable,
        run: () => toggleFiles("files"),
    },
    {
        name: "changes",
        description: t(
            "builtin.command.copy-34",
            "Review the folder's uncommitted changes, file by file",
        ),
        available: filesAvailable,
        run: () => toggleFiles("changes"),
    },
    {
        name: "branch",
        args: t("builtin.command.copy-7", "[name]"),
        description: t(
            "builtin.command.copy-35",
            "Switch the folder to another git branch, or make one",
        ),
        available: branchAvailable,
        run: (arg) => openSheet({ type: "branch", query: arg }),
    },
    {
        name: "pip",
        args: t("builtin.command.pip-args", "[message]"),
        description: t(
            "builtin.command.pip-description",
            "Open PiP, your assistant over every session, or ask it something",
        ),
        available: pipAvailable,
        run: (arg) => (arg === "" ? openPip() : askPip(arg)),
    },
    {
        name: "peek",
        description: t(
            "builtin.command.copy-36",
            "Show or hide peek tiles: other sessions' live work beside this one",
        ),
        available: () => store.state.server?.peeks === true,
        run: () => togglePeeks(),
    },
    {
        name: "artifacts",
        description: t("builtin.command.copy-37", "Show artifacts"),
        run: () => openSheet({ type: "artifacts" }),
    },
    {
        name: "login",
        description: t("builtin.command.copy-38", "Sign in to a model provider"),
        run: () => openSheet({ type: "providers" }),
    },
    {
        name: "settings",
        description: t("builtin.command.copy-39", "Open the menu"),
        run: () => openSheet({ type: "menu" }),
    },
    {
        name: "trust",
        description: t(
            "builtin.command.trust-description",
            "Whether Pi trusts this project, for its own skills",
        ),
        available: trustAvailable,
        run: () => openSheet({ type: "trust" }),
    },
    {
        name: "theme",
        args: t("builtin.command.copy-7", "[name]"),
        description: t(
            "builtin.command.copy-40",
            "Change the theme or the colors: a theme, an Omarchy palette, or desktop to follow yours",
        ),
        run: setTheme,
    },
];

/**
 * `/theme lantern` (a theme folder), `/theme gruvbox`, `/theme rose`, `/theme desktop` (colors); without a name, the
 * Appearance sheet. A theme's name wins over colors' of the same name.
 */
function setTheme(arg) {
    if (arg === "") {
        return openSheet({ type: "appearance" });
    }

    const needle = arg.toLowerCase().replace(/\s+/g, "-");
    const words = arg.toLowerCase();
    // Themes that work: one broken, which Appearance shows greyed out, would leave the app on Pocket.
    const looks = lookIds().flatMap((id) => {
        const listed = store.state.themeList?.find((each) => each.id === id);

        return id === BASE_LOOK || listed?.usable
            ? [{ id, name: id === BASE_LOOK ? "Pocket" : (listed?.name ?? id) }]
            : [];
    });
    // The desktop's colors only where the server has a desktop: elsewhere "desktop" would show Tokyo Night.
    const desktop = paletteOf("desktop").desktop === true;
    const palettes = [
        ...(desktop ? ["desktop"] : []),
        ...Object.keys(THEMES),
        ...folderPaletteIds(),
    ].map((id) => ({
        id,
        name: id === "desktop" ? "desktop" : paletteOf(id).name,
    }));
    const find = (list) =>
        list.find((each) => each.id === needle) ??
        list.find(
            (each) => each.id.startsWith(needle) || each.name.toLowerCase().startsWith(words),
        );
    const look = find(looks);

    if (look) {
        chooseLook(look.id);
        notify("info", `Theme: ${look.name}.`);

        return;
    }

    const palette = find(palettes);

    if (!palette) {
        const some = [
            "pocket",
            ...Object.keys(THEMES).slice(0, 3),
            ...(desktop ? ["desktop"] : []),
        ];

        throw new Error(
            `No theme or colors called “${arg}”. Try ${some.slice(0, -1).join(", ")}, or ${some.at(-1)}.`,
        );
    }

    chooseTheme(palette.id);
    notify("info", `Colors: ${palette.id === "desktop" ? "follow your desktop" : palette.name}.`);
}

/** Extensions' commands this person may run (`hello` lists them). A prompt template of the same name keeps it. */
function extensionCommands() {
    const prompts = new Set(templates().map((template) => template.name));

    return (store.state.server?.extensionCommands ?? [])
        .filter((command) => !prompts.has(command.name))
        .map((command) => ({
            ...command,
            extension: true,
            description:
                command.name === "design-open"
                    ? t(
                          "builtin.command.design-open-description",
                          "Open the Design canvas (or the design system, with `system`)",
                      )
                    : command.description,
            args:
                command.name === "design-open"
                    ? t("builtin.command.design-open-args", "[artifact | system]")
                    : command.args,
            run: async (args, requestId) => {
                const result = await actions.extensionCommand(command.id, args, requestId);

                if (result?.type === "toast") {
                    notify(
                        result.level,
                        command.name === "design-open" && result.message === "Opening Design"
                            ? t("builtin.design.opening", "Opening Design")
                            : result.message,
                    );
                }
            },
        }));
}

const available = () => [
    ...commands().filter((command) => command.available?.() ?? true),
    ...extensionCommands(),
];

/** The command a message runs, or null for a message to Pi (such as one starting with a path like /etc/hosts). */
export function parseCommand(text) {
    const match = /^\/([a-z][\w-]*)(?:\s+([\s\S]*))?$/i.exec(text.trim());

    if (!match) {
        return null;
    }

    const command = available().find((each) => each.name === match[1].toLowerCase());

    return command ? { command, arg: (match[2] ?? "").trim() } : null;
}

/** The prompt template a message to Pi starts with, or null. The app's own commands come first. */
export function parseTemplate(text) {
    const match = /^\/(\S+)(?:\s|$)/.exec(text.trim());

    if (!match || parseCommand(text)) {
        return null;
    }

    return templates().find((template) => template.name === match[1]) ?? null;
}

/** Commands to offer while someone types a command name: "/" lists them all, then Pi's prompt templates and skills. */
export function suggestCommands(text) {
    const match = /^\/([\w:-]*)$/.exec(text);

    if (!match) {
        return [];
    }

    const prefix = match[1].toLowerCase();
    const own = available();
    const commands = [
        ...own,
        ...templates().filter((template) => !own.some((command) => command.name === template.name)),
    ];
    const starts = commands.filter((each) => each.name.startsWith(prefix));
    // Two letters or more also find names that contain them: "/py" finds /copy.
    const contains =
        prefix.length < 2
            ? []
            : commands.filter(
                  (each) => !each.name.startsWith(prefix) && each.name.includes(prefix),
              );

    return [...starts, ...contains];
}
