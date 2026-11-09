// A run that failed with no answer that says so (its compaction failed) shows a lasting line in the open session,
// until a run starts again. A failed answer says it under itself already: no second line.
import {
    type App,
    cleanUp,
    lastText,
    newSession,
    openApp,
    owner,
    root,
    say,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
} as const;

/** Whether a summary is cut off at its limit. */
let failSummary = true;

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";

const inPage = async <T>(script: string): Promise<T> => JSON.parse(await page.evaluate(script));
const failureLine = () =>
    inPage<string | null>(
        `return JSON.stringify(document.querySelector('[data-part="run-failure"]')?.textContent ?? null)`,
    );

before(async () => {
    if (chromium === undefined) {
        return;
    }

    const faux = fauxProvider({
        tokensPerSecond: 100_000,
        models: [{ id: "faux-1", contextWindow: 100_000, maxTokens: 32_768 }],
    });

    faux.setResponses(
        Array.from({ length: 50 }, () => (context) => {
            const system = JSON.stringify(
                context.messages.filter((each) => each.role === "system"),
            );
            const { text } = lastText(context as never);

            if (system.includes("context summarization assistant")) {
                return failSummary
                    ? fauxAssistantMessage([fauxText("## Goal")], { stopReason: "length" })
                    : fauxAssistantMessage([fauxText("## Goal\nThe whole summary.")]);
            }

            if (text.endsWith("fail now")) {
                return fauxAssistantMessage([], {
                    stopReason: "error",
                    errorMessage: "Invalid request: unsupported parameter",
                });
            }

            return fauxAssistantMessage([fauxText(`ok: ${text.length}`)]);
        }),
    );
    app = await openApp(faux as never);
    app.settings.applyOverrides({ compaction: { enabled: true, keepRecentTokens: 50 } });
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "run-failure-ui-")),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test(
    "a failed compaction shows a lasting line in the open session until a run starts",
    real,
    async () => {
        const id = await newSession(app);
        const failure = () => app.sessions().find((each) => each.id === Number(id))?.failure;

        failSummary = true;

        for (let turn = 0; turn < 8 && failure() === undefined; turn++) {
            await say(app, id, `turn ${turn} `.repeat(6_000));
        }

        assert.match(failure() ?? "", /Compaction failed/);
        await page.setViewport(VIEWPORTS.desktop);
        await page.navigate(`${base}/s/${id}`);
        await until(async () => (await failureLine()) !== null, "the failure line", 20_000);
        assert.match(
            (await failureLine()) ?? "",
            /Run failed: .*Compaction failed: Summarization hit the token limit/,
        );

        // The next run compacts: the line goes.
        failSummary = false;
        await say(app, id, "again");
        await until(async () => (await failureLine()) === null, "the line to go", 20_000);
    },
);

test("a failed answer shows its own error, not a second line", real, async () => {
    const id = await newSession(app);

    await app.commands.submit(id, owner(app), { text: "fail now", requestId: "run-failure-ui" });
    await until(
        () => app.sessions().find((each) => each.id === Number(id))?.failed === true,
        "the run to fail",
    );
    await page.navigate(`${base}/s/${id}`);
    await until(
        async () =>
            await inPage<boolean>(
                `return JSON.stringify(document.querySelector(".error-box") !== null)`,
            ),
        "the answer's error",
        20_000,
    );
    assert.equal(await failureLine(), null);
});
