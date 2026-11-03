// The watch of the web app's files (`watchTree`): tabs reload for a real change, not for an event that leaves a file as
// it was. Windows reports reads and attribute changes to a watch too, and every tab reloaded for them.
import { cleanUp, root, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { watchTree } from "../src/server/reload.ts";

after(cleanUp);

const settle = () => new Promise((resolve) => setTimeout(resolve, 600));

test("a watched tree tells of added, written, and removed files, and not of reads or new attributes", async () => {
    const directory = join(root, "watched-web");

    mkdirSync(join(directory, "fonts"), { recursive: true });
    writeFileSync(join(directory, "app.js"), "export const a = 1;\n");
    writeFileSync(join(directory, "fonts", "font.woff2"), "font");

    const changes: string[] = [];
    const stop = watchTree(directory, (file) => changes.push(file));

    try {
        const app = join(directory, "app.js");

        // A read and new permissions: the files hold what they held.
        readFileSync(app);
        chmodSync(app, 0o600);
        chmodSync(join(directory, "fonts", "font.woff2"), 0o600);
        await settle();
        assert.deepEqual(changes, []);

        writeFileSync(app, "export const a = 2;\n");
        await until(() => changes.length === 1, "the edit is told");
        assert.equal(changes[0], "app.js");

        writeFileSync(join(directory, "fonts", "new.woff2"), "new");
        await until(() => changes.length === 2, "the new file is told");
        assert.equal(changes[1], join("fonts", "new.woff2"));

        rmSync(app);
        await until(() => changes.length === 3, "the removal is told");
        assert.equal(changes[2], "app.js");
    } finally {
        stop();
    }
});
