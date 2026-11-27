/**
 * Pi's loaders take paths (`loadSkills`, `loadSkillsFromDir`, `loadProjectContextFiles`, prompt templates) and read
 * them themselves, so they cannot be told to stay inside a folder that a sandboxed session writes. Pocket does not
 * reimplement them. For a sandboxed folder it reads the candidate files through the confined walk (`hostfs.ts`:
 * regular files only, with caps on their size and number; a pipe or `/dev/zero` is never opened) into a private copy
 * under `<data>/snapshots/`, runs Pi's own loader on the copy, and maps the copy's root back to the folder's path in
 * what the loader returns, as the guest mounts the folder at the same place. A folder that no sandboxed session uses
 * is loaded in place, as always.
 *
 * The copy mirrors each path under its own root, so a loader that walks up from a folder (`AGENTS.md`) finds the same
 * names. Its answers about places above the copy's root (the data folder's, and `/`'s) are not the project's:
 * `View.from` leaves them to the caller, who keeps the ones it asked for.
 */
import { dirname, join, resolve, sep } from "node:path";
import { loadProjectContextFiles } from "@earendil-works/pi-coding-agent";
import {
    type Hostfs,
    makeTemporaryFolder,
    mkdir,
    own,
    readdir,
    readFile,
    rm,
    writeFile,
    lstat,
} from "./hostfs.ts";

/** The most that one candidate file holds, and how many files and folders a copy has, and how deep it goes. */
export const MAX_FILE_BYTES = 1024 * 1024;
export const MAX_COPIED = 2000;
export const MAX_DEPTH = 12;

export type SnapshotView = {
    /** Whether the loader runs on a copy: a sandboxed folder is in the paths. */
    readonly copied: boolean;
    /** The copy's root folder; empty when nothing is copied. */
    readonly root: string;
    /** Where a real path is in the copy (the same path when nothing is copied). */
    to(path: string): string;
    /** What a loader's answer says, with the copy's root taken off every path: undefined parts stay as they are. */
    from<T>(value: T): T;
};

const IN_PLACE: SnapshotView = {
    copied: false,
    root: "",
    to: (path) => path,
    from: (value) => value,
};

function copyTree(host: Hostfs, from: string, to: string, budget: { left: number }): void {
    let depth = 0;

    const walk = (source: string, target: string): void => {
        if (budget.left <= 0 || depth > MAX_DEPTH) {
            return;
        }

        let info;

        try {
            info = lstat(host.at(source));
        } catch {
            return;
        }

        // A link, a pipe, a device, or a socket is not copied: a loader finds nothing there.
        if (info.isFile()) {
            budget.left--;

            if (info.size <= MAX_FILE_BYTES) {
                try {
                    mkdir(own(join(target, "..")), { recursive: true });
                    writeFile(own(target), readFile(host.at(source), { max: MAX_FILE_BYTES }), {
                        mode: 0o600,
                    });
                } catch {
                    // Unreadable: it is as if it were not there.
                }
            }

            return;
        }

        if (!info.isDirectory()) {
            return;
        }

        budget.left--;
        mkdir(own(target), { recursive: true });

        let names: string[];

        try {
            names = readdir(host.at(source));
        } catch {
            return;
        }

        depth++;

        for (const name of names.sort()) {
            walk(join(source, name), join(target, name));
        }

        depth--;
    };

    walk(from, to);
}

/** Replace the copy's root in every string of `value`. */
function unroot<T>(value: T, root: string): T {
    const prefix = root + sep;

    if (typeof value === "string") {
        return (
            value === root ? "/" : value.startsWith(prefix) ? value.slice(root.length) : value
        ) as T;
    }

    if (Array.isArray(value)) {
        return value.map((each) => unroot(each, root)) as T;
    }

    if (value !== null && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value).map(([key, each]) => [key, unroot(each, root)]),
        ) as T;
    }

    return value;
}

/** The file names Pi looks for in each folder from `cwd` up (`loadContextFileFromDir`). */
const CONTEXT_NAMES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];

/** A store of copies, under one folder (`<data>/snapshots/`). */
export class Snapshots {
    readonly #host: Hostfs;
    readonly #dir: string;

    constructor(host: Hostfs, dir: string) {
        this.#host = host;
        this.#dir = resolve(dir);
    }

    /** Whether any of `paths` is in, or leads through, a folder that a sandboxed session works in. */
    sandboxed(paths: readonly string[]): boolean {
        return paths.some((path) => {
            try {
                return this.#host.at(path).sandboxed || this.#host.confines(resolve(path));
            } catch {
                // A link into a sandboxed folder: refused, so it is read from the copy, where there are no links.
                return true;
            }
        });
    }

    /**
     * Pi's `loadProjectContextFiles` (`AGENTS.md` and `CLAUDE.md` in `cwd` and each folder above, and Pi's own folder).
     * For a sandboxed folder the candidates in every folder on the way up are read through the confined walk into a
     * copy, and Pi's loader runs on it. What it finds above the copy's root is not the project's and is dropped, except
     * Pi's own folder's file.
     */
    contextFiles(cwd: string, agentDir: string): { path: string; content: string }[] {
        const start = resolve(cwd);
        const candidates: string[] = [];

        for (let dir = start; ; dir = dirname(dir)) {
            candidates.push(...CONTEXT_NAMES.map((name) => join(dir, name)));

            if (dirname(dir) === dir) {
                break;
            }
        }

        return this.run(candidates, (view) => {
            if (!view.copied) {
                return loadProjectContextFiles({ cwd, agentDir });
            }

            const own = resolve(agentDir);

            // Before the root is taken off: the copy's own folders, and Pi's folder. The folders above the copy are not
            // the project's.
            return view.from(
                loadProjectContextFiles({ cwd: view.to(start), agentDir }).filter(
                    (file) => file.path.startsWith(view.root + sep) || dirname(file.path) === own,
                ),
            );
        });
    }

    /**
     * Run `load` where it sees what it would read at `paths` (files or folders, as absolute names): at the paths
     * themselves when no sandboxed folder is among them, else on a private copy that is gone when `load` returns.
     */
    run<T>(paths: readonly string[], load: (view: SnapshotView) => T): T {
        if (!this.sandboxed(paths)) {
            return load(IN_PLACE);
        }

        mkdir(own(this.#dir), { recursive: true });

        const root = makeTemporaryFolder(join(this.#dir, "snapshot-"));
        const budget = { left: MAX_COPIED };

        try {
            for (const path of paths) {
                copyTree(this.#host, resolve(path), join(root, resolve(path)), budget);
            }

            return load({
                copied: true,
                root,
                to: (path) => join(root, resolve(path)),
                from: (value) => unroot(value, root),
            });
        } finally {
            rm(own(root), { recursive: true, force: true });
        }
    }
}
