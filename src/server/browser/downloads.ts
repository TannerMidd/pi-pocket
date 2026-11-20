/**
 * Downloads of the built-in browser. Chromium saves each one in a private folder of its page's browser context on this
 * server (`incoming`, named by its guid); when it completes, it goes where the conversation's session works:
 *
 * - A session on this server: into `pi-pocket-downloads-<uid>/<conversation>/` in this server's temporary folder, a
 *   folder only this user may open (`privateFolder`), under the name the page suggested.
 * - A session on another computer: copied in parts to `<folder>/<conversation>/`, where the folder is the one its
 *   runner's settings name, or else `pi-pocket-downloads` in that computer's temporary folder (`RunnerEnv`). The
 *   server's copy is deleted at once: its bytes pass through this server only for that moment.
 *
 * The browser tool reports each download once it began, and again once it ended, with where the file is.
 */
import { BACKGROUND_CONTEXT as BACKGROUND } from "@earendil-works/chord/context";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { chmod, copyFile, link, lstat, mkdir, rm, stat, unlink } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { extname, join } from "node:path";

/** The largest file a download may be. */
export const MAX_DOWNLOAD = 2 * 1024 ** 3;

/** The size of each part copied to a computer. */
const PART = 4 * 1024 * 1024;

/** How many downloads of a conversation are kept for its reports. */
const KEEP = 20;

/**
 * A computer's environment, where its temporary folder is (pi-env's `info()`), and the downloads folder its runner's
 * settings name, if any.
 */
export type Computer = {
    name: string;
    env: ExecutionEnv;
    tmpdir: string;
    separator: string;
    folder?: string;
    /** The session's permission id there (`runnerScope`): its downloads folder's name, the only one it may reach. */
    session: string;
};

export type DownloadState = "downloading" | "copying" | "done" | "failed" | "canceled";

export type Download = {
    guid: string;
    name: string;
    url: string;
    state: DownloadState;
    bytes: number;
    /** When it began (ms). */
    at: number;
    /** Where the file is now, when it is done. */
    path?: string;
    error?: string;
    /** What the browser tool already said about it. */
    reported: "nothing" | "began" | "ended";
};

type Tracked = {
    conversationId: number;
    context: string;
    file: string;
    download: Download;
};

/** A file name a page suggested, safe to use in any folder: no separators, no `..`, nothing Windows refuses. */
export function safeName(suggested: string): string {
    const cleaned = suggested
        .replace(/[\u0000-\u001f\u007f/\\<>:"|?*]/g, "_")
        .replace(/^[\s.]+|[\s.]+$/g, "");
    const name = fitBytes(cleaned, NAME_BYTES).replace(/[\s.]+$/g, "");

    return name === "" || /^\.+$/.test(name) ? "download" : name;
}

/** A file name's limit is in bytes (255 on most file systems): this leaves room for " (99)". */
const NAME_BYTES = 200;

/** `name` in at most `bytes` UTF-8 bytes, whole characters only, keeping a short extension. */
function fitBytes(name: string, bytes: number): string {
    const size = (text: string) => Buffer.byteLength(text, "utf8");

    if (size(name) <= bytes) {
        return name;
    }

    const dot = name.lastIndexOf(".");
    const extension = dot > 0 && size(name.slice(dot)) <= 16 ? name.slice(dot) : "";
    let stem = "";

    for (const character of name.slice(0, name.length - extension.length)) {
        if (size(stem + character + extension) > bytes) {
            break;
        }

        stem += character;
    }

    return stem + extension;
}

/** `name`, then "name (2).ext", "name (3).ext", … */
export function numbered(name: string, n: number): string {
    if (n === 1) {
        return name;
    }

    const ext = extname(name);
    const base = ext === "" || ext === name ? name : name.slice(0, -ext.length);

    return `${base} (${n})${base === name ? "" : ext}`;
}

export function formatSize(bytes: number): string {
    if (bytes < 1024) {
        return `${bytes} B`;
    }

    const units = ["KB", "MB", "GB"];
    let value = bytes / 1024;
    let unit = 0;

    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }

    return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/**
 * This server's folder for downloads of its own sessions: `pi-pocket-downloads-<uid>` in the temporary folder, mode
 * 0700. The temporary folder is shared by every user, so a folder there that is a link, or that another user owns
 * (made first, to read or swap the files), is refused; one of this user's that others may open is closed to them.
 */
export async function privateFolder(
    base = tmpdir(),
    uid: number | undefined = process.getuid?.(),
): Promise<string> {
    const folder = join(base, `pi-pocket-downloads-${uid ?? userInfo().username}`);

    await mkdir(folder, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") {
            throw error;
        }
    });

    const found = await lstat(folder);

    if (!found.isDirectory()) {
        throw new Error(`${folder} is not a folder: refused for downloads`);
    }

    if (uid !== undefined && found.uid !== uid) {
        throw new Error(`${folder} belongs to another user: refused for downloads`);
    }

    if (uid !== undefined && (found.mode & 0o077) !== 0) {
        await chmod(folder, 0o700);
    }

    return folder;
}

/** Move a finished file into `folder` on this server, under a free name; its path. */
export async function moveToFolder(file: string, folder: string, name: string): Promise<string> {
    await mkdir(folder, { recursive: true, mode: 0o700 });

    for (let n = 1; ; n++) {
        const target = join(folder, numbered(name, n));

        try {
            // A hard link fails when the name is taken: no race with another download of the same name.
            await link(file, target);
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;

            if (code === "EEXIST") {
                continue;
            }

            if (code !== "EXDEV" && code !== "EPERM" && code !== "ENOTSUP") {
                throw error;
            }

            try {
                await copyFile(file, target, constants.COPYFILE_EXCL);
            } catch (copyError) {
                if ((copyError as NodeJS.ErrnoException).code === "EEXIST") {
                    continue;
                }

                throw copyError;
            }
        }

        await unlink(file);

        return target;
    }
}

function failure(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Whether a download landed in a temporary folder (`pi-pocket-downloads`), here or on a computer. */
function temporary(path: string | undefined): boolean {
    return path !== undefined && /[/\\]pi-pocket-downloads(?:-[^/\\]+)?[/\\]/.test(path);
}

/**
 * Copy a finished file to `<folder>/<session>/` on a computer (`folder`: its runner's setting, or else
 * `pi-pocket-downloads` in its temporary folder; `session`: the session's permission id, the folder its runner lets
 * that session reach), in parts, under a free name; its path there. A part file takes the bytes and gets its name only
 * when complete.
 */
export async function copyToComputer(
    computer: Computer,
    file: string,
    name: string,
): Promise<string> {
    const { separator } = computer;
    const folder = [
        ...(computer.folder === undefined
            ? [computer.tmpdir.replace(/[\\/]+$/, ""), "pi-pocket-downloads"]
            : [computer.folder.replace(/(?<=.)[\\/]+$/, "")]),
        computer.session,
    ].join(separator);
    // One copy at a time into a folder: a free name is picked and taken before the next one looks.
    const previous = copying.get(folder) ?? Promise.resolve();
    const copy = previous.catch(() => {}).then(() => copyInto(computer, folder, file, name));
    const settled = copy.then(
        () => {},
        () => {},
    );

    copying.set(folder, settled);
    void settled.then(() => {
        if (copying.get(folder) === settled) {
            copying.delete(folder);
        }
    });

    return copy;
}

/** Copies to each computer folder, in turn (`copyToComputer`). */
const copying = new Map<string, Promise<void>>();

async function copyInto(
    computer: Computer,
    folder: string,
    file: string,
    name: string,
): Promise<string> {
    const { env, separator } = computer;

    const check = <T>(result: { ok: true; value: T } | { ok: false; error: Error }): T => {
        if (!result.ok) {
            throw result.error;
        }

        return result.value;
    };

    check(await env.createDir(folder, { recursive: true }, BACKGROUND));

    let n = 1;

    const free = async (): Promise<string> => {
        for (; ; n++) {
            const candidate = `${folder}${separator}${numbered(name, n)}`;

            if (!check(await env.exists(candidate, BACKGROUND))) {
                return candidate;
            }
        }
    };

    let target = await free();

    // Short, whatever the name: the name's own bytes plus this would pass the file system's limit.
    const part = `${folder}${separator}.pi-pocket-${randomUUID()}.part`;

    try {
        let first = true;

        for await (const chunk of createReadStream(file, { highWaterMark: PART })) {
            check(
                first
                    ? await env.writeFile(part, chunk as Buffer, BACKGROUND)
                    : await env.appendFile(part, chunk as Buffer, BACKGROUND),
            );
            first = false;
        }

        if (first) {
            check(await env.writeFile(part, "", BACKGROUND));
        }

        // Another program may have made a file of that name during the copy: rename replaces, so take the next free
        // one. pi-env has no rename that refuses to replace; this leaves only the moment between check and rename.
        if (check(await env.exists(target, BACKGROUND))) {
            target = await free();
        }

        check(await env.renameFile(part, target, BACKGROUND));
    } catch (error) {
        await env.remove(part, { force: true }, BACKGROUND).catch(() => {});

        throw error;
    }

    return target;
}

export class Downloads {
    readonly #byGuid = new Map<string, Tracked>();
    readonly #lists = new Map<number, Download[]>();
    readonly #waiters = new Set<() => void>();
    /** Finished downloads being moved or copied, by their browser context. */
    readonly #placing = new Map<Promise<void>, string>();
    readonly #place: (conversationId: number, file: string, name: string) => Promise<string>;
    readonly #cancel: (guid: string, context: string) => void;
    readonly #log: (line: string) => void;

    constructor(options: {
        /** Put a finished download where its session works; the path to report. */
        place(conversationId: number, file: string, name: string): Promise<string>;
        cancel(guid: string, context: string): void;
        log?(line: string): void;
    }) {
        this.#place = options.place;
        this.#cancel = options.cancel;
        this.#log = options.log ?? (() => {});
    }

    /** A page's download began (`Page.downloadWillBegin`); Chromium saves it as `incoming/<guid>`. */
    began(
        conversationId: number,
        context: string,
        incoming: string,
        params: { guid: string; url?: string; suggestedFilename?: string },
    ): void {
        if (this.#byGuid.has(params.guid)) {
            return;
        }

        const download: Download = {
            guid: params.guid,
            name: safeName(String(params.suggestedFilename ?? "")),
            url: String(params.url ?? ""),
            state: "downloading",
            bytes: 0,
            at: Date.now(),
            reported: "nothing",
        };
        const list = this.#lists.get(conversationId) ?? [];

        list.push(download);

        // Past the limit, the oldest one already reported as ended goes: never one still going or not yet reported.
        if (list.length > KEEP) {
            const old = list.findIndex((each) => each.reported === "ended");

            if (old !== -1) {
                list.splice(old, 1);
            }
        }

        this.#lists.set(conversationId, list);
        this.#byGuid.set(params.guid, {
            conversationId,
            context,
            file: join(incoming, params.guid),
            download,
        });
        this.#wake();
    }

    /** `Browser.downloadProgress`. A download nobody tracks is deleted when it completes: no copy stays here. */
    progress(params: {
        guid: string;
        totalBytes?: number;
        receivedBytes?: number;
        state: string;
        filePath?: string;
    }): void {
        const tracked = this.#byGuid.get(params.guid);

        if (tracked === undefined) {
            return;
        }

        const { download } = tracked;

        if (download.state !== "downloading") {
            return;
        }

        download.bytes = Math.max(download.bytes, Number(params.receivedBytes ?? 0));

        const total = Number(params.totalBytes ?? 0);

        if (params.state === "inProgress") {
            if (download.bytes > MAX_DOWNLOAD || total > MAX_DOWNLOAD) {
                this.#cancel(params.guid, tracked.context);
                this.#end(tracked, "failed", `it is larger than ${formatSize(MAX_DOWNLOAD)}`);
            }

            return;
        }

        if (params.state === "canceled") {
            this.#end(tracked, "canceled");

            return;
        }

        if (params.state === "completed") {
            const placing = this.#finish(tracked, params.filePath ?? tracked.file);

            this.#placing.set(placing, tracked.context);
            void placing.finally(() => this.#placing.delete(placing));
        }
    }

    /** Once the finished downloads of a browser context are where they go (or failed). */
    async settled(context: string): Promise<void> {
        await Promise.all(
            [...this.#placing].filter(([, of]) => of === context).map(([placing]) => placing),
        );
    }

    /** Once every finished download is where it goes (or failed). */
    async settledAll(): Promise<void> {
        await Promise.all([...this.#placing.keys()]);
    }

    /** The context closed: its downloads in progress end, and its files go. */
    closed(context: string): void {
        for (const tracked of [...this.#byGuid.values()]) {
            if (tracked.context === context && tracked.download.state === "downloading") {
                this.#end(tracked, "canceled");
            }
        }
    }

    async #finish(tracked: Tracked, file: string): Promise<void> {
        const { download } = tracked;

        download.state = "copying";
        this.#wake();

        let path: string | undefined;
        let error: string | undefined;

        try {
            const size = (await stat(file)).size;

            download.bytes = size;

            if (size > MAX_DOWNLOAD) {
                throw new Error(`it is larger than ${formatSize(MAX_DOWNLOAD)}`);
            }

            path = await this.#place(tracked.conversationId, file, download.name);
        } catch (caught) {
            error = failure(caught);
            this.#log(`Browser: the download of ${download.name} failed: ${error}`);
        }

        // Whatever happened, no copy stays here (moved files are gone already), and it goes before the download
        // counts as ended: what waits for the end finds no copy left.
        await rm(file, { force: true }).catch(() => {});

        if (path === undefined) {
            download.state = "failed";
            download.error = error;
        } else {
            download.path = path;
            download.state = "done";
        }

        this.#byGuid.delete(download.guid);
        this.#wake();
    }

    #end(tracked: Tracked, state: "failed" | "canceled", error?: string): void {
        tracked.download.state = state;

        if (error !== undefined) {
            tracked.download.error = error;
        }

        this.#byGuid.delete(tracked.download.guid);
        void rm(tracked.file, { force: true }).catch(() => {});
        this.#wake();
    }

    /** Whether a download of the conversation began at `since` (ms) or later, waiting at most `ms` for one. */
    async beganSince(conversationId: number, since: number, ms: number): Promise<boolean> {
        const end = Date.now() + ms;
        const found = () =>
            (this.#lists.get(conversationId) ?? []).some((each) => each.at >= since);

        while (!found() && Date.now() < end) {
            await new Promise((done) => setTimeout(done, 50));
        }

        return found();
    }

    /** The conversation's latest download that ended and was reported, as its line said. */
    lastEnded(conversationId: number): string | undefined {
        const download = (this.#lists.get(conversationId) ?? [])
            .filter((each) => each.reported === "ended")
            .at(-1);

        if (download === undefined) {
            return undefined;
        }

        return download.state === "done"
            ? `${download.path} (${formatSize(download.bytes)})`
            : `${download.name}, which ${download.state === "canceled" ? "was canceled" : "failed"}`;
    }

    /** Whether a download of the conversation has not ended yet. */
    pending(conversationId: number): boolean {
        return (this.#lists.get(conversationId) ?? []).some(
            (each) => each.state === "downloading" || each.state === "copying",
        );
    }

    /** What the browser tool has not said yet about the conversation's downloads, one line each. */
    report(conversationId: number): string[] {
        const lines: string[] = [];

        for (const download of this.#lists.get(conversationId) ?? []) {
            if (download.reported === "ended") {
                continue;
            }

            if (download.state === "downloading" || download.state === "copying") {
                if (download.reported === "nothing") {
                    lines.push(`Downloading ${download.name}…`);
                    download.reported = "began";
                }

                continue;
            }

            download.reported = "ended";
            lines.push(
                download.state === "done"
                    ? `Downloaded ${download.path} (${formatSize(download.bytes)}).${temporary(download.path) ? " It is in a temporary folder, which the system can clear on restart: move it out to keep it." : ""}`
                    : download.state === "canceled"
                      ? `The download of ${download.name} was canceled.`
                      : `The download of ${download.name} failed: ${download.error}.`,
            );
        }

        return lines;
    }

    /**
     * Wait until the conversation's downloads end, or one that begins meanwhile, for at most `timeoutMs`. False when
     * one is still going at the end, or none began.
     */
    async wait(conversationId: number, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
        const end = Date.now() + timeoutMs;
        const unreported = () =>
            (this.#lists.get(conversationId) ?? []).some((each) => each.reported !== "ended");

        while (signal?.aborted !== true) {
            if (unreported() && !this.pending(conversationId)) {
                return true;
            }

            const left = end - Date.now();

            if (left <= 0) {
                return false;
            }

            await new Promise<void>((done) => {
                const waiters = this.#waiters;
                const timer = setTimeout(finish, Math.min(left, 1000));

                function finish(): void {
                    clearTimeout(timer);
                    waiters.delete(finish);
                    signal?.removeEventListener("abort", finish);
                    done();
                }

                waiters.add(finish);
                signal?.addEventListener("abort", finish, { once: true });
            });
        }

        return false;
    }

    #wake(): void {
        const waiters = [...this.#waiters];

        this.#waiters.clear();

        for (const wake of waiters) {
            wake();
        }
    }
}
