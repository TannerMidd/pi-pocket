/**
 * What a session on another computer (`runners.ts`) learns of its folder there, read through that computer's
 * environment and never from this server's disk:
 *
 * - The project's context files: the first of `AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, `CLAUDE.MD`
 *   in the folder and each folder above it, as Pi reads them here. This server's own global file (in Pi's folder) comes
 *   first, as for a session here: it holds the person's own instructions.
 * - Pi's skills there: the project's `.pi/skills/`, its `.agents/skills/` folders up to the repository's root (only while
 *   the project is trusted), then `~/.pi/agent/skills/` and `~/.agents/skills/` of that computer.
 *
 * One scan finds all of it (`scanFolder`): on Linux and macOS one `sh` command that prints the files, as a slow link
 * (a laptop on Wi-Fi) pays for each round trip; elsewhere, or when that fails, folder listings side by side. A scan is
 * kept for 30 seconds per computer and folder, as the prompt keeps what it reads here. Trust decisions for folders there
 * are this server's (`remote-trust.json` in its data folder), by computer and path: they never mix with Pi's trust store,
 * whose paths are this server's.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join, posix, win32 } from "node:path";
import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import {
    createSyntheticSourceInfo,
    parseFrontmatter,
    type Skill,
} from "@earendil-works/pi-coding-agent";
import type { ExecutionEnv, FileError, FileInfo } from "@earendil-works/pi-durable/env";
import { isConnectionLost, type RemoteInfo } from "@earendil-works/pi-env";
import {
    decides,
    type ProjectTrust,
    type Saved,
    type SkillSources,
    type TrustChoice,
} from "./skills.ts";

/** An environment on another computer: a `RunnerEnv` (or the harness's wrapper of one). */
export type RemoteEnv = ExecutionEnv & { readonly connection: { info(): Promise<RemoteInfo> } };

export type PathKit = typeof posix;

/** The context file names Pi looks for in each folder, first found wins (Pi's `loadProjectContextFiles`). */
const CANDIDATES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];
const STALE_MS = 30_000;
/** The most bytes read of one context or skill file. */
const MAX_FILE = 256 * 1024;
/** The most text one scan may print. */
const MAX_OUTPUT = 8 * 1024 * 1024;
const SCAN_TIMEOUT_S = 20;
/** How deep a skill folder is searched, as links may loop. */
const MAX_DEPTH = 8;
const context = BACKGROUND_CONTEXT;

/** What a scan found of a folder on another computer. */
export type FolderScan = {
    /** When it was read. */
    at: number;
    /** That computer's path rules. */
    paths: PathKit;
    /** Its home folder. */
    home: string;
    /** The folder, links resolved: what its trust decision is saved for. */
    folder: string;
    /** Its context files, the topmost folder's first. */
    context: { path: string; content: string }[];
    /** Its `.pi/skills/`, when there is one. */
    own?: string;
    /** Its `.agents/skills/` folders, nearest first, up to the repository's root, without the home folder's. */
    agents: string[];
    /** The home folder's skill places that exist. */
    user: string[];
    /** The skill files in those places (`place` is the one each is in), in Pi's order. */
    files: { place: string; path: string; text: string }[];
};

type Found = Omit<FolderScan, "at" | "paths" | "home">;

/** The path rules of a computer with this operating system. */
export function pathsFor(os: string | undefined): PathKit {
    return os === "windows" ? win32 : posix;
}

/** For tests: whether a scan may use one shell command, or only folder listings. */
export const scanSettings = { shell: true };

/** Each folder's last scan, the one being read, and how often it was forgotten (a scan that began before is stale). */
const scans = new Map<
    string,
    { value?: FolderScan; running?: Promise<FolderScan>; forgotten?: number }
>();

const keyOf = (env: RemoteEnv, cwd: string) => `${env.id}\0${cwd}`;

/**
 * The folder `cwd` on another computer, read again when the last scan is older than 30 seconds. Throws when the computer
 * cannot be reached.
 */
export function scanFolder(env: RemoteEnv, cwd: string): Promise<FolderScan> {
    const entry = scans.get(keyOf(env, cwd));

    if (entry?.value !== undefined && Date.now() - entry.value.at < STALE_MS) {
        return Promise.resolve(entry.value);
    }

    return refresh(env, cwd);
}

/** The last scan of the folder, at once, or undefined before the first; an old or missing one is read again meanwhile. */
export function knownScan(env: RemoteEnv, cwd: string): FolderScan | undefined {
    const value = scans.get(keyOf(env, cwd))?.value;

    if (value === undefined || Date.now() - value.at >= STALE_MS) {
        refresh(env, cwd).catch(() => {});
    }

    return value;
}

/**
 * Forget what was read of the folders on the computer of `env` that a file at `path` there is context or a skill for:
 * the next turn reads them again. A context file or `SKILL.md` that Pi writes counts from its next request, not 30
 * seconds later (a subagent started at once must see it).
 */
export function changedThere(env: RemoteEnv, path: string): void {
    const name = path.split(/[\\/]/).pop() ?? "";

    if (!CANDIDATES.includes(name) && name !== "SKILL.md") {
        return;
    }

    const prefix = `${env.id}\0`;

    for (const [key, entry] of scans) {
        if (key.startsWith(prefix)) {
            entry.value = undefined;
            entry.running = undefined;
            entry.forgotten = (entry.forgotten ?? 0) + 1;
        }
    }
}

/**
 * The folder read again. A computer that is offline is waited for (`runners.ts`): what calls this runs in a turn, which
 * starts only when the computer is back. Undefined when the reading fails.
 */
export async function latestScan(env: RemoteEnv, cwd: string): Promise<FolderScan | undefined> {
    try {
        return await scanFolder(env, cwd);
    } catch {
        return undefined;
    }
}

function refresh(env: RemoteEnv, cwd: string): Promise<FolderScan> {
    const key = keyOf(env, cwd);
    const entry = scans.get(key) ?? {};

    if (entry.running !== undefined) {
        return entry.running;
    }

    const forgotten = entry.forgotten;
    const running = readFolder(env, cwd).finally(() => {
        if (entry.running === running) {
            entry.running = undefined;
        }
    });

    entry.running = running;
    scans.set(key, entry);
    running.then(
        (value) => {
            // Read before a file there changed (`changedThere`): it may miss it, so it is not kept.
            if (entry.forgotten === forgotten) {
                entry.value = value;
            }
        },
        () => {},
    );

    return running;
}

/** The folder `cwd` on another computer, read now (no cache). Throws when the computer cannot be reached. */
export async function readFolder(env: RemoteEnv, cwd: string): Promise<FolderScan> {
    const info = await env.connection.info();
    const paths = pathsFor(info.os);
    const folder = paths.resolve(cwd);
    const home = paths.resolve(info.home);
    const at = Date.now();
    const found =
        (scanSettings.shell && info.os !== "windows"
            ? await shellScan(env, folder, home)
            : undefined) ?? (await listingScan(env, paths, folder, home));

    return { at, paths, home, ...found };
}

/**
 * The scan as one POSIX `sh` command: each record is a line `<marker> TAB kind TAB place TAB path` after a newline, and
 * a file's text follows its record. The marker is new each time, so no file can end a record early.
 */
const SCRIPT = String.raw`
N=$1 cwd=$2 home=$3 max=$4
mark() { printf '\n%s\t%s\t%s\t%s\n' "$N" "$1" "$2" "$3"; }
show() { mark "$1" "$2" "$3"; head -c "$max" "$3" 2>/dev/null; }
walk() {
    if [ -f "$2/SKILL.md" ]; then show skill "$1" "$2/SKILL.md"; return 0; fi
    [ "$4" -lt ${MAX_DEPTH} ] || return 0
    for e in "$2"/*; do
        [ -e "$e" ] || continue
        case "\${e##*/}" in node_modules) continue ;; esac
        if [ -d "$e" ]; then walk "$1" "$e" 0 $(($4 + 1))
        elif [ "$3" = 1 ] && [ -f "$e" ]; then
            case "$e" in *.md) show skill "$1" "$e" ;; esac
        fi
    done
}
real=$(cd "$cwd" 2>/dev/null && pwd -P) || real=$cwd
mark folder "" "$real"
d=$cwd git=
while :; do
    p=\${d%/}
    for c in ${CANDIDATES.join(" ")}; do
        if [ -f "$p/$c" ]; then show context "" "$p/$c"; break; fi
    done
    if [ -z "$git" ] && [ -e "$p/.git" ]; then git=$d; fi
    [ -n "$p" ] || break
    d=\${p%/*}; [ -n "$d" ] || d=/
done
p=\${cwd%/}
if [ -d "$p/.pi/skills" ]; then mark own "" "$p/.pi/skills"; walk "$p/.pi/skills" "$p/.pi/skills" 1 0; fi
d=$cwd
while :; do
    p=\${d%/}
    f=$p/.agents/skills
    if [ "$f" != "\${home%/}/.agents/skills" ] && [ -d "$f" ]; then mark agents "" "$f"; walk "$f" "$f" 1 0; fi
    if [ "$d" = "$git" ] || [ -z "$p" ]; then break; fi
    d=\${p%/*}; [ -n "$d" ] || d=/
done
for f in "\${home%/}/.pi/agent/skills" "\${home%/}/.agents/skills"; do
    if [ -d "$f" ]; then mark user "" "$f"; walk "$f" "$f" 1 0; fi
done
mark end "" ""
`.replace(/\\\$/g, "$");

async function shellScan(env: RemoteEnv, cwd: string, home: string): Promise<Found | undefined> {
    const marker = randomUUID();
    const run = withCancel(context);
    let out = "";
    let tooMuch = false;
    const result = await env.exec(
        ["sh", "-c", SCRIPT, "sh", marker, cwd, home, String(MAX_FILE)],
        {
            // In the session's folder: its runner refuses a command elsewhere (`docs/runners.md`).
            cwd,
            timeout: SCAN_TIMEOUT_S,
            onOutput: (text, _context, { stream }) => {
                if (stream !== "stdout" || tooMuch) {
                    return;
                }

                out += text;

                if (out.length > MAX_OUTPUT) {
                    tooMuch = true;
                    run.cancel();
                }
            },
        },
        run.context,
    );

    if (tooMuch) {
        throw new Error(`The skill and context files in ${cwd} are too large to read.`);
    }

    return result.ok ? parseScan(out, marker) : undefined;
}

/** The records of a shell scan; undefined when it did not finish. */
export function parseScan(out: string, marker: string): Found | undefined {
    const found: Found = { folder: "", context: [], agents: [], user: [], files: [] };
    let ended = false;

    for (const piece of out.split(`\n${marker}\t`).slice(1)) {
        const newline = piece.indexOf("\n");
        const [kind, place, path] = piece.slice(0, newline).split("\t") as [string, string, string];
        const text = stripBom(piece.slice(newline + 1));

        if (kind === "folder") {
            found.folder = path;
        } else if (kind === "context") {
            found.context.unshift({ path, content: text });
        } else if (kind === "own") {
            found.own = path;
        } else if (kind === "agents") {
            found.agents.push(path);
        } else if (kind === "user") {
            found.user.push(path);
        } else if (kind === "skill") {
            found.files.push({ place, path, text });
        } else if (kind === "end") {
            ended = true;
        }
    }

    return ended && found.folder !== "" ? found : undefined;
}

/** The scan as listings of folders, side by side where they can be: for Windows, or a computer without `sh`. */
async function listingScan(
    env: RemoteEnv,
    paths: PathKit,
    cwd: string,
    home: string,
): Promise<Found> {
    // A lost link is not "no such file": it fails the scan, so no empty one is kept.
    const failed = (error: FileError) => {
        if (isConnectionLost((error as { cause?: unknown }).cause)) {
            throw error;
        }

        return undefined;
    };

    const list = async (dir: string) => {
        const listed = await env.listDir(dir, context);

        return listed.ok ? listed.value : failed(listed.error);
    };

    const read = async (path: string) => {
        const text = await env.readTextFile(path, context);

        return text.ok ? stripBom(text.value.slice(0, MAX_FILE)) : failed(text.error);
    };

    const ancestors: string[] = [];

    for (let current = cwd; ; current = paths.dirname(current)) {
        ancestors.push(current);

        if (paths.dirname(current) === current) {
            break;
        }
    }

    const [real, listings] = await Promise.all([
        env.canonicalPath(cwd, context),
        Promise.all(ancestors.map(list)),
    ]);
    const has = (index: number, name: string): FileInfo | undefined =>
        listings[index]?.find((entry) => entry.name === name);
    const contextFiles = await Promise.all(
        ancestors.map(async (folder, index) => {
            for (const name of CANDIDATES) {
                const entry = has(index, name);

                if (entry === undefined || entry.kind === "directory") {
                    continue;
                }

                const path = paths.join(folder, name);
                const content = await read(path);

                if (content !== undefined) {
                    return [{ path, content }];
                }
            }

            return [];
        }),
    );
    const git = ancestors.findIndex((_, index) => has(index, ".git") !== undefined);
    const homeAgents = paths.join(home, ".agents", "skills");
    const agentsAt = ancestors
        .slice(0, git === -1 ? ancestors.length : git + 1)
        .filter((_, index) => has(index, ".agents") !== undefined)
        .map((folder) => paths.join(folder, ".agents", "skills"))
        .filter((folder) => folder !== homeAgents);
    const ownAt = has(0, ".pi") === undefined ? undefined : paths.join(cwd, ".pi", "skills");
    const userAt = [paths.join(home, ".pi", "agent", "skills"), homeAgents];

    // Pi's rules: a folder with SKILL.md is one skill; else `.md` files at the top and the folders in it, without hidden
    // ones and node_modules.
    const walk = async (
        dir: string,
        top: boolean,
        depth: number,
    ): Promise<string[] | undefined> => {
        const entries = await list(dir);

        if (entries === undefined) {
            return undefined;
        }

        if (entries.some((entry) => entry.name === "SKILL.md" && entry.kind !== "directory")) {
            return [paths.join(dir, "SKILL.md")];
        }

        if (depth >= MAX_DEPTH) {
            return [];
        }

        const inner = await Promise.all(
            entries
                .filter((entry) => !entry.name.startsWith(".") && entry.name !== "node_modules")
                .map(async (entry) => {
                    const path = paths.join(dir, entry.name);

                    if (entry.kind !== "file") {
                        const below = await walk(path, false, depth + 1);

                        if (below !== undefined || entry.kind === "directory") {
                            return below ?? [];
                        }
                    }

                    return top && entry.name.endsWith(".md") ? [path] : [];
                }),
        );

        return inner.flat();
    };

    const places = [...(ownAt === undefined ? [] : [ownAt]), ...agentsAt, ...userAt];
    const walked = await Promise.all(places.map((place) => walk(place, true, 0)));
    const exists = (place: string) => walked[places.indexOf(place)] !== undefined;
    const listed = places.flatMap((place, index) =>
        (walked[index] ?? []).map((path) => ({ place, path })),
    );
    const texts = await Promise.all(listed.map(({ path }) => read(path)));

    return {
        folder: real.ok ? real.value : (failed(real.error) ?? cwd),
        context: contextFiles.flat().reverse(),
        ...(ownAt !== undefined && exists(ownAt) ? { own: ownAt } : {}),
        agents: agentsAt.filter(exists),
        user: userAt.filter(exists),
        files: listed.flatMap((file, index) => {
            const text = texts[index];

            return text === undefined ? [] : [{ ...file, text }];
        }),
    };
}

function stripBom(text: string): string {
    return text.startsWith("\uFEFF") ? text.slice(1) : text;
}

/** A skill file as Pi reads one (`loadSkillFromFile`): none without a description. */
function skillOf(
    file: { path: string; text: string },
    paths: PathKit,
    scope: "user" | "project",
): Skill | undefined {
    let frontmatter: Record<string, unknown>;

    try {
        frontmatter = parseFrontmatter(file.text).frontmatter;
    } catch {
        return undefined;
    }

    const description = frontmatter.description;

    if (typeof description !== "string" || description.trim() === "") {
        return undefined;
    }

    const baseDir = paths.dirname(file.path);
    const name =
        typeof frontmatter.name === "string" && frontmatter.name !== ""
            ? frontmatter.name
            : paths.basename(baseDir);

    return {
        name,
        description,
        filePath: file.path,
        baseDir,
        sourceInfo: createSyntheticSourceInfo(file.path, { source: "remote", scope, baseDir }),
        disableModelInvocation: frontmatter["disable-model-invocation"] === true,
    };
}

/**
 * The skills a session in the scanned folder loads (the first of each name), and whether its project is trusted, as
 * `skills.ts` decides for a folder here: `.pi/skills/` loads unless the project is distrusted, `.agents/skills/` only
 * while it is trusted. `saved` is `savedTrust`'s answer; `defaultProjectTrust` is Pi's setting.
 */
export function remoteProject(
    scan: FolderScan,
    saved: Saved | null | undefined,
    defaultProjectTrust: SkillSources["defaultProjectTrust"],
): { skills: Skill[]; trust: ProjectTrust } {
    const skillsIn = (places: readonly string[], scope: "user" | "project") =>
        places.flatMap((place) =>
            scan.files.flatMap((file) => {
                const skill = file.place === place ? skillOf(file, scan.paths, scope) : undefined;

                return skill === undefined ? [] : [skill];
            }),
        );
    const own = skillsIn(scan.own === undefined ? [] : [scan.own], "project");
    const agents = skillsIn(scan.agents, "project");
    const decision = decides(saved, { defaultProjectTrust });
    const loaded = [
        ...(decision === "distrusted" ? [] : own),
        ...(decision === "trusted" ? agents : []),
        ...skillsIn(scan.user, "user"),
    ];
    const names = new Set<string>();
    const skills = loaded.filter((skill) => !names.has(skill.name) && names.add(skill.name));
    const brief = (list: Skill[]) => list.map(({ name, description }) => ({ name, description }));
    const parent = scan.paths.dirname(scan.folder);

    return {
        skills,
        trust: {
            folder: scan.folder,
            ...(parent === scan.folder ? {} : { parent }),
            saved: saved ?? null,
            defaultProjectTrust,
            trusted: decision === "trusted",
            folders: scan.agents,
            skills: brief(agents),
            ownSkills: brief(own),
            // A project's settings there are not read: they need no trust.
            settings: false,
            ask: agents.length > 0 && saved === null && defaultProjectTrust === "ask",
            ...(saved === undefined ? { unreadable: true as const } : {}),
        },
    };
}

/**
 * `remoteProject` for a folder on computer `runner`, with its trust decision from this server's data folder and Pi's
 * global `defaultProjectTrust`. (Project settings there are not read, so none of them can change it.)
 */
export function projectThere(
    scan: FolderScan,
    runner: string,
    dirs: { dataDir: string; agentDir: string },
): { skills: Skill[]; trust: ProjectTrust } {
    return remoteProject(
        scan,
        savedTrust(dirs.dataDir, runner, scan.folder, scan.paths),
        defaultTrust(dirs.agentDir),
    );
}

/** The context files of a session there, as the prompt shows them: this server's global one first. */
export function contextText(agentDir: string, scan: FolderScan): string | undefined {
    const files = [...globalContext(agentDir), ...scan.context];

    if (files.length === 0) {
        return undefined;
    }

    return files
        .map((file) => `<file path="${file.path}">\n${file.content.trim()}\n</file>`)
        .join("\n\n");
}

/** Pi's global context file on this server, in its folder (`agentDir`), as `loadProjectContextFiles` finds it. */
function globalContext(agentDir: string): { path: string; content: string }[] {
    for (const name of CANDIDATES) {
        const path = join(agentDir, name);

        try {
            if (statSync(path).isFile()) {
                return [{ path, content: stripBom(readFileSync(path, "utf8")) }];
            }
        } catch {
            // Not there: the next name.
        }
    }

    return [];
}

/** Pi's `defaultProjectTrust` setting on this server, from its global settings. */
export function defaultTrust(agentDir: string): SkillSources["defaultProjectTrust"] {
    try {
        const value = (
            JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as {
                defaultProjectTrust?: unknown;
            }
        ).defaultProjectTrust;

        return value === "always" || value === "never" ? value : "ask";
    } catch {
        return "ask";
    }
}

/** The text of a file there, as for a skill's instructions. */
export async function readRemoteText(env: RemoteEnv, path: string): Promise<string> {
    const text = await env.readTextFile(path, context);

    if (!text.ok) {
        throw text.error;
    }

    return text.value;
}

/** Where a session's attached files go on a computer: `<temp>/pi-pocket-uploads/<session>/` there. */
export type UploadsFolder = { folder: string; paths: PathKit };

/**
 * The folder on the computer for a session's attached files, from what it said of its system (`hello`, also kept
 * while it is offline): in its temporary folder, so they never pile up in a person's home. `session`: its permission
 * id there (`runnerScope`), the one folder of attached files its runner lets it reach. `clearUploads` empties it when
 * the session is archived; the system clears what is left.
 */
export function uploadsFolder(
    system: { os: string; tmpdir: string },
    session: string,
): UploadsFolder {
    const paths = pathsFor(system.os);

    return {
        folder: paths.join(system.tmpdir, "pi-pocket-uploads", session),
        paths,
    };
}

/** Where file `path` (in the conversation's uploads here) is on the computer, once `copyUploads` copied it. */
export function uploadedThere(folder: UploadsFolder, path: string): string {
    return folder.paths.join(folder.folder, basename(path));
}

/**
 * Copy files people attached (kept here, in the conversation's uploads) to the computer, into `folder` there with the
 * same names (`uploadedThere`). Images are copied too, so Pi's tools can use them there; the model also sees them in
 * the message. A computer that is offline is waited for. Never throws: the names of the files that could not be copied.
 */
export async function copyUploads(
    env: RemoteEnv,
    folder: UploadsFolder,
    files: readonly { path: string; name: string }[],
): Promise<string[]> {
    const failed: string[] = [];

    await Promise.all(
        files.map(async (file) => {
            const written = await readFile(file.path).then(
                (bytes) => env.writeFile(uploadedThere(folder, file.path), bytes, context),
                () => undefined,
            );

            if (written?.ok !== true) {
                failed.push(file.name);
            }
        }),
    );

    return failed;
}

/**
 * Remove a conversation's attached files from the computer (its session was archived): when it is offline, once it is
 * back. Errors are ignored.
 */
export async function clearUploads(env: RemoteEnv, session: string): Promise<void> {
    try {
        const { folder } = uploadsFolder(await env.connection.info(), session);

        await env.remove(folder, { recursive: true, force: true }, context);
    } catch {
        // Offline, or already gone: the system's temporary folder clears it in time.
    }
}

/** Trust decisions for folders on other computers: by computer, then by path there. */
type TrustData = Record<string, Record<string, boolean>>;

export const TRUST_FILE = "remote-trust.json";

/** The saved decisions, or undefined when the file cannot be read. */
function readTrust(dataDir: string): TrustData | undefined {
    const file = join(dataDir, TRUST_FILE);

    if (!existsSync(file)) {
        return {};
    }

    try {
        const data = JSON.parse(readFileSync(file, "utf8")) as unknown;

        return typeof data === "object" && data !== null && !Array.isArray(data)
            ? (data as TrustData)
            : undefined;
    } catch {
        return undefined;
    }
}

/**
 * The decision for `folder` on computer `runner`, saved for it or the nearest folder above it, as Pi's trust store finds
 * one; null when there is none, undefined when the decisions cannot be read.
 */
export function savedTrust(
    dataDir: string,
    runner: string,
    folder: string,
    paths: PathKit,
): Saved | null | undefined {
    const data = readTrust(dataDir);

    if (data === undefined) {
        return undefined;
    }

    const mine = data[runner] ?? {};

    for (let current = folder; ; current = paths.dirname(current)) {
        const trusted = mine[current];

        if (typeof trusted === "boolean") {
            return { path: current, trusted };
        }

        if (paths.dirname(current) === current) {
            return null;
        }
    }
}

/** Save an answer to "trust this project?" for `folder` on computer `runner`, as `saveProjectTrust` does here. */
export function saveTrust(
    dataDir: string,
    runner: string,
    folder: string,
    paths: PathKit,
    choice: TrustChoice,
): void {
    const data = readTrust(dataDir);

    if (data === undefined) {
        throw new Error(`${join(dataDir, TRUST_FILE)} cannot be read.`);
    }

    const mine = { ...data[runner] };
    const parent = paths.dirname(folder);

    if (choice !== "trust-parent") {
        mine[folder] = choice === "trust";
    } else if (parent === folder) {
        throw new Error(`${folder} has no folder above it.`);
    } else {
        // The folder's own decision goes, so the one for the folder above applies to it.
        mine[parent] = true;
        delete mine[folder];
    }

    const file = join(dataDir, TRUST_FILE);
    const temporary = `${file}.${process.pid}.tmp`;

    mkdirSync(dataDir, { recursive: true });
    writeFileSync(temporary, `${JSON.stringify({ ...data, [runner]: mine }, null, 2)}\n`, {
        mode: 0o600,
    });
    renameSync(temporary, file);
}
