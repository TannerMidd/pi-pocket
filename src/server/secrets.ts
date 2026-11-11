/**
 * Core's own secrets, kept out of what Pi and people read, and out of Pi's reach:
 *
 * - `CoreSecrets.sync` gives each secret core keeps to `HiddenValues` (as `host.hide` does), in every session, PiP and
 *   subagents too: every `secret: true` setting of a module (its value and its default), `ownerToken`, the private key
 *   in `push.json`, the keys in Pi's `auth.json`, and any file a part of core adds (`watchFile`). It runs when the owner
 *   saves settings, and before each command and after each tool, where it reads again only a file that changed. A value
 *   that changes stays hidden as the old one too, for the life of the process: the old value may still be in use.
 * - `CoreSecrets.blocked` is the rule Lancet Guard applies first (`lancet.ts`): a tool call that names one of those files,
 *   a drop-in's data folder (`x.*` in the data folder), or a `.env` file, is blocked.
 *
 * Hiding is by value, as `host.hide` is: a command that transforms a value on purpose (encodes it, splits it) shows it.
 * The rule for commands reads their text: it sees a file named, also through `~`, `$HOME`, a glob, a folder the command
 * names, or a symbolic link, and not one a command computes, nor a folder searched as a whole. Neither is a boundary
 * between Pi and the files of the user it runs as.
 */
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { ConfigStore } from "./config.ts";
import type { SettingField } from "./extension-settings.ts";
import { type HiddenValues, MAX_HIDDEN, MIN_HIDDEN } from "./hidden.ts";

/** One secret found: its value, and what shows in its place. */
export interface FoundSecret {
    value: string;
    label: string;
}

/** A file that holds secrets: what of its text they are. */
export interface SecretFile {
    path: string;
    read: (text: string) => FoundSecret[];
}

export interface CoreSecretsOptions {
    hidden: HiddenValues;
    config: ConfigStore;
    dataDir: string;
    agentDir: string;
    /** The settings a module that is on declares (`ExtensionWebs.settingsOf`). */
    settingsOf: (module: string) => readonly SettingField[] | undefined;
    log: (line: string) => void;
}

/** The most old values kept hidden after they changed, so a server that keeps changing them does not fill the list. */
const MAX_RETIRED = 200;
/** Fields of `auth.json` that hold keys and tokens. */
const AUTH_FIELD = /key|token|secret|access|refresh|password|credential|cookie|session/i;
/** The fewest characters core hides of its own: a shorter one would hide ordinary output. */
const MIN_OWN = 8;

function label(text: string): string {
    const clean = text.replace(/[^A-Za-z0-9 _.:-]+/g, "-").slice(0, 60);

    return clean === "" ? "secret" : clean;
}

/** `.env`, `.env.local`, `.plane.env`, `prod.env`: a file of variables. Templates (`.env.example`) are not. */
export function isEnvFile(name: string): boolean {
    if (name === ".env") {
        return true;
    }

    if (name.startsWith(".env.")) {
        return !/^\.env\.(example|sample|template|dist|defaults)$/i.test(name);
    }

    return name.length > 4 && name.endsWith(".env");
}

/** The same in a command's words: there `process.env` is code, not a file, so only names that start with a dot count. */
function isEnvWord(name: string): boolean {
    return isEnvFile(name) && name.startsWith(".");
}

function real(path: string): string {
    try {
        return realpathSync(path);
    } catch {
        // Not there (yet): its folder may still be a link.
        try {
            return join(realpathSync(dirname(path)), basename(path));
        } catch {
            return path;
        }
    }
}

/**
 * Where a path that is there leads, links followed; undefined when it cannot be read (not there, no access, not a path
 * at all): then no link of it leads to a secret.
 */
function linked(path: string): string | undefined {
    try {
        if (lstatSync(path, { throwIfNoEntry: false }) === undefined) {
            return undefined;
        }

        return realpathSync(path);
    } catch {
        return undefined;
    }
}

function isFolder(path: string): boolean {
    try {
        return statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;
    } catch {
        return false;
    }
}

const GLOB = /[*?[]/;

/** The drop-ins' data folders in a data folder: `x.*`. */
function drops(data: string): string[] {
    try {
        return readdirSync(data).filter((name) => name.startsWith("x."));
    } catch {
        return [];
    }
}

/** Whether a part of a word is, or as a glob matches, a drop-in's data folder that is there. */
function isDrop(part: string, names: Set<string>): boolean {
    if (!part.startsWith("x.")) {
        return false;
    }

    if (!GLOB.test(part)) {
        return names.has(part);
    }

    const matches = globExpression(part);

    return [...names].some((name) => matches.test(name));
}

/** How many links a command's words are followed in the folders it names, past the one it runs in. */
const LINK_CHECKS = 1000;

/** Where core's secrets are, once for each call judged. */
interface Roots {
    files: Set<string>;
    data: string[];
    agent: string[];
    /** The names of core's files, and `auth.json`: a word whose last part is none of them names none of them. */
    names: string[];
    /** The drop-ins' data folders (`x.*`) that are in the data folder now. */
    drops: Set<string>;
}

/** A glob's words as a regular expression over whole paths (`*`, `?`, and `[...]`; no `**`). */
function globExpression(glob: string): RegExp {
    let out = "";

    for (let at = 0; at < glob.length; at++) {
        const char = glob[at]!;

        if (char === "*") {
            out += "[^/]*";
        } else if (char === "?") {
            out += "[^/]";
        } else if (char === "[") {
            const end = glob.indexOf("]", at + 1);

            if (end === -1) {
                out += "\\[";
            } else {
                const inside = glob
                    .slice(at + 1, end)
                    .replace(/^!/, "^")
                    .replace(/\\/g, "\\\\");

                out += `[${inside}]`;
                at = end;
            }
        } else {
            out += char.replace(/[.+^${}()|\\]/g, "\\$&");
        }
    }

    return new RegExp(`^${out}$`);
}

/** A glob that names `.env` files in particular (`.env*`, `*.env`), not one that names every file (`*`, `.*`). */
function isEnvGlob(name: string): boolean {
    return globExpression(name).test(".env") && /env/i.test(name.replace(/\[[^\]]*\]|[*?]/g, ""));
}

/** Commands whose words are only text, or files they do not read: a file they name is not read. */
const TEXT_COMMANDS = new Set(["echo", "printf", "touch"]);
/** Commands whose last word is where they write: `cp .env.example .env` reads no `.env`. */
const COPY_COMMANDS = new Set(["cp", "mv", "install"]);
/** Words that come before a command's name: `sudo cp`, `then echo`. */
const PREFIXES = new Set(
    "sudo command builtin exec time if then do else elif while until ! {".split(" "),
);
/** Options whose value is a name to leave out: `--exclude=.env` reads no `.env`. */
const EXCLUSION = /^--(exclude|ignore)$/i;
/** Options whose value is a message: `git commit -m "Stop tracking .env"` reads no `.env`. */
const MESSAGE = /^(-m|--message|--body|--title)$/;
const MESSAGE_VALUE = /^--(message|body|title)=/;
/** Commands whose first word, or the value of `-e`, is a script: `sed 's/.env/x/' f` reads no `.env`. */
const SCRIPT_COMMANDS = new Set(["sed", "awk", "gawk"]);
/** Their options that take the next word: a script (`-e`), a file of one (`-f`), or another value (`-F`, `-v`). */
const SCRIPT_OPTIONS = /^(-[efFlv]|--(expression|file))$/;
const HEREDOC = /(?<!<)<<(-?)\s*(['"]?)([A-Za-z_][\w.-]*)\2/g;
const REDIRECT = /[<>]+&?/y;

/** A command without its heredocs' bodies: their lines are text a command reads in, not commands. */
function withoutBodies(command: string): string {
    const lines = command.split("\n");
    const out: string[] = [];

    for (let at = 0; at < lines.length; at++) {
        out.push(lines[at]!);

        for (const [, tabs, , delimiter] of lines[at]!.matchAll(HEREDOC)) {
            const ends = (line: string) =>
                (tabs === "-" ? line.replace(/^\t+/, "") : line) === delimiter;

            do {
                at++;
            } while (at < lines.length && !ends(lines[at]!));

            if (at < lines.length) {
                out.push(lines[at]!);
            }
        }
    }

    return out.join("\n");
}

interface ShellWord {
    start: number;
    end: number;
    text: string;
}

/** Where a quoted part that starts at `at` ends. */
function quoteEnd(command: string, at: number): number {
    if (command[at] === "'") {
        const end = command.indexOf("'", at + 1);

        return end === -1 ? command.length : end + 1;
    }

    let end = at + 1;

    while (end < command.length && command[end] !== '"') {
        end += command[end] === "\\" ? 2 : 1;
    }

    return end + 1;
}

/** A command's shell words, quotes kept whole, for each simple command; where output goes is not a word. */
function simpleCommands(command: string): ShellWord[][] {
    const all: ShellWord[][] = [[]];
    let redirect = false;
    let at = 0;

    while (at < command.length) {
        const char = command[at]!;

        if (/[;&|()\n]/.test(char)) {
            all.push([]);
            redirect = false;
            at++;
        } else if (/\s/.test(char)) {
            at++;
        } else if (char === "<" || char === ">") {
            REDIRECT.lastIndex = at;
            REDIRECT.test(command);
            at = REDIRECT.lastIndex;
            redirect = true;
        } else {
            const start = at;

            while (at < command.length && !/[\s;&|()<>]/.test(command[at]!)) {
                const each = command[at]!;

                at =
                    each === "\\"
                        ? at + 2
                        : each === "'" || each === '"'
                          ? quoteEnd(command, at)
                          : at + 1;
            }

            if (!redirect) {
                all.at(-1)!.push({ start, end: at, text: command.slice(start, at) });
            }

            redirect = false;
        }
    }

    return all;
}

/**
 * A command with the words that are only text left empty: heredoc bodies, the value of `-m`, `--message`, `--body`, and
 * `--title`, and a `sed` or `awk` script. A word with a substitution in it is kept: `-m "$(cat .env)"` reads `.env`.
 */
function withoutText(command: string): string {
    const text = withoutBodies(command);
    const ranges: [number, number][] = [];

    const add = (word: ShellWord | undefined, from = word?.start) => {
        if (word !== undefined && !/\$\(|`/.test(word.text.replace(/'[^']*'/g, ""))) {
            ranges.push([from!, word.end]);
        }
    };

    for (const words of simpleCommands(text)) {
        const first = words.findIndex(
            (word) => !PREFIXES.has(word.text) && !/^[A-Za-z_]\w*=/.test(word.text),
        );
        const script = first !== -1 && SCRIPT_COMMANDS.has(basename(words[first]!.text));
        let scriptWord = script;

        for (let at = first + 1; first !== -1 && at < words.length; at++) {
            const word = words[at]!;
            const value = MESSAGE_VALUE.exec(word.text);

            if (MESSAGE.test(word.text)) {
                add(words[++at]);
            } else if (value !== null) {
                add(word, word.start + value[0].length);
            } else if (script && SCRIPT_OPTIONS.test(word.text)) {
                // With `-e` or `-f` no word is the script; a `-f` file is read.
                scriptWord &&= !/^(-[ef]|--(expression|file))$/.test(word.text);
                at++;

                if (/^(-e|--expression)$/.test(word.text)) {
                    add(words[at]);
                }
            } else if (scriptWord && !word.text.startsWith("-")) {
                add(word);
                scriptWord = false;
            }
        }
    }

    let out = "";
    let from = 0;

    for (const [start, end] of ranges) {
        out += `${text.slice(from, start)}''`;
        from = end;
    }

    return out + text.slice(from);
}

/**
 * A command's words: all of them, and those that may name a file it reads. Not read: the words of `echo`, `printf`, and
 * `touch`, `git rm --cached`, where output goes (`>`, `>>`), a heredoc's delimiter, an excluded name, where `cp` or
 * `mv` writes, and text (`withoutText`).
 */
function commandWords(command: string): { all: string[]; read: string[] } {
    const all: string[] = [];
    const read: string[] = [];
    const clean = (text: string) =>
        text
            .split(/[=,]+/)
            .map((word) => word.replace(/^[{[]+|[}\]]+$/g, ""))
            .filter((word) => word !== "" && !word.startsWith("-"));

    // Each simple command on its own: a separator, a subshell, or a substitution starts the next.
    for (const part of withoutText(command).split(/[;|&\n()`]+/)) {
        const tokens = part
            .split(/([<>]+&?)|[\s'"]+/)
            .filter((token): token is string => token !== undefined && token !== "");
        const args: string[] = [];
        let name: string | undefined;
        let after: string | undefined;

        for (const token of tokens) {
            if (/^[<>]/.test(token)) {
                after = token;
                continue;
            }

            const before = after;
            const [, option, value = ""] = /^(--?[\w-]+)=(.*)$/.exec(token) ?? [];
            const words = clean(option === undefined ? token : EXCLUSION.test(option) ? "" : value);

            after = EXCLUSION.test(token) ? token : undefined;
            all.push(...words);

            if (before === "<") {
                read.push(...words);
            } else if (before !== undefined) {
                // Where output goes, a heredoc's delimiter or a here-string, or a name left out: none is read.
            } else if (name !== undefined) {
                args.push(...words);
            } else if (/^[A-Za-z_]\w*=/.test(token) || token.startsWith("-")) {
                read.push(...words);
            } else if (!PREFIXES.has(token)) {
                name = basename(token);
                read.push(...words);
            }
        }

        if (
            name !== undefined &&
            (TEXT_COMMANDS.has(name) ||
                // `git rm --cached .env` stops tracking it, and reads nothing.
                (name === "git" && args.includes("rm") && tokens.includes("--cached")))
        ) {
            continue;
        }

        const into =
            name !== undefined &&
            COPY_COMMANDS.has(name) &&
            args.length > 1 &&
            !tokens.some((token) =>
                /^(-[A-Za-z]*t[A-Za-z]*|--target-directory(=.*)?)$/.test(token),
            );

        read.push(...(into ? args.slice(0, -1) : args));
    }

    return { all, read };
}

const SHELL_TOOLS = new Set(["bash", "powershell", "background"]);
/** Tools whose `path` only writes a whole new file: they read nothing back. */
const WRITE_ONLY = new Set(["write"]);

export class CoreSecrets {
    readonly #options: CoreSecretsOptions;
    /** What is hidden now, by value: the value's label, and how to stop hiding it. */
    readonly #hidden = new Map<string, () => void>();
    /** Values that were secrets and changed: still hidden, oldest first. */
    readonly #retired: string[] = [];
    readonly #files = new Map<string, SecretFile>();
    /** What each file held when last read, by path: its size and time, so an unchanged file is not read again. */
    readonly #read = new Map<string, { stamp: string; found: FoundSecret[] }>();
    #syncing = false;

    constructor(options: CoreSecretsOptions) {
        this.#options = options;
        this.watchFile({
            path: join(options.dataDir, "push.json"),
            read: (text) => {
                const key = (JSON.parse(text) as { vapid?: { privateKey?: unknown } }).vapid
                    ?.privateKey;

                return typeof key === "string" ? [{ value: key, label: "push private key" }] : [];
            },
        });
        this.watchFile({
            path: join(options.agentDir, "auth.json"),
            read: (text) => authSecrets(JSON.parse(text)),
        });
    }

    /** Hide what a file holds, and keep Pi from it (a part of core that keeps a secret of its own in a file). */
    watchFile(file: SecretFile): void {
        this.#files.set(resolve(file.path), file);
        this.#read.delete(resolve(file.path));
    }

    /** The files core keeps secrets in: `config.json`, and each watched one. */
    files(): string[] {
        return [join(this.#options.dataDir, "config.json"), ...this.#files.keys()];
    }

    /** What is hidden now, as labels: for tests and the log, never the values. */
    labels(): string[] {
        return [...this.#current().map((each) => each.label)].sort();
    }

    /** Hide each secret found now, in every session. A value no longer found stays hidden, as an old value. */
    sync(): void {
        // A file read below can log, and a log line can come back here: one sync at a time.
        if (this.#syncing) {
            return;
        }

        this.#syncing = true;

        try {
            const found = this.#current();
            const now = new Set(found.map((each) => each.value));

            for (const { value, label: name } of found) {
                if (this.#hidden.has(value)) {
                    const at = this.#retired.indexOf(value);

                    if (at !== -1) {
                        this.#retired.splice(at, 1);
                    }

                    continue;
                }

                try {
                    this.#hidden.set(value, this.#options.hidden.add({ value, label: name }));
                } catch (error) {
                    // Full, or out of bounds: the log says which secret, never its value.
                    this.#options.log(
                        `Core secrets: ${name} is not hidden: ${error instanceof Error ? error.message : String(error)}`,
                    );
                }
            }

            for (const value of this.#hidden.keys()) {
                if (!now.has(value) && !this.#retired.includes(value)) {
                    this.#retired.push(value);
                }
            }

            while (this.#retired.length > MAX_RETIRED) {
                const value = this.#retired.shift()!;

                this.#hidden.get(value)?.();
                this.#hidden.delete(value);
            }
        } finally {
            this.#syncing = false;
        }
    }

    #current(): FoundSecret[] {
        const { config } = this.#options;
        const found: FoundSecret[] = [{ value: config.ownerToken, label: "owner token" }];

        for (const module of config.extensionSettingModules()) {
            const stored = config.extensionSettings(module);

            // A module that is off declares no settings: which of its values are secret is unknown, so none is hidden.
            // One hidden while it was on stays hidden, as an old value.
            for (const field of this.#options.settingsOf(module) ?? []) {
                if (field.type !== "text" || field.secret !== true) {
                    continue;
                }

                const name = label(`secret ${module}.${field.name}`);

                for (const value of [stored[field.name], field.default]) {
                    if (typeof value === "string") {
                        found.push({ value, label: name });
                    }
                }
            }
        }

        for (const [path, file] of this.#files) {
            found.push(...this.#readFile(path, file));
        }

        return found.filter(
            (each) =>
                each.value.length >= Math.max(MIN_HIDDEN, MIN_OWN) &&
                each.value.length <= MAX_HIDDEN,
        );
    }

    #readFile(path: string, file: SecretFile): FoundSecret[] {
        let stamp: string;

        try {
            const stat = statSync(path);

            stamp = `${stat.size}:${stat.mtimeMs}:${stat.ino}`;
        } catch {
            this.#read.delete(path);

            return [];
        }

        const known = this.#read.get(path);

        if (known?.stamp === stamp) {
            return known.found;
        }

        let found: FoundSecret[];

        try {
            found = file.read(readFileSync(path, "utf8"));
        } catch {
            // Half written, or not what it should be: what it held before stays hidden, and the next sync reads it again.
            return known?.found ?? [];
        }

        this.#read.set(path, { stamp, found });

        return found;
    }

    /**
     * Why a tool call may not run, when it would read a file that holds secrets, or undefined. Tools with a `path` (read,
     * edit, artifact, and others) are judged by where it leads; bash, PowerShell, and a background task's command by the
     * files their words name, as far as words can say.
     */
    blocked(tool: string, args: Record<string, unknown>, cwd: string): string | undefined {
        if (SHELL_TOOLS.has(tool)) {
            if (tool === "background" && args.action !== "start") {
                return undefined;
            }

            return typeof args.command === "string" ? this.#command(args.command, cwd) : undefined;
        }

        if (WRITE_ONLY.has(tool)) {
            return undefined;
        }

        const roots = this.#roots();

        for (const path of paths(args)) {
            const why = this.#path(resolve(cwd, this.#home(path)), roots);

            if (why !== undefined) {
                return why;
            }
        }

        return undefined;
    }

    /** `~` and `$HOME` as the shell expands them. */
    #home(text: string): string {
        const home = homedir();

        return text
            .replace(/\$\{HOME\}|\$HOME(?![A-Za-z0-9_])/g, home)
            .replace(/(^|[\s=:'"(])~(?=\/|$|[\s'")])/g, `$1${home}`);
    }

    /** Why a path is off limits, or undefined: the path as given, and where its links lead. */
    #path(path: string, roots: Roots): string | undefined {
        for (const each of new Set([path, real(path)])) {
            const why = this.#protected(each, isEnvFile, roots);

            if (why !== undefined) {
                return why;
            }
        }

        return undefined;
    }

    #roots(): Roots {
        const both = (path: string) => [...new Set([resolve(path), real(path)])];
        const files = this.files().flatMap(both);
        const data = both(this.#options.dataDir);

        return {
            files: new Set(files),
            data,
            agent: both(this.#options.agentDir),
            names: [...new Set([...files.map((file) => basename(file)), "auth.json"])],
            drops: new Set(data.flatMap(drops)),
        };
    }

    #protected(path: string, envFile: (name: string) => boolean, roots: Roots): string | undefined {
        if (roots.files.has(path)) {
            return `${basename(path)} holds Pi Pocket's secrets`;
        }

        for (const data of roots.data) {
            if (path.startsWith(data + sep)) {
                const first = path.slice(data.length + 1).split(sep)[0]!;

                if (first.startsWith("x.")) {
                    return `${first} is an extension's private data`;
                }
            }
        }

        if (path.endsWith(`${sep}.pi${sep}agent${sep}auth.json`)) {
            return "auth.json holds Pi's sign-ins";
        }

        if (envFile(basename(path))) {
            return `${basename(path)} is a file of secrets`;
        }

        return undefined;
    }

    #command(command: string, cwd: string): string | undefined {
        const { all, read: words } = commandWords(this.#home(command));
        const roots = this.#roots();
        // A word may be relative to the folder the command runs in, or a folder the command names, and where they lead.
        const bases = new Set([cwd, real(cwd)]);

        for (const word of new Set(all)) {
            if (isAbsolute(word) && !GLOB.test(word) && isFolder(word)) {
                bases.add(word).add(real(word));
            }
        }

        // In a folder that is off limits as a whole, every word names what it holds.
        const inside = new Set(
            [...bases].filter(
                (base) => this.#protected(join(base, "_"), isEnvWord, roots) !== undefined,
            ),
        );
        const candidates = [
            ...roots.files,
            ...roots.data.map((data) => join(data, "x.")),
            ...roots.agent.map((agent) => join(agent, "auth.json")),
        ];
        const near = new Set([cwd, ...inside]);
        let links = LINK_CHECKS;

        // The same word twice is judged the same.
        for (const word of new Set(words)) {
            const glob = GLOB.test(word);

            if (isEnvWord(basename(word)) || (glob && isEnvGlob(basename(word)))) {
                return `${basename(word)} is a file of secrets`;
            }

            // Only a word that ends in the name of one of core's files, or passes through a drop-in's folder, can name one
            // as written. JavaScript (`x.items.map`) passes through none, so it is not joined to every folder named.
            const last = glob ? globExpression(basename(word)) : undefined;
            const named =
                word.split("/").some((part) => isDrop(part, roots.drops)) ||
                (last === undefined
                    ? roots.names.includes(basename(word))
                    : [...roots.names, "x.any"].some((name) => last.test(name)));

            // Once no link is left to follow elsewhere, a word that names nothing is tried only where it can still lead.
            const tried = isAbsolute(word) ? ["/"] : named || links > 0 ? bases : near;

            for (const base of tried) {
                const literal = named || inside.has(base);
                // A link may lead anywhere: followed where the command runs, and a bounded number of times elsewhere.
                const follow = !glob && (base === cwd || isAbsolute(word) || links-- > 0);

                if (!literal && !follow) {
                    continue;
                }

                const path = resolve(base, word);

                if (glob) {
                    // The folder before the first wildcard (`x.*` in the data folder) may be off limits as a whole.
                    const prefix = this.#protected(
                        path.slice(0, path.search(GLOB)),
                        isEnvWord,
                        roots,
                    );

                    if (prefix !== undefined) {
                        return prefix;
                    }

                    const matches = globExpression(path);
                    const hit = candidates.find(
                        (candidate) =>
                            matches.test(candidate) ||
                            // `x.*` names every drop-in's folder.
                            (candidate.endsWith(`${sep}x.`) && matches.test(`${candidate}any`)),
                    );

                    if (hit !== undefined) {
                        return `${word} names ${basename(hit) === "x." ? "an extension's private data" : basename(hit)}`;
                    }

                    continue;
                }

                // Only a word that names a path: `config.json` alone is any project's, unless the command is in the folder.
                const why = literal ? this.#protected(path, isEnvWord, roots) : undefined;

                if (why !== undefined) {
                    return why;
                }

                const target = follow ? linked(path) : undefined;
                const led =
                    target === undefined ? undefined : this.#protected(target, isEnvWord, roots);

                if (led !== undefined) {
                    return led;
                }
            }
        }

        return undefined;
    }
}

/** The `path` arguments of a tool call: its own, and its assets'. */
function paths(args: Record<string, unknown>): string[] {
    const out: string[] = [];

    for (const [key, value] of Object.entries(args)) {
        if (typeof value === "string" && /^(path|file|filePath|from|source)$/.test(key)) {
            out.push(value);
        }

        if (Array.isArray(value)) {
            for (const each of value) {
                if (
                    typeof each === "object" &&
                    each !== null &&
                    typeof (each as { path?: unknown }).path === "string"
                ) {
                    out.push((each as { path: string }).path);
                }
            }
        }
    }

    return out.filter((each) => each !== "");
}

/** Every key and token in Pi's `auth.json`, by provider. */
function authSecrets(parsed: unknown): FoundSecret[] {
    const found: FoundSecret[] = [];

    if (typeof parsed !== "object" || parsed === null) {
        return found;
    }

    const walk = (value: unknown, provider: string, field: string) => {
        if (typeof value === "string") {
            if (AUTH_FIELD.test(field)) {
                found.push({ value, label: label(`auth ${provider}`) });
            }
        } else if (Array.isArray(value)) {
            for (const each of value) {
                walk(each, provider, field);
            }
        } else if (typeof value === "object" && value !== null) {
            for (const [key, each] of Object.entries(value)) {
                walk(each, provider, key);
            }
        }
    };

    for (const [provider, entry] of Object.entries(parsed)) {
        walk(entry, provider, "");
    }

    return found;
}
