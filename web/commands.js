// Slash commands in the message box ("/compact", "/model sonnet", …). They run here in the app and are never sent to Pi.
import { actions, collab, navigate, notify, openSheet, scoped, store } from "./store.js";
import { formatTokens, modelLabel, shortPath } from "./ui.js";

const agent = () => store.state.view.agent;
const isSession = () => store.state.view.conversation?.kind === "session";

/** A path as the conversation means it: absolute, `~/…`, or relative to its working directory. */
function pathFrom(arg) {
	if (arg.startsWith("/") || arg.startsWith("~")) return arg;
	const cwd = agent()?.cwd ?? store.state.server?.defaultCwd ?? "~";
	return `${cwd.replace(/\/$/, "")}/${arg}`;
}

/** Models matching what someone typed: exact ids or names first, then every word anywhere in the name. */
function findModels(query) {
	const needle = query.toLowerCase();
	const { models } = store.state;
	const exact = models.filter((model) => [`${model.provider}/${model.id}`, model.id, model.name].some((each) => each.toLowerCase() === needle));
	if (exact.length > 0) return exact;
	const words = needle.split(/\s+/);
	return models.filter((model) => {
		const haystack = `${model.provider}/${model.id} ${model.name}`.toLowerCase();
		return words.every((word) => haystack.includes(word));
	});
}

async function switchModel(arg) {
	if (arg === "") return openSheet({ type: "model" });
	let found = findModels(arg);
	// The same model from several providers: keep the current provider.
	if (found.length > 1 && found.every((model) => model.id === found[0].id)) {
		const current = found.find((model) => model.provider === agent()?.model?.provider);
		if (current) found = [current];
	}
	if (found.length !== 1) {
		if (found.length === 0) notify("info", `No model matches “${arg}”.`);
		return openSheet({ type: "model", query: found.length === 0 ? "" : arg });
	}
	await actions.configure({ model: { provider: found[0].provider, modelId: found[0].id } });
}

async function setThinking(arg) {
	if (arg === "") return openSheet({ type: "model" });
	const levels = agent()?.levels ?? ["off"];
	const level = arg.toLowerCase();
	if (!levels.includes(level)) throw new Error(levels.length > 1 ? `Thinking can be ${levels.join(", ")}.` : `${modelLabel(agent())} does not think.`);
	await actions.configure({ thinkingLevel: level });
}

async function newSession(arg) {
	const cwd = arg === "" ? agent()?.cwd : pathFrom(arg);
	const created = await actions.createSession(cwd);
	navigate(created.id);
}

/** Copy text, with a fallback for plain-http addresses, where the clipboard API does not exist. */
async function copyText(text) {
	if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
	const area = document.createElement("textarea");
	area.value = text;
	area.style.cssText = "position:fixed;opacity:0;top:0;left:0";
	document.body.append(area);
	area.select();
	const ok = document.execCommand("copy");
	area.remove();
	if (!ok) throw new Error("Could not copy.");
}

async function copyLast() {
	const { view } = store.state;
	for (let index = view.order.length - 1; index >= 0; index--) {
		const entry = view.entries.get(view.order[index]);
		if (entry?.kind !== "assistant") continue;
		const text = entry.blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n").trim();
		if (text === "") continue;
		await copyText(text);
		return notify("info", "Copied Pi’s last reply.");
	}
	notify("info", "Pi has not replied yet.");
}

function showSession() {
	const { view, server } = store.state;
	const stats = view.stats ?? {};
	const window = view.agent?.contextWindow;
	const level = view.agent?.reasoning && view.agent.thinkingLevel !== "off" ? ` (${view.agent.thinkingLevel})` : "";
	const parts = [`${modelLabel(view.agent)}${level}`];
	if (window) parts.push(`context ${Math.round(((stats.contextTokens ?? 0) / window) * 100)}% of ${formatTokens(window)}`);
	parts.push(`$${(stats.cost ?? 0).toFixed(2)}`, shortPath(view.agent?.cwd, server?.home));
	notify("info", parts.join(" · "));
}

/** `args` in brackets is optional. `available` hides a command where it does not apply. */
export const COMMANDS = [
	{ name: "compact", args: "[what to keep]", description: "Summarize older messages to free up context", run: (arg) => actions.compact(arg || undefined) },
	{ name: "model", args: "[name]", description: "Switch the model", run: switchModel },
	{ name: "thinking", args: "[level]", description: "Set the thinking level", run: setThinking },
	{ name: "new", args: "[folder]", description: "Start a new session in this folder", available: () => !scoped(), run: newSession },
	{
		name: "name",
		args: "[title]",
		description: "Rename this session",
		available: isSession,
		run: (arg) => (arg === "" ? openSheet({ type: "rename" }) : actions.updateSession(store.state.view.conversation.id, { title: arg })),
	},
	{ name: "cwd", args: "[folder]", description: "Change the working directory", run: (arg) => (arg === "" ? openSheet({ type: "cwd", mode: "change" }) : actions.configure({ cwd: pathFrom(arg) })) },
	{ name: "stop", description: "Stop the current run", run: () => actions.abort() },
	{ name: "copy", description: "Copy Pi’s last reply", run: copyLast },
	{ name: "session", description: "Show the model, context use, and cost", run: showSession },
	{ name: "resume", description: "Switch to another session", run: () => store.set({ drawer: true }) },
	{ name: "chat", description: "Open the people chat", available: collab, run: () => openSheet({ type: "chat" }) },
	{ name: "artifacts", description: "Show artifacts", run: () => openSheet({ type: "artifacts" }) },
	{ name: "login", description: "Sign in to a model provider", run: () => openSheet({ type: "providers" }) },
	{ name: "settings", description: "Open the menu", run: () => openSheet({ type: "menu" }) },
];

const available = () => COMMANDS.filter((command) => command.available?.() ?? true);

/** The command a message runs, or null for a message to Pi (such as one starting with a path like /etc/hosts). */
export function parseCommand(text) {
	const match = /^\/([a-z][\w-]*)(?:\s+([\s\S]*))?$/i.exec(text.trim());
	if (!match) return null;
	const command = available().find((each) => each.name === match[1].toLowerCase());
	return command ? { command, arg: (match[2] ?? "").trim() } : null;
}

/** Commands to offer while someone types a command name: "/" lists them all. */
export function suggestCommands(text) {
	const match = /^\/([\w-]*)$/.exec(text);
	if (!match) return [];
	const prefix = match[1].toLowerCase();
	const commands = available();
	const starts = commands.filter((each) => each.name.startsWith(prefix));
	// Two letters or more also find names that contain them: "/py" finds /copy.
	const contains = prefix.length < 2 ? [] : commands.filter((each) => !each.name.startsWith(prefix) && each.name.includes(prefix));
	return [...starts, ...contains];
}
