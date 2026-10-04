// Worktrees: a session or a fork works in a git checkout of its own, made from the folder as it is, and removable.
import { type App, cleanUp, context, lastText, modelTexts, newSession, openApp, owner, root, say, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { ChatDoc, SubagentsDoc } from "../src/server/docs.ts";

/** Asked to, the model writes a file in its folder. */
const route: FauxResponseStep = (request) => {
	const { role, text } = lastText(request as never);
	if (role === "toolResult") return fauxAssistantMessage([fauxText("written")]);
	if (text.endsWith("write the plan")) return fauxAssistantMessage([fauxToolCall("write", { path: "plan.md", content: "approach B\n" })], { stopReason: "toolUse" });
	if (text.endsWith("work slowly")) return fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 5" })], { stopReason: "toolUse" });
	if (text.endsWith("start a helper")) return fauxAssistantMessage([fauxToolCall("subagent", { action: "spawn", name: "helper", message: "look around" })], { stopReason: "toolUse" });
	return fauxAssistantMessage([fauxText(`echo: ${text}`)]);
};

let app: App;
const repo = join(root, "repo");
const gitIn = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

before(async () => {
	mkdirSync(join(repo, "app"), { recursive: true });
	gitIn(repo, "init", "-q");
	gitIn(repo, "config", "user.email", "t@example.com");
	gitIn(repo, "config", "user.name", "T");
	writeFileSync(join(repo, "app", "main.ts"), "export const answer = 1;\n");
	writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
	gitIn(repo, "add", "-A");
	gitIn(repo, "commit", "-qm", "init");
	// Uncommitted work, a new file, and an ignored one: the first two come along into a worktree.
	writeFileSync(join(repo, "app", "main.ts"), "export const answer = 2;\n");
	writeFileSync(join(repo, "app", "notes.md"), "new notes\n");
	mkdirSync(join(repo, "node_modules"));
	writeFileSync(join(repo, "node_modules", "big.js"), "ignored\n");
	app = await openApp(scriptedModel(route));
});

after(async () => {
	await app?.close();
	cleanUp();
});

test("a session in its own worktree starts with the folder as it is, on a branch of its own, and works apart", async () => {
	const { id } = await app.commands.createSession(owner(app), { cwd: join(repo, "app"), title: "Try B", worktree: true });
	await app.commands.configure(id, owner(app), { model: { provider: "faux", modelId: "faux-1" } });
	const worktree = app.sessionMeta(id)!.worktree!;
	assert.match(worktree.branch, /^pocket\/try-b-[0-9a-f]{6}$/);
	assert.equal(worktree.source, join(repo, "app"));
	assert.ok(worktree.path.startsWith(join(root, "data", "worktrees")));
	const cwd = app.cwdOf(id);
	assert.equal(cwd, join(worktree.path, "app"), "the same folder within the repository");
	assert.equal(readFileSync(join(cwd, "main.ts"), "utf8"), "export const answer = 2;\n", "uncommitted changes came along");
	assert.equal(readFileSync(join(cwd, "notes.md"), "utf8"), "new notes\n", "new files came along");
	assert.equal(existsSync(join(worktree.path, "node_modules")), false, "ignored files did not");
	assert.equal(gitIn(cwd, "rev-parse", "--abbrev-ref", "HEAD"), worktree.branch);

	await say(app, id, "write the plan");
	assert.equal(existsSync(join(cwd, "plan.md")), true);
	assert.equal(existsSync(join(repo, "app", "plan.md")), false, "the original folder is untouched");

	// With uncommitted changes, removing asks for force; the branch stays either way.
	await assert.rejects(app.commands.removeWorktree(id, owner(app), false), { status: 409 });
	await app.commands.removeWorktree(id, owner(app), true);
	assert.equal(existsSync(worktree.path), false);
	assert.equal(app.sessionMeta(id)?.worktree, undefined);
	assert.equal(app.cwdOf(id), join(repo, "app"), "the session works in the original folder again");
	assert.match(gitIn(repo, "branch", "--list", worktree.branch), new RegExp(worktree.branch));
	const chat = (await app.harness.snapshot(ChatDoc, id, context))!.messages.map((message) => message.text);
	assert.match(chat.at(-1)!, /^removed the worktree; the branch pocket\/try-b-\w+ stays, and Pi works in .*\/repo\/app again$/);
});

test("a fork can get a worktree of its own, and a folder outside any repository cannot", async () => {
	const id = await newSession(app, join(repo, "app"));
	await say(app, id, "hello");
	const page = await (await app.harness.conversation(id, context))!.entries({}, 10, undefined, context);
	const answer = page.items.find((entry) => entry.kind === "pi.assistant")!;
	const { id: fork } = await app.commands.fork(id, owner(app), { entryId: Number(answer.id), worktree: true });
	const worktree = app.sessionMeta(fork)!.worktree!;
	assert.equal(app.cwdOf(fork), join(worktree.path, "app"));
	assert.equal((await app.agentState(fork))?.cwd, join(worktree.path, "app"));
	const chat = (await app.harness.snapshot(ChatDoc, fork, context))!.messages.map((message) => message.text);
	assert.match(chat[0]!, /^forked this from “.*” into a worktree on pocket\/[\w-]+$/);
	await app.commands.removeWorktree(fork, owner(app), true);

	const plain = join(root, "plain");
	mkdirSync(plain, { recursive: true });
	const before = app.sessions().length;
	await assert.rejects(app.commands.createSession(owner(app), { cwd: plain, worktree: true }), { status: 400, message: /not in a git repository/ });
	assert.equal(app.sessions().length, before, "no session was made");
});

test("a folder reached through a symbolic link gets the matching folder in its worktree", async () => {
	const link = join(root, "linked");
	symlinkSync(repo, link);
	const { id } = await app.commands.createSession(owner(app), { cwd: join(link, "app"), worktree: true });
	const worktree = app.sessionMeta(id)!.worktree!;
	assert.equal(app.cwdOf(id), join(worktree.path, "app"));
	assert.equal(existsSync(join(app.cwdOf(id), "main.ts")), true);
	await app.commands.removeWorktree(id, owner(app), true);
	assert.equal(app.cwdOf(id), join(link, "app"), "back to the folder as it was given");
});

test("a worktree Pi is working in stays until Pi stops", async () => {
	const { id } = await app.commands.createSession(owner(app), { cwd: join(repo, "app"), worktree: true });
	await app.commands.configure(id, owner(app), { model: { provider: "faux", modelId: "faux-1" } });
	const { submissionId } = await app.commands.submit(id, owner(app), { text: "work slowly", requestId: "slow" });
	await until(() => app.isBusy(id), "Pi to start");
	await assert.rejects(app.commands.removeWorktree(id, owner(app), true), { status: 409, message: /Pi is working in the worktree/ });
	await app.commands.abort(id, owner(app));
	await (await app.harness.submission(submissionId, context))!.wait(context);
	await until(() => !app.isBusy(id), "Pi to stop");
	await app.commands.removeWorktree(id, owner(app), true);
});

test("a worktree another session reaches through a symbolic link stays too", async () => {
	const { id } = await app.commands.createSession(owner(app), { cwd: join(repo, "app"), worktree: true });
	const link = join(root, "worktree-link");
	symlinkSync(app.sessionMeta(id)!.worktree!.path, link, "dir");
	await newSession(app, link);
	await assert.rejects(app.commands.removeWorktree(id, owner(app), true), { status: 409, message: /works in this worktree too/ });
});

test("a worktree another session works in stays, and a session's subagents leave it with the session", async () => {
	const { id } = await app.commands.createSession(owner(app), { cwd: join(repo, "app"), worktree: true });
	await app.commands.configure(id, owner(app), { model: { provider: "faux", modelId: "faux-1" } });
	const worktree = app.sessionMeta(id)!.worktree!;
	await say(app, id, "start a helper");
	await until(async () => (await modelTexts(app, id)).some((text) => text.includes("[subagent helper answered")), "the helper to report");
	const helper = (await app.harness.snapshot(SubagentsDoc, id, context))!.agents.helper!.conversationId;
	// Pi answers the report too: everything settles before the worktree may go.
	await until(() => !app.isBusy(id) && !app.isBusy(helper), "the session and its helper to be done");
	assert.equal(app.cwdOf(helper), join(worktree.path, "app"));

	// A fork made without a worktree of its own works in this one.
	const page = await (await app.harness.conversation(id, context))!.entries({}, 50, undefined, context);
	const reply = page.items.find((entry) => entry.kind === "pi.assistant")!;
	const { id: fork } = await app.commands.fork(id, owner(app), { entryId: Number(reply.id) });
	await assert.rejects(app.commands.removeWorktree(id, owner(app), true), { status: 409, message: /works in this worktree too/ });
	await app.commands.configure(fork, owner(app), { cwd: join(repo, "app") });

	await app.commands.removeWorktree(id, owner(app), true);
	assert.equal(app.cwdOf(id), join(repo, "app"));
	assert.equal(app.cwdOf(helper), join(repo, "app"), "the helper went back with it");
});
