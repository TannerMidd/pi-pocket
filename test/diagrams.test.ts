import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import { render as renderPele } from "pele";
import { renderToString } from "katex";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { cleanUp, newSession, openApp, owner, root, say, scriptedModel, until } from "./helpers.ts";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { createHandler } from "../src/server/http.ts";

after(cleanUp);

const browserAvailable = {
    skip: findBrowser() === undefined ? "no Chromium-based browser on this machine" : false,
} as const;

async function inPage<T>(page: BrowserPage, script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

test("diagrams is on by default and its browser files leave with the module", async () => {
    const app = await openApp(scriptedModel(), join(root, "diagrams"));

    try {
        const client = () =>
            app.webs.clients(owner(app)).find((module) => module.module === "diagrams");
        const files = () => client() !== undefined;

        assert.match(client()?.url ?? "", /^\/x\/diagrams\/[^/]+\/index\.js$/);
        assert.equal(
            app.webs.file("diagrams", ["index.js"], owner(app))?.type,
            "text/javascript; charset=utf-8",
        );
        assert.equal(
            app.webs.file("diagrams", ["style.css"], owner(app))?.type,
            "text/css; charset=utf-8",
        );

        await app.setExtensionEnabled(owner(app), "diagrams.ts", false);
        assert.equal(files(), false);
        assert.equal(app.webs.file("diagrams", ["index.js"], owner(app)), undefined);

        await app.setExtensionEnabled(owner(app), "diagrams.ts", true);
        assert.equal(files(), true);
        assert.ok(app.webs.file("diagrams", ["index.js"], owner(app)));
    } finally {
        await app.close();
    }
});

test("local renderers bound input and disable Pele links and images", () => {
    const options = {
        links: false,
        images: false,
        limit: 50_000,
        outputLimit: 1_000_000,
        maxEdges: 2_000,
    };
    const { svg, links } = renderPele(
        `flowchart LR
        A["<script>alert(1)</script><img src=x onerror=alert(1)>"] --> B
        click A "https://attacker.example" "external"`,
        options,
    );
    const math = renderToString(String.raw`\href{javascript:alert(1)}{x}`, {
        trust: false,
        throwOnError: false,
    });

    assert.equal(links.length, 0);
    assert.doesNotMatch(svg, /<script\b|<img\b|<a\b|<image\b|\sonerror=|href=/i);
    assert.throws(
        () => renderPele(`flowchart LR\n${" ".repeat(50_001)}`, options),
        /longer than the limit/,
    );
    assert.doesNotMatch(math, /href=["']javascript:/i);
    assert.match(renderToString("x^2"), /class="katex"/);
});

test(
    "browser renderers load lazily and streaming diagrams retain the last valid SVG",
    browserAvailable,
    async () => {
        const app = await openApp(scriptedModel(), join(root, "diagrams-browser"));
        let server: Server | undefined;
        let browsers: Browsers | undefined;

        try {
            const session = await newSession(app);

            server = createServer(
                createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
            );
            await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
            const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

            browsers = new Browsers({
                dataDir: mkdtempSync(join(root, "diagrams-browser-")),
                load: async () => undefined,
                save: () => {},
            });
            const page = await browsers.open(1);

            await page.setViewport({ width: 1280, height: 800, scale: 1, mobile: false });
            await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
            await page.navigate(`${base}/s/${session}`);
            await until(
                () =>
                    inPage(
                        page,
                        `return JSON.stringify(document.querySelector(".composer") !== null)`,
                    ),
                "the session",
            );
            await until(
                () =>
                    inPage(
                        page,
                        `const markdown = await import("/markdown-ext.js"); return JSON.stringify(["mermaid", "math", "latex", "tex"].every((lang) => markdown.fenceFor(lang)));`,
                    ),
                "the diagrams fence registrations",
            );

            const moduleUrl = app.webs
                .clients(owner(app))
                .find((module) => module.module === "diagrams")?.url;

            assert.ok(moduleUrl);

            const resources = () =>
                inPage<string[]>(
                    page,
                    `return JSON.stringify(performance.getEntriesByType("resource").map((each) => new URL(each.name).pathname));`,
                );
            const hasKatexStyles = () =>
                inPage<boolean>(
                    page,
                    `return JSON.stringify(performance.getEntriesByType("resource").some((each) => new URL(each.name).pathname === "/vendor/katex.css"));`,
                );

            assert.equal(
                (await resources()).some((path) => path.endsWith("/vendor/pele.mjs")),
                false,
            );
            assert.equal(
                (await resources()).some((path) => path.endsWith("/vendor/katex.mjs")),
                false,
            );
            assert.equal(await hasKatexStyles(), false);

            const unsafeSvg = await inPage<string>(
                page,
                `const { sanitizeSvg } = await import(${JSON.stringify(moduleUrl)});
             return JSON.stringify(sanitizeSvg(${JSON.stringify(`<svg xmlns="http://www.w3.org/2000/svg">
                 <style>@import url("https://attacker.example/style.css")</style>
                 <a href="https://attacker.example/page"><text>link</text></a>
                 <image href="https://attacker.example/image.svg" />
                 <rect style="fill:url(https://attacker.example/paint.svg#x);width:expression(alert(1))" onload="alert(1)" />
                 <rect style="fill:url(javascript:alert(1))" />
                 <rect fill="u\\72l(https://attacker.example/escaped.svg#x)" />
                 <rect style="fill:u\\72l(https://attacker.example/escaped-style.svg#x)" />
                 <foreignObject><img src="https://attacker.example/image.png" /></foreignObject>
             </svg>`)}));`,
            );

            assert.doesNotMatch(
                unsafeSvg,
                /attacker\.example|<\s*(?:a|image|style|foreignobject)\b|\b(?:href|src|xml:base)\s*=|onload\s*=|expression\s*\(|javascript\s*:/i,
            );

            const mountFence = (
                lang: string,
                source: string,
                streaming = false,
                hostId = "diagrams-test-root",
                settleMs = 0,
            ) =>
                inPage<string>(
                    page,
                    `const markdown = await import("/markdown-ext.js");
                 const { h, render } = await import("preact");
                 const host = document.getElementById(${JSON.stringify(hostId)}) ?? document.body.appendChild(document.createElement("div"));
                 host.id = ${JSON.stringify(hostId)};
                 const spec = markdown.fenceFor(${JSON.stringify(lang)});
                 render(h(spec.component, { source: ${JSON.stringify(source)}, lang: ${JSON.stringify(lang)}, streaming: ${JSON.stringify(streaming)} }), host);
                 if (${settleMs}) await new Promise((resolve) => setTimeout(resolve, ${settleMs}));
                 return JSON.stringify(host.textContent.slice(0, 500));`,
                );
            const hasInPage = (selector: string) =>
                inPage<boolean>(
                    page,
                    `return JSON.stringify(document.querySelector(${JSON.stringify(selector)}) !== null);`,
                );
            const sourceInPage = (hostId = "diagrams-test-root") =>
                inPage<string>(
                    page,
                    `return JSON.stringify(document.getElementById(${JSON.stringify(hostId)})?.textContent ?? "");`,
                );
            const diagramHasText = (text: string) =>
                inPage<boolean>(
                    page,
                    `return JSON.stringify(document.querySelector("#diagrams-test-root .pocket-diagrams-output svg")?.textContent.includes(${JSON.stringify(text)}) ?? false);`,
                );

            await mountFence("mermaid", "x".repeat(50_001));
            await until(
                () => hasInPage("#diagrams-test-root .pocket-diagrams-error"),
                "the long diagram fallback",
            );
            assert.equal((await sourceInPage()).length, 50_001);
            assert.equal(
                (await resources()).some((path) => path.endsWith("/vendor/pele.mjs")),
                false,
            );

            const diagram = `flowchart LR
            A[Start] --> B[End]
            click A "https://attacker.example/page" "external"`;

            await mountFence("mermaid", diagram);
            await until(
                () => hasInPage("#diagrams-test-root .pocket-diagrams-output svg"),
                "the diagram SVG",
            );

            const renderedSvg = await inPage<{
                tags: number;
                references: number;
                attacker: boolean;
                styled: boolean;
                themed: boolean;
            }>(
                page,
                `const svg = document.querySelector("#diagrams-test-root svg");
             const elements = [svg, ...svg.querySelectorAll("*")];
             const tags = elements.filter((each) => ["a", "image", "style", "foreignobject"].includes(each.localName.toLowerCase())).length;
             const references = elements.flatMap((each) => [...each.attributes]).filter((each) => ["href", "xlink:href", "src", "xml:base"].includes(each.name.toLowerCase())).length;
             return JSON.stringify({ tags, references, attacker: svg.outerHTML.includes("attacker.example"), styled: svg.getAttribute("style")?.includes("max-width") ?? false, themed: getComputedStyle(svg).getPropertyValue("--pele-line").trim() !== "" && getComputedStyle(svg).getPropertyValue("--pele-line").trim() === getComputedStyle(svg).getPropertyValue("--muted").trim() });`,
            );

            assert.deepEqual(renderedSvg, {
                tags: 0,
                references: 0,
                attacker: false,
                styled: true,
                themed: true,
            });
            assert.ok((await resources()).some((path) => path.endsWith("/vendor/pele.mjs")));
            assert.equal(
                (await resources()).some((path) => path.endsWith("/vendor/katex.mjs")),
                false,
            );

            const invalidDiagram = "flowchart LR\n  A -->";

            const firstStream = `flowchart LR
                A[First] --> B[Preview]`;
            const warmStream = `flowchart LR
                A[Warm] --> B[WarmReady]`;
            const latestStream = `flowchart LR
                A[Newest] --> B[Latest]`;

            await mountFence("mermaid", firstStream, true);
            await until(() => diagramHasText("Preview"), "the first streaming diagram");
            await mountFence("mermaid", warmStream, true);
            await until(() => diagramHasText("WarmReady"), "the next streaming diagram");

            const immediate = await mountFence(
                "mermaid",
                latestStream,
                true,
                "diagrams-test-root",
                50,
            );

            assert.match(immediate, /WarmReady/);
            assert.doesNotMatch(immediate, /Latest/);
            await until(() => diagramHasText("Latest"), "the bounded streaming update");

            await mountFence("mermaid", invalidDiagram, true, "diagrams-test-root", 350);
            assert.equal(await diagramHasText("Latest"), true);
            assert.equal(await hasInPage("#diagrams-test-root .pocket-diagrams-error"), false);

            await mountFence("mermaid", invalidDiagram, false, "diagrams-test-root", 50);
            assert.equal(await diagramHasText("Latest"), true);

            await mountFence("mermaid", invalidDiagram, false, "diagrams-no-valid-root", 50);
            await until(
                () => hasInPage("#diagrams-no-valid-root .pocket-diagrams-error"),
                "source fallback when no diagram renders",
            );
            assert.equal(await sourceInPage("diagrams-no-valid-root"), invalidDiagram);

            const aliases = await inPage<string[]>(
                page,
                `const markdown = await import("/markdown-ext.js");
             return JSON.stringify(["math", "latex", "tex"].map((lang) => markdown.fenceFor(lang)?.id ?? null));`,
            );

            assert.deepEqual(aliases, ["diagrams-math", "diagrams-math", "diagrams-math"]);

            await mountFence("math", "x".repeat(20_001));
            await until(
                () => hasInPage("#diagrams-test-root .pocket-diagrams-error"),
                "the long math fallback",
            );
            assert.equal((await sourceInPage()).length, 20_001);
            assert.equal(
                (await resources()).some((path) => path.endsWith("/vendor/katex.mjs")),
                false,
            );
            assert.equal(await hasKatexStyles(), false);

            await mountFence("tex", "x^2");
            await until(
                () => hasInPage("#diagrams-test-root .pocket-diagrams-math-fence .katex"),
                "the math fence",
            );
            assert.ok((await resources()).some((path) => path.endsWith("/vendor/katex.mjs")));
            await until(hasKatexStyles, "the local math stylesheet");

            const invalidMath = String.raw`\notACommand`;

            await mountFence("latex", invalidMath);
            await until(
                () => hasInPage("#diagrams-test-root .pocket-diagrams-error"),
                "the invalid math fallback",
            );
            assert.equal(await sourceInPage(), invalidMath);
            await app.setExtensionEnabled(owner(app), "diagrams.ts", false);
            await until(
                async () => !(await hasInPage('style[data-extension="diagrams"]')),
                "the module stylesheet cleanup",
            );
        } finally {
            await browsers?.closeAll({ final: true });
            server?.closeAllConnections();
            server?.close();
            await app.close();
        }
    },
);

test("a reply drawn before the module registers math draws again", browserAvailable, async (t) => {
    const route = () => fauxAssistantMessage([fauxText("Result $x^2$")]);
    const app = await openApp(scriptedModel(route), join(root, "diagrams-late"));

    await app.setExtensionEnabled(owner(app), "diagrams.ts", false);

    const session = await newSession(app);
    const listen = { host: "127.0.0.1", port: 0 };
    const server = createServer(createHandler({ app, listen, restart: () => {} }));
    const dataDir = mkdtempSync(join(root, "diagrams-late-"));
    const browsers = new Browsers({ dataDir, load: async () => undefined, save: () => {} });

    t.after(async () => {
        await browsers.closeAll({ final: true });
        server.closeAllConnections();
        server.close();
        await app.close();
    });
    await say(app, session, "hi");
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    const page = await browsers.open(1);
    const reply = (inner: string) =>
        inPage<boolean>(
            page,
            `return JSON.stringify(document.querySelector('[data-part="reply"]${inner}') !== null);`,
        );
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await page.navigate(`${base}/s/${session}`);
    await until(() => reply(""), "the reply");
    assert.equal(await reply(" .katex"), false);
    await app.setExtensionEnabled(owner(app), "diagrams.ts", true);
    await until(() => reply(" .katex"), "the reply's math after the module loads");
});
