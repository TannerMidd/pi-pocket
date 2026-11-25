import { cleanUp, context, newSession, openApp, owner, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { after, test } from "node:test";
import { StartCutOff } from "../src/server/background.ts";
import { BackgroundDoc } from "../src/server/docs.ts";
import {
    taskProcesses,
    type TaskProcesses,
    type TaskRef,
    WindowsProcesses,
} from "../src/server/processes.ts";

after(cleanUp);

for (const cutOff of [false, true]) {
    test(
        `a ${cutOff ? "starting" : "running"} watch retains a Windows attempt across failed probes`,
        { skip: process.platform !== "linux" },
        async (t) => {
            const app = await openApp(scriptedModel());

            t.after(() => app.close());
            app.background.timing = { look: 40, starting: 100, grace: 100, sweep: 60_000 };
            const id = await newSession(app);
            let state: "unavailable" | "child" | "empty" = "unavailable";
            const probes: number[] = [];
            const backend = new WindowsProcesses({
                ask: async (line) => {
                    if (line.startsWith("members ")) {
                        probes.push(performance.now());
                    }

                    if (state === "unavailable") {
                        if (line === "list" && probes.length % 2 === 0) {
                            return "incomplete";
                        }

                        if (line === "list") {
                            throw new Error("synthetic helper outage");
                        }

                        return "members";
                    }

                    if (line === "list") {
                        return state === "child" ? "list 77,1,123" : "list";
                    }

                    return line.startsWith("members ")
                        ? state === "child"
                            ? "members 77,123"
                            : "members"
                        : "ok";
                },
                failed: undefined,
                close: () => {},
                holds: () => false,
            });
            const processes = Object.getPrototypeOf(taskProcesses()) as TaskProcesses;
            const spawn = t.mock.method(
                processes,
                "spawn",
                async (_script: string, _cwd: string, env: NodeJS.ProcessEnv, task: TaskRef) => {
                    const key = createHash("sha256").update(task.marker).digest("hex").slice(0, 32);

                    writeFileSync(`${task.files}.pids`, `job ${key}\n`);
                    writeFileSync(env.PI_POCKET_BACKGROUND_EXIT!, "7 0\n");

                    return { pid: 41, start: 100 };
                },
            );

            t.mock.method(processes, "members", backend.members.bind(backend));
            t.mock.method(processes, "find", backend.find.bind(backend));
            t.mock.method(processes, "left", async () => []);

            if (cutOff) {
                app.background.beforeRecord = async () => {
                    state = "child";
                    let overdue = 0;

                    app.background.timing = {
                        ...app.background.timing,
                        get starting() {
                            overdue++;

                            return -1;
                        },
                    };
                    await until(() => overdue >= 3, "the overdue local launch to stay reserved");
                    assert.equal(
                        probes.length,
                        0,
                        "recovery must not adopt an active local launch",
                    );
                    state = "unavailable";

                    throw new StartCutOff();
                };
            }

            const start = app.background.start(id, {
                command: "synthetic",
                requestedBy: owner(app).id,
                notify: false,
                quietMinutes: 0,
            });

            if (cutOff) {
                await assert.rejects(start, StartCutOff);
            } else {
                await start;
            }

            const row = async () =>
                Object.values((await app.harness.snapshot(BackgroundDoc, id, context))!.items)[0]!;

            await until(() => probes.length >= 3, "repeated inconclusive probes");
            assert.ok(
                probes[2]! - probes[0]! >= app.background.timing.look,
                "recovery waits between probes",
            );
            assert.equal((await row()).status, cutOff ? "starting" : "running");

            const count = probes.length;

            state = "child";
            await until(
                () => probes.length >= count + 3,
                "the verified child to stay under supervision",
            );
            assert.equal((await row()).status, "running");

            if (cutOff) {
                assert.equal((await row()).pid, 77);
                assert.equal((await row()).startTicks, 123);
            }

            state = "empty";
            await until(async () => (await row()).status === "exited", "proved completion");
            assert.equal((await row()).code, 7);
            assert.equal((await row()).processAlive, false);
            assert.equal(spawn.mock.callCount(), 1);
        },
    );
}
