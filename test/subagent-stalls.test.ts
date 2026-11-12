// The stall watch of subagents: one message for the helpers that make no progress, a stop of the stuck call at the
// hard limit (at most 2 for one message, then a person decides), and a person's Stop said as such, with the message it
// held followed to its answer.
import {
    type App,
    cleanUp,
    context,
    lastText,
    loadTools,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { type ConversationId, LiveDoc } from "@earendil-works/pi-durable";
import { SubagentsDoc } from "../src/server/docs.ts";
import { runningNow } from "../src/server/running.ts";
import { STALL_LOOK } from "../src/server/stall-facts.ts";

/** A command that prints nothing and never ends by itself. */
const HANG = "exec tail -f /dev/null";
/** How far the app's clock is ahead of the real one. */
let offset = 0;

const hang = () =>
    fauxAssistantMessage([fauxToolCall("bash", { command: HANG })], { stopReason: "toolUse" });

const route: FauxResponseStep = (request) => {
    const all = JSON.stringify((request as { messages: unknown[] }).messages);
    const { role, text: said } = lastText(request as never);
    const text = said.replace(/^\[from: [^\]]+\] /, "");
    const subagent = /You are the subagent \\"([^\\]+)\\"/.exec(all)?.[1];

    if (subagent !== undefined) {
        // "loop-": a new stuck call after each stopped one. Others hang once, then answer.
        if (subagent.startsWith("loop-") || (role === "user" && text.startsWith("Check "))) {
            return hang();
        }

        return fauxAssistantMessage([fauxText(`result of ${subagent}: ${text.slice(0, 40)}`)]);
    }

    const spawn = /^spawn (.+)$/.exec(text);

    if (spawn !== null) {
        return fauxAssistantMessage(
            spawn[1]!
                .split(" ")
                .map((name) =>
                    fauxToolCall("subagent", { action: "spawn", name, message: `Check ${name}.` }),
                ),
            { stopReason: "toolUse" },
        );
    }

    const nudge = /^nudge (\S+)$/.exec(text);

    if (nudge !== null) {
        return fauxAssistantMessage(
            [
                fauxToolCall("subagent", {
                    action: "send",
                    name: nudge[1]!,
                    message: "One more thing.",
                }),
            ],
            { stopReason: "toolUse" },
        );
    }

    return fauxAssistantMessage([fauxText("noted")]);
};

let app: App;
const alerts: string[] = [];

before(async () => {
    STALL_LOOK.ms = 100;
    app = await openApp(
        scriptedModel(route),
        join(root, "subagent-stalls"),
        () => Date.now() + offset,
    );
    // Only the stall watch stops calls here.
    app.background.limits.commandQuietMs = 0;
    app.alerts.ownerAlert = (_id, _title, body) => void alerts.push(body);
});

after(async () => {
    await app?.close();
    cleanUp();
});

async function session(): Promise<ConversationId> {
    const id = await newSession(app);

    await loadTools(app, id, "subagent");

    return id;
}

async function say(id: ConversationId, text: string): Promise<void> {
    const { submissionId } = await app.commands.submit(id, owner(app), {
        text,
        requestId: crypto.randomUUID(),
    });

    await (await app.harness.submission(submissionId, context))!.wait(context);
}

/** The messages the parent got, each as its text. */
async function inbox(id: ConversationId): Promise<string[]> {
    return (await (await app.harness.conversation(id, context))!.context(context)).messages
        .filter((message) => message.role === "user")
        .map((message) =>
            typeof message.content === "string"
                ? message.content
                : (message.content as { text?: string }[]).map((part) => part.text ?? "").join(""),
        );
}

const agent = async (id: ConversationId, name: string) =>
    (await app.harness.snapshot(SubagentsDoc, id, context))!.agents[name]!;

/** The call a subagent waits on now, once it has one. */
async function call(id: ConversationId, name: string): Promise<string | undefined> {
    const live = await app.harness.snapshot(
        LiveDoc,
        (await agent(id, name)).conversationId,
        context,
    );

    return live?.tools?.find((tool) => tool.status === "running")?.callId;
}

const settings = (stalledMinutes: number, stopMinutes: number) =>
    app.setExtensionSettings(owner(app), "subagents", { stalledMinutes, stopMinutes });

test("helpers past the soft limit cost the parent one message, with what each waits on", async () => {
    settings(30, 0);
    const id = await session();

    await say(id, "spawn soft-a soft-b");
    await until(
        async () =>
            (await call(id, "soft-a")) !== undefined && (await call(id, "soft-b")) !== undefined,
        "both at work on a call",
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    offset += 31 * 60_000;
    await until(
        async () => (await inbox(id)).some((text) => text.includes("soft-b stalled")),
        "the stall message",
    );

    const told = (await inbox(id)).filter((text) => text.includes(" stalled: "));

    assert.equal(told.length, 1, "one message for both");
    assert.match(
        told[0]!,
        /soft-a stalled: no progress for 31 min, waiting on its bash call since \d\d:\d\d UTC/,
    );
    assert.match(told[0]!, /soft-b stalled/);
    assert.ok((await call(id, "soft-a")) !== undefined, "nothing is stopped at the soft limit");

    const board = (await runningNow(app, owner(app))).flatMap((each) => each.tasks);

    assert.ok(
        board.some((task) => task.subagent === "soft-a" && task.kind === "pi.tool" && task.stalled),
        "Running now marks its call stalled",
    );

    for (const name of ["soft-a", "soft-b"]) {
        await (await app.harness.conversation(
            (await agent(id, name)).conversationId,
            context,
        ))!.abort(context);
    }
});

test("the hard limit stops the stuck call, 2 times for one message, then leaves it to a person", async () => {
    settings(30, 60);
    alerts.length = 0;
    const id = await session();

    await say(id, "spawn loop-x");

    for (let stop = 1; stop <= 3; stop++) {
        const stuck = await (async () => {
            await until(async () => (await call(id, "loop-x")) !== undefined, "a stuck call");

            return (await call(id, "loop-x"))!;
        })();

        await new Promise((resolve) => setTimeout(resolve, 300));
        offset += 61 * 60_000;

        if (stop <= 2) {
            await until(
                async () => ![undefined, stuck].includes(await call(id, "loop-x")),
                `stop ${stop}: the call stopped, and the subagent on to its next`,
            );
            await until(
                async () => (await inbox(id)).join("\n").includes(`stop ${stop} of 2`),
                `stop ${stop}: the parent told`,
            );
        } else {
            await until(
                async () => (await inbox(id)).join("\n").includes("stops it no more"),
                "the parent told that a person decides",
            );
            await new Promise((resolve) => setTimeout(resolve, 500));
            assert.equal(await call(id, "loop-x"), stuck, "a third stall is not stopped");
        }
    }

    assert.equal(alerts.length, 3, "the owner hears of each pass of the hard limit");
    assert.match(alerts[2]!, /left for you to decide/);
    await (await app.harness.conversation(
        (await agent(id, "loop-x")).conversationId,
        context,
    ))!.abort(context);
});

test("a person's Stop is said as such, and the message it held reaches the parent with its answer", async () => {
    settings(30, 0);
    const id = await session();

    await say(id, "spawn held");
    await until(async () => (await call(id, "held")) !== undefined, "the subagent on a stuck call");
    await say(id, "nudge held");

    const child = (await agent(id, "held")).conversationId;

    await app.commands.abort(child, owner(app));
    await until(
        async () =>
            (await inbox(id)).some((text) => text.includes("held stopped: a person stopped it")),
        "the report of the Stop",
    );
    await until(() => !app.isBusy(child), "the subagent stopped");
    assert.equal(await app.commands.sendHeld(child, owner(app)), 1);
    await until(
        async () =>
            (await inbox(id)).some((text) =>
                /\[subagent held answered[^]*One more thing/.test(text),
            ),
        "the answer to the held message",
    );
    assert.ok(!(await inbox(id)).join("\n").includes("held failed"), "a Stop is no failure");
});
