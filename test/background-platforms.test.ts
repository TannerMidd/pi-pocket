import { type App, cleanUp, newSession, openApp, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { context } from "./helpers.ts";
import { type BackgroundTask, wait } from "../src/server/background.ts";
import { BackgroundDoc } from "../src/server/docs.ts";

const model = scriptedModel(() => fauxAssistantMessage([fauxText("noted")]));
const dataDir = join(root, "platforms");
let app: App;
const decoys: ChildProcess[] = [];

function quick(): void {
    app.background.timing = { look: 100, grace: 1000, starting: 600, sweep: 60_000 };
}

before(async () => {
    app = await openApp(model, dataDir);
    quick();
});

after(async () => {
    for (const decoy of decoys) {
        decoy.kill("SIGKILL");
    }

    await app?.close();
    cleanUp();
});

const running = (pid: number) => {
    try {
        process.kill(pid, 0);

        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
};

const one = async (id: ConversationId) =>
    Object.values((await app.harness.snapshot(BackgroundDoc, id, context))?.items ?? {})[0]!;

/** A command that starts node, which writes its own pid (the platform's, not bash's) and runs until stopped. */
const child = (file: string) =>
    `node -e "require('fs').writeFileSync('${file}', String(process.pid)); setInterval(() => {}, 1000)"`;

async function pidIn(item: BackgroundTask, file: string): Promise<number> {
    const path = join(item.cwd, file);

    await until(
        () => existsSync(path) && readFileSync(path, "utf8").trim() !== "",
        `${file} to be written`,
        30_000,
    );

    return Number(readFileSync(path, "utf8"));
}

test("a task runs, prints, and ends with its exit code", async () => {
    const id = await newSession(app);
    const item = await app.background.start(id, {
        command: "echo one; sleep 0.3; echo two; exit 3",
        notify: false,
    });

    assert.equal(item.status, "running");
    assert.ok(item.startTicks !== undefined, "its start time is recorded");
    await until(async () => (await one(id)).status !== "running", "the end", 30_000);
    assert.equal((await one(id)).status, "exited");
    assert.equal((await one(id)).code, 3);
    assert.equal((await app.background.read(id, item.id))?.text, "one\ntwo\n");
});

test("a stop ends the task and a child it started, also one its shell left", async () => {
    const id = await newSession(app);
    const item = await app.background.start(id, {
        command: `${child("waits.pid")} & first=$!; ${child("left.pid")} > /dev/null 2>&1 & echo started; wait $first`,
        notify: false,
    });
    const waits = await pidIn(item, "waits.pid");
    const left = await pidIn(item, "left.pid");

    assert.ok(running(waits) && running(left));
    await wait(500);

    const stopped = await app.background.stop(id, item.id);

    assert.equal(stopped?.status, "stopped");
    await until(() => !running(waits) && !running(left), "both children to be ended", 15_000);
    assert.equal(await app.background.aliveNow(id, item), false);
});

test("a task whose shell exits runs while its child runs", async () => {
    const id = await newSession(app);
    const item = await app.background.start(id, {
        command: `${child("daemon.pid")} > /dev/null 2>&1 & exit 0`,
        notify: false,
    });
    const daemon = await pidIn(item, "daemon.pid");

    await wait(1500);
    assert.equal((await one(id)).status, "running", "its child keeps it running");
    await app.background.stop(id, item.id);
    await until(() => !running(daemon), "the child to be ended", 15_000);
});

test("a stop never ends a process that took the task's pid", async () => {
    const id = await newSession(app);
    const item = await app.background.start(id, { command: child("real.pid"), notify: false });
    const real = await pidIn(item, "real.pid");
    // Another process, which is not the task's, in a group of its own, as a task's leader would be.
    const decoy = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        detached: true,
        stdio: "ignore",
    });

    decoys.push(decoy);
    await until(() => running(decoy.pid!), "the decoy to run");

    // As if the task's first process ended and the decoy took its pid: the record's start time is the task's.
    await app.harness.commit(async (tx) => {
        (await tx.doc(BackgroundDoc, id)).items[item.id]!.pid = decoy.pid!;
    }, context);
    await app.background.stop(id, item.id);
    await wait(1500);
    assert.equal(running(decoy.pid!), true, "the decoy runs on");

    await until(() => !running(real), "the task's own process to be ended", 15_000);
});

test("a task quiet for its limit is stopped, with what it printed", async () => {
    const id = await newSession(app);
    const item = await app.background.start(id, {
        command: `echo begun; ${child("quiet.pid")}`,
        quietMinutes: 0.05,
        notify: false,
    });
    const quiet = await pidIn(item, "quiet.pid");

    await until(async () => (await one(id)).status !== "running", "the quiet limit", 30_000);
    assert.equal((await one(id)).status, "stopped");
    assert.match((await one(id)).why ?? "", /printed nothing/);
    assert.equal((await app.background.read(id, item.id))?.text, "begun\n");
    await until(() => !running(quiet), "its process to be ended", 15_000);
});

test("a restarted server finds a task's processes, and its stop ends them", async () => {
    const id = await newSession(app);
    const item = await app.background.start(id, {
        command: `${child("restart.pid")} > /dev/null 2>&1 & while [ ! -f release ]; do sleep 0.1; done; ${child("after.pid")} > /dev/null 2>&1 & echo released`,
        notify: false,
    });
    const kept = await pidIn(item, "restart.pid");

    // A look or two finds the child before the server goes.
    await wait(1000);
    await app.close();
    assert.equal(running(kept), true, "the task outlives the server");
    app = await openApp(model, dataDir);
    quick();
    await wait(1000);

    // A child it starts after the restart, once its shell is gone, is found too (Windows: by its job).
    writeFileSync(join(item.cwd, "release"), "");
    const later = await pidIn(item, "after.pid");

    await wait(1500);
    assert.equal((await one(id)).status, "running", "its children keep it running");
    assert.equal(await app.background.aliveNow(id, await one(id)), true);
    await app.background.stop(id, item.id);
    await until(
        () => !running(kept) && !running(later),
        "the children to be ended after the restart",
        15_000,
    );
});
