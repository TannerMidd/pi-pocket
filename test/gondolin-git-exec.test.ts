// What the host's git reads as configuration or runs, inside a sandbox's folder (`git-exec.ts`): the guest may not write
// it. Pure parts, git's own list on a real repository, and what a VM manager does with it, with a fake VM. The real VM
// runs the same in `gondolin-real-parity.test.ts`.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
    execPathsOf,
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
        "/.git/.githooks",
        "/.git/config",
        "/.git/more.cfg",
        "/.githooks",
        "/attrs",
        "/check.sh",
        "/cred.sh",
        "/extra.cfg",
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

    assert.deepEqual(held(paths, root), ["/.git/cfg", "/.git/config", "/tools/deep"]);
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
