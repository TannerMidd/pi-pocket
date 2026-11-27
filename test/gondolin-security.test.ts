// Security fixes of the third review round, with a fake VM: host work that runs when the sandbox is turned on, host
// files that an artifact names, and a VM that keeps the folder a session has left. The real VM runs the same for the
// git files and the folder move in `gondolin-real-parity.test.ts`.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { runningNow } from "../src/server/running.ts";
import { SandboxManager } from "../src/server/extensions/gondolin/manager.ts";
import { VmJobs } from "../src/server/extensions/gondolin/jobs.ts";
import { FakeDriver } from "./gondolin-fake.ts";
import {
    cleanUp,
    context,
    modelTexts,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";

after(cleanUp);

let opened = 0;
const openFresh = (model: ReturnType<typeof scriptedModel>) =>
    openApp(model, join(root, `data-security-${++opened}`));
const SEAM = Symbol.for("pi-pocket.gondolin.test-driver");
const MODULE = "gondolin.ts";

const useDriver = (driver: FakeDriver | undefined) => {
    (globalThis as Record<symbol, unknown>)[SEAM] = driver;
};

function folder(name: string): string {
    const path = join(root, `security-${name}`);

    mkdirSync(path, { recursive: true });

    return path;
}

const later = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ─── Host work that runs when the sandbox is turned on ──────────────────────

test("the sandbox is refused while the session runs a background task or a ! command on this machine, and turns on when they end", async () => {
    const driver = new FakeDriver();

    useDriver(driver);
    const app = await openFresh(scriptedModel());

    try {
        await app.setExtensionEnabled(owner(app), MODULE, true);
        const id = await newSession(app, folder("host-work"));
        const person = owner(app);

        // A background task of this machine.
        const task = await app.background.start(id, {
            requestedBy: person.id,
            command: "tail -f /dev/null",
            quietMinutes: 0,
            notify: false,
        });

        await assert.rejects(
            app.sandboxes.set(id, person, true),
            /still runs work on this machine: a background task/,
        );
        assert.equal((await app.sandboxes.get(id)).on, false, "the setting was put back");
        assert.equal(driver.log.started.length, 0);
        await app.background.stop(id, task.id);
        await until(
            async () => (await app.background.list(id)).every((item) => item.status !== "running"),
            "the task to end",
        );

        // A ! command of this machine.
        const shell = await app.shell.start(id, person, { command: "tail -f /dev/null" });

        await until(
            async () =>
                (await runningNow(app, person)).some((session) =>
                    session.tasks.some((each) => each.kind === "pocket.shell"),
                ),
            "the ! command to run",
        );
        await assert.rejects(
            app.sandboxes.set(id, person, true),
            /still runs work on this machine: a ! command \(tail -f \/dev\/null\)/,
        );
        assert.equal((await app.sandboxes.get(id)).on, false);
        await app.shell.stop(id, person, shell.taskId);
        await until(async () => {
            try {
                await app.sandboxes.set(id, person, true);

                return true;
            } catch {
                return false;
            }
        }, "the sandbox to turn on after the work ended");
        assert.equal((await app.sandboxes.get(id)).on, true);
    } finally {
        await app.close();
    }
});

// ─── Host files that an artifact names ──────────────────────────────────────

test("an artifact of a sandboxed session cannot read a host file through an asset", async () => {
    const driver = new FakeDriver();
    const secret = mkdtempSync(join(tmpdir(), "gondolin-secret-"));

    writeFileSync(join(secret, "key.txt"), "host-file-content");
    useDriver(driver);
    const model = scriptedModel((request) => {
        const { messages } = request as { messages: { role: string }[] };

        return messages.at(-1)?.role === "toolResult"
            ? fauxAssistantMessage([fauxText("done")])
            : fauxAssistantMessage(
                  [
                      fauxToolCall("artifact", {
                          id: "leak",
                          title: "leak",
                          content: "<p>hi</p>",
                          assets: [{ name: "key.txt", path: join(secret, "key.txt") }],
                      } as never),
                  ],
                  { stopReason: "toolUse" },
              );
    });
    const app = await openFresh(model);

    try {
        await app.setExtensionEnabled(owner(app), MODULE, true);
        const id = await newSession(app, folder("artifact"));

        await app.sandboxes.set(id, owner(app), true);
        await say(app, id, "publish");
        const texts = (await modelTexts(app, id)).join("\n");

        assert.match(texts, /runs on the host, outside the sandbox/);
        assert.ok(!texts.includes("host-file-content"));
    } finally {
        await app.close();
        rmSync(secret, { recursive: true, force: true });
    }
});

// ─── A VM keeps the folder a session has left ───────────────────────────────

test("a session that moves to another folder while a task holds its VM gets a VM for the new folder", async () => {
    const driver = new FakeDriver();
    const base = mkdtempSync(join(tmpdir(), "gondolin-move-"));
    const first = join(base, "first");
    const second = join(base, "second");

    mkdirSync(first);
    mkdirSync(second);
    const vms = new SandboxManager({
        driver,
        log: () => {},
        pidFile: join(base, "vms.json"),
        settings: () => ({
            backend: "auto",
            mount: "rw",
            network: "off",
            allowedHosts: [],
            cpus: 1,
            memoryMb: 512,
            diskMb: 1024,
            idleMinutes: 30,
            maxVms: 2,
            image: "alpine-base:latest",
        }),
    });
    const ended: string[] = [];
    const target = (cwd: string) => ({ rootId: 5, cwd, uploadDir: undefined });

    try {
        const env = vms.envFor(5, target(first));

        assert.ok((await env.exec("true", undefined, context)).ok);
        const release = vms.hold(target(first));

        // The session moves; a task still holds the VM, so nothing stops it at once.
        const moved = vms.envFor(5, target(second));

        assert.equal(driver.log.closed.length, 0, "a busy VM is not stopped by the move itself");
        assert.ok((await moved.exec("true", undefined, context)).ok);
        assert.equal(driver.log.started.length, 2, "the call in the new folder got a new VM");
        assert.equal(driver.log.started[1]!.cwd, second);
        assert.equal(driver.log.closed.length, 1, "the VM of the old folder ended");
        assert.equal(vms.state(5)?.cwd, second);
        release();
        ended.push("released");
    } finally {
        await vms.stopAll("the test ended");
        rmSync(base, { recursive: true, force: true });
    }

    assert.deepEqual(ended, ["released"]);
});

test("a task that ran in the old folder is reported ended when the session moves", async () => {
    const driver = new FakeDriver();
    const base = mkdtempSync(join(tmpdir(), "gondolin-move-"));
    const first = join(base, "first");
    const second = join(base, "second");

    mkdirSync(first);
    mkdirSync(second);
    let jobs: VmJobs | undefined;
    const vms = new SandboxManager({
        driver,
        log: () => {},
        pidFile: join(base, "vms.json"),
        settings: () => ({
            backend: "auto",
            mount: "rw",
            network: "off",
            allowedHosts: [],
            cpus: 1,
            memoryMb: 512,
            diskMb: 1024,
            idleMinutes: 30,
            maxVms: 2,
            image: "alpine-base:latest",
        }),
        onEnded: (rootId, reason) => jobs?.vmEnded(rootId, reason),
    });

    jobs = new VmJobs({
        file: join(base, "jobs.json"),
        spawn: (target, command, options) => vms.spawnShell(target, command, options),
        hold: (target) => vms.hold(target),
        limits: () => ({ running: 5, taskQuietMs: 0 }),
        log: () => {},
    });
    const api = jobs.for({ rootId: 6, cwd: first, uploadDir: undefined, own: true });

    try {
        assert.match(await api.start({ command: "tail -f /dev/null", key: "old" }), /Started vm-1/);
        vms.envFor(6, { rootId: 6, cwd: second, uploadDir: undefined });
        const env = vms.envFor(6, { rootId: 6, cwd: second, uploadDir: undefined });

        assert.ok((await env.exec("true", undefined, context)).ok);
        await later(100);
        assert.match(await api.list(), /vm-1: ended: the session's folder changed/);
        assert.equal(driver.log.started.at(-1)!.cwd, second);
    } finally {
        await vms.stopAll("the test ended");
        rmSync(base, { recursive: true, force: true });
    }
});
