import {
    type App,
    cleanUp,
    context,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { AgentDoc, UsageDoc, type ConversationId } from "@earendil-works/pi-durable";
import type { Usage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { SessionsDoc, SubagentsDoc } from "../src/server/docs.ts";
import { createHandler } from "../src/server/http.ts";
import type { ConversationUsage, ConversationWebRequest } from "../src/server/host.ts";

let app: App;
let server: Server;
let base = "";
const seen = globalThis as unknown as {
    usageRequest?: ConversationWebRequest;
    usageGate?: Promise<void>;
};
const zero = {
    requests: 0,
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    cost: 0,
    lastPrompt: 0,
};

before(async () => {
    const data = join(root, "data");
    const extensions = join(data, "extensions");

    mkdirSync(extensions, { recursive: true });
    writeFileSync(
        join(extensions, "usage.ts"),
        `/** Usage test routes. */
export default (_host, web) => {
    web.conversationRoute("GET", "source/:source", async req => {
        globalThis.usageRequest = req;
        await globalThis.usageGate;
        return req.conversationUsage(req.query.has("target") ? Number(req.query.get("target")) : undefined);
    }, { conversation: "source", access: "view" });
};
`,
    );
    app = await openApp(scriptedModel(), data);
    await app.setExtensionEnabled(owner(app), "usage.ts", true);
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/x/usage`;
});

after(async () => {
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await app?.close();
    cleanUp();
    delete seen.usageRequest;
    delete seen.usageGate;
});

async function call(id: ConversationId, token = app.config.ownerToken, target?: ConversationId) {
    const response = await fetch(
        `${base}/source/${id}${target === undefined ? "" : `?target=${target}`}`,
        {
            headers: { authorization: `Bearer ${token}`, "x-pocket": "1" },
        },
    );

    return { status: response.status, data: (await response.json()) as ConversationUsage };
}

async function read(id: ConversationId, target?: ConversationId): Promise<ConversationUsage> {
    const result = await call(id, app.config.ownerToken, target);

    assert.equal(result.status, 200, JSON.stringify(result.data));

    return result.data;
}

function used(n: number, reasoning?: number): Usage {
    return {
        input: n,
        cacheRead: 2 * n,
        cacheWrite: 3 * n,
        output: 4 * n,
        totalTokens: 10 * n,
        ...(reasoning === undefined ? {} : { reasoning }),
        cost: { input: 0, cacheRead: 0, cacheWrite: 0, output: n / 100, total: n / 100 },
    };
}

async function response(id: ConversationId, n: number, reasoning?: number): Promise<void> {
    const usage = used(n, reasoning);
    const message = { ...fauxAssistantMessage("synthetic"), usage };

    await app.harness.commit(async (tx) => {
        await tx.appendEntry(id, { kind: "pi.assistant", model: [message] });
        const models = (await tx.doc(UsageDoc, id)).models;
        const total = models["faux/faux-1"];

        if (total === undefined) {
            models["faux/faux-1"] = usage;
        } else {
            for (const field of [
                "input",
                "cacheRead",
                "cacheWrite",
                "output",
                "totalTokens",
            ] as const) {
                total[field] += usage[field];
            }

            total.cost.total += usage.cost.total;

            if (reasoning !== undefined) {
                total.reasoning = (total.reasoning ?? 0) + reasoning;
            }
        }
    }, context);
}

async function child(parent: ConversationId): Promise<ConversationId> {
    return app.harness.commit(async (tx) => {
        const { id } = await tx.createConversation({ ownership: { kind: "ownerless" } });

        (await tx.doc(AgentDoc, id)).cwd = app.cwdOf(parent);
        (await tx.doc(SubagentsDoc, parent)).agents[`child-${id}`] = {
            conversationId: id,
            reported: [],
        };

        return id;
    }, context);
}

async function link(parent: ConversationId): Promise<ConversationId> {
    const id = await newSession(app);

    await app.harness.commit(async (tx) => {
        (await tx.doc(SessionsDoc)).items[String(id)]!.linkedFrom = { id: Number(parent) };
    }, context);

    return id;
}

test("one conversation returns ledger totals, response count, and newest prompt", async () => {
    const id = await newSession(app);

    await response(id, 10);
    await response(id, 20, 7);
    // Auxiliary model and tool usage has no assistant entry. It still counts in ledger totals.
    await app.harness.commit(async (tx) => {
        const doc = await tx.doc(UsageDoc, id);

        doc.models["faux/auxiliary"] = used(2);
        doc.tools.synthetic = used(3);
    }, context);
    const totals = await read(id);

    assert.ok(Math.abs(totals.own.cost - 0.35) < 1e-12);
    assert.deepEqual(
        { ...totals, own: { ...totals.own, cost: 0.35 } },
        {
            own: {
                requests: 2,
                input: 35,
                cacheRead: 70,
                cacheWrite: 105,
                output: 140,
                reasoning: 7,
                cost: 0.35,
                lastPrompt: 120,
            },
            children: { ...zero, count: 0 },
        },
    );
    (totals.own as { input: number }).input = 999;
    assert.equal((await read(id)).own.input, 35, "results cannot change the ledger");
});

test("children sum subagents and linked sessions at depth 2, not siblings or forks", async () => {
    const source = await newSession(app);
    const agent = await child(source);
    const nested = await child(agent);
    const linked = await link(source);
    const linkedChild = await child(linked);

    await child(source); // An unused child still counts.
    await response(source, 1);

    for (const id of [agent, nested, linked, linkedChild]) {
        await response(id, 10, 0);
    }

    const unrelated = await newSession(app);

    await response(unrelated, 1000);
    const result = await read(source);

    assert.equal(result.own.input, 1);
    assert.deepEqual(result.children, {
        requests: 4,
        input: 40,
        cacheRead: 80,
        cacheWrite: 120,
        output: 160,
        reasoning: 0,
        cost: 0.4,
        lastPrompt: 240,
        count: 5,
    });
    assert.deepEqual((await read(source, agent)).children, {
        requests: 1,
        input: 10,
        cacheRead: 20,
        cacheWrite: 30,
        output: 40,
        reasoning: 0,
        cost: 0.1,
        lastPrompt: 60,
        count: 1,
    });
});

test("forks do not inherit counters, and resets do not erase old responses", async () => {
    const source = await newSession(app);

    await response(source, 5);
    const conversation = (await app.harness.conversation(source, context))!;
    const entry = (await conversation.entries({}, 1, undefined, context)).items[0]!;
    const { id: fork } = await app.commands.fork(source, owner(app), { entryId: Number(entry.id) });

    assert.deepEqual((await read(fork)).own, zero);
    await response(fork, 2);
    assert.equal((await read(fork)).own.requests, 1);
    assert.equal((await read(source)).children.count, 0);
    await app.harness.commit(async (tx) => {
        for (let index = 0; index < 260; index++) {
            await tx.appendEntry(source, { kind: "synthetic.note", data: { index } });
        }

        await tx.appendEntry(source, { kind: "pi.reset", head: "self" });
    }, context);
    assert.equal((await read(source)).own.requests, 1);
    assert.equal((await read(source)).own.lastPrompt, 30);
});

test("a conversation with no usage returns zeros and no reasoning", async () => {
    assert.deepEqual(await read(await newSession(app)), {
        own: zero,
        children: { ...zero, count: 0 },
    });
});

test("GET usage uses conversation-route access and filters hidden descendants", async () => {
    const source = await newSession(app);
    const visible = await link(source);
    const hidden = await link(source);
    const other = app.config.addUser("Other", "guest");
    const viewer = app.config.addUser("Reader", "viewer");

    await response(visible, 2);
    await response(hidden, 1000);
    await app.harness.commit(async (tx) => {
        (await tx.doc(SessionsDoc)).items[String(hidden)]!.pip = other.user.id;
    }, context);

    try {
        const allowed = await call(source, viewer.token);

        assert.equal(allowed.status, 200);
        assert.equal(allowed.data.children.input, 2);
        assert.equal(allowed.data.children.count, 1);
        assert.equal((await call(source, viewer.token, hidden)).status, 404);
        assert.equal((await call(hidden, viewer.token)).status, 404);
        const scoped = app.config.addUser("Scoped", "guest", [String(source)]);

        try {
            assert.equal((await call(source, scoped.token)).status, 404);
        } finally {
            app.config.removeUser(scoped.user.id);
        }
    } finally {
        app.config.removeUser(other.user.id);
        app.config.removeUser(viewer.user.id);
    }
});

test("usage rechecks access after awaited reads and expires with the route", async () => {
    const source = await newSession(app);
    const viewer = app.config.addUser("Changing", "viewer");
    const original = app.harness.snapshot.bind(app.harness);
    let changed = false;

    app.harness.snapshot = (async (...args: Parameters<typeof original>) => {
        const value = await Reflect.apply(original, app.harness, args);

        if ((args[0] as unknown) === UsageDoc && !changed) {
            changed = true;
            app.config.updateUser(viewer.user.id, { sessions: [] });
        }

        return value;
    }) as typeof app.harness.snapshot;

    try {
        // First prove the new capability exists; baseline must fail this test too.
        assert.equal(typeof (await read(source))?.own.requests, "number");
        changed = false;
        app.config.updateUser(viewer.user.id, { sessions: undefined });
        assert.equal((await call(source, viewer.token)).status, 403);
    } finally {
        app.harness.snapshot = original;
        app.config.removeUser(viewer.user.id);
    }

    await read(source);
    await assert.rejects(seen.usageRequest!.conversationUsage(), /request has ended/);
});

test("a failed request with no usage keeps the prompt before it, and a new response counts on the next read", async () => {
    const id = await newSession(app);

    await response(id, 10);
    assert.equal((await read(id)).own.lastPrompt, 60);
    // A request that failed before the provider answered: an assistant entry with no usage.
    await response(id, 0);
    assert.deepEqual(
        { requests: (await read(id)).own.requests, lastPrompt: (await read(id)).own.lastPrompt },
        { requests: 2, lastPrompt: 60 },
    );
    await response(id, 20);
    assert.deepEqual(
        { requests: (await read(id)).own.requests, lastPrompt: (await read(id)).own.lastPrompt },
        { requests: 3, lastPrompt: 120 },
    );
});

test("a subagent started after a read counts on the next one", async () => {
    const source = await newSession(app);

    assert.equal((await read(source)).children.count, 0);
    await response(await child(source), 5);
    assert.equal((await read(source)).children.count, 1);
});
