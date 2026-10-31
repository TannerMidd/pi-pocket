import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { createSocket } from "node:dgram";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Chromium } from "../src/server/browser/cdp.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { DesignBundle } from "../src/server/design/bundle.ts";
import { exportDesign } from "../src/server/design/export.ts";
import { writeExport } from "../src/server/design/files.ts";
import { designRoutes, designTools } from "../src/server/design/index.ts";
import {
    parseSlideSize,
    serveBundle,
    viewportOf,
    withRender,
} from "../src/server/design/render.ts";
import type { ExtensionWeb, PocketHost } from "../src/server/host.ts";
import { createPublicFetch } from "../src/server/public-fetch.ts";

const bundle: DesignBundle = {
    meta: { title: "Test design", type: "html", versions: [] },
    version: 1,
    content:
        '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{margin:0;background:#123456}h1{color:white}</style><h1 data-pid="title">Design test</h1><img src="assets/test.svg"><script>console.error("expected render error")</script>',
    assets: [
        {
            name: "assets/test.svg",
            type: "image/svg+xml",
            bytes: Buffer.from(
                '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="red"/></svg>',
            ),
        },
    ],
};
const host = { fetchPublic: createPublicFetch() } as PocketHost;
const browser = findBrowser();

test("design viewport validation is bounded", () => {
    assert.deepEqual(viewportOf("mobile"), { width: 390, height: 844 });
    assert.deepEqual(viewportOf("900x600"), { width: 900, height: 600 });
    assert.throws(() => viewportOf("__proto__"));
    assert.throws(() => viewportOf({ width: 100000, height: 800 }));
    assert.throws(() => viewportOf({ width: NaN, height: 800 }));
});

test("the private endpoint serves only its token-scoped snapshot", async () => {
    const endpoint = await serveBundle(bundle);

    try {
        const page = await fetch(endpoint.url);

        assert.equal(await page.text(), bundle.content);
        assert.match(
            page.headers.get("content-security-policy")!,
            /sandbox allow-scripts allow-forms allow-modals allow-popups/,
        );
        assert.match(page.headers.get("content-security-policy")!, /frame-ancestors 'self'/);
        assert.match(page.headers.get("content-security-policy")!, /frame-src 'none'/);
        assert.equal(page.headers.get("x-content-type-options"), "nosniff");
        assert.equal(page.headers.get("cache-control"), "no-store");
        const asset = await fetch(`${endpoint.url}assets/test.svg`);

        assert.deepEqual(Buffer.from(await asset.arrayBuffer()), bundle.assets[0]!.bytes);
        assert.equal((await fetch(new URL("/", endpoint.url))).status, 404);
        assert.equal((await fetch(`${endpoint.url}missing.png`)).status, 404);
        assert.equal((await fetch(endpoint.url, { method: "POST" })).status, 404);
        await new Promise<void>((resolve, reject) => {
            const url = new URL(endpoint.url);
            const request = httpRequest(
                { hostname: url.hostname, port: url.port, path: "http://[", timeout: 5000 },
                (response) => {
                    assert.equal(response.statusCode, 400);
                    response.resume();
                    response.on("end", resolve);
                },
            );

            request.on("timeout", () => request.destroy(new Error("no answer")));
            request.on("error", reject);
            request.end();
        });
    } finally {
        await endpoint.close();
    }
});

test("exports stay in the session and cannot follow directory links", async () => {
    const folder = await mkdtemp(join(tmpdir(), "design-export-test-"));
    const outside = await mkdtemp(join(tmpdir(), "design-outside-test-"));

    try {
        const path = await writeExport(folder, "exports/test.html", Buffer.from("one"));

        assert.equal(await readFile(path, "utf8"), "one");
        await writeExport(folder, "exports/test.html", Buffer.from("two"));
        assert.equal(await readFile(path, "utf8"), "two");
        await assert.rejects(writeExport(folder, "../escape", Buffer.from("x")), /inside/);
        await symlink(outside, join(folder, "linked"));
        await assert.rejects(writeExport(folder, "linked/escape", Buffer.from("x")), /symbolic/);
    } finally {
        await rm(folder, { recursive: true, force: true });
        await rm(outside, { recursive: true, force: true });
    }
});

test("HTML export includes the main page and binary assets", async () => {
    const bytes = await exportDesign(bundle, "html", undefined, host);

    assert.equal(bytes.readUInt32LE(0), 0x04034b50);
    assert.ok(bytes.includes(Buffer.from("index.html")));
    assert.ok(bytes.includes(Buffer.from("assets/test.svg")));
    const collision = await exportDesign(
        {
            ...bundle,
            assets: [{ name: "index.html", type: "text/html", bytes: Buffer.from("collision") }],
        },
        "html",
        undefined,
        host,
    );

    assert.ok(collision.includes(Buffer.from("pocket-design.html")));
    assert.ok(collision.includes(Buffer.from("index.html")));
});

test("design tools and export route expose the required contracts", async () => {
    const tools = designTools(host);

    assert.deepEqual(
        tools.map((tool) => tool.name),
        ["design_preview", "design_export", "design_system"],
    );
    assert.equal(
        (tools[0] as (typeof tools)[0] & { annotations: { readOnlyHint: boolean } }).annotations
            .readOnlyHint,
        true,
    );
    const routes: { path: string; access?: string; handle: (request: unknown) => unknown }[] = [];

    designRoutes(
        {
            conversationRoute: (
                _method: string,
                path: string,
                handle: (request: unknown) => unknown,
                options: { access?: string },
            ) => routes.push({ path, handle, access: options.access }),
            error: (status: number, message: string) =>
                Object.assign(new Error(message), { status }),
        } as unknown as ExtensionWeb,
        host,
    );
    assert.equal(routes[0]!.path, "c/:conversation/export");
    assert.equal(routes[0]!.access, "steer");
    await assert.rejects(
        async () =>
            routes[0]!.handle({
                body: { id: "test", format: "html" },
                conversation: { id: 10, cwd: "" },
            }),
        /no folder/,
    );
});

test(
    "private Chromium renders assets, diagnostics, PNG and PDF",
    { skip: browser === undefined, timeout: 120_000 },
    async () => {
        await withRender(bundle, host, undefined, async (page) => {
            await page.load(viewportOf("mobile"));
            assert.equal(await page.evaluate("document.querySelector('img').naturalWidth"), 20);
            assert.equal(
                await page.evaluate(
                    "(() => { try { return document.cookie === ''; } catch { return true; } })()",
                ),
                true,
            );
            const image = Buffer.from(await page.screenshot(viewportOf("mobile")), "base64");

            assert.equal(image.subarray(1, 4).toString(), "PNG");
            assert.equal(image.readUInt32BE(16), 390);
            assert.equal(image.readUInt32BE(20), 844);
            assert.ok(page.errors.some((error) => error.includes("expected render error")));
            const pdf = Buffer.from(await page.pdf(), "base64");

            assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
        });
    },
);

test(
    "a render cannot fetch the live app or other private network services",
    { skip: browser === undefined, timeout: 120_000 },
    async () => {
        let received = 0;
        const server = createServer((_request, response) => {
            received++;
            response.end("private");
        });

        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address() as { port: number };
        const content = `<h1>Private request check</h1><img src="http://127.0.0.1:${address.port}/secret"><img src="https://127.0.0.1:${address.port}/secret"><img src="https://10.0.0.1/secret"><img src="https://169.254.169.254/latest/meta-data/"><img src="https://[::1]/secret">`;

        try {
            await withRender({ ...bundle, content }, host, undefined, async (page) => {
                await page.load(viewportOf("desktop"));
                assert.equal(received, 0);
                assert.ok(page.failedRequests.some((error) => error.includes("public HTTPS")));
                assert.ok(
                    page.failedRequests.some((error) => error.includes("not a public address")),
                );
            });
        } finally {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    },
);

test(
    "public HTTPS resources use the guarded fetch, but public HTTP resources are refused",
    { skip: browser === undefined, timeout: 120_000 },
    async () => {
        const calls: string[] = [];
        const guarded = {
            fetchPublic: async (url: string | URL) => {
                calls.push(String(url));

                return new Response(new Uint8Array(bundle.assets[0]!.bytes), {
                    headers: { "content-type": "image/svg+xml" },
                });
            },
        } as unknown as PocketHost;
        const content =
            '<img id="secure" src="https://cdn.example/test.svg"><img src="http://cdn.example/insecure.svg">';

        await withRender({ ...bundle, content }, guarded, undefined, async (page) => {
            await page.load(viewportOf("desktop"));
            assert.deepEqual(calls, ["https://cdn.example/test.svg"]);
            assert.equal(await page.evaluate("document.getElementById('secure').naturalWidth"), 20);
            assert.ok(page.failedRequests.some((error) => error.includes("public HTTPS")));
        });
    },
);

test(
    "deck exports contain 16:9 slides and text notes",
    { skip: browser === undefined, timeout: 120_000 },
    async () => {
        const content =
            '<!doctype html><meta name="pocket-kind" content="deck"><style>section.slide{display:flex;align-items:center;justify-content:center;background:blue;color:white}</style><section class="slide">First &amp; second</section><section class="slide">Next slide</section>';
        const deck = { ...bundle, content };
        const output = await exportDesign(deck, "pptx", undefined, host);

        assert.equal(output.readUInt32LE(0), 0x04034b50);
        assert.ok(output.includes(Buffer.from("ppt/slides/slide2.xml")));
        assert.ok(output.includes(Buffer.from("ppt/notesSlides/notesSlide2.xml")));
    },
);

test(
    "a deck exports at the size the canvas lays it out: 1920×1080, or its pocket-slide-size",
    { skip: browser === undefined, timeout: 120_000 },
    async () => {
        // A slide written at 1920×1080 with a mark in its bottom-right corner: it must be in the picture, not cut off.
        const slide = (meta: string) =>
            `<!doctype html><meta name="pocket-kind" content="deck">${meta}<style>body{margin:0}section.slide{position:relative;background:#00f}i{position:absolute;right:0;bottom:0;width:40px;height:40px;background:#f00}</style><section class="slide"><i></i></section>`;
        const size = (png: Buffer) => [png.readUInt32BE(16), png.readUInt32BE(20)];

        assert.deepEqual(parseSlideSize(""), { width: 1920, height: 1080 });
        assert.deepEqual(parseSlideSize("1280x720"), { width: 1280, height: 720 });
        assert.deepEqual(parseSlideSize("99999x1"), { width: 1920, height: 1080 });

        const big = await exportDesign({ ...bundle, content: slide("") }, "png", undefined, host);

        assert.deepEqual(size(big), [1920, 1080]);

        await withRender({ ...bundle, content: slide("") }, host, undefined, async (page) => {
            await page.load(viewportOf("desktop"));
            await page.showSlide(1);
            const corner = await page.evaluate(
                "(() => { const r = document.querySelector('i').getBoundingClientRect(); return [r.right, r.bottom]; })()",
            );

            assert.deepEqual(corner, [1920, 1080]);
        });

        const small = await exportDesign(
            { ...bundle, content: slide('<meta name="pocket-slide-size" content="1280x720">') },
            "png",
            undefined,
            host,
        );

        assert.deepEqual(size(small), [1280, 720]);

        // The largest size a deck may name is taken whole, not cut at a bound.
        const large = await exportDesign(
            { ...bundle, content: slide('<meta name="pocket-slide-size" content="3840x2160">') },
            "png",
            undefined,
            host,
        );

        assert.deepEqual(size(large), [3840, 2160]);
    },
);

test(
    "a slide authored at 1920×1080 keeps its corner content and ignores conflicting size limits",
    { skip: browser === undefined, timeout: 120_000 },
    async () => {
        const content = `<!doctype html><meta name="pocket-kind" content="deck">
            <style>section.slide{width:1920px;height:1080px;min-width:2200px;max-width:1280px;min-height:1300px;max-height:720px;background:blue}
            i{position:absolute;left:1880px;top:1040px;width:40px;height:40px;background:red}</style>
            <section class="slide"><i></i></section>`;

        await withRender({ ...bundle, content }, host, undefined, async (page) => {
            await page.load(viewportOf("desktop"));
            await page.showSlide(1);
            const rect = await page.evaluate(
                "(() => { const r = document.querySelector('section.slide').getBoundingClientRect(); return [r.width, r.height]; })()",
            );

            assert.deepEqual(rect, [1920, 1080]);
            const image = await page.screenshot(await page.slideSize());
            const pixel = await page.evaluate(`(async () => {
                const image = new Image();
                image.src = 'data:image/png;base64,${image}';
                await image.decode();
                const canvas = document.createElement('canvas');
                canvas.width = image.width;
                canvas.height = image.height;
                const context = canvas.getContext('2d');
                context.drawImage(image, 0, 0);
                return Array.from(context.getImageData(1900, 1060, 1, 1).data);
            })()`);

            assert.deepEqual(
                pixel,
                [255, 0, 0, 255],
                "the authored bottom-right mark is in the PNG",
            );
            await page.pdf();
            assert.deepEqual(
                await page.evaluate(
                    "(() => { const r = document.querySelector('section.slide').getBoundingClientRect(); return [r.width, r.height]; })()",
                ),
                [1920, 1080],
                "PDF layout also overrides authored slide limits",
            );
        });
    },
);

test(
    "a supported 3840×2160 slide exports without a horizontal crop",
    { skip: browser === undefined, timeout: 120_000 },
    async () => {
        const content =
            '<!doctype html><meta name="pocket-kind" content="deck"><meta name="pocket-slide-size" content="3840x2160"><section class="slide">Large slide</section>';
        const png = await exportDesign({ ...bundle, content }, "png", undefined, host);

        assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [3840, 2160]);
    },
);

test(
    "deck PDF pages match the default or custom slide dimensions, one page per slide",
    { skip: browser === undefined, timeout: 120_000 },
    async () => {
        for (const [meta, expected] of [
            ["", [1440, 810]],
            ['<meta name="pocket-slide-size" content="640x640">', [480, 480]],
        ] as const) {
            const content = `<!doctype html><meta name="pocket-kind" content="deck">${meta}<section class="slide">First</section><section class="slide">Second</section>`;
            const pdf = await exportDesign({ ...bundle, content }, "pdf", undefined, host);
            const boxes = [
                ...pdf
                    .toString("latin1")
                    .matchAll(/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/g),
            ];

            assert.equal(boxes.length, 2);

            for (const box of boxes) {
                assert.deepEqual([Number(box[1]), Number(box[2])], expected);
            }
        }
    },
);

test(
    "WebRTC cannot send private UDP packets from a render",
    { skip: browser === undefined, timeout: 120_000 },
    async () => {
        const udp = createSocket("udp4");
        let packets = 0;

        udp.on("message", () => packets++);
        await new Promise<void>((resolve) => udp.bind(0, "127.0.0.1", resolve));
        const port = udp.address().port;
        const content = `<script>
        try {
            const peer = new RTCPeerConnection({iceServers:[{urls:'stun:127.0.0.1:${port}'}]});
            peer.createDataChannel('probe');
            peer.createOffer().then(offer => peer.setLocalDescription(offer));
        } catch { window.rtcBlocked = true; }
    </script>`;

        try {
            await withRender({ ...bundle, content }, host, undefined, async (page) => {
                await page.load(viewportOf("desktop"));
                assert.equal(await page.evaluate("window.rtcBlocked"), true);
                assert.equal(await page.evaluate("typeof RTCPeerConnection"), "undefined");
                assert.equal(await page.evaluate("typeof WebTransport"), "undefined");
                assert.equal(
                    await page.evaluate(
                        "Object.getOwnPropertyDescriptor(window, 'RTCPeerConnection').configurable",
                    ),
                    false,
                );
                await new Promise((resolve) => setTimeout(resolve, 300));
                assert.equal(packets, 0);
            });
        } finally {
            await new Promise<void>((resolve) => udp.close(() => resolve()));
        }
    },
);

test(
    "a design cannot replace its sandbox with an external document",
    { skip: browser === undefined, timeout: 120_000 },
    async () => {
        let publicDocuments = 0;
        const fixtures = {
            fetchPublic: async () => {
                publicDocuments++;

                return new Response('<iframe src="https://second.example/child"></iframe>');
            },
        } as unknown as PocketHost;
        const content =
            '<!doctype html><script>setTimeout(() => { location.href = "https://first.example/escape"; }, 0)</script>';

        await withRender({ ...bundle, content }, fixtures, undefined, async (page) => {
            await page.load(viewportOf("desktop"));
            assert.equal(publicDocuments, 0);
            assert.ok(
                page.failedRequests.some((error) =>
                    error.includes("External document navigation is disabled"),
                ),
            );
        });
    },
);

test(
    "hidden slides retain their authored flex or grid display",
    { skip: browser === undefined, timeout: 120_000 },
    async () => {
        const content =
            '<!doctype html><meta name="pocket-kind" content="deck"><style>.slide{display:flex;align-items:center;justify-content:center}.slide.grid{display:grid;place-items:center}.slide:not(:first-child){display:none}</style><section class="slide">First</section><section class="slide">Second</section><section class="slide grid">Third</section>';

        await withRender({ ...bundle, content }, host, undefined, async (page) => {
            await page.load({ width: 1280, height: 720 });
            await page.showSlide(2);
            assert.equal(
                await page.evaluate(
                    "getComputedStyle(document.querySelectorAll('section.slide')[1]).display",
                ),
                "flex",
            );
            await page.showSlide(3);
            assert.equal(
                await page.evaluate(
                    "getComputedStyle(document.querySelectorAll('section.slide')[2]).display",
                ),
                "grid",
            );
            await page.showSlide(3, { width: 390, height: 844 });
            const rect = await page.evaluate(
                "document.querySelectorAll('section.slide')[2].getBoundingClientRect().toJSON()",
            );

            assert.equal(rect.width, 390);
            assert.equal(rect.height, 219.375);
            await page.pdf();
            assert.deepEqual(
                await page.evaluate(
                    "Array.from(document.querySelectorAll('section.slide'), slide => getComputedStyle(slide).display)",
                ),
                ["flex", "flex", "grid"],
            );
        });
    },
);

test(
    "cancelled renders close and release their renderer slot",
    { skip: browser === undefined, timeout: 120_000 },
    async () => {
        const controller = new AbortController();

        await assert.rejects(
            withRender(bundle, host, controller.signal, async (page) => {
                controller.abort();
                await page.evaluate("1");
            }),
            /stopped/,
        );
        const alreadyAborted = AbortSignal.abort();

        await assert.rejects(withRender(bundle, host, alreadyAborted, async () => true));
        const results = await Promise.all(
            [1, 2].map(() => withRender(bundle, host, undefined, async () => true)),
        );

        assert.deepEqual(results, [true, true]);
    },
);

test(
    "PI_POCKET_BROWSER_ARGS reaches the design render's Chromium",
    { skip: browser === undefined },
    async () => {
        const realLaunch = Chromium.launch;
        let launched: readonly string[] | undefined;
        const fake = {
            connection: { send: async () => ({}), listen: () => {} },
            kill: () => {},
            exited: Promise.resolve(),
        } as unknown as Chromium;

        Chromium.launch = async (
            _executable: string,
            _profile: string,
            extra: readonly string[],
        ) => {
            launched = extra;

            return fake;
        };

        process.env.PI_POCKET_BROWSER_ARGS = "--no-sandbox --design-flag";

        try {
            await withRender(bundle, host, undefined, async () => true);
        } finally {
            Chromium.launch = realLaunch;
            delete process.env.PI_POCKET_BROWSER_ARGS;
        }

        assert.ok(launched?.includes("--no-sandbox"), "the env flag reaches Chromium");
        assert.ok(launched?.includes("--design-flag"), "space-separated args are kept apart");
    },
);
