import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import { createHandler } from "../src/server/http.ts";
import { ReplyHookProvisionsDoc } from "../src/server/docs.ts";
import { verifyReply } from "../src/server/reply-hooks.ts";
import {
    cleanUp,
    context,
    type App,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
    work,
} from "./helpers.ts";

type ReceiverCall = { body: string; hook: string; signatureValid: boolean };

type Closeable = Pick<Server, "close">;

const close = (server: Closeable): Promise<void> =>
    new Promise((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
    );

const provisionInput = (operation: string, replyUrl: string) => ({
    operation,
    cwd: work,
    model: "faux/faux-1",
    thinking: "off" as const,
    replyUrl,
});

const readBody = (request: IncomingMessage): Promise<string> =>
    new Promise((resolve) => {
        const chunks: Buffer[] = [];

        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });

async function temporaryApp(name: string): Promise<App> {
    return openApp(scriptedModel(), join(root, name));
}

after(cleanUp);

test("concurrent identical provisioning creates one session, hook, and receipt", async () => {
    const app = await temporaryApp("reply-provision-concurrent");
    const input = provisionInput("same-operation", "http://127.0.0.1:18787/v1/reply");

    try {
        const [first, second] = await Promise.all([
            app.hooks.provisionReplySession(owner(app), "ai-chat-users", input),
            app.hooks.provisionReplySession(owner(app), "ai-chat-users", input),
        ]);

        assert.equal(second.sessionId, first.sessionId);
        assert.equal(second.hook.id, first.hook.id);
        assert.equal(
            (await app.sessions(owner(app))).filter((session) => session.id === first.sessionId)
                .length,
            1,
        );
        assert.equal(
            (await app.hooks.list(owner(app))).filter((hook) => hook.id === first.hook.id).length,
            1,
        );

        const receipts = (await app.harness.snapshot(ReplyHookProvisionsDoc, context))!.items;
        const matching = Object.values(receipts).filter(
            (receipt) =>
                receipt.owner === owner(app).id &&
                receipt.module === "ai-chat-users" &&
                receipt.operation === input.operation,
        );

        assert.equal(matching.length, 1);
        assert.equal(matching[0]!.sessionId, first.sessionId);
        assert.equal(matching[0]!.hookId, first.hook.id);

        // Existing immutable receipts do not depend on current model availability.
        const models = app.models as { getAvailableSnapshot(): readonly unknown[] };
        const available = models.getAvailableSnapshot;

        models.getAvailableSnapshot = () => [];

        try {
            const recovered = await app.hooks.provisionReplySession(
                owner(app),
                "ai-chat-users",
                input,
            );

            assert.equal(recovered.sessionId, first.sessionId);
            assert.equal(recovered.hook.id, first.hook.id);
        } finally {
            models.getAvailableSnapshot = available;
        }
    } finally {
        await app.close();
    }
});

test("a guest cannot provision a session or hook", async () => {
    const app = await temporaryApp("reply-provision-guest");
    const guest = app.config.addUser("Guest", "guest").user;
    const beforeSessions = app.sessions(owner(app)).length;
    const beforeHooks = (await app.hooks.list(owner(app))).length;

    try {
        await assert.rejects(
            app.hooks.provisionReplySession(
                guest,
                "ai-chat-users",
                provisionInput("guest-operation", "http://127.0.0.1:18787/v1/reply"),
            ),
            /Only the owner/,
        );
        assert.equal(app.sessions(owner(app)).length, beforeSessions);
        assert.equal((await app.hooks.list(owner(app))).length, beforeHooks);
    } finally {
        await app.close();
    }
});

test("a capable root post to a provisioned hook returns a canonical legacy callback", async () => {
    const app = await temporaryApp("reply-provision-delivery");
    const received: ReceiverCall[] = [];
    let replySecret = "";
    const receiver = createServer(async (request: IncomingMessage, response: ServerResponse) => {
        const body = await readBody(request);
        const timestamp = Number(request.headers["x-pocket-timestamp"]);
        const signature = String(request.headers["x-pocket-signature"] ?? "");

        received.push({
            body,
            hook: String(request.headers["x-pocket-hook"] ?? ""),
            signatureValid: verifyReply(replySecret, timestamp, body, signature, Date.now()),
        });
        response.writeHead(200);
        response.end();
    });
    let pocket: Server | undefined;

    try {
        await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
        const receiverUrl = `http://127.0.0.1:${(receiver.address() as { port: number }).port}/v1/reply`;
        const provisioned = await app.hooks.provisionReplySession(
            owner(app),
            "ai-chat-users",
            provisionInput("capable-root", receiverUrl),
        );

        replySecret = provisioned.hook.replySecret;
        pocket = createServer(
            createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
        );
        await new Promise<void>((resolve) => pocket!.listen(0, "127.0.0.1", resolve));
        const base = `http://127.0.0.1:${(pocket.address() as { port: number }).port}`;

        const posted = await fetch(`${base}${provisioned.hook.path}`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "idempotency-key": "capable-root-delivery",
                "x-pocket-reply-protocol": "2",
            },
            body: JSON.stringify({ text: "reply through the managed hook" }),
        });

        await posted.body?.cancel();
        assert.equal(
            posted.status,
            202,
            "the authenticated capable root must be admitted before reply delivery",
        );
        await until(() => received.length === 1, "the canonical reply callback");

        const callback = received[0]!;
        const payload = JSON.parse(callback.body) as {
            hook: string;
            request: string;
            session: number;
            entry: string;
            text: string;
            protocol?: number;
        };

        assert.equal(callback.signatureValid, true);
        assert.equal(callback.hook, provisioned.hook.id);
        assert.equal(payload.hook, provisioned.hook.id);
        assert.equal(payload.request, "capable-root-delivery");
        assert.equal(payload.session, provisioned.sessionId);
        assert.ok(payload.entry.length > 0);
        assert.match(payload.text, /reply through the managed hook/);
        assert.equal(
            "protocol" in payload,
            false,
            "the root callback remains canonical protocol 1",
        );
    } finally {
        if (pocket !== undefined) {
            await close(pocket);
        }

        await close(receiver);
        await app.close();
    }
});
