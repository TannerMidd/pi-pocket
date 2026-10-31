// A file of a session's folder as a download: for whom the file viewer lets read it, never past a link or the folder.
import { type App, cleanUp, newSession, openApp, scriptedModel, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";

let app: App;
let server: Server;
let port = 0;
let id: ConversationId;

before(async () => {
    app = await openApp(scriptedModel());

    const { createHandler } = await import("../src/server/http.ts");

    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
    id = await newSession(app);
    mkdirSync(join(work, "exports"), { recursive: true });
    writeFileSync(join(work, "exports", "deck-v2.pptx"), Buffer.from([0x50, 0x4b, 3, 4, 0, 255]));
    writeFileSync(join(work, "exports", 'odd "name"\n.png'), "png");
});

after(async () => {
    server.closeAllConnections();
    server.close();
    await app.close();
    cleanUp();
});

function download(path: string, token = app.config.ownerToken) {
    return fetch(`http://127.0.0.1:${port}/api/c/${id}/download?path=${encodeURIComponent(path)}`, {
        headers: { authorization: `Bearer ${token}` },
    });
}

test("a session file downloads as it is, as an attachment that no browser runs", async () => {
    const response = await download("exports/deck-v2.pptx");

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/octet-stream");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.match(
        response.headers.get("content-disposition")!,
        /^attachment; filename="deck-v2.pptx"/,
    );
    assert.deepEqual(
        Buffer.from(await response.arrayBuffer()),
        Buffer.from([0x50, 0x4b, 3, 4, 0, 255]),
    );

    // No quote or line break of a name gets into the header.
    const odd = await download('exports/odd "name"\n.png');

    assert.equal(odd.status, 200);
    assert.doesNotMatch(odd.headers.get("content-disposition")!, /\n|"name"/);
});

test("a download needs a sign-in, a file, and, for a viewer, a file in the session's folder", async () => {
    const anonymous = await fetch(
        `http://127.0.0.1:${port}/api/c/${id}/download?path=exports/deck-v2.pptx`,
    );

    assert.equal(anonymous.status, 401);
    assert.equal((await download("exports/missing.pptx")).status, 404);
    assert.equal((await download("exports")).status, 404);
    assert.equal((await download("")).status, 400);

    const outside = join(work, "..", "outside-download.txt");

    writeFileSync(outside, "secret");
    symlinkSync(outside, join(work, "exports", "link.txt"));

    // A link at the file is not followed, for anyone.
    assert.equal((await download("exports/link.txt")).status, 404);

    const viewer = app.config.addUser("Viewer", "viewer").token;

    assert.equal((await download("exports/deck-v2.pptx", viewer)).status, 200);
    assert.equal((await download(outside, viewer)).status, 404);
});
