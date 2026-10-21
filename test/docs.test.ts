// Pocket's documents keep a short stored history: a cold read must not replay every change ever made.
import { type App, cleanUp, context, openApp, root, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { FolderFavoritesDoc } from "../src/server/docs.ts";

let app: App;

before(async () => {
    app = await openApp(scriptedModel());
});

after(async () => {
    await app.close();
    cleanUp();
});

test("a document changed many times is stored as a recent base and a few deltas", async () => {
    for (let index = 0; index < 150; index++) {
        await app.harness.commit(async (tx) => {
            (await tx.doc(FolderFavoritesDoc)).users.someone = [`/folder/${index}`];
        }, context);
    }

    const db = new DatabaseSync(join(root, "data", "pocket.sqlite"), { readOnly: true });
    const { revisions } = db
        .prepare(
            `SELECT count(*) AS revisions FROM document_revisions WHERE document_id =
                (SELECT id FROM documents WHERE kind = ? AND retired_at IS NULL)`,
        )
        .get(JSON.stringify(FolderFavoritesDoc.definition.kind)) as { revisions: number };

    db.close();
    assert.ok(revisions <= 65, `${revisions} revisions`);
    assert.deepEqual((await app.harness.snapshot(FolderFavoritesDoc, context))?.users.someone, [
        "/folder/149",
    ]);
});
