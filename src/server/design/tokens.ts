import { readdirSync } from "node:fs";
import { join } from "node:path";
import { defang } from "../fence.ts";
import type { DesignSystem, SystemChange, SystemProblem } from "./system-types.ts";
import { SLUG } from "./components.ts";
import { type Folder, DESIGN_DIR, emptyFolder, readFolder, writeFiles } from "./tokens-io.ts";
import {
    EXT,
    LIMITS,
    MODE_NAME,
    NAME,
    RESERVED,
    TOKEN_TYPES,
    extensionOf,
    isObject,
    type Obj,
} from "./tokens-base.ts";
import { buildSystem, inferType } from "./tokens-model.ts";
import { cachedSystem, derived } from "./tokens-cache.ts";
import { systemSummary as summaryOf } from "./tokens-summary.ts";

export { compileDesignSystem, scaleOf, tailwindNames, type Scale } from "./tokens-compile.ts";
export { DESIGN_DIR };

export class DesignSystemError extends Error {
    problems: SystemProblem[];

    constructor(message: string, problems: SystemProblem[] = []) {
        super(message);
        this.name = "DesignSystemError";
        this.problems = problems;
    }
}

export function problemLine(problem: SystemProblem): string {
    const where = [problem.file, problem.token].filter((part) => part !== undefined).join(" › ");

    // The message can quote project text: no closing tag survives in it.
    return defang(
        `${problem.level}: ${where === "" ? "" : `${where}: `}${problem.message}${problem.fix === undefined ? "" : ` Fix: ${problem.fix}`}`,
    );
}

/** The system is frozen and shared: a caller that needs to change it must copy it. */
export function loadDesignSystem(cwd: string): DesignSystem | undefined {
    return cachedSystem(cwd, () => {
        const folder = readFolder(cwd);

        return folder === undefined ? undefined : buildSystem(folder.raw);
    });
}

export function systemSummary(system: DesignSystem, maxBytes: number): string {
    return derived(system, `summary:${maxBytes}`, () => summaryOf(system, maxBytes));
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

function defaultModeOf(folder: Folder): string {
    return defaultModeName(folder.raw.tokens);
}

export function defaultModeName(tokens: unknown): string {
    const mode = isObject(tokens) ? extensionOf(tokens).mode : undefined;

    return typeof mode === "string" && MODE_NAME.test(mode) ? mode : "light";
}

function tokenPath(name: unknown): string[] {
    if (typeof name !== "string" || name.trim() === "") {
        throw new DesignSystemError('A token name is a dotted path such as "color.bg.surface".');
    }

    const path = name
        .trim()
        .replace(/^\{|\}$/g, "")
        .split(".");

    for (const key of path) {
        if (!NAME.test(key) || RESERVED.has(key)) {
            throw new DesignSystemError(
                `The token name "${name.slice(0, 60)}" must be groups and a name joined by dots, each of letters, digits, "-" or "_" (such as "color.bg.surface").`,
            );
        }
    }

    return path;
}

const hasValue = (node: Obj) => Object.hasOwn(node, "$value");

function groupFor(
    tree: Obj,
    path: string[],
    create: boolean,
): { group: Obj; type?: string } | undefined {
    let node = tree;
    let type = typeof tree.$type === "string" ? tree.$type : undefined;

    for (const [at, key] of path.slice(0, -1).entries()) {
        let child = Object.hasOwn(node, key) ? node[key] : undefined;

        if (child === undefined) {
            if (!create) {
                return undefined;
            }

            child = {};
            node[key] = child;
        }

        if (!isObject(child) || hasValue(child)) {
            throw new DesignSystemError(
                `"${path.slice(0, at + 1).join(".")}" is a token, so it cannot hold "${path.slice(at + 1).join(".")}". Choose another name.`,
            );
        }

        if (typeof child.$type === "string") {
            type = child.$type;
        }

        node = child;
    }

    return { group: node, ...(type === undefined ? {} : { type }) };
}

function setToken(
    tree: Obj,
    entry: NonNullable<SystemChange["set"]>[number],
    isDefault: boolean,
): void {
    const path = tokenPath(entry.token);
    const found = groupFor(tree, path, true)!;
    const key = path.at(-1)!;
    const existing = Object.hasOwn(found.group, key) ? found.group[key] : undefined;
    const whole = isObject(entry.value) && hasValue(entry.value);

    if (entry.value === undefined) {
        throw new DesignSystemError(`set "${entry.token}" needs a value.`);
    }

    if (isObject(existing) && !hasValue(existing)) {
        throw new DesignSystemError(
            `"${entry.token}" is a group, not a token. Set a token inside it, such as "${entry.token}.default".`,
        );
    }

    if (isObject(existing)) {
        if (whole) {
            Object.assign(existing, entry.value);
        } else {
            existing.$value = entry.value;
        }
    } else {
        const node: Obj = whole ? { ...(entry.value as Obj) } : { $value: entry.value };

        if (isDefault && node.$type === undefined) {
            const type = entry.type ?? found.type ?? inferType(node.$value);

            if (type === undefined) {
                throw new DesignSystemError(
                    `"${entry.token}" is new, so it needs a type. Add "type": one of ${TOKEN_TYPES.join(", ")}.`,
                );
            }

            if (entry.type !== undefined || found.type === undefined) {
                node.$type = type;
            }
        }

        found.group[key] = node;
    }

    const node = found.group[key] as Obj;

    if (entry.type !== undefined) {
        node.$type = entry.type;
    }

    if (entry.description !== undefined) {
        if (entry.description === "") {
            delete node.$description;
        } else {
            node.$description = entry.description;
        }
    }
}

function removeToken(tree: Obj, name: string): boolean {
    const path = tokenPath(name);
    const chain: Obj[] = [tree];
    let node = tree;

    for (const key of path.slice(0, -1)) {
        const child = Object.hasOwn(node, key) ? node[key] : undefined;

        if (!isObject(child)) {
            return false;
        }

        chain.push(child);
        node = child;
    }

    const key = path.at(-1)!;

    if (!Object.hasOwn(node, key)) {
        return false;
    }

    delete node[key];

    for (let at = chain.length - 1; at > 0; at--) {
        const group = chain[at]!;
        const empty =
            !Object.keys(group).some((each) => !each.startsWith("$")) &&
            group.$description === undefined;

        if (!empty) {
            break;
        }

        delete chain[at - 1]![path[at - 1]!];
    }

    return true;
}

function applyChange(
    folder: Folder,
    change: SystemChange,
): { raw: Folder["raw"]; dirty: Set<string>; removed: Set<string> } {
    const raw: Folder["raw"] = {
        ...folder.raw,
        tokens: structuredClone(folder.raw.tokens),
        modes: new Map(structuredClone([...folder.raw.modes])),
        components: new Map(folder.raw.components),
        // The read problems of a file the change replaces go away with the file.
        problems: [...folder.raw.problems],
    };
    const dirty = new Set<string>();
    const removed = new Set<string>();

    const clearProblems = (file: string) => {
        raw.problems = raw.problems.filter((problem) => problem.file !== file);
    };

    const guard = (file: string) => {
        if (folder.broken.has(file) && !dirty.has(file)) {
            throw new DesignSystemError(
                `${file} exists but could not be read, so a change to a single token would replace it. Fix the file, or replace it whole (init, or the tokens field).`,
            );
        }
    };

    const root = (): Obj => {
        if (!isObject(raw.tokens)) {
            raw.tokens = {};
        }

        return raw.tokens as Obj;
    };

    if (change.tokens !== undefined) {
        if (!isObject(change.tokens)) {
            throw new DesignSystemError(
                "tokens must be one DTCG object: groups and tokens with $value.",
            );
        }

        raw.tokens = structuredClone(change.tokens);
        dirty.add("tokens.json");
        clearProblems("tokens.json");
    }

    const base = defaultModeOf({ ...folder, raw });

    for (const [mode, value] of Object.entries(change.modes ?? {})) {
        if (!MODE_NAME.test(mode) || mode === base) {
            throw new DesignSystemError(
                mode === base
                    ? `"${mode}" is the default mode: its values are in tokens.json, not a mode file.`
                    : `The mode name "${mode.slice(0, 30)}" must be lowercase letters, digits, and hyphens (such as "dark").`,
            );
        }

        const file = `tokens.${mode}.json`;

        if (value === null) {
            raw.modes.delete(mode);
            removed.add(file);
        } else if (isObject(value)) {
            raw.modes.set(mode, structuredClone(value));
            dirty.add(file);
            removed.delete(file);
        } else {
            throw new DesignSystemError(
                `modes.${mode} must be one DTCG object with the tokens that change, or null to remove the mode.`,
            );
        }

        clearProblems(file);
    }

    if (change.name !== undefined || change.description !== undefined) {
        guard("tokens.json");

        const top = root();

        if (change.name !== undefined) {
            const extensions = isObject(top.$extensions) ? top.$extensions : {};
            const ext = isObject(extensions[EXT]) ? extensions[EXT] : {};

            ext.name = change.name.trim().slice(0, 80);
            extensions[EXT] = ext;
            top.$extensions = extensions;
        }

        if (change.description !== undefined) {
            top.$description = change.description.trim().slice(0, 300);
        }

        dirty.add("tokens.json");
    }

    for (const entry of change.set ?? []) {
        const isDefault = entry.mode === base;

        if (!isDefault && !MODE_NAME.test(entry.mode)) {
            throw new DesignSystemError(
                `The mode "${String(entry.mode).slice(0, 30)}" must be "${base}" (the default) or a lowercase name such as "dark".`,
            );
        }

        const file = isDefault ? "tokens.json" : `tokens.${entry.mode}.json`;

        guard(file);

        let tree: Obj;

        if (isDefault) {
            tree = root();
        } else {
            const current = raw.modes.get(entry.mode);

            tree = isObject(current) ? current : {};
            raw.modes.set(entry.mode, tree);
            removed.delete(file);
        }

        setToken(tree, entry, isDefault);
        dirty.add(file);
    }

    for (const entry of change.remove ?? []) {
        const isDefault = entry.mode === base;
        const file = isDefault ? "tokens.json" : `tokens.${entry.mode}.json`;

        guard(file);

        const tree = isDefault ? raw.tokens : raw.modes.get(entry.mode);

        if (!isObject(tree) || !removeToken(tree, entry.token)) {
            throw new DesignSystemError(`remove: "${entry.token}" is not in ${file}.`);
        }

        dirty.add(file);
    }

    for (const [slug, html] of Object.entries(change.components ?? {})) {
        if (!SLUG.test(slug)) {
            throw new DesignSystemError(
                `The component name "${slug.slice(0, 30)}" must be lowercase letters, digits, and hyphens (such as "button").`,
            );
        }

        const file = `components/${slug}.html`;

        if (html === null) {
            raw.components.delete(slug);
            removed.add(file);
        } else if (typeof html !== "string") {
            throw new DesignSystemError(
                `components.${slug} must be the specimen's HTML text, or null to remove it.`,
            );
        } else if (Buffer.byteLength(html) > LIMITS.componentBytes) {
            throw new DesignSystemError(
                `components.${slug} is larger than ${LIMITS.componentBytes / 1024} KB. Keep a specimen small.`,
            );
        } else {
            raw.components.set(slug, html);
            dirty.add(file);
            removed.delete(file);
        }

        clearProblems(file);
    }

    if (change.guidelines !== undefined) {
        if (Buffer.byteLength(change.guidelines) > LIMITS.guidelinesBytes) {
            throw new DesignSystemError(
                `guidelines.md is bounded text: ${LIMITS.guidelinesBytes / 1024} KB at most. Shorten it: rules a designer can apply, not a manual.`,
            );
        }

        raw.guidelines = change.guidelines;
        clearProblems("guidelines.md");

        if (change.guidelines.trim() === "") {
            removed.add("guidelines.md");
        } else {
            dirty.add("guidelines.md");
            removed.delete("guidelines.md");
        }
    }

    return { raw, dirty, removed };
}

function staleResolved(cwd: string, modes: string[]): string[] {
    try {
        return readdirSync(join(cwd, DESIGN_DIR, "dist"))
            .map((name) => /^tokens\.([a-z0-9]+(?:-[a-z0-9]+)*)\.resolved\.json$/.exec(name))
            .filter(
                (found): found is RegExpExecArray => found !== null && !modes.includes(found[1]!),
            )
            .map((found) => `dist/${found[0]}`);
    } catch {
        return [];
    }
}

const SUGGESTION = [
    /^("[^"]*" is not in tokens\.json, so it has no default value\.) (?:Add it to tokens\.json first\.|Did you mean "[^"]*"\?)$/,
    /^(The reference \{[^]*\} does not exist\.) Did you mean \{[^{}]*\}\?$/,
];

/** The problems as one key each, to tell which an edit adds. A suggestion is optional, so it is no part of the key. */
const keyOf = (problem: SystemProblem) => {
    let message = problem.message;

    for (const shape of SUGGESTION) {
        message = message.replace(shape, "$1");
    }

    return `${problem.file ?? ""}|${problem.token ?? ""}|${message}`;
};

// Errors that were already there do not stop a write, so a project with one broken token can still be repaired step by step.
export function writeDesignSystem(cwd: string, change: SystemChange): DesignSystem {
    const folder = readFolder(cwd) ?? emptyFolder(cwd);
    const before = new Set(
        buildSystem(folder.raw)
            .problems.filter((problem) => problem.level === "error")
            .map(keyOf),
    );
    const { raw, dirty, removed } = applyChange(folder, change);
    const system = buildSystem(raw);
    const added = system.problems.filter(
        (problem) => problem.level === "error" && !before.has(keyOf(problem)),
    );

    if (added.length > 0) {
        throw new DesignSystemError(
            `Nothing was written: the change has ${added.length} error${added.length === 1 ? "" : "s"}.\n${added
                .slice(0, 8)
                .map((problem) => `- ${problemLine(problem)}`)
                .join(
                    "\n",
                )}${added.length > 8 ? `\n- … and ${added.length - 8} more` : ""}\nFix ${added.length === 1 ? "it" : "them"} and call again.`,
            added,
        );
    }

    const files = new Map<string, string | null>();

    if (dirty.has("tokens.json")) {
        files.set("tokens.json", json(raw.tokens));
    }

    for (const mode of raw.modes.keys()) {
        if (dirty.has(`tokens.${mode}.json`)) {
            files.set(`tokens.${mode}.json`, json(raw.modes.get(mode)));
        }
    }

    for (const slug of raw.components.keys()) {
        if (dirty.has(`components/${slug}.html`)) {
            files.set(`components/${slug}.html`, raw.components.get(slug)!);
        }
    }

    if (dirty.has("guidelines.md")) {
        files.set("guidelines.md", raw.guidelines);
    }

    for (const file of removed) {
        files.set(file, null);
    }

    files.set("dist/tokens.css", system.compiled.css);
    files.set("dist/tailwind.css", system.compiled.tailwind);
    files.set("dist/tokens.resolved.json", system.compiled.json);
    files.set("dist/components.css", system.compiled.components);

    if (system.compiled.names !== undefined) {
        files.set("dist/names.md", system.compiled.names);
    }

    if (system.compiled.studio !== undefined) {
        files.set("dist/tokens.studio.json", system.compiled.studio);
    }

    for (const [mode, text] of Object.entries(system.compiled.modes ?? {})) {
        files.set(`dist/tokens.${mode}.resolved.json`, text);
    }

    for (const name of staleResolved(cwd, Object.keys(system.compiled.modes ?? {}))) {
        files.set(name, null);
    }

    writeFiles(cwd, files);

    return system;
}
