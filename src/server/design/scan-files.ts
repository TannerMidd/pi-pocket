// The walk never follows a symlink, so a project cannot lead it out of the folder.
import {
    closeSync,
    constants,
    type Dirent,
    fstatSync,
    lstatSync,
    openSync,
    readdirSync,
    readSync,
} from "node:fs";
import { extname, join, relative, sep } from "node:path";

const SKIP = new Set(
    `node_modules .git dist build out coverage .next .nuxt .svelte-kit .cache .turbo
    .parcel-cache .output .vercel .netlify .yarn .pnpm-store .venv venv __pycache__ target
    vendor vendors third_party third-party thirdparty bower_components exports
    storybook-static .pi .idea .vscode .github .husky`.split(/\s+/),
);

const FOLDER_WHY: [RegExp, string][] = [
    [/^(?:node_modules|vendors?|bower_components|third[-_]?party)$/i, "vendored code"],
    [/^(?:dist|build|out|coverage|target|exports|storybook-static)$/i, "build output"],
];

export interface Skipped {
    path: string;
    why: string;
}

const DOT_STYLE_FOLDERS = new Set([".storybook", ".vitepress", ".vuepress", ".docusaurus"]);

const STYLE =
    /\.(?:css|scss|less|pcss|postcss|html?|vue|svelte|astro|mdx|tsx|jsx|ts|js|mjs|cjs|mts|cts)$/i;
const TOKEN_JSON =
    /(?:^|\/)(?:design-?tokens?|tokens?|properties|brands?|themes?|style-?dictionary|dictionary)\/(?:[^/]+\/)*[^/]+\.json$|(?:^|\/)(?:[^/]*tokens?[^/]*|[^/]*theme[^/]*|[^/]*(?:figma|studio|design-?system)[^/]*)\.json$|(?:^|\/)styles\/[^/]+\.json$|(?:^|\/)\$(?:themes|metadata)\.json$/i;

export const LIMITS = {
    files: 400,
    candidates: 3000,
    entries: 20_000,
    depth: 8,
    fileBytes: 200_000,
    /** Bytes read from one token file: a Tokens Studio file of a large system is more than a stylesheet. */
    jsonBytes: 1_500_000,
    totalBytes: 8_000_000,
    valueChars: 200,
} as const;

const EXTENSION_SCORE: [RegExp, number][] = [
    [/^\.(?:css|scss|less|pcss|postcss)$/, 40],
    [/^\.json$/, 45],
    [/^\.(?:[cm]?[jt]s)$/, 20],
    [/^\.(?:html?|vue|svelte|astro|mdx)$/, 25],
];

const PATH_SCORE: [RegExp, number][] = [
    [
        /(?:^|\/)(?:tailwind\.config|theme|tokens?|variables|vars|globals?|global|base|colors?|palette|design|root|index|main|app|styles?)(?:[.\-_/]|$)/,
        20,
    ],
    [/(?:^|\/)(?:theme|themes|tokens|styles|css|design|assets\/css)\//, 8],
    [/\.min\.|(?:^|\/)(?:vendor|third[-_]?party|generated|__generated__)\/|\.d\.ts$/, -40],
    [/\.(?:test|spec|stories)\.|(?:^|\/)(?:__tests__|e2e|fixtures?)\//, -10],
];

export function priority(rel: string): number {
    const lower = rel.toLowerCase();
    const extension = extname(lower);
    let score = EXTENSION_SCORE.find(([pattern]) => pattern.test(extension))?.[1] ?? 12;

    for (const [pattern, points] of PATH_SCORE) {
        score += pattern.test(lower) ? points : 0;
    }

    if (/(?:^|\/)\$(?:themes|metadata)\.json$/.test(rel)) {
        score += 30;
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

const wanted = (rel: string, name: string) =>
    STYLE.test(name) ? !name.endsWith(".d.ts") : TOKEN_JSON.test(rel) && name.endsWith(".json");

function sortedEntries(dir: string): Dirent[] {
    try {
        return readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
            a.name.localeCompare(b.name),
        );
    } catch {
        return [];
    }
}

// A project's config names such folders; none may lead the scan out of the project (no `..`, no absolute path, no symlink).
export function folderInside(root: string, dir: string): boolean {
    let path = root;

    for (const part of dir === "" ? [] : dir.split("/")) {
        if (part === "" || part === "." || part === ".." || part.includes("\\")) {
            return false;
        }

        path = join(path, part);

        try {
            const info = lstatSync(path);

            if (info.isSymbolicLink() || !info.isDirectory()) {
                return false;
            }
        } catch {
            return false;
        }
    }

    return true;
}

function studioSets(root: string, dir: string, depth: number, found: string[]): void {
    if (!folderInside(root, dir)) {
        return;
    }

    for (const entry of sortedEntries(join(root, dir))) {
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
        for (const entry of sortedEntries(dir)) {
            if (found.length >= LIMITS.candidates || ++seen > LIMITS.entries) {
                partial = true;

                return;
            }

            const path = join(dir, entry.name);
            const rel = relative(root, path).split(sep).join("/");
            const hidden = entry.name.startsWith(".");

            // Dirent reports a symlink as a symlink, not as its target: neither branch below takes one.
            if (entry.isDirectory()) {
                const skip = SKIP.has(entry.name) || (hidden && !DOT_STYLE_FOLDERS.has(entry.name));

                if (!skip && depth < LIMITS.depth) {
                    walk(path, depth + 1);
                } else if (!skip) {
                    partial = true;
                    note(`${rel}/`, `deeper than ${LIMITS.depth} levels`);
                } else if (!hidden) {
                    const why = FOLDER_WHY.find(([pattern]) => pattern.test(entry.name))?.[1];

                    note(`${rel}/`, why ?? "ignored folder");
                }
            } else if (entry.isSymbolicLink() && !hidden) {
                note(rel, "a link, not followed");
            } else if (entry.isFile() && wanted(rel, entry.name)) {
                found.push(rel);
            }
        }
    };

    walk(root, 0);

    for (const dir of new Set(
        found
            .filter((rel) => /(?:^|\/)\$(?:themes|metadata)\.json$/.test(rel))
            .map((rel) => rel.slice(0, Math.max(0, rel.lastIndexOf("/")))),
    )) {
        studioSets(root, dir, 0, found);
    }

    const isMin = (rel: string) => /\.min\.[a-z]+$/i.test(rel);
    const own = found.filter((rel) => !isMin(rel) && /\.(?:css|scss|less|pcss)$/i.test(rel));
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

/** Reads no more than `limit` bytes and never follows a link. */
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
