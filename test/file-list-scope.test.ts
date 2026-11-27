// Restricted mentions show the same files as the viewer, also where the working folder contains private storage.
import {
    cleanUp,
    context,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { after, test } from "node:test";
import { issueUpload } from "../src/server/upload-references.ts";
import { Place } from "../src/server/hostfs.ts";
import type { App } from "./helpers.ts";

/** The path a readable file names: a place in a folder, or a bound upload. */
const shown = (file: Place | { path: string }): string =>
    file instanceof Place ? file.display.text : file.path;

const dataDir = join(root, "file-list-data");

after(() => cleanUp());

/** Make the files at `paths` (each holding its own name) under `dir`. */
function files(dir: string, paths: string[]): void {
    for (const path of paths) {
        mkdirSync(join(dir, path, ".."), { recursive: true });
        writeFileSync(join(dir, path), path);
    }
}

/** The files a listing names. */
const names = async (listing: { files: string[] }) => new Set(listing.files);

/** The id of this session's first answer from Pi. */
async function firstAnswer(app: App, id: Awaited<ReturnType<typeof newSession>>) {
    const page = await (await app.conversation(id)).entries({}, 64, undefined, context);
    const answer = page.items.find((entry) => entry.kind === "pi.assistant");

    assert.ok(answer !== undefined);

    return Number(answer.id);
}

test("in a folder that holds the store, a guest lists just the uploads conversationFile grants it", async () => {
    const app = await openApp(scriptedModel(), dataDir);
    const other = await newSession(app);
    const main = await newSession(app, dataDir);

    try {
        app.workspace.uploadDirectory(main);
        app.workspace.uploadDirectory(other);
        files(dataDir, [
            "private-note.txt",
            "repos/sample/notes.txt",
            `uploads/${String(main)}/own.txt`,
            `uploads/${String(main)}/nested/deep.txt`,
            `uploads/${String(other)}/secret.txt`,
            `uploads/${String(other)}/also-secret.png`,
        ]);

        // Two uploads of one and the same stranger folder: both stay out, for a session-scoped guest and a global one.
        for (const guest of [
            app.config.addUser("Gale", "guest", [String(main)]).user,
            app.config.addUser("Gabe", "guest").user,
        ]) {
            const listing = await app.workspace.fileList(main, guest);
            const listed = await names(listing);

            for (const path of [
                "repos/sample/notes.txt",
                `uploads/${String(main)}/own.txt`,
                `uploads/${String(main)}/nested/deep.txt`,
            ]) {
                assert.ok(listed.has(path), `${path} is missing`);
                assert.equal(
                    shown(app.workspace.readableFile(guest, main, path)),
                    join(dataDir, path),
                );
            }

            for (const path of [
                "private-note.txt",
                "config.json",
                `uploads/${String(other)}/secret.txt`,
                `uploads/${String(other)}/also-secret.png`,
            ]) {
                assert.ok(!listed.has(path), `${path} is listed`);
                assert.throws(() => app.workspace.readableFile(guest, main, path), { status: 404 });
            }
        }

        // What the list names, the guest can load; the owner's list still says every file.
        const guest = app.config.addUser("Gale", "guest", [String(main)]).user;

        assert.equal(
            shown(app.workspace.conversationFile(guest, main, `uploads/${String(main)}/own.txt`)),
            join(dataDir, "uploads", String(main), "own.txt"),
        );
        assert.ok(
            (await app.workspace.fileList(main, owner(app))).files.includes(
                `uploads/${String(other)}/secret.txt`,
            ),
        );

        // Rebuilding a restricted list with the same visible content gives the same version.
        const listing = await app.workspace.fileList(main, guest);
        const again = await app.workspace.fileList(main, guest);

        assert.equal(again.version, listing.version);
        assert.deepEqual(JSON.parse(again.json), {
            files: again.files,
            truncated: again.truncated,
            version: again.version,
        });
        assert.equal(gunzipSync(await again.gzipped()).toString(), again.json);
    } finally {
        await app.close();
    }
});

test("a name that does not resolve is not listed, in a folder that holds the store", async () => {
    const app = await openApp(scriptedModel(), dataDir);
    const other = await newSession(app);
    const main = await newSession(app, dataDir);

    try {
        app.workspace.uploadDirectory(other);
        files(dataDir, ["repos/sample/notes.txt", `uploads/${String(other)}/secret.txt`]);
        // A link to a file that is not there: its name is spelled under the store, and nothing resolves.
        symlinkSync(
            join(root, "no-such-file"),
            join(dataDir, "uploads", String(other), "broken.png"),
        );

        const guest = app.config.addUser("Gale", "guest").user;
        const listed = await names(await app.workspace.fileList(main, guest));

        assert.ok(listed.has("repos/sample/notes.txt"));
        assert.ok(!listed.has(`uploads/${String(other)}/secret.txt`));
        assert.ok(!listed.has(`uploads/${String(other)}/broken.png`));
    } finally {
        await app.close();
    }
});

test("a fork lists the one inherited upload of a parent folder, not its later upload", async () => {
    const app = await openApp(scriptedModel(), dataDir);
    const parent = await newSession(app, dataDir);

    try {
        const first = join(app.workspace.uploadDirectory(parent), "first.txt");

        writeFileSync(first, "first.txt");
        const file = { path: first, name: "first.txt", mime: "text/plain", size: 9 };

        await issueUpload(app, parent, file);
        await say(app, parent, "First message", [file]);
        const { id: fork } = await app.commands.fork(parent, owner(app), {
            entryId: await firstAnswer(app, parent),
        });

        // The parent folder gains a second upload after the fork point: the fork inherited the first, not this one.
        writeFileSync(join(app.workspace.uploadDirectory(parent), "later.txt"), "later");

        const guest = app.config.addUser("Gale", "guest", [String(fork)]).user;
        const listed = await names(await app.workspace.fileList(fork, guest));

        assert.ok(listed.has(`uploads/${String(parent)}/first.txt`));
        assert.ok(!listed.has(`uploads/${String(parent)}/later.txt`));
        const grant = app.workspace.uploadGrant(fork);

        assert.ok(await grant(`${String(parent)}/first.txt`));
        assert.ok(!(await grant(`${String(parent)}/later.txt`)));
        assert.ok(!(await grant(`${String(parent)}/..`)));
    } finally {
        await app.close();
    }
});

test("an ordinary folder, apart from the store, lists the same for a guest as for the owner", async () => {
    const app = await openApp(scriptedModel(), dataDir);
    const project = join(work, "file-list-project");

    mkdirSync(project, { recursive: true });

    try {
        const session = await newSession(app, project);

        files(project, ["README.md", "src/app.ts"]);

        const guest = app.config.addUser("Gale", "guest").user;
        const ownerList = await app.workspace.fileList(session, owner(app));
        const guestList = await app.workspace.fileList(session, guest);

        assert.deepEqual(guestList.files, ownerList.files);
        assert.deepEqual([...guestList.files].sort(), ["README.md", "src/app.ts"]);
        assert.equal(guestList.version, ownerList.version);
    } finally {
        await app.close();
    }
});

test("a folder view returns only children that the person can read", async () => {
    const project = join(work, "view-project");
    const app = await openApp(scriptedModel(), join(project, "records"));

    try {
        const id = await newSession(app, project);
        const guest = app.config.addUser("Gale", "guest", [String(id)]).user;

        files(project, ["notes.txt"]);
        const page = await app.workspace.viewFile(id, guest, project);

        assert.equal(page.kind, "folder");
        assert.deepEqual(page.entries, [{ name: "notes.txt", dir: false }]);
        assert.equal(page.truncated, false);
        assert.throws(() => app.workspace.readableFile(guest, id, "records"), { status: 404 });
        assert.equal(
            shown(app.workspace.readableFile(guest, id, "notes.txt")),
            join(project, "notes.txt"),
        );
    } finally {
        await app.close();
    }
});

test("a git-tracked name under a store that is not there is listed for the owner only", async () => {
    const folder = join(root, "file-list-repo");
    const app = await openApp(scriptedModel(), folder);
    const other = await newSession(app);

    writeFileSync(join(app.workspace.uploadDirectory(other), "ghost.txt"), "gone");
    execFileSync("git", ["init", "-q"], { cwd: folder });
    execFileSync("git", ["add", "uploads"], { cwd: folder });
    execFileSync("git", ["commit", "-q", "-m", "track"], {
        cwd: folder,
        env: {
            ...process.env,
            GIT_AUTHOR_NAME: "t",
            GIT_AUTHOR_EMAIL: "t@t",
            GIT_COMMITTER_NAME: "t",
            GIT_COMMITTER_EMAIL: "t@t",
        },
    });
    rmSync(join(folder, "uploads"), { recursive: true });

    try {
        // Git lists the tracked name although the store folder is gone: a guest does not get it.
        const session = await newSession(app, folder);
        const guest = app.config.addUser("Gale", "guest").user;
        const owners = await names(await app.workspace.fileList(session, owner(app)));
        const listed = await names(await app.workspace.fileList(session, guest));

        assert.ok(owners.has(`uploads/${String(other)}/ghost.txt`));
        assert.ok(!listed.has(`uploads/${String(other)}/ghost.txt`));
    } finally {
        await app.close();
    }
});
