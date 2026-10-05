/**
 * The files in a session's folder, for `@` mentions in the message box. In a git repository the list is git's: the
 * tracked files and the untracked ones it does not ignore. Elsewhere it is a walk of the folder that skips hidden and
 * dependency folders. A list is kept for a few seconds and shared by every tab, carries a version so a browser that
 * has the newest one hears only that, and is compressed once, however many browsers fetch it. Browsers match the list
 * themselves as people type: typing never waits on the network.
 */
import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { opendir } from "node:fs/promises";
import { promisify } from "node:util";
import { gzip as gzipCallback } from "node:zlib";
import { git } from "./git.ts";

const gzip = promisify(gzipCallback);

/** The most files a list holds. Past it, the files nearest the folder's top are kept. */
export const MAX_FILES = 100_000;
/**
 * The most files a walk outside git finds, and how long it may take. The count stops it first on a local disk, so an
 * unchanged folder gives the same list (and version) each time; the time is for slow ones.
 */
const WALK_FILES = 50_000;
const WALK_MS = 3_000;
/** A list is fresh for ten times what it took to make, within these bounds: a slow walk is not repeated every keystroke. */
const FRESH_MIN_MS = 2_000;
const FRESH_MAX_MS = 60_000;
/** How many folders' lists are kept. */
const KEEP = 16;
/** Folders a walk outside git skips: dependencies and build caches, which can hold more files than everything else. */
const SKIP = new Set(["node_modules", "__pycache__", "bower_components", "venv", "site-packages", "target", "dist-newstyle"]);

export type FileList = {
	/** Paths relative to the folder, with `/` between parts. */
	files: string[];
	/** True when the folder has more files than the list holds. */
	truncated: boolean;
	/** Changes whenever the list does. */
	version: string;
};

/** A list as it is sent: its JSON, and the same compressed when a browser first asks for that. */
export type FileListing = FileList & { json: string; gzipped(): Promise<Buffer> };

type Entry = { at: number; freshFor: number; listing: Promise<FileListing> };

/** The files git lists in `cwd`, or undefined when it is not in a repository (or git is not installed, or failed). */
async function gitFiles(cwd: string): Promise<string[] | undefined> {
	try {
		// Past this much, a walk (which stops at its own limits) does instead.
		const out = await git(cwd, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { timeoutMs: 10_000, maxBuffer: 32 * 1024 * 1024 });
		// A conflicted file is listed once per stage.
		const files = [...new Set(out.split("\0"))].filter((path) => path !== "");
		// A folder git ignores entirely, inside a repository, is still worth a walk.
		return files.length === 0 ? undefined : files;
	} catch {
		return undefined;
	}
}

/** How many entries past what fits a walk reads of one folder: room for its subfolders. */
const DIR_EXTRA = 1000;

/**
 * At most `limit` entries of a folder, read as they come: a folder of a million files costs no more than `limit`.
 * `more` says some were left. Stops early, with `more`, past `deadline`.
 */
async function readSome(path: string, limit: number, deadline = Number.POSITIVE_INFINITY): Promise<{ entries: Dirent[]; more: boolean }> {
	const entries: Dirent[] = [];
	const dir = await opendir(path, { bufferSize: 256 });
	// Leaving the loop early closes the folder.
	for await (const entry of dir) {
		if (entries.length >= limit || ((entries.length & 1023) === 1023 && Date.now() > deadline)) return { entries, more: true };
		entries.push(entry);
	}
	return { entries, more: false };
}

/** The files under `cwd`, nearest first, without hidden folders or `SKIP`: at most `max`, found within `ms`. */
async function walkFiles(cwd: string, max: number, ms: number): Promise<{ files: string[]; truncated: boolean }> {
	const deadline = Date.now() + ms;
	const files: string[] = [];
	const queue = [""];
	let truncated = false;
	for (let index = 0; index < queue.length; index++) {
		if (files.length >= max || Date.now() > deadline) return { files, truncated: true };
		const dir = queue[index]!;
		let read;
		try {
			read = await readSome(dir === "" ? cwd : `${cwd}/${dir}`, max - files.length + DIR_EXTRA, deadline);
		} catch {
			continue;
		}
		if (read.more) truncated = true;
		read.entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
		for (const entry of read.entries) {
			const path = dir === "" ? entry.name : `${dir}/${entry.name}`;
			// Linked folders are not followed: they can lead back up, or anywhere. The queue holds no more than fits.
			if (entry.isDirectory()) {
				if (!entry.name.startsWith(".") && !SKIP.has(entry.name) && queue.length - index <= max) queue.push(path);
			} else if (files.length < max) files.push(path);
			else return { files, truncated: true };
		}
	}
	return { files, truncated };
}

/** At most `max` of `files`, the ones nearest the top first when some must go. */
function nearest(files: string[], max: number): { files: string[]; truncated: boolean } {
	if (files.length <= max) return { files, truncated: false };
	const depth = (path: string) => {
		let count = 0;
		for (let index = path.indexOf("/"); index !== -1; index = path.indexOf("/", index + 1)) count++;
		return count;
	};
	const kept = files
		.map((path) => ({ path, depth: depth(path) }))
		.sort((a, b) => a.depth - b.depth || (a.path < b.path ? -1 : 1))
		.slice(0, max)
		.map((each) => each.path)
		.sort();
	return { files: kept, truncated: true };
}

/** The files in `cwd`, as `FileList` says. */
export async function listFiles(cwd: string, max = MAX_FILES): Promise<FileList> {
	const listed = await gitFiles(cwd);
	const { files, truncated } = listed === undefined ? await walkFiles(cwd, Math.min(max, WALK_FILES), WALK_MS) : nearest(listed, max);
	const version = createHash("sha1").update(files.join("\0")).update(truncated ? "+" : "").digest("base64url").slice(0, 16);
	return { files, truncated, version };
}

/** Lists of files by folder, made at most once at a time per folder and kept while fresh. */
export class FileLists {
	readonly #lists = new Map<string, Entry>();
	readonly #now: () => number;

	constructor(now: () => number = Date.now) {
		this.#now = now;
	}

	/** The list for `cwd`: a fresh one kept here, the one being made, or a new one. */
	get(cwd: string): Promise<FileListing> {
		const kept = this.#lists.get(cwd);
		const now = this.#now();
		if (kept !== undefined && now - kept.at < kept.freshFor) return kept.listing;
		const entry: Entry = { at: now, freshFor: Number.POSITIVE_INFINITY, listing: this.#make(cwd) };
		this.#lists.delete(cwd);
		this.#lists.set(cwd, entry);
		for (const key of this.#lists.keys()) {
			if (this.#lists.size <= KEEP) break;
			this.#lists.delete(key);
		}
		// Fresh from when it is done, for ten times what it took; a failure is not kept.
		entry.listing.then(
			() => {
				entry.freshFor = Math.min(FRESH_MAX_MS, Math.max(FRESH_MIN_MS, (this.#now() - now) * 10));
				entry.at = this.#now();
			},
			() => this.#lists.get(cwd) === entry && this.#lists.delete(cwd),
		);
		return entry.listing;
	}

	async #make(cwd: string): Promise<FileListing> {
		const list = await listFiles(cwd);
		const json = JSON.stringify(list);
		let compressed: Promise<Buffer> | undefined;
		return { ...list, json, gzipped: () => (compressed ??= gzip(json, { level: 6 })) };
	}
}

