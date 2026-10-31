import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
    cpSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { npmCommand } from "../src/server/npm-install.ts";
import { stageNpmUpdate } from "../src/server/npm-update.ts";
import {
    finishNpmPending,
    readOutcome,
    readPending,
    restorePackage,
    restoreMissingNpmPackage,
    rollBackUpdate,
    stagedPackagePath,
    swapInPackage,
    updatePaths,
    writePending,
    type PendingUpdate,
} from "../src/server/update-state.ts";

function manifest(root: string, version: string): void {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "pi-pocket", version }));
}

function pending(root: string, fields: Partial<PendingUpdate> = {}): PendingUpdate {
    const value: PendingUpdate = {
        v: 1,
        kind: "npm-global",
        tag: "v2.0.0",
        fromVersion: "1.0.0",
        toVersion: "2.0.0",
        from: "",
        to: "",
        branch: null,
        modules: false,
        oneWay: false,
        phase: "packages",
        at: 1,
        ...fields,
    };

    writePending(root, value);

    return value;
}

function version(root: string): string {
    return (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string })
        .version;
}

function sandbox() {
    const dir = mkdtempSync(join(tmpdir(), "pocket-npm-update-"));
    const prefix = join(dir, "global prefix");
    const root =
        process.platform === "win32"
            ? join(prefix, "node_modules", "pi-pocket")
            : join(prefix, "lib", "node_modules", "pi-pocket");
    const env = {
        ...process.env,
        npm_config_cache: join(dir, "cache"),
        npm_config_userconfig: join(dir, "empty-npmrc"),
        npm_config_offline: "true",
        npm_config_registry: "http://127.0.0.1:1/",
        npm_config_update_notifier: "false",
        npm_config_audit: "false",
        npm_config_fund: "false",
    };
    const command = npmCommand();

    const npm = (args: string[], cwd = dir) => {
        const result = spawnSync(command.file, args, {
            cwd,
            env,
            encoding: "utf8",
            shell: command.shell,
            timeout: 60_000,
        });

        assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);

        return result.stdout.trim();
    };

    const pack = (name: string, release: string, fail = false) => {
        const source = join(dir, `${name}-${release}${fail ? "-fail" : ""}`);

        mkdirSync(join(source, "node_modules", "pocket-fixture-dep"), { recursive: true });
        writeFileSync(
            join(source, "node_modules", "pocket-fixture-dep", "package.json"),
            JSON.stringify({ name: "pocket-fixture-dep", version: "1.0.0", main: "index.js" }),
        );
        writeFileSync(
            join(source, "node_modules", "pocket-fixture-dep", "index.js"),
            "module.exports = 42;\n",
        );
        writeFileSync(join(source, "bin.js"), "#!/usr/bin/env node\nconsole.log('fixture');\n");
        writeFileSync(
            join(source, "package.json"),
            JSON.stringify({
                name,
                version: release,
                bin: { [name]: "bin.js" },
                dependencies: { "pocket-fixture-dep": "1.0.0" },
                bundledDependencies: ["pocket-fixture-dep"],
                ...(fail ? { scripts: { install: 'node -e "process.exit(7)"' } } : {}),
            }),
        );
        const filename = npm(["pack", "--ignore-scripts", "--pack-destination", dir], source)
            .split("\n")
            .at(-1)!;

        return join(dir, filename);
    };

    return { dir, prefix, root, env, npm, pack };
}

test("npm stages a real offline tarball, swaps whole packages, and rolls back without npm", async (t) => {
    const fixture = sandbox();
    const { dir, prefix, root, env, npm, pack } = fixture;

    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const old = pack("pi-pocket", "1.0.0");
    const fresh = pack("pi-pocket", "2.0.0");

    npm(["install", "--global", "--prefix", prefix, old]);
    const paths = updatePaths(root);
    const originalBin =
        process.platform === "win32"
            ? join(prefix, "pi-pocket.cmd")
            : join(prefix, "bin", "pi-pocket");

    assert.equal(existsSync(originalBin), true);
    await assert.rejects(stageNpmUpdate(root, "2.0.0", { spec: fresh, env }), /pending update/);
    assert.equal(existsSync(paths.staging), false, "pending state precedes staging");
    pending(root);
    await stageNpmUpdate(root, "2.0.0", { spec: fresh, env });
    assert.equal(version(root), "1.0.0");
    assert.equal(version(stagedPackagePath(root)), "2.0.0");
    swapInPackage(root);
    assert.equal(version(root), "2.0.0");
    assert.equal(version(paths.previous), "1.0.0");
    assert.equal(readPending(root)?.phase, "switching");
    assert.equal(readPending(root)?.modules, true);
    assert.equal(
        readFileSync(join(root, "node_modules", "pocket-fixture-dep", "index.js"), "utf8"),
        "module.exports = 42;\n",
    );
    assert.equal(
        existsSync(originalBin),
        true,
        "the global bin link still targets the live package",
    );
    // The rollback function imports Node only. An unreachable registry and empty cache cannot affect it.
    rmSync(env.npm_config_cache, { recursive: true, force: true });
    assert.match(rollBackUpdate(root) ?? "", /went back to 1\.0\.0/);
    assert.equal(version(root), "1.0.0");
    assert.equal(readPending(root), undefined);
    assert.equal(readOutcome(root)?.ok, false);
});

test("npm stage failures leave the live package and pending state unchanged", async (t) => {
    const { dir, root, env, pack } = sandbox();

    t.after(() => rmSync(dir, { recursive: true, force: true }));
    manifest(root, "1.0.0");
    const fresh = pack("pi-pocket", "2.0.0");
    const failing = pack("pi-pocket", "3.0.0", true);

    pending(root, { toVersion: "3.0.0" });
    await assert.rejects(
        stageNpmUpdate(root, "3.0.0", { spec: failing, env }),
        /npm staging failed/,
    );
    assert.equal(version(root), "1.0.0");
    assert.equal(readPending(root)?.phase, "packages");
    assert.equal(existsSync(updatePaths(root).staging), false);
    await assert.rejects(stageNpmUpdate(root, "3.0.0", { spec: fresh, env }), /name and version/);
    assert.equal(version(root), "1.0.0");
    assert.equal(readPending(root)?.toVersion, "3.0.0");
    assert.equal(existsSync(updatePaths(root).previous), false);
    finishNpmPending(root, readPending(root)!);
    assert.equal(readOutcome(root)?.ok, false);
    assert.equal(readPending(root), undefined);

    // A one-way 1 -> 2 update can retain version 1. A later 2 -> 3 staging failure must not
    // treat that unrelated backup as the package it needs to restore.
    manifest(root, "2.0.0");
    const previous = updatePaths(root).previous;

    manifest(previous, "1.0.0");
    pending(root, { fromVersion: "2.0.0", toVersion: "3.0.0" });
    await assert.rejects(
        stageNpmUpdate(root, "3.0.0", { spec: failing, env }),
        /npm staging failed/,
    );
    assert.equal(finishNpmPending(root, readPending(root)!).ok, false);
    assert.equal(version(root), "2.0.0");
    assert.equal(version(previous), "1.0.0", "the unrelated retained backup stays untouched");
    assert.equal(readPending(root), undefined);
});

test("npm ignores the dot sibling during ls, another global install, and uninstall", (t) => {
    const { dir, root, prefix, npm, pack } = sandbox();

    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const first = pack("pi-pocket", "1.0.0");
    const other = pack("pocket-fixture-other", "1.0.0");

    npm(["install", "--global", "--prefix", prefix, first]);
    pending(root);
    const state = updatePaths(root);

    assert.equal(state.dir, join(dirname(root), ".pi-pocket-update"));
    writeFileSync(join(state.dir, "sentinel"), "keep");
    const listing = JSON.parse(npm(["ls", "--global", "--prefix", prefix, "--json"])) as {
        dependencies: Record<string, unknown>;
    };

    assert.equal(".pi-pocket-update" in listing.dependencies, false);
    npm(["install", "--global", "--prefix", prefix, other]);
    assert.equal(readFileSync(join(state.dir, "sentinel"), "utf8"), "keep");
    npm(["uninstall", "--global", "--prefix", prefix, "pi-pocket"]);
    assert.equal(existsSync(root), false);
    assert.equal(readFileSync(join(state.dir, "sentinel"), "utf8"), "keep");
    assert.equal(
        readPending(root)?.kind,
        "npm-global",
        "state remains readable without the package",
    );
});

test("npm state remembers a canonical global root without node_modules in its path", (t) => {
    const dir = mkdtempSync(join(tmpdir(), "pocket-npm-alias-"));
    const root = join(dir, "packages", "pi-pocket");

    t.after(() => rmSync(dir, { recursive: true, force: true }));
    manifest(root, "1.0.0");
    assert.equal(updatePaths(root).dir, join(root, ".pocket-update"));
    pending(`${root}/`);
    const paths = updatePaths(root);

    assert.equal(paths.dir, join(dirname(root), ".pi-pocket-update"));
    assert.equal(
        updatePaths(join(dirname(root), "checkout")).dir,
        join(dirname(root), "checkout", ".pocket-update"),
        "an npm marker does not change a nearby checkout's paths",
    );
    manifest(stagedPackagePath(root), "2.0.0");
    swapInPackage(root);
    assert.equal(version(root), "2.0.0");
    renameSync(root, paths.failed);
    assert.equal(
        readPending(root)?.phase,
        "switching",
        "the marker works without the live package",
    );
    assert.match(rollBackUpdate(root) ?? "", /went back/);
    assert.equal(version(root), "1.0.0");
    assert.equal(readOutcome(root)?.ok, false);
    assert.equal(updatePaths(root).dir, paths.dir, "the marker survives clearing pending state");
});

test("startup repairs the state between package renames before loading the live package", (t) => {
    const { dir, root } = sandbox();

    t.after(() => rmSync(dir, { recursive: true, force: true }));
    manifest(root, "1.0.0");
    pending(root, { phase: "switching" });
    const paths = updatePaths(root);

    manifest(stagedPackagePath(root), "2.0.0");
    renameSync(root, paths.previous);
    assert.equal(existsSync(root), false);
    assert.equal(restoreMissingNpmPackage(root), true);
    assert.equal(version(root), "1.0.0");
    assert.equal(restoreMissingNpmPackage(root), false, "an existing live package is not replaced");
    assert.equal(finishNpmPending(root, readPending(root)!).ok, false);

    // If only the staged copy remains, put it at the live path and retain startup recovery state.
    rmSync(root, { recursive: true });
    pending(root);
    assert.equal(restoreMissingNpmPackage(root), true);
    assert.equal(version(root), "2.0.0");
    assert.equal(finishNpmPending(root, readPending(root)!).ok, true);

    // A warning release that may have run must not fall back to an older data reader.
    renameSync(root, paths.failed);
    manifest(paths.previous, "1.0.0");
    pending(root, { phase: "switching", modules: true, oneWay: true });
    assert.equal(restoreMissingNpmPackage(root), true);
    assert.equal(version(root), "2.0.0");
    assert.equal(version(paths.previous), "1.0.0");
});

test("npm state handles interrupted swaps and restores, one-way releases, and changed packages", (t) => {
    const { dir, root } = sandbox();

    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const paths = updatePaths(root);

    const reset = () => {
        rmSync(dirname(root), { recursive: true, force: true });
        manifest(root, "1.0.0");
        pending(root);
        manifest(stagedPackagePath(root), "2.0.0");
    };

    reset();
    writePending(root, { ...readPending(root)!, phase: "switching" });
    renameSync(root, paths.previous);
    assert.equal(existsSync(root), false);
    assert.match(rollBackUpdate(root) ?? "", /went back/);
    assert.equal(version(root), "1.0.0");

    reset();
    swapInPackage(root);
    renameSync(root, paths.failed);
    assert.equal(restorePackage(root), true, "resume between the restore renames");
    assert.equal(restorePackage(root), true, "resume after the final restore rename");
    assert.match(rollBackUpdate(root) ?? "", /went back/);
    assert.equal(version(root), "1.0.0");

    reset();
    pending(root, { oneWay: true });
    swapInPackage(root);
    assert.match(rollBackUpdate(root) ?? "", /cannot be undone/);
    assert.equal(version(root), "2.0.0");
    assert.equal(version(paths.previous), "1.0.0");

    reset();
    pending(root, { oneWay: true, phase: "switching" });
    renameSync(root, paths.previous);
    rollBackUpdate(root);
    assert.equal(version(root), "1.0.0", "no new package ran in the rename gap");

    reset();
    swapInPackage(root);
    manifest(root, "9.0.0");
    assert.throws(() => rollBackUpdate(root), /live package changed/);
    assert.equal(readPending(root)?.kind, "npm-global", "recovery can retry after the error");
    assert.equal(version(paths.previous), "1.0.0");
    assert.equal(version(root), "9.0.0");
    assert.match(finishNpmPending(root, readPending(root)!).message, /started at 9\.0\.0/);
    assert.equal(readPending(root), undefined, "a successful manual reinstall ends stale recovery");
    assert.equal(version(paths.previous), "1.0.0", "manual recovery keeps the backup");

    reset();
    swapInPackage(root);
    assert.equal(finishNpmPending(root, readPending(root)!).ok, true);
    assert.equal(readPending(root), undefined);

    reset();
    cpSync(root, paths.previous, { recursive: true });
    manifest(paths.failed, "0.9.0");
    swapInPackage(`${root}/`);
    assert.equal(version(root), "2.0.0");
    assert.equal(readPending(`${root}/`)?.phase, "switching");
    assert.equal(updatePaths(`${root}/`).dir, paths.dir, "launcher roots can end with a slash");
    const kept = join(paths.dir, "kept");
    const archived = readdirSync(kept).map((name) => version(join(kept, name, "package")));

    assert.deepEqual(archived.sort(), ["0.9.0", "1.0.0"]);
    assert.equal(
        restorePackage(root),
        true,
        "retained failed packages cannot block the next rollback",
    );
    assert.equal(updatePaths(join(dir, "checkout")).dir, join(dir, "checkout", ".pocket-update"));
    assert.equal(
        updatePaths(join(dir, "node_modules", "@scope", "pi-pocket")).dir,
        join(dir, "node_modules", "@scope", ".pi-pocket-update"),
    );
});

test("a manual target install clears staging state without replacing packages", (t) => {
    const { dir, root } = sandbox();

    t.after(() => rmSync(dir, { recursive: true, force: true }));

    for (const backup of [undefined, "1.0.0", "0.9.0"]) {
        const paths = updatePaths(root);

        rmSync(paths.dir, { recursive: true, force: true });
        manifest(root, "2.0.0");
        const value = pending(root);

        if (backup !== undefined) {
            manifest(paths.previous, backup);
        }

        assert.equal(finishNpmPending(root, value).ok, false);
        assert.equal(version(root), "2.0.0");
        assert.equal(readPending(root), undefined);

        if (backup !== undefined) {
            assert.equal(version(paths.previous), backup);
        }
    }
});
