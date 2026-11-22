import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { createProvider, type ClassifierAnswer } from "@earendil-works/pi-ai";
import { createHandler } from "../src/server/http.ts";
import type { Client } from "../src/server/room.ts";
import {
    type App,
    cleanUp,
    fakeTab,
    newSession,
    openApp,
    owner,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";

const model = "faux-jev/jev-test";
const seen: Record<string, unknown>[] = [];
let verdict: ClassifierAnswer = choice("needs_input", 1);

function choice(value: string, confidence: number): ClassifierAnswer {
    return { type: "choice", choice: value, confidence, probabilities: { [value]: confidence } };
}

let fail = false;
let app: App;

before(async () => {
    app = await openApp(scriptedModel());
    app.models.registerNativeProvider(
        createProvider({
            id: "faux-jev",
            auth: { apiKey: { name: "Faux Jev", resolve: async () => ({ auth: {} }) } },
            models: [
                {
                    type: "classifier",
                    id: "jev-test",
                    name: "Faux Jev",
                    api: "typesafe-system-one",
                    provider: "faux-jev",
                    baseUrl: "https://faux.example/v1",
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 64_000,
                },
            ],
            classifiers: {
                "typesafe-system-one": {
                    async classify(_model, input) {
                        seen.push(input.state as Record<string, unknown>);

                        return {
                            api: "typesafe-system-one",
                            provider: "faux-jev",
                            model: "jev-test",
                            answers: { outcome: verdict },
                            stopReason: fail ? "error" : "stop",
                            timestamp: Date.now(),
                        };
                    },
                },
            },
        }),
    );
});

after(async () => {
    await app?.close();
    cleanUp();
});

test("opt-in labels done notifications, keeps the existing body and urgency, and falls back after failure", async () => {
    const id = await newSession(app);
    const tab = fakeTab(undefined, owner(app));
    const client: Client = { ...tab.client, embedder: "embedder-notify" };
    const sent = () =>
        tab.events.filter((event) => event.event === "embedder-notify").map((event) => event.data);

    await app.attach(client);

    try {
        await say(app, id, "first answer");
        await until(() => sent().length === 1, "plain completion notification");
        assert.match(String(sent()[0]?.title), /^Pi finished · /);
        assert.equal(seen.length, 0);

        await app.setExtensionEnabled(owner(app), "run-outcomes.ts", true);
        await app.setExtensionSettings(owner(app), "run-outcomes", { classifyModel: model });
        await say(app, id, "second answer");
        await until(() => sent().length === 2, "classified completion notification");
        assert.match(String(sent()[1]?.title), /^Needs input · /);
        assert.equal(sent()[1]?.body, "echo: second answer");
        assert.equal(sent()[1]?.urgency, "normal");
        assert.deepEqual(seen, [{ answer: "echo: second answer" }]);

        fail = true;
        await say(app, id, "third answer");
        await until(() => sent().length === 3, "completion notification after classifier failure");
        assert.match(String(sent()[2]?.title), /^Pi finished · /);
        assert.deepEqual(seen.at(-1), { answer: "echo: third answer" });
    } finally {
        fail = false;
        app.detach(client);
    }
});

test("a PiP follow report includes the label outside the original answer's fence", async () => {
    const id = await newSession(app);
    const pip = await app.pip.ensure(owner(app));

    await app.pip.read(pip, Number(id));
    const { requestId } = await app.pip.send(
        pip,
        Number(id),
        "Can you choose a target?",
        false,
        "send-outcome",
    );

    await app.pip.follow(pip, Number(id), requestId, "follow-outcome");
    await until(
        async () =>
            (await app.transcripts.allEntries(pip, true)).some(
                (entry) =>
                    entry.kind === "user" &&
                    entry.text.includes("</session-output>\nReported outcome: Needs input."),
            ),
        "labeled PiP report",
    );
    assert.match(String(seen.at(-1)?.answer), /Can you choose a target\?/);
});

test("a shared answer gets one verdict, hidden values are redacted, and uncertain labels are ignored", async () => {
    const id = await newSession(app);
    const before = seen.length;
    const unhide = app.hidden.add({
        value: "secret-ticket-123",
        label: "ticket",
        conversationId: Number(id),
    });
    const text = "This task is blocked by secret-ticket-123";

    verdict = choice("blocked", 0.8);

    try {
        assert.deepEqual(
            await Promise.all([
                app.classifyRunOutcome(id, 1, text),
                app.classifyRunOutcome(id, 1, text),
            ]),
            ["Blocked", "Blocked"],
        );
        assert.equal(seen.length, before + 1);
        assert.ok(!String(seen.at(-1)?.answer).includes("secret-ticket-123"));

        verdict = choice("completed", 0.5);
        assert.equal(await app.classifyRunOutcome(id, 2, "Done"), undefined);
        verdict = choice("verdict-with-private-text-456", 1);
        assert.equal(await app.classifyRunOutcome(id, 3, "Done"), undefined);
    } finally {
        unhide();
    }
});

test("the owner sees only sanitized verdicts and counts in Jev Hub, not guests or viewers", async () => {
    const server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const read = (token: string) =>
        fetch(`http://127.0.0.1:${port}/api/x/jev-hub/activity`, {
            headers: { "X-Pocket": "1", authorization: `Bearer ${token}` },
        });

    try {
        const response = await read(app.config.ownerToken);

        assert.equal(response.status, 200);
        const activity = await response.text();

        assert.match(activity, /"verdicts":\["needs_input"\]/);
        assert.match(activity, /"source":"run-outcomes","answered":\d+,"failed":1,"timedOut":0/);
        assert.doesNotMatch(
            activity,
            /Can you choose|second answer|secret-ticket-123|verdict-with-private-text-456/,
        );

        for (const role of ["guest", "viewer"] as const) {
            const added = app.config.addUser(role, role);

            assert.equal((await read(added.token)).status, 404);
            assert.ok(!app.webs.clients(added.user).some((client) => client.module === "jev-hub"));
        }
    } finally {
        server.closeAllConnections();
        server.close();
    }
});
