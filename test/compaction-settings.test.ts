// The owner's choice of when Pi compacts a session's context: Pi's own settings, changed from the app, kept live.
import { type App, cleanUp, openApp, owner, root, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, mock, test } from "node:test";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { harnessCompaction, reserveFromOver } from "../src/server/app.ts";

const faux = fauxProvider({ models: [{ id: "faux-1" }] });
let app: App;

before(async () => {
    app = await openApp(faux);
});

after(async () => {
    await app?.close();
    cleanUp();
});

/** Pi's settings file for these tests (the helpers point Pi's config at a temporary folder). */
const settingsFile = () =>
    JSON.parse(readFileSync(join(process.env.PI_CODING_AGENT_DIR!, "settings.json"), "utf8"));

test("the owner sets the thresholds: they reach Pi's settings file, and the hello the sheet reads", async () => {
    const before = app.compactionSettings();

    await app.setCompaction(owner(app), { reserveTokens: 32768, keepRecentTokens: 20000 });

    const policy = app.compactionSettings()!;

    assert.equal(policy.reserveTokens, 32768);
    assert.equal(policy.keepRecentTokens, 20000);
    // The switch was not named, so it stays as it was.
    assert.equal(policy.enabled, before?.enabled ?? true);
    assert.equal(policy.trigger, "fromFull");
    assert.equal(policy.overTokens, 100000);
    assert.deepEqual((await app.hello(owner(app))).server.compaction, policy);

    const stored = settingsFile();

    assert.equal(stored.compaction.reserveTokens, 32768);
    assert.equal(stored.compaction.keepRecentTokens, 20000);

    // Pi's file has the token fields only. The trigger lives in Pocket's config.
    assert.deepEqual(app.settings.getCompactionSettings(), {
        enabled: policy.enabled,
        reserveTokens: policy.reserveTokens,
        keepRecentTokens: policy.keepRecentTokens,
    });
});

test("the owner turns compaction off and on, one field at a time, without losing the thresholds", async () => {
    await app.setCompaction(owner(app), { enabled: false });
    assert.equal(app.compactionSettings()!.enabled, false);
    assert.equal(settingsFile().compaction.enabled, false);

    await app.setCompaction(owner(app), { enabled: true });
    assert.equal(app.compactionSettings()!.enabled, true);
    assert.equal(settingsFile().compaction.reserveTokens, 32768);
});

test("a change reaches a session that already exists", async () => {
    const { id } = await app.commands.createSession(owner(app), { cwd: work });

    await app.setCompaction(owner(app), { reserveTokens: 65536 });
    assert.equal(app.settings.getCompactionSettings().reserveTokens, 65536);

    // The harness's settings are getters that read Pi's manager each time, so the session sees the change.
    const agent = await app.agentState(id);

    assert.ok(agent);
    await app.setCompaction(owner(app), { reserveTokens: 32768 });
});

test("guests do not see compaction in hello, and the settings route is the owner's", async () => {
    const guest = { ...owner(app), role: "guest" } as ReturnType<typeof owner>;

    assert.equal("compaction" in (await app.hello(guest)).server, false);
    assert.ok((await app.hello(owner(app))).server.compaction);

    const { createServer } = await import("node:http");
    const { createHandler } = await import("../src/server/http.ts");
    const server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const post = (token: string, body: object) =>
        fetch(`http://127.0.0.1:${port}/api/settings`, {
            method: "POST",
            headers: {
                authorization: `Bearer ${token}`,
                "content-type": "application/json",
                "x-pocket": "1",
            },
            body: JSON.stringify(body),
        });

    try {
        const guestToken = app.config.addUser("Bea", "guest").token;

        assert.equal((await post(guestToken, { compaction: { enabled: false } })).status, 403);
        assert.equal(app.compactionSettings()!.enabled, true);
        assert.equal(
            (await post(app.config.ownerToken, { compaction: { enabled: false } })).status,
            200,
        );
        assert.equal(app.compactionSettings()!.enabled, false);
        assert.equal(
            (
                await post(app.config.ownerToken, {
                    compaction: { enabled: true },
                    limitWaitHours: 1,
                })
            ).status,
            400,
        );
        assert.equal(app.compactionSettings()!.enabled, false);
        assert.equal(
            (await post(app.config.ownerToken, { compaction: { enabled: true } })).status,
            200,
        );
    } finally {
        server.closeAllConnections();
        server.close();
    }
});

test("only whole numbers of tokens are taken, and the owner alone may set them", async () => {
    const guest = { ...owner(app), role: "guest" } as ReturnType<typeof owner>;

    await assert.rejects(app.setCompaction(guest, { reserveTokens: 4096 }), /Only the owner/);

    for (const bad of [16384.5, -1, "16000", null]) {
        await assert.rejects(
            app.setCompaction(owner(app), { reserveTokens: bad }),
            /whole number of tokens/,
        );
    }

    await assert.rejects(app.setCompaction(owner(app), {}), /Say what to change/);
    await assert.rejects(app.setCompaction(owner(app), { enabled: "yes" }), /true or false/);
    await assert.rejects(
        app.setCompaction(owner(app), { trigger: "percent" }),
        /fromFull" or "over/,
    );
    // A nothing-changed call is refused before any write.
    assert.equal(settingsFile().compaction.reserveTokens, 32768);
});

test("over Y is window minus Y; a window at or below Y keeps the from-full reserve", () => {
    assert.equal(reserveFromOver(128000, 60000, 16384), 68000);
    assert.equal(reserveFromOver(50000, 60000, 16384), 16384);
    assert.equal(reserveFromOver(0, 60000, 16384), 16384);

    const policy = { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 };
    const models = [{ provider: "faux", id: "faux-1", contextWindow: 128000 }];

    assert.deepEqual(harnessCompaction(policy, "fromFull", 60000, models), policy);
    assert.deepEqual(harnessCompaction(undefined, "over", 60000, models), {});
    assert.deepEqual(harnessCompaction(policy, "over", 60000, models), {
        ...policy,
        modelOverrides: { "faux/faux-1": { reserveTokens: 68000 } },
    });
    assert.deepEqual(harnessCompaction(policy, "over", 200000, models), {
        ...policy,
        modelOverrides: { "faux/faux-1": { reserveTokens: 16384 } },
    });
});

test("once-over writes Pocket config, leaves Pi's reserve, and converts per model in the harness", async () => {
    const { Harness } = await import("@earendil-works/pi-durable");
    const opened = mock.method(Harness, "open");
    let isolated: App | undefined;

    try {
        isolated = await openApp(faux, join(root, "compaction-over"));
        const harness = opened.mock.calls[0]!.arguments[1].settings as
            | {
                  compaction: {
                      reserveTokens?: number;
                      modelOverrides?: Record<string, { reserveTokens: number }>;
                  };
              }
            | (() => {
                  compaction: {
                      reserveTokens?: number;
                      modelOverrides?: Record<string, { reserveTokens: number }>;
                  };
              });
        const settings = typeof harness === "function" ? harness() : harness;

        const before = isolated.settings.getCompactionSettings().reserveTokens;

        await isolated.setCompaction(owner(isolated), { trigger: "over", overTokens: 60000 });

        const policy = isolated.compactionSettings()!;

        assert.equal(policy.trigger, "over");
        assert.equal(policy.overTokens, 60000);
        assert.equal(policy.reserveTokens, before);
        assert.equal(isolated.settings.getCompactionSettings().reserveTokens, before);
        assert.equal(isolated.config.compactionTrigger, "over");
        assert.deepEqual((await isolated.hello(owner(isolated))).server.compaction, policy);
        assert.equal(settings.compaction.reserveTokens, before);
        assert.equal(settings.compaction.modelOverrides?.["faux/faux-1"]?.reserveTokens, 68000);

        await isolated.setCompaction(owner(isolated), { trigger: "fromFull" });
        assert.equal(isolated.compactionSettings()!.trigger, "fromFull");
        assert.equal(settings.compaction.modelOverrides, undefined);
        assert.equal(isolated.settings.getCompactionSettings().reserveTokens, before);
    } finally {
        opened.mock.restore();
        await isolated?.close();
    }
});

test("the idle hours are the owner's, from a short list, and sent in the policy", async () => {
    assert.equal(app.compactionSettings()!.idleHours, 1);
    await app.setCompaction(owner(app), { idleHours: 5 });
    assert.equal(app.compactionSettings()!.idleHours, 5);
    await assert.rejects(app.setCompaction(owner(app), { idleHours: 3 }), { status: 400 });
    await app.setCompaction(owner(app), { idleHours: 1 });
    assert.equal(app.config.compactIdleHours, 1);
});
