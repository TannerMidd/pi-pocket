// End-to-end tests of the server core with a scripted model: no network, no API keys, no Pi config.
import {
    type App,
    cleanUp,
    context,
    fakeTab,
    lastText,
    modelTexts,
    openApp,
    owner as ownerOf,
    root,
    say as sayTo,
    scriptedModel,
    newSession as startSession,
    until,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { after, before, mock, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import {
    fauxAssistantMessage,
    fauxText,
    fauxThinking,
    fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { type ConversationId, InboxDoc, LiveDoc, type Storage } from "@earendil-works/pi-durable";
import type { Attachment } from "../src/server/commands.ts";
import { TurnsDoc } from "../src/server/docs.ts";
import type { Interrupt } from "../src/server/resend.ts";
import createArtifacts from "../src/server/extensions/artifacts.ts";
import type { PocketHost } from "../src/server/host.ts";

/** The provider session id each request carried, with the message it answered. */
const requests: { sessionId: string | undefined; text: string }[] = [];

/** One scripted model for every conversation, answering by the last message, like a tiny real model. */
const route: FauxResponseStep = (context, options) => {
    const { role, text } = lastText(context as never);

    requests.push({ sessionId: (options as { sessionId?: string } | undefined)?.sessionId, text });
    const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
        fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

    if (role === "toolResult") {
        return fauxAssistantMessage([fauxText(`tool said: ${text}`)]);
    }

    if (text.includes("make an artifact")) {
        return call("artifact", { id: "Demo Page", title: "Demo", content: "<h1>one</h1>" });
    }

    if (text.includes("write a markdown artifact")) {
        return call("artifact", {
            id: "notes",
            title: "Notes",
            type: "markdown",
            content: "# Notes\n\nSome **text**.",
        });
    }

    if (text.includes("fix the artifact")) {
        return call("artifact", {
            id: "demo-page",
            title: "Demo",
            edits: [{ oldText: "one", newText: "two" }],
        });
    }

    if (text.includes("start a helper")) {
        return call("subagent", { action: "spawn", name: "helper", message: "say hi please" });
    }

    if (text.includes("run a script")) {
        return call("codemode", {
            code: 'for (const body of ["<p>one</p>", "<p>two</p>"]) await tools.artifact({ id: "notes", title: "Notes", content: body });\nreturn await tools.read({ path: "hello.txt" });',
        });
    }

    if (text.includes("say hi please")) {
        return fauxAssistantMessage([fauxText("hi from helper")]);
    }

    // A long thought and a large file: what a view's first part leaves out.
    if (text.includes("think and write a big file")) {
        return fauxAssistantMessage(
            [
                fauxThinking("pondering ".repeat(200)),
                fauxToolCall("write", { path: "big.txt", content: "line\n".repeat(400) }),
            ],
            { stopReason: "toolUse" },
        );
    }

    // About 5 s of streaming at the scripted model's 2000 tokens a second.
    if (text.includes("stream a long answer")) {
        return fauxAssistantMessage([fauxText("word ".repeat(8000))]);
    }

    if (text.startsWith("[subagent helper answered")) {
        return fauxAssistantMessage([fauxText("noted")]);
    }

    return fauxAssistantMessage([fauxText(`echo: ${text}`)]);
};

const faux = scriptedModel(route);

let app: App;
const open = () => openApp(faux);
const owner = () => ownerOf(app);
const newSession = () => startSession(app);
const say = (id: ConversationId, text: string, attachments?: Attachment[]) =>
    sayTo(app, id, text, attachments);

before(async () => {
    app = await open();
});

after(async () => {
    await app?.close();
    cleanUp();
});

test("the artifact tool publishes versions, edits the latest, and serves the body", async () => {
    const id = await newSession();

    await say(id, "please make an artifact");
    const first = await app.artifactBody(id, "demo-page", undefined);

    assert.equal(first.version, 1);
    assert.equal(first.content, "<h1>one</h1>");
    await say(id, "now fix the artifact");
    const second = await app.artifactBody(id, "demo-page", undefined);

    assert.equal(second.version, 2);
    assert.equal(second.content, "<h1>two</h1>");
    assert.equal((await app.artifactBody(id, "demo-page", 1)).content, "<h1>one</h1>");
});

/** Real document commits, with a fixed tool-call identity so the test can replay the same call. */
async function artifactCall() {
    const id = await newSession();
    const tool = createArtifacts({} as PocketHost).tools![0]!;
    const api = {
        conversationId: id,
        taskId: 987_654,
        callId: "publish-file",
        agent: async () => ({ cwd: work }),
        snapshot: app.harness.snapshot.bind(app.harness),
        commit: app.harness.commit.bind(app.harness),
    };
    const publish = (args: Record<string, unknown>) =>
        tool.execute(
            { id: "from-file", title: "From file", ...args } as never,
            api as never,
            context,
        );

    return { id, api, publish };
}

test("artifact paths snapshot UTF-8 bytes and replay without rereading the source", async () => {
    const { id, api, publish } = await artifactCall();
    const path = join(work, "artifact-source.md");
    const content = "# Café\n";

    writeFileSync(path, content);
    await publish({ path: "artifact-source.md" });
    writeFileSync(path, "changed");
    await publish({ path: "artifact-source.md" });
    unlinkSync(path);
    await publish({ path: "artifact-source.md" });
    const first = await app.artifactBody(id, "from-file", 1);

    assert.equal(first.content, content);
    assert.equal(first.meta.type, "markdown");
    assert.equal(first.meta.versions.length, 1);
    assert.equal(first.meta.versions[0]!.size, Buffer.byteLength(content));
    api.callId = "publish-next";
    const next = join(work, "artifact-next.html");

    writeFileSync(next, "# Next");
    await assert.rejects(publish({ path: next, type: "html" }), /cannot change/);
    await publish({ path: next });
    const latest = await app.artifactBody(id, "from-file", undefined);

    assert.equal(latest.version, 2);
    assert.equal(latest.meta.type, "markdown");
    assert.equal((await app.artifactBody(id, "from-file", 1)).content, content);
});

test("artifact paths reject oversized and nonregular files instead of publishing a partial body", async () => {
    const { id, publish } = await artifactCall();
    const path = join(work, "artifact-large.html");

    writeFileSync(path, Buffer.alloc(2_000_001, 120));
    await assert.rejects(publish({ path }), /limited to 2000000 bytes/);
    writeFileSync(path, Buffer.from([0xc3, 0x28]));
    await assert.rejects(publish({ path }), /UTF-8 text/);
    await assert.rejects(publish({ path: work, type: "html" }), /regular file/);
    await assert.rejects(app.artifactBody(id, "from-file", undefined), /No such artifact/);
});

test("the page that runs a reply's HTML is for people signed in, sandboxed, and runs only what the app sends it", async () => {
    const { createServer } = await import("node:http");
    const { createHandler } = await import("../src/server/http.ts");
    const server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const url = `http://127.0.0.1:${port}/a/frame`;

    try {
        assert.equal((await fetch(url)).status, 401);
        const response = await fetch(url, {
            headers: { authorization: `Bearer ${app.config.ownerToken}` },
        });
        const body = await response.text();

        assert.equal(response.status, 200);
        assert.match(response.headers.get("content-type") ?? "", /^text\/html/);
        // An opaque origin even when opened in a tab of its own: no cookies, no app.
        assert.match(
            response.headers.get("content-security-policy") ?? "",
            /^sandbox allow-scripts /,
        );
        assert.doesNotMatch(
            response.headers.get("content-security-policy") ?? "",
            /allow-same-origin/,
        );
        assert.ok(body.includes('self.origin !== "null"'), "it runs nothing outside a sandbox");
        assert.ok(
            body.includes("event.source !== bridge.realParent"),
            "it takes HTML from its parent only",
        );
        assert.ok(
            body.includes("event.origin !== location.origin"),
            "a parent at the app's address",
        );
    } finally {
        server.closeAllConnections();
        server.close();
    }
});

test("a Markdown artifact's viewer colors cannot inject anything into its page", async () => {
    const { createServer } = await import("node:http");
    const { createHandler } = await import("../src/server/http.ts");
    const server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    const id = await newSession();

    await say(id, "please write a markdown artifact");
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;

    const page = async (artifact: string, query = "") => {
        const response = await fetch(
            `http://127.0.0.1:${port}/a/${id}/${artifact}/latest${query}`,
            {
                headers: { authorization: `Bearer ${app.config.ownerToken}` },
            },
        );

        assert.equal(response.status, 200);

        return response.text();
    };

    const style = (body: string) => /<style>(.*)<\/style>/s.exec(body)?.[1] ?? "";

    try {
        const plain = style(await page("notes"));

        // Only hex colors get in; without a good background and foreground, the page keeps the browser's look.
        const tricked = await page(
            "notes",
            `?mode=light&bg=${encodeURIComponent("fff}body{display:none")}&fg=${encodeURIComponent("</style><script>alert(1)</script>")}`,
        );

        assert.equal(style(tricked), plain);
        assert.doesNotMatch(tricked, /display:none|alert\(1\)/);
    } finally {
        server.closeAllConnections();
        server.close();
    }
});

test("each conversation sends its own provider session id, the same on every request and after a reopen", async () => {
    const first = await newSession();
    const second = await newSession();
    const sent = (text: string) => requests.findLast((request) => request.text === text)?.sessionId;

    await say(first, "session id one");
    await say(first, "session id two");
    await say(second, "session id three");
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

    assert.match(sent("session id one") ?? "", uuid, "OpenCode refuses requests without one");
    assert.equal(sent("session id two"), sent("session id one"));
    assert.notEqual(sent("session id three"), sent("session id one"));
    await app.close();
    app = await open();
    await say(first, "session id four");
    assert.equal(sent("session id four"), sent("session id one"));
});

test("a sign-in that needs this installation's id gets Pi's, the same every time", async () => {
    const calls: unknown[][] = [];
    const login = app.models.login;

    app.models.login = (async (...args: unknown[]) => {
        calls.push(args);

        return {} as never;
    }) as typeof login;

    try {
        app.providers.startLogin(owner(), "openai-chatgpt", "oauth");
        app.providers.startLogin(owner(), "openai-chatgpt", "oauth");
        await until(() => calls.length === 2, "both sign-ins to start");
        const ids = calls.map((args) =>
            (args[3] as { getDeviceId?: () => string } | undefined)?.getDeviceId?.(),
        );

        assert.match(
            ids[0] ?? "",
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        );
        assert.equal(ids[1], ids[0]);
        const { readFileSync } = await import("node:fs");

        assert.equal(
            JSON.parse(
                readFileSync(join(process.env.PI_CODING_AGENT_DIR!, "settings.json"), "utf8"),
            ).deviceId,
            ids[0],
            "kept in Pi's settings",
        );
    } finally {
        app.models.login = login;
    }
});

test("a script's nested calls each do their own work", async () => {
    writeFileSync(join(work, "hello.txt"), "hello from a file\n");
    const id = await newSession();

    await say(id, "please run a script");
    assert.equal((await app.artifactBody(id, "notes", 1)).content, "<p>one</p>");
    assert.equal(
        (await app.artifactBody(id, "notes", undefined)).version,
        2,
        "the second nested artifact call made its own version",
    );
});

test("a pasted image is stored with its message and read back", async () => {
    const id = await newSession();

    await app.commands.configure(id, owner(), {
        model: { provider: "faux", modelId: "faux-vision" },
    });
    const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        "base64",
    );
    const path = join(app.workspace.uploadDirectory(id), "dot.png");

    writeFileSync(path, png);
    await say(id, "look at this", [{ path, name: "dot.png", mime: "image/png", size: png.length }]);
    const { BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");
    const conversation = (await app.harness.conversation(id, BACKGROUND_CONTEXT))!;
    const entries = await conversation.entries({}, 256, undefined, BACKGROUND_CONTEXT);
    const user = entries.items.find((entry) => entry.kind === "pi.user")!;
    const image = await app.transcripts.entryImage(id, user.id as unknown as number, 0);

    assert.equal(image?.mimeType, "image/png");
    assert.deepEqual(image?.data, png);
    assert.equal(
        await app.transcripts.entryImage(
            (Number(id) + 1000) as unknown as ConversationId,
            user.id as unknown as number,
            0,
        ),
        undefined,
    );
});

/** A grey PNG, `width` by `height`. */
function greyPng(width: number, height: number): Buffer {
    const chunk = (type: string, data: Buffer) => {
        const body = Buffer.concat([Buffer.from(type), data]);
        const frame = Buffer.alloc(8);

        frame.writeUInt32BE(data.length, 0);
        frame.writeUInt32BE(crc32(body), 4);

        return Buffer.concat([frame.subarray(0, 4), body, frame.subarray(4)]);
    };

    const header = Buffer.alloc(13);

    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header.set([8, 2], 8);
    const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x80)]);

    return Buffer.concat([
        Buffer.from("89504e470d0a1a0a", "hex"),
        chunk("IHDR", header),
        chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))),
        chunk("IEND", Buffer.alloc(0)),
    ]);
}

test("a big pasted image goes to the model at most 2000 pixels a side", async () => {
    const id = await newSession();

    await app.commands.configure(id, owner(), {
        model: { provider: "faux", modelId: "faux-vision" },
    });
    const png = greyPng(10, 3000);
    const path = join(app.workspace.uploadDirectory(id), "tall.png");

    writeFileSync(path, png);
    await say(id, "how tall?", [{ path, name: "tall.png", mime: "image/png", size: png.length }]);
    const { BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");
    const conversation = (await app.harness.conversation(id, BACKGROUND_CONTEXT))!;
    const entries = await conversation.entries({}, 256, undefined, BACKGROUND_CONTEXT);
    const user = entries.items.find((entry) => entry.kind === "pi.user")!;
    const image = (await app.transcripts.entryImage(id, user.id as unknown as number, 0))!;

    assert.equal(image.mimeType, "image/png");
    assert.equal(image.data.readUInt32BE(20), 2000, "its height, from the PNG header");
});

test("long polling delivers the stream's events, resends until acknowledged, and waits for new ones", async () => {
    const { createServer } = await import("node:http");
    const { createHandler } = await import("../src/server/http.ts");
    const server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;

    type Poll = {
        session: string;
        events: { seq: number; event: string; data: Record<string, unknown> }[];
    };
    const poll = async (query: string): Promise<Poll> =>
        (
            await fetch(`http://127.0.0.1:${port}/api/poll?${query}`, {
                headers: { authorization: `Bearer ${app.config.ownerToken}` },
            })
        ).json() as Promise<Poll>;

    try {
        const id = await newSession();
        const first = await poll(`tab=t1&c=${id}`);

        assert.deepEqual(
            first.events.slice(0, 2).map((each) => each.event),
            ["hello", "sessions"],
        );
        assert.ok(first.events.some((each) => each.event === "view" && each.data.full === true));
        // Without an acknowledgement, the same events come again (a debounced update may follow them).
        const again = await poll(`tab=t1&c=${id}&session=${first.session}&ack=0`);

        assert.deepEqual(
            again.events.slice(0, first.events.length).map((each) => each.seq),
            first.events.map((each) => each.seq),
        );
        let ack = first.events.at(-1)!.seq;
        const sent = say(id, "hello by polling");
        let seen = false;

        for (let round = 0; round < 20 && !seen; round++) {
            const next = await poll(`tab=t1&c=${id}&session=${first.session}&ack=${ack}`);

            assert.equal(next.session, first.session);
            assert.ok(next.events.every((each) => each.seq > ack));

            for (const each of next.events) {
                ack = each.seq;
                const entries = (each.data.entries ?? []) as { kind: string; text?: string }[];

                if (
                    each.event === "view" &&
                    entries.some(
                        (entry) => entry.kind === "user" && entry.text === "hello by polling",
                    )
                ) {
                    seen = true;
                }
            }
        }

        await sent;
        assert.ok(seen, "the new message arrived by polling");
        await poll(`session=${first.session}&close=1`);
        const fresh = await poll(`tab=t1&c=${id}&session=${first.session}&ack=${ack}`);

        assert.notEqual(fresh.session, first.session, "a closed session starts over");
        await poll(`session=${fresh.session}&close=1`);
    } finally {
        server.closeAllConnections();
        server.close();
    }
});

test("the owner turns extensions off and on, the guard follows its switch, and the choice survives a restart", async () => {
    const module = (file: string) => app.loader.list().find((each) => each.file === file)!;

    // Lancet Guard is off until the owner turns it on.
    assert.equal(module("guard.ts").enabled, false);
    assert.ok(!app.loader.extensionNames().includes("pocket-guard"));
    await app.setExtensionEnabled(owner(), "guard.ts", true);
    assert.ok(app.loader.extensionNames().includes("pocket-guard"));

    await app.setExtensionEnabled(owner(), "subagents.ts", false);
    assert.equal(module("subagents.ts").enabled, false);
    assert.deepEqual(module("subagents.ts").extensions, []);
    assert.ok(!app.loader.extensionNames().includes("pocket-subagents"));

    await app.setExtensionEnabled(owner(), "guard.ts", false);
    assert.equal((await app.guardStatus()).enabled, false);

    await app.close();
    app = await open();
    assert.equal(module("subagents.ts").enabled, false);
    assert.ok(!app.loader.extensionNames().includes("pocket-subagents"));
    assert.equal(module("guard.ts").enabled, false);

    await app.setExtensionEnabled(owner(), "subagents.ts", true);
    await app.setExtensionEnabled(owner(), "guard.ts", true);
    assert.deepEqual(module("subagents.ts").extensions[0]?.tools, ["subagent"]);
    assert.ok(app.loader.extensionNames().includes("pocket-guard"));

    // Turned on, it stays on after a restart.
    await app.close();
    app = await open();
    assert.equal(module("guard.ts").enabled, true);
    assert.ok(app.loader.extensionNames().includes("pocket-guard"));
});

test("everyone signed in gets the desktop's theme colors; only the owner gets its wallpaper", async () => {
    const { createServer } = await import("node:http");
    const { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { createHandler } = await import("../src/server/http.ts");
    const home = mkdtempSync(join(tmpdir(), "pocket-desktop-"));
    const current = join(home, ".local/state/omarchy/current");

    mkdirSync(join(current, "theme"), { recursive: true });
    writeFileSync(
        join(current, "theme", "colors.toml"),
        'background = "#111111"\nforeground = "#eeeeee"\n',
    );
    writeFileSync(join(current, "theme.name"), "gruvbox\n");
    // A real PNG header, so the image check accepts it.
    writeFileSync(
        join(current, "theme", "wall.png"),
        Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"),
    );
    let hasWallpaper = true;

    try {
        symlinkSync(join(current, "theme", "wall.png"), join(current, "background"), "file");
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;

        if (process.platform !== "win32" || (code !== "EPERM" && code !== "EACCES")) {
            throw error;
        }

        hasWallpaper = false;
    }

    const server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const guest = app.config.addUser("Guest", "guest");
    const call = (token: string, path: string) =>
        fetch(`http://127.0.0.1:${port}/api/${path}`, {
            headers: { authorization: `Bearer ${token}` },
        });
    const realHome = process.env.HOME;
    const realUserProfile = process.env.USERPROFILE;

    process.env.HOME = home;
    process.env.USERPROFILE = home;

    try {
        type Theme = { theme: { name: string; wallpaper: boolean; stamp: string } };
        const owner = (await (await call(app.config.ownerToken, "theme")).json()) as Theme;

        assert.equal(owner.theme.name, "gruvbox");
        assert.equal(owner.theme.wallpaper, hasWallpaper);
        assert.ok(!owner.theme.stamp.includes(home), "the stamp names no paths");
        const theirs = (await (await call(guest.token, "theme")).json()) as Theme;

        assert.equal(theirs.theme.name, "gruvbox");
        assert.equal(theirs.theme.wallpaper, false);
        assert.equal((await call(guest.token, "theme/wallpaper")).status, 403);
        assert.equal(
            (await call(app.config.ownerToken, "theme/wallpaper")).status,
            hasWallpaper ? 200 : 404,
        );
    } finally {
        if (realHome === undefined) {
            delete process.env.HOME;
        } else {
            process.env.HOME = realHome;
        }

        if (realUserProfile === undefined) {
            delete process.env.USERPROFILE;
        } else {
            process.env.USERPROFILE = realUserProfile;
        }

        app.config.removeUser(guest.user.id);
        server.closeAllConnections();
        server.close();
    }
});

test("anyone signed in can list extensions; only the owner can change them", async () => {
    const { createServer } = await import("node:http");
    const { createHandler } = await import("../src/server/http.ts");
    const server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const guest = app.config.addUser("Guest", "guest");
    const call = (token: string, path: string, body?: unknown) =>
        fetch(`http://127.0.0.1:${port}/api/${path}`, {
            method: body === undefined ? "GET" : "POST",
            headers: {
                authorization: `Bearer ${token}`,
                "x-pocket": "1",
                "content-type": "application/json",
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });

    try {
        assert.equal((await call(guest.token, "extensions")).status, 200);
        assert.equal(
            (await call(guest.token, "extensions/guard.ts", { enabled: false })).status,
            403,
        );
        assert.equal((await call(guest.token, "extensions/guard.ts/reload", {})).status, 403);
        assert.equal(
            (await call(app.config.ownerToken, "extensions/guard.ts", { enabled: true })).status,
            200,
        );
        assert.equal(
            (await call(app.config.ownerToken, "extensions/guard.ts/reload", {})).status,
            200,
        );
    } finally {
        app.config.removeUser(guest.user.id);
        server.closeAllConnections();
        server.close();
    }
});

test("people chat beside Pi: presence, one post per request, and the chat survives a reopen", async () => {
    const id = await newSession();
    const guest = app.config.addUser("Alex", "guest");

    type Event = { event: string; data: Record<string, unknown> };
    const tab = (name: string, user: (typeof guest)["user"], events: Event[]) => ({
        id: name,
        connection: name,
        user,
        conversationId: id,
        sentEntries: new Set<number>(),
        orderKey: "",
        send: (event: string, data: unknown) =>
            events.push({ event, data: data as Record<string, unknown> }),
    });
    const mine: Event[] = [];
    const ownerTab = tab("tab-owner", owner(), mine);
    const guestTab = tab("tab-guest", guest.user, []);

    type People = { name: string }[];
    const people = () =>
        (mine.findLast((each) => each.event === "presence")?.data.people ?? []) as People;

    try {
        await app.attach(ownerTab);
        assert.deepEqual(mine.find((each) => each.event === "chat")?.data, {
            conversationId: id,
            full: true,
            messages: [],
        });
        await app.attach(guestTab);
        assert.deepEqual(
            people()
                .map((each) => each.name)
                .sort(),
            ["Alex", owner().name].sort(),
        );

        const posted = await app.collab.postChat(id, guest.user, {
            text: "  hi team  ",
            requestId: "r1",
        });

        assert.equal(
            (await app.collab.postChat(id, guest.user, { text: "hi team", requestId: "r1" })).id,
            posted.id,
            "a retry does not post twice",
        );
        await until(
            () =>
                mine.some(
                    (each) =>
                        each.event === "chat" &&
                        (each.data.messages as { id: string }[]).some(
                            (message) => message.id === posted.id,
                        ),
                ),
            "the message to reach the other tab",
        );

        app.detach(guestTab);
        await until(() => people().length === 1, "Alex to leave");
    } finally {
        app.detach(ownerTab);
        app.detach(guestTab);
        app.config.removeUser(guest.user.id);
    }

    await app.close();
    app = await open();
    const { BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");
    const { ChatDoc } = await import("../src/server/docs.ts");
    const stored = await app.harness.snapshot(ChatDoc, id, BACKGROUND_CONTEXT);

    assert.deepEqual(
        stored?.messages.map((message) => [message.name, message.text]),
        [["Alex", "hi team"]],
    );
});

/** A fake browser tab attached to a conversation, recording what the server sends it. */
test("viewers read and chat but never steer; people invited to one session see only that session", async () => {
    const id = await newSession();
    const other = await newSession();
    const viewer = app.config.addUser("Vee", "viewer").user;
    const scoped = app.config.addUser("Sam", "guest", [String(id)]).user;

    try {
        await assert.rejects(
            app.commands.submit(id, viewer, { text: "hi", requestId: "v1" }),
            /not steer/,
        );
        await assert.rejects(app.commands.abort(id, viewer), /not steer/);
        await assert.rejects(app.commands.createSession(viewer, { cwd: work }), /not steer/);
        await assert.rejects(app.answerApproval("nope", true, viewer), /not steer/);
        assert.equal(
            (await app.collab.postChat(id, viewer, { text: "just watching", requestId: "v2" }))
                .text,
            "just watching",
        );

        assert.deepEqual(
            app.sessions(scoped).map((each) => each.id),
            [Number(id)],
        );
        assert.ok(app.sessions(owner()).length >= 2);
        await assert.rejects(
            app.commands.submit(other, scoped, { text: "hi", requestId: "s1" }),
            /not shared/,
        );
        await assert.rejects(app.commands.createSession(scoped, { cwd: work }), /one session/);
        // Nor move it elsewhere: what they may read is its folder.
        await assert.rejects(
            app.commands.configure(id, scoped, { cwd: "/etc" }),
            /cannot move it to another folder/,
        );
        assert.equal(app.cwdOf(id), work);
        const tab = fakeTab(other, scoped);

        await app.attach(tab.client);
        assert.match(String(tab.last("missing")?.message), /not shared/);
        app.detach(tab.client);

        // The owner widens Sam's access and makes Vee a guest.
        app.setAccess(owner(), scoped.id, { sessions: null });
        assert.equal(app.config.userById(scoped.id)?.sessions, undefined);
        app.setAccess(owner(), viewer.id, { role: "guest" });
        assert.equal(app.config.userById(viewer.id)?.role, "guest");
        assert.throws(() => app.setAccess(viewer, scoped.id, { role: "viewer" }), /owner/);
        assert.throws(
            () => app.setAccess(owner(), owner().id, { role: "viewer" }),
            /owner can do everything/,
        );
    } finally {
        app.config.removeUser(viewer.id);
        app.config.removeUser(scoped.id);
    }
});

test("take turns: only the driver steers, others ask, the driver hands over", async () => {
    const id = await newSession();
    const alex = app.config.addUser("Alex", "guest").user;
    const ownerTab = fakeTab(id, owner());
    const alexTab = fakeTab(id, alex);

    try {
        await app.attach(ownerTab.client);
        await app.attach(alexTab.client);
        await app.collab.turns(id, owner(), { action: "on" });
        await assert.rejects(
            app.commands.submit(id, alex, { text: "my turn?", requestId: "t1" }),
            /is driving/,
        );
        await assert.rejects(app.collab.turns(id, alex, { action: "claim" }), /is driving/);
        await app.collab.turns(id, alex, { action: "ask" });
        await until(
            () =>
                (alexTab.field("turns") as { asks?: string[] } | undefined)?.asks?.includes(
                    alex.id,
                ) === true,
            "the ask to show",
        );
        await app.collab.turns(id, owner(), { action: "handover", to: alex.id });
        await until(
            () => (ownerTab.field("turns") as { driver?: string } | undefined)?.driver === alex.id,
            "Alex to drive",
        );
        await assert.rejects(
            app.commands.submit(id, owner(), { text: "me again", requestId: "t2" }),
            /Alex is driving/,
        );
        await app.commands.submit(id, alex, { text: "hello from the driver", requestId: "t3" });
    } finally {
        app.detach(ownerTab.client);
        app.detach(alexTab.client);
        app.config.removeUser(alex.id);
    }
});

test("a tab gets the queue when it changes, not with each update of a turn, and only the start of each message", async () => {
    const { BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");
    const id = await newSession();
    const tab = fakeTab(id, owner());
    const late = fakeTab(id, owner());

    type Row = { text?: string };
    const queue = (of = tab) => (of.field("inbox") ?? []) as Row[];
    const views = () => tab.events.flatMap((each) => (each.event === "view" ? [each.data] : []));
    const streaming = () =>
        (tab.last("view")?.live as { generation?: unknown } | undefined)?.generation !== undefined;

    await app.attach(tab.client);

    try {
        const conversation = (await app.harness.conversation(id, BACKGROUND_CONTEXT))!;

        await app.commands.submit(id, owner(), {
            text: "stream a long answer",
            requestId: crypto.randomUUID(),
        });
        await until(streaming, "the answer to stream");
        // While it streams: a long paste and a picture.
        await app.commands.submit(id, owner(), {
            text: `paste: ${"x".repeat(200_000)}`,
            requestId: crypto.randomUUID(),
        });
        await conversation.submit(
            {
                type: "input",
                content: [
                    { type: "text", text: "look at this" },
                    { type: "image", mimeType: "image/png", data: "A".repeat(300_000) },
                ],
                whenBusy: "followUp",
                requestId: "queue-picture",
            },
            BACKGROUND_CONTEXT,
        );
        await until(() => queue().length === 2, "both to wait");
        const from = views().length;

        // The answer streams on, updating the view every 90 ms.
        await new Promise((resolve) => setTimeout(resolve, 1000));
        assert.ok(streaming(), "it still streams");
        const later = views().slice(from);

        assert.ok(later.length >= 5, `${later.length} updates as it streamed`);
        assert.equal(
            later.filter((view) => "inbox" in view).length,
            0,
            "no update repeated the queue",
        );

        const [paste, picture] = queue();

        assert.equal(paste!.text!.length, 501);
        assert.equal(picture!.text, "look at this", "its text, not the picture");
        assert.ok(JSON.stringify(queue()).length < 2000);

        // A tab that comes now gets the queue with its first view.
        await app.attach(late.client);
        assert.deepEqual(queue(late), queue());

        // A change is sent: stopping withdraws them.
        await app.commands.abort(id, owner());
        await until(() => queue().length === 0 && queue(late).length === 0, "the queue to empty");
    } finally {
        app.detach(tab.client);
        app.detach(late.client);
    }
});

test("a tab of protocol 3 gets the answer being written as what changed, an older tab whole", async () => {
    const { liveMessage } = (await import(new URL("../web/live.js", import.meta.url).href)) as {
        liveMessage: (current: unknown, update: unknown) => unknown;
    };
    const id = await newSession();
    const tab = fakeTab(id, owner(), 3);
    const old = fakeTab(id, owner(), 2);

    type Live = { generation?: { message?: { keep?: number } } };
    const lives = (of: typeof tab) =>
        of.events.flatMap((each) => (each.event === "view" ? [each.data.live as Live] : []));
    const size = (of: typeof tab) => JSON.stringify(lives(of)).length;

    await app.attach(tab.client);
    await app.attach(old.client);

    try {
        await app.commands.submit(id, owner(), {
            text: "stream a long answer",
            requestId: crypto.randomUUID(),
        });
        await until(() => size(old) > 200_000, "the answer to stream a while");
        // Both tabs get each update at once: the new one's changes add up to the old one's whole message.
        let shown: unknown = undefined;

        for (const live of lives(tab)) {
            shown = liveMessage(shown, live.generation?.message);
        }

        assert.deepEqual(shown, lives(old).at(-1)!.generation?.message);
        assert.ok(lives(tab).some((live) => live.generation?.message?.keep !== undefined));
        assert.ok(lives(old).every((live) => live.generation?.message?.keep === undefined));
        assert.ok(size(tab) * 5 < size(old), `${size(tab)} bytes, against ${size(old)}`);
        await app.commands.abort(id, owner());
    } finally {
        app.detach(tab.client);
        app.detach(old.client);
    }
});

test("a tab of protocol 4 opens a long session with its newest rows, and asks for earlier ones", async () => {
    const id = await newSession();

    // 90 messages and 90 answers: more rows than a view brings.
    for (let n = 1; n <= 90; n++) {
        await say(id, `message ${n}`);
    }

    const tab = fakeTab(id, owner(), 4);
    const old = fakeTab(id, owner(), 3);

    type Entry = { id: number; kind: string; text?: string };
    const view = (of: typeof tab) =>
        of.events.find((each) => each.event === "view")!.data as {
            entries: Entry[];
            order: number[];
        };
    const isRow = (entry: Entry) => entry.kind === "user" || entry.kind === "assistant";

    await app.attach(tab.client);
    await app.attach(old.client);

    try {
        await until(
            () => tab.last("view") !== undefined && old.last("view") !== undefined,
            "the views",
        );
        const all = view(old).entries;
        const first = view(tab).entries;

        // Older code gets every entry; the new, the order of all of them and the entries of the newest 80 rows, with the
        // turn before the oldest, which says what was open there (`turnStart`).
        assert.equal(all.filter(isRow).length, 180);
        assert.deepEqual(view(tab).order, view(old).order);
        assert.equal(first.filter(isRow).length, 82);
        assert.deepEqual(first, all.slice(-first.length));
        assert.equal(first[0]!.kind, "user");

        // Earlier ones as asked: some rows (from a message on), up to an entry, or all of them.
        const room = await app.room(id);

        try {
            const rows = room.entriesBefore(first[0]!.id, { rows: 20 });

            assert.equal(rows.filter(isRow).length, 22);
            assert.deepEqual(rows, all.slice(-first.length - rows.length, -first.length));
            assert.deepEqual(
                room.entriesBefore(first[0]!.id, { from: all[3]!.id }),
                all.slice(2, -first.length),
            );
            assert.deepEqual(room.entriesBefore(first[0]!.id), all.slice(0, -first.length));
            assert.deepEqual(room.entriesBefore(-1), []);
        } finally {
            app.releaseRoom(room);
        }

        // An update brings only what is new, not the entries the first view left out.
        await say(id, "one more");
        const sent = () =>
            tab.events
                .filter((each) => each.event === "view")
                .slice(1)
                .flatMap((each) => each.data.entries as Entry[])
                .filter(isRow)
                .map((entry) => entry.text ?? entry.kind);

        await until(() => sent().length >= 2, "the update with the answer");
        assert.deepEqual(sent(), ["one more", "assistant"]);
    } finally {
        app.detach(tab.client);
        app.detach(old.client);
    }
});

test("a tab of protocol 5 gets a session's newest entries light first, and whole right after", async () => {
    const id = await newSession();

    await say(id, "think and write a big file");
    const tab = fakeTab(id, owner(), 5);
    const old = fakeTab(id, owner(), 4);

    type Block = { type: string; text?: string; args?: { content?: string }; partial?: boolean };
    type Entry = {
        id: number;
        kind: string;
        text?: string;
        blocks?: Block[];
        partial?: boolean;
    };
    const views = (of: typeof tab) =>
        of.events
            .filter((each) => each.event === "view")
            .map((each) => each.data as { full: boolean; entries: Entry[] });

    await app.attach(tab.client);
    await app.attach(old.client);

    try {
        await until(() => views(tab).length >= 2 && views(old).length >= 1, "the views");
        const whole = views(old)[0]!.entries;
        const [first, next] = views(tab);
        const call = whole.find((entry) =>
            entry.blocks?.some((block) => block.type === "thinking"),
        )!;
        const result = whole.find((entry) => entry.kind === "toolResult")!;
        const light = first!.entries.find((entry) => entry.id === call.id)!;

        // The first view has the same entries, the thought without its words and the file cut short, marked partial.
        assert.equal(first!.full, true);
        assert.deepEqual(
            first!.entries.map((entry) => entry.id),
            whole.map((entry) => entry.id),
        );
        assert.equal(light.partial, true);
        assert.deepEqual(
            light.blocks!.map((block) => [block.type, block.partial]),
            [
                ["thinking", true],
                ["toolCall", true],
            ],
        );
        assert.equal(light.blocks![0]!.text, "");
        assert.equal(light.blocks![1]!.args!.content!.length, 300);
        // A short result is whole already, and words are never cut.
        assert.equal(first!.entries.find((entry) => entry.id === result.id)!.partial, undefined);
        assert.ok(first!.entries.every((entry) => entry.kind !== "user" || !entry.partial));

        // The next update brings the light ones whole, and nothing else.
        assert.equal(next!.full, false);
        assert.deepEqual(next!.entries, [call]);

        // And later updates do not bring them again.
        await say(id, "one more");
        await until(
            () =>
                views(tab).some((each) => each.entries.some((entry) => entry.text === "one more")),
            "the update with the message",
        );
        assert.ok(
            views(tab)
                .slice(2)
                .every((each) => each.entries.every((entry) => entry.id !== call.id)),
        );
    } finally {
        app.detach(tab.client);
        app.detach(old.client);
    }
});

test("a tab does not get the session list again when it did not change", async () => {
    const id = await newSession();
    const tab = fakeTab(id, owner());
    const again = fakeTab(id, owner());
    const lists = () => tab.events.filter((each) => each.event === "sessions").length;
    const pause = () => new Promise((resolve) => setTimeout(resolve, 600));

    await app.attach(tab.client);

    try {
        await pause();
        const before = lists();

        // The same person in the same session again: the list says the same, though it is worked out again.
        await app.attach(again.client);
        await pause();
        assert.equal(lists(), before);
    } finally {
        app.detach(tab.client);
        app.detach(again.client);
    }
});

test("interrupt stops a streaming run and withdraws the queue, then Pi answers the new message", async () => {
    const id = await newSession();
    const started = Date.now();

    await app.commands.submit(id, owner(), { text: "stream a long answer", requestId: "i-1" });
    await until(() => app.isBusy(id), "the run to start");
    await app.commands.submit(id, owner(), { text: "queued one", requestId: "i-2" });
    const { submissionId } = await app.commands.submit(id, owner(), {
        text: "never mind",
        mode: "interrupt",
        requestId: "i-3",
    });

    await (await app.harness.submission(submissionId, context))!.wait(context);
    const texts = (await modelTexts(app, id)).join("\n");

    assert.match(texts, /echo: never mind/);
    assert.doesNotMatch(texts, /queued one/);
    assert.ok(Date.now() - started < 4000, "it did not wait for the long answer");
});

test("a queued message moves between Queue and Steer, by its sender only", async () => {
    const id = await newSession();
    const guest = app.config.addUser("Alex", "guest").user;
    const mode = async () => (await app.harness.snapshot(InboxDoc, id, context))?.items[0]?.mode;

    try {
        await app.commands.submit(id, owner(), { text: "stream a long answer", requestId: "m-1" });
        await until(() => app.isBusy(id), "the run to start");
        const { submissionId } = await app.commands.submit(id, owner(), {
            text: "later",
            mode: "followUp",
            requestId: "m-2",
        });

        await app.commands.moveQueued(id, owner(), Number(submissionId), "steer");
        assert.equal(await mode(), "steer");
        await app.commands.moveQueued(id, owner(), Number(submissionId), "followUp");
        assert.equal(await mode(), "followUp");
        await assert.rejects(
            app.commands.moveQueued(id, guest, Number(submissionId), "steer"),
            /Only its sender/,
        );
        assert.equal(await mode(), "followUp");
    } finally {
        await app.commands.abort(id, owner());
        app.config.removeUser(guest.id);
    }
});

test("a queued message taken back to edit gives its sender its words and files, and leaves the queue", async () => {
    const id = await newSession();
    const guest = app.config.addUser("Sam", "guest").user;
    const path = join(app.workspace.uploadDirectory(id), "lzx-1234abcd-notes (v2).txt");
    const file = { path, name: "notes (v2).txt", mime: "text/plain", size: 3 };

    writeFileSync(path, "abc");

    try {
        await app.commands.submit(id, owner(), { text: "stream a long answer", requestId: "e-1" });
        await until(() => app.isBusy(id), "the run to start");
        const { submissionId } = await app.commands.submit(id, owner(), {
            text: "first line\nsecond line",
            attachments: [file],
            mode: "followUp",
            requestId: "e-2",
        });

        await assert.rejects(
            app.commands.editQueued(id, guest, Number(submissionId)),
            /Only its sender/,
        );
        assert.deepEqual(await app.commands.editQueued(id, owner(), Number(submissionId)), {
            text: "first line\nsecond line",
            attachments: [file],
        });
        assert.equal((await app.harness.snapshot(InboxDoc, id, context))?.items.length, 0);
        await assert.rejects(
            app.commands.editQueued(id, owner(), Number(submissionId)),
            /already gone/,
        );
    } finally {
        await app.commands.abort(id, owner());
        app.config.removeUser(guest.id);
    }
});

test("a queued message moved to Interrupt goes now, as Pi answers it, and the other queued messages stay", async () => {
    const id = await newSession();
    const started = Date.now();

    await app.commands.submit(id, owner(), { text: "stream a long answer", requestId: "mi-1" });
    await until(() => app.isBusy(id), "the run to start");
    const { submissionId } = await app.commands.submit(id, owner(), {
        text: "right now",
        mode: "followUp",
        requestId: "mi-2",
    });

    await app.commands.submit(id, owner(), { text: "a steer", mode: "steer", requestId: "mi-3" });
    await app.commands.moveQueued(id, owner(), Number(submissionId), "interrupt");
    await until(
        async () => (await modelTexts(app, id)).some((text) => text.includes("echo: right now")),
        "the answer to the moved message",
    );
    assert.ok(Date.now() - started < 4000, "it did not wait for the long answer");
    // The steer stayed queued: Pi answers it as well.
    await until(
        async () => (await modelTexts(app, id)).some((text) => text.includes("echo: a steer")),
        "the answer to the message that stayed",
    );
    await assert.rejects(
        app.commands.moveQueued(id, owner(), Number(submissionId), "steer"),
        /already gone/,
    );
});

/** The queued messages of a conversation: the text each says, its mode, and who sent it. */
async function queued(app: App, id: ConversationId) {
    const items = (await app.harness.snapshot(InboxDoc, id, context))?.items ?? [];

    return Promise.all(
        items.map(async (item) => ({
            text: item.mode === "write" ? "" : JSON.stringify(item.content),
            mode: item.mode,
            by: await app.attribution.submitter(Number(item.id)),
        })),
    );
}

test("an Interrupt of one queued message leaves the 3 others, from 2 people, queued in order", async () => {
    const id = await newSession();
    const guest = app.config.addUser("Alex", "guest").user;
    const by = [owner().id, guest.id, guest.id];

    try {
        await app.commands.submit(id, owner(), { text: "stream a long answer", requestId: "st-1" });
        await until(() => app.isBusy(id), "the run to start");
        await app.commands.submit(id, owner(), {
            text: "first of mine",
            mode: "followUp",
            requestId: "st-2",
        });
        await app.commands.submit(id, guest, {
            text: "guest steer",
            mode: "steer",
            requestId: "st-3",
        });
        const { submissionId } = await app.commands.submit(id, owner(), {
            text: "stream a long answer, moved",
            mode: "followUp",
            requestId: "st-4",
        });

        await app.commands.submit(id, guest, {
            text: "guest queue",
            mode: "followUp",
            requestId: "st-5",
        });
        await app.commands.moveQueued(id, owner(), Number(submissionId), "interrupt");
        // The moved message is the new run; the others wait behind it, in their order.
        await until(
            async () => (await queued(app, id)).length === 3,
            "the other messages to be queued again",
        );
        await until(
            async () => (await modelTexts(app, id)).some((text) => text.includes("moved")),
            "the moved message to go",
        );
        const waiting = await queued(app, id);

        assert.deepEqual(
            waiting.map((each) => each.mode),
            ["followUp", "steer", "followUp"],
        );
        assert.ok(waiting[0]!.text.includes("first of mine"));
        assert.ok(waiting[1]!.text.includes("guest steer"));
        assert.ok(waiting[2]!.text.includes("guest queue"));
        assert.deepEqual(
            waiting.map((each) => each.by),
            by,
        );
    } finally {
        await app.commands.abort(id, owner());
        app.config.removeUser(guest.id);
    }
});

test("an Interrupt task run again, or for a run that is gone, stops nothing and queues nothing twice", async () => {
    const id = await newSession();
    const task = (input: Interrupt) =>
        app.harness.commit(
            (tx) =>
                tx.createTask(app.commands.interruptTask, input, {
                    ownership: { kind: "conversation" },
                    background: true,
                    conversationId: id,
                }),
            context,
        );

    const finish = async (created: Awaited<ReturnType<typeof task>>) => {
        await app.harness.waitForTask(created, context);
    };

    const kept = {
        content: "kept",
        mode: "steer" as const,
        requestId: `u:${owner().id}:kept~1`,
    };

    try {
        await app.commands.submit(id, owner(), { text: "stream a long answer", requestId: "re-1" });
        await until(() => app.isBusy(id), "the run to start");
        const run = Number((await app.harness.snapshot(LiveDoc, id, context))?.run?.taskId);
        const input = { content: "after", requestId: `u:${owner().id}:int-1`, others: [kept] };

        // Resumed after the stop: the run it meant is gone, and this one (any other) is not its to stop.
        await finish(await task({ ...input, run: run + 1000 }));
        assert.ok(app.isBusy(id), "another run is not stopped");
        assert.equal((await queued(app, id)).length, 2);

        // Resumed after the send: the message and the others are found by their request ids, and nothing is stopped.
        await finish(await task({ ...input, run }));
        assert.ok(app.isBusy(id), "a message that went is not sent again, nor the run stopped");
        assert.equal((await queued(app, id)).length, 2);
        assert.deepEqual(
            (await queued(app, id)).map((each) => each.mode),
            ["followUp", "steer"],
        );
    } finally {
        await app.commands.abort(id, owner());
    }
});

test("after a restart, a person still moves their own queued message; to Steer or Interrupt only while driving", async () => {
    const dataDir = join(root, "move-restart");
    let again = await openApp(faux, dataDir);
    let alex: Awaited<ReturnType<typeof again.config.addUser>>["user"] | undefined;

    try {
        const first = ownerOf(again);

        alex = again.config.addUser("Alex", "guest").user;
        const id = await startSession(again);

        await again.commands.submit(id, first, { text: "stream a long answer", requestId: "rs-1" });
        await until(() => again.isBusy(id), "the run to start");
        const mine = await again.commands.submit(id, first, {
            text: "mine",
            mode: "steer",
            requestId: "rs-2",
        });
        const theirs = await again.commands.submit(id, alex, {
            text: "theirs",
            mode: "followUp",
            requestId: "rs-3",
        });

        await again.close();
        again = await openApp(faux, dataDir);
        alex = again.config.users.find((user) => user.name === "Alex")!;
        // Take turns, and Alex drives: the owner moves their own message to the queue all the same, and not Alex's.
        // Steer and Interrupt act on the run now: Alex's turn.
        await again.harness.commit(async (tx) => {
            const turns = await tx.doc(TurnsDoc, id);

            turns.on = true;
            turns.driver = alex!.id;
        }, context);
        await assert.rejects(
            again.commands.moveQueued(id, ownerOf(again), Number(theirs.submissionId), "steer"),
            /Only its sender/,
        );
        await again.commands.moveQueued(id, ownerOf(again), Number(mine.submissionId), "followUp");
        assert.equal(
            (await again.harness.snapshot(InboxDoc, id, context))?.items.find(
                (item) => Number(item.id) === Number(mine.submissionId),
            )?.mode,
            "followUp",
        );

        for (const mode of ["steer", "interrupt"]) {
            await assert.rejects(
                again.commands.moveQueued(id, ownerOf(again), Number(mine.submissionId), mode),
                /Alex is driving/,
            );
        }

        assert.ok(again.isBusy(id), "the run Alex drives goes on");
        await again.commands.abort(id, ownerOf(again));
    } finally {
        await again.close();
    }
});

test("an interrupt sent again with the same request id does not stop the run that it started", async () => {
    const id = await newSession();

    await app.commands.submit(id, owner(), { text: "stream a long answer", requestId: "r-1" });
    await until(() => app.isBusy(id), "the first run");
    const request = {
        text: "stream a long answer again",
        mode: "interrupt" as const,
        requestId: "r-2",
    };
    const first = await app.commands.submit(id, owner(), request);

    await until(
        async () => (await modelTexts(app, id)).some((text) => text.includes("long answer again")),
        "the second run",
    );
    await until(() => app.isBusy(id), "the second run to stream");
    // A proxy or a client sends the same POST again, after a network drop.
    const again = await app.commands.submit(id, owner(), request);

    assert.equal(again.submissionId, first.submissionId);
    await (await app.harness.submission(first.submissionId, context))!.wait(context);
    const entries = await app.transcripts.allEntries(id, false);
    const last = entries.findLast((entry) => entry.kind === "assistant") as
        { stopReason?: string } | undefined;

    // The second run answers in full: the retry did not abort it.
    assert.equal(last?.stopReason, "stop");
});

test("requests with the wrong types are refused, and nothing odd is stored", async () => {
    const id = await newSession();

    await assert.rejects(
        app.commands.updateSession(id, owner(), { archived: "yes" as never }),
        /archived must be true or false/,
    );
    await assert.rejects(
        app.commands.configure(id, owner(), { thinkingLevel: "banana" }),
        /thinkingLevel must be one of/,
    );
    assert.equal(app.sessions().find((each) => each.id === Number(id))?.archived, undefined);
});

test("the harness disables the crash-loop guard for long task phases", async () => {
    const { Harness } = await import("@earendil-works/pi-durable");
    const opened = mock.method(Harness, "open");
    let isolated: App | undefined;

    try {
        isolated = await openApp(faux, join(root, "restart-settings"));
        const settings = opened.mock.calls[0]!.arguments[1].settings;

        assert.equal(
            (typeof settings === "function" ? settings() : settings)?.restartLimit,
            Infinity,
        );
    } finally {
        opened.mock.restore();
        await isolated?.close();
    }
});

test("failed harness initialization closes its opened storage before releasing the lock", async () => {
    const { Harness } = await import("@earendil-works/pi-durable");
    const dataDir = join(root, "failed-harness-initialization");
    let storageClosed = false;
    const failed = mock.method(Harness, "open", async (storage: Storage) => {
        const close = storage.close.bind(storage);

        mock.method(storage, "close", async (closeContext: Parameters<Storage["close"]>[0]) => {
            assert.equal(existsSync(join(dataDir, "harness.lock")), true);
            assert.equal(existsSync(join(dataDir, "harness.lock.identity")), true);
            await close(closeContext);
            storageClosed = true;
        });

        throw new Error("scripted harness failure");
    });

    try {
        await assert.rejects(openApp(faux, dataDir), /scripted harness failure/);
    } finally {
        failed.mock.restore();
    }

    assert.equal(storageClosed, true);
    assert.equal(existsSync(join(dataDir, "harness.lock")), false);
    assert.equal(existsSync(join(dataDir, "harness.lock.identity")), false);
    await (await openApp(faux, dataDir)).close();
});

test("a dead holder's lock is taken over; live legacy holders with normal or renamed commands are respected", async () => {
    const { spawn } = await import("node:child_process");
    const { once } = await import("node:events");
    const dataDir = join(root, "locks");

    mkdirSync(dataDir, { recursive: true });
    const lock = join(dataDir, "harness.lock");
    const openHere = () => openApp(faux, dataDir);
    // A changed command name is not proof that the old holder stopped.
    const other = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
        argv0: "not-node",
    });
    const node = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"]);

    try {
        writeFileSync(lock, "999999999\n");
        await (await openHere()).close();

        writeFileSync(lock, `${other.pid}\n`);
        await assert.rejects(
            openHere(),
            new RegExp(`already running on this data directory \\(pid ${other.pid}\\)`),
        );

        writeFileSync(lock, `${node.pid}\n`);
        await assert.rejects(
            openHere(),
            new RegExp(`already running on this data directory \\(pid ${node.pid}\\)`),
        );
    } finally {
        other.kill();
        node.kill();
        await Promise.all([once(other, "exit"), once(node, "exit")]);
    }
});

test("notes refuse a stale edit, and a mention reaches the person in another session", async () => {
    const id = await newSession();
    const other = await newSession();
    const alex = app.config.addUser("Alex", "guest").user;
    const elsewhere = fakeTab(other, alex);

    try {
        await app.attach(elsewhere.client);
        const saved = await app.collab.saveNotes(id, alex, "plan: ship it", 0);

        assert.equal(saved.rev, 1);
        await assert.rejects(
            app.collab.saveNotes(id, owner(), "stale edit", 0),
            /Alex changed the notes/,
        );

        const posted = await app.collab.postChat(id, owner(), {
            text: "@alex look at this, cc @Alexander",
            requestId: "m1",
        });

        assert.deepEqual(posted.mentions, [alex.id]);
        await until(
            () =>
                elsewhere.events.some(
                    (each) =>
                        each.event === "notice" &&
                        String(each.data.message).includes("mentioned you"),
                ),
            "Alex to hear about the mention elsewhere",
        );
    } finally {
        app.detach(elsewhere.client);
        app.config.removeUser(alex.id);
    }
});

test("invites carry a role and a session over HTTP, and viewers get 403 on steering routes", async () => {
    const { createServer } = await import("node:http");
    const { createHandler } = await import("../src/server/http.ts");
    const server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const call = (token: string, path: string, body?: unknown) =>
        fetch(`${base}/api/${path}`, {
            method: body === undefined ? "GET" : "POST",
            headers: {
                authorization: `Bearer ${token}`,
                "x-pocket": "1",
                "content-type": "application/json",
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
    const id = await newSession();
    const joined: string[] = [];

    try {
        const invite = (await (
            await call(app.config.ownerToken, "invite", { role: "viewer", session: Number(id) })
        ).json()) as { code: string; grant: unknown };

        assert.deepEqual(invite.grant, { role: "viewer", session: String(id) });
        const redeemed = await fetch(`${base}/join/${invite.code}`, {
            method: "POST",
            body: "name=Watcher",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            redirect: "manual",
        });
        const token = decodeURIComponent(
            /pocket_auth=([^;]+)/.exec(redeemed.headers.get("set-cookie") ?? "")![1]!,
        );
        const watcher = app.config.users.find((each) => each.name === "Watcher")!;

        joined.push(watcher.id);
        assert.equal(watcher.role, "viewer");
        assert.deepEqual(watcher.sessions, [String(id)]);
        assert.equal(
            (await call(token, `c/${id}/submit`, { text: "hi", requestId: "x" })).status,
            403,
        );
        assert.equal((await call(token, `c/${id}/abort`, {})).status, 403);
        assert.equal((await call(token, "invite", {})).status, 403);
        assert.equal((await call(token, "fs?path=/")).status, 403);
        assert.equal(
            (await call(token, "fs", { path: join(root, "made-by-watcher") })).status,
            403,
        );
        assert.equal((await call(token, `c/${id}/files`)).status, 403);
        assert.equal((await call(token, `c/${id}/view?path=README.md`)).status, 403);
        assert.equal((await call(token, `c/${id}/shell`, { command: "echo hi" })).status, 403);
        assert.equal((await call(token, `c/${id}/changes/revert`, { path: "a.txt" })).status, 403);
        assert.equal(
            (await call(token, `c/${id}/chat`, { text: "hello", requestId: "y" })).status,
            200,
        );
        assert.equal(
            (await call(token, `c/${Number(id) + 999}/chat`, { text: "hello", requestId: "z" }))
                .status,
            404,
        );
        const sessions = (await (await call(token, "sessions")).json()) as { id: number }[];

        assert.deepEqual(
            sessions.map((each) => each.id),
            [Number(id)],
        );
    } finally {
        for (const userId of joined) {
            app.config.removeUser(userId);
        }

        server.closeAllConnections();
        server.close();
    }
});

test("the owner signs another device in as the owner: owner only, once, no one new, and a new owner token signs it out", async () => {
    const { createServer } = await import("node:http");
    const { createHandler } = await import("../src/server/http.ts");
    const { Auth } = await import("../src/server/auth.ts");
    const server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const call = (token: string, path: string, body?: unknown) =>
        fetch(`${base}/api/${path}`, {
            method: body === undefined ? "GET" : "POST",
            headers: {
                authorization: `Bearer ${token}`,
                "x-pocket": "1",
                "content-type": "application/json",
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
    const signIn = (code: string, site: string) =>
        fetch(`${base}/join/${code}`, {
            method: "POST",
            redirect: "manual",
            body: "",
            headers: {
                "content-type": "application/x-www-form-urlencoded",
                "sec-fetch-site": site,
            },
        });
    const id = await newSession();
    const guest = app.config.addUser("Gwen", "guest");
    const viewer = app.config.addUser("Vic", "viewer");

    try {
        // Only the owner makes one, and it is never for one session.
        const invite = (await (
            await call(app.config.ownerToken, "invite", { role: "owner" })
        ).json()) as { code: string; grant: unknown };

        assert.deepEqual(invite.grant, { role: "owner" });
        assert.equal((await call(guest.token, "invite", { role: "owner" })).status, 403);
        assert.equal((await call(viewer.token, "invite", { role: "owner" })).status, 403);
        assert.deepEqual(
            (
                (await (
                    await call(app.config.ownerToken, "invite", {
                        role: "owner",
                        session: Number(id),
                    })
                ).json()) as { grant: unknown }
            ).grant,
            { role: "owner" },
        );

        // Another site cannot spend it.
        assert.equal((await signIn(invite.code, "cross-site")).status, 403);
        assert.equal(
            (await fetch(`${base}/join/${invite.code}`)).status,
            200,
            "the invite still works",
        );

        // The device gets the owner's token, and no one new is made.
        const people = app.config.users.length;
        const signed = await signIn(invite.code, "same-origin");

        assert.equal(signed.status, 303);
        const cookie = decodeURIComponent(
            /pocket_auth=([^;]+)/.exec(signed.headers.get("set-cookie") ?? "")![1]!,
        );

        assert.equal(cookie, app.config.ownerToken);
        assert.equal(app.config.users.length, people);
        const me = await fetch(`${base}/api/me`, { headers: { cookie: `pocket_auth=${cookie}` } });

        assert.equal(
            ((await me.json()) as { user: { id: string; role: string } }).user.id,
            owner().id,
        );

        // It works once.
        assert.equal((await signIn(invite.code, "same-origin")).status, 410);

        // An owner invite made by anyone else (past the API's check) signs no one in.
        const auth = new Auth(app.config);
        const forged = auth.createInvite(guest.user, { role: "owner" });

        assert.equal(auth.redeem(forged.code, ""), undefined);
        assert.equal(auth.invite(forged.code), undefined, "and it is spent");

        // A new owner token signs the device out.
        app.config.rotateOwnerToken();
        assert.equal(
            (await fetch(`${base}/api/me`, { headers: { cookie: `pocket_auth=${cookie}` } }))
                .status,
            401,
        );
    } finally {
        app.config.removeUser(guest.user.id);
        app.config.removeUser(viewer.user.id);
        server.closeAllConnections();
        server.close();
    }
});

test("an invite lasts as long as asked (an owner's always 15 minutes), outlives a restart, and ends when its maker moves on", async () => {
    const { createServer } = await import("node:http");
    const { createHandler } = await import("../src/server/http.ts");
    const { Auth } = await import("../src/server/auth.ts");
    const { ConfigStore } = await import("../src/server/config.ts");
    const { copyFileSync, mkdtempSync, readFileSync } = await import("node:fs");
    const server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const call = (token: string, path: string, body: unknown) =>
        fetch(`${base}/api/${path}`, {
            method: "POST",
            headers: {
                authorization: `Bearer ${token}`,
                "x-pocket": "1",
                "content-type": "application/json",
            },
            body: JSON.stringify(body),
        });
    const make = async (body: unknown) =>
        (await (await call(app.config.ownerToken, "invite", body)).json()) as {
            code: string;
            expiresAt: number;
            minutes: number;
        };
    const live = async (code: string) => (await fetch(`${base}/join/${code}`)).status === 200;
    const guest = app.config.addUser("Gil", "guest");
    const MINUTE = 60_000;

    try {
        // As long as asked, 15 minutes when not said; an owner invite, 15 whatever is asked.
        for (const [body, minutes] of [
            [{}, 15],
            [{ minutes: 7 * 24 * 60, role: "owner" }, 15],
        ] as const) {
            const before = Date.now();
            const invite = await make(body);

            assert.equal(invite.minutes, minutes, JSON.stringify(body));
            assert.ok(
                invite.expiresAt >= before + minutes * MINUTE &&
                    invite.expiresAt <= Date.now() + minutes * MINUTE,
                JSON.stringify(body),
            );
        }

        // Kept in the data folder, by the code's hash: another start of the server (on a copy, which writes nothing back
        // here) finds it.
        const week = await make({ minutes: 7 * 24 * 60 });
        const copy = mkdtempSync(join(root, "config-"));

        copyFileSync(app.config.file, join(copy, "config.json"));
        const again = new Auth(new ConfigStore(copy));

        assert.deepEqual(again.invite(week.code), { role: "guest" });
        assert.ok(!readFileSync(app.config.file, "utf8").includes(week.code));

        // Only whoever made it ends it.
        assert.equal((await call(guest.token, "invite/cancel", { code: week.code })).status, 200);
        assert.ok(await live(week.code), "someone else cannot end it");
        assert.equal(
            (await call(app.config.ownerToken, "invite/cancel", { code: week.code })).status,
            200,
        );
        assert.ok(!(await live(week.code)), "its maker can");
        const guests = (await (await call(guest.token, "invite", { minutes: 60 })).json()) as {
            code: string;
        };

        await call(app.config.ownerToken, "invite/cancel", { code: guests.code });
        assert.ok(await live(guests.code), "not even the owner ends someone else's");

        // Two devices spending one at once: one gets in.
        const once = await make({ minutes: 60 });
        const both = await Promise.all(
            ["One", "Two"].map((name) =>
                fetch(`${base}/join/${once.code}`, {
                    method: "POST",
                    redirect: "manual",
                    body: `name=${name}`,
                    headers: { "content-type": "application/x-www-form-urlencoded" },
                }),
            ),
        );

        assert.deepEqual(both.map((each) => each.status).sort(), [303, 410]);

        for (const name of ["One", "Two"]) {
            const joined = app.config.users.find((each) => each.name === name);

            if (joined !== undefined) {
                app.config.removeUser(joined.id);
            }
        }

        // It works until its time is up, and not after.
        const auth = new Auth(app.config);

        mock.timers.enable({ apis: ["Date"], now: Date.now() });

        try {
            const hour = auth.createInvite(owner(), { role: "guest" }, 60);
            const late = auth.createInvite(owner(), { role: "guest" }, 60);

            mock.timers.tick(59 * MINUTE);
            const inTime = auth.redeem(hour.code, "In Time");

            assert.equal(inTime?.user.role, "guest");
            app.config.removeUser(inTime!.user.id);
            mock.timers.tick(2 * MINUTE);
            assert.equal(auth.redeem(late.code, "Too Late"), undefined);
        } finally {
            mock.timers.reset();
        }

        // Someone removed takes the invites they made along.
        const leaving = app.config.addUser("Lee", "guest").user;
        const left = auth.createInvite(leaving, { role: "viewer" }, 24 * 60);

        app.config.removeUser(leaving.id);
        assert.equal(auth.invite(left.code), undefined);
        assert.ok(!(await live(left.code)));

        // A new owner token ends owner invites not yet used, which would hand it out; others stay.
        const mine = auth.createInvite(owner(), { role: "owner" });
        const theirs = auth.createInvite(owner(), { role: "guest" }, 24 * 60);

        app.config.rotateOwnerToken();
        assert.equal(auth.invite(mine.code), undefined);
        assert.deepEqual(auth.invite(theirs.code), { role: "guest" });
    } finally {
        app.config.removeUser(guest.user.id);
        server.closeAllConnections();
        server.close();
    }
});

test("people who signed in through a Cloudflare quick tunnel are removed once that tunnel is gone", async () => {
    const { createServer } = await import("node:http");
    const { createHandler } = await import("../src/server/http.ts");
    const server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const owner = {
        authorization: `Bearer ${app.config.ownerToken}`,
        "x-pocket": "1",
        "content-type": "application/json",
    };

    const join = async (name: string, host?: string): Promise<string> => {
        const { code } = (await (
            await fetch(`${base}/api/invite`, { method: "POST", headers: owner, body: "{}" })
        ).json()) as { code: string };
        const headers: Record<string, string> = {
            "content-type": "application/x-www-form-urlencoded",
            ...(host === undefined ? {} : { "x-forwarded-host": host }),
        };
        const joined = await fetch(`${base}/join/${code}`, {
            method: "POST",
            body: `name=${name}`,
            headers,
            redirect: "manual",
        });

        return decodeURIComponent(
            /pocket_auth=([^;]+)/.exec(joined.headers.get("set-cookie") ?? "")![1]!,
        );
    };

    const named = (name: string) => app.config.users.find((each) => each.name === name);
    const before = app.access;

    try {
        await join("Tunnelled", "old-tunnel.trycloudflare.com");
        await join("Wifi");
        const legacy = await join("Legacy");

        assert.equal(named("Tunnelled")?.tunnel, "old-tunnel.trycloudflare.com");
        assert.equal(named("Wifi")?.tunnel, undefined);
        // Someone who joined before tunnels were recorded is tagged when their cookie comes back through one.
        await fetch(`${base}/api/me`, {
            headers: {
                cookie: `pocket_auth=${encodeURIComponent(legacy)}`,
                "x-forwarded-host": "old-tunnel.trycloudflare.com",
            },
        });
        assert.equal(named("Legacy")?.tunnel, "old-tunnel.trycloudflare.com");

        // A server restart keeps the tunnel: nobody is removed.
        app.setReach({
            mode: "cloudflare",
            label: "Cloudflare Tunnel",
            url: "https://old-tunnel.trycloudflare.com",
        });
        assert.ok(named("Tunnelled") && named("Legacy") && named("Wifi"));
        // A new tunnel: its address is new, so the old one's people go. Others and the owner stay.
        app.setReach({
            mode: "cloudflare",
            label: "Cloudflare Tunnel",
            url: "https://new-tunnel.trycloudflare.com",
        });
        assert.equal(named("Tunnelled"), undefined);
        assert.equal(named("Legacy"), undefined);
        assert.ok(named("Wifi"));
        assert.ok(app.config.users.some((each) => each.role === "owner"));
    } finally {
        app.access = before;

        for (const name of ["Tunnelled", "Wifi", "Legacy"]) {
            const user = named(name);

            if (user !== undefined) {
                app.config.removeUser(user.id);
            }
        }

        server.closeAllConnections();
        server.close();
    }
});

test("the web edge: page policy, local redirects, asked account switches, no cross-site sign-ins, clean uploads, scoped people", async () => {
    const { createServer, request: rawRequest } = await import("node:http");
    const { createHandler } = await import("../src/server/http.ts");
    const { createHash } = await import("node:crypto");
    const { existsSync, readdirSync, readFileSync } = await import("node:fs");
    const server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    const ownerToken = app.config.ownerToken;
    const id = await newSession();
    const other = await newSession();
    const guest = app.config.addUser("Gus", "guest");
    const scoped = app.config.addUser("Sam", "viewer", [String(id)]);
    const elsewhere = app.config.addUser("Eve", "guest", [String(other)]);
    const cookie = (response: Response) => response.headers.get("set-cookie") ?? "";

    try {
        // The app page allows its own import map by hash and nothing from other sites.
        const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
        const map = /<script type="importmap">([\s\S]*?)<\/script>/.exec(html)![1]!;

        for (const path of ["/", `/s/${id}`, "/index.html"]) {
            const policy = (await fetch(base + path)).headers.get("content-security-policy") ?? "";

            assert.ok(
                policy.includes(`'sha256-${createHash("sha256").update(map).digest("base64")}'`),
                `${path} allows the import map`,
            );
            assert.match(policy, /img-src 'self' data: blob:;/);
            assert.match(policy, /connect-src 'self';/);
            assert.match(policy, /frame-ancestors 'self'/);
        }

        // After signing in, only paths on this server.
        const login = (query: string, headers: Record<string, string> = {}) =>
            fetch(`${base}/login?${query}`, { redirect: "manual", headers });

        for (const next of ["//evil.example/x", "/\\evil.example/x", "https://evil.example/"]) {
            assert.equal(
                (await login(`token=${ownerToken}&next=${encodeURIComponent(next)}`)).headers.get(
                    "location",
                ),
                "/",
                next,
            );
        }

        assert.equal(
            (await login(`token=${ownerToken}&next=${encodeURIComponent(`/s/${id}`)}`)).headers.get(
                "location",
            ),
            `/s/${id}`,
        );

        // A link for someone else asks before switching; only a same-site post switches.
        const asked = await login(`token=${guest.token}`, { cookie: `pocket_auth=${ownerToken}` });

        assert.equal(asked.status, 200);
        assert.equal(cookie(asked), "");
        const post = (path: string, body: string, site: string) =>
            fetch(base + path, {
                method: "POST",
                redirect: "manual",
                body,
                headers: {
                    "content-type": "application/x-www-form-urlencoded",
                    "sec-fetch-site": site,
                },
            });
        const forged = await post("/login", `token=${guest.token}`, "cross-site");

        assert.equal(forged.status, 403);
        assert.equal(cookie(forged), "");
        const switched = await post("/login", `token=${guest.token}`, "same-origin");

        assert.equal(switched.status, 303);
        assert.match(
            cookie(switched),
            new RegExp(`pocket_auth=${encodeURIComponent(guest.token)}`),
        );
        assert.equal(
            cookie(
                await login(`token=${ownerToken}`, { cookie: `pocket_auth=${ownerToken}` }),
            ).includes("pocket_auth="),
            true,
            "the same person signs in without asking",
        );

        // Another site cannot spend an invite on this browser.
        const invite = (await (
            await fetch(`${base}/api/invite`, {
                method: "POST",
                body: "{}",
                headers: { authorization: `Bearer ${ownerToken}`, "x-pocket": "1" },
            })
        ).json()) as { code: string };

        assert.equal(
            (await post(`/join/${invite.code}`, "name=Mallory", "cross-site")).status,
            403,
        );
        assert.equal(
            (await fetch(`${base}/join/${invite.code}`)).status,
            200,
            "the invite still works",
        );

        // Uploads: none for a conversation that does not exist, and nothing left of one cut off midway.
        const uploads = join(root, "data", "uploads");
        const missing = await fetch(`${base}/api/c/987654/upload?name=x.txt`, {
            method: "POST",
            body: "x",
            headers: { authorization: `Bearer ${ownerToken}`, "x-pocket": "1" },
        });

        assert.equal(missing.status, 404);
        assert.equal(existsSync(join(uploads, "987654")), false);
        const big = await fetch(`${base}/api/c/${id}/upload?name=big.bin`, {
            method: "POST",
            body: "x",
            headers: {
                authorization: `Bearer ${ownerToken}`,
                "x-pocket": "1",
                "content-length": "1",
            },
        });

        assert.equal(big.status, 200);
        const before = readdirSync(join(uploads, String(id))).length;

        await new Promise<void>((resolve) => {
            const cut = rawRequest({
                port,
                method: "POST",
                path: `/api/c/${id}/upload?name=cut.bin`,
                headers: {
                    authorization: `Bearer ${ownerToken}`,
                    "x-pocket": "1",
                    "content-length": "1000000",
                },
            });

            cut.on("error", () => resolve());
            cut.write(Buffer.alloc(1000));
            setTimeout(() => cut.destroy(), 200);
        });
        await until(
            () => readdirSync(join(uploads, String(id))).length === before,
            "the cut-off upload to be removed",
        );
        const declared = await new Promise<number>((resolve) => {
            const huge = rawRequest({
                port,
                method: "POST",
                path: `/api/c/${id}/upload?name=huge.bin`,
                headers: {
                    authorization: `Bearer ${ownerToken}`,
                    "x-pocket": "1",
                    "content-length": String(60 * 1024 * 1024),
                },
            });

            huge.on("response", (response) => resolve(response.statusCode ?? 0));
            huge.on("error", () => resolve(-1));
            huge.write("x");
        });

        assert.equal(declared, 413, "an upload declared too big is refused before it is read");
        // Two pasted images, both image.png, at the same moment: two files.
        const paste = () =>
            fetch(`${base}/api/c/${id}/upload?name=image.png`, {
                method: "POST",
                body: crypto.randomUUID(),
                headers: { authorization: `Bearer ${ownerToken}`, "x-pocket": "1" },
            }).then((response) => response.json() as Promise<{ path: string }>);
        const [first, second] = await Promise.all([paste(), paste()]);

        assert.notEqual(first.path, second.path);
        assert.notEqual(readFileSync(first.path, "utf8"), readFileSync(second.path, "utf8"));

        // People invited to one session see only the people who share it, without anyone's session limits.
        const seen = (await (
            await fetch(`${base}/api/users`, {
                headers: { authorization: `Bearer ${scoped.token}` },
            })
        ).json()) as { name: string; sessions?: number[] }[];

        assert.ok(
            seen.some((each) => each.name === "Gus") && seen.some((each) => each.name === "Sam"),
        );
        assert.ok(
            !seen.some((each) => each.name === "Eve"),
            "someone limited to another session stays hidden",
        );
        assert.ok(seen.every((each) => each.sessions === undefined));
        const all = (await (
            await fetch(`${base}/api/users`, { headers: { authorization: `Bearer ${ownerToken}` } })
        ).json()) as { name: string; sessions?: number[] }[];

        assert.deepEqual(all.find((each) => each.name === "Eve")?.sessions, [Number(other)]);
    } finally {
        for (const each of [guest, scoped, elsewhere]) {
            app.config.removeUser(each.user.id);
        }

        server.closeAllConnections();
        server.close();
    }
});

test("access holds: a refused tab hears nothing, narrowed access evicts, removal closes tabs, files stay in the session", async () => {
    const id = await newSession();
    const other = await newSession();
    const sam = app.config.addUser("Sam", "guest", [String(id)]).user;
    const vee = app.config.addUser("Vee", "viewer").user;
    const sneaky = fakeTab(other, sam);
    const samTab = fakeTab(id, sam);
    const veeTab = fakeTab(id, vee);
    let closed = 0;

    (veeTab.client as { close?: () => void }).close = () => closed++;

    try {
        // A tab pointed at a session Sam may not see gets "missing", then nothing about that session.
        await app.attach(sneaky.client);
        assert.equal(sneaky.client.conversationId, undefined);
        await app.commands.updateSession(other, owner(), { title: "Secret plans" });
        app.notice("warning", "server-wide detail");
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.ok(
            !sneaky.events.some((each) => each.event === "notice"),
            "no notices from the other session or the server",
        );
        assert.ok(
            !(app.sessions(owner()).find((each) => each.id === Number(other))?.people ?? []).some(
                (each) => each.id === sam.id,
            ),
        );

        // Narrowing Sam's access takes his tab out of the session at once.
        await app.attach(samTab.client);
        app.setAccess(owner(), sam.id, { sessions: [String(other)] });
        assert.match(String(samTab.last("missing")?.message), /no longer shared/);
        await app.collab.postChat(id, owner(), { text: "after the change", requestId: "acc-1" });
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.ok(
            !samTab.events.some(
                (each) =>
                    each.event === "chat" && JSON.stringify(each.data).includes("after the change"),
            ),
        );

        // Viewers load images only from the session's folder.
        const { writeFileSync } = await import("node:fs");
        const png = Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAAABJRU5ErkJggg==",
            "base64",
        );

        writeFileSync(join(work, "inside.png"), png);
        writeFileSync(join(root, "outside.png"), png);
        assert.equal(
            app.workspace.conversationFile(vee, id, "inside.png"),
            realpathSync(join(work, "inside.png")),
        );
        assert.throws(
            () => app.workspace.conversationFile(vee, id, join(root, "outside.png")),
            /not found/,
        );
        assert.throws(() => app.workspace.conversationFile(vee, id, "../outside.png"), /not found/);
        assert.equal(
            app.workspace.conversationFile(owner(), id, join(root, "outside.png")),
            join(root, "outside.png"),
        );

        // Removing Vee closes her tab.
        await app.attach(veeTab.client);
        app.removeUser(owner(), vee.id);
        assert.equal(closed, 1);
        assert.ok(veeTab.events.some((each) => each.event === "closing"));
    } finally {
        for (const tab of [sneaky, samTab, veeTab]) {
            app.detach(tab.client);
        }

        app.config.removeUser(sam.id);
        app.config.removeUser(vee.id);
    }
});

test("an invite stops working when its creator loses the right to invite", async () => {
    const { Auth } = await import("../src/server/auth.ts");
    const auth = new Auth(app.config);
    const guest = app.config.addUser("Gil", "guest").user;

    try {
        const { code } = auth.createInvite(guest, { role: "guest" });

        app.setAccess(owner(), guest.id, { role: "viewer" });
        assert.equal(auth.redeem(code, "Mallory"), undefined);
        assert.ok(!app.config.users.some((each) => each.name === "Mallory"));
        const fine = auth.createInvite(owner(), { role: "viewer" });
        const joined = auth.redeem(fine.code, "Okay");

        assert.equal(joined?.user.role, "viewer");
        app.config.removeUser(joined!.user.id);
    } finally {
        app.config.removeUser(guest.id);
    }
});

test("sessions and artifacts survive closing and reopening the storage", async () => {
    const id = await newSession();

    await say(id, "make an artifact for the restart test");
    await app.close();
    app = await open();
    assert.ok(app.sessions().some((each) => each.id === Number(id)));
    assert.equal((await app.artifactBody(id, "demo-page", undefined)).content, "<h1>one</h1>");
});

test("an extension reads a session's messages a page at a time, as its person may", async () => {
    const { createServer } = await import("node:http");
    const { createHandler } = await import("../src/server/http.ts");
    const id = await newSession();
    const other = await newSession();

    for (const text of ["first", "second", "third", "fourth", "fifth"]) {
        await say(id, text);
    }

    const server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const elsewhere = app.config.addUser("Sam", "guest", [String(other)]);
    const call = (token: string, query: string, session = id) =>
        fetch(`http://127.0.0.1:${port}/api/c/${session}/messages${query}`, {
            headers: { authorization: `Bearer ${token}` },
        });

    type Page = { messages: { id: number; kind: string; text: string }[]; before: number | null };
    const page = async (query: string) =>
        (await (await call(app.config.ownerToken, query)).json()) as Page;

    try {
        const newest = await page("?limit=2");

        assert.deepEqual(
            newest.messages.map((each) => [each.kind, each.text]),
            [
                ["user", "fourth"],
                ["user", "fifth"],
            ],
            "only people's messages, oldest first",
        );
        assert.equal(newest.before, newest.messages[0]!.id);

        const older = await page(`?limit=2&before=${newest.before}`);

        assert.deepEqual(
            older.messages.map((each) => each.text),
            ["second", "third"],
        );

        const first = await page(`?limit=2&before=${older.before}`);

        assert.deepEqual(
            first.messages.map((each) => each.text),
            ["first"],
        );
        assert.equal(first.before, null, "the start has no cursor");
        assert.equal((await page("")).messages.length, 5, "50 by default");

        // A cursor that is not a message of the context is stale, not the start.
        assert.equal((await call(app.config.ownerToken, `?before=999999999`)).status, 409);

        for (const bad of ["?limit=0", "?limit=201", "?limit=x", "?before=-3", "?before=abc"]) {
            assert.equal((await call(app.config.ownerToken, bad)).status, 400, bad);
        }

        assert.equal((await call(elsewhere.token, "")).status, 404, "not their session");
        assert.equal((await call(elsewhere.token, "", other)).status, 200, "their own session");
        assert.equal(
            (await fetch(`http://127.0.0.1:${port}/api/c/${id}/messages`)).status,
            401,
            "signed out",
        );
    } finally {
        app.config.removeUser(elsewhere.user.id);
        server.closeAllConnections();
        server.close();
    }
});

test("only the owner may show a path in the server's file manager, and only one that is there", async () => {
    const { createServer } = await import("node:http");
    const { createHandler } = await import("../src/server/http.ts");
    const id = await newSession();
    const server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const guest = app.config.addUser("Gil", "guest");
    const call = (token: string, body: unknown) =>
        fetch(`http://127.0.0.1:${port}/api/c/${id}/reveal`, {
            method: "POST",
            headers: {
                authorization: `Bearer ${token}`,
                "x-pocket": "1",
                "content-type": "application/json",
            },
            body: JSON.stringify(body),
        });

    try {
        // A real path for the owner would open a window: these stop before any command runs.
        assert.equal((await call(guest.token, { path: "." })).status, 403);
        assert.equal((await call(app.config.ownerToken, { path: "" })).status, 400);
        assert.equal((await call(app.config.ownerToken, { path: "no/such/file.txt" })).status, 404);
    } finally {
        app.config.removeUser(guest.user.id);
        server.closeAllConnections();
        server.close();
    }
});

test("a last-seen time that cannot be saved does not stop the server", async () => {
    const id = await newSession();
    const tab = fakeTab(id, owner());
    const update = mock.method(app.config, "updateUser", () => {
        throw new Error("ENOSPC: no space left on device, write");
    });

    try {
        await app.attach(tab.client);
        app.detach(tab.client);
        assert.ok(update.mock.callCount() >= 1, "it tried to save");
    } finally {
        update.mock.restore();
    }

    // The app goes on as before.
    await say(id, "still here");
    assert.ok((await modelTexts(app, id)).some((text) => text.includes("echo: still here")));
});

test("an Interrupt stops the run it was made for, not one that started after that run ended", async () => {
    const id = await newSession();
    let replacement: Awaited<ReturnType<typeof app.commands.submit>> | undefined;

    await app.commands.submit(id, owner(), { text: "stream a long answer", requestId: "race-old" });
    await until(() => app.isBusy(id), "the first run");
    const run = Number((await app.harness.snapshot(LiveDoc, id, context))?.run?.taskId);

    // The task's step, with the first run ended and a second one started between its look and its stop.
    await app.commands.interruptTask.definition.phases.send(
        { input: { content: "moved", requestId: `u:${owner().id}:race-interrupt`, run } } as never,
        {
            conversationId: id,
            commit: app.harness.commit.bind(app.harness),
            conversation: async () => {
                // The first run ends (awaited, so the next message starts a run of its own).
                await (await app.harness.conversation(id, context))!.abort(context);
                replacement = await app.commands.submit(id, owner(), {
                    text: "stream a long answer",
                    requestId: "race-new",
                });
                // Going, or already answered: either way, it started.
                await until(
                    async () =>
                        app.isBusy(id) ||
                        (
                            await (await app.harness.submission(
                                replacement!.submissionId!,
                                context,
                            ))!.status(context)
                        ).status !== "queued",
                    "the second run",
                );

                return app.harness.conversation(id, context);
            },
            report: (error: unknown) => assert.fail(String(error)),
        } as never,
        context,
    );
    const status = await (await app.harness.submission(
        replacement!.submissionId!,
        context,
    ))!.status(context);

    assert.notEqual(status.status, "unanswered", "the second run goes on");
    await app.commands.abort(id, owner());
});
