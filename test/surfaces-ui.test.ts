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
        render: ({ props, value, set, disabled }) => pocket.html\`<div class="stars">\${props.label}\${[1, 2, 3].map((n) => pocket.html\`<button class="star" disabled=\${disabled} onClick=\${() => set(n)}>\${n <= (value ?? 0) ? "★" : "☆"}</button>\`)}</div>\`,
    });
}
`,
    );
    app = await openApp(scriptedModel(route));
    await app.setExtensionEnabled(owner(app), "stars.ts", true);
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
