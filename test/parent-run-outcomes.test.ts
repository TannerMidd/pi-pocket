import {
    cleanUp,
    fakeTab,
    lastText,
    loadTools,
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
import { createProvider } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { defang } from "../src/server/fence.ts";

const answer = "Choose the required branch: release or main?\nOriginal answer stays intact.";
const label = "Reported outcome (Run outcomes classifier; not proof of success): Needs input.";
const model = "parent-jev/classifier";

after(cleanUp);

for (const path of ["linked", "subagent"] as const) {
    for (const mode of [
        "enabled",
        "disabled",
        "unavailable",
        "failure",
        "timeout",
        "empty",
        "model-error",
        "low-confidence",
        "subscribed",
        "watched",
        "stopped",
    ] as const) {
        test(`${path} parent report: ${mode}, original answer and one delivery`, async () => {
            const app = await openApp(
                scriptedModel((request) => {
                    const { text } = lastText(request as never);

                    if (text.includes("SPAWN_WORKER") && !text.includes("[subagent")) {
                        return fauxAssistantMessage(
                            [
                                fauxToolCall("subagent", {
                                    action: "spawn",
                                    name: "worker",
                                    message: "CHILD_TASK",
                                }),
                            ],
                            { stopReason: "toolUse" },
                        );
                    }

                    if (text.includes("CHILD_TASK") && mode === "model-error") {
                        return fauxAssistantMessage([], {
                            stopReason: "error",
                            errorMessage: "Bad request",
                        });
                    }

                    return fauxAssistantMessage([
                        fauxText(
                            text.includes("CHILD_TASK")
                                ? mode === "empty"
                                    ? ""
                                    : mode === "stopped"
                                      ? "word ".repeat(80_000)
                                      : answer
                                : "Parent ready.",
                        ),
                    ]);
                }),
                join(root, `${path}-${mode}`),
            );
            const seen: string[] = [];

            let release = () => {};

            const held = new Promise<void>((resolve) => {
                release = resolve;
            });

            app.models.registerNativeProvider(
                createProvider({
                    id: "parent-jev",
                    auth: { apiKey: { name: "Scripted", resolve: async () => ({ auth: {} }) } },
                    models: [
                        {
                            type: "classifier",
                            id: "classifier",
                            name: "Scripted",
                            api: "typesafe-system-one",
                            provider: "parent-jev",
                            baseUrl: "https://faux.example",
                            input: ["text"],
                            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                            contextWindow: 64000,
                        },
                    ],
                    classifiers: {
                        "typesafe-system-one": {
                            async classify(_model, input) {
                                seen.push(String((input.state as { answer: string }).answer));

                                if (mode === "timeout") {
                                    await held;
                                }

                                if (mode === "failure") {
                                    throw new Error("scripted classifier failure");
                                }

                                return {
                                    api: "typesafe-system-one",
                                    provider: "parent-jev",
                                    model: "classifier",
                                    answers: {
                                        outcome: {
                                            type: "choice",
                                            choice: "needs_input",
                                            confidence: mode === "low-confidence" ? 0.5 : 1,
                                            probabilities: { needs_input: 1 },
                                        },
                                    },
                                    stopReason: "stop",
                                    timestamp: Date.now(),
                                };
                            },
                        },
                    },
                }),
            );

            const tab = fakeTab(undefined, owner(app));
            const client = { ...tab.client, embedder: "embedder-notify" as const };

            try {
                if (mode === "subscribed") {
                    await app.attach(client);
                }

                if (mode !== "disabled") {
                    await app.setExtensionEnabled(owner(app), "run-outcomes.ts", true);

                    if (mode !== "unavailable") {
                        await app.setExtensionSettings(owner(app), "run-outcomes", {
                            classifyModel: model,
                        });
                    }
                }

                const parent = await newSession(app);

                await say(app, parent, "Ready");
                let child;

                if (path === "linked") {
                    child = (
                        await app.linkedSessions.start(parent, { message: "CHILD_TASK" }, "worker")
                    ).session;
                } else {
                    await loadTools(app, parent, "subagent");
                    await say(app, parent, "SPAWN_WORKER");
                    await until(
                        () => app.subagents().some((agent) => agent.name === "worker"),
                        "child created",
                    );
                    child = app
                        .subagents()
                        .find((agent) => agent.name === "worker")!.conversationId;
                }

                if (mode === "stopped") {
                    await until(() => app.isBusy(child), "child running");
                    await app.commands.abort(child, owner(app));
                }

                if (mode === "watched") {
                    client.conversationId = child;
                    await app.attach(client);
                }

                const reports = async () =>
                    (await app.transcripts.allEntries(parent, true)).filter(
                        (entry) =>
                            entry.kind === "user" &&
                            (path === "linked"
                                ? /Linked session \S+ (finished its run|failed|was stopped)/.test(
                                      entry.text,
                                  )
                                : /\[subagent worker (answered, no reply needed|failed:|stopped:)/.test(
                                      entry.text,
                                  )),
                    );

                await until(async () => (await reports()).length === 1, "parent report", 15000);
                await until(() => !app.isBusy(parent), "parent finished");
                const report = (await reports())[0]!;

                assert.equal(report.kind, "user");
                const text = report.text;

                if (mode === "model-error" || mode === "empty" || mode === "stopped") {
                    assert.doesNotMatch(text, /Reported outcome/);
                    assert.equal(seen.length, 0, "no classifier call for failure or empty answer");
                    assert.match(
                        text,
                        mode === "model-error"
                            ? /Bad request/
                            : mode === "stopped"
                              ? /stopped/
                              : /no final answer|no reply needed/,
                    );
                    assert.equal((await reports()).length, 1);

                    return;
                }

                assert.ok(
                    text.includes(path === "linked" ? defang(answer) : answer),
                    "full original answer",
                );

                if (mode === "enabled" || mode === "subscribed" || mode === "watched") {
                    assert.ok(
                        text.endsWith(label),
                        "attributed classifier verdict reaches the parent",
                    );
                    const childAnswer = (await app.transcripts.allEntries(child, true)).findLast(
                        (entry) => entry.kind === "assistant",
                    );

                    assert.ok(childAnswer);
                    assert.equal(
                        await app.classifyRunOutcome(child, childAnswer.id, answer),
                        "Needs input",
                    );

                    if (mode === "subscribed" && path === "linked") {
                        await until(
                            () =>
                                tab.events.some(
                                    (event) =>
                                        event.event === "embedder-notify" &&
                                        (event.data as { url?: string; title?: string }).url ===
                                            `/s/${String(child)}` &&
                                        (event.data as { title: string }).title.startsWith(
                                            "Needs input",
                                        ),
                                ),
                            "child completion notification",
                        );
                    }

                    assert.equal(
                        seen.filter((text) => text === answer).length,
                        1,
                        "same child answer shares its verdict across surfaces",
                    );
                } else {
                    assert.ok(!text.includes("Reported outcome"));
                    assert.ok(
                        text.endsWith(
                            path === "linked"
                                ? `${defang(answer)}\n</linked-session-message>`
                                : answer,
                        ),
                        "fallback preserves exact report suffix",
                    );
                    assert.equal(
                        seen.filter((text) => text === answer).length,
                        mode === "failure" || mode === "timeout" || mode === "low-confidence"
                            ? 1
                            : 0,
                    );
                }

                assert.equal((await reports()).length, 1);
            } finally {
                release();
                app.detach(client);
                await app.close();
            }
        });
    }
}
