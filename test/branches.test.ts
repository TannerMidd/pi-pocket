// A session's git branch: shown in its view as it changes, listed for the branch picker, and switched from the app.
import {
    type App,
    cleanUp,
    fakeTab,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { branchesIn, gitDirOf, headOf } from "../src/server/branches.ts";

let app: App;
const upstream = join(root, "upstream");
const repo = join(root, "clone");
const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=T", ...args], {
        cwd,
        encoding: "utf8",
    }).trim();

before(async () => {
    // A repository with a remote: main, a branch the clone follows, and one it has only as a remote branch.
    mkdirSync(upstream, { recursive: true });
    git(upstream, "init", "-q", "-b", "main");
    writeFileSync(join(upstream, "a.txt"), "a\n");
    git(upstream, "add", "-A");
    git(upstream, "commit", "-qm", "first");
    git(upstream, "branch", "fix/payments");
    git(root, "clone", "-q", upstream, repo);
    git(repo, "commit", "-q", "--allow-empty", "-m", "local work");
    git(repo, "branch", "old-idea");
    git(repo, "worktree", "add", "-q", join(root, "elsewhere"), "-b", "in-a-worktree");
    git(repo, "worktree", "add", "-q", join(root, "odd\nfolder"), "-b", "odd-worktree");
    app = await openApp(scriptedModel());
});

after(async () => {
    await app?.close();
    cleanUp();
});

test("the branch is read from the repository's HEAD, a worktree's included", () => {
    assert.equal(gitDirOf(join(repo, "missing", "deeper")), join(repo, ".git"));
    assert.deepEqual(headOf(gitDirOf(repo)!), { branch: "main" });
    assert.deepEqual(headOf(gitDirOf(join(root, "elsewhere"))!), { branch: "in-a-worktree" });
    assert.equal(gitDirOf("/"), undefined);

    const detached = join(root, "detached");

    git(root, "clone", "-q", upstream, detached);
    git(detached, "checkout", "-q", "--detach", "HEAD");
    assert.deepEqual(headOf(gitDirOf(detached)!), {
        detached: git(detached, "rev-parse", "--short=7", "HEAD"),
    });

    const fresh = join(root, "fresh");

    mkdirSync(fresh);
    git(fresh, "init", "-q", "-b", "trunk");
    assert.deepEqual(headOf(gitDirOf(fresh)!), { branch: "trunk" }, "before its first commit too");

    // A folder that cannot be read is in no repository as far as a view can tell: it never throws.
    const looped = join(root, "looped");

    mkdirSync(looped);
    symlinkSync(join(looped, ".git"), join(looped, ".git"));
    assert.equal(gitDirOf(looped), undefined);
});

test("branches are listed with their remote branches, worktrees, and uncommitted changes", async () => {
    writeFileSync(join(repo, "a.txt"), "changed\n");

    try {
        const branches = await branchesIn(repo);
        const main = branches.local.find((branch) => branch.name === "main");

        assert.deepEqual(branches.head, { branch: "main" });
        assert.equal(main?.current, true);
        assert.deepEqual(main?.upstream, { name: "origin/main", ahead: 1, behind: 0, gone: false });
        assert.equal(main?.subject, "local work");
        assert.equal(
            branches.local.find((branch) => branch.name === "in-a-worktree")?.worktree,
            join(root, "elsewhere"),
        );
        assert.equal(
            branches.local.find((branch) => branch.name === "odd-worktree")?.worktree,
            join(root, "odd\nfolder"),
            "a newline in a worktree's folder is part of it",
        );
        assert.equal(branches.local.find((branch) => branch.name === "old-idea")?.current, false);
        assert.deepEqual(
            branches.remote.map((branch) => branch.name),
            ["origin/fix/payments"],
            "a remote branch a local one follows is that branch",
        );
        assert.equal(branches.changed, 1);
    } finally {
        git(repo, "checkout", "-q", "--", "a.txt");
    }

    const fresh = await branchesIn(join(root, "fresh"));

    assert.deepEqual(
        fresh.local,
        [{ name: "trunk", current: true }],
        "a branch with no commits yet",
    );
});

test("switching from the app changes the branch, tells Pi, and shows in the view", async () => {
    const id = await newSession(app, repo);
    const me = owner(app);
    const tab = fakeTab(id, me);

    await app.attach(tab.client);

    try {
        await until(() => tab.field("branch") !== undefined, "the first view");
        assert.deepEqual(tab.field("branch"), { branch: "main" });

        assert.deepEqual(await app.workspace.switchBranch(id, me, { name: "old-idea" }), {
            branch: "old-idea",
        });
        assert.equal(git(repo, "branch", "--show-current"), "old-idea");
        await until(
            () => (tab.field("branch") as { branch?: string })?.branch === "old-idea",
            "the view to show the new branch",
        );

        // A remote branch becomes a local one that follows it; a new name, a branch made from here.
        await app.workspace.switchBranch(id, me, { track: "origin/fix/payments" });
        assert.equal(
            git(repo, "rev-parse", "--abbrev-ref", "fix/payments@{upstream}"),
            "origin/fix/payments",
        );
        await app.workspace.switchBranch(id, me, { name: "try-it", create: true });
        assert.equal(git(repo, "branch", "--show-current"), "try-it");

        // One switched outside the app shows too, once the session is quiet and nothing else would update its view.
        await until(
            () => (tab.field("branch") as { branch?: string })?.branch === "try-it",
            "the view to show try-it",
        );
        await new Promise((resolve) => setTimeout(resolve, 500));
        git(repo, "switch", "-q", "main");
        await until(
            () => (tab.field("branch") as { branch?: string })?.branch === "main",
            "a switch made in a terminal to show",
            8000,
        );

        const notes = (await app.transcripts.allEntries(id, false)).flatMap((entry) =>
            entry.kind === "note" ? [entry.text] : [],
        );

        assert.deepEqual(notes, [
            "switched the branch from main to old-idea",
            "made the branch fix/payments, following origin/fix/payments, and switched to it from old-idea",
            "made the branch try-it and switched to it from fix/payments",
        ]);
    } finally {
        app.detach(tab.client);
    }
});

test("switching waits for git's say, a good name, and the right person", async () => {
    const id = await newSession(app, repo);
    const me = owner(app);

    await assert.rejects(app.workspace.switchBranch(id, me, { name: "in-a-worktree" }), {
        status: 409,
        message: /already used by worktree/,
    });
    await assert.rejects(app.workspace.switchBranch(id, me, { name: "a..b", create: true }), {
        status: 400,
    });
    await assert.rejects(app.workspace.switchBranch(id, me, { name: "--force" }), { status: 400 });
    // What is to be followed must be a remote branch, never an option for git.
    await assert.rejects(
        app.workspace.switchBranch(id, me, { name: "x", track: "--discard-changes" }),
        { status: 400 },
    );
    await assert.rejects(app.workspace.switchBranch(id, me, { track: "origin/nope" }), {
        status: 400,
    });
    await assert.rejects(app.workspace.switchBranch(id, me, { name: "nope" }), { status: 409 });

    // Changes git would overwrite stay, and so does the branch.
    git(repo, "switch", "-q", "old-idea");
    writeFileSync(join(repo, "a.txt"), "mine\n");
    git(repo, "commit", "-qam", "change a");
    git(repo, "switch", "-q", "main");
    writeFileSync(join(repo, "a.txt"), "uncommitted\n");

    try {
        await assert.rejects(app.workspace.switchBranch(id, me, { name: "old-idea" }), {
            status: 409,
            message: /would be overwritten/,
        });
        assert.equal(git(repo, "branch", "--show-current"), "main");
    } finally {
        git(repo, "checkout", "-q", "--", "a.txt");
    }

    const viewer = app.config.addUser("Vee", "viewer").user;
    const invited = app.config.addUser("Ivy", "guest", [String(id)]).user;

    await assert.rejects(app.workspace.switchBranch(id, viewer, { name: "old-idea" }), {
        status: 403,
    });
    await assert.rejects(app.workspace.switchBranch(id, invited, { name: "old-idea" }), {
        status: 403,
    });
    await assert.rejects(app.workspace.branches(id, viewer), { status: 403 });
    assert.equal((await app.workspace.branches(id, invited)).head !== undefined, true);

    const plain = join(root, "plain");

    mkdirSync(plain, { recursive: true });
    const later = await newSession(app, plain);

    await assert.rejects(app.workspace.branches(later, me), { status: 404 });

    // Made a repository since, it shows its branch within seconds.
    git(plain, "init", "-q", "-b", "start");
    await until(
        () => (app.workspace.head(later) as { branch?: string } | undefined)?.branch === "start",
        "the new repository's branch",
        8000,
    );
});
