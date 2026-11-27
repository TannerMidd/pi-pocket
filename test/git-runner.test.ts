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
import {
    createGitRunner,
    EMPTY_TREE,
    findGit,
    findRepository,
    GitError,
    hardenedConfigEnv,
    hardenedEnv,
    parseVersion,
    versionOk,
} from "../src/server/git.ts";
import { ghEnvironment } from "../src/server/github.ts";
import { Hostfs } from "../src/server/hostfs.ts";

const linux = process.platform === "linux";
const GIT = findGit();
const haveGit = GIT !== undefined;

function repo(t: { after: (fn: () => void) => void }) {
    const base = mkdtempSync(join(tmpdir(), "pocket-git-"));
    const root = join(base, "project");

    t.after(() => rmSync(base, { recursive: true, force: true }));
    mkdirSync(root);

    const run = (...args: string[]) =>
        execFileSync("git", ["-C", root, "-c", "user.email=a@b.c", "-c", "user.name=n", ...args], {
            encoding: "utf8",
        });

    run("init", "-q", "-b", "main");
    writeFileSync(join(root, "a.txt"), "one\n");
    run("add", ".");
    run("commit", "-q", "-m", "first");

    const info = statSync(root, { bigint: true });
    const sandboxed = new Hostfs({
        sandboxedFolders: () => [{ path: root, dev: info.dev, ino: info.ino }],
    });

    return { base, root, run, sandboxed, plain: new Hostfs() };
}

const FAKE = { path: "/usr/bin/git", version: [2, 45, 1] } as const;

test("a plain folder runs git exactly as it always did", (t) => {
    const { root, plain } = repo(t);
    const runner = createGitRunner({ resolve: () => FAKE });
    const planned = runner.plan(plain.folder(root), ["status", "--porcelain"]);

    assert.equal(planned.command, "git");
    assert.deepEqual(planned.args, ["-c", "core.fsmonitor=false", "status", "--porcelain"]);
    assert.equal(planned.cwd, root);
    assert.equal(planned.env.GIT_LITERAL_PATHSPECS, "1");
    assert.equal(planned.env.GIT_OPTIONAL_LOCKS, "0");
    assert.equal(planned.env.LC_ALL, "C");
    // The server's own GIT_* stay, as they did: a plain folder is hardened by nothing.
    const kept = process.env.GIT_AUTHOR_NAME;

    process.env.GIT_AUTHOR_NAME = "kept";
    t.after(() => {
        if (kept === undefined) {
            delete process.env.GIT_AUTHOR_NAME;
        } else {
            process.env.GIT_AUTHOR_NAME = kept;
        }
    });
    assert.equal(runner.plan(plain.folder(root), []).env.GIT_AUTHOR_NAME, "kept");
    assert.deepEqual(runner.plan(plain.folder(root), ["x"], { literalPaths: false }).args, [
        "-c",
        "core.fsmonitor=false",
        "--no-literal-pathspecs",
        "x",
    ]);
});

test(
    "a sandboxed folder runs the absolute git with the repository pinned, hooks off, and no GIT_ of the server",
    { skip: !linux || !haveGit },
    (t) => {
        const { root, sandboxed } = repo(t);
        const runner = createGitRunner({ resolve: () => FAKE });
        const before = { ...process.env };

        process.env.GIT_DIR = "/tmp/evil";
        process.env.GIT_CONFIG_COUNT = "1";
        process.env.GIT_EXEC_PATH = "/tmp/evil";
        t.after(() => {
            for (const name of ["GIT_DIR", "GIT_CONFIG_COUNT", "GIT_EXEC_PATH"]) {
                if (before[name] === undefined) {
                    delete process.env[name];
                } else {
                    process.env[name] = before[name];
                }
            }
        });

        const planned = runner.plan(sandboxed.folder(root), ["status"]);

        assert.equal(planned.command, "/usr/bin/git");
        assert.equal(planned.args[0], `--git-dir=${join(root, ".git")}`);
        assert.equal(planned.args[1], `--work-tree=${root}`);
        assert.equal(planned.args[2], `--attr-source=${EMPTY_TREE}`);

        for (const pair of [
            "core.fsmonitor=false",
            "core.hooksPath=/dev/null",
            "safe.bareRepository=explicit",
            "core.attributesFile=/dev/null",
        ]) {
            assert.ok(planned.args.includes(pair), pair);
        }

        assert.equal(planned.args.at(-1), "status");
        assert.deepEqual(
            Object.keys(planned.env)
                .filter((name) => /^GIT_/i.test(name))
                .sort(),
            [
                "GIT_ATTR_NOSYSTEM",
                "GIT_LITERAL_PATHSPECS",
                "GIT_OPTIONAL_LOCKS",
                "GIT_TERMINAL_PROMPT",
            ],
        );
        assert.equal(planned.env.GIT_ATTR_NOSYSTEM, "1");
    },
);

test(
    "the version gate fails closed: an older git is refused for a sandboxed folder, and a plain one is not",
    { skip: !linux },
    (t) => {
        const { root, sandboxed, plain } = repo(t);
        const old = createGitRunner({
            resolve: () => ({ path: "/usr/bin/git", version: [2, 39, 5] }),
        });

        assert.throws(
            () => old.plan(sandboxed.folder(root), ["status"]),
            (error: unknown) => {
                assert.ok(error instanceof GitError);
                assert.match(error.message, /2\.39\.5 is older than 2\.40/);

                return true;
            },
        );
        // Plain folders never ask: the same old git runs as it did.
        assert.equal(old.plan(plain.folder(root), ["status"]).command, "git");
        assert.deepEqual(
            [versionOk([2, 40, 0]), versionOk([2, 39, 9]), versionOk([3, 0, 0])],
            [true, false, true],
        );
        assert.deepEqual(parseVersion("git version 2.45.1.windows.1"), [2, 45, 1]);

        // No git on an absolute PATH entry: refused, and the failure is kept, not retried on each call.
        let calls = 0;
        const none = createGitRunner({
            resolve: () => {
                calls++;

                throw new GitError("git is not installed here", undefined);
            },
        });

        assert.throws(() => none.plan(sandboxed.folder(root), []), GitError);
        assert.throws(() => none.plan(sandboxed.folder(root), []), GitError);
        assert.equal(calls, 1, "resolved once");
    },
);

test("the absolute git ignores relative and empty PATH entries", (t) => {
    const base = mkdtempSync(join(tmpdir(), "pocket-path-"));

    t.after(() => rmSync(base, { recursive: true, force: true }));
    mkdirSync(join(base, "bin"));
    writeFileSync(join(base, "bin", "git"), "#!/bin/sh\n", { mode: 0o755 });

    const cwd = process.cwd();

    process.chdir(base);
    t.after(() => process.chdir(cwd));
    assert.equal(findGit("bin::."), undefined, "a relative entry means the server's folder");
    assert.equal(findGit(`:bin:${join(base, "bin")}`), join(base, "bin", "git"));
});

test(
    "a real git in a sandboxed folder reads the work tree and runs no hook, filter, or attribute of the guest",
    { skip: !linux || !haveGit },
    async (t) => {
        const { root, run, sandboxed } = repo(t);
        const runner = createGitRunner();
        const marker = join(root, "..", "ran");

        // A hook, a filter named by .gitattributes, and a config the guest wrote in the work tree: none runs.
        mkdirSync(join(root, ".git", "hooks"), { recursive: true });
        writeFileSync(
            join(root, ".git", "hooks", "post-checkout"),
            `#!/bin/sh\ntouch '${marker}'\n`,
            { mode: 0o755 },
        );
        writeFileSync(join(root, ".gitattributes"), "*.txt filter=evil\n");
        run("config", "filter.evil.clean", `sh -c 'touch ${marker}; cat'`);
        writeFileSync(join(root, "a.txt"), "two\n");
        writeFileSync(join(root, "new.txt"), "new\n");

        const folder = sandboxed.folder(root);
        const status = await runner.git(folder, [
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
        ]);

        assert.match(status, /M a\.txt/);
        assert.equal(existsSync(marker), false, "the filter did not run");

        const sub = join(root, "src");

        mkdirSync(sub);
        assert.equal(
            (await runner.git(sandboxed.folder(sub), ["rev-parse", "--show-prefix"])).trim(),
            "src/",
        );
        assert.equal(
            (await runner.git(sandboxed.folder(sub), ["rev-parse", "--show-toplevel"])).trim(),
            root,
        );
        // Git that needs more than one name, with the empty tree's attributes in force.
        assert.match(await runner.git(folder, ["diff", "HEAD", "--numstat"]), /1\t1\ta\.txt/);
        await runner.git(folder, ["switch", "--create", "other"]);
        assert.equal(existsSync(marker), false, "the post-checkout hook did not run");
        assert.equal(run("rev-parse", "--abbrev-ref", "HEAD").trim(), "other");
    },
);

test(
    "a sandboxed folder that holds no repository, or has a .git link, is refused without running git",
    { skip: !linux },
    async (t) => {
        const base = mkdtempSync(join(tmpdir(), "pocket-git-none-"));
        const root = join(base, "project");

        t.after(() => rmSync(base, { recursive: true, force: true }));
        mkdirSync(root);

        const info = statSync(root, { bigint: true });
        const host = new Hostfs({
            sandboxedFolders: () => [{ path: root, dev: info.dev, ino: info.ino }],
        });
        const runner = createGitRunner({ resolve: () => FAKE });

        await assert.rejects(runner.git(host.folder(root), ["status"]), { exitCode: 128 });
        mkdirSync(join(base, "elsewhere", ".git"), { recursive: true });
        symlinkSync(join(base, "elsewhere", ".git"), join(root, ".git"));
        await assert.rejects(runner.git(host.folder(root), ["status"]), /is a link/);
        assert.throws(() => findRepository(host.folder(root)), /is a link/);
    },
);

test(
    "a .git file names the git dir, and a folder above the sandboxed one is searched",
    { skip: !linux },
    (t) => {
        const base = mkdtempSync(join(tmpdir(), "pocket-git-file-"));
        const root = join(base, "project");
        const gitDir = join(base, "main.git");

        t.after(() => rmSync(base, { recursive: true, force: true }));
        mkdirSync(join(root, "sub", "deeper"), { recursive: true });
        mkdirSync(gitDir);
        writeFileSync(join(root, ".git"), `gitdir: ${gitDir}\n`);

        const info = statSync(root, { bigint: true });
        const host = new Hostfs({
            sandboxedFolders: () => [{ path: root, dev: info.dev, ino: info.ino }],
        });

        assert.deepEqual(findRepository(host.folder(join(root, "sub", "deeper"))), {
            gitDir,
            workTree: root,
        });
    },
);

test(
    "gh takes git's environment in a sandboxed folder, and its own as ever in a plain one",
    { skip: !linux || !haveGit },
    (t) => {
        const { root, sandboxed, plain } = repo(t);
        const plainEnv = ghEnvironment(plain.folder(root));

        assert.equal(plainEnv.cwd, root);
        assert.equal(plainEnv.env.GH_PROMPT_DISABLED, "1");
        assert.equal(plainEnv.env.GIT_CONFIG_COUNT, process.env.GIT_CONFIG_COUNT);
        assert.equal(ghEnvironment(undefined).cwd, undefined);

        const hard = ghEnvironment(sandboxed.folder(root));

        assert.equal(hard.env.GIT_DIR, join(root, ".git"));
        assert.equal(hard.env.GIT_WORK_TREE, root);
        assert.equal(hard.env.GIT_ATTR_SOURCE, EMPTY_TREE);
        assert.equal(hard.env.GH_PROMPT_DISABLED, "1");
        assert.equal(hard.env.GIT_CONFIG_KEY_1, "core.hooksPath");
        assert.equal(hard.env.GIT_CONFIG_VALUE_1, "/dev/null");
        assert.deepEqual(
            Object.fromEntries(
                Object.entries(hardenedConfigEnv()).filter(([name]) =>
                    name.startsWith("GIT_CONFIG_KEY"),
                ),
            ),
            {
                GIT_CONFIG_KEY_0: "core.fsmonitor",
                GIT_CONFIG_KEY_1: "core.hooksPath",
                GIT_CONFIG_KEY_2: "safe.bareRepository",
                GIT_CONFIG_KEY_3: "core.attributesFile",
            },
        );
        assert.equal(
            hardenedEnv()
                .PATH?.split(":")
                .every((entry) => entry.startsWith("/")),
            true,
        );
        assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "one\n");
    },
);
