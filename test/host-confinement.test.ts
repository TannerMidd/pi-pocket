/**
 * Host file access through the app. A folder that a sandboxed tree uses is confined: the viewer, the file list, Changes,
 * its undo, the branch sheet, and `@` mentions never follow a name the guest made into a link, and the folder's Git is
 * the hardened one. The same calls on a plain folder follow links and give what they always did (a parity check, with and
 * without the view). `SandboxView` is what core state implements: here a list.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { context, modelTexts, newSession, openApp, owner, scriptedModel } from "./helpers.ts";
import { getAgentDir, ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { writeExport } from "../src/server/design/files.ts";
import { type Place, readText, type SandboxView } from "../src/server/hostfs.ts";

const linux = process.platform === "linux";

function project() {
    const base = mkdtempSync(join(tmpdir(), "pocket-confine-"));
    const dir = join(base, "project");
    const outside = join(base, "outside");
    const secret = join(outside, "secret.txt");

    mkdirSync(dir);
    mkdirSync(outside);
    writeFileSync(secret, "TOP SECRET");

    const git = (...args: string[]) =>
        execFileSync("git", ["-C", dir, "-c", "user.email=a@b.c", "-c", "user.name=n", ...args], {
            encoding: "utf8",
        });

    git("init", "-q", "-b", "main");
    writeFileSync(join(dir, "keep.txt"), "a\n");
    writeFileSync(join(dir, "AGENTS.md"), "Rules.\n");
    git("add", ".");
    git("commit", "-q", "-m", "first");

    const info = statSync(dir, { bigint: true });
    const view: SandboxView = {
        sandboxedFolders: () => [{ path: dir, dev: info.dev, ino: info.ino }],
    };

    return { base, dir, outside, secret, git, view };
}

test(
    "the viewer, the list, and Changes in a sandboxed folder never follow the guest's links",
    { skip: !linux, timeout: 60_000 },
    async (t) => {
        const { base, dir, outside, secret, view } = project();
        const app = await openApp(scriptedModel(), join(base, "data"), undefined, undefined, view);

        t.after(async () => {
            await app.close();
            rmSync(base, { recursive: true, force: true });
        });

        const id = await newSession(app, dir);
        const me = owner(app);

        symlinkSync(secret, join(dir, "leak.txt"));
        symlinkSync(outside, join(dir, "out"));
        writeFileSync(join(dir, "changed.txt"), "new\n");
        writeFileSync(join(dir, "keep.txt"), "b\n");

        // The viewer: a link is refused, the folder's own files are read.
        assert.equal((await app.workspace.viewFile(id, me, "keep.txt")).kind, "text");
        // A link is shown as what it is (not a file, not a folder), never read.
        assert.equal((await app.workspace.viewFile(id, me, "leak.txt")).kind, "other");
        await assert.rejects(
            app.workspace.viewFile(id, me, "out/secret.txt"),
            (error: { status: number }) => [404, 409].includes(error.status),
        );
        assert.throws(
            () => readText(app.workspace.conversationFile(me, id, "out/secret.txt") as Place),
            { code: "EACCES" },
        );
        // An alias to the folder is not the folder's name: a path through it is refused.
        symlinkSync(dir, join(base, "alias"));
        assert.throws(
            () => app.workspace.conversationFile(me, id, join(base, "alias", "keep.txt")),
            { status: 404 },
        );
        assert.equal(readText(app.workspace.conversationFile(me, id, "keep.txt") as Place), "b\n");

        // The list is git's, and the folder's name for a link is no more than a name.
        const listed = (await app.workspace.fileList(id, me)).files;

        assert.ok(listed.includes("keep.txt") && listed.includes("changed.txt"));

        // Changes: the hardened git reads the work tree; a link is a changed name, never what it names.
        const changes = await app.workspace.changes(id, me);

        assert.deepEqual(changes.files.map((file) => file.path).sort(), [
            "changed.txt",
            "keep.txt",
            "leak.txt",
            "out",
        ]);
        assert.equal(changes.repo?.branch, "main");

        // Undo removes a name made new since the last commit, never what a link names.
        await app.workspace.revertChange(id, me, "leak.txt");
        assert.equal(existsSync(join(dir, "leak.txt")), false);
        assert.equal(readFileSync(secret, "utf8"), "TOP SECRET");
        await app.workspace.revertChange(id, me, "out");
        assert.equal(existsSync(join(outside, "secret.txt")), true);

        // The branch sheet reads the repository through the descriptor walk.
        assert.equal(
            (await app.workspace.branches(id, me)).head &&
                "branch" in (await app.workspace.branches(id, me)).head!,
            true,
        );
        assert.deepEqual(app.workspace.head(id), { branch: "main" });
    },
);

test(
    "the same calls on a plain folder follow links, as they always did",
    { skip: !linux, timeout: 60_000 },
    async (t) => {
        const { base, dir, outside, secret } = project();
        const app = await openApp(scriptedModel(), join(base, "data"));

        t.after(async () => {
            await app.close();
            rmSync(base, { recursive: true, force: true });
        });

        const id = await newSession(app, dir);
        const me = owner(app);

        symlinkSync(secret, join(dir, "leak.txt"));
        symlinkSync(outside, join(dir, "out"));

        const viewed = await app.workspace.viewFile(id, me, "leak.txt");

        assert.ok(viewed.kind === "text" && viewed.text === "TOP SECRET");
        assert.ok((await app.workspace.viewFile(id, me, "out/secret.txt")).kind === "text");
        assert.equal((await app.workspace.viewFile(id, me, "out")).kind, "folder");
        assert.deepEqual(
            (await app.workspace.changes(id, me)).files.map((file) => file.path).sort(),
            ["leak.txt", "out"],
        );
        assert.deepEqual(app.workspace.head(id), { branch: "main" });
    },
);

test(
    "a sandboxed folder's project settings are never read for a new session's model",
    { skip: !linux, timeout: 60_000 },
    async (t) => {
        const { base, dir, view } = project();
        const app = await openApp(scriptedModel(), join(base, "data"), undefined, undefined, view);

        t.after(async () => {
            await app.close();
            rmSync(base, { recursive: true, force: true });
        });

        mkdirSync(join(dir, ".pi"));
        // The guest picked a model, and a link would have named anything: neither is read.
        writeFileSync(
            join(dir, ".pi", "settings.json"),
            JSON.stringify({ defaultProvider: "x", defaultModel: "y" }),
        );
        new ProjectTrustStore(getAgentDir()).set(dir, true);

        // With the file read, an unknown model fails the creation (a 400); it is not read, so the session is made.
        assert.ok((await app.commands.createSession(owner(app), { cwd: dir })).id);

        // A plain folder reads it, as it always did.
        const plain = await openApp(scriptedModel(), join(base, "plain-data"));

        t.after(() => plain.close());
        await assert.rejects(plain.commands.createSession(owner(plain), { cwd: dir }), {
            status: 400,
        });
    },
);

test(
    "an @ mention of a link in a sandboxed folder attaches nothing, and on a plain folder the file as before",
    { skip: !linux, timeout: 60_000 },
    async (t) => {
        const { base, dir, secret, view } = project();

        t.after(() => rmSync(base, { recursive: true, force: true }));
        symlinkSync(secret, join(dir, "leak.txt"));
        writeFileSync(join(dir, "plain.txt"), "PLAIN FILE");

        for (const [name, sandboxed] of [
            ["sandboxed", view],
            ["plain", undefined],
        ] as const) {
            const app = await openApp(
                scriptedModel(),
                join(base, `data-${name}`),
                undefined,
                undefined,
                sandboxed,
            );

            t.after(() => app.close());

            const id = await newSession(app, dir);

            const { submissionId } = await app.commands.submit(id, owner(app), {
                text: "read @leak.txt and @plain.txt",
                requestId: crypto.randomUUID(),
                inlineFiles: true,
            });

            await (await app.harness.submission(submissionId, context))!.wait(context);

            const seen = (await modelTexts(app, id)).join("\n");

            assert.equal(
                seen.includes("PLAIN FILE"),
                true,
                `${name}: the folder's own file is attached`,
            );
            assert.equal(
                seen.includes("TOP SECRET"),
                sandboxed === undefined,
                `${name}: a link to a secret`,
            );
        }
    },
);

test(
    "the folder picker makes folders one name at a time from the pinned root, never through a guest's link",
    { skip: !linux, timeout: 60_000 },
    async (t) => {
        const { base, dir, outside, view } = project();
        const app = await openApp(scriptedModel(), join(base, "data"), undefined, undefined, view);

        t.after(async () => {
            await app.close();
            rmSync(base, { recursive: true, force: true });
        });

        const me = owner(app);

        symlinkSync(outside, join(dir, "out"));
        assert.equal(
            app.workspace.makeFolder(me, join(dir, "fresh", "deeper")),
            join(dir, "fresh", "deeper"),
        );
        assert.equal(statSync(join(dir, "fresh", "deeper")).isDirectory(), true);
        assert.throws(() => app.workspace.makeFolder(me, join(dir, "out", "escaped")), {
            status: 409,
        });
        assert.equal(existsSync(join(outside, "escaped")), false);
    },
);

test(
    "a nested session's root is pinned by its first look or by admission, and a replacement is refused",
    { skip: !linux, timeout: 60_000 },
    async (t) => {
        const { base, dir, view } = project();
        const inner = join(dir, "inner");

        t.after(() => rmSync(base, { recursive: true, force: true }));
        mkdirSync(inner);
        writeFileSync(join(inner, "a.txt"), "real");

        const original = statSync(inner, { bigint: true });

        const replace = () => {
            rmSync(inner, { recursive: true });
            mkdirSync(inner);
            writeFileSync(join(inner, "a.txt"), "forged");
        };

        const refused = (error: { status?: number }) => [404, 409].includes(error.status ?? 0);

        // Pinned by the first look: the replacement after it is not the root.
        const first = await openApp(
            scriptedModel(),
            join(base, "data-first"),
            undefined,
            undefined,
            view,
        );

        t.after(() => first.close());

        const id = await newSession(first, inner);
        const me = owner(first);

        assert.ok((await first.workspace.viewFile(id, me, "a.txt")) !== undefined);
        replace();
        await assert.rejects(first.workspace.viewFile(id, me, "a.txt"), refused);
        // The list fails closed too: it names nothing of the replacement.
        assert.deepEqual((await first.workspace.fileList(id, me)).files, []);

        // Pinned by admission state, through the view: the replacement before the first look is refused too.
        rmSync(inner, { recursive: true });
        mkdirSync(inner);
        writeFileSync(join(inner, "a.txt"), "real");

        const second = await openApp(
            scriptedModel(),
            join(base, "data-second"),
            undefined,
            undefined,
            {
                ...view,
                pinnedRoot: (_conversation, path) =>
                    path === inner ? { dev: original.dev, ino: original.ino } : undefined,
            },
        );

        t.after(() => second.close());

        const other = await newSession(second, inner);

        replace();
        await assert.rejects(second.workspace.viewFile(other, owner(second), "a.txt"), refused);
    },
);

test(
    "an export is written from the admitted root: a nested folder replaced after the first look is refused",
    { skip: !linux, timeout: 60_000 },
    async (t) => {
        const { base, dir, view } = project();
        const inner = join(dir, "inner");
        const app = await openApp(scriptedModel(), join(base, "data"), undefined, undefined, view);

        t.after(async () => {
            await app.close();
            rmSync(base, { recursive: true, force: true });
        });
        mkdirSync(inner);

        const id = await newSession(app, inner);

        const replace = () => {
            rmSync(inner, { recursive: true });
            mkdirSync(inner);
        };

        await assert.rejects(
            writeExport(app.folderOf(id), "exports/a.txt", Buffer.from("data"), replace),
            {
                code: "ESTALE",
            },
        );
        assert.equal(
            existsSync(join(inner, "exports")),
            false,
            "nothing was written into the replacement",
        );
    },
);
