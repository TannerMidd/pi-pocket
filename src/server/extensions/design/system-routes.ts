/**
 * The System view's routes (`/api/x/design/c/:conversation/system…`): read the project's design system, write changes to
 * it, check a design against it, publish its documentation page as an artifact, and export it for code.
 */
import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import type { ConversationId, Tx } from "@earendil-works/pi-durable";
import { readBundle } from "../../design/bundle.ts";
import { writeExport } from "../../design/files.ts";
import { applyExactFixes } from "../../design/fix.ts";
import { VIEWPORTS } from "../../design/render.ts";
import { derived } from "../../design/tokens-cache.ts";
import type {
    CheckFinding,
    CheckReport,
    CheckRule,
    DesignSystem,
    SystemChange,
    SystemProblem,
} from "../../design/system-types.ts";
import { assetName, assetType } from "../../http/artifact-assets.ts";
import { zip } from "../../zip.ts";
import {
    ArtifactAssetDoc,
    ArtifactBodyDoc,
    type ArtifactAsset,
    ArtifactsDoc,
    type ArtifactVersion,
    DesignCommentsDoc,
} from "../../docs.ts";
import type { ConversationWebRequest, ExtensionWeb, PocketHost } from "../../host.ts";
import { MAX_ASSET_BYTES, MAX_ASSETS, MAX_ASSETS_BYTES, MAX_BYTES } from "../artifacts.ts";
import {
    type CheckOptions,
    checkDesign,
    fixExactMatches,
    loadDesignSystem,
    renderSystemDoc,
    writeDesignSystem,
} from "./system-api.ts";

export const LIMITS = {
    set: 500,
    value: 8192,
    guidelines: 16_384,
    modes: 8,
    findings: 300,
} as const;

const MODE_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const TOKEN_NAME = /^[A-Za-z0-9_-]{1,64}(?:\.[A-Za-z0-9_-]{1,64}){0,7}$/;
// Names that exist on every object: never a group or a token.
const INHERITED = new Set(["__proto__", "constructor", "prototype"]);
const KEY = /^[\w-]{8,64}$/;
const DESIGN_FILES = {
    "ds/tokens.css": "css",
    "ds/tailwind.css": "tailwind",
    "ds/components.css": "components",
} as const;

export const DOCS_ID = "design-system-docs";
const RULES: readonly CheckRule[] = [
    "off-system-color",
    "off-system-font",
    "off-system-size",
    "contrast",
    "tap-target",
    "overflow",
    "image-alt",
    "heading-order",
    "font-fallback",
    "missing-viewport",
    "missing-pid",
    "focus-visible",
    "reduced-motion",
    "missing-lang",
    "missing-main",
    "form-label",
    "accessible-name",
    "input-zoom",
];

type Errors = Pick<ExtensionWeb, "error">;
type Rect = { x: number; y: number; width: number; height: number };
type Prepared = { asset: ArtifactAsset; bytes: Buffer };

const tokenName = (name: string): boolean =>
    TOKEN_NAME.test(name) && !name.split(".").some((part) => INHERITED.has(part));

const clip = (value: unknown, max: number): string =>
    typeof value === "string" ? value.replace(/[\p{Cc}\p{Bidi_Control}]/gu, " ").slice(0, max) : "";

const coordinate = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value)
        ? Math.round(Math.max(-1e7, Math.min(1e7, value)) * 10) / 10
        : 0;

const rectOf = (rect: Rect | undefined): { rect?: Rect } =>
    typeof rect === "object" && rect !== null
        ? {
              rect: {
                  x: coordinate(rect.x),
                  y: coordinate(rect.y),
                  width: coordinate(rect.width),
                  height: coordinate(rect.height),
              },
          }
        : {};

const own = <T>(items: Record<string, T> | undefined, id: string): T | undefined =>
    items !== undefined && Object.hasOwn(items, id) ? items[id] : undefined;

const present = (files: (readonly [string, string | undefined])[]) =>
    files.filter((file): file is readonly [string, string] => file[1] !== undefined);

function cleanValue(web: Errors, value: unknown, depth = 0): unknown {
    if (typeof value === "string") {
        return clip(value, 500);
    }

    if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) {
        return value;
    }

    const entries =
        typeof value === "object" && value !== null && depth < 5
            ? Object.entries(value)
            : undefined;

    if (
        entries === undefined ||
        (Array.isArray(value) ? value : entries).length > 32 ||
        (!Array.isArray(value) && entries.some(([key]) => !/^[A-Za-z][\w-]{0,39}$/.test(key)))
    ) {
        throw web.error(400, "A token value is text, a number, a list, or a small object.");
    }

    return Array.isArray(value)
        ? value.map((each) => cleanValue(web, each, depth + 1))
        : Object.fromEntries(entries.map(([key, each]) => [key, cleanValue(web, each, depth + 1)]));
}

function listOf(web: Errors, list: unknown, message: string): unknown[] {
    if (!Array.isArray(list) || list.length > LIMITS.set) {
        throw web.error(400, message);
    }

    return list;
}

function tokenRef(web: Errors, each: unknown, message: string) {
    const entry = each as Record<string, unknown> | null;

    if (
        typeof entry !== "object" ||
        entry === null ||
        typeof entry.mode !== "string" ||
        !MODE_NAME.test(entry.mode) ||
        typeof entry.token !== "string" ||
        !tokenName(entry.token)
    ) {
        throw web.error(400, message);
    }

    return { mode: entry.mode, token: entry.token };
}

function cleanSetEntry(web: Errors, each: unknown) {
    const ref = tokenRef(web, each, "Each change names a mode and a token.");
    const value = cleanValue(web, (each as { value?: unknown }).value);

    if (JSON.stringify(value).length > LIMITS.value) {
        throw web.error(400, "That value is too large.");
    }

    return { ...ref, value };
}

function cleanModes(web: Errors, value: unknown): SystemChange["modes"] {
    const modes = value as Record<string, unknown> | null;

    if (typeof modes !== "object" || modes === null || Array.isArray(modes)) {
        throw web.error(400, "Modes are a set of names.");
    }

    if (Object.keys(modes).length > LIMITS.modes) {
        throw web.error(400, `A system has up to ${LIMITS.modes} modes.`);
    }

    const clean: Record<string, unknown> = {};

    for (const [name, each] of Object.entries(modes)) {
        if (!MODE_NAME.test(name)) {
            throw web.error(400, "A mode is named in lowercase letters, digits, and hyphens.");
        }

        if (
            each !== null &&
            (typeof each !== "object" || Array.isArray(each) || Object.keys(each).length > 0)
        ) {
            throw web.error(400, "A mode is added empty, or removed with null.");
        }

        clean[name] = each;
    }

    return clean;
}

export function cleanChange(web: Errors, body: Readonly<Record<string, unknown>>) {
    const change: SystemChange = {};

    for (const key of Object.keys(body)) {
        if (!["set", "remove", "modes", "guidelines", "baseRevision"].includes(key)) {
            throw web.error(400, `A save has no “${key.slice(0, 40)}”.`);
        }
    }

    if (body.set !== undefined) {
        const list = listOf(web, body.set, `A save changes up to ${LIMITS.set} tokens.`);

        change.set = list.map((each) => cleanSetEntry(web, each));
    }

    if (body.remove !== undefined) {
        const list = listOf(web, body.remove, `A save gives up to ${LIMITS.set} values back.`);

        change.remove = list.map((each) =>
            tokenRef(web, each, "Each removal names a mode and a token."),
        );
    }

    if (body.modes !== undefined) {
        change.modes = cleanModes(web, body.modes);
    }

    if (body.guidelines !== undefined) {
        if (typeof body.guidelines !== "string" || body.guidelines.length > LIMITS.guidelines) {
            throw web.error(400, `The guidelines are text up to ${LIMITS.guidelines} characters.`);
        }

        change.guidelines = body.guidelines.replace(/\r\n?/g, "\n").replace(/[^\P{Cc}\n\t]/gu, "");
    }

    if (
        body.baseRevision !== undefined &&
        (typeof body.baseRevision !== "string" || body.baseRevision.length > 64)
    ) {
        throw web.error(400, "The revision is text.");
    }

    if (Object.keys(change).length === 0) {
        throw web.error(400, "There is nothing to save.");
    }

    return { change, baseRevision: body.baseRevision as string | undefined };
}

function refuseUnknown(web: Errors, system: DesignSystem, change: SystemChange) {
    const { modes } = system;

    const knownMode = (mode: string) => {
        if (!modes.includes(mode)) {
            throw web.error(400, `There is no mode “${mode}”.`);
        }
    };

    // `{}` for a mode that is there would empty its file, and the default mode is the tokens file itself.
    for (const [mode, body] of Object.entries(change.modes ?? {})) {
        if (body === null && !modes.includes(mode)) {
            throw web.error(400, "There is no such mode.");
        }

        if (body === null && mode === modes[0]) {
            throw web.error(400, "The default mode is the tokens file: it cannot be removed.");
        }

        if (body !== null && modes.includes(mode)) {
            throw web.error(400, "There is a mode by that name.");
        }
    }

    // The engine would make a new token or mode file of a name that is not there.
    for (const entry of change.set ?? []) {
        knownMode(entry.mode);

        if (!system.tokens.some((token) => token.name === entry.token)) {
            throw web.error(400, `There is no token “${entry.token}”.`);
        }
    }

    // In the default mode a removal would delete the token, and the engine would take that as meant.
    for (const entry of change.remove ?? []) {
        knownMode(entry.mode);

        if (entry.mode === modes[0]) {
            throw web.error(
                400,
                "The default mode has the values: a token is not given back there.",
            );
        }

        if (!(system.overrides?.[entry.mode] ?? []).includes(entry.token)) {
            throw web.error(400, `The mode “${entry.mode}” does not set “${entry.token}” itself.`);
        }
    }
}

export function revisionOf(system: DesignSystem): string {
    const { modes, schemes, tokens, components, guidelines } = system;

    return derived(system, "revision", () =>
        createHash("sha256")
            .update(JSON.stringify([modes, schemes, tokens, components, guidelines]))
            .digest("hex")
            .slice(0, 16),
    );
}

function viewOf(system: DesignSystem) {
    const { compiled } = system;

    return {
        name: system.name,
        description: system.description,
        modes: system.modes,
        schemes: system.schemes,
        tokens: system.tokens,
        components: system.components,
        guidelines: system.guidelines,
        problems: system.problems,
        notes: system.notes,
        overrides: system.overrides,
        componentsCss: compiled.components,
        dist: Object.fromEntries(
            present([
                ["tokens.css", compiled.css],
                ["tailwind.css", compiled.tailwind],
                ["tokens.resolved.json", compiled.json],
                ["tokens.studio.json", compiled.studio],
                ["names.md", compiled.names],
                ["components.css", compiled.components],
            ]).map(([name, text]) => [name, Buffer.byteLength(text)]),
        ),
        revision: revisionOf(system),
    };
}

// A finding is marked as one a tap can fix only if the fix would change it: the same rule as the fix itself.
function onlyFixable(
    bundle: { content: string },
    system: DesignSystem | undefined,
    report: CheckReport,
    accepted: ReadonlySet<string>,
): CheckReport {
    if (system === undefined) {
        return report;
    }

    const open = report.findings.filter(
        (each) => each.fix !== undefined && !(each.id !== undefined && accepted.has(each.id)),
    );
    const skipped = new Set(
        applyExactFixes(bundle.content, open, system).skipped.map((each) => each.id),
    );

    return {
        ...report,
        findings: report.findings.map((each) => {
            const { fix: _fix, ...rest } = each;

            return each.fix !== undefined && skipped.has(each.id ?? "") ? rest : each;
        }),
    };
}

// The report holds text from the page: every field is cut to a fixed shape.
export function cleanReport(
    report: CheckReport,
    accepted: ReadonlySet<string> = new Set(),
): CheckReport & { accepted: CheckFinding[]; order: string[] } {
    const open: CheckFinding[] = [];
    const set: CheckFinding[] = [];
    const order: string[] = [];
    const listed = (value: unknown): unknown[] =>
        Array.isArray(value) ? value.slice(0, 2000) : [];
    const engines = (report as { accepted?: unknown } | undefined)?.accepted;

    for (const [each, apart] of [
        ...listed(report?.findings).map((one) => [one, false] as const),
        ...listed(engines).map((one) => [one, true] as const),
    ]) {
        const finding = cleanFinding(each as CheckFinding);

        if (finding === undefined) {
            continue;
        }

        if (finding.id !== undefined && order.length < LIMITS.findings * 2) {
            order.push(finding.id);
        }

        const into = apart || (finding.id !== undefined && accepted.has(finding.id)) ? set : open;

        if (into.length < LIMITS.findings) {
            into.push(finding);
        }
    }

    const byRule: Partial<Record<CheckRule, number>> = {};
    const left = report?.summary?.notJudged?.contrast;

    for (const each of open) {
        byRule[each.rule] = (byRule[each.rule] ?? 0) + 1;
    }

    return {
        order,
        viewport: {
            width: Math.round(coordinate(report?.viewport?.width)),
            height: Math.round(coordinate(report?.viewport?.height)),
        },
        colorScheme: report?.colorScheme === "dark" ? "dark" : "light",
        ...(typeof report?.mode === "string" && report.mode !== ""
            ? { mode: clip(report.mode, 64) }
            : {}),
        findings: open,
        accepted: set,
        summary: {
            errors: open.filter((each) => each.level === "error").length,
            warnings: open.filter((each) => each.level === "warning").length,
            elements: Math.max(0, Math.round(coordinate(report?.summary?.elements))),
            byRule,
            ...(set.length > 0 ? { accepted: set.length } : {}),
            ...(left !== undefined && coordinate(left.count) > 0
                ? {
                      notJudged: {
                          contrast: {
                              count: Math.round(coordinate(left.count)),
                              elements: (Array.isArray(left.elements) ? left.elements : [])
                                  .slice(0, 8)
                                  .map((one: unknown) => clip(one, 500)),
                          },
                      },
                  }
                : {}),
        },
        withoutSystem: report?.withoutSystem === true,
    };
}

function cleanFinding(each: CheckFinding): CheckFinding | undefined {
    if (!RULES.includes(each?.rule)) {
        return undefined;
    }

    const fix = each.fix;
    const fixable = (each as { fixable?: unknown }).fixable === true || fix !== undefined;

    return {
        ...(typeof each.id === "string" ? { id: clip(each.id, 60) } : {}),
        ...(Array.isArray(each.elements) && each.elements.length > 1
            ? {
                  elements: each.elements.slice(0, 12).map((item) => ({
                      selector: clip(item?.selector, 500),
                      ...(typeof item?.pid === "string" && item.pid !== ""
                          ? { pid: clip(item.pid, 200) }
                          : {}),
                      ...rectOf(item?.rect),
                  })),
              }
            : {}),
        ...(typeof fix === "object" &&
        fix !== null &&
        ["color", "length", "font"].includes(fix.kind) &&
        Array.isArray(fix.properties)
            ? {
                  fix: {
                      kind: fix.kind,
                      properties: fix.properties.slice(0, 20).map((one) => clip(one, 60)),
                      literal: clip(fix.literal, 300),
                      token: clip(fix.token, 200),
                      cssVar: clip(fix.cssVar, 200),
                      mode: clip(fix.mode, 64),
                  },
              }
            : {}),
        rule: each.rule,
        level: each.level === "error" ? "error" : "warning",
        selector: clip(each.selector, 500),
        ...(typeof each.pid === "string" && each.pid !== "" ? { pid: clip(each.pid, 200) } : {}),
        ...(typeof each.value === "string" ? { value: clip(each.value, 200) } : {}),
        ...(typeof each.suggestion === "string" ? { suggestion: clip(each.suggestion, 300) } : {}),
        message: clip(each.message, 400),
        ...(fixable ? { fixable: true } : {}),
        ...rectOf(each.rect),
    };
}

function legacySize(cwd: string): number | null {
    try {
        // Links are refused: only a plain folder and file count.
        const info = lstatSync(join(cwd, ".pi")).isDirectory()
            ? lstatSync(join(cwd, ".pi", "design-system.md"))
            : undefined;

        return info?.isFile() ? info.size : null;
    } catch {
        return null;
    }
}

// The engine's own message is written for Pi ("Fix them and call again"), so the problems are shown instead.
function refusal(error: unknown): { failed: string; problems: SystemProblem[] } {
    const list = (error as { problems?: unknown } | null)?.problems;
    const problems: SystemProblem[] = (Array.isArray(list) ? list : [])
        .slice(0, 20)
        .filter(
            (each) => typeof each === "object" && each !== null && typeof each.message === "string",
        )
        .map((each) => ({
            level: each.level === "warning" ? "warning" : "error",
            message: clip(each.message, 400),
            ...(typeof each.file === "string" ? { file: clip(each.file, 100) } : {}),
            ...(typeof each.token === "string" ? { token: clip(each.token, 200) } : {}),
        }));
    const failed =
        problems.length > 0
            ? `Not saved: ${problems
                  .slice(0, 3)
                  .map((each) => each.message.replace(/\s+/g, " ").trim())
                  .join(" ")}${problems.length > 3 ? ` (and ${problems.length - 3} more)` : ""}`
            : error instanceof Error
              ? clip(error.message, 600)
              : "The save failed.";

    return { failed: failed.slice(0, 900), problems };
}

function prepare(name: string, text: string): Prepared {
    const bytes = Buffer.from(text, "utf8");
    const hash = createHash("sha256").update(bytes).digest("hex");

    return { asset: { hash, size: bytes.length, type: assetType(name) }, bytes };
}

async function storeAsset(tx: Tx, { asset, bytes }: Prepared): Promise<void> {
    await tx.doc(ArtifactAssetDoc, asset.hash, { base64: bytes.toString("base64") });
}

async function storeBody(tx: Tx, conversation: ConversationId, name: string, content: string) {
    const body = await tx.doc(ArtifactBodyDoc, conversation, name, { content });

    if (body.content !== content) {
        body.content = content;
    }
}

export function systemRoutes(web: ExtensionWeb, host: PocketHost): void {
    const steer = { conversation: "conversation", access: "steer" } as const;

    // One save at a time for each folder: a save reads the revision and writes, and no other may come between.
    const queues = new Map<string, Promise<unknown>>();

    const exclusive = async <T>(cwd: string, work: () => Promise<T> | T): Promise<T> => {
        const before = queues.get(cwd) ?? Promise.resolve();
        const run = before.then(work, work);
        const tail = run.catch(() => undefined);

        queues.set(cwd, tail);
        void tail.then(() => queues.get(cwd) === tail && queues.delete(cwd));

        return run;
    };

    const folderOf = (request: ConversationWebRequest): string => {
        const cwd = request.conversation.cwd;

        if (!cwd) {
            throw web.error(400, "This session has no folder.");
        }

        return cwd;
    };

    const load = async (cwd: string): Promise<DesignSystem | undefined> => {
        try {
            return await loadDesignSystem(cwd);
        } catch (error) {
            throw web.error(
                400,
                error instanceof Error ? error.message : "The design system could not be read.",
            );
        }
    };

    const existing = (system: DesignSystem | undefined): DesignSystem => {
        if (system === undefined) {
            throw web.error(404, "There is no design system yet.");
        }

        return system;
    };

    const withoutErrors = (system: DesignSystem): DesignSystem => {
        if (system.problems.some((problem) => problem.level === "error")) {
            throw web.error(409, "Fix the errors in the design system first.");
        }

        return system;
    };

    const failure = (error: unknown, fallback: string) =>
        web.error(400, error instanceof Error ? error.message.slice(0, 300) : fallback);

    const keyOf = (request: ConversationWebRequest, message: string): string => {
        const key = request.body.key;

        if (typeof key !== "string" || !KEY.test(key)) {
            throw web.error(400, message);
        }

        return key;
    };

    web.conversationRoute(
        "GET",
        "c/:conversation/system",
        async (request) => {
            const cwd = folderOf(request);
            const system = await load(cwd);

            if (system === undefined) {
                return { system: null, legacy: legacySize(cwd) };
            }

            const revision = revisionOf(system);

            return request.query.get("revision") === revision
                ? { unchanged: true, revision }
                : { system: viewOf(system), legacy: null };
        },
        { conversation: "conversation", access: "view" },
    );

    web.conversationRoute(
        "POST",
        "c/:conversation/system",
        async (request) => {
            const { change, baseRevision } = cleanChange(web, request.body);
            const cwd = folderOf(request);

            const result = await exclusive(cwd, async () => {
                const current = existing(await load(cwd));

                if (baseRevision !== undefined && baseRevision !== revisionOf(current)) {
                    throw web.error(
                        409,
                        "The design system changed since you opened it. Load it again; your edits stay.",
                    );
                }

                refuseUnknown(web, current, change);

                try {
                    return { saved: await writeDesignSystem(cwd, change) };
                } catch (error) {
                    return refusal(error);
                }
            });

            if ("failed" in result) {
                return { ok: false, error: result.failed, problems: result.problems };
            }

            web.send("system", { conversation: request.conversation.id });

            return { ok: true, system: viewOf(result.saved), legacy: null };
        },
        steer,
    );

    const checkTarget = async (request: ConversationWebRequest) => {
        const id = typeof request.body.id === "string" ? request.body.id : "";
        const { version, colorScheme: scheme, mode } = request.body;
        const size = request.body.viewport ?? "mobile";

        if (version !== undefined && !Number.isSafeInteger(version)) {
            throw web.error(400, "Choose a version.");
        }

        if (scheme !== undefined && scheme !== "light" && scheme !== "dark") {
            throw web.error(400, "Choose light or dark.");
        }

        if (mode !== undefined && (typeof mode !== "string" || mode === "" || mode.length > 100)) {
            throw web.error(400, "Choose a mode of the design system.");
        }

        if (typeof size !== "string" || !Object.hasOwn(VIEWPORTS, size)) {
            throw web.error(400, "Choose mobile, tablet, or desktop.");
        }

        const system = await load(folderOf(request));

        if (mode !== undefined && system !== undefined && !system.modes.includes(mode)) {
            throw web.error(
                400,
                `The design system has no mode "${mode.slice(0, 40)}". Modes: ${system.modes.join(", ")}.`,
            );
        }

        const checked = system === undefined ? undefined : mode;
        const colorScheme =
            scheme ?? (checked === undefined ? undefined : system?.schemes[checked]);
        const options: CheckOptions = {
            viewport: VIEWPORTS[size as keyof typeof VIEWPORTS],
            ...(colorScheme === undefined ? {} : { colorScheme }),
            ...(checked === undefined ? {} : { mode: checked }),
        };

        return { id, version: version as number | undefined, options, system };
    };

    const runCheck = async (
        request: ConversationWebRequest,
        { id, version, options, system }: Awaited<ReturnType<typeof checkTarget>>,
    ) => {
        const conversation = request.conversation.id;
        const bundle = await readBundle(
            host,
            request.snapshot,
            conversation,
            id,
            version,
            request.context,
        );
        const doc = await request.snapshot(DesignCommentsDoc, conversation, request.context);
        const item = own(doc?.items, id);
        const accepted = new Set(Object.keys(item?.accepted ?? {}));
        const asked = { ...options, ...(accepted.size > 0 ? { accepted: [...accepted] } : {}) };
        const report = await checkDesign(bundle, system, asked, host, request.signal);

        return { bundle, accepted, report };
    };

    web.conversationRoute(
        "POST",
        "c/:conversation/system/check",
        async (request) => {
            const target = await checkTarget(request);

            try {
                const { bundle, accepted, report } = await runCheck(request, target);

                return {
                    report: cleanReport(
                        onlyFixable(bundle, target.system, report, accepted),
                        accepted,
                    ),
                    id: target.id,
                    version: bundle.version,
                };
            } catch (error) {
                if (request.signal.aborted) {
                    throw error;
                }

                throw failure(error, "The check failed.");
            }
        },
        steer,
    );

    // The key makes a repeat of the same tap find the version it made.
    web.conversationRoute(
        "POST",
        "c/:conversation/system/fix",
        async (request) => {
            const callId = `design-fix:${keyOf(request, "A fix needs a key.")}`;
            const target = await checkTarget(request);
            const { id } = target;
            const system = existing(target.system);
            const index = await request.snapshot(
                ArtifactsDoc,
                request.conversation.id,
                request.context,
            );
            const again = own(index?.items, id)?.versions.find((each) => each.callId === callId);

            if (again !== undefined) {
                return { id, version: again.version, fixed: 0, again: true };
            }

            withoutErrors(system);

            let result;

            try {
                const { bundle, accepted, report } = await runCheck(request, target);

                result = {
                    from: bundle.version,
                    ...fixExactMatches(bundle, system, report, accepted),
                };
            } catch (error) {
                if (request.signal.aborted || (error instanceof Error && "status" in error)) {
                    throw error;
                }

                throw failure(error, "The fix failed.");
            }

            if (result.fixed > 0 && Buffer.byteLength(result.content) > MAX_BYTES) {
                throw web.error(400, "The page is too large.");
            }

            if (result.fixed === 0) {
                throw web.error(
                    409,
                    "Nothing in this version is an exact match that one tap can fix.",
                );
            }

            const { content, from } = result;
            // The version's `ds/` files are a snapshot and may not define these tokens yet: the new version gets the current ones.
            const fresh = Object.entries(DESIGN_FILES).map(
                ([name, key]) => [name, prepare(name, system.compiled[key])] as const,
            );

            const made = await request.commit(async (tx) => {
                const items = await tx.doc(ArtifactsDoc, request.conversation.id);
                const current = own(items.items, id);

                if (current === undefined || current.type !== "html") {
                    throw web.error(404, "No such design.");
                }

                const done = current.versions.find((each) => each.callId === callId);

                if (done !== undefined) {
                    return done.version;
                }

                const original = current.versions.find((each) => each.version === from);

                if (original === undefined) {
                    throw web.error(404, "That version is not there.");
                }

                const next = current.versions.at(-1)!.version + 1;
                const { inline: _inline, ...copy } = original;
                const assets = { ...copy.assets };

                for (const [name, each] of fresh) {
                    if (Object.hasOwn(assets, name)) {
                        await storeAsset(tx, each);
                        assets[name] = each.asset;
                    }
                }

                current.versions.push({
                    ...copy,
                    ...(copy.assets === undefined ? {} : { assets }),
                    version: next,
                    callId,
                    size: Buffer.byteLength(content),
                    createdAt: Date.now(),
                });
                await storeBody(tx, request.conversation.id, `${id}@${next}`, content);

                return next;
            });

            return { id, version: made, fixed: result.fixed, fixes: result.fixes.slice(0, 20) };
        },
        steer,
    );

    // The key makes a repeat of the same tap find the version it made.
    web.conversationRoute(
        "POST",
        "c/:conversation/system/docs",
        async (request) => {
            const callId = `design-system-docs:${keyOf(request, "Publishing needs a key.")}`;
            const system = withoutErrors(existing(await load(folderOf(request))));
            const doc = renderSystemDoc(system);
            const prepared = new Map<string, Prepared>();
            let total = 0;

            if (Buffer.byteLength(doc.html) > MAX_BYTES) {
                throw web.error(400, "The documentation page is too large.");
            }

            if (doc.assets.length > MAX_ASSETS) {
                throw web.error(400, "The documentation page has too many files.");
            }

            for (const entry of doc.assets) {
                const each = prepare(entry.name, entry.content);

                total += each.bytes.length;

                if (
                    !assetName(entry.name) ||
                    prepared.has(entry.name) ||
                    each.bytes.length > MAX_ASSET_BYTES ||
                    total > MAX_ASSETS_BYTES
                ) {
                    throw web.error(400, "A file of the documentation page is not valid.");
                }

                prepared.set(entry.name, each);
            }

            const version = await request.commit(async (tx) => {
                const index = await tx.doc(ArtifactsDoc, request.conversation.id);
                const current = own(index.items, DOCS_ID);

                if (current !== undefined && current.type !== "html") {
                    throw web.error(409, `The artifact ${DOCS_ID} is not a page.`);
                }

                const again = current?.versions.find((each) => each.callId === callId);

                if (again !== undefined) {
                    return again.version;
                }

                for (const each of prepared.values()) {
                    await storeAsset(tx, each);
                }

                const next = (current?.versions.at(-1)?.version ?? 0) + 1;
                const assets = Object.fromEntries(
                    [...prepared].map(([name, each]) => [name, each.asset]),
                );
                const record = {
                    version: next,
                    taskId: 0,
                    callId,
                    size: Buffer.byteLength(doc.html),
                    createdAt: Date.now(),
                    ...(prepared.size > 0 ? { assets } : {}),
                } as unknown as ArtifactVersion;
                const title = `${system.name} design system`.slice(0, 100);

                if (current === undefined) {
                    index.items[DOCS_ID] = { title, type: "html", versions: [record] };
                } else {
                    current.title = title;
                    current.versions.push(record);
                }

                await storeBody(tx, request.conversation.id, `${DOCS_ID}@${next}`, doc.html);

                return next;
            });

            return { id: DOCS_ID, version };
        },
        steer,
    );

    web.conversationRoute(
        "POST",
        "c/:conversation/system/export",
        async (request) => {
            const cwd = folderOf(request);
            const system = withoutErrors(existing(await load(cwd)));
            const { compiled } = system;
            const slug =
                system.name
                    .toLowerCase()
                    .replace(/[^a-z0-9]+/g, "-")
                    .replace(/^-+|-+$/g, "")
                    .slice(0, 40) || "design-system";
            const name = `${slug}-tokens.zip`;
            const files = present([
                ["tokens.css", compiled.css],
                ["tailwind.css", compiled.tailwind],
                ...Object.entries(compiled.modes ?? {}).map(
                    ([mode, text]) => [`tokens.${mode}.resolved.json`, text] as const,
                ),
                ["tokens.studio.json", compiled.studio],
                ["names.md", compiled.names],
                ["tokens.resolved.json", compiled.json],
                ["components.css", compiled.components],
            ]);

            try {
                const bytes = zip(
                    files.map(([file, text]) => ({ name: file, bytes: Buffer.from(text) })),
                );
                const path = await writeExport(cwd, `exports/${name}`, bytes);

                return { path, relative: `exports/${name}`, name, size: bytes.length };
            } catch (error) {
                throw failure(error, "The export failed.");
            }
        },
        steer,
    );
}
