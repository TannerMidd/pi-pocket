// Small real-browser regressions for diagrams' locale listeners and Agent Teams' registered summaries.
import { cleanUp, newSession, openApp, owner, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import chinese from "../src/server/extensions/zh-cn/messages.ts";

after(cleanUp);
const evidence = process.env.PI_POCKET_EXTENSION_ADDITIONS_EVIDENCE_DIR;
const messages = chinese.messages as Record<string, string>;

test("diagrams keep source while aria changes and unload cleanly; team stop/archive use their registered verbs", async () => {
    assert.ok(findBrowser(), "Chromium is required for the extension locale additions");
    const { createHandler } = await import("../src/server/http.ts");
    const app = await openApp(scriptedModel(), join(root, "extension-locale-additions"));
    const session = await newSession(app);
    const server = createServer(
        createHandler({ app, listen: { host: "127.0.0.2", port: 0 }, restart: () => {} }),
    );
    const browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "extension-additions-browser-")),
        load: async () => undefined,
        save: () => {},
    });
    const records: unknown[] = [];
    const marks = String.fromCharCode(96).repeat(3);
    const sources = [
        { lang: "mermaid", source: "flowchart LR\nA[Literal Start] --> B[Literal End]" },
        { lang: "mermaid", source: "flowchart LR\nA -->" },
        { lang: "tex", source: "x^2" },
        { lang: "latex", source: String.raw`\notACommand` },
    ];
    const markdown = sources
        .map(({ lang, source }) => [marks + lang, source, marks].join("\n"))
        .join("\n\n");

    try {
        await app.setExtensionEnabled(owner(app), "agent-teams.ts", true);
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.2", resolve));
        const base = `http://127.0.0.2:${(server.address() as { port: number }).port}`;

        for (const [index, viewport] of (["mobile", "desktop"] as const).entries()) {
            await app.setExtensionEnabled(owner(app), "diagrams.ts", true);
            const page = await browsers.open(index + 1);
            const value = async <T>(script: string): Promise<T> =>
                JSON.parse(
                    await page.evaluate(`return JSON.stringify(await(async()=>{${script}})())`),
                ) as T;
            const see = (expression: string, name: string) =>
                until(() => value<boolean>(`return Boolean(${expression})`), name, 15000);
            const snapshot = () =>
                value<{ sources: string[]; aria: string[]; tex: string; diagram: string }>(
                    "const host=document.querySelector('#extension-locale-additions');return {sources:[...host.querySelectorAll('pre code')].map(e=>e.textContent),aria:[...host.querySelectorAll('[aria-label]')].map(e=>e.getAttribute('aria-label')),tex:host.querySelector('[data-tex]')?.dataset.tex,diagram:host.querySelector('svg')?.textContent ?? ''}",
                );

            const capture = async (name: string) => {
                await page.evaluate(
                    "document.querySelector('#extension-locale-additions').scrollIntoView({block:'center'})",
                );
                const actual = await snapshot();

                if (evidence) {
                    mkdirSync(evidence, { recursive: true });
                    writeFileSync(
                        join(evidence, `${viewport}-${name}.jpg`),
                        (await page.screenshot()).data,
                    );
                }

                records.push({
                    name,
                    entry: "real diagrams Markdown registry and Agent Teams toolCall registry",
                    viewport: VIEWPORTS[viewport],
                    screenshot: evidence ? `${viewport}-${name}.jpg` : undefined,
                    ...actual,
                });

                return actual;
            };

            try {
                await page.setViewport(VIEWPORTS[viewport]);
                await page.navigate(
                    `${base}/login?token=${encodeURIComponent(app.config.ownerToken)}&next=/s/${session}`,
                );
                await see(
                    "document.querySelector('.composer textarea') && (await import('/ui-locale.js')).languages().some(e=>e.id==='zh-CN') && (await import('/markdown-ext.js')).fenceFor('mermaid') && (await import('/calls.js')).describeCall({name:'team',args:{action:'stop'}}).own",
                    "the real registered extension APIs",
                );
                await page.evaluate(
                    `const {h,render}=await import('preact');const {Markdown}=await import('/ui.js');const {store}=await import('/store.js');const host=document.body.appendChild(document.createElement('section'));host.id='extension-locale-additions';const draw=()=>render(h(Markdown,{text:${JSON.stringify(markdown)}}),host);const stop=store.subscribe(draw);globalThis.extensionLocaleDispose=()=>{stop();render(null,host);};draw();`,
                );
                await see(
                    "document.querySelector('#extension-locale-additions svg') && document.querySelector('#extension-locale-additions .katex') && document.querySelectorAll('#extension-locale-additions .pocket-diagrams-error').length===2",
                    "real Pele/KaTeX renderers and invalid source fallbacks",
                );
                const original = await snapshot();

                assert.deepEqual(original.sources, [sources[1]!.source, sources[3]!.source]);
                assert.equal(original.tex, "x^2");

                for (const [switchIndex, language] of (["en", "zh-CN", "en"] as const).entries()) {
                    await page.evaluate(`(await import('/ui-locale.js')).setLocale('${language}')`);

                    const expected = (key: string, english: string, label: string) => {
                        const template = language === "en" ? english : messages[key];

                        assert.ok(template, `the default Chinese pack must contain ${key}`);

                        return template.replaceAll("{label}", label);
                    };

                    const labels = [
                        expected(
                            "server.extensions.diagrams.diagram",
                            "{label} diagram",
                            "mermaid",
                        ),
                        expected("server.extensions.diagrams.source", "{label} source", "mermaid"),
                        expected(
                            "server.extensions.diagrams.expression",
                            "{label} expression",
                            "tex",
                        ),
                        expected("server.extensions.diagrams.source", "{label} source", "latex"),
                    ];

                    await see(
                        `${JSON.stringify(labels)}.every(label=>[...document.querySelectorAll('#extension-locale-additions [aria-label]')].some(e=>e.getAttribute('aria-label')===label))`,
                        "mounted diagram/math aria updates with the language",
                    );
                    const actual = await capture(`${switchIndex}-${language}`);

                    assert.deepEqual(actual.sources, original.sources);
                    assert.equal(actual.tex, original.tex);
                    assert.equal(actual.diagram, original.diagram);
                    const calls = await value<{
                        stop: string;
                        archive: string;
                        startSubject: string;
                        stopSubject: string;
                        archiveSubject: string;
                    }>(
                        "const {describeCall}=await import('/calls.js');const {summarize}=await import('/turns.js');const args={title:'Literal title <b>',message:'Literal message & source'};const summary=action=>summarize([{block:{type:'toolCall',id:action,name:'team',args:{...args,action}}}],false);return {stop:summary('stop'),archive:summary('archive'),startSubject:describeCall({name:'team',args:{...args,action:'start'}}).subject,stopSubject:describeCall({name:'team',args:{...args,action:'stop'}}).subject,archiveSubject:describeCall({name:'team',args:{...args,action:'archive'}}).subject}",
                    );

                    assert.ok(
                        calls.stop
                            .toLowerCase()
                            .includes(
                                expected(
                                    "server.extensions.agent-teams.stopped",
                                    "stopped",
                                    "",
                                ).toLowerCase(),
                            ),
                        calls.stop,
                    );
                    assert.ok(
                        calls.archive
                            .toLowerCase()
                            .includes(
                                expected(
                                    "server.extensions.agent-teams.archived",
                                    "archived",
                                    "",
                                ).toLowerCase(),
                            ),
                        calls.archive,
                    );
                    assert.ok(
                        !calls.stop.includes("checked") && !calls.archive.includes("checked"),
                    );
                    assert.equal(
                        calls.startSubject,
                        "Literal title <b> · Literal message & source",
                    );
                    assert.equal(calls.stopSubject, "Literal message & source");
                    assert.equal(calls.archiveSubject, "Literal message & source");
                    records.push({ viewport: VIEWPORTS[viewport], language, calls });
                }

                await app.setExtensionEnabled(owner(app), "diagrams.ts", false);
                await see(
                    "!document.querySelector('#extension-locale-additions [class*=pocket-diagrams]') && !document.querySelector('style[data-extension=diagrams]') && !(await import('/markdown-ext.js')).fenceFor('mermaid') && !(await import('/markdown-ext.js')).fenceFor('tex') && !(await import('/markdown-ext.js')).mathOn()",
                    "unloading diagrams removes renderers, output and styles",
                );
                await page.evaluate("(await import('/ui-locale.js')).setLocale('zh-CN')");
                const removed = await capture("unloaded");

                assert.deepEqual(
                    removed.sources,
                    sources.map(({ source }) => source),
                );
                assert.deepEqual(removed.aria, []);
                assert.deepEqual(
                    page
                        .logs()
                        .filter(
                            (entry) => entry.level === "error" && entry.text.startsWith("Uncaught"),
                        ),
                    [],
                );
            } finally {
                try {
                    await page.evaluate("globalThis.extensionLocaleDispose?.()");
                } finally {
                    page.close();
                }
            }
        }
    } finally {
        if (evidence) {
            mkdirSync(evidence, { recursive: true });
            writeFileSync(
                join(evidence, "extension-additions-results.json"),
                JSON.stringify(records, null, 2),
            );
        }

        await browsers.closeAll({ final: true });
        server.closeAllConnections();
        await new Promise<void>((resolve) =>
            server.listening ? server.close(() => resolve()) : resolve(),
        );
        await app.close();
    }
});
