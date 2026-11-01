import { cleanUp, context, newSession, openApp, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { inflateRawSync } from "node:zlib";
import type { ConversationId, ToolRegistration } from "@earendil-works/pi-durable";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { DesignBundle } from "../src/server/design/bundle.ts";
import { exportDesign, saveDesignExport } from "../src/server/design/export.ts";
import { checkText, designRoutes, designTools } from "../src/server/design/index.ts";
import {
    designActions,
    Slots,
    tweakValues,
    viewportOf,
    withRender,
} from "../src/server/design/render.ts";
import createArtifacts from "../src/server/extensions/artifacts.ts";
import type { ConversationWebRequest, ExtensionWeb } from "../src/server/host.ts";
import type { DesignSystem } from "../src/server/design/system-types.ts";
import { bundleOf, host, page, testSystem } from "./design-lint-fixtures.ts";
import { loadDesignSystem } from "../src/server/design/tokens.ts";

const browser = { skip: findBrowser() === undefined, timeout: 120_000 };

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

test("slots: work beyond the limit waits its turn, first in, first out", async () => {
    const slots = new Slots(2, 10);
    const order: number[] = [];
    let running = 0;
    let most = 0;

    const job = async (id: number) => {
        const release = await slots.acquire();

        order.push(id);
        running++;
        most = Math.max(most, running);
        await tick();
        running--;
        release();
    };

    await Promise.all([1, 2, 3, 4, 5, 6].map(job));
    assert.deepEqual(order, [1, 2, 3, 4, 5, 6]);
    assert.equal(most, 2);
    assert.equal(slots.active, 0);
    assert.equal(slots.waiting, 0);
});

test("slots: a full queue refuses at once, and a slot given back twice counts once", async () => {
    const slots = new Slots(1, 1);
    const first = await slots.acquire();
    const second = slots.acquire();

    await assert.rejects(slots.acquire(), /1 design renders are already waiting/);
    first();
    first();
    const release = await second;

    assert.equal(
        slots.active,
        1,
        "the second holds the slot; the double release freed nothing more",
    );
    release();
    assert.equal(slots.active, 0);
});

test("slots: a wait ends when its signal aborts, and the next in line gets the slot", async () => {
    const slots = new Slots(1, 5);
    const held = await slots.acquire();
    const controller = new AbortController();
    const aborted = slots.acquire(controller.signal);
    const next = slots.acquire();

    assert.equal(slots.waiting, 2);
    controller.abort(new Error("gave up"));
    await assert.rejects(aborted, /gave up/);
    assert.equal(slots.waiting, 1);
    held();
    (await next)();
    assert.equal(slots.active, 0);
    await assert.rejects(slots.acquire(AbortSignal.abort()), /aborted|stopped/i);
    assert.equal(slots.active, 0);
});

test("slots: a wait is bounded in time", async () => {
    const slots = new Slots(1, 5, 30);
    const held = await slots.acquire();

    await assert.rejects(slots.acquire(), /Waited too long/);
    assert.equal(slots.waiting, 0);
    held();
});

test("five renders at once all finish, and never more than two run together", browser, async () => {
    // Timing does not decide this: the first two renders wait for each other inside their callbacks (so two really are
    // running at once, or the test fails after the wait), and no render may see a third.
    let running = 0;
    let most = 0;

    let meet: () => void = () => {};

    const together = new Promise<void>((resolve) => {
        meet = resolve;
    });
    const results = await Promise.all(
        [1, 2, 3, 4, 5].map((id) =>
            withRender(bundleOf("<h1>x</h1>"), host, undefined, async (view) => {
                running++;
                most = Math.max(most, running);

                if (running === 2) {
                    meet();
                }

                if (id <= 2) {
                    await Promise.race([
                        together,
                        new Promise((resolve) => setTimeout(resolve, 30_000)),
                    ]);
                }

                await view.load(viewportOf("mobile"));
                running--;

                return id;
            }),
        ),
    );

    assert.deepEqual(results, [1, 2, 3, 4, 5]);
    assert.equal(most, 2, "two ran at once, and a third never did");
});

test("tweaks and actions from a tool are validated and bounded", () => {
    assert.deepEqual(tweakValues(undefined), {});
    assert.deepEqual(tweakValues({ "--a": 1, b: "x", c: true }), { "--a": 1, b: "x", c: true });
    assert.throws(() => tweakValues([1]), /object/);
    assert.throws(() => tweakValues({ a: null }), /needs a string/);
    assert.throws(() => tweakValues({ a: "x".repeat(201) }), /needs a string/);
    assert.throws(() => tweakValues({ a: Number.NaN }), /needs a string/);
    assert.throws(() => tweakValues({ ["n".repeat(81)]: 1 }), /1 to 80/);
    assert.throws(
        () =>
            tweakValues(
                Object.fromEntries(Array.from({ length: 41 }, (_, index) => [`k${index}`, 1])),
            ),
        /up to 40/,
    );
    assert.deepEqual(designActions([{ type: "hover", selector: "a" }]), [
        { type: "hover", selector: "a" },
    ]);
    assert.throws(() => designActions([{ type: "drag", selector: "a" }]), /Action 1/);
    assert.throws(() => designActions([{ type: "click", selector: "" }]), /Action 1/);
    assert.throws(
        () => designActions(Array(11).fill({ type: "click", selector: "a" })),
        /up to 10/,
    );
    assert.throws(() => designActions("a"), /list/);
});

test("the checks text: a summary, the worst first, at most 30, and notes", () => {
    const finding = (index: number, level: "error" | "warning") => ({
        rule: "off-system-color" as const,
        level,
        selector: `#e${index}`,
        value: `#${index}`,
        message: `message ${index}`,
    });
    const report = (findings: ReturnType<typeof finding>[]) => ({
        viewport: { width: 390, height: 844 },
        colorScheme: "light" as const,
        findings,
        summary: { errors: 0, warnings: 0, elements: 1, byRule: {} },
        withoutSystem: false,
    });
    const many = Array.from({ length: 40 }, (_, index) => finding(index, "error"));
    const text = checkText(
        [
            { view: "mobile", report: report(many) },
            { view: "desktop", report: report([finding(0, "error")]) },
        ],
        testSystem(),
        "light",
        ["action 1 (hover a): no element matches."],
    );
    const lines = text.split("\n");

    assert.match(
        lines[0]!,
        /^Checks \(mobile, desktop; light; system "Test system", mode light\): 40 errors, 0 warnings\.$/,
    );
    assert.equal(lines.filter((line) => line.startsWith("- ")).length, 30);
    assert.match(
        lines[1]!,
        /^- error off-system-color #e0: message 0$/,
        "in every view: no view named",
    );
    assert.match(
        lines[2]!,
        /^- error off-system-color #e1 \(mobile\): message 1$/,
        "in one view: named",
    );
    assert.ok(lines.includes("… and 10 more (fix these first, then preview again)."));
    assert.equal(lines.at(-1), "Note: action 1 (hover a): no element matches.");
    assert.match(
        checkText([{ view: "mobile", report: report([]) }], undefined, undefined, []),
        /no design system, so no off-system rules\): 0 errors, 0 warnings\.\nNo findings\./,
    );
});

let app: Awaited<ReturnType<typeof openApp>>;
let conversation: ConversationId;
let cwd: string;
let system: DesignSystem | undefined;

function api(id = conversation) {
    return {
        conversationId: id,
        taskId: 900,
        callId: "design-verify-test",
        agent: async () => ({ cwd }),
        snapshot: app.harness.snapshot.bind(app.harness),
        commit: app.harness.commit.bind(app.harness),
    };
}

const call = (tool: ToolRegistration, args: object) => tool.execute(args, api() as never, context);
const publish = (args: object) => call(createArtifacts(host).tools![0]!, args);
const preview = () =>
    designTools(host, { loadSystem: () => system }).find((tool) => tool.name === "design_preview")!;
const exportTool = () => designTools(host).find((tool) => tool.name === "design_export")!;
const textOf = (result: Awaited<ReturnType<typeof call>>) =>
    (result.output ?? [])
        .filter((item) => item.type === "text")
        .map((item) => (item as { text: string }).text)
        .join("\n");

before(async () => {
    app = await openApp(scriptedModel());
    conversation = await newSession(app);
    cwd = await mkdtemp(join(tmpdir(), "pocket-verify-"));
    await publish({
        id: "lint",
        title: "Lint",
        content: page(
            "a.btn{display:inline-block;padding:var(--pad);color:#1c1e26;background:#fff}a.btn:hover{color:#bbb}",
            `<p data-pid="off" style="margin:0;color:#7ba3f8;background:#fff">Off</p><a class="btn" href="#" data-pid="btn">Go</a>` +
                `<script type="application/json" id="pocket-tweaks">[{"name":"--pad","type":"range","value":16,"unit":"px"}]</script>`,
        ).replace("<style>", "<style>:root{--pad:16px}"),
        assets: [
            {
                name: "about.html",
                content: page(
                    "",
                    `<p data-pid="about" style="margin:0;color:#999;background:#fff">About</p>`,
                ),
            },
        ],
    });
    const many = Array.from(
        { length: 40 },
        (_, index) =>
            `<p data-pid="p${index}" style="margin:0;color:#${(0x400000 + index * 0x010101).toString(16)};background:#fff">x</p>`,
    ).join("");

    await publish({ id: "many", title: "Many", content: page("", many) });
    await publish({
        id: "dark",
        title: "Dark",
        content: page(
            "",
            `<p data-pid="t" style="margin:0;padding:var(--space-2);color:#e6e8f0;background:var(--color-bg-page)">Text</p>`,
        ),
    });
});

after(async () => {
    await app.close();
    await rm(cwd, { recursive: true, force: true });
    cleanUp();
});

test(
    "design_preview checks by default: a summary, then the findings, after the screenshots",
    browser,
    async () => {
        system = testSystem();
        const result = await call(preview(), { id: "lint" });
        const output = result.output ?? [];

        assert.equal(output.filter((item) => item.type === "image").length, 2);
        assert.equal(output.at(-1)!.type, "text", "the report comes after the screenshots");
        const text = textOf(result);

        assert.match(
            text,
            /Checks \(mobile, desktop; light; system "Test system", mode light\): \d+ errors?, \d+ warnings?\./,
        );
        assert.match(
            text,
            /- error off-system-color \[data-pid="off"\]: #7ba3f8 is not a system color/,
        );
        assert.match(text, /Set `color: var\(--color-accent-default\)`/);
        assert.match(text, /No console errors or failed requests\./);
        const lines = text.split("\n").filter((line) => line.startsWith("- "));

        assert.ok(lines.length <= 30);
        const levels = lines.map((line) => line.split(" ")[1]);

        assert.deepEqual(
            levels,
            [...levels].sort((a, b) => (a === "error" ? -1 : 1) - (b === "error" ? -1 : 1)),
            "errors first",
        );
        const details = result.details as {
            checks: { view: string; findings: { rule: string }[] }[];
            errors: string[];
        };

        assert.deepEqual(
            details.checks.map((item) => item.view),
            ["mobile", "desktop"],
        );
        assert.ok(details.checks[0]!.findings.some((item) => item.rule === "off-system-color"));
        assert.deepEqual(details.errors, []);
    },
);

test(
    "design_preview without a system says so, and checks: false turns the report off",
    browser,
    async () => {
        system = undefined;
        const plain = textOf(await call(preview(), { id: "lint", viewports: ["mobile"] }));

        assert.match(plain, /no design system, so no off-system rules/);
        assert.doesNotMatch(plain, /off-system-color/);
        system = testSystem();
        const off = await call(preview(), { id: "lint", viewports: ["mobile"], checks: false });

        assert.doesNotMatch(textOf(off), /Checks \(/);
        assert.match(textOf(off), /No console errors or failed requests\./);
        assert.equal((off.details as { checks?: unknown }).checks, undefined);
    },
);

test("design_preview shows at most 30 findings and says how many more", browser, async () => {
    system = testSystem();
    const text = textOf(await call(preview(), { id: "many", viewports: ["mobile"] }));
    const lines = text.split("\n");

    assert.equal(lines.filter((line) => line.startsWith("- ")).length, 30);
    assert.ok(lines.some((line) => /^… and \d+ more/.test(line)));
});

test(
    "design_preview applies tweaks, a color scheme, another page, and actions",
    browser,
    async () => {
        system = testSystem();
        const base = textOf(await call(preview(), { id: "lint", viewports: ["mobile"] }));

        assert.doesNotMatch(base, /off-system-size/);
        const tweaked = textOf(
            await call(preview(), { id: "lint", viewports: ["mobile"], tweaks: { "--pad": 15 } }),
        );

        assert.match(tweaked, /off-system-size .*15px is not on the spacing scale/);
        const light = textOf(await call(preview(), { id: "dark", viewports: ["mobile"] }));
        const dark = textOf(
            await call(preview(), { id: "dark", viewports: ["mobile"], colorScheme: "dark" }),
        );

        assert.match(light, /light; system "Test system", mode light/);
        assert.match(dark, /dark; system "Test system", mode dark/);
        assert.doesNotMatch(
            dark,
            /- error off-system-color/,
            "the dark value is a system color in dark",
        );
        assert.match(light, /- error off-system-color/, "and not one in light");
        const about = textOf(
            await call(preview(), { id: "lint", viewports: ["mobile"], page: "about.html" }),
        );

        assert.match(about, /contrast \[data-pid="about"\]/);
        assert.doesNotMatch(about, /data-pid="off"/);
        await assert.rejects(
            call(preview(), { id: "lint", page: "missing.html" }),
            /no HTML page missing\.html\. Pages: about\.html\./,
        );
        // An action runs before the check: after a hover the button's text is too light. A step that cannot run is a note.
        const hovered = textOf(
            await call(preview(), {
                id: "lint",
                viewports: ["mobile"],
                actions: [
                    { type: "hover", selector: "a.btn" },
                    { type: "click", selector: "#nothing-here" },
                    { type: "focus", selector: "((" },
                ],
            }),
        );

        assert.match(hovered, /contrast \[data-pid="btn"\]/);
        assert.match(hovered, /Note: action 2 \(click #nothing-here\): no element matches\./);
        assert.match(hovered, /Note: action 3 \(focus \(\(\): .*not a valid selector/);
        assert.doesNotMatch(base, /contrast \[data-pid="btn"\]/);
    },
);

test("design_preview keeps its screenshots when the system cannot be read", browser, async () => {
    const broken = designTools(host, {
        loadSystem: () => {
            throw new Error("tokens.json is not valid JSON");
        },
    }).find((tool) => tool.name === "design_preview")!;
    const result = await call(broken, { id: "lint", viewports: ["mobile"] });

    assert.equal((result.output ?? []).filter((item) => item.type === "image").length, 1);
    assert.match(
        textOf(result),
        /Note: The design system could not be read: tokens.json is not valid JSON/,
    );
    assert.match(textOf(result), /no design system/);
});

async function pixel(png: Buffer, x: number, y: number): Promise<number[]> {
    return withRender(bundleOf("<p>x</p>"), host, undefined, async (view) => {
        await view.load(viewportOf("mobile"));

        return (await view.evaluate(`(async () => {
            const image = new Image();
            image.src = 'data:image/png;base64,${png.toString("base64")}';
            await image.decode();
            const canvas = document.createElement('canvas');
            canvas.width = image.width;
            canvas.height = image.height;
            const context = canvas.getContext('2d');
            context.drawImage(image, 0, 0);
            return Array.from(context.getImageData(${x}, ${y}, 1, 1).data);
        })()`)) as number[];
    });
}

const size = (png: Buffer) => [png.readUInt32BE(16), png.readUInt32BE(20)];

function unzip(bytes: Buffer): Map<string, Buffer> {
    const files = new Map<string, Buffer>();
    const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 5, 6]));
    let offset = bytes.readUInt32LE(end + 16);

    for (let index = 0; index < bytes.readUInt16LE(end + 10); index++) {
        const method = bytes.readUInt16LE(offset + 10);
        const compressed = bytes.readUInt32LE(offset + 20);
        const nameLength = bytes.readUInt16LE(offset + 28);
        const extraLength = bytes.readUInt16LE(offset + 30);
        const commentLength = bytes.readUInt16LE(offset + 32);
        const local = bytes.readUInt32LE(offset + 42);
        const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString();
        const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
        const data = bytes.subarray(start, start + compressed);

        files.set(name, method === 8 ? inflateRawSync(data) : data);
        offset += 46 + nameLength + extraLength + commentLength;
    }

    return files;
}

const mk = (content: string): DesignBundle => bundleOf(content);
const colorDeck = (meta = "") =>
    `<!doctype html><meta name="pocket-kind" content="deck">${meta}<style>body{margin:0}section.slide{box-sizing:border-box}</style>` +
    `<section class="slide" style="background:#f00">One</section><section class="slide" style="background:#0f0">Two</section><section class="slide" style="background:#00f">Three</section>`;

test("a deck's PNG is the requested slide, or every slide in a zip", browser, async () => {
    const deck = mk(colorDeck());
    const first = await exportDesign(deck, "png", undefined, host);
    const third = await exportDesign(deck, "png", undefined, host, undefined, { slide: 3 });

    assert.deepEqual(size(third), [1920, 1080]);
    assert.deepEqual(
        (await pixel(first, 1500, 900)).slice(0, 3),
        [255, 0, 0],
        "no slide: the first",
    );
    assert.deepEqual((await pixel(third, 1500, 900)).slice(0, 3), [0, 0, 255]);
    const all = unzip(
        await exportDesign(deck, "png", undefined, host, undefined, { slide: "all" }),
    );

    assert.deepEqual([...all.keys()], ["slide-1.png", "slide-2.png", "slide-3.png"]);
    assert.deepEqual((await pixel(all.get("slide-2.png")!, 1500, 900)).slice(0, 3), [0, 255, 0]);
    await assert.rejects(
        exportDesign(deck, "png", undefined, host, undefined, { slide: 4 }),
        /Slide must be between 1 and 3/,
    );
    await assert.rejects(
        exportDesign(mk("<p>x</p>"), "png", undefined, host, undefined, { slide: 1 }),
        /needs a deck/,
    );
    await assert.rejects(
        exportDesign(deck, "pdf", undefined, host, undefined, { slide: 1 }),
        /for the PNG export of a deck/,
    );
});

test("saving every slide gives a zip by default, a PNG otherwise", browser, async () => {
    const options = { id: "pitch", format: "png" as const, cwd };
    const zipped = await saveDesignExport(mk(colorDeck()), { ...options, slide: "all" }, host);
    const one = await saveDesignExport(mk(colorDeck()), { ...options, slide: 2 }, host);

    assert.equal(zipped.name, "pitch-v1-slides.zip");
    assert.equal(unzip(await readFile(zipped.path)).size, 3);
    assert.equal(one.name, "pitch-v1.png");
});

test(
    "export applies tweak values, and a custom size sets the width of a tall page",
    browser,
    async () => {
        const content = `<!doctype html><style>:root{--c:#00f;--h:2000px}body{margin:0;background:var(--c)}div{height:var(--h)}</style><div></div><script type="application/json" id="pocket-tweaks">[{"name":"--h","type":"range","value":2000,"unit":"px"}]</script>`;
        const plain = await exportDesign(mk(content), "png", { width: 700, height: 500 }, host);
        const tweaked = await exportDesign(
            mk(content),
            "png",
            { width: 700, height: 500 },
            host,
            undefined,
            {
                tweaks: { "--c": "#f00", "--h": 900 },
            },
        );

        assert.deepEqual(
            size(plain),
            [700, 2000],
            "the page is as wide as the viewport, scrollbar or not",
        );
        assert.deepEqual((await pixel(plain, 5, 5)).slice(0, 3), [0, 0, 255]);
        assert.deepEqual(size(tweaked), [700, 900], "a number takes the knob's unit");
        assert.deepEqual((await pixel(tweaked, 5, 5)).slice(0, 3), [255, 0, 0]);
    },
);

test("a page's PDF is as wide as the viewport", browser, async () => {
    const boxes = (pdf: Buffer) =>
        [
            ...pdf
                .toString("latin1")
                .matchAll(/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/g),
        ].map((match) => [Number(match[1]), Number(match[2])]);
    const content = "<!doctype html><h1>Hello</h1>";
    const desktop = boxes(await exportDesign(mk(content), "pdf", undefined, host));
    const custom = boxes(await exportDesign(mk(content), "pdf", { width: 800, height: 600 }, host));

    assert.deepEqual(desktop[0], [960, 600], "1280 px × 0.75 pt");
    assert.deepEqual(custom[0], [600, 450]);
});

test(
    "PPTX notes leave out style and script text, and slide images have twice the pixels",
    browser,
    async () => {
        const deck =
            `<!doctype html><meta name="pocket-kind" content="deck"><style>section.slide{background:#123;color:#fff}</style>` +
            `<section class="slide"><h1>Real words</h1><style>.secret-style{color:red}</style><script>var secretScript = 1</script><template>secret template</template><noscript>secret noscript</noscript><p>More <b>words</b></p></section>`;
        const files = unzip(await exportDesign(mk(deck), "pptx", undefined, host));
        const notes = files.get("ppt/notesSlides/notesSlide1.xml")!.toString();

        assert.match(notes, /Real words/);
        assert.match(notes, /More words/);
        assert.doesNotMatch(notes, /secret/);
        assert.deepEqual(size(files.get("ppt/media/image1.png")!), [3840, 2160]);
        const small = unzip(
            await exportDesign(
                mk(
                    deck.replace(
                        "<style>section",
                        '<meta name="pocket-slide-size" content="1280x720"><style>section',
                    ),
                ),
                "pptx",
                undefined,
                host,
            ),
        );

        assert.deepEqual(size(small.get("ppt/media/image1.png")!), [2560, 1440]);
        const huge = unzip(
            await exportDesign(
                mk(
                    deck.replace(
                        "<style>section",
                        '<meta name="pocket-slide-size" content="3840x2160"><style>section',
                    ),
                ),
                "pptx",
                undefined,
                host,
            ),
        );
        const [width, height] = size(huge.get("ppt/media/image1.png")!);

        assert.ok(
            width! <= 4096 && height! <= 4096,
            "the largest slides are not doubled past 4096 pixels",
        );
        assert.ok(width! >= 3840);
    },
);

test("the export tool and route take slide, tweaks, and a custom size", browser, async () => {
    await publish({ id: "pitch", title: "Pitch", content: colorDeck(), kind: "deck" });
    const tool = exportTool();
    const all = await call(tool, { id: "pitch", format: "png", slide: "all" });

    assert.equal(
        (all.details as { path: string }).path,
        join(await realpath(cwd), "exports/pitch-v1-slides.zip"),
    );
    assert.equal(unzip(await readFile((all.details as { path: string }).path)).size, 3);
    await assert.rejects(
        call(tool, { id: "pitch", format: "png", tweaks: { a: null } }),
        /needs a string/,
    );
    let handler: ((request: ConversationWebRequest) => unknown) | undefined;

    designRoutes(
        {
            conversationRoute: (_method: string, _path: string, handle: typeof handler) => {
                handler = handle;
            },
            error: (status: number, message: string) =>
                Object.assign(new Error(message), { status }),
        } as unknown as ExtensionWeb,
        host,
    );
    const request = (body: object) =>
        ({
            body,
            conversation: { id: conversation, cwd },
            snapshot: app.harness.snapshot.bind(app.harness),
            signal: new AbortController().signal,
            context,
        }) as unknown as ConversationWebRequest;
    const second = (await handler!(request({ id: "pitch", format: "png", slide: 2 }))) as {
        path: string;
        relative: string;
    };

    assert.deepEqual(
        (await pixel(await readFile(second.path), 1500, 900)).slice(0, 3),
        [0, 255, 0],
    );
    const zipped = (await handler!(request({ id: "pitch", format: "png", slide: "all" }))) as {
        relative: string;
    };

    assert.equal(zipped.relative, "exports/pitch-v1-slides.zip");
    await publish({
        id: "tall",
        title: "Tall",
        content: "<!doctype html><style>body{margin:0;height:1500px}p{margin:0}</style><p>x</p>",
    });
    const sized = (await handler!(
        request({ id: "tall", format: "png", viewport: { width: 640, height: 480 } }),
    )) as { path: string };

    assert.deepEqual(size(await readFile(sized.path)), [640, 1500]);
    await assert.rejects(
        async () => handler!(request({ id: "pitch", format: "png", slide: 0 })),
        /Slide must be/,
    );
    await assert.rejects(
        async () =>
            handler!(request({ id: "pitch", format: "png", viewport: { width: 5, height: 5 } })),
        /320/,
    );
    await assert.rejects(
        async () => handler!(request({ id: "pitch", format: "png", tweaks: "x" })),
        /object of names and values/,
    );
});

async function realpath(path: string): Promise<string> {
    return (await import("node:fs/promises")).realpath(path);
}

test("design_preview and design_export take a mode of the system", browser, async () => {
    const flagship = loadDesignSystem(
        join(import.meta.dirname, "..", "docs", "examples", "design-system", "pocket"),
    )!;

    await publish({
        id: "modes",
        title: "Modes",
        content: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="ds/tokens.css"><style>body{margin:0;background:var(--color-bg-base);height:300px}</style></head><body><p data-pid="quiet" style="margin:0;padding:var(--space-4);color:#b4bee6">Quiet words</p></body></html>`,
        assets: [{ name: "ds/tokens.css", content: flagship.compiled.css }],
    });
    const tools = designTools(host, { loadSystem: () => flagship });
    const run = (name: string, args: object) =>
        call(
            tools.find((tool) => tool.name === name)!,
            args,
        );
    const plain = textOf(await run("design_preview", { id: "modes", viewports: ["mobile"] }));
    const high = textOf(
        await run("design_preview", { id: "modes", viewports: ["mobile"], mode: "high-contrast" }),
    );

    // A dark default system and a page that keeps its own data-theme="dark": the preview checks the mode it shows.
    const night = { ...flagship, modes: ["dark", "light", "high-contrast"] };

    await publish({
        id: "own",
        title: "Own",
        content: `<!doctype html><html lang="en" data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="ds/tokens.css"></head><body><p data-pid="t" style="margin:0;color:var(--color-text-primary);background:var(--color-bg-base)">Own</p></body></html>`,
        assets: [{ name: "ds/tokens.css", content: flagship.compiled.css }],
    });
    const own = designTools(host, { loadSystem: () => night }).find(
        (t) => t.name === "design_preview",
    )!;

    assert.match(textOf(await call(own, { id: "own", viewports: ["mobile"] })), /", mode dark/);
    assert.match(plain, /light; system "Pi Pocket", mode light/);
    assert.match(plain, /contrast \[data-pid="quiet"\]/);
    assert.match(high, /dark; system "Pi Pocket", mode high-contrast/, "the mode's own scheme");
    assert.doesNotMatch(high, /contrast \[data-pid="quiet"\]/);
    const shot = await run("design_preview", {
        id: "modes",
        viewports: ["mobile"],
        mode: "high-contrast",
        checks: false,
    });
    const image = (shot.output ?? []).find((item) => item.type === "image") as { data: string };

    assert.deepEqual(
        (await pixel(Buffer.from(image.data, "base64"), 200, 250)).slice(0, 3),
        [14, 14, 20],
        "the high-contrast ground (#0e0e14)",
    );
    await assert.rejects(run("design_preview", { id: "modes", mode: "sepia" }), /no mode "sepia"/);
    await assert.rejects(
        call(
            designTools(host, { loadSystem: () => undefined }).find(
                (tool) => tool.name === "design_preview",
            )!,
            { id: "modes", mode: "dark" },
        ),
        /needs a design system/,
    );

    const file = async (args: object) =>
        readFile(
            (
                (await run("design_export", { id: "modes", format: "png", ...args })).details as {
                    path: string;
                }
            ).path,
        );
    const light = await pixel(await file({}), 200, 250);
    const dark = await pixel(await file({ mode: "high-contrast" }), 200, 250);

    assert.deepEqual(light.slice(0, 3), [244, 245, 249], "the light ground (#f4f5f9)");
    assert.deepEqual(dark.slice(0, 3), [14, 14, 20]);
    await assert.rejects(
        run("design_export", { id: "modes", format: "png", mode: "sepia" }),
        /no mode "sepia"/,
    );
    let handler: ((request: ConversationWebRequest) => unknown) | undefined;

    designRoutes(
        {
            conversationRoute: (_method: string, _path: string, handle: typeof handler) => {
                handler = handle;
            },
            error: (status: number, message: string) =>
                Object.assign(new Error(message), { status }),
        } as unknown as ExtensionWeb,
        host,
        { loadSystem: () => flagship },
    );
    const request = (body: object) =>
        ({
            body,
            conversation: { id: conversation, cwd },
            snapshot: app.harness.snapshot.bind(app.harness),
            signal: new AbortController().signal,
            context,
        }) as unknown as ConversationWebRequest;
    const saved = (await handler!(
        request({ id: "modes", format: "png", mode: "high-contrast" }),
    )) as {
        path: string;
    };

    assert.deepEqual((await pixel(await readFile(saved.path), 200, 250)).slice(0, 3), [14, 14, 20]);
    await assert.rejects(
        async () => handler!(request({ id: "modes", format: "png", mode: "sepia" })),
        /no mode "sepia"/,
    );
    await assert.rejects(
        async () => handler!(request({ id: "modes", format: "png", mode: 5 })),
        /name of a mode/,
    );
});
