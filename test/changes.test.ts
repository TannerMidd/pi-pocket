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
import { existsSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { parseNumstat, parseStatus } from "../src/server/changes.ts";

test("git's -z output reads into changes, renames included", () => {
    assert.deepEqual(parseStatus(" D del.txt\0 M keep.txt\0R  new.txt\0old.txt\0?? fresh.txt\0"), [
        { code: " D", path: "del.txt" },
        { code: " M", path: "keep.txt" },
        { code: "R ", path: "new.txt" },
        { code: "??", path: "fresh.txt" },
    ]);
    assert.deepEqual(
        [
            ...parseNumstat(
                "0\t1\tdel.txt\x002\t1\tkeep.txt\x000\t0\t\0old.txt\0new.txt\0-\t-\timage.png\0",
            ),
        ],
        [
            ["del.txt", { added: 0, removed: 1 }],
            ["keep.txt", { added: 2, removed: 1 }],
            ["new.txt", { added: 0, removed: 0 }],
            ["image.png", {}],
        ],
    );
});

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

    if (text.includes("write absolute:")) {
        const path = text.slice(text.indexOf("write absolute:") + "write absolute:".length).trim();

        return fauxAssistantMessage(
            [
                fauxToolCall("write", {
                    path,
                    content: "absolute edit\n",
                }),
            ],
            { stopReason: "toolUse" },
        );
    }

    if (text.includes("script absolute:")) {
        const path = text
            .slice(text.indexOf("script absolute:") + "script absolute:".length)
            .trim();

        return fauxAssistantMessage(
            [
                fauxToolCall("codemode", {
                    code: `await tools.write({ path: ${JSON.stringify(path)}, content: "absolute script\\n" });`,
                }),
            ],
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
                added: undefined,
                removed: undefined,
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

function symlinkDirectory(target: string, link: string): void {
    symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
}

test("absolute direct-write paths through a symlinked cwd are attributed to Pi", async () => {
    const folder = repository("absolute-direct", { "seed.txt": "seed\n" });
    const alias = join(root, "absolute-direct-alias");

    symlinkDirectory(folder, alias);
    const id = await newSession(app, alias);

    const path = join(alias, "direct.txt");

    await say(app, id, `write absolute: ${path}`);
    assert.equal(existsSync(path), true, "the write created its target file");
    const changes = await app.workspace.changes(id, owner(app));

    assert.equal(changes.files.find((file) => file.path === "direct.txt")?.byPi, true);
});

test("absolute codemode paths through a symlinked cwd are attributed to Pi", async () => {
    const folder = repository("absolute-codemode", { "seed.txt": "seed\n" });
    const alias = join(root, "absolute-codemode-alias");

    symlinkDirectory(folder, alias);
    const id = await newSession(app, alias);

    const path = join(alias, "scripted.txt");

    await say(app, id, `script absolute: ${path}`);
    assert.equal(existsSync(path), true, "the codemode write created its target file");
    const changes = await app.workspace.changes(id, owner(app));

    assert.equal(changes.files.find((file) => file.path === "scripted.txt")?.byPi, true);
});

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

test("a file named like a pattern is that one file", async () => {
    const starred = repository("starred", { "*": "star\n", "plain.txt": "plain\n" });

    writeFileSync(join(starred, "*"), "star changed\n");
    writeFileSync(join(starred, "plain.txt"), "plain changed\n");
    const id = await newSession(app, starred);
    const diff = await app.workspace.changeDiff(id, owner(app), "*");

    assert.match(diff, /^\+star changed$/m);
    assert.doesNotMatch(diff, /plain/);
});

test("outside a repository, the changes are Pi's edits alone", async () => {
    const folder = join(root, "plain");

    mkdirSync(folder, { recursive: true });
    const id = await newSession(app, folder);

    await say(app, id, "write notes");
    const changes = await app.workspace.changes(id, owner(app));

    assert.equal(changes.repo, undefined);
    assert.deepEqual(changes.files, []);
    assert.deepEqual(
        changes.piOnly.map((each) => each.path),
        [join(folder, "notes", "todo.md")],
    );
});
