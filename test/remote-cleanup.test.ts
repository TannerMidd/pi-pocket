// Session cleanup for a session on another computer, with a real runner and pi-env daemon: its worktree and its tasks
// are on that computer, so they go there, and only while that computer can be asked without asking a person.
import { linkInProcess } from "../src/runner/secure-link.ts";
import {
    type App,
    cleanUp,
    context,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Runner, type SessionQuestion } from "../src/runner/runner.ts";
import type { User } from "../src/server/config.ts";
import { BackgroundDoc, DeletedDoc } from "../src/server/docs.ts";
import { createHandler } from "../src/server/http.ts";

const repo = join(root, "computer-repo");
const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
let app: App;
let server: Server;
let runner: Runner;
let computer: string;
let base = "";
const questions: SessionQuestion[] = [];
const folders = new Set<string>();

before(async () => {
    mkdirSync(repo, { recursive: true });
    git(repo, "init", "-q");
    git(repo, "config", "user.name", "Cleanup test");
    git(repo, "config", "user.email", "cleanup@example.com");
    writeFileSync(join(repo, "main.ts"), "export const answer = 1;\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "init");

    app = await openApp(scriptedModel());
    app.background.timing.grace = 300;
    app.config.lastModel = { provider: "faux", modelId: "faux-1", thinkingLevel: "off" };
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    server.on("upgrade", (request, socket, head) => {
        if (!app.runners.upgrade(request, socket, head)) {
            socket.destroy();
        }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const linked = linkInProcess(
        (request) => app.runners.redeem(request),
        app.runners.makeCode("Cleanup laptop", owner(app).id).code,
    );

    computer = linked.id;
    runner = new Runner({
        link: { server: base, ...linked },
        version: "test",
        cwd: repo,
        log: () => {},
        ask: async (question) => {
            questions.push(question);

            return { allow: true };
        },
    });
    runner.start();
    await until(() => app.runners.list()[0]?.online === true, "the computer to connect");

    const info = await app.runners.link(computer).info();

    folders.add(join(info.home, ".pi-pocket", "worktrees"));
    folders.add(join(info.tmpdir, "pi-pocket-tasks"));
});

after(async () => {
    await runner?.stop();
    await app?.close();
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));

    // Only what this test's sessions had there, by their permission ids.
    for (const question of questions) {
        for (const folder of folders) {
            rmSync(join(folder, question.session), { recursive: true, force: true });
        }
    }

    cleanUp();
});

async function call(path: string, body: unknown, token = app.config.ownerToken) {
    const response = await fetch(`${base}/api/x/session-cleanup/${path}`, {
        method: "POST",
        headers: {
            authorization: `Bearer ${token}`,
            "x-pocket": "1",
            "content-type": "application/json",
        },
        body: JSON.stringify(body),
    });

    return { status: response.status, data: (await response.json()) as Record<string, any> };
}

async function there(title: string, worktree: boolean, user: User = owner(app)) {
    const { id } = await app.commands.createSession(user, {
        runner: computer,
        cwd: repo,
        title,
        ...(worktree ? { worktree: true } : {}),
    });

    return id;
}

const archive = (id: ConversationId, user: User = owner(app)) =>
    app.commands.updateSession(id, user, { archived: true });

const running = (pid: number) => {
    try {
        process.kill(pid, 0);

        return true;
    } catch {
        return false;
    }
};

test("a session on another computer leaves with its worktree and its tasks there", async () => {
    const id = await there("Work on the laptop", true);
    const worktree = app.sessionMeta(id)!.worktree!;

    await app.background.start(id, { command: "sleep 60", notify: false });

    await until(
        async () => ((await app.background.list(id))[0]?.pid ?? 0) > 0,
        "the task's process is known",
    );

    const { pid } = (await app.background.list(id))[0]!;
    // This server's own session in a folder of the same path is on another computer: it does not share the worktree.
    const here = await newSession(app, worktree.path);

    assert.equal(existsSync(join(app.dataDir, "worktrees")), false, "no worktree on the server");
    assert.equal(running(pid), true);
    await archive(id);

    const asked = questions.length;
    const [plan] = (await call("plan", { ids: [id] })).data.sessions;

    assert.equal(plan.blocked, undefined);
    assert.equal(plan.worktree.path, worktree.path);
    assert.equal(
        plan.worktree.state,
        "clean",
        "read on its computer, and not shared with this one",
    );
    assert.equal(plan.worktree.bytes, 0, "a worktree there is not sized");
    assert.equal(plan.ends.background, 1);

    const done = await call("remove", { ids: [id] });

    assert.deepEqual(done.data.outcomes, [{ id: Number(id), done: true, bytes: 0 }]);
    assert.equal(existsSync(worktree.path), false, "its worktree went on its computer");
    assert.equal(
        git(repo, "branch", "--list", worktree.branch),
        worktree.branch,
        "its branch stays",
    );
    await until(() => !running(pid), "its task stopped on its computer");
    assert.equal(
        app.sessions().some((session) => session.id === Number(id)),
        false,
    );
    assert.ok(app.sessions().some((session) => session.id === Number(here)));
    assert.equal(questions.length, asked, "the computer asked nobody");

    const record = (await app.harness.snapshot(DeletedDoc, context))!.items[String(id)]!;

    assert.equal(record.runner, computer);
    assert.equal(record.worktree, undefined, "nothing of it is looked for on this machine");
    assert.ok(record.done !== undefined);
});

test("a session on another computer that the owner may not see is not theirs to plan or remove", async () => {
    const guest = app.config.addUser("Gale", "guest").user;

    app.config.setRunnerUsers(computer, [guest.id]);

    const id = await there("Gale's own work", true, guest);
    const worktree = app.sessionMeta(id)!.worktree!;

    await archive(id, guest);
    assert.equal(app.canSee(owner(app), id), false);
    assert.deepEqual((await call("plan", { ids: [id] })).data.sessions, [], "not even its title");
    assert.deepEqual((await call("plan", { olderThanDays: 0 })).data.sessions, []);
    assert.equal((await call("clean-up", { ids: [id] })).data.outcomes[0].done, false);
    assert.equal((await call("remove", { ids: [id] })).data.outcomes[0].done, false);
    assert.equal(existsSync(worktree.path), true);
    assert.equal(app.sessionMeta(id)?.worktree?.path, worktree.path);
});

test("tasks on a computer that is not reached any more are given up, and no process is signalled", async () => {
    const guest = app.config.addUser("Remy", "guest").user;

    app.config.setRunnerUsers(computer, [guest.id]);

    const id = await there("Remy's server", false, guest);

    await app.background.start(id, { command: "sleep 60", notify: false });
    await until(
        async () => ((await app.background.list(id))[0]?.pid ?? 0) > 0,
        "the task's process is known",
    );

    const { pid } = (await app.background.list(id))[0]!;

    try {
        await app.setSharedRunnerSessions(owner(app), true);
        // The person who started it may no longer use the computer: nothing of the session runs or is read there.
        app.config.setRunnerUsers(computer, []);
        assert.throws(() => app.runnerScope(id), { status: 403 });
        await archive(id);

        const asked = questions.length;
        const [plan] = (await call("plan", { ids: [id] })).data.sessions;

        assert.equal(plan.blocked, undefined, "what is there stays; the session can go");
        assert.equal(plan.ends.background, 1);
        assert.deepEqual((await call("remove", { ids: [id] })).data.outcomes, [
            { id: Number(id), done: true, bytes: 0 },
        ]);
        assert.equal(questions.length, asked, "the computer asked nobody");

        const [task] = Object.values(
            (await app.harness.snapshot(BackgroundDoc, id, context))!.items,
        );

        assert.equal(task!.status, "lost", "no watch is left to look for it on this machine");
        // The test's computer is this machine, so a stop that took the task's process id for a local one would end it.
        await new Promise((resolve) => setTimeout(resolve, app.background.timing.grace + 500));
        assert.equal(running(pid), true, "its process was not signalled");
    } finally {
        await app.setSharedRunnerSessions(owner(app), false);

        try {
            process.kill(-pid, "SIGKILL");
        } catch {
            // Already gone.
        }
    }
});

test("what cannot be removed there keeps the session, and a plan never makes the computer ask", async () => {
    const id = await there("Half done", true);
    const plain = await there("Nothing there", false);
    const worktree = app.sessionMeta(id)!.worktree!;
    const scope = app.runnerScope(id);
    const link = app.runners.link(computer);
    const blocked = async () => (await call("plan", { ids: [id] })).data.sessions[0].blocked;

    const stays = async (why: RegExp) => {
        assert.match(await blocked(), why);

        for (const action of ["clean-up", "remove"]) {
            const [outcome] = (await call(action, { ids: [id] })).data.outcomes;

            assert.equal(outcome.done, false, action);
            assert.match(outcome.why, why, action);
        }

        assert.equal(existsSync(worktree.path), true);
        assert.equal(app.sessionMeta(id)?.worktree?.path, worktree.path);
    };

    await archive(id);
    await archive(plain);

    // Uncommitted changes, read on the computer.
    writeFileSync(join(worktree.path, "draft.ts"), "export {};\n");
    assert.match(await blocked(), /uncommitted changes/);
    rmSync(join(worktree.path, "draft.ts"));
    assert.equal(await blocked(), undefined);

    // An env file that git ignores, found on the computer.
    writeFileSync(join(worktree.path, ".gitignore"), "secrets/\n");
    git(worktree.path, "add", ".gitignore");
    git(worktree.path, "commit", "-qm", "ignore");
    mkdirSync(join(worktree.path, "secrets"));
    writeFileSync(join(worktree.path, "secrets", "prod.env"), "KEY=1\n");
    await stays(/env file that git ignores/);
    rmSync(join(worktree.path, "secrets"), { recursive: true });
    assert.equal(await blocked(), undefined);

    // Its approval there ended: a request would make the computer ask, so none is made.
    const asked = questions.length;

    await link.action({ action: "revoke", session: scope.id });
    await until(
        () => link.state?.sessions.every((each) => each.id !== scope.id) === true,
        "the computer says the approval ended",
    );
    await stays(/approval on Cleanup laptop has ended/);
    assert.equal(questions.length, asked, "nobody was asked");

    await runner.stop();
    await until(() => app.runners.list()[0]?.online === false, "the computer to go offline");
    await stays(/Cleanup laptop is offline/);

    // A session with nothing on its computer leaves, also while that computer is away.
    assert.deepEqual((await call("remove", { ids: [plain] })).data.outcomes, [
        { id: Number(plain), done: true, bytes: 0 },
    ]);
    assert.equal(
        (await app.harness.snapshot(DeletedDoc, context))!.items[String(plain)]!.runner,
        computer,
    );
});
