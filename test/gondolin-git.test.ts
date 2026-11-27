// The Git boundary of the sandbox (`git.ts`, and its use in `manager.ts`), with a fake VM and host Git: which git
// directories a folder reaches, and the rule that a VM does not start with a writable folder when Git would run code
// from it. The real VM enforces the same boundary in `gondolin-real-git.test.ts`.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
    chmodSync,
    readFileSync,
    mkdirSync,
    mkdtempSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
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

/** A home folder whose global git configuration is `text`: the machine's own settings, not the repository's. */
function homeWith(text: string): NodeJS.ProcessEnv {
    const home = temp();

    writeFileSync(join(home, ".gitconfig"), text);

    return { HOME: home };
}

/** What the sandbox must say, and what it must name, when a writable folder holds what git would run. */
async function refused(cwd: string, needle: string, env?: NodeJS.ProcessEnv) {
    const writable = await starts(cwd, "rw", env);

    assert.equal(writable.started, false, `${needle}: a VM started`);
    assert.ok(writable.message.includes(needle), `${needle} is named: ${writable.message}`);
    assert.match(writable.message, /read only/);

    const readOnly = await starts(cwd, "ro", env);

    assert.equal(readOnly.started, true, `a read only folder works: ${readOnly.message}`);
}

test("a hooks folder inside a writable folder keeps the VM from starting, and a read only folder still works", async () => {
    const repo = repository();
    const outside = temp();
    const hooks = (path: string) => homeWith(`[core]\n\thooksPath = ${path}\n`);

    assert.equal((await starts(repo)).started, true, "the default hooks folder is inside .git");
    await refused(repo, join(repo, ".githooks"), hooks(join(repo, ".githooks")));
    // A husky repository: the hooks folder does not exist yet.
    await refused(repo, join(repo, ".husky", "_"), hooks(join(repo, ".husky", "_")));
    assert.equal((await starts(repo, "rw", hooks(outside))).started, true, "outside the folder");
    assert.equal(
        (await starts(repo, "rw", hooks(join(repo, ".git", "custom-hooks")))).started,
        true,
        "in the git directory",
    );

    // In the repository's own configuration the key itself is refused, whatever it names.
    git(repo, "config", "core.hooksPath", outside);
    await refused(repo, "core.hookspath");
});

test("a hooks folder, a hook, or a configuration file that is reached through a place the guest can write keeps the VM from starting", async () => {
    const repo = repository();
    const outside = temp();
    const hooks = (path: string) => homeWith(`[core]\n\thooksPath = ${path}\n`);

    // A link outside the folder that leads into it, one that leads nowhere yet, and a link in the middle of a chain
    // whose end is outside: the guest can change the one in the folder.
    mkdirSync(join(repo, "tools"));
    symlinkSync(join(repo, "tools"), join(outside, "via-link"));
    symlinkSync(join(repo, "not-yet", "hooks"), join(outside, "dangling"));
    symlinkSync(outside, join(repo, "middle"));
    symlinkSync(join(repo, "middle"), join(outside, "chain"));
    await refused(repo, join(repo, "tools"), hooks(join(outside, "via-link")));
    await refused(repo, join(repo, "not-yet"), hooks(join(outside, "dangling")));
    await refused(repo, join(repo, "middle"), hooks(join(outside, "chain")));

    // A hook of the git directory that is a link to a script of the folder, and one that is not.
    mkdirSync(join(repo, "scripts"));
    writeFileSync(join(repo, "scripts", "pre-commit"), "#!/bin/sh\n");
    writeFileSync(join(repo, ".git", "hooks", "pre-push"), "#!/bin/sh\n");
    assert.equal((await starts(repo)).started, true, "a hook of the git directory is its own");
    symlinkSync("../../scripts/pre-commit", join(repo, ".git", "hooks", "pre-commit"));
    await refused(repo, join(repo, "scripts"));
    rmSync(join(repo, ".git", "hooks", "pre-commit"));

    // The machine's configuration file that is a link into the folder.
    const home = temp();

    writeFileSync(join(repo, "later.cfg"), "[user]\n\tname = x\n");
    symlinkSync(join(repo, "later.cfg"), join(home, ".gitconfig"));
    await refused(repo, join(repo, "later.cfg"), { HOME: home });
});

test("a configuration file that the machine's git includes, even one that is not there yet, keeps a writable folder from starting", async () => {
    const repo = repository();
    const outside = temp();

    writeFileSync(join(outside, "extra.cfg"), "[user]\n\tname = x\n");
    assert.equal(
        (await starts(repo, "rw", homeWith(`[include]\n\tpath = ${join(outside, "extra.cfg")}\n`)))
            .started,
        true,
    );
    await refused(
        repo,
        join(repo, "from-global.cfg"),
        homeWith(`[include]\n\tpath = ${join(repo, "from-global.cfg")}\n`),
    );
    await refused(
        repo,
        join(repo, "later.cfg"),
        homeWith(`[includeIf "onbranch:never"]\n\tpath = ${join(repo, "later.cfg")}\n`),
    );
});

test("an include path is read as git expands it: ~/, ~user/, a name relative to its file, and never with a .. taken out first", async () => {
    const repo = repository();
    const sub = join(repo, "sub");
    const me = userInfo().username;

    mkdirSync(sub);

    // The machine's configuration includes `text`, from a home folder whose `link` leads into the folder.
    const including = (text: string, file = ".gitconfig"): NodeJS.ProcessEnv => {
        const home = temp();

        symlinkSync(sub, join(home, "link"));
        writeFileSync(join(home, file), `[include]\n\tpath = ${text}\n`);

        return { HOME: home };
    };

    // `link/..` is the folder that holds `sub`, not the home folder: the walk keeps every name.
    await refused(repo, sub, including("~/link/../x.cfg"));
    await refused(repo, sub, including("link/../y.cfg"));
    assert.equal((await starts(repo, "rw", including("~/link/x.cfg"))).started, false);
    assert.equal((await starts(repo, "rw", including("elsewhere/x.cfg"))).started, true);

    // `~user/` is that user's home folder, which is not `$HOME`, and a user that is not known is not guessed.
    assert.equal((await starts(repo, "rw", including(`~${me}/x.cfg`))).started, true);
    const listed = /^nobody:/m.test(readFileSync("/etc/passwd", "utf8"));

    if (listed) {
        const other = await starts(repo, "rw", including("~nobody/x.cfg"));

        assert.equal(other.started, true, other.message);
    }

    await refused(repo, "~no-such-user-here/x.cfg", including("~no-such-user-here/x.cfg"));
    await refused(repo, "%(prefix)/etc/x.cfg", including("%(prefix)/etc/x.cfg"));
});

test("the machine's configuration counts when the folder holds no repository: what it includes lies in the folder", async () => {
    const scratch = temp();
    const global = homeWith(`[include]\n\tpath = ${join(scratch, "extra.conf")}\n`);

    assert.equal((await gitMounts(scratch)).gitDirs.length, 0);
    await refused(scratch, join(scratch, "extra.conf"), global);
    assert.equal((await starts(temp(), "rw", homeWith("[user]\n\tname = x\n"))).started, true);
});

test("the repository's own configuration may set only plain data: any other key keeps a writable folder from starting", async () => {
    const repo = repository();

    for (const [key, value] of [
        ["core.repositoryformatversion", "0"],
        ["core.filemode", "false"],
        ["core.ignorecase", "true"],
        ["core.autocrlf", "input"],
        ["remote.origin.url", "https://example.com/a.git"],
        ["remote.origin.pushurl", "https://example.com/b.git"],
        ["remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"],
        ["branch.main.remote", "origin"],
        ["branch.main.merge", "refs/heads/main"],
        ["branch.main.rebase", "true"],
        ["user.name", "someone"],
        ["user.signingkey", "ABCD"],
        ["extensions.worktreeConfig", "true"],
        ["init.defaultBranch", "main"],
        ["pull.rebase", "true"],
        ["push.default", "simple"],
        ["fetch.prune", "true"],
        ["lfs.repositoryformatversion", "0"],
        ["submodule.active", "."],
    ] as const) {
        git(repo, "config", key, value);
        assert.equal((await starts(repo)).started, true, `${key} = ${value}`);
        git(repo, "config", "--unset-all", key);
    }

    for (const [key, value] of [
        ["core.fsmonitor", "./watch.sh"],
        ["core.fsmonitor", "true"],
        ["core.hooksPath", "../hooks"],
        ["core.sshCommand", "ssh -F ./ssh-config"],
        ["core.editor", "./edit.sh"],
        ["core.pager", "./page.sh"],
        ["core.gitProxy", "./proxy.sh"],
        ["pager.diff", "./page.sh"],
        ["interactive.diffFilter", "./filter.sh"],
        ["gpg.program", "./sign.sh"],
        ["gpg.ssh.defaultKeyCommand", "./key.sh"],
        ["credential.helper", "!./cred.sh"],
        ["diff.x.textconv", "./conv.sh"],
        ["merge.x.driver", "./merge.sh %O"],
        ["filter.x.clean", "./clean.sh"],
        ["mergetool.x.cmd", "./mt.sh"],
        ["remote.origin.uploadpack", "./up.sh"],
        ["alias.co", "!./co.sh"],
        ["alias.st", "status -s"],
        ["sequence.editor", "./seq.sh"],
        ["include.path", "../extra.cfg"],
        ["includeIf.onbranch:main.path", "../extra.cfg"],
        ["submodule.x.update", "!./up.sh"],
        ["something.new", "anything"],
    ] as const) {
        git(repo, "config", key, value);
        const writable = await starts(repo, "rw");

        assert.equal(writable.started, false, `${key} = ${value}: a VM started`);
        assert.ok(writable.message.includes(key.toLowerCase().split(":")[0]!), writable.message);
        assert.match(writable.message, /read only/);
        assert.equal((await starts(repo, "ro")).started, true, "a read only folder works");
        git(repo, "config", "--unset-all", key);
    }

    // The same keys in the global configuration are the machine's: they do not count.
    const global = homeWith(
        "[core]\n\tsshCommand = ./global-ssh.sh\n\tfsmonitor = ./w.sh\n[alias]\n\tgo = !./go.sh\n[credential]\n\thelper = store\n",
    );

    assert.equal((await starts(repo, "rw", global)).started, true);
});

test("a repository above the folder counts: its own configuration is checked against the folder it holds", async () => {
    const repo = repository();
    const folder = join(repo, "src");

    mkdirSync(folder);
    writeFileSync(join(folder, "watch.sh"), "#!/bin/sh\n");
    assert.equal((await starts(folder, "rw", { GIT_DIR: "/nonexistent" })).started, true);
    git(repo, "config", "core.fsmonitor", "./src/watch.sh");
    await refused(folder, "core.fsmonitor");
    git(repo, "config", "--unset", "core.fsmonitor");
    await refused(folder, join(folder, "hooks"), {
        ...homeWith(`[core]\n\thooksPath = ${join(folder, "hooks")}\n`),
        GIT_DIR: "/nonexistent",
    });
});

test("a bare repository in the folder is audited as any other: its hooks folder and its configuration", async () => {
    const repo = repository();

    git(repo, "init", "-q", "--bare", "cache.git");
    mkdirSync(join(repo, "scripts"));
    assert.equal((await starts(repo)).started, true);

    git(join(repo, "cache.git"), "config", "core.hooksPath", join(repo, "scripts"));
    await refused(repo, join(repo, "scripts"));
    git(join(repo, "cache.git"), "config", "--unset", "core.hooksPath");

    git(join(repo, "cache.git"), "config", "core.fsmonitor", "./watch.sh");
    await refused(repo, "core.fsmonitor");
});

test("a link inside a git directory that leads into the folder keeps a writable VM from starting, whatever the file is", async () => {
    const repo = repository();
    const outside = temp();

    // The repository's own configuration is an empty file of the folder: git lists no value of it.
    writeFileSync(join(repo, "empty.cfg"), "");
    rmSync(join(repo, ".git", "config"));
    symlinkSync(join(repo, "empty.cfg"), join(repo, ".git", "config"));
    await refused(repo, join(repo, "empty.cfg"));
    rmSync(join(repo, ".git", "config"));
    writeFileSync(join(repo, ".git", "config"), "[core]\n\tbare = false\n");

    // The worktree configuration, and a file of info, that lead to a name that is not there yet.
    symlinkSync(join(repo, "later.cfg"), join(repo, ".git", "config.worktree"));
    await refused(repo, join(repo, "later.cfg"));
    rmSync(join(repo, ".git", "config.worktree"));
    rmSync(join(repo, ".git", "info", "exclude"));
    symlinkSync("../../ignore-list", join(repo, ".git", "info", "exclude"));
    await refused(repo, join(repo, "ignore-list"));
    rmSync(join(repo, ".git", "info", "exclude"));

    // A link in a git directory that leads outside the folder is fine.
    rmSync(join(repo, ".git", "info", "exclude"), { force: true });
    symlinkSync(join(outside, "elsewhere"), join(repo, ".git", "info", "exclude"));
    assert.equal((await starts(repo)).started, true);
});

test("each file that git reads as configuration counts, whether it is there or not, and also when it is empty", async () => {
    const repo = repository();
    const home = temp();
    const empty = join(repo, "empty.cfg");

    writeFileSync(empty, "");
    symlinkSync(empty, join(home, ".gitconfig"));
    await refused(repo, empty, { HOME: home });
    rmSync(join(home, ".gitconfig"));

    mkdirSync(join(home, "xdg", "git"), { recursive: true });
    symlinkSync(join(repo, "not-yet.cfg"), join(home, "xdg", "git", "config"));
    await refused(repo, join(repo, "not-yet.cfg"), {
        HOME: home,
        XDG_CONFIG_HOME: join(home, "xdg"),
    });
});

test("a repository above the folder is audited with its git directory too: a link in it that leads into the folder", async () => {
    const repo = repository();
    const folder = join(repo, "src");

    mkdirSync(folder);
    rmSync(join(repo, ".git", "info", "exclude"));
    symlinkSync("../../src/exclude-list", join(repo, ".git", "info", "exclude"));
    await refused(folder, join(folder, "exclude-list"));
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

test("every repository in the folder is found by walking it: nested ones, ones that keep their git directory elsewhere, and bare ones", async () => {
    const repo = repository();
    const kept = temp();

    // A nested repository that is no submodule, nested ones whose git directory is in the folder and outside it, and
    // a bare repository; a link is not followed.
    mkdirSync(join(repo, "a"));
    git(join(repo, "a"), "init", "-q", "b");
    mkdirSync(join(repo, "c"));
    git(join(repo, "c"), "init", "-q", "--separate-git-dir", join(repo, "c-data"), ".");
    mkdirSync(join(repo, "d"));
    git(join(repo, "d"), "init", "-q", "--separate-git-dir", join(kept, "d-data"), ".");
    git(repo, "init", "-q", "--bare", "e.git");
    symlinkSync(kept, join(repo, "link"));

    const found = await gitMounts(repo);

    assert.deepEqual(
        [...found.gitDirs].sort(),
        [
            join(repo, ".git"),
            join(repo, "a", "b", ".git"),
            join(repo, "c-data"),
            join(repo, "e.git"),
            join(kept, "d-data"),
        ].sort(),
    );
    assert.deepEqual(
        [...found.trees].sort(),
        [repo, join(repo, "a", "b"), join(repo, "c"), join(repo, "d")].sort(),
    );
    assert.equal(found.unreadable, undefined);
    const nested = await starts(repo);

    assert.equal(nested.started, true, nested.message);

    // A folder that cannot be read leaves a git directory unknown: a writable folder does not start.
    const closed = join(repo, "closed");

    mkdirSync(closed);
    chmodSync(closed, 0o000);

    try {
        assert.equal((await gitMounts(repo)).unreadable, closed);
        const writable = await starts(repo, "rw");

        assert.equal(writable.started, false);
        assert.ok(writable.message.includes(closed), writable.message);
        assert.equal((await starts(repo, "ro")).started, true, "a read only folder works");
    } finally {
        chmodSync(closed, 0o755);
    }
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
