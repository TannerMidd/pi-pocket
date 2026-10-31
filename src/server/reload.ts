/**
 * Live editing. Extension modules are imported again when they change and installed under the same names, which
 * replaces them in one step: a tool call already running finishes on the old code, the next one uses the new code.
 * Web files only need the browsers to reload.
 *
 * Modules come from two folders: Pi Pocket's own (`src/server/extensions/`), and the owner's drop-ins
 * (`extensions/` in the data folder), which load after them and stay off until the owner turns them on. The owner
 * can turn modules off and on from the app. A module that is off is not loaded, and turning one off uninstalls what
 * it installed; a tool call already running still finishes. What a module adds to the app (routes, a browser module,
 * commands) is kept by `ExtensionWebs` and goes in and out with its extensions.
 */
import {
    accessSync,
    constants,
    existsSync,
    type FSWatcher,
    lstatSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    statSync,
    symlinkSync,
    watch,
    writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Extension, Registry } from "@earendil-works/pi-durable";
import { describe } from "./errors.ts";
import { documentImports } from "./extension-document-imports.ts";
import { ExtensionWebs, OLDEST_POCKET_API, POCKET_API } from "./extension-web.ts";
import type { ExtensionModule, PocketHost, WebAccess } from "./host.ts";

/**
 * How long a module may take to load (its import, and an async default export) before its load fails. At the server's
 * start the modules share it: once it is spent, each module after has a fifteenth of it (2 s).
 */
const LOAD_LIMIT_MS = 30_000;
/** Loads so far in this process: each import of a module gets an address of its own. */
let imports = 0;

/** Built-in extension modules, in install order. Other `.ts` files in the directory load after them, by name. */
const ORDER = [
    "prompt.ts",
    "artifacts.ts",
    "browser.ts",
    "subagents.ts",
    "agent-teams.ts",
    "schedules.ts",
    "background.ts",
    "goals.ts",
    "plan.ts",
    "anthropic-subscription.ts",
    "guard.ts",
    "codemode.ts",
    "memory.ts",
    "pip.ts",
    "triggers.ts",
    "gallery.ts",
    "session-tags.ts",
    "ask.ts",
    "ask-someone.ts",
    "updates.ts",
    "design.ts",
    "tool-search.ts",
];

/** The built-in modules' names (their files' without `.ts`): a drop-in with one of them is never loaded. */
export const BUILT_IN_MODULES: ReadonlySet<string> = new Set(
    ORDER.map((file) => file.replace(/\.ts$/, "")),
);
/** Modules the app cannot work without: always on. */
const REQUIRED = new Set(["prompt.ts"]);
/** Built-in modules that stay off until the owner turns them on. Drop-ins all do. */
const OFF_BY_DEFAULT = new Set([
    "guard.ts",
    "agent-teams.ts",
    "anthropic-subscription.ts",
    "session-tags.ts",
    "ask-someone.ts",
]);
const TITLES: Record<string, string> = {
    "prompt.ts": "System prompt",
    "artifacts.ts": "Artifacts",
    "browser.ts": "Browser",
    "subagents.ts": "Subagents",
    "agent-teams.ts": "Agent Teams",
    "schedules.ts": "Scheduled messages",
    "background.ts": "Background tasks",
    "goals.ts": "Done when",
    "plan.ts": "Plan mode",
    "anthropic-subscription.ts": "Claude subscription billing",
    "guard.ts": "Lancet Guard",
    "codemode.ts": "Codemode",
    "memory.ts": "Memory",
    "pip.ts": "PiP",
    "triggers.ts": "Triggers",
    "gallery.ts": "Extension gallery",
    "session-tags.ts": "Session tags",
    "ask.ts": "Ask",
    "ask-someone.ts": "Ask someone",
    "updates.ts": "Pi Pocket updates",
    "design.ts": "Design",
    "tool-search.ts": "Tool search",
};

/**
 * Names Pi Pocket keeps for itself, whether the module that uses them is on or off. Installing an extension, or a tool,
 * with a name already taken replaces it in place, so a drop-in that used one would quietly replace a built-in (or be
 * replaced by it when the built-in is turned on), and turning the drop-in off would remove the built-in too.
 */
export const RESERVED_EXTENSIONS = /^(pocket-.*|coding-tools)$/;

/** The tools of Pi Durable's coding tools and of the built-in modules, kept in step with what they install by hand. */
export const BUILT_IN_TOOLS: ReadonlySet<string> = new Set([
    "read",
    "write",
    "edit",
    "bash",
    "artifact",
    "artifact_inline",
    "browser",
    "subagent",
    "team",
    "schedule",
    "background",
    "codemode",
    "tool_search",
    "memory",
    "sessions",
    "session_read",
    "session_start",
    "session_send",
    "session_follow",
    "session_stop",
    "session_archive",
    "session_schedule",
    "approvals",
    "watch_pr",
    "repo_watch",
    "session_watch_pr",
    "ask",
    "ask_someone",
    "design_preview",
    "design_export",
    "design_system",
]);

/** Pi Pocket's own modules, or the owner's from the drop-in folder. */
export type ModuleSource = "built-in" | "drop-in";

export interface ExtensionInfo {
    file: string;
    title: string;
    source: ModuleSource;
    /** Where a drop-in's file is. */
    path?: string;
    /** The first sentence of the module's doc comment. */
    summary: string;
    enabled: boolean;
    required: boolean;
    /**
     * What the module installed: each extension's tools (and which of them say they only read), the hooks' handlers,
     * prompt sections, and the tools and sections it wraps (`tool bash`).
     */
    extensions: {
        name: string;
        tools: string[];
        readOnlyTools: string[];
        hooks: string[];
        sections: string[];
        wraps: string[];
    }[];
    /**
     * What it adds to the app: its routes (`GET status`), who loads its browser module, when it has one, the widest
     * access of the two, its commands (`conversation /name`, `global /name`), and whether it draws pages for anyone with
     * one of its public links.
     */
    web?: {
        routes: string[];
        client?: WebAccess;
        access?: WebAccess;
        commands?: string[];
        publicPage?: boolean;
        service?: boolean;
        settings?: boolean;
    };
    /** Why the module is not loaded, when it failed. */
    error?: string;
}

type Module = { file: string; directory: string; source: ModuleSource };

/** Extension modules in a folder: `.ts` files, except tests and files starting with `_`. A missing folder has none. */
function moduleFiles(directory: string): string[] {
    try {
        return readdirSync(directory).filter(
            (file) => file.endsWith(".ts") && !file.endsWith(".test.ts") && !file.startsWith("_"),
        );
    } catch {
        return [];
    }
}

/**
 * Make the drop-in folder, with a `node_modules` link to Pi Pocket's own packages. Drop-ins then import
 * `@earendil-works/pi-durable` and the rest as built-in modules do, and get the very modules the server runs. A
 * `node_modules` folder the owner made there stays as it is; a link to another place is replaced. Where npm split Pi
 * Pocket's packages between folders (a local install beside other versions of them), `packageModules` says where each
 * is, and the link leads to a hidden folder with a link to each one instead.
 */
export function prepareDropInFolder(
    directory: string,
    appModules: string,
    packageModules: Readonly<Record<string, string>> = {},
): void {
    mkdirSync(directory, { recursive: true });
    // A junction on Windows: no administrator rights needed.
    const type = process.platform === "win32" ? "junction" : "dir";
    let target = appModules;

    // All in one folder, as in a checkout and most installs: one link to it, as before.
    if (Object.values(packageModules).some((modules) => modules !== appModules)) {
        target = join(directory, ".pocket-packages");
        mkdirSync(target, { recursive: true });

        for (const [name, modules] of Object.entries(packageModules)) {
            const link = join(target, name);

            if (existsSync(join(modules, name))) {
                mkdirSync(dirname(link), { recursive: true });
                keepLink(link, join(modules, name), type);
            }
        }
    }

    keepLink(join(directory, "node_modules"), target, type);
}

/** The first line of a copy of the types that Pi Pocket made where it cannot link: it refreshes only such a copy. */
const TYPES_COPY =
    "// A copy of Pi Pocket's types/pocket.d.ts: Pi Pocket refreshes it at each start. Edits here are lost.\n";

/**
 * Link `_pocket.d.ts` in the drop-in folder to Pi Pocket's public types (`types/pocket.d.ts`), so a drop-in imports them
 * from beside it on any machine. Its leading `_` keeps it from loading as a module. A link that leads to a file that can
 * be read stays as it is, wherever it leads (the owner's own checkout, say); a link to nowhere is made again. A file the
 * owner made stays as it is. Where links cannot be made (Windows, or a file system that refuses them with `EPERM`), it
 * is a copy instead, refreshed when the types change.
 */
export function linkTypes(directory: string, types: string): void {
    const link = join(directory, "_pocket.d.ts");
    let found: ReturnType<typeof lstatSync> | undefined;

    try {
        found = lstatSync(link);
    } catch {
        // Missing: made below.
    }

    if (found?.isSymbolicLink() === true) {
        try {
            accessSync(link, constants.R_OK);

            if (statSync(link).isFile()) {
                return;
            }
        } catch {
            // A link to nowhere, or to something unreadable: made again below.
        }

        rmSync(link, { force: true });
    } else if (found !== undefined) {
        if (found.isFile() && readFileSync(link, "utf8").startsWith(TYPES_COPY)) {
            copyTypes(link, types);
        }

        return;
    }

    if (process.platform !== "win32") {
        try {
            symlinkSync(types, link, "file");

            return;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EPERM") {
                throw error;
            }
        }
    }

    copyTypes(link, types);
}

/** Write a copy of the types at `link`, unless it is the same already. */
function copyTypes(link: string, types: string): void {
    const content = TYPES_COPY + readFileSync(types, "utf8");

    try {
        if (readFileSync(link, "utf8") === content) {
            return;
        }
    } catch {
        // Missing: written below.
    }

    writeFileSync(link, content);
}

/** Make `link` lead to `target`, unless it does already, or is a file or folder of its own. */
function keepLink(link: string, target: string, type: "dir" | "file" | "junction"): void {
    let current: string | undefined;

    try {
        if (!lstatSync(link).isSymbolicLink()) {
            return;
        }

        current = realpathSync(link);
    } catch {
        // Missing, or a link to nowhere: made below.
    }

    if (current === realpathSync(target)) {
        return;
    }

    rmSync(link, { force: true });
    symlinkSync(target, link, type);
}

export class ExtensionLoader {
    readonly #registry: Registry;
    readonly #host: PocketHost;
    readonly #builtIn: string;
    readonly #dropIn: string | undefined;
    readonly #choice: (file: string) => boolean | undefined;
    readonly #webs: ExtensionWebs;
    /** Extension names each file installed, to uninstall the ones a new version no longer provides. */
    readonly #installed = new Map<string, Extension[]>();
    readonly #errors = new Map<string, string>();
    readonly #timers = new Map<string, NodeJS.Timeout>();
    /** Drop-ins already reported for having a built-in module's name, so each is reported once. */
    readonly #clashes = new Set<string>();
    readonly #watchers: FSWatcher[] = [];
    readonly #notify: (level: "info" | "warning" | "error", message: string) => void;
    /**
     * Each file's latest load, counted. A load counts only while it is the latest: one that finishes after a newer load
     * started, or after the module was turned off or removed, or after the server began to stop, installs nothing.
     */
    readonly #generations = new Map<string, number>();
    readonly #loadLimitMs: number;
    readonly #stopDocumentImports: () => void;
    /** The folder of each file's latest load: its removal from that folder takes that version away. */
    readonly #sources = new Map<string, string>();
    /** How to end each load still waiting for its module: the server stopping ends them. */
    readonly #waiting = new Set<() => void>();
    #closed = false;

    /**
     * `folders` are where the built-in modules and the owner's drop-ins are. `choice` says whether the owner turned a
     * module on (true) or off (false), or never chose (undefined, so the module's default applies). It is read again
     * on every load. `webs` keeps what modules add to the app. `notify` tells about modules (loaded, failed, removed):
     * the owner's, as a module's errors can name the server's folders or quote what a provider said.
     */
    constructor(
        registry: Registry,
        host: PocketHost,
        folders: { builtIn: string; dropIn?: string },
        choice: (file: string) => boolean | undefined = () => undefined,
        options: {
            webs?: ExtensionWebs;
            notify?: (level: "info" | "warning" | "error", message: string) => void;
            /** How long a load may take; tests make it short. */
            loadLimitMs?: number;
        } = {},
    ) {
        this.#registry = registry;
        this.#host = host;
        this.#builtIn = folders.builtIn;
        this.#dropIn = folders.dropIn;
        this.#choice = choice;
        this.#webs = options.webs ?? new ExtensionWebs();
        this.#notify = options.notify ?? ((level, message) => host.notice(level, message));
        this.#loadLimitMs = options.loadLimitMs ?? LOAD_LIMIT_MS;
        this.#stopDocumentImports =
            this.#dropIn === undefined
                ? () => {}
                : documentImports(this.#dropIn, (message) => this.#notify("warning", message));
    }

    /** Every module, built-in ones first in install order. A drop-in with a built-in's name is left out. */
    #modules(): Module[] {
        const present = moduleFiles(this.#builtIn);
        const builtIn = [
            ...ORDER.filter((file) => present.includes(file)),
            ...present.filter((file) => !ORDER.includes(file)).sort(),
        ];
        const dropIns = this.#dropIn === undefined ? [] : moduleFiles(this.#dropIn).sort();

        return [
            ...builtIn.map((file) => ({
                file,
                directory: this.#builtIn,
                source: "built-in" as const,
            })),
            ...dropIns
                .filter((file) => !builtIn.includes(file))
                .map((file) => ({ file, directory: this.#dropIn!, source: "drop-in" as const })),
        ];
    }

    #module(file: string): Module | undefined {
        return this.#modules().find((module) => module.file === file);
    }

    /** Tell the owner about drop-ins that have a built-in module's name, each once: they are never loaded. */
    #reportClashes(): void {
        if (this.#dropIn === undefined) {
            return;
        }

        const builtIn = moduleFiles(this.#builtIn);

        for (const file of moduleFiles(this.#dropIn)) {
            if (!builtIn.includes(file) || this.#clashes.has(file)) {
                continue;
            }

            this.#clashes.add(file);
            this.#notify(
                "warning",
                `The drop-in extension ${file} has the name of a built-in one and is not loaded. Rename it.`,
            );
        }
    }

    #isOn(module: Module): boolean {
        return (
            REQUIRED.has(module.file) ||
            (this.#choice(module.file) ??
                (module.source === "built-in" && !OFF_BY_DEFAULT.has(module.file)))
        );
    }

    enabled(file: string): boolean {
        const module = this.#module(file);

        return module !== undefined && this.#isOn(module);
    }

    files(): string[] {
        return this.#modules().map((module) => module.file);
    }

    /** Load every module that is on. A module that fails to load at startup is reported and skipped. */
    async loadAll(): Promise<void> {
        this.#reportClashes();

        // One limit for them all: modules that hang cannot each hold up the start by the whole of it.
        const spent = Date.now() + this.#loadLimitMs;

        for (const module of this.#modules()) {
            // The server stopping during its start: the modules not loaded yet stay so.
            if (this.#closed) {
                return;
            }

            if (!this.#isOn(module)) {
                continue;
            }

            try {
                await this.#load(
                    module.file,
                    false,
                    Math.max(spent, Date.now() + this.#loadLimitMs / 15),
                );
            } catch (error) {
                if (error instanceof Overtaken) {
                    continue;
                }

                this.#errors.set(module.file, describe(error));
                this.#notify(
                    "error",
                    `Extension ${module.file} failed to load: ${describe(error)}`,
                );
            }
        }
    }

    /**
     * Install a module that was turned on, or uninstall one that was turned off (after `choice` already says so).
     * Throws when a module that was turned on fails to load; it stays on, and the error shows in `list()`.
     */
    async apply(file: string): Promise<void> {
        if (!this.files().includes(file)) {
            throw new Error(`There is no extension module ${file}`);
        }

        if (this.enabled(file)) {
            await this.reload(file);

            return;
        }

        this.#uninstall(file);
    }

    #uninstall(file: string): void {
        // A load still running for it installs nothing.
        this.#generation(file);
        this.#sources.delete(file);

        for (const extension of this.#installed.get(file) ?? []) {
            try {
                this.#registry.uninstall(extension);
            } catch (error) {
                // A listener that threw: the registry changed all the same. What the module added to the app goes too.
                this.#notify(
                    "warning",
                    `Uninstalling the extension ${extension.name} reported: ${describe(error)}`,
                );
            }
        }

        this.#webs.remove(file);
        this.#installed.delete(file);
        this.#errors.delete(file);
    }

    /**
     * Import a module again and install what it builds. When a newer load (or turning the module off) overtakes this
     * one, it installs nothing and answers what is installed: the newer one reports for itself.
     */
    async reload(file: string): Promise<Extension[]> {
        return (await this.#reload(file)) ?? this.#installed.get(file) ?? [];
    }

    /** `reload`, answering nothing when a newer load overtook this one. */
    async #reload(file: string): Promise<Extension[] | undefined> {
        try {
            return await this.#load(file, true);
        } catch (error) {
            if (error instanceof Overtaken) {
                return undefined;
            }

            this.#errors.set(file, describe(error));

            throw error;
        }
    }

    /** Start a file's next load, or end the one running: the number of the load that counts from now. */
    #generation(file: string): number {
        const next = (this.#generations.get(file) ?? 0) + 1;

        this.#generations.set(file, next);

        return next;
    }

    /** Whether a load still counts: no newer load started, the module was not turned off or removed, the server runs. */
    #isLatest(file: string, generation: number): boolean {
        return !this.#closed && this.#generations.get(file) === generation;
    }

    /** Throw when a load no longer counts. */
    #stillLatest(file: string, generation: number): void {
        if (!this.#isLatest(file, generation)) {
            throw new Overtaken(file);
        }
    }

    list(): ExtensionInfo[] {
        return this.#modules().map((module) => {
            const { file } = module;
            const error = this.#errors.get(file);
            const web = this.#webs.describe(file);

            return {
                file,
                title: titleOf(file),
                source: module.source,
                ...(module.source === "drop-in" ? { path: join(module.directory, file) } : {}),
                summary: summary(join(module.directory, file)),
                enabled: this.#isOn(module),
                required: REQUIRED.has(file),
                extensions: (this.#installed.get(file) ?? []).map(declared),
                ...(web === undefined ? {} : { web }),
                ...(error === undefined ? {} : { error }),
            };
        });
    }

    extensionNames(): string[] {
        return [...this.#installed.values()].flat().map((extension) => extension.name);
    }

    async #load(file: string, cacheBust: boolean, until?: number): Promise<Extension[]> {
        const module = this.#module(file);

        if (module === undefined) {
            throw new Error(`There is no extension module ${file}`);
        }

        // Nothing loads once the server stops, and a module that is off never runs: the name may lead to the other
        // folder's module by now (a built-in removed while the server starts leaves its drop-in), whose choice counts.
        if (this.#closed || !this.#isOn(module)) {
            throw new Overtaken(file);
        }

        const generation = this.#generation(file);
        // Its own limit, or less when the server's start has spent the shared one.
        const deadline = Math.min(Date.now() + this.#loadLimitMs, until ?? Infinity);

        this.#sources.set(file, module.directory);

        try {
            return await this.#build(module, generation, cacheBust, deadline);
        } catch (error) {
            // A load that no longer counts fails quietly too: the newer load, or the module turned off, says what holds.
            if (!(error instanceof Overtaken) && !this.#isLatest(file, generation)) {
                throw new Overtaken(file);
            }

            throw error;
        }
    }

    async #build(
        module: Module,
        generation: number,
        cacheBust: boolean,
        deadline: number,
    ): Promise<Extension[]> {
        const { file } = module;
        // A load waits for the module (its import, and an async default export), but not forever: one that never settles
        // would hold up the server's start, and every load after it.
        const url =
            pathToFileURL(join(module.directory, file)).href +
            // Each load its own address, or a second load in the same millisecond would get the first one's module.
            (cacheBust ? `?v=${Date.now()}-${++imports}` : "");
        const loaded = (await this.#within(import(url), deadline, file)) as ExtensionModule;

        // The import can take a while (a module may wait at its top level): the module may be off by now, or edited.
        this.#stillLatest(file, generation);

        if (typeof loaded.default !== "function") {
            throw new Error("the module has no default export function");
        }

        const needs = loaded.pocketApi;

        if (typeof needs === "number" && Number.isInteger(needs) && needs < OLDEST_POCKET_API) {
            throw new Error(
                `the module was written for version ${String(needs)} of Pi Pocket's extension API, and this Pi Pocket loads ${OLDEST_POCKET_API} to ${POCKET_API}: update the module`,
            );
        }

        if (
            needs !== undefined &&
            (typeof needs !== "number" || !Number.isInteger(needs) || !(needs <= POCKET_API))
        ) {
            throw new Error(
                `the module needs version ${String(needs)} of Pi Pocket's extension API, and this Pi Pocket has ${POCKET_API}: update Pi Pocket`,
            );
        }

        // What it adds to the app counts only once it installed; a version that fails leaves the one before in place,
        // and what it set up (its cleanups) goes. The new version starts before the old one's cleanups run.
        const { part, web } = this.#webs.stage(file, module.directory, titleOf(file));
        let committed = false;

        try {
            const returned = loaded.default(this.#host, web) as unknown;
            // An async default export: it may register until it settles.
            const built = isThenable(returned)
                ? await this.#within(Promise.resolve(returned), deadline, file)
                : returned;

            this.#stillLatest(file, generation);

            const extensions = (
                built === undefined || built === null ? [] : Array.isArray(built) ? built : [built]
            ) as Extension[];

            // A default export that forgot to return its extensions would load as nothing at all.
            if (
                (built === undefined || built === null) &&
                part.empty &&
                part.disposers.length === 0
            ) {
                throw new Error(
                    "the module returned no extensions and added nothing to the app: return its extensions",
                );
            }

            const names = extensions.map((extension) => extension?.name);

            if (names.some((name) => typeof name !== "string" || name === "")) {
                throw new Error("the module returns an extension without a name");
            }

            const twice = names.find((name, index) => names.indexOf(name) !== index);

            if (twice !== undefined) {
                throw new Error(`the module returns two extensions named ${twice}`);
            }

            if (module.source === "drop-in") {
                this.#checkNames(file, extensions);
            }

            // A new array, so that one the module froze or keeps is not changed.
            const installed =
                module.source === "drop-in" ? extensions.map(keepsContent) : extensions;

            this.#webs.check(part);
            this.#replace(installed, this.#installed.get(file) ?? []);
            this.#installed.set(file, installed);
            this.#errors.delete(file);
            this.#webs.commit(
                part,
                installed.flatMap((extension) => declared(extension).tools),
            );
            committed = true;

            return installed;
        } finally {
            if (!committed) {
                this.#webs.discard(part);
            }
        }
    }

    /**
     * `promise`, or a failure once `deadline` passed. The load then has failed, whatever the module does later: what it
     * staged is discarded, and what it would return is never installed.
     */
    async #within<T>(promise: Promise<T>, deadline: number, file: string): Promise<T> {
        let timer: NodeJS.Timeout | undefined;

        let stop = () => {};

        const late = new Promise<never>((_resolve, reject) => {
            // The server stopping: the load ends now, as one that no longer counts.
            stop = () => reject(new Overtaken(file));
            timer = setTimeout(
                () => {
                    reject(
                        new Error(
                            `it did not finish loading in time (${this.#loadLimitMs / 1000} s at most, less at the server's start): a module must not wait for long while it loads`,
                        ),
                    );
                },
                Math.max(0, deadline - Date.now()),
            );
        });

        this.#waiting.add(stop);

        // The server stopped before this load began to wait: it ends now too.
        if (this.#closed) {
            stop();
        }

        try {
            return await Promise.race([promise, late]);
        } finally {
            clearTimeout(timer);
            this.#waiting.delete(stop);
        }
    }

    /**
     * Put a version's extensions in place of the previous version's, all or none: when the registry refuses one, or a
     * listener of it throws, the registry is put back as it was before, every extension in its place.
     */
    #replace(extensions: readonly Extension[], previous: readonly Extension[]): void {
        const before = this.#registry.snapshot().installed();

        try {
            for (const extension of extensions) {
                this.#registry.install(extension);
            }

            for (const old of previous) {
                if (!extensions.some((extension) => extension.name === old.name)) {
                    this.#registry.uninstall(old);
                }
            }
        } catch (error) {
            this.#restore(before);

            throw error;
        }
    }

    /**
     * Make the registry hold `before` again, in its order: from the first place it differs, take out what is there
     * (last first), then put back what was (in order). Taking out first frees what the extensions own (a task's name),
     * so putting them back meets no clash.
     */
    #restore(before: readonly Extension[]): void {
        const now = () => this.#registry.snapshot().installed();

        // A listener that throws once the registry changed: what counts is what it holds after.
        const quietly = (change: () => void) => {
            try {
                change();
            } catch {
                // Checked below.
            }
        };

        const current = now();
        let from = 0;

        while (from < before.length && current[from] === before[from]) {
            from++;
        }

        for (const extension of current.slice(from).reverse()) {
            quietly(() => this.#registry.uninstall(extension));
        }

        for (const extension of before.slice(from)) {
            quietly(() => this.#registry.install(extension));
        }

        const after = now();

        if (after.length !== before.length || after.some((each, at) => each !== before[at])) {
            this.#notify(
                "error",
                "Could not put the extensions back as they were: restart the server to load them again",
            );
        }
    }

    /**
     * Refuse a drop-in that would take a name Pi Pocket keeps, or one another module installed: installing it would
     * replace that one. Throws before anything is installed, so a version that loaded before keeps running.
     */
    #checkNames(file: string, extensions: readonly Extension[]): void {
        const owners = new Map<string, string>();
        const tools = new Map<string, string>();

        for (const [other, installed] of this.#installed) {
            if (other === file) {
                continue;
            }

            for (const extension of installed) {
                owners.set(extension.name, other);

                for (const tool of extension.tools ?? []) {
                    tools.set(tool.name, other);
                }
            }
        }

        for (const extension of extensions) {
            if (RESERVED_EXTENSIONS.test(extension.name)) {
                throw new Error(
                    `the extension name ${extension.name} is Pi Pocket's own: give it a name of your own`,
                );
            }

            if (owners.has(extension.name)) {
                throw new Error(
                    `${owners.get(extension.name)} already installs an extension named ${extension.name}: give it a name of your own`,
                );
            }

            for (const tool of extension.tools ?? []) {
                if (BUILT_IN_TOOLS.has(tool.name)) {
                    throw new Error(
                        `the tool name ${tool.name} is a built-in tool's: give it a name of your own`,
                    );
                }

                if (tools.has(tool.name)) {
                    throw new Error(
                        `${tools.get(tool.name)} already has a tool named ${tool.name}: give it a name of your own`,
                    );
                }
            }
        }
    }

    /** While an update moves the checkout, edits load nothing: the restart after it loads the new version. */
    #paused = false;

    /** Stop or start loading modules again when they change, as `watch` does (`updates.ts`). */
    pause(paused: boolean): void {
        this.#paused = paused;
        this.#webs.pause(paused);

        if (paused) {
            for (const timer of this.#timers.values()) {
                clearTimeout(timer);
            }

            this.#timers.clear();
        }
    }

    /** Watch both folders and reload a module shortly after it changes. Keeps the old code when the new one fails. */
    watch(): void {
        this.#webs.watch();

        for (const directory of [this.#builtIn, this.#dropIn]) {
            if (directory === undefined) {
                continue;
            }

            try {
                this.#watchers.push(
                    watch(
                        directory,
                        (_event, name) =>
                            name !== null && this.#changed(basename(name.toString()), directory),
                    ),
                );
            } catch (error) {
                this.#notify(
                    "warning",
                    `Extensions in ${directory} are not reloaded when edited: ${describe(error)}`,
                );
            }
        }
    }

    #changed(file: string, directory: string): void {
        if (this.#paused) {
            return;
        }

        // A browser module's file, or its folder: tabs load the new version.
        this.#webs.touched(directory, file);

        if (!file.endsWith(".ts") || file.endsWith(".test.ts") || file.startsWith("_")) {
            return;
        }

        if (directory === this.#dropIn) {
            this.#reportClashes();
        }

        // A moment later, for an edit and a removal alike: an editor that saves by writing a new file and renaming it
        // over the old one removes the file for an instant, and that is no removal. One wait for each file in each
        // folder: a built-in's edit and a drop-in's of the same name do not share one.
        const key = `${directory}\0${file}`;

        clearTimeout(this.#timers.get(key));
        this.#timers.set(
            key,
            setTimeout(() => {
                this.#timers.delete(key);
                this.#settle(file, directory);
            }, 300),
        );
    }

    /** After a module's file changed: take away a drop-in that is gone, or load the new version of one that is on. */
    #settle(file: string, directory: string): void {
        const module = this.#module(file);

        // Gone from the folder its version came from (or from both folders): that version goes, and a load of it still
        // running (its first, say) installs nothing. A module of that name in the other folder is not loaded by this.
        if (
            !existsSync(join(directory, file)) &&
            (module === undefined || this.#sources.get(file) === directory)
        ) {
            const installed = this.#installed.has(file);

            this.#uninstall(file);

            if (installed) {
                this.#notify(
                    "info",
                    directory === this.#dropIn
                        ? `Removed the drop-in extension ${file}.`
                        : `Removed the extension module ${file}.`,
                );
            }

            return;
        }

        // A module that is off stays off when its file is edited; turning it on loads the new code.
        if (module?.directory !== directory || !this.enabled(file)) {
            return;
        }

        const loaded = this.#installed.has(file);

        this.#reload(file).then(
            (extensions) => {
                if (extensions !== undefined) {
                    this.#notify(
                        "info",
                        `Reloaded ${file}: ${extensions.map((extension) => extension.name).join(", ") || "it adds to the app"}`,
                    );
                }
            },
            (error: unknown) =>
                this.#notify(
                    "error",
                    loaded
                        ? `Kept the previous ${file}; the edited one failed to load: ${describe(error)}`
                        : `${file} failed to load: ${describe(error)}`,
                ),
        );
    }

    /** Stop watching, and run every module's cleanups: settles once they finished, the ones that wait included. */
    close(): Promise<void> {
        // Loads still running install nothing, and those waiting for their module end now.
        this.#closed = true;
        this.#stopDocumentImports();

        for (const stop of this.#waiting) {
            stop();
        }

        for (const watcher of this.#watchers) {
            watcher.close();
        }

        for (const timer of this.#timers.values()) {
            clearTimeout(timer);
        }

        return this.#webs.close();
    }
}

/** A load that a newer one, or turning the module off, overtook: it installs nothing, and is no failure. */
class Overtaken extends Error {
    constructor(file: string) {
        super(`a newer load of ${file} replaced this one`);
    }
}

/**
 * Pi Durable 1.2 renamed a tool result's `content` to `output`. A drop-in written before still returns `content`, and
 * would give the model nothing: read it as `output`, so those modules keep working.
 */
function keepsContent(extension: Extension): Extension {
    if (extension.tools === undefined) {
        return extension;
    }

    const tools = extension.tools.map((tool) =>
        withValues(tool, {
            execute: async (...args: Parameters<typeof tool.execute>) => {
                const result = await tool.execute(...args);

                if (typeof result !== "object" || result === null) {
                    return result;
                }

                const { content, ...rest } = result as typeof result & { content?: unknown };

                return content === undefined || result.output !== undefined
                    ? result
                    : ({ ...rest, output: content } as typeof result);
            },
        }),
    );

    return withValues(extension, { tools });
}

/** A copy of `object` with these values replaced: its prototype, getters, and other properties stay as they were. */
function withValues<T extends object>(object: T, values: Partial<T>): T {
    return Object.create(Object.getPrototypeOf(object), {
        ...Object.getOwnPropertyDescriptors(object),
        ...Object.fromEntries(
            Object.entries(values).map(([key, value]) => [
                key,
                { value, enumerable: true, writable: true, configurable: true },
            ]),
        ),
    }) as T;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
    return (
        typeof value === "object" &&
        value !== null &&
        typeof (value as { then?: unknown }).then === "function"
    );
}

/** What an extension installs, by name: what the Extensions sheet and the gallery's index say it does. */
function declared(extension: Extension): ExtensionInfo["extensions"][number] {
    const tools = extension.tools ?? [];

    return {
        name: extension.name,
        tools: tools.map((tool) => tool.name),
        readOnlyTools: tools
            .filter(
                (tool) =>
                    (tool as { annotations?: { readOnlyHint?: unknown } }).annotations
                        ?.readOnlyHint === true,
            )
            .map((tool) => tool.name),
        hooks: [...new Set((extension.hooks ?? []).flatMap((each) => Object.keys(each.handlers)))],
        sections: (extension.sections ?? []).map((each) => each.key),
        wraps: (extension.wraps ?? []).map((each) =>
            "tool" in each ? `tool ${each.tool}` : `section ${each.section}`,
        ),
    };
}

/** A module's title in the Extensions sheet: a built-in's own, or a drop-in's file name. */
function titleOf(file: string): string {
    return TITLES[file] ?? file.replace(/\.ts$/, "");
}

/** The first sentence of a module's doc comment: its description in the Extensions sheet. */
function summary(path: string): string {
    try {
        const comment = /^\s*\/\*\*([\s\S]*?)\*\//.exec(readFileSync(path, "utf8"))?.[1] ?? "";
        const text = comment
            .replace(/^\s*\* ?/gm, "")
            .replace(/\s+/g, " ")
            .trim();

        return /^(.*?[.!?])(\s|$)/.exec(text)?.[1] ?? text;
    } catch {
        return "";
    }
}

/** Calls `onChange` shortly after anything under `directory` changes. */
export function watchTree(directory: string, onChange: (file: string) => void): () => void {
    let timer: NodeJS.Timeout | undefined;
    let last = "";
    const watcher = watch(directory, { recursive: true }, (_event, name) => {
        last = name?.toString() ?? "";
        clearTimeout(timer);
        timer = setTimeout(() => onChange(last), 200);
    });

    return () => {
        clearTimeout(timer);
        watcher.close();
    };
}
