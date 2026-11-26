import {
    type App,
    cleanUp,
    context,
    newSession,
    openApp,
    root,
    say,
    scriptedModel,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { before, after, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { SessionsDoc } from "../src/server/docs.ts";
import { createHandler } from "../src/server/http.ts";

const real = { skip: findBrowser() === undefined ? "Chromium not installed" : false };
let app: App, server: Server, browsers: Browsers, base: string;
let lead: ConversationId, branch: ConversationId, proof: ConversationId, other: ConversationId;
const extra = 1476;
const q = JSON.stringify;
const explorer = ".family-explorer";
const result = (id: number) => explorer + ' .session-row[data-id="' + id + '"] > .session';
const get = async <T>(p: BrowserPage, expression: string): Promise<T> =>
    JSON.parse(await p.evaluate("return JSON.stringify(" + expression + ")")) as T;
const wait = async (p: BrowserPage, selector: string) =>
    assert.ok(await p.waitFor({ selector }), selector + " shows");
const run = async (p: BrowserPage, source: string) => p.evaluate(source);

const enter = async (p: BrowserPage, selector: string) => {
    await wait(p, selector);
    await run(p, "document.querySelector(" + q(selector) + ").focus()");
    await p.press("Enter");
};

async function shot(p: BrowserPage, name: string) {
    const path = process.env.POCKET_FAMILY_SHOTS;

    if (path) {
        // Keep transition frames out of the evidence; do not wait for infinite activity indicators.
        await run(
            p,
            "await Promise.allSettled(document.getAnimations().filter(a=>a.effect?.getComputedTiming().endTime < 2000).map(a=>a.finished))",
        );
        mkdirSync(path, { recursive: true });
        writeFileSync(
            join(path, name + ".jpg"),
            Buffer.from((await p.screenshot()).data, "base64"),
        );
    }
}

before(async () => {
    if (real.skip) {
        return;
    }

    app = await openApp(scriptedModel());
    lead = await newSession(app);
    branch = await newSession(app);
    proof = await newSession(app);
    other = await newSession(app);
    await say(
        app,
        proof,
        "Review the proof.\n\n" +
            Array.from(
                { length: 45 },
                (_, i) => "Print check " + (i + 1) + ": verify the line spacing.",
            ).join("\n\n"),
    );
    await app.harness.commit(async (tx) => {
        const items = (await tx.doc(SessionsDoc)).items;
        const t = Date.UTC(2023, 2, 8);

        Object.assign(items[String(lead)]!, { title: "Atlas proofs" });
        Object.assign(items[String(branch)]!, {
            title: "South plates",
            linkedFrom: { id: Number(lead) },
            updatedAt: t + 1800,
        });
        Object.assign(items[String(proof)]!, {
            title: "Night legend",
            linkedFrom: { id: Number(branch) },
            updatedAt: t + extra - 28.5,
        });
        Object.assign(items[String(other)]!, { title: "Night legend", updatedAt: t });

        for (let i = 0; i < extra; i++) {
            items[String(100000 + i)] = {
                title: i === 0 ? "Night legend" : "Sheet " + (i + 1),
                cwd: "/proofs",
                createdAt: t + i,
                updatedAt: t + i,
                linkedFrom: { id: Number(i % 3 === 0 ? branch : lead) },
                archived: i % 17 === 0,
            };
        }
    }, context);
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = "http://127.0.0.1:" + (server.address() as { port: number }).port;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "family-ui-")),
        load: async () => undefined,
        save: () => {},
    });
});
after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

for (const mobile of [false, true]) {
    test("browse and return at " + (mobile ? "390×844" : "1920×1080"), real, async () => {
        const p = await browsers.open(mobile ? 2 : 1);
        const device = mobile ? "phone" : "desktop";

        await p.setViewport({
            width: mobile ? 390 : 1920,
            height: mobile ? 844 : 1080,
            scale: 1,
            mobile,
        });
        await p.navigate(base + "/login?token=" + encodeURIComponent(app.config.ownerToken));
        await p.navigate(base + "/s/" + proof);
        await wait(p, ".scroller .transcript");
        await wait(p, ".family-context .lead-route");
        assert.equal(
            await get(
                p,
                "document.querySelector('.family-context .lead-route strong').textContent",
            ),
            "South plates",
        );
        assert.equal(await get(p, "document.querySelector('.scroller .family-context')"), null);
        await run(
            p,
            `const {togglePin,isPinned}=await import('/theme.js');for(const id of [100001,100002,100003,100004]) if(!isPinned(id)) togglePin(id);`,
        );
        const sidebar = mobile ? ".drawer" : ".sidebar";

        if (mobile) {
            await p.press("Control+b");
        }

        const browse = sidebar + ' [data-family-open="row-' + lead + '"]';

        await wait(p, browse);
        assert.equal(
            await get(p, `document.querySelectorAll(${q(sidebar + " .session-row")}).length`),
            5,
            "two roots, two shortcuts and the open child",
        );
        await shot(p, device + "-recent");
        await enter(p, sidebar + ' [data-family-open="work"]');
        await wait(p, explorer + " .session-row");
        assert.equal(
            await get(p, "document.querySelectorAll('.family-explorer .session-row').length"),
            4,
        );
        await enter(p, '[aria-label="Back from session index"]');
        await wait(p, browse);
        await enter(p, browse);
        await wait(p, explorer + " .session-row");
        assert.equal(
            await get(p, "document.querySelector('.family-range').textContent"),
            "1–12 of 1,478",
        );
        await enter(p, '[aria-label="Next page"]');
        await enter(p, '[aria-label="Next page"]');
        await wait(p, result(proof));
        const y = await get<number>(
            p,
            "(document.querySelector('.family-explorer .session-items').scrollTop=64,document.querySelector('.family-explorer .session-items').scrollTop)",
        );

        await shot(p, device + "-index");
        await enter(p, result(proof));
        await wait(p, ".scroller .transcript");
        await enter(p, '[aria-label="Back to results"]');
        await wait(p, result(proof));
        assert.equal(
            await get(p, "document.querySelector('.family-pager span').textContent"),
            "Page 3 of 124",
        );
        assert.equal(
            await get(p, "document.activeElement.matches(" + q(result(proof)) + ")"),
            true,
        );
        assert.equal(
            await get(p, "document.querySelector('.family-explorer .session-items').scrollTop"),
            y,
        );
        await p.type({ selector: explorer + " input" }, "Night legend");
        assert.equal(
            await get(p, "document.querySelectorAll('.family-explorer .session-row').length"),
            2,
        );
        assert.match(
            await get<string>(p, "document.querySelector(" + q(result(proof)) + ").innerText"),
            /Atlas proofs › South plates/,
        );
        await enter(p, result(proof));
        await wait(p, ".scroller .transcript");
        await run(p, "history.back()");
        await wait(p, result(proof));
        assert.equal(
            await get(p, "document.querySelector('.family-explorer input').value"),
            "Night legend",
        );
        await run(p, "history.back()");
        await wait(p, browse);

        if (mobile) {
            await p.press("Escape");
            await wait(p, ".family-context .lead-route");
        }

        const scrolled = await get<number>(
            p,
            "(document.querySelector('.scroller').scrollTop=95,document.querySelector('.scroller').scrollTop)",
        );

        assert.ok(scrolled > 0);
        const message = "Update the plate register for " + device + ".";

        await say(app, branch, message);
        await wait(p, ".lead-unread");
        assert.equal(
            await get(
                p,
                "document.querySelector('.transcript').textContent.includes(" + q(message) + ")",
            ),
            false,
        );
        await shot(p, device + "-child");
        await enter(p, ".lead-route");
        await wait(p, '.family-context [data-family-open="header-family"]');
        assert.ok(await p.waitFor({ text: message }));
        assert.equal(await get(p, "document.querySelectorAll('.family-context button').length"), 2);
        await run(p, "history.back()");
        await wait(p, ".scroller .transcript");
        assert.equal(await get(p, "document.querySelector('.lead-unread')"), null);
        assert.equal(await get(p, "document.querySelector('.scroller').scrollTop"), scrolled);

        if (mobile) {
            await p.press("Control+b");
        }

        await enter(p, sidebar + ' [data-family-open="all"]');
        await p.type({ selector: explorer + " input" }, "Night legend");
        assert.equal(
            await get(p, "document.querySelectorAll('.family-explorer .session-row').length"),
            3,
        );
        assert.equal(await get(p, "document.documentElement.scrollWidth > innerWidth"), false);
    });
}

test("waiting is not unread for an unrestricted viewer", real, async () => {
    const guest = app.config.addUser("Team reader", "viewer");
    const p = await browsers.open(4);

    await p.setViewport({ width: 390, height: 844, scale: 1, mobile: true });
    await p.navigate(base + "/login?token=" + encodeURIComponent(guest.token));
    await p.navigate(base + "/s/" + branch);
    await wait(p, ".family-context");
    const pending = app.approvals.request(
        {
            id: "family-call",
            conversationId: proof,
            taskId: 1 as never,
            callId: "review",
            tool: "write",
            subject: "Save proof notes",
            reason: "Review changes",
            createdAt: Date.now(),
        },
        context,
    );

    try {
        await wait(p, ".family-attn");
        assert.match(
            await get<string>(p, "document.querySelector('.family-attn').innerText"),
            /1 waiting/,
        );
        assert.equal(await get(p, "!!document.querySelector('.lead-unread')"), false);
        await enter(p, '.family-context [data-family-open="header-family"]');
        await wait(p, explorer + " .session-row");
        await p.type({ selector: explorer + " input" }, "Night legend");
        await wait(p, result(proof));
        assert.match(
            await get<string>(p, "document.querySelector(" + q(result(proof)) + ").innerText"),
            /Waiting/,
        );
        assert.equal(
            await get(p, "!!document.querySelector('.family-explorer [aria-label=Archive]')"),
            false,
        );
    } finally {
        app.approvals.answer("family-call", { allow: false, by: "test" });
        await pending;
    }
});

test(
    "a restricted viewer gets no parent identity, counts or inaccessible search hits",
    real,
    async () => {
        const guest = app.config.addUser("Reader", "viewer", [String(proof)]);
        const p = await browsers.open(3);

        await p.setViewport({ width: 390, height: 844, scale: 1, mobile: true });
        await p.navigate(base + "/login?token=" + encodeURIComponent(guest.token));
        await p.navigate(base + "/s/" + proof);
        await wait(p, ".scroller .transcript");
        assert.equal(await get(p, "!!document.querySelector('.family-context')"), false);
        await p.navigate(base + "/s/index/all");
        await wait(p, result(proof));
        assert.equal(
            await get(p, "document.querySelectorAll('.family-explorer .session-row').length"),
            1,
        );
        assert.doesNotMatch(
            await get<string>(p, "document.body.innerText"),
            /Atlas proofs|South plates|1,478/,
        );
        await p.type({ selector: explorer + " input" }, "South plates");
        assert.equal(
            await get(p, "document.querySelectorAll('.family-explorer .session-row').length"),
            0,
        );
        await p.navigate(base + "/s/index/" + lead);
        await wait(p, ".family-range");
        assert.equal(
            await get(p, "document.querySelector('.family-range').innerText"),
            "0 results",
        );
    },
);
