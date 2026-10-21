// Lancet Guard when the installed guard cannot load: it blocks only while its settings turn it on.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const root = mkdtempSync(join(tmpdir(), "pp-lancet-"));
const guard = join(root, "guard");

mkdirSync(join(guard, "src"), { recursive: true });
writeFileSync(join(guard, "src", "gate.ts"), 'throw new Error("broken guard");\n');
// This file runs in its own process: point the guard and its settings file at the temp folder.
process.env.PI_POCKET_LANCET_DIR = guard;
process.env.HOME = join(root, "home");
// Windows finds the home folder through USERPROFILE.
process.env.USERPROFILE = join(root, "home");
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
delete process.env.PI_POCKET_GUARD;
mkdirSync(join(root, "home", ".pi"), { recursive: true });

const { LancetGuard } = await import("../src/server/lancet.ts");

after(() => rmSync(root, { recursive: true, force: true }));

test("a guard that cannot load stays out of the way while off, and blocks while on", async () => {
    const lancet = new LancetGuard();
    const settings = join(root, "home", ".pi", "lancet-guard.json");

    // No settings file: off, as the guard's own default.
    assert.equal(await lancet.judge("bash", { command: "ls" }, root), undefined);

    // On, with a byte order mark as some editors write: every guarded call is blocked.
    writeFileSync(settings, '\uFEFF{"enabled": true}');
    const judged = await lancet.judge("bash", { command: "ls" }, root);

    assert.equal(judged?.decision.action, "block");
});
