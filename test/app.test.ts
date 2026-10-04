// End-to-end tests of the server core with a scripted model: no network, no API keys, no Pi config.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";

const root = mkdtempSync(join(tmpdir(), "pi-pocket-test-"));
// Isolate from the real Pi install: its auth, settings, skills, and Lancet Guard.
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
process.env.PI_POCKET_GUARD = "off";
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
const work = join(root, "work");
mkdirSync(work);

const { PocketApp } = await import("../src/server/app.ts");
type App = Awaited<ReturnType<typeof PocketApp.open>>;

function lastText(context: { messages: readonly { role: string; content: unknown }[] }): { role: string; text: string } {
	const last = context.messages.findLast((message) => message.role !== "system")!;
	const content = typeof last.content === "string" ? [{ type: "text", text: last.content }] : (last.content as { type: string; text?: string }[]);
	return { role: last.role, text: content.flatMap((part) => (part.type === "text" ? [part.text ?? ""] : [])).join("") };
}

/** One scripted model for every conversation, answering by the last message, like a tiny real model. */
const route: FauxResponseStep = (context) => {
	const { role, text } = lastText(context as never);
	const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
	if (role === "toolResult") return fauxAssistantMessage([fauxText(`tool said: ${text}`)]);
	if (text.includes("make an artifact")) return call("artifact", { id: "Demo Page", title: "Demo", content: "<h1>one</h1>" });
	if (text.includes("fix the artifact")) {
		return call("artifact", { id: "demo-page", title: "Demo", edits: [{ oldText: "one", newText: "two" }] });
	}
	if (text.includes("start a helper")) return call("subagent", { action: "spawn", name: "helper", message: "say hi please" });
	if (text.includes("say hi please")) return fauxAssistantMessage([fauxText("hi from helper")]);
	if (text.startsWith("[subagent helper answered")) return fauxAssistantMessage([fauxText("noted")]);
	return fauxAssistantMessage([fauxText(`echo: ${text}`)]);
};

const faux = fauxProvider({ tokensPerSecond: 2000, models: [{ id: "faux-1" }, { id: "faux-vision", input: ["text", "image"] }] });
faux.setResponses(Array.from({ length: 200 }, () => route));

let app: App;
const open = () =>
	PocketApp.open({
		dataDir: join(root, "data"),
		defaultCwd: work,
		supervised: false,
		log: () => {},
		configureModels: (models) => models.registerNativeProvider(faux.provider),
	});

async function until(check: () => Promise<boolean> | boolean, what: string, timeoutMs = 10_000): Promise<void> {
	const started = Date.now();
	while (!(await check())) {
		if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

const owner = () => app.config.users.find((user) => user.role === "owner")!;

async function newSession(): Promise<ConversationId> {
	const { id } = await app.createSession(owner(), { cwd: work });
	await app.configure(id, owner(), { model: { provider: "faux", modelId: "faux-1" }, thinkingLevel: "off" });
	return id;
}

type Attachment = { path: string; name: string; mime: string; size: number };

async function say(id: ConversationId, text: string, attachments?: Attachment[]): Promise<void> {
	const { submissionId } = await app.submit(id, owner(), { text, requestId: crypto.randomUUID(), ...(attachments === undefined ? {} : { attachments }) });
	const submission = await app.harness.submission(submissionId, (await import("@earendil-works/chord/context")).BACKGROUND_CONTEXT);
	await submission!.wait((await import("@earendil-works/chord/context")).BACKGROUND_CONTEXT);
}

before(async () => {
	app = await open();
});

after(async () => {
	await app?.close();
	rmSync(root, { recursive: true, force: true });
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
	await app.configure(id, owner(), { model: { provider: "faux", modelId: "faux-vision" } });
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
		["prompt.ts", "artifacts.ts", "subagents.ts", "guard.ts"],
	);
	assert.equal(module("prompt.ts").required, true);
	assert.match(module("guard.ts").summary, /^Lancet Guard for Pi Pocket's tools\.$/);
	assert.deepEqual(module("subagents.ts").extensions[0]?.tools, ["subagent"]);

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
		assert.equal(((await listed.json()) as { modules: unknown[] }).modules.length, 4);
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

		app.setTyping(id, guest.user, "chat");
		await until(() => people().find((each) => each.name === "Alex")?.typing === "chat", "Alex to show as typing");

		const posted = await app.postChat(id, guest.user, { text: "  hi team  ", requestId: "r1" });
		assert.equal(posted.text, "hi team");
		assert.equal((await app.postChat(id, guest.user, { text: "hi team", requestId: "r1" })).id, posted.id, "a retry does not post twice");
		await until(
			() => mine.some((each) => each.event === "chat" && (each.data.messages as { id: string }[]).some((message) => message.id === posted.id)),
			"the message to reach the other tab",
		);
		await until(() => people().find((each) => each.name === "Alex")?.typing === undefined, "sending to stop the typing indicator");
		await assert.rejects(app.postChat(id, guest.user, { text: "   ", requestId: "r2" }), /empty/);

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
function fakeTab(id: ConversationId | undefined, user: { id: string; name: string; role: "owner" | "guest" | "viewer"; sessions?: string[] } & Record<string, unknown>) {
	const events: { event: string; data: Record<string, unknown> }[] = [];
	const client = {
		id: `tab-${crypto.randomUUID()}`,
		user: user as never,
		conversationId: id,
		sentEntries: new Set<number>(),
		orderKey: "",
		send: (event: string, data: unknown) => events.push({ event, data: data as Record<string, unknown> }),
	};
	const last = (event: string) => events.findLast((each) => each.event === event)?.data;
	return { client, events, last };
}

test("viewers read and chat but never steer; people invited to one session see only that session", async () => {
	const id = await newSession();
	const other = await newSession();
	const viewer = app.config.addUser("Vee", "viewer").user;
	const scoped = app.config.addUser("Sam", "guest", [String(id)]).user;
	try {
		await assert.rejects(app.submit(id, viewer, { text: "hi", requestId: "v1" }), /not steer/);
		await assert.rejects(app.abort(id, viewer), /not steer/);
		await assert.rejects(app.createSession(viewer, { cwd: work }), /not steer/);
		await assert.rejects(app.answerApproval("nope", true, viewer), /not steer/);
		assert.equal((await app.postChat(id, viewer, { text: "just watching", requestId: "v2" })).text, "just watching");

		assert.deepEqual(app.sessions(scoped).map((each) => each.id), [Number(id)]);
		assert.ok(app.sessions(owner()).length >= 2);
		await assert.rejects(app.submit(other, scoped, { text: "hi", requestId: "s1" }), /not shared/);
		await assert.rejects(app.createSession(scoped, { cwd: work }), /one session/);
		const tab = fakeTab(other, scoped as never);
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
	const ownerTab = fakeTab(id, owner() as never);
	const alexTab = fakeTab(id, alex as never);
	try {
		await app.attach(ownerTab.client);
		await app.attach(alexTab.client);
		await app.turns(id, owner(), { action: "on" });
		await assert.rejects(app.submit(id, alex, { text: "my turn?", requestId: "t1" }), /is driving/);
		await assert.rejects(app.configure(id, alex, { thinkingLevel: "off" }), /is driving/);
		await assert.rejects(app.turns(id, alex, { action: "claim" }), /is driving/);
		await app.turns(id, alex, { action: "ask" });
		await until(() => (alexTab.last("view")?.turns as { asks?: string[] } | undefined)?.asks?.includes(alex.id) === true, "the ask to show");
		await app.turns(id, owner(), { action: "handover", to: alex.id });
		await until(() => (ownerTab.last("view")?.turns as { driver?: string } | undefined)?.driver === alex.id, "Alex to drive");
		await assert.rejects(app.submit(id, owner(), { text: "me again", requestId: "t2" }), /Alex is driving/);
		await app.submit(id, alex, { text: "hello from the driver", requestId: "t3" });
		await app.turns(id, alex, { action: "off" });
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

test("reactions, pins, notes, mentions, quotes, model changes, and guard decisions", async () => {
	const { BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");
	const docs = await import("../src/server/docs.ts");
	const id = await newSession();
	const other = await newSession();
	const alex = app.config.addUser("Alex", "guest").user;
	const elsewhere = fakeTab(other, alex as never);
	try {
		await app.attach(elsewhere.client);
		await say(id, "something to react to");
		const entries = (await app.harness.conversation(id, BACKGROUND_CONTEXT))!;
		const page = await entries.entries({}, 20, undefined, BACKGROUND_CONTEXT);
		const answer = page.items.find((entry) => entry.kind === "pi.assistant")!.id as unknown as number;

		await app.react(id, alex, answer, "👍");
		await app.react(id, owner(), answer, "👍");
		await app.react(id, owner(), answer, "👍");
		assert.deepEqual((await app.harness.snapshot(docs.ReactionsDoc, id, BACKGROUND_CONTEXT))?.entries, { [String(answer)]: { "👍": [alex.id] } });
		await assert.rejects(app.react(id, alex, answer, "💩"), /Pick one/);

		assert.deepEqual(await app.pin(id, alex, { entryId: answer }), { pinned: true });
		const pins = (await app.harness.snapshot(docs.PinsDoc, id, BACKGROUND_CONTEXT))!.items;
		assert.equal(pins[0]?.author, "Pi");
		assert.match(pins[0]!.text, /^echo: .*something to react to$/);
		const pinnedText = pins[0]!.text;
		assert.deepEqual(await app.pin(id, alex, { entryId: answer }), { pinned: false });

		const saved = await app.saveNotes(id, alex, "plan: ship it", 0);
		assert.equal(saved.rev, 1);
		await assert.rejects(app.saveNotes(id, owner(), "stale edit", 0), /Alex changed the notes/);

		const posted = await app.postChat(id, owner(), { text: "@alex look at this, cc @Alexander", requestId: "m1", quote: { entryId: answer } });
		assert.deepEqual(posted.mentions, [alex.id]);
		assert.equal(posted.quote!.text, pinnedText);
		await until(() => elsewhere.events.some((each) => each.event === "notice" && String(each.data.message).includes("mentioned you")), "Alex to hear about the mention elsewhere");
		assert.deepEqual(elsewhere.last("notice")?.link, { conversationId: id, sheet: "chat" });

		await app.configure(id, alex, { model: { provider: "faux", modelId: "faux-vision" }, thinkingLevel: "off" });
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
	const watcher = fakeTab(undefined, owner() as never);
	const tab = fakeTab(id, alex as never);
	try {
		await app.attach(watcher.client);
		await app.attach(tab.client);
		const online = (watcher.last("users") as unknown as { id: string; online: boolean }[]).find((each) => each.id === alex.id);
		assert.equal(online?.online, true);
		await app.postChat(id, alex, { text: "hello list", requestId: "l1" });
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

test("access holds: a refused tab hears nothing, narrowed access evicts, removal closes tabs, files stay in the session", async () => {
	const id = await newSession();
	const other = await newSession();
	const sam = app.config.addUser("Sam", "guest", [String(id)]).user;
	const vee = app.config.addUser("Vee", "viewer").user;
	const sneaky = fakeTab(other, sam as never);
	const samTab = fakeTab(id, sam as never);
	const veeTab = fakeTab(id, vee as never);
	let closed = 0;
	(veeTab.client as { close?: () => void }).close = () => closed++;
	try {
		// A tab pointed at a session Sam may not see gets "missing", then nothing about that session.
		await app.attach(sneaky.client);
		assert.equal(sneaky.client.conversationId, undefined);
		await app.updateSession(other, owner(), { title: "Secret plans" });
		app.notice("warning", "server-wide detail");
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.ok(!sneaky.events.some((each) => each.event === "notice"), "no notices from the other session or the server");
		assert.ok(!(app.sessions(owner()).find((each) => each.id === Number(other))?.people ?? []).some((each) => each.id === sam.id));

		// Narrowing Sam's access takes his tab out of the session at once.
		await app.attach(samTab.client);
		app.setAccess(owner(), sam.id, { sessions: [String(other)] });
		assert.match(String(samTab.last("missing")?.message), /no longer shared/);
		await app.postChat(id, owner(), { text: "after the change", requestId: "acc-1" });
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
