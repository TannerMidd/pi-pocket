// Fixes from the independent review of PR 1: provider replacement is serialised and keeps the old provider when its teardown
// fails; every failure after a release suspends the tree until a recovery; a recovery frees the reservation; handles go to the
// environment that the current state gives; readers and watchers keep their lease until closed; host tools pass I1; a refused
// worktree removal deletes nothing.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { AgentDoc } from "@earendil-works/pi-durable";
import { HttpError } from "../src/server/errors.ts";
import { SessionsDoc } from "../src/server/docs.ts";
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

async function world(name: string) {
    const provider = new FakeProvider();
    const app = await openApp(
        scriptedModel(),
        join(root, `data-review-${++opened}`),
        undefined,
        undefined,
        sandboxOptions(),
    );

    apps.push(app);
    await app.sandboxes.register(provider, "fake.ts");
    const dir = join(root, `review-${name}`);

    mkdirSync(dir, { recursive: true });
    const a = await newSession(app, dir);

    await app.sandboxes.turnOn(a, owner(app));

    return { app, provider, dir, a };
}

const exec = async (app: App, id: ConversationId) =>
    (await app.envFor(id).exec("x", undefined, context)).ok;

test("a replacement provider is installed only after the old one is released; a failed teardown keeps the old one", async () => {
    const w = await world("replace");
    const hold = gate();
    const second = new FakeProvider();

    w.provider.holdRelease = hold;
    let installed = false;
    const registering = w.app.sandboxes.register(second, "other.ts").then(() => (installed = true));

    await hold.reached;
    assert.equal(
        w.app.sandboxes.provider,
        w.provider,
        "the old provider serves until it is proved gone",
    );
    assert.equal(installed, false);
    assert.equal(w.app.sandboxes.phaseOf(w.a), "suspended");
    hold.open();
    await registering;
    assert.deepEqual(w.provider.released, [Number(w.a)], "the old VM was released first");
    assert.equal(w.app.sandboxes.provider, second);
    assert.equal(w.app.sandboxes.phaseOf(w.a), "stable");

    // Now one that cannot be stopped: the old provider stays, the new one is refused, and the tree stays suspended.
    const third = new FakeProvider();

    second.failRelease = "the VM would not close";
    await assert.rejects(w.app.sandboxes.register(third, "third.ts"), /could not be stopped/);
    assert.equal(w.app.sandboxes.provider, second);
    assert.equal(w.app.sandboxes.phaseOf(w.a), "suspended");
    assert.equal(await exec(w.app, w.a), false);
});

test("a step that fails after the release suspends the tree, also a refusal; resume recovers it and frees the reservation", async () => {
    const w = await world("post-release");

    await assert.rejects(
        w.app.sandboxes.change(
            { kind: "leave", id: w.a },
            {
                commit: () =>
                    Promise.reject(new HttpError(409, "this call refers to another session")),
            },
        ),
        /another session/,
    );
    assert.deepEqual(w.provider.released, [Number(w.a)], "the VM was stopped");
    assert.equal(w.app.sandboxes.phaseOf(w.a), "suspended", "a 4xx after the release suspends too");
    assert.equal(await exec(w.app, w.a), false);
    // The group stays reserved against joins until the recovery.
    await assert.rejects(w.app.commands.createSession(owner(w.app), { cwd: w.dir }), /under way/);
    await w.app.sandboxes.resume(w.a);
    assert.equal(w.app.sandboxes.phaseOf(w.a), "stable");
    assert.equal(await exec(w.app, w.a), true);
    const joined = await w.app.commands.createSession(owner(w.app), { cwd: w.dir });

    assert.equal(w.app.sandboxes.isOn(joined.id), true, "the reservation is gone");
});

test("a failed turn-off that is retried or resumed leaves no reservation: a turn-on works after", async () => {
    const w = await world("reservation");

    w.provider.failRelease = "stuck";
    await assert.rejects(w.app.sandboxes.turnOff(w.a, owner(w.app)), /stuck/);
    w.provider.failRelease = undefined;
    // A retry replaces the kept reservation, and its success clears it.
    await w.app.sandboxes.turnOff(w.a, owner(w.app));
    await w.app.sandboxes.turnOn(w.a, owner(w.app));
    assert.equal(w.app.sandboxes.isOn(w.a), true);

    // And a resume clears the one a failed turn-off kept.
    w.provider.failRelease = "stuck again";
    await assert.rejects(w.app.sandboxes.turnOff(w.a, owner(w.app)), /stuck again/);
    w.provider.failRelease = undefined;
    await w.app.sandboxes.resume(w.a);
    await w.app.sandboxes.turnOff(w.a, owner(w.app));
    await w.app.sandboxes.turnOn(w.a, owner(w.app));
    assert.equal(w.app.sandboxes.isOn(w.a), true);
});

test("a cached environment handle goes to the environment of the current folder, and of the current provider", async () => {
    const provider = new FakeProvider();
    const app = await openApp(
        scriptedModel(),
        join(root, `data-review-${++opened}`),
        undefined,
        undefined,
        sandboxOptions(),
    );

    apps.push(app);
    await app.sandboxes.register(provider, "fake.ts");
    const from = join(root, "review-handle-from");
    const to = join(root, "review-handle-to");

    mkdirSync(from);
    mkdirSync(to);
    writeFileSync(join(from, "note.txt"), "from");
    writeFileSync(join(to, "note.txt"), "to");
    const id = await newSession(app, from);
    const cached = app.envFor(id);

    const read = async () => {
        const result = await cached.readTextFile("note.txt", context);

        return result.ok ? result.value : result.error.message;
    };

    assert.equal(await read(), "from");
    await app.commands.configure(id, owner(app), { cwd: to });
    assert.equal(await read(), "to", "a plain move: the cached handle works in the new folder");

    // A sandboxed handle follows the provider: after a replacement it never reaches the old one.
    const dir = join(root, "review-handle-box");

    mkdirSync(dir);
    const boxed = await newSession(app, dir);

    await app.sandboxes.turnOn(boxed, owner(app));
    const handle = app.envFor(boxed);

    assert.ok((await handle.exec("one", undefined, context)).ok);
    const next = new FakeProvider();

    await app.sandboxes.register(next, "next.ts");
    assert.ok((await handle.exec("two", undefined, context)).ok);
    assert.deepEqual(provider.ran, ["one"]);
    assert.deepEqual(next.ran, ["two"], "the new provider served the cached handle");
});

test("a reader keeps its lease until it is closed, a turn-off closes it, and listFiles takes a lease", async () => {
    const w = await world("resources");
    const env = w.app.envFor(w.a);
    const opened = await env.openTextLineReader("a.txt", context);

    assert.ok(opened.ok);
    assert.equal(w.app.sandboxes.leasesOf(w.a).length, 1, "the lease outlives the open call");
    await opened.value.close(context);
    assert.equal(w.app.sandboxes.leasesOf(w.a).length, 0);

    const again = await env.openTextLineReader("b.txt", context);

    assert.ok(again.ok);
    await w.app.sandboxes.turnOff(w.a, owner(w.app));
    assert.deepEqual(w.provider.closed, ["reader", "reader"], "the revoke closed the open reader");
    assert.equal(w.app.sandboxes.leasesOf(w.a).length, 0);

    // `listFiles`: a lease for as long as the call runs.
    await w.app.sandboxes.turnOn(w.a, owner(w.app));
    const hold = gate();

    w.provider.holdList = hold;
    const listing = w.app.envFor(w.a).listFiles!(w.dir, undefined, context);

    await hold.reached;
    assert.deepEqual(
        w.app.sandboxes.leasesOf(w.a).map((lease) => lease.kind),
        ["file"],
    );
    hold.open();
    await listing;
    assert.equal(w.app.sandboxes.leasesOf(w.a).length, 0);
});

test("a plain tree's reader holds a host lease, so a turn-on sees it", async () => {
    const provider = new FakeProvider();
    const app = await openApp(
        scriptedModel(),
        join(root, `data-review-${++opened}`),
        undefined,
        undefined,
        sandboxOptions(),
    );

    apps.push(app);
    await app.sandboxes.register(provider, "fake.ts");
    const dir = join(root, "review-plain-reader");

    mkdirSync(dir);
    writeFileSync(join(dir, "a.txt"), "a\n");
    const id = await newSession(app, dir);
    const reader = await app.envFor(id).openTextLineReader(join(dir, "a.txt"), context);

    assert.ok(reader.ok);
    await assert.rejects(app.sandboxes.turnOn(id, owner(app)), /openTextLineReader/);
    await reader.value.close(context);
    await app.sandboxes.turnOn(id, owner(app));
});

test("a host tool of a plain tree that shares a sandboxed folder is blocked at the grant, as a delivery is", async () => {
    const w = await world("host-tool");
    const other = join(root, "review-host-tool-other");

    mkdirSync(other);
    const plain = await newSession(w.app, other);

    // A plain session that came into the sandboxed folder some other way (an older build): both stores.
    await w.app.harness.commit(async (tx) => {
        (await tx.doc(SessionsDoc)).items[String(plain)]!.cwd = w.dir;
        (await tx.doc(AgentDoc, plain)).cwd = w.dir;
    }, context);

    assert.equal(w.app.sandboxes.deliver(plain).ok, false, "delivery is refused");
    assert.match(
        (await w.app.sandboxes.beforeTool(plain, "t1", "mcp__x__y", {})) ?? "",
        /sandbox/,
        "so is a host tool grant",
    );
    assert.equal(w.app.sandboxes.leasesOf(plain).length, 0);
    // Also a call that needs no host lease: the group breaks I1 for every call of this tree.
    assert.match((await w.app.sandboxes.beforeTool(plain, "t2", "ask", {})) ?? "", /sandbox/);
});

test("a worktree whose removal admission refuses is not deleted, and nothing is stopped", async () => {
    const w = await world("worktree");
    const repo = join(root, "review-repo");
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });

    mkdirSync(join(repo, "app"), { recursive: true });
    git("init", "-q");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "T");
    writeFileSync(join(repo, "app", "main.ts"), "x\n");
    git("add", "-A");
    git("commit", "-qm", "init");
    // A plain session already works in the folder the worktree came from.
    await newSession(w.app, join(repo, "app"));
    const made = await w.app.commands.createSession(owner(w.app), {
        cwd: join(repo, "app"),
        worktree: true,
    });
    const worktree = w.app.sessionMeta(made.id)!.worktree!;

    await w.app.sandboxes.turnOn(made.id, owner(w.app));
    await assert.rejects(
        w.app.commands.removeWorktree(made.id, owner(w.app), true),
        /without a sandbox/,
    );
    assert.equal(existsSync(worktree.path), true, "the folder is still there");
    assert.deepEqual(w.provider.released, [], "no VM was stopped");
    assert.equal(w.app.sandboxes.phaseOf(made.id), "stable");
    assert.equal(w.app.sessionMeta(made.id)?.worktree?.path, worktree.path);
});

/** A timer that a test fires by hand, and that ends early when its signal aborts, as the real one does. */
function manualTimer() {
    let fire!: () => void;
    const fired = new Promise<void>((resolve) => (fire = resolve));

    return {
        fire,
        timer: (_ms: number, signal: AbortSignal) =>
            Promise.race([
                fired,
                new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve())),
            ]),
    };
}

async function timedWorld(name: string) {
    const clock = manualTimer();
    const provider = new FakeProvider();
    const app = await openApp(
        scriptedModel(),
        join(root, `data-review-${++opened}`),
        undefined,
        undefined,
        sandboxOptions({ timer: clock.timer }),
    );

    apps.push(app);
    await app.sandboxes.register(provider, "fake.ts");
    const dir = join(root, `review-${name}`);

    mkdirSync(dir, { recursive: true });
    const a = await newSession(app, dir);

    await app.sandboxes.turnOn(a, owner(app));

    return { app, provider, dir, a, fire: clock.fire };
}

test("one bound covers the whole release: a revoke handler that never settles leaves the tree suspended", async () => {
    const w = await timedWorld("bound-revoke");
    const lease = await w.app.sandboxes.lease(w.a, {
        kind: "call",
        revoke: () => new Promise(() => {}),
    });
    const off = w.app.sandboxes.turnOff(w.a, owner(w.app));
    const failed = assert.rejects(off, /did not finish in time/);

    await new Promise((resolve) => setImmediate(resolve));
    w.fire();
    await failed;
    assert.equal(w.app.sandboxes.phaseOf(w.a), "suspended");
    lease.end();
});

test("a provider that never closes leaves turn-off suspended, and shutdown still ends", async () => {
    const w = await timedWorld("bound-provider");

    w.provider.holdRelease = gate();
    const off = w.app.sandboxes.turnOff(w.a, owner(w.app));
    const failed = assert.rejects(off, /did not finish in time/);

    await w.provider.holdRelease.reached;
    w.fire();
    await failed;
    assert.equal(w.app.sandboxes.phaseOf(w.a), "suspended");
    // The bound has run out already: shutdown asks again and is bounded too (the fake timer fires at once).
    await w.app.sandboxes.shutdown();
});

test("a change of the rules finishes only its own transition: a suspension that a failed release left stays", async () => {
    const w = await world("rules-own");

    w.provider.failRelease = "stuck";
    await assert.rejects(w.app.sandboxes.turnOff(w.a, owner(w.app)), /stuck/);
    w.provider.failRelease = undefined;
    const reason = () => (w.app.sandboxes.phaseOf(w.a) === "suspended" ? "suspended" : "other");

    assert.equal(reason(), "suspended");
    await w.app.sandboxes.rules("settings changed");
    assert.equal(
        w.app.sandboxes.phaseOf(w.a),
        "suspended",
        "rules did not reopen a stopped session",
    );
    assert.equal(await exec(w.app, w.a), false);
    await w.app.sandboxes.resume(w.a);
    assert.equal(await exec(w.app, w.a), true);

    // A module teardown under way is not cleared by the rules either.
    const hold = gate();

    w.provider.holdRelease = hold;
    const leaving = w.app.sandboxes.suspendOwner("fake.ts", false);

    await hold.reached;
    await w.app.sandboxes.rules("settings changed again");
    assert.equal(w.app.sandboxes.phaseOf(w.a), "suspended");
    hold.open();
    await leaving;
});

test("a wait for a deferred delivery leaves no abort listener behind, however often it tries", async () => {
    const { untilDelivered, Deferred } = await import("../src/server/deliver.ts");
    const { getEventListeners } = await import("node:events");
    const stop = new AbortController();
    let tries = 0;

    await untilDelivered(
        async () => {
            if (++tries < 4) {
                throw new Deferred("Changing.", 1);
            }

            return "sent";
        },
        { abortSignal: stop.signal } as never,
    );
    assert.equal(tries, 4);
    assert.equal(getEventListeners(stop.signal, "abort").length, 0);
});
