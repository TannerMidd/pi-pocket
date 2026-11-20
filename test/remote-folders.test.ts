// The panels that read a session's folder (Files, the file viewer, Changes, branches, the top bar's branch, images in
// messages) for a session on another computer (`src/server/folder-access.ts`): they read the folder there, through its
// runner, and never this server's disk. Here the "other computer" is this one, in a git repository of its own; with the
// runner stopped, the folder is still on this disk, so anything that falls back to it would still answer.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Runner } from "../src/runner/runner.ts";
import { HttpError } from "../src/server/errors.ts";
import { type App, cleanUp, openApp, owner, root, scriptedModel, until } from "./helpers.ts";

/** The remote computer's repository, and a file beside it that a guest must not reach. */
const there = join(root, "there");
const outside = join(root, "outside.txt");
/** The computer's file manager: a fake `gdbus` first on its PATH records what it was asked to show. */
const fakeBin = join(root, "fake-bin");
const revealed = join(root, "revealed.txt");
/** The first bytes of a PNG, which is all the image route checks. */
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

let app: App;
let server: Server;
let port = 0;
let runner: Runner;
let id: ConversationId;

const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=t@example.com", ...args], {
        cwd: there,
        encoding: "utf8",
    });

/** A request to the API as `token`'s person. */
const get = (path: string, token = app.config.ownerToken, headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
        headers: { authorization: `Bearer ${token}`, ...headers },
    });

/** The status and message of what `promise` fails with. */
async function failure(promise: Promise<unknown>): Promise<{ status?: number; message: string }> {
    try {
        await promise;
    } catch (error) {
        return {
            status: error instanceof HttpError ? error.status : undefined,
            message: (error as Error).message,
        };
    }

    assert.fail("expected a failure");
}

before(async () => {
    mkdirSync(join(there, "sub"), { recursive: true });
    writeFileSync(join(there, "a.txt"), "one\ntwo\n");
    writeFileSync(join(there, "sub", "b.txt"), "bee\n");
    writeFileSync(join(there, "picture.png"), PNG);
    writeFileSync(join(there, "fake.png"), "not an image");
    writeFileSync(outside, "secret\n");
    git("init", "-q", "-b", "main");
    git("add", ".");
    git("commit", "-q", "-m", "first");
    // Made after the commit, so it is no change of its own: a link from the folder to a file beside it.
    symlinkSync(outside, join(there, "sub", "out.txt"));
    git("update-index", "--add", "sub/out.txt");
    git("commit", "-q", "-m", "link");

    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(join(fakeBin, "gdbus"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${revealed}'\n`, {
        mode: 0o755,
    });
    // The runner's daemon starts with this PATH: its commands find the fake first.
    process.env.PATH = `${fakeBin}:${process.env.PATH ?? ""}`;

    app = await openApp(scriptedModel());
    app.config.lastModel ??= { provider: "faux", modelId: "faux-1", thinkingLevel: "off" };

    const { createHandler } = await import("../src/server/http.ts");

    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    server.on("upgrade", (request, socket, head) => {
        if (!app.runners.upgrade(request, socket, head)) {
            socket.destroy();
        }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;

    const { code } = app.runners.makeCode("Laptop", owner(app).id);
    const linked = app.runners.redeem(code);

    runner = new Runner({
        link: { server: `http://127.0.0.1:${port}`, ...linked },
        version: "test",
        cwd: there,
        log: () => {},
        retryMs: [50, 100, 200],
        settings: () => ({ confirm: false }),
        ask: () => Promise.resolve({ allow: true }),
    });
    runner.start();
    await until(() => app.runners.list()[0]?.online === true, "the runner to connect");
    id = (await app.commands.createSession(owner(app), { cwd: there, runner: linked.id })).id;
});

after(async () => {
    await runner?.stop();
    await app?.close();
    server?.closeAllConnections();
    await new Promise((resolve) => server?.close(resolve));
    cleanUp();
});

describe("a session's folder on another computer", () => {
    it("shows a path in that computer's file manager, through its runner", async () => {
        await app.workspace.reveal(owner(app), id, "sub/b.txt");
        await app.workspace.reveal(owner(app), id, "sub");

        const lines = readFileSync(revealed, "utf8").trim().split("\n");

        assert.match(lines[0]!, /FileManager1\.ShowItems \['file:\/\/[^']*\/there\/sub\/b\.txt'\]/);
        assert.match(lines[1]!, /FileManager1\.ShowFolders \['file:\/\/[^']*\/there\/sub'\]/);

        const missing = await failure(app.workspace.reveal(owner(app), id, "nope.txt"));

        assert.equal(missing.status, 404);
        assert.match(missing.message, /nope\.txt is not there/);
    });

    it("lists its files for @ mentions, as git there does", async () => {
        const list = await app.workspace.fileList(id, owner(app));

        assert.deepEqual([...list.files].sort(), [
            "a.txt",
            "fake.png",
            "picture.png",
            "sub/b.txt",
            "sub/out.txt",
        ]);
    });

    it("shows a file and a folder in the viewer", async () => {
        const file = await app.workspace.viewFile(id, owner(app), "a.txt");

        assert.equal(file.kind, "text");
        assert.equal(file.kind === "text" && file.text, "one\ntwo\n");
        assert.equal(file.path, join(there, "a.txt"));
        assert.equal(file.display, "a.txt");

        const folder = await app.workspace.viewFile(id, owner(app), "sub");

        assert.equal(folder.kind, "folder");
        assert.deepEqual(folder.kind === "folder" && folder.entries.map((entry) => entry.name), [
            "b.txt",
            "out.txt",
        ]);

        const image = await app.workspace.viewFile(id, owner(app), "picture.png");

        assert.deepEqual([image.kind, "size" in image && image.size], ["image", PNG.length]);
        assert.equal(
            (await failure(app.workspace.viewFile(id, owner(app), "nope.txt"))).status,
            404,
        );
    });

    it("shows the branch in the top bar, asked there", async () => {
        await until(
            () => JSON.stringify(app.workspace.head(id)) === JSON.stringify({ branch: "main" }),
            "the branch",
        );
    });

    it("lists its changes with counts, and each one's diff", async () => {
        writeFileSync(join(there, "a.txt"), "one\nchanged\n");
        writeFileSync(join(there, "new.txt"), "x\ny\nz\n");

        const changes = await app.workspace.changes(id, owner(app));

        assert.equal(changes.repo?.root, there);
        assert.equal(changes.repo?.branch, "main");
        assert.deepEqual(
            changes.files.map(({ path, kind, added, removed }) => ({ path, kind, added, removed })),
            [
                { path: "a.txt", kind: "modified", added: 1, removed: 1 },
                { path: "new.txt", kind: "new", added: 3, removed: 0 },
            ],
        );
        assert.ok(changes.files.every((file) => typeof file.version === "string"));

        const diff = await app.workspace.changeDiff(id, owner(app), "a.txt");

        assert.match(diff, /^-two$/m);
        assert.match(diff, /^\+changed$/m);
        assert.match(await app.workspace.changeDiff(id, owner(app), "new.txt"), /^\+z$/m);
        assert.equal(
            (await failure(app.workspace.changeDiff(id, owner(app), "sub/b.txt"))).status,
            404,
        );
    });

    it("undoes a change there", async () => {
        await app.workspace.revertChange(id, owner(app), "a.txt");
        assert.equal(readFileSync(join(there, "a.txt"), "utf8"), "one\ntwo\n");

        await app.workspace.revertChange(id, owner(app), "new.txt");
        assert.ok(!existsSync(join(there, "new.txt")));
        assert.deepEqual((await app.workspace.changes(id, owner(app))).files, []);
    });

    it("lists its branches and switches there", async () => {
        git("branch", "older");

        const branches = await app.workspace.branches(id, owner(app));

        assert.deepEqual(branches.head, { branch: "main" });
        assert.deepEqual(branches.local.map((branch) => [branch.name, branch.current]).sort(), [
            ["main", true],
            ["older", false],
        ]);

        await app.workspace.switchBranch(id, owner(app), { name: "feature", create: true });
        assert.equal(git("branch", "--show-current").trim(), "feature");
        assert.deepEqual(app.workspace.head(id), { branch: "feature" });

        await app.workspace.switchBranch(id, owner(app), { name: "older" });
        assert.equal(git("branch", "--show-current").trim(), "older");
        assert.match(
            (await failure(app.workspace.switchBranch(id, owner(app), { name: "nope" }))).message,
            /nope/,
        );
    });

    it("shows its images in messages, with the image route's checks", async () => {
        const path = (file: string) => `/api/c/${id}/file?path=${encodeURIComponent(file)}`;
        const image = await get(path("picture.png"));

        assert.equal(image.status, 200);
        assert.equal(image.headers.get("content-type"), "image/png");
        assert.deepEqual(Buffer.from(await image.arrayBuffer()), PNG);

        const again = await get(path(join(there, "picture.png")), undefined, {
            "if-none-match": image.headers.get("etag")!,
        });

        assert.equal(again.status, 304);
        assert.equal((await get(path("fake.png"))).status, 415);
        assert.equal((await get(path("a.txt"))).status, 415);
        assert.equal((await get(path("gone.png"))).status, 404);
    });

    it("keeps a guest of a shared session to its folder there", async () => {
        const { user: guest, token } = app.config.addUser("Guest", "guest");

        await app.setSharedRunnerSessions(owner(app), true);

        try {
            const file = await app.workspace.viewFile(id, guest, "sub/b.txt");

            assert.equal(file.kind === "text" && file.text, "bee\n");

            for (const path of [outside, "../outside.txt", "sub/out.txt"]) {
                assert.equal(
                    (await failure(app.workspace.viewFile(id, guest, path))).status,
                    404,
                    `${path} is kept back`,
                );
            }

            // The owner reads what Pi can there: the session's folder. Its runner refuses a path outside it.
            assert.match(
                (await failure(app.workspace.viewFile(id, owner(app), outside))).message,
                /outside the session's approved folder|is not there/,
            );

            assert.equal(
                (await get(`/api/c/${id}/file?path=${encodeURIComponent(outside)}`, token)).status,
                404,
            );
            assert.equal((await get(`/api/c/${id}/file?path=picture.png`, token)).status, 200);
        } finally {
            await app.setSharedRunnerSessions(owner(app), false);
        }
    });

    it("says the computer is offline, and never reads this server's disk instead", async () => {
        await runner.stop();
        await until(() => app.runners.list()[0]?.online === false, "the runner to go");

        for (const [what, attempt] of [
            ["the file list", () => app.workspace.fileList(id, owner(app))],
            ["the viewer", () => app.workspace.viewFile(id, owner(app), "a.txt")],
            ["changes", () => app.workspace.changes(id, owner(app))],
            ["a diff", () => app.workspace.changeDiff(id, owner(app), "a.txt")],
            ["undo", () => app.workspace.revertChange(id, owner(app), "a.txt")],
            ["branches", () => app.workspace.branches(id, owner(app))],
            ["switching", () => app.workspace.switchBranch(id, owner(app), { name: "main" })],
        ] as const) {
            const failed = await failure(attempt());

            assert.equal(failed.status, 409, what);
            assert.match(failed.message, /Laptop is offline/, what);
        }

        const image = await get(`/api/c/${id}/file?path=picture.png`);

        assert.equal(image.status, 200);
        assert.deepEqual(Buffer.from(await image.arrayBuffer()), PNG);
        assert.equal((await app.workspace.viewFile(id, owner(app), "picture.png")).kind, "image");
        // The original is still on this disk, but only the server-owned copy may load while the runner is away.
        writeFileSync(join(there, "picture.png"), "changed on the offline computer");
        const kept = await get(`/api/c/${id}/file?path=picture.png`);

        assert.deepEqual(Buffer.from(await kept.arrayBuffer()), PNG);
        assert.equal((await get(`/api/c/${id}/file?path=never-opened.png`)).status, 409);
        assert.equal(git("branch", "--show-current").trim(), "older");
        await until(() => app.workspace.head(id) === undefined, "the branch to go", 15_000);
    });
});
