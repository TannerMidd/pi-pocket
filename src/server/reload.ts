/**
 * Live editing. Extension modules are imported again when they change and installed under the same names, which
 * replaces them in one step: a tool call already running finishes on the old code, the next one uses the new code.
 * Web files only need the browsers to reload.
 *
 * Modules come from two folders: Pi Pocket's own (`src/server/extensions/`), and the owner's drop-ins
 * (`extensions/` in the data folder), which load after them and stay off until the owner turns them on. The owner
 * can turn modules off and on from the app. A module that is off is not loaded, and turning one off uninstalls what
 * it installed; a tool call already running still finishes.
 */
import { randomUUID } from "node:crypto";
import {
    type FSWatcher,
    existsSync,
    lstatSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    symlinkSync,
    watch,
} from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Extension, Registry } from "@earendil-works/pi-durable";
import { describe } from "./errors.ts";
import type { CommandInfo, ExtensionCommand, ExtensionModule, PocketHost } from "./host.ts";

/** Built-in extension modules, in install order. Other `.ts` files in the directory load after them, by name. */
const ORDER = [
    "prompt.ts",
    "artifacts.ts",
    "browser.ts",
    "subagents.ts",
    "schedules.ts",
    "goals.ts",
    "plan.ts",
    "guard.ts",
    "codemode.ts",
];
/** Modules the app cannot work without: always on. */
const REQUIRED = new Set(["prompt.ts"]);
/** Built-in modules that stay off until the owner turns them on. Drop-ins all do. */
const OFF_BY_DEFAULT = new Set(["guard.ts"]);
const TITLES: Record<string, string> = {
    "prompt.ts": "System prompt",
    "artifacts.ts": "Artifacts",
    "browser.ts": "Browser",
    "subagents.ts": "Subagents",
    "schedules.ts": "Scheduled messages",
    "goals.ts": "Done when",
    "plan.ts": "Plan mode",
    "guard.ts": "Lancet Guard",
    "codemode.ts": "Codemode",
};

/**
 * Names Pi Pocket keeps for itself, whether the module that uses them is on or off. Installing an extension, or a tool,
 * with a name already taken replaces it in place, so a drop-in that used one would quietly replace a built-in (or be
 * replaced by it when the built-in is turned on), and turning the drop-in off would remove the built-in too.
 */
const RESERVED_EXTENSIONS = /^(pocket-.*|coding-tools)$/;

/** The tools of Pi Durable's coding tools and of the built-in modules. A test checks it against what they install. */
export const BUILT_IN_TOOLS: ReadonlySet<string> = new Set([
    "read",
    "write",
    "edit",
    "bash",
    "artifact",
    "browser",
    "subagent",
    "schedule",
    "codemode",
]);

/** Composer commands a module may not replace, whether currently available or not. */
export const BUILT_IN_COMMANDS: ReadonlySet<string> = new Set([
    "compact",
    "reset",
    "instructions",
    "model",
    "thinking",
    "new",
    "name",
    "cwd",
    "plan",
    "schedule",
    "until",
    "stop",
    "copy",
    "find",
    "session",
    "export",
    "resume",
    "chat",
    "browser",
    "files",
    "changes",
    "branch",
    "peek",
    "artifacts",
    "login",
    "settings",
    "theme",
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
    /** What the module installed, with the tools each extension provides. */
    extensions: { name: string; tools: string[] }[];
    /** Why the module is not loaded, when it failed. */
    error?: string;
}

type Module = { file: string; directory: string; source: ModuleSource };

export type RegisteredCommand = CommandInfo & Pick<ExtensionCommand, "handler">;

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
 * `node_modules` folder the owner made there stays as it is; a link to another place is replaced.
 */
export function prepareDropInFolder(directory: string, appModules: string): void {
    mkdirSync(directory, { recursive: true });
    const link = join(directory, "node_modules");
    let current: string | undefined;

    try {
        if (!lstatSync(link).isSymbolicLink()) {
            return;
        }

        current = realpathSync(link);
    } catch {
        // Missing, or a link to nowhere: made below.
    }

    if (current === realpathSync(appModules)) {
        return;
    }

    rmSync(link, { force: true });
    // A junction on Windows: no administrator rights needed.
    symlinkSync(appModules, link, process.platform === "win32" ? "junction" : "dir");
}

type LoadVersion = { id: string; module: Module | undefined };

export class ExtensionLoader {
    readonly #registry: Registry;
    readonly #host: Omit<PocketHost, "commands">;
    readonly #builtIn: string;
    readonly #dropIn: string | undefined;
    readonly #choice: (file: string) => boolean | undefined;
    /** Installed extensions and their source: deleting an ignored drop-in must not unload a built-in. */
    readonly #installed = new Map<string, { module: Module; extensions: Extension[] }>();
    readonly #commands = new Map<string, RegisteredCommand[]>();
    readonly #loading = new Map<string, LoadVersion>();
    readonly #commandsChanged: () => Promise<void>;
    readonly #errors = new Map<string, string>();
    readonly #timers = new Map<string, NodeJS.Timeout>();
    /** Drop-ins already reported for having a built-in module's name, so each is reported once. */
    readonly #clashes = new Set<string>();
    readonly #watchers: FSWatcher[] = [];

    /**
     * `folders` are where the built-in modules and the owner's drop-ins are. `choice` says whether the owner turned a
     * module on (true) or off (false), or never chose (undefined, so the module's default applies). It is read again
     * on every load.
     */
    constructor(
        registry: Registry,
        host: Omit<PocketHost, "commands">,
        folders: { builtIn: string; dropIn?: string },
        choice: (file: string) => boolean | undefined = () => undefined,
        commandsChanged: () => Promise<void> = () => Promise.resolve(),
    ) {
        this.#registry = registry;
        this.#host = host;
        this.#builtIn = folders.builtIn;
        this.#dropIn = folders.dropIn;
        this.#choice = choice;
        this.#commandsChanged = commandsChanged;
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
            this.#host.notice(
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

        for (const module of this.#modules()) {
            if (!this.#isOn(module)) {
                continue;
            }

            try {
                await this.#load(module.file, false);
            } catch (error) {
                this.#host.notice(
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

        await this.#uninstall(file);
    }

    async #uninstall(file: string, directory?: string): Promise<void> {
        if (directory === undefined || this.#loading.get(file)?.module?.directory === directory) {
            this.#loading.delete(file);
        }

        const installed = this.#installed.get(file);

        if (directory !== undefined && installed?.module.directory !== directory) {
            return;
        }

        for (const extension of installed?.extensions ?? []) {
            this.#registry.uninstall(extension);
        }

        const hadCommands = (this.#commands.get(file)?.length ?? 0) > 0;

        this.#installed.delete(file);
        this.#commands.delete(file);
        this.#errors.delete(file);

        if (hadCommands) {
            await this.#commandsChanged();
        }
    }

    /** Import a module again and install what it builds. */
    reload(file: string): Promise<Extension[]> {
        return this.#load(file, true);
    }

    list(): ExtensionInfo[] {
        return this.#modules().map((module) => {
            const { file } = module;
            const error = this.#errors.get(file);

            return {
                file,
                title: TITLES[file] ?? file.replace(/\.ts$/, ""),
                source: module.source,
                ...(module.source === "drop-in" ? { path: join(module.directory, file) } : {}),
                summary: summary(join(module.directory, file)),
                enabled: this.#isOn(module),
                required: REQUIRED.has(file),
                extensions: (this.#installed.get(file)?.extensions ?? []).map((extension) => ({
                    name: extension.name,
                    tools: (extension.tools ?? []).map((tool) => tool.name),
                })),
                ...(error === undefined ? {} : { error }),
            };
        });
    }

    extensionNames(): string[] {
        return [...this.#installed.values()]
            .flatMap((installed) => installed.extensions)
            .map((extension) => extension.name);
    }

    /** Commands offered by the modules that loaded, without their server-side handlers. */
    commands(): CommandInfo[] {
        return [...this.#commands.values()].flat().map(({ handler: _handler, ...info }) => info);
    }

    /** Resolve one exact registration, rather than running a different module after a stale browser choice. */
    command(id: string): RegisteredCommand | undefined {
        return [...this.#commands.values()].flat().find((command) => command.id === id);
    }

    async #load(file: string, cacheBust: boolean): Promise<Extension[]> {
        const version = { id: randomUUID(), module: this.#module(file) };

        this.#loading.set(file, version);

        try {
            return await this.#build(file, cacheBust, version);
        } catch (error) {
            if (
                this.#loading.get(file) === version &&
                this.#module(file)?.directory === version.module?.directory
            ) {
                this.#errors.set(file, describe(error));
            }

            throw error;
        } finally {
            if (this.#loading.get(file) === version) {
                this.#loading.delete(file);
            }
        }
    }

    async #build(file: string, cacheBust: boolean, version: LoadVersion): Promise<Extension[]> {
        const module = version.module;

        if (module === undefined) {
            throw new Error(`There is no extension module ${file}`);
        }

        if (!this.#isOn(module)) {
            return [];
        }

        const url =
            pathToFileURL(join(module.directory, file)).href +
            (cacheBust ? `?v=${version.id}` : "");
        const loaded = (await import(url)) as ExtensionModule;
        const current = this.#module(file);

        // Import can await other work. An intervening reload, disable, removal, or close wins over this one.
        if (
            this.#loading.get(file) !== version ||
            current === undefined ||
            current.directory !== module.directory ||
            !this.#isOn(current)
        ) {
            return [];
        }

        if (typeof loaded.default !== "function") {
            throw new Error("the module has no default export function");
        }

        const commands: RegisteredCommand[] = [];
        let collecting = true;
        let built: ReturnType<ExtensionModule["default"]>;

        try {
            built = loaded.default({
                ...this.#host,
                commands: {
                    register: (command) => {
                        if (!collecting) {
                            throw new Error(
                                "Register commands while the module builds its extensions, not afterwards.",
                            );
                        }

                        if (command === null || typeof command !== "object") {
                            throw new Error(
                                "A command must have a name, description, scope, and handler.",
                            );
                        }

                        const { name, description, scope, args, handler } = command;

                        if (typeof name !== "string" || !/^[a-z][a-z0-9_-]*$/.test(name)) {
                            throw new Error(
                                "A command name must start with a lowercase letter and use lowercase letters, digits, hyphens, or underscores.",
                            );
                        }

                        if (typeof description !== "string" || description.trim() === "") {
                            throw new Error(`The command ${name} needs a description.`);
                        }

                        if (scope !== "conversation" && scope !== "global") {
                            throw new Error(
                                `The command ${name} needs conversation or global scope.`,
                            );
                        }

                        if (args !== undefined && typeof args !== "string") {
                            throw new Error(`The command ${name} args must be a text hint.`);
                        }

                        if (typeof handler !== "function") {
                            throw new Error(`The command ${name} needs a handler.`);
                        }

                        if (BUILT_IN_COMMANDS.has(name)) {
                            throw new Error(
                                `The command ${name} is a built-in command: give it a name of your own.`,
                            );
                        }

                        const other = this.commands().find(
                            (each) => each.file !== file && each.name === name,
                        );

                        if (other !== undefined || commands.some((each) => each.name === name)) {
                            throw new Error(
                                `${other?.file ?? file} already has a command named ${name}.`,
                            );
                        }

                        commands.push({
                            id: randomUUID(),
                            file,
                            name,
                            description,
                            scope,
                            handler,
                            ...(args === undefined ? {} : { args }),
                        });
                    },
                },
            });
        } finally {
            collecting = false;
        }

        const extensions = (Array.isArray(built) ? built : [built]) as Extension[];

        if (module.source === "drop-in") {
            this.#checkNames(file, extensions);
        }

        const previous = this.#installed.get(file)?.extensions ?? [];

        for (const extension of extensions) {
            this.#registry.install(extension);
        }

        for (const old of previous) {
            if (!extensions.some((extension) => extension.name === old.name)) {
                this.#registry.uninstall(old);
            }
        }

        const commandsChanged = commands.length > 0 || (this.#commands.get(file)?.length ?? 0) > 0;

        this.#installed.set(file, { module, extensions });
        this.#commands.set(file, commands);
        this.#errors.delete(file);

        if (commandsChanged) {
            await this.#commandsChanged();
        }

        return extensions;
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

            for (const extension of installed.extensions) {
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

    /** Watch both folders and reload a module shortly after it changes. Keeps the old code when the new one fails. */
    watch(): void {
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
                this.#host.notice(
                    "warning",
                    `Extensions in ${directory} are not reloaded when edited: ${describe(error)}`,
                );
            }
        }
    }

    #changed(file: string, directory: string): void {
        if (!file.endsWith(".ts") || file.endsWith(".test.ts") || file.startsWith("_")) {
            return;
        }

        if (directory === this.#dropIn) {
            this.#reportClashes();
        }

        const module = this.#module(file);

        // Removal belongs to the directory that installed or is importing the module, not just its basename.
        if (
            !existsSync(join(directory, file)) &&
            (this.#installed.get(file)?.module.directory === directory ||
                this.#loading.get(file)?.module?.directory === directory)
        ) {
            void this.#uninstall(file, directory).then(
                () =>
                    this.#host.notice(
                        "info",
                        `Removed the ${directory === this.#builtIn ? "built-in" : "drop-in"} extension ${file}.`,
                    ),
                (error: unknown) => this.#host.notice("warning", describe(error)),
            );

            return;
        }

        // A module that is off stays off when its file is edited; turning it on loads the new code.
        if (module?.directory !== directory || !this.enabled(file)) {
            return;
        }

        clearTimeout(this.#timers.get(file));
        this.#timers.set(
            file,
            setTimeout(() => {
                this.#timers.delete(file);
                const current = this.#module(file);

                if (
                    current === undefined ||
                    current.directory !== directory ||
                    !this.#isOn(current)
                ) {
                    return;
                }

                const loaded = this.#installed.has(file);

                this.reload(file).then(
                    (extensions) =>
                        this.#host.notice(
                            "info",
                            `Reloaded ${file}: ${extensions.map((extension) => extension.name).join(", ")}`,
                        ),
                    (error: unknown) =>
                        this.#host.notice(
                            "error",
                            loaded
                                ? `Kept the previous ${file}; the edited one failed to load: ${describe(error)}`
                                : `${file} failed to load: ${describe(error)}`,
                        ),
                );
            }, 300),
        );
    }

    close(): void {
        this.#loading.clear();

        for (const watcher of this.#watchers) {
            watcher.close();
        }

        for (const timer of this.#timers.values()) {
            clearTimeout(timer);
        }
    }
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
