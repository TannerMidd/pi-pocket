// Screenshot triage (`extensions/browser.ts`, the setting `triageScreenshots`): a classifier reads each screenshot
// and attaches one line that says what it shows — content, an error state, broken layout, or still loading — and one
// still loading is shot again once, half a second later, so the second image and its label are what the tool returns.
// A classifier that fails or times out attaches no line, and no line at all when the setting is off. No app, no
// browser, no network: the tool is driven directly, against a fake page and a scripted `host.classify`.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ClassifyRequest } from "../src/server/classify.ts";
import createBrowser from "../src/server/extensions/browser.ts";
import type { ExtensionWeb, PocketHost } from "../src/server/host.ts";

/** One real tiny JPEG (32×24, solid blue), so the tool and the classifier see a real image content. */
const JPEG =
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABQODxIPDRQSEBIXFRQYHjIhHhwcHj0sLiQySUBMS0dARkVQWnNiUFVtVkVGZIhlbXd7gYKBTmCNl4x9lnN+gXz/2wBDARUXFx4aHjshITt8U0ZTfHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHz/wAARCAAYACADASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFgEBAQEAAAAAAAAAAAAAAAAAAAQG/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AlwGwTgAAAAAP/9k=";
/** The second JPEG a retry returns, so a test can tell the two shots apart. */
const JPEG_TWO = JPEG.slice(0, -10) + "AAAAAAAAAP/9k=";

/** A fake page: it counts screenshots and answers each one in turn from `shots`, or the one JPEG. */
function fakePage(
    shots: string[] = [],
    mimeType = "image/jpeg",
    url = "https://example.test/page",
) {
    let taken = 0;
    const page = {
        logSeq: 1,
        logs: () => [],
        url,
        title: "Example page",
        viewport: { width: 390, height: 844 },
        screenshot: async () => {
            const data = shots[taken] ?? JPEG;

            taken += 1;

            return { data, mimeType, width: 390, height: 844, scale: 1 };
        },
    };

    return { page, taken: () => taken };
}

/** A fake host: its `classify` records each request and answers `answer`, or throws when `fail` says so. */
function fakeHost(
    page: unknown,
    answer: () => string,
    fail: () => boolean = () => false,
    shared?: string,
) {
    const asked: ClassifyRequest[] = [];
    const host = {
        browsers: { open: async () => page },
        classifierModel: () => shared,
        classify: async (request: ClassifyRequest) => {
            asked.push(request);

            if (fail()) {
                throw new Error("no sign-in");
            }

            return {
                shot: {
                    type: "choice" as const,
                    choice: answer(),
                    probabilities: {},
                    confidence: 1,
                },
            };
        },
    } as unknown as PocketHost;

    return { host, asked };
}

/** A fake web: what `web.setting` answers comes from `values`, so a test can turn the setting on or off. */
function fakeWeb(values: Record<string, unknown> = { classifyModel: "faux/jev" }) {
    const web = {
        settings: () => {},
        setting: (name: string) => values[name],
    } as unknown as ExtensionWeb;

    return { web, values };
}

/** The browser tool, its extension's one tool, driven directly: what one `screenshot` call returns. */
async function screenshot(host: PocketHost, web: ExtensionWeb | undefined, args: object = {}) {
    const extension = createBrowser(host, web) as unknown as {
        tools: {
            name: string;
            execute: (
                args: Record<string, unknown>,
                api: unknown,
                context: unknown,
            ) => Promise<{
                output: { type: string; text?: string; data?: string }[];
                isError?: boolean;
            }>;
        }[];
    };
    const tool = extension.tools.find((each) => each.name === "browser")!;
    const api = { conversationId: 1, snapshot: async () => ({ cwd: "/tmp" }) };
    const context = { abortSignal: undefined };

    return tool.execute({ action: "screenshot", ...args }, api, context);
}

/** The tool result's text and image, as strings. */
const parts = (result: Awaited<ReturnType<typeof screenshot>>) => ({
    text: result.output.find((part) => part.type === "text")?.text ?? "",
    image: result.output.find((part) => part.type === "image")?.data,
});

test("each label attaches its line beside the screenshot, and the classifier reads the image", async () => {
    const words: [string, string][] = [
        ["content", "content"],
        ["error", "an error state"],
        ["broken-layout", "broken layout"],
    ];

    for (const [label, word] of words) {
        const { page, taken } = fakePage();
        const { host, asked } = fakeHost(page, () => label);
        const { web, values } = fakeWeb();

        values.triageScreenshots = true;
        values.classifyModel = "faux/jev";
        const result = await screenshot(host, web);
        const { text, image } = parts(result);

        assert.match(text, new RegExp(`The classifier reads the screenshot as ${word}\\.`), label);
        assert.equal(image, JPEG);
        assert.equal(taken(), 1, "one screenshot, no retry");

        // What the classifier was asked: the page's address and title, the image itself, and the model from the setting.
        assert.equal(asked.length, 1);
        assert.equal(asked[0]!.model, "faux/jev");
        assert.deepEqual(asked[0]!.state, {
            url: "https://example.test/page",
            title: "Example page",
        });
        assert.deepEqual(asked[0]!.images, [{ type: "image", data: JPEG, mimeType: "image/jpeg" }]);
        assert.deepEqual(Object.keys(asked[0]!.questions), ["shot"]);
    }
});

test("a shot read as still loading is taken once more: two shots, two classify calls, the second image and label", async () => {
    const { page, taken } = fakePage([JPEG, JPEG_TWO]);
    const { host, asked } = fakeHost(page, () => (taken() === 1 ? "loading" : "content"));
    const { web, values } = fakeWeb();

    values.triageScreenshots = true;
    const result = await screenshot(host, web);
    const { text, image } = parts(result);

    // The first shot is dropped: the result holds the second image and the second label.
    assert.equal(taken(), 2, "exactly one retry");
    assert.equal(asked.length, 2, "one classify per shot");
    assert.equal(image, JPEG_TWO);
    assert.match(text, /The classifier reads the screenshot as content\./);
    assert.equal(asked[0]!.images![0]!.data, JPEG);
    assert.equal(asked[1]!.images![0]!.data, JPEG_TWO);
});

test("a shot still loading on the retry is returned as still loading, with no third attempt", async () => {
    const { page, taken } = fakePage([JPEG, JPEG_TWO]);
    const { host, asked } = fakeHost(page, () => "loading");
    const { web, values } = fakeWeb();

    values.triageScreenshots = true;
    const { text, image } = parts(await screenshot(host, web));

    assert.equal(taken(), 2);
    assert.equal(asked.length, 2);
    assert.equal(image, JPEG_TWO);
    assert.match(text, /The classifier reads the screenshot as still loading\./);
});

test("a classifier that fails attaches no line, and the screenshot still comes back", async () => {
    const { page, taken } = fakePage();
    const { host, asked } = fakeHost(
        page,
        () => "content",
        () => true,
    );
    const { web, values } = fakeWeb();

    values.triageScreenshots = true;
    const { text, image } = parts(await screenshot(host, web));

    assert.doesNotMatch(text, /classifier reads/);
    assert.equal(image, JPEG);
    assert.equal(taken(), 1, "no retry on a failed read");
    assert.equal(asked.length, 1, "the failing call was still made once");
});

test("with the setting off, no classify call is made at all", async () => {
    const { page, taken } = fakePage();
    const { host, asked } = fakeHost(page, () => "content");
    const { web } = fakeWeb();

    const { text } = parts(await screenshot(host, web));

    assert.doesNotMatch(text, /classifier reads/);
    assert.equal(asked.length, 0);
    assert.equal(taken(), 1);
});

test("a host with no classify (an older server) attaches nothing", async () => {
    const { page, taken } = fakePage();
    const host = { browsers: { open: async () => page } } as unknown as PocketHost;
    const { web, values } = fakeWeb();

    values.triageScreenshots = true;
    const { text, image } = parts(await screenshot(host, web));

    assert.doesNotMatch(text, /classifier reads/);
    assert.equal(image, JPEG);
    assert.equal(taken(), 1);
});

test("with no classifier chosen nothing is asked; the owner's shared choice is used when the setting is empty", async () => {
    const { page } = fakePage();
    const none = fakeHost(page, () => "content");
    const { web, values } = fakeWeb({ classifyModel: "" });

    values.triageScreenshots = true;
    const { text } = parts(await screenshot(none.host, web));

    assert.doesNotMatch(text, /classifier reads/);
    assert.equal(none.asked.length, 0, "no default classifier: nothing is sent");

    const shared = fakeHost(
        page,
        () => "content",
        () => false,
        "faux/shared",
    );

    await screenshot(shared.host, web);
    assert.equal(shared.asked[0]!.model, "faux/shared");

    // The module's own setting wins over the shared choice.
    values.classifyModel = "faux/own";
    const own = fakeHost(
        page,
        () => "content",
        () => false,
        "faux/shared",
    );

    await screenshot(own.host, web);
    assert.equal(own.asked[0]!.model, "faux/own");

    // Without a web part there is no setting to read: the shot comes back with no line.
    const second = fakeHost(
        page,
        () => "content",
        () => false,
        "faux/shared",
    );
    const result = parts(await screenshot(second.host, undefined));

    assert.doesNotMatch(result.text, /classifier reads/);
    assert.equal(second.asked.length, 0);
});

test("the image goes with the type the page says, and the address goes without its query and fragment", async () => {
    const { page } = fakePage([JPEG], "image/png", "https://example.test/p?token=secret#frag");
    const { host, asked } = fakeHost(
        page,
        () => "content",
        () => false,
        "faux/shared",
    );
    const { web, values } = fakeWeb();

    values.triageScreenshots = true;
    const result = await screenshot(host, web);
    const image = result.output.find((part) => part.type === "image") as unknown as {
        mimeType: string;
    };

    assert.equal(asked[0]!.images![0]!.mimeType, "image/png");
    assert.equal(image.mimeType, "image/png");
    assert.equal(asked[0]!.state.url, "https://example.test/p");
    assert.doesNotMatch(JSON.stringify(asked[0]!.state), /secret|frag/);
});
