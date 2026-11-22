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
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { withCancel } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { User } from "../src/server/config.ts";
import type { ApprovalRequest } from "../src/server/host.ts";
import type { PendingApproval, PendingApprovals, ResolvedApproval } from "../types/pocket.d.ts";

const SECRET = "private-token-never-observable";
const data = join(root, "data");
const model = scriptedModel((request) => {
    const { role, text } = lastText(request as never);

    if (role === "user" && text.endsWith("guard a call")) {
        return fauxAssistantMessage(
            [fauxToolCall("bash", { command: "printf approval-api-safe" })],
            { stopReason: "toolUse" },
        );
    }

    if (role === "user" && text.endsWith("ask in a helper")) {
        return fauxAssistantMessage(
            [
                fauxToolCall("subagent", {
                    action: "spawn",
                    name: "helper",
                    message: "guard a call",
                }),
            ],
            { stopReason: "toolUse" },
        );
    }

    return fauxAssistantMessage([fauxText(`echo: ${text}`)]);
});
let app: App;
let sequence = 0;

before(async () => {
    mkdirSync(join(data, "extensions"), { recursive: true });
    writeFileSync(
        join(data, "extensions", "monitor.ts"),
        `/** Test the public host surface and reconstruct guard waits on every server start. */
export default (host, web) => {
    host.guard.judge = async (tool, args) => tool === "bash" && args.command === "printf approval-api-safe"
        ? { subject: args.command, decision: { action: "ask", reason: "test guard" } }
        : undefined;
    web.route("GET", "facade", () => host.pendingApprovals);
};
`,
    );
    app = await openApp(model, data);
    await app.setExtensionEnabled(owner(app), "monitor.ts", true);
    await app.setExtensionEnabled(owner(app), "guard.ts", true);
});

after(async () => {
    await app?.close();
    cleanUp();
});

// Call the test drop-in's handler directly. It captures the facade that real extensions get, without HTTP serialization.
async function approvalApi(): Promise<PendingApprovals> {
    const matched = app.webs.match("monitor", "GET", ["facade"], owner(app));

    assert.ok(matched !== undefined && "route" in matched);
    const api = (await matched.route.handle({} as never)) as PendingApprovals | undefined;

    assert.ok(api, "the public host must have pendingApprovals");

    return api;
}

async function source(user: User = owner(app)): Promise<ConversationId> {
    const id = await newSession(app);
    const { submissionId } = await app.commands.submit(id, user, {
        text: "hello",
        requestId: crypto.randomUUID(),
    });

    await (await app.harness.submission(submissionId, context))!.wait(context);

    return id;
}

function ask(id: ConversationId, more: Partial<ApprovalRequest> = {}, waitContext = context) {
    const request: ApprovalRequest = {
        id: `observed-${++sequence}`,
        conversationId: id,
        taskId: sequence as never,
        tool: "bash",
        subject: `curl --token ${SECRET}`,
        reason: SECRET,
        createdAt: Date.now(),
        ...more,
    };

    return { request, answer: app.approvals.request(request, waitContext) };
}

const tick = () => new Promise<void>((done) => setImmediate(done));

test("list and created give immutable, redacted snapshots; decisions emit resolved once", async () => {
    const api = await approvalApi();
    const id = await source();
    const created: PendingApproval[] = [];
    const resolved: ResolvedApproval[] = [];
    const off = [
        api.on(id, "created", (value) => created.push(value)),
        api.on(id, "resolved", (value) => resolved.push(value)),
    ];

    assert.deepEqual(api.list(id), []);

    try {
        for (const allow of [true, false]) {
            const wait = ask(id);
            const snapshot = api.list(id);

            assert.equal(snapshot.length, 1);
            assert.deepEqual(snapshot[0], {
                id: wait.request.id,
                conversationId: id,
                session: id,
                createdAt: wait.request.createdAt,
                tool: "bash",
                summary: "Run a command (arguments redacted)",
                state: "pending",
            });
            assert.ok(Object.isFrozen(snapshot) && Object.isFrozen(snapshot[0]));
            assert.throws(() => Object.assign(snapshot[0]!, { summary: "changed" }), TypeError);
            assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(SECRET));
            await tick();
            assert.deepEqual(created.at(-1), snapshot[0]);
            assert.equal(await app.answerApproval(wait.request.id, allow, owner(app)), true);
            await wait.answer;
            await tick();
            assert.deepEqual(resolved.at(-1), {
                ...snapshot[0],
                state: "resolved",
                outcome: allow ? "allowed" : "denied",
            });
            assert.deepEqual(api.list(id), []);
            assert.equal(app.approvals.answer(wait.request.id, { allow, by: SECRET }), false);
        }

        assert.equal(created.length, 2);
        assert.equal(resolved.length, 2);
    } finally {
        off.forEach((dispose) => dispose());
    }
});

test("form contents, unknown tool names, and answer values are never observed", async () => {
    const api = await approvalApi();
    const id = await source();
    const seen: unknown[] = [];
    const off = api.on(id, "resolved", (value) => seen.push(value));
    const question = ask(id, {
        tool: SECRET,
        form: {
            title: SECRET,
            text: SECRET,
            submit: SECRET,
            fields: [{ name: "token", label: SECRET, secret: true, placeholder: SECRET }],
        },
    });

    seen.push(api.list(id));
    assert.equal(api.list(id)[0]?.tool, "ask");
    await app.answerApproval(question.request.id, true, owner(app), { token: SECRET });
    await question.answer;
    const tool = ask(id, { tool: SECRET });

    assert.equal(api.list(id)[0]?.tool, "tool");
    seen.push(api.list(id));
    app.approvals.answer(tool.request.id, { allow: false, by: SECRET });
    await tool.answer;
    await tick();
    assert.doesNotMatch(JSON.stringify(seen), new RegExp(SECRET));
    off();
});

test("supersession and cancellation resolve waits without granting permission", async () => {
    const api = await approvalApi();
    const id = await source();
    const outcomes: string[] = [];
    const off = api.on(id, "resolved", (value) => outcomes.push(value.outcome));
    const first = ask(id);
    const second = ask(id, { id: first.request.id });

    assert.deepEqual(await first.answer, { allow: false, by: "superseded" });
    app.approvals.answer(second.request.id, { allow: false, by: "a person" });
    await second.answer;
    const cancelled = withCancel(context);
    const third = ask(id, {}, cancelled.context);
    const rejected = assert.rejects(third.answer);

    cancelled.cancel(new Error("stopped"));
    await rejected;
    await tick();
    assert.deepEqual(outcomes, ["superseded", "denied", "cancelled"]);
    assert.deepEqual(api.list(id), []);
    off();
});

test("the requester and whole source audience must see a wait; PiP is excluded", async () => {
    const api = await approvalApi();
    const shared = await source();
    const privateSession = await source();
    const guest = app.config.addUser("Limited", "guest", [String(shared)]).user;
    const pip = await app.pip.ensure(owner(app));
    const seen: string[] = [];
    const off = api.on(shared, "created", (value) => seen.push(value.id));
    const visible = ask(shared);
    const hidden = ask(privateSession);
    const privatePip = ask(pip);

    try {
        await tick();
        assert.deepEqual(
            api.list(shared).map((value) => value.id),
            [visible.request.id],
        );
        assert.deepEqual(seen, [visible.request.id]);
        app.config.updateUser(guest.id, { sessions: [String(shared), String(privateSession)] });
        assert.deepEqual(
            api
                .list(shared)
                .map((value) => value.id)
                .sort(),
            [visible.request.id, hidden.request.id].sort(),
        );
        assert.throws(() => api.list(pip), { status: 403 });
        assert.throws(() => api.list(999999 as ConversationId), { status: 403 });
        const unknownRequester = await newSession(app);

        assert.throws(() => api.list(unknownRequester), { status: 403 });

        // A subscription's person is re-read, not a stale User object retained before access was removed.
        const limitedSource = await source();

        app.config.updateUser(guest.id, {
            sessions: [String(shared), String(privateSession), String(limitedSource)],
        });
        const { submissionId } = await app.commands.submit(
            limitedSource,
            app.config.userById(guest.id)!,
            {
                text: "hello as the requester",
                requestId: crypto.randomUUID(),
            },
        );

        await (await app.harness.submission(submissionId, context))!.wait(context);
        const revoked: string[] = [];
        const stop = api.on(limitedSource, "created", (value) => revoked.push(value.id));
        const queued = ask(privateSession);

        app.config.updateUser(guest.id, { sessions: [String(shared), String(privateSession)] });
        await tick();
        assert.deepEqual(revoked, []);
        assert.throws(() => api.list(limitedSource), { status: 404 });
        stop();
        app.approvals.answer(queued.request.id, { allow: false, by: "cleanup" });
        await queued.answer;
    } finally {
        off();
        app.config.removeUser(guest.id);

        for (const wait of [visible, hidden, privatePip]) {
            app.approvals.answer(wait.request.id, { allow: false, by: "cleanup" });
            await wait.answer;
        }
    }
});

test("listeners are isolated from decisions and one another, and disposal stops queued delivery", async () => {
    const api = await approvalApi();
    const id = await source();
    const seen: string[] = [];
    const off = [
        api.on(id, "created", () => {
            throw new Error(SECRET);
        }),
        api.on(id, "created", async () => {
            throw new Error(SECRET);
        }),
        api.on(id, "created", (value) => seen.push(value.id)),
    ];
    const wait = ask(id);

    app.approvals.answer(wait.request.id, { allow: false, by: "a person" });
    await wait.answer;
    await tick();
    assert.deepEqual(seen, [wait.request.id]);
    off.forEach((dispose) => dispose());
    const stop = api.on(id, "created", (value) => seen.push(value.id));
    const cancelledDelivery = ask(id);

    stop();
    await tick();
    assert.deepEqual(seen, [wait.request.id]);
    app.approvals.answer(cancelledDelivery.request.id, { allow: false, by: "cleanup" });
    await cancelledDelivery.answer;
});

test("the public approval facade has no decision or mutation methods", async () => {
    const api = await approvalApi();

    assert.deepEqual(Object.keys(api).sort(), ["list", "on"]);
    assert.equal(Object.isFrozen(api), true);
    assert.equal("answer" in api || "approve" in api || "deny" in api || "request" in api, false);
});

test("a subagent's approval belongs to its top-level session and follows that session's audience", async () => {
    const api = await approvalApi();
    const id = await source();

    await loadTools(app, id, "subagent", "bash");
    await app.commands.submit(id, owner(app), {
        text: "ask in a helper",
        requestId: crypto.randomUUID(),
    });
    await until(
        () => app.approvals.all().some((request) => app.rootOf(request.conversationId) === id),
        "helper approval",
    );
    const wait = api.list(id).find((value) => value.session === id)!;

    assert.ok(wait);
    assert.notEqual(wait.conversationId, id);
    assert.equal(wait.session, id);
    const shared = await source();
    const invited = app.config.addUser("Shared source only", "viewer", [String(shared)]).user;

    try {
        assert.equal(
            api.list(shared).some((value) => value.id === wait.id),
            false,
        );
        app.config.updateUser(invited.id, { sessions: [String(shared), String(id)] });
        assert.equal(
            api.list(shared).some((value) => value.id === wait.id),
            true,
        );
    } finally {
        app.config.removeUser(invited.id);
        await app.answerApproval(wait.id, false, owner(app));
        await until(
            () => !app.busyConversations().includes(wait.conversationId),
            "helper to stop waiting",
        );
        await until(() => !app.busyConversations().includes(id), "helper report");
    }
});

test("a pending guard wait returns after a server restart with the same id and creation time", async () => {
    const initial = await approvalApi();
    const id = await source();

    await loadTools(app, id, "bash");
    assert.equal(app.guardOn(), true);
    assert.equal(
        (await app.guard.judge("bash", { command: "printf approval-api-safe" }, "/tmp"))?.decision
            .action,
        "ask",
    );
    await app.commands.submit(id, owner(app), {
        text: "guard a call",
        requestId: crypto.randomUUID(),
    });
    await until(() => app.approvals.forConversation(id).length === 1, "guard approval");
    const before = initial.list(id).find((value) => value.conversationId === id)!;

    assert.ok(before);
    await app.close();
    app = await openApp(model, data);
    const api = await approvalApi();

    await until(() => api.list(id).some((value) => value.id === before.id), "restored approval");
    assert.deepEqual(
        api.list(id).find((value) => value.id === before.id),
        before,
    );
    assert.equal(await app.answerApproval(before.id, true, owner(app)), true);
    await until(() => !app.busyConversations().includes(id), "resumed run to finish");
    assert.equal(
        api.list(id).some((value) => value.id === before.id),
        false,
    );
    await app.close();
    app = await openApp(model, data);
    assert.equal(
        (await approvalApi()).list(id).some((value) => value.id === before.id),
        false,
    );
});
