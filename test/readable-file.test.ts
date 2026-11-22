// A guest reads no file of Pi's folder or the app's data folder, also when the path spells them in another case (macOS).
import { cleanUp, newSession, openApp, root, scriptedModel, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

test("readableFile refuses Pi's folder and the data folder in another letter case, and serves a session file", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    const app = await openApp(scriptedModel(), join(root, "readable-data"));

    try {
        const id = await newSession(app);
        const guest = app.config.addUser("Gale", "guest").user;
        // On this system the other spelling is a folder of its own: it takes the case-blind compare to match it.
        const spelled = [
            join(root, "AGENT", "auth.json"),
            join(root, "READABLE-DATA", "config.json"),
        ];

        for (const file of [...spelled, join(work, "note.txt")]) {
            mkdirSync(join(file, ".."), { recursive: true });
            writeFileSync(file, "x");
        }

        Object.defineProperty(process, "platform", { value: "darwin" });

        for (const file of spelled) {
            assert.throws(() => app.workspace.readableFile(guest, id, file), { status: 404 });
        }

        const note = join(work, "note.txt");

        assert.equal(app.workspace.readableFile(guest, id, note), note);
    } finally {
        Object.defineProperty(process, "platform", platform);
        await app.close();
        cleanUp();
    }
});
