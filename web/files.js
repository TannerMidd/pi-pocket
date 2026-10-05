// Files to mention with @ in the message box ("look at @src/app.ts"). The session folder's list comes from the server
// once and is checked again in the background (an unchanged list costs one short reply); matching happens here as
// people type, so suggestions never wait on the network. Pi gets the text as written and reads what it names.
import { api, store } from "./store.js";

/** How old a list may be before a new mention checks it again. */
const RECHECK_MS = 5_000;
/** How many suggestions show. */
const SHOWN = 50;

/**
 * The list for each conversation: its folder, version, and what matching needs, made once per version. `paths` has
 * the folders first (ending in "/"), then the files; `lower` the same in lower case; `bases` where each name starts.
 */
const lists = new Map();

function prepare(files) {
	// Folders are not listed: every folder that holds a file is one.
	const dirs = new Set();
	for (const file of files) {
		for (let at = file.indexOf("/"); at !== -1; at = file.indexOf("/", at + 1)) dirs.add(file.slice(0, at + 1));
	}
	const paths = [...dirs, ...files];
	const lower = paths.map((path) => path.toLowerCase());
	const bases = new Uint32Array(paths.length);
	for (let index = 0; index < paths.length; index++) bases[index] = lower[index].lastIndexOf("/", lower[index].length - 2) + 1;
	return { paths, lower, bases, dirs: dirs.size };
}

const cwd = () => store.state.view.agent?.cwd;

/**
 * Get or check the list of files for this conversation's folder, unless one was checked in the last few seconds. With
 * `ifMissing`, only when there is none yet: focusing the message box gets one ready before the first @.
 */
export function loadFiles({ ifMissing = false } = {}) {
	const id = store.state.conversationId;
	if (id === null) return;
	let list = lists.get(id);
	// Another folder (`/cwd`) is another list. One asked for before the folder was known is the folder's.
	if (list !== undefined && list.cwd === undefined) list.cwd = cwd();
	if (list !== undefined && cwd() !== undefined && list.cwd !== cwd()) list = undefined;
	if (list?.loading || (list !== undefined && (ifMissing || Date.now() - list.at < RECHECK_MS))) return;
	const entry = list ?? { cwd: cwd(), version: null, truncated: false, paths: [], lower: [], bases: new Uint32Array(0), dirs: 0, at: 0, memo: null, last: null };
	entry.loading = true;
	lists.set(id, entry);
	const since = entry.version === null ? "" : `?since=${encodeURIComponent(entry.version)}`;
	const done = () => {
		entry.loading = false;
		entry.at = Date.now();
		if (lists.get(id) === entry) store.set({ filesLoaded: (store.state.filesLoaded ?? 0) + 1 });
	};
	api(`c/${id}/files${since}`).then((data) => {
		if (!data.same) {
			Object.assign(entry, prepare(data.files), { version: data.version, truncated: data.truncated, memo: null, last: null });
		}
		done();
	}, done);
}

/** The `@path` being typed at the caret: where it starts and ends (past the caret, to the end of the word), and the query. */
export function mentionAt(text, caret) {
	const match = /(?:^|[\s([{])@(?:"([^"\n]*)|([^\s"]*))$/.exec(text.slice(0, caret));
	if (!match) return null;
	const quoted = match[1] !== undefined;
	const query = quoted ? match[1] : match[2];
	const rest = (quoted ? /^[^"\n]*"?/ : /^\S*/).exec(text.slice(caret))[0];
	return { start: caret - query.length - (quoted ? 2 : 1), end: caret + rest.length, query };
}

/** How a path goes into a message: quoted when it has spaces. */
export function mentionText(path) {
	return /[\s"]/.test(path) ? `@"${path}"` : `@${path}`;
}

const isBreak = (code) => code === 47 || code === 95 || code === 45 || code === 46 || code === 32; // / _ - . space

/**
 * How well a lower-case path (whose name starts at `base`) matches the lower-case query: -1 for no match, else higher
 * is better. The name before the folders, whole words before parts, and a substring before scattered letters. Every
 * match is also a match of each shorter query, which lets typing narrow the last matches instead of the whole list.
 */
function score(lower, base, query) {
	const end = lower.charCodeAt(lower.length - 1) === 47 ? lower.length - 1 : lower.length;
	let at = lower.indexOf(query, base);
	if (at !== -1 && at < end) {
		if (at === base) return end - base === query.length ? 1000 : 900;
		return isBreak(lower.charCodeAt(at - 1)) ? 800 : 700;
	}
	at = lower.indexOf(query);
	if (at !== -1) return at === 0 || lower.charCodeAt(at - 1) === 47 ? 600 : isBreak(lower.charCodeAt(at - 1)) ? 550 : 500;
	// Scattered letters: forward to the earliest end, then back to the tightest start (fzf's first algorithm).
	let next = 0;
	let stop = 0;
	for (; stop < lower.length && next < query.length; stop++) if (lower.charCodeAt(stop) === query.charCodeAt(next)) next++;
	if (next < query.length) return -1;
	let bonus = 0;
	let start = stop - 1;
	for (next = query.length - 1; start >= 0; start--) {
		if (lower.charCodeAt(start) !== query.charCodeAt(next)) continue;
		if (start === 0 || isBreak(lower.charCodeAt(start - 1))) bonus += 12;
		if (--next < 0) break;
	}
	return Math.max(1, Math.min(399, 250 + bonus + (start >= base ? 100 : 0) - (stop - start - query.length) * 3));
}

/** Where the query shows in a path, for marking: the same places `score` found. */
function hitsIn(lower, base, query) {
	const end = lower.charCodeAt(lower.length - 1) === 47 ? lower.length - 1 : lower.length;
	let at = lower.indexOf(query, base);
	if (at === -1 || at >= end) at = lower.indexOf(query);
	if (at !== -1) return Array.from({ length: query.length }, (_, index) => at + index);
	const hits = [];
	let next = 0;
	let stop = 0;
	for (; stop < lower.length && next < query.length; stop++) if (lower.charCodeAt(stop) === query.charCodeAt(next)) next++;
	for (let index = stop - 1, want = query.length - 1; index >= 0 && want >= 0; index--) {
		if (lower.charCodeAt(index) === query.charCodeAt(want)) {
			hits.unshift(index);
			want--;
		}
	}
	return hits;
}

/** Better first: score, then shorter names (app.ts before app.test.ts), then shorter paths, then by path. */
function better(list, a, aScore, b, bScore) {
	if (aScore !== bScore) return aScore > bScore;
	const aPath = list.paths[a];
	const bPath = list.paths[b];
	const names = aPath.length - list.bases[a] - (bPath.length - list.bases[b]);
	if (names !== 0) return names < 0;
	const lengths = aPath.length - bPath.length;
	return lengths !== 0 ? lengths < 0 : aPath < bPath;
}

/** Folders first, then by name: how a folder's own files show. */
const byKind = (list) => (a, b) => {
	const aDir = a < list.dirs;
	const bDir = b < list.dirs;
	return aDir !== bDir ? (aDir ? -1 : 1) : list.lower[a] < list.lower[b] ? -1 : list.lower[a] > list.lower[b] ? 1 : 0;
};

/**
 * Suggestions for an @ query: `{ items, loading, truncated }`, where each item is `{ path, dir, name, parent,
 * nameHits, parentHits }`. An empty query, or one ending in "/", lists that folder; any other matches the whole list.
 */
export function suggestFiles(query) {
	const list = lists.get(store.state.conversationId);
	if (list === undefined) return { items: [], loading: true, truncated: false };
	const needle = query.toLowerCase();
	if (list.memo?.needle === needle) return list.memo.result;
	let picked;
	if (needle === "" || needle.endsWith("/")) {
		picked = [];
		for (let index = 0; index < list.paths.length; index++) {
			const lower = list.lower[index];
			if (lower.length > needle.length && lower.startsWith(needle) && list.bases[index] === needle.length) picked.push(index);
		}
		picked.sort(byKind(list)).splice(SHOWN);
	} else {
		// Each letter typed narrows the last matches.
		const from = list.last !== null && needle.startsWith(list.last.needle) ? list.last.matches : null;
		const matches = [];
		const top = [];
		const scores = [];
		const count = from === null ? list.paths.length : from.length;
		for (let at = 0; at < count; at++) {
			const index = from === null ? at : from[at];
			const value = score(list.lower[index], list.bases[index], needle);
			if (value < 0) continue;
			matches.push(index);
			if (top.length === SHOWN && !better(list, index, value, top[SHOWN - 1], scores[SHOWN - 1])) continue;
			let place = Math.min(top.length, SHOWN - 1);
			while (place > 0 && better(list, index, value, top[place - 1], scores[place - 1])) place--;
			top.splice(place, 0, index);
			scores.splice(place, 0, value);
			if (top.length > SHOWN) {
				top.pop();
				scores.pop();
			}
		}
		list.last = { needle, matches };
		picked = top;
	}
	const items = picked.map((index) => {
		const path = list.paths[index];
		const dir = index < list.dirs;
		const base = list.bases[index];
		const hits = needle === "" || needle.endsWith("/") ? [] : hitsIn(list.lower[index], base, needle);
		return {
			path,
			dir,
			name: path.slice(base, dir ? -1 : undefined),
			parent: path.slice(0, base),
			nameHits: hits.filter((hit) => hit >= base).map((hit) => hit - base),
			parentHits: hits.filter((hit) => hit < base),
		};
	});
	const result = { items, loading: list.loading && list.version === null, truncated: list.truncated };
	// Only a list that has arrived is worth remembering: the message box draws again on every change in the session.
	if (list.version !== null) list.memo = { needle, result };
	return result;
}
