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
    openSync,
    readFileSync,
    readlinkSync,
    realpathSync,
    renameSync,
    statSync,
    unlinkSync,
    writeSync,
} from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
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

/**
 * How a session's folder `root` stands to the folders that sandboxed sessions work in: inside one (then `start` is that
 * folder, and `names` lead from it to `root`), holding one (then `start` is `root`), or neither (undefined). The path
 * is walked from `/`, one name at a time. A link is followed only while the walk is outside every sandboxed folder,
 * where the guest cannot have put it; the walk is inside as soon as it reaches one of them, known by the device and the
 * inode of the folder and not by any path to it, so an alias, or a mount of the same folder, finds it too. The names
 * after that are not looked at: the walk of `pinParent` takes them without following a link, and refuses one.
 */
function place(root: string): Place | undefined {
    const folders = [...sandboxedFolders]
        .flatMap((list) => [...list()])
        .flatMap((path) => {
            try {
                const { dev, ino } = statSync(path, { bigint: true });

                return [{ path, key: `${dev}:${ino}` }];
            } catch {
                return [];
            }
        });
    const top = parse(resolve(root)).root;
    const pending = resolve(root).slice(top.length).split(sep).filter(Boolean);
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
            return undefined;
        }

        if (info.isSymbolicLink()) {
            if (++links > 40) {
                return undefined;
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
            return { start: inside.path, names: pending };
        }
    }

    return folders.some((each) => within(at, real(each.path)))
        ? { start: at, names: [] }
        : undefined;
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

/** What `readFileSync(path)` gives, for a path in `root`. */
export function readInsideSync(root: string, path: string): Buffer {
    const fd = openInsideSync(root, path);

    try {
        return readFileSync(fd);
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
