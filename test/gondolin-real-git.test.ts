// The Git boundary with a real VM: the guest writes the work tree and never a git directory, whatever path it takes to
// one. It runs only when `PI_POCKET_GONDOLIN_REAL` names a folder that has the Gondolin package and the image
// `pocket-base:latest` (with git) in its store, and the host can run a VM. Otherwise every test here is skipped.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
    existsSync,
    linkSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test, type TestContext } from "node:test";
import { NO_GIT_WRITE } from "../src/server/extensions/gondolin/git.ts";
import type { HostCheck } from "../src/server/extensions/gondolin/guest.ts";
import { SandboxManager } from "../src/server/extensions/gondolin/manager.ts";
import { GondolinDriver } from "../src/server/extensions/gondolin/real-driver.ts";
import { context } from "./helpers.ts";

const dir = process.env.PI_POCKET_GONDOLIN_REAL;
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "gondolin-real-git-")));
let driver: GondolinDriver | undefined;
let check: HostCheck | undefined;
const managers: Record<"rw" | "ro", SandboxManager | undefined> = { rw: undefined, ro: undefined };

before(async () => {
    if (dir === undefined) {
        return;
    }

    driver = new GondolinDriver(dir);
    check = await driver.check({ backend: "auto", image: "alpine-base:latest" });

    if (check.ok) {
        for (const mount of ["rw", "ro"] as const) {
            managers[mount] = new SandboxManager({
                driver,
                log: () => {},
                pidFile: join(scratch, `vms-${mount}.json`),
                settings: () => ({
                    backend: "auto",
                    mount,
                    network: "off",
                    allowedHosts: [],
                    cpus: 1,
                    memoryMb: 768,
                    diskMb: 2048,
                    idleMinutes: 0,
                    maxVms: 8,
                    image: "alpine-base:latest",
                }),
            });
        }
    }
});

after(async () => {
    await managers.rw?.stopAll("the test ended");
    await managers.ro?.stopAll("the test ended");
    rmSync(scratch, { recursive: true, force: true });
});

function unavailable(t: TestContext): boolean {
    const why =
        dir === undefined
            ? "PI_POCKET_GONDOLIN_REAL is not set"
            : check?.ok !== true
              ? "this host cannot run a VM"
              : !check.images.some((each) => each.name === "pocket-base:latest" && each.git)
                ? "the image pocket-base:latest with git is not in the store"
                : undefined;

    if (why !== undefined) {
        t.skip(why);
    }

    return why !== undefined;
}

const author = {
    GIT_AUTHOR_NAME: "host",
    GIT_AUTHOR_EMAIL: "host@host",
    GIT_COMMITTER_NAME: "host",
    GIT_COMMITTER_EMAIL: "host@host",
};
const onHost = (cwd: string, ...args: string[]): string =>
    execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...author } });

function repository(prefix: string): string {
    const path = realpathSync(mkdtempSync(join(scratch, `${prefix}-`)));

    onHost(path, "init", "-q", "-b", "main");
    writeFileSync(join(path, "a.txt"), "a\n");
    onHost(path, "add", ".");
    onHost(path, "commit", "-q", "-m", "first");

    return path;
}

let numbers = 500;

/** Run a command in a VM of its own for `cwd`, and say how it went. */
async function inVm(cwd: string, command: string, mount: "rw" | "ro" = "rw") {
    const vms = managers[mount]!;
    const rootId = ++numbers;
    const env = vms.envFor(rootId, { rootId, cwd, uploadDir: undefined });
    let output = "";
    const result = await env.exec(
        command,
        { onOutput: (text) => (output += text), timeout: 90 },
        context,
    );

    await vms.stop(rootId, "the call ended");

    return {
        output,
        started: result.ok,
        error: result.ok ? "" : String((result as { error: Error }).error.message),
    };
}

/** Every entry below `path`, with the content of each file, as one text: what must not change. */
const snapshot = (path: string): string =>
    execFileSync(
        "sh",
        ["-c", 'cd "$0" && find . -type f | sort | xargs -r md5sum && find . | sort', path],
        { encoding: "utf8" },
    );

const failed = (output: string, ...names: string[]) => {
    for (const name of names) {
        assert.match(output, new RegExp(`${name}=[1-9]`), `${name}: ${output}`);
    }
};

test("git reads work in the VM, and add and commit say that Git metadata is read only", async (t) => {
    if (unavailable(t)) {
        return;
    }

    const repo = repository("read");
    const before = readFileSync(join(repo, ".git", "index"));
    const { output } = await inVm(
        repo,
        [
            "echo optional=$GIT_OPTIONAL_LOCKS",
            "echo b >> a.txt",
            "git status --short; echo status=$?",
            "git diff --stat | tail -1; echo diff=$?",
            "git log --oneline | head -2; echo log=$?",
            "git show --stat HEAD | head -3; echo show=$?",
            "git blame a.txt | head -2; echo blame=$?",
            "git add a.txt 2>&1; echo add=$?",
            "git commit -m 'from the vm' 2>&1; echo commit=$?",
            "git branch topic 2>&1; echo branch=$?",
            "git config user.name evil 2>&1; echo config=$?",
            "git remote add other https://x.example/y.git 2>&1; echo remote=$?",
        ].join("; "),
    );

    assert.match(output, /optional=0/);
    assert.match(output, /M a\.txt/);
    assert.match(output, /1 file changed, 1 insertion/);
    assert.match(output, /first/);
    assert.match(output, /\^?[0-9a-f]+ \(host/);

    for (const name of ["status", "diff", "log", "show", "blame"]) {
        assert.match(output, new RegExp(`${name}=0`), `${name}: ${output}`);
    }

    failed(output, "add", "commit", "branch", "config", "remote");
    assert.ok(output.split(NO_GIT_WRITE).length - 1 >= 5, output);
    assert.equal(onHost(repo, "log", "--format=%s"), "first\n");
    assert.equal(onHost(repo, "diff", "--cached"), "");
    assert.equal(onHost(repo, "branch", "--list", "topic"), "");
    assert.ok(!readFileSync(join(repo, ".git", "config"), "utf8").includes("evil"));
    assert.deepEqual(readFileSync(join(repo, ".git", "index")), before, "status wrote no index");
});

test("the guest cannot write a git directory by any path: a file, a new entry, a .git variant, a link", async (t) => {
    if (unavailable(t)) {
        return;
    }

    const repo = repository("write");

    writeFileSync(join(repo, ".gitignore"), "sub/\n");
    mkdirSync(join(repo, "sub"));
    onHost(join(repo, "sub"), "init", "-q");

    const kept = {
        git: snapshot(join(repo, ".git")),
        nested: snapshot(join(repo, "sub", ".git")),
    };
    const { output } = await inVm(
        repo,
        [
            "echo x >> .git/config; echo config=$?",
            "echo x > .git/hooks/pre-commit; echo hook=$?",
            "echo x > .git/HEAD; echo head=$?",
            "echo x > .git/refs/heads/evil; echo ref=$?",
            "echo x > .git/objects/zz; echo object=$?",
            "mkdir .git/lfs; echo mkdir=$?",
            "rm .git/index; echo rmindex=$?",
            "rm -rf .git/hooks; echo rmhooks=$?",
            "mv .git .git-moved; echo mvgit=$?",
            "mv .git/config c; echo mvconfig=$?",
            "echo x > sub/.git/hooks/pre-commit; echo nested=$?",
            "mkdir .GIT; echo upper=$?",
            "mkdir .git.; echo dot=$?",
            "printf x > '.git '; echo space=$?",
            "mkdir 'git~1'; echo short=$?",
            "mkdir \"$(printf '.g\\342\\200\\214it')\"; echo hfs=$?",
            "mkdir lib; mkdir lib/.Git; echo deepvariant=$?",
            "ln .git/config c1; echo link1=$?",
            "ln .git/HEAD h; echo link2=$?",
            "ln a.txt .git/a; echo link3=$?",
            "ln -s .git/config sl; echo x >> sl; echo viasymlink=$?",
            "ln sl c2; echo link4=$?",
            "ln -s .git g; echo x > g/hooks/pre-commit; echo viadir=$?",
            "mv g/config c3; echo mvviadir=$?",
            "rm g/index; echo rmviadir=$?",
            "rm g; echo rmlink=$?",
            "mv sub sub2; echo mvnested=$?",
            "echo ok > notes.txt; echo notes=$?",
            "mkdir .gitx; echo gitx=$?",
            "echo ok > .gitignore2; echo gitignore=$?",
        ].join("; "),
    );

    failed(
        output,
        "config",
        "hook",
        "head",
        "ref",
        "object",
        "mkdir",
        "rmindex",
        "rmhooks",
        "mvgit",
        "mvconfig",
        "nested",
        "upper",
        "dot",
        "space",
        "short",
        "hfs",
        "deepvariant",
        "link1",
        "link2",
        "link3",
        "viasymlink",
        "link4",
        "viadir",
        "mvviadir",
        "rmviadir",
        "mvnested",
    );

    // A name that is not .git is the guest's, and so is a link that it made (the entry, not what it names).
    for (const name of ["notes", "gitx", "gitignore", "rmlink"]) {
        assert.match(output, new RegExp(`${name}=0`), `${name}: ${output}`);
    }

    assert.equal(snapshot(join(repo, ".git")), kept.git);
    assert.equal(snapshot(join(repo, "sub", ".git")), kept.nested);
    assert.equal(existsSync(join(repo, ".git", "hooks", "pre-commit")), false);
    assert.equal(existsSync(join(repo, "sub2")), false);
    assert.equal(existsSync(join(repo, ".GIT")), false);
    assert.equal(existsSync(join(repo, "git~1")), false);
    assert.ok(!readFileSync(join(repo, ".git", "config"), "utf8").includes("x\n"));
});

test("a separate git directory (git init --separate-git-dir, no back-pointer) inside the folder is read only, and so is every folder that holds it", async (t) => {
    if (unavailable(t)) {
        return;
    }

    const repo = realpathSync(mkdtempSync(join(scratch, "separate-")));
    const data = join(repo, "deep", "er", "gitdata");

    mkdirSync(join(repo, "deep", "er"), { recursive: true });
    onHost(repo, "init", "-q", "-b", "main", "--separate-git-dir", data, ".");
    writeFileSync(join(repo, "a.txt"), "a\n");
    onHost(repo, "add", ".");
    onHost(repo, "commit", "-q", "-m", "first");
    const before = snapshot(data);
    const { output } = await inVm(
        repo,
        [
            "git log --oneline | head -1; echo log=$?",
            "echo x >> deep/er/gitdata/config; echo config=$?",
            "echo x > deep/er/gitdata/hooks/pre-commit; echo hook=$?",
            "echo x > deep/er/gitdata/refs/heads/y; echo ref=$?",
            "rm deep/er/gitdata/index; echo remove=$?",
            "mv deep/er/gitdata deep/er/gd2; echo mvdir=$?",
            "mv deep/er er2; echo mvparent=$?",
            "mv deep deep2; echo mvancestor=$?",
            "ln deep/er/gitdata/config c; echo link=$?",
            "echo x > .git; echo pointer=$?",
            "echo ok > deep/er/other.txt; echo other=$?",
        ].join("; "),
    );

    assert.match(output, /log=0/);
    failed(
        output,
        "config",
        "hook",
        "ref",
        "remove",
        "mvdir",
        "mvparent",
        "mvancestor",
        "link",
        "pointer",
    );
    assert.match(output, /other=0/, "the rest of the folder is the guest's");
    assert.equal(snapshot(data), before);
    assert.equal(existsSync(join(repo, "deep2")), false);
    assert.equal(existsSync(join(repo, "deep", "er2")), false);
});

test("a separate git directory outside the folder is a read only mount, and git reads through it", async (t) => {
    if (unavailable(t)) {
        return;
    }

    const repo = realpathSync(mkdtempSync(join(scratch, "outside-")));
    const data = realpathSync(mkdtempSync(join(scratch, "outside-data-")));

    onHost(repo, "init", "-q", "-b", "main", "--separate-git-dir", join(data, "g"), ".");
    writeFileSync(join(repo, "a.txt"), "a\n");
    onHost(repo, "add", ".");
    onHost(repo, "commit", "-q", "-m", "first");
    const before = snapshot(join(data, "g"));
    const { output } = await inVm(
        repo,
        [
            "git log --oneline | head -1; echo log=$?",
            "git status --short; echo status=$?",
            `echo x >> ${data}/g/config; echo config=$?`,
            `echo x > ${data}/g/hooks/pre-commit; echo hook=$?`,
            `echo x > ${data}/g/refs/heads/y; echo ref=$?`,
            `ln ${data}/g/config ./c; echo link=$?`,
            "echo w >> a.txt; git add a.txt 2>&1; echo add=$?",
        ].join("; "),
    );

    assert.match(output, /log=0/);
    assert.match(output, /status=0/);
    failed(output, "config", "hook", "ref", "link", "add");
    assert.equal(snapshot(join(data, "g")), before);
});

test("a program that the repository's configuration names keeps the VM from starting, and a read only folder works", async (t) => {
    if (unavailable(t)) {
        return;
    }

    const repo = repository("program");

    writeFileSync(join(repo, "watch.sh"), "#!/bin/sh\ntouch /tmp/ran-by-host\n", { mode: 0o755 });
    onHost(repo, "config", "core.fsmonitor", "./watch.sh");

    const writable = await inVm(repo, "echo started");

    assert.equal(writable.started, false);
    assert.match(writable.error, /core\.fsmonitor/);
    assert.match(writable.error, /read only/);
    assert.ok(!writable.output.includes("started"));

    const readOnly = await inVm(repo, "cat watch.sh; echo x > watch.sh; echo write=$?", "ro");

    assert.ok(readOnly.started, readOnly.error);
    failed(readOnly.output, "write");
    assert.equal(
        readFileSync(join(repo, "watch.sh"), "utf8"),
        "#!/bin/sh\ntouch /tmp/ran-by-host\n",
    );

    onHost(repo, "config", "--unset-all", "core.fsmonitor");
    assert.equal((await inVm(repo, "true")).started, true);
});

test("a hook that is a link into the folder keeps the VM from starting, and the same repository works in a read only folder", async (t) => {
    if (unavailable(t)) {
        return;
    }

    const repo = repository("hooklink");

    mkdirSync(join(repo, "scripts"));
    writeFileSync(join(repo, "scripts", "pre-commit"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    symlinkSync("../../scripts/pre-commit", join(repo, ".git", "hooks", "pre-commit"));

    const writable = await inVm(repo, "echo started");

    assert.equal(writable.started, false);
    assert.ok(writable.error.includes(join(repo, "scripts")), writable.error);
    assert.match(writable.error, /read only/);

    const readOnly = await inVm(
        repo,
        "echo x > scripts/pre-commit; echo write=$?; git log --oneline | head -1",
        "ro",
    );

    assert.ok(readOnly.started, readOnly.error);
    failed(readOnly.output, "write");
});

test("every repository found by walking the folder is read only to the guest: a nested one, one with a separate git directory, a bare one", async (t) => {
    if (unavailable(t)) {
        return;
    }

    const repo = repository("walk");
    const kept = realpathSync(mkdtempSync(join(scratch, "walk-data-")));

    mkdirSync(join(repo, "c"));
    onHost(join(repo, "c"), "init", "-q", "--separate-git-dir", join(repo, "c-data"), ".");
    mkdirSync(join(repo, "d"));
    onHost(join(repo, "d"), "init", "-q", "--separate-git-dir", join(kept, "d-data"), ".");
    onHost(repo, "init", "-q", "--bare", "bare.git");
    onHost(repo, "init", "-q", "nested");
    const before = [
        snapshot(join(repo, "c-data")),
        snapshot(join(kept, "d-data")),
        snapshot(join(repo, "bare.git")),
    ];
    const { output } = await inVm(
        repo,
        [
            "echo x >> c-data/config; echo cdata=$?",
            "echo x > c-data/hooks/pre-commit; echo chook=$?",
            "mv c-data c-data2; echo cmove=$?",
            "git -C c status --short; echo cstatus=$?",
            `echo x >> ${kept}/d-data/config; echo ddata=$?`,
            "git -C d status --short; echo dstatus=$?",
            "echo x >> bare.git/config; echo bare=$?",
            "echo x > bare.git/hooks/post-update; echo barehook=$?",
            "mv bare.git bare2.git; echo baremove=$?",
            "echo x > nested/.git/hooks/pre-commit; echo nested=$?",
            "echo ok > nested/file.txt; echo file=$?",
        ].join("; "),
    );

    assert.match(output, /cstatus=0/);
    assert.match(output, /dstatus=0/);
    failed(output, "cdata", "chook", "cmove", "ddata", "bare", "barehook", "baremove", "nested");
    assert.match(output, /file=0/);
    assert.deepEqual(
        [
            snapshot(join(repo, "c-data")),
            snapshot(join(kept, "d-data")),
            snapshot(join(repo, "bare.git")),
        ],
        before,
    );
});

test("a file with other hard links is never changed in place, and can be replaced or removed", async (t) => {
    if (unavailable(t)) {
        return;
    }

    const repo = repository("links");
    const store = realpathSync(mkdtempSync(join(scratch, "store-")));

    writeFileSync(join(store, "shared.txt"), "from the store\n");
    linkSync(join(store, "shared.txt"), join(repo, "linked.txt"));
    linkSync(join(store, "shared.txt"), join(repo, "linked2.txt"));
    linkSync(join(store, "shared.txt"), join(repo, "linked3.txt"));
    writeFileSync(join(repo, "plain.txt"), "plain\n");
    const { output } = await inVm(
        repo,
        [
            "echo x >> linked.txt; echo append=$?",
            "echo x > linked.txt; echo write=$?",
            "truncate -s 0 linked.txt; echo truncate=$?",
            "python3 -c \"import os; os.truncate('linked.txt', 0)\"; echo ptruncate=$?",
            "chmod 777 linked.txt; echo chmod=$?",
            "cp plain.txt linked.txt; echo copy=$?",
            "echo x >> plain.txt; echo plain=$?",
            "echo new > linked2.txt.new && mv linked2.txt.new linked2.txt; echo replace=$?",
            "rm linked3.txt; echo remove=$?",
            "cat linked.txt",
        ].join("; "),
    );

    failed(output, "append", "write", "truncate", "ptruncate", "chmod");
    assert.match(output, /plain=0/);
    assert.match(output, /replace=0/);
    assert.match(output, /remove=0/);
    assert.equal(readFileSync(join(store, "shared.txt"), "utf8"), "from the store\n");
    assert.equal(statSync(join(store, "shared.txt")).mode & 0o777, 0o644);
    assert.equal(readFileSync(join(repo, "linked2.txt"), "utf8"), "new\n");
    assert.equal(
        readFileSync(join(repo, "linked.txt"), "utf8"),
        "plain\n",
        "cp replaced the name, not the file",
    );
    assert.equal(existsSync(join(repo, "linked3.txt")), false);
});

test("a worktree session reads the main repository's git directory, read only, whatever it tries", async (t) => {
    if (unavailable(t)) {
        return;
    }

    const main = repository("main");
    const tree = `${main}-tree`;

    onHost(main, "worktree", "add", "-q", tree, "-b", "feature");
    const before = snapshot(join(main, ".git"));
    const { output } = await inVm(
        tree,
        [
            "git status --short; echo status=$?",
            "git log --oneline | head -1; echo log=$?",
            "echo w >> a.txt; git add -A 2>&1; echo add=$?",
            "git commit -m 'in the worktree' 2>&1; echo commit=$?",
            `echo evil > ${main}/.git/hooks/post-commit; echo hook=$?`,
            `echo x >> ${main}/.git/config; echo config=$?`,
            `echo x > ${main}/.git/refs/heads/y; echo ref=$?`,
            `echo x > ${main}/.git/worktrees/${tree.split("/").at(-1)}/HEAD; echo admin=$?`,
            `ln ${main}/.git/config ./c; echo link=$?`,
            `mv ${main}/.git/config ./c; echo move=$?`,
            `rm ${main}/.git/index; echo remove=$?`,
            `test -e ${main}/a.txt; echo tree-visible=$?`,
            `head -1 ${main}/.git/config`,
        ].join("; "),
    );

    assert.match(output, /status=0/);
    assert.match(output, /log=0/);
    failed(output, "add", "commit", "hook", "config", "ref", "admin", "link", "move", "remove");
    assert.match(
        output,
        /tree-visible=1/,
        "only the git directory of the main repository is shared",
    );
    assert.match(output, /\[core\]/, "and it is readable");
    assert.ok(output.includes(NO_GIT_WRITE));
    assert.equal(snapshot(join(main, ".git")), before);
    assert.equal(onHost(tree, "log", "--format=%s"), "first\n");
});

test("a submodule's git directory is read only too, and git reads the submodule", async (t) => {
    if (unavailable(t)) {
        return;
    }

    const main = repository("modules");
    const sub = repository("module-source");

    onHost(main, "-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "vendor/lib");
    onHost(main, "commit", "-q", "-m", "with a submodule");
    const modules = join(main, ".git", "modules", "vendor", "lib");
    const before = snapshot(modules);
    const { output } = await inVm(
        main,
        [
            "git -C vendor/lib status --short; echo status=$?",
            "git -C vendor/lib log --oneline | head -1; echo log=$?",
            `echo x >> ${modules}/config; echo config=$?`,
            `echo x > ${modules}/hooks/pre-commit; echo hook=$?`,
            "echo 'gitdir: /tmp' > vendor/lib/.git; echo pointer=$?",
            "mv vendor/lib/.git vendor/lib/.git2; echo mvpointer=$?",
            "mv vendor vendor2; echo mvvendor=$?",
            "echo x >> vendor/lib/a.txt; git -C vendor/lib commit -am x 2>&1; echo commit=$?",
        ].join("; "),
    );

    assert.match(output, /status=0/);
    assert.match(output, /log=0/);
    failed(output, "config", "hook", "pointer", "mvpointer", "commit");
    assert.equal(snapshot(modules), before);
    assert.equal(onHost(main, "submodule", "status").includes("vendor/lib"), true);
});

test("a hooks folder inside a writable folder keeps the VM from starting, and the same repository works in a read only folder", async (t) => {
    if (unavailable(t)) {
        return;
    }

    const repo = repository("hooks");

    mkdirSync(join(repo, ".githooks"));
    writeFileSync(join(repo, ".githooks", "pre-commit"), "#!/bin/sh\nexit 0\n");
    onHost(repo, "config", "core.hooksPath", ".githooks");

    const writable = await inVm(repo, "echo started");

    assert.equal(writable.started, false);
    assert.ok(writable.error.includes(join(repo, ".githooks")), writable.error);
    assert.match(writable.error, /read only/);
    assert.ok(!writable.output.includes("started"));

    const readOnly = await inVm(
        repo,
        "cat .githooks/pre-commit; git log --oneline | head -1; echo x > .githooks/pre-commit; echo write=$?",
        "ro",
    );

    assert.ok(readOnly.started, readOnly.error);
    assert.match(readOnly.output, /exit 0/);
    failed(readOnly.output, "write");
    assert.equal(
        readFileSync(join(repo, ".githooks", "pre-commit"), "utf8"),
        "#!/bin/sh\nexit 0\n",
    );

    // A configuration file of the folder that git includes is the same.
    onHost(repo, "config", "--unset-all", "core.hooksPath");
    onHost(repo, "config", "include.path", "../extra.cfg");
    assert.equal((await inVm(repo, "true")).started, false);
    onHost(repo, "config", "--unset-all", "include.path");
    assert.equal((await inVm(repo, "true")).started, true);
});
