// Stage 2: the locale catalog uses a real temporary app and HTTP server, including each person's existing ACL.
import { type App, cleanUp, newSession, openApp, owner, root, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createHandler } from "../src/server/http.ts";

const data = join(root, "locale-http");
const dropIns = join(data, "extensions");
const people: Record<string, string> = {};
let app: App;
let server: Server;
let base = "";

before(async () => {
    mkdirSync(dropIns, { recursive: true });
    writeFileSync(
        join(dropIns, "synthetic-locale.ts"),
        `/** Public test language; the route is still restricted by its own access. */
export default (_host, web) => {
    web.uiLocales([{ id: "fr", label: "Français", messages: { "ui.close": "Fermer" } }]);
    web.route("GET", "view", () => ({ marker: "module-view" }), { access: "view" });
};
`,
    );
    app = await openApp(scriptedModel(), data);
    const session = await newSession(app);

    people.owner = app.config.ownerToken;
    people.guest = app.config.addUser("Guest", "guest").token;
    people.viewer = app.config.addUser("Viewer", "viewer").token;
    people.single = app.config.addUser("Single viewer", "viewer", [String(session)]).token;
    await app.setExtensionEnabled(owner(app), "synthetic-locale.ts", true);
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

async function request(path: string, who?: string, method = "GET"): Promise<Response> {
    return fetch(`${base}${path}`, {
        method,
        headers: {
            ...(who === undefined ? {} : { authorization: `Bearer ${people[who]}` }),
            "x-pocket": "1",
        },
    });
}

test("R23: the real catalog is public to every role without exposing private fields or changing module ACL", async () => {
    const results = await Promise.all(
        [undefined, "owner", "guest", "viewer", "single"].map(async (who) => {
            const response = await request("/ui-locales.json", who);

            assert.equal(response.status, 200, `catalog is public to ${who ?? "anonymous"}`);
            assert.match(response.headers.get("content-type") ?? "", /^application\/json\b/);
            assert.match(response.headers.get("cache-control") ?? "", /\bno-store\b/);

            return response.json() as Promise<{
                revision: number;
                locales: { id: string; label: string; messages: Record<string, string> }[];
            }>;
        }),
    );
    const catalog = results[0]!;

    assert.ok(Number.isInteger(catalog.revision));
    assert.deepEqual(Object.keys(catalog).sort(), ["locales", "revision"]);
    assert.deepEqual(
        catalog.locales.map((each) => each.id),
        ["en", "fr"],
    );
    assert.equal(catalog.locales[1]?.messages["ui.close"], "Fermer");

    for (const each of catalog.locales) {
        assert.deepEqual(Object.keys(each).sort(), ["id", "label", "messages"]);
    }

    assert.ok(results.every((value) => JSON.stringify(value) === JSON.stringify(catalog)));
    const encoded = JSON.stringify(catalog);

    for (const token of Object.values(people)) {
        assert.ok(!encoded.includes(token), "catalog does not contain credentials");
    }

    assert.ok(!encoded.includes(data), "catalog does not contain the temporary data path");
    assert.equal((await request("/api/x/synthetic-locale/view", "owner")).status, 200);
    assert.equal((await request("/api/x/synthetic-locale/view", "guest")).status, 200);
    assert.equal((await request("/api/x/synthetic-locale/view", "viewer")).status, 200);
    assert.equal((await request("/api/x/synthetic-locale/view", "single")).status, 404);
    assert.equal((await request("/api/x/synthetic-locale/view")).status, 401);
});

test("R24: GET is read-only and other methods cannot change configuration or the catalog", async () => {
    const beforeConfig = readFileSync(join(data, "config.json"));
    const before = app.webs.locales.snapshot();
    const get = await request("/ui-locales.json");

    assert.equal(get.status, 200, "the catalog GET exists");
    assert.deepEqual(await get.json(), JSON.parse(JSON.stringify(before)));

    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        const response = await request("/ui-locales.json", "owner", method);

        assert.ok(response.status >= 400, `${method} is rejected`);
    }

    assert.deepEqual(readFileSync(join(data, "config.json")), beforeConfig);
    assert.deepEqual(app.webs.locales.snapshot(), before);
});
