// Artifacts and kept images across a real runner link. The server must not fall back to its disk for session files.
import {
    type App,
    cleanUp,
    context,
    lastText,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import {
    existsSync,
    ftruncateSync,
    mkdirSync,
    openSync,
    closeSync,
    readFileSync,
    readdirSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Runner } from "../src/runner/runner.ts";
import { createHandler } from "../src/server/http.ts";
import { MAX_ASSET_BYTES, MAX_BYTES } from "../src/server/extensions/artifacts.ts";
import { MAX_IMAGE_FILE } from "../src/server/http/assets.ts";
import { Workspace } from "../src/server/workspace.ts";

const there = join(root, "computer");
const outside = join(root, "server-only.png");
const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=",
    "base64",
);
const SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="120" height="60" fill="purple"/></svg>';
const PAGE =
    '<!doctype html><meta name="viewport" content="width=device-width"><h1>From the computer</h1><img src="assets/pixel.png">';
let app: App;
let runner: Runner;
let server: Server;
let base: string;
let id: ConversationId;
let readEntry: number;
let guestToken: string;

const route = (path: string, token = app.config.ownerToken, headers: Record<string, string> = {}) =>
    fetch(`${base}/api/c/${id}/${path}`, {
        headers: { authorization: `Bearer ${token}`, ...headers },
    });
const image = (path: string, token?: string) =>
    route(`file?path=${encodeURIComponent(path)}`, token);
const call = (name: string, args: object) => say(app, id, `call: ${name} ${JSON.stringify(args)}`);

async function lastResult(): Promise<string> {
    const view = await (await app.conversation(id)).context(context);

    return JSON.stringify(
        view.messages.findLast((message) => message.role === "toolResult")?.content,
    );
}

function sparse(path: string, size: number, head = Buffer.from("x")) {
    writeFileSync(path, head);
    const fd = openSync(path, "r+");

    try {
        ftruncateSync(fd, size);
    } finally {
        closeSync(fd);
    }
}

before(async () => {
    mkdirSync(there, { recursive: true });
    writeFileSync(join(there, "page.html"), PAGE);
    writeFileSync(join(there, "pixel.png"), PNG);
    writeFileSync(join(there, "fake.png"), "not an image");
    writeFileSync(outside, PNG);
    symlinkSync(outside, join(there, "escape.png"));
    sparse(join(there, "too-big.png"), MAX_IMAGE_FILE + 1, PNG);
    sparse(join(there, "too-big.html"), MAX_BYTES + 1);
    sparse(join(there, "too-big-asset.bin"), MAX_ASSET_BYTES + 1);
    app = await openApp(
        scriptedModel((input) => {
            const { role, text } = lastText(input as never);
            const request = /call: (\w+) ([\s\S]+)/.exec(text);

            if (role === "user" && request !== null) {
                return fauxAssistantMessage([fauxToolCall(request[1]!, JSON.parse(request[2]!))], {
                    stopReason: "toolUse",
                });
            }

            return fauxAssistantMessage([fauxText(`tool said: ${text}`)]);
        }),
    );
    app.config.lastModel = { provider: "faux", modelId: "faux-vision", thinkingLevel: "off" };
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    server.on("upgrade", (request, socket, head) => {
        if (!app.runners.upgrade(request, socket, head)) {
            socket.destroy();
        }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const { code } = app.runners.makeCode("Image computer", owner(app).id);
    const linked = app.runners.redeem(code);

    runner = new Runner({
        link: { server: base, ...linked },
        version: "test",
        cwd: there,
        log: () => {},
        retryMs: [50],
        settings: () => ({ confirm: false, folders: [there] }),
        ask: () => Promise.resolve({ allow: false }),
    });
    runner.start();
    await until(() => app.runners.list()[0]?.online === true, "the image runner to connect");
    id = (await app.commands.createSession(owner(app), { cwd: there, runner: linked.id })).id;
    const guest = app.config.addUser("Image guest", "guest");

    guestToken = guest.token;
    await app.setSharedRunnerSessions(owner(app), true);
});

after(async () => {
    await runner?.stop();
    await app?.close();
    server?.closeAllConnections();
    await new Promise((resolve) => server?.close(resolve));
    cleanUp();
});

describe("files from a session's computer", () => {
    it("publishes a file with a binary asset through the real runner, as a server-owned snapshot", async () => {
        await call("artifact", {
            id: "computer-page",
            title: "Computer page",
            path: "page.html",
            assets: [{ name: "assets/pixel.png", path: "pixel.png" }],
        });
        const bundle = await app.artifactBundle(id, "computer-page");

        assert.equal(bundle.content, PAGE);
        assert.equal(bundle.assets[0]!.type, "image/png");
        assert.deepEqual(bundle.assets[0]!.bytes, PNG);
    });

    it("bounds file and asset reads and never reads a forbidden server file or a final symlink", async () => {
        for (const args of [
            { path: "too-big.html" },
            { content: "small", assets: [{ name: "large.bin", path: "too-big-asset.bin" }] },
        ]) {
            await call("artifact", { id: "too-big", title: "Too big", ...args });
            assert.match(await lastResult(), /Files are limited to/);
        }

        for (const args of [
            { path: outside, type: "html" },
            { content: "small", assets: [{ name: "secret.png", path: outside }] },
            { content: "small", assets: [{ name: "secret.png", path: "escape.png" }] },
        ]) {
            await call("artifact", { id: "not-allowed", title: "Not allowed", ...args });
            assert.match(
                await lastResult(),
                /outside the session's approved folder|symbolic link|symlink/i,
            );
        }
    });

    it("does not implicitly read design files on the server for a remote session", async () => {
        await call("artifact", {
            id: "design-links",
            title: "Design links",
            content: '<link rel="stylesheet" href="ds/tokens.css">',
        });
        assert.match(await lastResult(), /Automatic design-system loading is not available/);
        assert.deepEqual((await app.artifactBundle(id, "design-links")).assets, []);
    });

    it("serves answer paths, image links, and file-viewer images through a checked copy", async () => {
        const response = await image("pixel.png");

        assert.equal(response.status, 200);
        assert.equal(response.headers.get("content-type"), "image/png");
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), PNG);
        const copy = await app.workspace.imageFile(owner(app), id, join(there, "pixel.png"));

        assert.ok(copy.file.startsWith(join(app.dataDir, "uploads", String(id), "runner")));
        assert.deepEqual(readFileSync(copy.file), PNG);
        assert.equal((await route("view?path=pixel.png")).status, 200);
        assert.equal((await (await route("view?path=pixel.png")).json()).kind, "image");
        const again = await route("file?path=pixel.png", undefined, {
            "if-none-match": response.headers.get("etag")!,
        });

        assert.equal(again.status, 304);
        assert.equal((await image("pixel.png", guestToken)).status, 200);
        assert.equal((await image("fake.png")).status, 415);
        assert.equal((await image("page.html")).status, 415);
        assert.equal((await image("too-big.png")).status, 413);
        assert.equal((await image(outside)).status, 404);
        assert.equal((await image("escape.png")).status, 404);
    });

    it("keeps write and edit results before the first HTTP image request", async () => {
        await call("write", { path: "written.svg", content: SVG });
        const directory = join(app.dataDir, "uploads", String(id), "runner");
        const copies = () => readdirSync(directory).filter((name) => name.endsWith(".svg"));

        assert.equal(copies().length, 1);
        assert.equal(readFileSync(join(directory, copies()[0]!), "utf8"), SVG);
        await call("edit", {
            path: "written.svg",
            edits: [{ oldText: "purple", newText: "orange" }],
        });
        assert.equal(copies().length, 2);
        assert.ok(
            copies().some((name) => readFileSync(join(directory, name), "utf8").includes("orange")),
        );
        assert.ok(existsSync(join(there, "written.svg")));
    });

    it("stores the read tool's returned image in the transcript, separate from path images", async () => {
        await call("read", { path: "pixel.png" });
        const entries = await (await app.conversation(id)).entries({}, 256, undefined, context);
        const result = entries.items.findLast(
            (entry) =>
                entry.kind === "pi.tool-result" &&
                JSON.stringify(entry.model).includes('"type":"image"'),
        )!;

        assert.ok(result);
        readEntry = result.id as unknown as number;
        const response = await route(`image/${readEntry}/0`);

        assert.equal(response.status, 200);
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), PNG);
    });

    it("serves copies, tool images, the viewer, and artifact assets while the runner is offline, also in a new Workspace", async () => {
        await runner.stop();
        await until(() => app.runners.list()[0]?.online === false, "the image runner to stop");
        writeFileSync(join(there, "pixel.png"), "offline files are not server files");
        writeFileSync(join(there, "written.svg"), "offline files are not server files");

        for (const token of [app.config.ownerToken, guestToken]) {
            const response = await image("pixel.png", token);

            assert.equal(response.status, 200);
            assert.deepEqual(Buffer.from(await response.arrayBuffer()), PNG);
            assert.equal((await route("view?path=pixel.png", token)).status, 200);
        }

        const saved = await (await image("written.svg")).text();

        assert.ok(
            saved.includes("orange"),
            "the last edit was copied before the first image request",
        );
        assert.equal((await route(`image/${readEntry}/0`)).status, 200);
        assert.deepEqual(
            (await app.artifactAsset(id, "computer-page", 1, "assets/pixel.png")).bytes,
            PNG,
        );
        const restored = await new Workspace(app).imageFile(owner(app), id, "pixel.png");

        assert.deepEqual(readFileSync(restored.file), PNG);
        assert.equal((await image("never-seen.png")).status, 409);
    });
});
