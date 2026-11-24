import { cleanUp, context, newSession, openApp, owner, root, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import {
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DeletedDoc, SessionsDoc } from "../src/server/docs.ts";

test("after restart the log sweep cleans live and verified folders only", async (t) => {
    const model = scriptedModel();
    const data = join(root, "data");
    let app = await openApp(model, data);

    t.after(async () => {
        await app.close();
        cleanUp();
    });

    const live = await newSession(app);
    const original = await newSession(app);
    const replaced = await newSession(app);
    const absent = await newSession(app);
    const legacy = await newSession(app);
    const sessions = [live, original, replaced, absent, legacy];
    const path = (id: typeof live) => join(data, "background", String(id));

    for (const id of sessions) {
        if (id !== absent) {
            app.managedStorage.folder("background", String(id), true);
        }
    }

    // Completed records: only the ordinary log sweeper runs, not SessionCleanup's retry.
    await app.harness.commit(async (tx) => {
        const catalogue = await tx.doc(SessionsDoc);
        const removed = await tx.doc(DeletedDoc);

        for (const id of [original, replaced, absent, legacy]) {
            const key = String(id);
            const cwd = catalogue.items[key]!.cwd;

            delete catalogue.items[key];
            removed.items[key] = {
                cwd,
                conversations: [Number(id)],
                at: 1,
                done: 1,
                by: owner(app).id,
                ...(id === legacy
                    ? {}
                    : {
                          folders: {
                              uploads: {},
                              background: { [key]: app.managedStorage.capture("background", key) },
                          },
                      }),
            };
        }
    }, context);
    assert.equal(app.backgroundFolder(absent, true), undefined);
    assert.equal(existsSync(path(absent)), false);
    await app.close();
    renameSync(path(replaced), join(root, "original-logs"));
    mkdirSync(path(replaced));
    mkdirSync(path(absent));

    for (const id of sessions) {
        const log = join(path(id), "orphan.log.aaaaaa");

        writeFileSync(log, "synthetic output");
        utimesSync(log, new Date(0), new Date(0));
    }

    app = await openApp(model, data);
    await app.background.sweep();

    for (const id of [live, original]) {
        assert.equal(existsSync(join(path(id), "orphan.log.aaaaaa")), false);
    }

    for (const id of [replaced, absent, legacy]) {
        assert.equal(readFileSync(join(path(id), "orphan.log.aaaaaa"), "utf8"), "synthetic output");
    }
});
