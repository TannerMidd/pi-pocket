// Changes: Pi's edits from its tool calls, and a repository's uncommitted changes with their diffs.
import {
    type App,
    cleanUp,
    lastText,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

/** The model edits one file and writes another, as asked. */
const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);

    if (role === "toolResult") {
        return fauxAssistantMessage([fauxText("done")]);
    }

    if (text.endsWith("edit it")) {
        return fauxAssistantMessage(
            [fauxToolCall("edit", { path: "keep.txt", edits: [{ oldText: "b", newText: "c" }] })],
            { stopReason: "toolUse" },
        );
    }

    if (text.endsWith("write notes")) {
        return fauxAssistantMessage(
            [fauxToolCall("write", { path: "notes/todo.md", content: "- one\n" })],
            { stopReason: "toolUse" },
        );
    }

    if (text.endsWith("write outside")) {
        return fauxAssistantMessage(
            [fauxToolCall("write", { path: "../outside.txt", content: "x\n" })],
            { stopReason: "toolUse" },
        );
    }

    if (text.endsWith("script it")) {
        return fauxAssistantMessage(
            [
                fauxToolCall("codemode", {
                    code: 'await tools.write({ path: "scripted.txt", content: "x\\n" });\nawait tools.write({ path: "../scripted-outside.txt", content: "y\\n" });',
                }),
            ],
            { stopReason: "toolUse" },
        );
    }

    return fauxAssistantMessage([fauxText(`echo: ${text}`)]);
};

let app: App;
const repo = join(root, "repo");
const gitIn = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });

before(async () => {
    mkdirSync(repo, { recursive: true });
    gitIn("init", "-q");
    gitIn("config", "user.email", "t@example.com");
    gitIn("config", "user.name", "T");
    writeFileSync(join(repo, "keep.txt"), "a\nb\n");
    writeFileSync(join(repo, "other.txt"), "untouched by Pi\n");
    gitIn("add", "-A");
    gitIn("commit", "-qm", "init");
    app = await openApp(scriptedModel(route));
});

after(async () => {
    await app?.close();
    cleanUp();
});

test("a session's changes list git's uncommitted files, mark Pi's, and give each file's diff", async () => {
    const id = await newSession(app, repo);

    await say(app, id, "edit it");
    await say(app, id, "write notes");
    await say(app, id, "write outside");
    writeFileSync(join(repo, "other.txt"), "changed by a person\n");

    const changes = await app.workspace.changes(id, owner(app));

    assert.equal(changes.repo?.root, realpathSync(repo));
    assert.match(changes.repo?.branch ?? "", /^(main|master)$/);
    assert.deepEqual(
        changes.files.map(({ path, kind, added, removed, byPi }) => ({
            path,
            kind,
            added,
            removed,
            byPi,
        })),
        [
            { path: "keep.txt", kind: "modified", added: 1, removed: 1, byPi: true },
            { path: "other.txt", kind: "modified", added: 1, removed: 1, byPi: false },
            {
                path: "notes/todo.md",
                kind: "new",
                added: 1,
                removed: 0,
                byPi: true,
            },
        ],
    );
    assert.deepEqual(
        changes.piOnly.map((each) => each.path),
        ["../outside.txt"],
        "outside the repository, only Pi's list has it",
    );

    assert.match(await app.workspace.changeDiff(id, owner(app), "keep.txt"), /^-b\n\+c$/m);
    assert.match(await app.workspace.changeDiff(id, owner(app), "notes/todo.md"), /^\+- one$/m);
    await assert.rejects(app.workspace.changeDiff(id, owner(app), "../outside.txt"), {
        status: 404,
    });
    await assert.rejects(app.workspace.changeDiff(id, owner(app), "/etc/passwd"), { status: 404 });
    await assert.rejects(app.workspace.changeDiff(id, owner(app), "README.md"), {
        status: 404,
        message: /no uncommitted changes/,
    });
    const viewer = app.config.addUser("Vee", "viewer").user;

    await assert.rejects(app.workspace.changes(id, viewer), { status: 403 });

    // A same-line-count rewrite still changes its version, so the browser reads the new diff.
    const versionOf = async (path: string) =>
        (await app.workspace.changes(id, owner(app))).files.find((file) => file.path === path)
            ?.version;
    const before = await versionOf("notes/todo.md");

    assert.ok(before);
    writeFileSync(join(repo, "notes/todo.md"), "- two, and longer\n");
    assert.notEqual(await versionOf("notes/todo.md"), before);
});

test("diffs read the same whatever a person's git config says", async () => {
    const id = await newSession(app, repo);

    writeFileSync(join(repo, "fresh.txt"), "new\n");
    gitIn("config", "diff.mnemonicPrefix", "true");
    gitIn("config", "color.diff", "always");

    try {
        const changed = await app.workspace.changeDiff(id, owner(app), "other.txt");
        const added = await app.workspace.changeDiff(id, owner(app), "fresh.txt");

        assert.match(changed, /^diff --git a\/other\.txt b\/other\.txt$/m);
        assert.match(added, /^\+\+\+ b\/fresh\.txt$/m);
        assert.ok(!`${changed}${added}`.includes("\u001b"), "no colors");
    } finally {
        gitIn("config", "--unset", "diff.mnemonicPrefix");
        gitIn("config", "--unset", "color.diff");
        rmSync(join(repo, "fresh.txt"));
    }
});

test("files a codemode script wrote are Pi's too, shown at the reply that ran it", async () => {
    const id = await newSession(app, repo);

    await say(app, id, "script it");
    const changes = await app.workspace.changes(id, owner(app));

    assert.equal(changes.files.find((file) => file.path === "scripted.txt")?.byPi, true);
    assert.equal(changes.more, 0);
    const [outside] = changes.piOnly.filter((each) => each.path === "../scripted-outside.txt");

    assert.equal((await app.transcripts.fullEntry(id, outside!.entryId))?.kind, "assistant");
});

/** A repository of its own, with one commit of `files`. */
function repository(name: string, files: Record<string, string>): string {
    const folder = join(root, name);

    for (const [path, text] of Object.entries(files)) {
        mkdirSync(join(folder, path, ".."), { recursive: true });
        writeFileSync(join(folder, path), text);
    }

    const git = (...args: string[]) =>
        execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=T", ...args], {
            cwd: folder,
        });

    git("init", "-q");
    git("add", "-A");
    git("commit", "-qm", "init");

    return folder;
}

test("someone invited to one session sees the changes in its folder, not the rest of the repository", async () => {
    const shared = repository("shared", {
        "public/page.txt": "hello\n",
        "private/notes.txt": "notes\n",
    });

    writeFileSync(join(shared, "public", "page.txt"), "hello again\n");
    writeFileSync(join(shared, "private", "secret.txt"), "the secret\n");
    const id = await newSession(app, join(shared, "public"));
    const guest = app.config.addUser("Scoped", "guest", [String(id)]).user;

    assert.deepEqual(
        (await app.workspace.changes(id, guest)).files.map((file) => file.path),
        ["public/page.txt"],
    );
    assert.match(await app.workspace.changeDiff(id, guest, "public/page.txt"), /^\+hello again$/m);
    await assert.rejects(app.workspace.changeDiff(id, guest, "private/secret.txt"), {
        status: 404,
        message: /no uncommitted changes/,
    });
    assert.deepEqual(
        (await app.workspace.changes(id, owner(app))).files.map((file) => file.path),
        ["public/page.txt", "private/secret.txt"],
        "the owner sees them all",
    );
});

test("a renamed file's diff is what changed in it, under both its names", async () => {
    const moved = repository("moved", { "café.txt": "one\ntwo\nthree\n" });

    execFileSync("git", ["mv", "café.txt", "thé.txt"], { cwd: moved });
    writeFileSync(join(moved, "thé.txt"), "one\ntwo\nthree\nfour\n");
    const id = await newSession(app, moved);
    const [file] = (await app.workspace.changes(id, owner(app))).files;
    const diff = await app.workspace.changeDiff(id, owner(app), "thé.txt");

    assert.deepEqual([file?.path, file?.kind, file?.added], ["thé.txt", "renamed", 1]);
    assert.match(diff, /^rename from "caf\\303\\251\.txt"$/m);
    assert.match(diff, /^\+four$/m);
    assert.doesNotMatch(diff, /^\+one$/m, "not the whole file as new");
});
