import {
    type App,
    cleanUp,
    fakeTab,
    lastText,
    modelTexts,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import { createProvider } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { ConfigStore } from "../src/server/config.ts";
import { createHandler } from "../src/server/http.ts";
import type { RelayContext, RelayService } from "../src/server/extensions/pocket-relay/types.ts";

const workflows = ["agent-teams.ts", "pocket-relay.ts", "relay-triage.ts", "run-outcomes.ts"];
const alreadyOn = ["background.ts", "subagents.ts", "schedules.ts", "triggers.ts", "pip.ts"];
const stillOff = ["guard.ts", "anthropic-subscription.ts", "session-tags.ts", "ask-someone.ts"];

after(cleanUp);

function messageTexts(serialized: string): string[] {
    const content = JSON.parse(serialized) as string | { type: string; text?: string }[];

    return typeof content === "string"
        ? [content]
        : content.filter((part) => part.type === "text").map((part) => part.text ?? "");
}

function checkModules(app: App, files: string[], enabled: boolean): void {
    for (const file of files) {
        const module = app.loader.list().find((each) => each.file === file)!;

        assert.equal(module.enabled, enabled, file);
        assert.equal(module.error, undefined, `${file} loaded without an error`);
    }
}

test("fresh profiles enable only the four workflows, and disabling them survives a restart", async () => {
    let requests = 0;
    const model = scriptedModel(() => {
        requests += 1;

        return fauxAssistantMessage([fauxText("Done.")]);
    });
    const data = join(root, "fresh");
    let app = await openApp(model, data);

    try {
        checkModules(app, workflows, true);
        checkModules(app, alreadyOn, true);
        checkModules(app, stillOff, false);
        assert.deepEqual(app.config.enabledExtensions, workflows);
        assert.deepEqual(app.config.disabledExtensions, []);
        assert.equal(app.config.classifierModel, undefined);
        assert.equal(app.config.defaultModel, undefined);
        assert.equal(app.config.lastModel, undefined);
        assert.deepEqual(app.config.subagentModels, []);
        assert.equal(app.sessions().length, 0, "installation starts no session");
        assert.equal(requests, 0, "installation makes no model request");

        await app.close();
        app = await openApp(model, data);
        checkModules(app, workflows, true);
        assert.equal(requests, 0);

        for (const file of workflows) {
            await app.setExtensionEnabled(owner(app), file, false);
        }

        await app.close();
        app = await openApp(model, data);
        checkModules(app, workflows, false);
        checkModules(app, alreadyOn, true);
        checkModules(app, stillOff, false);
        assert.deepEqual(app.config.enabledExtensions, []);
        assert.deepEqual(app.config.disabledExtensions, workflows);
        assert.equal(requests, 0);
    } finally {
        await app.close();
    }
});

test("upgrades keep legacy implicit off, explicit on, explicit off, and mixed choices", async () => {
    const choices = [
        {},
        { enabledExtensions: workflows },
        { disabledExtensions: workflows },
        { enabledExtensions: workflows.slice(0, 2), disabledExtensions: workflows.slice(2) },
    ];

    for (const [index, choice] of choices.entries()) {
        const data = join(root, `legacy-${index}`);
        const token = `isolated-legacy-token-${index}`;
        const saved = JSON.stringify({
            version: 1,
            ownerToken: token,
            users: [
                {
                    id: "legacy-owner",
                    name: "Owner",
                    role: "owner",
                    tokenHash: createHash("sha256").update(token).digest("hex"),
                    createdAt: 1,
                },
            ],
            ...choice,
        });

        mkdirSync(data);
        writeFileSync(join(data, "config.json"), saved);
        new ConfigStore(data);
        assert.equal(readFileSync(join(data, "config.json"), "utf8"), saved, "no migration write");

        for (let restart = 0; restart < 2; restart++) {
            const app = await openApp(scriptedModel(), data);

            try {
                for (const file of workflows) {
                    checkModules(app, [file], choice.enabledExtensions?.includes(file) ?? false);
                }

                checkModules(app, alreadyOn, true);
                checkModules(app, stillOff, false);
                assert.equal(app.sessions().length, 0);
                assert.deepEqual(app.config.enabledExtensions, choice.enabledExtensions ?? []);
                assert.deepEqual(app.config.disabledExtensions, choice.disabledExtensions ?? []);
            } finally {
                await app.close();
            }
        }
    }
});

test("enabled workflows with no chosen classifier leave non-owner relay traffic and outcomes unchanged, even with a signed-in provider", async () => {
    let classifierCalls = 0;
    let reference: string | undefined;
    const requests: string[] = [];
    const model = scriptedModel((request) => {
        requests.push(JSON.stringify(request));
        const { text, role } = lastText(request as never);

        if (role === "user" && text === "REPLY_TEST") {
            return fauxAssistantMessage(
                [
                    fauxToolCall("relay_reply", {
                        text: "Unchanged reply.",
                        reply_to: reference!,
                    }),
                ],
                { stopReason: "toolUse" },
            );
        }

        if (role === "user" && text === "START_TEAM_TEST") {
            return fauxAssistantMessage(
                [fauxToolCall("team", { action: "start", message: "Answer with Done." })],
                { stopReason: "toolUse" },
            );
        }

        return fauxAssistantMessage([fauxText("Done.")]);
    });
    const app = await openApp(model, join(root, "no-classifier"));
    const server = createServer(
        createHandler({
            app,
            listen: { host: "127.0.0.1", port: 0 },
            restart: () => {},
        }),
    );
    const tab = fakeTab(undefined, owner(app));

    await app.attach({ ...tab.client, embedder: "embedder-notify" });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    const call = async (path: string, body?: unknown) => {
        const response = await fetch(`${base}/api/${path}`, {
            method: body === undefined ? "GET" : "POST",
            headers: { authorization: `Bearer ${app.config.ownerToken}`, "x-pocket": "1" },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });

        assert.equal(response.status, 200, path);

        return response.json() as Promise<Record<string, unknown>>;
    };

    let remove = () => {};

    try {
        checkModules(app, workflows, true);
        const empty = await call("x/pocket-relay/connectors");

        assert.deepEqual(empty.connectors, [], "installation adds no connectors");
        assert.equal(requests.length, 0, "installation makes no model calls");
        app.models.registerNativeProvider(
            createProvider({
                id: "faux-unselected",
                auth: {
                    apiKey: { name: "Isolated classifier", resolve: async () => ({ auth: {} }) },
                },
                models: [
                    {
                        type: "classifier",
                        id: "classifier",
                        name: "Unselected classifier",
                        api: "typesafe-system-one",
                        provider: "faux-unselected",
                        baseUrl: "https://unused.invalid",
                        input: ["text"],
                        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                        contextWindow: 64_000,
                    },
                ],
                classifiers: {
                    "typesafe-system-one": {
                        classify: async () => {
                            classifierCalls += 1;

                            throw new Error("An unselected classifier must not run");
                        },
                    },
                },
            }),
        );
        await app.models.setRuntimeApiKey("faux-unselected", "isolated-fake-key");
        assert.ok(
            app.models.hasConfiguredAuth("faux-unselected"),
            "a signed-in provider is not consent",
        );
        assert.equal(app.config.classifierModel, undefined);

        for (const module of ["agent-teams", "relay-triage", "run-outcomes"]) {
            assert.equal(app.config.extensionSettings(module).classifyModel, undefined);
        }

        const id = await newSession(app);
        const service = app.webs.serviceOf("pocket-relay") as RelayService;
        const replies: { text: string; author?: string }[] = [];
        let relayContext: RelayContext | undefined;

        remove = service.register({
            kind: "isolated-test",
            label: "Isolated test",
            shape: "stream",
            fields: [],
            run: async (current) => {
                relayContext = current;
                await new Promise<void>((resolve) =>
                    current.signal.addEventListener("abort", () => resolve(), { once: true }),
                );
            },
            reply: async (_current, reply) => {
                replies.push({ text: reply.text, author: reply.to?.author.id });

                return { id: "isolated-reply" };
            },
        });
        await call("x/pocket-relay/connectors", {
            name: "Test only",
            kind: "isolated-test",
            target: Number(id),
            ownerIds: ["connector-owner"],
            values: {},
        });
        await until(() => relayContext !== undefined, "the local test connector");
        const noticesBefore = tab.events.filter((event) => event.event === "notice").length;

        await relayContext!.emit([
            {
                id: "non-owner-event",
                text: "Unchanged inbound.",
                author: { id: "not-the-owner", name: "Non-owner" },
                channel: "test-channel",
            },
        ]);
        await until(
            async () =>
                (await modelTexts(app, id)).some((text) => text.includes("Unchanged inbound.")),
            "the inbound message",
        );
        await until(() => !app.isBusy(id), "the inbound answer");
        const inbound = (await modelTexts(app, id)).join("\n");

        assert.match(inbound, /Unchanged inbound\./);
        assert.doesNotMatch(inbound, /Triage:/);
        const payloads = (await modelTexts(app, id)).flatMap(messageTexts).flatMap((text) => {
            const payload = /<relay-message[^>]*>\n([\s\S]*?)\n<\/relay-message>/.exec(text)?.[1];

            return payload === undefined ? [] : [payload];
        });

        reference = /^event: (e-[A-Za-z0-9_-]+)$/m.exec(payloads[0] ?? "")?.[1];
        assert.ok(reference);
        assert.deepEqual(
            payloads,
            [`event: ${reference}\nchannel: (test-channel)\n\nUnchanged inbound.`],
            "the actual non-owner payload arrives unchanged",
        );
        await say(app, id, "REPLY_TEST");
        assert.deepEqual(replies, [{ text: "Unchanged reply.", author: "not-the-owner" }]);
        await say(app, id, "START_TEAM_TEST");
        const child = app.sessions().find((session) => session.linkedFrom?.id === Number(id));

        assert.ok(child, "the default team tool works");
        await until(
            async () =>
                (await modelTexts(app, id)).some(
                    (text) => text.includes("<linked-session-message>") && text.includes("Done."),
                ),
            "the linked-session report",
        );
        const reports = (await modelTexts(app, id))
            .flatMap(messageTexts)
            .filter((text) => text.includes("<linked-session-message>"));

        assert.ok(
            reports.some((text) =>
                text.includes("<linked-session-message>\nDone.\n</linked-session-message>"),
            ),
            "the parent gets the original final text with no verdict",
        );
        assert.doesNotMatch(
            reports.join("\n"),
            /by run-outcomes|Outcome unclear|Needs input|Classifier verdict/,
        );
        await until(
            () => !app.isBusy(id) && app.busyConversations().length === 0,
            "all reports answered",
        );
        await until(
            () => tab.events.some((event) => event.event === "embedder-notify"),
            "ordinary completion notifications",
        );
        const notifications = tab.events.filter((event) => event.event === "embedder-notify");

        assert.ok(notifications.length > 0);

        for (const { data } of notifications) {
            assert.match(String(data.title), /^Pi finished · /);
            assert.equal(data.body, "Done.");
        }

        assert.equal(await app.classifyRunOutcome(id, 999, "Done."), undefined);
        assert.equal(classifierCalls, 0, "no provider call or charge without model selection");
        assert.equal(
            tab.events.filter((event) => event.event === "notice").length,
            noticesBefore,
            "no model prompts or per-message warnings",
        );
        assert.doesNotMatch(requests.join("\n"), /No classifier model is chosen/);
        const status = await call("x/relay-triage/status");

        assert.equal(status.asked, 0);
        assert.equal(status.failed, 0);
        assert.deepEqual(status.outbound, { asked: 0, held: 0, failed: 0 });
        checkModules(app, workflows, true);
        checkModules(app, alreadyOn, true);
        checkModules(app, stillOff, false);
        assert.equal(app.config.classifierModel, undefined);
        assert.deepEqual(app.config.subagentModels, []);
    } finally {
        remove();
        app.detach(tab.client);
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await app.close();
    }
});
