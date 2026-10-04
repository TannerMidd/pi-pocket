// Spend: what each session and person cost, counted once across restarts and crashes, and limits that refuse and
// stop work. The scripted model costs nothing, so tests record usage in `pi.usage` themselves, as a response does.
import { type App, cleanUp, context, fakeTab, lastText, newSession, openApp, owner, recordCost, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { type ConversationId, LiveDoc, type UsageState } from "@earendil-works/pi-durable";
import type { User } from "../src/server/config.ts";
import { SpendDoc } from "../src/server/docs.ts";
import { usageCost } from "../src/server/projection.ts";

/** Usage worth `dollars`, split between a model and a tool. */
const costing = (dollars: number) =>
	({ models: { "faux/faux-1": { cost: { total: dollars - 0.25 } } }, tools: { codemode: { cost: { total: 0.25 } } } }) as unknown as UsageState;

const route: FauxResponseStep = (request) => {
	const { role, text } = lastText(request as never);
	if (role === "toolResult") return fauxAssistantMessage([fauxText("done")]);
	if (text.endsWith("work slowly")) return fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 5" })], { stopReason: "toolUse" });
	return fauxAssistantMessage([fauxText(`echo: ${text}`)]);
};
const model = scriptedModel(route);

let app: App;
let alex: User;

before(async () => {
	app = await openApp(model);
	alex = app.config.addUser("Alex", "guest").user;
});

after(async () => {
	await app?.close();
	cleanUp();
});

async function sayAs(user: User, id: ConversationId, text: string): Promise<void> {
	const { submissionId } = await app.commands.submit(id, user, { text, requestId: crypto.randomUUID() });
	await (await app.harness.submission(submissionId, context))!.wait(context);
}

test("a conversation's spend is everything its models and tools cost", () => {
	assert.equal(usageCost(costing(1.5)), 1.5);
	assert.equal(usageCost(undefined), 0);
});

test("spend goes to whoever asked for the work, once, also when the server stopped before counting it", async () => {
	const id = await newSession(app);
	await sayAs(alex, id, "do something");
	await recordCost(app, id, 1.5);
	await until(() => app.spend.personSpent(alex.id) === 1.5, "Alex's spend to be counted");
	assert.equal(app.spend.sessionSpent(id), 1.5);
	await recordCost(app, id, 0.5);
	await until(() => app.spend.personSpent(alex.id) === 2, "the new spend to be added");
	assert.equal(app.spend.personSpent(owner(app).id), 0);

	// The server stops right after a response, before its spend is counted for anyone.
	await recordCost(app, id, 1);
	assert.equal(app.spend.personSpent(alex.id), 2, "not counted yet");
	await app.close();
	app = await openApp(model);
	assert.equal(app.spend.personSpent(alex.id), 3, "counted on the next start, once");
	assert.equal(app.spend.sessionSpent(id), 3);
});

test("spend goes to whoever asked for the work, also when someone else writes before it is stored", async () => {
	const id = await newSession(app);
	const bea = app.config.addUser("Bea", "guest").user;
	await sayAs(alex, id, "do something");
	const before = app.spend.personSpent(alex.id);
	await recordCost(app, id, 2);
	await sayAs(bea, id, "and something else");
	await until(() => app.spend.personSpent(alex.id) === before + 2, "Alex's spend to be stored");
	assert.equal(app.spend.personSpent(bea.id), 0);
});

test("the first start that counts spend per person bills nobody for what was spent before", async () => {
	const id = await newSession(app);
	await sayAs(alex, id, "before the upgrade");
	// As before an upgrade: usage, and no per-person counting yet.
	await app.harness.commit((tx) => tx.retireDoc(SpendDoc), context);
	await recordCost(app, id, 4);
	await app.close();
	app = await openApp(model);
	assert.equal(app.spend.personSpent(alex.id), 0);
	assert.equal(app.spend.sessionSpent(id), 4, "the session still shows what it cost");
	await recordCost(app, id, 1);
	await until(() => app.spend.personSpent(alex.id) === 1, "new spend to be Alex's");
});

test("limits refuse new messages, for a session and for a guest, but never for the owner's own spend", async () => {
	const id = await newSession(app);
	await recordCost(app, id, 3);
	await until(() => app.spend.sessionSpent(id) === 3, "the spend to be known");
	await assert.rejects(app.spend.setSessionBudget(alex, id, 1), { status: 403 });
	await assert.rejects(app.spend.setSessionBudget(owner(app), id, -1), { status: 400 });
	await app.spend.setSessionBudget(owner(app), id, 2.5);
	assert.throws(() => app.spend.check(owner(app), id), { status: 409, message: "This session reached its $2.50 spend limit. The owner can raise it." });
	await app.spend.setSessionBudget(owner(app), id, null);
	app.spend.check(owner(app), id);

	app.spend.setPersonBudget(owner(app), alex.id, 1);
	assert.throws(() => app.spend.check(alex, id), { status: 409, message: "You reached your $1.00 spend limit. The owner can raise it." });
	await assert.rejects(app.commands.submit(id, alex, { text: "more", requestId: "r" }), { status: 409 });
	assert.throws(() => app.spend.setPersonBudget(owner(app), owner(app).id, 1), { status: 400 });
	app.spend.setPersonBudget(owner(app), alex.id, null);
	app.spend.check(alex, id);

	const summary = app.spend.summary(alex);
	assert.equal(summary.total, undefined, "only the owner sees the total");
	assert.deepEqual(summary.people.map((person) => person.name), ["Alex"]);
	assert.ok(app.spend.summary(owner(app)).people.length >= 2);
});

test("compacting asks the model too, so a limit refuses it", async () => {
	const id = await newSession(app);
	await recordCost(app, id, 2);
	await app.spend.setSessionBudget(owner(app), id, 1);
	await assert.rejects(app.commands.compact(id, owner(app), undefined), { status: 409, message: /spend limit/ });
});

test("a run that crosses its session's limit is stopped once, and the people there are told once", async () => {
	const id = await newSession(app);
	await app.spend.setSessionBudget(owner(app), id, 1);
	const tab = fakeTab(id, owner(app));
	await app.attach(tab.client);
	const stopped = () => tab.events.filter((each) => each.event === "notice" && each.data.message === "Pi stopped: this session reached its $1.00 spend limit.");
	// Stopping takes a moment, as it can with a real provider: spend counted meanwhile may not stop the run again.
	const conversation = app.conversation;
	let aborts = 0;
	app.conversation = async (cid) =>
		new Proxy(await conversation.call(app, cid), {
			get: (found, key) => {
				if (key === "abort") {
					return async (...args: Parameters<typeof found.abort>) => {
						aborts++;
						await new Promise((resolve) => setTimeout(resolve, 700));
						return found.abort(...args);
					};
				}
				const value: unknown = Reflect.get(found, key, found);
				return typeof value === "function" ? value.bind(found) : value;
			},
		});
	try {
		const { submissionId } = await app.commands.submit(id, owner(app), { text: "work slowly", requestId: "slow" });
		// The model answered once the tool runs: its response costs more than the limit.
		await until(async () => (await app.harness.snapshot(LiveDoc, id, context))?.tools?.some((tool) => tool.status === "running") === true, "the tool to run");
		await recordCost(app, id, 1.25);
		await until(() => stopped().length > 0, "the notice");
		await recordCost(app, id, 0.25);
		const settled = await (await app.harness.submission(submissionId, context))!.wait(context);
		assert.deepEqual(settled.status === "unanswered" ? settled.reason : settled.status, "aborted");
		const said = JSON.stringify((await (await app.harness.conversation(id, context))!.entries({}, 50, undefined, context)).items);
		assert.doesNotMatch(said, /"done"/, "the five-second command was cut off, so Pi never answered after it");
		assert.equal(aborts, 1);
		assert.equal(stopped().length, 1);

		// With the limit raised, a later run there is stopped again when it crosses it.
		await until(() => !app.isBusy(id), "the run to end");
		await app.spend.setSessionBudget(owner(app), id, 2);
		const later = await app.commands.submit(id, owner(app), { text: "work slowly", requestId: "slow-again" });
		await until(async () => (await app.harness.snapshot(LiveDoc, id, context))?.tools?.some((tool) => tool.status === "running") === true, "the tool to run again");
		await recordCost(app, id, 1);
		const settledLater = await (await app.harness.submission(later.submissionId, context))!.wait(context);
		assert.deepEqual(settledLater.status === "unanswered" ? settledLater.reason : settledLater.status, "aborted");
		assert.equal(aborts, 2);
	} finally {
		app.conversation = conversation;
		app.detach(tab.client);
	}
});

