// Web Access & Search provider management tests
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
const root = mkdtempSync(join(tmpdir(), "standalone-web-search-"));
const cleanUp = () => rmSync(root, { recursive: true, force: true });
const transport = { fetchPublic: (url: string | URL, init: any) => fetch(String(url), init) };

import { WebAccessManager } from "../web-search/manager.ts";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_TIERS } from "../web-search/settings.ts";

after(cleanUp);

test("WebAccessManager reports all supported providers and default configuration", async () => {
    const manager = new WebAccessManager(join(root, "defaults"), transport);
    const state = await manager.getState();

    assert.equal(typeof state.enabled, "boolean");
    assert.ok(state.providers.length >= 6);

    const ids = state.providers.map((p) => p.id);

    assert.ok(ids.includes("tavily"));
    assert.ok(ids.includes("exa"));
    assert.ok(ids.includes("brave"));
    assert.ok(ids.includes("serper"));
    assert.ok(ids.includes("openai"));
    assert.ok(ids.includes("duckduckgo"));

    const ddg = state.providers.find((p) => p.id === "duckduckgo");

    assert.equal(ddg?.apiKeyRequired, false);
    assert.equal(ddg?.keyConfigured, true);
});

test("WebAccessManager testConnection fails fast on missing key for keyed providers", async () => {
    const manager = new WebAccessManager(join(root, "defaults"), transport);
    const result = await manager.testConnection("tavily", "");

    assert.equal(result.ok, false);
    assert.ok(result.error?.includes("No API key"));
});

async function fixture() {
    const directory = await mkdtemp(join(root, "web-access-"));
    const manager = new WebAccessManager(directory, transport);

    await manager.saveConfig({
        tavilyApiKey: "fake-tavily",
        exaApiKey: "fake-exa",
        braveApiKey: "fake-brave",
    });

    return { manager, directory };
}

test("web providers ignore auth files, subscription tokens and key commands", async () => {
    const directory = await mkdtemp(join(root, "web-auth-"));
    const manager = new WebAccessManager(directory, transport);

    await mkdir(join(directory, "agent"));
    await writeFile(
        join(directory, "agent/auth.json"),
        JSON.stringify({
            openai: { type: "oauth", access: "private-oauth-token" },
            "openai-codex": { type: "oauth", access: "private-codex-token" },
            exa: { type: "api_key", key: "!printf private-key" },
            brave: { type: "api_key", key: "fake-brave-key" },
        }),
    );
    assert.deepEqual(await manager.resolveKey("openai"), { source: "none" });
    assert.deepEqual(await manager.resolveKey("exa"), { source: "none" });
    assert.deepEqual(await manager.resolveKey("brave"), {
        source: "none",
    });
});

const jsonResponse = (data: unknown) =>
    new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
const results = [
    { title: "Result", url: "https://example.com", text: "Exa content", content: "Tavily content" },
];

test("quick routing follows the configured order, reports attempts, and tracks fallback requests", async (t) => {
    const { manager } = await fixture();
    const calls: string[] = [];

    t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
        if (init?.method === "HEAD") {
            return new Response(null);
        }

        calls.push(url);

        if (url.includes("brave")) {
            return new Response("quota", { status: 429 });
        }

        const body = JSON.parse(init.body as string);

        assert.equal(body.type, "lite");
        assert.equal("useAutoprompt" in body, false);

        return jsonResponse({ results, costDollars: { total: 0.002 } });
    });
    const response = await manager.search("small query", undefined, 3, { tier: "quick" });

    assert.equal(calls.length, 2);
    assert.equal(response.provider, "exa");
    assert.equal(response.mode, "lite");
    assert.equal(response.attempts?.[0]?.outcome, "brave HTTP 429");
    const counters = Object.values((await manager.getState()).usage.days).flatMap(Object.values);

    assert.equal(counters.find((c) => c.provider === "brave")?.failures, 1);
    assert.equal(counters.find((c) => c.provider === "exa")?.fallback, 1);
    assert.equal(counters.find((c) => c.provider === "exa")?.dollars, 0.002);
    assert.ok(counters.every((c) => c.unknown === 0));
});

test("exhausted tiers never escalate, explicit provider remains strict, and cancellation stops fallback", async (t) => {
    const { manager } = await fixture();

    await manager.saveConfig({ tierRouting: { ...DEFAULT_TIERS, quick: [{ provider: "brave" }] } });
    const calls: string[] = [];
    const stub = t.mock.method(globalThis, "fetch", async (url: string) => {
        calls.push(url);

        return new Response("no", { status: 503 });
    });

    await assert.rejects(
        () => manager.search("query", undefined, 5, { tier: "quick" }),
        /no automatic escalation/,
    );
    await assert.rejects(() => manager.search("query", "brave"), /exhausted standard/);
    assert.equal(calls.length, 2);
    assert.ok(calls.every((u) => u.includes("brave")));
    stub.mock.mockImplementation(async () => {
        throw new DOMException("cancelled", "AbortError");
    });
    await assert.rejects(
        () => manager.search("query", undefined, 5, { tier: "quick" }),
        /cancelled/,
    );
    assert.equal(stub.mock.callCount(), 3);
});

test("validation, disabled operations, and missing keys send no requests", async (t) => {
    const { manager } = await fixture();
    const stub = t.mock.method(globalThis, "fetch", async () => {
        throw new Error("Unexpected network request");
    });

    for (const config of [
        { maxResults: NaN },
        { tierRouting: { ...DEFAULT_TIERS, quick: [{ provider: "exa", mode: "advanced" }] } },
        { providerSettings: { tavily: { maxDepth: 6 } } },
        { providerSettings: { exa: { content: "unsupported" } } },
        { operations: { brave: ["crawl"] } },
        { extractOrder: ["openai"] },
    ]) {
        await assert.rejects(
            () => manager.saveConfig(config as never),
            (e: any) => e.status === 400,
        );
    }

    await assert.rejects(
        () => manager.search("query", "exa", 5, { mode: "nonsense" }),
        /Unsupported/,
    );
    await assert.rejects(
        () => manager.search("query", undefined, 5, { mode: "deep" }),
        /requires an explicit provider/,
    );
    await assert.rejects(() => manager.search("query", undefined, NaN), /integer/);
    await assert.rejects(() => manager.research("query", "invalid"), /Unsupported/);
    await manager.saveConfig({ operations: { brave: [] } });
    await assert.rejects(() => manager.search("query", "brave"), /disabled or missing key/);
    assert.equal((await manager.testConnection("tavily", "")).ok, false);
    await manager.saveConfig({ enabled: false });
    await assert.rejects(() => manager.search("query"), /disabled or missing key/);
    await assert.rejects(() => manager.fetchContent("https://example.com"), /disabled/);
    assert.equal(stub.mock.callCount(), 0);
    assert.deepEqual((await manager.getState()).usage.days, {});
});

test("legacy routing and unknown fields survive saves and concurrent key/config writes", async (t) => {
    const { manager, directory } = await fixture();

    await writeFile(
        join(directory, "web-search.json"),
        JSON.stringify({
            provider: "brave",
            searchRouting: { providers: ["exa", "brave"], fallbackOn: ["quota"] },
            custom: { preserved: true },
            braveApiKey: "fake",
            exaApiKey: "fake",
        }),
    );
    const requests: string[] = [];

    t.mock.method(globalThis, "fetch", async (url: string) => {
        requests.push(url);

        return jsonResponse({
            web: { results: [{ title: "brave", url: "https://example.com", description: "yes" }] },
        });
    });
    assert.equal((await manager.getState()).tierRoutingEnabled, false);
    assert.equal((await manager.search("query")).provider, "brave");
    const other = new WebAccessManager(directory, transport);

    await Promise.all([
        manager.setApiKey("tavily", "new-key"),
        other.saveConfig({ maxResults: 12 }),
        manager.saveConfig({ providerSettings: { exa: { mode: "deep-lite" } } }),
    ]);
    const config = JSON.parse(await readFile(join(directory, "web-search.json"), "utf8"));

    assert.equal(config.maxResults, 12);
    assert.equal(config.tavilyApiKey, "new-key");
    assert.deepEqual(config.custom, { preserved: true });
    assert.deepEqual(config.searchRouting.fallbackOn, ["quota"]);
    assert.equal(config.tierRouting, undefined);
    assert.equal(requests.length, 1);
});

test("provider settings reach exact Tavily/Exa requests and persist across managers", async (t) => {
    const { manager, directory } = await fixture();

    await manager.saveConfig({
        providerSettings: {
            tavily: {
                mode: "advanced",
                topic: "news",
                timeRange: "week",
                includeAnswer: false,
                includeDomains: ["example.com"],
            },
            exa: { mode: "deep-lite", content: "highlights" },
        },
    });
    const bodies: any[] = [];

    t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(init.body as string));

        return jsonResponse({
            results: [{ ...results[0], text: undefined, highlights: ["Excerpt"] }],
            usage: { credits: 2 },
        });
    });
    await manager.search("query", "tavily");
    const exa = await new WebAccessManager(directory, transport).search("query", "exa");

    assert.equal(bodies[0].search_depth, "advanced");
    assert.equal(bodies[0].include_answer, false);
    assert.equal(bodies[0].time_range, "week");
    assert.equal(bodies[0].auto_parameters, false);
    assert.equal(bodies[1].type, "deep-lite");
    assert.deepEqual(bodies[1].contents, { highlights: true });
    assert.equal(exa.results[0]?.content, "Excerpt");
});

test("concurrent requests across managers keep exact counts and no query or credentials in usage", async (t) => {
    const { manager, directory } = await fixture();
    const other = new WebAccessManager(directory, transport);

    t.mock.method(globalThis, "fetch", async () =>
        jsonResponse({ results, usage: { credits: 1 } }),
    );
    await Promise.all(
        Array.from({ length: 16 }, (_, i) =>
            (i % 2 ? manager : other).search("secret-query", "tavily"),
        ),
    );
    const state = await new WebAccessManager(directory, transport).getState();
    const counters = Object.values(state.usage.days).flatMap(Object.values);

    assert.equal(counters[0]?.requests, 16);
    assert.equal(counters[0]?.successes, 16);
    assert.equal(counters[0]?.credits, 16);
    assert.equal(counters[0]?.unknown, 0);
    const raw = await readFile(join(directory, "web-usage.json"), "utf8");

    assert.equal(/secret-query|fake-tavily|example.com/.test(raw), false);
});

test("request timeouts remain unknown and connection tests are counted separately", async (t) => {
    const { manager } = await fixture();
    const stub = t.mock.method(globalThis, "fetch", async () => {
        throw new DOMException("timeout", "TimeoutError");
    });

    await assert.rejects(() => manager.search("query", "tavily"), /timeout/);
    stub.mock.mockImplementation(async () => jsonResponse({ results, usage: { credits: 1 } }));
    assert.equal((await manager.testConnection("tavily")).ok, true);
    const counters = Object.values((await manager.getState()).usage.days).flatMap(Object.values);

    assert.equal(counters.find((r) => r.operation === "search")?.unknown, 1);
    assert.equal(counters.find((r) => r.operation === "test")?.requests, 1);
});

test("direct reads and cloud extraction use the host transport and count preflight requests", async (t) => {
    const { manager } = await fixture();

    t.mock.method(globalThis, "fetch", async (url: string, init: any) => {
        if (init?.method === "HEAD") {
            return new Response(null, { status: 405 });
        }

        if (url.includes("api.tavily.com")) {
            return jsonResponse({ results: [{ raw_content: "Tavily extracted" }] });
        }

        if (url.includes("api.exa.ai")) {
            return jsonResponse({ results: [{ text: "Exa extracted" }] });
        }

        return new Response("<h1>Readable</h1><script>hidden</script>");
    });
    assert.equal((await manager.fetchContent("https://example.com")).text, "Readable");
    assert.equal(
        (await manager.fetchContent("https://example.com", 20000, "tavily")).text,
        "Tavily extracted",
    );
    assert.equal(
        (await manager.fetchContent("https://example.com", 20000, "exa")).text,
        "Exa extracted",
    );
    const state = await manager.getState();

    assert.equal(
        Object.values(state.usage.days)
            .flatMap(Object.values)
            .reduce((n: any, r: any) => n + r.requests, 0),
        5,
    );
});

test("crawl limits and research jobs persist; repeated polls do not double count credits", async (t) => {
    const { manager, directory } = await fixture();

    await manager.saveConfig({
        providerSettings: {
            tavily: {
                maxDepth: 2,
                maxBreadth: 4,
                pageLimit: 7,
                allowExternal: false,
                researchModel: "pro",
            },
        },
    });
    const calls: string[] = [];

    t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
        if (init?.method === "HEAD") {
            return new Response(null);
        }

        calls.push(url);

        if (url.endsWith("/crawl")) {
            const body = JSON.parse(init.body as string);

            assert.equal(body.max_depth, 2);
            assert.equal(body.max_breadth, 4);
            assert.equal(body.limit, 7);
            assert.equal(body.allow_external, false);

            return jsonResponse({ results, usage: { credits: 3 } });
        }

        if (url.endsWith("/research")) {
            assert.equal(JSON.parse(init.body as string).model, "pro");

            return jsonResponse({ request_id: "job-1", status: "pending", usage: { credits: 2 } });
        }

        assert.match(url, /job-1\?include_usage=true$/);

        return jsonResponse({ status: "completed", content: "Report", usage: { credits: 16 } });
    });
    await manager.crawl("https://example.com", "Find documentation");
    await manager.research("Research question");
    const restarted = new WebAccessManager(directory, transport);

    await Promise.all([restarted.researchStatus("job-1"), manager.researchStatus("job-1")]);
    const state = await restarted.getState();

    assert.equal(state.usage.jobs["job-1"]?.status, "completed");
    const rows = Object.values(state.usage.days).flatMap(Object.values);

    assert.equal(rows.find((r) => r.operation === "research")?.requests, 1);
    assert.equal(rows.find((r) => r.operation === "research")?.credits, 16);
    assert.equal(rows.find((r) => r.operation === "research-status")?.requests, 2);
    assert.equal(calls.length, 4);
});

test("uncertain research submission is sent once", async (t) => {
    const { manager } = await fixture();
    const stub = t.mock.method(globalThis, "fetch", async () => {
        throw new DOMException("timeout", "TimeoutError");
    });

    await assert.rejects(
        () => manager.research("question"),
        /not retried; submission may have reached/,
    );
    assert.equal(stub.mock.callCount(), 1);
});

test("invalid provider JSON is redacted and fallback still runs", async (t) => {
    const { manager } = await fixture();

    await manager.saveConfig({
        tierRouting: {
            ...DEFAULT_TIERS,
            quick: [{ provider: "brave" }, { provider: "exa", mode: "lite" }],
        },
    });
    t.mock.method(globalThis, "fetch", async (url: string) =>
        url.includes("brave") ? new Response("secret-invalid-response") : jsonResponse({ results }),
    );
    const response = await manager.search("query", undefined, 5, { tier: "quick" });

    assert.equal(response.provider, "exa");
    assert.match(response.attempts?.[0]?.outcome ?? "", /invalid JSON/);
    assert.equal(JSON.stringify(response.attempts).includes("secret-invalid-response"), false);
});

test("corrupt configuration is preserved without echoing its contents", async () => {
    const { manager, directory } = await fixture();
    const raw = "secret-key-invalid-json";

    await writeFile(join(directory, "web-search.json"), raw);
    await assert.rejects(
        () => manager.saveConfig({ maxResults: 5 }),
        (error: Error) => error.message.includes("Invalid JSON") && !error.message.includes(raw),
    );
    assert.equal(await readFile(join(directory, "web-search.json"), "utf8"), raw);
});
