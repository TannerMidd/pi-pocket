/**
 * Browser: Pi opens, reads, clicks through, and screenshots web pages in a real Chromium on this machine, the same page
 * the people in the conversation watch and use in the Browser panel. Turning it off turns off the panel too.
 *
 * A call is not replayed after a restart (clicking twice is not harmless), and the page itself does not survive one:
 * its address comes back when it opens again, but not what was typed or clicked on it.
 */
import { awaitWithContext } from "@earendil-works/chord/context";
import { type ImageContent, type TextContent, Type } from "@earendil-works/pi-ai";
import { AgentDoc, defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import type { BrowserPage, LogEntry, Target } from "../browser/page.ts";
import { displayUrl, normalizeUrl } from "../browser/urls.ts";
import { presetOf, viewportFrom } from "../browser/viewport.ts";
import type { PocketHost } from "../host.ts";

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

const GUIDE = `You have a browser tool: a real Chromium on this machine. The people in this conversation see the same page live in the app's Browser panel and can click and type in it too, so it is how you show and test web work: local dev servers (http://localhost:5173), HTML files on this machine (give their path), or any site.
- Start a dev server in the background with bash first, for example \`nohup npm run dev > /tmp/dev.log 2>&1 &\`, then navigate to it.
- snapshot lists the page's text and its controls with refs like [e12]; click, type, select, and hover take a ref (or a CSS selector, or the visible label). Refs last until the next snapshot.
- screenshot shows you how the page looks: use it to check layout and styling. viewport switches between mobile, tablet, and desktop sizes.
- After a change, check console for errors. evaluate runs JavaScript in the page.`;

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

export default function createBrowser(host: PocketHost) {
    const browser = defineTool({
        name: "browser",
        description:
            "Use a real web browser (Chromium on this machine) that the people in this conversation watch live. Open pages (local dev servers, files, sites), read them as a snapshot with element refs, click, type, take screenshots you can see, read console errors, and run JavaScript in the page.",
        parameters: Type.Object({
            action: Type.Union(
                ACTIONS.map((action) => Type.Literal(action)),
                {
                    description:
                        "navigate (url), snapshot, screenshot, click/hover (ref, selector, label, or x and y), type (text into ref/selector/label, or the focused element), press (key), select (value in a select element), scroll (to ref/selector/label, or by dy), wait (text, selector, or timeoutMs), evaluate (script), console, back, forward, reload, viewport.",
                },
            ),
            url: Type.Optional(
                Type.String({
                    description:
                        "navigate: an http(s) URL, host:port such as localhost:5173, or a path to an HTML file on this machine.",
                }),
            ),
            ref: Type.Optional(
                Type.String({ description: "An element ref from the last snapshot, such as e12." }),
            ),
            selector: Type.Optional(
                Type.String({
                    description: "Instead of ref: a CSS selector. wait: wait until it is visible.",
                }),
            ),
            label: Type.Optional(
                Type.String({
                    description:
                        "Instead of ref: the element's visible text or label, such as a button's text.",
                }),
            ),
            x: Type.Optional(
                Type.Number({
                    description:
                        "click, hover: a point in CSS pixels of the viewport, as seen in a screenshot (one shown smaller says how to scale its points).",
                }),
            ),
            y: Type.Optional(Type.Number()),
            text: Type.Optional(
                Type.String({
                    description:
                        "type: the text to type (empty clears the field). wait: text to wait for.",
                }),
            ),
            submit: Type.Optional(Type.Boolean({ description: "type: press Enter afterwards." })),
            append: Type.Optional(
                Type.Boolean({
                    description: "type: add to what the field holds instead of replacing it.",
                }),
            ),
            key: Type.Optional(
                Type.String({
                    description:
                        "press: a key or combination, such as Enter, Escape, Tab, ArrowDown, Control+A.",
                }),
            ),
            value: Type.Optional(
                Type.String({ description: "select: the option's value or text." }),
            ),
            dy: Type.Optional(
                Type.Number({
                    description:
                        "scroll: pixels down (negative: up). Default: most of a screen down.",
                }),
            ),
            script: Type.Optional(
                Type.String({
                    description:
                        "evaluate: JavaScript run in the page: an expression or statements (top-level await works), or a body that ends with return. Its value comes back as JSON.",
                }),
            ),
            viewport: Type.Optional(
                Type.String({
                    description:
                        "viewport: mobile (390×844), tablet (820×1180), desktop (1280×800), or WIDTHxHEIGHT.",
                }),
            ),
            fullPage: Type.Optional(
                Type.Boolean({
                    description: "screenshot: the whole page, not only what fits the viewport.",
                }),
            ),
            timeoutMs: Type.Optional(
                Type.Number({
                    description:
                        "navigate, wait: how long to wait in milliseconds (default 30000 for navigate, 10000 for wait).",
                }),
            ),
            snapshot: Type.Optional(
                Type.Boolean({
                    description: "After an action that changes the page: also return its snapshot.",
                }),
            ),
            clear: Type.Optional(
                Type.Boolean({ description: "console: clear the lines after reading them." }),
            ),
        }),
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
                    const shot = await run(page.screenshot({ fullPage: args.fullPage === true }));

                    // Models refuse bigger images once a conversation holds many, so a big page comes back smaller.
                    const smaller =
                        shot.scale < 1
                            ? `, shown at ${Math.round(shot.width * shot.scale)}×${Math.round(shot.height * shot.scale)}: multiply a point in it by ${(1 / shot.scale).toFixed(2)} for CSS pixels`
                            : "";

                    image = { type: "image", data: shot.data, mimeType: "image/jpeg" };
                    lines.push(
                        `Screenshot of ${args.fullPage === true ? "the whole page" : "the viewport"}, ${shot.width}×${shot.height} CSS pixels${smaller}.`,
                    );
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
                content,
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
            section("browser", (input) =>
                input.agent.tools.some((tool) => tool.name === "browser") ? GUIDE : undefined,
            ),
        ],
    });
}
