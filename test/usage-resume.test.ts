// Isolated, scripted models and a restart with an advanced clock: no subscription calls or live Pocket data.
import {
    type App,
    cleanUp,
    context,
    fakeTab,
    lastText,
    modelTexts,
    newSession,
    openApp,
    owner,
    recordCost,
    root,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, test } from "node:test";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import type { Context } from "@earendil-works/chord";
import type { ConversationId, Tx } from "@earendil-works/pi-durable";
import { AuthorsDoc, UsageResumeDoc } from "../src/server/docs.ts";
import { USAGE_RESUME_PREFIX } from "../src/server/usage-resume.ts";
import { runningNow } from "../src/server/running.ts";
import { createServer } from "node:http";
import { createHandler } from "../src/server/http.ts";

let serial = 0;

after(cleanUp);

async function scenario(
    run: (state: {
        app: () => App;
        id: ConversationId;
        waitForLimitRequest: () => Promise<void>;
        restart: () => Promise<void>;
        resumed: (target?: ConversationId) => Promise<number>;
    }) => Promise<void>,
    delayErrors = false,
) {
    const dataDir = join(root, `usage-resume-${++serial}`);
    let offset = 0;
    let limitStarted = false;
    let recoveringAttempts = 0;
    const model = scriptedModel(async (view) => {
        const { text } = lastText(view as never);

        if (text.endsWith("limit me")) {
            limitStarted = true;

            if (delayErrors) {
                await new Promise((resolve) => setTimeout(resolve, 100));
            }

            return fauxAssistantMessage([], {
                stopReason: "error",
                errorMessage: "You have hit your ChatGPT usage limit. Try again in ~5 min.",
            });
        }

        if (text.endsWith("retry then recover") && recoveringAttempts++ === 0) {
            return fauxAssistantMessage([], {
                stopReason: "error",
                errorMessage: "429 You have hit your ChatGPT usage limit. Try again in ~5 min.",
            });
        }

        if (text.endsWith("unknown reset")) {
            return fauxAssistantMessage([], {
                stopReason: "error",
                errorMessage: "You have hit your ChatGPT usage limit.",
            });
        }

        return fauxAssistantMessage([
            fauxText(text.startsWith(USAGE_RESUME_PREFIX) ? "continued" : `echo: ${text}`),
        ]);
    });
    let app = await openApp(model, dataDir, () => Date.now() + offset);
    const id = await newSession(app);

    const resumed = async (target = id) => {
        const entries = await (await app.harness.conversation(target, context))!.entries(
            {},
            100,
            undefined,
            context,
        );

        return entries.items.filter(
            (entry) =>
                entry.kind === "pi.user" &&
                JSON.stringify(entry.model).includes(USAGE_RESUME_PREFIX),
        ).length;
    };

    try {
        await run({
            app: () => app,
            id,
            resumed,
            waitForLimitRequest: () =>
                until(() => limitStarted, "the original model request to start"),
            restart: async () => {
                await app.close();
                offset += 7 * 60_000;
                app = await openApp(model, dataDir, () => Date.now() + offset);
            },
        });
    } finally {
        await app.close();
    }
}

test("auto-resume is opt-in, and an unknown reset remains manual even when enabled", async () => {
    await scenario(async ({ app, id, restart, resumed }) => {
        await say(app(), id, "limit me");
        assert.equal(
            (await app().harness.snapshot(UsageResumeDoc, id, context))?.pending,
            undefined,
        );
        await app().usageResumes.set(id, owner(app()), true);
        await say(app(), id, "unknown reset");
        assert.equal(
            (await app().harness.snapshot(UsageResumeDoc, id, context))?.pending,
            undefined,
        );
        await restart();
        assert.equal(await resumed(), 0);
    });
});

test("a limit schedules a visible, durable continuation, attributed to its requester, exactly once", async () => {
    await scenario(async ({ app, id, restart, resumed }) => {
        await app().usageResumes.set(id, owner(app()), true);
        await say(app(), id, "limit me");
        const pending = (await app().harness.snapshot(UsageResumeDoc, id, context))?.pending;

        assert.ok(pending);
        assert.ok(pending.at > app().now() + 5 * 60_000);
        const running = await runningNow(app(), owner(app()));

        assert.ok(
            running.some((session) =>
                session.tasks.some(
                    (task) =>
                        task.kind === "pocket.usage-resume" && task.label.includes("usage reset"),
                ),
            ),
        );
        await restart();
        await until(async () => (await resumed()) === 1, "the chat to resume after the reset");
        await until(
            async () => (await modelTexts(app(), id)).some((text) => text.includes("continued")),
            "the resumed answer",
        );
        await until(
            async () =>
                (await app().harness.snapshot(UsageResumeDoc, id, context))?.pending === undefined,
            "the wake-up to clear",
        );
        const entries = await (await app().harness.conversation(id, context))!.entries(
            {},
            100,
            undefined,
            context,
        );
        const continuation = entries.items.find(
            (entry) =>
                entry.kind === "pi.user" &&
                JSON.stringify(entry.model).includes(USAGE_RESUME_PREFIX),
        )!;

        await until(
            async () =>
                (await app().harness.snapshot(AuthorsDoc, id, context))?.requesters?.[
                    String(continuation.id)
                ] === owner(app()).id,
            "the original requester attribution",
        );
        await restart();
        assert.equal(await resumed(), 1);
    });
});

for (const change of [
    "off",
    "stop",
    "running-stop",
    "new-message",
    "new-context",
    "model",
    "archive",
    "budget",
    "driver",
] as const) {
    test(`${change} prevents an old usage-limit continuation`, async () => {
        await scenario(async ({ app, id, restart, resumed }) => {
            await app().usageResumes.set(id, owner(app()), true);
            await say(app(), id, "limit me");
            const pending = (await app().harness.snapshot(UsageResumeDoc, id, context))?.pending;

            assert.ok(pending);

            if (change === "off") {
                await app().usageResumes.set(id, owner(app()), false);
            } else if (change === "stop") {
                await app().commands.abort(id, owner(app()));
            } else if (change === "running-stop") {
                await app().usageResumes.cancel(id, owner(app()), Number(pending.taskId));
                assert.equal((await app().harness.snapshot(UsageResumeDoc, id, context))?.on, true);
            } else if (change === "new-message") {
                await say(app(), id, "new work");
            } else if (change === "new-context") {
                await app().commands.reset(id, owner(app()), "fresh start");
            } else if (change === "model") {
                await app().commands.configure(id, owner(app()), {
                    model: { provider: "faux", modelId: "faux-2" },
                });
            } else if (change === "archive") {
                await app().commands.updateSession(id, owner(app()), { archived: true });
            } else if (change === "driver") {
                const guest = app().config.addUser("New driver", "guest").user;

                await app().collab.turns(id, owner(app()), { action: "on" });
                await app().collab.turns(id, owner(app()), { action: "handover", to: guest.id });
            } else {
                await app().spend.setSessionBudget(owner(app()), id, 1);
                await recordCost(app(), id, 2);
                await until(() => app().spend.sessionSpent(id) === 2, "the spend to be recorded");
            }

            await restart();
            await until(
                async () =>
                    (await app().harness.snapshot(UsageResumeDoc, id, context))?.pending ===
                    undefined,
                "the obsolete wake-up to clear",
            );
            assert.equal(await resumed(), 0);
        });
    });
}

test("a model changed while the limited request is in flight is not auto-resumed on the new model", async () => {
    await scenario(async ({ app, id, waitForLimitRequest, restart, resumed }) => {
        await app().usageResumes.set(id, owner(app()), true);
        const submitted = await app().commands.submit(id, owner(app()), {
            text: "limit me",
            requestId: crypto.randomUUID(),
        });

        await waitForLimitRequest();
        await app().commands.configure(id, owner(app()), {
            model: { provider: "faux", modelId: "faux-2" },
        });
        await (await app().harness.submission(submitted.submissionId, context))!.wait(context);
        assert.equal(
            (await app().harness.snapshot(UsageResumeDoc, id, context))?.pending,
            undefined,
        );
        await restart();
        assert.equal(await resumed(), 0);
    }, true);
});

test("a generation that recovers through its built-in retry gets no extra reset continuation", async () => {
    await scenario(async ({ app, id, restart, resumed }) => {
        await app().usageResumes.set(id, owner(app()), true);
        await say(app(), id, "retry then recover");
        assert.ok((await app().harness.snapshot(UsageResumeDoc, id, context))?.pending);
        assert.ok((await modelTexts(app(), id)).some((text) => text.includes("echo:")));
        await restart();
        await until(
            async () =>
                (await app().harness.snapshot(UsageResumeDoc, id, context))?.pending === undefined,
            "the recovered generation's wake-up to clear",
        );
        assert.equal(await resumed(), 0);
    });
});

test("new work queued before the failed response prevents an old continuation", async () => {
    await scenario(async ({ app, id, restart, resumed }) => {
        await app().usageResumes.set(id, owner(app()), true);
        const first = await app().commands.submit(id, owner(app()), {
            text: "limit me",
            requestId: crypto.randomUUID(),
        });

        assert.equal(app().isBusy(id), true);
        await app().commands.submit(id, owner(app()), {
            text: "queued new work",
            mode: "followUp",
            requestId: crypto.randomUUID(),
        });
        await (await app().harness.submission(first.submissionId, context))!.wait(context);
        assert.ok((await app().harness.snapshot(UsageResumeDoc, id, context))?.pending);
        await restart();
        await until(
            async () =>
                (await app().harness.snapshot(UsageResumeDoc, id, context))?.pending === undefined,
            "the queued work to invalidate the wake-up",
        );
        assert.equal(await resumed(), 0);
    }, true);
});

for (const change of ["viewer", "removed"] as const) {
    test(`a requester who is ${change} cannot be resumed`, async () => {
        await scenario(async ({ app, id, restart, resumed }) => {
            const guest = app().config.addUser("Requester", "guest").user;

            await app().usageResumes.set(id, owner(app()), true);
            const submitted = await app().commands.submit(id, guest, {
                text: "limit me",
                requestId: crypto.randomUUID(),
            });

            await (await app().harness.submission(submitted.submissionId, context))!.wait(context);
            assert.ok((await app().harness.snapshot(UsageResumeDoc, id, context))?.pending);

            if (change === "viewer") {
                app().config.updateUser(guest.id, { role: "viewer" });
            } else {
                app().config.removeUser(guest.id);
            }

            await restart();
            await until(
                async () =>
                    (await app().harness.snapshot(UsageResumeDoc, id, context))?.pending ===
                    undefined,
                "the inaccessible requester's wake-up to clear",
            );
            assert.equal(await resumed(), 0);
        });
    });
}

for (const policy of ["requester permission", "global default"] as const) {
    test(`${policy} revoked during admission rolls back the user entry, submission, and new generation`, async () => {
        await scenario(async ({ app, id, resumed }) => {
            const guest = app().config.addUser("Requester", "guest").user;

            if (policy === "global default") {
                await app().setUsageResumeDefault(owner(app()), true);
            } else {
                await app().usageResumes.set(id, owner(app()), true);
            }

            const submitted = await app().commands.submit(id, guest, {
                text: "limit me",
                requestId: crypto.randomUUID(),
            });

            await (await app().harness.submission(submitted.submissionId, context))!.wait(context);
            const pending = (await app().harness.snapshot(UsageResumeDoc, id, context))!.pending!;
            const record = await app().harness.getTask(pending.taskId, context);
            const send = app().usageResumes.task.definition.phases.send;
            const task = record as unknown as Parameters<typeof send>[0];

            type Runtime = Parameters<typeof send>[1];
            let revoked = false;
            const runtime = {
                taskId: pending.taskId,
                conversationId: id,
                now: () => app().now(),
                conversation: (id: ConversationId, context: Context) =>
                    app().harness.conversation(id, context),
                commit: async (
                    change: Parameters<Runtime["commit"]>[0],
                    commitContext: Context,
                ) => {
                    await app().harness.commit(async (tx) => {
                        const intercepted = new Proxy(tx, {
                            get(target, key) {
                                if (key === "appendEntry") {
                                    return async (...args: unknown[]) => {
                                        if (!revoked) {
                                            revoked = true;

                                            if (policy === "global default") {
                                                app().config.usageResumeDefault = false;
                                            } else {
                                                app().config.updateUser(guest.id, {
                                                    role: "viewer",
                                                });
                                            }
                                        }

                                        return Reflect.apply(target.appendEntry, target, args);
                                    };
                                }

                                const value = Reflect.get(target, key);

                                return typeof value === "function" ? value.bind(target) : value;
                            },
                        }) as Tx;

                        return change(intercepted, task);
                    }, commitContext);
                },
            } as unknown as Runtime;

            await send(task, runtime, context);
            assert.equal(revoked, true);
            assert.equal(await resumed(), 0);
            assert.equal(app().isBusy(id), false);
            assert.equal(
                (await app().harness.snapshot(UsageResumeDoc, id, context))?.pending,
                undefined,
            );
        });
    });
}

test("forks inherit neither auto-resume nor the parent's pending task", async () => {
    await scenario(async ({ app, id }) => {
        await app().usageResumes.set(id, owner(app()), true);
        await say(app(), id, "limit me");
        const parent = await app().harness.snapshot(UsageResumeDoc, id, context);
        const entries = await (await app().harness.conversation(id, context))!.entries(
            {},
            100,
            undefined,
            context,
        );
        const error = entries.items.find((entry) => entry.kind === "pi.assistant")!;
        const fork = await app().commands.fork(id, owner(app()), { entryId: Number(error.id) });
        const child = await app().harness.snapshot(UsageResumeDoc, fork.id, context);

        assert.ok(parent?.pending);
        assert.equal(child?.on ?? false, false);
        assert.equal(child?.pending, undefined);
    });
});

test("auto-resume settings validate booleans and require steering and the current driver", async () => {
    await scenario(async ({ app, id }) => {
        const guest = app().config.addUser("Guest", "guest").user;
        const viewer = app().config.addUser("Viewer", "viewer").user;

        await assert.rejects(app().usageResumes.set(id, owner(app()), "yes"), { status: 400 });
        await assert.rejects(app().usageResumes.set(id, viewer, true), { status: 403 });
        await assert.rejects(app().usageResumes.cancel(id, viewer, 1), { status: 403 });
        await assert.rejects(app().usageResumes.cancel(id, owner(app()), "1"), { status: 400 });
        await app().collab.turns(id, owner(app()), { action: "on" });
        await assert.rejects(app().usageResumes.set(id, guest, true), { status: 409 });
        assert.equal(
            (await app().harness.snapshot(UsageResumeDoc, id, context))?.on ?? false,
            false,
        );
    });
});

test("global default resumes existing and new chats after restart without per-chat activation", async () => {
    await scenario(async ({ app, id, restart, resumed }) => {
        const tab = fakeTab(id, owner(app()));

        await app().attach(tab.client);
        await app().setUsageResumeDefault(owner(app()), true);
        assert.equal((await app().hello(owner(app()))).server.usageResumeDefault, true);
        await until(
            () => (tab.field("usageResume") as { on?: boolean })?.on === true,
            "the open chat to inherit the default",
        );
        const second = await newSession(app());

        await say(app(), id, "limit me");
        await say(app(), second, "limit me");
        assert.ok((await app().harness.snapshot(UsageResumeDoc, id, context))?.pending);
        assert.ok((await app().harness.snapshot(UsageResumeDoc, second, context))?.pending);
        assert.equal(
            (await app().harness.snapshot(UsageResumeDoc, id, context))?.override,
            undefined,
        );
        await restart();
        assert.equal(app().config.usageResumeDefault, true);
        await until(
            async () => (await resumed()) === 1 && (await resumed(second)) === 1,
            "both chats to resume",
        );
        await until(
            async () =>
                (await modelTexts(app(), second)).some((text) => text.includes("continued")),
            "the second resumed answer",
        );
        await restart();
        assert.equal(await resumed(), 1);
        assert.equal(await resumed(second), 1);
    });
});

test("turning off the default cancels inherited wake-ups while explicit chat opt-ins remain active", async () => {
    await scenario(async ({ app, id, restart, resumed }) => {
        await app().setUsageResumeDefault(owner(app()), true);
        const optedIn = await newSession(app());

        await app().usageResumes.set(optedIn, owner(app()), true);
        await say(app(), id, "limit me");
        await say(app(), optedIn, "limit me");
        assert.ok((await app().harness.snapshot(UsageResumeDoc, id, context))?.pending);
        await app().setUsageResumeDefault(owner(app()), false);
        assert.equal(
            (await app().harness.snapshot(UsageResumeDoc, id, context))?.pending,
            undefined,
        );
        assert.ok((await app().harness.snapshot(UsageResumeDoc, optedIn, context))?.pending);
        await restart();
        await until(async () => (await resumed(optedIn)) === 1, "the explicit opt-in to resume");
        assert.equal(await resumed(), 0);
        assert.equal(app().config.usageResumeDefault, false);
    });
});

test("per-chat opt-out survives global changes and can return to the app default", async () => {
    await scenario(async ({ app, id, restart, resumed }) => {
        await app().setUsageResumeDefault(owner(app()), true);
        await app().usageResumes.set(id, owner(app()), false);
        await app().setUsageResumeDefault(owner(app()), false);
        await app().setUsageResumeDefault(owner(app()), true);
        await say(app(), id, "limit me");
        assert.equal(
            (await app().harness.snapshot(UsageResumeDoc, id, context))?.pending,
            undefined,
        );
        await restart();
        assert.equal(await resumed(), 0);
        await app().usageResumes.set(id, owner(app()), null);
        await say(app(), id, "limit me");
        assert.ok((await app().harness.snapshot(UsageResumeDoc, id, context))?.pending);
        await restart();
        await until(
            async () => (await resumed()) === 1,
            "the chat to resume after returning to the default",
        );
    });
});

test("global default remains owner-only, boolean, and does not retroactively resume old errors", async () => {
    await scenario(async ({ app, id, restart, resumed }) => {
        const guest = app().config.addUser("Guest", "guest").user;
        const viewer = app().config.addUser("Viewer", "viewer").user;

        await assert.rejects(app().setUsageResumeDefault(guest, true), { status: 403 });
        await assert.rejects(app().setUsageResumeDefault(viewer, true), { status: 403 });
        await assert.rejects(app().setUsageResumeDefault(owner(app()), "yes"), { status: 400 });
        await say(app(), id, "limit me");
        await app().setUsageResumeDefault(owner(app()), true);
        assert.equal(
            (await app().harness.snapshot(UsageResumeDoc, id, context))?.pending,
            undefined,
        );
        await restart();
        assert.equal(await resumed(), 0);
    });
});

test("global auto-resume settings HTTP route validates input and rejects non-owners", async () => {
    await scenario(async ({ app }) => {
        const server = createServer(
            createHandler({
                app: app(),
                listen: { host: "127.0.0.1", port: 0 },
                restart: () => {},
            }),
        );

        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/settings`;
        const call = (token: string, body: unknown) =>
            fetch(url, {
                method: "POST",
                headers: {
                    authorization: `Bearer ${token}`,
                    "x-pocket": "1",
                    "content-type": "application/json",
                },
                body: JSON.stringify(body),
            });

        try {
            const guest = app().config.addUser("Guest", "guest");

            assert.equal((await call(guest.token, { usageResumeDefault: true })).status, 403);
            assert.equal(
                (await call(app().config.ownerToken, { usageResumeDefault: "yes" })).status,
                400,
            );
            assert.equal(
                (
                    await call(app().config.ownerToken, {
                        usageResumeDefault: true,
                        approvalRule: "others",
                    })
                ).status,
                400,
            );
            assert.equal(app().config.usageResumeDefault, false);
            assert.equal(
                (await call(app().config.ownerToken, { usageResumeDefault: true })).status,
                200,
            );
            assert.equal(app().config.usageResumeDefault, true);
            assert.equal(
                (await call(app().config.ownerToken, { usageResumeDefault: false })).status,
                200,
            );
            assert.equal(app().config.usageResumeDefault, false);
        } finally {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });
});
