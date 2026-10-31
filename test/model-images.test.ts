import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { forModel, modelImage, prepareModelImage } from "../src/server/model-images.ts";

// A 1×1 PNG.
const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
);

test("an image prepared at upload is the one a message sends, without making it again", async () => {
    const folder = mkdtempSync(join(tmpdir(), "model-images-"));

    try {
        const path = join(folder, "a.png");

        writeFileSync(path, PNG);
        prepareModelImage(path, "image/png", PNG.length);
        const first = modelImage(path, "image/png");

        assert.equal((await first).mimeType, "image/png");
        // The file is gone: only the prepared image can answer.
        rmSync(path);
        assert.equal(modelImage(path, "image/png"), first);
        assert.equal(await modelImage(path, "image/png"), await first);
    } finally {
        rmSync(folder, { recursive: true, force: true });
    }
});

test("only images the model takes are prepared", () => {
    assert.equal(forModel("image/png", 1000), true);
    assert.equal(forModel("image/heic", 1000), false);
    assert.equal(forModel("image/png", 6 * 1024 * 1024), false);
});
