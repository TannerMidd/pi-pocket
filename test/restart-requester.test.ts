import {
    cleanUp,
    context,
    lastText,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, test } from "node:test";
import { withAbortSignal } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";

after(cleanUp);

test("restart recovers unfinished runs only for their original, still-authorized requesters", async () => {
    const dataDir = join(root, "restart");
    const pending = new Set<string>();
    const waiting = scriptedModel(async (request, options) => {
        const { text } = lastText(request);

        if (!text.endsWith("pending")) {
            return fauxAssistantMessage("noted");
        }

        // Keep the generation unfinished until the first app closes.
        const signal = options!.signal!;

        pending.add(text);
        signal.throwIfAborted();

        return new Promise<never>((_, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
        );
    });
    let app = await openApp(waiting, dataDir);

    try {
        const kept = app.config.addUser("Pat", "guest").user;
        const revoked = app.config.addUser("Lee", "guest").user;
        const cases = [
            { text: "guest pending", person: kept },
            { text: "owner pending", person: owner(app) },
            { text: "revoked pending", person: revoked },
            { text: "legacy pending", person: undefined },
        ];
        const runs = [];

        for (const { text, person } of cases) {
            const id = await newSession(app);
            let submissionId;

            if (person === undefined) {
                // An old input has no requester. A previous owner turn must not supply one.
                await say(app, id, "previous owner turn");
                const conversation = await app.conversation(id);

                submissionId = (
                    await conversation.submit({ type: "input", content: text }, context)
                ).id;
            } else {
                submissionId = (
                    await app.commands.submit(id, person, { text, requestId: "unfinished" })
                ).submissionId;
            }

            runs.push({ id, person, submissionId });
        }

        await until(() => pending.size === cases.length, "all four generations to be pending");
        // Persist the grant without live cancellation: startup must reconcile this state itself.
        app.config.updateUser(revoked.id, { role: "viewer" });
        await app.close();
        const resumed: string[] = [];

        app = await openApp(
            scriptedModel((request) => {
                resumed.push(lastText(request).text);

                return fauxAssistantMessage("finished");
            }),
            dataDir,
        );

        const deadline = withAbortSignal(AbortSignal.timeout(10_000), context);

        for (const { id, person, submissionId } of runs) {
            const submission = await app.harness.submission(submissionId, context);

            assert.ok(submission);
            const record = await submission.wait(deadline);

            assert.equal(app.attribution.requesterOf(id), person?.id);

            if (person === undefined || person === revoked) {
                assert.equal(record.status, "unanswered");
                assert.equal(record.reason, "aborted");
            } else {
                assert.equal(record.status, "done");
            }
        }

        assert.deepEqual(
            resumed.sort(),
            [
                app.commands.messageText(kept, "guest pending"),
                app.commands.messageText(owner(app), "owner pending"),
            ].sort(),
        );
    } finally {
        await app.close();
    }
});
