import { type App, cleanUp, openApp, root, scriptedModel, until } from "./helpers.ts";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import { createHandler } from "../src/server/http.ts";

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
} as const;

let app: App | undefined;
let server: Server | undefined;
let browsers: Browsers | undefined;

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test("a file of the app that a blocker stops shows on the boot screen (#249)", real, async () => {
    app = await openApp(scriptedModel());
    const handle = createHandler({
        app,
        listen: { host: "127.0.0.1", port: 0 },
        restart: () => {},
    });

    server = createServer((request, response) => {
        if (request.url?.startsWith("/text-hash.js")) {
            response.writeHead(403).end();

            return;
        }

        handle(request, response);
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "boot-failure-ui-")),
        load: async () => undefined,
        save: () => {},
    });
    const page = await browsers.open(1);

    await page.navigate(`http://127.0.0.1:${(server.address() as { port: number }).port}/`);
    await until(
        async () =>
            JSON.parse(
                await page.evaluate(
                    `return JSON.stringify(document.querySelector(".boot.failed .boot-detail")?.textContent ?? "")`,
                ),
            ).includes("did not load"),
        "the boot screen to say a file did not load",
    );
});
