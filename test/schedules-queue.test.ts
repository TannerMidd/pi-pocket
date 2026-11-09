// A repeat whose last message still waits in the session's queue sends no other: the time is skipped, counted, and
// said in the chat (src/server/schedules.ts).
import {
    type App,
    cleanUp,
    context,
    lastText,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { ChatDoc, ScheduleDoc } from "../src/server/docs.ts";

/** "hold" keeps Pi at work in a tool call until the test removes its flag; anything else is answered at once. */
const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);

    if (role === "user" && text.endsWith("hold")) {
        return fauxAssistantMessage(
            [fauxToolCall("bash", { command: "while [ -e hold.flag ]; do sleep 0.1; done" })],
            { stopReason: "toolUse" },
        );
    }

    return fauxAssistantMessage([fauxText(`echo: ${text}`)]);
};

let app: App | undefined;
let offset = 0;

after(async () => {
    await app?.close();
    cleanUp();
});

/** Move the server's clock on, and let the tasks whose time came run. */
function later(minutes: number): void {
    offset += minutes * 60_000;
    app!.harness.resume();
}

async function scheduledTexts(id: ConversationId): Promise<string[]> {
    const page = await (await app!.harness.conversation(id, context))!.entries(
        {},
        100,
        undefined,
        context,
    );

    return page.items
        .filter((entry) => entry.kind === "pi.user")
        .map((entry) => JSON.stringify(entry.model))
        .filter((text) => text.includes("[scheduled] ping"));
}

test("a repeat skips its time while its last message waits in the queue, and says so", async () => {
    const dataDir = join(root, "schedules-queue");

    app = await openApp(scriptedModel(route), dataDir, () => Date.now() + offset);
    const id = await newSession(app);
    const flag = join(work, "hold.flag");

    writeFileSync(flag, "");

    try {
        // Pi is at work: what the schedule sends waits in the queue.
        const { submissionId } = await app.commands.submit(id, owner(app), {
            text: "hold",
            requestId: crypto.randomUUID(),
        });

        await until(() => app!.isBusy(id), "Pi to be at work");
        const repeat = await app.commands.schedule(id, owner(app), {
            when: "every 10m ping",
            zone: "UTC",
        });
        const item = async () =>
            (await app!.harness.snapshot(ScheduleDoc, id, context))?.items[repeat.id];

        later(11);
        await until(async () => (await item())?.runs === 1, "the first time to go out");
        assert.equal(app.isBusy(id), true, "still at work: the message waits");

        // The next time finds it still waiting: no second message, one skip.
        later(11);
        await until(async () => (await item())?.skipped === 1, "the second time to be skipped");
        assert.equal((await item())?.runs, 1, "no other message went out");
        later(11);
        await until(async () => (await item())?.skipped === 2, "the third time to be skipped");

        const chat = await app.harness.snapshot(ChatDoc, id, context);
        const lines = (chat?.messages ?? []).filter(
            (each) => each.kind === "event" && each.text.includes("skipped"),
        );

        assert.equal(lines.length, 1, "one line, updated while the skips go on");
        assert.equal(
            lines[0]!.text,
            "skipped “ping” 2 times: its last message still waits in the queue.",
        );
        assert.equal(lines[0]!.name, "Schedules");
        assert.equal((await item())!.skippedAt! > (await item())!.next - 11 * 60_000, true);

        // Pi is free: the waiting message is taken, and the next time sends again.
        rmSync(flag);
        await (await app.harness.submission(submissionId, context))!.wait(context);
        await until(async () => (await scheduledTexts(id)).length === 1, "the waiting message");
        await until(() => !app!.isBusy(id), "Pi to answer it");
        later(11);
        await until(async () => (await item())?.runs === 2, "the next time to go out");
        await until(async () => (await scheduledTexts(id)).length === 2, "its message");
        assert.equal((await item())?.skipped, 2, "the count stays, for people to see");
    } finally {
        rmSync(flag, { force: true });
    }
});
