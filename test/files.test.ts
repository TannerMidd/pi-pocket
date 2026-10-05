// Files for @ mentions: git's list in a repository, a walk elsewhere, kept while fresh, and sent compressed or not at all.
import { cleanUp, newSession, openApp, root, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import { gunzipSync } from "node:zlib";
import { FileLists, listFiles } from "../src/server/files.ts";
import { createHandler } from "../src/server/http.ts";

after(() => cleanUp());

/** Make the files at `paths` (each holding its own name) under `dir`. */
function files(dir: string, paths: string[]): void {
	for (const path of paths) {
		mkdirSync(join(dir, path, ".."), { recursive: true });
		writeFileSync(join(dir, path), path);
	}
}

test("in a repository, the list is git's: tracked and untracked files, not ignored ones, relative to the folder", async () => {
	const repo = join(root, "mention-repo");
	files(repo, [".gitignore", "README.md", "src/app.ts", "src/deep/util.ts", "build/out.js", "notes.txt"]);
	writeFileSync(join(repo, ".gitignore"), "build/\n");
	const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
	git("init", "-q");
	git("add", ".gitignore", "README.md", "src");
	const list = await listFiles(repo);
	assert.deepEqual(list.files.sort(), [".gitignore", "README.md", "notes.txt", "src/app.ts", "src/deep/util.ts"]);
	assert.equal(list.truncated, false);
	// From a folder inside the repository: its own files, relative to it.
	assert.deepEqual((await listFiles(join(repo, "src"))).files.sort(), ["app.ts", "deep/util.ts"]);
	// Past the most it holds, the files nearest the top stay.
	const nearest = await listFiles(repo, 3);
	assert.deepEqual(nearest.files, [".gitignore", "README.md", "notes.txt"]);
	assert.equal(nearest.truncated, true);
	assert.notEqual(nearest.version, list.version);
});

test("outside a repository, a walk lists files nearest first and skips hidden and dependency folders", async () => {
	const plain = join(root, "mention-plain");
	files(plain, ["b.txt", ".env", "a/one.md", "a/b/two.md", ".cache/x", "node_modules/pkg/index.js", "z/three.md"]);
	const list = await listFiles(plain);
	assert.deepEqual(list.files, [".env", "b.txt", "a/one.md", "z/three.md", "a/b/two.md"]);
	assert.equal(list.truncated, false);
	const capped = await listFiles(plain, 2);
	assert.deepEqual(capped, { files: [".env", "b.txt"], truncated: true, version: capped.version });
	// One huge folder costs no more than the list holds.
	const crowded = join(root, "mention-crowded");
	files(crowded, Array.from({ length: 300 }, (_, index) => `f${String(index).padStart(3, "0")}.txt`));
	const few = await listFiles(crowded, 10);
	assert.equal(few.files.length, 10);
	assert.equal(few.truncated, true);
	// A folder that is not there has no files.
	assert.deepEqual((await listFiles(join(plain, "missing"))).files, []);
});

test("a list is made once while fresh, then made again with a new version when the files change", async () => {
	const dir = join(root, "mention-fresh");
	files(dir, ["one.txt"]);
	let now = 1_000;
	const lists = new FileLists(() => now);
	const first = lists.get(dir);
	assert.equal(lists.get(dir), first, "asked again while it is made: the same list");
	const made = await first;
	assert.equal(lists.get(dir), first, "fresh: the same list");
	files(dir, ["two.txt"]);
	now += 60_000;
	const next = await lists.get(dir);
	assert.deepEqual(next.files, ["one.txt", "two.txt"]);
	assert.notEqual(next.version, made.version);
	assert.deepEqual(JSON.parse(gunzipSync(await next.gzipped()).toString()), { files: next.files, truncated: false, version: next.version });
	assert.equal(next.gzipped(), next.gzipped(), "compressed once");
});

test("the files route sends the list compressed, then only its version while it has not changed", async () => {
	const app = await openApp(scriptedModel(), join(root, "mention-data"));
	const server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const dir = join(root, "mention-route");
		files(dir, ["src/a.ts", "b.md"]);
		const id = await newSession(app, dir);
		const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/c/${id}/files`;
		const headers = { authorization: `Bearer ${app.config.ownerToken}` };
		const response = await fetch(url, { headers: { ...headers, "accept-encoding": "gzip" } });
		assert.equal(response.headers.get("content-encoding"), "gzip");
		const list = (await response.json()) as { files: string[]; version: string };
		assert.deepEqual(list.files, ["b.md", "src/a.ts"]);
		const same = await (await fetch(`${url}?since=${list.version}`, { headers })).json();
		assert.deepEqual(same, { version: list.version, same: true });
		assert.equal((await fetch(url.replace(`/c/${id}/`, `/c/${Number(id) + 999}/`), { headers })).status, 404);
	} finally {
		server.closeAllConnections();
		server.close();
		await app.close();
	}
});
