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
import { type FSWatcher, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, watch } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Extension, Registry } from "@earendil-works/pi-durable";
import type { ExtensionModule, PocketHost } from "./host.ts";

/** Built-in extension modules, in install order. Other `.ts` files in the directory load after them, by name. */
const ORDER = ["prompt.ts", "artifacts.ts", "subagents.ts", "schedules.ts", "goals.ts", "plan.ts", "guard.ts", "codemode.ts"];
/** Modules the app cannot work without: always on. */
const REQUIRED = new Set(["prompt.ts"]);
/** Built-in modules that stay off until the owner turns them on. Drop-ins all do. */
const OFF_BY_DEFAULT = new Set(["guard.ts"]);
const TITLES: Record<string, string> = {
	"prompt.ts": "System prompt",
	"artifacts.ts": "Artifacts",
	"subagents.ts": "Subagents",
	"schedules.ts": "Scheduled messages",
	"goals.ts": "Done when",
	"plan.ts": "Plan mode",
	"guard.ts": "Lancet Guard",
	"codemode.ts": "Codemode",
};

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
		return readdirSync(directory).filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts") && !file.startsWith("_"));
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
		if (!lstatSync(link).isSymbolicLink()) return;
		current = realpathSync(link);
	} catch {
		// Missing, or a link to nowhere: made below.
	}
	if (current === realpathSync(appModules)) return;
	rmSync(link, { force: true });
	// A junction on Windows: no administrator rights needed.
	symlinkSync(appModules, link, process.platform === "win32" ? "junction" : "dir");
}

export class ExtensionLoader {
	readonly #registry: Registry;
	readonly #host: PocketHost;
	readonly #builtIn: string;
	readonly #dropIn: string | undefined;
	readonly #choice: (file: string) => boolean | undefined;
	/** Extension names each file installed, to uninstall the ones a new version no longer provides. */
	readonly #installed = new Map<string, Extension[]>();
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
		host: PocketHost,
		folders: { builtIn: string; dropIn?: string },
		choice: (file: string) => boolean | undefined = () => undefined,
	) {
		this.#registry = registry;
		this.#host = host;
		this.#builtIn = folders.builtIn;
		this.#dropIn = folders.dropIn;
		this.#choice = choice;
	}

	/** Every module, built-in ones first in install order. A drop-in with a built-in's name is left out. */
	#modules(): Module[] {
		const present = moduleFiles(this.#builtIn);
		const builtIn = [...ORDER.filter((file) => present.includes(file)), ...present.filter((file) => !ORDER.includes(file)).sort()];
		const dropIns = this.#dropIn === undefined ? [] : moduleFiles(this.#dropIn).sort();
		return [
			...builtIn.map((file) => ({ file, directory: this.#builtIn, source: "built-in" as const })),
			...dropIns.filter((file) => !builtIn.includes(file)).map((file) => ({ file, directory: this.#dropIn!, source: "drop-in" as const })),
		];
	}

	#module(file: string): Module | undefined {
		return this.#modules().find((module) => module.file === file);
	}

	/** Tell the owner about drop-ins that have a built-in module's name, each once: they are never loaded. */
	#reportClashes(): void {
		if (this.#dropIn === undefined) return;
		const builtIn = moduleFiles(this.#builtIn);
		for (const file of moduleFiles(this.#dropIn)) {
			if (!builtIn.includes(file) || this.#clashes.has(file)) continue;
			this.#clashes.add(file);
			this.#host.notice("warning", `The drop-in extension ${file} has the name of a built-in one and is not loaded. Rename it.`);
		}
	}

	#isOn(module: Module): boolean {
		return REQUIRED.has(module.file) || (this.#choice(module.file) ?? (module.source === "built-in" && !OFF_BY_DEFAULT.has(module.file)));
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
			if (!this.#isOn(module)) continue;
			try {
				await this.#load(module.file, false);
			} catch (error) {
				this.#errors.set(module.file, describe(error));
				this.#host.notice("error", `Extension ${module.file} failed to load: ${describe(error)}`);
			}
		}
	}

	/**
	 * Install a module that was turned on, or uninstall one that was turned off (after `choice` already says so).
	 * Throws when a module that was turned on fails to load; it stays on, and the error shows in `list()`.
	 */
	async apply(file: string): Promise<void> {
		if (!this.files().includes(file)) throw new Error(`There is no extension module ${file}`);
		if (this.enabled(file)) {
			await this.reload(file);
			return;
		}
		this.#uninstall(file);
	}

	#uninstall(file: string): void {
		for (const extension of this.#installed.get(file) ?? []) this.#registry.uninstall(extension);
		this.#installed.delete(file);
		this.#errors.delete(file);
	}

	/** Import a module again and install what it builds. */
	async reload(file: string): Promise<Extension[]> {
		try {
			return await this.#load(file, true);
		} catch (error) {
			this.#errors.set(file, describe(error));
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

	async #load(file: string, cacheBust: boolean): Promise<Extension[]> {
		const module = this.#module(file);
		if (module === undefined) throw new Error(`There is no extension module ${file}`);
		const url = pathToFileURL(join(module.directory, file)).href + (cacheBust ? `?v=${Date.now()}` : "");
		const loaded = (await import(url)) as ExtensionModule;
		if (typeof loaded.default !== "function") throw new Error("the module has no default export function");
		const built = loaded.default(this.#host);
		const extensions = (Array.isArray(built) ? built : [built]) as Extension[];
		const previous = this.#installed.get(file) ?? [];
		for (const extension of extensions) this.#registry.install(extension);
		for (const old of previous) {
			if (!extensions.some((extension) => extension.name === old.name)) this.#registry.uninstall(old);
		}
		this.#installed.set(file, extensions);
		this.#errors.delete(file);
		return extensions;
	}

	/** Watch both folders and reload a module shortly after it changes. Keeps the old code when the new one fails. */
	watch(): void {
		for (const directory of [this.#builtIn, this.#dropIn]) {
			if (directory === undefined) continue;
			try {
				this.#watchers.push(watch(directory, (_event, name) => name !== null && this.#changed(basename(name.toString()), directory)));
			} catch (error) {
				this.#host.notice("warning", `Extensions in ${directory} are not reloaded when edited: ${describe(error)}`);
			}
		}
	}

	#changed(file: string, directory: string): void {
		if (!file.endsWith(".ts") || file.endsWith(".test.ts") || file.startsWith("_")) return;
		if (directory === this.#dropIn) this.#reportClashes();
		const module = this.#module(file);
		// A drop-in that was removed takes away what it installed.
		if (module === undefined && directory === this.#dropIn && this.#installed.has(file)) {
			this.#uninstall(file);
			this.#host.notice("info", `Removed the drop-in extension ${file}.`);
			return;
		}
		// A module that is off stays off when its file is edited; turning it on loads the new code.
		if (module?.directory !== directory || !this.enabled(file)) return;
		clearTimeout(this.#timers.get(file));
		this.#timers.set(
			file,
			setTimeout(() => {
				this.#timers.delete(file);
				if (!this.enabled(file)) return;
				const loaded = this.#installed.has(file);
				this.reload(file).then(
					(extensions) => this.#host.notice("info", `Reloaded ${file}: ${extensions.map((extension) => extension.name).join(", ")}`),
					(error: unknown) =>
						this.#host.notice(
							"error",
							loaded ? `Kept the previous ${file}; the edited one failed to load: ${describe(error)}` : `${file} failed to load: ${describe(error)}`,
						),
				);
			}, 300),
		);
	}

	close(): void {
		for (const watcher of this.#watchers) watcher.close();
		for (const timer of this.#timers.values()) clearTimeout(timer);
	}
}

/** The first sentence of a module's doc comment: its description in the Extensions sheet. */
function summary(path: string): string {
	try {
		const comment = /^\s*\/\*\*([\s\S]*?)\*\//.exec(readFileSync(path, "utf8"))?.[1] ?? "";
		const text = comment.replace(/^\s*\* ?/gm, "").replace(/\s+/g, " ").trim();
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

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
