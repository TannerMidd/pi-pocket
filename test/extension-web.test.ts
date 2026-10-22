// Extensions' web parts: the routes a module adds under /api/x/, the browser module it serves from /x/, and the events
// it sends there. Who may use each, what a folder serves, and how they come and go with the module.
import {
    type App,
    cleanUp,
    context,
    newSession,
    modelTexts,
    fakeTab,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import {
    closeSync,
    existsSync,
    fstatSync,
    mkdirSync,
    openSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type {
    ConversationWebRequest,
    ExtensionWeb,
    PocketHost,
    WebRequest,
} from "../src/server/host.ts";
import { AgentDoc, defineDoc, type ConversationId } from "@earendil-works/pi-durable";
import { pocketVersion } from "../src/server/versions.ts";
import { ExtensionWebs } from "../src/server/extension-web.ts";
import { PlanDoc, TurnsDoc } from "../src/server/docs.ts";
import { createHandler } from "../src/server/http.ts";
import { opened } from "../src/server/http/io.ts";

const dataDir = join(root, "data");
const dropIns = join(dataDir, "extensions");
/** What the test modules leave on `globalThis`: their `web`, and how many of their versions were cleaned up. */
const seen = globalThis as unknown as {
    panelWeb?: ExtensionWeb;
    panelGone?: number;
    workspaceRequest?: WebRequest | ConversationWebRequest;
    workspaceHost?: PocketHost;
    workspaceGate?: Promise<void>;
    workspaceWrite?: Promise<unknown>;
};
const Catalog = defineDoc({
    kind: "x.workspace.catalog",
    version: 1,
    scope: "session",
    initial: () => ({ saved: 0 }),
});

/** A module with routes for every kind of person, and a folder of browser files for everyone with every session. */
const panel = (
    version: number,
    extra = "",
) => `/** Panel: a test module with routes and a browser module. */
export default function (_host, web) {
	web.route("GET", "status", () => ({ version: ${version} }));
	web.route("GET", "items/:id", ({ params }) => ({ id: params.id }));
	web.route("GET", "who", ({ user }) => user, { access: "view" });
	web.route("POST", "steer", () => ({ ok: true }), { access: "steer" });
	web.route("GET", "leaky", () => { throw Object.assign(new Error("Incorrect API key sk-123"), { status: 401 }); }, { access: "view" });
	web.route("GET", "broken", () => { throw new Error("a secret detail"); }, { access: "view" });
	web.client("panel-web", { access: "view" });
	web.onDispose(() => { globalThis.panelGone = (globalThis.panelGone ?? 0) + 1; });
	globalThis.panelWeb = web;
	${extra}
}
`;

let app: App;
let server: Server;
let base = "";
const people: Record<string, { token: string; id: string }> = {};

before(async () => {
    mkdirSync(join(dropIns, "panel-web"), { recursive: true });
    writeFileSync(join(dropIns, "panel.ts"), panel(1));
    writeFileSync(join(dropIns, "panel-web", "index.js"), "export const marker = 'panel index';\n");
    writeFileSync(join(dropIns, "panel-web", "notes.ts"), "export const secret = 'server code';\n");
    writeFileSync(join(dropIns, "panel-web", ".hidden.js"), "export {};\n");
    writeFileSync(join(root, "outside.js"), "export const outside = true;\n");
    symlinkSync(join(root, "outside.js"), join(dropIns, "panel-web", "link.js"));
    // A link that stays in the folder but leads to what is not served: not followed.
    mkdirSync(join(dropIns, "panel-web", ".secret"));
    writeFileSync(join(dropIns, "panel-web", ".secret", "key.json"), '{"key":"sk-secret"}\n');
    symlinkSync(".secret", join(dropIns, "panel-web", "visible"));
    // One file as the browser module: only it is served, not the files beside it.
    writeFileSync(
        join(dropIns, "solo.ts"),
        `/** Solo: a browser module of one file, for the owner. */\nexport default (_host, web) => { web.client("solo.js"); };\n`,
    );
    writeFileSync(join(dropIns, "solo.js"), "export default () => {};\n");
    writeFileSync(join(dropIns, "other.js"), "export const other = true;\n");
    writeFileSync(
        join(dropIns, "workspace.ts"),
        `/** Workspace: request-bound test routes. */
import { defineDoc } from "@earendil-works/pi-durable";
const Catalog = defineDoc({ kind: "x.workspace.catalog", version: 1, scope: "session", initial: () => ({ saved: 0 }) });
export default function(host, web) {
    globalThis.workspaceHost = host;
    web.route("GET", "catalog", async req => {
        globalThis.workspaceRequest = req;
        return await req.snapshot(Catalog, req.context) ?? { saved: 0 };
    }, { access: "view" });
    web.route("POST", "catalog", req => req.commit(async tx => ++(await tx.doc(Catalog)).saved));
    web.route("GET", "viewer-write", req => req.commit(async tx => ++(await tx.doc(Catalog)).saved), { access: "view" });
    web.route("GET", "wait", async req => {
        globalThis.workspaceRequest = req;
        await globalThis.workspaceGate;
        return {};
    });
    web.route("GET", "detached", req => {
        globalThis.workspaceRequest = req;
        globalThis.workspaceWrite = req.commit(async tx => {
            (await tx.doc(Catalog)).saved++;
            await globalThis.workspaceGate;
        }).catch(error => error);
        return {};
    });
    web.conversationRoute("GET", "source/:source", async req => {
        globalThis.workspaceRequest = req;
        return { conversation: req.conversation, linked: await req.linkedSessions.list() };
    }, { conversation: "source", access: "view" });
    web.conversationRoute("POST", "start/:source", req => {
        globalThis.workspaceRequest = req;
        return req.linkedSessions.start(req.body, req.body.key);
    }, { conversation: "source", access: "view" });
}
`,
    );
    app = await openApp(scriptedModel(), dataDir);
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    for (const [name, role, sessions] of [
        ["Gale", "guest", undefined],
        ["Vic", "viewer", undefined],
        ["Sid", "guest", ["1"]],
    ] as const) {
        const added = app.config.addUser(name, role, sessions ? [...sessions] : undefined);

        people[name] = { token: added.token, id: added.user.id };
    }

    people.owner = { token: app.config.ownerToken, id: owner(app).id };
    await app.setExtensionEnabled(owner(app), "panel.ts", true);
    await app.setExtensionEnabled(owner(app), "solo.ts", true);
    await app.setExtensionEnabled(owner(app), "workspace.ts", true);
});

after(async () => {
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

/** A request as someone (by name, or nobody), with the `X-Pocket` header unless told not to. */
async function call(
    who: string | null,
    path: string,
    {
        method = "GET",
        body,
        header = true,
    }: { method?: string; body?: unknown; header?: boolean } = {},
) {
    const response = await fetch(`${base}${path}`, {
        method,
        headers: {
            ...(who === null ? {} : { authorization: `Bearer ${people[who]!.token}` }),
            ...(header ? { "x-pocket": "1" } : {}),
            ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let data: unknown = text;

    try {
        data = JSON.parse(text);
    } catch {
        // Not JSON: a file.
    }

    return { status: response.status, data, headers: response.headers };
}

/** The browser modules someone's tabs load, as `hello` says. */
const uiFor = async (who: string) =>
    ((await call(who, "/api/me")).data as { server: { ui: { module: string; url: string }[] } })
        .server.ui;

test("a module's routes answer signed-in people, by who may use each", async () => {
    assert.deepEqual((await call("owner", "/api/x/panel/status")).data, { version: 1 });

    // The API's own checks come first: a sign-in, and the header a link or form on another site cannot send, which a
    // module's routes need on a GET too.
    assert.equal((await call(null, "/api/x/panel/status")).status, 401);
    assert.equal((await call("owner", "/api/x/panel/status", { header: false })).status, 403);

    // Owner by default; "steer" lets guests in, "view" viewers too; someone invited to one session never. A route
    // someone may not use is not there for them.
    assert.equal((await call("Gale", "/api/x/panel/status")).status, 404);
    assert.equal(
        (await call("Gale", "/api/x/panel/steer", { method: "POST", body: {} })).status,
        200,
    );
    assert.equal(
        (await call("Vic", "/api/x/panel/steer", { method: "POST", body: {} })).status,
        404,
    );
    assert.deepEqual((await call("Vic", "/api/x/panel/who")).data, {
        id: people.Vic!.id,
        name: "Vic",
        role: "viewer",
    });
    assert.equal((await call("Sid", "/api/x/panel/who")).status, 404);

    // A part decoded to a step out (`..%2F` is `../` once decoded), or with a backslash, is refused.
    for (const path of ["items/..%2F", "items/a%5Cb"]) {
        assert.equal((await call("owner", `/api/x/panel/${path}`)).status, 400, path);
    }
});

test("what a route throws becomes a 500 whose words only the owner sees", async () => {
    // A library's error has a status too, and words that may not be for everyone: a 500, as any other throw.
    const leakyToGuest = await call("Gale", "/api/x/panel/leaky");

    assert.equal(leakyToGuest.status, 500);
    assert.deepEqual(leakyToGuest.data, { error: "The extension failed to answer." });
    assert.match(JSON.stringify((await call("owner", "/api/x/panel/leaky")).data), /sk-123/);

    const toOwner = await call("owner", "/api/x/panel/broken");
    const toGuest = await call("Gale", "/api/x/panel/broken");

    assert.equal(toOwner.status, 500);
    assert.match(JSON.stringify(toOwner.data), /panel\.ts failed: a secret detail/);
    assert.equal(toGuest.status, 500);
    assert.deepEqual(toGuest.data, { error: "The extension failed to answer." });
});

test("a browser module loads for the people it is for, and its folder serves only its web files", async () => {
    const ownerUi = await uiFor("owner");
    const panelUrl = ownerUi.find((each) => each.module === "panel")!.url;
    const soloUrl = ownerUi.find((each) => each.module === "solo")!.url;

    // Panel's is for everyone with every session, as the built-in auto-resume's is; Solo's for the owner alone.
    assert.deepEqual(
        (await uiFor("Vic")).map((each) => each.module),
        ["auto-resume", "panel"],
    );
    assert.deepEqual(await uiFor("Sid"), []);

    const folder = panelUrl.replace(/index\.js$/, "");

    assert.match(String((await call("owner", panelUrl)).data), /panel index/);

    // Never server code, hidden files, a link (out of the folder or in it), or a step out of it.
    for (const path of [
        "notes.ts",
        ".hidden.js",
        "link.js",
        "visible/key.json",
        "%2E%2E/panel.ts",
    ]) {
        assert.equal((await call("owner", `${folder}${path}`)).status, 404, path);
    }

    // Nobody signed in, and someone it is not for, learn nothing.
    assert.equal((await call(null, panelUrl)).status, 401);
    assert.equal((await call("Sid", panelUrl)).status, 404);
    assert.equal((await call("Gale", soloUrl)).status, 404);
    // One file is all a file serves.
    assert.equal((await call("owner", soloUrl)).status, 200);
    assert.equal((await call("owner", soloUrl.replace(/solo\.js$/, "other.js"))).status, 404);
});

test("events reach the tabs that load the browser module, or one person's, and what is not JSON never throws", async () => {
    const tabs = Object.fromEntries(
        ["owner", "Gale", "Sid"].map((name) => [
            name,
            fakeTab(undefined, app.config.userById(people[name]!.id)!),
        ]),
    );

    for (const tab of Object.values(tabs)) {
        await app.attach(tab.client);
    }

    const ext = (name: string) =>
        tabs[name]!.events.filter((each) => each.event === "ext").map((each) => each.data);

    seen.panelWeb!.send("tick", { n: 1 });
    seen.panelWeb!.send("tick", 2, { to: people.Gale!.id });
    assert.deepEqual(ext("owner"), [{ module: "panel", event: "tick", data: { n: 1 } }]);
    assert.deepEqual(ext("Gale"), [
        { module: "panel", event: "tick", data: { n: 1 } },
        { module: "panel", event: "tick", data: 2 },
    ]);
    assert.deepEqual(ext("Sid"), []);
    // Never a throw (a timer's throw would stop the server): it is logged, and nobody gets it.
    const cycle: Record<string, unknown> = {};

    cycle.self = cycle;
    seen.panelWeb!.send("cycle", cycle);
    assert.equal(ext("owner").length, 1);

    for (const tab of Object.values(tabs)) {
        app.detach(tab.client);
    }
});

test("an edit swaps the routes and cleans up the version before; a failed one keeps it; off removes them", async () => {
    const urlBefore = (await uiFor("owner")).find((each) => each.module === "panel")!.url;
    const gone = seen.panelGone ?? 0;

    writeFileSync(join(dropIns, "panel.ts"), panel(2));
    await app.loader.reload("panel.ts");
    assert.deepEqual((await call("owner", "/api/x/panel/status")).data, { version: 2 });
    assert.equal(seen.panelGone, gone + 1, "the version before was cleaned up");

    // A version that throws while it loads: the one before keeps answering, and what the failed one set up goes.
    writeFileSync(join(dropIns, "panel.ts"), panel(3, `throw new Error("not today");`));
    await assert.rejects(app.loader.reload("panel.ts"), /not today/);
    assert.deepEqual((await call("owner", "/api/x/panel/status")).data, { version: 2 });
    assert.equal(seen.panelGone, gone + 2, "the failed version's cleanup ran");

    // Off: its routes, files, and browser module go, and its cleanup runs.
    await app.setExtensionEnabled(owner(app), "panel.ts", false);
    assert.equal((await call("owner", "/api/x/panel/status")).status, 404);
    assert.equal((await call("owner", urlBefore)).status, 404);
    assert.ok(!(await uiFor("owner")).some((each) => each.module === "panel"));
    assert.equal(seen.panelGone, gone + 3);
});

const OWNER = { role: "owner" as const };

/** Run `act` with the clock `ms` ahead: how a test waits out the 30 s a tab far behind has to take something. */
async function later<T>(ms: number, act: () => Promise<T> | T): Promise<T> {
    const realNow = Date.now;

    Date.now = () => realNow() + ms;

    try {
        return await act();
    } finally {
        Date.now = realNow;
    }
}

test("the server stops in time when a module's cleanup never ends, and still closes the rest", async () => {
    const dataDir = join(root, "stopping");
    const folder = join(dataDir, "extensions");

    mkdirSync(folder, { recursive: true });
    writeFileSync(
        join(folder, "forever.ts"),
        `/** Forever: a cleanup that never ends. */
export default (_host, web) => {
	web.onDispose(() => new Promise(() => {}));
};
`,
    );

    const other = await openApp(scriptedModel(), dataDir);

    await other.setExtensionEnabled(owner(other), "forever.ts", true);
    const started = Date.now();

    await other.close();

    const took = Date.now() - started;

    assert.ok(took >= 2900 && took < 8000, `stopped after ${took} ms`);
    assert.equal(existsSync(join(dataDir, "harness.lock")), false, "the rest closed too");
});

test("a stream far behind is cut off only once it took nothing for long, and one that reads never is", async () => {
    const { port } = server.address() as { port: number };

    const open = (tab: string) => {
        const socket = connect(port, "127.0.0.1");
        let got = 0;

        socket.on("error", () => {});
        socket.on("data", (chunk: Buffer) => (got += chunk.length));
        socket.write(
            `GET /api/events?tab=${tab} HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${app.config.ownerToken}\r\n\r\n`,
        );

        return {
            socket,
            got: () => got,
            closed: new Promise<void>((resolve) => socket.on("close", () => resolve())),
        };
    };

    const reading = open("reading");
    const stalled = open("stalled");

    await until(() => reading.got() > 0 && stalled.got() > 0, "both streams start");
    // One reads nothing from here on.
    stalled.socket.pause();

    let cut = false;

    void stalled.closed.then(() => (cut = true));

    const flood = async (count: number) => {
        for (let each = 0; each < count; each++) {
            app.notice("info", "x".repeat(1024 * 1024));
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
    };

    // Far behind, but only for a moment: nothing is cut off yet.
    await flood(20);
    stalled.socket.resume();
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(cut, false, "not cut off for being behind a moment");
    stalled.socket.pause();
    await flood(20);

    // Long after, the one that reads still gets everything; the one that took nothing is cut off.
    let readingCut = false;

    void reading.closed.then(() => (readingCut = true));
    await later(31_000, () => flood(3));
    stalled.socket.resume();
    await Promise.race([stalled.closed, new Promise((resolve) => setTimeout(resolve, 5000))]);
    assert.equal(cut, true, "the stalled stream was cut off");
    assert.equal(readingCut, false, "the stream that reads was not");
    reading.socket.destroy();
    stalled.socket.destroy();
});

test("a file is served only when what was opened is the file that was checked", async () => {
    const ownerUi = await uiFor("owner");
    const folder = ownerUi.find((each) => each.module === "solo")!.url.replace(/solo\.js$/, "");
    // A folder on the way swapped for a link after the check: the path checked leads elsewhere when opened.
    const outside = join(root, "swapped-outside");

    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "secret.json"), '{"secret":"sk-outside"}\n');
    symlinkSync(outside, join(root, "swapped-link"));

    const checked = app.webs.file.bind(app.webs);
    // What the check saw: the module's own file, before its folder was swapped.
    const real = app.webs.file("solo", ["solo.js"], OWNER)!;

    app.webs.file = () => ({
        file: join(root, "swapped-link", "secret.json"),
        type: "application/json",
        dev: real.dev,
        ino: real.ino,
    });

    try {
        const answer = await call("owner", `${folder}solo.js`);

        assert.equal(answer.status, 404);
        assert.doesNotMatch(String(JSON.stringify(answer.data)), /sk-outside/);
    } finally {
        app.webs.file = checked;
    }

    assert.equal((await call("owner", `${folder}solo.js`)).status, 200);

    // Where the system cannot say where an open file is (macOS has no /proc), the file opened must still be the one
    // checked: the swapped folder's file is another.
    const fd = openSync(join(root, "swapped-link", "secret.json"), "r");

    try {
        const stats = fstatSync(fd);
        const swapped = { file: join(root, "swapped-link", "secret.json") };

        assert.equal(opened(fd, { ...swapped, dev: real.dev, ino: real.ino }, stats, false), false);
        assert.equal(
            opened(fd, { ...swapped, dev: stats.dev, ino: stats.ino }, stats, false),
            true,
        );
    } finally {
        closeSync(fd);
    }
});

test("route documents are fresh, non-viewer writes that end with their request", async () => {
    assert.equal(
        (await call("owner", "/api/x/workspace/catalog", { method: "POST", body: {} })).status,
        200,
    );
    assert.deepEqual((await call("owner", "/api/x/workspace/catalog")).data, { saved: 1 });
    const captured = seen.workspaceRequest!;

    assert.equal(captured.context.abortSignal?.aborted, true);
    assert.equal(captured.signal.aborted, false, "normal completion keeps the legacy signal live");
    await assert.rejects(
        captured.commit(async (tx) => {
            (await tx.doc(Catalog)).saved++;
        }),
        /ended/,
    );
    assert.equal((await call("Vic", "/api/x/workspace/viewer-write")).status, 403);

    let release!: () => void;

    seen.workspaceGate = new Promise<void>((resolve) => {
        release = resolve;
    });
    await call("owner", "/api/x/workspace/detached");
    release();
    assert.ok((await seen.workspaceWrite) instanceof Error);
    assert.equal((await app.harness.snapshot(Catalog, context))?.saved, 1);

    // A disconnected handler still waiting cannot keep a live capability either.
    seen.workspaceGate = new Promise<void>((resolve) => {
        release = resolve;
    });
    const previous = seen.workspaceRequest;
    const stopped = new AbortController();
    const waiting = fetch(`${base}/api/x/workspace/wait`, {
        headers: { authorization: `Bearer ${people.owner!.token}`, "x-pocket": "1" },
        signal: stopped.signal,
    }).catch(() => {});

    await until(() => seen.workspaceRequest !== previous, "the waiting request");
    stopped.abort();
    await waiting;
    await until(() => seen.workspaceRequest!.signal.aborted, "request cancellation");
    assert.equal(seen.workspaceRequest!.context.abortSignal?.aborted, true);
    await assert.rejects(
        seen.workspaceRequest!.commit(() => {}),
        /ended/,
    );
    release();
});

test("bound routes use the clicking actor, keep receipts private, and expose authorized navigation metadata", async () => {
    const stage = new ExtensionWebs().stage("check.ts", dropIns, "Check");

    assert.throws(
        () =>
            stage.web.conversationRoute("GET", "source/:id", () => ({}), {
                conversation: "missing",
            }),
        /path parameter/,
    );
    const id = await newSession(app);
    const gale = app.config.userById(people.Gale!.id)!;

    await app.commands.submit(id, gale, { text: "hello", requestId: "source-requester" });
    const request = { title: "Human role", message: "a human task", key: "human-start" };
    const start = () =>
        call("owner", `/api/x/workspace/start/${id}`, { method: "POST", body: request });
    const first = await start();

    assert.equal(first.status, 200);
    const target = (first.data as { session: ConversationId }).session;

    await until(
        () => app.attribution.requesterOf(target) === owner(app).id,
        "the clicking actor's attribution",
    );
    assert.equal(app.attribution.requesterOf(id), gale.id);
    assert.deepEqual((await start()).data, first.data);
    assert.equal(
        (await call("Gale", `/api/x/workspace/start/${id}`, { method: "POST", body: request }))
            .status,
        409,
    );
    const count = app.sessions().length;

    assert.equal(
        (
            await call("owner", `/api/x/workspace/start/${id}`, {
                method: "POST",
                body: { ...request, key: "thinking", thinking: "high" },
            })
        ).status,
        400,
    );
    assert.equal(app.sessions().length, count);

    await app.harness.commit(
        async (tx) =>
            Object.assign(await tx.doc(TurnsDoc, id), { on: true, driver: gale.id, asks: [] }),
        context,
    );
    const view = await call("Vic", `/api/x/workspace/source/${id}`);

    assert.equal(view.status, 200);
    const data = view.data as {
        conversation: {
            id: number;
            cwd: string;
            thinkingLevel: string;
            model: { provider: string; modelId: string };
        };
        linked: { conversationId: number }[];
    };

    assert.equal(data.conversation.id, Number(id));
    assert.equal(data.conversation.thinkingLevel, "off");
    assert.ok(data.linked.some((each) => each.conversationId === Number(target)));
    assert.equal(
        (await call("Vic", `/api/x/workspace/start/${id}`, { method: "POST", body: request }))
            .status,
        403,
    );
    await assert.rejects(
        (seen.workspaceRequest as ConversationWebRequest).linkedSessions.list(),
        /ended/,
    );
    // An owner catalog save has no source turn, plan, or spend admission policy.
    assert.equal(
        (await call("owner", "/api/x/workspace/catalog", { method: "POST", body: {} })).status,
        200,
    );
    assert.equal(seen.workspaceHost!.pocketVersion, pocketVersion());
    assert.deepEqual(seen.workspaceHost!.modelInfo("faux/faux-1")?.thinkingLevels, ["off"]);
    assert.equal(typeof seen.workspaceHost!.modelInfo("faux/faux-1")?.contextWindow, "number");
    assert.equal(seen.workspaceHost!.modelInfo("faux-1"), undefined);
    assert.equal(
        ((await call("owner", "/api/me")).data as { server: { pocketVersion: string } }).server
            .pocketVersion,
        pocketVersion(),
    );
});

test("a human linked start admits the requested folder and leaves its source in place", async () => {
    const id = await newSession(app);
    const original = app.cwdOf(id);
    const cwd = join(root, "human-specialist-repository");

    mkdirSync(cwd);
    const body = { message: "Work in another repository", cwd, key: "human-other-folder" };
    const first = await call("owner", `/api/x/workspace/start/${id}`, { method: "POST", body });

    assert.equal(first.status, 200);
    const target = (first.data as { session: ConversationId }).session;

    assert.equal(app.cwdOf(target), cwd);
    assert.equal((await app.agentState(target))?.cwd, cwd);
    assert.equal(app.cwdOf(id), original);
    assert.deepEqual(
        (await call("owner", `/api/x/workspace/start/${id}`, { method: "POST", body })).data,
        first.data,
    );
});

/** Pause the network-facing model check, then change policy before it answers. */
async function whileChecking(
    t: import("node:test").TestContext,
    change: (id: ConversationId) => Promise<void> | void,
    who = "owner",
    model?: string,
) {
    const id = await newSession(app);
    const count = app.sessions().length;
    let release!: () => void;
    let checking = false;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });

    t.mock.method(app.providers, "problem", async () => {
        checking = true;
        await gate;

        return undefined;
    });
    const pending = call(who, `/api/x/workspace/start/${id}`, {
        method: "POST",
        body: { message: "a task", key: "paused", model },
    });

    await until(() => checking, "the model check");
    await change(id);
    release();
    const answer = await pending;

    assert.equal(app.sessions().length, count);

    return answer;
}

test("human starts recheck the person's current access after model checks", async (t) => {
    const answer = await whileChecking(
        t,
        () => {
            app.config.updateUser(people.Gale!.id, { role: "viewer" });
        },
        "Gale",
    );

    app.config.updateUser(people.Gale!.id, { role: "guest" });
    assert.equal(answer.status, 403);
});

test("a policy change queued between final authorization and admission cancels only that admission", async (t) => {
    const source = await newSession(app);
    let target!: ConversationId;
    const submit = app.commands.submit.bind(app.commands);

    t.mock.method(
        app.commands,
        "submit",
        async (...[id, user, request, via, admission]: Parameters<typeof submit>) => {
            target = id;

            return submit(
                id,
                user,
                request,
                via,
                admission && {
                    ...admission,
                    beforeSubmit: async () => {
                        const accepted = await admission.beforeSubmit();

                        await app.harness.commit(async (tx) => {
                            (await tx.doc(PlanDoc, source)).on = true;
                        }, context);
                        assert.equal(
                            seen.workspaceRequest!.context.abortSignal?.aborted,
                            false,
                            "only the admission lease is cancelled",
                        );

                        return accepted;
                    },
                },
            );
        },
    );
    const answer = await call("owner", `/api/x/workspace/start/${source}`, {
        method: "POST",
        body: { message: "not admitted", key: "policy-race" },
    });

    assert.equal(answer.status, 409);
    assert.deepEqual(await modelTexts(app, target), []);
});

test("a reconfigured target cannot substitute another allowed model for the approved start", async (t) => {
    const source = await newSession(app);

    // The source's model is listed, so a start keeps it; the other listed model is the one not approved.
    await app.allowSubagentModel(owner(app), "faux/faux-1", true);
    await app.allowSubagentModel(owner(app), "faux/faux-2", true);
    let target!: ConversationId;
    const submit = app.commands.submit.bind(app.commands);

    t.mock.method(
        app.commands,
        "submit",
        async (...[id, user, request, via, admission]: Parameters<typeof submit>) => {
            target = id;
            await app.harness.commit(async (tx) => {
                (await tx.doc(AgentDoc, id)).model = { provider: "faux", modelId: "faux-2" };
            }, context);

            return submit(id, user, request, via, admission);
        },
    );
    const answer = await call("owner", `/api/x/workspace/start/${source}`, {
        method: "POST",
        body: { message: "not substituted", key: "target-race" },
    });

    assert.equal(answer.status, 409);
    assert.deepEqual(await modelTexts(app, target), []);
    await app.allowSubagentModel(owner(app), "faux/faux-1", false);
    await app.allowSubagentModel(owner(app), "faux/faux-2", false);
});

test("a human start with a list needs a model when the source's is not listed, and takes a listed one", async () => {
    const source = await newSession(app);

    await app.allowSubagentModel(owner(app), "faux/faux-2", true);

    try {
        const answer = await call("owner", `/api/x/workspace/start/${source}`, {
            method: "POST",
            body: { message: "default model", key: "default-listed" },
        });

        assert.equal(answer.status, 400);
        assert.match(JSON.stringify(answer.data), /A model is required[^]*faux\/faux-2/);

        const chosen = await call("owner", `/api/x/workspace/start/${source}`, {
            method: "POST",
            body: { message: "chosen model", key: "chosen-listed", model: "faux/faux-2" },
        });

        assert.equal(chosen.status, 200);
        const target = (chosen.data as { session: ConversationId }).session;

        assert.equal((await app.agentState(target))?.model?.modelId, "faux-2");

        // Naming the source's own model, which is not listed, is refused.
        const refused = await call("owner", `/api/x/workspace/start/${source}`, {
            method: "POST",
            body: { message: "own model", key: "own-unlisted", model: "faux/faux-1" },
        });

        assert.equal(refused.status, 403);
    } finally {
        await app.allowSubagentModel(owner(app), "faux/faux-2", false);
    }
});

test("human creation inherits fresh non-selection source settings after provider checks", async (t) => {
    const source = await newSession(app);

    t.mock.method(app.providers, "problem", async () => {
        await app.harness.commit(async (tx) => {
            (await tx.doc(AgentDoc, source)).instructions = "Fresh instructions";
        }, context);

        return undefined;
    });
    const answer = await call("owner", `/api/x/workspace/start/${source}`, {
        method: "POST",
        body: { message: "fresh inheritance", key: "fresh-agent" },
    });

    assert.equal(answer.status, 200);
    const target = (answer.data as { session: ConversationId }).session;

    assert.equal((await app.agentState(target))?.instructions, "Fresh instructions");
});

test("human starts reject a source folder changed after its request preview", async (t) => {
    const answer = await whileChecking(t, (id) =>
        app.harness.commit(async (tx) => {
            (await tx.doc(AgentDoc, id)).cwd = root;
        }, context),
    );

    assert.equal(answer.status, 409);
});

test("human starts recheck the allowed model after model checks", async (t) => {
    await app.allowSubagentModel(owner(app), "faux/faux-2", true);
    const answer = await whileChecking(
        t,
        async () => {
            await app.allowSubagentModel(owner(app), "faux/faux-2", false);
        },
        "owner",
        "faux/faux-2",
    );

    assert.equal(answer.status, 403);
});
