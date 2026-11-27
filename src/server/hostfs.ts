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
    symlinkSync,
    linkSync,
    chmodSync,
    utimesSync,
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

    constructor(host: Hostfs, path: string) {
        this.#host = host;
        this.#path = resolve(path);

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

    /** @internal */
    constructor(located: Located, label: string) {
        this.located = located;
        this.#label = label;
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

        return this.located.kind === "plain"
            ? new Place(
                  { kind: "plain", path: join(this.located.path, ...parts) },
                  join(this.#label, ...parts),
              )
            : new Place(
                  {
                      kind: "confined",
                      start: this.located.start,
                      parts: [...this.located.parts, ...parts],
                      ...(this.located.root === undefined ? {} : { root: this.located.root }),
                  },
                  join(this.#label, ...parts),
              );
    }

    /** The place that holds this one; undefined at the top of its folder. */
    parent(): Place | undefined {
        const at = this.located;

        if (at.kind === "plain") {
            const up = dirname(at.path);

            return up === at.path
                ? undefined
                : new Place({ kind: "plain", path: up }, dirname(this.#label));
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

        // The entry itself is the admitted root: it must be that folder, not a link or another one in its place.
        if (at.root?.depth === at.parts.length) {
            const info = lstatSync(path, { bigint: true });

            if (info.dev !== at.root.dev || info.ino !== at.root.ino) {
                throw failure(
                    "ESTALE",
                    `${shown} is no longer the folder it was admitted as`,
                    shown,
                );
            }
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
): T {
    const pinned = pin(place, make);

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
): Promise<T> {
    const pinned = pin(place, make);

    try {
        return await run(pinned.path, pinned.confined, pinned.self);
    } finally {
        pinned.release();
    }
}

/** Open `path` (made by `pin`) as the last name of a sandboxed place: never through a link. */
const lastFlags = (flags: number, confined: boolean): number =>
    confined ? flags | NO_FOLLOW : flags;

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

    /** What is left of the file, from the start. */
    readAll(): Buffer {
        return readFileSync(this.#fd);
    }

    close(): void {
        if (!this.#closed) {
            this.#closed = true;
            closeSync(this.#fd);
        }
    }
}

/** What a regular file read of a sandboxed place is bounded by. */
export type ReadOptions = { max?: number };

function readConfined(place: Place, path: string, max: number): Buffer {
    const fd = noLink(place.display.text, () =>
        fsOpenSync(path, constants.O_RDONLY | NON_BLOCK | NO_FOLLOW),
    );

    try {
        const info = fstatSync(fd);

        if (!info.isFile() || info.size > max) {
            throw notRegular(place, max);
        }

        return readFileSync(fd);
    } finally {
        closeSync(fd);
    }
}

// ---- Operations. A plain place is the plain call; a sandboxed one is confined. -------------------------------------

export function readFile(place: Place, options?: ReadOptions): Buffer {
    return use(place, (path, confined) =>
        confined ? readConfined(place, path, options?.max ?? MAX_TEXT) : readFileSync(path),
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

        const handle = await noLink(place.display.text, () =>
            fsp.open(path, constants.O_RDONLY | NON_BLOCK | NO_FOLLOW),
        );

        try {
            const info = await handle.stat();
            const max = options?.max ?? MAX_TEXT;

            if (!info.isFile() || info.size > max) {
                throw notRegular(place, max);
            }

            return await handle.readFile();
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
    use(place, (path) => unlinkSync(path));
}

export async function unlinkAsync(place: Place): Promise<void> {
    await useAsync(place, (path) => fsp.unlink(path));
}

export function rmdir(place: Place): void {
    use(place, (path) => rmdirSync(path));
}

export async function rmdirAsync(place: Place): Promise<void> {
    await useAsync(place, (path) => fsp.rmdir(path));
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
    use(from, (source) => use(to, (target) => renameSync(source, target)));
}

export async function renameAsync(from: Place, to: Place): Promise<void> {
    await useAsync(from, (source) => useAsync(to, (target) => fsp.rename(source, target)));
}

export function copyFile(from: Place, to: Place, mode?: number): void {
    if (from.located.kind === "plain" && to.located.kind === "plain") {
        copyFileSync(from.located.path, to.located.path);

        return;
    }

    // The source is read through its own descriptor, so a link swapped in is refused, not followed.
    writeFile(to, readFile(from, { max: Number.MAX_SAFE_INTEGER }));

    if (mode !== undefined) {
        use(to, (path) => chmodSync(path, mode));
    }
}

export async function copyFileAsync(from: Place, to: Place): Promise<void> {
    if (from.located.kind === "plain" && to.located.kind === "plain") {
        await fsp.copyFile(from.located.path, to.located.path);

        return;
    }

    copyFile(from, to);
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

            const fd = noLink(place.display.text, () =>
                fsOpenSync(
                    path,
                    lastFlags(modeFlags(options.flag ?? "w"), true),
                    options.mode ?? 0o666,
                ),
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
        const fd = noLink(place.display.text, () =>
            fsOpenSync(
                path,
                confined ? lastFlags(bits | (bits & 3 ? 0 : NON_BLOCK), true) : bits,
                mode,
            ),
        );

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

        return new OpenFile(noLink(place.display.text, () => fsOpenSync(path, flags | NO_FOLLOW)));
    });
}

export async function open(
    place: Place,
    flags: string | number = "r",
    mode?: number,
): Promise<FileHandle> {
    return useAsync(place, async (path, confined) => {
        const bits = modeFlags(flags);

        return noLink(place.display.text, () =>
            fsp.open(
                path,
                confined ? lastFlags(bits | (bits & 3 ? 0 : NON_BLOCK), true) : bits,
                mode,
            ),
        );
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

        return noLink(place.display.text, () => fsp.open(path, flags | NO_FOLLOW));
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

        const fd = noLink(place.display.text, () =>
            fsOpenSync(path, constants.O_RDONLY | NON_BLOCK | NO_FOLLOW),
        );

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

export { appendFileSync, accessSync, chmodSync, copyFileSync, linkSync, symlinkSync, utimesSync };

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

    constructor(view: SandboxView = NO_SANDBOX) {
        this.#view = view;
    }

    #folders(): Folder[] {
        return [...this.#view.sandboxedFolders()].map((each) => ({
            ...each,
            path: resolve(each.path),
            key: keyOf(each),
        }));
    }

    /** A folder as a session works in it. */
    folder(path: string): FolderRef {
        return new FolderRef(this, path);
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

        return new Place(this.#locate(path, folders, false), resolve(path));
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
            return new Place({ kind: "plain", path: join(base, ...parts) }, join(base, ...parts));
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
            );
        }

        // The folder is plain, but the name may pass through a sandboxed folder below it.
        const joined = join(base, ...parts);

        return new Place(this.#locate(joined, folders, false), joined);
    }
}

/** A place as data a worker can take (it is cloned, and holds no handle): `receivePlace` makes the place again. */
export type PlaceData = { located: Located; label: string };

export const sendPlace = (place: Place): PlaceData => ({
    located: place.located,
    label: place.display.text,
});

export const receivePlace = (data: PlaceData): Place => new Place(data.located, data.label);

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
