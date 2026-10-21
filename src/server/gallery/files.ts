/**
 * An extension's files in the drop-in folder, as the gallery writes, reads, and removes them: only names the extension
 * may have (`fileProblem`), never through a link, and a version all or none. A version goes in place with a journal
 * beside it (`.<name>.gallery-undo.json`), and what each move replaces is kept aside until all are done: when a move
 * fails, or the server stops in the middle, everything goes back as it was (`recover`, before extensions load).
 *
 * The checks look at paths, then the files are used: something that changes the folder at that very moment (a link
 * swapped in) could get past them. Only the owner's own account should be able to write there, and it has the owner's
 * rights already.
 */
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { describe, HttpError } from "../errors.ts";
import { fileProblem, LIMITS } from "./entry.ts";

/** One file of a version, as it is written. */
export type Written = { name: string; bytes: Uint8Array };

/**
 * One move of a version: the file written beside its place (`from`) to its place (`to`), with what was there kept at
 * `old`. A removal is a move to `old` alone.
 */
type Step = { to: string; old?: string; from?: string };

const JOURNAL = /^\.([a-z0-9][a-z0-9_-]{1,63})\.gallery-undo\.json$/;

export const journalOf = (root: string, name: string) => join(root, `.${name}.gallery-undo.json`);

export const exists = (path: string) =>
    lstat(path).then(
        () => true,
        () => false,
    );

/** A file's text, or undefined for one that is not UTF-8 text. */
export function textOf(bytes: Uint8Array): string | undefined {
    try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);

        return text.includes("\0") ? undefined : text;
    } catch {
        return undefined;
    }
}

/** Which file a path is, to tell two names for one file apart (`A.ts` and `a.ts` where case is ignored). */
const identity = async (path: string) => {
    const stat = await lstat(path).catch(() => undefined);

    return stat === undefined ? undefined : `${stat.dev}:${stat.ino}`;
};

/** An extension's file in the drop-in folder `root`: refused when its name is not one the extension may have. */
export function target(root: string, name: string, file: string): string {
    const problem = fileProblem(file, name);
    const path = resolve(root, ...file.split("/"));

    if (problem !== undefined || !path.startsWith(resolve(root) + sep)) {
        throw new HttpError(409, `${file} ${problem ?? "is outside the extensions folder"}`);
    }

    return path;
}

/**
 * Refuse a link on the way to an extension's file, or at it, and anything there that is not a file: writing or reading
 * through a link would reach past the drop-in folder.
 */
export async function plain(root: string, name: string, file: string): Promise<void> {
    const parts = file.split("/");
    let path = root;

    for (let at = 0; at < parts.length; at++) {
        path = join(path, parts[at]!);
        const stat = await lstat(path).catch(() => undefined);
        const shown = parts.slice(0, at + 1).join("/");

        if (stat === undefined) {
            return;
        }

        if (stat.isSymbolicLink()) {
            throw new HttpError(409, `${shown} is a link: the gallery does not go through links`);
        }

        if (at < parts.length - 1 ? !stat.isDirectory() : !stat.isFile()) {
            throw new HttpError(
                409,
                `${shown} in the extensions folder is ${at < parts.length - 1 ? "not a folder" : "not a file"}: move it away first`,
            );
        }
    }
}

/** An installed file's bytes, or undefined when it is not there. */
export async function readInstalled(
    root: string,
    name: string,
    file: string,
): Promise<Uint8Array | undefined> {
    const path = target(root, name, file);

    await plain(root, name, file);

    const stat = await lstat(path).catch(() => undefined);

    if (stat === undefined) {
        return undefined;
    }

    if (stat.size > LIMITS.file) {
        throw new HttpError(409, `${file} is larger than ${LIMITS.file} bytes now`);
    }

    return readFile(path);
}

/**
 * Where one of an extension's files is, to remove it: undefined when it is not there, or is reached through a folder
 * that is a link (the file is elsewhere then). A link itself is removed, never what it leads to.
 */
export async function removable(
    root: string,
    name: string,
    file: string,
): Promise<string | undefined> {
    const path = target(root, name, file);
    const parts = file.split("/");

    for (let at = 1; at < parts.length; at++) {
        const folder = await lstat(join(root, ...parts.slice(0, at))).catch(() => undefined);

        if (folder === undefined || !folder.isDirectory()) {
            return undefined;
        }
    }

    const stat = await lstat(path).catch(() => undefined);

    return stat === undefined || stat.isDirectory() ? undefined : path;
}

/** Remove the empty folders in an extension's own folder, and that folder when it is empty. */
export async function prune(folder: string): Promise<void> {
    const stat = await lstat(folder).catch(() => undefined);

    if (stat === undefined || !stat.isDirectory()) {
        return;
    }

    for (const each of await readdir(folder, { withFileTypes: true })) {
        if (each.isDirectory()) {
            await prune(join(folder, each.name));
        }
    }

    await rmdir(folder).catch(() => {});
}

/**
 * Put back what the steps changed, last first: what a move replaced returns to its place, and a file that was not
 * there before goes. Says what could not be put back.
 */
async function undo(steps: readonly Step[]): Promise<string[]> {
    const failed: string[] = [];

    for (const step of [...steps].reverse()) {
        try {
            if (step.old !== undefined && (await exists(step.old))) {
                await rename(step.old, step.to);
            } else if (
                step.old === undefined &&
                step.from !== undefined &&
                !(await exists(step.from))
            ) {
                await rm(step.to, { force: true });
            }

            if (step.from !== undefined) {
                await rm(step.from, { force: true });
            }
        } catch (error) {
            failed.push(`${basename(step.to)}: ${describe(error)}`);
        }
    }

    return failed;
}

/**
 * Put a version of an extension in place: its `files`, then `last` (its provenance, so that it never names a version
 * that is not in place), and remove `remove` (files of the version before that this one does not have). Each file is
 * written beside its place first; then they move into place, the module last of its files, so that when it appears
 * (and, when it is on, loads again) the files it imports are there.
 */
export async function place(
    root: string,
    name: string,
    files: readonly Written[],
    last: { path: string; text: string },
    remove: readonly string[],
): Promise<void> {
    const module = `${name}.ts`;
    // Names that start with a dot: neither the loader nor a browser module's folder serves them.
    const aside = (path: string, end: string) =>
        join(dirname(path), `.${basename(path)}.${randomUUID()}.${end}`);
    const journal = journalOf(root, name);
    const steps: Step[] = [];

    // A version that could not be put back is still in its journal, for the next start: a new one must not overwrite it.
    if (await exists(journal)) {
        throw new HttpError(
            409,
            `An earlier change to ${name} was not put back yet: restart the server, then try again`,
        );
    }

    try {
        const staged = async (to: string, bytes: Uint8Array | string) => {
            const from = aside(to, "part");

            try {
                await writeFile(from, bytes, { flag: "wx" });
            } catch (error) {
                await rm(from, { force: true });

                throw error;
            }

            steps.push({ to, from, ...((await exists(to)) ? { old: aside(to, "old") } : {}) });
        };

        for (const file of [...files].sort(
            (a, b) => Number(a.name === module) - Number(b.name === module),
        )) {
            await plain(root, name, file.name);
            const to = target(root, name, file.name);

            await mkdir(dirname(to), { recursive: true });
            await staged(to, file.bytes);
        }

        await staged(last.path, last.text);

        // Where the file system ignores case, an old name can be a new file's (`A.ts` for `a.ts`): that one stays.
        const kept = new Set(await Promise.all(steps.map((step) => identity(step.to))));

        for (const file of remove) {
            const to = await removable(root, name, file);

            if (to !== undefined && !kept.has(await identity(to))) {
                steps.push({ to, old: aside(to, "old") });
            }
        }

        await writeFile(journal, JSON.stringify(steps));

        for (const step of steps) {
            if (step.old !== undefined) {
                await rename(step.to, step.old);
            }

            if (step.from !== undefined) {
                await rename(step.from, step.to);
            }
        }
    } catch (error) {
        const failed = await undo(steps);

        if (failed.length > 0) {
            throw new HttpError(
                500,
                `${describe(error)}; putting the files back failed too (${failed.join("; ")}): the server tries again when it starts`,
            );
        }

        await rm(journal, { force: true });

        throw error;
    }

    // All in place: the journal goes first, so a stop from here on keeps the new version, then what it replaced (a stop
    // between the two leaves those hidden `.old` files behind, which nothing loads or serves).
    await rm(journal, { force: true });

    for (const step of steps) {
        if (step.old !== undefined) {
            await rm(step.old, { force: true }).catch(() => {});
        }
    }

    await prune(join(root, name));
}

/**
 * Put back each version the server stopped in the middle of putting in place, from its journal: before extensions
 * load, so none loads half of one. Answers the extensions it put back, and what it could not.
 */
export async function recover(root: string): Promise<{ name: string; failed: string[] }[]> {
    let files: string[];

    try {
        files = await readdir(root);
    } catch {
        return [];
    }

    const done: { name: string; failed: string[] }[] = [];
    const inside = (path: unknown) =>
        typeof path === "string" && resolve(path).startsWith(resolve(root) + sep);

    for (const file of files) {
        const name = JOURNAL.exec(file)?.[1];

        if (name === undefined) {
            continue;
        }

        let steps: Step[];

        try {
            steps = JSON.parse(await readFile(join(root, file), "utf8")) as Step[];

            if (
                !Array.isArray(steps) ||
                !steps.every(
                    (step) =>
                        inside(step.to) &&
                        (step.old === undefined || inside(step.old)) &&
                        (step.from === undefined || inside(step.from)),
                )
            ) {
                throw new Error("it names files outside the extensions folder");
            }
        } catch (error) {
            // It is written whole before anything moves: one that cannot be read moved nothing. It goes aside, so that
            // `place` takes the next change to this extension.
            const aside = `${file}.${randomUUID()}.unread`;
            const kept = await rename(join(root, file), join(root, aside)).then(
                () => `it is kept as ${aside}`,
                (again: unknown) => `moving it aside failed too: ${describe(again)}`,
            );

            done.push({
                name,
                failed: [
                    `its journal cannot be read (${describe(error)}), so it was not used: ${kept}`,
                ],
            });
            continue;
        }

        const failed = await undo(steps);

        if (failed.length === 0) {
            await rm(join(root, file), { force: true });
        }

        done.push({ name, failed });
    }

    return done;
}
