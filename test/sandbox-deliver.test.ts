// Deferred deliveries keep their records (design 4.8): a background report that cannot go is not marked told and keeps its
// batch; a message sent again or an Interrupt waits and is sent once; `untilDelivered` stops on an abort.
import {
    type App,
    cleanUp,
    context,
    lastText,
    loadTools,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Deferred, untilDelivered } from "../src/server/deliver.ts";
import { BackgroundDoc } from "../src/server/docs.ts";
import { resendTask } from "../src/server/resend.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

const skip = existsSync("/proc/self/stat") ? false : "no /proc on this machine";

const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);

    if (role === "toolResult") {
        return fauxAssistantMessage([fauxText(`tool said: ${text}`)]);
    }

    const args = /^(?:\[from: [^\]]+\] )?bg (\{.*\})$/s.exec(text)?.[1];

    return args === undefined
        ? fauxAssistantMessage([fauxText(`echo: ${text.slice(0, 500)}`)])
        : fauxAssistantMessage([fauxToolCall("background", JSON.parse(args))], {
              stopReason: "toolUse",
          });
};

let app: App;

before(async () => {
    app = await openApp(scriptedModel(route), join(root, "data-deliver"));
    app.background.timing = { look: 50, grace: 400, starting: 300, sweep: 60_000 };
});

after(async () => {
    await app?.close();
    cleanUp();
});

test(
    "a background report that cannot be delivered is not marked told, keeps its batch, and goes once after",
    { skip },
    async () => {
        const id: ConversationId = await newSession(app);

        await loadTools(app, id, "background");
        const flag = join(root, "deliver-flag");
        const command = `while [ ! -e ${flag} ]; do sleep 0.05; done; echo finished`;
        const { submissionId } = await app.commands.submit(id, owner(app), {
            text: `bg ${JSON.stringify({ action: "start", command })}`,
            requestId: crypto.randomUUID(),
        });

        await (await app.harness.submission(submissionId, context))!.wait(context);
        const original = app.sandboxes.requireDelivery.bind(app.sandboxes);
        let blocked = true;
        let tries = 0;

        // The sandbox of the session is changing: every delivery defers, quickly.
        app.sandboxes.requireDelivery = (target) => {
            if (blocked) {
                tries++;

                throw new Deferred("The sandbox of this session is changing.", 20);
            }

            original(target);
        };

        const items = async () =>
            Object.values((await app.harness.snapshot(BackgroundDoc, id, context))?.items ?? {});
        const texts = async () =>
            (
                await (await app.harness.conversation(id, context))!.entries(
                    {},
                    200,
                    undefined,
                    context,
                )
            ).items
                .filter((entry) => entry.kind === "pi.user")
                .map((entry) => JSON.stringify(entry.model));

        writeFileSync(flag, "go");
        await until(
            async () => tries >= 3,
            "the report to try, be deferred, and try again",
            20_000,
        );
        const [task] = await items();

        assert.equal(task?.status, "exited");
        assert.equal(task?.toldAt, undefined, "a deferred report is not marked told");
        assert.ok(task?.batch !== undefined, "its batch stays saved under its request id");
        assert.equal(
            (await texts()).filter((text) => /\[background\]|Task 000001/i.test(text)).length,
            0,
            "nothing was delivered",
        );
        const batch = task?.batch;

        blocked = false;
        await until(
            async () => (await items())[0]?.toldAt !== undefined,
            "the report after the resume",
            20_000,
        );
        assert.equal((await items())[0]?.batch, undefined);
        assert.equal(
            (await texts()).filter((text) => /Task 000001/.test(text)).length,
            1,
            `the same batch (${batch}) went once`,
        );
        app.sandboxes.requireDelivery = original;
    },
);

test("a message sent again waits while its tree changes, and is sent once; the task is not finished early", async () => {
    let blocked = 2;
    const sent: string[] = [];

    const submit = (_tx: unknown, draft: { requestId: string }) => {
        sent.push(draft.requestId);

        return Promise.resolve(1);
    };

    const task = resendTask(
        () => true,
        () => Promise.resolve(new Set<string>()),
        () => {
            if (blocked-- > 0) {
                throw new Deferred("The sandbox is changing.", 1);
            }
        },
    );
    let finished = false;
    const runtime = {
        conversationId: 1,
        conversation: () => Promise.resolve({ id: 1, submit }),
        commit: (change: (tx: unknown) => unknown) =>
            Promise.resolve(change({ doc: () => ({ items: {} }) })).then((result) => {
                finished = result !== undefined;

                return result;
            }),
    };

    await task.definition.phases.send(
        { input: { text: "fork", by: "someone" } } as never,
        runtime as never,
        BACKGROUND_CONTEXT,
    );
    assert.deepEqual(sent, ["u:someone:resend"].slice(0, sent.length));
    assert.equal(blocked, -1, "it asked three times: two deferrals, then the delivery");
    assert.equal(sent.length, 1, "sent once");
    assert.equal(finished, true, "finished only after the delivery");
});

test("a wait for a deferred delivery ends with the task's abort", async () => {
    const stop = new AbortController();
    let tries = 0;
    const waiting = untilDelivered(
        () => {
            tries++;

            return Promise.reject(new Deferred("Changing.", 10_000));
        },
        { abortSignal: stop.signal } as never,
    );

    await until(() => tries === 1, "the first try");
    stop.abort(new Error("stopped"));
    await assert.rejects(waiting);
    assert.equal(tries, 1);
});
