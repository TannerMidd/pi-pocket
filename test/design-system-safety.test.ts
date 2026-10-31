import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readDesignSystemText, writeDesignSystemText } from "../src/server/design/system.ts";

test("design-system reads and writes refuse a linked .pi parent", () => {
    const root = mkdtempSync(join(tmpdir(), "design-system-parent-"));
    const outside = mkdtempSync(join(tmpdir(), "design-system-outside-"));

    try {
        const path = join(outside, "design-system.md");

        writeFileSync(path, "outside");
        symlinkSync(outside, join(root, ".pi"));
        assert.throws(() => readDesignSystemText(root), /symlink/);
        assert.throws(() => writeDesignSystemText(root, "changed"), /symlink/);
        assert.equal(readFileSync(path, "utf8"), "outside");
    } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
    }
});

test(
    "a design-system FIFO cannot block the prompt renderer",
    { skip: process.platform === "win32", timeout: 5000 },
    () => {
        const root = mkdtempSync(join(tmpdir(), "design-system-fifo-"));

        try {
            mkdirSync(join(root, ".pi"));
            execFileSync("mkfifo", [join(root, ".pi", "design-system.md")]);
            assert.throws(() => readDesignSystemText(root), /regular file/);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    },
);
