/**
 * Browser: Pi opens, reads, clicks through, and screenshots web pages in a real Chromium on this machine, the same page
 * the people in the conversation watch and use in the Browser panel. Turning it off turns off the panel too.
 *
 * Screenshot triage (the setting `triageScreenshots`, off by default): a classifier model with image input reads each
 * screenshot and adds one line that says what it shows — content, an error state, broken layout, or still loading — so
 * the model knows what the image holds without seeing it; one still loading is shot again once, after half a second.
 * A classifier that fails or runs out of time attaches no line.
 *
 * A call is not replayed after a restart (clicking twice is not harmless), and the page itself does not survive one:
 * its address comes back when it opens again, but not what was typed or clicked on it.
 */
import { awaitWithContext } from "@earendil-works/chord/context";
import { type ImageContent, StringEnum, type TextContent } from "@earendil-works/pi-ai";
import { bool, num, obj, opt, str } from "@earendil-works/pi-schema";
import { AgentDoc, defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import type { BrowserPage, LogEntry, Target } from "../browser/page.ts";
import { displayUrl, normalizeUrl, REMOTE_FILES } from "../browser/urls.ts";
import { presetOf, viewportFrom } from "../browser/viewport.ts";
import { DEFAULT_CLASSIFY_MODEL, type ClassifyRequest, withDeadline } from "../classify.ts";
import type { ExtensionWeb, PocketHost } from "../host.ts";
import { workspaceScheme } from "../paths.ts";

const ACTIONS = [
    "navigate",
    "snapshot",
    "screenshot",
    "click",
    "type",
    "press",
    "select",
    "hover",
    "scroll",
    "wait",
    "evaluate",
    "console",
    "back",
    "forward",
    "reload",
    "viewport",
] as const;

type Action = (typeof ACTIONS)[number];

/** Actions that may change the page, after which a snapshot can come along. */
const CHANGING = new Set<Action>([
    "navigate",
    "click",
    "type",
    "press",
    "select",
    "back",
    "forward",
    "reload",
    "viewport",
]);
const MAX_TEXT = 20_000;

/** How long one screenshot-triage classify call may take; past it, the shot goes back with no line. */
const TRIAGE_TIMEOUT_MS = 5_000;
/** How long to wait before the one retry of a shot the classifier read as still loading. */
const LOADING_RETRY_MS = 500;

/** The labels the classifier answers about a screenshot, each with the criterion that earns it. */
const TRIAGE_CRITERIA = {
    loading:
        "The page is still loading: a spinner, a skeleton, a mostly blank body, or a progress bar.",
    error: "The page shows an error: a failure or not-found message, an error code, a crash screen, or a refused connection.",
    content: "The page shows its real content: the text, images, or controls people use it for.",
    "broken-layout":
        "The page loaded, but its layout is broken: elements overlap or are cut off, or the styles did not load.",
} as const;

type TriageLabel = keyof typeof TRIAGE_CRITERIA;

/** What each label says in the line the tool attaches beside the screenshot. */
const TRIAGE_WORDS: Record<TriageLabel, string> = {
    loading: "still loading",
    error: "an error state",
    content: "content",
    "broken-layout": "broken layout",
};

const TRIAGE_QUESTIONS: ClassifyRequest["questions"] = {
    shot: {
        type: "choice",
        instructions:
            "Classify what the screenshot in the images shows, a web page the browser tool just took. Judge the whole image.",
        criteria: TRIAGE_CRITERIA,
    },
};

const GUIDE = `The browser tool is a real Chromium on this machine. The people in this conversation see its page live in the Browser panel and can use it too: show and test web work there (local dev servers, HTML files on this machine, any site).
- Start a dev server in the background with bash first (\`nohup npm run dev > /tmp/dev.log 2>&1 &\`), then navigate to it.
- snapshot gives refs like [e12] for click, type, select, and hover, valid until the next snapshot. screenshot shows the layout; viewport changes the size. After a change, check console for errors.`;

function clip(text: string, max = MAX_TEXT): string {
    return text.length > max
        ? `${text.slice(0, max)}\n… (${text.length - max} more characters)`
        : text;
}

/** Where the page is, for the end of every answer. */
function where(page: BrowserPage): string {
    const viewport = page.viewport;
    const size = `${presetOf(viewport) ?? "custom"} ${viewport.width}×${viewport.height}`;
    const url = page.url === "about:blank" ? "a blank page" : page.url;

    return `Page: ${page.title === "" ? "" : `"${page.title}" · `}${url} · ${size}`;
}

function formatLog(entry: LogEntry): string {
    if (entry.level === "nav") {
        return `--- navigated to ${entry.text} ---`;
    }

    return `[${entry.level}] ${entry.text}${entry.source === undefined ? "" : ` (${entry.source})`}`;
}

export default function createBrowser(host: PocketHost, web?: ExtensionWeb) {
    // With a web part, the owner can turn screenshot triage on and name its classifier model.
    if (web !== undefined) {
        web.settings([
            {
                name: "triageScreenshots",
                label: "Triage screenshots",
                description:
                    "A classifier reads each screenshot and adds a line beside it that says what it shows: content, an error state, broken layout, or still loading. One still loading is taken again after half a second, once. Needs a classifier model with image input; off by default.",
                type: "boolean",
                default: false,
            },
            {
                name: "classifyModel",
                label: "Screenshot classifier model",
                description:
                    "The classifier that reads each screenshot, as provider/modelId. It must accept image input. Default: OpenRouter's Jev route; an OpenRouter sign-in is enough.",
                type: "text",
                default: DEFAULT_CLASSIFY_MODEL,
            },
        ]);
    }

    /** The classifier model the owner named for triage, or the default one. */
    const model = () => {
        const value = web?.setting("classifyModel");

        return typeof value === "string" && value.trim() !== ""
            ? value.trim()
            : DEFAULT_CLASSIFY_MODEL;
    };

    const browser = defineTool({
        name: "browser",
        description:
            "Use a real web browser (Chromium on this machine) that the people in this conversation watch live. Open pages (local dev servers, files, sites), read them as a snapshot with element refs, click, type, take screenshots you can see, read console errors, and run JavaScript in the page.",
        parameters: obj(
            {
                action: StringEnum(ACTIONS, {
                    description:
                        "navigate (url), snapshot, screenshot, click/hover (ref, selector, label, or x and y), type (text into ref/selector/label, or the focused element), press (key), select (value in a select element), scroll (to ref/selector/label, or by dy), wait (text, selector, or timeoutMs), evaluate (script), console, back, forward, reload, viewport.",
                }),
                url: opt(
                    str({
                        description:
                            "navigate: an http(s) URL, host:port such as localhost:5173, or a path to an HTML file on this machine.",
                    }),
                ),
                ref: opt(
                    str({ description: "An element ref from the last snapshot, such as e12." }),
                ),
                selector: opt(
                    str({
                        description:
                            "Instead of ref: a CSS selector. wait: wait until it is visible.",
                    }),
                ),
                label: opt(
                    str({
                        description:
                            "Instead of ref: the element's visible text or label, such as a button's text.",
                    }),
                ),
                x: opt(
                    num({
                        description:
                            "click, hover: a point in CSS pixels of the viewport, as seen in a screenshot (one shown smaller says how to scale its points).",
                    }),
                ),
                y: opt(num()),
                text: opt(
                    str({
                        description:
                            "type: the text to type (empty clears the field). wait: text to wait for.",
                    }),
                ),
                submit: opt(bool({ description: "type: press Enter afterwards." })),
                append: opt(
                    bool({
                        description: "type: add to what the field holds instead of replacing it.",
                    }),
                ),
                key: opt(
                    str({
                        description:
                            "press: a key or combination, such as Enter, Escape, Tab, ArrowDown, Control+A.",
                    }),
                ),
                value: opt(str({ description: "select: the option's value or text." })),
                dy: opt(
                    num({
                        description:
                            "scroll: pixels down (negative: up). Default: most of a screen down.",
                    }),
                ),
                script: opt(
                    str({
                        description:
                            "evaluate: JavaScript run in the page: an expression or statements (top-level await works), or a body that ends with return. Its value comes back as JSON.",
                    }),
                ),
                viewport: opt(
                    str({
                        description:
                            "viewport: mobile (390×844), tablet (820×1180), desktop (1280×800), or WIDTHxHEIGHT.",
                    }),
                ),
                fullPage: opt(
                    bool({
                        description: "screenshot: the whole page, not only what fits the viewport.",
                    }),
                ),
                timeoutMs: opt(
                    num({
                        description:
                            "navigate, wait: how long to wait in milliseconds (default 30000 for navigate, 10000 for wait).",
                    }),
                ),
                snapshot: opt(
                    bool({
                        description:
                            "After an action that changes the page: also return its snapshot.",
                    }),
                ),
                clear: opt(bool({ description: "console: clear the lines after reading them." })),
            },
            { open: true },
        ),
        // Pages are shared and stateful: a round's calls run in order.
        executionMode: "sequential",
        execute: async (args, api, context) => {
            const signal = context.abortSignal;
            const action = args.action as Action;
            const agent = await api.snapshot(AgentDoc, api.conversationId, context);
            const cwd = agent?.cwd ?? process.cwd();
            // A page opened again comes back at its last address, unless Pi is about to open another.
            const page = await awaitWithContext(
                host.browsers.open(Number(api.conversationId), { restore: action !== "navigate" }),
                context,
            );
            const before = page.logSeq;
            const target: Target = {
                ...(args.ref === undefined ? {} : { ref: args.ref.replace(/^\[|\]$/g, "") }),
                ...(args.selector === undefined ? {} : { selector: args.selector }),
                ...(args.label === undefined ? {} : { label: args.label }),
                ...(args.x === undefined || args.y === undefined ? {} : { x: args.x, y: args.y }),
            };
            const pointed = Object.keys(target).length > 0;

            const need = (ok: boolean, what: string) => {
                if (!ok) {
                    throw new Error(`${action} needs ${what}.`);
                }
            };

            const lines: string[] = [];
            let image: ImageContent | undefined;
            let failed = false;
            const run = <T>(promise: Promise<T>) => awaitWithContext(promise, context);

            switch (action) {
                case "navigate": {
                    need(args.url !== undefined && args.url.trim() !== "", "a url");
                    const url = normalizeUrl(args.url!, { trusted: true, cwd });

                    if (url === undefined) {
                        throw new Error(
                            `"${args.url}" is not an address the browser opens: give an http(s) URL, host:port, or a file path.`,
                        );
                    }

                    if (url.startsWith("file:") && workspaceScheme(cwd) !== undefined) {
                        throw new Error(REMOTE_FILES);
                    }

                    const result = await run(
                        page.navigate(url, {
                            timeoutMs: args.timeoutMs ?? 30_000,
                            ...(signal === undefined ? {} : { signal }),
                        }),
                    );

                    if (result.error !== undefined) {
                        failed = true;
                        const refused = /CONNECTION_REFUSED/.test(result.error);

                        lines.push(
                            `Could not open ${url}: ${result.error}.${refused ? " Nothing answers there: is the server running?" : ""}`,
                        );
                    } else {
                        lines.push(
                            `Opened ${url}${result.status === undefined ? "" : ` (HTTP ${result.status})`}.`,
                        );

                        if (result.slow === true) {
                            lines.push("It is still loading.");
                        }
                    }

                    break;
                }

                case "back":

                case "forward": {
                    const moved = await run(
                        page.go(action === "back" ? -1 : 1, signal === undefined ? {} : { signal }),
                    );

                    lines.push(moved ? `Went ${action}.` : `There is no page to go ${action} to.`);
                    break;
                }

                case "reload":
                    await run(page.reload(signal === undefined ? {} : { signal }));
                    lines.push("Reloaded.");
                    break;
                case "snapshot":
                    break;

                case "screenshot": {
                    let shot = await run(page.screenshot({ fullPage: args.fullPage === true }));
                    let triage: TriageLabel | undefined;

                    /** One classifier read of a shot: its label, or undefined to attach no line. */
                    const read = async (data: string): Promise<TriageLabel | undefined> => {
                        // Off, or a server too old for `host.classify` (this module reloaded into it): no line.
                        if (
                            web === undefined ||
                            web.setting("triageScreenshots") !== true ||
                            typeof host.classify !== "function"
                        ) {
                            return undefined;
                        }

                        const answers = await withDeadline(
                            () =>
                                host.classify({
                                    model: model(),
                                    state: { url: page.url, title: page.title },
                                    images: [{ type: "image", data, mimeType: "image/jpeg" }],
                                    questions: TRIAGE_QUESTIONS,
                                }),
                            TRIAGE_TIMEOUT_MS,
                        );
                        const answer = answers?.shot;

                        return answer?.type === "choice" &&
                            Object.hasOwn(TRIAGE_CRITERIA, answer.choice)
                            ? (answer.choice as TriageLabel)
                            : undefined;
                    };

                    // Screenshot triage: one classifier read, and one retry when the shot is still loading, so the
                    // second image and its label are what the tool returns. A call that fails or runs out of time
                    // attaches no line, and the shot goes back as it came.
                    if (web?.setting("triageScreenshots") === true) {
                        triage = await read(shot.data);

                        if (triage === "loading") {
                            await new Promise((resolve) => setTimeout(resolve, LOADING_RETRY_MS));
                            shot = await run(page.screenshot({ fullPage: args.fullPage === true }));
                            triage = await read(shot.data);
                        }
                    }

                    // Models refuse bigger images once a conversation holds many, so a big page comes back smaller.
                    const smaller =
                        shot.scale < 1
                            ? `, shown at ${Math.round(shot.width * shot.scale)}×${Math.round(shot.height * shot.scale)}: multiply a point in it by ${(1 / shot.scale).toFixed(2)} for CSS pixels`
                            : "";

                    image = { type: "image", data: shot.data, mimeType: "image/jpeg" };
                    lines.push(
                        `Screenshot of ${args.fullPage === true ? "the whole page" : "the viewport"}, ${shot.width}×${shot.height} CSS pixels${smaller}.`,
                    );

                    if (triage !== undefined) {
                        lines.push(
                            `The classifier reads the screenshot as ${TRIAGE_WORDS[triage]}.`,
                        );
                    }

                    break;
                }

                case "click": {
                    need(pointed, "a ref, selector, label, or x and y");
                    const clicked = await run(
                        page.click(target, signal === undefined ? {} : { signal }),
                    );

                    lines.push(`Clicked ${clicked.label}.`);

                    if (clicked.covered !== undefined) {
                        lines.push(
                            `Something else was on top of it: ${clicked.covered}, which got the click.`,
                        );
                    }

                    if (clicked.navigated) {
                        lines.push(`The page changed to ${page.url}.`);
                    }

                    break;
                }

                case "hover":
                    need(pointed, "a ref, selector, label, or x and y");
                    lines.push(`The mouse is over ${await run(page.hover(target))}.`);
                    break;

                case "type": {
                    need(args.text !== undefined, "text");
                    const into = await run(
                        page.type(pointed ? target : undefined, args.text!, {
                            ...(args.append === undefined ? {} : { append: args.append }),
                            ...(args.submit === undefined ? {} : { submit: args.submit }),
                            ...(signal === undefined ? {} : { signal }),
                        }),
                    );

                    lines.push(
                        args.text === ""
                            ? `Cleared ${into}.`
                            : `Typed into ${into}${args.submit === true ? " and pressed Enter" : ""}.`,
                    );
                    break;
                }

                case "press":
                    need(args.key !== undefined && args.key !== "", "a key");
                    await run(page.press(args.key!, signal === undefined ? {} : { signal }));
                    lines.push(`Pressed ${args.key}.`);
                    break;
                case "select":
                    need(pointed && args.value !== undefined, "a ref or selector and a value");
                    lines.push(`Selected "${await run(page.select(target, args.value!))}".`);
                    break;
                case "scroll":
                    lines.push(
                        `Scrolled ${pointed ? "to " : ""}${await run(page.scroll(pointed ? target : undefined, args.dy))}.`,
                    );
                    break;

                case "wait": {
                    const found = await run(
                        page.waitFor({
                            ...(args.text === undefined ? {} : { text: args.text }),
                            ...(args.selector === undefined ? {} : { selector: args.selector }),
                            ...(args.timeoutMs === undefined
                                ? {}
                                : { timeoutMs: args.timeoutMs, ms: args.timeoutMs }),
                            ...(signal === undefined ? {} : { signal }),
                        }),
                    );
                    const what = args.text !== undefined ? `"${args.text}"` : args.selector;

                    lines.push(
                        what === undefined
                            ? "Waited."
                            : found
                              ? `Found ${what}.`
                              : `${what} did not show up in time.`,
                    );

                    if (what !== undefined && !found) {
                        failed = true;
                    }

                    break;
                }

                case "evaluate":
                    need(args.script !== undefined && args.script.trim() !== "", "a script");
                    lines.push(
                        clip(
                            await run(
                                page.evaluate(args.script!, {
                                    timeoutMs: args.timeoutMs ?? 30_000,
                                }),
                            ),
                        ),
                    );
                    break;

                case "console": {
                    const entries = page.logs();

                    lines.push(
                        entries.length === 0
                            ? "The console is empty."
                            : clip(entries.map(formatLog).join("\n")),
                    );

                    if (args.clear === true) {
                        page.clearLogs();
                    }

                    break;
                }

                case "viewport": {
                    const viewport = viewportFrom(args.viewport);

                    if (viewport === undefined) {
                        throw new Error("viewport needs mobile, tablet, desktop, or WIDTHxHEIGHT.");
                    }

                    await run(page.setViewport(viewport));
                    lines.push(
                        `The page is now ${presetOf(viewport) ?? "custom"} ${viewport.width}×${viewport.height}.`,
                    );
                    break;
                }
            }

            if (action === "snapshot" || (args.snapshot === true && CHANGING.has(action))) {
                const outline = await run(page.snapshot());
                const below = outline.scrollHeight - outline.scrollY - outline.innerHeight;

                lines.push(
                    `Snapshot (scrolled ${outline.scrollY} of ${outline.scrollHeight}px${below > 0 ? `, ${below}px below the viewport` : ""}):`,
                    outline.lines === "" ? "(no text or controls)" : outline.lines,
                );

                if (outline.truncated) {
                    lines.push(
                        "… the snapshot stops here: scroll, or use evaluate to read the rest.",
                    );
                }
            }

            if (action !== "console") {
                const errors = page
                    .logs(before)
                    .filter((entry) => entry.level === "error" || entry.level === "dialog");

                if (errors.length > 0) {
                    lines.push(
                        "Console errors and dialogs during this call:",
                        ...errors.slice(0, 10).map((entry) => `- ${formatLog(entry)}`),
                        ...(errors.length > 10
                            ? [`- … and ${errors.length - 10} more (see console)`]
                            : []),
                    );
                }
            }

            lines.push(where(page));
            const content: (TextContent | ImageContent)[] = [
                { type: "text", text: lines.join("\n") },
            ];

            if (image !== undefined) {
                content.push(image);
            }

            return {
                output: content,
                ...(failed ? { isError: true } : {}),
                details: {
                    action,
                    url: page.url,
                    address: displayUrl(page.url),
                    title: page.title,
                },
            };
        },
    });

    return defineExtension({
        name: "pocket-browser",
        tools: [browser],
        sections: [
            // Offered, or for scripts alone (codemode's Only mode).
            section("browser", ({ agent }) =>
                agent.tools.some((tool) => tool.name === "browser") ||
                agent.callable.some(
                    (tool) => tool.name === "browser" && tool.callers?.includes("model") === false,
                )
                    ? GUIDE
                    : undefined,
            ),
        ],
    });
}
