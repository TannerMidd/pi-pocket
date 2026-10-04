/**
 * Live editing. Extension modules in `src/server/extensions/` are imported again when they change and installed
 * under the same names, which replaces them in one step: a tool call already running finishes on the old code, the
 * next one uses the new code. Web files only need the browsers to reload.
 *
 * The owner can turn modules off and on from the app. A module that is off is not loaded, and turning one off
 * uninstalls what it installed; a tool call already running still finishes.
 */
import { type FSWatcher, readdirSync, readFileSync, watch } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Extension, Registry } from "@earendil-works/pi-durable";
import type { ExtensionModule, PocketHost } from "./host.ts";

/** Built-in extension modules, in install order. Other `.ts` files in the directory load after them, by name. */
const ORDER = ["prompt.ts", "artifacts.ts", "subagents.ts", "guard.ts", "codemode.ts"];
/** Modules the app cannot work without: always on. */
const REQUIRED = new Set(["prompt.ts"]);
const TITLES: Record<string, string> = {
	"prompt.ts": "System prompt",
	"artifacts.ts": "Artifacts",
	"subagents.ts": "Subagents",
	"guard.ts": "Lancet Guard",
	"codemode.ts": "Codemode",
};

export interface ExtensionInfo {
	file: string;
	title: string;
	/** The first sentence of the module's doc comment. */
	summary: string;
	enabled: boolean;
	required: boolean;
	/** What the module installed, with the tools each extension provides. */
	extensions: { name: string; tools: string[] }[];
	/** Why the module is not loaded, when it failed. */
	error?: string;
}

export class ExtensionLoader {
	readonly #registry: Registry;
	readonly #host: PocketHost;
	readonly #directory: string;
	readonly #isOff: (file: string) => boolean;
	/** Extension names each file installed, to uninstall the ones a new version no longer provides. */
	readonly #installed = new Map<string, Extension[]>();
	readonly #errors = new Map<string, string>();
	readonly #timers = new Map<string, NodeJS.Timeout>();
	#watcher: FSWatcher | undefined;

	/** `isOff` says which modules the owner turned off; it is read again on every load. */
	constructor(registry: Registry, host: PocketHost, directory: string, isOff: (file: string) => boolean = () => false) {
		this.#registry = registry;
		this.#host = host;
		this.#directory = directory;
		this.#isOff = isOff;
	}

	enabled(file: string): boolean {
		return REQUIRED.has(file) || !this.#isOff(file);
	}

	files(): string[] {
		const present = readdirSync(this.#directory).filter(
			(file) => file.endsWith(".ts") && !file.endsWith(".test.ts") && !file.startsWith("_"),
		);
		const known = ORDER.filter((file) => present.includes(file));
		const extra = present.filter((file) => !ORDER.includes(file)).sort();
		return [...known, ...extra];
	}

	/** Load every module that is on. A module that fails to load at startup is reported and skipped. */
	async loadAll(): Promise<void> {
		for (const file of this.files()) {
			if (!this.enabled(file)) continue;
			try {
				await this.#load(file, false);
			} catch (error) {
				this.#errors.set(file, describe(error));
				this.#host.notice("error", `Extension ${file} failed to load: ${describe(error)}`);
			}
		}
	}

	/**
	 * Install a module that was turned on, or uninstall one that was turned off (after `isOff` already says so).
	 * Throws when a module that was turned on fails to load; it stays on, and the error shows in `list()`.
	 */
	async apply(file: string): Promise<void> {
		if (!this.files().includes(file)) throw new Error(`There is no extension module ${file}`);
		if (this.enabled(file)) {
			await this.reload(file);
			return;
		}
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
		return this.files().map((file) => {
			const error = this.#errors.get(file);
			return {
				file,
				title: TITLES[file] ?? file.replace(/\.ts$/, ""),
				summary: this.#summary(file),
				enabled: this.enabled(file),
				required: REQUIRED.has(file),
				extensions: (this.#installed.get(file) ?? []).map((extension) => ({
					name: extension.name,
					tools: (extension.tools ?? []).map((tool) => tool.name),
				})),
				...(error === undefined ? {} : { error }),
			};
		});
	}

	#summary(file: string): string {
		try {
			const comment = /^\s*\/\*\*([\s\S]*?)\*\//.exec(readFileSync(join(this.#directory, file), "utf8"))?.[1] ?? "";
			const text = comment.replace(/^\s*\* ?/gm, "").replace(/\s+/g, " ").trim();
			return /^(.*?[.!?])(\s|$)/.exec(text)?.[1] ?? text;
		} catch {
			return "";
		}
	}

	extensionNames(): string[] {
		return [...this.#installed.values()].flat().map((extension) => extension.name);
	}

	async #load(file: string, cacheBust: boolean): Promise<Extension[]> {
		const url = pathToFileURL(join(this.#directory, file)).href + (cacheBust ? `?v=${Date.now()}` : "");
		const module = (await import(url)) as ExtensionModule;
		if (typeof module.default !== "function") throw new Error("the module has no default export function");
		const built = module.default(this.#host);
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

	/** Watch the directory and reload a module shortly after it changes. Keeps the old code when the new one fails. */
	watch(): void {
		this.#watcher = watch(this.#directory, (_event, name) => {
			if (name === null) return;
			const file = basename(name.toString());
			if (!file.endsWith(".ts") || file.endsWith(".test.ts") || file.startsWith("_")) return;
			// A module that is off stays off when its file is edited; turning it on loads the new code.
			if (!this.enabled(file)) return;
			clearTimeout(this.#timers.get(file));
			this.#timers.set(
				file,
				setTimeout(() => {
					this.#timers.delete(file);
					if (!this.enabled(file)) return;
					const loaded = this.#installed.has(file);
					this.reload(file).then(
						(extensions) =>
							this.#host.notice("info", `Reloaded ${file}: ${extensions.map((extension) => extension.name).join(", ")}`),
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
		});
	}

	close(): void {
		this.#watcher?.close();
		for (const timer of this.#timers.values()) clearTimeout(timer);
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
