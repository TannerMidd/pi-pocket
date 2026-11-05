import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
    existsSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    symlinkSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { takeLock } from "../src/server/lock.ts";

const linux = process.platform === "linux";
const lockModule = new URL("../src/server/lock.ts", import.meta.url).href;
// A child that takes the lock itself, as a running server does.
const holderScript = `
    import { takeLock } from ${JSON.stringify(lockModule)};
    takeLock(process.argv[1]);
    process.send("held");
    setInterval(() => {}, 1000);
`;

function fixture(t: TestContext) {
    const dir = mkdtempSync(join(tmpdir(), "pocket-lock-test-"));
    const lock = join(dir, "harness.lock");
    const children: ChildProcess[] = [];

    t.after(() => {
        children.forEach((each) => each.kill("SIGKILL"));
        rmSync(dir, { recursive: true, force: true });
    });

    /** A live child process. With `hold`, it has taken the lock, under a name that is not `node`. */
    async function child(hold = false) {
        const executable = join(dir, "pocket-host");

        symlinkSync(process.execPath, executable);

        const each = hold
            ? spawn(executable, ["--input-type=module", "-e", holderScript, "--", lock], {
                  stdio: ["ignore", "inherit", "inherit", "ipc"],
              })
            : spawn("sleep", ["60"], { stdio: "ignore" });

        children.push(each);
        await (hold ? once(each, "message") : once(each, "spawn"));

        return each;
    }

    return { lock, child };
}

function identity(lock: string): { pid: number; startTime: string; fileId: string } {
    return JSON.parse(readFileSync(`${lock}.identity`, "utf8"));
}

function assertOccupied(lock: string): void {
    const before = readFileSync(lock, "utf8");

    assert.throws(() => takeLock(lock), /already running/i);
    assert.equal(readFileSync(lock, "utf8"), before);
}

function assertTakenOver(lock: string): void {
    const release = takeLock(lock);

    assert.equal(readFileSync(lock, "utf8").trim(), String(process.pid));
    assert.equal(identity(lock).pid, process.pid);
    release();
    assert.equal(existsSync(lock), false);
    assert.equal(existsSync(`${lock}.identity`), false);
}

test("a live holder under a name that is not node keeps the lock", async (t) => {
    const { lock, child } = fixture(t);

    await child(true);
    assertOccupied(lock);
});

test("a reused pid with another start time is taken over", { skip: !linux }, async (t) => {
    const { lock, child } = fixture(t);
    const holder = await child(true);
    const saved = { ...identity(lock), startTime: "1" };

    writeFileSync(`${lock}.identity`, JSON.stringify(saved));
    assertTakenOver(lock);
    assert.doesNotThrow(() => process.kill(holder.pid!, 0));
});

test(
    "a legacy lock follows whether its process started after the lock",
    { skip: !linux },
    async (t) => {
        const { lock, child } = fixture(t);
        const holder = await child();
        const old = new Date(Date.now() - 60_000);

        writeFileSync(lock, `${holder.pid}\n`);
        assertOccupied(lock);
        utimesSync(lock, old, old);
        assertTakenOver(lock);
    },
);

test("an empty lock is taken over when old, and not when young", (t) => {
    const { lock } = fixture(t);
    const young = new Date(Date.now() - 1000);
    const old = new Date(Date.now() - 11_000);

    writeFileSync(lock, "");
    utimesSync(lock, young, young);
    assert.throws(() => takeLock(lock), /incomplete|damaged/i);
    utimesSync(lock, old, old);
    assertTakenOver(lock);
});
