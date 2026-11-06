// The watch of the web app's files (`watchTree`): tabs reload for a real change, not for an event that leaves a file as
// it was. Windows reports reads and attribute changes to a watch too, and every tab reloaded for them.
import { cleanUp, root, until } from "./helpers.ts";
import assert from "node:assert/strict";
import {
    chmodSync,
    mkdirSync,
    readFileSync,
    renameSync,
    rmSync,
    statSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
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
        assert.equal(changes.length, 0, "nothing is told");

        writeFileSync(app, "export const a = 2;\n");
        await until(() => changes.length === 1, "the edit is told");
        assert.equal(changes[0], "app.js");

        writeFileSync(join(directory, "fonts", "new.woff2"), "new");
        await until(() => changes.length === 2, "the new file is told");
        assert.equal(changes[1], join("fonts", "new.woff2"));

        // A save by rename, of the same size at the same time (a coarse clock): a new file all the same.
        const saved = join(directory, "app.js.tmp");
        const second = new Date(Math.floor(Date.now() / 1000) * 1000);

        utimesSync(app, second, second);
        await settle();
        const before = changes.length;

        writeFileSync(saved, "export const a = 3;\n");
        utimesSync(saved, second, second);
        assert.equal(statSync(saved).mtimeMs, statSync(app).mtimeMs);
        renameSync(saved, app);
        await until(() => changes.slice(before).includes("app.js"), "the rename is told");

        const told = changes.length;

        rmSync(app);
        await until(() => changes.length === told + 1, "the removal is told");
        assert.equal(changes.at(-1), "app.js");
    } finally {
        stop();
    }
});
