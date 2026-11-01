import { cleanUp, newSession, openApp, root, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { CheckFinding, CheckReport } from "../src/server/design/system-types.ts";
import { createHandler } from "../src/server/http.ts";
import { loadDesignSystem } from "../src/server/extensions/design/system-api.ts";
import { publishDesign } from "./design-fixtures.ts";
import { ferryPage, writeSystemFixture } from "./design-system-fixtures.ts";

let app: Awaited<ReturnType<typeof openApp>>;
let server: Server;
let base = "";
let session: ConversationId;

before(async () => {
    app = await openApp(scriptedModel(), join(root, "data"));
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const folder = join(root, "with-system");

    mkdirSync(folder, { recursive: true });
    writeSystemFixture(folder);
    session = await newSession(app, folder);
    await publishDesign(app, session, {
        id: "ferry",
        title: "Ferry booking",
        content: ferryPage(loadDesignSystem(folder)!.compiled.css),
    });
    // A grey that reads on the light canvas (5.9:1) and not on the dark one (3.2:1).
    await publishDesign(app, session, {
        id: "scheme",
        title: "Scheme",
        content: `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><style>${loadDesignSystem(folder)!.compiled.css}body{margin:0;background:var(--color-bg-canvas)}</style><p data-pid="low" style="margin:0;padding:var(--space-4);color:#5d647d">Quiet words</p>`,
    });
});

after(async () => {
    server.closeAllConnections();
    server.close();
    await app.close();
    cleanUp();
});

async function check(body: object): Promise<CheckReport> {
    const response = await fetch(`${base}/api/x/design/c/${session}/system/check`, {
        method: "POST",
        headers: {
            authorization: `Bearer ${app.config.ownerToken}`,
            "x-pocket": "1",
            "content-type": "application/json",
        },
        body: JSON.stringify({ id: "scheme", viewport: "mobile", ...body }),
    });

    assert.equal(response.status, 200);

    return ((await response.json()) as { report: CheckReport }).report;
}

const low = (report: CheckReport): CheckFinding | undefined =>
    report.findings.find((item) => item.rule === "contrast" && item.pid === "low");

test(
    "the check runs in the scheme it is given, and judges the page as that scheme draws it",
    { skip: findBrowser() === undefined, timeout: 120_000 },
    async () => {
        const light = await check({ colorScheme: "light" });
        const dark = await check({ colorScheme: "dark" });

        assert.equal(light.colorScheme, "light");
        assert.equal(dark.colorScheme, "dark");
        assert.equal(low(light), undefined, "5.9:1 on the light canvas");
        assert.equal(low(dark)!.level, "error", "3.2:1 on the dark canvas");
        const none = await check({});

        assert.equal(none.colorScheme, "light");
        assert.equal(low(none), undefined);
    },
);

test(
    "a finding keeps its id from one run to the next, in either scheme",
    { skip: findBrowser() === undefined, timeout: 120_000 },
    async () => {
        const first = await check({ colorScheme: "light", id: "ferry" });
        const again = await check({ colorScheme: "light", id: "ferry" });
        const dark = await check({ colorScheme: "dark", id: "ferry" });

        assert.ok(first.findings.length > 0);
        assert.deepEqual(
            first.findings.map((item) => item.id),
            again.findings.map((item) => item.id),
        );
        assert.ok(first.findings.every((item) => /^[a-z-]+-[0-9a-f]{10}(-\d+)?$/.test(item.id!)));
        assert.equal(new Set(first.findings.map((item) => item.id)).size, first.findings.length);
        const note = (report: CheckReport) =>
            report.findings.find(
                (item) => item.rule === "off-system-color" && item.pid === "note",
            )!;

        assert.ok(note(first).id);
        assert.equal(note(first).id, note(dark).id);
    },
);
