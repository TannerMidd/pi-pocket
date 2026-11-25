import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { WindowsProcesses } from "../src/server/processes.ts";

test("a restarted Windows watch refreshes receipts while it holds the job open", async (t) => {
    const dir = mkdtempSync(join(import.meta.dirname, "receipt-refresh-"));

    t.after(() => rmSync(dir, { recursive: true }));
    const task = { marker: "recovered", files: join(dir, "attempt"), pid: 0, startedAt: 0 };
    const file = `${task.files}.pids`;
    const key = createHash("sha256").update(task.marker).digest("hex").slice(0, 32);
    let job = "members";
    let table = "list";
    const helper = {
        ask: async (line: string) => {
            if (line === "list") {
                return table;
            }

            if (line.startsWith(`members ${key}`)) {
                return job;
            }

            assert.equal(line, `drop ${key}`);

            return "ok";
        },
        failed: undefined,
        holds: () => false,
        close: () => {},
    };
    const processes = new WindowsProcesses(helper);
    const poll = () => processes.members(task, true);

    assert.equal(await poll(), undefined, "the first receipt read fails");
    assert.equal(helper.holds(), true, "the new helper now holds the named job");
    table = "list 88,1,111";
    writeFileSync(file, `88 111 extra\nempty other-attempt\nempty ${key}`);
    assert.equal(
        await poll(),
        undefined,
        "ignore a malformed identity, a wrong key, and a torn line",
    );

    const ledger = `job ${key}\n77 123\nempty ${key}\n`;

    writeFileSync(file, ledger);
    table = "list 77,1,123";
    assert.deepEqual(
        await poll(),
        [77],
        "a restored live identity takes priority over the receipt",
    );
    table = "list";
    job = "members 91,456";
    assert.equal(await poll(), undefined, "the receipt conflicts with a nonempty job");
    assert.equal(helper.holds(), true);
    job = "members";
    assert.deepEqual(await poll(), [], "stable completion does not require the job to disappear");
    assert.equal(helper.holds(), false);
    assert.equal(readFileSync(file, "utf8"), ledger, "use the existing completion receipt");
});
