// Boot real app instances with isolated Pi settings and data. No model request is made.
import { cleanUp, home, root, scriptedModel, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, test } from "node:test";
import { PocketApp } from "../src/server/app.ts";

const previous = process.env.PI_POCKET_CACHE_EXPIRY_PILOT;

after(() => {
    if (previous === undefined) {
        delete process.env.PI_POCKET_CACHE_EXPIRY_PILOT;
    } else {
        process.env.PI_POCKET_CACHE_EXPIRY_PILOT = previous;
    }

    cleanUp();
});

for (const mode of [undefined, "observe"]) {
    test(`cache expiry pilot app startup and shutdown: ${mode ?? "disabled by default"}`, async () => {
        if (mode === undefined) {
            delete process.env.PI_POCKET_CACHE_EXPIRY_PILOT;
        } else {
            process.env.PI_POCKET_CACHE_EXPIRY_PILOT = mode;
        }

        const logs: string[] = [];
        const provider = scriptedModel();
        const app = await PocketApp.open({
            dataDir: join(root, `cache-pilot-${mode ?? "off"}`),
            defaultCwd: work,
            home,
            supervised: false,
            log: (line) => logs.push(line),
            configureModels: (models) => models.registerNativeProvider(provider.provider),
        });

        try {
            assert.equal(
                logs.some((line) => line.includes("[cache-expiry-pilot]")),
                mode === "observe",
            );
        } finally {
            await app.close();
        }
    });
}
