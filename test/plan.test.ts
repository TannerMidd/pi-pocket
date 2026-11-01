// Plan mode: Pi reads and proposes, anything that changes something is blocked, and approving turns it off.
import {
    type App,
    cleanUp,
    context,
    lastText,
    modelTexts,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { PlanDoc, SubagentsDoc } from "../src/server/docs.ts";
import { blockedInPlanMode, commandWords, readOnlyCommand } from "../src/server/extensions/plan.ts";

test("anything beyond plain words in a command line is refused", () => {
    for (const refused of ["ls > out", 'echo "$(id)"', "echo `id`", "ls *.ts", "ls &"]) {
        const words = commandWords(refused);

        assert.ok(words === undefined || !readOnlyCommand(refused), refused);
    }
});

test("only commands that read pass, with arguments that keep them reading", () => {
    const reads = [
        "ls -la ~/src",
        "cat package.json | head -20",
        "cd src && grep -rn TODO .",
        "find . -name '*.ts' -not -path './node_modules/*'",
        "git status",
        "rg --glob '*.md' pi",
    ];

    for (const command of reads) {
        assert.equal(readOnlyCommand(command), true, command);
    }

    const changes = [
        "rm -rf build",
        "git commit -am x",
        "git -c core.pager=evil log",
        "git diff --output=patch.diff",
        "find . -name x -delete",
        "sort -o out.txt in.txt",
        "rg --pre ./run.sh foo",
        "rg --hostname-bin ./run.sh foo",
        // Long options shortened, as getopt and git accept them.
        "git log --outp=log.txt",
        "sort --compress=sh big.txt",
        // The subscript of a name runs what it substitutes.
        "printf -v 'a[$(touch pwned)]' x",
        "sed -i s/a/b/ f",
        "ls && rm x",
        "",
    ];

    for (const command of changes) {
        assert.equal(readOnlyCommand(command), false, command);
    }
});

test("in plan mode reads and subagent spawning pass, but writes are blocked", () => {
    assert.equal(blockedInPlanMode("read", { path: "a" }), undefined);
    assert.equal(blockedInPlanMode("bash", { command: "git log" }), undefined);
    assert.equal(
        blockedInPlanMode("subagent", { action: "spawn", name: "helper", message: "hello" }),
        undefined,
    );
    assert.match(
        blockedInPlanMode("write", { path: "a", content: "" }) ?? "",
        /^Plan mode is on: The write tool can change things/,
    );
    assert.match(
        blockedInPlanMode("bash", { command: "npm install" }) ?? "",
        /not a simple read-only one/,
    );
    assert.match(
        blockedInPlanMode("schedule", {}) ?? "",
        /blocked/,
        "tools it does not know are blocked too",
    );
    assert.equal(
        blockedInPlanMode("schedule", {}, true),
        undefined,
        "tools their extension marks read-only pass",
    );
});

/** A wrapper-marked read-only tool, an unmarked tool, and a wrap that marks the built-in write tool read-only. */
const peek = `import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, wrapTool } from "@earendil-works/pi-durable";

const tool = (name: string, annotations?: object) =>
	defineTool({
		name,
		description: name,
		parameters: Type.Object({}),
		...(annotations === undefined ? {} : { annotations }),
		execute: async () => ({ output: [{ type: "text", text: name + " ran" }] }),
	});

const peek = tool("peek");
const readOnly = (tool) => ({ ...tool, annotations: { readOnlyHint: true } });

export default () => defineExtension({
    name: "peek",
    tools: [peek, tool("poke")],
    wraps: [wrapTool(peek, readOnly), wrapTool(tool("write"), readOnly)],
});
`;

/** Whether a request carried the plan mode section of the system prompt. */
let toldPlanMode = false;

/** The scripted model tries to write a file, then lists the folder, then answers with what it learned. */
const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);
    // System messages are positional: each sets the sections it names, and null removes one.
    let planSection = false;

    for (const message of (
        request as { messages: { role: string; sections?: Record<string, string | null> }[] }
    ).messages) {
        if (
            message.role === "system" &&
            message.sections !== undefined &&
            "plan_mode" in message.sections
        ) {
            planSection = message.sections.plan_mode !== null;
        }
    }

    if (planSection) {
        toldPlanMode = true;
    }

    const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
        fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

    if (role === "toolResult" && text.startsWith("Plan mode is on")) {
        return call("bash", { command: "ls" });
    }

    if (role === "toolResult") {
        return fauxAssistantMessage([fauxText(`plan: 1. write the file (saw: ${text.trim()})`)]);
    }

    if (text.endsWith("make a plan")) {
        return call("write", { path: "planned.txt", content: "x" });
    }

    if (text.endsWith("start a helper")) {
        return call("subagent", { action: "spawn", name: "helper", message: "hello helper" });
    }

    if (text.endsWith("helper, write")) {
        return call("write", { path: "helper.txt", content: "x" });
    }

    if (text.endsWith("script")) {
        return call("codemode", {
            code: "text(await tools.peek({})); try { await tools.poke({}); } catch (error) { text(error.message); }",
        });
    }

    if (text.endsWith("peek") || text.endsWith("poke")) {
        return call(text.slice(-4), {});
    }

    return fauxAssistantMessage([fauxText(`echo: ${text}`)]);
};

let app: App;

before(async () => {
    const dropIns = join(root, "data", "extensions");

    mkdirSync(dropIns, { recursive: true });
    writeFileSync(join(dropIns, "peek.ts"), peek);
    app = await openApp(scriptedModel(route));
    await app.setExtensionEnabled(owner(app), "peek.ts", true);
});

after(async () => {
    await app?.close();
    cleanUp();
});

test("a session in plan mode is told so, cannot write, still reads, and approving the plan turns it off", async () => {
    const id = await newSession(app);

    await app.commands.setPlan(id, owner(app), true);
    await say(app, id, "make a plan");
    assert.equal(toldPlanMode, true, "the system prompt says plan mode is on");
    assert.equal(existsSync(join(work, "planned.txt")), false, "the write was blocked");
    const said = (await modelTexts(app, id)).join("\n");

    assert.match(said, /Plan mode is on: The write tool can change things/);
    assert.match(said, /plan: 1\. write the file/, "read-only bash ran and Pi answered");

    await app.commands.approvePlan(id, owner(app));
    assert.equal((await app.harness.snapshot(PlanDoc, id, context))?.on, false);
    const viewer = app.config.addUser("Vee", "viewer").user;

    await assert.rejects(app.commands.setPlan(id, viewer, true), { status: 403 });
});

test("subagents spawned in plan mode inherit it and cannot write", async () => {
    const id = await newSession(app);

    await app.commands.setPlan(id, owner(app), true);
    await say(app, id, "start a helper");
    await until(
        async () =>
            (await modelTexts(app, id)).some((text) => text.includes("[subagent helper answered")),
        "the helper to report",
    );
    const helper = (await app.harness.snapshot(SubagentsDoc, id, context))!.agents.helper!
        .conversationId;

    assert.equal((await app.harness.snapshot(PlanDoc, helper, context))?.on, true);

    await say(app, helper, "helper, write");
    assert.equal(existsSync(join(work, "helper.txt")), false, "the inherited plan blocked writing");
    assert.match(
        (await modelTexts(app, helper)).join("\n"),
        /Plan mode is on: The write tool can change things/,
    );
    await app.commands.approvePlan(id, owner(app));
    assert.equal((await app.harness.snapshot(PlanDoc, helper, context))?.on, false);
});

test("plan mode reaches the subagents already at work", async () => {
    const id = await newSession(app);

    await say(app, id, "start a helper");
    await until(
        async () =>
            (await modelTexts(app, id)).some((text) => text.includes("[subagent helper answered")),
        "the helper to report",
    );
    const helper = (await app.harness.snapshot(SubagentsDoc, id, context))!.agents.helper!
        .conversationId;

    await app.commands.setPlan(id, owner(app), true);
    assert.equal((await app.harness.snapshot(PlanDoc, helper, context))?.on, true);

    await say(app, helper, "helper, write");
    assert.equal(existsSync(join(work, "helper.txt")), false, "the helper's write was blocked");
    assert.match(
        (await modelTexts(app, helper)).join("\n"),
        /Plan mode is on: The write tool can change things/,
    );
    await app.commands.approvePlan(id, owner(app));
    assert.equal(
        (await app.harness.snapshot(PlanDoc, helper, context))?.on,
        false,
        "approving lets the helper work again",
    );
});

test("in plan mode a tool its extension marks read-only runs, and one it does not is blocked", async () => {
    const id = await newSession(app);

    await app.commands.setPlan(id, owner(app), true);
    await say(app, id, "peek");
    await say(app, id, "poke");
    await say(app, id, "script");
    const said = (await modelTexts(app, id)).join("\n");

    assert.match(said, /peek ran/);
    assert.doesNotMatch(said, /poke ran/);
    assert.match(said, /Plan mode is on: .*poke/);
    assert.match(
        said,
        /Script completed[\s\S]*peek ran[\s\S]*Tool call blocked: Plan mode is on: .*poke/,
    );
});
