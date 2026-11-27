/**
 * Reading the folder of a sandboxed session as the host, without leaving it. The folder is untrusted, as a cloned
 * repository is: a guest may leave a link in it that names `~/.ssh/id_rsa`, and a host that follows it would show that file to a person
 * or put it in a prompt. A path that lies in the folder is read only when the file it reaches does too, links
 * followed. The check is on the file that was opened (its place on Linux, its identity elsewhere), never only on the
 * path before it, so a link put in the way while the file is opened cannot lead out.
 */
import {
    closeSync,
    constants,
    fstatSync,
    openSync,
    readFileSync,
    readlinkSync,
    realpathSync,
    statSync,
} from "node:fs";
import { open, readlink, realpath, stat, type FileHandle } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

const READ = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0);
const FD_LINKS = process.platform === "linux";

const sandboxedFolders = new Set<(folder: string) => boolean>();

/** A server says which folders a sandboxed session uses. Returns how to stop. */
export function onSandboxedFolders(uses: (folder: string) => boolean): () => void {
    sandboxedFolders.add(uses);

    return () => void sandboxedFolders.delete(uses);
}

/** Whether a sandboxed session uses `folder`, so that a guest may have written what is in it. */
export function sandboxedFolder(folder: string): boolean {
    return [...sandboxedFolders].some((uses) => uses(folder));
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

function leadsOut(path: string): NodeJS.ErrnoException {
    return Object.assign(new Error(`EACCES: ${path} leads out of the folder`), {
        code: "EACCES",
        path,
    });
}

/** The real path of `path`; throws when it is not in the real path of `root`. */
export async function realInside(root: string, path: string): Promise<string> {
    const [folder, real] = await Promise.all([realpath(root), realpath(path)]);

    if (!within(folder, real)) {
        throw leadsOut(path);
    }

    return real;
}

/** `path` opened for reading: a file that is in `root` once it is open. */
export async function openInside(root: string, path: string): Promise<FileHandle> {
    const real = await realInside(root, path);
    const folder = await realpath(root);
    const handle = await open(real, READ);

    try {
        const here = FD_LINKS
            ? await readlink(`/proc/self/fd/${handle.fd}`).catch(() => undefined)
            : undefined;
        const [named, opened] = await Promise.all([
            stat(real, { bigint: true }),
            handle.stat({ bigint: true }),
        ]);

        if (
            here === undefined
                ? named.dev !== opened.dev || named.ino !== opened.ino
                : !within(folder, here)
        ) {
            throw leadsOut(path);
        }
    } catch (error) {
        await handle.close();

        throw error;
    }

    return handle;
}

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

/** What `readFileSync(path)` gives, for a path that is in `root` by the file it reaches. */
export function readInsideSync(root: string, path: string): Buffer {
    const folder = realpathSync(root);
    const real = realpathSync(path);

    if (!within(folder, real)) {
        throw leadsOut(path);
    }

    const fd = openSync(real, READ);

    try {
        let here: string | undefined;

        try {
            here = FD_LINKS ? readlinkSync(`/proc/self/fd/${fd}`) : undefined;
        } catch {
            here = undefined;
        }

        const named = statSync(real, { bigint: true });
        const opened = fstatSync(fd, { bigint: true });

        if (
            here === undefined
                ? named.dev !== opened.dev || named.ino !== opened.ino
                : !within(folder, here)
        ) {
            throw leadsOut(path);
        }

        return readFileSync(fd);
    } finally {
        closeSync(fd);
    }
}
