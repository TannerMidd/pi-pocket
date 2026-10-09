/** A real HTTP test server killed at a durable command checkpoint; only its parent test starts it. */
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { createHandler } from "../../src/server/http.ts";
import { newSession, openApp, owner, scriptedModel } from "../helpers.ts";

const [dataDir = "", phase = "", existingId] = process.argv.slice(2);

if (
    !process.send ||
    !dataDir ||
    !["effect", "memo", "card", "terminal", "recover"].includes(phase)
) {
    throw new Error("Start this fixture through extension-command-crash.test.ts.");
}

process.once("exit", () => writeFileSync(join(dataDir, "orderly-exit"), "yes"));
const model = scriptedModel(() => {
    appendFileSync(join(dataDir, "model-calls"), "request\n");

    return fauxAssistantMessage([fauxText("No model request was expected.")]);
});
const app = await openApp(model, dataDir);
const file = "native-crash.ts";
const path = join(dataDir, "extensions", file);
let taskId: number | undefined;
let taskState: string | undefined;
let resultMemo = false;
let cards = 0;

function crash(): never {
    writeFileSync(
        join(dataDir, "checkpoint.json"),
        JSON.stringify({ phase, taskId, taskState, resultMemo, cards }),
    );
    // Deliberate process failure: no app.close(), exit handlers, or further Session operations.
    process.kill(process.pid, "SIGKILL");

    throw new Error("SIGKILL did not stop the fixture.");
}

const globals = globalThis as typeof globalThis & { pocketNativeCrashEffect?: () => void };

globals.pocketNativeCrashEffect = () => {
    if (phase === "effect") {
        crash();
    }
};

app.harness.subscribeCommits((publication) => {
    for (const change of publication.changes) {
        if (change.type === "task" && change.value.kind === "pocket.command") {
            taskId = Number(change.value.id);
            taskState = change.value.state.status;
            resultMemo = change.value.memos?.result !== undefined;
        }

        if (change.type === "entry" && change.value.kind === "pocket.command") {
            cards++;
        }
    }

    if (
        (phase === "memo" && taskState === "running" && resultMemo) ||
        (phase === "card" && taskState === "running" && cards === 1) ||
        (phase === "terminal" && taskState === "terminal")
    ) {
        crash();
    }
});

if (!existsSync(path)) {
    writeFileSync(
        path,
        `/** A command with an external side effect for crash-boundary tests. */
import { appendFileSync } from "node:fs";
import { join } from "node:path";
export default (host) => {
    host.commands.register({
        name: "crash-status", description: "Exercise real recovery", scope: "conversation",
        handler() {
            appendFileSync(join(host.dataDir, "effects"), "changed\\n");
            globalThis.pocketNativeCrashEffect();
            return { type: "card", output: "CRASH_RECOVERY_CARD_SENTINEL" };
        },
    });
    return [];
};
`,
    );
}

await app.setExtensionEnabled(owner(app), file, true);
const id = existingId ? (Number(existingId) as ConversationId) : await newSession(app);
const server = createServer(
    createHandler({
        app,
        listen: { host: "127.0.0.1", port: 0 },
        restart: () => {},
    }),
);

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();

if (!address || typeof address === "string") {
    throw new Error("The fixture has no HTTP port.");
}

process.send({
    event: "ready",
    id: String(id),
    commandId: app.loader.commands().find((command) => command.name === "crash-status")!.id,
    base: `http://127.0.0.1:${address.port}`,
    token: app.config.ownerToken,
});
