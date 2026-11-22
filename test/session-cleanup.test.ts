import {
    cleanUp,
    context,
    modelTexts,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { DeletedDoc, SessionsDoc } from "../src/server/docs.ts";
import { createHandler } from "../src/server/http.ts";

const dataDir = join(root, "data");
const repo = join(root, "repo");
let app: Awaited<ReturnType<typeof openApp>>;
let server: Server;
let base = "";
let guest = "";
const gitIn = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

async function start(): Promise<void> {
    app = await openApp(scriptedModel(), dataDir);
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

async function stop(): Promise<void> {
    server.closeAllConnections();
    server.close();
    await app.close();
}

before(async () => {
    mkdirSync(repo, { recursive: true });
    gitIn(repo, "init", "-q");
    gitIn(repo, "config", "core.autocrlf", "false");
    gitIn(repo, "config", "user.email", "t@example.com");
    gitIn(repo, "config", "user.name", "T");
    writeFileSync(join(repo, "main.ts"), "export const answer = 1;\n");
    gitIn(repo, "add", "-A");
    gitIn(repo, "commit", "-qm", "init");
    await start();
    guest = app.config.addUser("Gale", "guest").token;
});

after(async () => {
    await stop();
    cleanUp();
});

async function call(path: string, body?: unknown, token = app.config.ownerToken) {
    const response = await fetch(`${base}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
            authorization: `Bearer ${token}`,
            "x-pocket": "1",
            ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    return { status: response.status, data: (await response.json()) as Record<string, any> };
}

async function worktreeSession(title: string): Promise<ConversationId> {
    const { id } = await app.commands.createSession(owner(app), {
        cwd: repo,
        title,
        worktree: true,
    });

    await app.commands.configure(id, owner(app), {
        model: { provider: "faux", modelId: "faux-1" },
        thinkingLevel: "off",
    });

    return id;
}

function filesOf(id: ConversationId): { uploads: string; logs: string } {
    const uploads = join(dataDir, "uploads", String(id));
    const logs = join(dataDir, "background", String(id));

    mkdirSync(uploads, { recursive: true });
    mkdirSync(logs, { recursive: true });
    writeFileSync(join(uploads, "photo.png"), "x".repeat(2048));
    writeFileSync(join(logs, "abc.log.aaaaaa"), "output\n");

    return { uploads, logs };
}

const archive = (id: ConversationId) =>
    app.commands.updateSession(id, owner(app), { archived: true });

test("an archived session leaves the app with Pocket's own files; its transcript stays; a guest cannot", async () => {
    const id = await worktreeSession("Old work");
    const other = await newSession(app);
    const worktree = app.sessionMeta(id)!.worktree!;
    const files = filesOf(id);
    const removed: number[] = [];

    app.events.on("session.removed", (event) => removed.push(event.conversationId));
    await say(app, id, "hello");
    await app.schedules.add(id, { when: "in 30m", text: "later" });

    const early = await call("/api/x/session-cleanup/remove", { ids: [id] });

    assert.equal(early.data.outcomes[0].done, false);
    assert.match(early.data.outcomes[0].why, /Archive it first/);

    await archive(id);
    assert.equal((await call("/api/x/session-cleanup/plan", { ids: [id] }, guest)).status, 404);
    assert.equal((await call("/api/x/session-cleanup/remove", { ids: [id] }, guest)).status, 404);

    const [plan] = (await call("/api/x/session-cleanup/plan", { olderThanDays: 0 })).data.sessions;

    assert.equal(plan.id, id);
    assert.equal(plan.blocked, undefined);
    assert.equal(plan.worktree.state, "clean");
    assert.equal(plan.uploads.bytes, 2048);
    assert.equal(plan.ends.schedules, 1);

    assert.equal((await call(`/api/c/${id}/trust`)).status, 200);
    const done = await call("/api/x/session-cleanup/remove", { ids: [id] });

    assert.equal(done.data.outcomes[0].done, true);
    assert.ok(done.data.outcomes[0].bytes >= 2048);
    assert.deepEqual(
        app.sessions().map((session) => session.id),
        [other],
        "it left the list; the other session stays",
    );
    assert.equal((await call(`/api/c/${id}/trust`)).status, 404, "nobody opens it again");
    assert.equal(existsSync(files.uploads), false);
    assert.equal(existsSync(files.logs), false);
    assert.equal(existsSync(worktree.path), false);
    assert.match(gitIn(repo, "branch", "--list", worktree.branch), /pocket\//, "the branch stays");
    assert.deepEqual(await app.schedules.list(id), [], "its schedule ended");
    assert.deepEqual(removed, [Number(id)]);

    const record = (await app.harness.snapshot(DeletedDoc, context))!.items[String(id)]!;

    assert.ok(record.done !== undefined);
    assert.ok(record.conversations.includes(Number(id)));
    assert.ok(
        (await modelTexts(app, id)).some((text) => text.includes("hello")),
        "the transcript stays in storage for a later purge",
    );
});

test("uncommitted changes in its worktree keep a session; a live fork keeps the uploads it reads", async () => {
    const dirty = await worktreeSession("Dirty");

    writeFileSync(join(app.sessionMeta(dirty)!.worktree!.path, "wip.ts"), "unsaved\n");
    await archive(dirty);

    const [kept] = (await call("/api/x/session-cleanup/remove", { ids: [dirty] })).data.outcomes;

    assert.equal(kept.done, false);
    assert.match(kept.why, /uncommitted changes/);
    assert.ok(app.sessionMeta(dirty) !== undefined);

    // A fork of a fork stays: removing its parent and grandparent together keeps the grandparent's uploads, which it
    // still reads through the removed parent.
    const grand = await newSession(app);

    await say(app, grand, "hello");
    const forkOf = async (id: ConversationId) =>
        (
            await app.commands.fork(id, owner(app), {
                entryId: (await app.transcripts.allEntries(id, false)).at(-1)!.id,
            })
        ).id;
    const parent = await forkOf(grand);
    const child = await forkOf(parent);
    const grandFiles = filesOf(grand);
    const parentFiles = filesOf(parent);

    await archive(grand);
    await archive(parent);
    const outcomes = (await call("/api/x/session-cleanup/remove", { ids: [grand, parent] })).data
        .outcomes;

    assert.deepEqual(
        outcomes.map((outcome: { id: number; done: boolean }) => [outcome.id, outcome.done]),
        [
            [grand, true],
            [parent, true],
        ],
    );
    assert.equal(existsSync(grandFiles.uploads), true, "the fork still shows them");
    assert.equal(existsSync(parentFiles.uploads), true);
    assert.equal(existsSync(grandFiles.logs), false);
    assert.ok(app.sessionMeta(child) !== undefined);

    await archive(child);
    assert.equal((await call("/api/x/session-cleanup/remove", { ids: [child] })).status, 200);
    assert.equal(existsSync(grandFiles.uploads), false);
    assert.equal(existsSync(parentFiles.uploads), false);
});

test("a fork made while the removal checks the session keeps the uploads it reads", async () => {
    const id = await newSession(app);

    await say(app, id, "hello");
    const files = filesOf(id);
    const entryId = (await app.transcripts.allEntries(id, false)).at(-1)!.id;
    const get = app.watches.get.bind(app.watches);
    let fork: ConversationId | undefined;

    await archive(id);

    // The plan's slow steps: a person forks the session in the meantime.
    app.watches.get = async (each) => {
        fork ??= (await app.commands.fork(id, owner(app), { entryId })).id;

        return get(each);
    };

    const done = await call("/api/x/session-cleanup/remove", { ids: [id] }).finally(() => {
        app.watches.get = get;
    });

    assert.equal(done.data.outcomes[0].done, true);
    assert.ok(fork !== undefined && app.sessionMeta(fork) !== undefined);
    assert.equal(existsSync(files.uploads), true, "the fork reads them");
});

test("a fork that a removal overtakes is refused, so it never reads uploads that go", async () => {
    const id = await newSession(app);

    await say(app, id, "hello");
    const files = filesOf(id);
    const entryId = (await app.transcripts.allEntries(id, false)).at(-1)!.id;
    const agentState = app.agentState.bind(app);

    await archive(id);

    // The fork has passed its checks; the removal commits before the fork does.
    app.agentState = async (each) => {
        app.agentState = agentState;
        assert.equal((await call("/api/x/session-cleanup/remove", { ids: [id] })).status, 200);

        return agentState(each);
    };

    await assert.rejects(app.commands.fork(id, owner(app), { entryId }), { status: 409 });
    assert.equal(existsSync(files.uploads), false);
});

test("a removal that a restart cut short goes on at the next start", async () => {
    const id = await newSession(app);
    const files = filesOf(id);

    await archive(id);
    assert.equal((await call(`/api/c/${id}/trust`)).status, 200);
    // The removal's commit, as a crash right after it left it: the files are still there.
    await app.harness.commit(async (tx) => {
        const sessions = await tx.doc(SessionsDoc);
        const meta = sessions.items[String(id)]!;

        delete sessions.items[String(id)];
        (await tx.doc(DeletedDoc)).items[String(id)] = {
            cwd: meta.cwd,
            conversations: [Number(id)],
            by: owner(app).id,
            at: Date.now(),
        };
    }, context);
    await stop();
    await start();

    await until(
        async () =>
            (await app.harness.snapshot(DeletedDoc, context))?.items[String(id)]?.done !==
            undefined,
        "the removal to finish",
    );
    assert.equal(existsSync(files.uploads), false);
    assert.equal(existsSync(files.logs), false);
    assert.equal((await call(`/api/c/${id}/trust`)).status, 404, "still out of the app");
});

test("an env file that git ignores keeps a worktree, also in an ignored folder", async () => {
    const id = await worktreeSession("Secrets");
    const env = join(app.sessionMeta(id)!.worktree!.path, "deps", "a", "prod.env");

    writeFileSync(join(repo, ".git", "info", "exclude"), "deps/\n");
    mkdirSync(join(env, ".."), { recursive: true });
    writeFileSync(env, "KEY=1\n");
    await archive(id);

    const [plan] = (await call("/api/x/session-cleanup/plan", { ids: [id] })).data.sessions;
    const [kept] = (await call("/api/x/session-cleanup/clean-up", { ids: [id] })).data.outcomes;
    const [stays] = (await call("/api/x/session-cleanup/remove", { ids: [id] })).data.outcomes;

    assert.equal(plan.worktree.state, "env");
    assert.match(kept.why, /env file that git ignores/);
    assert.equal(stays.done, false);
    assert.ok(existsSync(env));
});
