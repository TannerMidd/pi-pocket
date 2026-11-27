/**
 * Using the folder of a sandboxed session as the host, without leaving it. The folder is untrusted, as a cloned
 * repository is: a guest may leave a link in it that names `~/.ssh/id_rsa`, and may swap a folder for a link at any
 * moment, so a check of a path followed by a use of the path is not safe. Here a path is walked one name at a time,
 * from the folder's own descriptor, and each name is opened without following a link (`/proc/self/fd/<dir>/<name>` is
 * `openat` on Linux). A link anywhere on the way fails the call: nothing in such a folder is reached through one.
 * Where this system has no such primitive, the call fails with a message; it never falls back to the path.
 */
import {
    closeSync,
    constants,
    lstatSync,
    mkdirSync,
    fstatSync,
    openSync,
    opendirSync,
    readFileSync,
    readlinkSync,
    realpathSync,
    renameSync,
    statSync,
    unlinkSync,
    writeSync,
} from "node:fs";
import { open, readdir, stat, type FileHandle } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const READ = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | NO_FOLLOW;
const FOLDER = constants.O_RDONLY | constants.O_DIRECTORY | NO_FOLLOW;

const sandboxedFolders = new Set<() => Iterable<string>>();

/** A server says which folders sandboxed sessions work in, as their stated paths. Returns how to stop. */
export function onSandboxedFolders(list: () => Iterable<string>): () => void {
    sandboxedFolders.add(list);

    return () => void sandboxedFolders.delete(list);
}

function real(path: string): string {
    try {
        return realpathSync(path);
    } catch {
        return resolve(path);
    }
}

type Place = { start: string; names: string[] };
type Folder = { path: string; key: string };

function listed(): Folder[] {
    return [...sandboxedFolders]
        .flatMap((list) => [...list()])
        .flatMap((path) => {
            try {
                const { dev, ino } = statSync(path, { bigint: true });

                return [{ path, key: `${dev}:${ino}` }];
            } catch {
                return [];
            }
        });
}

/**
 * Walk `path` from `/`, one name at a time, following links, until the walk is in one of `folders`, known by the device
 * and the inode of the folder and not by any path to it, so an alias, or a mount of the same folder, finds it too. It
 * answers where it entered, and the names still to go; or, when it never did, the real path it came to (undefined when
 * a name is not there). Every folder on the way counts, so a link that passes through a folder is found as well.
 */
function walk(
    path: string,
    folders: readonly Folder[],
): { entered: Place } | { at: string | undefined } {
    const top = parse(resolve(path)).root;
    const pending = resolve(path).slice(top.length).split(sep).filter(Boolean);
    let at = top;

    for (let links = 0; pending.length > 0;) {
        const name = pending.shift()!;

        if (name === ".") {
            continue;
        }

        if (name === "..") {
            at = dirname(at);
            continue;
        }

        const next = join(at, name);
        let info;

        try {
            info = lstatSync(next, { bigint: true });
        } catch {
            return { at: undefined };
        }

        if (info.isSymbolicLink()) {
            if (++links > 40) {
                return { at: undefined };
            }

            const target = readlinkSync(next);
            const start = isAbsolute(target) ? parse(target).root : at;

            pending.unshift(
                ...target
                    .slice(isAbsolute(target) ? start.length : 0)
                    .split(sep)
                    .filter(Boolean),
            );
            at = start;
            continue;
        }

        at = next;
        const inside = folders.find((each) => each.key === `${info.dev}:${info.ino}`);

        if (inside !== undefined) {
            return { entered: { start: inside.path, names: pending } };
        }
    }

    return { at };
}

/**
 * How a session's folder `root` stands to the folders that sandboxed sessions work in: inside one (then `start` is that
 * folder, and `names` lead from it to `root`), holding one (then `start` is `root`), or neither (undefined). A link is
 * followed only while the walk is outside every sandboxed folder, where the guest cannot have put it; the names after
 * the walk is inside are not looked at: the walk of `pinParent` takes them without following a link, and refuses one.
 */
function place(root: string): Place | undefined {
    const folders = listed();
    const found = walk(root, folders);

    if ("entered" in found) {
        return found.entered;
    }

    return found.at !== undefined && folders.some((each) => within(found.at!, real(each.path)))
        ? { start: found.at, names: [] }
        : undefined;
}

/** Whether `path` is in a folder that a sandboxed session works in, as the walk finds it: a guest may write it. */
export function inSandboxedFolder(path: string): boolean {
    const folders = listed();

    return folders.length > 0 && "entered" in walk(path, folders);
}

/** What a look for links into a folder found: a link, or why the look did not finish. */
export type LinkFound = { link: string } | { unfinished: string };

/**
 * A link under `roots` (or a root that is one) that leads into `folder`, or through it. These are the places that the
 * server, or Pi, loads code and trusted settings from: a guest that can write the folder would write there. Each link
 * is walked, every name on its way, with the folder known by its inode. The roots are walked whole; a link to a folder
 * outside brings that folder in as well (once, whichever way it is reached), and the links in it are walked. A look
 * that does not finish (more than `limit` entries, more than `ms` milliseconds, or a
 * folder that cannot be read) is not clean: it answers why it stopped, and the caller refuses. Undefined: none, and done.
 */
export async function linkInto(
    roots: readonly string[],
    folder: string,
    { limit = 250_000, ms = 20_000 } = {},
): Promise<LinkFound | undefined> {
    let key: string;

    try {
        const { dev, ino } = statSync(folder, { bigint: true });

        key = `${dev}:${ino}`;
    } catch {
        return undefined;
    }

    const folders = [{ path: folder, key }];
    const deadline = Date.now() + ms;
    // Each folder is looked at once, whichever way it is reached: a link in a loop ends the walk of it.
    const seen = new Set<string>();
    let looked = 0;

    for (const root of roots) {
        // The place is the folder, or is in it, or leads into it; or it holds the folder, and what it loads of its own
        // reaches the folder's files (a skills folder loads every `SKILL.md` below it).
        if ("entered" in walk(root, folders)) {
            return { link: root };
        }

        try {
            const { dev, ino } = await stat(root, { bigint: true });

            if ("entered" in walk(folder, [{ path: root, key: `${dev}:${ino}` }])) {
                return { link: root };
            }
        } catch {
            // Not there (yet): nothing of the folder is in it.
        }

        const pending = [root];

        for (let path = pending.pop(); path !== undefined; path = pending.pop()) {
            if (Date.now() > deadline) {
                return { unfinished: `it took more than ${ms / 1000} seconds` };
            }

            let entries;

            try {
                const info = await stat(path, { bigint: true });
                const id = `${info.dev}:${info.ino}`;

                // What a link names may be a file: its link has been walked. A folder is looked at once.
                if (!info.isDirectory() || seen.has(id)) {
                    continue;
                }

                seen.add(id);
                entries = await readdir(path, { withFileTypes: true });
            } catch (error) {
                // A root that is not there has nothing in it; a folder that cannot be read may hold anything.
                if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                    continue;
                }

                return {
                    unfinished: `${path} cannot be read (${(error as NodeJS.ErrnoException).code})`,
                };
            }

            for (const entry of entries) {
                if (++looked > limit) {
                    return { unfinished: `there are more than ${limit} entries` };
                }

                const child = join(path, entry.name);

                if (entry.isSymbolicLink()) {
                    const found = walk(child, folders);

                    if ("entered" in found) {
                        return { link: child };
                    }

                    // A link to a folder outside brings that folder's content under the trusted place, links in it too.
                    if (found.at !== undefined) {
                        pending.push(found.at);
                    }
                } else if (entry.isDirectory()) {
                    pending.push(child);
                }
            }
        }
    }

    return undefined;
}

/** Whether a sandboxed session works in `folder`, in a folder that holds it, or in one inside it (`place`). */
export function sandboxedFolder(folder: string): boolean {
    return place(folder) !== undefined;
}

/** Where the walk to `path` in `root` starts, and the names it takes from there. */
function route(root: string, path: string): { start: string; parts: string[] } {
    const into = names(root, path);
    const at = place(root) ?? { start: root, names: [] };
    const parts = [...at.names, ...into];

    if (parts.includes("..")) {
        throw refused(path);
    }

    return { start: at.start, parts: parts.filter((part) => part !== ".") };
}

/**
 * Whether a read of `path` must stay in `folder`: it lies there, and a sandboxed session uses the folder. Of a folder
 * that only ordinary sessions use, Pi has the whole machine anyway, and links in it (a shared `AGENTS.md`) work.
 */
export function confines(folder: string, path: string): boolean {
    return within(folder, path) && sandboxedFolder(folder);
}

/** Whether `path` is `root` or lies in it, by name. */
export function within(root: string, path: string): boolean {
    const from = relative(resolve(root), resolve(path));

    return from === "" || (from !== ".." && !from.startsWith(`..${sep}`) && !isAbsolute(from));
}

function refused(path: string): NodeJS.ErrnoException {
    return Object.assign(
        new Error(
            `EACCES: ${path} is, or passes through, a link, which is not followed in this folder`,
        ),
        { code: "EACCES", path },
    );
}

/** The entry of the folder that descriptor `dir` holds. */
const entry = (dir: number, name?: string) =>
    `/proc/self/fd/${dir}${name === undefined ? "" : `/${name}`}`;

/** The names from `root` to `path`; throws when `path` is not in `root`. */
function names(root: string, path: string): string[] {
    if (!within(root, path)) {
        throw refused(path);
    }

    const from = relative(resolve(root), resolve(path));

    return from === "" ? [] : from.split(sep);
}

/** Run `step`, which opens a name without following a link: a link in its place fails as a refusal. */
function noLink<T>(path: string, step: () => T): T {
    try {
        return step();
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;

        throw code === "ELOOP" || code === "ENOTDIR" ? refused(path) : error;
    }
}

/** The folder `root` itself, open: where each walk starts. */
function pinRoot(root: string): number {
    if (process.platform !== "linux") {
        throw Object.assign(
            new Error(
                "EOPNOTSUPP: this system cannot open a name inside the folder of a sandboxed session safely, so Pi Pocket does not use it from the host here. Use Linux, or turn the session's sandbox off.",
            ),
            { code: "EOPNOTSUPP" },
        );
    }

    return openSync(realpathSync(root), FOLDER);
}

/**
 * The folder that holds `path` in `root`, open, and the name in it (`make`: the folders on the way are made when they
 * are missing). The caller closes the descriptor.
 */
function pinParent(root: string, path: string, make = false): { dir: number; name: string } {
    const { start, parts } = route(root, path);

    if (parts.length === 0) {
        throw refused(path);
    }

    let dir = pinRoot(start);

    try {
        for (const part of parts.slice(0, -1)) {
            const at = entry(dir, part);
            const next = noLink(path, () => {
                try {
                    return openSync(at, FOLDER);
                } catch (error) {
                    if (!make || (error as NodeJS.ErrnoException).code !== "ENOENT") {
                        throw error;
                    }

                    mkdirSync(at);

                    return openSync(at, FOLDER);
                }
            });

            closeSync(dir);
            dir = next;
        }

        return { dir, name: parts.at(-1)! };
    } catch (error) {
        closeSync(dir);

        throw error;
    }
}

/** `path` in `root`, open for reading (a file or a folder), as a descriptor: the caller closes it. */
export function openInsideSync(root: string, path: string): number {
    const { start, parts } = route(root, path);

    if (parts.length === 0) {
        return pinRoot(start);
    }

    const { dir, name } = pinParent(root, path);

    try {
        return noLink(path, () => openSync(entry(dir, name), READ));
    } finally {
        closeSync(dir);
    }
}

/** The most that a file read for the prompt may hold (a skill, an `AGENTS.md`, a prompt template), and entries of a folder. */
export const MAX_TEXT = 1024 * 1024;
export const MAX_ENTRIES = 1000;

/**
 * What `readFileSync(path)` gives, for a path in `root`: a regular file of at most `max` bytes. Anything else (a
 * device, a pipe, a file the guest made enormous) is refused before it is read: a guest wrote it.
 */
export function readInsideSync(root: string, path: string, max = MAX_TEXT): Buffer {
    const fd = openInsideSync(root, path);

    try {
        const info = fstatSync(fd);

        if (!info.isFile() || info.size > max) {
            throw Object.assign(
                new Error(`EFBIG: ${path} is not a regular file of at most ${max} bytes`),
                { code: "EFBIG", path },
            );
        }

        return readFileSync(fd);
    } finally {
        closeSync(fd);
    }
}

/**
 * The first `limit` entries of the folder `path` in `root`, as names with their kind (a link is neither a file nor a
 * folder): read as they come, so a folder of a million names costs `limit`. `more` says some were left.
 */
export function listInsideSync(
    root: string,
    path: string,
    limit = MAX_ENTRIES,
): { entries: { name: string; file: boolean; folder: boolean }[]; more: boolean } {
    const fd = openInsideSync(root, path);

    try {
        const dir = opendirSync(entry(fd));
        const entries: { name: string; file: boolean; folder: boolean }[] = [];

        try {
            for (let each = dir.readSync(); each !== null; each = dir.readSync()) {
                if (entries.length >= limit) {
                    return { entries, more: true };
                }

                entries.push({ name: each.name, file: each.isFile(), folder: each.isDirectory() });
            }
        } finally {
            dir.closeSync();
        }

        return { entries, more: false };
    } finally {
        closeSync(fd);
    }
}

/** `path` in `root`, open for reading (a file or a folder). The same file as the descriptor held until it is open. */
export async function openInside(root: string, path: string): Promise<FileHandle> {
    const fd = openInsideSync(root, path);

    try {
        return await open(entry(fd), constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    } finally {
        closeSync(fd);
    }
}

/** Where to list a folder that `handle` holds. */
export const listing = (handle: FileHandle): string => entry(handle.fd);

/** The bytes of a file in `root`; undefined when it holds more than `max`. */
export async function readInside(
    root: string,
    path: string,
    max: number,
): Promise<Buffer | undefined> {
    const handle = await openInside(root, path);

    try {
        return (await handle.stat()).size > max ? undefined : await handle.readFile();
    } finally {
        await handle.close();
    }
}

/** Remove the entry `path` in `root`, a link or a file, never what a link names. */
export function unlinkInside(root: string, path: string): void {
    const { dir, name } = pinParent(root, path);

    try {
        unlinkSync(entry(dir, name));
    } finally {
        closeSync(dir);
    }
}

/** Write `data` as the file `path` in `root` (its folders made), whole or not at all, never through a link. */
export function writeInside(root: string, path: string, data: Uint8Array, mode: number): void {
    const { dir, name } = pinParent(root, path, true);
    const temporary = `.${randomUUID()}.tmp`;

    try {
        const fd = openSync(
            entry(dir, temporary),
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
            mode,
        );

        try {
            for (let done = 0; done < data.length;) {
                done += writeSync(fd, data, done);
            }
        } finally {
            closeSync(fd);
        }

        renameSync(entry(dir, temporary), entry(dir, name));
    } catch (error) {
        try {
            unlinkSync(entry(dir, temporary));
        } catch {
            // Not made, or already renamed.
        }

        throw error;
    } finally {
        closeSync(dir);
    }
}
