// End-to-end tests of the server core with a scripted model: no network, no API keys, no Pi config.
import {
	type App,
	type Attachment,
	cleanUp,
	fakeTab,
	lastText,
	openApp,
	owner as ownerOf,
	root,
	say as sayTo,
	scriptedModel,
	newSession as startSession,
	until,
	work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";

/** The provider session id each request carried, with the message it answered. */
const requests: { sessionId: string | undefined; text: string }[] = [];

/** One scripted model for every conversation, answering by the last message, like a tiny real model. */
const route: FauxResponseStep = (context, options) => {
	const { role, text } = lastText(context as never);
	requests.push({ sessionId: (options as { sessionId?: string } | undefined)?.sessionId, text });
	const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
	if (role === "toolResult") return fauxAssistantMessage([fauxText(`tool said: ${text}`)]);
	if (text.includes("make an artifact")) return call("artifact", { id: "Demo Page", title: "Demo", content: "<h1>one</h1>" });
	if (text.includes("fix the artifact")) {
		return call("artifact", { id: "demo-page", title: "Demo", edits: [{ oldText: "one", newText: "two" }] });
	}
	if (text.includes("start a helper")) return call("subagent", { action: "spawn", name: "helper", message: "say hi please" });
	if (text.includes("run a script")) {
		return call("codemode", {
			code: 'for (const body of ["<p>one</p>", "<p>two</p>"]) await tools.artifact({ id: "notes", title: "Notes", content: body });\nreturn await tools.read({ path: "hello.txt" });',
		});
	}
	if (text.includes("say hi please")) return fauxAssistantMessage([fauxText("hi from helper")]);
	if (text.startsWith("[subagent helper answered")) return fauxAssistantMessage([fauxText("noted")]);
	return fauxAssistantMessage([fauxText(`echo: ${text}`)]);
};

const faux = scriptedModel(route);

let app: App;
const open = () => openApp(faux);
const owner = () => ownerOf(app);
const newSession = () => startSession(app);
const say = (id: ConversationId, text: string, attachments?: Attachment[]) => sayTo(app, id, text, attachments);

before(async () => {
	app = await open();
});

after(async () => {
	await app?.close();
	cleanUp();
});

test("a session lists itself and takes its first message as its title", async () => {
	const id = await newSession();
	await say(id, "hello there");
	const session = app.sessions().find((each) => each.id === Number(id));
	assert.equal(session?.title, "hello there");
	assert.equal(session?.cwd, work);
});

test("the artifact tool publishes versions, edits the latest, and serves the body", async () => {
	const id = await newSession();
	await say(id, "please make an artifact");
	const first = await app.artifactBody(id, "demo-page", undefined);
	assert.equal(first.version, 1);
	assert.equal(first.content, "<h1>one</h1>");
	await say(id, "now fix the artifact");
	const second = await app.artifactBody(id, "demo-page", undefined);
	assert.equal(second.version, 2);
	assert.equal(second.content, "<h1>two</h1>");
	assert.equal((await app.artifactBody(id, "demo-page", 1)).content, "<h1>one</h1>");
});

test("each conversation sends its own provider session id, the same on every request and after a reopen", async () => {
	const first = await newSession();
	const second = await newSession();
	const sent = (text: string) => requests.findLast((request) => request.text === text)?.sessionId;
	await say(first, "session id one");
	await say(first, "session id two");
	await say(second, "session id three");
	const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
	assert.match(sent("session id one") ?? "", uuid, "OpenCode refuses requests without one");
	assert.equal(sent("session id two"), sent("session id one"));
	assert.notEqual(sent("session id three"), sent("session id one"));
	await app.close();
	app = await open();
	await say(first, "session id four");
	assert.equal(sent("session id four"), sent("session id one"));
});

test("a sign-in that needs this installation's id gets Pi's, the same every time", async () => {
	const calls: unknown[][] = [];
	const login = app.models.login;
	app.models.login = (async (...args: unknown[]) => {
		calls.push(args);
		return {} as never;
	}) as typeof login;
	try {
		app.providers.startLogin(owner(), "openai-chatgpt", "oauth");
		app.providers.startLogin(owner(), "openai-chatgpt", "oauth");
		await until(() => calls.length === 2, "both sign-ins to start");
		const ids = calls.map((args) => (args[3] as { getDeviceId?: () => string } | undefined)?.getDeviceId?.());
		assert.match(ids[0] ?? "", /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		assert.equal(ids[1], ids[0]);
		const { readFileSync } = await import("node:fs");
		assert.equal(JSON.parse(readFileSync(join(process.env.PI_CODING_AGENT_DIR!, "settings.json"), "utf8")).deviceId, ids[0], "kept in Pi's settings");
	} finally {
		app.models.login = login;
	}
});

test("codemode is on by default, and a script's nested calls each do their own work", async () => {
	assert.ok((await app.extensions(owner())).modules.some((module) => module.file === "codemode.ts" && module.enabled));
	writeFileSync(join(work, "hello.txt"), "hello from a file\n");
	const id = await newSession();
	await say(id, "please run a script");
	assert.equal((await app.artifactBody(id, "notes", 1)).content, "<p>one</p>");
	assert.equal((await app.artifactBody(id, "notes", undefined)).version, 2, "the second nested artifact call made its own version");
	const { BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");
	const view = await (await app.harness.conversation(id, BACKGROUND_CONTEXT))!.context(BACKGROUND_CONTEXT);
	const said = view.messages.map((message) => JSON.stringify(message.content)).join("\n");
	assert.match(said, /tool said: Script completed\\nWall time [\d.]+ seconds\\nOutput:\\n/);
	assert.match(said, /hello from a file/);
});

test("a background subagent reports its answer back to the parent", async () => {
	const id = await newSession();
	await say(id, "start a helper");
	const { BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");
	const conversation = (await app.harness.conversation(id, BACKGROUND_CONTEXT))!;
	const texts = async () => {
		const view = await conversation.context(BACKGROUND_CONTEXT);
		return view.messages.map((message) => JSON.stringify(message.content));
	};
	await until(async () => (await texts()).some((text) => text.includes("noted")), "the parent to react to the report");
	assert.ok((await texts()).some((text) => text.includes("[subagent helper answered, no reply needed] hi from helper")));
});

test("a pasted image is stored with its message and read back, and image paths resolve in the session folder", async () => {
	const id = await newSession();
	await app.commands.configure(id, owner(), { model: { provider: "faux", modelId: "faux-vision" } });
	const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
	const path = join(app.uploadDirectory(id), "dot.png");
	writeFileSync(path, png);
	await say(id, "look at this", [{ path, name: "dot.png", mime: "image/png", size: png.length }]);
	const { BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");
	const conversation = (await app.harness.conversation(id, BACKGROUND_CONTEXT))!;
	const entries = await conversation.entries({}, 256, undefined, BACKGROUND_CONTEXT);
	const user = entries.items.find((entry) => entry.kind === "pi.user")!;
	const image = await app.entryImage(id, user.id as unknown as number, 0);
	assert.equal(image?.mimeType, "image/png");
	assert.deepEqual(image?.data, png);
	assert.equal(await app.entryImage(id, user.id as unknown as number, 1), undefined);
	assert.equal(await app.entryImage((Number(id) + 1000) as unknown as ConversationId, user.id as unknown as number, 0), undefined);
	assert.equal(app.conversationPath(id, "chart.png"), join(work, "chart.png"));
	assert.equal(app.conversationPath(id, "/tmp/chart.png"), "/tmp/chart.png");
});

test("long polling delivers the stream's events, resends until acknowledged, and waits for new ones", async () => {
	const { createServer } = await import("node:http");
	const { createHandler } = await import("../src/server/http.ts");
	const server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as { port: number }).port;
	type Poll = { session: string; events: { seq: number; event: string; data: Record<string, unknown> }[] };
	const poll = async (query: string): Promise<Poll> =>
		(await fetch(`http://127.0.0.1:${port}/api/poll?${query}`, { headers: { authorization: `Bearer ${app.config.ownerToken}` } })).json() as Promise<Poll>;
	try {
		const id = await newSession();
		const first = await poll(`tab=t1&c=${id}`);
		assert.deepEqual(first.events.slice(0, 2).map((each) => each.event), ["hello", "sessions"]);
		assert.ok(first.events.some((each) => each.event === "view" && each.data.full === true));
		// Without an acknowledgement, the same events come again (a debounced update may follow them).
		const again = await poll(`tab=t1&c=${id}&session=${first.session}&ack=0`);
		assert.deepEqual(again.events.slice(0, first.events.length).map((each) => each.seq), first.events.map((each) => each.seq));
		let ack = first.events.at(-1)!.seq;
		const sent = say(id, "hello by polling");
		let seen = false;
		for (let round = 0; round < 20 && !seen; round++) {
			const next = await poll(`tab=t1&c=${id}&session=${first.session}&ack=${ack}`);
			assert.equal(next.session, first.session);
			assert.ok(next.events.every((each) => each.seq > ack));
			for (const each of next.events) {
				ack = each.seq;
				const entries = (each.data.entries ?? []) as { kind: string; text?: string }[];
				if (each.event === "view" && entries.some((entry) => entry.kind === "user" && entry.text === "hello by polling")) seen = true;
			}
		}
		await sent;
		assert.ok(seen, "the new message arrived by polling");
		await poll(`session=${first.session}&close=1`);
		const fresh = await poll(`tab=t1&c=${id}&session=${first.session}&ack=${ack}`);
		assert.notEqual(fresh.session, first.session, "a closed session starts over");
		await poll(`session=${fresh.session}&close=1`);
	} finally {
		server.closeAllConnections();
		server.close();
	}
});

test("the owner turns extensions off and on, the guard follows its switch, and the choice survives a restart", async () => {
	const module = (file: string) => app.loader.list().find((each) => each.file === file)!;
	assert.deepEqual(
		app.loader.list().map((each) => each.file),
		["prompt.ts", "artifacts.ts", "subagents.ts", "schedules.ts", "goals.ts", "plan.ts", "guard.ts", "codemode.ts"],
	);
	assert.equal(module("prompt.ts").required, true);
	assert.equal(module("codemode.ts").title, "Codemode");
	assert.match(module("codemode.ts").summary, /^Codemode lets the agent write JavaScript that calls its other tools/);
	assert.deepEqual(module("codemode.ts").extensions[0]?.tools, ["codemode"]);
	assert.match(module("guard.ts").summary, /^Lancet Guard for Pi Pocket's tools\.$/);
	assert.deepEqual(module("subagents.ts").extensions[0]?.tools, ["subagent"]);

	// Lancet Guard is off until the owner turns it on.
	assert.equal(module("guard.ts").enabled, false);
	assert.ok(!app.loader.extensionNames().includes("pocket-guard"));
	assert.match((await app.guardStatus()).detail, /off in Pi Pocket/);
	await app.setExtensionEnabled(owner(), "guard.ts", true);
	assert.ok(app.loader.extensionNames().includes("pocket-guard"));
	assert.deepEqual(app.config.enabledExtensions, ["guard.ts"]);

	await app.setExtensionEnabled(owner(), "subagents.ts", false);
	assert.equal(module("subagents.ts").enabled, false);
	assert.deepEqual(module("subagents.ts").extensions, []);
	assert.ok(!app.loader.extensionNames().includes("pocket-subagents"));

	await app.setExtensionEnabled(owner(), "guard.ts", false);
	const guard = await app.guardStatus();
	assert.equal(guard.enabled, false);
	assert.match(guard.detail, /off in Pi Pocket/);

	await assert.rejects(app.setExtensionEnabled(owner(), "prompt.ts", false), /required/);
	await assert.rejects(app.setExtensionEnabled(owner(), "nope.ts", false), /no extension module/);

	await app.close();
	app = await open();
	assert.equal(module("subagents.ts").enabled, false);
	assert.ok(!app.loader.extensionNames().includes("pocket-subagents"));
	assert.equal(module("guard.ts").enabled, false);

	await app.setExtensionEnabled(owner(), "subagents.ts", true);
	await app.setExtensionEnabled(owner(), "guard.ts", true);
	assert.deepEqual(module("subagents.ts").extensions[0]?.tools, ["subagent"]);
	assert.ok(app.loader.extensionNames().includes("pocket-guard"));
	assert.deepEqual(app.config.disabledExtensions, []);

	// Turned on, it stays on after a restart.
	await app.close();
	app = await open();
	assert.equal(module("guard.ts").enabled, true);
	assert.ok(app.loader.extensionNames().includes("pocket-guard"));
});

test("everyone signed in gets the desktop's theme colors; only the owner gets its wallpaper", async () => {
	const { createServer } = await import("node:http");
	const { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { createHandler } = await import("../src/server/http.ts");
	const home = mkdtempSync(join(tmpdir(), "pocket-desktop-"));
	const current = join(home, ".local/state/omarchy/current");
	mkdirSync(join(current, "theme"), { recursive: true });
	writeFileSync(join(current, "theme", "colors.toml"), 'background = "#111111"\nforeground = "#eeeeee"\n');
	writeFileSync(join(current, "theme.name"), "gruvbox\n");
	// A real PNG header, so the image check accepts it.
	writeFileSync(join(current, "theme", "wall.png"), Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"));
	symlinkSync(join(current, "theme", "wall.png"), join(current, "background"));
	const server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as { port: number }).port;
	const guest = app.config.addUser("Guest", "guest");
	const call = (token: string, path: string) => fetch(`http://127.0.0.1:${port}/api/${path}`, { headers: { authorization: `Bearer ${token}` } });
	const realHome = process.env.HOME;
	process.env.HOME = home;
	try {
		type Theme = { theme: { name: string; wallpaper: boolean; stamp: string } };
		const owner = (await (await call(app.config.ownerToken, "theme")).json()) as Theme;
		assert.equal(owner.theme.name, "gruvbox");
		assert.equal(owner.theme.wallpaper, true);
		assert.ok(!owner.theme.stamp.includes(home), "the stamp names no paths");
		const theirs = (await (await call(guest.token, "theme")).json()) as Theme;
		assert.equal(theirs.theme.name, "gruvbox");
		assert.equal(theirs.theme.wallpaper, false);
		assert.equal((await call(guest.token, "theme/wallpaper")).status, 403);
		assert.equal((await call(app.config.ownerToken, "theme/wallpaper")).status, 200);
	} finally {
		process.env.HOME = realHome;
		app.config.removeUser(guest.user.id);
		server.closeAllConnections();
		server.close();
	}
});

test("anyone signed in can list extensions; only the owner can change them", async () => {
	const { createServer } = await import("node:http");
	const { createHandler } = await import("../src/server/http.ts");
	const server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as { port: number }).port;
	const guest = app.config.addUser("Guest", "guest");
	const call = (token: string, path: string, body?: unknown) =>
		fetch(`http://127.0.0.1:${port}/api/${path}`, {
			method: body === undefined ? "GET" : "POST",
			headers: { authorization: `Bearer ${token}`, "x-pocket": "1", "content-type": "application/json" },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
	try {
		const listed = await call(guest.token, "extensions");
		assert.equal(listed.status, 200);
		assert.deepEqual(
			((await listed.json()) as { modules: { file: string }[] }).modules.map((module) => module.file),
			app.loader.list().map((module) => module.file),
		);
		assert.equal((await call(guest.token, "extensions/guard.ts", { enabled: false })).status, 403);
		assert.equal((await call(guest.token, "extensions/guard.ts/reload", {})).status, 403);
		assert.equal((await call(app.config.ownerToken, "extensions/guard.ts", { enabled: "no" })).status, 400);
		const off = await call(app.config.ownerToken, "extensions/guard.ts", { enabled: false });
		assert.equal(off.status, 200);
		assert.equal(((await off.json()) as { modules: { file: string; enabled: boolean }[] }).modules.find((each) => each.file === "guard.ts")?.enabled, false);
		assert.equal((await call(app.config.ownerToken, "extensions/guard.ts/reload", {})).status, 409);
		assert.equal((await call(app.config.ownerToken, "extensions/guard.ts", { enabled: true })).status, 200);
		assert.equal((await call(app.config.ownerToken, "extensions/guard.ts/reload", {})).status, 200);
	} finally {
		app.config.removeUser(guest.user.id);
		server.closeAllConnections();
		server.close();
	}
});

test("people chat beside Pi: presence, typing, one post per request, and the chat survives a reopen", async () => {
	const id = await newSession();
	const guest = app.config.addUser("Alex", "guest");
	type Event = { event: string; data: Record<string, unknown> };
	const tab = (name: string, user: (typeof guest)["user"], events: Event[]) => ({
		id: name,
		user,
		conversationId: id,
		sentEntries: new Set<number>(),
		orderKey: "",
		send: (event: string, data: unknown) => events.push({ event, data: data as Record<string, unknown> }),
	});
	const mine: Event[] = [];
	const ownerTab = tab("tab-owner", owner(), mine);
	const guestTab = tab("tab-guest", guest.user, []);
	type People = { name: string; typing?: string }[];
	const people = () => (mine.findLast((each) => each.event === "presence")?.data.people ?? []) as People;
	try {
		await app.attach(ownerTab);
		assert.deepEqual(mine.find((each) => each.event === "chat")?.data, { conversationId: id, full: true, messages: [] });
		await app.attach(guestTab);
		assert.deepEqual(people().map((each) => each.name).sort(), ["Alex", owner().name].sort());

		app.collab.setTyping(id, guest.user, "chat");
		await until(() => people().find((each) => each.name === "Alex")?.typing === "chat", "Alex to show as typing");

		const posted = await app.collab.postChat(id, guest.user, { text: "  hi team  ", requestId: "r1" });
		assert.equal(posted.text, "hi team");
		assert.equal((await app.collab.postChat(id, guest.user, { text: "hi team", requestId: "r1" })).id, posted.id, "a retry does not post twice");
		await until(
			() => mine.some((each) => each.event === "chat" && (each.data.messages as { id: string }[]).some((message) => message.id === posted.id)),
			"the message to reach the other tab",
		);
		await until(() => people().find((each) => each.name === "Alex")?.typing === undefined, "sending to stop the typing indicator");
		await assert.rejects(app.collab.postChat(id, guest.user, { text: "   ", requestId: "r2" }), /empty/);

		app.detach(guestTab);
		await until(() => people().length === 1, "Alex to leave");
	} finally {
		app.detach(ownerTab);
		app.detach(guestTab);
		app.config.removeUser(guest.user.id);
	}
	await app.close();
	app = await open();
	const { BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");
	const { ChatDoc } = await import("../src/server/docs.ts");
	const stored = await app.harness.snapshot(ChatDoc, id, BACKGROUND_CONTEXT);
	assert.deepEqual(stored?.messages.map((message) => [message.name, message.text]), [["Alex", "hi team"]]);
});

/** A fake browser tab attached to a conversation, recording what the server sends it. */
test("viewers read and chat but never steer; people invited to one session see only that session", async () => {
	const id = await newSession();
	const other = await newSession();
	const viewer = app.config.addUser("Vee", "viewer").user;
	const scoped = app.config.addUser("Sam", "guest", [String(id)]).user;
	try {
		await assert.rejects(app.commands.submit(id, viewer, { text: "hi", requestId: "v1" }), /not steer/);
		await assert.rejects(app.commands.abort(id, viewer), /not steer/);
		await assert.rejects(app.commands.createSession(viewer, { cwd: work }), /not steer/);
		await assert.rejects(app.answerApproval("nope", true, viewer), /not steer/);
		assert.equal((await app.collab.postChat(id, viewer, { text: "just watching", requestId: "v2" })).text, "just watching");

		assert.deepEqual(app.sessions(scoped).map((each) => each.id), [Number(id)]);
		assert.ok(app.sessions(owner()).length >= 2);
		await assert.rejects(app.commands.submit(other, scoped, { text: "hi", requestId: "s1" }), /not shared/);
		await assert.rejects(app.commands.createSession(scoped, { cwd: work }), /one session/);
		const tab = fakeTab(other, scoped);
		await app.attach(tab.client);
		assert.match(String(tab.last("missing")?.message), /not shared/);
		app.detach(tab.client);

		// The owner widens Sam's access and makes Vee a guest.
		app.setAccess(owner(), scoped.id, { sessions: null });
		assert.equal(app.config.userById(scoped.id)?.sessions, undefined);
		app.setAccess(owner(), viewer.id, { role: "guest" });
		assert.equal(app.config.userById(viewer.id)?.role, "guest");
		assert.throws(() => app.setAccess(viewer, scoped.id, { role: "viewer" }), /owner/);
		assert.throws(() => app.setAccess(owner(), owner().id, { role: "viewer" }), /owner can do everything/);
	} finally {
		app.config.removeUser(viewer.id);
		app.config.removeUser(scoped.id);
	}
});

test("take turns: only the driver steers, others ask, the driver hands over, and it all shows as activity", async () => {
	const id = await newSession();
	const alex = app.config.addUser("Alex", "guest").user;
	const ownerTab = fakeTab(id, owner());
	const alexTab = fakeTab(id, alex);
	try {
		await app.attach(ownerTab.client);
		await app.attach(alexTab.client);
		await app.collab.turns(id, owner(), { action: "on" });
		await assert.rejects(app.commands.submit(id, alex, { text: "my turn?", requestId: "t1" }), /is driving/);
		await assert.rejects(app.commands.configure(id, alex, { thinkingLevel: "off" }), /is driving/);
		await assert.rejects(app.collab.turns(id, alex, { action: "claim" }), /is driving/);
		await app.collab.turns(id, alex, { action: "ask" });
		await until(() => (alexTab.field("turns") as { asks?: string[] } | undefined)?.asks?.includes(alex.id) === true, "the ask to show");
		await app.collab.turns(id, owner(), { action: "handover", to: alex.id });
		await until(() => (ownerTab.field("turns") as { driver?: string } | undefined)?.driver === alex.id, "Alex to drive");
		await assert.rejects(app.commands.submit(id, owner(), { text: "me again", requestId: "t2" }), /Alex is driving/);
		await app.commands.submit(id, alex, { text: "hello from the driver", requestId: "t3" });
		await app.collab.turns(id, alex, { action: "off" });
		const chat = (await app.harness.snapshot((await import("../src/server/docs.ts")).ChatDoc, id, (await import("@earendil-works/chord/context")).BACKGROUND_CONTEXT))!;
		const lines = chat.messages.filter((each) => each.kind === "event").map((each) => `${each.name} ${each.text}`);
		assert.deepEqual(lines, [
			`${owner().name} turned on take turns and is driving`,
			"Alex asked to drive",
			`${owner().name} handed the wheel to Alex`,
			"Alex turned off take turns",
		]);
		// The others saw it as notices too.
		assert.ok(alexTab.events.some((each) => each.event === "notice" && String(each.data.message).includes("handed the wheel to Alex")));
	} finally {
		app.detach(ownerTab.client);
		app.detach(alexTab.client);
		app.config.removeUser(alex.id);
	}
});

test("a tab that closes while it is attaching is never counted as there", async () => {
	const id = await newSession();
	const gone = fakeTab(id, owner());
	const attaching = app.attach(gone.client);
	app.detach(gone.client);
	await attaching;
	const here = fakeTab(id, owner());
	try {
		await app.attach(here.client);
		const people = (here.last("presence")?.people ?? []) as { id: string; tabs: number }[];
		assert.deepEqual(people.map((person) => [person.id, person.tabs]), [[owner().id, 1]]);
		assert.equal(gone.events.some((each) => each.event === "view"), false, "the closed tab got no view");
	} finally {
		app.detach(here.client);
	}
});

test("requests with the wrong types are refused, and nothing odd is stored", async () => {
	const id = await newSession();
	await assert.rejects(app.commands.updateSession(id, owner(), { archived: "yes" as never }), /archived must be true or false/);
	await assert.rejects(app.commands.updateSession(id, owner(), { title: 5 as never }), /title must be text/);
	await assert.rejects(app.commands.configure(id, owner(), { thinkingLevel: "banana" }), /thinkingLevel must be one of/);
	await assert.rejects(app.commands.configure(id, owner(), { model: { provider: 5 } as never }), /model must name/);
	await assert.rejects(app.commands.configure(id, owner(), { cwd: 5 as never }), /cwd must be text/);
	await assert.rejects(app.commands.createSession(owner(), { cwd: 5 as never }), /cwd must be text/);
	assert.equal(app.sessions().find((each) => each.id === Number(id))?.archived, undefined);
	await app.commands.configure(id, owner(), { thinkingLevel: "off" });
});

test("a lock left by a process that is gone, or is not Node, is taken over; a running server's is not", async () => {
	const { spawn } = await import("node:child_process");
	const { once } = await import("node:events");
	const dataDir = join(root, "locks");
	mkdirSync(dataDir, { recursive: true });
	const lock = join(dataDir, "harness.lock");
	const openHere = () => openApp(faux, dataDir);
	// Something running that is not Node; only Linux (and Android) can tell, through /proc.
	const other = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { argv0: "not-node" });
	const node = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"]);
	try {
		writeFileSync(lock, "999999999\n");
		await (await openHere()).close();
		if (process.platform === "linux" || process.platform === "android") {
			writeFileSync(lock, `${other.pid}\n`);
			await (await openHere()).close();
		}
		writeFileSync(lock, `${node.pid}\n`);
		await assert.rejects(openHere(), new RegExp(`already running on this data directory \\(pid ${node.pid}\\)`));
	} finally {
		other.kill();
		node.kill();
		await Promise.all([once(other, "exit"), once(node, "exit")]);
	}
});

test("view updates repeat the slow-changing fields only when they change", async () => {
	const id = await newSession();
	await say(id, "hello there");
	const tab = fakeTab(id, owner());
	const fields = ["artifacts", "subagents", "authors", "reactions", "pins", "turns", "decisions"];
	const views = () => tab.events.filter((each) => each.event === "view").map((each) => each.data);
	try {
		await app.attach(tab.client);
		const first = views()[0]!;
		assert.equal(first.full, true);
		for (const name of fields) assert.ok(name in first, `a full view has ${name}`);
		const answer = (first.entries as { id: number; kind: string }[]).findLast((entry) => entry.kind === "assistant")!;

		await app.collab.react(id, owner(), answer.id, "👍");
		await until(() => views().length > 1, "an update after the reaction");
		const update = views().at(-1)!;
		assert.deepEqual(update.reactions, { [String(answer.id)]: { "👍": [owner().id] } });
		for (const name of fields.filter((each) => each !== "reactions")) assert.ok(!(name in update), `an update leaves out unchanged ${name}`);

		app.detach(tab.client);
		await app.attach(tab.client);
		const again = views().at(-1)!;
		assert.equal(again.full, true);
		for (const name of fields) assert.ok(name in again, `a fresh attach sends ${name} again`);
	} finally {
		app.detach(tab.client);
	}
});

test("reactions, pins, notes, mentions, quotes, model changes, and guard decisions", async () => {
	const { BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");
	const docs = await import("../src/server/docs.ts");
	const id = await newSession();
	const other = await newSession();
	const alex = app.config.addUser("Alex", "guest").user;
	const elsewhere = fakeTab(other, alex);
	try {
		await app.attach(elsewhere.client);
		await say(id, "something to react to");
		const entries = (await app.harness.conversation(id, BACKGROUND_CONTEXT))!;
		const page = await entries.entries({}, 20, undefined, BACKGROUND_CONTEXT);
		const answer = page.items.find((entry) => entry.kind === "pi.assistant")!.id as unknown as number;

		await app.collab.react(id, alex, answer, "👍");
		await app.collab.react(id, owner(), answer, "👍");
		await app.collab.react(id, owner(), answer, "👍");
		assert.deepEqual((await app.harness.snapshot(docs.ReactionsDoc, id, BACKGROUND_CONTEXT))?.entries, { [String(answer)]: { "👍": [alex.id] } });
		await assert.rejects(app.collab.react(id, alex, answer, "💩"), /Pick one/);

		assert.deepEqual(await app.collab.pin(id, alex, { entryId: answer }), { pinned: true });
		const pins = (await app.harness.snapshot(docs.PinsDoc, id, BACKGROUND_CONTEXT))!.items;
		assert.equal(pins[0]?.author, "Pi");
		assert.match(pins[0]!.text, /^echo: .*something to react to$/);
		const pinnedText = pins[0]!.text;
		assert.deepEqual(await app.collab.pin(id, alex, { entryId: answer }), { pinned: false });

		const saved = await app.collab.saveNotes(id, alex, "plan: ship it", 0);
		assert.equal(saved.rev, 1);
		await assert.rejects(app.collab.saveNotes(id, owner(), "stale edit", 0), /Alex changed the notes/);

		const posted = await app.collab.postChat(id, owner(), { text: "@alex look at this, cc @Alexander", requestId: "m1", quote: { entryId: answer } });
		assert.deepEqual(posted.mentions, [alex.id]);
		assert.equal(posted.quote!.text, pinnedText);
		await until(() => elsewhere.events.some((each) => each.event === "notice" && String(each.data.message).includes("mentioned you")), "Alex to hear about the mention elsewhere");
		assert.deepEqual(elsewhere.last("notice")?.link, { conversationId: id, sheet: "chat" });

		await app.commands.configure(id, alex, { model: { provider: "faux", modelId: "faux-vision" }, thinkingLevel: "off" });
		const asked = app.approvals.request(
			{ id: "approval-1", conversationId: id, taskId: 1 as never, callId: "call-1", tool: "bash", subject: "rm -rf build", reason: "deletes files", createdAt: Date.now() },
			BACKGROUND_CONTEXT,
		);
		assert.equal(await app.answerApproval("approval-1", true, alex), true);
		assert.deepEqual(await asked, { allow: true, by: "Alex" });
		const decision = (await app.harness.snapshot(docs.DecisionsDoc, id, BACKGROUND_CONTEXT))?.calls["call-1"];
		assert.equal(decision?.by, "Alex");
		assert.equal(decision?.allow, true);

		const lines = (await app.harness.snapshot(docs.ChatDoc, id, BACKGROUND_CONTEXT))!.messages.filter((each) => each.kind === "event").map((each) => each.text);
		assert.deepEqual(lines, [`pinned “${pinnedText}”`, "updated the notes", "switched the model to faux-vision", "allowed the bash call: rm -rf build"]);
	} finally {
		app.detach(elsewhere.client);
		app.config.removeUser(alex.id);
	}
});

test("the session list shows who is where, the newest chat, and people come and go with a last-seen time", async () => {
	const id = await newSession();
	const alex = app.config.addUser("Alex", "guest").user;
	const watcher = fakeTab(undefined, owner());
	const tab = fakeTab(id, alex);
	try {
		await app.attach(watcher.client);
		await app.attach(tab.client);
		const online = (watcher.last("users") as unknown as { id: string; online: boolean }[]).find((each) => each.id === alex.id);
		assert.equal(online?.online, true);
		await app.collab.postChat(id, alex, { text: "hello list", requestId: "l1" });
		await until(() => {
			const sessions = watcher.last("sessions") as unknown as { id: number; people?: { name: string }[]; chatBy?: string }[] | undefined;
			const row = sessions?.find((each) => each.id === Number(id));
			return row?.chatBy === alex.id && row.people?.some((each) => each.name === "Alex") === true;
		}, "the session row to show Alex and the chat");
		app.detach(tab.client);
		const gone = (watcher.last("users") as unknown as { id: string; online: boolean; lastSeen?: number }[]).find((each) => each.id === alex.id);
		assert.equal(gone?.online, false);
		assert.ok((gone?.lastSeen ?? 0) > Date.now() - 5000);
	} finally {
		app.detach(watcher.client);
		app.detach(tab.client);
		app.config.removeUser(alex.id);
	}
});

test("invites carry a role and a session over HTTP, and viewers get 403 on steering routes", async () => {
	const { createServer } = await import("node:http");
	const { createHandler } = await import("../src/server/http.ts");
	const server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
	const call = (token: string, path: string, body?: unknown) =>
		fetch(`${base}/api/${path}`, {
			method: body === undefined ? "GET" : "POST",
			headers: { authorization: `Bearer ${token}`, "x-pocket": "1", "content-type": "application/json" },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
	const id = await newSession();
	const joined: string[] = [];
	try {
		const invite = (await (await call(app.config.ownerToken, "invite", { role: "viewer", session: Number(id) })).json()) as { code: string; grant: unknown };
		assert.deepEqual(invite.grant, { role: "viewer", session: String(id) });
		const page = await (await fetch(`${base}/join/${invite.code}`)).text();
		assert.match(page, /but not steer Pi/);
		const redeemed = await fetch(`${base}/join/${invite.code}`, { method: "POST", body: "name=Watcher", headers: { "content-type": "application/x-www-form-urlencoded" }, redirect: "manual" });
		const token = decodeURIComponent(/pocket_auth=([^;]+)/.exec(redeemed.headers.get("set-cookie") ?? "")![1]!);
		const watcher = app.config.users.find((each) => each.name === "Watcher")!;
		joined.push(watcher.id);
		assert.equal(watcher.role, "viewer");
		assert.deepEqual(watcher.sessions, [String(id)]);
		assert.equal((await call(token, `c/${id}/submit`, { text: "hi", requestId: "x" })).status, 403);
		assert.equal((await call(token, `c/${id}/abort`, {})).status, 403);
		assert.equal((await call(token, "invite", {})).status, 403);
		assert.equal((await call(token, "fs?path=/")).status, 403);
		assert.equal((await call(token, `c/${id}/chat`, { text: "hello", requestId: "y" })).status, 200);
		assert.equal((await call(token, `c/${Number(id) + 999}/chat`, { text: "hello", requestId: "z" })).status, 404);
		const sessions = (await (await call(token, "sessions")).json()) as { id: number }[];
		assert.deepEqual(sessions.map((each) => each.id), [Number(id)]);
		const push = (await (await call(token, "push")).json()) as { publicKey: string; prefs: Record<string, boolean>; devices: number };
		assert.equal(push.devices, 0);
		assert.equal(push.prefs.mention, true);
		assert.ok(push.publicKey.length > 80);
		assert.equal((await call(token, "push/subscribe", { subscription: { endpoint: "http://insecure.example/x", keys: { p256dh: "a", auth: "b" } } })).status, 400);
	} finally {
		for (const userId of joined) app.config.removeUser(userId);
		server.closeAllConnections();
		server.close();
	}
});

test("people who signed in through a Cloudflare quick tunnel are removed once that tunnel is gone", async () => {
	const { createServer } = await import("node:http");
	const { createHandler } = await import("../src/server/http.ts");
	const server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
	const owner = { authorization: `Bearer ${app.config.ownerToken}`, "x-pocket": "1", "content-type": "application/json" };
	const join = async (name: string, host?: string): Promise<string> => {
		const { code } = (await (await fetch(`${base}/api/invite`, { method: "POST", headers: owner, body: "{}" })).json()) as { code: string };
		const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", ...(host === undefined ? {} : { "x-forwarded-host": host }) };
		const joined = await fetch(`${base}/join/${code}`, { method: "POST", body: `name=${name}`, headers, redirect: "manual" });
		return decodeURIComponent(/pocket_auth=([^;]+)/.exec(joined.headers.get("set-cookie") ?? "")![1]!);
	};
	const named = (name: string) => app.config.users.find((each) => each.name === name);
	const before = app.access;
	try {
		await join("Tunnelled", "old-tunnel.trycloudflare.com");
		await join("Wifi");
		const legacy = await join("Legacy");
		assert.equal(named("Tunnelled")?.tunnel, "old-tunnel.trycloudflare.com");
		assert.equal(named("Wifi")?.tunnel, undefined);
		// Someone who joined before tunnels were recorded is tagged when their cookie comes back through one.
		await fetch(`${base}/api/me`, { headers: { cookie: `pocket_auth=${encodeURIComponent(legacy)}`, "x-forwarded-host": "old-tunnel.trycloudflare.com" } });
		assert.equal(named("Legacy")?.tunnel, "old-tunnel.trycloudflare.com");

		// A server restart keeps the tunnel: nobody is removed.
		app.setReach({ mode: "cloudflare", label: "Cloudflare Tunnel", url: "https://old-tunnel.trycloudflare.com" });
		assert.ok(named("Tunnelled") && named("Legacy") && named("Wifi"));
		// A new tunnel: its address is new, so the old one's people go. Others and the owner stay.
		app.setReach({ mode: "cloudflare", label: "Cloudflare Tunnel", url: "https://new-tunnel.trycloudflare.com" });
		assert.equal(named("Tunnelled"), undefined);
		assert.equal(named("Legacy"), undefined);
		assert.ok(named("Wifi"));
		assert.ok(app.config.users.some((each) => each.role === "owner"));
	} finally {
		app.access = before;
		for (const name of ["Tunnelled", "Wifi", "Legacy"]) {
			const user = named(name);
			if (user !== undefined) app.config.removeUser(user.id);
		}
		server.closeAllConnections();
		server.close();
	}
});

test("the web edge: page policy, local redirects, asked account switches, no cross-site sign-ins, clean uploads, scoped people", async () => {
	const { createServer, request: rawRequest } = await import("node:http");
	const { createHandler } = await import("../src/server/http.ts");
	const { createHash } = await import("node:crypto");
	const { existsSync, readdirSync, readFileSync } = await import("node:fs");
	const server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as { port: number }).port;
	const base = `http://127.0.0.1:${port}`;
	const ownerToken = app.config.ownerToken;
	const id = await newSession();
	const other = await newSession();
	const guest = app.config.addUser("Gus", "guest");
	const scoped = app.config.addUser("Sam", "viewer", [String(id)]);
	const elsewhere = app.config.addUser("Eve", "guest", [String(other)]);
	const cookie = (response: Response) => response.headers.get("set-cookie") ?? "";
	try {
		// The app page allows its own import map by hash and nothing from other sites.
		const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
		const map = /<script type="importmap">([\s\S]*?)<\/script>/.exec(html)![1]!;
		for (const path of ["/", `/s/${id}`, "/index.html"]) {
			const policy = (await fetch(base + path)).headers.get("content-security-policy") ?? "";
			assert.ok(policy.includes(`'sha256-${createHash("sha256").update(map).digest("base64")}'`), `${path} allows the import map`);
			assert.match(policy, /img-src 'self' data: blob:;/);
			assert.match(policy, /connect-src 'self';/);
			assert.match(policy, /frame-ancestors 'self'/);
		}

		// After signing in, only paths on this server.
		const login = (query: string, headers: Record<string, string> = {}) => fetch(`${base}/login?${query}`, { redirect: "manual", headers });
		for (const next of ["//evil.example/x", "/\\evil.example/x", "https://evil.example/"]) {
			assert.equal((await login(`token=${ownerToken}&next=${encodeURIComponent(next)}`)).headers.get("location"), "/", next);
		}
		assert.equal((await login(`token=${ownerToken}&next=${encodeURIComponent(`/s/${id}`)}`)).headers.get("location"), `/s/${id}`);

		// A link for someone else asks before switching; only a same-site post switches.
		const asked = await login(`token=${guest.token}`, { cookie: `pocket_auth=${ownerToken}` });
		assert.equal(asked.status, 200);
		assert.equal(cookie(asked), "");
		assert.match(await asked.text(), /Switch account\?[\s\S]*signed in as [^<]+\. The link you opened signs it in as Gus/);
		const post = (path: string, body: string, site: string) =>
			fetch(base + path, { method: "POST", redirect: "manual", body, headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": site } });
		const forged = await post("/login", `token=${guest.token}`, "cross-site");
		assert.equal(forged.status, 403);
		assert.equal(cookie(forged), "");
		const switched = await post("/login", `token=${guest.token}`, "same-origin");
		assert.equal(switched.status, 303);
		assert.match(cookie(switched), new RegExp(`pocket_auth=${encodeURIComponent(guest.token)}`));
		assert.equal(cookie(await login(`token=${ownerToken}`, { cookie: `pocket_auth=${ownerToken}` })).includes("pocket_auth="), true, "the same person signs in without asking");

		// Another site cannot spend an invite on this browser.
		const invite = (await (await fetch(`${base}/api/invite`, { method: "POST", body: "{}", headers: { authorization: `Bearer ${ownerToken}`, "x-pocket": "1" } })).json()) as { code: string };
		assert.equal((await post(`/join/${invite.code}`, "name=Mallory", "cross-site")).status, 403);
		assert.equal((await fetch(`${base}/join/${invite.code}`)).status, 200, "the invite still works");

		// Uploads: none for a conversation that does not exist, and nothing left of one cut off midway.
		const uploads = join(root, "data", "uploads");
		const missing = await fetch(`${base}/api/c/987654/upload?name=x.txt`, { method: "POST", body: "x", headers: { authorization: `Bearer ${ownerToken}`, "x-pocket": "1" } });
		assert.equal(missing.status, 404);
		assert.equal(existsSync(join(uploads, "987654")), false);
		const big = await fetch(`${base}/api/c/${id}/upload?name=big.bin`, { method: "POST", body: "x", headers: { authorization: `Bearer ${ownerToken}`, "x-pocket": "1", "content-length": "1" } });
		assert.equal(big.status, 200);
		const before = readdirSync(join(uploads, String(id))).length;
		await new Promise<void>((resolve) => {
			const cut = rawRequest({ port, method: "POST", path: `/api/c/${id}/upload?name=cut.bin`, headers: { authorization: `Bearer ${ownerToken}`, "x-pocket": "1", "content-length": "1000000" } });
			cut.on("error", () => resolve());
			cut.write(Buffer.alloc(1000));
			setTimeout(() => cut.destroy(), 200);
		});
		await until(() => readdirSync(join(uploads, String(id))).length === before, "the cut-off upload to be removed");
		const declared = await new Promise<number>((resolve) => {
			const huge = rawRequest({ port, method: "POST", path: `/api/c/${id}/upload?name=huge.bin`, headers: { authorization: `Bearer ${ownerToken}`, "x-pocket": "1", "content-length": String(60 * 1024 * 1024) } });
			huge.on("response", (response) => resolve(response.statusCode ?? 0));
			huge.on("error", () => resolve(-1));
			huge.write("x");
		});
		assert.equal(declared, 413, "an upload declared too big is refused before it is read");
		// Two pasted images, both image.png, at the same moment: two files.
		const paste = () =>
			fetch(`${base}/api/c/${id}/upload?name=image.png`, { method: "POST", body: crypto.randomUUID(), headers: { authorization: `Bearer ${ownerToken}`, "x-pocket": "1" } }).then(
				(response) => response.json() as Promise<{ path: string }>,
			);
		const [first, second] = await Promise.all([paste(), paste()]);
		assert.notEqual(first.path, second.path);
		assert.notEqual(readFileSync(first.path, "utf8"), readFileSync(second.path, "utf8"));

		// People invited to one session see only the people who share it, without anyone's session limits.
		const seen = (await (await fetch(`${base}/api/users`, { headers: { authorization: `Bearer ${scoped.token}` } })).json()) as { name: string; sessions?: number[] }[];
		assert.ok(seen.some((each) => each.name === "Gus") && seen.some((each) => each.name === "Sam"));
		assert.ok(!seen.some((each) => each.name === "Eve"), "someone limited to another session stays hidden");
		assert.ok(seen.every((each) => each.sessions === undefined));
		const all = (await (await fetch(`${base}/api/users`, { headers: { authorization: `Bearer ${ownerToken}` } })).json()) as { name: string; sessions?: number[] }[];
		assert.deepEqual(all.find((each) => each.name === "Eve")?.sessions, [Number(other)]);
	} finally {
		for (const each of [guest, scoped, elsewhere]) app.config.removeUser(each.user.id);
		server.closeAllConnections();
		server.close();
	}
});

test("access holds: a refused tab hears nothing, narrowed access evicts, removal closes tabs, files stay in the session", async () => {
	const id = await newSession();
	const other = await newSession();
	const sam = app.config.addUser("Sam", "guest", [String(id)]).user;
	const vee = app.config.addUser("Vee", "viewer").user;
	const sneaky = fakeTab(other, sam);
	const samTab = fakeTab(id, sam);
	const veeTab = fakeTab(id, vee);
	let closed = 0;
	(veeTab.client as { close?: () => void }).close = () => closed++;
	try {
		// A tab pointed at a session Sam may not see gets "missing", then nothing about that session.
		await app.attach(sneaky.client);
		assert.equal(sneaky.client.conversationId, undefined);
		await app.commands.updateSession(other, owner(), { title: "Secret plans" });
		app.notice("warning", "server-wide detail");
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.ok(!sneaky.events.some((each) => each.event === "notice"), "no notices from the other session or the server");
		assert.ok(!(app.sessions(owner()).find((each) => each.id === Number(other))?.people ?? []).some((each) => each.id === sam.id));

		// Narrowing Sam's access takes his tab out of the session at once.
		await app.attach(samTab.client);
		app.setAccess(owner(), sam.id, { sessions: [String(other)] });
		assert.match(String(samTab.last("missing")?.message), /no longer shared/);
		await app.collab.postChat(id, owner(), { text: "after the change", requestId: "acc-1" });
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.ok(!samTab.events.some((each) => each.event === "chat" && JSON.stringify(each.data).includes("after the change")));

		// Viewers load images only from the session's folder.
		const { writeFileSync } = await import("node:fs");
		const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAAABJRU5ErkJggg==", "base64");
		writeFileSync(join(work, "inside.png"), png);
		writeFileSync(join(root, "outside.png"), png);
		assert.equal(app.conversationFile(vee, id, "inside.png"), join(work, "inside.png"));
		assert.throws(() => app.conversationFile(vee, id, join(root, "outside.png")), /not found/);
		assert.throws(() => app.conversationFile(vee, id, "../outside.png"), /not found/);
		assert.equal(app.conversationFile(owner(), id, join(root, "outside.png")), join(root, "outside.png"));

		// Removing Vee closes her tab.
		await app.attach(veeTab.client);
		app.removeUser(owner(), vee.id);
		assert.equal(closed, 1);
		assert.ok(veeTab.events.some((each) => each.event === "closing"));
	} finally {
		for (const tab of [sneaky, samTab, veeTab]) app.detach(tab.client);
		app.config.removeUser(sam.id);
		app.config.removeUser(vee.id);
	}
});

test("an invite stops working when its creator loses the right to invite", async () => {
	const { Auth } = await import("../src/server/auth.ts");
	const auth = new Auth(app.config);
	const guest = app.config.addUser("Gil", "guest").user;
	try {
		const { code } = auth.createInvite(guest, { role: "guest" });
		app.setAccess(owner(), guest.id, { role: "viewer" });
		assert.equal(auth.redeem(code, "Mallory"), undefined);
		assert.ok(!app.config.users.some((each) => each.name === "Mallory"));
		const fine = auth.createInvite(owner(), { role: "viewer" });
		const joined = auth.redeem(fine.code, "Okay");
		assert.equal(joined?.user.role, "viewer");
		app.config.removeUser(joined!.user.id);
	} finally {
		app.config.removeUser(guest.id);
	}
});

test("sessions and artifacts survive closing and reopening the storage", async () => {
	const id = await newSession();
	await say(id, "make an artifact for the restart test");
	await app.close();
	app = await open();
	assert.ok(app.sessions().some((each) => each.id === Number(id)));
	assert.equal((await app.artifactBody(id, "demo-page", undefined)).content, "<h1>one</h1>");
});
