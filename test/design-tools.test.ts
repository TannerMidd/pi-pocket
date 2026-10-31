// Agent tools use the same committed artifact versions as the viewer, scoped to the calling conversation.
import { cleanUp, context, newSession, openApp, scriptedModel, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import type { ConversationId, ToolRegistration } from "@earendil-works/pi-durable";
import { findBrowser } from "../src/server/browser/discovery.ts";
import { readBundle } from "../src/server/design/bundle.ts";
import { designRoutes, designTools } from "../src/server/design/index.ts";
import createArtifacts from "../src/server/extensions/artifacts.ts";
import type { ConversationWebRequest, ExtensionWeb, PocketHost } from "../src/server/host.ts";
import { createPublicFetch } from "../src/server/public-fetch.ts";

let app: Awaited<ReturnType<typeof openApp>>;
let conversation: ConversationId;
const host = { fetchPublic: createPublicFetch() } as PocketHost;
const content =
    '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><h1 data-pid="title">Design</h1>';

function api(id = conversation) {
    return {
        conversationId: id,
        taskId: 900,
        callId: "design-tool-test",
        agent: async () => ({ cwd: work }),
        snapshot: app.harness.snapshot.bind(app.harness),
        commit: app.harness.commit.bind(app.harness),
    };
}

async function call(tool: ToolRegistration, args: object) {
    return tool.execute(args, api() as never, context);
}

before(async () => {
    app = await openApp(scriptedModel());
    conversation = await newSession(app);
    await call(createArtifacts(host).tools![0]!, { id: "test", title: "Test", content });
});

after(async () => {
    await app.close();
    cleanUp();
});

test("the bundle reader reads the committed version and refuses missing, foreign, or non-HTML artifacts", async () => {
    const snapshot = app.harness.snapshot.bind(app.harness);
    const found = await readBundle(host, snapshot, conversation, "test", undefined, context);

    assert.equal(found.content, content);
    assert.equal(found.version, 1);
    await assert.rejects(
        readBundle(host, snapshot, conversation, "../test", undefined, context),
        /kebab/,
    );
    await assert.rejects(
        readBundle(host, snapshot, conversation, "test", 99, context),
        /does not exist/,
    );
    await assert.rejects(
        readBundle(host, snapshot, conversation, "test", NaN, context),
        /positive/,
    );
    const other = await newSession(app);

    await assert.rejects(
        readBundle(host, snapshot, other, "test", undefined, context),
        /does not exist/,
    );
});

test("the bundle reader returns the version's stored assets, byte for byte", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 255]);
    const { writeFile } = await import("node:fs/promises");

    await writeFile(`${work}/logo.png`, png);
    await call(createArtifacts(host).tools![0]!, {
        id: "assets",
        title: "Assets",
        content,
        assets: [
            { name: "img/logo.png", path: `${work}/logo.png` },
            { name: "css/site.css", content: "h1 { color: red; }" },
        ],
    });

    const snapshot = app.harness.snapshot.bind(app.harness);
    const found = await readBundle(host, snapshot, conversation, "assets", undefined, context);
    const byName = new Map(found.assets.map((asset) => [asset.name, asset]));

    assert.deepEqual([...byName.keys()].sort(), ["css/site.css", "img/logo.png"]);
    assert.deepEqual(byName.get("img/logo.png")!.bytes, png);
    assert.match(byName.get("img/logo.png")!.type, /^image\/png/);
    assert.equal(byName.get("css/site.css")!.bytes.toString(), "h1 { color: red; }");
});

test("design_export writes a real HTML bundle to the default session-local path", async () => {
    const tool = designTools(host).find((item) => item.name === "design_export")!;
    const result = await call(tool, { id: "test", format: "html" });
    const details = result.details as { path: string; version: number };
    const bytes = await readFile(details.path);

    assert.equal(details.path, `${work}/exports/test-v1.zip`);
    assert.equal(details.version, 1);
    assert.equal(bytes.readUInt32LE(0), 0x04034b50);
    await assert.rejects(
        call(tool, { id: "test", format: "html", path: "../escape.zip" }),
        /inside/,
    );
    await assert.rejects(
        tool.execute(
            { id: "test", format: "html" },
            { ...api(), agent: async () => ({}) } as never,
            context,
        ),
        /no working directory/,
    );
});

test("the workspace export writes the file in a visible session's folder and answers its path", async () => {
    let handler: ((request: ConversationWebRequest) => unknown) | undefined;
    let method: string | undefined;

    const route: ExtensionWeb["conversationRoute"] = (asked, _path, handle) => {
        method = asked;
        handler = handle;
    };

    designRoutes(
        {
            conversationRoute: route,
            error: (status: number, message: string) =>
                Object.assign(new Error(message), { status }),
        } as unknown as ExtensionWeb,
        host,
    );
    assert.equal(method, "POST");
    const request = {
        body: { id: "test", format: "html" },
        conversation: { id: conversation, cwd: work },
        snapshot: app.harness.snapshot.bind(app.harness),
        signal: new AbortController().signal,
        context,
    } as unknown as ConversationWebRequest;
    const answer = (await handler!(request)) as {
        path: string;
        relative: string;
        name: string;
        size: number;
    };

    assert.equal(answer.path, `${work}/exports/test-v1.zip`);
    assert.equal(answer.relative, "exports/test-v1.zip");
    assert.equal(answer.name, "test-v1.zip");
    const bytes = await readFile(answer.path);

    assert.equal(bytes.length, answer.size);
    assert.equal(bytes.readUInt32LE(0), 0x04034b50);
    await assert.rejects(
        async () =>
            handler!({
                ...request,
                body: { id: "test", format: "exe" },
            } as unknown as ConversationWebRequest),
        /Choose/,
    );
});

test(
    "design_preview returns screenshots from two private viewport renders",
    { skip: findBrowser() === undefined, timeout: 120_000 },
    async () => {
        const result = await call(
            designTools(host).find((item) => item.name === "design_preview")!,
            { id: "test" },
        );
        const images = result.output?.filter((item) => item.type === "image") ?? [];

        assert.equal(images.length, 2);
        assert.equal(images[0]!.mimeType, "image/png");
        assert.equal(Buffer.from(images[0]!.data, "base64").readUInt32BE(16), 390);
        assert.equal(Buffer.from(images[1]!.data, "base64").readUInt32BE(16), 1280);
        const details = result.details as { version: number; errors: string[] };

        assert.equal(details.version, 1);
        assert.deepEqual(details.errors, []);
    },
);
