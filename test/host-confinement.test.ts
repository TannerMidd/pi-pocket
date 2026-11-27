// What Pi Pocket does on the host with a session's folder, which a guest may write: it refuses a folder the server
// loads code from, never follows a link out of the folder when it reads, and runs git held to the known repository,
// with none of the configuration's filters.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    realpathSync,
    rmSync,
    symlinkSync,
    truncateSync,
    writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { changesIn, diffOf } from "../src/server/changes.ts";
import { SandboxDoc } from "../src/server/docs.ts";
import { onSandboxedFolders, openInside, sandboxedFolder } from "../src/server/confined.ts";
import { APP_ROOT } from "../src/server/config.ts";
import { viewFile } from "../src/server/files.ts";
import { serveImage } from "../src/server/http/assets.ts";
import { loadPromptTemplates } from "../src/server/prompts.ts";
import { reloadedFolderProblem } from "../src/server/sandbox.ts";
import { FakeDriver, sandboxOptions, useDriver } from "./gondolin-fake.ts";
import {
    cleanUp,
    context,
    lastText,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    type App,
} from "./helpers.ts";

after(cleanUp);

/** Only Linux has the primitive that these tests need (`confined.ts`): elsewhere a sandboxed folder is refused. */
const LINUX =
    process.platform === "linux"
        ? false
        : "the walk of names needs Linux; elsewhere it fails closed";

const SECRET = "HOST_SECRET_MARKER_7f3a";
const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
    "base64",
);

function folder(name: string): string {
    const path = join(root, name);

    mkdirSync(path, { recursive: true });

    return path;
}

/** A host file outside every session folder, as `~/.ssh/id_rsa` is. */
const secret = join(folder("outside"), "id_rsa");

writeFileSync(secret, `${SECRET}\n`);

test("a folder the server loads code from, or keeps its data in, is refused whatever the mode", () => {
    const data = folder("srv-data");
    const code = [APP_ROOT, join(data, "extensions"), join(data, "themes")];
    const problem = (path: string) => reloadedFolderProblem(path, code, data);

    mkdirSync(join(data, "extensions"), { recursive: true });
    mkdirSync(join(data, "worktrees", "feature"), { recursive: true });

    for (const path of [
        APP_ROOT,
        join(APP_ROOT, "web"),
        join(APP_ROOT, "src", "server", "extensions"),
        join(data, "extensions"),
        join(data, "extensions", "mine"),
        join(data, "themes"),
        data,
        root,
        join(data, "sessions"),
    ]) {
        assert.match(problem(path) ?? "", /loads code from or keeps its data in/, path);
    }

    const through = join(folder("srv-links"), "app");

    symlinkSync(APP_ROOT, through);
    assert.match(problem(through) ?? "", /loads code from/, "a link to the install folder");

    assert.equal(problem(join(data, "worktrees", "feature")), undefined);
    assert.equal(problem(folder("srv-project")), undefined);
});

test("the sandbox cannot be chosen for a folder of the server's own code or data", async () => {
    useDriver(new FakeDriver());
    const app = await openApp(
        scriptedModel(),
        join(root, "data-confined"),
        undefined,
        undefined,
        sandboxOptions(),
    );

    try {
        await app.setExtensionEnabled(owner(app), "gondolin.ts", true);

        for (const path of [
            join(app.dataDir, "extensions"),
            join(app.dataDir, "themes"),
            join(APP_ROOT, "docs"),
        ]) {
            mkdirSync(path, { recursive: true });
            const id = await newSession(app, path);

            await assert.rejects(app.sandboxes.set(id, owner(app), true), /loads code from/, path);
            assert.equal((await app.sandboxes.get(id)).on, false);
        }

        const fine = await newSession(app, folder("fine-project"));

        await app.sandboxes.set(fine, owner(app), true);
        assert.equal((await app.sandboxes.get(fine)).on, true);
    } finally {
        useDriver(undefined);
        await app.close();
    }
});

test(
    "in a sandboxed session's folder the viewer and the file route never follow a link out of it",
    { skip: LINUX },
    async () => {
        const work = folder("view-work");
        const beyond = folder("view-beyond");

        writeFileSync(join(work, "plain.txt"), "plain\n");
        writeFileSync(join(beyond, "other.txt"), `${SECRET}\n`);
        writeFileSync(join(beyond, "image.png"), PNG);
        writeFileSync(join(work, "real.png"), PNG);
        symlinkSync(secret, join(work, "AGENTS.md"));
        symlinkSync(secret, join(work, "link.txt"));
        symlinkSync(beyond, join(work, "linked-dir"));
        symlinkSync("plain.txt", join(work, "inner.txt"));
        symlinkSync(join(beyond, "image.png"), join(work, "pic.png"));

        const text = async (path: string) => {
            const view = await viewFile(join(work, path), undefined, work);

            return view.kind === "text" ? view.text : view.kind;
        };

        const status = async (name: string) => {
            const server = createServer((request, response) => {
                Promise.resolve(serveImage(request, response, join(work, name), work)).catch(
                    (error: { status?: number }) => {
                        response.writeHead(error.status ?? 500).end();
                    },
                );
            });

            await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));

            try {
                const { port } = server.address() as { port: number };

                return (await fetch(`http://127.0.0.1:${port}/`)).status;
            } finally {
                server.close();
            }
        };

        // No sandboxed session uses the folder: Pi has the whole machine here anyway, and a shared file linked in works.
        assert.equal(await text("link.txt"), `${SECRET}\n`);
        assert.equal(await text("linked-dir/other.txt"), `${SECRET}\n`);
        assert.equal(await status("pic.png"), 200);

        const stop = onSandboxedFolders(() => [work]);

        try {
            assert.equal(await text("plain.txt"), "plain\n");

            for (const path of [
                "AGENTS.md",
                "link.txt",
                "inner.txt",
                "linked-dir/other.txt",
                "linked-dir",
            ]) {
                await assert.rejects(text(path), /link, which is not followed/, path);
            }

            await assert.rejects(openInside(work, join(work, "link.txt")), /not followed/);

            // A path outside the folder that someone names is theirs to read, as before.
            const named = await viewFile(secret, undefined, work);

            assert.equal(named.kind === "text" && named.text, `${SECRET}\n`);
            assert.equal(await status("real.png"), 200);
            assert.equal(await status("pic.png"), 404);
        } finally {
            stop();
        }
    },
);

/** Send `@mentioned.txt` with its file, as the message box does. */
async function mention(app: App, id: ConversationId): Promise<void> {
    const { submissionId } = await app.commands.submit(id, owner(app), {
        text: "hello @mentioned.txt",
        requestId: crypto.randomUUID(),
        inlineFiles: true,
    });

    await (await app.harness.submission(submissionId, context))!.wait(context);
}

test(
    "a link in a sandboxed session's folder puts no host file in the prompt, a mention, or a template",
    { skip: LINUX },
    async () => {
        useDriver(new FakeDriver());
        const seen: string[] = [];
        const app = await openApp(
            scriptedModel((request) => {
                seen.push(JSON.stringify(request));

                return fauxAssistantMessage([
                    fauxText(lastText(request as never).text.slice(0, 20)),
                ]);
            }),
            join(root, "data-prompts"),
            undefined,
            undefined,
            sandboxOptions(),
        );

        const linkedFolder = (name: string) => {
            const path = folder(name);

            symlinkSync(secret, join(path, "AGENTS.md"));
            symlinkSync(secret, join(path, "mentioned.txt"));
            mkdirSync(join(path, ".pi", "prompts"), { recursive: true });
            symlinkSync(secret, join(path, ".pi", "prompts", "evil.md"));
            writeFileSync(join(path, ".pi", "prompts", "fine.md"), "Fine $1");

            return path;
        };

        const names = (path: string) =>
            loadPromptTemplates(path, join(root, "agent"), []).map((each) => each.name);

        const sent = async (id: ConversationId) => {
            seen.length = 0;
            await mention(app, id);

            return seen.join("\n");
        };

        try {
            await app.setExtensionEnabled(owner(app), "gondolin.ts", true);

            const sandboxedPath = linkedFolder("prompt-sandboxed");
            const ordinaryPath = linkedFolder("prompt-ordinary");
            const sharedPath = linkedFolder("prompt-shared");
            const honest = folder("prompt-honest");

            writeFileSync(join(honest, "AGENTS.md"), "HONEST_INSTRUCTIONS");
            writeFileSync(join(honest, "mentioned.txt"), "HONEST_MENTION");

            // An ordinary session: links work as before, so a shared AGENTS.md outside the repository is read.
            const ordinary = await newSession(app, ordinaryPath);
            const before = await sent(ordinary);

            assert.match(before, new RegExp(SECRET));
            assert.deepEqual(names(ordinaryPath).sort(), ["evil", "fine"]);

            // A sandboxed session: no host file reaches the prompt, a mention, or a template.
            const sandboxed = await newSession(app, sandboxedPath);

            await app.sandboxes.set(sandboxed, owner(app), true);
            assert.doesNotMatch(await sent(sandboxed), new RegExp(SECRET));
            assert.deepEqual(names(sandboxedPath), ["fine"]);

            // A folder that a sandboxed session shares with an ordinary one is confined for both. The rule against it
            // (`one-folder.test.ts`) keeps new sessions from making it, so the state is written as an older version did.
            const first = await newSession(app, sharedPath);
            const next = await newSession(app, sharedPath);
            const boxed = await newSession(app, sharedPath);
            const mark = (on: boolean) =>
                app.harness.commit(async (tx) => {
                    Object.assign(await tx.doc(SandboxDoc, boxed), { on });
                }, context);

            assert.match(await sent(first), new RegExp(SECRET));
            await mark(true);
            assert.doesNotMatch(await sent(next), new RegExp(SECRET));
            assert.deepEqual(names(sharedPath), ["fine"]);

            // Turned off again, the folder is ordinary again.
            await mark(false);
            assert.match(await sent(await newSession(app, sharedPath)), new RegExp(SECRET));

            const second = await newSession(app, honest);
            const text = await sent(second);

            assert.match(text, /HONEST_INSTRUCTIONS/);
            assert.match(text, /HONEST_MENTION/);
        } finally {
            useDriver(undefined);
            await app.close();
        }
    },
);

/** A repository in a fresh folder with one commit; `config` lines are added to its own configuration. */
function repository(name: string, files: Record<string, string>, config = ""): string {
    const path = mkdtempSync(join(tmpdir(), `pocket-git-${name}-`));
    const run = (...args: string[]) =>
        execFileSync("git", args, {
            cwd: path,
            env: {
                ...process.env,
                GIT_CONFIG_GLOBAL: "/dev/null",
                GIT_CONFIG_SYSTEM: "/dev/null",
                GIT_AUTHOR_NAME: "t",
                GIT_AUTHOR_EMAIL: "t@example.com",
                GIT_COMMITTER_NAME: "t",
                GIT_COMMITTER_EMAIL: "t@example.com",
            },
        });

    run("init", "-q", "-b", "main");

    for (const [file, content] of Object.entries(files)) {
        mkdirSync(join(path, file, ".."), { recursive: true });
        writeFileSync(join(path, file), content);
    }

    run("add", "-A");
    run("commit", "-q", "-m", "first");

    if (config !== "") {
        writeFileSync(join(path, ".git", "config"), `${config}\n`, { flag: "a" });
    }

    return realpathSync(path);
}

test("in a sandboxed session's folder no filter the configuration defines runs for Changes, whatever .gitattributes says", async () => {
    const marker = join(folder("git-marker"), "ran");
    const path = repository(
        "filter",
        { "a.txt": "one\n", ".gitattributes": "*.txt filter=pwn\n" },
        `[filter "pwn"]\n\tclean = "sh -c 'touch ${marker}; cat'"\n\tsmudge = "sh -c 'touch ${marker}; cat'"\n`,
    );

    try {
        writeFileSync(join(path, "a.txt"), "two\n");
        writeFileSync(join(path, "b.txt"), "new\n");

        // An ordinary folder: its filters run, as in any git command there.
        await changesIn(path, []);
        assert.equal(existsSync(marker), true, "an ordinary folder's filter did not run");
        rmSync(marker);

        const stop = onSandboxedFolders(() => [path]);

        try {
            const changes = await changesIn(path, []);

            assert.deepEqual(changes.files.map((file) => file.path).sort(), ["a.txt", "b.txt"]);
            assert.match(await diffOf(path, "a.txt"), /\+two/);
            assert.match(await diffOf(path, "b.txt"), /\+new/);
            assert.equal(existsSync(marker), false, "a configured filter ran");
        } finally {
            stop();
        }
    } finally {
        rmSync(path, { recursive: true, force: true });
    }
});

test("in a sandboxed session's folder Changes shows a repository whose filter is required, as git-lfs's is, by its pointers", async () => {
    const marker = join(folder("lfs-marker"), "ran");
    const pointer = "version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 4\n";
    const path = repository(
        "lfs",
        { "big.bin": pointer, ".gitattributes": "*.bin filter=lfs\n" },
        `[filter "lfs"]\n\tclean = "sh -c 'touch ${marker}; exit 1'"\n\tsmudge = "sh -c 'touch ${marker}; exit 1'"\n\tprocess = "sh -c 'touch ${marker}; exit 1'"\n\trequired = true\n`,
    );

    const stop = onSandboxedFolders(() => [path]);

    try {
        writeFileSync(join(path, "big.bin"), "real big content\n");

        const changes = await changesIn(path, []);

        assert.deepEqual(
            changes.files.map((file) => [file.path, file.kind]),
            [["big.bin", "modified"]],
        );
        assert.match(await diffOf(path, "big.bin"), /-oid sha256:abc/);
        assert.equal(existsSync(marker), false, "the LFS filter ran");
    } finally {
        stop();
        rmSync(path, { recursive: true, force: true });
    }
});

test("a repository a guest makes in the folder does not run its configuration", async () => {
    const marker = join(folder("bare-marker"), "ran");
    const path = repository("hijack", { "a.txt": "one\n", "sub/b.txt": "b\n" });

    try {
        const sub = join(path, "sub");

        // A git folder of its own in the folder, whose configuration defines a filter that a .gitattributes selects.
        mkdirSync(join(sub, "objects"), { recursive: true });
        mkdirSync(join(sub, "refs"), { recursive: true });
        writeFileSync(join(sub, "HEAD"), "ref: refs/heads/main\n");
        writeFileSync(
            join(sub, "config"),
            `[core]\n\tbare = false\n\tworktree = ${sub}\n\trepositoryformatversion = 0\n[filter "x"]\n\tclean = "sh -c 'touch ${marker}; cat'"\n`,
        );
        writeFileSync(join(sub, ".gitattributes"), "* filter=x\n");
        writeFileSync(join(sub, "c.txt"), "c\n");

        await changesIn(sub, []).catch(() => undefined);
        assert.equal(existsSync(marker), false, "the guest's configuration ran");
    } finally {
        rmSync(path, { recursive: true, force: true });
    }
});

test(
    "a session's folder inside a sandboxed one is still confined when the guest makes it a link",
    { skip: LINUX },
    async () => {
        const project = folder("nested-project");
        const beyond = folder("nested-beyond");
        const nested = join(project, "sub");

        writeFileSync(join(beyond, "data.txt"), `${SECRET}\n`);
        symlinkSync(beyond, nested);
        const stop = onSandboxedFolders(() => [project]);

        try {
            // The folder lies in the project by name, though really it is elsewhere.
            assert.equal(sandboxedFolder(nested), true);

            for (const path of [join(nested, "data.txt"), nested]) {
                await assert.rejects(viewFile(path, undefined, nested), /not followed/, path);
                await assert.rejects(openInside(nested, path), /not followed/, path);
            }

            assert.equal(sandboxedFolder(folder("nested-elsewhere")), false);
        } finally {
            stop();
        }
    },
);

test(
    "a session's folder reached through an alias is confined as the sandboxed folder it enters",
    { skip: LINUX },
    async () => {
        const project = folder("alias-project");
        const beyond = folder("alias-beyond");
        const links = folder("alias-links");

        writeFileSync(join(beyond, "data.txt"), `${SECRET}\n`);
        mkdirSync(join(project, "deep"), { recursive: true });
        symlinkSync(beyond, join(project, "sub"));
        symlinkSync(beyond, join(project, "deep", "leaf"));
        symlinkSync(project, join(links, "alias"));
        symlinkSync(join(links, "alias"), join(links, "chain-1"));
        symlinkSync(join(links, "chain-1"), join(links, "chain-2"));
        symlinkSync(join(project, "deep"), join(links, "middle"));
        symlinkSync(beyond, join(links, "elsewhere"));
        const stop = onSandboxedFolders(() => [project]);

        try {
            // Neither the stated path nor the real one lies in the project: the walk finds it by its inode.
            for (const root of [
                join(links, "alias", "sub"),
                join(links, "chain-2", "sub"),
                join(links, "middle", "leaf"),
            ]) {
                assert.equal(sandboxedFolder(root), true, root);
                await assert.rejects(
                    viewFile(join(root, "data.txt"), undefined, root),
                    /not followed/,
                    root,
                );
                await assert.rejects(
                    openInside(root, join(root, "data.txt")),
                    /not followed/,
                    root,
                );
            }

            assert.equal(sandboxedFolder(join(links, "alias")), true);
            assert.equal(sandboxedFolder(join(links, "elsewhere")), false);
        } finally {
            stop();
        }
    },
);

test(
    "a context file of a sandboxed folder that is larger than the limit is not read into the prompt",
    { skip: LINUX },
    async () => {
        useDriver(new FakeDriver());
        const seen: string[] = [];
        const app = await openApp(
            scriptedModel((request) => {
                seen.push(JSON.stringify(request));

                return fauxAssistantMessage([fauxText("ok")]);
            }),
            join(root, "data-big-context"),
            undefined,
            undefined,
            sandboxOptions(),
        );

        try {
            await app.setExtensionEnabled(owner(app), "gondolin.ts", true);
            const big = folder("big-context");
            const small = folder("small-context");

            writeFileSync(join(big, "AGENTS.md"), "BIG_MARKER");
            truncateSync(join(big, "AGENTS.md"), 3 * 1024 * 1024);
            writeFileSync(join(big, "CLAUDE.md"), "CLAUDE_FALLBACK_MARKER");
            writeFileSync(join(small, "AGENTS.md"), "SMALL_MARKER");

            for (const path of [big, small]) {
                const id = await newSession(app, path);

                await app.sandboxes.set(id, owner(app), true);
                seen.length = 0;
                await say(app, id, "hello");

                if (path === small) {
                    assert.match(seen.join("\n"), /SMALL_MARKER/);
                } else {
                    assert.doesNotMatch(seen.join("\n"), /big-context\/AGENTS\.md/);
                }
            }
        } finally {
            useDriver(undefined);
            await app.close();
        }
    },
);
