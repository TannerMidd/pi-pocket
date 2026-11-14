// Follow-up provenance: model tools retain only authenticated hook roots, and delayed producers reserve derived receipts before they submit.
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { type ConversationId, LiveDoc } from "@earendil-works/pi-durable";
import { BackgroundDoc, HooksDoc, SubagentsDoc, type ReplyOrigins } from "../src/server/docs.ts";
import createBackground from "../src/server/extensions/background.ts";
import type { PocketHost } from "../src/server/host.ts";
import { requestFor } from "../src/server/requests.ts";
import {
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
    type App,
} from "./helpers.ts";

const route: FauxResponseStep = (request) => {
    const all = JSON.stringify((request as { messages: unknown[] }).messages);
    const { role, text } = lastText(request as never);
    const name = /You are the subagent \\"([^\\]+)\\"/.exec(all)?.[1];

    if (name !== undefined) {
        if (name.startsWith("provenance-") && role !== "toolResult") {
            return fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 0.2" })], {
                stopReason: "toolUse",
            });
        }

        return fauxAssistantMessage([fauxText(`result from ${name}`)]);
    }

    if (role === "toolResult") {
        return fauxAssistantMessage([fauxText("tool completed")]);
    }

    if (text.includes("provenance-chain")) {
        return fauxAssistantMessage(
            [
                fauxToolCall("background", {
                    action: "start",
                    command: "sleep 0.15; echo chain-provenance",
                }),
            ],
            { stopReason: "toolUse" },
        );
    }

    if (text.includes("chain-provenance")) {
        return fauxAssistantMessage(
            [fauxToolCall("background", { action: "start", command: "echo chained" })],
            { stopReason: "toolUse" },
        );
    }

    if (text.includes("provenance-background")) {
        return fauxAssistantMessage(
            [fauxToolCall("background", { action: "start", command: "sleep 0.15; echo done" })],
            { stopReason: "toolUse" },
        );
    }

    if (text.includes("provenance-capacity")) {
        return fauxAssistantMessage(
            [fauxToolCall("background", { action: "start", command: "sleep 0.7; echo done" })],
            { stopReason: "toolUse" },
        );
    }

    const agent = /provenance-agent-([ab])/.exec(text)?.[1];

    if (agent !== undefined) {
        return fauxAssistantMessage(
            [
                fauxToolCall("subagent", {
                    action: "spawn",
                    name: `provenance-${agent}`,
                    message: `Report ${agent}.`,
                }),
            ],
            { stopReason: "toolUse" },
        );
    }

    return fauxAssistantMessage([fauxText(`echo: ${text}`)]);
};

let app: App | undefined;

after(async () => {
    await app?.close();
    cleanUp();
});

async function open(name: string): Promise<App> {
    app = await openApp(scriptedModel(route), join(root, name));
    app.background.timing = { look: 30, grace: 100, starting: 500, sweep: 60_000 };

    return app;
}

async function hooked(app: App, id: ConversationId, name: string) {
    const view = await app.commands.addHook(owner(app), {
        target: Number(id),
        name,
        replyUrl: "http://127.0.0.1:1/reply",
    });
    const hook = (await app.harness.snapshot(HooksDoc, context))!.items[view.id]!;

    return hook;
}

async function post(
    app: App,
    hook: Awaited<ReturnType<typeof hooked>>,
    text: string,
    request: string,
    capable = true,
): Promise<void> {
    const result = await app.hooks.deliver(hook.id, {
        secret: hook.secret,
        headers: {
            "idempotency-key": request,
            ...(capable ? { "x-pocket-reply-protocol": "2" } : {}),
        },
        body: Buffer.from(JSON.stringify({ text })),
    });

    assert.equal(result.status, 202);
}

async function roots(app: App, hook: Awaited<ReturnType<typeof hooked>>): Promise<ReplyOrigins> {
    return Object.entries(
        (await app.harness.snapshot(HooksDoc, context))!.items[hook.id]!.reply!.requests!,
    )
        .filter(([, receipt]) => receipt.followUp === true && receipt.root === undefined)
        .map(([key, receipt]) => ({
            hookId: hook.id,
            key,
            request: receipt.request,
            followUp: true,
        }));
}

async function backgroundItems(app: App, id: ConversationId) {
    return Object.values((await app.harness.snapshot(BackgroundDoc, id, context))?.items ?? {});
}

async function submissionForRoot(
    app: App,
    hook: Awaited<ReturnType<typeof hooked>>,
    request: string,
) {
    const receipt = Object.values(
        (await app.harness.snapshot(HooksDoc, context))!.items[hook.id]!.reply!.requests!,
    ).find((item) => item.request === request)!;

    return app.harness.commit(
        (tx) => tx.submissionByRequest(hook.target as ConversationId, receipt.submissionRequest),
        context,
    );
}

test("a current model tool captures its root, rejects another owner, and a background round trip keeps that root", async () => {
    const app = await open("reply-provenance-background");
    const id = await newSession(app);

    await loadTools(app, id, "background");
    const hook = await hooked(app, id, "Provenance background");
    const start = app.background.start.bind(app.background);
    let current: ReplyOrigins | undefined;
    let stale: ReplyOrigins | undefined;

    app.background.start = async (conversationId, request, signal) => {
        const taskId = Number(request.key!.split(":")[0]);

        current = await app.replies.originForTool(conversationId, taskId as never);
        stale = await app.replies.originForTool(conversationId, (taskId + 1) as never);

        return start(conversationId, request, signal);
    };

    try {
        await post(app, hook, "provenance-background", "root-background");
        await until(
            async () => (await backgroundItems(app, id)).length === 1,
            "the background tool call",
        );

        const [root] = await roots(app, hook);
        const [item] = await backgroundItems(app, id);

        assert.deepEqual(current, [root], "the current pi.tool owner has the authenticated root");
        assert.equal(stale, undefined, "another pi.tool task cannot borrow the live run roots");
        assert.deepEqual(item!.replyOrigins, [root], "the producer stores the exact root set");

        await until(
            async () => (await backgroundItems(app, id))[0]?.status === "exited",
            "the background command to finish",
        );
        await until(
            async () =>
                Object.values(
                    (await app.harness.snapshot(HooksDoc, context))!.items[hook.id]!.reply!
                        .requests!,
                ).some(
                    (receipt) =>
                        receipt.root === root!.key && receipt.submissionRequest.startsWith("p:"),
                ),
            "the background notification reservation",
        );

        const derived = Object.values(
            (await app.harness.snapshot(HooksDoc, context))!.items[hook.id]!.reply!.requests!,
        ).find((receipt) => receipt.root === root!.key)!;

        assert.equal(derived.request, "root-background");
        assert.equal(derived.followUp, true);
        assert.ok(derived.submissionRequest.startsWith("p:"));
    } finally {
        app.background.start = start;
    }
});

test("originForTool retains every rooted input, rejects a mixed owner input, and follows a derived receipt", async () => {
    const app = await open("reply-provenance-inputs");
    const id = await newSession(app);

    await loadTools(app, id, "background");

    const first = await hooked(app, id, "First root");
    const second = await hooked(app, id, "Second root");

    await post(app, first, "quiet first", "first-root");
    await post(app, second, "quiet second", "second-root");
    await post(app, first, "quiet legacy", "legacy-root", false);

    assert.equal(
        Object.values(
            (await app.harness.snapshot(HooksDoc, context))!.items[first.id]!.reply!.requests!,
        ).find((receipt) => receipt.request === "legacy-root")!.followUp,
        undefined,
        "only the inbound protocol header grants the root capability",
    );

    const ownerSubmission = await app.commands.submit(id, owner(app), {
        text: "quiet owner",
        requestId: "owner-input",
    });

    await (await app.harness.submission(ownerSubmission.submissionId, context))!.wait(context);
    await until(
        async () =>
            (await roots(app, first)).length === 1 && (await roots(app, second)).length === 1,
        "the completed roots",
    );
    const start = app.background.start.bind(app.background);
    let allRooted: ReplyOrigins | undefined;
    let mixed: ReplyOrigins | undefined;

    app.background.start = async (conversationId, request, signal) => {
        const taskId = Number(request.key!.split(":")[0]);
        const live = (await app.harness.snapshot(LiveDoc, conversationId, context))!;
        const inputs = [...live.run!.inputs];
        const firstRoot = (await roots(app, first))[0]!;
        const secondRoot = (await roots(app, second))[0]!;
        const firstSubmission = await submissionForRoot(app, first, firstRoot.request);
        const secondSubmission = await submissionForRoot(app, second, secondRoot.request);

        // Pi Durable normally creates this input set at admission. Add completed inputs here so this test exercises the
        // ownership and receipt scan with a multi-input run, without a timing race in the scripted provider.
        await app.harness.commit(async (tx) => {
            (await tx.doc(LiveDoc, conversationId)).run!.inputs = [
                ...inputs,
                firstSubmission!.id,
                secondSubmission!.id,
            ];
        }, context);
        allRooted = await app.replies.originForTool(conversationId, taskId as never);
        await app.harness.commit(async (tx) => {
            (await tx.doc(LiveDoc, conversationId)).run!.inputs = [
                ...inputs,
                firstSubmission!.id,
                secondSubmission!.id,
                ownerSubmission.submissionId,
            ];
        }, context);
        mixed = await app.replies.originForTool(conversationId, taskId as never);
        await app.harness.commit(async (tx) => {
            (await tx.doc(LiveDoc, conversationId)).run!.inputs = inputs;
        }, context);

        return start(conversationId, request, signal);
    };

    try {
        await post(app, first, "provenance-background", "trigger-root");
        await until(async () => allRooted !== undefined, "the multi-input provenance check");
        const trigger = (await roots(app, first)).find(
            (origin) => origin.request === "trigger-root",
        )!;

        assert.deepEqual(
            allRooted!.map((origin) => origin.key).sort(),
            [
                firstRootKey(await roots(app, first), "first-root"),
                firstRootKey(await roots(app, second), "second-root"),
                trigger.key,
            ].sort(),
        );
        assert.equal(mixed, undefined, "one unrooted owner input rejects the complete set");
    } finally {
        app.background.start = start;
    }

    await post(app, first, "provenance-chain", "chain-root");
    await until(
        async () => (await backgroundItems(app, id)).length >= 3,
        "the derived notification tool",
    );
    const chainRoot = (await roots(app, first)).find((origin) => origin.request === "chain-root")!;
    const chain = (await backgroundItems(app, id)).find((item) =>
        item.command.includes("echo chained"),
    )!;

    assert.deepEqual(
        chain.replyOrigins,
        [chainRoot],
        "a tool called by a derived receipt keeps its root",
    );
});

function firstRootKey(origins: ReplyOrigins, request: string): string {
    return origins.find((origin) => origin.request === request)!.key;
}

test("a full root set defers a background notification without submitting, then uses its same source request", async () => {
    const app = await open("reply-provenance-capacity");
    const id = await newSession(app);

    await loadTools(app, id, "background");
    const hook = await hooked(app, id, "Capacity root");

    await post(app, hook, "provenance-capacity", "capacity-root");
    await until(async () => (await backgroundItems(app, id)).length === 1, "the capacity task");
    const [item] = await backgroundItems(app, id);
    const source = requestFor(owner(app).id, `background-batch-${item!.id}`);

    await app.harness.commit(async (tx) => {
        const receipts = (await tx.doc(HooksDoc)).items[hook.id]!.reply!.requests!;

        Object.assign(
            receipts,
            Object.fromEntries(
                Array.from({ length: 999 }, (_, index) => [
                    `full-${index}`,
                    { request: `full-${index}`, submissionRequest: `full-${index}` },
                ]),
            ),
        );
    }, context);
    await until(
        async () => (await backgroundItems(app, id))[0]?.status === "exited",
        "the capacity task to end",
    );
    await new Promise((resolve) => setTimeout(resolve, 150));

    const before = await app.harness.commit((tx) => tx.submissionByRequest(id, source), context);

    assert.equal(before, undefined, "capacity defers before it submits");
    assert.equal(
        Object.values(
            (await app.harness.snapshot(HooksDoc, context))!.items[hook.id]!.reply!.requests!,
        ).some((receipt) => receipt.submissionRequest === source),
        false,
    );

    await app.harness.commit(async (tx) => {
        (await tx.doc(HooksDoc)).items[hook.id]!.reply!.requests!["full-0"]!.done = true;
    }, context);
    await until(
        async () =>
            (await app.harness.commit((tx) => tx.submissionByRequest(id, source), context)) !==
            undefined,
        "the deferred notification submission",
        10_000,
    );

    const receipt = Object.values(
        (await app.harness.snapshot(HooksDoc, context))!.items[hook.id]!.reply!.requests!,
    ).find((entry) => entry.submissionRequest === source)!;

    assert.equal(receipt.root, (await roots(app, hook))[0]!.key);
});

test("the subagent courier reserves each origin partition before it submits reports", async () => {
    const app = await open("reply-provenance-courier");
    const id = await newSession(app);

    // In Pocket 0.28, subagent is a deferred model tool and must be loaded before this scripted model can call it.
    await loadTools(app, id, "subagent");
    const first = await hooked(app, id, "Courier first");
    const second = await hooked(app, id, "Courier second");
    const reserve = app.replies.reserve.bind(app.replies);
    const checked: string[] = [];

    app.replies.reserve = async (conversationId, request, origins) => {
        if (request.startsWith("subagent-reports:")) {
            const existing = await app.harness.commit(
                (tx) => tx.submissionByRequest(conversationId, request),
                context,
            );

            assert.equal(existing, undefined, "the courier reserves before it submits");
            checked.push(request);
        }

        return reserve(conversationId, request, origins);
    };

    try {
        await post(app, first, "provenance-agent-a", "courier-a");
        await until(
            async () =>
                (await app.harness.snapshot(SubagentsDoc, id, context))?.agents["provenance-a"] !==
                    undefined && !app.isBusy(id),
            "the first subagent while the parent is idle",
        );
        await post(app, second, "provenance-agent-b", "courier-b");
        await until(
            async () =>
                Object.values(
                    (await app.harness.snapshot(HooksDoc, context))!.items[first.id]!.reply!
                        .requests!,
                ).some((receipt) => receipt.submissionRequest.startsWith("subagent-reports:")),
            "the first courier receipt",
            15_000,
        );
        await until(
            async () =>
                Object.values(
                    (await app.harness.snapshot(HooksDoc, context))!.items[second.id]!.reply!
                        .requests!,
                ).some((receipt) => receipt.submissionRequest.startsWith("subagent-reports:")),
            "the second courier receipt",
            15_000,
        );

        const firstRoot = (await roots(app, first))[0]!;
        const secondRoot = (await roots(app, second))[0]!;
        const firstDerived = Object.values(
            (await app.harness.snapshot(HooksDoc, context))!.items[first.id]!.reply!.requests!,
        ).find((receipt) => receipt.submissionRequest.startsWith("subagent-reports:"))!;
        const secondDerived = Object.values(
            (await app.harness.snapshot(HooksDoc, context))!.items[second.id]!.reply!.requests!,
        ).find((receipt) => receipt.submissionRequest.startsWith("subagent-reports:"))!;

        assert.ok(checked.length >= 2);
        assert.equal(firstDerived.root, firstRoot.key);
        assert.equal(secondDerived.root, secondRoot.key);
        assert.notEqual(
            firstDerived.submissionRequest,
            secondDerived.submissionRequest,
            "different root sets stay in different courier batches",
        );
        assert.equal(
            (await app.harness.snapshot(SubagentsDoc, id, context))?.outbox?.length ?? 0,
            0,
        );
    } finally {
        app.replies.reserve = reserve;
    }
});

test("an extension on an older core does not request reply origins", async () => {
    let origins = 0;
    let started = 0;
    const extension = createBackground(
        {
            background: {
                limits: { running: 1 },
                describe: () => "command",
                list: async () => [],
                start: async () => {
                    started++;

                    return { id: "old", pid: 1, cwd: "/tmp", status: "running", notify: false };
                },
            },
            requesterOf: () => undefined,
            replyOriginForTool: async () => {
                origins++;

                return [];
            },
        } as unknown as PocketHost,
        {
            settings: () => {},
            setting: () => 1,
            onSettings: () => {},
        } as never,
    );
    const tool = extension.tools![0]!;

    await tool.execute(
        { action: "start", command: "echo old core" } as never,
        { conversationId: 1, taskId: 2, callId: "old-core", memo: async () => undefined } as never,
        { abortSignal: new AbortController().signal } as never,
    );

    assert.equal(started, 1);
    assert.equal(origins, 0, "the protocol marker gates older live cores");
});
