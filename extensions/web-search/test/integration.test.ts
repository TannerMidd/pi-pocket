// Optional integration against an unmodified Pi Pocket 0.20 source checkout, with isolated data and scripted models.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { cpSync, mkdirSync } from "node:fs";
import { IncomingMessage, ServerResponse } from "node:http";
import { Duplex } from "node:stream";
import { once } from "node:events";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const source = process.env.PI_POCKET_SOURCE;

if (!source) {
    test(
        "Pi Pocket 0.20 integration",
        { skip: "Set PI_POCKET_SOURCE to an unmodified 0.20 source checkout" },
        () => {},
    );
} else {
    const helpers = await import(pathToFileURL(join(source, "test/helpers.ts")).href);
    const { createHandler } = await import(pathToFileURL(join(source, "src/server/http.ts")).href);
    const { shareDraft } = await import(
        pathToFileURL(join(source, "src/server/gallery/share.ts")).href
    );
    const { createPublicFetch } = await import(
        pathToFileURL(join(source, "src/server/public-fetch.ts")).href
    );

    after(helpers.cleanUp);

    test("unmodified 0.20 installs the extension off, enforces owner-only routes, validates sharing and removes its routes", async () => {
        const dataDir = join(helpers.root, "web-search-integration");
        const dropIn = join(dataDir, "extensions");
        const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));

        mkdirSync(dropIn, { recursive: true });
        cpSync(join(packageDir, "web-search.ts"), join(dropIn, "web-search.ts"));
        cpSync(join(packageDir, "web-search"), join(dropIn, "web-search"), { recursive: true });
        const app = await helpers.openApp(helpers.scriptedModel(), dataDir);
        const handler = createHandler({
            app,
            listen: { host: "127.0.0.1", port: 0 },
            restart: () => {},
        });

        // Native HTTP objects over an in-memory socket: no TCP listener or external requests.
        const call = async (token: string, path = "state", body?: unknown) => {
            const socket = new Duplex({
                read() {},
                write(_chunk, _encoding, done) {
                    done();
                },
            });
            const request = new IncomingMessage(socket as never);

            request.url = `/api/x/web-search/${path}`;
            request.method = body === undefined ? "GET" : "POST";
            request.headers = {
                authorization: `Bearer ${token}`,
                "x-pocket": "1",
                "content-type": "application/json",
            };

            if (body !== undefined) {
                request.push(Buffer.from(JSON.stringify(body)));
            }

            request.push(null);
            request.complete = true;
            const response = new ServerResponse(request);

            response.assignSocket(socket as never);
            const finished = once(response, "finish");

            await handler(request, response);
            await finished;

            return { status: response.statusCode };
        };

        try {
            const initial = app.loader.list().find((m: any) => m.file === "web-search.ts");

            assert.equal(initial?.enabled, false);
            await app.setExtensionEnabled(helpers.owner(app), "web-search.ts", true);
            const module = app.loader.list().find((m: any) => m.file === "web-search.ts");

            assert.equal(module.error, undefined);
            assert.equal(module.web.access, "owner");
            assert.equal((await call(app.config.ownerToken)).status, 200);

            for (const role of ["guest", "viewer"]) {
                const user = app.config.addUser(role, role);

                assert.equal((await call(user.token)).status, 404);
                assert.equal((await call(user.token, "state", { enabled: false })).status, 404);
                assert.equal((await call(user.token, "test", { provider: "tavily" })).status, 404);
                assert.equal((await call(user.token, "search", { query: "q" })).status, 404);
            }

            assert.equal((await call(app.config.ownerToken)).status, 200);
            assert.equal(
                (
                    await call(app.config.ownerToken, "state", {
                        providerSettings: { exa: { mode: "invalid" } },
                    })
                ).status,
                400,
            );
            assert.equal((await call(app.config.ownerToken, "search", { query: "" })).status, 400);
            const shared = await shareDraft({
                root: dropIn,
                module,
                owner: "piromagnus",
                repoUrl: null,
                packages: new Set(["@earendil-works/pi-ai", "@earendil-works/pi-durable"]),
                version: "0.20.0",
            });

            assert.deepEqual(shared.problems, []);
            assert.equal(shared.entry.minPocket, "0.20.0");
            assert.equal(shared.entry.pocketApi, 2);
            assert.equal(shared.entry.declares.access, "owner");
            await app.setExtensionEnabled(helpers.owner(app), "web-search.ts", false);
            assert.equal((await call(app.config.ownerToken)).status, 404);
        } finally {
            await app.close();
        }
    });

    test("the real host network guard rejects non-public destinations before connecting", async () => {
        const fetchPublic = createPublicFetch();

        for (const url of [
            "http://127.0.0.1",
            "http://169.254.169.254",
            "http://100.64.0.1",
            "http://[::ffff:127.0.0.1]",
        ]) {
            await assert.rejects(
                () => fetchPublic(url),
                (error: any) => error.code === "POCKET_NOT_PUBLIC",
            );
        }
    });
}
