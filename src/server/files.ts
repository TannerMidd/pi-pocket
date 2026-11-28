/**
 * The files in a session's folder, for `@` mentions in the message box. In a git repository the list is git's: the
 * tracked files and the untracked ones it does not ignore. Elsewhere it is a walk of the folder that skips hidden and
 * dependency folders. Only unrestricted tabs share a cached list. Each list carries a version so a browser that
 * has the newest one hears only that, and is compressed on demand. Browsers match the list
 * themselves as people type: typing never waits on the network.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { lstat, open, opendir, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { setImmediate } from "node:timers/promises";
import { promisify } from "node:util";
import { gzip as gzipCallback } from "node:zlib";
import { git } from "./git.ts";
import { type ReadableFile, withUploadBytes } from "./upload-content.ts";

const gzip = promisify(gzipCallback);
const exec = promisify(execFile);

/** The most files a list holds. Past it, the files nearest the folder's top are kept. */
export const MAX_FILES = 100_000;
/**
 * The most files a walk outside git finds, and how long it may take. The count stops it first on a local disk, so an
 * unchanged folder gives the same list (and version) each time; the time is for slow ones.
 */
const WALK_FILES = 50_000;
const WALK_MS = 3_000;
/** A separate work budget for restricted reads, including denied and absent candidates. */
const SCAN_ENTRIES = 2 * MAX_FILES;
/** A list is fresh for ten times what it took to make, within these bounds: a slow walk is not repeated every keystroke. */
const FRESH_MIN_MS = 2_000;
const FRESH_MAX_MS = 60_000;
/** How many folders' lists are kept. */
const KEEP = 16;
/** Folders a walk outside git skips: dependencies and build caches, which can hold more files than everything else. */
const SKIP = new Set([
    "node_modules",
    "__pycache__",
    "bower_components",
    "venv",
    "site-packages",
    "target",
    "dist-newstyle",
]);

export type FileFilter = {
    /** The canonical workspace encloses no protected roots. Git can discover names, but each still needs `allow`. */
    ordinaryTree?: boolean;
    /** Whether a file can be listed. Both callbacks take absolute paths. */
    allow: (path: string) => boolean | Promise<boolean>;
    /** Empty to prune, known basenames to probe without enumerating, or undefined to enumerate. */
    children: (dir: string) => readonly string[] | undefined;
};

export type FileList = {
    /** Paths relative to the folder, with `/` between parts. */
    files: string[];
    /** True when the folder has more files than the list holds. */
    truncated: boolean;
    /** Changes whenever the list does. */
    version: string;
};

/** A list as it is sent: its JSON, and the same compressed when a browser first asks for that. */
export type FileListing = FileList & { json: string; gzipped(): Promise<Buffer> };

type Entry = { at: number; freshFor: number; listing: Promise<FileListing> };

/** The files git lists in `cwd`, or undefined when it is not in a repository (or git is not installed, or failed). */
async function gitFiles(cwd: string, timeoutMs = 10_000): Promise<string | undefined> {
    try {
        // Past this much, a walk (which stops at its own limits) does instead.
        const out = await git(
            cwd,
            ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
            { timeoutMs, maxBuffer: 32 * 1024 * 1024 },
        );

        // A folder git ignores entirely, inside a repository, is still worth a walk.
        return out === "" ? undefined : out;
    } catch {
        return undefined;
    }
}

/** How many entries past what fits a walk reads of one folder: room for its subfolders. */
const DIR_EXTRA = 1000;

/**
 * At most `limit` entries of a folder, read as they come: a folder of a million files costs no more than `limit`.
 * `more` says some were left. Stops early, with `more`, past `deadline`.
 */
async function readSome(
    path: string,
    limit: number,
    deadline = Number.POSITIVE_INFINITY,
    allow?: FileFilter["allow"],
): Promise<{ entries: Dirent[]; more: boolean }> {
    const entries: Dirent[] = [];
    const dir = await opendir(path, { bufferSize: 256 });
    let scanned = 0;

    // Leaving the loop early closes the folder.
    for await (const entry of dir) {
        if (++scanned > SCAN_ENTRIES || Date.now() > deadline) {
            return { entries, more: true };
        }

        if (allow !== undefined && !(await allow(join(path, entry.name)))) {
            continue;
        }

        if (entries.length >= limit) {
            return { entries, more: true };
        }

        entries.push(entry);
    }

    return { entries, more: false };
}

/** The files under `cwd`, nearest first, without hidden folders or `SKIP`: at most `max`, found within `ms`. */
async function walkFiles(
    cwd: string,
    max: number,
    ms: number,
): Promise<{ files: string[]; truncated: boolean }> {
    const deadline = Date.now() + ms;
    const files: string[] = [];
    const queue = [""];
    let truncated = false;

    for (let index = 0; index < queue.length; index++) {
        if (files.length >= max || Date.now() > deadline) {
            return { files, truncated: true };
        }

        const dir = queue[index]!;
        let read;

        try {
            read = await readSome(
                dir === "" ? cwd : `${cwd}/${dir}`,
                max - files.length + DIR_EXTRA,
                deadline,
            );
        } catch {
            continue;
        }

        if (read.more) {
            truncated = true;
        }

        read.entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

        for (const entry of read.entries) {
            const path = dir === "" ? entry.name : `${dir}/${entry.name}`;

            // Linked folders are not followed: they can lead back up, or anywhere. The queue holds no more than fits.
            if (entry.isDirectory()) {
                if (
                    !entry.name.startsWith(".") &&
                    !SKIP.has(entry.name) &&
                    queue.length - index <= max
                ) {
                    queue.push(path);
                }
            } else if (files.length < max) {
                files.push(path);
            } else {
                return { files, truncated: true };
            }
        }
    }

    return { files, truncated };
}

/** At most `max` of `files`, the ones nearest the top first when some must go. */
function nearest(files: string[], max: number): { files: string[]; truncated: boolean } {
    if (files.length <= max) {
        return { files, truncated: false };
    }

    const depth = (path: string) => {
        let count = 0;

        for (let index = path.indexOf("/"); index !== -1; index = path.indexOf("/", index + 1)) {
            count++;
        }

        return count;
    };

    const kept = files
        .map((path) => ({ path, depth: depth(path) }))
        .sort((a, b) => a.depth - b.depth || (a.path < b.path ? -1 : 1))
        .slice(0, max)
        .map((each) => each.path)
        .sort();

    return { files: kept, truncated: true };
}

type WalkEntry = { name: string; dir: boolean };

/** A partial directory is never opened. Even a missing candidate consumes one unit of scan work. */
async function* candidates(
    dir: string,
    known: readonly string[] | undefined,
): AsyncGenerator<WalkEntry | undefined> {
    if (known === undefined) {
        const folder = await opendir(dir, { bufferSize: 256 });

        for await (const entry of folder) {
            yield { name: entry.name, dir: entry.isDirectory() };
        }
    } else {
        const seen = new Set<string>();

        for (const name of known) {
            if (
                !name ||
                basename(name) !== name ||
                name === "." ||
                name === ".." ||
                seen.has(name)
            ) {
                yield undefined;
                continue;
            }

            seen.add(name);
            const info = await lstat(join(dir, name)).catch(() => undefined);

            yield info && { name, dir: info.isDirectory() };
        }
    }
}

/** Check only these candidates, without asking git to discover any files. NULs preserve every filename. */
async function ignoredFiles(dir: string, names: string[], deadline: number): Promise<Set<string>> {
    const command = exec(
        "git",
        ["--no-literal-pathspecs", "-c", "core.fsmonitor=false", "check-ignore", "-z", "--stdin"],
        {
            cwd: dir,
            timeout: Math.max(1, deadline - Date.now()),
            env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
        },
    );

    // Git may exit before consuming stdin; the command promise reports its error.
    command.child.stdin!.on("error", () => {});
    command.child.stdin!.end(names.map((name) => `./${name}\0`).join(""));

    try {
        const { stdout } = await command;

        return new Set(stdout.split("\0").map((path) => path.slice(2)));
    } catch (error) {
        if ((error as { code?: number }).code === 1) {
            return new Set();
        }

        throw error;
    }
}

/** A bounded breadth-first walk. A denied name spends scan work, never a result slot. */
async function filteredFiles(cwd: string, max: number, filter: FileFilter) {
    const files: string[] = [];
    const deadline = Date.now() + WALK_MS;
    const root = resolve(cwd);

    if (filter.children(root)?.length === 0) {
        return { files, truncated: false };
    }

    const repository =
        (
            await git(root, ["rev-parse", "--is-inside-work-tree"], { timeoutMs: WALK_MS }).catch(
                () => "",
            )
        ).trim() === "true";
    const visibleLimit = repository ? max : Math.min(max, WALK_FILES);
    const queue = [""];
    let scanned = 0;

    for (let i = 0; i < queue.length; i++) {
        if (Date.now() > deadline) {
            return { files, truncated: true };
        }

        const prefix = queue[i]!;
        const dir = join(root, prefix);
        const known = filter.children(dir);

        if (known?.length === 0) {
            continue;
        }

        // Git does not recurse into another worktree (including a checked-out submodule).
        if (
            repository &&
            prefix !== "" &&
            known === undefined &&
            (await lstat(join(dir, ".git")).catch(() => undefined))
        ) {
            continue;
        }

        const fileStart = files.length;
        const folderStart = queue.length;
        const batch: WalkEntry[] = [];

        const flush = async (): Promise<boolean> => {
            const ignored =
                repository && batch.length !== 0
                    ? await ignoredFiles(
                          dir,
                          batch.map((entry) => entry.name),
                          deadline,
                      )
                    : undefined;

            for (const entry of batch) {
                if (ignored?.has(entry.name)) {
                    continue;
                }

                const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;

                if (entry.dir) {
                    queue.push(path);
                } else if (files.length < visibleLimit) {
                    files.push(path);
                } else {
                    return false;
                }
            }

            batch.length = 0;

            return true;
        };

        try {
            for await (const entry of candidates(dir, known)) {
                if (++scanned > SCAN_ENTRIES || Date.now() > deadline) {
                    await flush();

                    return { files, truncated: true };
                }

                if (!entry || (repository && entry.name === ".git")) {
                    continue;
                }

                if (entry.dir) {
                    if (!repository && (entry.name.startsWith(".") || SKIP.has(entry.name))) {
                        continue;
                    }

                    if (filter.children(join(dir, entry.name))?.length === 0) {
                        continue;
                    }
                } else if (!(await filter.allow(join(dir, entry.name)))) {
                    continue;
                }

                batch.push(entry);

                if (batch.length === 512 && !(await flush())) {
                    return { files, truncated: true };
                }
            }

            if (!(await flush())) {
                return { files, truncated: true };
            }
        } catch (error) {
            if (Date.now() >= deadline || (error as { killed?: boolean }).killed === true) {
                return { files, truncated: true };
            }

            if (
                ["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(
                    (error as NodeJS.ErrnoException).code ?? "",
                )
            ) {
                continue;
            }

            throw error;
        } finally {
            sortFrom(files, fileStart);
            sortFrom(queue, folderStart);
        }
    }

    return { files, truncated: false };
}

/** Preserve native Git order (including tracked after untracked) until the result limit requires `nearest`. */
async function fromGit(output: string, root: string, max: number, filter?: FileFilter) {
    const files = new Set<string>();
    const deadline = Date.now() + WALK_MS;
    let scanned = 0;
    let start = 0;

    while (start < output.length) {
        if (filter !== undefined) {
            if (++scanned > SCAN_ENTRIES || Date.now() > deadline) {
                return { files: nearest([...files], max).files, truncated: true };
            }

            // The filesystem boundary check is synchronous. Give other requests a turn between batches.
            if (scanned % 256 === 0) {
                await setImmediate();
            }
        }

        const end = output.indexOf("\0", start);

        if (end === -1) {
            break;
        }

        const path = output.slice(start, end);

        if (!filter || (await filter.allow(join(root, path)))) {
            // A conflicted file is listed once per stage.
            files.add(path);
        }

        start = end + 1;
    }

    return nearest([...files], max);
}

/** Keep the unrestricted walk's order: siblings sorted by name, directories visited breadth first. */
function sortFrom(paths: string[], start: number): void {
    if (paths.length > start + 1) {
        const sorted = paths.slice(start).sort();

        for (const path of sorted) {
            paths[start++] = path;
        }
    }
}

/** The files in `cwd`, filtered before computing the version of a restricted listing. */
export async function listFiles(
    cwd: string,
    max = MAX_FILES,
    filter?: FileFilter,
): Promise<FileList> {
    const root = resolve(cwd);
    const ordinary =
        filter === undefined || (filter.ordinaryTree && filter.children(root) === undefined);
    const listed = ordinary ? await gitFiles(root, filter && WALK_MS) : undefined;
    const { files, truncated } =
        listed !== undefined
            ? await fromGit(listed, root, max, filter)
            : filter !== undefined
              ? await filteredFiles(root, ordinary ? Math.min(max, WALK_FILES) : max, filter)
              : await walkFiles(root, Math.min(max, WALK_FILES), WALK_MS);

    const version = createHash("sha1")
        .update(files.join("\0"))
        .update(truncated ? "+" : "")
        .digest("base64url")
        .slice(0, 16);

    return { files, truncated, version };
}

/** Lists of files by folder, made at most once at a time per folder and kept while fresh. */
export class FileLists {
    readonly #lists = new Map<string, Entry>();
    readonly #now: () => number;

    constructor(now: () => number = Date.now) {
        this.#now = now;
    }

    /** Only unrestricted callers share an in-flight or cached list. */
    get(cwd: string, filter?: FileFilter): Promise<FileListing> {
        if (filter !== undefined) {
            return this.#make(cwd, filter);
        }

        const kept = this.#lists.get(cwd);
        const now = this.#now();

        if (kept !== undefined && now - kept.at < kept.freshFor) {
            return kept.listing;
        }

        const entry: Entry = {
            at: now,
            freshFor: Number.POSITIVE_INFINITY,
            listing: this.#make(cwd),
        };

        this.#lists.delete(cwd);
        this.#lists.set(cwd, entry);

        for (const key of this.#lists.keys()) {
            if (this.#lists.size <= KEEP) {
                break;
            }

            this.#lists.delete(key);
        }

        // Fresh from when it is done, for ten times what it took; a failure is not kept.
        entry.listing.then(
            () => {
                entry.freshFor = Math.min(
                    FRESH_MAX_MS,
                    Math.max(FRESH_MIN_MS, (this.#now() - now) * 10),
                );
                entry.at = this.#now();
            },
            () => this.#lists.get(cwd) === entry && this.#lists.delete(cwd),
        );

        return entry.listing;
    }

    async #make(cwd: string, filter?: FileFilter): Promise<FileListing> {
        const list = await listFiles(cwd, MAX_FILES, filter);
        const json = JSON.stringify(list);
        let compressed: Promise<Buffer> | undefined;

        return { ...list, json, gzipped: () => (compressed ??= gzip(json, { level: 6 })) };
    }
}

/** How much of a file the viewer shows, and of a folder. */
const VIEW_BYTES = 512 * 1024;
const VIEW_ENTRIES = 1000;
const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i;

/** A file as the viewer shows it: text, an image (loaded through the image route), a folder's entries, binary, or other (a pipe, a device). */
export type FileView =
    | { kind: "text"; size: number; text: string; truncated: boolean }
    | { kind: "image" | "binary" | "other"; size: number }
    | { kind: "folder"; entries: { name: string; dir: boolean }[]; truncated: boolean };

function viewBytes(file: string, buffer: Buffer, size = buffer.length): FileView {
    if (IMAGE_EXTENSIONS.test(file)) {
        return { kind: "image", size };
    }

    const bytes = buffer.subarray(0, VIEW_BYTES);

    if (bytes.subarray(0, 8000).includes(0)) {
        return { kind: "binary", size };
    }

    return { kind: "text", size, text: bytes.toString("utf8"), truncated: size > bytes.length };
}

/** What the viewer shows of `file`. Throws when it is not there. */
export async function viewFile(file: ReadableFile, allow?: FileFilter["allow"]): Promise<FileView> {
    if (typeof file !== "string") {
        return withUploadBytes(file, async (bytes) => viewBytes(file.path, bytes));
    }

    const info = await stat(file);

    if (info.isDirectory()) {
        const { entries, more } = await readSome(
            resolve(file),
            VIEW_ENTRIES,
            allow && Date.now() + WALK_MS,
            allow,
        );
        const listed = entries
            .map((entry) => ({ name: entry.name, dir: entry.isDirectory() }))
            .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));

        return { kind: "folder", entries: listed, truncated: more };
    }

    // A pipe or a device would never finish reading: only regular files are opened.
    if (!info.isFile()) {
        return { kind: "other", size: info.size };
    }

    if (IMAGE_EXTENSIONS.test(file)) {
        return { kind: "image", size: info.size };
    }

    const handle = await open(file, "r");

    try {
        const buffer = Buffer.alloc(Math.min(info.size, VIEW_BYTES));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);

        return viewBytes(file, buffer.subarray(0, bytesRead), info.size);
    } finally {
        await handle.close();
    }
}

/**
 * The files `@` mentions in a message name, as the message box writes them: `@src/app.ts`, or `@"my file.txt"` with
 * spaces. Each comes with the paths it may mean, best first: as written, then without the punctuation that may end a
 * sentence after it ("look at @app.ts."). One in a quote ("> …" lines, a passage Reply quoted) is the passage's, not a
 * file the person asks to send along.
 */
export function mentionedPaths(text: string): { written: string; candidates: string[] }[] {
    const found: { written: string; candidates: string[] }[] = [];
    const own = text
        .split("\n")
        .filter((line) => !/^ {0,3}>/.test(line))
        .join("\n");

    for (const match of own.matchAll(/(?:^|[\s([{])@(?:"([^"\n]+)"|([^\s"]+))/g)) {
        const written = match[1] ?? match[2]!;

        if (found.some((each) => each.written === written)) {
            continue;
        }

        const trimmed = match[1] === undefined ? written.replace(/[.,;:!?)\]}'`]+$/, "") : written;

        found.push({
            written,
            candidates: trimmed === written || trimmed === "" ? [written] : [written, trimmed],
        });
    }

    return found;
}
