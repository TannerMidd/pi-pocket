/**
 * The extension gallery's index, read strictly: everything in it comes from elsewhere. An index is one JSON file (the
 * index repository's generated `index.json`): its format, and an entry for each extension, which names the files of
 * one drop-in at a pinned commit of a GitHub repository, with each file's SHA-256, and what the module installs. An
 * entry with `kind: "theme"` names a theme folder's files the same way, and declares nothing: a Pi Pocket before
 * 0.14.0 reads it as not valid (it has a field that one does not know), so never installs it as an extension.
 *
 * Pi Pocket reads it here, and the index repository's checks use these same functions, so an entry they let in is one
 * Pi Pocket reads (they import this file from a Pi Pocket checkout, the loader's lists of reserved names with it). Text
 * is kept to one plain line (no control, invisible, or direction characters), names to the drop-in folder's rules, and
 * sizes to `LIMITS`.
 */
import { createHash } from "node:crypto";
import { BUILT_IN_COMMANDS } from "../extension-web.ts";
import { INVISIBLE_CLASS } from "../fence.ts";
import { BUILT_IN_MODULES, BUILT_IN_TOOLS, RESERVED_EXTENSIONS } from "../reload.ts";
import { assetType, THEME_API, THEME_ID, THEME_LIMITS } from "../themes/format.ts";
import { reservedThemeIds } from "../themes/reserved.ts";
import { atLeast, POCKET_VERSION, versionParts } from "../versions.ts";

// Where they always were: the index repository's checks import them from here.
export { atLeast, versionParts };

/** The index format this Pi Pocket reads. */
export const INDEX_FORMAT = 1;

/** How much Pi Pocket reads from the index and from an extension's repository. */
export const LIMITS = {
    /** The index, in bytes. */
    index: 4 * 1024 * 1024,
    /** Entries in the index. */
    entries: 2000,
    /** Files of one extension. */
    files: 50,
    /** One file, in bytes. */
    file: 512 * 1024,
    /** All of one extension's files, in bytes. */
    total: 2 * 1024 * 1024,
} as const;

/** Who may use what a module adds to the app (`WebAccess`). */
export type Access = "owner" | "steer" | "view";

const ACCESS: readonly Access[] = ["owner", "steer", "view"];

/** What a module installs, as its entry declares it and as the loader reports it (`ExtensionInfo`). */
export interface Declares {
    /** The extensions' names. */
    extensions: string[];
    tools: string[];
    /** The tools that say they only read (`readOnlyHint`): plan mode lets them run. */
    readOnlyTools: string[];
    /** The hooks' handlers: `beforeTool`, `onYield`, … */
    hooks: string[];
    /** Prompt sections' keys. */
    sections: string[];
    /** Tools and sections it wraps: `tool bash`, `section memory`. */
    wraps: string[];
    /** Routes it adds to the app: `GET status`. */
    routes: string[];
    /** Who loads its browser module, or null for none. */
    client: Access | null;
    /** The widest access of its routes and browser module: `owner` when it adds nothing to the app. */
    access: Access;
    /**
     * Its slash commands, each with who may run it, as a route has its method: `conversation clock-zone` (anyone who
     * can steer the session), `global clock-reset` (the owner). Left out when it has none, so older Pi Pockets read it.
     */
    commands?: string[];
}

export interface EntryFile {
    /** Where it goes in the drop-in folder, and where it is in the repository (under `source.path`). */
    name: string;
    sha256: string;
    size: number;
}

export interface Entry {
    /** The module's name: its file is `<name>.ts`. */
    name: string;
    title: string;
    description: string;
    tags: string[];
    author: { name: string; github?: string };
    /** The author's version, for people: the commit is what counts. */
    version: string;
    /** A GitHub repository (`owner/name`), the commit the files are pinned to, and the folder in it they are in. */
    source: { repo: string; commit: string; path: string };
    files: EntryFile[];
    /** The extension API version it needs (`POCKET_API`). */
    pocketApi: number;
    /** The oldest Pi Pocket it works with: `0.14.0`. */
    minPocket: string;
    declares: Declares;
    /** Commits of it that must not be used: Pi Pocket warns where one is installed. */
    revoked: { commit: string; reason: string }[];
}

/**
 * A theme's entry (`kind: "theme"`): a theme folder (`themes/format.ts`) at a pinned commit, installed into the data
 * folder's `themes/<name>/`. It runs no code, so it declares nothing.
 */
export interface ThemeEntry {
    kind: "theme";
    /** The theme's id: its folder's name, which its files are in (`<name>/theme.css`). */
    name: string;
    title: string;
    description: string;
    tags: string[];
    author: { name: string; github?: string };
    version: string;
    source: { repo: string; commit: string; path: string };
    files: EntryFile[];
    /** The theme surface's version it needs (`THEME_API`). */
    themeApi: number;
    minPocket: string;
    revoked: { commit: string; reason: string }[];
}

export interface Index {
    name?: string;
    /** The index's repository on GitHub, where entries are submitted. */
    repo?: string;
    /** The extensions' entries. */
    entries: Entry[];
    /** The themes' entries. */
    themes: ThemeEntry[];
    /** Entries for a newer Pi Pocket, or a newer extension API. */
    incompatible: number;
    /** Entries that are not valid, or repeat a name, with why. */
    invalid: { name?: string; problem: string }[];
    /**
     * Each name's revoked commits, from every entry whose `revoked` can be read: also one for a newer Pi Pocket, or one
     * not valid otherwise, as a revocation is a warning for whoever has that commit, whatever else the entry says.
     */
    revoked: Map<string, Entry["revoked"]>;
    /** The names of the entries for a newer Pi Pocket or extension API. */
    newer: Set<string>;
}

/** Why something in the index is not valid. */
export class EntryError extends Error {}

/** The kinds of entry this Pi Pocket reads: an entry with no `kind` is an extension's. Others are for a newer one. */
const KINDS = ["extension", "theme"];

// ─── Names ─────────────────────────────────────────────────────────────────────────

/** An extension's name in the index: its module's file name, lowercase, as a module that adds to the app needs. */
export const NAME = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
/** One part of a path in an extension's folder: no hidden files, no `.` or `..`. */
const PART = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;
/**
 * Names Windows keeps for devices, with any ending (`nul.js`), and names that end in a dot, which Windows reads as the
 * name without it: on Windows each is another file than it says, or none.
 */
const NOT_PORTABLE =
    /^(con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])(\..*)?$|\.$/i;
const TAG = /^[a-z0-9][a-z0-9-]{0,23}$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/;
const TOOL = /^[A-Za-z0-9_-]{1,64}$/;
const KEY = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const HOOK = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const WRAP = /^(tool|section) [A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const ROUTE = /^(GET|POST|PUT|PATCH|DELETE) [A-Za-z0-9._~:/-]{1,200}$/;
/** A command's scope and name: the name has a `-`, as no built-in command's does. */
const COMMAND = /^(conversation|global) [a-z][a-z0-9_]*-[a-z0-9_-]*$/;
/**
 * Controls, line breaks, and characters that show as nothing or reorder text (zero-width, bidi, tags: `fence.ts`'s
 * `INVISIBLE_CLASS`, which keeps them out of memory lessons too): none of them belong in what the gallery draws.
 */
const UNSAFE = new RegExp(`[\\p{Zl}\\p{Zp}${INVISIBLE_CLASS}]`, "u");
const UNSAFE_ALL = new RegExp(UNSAFE.source, "gu");

/**
 * Why a file name is not one an extension called `extension` may have, or undefined when it may: its module
 * (`<name>.ts`), a browser module beside it (`<name>.js`, `<name>.mjs`), or anything in its own folder (`<name>/…`, at
 * most four folders deep, with no hidden files and no `node_modules`). So an extension's files never reach past the
 * drop-in folder, nor another extension's files.
 */
export function fileProblem(file: string, extension: string): string | undefined {
    if (typeof file !== "string" || file.length > 200) {
        return "is not a file name of 200 characters at most";
    }

    if (NOT_PORTABLE.test(extension)) {
        return `is not a name every system can keep: ${extension} is a device on Windows`;
    }

    if ([`${extension}.ts`, `${extension}.js`, `${extension}.mjs`].includes(file)) {
        return undefined;
    }

    const parts = file.split("/");

    if (parts[0] !== extension || parts.length < 2) {
        return `is not ${extension}.ts, ${extension}.js, ${extension}.mjs, or in the folder ${extension}/`;
    }

    if (parts.length > 5) {
        return "is more than four folders deep";
    }

    for (const part of parts.slice(1)) {
        if (!PART.test(part) || part === "node_modules") {
            return `has the part ${JSON.stringify(part)}: use letters, digits, . _ and -, not starting with a dot`;
        }

        if (NOT_PORTABLE.test(part)) {
            return `has the part ${JSON.stringify(part)}, which Windows reads as another name`;
        }
    }

    return undefined;
}

/**
 * Why a file name is not one a theme called `theme` may have, or undefined when it may: in its own folder (`<theme>/…`,
 * at most four folders deep), and one the theme format serves: `theme.json`, `colors.toml`, and `colors-light.toml` at
 * its top, stylesheets, `.woff2` fonts, and images. So a theme's files never reach past its folder in `themes/`.
 */
export function themeFileProblem(file: string, theme: string): string | undefined {
    if (typeof file !== "string" || file.length > 200) {
        return "is not a file name of 200 characters at most";
    }

    const parts = file.split("/");

    if (parts[0] !== theme || parts.length < 2) {
        return `is not in the folder ${theme}/`;
    }

    if (parts.length > THEME_LIMITS.depth + 2) {
        return `is more than ${THEME_LIMITS.depth} folders deep`;
    }

    for (const part of parts.slice(1)) {
        if (!PART.test(part) || part === "node_modules") {
            return `has the part ${JSON.stringify(part)}: use letters, digits, . _ and -, not starting with a dot`;
        }

        if (NOT_PORTABLE.test(part)) {
            return `has the part ${JSON.stringify(part)}, which Windows reads as another name`;
        }
    }

    const inner = parts.slice(1).join("/");

    if (
        SMALL_FILES.includes(inner) ||
        inner.toLowerCase().endsWith(".css") ||
        assetType(inner) !== undefined
    ) {
        return undefined;
    }

    return "is not a file a theme serves: theme.json, colors.toml, colors-light.toml, .css, .woff2, or an image (.png, .jpg, .webp, .avif, .gif, .svg)";
}

/** The files at the top of a theme's folder that say what it is: each is `THEME_LIMITS.small` at most. */
const SMALL_FILES = ["theme.json", "colors.toml", "colors-light.toml"];

// ─── Reading ───────────────────────────────────────────────────────────────────────

type Shape = Record<string, unknown>;

function object(value: unknown, where: string, required: string[], optional: string[] = []): Shape {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new EntryError(`${where} is not an object`);
    }

    for (const key of Object.keys(value)) {
        if (!required.includes(key) && !optional.includes(key)) {
            throw new EntryError(`${where} has an unknown field ${JSON.stringify(key)}`);
        }
    }

    for (const key of required) {
        if (!(key in value)) {
            throw new EntryError(`${where} has no ${key}`);
        }
    }

    return value as Shape;
}

/** One line of plain text: trimmed, at most `max` characters, nothing hidden in it, and matching `pattern`. */
function text(value: unknown, where: string, max: number, pattern?: RegExp): string {
    if (typeof value !== "string" || value.length === 0 || value.length > max) {
        throw new EntryError(`${where} is not text of 1 to ${max} characters`);
    }

    if (UNSAFE.test(value) || value.trim() !== value) {
        throw new EntryError(
            `${where} has spaces at an end, or control or invisible characters in it`,
        );
    }

    if (pattern !== undefined && !pattern.test(value)) {
        throw new EntryError(`${where} is not in the right form: ${JSON.stringify(value)}`);
    }

    return value;
}

function list<T>(
    value: unknown,
    where: string,
    max: number,
    each: (item: unknown, at: string) => T,
): T[] {
    if (!Array.isArray(value) || value.length > max) {
        throw new EntryError(`${where} is not a list of ${max} at most`);
    }

    const items = value.map((item, at) => each(item, `${where}[${at}]`));
    const seen = new Set<string>();

    for (const item of items) {
        const key = JSON.stringify(item);

        if (seen.has(key)) {
            throw new EntryError(`${where} has ${key} twice`);
        }

        seen.add(key);
    }

    return items;
}

function names(value: unknown, where: string, pattern: RegExp): string[] {
    return list(value, where, 100, (item, at) => text(item, at, 210, pattern));
}

function access(value: unknown, where: string): Access {
    if (!ACCESS.includes(value as Access)) {
        throw new EntryError(`${where} is not "owner", "steer", or "view"`);
    }

    return value as Access;
}

function declares(value: unknown, where: string): Declares {
    const shape = object(
        value,
        where,
        [
            "extensions",
            "tools",
            "readOnlyTools",
            "hooks",
            "sections",
            "wraps",
            "routes",
            "client",
            "access",
        ],
        ["commands"],
    );
    const result: Declares = {
        extensions: names(shape.extensions, `${where}.extensions`, KEY),
        tools: names(shape.tools, `${where}.tools`, TOOL),
        readOnlyTools: names(shape.readOnlyTools, `${where}.readOnlyTools`, TOOL),
        hooks: names(shape.hooks, `${where}.hooks`, HOOK),
        sections: names(shape.sections, `${where}.sections`, KEY),
        wraps: names(shape.wraps, `${where}.wraps`, WRAP),
        routes: names(shape.routes, `${where}.routes`, ROUTE),
        client: shape.client === null ? null : access(shape.client, `${where}.client`),
        access: access(shape.access, `${where}.access`),
        ...(shape.commands === undefined
            ? {}
            : { commands: names(shape.commands, `${where}.commands`, COMMAND) }),
    };

    for (const command of result.commands ?? []) {
        if (command.length > 80 || BUILT_IN_COMMANDS.has(command.split(" ")[1]!)) {
            throw new EntryError(`${where}.commands has ${command}, a command of Pi Pocket's own`);
        }
    }

    for (const tool of result.readOnlyTools) {
        if (!result.tools.includes(tool)) {
            throw new EntryError(`${where}.readOnlyTools has ${tool}, which is not in its tools`);
        }
    }

    const widest = (each: Access) => ACCESS.indexOf(each);

    if (result.client !== null && widest(result.client) > widest(result.access)) {
        throw new EntryError(`${where}.access is narrower than its browser module's`);
    }

    if (result.client === null && result.routes.length === 0 && result.access !== "owner") {
        throw new EntryError(
            `${where}.access is wider than "owner", but it adds nothing to the app`,
        );
    }

    for (const name of result.extensions) {
        if (RESERVED_EXTENSIONS.test(name)) {
            throw new EntryError(
                `${where}.extensions has ${name}, a name Pi Pocket keeps for itself`,
            );
        }
    }

    for (const tool of result.tools) {
        if (BUILT_IN_TOOLS.has(tool)) {
            throw new EntryError(`${where}.tools has ${tool}, a built-in tool's name`);
        }
    }

    return result;
}

/** What every kind of entry has besides its name and files: who made it, which version, and where its files are. */
function common(shape: Shape) {
    const author = object(shape.author, "author", ["name"], ["github"]);
    const source = object(shape.source, "source", ["repo", "commit"], ["path"]);
    const repo = text(source.repo, "source.repo", 140);

    if (!isRepo(repo)) {
        throw new EntryError(`source.repo is not a GitHub repository as owner/name: ${repo}`);
    }

    const path =
        source.path === undefined || source.path === ""
            ? ""
            : text(source.path, "source.path", 200);

    if (
        path !== "" &&
        (path.split("/").length > 4 || path.split("/").some((part) => !PART.test(part)))
    ) {
        throw new EntryError("source.path is not a folder in the repository, four deep at most");
    }

    return {
        title: text(shape.title, "title", 60),
        description: text(shape.description, "description", 600),
        tags: list(shape.tags, "tags", 10, (item, at) => text(item, at, 24, TAG)),
        author: {
            name: text(author.name, "author.name", 60),
            ...(author.github === undefined
                ? {}
                : { github: text(author.github, "author.github", 39, OWNER) }),
        },
        version: text(shape.version, "version", 32, VERSION),
        source: { repo, commit: text(source.commit, "source.commit", 40, COMMIT), path },
        minPocket: text(shape.minPocket, "minPocket", 14, POCKET_VERSION),
        revoked: revocations(shape.revoked),
    };
}

/** An entry's files: each name as `problemOf` allows, each size up to `size`, and no two that are one file on disk. */
function filesOf(
    value: unknown,
    max: number,
    size: number,
    problemOf: (file: string) => string | undefined,
): EntryFile[] {
    const files = list(value, "files", max, (item, at) => {
        const file = object(item, at, ["name", "sha256", "size"]);
        const fileName = text(file.name, `${at}.name`, 200);
        const problem = problemOf(fileName);

        if (problem !== undefined) {
            throw new EntryError(`${at}.name ${problem}`);
        }

        if (
            !Number.isSafeInteger(file.size) ||
            (file.size as number) < 0 ||
            (file.size as number) > size
        ) {
            throw new EntryError(`${at}.size is not a size of ${size} bytes at most`);
        }

        return {
            name: fileName,
            sha256: text(file.sha256, `${at}.sha256`, 64, SHA256),
            size: file.size as number,
        };
    });

    // Two names that differ only in case are one file where the file system ignores case (macOS, Windows).
    const folded = new Set(files.map((file) => file.name.toLowerCase()));

    if (folded.size !== files.length) {
        throw new EntryError("files has two names that differ only in case");
    }

    // A file cannot be a folder of another one too (`a/b` and `a/b/c`).
    for (const file of folded) {
        const parts = file.split("/");

        for (let at = 1; at < parts.length; at++) {
            if (folded.has(parts.slice(0, at).join("/"))) {
                throw new EntryError(
                    `files has ${parts.slice(0, at).join("/")} as a file and as a folder`,
                );
            }
        }
    }

    return files;
}

/** One entry of the index, checked whole: throws an `EntryError` that says what is wrong, and where. */
export function parseEntry(value: unknown): Entry {
    const shape = object(
        value,
        "the entry",
        [
            "name",
            "title",
            "description",
            "tags",
            "author",
            "version",
            "source",
            "files",
            "pocketApi",
            "minPocket",
            "declares",
        ],
        ["revoked", "kind"],
    );

    if (shape.kind !== undefined && shape.kind !== "extension") {
        throw new EntryError(`kind is ${JSON.stringify(shape.kind)}, not an extension's`);
    }

    const name = text(shape.name, "name", 64, NAME);

    if (BUILT_IN_MODULES.has(name) || name.startsWith("pocket-")) {
        throw new EntryError(`name ${name} is Pi Pocket's own: give it a name of its own`);
    }

    const about = common(shape);
    const files = filesOf(shape.files, LIMITS.files, LIMITS.file, (file) =>
        fileProblem(file, name),
    );

    if (!files.some((file) => file.name === `${name}.ts`)) {
        throw new EntryError(`files has no ${name}.ts, the module`);
    }

    if (files.reduce((sum, file) => sum + file.size, 0) > LIMITS.total) {
        throw new EntryError(`files are more than ${LIMITS.total} bytes together`);
    }

    if (!Number.isSafeInteger(shape.pocketApi) || (shape.pocketApi as number) < 1) {
        throw new EntryError("pocketApi is not a version of the extension API, such as 1");
    }

    const { minPocket, revoked, ...rest } = about;

    return {
        name,
        ...rest,
        files,
        pocketApi: shape.pocketApi as number,
        minPocket,
        declares: declares(shape.declares, "declares"),
        revoked,
    };
}

/**
 * Ids a theme in the index may not have, as Pi Pocket keeps them for itself (`reservedThemeIds`): `pocket`, `desktop`
 * (the desktop's colors), the themes that come with it (`web/themes/`), and its palettes (`web/themes.js`). Read from
 * this checkout, as the index's checks import this file from one.
 */
export const RESERVED_THEMES: ReadonlySet<string> = await reservedThemeIds();

/**
 * A theme's entry, checked whole: its files keep to the theme format's names and limits (`themes/format.ts`). What
 * its CSS does is checked when it is installed, before it is in place (`readTheme`), as for any theme folder.
 */
export function parseThemeEntry(value: unknown): ThemeEntry {
    const shape = object(
        value,
        "the entry",
        [
            "kind",
            "name",
            "title",
            "description",
            "tags",
            "author",
            "version",
            "source",
            "files",
            "themeApi",
            "minPocket",
        ],
        ["revoked"],
    );

    if (shape.kind !== "theme") {
        throw new EntryError('kind is not "theme"');
    }

    const name = text(shape.name, "name", 48, THEME_ID);

    if (RESERVED_THEMES.has(name)) {
        throw new EntryError(`name ${name} is Pi Pocket's own: give it a name of its own`);
    }

    const about = common(shape);
    const files = filesOf(shape.files, THEME_LIMITS.files, THEME_LIMITS.asset, (file) =>
        themeFileProblem(file, name),
    );
    const inner = (file: EntryFile) => file.name.slice(name.length + 1);
    const has = (path: string) => files.some((file) => inner(file) === path);

    if (!has("theme.css") && !has("colors.toml") && !has("colors-light.toml")) {
        throw new EntryError(
            `files has no ${name}/theme.css, ${name}/colors.toml, or ${name}/colors-light.toml`,
        );
    }

    if (has("theme.css") && !has("theme.json")) {
        throw new EntryError(`files has ${name}/theme.css but no ${name}/theme.json`);
    }

    for (const file of files) {
        if (SMALL_FILES.includes(inner(file)) && file.size > THEME_LIMITS.small) {
            throw new EntryError(`${file.name} is more than ${THEME_LIMITS.small} bytes`);
        }
    }

    const css = files.filter((file) => file.name.toLowerCase().endsWith(".css"));

    if (css.reduce((sum, file) => sum + file.size, 0) > THEME_LIMITS.css) {
        throw new EntryError(`its CSS files are more than ${THEME_LIMITS.css} bytes together`);
    }

    if (files.reduce((sum, file) => sum + file.size, 0) > THEME_LIMITS.total) {
        throw new EntryError(`files are more than ${THEME_LIMITS.total} bytes together`);
    }

    if (!Number.isSafeInteger(shape.themeApi) || (shape.themeApi as number) < 1) {
        throw new EntryError("themeApi is not a version of the theme surface, such as 1");
    }

    const { minPocket, revoked, ...rest } = about;

    return {
        kind: "theme",
        name,
        ...rest,
        files,
        themeApi: shape.themeApi as number,
        minPocket,
        revoked,
    };
}

/** An entry's revoked commits, each with why: none when it has no `revoked`. */
function revocations(value: unknown): Entry["revoked"] {
    return value === undefined
        ? []
        : list(value, "revoked", 50, (item, at) => {
              const revoked = object(item, at, ["commit", "reason"]);

              return {
                  commit: text(revoked.commit, `${at}.commit`, 40, COMMIT),
                  reason: text(revoked.reason, `${at}.reason`, 300),
              };
          });
}

/**
 * An entry's revoked commits for the warning alone, read loosely: a revocation counts whatever else its entry says, so
 * an item the strict reading refuses (a reason with an emoji's variation selector, or too long) must not drop them
 * all. Each item with a commit counts; its reason is cleaned of what a line may not hold, and cut short.
 */
function revokedLoosely(value: unknown): Entry["revoked"] {
    return (Array.isArray(value) ? value.slice(0, 200) : []).flatMap((item: unknown) => {
        const { commit, reason } = (item ?? {}) as { commit?: unknown; reason?: unknown };

        if (typeof commit !== "string" || !COMMIT.test(commit)) {
            return [];
        }

        const said =
            typeof reason === "string"
                ? reason.replace(UNSAFE_ALL, " ").replace(/\s+/g, " ").trim().slice(0, 300)
                : "";

        return [{ commit, reason: said === "" ? "The index gives no reason." : said }];
    });
}

/**
 * What the owner approves when they install or update: a digest of everything that decides what is written and what
 * it does (its repository, folder, commit, files with their hashes, and what it declares). The index could change any
 * of them and keep the commit; an install or update the owner saw goes ahead only while this is the same.
 */
export function pinOf(entry: Entry | ThemeEntry): string {
    const { name, source, files } = entry;

    return createHash("sha256")
        .update(
            JSON.stringify(
                "kind" in entry
                    ? { kind: entry.kind, name, source, files }
                    : { name, source, files, declares: entry.declares },
            ),
        )
        .digest("hex");
}

/**
 * Whether an entry is for this Pi Pocket: `newer` when it needs a newer extension API or Pi Pocket. Read loosely,
 * before the entry is checked whole, so an entry written for a newer Pi Pocket (with fields this one does not know)
 * counts as one for later, not as invalid.
 */
export function compatibility(
    value: unknown,
    here: { api: number; version: string },
): "ok" | "newer" {
    const { pocketApi, minPocket, kind, themeApi } = (
        typeof value === "object" && value !== null ? value : {}
    ) as Shape;

    if (typeof kind === "string" && !KINDS.includes(kind)) {
        return "newer";
    }

    if (typeof pocketApi === "number" && pocketApi > here.api) {
        return "newer";
    }

    if (typeof themeApi === "number" && themeApi > THEME_API) {
        return "newer";
    }

    if (
        typeof minPocket === "string" &&
        versionParts(minPocket) !== undefined &&
        !atLeast(here.version, minPocket)
    ) {
        return "newer";
    }

    return "ok";
}

/** Read an index's text, already within `LIMITS.index`: throws an `EntryError` when the index as a whole is not one. */
export function parseIndex(source: string, here: { api: number; version: string }): Index {
    let value: unknown;

    try {
        value = JSON.parse(source);
    } catch {
        throw new EntryError("The index is not JSON");
    }

    if (
        typeof value === "object" &&
        value !== null &&
        "format" in value &&
        value.format !== INDEX_FORMAT
    ) {
        throw new EntryError(
            typeof value.format === "number" && value.format > INDEX_FORMAT
                ? "The index is in a newer format: update Pi Pocket to read it"
                : "The index is not in a format Pi Pocket reads",
        );
    }

    const shape = object(value, "The index", ["format", "extensions"], ["name", "repo"]);

    if (!Array.isArray(shape.extensions) || shape.extensions.length > LIMITS.entries) {
        throw new EntryError(`The index's extensions are not a list of ${LIMITS.entries} at most`);
    }

    const index: Index = {
        entries: [],
        themes: [],
        incompatible: 0,
        invalid: [],
        revoked: new Map(),
        newer: new Set(),
    };

    if (shape.name !== undefined) {
        index.name = text(shape.name, "The index's name", 80);
    }

    if (shape.repo !== undefined) {
        const repo = text(shape.repo, "The index's repo", 160);

        if (repoPage(repo) === undefined) {
            throw new EntryError("The index's repo is not a GitHub repository's address");
        }

        index.repo = repo;
    }

    const taken = new Set<string>();

    for (const item of shape.extensions) {
        const named = (item as Shape | null)?.name;
        const name = typeof named === "string" && NAME.test(named) ? named : undefined;
        const twice = name !== undefined && taken.has(name);

        if (name !== undefined) {
            taken.add(name);
        }

        if (name !== undefined && !twice) {
            index.revoked.set(name, revokedLoosely((item as Shape).revoked));
        }

        if (compatibility(item, here) === "newer" && !twice) {
            index.incompatible++;

            if (name !== undefined) {
                index.newer.add(name);
            }

            continue;
        }

        try {
            if (twice) {
                throw new EntryError(`a second entry is named ${name}`);
            }

            if ((item as Shape | null)?.kind === "theme") {
                index.themes.push(parseThemeEntry(item));
            } else {
                index.entries.push(parseEntry(item));
            }
        } catch (error) {
            if (!(error instanceof EntryError)) {
                throw error;
            }

            index.invalid.push({ ...(name === undefined ? {} : { name }), problem: error.message });
        }
    }

    return index;
}

// ─── Addresses ─────────────────────────────────────────────────────────────────────

/** Whether `text` names a GitHub repository as `owner/name`. */
export function isRepo(text: string): boolean {
    const [owner, repo, ...rest] = text.split("/");

    return (
        rest.length === 0 &&
        OWNER.test(owner ?? "") &&
        REPO.test(repo ?? "") &&
        repo !== "." &&
        repo !== ".."
    );
}

/** A GitHub repository's page from its address (`https://github.com/owner/name`), or undefined for any other. */
export function repoPage(address: string): string | undefined {
    let url: URL;

    try {
        url = new URL(address);
    } catch {
        return undefined;
    }

    const [owner, repo, ...rest] = url.pathname.replace(/^\/|\/$/g, "").split("/");

    return url.protocol === "https:" &&
        url.host === "github.com" &&
        url.username === "" &&
        url.password === "" &&
        url.search === "" &&
        url.hash === "" &&
        rest.length === 0 &&
        isRepo(`${owner}/${repo}`)
        ? `https://github.com/${owner}/${repo}`
        : undefined;
}

/** The address of one of an entry's files: its repository's raw files, at the pinned commit. Always https. */
export function fileUrl(entry: Pick<Entry, "source">, file: string): string {
    const { repo, commit, path } = entry.source;
    const parts = [...(path === "" ? [] : path.split("/")), ...file.split("/")];

    return `https://raw.githubusercontent.com/${repo}/${commit}/${parts.map(encodeURIComponent).join("/")}`;
}

/** The entry's files on GitHub, at the pinned commit, for people to read. */
export function sourcePage(entry: Pick<Entry, "source">): string {
    const { repo, commit, path } = entry.source;

    return `https://github.com/${repo}/tree/${commit}${path === "" ? "" : `/${path}`}`;
}

export function sha256(bytes: Uint8Array): string {
    return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Every name an entry declares, for checking two entries do not share one: its module's, extensions', and tools'; a
 * theme's id.
 */
export function claimedNames(entry: Entry | ThemeEntry): string[] {
    if ("kind" in entry) {
        return [`theme ${entry.name}`];
    }

    return [
        `module ${entry.name}`,
        ...entry.declares.extensions.map((name) => `extension ${name}`),
        ...entry.declares.tools.map((name) => `tool ${name}`),
        ...(entry.declares.commands ?? []).map((command) => `command /${command.split(" ")[1]}`),
    ];
}
