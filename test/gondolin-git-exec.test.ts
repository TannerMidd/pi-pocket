// What the host's git reads as configuration or runs, inside a sandbox's folder (`git-exec.ts`): the guest may not write
// it. Pure parts, git's own list on a real repository, and what a VM manager does with it, with a fake VM. The real VM
// runs the same in `gondolin-real-parity.test.ts`.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
    execPathsOf,
    execPlan,
    GitExecGuard,
    gitExecPaths,
    parseConfigList,
    type ConfigEntry,
} from "../src/server/extensions/gondolin/git-exec.ts";
import { SandboxManager } from "../src/server/extensions/gondolin/manager.ts";
import { context } from "./helpers.ts";
import { FakeDriver } from "./gondolin-fake.ts";

const roots: string[] = [];

const temp = () => {
    const path = realpathSync(mkdtempSync(join(tmpdir(), "gondolin-exec-")));

    roots.push(path);

    return path;
};

after(() => {
    for (const path of roots) {
        rmSync(path, { recursive: true, force: true });
    }
});

const entry = (key: string, value: string, origin = "file:.git/config"): ConfigEntry => ({
    origin,
    key,
    value,
});
const held = (paths: { path: string; tree: boolean }[], root: string) =>
    paths.map((each) => each.path.slice(root.length)).sort();
/** What a hooks path alone holds: not the config file that it comes from. */
const hooksOnly = (paths: { path: string; tree: boolean }[], root: string) =>
    held(paths, root).filter((each) => !each.startsWith("/.git"));

test("git's own list is read as entries", () => {
    const list =
        "file:.git/config\0core.hookspath\n.githooks\0global\0alias.co\n!sh a.sh\0file:/x\0empty\n\0";

    assert.deepEqual(parseConfigList(list), [
        { origin: "file:.git/config", key: "core.hookspath", value: ".githooks" },
        { origin: "global", key: "alias.co", value: "!sh a.sh" },
        { origin: "file:/x", key: "empty", value: "" },
    ]);
});

test("what the configuration names inside the folder is held: hooks folder, includes, commands, drivers", () => {
    const root = temp();
    const other = temp();

    mkdirSync(join(root, ".git"));
    mkdirSync(join(root, ".githooks"));
    mkdirSync(join(root, "tools"));
    writeFileSync(join(root, "tools", "watch.sh"), "#!/bin/sh\n");
    writeFileSync(join(root, "check.sh"), "#!/bin/sh\n");
    const paths = execPathsOf(
        [
            entry("core.hookspath", ".githooks"),
            entry("include.path", "../extra.cfg"),
            entry("includeif.gitdir:/x/.path", "../.git/more.cfg"),
            entry("core.fsmonitor", "./tools/watch.sh"),
            entry("core.sshcommand", `ssh -F ${join(root, "tools", "ssh-config")} -i key`),
            entry("alias.co", "!sh check.sh"),
            entry("alias.plain", "checkout"),
            entry("filter.lfs.clean", "tools/clean.sh %f"),
            entry("diff.x.textconv", "'./tools/conv' --flag"),
            entry("merge.m.driver", `${join(other, "outside")} %O`),
            entry("core.editor", "vim"),
            entry("core.attributesfile", "attrs"),
            entry("user.name", "tools"),
            entry("credential.https://x.helper", "!./cred.sh"),
        ],
        { cwd: root, top: root, gitDir: join(root, ".git"), mounts: [root] },
    );

    assert.deepEqual(held(paths, root), [
        "/.git",
        "/.git/.githooks",
        "/.git/config",
        "/.git/more.cfg",
        "/.githooks",
        "/attrs",
        "/check.sh",
        "/cred.sh",
        "/extra.cfg",
        "/tools",
        "/tools/clean.sh",
        "/tools/conv",
        "/tools/ssh-config",
        "/tools/watch.sh",
    ]);
    assert.equal(
        paths.find((each) => each.path.endsWith(".githooks"))?.tree,
        true,
        "a hooks folder is held whole",
    );
});

test("a path that does not exist yet is held by its top missing folder, so a link or a folder cannot lead to it", () => {
    const root = temp();

    mkdirSync(join(root, ".git"));
    mkdirSync(join(root, "tools"));
    const paths = execPathsOf(
        [entry("core.fsmonitor", "./tools/deep/er/watch.sh"), entry("include.path", "cfg/x.cfg")],
        { cwd: root, top: root, mounts: [root] },
    );

    assert.deepEqual(held(paths, root), [
        "/.git",
        "/.git/cfg",
        "/.git/config",
        "/tools",
        "/tools/deep",
    ]);
});

test("a file of the folder that holds an included configuration is held, and values outside the folder are not", () => {
    const root = temp();
    const home = temp();

    writeFileSync(join(root, "team.cfg"), "[core]\n");
    const paths = execPathsOf(
        [
            entry("core.pager", "less", "file:team.cfg"),
            entry("core.hookspath", join(home, "hooks"), "global"),
            entry("core.fsmonitor", "~/bin/watch", "global"),
        ],
        { cwd: root, top: root, mounts: [root], home },
    );

    assert.deepEqual(held(paths, root), ["/team.cfg"]);
});

test("the guard holds a path and what is below a folder, whatever the case, and keeps a path the configuration dropped", async () => {
    const root = temp();

    mkdirSync(join(root, ".githooks"));
    const repo = join(root, "repo");

    mkdirSync(repo);
    execFileSync("git", ["init", "-q", repo]);
    execFileSync("git", ["config", "core.hooksPath", "../.githooks"], { cwd: repo });
    const guard = new GitExecGuard(repo, [repo, root], 0, root);

    await guard.refresh(true);
    assert.equal(guard.protects(root, "/.githooks/post-checkout"), true);
    assert.equal(guard.protects(root, "/.GITHOOKS/Post-Checkout"), true);
    assert.equal(guard.protects(root, "/.githooks"), true);
    assert.equal(guard.protects(root, "/src/a.ts"), false);
    execFileSync("git", ["config", "--unset", "core.hooksPath"], { cwd: repo });
    await guard.refresh(true);
    assert.equal(
        guard.protects(root, "/.githooks/post-checkout"),
        true,
        "a change undone keeps it held",
    );
});

test("git itself lists what its configuration names: hooks path, includes, fsmonitor, a filter, an alias", async () => {
    const root = temp();

    execFileSync("git", ["init", "-q", root]);
    writeFileSync(join(root, "extra.cfg"), "[alias]\n\tx = !sh ./run.sh\n");
    mkdirSync(join(root, ".githooks"));
    const set = (...args: string[]) => execFileSync("git", ["config", ...args], { cwd: root });

    set("core.hooksPath", ".githooks");
    set("include.path", "../extra.cfg");
    set("core.fsmonitor", "./watch.sh");
    set("filter.f.clean", "./clean.sh");
    set("alias.y", "!node tool.js");
    const paths = await gitExecPaths(root, [root], root);
    const got = held(paths, root);

    for (const expected of [
        "/.githooks",
        "/extra.cfg",
        "/watch.sh",
        "/clean.sh",
        "/run.sh",
        "/tool.js",
    ]) {
        assert.ok(
            got.some((each) => each.startsWith(expected)),
            `${expected} in ${got.join(" ")}`,
        );
    }
});

test("a VM holds what the configuration names from before its first call, and what the owner adds while it runs", async () => {
    const root = temp();

    execFileSync("git", ["init", "-q", root]);
    mkdirSync(join(root, ".githooks"));
    execFileSync("git", ["config", "core.hooksPath", ".githooks"], { cwd: root });
    const driver = new FakeDriver();
    const vms = new SandboxManager({
        driver,
        log: () => {},
        pidFile: join(root, "..", `vms-${process.pid}.json`),
        settings: () => ({
            backend: "auto",
            mount: "rw",
            network: "off",
            allowedHosts: [],
            cpus: 1,
            memoryMb: 512,
            diskMb: 1024,
            idleMinutes: 30,
            maxVms: 2,
            image: "alpine-base:latest",
        }),
    });
    const env = vms.envFor(1, { rootId: 1, cwd: root, uploadDir: undefined });

    try {
        assert.ok((await env.exec("true", undefined, context)).ok);
        const guard = driver.log.started[0]!.gitExec!;

        assert.equal(guard.protects(root, "/.githooks/post-checkout"), true);
        assert.equal(guard.protects(root, "/new/hook.sh"), false);

        // The owner points git at another script while the VM runs: the next call holds it, within a second.
        execFileSync("git", ["config", "core.fsmonitor", "./new/hook.sh"], { cwd: root });
        await new Promise((resolve) => setTimeout(resolve, 1100));
        assert.ok((await env.exec("true", undefined, context)).ok);
        assert.equal(guard.protects(root, "/new/hook.sh"), true);
        assert.equal(driver.log.started.length, 1, "the VM went on");
    } finally {
        await vms.stopAll("the test ended");
    }
});

test("a call that was meant for a folder the session has left does not run in the VM of the new one", async () => {
    const first = temp();
    const second = temp();
    const driver = new FakeDriver();
    const vms = new SandboxManager({
        driver,
        log: () => {},
        pidFile: join(first, "..", `vms-stale-${process.pid}.json`),
        settings: () => ({
            backend: "auto",
            mount: "rw",
            network: "off",
            allowedHosts: [],
            cpus: 1,
            memoryMb: 512,
            diskMb: 1024,
            idleMinutes: 30,
            maxVms: 2,
            image: "alpine-base:latest",
        }),
    });

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

test("a hooks folder that is the folder itself cannot be held, and the way it is written does not matter", () => {
    const root = temp();

    mkdirSync(join(root, ".git"));
    mkdirSync(join(root, "sub"));

    for (const value of [
        ".",
        "./",
        "",
        ".//",
        "sub/..",
        "./sub/../.",
        root,
        `${root}/`,
        `${root}/sub/..`,
    ]) {
        const plan = execPlan([entry("core.hookspath", value)], {
            cwd: root,
            top: root,
            gitDir: join(root, ".git"),
            mounts: [root],
        });

        assert.equal(plan.problems.length, 1, JSON.stringify(value));
        assert.match(plan.problems[0]!, /core\.hookspath .* is the folder .* itself/i);
        assert.deepEqual(hooksOnly(plan.paths, root), []);
    }

    // Other places are held, or are not the guest's: nothing to refuse.
    for (const value of [".githooks", ".githooks/", "sub", "../elsewhere", "/etc/hooks"]) {
        const plan = execPlan([entry("core.hookspath", value)], {
            cwd: root,
            top: root,
            gitDir: join(root, ".git"),
            mounts: [root],
        });

        assert.deepEqual(plan.problems, [], value);
    }
});

test("a hooks folder that is the session's folder, or holds it, is refused; one inside it is held", () => {
    const top = temp();
    const cwd = join(top, "app");

    mkdirSync(cwd);
    mkdirSync(join(top, ".git"));
    const context = { cwd, top, gitDir: join(top, ".git"), mounts: [cwd] };

    assert.equal(
        execPlan([entry("core.hookspath", ".")], context).problems.length,
        1,
        "the top holds the folder: every file there is a hook, and the folder's name is one place",
    );
    assert.equal(execPlan([entry("core.hookspath", "app")], context).problems.length, 1);
    assert.deepEqual(execPlan([entry("core.hookspath", "app/hooks")], context).problems, []);
    assert.deepEqual(hooksOnly(execPathsOf([entry("core.hookspath", "app/hooks")], context), cwd), [
        "/hooks",
    ]);
});

test("a path that reaches the folder through a link is refused, whatever the chain, and a plain folder is held with the way to it", () => {
    const base = temp();
    const root = join(base, "proj");

    mkdirSync(join(root, ".git"), { recursive: true });
    mkdirSync(join(root, "real", "hooks"), { recursive: true });
    mkdirSync(join(root, "scripts"));
    writeFileSync(join(root, "scripts", "h.sh"), "#!/bin/sh\n");
    symlinkSync("real", join(root, "alias"));
    symlinkSync("real/hooks", join(root, "hooks"));
    symlinkSync("hooks", join(root, "chain"));
    mkdirSync(join(base, "elsewhere"));
    symlinkSync(root, join(base, "into-root"));
    symlinkSync(join(base, "elsewhere"), join(base, "outside-link"));
    const context = { cwd: root, top: root, gitDir: join(root, ".git"), mounts: [root] };
    const plan = (value: string, key = "core.hookspath") =>
        execPlan([entry(key, value)], context).problems;

    for (const value of ["hooks", "alias/hooks", "chain", "./chain/", "alias/../real/hooks"]) {
        assert.match(plan(value)[0] ?? "", /through a link/, value);
    }

    // The same for a script, an include, and an attributes file.
    assert.match(plan("./chain", "core.fsmonitor")[0] ?? "", /through a link/);
    assert.match(plan("../alias/x.cfg", "include.path")[0] ?? "", /through a link/);
    assert.match(plan("alias/attrs", "core.attributesfile")[0] ?? "", /through a link/);

    // A link of the owner's outside the folder that leads to a plain folder in it is followed, and the folder is held.
    assert.deepEqual(plan(`${base}/into-root/real/hooks`), []);

    // A link that leads out of the folder, and a plain folder, are no problem; the plain one is held with its way.
    assert.deepEqual(plan(`${base}/outside-link/hooks`), []);
    assert.deepEqual(plan("real/hooks"), []);
    assert.deepEqual(
        hooksOnly(execPathsOf([entry("core.hookspath", "real/hooks")], context), root),
        ["/real", "/real/hooks"],
    );

    // A link inside the hooks folder to a file that the guest may write is refused; one inside the folder is not.
    symlinkSync("../../scripts/h.sh", join(root, "real", "hooks", "post-checkout"));
    assert.match(plan("real/hooks")[0] ?? "", /post-checkout is a link to .*h\.sh/);
    rmSync(join(root, "real", "hooks", "post-checkout"));
    writeFileSync(join(root, "real", "hooks", "common.sh"), "#!/bin/sh\n");
    symlinkSync("common.sh", join(root, "real", "hooks", "pre-commit"));
    assert.deepEqual(plan("real/hooks"), []);
});

test("git's effective value decides: a global setting that the repository overrides does not refuse the folder", () => {
    const root = temp();

    mkdirSync(join(root, ".git"));
    mkdirSync(join(root, ".githooks"));
    const context = { cwd: root, top: root, gitDir: join(root, ".git"), mounts: [root] };
    const global = (key: string, value: string) => entry(key, value, "global");

    // The repository's value is the later one: the global `.` is not used.
    const overridden = execPlan(
        [global("core.hookspath", "."), entry("core.hookspath", ".githooks")],
        context,
    );

    assert.deepEqual(overridden.problems, []);
    assert.ok(held(overridden.paths, root).includes("/.githooks"));

    // The other way round, `.` is the one git uses.
    assert.equal(
        execPlan([entry("core.hookspath", ".githooks"), entry("core.hookspath", ".")], context)
            .problems.length,
        1,
    );

    // A command that is overridden is not held; every include and every credential helper is.
    const many = execPlan(
        [
            entry("core.fsmonitor", "./old.sh"),
            entry("core.fsmonitor", "./new.sh"),
            entry("include.path", "../a.cfg"),
            entry("include.path", "../b.cfg"),
            entry("credential.helper", "!./one.sh"),
            entry("credential.helper", "!./two.sh"),
        ],
        context,
    );

    assert.deepEqual(
        held(many.paths, root).filter((each) => !each.startsWith("/.git")),
        ["/new.sh", "/one.sh", "/two.sh", "/a.cfg", "/b.cfg"].sort(),
    );
});

test("a VM does not start when git runs hooks from the folder itself, and one that runs stops when the owner sets it so", async () => {
    const root = temp();

    execFileSync("git", ["init", "-q", root]);
    const driver = new FakeDriver();
    const vms = new SandboxManager({
        driver,
        log: () => {},
        pidFile: join(root, "..", `vms-root-${process.pid}.json`),
        settings: () => ({
            backend: "auto",
            mount: "rw",
            network: "off",
            allowedHosts: [],
            cpus: 1,
            memoryMb: 512,
            diskMb: 1024,
            idleMinutes: 30,
            maxVms: 2,
            image: "alpine-base:latest",
        }),
    });
    const env = vms.envFor(1, { rootId: 1, cwd: root, uploadDir: undefined });

    try {
        assert.ok((await env.exec("true", undefined, context)).ok);
        execFileSync("git", ["config", "core.hooksPath", "."], { cwd: root });
        await new Promise((resolve) => setTimeout(resolve, 1100));
        const refused = await env.exec("true", undefined, context);

        assert.ok(!refused.ok);
        assert.match(
            String((refused as { error: Error }).error.message),
            /core\.hookspath .* itself/i,
        );
        assert.equal(vms.running, 0, "the VM that ran was stopped");
        const again = await env.exec("true", undefined, context);

        assert.ok(!again.ok, "and none starts while it is so");
        assert.equal(driver.log.started.length, 1);
        assert.match(
            String((again as { error: Error }).error.message),
            /names a plain file or folder inside the project/,
        );
        execFileSync("git", ["config", "core.hooksPath", ".githooks"], { cwd: root });
        assert.ok((await env.exec("true", undefined, context)).ok);
        assert.equal(driver.log.started.length, 2);
    } finally {
        await vms.stopAll("the test ended");
    }
});

test("a call that waits for git's configuration does not lose its VM to the idle timer or to a stop", async () => {
    const root = temp();

    execFileSync("git", ["init", "-q", root]);
    const driver = new FakeDriver();
    const vms = new SandboxManager({
        driver,
        log: () => {},
        pidFile: join(root, "..", `vms-race-${process.pid}.json`),
        settings: () => ({
            backend: "auto",
            mount: "rw",
            network: "off",
            allowedHosts: [],
            cpus: 1,
            memoryMb: 512,
            diskMb: 1024,
            idleMinutes: 0.02,
            maxVms: 2,
            image: "alpine-base:latest",
        }),
    });
    const env = vms.envFor(3, { rootId: 3, cwd: root, uploadDir: undefined });

    try {
        assert.ok((await env.exec("true", undefined, context)).ok);
        const guard = driver.log.started[0]!.gitExec!;
        const slow = guard.refresh.bind(guard);

        // The idle timer (1.2 s) fires while git is asked.
        await new Promise((resolve) => setTimeout(resolve, 900));

        guard.refresh = async () => {
            await new Promise((resolve) => setTimeout(resolve, 700));
            await slow(true);
        };

        assert.ok((await env.exec("true", undefined, context)).ok, "the idle timer stopped it");
        assert.equal(driver.log.started.length, 1, "the same VM served the call");

        // A stop that comes while git is asked: the call starts a new VM, not a TypeError.
        guard.refresh = async () => {
            await vms.stop(3, "stopped meanwhile");
        };

        assert.ok((await env.exec("true", undefined, context)).ok);
        assert.equal(driver.log.started.length, 2);
    } finally {
        await vms.stopAll("the test ended");
    }
});

test("a link that leads nowhere and lies outside the folder does not block it, unless it points into it", () => {
    const base = temp();
    const root = join(base, "proj");
    const home = join(base, "home");

    mkdirSync(join(root, ".git"), { recursive: true });
    mkdirSync(home);
    symlinkSync(join(base, "gone"), join(home, "stale"));
    symlinkSync(join(home, "stale"), join(home, "chain"));
    symlinkSync(join(root, "not-yet.txt"), join(home, "into-folder"));
    symlinkSync(join(home, "into-folder"), join(home, "via-link"));
    const context = { cwd: root, top: root, gitDir: join(root, ".git"), mounts: [root], home };
    const plan = (value: string, key = "core.excludesfile") =>
        execPlan([{ origin: "global", key, value }], context);

    // The owner's stale links, wholly outside the folder: nothing for the guest to change.
    for (const value of [join(home, "stale"), join(home, "chain"), "~/stale", "~/chain/x"]) {
        assert.deepEqual(plan(value).problems, [], value);
        assert.deepEqual(plan(value).paths, [], value);
    }

    // A link in the owner's home that points into the folder, at a file that is not there yet: the guest could make
    // it, so it is held.
    for (const value of [join(home, "into-folder"), "~/into-folder", join(home, "via-link")]) {
        const result = plan(value);

        assert.deepEqual(result.problems, [], value);
        assert.deepEqual(hooksOnly(result.paths, root), ["/not-yet.txt"], value);
    }

    // A link inside the folder that leads nowhere is the guest's to change: refused.
    symlinkSync(join(base, "gone"), join(root, "dangling"));
    assert.match(plan(join(root, "dangling")).problems[0] ?? "", /link that leads nowhere/);
});
