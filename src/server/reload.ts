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
import {
    type FSWatcher,
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
import { createRegistry, type Registry } from "@earendil-works/pi-durable";
import { describe } from "./errors.ts";
import type { ExtensionModule, PocketExtension, PocketHost, PocketUiLocale } from "./host.ts";

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

const MAX_UI_LOCALES = 16;
const MAX_UI_ENTRIES = 5000;
const MAX_UI_BYTES = 512 * 1024;
const UI_LOCALE_FIELDS = new Set(["locale", "label", "default", "strings", "templates"]);

function plainRecord(value: unknown): value is Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return false;
    }

    const prototype = Object.getPrototypeOf(value);

    return prototype === Object.prototype || prototype === null;
}

/** Read enumerable own data properties without invoking accessors. */
function dataProperties(
    value: Record<string, unknown>,
    file: string,
    field: string,
    allowed?: ReadonlySet<string>,
): Map<string, unknown> {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result = new Map<string, unknown>();

    for (const key of Reflect.ownKeys(descriptors)) {
        if (typeof key !== "string" || (allowed !== undefined && !allowed.has(key))) {
            throw new Error(`${file} UI locale ${field} has an unknown field`);
        }

        const descriptor = descriptors[key]!;

        if (!descriptor.enumerable || !("value" in descriptor)) {
            throw new Error(
                `${file} UI locale ${field} must contain only enumerable data properties`,
            );
        }

        result.set(key, descriptor.value);
    }

    return result;
}

function checkedArray(value: unknown, file: string, field: string, limit: number): unknown[] {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
        throw new Error(`${file} UI locale ${field} must be a plain array`);
    }

    const descriptors: Record<string, PropertyDescriptor> = Object.getOwnPropertyDescriptors(value);
    const lengthDescriptor = descriptors.length;
    const length = lengthDescriptor?.value;

    if (
        lengthDescriptor === undefined ||
        !("value" in lengthDescriptor) ||
        !Number.isSafeInteger(length) ||
        length < 0 ||
        length > limit
    ) {
        throw new Error(`${file} UI locale ${field} has too many entries`);
    }

    if (Reflect.ownKeys(descriptors).length !== length + 1) {
        throw new Error(`${file} UI locale ${field} must be a dense array without extra fields`);
    }

    const result: unknown[] = [];

    for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];

        if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
            throw new Error(`${file} UI locale ${field} must be a dense array of data values`);
        }

        result.push(descriptor.value);
    }

    return result;
}

function checkedStrings(
    value: unknown,
    file: string,
    field: string,
): Readonly<Record<string, string>> {
    if (!plainRecord(value)) {
        throw new Error(`${file} UI locale ${field} must be a plain object of strings`);
    }

    const entries = dataProperties(value, file, field);

    if (entries.size > MAX_UI_ENTRIES) {
        throw new Error(`${file} UI locale ${field} has too many entries`);
    }

    const result: Record<string, string> = Object.create(null);
    let bytes = 0;

    for (const [key, text] of entries) {
        if (typeof text !== "string") {
            throw new Error(`${file} UI locale ${field} values must be plain strings`);
        }

        if (key.length === 0 || key.length > 1000 || text.length > 4000) {
            throw new Error(`${file} UI locale ${field} contains an entry that is too long`);
        }

        bytes += Buffer.byteLength(key) + Buffer.byteLength(text);

        if (bytes > MAX_UI_BYTES) {
            throw new Error(`${file} UI locale ${field} is too large`);
        }

        result[key] = text;
    }

    return Object.freeze(result);
}

function normalizeUiLocales(
    file: string,
    extensions: readonly PocketExtension[],
): PocketExtension[] {
    const seen = new Set<string>();
    let count = 0;

    return extensions.map((extension) => {
        const descriptor = Object.getOwnPropertyDescriptor(extension, "uiLocales");

        if (descriptor === undefined) {
            if ("uiLocales" in extension) {
                throw new Error(`${file} uiLocales must be an own data property`);
            }

            return extension;
        }

        if (!descriptor.enumerable || !("value" in descriptor)) {
            throw new Error(`${file} uiLocales must be an array of data-only locale packs`);
        }

        const rawLocales = checkedArray(descriptor.value, file, "uiLocales", MAX_UI_LOCALES);
        const locales = rawLocales.map((raw: unknown) => {
            if (!plainRecord(raw)) {
                throw new Error(`${file} UI locale entries must be plain objects`);
            }

            const fields = dataProperties(raw, file, "entry", UI_LOCALE_FIELDS);
            const locale = fields.get("locale");
            const label = fields.get("label");
            const preferred = fields.get("default");

            if (typeof locale !== "string" || locale.length > 35) {
                throw new Error(`${file} UI locale needs a valid BCP 47 language tag`);
            }

            let canonical: string;

            try {
                canonical = Intl.getCanonicalLocales(locale)[0] ?? "";
            } catch {
                canonical = "";
            }

            if (canonical === "" || canonical !== locale) {
                throw new Error(
                    `${file} UI locale ${locale} must be a canonical BCP 47 language tag`,
                );
            }

            if (seen.has(locale)) {
                throw new Error(`${file} registers the ${locale} UI locale more than once`);
            }

            seen.add(locale);
            count += 1;

            if (count > MAX_UI_LOCALES) {
                throw new Error(`${file} registers too many UI locales`);
            }

            if (typeof label !== "string" || label.trim() === "" || label.length > 80) {
                throw new Error(`${file} UI locale ${locale} needs a short label`);
            }

            if (fields.has("default") && typeof preferred !== "boolean") {
                throw new Error(`${file} UI locale ${locale} default must be true or false`);
            }

            const strings = checkedStrings(fields.get("strings"), file, `${locale} strings`);
            const templates = fields.has("templates")
                ? checkedStrings(fields.get("templates"), file, `${locale} templates`)
                : undefined;

            for (const [source, translated] of Object.entries(templates ?? {})) {
                const placeholders = (text: string) =>
                    [
                        ...new Set(
                            [...text.matchAll(/\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g)].map(
                                (match) => match[1],
                            ),
                        ),
                    ].sort();

                if (
                    JSON.stringify(placeholders(source)) !==
                    JSON.stringify(placeholders(translated))
                ) {
                    throw new Error(
                        `${file} UI locale ${locale} template placeholders must match the source`,
                    );
                }
            }

            const serializedBytes = Buffer.byteLength(
                JSON.stringify({
                    locale,
                    label,
                    ...(fields.has("default") ? { default: preferred } : {}),
                    strings,
                    ...(templates === undefined ? {} : { templates }),
                }),
            );

            if (serializedBytes > MAX_UI_BYTES) {
                throw new Error(`${file} UI locale ${locale} is too large`);
            }

            return Object.freeze({
                locale,
                label,
                ...(fields.has("default") ? { default: preferred as boolean } : {}),
                strings,
                ...(templates === undefined ? {} : { templates }),
            });
        });

        const normalized = { ...extension, uiLocales: Object.freeze(locales) };

        Object.defineProperty(normalized, "uiLocales", { writable: false, configurable: false });

        return normalized;
    });
}

export class ExtensionLoader {
    readonly #registry: Registry;
    readonly #host: PocketHost;
    readonly #builtIn: string;
    readonly #dropIn: string | undefined;
    readonly #choice: (file: string) => boolean | undefined;
    readonly #onChange: () => Promise<void>;
    /** Extension names each file installed, to uninstall the ones a new version no longer provides. */
    readonly #installed = new Map<string, PocketExtension[]>();
    readonly #errors = new Map<string, string>();
    readonly #timers = new Map<string, NodeJS.Timeout>();
    /** Each load owns a version so disabling, deletion, or a newer reload makes it stale. */
    readonly #loadVersions = new Map<string, number>();
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
        host: PocketHost,
        folders: { builtIn: string; dropIn?: string },
        choice: (file: string) => boolean | undefined = () => undefined,
        onChange: () => Promise<void> = async () => {},
    ) {
        this.#registry = registry;
        this.#host = host;
        this.#builtIn = folders.builtIn;
        this.#dropIn = folders.dropIn;
        this.#choice = choice;
        this.#onChange = onChange;
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

            const version = this.#beginLoad(module.file);

            try {
                await this.#load(module.file, false, version);
            } catch (error) {
                if (this.#loadVersions.get(module.file) === version) {
                    this.#errors.set(module.file, describe(error));
                    this.#host.notice(
                        "error",
                        `Extension ${module.file} failed to load: ${describe(error)}`,
                    );
                }
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

    #beginLoad(file: string): number {
        const timer = this.#timers.get(file);

        if (timer !== undefined) {
            clearTimeout(timer);
            this.#timers.delete(file);
        }

        const version = (this.#loadVersions.get(file) ?? 0) + 1;

        this.#loadVersions.set(file, version);

        return version;
    }

    #uninstall(file: string): void {
        this.#beginLoad(file);

        for (const extension of this.#installed.get(file) ?? []) {
            this.#registry.uninstall(extension);
        }

        this.#installed.delete(file);
        this.#errors.delete(file);
    }

    /** Import a module again and install what it builds. */
    async reload(file: string): Promise<PocketExtension[]> {
        const version = this.#beginLoad(file);

        try {
            return await this.#load(file, true, version);
        } catch (error) {
            if (this.#loadVersions.get(file) === version) {
                this.#errors.set(file, describe(error));
            }

            throw error;
        }
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
                extensions: (this.#installed.get(file) ?? []).map((extension) => ({
                    name: extension.name,
                    tools: (extension.tools ?? []).map((tool) => tool.name),
                })),
                ...(error === undefined ? {} : { error }),
            };
        });
    }

    extensionNames(): string[] {
        return [...this.#installed.values()].flat().map((extension) => extension.name);
    }

    /** The data-only locale packs registered by extensions that are on, in deterministic priority order. */
    uiLocales(): PocketUiLocale[] {
        return [...this.#installed.values()]
            .flatMap((extensions) => extensions.flatMap((extension) => extension.uiLocales ?? []))
            .sort(
                (a, b) =>
                    Number(b.default === true) - Number(a.default === true) ||
                    (a.locale < b.locale ? -1 : a.locale > b.locale ? 1 : 0),
            );
    }

    async #load(file: string, cacheBust: boolean, version: number): Promise<PocketExtension[]> {
        const module = this.#module(file);

        if (module === undefined) {
            throw new Error(`There is no extension module ${file}`);
        }

        const url =
            pathToFileURL(join(module.directory, file)).href +
            (cacheBust ? `?v=${Date.now()}-${version}` : "");
        const loaded = (await import(url)) as ExtensionModule;
        const current = this.#module(file);

        if (
            this.#loadVersions.get(file) !== version ||
            !this.enabled(file) ||
            current?.directory !== module.directory ||
            current.source !== module.source
        ) {
            return this.#installed.get(file) ?? [];
        }

        if (typeof loaded.default !== "function") {
            throw new Error("the module has no default export function");
        }

        const built = loaded.default(this.#host);
        const extensions = normalizeUiLocales(
            file,
            (Array.isArray(built) ? built : [built]) as PocketExtension[],
        );

        if (module.source === "drop-in") {
            this.#checkNames(file, extensions);
        }

        this.#checkUiLocaleNames(file, extensions);

        const previous = this.#installed.get(file) ?? [];

        // Validate the complete replacement before publishing any part of it. Registry.install() publishes
        // synchronously and a later extension can fail (for example, on a task-name collision).
        const staged = createRegistry();

        for (const extension of this.#registry.snapshot().installed()) {
            staged.install(extension);
        }

        for (const extension of extensions) {
            staged.install(extension);
        }

        for (const old of previous) {
            if (!extensions.some((extension) => extension.name === old.name)) {
                staged.uninstall(old);
            }
        }

        for (const extension of extensions) {
            this.#registry.install(extension);
        }

        for (const old of previous) {
            if (!extensions.some((extension) => extension.name === old.name)) {
                this.#registry.uninstall(old);
            }
        }

        this.#installed.set(file, extensions);
        this.#errors.delete(file);

        return extensions;
    }

    /**
     * Refuse a drop-in that would take a name Pi Pocket keeps, or one another module installed: installing it would
     * replace that one. Throws before anything is installed, so a version that loaded before keeps running.
     */
    #checkNames(file: string, extensions: readonly PocketExtension[]): void {
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

    #checkUiLocaleNames(file: string, extensions: readonly PocketExtension[]): void {
        const owners = new Map<string, string>();
        let count = 0;

        for (const [other, installed] of this.#installed) {
            if (other === file) {
                continue;
            }

            for (const extension of installed) {
                for (const locale of extension.uiLocales ?? []) {
                    owners.set(locale.locale, other);
                    count += 1;
                }
            }
        }

        for (const extension of extensions) {
            for (const locale of extension.uiLocales ?? []) {
                const other = owners.get(locale.locale);

                if (other !== undefined) {
                    throw new Error(
                        `${other} already registers the ${locale.locale} UI locale: choose another locale`,
                    );
                }

                count += 1;

                if (count > MAX_UI_LOCALES) {
                    throw new Error(
                        `${file} would register too many UI locales (maximum ${MAX_UI_LOCALES})`,
                    );
                }

                owners.set(locale.locale, file);
            }
        }
    }

    #notifyClients(): void {
        void this.#onChange().catch((error: unknown) =>
            this.#host.notice(
                "warning",
                `Could not refresh clients after an extension change: ${describe(error)}`,
            ),
        );
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

        // A drop-in that was removed takes away what it installed.
        if (module === undefined && directory === this.#dropIn && this.#installed.has(file)) {
            this.#uninstall(file);
            this.#notifyClients();
            this.#host.notice("info", `Removed the drop-in extension ${file}.`);

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

                if (!this.enabled(file)) {
                    return;
                }

                const loaded = this.#installed.has(file);

                this.reload(file).then(
                    (extensions) => {
                        this.#notifyClients();
                        this.#host.notice(
                            "info",
                            `Reloaded ${file}: ${extensions.map((extension) => extension.name).join(", ")}`,
                        );
                    },
                    (error: unknown) => {
                        this.#notifyClients();
                        this.#host.notice(
                            "error",
                            loaded
                                ? `Kept the previous ${file}; the edited one failed to load: ${describe(error)}`
                                : `${file} failed to load: ${describe(error)}`,
                        );
                    },
                );
            }, 300),
        );
    }

    close(): void {
        for (const watcher of this.#watchers) {
            watcher.close();
        }

        for (const file of new Set([...this.#timers.keys(), ...this.#loadVersions.keys()])) {
            this.#beginLoad(file);
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
