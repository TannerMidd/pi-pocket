// Sandbox core (`sandbox.ts`): the readiness gate, turn-on and turn-off with their phases, the fail-closed environment,
// and the tool gate. A fake provider with gates stands in for a VM, so no test waits on time.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { SandboxDoc } from "../src/server/docs.ts";
import { READINESS_COMPONENTS } from "../src/server/sandbox.ts";
import {
    cleanUp,
    context,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    type App,
} from "./helpers.ts";
import { FakeProvider, gate, sandboxOptions } from "./sandbox-fake.ts";

const apps: App[] = [];
let opened = 0;

after(async () => {
    for (const app of apps) {
        await app.close();
    }

    cleanUp();
});

async function boot(options: Parameters<typeof sandboxOptions>[0] = {}, register = true) {
    const provider = new FakeProvider();
    const app = await openApp(
        scriptedModel(),
        join(root, `data-core-${++opened}`),
        undefined,
        undefined,
        sandboxOptions(options),
    );

    apps.push(app);

    const handle = register ? await app.sandboxes.register(provider, "fake.ts") : undefined;

    return { app, provider, handle };
}

function folder(name: string): string {
    const path = join(root, `core-${name}`);

    mkdirSync(path, { recursive: true });

    return path;
}

const stored = (app: App, id: number) =>
    app.harness.snapshot(SandboxDoc, id as never, context).then((doc) => doc?.on === true);

test("the readiness gate refuses a sandbox until every component is registered", async () => {
    const app = await openApp(
        scriptedModel(),
        join(root, `data-core-${++opened}`),
        undefined,
        undefined,
        { sandbox: { platform: "linux" } },
    );

    apps.push(app);
    const id = await newSession(app, folder("ready"));

    assert.deepEqual(app.sandboxes.readiness().missing, READINESS_COMPONENTS.slice(1));
    await assert.rejects(app.sandboxes.turnOn(id, owner(app)), /not available yet/);
    assert.equal(await stored(app, id), false);
    assert.equal(app.sandboxes.phaseOf(id), "stable");
});

test("with every component but the trusted places stub, turning on is refused, and nothing was revoked", async () => {
    const { app, provider } = await boot({ trusted: () => "no place is trusted yet" });
    const id = await newSession(app, folder("trusted"));

    await assert.rejects(app.sandboxes.turnOn(id, owner(app)), /no place is trusted yet/);
    assert.equal(await stored(app, id), false);
    assert.deepEqual(provider.released, []);
});

test("the stub that ships refuses every folder by default", async () => {
    const provider = new FakeProvider();
    const app = await openApp(
        scriptedModel(),
        join(root, `data-core-${++opened}`),
        undefined,
        undefined,
        {
            sandbox: { platform: "linux", components: [...READINESS_COMPONENTS] },
        },
    );

    apps.push(app);
    await app.sandboxes.register(provider, "fake.ts");
    const id = await newSession(app, folder("stub"));

    await assert.rejects(app.sandboxes.turnOn(id, owner(app)), /not checked in this build/);
    assert.equal(await stored(app, id), false);
});

test("a sandbox turns on, runs in the provider's environment, and turns off after the release", async () => {
    const { app, provider } = await boot();
    const dir = folder("basic");
    const id = await newSession(app, dir);

    await app.sandboxes.turnOn(id, owner(app));
    assert.equal(await stored(app, id), true);
    assert.equal(app.sandboxes.isOn(id), true);

    const env = app.envFor(id);
    const result = await env.exec("echo hi", undefined, context);

    assert.ok(result.ok);
    assert.deepEqual(provider.ran, ["echo hi"]);
    assert.equal(provider.targets[0]?.cwd, dir);

    await app.sandboxes.turnOff(id, owner(app));
    assert.equal(await stored(app, id), false);
    assert.deepEqual(provider.released, [Number(id)]);
    assert.equal(app.sandboxes.phaseOf(id), "stable");
});

/** An environment's call, as a person's tool would make it, answering whether it ran. */
const runs = async (app: App, id: number) => {
    const result = await app.envFor(id as never).exec("echo", undefined, context);

    return result.ok ? "ran" : result.error.message;
};

async function sandboxed(name: string, options: Parameters<typeof sandboxOptions>[0] = {}) {
    const booted = await boot(options);
    const dir = folder(name);
    const id = Number(await newSession(booted.app, dir));

    await booted.app.sandboxes.turnOn(id as never, owner(booted.app));

    return { ...booted, dir, id };
}

test("a sandboxed tree with no provider fails every call at once, and says why; it never reaches the host", async () => {
    const { app, id, handle } = await sandboxed("noprovider");

    // The module's own cleanup ran (the server is going away): the tree is still sandboxed, and its environment is the one
    // that fails.
    await handle!.unregister();
    assert.equal(app.sandboxes.provider, undefined);
    assert.match(await runs(app, id), /module/);
});

test("a failed release leaves the tree suspended with its setting on; every call fails at once; resume recovers it", async () => {
    const { app, provider, id } = await sandboxed("suspend");

    provider.failRelease = "the VM would not close";
    await assert.rejects(app.sandboxes.turnOff(id as never, owner(app)), /would not close/);
    assert.equal(await stored(app, id), true);
    assert.equal(app.sandboxes.phaseOf(id as never), "suspended");
    assert.match(await runs(app, id), /suspended/);
    assert.match(await runs(app, id), /would not close/);
    provider.failRelease = undefined;
    await app.sandboxes.resume(id as never);
    assert.equal(app.sandboxes.phaseOf(id as never), "stable");
    assert.equal(await runs(app, id), "ran");
});

test("a lease waits in turning-off; the wait is bounded", async () => {
    const hold = gate();
    let expire!: () => void;
    const expired = new Promise<void>((resolve) => (expire = resolve));
    // Only the bound of a waiting call fires (1000 ms); the bound of the release (2000 ms) does not.
    const { app, provider, id } = await sandboxed("lease-phases", {
        waitMs: 1000,
        drainMs: 2000,
        timer: (ms, signal) =>
            Promise.race([
                ms === 1000 ? expired : new Promise<void>(() => {}),
                new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve())),
            ]),
    });

    provider.holdRelease = hold;
    const off = app.sandboxes.turnOff(id as never, owner(app));

    await hold.reached;
    assert.equal(app.sandboxes.phaseOf(id as never), "turning-off");
    const waiting = runs(app, id);
    let settled = false;

    void waiting.then(() => (settled = true));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false, "a call waits while the phase is not stable");
    // The bound runs out: the call fails, and says it waited.
    expire();
    assert.match(await waiting, /did not finish in time/);
    hold.open();
    await off;
});

test("a call that waited re-resolves its environment: after a turn-off it runs on the host's, never on the old one", async () => {
    const hold = gate();
    const { app, provider, id, dir } = await sandboxed("reresolve");

    writeFileSync(join(dir, "note.txt"), "host");
    provider.holdRelease = hold;
    const off = app.sandboxes.turnOff(id as never, owner(app));

    await hold.reached;
    const env = app.envFor(id as never);
    // Made while turning off, it is the sandbox's handle: its call waits, then moves to the environment the new state gives.
    const call = env.readTextFile(join(dir, "note.txt"), context);

    hold.open();
    await off;
    const read = await call;

    assert.ok(read.ok && read.value === "host", "ran on the host after the turn-off");
    assert.equal(provider.ran.length, 0);
});

test("an environment handle takes a lease for each call, and a turn-off revokes it", async () => {
    const { app, provider, id } = await sandboxed("handle");
    let seen: AbortSignal | undefined;

    // A call that does not end until it is revoked.
    provider.env = (target) => {
        provider.targets.push(target);

        return {
            id: "stuck",
            cwd: target.cwd,
            exec: (_command: unknown, _options: unknown, ctx: { abortSignal?: AbortSignal }) => {
                seen = ctx.abortSignal;

                return new Promise((resolve) =>
                    seen?.addEventListener("abort", () =>
                        resolve({ ok: false, error: new Error("revoked") }),
                    ),
                );
            },
            cleanup: async () => {},
        } as never;
    };

    const call = app.envFor(id as never).exec("forever", undefined, context);

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(app.sandboxes.leasesOf(id as never).length, 1);
    assert.equal(app.sandboxes.leasesOf(id as never)[0]?.kind, "exec");
    await app.sandboxes.turnOff(id as never, owner(app));
    await call;
    assert.equal(seen?.aborted, true, "the revoke handler aborted the call");
    assert.equal(app.sandboxes.leasesOf(id as never).length, 0);
});

test("a host call in flight refuses a turn-on, and names it; nothing is killed", async () => {
    const { app } = await boot();
    const id = await newSession(app, folder("hostwork"));
    const lease = await app.sandboxes.lease(id, { kind: "host", what: "a build that is running" });

    await assert.rejects(app.sandboxes.turnOn(id, owner(app)), /a build that is running/);
    assert.equal(app.sandboxes.phaseOf(id), "stable");
    lease.end();
    await app.sandboxes.turnOn(id, owner(app));
    assert.equal(app.sandboxes.isOn(id), true);
});

test("the tool gate is an allow list with a route check", async () => {
    const { app, provider } = await boot({
        components: READINESS_COMPONENTS.filter((each) => each !== "team-rule"),
    });
    const gateOf = (tool: string, args: unknown = {}) => app.sandboxes.gate(tool, args);

    for (const tool of [
        "bash",
        "read",
        "write",
        "edit",
        "ask",
        "ui",
        "schedule",
        "subagent",
        "codemode",
        "tool_search",
    ]) {
        assert.equal(gateOf(tool), undefined, tool);
    }

    for (const tool of [
        "watch_pr",
        "session_send",
        "design_export",
        "mcp__x__y",
        "relay_reply",
        "team",
        "background",
        "browser",
    ]) {
        assert.match(gateOf(tool) ?? "", /runs on the host|no route|not available yet/, tool);
    }

    // Artifacts: no path anywhere, assets included.
    assert.equal(gateOf("artifact", { title: "a", content: "x" }), undefined);
    assert.match(gateOf("artifact", { path: "/etc/passwd" }) ?? "", /host/);
    assert.match(
        gateOf("artifact", { assets: [{ name: "a", path: "~/.ssh/id_rsa" }] }) ?? "",
        /host/,
    );
    // Memory: session scope only.
    assert.equal(gateOf("memory", { action: "add", scope: "session", text: "x" }), undefined);
    assert.match(gateOf("memory", { action: "add", text: "x" }) ?? "", /session/);
    assert.match(
        gateOf("memory", { action: "add", scope: "everywhere", text: "x" }) ?? "",
        /session/,
    );
    assert.match(gateOf("memory", { action: "remove", id: "a" }) ?? "", /session/);
    // A routed tool has a route only when the provider has one; `team` only when its rule is registered.
    assert.match(gateOf("background") ?? "", /no route/);
    Object.assign(provider, { jobs: () => ({}), browser: () => ({}) });
    assert.equal(gateOf("background"), undefined);
    assert.equal(gateOf("browser"), undefined);
    app.sandboxes.provide("team-rule");
    assert.equal(gateOf("team"), undefined);
});

test("the gate hook blocks a sandboxed tree's host tool, and a plain tree's host call holds a lease", async () => {
    const { app, id } = await sandboxed("hook");
    const plain = await newSession(app, folder("hook-plain"));

    assert.match(
        (await app.sandboxes.beforeTool(id as never, "t1", "watch_pr", {})) ?? "",
        /runs on the host/,
    );
    assert.equal(await app.sandboxes.beforeTool(id as never, "t2", "bash", {}), undefined);
    assert.equal(await app.sandboxes.beforeTool(plain, "t3", "watch_pr", {}), undefined);
    assert.equal(app.sandboxes.leasesOf(plain).length, 1);
    await assert.rejects(app.sandboxes.turnOn(plain, owner(app)), /watch_pr call that is running/);
    app.sandboxes.toolEnded("t3");
    assert.equal(app.sandboxes.leasesOf(plain).length, 0);
});

test("a delivery is checked in every phase: stable goes, anything else defers", async () => {
    const hold = gate();
    const { app, provider, id } = await sandboxed("deliver");

    assert.deepEqual(app.sandboxes.deliver(id as never), { ok: true });
    provider.holdRelease = hold;
    const off = app.sandboxes.turnOff(id as never, owner(app));

    await hold.reached;
    assert.equal(app.sandboxes.deliver(id as never).ok, false);
    assert.throws(() => app.sandboxes.requireDelivery(id as never), /Nothing was sent/);
    hold.open();
    await off;
    assert.deepEqual(app.sandboxes.deliver(id as never), { ok: true });
});

test("a page and a task hold leases with revoke handlers; a turn-off revokes each and waits for it to end", async () => {
    const { app, id } = await sandboxed("lease-kinds");
    const revoked: string[] = [];
    const page = await app.sandboxes.lease(id as never, {
        kind: "page",
        revoke: () => void revoked.push("page"),
    });
    const task = await app.sandboxes.lease(id as never, {
        kind: "task",
        revoke: async () => {
            revoked.push("task");
            task.end();
        },
    });

    // Releasing the launch lease closes the page: the page's own revoke ends its lease.
    page.end = ((end) => () => {
        revoked.push("page closed");
        end();
    })(page.end);
    assert.deepEqual(
        app.sandboxes.leasesOf(id as never).map((lease) => lease.kind),
        ["page", "task"],
    );
    const off = app.sandboxes.turnOff(id as never, owner(app));

    await new Promise((resolve) => setImmediate(resolve));
    // The page's handler does not end it: the release waits (bounded) for it, and the test ends it as a closing page does.
    assert.ok(revoked.includes("page") && revoked.includes("task"));
    page.end();
    await off;
    assert.equal(app.sandboxes.leasesOf(id as never).length, 0);
});

test("a VM lease cannot be issued without a revoke handler (the type asks for it)", async () => {
    const { app, id } = await sandboxed("lease-types");

    // @ts-expect-error a `call` lease needs `revoke`.
    const refused = app.sandboxes.lease(id as never, { kind: "call" });

    void refused.then((lease) => lease.end());
    const host = await app.sandboxes
        .lease(id as never, { kind: "host" })
        .catch((error: Error) => error);

    // A host lease in a sandboxed tree is granted (its `sandboxed` flag says so): the caller must not run on the host.
    assert.ok(!(host instanceof Error) && host.sandboxed === true);
    host instanceof Error || host.end();
});

test("a join of a sandboxed group is refused while the readiness gate is closed", async () => {
    const data = join(root, `data-core-${++opened}`);
    const dir = folder("join-gate");
    const first = await openApp(scriptedModel(), data, undefined, undefined, sandboxOptions());

    await first.sandboxes.register(new FakeProvider(), "fake.ts");
    const a = await newSession(first, dir);

    await first.sandboxes.turnOn(a, owner(first));
    await first.close();
    const second = await openApp(scriptedModel(), data, undefined, undefined, {
        sandbox: { platform: "linux" },
    });

    apps.push(second);
    await assert.rejects(
        second.commands.createSession(owner(second), { cwd: dir }),
        /not available yet/,
    );
});
