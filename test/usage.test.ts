// Provider usage: what a response's limit headers say, kept in memory for each provider, and who may see it.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
    type Api,
    createAssistantMessageEventStream,
    type Model,
    type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { LimitGate, noWait } from "../src/server/limit-gate.ts";
import { responseFacts } from "../src/server/limits.ts";
import { parseUsage, UsageStore, windowName } from "../src/server/usage.ts";
import {
    type App,
    cleanUp,
    fakeTab,
    newSession,
    openApp,
    owner,
    scriptedModel,
} from "./helpers.ts";

const AT = 1_800_000_000_000;
const facts = (headers: Record<string, string>, status = 200) => ({ status, headers });

test("Anthropic's subscription: 5-hour and weekly windows from utilization, status, and reset", () => {
    const windows = parseUsage(
        facts({
            "anthropic-ratelimit-unified-5h-utilization": "0.32",
            "anthropic-ratelimit-unified-5h-status": "allowed",
            "anthropic-ratelimit-unified-5h-reset": String((AT + 7_200_000) / 1000),
            "anthropic-ratelimit-unified-7d-utilization": "0.91",
            "anthropic-ratelimit-unified-7d-status": "allowed_warning",
            "anthropic-ratelimit-unified-7d-reset": String((AT + 3 * 86_400_000) / 1000),
            "anthropic-ratelimit-unified-status": "allowed",
        }),
        AT,
    );

    assert.deepEqual(
        windows.map((window) => [window.id, window.tag, window.label, window.left, window.state]),
        [
            ["5h", "5h", "5-hour window", 68, "ok"],
            ["7d", "7d", "Weekly window", 9, "low"],
        ],
    );
    assert.equal(windows[0]?.resetAt, AT + 7_200_000);
    assert.equal(windows[1]?.resetAt, AT + 3 * 86_400_000);
});

test("Anthropic's subscription: a rejected window is limited, with or without a number", () => {
    const [rejected] = parseUsage(
        facts(
            {
                "anthropic-ratelimit-unified-5h-status": "rejected",
                "anthropic-ratelimit-unified-5h-reset": String((AT + 60_000) / 1000),
            },
            429,
        ),
        AT,
    );

    assert.equal(rejected?.state, "limited");
    assert.equal(rejected?.left, 0);

    const [full] = parseUsage(facts({ "anthropic-ratelimit-unified-7d-utilization": "1" }), AT);

    assert.equal(full?.left, 0);
    assert.equal(full?.state, "limited");

    const [remaining] = parseUsage(
        facts({ "anthropic-ratelimit-unified-5h-remaining": "0.4" }),
        AT,
    );

    assert.equal(remaining?.left, 40);
});

test("Codex: the primary and secondary windows, named by their length", () => {
    const windows = parseUsage(
        facts({
            "x-codex-primary-used-percent": "100",
            "x-codex-primary-window-minutes": "300",
            "x-codex-primary-reset-after-seconds": "4320",
            "x-codex-secondary-used-percent": "48.4",
            "x-codex-secondary-window-minutes": "10080",
            "x-codex-secondary-reset-at": String((AT + 86_400_000) / 1000),
        }),
        AT,
    );

    assert.deepEqual(
        windows.map((window) => [window.id, window.tag, window.label, window.left, window.state]),
        [
            ["primary", "5h", "5-hour window", 0, "limited"],
            ["secondary", "7d", "Weekly window", 52, "ok"],
        ],
    );
    assert.equal(windows[0]?.resetAt, AT + 4_320_000, "reset-after counts from the response");
    assert.equal(windows[1]?.resetAt, AT + 86_400_000);

    const [unnamed] = parseUsage(facts({ "x-codex-primary-used-percent": "10" }), AT);

    assert.equal(unnamed?.label, "Primary window");
    assert.equal(unnamed?.tag, "");
    assert.equal(unnamed?.resetAt, undefined);
});

test("window names from minutes", () => {
    assert.deepEqual(windowName(300), { tag: "5h", label: "5-hour window" });
    assert.deepEqual(windowName(10_080), { tag: "7d", label: "Weekly window" });
    assert.deepEqual(windowName(1440), { tag: "1d", label: "Daily window" });
    assert.deepEqual(windowName(43_200), { tag: "30d", label: "30-day window" });
    assert.deepEqual(windowName(90), { tag: "90m", label: "90-minute window" });
});

test("API keys: x-ratelimit requests and tokens, with durations", () => {
    const windows = parseUsage(
        facts({
            "x-ratelimit-limit-requests": "500",
            "x-ratelimit-remaining-requests": "410",
            "x-ratelimit-reset-requests": "1s",
            "x-ratelimit-limit-tokens": "2000000",
            "x-ratelimit-remaining-tokens": "180000",
            "x-ratelimit-reset-tokens": "6m0s",
        }),
        AT,
    );

    assert.deepEqual(
        windows.map((window) => [window.label, window.left, window.state, window.detail]),
        [
            ["Requests per minute", 82, "ok", "410 of 500 left"],
            ["Tokens", 9, "low", "180k of 2M left"],
        ],
    );
    assert.equal(windows[0]?.resetAt, AT + 1000);
    assert.equal(windows[1]?.resetAt, AT + 360_000);
});

test("API keys: Anthropic's requests and tokens, and a single plain limit", () => {
    const windows = parseUsage(
        facts({
            "anthropic-ratelimit-requests-limit": "50",
            "anthropic-ratelimit-requests-remaining": "0",
            "anthropic-ratelimit-requests-reset": new Date(AT + 30_000).toISOString(),
            "anthropic-ratelimit-tokens-limit": "40000",
            "anthropic-ratelimit-tokens-remaining": "39000",
            "anthropic-ratelimit-tokens-reset": new Date(AT + 30_000).toISOString(),
        }),
        AT,
    );

    assert.deepEqual(
        windows.map((window) => [window.id, window.label, window.left, window.state]),
        [
            ["requests", "Requests per minute", 0, "limited"],
            ["tokens", "Tokens per minute", 98, "ok"],
        ],
    );
    assert.equal(windows[0]?.resetAt, AT + 30_000);

    const [plain] = parseUsage(
        facts({
            "x-ratelimit-limit": "1000",
            "x-ratelimit-remaining": "999",
            "x-ratelimit-reset": String(AT + 3_600_000),
        }),
        AT,
    );

    assert.equal(plain?.left, 100);
    assert.equal(plain?.resetAt, AT + 3_600_000);
});

test("a refusal that only says how long to wait is a limited window", () => {
    const [window] = parseUsage(facts({ "retry-after": "90" }, 429), AT);

    assert.equal(window?.state, "limited");
    assert.equal(window?.resetAt, AT + 90_000);
    assert.deepEqual(parseUsage(facts({ "retry-after": "90" }, 200), AT), []);
});

test("missing and malformed values make no window, and no window is wrong", () => {
    assert.deepEqual(parseUsage(facts({}), AT), []);
    assert.deepEqual(
        parseUsage(
            facts({
                "anthropic-ratelimit-unified-5h-utilization": "lots",
                "anthropic-ratelimit-unified-7d-utilization": "",
                "x-codex-primary-used-percent": "NaN",
                "x-codex-secondary-used-percent": "-5",
                "x-ratelimit-limit-requests": "abc",
                "x-ratelimit-remaining-requests": "abc",
                "x-ratelimit-limit-tokens": "100",
                "x-ratelimit-remaining-tokens": "-1",
                "x-ratelimit-limit": "0",
                "x-ratelimit-remaining": "0",
            }),
            AT,
        ),
        [],
    );

    // A number with no time, a time that is not one, and a percent past the ends.
    const [window, other] = parseUsage(
        facts({
            "x-codex-primary-used-percent": "140",
            "x-codex-primary-reset-at": "tomorrow-ish",
            "x-codex-secondary-used-percent": "-0",
            "x-codex-secondary-reset-after-seconds": "soon",
        }),
        AT,
    );

    assert.equal(window?.left, 0);
    assert.equal(window?.resetAt, undefined);
    assert.equal(other?.left, 100);
    assert.equal(other?.resetAt, undefined);
});

test("the store keeps the newest windows, no header and no secret", () => {
    let changed = 0;
    const store = new UsageStore({ now: () => AT, changed: () => changed++ });
    const secret = "sk-ant-api03-THE-KEY";
    const headers = {
        "anthropic-ratelimit-unified-5h-utilization": "0.5",
        "anthropic-ratelimit-unified-5h-reset": String(AT / 1000 + 100),
        authorization: `Bearer ${secret}`,
        "x-api-key": secret,
        cookie: `session=${secret}`,
        "anthropic-organization-id": "org-private-1234",
        "x-ratelimit-note": secret,
    };
    // The gate's own filter first, as a real response goes through it.
    const kept = responseFacts(200, {
        forEach: (each) => {
            for (const [name, value] of Object.entries(headers)) {
                each(value, name);
            }
        },
    });

    store.record("anthropic", kept);
    store.record("anthropic", facts(headers));

    const view = store.view({ id: "anthropic", name: "Anthropic", kind: "subscription" });

    assert.equal(view.status, "reported");
    assert.equal(view.asOf, AT);
    assert.equal(view.windows[0]?.left, 50);
    assert.equal(JSON.stringify(view).includes(secret), false);
    assert.equal(JSON.stringify(view).includes("org-private"), false);
    assert.equal(changed, 1, "the same numbers again are no change");

    store.record(
        "anthropic",
        facts({ "anthropic-ratelimit-unified-5h-utilization": "0.6" }),
        AT + 5,
    );
    assert.equal(
        store.view({ id: "anthropic", name: "A", kind: "subscription" }).windows[0]?.left,
        40,
    );
    assert.equal(changed, 2);
});

test("a provider with no response has no data; one that sends no usage does not report it", () => {
    const store = new UsageStore({ now: () => AT, changed: () => {} });
    const named = (id: string) => ({ id, name: id, kind: "key" as const });

    assert.equal(store.view(named("google")).status, "no-data");

    store.record("google", facts({ "content-type": "application/json" }));
    assert.equal(store.view(named("google")).status, "not-reported");
    assert.equal(store.view(named("google")).asOf, undefined);

    // A server error says nothing about usage, and never makes a silent provider of one that has none yet.
    store.record("ollama", facts({}, 503));
    assert.equal(store.view(named("ollama")).status, "no-data");

    // Numbers that came once stay when a later response has none (an error, say).
    store.record("openai", facts({ "x-codex-primary-used-percent": "10" }));
    store.record("openai", facts({}, 500));
    store.record("openai", facts({}, 200));
    assert.equal(store.view(named("openai")).status, "reported");
    assert.equal(store.view(named("openai")).windows[0]?.left, 90);

    // A sign-in or sign-out: the numbers were another account's.
    store.forget("openai");
    assert.equal(store.view(named("openai")).status, "no-data");
});

/** A model runtime whose request goes through `options.fetch`, as the adapters' do, once: its response is `respond`. */
function runtime() {
    return {
        streamSimple(m: Model<Api>, _context: unknown, options?: SimpleStreamOptions) {
            const stream = createAssistantMessageEventStream();

            queueMicrotask(async () => {
                const response = await options!.fetch!("https://provider.example/v1");
                const failed = response.status >= 400;
                const message = {
                    ...{ role: "assistant", api: "anthropic-messages", provider: m.provider },
                    ...{ model: m.id, usage: { input: 0, output: 0, cacheRead: 0 } },
                    ...{
                        timestamp: Date.now(),
                        content: failed ? [] : [{ type: "text", text: "ok" }],
                    },
                    ...(failed
                        ? { stopReason: "error", errorMessage: "400 bad" }
                        : { stopReason: "stop" }),
                } as never;

                stream.push(
                    failed
                        ? { type: "error", reason: "error", error: message }
                        : { type: "done", reason: "stop", message },
                );
                stream.end(message);
            });

            return stream;
        },
    };
}

test("the limit gate tells every response's headers, waiting or not, and a failure there does not stop the request", async () => {
    const seen: { provider: string; status: number; headers: Record<string, string> }[] = [];
    const models = runtime();
    const reply = async () =>
        new Response("{}", {
            status: 200,
            headers: {
                "anthropic-ratelimit-unified-5h-utilization": "0.25",
                authorization: "Bearer nope",
                "content-type": "application/json",
            },
        });
    let hours = 6;
    const gate = new LimitGate({
        hours: () => hours,
        epoch: () => 0,
        conversationOf: () => undefined,
        changed: () => {},
        log: () => {},
        seen: (provider, each) => {
            seen.push({ provider, ...each });

            if (seen.length === 4) {
                throw new Error("a bug in the listener");
            }
        },
    });
    const model = {
        id: "m",
        provider: "anthropic",
        api: "anthropic-messages",
    } as unknown as Model<Api>;
    const ask = (options?: SimpleStreamOptions) =>
        models.streamSimple(model, {} as never, { fetch: reply, ...options }).result();

    gate.install(models);

    assert.equal((await ask()).stopReason, "stop");
    assert.equal((await ask(noWait({}))).stopReason, "stop");
    hours = 0;
    assert.equal((await ask()).stopReason, "stop");
    assert.equal(
        (await ask()).stopReason,
        "stop",
        "a listener that throws never fails the request",
    );
    gate.close();

    assert.equal(seen.length, 4);
    assert.deepEqual(
        seen.map((each) => each.provider),
        ["anthropic", "anthropic", "anthropic", "anthropic"],
    );
    assert.deepEqual(seen[0]?.headers, { "anthropic-ratelimit-unified-5h-utilization": "0.25" });
});

test("the limit gate tells a refusal's headers too", async () => {
    const seen: number[] = [];
    const models = runtime();
    const gate = new LimitGate({
        hours: () => 0,
        epoch: () => 0,
        conversationOf: () => undefined,
        changed: () => {},
        log: () => {},
        seen: (_provider, each) => seen.push(each.status),
    });

    gate.install(models);
    await models
        .streamSimple({ id: "m", provider: "p", api: "anthropic-messages" } as never, {} as never, {
            fetch: async () =>
                new Response("{}", { status: 400, headers: { "x-ratelimit-limit": "10" } }),
        })
        .result();
    gate.close();
    assert.deepEqual(seen, [400]);
});

// ─── Who sees it ─────────────────────────────────────────────────────────────

const faux = scriptedModel(() => fauxAssistantMessage([fauxText("ok")]));
let app: App;

before(async () => {
    app = await openApp(faux);
});

after(async () => {
    await app.close();
    cleanUp();
});

test("the owner gets usage with each connected provider; a guest, a viewer, and a one-session guest get none", async () => {
    const id = await newSession(app);
    const ownerTab = fakeTab(undefined, owner(app));
    const guest = fakeTab(undefined, app.config.addUser("Gus", "guest").user);
    const viewer = fakeTab(undefined, app.config.addUser("Vee", "viewer").user);
    const scoped = fakeTab(undefined, app.config.addUser("Sam", "guest", [String(id)]).user);
    const tabs = [ownerTab, guest, viewer, scoped];

    for (const tab of tabs) {
        await app.attach(tab.client);
    }

    const first = ownerTab.last("usage") as
        { providers: { id: string; status: string }[] } | undefined;

    assert.ok(first, "the owner's tab got usage on connecting");
    assert.ok(first.providers.length > 0, "the connected providers are listed");
    assert.ok(first.providers.every((provider) => provider.status === "no-data"));

    // A response comes: the owner's tabs hear it, throttled, and nobody else does.
    const provider = first.providers[0]!.id;

    app.usage.record(
        provider,
        facts({
            "anthropic-ratelimit-unified-5h-utilization": "0.4",
            "anthropic-ratelimit-unified-5h-reset": String(Date.now() / 1000 + 600),
        }),
    );

    const heard = () =>
        ownerTab.events.filter((event) => event.event === "usage").map((event) => event.data);

    for (let i = 0; i < 100 && heard().length < 2; i++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const latest = heard().at(-1) as {
        providers: { id: string; status: string; windows: { left: number }[] }[];
    };
    const mine = latest.providers.find((each) => each.id === provider);

    assert.equal(mine?.status, "reported");
    assert.equal(mine?.windows[0]?.left, 60);

    for (const tab of [guest, viewer, scoped]) {
        assert.equal(
            tab.events.some((event) => event.event === "usage"),
            false,
        );
        assert.equal(app.usageFor(tab.client.user), undefined);
    }

    for (const tab of tabs) {
        app.detach(tab.client);
    }
});

test("only the owner reads GET /api/usage", async () => {
    const { createServer } = await import("node:http");
    const { createHandler } = await import("../src/server/http.ts");
    const server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/usage`;
    const guest = app.config.addUser("Gil", "guest");
    const viewer = app.config.addUser("Vic", "viewer");
    const scoped = app.config.addUser("Sue", "guest", ["1"]);

    try {
        assert.equal((await fetch(url)).status, 401);

        for (const person of [guest, viewer, scoped]) {
            const response = await fetch(url, {
                headers: { authorization: `Bearer ${person.token}` },
            });

            assert.equal(response.status, 403);
        }

        const response = await fetch(url, {
            headers: { authorization: `Bearer ${app.config.ownerToken}` },
        });

        assert.equal(response.status, 200);
        assert.ok(Array.isArray(((await response.json()) as { providers: unknown }).providers));
    } finally {
        server.closeAllConnections();
        server.close();
    }
});

test("the limit gate marks its provider held in the owner's usage, and a request's own wait does not", (t) => {
    const [first] = app.usageSnapshot().providers;

    assert.ok(first);
    assert.equal(first.held, undefined);

    const wait = (scope: string, until: number, resetAt?: number) => ({
        ...{ key: "k", provider: first.id, kind: "reset", since: 0, tries: 1, probing: false },
        ...{ scope, until, reason: "the provider's usage limit" },
        ...(resetAt === undefined ? {} : { resetAt }),
    });

    t.mock.method(
        app.limits,
        "gates",
        () => [wait("request", 5), wait("account", 1000, 2000)] as never,
    );
    assert.deepEqual(app.usageSnapshot().providers.find((each) => each.id === first.id)?.held, {
        until: 2000,
        reason: "the provider's usage limit",
    });

    t.mock.method(app.limits, "gates", () => [wait("request", 5)] as never);
    assert.equal(
        app.usageSnapshot().providers.find((each) => each.id === first.id)?.held,
        undefined,
    );
});
