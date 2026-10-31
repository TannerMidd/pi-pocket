// The Updates module's routes and browser module: on by default, and the owner's alone.
import { cleanUp, openApp, root, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createHandler } from "../src/server/http.ts";
import { pocketVersion } from "../src/server/versions.ts";

let app: Awaited<ReturnType<typeof openApp>>;
let server: Server;
let base = "";
const tokens: Record<string, string> = {};

before(async () => {
    app = await openApp(scriptedModel(), join(root, "updates-data"));
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    tokens.owner = app.config.ownerToken;
    tokens.guest = app.config.addUser("Gale", "guest").token;
});

after(async () => {
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

const call = async (who: string, path: string, body?: unknown, method?: string) => {
    const response = await fetch(`${base}${path}`, {
        method: method ?? (body === undefined ? "GET" : "POST"),
        headers: {
            authorization: `Bearer ${tokens[who]}`,
            "x-pocket": "1",
            ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    return { status: response.status, data: (await response.json().catch(() => null)) as never };
};

test("the owner reads the running version, and nobody else reaches the routes or the browser module", async () => {
    assert.ok(app.loader.extensionNames().includes("pocket-updates"), "on by default");

    const status = await call("owner", "/api/x/updates/status");

    assert.equal(status.status, 200);
    assert.equal((status.data as { version: string }).version, pocketVersion());
    assert.equal((status.data as { available: boolean }).available, false, "nothing checked yet");
    assert.equal((status.data as { supervised: boolean }).supervised, false);

    assert.equal((await call("guest", "/api/x/updates/status")).status, 404);
    assert.equal((await call("guest", "/api/x/updates/apply", {})).status, 404);

    const ui = async (who: string) =>
        (
            (await call(who, "/api/me")).data as { server: { ui: { module: string }[] } }
        ).server.ui.map((each) => each.module);

    assert.ok((await ui("owner")).includes("updates"));
    assert.ok(!(await ui("guest")).includes("updates"));
});

test("Beta updates is an owner setting, off by default, that turns the beta channel on and off", async () => {
    const settings = await call("owner", "/api/extension-settings/updates");

    assert.equal(settings.status, 200);
    assert.equal(
        (settings.data as { fields: { name: string }[] }).fields.some(
            (each) => each.name === "beta",
        ),
        true,
    );
    assert.equal((settings.data as { values: { beta: boolean } }).values.beta, false);
    assert.equal(app.updates.beta, false);
    assert.equal(
        ((await call("owner", "/api/x/updates/status")).data as { beta: boolean }).beta,
        false,
    );

    assert.equal(
        (await call("guest", "/api/extension-settings/updates", { beta: true }, "PUT")).status,
        403,
    );
    assert.equal(app.updates.beta, false, "only the owner changes it");

    assert.equal(
        (await call("owner", "/api/extension-settings/updates", { beta: true }, "PUT")).status,
        200,
    );
    assert.equal(app.updates.beta, true);
    assert.equal(
        ((await call("owner", "/api/x/updates/status")).data as { beta: boolean }).beta,
        true,
    );

    await call("owner", "/api/extension-settings/updates", { beta: null, check: null }, "PUT");
    assert.equal(app.updates.beta, false, "the default puts it back off");
});
