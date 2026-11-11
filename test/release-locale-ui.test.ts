// Release 0.28 entry points, using Chromium, the default Chinese pack and isolated app data.
import {
    type App,
    cleanUp,
    context,
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
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";
import { BackgroundDoc } from "../src/server/docs.ts";

const evidence = process.env.PI_POCKET_RELEASE_LOCALE_EVIDENCE_DIR;
const records: unknown[] = [];
let app: App;
let server: Server;
let endpoint: Server;
let endpointUrl = "";
let endpointRequests = 0;
let browsers: Browsers;
let session: ConversationId;
let base = "";
let nextPage = 0;

before(async () => {
    assert.ok(findBrowser(), "Chromium is required for release locale acceptance");
    const data = join(root, "release-locales");
    const extensions = join(data, "extensions");

    mkdirSync(extensions, { recursive: true });
    writeFileSync(
        join(extensions, "guard-fallback.ts"),
        '/** Real failing settings card and presented input. */\nexport default (_host,web)=>{web.client("guard-fallback.js");web.presentEntry({kind:"x.guard-fallback.note",label:"Literal input label",userPrefix:"PRESENTED "});};\n',
    );
    writeFileSync(
        join(extensions, "guard-fallback.js"),
        `export default function(pocket) {
        globalThis.guardFallbackPocket=pocket;
        pocket.fence({id:"settings-fence",langs:["guard-fallback"],component:({source})=>{
            if(source.trim()==="bad source")throw new Error("Literal failure");
            return pocket.h("output",{class:"guard-recovered"},source);
        }});
        function SettingsCard(){
            const [source,setSource]=pocket.useState("bad source");
            globalThis.guardFallbackChange=setSource;
            const marks=String.fromCharCode(96).repeat(3);
            const text=[marks+"guard-fallback",source,marks,"","Literal card after fence"].join(String.fromCharCode(10));
            return pocket.h("div",{class:"guard-settings-card"},pocket.h(pocket.Markdown,{text}));
        }
        pocket.sheet({id:"settings",title:"Literal settings card",component:SettingsCard});
    }`,
    );
    writeFileSync(
        join(extensions, "literal-settings.ts"),
        `/** Literal metadata, including names used by built-in settings. */
export default (_host,web)=>web.settings(["running","perSession","chars","repeatMinutes","aheadDays"].map(name=>({name,label:"Literal "+name+" label",description:"Literal "+name+" description",type:"number",default:1})));
`,
    );
    app = await openApp(scriptedModel(), data);
    await app.setExtensionEnabled(owner(app), "literal-settings.ts", true);
    endpoint = createServer((request, response) => {
        endpointRequests++;
        assert.equal(request.url, "/v1/models");
        response.setHeader("content-type", "application/json");
        response.end('{"object":"list","data":[]}');
    });
    await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.2", resolve));
    endpointUrl = `http://127.0.0.2:${(endpoint.address() as { port: number }).port}/v1`;
    await app.setExtensionEnabled(owner(app), "guard-fallback.ts", true);
    session = await newSession(app);
    await app.commands.updateSession(session, owner(app), { title: "Literal scheduled session" });
    await app.commands.schedule(session, owner(app), {
        when: "every 20m Literal scheduled input",
        zone: "UTC",
    });
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.2", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.2", resolve));
    base = `http://127.0.0.2:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "release-locale-browser-")),
        load: async () => undefined,
        save: () => {},
    });
});

after(async () => {
    if (evidence) {
        mkdirSync(evidence, { recursive: true });
        writeFileSync(join(evidence, "release-ui-results.json"), JSON.stringify(records, null, 2));
    }

    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    endpoint?.closeAllConnections();
    await new Promise<void>((resolve) => (endpoint ? endpoint.close(() => resolve()) : resolve()));
    await app?.close();
    cleanUp();
});

async function value<T>(page: BrowserPage, script: string): Promise<T> {
    return JSON.parse(
        await page.evaluate(`return JSON.stringify(await(async()=>{${script}})())`),
    ) as T;
}

async function see(page: BrowserPage, expression: string, name: string) {
    await until(() => value<boolean>(page, `return Boolean(${expression})`), name, 15000);
}

async function capture(
    page: BrowserPage,
    viewport: "mobile" | "desktop",
    name: string,
    entry: string,
    selector: string,
) {
    const actual = await value<{
        text: string;
        lang: string;
        width: number;
        height: number;
        overflow: boolean;
    }>(
        page,
        `const node=document.querySelector(${JSON.stringify(selector)}); if(!node)throw new Error('Missing evidence node');return {text:node.textContent.replace(/\\s+/g,' ').trim(),lang:document.documentElement.lang,width:innerWidth,height:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth};`,
    );

    assert.equal(actual.width, VIEWPORTS[viewport].width);
    assert.equal(actual.height, VIEWPORTS[viewport].height);
    assert.equal(actual.overflow, false, "the page fits its viewport");
    let screenshot: string | undefined;

    if (evidence) {
        mkdirSync(evidence, { recursive: true });
        await page.evaluate(
            "await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
        );
        screenshot = `${viewport}-${name}.jpg`;
        writeFileSync(join(evidence, screenshot), (await page.screenshot()).data);
    }

    records.push({ name, entry, selector, viewport: VIEWPORTS[viewport], ...actual, screenshot });

    return actual;
}

async function language(page: BrowserPage, id: "en" | "zh-CN") {
    await page.evaluate(`(await import('/ui-locale.js')).setLocale('${id}')`);
    await see(page, `document.documentElement.lang==='${id}'`, `language ${id}`);
}

async function openDesign(page: BrowserPage) {
    if (
        await value<boolean>(
            page,
            "return (await import('/store.js')).store.state.extPanel?.module==='design'",
        )
    ) {
        await see(
            page,
            "document.querySelector('.dsn-empty-state h3')?.textContent.trim()==='尚无设计'",
            "the restored Design panel",
        );

        return;
    }

    if (
        await value<boolean>(
            page,
            "const rail=document.querySelector('.rail-ext[title=设计]');return Boolean(rail&&rail.getBoundingClientRect().width&&rail.getBoundingClientRect().height)",
        )
    ) {
        await page.evaluate("document.querySelector('.rail-ext[title=设计]').click()");
    } else {
        await page.evaluate("(await import('/store.js')).openSheet({type:'menu'})");
        await see(
            page,
            "[...document.querySelectorAll('[data-sheet=menu] .place')].some(e=>e.getAttribute('aria-label')==='设计')",
            "the real Design menu place",
        );
        await page.evaluate(
            "[...document.querySelectorAll('[data-sheet=menu] .place')].find(e=>e.getAttribute('aria-label')==='设计').click()",
        );
    }

    await see(
        page,
        "document.querySelector('.dsn-empty-state h3')?.textContent.trim()==='尚无设计'",
        "the actual Design panel",
    );
}

async function menuRunning(page: BrowserPage, label: string) {
    await page.evaluate("(await import('/store.js')).openSheet({type:'menu'})");
    await see(page, "document.querySelector('[data-sheet=menu]')", "the actual menu");
    await page.evaluate(
        `const row=[...document.querySelectorAll('[data-sheet=menu] .list-item')].find(e=>e.textContent.includes(${JSON.stringify(label)}));if(!row)throw new Error('Missing Running now menu entry');globalThis.firstRunningTitle=null;globalThis.runningObserver?.disconnect();globalThis.runningObserver=new MutationObserver(()=>{const title=document.querySelector('[data-part=running-board] h2');if(title&&globalThis.firstRunningTitle===null){globalThis.firstRunningTitle=title.textContent;globalThis.runningObserver.disconnect();}});globalThis.runningObserver.observe(document.body,{subtree:true,childList:true});row.click();`,
    );
    await see(
        page,
        "document.querySelector('[data-part=running-board] .rb-matrix')",
        "the new Running now board with real data",
    );
}

for (const viewport of ["mobile", "desktop"] as const) {
    test(`release ${viewport}: real presented-input controls keep modes and literal full text across language changes`, async () => {
        const id = await newSession(app);
        const conversation = await app.conversation(id);
        const body =
            "Literal presented beginning " +
            "long input ".repeat(450) +
            " Literal clipped middle " +
            "long input ".repeat(450) +
            " Literal presented tail";
        const own = await conversation.submit(
            {
                type: "input",
                content: body,
                requestId: crypto.randomUUID(),
                entry: {
                    kind: "x.guard-fallback.note",
                    data: { summary: "Literal summary & text" },
                },
            },
            context,
        );

        await own.wait(context);
        const prefixed = await conversation.submit(
            {
                type: "input",
                content: "PRESENTED Literal prefixed body",
                requestId: crypto.randomUUID(),
            },
            context,
        );

        await prefixed.wait(context);
        const entries = await app.transcripts.allEntries(id, true);
        const entry = entries.find(
            (each) =>
                each.kind === "user" &&
                each.presentation?.entryKind === "x.guard-fallback.note" &&
                !each.presentation.prefixed,
        )!;
        const prefix = entries.find((each) => each.kind === "user" && each.presentation?.prefixed)!;
        const page = await browsers.open(++nextPage);

        assert.ok(entry && prefix, "both actual stored inputs project as presented rows");

        try {
            await page.setViewport(VIEWPORTS[viewport]);
            await page.navigate(
                `${base}/login?token=${encodeURIComponent(app.config.ownerToken)}&next=/s/${id}`,
            );
            await see(
                page,
                `document.querySelector('#entry-${entry.id} .presented-head')`,
                "the actual presented-input chip",
            );
            await language(page, "en");
            await page.evaluate(
                `const {choosePresentationMode}=await import("/entry-presentation.js");choosePresentationMode("x.guard-fallback.note","folded");`,
            );
            await see(
                page,
                `document.querySelector('#entry-${entry.id} .presented-head')`,
                "the fresh browser folded mode",
            );
            await language(page, "zh-CN");
            await page.evaluate(
                `document.querySelector('#entry-${entry.id} .presented-head').click()`,
            );
            await see(
                page,
                `document.querySelector('#entry-${entry.id} .presented-body')?.textContent.includes('Literal clipped middle')`,
                "opening the clipped input reads the missing middle of the full stored text",
            );
            assert.equal(
                await value<string>(
                    page,
                    `return document.querySelector('#entry-${entry.id} .presented-label').textContent`,
                ),
                "Literal input label",
            );
            assert.ok(
                (
                    await value<string>(
                        page,
                        `return document.querySelector('#entry-${entry.id} .presented-summary').textContent`,
                    )
                ).includes("Literal summary & text"),
            );
            await page.evaluate(
                `document.querySelector('#entry-${entry.id} .presented-more').click()`,
            );
            await see(
                page,
                "document.querySelector('[data-part=presented-choice]')",
                "the real message mode controls",
            );
            const choices = await value<string[]>(
                page,
                "return [...document.querySelectorAll('[data-part=presented-choice] button')].map(e=>e.textContent.trim())",
            );

            assert.equal(choices.length, 3);
            assert.ok(choices.every((label) => /[\u4e00-\u9fff]/u.test(label)));
            assert.ok(
                !(
                    await value<string>(
                        page,
                        "return document.querySelector('[data-sheet=message]').textContent",
                    )
                ).includes("Edit and send again"),
            );
            await capture(
                page,
                viewport,
                "presented-controls-chinese",
                "Presented input → more → Show/Fold/Hide",
                "[data-sheet=message]",
            );
            await page.evaluate(
                "document.querySelectorAll('[data-part=presented-choice] button')[2].click()",
            );
            await page.evaluate("(await import('/store.js')).closeSheet()");
            await see(
                page,
                `document.querySelector('#entry-${entry.id}.presented-hidden')`,
                "Hide leaves a hidden anchor",
            );
            await language(page, "en");
            assert.equal(
                await value<string>(
                    page,
                    "return (await import('/entry-presentation.js')).presentationMode('x.guard-fallback.note')",
                ),
                "hidden",
            );
            await page.evaluate("(await import('/store.js')).openSheet({type:'find'})");
            await see(page, "document.querySelector('.find-input')", "the real Find control");
            await page.evaluate(
                "const input=document.querySelector('.find-input');input.value='Literal clipped middle';input.dispatchEvent(new Event('input',{bubbles:true}))",
            );
            await see(
                page,
                "[...document.querySelectorAll('.find-result')].some(e=>e.querySelector('.find-who')?.textContent==='Literal input label')",
                "Find searches the complete hidden input rather than its assistant echo",
            );
            await page.evaluate(
                "[...document.querySelectorAll('.find-result')].find(e=>e.querySelector('.find-who')?.textContent==='Literal input label').click()",
            );
            await see(
                page,
                `document.querySelector('#entry-${entry.id} .presented-body')?.textContent.includes('Literal clipped middle')`,
                "Find reveals hidden full text without changing its mode",
            );
            assert.equal(
                await value<string>(
                    page,
                    "return (await import('/entry-presentation.js')).presentationMode('x.guard-fallback.note')",
                ),
                "hidden",
            );
            await page.evaluate(
                `document.querySelector('#entry-${entry.id} .presented-more').click()`,
            );
            await see(
                page,
                "document.querySelector('[data-part=presented-choice] button')",
                "the real English controls",
            );
            assert.deepEqual(
                await value<string[]>(
                    page,
                    "return [...document.querySelectorAll('[data-part=presented-choice] button')].map(e=>e.textContent.trim())",
                ),
                ["Show", "Fold", "Hide"],
            );
            await see(
                page,
                "[...document.querySelectorAll('[data-sheet=message] .message-actions button')].some(e=>e.textContent.trim()==='Copy text') && document.querySelector('[data-sheet=message] .message-preview')?.textContent.includes('Literal clipped middle')",
                "the actual Copy text control waits for the full clipped input",
            );
            const ownMenu = await value<string>(
                page,
                "return document.querySelector('[data-sheet=message]').textContent",
            );

            assert.ok(
                ownMenu.includes("Copy text") && !ownMenu.includes("Edit and send again"),
                ownMenu,
            );
            await page.evaluate(
                "document.querySelectorAll('[data-part=presented-choice] button')[0].click()",
            );
            await page.evaluate("(await import('/store.js')).closeSheet()");
            await see(
                page,
                `document.querySelector('#entry-${entry.id} [data-part=prompt]')`,
                "Show renders the normal message",
            );
            await page.evaluate(
                `(await import("/store.js")).openSheet({type:"message",entryId:${prefix.id}})`,
            );
            await see(
                page,
                "document.querySelector('[data-sheet=message]')?.textContent.includes('Edit and send again')",
                "a prefixed user input keeps its resend controls",
            );
            await page.evaluate(
                "document.querySelectorAll('[data-part=presented-choice] button')[1].click()",
            );
            await page.evaluate("(await import('/store.js')).closeSheet()");
            await language(page, "zh-CN");
            assert.equal(
                await value<string>(
                    page,
                    "return (await import('/entry-presentation.js')).presentationMode('x.guard-fallback.note')",
                ),
                "folded",
            );
            await capture(
                page,
                viewport,
                "presented-full",
                "Find reveal → Show → language switch preserves mode/text",
                "body",
            );
        } catch (error) {
            await capture(
                page,
                viewport,
                "presented-failure",
                "Presented input UI failure state",
                "body",
            );
            records.push({
                viewport: VIEWPORTS[viewport],
                error: String(error),
                logs: page.logs(),
            });

            throw error;
        } finally {
            page.close();
        }
    });
    test(`release ${viewport}: Background translates only exact standard outcomes and keeps detailed reasons and daemon warnings`, async () => {
        const page = await browsers.open(++nextPage);
        const item = await app.background.start(session, {
            command: "printf 'Literal output'; exit 7",
            notify: false,
        });

        try {
            await until(
                async () =>
                    (await app.background.list(session)).find((each) => each.id === item.id)
                        ?.status === "exited",
                "a real command has exited",
            );
            await page.setViewport(VIEWPORTS[viewport]);
            await page.navigate(
                `${base}/login?token=${encodeURIComponent(app.config.ownerToken)}&next=/s/${session}`,
            );
            await see(
                page,
                "document.querySelector('.composer textarea') && (await import('/ui-locale.js')).languages().some(e=>e.id==='zh-CN')",
                "the owner and default language pack",
            );
            await language(page, "zh-CN");

            const show = async () => {
                await page.evaluate(
                    `(await import('/store.js')).openSheet({type:'background',task:'${item.id}'})`,
                );
                await see(
                    page,
                    "document.querySelector('.background-said') && document.querySelector('.background-log').textContent.includes('Literal output')",
                    "the actual Background output route",
                );
            };

            await show();
            let said = await value<string>(
                page,
                "return document.querySelector('.background-said').textContent",
            );

            assert.match(said, /[\u4e00-\u9fff]/u);
            assert.ok(said.includes("7") && !said.includes("exited with code 7"), said);
            await capture(
                page,
                viewport,
                "background-exit",
                "Background → real command exit 7",
                ".background-view",
            );

            // The terminal task is complete. Commit test statuses through the real temporary durable document.
            for (const why of [undefined, "Literal output exceeded its limit"]) {
                await page.evaluate("(await import('/store.js')).closeSheet()");
                await see(
                    page,
                    "!document.querySelector('.background-view')",
                    "the previous task view closes",
                );
                await app.harness.commit(async (tx) => {
                    const stored = (await tx.doc(BackgroundDoc, session)).items[item.id]!;

                    stored.status = "stopped";

                    if (why === undefined) {
                        delete stored.why;
                    } else {
                        stored.why = why;
                    }
                }, context);
                await show();
                said = await value<string>(
                    page,
                    "return document.querySelector('.background-said').textContent",
                );

                if (why === undefined) {
                    assert.match(said, /[\u4e00-\u9fff]/u);
                    assert.ok(!said.trim().startsWith("stopped"), said);
                } else {
                    assert.ok(said.includes("stopped by Pi Pocket: " + why), said);
                }
            }

            await capture(
                page,
                viewport,
                "background-reason",
                "Background → detailed stored stop reason stays literal",
                ".background-view",
            );
            const daemon = await app.background.start(session, {
                command:
                    "setsid sleep 30 > /dev/null 2>&1 < /dev/null & printf 'Literal daemon output'",
                notify: false,
            });

            try {
                await until(
                    async () =>
                        (await app.background.list(session)).some(
                            (each) => each.id === daemon.id && (each.left?.length ?? 0) > 0,
                        ),
                    "the real command left a bounded daemon",
                );
                await page.evaluate("(await import('/store.js')).closeSheet()");
                await see(
                    page,
                    "!document.querySelector('.background-view')",
                    "close the previous task",
                );
                await page.evaluate(
                    `(await import('/store.js')).openSheet({type:'background',task:'${daemon.id}'})`,
                );
                await see(
                    page,
                    "document.querySelector('.background-said')?.textContent.includes('a daemon: pid ')",
                    "the real daemon outcome reaches the sheet",
                );
                const warning = await value<string>(
                    page,
                    "return document.querySelector('.background-said').textContent",
                );

                assert.ok(
                    warning.includes(
                        "exited with code 0; 1 process it started still runs outside it (a daemon: pid ",
                    ),
                    warning,
                );
                assert.ok(warning.includes("which a stop ends"), warning);
                await capture(
                    page,
                    viewport,
                    "background-daemon",
                    "Background → actual local daemon warning stays literal",
                    ".background-view",
                );
            } finally {
                await app.background.stop(session, daemon.id);
            }
        } finally {
            page.close();
        }
    });
    test(`release ${viewport}: settings ownership and empty-endpoint notices switch without losing literal metadata or drafts`, async () => {
        const page = await browsers.open(++nextPage);

        try {
            await page.setViewport(VIEWPORTS[viewport]);
            await page.navigate(
                `${base}/login?token=${encodeURIComponent(app.config.ownerToken)}&next=/s/${session}`,
            );
            await see(
                page,
                "document.querySelector('.composer textarea') && (await import('/ui-locale.js')).languages().some(e=>e.id==='zh-CN')",
                "the owner and built-in Chinese pack",
            );
            await language(page, "zh-CN");
            await page.evaluate(
                "(await import('/store.js')).openSheet({type:'extensions',tab:'installed'})",
            );
            await see(
                page,
                "document.querySelector('.ext-row-open[aria-controls=ext-more-background-ts]')",
                "the installed module settings",
            );

            for (const module of ["background", "schedules", "literal-settings"]) {
                await page.evaluate(
                    `const rows=[...document.querySelectorAll('.ext-row')];const row=rows.find(e=>e.querySelector('#ext-more-${module}-ts')||e.querySelector('.ext-row-by')?.textContent==='${module}.ts'||(e.querySelector('.ext-row-open')?.getAttribute('aria-controls')==='ext-more-${module}-ts'));if(!row)throw new Error('Missing module ${module}');if(!row.classList.contains('open'))row.querySelector('.ext-row-open').click();`,
                );
                await see(
                    page,
                    `document.querySelector('#ext-more-${module}-ts .ext-settings label')`,
                    "the actual module settings fields",
                );
                const labels = await value<string[]>(
                    page,
                    `return [...document.querySelectorAll('#ext-more-${module}-ts .ext-settings label')].map(e=>e.textContent)`,
                );

                if (module === "literal-settings") {
                    assert.deepEqual(
                        labels,
                        ["running", "perSession", "chars", "repeatMinutes", "aheadDays"].map(
                            (name) => "Literal " + name + " label",
                        ),
                    );
                    assert.ok(
                        (
                            await value<string>(
                                page,
                                "return document.querySelector('#ext-more-literal-settings-ts .ext-settings').textContent",
                            )
                        ).includes("Literal running description"),
                    );
                } else {
                    assert.ok(
                        labels.length > 0 &&
                            labels.every((label) => /[\u4e00-\u9fff]/u.test(label)),
                        labels.join(" / "),
                    );
                }
            }

            await capture(
                page,
                viewport,
                "settings-ownership",
                "Extensions → built-in Background/Schedules and literal-settings drop-in",
                "[data-sheet=extensions]",
            );
            await page.evaluate("(await import('/store.js')).openSheet({type:'providers'})");
            await see(
                page,
                "((label)=>[...document.querySelectorAll('.provider-item')].some(e=>e.textContent.includes(label)))((await import('/ui-locale.js')).t('web.sheets.providers.release028.compatible-name','OpenAI Compatible'))",
                "the real compatible-provider row",
            );
            await page.evaluate(
                "const label=(await import('/ui-locale.js')).t('web.sheets.providers.release028.compatible-name','OpenAI Compatible');const row=[...document.querySelectorAll('.provider-item')].find(e=>e.textContent.includes(label));row.querySelector('.provider-actions button').click()",
            );
            await see(
                page,
                "document.querySelector('.custom-endpoint-form input[type=url]')",
                "the real EndpointForm",
            );
            await page.evaluate(
                `const form=document.querySelector('.custom-endpoint-form');const name=form.querySelector('input[placeholder="LM Studio"]');const url=form.querySelector('input[type=url]');for(const [input,value] of [[name,'Literal provider name'],[url,${JSON.stringify(endpointUrl)}]]){input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));}form.querySelector('input[type=checkbox]').click();`,
            );
            await page.evaluate(
                "document.querySelector('.custom-endpoint-models-head button').click()",
            );
            await see(
                page,
                "document.querySelector('.custom-endpoint-form [role=alert]') && !document.querySelector('.custom-endpoint-models-head button').disabled",
                "the real endpoint returns an empty model list",
            );
            const chinese = await value<string>(
                page,
                "return document.querySelector('.custom-endpoint-form [role=alert]').textContent",
            );

            assert.match(chinese, /[\u4e00-\u9fff]/u);
            assert.ok(endpointRequests > 0, "the actual app fetched the local models endpoint");
            await capture(
                page,
                viewport,
                "endpoint-empty-chinese",
                "Providers → OpenAI Compatible → Find models → real local empty list",
                ".custom-endpoint-form",
            );
            await language(page, "en");
            await see(
                page,
                "document.querySelector('.custom-endpoint-form [role=alert]')?.textContent==='The endpoint lists no models. Add model IDs by hand.'",
                "S1: the existing no-model notice redraws in English",
            );
            assert.deepEqual(
                await value<string[]>(
                    page,
                    "return [...document.querySelectorAll('.custom-endpoint-form input[placeholder=\"LM Studio\"],.custom-endpoint-form input[type=url]')].map(e=>e.value)",
                ),
                ["Literal provider name", endpointUrl],
            );
            await capture(
                page,
                viewport,
                "endpoint-empty-english",
                "EndpointForm → language English retains input name/URL",
                ".custom-endpoint-form",
            );
        } catch (error) {
            await capture(
                page,
                viewport,
                "settings-endpoint-failure",
                "Settings/EndpointForm failure state",
                "body",
            );
            records.push({
                viewport: VIEWPORTS[viewport],
                error: String(error),
                logs: page.logs(),
            });

            throw error;
        } finally {
            page.close();
        }
    });
    test(`release ${viewport}: extension Guard translates its failure and keeps the settings card fallback and reset`, async () => {
        const page = await browsers.open(++nextPage);

        try {
            await page.setViewport(VIEWPORTS[viewport]);
            await page.navigate(
                `${base}/login?token=${encodeURIComponent(app.config.ownerToken)}&next=/s/${session}`,
            );
            await see(
                page,
                "globalThis.guardFallbackPocket && (await import('/ui-locale.js')).languages().some(e=>e.id==='zh-CN')",
                "the real fallback extension",
            );
            await language(page, "zh-CN");
            await page.evaluate("guardFallbackPocket.openSheet('settings')");
            await see(
                page,
                "document.querySelector('.guard-settings-card .error-box')",
                "the real renderer fails under Guard",
            );
            const first = await capture(
                page,
                viewport,
                "guard-card-chinese",
                "Extension settings card → throwing fence renderer → Guard fallback",
                ".guard-settings-card",
            );

            assert.equal(
                await value<string>(
                    page,
                    "return document.querySelector('.guard-settings-card .error-box').textContent.trim()",
                ),
                "代码围栏 settings-fence 失败：Literal failure",
            );
            assert.ok(first.text.includes("Literal card after fence"));
            assert.equal(
                await value<string>(
                    page,
                    "return document.querySelector('.guard-settings-card pre code').textContent",
                ),
                "bad source",
            );
            await language(page, "en");
            await see(
                page,
                "document.querySelector('.guard-settings-card .error-box')?.textContent.includes('Fence settings-fence failed: Literal failure')",
                "Guard English fallback",
            );
            await capture(
                page,
                viewport,
                "guard-card-english",
                "Extension settings card → language English",
                ".guard-settings-card",
            );
            assert.equal(
                await value<string>(
                    page,
                    "return document.querySelector('.guard-settings-card pre code').textContent",
                ),
                "bad source",
            );
            await page.evaluate("guardFallbackChange('good source')");
            await see(
                page,
                "document.querySelector('.guard-recovered')?.textContent.trim()==='good source' && !document.querySelector('.guard-settings-card .error-box')",
                "changing the source resets the real Guard",
            );
            await capture(
                page,
                viewport,
                "guard-card-recovered",
                "Extension settings card → source changes → Guard reset",
                ".guard-settings-card",
            );
        } catch (error) {
            await capture(
                page,
                viewport,
                "guard-card-failure",
                "Guard fallback failure state",
                "body",
            );
            records.push({
                viewport: VIEWPORTS[viewport],
                error: String(error),
                logs: page.logs(),
            });

            throw error;
        } finally {
            page.close();
        }
    });
    test(`release ${viewport}: Running now and Design translate on first open, switch, refresh and module removal`, async () => {
        const page = await browsers.open(++nextPage);

        try {
            await page.setViewport(VIEWPORTS[viewport]);
            await page.navigate(
                `${base}/login?token=${encodeURIComponent(app.config.ownerToken)}&next=/s/${session}`,
            );
            await see(
                page,
                "document.querySelector('.composer textarea') && (await import('/ui-locale.js')).languages().some(e=>e.id==='zh-CN')",
                "the isolated owner and default Chinese pack",
            );
            await language(page, "zh-CN");
            await page.navigate(`${base}/s/${session}`);
            await see(
                page,
                "document.documentElement.lang==='zh-CN' && document.querySelector('.composer textarea')",
                "the saved preference on a fresh page",
            );
            await menuRunning(page, "正在运行");
            const first = await capture(
                page,
                viewport,
                "running-first",
                "Menu → Running now",
                "[data-part=running-board]",
            );

            assert.equal(
                await value<string>(page, "return firstRunningTitle"),
                "正在运行",
                "the first board title is already Chinese",
            );
            assert.ok(first.text.includes("Literal scheduled session"));
            assert.equal(
                await value<string>(
                    page,
                    "return document.querySelector('[data-part=running-board] h2').textContent",
                ),
                "正在运行",
            );
            assert.ok(!first.text.includes("Running now"));
            const controls = await value<{
                headers: string;
                filters: string[];
                placeholder: string;
            }>(
                page,
                "const board=document.querySelector('[data-part=running-board]');return {headers:board.querySelector('.rb-thead').textContent,filters:[...board.querySelectorAll('.rb-filters button')].map(e=>e.textContent.trim()),placeholder:board.querySelector('.board-search input').placeholder}",
            );

            assert.match(controls.headers, /[\u4e00-\u9fff]/u);
            assert.doesNotMatch(controls.headers, /Session|Now|Schedule/);
            assert.ok(controls.filters.length >= 5);
            assert.ok(
                controls.filters.every((text) => /[\u4e00-\u9fff]/u.test(text)),
                "every board filter has a Chinese label",
            );
            assert.match(controls.placeholder, /[\u4e00-\u9fff]/u);
            await language(page, "en");
            await see(
                page,
                "document.querySelector('[data-part=running-board] h2')?.textContent==='Running now'",
                "the live board returns to English",
            );
            await capture(
                page,
                viewport,
                "running-english",
                "Running now → language English",
                "[data-part=running-board]",
            );
            await language(page, "zh-CN");
            await see(
                page,
                "document.querySelector('[data-part=running-board] h2')?.textContent==='正在运行'",
                "the board switches back in place",
            );
            await page.navigate(`${base}/s/${session}`);
            await see(
                page,
                "document.documentElement.lang==='zh-CN' && document.querySelector('.composer textarea')",
                "Chinese survives refresh",
            );
            await menuRunning(page, "正在运行");
            await capture(
                page,
                viewport,
                "running-refresh",
                "Refresh → Menu → Running now",
                "[data-part=running-board]",
            );
            await page.press("Escape");
            await see(
                page,
                "!document.querySelector('[data-part=running-board]')",
                "back to conversation",
            );
            await openDesign(page);
            await see(
                page,
                "document.querySelector('.dsn-empty-state h3')?.textContent.trim()==='尚无设计'",
                "Design is Chinese on first open",
            );
            await capture(page, viewport, "design-first", "Rail → Design", ".ext-panel");
            await language(page, "en");
            await see(
                page,
                "document.querySelector('.dsn-empty-state h3')?.textContent.trim()==='No designs yet'",
                "Design English fallback",
            );
            await language(page, "zh-CN");
            await see(
                page,
                "document.querySelector('.dsn-empty-state h3')?.textContent.trim()==='尚无设计'",
                "Design switches back in place",
            );
            await page.navigate(`${base}/s/${session}`);
            await see(
                page,
                "document.documentElement.lang==='zh-CN' && (await import('/extension-ui.js')).browserModuleState('design')?.status==='ready'",
                "Design module ready after refresh",
            );
            await openDesign(page);
            await see(
                page,
                "document.querySelector('.dsn-empty-state h3')?.textContent.trim()==='尚无设计'",
                "Design remains Chinese after refresh",
            );
            await capture(
                page,
                viewport,
                "design-refresh",
                "Refresh → Rail → Design",
                ".ext-panel",
            );
            await app.setExtensionEnabled(owner(app), "design.ts", false);
            await see(
                page,
                "!document.querySelector('.rail-ext[title=设计]') && !document.querySelector('.dsn-empty-state')",
                "unloading Design removes its entry and open panel",
            );
            await capture(page, viewport, "design-unloaded", "Owner disables Design", "body");
            await app.setExtensionEnabled(owner(app), "design.ts", true);
            await see(
                page,
                "(await import('/extension-ui.js')).browserModuleState('design')?.status==='ready'",
                "Design can load again",
            );
            await page.evaluate(
                "(await import('/store.js')).openSheet({type:'extensions',tab:'installed'})",
            );
            await see(
                page,
                "document.querySelector('[data-sheet=extensions]')?.textContent.includes('工具运行时不接受安全检查')",
                "real environment-off Guard detail is Chinese",
            );
            await capture(
                page,
                viewport,
                "guard-fallback",
                "Menu → Extensions → Guard (PI_POCKET_GUARD=off)",
                "[data-sheet=extensions]",
            );
            await language(page, "en");
            await see(
                page,
                "document.querySelector('[data-sheet=extensions]')?.textContent.includes('Lancet Guard is off (PI_POCKET_GUARD=off); tools run unguarded.')",
                "real Guard detail English fallback",
            );
            await language(page, "zh-CN");
            await page.evaluate("(await import('/store.js')).closeSheet()");
            await app.setExtensionEnabled(owner(app), "zh-cn.ts", false);
            await see(
                page,
                "document.documentElement.lang==='en' && !(await import('/ui-locale.js')).languages().some(e=>e.id==='zh-CN')",
                "unloading the Chinese pack falls back without erasing preference",
            );
            assert.match(
                await value<string>(page, "return document.cookie"),
                /pocket_locale=zh-CN/,
            );
            await menuRunning(page, "Running now");
            assert.equal(
                await value<string>(
                    page,
                    "return document.querySelector('[data-part=running-board] h2').textContent",
                ),
                "Running now",
            );
            await capture(
                page,
                viewport,
                "pack-unloaded",
                "Owner disables Chinese pack → Menu → Running now",
                "[data-part=running-board]",
            );
            const errors = page
                .logs()
                .filter((each) => each.level === "error" && each.text.startsWith("Uncaught"));

            assert.deepEqual(errors, [], "no uncaught browser errors");
        } catch (error) {
            await capture(
                page,
                viewport,
                "failure",
                "Failure state of release locale scenario",
                "body",
            );
            records.push({
                viewport: VIEWPORTS[viewport],
                error: String(error),
                logs: page.logs(),
            });

            throw error;
        } finally {
            await app.setExtensionEnabled(owner(app), "zh-cn.ts", true);
            await app.setExtensionEnabled(owner(app), "design.ts", true);
            page.close();
        }
    });
}
