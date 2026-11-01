/** Private, short-lived Chromium renders. No shared page, profile, or sign-in cookie reaches a design. */
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Chromium, type Json } from "../browser/cdp.ts";
import { findBrowser, profileFolder } from "../browser/discovery.ts";
import type { PocketHost } from "../host.ts";
import type { DesignBundle } from "./bundle.ts";

export const VIEWPORTS = {
    mobile: { width: 390, height: 844 },
    tablet: { width: 820, height: 1180 },
    desktop: { width: 1280, height: 800 },
} as const;

export type ViewportName = keyof typeof VIEWPORTS;
export type TweakValues = Record<string, string | number | boolean>;
export type DesignAction = { type: "hover" | "click" | "focus"; selector: string };
export type DesignViewport = { width: number; height: number };
const LIMIT_MS = 90_000;
const QUEUE_MS = 300_000;
const QUEUE_LENGTH = 16;
// Keep the /a/ page policy and add a separate, stricter render-only policy. CSP policies intersect.
const ARTIFACT_CSP =
    "sandbox allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-pointer-lock allow-downloads; frame-ancestors 'self'";
const RENDER_CSP =
    "sandbox allow-scripts allow-modals; frame-src 'none'; worker-src 'none'; object-src 'none'; connect-src http: https:;";

export class Slots {
    readonly #limit: number;
    readonly #queue: number;
    readonly #waitMs: number;
    readonly #waiting: (() => void)[] = [];
    #active = 0;

    constructor(limit: number, queue: number, waitMs = QUEUE_MS) {
        this.#limit = limit;
        this.#queue = queue;
        this.#waitMs = waitMs;
    }

    get active(): number {
        return this.#active;
    }

    get waiting(): number {
        return this.#waiting.length;
    }

    async acquire(signal?: AbortSignal): Promise<() => void> {
        signal?.throwIfAborted();

        if (this.#active < this.#limit && this.#waiting.length === 0) {
            this.#active++;

            return this.#releaser();
        }

        if (this.#waiting.length >= this.#queue) {
            throw new Error(
                `${this.#queue} design renders are already waiting. Try again in a minute.`,
            );
        }

        await new Promise<void>((resolve, reject) => {
            const leave = () => {
                clearTimeout(timer);
                signal?.removeEventListener("abort", onAbort);
                const index = this.#waiting.indexOf(grant);

                if (index !== -1) {
                    this.#waiting.splice(index, 1);
                }
            };

            const grant = () => {
                leave();
                this.#active++;
                resolve();
            };

            const onAbort = () => {
                leave();
                reject(signal?.reason ?? new Error("The design render stopped."));
            };

            const timer = setTimeout(() => {
                leave();
                reject(new Error("Waited too long for a free design render."));
            }, this.#waitMs);

            this.#waiting.push(grant);
            signal?.addEventListener("abort", onAbort, { once: true });
        });

        return this.#releaser();
    }

    #releaser(): () => void {
        let done = false;

        return () => {
            if (done) {
                return;
            }

            done = true;
            this.#active--;
            this.#waiting.shift()?.();
        };
    }
}

const renders = new Slots(2, QUEUE_LENGTH);

/** The default slide size of a deck, as the canvas lays slides out. */
export const SLIDE_SIZE: DesignViewport = { width: 1920, height: 1080 };

/** A `pocket-slide-size` value (`WxH`, each 320 to 3840), or the default for anything else. */
export function parseSlideSize(value: string): DesignViewport {
    const match = /^\s*(\d{3,4})\s*[x×]\s*(\d{3,4})\s*$/i.exec(value);

    if (match === null) {
        return SLIDE_SIZE;
    }

    const width = Number(match[1]);
    const height = Number(match[2]);

    if (width < 320 || height < 320 || width > 3840 || height > 3840) {
        return SLIDE_SIZE;
    }

    return { width, height };
}

export function tweakValues(value: unknown): TweakValues {
    if (value === undefined || value === null) {
        return {};
    }

    if (typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Tweaks must be an object of names and values.");
    }

    const entries = Object.entries(value);

    if (entries.length > 40) {
        throw new Error("Tweaks can set up to 40 values.");
    }

    const out: TweakValues = {};

    for (const [name, item] of entries) {
        if (name.length === 0 || name.length > 80) {
            throw new Error("A tweak name is 1 to 80 characters.");
        }

        if (
            !(typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item))) &&
            !(typeof item === "string" && item.length <= 200)
        ) {
            throw new Error(
                `Tweak ${name} needs a string (up to 200 characters), number, or boolean.`,
            );
        }

        out[name] = item;
    }

    return out;
}

export function designActions(value: unknown): DesignAction[] {
    if (value === undefined || value === null) {
        return [];
    }

    if (!Array.isArray(value) || value.length > 10) {
        throw new Error("Actions must be a list of up to 10 steps.");
    }

    return value.map((item, index) => {
        const { type, selector } = (item ?? {}) as { type?: unknown; selector?: unknown };

        if (
            (type !== "hover" && type !== "click" && type !== "focus") ||
            typeof selector !== "string" ||
            selector.length === 0 ||
            selector.length > 300
        ) {
            throw new Error(
                `Action ${index + 1} needs a type (hover, click, or focus) and a selector of up to 300 characters.`,
            );
        }

        return { type, selector };
    });
}

export function viewportOf(value: string | DesignViewport = "desktop"): DesignViewport {
    if (typeof value === "string") {
        if (Object.hasOwn(VIEWPORTS, value)) {
            return VIEWPORTS[value as ViewportName];
        }

        const match = /^(\d{3,4})x(\d{3,4})$/.exec(value);

        if (match === null) {
            throw new Error("Viewport must be mobile, tablet, desktop, or WIDTHxHEIGHT.");
        }

        value = { width: Number(match[1]), height: Number(match[2]) };
    }

    if (
        !Number.isInteger(value.width) ||
        !Number.isInteger(value.height) ||
        value.width < 320 ||
        value.width > 2560 ||
        value.height < 240 ||
        value.height > 2560
    ) {
        throw new Error("Viewport must be 320–2560 pixels wide and 240–2560 pixels tall.");
    }

    return { ...value };
}

/** Only this bundle is available. A random bearer path expires when the render ends. */
export async function serveBundle(bundle: DesignBundle) {
    const token = randomBytes(32).toString("hex");
    const prefix = `/${token}/a/`;
    const assets = new Map(bundle.assets.map((asset) => [asset.name, asset]));
    const server = createServer((request, response) => {
        let url: URL;
        let name: string;

        try {
            url = new URL(request.url ?? "/", "http://127.0.0.1");
            name = decodeURIComponent(url.pathname.slice(prefix.length));
        } catch {
            response.writeHead(400).end();

            return;
        }

        if (
            !url.pathname.startsWith(prefix) ||
            (request.method !== "GET" && request.method !== "HEAD")
        ) {
            response.writeHead(404).end();

            return;
        }

        const asset = assets.get(name);

        if (name !== "" && asset === undefined) {
            response.writeHead(404).end();

            return;
        }

        response.writeHead(200, {
            "content-type": asset?.type ?? "text/html; charset=utf-8",
            "cache-control": "no-store",
            "referrer-policy": "no-referrer",
            "access-control-allow-origin": "*",
            "x-content-type-options": "nosniff",
            // No popups, workers, frames, or sockets can bypass the page's request interception.
            "content-security-policy": `${ARTIFACT_CSP}, ${RENDER_CSP}`,
        });
        response.end(request.method === "HEAD" ? undefined : (asset?.bytes ?? bundle.content));
    });

    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();

    if (address === null || typeof address === "string") {
        server.close();

        throw new Error("The private render server did not start.");
    }

    return {
        url: `http://127.0.0.1:${address.port}${prefix}`,
        close: async () => {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}

export class DesignPage {
    readonly errors: string[] = [];
    readonly failedRequests: string[] = [];
    readonly #browser: Chromium;
    readonly #session: string;
    readonly #url: string;
    readonly #host: PocketHost;
    readonly #signal: AbortSignal;
    #requests = 0;
    #pending = 0;
    #networkBytes = 0;
    #slideDisplays: string[] | undefined;

    constructor(
        browser: Chromium,
        session: string,
        url: string,
        host: PocketHost,
        signal: AbortSignal,
    ) {
        this.#browser = browser;
        this.#session = session;
        this.#url = url;
        this.#host = host;
        this.#signal = signal;
        browser.connection.listen(session, (method, params) => this.#event(method, params));
    }

    #record(list: string[], text: string): void {
        if (list.length < 100) {
            list.push(text.slice(0, 2000));
        }
    }

    #event(method: string, params: Json): void {
        if (method === "Fetch.requestPaused") {
            void this.#request(params).catch(() => {});
        } else if (method === "Runtime.exceptionThrown") {
            const error = params.exceptionDetails;

            this.#record(this.errors, String(error?.exception?.description ?? error?.text));
        } else if (method === "Runtime.consoleAPICalled" && params.type === "error") {
            this.#record(
                this.errors,
                (params.args ?? [])
                    .map((arg: Json) => String(arg.value ?? arg.description ?? arg.type))
                    .join(" "),
            );
        } else if (method === "Network.loadingFailed") {
            this.#record(this.failedRequests, String(params.errorText));
        } else if (method === "Network.responseReceived" && params.response?.status >= 400) {
            this.#record(this.failedRequests, `${params.response.status} ${params.response.url}`);
        } else if (method === "Page.javascriptDialogOpening") {
            void this.send("Page.handleJavaScriptDialog", { accept: false }).catch(() => {});
        }
    }

    async #request(params: Json): Promise<void> {
        const url = String(params.request.url);
        const id = params.requestId;
        let external = false;

        try {
            if (++this.#requests > 400) {
                throw new Error("The design exceeded 400 requests.");
            }

            if (url === new URL("/favicon.ico", this.#url).href) {
                await this.send("Fetch.fulfillRequest", { requestId: id, responseCode: 204 });

                return;
            }

            // Only the token-scoped bundle bypasses the public-network guard. Redirects go through Fetch again.
            if (url.startsWith(this.#url) && /^(GET|HEAD)$/.test(params.request.method)) {
                await this.send("Fetch.continueRequest", { requestId: id });

                return;
            }

            if (params.resourceType === "Document") {
                throw new Error(
                    "External document navigation is disabled during design rendering.",
                );
            }

            if (new URL(url).protocol !== "https:") {
                throw new Error("External design resources must use public HTTPS addresses.");
            }

            if (!/^(GET|HEAD)$/.test(params.request.method)) {
                throw new Error("Preview requests must use GET or HEAD.");
            }

            if (this.#pending >= 20 || this.#networkBytes >= 50_000_000) {
                throw new Error("The design exceeded its external request budget.");
            }

            this.#pending++;
            external = true;
            // Fetch on the server pins DNS and rejects private addresses at every connection and redirect.
            // No browser cookies, credentials, or authorization headers are forwarded.
            const response = await this.#host.fetchPublic(url, {
                method: params.request.method,
                signal: this.#signal,
                redirect: "manual",
                maxBytes: 5_000_000,
                timeoutMs: 10_000,
            });
            const bytes = Buffer.from(await response.arrayBuffer());

            this.#networkBytes += bytes.length;

            if (this.#networkBytes > 50_000_000) {
                throw new Error("The design exceeded 50 MB of external resources.");
            }

            const headers = [...response.headers]
                .filter(
                    ([name]) =>
                        !["set-cookie", "content-encoding", "content-length"].includes(name),
                )
                .map(([name, value]) => ({ name, value }));

            await this.send("Fetch.fulfillRequest", {
                requestId: id,
                responseCode: response.status,
                responseHeaders: headers,
                body: bytes.toString("base64"),
            });
        } catch (error) {
            this.#record(this.failedRequests, `${url}: ${String(error)}`);
            await this.send("Fetch.failRequest", { requestId: id, errorReason: "BlockedByClient" });
        } finally {
            if (external) {
                this.#pending--;
            }
        }
    }

    send(method: string, params: Record<string, unknown> = {}): Promise<Json> {
        this.#signal.throwIfAborted();

        return this.#browser.connection.send(method, params, this.#session, 15_000);
    }

    async evaluate(expression: string): Promise<Json> {
        const result = await this.send("Runtime.evaluate", {
            expression,
            returnByValue: true,
            awaitPromise: true,
            timeout: 10_000,
        });

        if (result.exceptionDetails !== undefined) {
            throw new Error(
                String(result.exceptionDetails.exception?.description ?? "Render script failed."),
            );
        }

        return result.result?.value;
    }

    // An isolated world: the script sees the page's DOM and styles but none of the page's own scripts, so a page cannot change the objects that the script uses.
    async evaluateIsolated(expression: string): Promise<Json> {
        const tree = await this.send("Page.getFrameTree");
        const world = await this.send("Page.createIsolatedWorld", {
            frameId: tree.frameTree.frame.id,
            worldName: "pocket-check",
        });
        const result = await this.send("Runtime.evaluate", {
            expression,
            contextId: world.executionContextId,
            returnByValue: true,
            awaitPromise: true,
            timeout: 10_000,
        });

        if (result.exceptionDetails !== undefined) {
            throw new Error(
                String(result.exceptionDetails.exception?.description ?? "Check script failed."),
            );
        }

        return result.result?.value;
    }

    async load(
        viewport: DesignViewport,
        options: { scale?: number; page?: string } = {},
    ): Promise<void> {
        this.#slideDisplays = undefined;
        await this.setScale(viewport, options.scale ?? 1);
        const url =
            options.page === undefined
                ? this.#url
                : this.#url + options.page.split("/").map(encodeURIComponent).join("/");
        const result = await this.send("Page.navigate", { url });

        if (result.errorText) {
            throw new Error(String(result.errorText));
        }

        // Readiness is bounded even when an image, font, or page request never finishes.
        for (let attempt = 0; attempt < 50; attempt++) {
            if ((await this.evaluate("document.readyState")) === "complete") {
                break;
            }

            await new Promise((resolve) => setTimeout(resolve, 100));
        }

        await this.settle();
    }

    async setScale(viewport: DesignViewport, scale = 1): Promise<void> {
        await this.send("Emulation.setDeviceMetricsOverride", {
            ...viewport,
            deviceScaleFactor: scale,
            mobile: viewport.width < 500,
        });
    }

    async settle(): Promise<void> {
        await this.evaluateIsolated(`Promise.race([
            Promise.all([document.fonts.ready, ...Array.from(document.images, image => image.decode().catch(() => {}))]),
            new Promise(resolve => setTimeout(resolve, 3000))
        ]).then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))`);
    }

    async applyView(
        view: {
            colorScheme?: "light" | "dark";
            theme?: string;
            forceTheme?: boolean;
            tweaks?: TweakValues;
        } = {},
    ): Promise<void> {
        if (view.colorScheme !== undefined) {
            await this.send("Emulation.setEmulatedMedia", {
                features: [{ name: "prefers-color-scheme", value: view.colorScheme }],
            });
        }

        if (view.theme !== undefined && /^[a-z0-9][a-z0-9-]{0,63}$/.test(view.theme)) {
            await this.evaluate(
                view.forceTheme === true
                    ? `document.documentElement.setAttribute('data-theme', ${JSON.stringify(view.theme)})`
                    : `document.documentElement.hasAttribute('data-theme') || document.documentElement.setAttribute('data-theme', ${JSON.stringify(view.theme)})`,
            );
        }

        const tweaks = view.tweaks ?? {};

        if (Object.keys(tweaks).length > 0) {
            await this.evaluate(`((values) => {
                let manifest = [];
                try { manifest = JSON.parse(document.getElementById('pocket-tweaks')?.textContent ?? '[]'); } catch {}
                const units = Object.create(null);
                for (const knob of Array.isArray(manifest) ? manifest.slice(0, 40) : []) {
                    if (knob && typeof knob.name === 'string' && typeof knob.unit === 'string') units[knob.name] = knob.unit;
                }
                for (const [name, value] of Object.entries(values)) {
                    if (/^--[A-Za-z0-9_-]{1,78}$/.test(name)) {
                        const style = document.documentElement.style;
                        if (typeof value === 'number') style.setProperty(name, value + (units[name] ?? ''));
                        else style.setProperty(name, typeof value === 'boolean' ? (value ? '1' : '0') : value);
                    }
                    window.dispatchEvent(new CustomEvent('pocket:tweak', { detail: { name, value } }));
                }
            })(${JSON.stringify(tweaks)})`);
        }

        await this.settle();
    }

    async act(actions: DesignAction[]): Promise<string[]> {
        const notes: string[] = [];

        for (const [index, action] of actions.entries()) {
            const label = `action ${index + 1} (${action.type} ${action.selector.slice(0, 60)})`;
            let box: { x: number; y: number } | null | undefined;

            try {
                box = (await this.evaluate(`(() => {
                    const el = document.querySelector(${JSON.stringify(action.selector)});
                    if (el === null) return null;
                    el.scrollIntoView({ block: 'center', inline: 'center' });
                    if (${JSON.stringify(action.type)} === 'focus') {
                        el.focus({ preventScroll: true, focusVisible: true });
                        return { x: 0, y: 0 };
                    }
                    const rect = el.getBoundingClientRect();
                    if (rect.width <= 0 || rect.height <= 0) return undefined;
                    return {
                        x: Math.min(Math.max(rect.left + rect.width / 2, 1), innerWidth - 1),
                        y: Math.min(Math.max(rect.top + rect.height / 2, 1), innerHeight - 1),
                    };
                })()`)) as typeof box;
            } catch (error) {
                notes.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);

                continue;
            }

            if (box === null) {
                notes.push(`${label}: no element matches.`);
            } else if (box === undefined) {
                notes.push(`${label}: the element has no size on screen.`);
            } else if (action.type !== "focus") {
                const point = { x: box.x, y: box.y, button: "none", pointerType: "mouse" };

                await this.send("Input.dispatchMouseEvent", { ...point, type: "mouseMoved" });

                if (action.type === "click") {
                    const press = { ...point, button: "left", clickCount: 1 };

                    await this.send("Input.dispatchMouseEvent", { ...press, type: "mousePressed" });
                    await this.send("Input.dispatchMouseEvent", {
                        ...press,
                        type: "mouseReleased",
                    });
                }
            }

            // Let a transition run out before the next step or the screenshot.
            await new Promise((resolve) => setTimeout(resolve, 350));
            await this.settle();
        }

        return notes;
    }

    async init(): Promise<void> {
        // Network APIs outside Fetch interception must be unavailable before any untrusted script runs.
        await this.send("Page.addScriptToEvaluateOnNewDocument", {
            source: `(() => {
                for (const name of Object.getOwnPropertyNames(globalThis)) {
                    if (/^(RTC|webkitRTC)/.test(name) || name === 'WebTransport') {
                        Object.defineProperty(globalThis, name, { value: undefined, writable: false, configurable: false });
                    }
                }
            })();`,
        });
        await this.send("DOM.enable");
        await this.send("CSS.enable");
        await Promise.all([
            this.send("Page.enable"),
            this.send("Runtime.enable"),
            this.send("Network.enable"),
            this.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] }),
            this.send("Browser.setDownloadBehavior", { behavior: "deny" }),
            // No scrollbar takes a strip of the width, so a page is as wide as its viewport.
            this.send("Emulation.setScrollbarsHidden", { hidden: true }),
        ]);
    }

    async screenshot(viewport: DesignViewport, fullPage = false, preview = false): Promise<string> {
        const metrics = fullPage ? await this.send("Page.getLayoutMetrics") : undefined;
        const content = metrics?.cssContentSize;
        // A full page is cut at a bound; a viewport (a slide up to 3840 a side) is taken whole.
        const width =
            content === undefined ? viewport.width : Math.min(2560, Math.ceil(content.width));
        const height =
            content === undefined ? viewport.height : Math.min(16000, Math.ceil(content.height));
        const scale = preview ? Math.min(1, 2000 / Math.max(width, height)) : 1;
        const result = await this.send("Page.captureScreenshot", {
            format: "png",
            captureBeyondViewport: true,
            clip: { x: 0, y: 0, width, height, scale },
        });

        return String(result.data);
    }

    async isDeck(): Promise<boolean> {
        return (
            (await this.evaluate(
                `document.querySelector('meta[name="pocket-kind"]')?.content === 'deck'`,
            )) === true
        );
    }

    /**
     * The size a deck's slides are written at, as the canvas lays them out (`artifact-inspect.ts`): 1920×1080, or the
     * page's `<meta name="pocket-slide-size" content="WxH">`.
     */
    async slideSize(): Promise<DesignViewport> {
        const value = await this.evaluate(
            `document.querySelector('meta[name="pocket-slide-size"]')?.content ?? ''`,
        );

        return parseSlideSize(typeof value === "string" ? value : "");
    }

    async pdf(viewport?: DesignViewport): Promise<string> {
        const deck = await this.isDeck();

        if (deck) {
            await this.slides();
            const displays = await this.#displays();
            const { width, height } = await this.slideSize();

            await this.evaluate(`(() => {
                document.getElementById('pocket-render-slide')?.remove();
                const slides = Array.from(document.querySelectorAll('section.slide'));
                const displays = ${JSON.stringify(displays)};
                document.body.replaceChildren(...slides);
                slides.forEach((slide, index) => {
                    slide.hidden = false;
                    slide.style.setProperty('display', displays[index] === 'none' ? 'block' : displays[index], 'important');
                });
                const style = document.createElement('style');
                style.textContent = '@page{size:${width}px ${height}px;margin:0}html,body{margin:0!important;padding:0!important;width:${width}px!important;height:auto!important;overflow:visible!important}section.slide{position:relative!important;inset:auto!important;width:${width}px!important;height:${height}px!important;min-width:0!important;max-width:none!important;min-height:0!important;max-height:none!important;margin:0!important;overflow:hidden!important;box-sizing:border-box!important;transform:none!important;scale:1!important;break-after:page!important;break-inside:avoid!important}section.slide:last-child{break-after:auto!important}';
                document.head.append(style);
            })()`);
        }

        const paper =
            viewport === undefined || deck
                ? {}
                : {
                      paperWidth: viewport.width / 96,
                      paperHeight: viewport.height / 96,
                      marginTop: 0,
                      marginBottom: 0,
                      marginLeft: 0,
                      marginRight: 0,
                  };
        const result = await this.send("Page.printToPDF", {
            ...paper,
            printBackground: true,
            preferCSSPageSize: true,
            transferMode: "ReturnAsBase64",
        });

        return String(result.data);
    }

    async slides(): Promise<string[]> {
        const result = await this.evaluate(`(() => {
            if (document.querySelector('meta[name="pocket-kind"]')?.content !== 'deck') return null;
            // The words a person reads: not the text of style, script, template, or noscript elements.
            const skip = new Set(['STYLE', 'SCRIPT', 'TEMPLATE', 'NOSCRIPT', 'TITLE']);
            const textOf = (node, out) => {
                if (out.length > 20000) return;
                if (node.nodeType === 3) { out.push(node.nodeValue ?? ''); return; }
                if (node.nodeType !== 1 || skip.has(node.nodeName.toUpperCase())) return;
                for (const child of node.childNodes) textOf(child, out);
            };
            return Array.from(document.querySelectorAll('section.slide'), slide => {
                const out = [];
                textOf(slide, out);
                return out.join('').slice(0, 20000);
            });
        })()`);

        if (!Array.isArray(result) || result.length === 0 || result.length > 100) {
            throw new Error("A deck needs pocket-kind=deck and 1–100 section.slide elements.");
        }

        return result.map(String);
    }

    /** DevTools exposes matched rules even for cross-origin stylesheets and inactive slides. */
    async #displays(): Promise<string[]> {
        if (this.#slideDisplays !== undefined) {
            return this.#slideDisplays;
        }

        const computed = await this.evaluate(
            `Array.from(document.querySelectorAll('section.slide'), slide => getComputedStyle(slide).display)`,
        );
        const document = await this.send("DOM.getDocument");
        const nodes = await this.send("DOM.querySelectorAll", {
            nodeId: document.root.nodeId,
            selector: "section.slide",
        });
        const displays: string[] = [];

        for (const [index, nodeId] of nodes.nodeIds.entries()) {
            if (computed[index] !== "none") {
                displays.push(String(computed[index]));
                continue;
            }

            const matched = await this.send("CSS.getMatchedStylesForNode", { nodeId });
            const declarations = [
                ...matched.matchedCSSRules.flatMap((match: Json) => match.rule.style.cssProperties),
                ...(matched.inlineStyle?.cssProperties ?? []),
            ].filter(
                (property: Json) =>
                    property.name === "display" &&
                    property.value !== "none" &&
                    property.disabled !== true &&
                    property.parsedOk !== false,
            );
            const chosen =
                declarations.filter((property: Json) => property.important).at(-1) ??
                declarations.at(-1);

            displays.push(String(chosen?.value ?? "block"));
        }

        this.#slideDisplays = displays;

        return displays;
    }

    /** Show one slide (from 1), laid out at the deck's slide size and scaled to fit `viewport` (default: that size). */
    async showSlide(slide: number, viewport?: DesignViewport): Promise<void> {
        const slides = await this.slides();
        const size = await this.slideSize();

        viewport ??= size;

        if (!Number.isInteger(slide) || slide < 1 || slide > slides.length) {
            throw new Error(`Slide must be between 1 and ${slides.length}.`);
        }

        const displays = await this.#displays();
        const scale = Math.min(viewport.width / size.width, viewport.height / size.height);
        const left = (viewport.width - size.width * scale) / 2;
        const top = (viewport.height - size.height * scale) / 2;

        await this.evaluate(`(() => {
            document.getElementById('pocket-render-slide')?.remove();
            const visibleDisplay = ${JSON.stringify(displays[slide - 1])};
            const style = document.createElement('style');
            style.id = 'pocket-render-slide';
            style.textContent = 'html,body{margin:0!important;padding:0!important;width:${viewport.width}px!important;height:${viewport.height}px!important;overflow:hidden!important}section.slide{display:none!important}section.slide[data-pocket-export]{display:' + visibleDisplay + '!important;position:fixed!important;inset:auto!important;left:${left}px!important;top:${top}px!important;width:${size.width}px!important;height:${size.height}px!important;min-width:0!important;max-width:none!important;min-height:0!important;max-height:none!important;margin:0!important;overflow:hidden!important;box-sizing:border-box!important;transform:scale(${scale})!important;transform-origin:top left!important;scale:1!important}';
            document.head.append(style);
            const slides = Array.from(document.querySelectorAll('section.slide'));
            slides.forEach((item, index) => item.toggleAttribute('data-pocket-export', index === ${slide - 1}));
        })()`);
    }
}

export async function withRender<T>(
    bundle: DesignBundle,
    host: PocketHost,
    signal: AbortSignal | undefined,
    run: (page: DesignPage) => Promise<T>,
): Promise<T> {
    const executable = findBrowser();

    if (executable === undefined) {
        throw new Error("Install Chromium or set PI_POCKET_BROWSER to render designs.");
    }

    // The time limit starts when the render does, not while it waits.
    const release = await renders.acquire(signal);
    const controller = new AbortController();
    const abort = () => controller.abort(new Error("The design render stopped."));
    const timer = setTimeout(abort, LIMIT_MS);
    let browser: Chromium | undefined;
    let profile: string | undefined;
    let folder: string | undefined;
    let server: Awaited<ReturnType<typeof serveBundle>> | undefined;

    signal?.addEventListener("abort", abort, { once: true });
    controller.signal.addEventListener("abort", () => browser?.kill(), { once: true });

    try {
        signal?.throwIfAborted();
        folder = await mkdtemp(join(tmpdir(), "pocket-design-"));

        profile = profileFolder(executable, folder);
        server = await serveBundle(bundle);
        browser = await Chromium.launch(executable, profile, [
            "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
            ...(process.env.PI_POCKET_BROWSER_ARGS?.split(/\s+/).filter(Boolean) ?? []),
        ]);
        controller.signal.throwIfAborted();
        const context = await browser.connection.send("Target.createBrowserContext");
        const target = await browser.connection.send("Target.createTarget", {
            url: "about:blank",
            browserContextId: context.browserContextId,
        });
        const attached = await browser.connection.send("Target.attachToTarget", {
            targetId: target.targetId,
            flatten: true,
        });
        const page = new DesignPage(
            browser,
            attached.sessionId,
            server.url,
            host,
            controller.signal,
        );

        await page.init();

        return await run(page);
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        controller.abort();

        try {
            browser?.kill();
            await browser?.exited;
            await server?.close();

            if (profile !== undefined) {
                await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
            }

            if (folder !== undefined) {
                await rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
            }
        } finally {
            release();
        }
    }
}
