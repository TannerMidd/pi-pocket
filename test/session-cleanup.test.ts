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
import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { basename, join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { DeletedDoc, SessionsDoc } from "../src/server/docs.ts";
import { createHandler } from "../src/server/http.ts";
import { issueUpload } from "../src/server/upload-references.ts";

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

function filesOf(id: ConversationId) {
    const uploads = app.managedStorage.uploadFolder(Number(id), true)!;
    const logs = app.managedStorage.folder("background", String(id), true)!;

    writeFileSync(join(uploads, "photo.png"), "x".repeat(2048));
    writeFileSync(join(logs, "abc.log.aaaaaa"), "output\n");

    const attachment = {
        path: join(uploads, "photo.png"),
        name: "photo.png",
        mime: "application/octet-stream",
        size: 2048,
    };

    return { uploads, logs, attachment };
}

const archive = (id: ConversationId) =>
    app.commands.updateSession(id, owner(app), { archived: true });

test("an archived session leaves the app with Pocket's own files; its transcript stays; a guest cannot", async () => {
    const id = await worktreeSession("Old work");
    const other = await newSession(app);
    const worktree = app.sessionMeta(id)!.worktree!;
    const files = filesOf(id);
    const folders = {
        uploads: { [String(id)]: app.managedStorage.capture("uploads", String(id)) },
        background: { [String(id)]: app.managedStorage.capture("background", String(id)) },
        worktree: app.managedStorage.capture("worktrees", basename(worktree.path)),
    };
    const removed: number[] = [];

    app.events.on("session.removed", (event) => removed.push(event.conversationId));
    await say(app, id, "hello");
    await app.schedules.add(id, { requestedBy: owner(app).id, when: "in 30m", text: "later" });

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

    assert.deepEqual(record.folders, folders);
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

    const grandFiles = filesOf(grand);

    await issueUpload(app, grand, grandFiles.attachment);
    await say(app, grand, "hello", [grandFiles.attachment]);
    const forkOf = async (id: ConversationId) =>
        (
            await app.commands.fork(id, owner(app), {
                entryId: (await app.transcripts.allEntries(id, false)).at(-1)!.id,
            })
        ).id;
    const parent = await forkOf(grand);
    const parentFiles = filesOf(parent);

    await issueUpload(app, parent, parentFiles.attachment);
    await say(app, parent, "attached in the fork", [parentFiles.attachment]);
    const child = await forkOf(parent);

    for (const { uploads } of [grandFiles, parentFiles]) {
        writeFileSync(join(uploads, "draft.txt"), "unattached");
    }

    await archive(grand);
    await archive(parent);
    // The child is selected but cannot leave. Its inherited attachments stay in both sources.
    const ids = [grand, parent, child];
    const plans = await app.sessionCleanup.plan(owner(app).id, ids);

    for (const plan of plans.slice(0, 2)) {
        assert.deepEqual(plan.uploads, {
            bytes: 2058,
            removableBytes: 10,
            retainedBytes: 2048,
            kept: true,
        });
    }

    assert.match(plans[2]!.blocked!, /Archive it first/);
    const outcomes = (await call("/api/x/session-cleanup/remove", { ids })).data.outcomes;

    assert.deepEqual(
        outcomes.map((item: { bytes?: number }) => item.bytes),
        [17, 17, undefined],
    );

    assert.deepEqual(
        outcomes.map((outcome: { id: number; done: boolean }) => [outcome.id, outcome.done]),
        [
            [grand, true],
            [parent, true],
            [child, false],
        ],
    );

    for (const { uploads, attachment } of [grandFiles, parentFiles]) {
        assert.equal(existsSync(attachment.path), true, "the fork still reads its attachment");
        assert.equal(existsSync(join(uploads, "draft.txt")), false);
    }

    assert.equal(existsSync(grandFiles.logs), false);
    assert.ok(app.sessionMeta(child) !== undefined);

    await archive(child);
    assert.equal((await call("/api/x/session-cleanup/remove", { ids: [child] })).status, 200);
    assert.equal(existsSync(grandFiles.uploads), false);
    assert.equal(existsSync(parentFiles.uploads), false);
});

test("a fork made while the removal checks the session keeps the uploads it reads", async () => {
    const id = await newSession(app);
    const files = filesOf(id);

    await issueUpload(app, id, files.attachment);
    await say(app, id, "hello", [files.attachment]);
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

test("surviving forks retain the union of their exact files until their last reference goes", async () => {
    const source = await newSession(app);
    const { uploads } = filesOf(source);
    const first = await newSession(app);
    const last = await newSession(app);

    for (const name of ["first.txt", "both.txt", "last.txt"]) {
        writeFileSync(join(uploads, name), name);
    }

    await app.harness.commit(async (tx) => {
        const sessions = await tx.doc(SessionsDoc);

        for (const [id, names] of [
            [first, ["first.txt", "both.txt"]],
            [last, ["last.txt", "both.txt"]],
        ] as const) {
            const reader = sessions.items[String(id)]!;

            reader.forkedFrom = { id: Number(source) };
            reader.inheritedUploads = names.map((name) => `${source}/${name}`);
        }
    }, context);

    for (const [id, names] of [
        [source, ["both.txt", "first.txt", "last.txt"]],
        [first, ["both.txt", "last.txt"]],
        [last, []],
    ] as const) {
        await archive(id);
        const [outcome] = await app.sessionCleanup.remove(owner(app).id, [id]);

        assert.equal(outcome?.done, true);
        assert.deepEqual(existsSync(uploads) ? (await fs.readdir(uploads)).sort() : [], names);

        if (id === source) {
            await stop();
            await start();
        }
    }
});

test("an old or uncertain fork retains its source folder, but a known empty list does not", async () => {
    for (const refs of [undefined, ["unrecognized reference"], []]) {
        const source = await newSession(app);
        const files = filesOf(source);
        const reader = await newSession(app);

        await app.harness.commit(async (tx) => {
            const meta = (await tx.doc(SessionsDoc)).items[String(reader)]!;

            meta.forkedFrom = { id: Number(source) };

            if (refs !== undefined) {
                meta.inheritedUploads = refs;
            }
        }, context);
        await archive(source);
        const [outcome] = await app.sessionCleanup.remove(owner(app).id, [source]);

        assert.equal(outcome?.done, true);
        assert.equal(existsSync(files.attachment.path), refs?.length !== 0);
        await archive(reader);
        await app.sessionCleanup.remove(owner(app).id, [reader]);
        assert.equal(existsSync(files.uploads), false);
    }
});

test("a folder rejected at removal stays rejected after restart", async () => {
    const source = await newSession(app);
    const files = filesOf(source);
    const previous = files.uploads + ".previous";
    const sentinel = join(files.uploads, "sentinel.txt");

    await archive(source);
    await fs.rename(files.uploads, previous);
    await fs.mkdir(files.uploads);
    await fs.writeFile(sentinel, "unrelated fixture");

    const [plan] = await app.sessionCleanup.plan(owner(app).id, [source]);

    assert.equal(plan?.uploads.removableBytes, 0);
    const [outcome] = await app.sessionCleanup.remove(owner(app).id, [source]);

    assert.equal(outcome?.bytes, 7, "only the log was removed");
    const record = (await app.harness.snapshot(DeletedDoc, context))!.items[String(source)]!;

    assert.equal(record.folders?.uploads[String(source)]?.state, "changed");
    assert.deepEqual(record.keepUploads, [Number(source)]);
    await stop();
    await start();
    await app.sessionCleanup.resume();
    assert.equal(await fs.readFile(sentinel, "utf8"), "unrelated fixture");
    assert.ok(existsSync(join(previous, "photo.png")));
});

async function waitForCleanup(id: ConversationId): Promise<void> {
    await until(
        async () =>
            (await app.harness.snapshot(DeletedDoc, context))?.items[String(id)]?.done !==
            undefined,
        "the removal to finish",
    );
}

for (const verified of [true, false]) {
    test(`restart cancels schedules and ${verified ? "removes verified" : "keeps legacy"} folders`, async () => {
        const id = await worktreeSession("Pending removal");
        const files = filesOf(id);
        const tree = app.sessionMeta(id)!.worktree!;

        await archive(id);
        await app.schedules.add(id, { requestedBy: owner(app).id, when: "in 30m", text: "later" });
        assert.equal((await call(`/api/c/${id}/trust`)).status, 200);
        // The commit succeeded, but the app stopped before it touched the files or schedules.
        await app.harness.commit(async (tx) => {
            const sessions = await tx.doc(SessionsDoc);
            const meta = sessions.items[String(id)]!;
            const key = String(id);
            const folders = verified
                ? {
                      uploads: { [key]: app.managedStorage.capture("uploads", key) },
                      background: { [key]: app.managedStorage.capture("background", key) },
                      worktree: app.managedStorage.capture("worktrees", basename(tree.path)),
                  }
                : undefined;

            delete sessions.items[key];
            (await tx.doc(DeletedDoc)).items[key] = {
                cwd: meta.cwd,
                conversations: [Number(id)],
                worktree: tree,
                ...(folders === undefined ? {} : { folders }),
                by: owner(app).id,
                at: Date.now(),
            };
        }, context);
        await stop();
        await start();
        await waitForCleanup(id);

        assert.deepEqual(await app.schedules.list(id), []);
        assert.equal((await call(`/api/c/${id}/trust`)).status, 404);

        if (verified) {
            for (const folder of [files.uploads, files.logs, tree.path]) {
                assert.equal(existsSync(folder), false);
            }
        } else {
            assert.equal(await fs.readFile(files.attachment.path, "utf8"), "x".repeat(2048));
            assert.equal(await fs.readFile(join(files.logs, "abc.log.aaaaaa"), "utf8"), "output\n");
            assert.equal(
                await fs.readFile(join(tree.path, "main.ts"), "utf8"),
                "export const answer = 1;\n",
            );
        }
    });
}

test("retry keeps new uploads, logs, and a clean worktree, including folders absent at removal", async () => {
    const id = await worktreeSession("Recorded checkout");
    const absent = await newSession(app);
    const tree = app.sessionMeta(id)!.worktree!;
    const files = filesOf(id);
    const replacement = join(root, "replacement-checkout");
    const replacements: string[] = [];

    gitIn(repo, "worktree", "add", "--detach", replacement, "HEAD");

    for (const each of [id, absent]) {
        for (const store of ["uploads", "background"] as const) {
            const folder = join(dataDir, store, String(each));
            const staged = `${folder}.staged`;

            assert.equal(existsSync(folder), each === id);
            await fs.mkdir(staged);
            await fs.writeFile(join(staged, "sentinel"), "replacement");
            replacements.push(folder);
        }

        await archive(each);
    }

    const outcomes = await app.sessionCleanup.remove(owner(app).id, [id, absent]);

    assert.deepEqual(
        outcomes.map((row) => row.done),
        [true, true],
    );

    for (const folder of [tree.path, files.logs, files.uploads]) {
        assert.equal(existsSync(folder), false);
    }

    // Replay the exact authorizations from ordinary removal, as if completion was not recorded.
    await app.harness.commit(async (tx) => {
        const { items } = await tx.doc(DeletedDoc);

        const folders = items[String(absent)]!.folders;

        assert.equal(folders?.uploads[String(absent)]?.state, "absent");
        assert.equal(folders?.background[String(absent)]?.state, "absent");

        for (const each of [id, absent]) {
            delete items[String(each)]!.done;
        }
    }, context);
    await stop();

    for (const folder of replacements) {
        await fs.rename(`${folder}.staged`, folder);
    }

    gitIn(replacement, "checkout", "-q", tree.branch);
    gitIn(repo, "worktree", "move", replacement, tree.path);
    await start();
    await waitForCleanup(id);
    await waitForCleanup(absent);

    for (const folder of replacements) {
        assert.equal(await fs.readFile(join(folder, "sentinel"), "utf8"), "replacement");
    }

    assert.equal(
        await fs.readFile(join(tree.path, "main.ts"), "utf8"),
        "export const answer = 1;\n",
    );
});

test("release after restart does not apply a removed source's partial grant to another folder", async () => {
    const source = await newSession(app);
    const reader = await newSession(app);
    const { uploads } = filesOf(source);

    await fs.writeFile(join(uploads, "draft.txt"), "unattached");
    await app.harness.commit(async (tx) => {
        const meta = (await tx.doc(SessionsDoc)).items[String(reader)]!;

        meta.forkedFrom = { id: Number(source) };
        meta.inheritedUploads = [`${source}/photo.png`];
    }, context);
    await archive(source);
    const [outcome] = await app.sessionCleanup.remove(owner(app).id, [source]);

    assert.equal(outcome?.done, true);
    assert.deepEqual(await fs.readdir(uploads), ["photo.png"]);
    const record = (await app.harness.snapshot(DeletedDoc, context))!.items[String(source)]!;

    assert.deepEqual(record.keepUploads, [Number(source)]);
    await stop();
    await fs.rename(uploads, join(root, "retained-original"));
    await fs.mkdir(uploads);
    await fs.writeFile(join(uploads, "photo.png"), "different photo");
    await fs.writeFile(join(uploads, "draft.txt"), "different draft");
    await start();
    await archive(reader);
    const [released] = await app.sessionCleanup.remove(owner(app).id, [reader]);

    assert.equal(released?.done, true);
    assert.equal(await fs.readFile(join(uploads, "photo.png"), "utf8"), "different photo");
    assert.equal(await fs.readFile(join(uploads, "draft.txt"), "utf8"), "different draft");

    // The original is still authorized. The last reader has already left.
    await fs.rename(uploads, join(root, "retained-replacement"));
    await fs.rename(join(root, "retained-original"), uploads);
    await stop();
    await start();
    await until(
        async () =>
            (await app.harness.snapshot(DeletedDoc, context))!.items[String(source)]!
                .keepUploads === undefined,
        "completion of the retained upload sweep",
    );
    assert.equal(existsSync(uploads), false);
    assert.equal(
        await fs.readFile(join(root, "retained-replacement", "draft.txt"), "utf8"),
        "different draft",
    );
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
