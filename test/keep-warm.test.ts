import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { test } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ConversationId } from "@earendil-works/pi-durable";
import { keepWarmFrom } from "../src/server/config.ts";
import { ChatDoc, type SessionMeta } from "../src/server/docs.ts";
import { KeepWarm, type KeepWarmDeps, keepWarmLabel } from "../src/server/keep-warm.ts";
import { cachePrices } from "../src/server/model-cache-facts.ts";
import { cleanUp, context, newSession, openApp, owner, scriptedModel, work } from "./helpers.ts";

const model = (api: string, cost: Partial<Model<Api>["cost"]>) =>
    ({ api, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...cost } }) as Model<Api>;

test("cache prices: published and owner read prices, tiered writes, and missing prices", () => {
    const claude = model("anthropic-messages", { input: 4, cacheRead: 0.2, cacheWrite: 5 });

    for (const [entry, seconds, read, expected] of [
        [claude, 300, undefined, { read: 0.2, write: 5 }],
        [claude, 3600, undefined, { read: 0.2, write: 8 }],
        [
            model("openai-responses", { input: 2, cacheRead: 0.1 }),
            undefined,
            undefined,
            { read: 0.1, write: 2 },
        ],
        [model("openai-responses", { input: 2 }), undefined, undefined, undefined],
        [model("openai-responses", { cacheRead: 0.1 }), undefined, undefined, undefined],
        [model("openai-completions", { input: 2 }), undefined, 0.5, { read: 0.5, write: 2 }],
    ] as const) {
        assert.deepEqual(cachePrices(entry, seconds, read), expected);
    }
});

const fakeDeps = (overrides: Partial<KeepWarmDeps> = {}): KeepWarmDeps => ({
    settings: () => keepWarmFrom({}),
    saveSettings: () => {},
    sessionMeta: () => undefined,
    rootOf: (id) => id,
    model: () => undefined,
    models: () => [],
    availableModels: () => [],
    keeper: {
        idleSummary: () => ({ warm: 0, refreshes: 0, spent: 0 }),
        idleStatus: () => ({ warm: false }),
    },
    settingsChanged: async () => {},
    ...overrides,
});

test("keep warm: facts use the selected tier's Anthropic write price for Break-even", () => {
    const cached: Model<Api> = {
        ...model("anthropic-messages", { input: 4, cacheRead: 0.2, cacheWrite: 5 }),
        provider: "anthropic",
        id: "cached-model",
        promptCache: { short: 300, long: 3600 },
    };
    const keepWarm = new KeepWarm(fakeDeps({ model: () => cached }));

    assert.deepEqual(keepWarm.facts("anthropic/cached-model", "long").prices, {
        read: 0.2,
        write: 8,
    });
    assert.deepEqual(keepWarm.facts("anthropic/cached-model", "short").prices, {
        read: 0.2,
        write: 5,
    });
});

test("keep warm: policy uses the owner's hours and excludes PiP, archived sessions, and disallowed subagents", () => {
    const settings = keepWarmFrom({ hours: 4 });
    const meta: SessionMeta = { cwd: "/tmp", createdAt: 0, updatedAt: 0 };
    const pip = 1 as ConversationId;
    const archived = 2 as ConversationId;
    const session = 3 as ConversationId;
    const subagent = 4 as ConversationId;
    const sessions = new Map<ConversationId, SessionMeta>([
        [pip, { ...meta, pip: "owner" }],
        [archived, { ...meta, archived: true }],
        [session, { ...meta }],
    ]);
    const keepWarm = new KeepWarm(
        fakeDeps({
            settings: () => settings,
            sessionMeta: (id) => sessions.get(id),
            rootOf: (id) => (id === subagent ? session : id),
        }),
    );

    assert.equal(keepWarm.policy(pip), undefined);
    assert.equal(keepWarm.policy(archived), undefined);
    assert.equal(keepWarm.policy(subagent), undefined);
    assert.equal(keepWarm.policy(session)?.hours, settings.hours);
});

test("keep warm: overview gives each model's refresh interval and Break-even cap", () => {
    const cached: Model<Api> = {
        ...model("anthropic-messages", { input: 4, cacheRead: 0.2, cacheWrite: 5 }),
        provider: "anthropic",
        id: "cached-model",
        name: "Cached model",
        promptCache: { short: 3600 },
    };
    const keepWarm = new KeepWarm(
        fakeDeps({
            model: (provider, id) =>
                provider === cached.provider && id === cached.id ? cached : undefined,
            models: () => [cached],
            availableModels: () => [cached],
        }),
    );
    const overview = keepWarm.overview({
        id: "owner",
        name: "Owner",
        role: "owner",
        tokenHash: "",
        createdAt: 0,
    });

    assert.equal(overview.models.length, 1);
    assert.equal(overview.models[0]!.plan.everyMs, 3_240_000, "90% of a 1-hour cache by default");
    assert.equal(overview.models[0]!.plan.refreshes, 30);
});

test("keep warm: session changes validate together, check permissions, and record activity", async (t) => {
    const app = await openApp(scriptedModel());

    try {
        const guest = app.config.addUser("Alex", "guest").user;
        const id = await newSession(app);
        const before = structuredClone(app.sessionMeta(id));
        const activityBefore = await app.harness.snapshot(ChatDoc, id, context);

        for (const choice of ["break-even", 8, 1]) {
            await assert.rejects(
                app.commands.updateSession(id, guest, {
                    title: "Rejected",
                    archived: true,
                    keepWarm: choice,
                }),
                /Only the owner/,
            );
            assert.deepEqual(
                app.sessionMeta(id),
                before,
                "a rejected choice must not rename or archive",
            );
        }

        await assert.rejects(
            app.commands.updateSession(id, owner(app), { title: "Invalid time", keepWarm: 3 }),
            /must be/,
        );
        assert.deepEqual(app.sessionMeta(id), before);
        assert.deepEqual(await app.harness.snapshot(ChatDoc, id, context), activityBefore);

        const reconsider = t.mock.method(app.cacheKeeper, "reconsider");

        await app.commands.updateSession(id, guest, { keepWarm: 0 });
        assert.equal(app.sessionMeta(id)?.keepWarm, 0);
        assert.equal(reconsider.mock.callCount(), 1);
        await app.commands.updateSession(id, guest, { keepWarm: 0 });
        assert.equal(reconsider.mock.callCount(), 1, "an unchanged choice does not reconsider");
        await app.commands.updateSession(id, guest, { keepWarm: "default" });
        assert.equal(app.sessionMeta(id)?.keepWarm, undefined, "the default is off");
        await app.commands.updateSession(id, guest, { keepWarm: 0 });

        // The owner's default is on: a guest's Default would turn the session back on.
        await app.keepWarm.setSettings(owner(app), { hours: "break-even" });
        await assert.rejects(
            app.commands.updateSession(id, guest, { keepWarm: "default" }),
            /Only the owner/,
        );
        assert.equal(app.sessionMeta(id)?.keepWarm, 0);
        await app.commands.updateSession(id, owner(app), { keepWarm: "break-even" });
        assert.equal(app.sessionMeta(id)?.keepWarm, "break-even");
        await app.commands.updateSession(id, guest, { keepWarm: "default" });
        assert.equal(
            app.sessionMeta(id)?.keepWarm,
            undefined,
            "back to a Default that is the session's time already is allowed",
        );

        // A shorter time the owner chose: a guest's Default would lengthen it.
        await app.commands.updateSession(id, owner(app), { keepWarm: 0.5 });
        await assert.rejects(
            app.commands.updateSession(id, guest, { keepWarm: "default" }),
            /Only the owner/,
        );
        assert.equal(app.sessionMeta(id)?.keepWarm, 0.5);

        // A viewer cannot steer, and a guest with access to another session cannot change this one.
        const viewer = app.config.addUser("Bea", "viewer").user;
        const stranger = app.config.addUser("Chris", "guest", []).user;

        await assert.rejects(app.commands.updateSession(id, viewer, { keepWarm: 0 }));
        await assert.rejects(app.commands.updateSession(id, stranger, { keepWarm: 0 }));

        for (const choice of [0.5, 1, 2, "break-even", 0, "default"] as const) {
            await app.commands.updateSession(id, owner(app), { keepWarm: choice });
        }

        const chat = await app.harness.snapshot(ChatDoc, id, context);

        assert.ok(chat);
        const lines = chat.messages.filter(
            (message) => message.kind === "event" && message.text.startsWith("set keep warm to "),
        );

        assert.deepEqual(
            lines.map((message) => message.text),
            [
                "set keep warm to off",
                "set keep warm to the default (off)",
                "set keep warm to off",
                "set keep warm to Break-even",
                "set keep warm to the default (Break-even)",
                "set keep warm to 30 minutes",
                "set keep warm to 1 hour",
                "set keep warm to 2 hours",
                "set keep warm to Break-even",
                "set keep warm to off",
                "set keep warm to the default (Break-even)",
            ],
        );
        assert.equal(lines[0]?.userId, guest.id);
    } finally {
        await app.close();
        cleanUp();
    }
});

test("keep warm: off is the default; the owner's saved times stay valid", () => {
    assert.equal(keepWarmFrom({}).hours, 0);
    assert.equal(keepWarmFrom({ hours: 0.5 }).hours, 0.5);
    assert.equal(keepWarmFrom({ hours: "break-even" }).hours, "break-even");
    assert.equal(keepWarmFrom({ hours: 3 }).hours, 0, "a time not on offer is the default");

    const session = 3 as ConversationId;
    const keepWarm = new KeepWarm(
        fakeDeps({ sessionMeta: () => ({ cwd: "/tmp", createdAt: 0, updatedAt: 0 }) }),
    );

    assert.equal(keepWarm.policy(session), undefined);
    assert.equal(keepWarm.session(session)?.choice, "default");
});

test("keep warm: a session choice reconsiders only the session and its subagents", async (t) => {
    mkdirSync(work, { recursive: true });
    const app = await openApp(scriptedModel());

    try {
        const id = await newSession(app);
        const child = (Number(id) + 10_000) as ConversationId;
        const conversations = t.mock.method(app, "conversationsOf", () => [id, child]);
        const reconsider = t.mock.method(app.cacheKeeper, "reconsider");

        await app.commands.updateSession(id, owner(app), { keepWarm: 1 });
        assert.equal(conversations.mock.callCount(), 1);
        assert.deepEqual(reconsider.mock.calls[0]?.arguments, [new Set([id, child])]);
        await app.keepWarm.setSettings(owner(app), { hours: 1 });
        assert.deepEqual(
            reconsider.mock.calls.at(-1)?.arguments,
            [],
            "settings still reconsider all",
        );
    } finally {
        await app.close();
        cleanUp();
    }
});

test("keep warm: warmable includes Off, archived, and disallowed subagents, but never PiP or a missing session", () => {
    const session = 1 as ConversationId;
    const child = 2 as ConversationId;
    const pip = 3 as ConversationId;
    const missing = 4 as ConversationId;
    const archived = 5 as ConversationId;
    const meta: SessionMeta = { cwd: "/tmp", createdAt: 0, updatedAt: 0 };
    const settings = keepWarmFrom({ hours: 0, subagents: false });
    const sessions = new Map<ConversationId, SessionMeta>([
        [session, meta],
        [pip, { ...meta, pip: "owner" }],
        [archived, { ...meta, archived: true }],
    ]);
    const keepWarm = new KeepWarm(
        fakeDeps({
            settings: () => settings,
            sessionMeta: (id) => sessions.get(id),
            rootOf: (id) => (id === child ? session : id),
        }),
    );

    assert.equal(keepWarm.warmable(pip), false);
    assert.equal(keepWarm.warmable(missing), false);
    assert.equal(keepWarm.warmable(session), true);
    assert.equal(keepWarm.warmable(archived), true, "an archived session can return");
    assert.equal(keepWarm.warmable(child), true, "the owner can allow subagents later");
    assert.equal(keepWarm.policy(child), undefined);
});

test("keep warm: activity uses the same time labels for every choice", () => {
    assert.deepEqual(([0, 0.5, 1, 2, 4, 8, "break-even"] as const).map(keepWarmLabel), [
        "off",
        "30 minutes",
        "1 hour",
        "2 hours",
        "4 hours",
        "8 hours",
        "Break-even",
    ]);
});
