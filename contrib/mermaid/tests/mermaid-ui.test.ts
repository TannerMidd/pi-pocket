// Import the root helpers first: they isolate Pi's settings before server modules load.
import {
    type App,
    cleanUp,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
} from "../../../test/helpers.ts";
import assert from "node:assert/strict";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { Browsers } from "../../../src/server/browser.ts";
import { findBrowser } from "../../../src/server/browser/discovery.ts";
import type { BrowserPage } from "../../../src/server/browser/page.ts";
import { createHandler } from "../../../src/server/http.ts";

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
} as const;
const DESKTOP = { width: 1440, height: 900, scale: 1, mobile: false };
const MOBILE = { width: 390, height: 844, scale: 1, mobile: true };
const FLOW = "flowchart LR\n    Start[Start here] --> Finish[Finish here]";
const SEQUENCE = "sequenceDiagram\n    Alice->>Bob: Hello Bob\n    Bob-->>Alice: Hello Alice";
const fence = (source: string, language = "mermaid") => `\`\`\`${language}\n${source}\n\`\`\``;

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let answer = "";
let attackRequests = 0;

const inPage = async <T>(script: string): Promise<T> =>
    JSON.parse(await page.evaluate(script)) as T;
const count = (selector: string) =>
    inPage<number>(
        `return JSON.stringify(document.querySelectorAll(${JSON.stringify(selector)}).length)`,
    );

before(async () => {
    if (chromium === undefined) {
        return;
    }

    const dropIns = join(root, "data", "extensions");
    const extension = join(import.meta.dirname, "..");

    mkdirSync(dropIns, { recursive: true });
    // Copy only the installable drop-in, including its already-built local vendor.js.
    copyFileSync(join(extension, "mermaid.ts"), join(dropIns, "mermaid.ts"));
    cpSync(join(extension, "mermaid"), join(dropIns, "mermaid"), { recursive: true });
    app = await openApp(scriptedModel(() => fauxAssistantMessage([fauxText(answer)])));
    await app.setExtensionEnabled(owner(app), "mermaid.ts", true);
    const handler = createHandler({
        app,
        listen: { host: "127.0.0.1", port: 0 },
        restart: () => {},
    });

    server = createServer((request, response) => {
        if (request.url?.startsWith("/mermaid-ui-attack")) {
            attackRequests++;
        }

        void handler(request, response);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "mermaid-ui-")),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
    await page.setViewport(DESKTOP);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    const moduleState = () =>
        inPage<{ status: string; error: string | null } | null>(`
        return JSON.stringify((await import("/extension-ui.js")).browserModuleState("mermaid") ?? null);
    `);

    await until(async () => {
        const state = await moduleState();

        return state !== null && state.status !== "loading";
    }, "the Mermaid browser module");
    const state = await moduleState();

    assert.equal(state?.status, "ready", state?.error ?? "the Mermaid browser module must load");
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

/** Use a real saved assistant reply, not a test-only renderer or an injected extension. */
async function show(markdown: string): Promise<void> {
    answer = markdown;
    const id = await newSession(app);

    await say(app, id, "Show the test example.");
    await page.navigate(`${base}/s/${id}`);
    await until(
        () =>
            inPage<boolean>(`return JSON.stringify(Boolean(document.querySelector(".composer")))`),
        "the conversation",
    );
}

/** A successful block must contain a visible, decoded image or a laid-out SVG. */
async function rendered(expected: number): Promise<void> {
    await until(
        async () => {
            const failure = await inPage<string>(
                `return JSON.stringify(document.querySelector(".x-mermaid-error")?.textContent ?? "")`,
            );

            assert.equal(failure, "", failure);

            return inPage<boolean>(`
                const blocks = [...document.querySelectorAll(".x-mermaid-diagram")];

                return JSON.stringify(blocks.length === ${expected} && blocks.every((block) => {
                    const image = block.querySelector("img, svg");
                    const box = image?.getBoundingClientRect();

                    return box?.width > 0 && box?.height > 0 &&
                        (image.tagName.toLowerCase() !== "img" || (image.complete && image.naturalWidth > 0));
                }));
            `);
        },
        `${expected} rendered Mermaid diagrams`,
        20_000,
    ).catch(async (error) => {
        console.error(
            await inPage(`return JSON.stringify({
            html: document.querySelector(".md-code-renderer")?.outerHTML.slice(0, 8000),
            markdown: [...document.querySelectorAll(".md")].map((node) => node.outerHTML.slice(0, 4000)),
            body: document.body.innerText.slice(-4000),
            dimensions: [...document.querySelectorAll(".x-mermaid, .x-mermaid-diagram, .x-mermaid-diagram svg")].map((node) => ({tag: node.tagName, rect: node.getBoundingClientRect().toJSON()})),
            state: (await import("/extension-ui.js")).browserModuleState("mermaid"),
        })`),
        );

        throw error;
    });
    assert.equal(await count(".x-mermaid-error"), 0);
}

/** Inspect the browser's rendered SVG, including SVGs isolated inside image elements. */
async function diagrams(): Promise<{ text: string; ids: string[]; unsafe: string[] }[]> {
    return inPage(`
        const result = [];

        for (const block of document.querySelectorAll(".x-mermaid-diagram")) {
            const image = block.querySelector("img, svg");

            if (!image) {
                continue;
            }

            const markup = image.tagName.toLowerCase() === "img"
                ? await (await fetch(image.currentSrc || image.src)).text()
                : new XMLSerializer().serializeToString(image);
            const svg = new DOMParser().parseFromString(markup, "image/svg+xml");
            const unsafe = [];

            for (const node of svg.querySelectorAll("*")) {
                if (["script", "foreignobject", "iframe", "object", "embed", "image"].includes(node.localName.toLowerCase())) {
                    unsafe.push(node.localName);
                }

                for (const attr of node.attributes) {
                    if (/^on/i.test(attr.localName) ||
                        (["href", "src"].includes(attr.localName) && !attr.value.startsWith("#"))) {
                        unsafe.push(attr.name + "=" + attr.value);
                    }
                }
            }

            result.push({
                text: svg.documentElement.textContent,
                ids: [...svg.querySelectorAll("[id]")].map((node) => node.id),
                unsafe,
            });
        }

        return JSON.stringify(result);
    `);
}

/** Open the user's source disclosure and read selectable code, including after a render failure. */
async function sourceAt(index: number): Promise<string> {
    const selector = `.x-mermaid:nth-of-type(${index + 1})`;

    // Use the block's own disclosure, not a global transcript copy button.
    await inPage(`
        const diagram = document.querySelectorAll(".x-mermaid")[${index}];
        const block = diagram.closest(".md-code-renderer");
        const control = [...block.querySelectorAll("summary, button")].find((node) => /source/i.test(node.textContent + " " + (node.getAttribute("aria-label") || "")));

        if (!control) {
            throw new Error("No source control in Mermaid block ${index}");
        }

        if (control.tagName === "SUMMARY" ? !control.parentElement.open : control.getAttribute("aria-expanded") !== "true") {
            control.click();
        }

        return "null";
    `);
    await until(
        () =>
            inPage<boolean>(`
            const code = document.querySelectorAll(".x-mermaid")[${index}]?.closest(".md-code-renderer").querySelector("details pre code, details pre");

            return JSON.stringify(Boolean(code && code.getBoundingClientRect().height > 0));
        `),
        `visible Mermaid source in ${selector}`,
    );

    return inPage<string>(`
        const block = document.querySelectorAll(".x-mermaid")[${index}].closest(".md-code-renderer");

        return JSON.stringify(block.querySelector("details pre code, details pre").textContent.trimEnd());
    `);
}

test("flowchart and sequence fences render their labels and keep exact source", real, async () => {
    for (const source of [FLOW, SEQUENCE]) {
        await show(fence(source));
        await rendered(1);
        assert.equal(await count(".x-mermaid"), 1);
        const [diagram] = await diagrams();

        assert.ok(diagram);

        for (const label of source === FLOW
            ? ["Start here", "Finish here"]
            : ["Alice", "Bob", "Hello Bob", "Hello Alice"]) {
            assert.ok(diagram.text.includes(label), `the rendered diagram contains ${label}`);
        }

        assert.deepEqual(diagram.unsafe, []);
        assert.equal(await sourceAt(0), source);
    }
});

test("pie slices keep distinct colors and match their legend", real, async () => {
    await show(fence('pie title Counts\n    "First" : 2\n    "Second" : 3\n    "Third" : 4'));
    await rendered(1);
    const chart = await inPage<{ slices: string[]; legend: string[] }>(`
        const svg = document.querySelector(".x-mermaid-diagram svg");

        return JSON.stringify({
            slices: [...svg.querySelectorAll(".pieCircle")].map((node) => getComputedStyle(node).fill),
            legend: [...svg.querySelectorAll(".legend rect")].map((node) => getComputedStyle(node).fill),
        });
    `);

    assert.equal(chart.slices.length, 3);
    assert.equal(new Set(chart.slices).size, 3);
    assert.ok(chart.slices.every((color) => color !== "none" && color !== "rgba(0, 0, 0, 0)"));
    assert.deepEqual(new Set(chart.slices), new Set(chart.legend));
});

test("invalid Mermaid reports an accessible error and retains its source", real, async () => {
    const invalid = "flowchart LR\n    A[unterminated --> B";

    await show(fence(invalid));
    await until(
        async () => (await count('.x-mermaid-error[role="alert"]')) === 1,
        "the parse error",
    );
    assert.ok(
        await inPage<boolean>(`
        const error = document.querySelector('.x-mermaid-error[role="alert"]');

        return JSON.stringify(error.textContent.trim().length > 0 && error.getBoundingClientRect().height > 0);
    `),
    );
    assert.equal(await count(".x-mermaid-diagram img, .x-mermaid-diagram svg"), 0);
    assert.equal(await sourceAt(0), invalid);
});

test("multiple diagrams render independently without duplicate SVG identifiers", real, async () => {
    await show(
        [fence(FLOW), fence(SEQUENCE), fence("flowchart TD\n    Third --> Fourth")].join("\n\n"),
    );
    await rendered(3);
    const results = await diagrams();
    const ids = results.flatMap((diagram) => diagram.ids);

    assert.equal(new Set(ids).size, ids.length, "markers and nodes have distinct identifiers");
    assert.ok(results[0]?.text.includes("Start here"));
    assert.ok(results[1]?.text.includes("Hello Bob"));
    assert.ok(results[2]?.text.includes("Fourth"));
    assert.equal(await sourceAt(1), SEQUENCE);
});

test("wide diagrams and open source do not overflow a 390 by 844 phone", real, async () => {
    const wide =
        "flowchart LR\n    " +
        Array.from({ length: 15 }, (_, at) => `N${at}[Step ${at}: a long label]`).join(" --> ");

    try {
        await page.setViewport(MOBILE);
        await show(fence(wide));
        await rendered(1);
        assert.equal(await sourceAt(0), wide);
        const size = await inPage<{
            width: number;
            scroll: number;
            boxes: { left: number; right: number; width: number }[];
        }>(`
            return JSON.stringify({
                width: innerWidth,
                scroll: document.documentElement.scrollWidth,
                boxes: [...document.querySelectorAll(".x-mermaid, .x-mermaid-diagram, .md-code-renderer:has(.x-mermaid) pre")].map((node) => {
                    const box = node.getBoundingClientRect();

                    return { left: box.left, right: box.right, width: box.width };
                }),
            });
        `);

        assert.equal(size.width, 390);
        assert.ok(size.scroll <= 391, `the page stays phone-width: ${JSON.stringify(size)}`);
        assert.ok(size.boxes.length >= 3);

        for (const box of size.boxes) {
            assert.ok(box.width > 0 && box.left >= -1 && box.right <= 391, JSON.stringify(box));
        }
    } finally {
        await page.setViewport(DESKTOP);
    }
});

/** Read actual painted SVG colors, not the extension's CSS or its implementation. */
const colors = () =>
    inPage<{ fill: string; stroke: string; text: string }>(`
    const svg = document.querySelector(".x-mermaid-diagram svg");
    const shape = svg.querySelector(".node rect, rect");
    const text = svg.querySelector("text, tspan");

    return JSON.stringify({
        fill: getComputedStyle(shape).fill,
        stroke: getComputedStyle(shape).stroke,
        text: getComputedStyle(text).fill,
    });
`);
const theme = (name: string) =>
    inPage(`
    (await import("/theme.js")).setPrefs({ theme: ${JSON.stringify(name)} });

    return "null";
`);

test("existing SVGs follow light and dark colors without a rerender", real, async () => {
    await show(fence(FLOW));
    await rendered(1);
    await theme("catppuccin-latte");
    const light = await colors();

    await inPage(`
        globalThis.mermaidOriginalSvg = document.querySelector(".x-mermaid-diagram svg");

        return "null";
    `);
    await theme("catppuccin");
    await until(async () => (await colors()).fill !== light.fill, "dark diagram colors");
    const dark = await colors();

    assert.notEqual(dark.text, light.text, "the rendered labels follow the palette");
    assert.notEqual(dark.stroke, light.stroke, "the rendered edges follow the palette");
    assert.notEqual(dark.fill, "none");
    assert.notEqual(dark.text, "rgba(0, 0, 0, 0)");
    await theme("catppuccin-latte");
    await until(
        async () => JSON.stringify(await colors()) === JSON.stringify(light),
        "light colors restored",
    );
    assert.equal(
        await inPage<boolean>(`
        return JSON.stringify(document.querySelector(".x-mermaid-diagram svg") === globalThis.mermaidOriginalSvg);
    `),
        true,
        "the same diagram follows both palette changes",
    );
});

test("HTML, click URLs, callbacks, and source CSS cannot reach the app", real, async () => {
    const examples = [
        'flowchart LR\n    A["<img src=/mermaid-ui-attack onerror=globalThis.__mermaidAttack=1>"] --> B[Safe]',
        'flowchart LR\n    A@{img: "/mermaid-ui-attack", h: 20, label: "Probe"}',
        "classDiagram\n    class A\n    style A fill:url(/mermaid-ui-attack)",
        'classDiagram\n    class A["/*"]\n    style A fill:url(/mermaid-ui-attack)',
        "classDiagram\n    class A\n    style A fill:u\\72l(/mermaid-ui-attack)",
        "stateDiagram-v2\n    A --> B\n    style A fill:url(/mermaid-ui-attack)",
        'C4Context\n    Person(a, "A")\n    UpdateElementStyle(a, $bgColor="url(/mermaid-ui-attack)")',
        'flowchart LR\n    A[Tap me] --> B[Safe]\n    click A "javascript:globalThis.__mermaidAttack=1"',
        'flowchart LR\n    A[Tap me] --> B[Safe]\n    click A "/mermaid-ui-attack"',
        "flowchart LR\n    A[Tap me] --> B[Safe]\n    click A call mermaidAttack()",
        "flowchart LR\n    A[Safe] --> B[Safe]\n    classDef attack fill:#ff00ff,stroke:#ff00ff;\n    class A attack;",
    ];

    for (const source of examples) {
        const previousRequests = attackRequests;

        await show(fence(source));
        await inPage(`
            globalThis.__mermaidAttack ??= 0;
            globalThis.mermaidAttack = () => { globalThis.__mermaidAttack++; };

            return "null";
        `);
        await until(
            async () =>
                (await count('.x-mermaid-error[role="alert"], .x-mermaid-diagram svg')) === 1,
            "safe output or a clear refusal",
            20_000,
        );
        const output = await diagrams();

        for (const diagram of output) {
            assert.deepEqual(
                diagram.unsafe,
                [],
                "rendered SVG contains no active HTML or external references",
            );
        }

        assert.equal(
            await inPage<boolean>(`
            const diagram = document.querySelector(".x-mermaid-diagram");
            const unsafe = diagram.querySelector("a, script, img, image, foreignObject, iframe, object, embed, style, [style]");

            for (const node of diagram.querySelectorAll(".node")) {
                node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            }

            return JSON.stringify(Boolean(unsafe));
        `),
            false,
        );
        assert.equal(await inPage<number>(`return JSON.stringify(globalThis.__mermaidAttack)`), 0);
        assert.equal(
            attackRequests,
            previousRequests,
            "the diagram sends no image or click request",
        );
        assert.equal(await sourceAt(0), source, "unsafe input stays accessible as inert code");
    }

    await show(fence(FLOW));
    await rendered(1);
});

test("configuration directives, front matter, and oversized input fail clearly", real, async () => {
    const examples = [
        '%%{init: {"securityLevel":"loose","flowchart":{"htmlLabels":true},"themeCSS":"body{display:none}"}}%%\n' +
            FLOW,
        "---\nconfig:\n  securityLevel: loose\n  htmlLabels: true\n---\n" + FLOW,
        FLOW + "\n%% " + "x".repeat(20_001),
    ];

    for (const source of examples) {
        await show(fence(source));
        await until(
            async () => (await count('.x-mermaid-error[role="alert"]')) === 1,
            "a clear refusal",
        );
        assert.equal(await count(".x-mermaid-diagram svg"), 0);
        assert.equal(await sourceAt(0), source);
        assert.ok(
            await inPage<boolean>(`
            const error = document.querySelector('.x-mermaid-error[role="alert"]');

            return JSON.stringify(error.textContent.trim().length > 0 && error.getBoundingClientRect().height > 0);
        `),
        );
    }
});

test("non-Mermaid fences and ordinary Markdown retain their normal behavior", real, async () => {
    const javascript = 'const label = "<not HTML>";';
    const plain = "flowchart LR\n    This --> StaysCode";

    await show(
        [
            "Normal **bold text** and `inline code`.",
            fence(javascript, "javascript"),
            fence(plain, "text"),
            fence("no language stays code", ""),
            fence(
                '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="red"/></svg>',
                "svg",
            ),
            fence(FLOW),
        ].join("\n\n"),
    );
    await rendered(1);
    const blocks = await inPage<string[]>(`
        return JSON.stringify([...document.querySelectorAll(".code:not(:has(.x-mermaid)) pre code")].map((node) => node.textContent.trimEnd()));
    `);

    assert.ok(blocks.includes(javascript), JSON.stringify(blocks));
    assert.ok(blocks.includes(plain), JSON.stringify(blocks));
    assert.ok(blocks.includes("no language stays code"), JSON.stringify(blocks));
    assert.equal(await count(".code.rich.svg img"), 1, "the built-in SVG preview still works");
    assert.ok(
        await inPage<boolean>(`
        return JSON.stringify([...document.querySelectorAll("strong")].some((node) => node.textContent === "bold text") &&
            [...document.querySelectorAll("code")].some((node) => node.textContent === "inline code"));
    `),
    );
});

test("disabling Mermaid restores ordinary code in the open conversation", real, async () => {
    await show(fence(FLOW));
    await rendered(1);

    try {
        await app.setExtensionEnabled(owner(app), "mermaid.ts", false);
        await until(
            async () => (await count(".x-mermaid")) === 0,
            "the renderer removed without navigation",
        );
        await until(
            () =>
                inPage<boolean>(`
            return JSON.stringify([...document.querySelectorAll("pre code")].some((node) => node.textContent.trimEnd() === ${JSON.stringify(FLOW)}));
        `),
            "the ordinary Mermaid code fence restored",
        );
    } finally {
        await app.setExtensionEnabled(owner(app), "mermaid.ts", true);
    }

    await rendered(1);
});
