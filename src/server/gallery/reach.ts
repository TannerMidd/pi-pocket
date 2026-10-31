import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseColors } from "../omarchy.ts";
import { sha256 } from "./entry.ts";

export interface Scanned {
    network: string[];
    keys: string[];
    programs: string[];
    files: string[];
}

export interface Palette {
    colors: Record<string, string> | null;
    colorsLight: Record<string, string> | null;
}

export type Reach =
    | { kind: "extension"; commit: string; scanned: Scanned }
    | { kind: "theme"; commit: string; palette: Palette }
    | { kind: "extension" | "theme"; commit: string; error: string };

/** Raise it when the scan changes, so results kept from an older scan are made again. */
export const SCAN_VERSION = 6;

export const SCAN_FILE = /\.(?:[cm]?[jt]s)$/i;
export const PALETTE_FILES = ["colors.toml", "colors-light.toml"];

const DYNAMIC_ADDRESS = "addresses it builds at run time";
const DYNAMIC_PROGRAM = "programs it names at run time";
const WRITTEN_FILES = "files it writes";
const HOME_FOLDER = "your home folder";

const BEFORE_REGEX = /[(,=:[!&|?{};+\-*%<>~^]/;
const KEYWORD_BEFORE_REGEX =
    /(?:^|[^\w$])(return|typeof|void|delete|throw|case|in|of|new|else|do|yield|await)$/;

function keywordBeforeRegex(code: string): boolean {
    const end = code.trimEnd();
    const keyword = KEYWORD_BEFORE_REGEX.exec(end.slice(-12))?.[1];

    return keyword !== undefined && !end.slice(0, -keyword.length).trimEnd().endsWith(".");
}

/**
 * Where a regular expression literal whose body starts at each position ends (its closing `/`), or -1, from outside and
 * from inside a character class: one pass from the end, so that a line of `(/[` takes linear time.
 */
function regexEnds(code: string): { outside: Int32Array; inside: Int32Array } {
    const outside = new Int32Array(code.length + 2).fill(-1);
    const inside = new Int32Array(code.length + 2).fill(-1);

    for (let i = code.length - 1; i >= 0; i--) {
        const char = code[i];

        if (char === "\\") {
            outside[i] = outside[i + 2]!;
            inside[i] = inside[i + 2]!;
        } else if (char === "[") {
            outside[i] = inside[i + 1]!;
            inside[i] = inside[i + 1]!;
        } else if (char === "]") {
            outside[i] = outside[i + 1]!;
            inside[i] = outside[i + 1]!;
        } else if (char === "/") {
            outside[i] = i;
            inside[i] = inside[i + 1]!;
        } else if (char !== "\n") {
            outside[i] = outside[i + 1]!;
            inside[i] = inside[i + 1]!;
        }
    }

    return { outside, inside };
}

export function stripComments(code: string): string {
    let out = "";
    let tail = "";
    let at = 0;
    let last = "";
    let ends: { outside: Int32Array; inside: Int32Array } | undefined;

    // A separate, whitespace-collapsed tail avoids flattening `out` and preserves long keyword gaps.
    const append = (text: string) => {
        const next = text.replace(/\s+/g, " ");

        out += text;
        tail = (tail + (tail.endsWith(" ") ? next.trimStart() : next)).slice(-64);
    };

    while (at < code.length) {
        const char = code[at]!;
        const next = code[at + 1];

        if (char === "/" && next === "/") {
            while (at < code.length && code[at] !== "\n") {
                at++;
            }

            continue;
        }

        if (char === "/" && next === "*") {
            const end = code.indexOf("*/", at + 2);
            const stop = end === -1 ? code.length : end + 2;

            append(code.slice(at, stop).replace(/[^\n]/g, " "));
            at = stop;
            continue;
        }

        if (char === '"' || char === "'" || char === "`") {
            let stop = at + 1;

            while (stop < code.length && code[stop] !== char) {
                if (code[stop] === "\\") {
                    stop++;
                } else if (code[stop] === "\n" && char !== "`") {
                    break;
                }

                stop++;
            }

            append(code.slice(at, stop + 1));
            at = stop + 1;
            last = char;
            continue;
        }

        if (char === "/" && (last === "" || BEFORE_REGEX.test(last) || keywordBeforeRegex(tail))) {
            ends ??= regexEnds(code);
            let stop = ends.outside[at + 1]!;

            if (stop !== -1) {
                // Keep ambiguous line comments literal so a commented /* cannot hide later code.
                if (code[stop + 1] === "/" && keywordBeforeRegex(tail)) {
                    const end = code.indexOf("\n", stop + 2);

                    stop = end === -1 ? code.length : end;
                    append(code.slice(at, stop));
                    at = stop;
                    last = "/";
                    continue;
                }

                append(code.slice(at, stop + 1));
                at = stop + 1;
                last = "/";
                continue;
            }
        }

        append(char);
        at++;

        if (!/\s/.test(char)) {
            last = char;
        }
    }

    return out;
}

const URL_LITERAL = /\b(?:https?|wss?):\/\/([^\s"'`\\/?#:<>()[\]{}$]*)(?::\d+)?([^\s"'`\\]*)/gi;
const HOST = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
const QUIET_HOST =
    /^(?:localhost|127\.[\d.]+|(?:[a-z0-9-]+\.)*(?:w3\.org|example\.com|example\.org|schema\.org|json-schema\.org))$/;
const REPO_PAGE =
    /^\/[\w.-]+\/[\w.-]+(?:\/(?:tree|blob|issues|pull|pulls|releases|wiki|commit|commits|discussions|actions|tags)(?:\/.*)?)?\/?$/;
const CALLS_OUT =
    /(?<![\w$])(?:fetch|fetchPublic)\s*\(|\bnew\s+WebSocket\s*\(|\bhttps?\.request\s*\(/;
const CALLS_OUT_DYNAMIC =
    /(?<![\w$])(?:fetch|fetchPublic)\s*\((?!\s*(?:["']|`(?!(?:\\.|[^`\\])*\$\{)))|\bnew\s+WebSocket\s*\((?!\s*(?:["']|`(?!(?:\\.|[^`\\])*\$\{)))|\b(?:net|tls|dgram)\b\s*\.\s*(?:connect|createConnection|Socket)\b|\bnode:(?:net|tls|dgram|http2)\b/;

function networkOf(code: string): string[] {
    const hosts = new Set<string>();

    for (const match of code.matchAll(URL_LITERAL)) {
        const host = match[1]!.toLowerCase();
        const path = match[2]!.replace(/[?#].*$/, "");

        if (
            !HOST.test(host) ||
            QUIET_HOST.test(host) ||
            ((host === "github.com" || host === "www.github.com") && REPO_PAGE.test(path))
        ) {
            continue;
        }

        hosts.add(host);
    }

    const named = [...hosts]
        // Ignore git-config pseudo-hosts such as `github.com.helper`.
        .filter((host) => ![...hosts].some((other) => host.startsWith(`${other}.`)))
        .sort();

    if ((hosts.size === 0 && CALLS_OUT.test(code)) || CALLS_OUT_DYNAMIC.test(code)) {
        named.push(DYNAMIC_ADDRESS);
    }

    return named;
}

const SECRET_NAME = /KEY|TOKEN|SECRET/i;
const PI_KEY_CALL =
    /(?<![\w$])(?:getApiKey|getApiKeyForProvider|getAuth|apiKeyFor)\s*\(\s*(["'`])([\w.-]{1,60})\1/g;
const ENV_READ = /\benv(?:\??\.|\[\s*["'`])([A-Za-z_][A-Za-z0-9_]*)/g;
const ENV_DESTRUCTURE = /\{([^{}]*)\}\s*=\s*(?:process\.)?env\b/g;

function keysOf(code: string): string[] {
    const keys = new Set<string>();

    for (const match of code.matchAll(PI_KEY_CALL)) {
        keys.add(`${match[2]} key from Pi`);
    }

    const names = new Set<string>();

    for (const match of code.matchAll(ENV_READ)) {
        names.add(match[1]!);
    }

    for (const match of code.matchAll(ENV_DESTRUCTURE)) {
        for (const part of match[1]!.split(",")) {
            const name = /^\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(part)?.[1];

            if (name !== undefined) {
                names.add(name);
            }
        }
    }

    for (const name of [...names].sort()) {
        // A trailing underscore can be a dynamic key prefix, not a complete secret name.
        if (SECRET_NAME.test(name) && !name.endsWith("_")) {
            keys.add(`environment variable ${name}`);
        }
    }

    if (/auth\.json/.test(code)) {
        keys.add("Pi's auth.json");
    }

    return [...keys].sort();
}

const PROGRAM_CALL =
    /(?<![\w$.])(?:(?:child_process|childProcess|cp)\.)?(spawn|spawnSync|execFile|execFileSync|exec|execSync)\s*\(\s*(["'`])((?:\\.|(?!\2)[^\\\n])*)\2/g;
const CHILD_PROCESS = /\bchild_process\b/;
const UNNAMED_CODE =
    /\beval\s*\(|\bnew\s+Function\b|\bFunction\s*\(|\bgetBuiltinModule\b|\bprocess\s*\.\s*(?:binding|dlopen)\b|\bimport\s*\((?!\s*(?:["']|`(?!(?:\\.|[^`\\])*\$\{)))|\brequire\s*\((?!\s*(?:["']|`(?!(?:\\.|[^`\\])*\$\{)))/;
// Bound loader gaps to 200 characters to prevent quadratic work on hostile gallery code.
const NATIVE_FILE =
    /(?:\b(?:require|dlopen)\s*\(|\bcreateRequire\s*\([^)]{0,200}\)\s*\()[^)]{0,200}?["'`][^"'`\n]{0,200}\.node["'`]|["'`][^"'`\n/\\]{0,200}[/\\][^"'`\n]{0,200}\.node["'`]/;

function programsOf(code: string): string[] {
    const programs = new Set<string>();

    for (const match of code.matchAll(PROGRAM_CALL)) {
        const literal = match[3]!.split("${")[0]!;
        const program = (
            match[1]!.startsWith("exec") && !match[1]!.startsWith("execFile")
                ? literal.trim().split(/\s+/)[0]
                : literal.trim()
        )?.slice(0, 80);

        if (program !== undefined && program !== "") {
            programs.add(program);
        }
    }

    const listed = [...programs].sort();

    if (
        (programs.size === 0 && CHILD_PROCESS.test(code)) ||
        UNNAMED_CODE.test(code) ||
        NATIVE_FILE.test(code)
    ) {
        listed.push(DYNAMIC_PROGRAM);
    }

    return listed;
}

const WRITES =
    /(?<![\w$])(?:writeFile|writeFileSync|mkdir|mkdirSync|rm|rmSync|appendFile|appendFileSync)\s*\(/;
const AGENT_PATH = /(?:~\/|\$HOME\/|\$\{HOME\}\/)?\.pi\/agent((?:\/[A-Za-z0-9_.-]+)*)/g;
const AGENT_JOIN = /["'`]\.pi["'`]\s*,\s*["'`]agent["'`]/;

function filesOf(code: string): string[] {
    const files: string[] = [];
    const paths = new Set<string>();

    if (WRITES.test(code)) {
        files.push(WRITTEN_FILES);
    }

    for (const match of code.matchAll(AGENT_PATH)) {
        paths.add(`~/.pi/agent${match[1]}`);
    }

    if (AGENT_JOIN.test(code) || /\bagentDir\b/.test(code)) {
        paths.add("~/.pi/agent");
    }

    files.push(...[...paths].sort());

    if (paths.size === 0 && /(?<![\w$])homedir\s*\(/.test(code)) {
        files.push(HOME_FOLDER);
    }

    return files;
}

export function scanFiles(files: readonly { name: string; text: string }[]): Scanned {
    return scanStripped(files.map((file) => stripComments(file.text)).join("\n"));
}

export function scanCode(text: string): Scanned {
    return scanStripped(stripComments(text));
}

function scanStripped(code: string): Scanned {
    return {
        network: networkOf(code),
        keys: keysOf(code),
        programs: programsOf(code),
        files: filesOf(code),
    };
}

function colorsOf(text: string | undefined): Record<string, string> | null {
    if (text === undefined) {
        return null;
    }

    const colors = parseColors(text);

    return Object.keys(colors).length === 0 ? null : colors;
}

export function themePalette(colors: string | undefined, light: string | undefined): Palette {
    const lightColors = colorsOf(light);

    return {
        colors: colorsOf(colors),
        colorsLight: lightColors === null ? null : { ...lightColors, mode: "light" },
    };
}

export function reachKey(
    kind: string,
    name: string,
    commit: string,
    files: readonly { name: string; sha256: string }[],
): string {
    const pins = sha256(
        new TextEncoder().encode(
            `${SCAN_VERSION}\n${files.map((file) => `${file.name} ${file.sha256}`).join("\n")}`,
        ),
    );

    return `${kind}:${name}@${commit}:${pins}`;
}

const CACHE_FILE = "reach.json";

export async function loadReach(folder: string): Promise<Record<string, Reach>> {
    try {
        const saved = JSON.parse(await readFile(join(folder, CACHE_FILE), "utf8")) as {
            format?: unknown;
            results?: unknown;
        };

        if (
            saved.format !== SCAN_VERSION ||
            typeof saved.results !== "object" ||
            saved.results === null ||
            Array.isArray(saved.results)
        ) {
            return {};
        }

        return saved.results as Record<string, Reach>;
    } catch {
        return {};
    }
}

export async function saveReach(folder: string, results: Record<string, Reach>): Promise<void> {
    const path = join(folder, CACHE_FILE);

    await mkdir(folder, { recursive: true });
    await writeFile(`${path}.tmp`, `${JSON.stringify({ format: SCAN_VERSION, results })}\n`);
    await rename(`${path}.tmp`, path);
}

export function usable(value: unknown, kind: string, commit: string): value is Reach {
    if (typeof value !== "object" || value === null) {
        return false;
    }

    const reach = value as Record<string, unknown>;

    return (
        reach.kind === kind &&
        reach.commit === commit &&
        reach.error === undefined &&
        (kind === "theme"
            ? typeof reach.palette === "object" && reach.palette !== null
            : typeof reach.scanned === "object" && reach.scanned !== null)
    );
}

export async function mapLimit<T, R>(
    items: readonly T[],
    limit: number,
    work: (item: T) => Promise<R>,
): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let next = 0;

    await Promise.all(
        Array.from({ length: Math.min(limit, items.length) }, async () => {
            while (next < items.length) {
                const at = next++;

                results[at] = await work(items[at]!);
            }
        }),
    );

    return results;
}
