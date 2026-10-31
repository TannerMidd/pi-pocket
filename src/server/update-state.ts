/**
 * Update state in `.pocket-update/` in a checkout, or `.pi-pocket-update/` beside an npm package: the update under way
 * (`pending.json`), how the last one ended (`last.json`), the packages it installs (`staging/`), and the ones it
 * replaced (`previous/`). The server writes them (`updates.ts`); the launcher reads them when a server it started after
 * an update stops before it is ready, and goes back to the version before (`rollBackUpdate`). It imports only Node's
 * own modules and runs no server code, so the launcher can import it: keep it so.
 */
import { spawnSync } from "node:child_process";
import {
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    renameSync,
    rmdirSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

/** The folder in the checkout, which `.gitignore` leaves out. */
export const UPDATE_DIR = ".pocket-update";

/** An update under way, written before staging or changing the live package or checkout. */
export type PendingUpdate = {
    v: 1;
    /** Omitted by older git update records. */
    kind?: "npm-global";
    tag: string;
    fromVersion: string;
    toVersion: string;
    /** The commit before, and the release's. Empty strings for npm updates. */
    from: string;
    to: string;
    /** The branch the update moves, or null for a detached checkout. */
    branch: string | null;
    /** New dependencies (git) or the whole new package (npm) went in. */
    modules: boolean;
    /** The release notes warn of a step that cannot be undone: the launcher does not go back by itself. */
    oneWay: boolean;
    /** "switching" before git can change files, or before the npm package's first rename. */
    phase: "packages" | "switching";
    at: number;
};

/** How the last update ended, for the owner to read after the restart. */
export type UpdateOutcome = {
    v: 1;
    /** Each outcome's own: the app tells each one once. */
    id: string;
    ok: boolean;
    tag: string;
    fromVersion: string;
    toVersion: string;
    message: string;
    at: number;
};

export function updatePaths(appRoot: string) {
    appRoot = resolve(appRoot);
    const parent = dirname(appRoot);
    const npmPackage =
        basename(parent) === "node_modules" ||
        (basename(parent).startsWith("@") && basename(dirname(parent)) === "node_modules");
    const sibling = join(parent, ".pi-pocket-update");
    // A global root can resolve through a symlink to a folder not named node_modules. The writer
    // marks that exact package root; the launcher needs neither npm nor the live package to find it.
    const markedGlobal = readJson(join(sibling, "npm-global.json"))?.appRoot === appRoot;
    // npm ignores dot-prefixed siblings. State must survive replacement or removal of the package.
    const dir = npmPackage || markedGlobal ? sibling : join(appRoot, UPDATE_DIR);

    return {
        dir,
        pending: join(dir, "pending.json"),
        last: join(dir, "last.json"),
        staging: join(dir, "staging"),
        previous: join(dir, "previous"),
        failed: join(dir, "failed"),
    };
}

const COMMIT = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

function readJson(path: string): Record<string, unknown> | undefined {
    try {
        const value: unknown = JSON.parse(readFileSync(path, "utf8"));

        return typeof value === "object" && value !== null && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : undefined;
    } catch {
        return undefined;
    }
}

/** Written in full or not at all: a stop in the middle leaves the file before. */
function writeJson(path: string, value: unknown): void {
    mkdirSync(join(path, ".."), { recursive: true });
    const temp = `${path}.${process.pid}.tmp`;

    writeFileSync(temp, `${JSON.stringify(value, null, 4)}\n`, { mode: 0o600 });
    renameSync(temp, path);
}

const text = (value: unknown) => (typeof value === "string" ? value : undefined);

/** The update under way, or undefined. A file that is not one (cut short, or by hand) counts as none. */
export function readPending(appRoot: string): PendingUpdate | undefined {
    const raw = readJson(updatePaths(appRoot).pending);
    const from = text(raw?.from);
    const to = text(raw?.to);

    if (raw?.v !== 1 || from === undefined || to === undefined) {
        return undefined;
    }

    if (raw.kind === "npm-global") {
        if (!text(raw.fromVersion) || !text(raw.toVersion)) {
            return undefined;
        }
    } else if (raw.kind !== undefined || !COMMIT.test(from) || !COMMIT.test(to)) {
        return undefined;
    }

    return {
        v: 1,
        ...(raw.kind === "npm-global" ? { kind: "npm-global" as const } : {}),
        tag: text(raw.tag) ?? "",
        fromVersion: text(raw.fromVersion) ?? "",
        toVersion: text(raw.toVersion) ?? "",
        from,
        to,
        branch: text(raw.branch) ?? null,
        modules: raw.modules === true,
        oneWay: raw.oneWay === true,
        // A file without a phase may have got as far as git.
        phase: raw.phase === "packages" ? "packages" : "switching",
        at: typeof raw.at === "number" ? raw.at : 0,
    };
}

export function writePending(appRoot: string, pending: PendingUpdate): void {
    if (pending.kind === "npm-global") {
        const root = resolve(appRoot);
        const marker = join(dirname(root), ".pi-pocket-update", "npm-global.json");

        writeJson(marker, { v: 1, appRoot: root });
    }

    writeJson(updatePaths(appRoot).pending, pending);
}

export function clearPending(appRoot: string): void {
    rmSync(updatePaths(appRoot).pending, { force: true });
}

export function readOutcome(appRoot: string): UpdateOutcome | undefined {
    const raw = readJson(updatePaths(appRoot).last);

    if (raw?.v !== 1 || typeof raw.ok !== "boolean" || text(raw.message) === undefined) {
        return undefined;
    }

    return {
        v: 1,
        id: text(raw.id) ?? "",
        ok: raw.ok,
        tag: text(raw.tag) ?? "",
        fromVersion: text(raw.fromVersion) ?? "",
        toVersion: text(raw.toVersion) ?? "",
        message: text(raw.message) ?? "",
        at: typeof raw.at === "number" ? raw.at : 0,
    };
}

/** Note how an update ended that never got as far as a pending update (its packages did not install, say). */
export function recordOutcome(
    appRoot: string,
    fields: { tag: string; fromVersion: string; toVersion: string },
    message: string,
    now = Date.now(),
): UpdateOutcome {
    const outcome: UpdateOutcome = {
        v: 1,
        id: `${now}-${fields.tag}-failed`,
        ok: false,
        ...fields,
        message,
        at: now,
    };

    writeJson(updatePaths(appRoot).last, outcome);

    return outcome;
}

/** End the update under way with `message`: the outcome is written first, then the pending update goes. */
export function finishPending(
    appRoot: string,
    pending: PendingUpdate,
    ok: boolean,
    message: string,
    now = Date.now(),
): UpdateOutcome {
    const outcome: UpdateOutcome = {
        v: 1,
        id: `${pending.at}-${pending.to.slice(0, 12)}-${ok ? "ok" : "back"}`,
        ok,
        tag: pending.tag,
        fromVersion: pending.fromVersion,
        toVersion: pending.toVersion,
        message,
        at: now,
    };

    writeJson(updatePaths(appRoot).last, outcome);
    clearPending(appRoot);

    return outcome;
}

/**
 * Put the packages an update installed in place of the checkout's (`staging/node_modules`), keeping the ones before in
 * `previous/`. Each step is a rename in the checkout's own file system, so it takes a moment. Throws, with the packages
 * before back in place, when it cannot.
 */
export function swapInModules(appRoot: string): void {
    const paths = updatePaths(appRoot);
    const fresh = join(paths.staging, "node_modules");
    const current = join(appRoot, "node_modules");
    const kept = join(paths.previous, "node_modules");

    // A lock file with no packages in it installs none: an empty folder takes their place.
    mkdirSync(fresh, { recursive: true });
    rmSync(paths.previous, { recursive: true, force: true });
    mkdirSync(paths.previous, { recursive: true });

    if (existsSync(current)) {
        renameSync(current, kept);
    }

    try {
        renameSync(fresh, current);
    } catch (error) {
        if (existsSync(kept)) {
            renameSync(kept, current);
        }

        throw error;
    }

    rmSync(paths.staging, { recursive: true, force: true });
}

/** Put back the packages from before an update. False when there are none to put back. */
export function restoreModules(appRoot: string): boolean {
    const paths = updatePaths(appRoot);
    const kept = join(paths.previous, "node_modules");
    const current = join(appRoot, "node_modules");

    if (!existsSync(kept)) {
        return false;
    }

    rmSync(paths.failed, { recursive: true, force: true });

    if (existsSync(current)) {
        mkdirSync(paths.failed, { recursive: true });
        renameSync(current, join(paths.failed, "node_modules"));
    }

    renameSync(kept, current);
    rmSync(paths.failed, { recursive: true, force: true });
    rmSync(paths.previous, { recursive: true, force: true });

    return true;
}

/** The package npm installs with an isolated global prefix. Its dependencies stay inside it. */
export function stagedPackagePath(appRoot: string): string {
    const { staging } = updatePaths(appRoot);

    return process.platform === "win32"
        ? join(staging, "node_modules", "pi-pocket")
        : join(staging, "lib", "node_modules", "pi-pocket");
}

/** Read without importing package code: the launcher can use this after a package rename. */
function packageVersion(root: string): string | undefined {
    const manifest = readJson(join(root, "package.json"));

    return manifest?.name === "pi-pocket" ? text(manifest.version) : undefined;
}

function npmPending(appRoot: string): PendingUpdate {
    const pending = readPending(appRoot);

    if (pending?.kind !== "npm-global") {
        throw new Error("No npm global update is pending.");
    }

    return pending;
}

/** Swap whole packages on the same file system. The global bin link keeps its original target. */
export function swapInPackage(appRoot: string): void {
    const pending = npmPending(appRoot);
    const paths = updatePaths(appRoot);
    const fresh = stagedPackagePath(appRoot);

    if (packageVersion(fresh) !== pending.toVersion) {
        throw new Error("The staged package does not match the pending version.");
    }

    if (
        pending.phase !== "packages" ||
        pending.modules ||
        packageVersion(appRoot) !== pending.fromVersion
    ) {
        throw new Error("The live package changed, or this package swap already started.");
    }

    // A previous one-way update can leave its old package for manual recovery. Keep it without
    // blocking a later update or deleting a package that the owner may still need.
    for (const name of ["previous", "failed"] as const) {
        if (existsSync(paths[name])) {
            const kept = join(paths.dir, "kept");

            mkdirSync(kept, { recursive: true });
            const folder = mkdtempSync(join(kept, `npm-${name}-`));

            renameSync(paths[name], join(folder, "package"));
        }
    }

    writePending(appRoot, { ...pending, phase: "switching" });

    // Keep these renames synchronous and adjacent: only a whole-process stop can interrupt them.
    try {
        renameSync(appRoot, paths.previous);
        renameSync(fresh, appRoot);
    } catch (error) {
        if (!existsSync(appRoot) && existsSync(paths.previous)) {
            renameSync(paths.previous, appRoot);
        }

        throw error;
    }

    writePending(appRoot, { ...pending, phase: "switching", modules: true });
}

/** Repair a missing live package before the launcher spawns a server or the server loads its app modules. */
export function restoreMissingNpmPackage(appRoot: string): boolean {
    const pending = readPending(appRoot);

    if (pending?.kind !== "npm-global" || existsSync(appRoot)) {
        return false;
    }

    const paths = updatePaths(appRoot);
    const fresh = stagedPackagePath(appRoot);
    const previous = packageVersion(paths.previous);
    const failed = packageVersion(paths.failed);

    if (existsSync(paths.previous) && previous !== pending.fromVersion) {
        throw new Error("The previous npm package changed; it was kept for manual recovery.");
    }

    // Do not restore an older version after a warning release may have changed the data.
    const keepNew = pending.oneWay && (pending.modules || failed === pending.toVersion);
    const source =
        !keepNew && previous === pending.fromVersion
            ? paths.previous
            : keepNew && failed === pending.toVersion
              ? paths.failed
              : packageVersion(fresh) === pending.toVersion
                ? fresh
                : undefined;

    if (source === undefined) {
        throw new Error("The live npm package is missing, with no safe copy to restore.");
    }

    if (source !== paths.previous) {
        writePending(appRoot, { ...pending, phase: "switching", modules: true });
    }

    renameSync(source, appRoot);

    return true;
}

/** Restore a whole npm package, including its dependencies, without invoking npm or a network. */
export function restorePackage(appRoot: string): boolean {
    const pending = npmPending(appRoot);
    const paths = updatePaths(appRoot);

    // Staging can fail before a swap starts. An older one-way update may have left an unrelated
    // previous package: the live version is already right, so leave both packages untouched.
    // This also handles a stop after the final restore rename.
    if (packageVersion(appRoot) === pending.fromVersion) {
        return true;
    }

    if (!existsSync(paths.previous)) {
        return false;
    }

    if (packageVersion(paths.previous) !== pending.fromVersion) {
        throw new Error("The previous package does not match the pending version; it was kept.");
    }

    if (existsSync(appRoot)) {
        if (packageVersion(appRoot) !== pending.toVersion || existsSync(paths.failed)) {
            throw new Error("The live package changed during recovery; no package was removed.");
        }

        renameSync(appRoot, paths.failed);
    }

    renameSync(paths.previous, appRoot);

    return true;
}

/** Startup completed: record success, or recover an update that stopped before the swap completed. */
export function finishNpmPending(
    appRoot: string,
    pending: PendingUpdate,
    now = Date.now(),
): UpdateOutcome {
    if (pending.kind !== "npm-global") {
        throw new Error("This is not an npm global update.");
    }

    const current = packageVersion(appRoot);

    // A manual npm reinstall can finish before a staged update switches packages. Keep any
    // unrelated backup, and clear that stale record without replacing the running package.
    if (
        current !== undefined &&
        current !== pending.fromVersion &&
        (current !== pending.toVersion || pending.phase === "packages")
    ) {
        return finishPending(
            appRoot,
            pending,
            false,
            `The npm package changed during the update to ${pending.toVersion}. Pi Pocket started at ${current}, so no package was replaced during recovery.`,
            now,
        );
    }

    if (pending.phase === "switching" && current === pending.toVersion) {
        return finishPending(
            appRoot,
            pending,
            true,
            `Pi Pocket updated from ${pending.fromVersion} to ${pending.toVersion}.`,
            now,
        );
    }

    return rollBackNpm(appRoot, pending, now);
}

function rollBackNpm(appRoot: string, pending: PendingUpdate, now: number): UpdateOutcome {
    const to = pending.toVersion;
    const from = pending.fromVersion;
    const paths = updatePaths(appRoot);
    // A previous package plus a live release (or one set aside during recovery) means it may have run.
    const mayHaveRun =
        packageVersion(appRoot) === to || packageVersion(paths.failed) === to || pending.modules;

    if (pending.oneWay && mayHaveRun) {
        return finishPending(
            appRoot,
            pending,
            false,
            `${to} did not start. Its release notes warn of a step that cannot be undone, so Pi Pocket did not go back to ${from} by itself: read the release notes, and the server's log.`,
            now,
        );
    }

    if (!restorePackage(appRoot)) {
        throw new Error("The previous npm package is missing. The pending update was kept.");
    }

    return finishPending(
        appRoot,
        pending,
        false,
        `The update to ${to} did not finish, so Pi Pocket went back to ${from}. The server's log says why.`,
        now,
    );
}

/** The checkout's branch, null when detached, undefined when git cannot say. */
function branchOf(appRoot: string): string | null | undefined {
    const head = gitSync(appRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]);

    if (head.ok) {
        return head.out;
    }

    return gitSync(appRoot, ["rev-parse", "HEAD"]).ok ? null : undefined;
}

/**
 * The paths a move from `from` to `to` changes: the ones it adds, and the others (changed or deleted). `links` are the
 * submodules among them: only their index entry changes, never their folder.
 */
export function switchPaths(
    appRoot: string,
    from: string,
    to: string,
): { added: string[]; other: string[]; links: Set<string> } {
    const diff = gitSync(appRoot, ["diff", "--raw", "--no-renames", "--no-abbrev", "-z", from, to]);

    if (!diff.ok) {
        throw new Error(diff.out);
    }

    // ":<mode> <mode> <hash> <hash> <status>", then the path.
    const parts = diff.out.split("\0").filter((each) => each !== "");
    const added: string[] = [];
    const other: string[] = [];
    const links = new Set<string>();

    for (let at = 0; at + 1 < parts.length; at += 2) {
        const [before, after, , , status] = parts[at]!.replace(/^:/, "").split(" ");
        const path = parts[at + 1]!;

        (status === "A" ? added : other).push(path);

        if (before === "160000" || after === "160000") {
            links.add(path);
        }
    }

    return { added, other, links };
}

/** Each file of a commit, by path: its blob. */
function blobs(appRoot: string, commit: string): Map<string, string> {
    const tree = gitSync(appRoot, ["ls-tree", "-r", "--full-tree", "-z", commit]);

    if (!tree.ok) {
        throw new Error(tree.out);
    }

    const found = new Map<string, string>();

    for (const entry of tree.out.split("\0")) {
        // "<mode> blob <hash>\t<path>"
        const match = /^\d+ blob ([0-9a-f]+)\t([\s\S]+)$/.exec(entry);

        if (match !== null) {
            found.set(match[2]!, match[1]!);
        }
    }

    return found;
}

/** What git prints, as bytes. */
function gitBytes(cwd: string, args: string[]): Buffer | undefined {
    const result = spawnSync("git", ["-c", "core.fsmonitor=false", ...args], {
        cwd,
        timeout: 60_000,
        maxBuffer: 512 * 1024 * 1024,
        env: { ...process.env, LC_ALL: "C" },
    });

    return result.status === 0 ? result.stdout : undefined;
}

/**
 * The file at `file` (moved aside from `path`) is git's own: its bytes are the very bytes one of `commits` has at
 * `path`, as stored, or as git writes them in this checkout (line endings, a smudge filter). Anything else, even one
 * that a clean filter would make look the same, is not.
 */
function gitsOwn(appRoot: string, file: string, path: string, commits: string[]): boolean {
    let bytes: Buffer;

    try {
        if (!lstatSync(file).isFile()) {
            return false;
        }

        bytes = readFileSync(file);
    } catch {
        return false;
    }

    for (const commit of commits) {
        for (const args of [
            ["cat-file", "blob", `${commit}:${path}`],
            ["cat-file", "--filters", `${commit}:${path}`],
        ]) {
            const written = gitBytes(appRoot, args);

            if (written !== undefined && written.equals(bytes)) {
                return true;
            }
        }
    }

    return false;
}

/** Remove the folders that `path` leaves empty, up to the checkout. */
function removeEmptyParents(appRoot: string, path: string): void {
    for (let folder = dirname(path); folder !== "." && folder !== ""; folder = dirname(folder)) {
        try {
            rmdirSync(join(appRoot, folder));
        } catch {
            return;
        }
    }
}

/** What `undoPartialSwitch` moved aside, and where: a folder of its own for each try. */
export type Kept = { paths: string[]; folder?: string };

/**
 * Git stopped part way from `from` to `to` (the server stopped while it moved the checkout): HEAD is still `from`, but
 * some files may be the release's. Only the paths the move changes are looked at. Each one there is first moved, as it
 * is, into a new folder of its own in `.pocket-update/kept/`, and looked at only there, where an edit meanwhile cannot
 * slip past the look. A regular file with the release's version, or `from`'s, goes: git puts `from`'s back. Anything
 * else (other content, a folder, a link) is someone's own, and stays kept; the answer names it. Then the paths the
 * release changes or deletes come back from `from`, and the ones it adds leave the index. Throws when git cannot.
 */
export function undoPartialSwitch(appRoot: string, pending: PendingUpdate): Kept {
    const { added, other, links } = switchPaths(appRoot, pending.from, pending.to);
    const parent = join(updatePaths(appRoot).dir, "kept");

    mkdirSync(parent, { recursive: true });
    // A new folder each try: a second try never writes over what a first one kept.
    const folder = mkdtempSync(join(parent, `${pending.at}-`));
    const moved: string[] = [];

    // The release's new files first: a folder the version before has a file in place of may need their room. And a
    // path before the paths under it: a folder the release made of a file goes aside whole, with what is in it, rather
    // than after its files, onto the folder that they made in the place it would take.
    const depth = (path: string) => path.split("/").length;
    const order = [...added, ...other].sort((one, two) => depth(one) - depth(two));

    for (const path of order) {
        // A submodule's folder is its own checkout: only its index entry goes back.
        if (links.has(path)) {
            continue;
        }

        try {
            lstatSync(join(appRoot, path));
        } catch {
            continue;
        }

        const aside = join(folder, path);

        mkdirSync(dirname(aside), { recursive: true });
        renameSync(join(appRoot, path), aside);
        moved.push(path);

        if (added.includes(path)) {
            removeEmptyParents(appRoot, path);
        }
    }

    // Looked at where nobody edits: what git wrote, or what was there before, goes; the rest is kept.
    const kept: Kept = { paths: [], folder };

    for (const path of moved) {
        if (gitsOwn(appRoot, join(folder, path), path, [pending.to, pending.from])) {
            rmSync(join(folder, path), { force: true });
            removeEmptyParents(folder, path);
        } else {
            kept.paths.push(path);
        }
    }

    if (kept.paths.length === 0) {
        rmSync(folder, { recursive: true, force: true });
        delete kept.folder;
    }

    if (added.length > 0) {
        const unstaged = gitSync(
            appRoot,
            [
                "rm",
                "--quiet",
                "--cached",
                "--ignore-unmatch",
                "--pathspec-from-file=-",
                "--pathspec-file-nul",
            ],
            `${added.join("\0")}\0`,
        );

        if (!unstaged.ok) {
            throw new Error(unstaged.out);
        }
    }

    if (other.length > 0) {
        // The files and the index of every path the release changes or deletes, as `from` has them.
        const back = gitSync(
            appRoot,
            ["checkout", "--quiet", pending.from, "--pathspec-from-file=-", "--pathspec-file-nul"],
            `${other.join("\0")}\0`,
        );

        if (!back.ok) {
            throw new Error(back.out);
        }
    }

    return kept;
}

/**
 * Before the checkout goes back from `to` to `from`: what is at a path that only `from` tracks is someone's, since `to`
 * has nothing there. It moves, as it is, into a new folder of its own in `.pocket-update/kept/`; a regular file with
 * the very bytes `from` has goes, since git writes the same.
 */
export function setAsideForRollback(appRoot: string, pending: PendingUpdate): Kept {
    const before = blobs(appRoot, pending.from);
    const after = blobs(appRoot, pending.to);
    const only = [...before.keys()].filter((path) => !after.has(path));
    const kept: Kept = { paths: [] };

    for (const path of only) {
        let file: boolean;

        try {
            file = lstatSync(join(appRoot, path)).isFile();
        } catch {
            continue;
        }

        if (kept.folder === undefined) {
            const parent = join(updatePaths(appRoot).dir, "kept");

            mkdirSync(parent, { recursive: true });
            kept.folder = mkdtempSync(join(parent, `${pending.at}-`));
        }

        const aside = join(kept.folder, path);

        mkdirSync(dirname(aside), { recursive: true });
        renameSync(join(appRoot, path), aside);

        if (file && gitsOwn(appRoot, aside, path, [pending.from])) {
            rmSync(aside, { force: true });
            removeEmptyParents(kept.folder, path);
        } else {
            kept.paths.push(path);
        }
    }

    if (kept.folder !== undefined && kept.paths.length === 0) {
        rmSync(kept.folder, { recursive: true, force: true });
        delete kept.folder;
    }

    return kept;
}

/** The words for what `undoPartialSwitch` kept, to add to an outcome. */
export function keptNote(appRoot: string, kept: Kept): string {
    if (kept.folder === undefined || kept.paths.length === 0) {
        return "";
    }

    const where = relative(appRoot, kept.folder);
    const names = `${kept.paths.slice(0, 3).join(", ")}${kept.paths.length > 3 ? ", …" : ""}`;

    return ` What was in its place meanwhile (${names}) is kept in ${where}.`;
}

function gitSync(cwd: string, args: string[], input?: string): { ok: boolean; out: string } {
    const result = spawnSync("git", ["-c", "core.fsmonitor=false", ...args], {
        cwd,
        ...(input === undefined ? {} : { input }),
        encoding: "utf8",
        timeout: 60_000,
        env: { ...process.env, LC_ALL: "C", GIT_LITERAL_PATHSPECS: "1" },
    });

    return {
        ok: result.status === 0,
        out: (result.status === 0 ? result.stdout : result.stderr || String(result.error ?? ""))
            .toString()
            .trim(),
    };
}

/**
 * For the launcher: a server that stopped this way, with an update under way, means the new version does not start. A
 * restart it asked for (75) and a port or address it cannot listen on (78) do not: neither is the version's fault.
 */
export function stopMeansRollBack(ready: boolean, code: number | null): boolean {
    return !ready && code !== 75 && code !== 78;
}

/**
 * For the launcher: a server it started after an update stopped before it was ready. Put the checkout and its packages
 * back as they were before the update, and say what was done; undefined when no update is under way. A release whose
 * notes warn of a one-way step (a database upgrade, say) is not undone: the version before may not read what the new
 * one changed. Synchronous: it runs between two starts of the server, with nothing else to do.
 */
export function rollBackUpdate(appRoot: string, now = Date.now()): string | undefined {
    const pending = readPending(appRoot);

    if (pending === undefined) {
        return undefined;
    }

    // npm recovery must retain the pending record if a rename fails. The next start can retry it.
    if (pending.kind === "npm-global") {
        return rollBackNpm(appRoot, pending, now).message;
    }

    try {
        return rollBack(appRoot, pending, now);
    } catch (error) {
        // Never again on the next start: a lock git left, say, would fail each time, and the server never start.
        return finishPending(
            appRoot,
            pending,
            false,
            `Going back from the update to ${pending.toVersion || pending.tag} failed: ${(error as Error).message}. Fix the checkout by hand (\`git status\` in it), then restart Pi Pocket.`,
            now,
        ).message;
    }
}

/**
 * The update stopped before git moved HEAD (between the new packages and the checkout, or while git wrote files): the
 * files the release brought and its packages go back. One that cannot (a lock git left, say) is noted for the owner to
 * fix by hand, never tried at each start.
 */
export function finishPartial(
    appRoot: string,
    pending: PendingUpdate,
    now = Date.now(),
): UpdateOutcome {
    const to = pending.toVersion || pending.tag;
    const from = pending.fromVersion || pending.from.slice(0, 12);

    try {
        const kept: Kept =
            pending.phase === "switching" ? undoPartialSwitch(appRoot, pending) : { paths: [] };

        if (pending.modules) {
            restoreModules(appRoot);
        }

        return finishPending(
            appRoot,
            pending,
            false,
            `The update to ${to} did not finish, so Pi Pocket stays at ${from}.${keptNote(appRoot, kept)}`,
            now,
        );
    } catch (error) {
        return finishPending(
            appRoot,
            pending,
            false,
            `The update to ${to} did not finish, and putting the files of ${from} back failed: ${(error as Error).message}. Fix the checkout by hand (\`git status\` in it, and \`npm ci\`), then restart Pi Pocket. Anything set aside is in ${UPDATE_DIR}/kept/.`,
            now,
        );
    }
}

function rollBack(appRoot: string, pending: PendingUpdate, now: number): string {
    const head = gitSync(appRoot, ["rev-parse", "HEAD"]);
    const to = pending.toVersion || pending.tag;
    const from = pending.fromVersion || pending.from.slice(0, 12);

    if (!head.ok) {
        return finishPending(
            appRoot,
            pending,
            false,
            `Could not read the checkout: ${head.out}`,
            now,
        ).message;
    }

    // Someone switched branches meanwhile: going back would move a branch the update never moved.
    if (branchOf(appRoot) !== pending.branch) {
        return finishPending(
            appRoot,
            pending,
            false,
            `${to} did not start, and the checkout is no longer on ${pending.branch ?? "the commit the update left"}, so Pi Pocket did not go back to ${from} by itself.`,
            now,
        ).message;
    }

    if (head.out === pending.to) {
        if (pending.oneWay) {
            return finishPending(
                appRoot,
                pending,
                false,
                `${to} did not start. Its release notes warn of a step that cannot be undone, so Pi Pocket did not go back to ${from} by itself: read the release notes, and the server's log.`,
                now,
            ).message;
        }

        // Files only the version before tracks, that someone put there since (ignored ones too): git would write over
        // them, so they go aside first.
        const kept = setAsideForRollback(appRoot, pending);
        const back = gitSync(
            appRoot,
            pending.branch === null
                ? ["checkout", "--quiet", "--detach", pending.from]
                : ["reset", "--quiet", "--keep", pending.from],
        );

        if (!back.ok) {
            return finishPending(
                appRoot,
                pending,
                false,
                `${to} did not start, and going back to ${from} failed: ${back.out}${keptNote(appRoot, kept)}`,
                now,
            ).message;
        }

        if (pending.modules) {
            restoreModules(appRoot);
        }

        return finishPending(
            appRoot,
            pending,
            false,
            `${to} did not start, so Pi Pocket went back to ${from}. The server's log says why.${keptNote(appRoot, kept)}`,
            now,
        ).message;
    }

    if (head.out === pending.from) {
        return finishPartial(appRoot, pending, now).message;
    }

    return finishPending(
        appRoot,
        pending,
        false,
        `The checkout changed during the update to ${to}, so nothing was undone.`,
        now,
    ).message;
}
