// The small, pure parts of the sandbox: the names and paths that the guest may not write, the environment of a
// sandboxed session that cannot run, the idle stop and the left-behind runners of the VM manager.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { context } from "./helpers.ts";
import {
    folderProblem,
    gitProtected,
    hasDotGit,
    holdsGitDir,
    isDotGit,
    whereTable,
} from "../src/server/extensions/gondolin/policy.ts";
import { SandboxManager } from "../src/server/extensions/gondolin/manager.ts";
import { failedEnv } from "../src/server/sandbox.ts";
import { FakeDriver } from "./gondolin-fake.ts";

const roots: string[] = [];

const temp = () => {
    const path = mkdtempSync(join(tmpdir(), "gondolin-policy-"));

    roots.push(path);

    return path;
};

after(() => {
    for (const path of roots) {
        rmSync(path, { recursive: true, force: true });
    }
});

test("a name is .git by Git's own rules: case, trailing dots and spaces, NTFS short names and streams, HFS ignorables", () => {
    for (const name of [
        ".git",
        ".GIT",
        ".Git",
        ".gIt",
        ".git.",
        ".git ",
        ".git. .",
        ".git...",
        "git~1",
        "GIT~1",
        "git~1.",
        "git~2",
        ".git::$INDEX_ALLOCATION",
        ".git:stream",
        ".g\u200cit",
        ".gi\u200ft",
        "\u200e.git",
        ".git\ufeff",
        ".\u202agit",
    ]) {
        assert.equal(isDotGit(name), true, JSON.stringify(name));
    }

    for (const name of [
        "",
        ".",
        "..",
        ".gitignore",
        ".gitmodules",
        ".gitattributes",
        ".github",
        ".git2",
        ".gitx",
        "git",
        "git~",
        "git~x",
        "a.git",
        "x.git",
        ".gi",
        "..git",
        "git~1.txt",
        ".git.txt",
        ".g it",
        ".get",
    ]) {
        assert.equal(isDotGit(name), false, JSON.stringify(name));
    }

    assert.equal(hasDotGit("/a/.Git/config"), true);
    assert.equal(hasDotGit("/a/b\\.git"), true, "a backslash separates names on NTFS");
    assert.equal(hasDotGit("/a/git~1/hooks"), true);
    assert.equal(hasDotGit("/src/.github/workflows/ci.yml"), false);
});

test("the guest may not write a git directory, a .git entry of the folder, or a folder that holds a git directory", () => {
    const guarded = gitProtected("/work", ["/work/gitdata", "/other/.git"]);

    for (const path of [
        "/work/.git",
        "/work/.git/config",
        "/work/.GIT/hooks/pre-commit",
        "/work/pkg/.git/index",
        "/work/pkg/.git",
        "/work/a/git~1/x",
        "/work/gitdata",
        "/work/gitdata/objects/ab/cd",
        "/WORK/GitData/HEAD",
        "/other/.git/refs/heads/main",
    ]) {
        assert.equal(guarded(path), true, path);
    }

    for (const path of [
        "/work",
        "/work/src/index.ts",
        "/work/.gitignore",
        "/work/.github/ci.yml",
        "/work/gitdata2/x",
        "/other",
        "/other/readme",
    ]) {
        assert.equal(guarded(path), false, path);
    }

    // A folder that lies inside a git directory is wholly the git directory's.
    assert.equal(gitProtected("/repo/.git/sub", ["/repo/.git"])("/repo/.git/sub/file"), true);

    assert.equal(holdsGitDir("/work", ["/work/gitdata"]), true);
    assert.equal(holdsGitDir("/work/gitdata", ["/work/gitdata"]), true);
    assert.equal(holdsGitDir("/work/src", ["/work/gitdata"]), false);
    assert.equal(holdsGitDir("/work/gitdata/objects", ["/work/gitdata"]), false);
});

test("a folder that is, or lies inside, a git directory cannot be a sandbox's folder", () => {
    const base = temp();
    const places = {
        home: join(base, "home"),
        dataDir: join(base, "data"),
        agentDir: join(base, "agent"),
    };
    const repo = join(base, "repo");
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });

    for (const dir of [repo, places.home, places.dataDir, places.agentDir]) {
        mkdirSync(dir, { recursive: true });
    }

    git("init", "-q", "-b", "main");
    git(
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "first",
    );
    git("worktree", "add", "-q", join(base, "tree"), "-b", "feature");
    git("init", "-q", "--bare", join(base, "bare.git"));
    mkdirSync(join(repo, "src"));

    for (const dir of [
        join(repo, ".git"),
        join(repo, ".git", "hooks"),
        join(repo, ".git", "refs", "heads"),
        join(repo, ".git", "worktrees", "tree"),
        join(base, "bare.git"),
        join(base, "bare.git", "hooks"),
    ]) {
        assert.match(folderProblem(dir, places) ?? "", /git directory/, dir);
    }

    for (const dir of [repo, join(repo, "src"), join(base, "tree")]) {
        assert.equal(folderProblem(dir, places), undefined, dir);
    }

    // A git directory that a VM mounts is not a session's folder: it passes the private-folder check only.
    assert.equal(folderProblem(join(repo, ".git"), places, "git"), undefined);
});

test("an environment that cannot run answers every call with the reason, and is not a promise", async () => {
    const env = failedEnv("/work", "the sandbox is off");

    assert.equal((env as unknown as { then?: unknown }).then, undefined);
    assert.equal(await Promise.resolve(env), env, "awaiting it gives it back");
    const run = await env.exec("touch /tmp/should-not-exist", undefined, context);

    assert.equal(run.ok, false);
    assert.match((run as { error: Error }).error.message, /the sandbox is off/);

    for (const result of [
        await env.readTextFile("a", context),
        await env.writeFile("a", "x", context),
        await env.fileInfo("a", context),
        await env.listDir(".", context),
        await env.createDir("d", undefined, context),
        await env.remove("a", undefined, context),
        await env.canonicalPath("a", context),
    ]) {
        assert.equal(result.ok, false);
        assert.match((result as { error: Error }).error.message, /the sandbox is off/);
    }

    assert.equal(env.cwd, "/work");
});

test("the table of what runs where follows the host-tools setting", () => {
    const blocked = whereTable("block").find((row) => row.what.startsWith("session tools"));
    const allowed = whereTable("allow").find((row) => row.what.startsWith("session tools"));

    assert.equal(blocked?.where, "blocked");
    assert.equal(allowed?.where, "host");
    assert.ok(
        whereTable("block").some((row) => row.where === "sandbox" && row.what.includes("bash")),
    );

    // Background tasks and the team tool run in the sandbox whatever the owner allows for host tools.
    for (const mode of ["block", "allow"] as const) {
        for (const what of ["background", "team"]) {
            assert.equal(
                whereTable(mode).find((row) => row.what.startsWith(what))?.where,
                "sandbox",
            );
        }
    }

    assert.ok(
        whereTable("block").some((row) => row.what.includes("browser") && row.where === "sandbox"),
    );
});

function manager(driver: FakeDriver, directory: string, idleMinutes = 30) {
    return new SandboxManager({
        driver,
        log: () => {},
        pidFile: join(directory, "vms.json"),
        settings: () => ({
            backend: "auto",
            mount: "rw",
            network: "off",
            allowedHosts: [],
            cpus: 1,
            memoryMb: 512,
            diskMb: 1024,
            idleMinutes,
            maxVms: 2,
            image: "alpine-base:latest",
        }),
    });
}

test("an idle VM stops, a VM with a command running does not, and the next call starts a new one", async () => {
    const driver = new FakeDriver();
    const directory = temp();
    // 0.02 minutes: the manager looks after a second.
    const vms = manager(driver, directory, 0.02);
    const env = vms.envFor(1, { rootId: 1, cwd: directory, uploadDir: undefined });

    assert.ok((await env.exec("true", undefined, context)).ok);
    assert.equal(driver.log.started.length, 1);
    const long = env.exec("tail -f /dev/null", { timeout: 2.5 }, context);

    await new Promise((resolve) => setTimeout(resolve, 1800));
    assert.equal(driver.log.closed.length, 0, "a running command keeps it");
    await long;
    await new Promise((resolve) => setTimeout(resolve, 2500));
    assert.equal(driver.log.closed.length, 1, "idle: stopped");
    assert.equal(vms.state(1)?.phase, "stopped");
    assert.match(vms.state(1)?.note ?? "", /idle/);
    assert.ok((await env.exec("true", undefined, context)).ok);
    assert.equal(driver.log.started.length, 2, "a new VM for the next call");
    await vms.stopAll("the test ended");
});

test("a VM that dies on its own is noted, and the next call starts another", async () => {
    const driver = new FakeDriver();
    const directory = temp();
    const vms = manager(driver, directory);
    const env = vms.envFor(2, { rootId: 2, cwd: directory, uploadDir: undefined });

    assert.ok((await env.exec("true", undefined, context)).ok);
    driver.vms[0]!.crash("the runner was killed");
    assert.equal(vms.state(2)?.phase, "stopped");
    assert.match(vms.state(2)?.note ?? "", /the runner was killed/);
    assert.ok((await env.exec("true", undefined, context)).ok);
    assert.equal(driver.log.started.length, 2);
    await vms.stopAll("the test ended");
});

test("a start that fails says why, and is tried again", async () => {
    const driver = new FakeDriver();
    const directory = temp();
    const vms = manager(driver, directory);
    const env = vms.envFor(3, { rootId: 3, cwd: directory, uploadDir: undefined });

    driver.failStart = "no /dev/kvm";
    const failed = await env.exec("true", undefined, context);

    assert.equal(failed.ok, false);
    assert.match(
        (failed as { error: Error }).error.message,
        /The sandbox could not start: no \/dev\/kvm/,
    );
    assert.equal(vms.state(3)?.phase, "error");
    // Files fail the same way: no fallback to this machine's files.
    writeFileSync(join(directory, "host-file"), "host");
    const read = await env.readTextFile(join(directory, "host-file"), context);

    assert.equal(read.ok, false);
    driver.failStart = undefined;
    assert.ok((await env.exec("true", undefined, context)).ok);
    await vms.stopAll("the test ended");
});

test("a runner that an earlier server left behind is ended, and a reused process id is not", async () => {
    const driver = new FakeDriver();
    const directory = temp();
    const killed: number[] = [];
    const file = join(directory, "vms.json");
    const lines: Record<number, string | undefined> = {
        101: "/x/node_modules/@earendil-works/gondolin-krun-runner-linux-x64/bin/gondolin-krun-runner --config /tmp/c.json",
        102: "/usr/bin/vim notes.txt",
        103: undefined,
        104: "qemu-system-x86_64 -machine microvm",
    };

    writeFileSync(
        file,
        JSON.stringify([101, 102, 103, 104].map((pid) => ({ pid, vm: `vm-${pid}` }))),
    );
    const vms = new SandboxManager({
        driver,
        log: () => {},
        pidFile: file,
        settings: () => ({}) as never,
        inspect: async (pid) => lines[pid],
        kill: (pid) => {
            killed.push(pid);
        },
    });

    assert.equal(await vms.reapStale(), 2);
    assert.deepEqual(killed.sort(), [101, 104]);
    assert.equal(readFileSync(file, "utf8"), "[]");
});
