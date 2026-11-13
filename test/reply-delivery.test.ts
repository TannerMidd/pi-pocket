// Reply hooks, end to end: a post to a hook with a reply address gets its answer back, signed; a failed send is kept and
// sent again with the same entry; an answer to a person's own message, which no hook asked for, is not sent; and an
// answer is never sent twice.
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
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
    app = await openApp(scriptedModel(), join(root, "reply-data"));
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
async function post(path: string, text: string): Promise<number> {
    const response = await fetch(`${pocketBase}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
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
    const payload = JSON.parse(reply.body) as { session: number; entry: string; text: string; truncated: boolean };
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
    const stored = Object.values((await app.harness.snapshot(HooksDoc, BACKGROUND_CONTEXT))?.items ?? {});
    assert.ok(stored.some((item) => item.reply?.pending !== undefined), "the answer is kept");

    accepting = true;
    // Make the pending reply due at once instead of waiting for its backoff.
    await app.harness.commit(async (tx) => {
        for (const item of Object.values((await tx.doc(HooksDoc)).items)) {
            if (item.target === Number(id) && item.reply?.pending !== undefined) {
                item.reply.pending.nextAt = 0;
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
