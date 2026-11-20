// Worktrees on a linked computer: the real runner gate, git, copies, tools, forks, and removal on its disk.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Runner, type SessionQuestion } from "../src/runner/runner.ts";
import { localAccess, Unreachable } from "../src/server/folder-access.ts";
import { removeWorktree } from "../src/server/worktrees.ts";
import {
    type App,
    cleanUp,
    context,
    lastText,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";

const repo = join(root, "computer-repo");
const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
let app: App;
let server: Server;
let runner: Runner;
let runnerId: string;
let home: string;
const questions: SessionQuestion[] = [];

before(async () => {
    mkdirSync(repo, { recursive: true });
    git(repo, "init", "-q");
    git(repo, "config", "user.name", "Worktree test");
    git(repo, "config", "user.email", "worktree@example.com");
    writeFileSync(join(repo, "tracked.txt"), "committed\n");
    writeFileSync(join(repo, ".gitignore"), "ignored/\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "Initial files");
    writeFileSync(join(repo, "tracked.txt"), "uncommitted\n");
    mkdirSync(join(repo, "new files"));
    // A binary copy larger than a runner frame must be split, not put in one write request.
    writeFileSync(join(repo, "new files", "binary.dat"), Buffer.alloc(17 * 1024 * 1024, 42));
    writeFileSync(join(repo, "new files", "note.txt"), "new on the computer\n");
    writeFileSync(join(repo, "too-big.dat"), "");
    truncateSync(join(repo, "too-big.dat"), 50 * 1024 * 1024 + 1);
    writeFileSync(join(repo, "new files", "zz-over-budget.dat"), "");
    truncateSync(join(repo, "new files", "zz-over-budget.dat"), 34 * 1024 * 1024);
    mkdirSync(join(repo, "ignored"));
    writeFileSync(join(repo, "ignored", "keep-out.txt"), "ignored\n");

    app = await openApp(
        scriptedModel((request) => {
            const { role } = lastText(request as never);

            return role === "toolResult"
                ? fauxAssistantMessage([fauxText("written on the computer")])
                : fauxAssistantMessage(
                      [fauxToolCall("write", { path: "agent.txt", content: "in my worktree\n" })],
                      { stopReason: "toolUse" },
                  );
        }),
    );
    app.config.lastModel = { provider: "faux", modelId: "faux-1", thinkingLevel: "off" };
    server = createServer();
    server.on("upgrade", (request, socket, head) => {
        if (!app.runners.upgrade(request, socket, head)) {
            socket.destroy();
        }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const linked = app.runners.redeem(
        app.runners.makeCode("Worktree computer", owner(app).id).code,
    );

    runnerId = linked.id;
    runner = new Runner({
        link: { server: `http://127.0.0.1:${port}`, ...linked },
        version: "test",
        cwd: repo,
        log: () => {},
        ask: async (question) => {
            questions.push(question);

            return { allow: true };
        },
    });
    runner.start();
    await until(() => app.runners.list()[0]?.online === true, "the worktree computer to connect");
    home = (await app.runners.link(runnerId).info()).home;
});

after(async () => {
    await runner?.stop();
    await app?.close();
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));

    for (const question of questions) {
        rmSync(join(home, ".pi-pocket", "worktrees", question.session), {
            recursive: true,
            force: true,
        });
    }

    cleanUp();
});

test("does not treat an unreachable or refused worktree as an already removed folder", async () => {
    const tree = { path: "/worktree", branch: "pocket/example", source: "/repository" };

    for (const error of [
        new Unreachable("The computer is offline"),
        Object.assign(new Error("The folder is not approved"), { code: "EACCES" }),
    ]) {
        await assert.rejects(
            removeWorktree(tree, true, {
                ...localAccess,
                id: "computer",
                async info() {
                    throw error;
                },
            }),
            error,
        );
    }
});

test("does not widen a subfolder permission to reach a repository above it", async () => {
    const before = git(repo, "worktree", "list", "--porcelain");

    await assert.rejects(
        app.commands.createSession(owner(app), {
            runner: runnerId,
            cwd: join(repo, "new files"),
            worktree: true,
        }),
        /repository root is outside the session's approved folder/,
    );
    assert.equal(git(repo, "worktree", "list", "--porcelain"), before);
});

test("starts and forks in worktrees on the computer, keeps each permission, and removes them there", async () => {
    const { id } = await app.commands.createSession(owner(app), {
        runner: runnerId,
        cwd: repo,
        title: "Try on the computer",
        worktree: true,
    });
    const worktree = app.sessionMeta(id)!.worktree!;
    const scope = app.runnerScope(id);

    assert.equal(app.runnerOf(id), runnerId);
    assert.equal(app.cwdOf(id), worktree.path);
    assert.equal(worktree.source, repo);
    assert.equal(scope.folder, repo, "the worktree keeps the approved source folder");
    assert.equal(questions.at(-1)!.session, scope.id);
    assert.equal(questions.at(-1)!.folder, repo);
    assert.equal(
        worktree.path,
        join(home, ".pi-pocket", "worktrees", scope.id, worktree.branch.slice("pocket/".length)),
    );
    assert.match(worktree.branch, /^pocket\/try-on-the-computer-[0-9a-f]{6}$/);
    assert.equal(git(worktree.path, "branch", "--show-current"), worktree.branch);
    assert.equal(readFileSync(join(worktree.path, "tracked.txt"), "utf8"), "uncommitted\n");
    assert.equal(
        readFileSync(join(worktree.path, "new files", "note.txt"), "utf8"),
        "new on the computer\n",
    );
    assert.deepEqual(
        readFileSync(join(worktree.path, "new files", "binary.dat")),
        readFileSync(join(repo, "new files", "binary.dat")),
    );
    assert.equal(existsSync(join(worktree.path, "too-big.dat")), false);
    assert.equal(
        existsSync(join(worktree.path, "new files", "zz-over-budget.dat")),
        false,
        "the 50 MiB limit is for all new files together",
    );
    assert.equal(existsSync(join(worktree.path, "ignored")), false);
    assert.equal(existsSync(join(app.dataDir, "worktrees")), false, "no worktree on the server");

    const asks = questions.length;

    await say(app, id, "write a file");
    assert.equal(readFileSync(join(worktree.path, "agent.txt"), "utf8"), "in my worktree\n");
    assert.equal(existsSync(join(repo, "agent.txt")), false);
    assert.equal(questions.length, asks, "tools use the same permission without another question");

    const { id: fork } = await app.commands.fork(id, owner(app), { worktree: true });
    const forkTree = app.sessionMeta(fork)!.worktree!;
    const forkScope = app.runnerScope(fork);

    assert.equal(app.runnerOf(fork), runnerId);
    assert.notEqual(forkScope.id, scope.id);
    assert.equal(forkScope.folder, worktree.path);
    assert.equal(questions.at(-1)!.session, forkScope.id);
    assert.equal(questions.at(-1)!.kind, "fork");
    assert.equal(forkTree.source, worktree.path);
    assert.equal(
        forkTree.path,
        join(
            home,
            ".pi-pocket",
            "worktrees",
            forkScope.id,
            forkTree.branch.slice("pocket/".length),
        ),
    );
    assert.equal(git(forkTree.path, "branch", "--show-current"), forkTree.branch);
    assert.equal(readFileSync(join(forkTree.path, "agent.txt"), "utf8"), "in my worktree\n");
    await say(app, fork, "write in the fork");

    // A permission reaches only its own worktree area, not the parent area or any other session's.
    const env = app.runners.env(runnerId, worktree.path, scope);

    assert.equal(
        (await env.writeFile(join(home, ".pi-pocket", "worktrees", "outside.txt"), "no", context))
            .ok,
        false,
    );
    assert.equal(
        (await env.writeFile(join(forkTree.path, "outside.txt"), "no", context)).ok,
        false,
    );
    assert.equal((await env.writeFile(join(worktree.path, "inside.txt"), "yes", context)).ok, true);

    await assert.rejects(app.commands.removeWorktree(fork, owner(app), false), { status: 409 });
    await app.commands.removeWorktree(fork, owner(app), true);
    assert.equal(existsSync(forkTree.path), false);
    assert.equal(app.cwdOf(fork), worktree.path);
    assert.equal(app.runnerScope(fork).id, forkScope.id);
    assert.equal(app.sessionMeta(fork)?.worktree, undefined);
    assert.equal(git(repo, "branch", "--list", forkTree.branch), forkTree.branch);

    // A fork without its own checkout must leave before the source checkout can be removed.
    await assert.rejects(
        app.commands.removeWorktree(id, owner(app), true),
        /works in this worktree too/,
    );
    await app.commands.configure(fork, owner(app), { cwd: repo });
    await app.commands.removeWorktree(id, owner(app), true);
    assert.equal(existsSync(worktree.path), false);
    assert.equal(app.cwdOf(id), repo);
    assert.equal(app.runnerScope(id).id, scope.id);
    assert.equal(app.sessionMeta(id)?.worktree, undefined);
    assert.equal(git(repo, "branch", "--list", worktree.branch), worktree.branch);
    assert.ok(!git(repo, "worktree", "list", "--porcelain").includes(worktree.path));
    await say(app, id, "write after removing the worktree");
    assert.equal(readFileSync(join(repo, "agent.txt"), "utf8"), "in my worktree\n");
});
