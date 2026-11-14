import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import {
    cleanUp,
    context,
    type App,
    modelTexts,
    openApp,
    owner,
    scriptedModel,
    work,
} from "./helpers.ts";
import { HooksDoc } from "../src/server/docs.ts";

let app: App;

before(async () => {
    app = await openApp(scriptedModel());
});

after(async () => {
    await app?.close();
    cleanUp();
});

/** Provisioning returns a public numeric id. Agent and transcript APIs use Pi Durable's branded core id. */
const coreConversationId = (id: number): ConversationId => id as ConversationId;

const input = {
    operation: "onboard_user_1",
    cwd: work,
    model: "faux/faux-1",
    thinking: "off" as const,
    replyUrl: "http://127.0.0.1:8788/v1/reply",
};

test("reply-session provisioning returns one private hook for an unchanged operation", async () => {
    const first = await app.hooks.provisionReplySession(owner(app), "ai-chat-users", input);
    const again = await app.hooks.provisionReplySession(owner(app), "ai-chat-users", input);

    assert.equal(again.sessionId, first.sessionId);
    assert.deepEqual(again.hook, first.hook);
    assert.match(first.hook.path, /^\/hook\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/);
    assert.ok(first.hook.replySecret.length >= 32);
    const sessionId = coreConversationId(first.sessionId);

    assert.deepEqual((await app.agentState(sessionId))?.model, {
        provider: "faux",
        modelId: "faux-1",
    });
    assert.equal((await app.agentState(sessionId))?.thinkingLevel, "off");
    assert.deepEqual(await modelTexts(app, sessionId), []);
    const stored = (await app.harness.snapshot(HooksDoc, context))!.items[first.hook.id]!;

    assert.notEqual(stored.secret, stored.reply!.secret);
    const view = (await app.hooks.list(owner(app))).find((item) => item.id === first.hook.id)!;

    assert.equal(view.managedReply, true);
    assert.equal(view.path, `/hook/${first.hook.id}`);
    assert.equal("secret" in view, false);
    assert.equal("reply" in view, false);
    assert.equal("replySecret" in view, false);
});

test("ordinary Hooks.add views retain their reply credential", async () => {
    const { id } = await app.commands.createSession(owner(app), { cwd: work });
    const ordinary = await app.hooks.add(owner(app), id, {
        name: "Ordinary reply",
        replyUrl: "http://127.0.0.1:8788/v1/reply",
    });

    assert.equal("managedReply" in ordinary && ordinary.managedReply === true, false);
    assert.ok("reply" in ordinary);

    if ("reply" in ordinary) {
        assert.equal(ordinary.reply?.url, "http://127.0.0.1:8788/v1/reply");
        assert.ok(ordinary.reply?.secret.length >= 32);
    }

    await app.harness.commit(async (tx) => {
        const hook = (await tx.doc(HooksDoc)).items[ordinary.id]!;

        hook.reply!.requests = {
            receipt: {
                request: "external-request",
                submissionRequest: "owner:submission",
                pending: {
                    entry: "entry-1",
                    text: "private pending answer",
                    attempts: 1,
                    nextAt: 1,
                },
            },
        };
        hook.reply!.asked = true;
        hook.reply!.sent = "entry-1";
        hook.reply!.pending = {
            entry: "entry-1",
            text: "private pending answer",
            attempts: 1,
            nextAt: 1,
        };
    }, context);

    const ordinaryView = (await app.hooks.list(owner(app))).find(
        (hook) => hook.id === ordinary.id,
    )!;

    assert.deepEqual(ordinaryView.reply, {
        url: "http://127.0.0.1:8788/v1/reply",
        secret: ordinary.reply!.secret,
    });
    assert.equal("requests" in ordinaryView.reply!, false);
    assert.equal("asked" in ordinaryView.reply!, false);
    assert.equal("sent" in ordinaryView.reply!, false);
    assert.equal("pending" in ordinaryView.reply!, false);
});

test("reply-session provisioning refuses changed input for an operation", async () => {
    const operation = { ...input, operation: "onboard_user_2" };

    await app.hooks.provisionReplySession(owner(app), "ai-chat-users", operation);
    await assert.rejects(
        app.hooks.provisionReplySession(owner(app), "ai-chat-users", {
            ...operation,
            cwd: `${work}/other`,
        }),
        /different inputs/,
    );
});
