/**
 * Pi Pocket's folders: which parts of its state live where, per the XDG base directory spec. The launcher and the
 * server both work them out here, so they always agree, and an older `~/.pi-pocket` moves into them once.
 */
import {
    chmodSync,
    cpSync,
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    renameSync,
    rmSync,
    rmdirSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { lockHolder } from "./lock.ts";

/** Pi Pocket's folders: which parts of its state live where, per the XDG base directory spec. */
export interface Folders {
    config: string;
    data: string;
    state: string;
    cache: string;
}

/** What each kind of folder holds, as an old `~/.pi-pocket` named it. */
const LEGACY_ENTRIES: Record<keyof Folders, readonly string[]> = {
    config: ["config.json", "launcher.json"],
    data: [
        "pocket.sqlite",
        "pocket.sqlite-wal",
        "pocket.sqlite-shm",
        "push.json",
        // Moved with the database it guards: a server still on the old layout is then refused, not doubled.
        "harness.lock",
        "uploads",
        "worktrees",
        "repos",
        "gallery",
        "themes",
        "extensions",
    ],
    state: ["cloudflared.log"],
    cache: ["bin", "browser"],
};

/** What the app stores more than once: uploads a message carries, and the folders sessions work in. */
const NAMED_BY_PATH = new Set(["uploads", "worktrees", "repos"]);

/** An XDG variable: an absolute value, else the default under the home folder (the spec ignores a relative one). */
function xdg(env: NodeJS.ProcessEnv, name: string, home: string, fallback: string): string {
    const value = env[name];

    return value !== undefined && value !== "" && isAbsolute(value) ? value : join(home, fallback);
}

/**
 * The four folders: `PI_POCKET_*_DIR`, else the XDG folder, else the XDG default under the home folder. An override
 * is a person's own choice, so a relative one counts, from the working folder.
 */
export function foldersFromEnv(
    env: NodeJS.ProcessEnv = process.env,
    home: string = homedir(),
): Folders {
    const pick = (name: string, base: string): string => {
        const value = env[name];

        return value !== undefined && value !== "" ? resolve(value) : join(base, "pi-pocket");
    };

    return {
        config: pick("PI_POCKET_CONFIG_DIR", xdg(env, "XDG_CONFIG_HOME", home, ".config")),
        data: pick("PI_POCKET_DATA_DIR", xdg(env, "XDG_DATA_HOME", home, join(".local", "share"))),
        state: pick(
            "PI_POCKET_STATE_DIR",
            xdg(env, "XDG_STATE_HOME", home, join(".local", "state")),
        ),
        cache: pick("PI_POCKET_CACHE_DIR", xdg(env, "XDG_CACHE_HOME", home, ".cache")),
    };
}

/** Create the four, 0700, as private as the old data folder was: tokens and keys live in them. */
export function ensureFolders(dirs: Folders): void {
    for (const folder of Object.values(dirs)) {
        mkdirSync(folder, { recursive: true, mode: 0o700 });
        // `mode` reaches only folders this made: one named with `PI_POCKET_*_DIR` may have come another way.
        chmodSync(folder, 0o700);
    }
}

/** `~` for the home folder, as the launcher's and the server's messages show paths. */
function tilde(folder: string, home: string): string {
    return folder === home || folder.startsWith(`${home}${sep}`)
        ? `~${folder.slice(home.length)}`
        : folder;
}

/**
 * Move one entry, across folders or filesystems: rename is atomic, and a copy (then remove) when it cannot. The copy
 * goes to a `.partial` name first, so a copy cut off midway is not mistaken for a finished one next time.
 */
function move(source: string, target: string): void {
    try {
        renameSync(source, target);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EXDEV") {
            throw error;
        }

        const partial = `${target}.partial`;

        try {
            cpSync(source, partial, { recursive: true, errorOnExist: true, force: false });
            renameSync(partial, target);
        } catch (failed) {
            rmSync(partial, { recursive: true, force: true });

            throw failed;
        }

        rmSync(source, { recursive: true, force: true });
    }
}

/** The process id in an old folder's lock, when that process is still Pi Pocket and still using the folder. */
function holder(legacy: string): number | undefined {
    const file = join(legacy, "harness.lock");

    if (!existsSync(file)) {
        return undefined;
    }

    const pid = Number(readFileSync(file, "utf8").trim());

    return lockHolder(pid) ? pid : undefined;
}

/**
 * Move an existing `~/.pi-pocket` into the four, for people who ran an older Pi Pocket. Entries are moved only where
 * the destination is absent, so a migration cut off mid-way finishes on the next start; anything unknown is left where
 * it is. A folder named with `PI_POCKET_*_DIR` that is the old one itself keeps what it has.
 */
export function migrateLegacy(
    dirs: Folders,
    log: (line: string) => void = () => {},
    home: string = homedir(),
): void {
    const legacy = join(home, ".pi-pocket");

    if (!existsSync(legacy)) {
        return;
    }

    const running = holder(legacy);

    if (running !== undefined) {
        // Its database is open and being written: moving it would give this process a torn copy to open.
        log(
            `Pi Pocket is still running on ${tilde(legacy, home)} (pid ${running}): stop it, then start again.`,
        );

        return;
    }

    let known = false;
    let moved = false;
    let movedNamed = false;

    for (const kind of ["config", "data", "state", "cache"] as const) {
        const folder = dirs[kind];

        // A folder named with PI_POCKET_*_DIR may be the old one itself: it keeps what is already in it.
        if (resolve(folder) === resolve(legacy)) {
            continue;
        }

        for (const entry of LEGACY_ENTRIES[kind]) {
            const source = join(legacy, entry);

            if (!existsSync(source)) {
                continue;
            }

            known = true;
            const target = join(folder, entry);

            if (existsSync(target)) {
                // Two databases are worse than one: say which one is left, rather than run on it in silence.
                if (entry.startsWith("pocket.sqlite")) {
                    log(
                        `Kept ${tilde(source, home)}: ${tilde(target, home)} is already there. Delete one of them.`,
                    );
                }

                continue;
            }

            mkdirSync(folder, { recursive: true, mode: 0o700 });
            move(source, target);
            moved = true;
            movedNamed ||= NAMED_BY_PATH.has(entry);
        }
    }

    if (!known) {
        return;
    }

    if (moved) {
        log(`Moved Pi Pocket's data from ${tilde(legacy, home)} to ${tilde(dirs.data, home)}.`);
    }

    if (movedNamed) {
        // What the app stored before the move: an older message's attachments, an isolated session's folder.
        log(
            `Files those conversations name by ${tilde(legacy, home)} are now in ${tilde(dirs.data, home)}.`,
        );
    }

    const left = readdirSync(legacy);

    if (left.length === 0) {
        rmdirSync(legacy);

        return;
    }

    log(`Left in ${tilde(legacy, home)}: ${left.join(", ")}`);
}
