// The subagent rows of the entry-point table, through the real flows: a spawn, a reporter's delivery to a subagent, and the
// courier's batch to the parent. A sandboxed session is the parent; a gate in the fake provider (or in the model) holds a step
// half way, and the delivery check is made to defer, so the rows are tried where the tools and tasks really run.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Deferred } from "../src/server/deliver.ts";
import { SubagentsDoc } from "../src/server/docs.ts";
import {
    cleanUp,
    context,
    lastText,
    newSession,
    offerSubagents,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
    type App,
} from "./helpers.ts";
import { FakeProvider, gate, sandboxOptions } from "./sandbox-fake.ts";

/** Steps the scripted models wait at, set by a test. */
const holds: { spawn?: Promise<void>; helper?: Promise<void> } = {};

const route: FauxResponseStep = async (request) => {
    const all = JSON.stringify((request as { messages: unknown[] }).messages);
    const { role, text } = lastText(request as never);
    const subagent = /You are the subagent \\"([^\\]+)\\"/.exec(all)?.[1];

    if (subagent !== undefined) {
        if (role !== "toolResult") {
            await holds.helper;
        }

        return fauxAssistantMessage([fauxText(`result of ${subagent}`)]);
    }

    if (text === "orchestrate") {
        await holds.spawn;

        return fauxAssistantMessage(
            [
                fauxToolCall("subagent", {
                    action: "spawn",
                    name: "helper",
                    message: "Check, please.",
                }),
            ],
            { stopReason: "toolUse" },
        );
    }

    if (text === "nudge helper") {
        return fauxAssistantMessage(
            [
                fauxToolCall("subagent", {
                    action: "send",
                    name: "helper",
                    message: "One more thing.",
                    followUp: true,
                }),
            ],
            { stopReason: "toolUse" },
        );
    }

    return fauxAssistantMessage([fauxText(role === "toolResult" ? "done working" : "noted")]);
};

let app: App;
let provider: FakeProvider;
let opened = 0;

before(async () => {
    app = await openApp(
        scriptedModel(route),
        join(root, "data-subagents"),
        undefined,
        undefined,
        sandboxOptions(),
    );
    offerSubagents(app);
    provider = new FakeProvider();
    await app.sandboxes.register(provider, "fake.ts");
});

after(async () => {
    await app?.close();
    cleanUp();
});

async function parent(name: string): Promise<ConversationId> {
    const dir = join(root, `subagents-${name}-${++opened}`);

    mkdirSync(dir, { recursive: true });
    const id = await newSession(app, dir);

    await app.sandboxes.turnOn(id, owner(app));

    return id;
}

const helperOf = async (id: ConversationId) =>
    (await app.harness.snapshot(SubagentsDoc, id, context))?.agents.helper;

const userTexts = async (id: ConversationId) =>
    (
        await (await app.harness.conversation(id, context))!.entries({}, 200, undefined, context)
    ).items
        .filter((entry) => entry.kind === "pi.user")
        .map((entry) => JSON.stringify(entry.model));

const send = (id: ConversationId, text: string) =>
    app.commands
        .submit(id, owner(app), { text, requestId: crypto.randomUUID() })
        .then(async ({ submissionId }) => {
            await (await app.harness.submission(submissionId, context))!.wait(context);
        });

/** A promise for a model to wait at, and how to open it. */
function holdSpawn(): () => void {
    let open!: () => void;

    holds.spawn = new Promise<void>((resolve) => (open = resolve));

    return open;
}

test("a spawn waits for a stable phase, then joins its session's tree", async () => {
    const id = await parent("spawn");
    const hold = gate();
    const openModel = holdSpawn();
    const placed = await app.commands.submit(id, owner(app), {
        text: "orchestrate",
        requestId: "go-1",
    });

    // The run is at its model call. The sandbox is turned off meanwhile, and held in the middle of its release.
    provider.holdRelease = hold;
    const off = app.sandboxes.turnOff(id, owner(app));

    await hold.reached;
    assert.equal(app.sandboxes.phaseOf(id), "turning-off");
    openModel();

    for (let turns = 0; turns < 20; turns++) {
        await new Promise((resolve) => setImmediate(resolve));
    }

    assert.equal(await helperOf(id), undefined, "the spawn waits while the sandbox changes");
    hold.open();
    await off;
    provider.holdRelease = undefined;
    await (await app.harness.submission(placed.submissionId, context))!.wait(context);
    const record = await helperOf(id);

    assert.ok(record !== undefined, "the spawn went on once the phase was stable");
    assert.equal(app.rootOf(record.conversationId), id, "it joined its session's tree");
    assert.equal(
        app.sandboxes.isOn(record.conversationId),
        false,
        "it reads its root's setting, which is off now",
    );
    holds.spawn = undefined;
});

test("in a suspended session the spawn tool is blocked at its gate, and nothing is made", async () => {
    const id = await parent("spawn-suspended");
    const openModel = holdSpawn();
    const placed = await app.commands.submit(id, owner(app), {
        text: "orchestrate",
        requestId: "go-2",
    });

    provider.failRelease = "the VM would not close";
    await assert.rejects(app.sandboxes.turnOff(id, owner(app)), /would not close/);
    assert.equal(app.sandboxes.phaseOf(id), "suspended");
    openModel();
    await (await app.harness.submission(placed.submissionId, context))!.wait(context);
    assert.equal(await helperOf(id), undefined, "no subagent was made in a suspended session");
    provider.failRelease = undefined;
    await app.sandboxes.resume(id);
    holds.spawn = undefined;
});

test("a report that cannot reach its parent, and a message that cannot reach its subagent, wait and are delivered once", async () => {
    const id = await parent("reports");
    const helperGate = gate();
    const original = app.sandboxes.requireDelivery.bind(app.sandboxes);
    const blocked = new Set<ConversationId>();
    let tries = 0;

    app.sandboxes.requireDelivery = (target) => {
        if (blocked.has(target)) {
            tries++;

            throw new Deferred("The sandbox of this session is changing.", 20);
        }

        original(target);
    };

    holds.helper = helperGate.opened;

    try {
        await send(id, "orchestrate");
        const child = (await helperOf(id))!.conversationId;

        // The courier: the subagent answers while its parent's deliveries defer.
        blocked.add(id);
        helperGate.open();
        await until(() => tries >= 2, "the courier to try, be deferred, and try again", 20_000);
        assert.equal(
            (await userTexts(id)).filter((text) => /\[subagent helper/.test(text)).length,
            0,
        );
        blocked.delete(id);
        await until(
            async () =>
                (await userTexts(id)).some((text) => /\[subagent helper answered/.test(text)),
            "the report after the wait",
            20_000,
        );
        assert.equal(
            (await userTexts(id)).filter((text) => /\[subagent helper answered/.test(text)).length,
            1,
            "the batch went once",
        );

        // The reporter: a message to the subagent waits while the delivery to it defers.
        tries = 0;
        blocked.add(child);
        await send(id, "nudge helper");
        await until(() => tries >= 3, "the reporter to try and be deferred", 20_000);
        assert.equal(
            (await userTexts(child)).filter((text) => /One more thing/.test(text)).length,
            0,
        );
        blocked.delete(child);
        await until(
            async () => (await userTexts(child)).some((text) => /One more thing/.test(text)),
            "the message after the wait",
            20_000,
        );
        assert.equal(
            (await userTexts(child)).filter((text) => /One more thing/.test(text)).length,
            1,
        );
    } finally {
        app.sandboxes.requireDelivery = original;
        holds.helper = undefined;
    }
});
