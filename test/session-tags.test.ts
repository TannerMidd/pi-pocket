// Session tags (`extensions/session-tags.ts`) over HTTP, and `WebRequest.sessions()`, which its routes check ids with:
// who may read and change tags, the limits, all-or-nothing changes, and that tags last across a restart.
import { cleanUp, newSession, openApp, owner, root, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import createSessionTags from "../src/server/extensions/session-tags.ts";
import type { ExtensionWeb, PocketHost } from "../src/server/host.ts";
import { createHandler } from "../src/server/http.ts";

const dataDir = join(root, "data");
let app: Awaited<ReturnType<typeof openApp>>;
let server: Server;
let base = "";
const people: Record<string, { token: string; id: string }> = {};
let first: ConversationId;
let second: ConversationId;

async function start(): Promise<void> {
    app = await openApp(scriptedModel(), dataDir);
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

async function stop(): Promise<void> {
    server.closeAllConnections();
    server.close();
    await app.close();
}

before(async () => {
    // A drop-in that answers with what `sessions()` gives the person who asks.
    mkdirSync(join(dataDir, "extensions"), { recursive: true });
    writeFileSync(
        join(dataDir, "extensions", "lister.ts"),
        `/** Lister: the sessions a person can see. */
export default (_host, web) => { web.route("GET", "sessions", (request) => request.sessions(), { access: "view" }); };
`,
    );
    await start();
    first = await newSession(app);
    second = await newSession(app);

    for (const [name, role, sessions] of [
        ["Gale", "guest", undefined],
        ["Vic", "viewer", undefined],
        ["Sid", "guest", [String(first)]],
    ] as const) {
        const added = app.config.addUser(name, role, sessions ? [...sessions] : undefined);

        people[name] = { token: added.token, id: added.user.id };
    }

    people.owner = { token: app.config.ownerToken, id: owner(app).id };
    await app.setExtensionEnabled(owner(app), "session-tags.ts", true);
    await app.setExtensionEnabled(owner(app), "lister.ts", true);
});

after(async () => {
    await stop();
    cleanUp();
});

async function call(who: string, path: string, body?: unknown) {
    const response = await fetch(`${base}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
            authorization: `Bearer ${people[who]!.token}`,
            "x-pocket": "1",
            ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    return { status: response.status, data: (await response.json()) as Record<string, unknown> };
}

const tagsOf = async (who = "owner") =>
    (await call(who, "/api/x/session-tags/tags")).data.tags as Record<string, string[]>;

test("sessions() gives the sessions the person sees, as their list shows them", async () => {
    const listed = (await call("owner", "/api/x/lister/sessions")).data as unknown as {
        id: number;
        title: string;
        cwd: string;
        archived: boolean;
        updatedAt: number;
    }[];

    assert.deepEqual(listed.map((session) => session.id).sort(), [first, second].sort());
    assert.deepEqual(Object.keys(listed[0]!).sort(), [
        "archived",
        "cwd",
        "id",
        "title",
        "updatedAt",
    ]);
    assert.equal(listed[0]!.archived, false);
    assert.equal(listed[0]!.title, "New session");
});

test("people who steer every session tag them; viewers read the tags; someone invited to one session has neither", async () => {
    const added = await call("owner", "/api/x/session-tags/tags", {
        ids: [first, second],
        add: [" Review ", "urgent", "review"],
    });

    assert.equal(added.status, 200);
    assert.deepEqual(await tagsOf(), {
        [first]: ["review", "urgent"],
        [second]: ["review", "urgent"],
    });

    // A guest takes one off one session, and adds another: the rest stays.
    assert.equal(
        (
            await call("Gale", "/api/x/session-tags/tags", {
                ids: [second],
                add: ["bug"],
                remove: ["urgent"],
            })
        ).status,
        200,
    );
    assert.deepEqual(await tagsOf("Vic"), {
        [first]: ["review", "urgent"],
        [second]: ["bug", "review"],
    });

    // Viewers read but do not change: only GET is there for them. Someone invited to one session has no route at all.
    assert.equal(
        (await call("Vic", "/api/x/session-tags/tags", { ids: [first], add: ["x"] })).status,
        405,
    );
    assert.equal((await call("Sid", "/api/x/session-tags/tags")).status, 404);
});

test("a change is all or nothing, and names and ids are checked", async () => {
    const before = await tagsOf();
    const many = Array.from({ length: 9 }, (_, index) => `t${index}`);

    // The second session would pass 10 tags: neither changes.
    const over = await call("owner", "/api/x/session-tags/tags", {
        ids: [first, second],
        add: many,
    });

    assert.equal(over.status, 409);
    assert.match(String(over.data.error), /10 tags at most/);
    assert.deepEqual(await tagsOf(), before);

    for (const body of [
        { ids: [first], add: ["x".repeat(33)] },
        { ids: [first], add: ["two\nlines"] },
        { ids: [first], add: ["a"], remove: ["a"] },
        { ids: [], add: ["a"] },
        { ids: ["1"], add: ["a"] },
    ]) {
        assert.equal(
            (await call("owner", "/api/x/session-tags/tags", body)).status,
            400,
            JSON.stringify(body),
        );
    }

    // A session that is not there (or that this person cannot see) is not tagged.
    assert.equal(
        (await call("owner", "/api/x/session-tags/tags", { ids: [first, 999_999], add: ["a"] }))
            .status,
        404,
    );
    assert.deepEqual(await tagsOf(), before);
});

test("taking off a session's last tag leaves no entry, and tags last across a restart", async () => {
    assert.equal(
        (
            await call("owner", "/api/x/session-tags/tags", {
                ids: [first],
                remove: ["review", "urgent"],
            })
        ).status,
        200,
    );
    assert.deepEqual(await tagsOf(), { [second]: ["bug", "review"] });

    await stop();
    await start();
    assert.deepEqual(await tagsOf(), { [second]: ["bug", "review"] });
});

test("a server older than 0.20.0, which loads the file as its checkout changes, gets nothing from it", () => {
    const calls: string[] = [];
    const web = new Proxy(
        {},
        { get: (_target, name) => () => void calls.push(String(name)) },
    ) as unknown as ExtensionWeb;

    createSessionTags({ pocketVersion: "0.19.0" } as PocketHost, web);
    assert.equal(calls.length, 0);
    createSessionTags({ pocketVersion: "0.20.0" } as PocketHost, web);
    assert.ok(calls.includes("client") && calls.includes("route"));
});
