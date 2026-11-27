// A link that a guest left in a sandboxed session's folder leads nowhere outside it, for the owner and for a steering
// guest without restrictions (whose file policy resolves a link to its real target): a mention, an image, a download,
// and the viewer. In a folder that no sandboxed session uses, links work as before.
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { createHandler } from "../src/server/http.ts";
import { FakeDriver } from "./gondolin-fake.ts";
import {
    cleanUp,
    context,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    type App,
} from "./helpers.ts";

const SEAM = Symbol.for("pi-pocket.gondolin.test-driver");
const SECRET = "HOST_SECRET_MARKER_91c2";
const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
    "base64",
);

let app: App;
let server: Server;
let base = "";
const requests: string[] = [];
const people: Record<string, { token: string; id: string }> = {};
let sandboxed: ConversationId;
let ordinary: ConversationId;

function linked(name: string): string {
    const outside = join(root, `${name}-outside`);
    const path = join(root, name);

    mkdirSync(outside, { recursive: true });
    mkdirSync(path, { recursive: true });
    writeFileSync(join(outside, "secret.txt"), `${SECRET}\n`);
    writeFileSync(join(outside, "image.png"), PNG);
    symlinkSync(join(outside, "secret.txt"), join(path, "mentioned.txt"));
    symlinkSync(join(outside, "image.png"), join(path, "pic.png"));

    return path;
}

before(async () => {
    (globalThis as Record<symbol, unknown>)[SEAM] = new FakeDriver();
    app = await openApp(
        scriptedModel((request) => {
            requests.push(JSON.stringify(request));

            return fauxAssistantMessage([fauxText("ok")]);
        }),
        join(root, "data"),
    );
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    await app.setExtensionEnabled(owner(app), "gondolin.ts", true);
    sandboxed = await newSession(app, linked("sandboxed-folder"));
    ordinary = await newSession(app, linked("ordinary-folder"));
    await app.sandboxes.set(sandboxed, owner(app), true);

    const gale = app.config.addUser("Gale", "guest");

    people.Gale = { token: gale.token, id: gale.user.id };
    people.owner = { token: app.config.ownerToken, id: owner(app).id };
});

after(async () => {
    (globalThis as Record<symbol, unknown>)[SEAM] = undefined;
    server.closeAllConnections();
    server.close();
    await app.close();
    cleanUp();
});

const get = (who: string, id: ConversationId, route: string, path: string) =>
    fetch(`${base}/api/c/${id}/${route}?path=${encodeURIComponent(path)}`, {
        headers: { authorization: `Bearer ${people[who]!.token}`, "x-pocket": "1" },
    });

async function mention(who: string, id: ConversationId): Promise<string> {
    const user = app.config.userById(people[who]!.id)!;

    requests.length = 0;
    const { submissionId } = await app.commands.submit(id, user, {
        text: "hello @mentioned.txt",
        requestId: crypto.randomUUID(),
        inlineFiles: true,
    });

    await (await app.harness.submission(submissionId, context))!.wait(context);

    return requests.join("\n");
}

for (const who of ["owner", "Gale"]) {
    test(`${who}: a link that leads outside a sandboxed folder gives no host file`, async () => {
        for (const route of ["view", "download"]) {
            const response = await get(who, sandboxed, route, "mentioned.txt");

            assert.notEqual(response.status, 200, route);
            assert.doesNotMatch(await response.text(), new RegExp(SECRET), route);
        }

        assert.equal((await get(who, sandboxed, "file", "pic.png")).status, 404);
        assert.doesNotMatch(await mention(who, sandboxed), new RegExp(SECRET));
    });

    test(`${who}: in a folder that no sandboxed session uses, a link works as before`, async () => {
        assert.match(
            await (await get(who, ordinary, "view", "mentioned.txt")).text(),
            new RegExp(SECRET),
        );
        assert.equal((await get(who, ordinary, "file", "pic.png")).status, 200);
        assert.match(await mention(who, ordinary), new RegExp(SECRET));
    });
}
