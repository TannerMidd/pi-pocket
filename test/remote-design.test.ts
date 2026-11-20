// Design uses a server mirror but the session's existing runner permission supplies every project read and write.
import { cleanUp, context, openApp, owner, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, before, describe, it } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { Runner } from "../src/runner/runner.ts";
import type { PocketHost } from "../src/server/host.ts";
import { designTools } from "../src/server/design/index.ts";
import { designGuide } from "../src/server/design/guide.ts";
import { withDesignMirror, MIRROR_BYTES } from "../src/server/design/mirror.ts";
import createArtifacts from "../src/server/extensions/artifacts.ts";
import { createPublicFetch } from "../src/server/public-fetch.ts";

let app: Awaited<ReturnType<typeof openApp>>;
let server: Server;
let runner: Runner;
let id: ConversationId;
let base: string;
let host: PocketHost;
const there = join(root, "computer");
const content =
    '<!doctype html><meta name="viewport" content="width=device-width"><h1 data-pid="title">Remote design</h1>';

function api() {
    return {
        conversationId: id,
        taskId: 90,
        callId: "remote-design",
        agent: async () => ({ cwd: there }),
        snapshot: app.harness.snapshot.bind(app.harness),
        commit: app.harness.commit.bind(app.harness),
    };
}

const call = (name: string, args: object) =>
    designTools(host)
        .find((tool) => tool.name === name)!
        .execute(args, api() as never, context);
const request = (path: string, body?: object) =>
    fetch(`${base}/api/x/design/c/${id}/${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
            authorization: `Bearer ${app.config.ownerToken}`,
            "content-type": "application/json",
            "x-pocket": "1",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

before(async () => {
    mkdirSync(there, { recursive: true });
    app = await openApp(scriptedModel());
    app.config.lastModel ??= { provider: "faux", modelId: "faux-1", thinkingLevel: "off" };
    const { createHandler } = await import("../src/server/http.ts");

    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    server.on("upgrade", (request, socket, head) => {
        if (!app.runners.upgrade(request, socket, head)) {
            socket.destroy();
        }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const { code } = app.runners.makeCode("Design computer", owner(app).id);
    const linked = app.runners.redeem(code);

    runner = new Runner({
        link: { server: base, ...linked },
        version: "test",
        cwd: there,
        log: () => {},
        retryMs: [50, 100],
        settings: () => ({ confirm: false, folders: [there] }),
        ask: () => Promise.resolve({ allow: true }),
    });
    runner.start();
    await until(() => app.runners.list()[0]?.online === true, "the design computer to connect");
    id = (await app.commands.createSession(owner(app), { cwd: there, runner: linked.id })).id;
    host = {
        dataDir: app.dataDir,
        runnerOf: app.runnerOf.bind(app),
        envFor: app.envFor.bind(app),
        fetchPublic: createPublicFetch(),
        notice: () => {},
    } as unknown as PocketHost;
    await createArtifacts(host).tools![0]!.execute(
        { id: "remote", title: "Remote design", content },
        api() as never,
        context,
    );
});

after(async () => {
    await runner?.stop();
    await app?.close();
    server?.closeAllConnections();
    await new Promise((resolve) => server?.close(resolve));
    cleanUp();
});

describe("design on a real runner", () => {
    it("writes a system back to the computer and sees the computer's next edit, including in the panel and prompt", async () => {
        await call("design_system", { action: "write", content: "# First from Pi" });
        assert.equal(readFileSync(join(there, ".pi/design-system.md"), "utf8"), "# First from Pi");
        writeFileSync(join(there, ".pi/design-system.md"), "# Changed on the computer");
        const next = await call("design_system", { action: "read" });

        assert.match(JSON.stringify(next), /Changed on the computer/);
        const panel = await request("system");

        assert.equal(panel.status, 200, await panel.clone().text());
        assert.deepEqual(await panel.json(), { system: null, legacy: 25 });
        const guide = await designGuide(host).render(
            { conversationId: id, agent: { cwd: there } } as never,
            context,
        );

        assert.match(guide ?? "", /Changed on the computer/);
        assert.doesNotMatch(guide ?? "", /Before you make or change a design, read \/home/);
    });

    it("refreshes structured tokens and copies a panel edit and compiled files to the computer", async () => {
        await call("design_system", {
            action: "init",
            name: "Remote",
            tokens: { color: { $type: "color", brand: { $value: "#123456" } } },
        });
        const file = join(there, ".pi/design/tokens.json");

        writeFileSync(file, readFileSync(file, "utf8").replace("#123456", "#abcdef"));
        const panel = await request("system");

        assert.equal(panel.status, 200, await panel.clone().text());
        assert.match(await panel.text(), /#abcdef/);
        const saved = await request("system", {
            set: [{ mode: "light", token: "color.brand", value: "#fedcba" }],
        });

        assert.equal(saved.status, 200, await saved.clone().text());
        assert.equal(((await saved.json()) as { ok: boolean }).ok, true);
        assert.match(readFileSync(file, "utf8"), /#fedcba/);
        assert.match(readFileSync(join(there, ".pi/design/dist/tokens.css"), "utf8"), /#fedcba/);
    });

    it("renders a preview with server Chromium and exports both from the tool and from the panel", async () => {
        const preview = await call("design_preview", { id: "remote", width: 390, height: 844 });

        assert.equal(preview.output?.filter((part) => part.type === "image").length, 2);
        const exported = await call("design_export", {
            id: "remote",
            format: "html",
            path: join(there, "exports/from-tool.zip"),
        });
        const details = exported.details as { path: string };

        assert.equal(details.path, join(there, "exports/from-tool.zip"));
        assert.equal(readFileSync(details.path).readUInt32LE(0), 0x04034b50);
        const panel = await request("export", { id: "remote", format: "html" });

        assert.equal(panel.status, 200, await panel.clone().text());
        const result = (await panel.json()) as { path: string };

        assert.equal(result.path, join(there, "exports/remote-v1.zip"));
        assert.ok(existsSync(result.path));
        const download = await fetch(`${base}/api/c/${id}/download?path=exports/remote-v1.zip`, {
            headers: { authorization: `Bearer ${app.config.ownerToken}` },
        });

        assert.equal(download.status, 200, await download.clone().text());
        assert.match(download.headers.get("content-disposition") ?? "", /remote-v1.zip/);
        assert.equal(Buffer.from(await download.arrayBuffer()).readUInt32LE(0), 0x04034b50);
        const escaped = await fetch(`${base}/api/c/${id}/download?path=../escape.zip`, {
            headers: { authorization: `Bearer ${app.config.ownerToken}` },
        });

        assert.equal(escaped.status, 400);
        assert.match(await escaped.text(), /inside the session folder/);
    });

    it("does not read the project's node_modules or follow a source link, and refuses escaped exports", async () => {
        mkdirSync(join(there, "node_modules/pkg"), { recursive: true });
        writeFileSync(join(there, "node_modules/pkg/styles.css"), ":root { --secret: red }");
        writeFileSync(join(there, "styles.css"), ":root { --brand: #123456 }");
        await symlink(join(root, "outside"), join(there, "link"));
        const scan = await call("design_system", { action: "scan" });

        assert.match(JSON.stringify(scan), /123456/);
        assert.equal(
            existsSync(join(app.dataDir, "design-mirrors", String(id), "node_modules")),
            false,
        );
        await assert.rejects(
            call("design_export", { id: "remote", format: "html", path: "../escape.zip" }),
            /inside the session folder/,
        );
        await symlink(root, join(there, "exports/escape"));
        await assert.rejects(
            call("design_export", { id: "remote", format: "html", path: "exports/escape/bad.zip" }),
            /symbolic links/,
        );
        assert.equal(existsSync(join(root, "bad.zip")), false);
    });

    it("fails offline rather than reading the same path on this server", async () => {
        await runner.stop();
        app.runners.remove(app.runnerOf(id)!);
        await assert.rejects(
            call("design_system", { action: "read" }),
            /computer|runner|removed|unavailable|offline/i,
        );
    });
});

describe("mirror bounds and copying", () => {
    it("copies only changes, drops remote deletions, writes back even after a failed call, and serializes a session", async () => {
        const dir = await mkdtemp(join(tmpdir(), "pocket-design-copy-"));
        const project = join(dir, "project");
        const env = new NodeExecutionEnv({ cwd: project });
        const fake = { dataDir: dir, runnerOf: () => "computer", envFor: () => env };
        const session = 1 as ConversationId;
        const run = (fn: (folder: string | undefined) => Promise<unknown>) =>
            withDesignMirror(fake, session, project, context, fn);

        try {
            await mkdir(join(project, ".pi/design"), { recursive: true });
            await writeFile(join(project, ".pi/design/tokens.json"), "one");
            await run(async () => {});
            const target = join(dir, "design-mirrors/1/.pi/design/tokens.json");
            const first = (await stat(target)).ctimeMs;

            await run(async () => {});
            assert.equal(
                (await stat(target)).ctimeMs,
                first,
                "an unchanged file is not copied twice",
            );
            await rm(join(project, ".pi/design/tokens.json"));
            await run(async (folder) =>
                assert.equal(existsSync(join(folder!, ".pi/design/tokens.json")), false),
            );
            await assert.rejects(
                run(async (folder) => {
                    await writeFile(join(folder!, "written.txt"), "still written");

                    throw new Error("intentional failure");
                }),
                /intentional failure/,
            );
            assert.equal(await readFile(join(project, "written.txt"), "utf8"), "still written");
            const sequence: number[] = [];

            await Promise.all([
                run(async () => {
                    sequence.push(1);
                    await new Promise((resolve) => setTimeout(resolve, 25));
                    sequence.push(2);
                }),
                run(async () => {
                    sequence.push(3);
                }),
            ]);
            assert.deepEqual(sequence, [1, 2, 3]);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it("rejects more than 200 MiB or 5000 files before copying bytes, and cleans an oversized result", async () => {
        const dir = await mkdtemp(join(tmpdir(), "pocket-design-bounds-"));
        const project = join(dir, "project");
        const env = new NodeExecutionEnv({ cwd: project });
        const fake = { dataDir: dir, runnerOf: () => "computer", envFor: () => env };
        const session = 2 as ConversationId;
        const run = (fn: (folder: string | undefined) => Promise<unknown> = async () => {}) =>
            withDesignMirror(fake, session, project, context, fn);

        try {
            await mkdir(join(project, ".pi/design"), { recursive: true });
            const big = join(project, ".pi/design/big.json");

            await writeFile(big, "");
            await truncate(big, MIRROR_BYTES + 1);
            await assert.rejects(run(), /200 MiB or 5000 files/);
            await rm(big);
            // The directory reader provides metadata only: no 5001 test files and no copied bytes.
            const real = env.openDirReader.bind(env);

            env.openDirReader = async (path, ctx) =>
                path.endsWith("/design")
                    ? ({
                          ok: true,
                          value: {
                              next: async () => ({
                                  ok: true,
                                  value: {
                                      entries: Array.from({ length: 5001 }, (_, i) => ({
                                          name: `${i}.json`,
                                          kind: "file" as const,
                                      })),
                                      done: true,
                                  },
                              }),
                              close: async () => {},
                          },
                      } as never)
                    : real(path, ctx);
            const info = env.fileInfo.bind(env);

            env.fileInfo = async (path, ctx) =>
                /\/\d+\.json$/.test(path)
                    ? ({ ok: true, value: { kind: "file", size: 0, mtimeMs: 0 } } as never)
                    : info(path, ctx);
            await assert.rejects(run(), /200 MiB or 5000 files/);
            env.openDirReader = real;
            env.fileInfo = info;
            await assert.rejects(
                run(async (folder) => {
                    const output = join(folder!, "large.zip");

                    await writeFile(output, "");
                    await truncate(output, MIRROR_BYTES + 1);
                }),
                /200 MiB or 5000 files/,
            );
            assert.equal(existsSync(join(dir, "design-mirrors/2")), false);
            assert.equal(existsSync(join(project, "large.zip")), false);
            const queued = await Promise.allSettled([
                run(async (folder) => {
                    const output = join(folder!, "large.zip");

                    await writeFile(output, "");
                    await truncate(output, MIRROR_BYTES + 1);
                }),
                run(async (folder) => {
                    await writeFile(join(folder!, "after-limit.txt"), "queue recovered");
                }),
            ]);

            assert.equal(queued[0]!.status, "rejected");
            assert.equal(queued[1]!.status, "fulfilled");
            assert.equal(
                await readFile(join(project, "after-limit.txt"), "utf8"),
                "queue recovered",
            );
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});
