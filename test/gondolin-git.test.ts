// The Git boundary of the sandbox (`git.ts`, and its use in `manager.ts`), with a fake VM and host Git: which git
// directories a folder reaches, and the rule that a VM does not start with a writable folder when Git would run code
// from it. The real VM enforces the same boundary in `gondolin-real-git.test.ts`.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { gitMounts } from "../src/server/extensions/gondolin/git.ts";
import { SandboxManager } from "../src/server/extensions/gondolin/manager.ts";
import { context } from "./helpers.ts";
import { FakeDriver } from "./gondolin-fake.ts";

const roots: string[] = [];

const temp = () => {
    const path = realpathSync(mkdtempSync(join(tmpdir(), "gondolin-git-")));

    roots.push(path);

    return path;
};

after(() => {
    for (const path of roots) {
        rmSync(path, { recursive: true, force: true });
    }
});

const author = {
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
};
const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...author } });

/** A repository with one commit. */
function repository(): string {
    const path = temp();

    git(path, "init", "-q", "-b", "main");
    writeFileSync(join(path, "a.txt"), "a\n");
    git(path, "add", ".");
    git(path, "commit", "-q", "-m", "first");

    return path;
}

const settings =
    (mount: "rw" | "ro", idleMinutes = 30) =>
    () => ({
        backend: "auto" as const,
        mount,
        network: "off" as const,
        allowedHosts: [],
        cpus: 1,
        memoryMb: 512,
        diskMb: 1024,
        idleMinutes,
        maxVms: 4,
        image: "alpine-base:latest",
    });

let numbers = 0;

function manager(driver: FakeDriver, mount: "rw" | "ro" = "rw", idleMinutes = 30) {
    return new SandboxManager({
        driver,
        log: () => {},
        pidFile: join(tmpdir(), `gondolin-git-vms-${process.pid}.json`),
        settings: settings(mount, idleMinutes),
    });
}

/** Whether a VM starts for `cwd`, and what the call says when it does not. */
async function starts(cwd: string, mount: "rw" | "ro" = "rw", env: NodeJS.ProcessEnv = {}) {
    const driver = new FakeDriver();
    const vms = manager(driver, mount);
    const rootId = ++numbers;
    const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));

    Object.assign(process.env, env);

    try {
        const result = await vms
            .envFor(rootId, { rootId, cwd, uploadDir: undefined })
            .exec("true", undefined, context);

        return {
            started: driver.log.started.length === 1,
            message: result.ok ? "" : String((result as { error: Error }).error.message),
            spec: driver.log.started[0],
        };
    } finally {
        await vms.stopAll("the test ended");

        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }
    }
}

test("the git directories a folder reaches: its own, a worktree's common directory, one of another name that names the folder back, and each submodule's", async () => {
    const main = repository();
    const sub = repository();

    git(main, "-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "vendor/lib");
    git(main, "commit", "-q", "-m", "with a submodule");

    const plain = await gitMounts(main);

    assert.deepEqual(
        [...plain.gitDirs].sort(),
        [join(main, ".git"), join(main, ".git", "modules", "vendor", "lib")].sort(),
    );
    assert.deepEqual(plain.trees, [main, join(main, "vendor", "lib")]);
    assert.deepEqual(plain.safeDirectories, [main, join(main, "vendor", "lib")]);

    const tree = `${main}-tree`;

    roots.push(tree);
    git(main, "worktree", "add", "-q", tree, "-b", "feature");
    const worktree = await gitMounts(tree);

    assert.deepEqual(worktree.gitDirs, [join(main, ".git")]);
    assert.deepEqual(worktree.safeDirectories, [tree, main]);

    // A git directory of another name inside the folder, whose configuration names the folder back.
    const separate = temp();
    const data = join(separate, "gitdata");

    git(separate, "init", "-q", "--separate-git-dir", data, ".");
    git(separate, "config", "--file", join(data, "config"), "core.worktree", separate);
    assert.deepEqual((await gitMounts(separate)).gitDirs, [data]);
    assert.deepEqual((await gitMounts(temp())).gitDirs, [], "a folder with no repository");
});

test("a submodule that is a link to another folder shares nothing, and a .git file that names no git directory shares nothing", async () => {
    const main = repository();
    const sub = repository();
    const other = repository();

    git(main, "-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "lib");
    git(main, "commit", "-q", "-m", "with a submodule");
    rmSync(join(main, "lib"), { recursive: true, force: true });
    symlinkSync(other, join(main, "lib"));

    assert.deepEqual((await gitMounts(main)).gitDirs, [join(main, ".git")]);

    const forged = temp();

    writeFileSync(join(forged, ".git"), `gitdir: ${forged}\n`);
    assert.deepEqual((await gitMounts(forged)).gitDirs, [], "a folder that is no git directory");
});

test("every git directory that a .git file names is guarded, with a back-pointer or without one", async () => {
    // `git init --separate-git-dir` writes no `core.worktree`: inside the folder, and outside it.
    const inside = temp();
    const data = join(inside, "gitdata");

    git(inside, "init", "-q", "--separate-git-dir", data, ".");
    assert.deepEqual((await gitMounts(inside)).gitDirs, [data]);

    const outside = temp();
    const kept = temp();

    git(outside, "init", "-q", "--separate-git-dir", join(kept, "gitdata"), ".");
    assert.deepEqual((await gitMounts(outside)).gitDirs, [join(kept, "gitdata")]);
    assert.equal((await starts(outside)).spec!.gitDirs[0], join(kept, "gitdata"));

    // A linked worktree whose record does not point back: guarded where it lies in the folder, shared nowhere else.
    const main = repository();
    const tree = `${main}-tree`;

    roots.push(tree);
    git(main, "worktree", "add", "-q", tree, "-b", "moved");
    const record = join(main, ".git", "worktrees", tree.split("/").at(-1)!, "gitdir");

    writeFileSync(record, join(main, "elsewhere", ".git"));
    assert.deepEqual((await gitMounts(tree)).gitDirs, [], "not shared, as a worktree");
    assert.deepEqual((await gitMounts(main)).gitDirs, [join(main, ".git")]);
});

/** What the sandbox must say, and what it must name, when a writable folder holds what git would run. */
async function refused(cwd: string, path: string, env?: NodeJS.ProcessEnv) {
    const writable = await starts(cwd, "rw", env);

    assert.equal(writable.started, false, `${path}: a VM started`);
    assert.ok(writable.message.includes(path), `${path} is named: ${writable.message}`);
    assert.match(writable.message, /read only/);

    const readOnly = await starts(cwd, "ro", env);

    assert.equal(readOnly.started, true, `a read only folder works: ${readOnly.message}`);
}

test("a hooks folder inside a writable folder keeps the VM from starting, and a read only folder still works", async () => {
    const repo = repository();

    assert.equal((await starts(repo)).started, true, "the default hooks folder is inside .git");

    git(repo, "config", "core.hooksPath", ".githooks");
    await refused(repo, join(repo, ".githooks"));

    // A husky repository: the hooks folder does not exist yet.
    git(repo, "config", "core.hooksPath", ".husky/_");
    await refused(repo, join(repo, ".husky", "_"));

    git(repo, "config", "core.hooksPath", "../shared-hooks");
    assert.equal((await starts(repo)).started, true, "a hooks folder outside the folder");

    git(repo, "config", "core.hooksPath", join(repo, ".git", "custom-hooks"));
    assert.equal((await starts(repo)).started, true, "a hooks folder in the git directory");
});

test("a hooks folder that leads into the folder by a link, or by a link that leads nowhere yet, keeps it from starting", async () => {
    const repo = repository();
    const outside = temp();

    mkdirSync(join(repo, "tools"));
    symlinkSync(join(repo, "tools"), join(outside, "via-link"));
    symlinkSync(join(repo, "not-yet", "hooks"), join(outside, "dangling"));
    git(repo, "config", "core.hooksPath", join(outside, "via-link"));
    await refused(repo, join(repo, "tools"));
    git(repo, "config", "core.hooksPath", join(outside, "dangling"));
    await refused(repo, join(repo, "not-yet", "hooks"));
});

test("a configuration file that git includes, even one that is not there yet, keeps a writable folder from starting", async () => {
    const repo = repository();
    const config = join(repo, ".git", "config");
    const outside = temp();

    writeFileSync(join(outside, "extra.cfg"), "[user]\n\tname = x\n");
    git(repo, "config", "include.path", join(outside, "extra.cfg"));
    assert.equal((await starts(repo)).started, true, "an included file outside the folder");

    git(repo, "config", "--unset-all", "include.path");
    git(repo, "config", "include.path", "../extra.cfg");
    await refused(repo, join(repo, "extra.cfg"));

    git(repo, "config", "--unset-all", "include.path");
    git(repo, "config", "includeIf.onbranch:never.path", "../later.cfg");
    await refused(repo, join(repo, "later.cfg"));

    git(repo, "config", "--unset-all", "includeIf.onbranch:never.path");
    git(repo, "config", "include.path", "more.cfg");
    assert.equal((await starts(repo)).started, true, "an included file in the git directory");
    assert.ok(config.length > 0);

    git(repo, "config", "--unset-all", "include.path");
    const global = join(outside, "global.cfg");

    writeFileSync(global, `[include]\n\tpath = ${join(repo, "from-global.cfg")}\n`);
    await refused(repo, join(repo, "from-global.cfg"), { GIT_CONFIG_GLOBAL: global });
});

/** A key that the repository's own configuration sets must name what the sandbox cannot rewrite, so it is refused. */
async function programRefused(repo: string, key: string, value: string) {
    git(repo, "config", key, value);
    const writable = await starts(repo, "rw");

    assert.equal(writable.started, false, `${key} = ${value}: a VM started`);
    assert.ok(writable.message.includes(key.toLowerCase()), `${key} is named: ${writable.message}`);
    assert.match(writable.message, /read only/);
    assert.equal((await starts(repo, "ro")).started, true, "a read only folder works");
    git(repo, "config", "--unset-all", key);
}

test("a program that the repository's configuration names keeps a writable folder from starting, and a boolean or a global one does not", async () => {
    const repo = repository();

    for (const [key, value] of [
        ["core.fsmonitor", "./watch.sh"],
        ["core.sshCommand", "ssh -F ./ssh-config"],
        ["core.editor", "./edit.sh"],
        ["core.pager", "./page.sh"],
        ["core.askPass", "./ask.sh"],
        ["gpg.program", "./sign.sh"],
        ["gpg.ssh.program", "./sign.sh"],
        ["credential.helper", "!./cred.sh"],
        ["credential.https://example.com.helper", "./cred"],
        ["diff.x.command", "./diff.sh"],
        ["diff.x.textconv", "./conv.sh"],
        ["merge.x.driver", "./merge.sh %O"],
        ["filter.x.clean", "./clean.sh"],
        ["filter.x.smudge", "./smudge.sh"],
        ["filter.x.process", "./process.sh"],
        ["difftool.x.cmd", "./dt.sh"],
        ["mergetool.x.cmd", "./mt.sh"],
        ["remote.origin.uploadpack", "./up.sh"],
        ["remote.origin.receivepack", "./rp.sh"],
        ["alias.co", "!./co.sh"],
        ["sequence.editor", "./seq.sh"],
    ] as const) {
        await programRefused(repo, key, value);
    }

    for (const [key, value] of [
        ["core.fsmonitor", "true"],
        ["core.fsmonitor", "false"],
        ["alias.st", "status -s"],
        ["user.name", "someone"],
        ["diff.x.binary", "true"],
    ] as const) {
        git(repo, "config", key, value);
        assert.equal((await starts(repo)).started, true, `${key} = ${value}`);
        git(repo, "config", "--unset-all", key);
    }

    // A program in the global configuration is the machine's: it does not count.
    const global = join(temp(), "global.cfg");

    writeFileSync(global, "[core]\n\tsshCommand = ./global-ssh.sh\n[alias]\n\tgo = !./go.sh\n");
    assert.equal((await starts(repo, "rw", { GIT_CONFIG_GLOBAL: global })).started, true);
});

test("a program in a worktree's own configuration, or in a submodule's, counts as the repository's", async () => {
    const main = repository();
    const sub = repository();

    git(main, "-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "lib");
    git(main, "commit", "-q", "-m", "with a submodule");
    git(join(main, "lib"), "config", "core.fsmonitor", "./watch.sh");
    const refusal = await starts(main, "rw");

    assert.equal(refusal.started, false);
    assert.match(refusal.message, /core\.fsmonitor/);
    git(join(main, "lib"), "config", "--unset", "core.fsmonitor");

    git(main, "config", "extensions.worktreeConfig", "true");
    git(main, "config", "--worktree", "core.sshCommand", "./ssh.sh");
    const worktree = await starts(main, "rw");

    assert.equal(worktree.started, false);
    assert.match(worktree.message, /core\.sshcommand/);
});

test("when git does not say which scope a value comes from, a writable folder does not start", async () => {
    const repo = repository();
    const bin = temp();

    writeFileSync(
        join(bin, "git"),
        '#!/bin/sh\ncase "$*" in *show-scope*) printf "\\0file:x\\0core.editor\\nvi\\0" ;; *) exec /usr/bin/git "$@" ;; esac\n',
        { mode: 0o755 },
    );
    const refusal = await starts(repo, "rw", { PATH: `${bin}:${process.env.PATH}` });

    assert.equal(refusal.started, false);
    assert.match(refusal.message, /could not ask git|scope/);
});

test("a submodule's hooks folder inside the folder keeps the VM from starting", async () => {
    const main = repository();
    const sub = repository();

    git(main, "-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "lib");
    git(main, "commit", "-q", "-m", "with a submodule");
    assert.equal((await starts(main)).started, true);
    git(join(main, "lib"), "config", "core.hooksPath", "../hooks-of-lib");
    await refused(main, join(main, "hooks-of-lib"));
});

test("when git cannot be asked, a writable folder does not start, and the message says why", async () => {
    const repo = temp();

    mkdirSync(join(repo, ".git", "objects"), { recursive: true });
    writeFileSync(join(repo, ".git", "HEAD"), "not a ref\n");
    const result = await starts(repo);

    assert.equal(result.started, false);
    assert.match(result.message, /could not ask git|git .* failed/);

    const none = temp();

    assert.equal((await starts(none)).started, true, "a folder with no repository needs no answer");
});

test("a VM is given every git directory that the folder reaches, its own too", async () => {
    const repo = repository();
    const result = await starts(repo);

    assert.deepEqual(result.spec!.gitDirs, [join(repo, ".git")]);
    assert.deepEqual(result.spec!.safeDirectories, [repo]);
});

test("a call that was meant for a folder the session has left does not run in the VM of the new one", async () => {
    const first = temp();
    const second = temp();
    const driver = new FakeDriver();
    const vms = manager(driver);

    try {
        const old = vms.envFor(2, { rootId: 2, cwd: first, uploadDir: undefined });

        assert.ok((await old.exec("true", undefined, context)).ok);
        const moved = vms.envFor(2, { rootId: 2, cwd: second, uploadDir: undefined });
        const result = await old.exec("true", undefined, context);

        assert.equal(result.ok, false, "the old environment fails");
        assert.ok(!result.ok);
        assert.match(
            String((result as { error: Error }).error.message),
            /meant for .* but the session works in/,
        );
        assert.equal(driver.log.started.length, 1, "no VM started for it");
        assert.ok((await moved.exec("true", undefined, context)).ok);
        assert.equal(driver.log.started.at(-1)!.cwd, second);
    } finally {
        await vms.stopAll("the test ended");
    }
});

test("a VM is not stopped for idleness while a call runs in it, and a stop in the middle of a call gives the next one a new VM", async () => {
    const root = repository();
    const driver = new FakeDriver();
    const vms = manager(driver, "rw", 0.02);
    const env = vms.envFor(3, { rootId: 3, cwd: root, uploadDir: undefined });

    try {
        // The idle time (1.2 s) passes while the command runs.
        const long = await env.exec("sleep 2; echo done", undefined, context);

        assert.ok(long.ok);
        assert.equal(driver.log.started.length, 1, "the same VM served the call");
        const running = env.exec("sleep 1", undefined, context);

        await new Promise((resolve) => setTimeout(resolve, 200));
        await vms.stop(3, "stopped meanwhile");
        await running;
        assert.ok((await env.exec("true", undefined, context)).ok);
        assert.equal(driver.log.started.length, 2);
    } finally {
        await vms.stopAll("the test ended");
    }
});
