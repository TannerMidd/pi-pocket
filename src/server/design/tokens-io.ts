// A read never follows a symlink and reads at most a limit's worth of bytes of each file.
// A write renames a temporary file next to the target, so a reader never sees half a file, and a link at the target is replaced, not followed.
import { randomUUID } from "node:crypto";
import {
    closeSync,
    constants,
    fstatSync,
    lstatSync,
    mkdirSync,
    openSync,
    readdirSync,
    readFileSync,
    readSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import type { SystemProblem } from "./system-types.ts";
import { LIMITS, boundedText, type RawSystem } from "./tokens-base.ts";
import { forgetSystem } from "./tokens-cache.ts";

export const DESIGN_DIR = join(".pi", "design");

/** The system as it is on disk, with the files that could not be parsed: a write must not replace them by accident. */
export interface Folder {
    raw: RawSystem;
    broken: Set<string>;
}

// A link is an error: nothing here follows one.
function kindOf(path: string, label: string): "file" | "directory" | undefined {
    let info;

    try {
        info = lstatSync(path);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return undefined;
        }

        throw error;
    }

    if (info.isSymbolicLink()) {
        throw new Error(
            `${label} is a symlink. Pi Pocket does not follow links here: replace it with a real file or folder.`,
        );
    }

    return info.isDirectory() ? "directory" : info.isFile() ? "file" : undefined;
}

function lstatOf(path: string): ReturnType<typeof lstatSync> | undefined {
    try {
        return lstatSync(path);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return undefined;
        }

        throw error;
    }
}

function hasDesignFolder(cwd: string): boolean {
    const pi = kindOf(join(cwd, ".pi"), "The project's .pi folder");

    if (pi === undefined) {
        return false;
    }

    if (pi !== "directory") {
        throw new Error("The project's .pi path must be a folder.");
    }

    const design = kindOf(join(cwd, DESIGN_DIR), ".pi/design");

    if (design === undefined) {
        return false;
    }

    if (design !== "directory") {
        throw new Error(".pi/design must be a folder.");
    }

    return true;
}

function readHead(path: string, max: number): { bytes: Buffer; more: boolean } {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);

    try {
        if (!fstatSync(fd).isFile()) {
            throw new Error("not a regular file");
        }

        const buffer = Buffer.alloc(max + 1);
        let size = 0;

        while (size < buffer.length) {
            const read = readSync(fd, buffer, size, buffer.length - size, null);

            if (read <= 0) {
                break;
            }

            size += read;
        }

        return { bytes: buffer.subarray(0, Math.min(size, max)), more: size > max };
    } finally {
        closeSync(fd);
    }
}

const kb = (bytes: number) => `${Math.round(bytes / 1024)} KB`;

export function readFolder(cwd: string): Folder | undefined {
    if (!hasDesignFolder(cwd)) {
        return undefined;
    }

    const root = join(cwd, DESIGN_DIR);
    const problems: SystemProblem[] = [];
    const broken = new Set<string>();
    const raw: RawSystem = {
        folder: basename(cwd),
        tokens: undefined,
        modes: new Map(),
        components: new Map(),
        guidelines: "",
        problems,
    };

    const text = (name: string, max: number, whole = true): string | undefined => {
        const path = join(root, name);

        try {
            if (kindOf(path, name) !== "file") {
                broken.add(name);
                problems.push({
                    level: "error",
                    file: name,
                    message: `${name} must be a regular file.`,
                });

                return undefined;
            }

            const { bytes, more } = readHead(path, max);

            if (more && whole) {
                broken.add(name);
                problems.push({
                    level: "error",
                    file: name,
                    message: `${name} is larger than ${kb(max)}. Split it, or remove what it does not need.`,
                });

                return undefined;
            }

            return bytes.toString("utf8").replace(/^\uFEFF/, "");
        } catch (error) {
            broken.add(name);
            problems.push({
                level: "error",
                file: name,
                message: `${name} could not be read: ${(error as Error).message}`,
            });

            return undefined;
        }
    };

    const json = (name: string): { value: unknown } | undefined => {
        const source = text(name, LIMITS.tokenFileBytes);

        if (source === undefined) {
            return undefined;
        }

        try {
            return { value: JSON.parse(source) as unknown };
        } catch (error) {
            broken.add(name);
            problems.push({
                level: "error",
                file: name,
                message: `${name} is not valid JSON (${(error as Error).message}). Fix the file, or replace it with init or the tokens field.`,
            });

            return undefined;
        }
    };

    let entries;

    try {
        entries = readdirSync(root, { withFileTypes: true }).slice(0, 500);
    } catch (error) {
        throw new Error(`.pi/design could not be read: ${(error as Error).message}`);
    }

    let modeFiles = 0;

    for (const entry of entries) {
        const match = /^tokens(?:\.(.+))?\.json$/.exec(entry.name);

        if (entry.name.startsWith(".") || match === null) {
            continue;
        }

        if (match[1] !== undefined && ++modeFiles > LIMITS.modes * 2) {
            broken.add(entry.name);
            problems.push({
                level: "error",
                file: entry.name,
                message: `${entry.name} is not read: a design system has at most ${LIMITS.modes} modes.`,
            });
            continue;
        }

        const parsed = json(entry.name);

        if (parsed === undefined) {
            continue;
        }

        if (match[1] === undefined) {
            raw.tokens = parsed.value;
        } else {
            raw.modes.set(match[1], parsed.value);
        }
    }

    if (entries.some((entry) => entry.name === "guidelines.md")) {
        // Too long is cut, not refused: the prose is advice, and the rest can be read from the file.
        const source = text("guidelines.md", LIMITS.guidelinesBytes, false);

        if (source !== undefined) {
            raw.guidelines = source;

            if (Buffer.byteLength(source) >= LIMITS.guidelinesBytes) {
                problems.push({
                    level: "warning",
                    file: "guidelines.md",
                    message: `guidelines.md is ${kb(LIMITS.guidelinesBytes)} or more; the rest is not read. Keep it short.`,
                });
            }
        }
    }

    if (entries.some((entry) => entry.name === "components")) {
        try {
            if (kindOf(join(root, "components"), "components") === "directory") {
                const names = readdirSync(join(root, "components"))
                    .filter((name) => name.endsWith(".html") && !name.startsWith("."))
                    .sort();

                for (const name of names.slice(0, LIMITS.components + 1)) {
                    const source = text(`components/${name}`, LIMITS.componentBytes);

                    if (source !== undefined) {
                        raw.components.set(name.slice(0, -5), source);
                    }
                }
            }
        } catch (error) {
            problems.push({
                level: "error",
                file: "components",
                message: (error as Error).message,
            });
        }
    }

    return { raw, broken };
}

const READABLE =
    /^(?:tokens(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)?\.json|guidelines\.md|components\/[a-z0-9]+(?:-[a-z0-9]+)*\.html|dist\/(?:tokens\.css|tailwind\.css|tokens\.resolved\.json|tokens\.studio\.json|names\.md|tokens\.[a-z0-9]+(?:-[a-z0-9]+)*\.resolved\.json|components\.css))$/;

// The name must be one of the folder's own files; a link or a name with a path is refused.
export function readDesignFile(
    cwd: string,
    name: string,
    max = 60_000,
): { text: string; truncated: boolean } | undefined {
    if (!READABLE.test(name)) {
        throw new Error(
            `"${name.slice(0, 60)}" is not a file of the design system. Use tokens.json, tokens.<mode>.json, guidelines.md, components/<name>.html, or dist/tokens.css, dist/tailwind.css, dist/tokens.resolved.json, dist/tokens.studio.json, dist/names.md, dist/tokens.<mode>.resolved.json, dist/components.css.`,
        );
    }

    if (!hasDesignFolder(cwd)) {
        return undefined;
    }

    const parts = name.split("/");

    if (parts.length === 2 && kindOf(join(cwd, DESIGN_DIR, parts[0]!), parts[0]!) !== "directory") {
        return undefined;
    }

    const path = join(cwd, DESIGN_DIR, ...parts);

    if (kindOf(path, name) !== "file") {
        return undefined;
    }

    const { bytes, more } = readHead(path, max);
    const { text } = boundedText(bytes, max);

    return { text: text.replace(/^\uFEFF/, ""), truncated: more };
}

export function emptyFolder(cwd: string): Folder {
    return {
        raw: {
            folder: basename(cwd),
            tokens: undefined,
            modes: new Map(),
            components: new Map(),
            guidelines: "",
            problems: [],
        },
        broken: new Set(),
    };
}

function ensureFolder(path: string, label: string): void {
    const kind = kindOf(path, label);

    if (kind === undefined) {
        mkdirSync(path);
    } else if (kind !== "directory") {
        throw new Error(`${label} must be a folder.`);
    }
}

interface WriteResult {
    written: string[];
    removed: string[];
}

export function writeFiles(cwd: string, files: Map<string, string | null>): WriteResult {
    const result: WriteResult = { written: [], removed: [] };

    forgetSystem(cwd);
    ensureFolder(join(cwd, ".pi"), "The project's .pi folder");
    ensureFolder(join(cwd, DESIGN_DIR), ".pi/design");

    const root = join(cwd, DESIGN_DIR);

    for (const [name, content] of files) {
        const parts = name.split("/");
        const dir = parts.length === 2 ? join(root, parts[0]!) : root;
        const path = join(root, ...parts);

        if (
            parts.length > 2 ||
            parts.some(
                (part) => part === "" || part === "." || part === ".." || part.startsWith("."),
            )
        ) {
            throw new Error(`Refusing to write ${name}.`);
        }

        // Check the parent for removals too: O_NOFOLLOW on the final name cannot protect it.
        if (parts.length === 2) {
            if (content === null) {
                const kind = kindOf(dir, parts[0]!);

                if (kind === undefined) {
                    continue;
                }

                if (kind !== "directory") {
                    throw new Error(`${parts[0]!} must be a folder.`);
                }
            } else {
                ensureFolder(dir, parts[0]!);
            }
        }

        // A link at the file itself is replaced or removed as a link; nothing writes through it.
        const present = lstatOf(path);

        if (content === null) {
            if (present !== undefined && !present.isDirectory()) {
                rmSync(path);
                result.removed.push(name);
            }

            continue;
        }

        const bytes = Buffer.from(content, "utf8");

        // The same bytes again: leave the file (and its time) alone.
        try {
            if (
                present?.isFile() === true &&
                present.size === bytes.length &&
                readFileSync(path).equals(bytes)
            ) {
                continue;
            }
        } catch {
            // Unreadable counts as different: the write below replaces it.
        }

        // A fresh name each time, in the same folder: the rename stays on one file system.
        const temp = join(dir, `.${randomUUID()}.tmp`);

        try {
            writeFileSync(temp, bytes, { flag: "wx" });
            renameSync(temp, path);
        } finally {
            rmSync(temp, { force: true });
        }

        result.written.push(name);
    }

    return result;
}
