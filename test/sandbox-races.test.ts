// One race test for each row of the entry-point table (design 2.4): a change of the sandbox is held half way by a gate in
// the fake provider, the entry point runs meanwhile, and the test says what it did: refused, deferred, or admitted
// into the state the change leaves. No test waits on time. Rows that need the real subagent or linked-session flows are
// marked; the rest run through the real app.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { AgentDoc } from "@earendil-works/pi-durable";
import type { ConversationId } from "@earendil-works/pi-durable";
import { SandboxDoc, ScheduleDoc, SessionsDoc, SubagentsDoc } from "../src/server/docs.ts";
import { READINESS_COMPONENTS } from "../src/server/sandbox.ts";
import {
    cleanUp,
    context,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
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

/** An app with a fake provider, and a session `a` that runs in a sandbox in a folder of its own. */
async function world(name: string, options: Parameters<typeof sandboxOptions>[0] = {}) {
    const provider = new FakeProvider();
    const app = await openApp(
        scriptedModel(),
        join(root, `data-races-${++opened}`),
        undefined,
        undefined,
        sandboxOptions(options),
    );

    apps.push(app);
    await app.sandboxes.register(provider, "fake.ts");
    const dir = join(root, `races-${name}`);

    mkdirSync(dir, { recursive: true });
    const a = await newSession(app, dir);

    await app.sandboxes.turnOn(a, owner(app));

    return { app, provider, dir, a };
}

const on = (app: App, id: ConversationId) =>
    app.harness.snapshot(SandboxDoc, id, context).then((doc) => doc?.on === true);

/** Both stores of a session's folder, which must agree (I6). */
async function folders(app: App, id: ConversationId) {
    return {
        entry: ((await app.harness.snapshot(SessionsDoc, context))?.items ?? {})[String(id)]?.cwd,
        agent: (await app.harness.snapshot(AgentDoc, id, context))?.cwd,
    };
}

/** Turn `a` off, and hold it in the middle of its release; `finish` lets it end. */
async function turningOff(w: Awaited<ReturnType<typeof world>>) {
    const hold = gate();

    w.provider.holdRelease = hold;
    const off = w.app.sandboxes.turnOff(w.a, owner(w.app));

    await hold.reached;
    assert.equal(w.app.sandboxes.phaseOf(w.a), "turning-off");

    return {
        finish: async () => {
            hold.open();
            await off;
            w.provider.holdRelease = undefined;
        },
    };
}

const UNDER_WAY = /under way/;

test("row: create joins the sandbox of its folder, and is refused while the group changes", async () => {
    const w = await world("create");
    const joined = await w.app.commands.createSession(owner(w.app), { cwd: w.dir });

    assert.equal(
        await on(w.app, joined.id),
        true,
        "a new session in a sandboxed folder is sandboxed",
    );
    assert.deepEqual(await folders(w.app, joined.id), { entry: w.dir, agent: w.dir });
    await w.app.sandboxes.turnOff(joined.id, owner(w.app)).catch(() => {});

    const held = await world("create-held");
    const off = await turningOff(held);

    await assert.rejects(
        held.app.commands.createSession(owner(held.app), { cwd: held.dir }),
        UNDER_WAY,
    );
    await off.finish();
    const plain = await held.app.commands.createSession(owner(held.app), { cwd: held.dir });

    assert.equal(
        await on(held.app, plain.id),
        false,
        "after the turn-off it is plain, beside a plain tree",
    );
});

test("row: fork copies its source's sandbox in the commit that makes it, and is refused while the group changes", async () => {
    const w = await world("fork");
    const fork = await w.app.commands.fork(w.a, owner(w.app), {});

    assert.equal(await on(w.app, fork.id), true);

    const held = await world("fork-held");
    const off = await turningOff(held);

    await assert.rejects(held.app.commands.fork(held.a, owner(held.app), {}), UNDER_WAY);
    await off.finish();
});

/** A Pi session file in the terminal's folder for `dir`, as Pi writes it; its path. */
function terminalSession(dir: string, name: string): string {
    const manager = SessionManager.inMemory(dir);

    manager.appendMessage({ role: "user", content: "hello", timestamp: 1 });
    const folder = join(process.env.PI_CODING_AGENT_DIR!, "sessions", `--${name}--`);
    const path = join(folder, `${name}.jsonl`);

    mkdirSync(folder, { recursive: true });
    writeFileSync(
        path,
        [manager.getHeader(), ...manager.getEntries()]
            .map((entry) => JSON.stringify(entry))
            .join("\n") + "\n",
    );

    return path;
}

test("row: terminal continue joins like a new session, and is refused while the group changes", async () => {
    const w = await world("continue");
    const { id } = await w.app.commands.continuePiSession(
        owner(w.app),
        terminalSession(w.dir, "continue-one"),
    );

    assert.equal(await on(w.app, id), true, "continued in a sandboxed folder: sandboxed");

    const held = await world("continue-held");
    const off = await turningOff(held);

    await assert.rejects(
        held.app.commands.continuePiSession(
            owner(held.app),
            terminalSession(held.dir, "continue-two"),
        ),
        UNDER_WAY,
    );
    await off.finish();
});

test("the delivery wrapper checks inside the delivering commit, in every phase, and writes nothing when it defers", async () => {
    const w = await world("subagent-delivery");
    const log: string[] = [];
    const conversation = {
        id: w.a,
        submit: (first: unknown) => {
            // The commit form places the message; the plain form finds it again by its request id.
            log.push(
                typeof first === "object" && first !== null && "type" in first ? "found" : "queued",
            );

            return Promise.resolve({ id: 1 });
        },
    };
    const { submitNow } = await import("../src/server/deliver.ts");
    const attempt = () =>
        submitNow(
            (id) => {
                log.push("check");
                w.app.sandboxes.requireDelivery(id);
            },
            async (change) => {
                log.push("commit starts");
                await change({} as never);
                log.push("commit ends");
            },
            conversation as never,
            { type: "input", content: "report", requestId: "r1" },
            context,
        );

    await attempt();
    assert.deepEqual(
        log,
        ["commit starts", "check", "queued", "commit ends", "found"],
        "the check is in the commit",
    );
    log.length = 0;

    const off = await turningOff(w);

    await assert.rejects(attempt(), /Nothing was sent/);
    assert.deepEqual(log, ["commit starts", "check"], "nothing was queued");
    await off.finish();
    log.length = 0;
    w.provider.failRelease = "stuck";
    await w.app.sandboxes.turnOn(w.a, owner(w.app));
    await assert.rejects(w.app.sandboxes.turnOff(w.a, owner(w.app)), /stuck/);
    assert.equal(w.app.sandboxes.phaseOf(w.a), "suspended");
    await assert.rejects(attempt(), /suspended/);
    assert.ok(!log.includes("queued"), "nothing was sent while suspended");
    w.provider.failRelease = undefined;
    await w.app.sandboxes.resume(w.a);
    log.length = 0;
    await attempt();
    assert.ok(log.includes("queued"));
});

test("row: the first message of an extension's session comes after its join, and a changing group stops both", async () => {
    const w = await world("extension-session");
    const sourceDir = join(root, "races-extension-source");

    mkdirSync(sourceDir, { recursive: true });
    const source = await newSession(w.app, sourceDir);

    await say(w.app, source, "hello");
    const started = await w.app.extensionSessions.start(
        source,
        { cwd: w.dir, message: "first message", title: "ext" },
        "key-1",
    );

    assert.equal(
        await on(w.app, started.session),
        true,
        "joined the sandbox before its first message",
    );

    const held = await world("extension-session-held");
    const heldSource = await newSession(held.app, sourceDir);

    await say(held.app, heldSource, "hello");
    const off = await turningOff(held);

    await assert.rejects(
        held.app.extensionSessions.start(
            heldSource,
            { cwd: held.dir, message: "second", title: "ext2" },
            "key-2",
        ),
        UNDER_WAY,
    );
    await off.finish();
});

test("row: a linked start inherits its starter's sandbox, in the starter's folder, and is refused while it changes", async () => {
    const w = await world("linked-start");

    await say(w.app, w.a, "hello");
    const { session } = await w.app.linkedSessions.start(
        w.a,
        { title: "Linked", message: "a task" },
        "k1",
    );

    assert.equal(await on(w.app, session), true);
    const other = join(root, "races-linked-other");

    mkdirSync(other, { recursive: true });
    await assert.rejects(
        w.app.linkedSessions.start(w.a, { title: "Other", message: "x", cwd: other }, "k2"),
        /works in its folder/,
    );

    const held = await world("linked-start-held");

    await say(held.app, held.a, "hello");
    const off = await turningOff(held);

    await assert.rejects(
        held.app.linkedSessions.start(held.a, { title: "Again", message: "x" }, "k3"),
        UNDER_WAY,
    );
    await off.finish();
});

test("row: a subagent joins its session's tree, and is refused while the sandbox changes", async () => {
    const w = await world("child");

    await w.app.harness.commit(
        (tx) => w.app.sandboxes.admit(tx, { kind: "child", parent: w.a }),
        context,
    );
    const off = await turningOff(w);

    await assert.rejects(
        w.app.harness.commit(
            (tx) => w.app.sandboxes.admit(tx, { kind: "child", parent: w.a }),
            context,
        ),
        /changing/,
    );
    await off.finish();
});

test("row: a move reserves the old and the new group, releases first, and writes both folders in one commit", async () => {
    const w = await world("move");
    const target = join(root, "races-move-target");

    mkdirSync(target, { recursive: true });
    const hold = gate();

    w.provider.holdRelease = hold;
    const moving = w.app.commands.configure(w.a, owner(w.app), { cwd: target });

    await hold.reached;
    assert.equal(w.app.sandboxes.phaseOf(w.a), "moving");
    // Both groups are reserved: a join of either folder is refused meanwhile.
    await assert.rejects(w.app.commands.createSession(owner(w.app), { cwd: w.dir }), UNDER_WAY);
    await assert.rejects(w.app.commands.createSession(owner(w.app), { cwd: target }), UNDER_WAY);
    assert.deepEqual(
        await folders(w.app, w.a),
        { entry: w.dir, agent: w.dir },
        "nothing moved before the release",
    );
    hold.open();
    await moving;
    w.provider.holdRelease = undefined;
    assert.deepEqual(await folders(w.app, w.a), { entry: target, agent: target });
    assert.equal(w.app.sandboxes.phaseOf(w.a), "stable");
    assert.equal(await on(w.app, w.a), true);
});

test("row: a move into a plain folder is refused before anything is stopped, and leaves the session as it was", async () => {
    const w = await world("move-mixed");
    const target = join(root, "races-move-mixed-target");

    mkdirSync(target, { recursive: true });
    // A plain session works there already (no sandbox exists in its group).
    const plain = await newSession(w.app, target);

    await assert.rejects(
        w.app.commands.configure(w.a, owner(w.app), { cwd: target }),
        /without a sandbox/,
    );
    assert.deepEqual(
        w.provider.released,
        [],
        "the VM was not stopped for a move that admission refuses",
    );
    assert.deepEqual(await folders(w.app, w.a), { entry: w.dir, agent: w.dir });
    assert.equal(w.app.sandboxes.phaseOf(w.a), "stable");
    assert.equal(await on(w.app, plain), false);
});

test("row: a subagent's move stays inside its sandboxed session's folder, and goes through admission", async () => {
    const w = await world("subagent-move");
    const outside = join(root, "races-subagent-outside");

    mkdirSync(outside);
    mkdirSync(join(w.dir, "sub"));
    const child = await w.app.harness.createConversation(
        { ownership: { kind: "ownerless" }, agent: { cwd: w.dir } },
        context,
    );

    await w.app.harness.commit(async (tx) => {
        (await tx.doc(SubagentsDoc, w.a)).agents.helper = {
            conversationId: child.id,
            reported: [],
        };
    }, context);
    assert.equal(w.app.rootOf(child.id), w.a);
    await assert.rejects(
        w.app.commands.configure(child.id, owner(w.app), { cwd: outside }),
        /inside the session's folder/,
    );
    await w.app.commands.configure(child.id, owner(w.app), { cwd: join(w.dir, "sub") });
    assert.deepEqual(await folders(w.app, child.id), {
        entry: undefined,
        agent: join(w.dir, "sub"),
    });
    assert.deepEqual(await folders(w.app, w.a), { entry: w.dir, agent: w.dir });
});

test("row: a session in a sandboxed folder reads no project model default", async () => {
    const w = await world("model-default");
    const settings = join(w.dir, ".pi");

    mkdirSync(settings, { recursive: true });
    writeFileSync(
        join(settings, "settings.json"),
        JSON.stringify({ defaultProvider: "faux", defaultModel: "faux-2" }),
    );
    w.app.config.defaultModel = undefined;
    w.app.config.lastModel = { provider: "faux", modelId: "faux-1", thinkingLevel: "off" };
    const made = await w.app.commands.createSession(owner(w.app), { cwd: w.dir });

    assert.equal(await on(w.app, made.id), true);
    assert.equal(
        (await w.app.agentState(made.id))?.model?.modelId,
        "faux-1",
        "the project file was not read",
    );
});

/** A git repository with a folder `app`, for the worktree rows. */
function repository(name: string): string {
    const repo = join(root, `races-repo-${name}`);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });

    mkdirSync(join(repo, "app"), { recursive: true });
    git("init", "-q");
    git("config", "core.autocrlf", "false");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "T");
    writeFileSync(join(repo, "app", "main.ts"), "export const answer = 1;\n");
    git("add", "-A");
    git("commit", "-qm", "init");

    return repo;
}

test("row: a worktree is a new session in a folder of its own, outside the sandboxed folder it came from", async () => {
    const w = await world("worktree-add");
    const repo = repository("add");
    const source = await newSession(w.app, join(repo, "app"));

    await w.app.sandboxes.turnOn(source, owner(w.app));
    const made = await w.app.commands.createSession(owner(w.app), {
        cwd: join(repo, "app"),
        worktree: true,
    });
    const worktree = w.app.sessionMeta(made.id)!.worktree!;

    assert.ok(worktree.path.startsWith(join(root, `data-races-${opened}`, "worktrees")));
    assert.deepEqual(await folders(w.app, made.id), {
        entry: join(worktree.path, "app"),
        agent: join(worktree.path, "app"),
    });
    assert.equal(await on(w.app, made.id), false, "the worktree is its own group");
});

test("row: removing a worktree releases the VM first, deletes the folder only after, and writes both folders at once", async () => {
    const w = await world("worktree-remove");
    const repo = repository("remove");
    const made = await w.app.commands.createSession(owner(w.app), {
        cwd: join(repo, "app"),
        worktree: true,
    });
    const worktree = w.app.sessionMeta(made.id)!.worktree!;

    await w.app.sandboxes.turnOn(made.id, owner(w.app));
    const hold = gate();

    w.provider.holdRelease = hold;
    const removing = w.app.commands.removeWorktree(made.id, owner(w.app), true);

    await hold.reached;
    assert.equal(w.app.sandboxes.phaseOf(made.id), "moving");
    assert.equal(existsSync(worktree.path), true, "the folder stays until the release is proved");
    hold.open();
    await removing;
    w.provider.holdRelease = undefined;
    assert.equal(existsSync(worktree.path), false);
    assert.deepEqual(await folders(w.app, made.id), {
        entry: join(repo, "app"),
        agent: join(repo, "app"),
    });
    assert.equal(await on(w.app, made.id), true);
});

test("row: archive releases the VM before the flag is written, and a tree with no work leaves its group", async () => {
    const w = await world("archive");
    const hold = gate();

    w.provider.holdRelease = hold;
    const archiving = w.app.commands.updateSession(w.a, owner(w.app), { archived: true });

    await hold.reached;
    assert.equal(w.app.sessionMeta(w.a)?.archived, undefined, "not archived before the release");
    await assert.rejects(w.app.commands.createSession(owner(w.app), { cwd: w.dir }), UNDER_WAY);
    hold.open();
    await archiving;
    w.provider.holdRelease = undefined;
    assert.equal(w.app.sessionMeta(w.a)?.archived, true);
    assert.deepEqual(w.provider.released, [Number(w.a)]);
    // It has no work: it left the group, so a plain session may use the folder.
    const plain = await w.app.commands.createSession(owner(w.app), { cwd: w.dir });

    assert.equal(await on(w.app, plain.id), false);
});

test("row: unarchive is a whole join, and is refused when the group would mix", async () => {
    const w = await world("unarchive");

    await w.app.commands.updateSession(w.a, owner(w.app), { archived: true });
    const plain = await w.app.commands.createSession(owner(w.app), { cwd: w.dir });

    await assert.rejects(
        w.app.commands.updateSession(w.a, owner(w.app), { archived: false }),
        /cannot be brought back/,
    );
    assert.equal(w.app.sessionMeta(w.a)?.archived, true);
    await w.app.commands.updateSession(plain.id, owner(w.app), { archived: true });
    await w.app.commands.updateSession(w.a, owner(w.app), { archived: false });
    assert.notEqual(w.app.sessionMeta(w.a)?.archived, true);
});

test("row: a linked archive and unarchive use the same admission, and release first", async () => {
    const w = await world("linked-archive");

    await say(w.app, w.a, "hello");
    const { session, address } = await w.app.linkedSessions.start(
        w.a,
        { title: "Linked", message: "a task" },
        "start",
    );
    const hold = gate();

    w.provider.holdRelease = hold;
    // The linked session is sandboxed too: archiving it stops the VM of its own tree first.
    const archiving = w.app.linkedSessions.archive(w.a, { to: address }, "archive-1");

    await hold.reached;
    assert.equal(w.app.sessionMeta(session)?.archived, undefined);
    hold.open();
    await archiving;
    w.provider.holdRelease = undefined;
    assert.equal(w.app.sessionMeta(session)?.archived, true);
    assert.ok(w.provider.released.includes(Number(session)));
    await w.app.linkedSessions.archive(w.a, { to: address, archived: false }, "archive-2");
    assert.notEqual(w.app.sessionMeta(session)?.archived, true);
});

test("row: removal needs an archived session, and releases the VM before anything is deleted", async () => {
    const w = await world("remove");
    const made = await w.app.commands.createSession(owner(w.app), { cwd: w.dir });

    assert.equal(await on(w.app, made.id), true);
    // Both are archived: removing one at a time, the second sandboxed session is a group of its own.
    await w.app.commands.updateSession(made.id, owner(w.app), { archived: true });
    const hold = gate();

    w.provider.holdRelease = hold;
    const removing = w.app.sessionCleanup.remove(owner(w.app).id, [made.id]);

    await hold.reached;
    assert.ok(
        w.app.sessionMeta(made.id) !== undefined,
        "its entry stays until the release is proved",
    );
    hold.open();
    const [outcome] = await removing;

    w.provider.holdRelease = undefined;
    assert.equal(outcome?.done, true);
    assert.equal(w.app.sessionMeta(made.id), undefined);
});

test("row: work on an archived session is admitted, and an archived tree with work stays in its group", async () => {
    const w = await world("work");

    // A repeating schedule: the tree is live after its archive.
    await w.app.commands.schedule(w.a, owner(w.app), { when: "every 2 hours check" });
    await w.app.commands.updateSession(w.a, owner(w.app), { archived: true });
    const joined = await w.app.commands.createSession(owner(w.app), { cwd: w.dir });

    assert.equal(
        await on(w.app, joined.id),
        true,
        "the archived tree still counts: a new session must be sandboxed",
    );

    // A plain archived session that gains work in a sandboxed group is refused.
    const lone = join(root, "races-work-plain");

    mkdirSync(lone);
    const plain = await newSession(w.app, lone);

    await w.app.commands.updateSession(plain, owner(w.app), { archived: true });
    // The sandboxed tree takes its folder... a plain session cannot come back into it.
    const clash = await newSession(w.app, lone);

    void clash;
    await w.app.sandboxes.turnOn(clash, owner(w.app));
    await assert.rejects(
        w.app.commands.schedule(plain, owner(w.app), { when: "every 2 hours check" }),
        /live again beside others/,
    );
});

test("row: a plain move with a surviving task keeps the old folder in its group", async () => {
    const provider = new FakeProvider();
    const app = await openApp(
        scriptedModel(),
        join(root, `data-races-${++opened}`),
        undefined,
        undefined,
        sandboxOptions(),
    );

    apps.push(app);
    await app.sandboxes.register(provider, "fake.ts");
    const from = join(root, "races-task-from");
    const to = join(root, "races-task-to");

    mkdirSync(from);
    mkdirSync(to);
    const plain = await newSession(app, from);

    // A task that outlives its call is bound to the folder it started in (`background.ts` keeps its record).
    app.sandboxes.noteDoc("pocket.background", plain, {
        items: {
            t1: { id: "t1", status: "running", command: "npm run watch", cwd: from, notify: false },
        },
    });
    // No sandbox exists: the move is allowed, and the old folder stays in the tree's group.
    await app.commands.configure(plain, owner(app), { cwd: to });
    assert.equal(app.cwdOf(plain), to);
    const other = await newSession(app, from);

    await assert.rejects(app.sandboxes.turnOn(other, owner(app)), /background task/);
    // Once the task ends, the folder is free.
    app.sandboxes.noteDoc("pocket.background", plain, { items: {} });
    await app.sandboxes.turnOn(other, owner(app));
    assert.equal(app.sandboxes.isOn(other), true);
});

test("row: turn-off checks the overlap before it revokes anything, and two changes of one tree do not overlap", async () => {
    const w = await world("onoff");
    const joined = await w.app.commands.createSession(owner(w.app), { cwd: w.dir });

    // Another sandboxed session shares the folder: turning this one off would leave a plain session beside it.
    await assert.rejects(w.app.sandboxes.turnOff(w.a, owner(w.app)), /in a sandbox and use/);
    assert.deepEqual(w.provider.released, [], "nothing was revoked");
    assert.equal(w.app.sandboxes.phaseOf(w.a), "stable");
    // The way out is to archive the others: an archived tree with no work leaves the group.
    await w.app.commands.updateSession(joined.id, owner(w.app), { archived: true });

    const off = await turningOff(w);

    await assert.rejects(w.app.sandboxes.turnOff(w.a, owner(w.app)), /changing/);
    await off.finish();
    assert.equal(await on(w.app, w.a), false);
});

test("row: turn-on refuses a plain session in the folder, and a join during the turn-on ends sandboxed, never plain", async () => {
    const provider = new FakeProvider();
    const app = await openApp(
        scriptedModel(),
        join(root, `data-races-${++opened}`),
        undefined,
        undefined,
        sandboxOptions(),
    );

    apps.push(app);
    await app.sandboxes.register(provider, "fake.ts");
    const dir = join(root, "races-turn-on");

    mkdirSync(dir);
    const first = await newSession(app, dir);
    const second = await newSession(app, dir);

    await assert.rejects(app.sandboxes.turnOn(first, owner(app)), /without a sandbox/);
    await app.harness.commit(
        (tx) => app.sandboxes.admit(tx, { kind: "off", id: second, user: owner(app) }),
        context,
    );
    await app.commands.updateSession(second, owner(app), { archived: true });
    // Hold the commit of the turn-on: the phase is `turning-on` and the folder is reserved.
    const hold = gate();
    const commit = app.harness.commit.bind(app.harness);

    app.harness.commit = (async (...args: Parameters<typeof commit>) => {
        app.harness.commit = commit;
        await hold.wait();

        return commit(...args);
    }) as typeof commit;
    const turning = app.sandboxes.turnOn(first, owner(app));

    await hold.reached;
    assert.equal(app.sandboxes.phaseOf(first), "turning-on");
    const joining = app.commands.createSession(owner(app), { cwd: dir });

    hold.open();
    await turning;
    const joined = await joining.catch((error: Error) => error);

    // Either it waited and joined the sandbox, or it was refused: never a plain session beside a sandboxed one.
    assert.ok(
        joined instanceof Error ? /under way/.test(joined.message) : await on(app, joined.id),
    );
});

test("row: a change of the rules stops every call at once, then checks the trusted places again", async () => {
    let refuse: string | undefined;
    const w = await world("rules", { trusted: () => refuse });
    const runs = async () => (await w.app.envFor(w.a).exec("x", undefined, context)).ok;

    assert.equal(await runs(), true);
    // Settings or an MCP file changed so that the folder is now reachable: the tree is suspended, with the reason.
    refuse = "a trusted place now reaches this folder";
    const changing = w.app.sandboxes.rules("mcp.json changed");

    assert.equal(w.app.sandboxes.phaseOf(w.a), "suspended", "stopped before the check ends");
    assert.equal(await runs(), false);
    await changing;
    assert.equal(w.app.sandboxes.phaseOf(w.a), "suspended");
    // Clear again: the owner resumes it.
    refuse = undefined;
    await w.app.sandboxes.resume(w.a);
    assert.equal(await runs(), true);
    // Stricter rules stop a looser VM before a new call can use it.
    w.provider.stricterNow = true;
    await w.app.sandboxes.rules("the module's settings");
    assert.equal(w.app.sandboxes.phaseOf(w.a), "stable");
    assert.deepEqual(w.provider.released.slice(-1), [Number(w.a)]);
});

test("row: settings of the module serving the sandbox run the rules transition before the module hears of them", async () => {
    const w = await world("settings");
    const heard: string[] = [];

    w.app.sandboxes.rulesOf("other.ts", () => heard.push("other"));
    assert.deepEqual(heard, ["other"], "another module hears at once");
    w.provider.stricterNow = true;
    let done!: () => void;
    const told = new Promise<void>((resolve) => (done = resolve));

    w.app.sandboxes.rulesOf("fake.ts", () => {
        heard.push(`fake after ${w.provider.released.length} releases`);
        done();
    });
    assert.equal(w.app.sandboxes.phaseOf(w.a), "suspended", "stopped at once");
    await told;
    assert.deepEqual(heard, ["other", "fake after 1 releases"]);
});

test("row: a module that comes on reconciles: registration waits for the old teardown and lets suspended trees go on", async () => {
    const w = await world("enable");
    const hold = gate();

    w.provider.holdRelease = hold;
    const leaving = w.app.sandboxes.suspendOwner("fake.ts", false);

    await hold.reached;
    assert.equal(w.app.sandboxes.phaseOf(w.a), "suspended");
    assert.match(
        (await w.app.envFor(w.a).exec("x", undefined, context)).ok ? "ran" : "failed at once",
        /failed at once/,
    );
    const second = new FakeProvider();
    let registered = false;
    const registering = w.app.sandboxes.register(second, "fake.ts").then(() => (registered = true));

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(registered, false, "the new provider waits for the old one's teardown");
    hold.open();
    await leaving;
    await registering;
    // A reload's registration is only staged: the loader commits it once the new version is installed.
    assert.equal(w.app.sandboxes.provider, w.provider, "staged, not installed yet");
    await w.app.sandboxes.reloadCommitted("fake.ts");
    assert.equal(w.app.sandboxes.provider, second);
    assert.equal(w.app.sandboxes.phaseOf(w.a), "stable", "reconciled");
    assert.equal((await w.app.envFor(w.a).exec("x", undefined, context)).ok, true);
    assert.deepEqual(second.ran, ["x"], "the newest registration serves");
});

test("row: server start audits stored sandboxes: not ready means suspended, and a mixed group blocks every VM", async () => {
    const data = join(root, `data-races-${++opened}`);
    const dir = join(root, "races-restart");
    const other = join(root, "races-restart-other");

    mkdirSync(dir);
    mkdirSync(other);
    const first = await openApp(scriptedModel(), data, undefined, undefined, sandboxOptions());

    await first.sandboxes.register(new FakeProvider(), "fake.ts");
    const a = await newSession(first, dir);
    const plain = await newSession(first, other);

    await first.sandboxes.turnOn(a, owner(first));
    // A plain session that came to the folder some other way (an older build): both stores, bypassing admission.
    await first.harness.commit(async (tx) => {
        const entry = (await tx.doc(SessionsDoc)).items[String(plain)]!;

        entry.cwd = dir;
        (await tx.doc(AgentDoc, plain)).cwd = dir;
    }, context);
    await first.close();

    // The stored doc is on, the gate is not met: suspended. The folder is mixed: no VM starts either.
    const second = await openApp(scriptedModel(), data, undefined, undefined, {
        sandbox: { platform: "linux" },
    });

    apps.push(second);
    assert.equal(second.sandboxes.isOn(a), true);
    assert.equal(second.sandboxes.phaseOf(a), "suspended");
    const result = await second.envFor(a).exec("x", undefined, context);

    assert.ok(!result.ok && /suspended.*not available yet/.test(result.error.message));
    await second.close();

    const third = await openApp(scriptedModel(), data, undefined, undefined, sandboxOptions());
    const provider = new FakeProvider();

    apps.push(third);
    await third.sandboxes.register(provider, "fake.ts");
    assert.equal(third.sandboxes.phaseOf(a), "stable");
    const blocked = await third.envFor(a).exec("x", undefined, context);

    assert.ok(
        !blocked.ok && /blocked until this is fixed/.test(blocked.error.message),
        "a mixed group blocks VMs",
    );
    assert.deepEqual(provider.ran, []);
});

test("row: server shutdown revokes every sandbox and proves it gone", async () => {
    const w = await world("shutdown");

    await w.app.close();
    assert.deepEqual(w.provider.released, [Number(w.a)]);
});

test("row: a schedule that comes due while its tree is suspended defers, keeps its item and request id, and goes out after", async () => {
    const data = join(root, `data-races-${++opened}`);
    const dir = join(root, "races-schedule-delivery");

    mkdirSync(dir);
    const first = await openApp(scriptedModel(), data, undefined, undefined, sandboxOptions());

    await first.sandboxes.register(new FakeProvider(), "fake.ts");
    const a = await newSession(first, dir);

    await first.sandboxes.turnOn(a, owner(first));
    const made = await first.commands.schedule(a, owner(first), {
        when: "in 10m ping",
        zone: "UTC",
    });

    await first.close();
    // Eleven minutes on, with the gate not met: the tree starts suspended, and the schedule is due.
    const offset = 11 * 60_000;
    const second = await openApp(scriptedModel(), data, () => Date.now() + offset, undefined, {
        sandbox: {
            platform: "linux",
            deferMs: 20,
            trustedPlaces: { check: () => Promise.resolve(undefined) },
        },
    });

    apps.push(second);
    const items = async () =>
        Object.values((await second.harness.snapshot(ScheduleDoc, a, context))?.items ?? {});
    const texts = async () =>
        (
            await (await second.harness.conversation(a, context))!.entries(
                {},
                100,
                undefined,
                context,
            )
        ).items
            .filter((entry) => entry.kind === "pi.user")
            .map((entry) => JSON.stringify(entry.model));

    assert.equal(second.sandboxes.phaseOf(a), "suspended");
    await until(
        async () => ((await items())[0]?.next ?? 0) > made.next + 1_000,
        "the deferral to move the next try",
    );
    assert.equal((await items()).length, 1, "the item stays");
    assert.equal((await items())[0]!.runs, 0);
    assert.deepEqual(await texts(), [], "nothing was delivered while suspended");

    // The module comes back: the tree goes on, and the same item goes out.
    for (const component of READINESS_COMPONENTS) {
        second.sandboxes.provide(component);
    }

    await second.sandboxes.register(new FakeProvider(), "fake.ts");
    await until(async () => (await texts()).length === 1, "the delivery after the resume");
    assert.match((await texts())[0]!, /ping/);
});
