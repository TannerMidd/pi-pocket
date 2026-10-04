// Running now: what is at work in each session, from the task graph, as each person may see it.
import { type App, cleanUp, context, lastText, newSession, openApp, owner, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { runningNow } from "../src/server/running.ts";

/** Asked to wait, the model runs a slow command; then it answers. */
const route: FauxResponseStep = (request) => {
	const { role, text } = lastText(request as never);
	if (role === "toolResult") return fauxAssistantMessage([fauxText("done waiting")]);
	if (text.endsWith("wait a bit")) return fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 1.5" })], { stopReason: "toolUse" });
	return fauxAssistantMessage([fauxText(`echo: ${text}`)]);
};

let app: App;

before(async () => {
	app = await openApp(scriptedModel(route));
});

after(async () => {
	await app?.close();
	cleanUp();
});

test("running now lists a session's run and its tool call, scheduled messages, and only what each person may see", async () => {
	const busy = await newSession(app);
	const quiet = await newSession(app);
	await app.commands.updateSession(busy, owner(app), { title: "Busy one" });
	const scheduled = await app.commands.schedule(quiet, owner(app), { when: "in 2h look again", zone: "UTC" });
	const { submissionId } = await app.commands.submit(busy, owner(app), { text: "wait a bit", requestId: "r1" });
	await until(async () => (await runningNow(app, owner(app))).some((each) => each.tasks.some((task) => task.label === "running bash")), "the tool call to show");

	const running = await runningNow(app, owner(app));
	const first = running[0]!;
	assert.equal(first.id, Number(busy), "the busy session comes first");
	assert.equal(first.title, "Busy one");
	assert.equal(first.busy, true);
	assert.deepEqual(first.tasks.map((task) => [task.kind, task.label]).sort(), [["pi.generation", "writing an answer"], ["pi.tool", "running bash"]]);
	const later = running.find((each) => each.id === Number(quiet))!;
	assert.equal(later.busy, false);
	assert.equal(later.tasks[0]?.scheduleId, scheduled.id);
	assert.match(later.tasks[0]!.label, /^scheduled for \w{3} \d\d:\d\d: look again$/);

	const scoped = app.config.addUser("Sam", "guest", [String(quiet)]).user;
	assert.deepEqual((await runningNow(app, scoped)).map((each) => each.id), [Number(quiet)]);

	await (await app.harness.submission(submissionId, context))!.wait(context);
	assert.equal((await runningNow(app, owner(app))).some((each) => each.id === Number(busy)), false, "a finished run is gone");
	await app.commands.cancelSchedule(quiet, owner(app), scheduled.id);
});
