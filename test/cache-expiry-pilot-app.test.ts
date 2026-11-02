// Verify owner-only persistent observation settings on isolated application data.
import { cleanUp, home, owner, root, scriptedModel, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, test } from "node:test";
import { PocketApp } from "../src/server/app.ts";

after(cleanUp);

test("cache observation is owner-only, immediate, and persists across restart", async () => {
    const dataDir = join(root, "cache-pilot-setting");
    const provider = scriptedModel();
    const open = () =>
        PocketApp.open({
            dataDir,
            defaultCwd: work,
            home,
            supervised: false,
            log: () => {},
            configureModels: (models) => models.registerNativeProvider(provider.provider),
        });
    let app = await open();

    try {
        assert.equal(app.config.cacheObservation, false);
        await assert.rejects(app.setCacheObservation({ ...owner(app), role: "guest" }, true));
        await assert.rejects(app.setCacheObservation(owner(app), "true"));
        await app.setCacheObservation(owner(app), true);
        assert.equal(app.config.cacheObservation, true);
        await app.close();
        app = await open();
        assert.equal(app.config.cacheObservation, true);
        await app.setCacheObservation(owner(app), false);
        assert.equal(app.config.cacheObservation, false);
    } finally {
        await app.close();
    }
});
