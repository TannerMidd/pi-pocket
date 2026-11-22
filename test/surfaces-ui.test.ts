// A surface in a real Chromium (design test 11): tick rows and "13.9 GB selected" changes in two tabs, Delete resolves
// after its question, Pi's call wakes with the values, and a fork shows the card as text, read-only.
import {
    type App,
    cleanUp,
    context,
    lastText,
    loadTools,
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
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { SurfacesDoc } from "../src/server/docs.ts";
import { createHandler } from "../src/server/http.ts";

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
} as const;
const SLOW = 30_000;

const card = {
    action: "show",
    title: "Cleanup dry run",
    wait: { minutes: 120 },
    data: {
        rows: [
            { name: "/tmp/a", size: 4200000000, picked: true },
            { name: "/tmp/b", size: 9700000000, picked: false },
        ],
    },
    computed: {
        gb: {
            "@call": "bytes",
            args: {
                value: { "@call": "sum", args: { list: "/rows", field: "size", where: "picked" } },
            },
        },
    },
    components: [
        {
            type: "Column",
            children: [
                {
                    type: "Table",
                    rows: "/rows",
                    select: "picked",
                    columns: [
                        { label: "Path", value: "name" },
                        { label: "Size", value: "size", format: "bytes" },
                    ],
                },
                {
                    type: "Text",
                    text: { "@call": "formatString", args: { value: "${/$/gb} selected" } },
                },
                {
                    type: "Row",
                    children: [
                        {
                            type: "Button",
                            id: "delete",
                            label: "Delete",
                            style: "danger",
                            action: {
                                event: {
                                    name: "delete",
                                    confirm: "Delete the selected paths?",
                                    context: {
                                        paths: {
                                            "@call": "pick",
                                            args: { list: "/rows", field: "name", where: "picked" },
                                        },
                                    },
                                },
                            },
                        },
                    ],
                },
            ],
        },
    ],
};

const noteCard = {
    action: "show",
    title: "Note",
    wait: { minutes: 120 },
    data: { note: "old", marker: "v1" },
    components: [
        {
            type: "Column",
            children: [
                { type: "Text", text: { "@path": "/marker" } },
                { type: "TextField", label: "Note", bind: "/note" },
                {
                    type: "Button",
                    id: "send",
                    label: "Send",
                    action: { event: { name: "send", context: { note: { "@path": "/note" } } } },
                },
            ],
        },
    ],
};

// The server never runs a pattern from Pi: the browser's form is the only check.
const codeCard = {
    ...noteCard,
    title: "Code",
    components: [
        {
            type: "Column",
            children: [
                { type: "TextField", label: "Code", bind: "/note", pattern: "^[0-9]+$" },
                noteCard.components[0]!.children[2]!,
            ],
        },
    ],
};

const controlsCard = {
    action: "show",
    title: "Controls",
    wait: { minutes: 120 },
    data: { size: "M", tags: ["a"], rating: 1 },
    components: [
        {
            type: "Column",
            children: [
                { type: "ChoicePicker", label: "Size", bind: "/size", options: ["S", "M", "L"] },
                {
                    type: "ChoicePicker",
                    label: "Tags",
                    bind: "/tags",
                    multiple: true,
                    options: ["a", "b"],
                },
                { type: "x.stars.Rating", label: "Quality", bind: "/rating" },
                {
                    type: "Row",
                    children: [
                        {
                            type: "Button",
                            id: "plain",
                            label: "Plain",
                            action: { event: { name: "plain", resolves: false } },
                        },
                        {
                            type: "Button",
                            id: "gone",
                            label: "Gone",
                            action: {
                                event: { name: "gone", confirm: "Really?", resolves: false },
                            },
                        },
                        {
                            type: "Button",
                            id: "off",
                            label: "Off",
                            disabled: true,
                            action: { event: { name: "off", resolves: false } },
                        },
                    ],
                },
            ],
        },
    ],
};

const layoutCard = {
    action: "show",
    title: "Layout",
    data: {
        rows: [
            { name: "/tmp/a", size: 1, picked: false },
            { name: "/tmp/b", size: 2, picked: true },
        ],
    },
    components: [
        {
            type: "Column",
            children: [
                {
                    type: "Row",
                    children: ["Approve everything", "Request a review", "Discard all changes"].map(
                        (label, at) => ({
                            type: "Button",
                            id: `b${at}`,
                            label,
                            action: { event: { name: `b${at}`, resolves: false } },
                        }),
                    ),
                },
                {
                    type: "Table",
                    rows: "/rows",
                    select: "picked",
                    columns: [
                        { label: "Path", value: "name" },
                        { label: "Size", value: "size" },
                    ],
                },
            ],
        },
    ],
};

const route: Parameters<typeof scriptedModel>[0] = (request) => {
    const { role, text } = lastText(request as never);

    if (role === "toolResult") {
        return fauxAssistantMessage([fauxText("Deleted what you chose.")]);
    }

    if (text.includes("show the rating")) {
        return fauxAssistantMessage(
            [
                fauxToolCall("ui", {
                    action: "show",
                    title: "Rate it",
                    data: { rating: 1 },
                    components: [{ type: "x.stars.Rating", label: "Quality", bind: "/rating" }],
                } as never),
            ],
            { stopReason: "toolUse" },
        );
    }

    for (const [words, card] of [
        ["show the note", noteCard],
        ["show the code", codeCard],
        ["show the controls", controlsCard],
        ["show the layout", layoutCard],
    ] as const) {
        if (text.includes(words)) {
            return fauxAssistantMessage([fauxToolCall("ui", card as never)], {
                stopReason: "toolUse",
            });
        }
    }

    return text.includes("show the cleanup")
        ? fauxAssistantMessage([fauxToolCall("ui", card as never)], { stopReason: "toolUse" })
        : fauxAssistantMessage([fauxText(`echo: ${text}`)]);
};

let app: App;
let server: Server;
let base = "";
let session: ConversationId;
const browsers: Browsers[] = [];

async function tab(
    path: string,
    width = 1100,
    token = app.config.ownerToken,
): Promise<BrowserPage> {
    const set = new Browsers({
        dataDir: mkdtempSync(join(root, "surfaces-ui-")),
        load: async () => undefined,
        save: () => {},
    });

    browsers.push(set);
    const page = await set.open(1);

    await page.setViewport({ width, height: 800, scale: 1, mobile: false });
    await page.navigate(`${base}/login?token=${encodeURIComponent(token)}`);
    await page.navigate(`${base}${path}`);

    return page;
}

const count = async (page: BrowserPage, selector: string) =>
    JSON.parse(
        await page.evaluate(
            `return JSON.stringify(document.querySelectorAll(${JSON.stringify(selector)}).length)`,
        ),
    ) as number;

const run = async (page: BrowserPage, script: string) =>
    JSON.parse(await page.evaluate(`return JSON.stringify(await (async () => { ${script} })())`));

const surfaceOf = async (id: ConversationId) =>
    Object.values((await app.harness.snapshot(SurfacesDoc, id, context))!.items)[0]!;

async function shown(words: string, wanted: string, width = 1100) {
    const id = await newSession(app);

    await loadTools(app, id, "ui");
    const page = await tab(`/s/${id}`, width);

    await waitFor(page, ".composer textarea", undefined, "the message box");
    await app.commands.submit(id, owner(app), { text: words, requestId: `ui-${id}` });
    await waitFor(page, ".surf", undefined, `the card of "${wanted}"`);

    return { id, page };
}

const text = async (page: BrowserPage, selector: string) =>
    JSON.parse(
        await page.evaluate(
            `return JSON.stringify(document.querySelector(${JSON.stringify(selector)})?.textContent ?? "")`,
        ),
    ) as string;

async function waitFor(
    page: BrowserPage,
    selector: string,
    words: RegExp | undefined,
    what: string,
) {
    await until(
        async () =>
            words === undefined
                ? JSON.parse(
                      await page.evaluate(
                          `return JSON.stringify(Boolean(document.querySelector(${JSON.stringify(selector)})))`,
                      ),
                  )
                : words.test(await text(page, selector)),
        what,
        SLOW,
    );
}

before(async () => {
    if (chromium === undefined) {
        return;
    }

    mkdirSync(join(root, "data", "extensions"), { recursive: true });
    writeFileSync(
        join(root, "data", "extensions", "stars.ts"),
        `/** Stars: a rating component for surfaces. */
import { int, obj, opt, str } from "@earendil-works/pi-schema";
export default (_host, web) => {
    web.client("stars.js");
    web.surfaceComponent({
        type: "x.stars.Rating",
        props: obj({ label: str({ maxLength: 40 }) }),
        bind: int({ minimum: 0, maximum: 5 }),
        text: (props, data) => props.label + ": " + String(data.rating ?? 0) + " of 5",
    });
};
`,
    );
    writeFileSync(
        join(root, "data", "extensions", "stars.js"),
        `export const pocketApi = 1;
export default function (pocket) {
    pocket.surfaceComponent({
        type: "x.stars.Rating",
        render: ({ props, value, set, act, disabled }) => pocket.html\`<div class="stars">\${props.label}\${[1, 2, 3].map((n) => pocket.html\`<button class="star" disabled=\${disabled} onClick=\${() => set(n)}>\${n <= (value ?? 0) ? "★" : "☆"}</button>\`)}</div><button class="act-gone" onClick=\${() => act("gone")}></button><button class="act-off" onClick=\${() => act("off")}></button>\`,
    });
}
`,
    );
    writeFileSync(
        join(root, "data", "extensions", "rogue.ts"),
        `/** Rogue: a browser module that draws another module's component. */
export default (_host, web) => {
    web.client("rogue.js");
};
`,
    );
    writeFileSync(
        join(root, "data", "extensions", "rogue.js"),
        `export const pocketApi = 1;
export default function (pocket) {
    try {
        pocket.surfaceComponent({
            type: "x.stars.Rating",
            render: () => pocket.html\`<div class="rogue">EVIL</div>\`,
        });
    } catch (error) {
        console.warn("rogue refused", error.message);
    }
}
`,
    );
    app = await openApp(scriptedModel(route));
    await app.setExtensionEnabled(owner(app), "stars.ts", true);
    await app.setExtensionEnabled(owner(app), "rogue.ts", true);
    session = await newSession(app);
    await loadTools(app, session, "ui");
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
    for (const set of browsers) {
        await set.closeAll({ final: true });
    }

    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test(
    "rows ticked in one tab show in the other, and Delete resolves the card and wakes Pi",
    real,
    async () => {
        const one = await tab(`/s/${session}`);
        const two = await tab(`/s/${session}`, 390);

        await waitFor(one, ".composer textarea", undefined, "the message box");
        await app.commands.submit(session, owner(app), {
            text: "show the cleanup",
            requestId: "ui-1",
        });
        await waitFor(one, ".surf .surf-text", /4\.2 GB selected/, "the card in the first tab");
        await waitFor(two, ".surf .surf-text", /4\.2 GB selected/, "the card in the second tab");

        await one.evaluate(
            `document.querySelectorAll(".surf .surf-pick input")[1].click(); return "null"`,
        );
        await waitFor(one, ".surf .surf-text", /13\.9 GB selected/, "the total in the first tab");
        await waitFor(two, ".surf .surf-text", /13\.9 GB selected/, "the total in the second tab");

        if (process.env.SURF_SHOTS !== undefined) {
            const { writeFileSync } = await import("node:fs");

            writeFileSync(
                `${process.env.SURF_SHOTS}/phone.jpg`,
                Buffer.from((await two.screenshot()).data, "base64"),
            );
            writeFileSync(
                `${process.env.SURF_SHOTS}/desk.jpg`,
                Buffer.from((await one.screenshot()).data, "base64"),
            );
        }

        // Nothing is wider than the phone.
        assert.equal(
            JSON.parse(
                await two.evaluate(
                    `return JSON.stringify(document.documentElement.scrollWidth <= 390)`,
                ),
            ),
            true,
        );

        await one.evaluate(
            `[...document.querySelectorAll(".surf button")].find((b) => b.textContent.trim() === "Delete").click(); return "null"`,
        );
        await waitFor(one, ".surf-confirm", /Delete the selected paths\?/, "the question");
        await one.evaluate(
            `[...document.querySelectorAll(".surf-confirm button")].find((b) => b.textContent.trim() === "Yes").click(); return "null"`,
        );
        await waitFor(one, ".surf-foot", /done/i, "the card done in the first tab");
        await waitFor(two, ".surf-foot", /done/i, "the card done in the second tab");
        await until(
            async () =>
                JSON.stringify(await app.transcripts.allEntries(session as never, true)).includes(
                    "Deleted what you chose.",
                ),
            "Pi's answer",
            SLOW,
        );

        const surface = Object.values(
            (await app.harness.snapshot(SurfacesDoc, session, context))!.items,
        )[0]!;

        assert.equal(surface.status, "done");
        assert.deepEqual(surface.final?.values, { paths: ["/tmp/a", "/tmp/b"] });
    },
);

test("a fork shows the card as read-only text", real, async () => {
    const { id } = await app.commands.fork(session, owner(app), {});
    const page = await tab(`/s/${id}`);

    await waitFor(page, ".surf-copy", /13\.9 GB selected[^]*\(done\)/, "the text of the card");
    assert.equal(
        JSON.parse(
            await page.evaluate(
                `return JSON.stringify(document.querySelectorAll(".surf button, .surf input").length)`,
            ),
        ),
        0,
    );
});

test(
    "an extension's component is drawn by its browser module, and shows its text without it",
    real,
    async () => {
        const id = await newSession(app);

        await loadTools(app, id, "ui");
        const invited = app.config.addUser("Ines", "guest", [String(id)]);
        const owners = await tab(`/s/${id}`);

        await app.commands.submit(id, owner(app), { text: "show the rating", requestId: "ui-2" });
        await waitFor(owners, ".surf .stars .star", undefined, "the stars");
        assert.match(await text(owners, ".surf .stars"), /Quality★☆☆/);
        // Another module's browser part cannot draw this module's type.
        assert.equal(await count(owners, ".surf .rogue"), 0);
        await owners.evaluate(`document.querySelectorAll(".surf .star")[2].click(); return "null"`);
        await waitFor(owners, ".surf .stars", /Quality★★★/, "the rating set to 3");
        assert.equal(
            Object.values((await app.harness.snapshot(SurfacesDoc, id, context))!.items)[0]!.data
                .rating,
            3,
        );

        // A person invited to one session loads no extension browser module: the card shows the module's text.
        const theirs = await tab(`/s/${id}`, 390, invited.token);

        await waitFor(theirs, ".surf .surf-text", /Quality: 3 of 5/, "the text of the component");
        assert.equal(
            JSON.parse(
                await theirs.evaluate(
                    `return JSON.stringify(document.querySelectorAll(".surf .star").length)`,
                ),
            ),
            0,
        );
    },
);

const SEND = `[...document.querySelectorAll(".surf button")].find((b) => b.textContent.trim() === "Send")`;
const TYPE = `const input = document.querySelector(".surf input[type=text]"); input.focus(); input.value = "typed now"; input.dispatchEvent(new Event("input", { bubbles: true }));`;

test("a press sends the text typed just before it, in the same request", real, async () => {
    const { id, page } = await shown("show the note", "Note");

    await run(page, `${TYPE} ${SEND}.click(); return null;`);
    await until(async () => (await surfaceOf(id)).status === "done", "the card done", SLOW);
    assert.deepEqual((await surfaceOf(id)).final?.values, { note: "typed now" });
});

test(
    "a draft that does not fit the field's pattern stops the press and says why",
    real,
    async () => {
        const { id, page } = await shown("show the code", "Code");

        await run(page, `${TYPE} ${SEND}.click(); return null;`);
        await waitFor(page, ".surf-why", /does not fit the form/, "the field's note");
        assert.equal((await surfaceOf(id)).status, "open", "nothing was pressed");

        await run(
            page,
            `const input = document.querySelector(".surf input[type=text]"); input.value = "1234"; input.dispatchEvent(new Event("input", { bubbles: true })); ${SEND}.click(); return null;`,
        );
        await until(async () => (await surfaceOf(id)).status === "done", "the card done", SLOW);
        assert.deepEqual((await surfaceOf(id)).final?.values, { note: "1234" });
    },
);

test(
    "a field that lost focus and a press right after it still send the text first",
    real,
    async () => {
        const { id, page } = await shown("show the note", "Note");

        await run(page, `${TYPE} document.activeElement.blur(); ${SEND}.click(); return null;`);
        await until(async () => (await surfaceOf(id)).status === "done", "the card done", SLOW);
        assert.deepEqual((await surfaceOf(id)).final?.values, { note: "typed now" });
    },
);

test(
    "an edit carries the card's pv from when typing began, and a refused one is dropped once",
    real,
    async () => {
        const { id, page } = await shown("show the note", "Note");

        await run(page, `${TYPE} return null;`);
        // Pi changes the card while the person types.
        await app.harness.commit(async (tx) => {
            const surface = Object.values((await tx.doc(SurfacesDoc, id)).items)[0]!;

            surface.data.marker = "v2";
            surface.rev += 1;
            surface.pv += 1;
        }, context);
        await waitFor(page, ".surf .surf-text", /v2/, "Pi's change in the card");
        await run(page, `document.activeElement.blur(); return null;`);
        await waitFor(page, ".surf-error", /changed/i, "the refusal");

        // The draft is gone: the field shows the stored text, and the blur does not send it again.
        assert.equal(await run(page, `return document.querySelector(".surf input").value`), "old");
        assert.equal((await surfaceOf(id)).data.note, "old");
    },
);

test(
    "controls stay enabled and focused while a press is on its way, and a confirm takes the focus",
    real,
    async () => {
        const { id, page } = await shown("show the controls", "Controls");

        await waitFor(page, ".surf .act-gone", undefined, "the extension's buttons");

        // Pressing a plain button keeps the focus on it (it is never disabled for its own request).
        await run(
            page,
            `const plain = [...document.querySelectorAll(".surf-btn")].find((b) => b.textContent.trim() === "Plain"); plain.focus(); plain.click(); return null;`,
        );
        await until(async () => (await surfaceOf(id)).last?.name === "plain", "the press", SLOW);
        await until(
            async () =>
                await run(
                    page,
                    `return document.activeElement?.textContent.trim() === "Plain" && !document.activeElement.disabled`,
                ),
            "the focus on the button",
            SLOW,
        );

        // An extension's act of a button asks the same question: it focuses "Yes", and Escape gives the focus back.
        await run(page, `document.querySelector(".act-gone").click(); return null;`);
        await waitFor(page, ".surf-confirm", /Really\?/, "the question");
        await until(
            async () =>
                (await run(page, `return document.activeElement.textContent.trim()`)) === "Yes",
            "the focus on Yes",
            SLOW,
        );
        await run(
            page,
            `document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return null;`,
        );
        await until(
            async () => (await count(page, ".surf-confirm")) === 0,
            "the question gone",
            SLOW,
        );
        await until(
            async () =>
                (await run(page, `return document.activeElement.textContent.trim()`)) === "Gone",
            "the focus back on the button",
            SLOW,
        );

        // A button that is off does nothing for an extension's act: no question and no request.
        await run(page, `document.querySelector(".act-off").click(); return null;`);
        await run(page, `document.querySelector(".act-gone").click(); return null;`);
        await waitFor(page, ".surf-confirm", /Really\?/, "the question again");
        assert.equal(await count(page, ".surf-error"), 0);
        assert.equal((await surfaceOf(id)).last?.name, "plain");
    },
);

test(
    "the radio buttons move with the arrow keys, and the multiple choice is a labelled group",
    real,
    async () => {
        const { id, page } = await shown("show the controls", "Controls");

        assert.equal(await count(page, `.surf [role=group][aria-label="Tags"]`), 1);
        assert.deepEqual(
            await run(
                page,
                `return [...document.querySelectorAll(".surf [role=radio]")].map((b) => b.tabIndex)`,
            ),
            [-1, 0, -1],
        );
        await run(
            page,
            `const on = document.querySelector('.surf [role=radio][aria-checked=true]'); on.focus(); on.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); return null;`,
        );
        await until(async () => (await surfaceOf(id)).data.size === "L", "the choice moved", SLOW);
        assert.equal(
            await run(page, `return document.activeElement.textContent.trim()`),
            "L",
            "the focus follows",
        );
    },
);

test("a card that someone else may use says so in words under each control", real, async () => {
    const { id } = await shown("show the controls", "Controls");
    const guest = app.config.addUser("Ines", "guest", [String(id)]);
    const theirs = await tab(`/s/${id}`, 390, guest.token);

    await waitFor(theirs, ".surf-why", /Only the owner can use this/, "the reason");
    // A picker, the multiple choice, and the three buttons: each has its own line.
    assert.ok((await count(theirs, ".surf-why")) >= 5);
});

test(
    "a row wraps on a phone without breaking a word, and a table stacks by its card's width",
    real,
    async () => {
        const { page } = await shown("show the layout", "Layout", 390);
        const wide = await shown("show the layout", "Layout", 1100);
        const broken = `let broken = 0; for (const b of document.querySelectorAll(".surf-row .surf-btn")) { const walk = document.createTreeWalker(b, NodeFilter.SHOW_TEXT); for (let node = walk.nextNode(); node; node = walk.nextNode()) { for (const word of node.data.matchAll(/\\S+/g)) { const range = document.createRange(); range.setStart(node, word.index); range.setEnd(node, word.index + word[0].length); if (range.getClientRects().length > 1) { broken++; } } } } return broken;`;

        assert.equal(await run(page, `return document.documentElement.scrollWidth <= 390`), true);
        assert.equal(await run(page, broken), 0);
        assert.equal(
            await run(
                page,
                `return getComputedStyle(document.querySelector(".surf-table td")).display`,
            ),
            "block",
        );
        assert.equal(
            await run(
                wide.page,
                `return getComputedStyle(document.querySelector(".surf-table td")).display`,
            ),
            "table-cell",
        );
        // The select column has a name for screen readers.
        assert.equal(await text(page, "th.surf-pick .surf-sr"), "Select");
    },
);

test(
    "a question closes when Pi changes the card under it, so Yes never confirms the new layout",
    real,
    async () => {
        const { id, page } = await shown("show the controls", "Controls");

        await run(
            page,
            `[...document.querySelectorAll(".surf-btn")].find((b) => b.textContent.trim() === "Gone").click(); return null;`,
        );
        await waitFor(page, ".surf-confirm", /Really\?/, "the question");
        await app.harness.commit(async (tx) => {
            const surface = Object.values((await tx.doc(SurfacesDoc, id)).items)[0]!;

            surface.rev += 1;
            surface.pv += 1;
        }, context);
        await until(
            async () => (await count(page, ".surf-confirm")) === 0,
            "the question closed",
            SLOW,
        );
    },
);
