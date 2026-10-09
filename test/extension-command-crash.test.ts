import { cleanUp, context, root, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ConversationId, TaskId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

after(cleanUp);

type Ready = { event: "ready"; id: string; commandId: string; base: string; token: string };

async function startWorker(dataDir: string, phase: string, id = "") {
    const child = fork(
        new URL("./fixtures/native-command-crash.ts", import.meta.url),
        [dataDir, phase, id],
        {
            execArgv: [],
            silent: true,
            // Child helper directories also belong to this disposable data copy.
            env: { ...process.env, TEMP: dataDir, TMP: dataDir, TMPDIR: dataDir },
        },
    );
    let ready: Ready | undefined;
    let error: Error | undefined;
    let logs = "";

    child.stdout?.on("data", (chunk: Buffer) => {
        logs = (logs + chunk.toString()).slice(-8000);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
        logs = (logs + chunk.toString()).slice(-8000);
    });
    child.on("message", (message) => {
        if (
            message &&
            typeof message === "object" &&
            "event" in message &&
            message.event === "ready"
        ) {
            ready = message as Ready;
        }
    });
    child.on("error", (failure) => {
        error = failure;
    });
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    const exited = () => child.exitCode !== null || child.signalCode !== null;

    const stop = async () => {
        if (!exited()) {
            child.kill("SIGKILL");
        }

        await closed;
    };

    try {
        await until(
            () => ready !== undefined || exited() || error !== undefined,
            "the crash-test server",
            20_000,
        );

        if (!ready || child.pid === undefined) {
            throw new Error(`The crash-test server did not start: ${error?.message ?? logs}`);
        }

        return { ready, closed, exited, stop, pid: child.pid, logs: () => logs };
    } catch (failure) {
        await stop();

        throw failure;
    }
}

function post(server: Ready, request: { commandId: string; args: string; requestId: string }) {
    return fetch(`${server.base}/api/c/${server.id}/extension-commands`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${server.token}`,
            "Content-Type": "application/json",
            "x-pocket": "1",
        },
        body: JSON.stringify(request),
    });
}

/** Read the persisted checkpoint directly, before any Harness can recover or replace it. */
async function stored(dataDir: string, conversationId: string, taskId: number) {
    const storage = await openNodeSqliteStorage(join(dataDir, "pocket.sqlite"));

    try {
        const task = await storage.task(taskId as TaskId, context);
        const entries = await storage.scanEntries(
            { conversationId: Number(conversationId) as ConversationId },
            100,
            undefined,
            context,
        );

        assert.ok(task);
        assert.equal(entries.next, undefined);

        return { task, cards: entries.items.filter((entry) => entry.kind === "pocket.command") };
    } finally {
        await storage.close(context);
    }
}

for (const phase of ["effect", "memo", "card", "terminal"] as const) {
    test(`a hard kill after the command's ${phase} checkpoint never repeats its effect`, async () => {
        const dataDir = mkdtempSync(join(root, "command-crash-"));
        const first = await startWorker(dataDir, phase);
        let recovered: Awaited<ReturnType<typeof startWorker>> | undefined;

        try {
            const request = {
                commandId: first.ready.commandId,
                args: "",
                requestId: crypto.randomUUID(),
            };
            let early: Response | undefined;
            const pending = post(first.ready, request).then(
                (response) => {
                    early = response;

                    return { response };
                },
                (error: unknown) => ({ error }),
            );

            await until(
                async () => {
                    if (early) {
                        throw new Error(
                            `Expected a crash, but HTTP answered ${early.status}: ${await early.clone().text()}`,
                        );
                    }

                    return first.exited();
                },
                "the forced crash at the requested checkpoint",
                20_000,
            );
            await first.closed;
            assert.ok(
                "error" in (await pending),
                "the process died before acknowledging HTTP execution",
            );
            assert.equal(existsSync(join(dataDir, "orderly-exit")), false, first.logs());
            const checkpoint = JSON.parse(
                readFileSync(join(dataDir, "checkpoint.json"), "utf8"),
            ) as {
                phase: string;
                taskId: number;
            };

            assert.equal(checkpoint.phase, phase);
            assert.equal(readFileSync(join(dataDir, "effects"), "utf8"), "changed\n");
            const before = await stored(dataDir, first.ready.id, checkpoint.taskId);

            assert.equal(before.task.kind, "pocket.command");
            assert.equal(before.task.state.status, phase === "terminal" ? "terminal" : "running");
            assert.equal(before.cards.length, phase === "card" || phase === "terminal" ? 1 : 0);

            if (phase === "memo" || phase === "card") {
                assert.equal(
                    (before.task.memos?.result as { output?: string } | undefined)?.output,
                    "CRASH_RECOVERY_CARD_SENTINEL",
                );
            } else {
                assert.equal(before.task.memos?.result, undefined);
            }

            // The owned child has closed. Its PID can now belong to an unrelated process,
            // especially on Windows; that must not turn command recovery into a PID-lock test.
            // Verify ownership before removing only this stale lock, never durable task data.
            const lockFile = join(dataDir, "harness.lock");

            assert.equal(Number(readFileSync(lockFile, "utf8").trim()), first.pid);
            rmSync(lockFile);
            recovered = await startWorker(dataDir, "recover", first.ready.id);
            const response = await post(recovered.ready, request);

            assert.equal(response.status, 200, await response.clone().text());
            const receipt = await response.json();

            assert.equal(receipt.status, phase === "effect" ? "interrupted" : "done");
            assert.equal(receipt.type, phase === "effect" ? "toast" : "card");
            const duplicate = await post(recovered.ready, request);

            assert.equal(duplicate.status, 200);
            assert.deepEqual(await duplicate.json(), receipt);
            await recovered.stop();
            const after = await stored(dataDir, first.ready.id, checkpoint.taskId);

            assert.equal(after.task.state.status, "terminal");
            assert.equal(after.cards.length, phase === "effect" ? 0 : 1);

            if (after.cards[0]) {
                assert.equal(after.cards[0].model, undefined);
                assert.equal(
                    (after.cards[0].data as { output: string }).output,
                    "CRASH_RECOVERY_CARD_SENTINEL",
                );
            }

            assert.equal(readFileSync(join(dataDir, "effects"), "utf8"), "changed\n");
            assert.equal(existsSync(join(dataDir, "model-calls")), false);
        } finally {
            await first.stop();
            await recovered?.stop();
        }
    });
}
