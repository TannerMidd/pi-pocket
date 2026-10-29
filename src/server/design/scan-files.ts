/**
 * The file walk of the design system scan (stream T): finds the style files of a project, ranks them by how likely they
 * are to hold the design (a stylesheet called `theme.css` before a deep component file), and reads each one bounded.
 * The walk never follows a symlink, so a project cannot lead it out of the folder.
 */
import {
    SD_CONFIG_NAME,
    type SdConfig,
    sdConfigOfJson,
    sdConfigsIn,
} from "./scan-import-sd-config.ts";
import { isObject } from "./scan-import-convert.ts";
import { closeSync, constants, fstatSync, openSync, readdirSync, readSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";

/** Folders that hold other people's code or build output, not the project's own styles. */
const SKIP = new Set([
    "node_modules",
    ".git",
    "dist",
    "build",
    "out",
    "coverage",
    ".next",
    ".nuxt",
    ".svelte-kit",
    ".cache",
    ".turbo",
    ".parcel-cache",
    ".output",
    ".vercel",
    ".netlify",
    ".yarn",
    ".pnpm-store",
    ".venv",
    "venv",
    "__pycache__",
    "target",
    "vendor",
    "vendors",
    "third_party",
    "third-party",
    "thirdparty",
    "bower_components",
    "exports",
    "storybook-static",
    ".pi",
    ".idea",
    ".vscode",
    ".github",
    ".husky",
]);

/** Why a folder is not walked, for the report: the first match of its name. Dot folders (`.git`) are not reported. */
const FOLDER_WHY: [RegExp, string][] = [
    [/^(?:node_modules|vendors?|bower_components|third[-_]?party)$/i, "vendored code"],
    [/^(?:dist|build|out|coverage|target|exports|storybook-static)$/i, "build output"],
];

/** A file or folder that the scan did not read, and why. */
export interface Skipped {
    path: string;
    why: string;
}

/** Dot folders that hold a project's styles. */
const DOT_STYLE_FOLDERS = new Set([".storybook", ".vitepress", ".vuepress", ".docusaurus"]);

const STYLE =
    /\.(?:css|scss|sass|less|styl|stylus|pcss|postcss|html?|vue|svelte|astro|mdx|tsx|jsx|ts|js|mjs|cjs|mts|cts)$/i;
const TOKEN_JSON =
    /(?:^|\/)(?:design-?tokens?|tokens?|properties|brands?|themes?|style-?dictionary|dictionary)\/(?:[^/]+\/)*[^/]+\.json$|(?:^|\/)(?:config|[\w.-]*config|[\w.-]*[.-]config[.-][\w-]+|config[.-][\w-]+|\.styledictionaryrc)\.json$|(?:^|\/)(?:[^/]*tokens?[^/]*|[^/]*theme[^/]*|[^/]*(?:figma|studio|design-?system|material|m3)[^/]*)\.json$|(?:^|\/)(?:design-)?tokens\/[^/]+\.json$|(?:^|\/)styles\/[^/]+\.json$|(?:^|\/)\$(?:themes|metadata)\.json$/i;

export const LIMITS = {
    /** Files read. */
    files: 400,
    /** Candidate files kept for ranking. */
    candidates: 3000,
    /** Entries looked at in the walk. */
    entries: 20_000,
    depth: 8,
    /** Bytes read from one file. */
    fileBytes: 200_000,
    /** Bytes read from one token file: a Tokens Studio file of a large system is more than a stylesheet. */
    jsonBytes: 1_500_000,
    /** Bytes read in all. */
    totalBytes: 8_000_000,
    /** Characters kept of a value in the report. */
    valueChars: 200,
    /** Figma `.fig` files read: each one is decoded, so only a few. */
    figs: 4,
} as const;

/** How likely a file is to hold the design, for ordering: higher is read first. */
export function priority(rel: string): number {
    const name = rel.split("/").at(-1)!.toLowerCase();
    const extension = extname(name);
    let score = 0;

    if (/^\.(?:css|scss|sass|less|styl|stylus|pcss|postcss)$/.test(extension)) {
        score += 40;
    } else if (extension === ".json") {
        score += 45;
    } else if (extension === ".fig") {
        // A Figma file is the design itself, before any stylesheet that a person wrote from it.
        score += 50;
    } else if (/^\.(?:[cm]?[jt]s)$/.test(extension)) {
        score += 20;
    } else if (/^\.(?:html?|vue|svelte|astro|mdx)$/.test(extension)) {
        score += 25;
    } else {
        score += 12;
    }

    if (
        /(?:^|\/)(?:tailwind\.config|theme|tokens?|variables|vars|globals?|global|base|colors?|palette|design|root|index|main|app|styles?)(?:[.\-_/]|$)/.test(
            rel.toLowerCase(),
        )
    ) {
        score += 20;
    }

    if (/(?:^|\/)(?:theme|themes|tokens|styles|css|design|assets\/css)\//.test(rel.toLowerCase())) {
        score += 8;
    }

    // Tokens Studio writes `$themes.json` and `$metadata.json` beside a file for each token set.
    if (/(?:^|\/)\$(?:themes|metadata)\.json$/.test(rel)) {
        score += 30;
    }

    if (
        /\.min\.|(?:^|\/)(?:vendor|third[-_]?party|generated|__generated__)\/|\.d\.ts$/.test(
            rel.toLowerCase(),
        )
    ) {
        score -= 40;
    }

    if (/\.(?:test|spec|stories)\.|(?:^|\/)(?:__tests__|e2e|fixtures?)\//.test(rel.toLowerCase())) {
        score -= 10;
    }

    // A script that is not named for a theme or styles comes after every file that is.
    if (
        /^\.(?:[cm]?[jt]s)$/.test(extension) &&
        !/(?:tailwind\.config|theme|tokens?|colors?|palette|design|variables|styles?|constants?|config)/i.test(
            rel,
        )
    ) {
        score -= 15;
    }

    return score - rel.split("/").length * 2;
}

/** Whether a file is worth reading at all. */
function wanted(rel: string, name: string): boolean {
    if (/\.fig$/i.test(name)) {
        return true;
    }

    if (!STYLE.test(name)) {
        return TOKEN_JSON.test(rel) && name.endsWith(".json");
    }

    // A script may hold a theme or CSS-in-JS styles. The walk keeps them all (a bounded number, behind the best files);
    // the scan reads the ones that are not named for a theme only when they look like styles.
    if (/\.(?:[cm]?[jt]s)$/i.test(name) && !/\.d\.[cm]?ts$/.test(name)) {
        return true;
    }

    return !name.endsWith(".d.ts");
}

/** The `.json` files under a Tokens Studio folder (three levels, a bounded number), added to `found`. */
function studioSets(root: string, dir: string, depth: number, found: string[]): void {
    let entries;

    try {
        entries = readdirSync(join(root, dir), { withFileTypes: true }).sort((a, b) =>
            a.name.localeCompare(b.name),
        );
    } catch {
        return;
    }

    for (const entry of entries) {
        const rel = dir === "" ? entry.name : `${dir}/${entry.name}`;

        if (found.length >= LIMITS.candidates) {
            return;
        }

        if (
            entry.isDirectory() &&
            depth < 3 &&
            !SKIP.has(entry.name) &&
            !entry.name.startsWith(".")
        ) {
            studioSets(root, rel, depth + 1, found);
        } else if (entry.isFile() && entry.name.endsWith(".json") && !found.includes(rel)) {
            found.push(rel);
        }
    }
}

/** The files to read under `root`, best first, and whether a limit left some out. */
export function collectFiles(root: string): {
    files: string[];
    partial: boolean;
    skipped: Skipped[];
} {
    const found: string[] = [];
    const skipped: Skipped[] = [];
    let partial = false;
    let seen = 0;

    const note = (path: string, why: string) => {
        if (skipped.length < 40) {
            skipped.push({ path, why });
        }
    };

    const walk = (dir: string, depth: number) => {
        let entries;

        try {
            entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
                a.name.localeCompare(b.name),
            );
        } catch {
            return;
        }

        for (const entry of entries) {
            if (found.length >= LIMITS.candidates || ++seen > LIMITS.entries) {
                partial = true;

                return;
            }

            // Dirent reports a symlink as a symlink, not as its target: neither branch below takes one.
            if (entry.isDirectory()) {
                const skip =
                    SKIP.has(entry.name) ||
                    (entry.name.startsWith(".") && !DOT_STYLE_FOLDERS.has(entry.name));

                if (depth < LIMITS.depth && !skip) {
                    walk(join(dir, entry.name), depth + 1);
                } else if (depth >= LIMITS.depth && !skip) {
                    partial = true;
                    note(
                        `${relative(root, join(dir, entry.name)).split(sep).join("/")}/`,
                        `deeper than ${LIMITS.depth} levels`,
                    );
                } else if (skip && !entry.name.startsWith(".")) {
                    note(
                        `${relative(root, join(dir, entry.name)).split(sep).join("/")}/`,
                        FOLDER_WHY.find(([pattern]) => pattern.test(entry.name))?.[1] ??
                            "ignored folder",
                    );
                }
            } else if (entry.isSymbolicLink() && !entry.name.startsWith(".")) {
                note(
                    relative(root, join(dir, entry.name)).split(sep).join("/"),
                    "a link, not followed",
                );
            } else if (entry.isFile()) {
                const path = join(dir, entry.name);
                const rel = relative(root, path).split(sep).join("/");

                if (wanted(rel, entry.name)) {
                    found.push(rel);
                }
            }
        }
    };

    walk(root, 0);

    // The sets of a Tokens Studio folder have names of their own (`global.json`, `brand/acme.json`): the files beside
    // `$themes.json` or `$metadata.json` are read too.
    for (const dir of new Set(
        found
            .filter((rel) => /(?:^|\/)\$(?:themes|metadata)\.json$/.test(rel))
            .map((rel) => rel.slice(0, Math.max(0, rel.lastIndexOf("/")))),
    )) {
        studioSets(root, dir, 0, found);
    }

    // A Style Dictionary config names its token files by globs: the folders they start in are read too.
    for (const rel of [...found].filter((each) =>
        SD_CONFIG_NAME.test((each.split("/").at(-1) ?? "").replace(/\.(?:json|[cm]?[jt]s)$/i, "")),
    )) {
        let text = "";

        try {
            text = readHead(join(root, ...rel.split("/")), 60_000);
        } catch {
            continue;
        }

        const dir = rel.slice(0, Math.max(0, rel.lastIndexOf("/")));
        let configs: SdConfig[] = [];

        if (rel.endsWith(".json")) {
            try {
                const root: unknown = JSON.parse(text);

                if (isObject(root) && Array.isArray(root.source) && isObject(root.platforms)) {
                    configs = [sdConfigOfJson(dir, rel, root)];
                }
            } catch {
                // Not JSON, or cut short: not a config that can be read.
            }
        } else {
            configs = sdConfigsIn(dir, rel, text);
        }

        for (const config of configs.slice(0, 8)) {
            for (const glob of [...config.include, ...config.source].slice(0, 12)) {
                const fixed = glob
                    .replace(/^\.\//, "")
                    .split("/")
                    .filter((_, at, all) => at < all.length - 1)
                    .filter((part, at, all) =>
                        all.slice(0, at + 1).every((each) => !/[*?{$]/.test(each)),
                    );

                for (const base of new Set([config.dir, ""])) {
                    const folder = [base, ...fixed].filter(Boolean).join("/");

                    if (folder !== "" || fixed.length === 0) {
                        studioSets(root, folder, 0, found);
                    }
                }
            }
        }
    }

    // A minified file (`app.min.css`) is the build of a source, not the design: it is left out when the project has style
    // files of its own, and read (last) when it has nothing else.
    const isMin = (rel: string) => /\.min\.[a-z]+$/i.test(rel);
    const own = found.filter(
        (rel) => !isMin(rel) && /\.(?:css|scss|sass|less|styl|stylus|pcss)$/i.test(rel),
    );
    const kept = own.length > 0 ? found.filter((rel) => !isMin(rel)) : found;

    for (const rel of found.filter((each) => !kept.includes(each))) {
        note(rel, "minified");
    }

    const ranked = kept
        .map((rel) => ({ rel, score: priority(rel) }))
        .sort((a, b) => b.score - a.score || a.rel.localeCompare(b.rel))
        .map((entry) => entry.rel);

    if (ranked.length > LIMITS.files) {
        partial = true;
        note(
            `${ranked.length - LIMITS.files} files`,
            `over the limit of ${LIMITS.files} files read; the lowest ranked were left out`,
        );
    }

    return { files: ranked.slice(0, LIMITS.files), partial, skipped };
}

/** The first `limit` bytes of a file as text (a stylesheet's size by default); it reads no more and never follows a link. */
export function readHead(path: string, limit: number = LIMITS.fileBytes): string {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);

    try {
        // No more than the file has (a regular file), so that a small file does not cost a large buffer.
        const buffer = Buffer.alloc(Math.min(limit, Math.max(0, fstatSync(fd).size)));
        let size = 0;

        while (size < buffer.length) {
            const read = readSync(fd, buffer, size, buffer.length - size, null);

            if (read <= 0) {
                break;
            }

            size += read;
        }

        return buffer.subarray(0, size).toString("utf8");
    } finally {
        closeSync(fd);
    }
}
