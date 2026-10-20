// Real app routes/assets and an isolated browser; synthetic data, not physical-phone or screen-reader acceptance.
import {
    type App,
    cleanUp,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { createHandler } from "../src/server/http.ts";

const real = { skip: findBrowser() === undefined ? "no Chromium-based browser" : false };
const INPUT = ".launcher input";
const ROWS = '.launcher-item[id^="launcher-option-session%3A"]';

const option = (id: ConversationId | undefined) => {
    assert.ok(id !== undefined, "fixture session exists");

    return `.launcher-item[id="launcher-option-${encodeURIComponent(`session:${id}`)}"]`;
};

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
const ids: ConversationId[] = [];
const fixtures = [
    ["Release preparation", ["project-x", "shipping"]],
    ["Prototype handoff", ["design-review", "needs-review", "ready-for-review"]],
    ["Reliability notes", ["workspace-reliability-review", "café-👩‍💻", "👩-x", "مراجعة-التصميم"]],
    ["Weekly budget", ["finance"]],
    ["Deployment runbook", ["project-x"]],
    ["Shipping list", ["shipping"]],
    ["Confidential audit", ["private-vocabulary", "needs-review"]],
] as const;

const inPage = async <T>(script: string): Promise<T> =>
    JSON.parse(await page.evaluate(script)) as T;
const see = (script: string, what: string) =>
    until(() => inPage<boolean>(`return JSON.stringify(Boolean(${script}))`), what);
const settle = () =>
    page.evaluate(`
    await document.fonts.ready;
    // Only the palette's short transitions matter; unrelated status/boot animations can be long-lived.
    const animations=document.querySelector('.launcher')?.getAnimations({subtree:true}) ?? [];
    await Promise.all(animations.filter(a => a.effect?.getComputedTiming().endTime < 1000).map(a => a.finished.catch(() => {})));
    for (let i = 0; i < 3; i++) await new Promise(requestAnimationFrame);
`);

async function fresh(width = 390) {
    await page.setViewport({ width, height: 844, scale: 1, mobile: width < 700 });
    await page.navigate(base);
    await see(
        `document.querySelector('.home-list, .sidebar') !== null && (await import('/store.js')).store.state.sessionsLoaded`,
        "the session list",
    );
    await settle();
    await page.press("Control+k");
    await see(
        `document.activeElement === document.querySelector(${JSON.stringify(INPUT)})`,
        "focused launcher",
    );
    await settle();
}

async function search(query: string) {
    await page.evaluate(`
        const input = document.querySelector(${JSON.stringify(INPUT)});
        input.value = ${JSON.stringify(query)};
        input.dispatchEvent(new Event('input', { bubbles: true }));
    `);
    await settle();
}

async function sessionRows() {
    return await inPage<Array<{ label: string; reason: string | null; highlights: string[] }>>(`
        return JSON.stringify([...document.querySelectorAll(${JSON.stringify(ROWS)})].map(row => ({
            label: row.getAttribute('aria-label'),
            reason: row.querySelector('.launcher-tag-reason')?.textContent.trim() ?? null,
            highlights: [...row.querySelectorAll('mark')].map(mark => mark.textContent),
        })));
    `);
}

before(async () => {
    if (real.skip) {
        return;
    }

    app = await openApp(scriptedModel());
    const cwd = join(work, "pocket");

    mkdirSync(cwd);

    for (const [title, tags] of fixtures) {
        const id = await newSession(app, cwd);

        ids.push(id);
        await app.commands.updateSession(id, owner(app), { title });
        await app.commands.updateSessionTags(owner(app), { ids: [Number(id)], add: [...tags] });
    }

    const archived = ids[4];

    assert.ok(archived !== undefined);
    await app.commands.updateSession(archived, owner(app), { archived: true });
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "launcher-tags-")),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await see(`(await import('/store.js')).store.state.me?.role === 'owner'`, "signed in");
});
after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();

    if (server) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    await app?.close();
    cleanUp();
});

test(
    "tag-only search finds active and archived sessions with one strongest passive reason",
    real,
    async () => {
        await fresh();
        await search("PROJECT-X");
        let rows = await sessionRows();

        assert.equal(rows.length, 2);
        assert.ok(rows.every((row) => row.reason === "Tag:project-x"));
        assert.ok(rows.some((row) => row.label.includes("Archived")));
        await search("shipping");
        rows = await sessionRows();
        assert.equal(
            rows.find((row) => row.label.startsWith("Release preparation"))?.reason,
            "Tag:shipping",
        );
        assert.equal(
            rows.find((row) => row.label.startsWith("Shipping list"))?.reason,
            null,
            "title match needs no tag inventory",
        );
        await search("review");
        rows = await sessionRows();
        const handoff = rows.filter((row) => row.label.startsWith("Prototype handoff"));

        assert.equal(handoff.length, 1, "three matching tags do not duplicate a session");
        assert.ok(handoff[0]);
        assert.equal(handoff[0].reason, "Tag:needs-review");
        assert.ok(handoff[0].highlights.includes("review"));
        assert.ok(
            !handoff[0].label.includes("design-review"),
            "unshown tags are not an inventory in the accessible label",
        );
        await search("design-review");
        const design = (await sessionRows())[0];

        assert.ok(design);
        assert.equal(design.reason, "Tag:design-review");
        await search("👩‍💻");
        const emoji = (await sessionRows())[0];

        assert.ok(emoji);
        assert.ok(emoji.label.includes("café-👩‍💻"));
        assert.ok(emoji.highlights.includes("👩‍💻"));
        await search("👩x");
        const fuzzyEmoji = (await sessionRows())[0];

        assert.ok(fuzzyEmoji);
        assert.ok(
            fuzzyEmoji.highlights.includes("👩"),
            "a fuzzy hit cannot split an emoji surrogate pair",
        );
        await search("صميم");
        const arabic = (await sessionRows())[0];

        assert.ok(arabic?.label.includes("مراجعة-التصميم"));
        assert.equal(
            await inPage<boolean>(`
            const name=document.querySelector(${JSON.stringify(option(ids[2]))}+' .launcher-tag-name');
            return JSON.stringify(name.getAttribute('dir')==='auto' && name.querySelector('.launcher-tag-hit').textContent.trim()==='التصميم');
        `),
            true,
            "joining words stay within one inline formatting context with automatic direction",
        );
    },
);

test(
    "native combined-field search, modes and empty recent results remain intact",
    real,
    async () => {
        await fresh(1280);
        await search("budget /");
        assert.equal((await sessionRows()).length, 1, "one query can span title and folder");
        assert.equal(
            await inPage<boolean>(
                `const row=document.querySelector(${JSON.stringify(option(ids[3]))}); return JSON.stringify(!!row.querySelector('.launcher-title mark') && !!row.querySelector('.launcher-path mark'));`,
            ),
            true,
        );

        for (const query of ["> project-x", "# project-x"]) {
            await search(query);
            assert.equal((await sessionRows()).length, 0);
        }

        await search("@ project-x");
        assert.equal((await sessionRows()).length, 2);
        await search("");
        assert.equal((await sessionRows()).length, 6);
        assert.equal(
            await inPage<number>(
                `return JSON.stringify(document.querySelectorAll('.launcher-tag-reason').length)`,
            ),
            0,
        );
        assert.equal(
            await inPage<number>(
                `return JSON.stringify(document.querySelectorAll('.launcher-types button').length)`,
            ),
            4,
        );
    },
);

test(
    "opening a tag result keeps personal main-list filters and native fresh-opening focus",
    real,
    async () => {
        await fresh();
        await page.evaluate(
            `const {store}=await import('/store.js');store.set({sessionTagFilters:{person:store.state.me.id,tags:['shipping']}});`,
        );
        await search("@ design-review");
        assert.equal((await sessionRows()).length, 1);
        await page.press("Enter");
        await see(
            `(await import('/store.js')).store.state.conversationId === ${JSON.stringify(ids[1])} && !document.querySelector('.launcher')`,
            "the chosen session opened",
        );
        assert.deepEqual(
            await inPage<string[]>(
                `return JSON.stringify((await import('/store.js')).store.state.sessionTagFilters.tags)`,
            ),
            ["shipping"],
        );
        await page.press("Control+k");
        await see(
            `document.activeElement === document.querySelector(${JSON.stringify(INPUT)})`,
            "fresh input focused",
        );
        assert.equal(
            await inPage<string>(
                `return JSON.stringify(document.querySelector(${JSON.stringify(INPUT)}).value)`,
            ),
            "",
        );
        await page.press("Escape");
        await see(`!document.querySelector('.launcher')`, "closed");
    },
);

test(
    "tag reasons fit native phone and desktop density without hiding composite status",
    real,
    async () => {
        for (const width of [390, 320, 1280]) {
            await fresh(width);
            await search("review");
            assert.ok(
                (await sessionRows()).some((row) => row.label.startsWith("Reliability notes")),
            );
            const layout = await inPage<{
                overflow: boolean;
                rows: Array<{ height: number; detail: number; nested: number }>;
                text: string;
                marks: string[];
            }>(`
            const rows=[...document.querySelectorAll(${JSON.stringify(ROWS)})];
            const reliability=document.querySelector(${JSON.stringify(option(ids[2]))});
            return JSON.stringify({overflow:document.documentElement.scrollWidth>innerWidth,rows:rows.map(row=>({height:row.getBoundingClientRect().height,detail:row.querySelector('.detail').getBoundingClientRect().height,nested:row.querySelectorAll('button,a,input').length})),text:reliability.querySelector('.launcher-tag-name').textContent,marks:[...reliability.querySelectorAll('.launcher-tag-name mark')].map(m=>m.textContent)});
        `);

            assert.equal(layout.overflow, false);
            assert.ok(layout.rows.every((row) => row.detail < 22 && row.nested === 0));
            assert.ok(layout.text.includes("reliability") && layout.marks.includes("review"));

            if (width < 700) {
                assert.ok(layout.rows.every((row) => row.height >= 60));
            } else {
                assert.equal(
                    await inPage<boolean>(
                        `return JSON.stringify(!!document.querySelector(${JSON.stringify(option(ids[1]))}+' .hint kbd'))`,
                    ),
                    true,
                );
            }

            // Synthetic client status flags exercise real native rendering, not model execution or persisted run state.
            for (const state of ["waiting", "busy"]) {
                await page.evaluate(
                    `const {store}=await import('/store.js');store.set({conversationId:${JSON.stringify(ids[0])},sessions:store.state.sessions.map(s=>s.id===${JSON.stringify(ids[0])}?{...s,waiting:${state === "waiting"},busy:${state === "busy"}}:s)});`,
                );
                await search("project-x");
                const status = await inPage<{ text: string; clipped: boolean; max: string }>(
                    `const badge=document.querySelector(${JSON.stringify(option(ids[0]))}+' .launcher-state');return JSON.stringify({text:badge.textContent,clipped:badge.scrollWidth>badge.clientWidth+1,max:getComputedStyle(badge).maxWidth});`,
                );

                assert.equal(
                    status.text,
                    state === "waiting" ? "Current · Waiting" : "Current · Working",
                );
                assert.equal(status.clipped, false);
                assert.equal(status.max, "50%");
                await page.evaluate(
                    `const {store}=await import('/store.js');store.set({conversationId:${JSON.stringify(ids[2])},sessions:store.state.sessions.map(s=>s.id===${JSON.stringify(ids[2])}?{...s,waiting:${state === "waiting"},busy:${state === "busy"}}:s)});`,
                );
                await search("review");
                assert.equal(
                    await inPage<boolean>(`
                const name=document.querySelector(${JSON.stringify(option(ids[2]))}+' .launcher-tag-name');
                const box=name.getBoundingClientRect();
                return JSON.stringify([...name.querySelectorAll('mark')].every(mark=>{const r=mark.getBoundingClientRect();return r.left>=box.left-1 && r.right<=box.right+1}));
            `),
                    true,
                    "late tag highlights are visibly inside the metadata budget beside composite status",
                );
            }
        }

        assert.equal(page.logs().filter((line) => line.level === "error").length, 0);
    },
);

test(
    "tag labels, highlighted names and folder text share a typographic baseline",
    real,
    async () => {
        for (const width of [1280, 390, 320]) {
            await fresh(width);

            for (const query of ["needs", "review", "needs-review", "design-review"]) {
                await search(query);
                const baselines = await inPage<number[]>(`
                const row=document.querySelector(${JSON.stringify(option(ids[1]))});
                const label=row.querySelector('.launcher-tag-reason > span');
                const elements=[label,...row.querySelectorAll('.launcher-tag-hit mark, .launcher-tag-context')].filter(e=>e.textContent.length>0);
                const path=[...row.querySelectorAll('.launcher-path')].find(e=>e.getBoundingClientRect().width>0);
                if(path) elements.push(path);
                const values=elements.map(element=>{
                    const probe=document.createElement('span');
                    probe.style.cssText='display:inline-block;width:0;height:0;padding:0;margin:0;border:0;vertical-align:baseline';
                    element.append(probe);
                    const baseline=probe.getBoundingClientRect().top;
                    probe.remove();
                    return baseline;
                });
                return JSON.stringify(values);
            `);

                assert.ok(baselines.length >= 3);
                assert.ok(
                    Math.max(...baselines) - Math.min(...baselines) <= 0.5,
                    `${width}px / ${query}: text baselines differ: ${baselines.join(", ")}`,
                );
            }
        }
    },
);

test("tag matching follows live authorized metadata without changing the query", real, async () => {
    await fresh();
    await search("launch-track");
    assert.equal((await sessionRows()).length, 0);
    await app.commands.updateSessionTags(owner(app), {
        ids: [Number(ids[0])],
        add: ["launch-track"],
    });
    await until(
        async () => (await sessionRows()).some((row) => row.reason === "Tag:launch-track"),
        "tag result from committed event",
        5000,
    );
    assert.equal(
        await inPage<string>(
            `return JSON.stringify(document.querySelector(${JSON.stringify(INPUT)}).value)`,
        ),
        "launch-track",
    );
    await app.commands.updateSessionTags(owner(app), {
        ids: [Number(ids[0])],
        remove: ["launch-track"],
    });
    await until(
        async () => (await sessionRows()).length === 0,
        "removed tag no longer matches",
        5000,
    );
});

test("scoped viewers discover tags only on sessions they can access", real, async () => {
    const scoped = app.config.addUser("Scoped reader", "viewer", [String(ids[1])]);

    page = await browsers.open(2);
    await page.navigate(`${base}/login?token=${encodeURIComponent(scoped.token)}`);
    await fresh();
    await see(
        `(await import('/store.js')).store.state.me?.id === ${JSON.stringify(scoped.user.id)}`,
        "scoped viewer",
    );
    await search("review");
    const rows = await sessionRows();

    assert.equal(rows.length, 1);
    assert.ok(rows[0]);
    assert.ok(rows[0].label.startsWith("Prototype handoff"));
    assert.equal(rows[0].reason, "Tag:needs-review");
    await search("private-vocabulary");
    assert.equal((await sessionRows()).length, 0);
    assert.equal(
        await inPage<boolean>(
            `return JSON.stringify(document.querySelector('#launcher-results')?.textContent.includes('private-vocabulary') ?? false)`,
        ),
        false,
    );
});
