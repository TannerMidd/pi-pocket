import assert from "node:assert/strict";
import {
    chmodSync,
    mkdirSync,
    mkdtempSync,
    realpathSync,
    renameSync,
    rmSync,
    symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { npmInstallKind, npmWritable } from "../src/server/npm-install.ts";
import { npmRelease, Updates } from "../src/server/updates.ts";

// The npm beside Node reads this prefix too. No global package outside this temporary folder changes.
test("only the exact global npm root can update; local and npx installs show their own command", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-pocket-install-kinds-"));
    const before = process.env.npm_config_prefix;
    const global = join(
        root,
        "prefix",
        process.platform === "win32" ? "node_modules" : "lib/node_modules",
        "pi-pocket",
    );
    const local = join(root, "project", "node_modules", "pi-pocket");
    const npx = join(root, "cache", "_npx", "abc", "node_modules", "pi-pocket");

    process.env.npm_config_prefix = join(root, "prefix");

    try {
        for (const path of [global, local, npx]) {
            mkdirSync(path, { recursive: true });
        }

        assert.equal(await npmInstallKind(global), "npm-global");
        assert.equal(await npmInstallKind(local), "npm-local");
        assert.equal(await npmInstallKind(npx), "npx");
        assert.equal(await npmInstallKind(root), "unknown");
        const link = join(root, "linked-package");

        symlinkSync(global, link, "dir");
        assert.equal(await npmInstallKind(link), "npm-global", "compare real paths");

        for (const [path, kind, command] of [
            [global, "npm-global", undefined],
            [local, "npm-local", "npm install pi-pocket@latest"],
            [npx, "npx", "npx pi-pocket@latest"],
        ] as const) {
            const makeUpdates = (npmRollback = true) =>
                new Updates({
                    appRoot: path,
                    version: "1.0.0",
                    supervised: true,
                    rollback: true,
                    npmRollback,
                    restart: () => assert.fail("a blocked update must not restart"),
                    busy: () => 0,
                    log: () => {},
                    releases: async () => ({
                        tag: "v2.0.0",
                        version: "2.0.0",
                        name: "2.0.0",
                        warning: false,
                    }),
                });
            const updates = makeUpdates();
            const status = await updates.check();

            assert.equal(status.installKind, kind);
            assert.equal(status.available, true);

            if (command === undefined) {
                assert.deepEqual(status.blockers, []);
                assert.equal(status.packages, true);
                const oldLauncher = makeUpdates(false);
                const blocked = await oldLauncher.check();

                assert.equal(blocked.rollback, false);
                assert.match(blocked.blockers.join("\n"), /Quit Pi Pocket and start it again/);
                await assert.rejects(oldLauncher.apply(), { status: 409 });
            } else {
                assert.ok(status.blockers.some((line) => line.includes(command)));
                await assert.rejects(updates.apply(), { status: 409 });
            }
        }

        // A version npm no longer confirms (unpublished, or the registry fails) is not offered from an earlier look.
        let gone = false;
        const withdrawn = new Updates({
            appRoot: global,
            version: "1.0.0",
            supervised: true,
            rollback: true,
            npmRollback: true,
            restart: () => assert.fail("nothing to update"),
            busy: () => 0,
            log: () => {},
            releases: async () => {
                if (gone) {
                    throw new Error("npm answered 404 for the newest release");
                }

                return { tag: "v2.0.0", version: "2.0.0", name: "2.0.0", warning: false };
            },
        });

        assert.equal((await withdrawn.check()).available, true);
        gone = true;
        assert.equal((await withdrawn.check()).available, false);

        const packages = join(root, "packages");

        renameSync(dirname(global), packages);
        symlinkSync(packages, dirname(global), "dir");
        assert.equal(
            await npmInstallKind(realpathSync(global)),
            "npm-global",
            "the global node_modules folder can itself be a symbolic link",
        );
    } finally {
        if (before === undefined) {
            delete process.env.npm_config_prefix;
        } else {
            process.env.npm_config_prefix = before;
        }

        rmSync(root, { recursive: true, force: true });
    }
});

test("npm latest chooses the version; GitHub supplies that tag's notes, or an unread warning", async (t) => {
    const requests: string[] = [];
    let notesStatus = 200;
    let registryStatus = 200;
    const mocked = t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
        requests.push(String(url));

        return String(url).includes("registry.npmjs.org")
            ? Response.json(
                  {
                      "dist-tags": { latest: "1.2.0" },
                      versions: { "1.2.0": { engines: { node: ">=24" } }, "2.0.0": {} },
                  },
                  { status: registryStatus },
              )
            : Response.json(
                  {
                      tag_name: "v1.2.0",
                      body: "> [!WARNING]\n> A one-way step.",
                      name: "The published version",
                  },
                  { status: notesStatus },
              );
    });
    const repository = { owner: "test", name: "pocket" };
    const release = await npmRelease(repository);

    assert.equal(release.version, "1.2.0");
    assert.equal(release.node, ">=24");
    assert.equal(release.warning, true);
    assert.equal(release.unread, undefined);
    assert.ok(requests[1]?.endsWith("/releases/tags/v1.2.0"));
    notesStatus = 404;
    const unread = await npmRelease(repository);

    assert.equal(unread.version, "1.2.0");
    assert.equal(unread.unread, true);
    registryStatus = 503;
    const count = requests.length;

    await assert.rejects(npmRelease(repository), /npm answered 503/);
    assert.equal(
        requests.length,
        count + 1,
        "a registry failure does not offer a GitHub-only release",
    );
    mocked.mock.restore();
});

test("an update state folder that the server cannot write stops an npm update before it starts", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "pocket-npm-writable-"));
    const root = join(dir, "lib", "node_modules", "pi-pocket");
    const state = join(dir, "lib", "node_modules", ".pi-pocket-update");

    t.after(() => {
        chmodSync(state, 0o755);
        rmSync(dir, { recursive: true, force: true });
    });
    mkdirSync(root, { recursive: true });
    mkdirSync(state);
    assert.equal(await npmWritable(root), true);
    chmodSync(state, 0o555);
    assert.equal(await npmWritable(root), process.getuid?.() === 0);
});

test("warnings after the displayed notes limit still require care", async (t) => {
    let alert = "WARNING";

    t.mock.method(globalThis, "fetch", async (url: string | URL | Request) =>
        String(url).includes("registry.npmjs.org")
            ? Response.json({
                  "dist-tags": { latest: "1.2.0" },
                  versions: { "1.2.0": {} },
              })
            : Response.json({
                  tag_name: "v1.2.0",
                  body: `${"x".repeat(60_000)}\n> [!${alert}]\n> A one-way migration.`,
              }),
    );

    for (const kind of ["WARNING", "CAUTION"]) {
        alert = kind;
        const release = await npmRelease({ owner: "test", name: "pocket" });

        assert.equal(release.notes?.length, 60_000);
        assert.equal(release.warning, true);
        assert.equal(release.unread, undefined);
    }
});
