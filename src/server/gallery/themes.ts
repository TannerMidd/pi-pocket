/**
 * Themes from the gallery, in the data folder's `themes/`. A version is written to a hidden folder there (which the
 * theme list and its addresses skip), checked as every theme folder is (`readTheme`: `theme.json`, `colors.toml`, and
 * the CSS check), given its provenance (`.gallery.json`, hidden in the folder, so it moves with it), and only then
 * moved into place, in one rename. The version before goes to `themes/.removed/`, as Remove in Appearance does, so
 * nothing the owner changed in it is lost.
 */
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { describe, HttpError } from "../errors.ts";
import { readTheme } from "../themes.ts";
import { THEME_ID, THEME_LIMITS, ThemeProblem } from "../themes/format.ts";
import { EntryError, parseThemeEntry, sha256, type ThemeEntry, themeFileProblem } from "./entry.ts";
import { exists, type Written } from "./files.ts";

/** Where a theme from the gallery came from: in its folder, hidden. */
export const THEME_SIDECAR = ".gallery.json";
/** A version being put in place: `.gallery-<id>-<uuid>.part`. */
const STAGED = /^\.gallery-([a-z0-9][a-z0-9-]{1,47})-[0-9a-f-]{36}\.part$/;

export interface ThemeProvenance {
    index: string;
    installedAt: number;
    entry: ThemeEntry;
}

/** A theme file's path in its folder: its name in the entry without the folder (`paper/theme.css` is `theme.css`). */
export const innerPath = (entry: { name: string }, file: string) =>
    file.slice(entry.name.length + 1);

/** A theme's folder in `themes/`, as a folder: undefined when there is none, refused when it is a link or a file. */
async function folderOf(dir: string, id: string): Promise<string | undefined> {
    const folder = join(dir, id);
    const stat = await lstat(folder).catch(() => undefined);

    if (stat === undefined) {
        return undefined;
    }

    if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new HttpError(409, `themes/${id} is a link or not a folder: move it away first`);
    }

    return folder;
}

/** A file of a theme as it is in its folder, or undefined when it is not there: never through a link. */
export async function readThemeFile(
    dir: string,
    id: string,
    inner: string,
): Promise<Uint8Array | undefined> {
    let path = join(dir, id);
    const parts = inner.split("/");

    for (let at = 0; at < parts.length; at++) {
        path = join(path, parts[at]!);
        const stat = await lstat(path).catch(() => undefined);

        if (stat === undefined || stat.isSymbolicLink()) {
            return undefined;
        }

        if (at < parts.length - 1 ? !stat.isDirectory() : !stat.isFile()) {
            return undefined;
        }

        if (at === parts.length - 1 && stat.size > THEME_LIMITS.asset) {
            throw new HttpError(409, `${id}/${inner} is larger than the theme format allows now`);
        }
    }

    return readFile(path);
}

/** Where a theme came from, from its folder's `.gallery.json`; undefined for one the gallery did not install. */
export async function themeProvenance(
    dir: string,
    id: string,
): Promise<ThemeProvenance | undefined> {
    if (!THEME_ID.test(id)) {
        return undefined;
    }

    const folder = await folderOf(dir, id).catch(() => undefined);
    const bytes = folder === undefined ? undefined : await readThemeFile(dir, id, THEME_SIDECAR);

    if (bytes === undefined) {
        return undefined;
    }

    try {
        const value = JSON.parse(Buffer.from(bytes).toString("utf8")) as Record<string, unknown>;
        const entry = parseThemeEntry(value.entry);

        if (
            entry.name !== id ||
            typeof value.index !== "string" ||
            typeof value.installedAt !== "number"
        ) {
            throw new EntryError("it is not one the gallery wrote");
        }

        return { index: value.index, installedAt: value.installedAt, entry };
    } catch (error) {
        throw new HttpError(
            409,
            `themes/${id}/${THEME_SIDECAR} cannot be read (${describe(error)}): remove the theme in Appearance`,
        );
    }
}

/** Every theme the gallery installed: those whose provenance cannot be read are left out. */
export async function themeProvenances(dir: string): Promise<ThemeProvenance[]> {
    const names = await readdir(dir).catch(() => [] as string[]);
    const found: ThemeProvenance[] = [];

    for (const id of names.sort()) {
        const provenance = await themeProvenance(dir, id).catch(() => undefined);

        if (provenance !== undefined) {
            found.push(provenance);
        }
    }

    return found;
}

/** The entry's files that are not as installed: edited since, or gone. */
export async function changedThemeFiles(dir: string, entry: ThemeEntry): Promise<string[]> {
    const changed: string[] = [];

    for (const file of entry.files) {
        const bytes = await readThemeFile(dir, entry.name, innerPath(entry, file.name)).catch(
            () => undefined,
        );

        if (bytes === undefined || sha256(bytes) !== file.sha256) {
            changed.push(file.name);
        }
    }

    return changed;
}

/**
 * Put a version of a theme in place: its files in a hidden folder, checked whole as the theme list will check them,
 * its provenance, then one rename into `themes/<id>`. With `replace`, the folder there now goes to `themes/.removed/`
 * first; without it, there must be none.
 */
export async function placeTheme(
    dir: string,
    files: readonly Written[],
    provenance: ThemeProvenance,
    options: { replace: boolean; pocketVersion: string },
): Promise<void> {
    const { entry } = provenance;
    const id = entry.name;

    await mkdir(dir, { recursive: true });

    const staged = join(dir, `.gallery-${id}-${randomUUID()}.part`);

    await mkdir(staged);

    try {
        for (const file of files) {
            const problem = themeFileProblem(file.name, id);
            const path = resolve(staged, ...innerPath(entry, file.name).split("/"));

            if (problem !== undefined || !path.startsWith(staged + sep)) {
                throw new HttpError(409, `${file.name} ${problem ?? "is outside its folder"}`);
            }

            await mkdir(dirname(path), { recursive: true });
            await writeFile(path, file.bytes, { flag: "wx" });
        }

        // The check every theme folder has, before anything is in place: a theme that fails it is not installed.
        try {
            readTheme(staged, id, false, options.pocketVersion);
        } catch (error) {
            throw new HttpError(
                422,
                `${entry.title} was not installed: ${error instanceof ThemeProblem ? error.message : describe(error)}`,
            );
        }

        // Last: a staged folder with its provenance is whole and checked (`recoverThemes`).
        await writeFile(
            join(staged, THEME_SIDECAR),
            `${JSON.stringify({ format: 1, kind: "theme", ...provenance }, null, 2)}\n`,
            { flag: "wx" },
        );

        const before = await folderOf(dir, id);

        if (before !== undefined && !options.replace) {
            throw new HttpError(409, `The themes folder has ${id} already: move it away first`);
        }

        if (before !== undefined) {
            const removed = join(dir, ".removed");

            await mkdir(removed, { recursive: true });
            await rename(
                before,
                join(removed, `${id}-${new Date().toISOString().replace(/[:.]/g, "-")}`),
            );
        }

        await rename(staged, join(dir, id));
    } catch (error) {
        await rm(staged, { recursive: true, force: true });

        throw error;
    }
}

/**
 * At the start: a version the server stopped in the middle of putting in place. One that is whole (it has its
 * provenance) goes in place when its theme's folder is not there (the version before is in `themes/.removed/`); any
 * other goes. Answers the themes it put in place.
 */
export async function recoverThemes(dir: string): Promise<string[]> {
    const names = await readdir(dir).catch(() => [] as string[]);
    const placed: string[] = [];

    for (const name of names) {
        const id = STAGED.exec(name)?.[1];
        const staged = join(dir, name);

        if (id === undefined || !(await lstat(staged).catch(() => undefined))?.isDirectory()) {
            continue;
        }

        if ((await exists(join(staged, THEME_SIDECAR))) && !(await exists(join(dir, id)))) {
            await rename(staged, join(dir, id));
            placed.push(id);
        } else {
            await rm(staged, { recursive: true, force: true });
        }
    }

    return placed;
}
