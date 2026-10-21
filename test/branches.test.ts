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
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";

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
    git(root, "clone", "-q", upstream, repo);
    git(repo, "branch", "old-idea");
    git(repo, "worktree", "add", "-q", join(root, "elsewhere"), "-b", "in-a-worktree");
    app = await openApp(scriptedModel());
});

after(async () => {
    await app?.close();
    cleanUp();
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

        // One switched outside the app shows too, once the session is quiet and nothing else would update its view.
        await new Promise((resolve) => setTimeout(resolve, 500));
        git(repo, "switch", "-q", "main");
        await until(
            () => (tab.field("branch") as { branch?: string })?.branch === "main",
            "a switch made in a terminal to show",
            8000,
        );
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
    await assert.rejects(app.workspace.switchBranch(id, me, { name: "--force" }), { status: 400 });
    // What is to be followed must be a remote branch, never an option for git.
    await assert.rejects(
        app.workspace.switchBranch(id, me, { name: "x", track: "--discard-changes" }),
        { status: 400 },
    );
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
});
