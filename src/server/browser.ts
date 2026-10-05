/**
 * The built-in browser: one headless Chromium on this machine, driven over the DevTools protocol through a pipe, with a
 * page per conversation that Pi (the `browser` tool) and the people in the conversation (the Browser panel) share.
 * People see the page as a stream of JPEG frames and send it taps, scrolls, and keys. Nothing of the page runs in their
 * own browser, so a page cannot reach the app or its cookies, and pages only this machine can reach (a dev server on
 * localhost) work from a phone too.
 *
 * Each conversation's page lives in a browser context of its own: cookies and storage are not shared between
 * conversations. Pages are memory only: a restart closes them, and each conversation's last address and size come back
 * from its saved state when its page is next opened.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { homedir } from "node:os";
import { basename, delimiter, join, posix, win32 } from "node:path";
import type { Readable, Writable } from "node:stream";
import { pathToFileURL } from "node:url";

// ─── Sizes and addresses ────────────────────────────────────────────────

export type ViewportPreset = "mobile" | "tablet" | "desktop";

/** A page's size in CSS pixels, its device pixel ratio, and whether it acts as a phone or tablet (touch, mobile layout). */
export type Viewport = { width: number; height: number; scale: number; mobile: boolean };

export const VIEWPORTS: Readonly<Record<ViewportPreset, Viewport>> = {
	mobile: { width: 390, height: 844, scale: 2, mobile: true },
	tablet: { width: 820, height: 1180, scale: 2, mobile: true },
	desktop: { width: 1280, height: 800, scale: 1, mobile: false },
};

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/** A preset name, `WIDTHxHEIGHT`, or a viewport object, as a viewport; undefined when it is none of these. */
export function viewportFrom(value: unknown): Viewport | undefined {
	if (typeof value === "string") {
		const name = value.trim().toLowerCase();
		if (Object.hasOwn(VIEWPORTS, name)) return { ...VIEWPORTS[name as ViewportPreset] };
		const match = /^(\d{3,4})\s*[x×]\s*(\d{3,4})$/.exec(name);
		if (match === null) return undefined;
		const width = clamp(Number(match[1]), 240, 3840);
		return { width, height: clamp(Number(match[2]), 240, 3840), scale: 1, mobile: width < 600 };
	}
	if (typeof value !== "object" || value === null) return undefined;
	const raw = value as Record<string, unknown>;
	if (typeof raw.width !== "number" || typeof raw.height !== "number" || !Number.isFinite(raw.width) || !Number.isFinite(raw.height)) return undefined;
	return {
		width: clamp(Math.round(raw.width), 240, 3840),
		height: clamp(Math.round(raw.height), 240, 3840),
		scale: typeof raw.scale === "number" && Number.isFinite(raw.scale) ? clamp(raw.scale, 1, 3) : 1,
		mobile: raw.mobile === true,
	};
}

/** The preset a viewport is, if it is one. */
export function presetOf(viewport: Viewport): ViewportPreset | undefined {
	return (Object.keys(VIEWPORTS) as ViewportPreset[]).find((name) => {
		const preset = VIEWPORTS[name];
		return preset.width === viewport.width && preset.height === viewport.height && preset.mobile === viewport.mobile;
	});
}

/** Host names that are this machine or the local network, where plain http is the likely scheme. */
function localHost(host: string): boolean {
	const name = host.toLowerCase().replace(/^\[|\]$/g, "");
	return (
		name === "localhost" ||
		name.endsWith(".localhost") ||
		name.endsWith(".local") ||
		name.endsWith(".lan") ||
		name.endsWith(".internal") ||
		name.endsWith(".home.arpa") ||
		name === "::1" ||
		name === "0.0.0.0" ||
		/^127\./.test(name) ||
		/^10\./.test(name) ||
		/^192\.168\./.test(name) ||
		/^172\.(1[6-9]|2\d|3[01])\./.test(name) ||
		/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(name) ||
		// One label, as `myserver:8080`: a name on the local network.
		!name.includes(".")
	);
}

/** Paths as people write them: absolute, from the home folder, or from the current folder. */
const POSIX_PATH = /^(\/|~\/|~$|\.\.?\/)/;
/** On Windows also `C:\site`, `C:/site`, `\\server\share`, `.\site`, and `~\site`. */
const WINDOWS_PATH = /^(\/|\\|[a-z]:[\\/]|~[\\/]|~$|\.\.?[\\/])/i;

/**
 * An address as people and Pi type it, as a URL the browser may open. `localhost:5173` and other local addresses
 * become http, other bare host names https. With `trusted` (Pi, or the owner), paths to files on this machine become
 * file URLs, and file and data URLs are allowed. Undefined for anything else, such as `javascript:` or `chrome:` URLs.
 * `windows` reads paths as Windows does (the default on Windows).
 */
export function normalizeUrl(input: string, options: { trusted?: boolean; cwd?: string; windows?: boolean } = {}): string | undefined {
	const text = input.trim();
	if (text === "") return undefined;
	if (text === "about:blank") return text;
	const windows = options.windows ?? process.platform === "win32";
	if ((windows ? WINDOWS_PATH : POSIX_PATH).test(text)) {
		if (options.trusted !== true) return undefined;
		const paths = windows ? win32 : posix;
		const home = text === "~" || /^~[\\/]/.test(text);
		const path = paths.resolve(options.cwd ?? process.cwd(), home ? homedir() + text.slice(1) : text);
		return pathToFileURL(path, { windows }).href;
	}
	// A backslash is no part of a web address: browsers read it as a slash, which turns `.\site` into a host named ".".
	if (/^[^:]*\\/.test(text)) return undefined;
	// `host:port`, which looks like a scheme followed by a path.
	const hostPort = /^([^\s/:?#]+|\[[0-9a-f:]+\]):(\d{1,5})(?=$|[/?#])/i.exec(text);
	const scheme = hostPort === null ? /^([a-z][a-z0-9+.-]*):/i.exec(text)?.[1]?.toLowerCase() : undefined;
	let candidate: string;
	if (scheme === undefined) {
		// Words with spaces are a search, which this browser does not do.
		if (/\s/.test(text)) return undefined;
		const host = hostPort?.[1] ?? /^[^/?#]+/.exec(text)?.[0] ?? "";
		const bare = host.replace(/:\d+$/, "");
		// A bare word is not an address unless it names a local machine with a port.
		if (hostPort === null && !bare.includes(".") && bare !== "localhost" && !bare.startsWith("[")) return undefined;
		candidate = `${localHost(bare) ? "http" : "https"}://${text}`;
	} else if (scheme === "http" || scheme === "https") {
		candidate = text;
	} else if ((scheme === "file" || scheme === "data") && options.trusted === true) {
		candidate = text;
	} else {
		return undefined;
	}
	try {
		const url = new URL(candidate);
		if (url.protocol === "http:" || url.protocol === "https:") {
			// A name made of labels (letters, digits, hyphens) with dots between, or an IPv6 address.
			const host = url.hostname;
			if (!host.startsWith("[") && !/^[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?)*\.?$/i.test(host)) return undefined;
		}
		return url.href;
	} catch {
		return undefined;
	}
}

/** An address as the address bar shows it: without `http://` and a lone trailing slash. */
export function displayUrl(url: string): string {
	if (url === "" || url === "about:blank") return "";
	return url.replace(/^https?:\/\//, "").replace(/^([^/?#]+)\/$/, "$1");
}

// ─── Finding a browser ──────────────────────────────────────────────────

const isFile = (path: string) => {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
};

/** The newest Playwright download of Chromium, if there is one. */
function playwrightChromium(): string | undefined {
	const root =
		process.env.PLAYWRIGHT_BROWSERS_PATH ??
		(process.platform === "darwin"
			? join(homedir(), "Library", "Caches", "ms-playwright")
			: process.platform === "win32"
				? join(process.env.LOCALAPPDATA ?? homedir(), "ms-playwright")
				: join(homedir(), ".cache", "ms-playwright"));
	let folders: string[];
	try {
		folders = readdirSync(root).filter((name) => /^chromium-\d+$/.test(name));
	} catch {
		return undefined;
	}
	folders.sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
	for (const folder of folders) {
		for (const path of [
			join(root, folder, "chrome-linux64", "chrome"),
			join(root, folder, "chrome-linux", "chrome"),
			join(root, folder, "chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"),
			join(root, folder, "chrome-mac-arm64", "Chromium.app", "Contents", "MacOS", "Chromium"),
			join(root, folder, "chrome-win", "chrome.exe"),
			join(root, folder, "chrome-win64", "chrome.exe"),
		]) {
			if (isFile(path)) return path;
		}
	}
	return undefined;
}

/** Where snapd puts the commands that run snaps. */
const SNAP_BIN = "/snap/bin";

/**
 * The snap a browser command runs, if it is one: `/snap/bin/chromium`, or a script that runs one, as Ubuntu's
 * `/usr/bin/chromium-browser` is. `command` is what to run: the snap's own command, which the script would run.
 */
export function snapOf(path: string, snapBin = SNAP_BIN): { name: string; command: string } | undefined {
	if (path.startsWith(`${snapBin}/`)) return { name: basename(path), command: path };
	if (path.startsWith("/snap/")) return { name: path.split("/")[2] ?? "", command: path };
	let head = "";
	try {
		const fd = openSync(path, "r");
		try {
			const buffer = Buffer.alloc(4096);
			head = buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, 0)).toString("latin1");
		} finally {
			closeSync(fd);
		}
	} catch {
		return undefined;
	}
	if (!head.startsWith("#!")) return undefined;
	const escaped = snapBin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const name = new RegExp(`${escaped}/([\\w.-]+)`).exec(head)?.[1];
	return name === undefined ? undefined : { name, command: join(snapBin, name) };
}

/**
 * Where the browser keeps its profile. A snap may not write to hidden folders in the home folder, as the data folder
 * usually is (`~/.pi-pocket`): its profile goes in the snap's own folder instead, one per data folder.
 */
export function profileFolder(executable: string, dataDir: string, snapBin = SNAP_BIN): string {
	const snap = snapOf(executable, snapBin);
	if (snap === undefined) return join(dataDir, "browser", "profile");
	const id = createHash("sha256").update(dataDir).digest("hex").slice(0, 12);
	return join(homedir(), "snap", snap.name, "common", "pi-pocket", id);
}

/**
 * A Chromium-based browser to run: `PI_POCKET_BROWSER` if set, else Chromium, Chrome, Brave, or Edge where they are
 * usually installed, else a Playwright download. On Linux the real Chromium binary comes before the launcher scripts
 * distributions put on the PATH, which add the desktop's own flags and extensions. A snap comes last (Ubuntu's
 * Chromium is one): it cannot open files outside the home folder, so a browser installed otherwise is the better choice.
 */
export function findBrowser(env: NodeJS.ProcessEnv = process.env, options: { snapBin?: string; places?: readonly string[] } = {}): string | undefined {
	const configured = env.PI_POCKET_BROWSER?.trim();
	if (configured) return isFile(configured) ? configured : undefined;
	const snapBin = options.snapBin ?? SNAP_BIN;
	const candidates = [...(options.places ?? installPlaces(env))];
	const names = ["chromium", "chromium-browser", "google-chrome-stable", "google-chrome", "brave-browser", "brave", "microsoft-edge-stable", "microsoft-edge"];
	const extension = process.platform === "win32" ? ".exe" : "";
	for (const folder of (env.PATH ?? "").split(delimiter)) {
		if (folder === "") continue;
		for (const name of names) candidates.push(join(folder, name + extension));
	}
	let snap: string | undefined;
	for (const candidate of candidates) {
		if (!isFile(candidate)) continue;
		const found = process.platform === "linux" ? snapOf(candidate, snapBin) : undefined;
		if (found === undefined) return candidate;
		// A script for a snap that is not installed only says so.
		if (snap === undefined && isFile(found.command)) snap = found.command;
	}
	return playwrightChromium() ?? snap;
}

/** Where browsers are usually installed on this system, besides the PATH. */
function installPlaces(env: NodeJS.ProcessEnv): string[] {
	const candidates: string[] = [];
	if (process.platform === "darwin") {
		// Installed for everyone, or for this user alone.
		for (const folder of ["/Applications", join(homedir(), "Applications")]) {
			for (const app of ["Google Chrome", "Chromium", "Brave Browser", "Microsoft Edge"]) candidates.push(join(folder, `${app}.app`, "Contents", "MacOS", app));
		}
	} else if (process.platform === "win32") {
		for (const base of [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA]) {
			if (base === undefined) continue;
			candidates.push(join(base, "Google", "Chrome", "Application", "chrome.exe"), join(base, "Chromium", "Application", "chrome.exe"), join(base, "Microsoft", "Edge", "Application", "msedge.exe"));
		}
	} else {
		candidates.push("/usr/lib/chromium/chromium", "/usr/lib/chromium-browser/chromium-browser");
	}
	return candidates;
}

// ─── The DevTools protocol over a pipe ─────────────────────────────────

export class BrowserError extends Error {}

/** A DevTools protocol message: untyped JSON, read field by field where it arrives. */
type Json = any;
type EventListener = (method: string, params: Json) => void;

/** Messages are JSON, each ended by a NUL byte: Chromium reads from fd 3 and writes to fd 4. */
class Connection {
	readonly #out: Writable;
	#parts: string[] = [];
	#next = 0;
	readonly #pending = new Map<number, { resolve: (value: Json) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
	readonly #sessions = new Map<string, EventListener>();
	#closed: string | undefined;
	/** Events without a session: the browser's own, such as targets appearing. */
	onEvent: EventListener | undefined;
	onClose: (() => void) | undefined;

	constructor(out: Writable, input: Readable) {
		this.#out = out;
		input.setEncoding("utf8");
		input.on("data", (chunk: string) => this.#receive(chunk));
		input.on("close", () => this.close("The browser closed."));
		input.on("error", () => this.close("The browser closed."));
		out.on("error", () => this.close("The browser closed."));
	}

	get closed(): boolean {
		return this.#closed !== undefined;
	}

	#receive(chunk: string): void {
		let start = 0;
		let end = chunk.indexOf("\0");
		while (end !== -1) {
			this.#parts.push(chunk.slice(start, end));
			const text = this.#parts.join("");
			this.#parts = [];
			this.#dispatch(text);
			start = end + 1;
			end = chunk.indexOf("\0", start);
		}
		if (start < chunk.length) this.#parts.push(chunk.slice(start));
	}

	#dispatch(text: string): void {
		let message: Json;
		try {
			message = JSON.parse(text);
		} catch {
			return;
		}
		if (typeof message.id === "number") {
			const pending = this.#pending.get(message.id);
			if (pending === undefined) return;
			this.#pending.delete(message.id);
			clearTimeout(pending.timer);
			if (message.error !== undefined) pending.reject(new BrowserError(String(message.error.message ?? message.error)));
			else pending.resolve(message.result ?? {});
			return;
		}
		if (typeof message.method !== "string") return;
		try {
			if (typeof message.sessionId === "string") this.#sessions.get(message.sessionId)?.(message.method, message.params ?? {});
			else this.onEvent?.(message.method, message.params ?? {});
		} catch {
			// A listener's mistake must not stop the connection.
		}
	}

	send(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 30_000): Promise<Json> {
		if (this.#closed !== undefined) return Promise.reject(new BrowserError(this.#closed));
		const id = ++this.#next;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#pending.delete(id);
				reject(new BrowserError(`The browser did not answer ${method} in time.`));
			}, timeoutMs);
			timer.unref();
			this.#pending.set(id, { resolve, reject, timer });
			this.#out.write(`${JSON.stringify(sessionId === undefined ? { id, method, params } : { id, method, params, sessionId })}\0`);
		});
	}

	listen(sessionId: string, listener: EventListener): void {
		this.#sessions.set(sessionId, listener);
	}

	unlisten(sessionId: string): void {
		this.#sessions.delete(sessionId);
	}

	close(reason: string): void {
		if (this.#closed !== undefined) return;
		this.#closed = reason;
		for (const pending of this.#pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(new BrowserError(reason));
		}
		this.#pending.clear();
		this.#sessions.clear();
		this.onClose?.();
	}
}

const LAUNCH_ARGS = [
	"--headless=new",
	"--remote-debugging-pipe",
	"--no-first-run",
	"--no-default-browser-check",
	"--disable-background-networking",
	"--disable-component-update",
	"--disable-default-apps",
	"--disable-extensions",
	"--disable-sync",
	"--disable-features=Translate,MediaRouter,OptimizationHints,AutofillServerCommunication",
	// Pages keep running while nobody watches: Pi tests them in the background.
	"--disable-background-timer-throttling",
	"--disable-backgrounding-occluded-windows",
	"--disable-renderer-backgrounding",
	"--mute-audio",
	"--password-store=basic",
	"--use-mock-keychain",
	"--force-color-profile=srgb",
];

/** One Chromium process. It exits on its own when the pipe closes, so a crashed server leaves none behind. */
class Chromium {
	readonly connection: Connection;
	readonly #child: ChildProcess;
	readonly exited: Promise<void>;
	userAgent = "";

	private constructor(child: ChildProcess, connection: Connection) {
		this.#child = child;
		this.connection = connection;
		this.exited = new Promise((done) => {
			if (child.exitCode !== null || child.signalCode !== null) done();
			else child.once("exit", () => done());
		});
	}

	static async launch(executable: string, profile: string, extra: readonly string[]): Promise<Chromium> {
		mkdirSync(profile, { recursive: true, mode: 0o700 });
		const child = spawn(executable, [...LAUNCH_ARGS, `--user-data-dir=${profile}`, ...extra, "about:blank"], {
			stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
		});
		let stderr = "";
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => {
			stderr = (stderr + chunk).slice(-4000);
		});
		const failed = new Promise<never>((_, reject) => {
			// Every error: one after the start (a failed kill) would otherwise be unhandled and stop the server.
			child.on("error", (error) => reject(new BrowserError(`Could not start ${executable}: ${error.message}`)));
			child.once("exit", (code, signal) => {
				const why = stderr.trim().split("\n").slice(-6).join("\n");
				reject(new BrowserError(`The browser exited as it started (${signal ?? `code ${code}`}).${why === "" ? "" : `\n${why}`}`));
			});
		});
		failed.catch(() => {});
		if (child.stdio[3] == null || child.stdio[4] == null) {
			child.kill("SIGKILL");
			throw new BrowserError(`Could not start ${executable}.`);
		}
		const connection = new Connection(child.stdio[3] as Writable, child.stdio[4] as Readable);
		const chromium = new Chromium(child, connection);
		child.once("exit", () => connection.close("The browser stopped."));
		try {
			const version = await Promise.race([connection.send("Browser.getVersion", {}, undefined, 20_000), failed]);
			chromium.userAgent = String(version.userAgent ?? "").replace("HeadlessChrome/", "Chrome/");
			await connection.send("Target.setDiscoverTargets", { discover: true });
		} catch (error) {
			chromium.kill();
			throw error;
		}
		return chromium;
	}

	kill(): void {
		this.connection.close("The browser stopped.");
		if (this.#child.exitCode !== null || this.#child.signalCode !== null) return;
		this.#child.kill("SIGTERM");
		const force = setTimeout(() => this.#child.kill("SIGKILL"), 3000);
		force.unref();
		this.#child.once("exit", () => clearTimeout(force));
	}
}

// ─── Pages ──────────────────────────────────────────────────────────────

export type BrowserState = {
	/** A browser to run was found on this machine. */
	available: boolean;
	/** The conversation's page is open. */
	open: boolean;
	url: string;
	title: string;
	loading: boolean;
	viewport: Viewport;
	preset?: ViewportPreset;
	canGoBack: boolean;
	canGoForward: boolean;
	/** Console errors since the page last loaded. */
	errors: number;
	/** How many console lines there are, to know when to fetch them again. */
	logs: number;
	/** Why the page could not open, or that it crashed. */
	problem?: string;
};

export type LogEntry = { seq: number; at: number; level: string; text: string; source?: string };

export type Frame = { seq: number; data: Buffer; width: number; height: number };

/** Where Pi points: a ref from the last snapshot, a CSS selector, visible text, or a point. */
export type Target = { ref?: string; selector?: string; label?: string; x?: number; y?: number };

export type Saved = { url?: string; viewport?: Viewport };

const MAX_LOGS = 300;
/** Frame numbers, for every page: a page opened again goes on from where the last one was. */
let frameCount = 0;
/** At most one screencast frame per this many milliseconds. */
const FRAME_GAP_MS = 40;
/** Frames stop this long after the last viewer asked for one. */
const WATCH_MS = 15_000;
const FRAME_WAIT_MS = 25_000;

const MODIFIERS: Record<string, number> = { alt: 1, option: 1, control: 2, ctrl: 2, meta: 4, cmd: 4, command: 4, super: 4, shift: 8 };

/** Keys other than characters: their DOM code, Windows key code, and the text they type. */
const KEYS: Record<string, [string, number, string?]> = {
	Enter: ["Enter", 13, "\r"],
	Tab: ["Tab", 9],
	Backspace: ["Backspace", 8],
	Delete: ["Delete", 46],
	Escape: ["Escape", 27],
	ArrowLeft: ["ArrowLeft", 37],
	ArrowUp: ["ArrowUp", 38],
	ArrowRight: ["ArrowRight", 39],
	ArrowDown: ["ArrowDown", 40],
	Home: ["Home", 36],
	End: ["End", 35],
	PageUp: ["PageUp", 33],
	PageDown: ["PageDown", 34],
	Insert: ["Insert", 45],
	" ": ["Space", 32, " "],
	Shift: ["ShiftLeft", 16],
	Control: ["ControlLeft", 17],
	Alt: ["AltLeft", 18],
	Meta: ["MetaLeft", 91],
	...Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`F${index + 1}`, [`F${index + 1}`, 112 + index] as [string, number]])),
};
const KEY_NAMES: Record<string, string> = {
	esc: "Escape",
	return: "Enter",
	space: " ",
	up: "ArrowUp",
	down: "ArrowDown",
	left: "ArrowLeft",
	right: "ArrowRight",
	del: "Delete",
	pgup: "PageUp",
	pgdn: "PageDown",
	...Object.fromEntries(Object.keys(KEYS).map((name) => [name.toLowerCase(), name])),
};
/**
 * Editing shortcuts headless Chromium does not act on by itself, as the editor commands they stand for. Not the
 * clipboard's: the browser's clipboard is not the person's, whose pastes arrive as text.
 */
const COMMANDS: Record<string, string> = { a: "selectAll", z: "undo", y: "redo" };

/** `Control+Shift+A` as a key and modifier bits; a key alone is a key. */
export function parseKeys(combo: string): { key: string; modifiers: number } {
	const parts = combo === "+" ? ["+"] : combo.endsWith("++") ? [...combo.slice(0, -2).split("+"), "+"] : combo.split("+");
	let modifiers = 0;
	for (const part of parts.slice(0, -1)) {
		const bit = MODIFIERS[part.trim().toLowerCase()];
		if (bit === undefined) throw new BrowserError(`Unknown modifier "${part}". Use Control, Shift, Alt, or Meta.`);
		modifiers |= bit;
	}
	const last = parts.at(-1) ?? "";
	const key = last.length === 1 ? last : (KEY_NAMES[last.trim().toLowerCase()] ?? last.trim());
	if (key.length !== 1 && KEYS[key] === undefined) throw new BrowserError(`Unknown key "${last}".`);
	return { key, modifiers };
}

function keyEvents(key: string, modifiers: number): { down: Record<string, unknown>; up: Record<string, unknown> } {
	const special = KEYS[key];
	let code: string;
	let keyCode: number;
	let text: string | undefined;
	if (special !== undefined) {
		[code, keyCode, text] = special;
	} else {
		const upper = key.toUpperCase();
		code = /^[a-z]$/i.test(key) ? `Key${upper}` : /^\d$/.test(key) ? `Digit${key}` : "";
		keyCode = /^[a-z\d]$/i.test(key) ? upper.charCodeAt(0) : 0;
		text = key;
	}
	// With Control, Alt, or Meta held, a key is a shortcut and types nothing.
	if ((modifiers & 7) !== 0) text = undefined;
	const base = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers };
	const command = (modifiers & 6) !== 0 ? COMMANDS[key.toLowerCase()] : undefined;
	return {
		down: { ...base, type: text === undefined ? "rawKeyDown" : "keyDown", ...(text === undefined ? {} : { text, unmodifiedText: text }), ...(command === undefined ? {} : { commands: [command] }) },
		up: { ...base, type: "keyUp" },
	};
}

/** A console argument as text: strings as they are, other values as DevTools would show them in one line. */
function formatArg(arg: Json): string {
	if (arg === undefined || arg === null) return "";
	if (arg.type === "string") return String(arg.value);
	if (arg.type === "undefined") return "undefined";
	if (arg.unserializableValue !== undefined) return String(arg.unserializableValue);
	if (Object.hasOwn(arg, "value")) return JSON.stringify(arg.value);
	const preview = arg.preview;
	if (preview !== undefined && Array.isArray(preview.properties)) {
		const items = preview.properties.map((property: Json) => (preview.subtype === "array" ? property.value : `${property.name}: ${property.value}`));
		const body = `${items.join(", ")}${preview.overflow ? ", …" : ""}`;
		return preview.subtype === "array" ? `[${body}]` : `${arg.className && arg.className !== "Object" ? `${arg.className} ` : ""}{${body}}`;
	}
	return String(arg.description ?? arg.className ?? arg.type);
}

const wait = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

function aborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new BrowserError("Stopped.");
}

/** A page script's result, or its exception as an error. */
function evaluated(response: Json): Json {
	if (response.exceptionDetails !== undefined) {
		const details = response.exceptionDetails;
		const message = details.exception?.description ?? details.exception?.value ?? details.text ?? "The script failed";
		throw new BrowserError(String(message).split("\n    at ")[0] ?? "The script failed");
	}
	return response.result?.value;
}

/**
 * The page outline Pi reads: headings, text, and every control with a ref (`[e12]`) that click, type, select, and
 * hover take until the next snapshot. Refs are kept in the page itself, as weak references, so a page that changed
 * underneath still finds the controls it has. Elements that only look clickable (a `cursor: pointer` div with a
 * script's listener) count as controls too: apps are full of them.
 */
const SNAPSHOT_SCRIPT = String.raw`(() => {
	const MAX = 16000;
	const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "META", "LINK", "BR", "WBR"]);
	const ROLES = new Set(["button", "link", "checkbox", "radio", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "switch", "option", "combobox", "textbox", "searchbox", "slider", "spinbutton", "treeitem", "listbox"]);
	const INPUTS = { button: "button", submit: "button", reset: "button", image: "button", file: "button", color: "button", checkbox: "checkbox", radio: "radio", range: "slider", number: "spinbutton", search: "searchbox" };
	const LANDMARKS = { HEADER: "header", NAV: "nav", MAIN: "main", ASIDE: "aside", FOOTER: "footer", FORM: "form", DIALOG: "dialog", TABLE: "table" };
	const styles = new Map();
	const style = (el) => { let s = styles.get(el); if (!s) { s = getComputedStyle(el); styles.set(el, s); } return s; };
	const clip = (text, max) => { const flat = String(text ?? "").replace(/\s+/g, " ").trim(); return flat.length > max ? flat.slice(0, max - 1) + "…" : flat; };
	const shown = (el) => { const s = style(el); if (s.display === "contents") return true; return s.display !== "none" && s.visibility !== "hidden" && s.visibility !== "collapse" && el.getClientRects().length > 0; };
	const up = (el) => el.parentElement ?? (el.parentNode instanceof ShadowRoot ? el.parentNode.host : null);
	const roleOf = (el) => {
		const explicit = el.getAttribute("role");
		if (explicit) return explicit.trim().split(/\s+/)[0];
		const tag = el.tagName;
		if (tag === "A") return el.hasAttribute("href") ? "link" : null;
		if (tag === "BUTTON" || tag === "SUMMARY") return "button";
		if (tag === "SELECT") return el.multiple ? "listbox" : "combobox";
		if (tag === "TEXTAREA") return "textbox";
		if (tag === "INPUT") { const type = (el.getAttribute("type") || "text").toLowerCase(); return type === "hidden" ? null : (INPUTS[type] ?? "textbox"); }
		if (el.isContentEditable && (el.getAttribute("contenteditable") ?? "") !== "false" && !el.parentElement?.isContentEditable) return "textbox";
		if (/^H[1-6]$/.test(tag)) return "heading";
		return null;
	};
	const nameOf = (el) => {
		const aria = el.getAttribute("aria-label");
		if (aria && aria.trim()) return aria;
		const by = el.getAttribute("aria-labelledby");
		if (by) { const text = by.split(/\s+/).map((id) => document.getElementById(id)?.innerText ?? "").join(" "); if (text.trim()) return text; }
		if (el.labels && el.labels.length > 0) { const text = [...el.labels].map((label) => label.innerText).join(" "); if (text.trim()) return text; }
		if (el.tagName === "INPUT" && ["button", "submit", "reset"].includes(el.type)) return el.value;
		if (el.tagName === "IMG") return el.alt;
		if (el.tagName !== "SELECT" && el.tagName !== "TEXTAREA" && el.tagName !== "INPUT") { const text = el.innerText; if (text && text.trim()) return text; }
		return el.getAttribute("title") || el.getAttribute("placeholder") || el.querySelector?.("img[alt]")?.alt || "";
	};
	const clickable = new Set();
	const holders = new Set();
	const scan = (root) => {
		for (const el of root.querySelectorAll("*")) {
			if (el.shadowRoot) scan(el.shadowRoot);
			if (SKIP.has(el.tagName)) continue;
			const role = roleOf(el);
			let control = ROLES.has(role) || el.hasAttribute("onclick") || (el.hasAttribute("tabindex") && el.tabIndex >= 0 && el !== document.body);
			if (!control) { const parent = up(el); control = style(el).cursor === "pointer" && (!parent || style(parent).cursor !== "pointer"); }
			if (!control || !shown(el)) continue;
			clickable.add(el);
			for (let parent = up(el); parent && !holders.has(parent); parent = up(parent)) holders.add(parent);
		}
	};
	scan(document);
	const refs = new Map();
	window.__piPocketRefs = refs;
	let count = 0;
	let size = 0;
	let full = false;
	const lines = [];
	const add = (depth, text) => {
		if (full) return;
		const line = "  ".repeat(Math.min(depth, 12)) + text;
		if (size + line.length > MAX) { full = true; return; }
		size += line.length + 1;
		lines.push(line);
	};
	const control = (el, role) => {
		const ref = "e" + ++count;
		refs.set(ref, new WeakRef(el));
		let line = "[" + ref + "] " + (role ?? (style(el).cursor === "pointer" ? "clickable" : el.tagName.toLowerCase()));
		const name = clip(nameOf(el), 80);
		if (name) line += ' "' + name + '"';
		if (role === "link") { const href = el.getAttribute("href"); if (href && !href.startsWith("javascript:")) line += " -> " + clip(href, 90); }
		if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
			const type = el.tagName === "TEXTAREA" ? "textarea" : el.type;
			if (type === "checkbox" || type === "radio") { if (el.checked) line += " (checked)"; }
			else if (!["button", "submit", "reset", "image"].includes(type)) {
				if (el.value) line += ' = "' + (type === "password" ? "••••" : clip(el.value, 60)) + '"';
				else if (el.placeholder && !name.includes(el.placeholder)) line += ' placeholder "' + clip(el.placeholder, 40) + '"';
				if (!["text", "textarea", "search"].includes(type)) line += " [" + type + "]";
			}
		}
		if (el.tagName === "SELECT") {
			const chosen = el.selectedOptions?.[0]?.text;
			if (chosen) line += ' = "' + clip(chosen, 40) + '"';
			const options = [...el.options].map((option) => clip(option.text, 30));
			line += " options: " + options.slice(0, 12).join(" | ") + (options.length > 12 ? " … (" + options.length + ")" : "");
		}
		const expanded = el.getAttribute("aria-expanded");
		if (expanded) line += expanded === "true" ? " (expanded)" : " (collapsed)";
		if (["aria-checked", "aria-selected", "aria-pressed"].some((attr) => el.getAttribute(attr) === "true")) line += " (selected)";
		if (el.disabled || el.getAttribute("aria-disabled") === "true") line += " (disabled)";
		return line;
	};
	const visit = (node, depth) => {
		if (full) return;
		if (node.nodeType === 3) { const text = clip(node.textContent, 200); if (text) add(depth, text); return; }
		if (node.nodeType !== 1) return;
		const el = node;
		if (SKIP.has(el.tagName)) return;
		if (el.tagName === "SLOT") { for (const child of el.assignedNodes({ flatten: true })) visit(child, depth); return; }
		const s = style(el);
		if (s.display === "none") return;
		if (!shown(el) && !holders.has(el)) return;
		const role = roleOf(el);
		if (clickable.has(el)) {
			add(depth, control(el, role));
			if (holders.has(el)) walk(el, depth + 1);
			return;
		}
		if (role === "heading") {
			const level = Number(el.getAttribute("aria-level") ?? el.tagName.slice(1)) || 2;
			add(depth, "#".repeat(Math.min(level, 6)) + " " + clip(el.innerText, 120));
			if (holders.has(el)) walk(el, depth + 1);
			return;
		}
		if (el.tagName === "IMG") { const alt = clip(el.alt, 80); if (alt) add(depth, 'img "' + alt + '"'); return; }
		if (el.tagName === "IFRAME") { add(depth, "iframe " + clip(el.src, 90)); return; }
		if (el.namespaceURI === "http://www.w3.org/2000/svg") { const title = clip(el.querySelector("title")?.textContent, 60); if (title) add(depth, 'svg "' + title + '"'); return; }
		if (el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA") return;
		const landmark = LANDMARKS[el.tagName] ?? (el.getAttribute("role") === "dialog" ? "dialog" : undefined);
		if (landmark) {
			const label = el.getAttribute("aria-label");
			add(depth, landmark + (label ? ' "' + clip(label, 60) + '"' : "") + ":");
			walk(el, depth + 1);
			return;
		}
		if (!holders.has(el) && !s.display.startsWith("inline")) {
			const text = el.innerText ?? "";
			if (text.trim() === "") return;
			if (text.length <= 300 || el.children.length === 0) { add(depth, clip(text, 500)); return; }
		}
		walk(el, depth);
	};
	const walk = (el, depth) => { for (const child of (el.shadowRoot ?? el).childNodes) visit(child, depth); };
	if (document.body) walk(document.body, 0);
	const scrolling = document.scrollingElement ?? document.documentElement;
	return { lines: lines.join("\n"), truncated: full, controls: count, scrollY: Math.round(scrollY), scrollHeight: Math.round(scrolling.scrollHeight), innerHeight: Math.round(innerHeight) };
})()`;

/**
 * Finds what Pi points at, scrolls it into view, and returns its middle in screen coordinates (CSS pixels of the
 * visual viewport, which mouse events use), with a short description and what covers it, if anything.
 */
const LOCATE_SCRIPT = String.raw`(async (target) => {
	const clip = (text, max) => { const flat = String(text ?? "").replace(/\s+/g, " ").trim(); return flat.length > max ? flat.slice(0, max - 1) + "…" : flat; };
	const describe = (el) => {
		const name = clip(el.getAttribute("aria-label") || el.innerText || el.value || el.getAttribute("placeholder") || el.getAttribute("title") || "", 60);
		return el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (name ? ' "' + name + '"' : "");
	};
	let el = null;
	if (target.ref) {
		el = window.__piPocketRefs?.get(target.ref)?.deref() ?? null;
		if (!el || !el.isConnected) throw new Error("No element " + target.ref + " on the page now: take a new snapshot.");
	} else if (target.selector) {
		el = document.querySelector(target.selector);
		if (!el) throw new Error("Nothing matches the selector " + target.selector + ".");
	} else if (target.label) {
		const want = target.label.replace(/\s+/g, " ").trim().toLowerCase();
		const text = (each) => (each.getAttribute("aria-label") || each.innerText || each.value || each.getAttribute("placeholder") || each.getAttribute("title") || "").replace(/\s+/g, " ").trim().toLowerCase();
		const seen = (each) => each.getClientRects().length > 0 && getComputedStyle(each).visibility !== "hidden";
		const controls = [...document.querySelectorAll('a[href], button, input:not([type=hidden]), select, textarea, summary, label, [role], [onclick], [tabindex]')].filter(seen);
		el = controls.find((each) => text(each) === want) ?? controls.find((each) => text(each).includes(want)) ?? null;
		if (!el) {
			const all = [...document.body.querySelectorAll("*")].filter((each) => each.children.length === 0 && seen(each) && text(each).includes(want));
			el = all.find((each) => text(each) === want) ?? all[0] ?? null;
		}
		if (!el) throw new Error('Nothing on the page says "' + target.label + '".');
		// A label stands for its field.
		if (el.tagName === "LABEL" && el.control) el = el.control;
	}
	el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
	await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
	const box = el.getBoundingClientRect();
	if (box.width === 0 && box.height === 0) throw new Error(describe(el) + " is not visible.");
	const x = box.left + box.width / 2;
	const y = box.top + box.height / 2;
	const hit = document.elementFromPoint(x, y);
	const covered = hit && hit !== el && !el.contains(hit) && !hit.contains(el) ? describe(hit) : undefined;
	const view = window.visualViewport;
	const scale = view?.scale ?? 1;
	return { x: (x - (view?.offsetLeft ?? 0)) * scale, y: (y - (view?.offsetTop ?? 0)) * scale, label: describe(el), covered, editable: el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) };
})`;

/**
 * Selects what the focused field holds, so typed text replaces it: "selected", "empty", "none" (not a field), or "keys"
 * for a field a script cannot select (email, number), which the editor's select-all shortcut selects instead.
 */
const SELECT_ALL_SCRIPT = String.raw`(() => {
	const el = document.activeElement;
	if (!el) return "none";
	if (["INPUT", "TEXTAREA"].includes(el.tagName)) {
		if (el.value === "") return "empty";
		try { el.select(); return "selected"; } catch { return "keys"; }
	}
	if (el.isContentEditable) {
		if ((el.textContent ?? "") === "") return "empty";
		const range = document.createRange(); range.selectNodeContents(el); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
		return "selected";
	}
	return "none";
})()`;

/** Picks an option of a select element by its value or text. */
const SELECT_OPTION_SCRIPT = String.raw`((target, wanted) => {
	const el = target.ref ? window.__piPocketRefs?.get(target.ref)?.deref() : target.selector ? document.querySelector(target.selector) : document.activeElement;
	if (!el) throw new Error("No such element: take a new snapshot.");
	if (el.tagName !== "SELECT") throw new Error("That is a " + el.tagName.toLowerCase() + ", not a select element: click it instead.");
	const want = String(wanted).trim().toLowerCase();
	const option = [...el.options].find((each) => each.value === wanted) ?? [...el.options].find((each) => each.text.trim().toLowerCase() === want) ?? [...el.options].find((each) => each.text.toLowerCase().includes(want));
	if (!option) throw new Error('No option "' + wanted + '". Options: ' + [...el.options].map((each) => each.text.trim()).join(" | "));
	el.value = option.value;
	el.dispatchEvent(new Event("input", { bubbles: true }));
	el.dispatchEvent(new Event("change", { bubbles: true }));
	return option.text.trim();
})`;

/** A value as text for Pi: JSON, with elements as their opening tags. */
const DESCRIBE_FUNCTION = String.raw`function () {
	const seen = new WeakSet();
	const node = (value) => value.nodeType === 1 ? value.outerHTML.slice(0, 200) + (value.outerHTML.length > 200 ? "…" : "") : String(value.textContent ?? value.nodeName);
	if (this instanceof Node) return node(this);
	try {
		return JSON.stringify(this, (key, value) => {
			if (value instanceof Node) return node(value);
			if (typeof value === "function") return "[function " + (value.name || "anonymous") + "]";
			if (typeof value === "bigint") return value.toString() + "n";
			if (value && typeof value === "object") { if (seen.has(value)) return "[circular]"; seen.add(value); }
			return value;
		}, 2) ?? String(this);
	} catch (error) {
		return String(this);
	}
}`;

/** One conversation's page. Everything it knows comes from the browser's events; nothing here is stored. */
export class BrowserPage {
	readonly conversationId: number;
	readonly #connection: Connection;
	readonly #session: string;
	readonly #target: string;
	readonly #context: string;
	readonly #baseAgent: string;
	readonly #changed: () => void;
	readonly #saved: (saved: Saved) => void;
	#frameId = "";
	#url = "about:blank";
	#title = "";
	#loading = false;
	#starts = 0;
	#stops = 0;
	readonly #stopWaiters = new Set<() => void>();
	#viewport: Viewport;
	#canGoBack = false;
	#canGoForward = false;
	#logs: LogEntry[] = [];
	#logSeq = 0;
	#errors = 0;
	#crashed = false;
	#closed = false;
	#frame: Frame | undefined;
	readonly #frameWaiters = new Set<() => void>();
	#watchers = 0;
	#watchedAt = 0;
	#casting = false;
	#castTimer: NodeJS.Timeout | undefined;
	#historyTimer: NodeJS.Timeout | undefined;
	#saveTimer: NodeJS.Timeout | undefined;
	/** Last time Pi or a person used this page; idle pages close. */
	usedAt = Date.now();
	readonly #popups = new Map<string, NodeJS.Timeout>();
	/** Tabs already sent here or closed, until the browser says they are gone: their later updates change nothing. */
	readonly #handled = new Set<string>();

	constructor(options: {
		conversationId: number;
		connection: Connection;
		session: string;
		target: string;
		context: string;
		userAgent: string;
		viewport: Viewport;
		changed: () => void;
		saved: (saved: Saved) => void;
	}) {
		this.conversationId = options.conversationId;
		this.#connection = options.connection;
		this.#session = options.session;
		this.#target = options.target;
		this.#context = options.context;
		this.#baseAgent = options.userAgent;
		this.#viewport = options.viewport;
		this.#changed = options.changed;
		this.#saved = options.saved;
		this.#connection.listen(this.#session, (method, params) => this.#event(method, params));
	}

	get targetId(): string {
		return this.#target;
	}

	get contextId(): string {
		return this.#context;
	}

	get closed(): boolean {
		return this.#closed || this.#connection.closed;
	}

	get url(): string {
		return this.#url;
	}

	get title(): string {
		return this.#title;
	}

	get viewport(): Viewport {
		return { ...this.#viewport };
	}

	#send(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<Json> {
		if (this.#closed) return Promise.reject(new BrowserError("This page is closed."));
		return this.#connection.send(method, params, this.#session, timeoutMs);
	}

	async init(): Promise<void> {
		await Promise.all([this.#send("Page.enable"), this.#send("Runtime.enable"), this.#send("Log.enable")]);
		const tree = await this.#send("Page.getFrameTree");
		this.#frameId = String(tree.frameTree?.frame?.id ?? "");
		await this.#applyViewport();
	}

	state(available: boolean): BrowserState {
		return {
			available,
			open: !this.closed,
			url: this.#url,
			title: this.#title,
			loading: this.#loading,
			viewport: { ...this.#viewport },
			...(presetOf(this.#viewport) === undefined ? {} : { preset: presetOf(this.#viewport) }),
			canGoBack: this.#canGoBack,
			canGoForward: this.#canGoForward,
			errors: this.#errors,
			logs: this.#logSeq,
			...(this.#crashed ? { problem: "The page crashed. Reload it." } : {}),
		};
	}

	// ─── Events ─────────────────────────────────────────────────────────────

	#event(method: string, params: Json): void {
		switch (method) {
			case "Page.frameNavigated": {
				const frame = params.frame;
				if (frame === undefined || frame.parentId !== undefined) return;
				this.#frameId = frame.id;
				// A page that failed to load shows Chromium's error page; the address is still the one asked for.
				this.#url = String(frame.unreachableUrl ?? `${frame.url}${frame.urlFragment ?? ""}`);
				this.#errors = 0;
				this.#crashed = false;
				this.#log("nav", this.#url);
				this.#navigated();
				return;
			}
			case "Page.navigatedWithinDocument":
				if (params.frameId !== this.#frameId) return;
				this.#url = String(params.url);
				this.#navigated();
				return;
			case "Page.frameStartedLoading":
				if (params.frameId !== this.#frameId) return;
				this.#starts++;
				if (this.#loading) return;
				this.#loading = true;
				this.#changed();
				return;
			case "Page.frameStoppedLoading":
				if (params.frameId !== this.#frameId) return;
				this.#loading = false;
				this.#stops++;
				for (const wake of this.#stopWaiters) wake();
				this.#stopWaiters.clear();
				this.#changed();
				return;
			case "Page.javascriptDialogOpening": {
				// Nobody can answer a dialog in a headless page, and it would stop the page: accept it, and say so.
				this.#log("dialog", `${params.type}: ${params.message}`);
				void this.#send("Page.handleJavaScriptDialog", { accept: true, ...(params.type === "prompt" ? { promptText: String(params.defaultPrompt ?? "") } : {}) }).catch(() => {});
				return;
			}
			case "Page.screencastFrame":
				this.#onFrame(params);
				return;
			case "Runtime.consoleAPICalled": {
				const level = params.type === "warning" ? "warn" : params.type === "assert" ? "error" : String(params.type);
				if (level === "clear") return;
				const frame = params.stackTrace?.callFrames?.[0];
				this.#log(level, (params.args ?? []).map(formatArg).join(" "), frame === undefined ? undefined : `${frame.url}:${frame.lineNumber + 1}`);
				return;
			}
			case "Runtime.exceptionThrown": {
				const details = params.exceptionDetails ?? {};
				const text = String(details.exception?.description ?? details.text ?? "Uncaught error").split("\n    at ")[0] ?? "";
				this.#log("error", text.startsWith("Uncaught") ? text : `Uncaught ${text}`, details.url ? `${details.url}:${(details.lineNumber ?? 0) + 1}` : undefined);
				return;
			}
			case "Log.entryAdded": {
				const entry = params.entry ?? {};
				// The browser asks every site for an icon by itself; most dev servers have none. Not the page's error.
				if (entry.source === "network" && /\/favicon\.ico([?#]|$)/.test(String(entry.url ?? ""))) return;
				const level = entry.level === "warning" ? "warn" : entry.level === "verbose" ? "debug" : String(entry.level ?? "info");
				this.#log(level, String(entry.text ?? ""), entry.url ? String(entry.url) : undefined);
				return;
			}
			case "Inspector.targetCrashed":
				this.#crashed = true;
				this.#loading = false;
				this.#changed();
				return;
		}
	}

	/** The browser's own events about this page's target, and popups it opened. */
	targetEvent(method: string, info: Json): void {
		if (info?.targetId === this.#target) {
			if (method === "Target.targetInfoChanged") {
				const title = String(info.title ?? "");
				// Until a page has a title, Chromium reports its address as one.
				const next = title === info.url || title === this.#url.replace(/^https?:\/\//, "") ? "" : title;
				if (next !== this.#title) {
					this.#title = next;
					this.#changed();
				}
			}
			return;
		}
		const id = String(info?.targetId);
		// The browser says only which tab is gone.
		if (method === "Target.targetDestroyed") {
			clearTimeout(this.#popups.get(id));
			this.#popups.delete(id);
			this.#handled.delete(id);
			return;
		}
		if (info?.type !== "page" || info.browserContextId !== this.#context) return;
		// Pages the browser prerenders on a site's hint are its guesses, not tabs; and only this page's tabs come here.
		if ((info.subtype ?? "") !== "" || (info.openerId !== undefined && info.openerId !== this.#target) || this.#handled.has(id)) return;
		// One page per conversation: a popup or new tab opens here instead, once it has an address.
		const url = String(info.url ?? "");
		if (method === "Target.targetCreated" || method === "Target.targetInfoChanged") {
			if (!this.#popups.has(id)) {
				const timer = setTimeout(() => this.#closePopup(id), 5000);
				timer.unref();
				this.#popups.set(id, timer);
			}
			if (url !== "" && url !== "about:blank") {
				this.#closePopup(id);
				// Opened from here, the address would skip the browser's own rules (a web page may not open a file): only
				// web addresses follow, and files from a page that is a file itself.
				const web = /^https?:/i.test(url) || (/^file:/i.test(url) && /^file:/i.test(this.#url));
				if (web) void this.navigate(url, { wait: false }).catch(() => {});
				else this.#log("warn", `A new tab for ${url} was not opened.`);
			}
		}
	}

	#closePopup(targetId: string): void {
		clearTimeout(this.#popups.get(targetId));
		this.#popups.delete(targetId);
		this.#handled.add(targetId);
		void this.#connection.send("Target.closeTarget", { targetId }).catch(() => {});
	}

	#log(level: string, text: string, source?: string): void {
		const entry: LogEntry = { seq: ++this.#logSeq, at: Date.now(), level, text: text.length > 2000 ? `${text.slice(0, 1999)}…` : text, ...(source === undefined || source === "" ? {} : { source }) };
		this.#logs.push(entry);
		if (this.#logs.length > MAX_LOGS) this.#logs.splice(0, this.#logs.length - MAX_LOGS);
		if (level === "error") this.#errors++;
		this.#changed();
	}

	#navigated(): void {
		this.#changed();
		clearTimeout(this.#historyTimer);
		this.#historyTimer = setTimeout(() => void this.#refreshHistory(), 50);
		this.#historyTimer.unref();
		clearTimeout(this.#saveTimer);
		this.#saveTimer = setTimeout(() => this.#save(), 1000);
		this.#saveTimer.unref();
	}

	#save(): void {
		if (this.#closed) return;
		const url = this.#url;
		this.#saved({ ...(url === "about:blank" || url.startsWith("chrome-error:") ? {} : { url }), viewport: { ...this.#viewport } });
	}

	async #refreshHistory(): Promise<void> {
		try {
			const history = await this.#send("Page.getNavigationHistory");
			const back = history.currentIndex > 0;
			const forward = history.currentIndex < history.entries.length - 1;
			const entry = history.entries[history.currentIndex];
			// A page without a title has its address as one.
			const title = entry === undefined || entry.title === entry.url ? "" : String(entry.title ?? "");
			if (back !== this.#canGoBack || forward !== this.#canGoForward || title !== this.#title) {
				this.#canGoBack = back;
				this.#canGoForward = forward;
				this.#title = title;
				this.#changed();
			}
		} catch {
			// Closed meanwhile.
		}
	}

	// ─── Frames for the Browser panel ─────────────────────────────────────

	#onFrame(params: Json): void {
		const meta = params.metadata ?? {};
		this.#frame = {
			seq: ++frameCount,
			data: Buffer.from(String(params.data ?? ""), "base64"),
			width: Math.round(meta.deviceWidth ?? this.#viewport.width),
			height: Math.round(meta.deviceHeight ?? this.#viewport.height),
		};
		for (const wake of this.#frameWaiters) wake();
		this.#frameWaiters.clear();
		// The next frame comes after this one is acknowledged: acknowledging a little later caps the frame rate.
		const timer = setTimeout(() => {
			if (this.#casting) void this.#send("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => {});
		}, FRAME_GAP_MS);
		timer.unref();
	}

	async #startCast(): Promise<void> {
		if (this.#casting || this.closed) return;
		this.#casting = true;
		const scale = Math.min(this.#viewport.scale, 2);
		try {
			await this.#send("Page.startScreencast", {
				format: "jpeg",
				quality: 65,
				maxWidth: Math.round(this.#viewport.width * scale),
				maxHeight: Math.round(this.#viewport.height * scale),
			});
		} catch {
			this.#casting = false;
			return;
		}
		clearInterval(this.#castTimer);
		this.#castTimer = setInterval(() => {
			if (this.#watchers === 0 && Date.now() - this.#watchedAt > WATCH_MS) void this.#stopCast();
		}, 5000);
		this.#castTimer.unref();
	}

	async #stopCast(): Promise<void> {
		clearInterval(this.#castTimer);
		this.#castTimer = undefined;
		if (!this.#casting) return;
		this.#casting = false;
		await this.#send("Page.stopScreencast").catch(() => {});
	}

	/** The newest frame after `after`, waiting for one up to 25 seconds; undefined if none came. */
	async frame(after: number, signal?: AbortSignal): Promise<Frame | undefined> {
		// A number from before a restart: this tab has none of these frames.
		if (after > frameCount) after = 0;
		this.#watchedAt = Date.now();
		this.usedAt = Date.now();
		this.#watchers++;
		try {
			await this.#startCast();
			if (this.#frame !== undefined && this.#frame.seq > after) return this.#frame;
			if (this.closed) return undefined;
			await new Promise<void>((done) => {
				const finish = () => {
					clearTimeout(timer);
					signal?.removeEventListener("abort", finish);
					this.#frameWaiters.delete(finish);
					done();
				};
				const timer = setTimeout(finish, FRAME_WAIT_MS);
				signal?.addEventListener("abort", finish, { once: true });
				this.#frameWaiters.add(finish);
			});
			return this.#frame !== undefined && this.#frame.seq > after ? this.#frame : undefined;
		} finally {
			this.#watchers--;
			this.#watchedAt = Date.now();
		}
	}

	/**
	 * Taps, drags, scrolls, and keys from the Browser panel, in order: `click`, `mouse` (down, up, or move), `wheel`, `key`,
	 * and `text`, at CSS pixels of the viewport. They come from browsers, so each is checked as it is read.
	 */
	async input(events: readonly unknown[]): Promise<void> {
		this.usedAt = Date.now();
		const { width, height } = this.#viewport;
		const point = (raw: Record<string, unknown>) => ({
			x: clamp(Number(raw.x) || 0, 0, width),
			y: clamp(Number(raw.y) || 0, 0, height),
		});
		const button = (raw: unknown) => (raw === "right" || raw === "middle" ? raw : "left");
		for (const item of events) {
			if (typeof item !== "object" || item === null) continue;
			const event = item as Record<string, unknown>;
			switch (event.type) {
				case "click":
					await this.#click(point(event), button(event.button), clamp(Number(event.count) || 1, 1, 3));
					break;
				case "mouse": {
					const at = point(event);
					const pressed = button(event.button);
					const type = event.action === "down" ? "mousePressed" : event.action === "up" ? "mouseReleased" : "mouseMoved";
					const count = clamp(Number(event.count) || 1, 1, 3);
					await this.#send("Input.dispatchMouseEvent", {
						type,
						...at,
						button: type === "mouseMoved" && event.pressed !== true ? "none" : pressed,
						buttons: event.pressed === true || type === "mousePressed" ? 1 : 0,
						clickCount: type === "mouseMoved" ? 0 : count,
					});
					break;
				}
				case "wheel":
					await this.#send("Input.dispatchMouseEvent", { type: "mouseWheel", ...point(event), deltaX: clamp(Number(event.dx) || 0, -5000, 5000), deltaY: clamp(Number(event.dy) || 0, -5000, 5000) });
					break;
				case "key": {
					const key = String(event.key ?? "");
					if (key === "" || key === "Unidentified" || key === "Dead" || key === "Process") break;
					if (key.length !== 1 && KEYS[key] === undefined) break;
					await this.#key(key, clamp(Number(event.modifiers) || 0, 0, 15));
					break;
				}
				case "text": {
					const text = String(event.text ?? "").slice(0, 10_000);
					if (text !== "") await this.#send("Input.insertText", { text });
					break;
				}
			}
		}
	}

	async #click(at: { x: number; y: number }, button: string, count: number): Promise<void> {
		await this.#send("Input.dispatchMouseEvent", { type: "mouseMoved", ...at, button: "none" });
		for (let index = 1; index <= count; index++) {
			await this.#send("Input.dispatchMouseEvent", { type: "mousePressed", ...at, button, buttons: 1, clickCount: index });
			await this.#send("Input.dispatchMouseEvent", { type: "mouseReleased", ...at, button, buttons: 0, clickCount: index });
		}
	}

	async #key(key: string, modifiers: number): Promise<void> {
		const { down, up } = keyEvents(key, modifiers);
		await this.#send("Input.dispatchKeyEvent", down);
		await this.#send("Input.dispatchKeyEvent", up);
	}

	// ─── Navigation ───────────────────────────────────────────────────────────

	/** Where loading stands before an action, to tell the loads it started from those already going on. */
	#mark(): { starts: number; stops: number } {
		return { starts: this.#starts, stops: this.#stops };
	}

	/**
	 * Wait for the load an action started, until it stops; false when that took longer than `timeoutMs`. A load that was
	 * going on before (a request that never ends) does not count. With `started`, the action surely started one.
	 */
	async #settle(mark: { starts: number; stops: number }, timeoutMs: number, signal?: AbortSignal, started = false): Promise<boolean> {
		if (!started) {
			// A navigation a click starts begins a moment later.
			await wait(150);
			if (this.#starts === mark.starts) return true;
		}
		if (this.#stops > mark.stops && !this.#loading) return true;
		return new Promise((done) => {
			const finish = (ok: boolean) => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", stop);
				this.#stopWaiters.delete(wake);
				done(ok);
			};
			const wake = () => finish(true);
			const stop = () => finish(false);
			const timer = setTimeout(stop, timeoutMs);
			signal?.addEventListener("abort", stop, { once: true });
			this.#stopWaiters.add(wake);
		});
	}

	/**
	 * Open an address. With `wait`, until it has loaded (or `timeoutMs` passed); without, only as long as it takes to
	 * hear whether it failed at once (nothing answers there), at most a few seconds. The result says how it went.
	 */
	async navigate(url: string, options: { wait?: boolean; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<{ error?: string; status?: number; slow?: boolean }> {
		this.usedAt = Date.now();
		const mark = this.#mark();
		const budget = options.wait === false ? 3000 : (options.timeoutMs ?? 30_000);
		// The browser answers once the page starts to arrive: a server that never responds keeps it waiting, while the
		// navigation goes on.
		const answer = this.#send("Page.navigate", { url }, 120_000);
		answer.catch(() => {});
		let timer: NodeJS.Timeout | undefined;
		const late = new Promise<undefined>((done) => {
			timer = setTimeout(() => done(undefined), budget);
		});
		const result = await Promise.race([answer, late]).finally(() => clearTimeout(timer));
		if (result === undefined) return options.wait === false ? {} : { slow: true };
		if (result.errorText) return { error: String(result.errorText) };
		if (options.wait === false || result.loaderId === undefined) return {};
		const loaded = await this.#settle(mark, options.timeoutMs ?? 30_000, options.signal, true);
		aborted(options.signal);
		// Apps fetch their data after the load event; give them a moment.
		await wait(300);
		const status = await this.#send("Runtime.evaluate", { expression: `performance.getEntriesByType("navigation")[0]?.responseStatus ?? 0`, returnByValue: true }).then(evaluated, () => 0);
		return { ...(typeof status === "number" && status > 0 ? { status } : {}), ...(loaded ? {} : { slow: true }) };
	}

	async go(delta: -1 | 1, options: { wait?: boolean; signal?: AbortSignal } = {}): Promise<boolean> {
		this.usedAt = Date.now();
		const history = await this.#send("Page.getNavigationHistory");
		const entry = history.entries?.[history.currentIndex + delta];
		if (entry === undefined) return false;
		const mark = this.#mark();
		await this.#send("Page.navigateToHistoryEntry", { entryId: entry.id });
		if (options.wait !== false) await this.#settle(mark, 30_000, options.signal);
		return true;
	}

	async reload(options: { wait?: boolean; signal?: AbortSignal } = {}): Promise<void> {
		this.usedAt = Date.now();
		this.#crashed = false;
		const mark = this.#mark();
		await this.#send("Page.reload", { ignoreCache: false });
		if (options.wait !== false) await this.#settle(mark, 30_000, options.signal, true);
	}

	async stop(): Promise<void> {
		await this.#send("Page.stopLoading");
	}

	async #applyViewport(): Promise<void> {
		const viewport = this.#viewport;
		const agent = viewport.mobile
			? `Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${/Chrome\/([\d.]+)/.exec(this.#baseAgent)?.[1] ?? "130.0.0.0"} Mobile Safari/537.36`
			: this.#baseAgent;
		await Promise.all([
			this.#send("Emulation.setDeviceMetricsOverride", { width: viewport.width, height: viewport.height, deviceScaleFactor: viewport.scale, mobile: viewport.mobile }),
			this.#send("Emulation.setTouchEmulationEnabled", { enabled: viewport.mobile, maxTouchPoints: viewport.mobile ? 5 : 1 }),
			agent === "" ? Promise.resolve() : this.#send("Emulation.setUserAgentOverride", { userAgent: agent }),
		]);
	}

	async setViewport(viewport: Viewport): Promise<void> {
		this.usedAt = Date.now();
		this.#viewport = { ...viewport };
		await this.#applyViewport();
		if (this.#casting) {
			await this.#stopCast();
			await this.#startCast();
		}
		this.#changed();
		this.#save();
	}

	// ─── What Pi does ─────────────────────────────────────────────────────────

	async #evaluate(expression: string, timeoutMs = 15_000): Promise<Json> {
		return evaluated(await this.#send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true }, timeoutMs));
	}

	/** Where a target is on screen, scrolled into view. */
	async locate(target: Target): Promise<{ x: number; y: number; label: string; covered?: string; editable?: boolean }> {
		if (typeof target.x === "number" && typeof target.y === "number") return { x: target.x, y: target.y, label: `the point ${Math.round(target.x)},${Math.round(target.y)}` };
		if (target.ref === undefined && target.selector === undefined && target.label === undefined) throw new BrowserError("Say what to act on: a ref from the snapshot, a selector, a label, or x and y.");
		return await this.#evaluate(`(${LOCATE_SCRIPT})(${JSON.stringify(target)})`);
	}

	async click(target: Target, options: { count?: number; signal?: AbortSignal } = {}): Promise<{ label: string; covered?: string; navigated: boolean }> {
		this.usedAt = Date.now();
		const found = await this.locate(target);
		const url = this.#url;
		const mark = this.#mark();
		await this.#click({ x: found.x, y: found.y }, "left", options.count ?? 1);
		await this.#settle(mark, 10_000, options.signal);
		return { label: found.label, ...(found.covered === undefined ? {} : { covered: found.covered }), navigated: this.#url !== url };
	}

	async hover(target: Target): Promise<string> {
		this.usedAt = Date.now();
		const found = await this.locate(target);
		await this.#send("Input.dispatchMouseEvent", { type: "mouseMoved", x: found.x, y: found.y, button: "none" });
		await wait(150);
		return found.label;
	}

	/** Type into a target (clicking it first), or into what has focus. Replaces what the field holds unless `append`. */
	async type(target: Target | undefined, text: string, options: { append?: boolean; submit?: boolean; signal?: AbortSignal } = {}): Promise<string> {
		this.usedAt = Date.now();
		let label = "the focused element";
		if (target !== undefined && (target.ref ?? target.selector ?? target.label ?? target.x) !== undefined) {
			const found = await this.locate(target);
			await this.#click({ x: found.x, y: found.y }, "left", 1);
			label = found.label;
		}
		if (options.append !== true) {
			const field = await this.#evaluate(SELECT_ALL_SCRIPT);
			// Some fields (email, number) cannot be selected by script: the editor's select-all works on them.
			if (field === "keys") await this.#key("a", 2);
			if ((field === "selected" || field === "keys") && text === "") await this.#key("Backspace", 0);
		}
		if (text !== "") await this.#send("Input.insertText", { text });
		if (options.submit === true) {
			const mark = this.#mark();
			await this.#key("Enter", 0);
			await this.#settle(mark, 10_000, options.signal);
		}
		return label;
	}

	async press(combo: string, options: { signal?: AbortSignal } = {}): Promise<void> {
		this.usedAt = Date.now();
		const { key, modifiers } = parseKeys(combo);
		const mark = this.#mark();
		await this.#key(key, modifiers);
		await this.#settle(mark, 10_000, options.signal);
	}

	async select(target: Target, value: string): Promise<string> {
		this.usedAt = Date.now();
		return String(await this.#evaluate(`(${SELECT_OPTION_SCRIPT})(${JSON.stringify(target)}, ${JSON.stringify(value)})`));
	}

	/** Scroll a target into view, or the page by `dy` pixels (a screen down by default). */
	async scroll(target: Target | undefined, dy?: number): Promise<string> {
		this.usedAt = Date.now();
		if (target !== undefined && (target.ref ?? target.selector ?? target.label) !== undefined) return (await this.locate(target)).label;
		const amount = dy ?? Math.round(this.#viewport.height * 0.8);
		await this.#send("Input.dispatchMouseEvent", { type: "mouseWheel", x: this.#viewport.width / 2, y: this.#viewport.height / 2, deltaX: 0, deltaY: amount });
		await wait(250);
		return `${amount >= 0 ? "down" : "up"} ${Math.abs(amount)}px`;
	}

	async snapshot(): Promise<{ lines: string; truncated: boolean; controls: number; scrollY: number; scrollHeight: number; innerHeight: number }> {
		this.usedAt = Date.now();
		return await this.#evaluate(SNAPSHOT_SCRIPT, 20_000);
	}

	/** A JPEG of the viewport, or of the whole page (up to 8000 CSS pixels tall), in CSS pixels. */
	async screenshot(options: { fullPage?: boolean } = {}): Promise<{ data: string; width: number; height: number }> {
		this.usedAt = Date.now();
		const scale = 1 / this.#viewport.scale;
		if (options.fullPage === true) {
			const metrics = await this.#send("Page.getLayoutMetrics");
			const size = metrics.cssContentSize ?? metrics.contentSize;
			const width = Math.ceil(size.width);
			const height = Math.min(Math.ceil(size.height), 8000);
			const shot = await this.#send("Page.captureScreenshot", { format: "jpeg", quality: 80, captureBeyondViewport: true, clip: { x: 0, y: 0, width, height, scale } }, 60_000);
			return { data: String(shot.data), width, height };
		}
		const metrics = await this.#send("Page.getLayoutMetrics");
		const view = metrics.cssVisualViewport ?? { pageX: 0, pageY: 0, clientWidth: this.#viewport.width, clientHeight: this.#viewport.height, scale: 1 };
		const zoom = view.scale ?? 1;
		const shot = await this.#send(
			"Page.captureScreenshot",
			{ format: "jpeg", quality: 80, clip: { x: view.pageX, y: view.pageY, width: view.clientWidth, height: view.clientHeight, scale: scale * zoom } },
			60_000,
		);
		return { data: String(shot.data), width: this.#viewport.width, height: this.#viewport.height };
	}

	/** Run JavaScript in the page: an expression or statements (top-level await works), or a body that uses `return`. */
	async evaluate(script: string, options: { timeoutMs?: number } = {}): Promise<string> {
		this.usedAt = Date.now();
		const run = (expression: string, replMode: boolean) =>
			this.#send(
				"Runtime.evaluate",
				{ expression, replMode, awaitPromise: true, userGesture: true, objectGroup: "pi-pocket", generatePreview: false, timeout: options.timeoutMs ?? 30_000 },
				(options.timeoutMs ?? 30_000) + 5000,
			);
		// REPL mode, as in DevTools' console: top-level await works and names can be declared again. A body that returns
		// its result is not a script there; it runs as a function, outside REPL mode, which would not await its promise.
		let response = await run(script, true);
		if (/Illegal return statement/.test(String(response.exceptionDetails?.exception?.description ?? ""))) response = await run(`(async () => {\n${script}\n})()`, false);
		try {
			if (response.exceptionDetails !== undefined) evaluated(response);
			const result = response.result ?? {};
			if (result.type === "undefined") return "undefined";
			if (result.objectId === undefined) {
				if (result.unserializableValue !== undefined) return String(result.unserializableValue);
				return typeof result.value === "string" ? result.value : JSON.stringify(result.value);
			}
			const described = await this.#send("Runtime.callFunctionOn", { objectId: result.objectId, functionDeclaration: DESCRIBE_FUNCTION, returnByValue: true });
			return String(described.result?.value ?? result.description ?? "");
		} finally {
			void this.#send("Runtime.releaseObjectGroup", { objectGroup: "pi-pocket" }).catch(() => {});
		}
	}

	/** Wait for text or an element to show up, or a number of milliseconds. */
	async waitFor(options: { text?: string; selector?: string; ms?: number; timeoutMs?: number; signal?: AbortSignal }): Promise<boolean> {
		this.usedAt = Date.now();
		if (options.text === undefined && options.selector === undefined) {
			await wait(clamp(options.ms ?? 1000, 0, 30_000));
			return true;
		}
		const check =
			options.selector !== undefined
				? `(() => { const el = document.querySelector(${JSON.stringify(options.selector)}); return !!el && el.getClientRects().length > 0; })()`
				: `(document.body?.innerText ?? "").toLowerCase().includes(${JSON.stringify(options.text!.toLowerCase())})`;
		const until = Date.now() + clamp(options.timeoutMs ?? 10_000, 0, 60_000);
		while (true) {
			aborted(options.signal);
			if ((await this.#evaluate(check).catch(() => false)) === true) return true;
			if (Date.now() >= until) return false;
			await wait(200);
		}
	}

	/** Console lines after `after` (all of them by default). */
	logs(after = 0): LogEntry[] {
		return this.#logs.filter((entry) => entry.seq > after);
	}

	get logSeq(): number {
		return this.#logSeq;
	}

	clearLogs(): void {
		this.#logs = [];
		this.#errors = 0;
		// Counted as a change, so the panel fetches the (empty) console again.
		this.#logSeq++;
		this.#changed();
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#casting = false;
		clearInterval(this.#castTimer);
		clearTimeout(this.#historyTimer);
		clearTimeout(this.#saveTimer);
		for (const timer of this.#popups.values()) clearTimeout(timer);
		for (const wake of this.#frameWaiters) wake();
		for (const wake of this.#stopWaiters) wake();
		this.#connection.unlisten(this.#session);
		this.#changed();
	}
}

// ─── Every conversation's page ──────────────────────────────────────────

export type OpenOptions = {
	/** The size of a page that has no saved size. */
	viewport?: Viewport;
	/** Open the saved address again (default), or (false) start blank. */
	restore?: boolean;
	/** Wait for the saved address to load (default), or (false) only start loading it. */
	wait?: boolean;
};

export interface BrowsersOptions {
	/** Where the browser's profile goes: `browser/` in it. */
	dataDir: string;
	/** The browser to run. Undefined finds one; null means there is none (tests). */
	executable?: string | null;
	/** Extra Chromium flags, such as `--no-sandbox` where sandboxes are not available. */
	args?: readonly string[];
	/** A conversation's saved address and size, to open its page again. */
	load?(conversationId: number): Promise<Saved | undefined>;
	/** Called when a page's address or size changed. */
	save?(conversationId: number, saved: Saved): void;
	log?(line: string): void;
	/** A page nobody used or watched for this long closes. */
	idleMs?: number;
}

/**
 * The browser and every conversation's page. The browser starts with the first page and stops a while after the last
 * one closes; pages close after a while unused.
 */
export class Browsers {
	readonly #options: BrowsersOptions;
	#executable: string | null | undefined;
	#chromium: Promise<Chromium> | undefined;
	readonly #pages = new Map<number, BrowserPage>();
	readonly #opening = new Map<number, Promise<BrowserPage>>();
	readonly #listeners = new Set<(conversationId: number, state: BrowserState) => void>();
	readonly #pending = new Map<number, NodeJS.Timeout>();
	readonly #problems = new Map<number, string>();
	readonly #reaper: NodeJS.Timeout;
	#idleSince = Date.now();
	#closing = false;
	/** Counts every closeAll: a page that began opening before one must not open after it. */
	#generation = 0;

	constructor(options: BrowsersOptions) {
		this.#options = options;
		this.#executable = options.executable;
		this.#reaper = setInterval(() => this.#reap(), 60_000);
		this.#reaper.unref();
	}

	/** The browser this machine has, if any. Looked up once. */
	get executable(): string | undefined {
		if (this.#executable === undefined) this.#executable = findBrowser() ?? null;
		return this.#executable ?? undefined;
	}

	get available(): boolean {
		return this.executable !== undefined;
	}

	subscribe(listener: (conversationId: number, state: BrowserState) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** A conversation's page as it is now; a closed one has no address. */
	state(conversationId: number): BrowserState {
		const page = this.#pages.get(conversationId);
		if (page !== undefined && !page.closed) return page.state(this.available);
		const problem = this.#problems.get(conversationId);
		return {
			available: this.available,
			open: false,
			url: "",
			title: "",
			loading: this.#opening.has(conversationId),
			viewport: { ...VIEWPORTS.desktop },
			preset: "desktop",
			canGoBack: false,
			canGoForward: false,
			errors: 0,
			logs: 0,
			...(problem === undefined ? {} : { problem }),
		};
	}

	/** The conversation's page if it is open. */
	page(conversationId: number): BrowserPage | undefined {
		const page = this.#pages.get(conversationId);
		return page === undefined || page.closed ? undefined : page;
	}

	/** Coalesce a page's changes: frames of logs and loads arrive in bursts. */
	#changed(conversationId: number): void {
		if (this.#pending.has(conversationId)) return;
		const timer = setTimeout(() => {
			this.#pending.delete(conversationId);
			const state = this.state(conversationId);
			for (const listener of this.#listeners) listener(conversationId, state);
		}, 120);
		timer.unref();
		this.#pending.set(conversationId, timer);
	}

	async #browser(): Promise<Chromium> {
		const executable = this.executable;
		if (executable === undefined) {
			throw new BrowserError("No Chromium-based browser was found on this machine. Install Chromium or Google Chrome, or set PI_POCKET_BROWSER to a browser's path.");
		}
		if (this.#chromium !== undefined) {
			const running = await this.#chromium.catch(() => undefined);
			if (running !== undefined && !running.connection.closed) return running;
		}
		if (this.#closing) throw new BrowserError("The server is stopping.");
		const extra = [...(this.#options.args ?? []), ...(process.env.PI_POCKET_BROWSER_ARGS?.split(/\s+/).filter(Boolean) ?? [])];
		const launching = Chromium.launch(executable, profileFolder(executable, this.#options.dataDir), extra);
		this.#chromium = launching;
		launching.catch(() => {
			if (this.#chromium === launching) this.#chromium = undefined;
		});
		const chromium = await launching;
		// The server began stopping while the browser started: nothing will stop this one later.
		if (this.#closing) {
			chromium.kill();
			throw new BrowserError("The server is stopping.");
		}
		this.#options.log?.(`Browser started: ${executable}`);
		chromium.connection.onEvent = (method, params) => {
			if (!method.startsWith("Target.")) return;
			const info = params.targetInfo ?? (method === "Target.targetDestroyed" ? { targetId: params.targetId } : undefined);
			if (info === undefined) return;
			for (const [id, page] of this.#pages) {
				// A page closed by its own script (window.close()) is gone, with its browser context.
				if (method === "Target.targetDestroyed" && info.targetId === page.targetId) void this.#discard(id, page);
				else page.targetEvent(method, info);
			}
		};
		chromium.connection.onClose = () => {
			if (this.#chromium === launching) this.#chromium = undefined;
			for (const page of this.#pages.values()) page.close();
		};
		return chromium;
	}

	/**
	 * The conversation's page, opened (and its saved address loaded again) if it was not. `viewport` sizes a page that
	 * has no saved size.
	 */
	async open(conversationId: number, options: OpenOptions = {}): Promise<BrowserPage> {
		if (this.#closing) throw new BrowserError("The server is stopping.");
		const open = this.page(conversationId);
		if (open !== undefined) return open;
		const opening = this.#opening.get(conversationId);
		if (opening !== undefined) return opening;
		const created = this.#create(conversationId, options);
		this.#opening.set(conversationId, created);
		this.#changed(conversationId);
		try {
			const page = await created;
			this.#problems.delete(conversationId);
			return page;
		} catch (error) {
			this.#problems.set(conversationId, error instanceof Error ? error.message : String(error));
			throw error;
		} finally {
			this.#opening.delete(conversationId);
			this.#changed(conversationId);
		}
	}

	async #create(conversationId: number, options: OpenOptions): Promise<BrowserPage> {
		const generation = this.#generation;
		const stale = () => this.#closing || this.#generation !== generation;
		const saved = await this.#options.load?.(conversationId).catch(() => undefined);
		if (stale()) throw new BrowserError("The browser was closed.");
		const chromium = await this.#browser();
		const connection = chromium.connection;
		const { browserContextId } = await connection.send("Target.createBrowserContext", { disposeOnDetach: false });
		let page: BrowserPage | undefined;
		try {
			await connection.send("Browser.setDownloadBehavior", { behavior: "deny", browserContextId }).catch(() => {});
			const { targetId } = await connection.send("Target.createTarget", { url: "about:blank", browserContextId });
			const { sessionId } = await connection.send("Target.attachToTarget", { targetId, flatten: true });
			page = new BrowserPage({
				conversationId,
				connection,
				session: sessionId,
				target: targetId,
				context: browserContextId,
				userAgent: chromium.userAgent,
				viewport: viewportFrom(saved?.viewport) ?? options.viewport ?? { ...VIEWPORTS.desktop },
				changed: () => this.#changed(conversationId),
				saved: (value) => this.#options.save?.(conversationId, value),
			});
			await page.init();
			if (stale()) {
				page.close();
				throw new BrowserError("The browser was closed.");
			}
			this.#pages.set(conversationId, page);
			this.#idleSince = Date.now();
			if (options.restore !== false && saved?.url !== undefined && saved.url !== "") {
				const restoring = page.navigate(saved.url, { timeoutMs: 15_000 }).catch(() => {});
				if (options.wait !== false) await restoring;
			}
			return page;
		} catch (error) {
			page?.close();
			void connection.send("Target.disposeBrowserContext", { browserContextId }).catch(() => {});
			throw error;
		}
	}

	/** Close a conversation's page. Its saved address stays, to open it again later. */
	async close(conversationId: number): Promise<void> {
		const page = this.#pages.get(conversationId);
		if (page !== undefined) await this.#discard(conversationId, page);
	}

	/** Forget a page and free its browser context, which holds its cookies and storage. */
	async #discard(conversationId: number, page: BrowserPage): Promise<void> {
		if (this.#pages.get(conversationId) === page) this.#pages.delete(conversationId);
		page.close();
		if (this.#pages.size === 0) this.#idleSince = Date.now();
		this.#changed(conversationId);
		const chromium = await this.#chromium?.catch(() => undefined);
		await chromium?.connection.send("Target.disposeBrowserContext", { browserContextId: page.contextId }).catch(() => {});
	}

	#reap(): void {
		const idle = this.#options.idleMs ?? 30 * 60_000;
		for (const [id, page] of this.#pages) {
			if (page.closed || Date.now() - page.usedAt > idle) void this.#discard(id, page);
		}
		// The browser itself stops a few minutes after its last page closed.
		if (this.#pages.size === 0 && this.#opening.size === 0 && this.#chromium !== undefined && Date.now() - this.#idleSince > 5 * 60_000) {
			void this.#stopBrowser();
		}
	}

	async #stopBrowser(): Promise<void> {
		const pending = this.#chromium;
		this.#chromium = undefined;
		const chromium = await pending?.catch(() => undefined);
		if (chromium === undefined) return;
		chromium.kill();
		await Promise.race([chromium.exited, wait(4000)]);
	}

	/** Close every page and stop the browser, as the server stops or the browser is turned off. */
	async closeAll(options: { final?: boolean } = {}): Promise<void> {
		this.#generation++;
		if (options.final === true) {
			this.#closing = true;
			clearInterval(this.#reaper);
		}
		const ids = [...this.#pages.keys()];
		for (const page of this.#pages.values()) page.close();
		this.#pages.clear();
		if (options.final === true) {
			// After the pages closed, which announces them: nobody listens any more.
			for (const timer of this.#pending.values()) clearTimeout(timer);
			this.#pending.clear();
		}
		await this.#stopBrowser();
		if (options.final !== true) for (const id of ids) this.#changed(id);
	}
}

// ─── Servers on this machine ────────────────────────────────────────────

/** TCP ports this machine listens on, from Linux's /proc; none elsewhere. `v6only`: listening on IPv6 alone. */
function listeningPorts(): Map<number, { v6only: boolean }> {
	const ports = new Map<number, { v4: boolean; v6: boolean }>();
	for (const [file, v6] of [
		["/proc/net/tcp", false],
		["/proc/net/tcp6", true],
	] as const) {
		let text: string;
		try {
			text = readFileSync(file, "utf8");
		} catch {
			continue;
		}
		for (const line of text.split("\n").slice(1)) {
			const fields = line.trim().split(/\s+/);
			if (fields[3] !== "0A") continue;
			const [address = "", hex = ""] = (fields[1] ?? "").split(":");
			const port = Number.parseInt(hex, 16);
			if (!Number.isInteger(port)) continue;
			// Loopback or every address: the ones this machine's browser reaches as localhost.
			const local = v6 ? /^(0{32}|0{24}01000000|0{16}FFFF0000(0{8}|[0-9A-F]{6}7F))$/i.test(address) : /^(00000000|[0-9A-F]{6}7F)$/i.test(address);
			if (!local) continue;
			const entry = ports.get(port) ?? { v4: false, v6: false };
			if (v6) entry.v6 = true;
			else entry.v4 = true;
			ports.set(port, entry);
		}
	}
	return new Map([...ports].map(([port, entry]) => [port, { v6only: entry.v6 && !entry.v4 }]));
}

/** Whether a port answers http, and the title of its page. */
function probe(port: number, v6only: boolean): Promise<{ title: string } | undefined> {
	return new Promise((done) => {
		const request = httpRequest({ host: v6only ? "::1" : "127.0.0.1", port, path: "/", method: "GET", timeout: 800, headers: { accept: "text/html" } }, (response) => {
			let body = "";
			response.setEncoding("utf8");
			response.on("data", (chunk: string) => {
				body += chunk;
				if (body.length > 65_536) response.destroy();
			});
			const finish = () => done({ title: (/<title[^>]*>([^<]*)<\/title>/i.exec(body)?.[1] ?? "").replace(/\s+/g, " ").trim().slice(0, 80) });
			response.on("end", finish);
			response.on("close", finish);
		});
		request.on("timeout", () => request.destroy());
		request.on("error", () => done(undefined));
		request.end();
	});
}

/**
 * Web servers running on this machine, such as a dev server, for the Browser panel to offer: ports from 1024 to 32767
 * that answer http, without `exclude` (Pi Pocket's own). Linux only.
 */
export async function localServers(exclude: readonly number[] = []): Promise<{ port: number; url: string; title: string }[]> {
	// Above 32767 are mostly the system's passing connections and services' private ports.
	const ports = [...listeningPorts()].filter(([port]) => port >= 1024 && port <= 32767 && !exclude.includes(port)).slice(0, 40);
	const found = await Promise.all(ports.map(async ([port, { v6only }]) => ({ port, answer: await probe(port, v6only) })));
	return found
		.filter((each) => each.answer !== undefined)
		.map((each) => ({ port: each.port, url: `http://localhost:${each.port}/`, title: each.answer!.title }))
		.sort((a, b) => a.port - b.port);
}
