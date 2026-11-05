// Codemode's Only mode: the other tools leave the request, the codemode section lists them, and scripts
// still call them.
import {
    cleanUp,
    context,
    lastText,
    loadTools,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { PlanDoc } from "../src/server/docs.ts";

type System = { role: string; sections?: Record<string, string>; toolsAdded?: { name: string }[] };

let app: Awaited<ReturnType<typeof openApp>>;
/** The newest request: its declared tools, its sections by name, and the last tool result. */
let declared: string[] = [];
let sections: Record<string, string> = {};
let result = "";
/** The declared tools of the subagent's first request. */
let child: string[] | undefined;
/** Scripts the model runs, by a part of the message. */
const scripts: Record<string, string> = {
    "run a script": 'return await tools.late_tool({ text: "hi" })',
    "spawn a helper": `return await tools.subagent({ action: "spawn", name: "kid", message: "Brief", tools: ["read"] })`,
};

const call = (name: string, args: Record<string, string>) =>
    fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

const model = scriptedModel((request) => {
    const { role, text } = lastText(request as never);
    const system = (request.messages as System[]).filter((message) => message.role === "system");

    declared = system.flatMap((message) => (message.toolsAdded ?? []).map((tool) => tool.name));
    sections = Object.assign({}, ...system.map((message) => message.sections));
    result = role === "toolResult" ? text : result;
    child ??= text.includes("Brief") ? declared : undefined;

    const code = Object.entries(scripts).find(([key]) => text.includes(key))?.[1];

    if (role === "user" && code !== undefined) {
        return call("codemode", { code });
    }

    return role === "user" && text.includes("browser")
        ? call("tool_search", { query: "browser" })
        : fauxAssistantMessage([fauxText("done")]);
});

const mode = (value: string) => app.setExtensionSettings(owner(app), "codemode", { mode: value });

before(async () => {
    mkdirSync(join(root, "data", "extensions"), { recursive: true });
    app = await openApp(model);
    // A drop-in that the owner turns on later, too long for the budget: it must follow the mode too.
    writeFileSync(
        join(root, "data", "extensions", "late.ts"),
        `/** Late: for tests. */
export default () => ({ name: "late", tools: [{
    name: "late_tool",
    description: "Late echo. " + "Long. ".repeat(2000),
    parameters: { type: "object", properties: { text: { type: "string" } } },
    annotations: { readOnlyHint: true },
    execute: async (args) => ({ output: [{ type: "text", text: "late:" + args.text }] }),
}, {
    name: "inner_tool",
    description: "Only for scripts.",
    parameters: { type: "object", properties: {} },
    deferred: true,
    callers: ["tools"],
    execute: async () => ({ output: [{ type: "text", text: "inner" }] }),
}] });
`,
    );
});

after(async () => {
    await app?.close();
    cleanUp();
});

test("On mode declares every tool and keeps the short codemode section", async () => {
    mode("on");
    await say(app, await newSession(app), "hello");

    assert.ok(["codemode", "read", "bash"].every((name) => declared.includes(name)));
    assert.match(sections.codemode!, /^<codemode>\nUse codemode to batch/);
});

test("Only mode declares codemode, tool search, and the tools with cards, and lists the others", async () => {
    mode("only");
    await say(app, await newSession(app), "hello");
    await app.setExtensionEnabled(owner(app), "late.ts", true);
    await say(app, await newSession(app), "hello");

    assert.deepEqual(declared.sort(), ["artifact", "ask", "codemode", "memory", "tool_search"]);
    assert.match(sections.codemode!, /^<codemode>\nYour other tools are not declared/);
    assert.match(sections.codemode!, /## read\n.*\nParameters \(JSON Schema\): \{/);
    // Past the budget, a drop-in installed later is listed by name.
    assert.match(sections.codemode!, /\nAlso callable, not listed: late_tool\n/);
    assert.match(sections.deferred_tools!, /- browser:/, "waiting tools still wait");
    assert.doesNotMatch(sections.codemode!, /\bbrowser\b/, "a waiting tool is not listed");
});

test("in Only mode, a script calls a hidden tool, and a tool that waits goes through codemode", async () => {
    mode("only");
    const id = await newSession(app);

    // Loaded before a switch to Only, as in On mode: it waits again.
    await loadTools(app, id, "browser");

    // Plan mode lets a read-only tool run, also one that only scripts call.
    await app.harness.commit(async (tx) => void ((await tx.doc(PlanDoc, id)).on = true), context);
    await say(app, id, "run a script");
    assert.match(result, /^Script completed[\s\S]*late:hi/);

    // A model that takes tool changes would get browser declared in On mode.
    await app.commands.configure(id, owner(app), {
        model: { provider: "faux", modelId: "faux-native" },
    });
    await say(app, id, "need the browser");
    assert.match(result, /^Use these through codemode/);
    assert.ok(!declared.includes("browser"));
});

test("in Only mode, a subagent given a tool that only scripts call also gets codemode", async () => {
    mode("only");
    await say(app, await newSession(app), "spawn a helper");
    await until(() => child !== undefined, "the subagent's first request");

    assert.deepEqual(child, ["codemode"]);
});

test("in On mode, a waiting tool that only scripts call is not offered to tool search", async () => {
    mode("on");
    await say(app, await newSession(app), "hello");

    assert.doesNotMatch(sections.deferred_tools ?? "", /inner_tool/);
});
