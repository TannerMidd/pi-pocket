/**
 * How host code touches files. A folder that a sandboxed session works in is written by the guest, which is untrusted,
 * as a cloned repository is: it can leave a link that names `~/.ssh/id_rsa`, a pipe that never ends, or swap a folder
 * for a link at any moment. A path that is checked and then used is not safe there. So host code names a file as a
 * `Place`: a `FolderRef` and a name in it, or a raw path that `Hostfs.at` classifies. Each operation here
 * - on a folder that no sandboxed session uses (a plain folder) is the plain `node:fs` call on the joined path:
 *   links are followed, and the errors are the same as before;
 * - on a sandboxed folder walks the name one component at a time, from the folder's own descriptor. Linux gives
 *   `openat` as `/proc/self/fd/<N>/<name>`: `N` is the directory reached so far, `<name>` is one component, and
 *   the kernel resolves the magic link to that directory, so nothing before the name can be swapped. A link on the
 *   way, or as the last name, is refused. A pipe or a device is never opened. Off Linux, or with no `/proc`, the
 *   call fails: nothing falls back to the path.
 * Which folders are sandboxed comes from a `SandboxView`, which core state injects; the default says none.
 *
 * This is the one module that touches the file system for host code, with the hardened Git runner (`git.ts`), the
 * named spawn wrappers, and the files that touch only Pocket's own data (`fs-census.json`).
 */
import {
    constants,
    type Dir,
    type Dirent,
    type BigIntStats,
    type Stats,
    closeSync,
    copyFileSync,
    createReadStream as fsCreateReadStream,
    existsSync,
    fstatSync,
    ftruncateSync,
    lstatSync,
    mkdirSync,
    openSync as fsOpenSync,
    opendirSync,
    readFileSync,
    readSync as fsReadSync,
    readdirSync,
    readlinkSync,
    realpathSync,
    renameSync,
    rmSync,
    rmdirSync,
    statSync,
    unlinkSync,
    writeFileSync,
    writeSync,
    appendFileSync,
    accessSync,
    chmodSync,
    mkdtempSync,
} from "node:fs";
import * as fsp from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import type { ReadStream } from "node:fs";

export { constants };
export type { BigIntStats, Dir, Dirent, FileHandle, ReadStream, Stats };

/** The most that a read of a file in a sandboxed folder holds unless the caller says more. */
export const MAX_TEXT = 1024 * 1024;

/** `O_ACCMODE`: the bits that say read, write, or both. */
const ACCMODE = 3;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const NON_BLOCK = constants.O_NONBLOCK ?? 0;
const FOLDER = constants.O_RDONLY | constants.O_DIRECTORY | NO_FOLLOW;
/** The folder itself, named by its descriptor's magic link, which is followed on purpose. */
const SELF_FOLDER = constants.O_RDONLY | constants.O_DIRECTORY;
const PATH_ONLY = (constants as Record<string, number>).O_PATH ?? 0o10000000;

/** A sandboxed folder as core state knows it: its stated path, and the folder it is by device and inode. */
export type SandboxedFolder = { path: string; dev: bigint; ino: bigint };

/**
 * Which folders sandboxed trees use. Core state implements it. The default reports none, so every folder is plain and
 * every operation is the plain one. A folder is listed with the stated path and the identity it had when it was chosen.
 */
export interface SandboxView {
    sandboxedFolders(): Iterable<SandboxedFolder>;
    /**
     * The identity (device and inode) that a conversation's folder had when it was admitted, which admission state owns.
     * Without it, the first look at a nested folder pins it (`PocketApp.folderOf`). A folder that is no longer that
     * folder makes every operation fail closed.
     */
    pinnedRoot?(conversation: number, path: string): { dev: bigint; ino: bigint } | undefined;
}

export const NO_SANDBOX: SandboxView = { sandboxedFolders: () => [] };

/** A path for a label or a message, never for `fs`: it is not a string, so a file call rejects it. */
export class Display {
    readonly text: string;

    constructor(text: string) {
        this.text = text;
    }

    toString(): string {
        return this.text;
    }

    toJSON(): string {
        return this.text;
    }
}

function failure(code: string, message: string, path?: string): NodeJS.ErrnoException {
    return Object.assign(new Error(`${code}: ${message}`), {
        code,
        ...(path === undefined ? {} : { path }),
    });
}

const refused = (path: string): NodeJS.ErrnoException =>
    failure(
        "EACCES",
        `${path} is, or passes through, a link or an odd name, which is not followed in this folder`,
        path,
    );

function needProc(): void {
    if (process.platform !== "linux" || !existsSync("/proc/self/fd")) {
        throw failure(
            "EOPNOTSUPP",
            "this system cannot open a name inside the folder of a sandboxed session safely, so Pi Pocket does not use it from the host here. Use Linux, or turn the session's sandbox off.",
        );
    }
}

const entry = (dir: number, name?: string): string =>
    `/proc/self/fd/${dir}${name === undefined ? "" : `/${name}`}`;

const keyOf = (info: { dev: bigint; ino: bigint }): string => `${info.dev}:${info.ino}`;

/** Whether `path` is `root` or lies in it, by name. */
export function within(root: string, path: string): boolean {
    const from = relative(resolve(root), resolve(path));

    return from === "" || (from !== ".." && !from.startsWith(`..${sep}`) && !isAbsolute(from));
}

/**
 * The folder a session was admitted with, when it lies inside a sandboxed folder: the name `depth` parts down is that
 * folder by device and inode. The walk checks it each time it passes, so a guest that swaps the folder for a link or
 * another folder after admission makes every operation fail, and the root is never found again by its name.
 */
type PinnedRoot = { depth: number; dev: bigint; ino: bigint };

type Located =
    | { kind: "plain"; path: string }
    | { kind: "confined"; start: SandboxedFolder; parts: string[]; root?: PinnedRoot };

/** A folder that a session works in. Opaque: it is no string, and `fs` rejects it. */
export class FolderRef {
    readonly #host: Hostfs;
    readonly #path: string;
    readonly #dev: bigint | undefined;
    readonly #ino: bigint | undefined;

    constructor(host: Hostfs, path: string, pinned?: { dev: bigint; ino: bigint }) {
        this.#host = host;
        this.#path = resolve(path);

        if (pinned !== undefined) {
            this.#dev = pinned.dev;
            this.#ino = pinned.ino;

            return;
        }

        try {
            const info = statSync(this.#path, { bigint: true });

            this.#dev = info.dev;
            this.#ino = info.ino;
        } catch {
            // Not there (yet): it has no identity, and operations fail as a missing folder does.
        }
    }

    get host(): Hostfs {
        return this.#host;
    }

    /** The folder as text for a label. */
    get display(): Display {
        return new Display(this.#path);
    }

    /** The folder's identity when it was chosen; undefined when it was missing. */
    get identity(): { dev: bigint; ino: bigint } | undefined {
        return this.#dev === undefined ? undefined : { dev: this.#dev, ino: this.#ino! };
    }

    /** Whether a sandboxed tree uses this folder, or one that holds it, or one inside it. Live. */
    get sandboxed(): boolean {
        return this.#host.confines(this.#path) || this.#host.holdsSandboxed(this.#path);
    }

    /** A name inside this folder. */
    at(name = ""): Place {
        return this.#host.within(this, name);
    }

    /** @internal: the stated path, for the named wrappers that start a process or Git. */
    static pathOf(ref: FolderRef): string {
        return ref.#path;
    }
}

/** A file or folder in a folder, as a name to resolve at each use. */
export class Place {
    /** @internal */
    readonly located: Located;
    readonly #label: string;
    readonly #host: Hostfs | undefined;

    /** @internal */
    constructor(located: Located, label: string, host?: Hostfs) {
        this.located = located;
        this.#label = label;
        this.#host = host;
    }

    /** @internal: the context that classified this place; none for Pocket's own places. */
    get context(): Hostfs | undefined {
        return this.#host;
    }

    get display(): Display {
        return new Display(this.#label);
    }

    get sandboxed(): boolean {
        return this.located.kind === "confined";
    }

    /** A name below this place (or a few, with `/`). Refuses `..`, an absolute name, and an empty part. */
    child(name: string): Place {
        const parts = splitName(name);

        if (parts.length === 0) {
            return this;
        }

        // A plain place is classified again at each step: a child can enter a sandboxed folder (a walk that starts above
        // one), and from there it is confined. Pocket's own places have no context, and stay plain.
        if (this.located.kind === "plain") {
            const joined = join(this.located.path, ...parts);

            return this.#host === undefined
                ? new Place({ kind: "plain", path: joined }, join(this.#label, ...parts))
                : this.#host.classified(joined, join(this.#label, ...parts));
        }

        return new Place(
            {
                kind: "confined",
                start: this.located.start,
                parts: [...this.located.parts, ...parts],
                ...(this.located.root === undefined ? {} : { root: this.located.root }),
            },
            join(this.#label, ...parts),
            this.#host,
        );
    }

    /** The place that holds this one; undefined at the top of its folder. */
    parent(): Place | undefined {
        const at = this.located;

        if (at.kind === "plain") {
            const up = dirname(at.path);

            return up === at.path
                ? undefined
                : new Place({ kind: "plain", path: up }, dirname(this.#label), this.#host);
        }

        return at.parts.length === 0
            ? undefined
            : new Place(
                  {
                      kind: "confined",
                      start: at.start,
                      parts: at.parts.slice(0, -1),
                      ...(at.root === undefined || at.root.depth > at.parts.length - 1
                          ? {}
                          : { root: at.root }),
                  },
                  dirname(this.#label),
                  this.#host,
              );
    }

    /** The last name of this place. */
    get name(): string {
        const at = this.located;

        return at.kind === "plain"
            ? parse(at.path).base
            : (at.parts.at(-1) ?? parse(at.start.path).base);
    }
}

function splitName(name: string): string[] {
    if (name === "" || name === ".") {
        return [];
    }

    if (name.includes("\0") || isAbsolute(name)) {
        throw refused(name);
    }

    // A backslash is a name character on Linux; only Windows treats it as a separator.
    const parts = name
        .split(process.platform === "win32" ? /[\\/]/u : "/")
        .filter((part) => part !== "" && part !== ".");

    if (parts.includes("..")) {
        throw refused(name);
    }

    return parts;
}

/** Open a folder from its stated path; it must be the folder it was when it was chosen. */
function openStart(start: SandboxedFolder): number {
    needProc();

    // The stated path is the owner's choice and may be an alias: it is followed, and must be the folder it was.
    const fd = fsOpenSync(start.path, constants.O_RDONLY | constants.O_DIRECTORY);

    try {
        const info = fstatSync(fd, { bigint: true });

        if (info.dev !== start.dev || info.ino !== start.ino) {
            throw failure("ESTALE", `${start.path} is no longer the folder it was`, start.path);
        }

        return fd;
    } catch (error) {
        closeSync(fd);

        throw error;
    }
}

/** A step of the walk: opening a name without following a link; a link in its place is a refusal. */
function noLink<T>(path: string, step: () => T): T {
    try {
        return step();
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;

        throw code === "ELOOP" || code === "ENOTDIR" || code === "EMLINK" ? refused(path) : error;
    }
}

/**
 * The folder that holds the last name of `parts` below `start`, open, and that name. The caller closes `dir`. A name
 * that is not a plain component is refused. `make`: folders on the way that are missing are made.
 */
function pinParent(
    start: SandboxedFolder,
    parts: readonly string[],
    shown: string,
    make = false,
    root?: PinnedRoot,
): { dir: number; name: string | undefined } {
    let dir = openStart(start);

    try {
        for (const [index, part] of parts.slice(0, -1).entries()) {
            if (part === ".." || part === "." || part === "" || part.includes("\0")) {
                throw refused(shown);
            }

            const at = entry(dir, part);
            const next = noLink(shown, () => {
                try {
                    return fsOpenSync(at, FOLDER);
                } catch (error) {
                    if (!make || (error as NodeJS.ErrnoException).code !== "ENOENT") {
                        throw error;
                    }

                    try {
                        mkdirSync(at);
                    } catch (made) {
                        if ((made as NodeJS.ErrnoException).code !== "EEXIST") {
                            throw made;
                        }
                    }

                    return fsOpenSync(at, FOLDER);
                }
            });

            if (root?.depth === index + 1) {
                checkRoot(next, root, shown);
            }

            closeSync(dir);
            dir = next;
        }

        return { dir, name: parts.at(-1) };
    } catch (error) {
        closeSync(dir);

        throw error;
    }
}

function checkRoot(fd: number, root: PinnedRoot, shown: string): void {
    const info = fstatSync(fd, { bigint: true });

    if (info.dev !== root.dev || info.ino !== root.ino) {
        closeSync(fd);

        throw failure("ESTALE", `${shown} is no longer the folder it was admitted as`, shown);
    }
}

function checkName(name: string, shown: string): string {
    if (name === ".." || name === "." || name === "" || name.includes("\0")) {
        throw refused(shown);
    }

    return name;
}

/**
 * The path that names `place` for one `fs` call, valid until `release`. A plain place is its path. A sandboxed place is
 * `/proc/self/fd/<dir>/<name>`, or `/proc/self/fd/<folder>` for the folder itself.
 */
function pin(
    place: Place,
    make = false,
    byName = false,
): { path: string; release: () => void; confined: boolean; self: boolean } {
    const at = place.located;

    if (at.kind === "plain") {
        return { path: at.path, release: () => {}, confined: false, self: false };
    }

    const shown = place.display.text;

    if (at.parts.length === 0) {
        const fd = openStart(at.start);

        return { path: entry(fd), release: () => closeSync(fd), confined: true, self: true };
    }

    const { dir, name } = pinParent(at.start, at.parts, shown, make, at.root);

    try {
        const path = entry(dir, checkName(name!, shown));

        // The entry itself is the admitted root: the descriptor that is opened must be that folder (a link or another
        // folder in its place is refused), and the call then uses that descriptor, not the name.
        if (at.root?.depth === at.parts.length) {
            const probe = noLink(shown, () => fsOpenSync(path, PATH_ONLY | NO_FOLLOW));

            try {
                const info = fstatSync(probe, { bigint: true });

                if (info.dev !== at.root.dev || info.ino !== at.root.ino) {
                    throw failure(
                        "ESTALE",
                        `${shown} is no longer the folder it was admitted as`,
                        shown,
                    );
                }
            } catch (error) {
                closeSync(probe);

                throw error;
            }

            if (!byName) {
                return {
                    path: entry(probe),
                    release: () => {
                        closeSync(probe);
                        closeSync(dir);
                    },
                    confined: true,
                    self: true,
                };
            }

            closeSync(probe);
        }

        return {
            path,
            release: () => closeSync(dir),
            confined: true,
            self: false,
        };
    } catch (error) {
        closeSync(dir);

        throw error;
    }
}

function use<T>(
    place: Place,
    run: (path: string, confined: boolean, self: boolean) => T,
    make = false,
    byName = false,
): T {
    const pinned = pin(place, make, byName);

    try {
        return run(pinned.path, pinned.confined, pinned.self);
    } finally {
        pinned.release();
    }
}

async function useAsync<T>(
    place: Place,
    run: (path: string, confined: boolean, self: boolean) => Promise<T>,
    make = false,
    byName = false,
): Promise<T> {
    const pinned = pin(place, make, byName);

    try {
        return await run(pinned.path, pinned.confined, pinned.self);
    } finally {
        pinned.release();
    }
}

function modeFlags(flags: string | number): number {
    if (typeof flags === "number") {
        return flags;
    }

    const table: Record<string, number> = {
        r: constants.O_RDONLY,
        "r+": constants.O_RDWR,
        w: constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC,
        wx: constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        "w+": constants.O_RDWR | constants.O_CREAT | constants.O_TRUNC,
        a: constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND,
        ax: constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_EXCL,
    };
    const found = table[flags];

    if (found === undefined) {
        throw failure("EINVAL", `unknown open flag ${flags}`);
    }

    return found;
}

const notRegular = (place: Place, max: number): NodeJS.ErrnoException =>
    failure("EFBIG", `${place.display.text} is not a regular file of at most ${max} bytes`);

/** A descriptor held open for a file: read it, look at it, close it. */
export class OpenFile {
    readonly #fd: number;
    #closed = false;

    constructor(fd: number) {
        this.#fd = fd;
    }

    stat(): Stats;
    stat(options: { bigint: true }): BigIntStats;
    stat(options?: { bigint: true }): Stats | BigIntStats {
        return options === undefined ? fstatSync(this.#fd) : fstatSync(this.#fd, options);
    }

    read(buffer: Buffer, offset: number, length: number, position: number | null): number {
        return fsReadSync(this.#fd, buffer, offset, length, position);
    }

    write(data: Uint8Array): void {
        for (let done = 0; done < data.length;) {
            done += writeSync(this.#fd, data, done);
        }
    }

    /** What is left of the file, from the start; `max` bounds it (more than that is `EFBIG`). */
    readAll(max?: number): Buffer {
        return max === undefined
            ? readFileSync(this.#fd)
            : readBounded((buffer) => fsReadSync(this.#fd, buffer, 0, buffer.length, null), max);
    }

    close(): void {
        if (!this.#closed) {
            this.#closed = true;
            closeSync(this.#fd);
        }
    }
}

/** What a regular file read of a sandboxed place is bounded by. */
export type ReadOptions = {
    max?: number;
    /** @internal A test hook: runs between the look at the size and the read, where a guest can grow the file. */
    afterSize?: () => void;
};

const tooBig = (max: number): NodeJS.ErrnoException =>
    failure("EFBIG", `a file of more than ${max} bytes is not read`);

/** Read at most `max` bytes: one more arriving, whatever the size said, fails the read. */
function readBounded(read: (buffer: Buffer) => number, max: number): Buffer {
    const chunks: Buffer[] = [];
    let total = 0;

    for (;;) {
        const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, max + 1 - total));
        const got = read(buffer);

        if (got === 0) {
            return Buffer.concat(chunks, total);
        }

        total += got;

        if (total > max) {
            throw tooBig(max);
        }

        chunks.push(buffer.subarray(0, got));
    }
}

/** Read what a descriptor holds from where it is, at most `max` bytes: one more, whatever its size said, is `EFBIG`. */
export async function readHandleBounded(handle: FileHandle, max: number): Promise<Buffer> {
    return readBoundedAsync(
        async (buffer) => (await handle.read(buffer, 0, buffer.length, null)).bytesRead,
        max,
    );
}

async function readBoundedAsync(
    read: (buffer: Buffer) => Promise<number>,
    max: number,
): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let total = 0;

    for (;;) {
        const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, max + 1 - total));
        const got = await read(buffer);

        if (got === 0) {
            return Buffer.concat(chunks, total);
        }

        total += got;

        if (total > max) {
            throw tooBig(max);
        }

        chunks.push(buffer.subarray(0, got));
    }
}

/**
 * Open the entry `path` (a name below a descriptor) for a sandboxed place, and only a regular file (or, to read, a folder).
 * The entry is classified first with `O_PATH` and no link followed, and what is opened is that classified descriptor
 * (`/proc/self/fd/N`), so nothing can take its place in between: a pipe, a device, a socket, or a link is `ENXIO` or a
 * refusal and is never opened, for a read, a write, or a truncate. A name that is not there is made with `O_EXCL`.
 */
function openChecked(path: string, flags: number, mode: number | undefined, shown: string): number {
    const writes = (flags & ACCMODE) !== constants.O_RDONLY;

    for (let attempt = 0; ; attempt++) {
        let probe: number;

        try {
            probe = fsOpenSync(path, PATH_ONLY | NO_FOLLOW);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT" && flags & constants.O_CREAT) {
                try {
                    return fsOpenSync(
                        path,
                        (flags | constants.O_EXCL | NO_FOLLOW | NON_BLOCK) & ~constants.O_TRUNC,
                        mode,
                    );
                } catch (made) {
                    // Made by the guest between the look and here: look again, once.
                    if (
                        (made as NodeJS.ErrnoException).code === "EEXIST" &&
                        !(flags & constants.O_EXCL) &&
                        attempt === 0
                    ) {
                        continue;
                    }

                    return noLink(shown, () => {
                        throw made;
                    });
                }
            }

            return noLink(shown, () => {
                throw error;
            });
        }

        try {
            const info = fstatSync(probe, { bigint: true });

            if (info.isSymbolicLink()) {
                throw refused(shown);
            }

            if (!info.isFile() && !(info.isDirectory() && !writes)) {
                throw failure("ENXIO", `${shown} is not a regular file`, shown);
            }

            if (flags & constants.O_CREAT && flags & constants.O_EXCL) {
                throw failure("EEXIST", `${shown} is there`, shown);
            }

            const fd = fsOpenSync(
                entry(probe),
                flags & ~(constants.O_CREAT | constants.O_EXCL | constants.O_TRUNC | NO_FOLLOW),
            );

            try {
                const after = fstatSync(fd, { bigint: true });

                if (after.dev !== info.dev || after.ino !== info.ino) {
                    throw failure("ESTALE", `${shown} changed as it was opened`, shown);
                }

                if (flags & constants.O_TRUNC && writes) {
                    ftruncateSync(fd, 0);
                }

                return fd;
            } catch (error) {
                closeSync(fd);

                throw error;
            }
        } finally {
            closeSync(probe);
        }
    }
}

function readConfined(place: Place, path: string, options: ReadOptions): Buffer {
    const max = options.max ?? MAX_TEXT;
    const fd = openChecked(path, constants.O_RDONLY, undefined, place.display.text);

    try {
        const info = fstatSync(fd);

        if (!info.isFile() || info.size > max) {
            throw notRegular(place, max);
        }

        options.afterSize?.();

        return readBounded((buffer) => fsReadSync(fd, buffer, 0, buffer.length, null), max);
    } finally {
        closeSync(fd);
    }
}

// ---- Operations. A plain place is the plain call; a sandboxed one is confined. -------------------------------------

export function readFile(place: Place, options?: ReadOptions): Buffer {
    return use(place, (path, confined) =>
        confined ? readConfined(place, path, options ?? {}) : readFileSync(path),
    );
}

export function readText(place: Place, options?: ReadOptions): string {
    return readFile(place, options).toString("utf8");
}

export async function readFileAsync(place: Place, options?: ReadOptions): Promise<Buffer> {
    return useAsync(place, async (path, confined) => {
        if (!confined) {
            return fsp.readFile(path);
        }

        const max = options?.max ?? MAX_TEXT;
        const fd = openChecked(path, constants.O_RDONLY, undefined, place.display.text);
        const handle = await fsp.open(entry(fd), constants.O_RDONLY).finally(() => closeSync(fd));

        try {
            const info = await handle.stat();

            if (!info.isFile() || info.size > max) {
                throw notRegular(place, max);
            }

            options?.afterSize?.();

            return await readBoundedAsync(
                async (buffer) => (await handle.read(buffer, 0, buffer.length, null)).bytesRead,
                max,
            );
        } finally {
            await handle.close();
        }
    });
}

/** Whether `place` is there. A sandboxed place that is a link is there (it is the link). */
export function exists(place: Place): boolean {
    try {
        return use(place, (path, confined, self) => {
            if (confined) {
                (self ? statSync : lstatSync)(path);

                return true;
            }

            return existsSync(path);
        });
    } catch {
        return false;
    }
}

/** Plain: `statSync` (it follows a link). Sandboxed: `lstat`, so a link is a link. */
export function stat(place: Place): Stats;
export function stat(
    place: Place,
    options: { bigint: true; throwIfNoEntry?: boolean },
): BigIntStats;
export function stat(place: Place, options: { throwIfNoEntry: false }): Stats | undefined;

export function stat(
    place: Place,
    options?: { bigint?: boolean; throwIfNoEntry?: boolean },
): Stats | BigIntStats | undefined {
    return use(
        place,
        (path, confined, self) =>
            (confined && !self ? lstatSync : statSync)(path, options as never) as
                Stats | BigIntStats | undefined,
    );
}

export function lstat(place: Place): Stats;
export function lstat(
    place: Place,
    options: { bigint: true; throwIfNoEntry?: boolean },
): BigIntStats;
export function lstat(place: Place, options: { throwIfNoEntry: false }): Stats | undefined;

export function lstat(
    place: Place,
    options?: { bigint?: boolean; throwIfNoEntry?: boolean },
): Stats | BigIntStats | undefined {
    return use(
        place,
        (path, _confined, self) =>
            (self ? statSync : lstatSync)(path, options as never) as
                Stats | BigIntStats | undefined,
    );
}

export async function lstatAsync(place: Place): Promise<Stats>;
export async function lstatAsync(place: Place, options: { bigint: true }): Promise<BigIntStats>;

export async function lstatAsync(
    place: Place,
    options?: { bigint?: boolean },
): Promise<Stats | BigIntStats> {
    return useAsync(
        place,
        (path, _confined, self) =>
            (self ? fsp.stat : fsp.lstat)(path, options as never) as Promise<Stats | BigIntStats>,
    );
}

export async function statAsync(place: Place): Promise<Stats>;
export async function statAsync(place: Place, options: { bigint: true }): Promise<BigIntStats>;

export async function statAsync(
    place: Place,
    options?: { bigint?: boolean },
): Promise<Stats | BigIntStats> {
    return useAsync(
        place,
        (path, confined, self) =>
            (confined && !self ? fsp.lstat : fsp.stat)(path, options as never) as Promise<
                Stats | BigIntStats
            >,
    );
}

export function isDirectory(place: Place): boolean {
    try {
        return stat(place).isDirectory();
    } catch {
        return false;
    }
}

export function isFile(place: Place): boolean {
    try {
        return stat(place).isFile();
    } catch {
        return false;
    }
}

/** Where a folder is open, for a listing: plain, the path; sandboxed, the entry of the folder's descriptor. */
function withFolder<T>(place: Place, run: (path: string) => T): T {
    const at = place.located;

    if (at.kind === "plain") {
        return run(at.path);
    }

    return use(place, (path, _confined, self) => {
        const fd = noLink(place.display.text, () => fsOpenSync(path, self ? SELF_FOLDER : FOLDER));

        try {
            return run(entry(fd));
        } finally {
            closeSync(fd);
        }
    });
}

export function readdir(place: Place): string[];
export function readdir(place: Place, options: { withFileTypes: true }): Dirent[];

export function readdir(place: Place, options?: { withFileTypes: true }): string[] | Dirent[] {
    return withFolder(place, (path) =>
        options === undefined ? readdirSync(path) : readdirSync(path, options),
    );
}

export async function readdirAsync(place: Place): Promise<string[]>;
export async function readdirAsync(
    place: Place,
    options: { withFileTypes: true },
): Promise<Dirent[]>;

export async function readdirAsync(
    place: Place,
    options?: { withFileTypes: true },
): Promise<string[] | Dirent[]> {
    const at = place.located;

    if (at.kind === "plain") {
        return options === undefined ? fsp.readdir(at.path) : fsp.readdir(at.path, options);
    }

    return useAsync(place, async (path, _confined, self) => {
        const handle = await noLink(place.display.text, () =>
            fsp.open(path, self ? SELF_FOLDER : FOLDER),
        );

        try {
            return options === undefined
                ? await fsp.readdir(entry(handle.fd))
                : await fsp.readdir(entry(handle.fd), options);
        } finally {
            await handle.close();
        }
    });
}

/**
 * A folder opened for reading entry by entry. The `Dir` holds its own handle: it is valid after this returns, and a
 * folder of a million names costs what is read.
 */
export async function opendir(place: Place, options?: { bufferSize?: number }): Promise<Dir> {
    const at = place.located;

    if (at.kind === "plain") {
        return fsp.opendir(at.path, options);
    }

    return useAsync(place, async (path, _confined, self) => {
        const handle = await noLink(place.display.text, () =>
            fsp.open(path, self ? SELF_FOLDER : FOLDER),
        );

        try {
            return await fsp.opendir(entry(handle.fd), options);
        } finally {
            await handle.close();
        }
    });
}

export function opendirSyncAt(place: Place): Dir {
    return withFolder(place, (path) => opendirSync(path));
}

/** The place's real path. A sandboxed place has no links, so it is its stated path once it is shown to be there. */
export function realpath(place: Place, options: { native?: boolean } = {}): string {
    const at = place.located;

    if (at.kind === "plain") {
        return options.native === true ? realpathSync.native(at.path) : realpathSync(at.path);
    }

    lstat(place);

    return join(at.start.path, ...at.parts);
}

export async function realpathAsync(place: Place): Promise<string> {
    const at = place.located;

    if (at.kind === "plain") {
        return fsp.realpath(at.path);
    }

    await lstatAsync(place);

    return join(at.start.path, ...at.parts);
}

export function mkdir(place: Place, options?: { recursive?: boolean; mode?: number }): void {
    if (place.located.kind === "plain") {
        mkdirSync(place.located.path, options);

        return;
    }

    if (options?.recursive === true) {
        // Every name on the way is a folder: made one at a time, never through a link.
        const at = place.located;

        closeSync(pinParent(at.start, [...at.parts, ""], place.display.text, true, at.root).dir);

        return;
    }

    use(place, (path) => mkdirSync(path, { mode: options?.mode }));
}

export async function mkdirAsync(
    place: Place,
    options?: { recursive?: boolean; mode?: number },
): Promise<void> {
    mkdir(place, options);
}

export function unlink(place: Place): void {
    use(place, (path) => unlinkSync(path), false, true);
}

export async function unlinkAsync(place: Place): Promise<void> {
    await useAsync(place, (path) => fsp.unlink(path), false, true);
}

export function rmdir(place: Place): void {
    use(place, (path) => rmdirSync(path), false, true);
}

export async function rmdirAsync(place: Place): Promise<void> {
    await useAsync(place, (path) => fsp.rmdir(path), false, true);
}

/** Remove a file, a link (never what it names), or with `recursive` a folder and all in it. */
export function rm(place: Place, options: { force?: boolean; recursive?: boolean } = {}): void {
    const at = place.located;

    if (at.kind === "plain") {
        rmSync(at.path, options);

        return;
    }

    try {
        const info = lstat(place);

        if (info.isDirectory() && !info.isSymbolicLink()) {
            if (options.recursive !== true) {
                throw failure("EISDIR", `${place.display.text} is a folder`, place.display.text);
            }

            for (const name of readdir(place)) {
                rm(place.child(name), options);
            }

            rmdir(place);

            return;
        }

        unlink(place);
    } catch (error) {
        if (!(options.force === true && (error as NodeJS.ErrnoException).code === "ENOENT")) {
            throw error;
        }
    }
}

export async function rmAsync(
    place: Place,
    options: { force?: boolean; recursive?: boolean } = {},
): Promise<void> {
    rm(place, options);
}

export function rename(from: Place, to: Place): void {
    use(
        from,
        (source) => use(to, (target) => renameSync(source, target), false, true),
        false,
        true,
    );
}

export async function renameAsync(from: Place, to: Place): Promise<void> {
    await useAsync(
        from,
        (source) => useAsync(to, (target) => fsp.rename(source, target), false, true),
        false,
        true,
    );
}

/** The most that a copy out of a sandboxed folder reads, unless the caller says less. */
export const MAX_COPY = 256 * 1024 * 1024;

/**
 * Copy a file. Between two plain places it is the plain copy. Otherwise the bytes are streamed, a chunk at a time, from
 * the source's checked descriptor to the target, and counted as they are read: more than `max` (whatever the size
 * said when it was looked at) is `EFBIG`, and the part written is removed. `onChunk` is a test hook.
 */
export function copyFile(
    from: Place,
    to: Place,
    mode?: number,
    max = MAX_COPY,
    onChunk?: () => void,
): void {
    if (from.located.kind === "plain" && to.located.kind === "plain") {
        copyFileSync(from.located.path, to.located.path);

        return;
    }

    const source = openSync(from, "r");

    try {
        const target = openSync(to, "w", mode ?? 0o666);
        let total = 0;

        try {
            const buffer = Buffer.allocUnsafe(64 * 1024);

            for (;;) {
                const got = source.read(buffer, 0, buffer.length, null);

                if (got === 0) {
                    break;
                }

                total += got;

                if (total > max) {
                    throw tooBig(max);
                }

                target.write(buffer.subarray(0, got));
                onChunk?.();
            }
        } catch (error) {
            target.close();
            rm(to, { force: true });

            throw error;
        }

        target.close();
    } finally {
        source.close();
    }

    if (mode !== undefined) {
        use(to, (path) => chmodSync(path, mode));
    }
}

export async function copyFileAsync(
    from: Place,
    to: Place,
    max = MAX_COPY,
    onChunk?: () => void,
): Promise<void> {
    if (from.located.kind === "plain" && to.located.kind === "plain") {
        await fsp.copyFile(from.located.path, to.located.path);

        return;
    }

    copyFile(from, to, undefined, max, onChunk);
}

/** Write a file (`flag` `w` by default; `wx` makes it fail if it is there). A sandboxed place is never opened through a link. */
export function writeFile(
    place: Place,
    data: string | Uint8Array,
    options: { flag?: string; mode?: number } = {},
): void {
    use(
        place,
        (path, confined) => {
            if (!confined) {
                writeFileSync(path, data, { flag: options.flag ?? "w", mode: options.mode });

                return;
            }

            const fd = openChecked(
                path,
                modeFlags(options.flag ?? "w"),
                options.mode ?? 0o666,
                place.display.text,
            );

            try {
                const bytes = typeof data === "string" ? Buffer.from(data) : data;

                for (let done = 0; done < bytes.length;) {
                    done += writeSync(fd, bytes, done);
                }
            } finally {
                closeSync(fd);
            }
        },
        true,
    );
}

/** Write `data` as the file `place`: whole or not at all, by a temporary name in the same folder and a rename. */
export function writeFileAtomic(place: Place, data: string | Uint8Array, mode = 0o666): void {
    const parent = place.parent();

    if (parent === undefined) {
        throw refused(place.display.text);
    }

    const temporary = parent.child(`.${randomUUID()}.tmp`);

    try {
        writeFile(temporary, data, { flag: "wx", mode });
        rename(temporary, place);
    } catch (error) {
        rm(temporary, { force: true });

        throw error;
    }
}

export function append(
    place: Place,
    data: string | Uint8Array,
    options: { flush?: boolean } = {},
): void {
    if (place.located.kind === "plain") {
        appendFileSync(place.located.path, data, { flush: options.flush });

        return;
    }

    writeFile(place, data, { flag: "a" });
}

export function openSync(place: Place, flags: string | number = "r", mode?: number): OpenFile {
    return use(place, (path, confined) => {
        const bits = modeFlags(flags);
        const fd = confined
            ? openChecked(path, bits, mode, place.display.text)
            : noLink(place.display.text, () => fsOpenSync(path, bits, mode));

        return new OpenFile(fd);
    });
}

/** Open for reading, never through a link as its last part, on every system (plain folders too). */
export function openNoFollowSync(
    place: Place,
    flags: number = constants.O_RDONLY | NON_BLOCK,
): OpenFile {
    return use(place, (path, confined) => {
        if (!confined) {
            const before = lstatSync(path, { bigint: true });

            if (before.isSymbolicLink()) {
                throw failure(
                    "ELOOP",
                    `a link is not followed, open '${place.display.text}'`,
                    path,
                );
            }

            const fd = fsOpenSync(path, flags | NO_FOLLOW);

            try {
                const after = fstatSync(fd, { bigint: true });

                if (after.dev !== before.dev || after.ino !== before.ino) {
                    throw failure(
                        "ELOOP",
                        `a link is not followed, open '${place.display.text}'`,
                        path,
                    );
                }
            } catch (error) {
                closeSync(fd);

                throw error;
            }

            return new OpenFile(fd);
        }

        return new OpenFile(openChecked(path, flags, undefined, place.display.text));
    });
}

export async function open(
    place: Place,
    flags: string | number = "r",
    mode?: number,
): Promise<FileHandle> {
    return useAsync(place, async (path, confined) => {
        const bits = modeFlags(flags);

        if (!confined) {
            return fsp.open(path, bits, mode);
        }

        // Checked and made as a regular file, then opened again through the checked descriptor.
        const fd = openChecked(path, bits, mode, place.display.text);

        return fsp
            .open(entry(fd), bits & (ACCMODE | constants.O_APPEND))
            .finally(() => closeSync(fd));
    });
}

/** As `open`, but never through a link as its last part on any folder (a plain one too). */
export async function openNoFollow(
    place: Place,
    flags: number = constants.O_RDONLY | NON_BLOCK,
): Promise<FileHandle> {
    return useAsync(place, async (path, confined) => {
        if (!confined) {
            const before = await fsp.lstat(path, { bigint: true });

            if (before.isSymbolicLink()) {
                throw failure(
                    "ELOOP",
                    `a link is not followed, open '${place.display.text}'`,
                    path,
                );
            }

            const handle = await fsp.open(path, flags | NO_FOLLOW);

            try {
                const after = await handle.stat({ bigint: true });

                if (after.dev !== before.dev || after.ino !== before.ino) {
                    throw failure(
                        "ELOOP",
                        `a link is not followed, open '${place.display.text}'`,
                        path,
                    );
                }
            } catch (error) {
                await handle.close();

                throw error;
            }

            return handle;
        }

        const fd = openChecked(path, flags, undefined, place.display.text);

        return fsp
            .open(entry(fd), flags & (ACCMODE | constants.O_APPEND))
            .finally(() => closeSync(fd));
    });
}

/** A read stream of a file. Sandboxed: the descriptor is opened without a link first, and the stream owns it. */
export function createReadStream(
    place: Place,
    options?: { start?: number; end?: number },
): ReadStream {
    return use(place, (path, confined) => {
        if (!confined) {
            return fsCreateReadStream(path, options);
        }

        const fd = openChecked(path, constants.O_RDONLY, undefined, place.display.text);

        if (!fstatSync(fd).isFile()) {
            closeSync(fd);

            throw failure("EACCES", `${place.display.text} is not a regular file`);
        }

        return fsCreateReadStream("", { ...options, fd, autoClose: true });
    });
}

export function makeTemporaryFolder(prefix: string): string {
    return mkdtempSync(prefix);
}

/** Whether a file on an owner's path (the server's `PATH`) can be run. Not for a session's folder. */
export function isExecutable(path: string): boolean {
    try {
        accessSync(path, constants.X_OK);

        return true;
    } catch {
        return false;
    }
}

/** The link a sandboxed or plain place is, as text. */
export function readlink(place: Place): string {
    return use(place, (path) => readlinkSync(path));
}

// ---- Identity ---------------------------------------------------------------------------------------------------

type Folder = SandboxedFolder & { key: string };

/**
 * Walk `path` from `/`, one name at a time, following links, until the walk is in one of `folders` (known by device and
 * inode, so an alias, or a mount of the same folder, finds it too). It answers where it entered and the names still
 * to go, or the real path it came to (undefined when a name is not there).
 */
function walk(
    path: string,
    folders: readonly Folder[],
): { entered: { start: Folder; names: string[] } } | { at: string | undefined } {
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

        const inside = folders.find((each) => each.key === keyOf(info));

        if (inside !== undefined) {
            return { entered: { start: inside, names: pending } };
        }
    }

    return { at };
}

/**
 * Climb from the open descriptor `start` to `/` with `..` by descriptor, comparing each folder's device and inode with
 * `keys`. True when the climb passes through one (or starts at one). A file climbs from the folder that holds it.
 */
function climb(start: number, keys: ReadonlySet<string>): boolean {
    const opened: number[] = [];

    try {
        const info = fstatSync(start, { bigint: true });

        if (keys.has(keyOf(info))) {
            return true;
        }

        let at = start;

        if (!info.isDirectory()) {
            // The real folder of a file is the parent of its descriptor's magic link.
            at = fsOpenSync(dirname(readlinkSync(entry(start))), PATH_ONLY | constants.O_DIRECTORY);
            opened.push(at);
        }

        for (;;) {
            const here = fstatSync(at, { bigint: true });

            if (keys.has(keyOf(here))) {
                return true;
            }

            const up = fsOpenSync(entry(at, ".."), PATH_ONLY | constants.O_DIRECTORY);

            opened.push(up);

            const above = fstatSync(up, { bigint: true });

            if (above.dev === here.dev && above.ino === here.ino) {
                return false;
            }

            at = up;
        }
    } finally {
        for (const fd of opened) {
            closeSync(fd);
        }
    }
}

/**
 * Open `path` as it is (links followed) with `O_PATH`, and climb with `..` by descriptor (`climb`). True when the path
 * passes through one of `folders`. A path that is missing is looked at from what is there: a dangling link is followed
 * by name, a missing last name by its parent. Any other error means it cannot be shown clear, so it fails closed.
 */
function passesThrough(path: string, folders: readonly Folder[]): boolean {
    needProc();

    const keys = new Set(folders.map((each) => each.key));
    let current = resolve(path);

    for (let steps = 0; steps < 80; steps++) {
        let fd: number;

        try {
            fd = fsOpenSync(current, PATH_ONLY);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                return true;
            }

            let info;

            try {
                info = lstatSync(current);
            } catch {
                const up = dirname(current);

                if (up === current) {
                    return false;
                }

                current = up;
                continue;
            }

            if (info.isSymbolicLink()) {
                current = resolve(dirname(current), readlinkSync(current));
                continue;
            }

            return true;
        }

        try {
            return climb(fd, keys);
        } catch {
            return true;
        } finally {
            closeSync(fd);
        }
    }

    return true;
}

/** Whether climbing from `path` to `/` passes through the folder with this identity. */
function climbTo(path: string, key: string): boolean {
    const fd = fsOpenSync(path, PATH_ONLY);

    try {
        return climb(fd, new Set([key]));
    } finally {
        closeSync(fd);
    }
}

/** Owns which folders sandboxed trees use, and makes folders and places. */
export class Hostfs {
    readonly #view: SandboxView;
    /** The identity of each nested folder at its first look, by stated path. */
    readonly #roots = new Map<string, { dev: bigint; ino: bigint }>();

    readonly #maxPins: number;

    /** `maxPins`: how many nested folders keep their first-look identity; a pin is never dropped to make room. */
    constructor(view: SandboxView = NO_SANDBOX, options: { maxPins?: number } = {}) {
        this.#view = view;
        this.#maxPins = options.maxPins ?? 10_000;
    }

    /** Admission teardown: the folder's pinned identity goes (a new look pins it again). */
    unpinRoot(path: string): void {
        this.#roots.delete(resolve(path));
    }

    #folders(): Folder[] {
        return [...this.#view.sandboxedFolders()].map((each) => ({
            ...each,
            path: resolve(each.path),
            key: keyOf(each),
        }));
    }

    /** A folder as a session works in it. */
    folder(path: string, pinned?: { dev: bigint; ino: bigint }): FolderRef {
        const target = resolve(path);
        const known = pinned ?? this.#roots.get(target);
        const ref = new FolderRef(this, target, known);

        // A folder nested in a sandboxed one is pinned by the first look, when admission gave no identity: the guest can
        // replace it, and a replacement is then not the root.
        if (known === undefined && ref.identity !== undefined) {
            const here = this.#folders();

            if (here.length > 0) {
                const where = this.#locate(target, here, true);

                if (where.kind === "confined" && where.parts.length > 0) {
                    // A pin is a security fact: it is kept until admission is torn down (`unpinRoot`), never evicted. At
                    // the limit a new nested folder is refused.
                    if (this.#roots.size >= this.#maxPins) {
                        throw failure(
                            "EMFILE",
                            `${target} cannot be admitted: too many folders are pinned`,
                            target,
                        );
                    }

                    this.#roots.set(target, ref.identity);
                }
            }
        }

        return ref;
    }

    /** Whether a sandboxed tree uses `path`, a folder that holds it, or one inside it (by name, and by identity). */
    confines(path: string): boolean {
        const folders = this.#folders();

        return folders.length > 0 && this.#locate(path, folders, true).kind === "confined";
    }

    /** Whether a sandboxed folder lies in `path` (by name, or by identity: its parents are climbed). */
    holdsSandboxed(path: string): boolean {
        const folders = this.#folders();

        if (folders.length === 0) {
            return false;
        }

        let key: string | undefined;

        try {
            key = keyOf(statSync(resolve(path), { bigint: true }));
        } catch {
            return folders.some((each) => within(path, each.path));
        }

        return folders.some((each) => {
            try {
                return within(path, each.path) || climbTo(each.path, key!);
            } catch {
                return true;
            }
        });
    }

    /** The folders sandboxed trees use, for the code that must know (identity, not paths to use). */
    sandboxed(): readonly SandboxedFolder[] {
        return this.#folders();
    }

    /**
     * Where `path` is for the walk: inside a sandboxed folder (by its stated path, or, for a folder a session works in,
     * by the folder it is, found through links outside), or plain. `chosen`: the path is a folder an owner chose, so a link
     * to a sandboxed folder is that folder. A raw path with a link into one is refused (`passesThrough`).
     */
    #locate(path: string, folders: Folder[], chosen: boolean): Located {
        const target = resolve(path);

        if (folders.length === 0) {
            return { kind: "plain", path: target };
        }

        // 1. By the stated path: the outermost sandboxed folder that holds it.
        const holders = folders
            .filter((each) => within(each.path, target))
            .sort((a, b) => a.path.length - b.path.length);

        if (holders[0] !== undefined) {
            return {
                kind: "confined",
                start: holders[0],
                parts: relative(holders[0].path, target).split(sep).filter(Boolean),
            };
        }

        // 2. By identity.
        if (chosen) {
            const found = walk(target, folders);

            if ("entered" in found) {
                return {
                    kind: "confined",
                    start: found.entered.start,
                    parts: found.entered.names,
                };
            }
        }

        // A raw path is followed component by component, links and all, until it is in a sandboxed folder: from there
        // it is that folder's, and a link after that point does not matter. Entering by a link at any step is refused.
        if (!chosen && "entered" in walk(target, folders)) {
            throw refused(path);
        }

        if (passesThrough(target, folders)) {
            if (chosen) {
                // A folder that holds a sandboxed folder: what is below it is classified name by name.
                return { kind: "plain", path: target };
            }

            throw refused(path);
        }

        return { kind: "plain", path: target };
    }

    /**
     * A raw path from anyone (a plain session, the owner's viewer, an absolute path, an alias), classified by identity, not by
     * text. In a sandboxed folder: the confined walk. Through a link into one: refused. Else plain.
     */
    at(path: string): Place {
        const folders = this.#folders();

        return new Place(this.#locate(path, folders, false), resolve(path), this);
    }

    /** Whether a path is there. A refused path (a link into a sandboxed folder) is not. */
    has(path: string): boolean {
        try {
            return exists(this.at(path));
        } catch {
            return false;
        }
    }

    /** Whether a path is a folder (followed through a link where the folder is plain). False when refused or missing. */
    isFolder(path: string): boolean {
        try {
            return isDirectory(this.at(path));
        } catch {
            return false;
        }
    }

    /** The path as it really is (links resolved) when it is there; undefined when missing or refused. */
    real(path: string, options: { native?: boolean } = {}): string | undefined {
        try {
            return realpath(this.at(path), options);
        } catch {
            return undefined;
        }
    }

    /** @internal: a name in a folder. */
    within(ref: FolderRef, name: string): Place {
        const parts = splitName(name);
        const base = FolderRef.pathOf(ref);
        const folders = this.#folders();

        if (folders.length === 0) {
            return new Place(
                { kind: "plain", path: join(base, ...parts) },
                join(base, ...parts),
                this,
            );
        }

        const own = this.#locate(base, folders, true);

        if (own.kind === "confined") {
            const identity = ref.identity;

            return new Place(
                {
                    kind: "confined",
                    start: own.start,
                    parts: [...own.parts, ...parts],
                    ...(identity === undefined || own.parts.length === 0
                        ? {}
                        : { root: { depth: own.parts.length, ...identity } }),
                },
                join(base, ...parts),
                this,
            );
        }

        // The folder is plain, but the name may pass through a sandboxed folder below it.
        const joined = join(base, ...parts);

        return new Place(this.#locate(joined, folders, false), joined, this);
    }

    /** @internal: a path below a plain place, classified as a raw path is. */
    classified(path: string, label: string): Place {
        return new Place(this.#locate(path, this.#folders(), false), label, this);
    }
}

/** A place as data a worker can take (it is cloned, and holds no handle): `receivePlace` makes the place again. */
export type PlaceData = { located: Located; label: string; sandboxed: SandboxedFolder[] };

export const sendPlace = (place: Place): PlaceData => ({
    located: place.located,
    label: place.display.text,
    sandboxed: [...(place.context?.sandboxed() ?? [])],
});

/** In a worker: the same place, with the sandboxed folders it was sent with, so its children are classified as before. */
export const receivePlace = (data: PlaceData): Place =>
    new Place(data.located, data.label, new Hostfs({ sandboxedFolders: () => data.sandboxed }));

/**
 * The place above `place`, even above the top of a sandboxed folder (where the folders above are named as the owner
 * stated them); undefined at `/`.
 */
export function above(place: Place, host: Hostfs): Place | undefined {
    const up = place.parent();

    if (up !== undefined) {
        return up;
    }

    const shown = place.display.text;
    const outer = dirname(shown);

    return outer === shown ? undefined : host.at(outer);
}

/**
 * Pocket's own files (data, install, config, a drop-in's folder): plain paths under a root that the host owns, never a
 * folder of a session. These are the same calls as `node:fs`. Use a `FolderRef` for anything the guest can write.
 */
export function own(root: string): Place {
    return new Place({ kind: "plain", path: resolve(root) }, resolve(root));
}

/** Pocket's own file at an absolute path. */
export const ownPath = own;

/** `process.cwd()` as a place, for the places that look up files by `cwd` (own code). */
export function pathOf(place: Place): string {
    if (place.located.kind !== "plain") {
        throw refused(place.display.text);
    }

    return place.located.path;
}

/** What `FolderRef` is for a process: the folder's path, for the wrappers that start a process (`spawnIn`, `runGit`). */
export const folderPath = FolderRef.pathOf;

// No `toString`, `valueOf`, or `Symbol.toPrimitive`: a template, a concatenation, or `fs` rejects these objects.
Object.setPrototypeOf(FolderRef.prototype, null);
Object.setPrototypeOf(Place.prototype, null);
