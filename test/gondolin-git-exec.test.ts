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
    follow,
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

        assert.ok(plan.problems.length >= 1, JSON.stringify(value));
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
        assert.match(plan(value)[0] ?? "", /(through|by way of) a link/, value);
    }

    // The same for a script, an include, and an attributes file.
    assert.match(plan("./chain", "core.fsmonitor")[0] ?? "", /(through|by way of) a link/);
    assert.match(plan("../alias/x.cfg", "include.path")[0] ?? "", /(through|by way of) a link/);
    assert.match(plan("alias/attrs", "core.attributesfile")[0] ?? "", /(through|by way of) a link/);

    // A link of the owner's outside the folder that leads into it is refused too: it is a way into the folder by a link.
    assert.match(plan(`${base}/into-root/real/hooks`)[0] ?? "", /(through|by way of) a link/);

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

test("a link that leads nowhere and lies outside the folder does not block it, and one that points into it is refused", () => {
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

    // A link in the owner's home that points into the folder, even at a file that is not there yet, is refused: the
    // guest could make the target.
    for (const value of [join(home, "into-folder"), "~/into-folder", join(home, "via-link")]) {
        assert.match(plan(value).problems[0] ?? "", /(through|by way of) a link/, value);
    }

    // A link inside the folder that leads nowhere is the guest's to change: refused.
    symlinkSync(join(base, "gone"), join(root, "dangling"));
    assert.match(
        plan(join(root, "dangling")).problems[0] ?? "",
        /link in the folder .*which the guest may change/,
    );
});

// ─── The resolver walks as the kernel does ──────────────────────────────────

/** What the kernel says a path is, by `realpath` (libc's): undefined for a path that is not there, or a loop. */
function kernel(path: string): string | undefined {
    try {
        return realpathSync.native(path);
    } catch {
        return undefined;
    }
}

test("the resolver ends where the kernel does, for links, .. after links, relative targets, loops, and missing parts", () => {
    const base = temp();
    const at = (...parts: string[]) => join(base, ...parts);
    const link = (target: string, ...name: string[]) => symlinkSync(target, at(...name));

    mkdirSync(at("a", "b"), { recursive: true });
    mkdirSync(at("dd", "ee", "ff"), { recursive: true });
    writeFileSync(at("a", "b", "file"), "x");
    link("a", "l1");
    link("a/b", "rel");
    link(at("a", "b"), "abs");
    link("a/b/..", "up");
    link("pivot/../hook.sh", "alias");
    link("a/b", "pivot");
    link("loop2", "loop1");
    link("loop1", "loop2");
    link("/", "root");
    link("../a", "dd", "back");
    link("../back/b", "dd", "ee", "chain");
    link("../../../a/b", "dd", "ee", "ff", "deep");
    link("l1", "l2");
    link("l2/b/..", "l3");
    link("dd/ee/ff/deep/..", "l4");

    const cases = [
        "a/b/file",
        "a//b/./file",
        "l1/b/file",
        "l1/b/..",
        "l1/b/../b/file",
        "l1/../a/b",
        "l2/b/file",
        "l3/b/file",
        "l4/x",
        "rel/file",
        "abs/file",
        "up/b/file",
        "pivot/..",
        "pivot/../a",
        "pivot/../hook.sh",
        "alias",
        "alias/x",
        "dd/back/b/file",
        "dd/ee/chain/file",
        "dd/ee/ff/deep/file",
        "dd/ee/ff/deep/../file",
        "root/etc",
        "root/..",
        "root/../etc",
        "a/missing",
        "a/missing/",
        "a/b/missing/more",
        "l1/missing",
        "l1/nope/x/y",
    ];
    // A last part that is not there: no tool says where it would be (`readlink -f` differs between systems), so the table
    // does, from the part that is there; the kernel is asked for that part.
    const missing: Record<string, [string, string]> = {
        "a/missing": ["a", "missing"],
        "a/missing/": ["a", "missing"],
        "l1/missing": ["a", "missing"],
        alias: ["a", "hook.sh"],
        "pivot/../hook.sh": ["a", "hook.sh"],
        "pivot/../a": ["a", "a"],
        "l4/x": ["a", "x"],
        "dd/ee/ff/deep/../file": ["a", "file"],
    };
    let compared = 0;

    for (const text of cases) {
        const raw = `${base}/${text}`;
        const got = follow(raw, []);

        assert.equal(got.problem, undefined, text);
        const parent = missing[text];
        const want = parent === undefined ? kernel(raw) : `${kernel(at(parent[0]))}/${parent[1]}`;

        if (want !== undefined) {
            assert.equal(got.physical, want, `${text}: the kernel says ${want}`);
            compared++;
        }
    }

    // Every case but those with a missing middle part is compared: the kernel (or the part of it that is there) is the judge.
    assert.ok(
        compared >= cases.length - 3,
        `${compared} of ${cases.length} compared with the kernel`,
    );
    assert.equal(follow(`${base}/a/b/missing/more`, []).physical, at("a", "b", "missing", "more"));

    // A loop is an error for the kernel, and for the walk.
    assert.match(follow(`${base}/loop1/x`, []).problem ?? "", /too many links/);
    assert.equal(kernel(`${base}/loop1/x`), undefined);
});

test("a link that is followed by .. is read as the kernel reads it: a hook that is missing in the project is held or refused", () => {
    const base = temp();
    const project = join(base, "project");
    const outside = join(base, "outside");

    mkdirSync(join(project, ".git"), { recursive: true });
    mkdirSync(join(project, "sub"));
    mkdirSync(outside);
    symlinkSync(join(project, "sub"), join(outside, "pivot"));
    symlinkSync(`${outside}/pivot/../hook.sh`, join(outside, "alias"));
    symlinkSync("pivot/../hook.sh", join(outside, "relalias"));
    const context = {
        cwd: project,
        top: project,
        gitDir: join(project, ".git"),
        mounts: [project],
    };
    const plan = (value: string, key = "core.fsmonitor") => execPlan([entry(key, value)], context);

    // `alias` leads to `outside/pivot/../hook.sh`, which the kernel reads as `project/hook.sh`: not there yet, and the
    // guest could make it. The old reading, `outside/hook.sh`, held nothing.
    for (const value of [
        `sh ${outside}/alias`,
        `sh ${outside}/relalias`,
        `${outside}/pivot/../hook.sh`,
    ]) {
        const result = plan(value);

        assert.match(result.problems[0] ?? "", /(through|by way of) a link|leads to/, value);
    }

    // `..` that climbs out of the folder by way of a link, and `..` after a place that is not there.
    assert.match(plan(`${outside}/pivot/../x`).problems[0] ?? "", /link/);
    assert.match(
        execPlan([entry("core.hookspath", "missing/../.githooks")], context).problems[0] ?? "",
        /after a place that is not there/,
    );

    // A plain path stays allowed and is held.
    assert.deepEqual(plan("sh ./tools/hook.sh").problems, []);
    assert.ok(held(plan("sh ./tools/hook.sh").paths, project).includes("/tools"));
});

// ─── A relative hooks path is held from the git folder as well ──────────────

test("a hooks path that is relative is held from the top of the tree and from the git folder", () => {
    const root = temp();

    mkdirSync(join(root, ".git"));
    const plan = execPlan([entry("core.hookspath", ".githooks")], {
        cwd: root,
        top: root,
        gitDir: join(root, ".git"),
        mounts: [root],
    });

    assert.ok(held(plan.paths, root).includes("/.githooks"));
    assert.ok(held(plan.paths, root).includes("/.git/.githooks"), "the receive hooks of a push in");
});

// ─── macOS: a link in a parent of the folder ────────────────────────────────

test("a folder below a link of the owner's (as /tmp and /var are on macOS) is no way in by a link", () => {
    const base = temp();
    const real = join(base, "private", "tmp");
    const named = join(base, "tmp");
    const project = join(real, "proj");

    mkdirSync(join(project, ".git"), { recursive: true });
    mkdirSync(join(project, ".githooks"));
    symlinkSync("private/tmp", named);
    symlinkSync(`${named}/proj/.githooks`, join(base, "front"));

    // The session's folder is named through the link, git's top is the real path: both ways hold the same folder.
    const sessions: [string, string][] = [
        [join(named, "proj"), project],
        [project, project],
        [join(named, "proj"), join(named, "proj")],
    ];

    for (const [cwd, top] of sessions) {
        const plan = execPlan([entry("core.hookspath", ".githooks")], {
            cwd,
            top,
            gitDir: join(project, ".git"),
            mounts: [cwd],
        });

        assert.deepEqual(plan.problems, [], `${cwd} ${top}`);
        assert.ok(
            plan.paths.some((each) => each.path === join(project, ".githooks")),
            `${cwd} ${top}: held at the real path`,
        );
    }

    // A path of the owner's that goes through the link into the folder by a plain walk is the same folder, held.
    const walked = execPlan([entry("core.hookspath", `${named}/proj/.githooks`)], {
        cwd: project,
        top: project,
        mounts: [project],
    });

    assert.deepEqual(walked.problems, []);
    assert.ok(walked.paths.some((each) => each.path === join(project, ".githooks")));

    // But a link whose own target is inside the folder is a way in by a link, whatever the parents are.
    const front = execPlan([entry("core.hookspath", join(base, "front"))], {
        cwd: project,
        top: project,
        mounts: [project],
    });

    assert.match(front.problems[0] ?? "", /by way of a link|through a link/);
});
