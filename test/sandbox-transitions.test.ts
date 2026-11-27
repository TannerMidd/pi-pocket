// A change of a session's sandbox is one step at a time, and no tool call runs while it does: turning it on stores the
// setting only when nothing runs on this machine (so a refused turn-on leaves no VM), and turning it off stops the VM,
// and waits for it, before the folder stops being confined. Each step is held by a gate, not by a delay.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { sandboxedFolder } from "../src/server/confined.ts";
import { SandboxDoc, SubagentsDoc } from "../src/server/docs.ts";
import { FakeDriver, sandboxOptions, useDriver } from "./gondolin-fake.ts";
import {
    cleanUp,
    context,
    loadTools,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
    type App,
} from "./helpers.ts";

after(cleanUp);

let opened = 0;

/** A promise that settles when `open` is called, and one that settles when something reaches `wait`. */
function gate() {
    let open!: () => void;
    let reach!: () => void;
    const opened = new Promise<void>((resolve) => (open = resolve));
    const reached = new Promise<void>((resolve) => (reach = resolve));

    return {
        open,
        reached,
        wait: async () => {
            reach();
            await opened;
        },
    };
}

/** A signal that something was called, for a method that is called as it is. */
function signal() {
    let fire!: () => void;
    const fired = new Promise<void>((resolve) => (fire = resolve));

    return { fire, fired };
}

async function session(name: string) {
    const driver = new FakeDriver();

    useDriver(driver);
    const model = scriptedModel((request) => {
        const { messages } = request as { messages: { role: string }[] };

        return messages.at(-1)?.role === "toolResult"
            ? fauxAssistantMessage([fauxText("done")])
            : fauxAssistantMessage([fauxToolCall("bash", { command: "echo hi" })], {
                  stopReason: "toolUse",
              });
    });
    const app = await openApp(
        model,
        join(root, `data-transition-${++opened}`),
        undefined,
        undefined,
        sandboxOptions(),
    );
    const folder = join(root, `transition-${name}`);

    mkdirSync(folder, { recursive: true });
    await app.setExtensionEnabled(owner(app), "gondolin.ts", true);

    return { app, driver, folder, id: await newSession(app, folder) };
}

/** Hold the first look for work on this machine that a turn-on makes, until the gate opens. */
function holdHostWork(app: App, held: ReturnType<typeof gate>): void {
    const look = app.harness.watchTaskGraph.bind(app.harness);
    let first = true;

    app.harness.watchTaskGraph = async (...args: Parameters<typeof look>) => {
        if (first) {
            first = false;
            await held.wait();
        }

        return look(...args);
    };
}

/** Say when a tool call of the session comes to wait for the change, and when a VM starts. */
function watchCalls(app: App, driver: FakeDriver) {
    const waiting = signal();
    const started = signal();
    const settled = app.sandboxes.settled.bind(app.sandboxes);
    const start = driver.start.bind(driver);

    app.sandboxes.settled = (id) => {
        waiting.fire();

        return settled(id);
    };

    driver.start = async (spec) => {
        started.fire();

        return start(spec);
    };

    return { either: Promise.race([waiting.fired, started.fired]) };
}

test("a turn-on that is refused leaves no VM, and a call that comes meanwhile waits for it", async () => {
    const { app, driver, id } = await session("refused");
    const person = owner(app);
    const held = gate();

    try {
        const task = await app.background.start(id, {
            requestedBy: person.id,
            command: "tail -f /dev/null",
            quietMinutes: 0,
            notify: false,
        });

        holdHostWork(app, held);
        const calls = watchCalls(app, driver);
        const change = app.sandboxes.set(id, person, true).then(
            () => undefined,
            (error: unknown) => error,
        );

        await held.reached;
        const run = say(app, id, "run it");

        await calls.either;
        assert.equal(driver.log.started.length, 0, "a VM started for a setting that is not kept");
        held.open();

        assert.match(String(await change), /still runs work on this machine/);
        await run;
        assert.equal((await app.sandboxes.get(id)).on, false);
        assert.equal(driver.log.started.length, 0);
        assert.equal(driver.log.commands.length, 0, "the call ran in a VM");
        await app.background.stop(id, task.id);
    } finally {
        useDriver(undefined);
        held.open();
        await app.close();
    }
});

test("a call that comes while the sandbox is turned on runs in the VM once it is on", async () => {
    const { app, driver, id } = await session("waits");
    const held = gate();

    try {
        holdHostWork(app, held);
        const calls = watchCalls(app, driver);
        const change = app.sandboxes.set(id, owner(app), true);

        await held.reached;
        const run = say(app, id, "run it");

        await calls.either;
        assert.equal(driver.log.started.length, 0, "a VM started before the setting was kept");
        assert.equal((await app.sandboxes.get(id)).on, false);
        held.open();
        await change;
        await run;
        assert.equal(driver.log.started.length, 1);
        assert.ok(driver.log.commands.length > 0, "the call did not run in the VM");
    } finally {
        useDriver(undefined);
        held.open();
        await app.close();
    }
});

test("the folder stays confined, and the setting on, until the VM is gone when the sandbox is turned off", async () => {
    const { app, driver, folder, id } = await session("off");
    const held = gate();

    try {
        await app.sandboxes.set(id, owner(app), true);
        await say(app, id, "run it");
        await until(() => driver.vms.length === 1, "the VM to start");
        assert.equal(sandboxedFolder(folder), true);

        const vm = driver.vms[0]!;
        const close = vm.close.bind(vm);

        vm.close = async () => {
            await held.wait();
            await close();
        };

        const calls = watchCalls(app, driver);
        const change = app.sandboxes.set(id, owner(app), false);

        await held.reached;
        assert.equal(
            (await app.sandboxes.get(id)).on,
            true,
            "the setting went off before the VM did",
        );
        assert.equal(sandboxedFolder(folder), true, "the folder was open before the VM was gone");

        const run = say(app, id, "run it again");

        await calls.either;
        assert.equal(vm.closed, false);
        held.open();
        await change;
        await run;
        assert.equal(vm.closed, true);
        assert.equal((await app.sandboxes.get(id)).on, false);
        assert.equal(sandboxedFolder(folder), false);
        assert.equal(driver.log.started.length, 1, "the call that waited started a VM");
    } finally {
        useDriver(undefined);
        held.open();
        await app.close();
    }
});

test("a subagent that is made after the sandbox looked for them, and before it is stored, is in the sandbox", async () => {
    const { app, id } = await session("late-child");
    const held = gate();

    try {
        holdHostWork(app, held);
        const change = app.sandboxes.set(id, owner(app), true);

        await held.reached;

        // What a spawn that was already running commits: the child, listed under its parent, with the setting it read.
        const child = await app.harness.commit(async (tx) => {
            const made = await tx.createConversation({ ownership: { kind: "ownerless" } });

            (await tx.doc(SubagentsDoc, id)).agents.helper = {
                conversationId: made.id,
                reported: [],
            };

            return made.id;
        }, context);

        held.open();
        await change;
        assert.equal((await app.harness.snapshot(SandboxDoc, child, context))?.on, true);
    } finally {
        useDriver(undefined);
        held.open();
        await app.close();
    }
});

test("the sandbox is not turned on while a background call has not made its record, and the call goes on", async () => {
    const driver = new FakeDriver();

    useDriver(driver);
    const model = scriptedModel((request) => {
        const { messages } = request as { messages: { role: string }[] };

        return messages.at(-1)?.role === "toolResult"
            ? fauxAssistantMessage([fauxText("done")])
            : fauxAssistantMessage(
                  [
                      fauxToolCall("background", {
                          action: "start",
                          command: "echo hi",
                          notify: false,
                      }),
                  ],
                  { stopReason: "toolUse" },
              );
    });
    const app = await openApp(
        model,
        join(root, `data-transition-${++opened}`),
        undefined,
        undefined,
        sandboxOptions(),
    );
    const held = gate();

    try {
        const folder = join(root, "transition-background");

        mkdirSync(folder, { recursive: true });
        await app.setExtensionEnabled(owner(app), "gondolin.ts", true);
        const id = await newSession(app, folder);

        await loadTools(app, id, "background");
        const start = app.background.start.bind(app.background);

        // The call is in flight, and has not reserved its record: the point where a turn-on used to find nothing.
        app.background.start = async (...args: Parameters<typeof start>) => {
            await held.wait();

            return start(...args);
        };

        const run = say(app, id, "start it");

        await held.reached;
        await assert.rejects(
            app.sandboxes.set(id, owner(app), true),
            /still runs work on this machine: a background call that is running/,
        );
        assert.equal((await app.sandboxes.get(id)).on, false);
        held.open();
        await run;
        assert.equal(driver.log.started.length, 0);
    } finally {
        useDriver(undefined);
        held.open();
        await app.close();
    }
});
