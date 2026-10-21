import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { cleanUp, root } from "./helpers.ts";

after(cleanUp);

test("the guard reports a missing model, downloads it once on request, and then reports it ready", async () => {
    const pkg = join(root, "fake-lancet");
    const marker = join(root, "fake-model");

    mkdirSync(join(pkg, "src"), { recursive: true });
    writeFileSync(join(pkg, "src", "gate.ts"), "");
    // The package's downloader, reduced to its two calls: the model is "installed" once a marker file exists.
    writeFileSync(
        join(pkg, "src", "model-store.mjs"),
        `import fs from "node:fs";
export const modelState = () => fs.existsSync(${JSON.stringify(marker)}) ? { installed: true } : { installed: false, problem: "not downloaded" };
export async function installModel({ onProgress }) {
    onProgress("download");
    await new Promise((resolve) => setTimeout(resolve, 20));
    fs.writeFileSync(${JSON.stringify(marker)}, "x");
    return { installed: true, reason: "downloaded" };
}
`,
    );
    process.env.PI_POCKET_LANCET_DIR = pkg;

    const { LancetGuard } = await import("../src/server/lancet.ts");
    const guard = new LancetGuard();

    assert.equal((await guard.model())?.state, "missing");

    let steps = 0;
    const first = guard.setupModel(() => steps++);

    assert.equal((await guard.model())?.state, "downloading");
    // A second request joins the download in progress.
    assert.equal(guard.setupModel(), first);
    await first;
    assert.ok(steps > 0);
    assert.equal((await guard.model())?.state, "ready");
});
