// Design's server part (`extensions/design.ts`) over HTTP: the session's designs, shared comments and who may write them,
// one person's tweaks, "go back to this one" (a new version in one commit, once for each key), what the module registers, and
// that the page it points at is untrusted data.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { cleanUp, newSession, openApp, owner, root, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { ArtifactBodyDoc, ArtifactsDoc, DesignCommentsDoc } from "../src/server/docs.ts";
import { cleanTarget, cleanTweaks } from "../src/server/extensions/design.ts";
import { createHandler } from "../src/server/http.ts";
import { BUILT_IN_MODULES, BUILT_IN_TOOLS } from "../src/server/reload.ts";
import { landing, publishAll, publishDesign } from "./design-fixtures.ts";

let app: Awaited<ReturnType<typeof openApp>>;
let server: Server;
let base = "";
let session: ConversationId;
let other: ConversationId;
const people: Record<string, { token: string; id: string }> = {};

const TARGET = {
    pid: "headline",
    selector: '[data-pid="headline"]',
    tag: "h1",
    text: "Fresh coffee",
    html: "<h1>Fresh coffee</h1>",
    rect: { x: 1, y: 2, width: 300, height: 40 },
    styles: { color: "red", "font-size": "38px", "not a style": "x" },
    onclick: "alert(1)",
};

before(async () => {
    app = await openApp(scriptedModel(), join(root, "data"));
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    session = await newSession(app);
    other = await newSession(app);
    await publishAll(app, session);
    await publishDesign(app, other, { id: "elsewhere", title: "Elsewhere", content: landing("x") });

    for (const [name, role, sessions] of [
        ["Gale", "guest", undefined],
        ["Vic", "viewer", undefined],
        ["Sid", "guest", [String(session)]],
    ] as const) {
        const added = app.config.addUser(name, role, sessions ? [...sessions] : undefined);

        people[name] = { token: added.token, id: added.user.id };
    }

    people.owner = { token: app.config.ownerToken, id: owner(app).id };
});

after(async () => {
    server.closeAllConnections();
    server.close();
    await app.close();
    cleanUp();
});

async function call(who: string, path: string, body?: unknown, method?: string) {
    const response = await fetch(`${base}/api/x/design/${path}`, {
        method: method ?? (body === undefined ? "GET" : "POST"),
        headers: {
            authorization: `Bearer ${people[who]!.token}`,
            "x-pocket": "1",
            ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    return { status: response.status, data: (await response.json()) as Record<string, any> };
}

const designs = async (who = "owner", id = session) =>
    (await call(who, `c/${id}/artifacts`)).data.artifacts as {
        id: string;
        title: string;
        group?: string;
        kind: string;
        versions: { version: number; restoredFrom?: number }[];
    }[];

const notes = async (who = "owner", artifact = "landing") =>
    (await call(who, `c/${session}/designs/${artifact}`)).data as {
        comments: {
            id: string;
            text: string;
            by: string;
            version: number;
            resolved?: object;
            target: any;
        }[];
        tweaks: Record<string, unknown> | null;
    };

test("the module is built in, with its names reserved", () => {
    assert.ok(BUILT_IN_MODULES.has("design"));

    for (const tool of ["design_preview", "design_export", "design_system"]) {
        assert.ok(BUILT_IN_TOOLS.has(tool), tool);
    }

    assert.ok(app.webs.commands().some((command) => command.name === "design-open"));
});

test("the session's HTML designs, with their groups, kinds, and versions: for everyone who sees every session", async () => {
    const list = await designs();

    assert.deepEqual(list.map((each) => each.id).sort(), [
        "hero-a",
        "hero-b",
        "hero-c",
        "landing",
        "pitch",
    ]);
    assert.equal(list.find((each) => each.id === "pitch")!.kind, "deck");
    assert.equal(list.find((each) => each.id === "landing")!.kind, "page");
    assert.equal(list.find((each) => each.id === "hero-b")!.group, "hero");
    assert.deepEqual(
        list.find((each) => each.id === "landing")!.versions.map((each) => each.version),
        [1, 2, 3],
    );
    assert.deepEqual(await designs("Vic"), list);
    assert.deepEqual(await designs("Gale"), list);
    // Another session's designs are that session's.
    assert.deepEqual(
        (await designs("owner", other)).map((each) => each.id),
        ["elsewhere"],
    );
});

test("a session a person cannot see, and a module that is for the whole app, stay shut to them", async () => {
    // Invited to one session: a module's web part belongs to the whole app, so there is none.
    assert.equal((await call("Sid", `c/${session}/artifacts`)).status, 404);
    assert.equal((await call("owner", "c/99999/artifacts")).status, 404);
});

test("comments are shared, shape-checked, and only people who steer write them", async () => {
    const added = await call("owner", `c/${session}/designs/landing/comments`, {
        version: 3,
        text: "  Shorter, please\n\n",
        target: TARGET,
    });

    assert.equal(added.status, 200);

    const comment = added.data.comment as {
        id: string;
        by: string;
        byName: string;
        target: any;
        text: string;
    };

    assert.equal(comment.text, "Shorter, please");
    assert.equal(comment.by, people.owner!.id);
    // The page's own fields only, in a fixed shape.
    assert.equal(comment.target.onclick, undefined);
    assert.equal(comment.target.pid, "headline");
    assert.deepEqual(comment.target.styles, { color: "red", "font-size": "38px" });

    // Everyone sees it; a viewer cannot write, and neither can someone with no such session.
    for (const who of ["owner", "Gale", "Vic"]) {
        assert.deepEqual(
            (await notes(who)).comments.map((each) => each.text),
            ["Shorter, please"],
        );
    }

    const viewer = await call("Vic", `c/${session}/designs/landing/comments`, {
        version: 3,
        text: "Nope",
        target: TARGET,
    });

    // A route for those who steer is not there for a viewer.
    assert.equal(viewer.status, 404);

    // Bad input: no element, no words, a version that is not there, an artifact that is not one.
    const path = `c/${session}/designs/landing/comments`;

    assert.equal((await call("owner", path, { version: 3, text: "x", target: {} })).status, 400);
    assert.equal(
        (await call("owner", path, { version: 3, text: "  ", target: TARGET })).status,
        400,
    );
    assert.equal(
        (await call("owner", path, { version: 9, text: "x", target: TARGET })).status,
        400,
    );
    assert.equal(
        (
            await call("owner", `c/${session}/designs/nope/comments`, {
                version: 1,
                text: "x",
                target: TARGET,
            })
        ).status,
        404,
    );
    assert.equal(
        (
            await call("owner", `c/${session}/designs/__proto__/comments`, {
                version: 1,
                text: "x",
                target: TARGET,
            })
        ).status,
        404,
    );
});

test("anyone who steers marks a comment done; only its author or the owner deletes or rewords it", async () => {
    const path = `c/${session}/designs/landing/comments`;
    const made = await call("Gale", path, { version: 2, text: "Gale's note", target: TARGET });
    const id = (made.data.comment as { id: string }).id;

    // The owner's comment is not Gale's to delete, but she may mark it done.
    const first = (await notes()).comments.find((each) => each.text === "Shorter, please")!;

    assert.equal((await call("Gale", `${path}/${first.id}`, undefined, "DELETE")).status, 403);
    assert.equal((await call("Gale", `${path}/${first.id}`, { text: "changed" })).status, 403);
    assert.equal((await call("Gale", `${path}/${first.id}`, { resolved: true })).status, 200);
    assert.ok((await notes("Vic")).comments.find((each) => each.id === first.id)!.resolved);
    assert.equal((await call("Gale", `${path}/${first.id}`, { resolved: false })).status, 200);
    assert.equal(
        (await notes()).comments.find((each) => each.id === first.id)!.resolved,
        undefined,
    );

    // The owner deletes anyone's; a viewer nobody's.
    assert.equal((await call("Vic", `${path}/${id}`, undefined, "DELETE")).status, 404);
    assert.equal((await call("owner", `${path}/${id}`, undefined, "DELETE")).status, 200);
    assert.equal((await call("owner", `${path}/${id}`, undefined, "DELETE")).status, 404);

    // All of a list at once, for after "Send to Pi".
    const again = await call("owner", path, { version: 3, text: "More", target: TARGET });
    const ids = [first.id, (again.data.comment as { id: string }).id];

    assert.equal(
        (await call("owner", `c/${session}/designs/landing/resolve`, { ids })).data.resolved,
        2,
    );
    assert.ok((await notes()).comments.every((each) => each.resolved !== undefined));
    assert.equal(
        (await call("owner", `c/${session}/designs/landing/resolve`, { ids: "all" })).status,
        400,
    );
});

test("a design keeps up to 200 comments", async () => {
    const path = `c/${session}/designs/pitch/comments`;

    // In groups of 50 at once, to keep the test quick: each is a commit of its own.
    for (let first = 0; first < 200; first += 50) {
        await Promise.all(
            Array.from({ length: 50 }, (_, at) =>
                call("owner", path, { version: 1, text: `c${first + at}`, target: TARGET }),
            ),
        );
    }

    assert.equal((await notes("owner", "pitch")).comments.length, 200);
    assert.equal(
        (await call("owner", path, { version: 1, text: "one too many", target: TARGET })).status,
        409,
    );
});

test("tweaks are each person's own, replaced as a whole, and checked", async () => {
    const path = `c/${session}/designs/landing/tweaks`;

    assert.equal(
        (
            await call("owner", path, {
                values: { "--accent": "#ff0000", "--radius": 20, shout: true },
            })
        ).status,
        200,
    );
    assert.equal((await call("Gale", path, { values: { "--accent": "#00ff00" } })).status, 200);
    assert.deepEqual((await notes("owner")).tweaks, {
        "--accent": "#ff0000",
        "--radius": 20,
        shout: true,
    });
    assert.deepEqual((await notes("Gale")).tweaks, { "--accent": "#00ff00" });
    // A viewer sees none of theirs: nothing to write.
    assert.equal((await notes("Vic")).tweaks, null);
    assert.equal((await call("Vic", path, { values: { a: 1 } })).status, 404);

    // Not a value, too many. A name that is not kept is left out, and the rest stay.
    assert.equal((await call("owner", path, { values: { a: { b: 1 } } })).status, 400);
    assert.equal(
        (await call("owner", path, { values: { "bad name": 1, "--": 1, "--ok": 2 } })).status,
        200,
    );
    assert.deepEqual((await notes("owner")).tweaks, { "--ok": 2 });
    assert.equal(
        (
            await call("owner", path, {
                values: Object.fromEntries(Array.from({ length: 41 }, (_, at) => [`k${at}`, at])),
            })
        ).status,
        400,
    );
    assert.equal((await call("owner", path, { values: [1] })).status, 400);

    // Clearing: null, or nothing.
    assert.equal((await call("owner", path, { values: null })).status, 200);
    assert.equal((await notes("owner")).tweaks, null);
    assert.deepEqual((await notes("Gale")).tweaks, { "--accent": "#00ff00" });
});

test("go back to this one: a new version with the old content, once for each key", async () => {
    const path = `c/${session}/designs/landing/restore`;
    const key = "key-0001-aaaa";
    const first = await call("owner", path, { version: 1, key });

    assert.equal(first.status, 200);
    assert.equal(first.data.version, 4);

    const bodyOf = async (version: number) =>
        (
            await app.harness.snapshot(
                ArtifactBodyDoc,
                session,
                `landing@${version}`,
                BACKGROUND_CONTEXT,
            )
        )?.content;

    assert.equal(await bodyOf(4), await bodyOf(1));
    assert.notEqual(await bodyOf(4), await bodyOf(3));

    // The same tap again finds the version it made.
    assert.equal((await call("owner", path, { version: 1, key })).data.version, 4);
    assert.equal((await designs()).find((each) => each.id === "landing")!.versions.length, 4);
    assert.equal(
        (await designs("Vic")).find((each) => each.id === "landing")!.versions[3]!.restoredFrom,
        1,
    );

    // The new version is the artifact's newest, as any publish would leave it.
    const index = await app.harness.snapshot(ArtifactsDoc, session, BACKGROUND_CONTEXT);

    assert.equal(index?.items.landing!.versions.at(-1)!.version, 4);
    assert.equal(index?.items.landing!.versions.at(-1)!.callId, `design-restore:${key}`);

    // Not the newest itself, nor one that is not there; a viewer cannot.
    assert.equal((await call("owner", path, { version: 4, key: "key-0002-bbbb" })).status, 409);
    assert.equal((await call("owner", path, { version: 9, key: "key-0003-cccc" })).status, 404);
    assert.equal((await call("owner", path, { version: 1 })).status, 400);
    assert.equal((await call("owner", path, { version: 1, key: "no" })).status, 400);
    assert.equal((await call("Vic", path, { version: 2, key: "key-0004-dddd" })).status, 404);

    // A second restore makes version 5, and the document keeps what it was told.
    assert.equal((await call("Gale", path, { version: 2, key: "key-0005-eeee" })).data.version, 5);
    assert.equal(
        (await app.harness.snapshot(DesignCommentsDoc, session, BACKGROUND_CONTEXT))?.items.landing!
            .restores?.["5"],
        2,
    );
});

test("what a page says about an element is cut to a fixed shape", () => {
    const web = {
        error: (status: number, message: string) => Object.assign(new Error(message), { status }),
    };
    const clean = cleanTarget(web, {
        selector: "a".repeat(900),
        tag: "DIV",
        text: "t".repeat(900),
        html: "h".repeat(5000),
        rect: { x: Infinity, y: "no", width: 10.123, height: 2 },
        styles: { color: "red", "bad key!": "x", "font-size": 4 },
    });

    assert.equal(clean.selector.length, 500);
    assert.equal(clean.tag, "div");
    assert.equal(clean.text.length, 200);
    assert.equal(clean.html.length, 1000);
    assert.deepEqual(clean.rect, { x: 0, y: 0, width: 10.1, height: 2 });
    // A number that is finite but huge stays finite once rounded: the document takes only plain JSON.
    const huge = cleanTarget(web, {
        selector: "a",
        rect: { x: 1e308, y: -1e308, width: 1, height: 1 },
    });

    assert.ok(Number.isFinite(huge.rect.x * 10) && Number.isFinite(huge.rect.y * 10));
    assert.deepEqual(clean.styles, { color: "red" });
    assert.throws(() => cleanTarget(web, null), /points at an element/);
    assert.throws(() => cleanTarget(web, { selector: "" }), /points at an element/);
    assert.deepEqual(cleanTweaks(web, { "--a": "x".repeat(900), b: 2, c: false }), {
        "--a": "x".repeat(500),
        b: 2,
        c: false,
    });
    assert.throws(() => cleanTweaks(web, { a: null }), /text, a number/);
});

test("export is the agent side's route, there for people who steer and not for a viewer", async () => {
    const body = { id: "no-such-design", format: "png" };
    const path = `c/${session}/export`;

    // A design that is not there: a 4xx from its own route, never a 404 for the route.
    const owned = await call("owner", path, body);

    assert.ok(owned.status >= 400 && owned.status < 500);
    assert.notEqual(owned.data.error, "Unknown extension route");
    assert.equal((await call("Vic", path, body)).status, 404);

    // While people take turns, only the driver exports.
    await app.collab.turns(session, owner(app), { action: "on" });
    assert.equal((await call("Gale", path, body)).status, 409);
    await app.collab.turns(session, owner(app), { action: "off" });
});

test("a design with nothing kept leaves no item behind, so empty ones never use up the places", async () => {
    const items = async () =>
        Object.keys(
            (await app.harness.snapshot(DesignCommentsDoc, other, BACKGROUND_CONTEXT))?.items ?? {},
        );
    const path = `c/${other}/designs/elsewhere`;

    // Clearing what was never saved makes nothing; saving and clearing leaves nothing.
    assert.equal((await call("owner", `${path}/tweaks`, { values: {} })).status, 200);
    assert.equal((await call("owner", `${path}/tweaks`, { values: null })).status, 200);
    assert.deepEqual(await items(), []);
    assert.equal((await call("owner", `${path}/tweaks`, { values: { a: 1 } })).status, 200);
    assert.deepEqual(await items(), ["elsewhere"]);
    assert.equal((await call("owner", `${path}/tweaks`, { values: {} })).status, 200);
    assert.deepEqual(await items(), []);

    // The last comment deleted takes the item with it.
    const made = await call("owner", `${path}/comments`, { version: 1, text: "x", target: TARGET });

    assert.deepEqual(await items(), ["elsewhere"]);
    await call(
        "owner",
        `${path}/comments/${(made.data.comment as { id: string }).id}`,
        undefined,
        "DELETE",
    );
    assert.deepEqual(await items(), []);
});
