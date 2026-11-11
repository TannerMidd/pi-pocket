// Stop's real held queue: locale shells, author controls, Edit, Withdraw, Send; no paid model requests.
import {
    cleanUp,
    context,
    lastText,
    modelTexts,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { HeldDoc } from "../src/server/docs.ts";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { capture0281 } from "./main-0281-ui-evidence.ts";

const { createHandler } = await import("../src/server/http.ts");

after(cleanUp);

for (const viewport of ["mobile", "desktop"] as const) {
    test(`main 0.28.1 ${viewport}: Stop holds messages and real author controls preserve text across locale, Edit/Withdraw/Send`, async () => {
        assert.ok(findBrowser(), "Chromium is required; held-queue acceptance must not skip");
        const model = scriptedModel((request) =>
            fauxAssistantMessage([
                fauxText(
                    lastText(request as never).text.includes("STREAM_FOR_STOP")
                        ? "word ".repeat(24000)
                        : "Literal answered",
                ),
            ]),
        );
        const app = await openApp(model, join(root, `held-${viewport}`));
        const id = await newSession(app);
        const guest = app.config.addUser("Literal guest", "guest");
        const server = createServer(
            createHandler({ app, listen: { host: "127.0.0.2", port: 0 }, restart: () => {} }),
        );
        const browsers = new Browsers({
            dataDir: mkdtempSync(join(root, "held-browser-")),
            load: async () => undefined,
            save: () => {},
        });
        const page = await browsers.open(1);
        const value = async <T>(script: string): Promise<T> =>
            JSON.parse(
                await page.evaluate(`return JSON.stringify(await(async()=>{${script}})())`),
            ) as T;
        const see = (expression: string, name: string) =>
            until(() => value<boolean>(`return Boolean(${expression})`), name, 15000);

        try {
            await new Promise<void>((resolve) => server.listen(0, "127.0.0.2", resolve));
            const base = `http://127.0.0.2:${(server.address() as { port: number }).port}`;

            await page.setViewport(VIEWPORTS[viewport]);
            await page.navigate(
                `${base}/login?token=${encodeURIComponent(app.config.ownerToken)}&next=/s/${id}`,
            );
            await see(
                "document.querySelector('.composer textarea') && (await import('/ui-locale.js')).languages().some(item=>item.id==='zh-CN')",
                "the temporary owner and default Chinese pack",
            );
            await page.evaluate("(await import('/ui-locale.js')).setLocale('zh-CN')");
            await app.commands.submit(id, owner(app), {
                text: "STREAM_FOR_STOP",
                requestId: crypto.randomUUID(),
            });
            await until(() => app.isBusy(id), "the actual streaming run");
            await app.commands.submit(id, owner(app), {
                text: "Literal owner edit",
                requestId: crypto.randomUUID(),
            });
            await app.commands.submit(id, guest.user, {
                text: "Literal guest withdraw",
                requestId: crypto.randomUUID(),
            });
            await app.commands.submit(id, owner(app), {
                text: "Literal owner send",
                requestId: crypto.randomUUID(),
            });
            await see("document.querySelector('.stop-button')", "the real Stop button");
            await page.click({ selector: ".stop-button" });
            await see(
                "document.querySelector('[data-part=held]')",
                "Stop created the real held queue",
            );
            await until(
                async () => (await app.harness.snapshot(HeldDoc, id, context))?.items.length === 3,
                "all 3 messages held",
            );
            const line = await value<string>(
                "return document.querySelector('[data-part=held]').textContent",
            );

            assert.match(line, /[\u4e00-\u9fff]/u);
            assert.ok(line.includes("3") && !line.includes("messages held"), line);
            await page.evaluate(
                "document.querySelector('[data-part=held] button[aria-expanded=false]').click()",
            );
            await see(
                "document.querySelectorAll('.held-list .queued').length===3",
                "the actual Show control opens all held messages",
            );
            const controls = await value<
                { text: string; editButtons: number; withdrawButtons: number }[]
            >(
                "return [...document.querySelectorAll('.held-list .queued')].map(row=>({text:row.querySelector('.queued-text').textContent,editButtons:row.querySelectorAll('button.link').length,withdrawButtons:row.querySelectorAll('.queued-remove').length}))",
            );

            assert.deepEqual(
                controls.map((row) => [row.text, row.editButtons, row.withdrawButtons]),
                [
                    ["Literal owner edit", 1, 1],
                    ["Literal guest withdraw", 0, 1],
                    ["Literal owner send", 1, 1],
                ],
            );
            const held = (await app.harness.snapshot(HeldDoc, id, context))!.items;
            const forbidden = await fetch(`${base}/api/c/${id}/held`, {
                method: "POST",
                headers: {
                    authorization: `Bearer ${guest.token}`,
                    "x-pocket": "1",
                    "content-type": "application/json",
                },
                body: JSON.stringify({ action: "edit", key: held[0]!.key }),
            });

            assert.equal(
                forbidden.status,
                403,
                "the actual endpoint rejects another author's Edit",
            );
            await capture0281(
                page,
                viewport + "-held-chinese",
                "Stop → held Show → own Edit and driver Withdraw controls",
                '[data-part="held"]',
            );
            await page.evaluate("(await import('/ui-locale.js')).setLocale('en')");
            await see(
                "document.querySelector('[data-part=held]')?.textContent.includes('3 messages held.')",
                "the original English held shell",
            );
            assert.deepEqual(
                await value<string[]>(
                    "return [...document.querySelectorAll('.held-list .queued-text')].map(row=>row.textContent)",
                ),
                ["Literal owner edit", "Literal guest withdraw", "Literal owner send"],
            );
            await page.click({ selector: ".held-list .queued:first-child button.link" });
            await see(
                "document.querySelector('.composer textarea')?.value==='Literal owner edit' && document.querySelectorAll('.held-list .queued').length===2",
                "Edit returns its author's exact text to the composer",
            );
            await page.evaluate(
                "const input=document.querySelector('.composer textarea');input.value='';input.dispatchEvent(new Event('input',{bubbles:true}))",
            );
            await page.evaluate(
                "[...document.querySelectorAll('.held-list .queued')].find(row=>row.textContent.includes('Literal guest withdraw')).querySelector('.queued-remove').click()",
            );
            await see(
                "document.querySelectorAll('.held-list .queued').length===1",
                "driver Withdraw removed the guest held message",
            );
            await page.click({ selector: "[data-part=held] > button.primary" });
            await see(
                "!document.querySelector('[data-part=held]')",
                "Send empties the held queue through its real endpoint",
            );
            await until(() => !app.isBusy(id), "the held send answer");
            const texts = (await modelTexts(app, id)).join("\n");

            assert.ok(texts.includes("Literal owner send"));
            assert.ok(
                !texts.includes("Literal owner edit") && !texts.includes("Literal guest withdraw"),
            );
            assert.deepEqual((await app.harness.snapshot(HeldDoc, id, context))!.items, []);
        } finally {
            await app.commands.abort(id, owner(app));
            await browsers.closeAll({ final: true });
            server.closeAllConnections();
            await new Promise<void>((resolve) =>
                server.listening ? server.close(() => resolve()) : resolve(),
            );
            await app.close();
        }
    });
}
