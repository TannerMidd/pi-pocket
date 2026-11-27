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
    writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { changesIn, diffOf } from "../src/server/changes.ts";
import { openInside } from "../src/server/confined.ts";
import { APP_ROOT } from "../src/server/config.ts";
import { viewFile } from "../src/server/files.ts";
import { serveImage } from "../src/server/http/assets.ts";
import { loadPromptTemplates } from "../src/server/prompts.ts";
import { reloadedFolderProblem } from "../src/server/sandbox.ts";
import { FakeDriver } from "./gondolin-fake.ts";
import {
    cleanUp,
    context,
    lastText,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    type App,
} from "./helpers.ts";

after(cleanUp);

const SEAM = Symbol.for("pi-pocket.gondolin.test-driver");
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
    (globalThis as Record<symbol, unknown>)[SEAM] = new FakeDriver();
    const app = await openApp(scriptedModel(), join(root, "data-confined"));

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
        (globalThis as Record<symbol, unknown>)[SEAM] = undefined;
        await app.close();
    }
});

test("the viewer and the file route never follow a link out of the session's folder", async () => {
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

    assert.equal(await text("plain.txt"), "plain\n");
    assert.equal(await text("inner.txt"), "plain\n", "a link inside the folder is followed");

    for (const path of ["AGENTS.md", "link.txt", "linked-dir/other.txt", "linked-dir"]) {
        await assert.rejects(text(path), /leads out of the folder/, path);
    }

    await assert.rejects(openInside(work, join(work, "link.txt")), /leads out of the folder/);

    // A path outside the folder that someone names is theirs to read, as before.
    const named = await viewFile(secret, undefined, work);

    assert.equal(named.kind === "text" && named.text, `${SECRET}\n`);

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

    assert.equal(await status("real.png"), 200);
    assert.equal(await status("pic.png"), 404);
});

/** Send `@mentioned.txt` with its file, as the message box does. */
async function mention(app: App, id: ConversationId): Promise<void> {
    const { submissionId } = await app.commands.submit(id, owner(app), {
        text: "hello @mentioned.txt",
        requestId: crypto.randomUUID(),
        inlineFiles: true,
    });

    await (await app.harness.submission(submissionId, context))!.wait(context);
}

test("a link in the folder puts no host file in the prompt, a mention, or a prompt template", async () => {
    const seen: string[] = [];
    const app = await openApp(
        scriptedModel((request) => {
            seen.push(JSON.stringify(request));

            return fauxAssistantMessage([fauxText(lastText(request as never).text.slice(0, 20))]);
        }),
        join(root, "data-prompts"),
    );

    try {
        const linked = folder("prompt-linked");
        const honest = folder("prompt-honest");

        symlinkSync(secret, join(linked, "AGENTS.md"));
        symlinkSync(secret, join(linked, "mentioned.txt"));
        mkdirSync(join(linked, ".pi", "prompts"), { recursive: true });
        symlinkSync(secret, join(linked, ".pi", "prompts", "evil.md"));
        writeFileSync(join(linked, ".pi", "prompts", "fine.md"), "Fine $1");
        writeFileSync(join(honest, "AGENTS.md"), "HONEST_INSTRUCTIONS");
        writeFileSync(join(honest, "mentioned.txt"), "HONEST_MENTION");

        const first = await newSession(app, linked);

        await mention(app, first);
        assert.ok(seen.length > 0);
        assert.doesNotMatch(seen.join("\n"), new RegExp(SECRET), "a linked file is in a request");

        const templates = loadPromptTemplates(linked, join(root, "agent"), []).map(
            (each) => each.name,
        );

        assert.deepEqual(templates, ["fine"]);

        seen.length = 0;
        const second = await newSession(app, honest);

        await mention(app, second);
        assert.match(seen.join("\n"), /HONEST_INSTRUCTIONS/);
        assert.match(seen.join("\n"), /HONEST_MENTION/);
    } finally {
        await app.close();
    }
});

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

test("a filter the configuration defines never runs for Changes, whatever .gitattributes says", async () => {
    const marker = join(folder("git-marker"), "ran");
    const path = repository(
        "filter",
        { "a.txt": "one\n", ".gitattributes": "*.txt filter=pwn\n" },
        `[filter "pwn"]\n\tclean = "sh -c 'touch ${marker}; cat'"\n\tsmudge = "sh -c 'touch ${marker}; cat'"\n`,
    );

    try {
        writeFileSync(join(path, "a.txt"), "two\n");
        writeFileSync(join(path, "b.txt"), "new\n");

        const changes = await changesIn(path, []);

        assert.deepEqual(changes.files.map((file) => file.path).sort(), ["a.txt", "b.txt"]);
        assert.match(await diffOf(path, "a.txt"), /\+two/);
        assert.match(await diffOf(path, "b.txt"), /\+new/);
        assert.equal(existsSync(marker), false, "a configured filter ran");
    } finally {
        rmSync(path, { recursive: true, force: true });
    }
});

test("Changes shows a repository whose filter is required, as git-lfs's is, by its pointers", async () => {
    const marker = join(folder("lfs-marker"), "ran");
    const pointer = "version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 4\n";
    const path = repository(
        "lfs",
        { "big.bin": pointer, ".gitattributes": "*.bin filter=lfs\n" },
        `[filter "lfs"]\n\tclean = "sh -c 'touch ${marker}; exit 1'"\n\tsmudge = "sh -c 'touch ${marker}; exit 1'"\n\tprocess = "sh -c 'touch ${marker}; exit 1'"\n\trequired = true\n`,
    );

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
