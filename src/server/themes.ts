/**
 * Themes: folders of CSS, colors, fonts, and images that change how the app looks and is laid out
 * (docs/extensions/themes.md). The built-in ones are in `web/themes/`, the owner's in the data folder's `themes/`. Each
 * is read and checked here (`themes/format.ts`, `themes/css.ts`), its CSS kept in memory as it was checked, and served
 * at `/themes/<id>/<rev>/…` to everyone signed in (`http/theme-routes.ts`). A theme that breaks keeps its last good
 * version while the server runs, and the owner is told why.
 */
import { createHash } from "node:crypto";
import {
    closeSync,
    constants,
    cpSync,
    type Dirent,
    fstatSync,
    lstatSync,
    mkdirSync,
    openSync,
    readdirSync,
    readFileSync,
    realpathSync,
    renameSync,
    writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { APP_ROOT } from "./config.ts";
import { describe, HttpError } from "./errors.ts";
import { opened } from "./http/io.ts";
import { desktopTheme } from "./omarchy.ts";
import { watchTree } from "./reload.ts";
import { cssReferences, themeFile } from "./themes/css.ts";
import { reservedThemeIds } from "./themes/reserved.ts";
import { pocketVersion } from "./versions.ts";
import {
    assetType,
    colorsToml,
    type Manifest,
    newThemeId,
    parseManifest,
    parseThemeColors,
    plainLine,
    THEME_ID,
    THEME_LIMITS,
    ThemeProblem,
} from "./themes/format.ts";

/** The app's own look, which every theme builds on: choosing it loads no stylesheet. */
export const BASE_THEME = "pocket";

/** A theme as the web app lists it. */
export interface ThemeInfo {
    id: string;
    name: string;
    description?: string;
    author?: string;
    version?: string;
    /** In `web/themes/`, with the app: it cannot be changed or removed here. */
    builtIn: boolean;
    /** The stylesheets to load; none for the base theme and for colors alone. */
    css: string[];
    /** Its palette, by `colors.toml`'s keys, when it has one. */
    colors?: Record<string, string>;
    /** A light palette beside it (`colors-light.toml`): the theme's colors follow the system's light or dark. */
    colorsLight?: Record<string, string>;
    /** The fonts its stylesheets load, to preload with them. */
    fonts: string[];
    /** Changes when any of its files do. */
    rev?: string;
    /** Why it is not as its files are: it keeps its last good version, or, with none, it is not offered. */
    problem?: string;
    /** Whether it can be chosen: it has a good version. */
    usable: boolean;
}

/** A file of a theme's folder, as it was when it was read. */
interface FileStat {
    file: string;
    size: number;
    mtimeMs: number;
    dev: number;
    ino: number;
}

/** A theme as it was checked: what is served. */
interface Version {
    id: string;
    dir: string;
    builtIn: boolean;
    manifest?: Manifest;
    colors?: Record<string, string>;
    colorsLight?: Record<string, string>;
    /** Its stylesheets' text, by their path in the folder, `theme.css` first. */
    css: Map<string, string>;
    /** Its fonts and images, by their path in the folder. */
    assets: Map<string, FileStat & { type: string }>;
    rev: string;
}

/** A theme's file's address: its path in the folder, each part escaped, under the theme's id and version. */
const themeAddress = (id: string, rev: string, path: string) =>
    `/themes/${id}/${rev}/${path.split("/").map(encodeURIComponent).join("/")}`;

/** A theme folder found, in the order listed. */
interface Listed {
    id: string;
    builtIn: boolean;
    name?: string | undefined;
}

/** What a theme's address serves: a stylesheet as it was checked, or a font or image on disk. */
export type ThemeFile = { css: string } | (FileStat & { type: string });

export interface ThemesOptions {
    builtIn: string;
    dataDir: string;
    /** Pi Pocket's version, for a theme's `minPocket`: its package's, unless a test says otherwise. */
    version?: string;
    /** Something about a theme only the owner can mend. */
    notify: (message: string) => void;
    /** The list changed: tabs should hear it. */
    changed: () => void;
    log: (line: string) => void;
}

export class Themes {
    readonly builtInDir: string;
    /** The owner's themes: a real path once `load` made it, as reading a file checks the path it opened. */
    dir: string;
    readonly #options: ThemesOptions & { version: string };
    /** The last good version of each theme, by id. */
    readonly #good = new Map<string, Version>();
    /** Why a theme's files are not what is served, by id. */
    readonly #problems = new Map<string, string>();
    /** Every theme folder found, by id, in the order listed: built-in ones first. */
    #found: Listed[] = [];
    /** The palettes that come with the app (`web/themes.js`), by id: their ids are taken. */
    #palettes: Record<string, { name: string; colors: Record<string, string> }> = {};
    /** The ids the app keeps (`reservedThemeIds`): no folder of the owner's may take one. */
    #reserved = new Set<string>(["pocket", "desktop"]);
    #failure: string | undefined;
    /** Folders not read for their names, with why: told once. */
    #misnamed = new Map<string, string>();
    #stops: (() => void)[] = [];
    #timer: NodeJS.Timeout | undefined;
    #listKey = "";

    constructor(options: ThemesOptions) {
        this.#options = { ...options, version: options.version ?? pocketVersion() };
        this.builtInDir = options.builtIn;
        this.dir = join(options.dataDir, "themes");
    }

    /** Read every theme, once, as the server starts. */
    async load(): Promise<void> {
        try {
            const module = (await import(
                pathToFileURL(join(APP_ROOT, "web", "themes.js")).href
            )) as {
                THEMES: Record<string, { name: string; colors: Record<string, string> }>;
            };

            this.#palettes = module.THEMES;
        } catch (error) {
            this.#options.log(`The app's palettes could not be read: ${describe(error)}`);
        }

        this.#reserved = await reservedThemeIds();

        try {
            mkdirSync(this.dir, { recursive: true });
            // A data folder reached through a link (or named relatively) would make every file read differ from the
            // path `/proc` gives for it, and no theme of the owner's would load.
            this.dir = realpathSync(this.dir);
        } catch (error) {
            this.#options.log(`No themes folder at ${this.dir}: ${describe(error)}`);
        }

        // A theme folder must never keep the server from starting: past a failure, the built-in themes alone.
        try {
            this.#scan(false);
        } catch (error) {
            this.#failure = `The owner's themes could not be read, so only the built-in ones are offered until the server restarts: ${describe(error)}`;
            this.#options.log(this.#failure);
            this.#good.clear();
            this.#problems.clear();
            this.#found = [];

            try {
                this.#scan(false, false);
            } catch (again) {
                this.#options.log(`The built-in themes could not be read: ${describe(again)}`);
            }
        }
    }

    /** Why the owner's themes were not read at the start, if they were not: the owner is told when they connect. */
    get failure(): string | undefined {
        return this.#failure;
    }

    /** Read the themes again shortly after their files change. */
    watch(): void {
        const later = () => {
            clearTimeout(this.#timer);
            this.#timer = setTimeout(() => this.rescan(), 300);
        };

        for (const dir of [this.builtInDir, this.dir]) {
            try {
                this.#stops.push(watchTree(dir, later));
            } catch (error) {
                this.#options.log(
                    `Themes in ${dir} are not reloaded when edited: ${describe(error)}`,
                );
            }
        }
    }

    close(): void {
        clearTimeout(this.#timer);

        for (const stop of this.#stops.splice(0)) {
            stop();
        }
    }

    /** Read every theme again, and tell the tabs and the owner what changed. */
    rescan(): void {
        // From a timer: what it throws would end the process.
        try {
            this.#scan(true);
        } catch (error) {
            const message = `Themes could not be read again; the ones in use stay as they were: ${describe(error)}`;

            this.#options.log(message);
            this.#options.notify(message);
        }
    }

    /** Every theme, as the web app lists it: built-in ones first, then the owner's by name. */
    list(owner = true): ThemeInfo[] {
        return this.#found.map(({ id, builtIn, name }) => {
            const good = this.#good.get(id);
            const problem = this.#problems.get(id);
            const manifest = good?.manifest;

            return {
                id,
                name: manifest?.name ?? name ?? id,
                ...(manifest?.description === undefined
                    ? {}
                    : { description: manifest.description }),
                ...(manifest?.author === undefined ? {} : { author: manifest.author }),
                ...(manifest?.version === undefined ? {} : { version: manifest.version }),
                builtIn,
                css: good === undefined || id === BASE_THEME ? [] : this.#chain(good),
                ...(good?.colors === undefined ? {} : { colors: good.colors }),
                ...(good?.colorsLight === undefined ? {} : { colorsLight: good.colorsLight }),
                fonts: good === undefined || id === BASE_THEME ? [] : this.#fonts(good),
                ...(good === undefined ? {} : { rev: good.rev }),
                // What is wrong can name the server's folders: the owner's to read, as extensions' load errors are.
                ...(problem === undefined || !owner ? {} : { problem }),
                usable: good !== undefined,
            };
        });
    }

    /**
     * A file a theme serves now, by its path in the folder, and whether `rev` is the version it is now (an address that
     * will never serve anything else); none for anything else.
     */
    file(
        id: string,
        rev: string | undefined,
        path: readonly string[],
    ): { file: ThemeFile; current: boolean } | undefined {
        const good = this.#good.get(id);
        const key = path.join("/");

        if (good === undefined) {
            return undefined;
        }

        const css = good.css.get(key);
        const file = css === undefined ? good.assets.get(key) : { css };

        return file === undefined ? undefined : { file, current: rev === good.rev };
    }

    /**
     * Whether colors are here to use: the desktop's (on a machine with Omarchy), a palette that comes with the app, or a
     * theme folder's that can be used (`<id>`, or a half of a pair: `<id>@dark`, `<id>@light`).
     */
    async hasColors(id: string): Promise<boolean> {
        if (id === "desktop") {
            return (await desktopTheme()) !== null;
        }

        if (Object.hasOwn(this.#palettes, id)) {
            return true;
        }

        const [base, half] = id.split("@");
        const good = base === undefined ? undefined : this.#good.get(base);

        return half === "light"
            ? good?.colorsLight !== undefined
            : half === "dark"
              ? good?.colorsLight !== undefined && good.colors !== undefined
              : good?.colors !== undefined;
    }

    /** Whether a theme is the owner's, and so may be changed or removed here. */
    #owned(id: string): boolean {
        return this.#found.some((each) => each.id === id && !each.builtIn);
    }

    /**
     * A new theme of the owner's called `name`. Of a theme (`colors` false): a copy of its whole folder, with a new name.
     * Of colors (`colors` true): a theme of colors alone, from a palette that comes with the app, `desktop` (the
     * desktop's, as it is now), or a theme folder's (`<id>`, both halves of a pair; `<id>@dark` or `<id>@light`, one).
     * Answers its id.
     */
    async duplicate(from: string, name: unknown, colorsOnly = false): Promise<string> {
        const title = (() => {
            try {
                return plainLine(name, "The name", 60);
            } catch (error) {
                throw new HttpError(400, describe(error));
            }
        })();
        const [base, half] = from.split("@") as [string, string | undefined];
        const source = this.#good.get(base);
        /** What to write, by file name, besides the copied files. */
        const write = new Map<string, string>();
        let copy: Map<string, FileStat> | undefined;
        let manifest: Record<string, unknown> = { themeApi: 1, name: title };

        if (!colorsOnly) {
            if (source === undefined || half !== undefined) {
                throw new HttpError(404, "No such theme to copy");
            }

            copy = walk(source.dir);
            // Its own now: what the copy says of itself is the owner's to write.
            manifest = {
                ...(source.manifest ?? {}),
                themeApi: source.manifest?.themeApi ?? 1,
                name: title,
            };
            delete manifest.description;
            delete manifest.author;
            delete manifest.version;
        } else if (source !== undefined) {
            const dark = half === "light" ? undefined : source.colors;
            const light = half === "dark" ? undefined : source.colorsLight;

            if (dark === undefined && light === undefined) {
                throw new HttpError(404, "That theme has no such colors");
            }

            if (dark !== undefined) {
                write.set("colors.toml", colorsToml(dark));
            }

            if (light !== undefined) {
                write.set(
                    dark === undefined ? "colors.toml" : "colors-light.toml",
                    colorsToml(light),
                );
            }
        } else {
            const colors =
                from === "desktop"
                    ? (await desktopTheme())?.colors
                    : Object.hasOwn(this.#palettes, from)
                      ? this.#palettes[from]!.colors
                      : undefined;

            if (colors === undefined) {
                throw new HttpError(404, "No such colors to copy");
            }

            write.set("colors.toml", colorsToml(colors));
        }

        write.set("theme.json", `${JSON.stringify(manifest, null, 4)}\n`);
        const id = newThemeId(title, (each) => this.#taken(each));
        const target = join(this.dir, id);

        mkdirSync(this.dir, { recursive: true });
        mkdirSync(target);

        try {
            // Every file of its folder, as written (its fonts' licences too), not as served.
            for (const [path, stat] of copy ?? []) {
                mkdirSync(dirname(join(target, path)), { recursive: true });
                cpSync(stat.file, join(target, path), { dereference: false });
            }

            for (const [file, text] of write) {
                writeFileSync(join(target, file), text);
            }
        } catch (error) {
            this.#options.log(`Theme ${id} was not copied whole: ${describe(error)}`);

            throw new HttpError(500, `The copy failed: ${describe(error)}`);
        }

        this.#scan(true);

        return id;
    }

    /** Take one of the owner's themes away: into `themes/.removed/`, which is not listed, so nothing is lost. */
    remove(id: string): void {
        if (!this.#owned(id)) {
            throw new HttpError(404, "No such theme of yours");
        }

        const removed = join(this.dir, ".removed");
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");

        mkdirSync(removed, { recursive: true });
        renameSync(join(this.dir, id), join(removed, `${id}-${stamp}`));
        this.#scan(true);
    }

    /** Where a session that edits one of the owner's themes works, and what its message box starts with. */
    edit(id: string): { cwd: string; draft: string } {
        if (!this.#owned(id)) {
            throw new HttpError(
                404,
                "Only your own themes can be edited here: duplicate this one first",
            );
        }

        const name = this.list().find((each) => each.id === id)?.name ?? id;
        const docs = join(APP_ROOT, "docs", "extensions");

        return {
            cwd: join(this.dir, id),
            draft: `Help me change the theme “${name}” in this folder. Read the theme guide (${join(docs, "themes.md")}) and the list of tokens and parts (${join(docs, "reference", "theme-surface.md")}) first. What I want: `,
        };
    }

    /** Whether an id is a theme's, a built-in palette's, or a word the app keeps. */
    #taken(id: string): boolean {
        if (this.#reserved.has(id)) {
            return true;
        }

        if (this.#found.some((each) => each.id === id)) {
            return true;
        }

        try {
            lstatSync(join(this.dir, id));

            return true;
        } catch {
            return false;
        }
    }

    /** The fonts a theme's stylesheets load. */
    #fonts(version: Version): string[] {
        return [...version.assets]
            .filter(([, asset]) => asset.type === "font/woff2")
            .map(([path]) => themeAddress(version.id, version.rev, path));
    }

    /** The stylesheet of a theme: its `theme.css`, which imports the rest; none for colors alone. */
    #chain(version: Version): string[] {
        return version.css.has("theme.css")
            ? [`/themes/${version.id}/${version.rev}/theme.css`]
            : [];
    }

    /** Read every theme folder; with `tell`, tell the owner about new problems and the tabs about a changed list. */
    #scan(tell: boolean, theirs = true): void {
        const found: { id: string; builtIn: boolean; dir: string }[] = [];

        for (const [root, builtIn] of [
            [this.builtInDir, true],
            ...(theirs ? [[this.dir, false] as const] : []),
        ] as const) {
            let entries: Dirent[];

            try {
                entries = readdirSync(root, { withFileTypes: true });
            } catch {
                continue;
            }

            for (const entry of entries
                .filter((each) => each.isDirectory() && !each.name.startsWith("."))
                .sort((a, b) => (a.name < b.name ? -1 : 1))) {
                found.push({ id: entry.name, builtIn, dir: join(root, entry.name) });
            }
        }

        const before = new Map(this.#problems);
        const seen = new Set<string>();
        const listed: Listed[] = [];
        const misnamed = new Map<string, string>();

        for (const { id, builtIn, dir } of found) {
            if (!THEME_ID.test(id)) {
                misnamed.set(
                    dir,
                    "its folder's name is not an id: 2 to 48 lowercase letters, digits, and -",
                );
                continue;
            }

            if (seen.has(id) || (!builtIn && this.#reserved.has(id))) {
                misnamed.set(
                    dir,
                    "its folder has the name of a theme or colors that come with Pi Pocket",
                );
                continue;
            }

            seen.add(id);

            try {
                const version = readTheme(dir, id, builtIn, this.#options.version);

                this.#good.set(id, version);
                this.#problems.delete(id);
                listed.push({ id, builtIn, name: version.manifest?.name });
            } catch (error) {
                this.#problems.set(
                    id,
                    error instanceof ThemeProblem
                        ? error.message
                        : `it cannot be read: ${describe(error)}`,
                );
                listed.push({ id, builtIn, name: this.#good.get(id)?.manifest?.name });
            }
        }

        // Themes whose folder went: nothing of them is served or listed.
        for (const id of [...this.#good.keys()]) {
            if (!seen.has(id)) {
                this.#good.delete(id);
            }
        }

        for (const id of [...this.#problems.keys()]) {
            if (!seen.has(id)) {
                this.#problems.delete(id);
            }
        }

        // The owner's by name, after the built-in ones.
        const owners = listed
            .filter((each) => !each.builtIn)
            .sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id));

        this.#found = [...listed.filter((each) => each.builtIn), ...owners];

        const told: string[] = [];

        for (const [id, problem] of this.#problems) {
            if (before.get(id) !== problem) {
                const name = this.#found.find((each) => each.id === id)?.name;
                const kept = this.#good.has(id)
                    ? "It keeps its last good version."
                    : "It is not offered until that is mended.";

                told.push(`Theme ${name ? `“${name}” (${id})` : id}: ${problem}. ${kept}`);
            }
        }

        for (const [dir, problem] of misnamed) {
            if (this.#misnamed.get(dir) !== problem) {
                told.push(`The theme folder ${dir} is not read: ${problem}.`);
            }
        }

        this.#misnamed = misnamed;

        for (const message of told) {
            this.#options.log(message);

            if (tell) {
                this.#options.notify(message);
            }
        }

        const key = JSON.stringify(this.list());

        if (key !== this.#listKey) {
            this.#listKey = key;

            if (tell) {
                this.#options.changed();
            }
        }
    }
}

/** A theme's folder: its files, by their path in it; no hidden ones, `node_modules`, or links, four folders deep. */
function walk(dir: string): Map<string, FileStat> {
    const files = new Map<string, FileStat>();
    let looked = 0;

    const visit = (folder: string, prefix: string, depth: number) => {
        let entries: Dirent[];

        try {
            entries = readdirSync(folder, { withFileTypes: true });
        } catch {
            return;
        }

        for (const entry of entries) {
            if (++looked > THEME_LIMITS.walk) {
                throw new ThemeProblem(
                    `its folder holds more than ${THEME_LIMITS.walk} files and folders`,
                );
            }

            if (entry.name.startsWith(".") || entry.name === "node_modules") {
                continue;
            }

            const path = join(folder, entry.name);
            const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;

            if (entry.isDirectory()) {
                if (depth < THEME_LIMITS.depth) {
                    visit(path, relative, depth + 1);
                }
            } else if (entry.isFile()) {
                try {
                    const stats = lstatSync(path);

                    files.set(relative, {
                        file: path,
                        size: stats.size,
                        mtimeMs: stats.mtimeMs,
                        dev: stats.dev,
                        ino: stats.ino,
                    });
                } catch {
                    // Gone since the listing.
                }
            }
        }
    };

    const stats = lstatSync(dir);

    if (!stats.isDirectory()) {
        throw new ThemeProblem("it is not a folder (a link to one is not read)");
    }

    visit(dir, "", 0);

    return files;
}

/** A file of the folder as text, read as it was listed: not a link, the same file, and no bigger than `max`. */
export function readListed(stat: FileStat, max: number, what: string): string {
    if (stat.size > max) {
        throw new ThemeProblem(`${what} is larger than ${Math.round(max / 1024)} KB`);
    }

    let fd: number;

    try {
        fd = openSync(stat.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
        throw new ThemeProblem(`${what} cannot be read: ${describe(error)}`);
    }

    try {
        const now = fstatSync(fd);

        if (!now.isFile() || !opened(fd, stat, now) || now.size > max) {
            throw new ThemeProblem(`${what} changed while it was read: it is read again soon`);
        }

        return readFileSync(fd, "utf8");
    } finally {
        closeSync(fd);
    }
}

/** Read and check one theme folder: what it serves, or why it cannot. */
export function readTheme(
    dir: string,
    id: string,
    builtIn: boolean,
    pocketVersion: string,
): Version {
    const files = walk(dir);
    const hash = createHash("sha256");
    const manifestFile = files.get("theme.json");
    const colorsFile = files.get("colors.toml");
    const lightFile = files.get("colors-light.toml");
    const entry = files.get("theme.css");
    let manifest: Manifest | undefined;
    let colors: Record<string, string> | undefined;
    let colorsLight: Record<string, string> | undefined;

    if (manifestFile !== undefined) {
        const text = readListed(manifestFile, THEME_LIMITS.small, "theme.json");

        manifest = parseManifest(text, pocketVersion);
        hash.update(`theme.json\0${text}\0`);
    }

    if (colorsFile !== undefined) {
        const text = readListed(colorsFile, THEME_LIMITS.small, "colors.toml");

        colors = parseThemeColors(text);
        hash.update(`colors.toml\0${text}\0`);
    }

    if (lightFile !== undefined) {
        const text = readListed(lightFile, THEME_LIMITS.small, "colors-light.toml");
        const light = parseThemeColors(text);

        if ((light.mode ?? "light") !== "light") {
            throw new ThemeProblem('colors-light.toml says mode = "dark"');
        }

        // Alone, it is the theme's palette; beside colors.toml, the light half of a pair.
        if (colors === undefined) {
            colors = { ...light, mode: "light" };
        } else {
            colorsLight = { ...light, mode: "light" };
        }

        hash.update(`colors-light.toml\0${text}\0`);
    }

    if (entry === undefined && colors === undefined) {
        throw new ThemeProblem("it has no theme.css, colors.toml, or colors-light.toml");
    }

    if (entry !== undefined && manifest === undefined) {
        throw new ThemeProblem("it has a theme.css but no theme.json");
    }

    const css = new Map<string, string>();
    /** Where each stylesheet loads a font or an image, to write the theme's own address in (`served` below). */
    const loads = new Map<string, Load[]>();
    const assets = new Map<string, FileStat & { type: string }>();
    let cssBytes = 0;
    let assetBytes = 0;
    const queue = entry === undefined ? [] : ["theme.css"];

    while (queue.length > 0) {
        const path = queue.shift()!;

        if (css.has(path)) {
            continue;
        }

        const stat = files.get(path)!;

        cssBytes += stat.size;

        if (cssBytes > THEME_LIMITS.css) {
            throw new ThemeProblem(`its CSS is larger than ${THEME_LIMITS.css / 1024} KB together`);
        }

        const text = readListed(stat, THEME_LIMITS.css, path);
        const found = cssReferences(text);
        const where = (line: number) => `${path} line ${line}`;

        css.set(path, found.text);
        loads.set(path, []);
        hash.update(`${path}\0${text}\0`);

        if (found.problems.length > 0) {
            const first = found.problems[0]!;

            throw new ThemeProblem(`${where(first.line)}: ${first.message}`);
        }

        for (const ref of found.imports) {
            const target = themeFile(ref.url, path);

            if (typeof target !== "object" || !target.file.toLowerCase().endsWith(".css")) {
                throw new ThemeProblem(
                    `${where(ref.line)}: @import ${JSON.stringify(ref.url)} is not a .css file of the theme's own: a theme loads only its own files`,
                );
            }

            if (!files.has(target.file)) {
                throw new ThemeProblem(
                    `${where(ref.line)}: there is no ${target.file} in its folder`,
                );
            }

            queue.push(target.file);
            // Written as its full address, as a font or an image is: the check read the address against the theme's
            // folder, and the browser must read it the same way, not against the app's.
            loads.get(path)!.push({
                start: ref.start,
                end: ref.end,
                quoted: ref.quoted,
                file: target.file,
            });
        }

        for (const ref of found.assets) {
            const target = themeFile(ref.url, path);

            if (target === "fragment" || target === "data") {
                continue;
            }

            if (target === undefined) {
                throw new ThemeProblem(
                    `${where(ref.line)}: url(${JSON.stringify(ref.url)}) is not a file in the theme's folder: a theme loads only its own files`,
                );
            }

            const type = assetType(target.file);
            const stat = files.get(target.file);

            if (type === undefined) {
                throw new ThemeProblem(
                    `${where(ref.line)}: ${target.file} is not a .woff2 font or an image (.png, .jpg, .webp, .avif, .gif, .svg)`,
                );
            }

            if (stat === undefined) {
                throw new ThemeProblem(
                    `${where(ref.line)}: there is no ${target.file} in its folder`,
                );
            }

            const fragment = ref.url.indexOf("#");

            loads.get(path)!.push({
                start: ref.start,
                end: ref.end,
                quoted: ref.quoted,
                file: target.file,
                ...(fragment === -1
                    ? {}
                    : { fragment: encodeURIComponent(ref.url.slice(fragment + 1)) }),
            });

            if (assets.has(target.file)) {
                continue;
            }

            if (stat.size > THEME_LIMITS.asset) {
                throw new ThemeProblem(
                    `${target.file} is larger than ${THEME_LIMITS.asset / 1024 / 1024} MB`,
                );
            }

            assetBytes += stat.size;

            if (assetBytes > THEME_LIMITS.total) {
                throw new ThemeProblem(
                    `its fonts and images are larger than ${THEME_LIMITS.total / 1024 / 1024} MB together`,
                );
            }

            assets.set(target.file, { ...stat, type });
            hash.update(`${target.file}\0${stat.size}\0${stat.mtimeMs}\0`);
        }

        if (css.size + assets.size > THEME_LIMITS.files) {
            throw new ThemeProblem(`it serves more than ${THEME_LIMITS.files} files`);
        }
    }

    const rev = hash.digest("base64url").slice(0, 12);

    return {
        id,
        dir,
        builtIn,
        ...(manifest === undefined ? {} : { manifest }),
        ...(colors === undefined ? {} : { colors }),
        ...(colorsLight === undefined ? {} : { colorsLight }),
        css: new Map(
            [...css].map(([path, text]) => [path, served(text, loads.get(path)!, id, rev)]),
        ),
        assets,
        rev,
    };
}

/** A file a stylesheet loads, where it names it, and the file of the folder it is (a `#` in its name kept apart). */
interface Load {
    start: number;
    end: number;
    quoted: boolean;
    file: string;
    fragment?: string;
}

/**
 * A stylesheet as it is served: each font and image it loads named by its full address, not by a path from the
 * stylesheet. A path in a variable (`--wallpaper: url("images/a.png")`) would otherwise be read where the variable is
 * used, from the app's own stylesheet, and miss.
 */
function served(text: string, loads: Load[], id: string, rev: string): string {
    const parts: string[] = [];
    let at = 0;

    // In one pass, front to back: a slice of the whole text for each load would grow with their count times the size.
    for (const load of [...loads].sort((a, b) => a.start - b.start)) {
        const address = `${themeAddress(id, rev, load.file)}${load.fragment === undefined ? "" : `#${load.fragment}`}`;

        parts.push(text.slice(at, load.start), load.quoted ? `"${address}"` : `url("${address}")`);
        at = load.end;
    }

    parts.push(text.slice(at));

    return parts.join("");
}
