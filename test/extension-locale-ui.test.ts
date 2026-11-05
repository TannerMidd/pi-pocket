// Browser language APIs work through public pocket methods and stop with their module version.
import {
    type App,
    cleanUp,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import { createHandler } from "../src/server/http.ts";

let app: App;
let server: Server;
let browsers: Browsers;
let base = "";
let token = "";
let session = 0;

before(async () => {
    assert.ok(findBrowser(), "Chromium is required for the public language API regression");
    const data = join(root, "extension-locale");
    const extensions = join(data, "extensions");

    mkdirSync(extensions, { recursive: true });
    writeFileSync(
        join(extensions, "locale-reader.ts"),
        '/** Public language API consumer. */\nexport default (_host, web) => web.client("locale-reader.js", {access:"view"});\n',
    );
    writeFileSync(
        join(extensions, "locale-reader.js"),
        `export default function(pocket) {
        globalThis.localeApiChanges = 0;
        globalThis.localeApiDisposed = 0;
        globalThis.localeApiPocket = pocket;
        const text = () => pocket.t("ui.close", "Close");
        pocket.sheet({id:"reading", title:text(), component:Reading});
        const listeners = new Set();
        function Reading() {
            const [,draw] = pocket.useState(0);
            const [draft,setDraft] = pocket.useState("");
            pocket.useEffect(() => { const run=()=>draw(n=>n+1); listeners.add(run); return()=>listeners.delete(run); },[]);
            return pocket.html\`<div class="locale-reader"><span>\${text()}</span><input value=\${draft} onInput=\${e=>setDraft(e.currentTarget.value)} /></div>\`;
        }
        globalThis.localeApiStop = pocket.onLocaleChange(() => {
            globalThis.localeApiChanges++;
            pocket.sheet({id:"reading", title:text(), component:Reading});
            for(const listener of listeners)listener();
        });
        pocket.onDispose(()=>globalThis.localeApiDisposed++);
    }`,
    );
    app = await openApp(scriptedModel(), data);
    session = Number(await newSession(app));
    token = app.config.addUser("Language guest", "guest").token;
    await app.setExtensionEnabled(owner(app), "locale-reader.ts", true);
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.2", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.2", resolve));
    base = `http://127.0.0.2:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "extension-locale-browser-")),
        load: async () => undefined,
        save: () => {},
    });
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    await app?.close();
    cleanUp();
});

test("public translation and locale listeners redraw in place and stop explicitly or on unload", async () => {
    const page = await browsers.open(1);
    const value = async <T>(script: string) =>
        JSON.parse(
            await page.evaluate(`return JSON.stringify(await(async()=>{${script}})())`),
        ) as T;
    const see = (expression: string, name: string) =>
        until(() => value<boolean>(`return Boolean(${expression})`), name, 15000);

    await page.navigate(`${base}/login?token=${token}&next=/s/${session}`);
    await see(
        `globalThis.localeApiPocket && (await import('/store.js')).store.state.me?.role==='guest'`,
        "the real public API module",
    );
    await page.evaluate(
        `(await import('/ui-locale.js')).setLocale('en');globalThis.localeApiPocket.openSheet('reading');`,
    );
    await see(`document.querySelector('.locale-reader input')`, "the registered extension sheet");
    await page.evaluate(
        `window.localeBefore=document.querySelector('.locale-reader input');window.localeBefore.value='literal draft';window.localeBefore.dispatchEvent(new Event('input',{bubbles:true}));window.countBefore=localeApiChanges;(await import('/ui-locale.js')).setLocale('zh-CN');`,
    );
    await see(
        `document.querySelector('.locale-reader span')?.textContent==='关闭'`,
        "default Chinese lookup reaches a live extension",
    );
    assert.equal(
        await value<string>("return document.querySelector('.locale-reader input').value"),
        "literal draft",
    );
    assert.equal(
        await value<boolean>(
            "return window.localeBefore===document.querySelector('.locale-reader input')",
        ),
        true,
    );
    assert.equal(await value<number>("return localeApiChanges-countBefore"), 1);
    assert.equal(
        await value<string>(
            `return localeApiPocket.t('unknown-key','Literal {name}',{name:'<img src=x>'})`,
        ),
        "Literal <img src=x>",
    );
    await page.evaluate(
        `localeApiStop();window.stoppedCount=localeApiChanges;(await import('/ui-locale.js')).setLocale('en');`,
    );
    assert.equal(
        await value<number>("return localeApiChanges"),
        await value<number>("return window.stoppedCount"),
    );
    await page.evaluate(`localeApiPocket.onLocaleChange(()=>globalThis.localeApiChanges++);`);
    await app.setExtensionEnabled(owner(app), "locale-reader.ts", false);
    await see(`localeApiDisposed===1`, "module disposal");
    const disposedCount = await value<number>("return localeApiChanges");

    await page.evaluate(`(await import('/ui-locale.js')).setLocale('zh-CN')`);
    assert.equal(
        await value<number>("return localeApiChanges"),
        disposedCount,
        "unloading removes language listeners",
    );
    page.close();
});
