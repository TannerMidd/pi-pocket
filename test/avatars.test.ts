// Profile pictures: set, shown to others by version, refused when not a picture, removed.
import { cleanUp, newSession, openApp, root, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createHandler } from "../src/server/http.ts";

let app: Awaited<ReturnType<typeof openApp>>;
let server: Server;
let base = "";
let owner = "";
let guest = { id: "", token: "" };

// A 1x1 PNG.
const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
);

before(async () => {
    app = await openApp(scriptedModel(), join(root, "avatar-data"));
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    owner = app.config.ownerToken;
    const added = app.config.addUser("Gale", "guest");

    guest = { id: added.user.id, token: added.token };
});

after(async () => {
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

const call = (token: string, path: string, method: string, body?: Buffer) =>
    fetch(`${base}${path}`, {
        method,
        body: body === undefined ? undefined : new Uint8Array(body),
        headers: { authorization: `Bearer ${token}`, "x-pocket": "1" },
    });
const people = async () =>
    (await (await call(owner, "/api/users", "GET")).json()) as { id: string; avatar?: number }[];

test("a picture is set, seen by others, and removed", async () => {
    assert.equal((await call(guest.token, "/api/me/avatar", "POST", PNG)).status, 200);
    const version = (await people()).find((each) => each.id === guest.id)?.avatar;

    assert.equal(typeof version, "number");
    const seen = await call(owner, `/api/avatar/${guest.id}?v=${version}`, "GET");

    assert.equal(seen.status, 200);
    assert.equal(seen.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await seen.arrayBuffer()), PNG);

    assert.equal((await call(guest.token, "/api/me/avatar", "DELETE")).status, 200);
    assert.equal((await people()).find((each) => each.id === guest.id)?.avatar, undefined);
    assert.equal((await call(owner, `/api/avatar/${guest.id}`, "GET")).status, 404);
});

test("only pictures of an allowed type and size are kept", async () => {
    const text = await call(guest.token, "/api/me/avatar", "POST", Buffer.from("<svg onload=x>"));

    assert.equal(text.status, 415);
    assert.equal((await call(guest.token, "/api/me/avatar", "POST", Buffer.alloc(0))).status, 400);
    const big = Buffer.concat([PNG, Buffer.alloc(600 * 1024)]);

    assert.equal((await call(guest.token, "/api/me/avatar", "POST", big)).status, 413);
    assert.equal((await people()).find((each) => each.id === guest.id)?.avatar, undefined);
});

test("a picture is for people who share a session with its owner, and for people signed in", async () => {
    assert.equal((await call(guest.token, "/api/me/avatar", "POST", PNG)).status, 200);
    const mine = await newSession(app);
    const other = await newSession(app);
    const sam = app.config.addUser("Sam", "guest", [String(mine)]);
    const eve = app.config.addUser("Eve", "guest", [String(other)]);

    app.config.updateUser(guest.id, { sessions: [String(other)] });

    assert.equal((await call(eve.token, `/api/avatar/${guest.id}`, "GET")).status, 200);
    // Sam shares no session with the owner of the picture: it is as if the person did not exist.
    assert.equal((await call(sam.token, `/api/avatar/${guest.id}`, "GET")).status, 404);
    assert.equal((await fetch(`${base}/api/avatar/${guest.id}`)).status, 401);
    assert.equal((await fetch(`${base}/api/me/avatar`, { method: "POST", body: PNG })).status, 401);
    app.config.updateUser(guest.id, { sessions: undefined });
    await call(guest.token, "/api/me/avatar", "DELETE");
});

test("removing a person removes their picture", async () => {
    const gone = app.config.addUser("Gone", "guest");

    assert.equal((await call(gone.token, "/api/me/avatar", "POST", PNG)).status, 200);
    const file = join(app.dataDir, "avatars", gone.user.id);

    assert.equal(existsSync(file), true);
    app.removeUser(app.config.userById(app.config.users[0]!.id)!, gone.user.id);
    assert.equal(existsSync(file), false);
});
