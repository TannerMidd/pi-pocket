import { type App, cleanUp, newSession, openApp, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import type { HookView } from "../src/server/hooks.ts";
import { createHandler } from "../src/server/http.ts";

const real = {
    skip: findBrowser() === undefined ? "no Chromium-based browser on this machine" : false,
} as const;
let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";

const inPage = async <T>(script: string): Promise<T> =>
    JSON.parse(await page.evaluate(script)) as T;

const request = (path: string, body?: object, token = app.config.ownerToken) =>
    fetch(`${base}/api/${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
            Authorization: `Bearer ${token}`,
            "X-Pocket": "1",
            "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

const hooks = async (): Promise<HookView[]> => (await (await request("hooks")).json()).hooks;

async function openHooks(id: ConversationId): Promise<void> {
    await page.navigate(`${base}/s/${id}`);
    assert.ok(await page.waitFor({ selector: '.topbar [aria-label="Menu"]' }));
    await page.click({ selector: '.topbar [aria-label="Menu"]' });
    await page.evaluate(`
        [...document.querySelectorAll('.sheet button')]
            .find((button) => button.textContent.includes('Webhooks and watches')).click();
    `);
    assert.ok(await page.waitFor({ selector: '.hook-form input[aria-label="Name"]' }));
    await page.waitFor({ ms: 350 });
}

async function edit(): Promise<void> {
    await page.click({ label: "Edit prompt" });
    assert.ok(await page.waitFor({ selector: ".hook textarea" }));
    await until(
        () =>
            inPage<boolean>(
                `return JSON.stringify(document.activeElement === document.querySelector('.hook textarea'))`,
            ),
        "the prompt editor has focus",
    );
}

async function delivered(hook: HookView, id: ConversationId, instructions: string): Promise<void> {
    const body = JSON.stringify({ deploy: "failed" });
    const response = await fetch(`${base}${hook.path}`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            ...(hook.signed
                ? {
                      "X-Hub-Signature-256": `sha256=${createHmac("sha256", hook.secret!).update(body).digest("hex")}`,
                  }
                : {}),
        },
        body,
    });

    assert.equal(response.status, 202, await response.text());
    await until(() => !app.isBusy(id), "the webhook's answer");

    const entries = await app.transcripts.allEntries(id, true);
    const latest = entries.filter((entry) => entry.kind === "user").at(-1)!;

    assert.ok(latest.text.includes(`${instructions}\n\n<webhook-payload>`), latest.text);
}

before(async () => {
    app = await openApp(scriptedModel());
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    if (!real.skip) {
        browsers = new Browsers({
            dataDir: mkdtempSync(join(root, "hooks-ui-")),
            load: async () => undefined,
            save: () => {},
        });
        page = await browsers.open(1);
        await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    }
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

for (const viewport of ["desktop", "mobile"] as const) {
    test(`webhook prompts can be edited in place on ${viewport}`, real, async () => {
        const id = await newSession(app);
        const original = "Report failed deploys.";
        const revised = "Find out why the deploy failed.\n\nIgnore successful deploys.";

        await page.setViewport(VIEWPORTS[viewport]);
        await openHooks(id);
        await page.type({ selector: '.hook-form input[aria-label="Name"]' }, "Deploys");
        await page.type({ selector: ".hook-form textarea" }, original);

        if (viewport === "mobile") {
            await page.click({ label: "Another service" });
        }

        await page.click({ label: "Make webhook" });
        assert.ok(await page.waitFor({ selector: ".hook" }));

        const hook = (await hooks())[0]!;

        if (viewport === "mobile") {
            const status = await inPage<{ bottom: number; firstActionTop: number }>(`
                const row = document.querySelector('.hook .hook-actions');

                return JSON.stringify({
                    bottom: row.querySelector('.grow').getBoundingClientRect().bottom,
                    firstActionTop: row.querySelector('button').getBoundingClientRect().top,
                });
            `);

            assert.ok(
                status.bottom <= status.firstActionTop,
                `The webhook status must occupy its own row above the actions: ${JSON.stringify(status)}`,
            );
        }

        await delivered(hook, id, original);
        await openHooks(id);

        const before = (await hooks())[0]!;

        await edit();
        assert.equal(
            await inPage<string>(
                'return JSON.stringify(document.querySelector(".hook textarea").value)',
            ),
            original,
        );
        await page.type({ selector: ".hook textarea" }, "Discard this draft.");
        await page.click({ selector: ".hook .field button.ghost" });
        assert.ok(await page.waitFor({ selector: ".hook-text" }));
        assert.deepEqual((await hooks())[0], before);
        await until(
            () =>
                inPage<boolean>(
                    `return JSON.stringify(document.activeElement?.textContent.trim() === 'Edit prompt')`,
                ),
            "focus returns to Edit prompt",
        );
        await edit();
        await page.type({ selector: ".hook textarea" }, `  ${revised}  `);

        const layout = await inPage<{
            width: number;
            sheetWidth: number;
            scrollWidth: number;
            maxLength: number;
            controls: { left: number; right: number; height: number }[];
        }>(`
            const sheet = document.querySelector('.sheet');
            const controls = [...document.querySelectorAll('.hook textarea, .hook button')];

            return JSON.stringify({
                width: innerWidth,
                sheetWidth: sheet.clientWidth,
                scrollWidth: sheet.scrollWidth,
                maxLength: document.querySelector('.hook textarea').maxLength,
                controls: controls.map((element) => {
                    const { left, right, height } = element.getBoundingClientRect();

                    return { left, right, height };
                }),
            });
        `);

        assert.equal(layout.maxLength, 2000);
        assert.ok(layout.scrollWidth <= layout.sheetWidth, JSON.stringify(layout));

        for (const control of layout.controls) {
            assert.ok(control.left >= 0 && control.right <= layout.width, JSON.stringify(control));
            assert.ok(control.height >= (viewport === "mobile" ? 38 : 24), JSON.stringify(control));
        }

        await page.click({ selector: ".hook .field button.primary" });
        await until(
            async () =>
                (await inPage<string>(
                    'return JSON.stringify(document.querySelector(".hook-text")?.textContent)',
                )) === revised,
            "the saved prompt",
        );
        assert.deepEqual((await hooks())[0], { ...before, instructions: revised });
        await delivered(hook, id, revised);
        await openHooks(id);
        await edit();
        assert.equal(
            await inPage<string>(
                'return JSON.stringify(document.querySelector(".hook textarea").value)',
            ),
            revised,
        );
        await page.evaluate(`
            const input = document.querySelector('.hook textarea');

            input.value = 'x'.repeat(2001);
            input.dispatchEvent(new Event('input', { bubbles: true }));
        `);
        await page.click({ selector: ".hook .field button.primary" });
        assert.ok(await page.waitFor({ text: "Instructions are limited to 2000 characters." }));
        assert.equal(
            await inPage<number>(
                'return JSON.stringify(document.querySelector(".hook textarea").value.length)',
            ),
            2001,
        );
        assert.equal((await hooks())[0]!.instructions, revised);
        await page.type({ selector: ".hook textarea" }, "");
        await page.click({ selector: ".hook .field button.primary" });
        await until(async () => (await hooks())[0]!.instructions === "", "the empty prompt");
        await delivered(
            hook,
            id,
            "Something happened that you were set up to hear about. Say in a line what it is, and whether anything needs doing.",
        );
        await openHooks(id);
        await edit();
        assert.equal(
            await inPage<string>(
                'return JSON.stringify(document.querySelector(".hook textarea").value)',
            ),
            "",
        );
        assert.equal((await request(`hooks/${hook.id}/remove`, {})).status, 200);
    });
}

test("webhook prompt updates enforce ownership and validate the request over HTTP", async () => {
    const id = await newSession(app);
    const guest = app.config.addUser("Maker", "guest");
    const other = app.config.addUser("Other", "guest");
    const viewer = app.config.addUser("Viewer", "viewer");
    const created = await request(
        "hooks",
        { target: Number(id), name: "Guest deploys", instructions: "Original", signed: true },
        guest.token,
    );
    const hook = (await created.json()) as HookView;

    assert.equal(created.status, 200);
    assert.equal(
        (await request(`hooks/${hook.id}`, { instructions: "Other" }, other.token)).status,
        404,
    );
    assert.equal(
        (await request(`hooks/${hook.id}`, { instructions: "Viewer" }, viewer.token)).status,
        403,
    );

    for (const instructions of [undefined, null, 123, {}, []]) {
        assert.equal((await request(`hooks/${hook.id}`, { instructions })).status, 400);
    }

    for (const unknown of ["missing", "__proto__", "constructor", "toString"]) {
        assert.equal((await request(`hooks/${unknown}`, { instructions: "No" })).status, 404);
    }

    assert.equal((await hooks()).find((item) => item.id === hook.id)!.instructions, "Original");

    const own = await request(
        `hooks/${hook.id}`,
        { instructions: "  Maker's edit  " },
        guest.token,
    );

    assert.equal(own.status, 200);
    assert.deepEqual(await own.json(), { ...hook, instructions: "Maker's edit" });

    const edited = await request(`hooks/${hook.id}`, { instructions: "Owner's edit" });

    assert.equal(edited.status, 200);
    assert.deepEqual(await edited.json(), { ...hook, instructions: "Owner's edit" });
});
