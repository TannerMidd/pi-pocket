import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { after, test } from "node:test";
import {
    chmodSync,
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, posix } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { cleanUp, openApp, root, scriptedModel } from "./helpers.ts";
import {
    parseAllowedHosts,
    type GuestChunk,
    type GuestExecOptions,
    type GuestFs,
    type GuestProcess,
    type GuestVm,
    type HostCheck,
    type SandboxDriver,
    type VmSpec,
} from "../src/server/extensions/gondolin/guest.ts";
import {
    applyPatchToNewBranch,
    inspectPatch,
    validBranchName,
} from "../src/server/extensions/gondolin/patch.ts";
import {
    seedWorkspace,
    validateGitUrl,
    validateSeedSource,
} from "../src/server/extensions/gondolin/seed.ts";
import {
    parseSandboxUri,
    SandboxManager,
    sandboxUri,
} from "../src/server/extensions/gondolin/manager.ts";
import createGondolin from "../src/server/extensions/gondolin.ts";

after(cleanUp);

/** Minimal in-memory/tempdir fake VM driver so tests run deterministically on every OS without KVM/QEMU. */
class FakeVm implements GuestVm {
    readonly id: string;
    readonly rootDir: string;
    readonly fs: GuestFs;
    closed = false;
    readonly #exits: ((reason: string) => void)[] = [];

    constructor(id: string) {
        this.id = id;
        this.rootDir = mkdtempSync(join(tmpdir(), `fake-gondolin-${id}-`));
        mkdirSync(join(this.rootDir, "workspace"), { recursive: true });
        mkdirSync(join(this.rootDir, "tmp"), { recursive: true });

        const map = (guestPath: string): string => {
            const norm = posix.normalize(guestPath.startsWith("/") ? guestPath : `/${guestPath}`);
            const rel = norm.replace(/^\/+/, "");

            return join(this.rootDir, rel);
        };

        this.fs = {
            readFile: async (p) => new Uint8Array(readFileSync(map(p))),
            writeFile: async (p, data) => {
                const target = map(p);

                mkdirSync(join(target, ".."), { recursive: true });
                writeFileSync(target, data);
            },
            stat: async (p) => {
                const s = lstatSync(map(p));

                return {
                    kind: s.isSymbolicLink()
                        ? "symlink"
                        : s.isDirectory()
                          ? "directory"
                          : s.isFile()
                            ? "file"
                            : "other",
                    size: s.size,
                    mtimeMs: s.mtimeMs,
                };
            },
            list: async (p) => readdirSync(map(p)),
            mkdir: async (p, recursive) => {
                mkdirSync(map(p), { recursive });
            },
            remove: async (p, opts) => {
                rmSync(map(p), { recursive: opts.recursive, force: opts.force });
            },
            rename: async (from, to) => {
                renameSync(map(from), map(to));
            },
        };
    }

    hostPid(): number | null {
        return null;
    }

    onExit(listener: (reason: string) => void): void {
        this.#exits.push(listener);
    }

    exec(argv: string[], options: GuestExecOptions = {}): GuestProcess {
        const guestCwd = options.cwd ?? "/workspace";
        const hostCwd = join(this.rootDir, guestCwd.replace(/^\/+/, ""));
        const rewrite = (arg: string) =>
            arg
                .replace(/\/workspace/g, join(this.rootDir, "workspace"))
                .replace(/\/tmp\/pocket-/g, join(this.rootDir, "tmp", "pocket-"));

        const rewritten = argv.map(rewrite);
        let stdout = "";
        let stderr = "";
        let exitCode = 0;

        try {
            stdout = execFileSync(rewritten[0]!, rewritten.slice(1), {
                cwd: existsSync(hostCwd) ? hostCwd : this.rootDir,
                encoding: "utf8",
                env: { ...process.env, ...options.env },
                stdio: ["pipe", "pipe", "pipe"],
            });
        } catch (error) {
            const err = error as { status?: number; stdout?: string; stderr?: string };

            exitCode = err.status ?? 1;
            stdout = String(err.stdout ?? "");
            stderr = String(err.stderr ?? "");
        }

        const chunks: GuestChunk[] = [];

        if (stdout !== "") {
            chunks.push({ stream: "stdout", data: Buffer.from(stdout, "utf8") });
        }

        if (stderr !== "") {
            chunks.push({ stream: "stderr", data: Buffer.from(stderr, "utf8") });
        }

        return {
            output: async function* () {
                for (const c of chunks) {
                    yield c;
                }
            },
            result: Promise.resolve({ exitCode }),
            write: () => {},
            end: () => {},
        };
    }

    async close(): Promise<void> {
        this.closed = true;
        rmSync(this.rootDir, { recursive: true, force: true });
    }
}

class FakeDriver implements SandboxDriver {
    starts = 0;
    lastSpec: VmSpec | undefined;

    installed(): boolean {
        return true;
    }

    async check(): Promise<HostCheck> {
        return {
            ok: true,
            backend: "krun",
            lines: [{ name: "Fake", ok: true, detail: "Ready" }],
            images: [{ name: "alpine-base:latest", git: true }],
        };
    }

    async setup(progress: (line: string) => void): Promise<void> {
        progress("Fake setup done.");
    }

    async start(spec: VmSpec, _signal?: AbortSignal, onRunner?: (vm: GuestVm) => void) {
        this.starts++;
        this.lastSpec = spec;
        const vm = new FakeVm(`${spec.sandboxId}-${this.starts}`);

        onRunner?.(vm);

        return vm;
    }
}

function makeTempGitRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), "pocket-gondolin-repo-"));

    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
    writeFileSync(join(dir, "README.md"), "# Demo\nhello\n");
    writeFileSync(join(dir, ".env"), "SECRET_KEY=do-not-copy\n");
    execFileSync("git", ["add", "README.md"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd: dir });

    return dir;
}

test("parseAllowedHosts strips schemes/ports and drops loopback and private addresses", () => {
    const hosts = parseAllowedHosts(
        "https://Registry.NPMJS.org/path, github.com:443, localhost, 127.0.0.1, 10.0.0.1, 192.168.1.5, 169.254.169.254, [::1], foo.local, api.github.com",
    );

    assert.deepEqual(hosts, ["registry.npmjs.org", "github.com", "api.github.com"]);
});

test("inspectPatch rejects symlinks, submodules, binary patches, .git paths, and traversals, and flags risky files", () => {
    const clean = inspectPatch(
        [
            "diff --git a/src/app.ts b/src/app.ts",
            "index 1111111..2222222 100644",
            "--- a/src/app.ts",
            "+++ b/src/app.ts",
            "@@ -1 +1,2 @@",
            " const x = 1;",
            "+const y = 2;",
            "diff --git a/package.json b/package.json",
            "--- a/package.json",
            "+++ b/package.json",
            "@@ -1 +1 @@",
            '-{"name":"a"}',
            '+{"name":"a","scripts":{"postinstall":"echo hi"}}',
        ].join("\n"),
    );

    assert.equal(clean.ok, true);
    assert.equal(clean.files.length, 2);
    assert.equal(clean.totalAdded, 2);
    assert.equal(clean.totalRemoved, 1);
    assert.equal(clean.riskyFiles.length, 1);
    assert.equal(clean.riskyFiles[0]!.path, "package.json");

    // Symlink creation (120000) is blocked.
    const symlinkPatch = inspectPatch(
        [
            "diff --git a/evil b/evil",
            "new file mode 120000",
            "--- /dev/null",
            "+++ b/evil",
            "@@ -0,0 +1 @@",
            "+/etc/passwd",
        ].join("\n"),
    );

    assert.equal(symlinkPatch.ok, false);
    assert.ok(symlinkPatch.blocked.some((b) => /120000/.test(b)));

    // Submodule (160000) is blocked.
    const subPatch = inspectPatch(
        "diff --git a/sub b/sub\nnew file mode 160000\n--- /dev/null\n+++ b/sub\n",
    );

    assert.equal(subPatch.ok, false);
    assert.ok(subPatch.blocked.some((b) => /160000/.test(b)));

    // `.git/` paths and traversals are blocked.
    for (const badPath of [
        ".git/hooks/pre-commit",
        ".GIT./config",
        "../outside.txt",
        "/etc/hosts",
    ]) {
        const res = inspectPatch(
            `diff --git a/${badPath} b/${badPath}\n--- /dev/null\n+++ b/${badPath}\n`,
        );

        assert.equal(res.ok, false, `expected ${badPath} to be blocked`);
    }

    // Binary patches are blocked.
    const binPatch = inspectPatch("diff --git a/a.bin b/a.bin\nGIT binary patch\nliteral 0\n");

    assert.equal(binPatch.ok, false);

    // Hunk-smuggled plain unified diff after a valid git hunk MUST be blocked.
    const smuggled = inspectPatch(
        [
            "diff --git a/ok.txt b/ok.txt",
            "--- a/ok.txt",
            "+++ b/ok.txt",
            "@@ -1 +1,2 @@",
            " hello",
            "+world",
            "--- a/ok.txt",
            "+++ b/.git/hooks/pre-commit",
            "@@ -0,0 +1 @@",
            "+#!/bin/sh",
        ].join("\n"),
    );

    assert.equal(smuggled.ok, false);
    assert.ok(smuggled.blocked.length > 0);

    // Plain unified diff without a `diff --git` header MUST be blocked.
    const noGitHeader = inspectPatch(
        ["--- a/foo.txt", "+++ b/foo.txt", "@@ -1 +1 @@", "-a", "+b"].join("\n"),
    );

    assert.equal(noGitHeader.ok, false);
});

test("applyPatchToNewBranch commits onto a fresh branch without touching the live working tree", async () => {
    const repo = makeTempGitRepo();

    try {
        // Create an uncommitted edit in the user's live working tree.
        writeFileSync(join(repo, "README.md"), "# Dirty local edit\n");

        const patch = [
            "diff --git a/README.md b/README.md",
            "--- a/README.md",
            "+++ b/README.md",
            "@@ -1,2 +1,3 @@",
            " # Demo",
            " hello",
            "+from sandbox",
            "",
        ].join("\n");

        const result = await applyPatchToNewBranch({
            repoPath: repo,
            branchName: "sandbox/test-apply",
            patch,
            commitMessage: "Add sandbox line",
        });

        assert.equal(result.branch, "sandbox/test-apply");
        assert.equal(result.filesChanged, 1);

        // Live working tree was NEVER touched!
        assert.equal(readFileSync(join(repo, "README.md"), "utf8"), "# Dirty local edit\n");

        // New branch contains the applied change cleanly.
        const onBranch = execFileSync("git", ["show", "sandbox/test-apply:README.md"], {
            cwd: repo,
            encoding: "utf8",
        });

        assert.equal(onBranch, "# Demo\nhello\nfrom sandbox\n");

        // Refuses overwriting an existing branch.
        await assert.rejects(
            applyPatchToNewBranch({
                repoPath: repo,
                branchName: "sandbox/test-apply",
                patch,
            }),
            /already exists/,
        );

        assert.equal(validBranchName("sandbox/ok-1"), true);
        assert.equal(validBranchName("--evil"), false);
        assert.equal(validBranchName("a..b"), false);
    } finally {
        rmSync(repo, { recursive: true, force: true });
    }
});

test("validateSeedSource and validateGitUrl refuse sensitive roots and non-https URLs", () => {
    const dataDir = join(root, "fake-data");

    mkdirSync(dataDir, { recursive: true });
    assert.throws(() => validateSeedSource("/", dataDir), /Refusing to seed/);
    assert.throws(() => validateSeedSource(homedir(), dataDir), /Refusing to seed/);
    assert.throws(() => validateSeedSource(dataDir, dataDir), /Refusing to seed/);

    assert.throws(() => validateGitUrl("file:///etc/passwd"), /https:\/\//);
    assert.throws(() => validateGitUrl("--upload-pack=sh"), /valid https:\/\//);
    assert.equal(
        validateGitUrl("https://github.com/TannerMidd/pi-pocket.git"),
        "https://github.com/TannerMidd/pi-pocket.git",
    );
});

test("SandboxManager seeds a repo one-way, persists workspace across stop/restart, and produces a valid diff", async () => {
    const repo = makeTempGitRepo();
    const mgrDir = mkdtempSync(join(tmpdir(), "pocket-gondolin-mgr-"));
    const driver = new FakeDriver();
    const manager = new SandboxManager({
        dir: mgrDir,
        dataDir: join(root, "data-mgr"),
        driver,
        settings: () => ({
            backend: "auto",
            image: "alpine-base:latest",
            networkMode: "allowlist",
            allowedHosts: ["registry.npmjs.org"],
            memoryMb: 1024,
            cpus: 2,
            diskMb: 4096,
            idleMinutes: 30,
        }),
    });

    try {
        const created = manager.create({
            name: "demo",
            source: { kind: "repo", sourcePath: repo },
        });
        const uri = sandboxUri(created.id);

        assert.equal(parseSandboxUri(uri), created.id);
        assert.equal(await manager.resolveCwd(uri), uri);

        const env = manager.env(uri);

        // First read lazily boots the VM and seeds from the repo (without host .env!).
        const readme = await env.readTextFile("README.md", BACKGROUND_CONTEXT);

        assert.equal(readme.ok, true);
        assert.equal(readme.ok ? readme.value : "", "# Demo\nhello\n");
        assert.equal(driver.starts, 1);

        const dotEnv = await env.exists(".env", BACKGROUND_CONTEXT);

        assert.equal(dotEnv.ok, true);
        assert.equal(dotEnv.ok ? dotEnv.value : true, false);

        // Write a change inside the VM; host repo must remain untouched.
        const written = await env.writeFile(
            "README.md",
            "# Demo\nhello\nfrom vm\n",
            BACKGROUND_CONTEXT,
        );

        assert.equal(written.ok, true);
        assert.equal(readFileSync(join(repo, "README.md"), "utf8"), "# Demo\nhello\n");

        // Stop (snapshots /workspace) and verify persistence on next boot.
        await manager.stop(created.id, { saveSnapshot: true });
        const afterStop = manager.list().find((s) => s.id === created.id);

        assert.equal(afterStop?.state, "stopped");
        assert.equal(afterStop?.hasSnapshot, true);

        const readmeAfterRestart = await env.readTextFile("README.md", BACKGROUND_CONTEXT);

        assert.equal(driver.starts, 2);
        assert.equal(
            readmeAfterRestart.ok ? readmeAfterRestart.value : "",
            "# Demo\nhello\nfrom vm\n",
        );

        // Extract and inspect the diff from inside the VM.
        const inspection = await manager.diff(created.id);

        assert.equal(inspection.ok, true);
        assert.equal(inspection.files.length, 1);
        assert.equal(inspection.files[0]!.path, "README.md");
        assert.match(inspection.patch, /\+from vm/);
        assert.match(inspection.patchHash, /^[0-9a-f]{64}$/);

        // Committing work inside the VM MUST still appear in export diff (diffs against baseCommit, not HEAD).
        const committed = await env.exec(
            'git add README.md && git commit -q -m "agent commit"',
            undefined,
            BACKGROUND_CONTEXT,
        );

        assert.equal(committed.ok, true);
        assert.equal(committed.ok ? committed.value.exitCode : 1, 0);

        const afterCommit = await manager.diff(created.id);

        assert.equal(afterCommit.ok, true);
        assert.equal(afterCommit.files.length, 1);
        assert.equal(afterCommit.files[0]!.path, "README.md");
        assert.match(afterCommit.patch, /\+from vm/);
    } finally {
        await manager.closeAll();
        rmSync(repo, { recursive: true, force: true });
        rmSync(mgrDir, { recursive: true, force: true });
    }
});

test("Git seeding strips tracked and historical .env secrets, and empty allow-list stays empty", async () => {
    const repo = makeTempGitRepo();
    const mgrDir = mkdtempSync(join(tmpdir(), "pocket-gondolin-secrets-"));
    const driver = new FakeDriver();

    try {
        // Commit a secret .env, then delete it in a second commit, plus track another .env.local.
        writeFileSync(join(repo, ".env.old"), "OLD_SECRET=123\n");
        writeFileSync(join(repo, ".env.local"), "TRACKED_SECRET=456\n");
        execFileSync("git", ["add", ".env.old", ".env.local"], { cwd: repo });
        execFileSync("git", ["commit", "-q", "-m", "add secrets"], { cwd: repo });
        rmSync(join(repo, ".env.old"));
        execFileSync("git", ["add", "-A"], { cwd: repo });
        execFileSync("git", ["commit", "-q", "-m", "remove old secret"], { cwd: repo });

        const manager = new SandboxManager({
            dir: mgrDir,
            dataDir: join(root, "data-sec"),
            driver,
            settings: () => ({
                backend: "auto",
                image: "alpine-base:latest",
                networkMode: "allowlist",
                allowedHosts: [],
                memoryMb: 1024,
                cpus: 2,
                diskMb: 4096,
                idleMinutes: 30,
            }),
        });

        try {
            const created = manager.create({
                name: "secret-check",
                source: { kind: "repo", sourcePath: repo },
                networkMode: "allowlist",
                allowedHosts: [],
            });
            const env = manager.env(sandboxUri(created.id));

            // Boot VM and check network allowlist remained explicitly empty (not overwritten by defaults).
            const readme = await env.readTextFile("README.md", BACKGROUND_CONTEXT);

            assert.equal(readme.ok, true);
            assert.deepEqual(driver.lastSpec?.network.allowedHosts, []);

            // Neither tracked .env.local nor historical .env.old exist anywhere in the guest repo or history.
            const hasLocal = await env.exists(".env.local", BACKGROUND_CONTEXT);

            assert.equal(hasLocal.ok ? hasLocal.value : true, false);

            let gitLogOut = "";
            const logRes = await env.exec(
                "git log --all --stat",
                { onOutput: (chunk) => (gitLogOut += chunk) },
                BACKGROUND_CONTEXT,
            );

            assert.equal(logRes.ok, true);
            assert.ok(!gitLogOut.includes(".env.old"), "historical .env.old must not leak");
            assert.ok(!gitLogOut.includes(".env.local"), "tracked .env.local must not leak");
        } finally {
            await manager.closeAll();
        }
    } finally {
        rmSync(repo, { recursive: true, force: true });
        rmSync(mgrDir, { recursive: true, force: true });
    }
});

test("applyPatchToNewBranch disables configured Git clean/smudge filters", async () => {
    const repo = makeTempGitRepo();
    const marker = join(tmpdir(), `pocket-filter-marker-${Date.now()}`);

    try {
        // Configure an aggressive clean/smudge filter in the target repo's .gitattributes and .git/config.
        writeFileSync(join(repo, ".gitattributes"), "*.md filter=evil\n");
        execFileSync("git", ["add", ".gitattributes"], { cwd: repo });
        execFileSync("git", ["commit", "-q", "-m", "add attributes"], { cwd: repo });
        execFileSync("git", ["config", "filter.evil.clean", `sh -c 'touch "${marker}"; cat'`], {
            cwd: repo,
        });
        execFileSync("git", ["config", "filter.evil.smudge", `sh -c 'touch "${marker}"; cat'`], {
            cwd: repo,
        });
        execFileSync("git", ["config", "filter.evil.required", "true"], { cwd: repo });

        const patch = [
            "diff --git a/README.md b/README.md",
            "--- a/README.md",
            "+++ b/README.md",
            "@@ -1,2 +1,3 @@",
            " # Demo",
            " hello",
            "+safe apply",
            "",
        ].join("\n");

        const result = await applyPatchToNewBranch({
            repoPath: repo,
            branchName: "sandbox/filter-safe",
            patch,
        });

        assert.equal(result.branch, "sandbox/filter-safe");
        assert.equal(existsSync(marker), false, "Git filter command must never run during apply");
    } finally {
        rmSync(marker, { force: true });
        rmSync(repo, { recursive: true, force: true });
    }
});

test("stop keeps VM running when workspace snapshot fails", async () => {
    const mgrDir = mkdtempSync(join(tmpdir(), "pocket-gondolin-failstop-"));
    const failingDriver: SandboxDriver = {
        installed: () => true,
        check: async () => ({ ok: true, backend: "krun", lines: [], images: [] }),
        setup: async () => {},
        start: async (spec) => {
            const vm = new FakeVm(spec.sandboxId);
            const origExec = vm.exec.bind(vm);

            vm.exec = (argv, opts) => {
                if (argv.some((a) => a.includes("tar -czf"))) {
                    return {
                        output: async function* () {
                            yield {
                                stream: "stderr" as const,
                                data: Buffer.from("disk full", "utf8"),
                            };
                        },
                        result: Promise.resolve({ exitCode: 1 }),
                        write: () => {},
                        end: () => {},
                    };
                }

                return origExec(argv, opts);
            };

            return vm;
        },
    };
    const manager = new SandboxManager({
        dir: mgrDir,
        dataDir: join(root, "data-failstop"),
        driver: failingDriver,
        settings: () => ({
            backend: "auto",
            image: "alpine-base:latest",
            networkMode: "off",
            allowedHosts: [],
            memoryMb: 1024,
            cpus: 2,
            diskMb: 4096,
            idleMinutes: 30,
        }),
    });

    try {
        const sb = manager.create({ name: "save-fail", source: { kind: "empty" } });
        const env = manager.env(sandboxUri(sb.id));

        await env.writeFile("work.txt", "important", BACKGROUND_CONTEXT);
        await assert.rejects(manager.stop(sb.id, { saveSnapshot: true }), /tar exited 1/);

        // VM stays running and work is still intact!
        assert.equal(manager.list().find((s) => s.id === sb.id)?.state, "running");
        const read = await env.readTextFile("work.txt", BACKGROUND_CONTEXT);

        assert.equal(read.ok ? read.value : "", "important");
    } finally {
        await manager.closeAll();
        rmSync(mgrDir, { recursive: true, force: true });
    }
});

test("createGondolin binds apply to reviewed patchHash and exposes sandboxByConversation in status", async () => {
    const app = await openApp(scriptedModel());
    const repo = makeTempGitRepo();
    const driver = new FakeDriver();
    let disposeFn: (() => Promise<void> | void) | undefined;
    const routes = new Map<string, (req: Record<string, unknown>) => Promise<unknown>>();

    try {
        const fakeHost = {
            dataDir: app.dataDir,
            registerWorkspaceProvider: (
                scheme: string,
                provider: Parameters<typeof app.registerWorkspaceProvider>[1],
            ) => app.registerWorkspaceProvider(scheme, provider),
            notice: () => {},
            text: { quoted: (t: string) => t, defang: (t: string) => t },
        };
        const fakeWeb = {
            settings: () => {},
            setting: () => undefined,
            onDispose: (fn: () => Promise<void> | void) => {
                disposeFn = fn;
            },
            client: () => {},
            route: (
                method: string,
                path: string,
                handler: (req: Record<string, unknown>) => Promise<unknown>,
            ) => {
                routes.set(`${method} ${path}`, handler);
            },
            send: () => {},
            error: (status: number, message: string) =>
                Object.assign(new Error(message), { status }),
        };

        createGondolin(fakeHost as never, fakeWeb as never, { driver });
        assert.equal(app.isIsolatedWorkspace("gondolin://sb-123456/workspace"), true);

        const createRoute = routes.get("POST sandboxes")!;
        const diffRoute = routes.get("GET sandboxes/:id/diff")!;
        const applyRoute = routes.get("POST sandboxes/:id/apply")!;
        const statusRoute = routes.get("GET status")!;

        let createdCwd = "";
        const created = (await createRoute({
            body: { title: "Review Test", source: "repo", sourcePath: repo },
            createSession: async ({ cwd }: { cwd: string }) => {
                createdCwd = cwd;

                return { id: 42 };
            },
        })) as { sandbox: { id: string } };
        const sbId = created.sandbox.id;

        // Status maps conversationId -> sandboxId so pocket.onConversation(id) shows the status item.
        const status = (await statusRoute({
            sessions: () => [{ id: 42, cwd: createdCwd }],
        })) as { sandboxByConversation: Record<number, string> };

        assert.equal(status.sandboxByConversation[42], sbId);

        // Modify a file inside the VM, inspect diff, then mutate again before apply: apply must reject with 409!
        const session = await app.commands.createSession(app.config.users[0]!, {
            cwd: createdCwd,
        });
        const env = app.envFor(session.id);

        await env.writeFile("README.md", "# Demo\nhello\nreviewed\n", BACKGROUND_CONTEXT);
        const reviewed = (await diffRoute({ params: { id: sbId } })) as { patchHash: string };

        await env.writeFile(
            "README.md",
            "# Demo\nhello\nsneaky post-review change\n",
            BACKGROUND_CONTEXT,
        );
        await assert.rejects(
            applyRoute({
                params: { id: sbId },
                body: {
                    repoPath: repo,
                    branchName: "sandbox/stale",
                    patchHash: reviewed.patchHash,
                },
            }),
            { status: 409 },
        );

        // Refreshing diff and applying with the current patchHash succeeds.
        const refreshed = (await diffRoute({ params: { id: sbId } })) as { patchHash: string };
        const applied = (await applyRoute({
            params: { id: sbId },
            body: {
                repoPath: repo,
                branchName: "sandbox/fresh",
                patchHash: refreshed.patchHash,
            },
        })) as { branch: string };

        assert.equal(applied.branch, "sandbox/fresh");
    } finally {
        await disposeFn?.();
        rmSync(repo, { recursive: true, force: true });
        await app.close();
    }
});

test("seedWorkspace rejects symlinked parent folders, preserves executable bits, includes staged files, and fails loudly when oversized", async () => {
    const repo = makeTempGitRepo();
    const externalDir = mkdtempSync(join(tmpdir(), "pocket-gondolin-ext-"));
    const vm = new FakeVm("seed-checks");

    try {
        // Track an executable script and a nested config file.
        mkdirSync(join(repo, "config"), { recursive: true });
        writeFileSync(join(repo, "config", "data.txt"), "internal\n");
        writeFileSync(join(repo, "run.sh"), "#!/bin/sh\necho ok\n");
        chmodSync(join(repo, "run.sh"), 0o755);
        execFileSync("git", ["add", "config/data.txt", "run.sh"], { cwd: repo });
        execFileSync("git", ["update-index", "--chmod=+x", "run.sh"], { cwd: repo });
        execFileSync("git", ["commit", "-q", "-m", "add script and config"], { cwd: repo });

        // Replace `config/` in the working tree with a symlink pointing outside the repo (POSIX).
        if (process.platform !== "win32") {
            writeFileSync(join(externalDir, "data.txt"), "EXTERNAL-HOST-SECRET\n");
            rmSync(join(repo, "config"), { recursive: true, force: true });
            symlinkSync(externalDir, join(repo, "config"));
        }

        // Stage a brand-new file (not in HEAD yet), then configure core.fsmonitor to prove seeding never runs it.
        const fsmonitorMarker = join(tmpdir(), `pocket-fsmonitor-marker-${Date.now()}`);

        writeFileSync(join(repo, "staged-new.txt"), "from staging area\n");
        execFileSync("git", ["add", "staged-new.txt"], { cwd: repo });
        execFileSync("git", ["config", "core.fsmonitor", `sh -c 'touch "${fsmonitorMarker}"'`], {
            cwd: repo,
        });

        // Seed with includeUncommitted: true.
        const seeded = await seedWorkspace(vm, {
            kind: "repo",
            sourcePath: repo,
            includeUncommitted: true,
        });

        assert.equal(
            existsSync(fsmonitorMarker),
            false,
            "core.fsmonitor must never execute during seeding",
        );
        rmSync(fsmonitorMarker, { force: true });

        assert.match(seeded.baseCommit ?? "", /^[0-9a-f]{40,64}$/);

        // 1. Symlinked parent directory MUST NOT leak external host file.
        if (process.platform !== "win32") {
            await assert.rejects(vm.fs.readFile("/workspace/config/data.txt"));
        }

        // 2. Staged new file MUST be present.
        const stagedBytes = await vm.fs.readFile("/workspace/staged-new.txt");

        assert.equal(Buffer.from(stagedBytes).toString("utf8"), "from staging area\n");

        // 3. Executable bit MUST be preserved in the initial guest commit (100755) on POSIX.
        if (process.platform !== "win32") {
            const modeOut = execFileSync("git", ["ls-tree", "HEAD", "run.sh"], {
                cwd: join(vm.rootDir, "workspace"),
                encoding: "utf8",
            });

            assert.match(modeOut, /^100755 blob /);
        }

        // 4. Oversized seed MUST fail loudly instead of silently truncating.
        const vm2 = new FakeVm("seed-oversized");

        try {
            await assert.rejects(
                seedWorkspace(vm2, {
                    kind: "repo",
                    sourcePath: repo,
                    limits: { maxFiles: 1 },
                }),
                /exceeds the 1-file snapshot limit/,
            );
        } finally {
            await vm2.close();
        }
    } finally {
        await vm.close();
        rmSync(externalDir, { recursive: true, force: true });
        rmSync(repo, { recursive: true, force: true });
    }
});

test("inspectPatch accepts trailing no-newline markers and paths with spaces", () => {
    const noNewline = inspectPatch(
        [
            "diff --git a/my file.txt b/my file.txt",
            "index 1111111..2222222 100644",
            "--- a/my file.txt",
            "+++ b/my file.txt",
            "@@ -1 +1 @@",
            "-old",
            "\\ No newline at end of file",
            "+new",
            "\\ No newline at end of file",
            "",
        ].join("\n"),
    );

    assert.equal(noNewline.ok, true);
    assert.equal(noNewline.files.length, 1);
    assert.equal(noNewline.files[0]!.path, "my file.txt");

    // Unsafe path with spaces is still rejected.
    const badSpaces = inspectPatch(
        [
            "diff --git a/my file.txt b/../evil file.txt",
            "--- a/my file.txt",
            "+++ b/../evil file.txt",
            "@@ -1 +1 @@",
            "-a",
            "+b",
        ].join("\n"),
    );

    assert.equal(badSpaces.ok, false);
});

test("gondolin browser module conforms to Pi Pocket extension UI contract", async () => {
    const moduleUrl = new URL("../src/server/extensions/gondolin/index.js", import.meta.url).href;
    const mod = (await import(moduleUrl)) as {
        pocketApi: number;
        default: (pocket: Record<string, unknown>) => void;
    };

    assert.equal(mod.pocketApi, 2);

    const sheets: Record<string, unknown>[] = [];
    const menus: Record<string, unknown>[] = [];
    const launchers: Record<string, unknown>[] = [];
    const styles: string[] = [];
    let statusSpec: Record<string, unknown> | null = null;
    let statusRemoved = false;
    let onConvListener: ((id: number | null) => void) | undefined;
    const disposes: (() => void)[] = [];

    const mockPocket = {
        html: () => null,
        useEffect: () => {},
        useState: (init: unknown) => [init, () => {}],
        style: (path: string) => {
            assert.equal(typeof path, "string");
            styles.push(path);
        },
        api: async (path: string) => {
            if (path === "status") {
                return {
                    installed: true,
                    check: { ok: true, lines: [] },
                    sandboxes: [{ id: "sb-abc123", name: "Demo", state: "running" }],
                    sandboxByConversation: { 7: "sb-abc123" },
                    setup: { running: false },
                };
            }

            return {};
        },
        notify: () => {},
        on: () => () => {},
        onDispose: (fn: () => void) => {
            disposes.push(fn);
        },
        menu: (spec: Record<string, unknown>) => {
            assert.equal(typeof spec.id, "string");
            assert.equal(typeof spec.label, "string");
            assert.ok(String(spec.label).trim() !== "");
            menus.push(spec);
        },
        launcher: (spec: Record<string, unknown>) => {
            assert.equal(typeof spec.id, "string");
            assert.equal(typeof spec.label, "string");
            launchers.push(spec);
        },
        sheet: (spec: Record<string, unknown>) => {
            assert.equal(typeof spec, "object");
            assert.equal(typeof spec.id, "string");
            assert.equal(typeof spec.title, "string");
            assert.equal(typeof spec.component, "function");
            sheets.push(spec);
        },
        status: (spec: Record<string, unknown>) => {
            // Mirrors web/extension-ui.js check(): status requires non-empty text.
            assert.equal(typeof spec.id, "string");
            assert.equal(typeof spec.text, "string");
            assert.ok(String(spec.text).trim() !== "", "status.text must be non-empty");
            statusSpec = { ...spec };
            statusRemoved = false;

            return {
                update: (patch: Record<string, unknown>) => {
                    statusSpec = { ...statusSpec, ...patch };
                    assert.ok(String(statusSpec.text).trim() !== "");
                },
                remove: () => {
                    statusSpec = null;
                    statusRemoved = true;
                },
            };
        },
        onConversation: (listener: (id: number | null) => void) => {
            onConvListener = listener;

            return () => {
                onConvListener = undefined;
            };
        },
    };

    mod.default(mockPocket);
    // Allow initial refresh() microtask to resolve.
    await new Promise((r) => setTimeout(r, 10));

    assert.deepEqual(styles, ["style.css"]);
    assert.equal(menus.length, 1);
    assert.equal(launchers.length, 1);
    assert.deepEqual(
        sheets.map((s) => s.id),
        ["main", "diff"],
    );
    assert.equal(statusSpec, null, "status item should not show outside a sandbox session");

    // Switching to sandbox conversation #7 adds the status item; leaving removes it.
    onConvListener?.(7);
    assert.ok(statusSpec !== null);
    assert.match(String((statusSpec as Record<string, unknown>).text), /Sandbox/);

    onConvListener?.(99);
    assert.equal(statusSpec, null);
    assert.equal(statusRemoved, true);

    for (const fn of disposes) {
        fn();
    }
});
