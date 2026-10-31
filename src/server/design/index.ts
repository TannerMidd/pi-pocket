/** Agent-facing Design tools and workspace export routes. Registered by the Design module. */
import { StringEnum, Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import type { ExtensionWeb, PocketHost } from "../host.ts";
import { readBundle } from "./bundle.ts";
import { EXPORT_TYPES, type ExportFormat, saveDesignExport } from "./export.ts";
import {
    checkPage,
    mergeFindings,
    mergeNotJudged,
    modeFor,
    notJudgedText,
    renderedMode,
    reportOf,
} from "./lint.ts";
import {
    designActions,
    tweakValues,
    VIEWPORTS,
    viewportOf,
    withRender,
    type DesignPage,
} from "./render.ts";
import { designSystemTool } from "./system.ts";
import type { CheckFinding, CheckReport, DesignSystem } from "./system-types.ts";
import { loadDesignSystem } from "./tokens.ts";

export { designGuide } from "./guide.ts";

const version = Type.Optional(Type.Integer({ minimum: 1 }));
const preset = StringEnum(["mobile", "tablet", "desktop"] as const);
const formatSchema = StringEnum(["png", "pdf", "pptx", "html"] as const);

interface DesignToolDeps {
    loadSystem?: (cwd: string) => DesignSystem | undefined;
}

const tweakSchema = Type.Record(
    Type.String({ maxLength: 80 }),
    Type.Union([Type.String({ maxLength: 200 }), Type.Number(), Type.Boolean()]),
    { maxProperties: 40, description: "Tweak values, as the Tweaks panel sets them." },
);
const slideSchema = Type.Union([Type.Integer({ minimum: 1, maximum: 100 }), Type.Literal("all")]);

const modeSchema = Type.String({
    minLength: 1,
    maxLength: 64,
    description:
        "A mode of the design system (high-contrast, a brand): the page gets data-theme=<mode>, is drawn in the mode's color scheme, and is checked against that mode's tokens.",
});

const MAX_FINDINGS = 30;

type Output = (
    { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
)[];

function findingLine(finding: CheckFinding, views: string, all: number): string {
    const where =
        finding.selector === ""
            ? "page"
            : finding.selector +
              (finding.elements === undefined ? "" : ` (+${finding.elements.length - 1} more)`);

    return `- ${finding.level} ${finding.rule} ${where}${views.length > 0 && views.split(", ").length < all ? ` (${views})` : ""}: ${finding.message}`;
}

export function checkText(
    reports: { view: string; report: CheckReport }[],
    system: DesignSystem | undefined,
    modeName: string | undefined,
    notes: string[],
): string {
    const merged = new Map<string, { finding: CheckFinding; views: string[] }>();

    for (const { view, report } of reports) {
        for (const finding of report.findings) {
            const key = [finding.rule, finding.level, finding.selector, finding.value ?? ""].join(
                "|",
            );
            const found = merged.get(key);

            if (found === undefined) {
                merged.set(key, { finding, views: [view] });
            } else {
                found.views.push(view);
            }
        }
    }

    const items = [...merged.values()];
    const errors = items.filter((item) => item.finding.level === "error").length;
    const warnings = items.length - errors;
    const where = `${reports.map((item) => item.view).join(", ")}; ${reports[0]?.report.colorScheme ?? "light"}`;
    const against =
        system === undefined
            ? "no design system, so no off-system rules"
            : `system "${system.name}", mode ${modeName ?? system.modes[0]}`;
    const lines = [
        `Checks (${where}; ${against}): ${plural(errors, "error")}, ${plural(warnings, "warning")}.`,
    ];

    for (const item of items.slice(0, MAX_FINDINGS)) {
        lines.push(findingLine(item.finding, item.views.join(", "), reports.length));
    }

    if (items.length > MAX_FINDINGS) {
        lines.push(
            `… and ${items.length - MAX_FINDINGS} more (fix these first, then preview again).`,
        );
    }

    if (items.length === 0) {
        lines.push("No findings.");
    }

    // What was left unjudged, so that the silence can be trusted: the worst view's.
    const left = reports
        .map((item) => notJudgedText(item.report))
        .filter((text) => text !== undefined)
        .sort((a, b) => b.length - a.length)[0];

    if (left !== undefined) {
        lines.push(left);
    }

    for (const note of notes) {
        lines.push(`Note: ${note}`);
    }

    return lines.join("\n");
}

function renderNotes(
    page: Pick<DesignPage, "errors" | "failedRequests">,
    reports: { view: string; report: CheckReport }[],
    system: DesignSystem | undefined,
    modeName: string | undefined,
    notes: string[],
): string {
    const lines: string[] = [];

    if (reports.length > 0) {
        lines.push(checkText(reports, system, modeName, notes));
    } else {
        lines.push(...notes.map((note) => `Note: ${note}`));
    }

    const list = (title: string, items: string[]) =>
        items.length === 0
            ? undefined
            : `${title} (${items.length}): ${items
                  .slice(0, 5)
                  .map((item) => item.slice(0, 200))
                  .join("; ")}${items.length > 5 ? "; …" : ""}`;
    const problems = [
        list("Console errors", page.errors),
        list("Failed requests", page.failedRequests),
    ].filter((line) => line !== undefined);

    lines.push(...(problems.length > 0 ? problems : ["No console errors or failed requests."]));

    return lines.join("\n");
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

export function designTools(host: PocketHost, deps: DesignToolDeps = {}): ToolRegistration[] {
    const loadSystem = deps.loadSystem ?? loadDesignSystem;
    const preview = Object.assign(
        defineTool({
            name: "design_preview",
            description:
                "Check an HTML design in private headless Chromium pages, never the shared browser. Returns screenshots, console errors, failed requests, and (checks, on by default) a compact list of problems: values that are not design-system tokens (with the nearest token), contrast, tap targets, overflow, alt text, headings, fonts, and focus. Fix every error, then preview again. Optional: tweaks (values to apply), colorScheme, mode (a mode of the design system, such as high-contrast), page (another HTML page of the bundle), actions (hover, click, or focus a selector before the screenshot). Slide numbers start at 1.",
            parameters: Type.Object({
                id: Type.String(),
                version,
                viewports: Type.Optional(
                    Type.Array(preset, { minItems: 1, maxItems: 3, uniqueItems: true }),
                ),
                fullPage: Type.Optional(Type.Boolean()),
                slide: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
                checks: Type.Optional(
                    Type.Boolean({ description: "Run the design checks. Default: true." }),
                ),
                tweaks: Type.Optional(tweakSchema),
                colorScheme: Type.Optional(
                    Type.Union([Type.Literal("light"), Type.Literal("dark")]),
                ),
                mode: Type.Optional(modeSchema),
                page: Type.Optional(
                    Type.String({
                        maxLength: 200,
                        description: "Another HTML page of the bundle, such as about.html.",
                    }),
                ),
                actions: Type.Optional(
                    Type.Array(
                        Type.Object({
                            type: Type.Union([
                                Type.Literal("hover"),
                                Type.Literal("click"),
                                Type.Literal("focus"),
                            ]),
                            selector: Type.String({ minLength: 1, maxLength: 300 }),
                        }),
                        { maxItems: 10 },
                    ),
                ),
            }),
            replay: "safe",
            execute: async (args, api, context) => {
                const bundle = await readBundle(
                    host,
                    api.snapshot,
                    api.conversationId,
                    args.id,
                    args.version,
                    context,
                );
                const views = args.viewports ?? ["mobile", "desktop"];
                const tweaks = tweakValues(args.tweaks);
                const actions = designActions(args.actions);
                const colorScheme = args.colorScheme ?? "light";
                const checks = args.checks !== false;
                const notes: string[] = [];
                let system: DesignSystem | undefined;
                let picked: ReturnType<typeof modeFor> | undefined;

                if (args.page !== undefined) {
                    const asset = bundle.assets.find((item) => item.name === args.page);

                    if (asset === undefined || !/^text\/html\b/.test(asset.type)) {
                        const pages = bundle.assets
                            .filter((item) => /^text\/html\b/.test(item.type))
                            .map((item) => item.name);

                        throw new Error(
                            `The bundle has no HTML page ${args.page}. Pages: ${pages.join(", ") || "none"}.`,
                        );
                    }
                }

                if (checks || args.mode !== undefined) {
                    const cwd = (await api.agent(context)).cwd;

                    try {
                        system = cwd === undefined ? undefined : loadSystem(cwd);
                    } catch (error) {
                        notes.push(
                            `The design system could not be read: ${error instanceof Error ? error.message : String(error)}`,
                        );
                    }

                    if (args.mode !== undefined && system === undefined) {
                        throw new Error("A mode needs a design system: this project has none.");
                    }

                    picked =
                        system === undefined ? undefined : modeFor(system, colorScheme, args.mode);
                }

                const scheme = picked?.scheme ?? colorScheme;

                return withRender(bundle, host, context.abortSignal, async (page) => {
                    let checked = picked?.mode;
                    const output: Output = [];
                    const reports: { view: string; report: CheckReport }[] = [];

                    for (const view of views) {
                        const size = VIEWPORTS[view];

                        await page.load(size, { page: args.page });
                        await page.applyView({
                            colorScheme: scheme,
                            theme: picked?.theme,
                            forceTheme: picked?.named,
                            tweaks,
                        });

                        const slide = args.slide ?? ((await page.isDeck()) ? 1 : undefined);

                        if (slide !== undefined) {
                            await page.showSlide(slide, size);
                        }

                        const check = async () => {
                            if (!checks) {
                                return undefined;
                            }

                            try {
                                // The mode the page really shows (a data-theme of its own), as the Check tab does.
                                checked = await renderedMode(page, system, args.mode, picked?.mode);

                                return await checkPage(page, system, {
                                    viewport: size,
                                    colorScheme: scheme,
                                    mode: checked,
                                });
                            } catch (error) {
                                notes.push(
                                    `Checks failed in ${view}: ${error instanceof Error ? error.message : String(error)}`,
                                );

                                return undefined;
                            }
                        };

                        const found: CheckReport[] = [];
                        const first = await check();

                        if (first !== undefined) {
                            found.push(first);
                        }

                        if (actions.length > 0) {
                            notes.push(...(await page.act(actions)));
                            const after = await check();

                            if (after !== undefined) {
                                found.push(after);
                            }
                        }

                        if (found.length > 0) {
                            reports.push({
                                view,
                                report: reportOf(
                                    mergeFindings(found),
                                    { viewport: size, colorScheme: scheme, mode: checked },
                                    found[0]!.summary.elements,
                                    system === undefined,
                                    mergeNotJudged(found),
                                ),
                            });
                        }

                        output.push({
                            type: "text",
                            text: `${args.id} v${bundle.version}: ${view} (${size.width}×${size.height})${slide === undefined ? "" : `, slide ${slide}`}`,
                        });
                        output.push({
                            type: "image",
                            data: await page.screenshot(size, args.fullPage, true),
                            mimeType: "image/png",
                        });
                    }

                    output.push({
                        type: "text",
                        text: renderNotes(page, checks ? reports : [], system, checked, notes),
                    });

                    return {
                        output,
                        details: {
                            id: args.id,
                            version: bundle.version,
                            viewports: views,
                            errors: page.errors,
                            failedRequests: page.failedRequests,
                            ...(checks
                                ? {
                                      // Plain JSON, as details must be.
                                      checks: JSON.parse(
                                          JSON.stringify(
                                              reports.map(({ view, report }) => ({
                                                  view,
                                                  summary: report.summary,
                                                  findings: report.findings.slice(0, 200),
                                              })),
                                          ),
                                      ),
                                  }
                                : {}),
                        },
                    };
                });
            },
        }),
        { annotations: { readOnlyHint: true } },
    );
    const exportTool = defineTool({
        name: "design_export",
        description:
            "Export an HTML design as PNG, PDF, PPTX (image slides with text notes), or an HTML bundle zip. Writes inside the session folder, by default exports/<id>-v<version>.<ext>. Existing output files are replaced. PPTX requires a deck. A page's PNG and PDF use the viewport's width (a preset, or { width, height }). tweaks applies tweak values first. mode draws it in a mode of the design system (data-theme and the mode's color scheme). For a deck's PNG, slide picks a slide (from 1; default 1), or \"all\" writes a zip with every slide.",
        parameters: Type.Object({
            id: Type.String(),
            version,
            format: formatSchema,
            viewport: Type.Optional(
                Type.Union([
                    preset,
                    Type.Object({
                        width: Type.Integer({ minimum: 320, maximum: 2560 }),
                        height: Type.Integer({ minimum: 240, maximum: 2560 }),
                    }),
                ]),
            ),
            path: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
            tweaks: Type.Optional(tweakSchema),
            slide: Type.Optional(slideSchema),
            mode: Type.Optional(modeSchema),
        }),
        execute: async (args, api, context) => {
            const bundle = await readBundle(
                host,
                api.snapshot,
                api.conversationId,
                args.id,
                args.version,
                context,
            );
            const cwd = (await api.agent(context)).cwd;

            if (cwd === undefined) {
                throw new Error("This session has no working directory for the export.");
            }

            const saved = await saveDesignExport(
                bundle,
                {
                    id: args.id,
                    format: args.format,
                    cwd,
                    viewport: args.viewport,
                    path: args.path,
                    tweaks: tweakValues(args.tweaks),
                    slide: args.slide,
                    ...exportMode(loadSystem, cwd, args.mode),
                    signal: context.abortSignal,
                },
                host,
            );

            return {
                output: [
                    {
                        type: "text",
                        text: `Exported ${args.id} v${bundle.version} to ${saved.path}`,
                    },
                ],
                details: {
                    path: saved.path,
                    id: args.id,
                    version: bundle.version,
                    format: args.format,
                    bytes: saved.size,
                },
            };
        },
    });

    return [preview, exportTool, designSystemTool()];
}

function exportMode(
    loadSystem: (cwd: string) => DesignSystem | undefined,
    cwd: string,
    mode: unknown,
): { colorScheme?: "light" | "dark"; theme?: string } {
    if (mode === undefined || mode === null) {
        return {};
    }

    if (typeof mode !== "string" || mode.length === 0 || mode.length > 64) {
        throw new Error("The mode is the name of a mode of the design system.");
    }

    const system = loadSystem(cwd);

    if (system === undefined) {
        throw new Error("A mode needs a design system: this project has none.");
    }

    const picked = modeFor(system, "light", mode);

    return { colorScheme: picked.scheme, theme: picked.theme };
}

function slideOf(value: unknown): number | "all" | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }

    if (
        value === "all" ||
        (Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 100)
    ) {
        return value as number | "all";
    }

    throw new Error('Slide must be a whole number from 1 to 100, or "all".');
}

/**
 * `POST c/:conversation/export` for the workspace: the same export as `design_export`, written in the session folder at its default
 * path. It answers `{ path, name, size }`; the browser downloads the file through the core file route.
 */
export function designRoutes(web: ExtensionWeb, host: PocketHost, deps: DesignToolDeps = {}): void {
    const loadSystem = deps.loadSystem ?? loadDesignSystem;

    web.conversationRoute(
        "POST",
        "c/:conversation/export",
        async (request) => {
            const body = request.body;
            const conversation = request.conversation.id;
            const cwd = request.conversation.cwd;

            const id = typeof body.id === "string" ? body.id : "";
            const format = typeof body.format === "string" ? body.format : "";
            const selectedVersion = body.version === undefined ? undefined : Number(body.version);
            const size = body.viewport as
                { width?: unknown; height?: unknown } | string | undefined;
            const viewport =
                typeof size === "string"
                    ? size
                    : typeof size === "object" && size !== null
                      ? { width: Number(size.width), height: Number(size.height) }
                      : "desktop";

            if (!Object.hasOwn(EXPORT_TYPES, format)) {
                throw web.error(400, "Choose png, pdf, pptx, or html.");
            }

            if (!cwd) {
                throw web.error(400, "This session has no folder for the export.");
            }

            try {
                viewportOf(viewport);
                const tweaks = tweakValues(body.tweaks);
                const slide = slideOf(body.slide);
                const bundle = await readBundle(
                    host,
                    request.snapshot,
                    conversation,
                    id,
                    selectedVersion,
                    request.context,
                );
                const saved = await saveDesignExport(
                    bundle,
                    {
                        id,
                        format: format as ExportFormat,
                        cwd,
                        viewport,
                        tweaks,
                        slide,
                        ...exportMode(loadSystem, cwd, body.mode),
                        signal: request.signal,
                    },
                    host,
                );

                return { ...saved, relative: `exports/${saved.name}` };
            } catch (error) {
                if (request.signal.aborted) {
                    throw error;
                }

                throw web.error(
                    400,
                    error instanceof Error ? error.message : "The design export failed.",
                );
            }
        },
        { conversation: "conversation", access: "steer" },
    );
}
