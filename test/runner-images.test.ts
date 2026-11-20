// The server-owned image cache: bounded reads, version names, restart-safe lookups, and the per-session disk budget.
import assert from "node:assert/strict";
import {
    closeSync,
    existsSync,
    ftruncateSync,
    mkdirSync,
    mkdtempSync,
    openSync,
    readdirSync,
    readFileSync,
    rmSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { localAccess, type FolderAccess } from "../src/server/folder-access.ts";
import { MAX_IMAGE_FILE } from "../src/server/http/assets.ts";
import { RunnerImages, MAX_RUNNER_IMAGES } from "../src/server/runner-images.ts";

const root = mkdtempSync(join(tmpdir(), "runner-images-"));
const id = 1 as ConversationId;
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const SVG =
    '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10" fill="red"/></svg>';

after(() => rmSync(root, { recursive: true, force: true }));

test("copies each version once, keeps the latest even after reverting, and binds offline copies to their scope", async () => {
    const file = join(root, "source.svg");
    const source = { runner: "computer", cwd: root, file };
    const cache = new RunnerImages(join(root, "versions"));

    writeFileSync(file, SVG);
    utimesSync(file, 100, 100);
    const first = await cache.copy(id, source, localAccess, false);

    assert.equal(
        await cache.latest(id, source, true),
        undefined,
        "an owner's out-of-folder image is not a guest's",
    );
    assert.equal(await cache.copy(id, source, localAccess, true), first);
    assert.equal(await cache.latest(id, source, true), first);
    writeFileSync(file, SVG.replace("red", "tan"));
    utimesSync(file, 200, 200);
    const second = await cache.copy(id, source, localAccess, true);

    assert.notEqual(first, second);
    assert.equal(await new RunnerImages(join(root, "versions")).latest(id, source, false), second);
    writeFileSync(file, SVG);
    utimesSync(file, 100, 100);
    assert.equal(await cache.copy(id, source, localAccess, true), first);
    assert.equal(
        await cache.latest(id, source, true),
        first,
        "a reverted version is the current offline copy",
    );
    assert.equal(await cache.latest(id, { ...source, runner: "someone-else" }, false), undefined);
    assert.equal(await cache.latest(id, { ...source, cwd: "/different-folder" }, false), undefined);
    assert.equal(
        readdirSync(cache.directory(id)).filter((name) => name.endsWith(".svg")).length,
        2,
    );
    assert.equal(readFileSync(first, "utf8"), SVG);
});

test("rechecks type and size when the image changes between its header and body reads", async () => {
    for (const changed of [
        { kind: "file" as const, size: 2000, mtimeMs: 1, bytes: Buffer.from("not an image") },
        { kind: "file" as const, size: MAX_IMAGE_FILE + 1, mtimeMs: 1, bytes: PNG },
        { kind: "file" as const, size: 2000, mtimeMs: 1, bytes: PNG },
    ]) {
        let reads = 0;
        const access: FolderAccess = {
            ...localAccess,
            peek: async (_file, bound) => {
                reads++;
                assert.ok(bound <= MAX_IMAGE_FILE + 1);

                return reads === 1 ? { kind: "file", size: 2000, mtimeMs: 0, bytes: PNG } : changed;
            },
        };
        const cache = new RunnerImages(
            join(root, `changing-${changed.size}-${changed.bytes.length}`),
        );

        await assert.rejects(
            cache.copy(id, { runner: "computer", cwd: root, file: "/picture.png" }, access, true),
            /not an image|Image too large|Image changed/,
        );
        assert.equal(reads, 2);
        assert.equal(readdirSync(cache.directory(id)).length, 0);
    }
});

test("removes the oldest copies above 500 MiB, including their metadata, without deleting another session's files", async () => {
    const cache = new RunnerImages(join(root, "budget"));
    const directory = cache.directory(id);
    const older: string[] = [];

    mkdirSync(directory, { recursive: true });

    // Sparse files account for the real 500 MiB limit without generating load or filling the disk with test bytes.
    for (let index = 0; index < MAX_RUNNER_IMAGES / MAX_IMAGE_FILE; index++) {
        const name = `${index.toString(16).padStart(64, "0")}-${"a".repeat(64)}.png`;
        const file = join(directory, name);

        writeFileSync(file, PNG);
        const fd = openSync(file, "r+");

        try {
            ftruncateSync(fd, MAX_IMAGE_FILE);
        } finally {
            closeSync(fd);
        }

        writeFileSync(file + ".json", JSON.stringify({ shared: true, seen: index }));
        utimesSync(file, index + 1, index + 1);
        older.push(file);
    }

    const otherDirectory = cache.directory(2 as ConversationId);

    mkdirSync(otherDirectory, { recursive: true });
    writeFileSync(join(otherDirectory, "not-this-session.png"), PNG);
    const file = join(root, "budget-source.svg");

    writeFileSync(file, SVG);
    const copy = await cache.copy(id, { runner: "computer", cwd: root, file }, localAccess, true);

    assert.ok(existsSync(copy));
    assert.ok(!existsSync(older[0]!));
    assert.ok(!existsSync(older[0]! + ".json"));
    assert.ok(older.slice(1).every((file) => existsSync(file)));
    assert.ok(existsSync(join(otherDirectory, "not-this-session.png")));
    assert.equal(readdirSync(directory).filter((name) => name.endsWith(".png")).length, 19);
});
