// Slash commands in the message box ("/compact", "/model sonnet", …). They run here in the app and are never sent to Pi.
import { browserAvailable, openInBrowser, toggleBrowser } from "./browser.js";
import { filesAvailable, toggleFiles } from "./files-panel.js";
import { branchAvailable } from "./sheets/branch.js";
import { togglePeeks } from "./peeks.js";
import { actions, collab, navigate, notify, openSheet, scoped, store, uid } from "./store.js";
import { chooseTheme, THEMES } from "./theme.js";
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

/** How long a list of prompt templates is used before it is fetched again: someone may be writing one. */
const TEMPLATES_FOR_MS = 30_000;

let templateRequest = null;

/** Suggestions may use a recent list; executing a native command checks again before choosing its meaning. */
export function loadTemplates(force = false) {
    const id = store.state.conversationId;
    const cached = store.state.templates;

    if (id === null) {
        return Promise.resolve([]);
    }

    if (!force && cached?.conversationId === id && Date.now() - cached.at < TEMPLATES_FOR_MS) {
        return Promise.resolve(cached.list);
    }

    if (!force && templateRequest?.id === id) {
        return templateRequest.promise;
    }

    const request = {
        id,
        promise: actions
            .prompts(id)
            .then((list) => {
                if (templateRequest === request && store.state.conversationId === id) {
                    store.set({ templates: { conversationId: id, at: Date.now(), list } });
                }

                return list;
            })
            .finally(() => {
                if (templateRequest === request) {
                    templateRequest = null;
                }
            }),
    };

    templateRequest = request;

    return request.promise;
}

/** The prompt templates and skills (`skill:name`) known for this conversation, as entries like the app's commands. */
function templates() {
    const cached = store.state.templates;

    if (cached?.conversationId !== store.state.conversationId) {
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

    notify("info", "Pi has not replied yet.");
}

function showSession() {
    const { view, server } = store.state;
    const stats = view.stats ?? {};
    const window = view.agent?.contextWindow;
    const level =
        view.agent?.reasoning && view.agent.thinkingLevel !== "off"
            ? ` (${view.agent.thinkingLevel})`
            : "";
    const parts = [`${modelLabel(view.agent)}${level}`];

    if (window) {
        parts.push(
            `context ${Math.round(((stats.contextTokens ?? 0) / window) * 100)}% of ${formatTokens(window)}`,
        );
    }

    parts.push(`$${(stats.cost ?? 0).toFixed(2)}`, shortPath(view.agent?.cwd, server?.home));
    notify("info", parts.join(" · "));
}

/** `args` in brackets is optional. `available` hides a command where it does not apply. */
const COMMANDS = [
    {
        name: "compact",
        args: "[what to keep]",
        description: "Summarize older messages to free up context",
        run: (arg) => actions.compact(arg || undefined),
    },
    {
        name: "reset",
        args: "[handoff note]",
        description: "Start a new context: Pi starts fresh, history stays",
        run: (arg) => actions.reset(arg || undefined),
    },
    {
        name: "instructions",
        args: "[text]",
        description: "Set what Pi is told with every message here",
        available: isSession,
        run: (arg) =>
            arg === "" ? openSheet({ type: "instructions" }) : actions.setInstructions(arg),
    },
    { name: "model", args: "[name]", description: "Switch the model", run: switchModel },
    { name: "thinking", args: "[level]", description: "Set the thinking level", run: setThinking },
    {
        name: "new",
        args: "[folder]",
        description: "Start a new session in this folder",
        available: () => !scoped(),
        run: newSession,
    },
    {
        name: "name",
        args: "[title]",
        description: "Rename this session",
        available: isSession,
        run: (arg) =>
            arg === ""
                ? openSheet({ type: "rename" })
                : actions.updateSession(store.state.view.conversation.id, { title: arg }),
    },
    {
        name: "cwd",
        args: "[folder]",
        description: "Change the working directory",
        run: (arg) =>
            arg === ""
                ? openSheet({ type: "cwd", mode: "change" })
                : actions.configure({ cwd: pathFrom(arg) }),
    },
    {
        name: "plan",
        description: "Plan mode on or off: Pi reads and proposes, and changes nothing",
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
        args: "<when> <message>",
        description:
            "Send Pi a message later or on repeat: in 2h …, tomorrow 9:00 …, every weekday 8:00 …",
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
        name: "until",
        args: "<command>",
        description: "Pi keeps going until a check passes, such as npm test (5 checks at most)",
        available: goalsAvailable,
        run: async (arg) => {
            if (arg === "") {
                throw new Error("Say which command has to pass, such as /until npm test.");
            }

            await actions.setGoal(arg);
            notify("info", `Pi keeps going until ${arg} passes, checked after each answer.`);
        },
    },
    { name: "stop", description: "Stop the current run", run: () => actions.abort() },
    { name: "copy", description: "Copy Pi’s last reply", run: copyLast },
    {
        name: "find",
        args: "[text]",
        description: "Find in this session’s messages",
        run: (arg) => openSheet({ type: "find", query: arg }),
    },
    { name: "session", description: "Show the model, context use, and cost", run: showSession },
    {
        name: "export",
        description: "Download this conversation as Markdown",
        run: () => location.assign(`/api/c/${store.state.view.conversation.id}/export`),
    },
    {
        name: "resume",
        description: "Switch to another session",
        run: () => store.set({ drawer: true }),
    },
    {
        name: "chat",
        description: "Open the people chat",
        available: collab,
        run: () => openSheet({ type: "chat" }),
    },
    {
        name: "browser",
        args: "[address]",
        description: "Open the browser Pi uses, or an address in it, such as localhost:5173",
        available: browserAvailable,
        run: (arg) => (arg === "" ? toggleBrowser() : openInBrowser(arg)),
    },
    {
        name: "files",
        description: "Show or hide the Files tile: the folder's files, and what changed",
        available: filesAvailable,
        run: () => toggleFiles("files"),
    },
    {
        name: "changes",
        description: "Review the folder's uncommitted changes, file by file",
        available: filesAvailable,
        run: () => toggleFiles("changes"),
    },
    {
        name: "branch",
        args: "[name]",
        description: "Switch the folder to another git branch, or make one",
        available: branchAvailable,
        run: (arg) => openSheet({ type: "branch", query: arg }),
    },
    {
        name: "peek",
        description: "Show or hide peek tiles: other sessions' live work beside this one",
        available: () => store.state.server?.peeks === true,
        run: () => togglePeeks(),
    },
    {
        name: "artifacts",
        description: "Show artifacts",
        run: () => openSheet({ type: "artifacts" }),
    },
    {
        name: "login",
        description: "Sign in to a model provider",
        run: () => openSheet({ type: "providers" }),
    },
    { name: "settings", description: "Open the menu", run: () => openSheet({ type: "menu" }) },
    {
        name: "theme",
        args: "[name]",
        description: "Change the theme: an Omarchy theme, or desktop to follow yours",
        run: setTheme,
    },
];

/** `/theme gruvbox`, `/theme rose`, `/theme desktop`; without a name, the Appearance sheet. */
function setTheme(arg) {
    if (arg === "") {
        return openSheet({ type: "appearance" });
    }

    const needle = arg.toLowerCase().replace(/\s+/g, "-");
    const ids = ["desktop", ...Object.keys(THEMES)];
    const id =
        ids.find((each) => each === needle) ??
        ids.find(
            (each) =>
                each.startsWith(needle) ||
                THEMES[each]?.name.toLowerCase().startsWith(arg.toLowerCase()),
        );

    if (!id) {
        throw new Error(
            `No theme called “${arg}”. Try ${Object.keys(THEMES).slice(0, 4).join(", ")}, or desktop.`,
        );
    }

    chooseTheme(id);
    notify("info", `Theme: ${id === "desktop" ? "follows your desktop" : THEMES[id].name}.`);
}

const commandKey = (id) => `pocket.extension-command.${store.state.me?.id}.${id}`;

/** Clearing the box deliberately abandons its saved request; a network error does not. */
export function clearPendingCommand(id) {
    sessionStorage.removeItem(commandKey(id));
}

function savedCommand(key) {
    const saved = JSON.parse(sessionStorage.getItem(key) ?? "null");

    if (
        saved !== null &&
        (typeof saved !== "object" ||
            ["name", "args", "commandId", "requestId"].some(
                (field) => typeof saved[field] !== "string",
            ) ||
            !saved.name ||
            !saved.commandId ||
            !saved.requestId ||
            !["conversation", "global"].includes(saved.scope))
    ) {
        throw new Error(
            "The saved command request is invalid. Clear the message box before starting another.",
        );
    }

    return saved;
}

/** Only a terminal command receipt acknowledges this request, not merely a successful HTTP status. */
async function sendCommand(request, id, key) {
    const result = await actions.extensionCommand(
        id,
        request.commandId,
        request.args,
        request.requestId,
    );
    const feedback =
        result?.type === "card"
            ? typeof result.output === "string"
            : result?.type === "toast" &&
              ["info", "warning", "error"].includes(result.level) &&
              typeof result.message === "string";

    if (
        !Number.isSafeInteger(result?.taskId) ||
        result.taskId <= 0 ||
        !["done", "failed", "interrupted", "stopped"].includes(result.status) ||
        !feedback
    ) {
        throw new Error("The server did not return a valid command receipt. Retry this request.");
    }

    if (savedCommand(key)?.requestId === request.requestId) {
        sessionStorage.removeItem(key);
    }

    if (result.type === "toast") {
        notify(result.level, result.message);
    }
}

async function invokeCommand(command, args) {
    const id = store.state.conversationId;
    const key = commandKey(id);
    let request = savedCommand(key);

    if (request?.name !== command.name || request.args !== args) {
        const prompts = await loadTemplates(true);

        if (store.state.conversationId !== id) {
            throw new Error("The conversation changed before the command started.");
        }

        if (prompts.some((template) => template.name.toLowerCase() === command.name)) {
            throw new Error(
                "A prompt template now has that command name. Choose it from the refreshed list.",
            );
        }

        request = savedCommand(key);

        if (request?.name !== command.name || request.args !== args) {
            request = {
                name: command.name,
                scope: command.scope,
                commandId: command.id,
                args,
                requestId: uid(),
            };
            // Keep the original registration too: rebuilding a module must not turn a retry into a different operation.
            sessionStorage.setItem(key, JSON.stringify(request));
        }
    }

    await sendCommand(request, id, key);
}

/** An unacknowledged request can still be retried after its module is disabled or rebuilt. */
function pendingCommand(match) {
    const id = store.state.conversationId;

    if (id === null || store.state.me == null) {
        return null;
    }

    const key = commandKey(id);
    const request = savedCommand(key);
    const arg = (match[2] ?? "").trim();

    if (request?.name !== match[1].toLowerCase() || request.args !== arg) {
        return null;
    }

    return {
        command: {
            name: request.name,
            scope: request.scope,
            extension: true,
            description: "Retry the previous request",
            run: () => sendCommand(request, id, key),
        },
        arg,
    };
}

/** Built-ins and existing prompt templates keep their names; extension commands use the remaining ones. */
function extensionCommands() {
    const prompts = new Set(templates().map((template) => template.name.toLowerCase()));

    return (store.state.server?.extensionCommands ?? [])
        .filter((command) => !prompts.has(command.name))
        .map((command) => ({
            ...command,
            extension: true,
            run: (args) => invokeCommand(command, args),
        }));
}

const available = () => [
    ...COMMANDS.filter((command) => command.available?.() ?? true),
    ...extensionCommands(),
];

/** The command a message runs, or null for a message to Pi (such as one starting with a path like /etc/hosts). */
export function parseCommand(text) {
    const match = /^\/([a-z][\w-]*)(?:\s+([\s\S]*))?$/i.exec(text.trim());

    if (!match) {
        return null;
    }

    if (!COMMANDS.some((command) => command.name === match[1].toLowerCase())) {
        try {
            const pending = pendingCommand(match);

            if (pending) {
                return pending;
            }
        } catch (error) {
            // Keep rendering, but never turn an unreadable command retry into a message to Pi.
            return {
                command: {
                    name: match[1].toLowerCase(),
                    scope: "conversation",
                    extension: true,
                    description: "The previous command request could not be read",
                    run: () => {
                        throw error;
                    },
                },
                arg: (match[2] ?? "").trim(),
            };
        }
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
