// Drop-in extensions: the owner's own modules in the data folder load like built-in ones, but only once turned on.
import { type App, cleanUp, fakeTab, lastText, modelTexts, newSession, openApp, owner, root, say, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

const dataDir = join(root, "data");
const dropIns = join(dataDir, "extensions");

/** A drop-in that imports Pi Durable and pi-ai by name, offers a tool, and blocks bash with a hook. */
const shout = (suffix: string) => `/** Shout offers a tool that shouts${suffix}. */
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, hook, ToolTask } from "@earendil-works/pi-durable";

export default () =>
	defineExtension({
		name: "shout",
		tools: [
			defineTool({
				name: "shout",
				description: "Shout",
				parameters: Type.Object({ text: Type.String() }),
				execute: async (args) => ({ content: [{ type: "text", text: args.text.toUpperCase() + "${suffix}" }] }),
			}),
		],
		hooks: [hook(ToolTask, { beforeTool: (call) => (call.name === "bash" ? { block: "no shell while shouting" } : undefined) })],
	});
`;

const route: FauxResponseStep = (request) => {
	const { role, text } = lastText(request as never);
	const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
	if (role === "toolResult") return fauxAssistantMessage([fauxText(`tool said: ${text}`)]);
	if (text.endsWith("shout hello")) return call("shout", { text: "hello" });
	if (text.endsWith("list files")) return call("bash", { command: "ls" });
	return fauxAssistantMessage([fauxText(`echo: ${text}`)]);
};
const model = scriptedModel(route);

let app: App;

before(async () => {
	mkdirSync(dropIns, { recursive: true });
	writeFileSync(join(dropIns, "shout.ts"), shout("!"));
	// The name of a built-in module: never loaded in its place.
	writeFileSync(join(dropIns, "plan.ts"), "export default () => { throw new Error('a drop-in must not replace a built-in'); };");
	app = await openApp(model, dataDir);
});

after(async () => {
	await app?.close();
	cleanUp();
});

const module = (file: string) => app.loader.list().filter((each) => each.file === file);

test("drop-ins are listed after the built-in modules, off until the owner turns them on, and cannot replace one", async () => {
	const [listed] = module("shout.ts");
	assert.equal(listed?.source, "drop-in");
	assert.equal(listed?.path, join(dropIns, "shout.ts"));
	assert.equal(listed?.summary, "Shout offers a tool that shouts!.");
	assert.equal(listed?.enabled, false);
	assert.equal(app.loader.list().at(-1)?.file, "shout.ts");
	assert.deepEqual(module("plan.ts").map((each) => each.source), ["built-in"]);
	assert.equal(realpathSync(join(dropIns, "node_modules")), realpathSync(join(import.meta.dirname, "..", "node_modules")), "drop-ins import Pi Pocket's packages");
	// Where the server keeps files is the owner's to know.
	const scoped = app.config.addUser("Sid", "guest", ["1"]).user;
	const seen = await app.extensions(scoped);
	assert.equal(seen.dropIns, undefined);
	assert.equal(seen.modules.find((each) => each.file === "shout.ts")?.path, undefined);
	assert.equal((await app.extensions(owner(app))).dropIns, dropIns);
});

test("a drop-in that is on gives Pi its tools and hooks, reloads when edited, and goes away when deleted", async () => {
	await app.setExtensionEnabled(owner(app), "shout.ts", true);
	assert.deepEqual(module("shout.ts")[0]?.extensions, [{ name: "shout", tools: ["shout"] }]);
	const id = await newSession(app);
	await say(app, id, "shout hello");
	await say(app, id, "list files");
	const said = (await modelTexts(app, id)).join("\n");
	assert.match(said, /tool said: HELLO!/);
	assert.match(said, /no shell while shouting/, "its hook runs on the built-in bash tool");

	// The owner's tab hears when the edited file is reloaded.
	const tab = fakeTab(undefined, owner(app));
	await app.attach(tab.client);
	app.loader.watch();
	try {
		writeFileSync(join(dropIns, "shout.ts"), shout("!!"));
		const notices = () => tab.events.filter((each) => each.event === "notice").map((each) => String(each.data.message));
		await until(() => notices().includes("Reloaded shout.ts: shout"), "the edited file to be reloaded");
		await say(app, id, "shout hello");
		assert.match((await modelTexts(app, id)).join("\n"), /tool said: HELLO!!/);

		rmSync(join(dropIns, "shout.ts"));
		await until(() => notices().includes("Removed the drop-in extension shout.ts."), "the deleted drop-in to be uninstalled");
		assert.equal(app.loader.extensionNames().includes("shout"), false);
		assert.deepEqual(module("shout.ts"), []);
	} finally {
		app.detach(tab.client);
	}
});
