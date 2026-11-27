/**
 * Whether two session folders overlap (`sandbox.ts`, invariant I1): by their stated paths, and by the folders they
 * really are, known by device and inode. A walk from `/` follows links while it is outside the other folder, so an
 * alias, a link, or a mount of the same folder counts; it stops the moment it is inside the other folder, so a link
 * that a guest made there is never followed. A folder that is not there overlaps only by its stated path.
 *
 * Salvaged from `confined.ts` of the closed #415 and cut to this one question. The structural file access of the
 * design (`hostfs.ts`) replaces the file reads here in a later PR; this module only stats folders.
 */
import { lstatSync, readlinkSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

/** Whether `path` is `root` or lies in it, by name. */
export function within(root: string, path: string): boolean {
    const from = relative(resolve(root), resolve(path));

    return from === "" || (from !== ".." && !from.startsWith(`..${sep}`) && !isAbsolute(from));
}

/** A folder's identity: the device and the inode, which no path or alias changes. */
function identity(path: string): string | undefined {
    try {
        const { dev, ino } = statSync(path, { bigint: true });

        return `${dev}:${ino}`;
    } catch {
        return undefined;
    }
}

/**
 * Walk `path` from `/`, one name at a time, following links, and say whether the walk is ever in the folder with
 * identity `target`. Every folder on the way counts, so a link that passes through the folder is found too.
 */
function passesThrough(path: string, target: string): boolean {
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
            return false;
        }

        if (info.isSymbolicLink()) {
            if (++links > 40) {
                return false;
            }

            const link = readlinkSync(next);
            const start = isAbsolute(link) ? parse(link).root : at;

            pending.unshift(
                ...link
                    .slice(isAbsolute(link) ? start.length : 0)
                    .split(sep)
                    .filter(Boolean),
            );
            at = start;
            continue;
        }

        at = next;

        if (`${info.dev}:${info.ino}` === target) {
            return true;
        }
    }

    return false;
}

/** Whether folders `a` and `b` are the same, or one holds the other, by name or by place. */
export function foldersOverlap(a: string, b: string): boolean {
    if (within(a, b) || within(b, a)) {
        return true;
    }

    const first = identity(a);
    const second = identity(b);

    return (
        first !== undefined &&
        second !== undefined &&
        (first === second || passesThrough(a, second) || passesThrough(b, first))
    );
}

/** Whether `a` and `b` are exactly the same folder: the same path, or the same device and inode. */
export function sameFolder(a: string, b: string): boolean {
    if (resolve(a) === resolve(b)) {
        return true;
    }

    const first = identity(a);

    return first !== undefined && first === identity(b);
}
