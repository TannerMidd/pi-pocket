// Fixed-release follow-up: real ask drafts and cached session rows, with temporary data and Chromium.
import {
    cleanUp,
    context,
    lastText,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import type { TaskId } from "@earendil-works/pi-durable";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";

after(cleanUp);
const evidence = process.env.PI_POCKET_RELEASE_FOLLOWUP_EVIDENCE_DIR;
const records: unknown[] = [];
const card = "form.approval.ask";
const question = "Literal database <b> & question";
const fields = [
    {
        name: "db",
        label: question,
        choices: [{ label: "Postgres" }, { label: "SQLite" }],
        other: true,
    },
    {
        name: "parts",
        label: "Literal parts?",
        choices: [{ label: "API" }, { label: "Web" }],
        multiple: true,
    },
    { name: "user", label: "Literal user" },
];

async function value<T>(page: BrowserPage, script: string): Promise<T> {
    return JSON.parse(
        await page.evaluate(`return JSON.stringify(await(async()=>{${script}})())`),
    ) as T;
}

async function see(page: BrowserPage, expression: string, name: string) {
    await until(() => value<boolean>(page, `return Boolean(${expression})`), name, 15000);
}

async function language(page: BrowserPage, locale: "en" | "zh-CN") {
    await page.evaluate(`(await import('/ui-locale.js')).setLocale('${locale}')`);
    await see(page, `document.documentElement.lang==='${locale}'`, `language ${locale}`);
}

async function capture(
    page: BrowserPage,
    viewport: "mobile" | "desktop",
    name: string,
    entry: string,
    selector: string,
) {
    const actual = await value<{
        lang: string;
        width: number;
        height: number;
        overflow: boolean;
        text: string;
    }>(
        page,
        `const node=document.querySelector(${JSON.stringify(selector)});if(!node)throw new Error('Missing evidence node');return {lang:document.documentElement.lang,width:innerWidth,height:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth,text:node.textContent.replace(/\\s+/g,' ').trim()};`,
    );

    assert.equal(actual.width, VIEWPORTS[viewport].width);
    assert.equal(actual.height, VIEWPORTS[viewport].height);
    assert.equal(actual.overflow, false);
    let screenshot: string | undefined;

    if (evidence) {
        mkdirSync(evidence, { recursive: true });
        screenshot = `${viewport}-${name}.jpg`;
        const shot = await page.screenshot();
        const image = Buffer.from(shot.data, "base64");

        assert.equal(image.readUInt16BE(0), 0xffd8, "the evidence is binary JPEG, not base64 text");
        writeFileSync(join(evidence, screenshot), image);
    }

    records.push({ name, entry, selector, viewport: VIEWPORTS[viewport], ...actual, screenshot });
}

after(() => {
    if (evidence) {
        mkdirSync(evidence, { recursive: true });
        writeFileSync(join(evidence, "followup-ui-results.json"), JSON.stringify(records, null, 2));
    }
});

for (const viewport of ["mobile", "desktop"] as const) {
    test(`follow-up ${viewport}: ask multi-field drafts survive locale and refresh without remounting, submitted values stay literal`, async () => {
        assert.ok(findBrowser(), "Chromium is required; follow-up acceptance does not skip");
        const app = await openApp(scriptedModel(), join(root, `ask-${viewport}`));
        const server = createServer(
            createHandler({ app, listen: { host: "127.0.0.2", port: 0 }, restart: () => {} }),
        );
        const browsers = new Browsers({
            dataDir: mkdtempSync(join(root, "followup-ask-browser-")),
            load: async () => undefined,
            save: () => {},
        });
        const page = await browsers.open(1);
        const id = await newSession(app);
        const approvalId = `followup-ask-${viewport}`;

        try {
            await say(app, id, "Literal session prompt");
            const answered = app.approvals.request(
                {
                    id: approvalId,
                    conversationId: id,
                    taskId: 1 as TaskId,
                    tool: "ask",
                    subject: "Pi asks",
                    reason: question,
                    createdAt: Date.now(),
                    form: { title: "Pi asks", fields, submit: "Send" },
                },
                context,
            );

            await new Promise<void>((resolve) => server.listen(0, "127.0.0.2", resolve));
            const base = `http://127.0.0.2:${(server.address() as { port: number }).port}`;

            await page.setViewport(VIEWPORTS[viewport]);
            await page.navigate(
                `${base}/login?token=${encodeURIComponent(app.config.ownerToken)}&next=/s/${id}`,
            );
            await see(
                page,
                `document.querySelector('${card}') && (await import('/ui-locale.js')).languages().some(e=>e.id==='zh-CN')`,
                "the real ask and default Chinese pack",
            );
            await language(page, "zh-CN");
            await page.reload();
            await see(
                page,
                `document.querySelector('${card} .approval-ask')?.textContent==='Pi 提问'`,
                "the first ask render after refresh is Chinese",
            );
            assert.equal(
                await value<string>(
                    page,
                    `return document.querySelector('${card} fieldset .ask-question > span').textContent`,
                ),
                question,
            );
            assert.equal(
                await value<number>(
                    page,
                    `return document.querySelectorAll('${card} .ask-question b').length`,
                ),
                0,
                "question markup stays text",
            );
            assert.equal(
                await value<string>(
                    page,
                    `return document.querySelector('${card} button[type=submit]').textContent.trim()`,
                ),
                "发送",
            );
            assert.equal(
                await value<string>(
                    page,
                    "return document.querySelector('.ask-other').placeholder",
                ),
                "或输入自己的答案",
            );
            await page.evaluate(`globalThis.followupAskGeometry=()=>{
                const options=[...document.querySelectorAll('${card} .ask-option')];
                const elements=new Set();
                for(const option of options){for(let node=option;node;node=node.parentElement)elements.add(node);}
                const ancestors=[...elements].map(node=>{
                    const style=getComputedStyle(node);
                    const matrix=new DOMMatrixReadOnly(style.transform==='none'?undefined:style.transform);
                    const animations=node.getAnimations().filter(animation=>animation.effect?.getComputedTiming().endTime!==Infinity);
                    return {node:node.tagName+'.'+node.className,transform:style.transform,scale:style.scale,
                        unitScale:matrix.m11===1&&matrix.m22===1&&matrix.m33===1&&matrix.m12===0&&matrix.m21===0&&(style.scale==='none'||style.scale==='1'||style.scale==='1 1'),
                        finished:animations.every(animation=>!animation.pending&&animation.playState!=='running'),
                        animations:animations.map(animation=>({state:animation.playState,pending:animation.pending,currentTime:animation.currentTime}))};
                });
                return {ancestors,ready:options.length>0&&ancestors.every(node=>node.finished&&node.unitScale),heights:options.map(node=>node.getBoundingClientRect().height)};
            };`);
            await see(
                page,
                "globalThis.followupAskGeometry().ready",
                "all ask option ancestors finish animating and have exact unit scale",
            );
            records.push({
                name: "ask-ancestor-geometry",
                viewport: VIEWPORTS[viewport],
                actual: await value(page, "return globalThis.followupAskGeometry()"),
            });
            const sizes = await value<number[]>(
                page,
                `return [...document.querySelectorAll('${card} .ask-option')].map(e=>e.getBoundingClientRect().height)`,
            );

            records.push({
                name: "ask-choice-geometry",
                viewport: VIEWPORTS[viewport],
                heights: sizes,
                expectedCount: 4,
            });
            assert.equal(
                sizes.length,
                4,
                "the schema has two fields with two choices; other is an input",
            );
            assert.ok(
                sizes.every((height) => height >= 44),
                `all choice targets are at least 44 CSS pixels: ${JSON.stringify(sizes)}`,
            );

            if (viewport === "mobile") {
                assert.ok(
                    await value<boolean>(
                        page,
                        "return document.querySelector('.ask-other').getBoundingClientRect().height>=44",
                    ),
                );
            }

            await page.type({ selector: ".ask-other" }, "Literal MySQL & draft");
            await page.click({ selector: "fieldset:nth-of-type(2) .ask-option:nth-child(1)" });
            await page.click({ selector: "fieldset:nth-of-type(2) .ask-option:nth-child(2)" });
            await page.type({ selector: "input[name=user]" }, "Literal user value");
            const saved = () =>
                value<string | null>(
                    page,
                    `return (await import('/person-storage.js')).personStorage.get('ask.${approvalId}')`,
                );
            const shown = () =>
                value<string[]>(
                    page,
                    `return [...document.querySelectorAll('${card} [aria-pressed=true],${card} input')].map(e=>e.tagName==='INPUT'?e.value:e.textContent.trim())`,
                );

            assert.match((await saved())!, /Literal MySQL.*Literal user value/);
            await capture(
                page,
                viewport,
                "ask-first",
                "Session → real multi-field Pi asks → Chinese first render and draft",
                card,
            );
            await page.evaluate(
                "globalThis.followupAskInput=document.querySelector('input[name=user]')",
            );
            await language(page, "en");
            await see(
                page,
                `document.querySelector('${card} button[type=submit]')?.textContent.trim()==='Send'`,
                "English fallback redraws the live card",
            );
            assert.equal(
                await value<boolean>(
                    page,
                    "return globalThis.followupAskInput===document.querySelector('input[name=user]')",
                ),
                true,
            );
            assert.deepEqual(await shown(), [
                "Literal MySQL & draft",
                "API",
                "Web",
                "Literal user value",
            ]);
            await language(page, "zh-CN");
            await page.reload();
            await see(
                page,
                `document.querySelector('${card} .approval-ask')?.textContent==='Pi 提问'`,
                "Chinese and multi-field drafts survive refresh",
            );
            assert.deepEqual(await shown(), [
                "Literal MySQL & draft",
                "API",
                "Web",
                "Literal user value",
            ]);
            await capture(
                page,
                viewport,
                "ask-restored",
                "Live language switch → refresh retains multi-field answers",
                card,
            );
            await page.click({ selector: "form.approval.ask button[type=submit]" });
            const answer = await answered;

            assert.equal(answer.allow, true);
            assert.deepEqual(answer.values, {
                db: "Literal MySQL & draft",
                parts: "API\nWeb",
                user: "Literal user value",
            });
            await see(
                page,
                `!document.querySelector('${card}')`,
                "the actual HTTP answer removed the card",
            );
            await until(
                async () => (await saved()) === null,
                "submitted draft removed from person storage",
            );
            records.push({
                name: "ask-submitted",
                viewport: VIEWPORTS[viewport],
                valuesPreserved: true,
            });
        } catch (error) {
            records.push({
                name: "ask-ancestor-failure-state",
                viewport: VIEWPORTS[viewport],
                actual: await value(page, "return globalThis.followupAskGeometry?.() ?? null"),
            });
            await capture(page, viewport, "ask-failure", "Ask follow-up failure state", "body");
            records.push({
                name: "ask-error",
                viewport: VIEWPORTS[viewport],
                error: String(error),
                logs: page.logs(),
            });

            throw error;
        } finally {
            app.approvals.answer(approvalId, { allow: false, by: "test cleanup" });
            await browsers.closeAll({ final: true });
            server.closeAllConnections();
            await new Promise<void>((resolve) =>
                server.listening ? server.close(() => resolve()) : resolve(),
            );
            await app.close();
        }
    });

    test(`follow-up ${viewport}: cached session rows update state and extension chips on locale changes and keep search scroll`, async () => {
        assert.ok(findBrowser(), "Chromium is required; cached-row acceptance does not skip");
        let release!: () => void;
        const hold = new Promise<void>((resolve) => (release = resolve));
        const model = scriptedModel(async (request) => {
            if (lastText(request as never).text.includes("FOLLOWUP_HOLD")) {
                await hold;
            }

            return fauxAssistantMessage([fauxText("Literal finished reply")]);
        });
        const data = join(root, `rows-${viewport}`);
        const extensions = join(data, "extensions");

        mkdirSync(extensions, { recursive: true });
        writeFileSync(
            join(extensions, "followup-chips.ts"),
            '/** Real locale-sensitive session chips. */\nexport default(_host,web)=>web.client("followup-chips.js",{access:"view"});\n',
        );
        writeFileSync(
            join(extensions, "followup-chips.js"),
            `export default(pocket)=>pocket.sessionChips({id:"locale",chips:session=>[{label:pocket.t("sessions.working","Working"),title:"Literal chip "+session.id}]});`,
        );
        const app = await openApp(model, data);
        const server = createServer(
            createHandler({ app, listen: { host: "127.0.0.2", port: 0 }, restart: () => {} }),
        );
        const browsers = new Browsers({
            dataDir: mkdtempSync(join(root, "followup-rows-browser-")),
            load: async () => undefined,
            save: () => {},
        });
        const page = await browsers.open(1);
        const list = viewport === "mobile" ? ".home-list" : ".sidebar";

        try {
            for (let n = 0; n < 30; n++) {
                await newSession(app);
            }

            const id = await newSession(app);

            await app.commands.updateSession(id, owner(app), { title: "Literal cached target" });
            await app.setExtensionEnabled(owner(app), "followup-chips.ts", true);
            const submitted = await app.commands.submit(id, owner(app), {
                text: "FOLLOWUP_HOLD",
                requestId: crypto.randomUUID(),
            });

            await until(() => app.isBusy(id), "the actual faux model run is in progress");
            await new Promise<void>((resolve) => server.listen(0, "127.0.0.2", resolve));
            const base = `http://127.0.0.2:${(server.address() as { port: number }).port}`;
            const row = `${list} .session-group:not(.kept) .session-row[data-id="${id}"]`;

            await page.setViewport(VIEWPORTS[viewport]);
            await page.navigate(
                `${base}/login?token=${encodeURIComponent(app.config.ownerToken)}&next=/`,
            );
            await see(
                page,
                `document.querySelector('${row} .session-chip') && (await import('/ui-locale.js')).languages().some(e=>e.id==='zh-CN')`,
                "the real list row and extension chip",
            );
            await language(page, "en");
            await page.evaluate(
                `const tab=document.querySelector('${list} [data-tab=recent]');if(!tab)throw new Error('Missing Recent tab');tab.click();`,
            );
            await see(
                page,
                `document.querySelector('${list} [data-tab=recent]')?.getAttribute('aria-selected')==='true' && document.querySelector('${row} [data-part=session-mark]')?.getAttribute('aria-label')==='Working'`,
                "the actual Recent list and working mark",
            );
            await page.evaluate(
                `const {store}=await import('/store.js');globalThis.followupSessions=store.state.sessions;globalThis.followupChipUrl=store.state.server.ui.find(e=>e.module==='followup-chips').url;globalThis.followupRow=document.querySelector('${row}');`,
            );
            await language(page, "zh-CN");
            await see(
                page,
                `document.querySelector('${row} [data-part=session-mark]')?.getAttribute('aria-label')==='工作中' && document.querySelector('${row} .session-chip')?.textContent.trim()==='工作中'`,
                "locale invalidates the cached row and extension chip immediately",
            );
            assert.equal(
                await value<boolean>(
                    page,
                    "const {store}=await import('/store.js');return followupSessions===store.state.sessions && followupChipUrl===store.state.server.ui.find(e=>e.module==='followup-chips').url",
                ),
                true,
                "sessions and the tested extension version stay unchanged across the locale redraw",
            );
            assert.equal(
                await value<string>(page, `return document.querySelector('${row}').dataset.state`),
                "working",
            );
            await capture(
                page,
                viewport,
                "rows-chinese",
                "Home/Sidebar → Recent → cached working mark and extension chip",
                list,
            );
            await language(page, "en");
            await see(
                page,
                `document.querySelector('${row} [data-part=session-mark]')?.getAttribute('aria-label')==='Working' && document.querySelector('${row} .session-chip')?.textContent.trim()==='Working'`,
                "English fallback updates cached labels",
            );
            await page.evaluate(
                `const box=document.querySelector('${list} .session-items');globalThis.followupScrolled=false;box.addEventListener('scroll',()=>{if(box.scrollTop===350)globalThis.followupScrolled=true;});box.scrollTop=350;`,
            );
            await see(
                page,
                `globalThis.followupScrolled && document.querySelector('${list} .session-items').scrollTop===350`,
                "the full list real scroll event records position 350 before search",
            );
            await page.evaluate(
                `const input=document.querySelector('${list} [data-part=session-search] input');input.value='Literal cached target';input.dispatchEvent(new Event('input',{bubbles:true}));`,
            );
            await see(
                page,
                `document.querySelectorAll('${list} .session-group:not(.kept) .session-row').length===1`,
                "the actual search matches only the target",
            );
            await language(page, "zh-CN");
            await see(
                page,
                `document.querySelector('${row} .session-chip')?.textContent.trim()==='工作中'`,
                "search matches update their locale too",
            );
            await capture(
                page,
                viewport,
                "rows-search",
                "Recent → search → locale switch keeps the query",
                list,
            );
            assert.equal(
                await value<string>(
                    page,
                    `return document.querySelector('${list} [data-part=session-search] input').value`,
                ),
                "Literal cached target",
            );
            await page.evaluate(
                `const input=document.querySelector('${list} [data-part=session-search] input');input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));`,
            );
            await see(
                page,
                `document.querySelector('${list} .session-items').scrollTop===350 && document.querySelectorAll('${list} .session-group:not(.kept) .session-row').length>1`,
                "ending search restores the full list scroll",
            );
            assert.equal(
                await value<boolean>(page, `return followupRow===document.querySelector('${row}')`),
                true,
                "the original cached DOM row survives search",
            );
            await capture(
                page,
                viewport,
                "rows-search-ended",
                "Search cleared → cached rows return at their previous scroll",
                list,
            );
            release();
            await (await app.harness.submission(submitted.submissionId, context))!.wait(context);
        } catch (error) {
            await capture(
                page,
                viewport,
                "rows-failure",
                "Cached row follow-up failure state",
                "body",
            );
            records.push({
                name: "rows-scroll-failure-state",
                viewport: VIEWPORTS[viewport],
                actual: await value(
                    page,
                    `const box=document.querySelector('${list} .session-items');return {scrollTop:box?.scrollTop,scrollHeight:box?.scrollHeight,clientHeight:box?.clientHeight,scrollEventObserved:globalThis.followupScrolled,query:document.querySelector('${list} [data-part=session-search] input')?.value,visibleRows:document.querySelectorAll('${list} .session-group:not(.kept) .session-row').length};`,
                ),
            });
            records.push({
                name: "rows-error",
                viewport: VIEWPORTS[viewport],
                error: String(error),
                logs: page.logs(),
            });

            throw error;
        } finally {
            release();
            await browsers.closeAll({ final: true });
            server.closeAllConnections();
            await new Promise<void>((resolve) =>
                server.listening ? server.close(() => resolve()) : resolve(),
            );
            await app.close();
        }
    });
}
