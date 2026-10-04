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
	assert.equal(lancet.directory, guard);
	const settings = join(root, "home", ".pi", "lancet-guard.json");
	assert.equal(lancet.settingsFile, settings);

	// No settings file: off, as the guard's own default.
	assert.equal(await lancet.judge("bash", { command: "ls" }, root), undefined);
	assert.deepEqual(
		{ ...(await lancet.status()), detail: undefined },
		{ available: false, enabled: false, detail: undefined },
	);

	for (const off of ['{"enabled": false}', '{"enabled": "yes"}', "not json"]) {
		writeFileSync(settings, off);
		assert.equal(await lancet.judge("write", { path: "x" }, root), undefined, off);
	}

	// On, with a byte order mark as some editors write: every guarded call is blocked, and the status says why.
	writeFileSync(settings, '\uFEFF{"enabled": true}');
	const judged = await lancet.judge("bash", { command: "ls" }, root);
	assert.equal(judged?.decision.action, "block");
	assert.match(judged?.decision.reason ?? "", /could not load: broken guard/);
	assert.equal(await lancet.judge("read", { path: "x" }, root), undefined, "read is never guarded");
	const status = await lancet.status();
	assert.equal(status.enabled, true);
	assert.equal(status.available, false);
	assert.match(status.detail, /on but failed to load, so bash, write, and edit calls are blocked/);
});
