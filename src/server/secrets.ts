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
import { readFileSync, realpathSync, statSync } from "node:fs";
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
/** A stored value of a module whose settings are unknown (it is off) is hidden when it looks like a key: no spaces. */
const KEY_LIKE = /^\S{12,}$/;
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
            const fields = this.#options.settingsOf(module);
            const stored = config.extensionSettings(module);

            if (fields === undefined) {
                // A module that is off: which of its values are secret is unknown, so each that looks like a key is.
                for (const [name, value] of Object.entries(stored)) {
                    if (typeof value === "string" && KEY_LIKE.test(value)) {
                        found.push({ value, label: label(`setting ${module}.${name}`) });
                    }
                }

                continue;
            }

            for (const field of fields) {
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

        for (const path of paths(args)) {
            const why = this.#path(resolve(cwd, this.#home(path)));

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
    #path(path: string, envFile = isEnvFile): string | undefined {
        for (const each of new Set([path, real(path)])) {
            const why = this.#protected(each, envFile);

            if (why !== undefined) {
                return why;
            }
        }

        return undefined;
    }

    #roots(): { files: string[]; data: string[]; agent: string[] } {
        const both = (path: string) => [...new Set([resolve(path), real(path)])];

        return {
            files: this.files().flatMap(both),
            data: both(this.#options.dataDir),
            agent: both(this.#options.agentDir),
        };
    }

    #protected(path: string, envFile: (name: string) => boolean): string | undefined {
        const roots = this.#roots();

        if (roots.files.includes(path)) {
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
        const words = this.#home(command)
            .split(/[\s;|&<>()'"`=,]+/)
            .map((word) => word.replace(/^[{[]+|[}\]]+$/g, ""))
            .filter((word) => word !== "" && !word.startsWith("-"));
        // A word may be relative to the folder the command runs in, the home folder, or a folder the command names.
        const bases = [
            ...new Set([cwd, ...words.filter((word) => isAbsolute(word) && !/[*?[]/.test(word))]),
        ];
        const roots = this.#roots();
        const candidates = [
            ...roots.files,
            ...roots.data.map((data) => join(data, "x.")),
            ...roots.agent.map((agent) => join(agent, "auth.json")),
        ];

        for (const word of words) {
            const glob = /[*?[]/.test(word);

            if (
                isEnvWord(basename(word)) ||
                (glob && globExpression(basename(word)).test(".env"))
            ) {
                return `${basename(word)} is a file of secrets`;
            }

            for (const base of isAbsolute(word) ? [""] : bases) {
                const path = resolve(base || "/", word);

                if (glob) {
                    // The folder before the first wildcard (`x.*` in the data folder) may be off limits as a whole.
                    const prefix = this.#protected(path.slice(0, path.search(/[*?[]/)), isEnvWord);

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
                const why = this.#path(path, isEnvWord);

                if (why !== undefined) {
                    return why;
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
