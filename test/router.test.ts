import assert from "node:assert/strict";
import test from "node:test";
import { isExplicitQuotaExhaustion, RouterDoc } from "../src/server/router.ts";
import { context, newSession, openApp, owner, scriptedModel, say, cleanUp } from "./helpers.ts";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { after } from "node:test";

test("only explicit subscription quota exhaustion activates router fallback", () => {
    assert.equal(
        isExplicitQuotaExhaustion(
            "You have hit your ChatGPT usage limit (team plan). Try again in ~144 min.",
        ),
        true,
    );
    assert.equal(isExplicitQuotaExhaustion('{"type":"usage_limit_reached"}'), true);
    assert.equal(
        isExplicitQuotaExhaustion("HTTP 429: rate limit exceeded, retry after 30s"),
        false,
    );
    assert.equal(isExplicitQuotaExhaustion("503 upstream unavailable"), false);
});

test("a repeated identical prompt in a new turn is classified again", async () => {
    const app = await openApp(scriptedModel());
    const openai = fauxProvider({
        api: "openai-responses",
        provider: "openai",
        models: [{ id: "gpt-6-luna" }, { id: "gpt-6.1-sol" }, { id: "gpt-6-astra" }],
    });

    const modelIds: string[] = [];

    app.models.registerNativeProvider(openai.provider);
    await app.models.refresh({ providers: ["openai"], allowNetwork: false });
    openai.setResponses([
        (_context, _options, _state, model) => {
            modelIds.push(model.id);

            return fauxAssistantMessage([fauxText("ROUTINE")]);
        },
        (_context, _options, _state, model) => {
            modelIds.push(model.id);

            return fauxAssistantMessage([fauxText("first answer")]);
        },
        (_context, _options, _state, model) => {
            modelIds.push(model.id);

            return fauxAssistantMessage([fauxText("COMPLEX")]);
        },
        (_context, _options, _state, model) => {
            modelIds.push(model.id);

            return fauxAssistantMessage([fauxText("second answer")]);
        },
    ]);
    const id = await newSession(app);

    try {
        await app.commands.configure(id, owner(app), {
            model: { provider: "router", modelId: "auto" },
            thinkingLevel: "off",
        });
        await say(app, id, "same prompt");
        await say(app, id, "same prompt");

        assert.deepEqual(modelIds, ["gpt-6-luna", "gpt-6-luna", "gpt-6-luna", "gpt-6.1-sol"]);
        assert.equal(openai.state.callCount, 4);
        assert.equal(
            (await app.harness.snapshot(RouterDoc, id, context))?.state?.complexity,
            "complex",
        );
    } finally {
        await app.close();
    }
});

test("router does not fall back for a generic 429 response", async () => {
    const app = await openApp(scriptedModel());
    const openai = fauxProvider({
        api: "openai-responses",
        provider: "openai",
        models: [{ id: "gpt-6-luna" }, { id: "gpt-6.1-sol" }, { id: "gpt-6-astra" }],
    });
    const hww = fauxProvider({
        api: "openai-responses",
        provider: "hww",
        models: [{ id: "gpt-6-luna" }, { id: "gpt-6.1-sol" }, { id: "gpt-6-astra" }],
    });

    app.models.registerNativeProvider(openai.provider);
    app.models.registerNativeProvider(hww.provider);
    await app.models.refresh({ providers: ["openai", "hww"], allowNetwork: false });
    openai.setResponses([
        fauxAssistantMessage([fauxText("ROUTINE")]),
        fauxAssistantMessage([], {
            stopReason: "error",
            errorMessage: "HTTP 429: rate limit exceeded, retry after 30s",
        }),
    ]);
    hww.setResponses([fauxAssistantMessage([fauxText("must not be used")])]);
    const id = await newSession(app);

    try {
        await app.commands.configure(id, owner(app), {
            model: { provider: "router", modelId: "auto" },
            thinkingLevel: "off",
        });
        await say(app, id, "Ordinary rate limit");

        assert.equal(hww.state.callCount, 0);
        assert.equal(
            (await app.harness.snapshot(RouterDoc, id, context))?.state?.provider,
            "openai",
        );
    } finally {
        await app.close();
    }
});

test("router does not start a fallback request when HWW auth is missing", async () => {
    const app = await openApp(scriptedModel());
    const openai = fauxProvider({
        api: "openai-responses",
        provider: "openai",
        models: [{ id: "gpt-6-luna" }, { id: "gpt-6.1-sol" }, { id: "gpt-6-astra" }],
    });
    const hww = fauxProvider({
        api: "openai-responses",
        provider: "hww",
        models: [{ id: "gpt-6-luna" }, { id: "gpt-6.1-sol" }, { id: "gpt-6-astra" }],
    });

    app.models.registerNativeProvider(openai.provider);
    app.models.registerNativeProvider(hww.provider);
    await app.models.refresh({ providers: ["openai", "hww"], allowNetwork: false });
    const hasConfiguredAuth = app.models.hasConfiguredAuth.bind(app.models);

    app.models.hasConfiguredAuth = (provider) =>
        provider === "hww" ? false : hasConfiguredAuth(provider);
    openai.setResponses([
        fauxAssistantMessage([fauxText("ROUTINE")]),
        fauxAssistantMessage([], {
            stopReason: "error",
            errorMessage: "You have hit your ChatGPT usage limit.",
        }),
    ]);
    const id = await newSession(app);

    try {
        await app.commands.configure(id, owner(app), {
            model: { provider: "router", modelId: "auto" },
            thinkingLevel: "off",
        });
        await say(app, id, "Hello");

        const conversation = await app.harness.conversation(id, context);
        const entries = await conversation!.entries({}, 100, undefined, context);

        assert.ok(entries.items.some((entry) => entry.kind === "pi.assistant"));
        assert.equal(hww.state.callCount, 0);
    } finally {
        await app.close();
    }
});

test("reset clears router fallback affinity before the next request", async () => {
    let app = await openApp(scriptedModel());
    const openai = fauxProvider({
        api: "openai-responses",
        provider: "openai",
        models: [{ id: "gpt-6-luna" }, { id: "gpt-6.1-sol" }, { id: "gpt-6-astra" }],
    });
    const hww = fauxProvider({
        api: "openai-responses",
        provider: "hww",
        models: [{ id: "gpt-6-luna" }, { id: "gpt-6.1-sol" }, { id: "gpt-6-astra" }],
    });

    app.models.registerNativeProvider(openai.provider);
    app.models.registerNativeProvider(hww.provider);
    await app.models.refresh({ providers: ["openai", "hww"], allowNetwork: false });
    openai.setResponses([
        fauxAssistantMessage([fauxText("ROUTINE")]),
        fauxAssistantMessage([], {
            stopReason: "error",
            errorMessage: "You have hit your ChatGPT usage limit.",
        }),
        fauxAssistantMessage([fauxText("ROUTINE")]),
        fauxAssistantMessage([fauxText("Primary recovered answer")]),
    ]);
    hww.setResponses([fauxAssistantMessage([fauxText("HWW before reset")])]);
    const id = await newSession(app);

    try {
        await app.commands.configure(id, owner(app), {
            model: { provider: "router", modelId: "auto" },
            thinkingLevel: "off",
        });
        await say(app, id, "first task");
        assert.equal((await app.harness.snapshot(RouterDoc, id, context))?.state?.provider, "hww");
        await app.commands.reset(id, owner(app), undefined);
        assert.equal((await app.harness.snapshot(RouterDoc, id, context))?.state, undefined);
        await say(app, id, "after reset");
        assert.equal(
            (await app.harness.snapshot(RouterDoc, id, context))?.state?.provider,
            "openai",
        );
        assert.equal(hww.state.callCount, 1);
    } finally {
        await app.close();
    }
});

test("a router request started before reset cannot restore stale routing state", async () => {
    const app = await openApp(scriptedModel());
    const openai = fauxProvider({
        api: "openai-responses",
        provider: "openai",
        models: [{ id: "gpt-6-luna" }, { id: "gpt-6.1-sol" }, { id: "gpt-6-astra" }],
    });
    let started!: () => void;
    let release!: () => void;
    const requestStarted = new Promise<void>((resolve) => {
        started = resolve;
    });
    const pendingRequest = new Promise<void>((resolve) => {
        release = resolve;
    });

    app.models.registerNativeProvider(openai.provider);
    await app.models.refresh({ providers: ["openai"], allowNetwork: false });
    openai.setResponses([
        fauxAssistantMessage([fauxText("ROUTINE")]),
        async () => {
            started();
            await pendingRequest;

            return fauxAssistantMessage([fauxText("old response")]);
        },
    ]);
    const id = await newSession(app);

    try {
        await app.commands.configure(id, owner(app), {
            model: { provider: "router", modelId: "auto" },
            thinkingLevel: "off",
        });
        const oldRequest = say(app, id, "slow old request");

        await requestStarted;
        await app.commands.reset(id, owner(app), undefined);
        release();
        await oldRequest;
        const conversation = (await app.harness.conversation(id, context))!;

        await conversation.waitForIdle(context);
        assert.equal((await app.harness.snapshot(RouterDoc, id, context))?.state, undefined);
    } finally {
        release();
        await app.close();
    }
});

test("HWW quota exhaustion stops without retrying on OpenAI", async () => {
    const app = await openApp(scriptedModel());
    const openai = fauxProvider({
        api: "openai-responses",
        provider: "openai",
        models: [{ id: "gpt-6-luna" }, { id: "gpt-6.1-sol" }, { id: "gpt-6-astra" }],
    });
    const hww = fauxProvider({
        api: "openai-responses",
        provider: "hww",
        models: [{ id: "gpt-6-luna" }, { id: "gpt-6.1-sol" }, { id: "gpt-6-astra" }],
    });

    app.models.registerNativeProvider(openai.provider);
    app.models.registerNativeProvider(hww.provider);
    await app.models.refresh({ providers: ["openai", "hww"], allowNetwork: false });
    openai.setResponses([
        fauxAssistantMessage([fauxText("ROUTINE")]),
        fauxAssistantMessage([], {
            stopReason: "error",
            errorMessage: "You have hit your ChatGPT usage limit.",
        }),
    ]);
    hww.setResponses([
        fauxAssistantMessage([], {
            stopReason: "error",
            errorMessage: "You have hit your HWW usage limit.",
        }),
    ]);
    const id = await newSession(app);

    try {
        await app.commands.configure(id, owner(app), {
            model: { provider: "router", modelId: "auto" },
            thinkingLevel: "off",
        });
        await say(app, id, "Hello");

        assert.equal(openai.state.callCount, 2);
        assert.equal(hww.state.callCount, 1);
        assert.equal((await app.harness.snapshot(RouterDoc, id, context))?.state?.provider, "hww");
    } finally {
        await app.close();
    }
});

test("router buffers quota failure, falls back to HWW, and persists per-conversation state", async () => {
    let app = await openApp(scriptedModel());
    const openai = fauxProvider({
        api: "openai-responses",
        provider: "openai",
        models: [{ id: "gpt-6-luna" }, { id: "gpt-6.1-sol" }, { id: "gpt-6-astra" }],
    });
    const hww = fauxProvider({
        api: "openai-responses",
        provider: "hww",
        models: [{ id: "gpt-6-luna" }, { id: "gpt-6.1-sol" }, { id: "gpt-6-astra" }],
    });

    app.models.registerNativeProvider(openai.provider);
    app.models.registerNativeProvider(hww.provider);
    await app.models.refresh({ providers: ["openai", "hww"], allowNetwork: false });
    openai.setResponses([
        fauxAssistantMessage([fauxText("ROUTINE")]),
        fauxAssistantMessage([], {
            stopReason: "error",
            errorMessage: "You have hit your ChatGPT usage limit (team plan).",
        }),
        fauxAssistantMessage([fauxText("ROUTINE")]),
        fauxAssistantMessage([fauxText("Primary recovered answer")]),
    ]);
    hww.setResponses([fauxAssistantMessage([fauxText("HWW fallback answer")])]);

    try {
        const id = await newSession(app);

        await app.commands.configure(id, owner(app), {
            model: { provider: "router", modelId: "auto" },
            thinkingLevel: "off",
        });
        await say(app, id, "Hello");

        const transcript = await (await app.harness.conversation(id, context))!.entries(
            {},
            100,
            undefined,
            context,
        );
        const assistant = transcript.items.findLast((entry) => entry.kind === "pi.assistant");

        assert.ok(assistant);
        assert.equal(JSON.stringify(assistant).includes("HWW fallback answer"), true);
        const state = await app.harness.snapshot(RouterDoc, id, context);

        assert.equal(state?.state?.provider, "hww");
        await app.close();
        app = await openApp(scriptedModel());
        assert.equal((await app.harness.snapshot(RouterDoc, id, context))?.state?.provider, "hww");

        const other = await newSession(app);

        assert.equal((await app.harness.snapshot(RouterDoc, other, context))?.state, undefined);
    } finally {
        await app.close();
    }
});

after(() => cleanUp());
