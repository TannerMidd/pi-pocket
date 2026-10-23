// Browser component check with the public Pocket API and an in-memory settings transport; no test server.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebAccessManager } from "../web-search/manager.ts";

const source = process.env.PI_POCKET_SOURCE;

if (!source) {
    test(
        "mobile extension component",
        { skip: "Set PI_POCKET_SOURCE to Pi Pocket 0.20 source" },
        () => {},
    );
} else {
    const { Browsers } = await import(pathToFileURL(join(source, "src/server/browser.ts")).href);
    const { VIEWPORTS } = await import(
        pathToFileURL(join(source, "src/server/browser/viewport.ts")).href
    );
    const { findBrowser } = await import(
        pathToFileURL(join(source, "src/server/browser/discovery.ts")).href
    );

    test(
        "public browser module saves tier edits and renders options without phone overflow",
        { skip: findBrowser() ? false : "Chromium unavailable" },
        async () => {
            const root = mkdtempSync(join(tmpdir(), "web-search-browser-"));
            const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
            const manager = new WebAccessManager(join(root, "settings"), {
                fetchPublic: async () => {
                    throw new Error("No provider requests in this UI check");
                },
            });
            const state = await manager.getState();
            const read = (path: string) => readFileSync(path, "utf8");
            const data = (text: string) =>
                `data:text/javascript;base64,${Buffer.from(text).toString("base64")}`;
            const preact = data(read(fileURLToPath(import.meta.resolve("preact"))));
            const hooks = data(
                read(fileURLToPath(import.meta.resolve("preact/hooks"))).replaceAll(
                    '"preact"',
                    JSON.stringify(preact),
                ),
            );
            const htm = data(read(fileURLToPath(import.meta.resolve("htm"))));
            const options = data(read(join(packageDir, "web-search/options.js")));
            const setup = data(
                read(join(packageDir, "web-search/index.js")).replace(
                    '"./options.js"',
                    JSON.stringify(options),
                ),
            );
            const style =
                read(join(source, "web/style.css")).replace(/@font-face\s*\{[\s\S]*?\}/g, "") +
                read(join(packageDir, "web-search/look.css"));
            const browsers = new Browsers({
                dataDir: root,
                load: async () => undefined,
                save: () => {},
            });

            try {
                const page = await browsers.open(1);

                await page.setViewport(VIEWPORTS.mobile);
                await page.navigate("about:blank");
                await page.evaluate(`
                const css=document.createElement('style');css.textContent=${JSON.stringify(style)};document.head.append(css);
                document.body.innerHTML='<main style="width:100%;padding:16px;box-sizing:border-box"><div id="app"></div></main>';
                const {h,render}=await import(${JSON.stringify(preact)});
                const hooks=await import(${JSON.stringify(hooks)});
                const {default:htm}=await import(${JSON.stringify(htm)});
                const {default:setup}=await import(${JSON.stringify(setup)});
                window.saved=${JSON.stringify(state)};
                setup({html:htm.bind(h),...hooks,Icon:()=>null,Loader:()=>null,
                    Switch:({on,onChange,label,disabled})=>h('input',{type:'checkbox',checked:on,onChange,'aria-label':label,disabled}),
                    style:()=>{},menu:()=>{},launcher:()=>{},notify:(_level,message)=>{throw new Error(message)},
                    sheet:({component})=>render(h(component),document.querySelector('#app')),
                    api:async(_path,body)=>{if(body) Object.assign(window.saved,body);return structuredClone(window.saved);}
                });
            `);
                const value = async (expression: string) =>
                    JSON.parse(await page.evaluate(`return JSON.stringify(${expression})`));

                const until = async (expression: string) => {
                    for (let i = 0; i < 100; i++) {
                        if (await value(expression)) {
                            return;
                        }

                        await new Promise((resolve) => setTimeout(resolve, 20));
                    }

                    assert.fail(`Timed out: ${expression}`);
                };

                await until("!!document.querySelector('[aria-label=\"quick provider 1\"]')");
                await page.evaluate(
                    `document.querySelector('[aria-label="Move quick route 2 up"]').click()`,
                );
                await until(
                    "document.querySelector('[aria-label=\"quick provider 1\"]').value === 'exa'",
                );
                await page.evaluate(
                    `document.querySelectorAll('details').forEach(element=>element.open=true)`,
                );
                assert.equal(
                    await value("document.documentElement.scrollWidth <= innerWidth"),
                    true,
                );
                assert.equal(await value("window.saved.tierRouting.quick[0].provider"), "exa");
                await page.screenshot();
            } finally {
                await browsers.closeAll({ final: true });
                rmSync(root, { recursive: true, force: true });
            }
        },
    );
}
