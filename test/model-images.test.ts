import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { forModel, imageWork, modelImage, prepareModelImage } from "../src/server/model-images.ts";

// A 1×1 PNG, and a 2×2 blue one.
const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
);
const BLUE = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAD0lEQVR4nGNgYPgPRmAKABf2A/1+6zfzAAAAAElFTkSuQmCC",
    "base64",
);

test("an image prepared at upload is the one a message sends, without making it again", async () => {
    const folder = mkdtempSync(join(tmpdir(), "model-images-"));

    try {
        const path = join(folder, "a.png");

        writeFileSync(path, PNG);
        prepareModelImage(path, "image/png", PNG.length);
        const first = await modelImage(path, "image/png");

        assert.equal(first.mimeType, "image/png");
        // The same object each time: the one prepared, not one made again.
        assert.equal(await modelImage(path, "image/png"), first);
    } finally {
        rmSync(folder, { recursive: true, force: true });
    }
});

test("an image whose file changed after its upload is read again", async () => {
    const folder = mkdtempSync(join(tmpdir(), "model-images-"));

    try {
        const path = join(folder, "a.png");

        writeFileSync(path, PNG);
        prepareModelImage(path, "image/png", PNG.length);
        const before = await modelImage(path, "image/png");

        writeFileSync(path, BLUE);
        assert.equal((await modelImage(path, "image/png")).data, BLUE.toString("base64"));
        assert.notEqual(before.data, BLUE.toString("base64"));
    } finally {
        rmSync(folder, { recursive: true, force: true });
    }
});

test("uploads make two images at a time, and wait at most 24 deep", async () => {
    const folder = mkdtempSync(join(tmpdir(), "model-images-"));

    try {
        const source = join(folder, "source.png");

        writeFileSync(source, PNG);

        const paths = Array.from({ length: 30 }, (_, n) => join(folder, `${n}.png`));

        for (const path of paths) {
            copyFileSync(source, path);
            prepareModelImage(path, "image/png", PNG.length);
        }

        assert.deepEqual(imageWork(), { running: 2, waiting: 24 });
        await Promise.all(paths.map((path) => modelImage(path, "image/png")));
        assert.deepEqual(imageWork(), { running: 0, waiting: 0 });
    } finally {
        rmSync(folder, { recursive: true, force: true });
    }
});

test("only images the model takes are prepared", () => {
    assert.equal(forModel("image/png", 1000), true);
    assert.equal(forModel("image/heic", 1000), false);
    assert.equal(forModel("image/png", 6 * 1024 * 1024), false);
});
