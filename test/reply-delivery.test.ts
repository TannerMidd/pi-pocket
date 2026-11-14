// Reply hooks, end to end: a post to a hook with a reply address gets its answer back, signed; a failed send is kept and
// sent again with the same entry; an answer to a person's own message, which no hook asked for, is not sent; and an
// answer is never sent twice.
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { createHandler } from "../src/server/http.ts";
import { HooksDoc } from "../src/server/docs.ts";
import { verifyReply } from "../src/server/reply-hooks.ts";
import {
    type App,
    cleanUp,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";

type Received = { body: string; hook: string; ok: boolean };

let app: App;
let model: ReturnType<typeof scriptedModel>;
let pocket: Server;
let pocketBase: string;
let receiver: Server;
let receiverUrl: string;
/** What the receiver answers: 200 when true, 500 when false. */
let accepting = true;
const received: Received[] = [];

function readBody(request: IncomingMessage): Promise<string> {
    return new Promise((resolve) => {
        const chunks: Buffer[] = [];

        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
}

/** The fake bridge: records each reply and checks its signature with the hook's reply secret. */
let replySecret = "";

before(async () => {
    model = scriptedModel();
    app = await openApp(model, join(root, "reply-data"));
    receiver = createServer(async (request: IncomingMessage, response: ServerResponse) => {
        const body = await readBody(request);
        const timestamp = Number(request.headers["x-pocket-timestamp"]);
        const signature = String(request.headers["x-pocket-signature"] ?? "");
        const ok = verifyReply(replySecret, timestamp, body, signature, Date.now());

        received.push({ body, hook: String(request.headers["x-pocket-hook"]), ok });
        response.writeHead(accepting ? 200 : 500);
        response.end();
    });
    await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
    receiverUrl = `http://127.0.0.1:${(receiver.address() as { port: number }).port}/v1/reply`;

    pocket = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => pocket.listen(0, "127.0.0.1", resolve));
    pocketBase = `http://127.0.0.1:${(pocket.address() as { port: number }).port}`;
});

after(async () => {
    pocket?.close();
    receiver?.close();
    await app?.close();
    cleanUp();
});

/** Makes a session with a reply hook. Returns its id and the hook's address and reply secret. */
async function hookedSession(name: string) {
    const id = await newSession(app);
    const view = await app.commands.addHook(owner(app), {
        target: Number(id),
        name,
        replyUrl: receiverUrl,
    });

    replySecret = (view as unknown as { reply: { secret: string } }).reply.secret;

    return { id: id as ConversationId, path: view.path, hook: view.id };
}

/** Posts to a hook's address, as an outside service does. */
async function post(path: string, text: string, key = text, followUp = false): Promise<number> {
    const response = await fetch(`${pocketBase}${path}`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "idempotency-key": key,
            ...(followUp ? { "x-pocket-reply-protocol": "2" } : {}),
        },
        body: JSON.stringify({ text }),
    });

    await response.body?.cancel();

    return response.status;
}

test("a post's answer goes to the reply address, signed, once", async () => {
    const { id, path, hook } = await hookedSession("Chat");
    const before = received.length;

    assert.equal(await post(path, "hello from the chat"), 202);
    await until(() => received.length > before, "the reply arrives");

    const reply = received[before]!;

    assert.equal(reply.ok, true, "the signature checks");
    assert.equal(reply.hook, hook);
    const payload = JSON.parse(reply.body) as {
        request: string;
        session: number;
        entry: string;
        text: string;
        truncated: boolean;
    };

    assert.equal(payload.request, "hello from the chat");
    assert.equal(payload.session, Number(id));
    assert.ok(payload.entry.length > 0);
    assert.match(payload.text, /hello from the chat/);
    assert.equal(payload.truncated, false);

    // The same answer is never sent again, however often the sweep runs.
    await app.replies.sweep();
    await app.replies.sweep();
    assert.equal(received.length, before + 1);
});

test("a failed send is kept and sent again with the same entry", async () => {
    const { id, path } = await hookedSession("Flaky");
    const before = received.length;

    accepting = false;

    assert.equal(await post(path, "first try"), 202);
    await until(() => received.length > before, "the first attempt");
    assert.equal(received[before]!.ok, true);

    // The receiver refused: the answer stays pending.
    const stored = Object.values(
        (await app.harness.snapshot(HooksDoc, BACKGROUND_CONTEXT))?.items ?? {},
    );

    assert.ok(
        stored.some((item) =>
            Object.values(item.reply?.requests ?? {}).some(
                (receipt) => receipt.pending !== undefined,
            ),
        ),
        "the answer is kept",
    );

    accepting = true;
    // Make the pending reply due at once instead of waiting for its backoff.
    await app.harness.commit(async (tx) => {
        for (const item of Object.values((await tx.doc(HooksDoc)).items)) {
            if (item.target === Number(id)) {
                for (const receipt of Object.values(item.reply?.requests ?? {})) {
                    if (receipt.pending !== undefined) {
                        receipt.pending.nextAt = 0;
                    }
                }
            }
        }
    }, BACKGROUND_CONTEXT);

    await app.replies.sweep();
    await until(() => received.length > before + 1, "the retry");
    assert.equal(received[before + 1]!.body, received[before]!.body, "the same payload again");
    assert.equal(received[before + 1]!.ok, true);
});

test("an answer to a person's own message, which no hook asked for, is not sent", async () => {
    const id = await newSession(app);

    await app.commands.addHook(owner(app), {
        target: Number(id),
        name: "Quiet",
        replyUrl: receiverUrl,
    });
    const before = received.length;

    await say(app, id, "a message typed in the app");
    await new Promise((resolve) => setTimeout(resolve, 300));
    await app.replies.sweep();

    assert.equal(received.length, before, "nothing was sent for it");
});

test("follow-up capability is fresh-only and does not upgrade a duplicate receipt", async () => {
    const { path, hook } = await hookedSession("Capability");
    const before = received.length;

    assert.equal(await post(path, "legacy capability", "legacy-capability"), 202);
    await until(() => received.length > before, "the legacy reply");
    const duplicate = await post(path, "legacy capability", "legacy-capability", true);

    assert.ok(duplicate === 200 || duplicate === 202);
    assert.equal(await post(path, "new capability", "new-capability", true), 202);
    await until(() => received.length > before + 1, "the capable reply");
    const receipts = Object.values(
        (await app.harness.snapshot(HooksDoc, BACKGROUND_CONTEXT))!.items[hook]!.reply!.requests!,
    );

    assert.equal(
        receipts.find((receipt) => receipt.request === "legacy-capability")!.followUp,
        undefined,
    );
    assert.equal(receipts.find((receipt) => receipt.request === "new-capability")!.followUp, true);
});

test("a run can finish before submit returns without losing its reply", async () => {
    const { path } = await hookedSession("Fast");
    const before = received.length;
    const submit = app.commands.submit.bind(app.commands);

    app.commands.submit = async (...args) => {
        const result = await submit(...args);

        await until(() => received.length > before, "reply before submit returns");

        return result;
    };

    try {
        assert.equal(await post(path, "fast completion", "fast-key"), 202);
        assert.equal(JSON.parse(received[before]!.body).request, "fast-key");
    } finally {
        app.commands.submit = submit;
    }
});

test("a receipt saved before failed admission retries with the same durable request", async () => {
    const { path, hook } = await hookedSession("Admission");
    const submit = app.commands.submit.bind(app.commands);

    app.commands.submit = async () => {
        throw new Error("simulated failure before admission");
    };

    try {
        assert.equal(await post(path, "retry admission", "admission-key"), 409);
    } finally {
        app.commands.submit = submit;
    }

    const item = (await app.harness.snapshot(HooksDoc, BACKGROUND_CONTEXT))!.items[hook]!;
    const requestId = Object.values(item.reply!.requests!)[0]!.submissionRequest;
    const before = received.length;

    assert.equal(await post(path, "retry admission", "admission-key"), 202);
    await until(() => received.length > before, "answer after admission retry");
    const stored = (await app.harness.snapshot(HooksDoc, BACKGROUND_CONTEXT))!.items[hook]!;

    assert.equal(Object.keys(stored.reply!.requests!).length, 1);
    assert.equal(Object.values(stored.reply!.requests!)[0]!.submissionRequest, requestId);
});

test("concurrent duplicate posts create only one durable submission and receipt", async () => {
    const { path, hook, id } = await hookedSession("Concurrent");
    const before = received.length;
    const statuses = await Promise.all([
        post(path, "same post", "concurrent-key"),
        post(path, "same post", "concurrent-key"),
    ]);

    assert.ok(statuses.every((status) => status === 200 || status === 202));
    await until(() => received.length > before, "one concurrent answer");
    const item = (await app.harness.snapshot(HooksDoc, BACKGROUND_CONTEXT))!.items[hook]!;
    const receipts = Object.values(item.reply!.requests!);

    assert.equal(receipts.length, 1);
    const submission = await app.harness.commit(
        (tx) => tx.submissionByRequest(id, receipts[0]!.submissionRequest),
        BACKGROUND_CONTEXT,
    );

    assert.equal(submission!.status, "done");
    await app.replies.sweep();
    assert.equal(received.length, before + 1);
});

test("a duplicate post never creates a new reply receipt", async () => {
    const { path, hook } = await hookedSession("Duplicate");
    const before = received.length;

    assert.equal(await post(path, "one post", "same-delivery"), 202);
    await until(() => received.length > before, "the correlated answer");
    assert.equal(JSON.parse(received[before]!.body).request, "same-delivery");
    assert.equal(await post(path, "one post", "same-delivery"), 200);
    await app.replies.sweep();
    assert.equal(received.length, before + 1);
    const item = (await app.harness.snapshot(HooksDoc, BACKGROUND_CONTEXT))!.items[hook]!;

    assert.equal(Object.keys(item.reply!.requests!).length, 1);
    const view = (await app.hooks.list(owner(app))).find((item) => item.id === hook)!;

    assert.equal("requests" in view.reply!, false, "operational data stays private");
});

test("multiple posts retain separate receipts while an older reply waits", async () => {
    const { id, path, hook } = await hookedSession("Separate");

    accepting = false;
    const before = received.length;

    assert.equal(await post(path, "first payload", "first-key"), 202);
    await until(() => received.length > before, "first delivery attempt");
    assert.equal(await post(path, "second payload", "second-key"), 202);
    await until(
        () => received.some((item) => JSON.parse(item.body).request === "second-key"),
        "second delivery attempt",
    );
    await say(app, id, "unrelated private words");

    const items = (await app.harness.snapshot(HooksDoc, BACKGROUND_CONTEXT))!.items;
    const receipts = Object.values(items[hook]!.reply!.requests!);

    assert.equal(receipts.length, 2);
    assert.match(
        receipts.find((item) => item.request === "first-key")!.pending!.text,
        /first payload/,
    );
    assert.match(
        receipts.find((item) => item.request === "second-key")!.pending!.text,
        /second payload/,
    );
    assert.equal(
        receipts.some((item) => item.pending!.text.includes("unrelated private words")),
        false,
    );
    accepting = true;

    await app.harness.commit(async (tx) => {
        for (const receipt of Object.values(
            (await tx.doc(HooksDoc)).items[hook]!.reply!.requests!,
        )) {
            receipt.pending!.nextAt = 0;
        }
    }, BACKGROUND_CONTEXT);
    await app.replies.sweep();
});

test("restart recovers a completed submission even when its completion event was missed", async () => {
    const { id, path, hook } = await hookedSession("Restart");
    const before = received.length;

    assert.equal(await post(path, "persisted answer", "restart-key"), 202);
    await until(() => received.length > before, "initial answer");

    await say(app, id, "a newer unrelated answer");
    // Recreate the durable state before collection, with a newer unrelated answer in the session.
    await app.harness.commit(async (tx) => {
        const receipt = Object.values((await tx.doc(HooksDoc)).items[hook]!.reply!.requests!)[0]!;

        delete receipt.done;
        delete receipt.pending;
    }, BACKGROUND_CONTEXT);
    await new Promise<void>((resolve) => pocket.close(() => resolve()));
    await app.close();
    const start = received.length;

    model = scriptedModel();
    app = await openApp(model, join(root, "reply-data"));
    pocket = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => pocket.listen(0, "127.0.0.1", resolve));
    pocketBase = `http://127.0.0.1:${(pocket.address() as { port: number }).port}`;
    await app.replies.sweep();
    await until(() => received.length > start, "answer recovered on restart");
    const payload = JSON.parse(received[start]!.body);

    assert.equal(payload.request, "restart-key");
    assert.match(payload.text, /persisted answer/);
    assert.doesNotMatch(payload.text, /a newer unrelated answer/);
});

test("derived receipts follow the root receipt capacity policy", async () => {
    const { id, hook } = await hookedSession("Derived capacity");
    const origin = [
        { hookId: hook, key: "root", request: "root-request", followUp: true as const },
    ];

    await app.harness.commit(async (tx) => {
        (await tx.doc(HooksDoc)).items[hook]!.reply!.requests = Object.fromEntries(
            Array.from({ length: 1000 }, (_, index) => [
                `busy-${index}`,
                {
                    request: `busy-request-${index}`,
                    submissionRequest: `busy-submission-${index}`,
                },
            ]),
        );
    }, BACKGROUND_CONTEXT);
    await app.replies.reserve(id, "capacity-source", origin);
    let receipts = (await app.harness.snapshot(HooksDoc, BACKGROUND_CONTEXT))!.items[hook]!.reply!
        .requests!;

    assert.equal(Object.keys(receipts).length, 1000, "unfinished receipts keep the cap");
    assert.equal(
        Object.values(receipts).some((receipt) => receipt.submissionRequest === "capacity-source"),
        false,
    );

    await app.harness.commit(async (tx) => {
        (await tx.doc(HooksDoc)).items[hook]!.reply!.requests!["busy-0"]!.done = true;
    }, BACKGROUND_CONTEXT);
    await app.replies.reserve(id, "capacity-source", origin);
    receipts = (await app.harness.snapshot(HooksDoc, BACKGROUND_CONTEXT))!.items[hook]!.reply!
        .requests!;

    assert.equal(Object.keys(receipts).length, 1000, "a completed receipt gives one place back");
    assert.equal(
        Object.values(receipts).some((receipt) => receipt.submissionRequest === "capacity-source"),
        true,
    );
});

test("a derived receipt keeps its original request and sends protocol 2", async () => {
    const { id, path, hook } = await hookedSession("Follow-up");
    const before = received.length;

    assert.equal(await post(path, "root work", "root-request", true), 202);
    await until(() => received.length > before, "the root reply");
    const root = (await app.harness.snapshot(HooksDoc, BACKGROUND_CONTEXT))!.items[hook]!;
    const [rootKey, rootReceipt] = Object.entries(root.reply!.requests!)[0]!;
    const requestId = "test-derived-follow-up";

    await app.replies.reserve(id, requestId, [
        {
            hookId: hook,
            key: rootKey,
            request: rootReceipt.request,
            followUp: true,
        },
    ]);
    const conversation = (await app.harness.conversation(id, BACKGROUND_CONTEXT))!;
    const submission = await conversation.submit(
        {
            type: "input",
            content: "later result",
            whenBusy: "followUp",
            requestId,
        },
        BACKGROUND_CONTEXT,
    );

    await submission.wait(BACKGROUND_CONTEXT);
    await app.replies.sweep();
    await until(() => received.length > before + 1, "the derived reply");
    const payload = JSON.parse(received[before + 1]!.body);

    assert.equal(payload.request, "root-request");
    assert.equal(payload.protocol, 2);
    assert.ok(payload.entry.length > 0);
    assert.match(payload.text, /later result/);
    assert.equal(JSON.parse(received[before]!.body).protocol, undefined, "root stays legacy");
});

test("a derived source sends one receipt for each retained root", async () => {
    const { id, path, hook } = await hookedSession("Many roots");
    const before = received.length;

    assert.equal(await post(path, "first root", "many-first", true), 202);
    await until(() => received.length > before, "the first root reply");
    assert.equal(await post(path, "second root", "many-second", true), 202);
    await until(() => received.length > before + 1, "the second root reply");
    const receipts = Object.entries(
        (await app.harness.snapshot(HooksDoc, BACKGROUND_CONTEXT))!.items[hook]!.reply!.requests!,
    );
    const origins = receipts
        .filter(
            ([, receipt]) => receipt.request === "many-first" || receipt.request === "many-second",
        )
        .map(([key, receipt]) => ({
            hookId: hook,
            key,
            request: receipt.request,
            followUp: true as const,
        }));

    await app.replies.reserve(id, "many-derived", origins);
    const conversation = (await app.harness.conversation(id, BACKGROUND_CONTEXT))!;
    const submission = await conversation.submit(
        {
            type: "input",
            content: "shared derived result",
            whenBusy: "followUp",
            requestId: "many-derived",
        },
        BACKGROUND_CONTEXT,
    );

    await submission.wait(BACKGROUND_CONTEXT);
    await app.replies.sweep();
    await until(() => received.length > before + 3, "both derived receipts");
    const derived = received.slice(before + 2, before + 4).map((item) => JSON.parse(item.body));

    assert.deepEqual(derived.map((item) => item.request).sort(), ["many-first", "many-second"]);
    assert.ok(derived.every((item) => item.protocol === 2));
    assert.equal(derived[0]!.entry, derived[1]!.entry, "one terminal entry serves both roots");
});

test("a later derived receipt waits for an earlier receipt", async () => {
    const { id, path, hook } = await hookedSession("Ordered follow-up");
    const before = received.length;

    assert.equal(await post(path, "ordered root", "ordered-root", true), 202);
    await until(() => received.length > before, "the root reply");
    const root = (await app.harness.snapshot(HooksDoc, BACKGROUND_CONTEXT))!.items[hook]!;
    const [rootKey, rootReceipt] = Object.entries(root.reply!.requests!)[0]!;
    const origins = [
        { hookId: hook, key: rootKey, request: rootReceipt.request, followUp: true as const },
    ];

    await app.replies.reserve(id, "ordered-first", origins);
    await app.replies.reserve(id, "ordered-second", origins);
    const conversation = (await app.harness.conversation(id, BACKGROUND_CONTEXT))!;
    const second = await conversation.submit(
        {
            type: "input",
            content: "second derived result",
            whenBusy: "followUp",
            requestId: "ordered-second",
        },
        BACKGROUND_CONTEXT,
    );

    await second.wait(BACKGROUND_CONTEXT);
    await app.replies.sweep();
    assert.equal(received.length, before + 1, "the later receipt waits");

    const first = await conversation.submit(
        {
            type: "input",
            content: "first derived result",
            whenBusy: "followUp",
            requestId: "ordered-first",
        },
        BACKGROUND_CONTEXT,
    );

    await first.wait(BACKGROUND_CONTEXT);
    await app.replies.sweep();
    await until(() => received.length > before + 2, "both ordered replies");
    assert.match(JSON.parse(received[before + 1]!.body).text, /first derived result/);
    assert.match(JSON.parse(received[before + 2]!.body).text, /second derived result/);
});

test("an aborted submission ends its receipt with a fixed notice and no private error", async () => {
    model.setResponses(
        Array.from({ length: 10 }, () =>
            fauxAssistantMessage("private provider text", {
                stopReason: "aborted",
                errorMessage: "private provider error",
            }),
        ),
    );
    const { path, hook } = await hookedSession("Aborted");
    const before = received.length;

    assert.equal(await post(path, "abort test", "abort-key"), 202);
    await until(() => received.length > before, "terminal failure notice");
    const payload = JSON.parse(received[before]!.body);

    assert.equal(payload.request, "abort-key");
    assert.equal(payload.text, "[Pi could not answer this message. Try again later.]");
    await until(async () => {
        const item = (await app.harness.snapshot(HooksDoc, BACKGROUND_CONTEXT))!.items[hook]!;

        return Object.values(item.reply!.requests!)[0]!.done === true;
    }, "receipt is terminal");
});

test("a reply address that is not https or this machine is refused when the hook is made", async () => {
    const id = await newSession(app);

    await assert.rejects(
        app.commands.addHook(owner(app), {
            target: Number(id),
            name: "Bad",
            replyUrl: "http://example.com/x",
        }),
        (error: unknown) => (error as { status?: number }).status === 400,
    );
});
