// Request locales across public pages and design documentation, through a real temporary app.
import {
    type App,
    cleanUp,
    context,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createHandler } from "../src/server/http.ts";
import { ArtifactBodyDoc } from "../src/server/docs.ts";
import { renderSystemDoc } from "../src/server/design/docsite.ts";
import { loadDesignSystem } from "../src/server/extensions/design/system-api.ts";
import { DOCS_ID } from "../src/server/extensions/design/system-routes.ts";
import { writeSystemFixture } from "./design-system-fixtures.ts";
import type { ConversationId } from "@earendil-works/pi-durable";

const data = join(root, "request-locale-pages");
const extensions = join(data, "extensions");
const gates = globalThis as unknown as {
    requestLocaleGate?: Promise<void>;
    requestLocaleEntered?: number;
};
let app: App;
let server: Server;
let base = "";
let publicPath = "";
let session: ConversationId;
let systemFolder = "";

before(async () => {
    mkdirSync(extensions, { recursive: true });
    writeFileSync(
        join(extensions, "locale-pages.ts"),
        `/** A synthetic locale and public page. */
export default (_host, web) => {
    web.uiLocales([{ id: "fr", label: "Français", messages: { "app.menu": "Menu français", "signin.switch-as": "Compte {name}" } }]);
    web.route("POST", "make", () => web.links.create({ hours: 1 }));
    web.route("GET", "locale", request => ({ lang: request.locale?.lang ?? "en", text: request.locale?.t("app.menu", "Menu") ?? "Menu", own: request.locale !== undefined, frozen: request.locale === undefined || Object.isFrozen(request.locale), fallback: request.locale?.t("missing.synthetic", "Explicit English {name}", { name: "$& {other}" }) ?? "Explicit English $& {other}", formatted: request.locale?.t("signin.switch-as", "Sign in as {name}", { name: "$& {other}" }) ?? "Sign in as $& {other}" }), { access: "view" });
    web.conversationRoute("GET", "session/:id", request => ({ lang: request.locale?.lang ?? "en", text: request.locale?.t("app.menu", "Menu") ?? "Menu", own: request.locale !== undefined, frozen: request.locale === undefined || Object.isFrozen(request.locale) }), { conversation: "id", access: "view" });
    web.route("POST", "hold", request => ({ lang: request.locale?.lang ?? "en", text: request.locale?.t("app.menu", "Menu") ?? "Menu" }), { access: "view" });
    web.publicPage(async request => {
        const lang = request.locale?.lang ?? "en";
        const own = request.locale !== undefined;
        const frozen = request.locale === undefined || Object.isFrozen(request.locale);
        const originalLanguage = lang;
        if (request.locale) {
            try { request.locale.lang = "de"; } catch {}
        }
        globalThis.requestLocaleEntered = (globalThis.requestLocaleEntered ?? 0) + 1;
        await globalThis.requestLocaleGate;
        const text = request.locale?.t("app.menu", "Menu") ?? "Menu";
        if (request.method === "POST") {
            return JSON.stringify({ lang, text, own, frozen, answer: request.form.answer });
        }
        if (request.query.get("html") === "1") {
            const escape = value => String(value).replace(/[&<>\"']/g, char => "&#" + char.charCodeAt(0) + ";");
            return '<!doctype html><html lang="' + escape(lang) + '"><body><h1>' + escape(text) + '</h1></body></html>';
        }
        return JSON.stringify({ lang: request.locale?.lang ?? originalLanguage, text, own, frozen });
    });
};
`,
    );
    app = await openApp(scriptedModel(), data);
    systemFolder = join(root, "request-locale-system");
    mkdirSync(systemFolder, { recursive: true });
    writeSystemFixture(systemFolder);
    const tokensFile = join(systemFolder, ".pi", "design", "tokens.json");
    const tokens = JSON.parse(readFileSync(tokensFile, "utf8")) as {
        $extensions: Record<string, { name: string }>;
    };

    tokens.$extensions["com.pi-pocket"]!.name = 'Harbor "<img src=x onerror=alert(2)>';
    writeFileSync(tokensFile, JSON.stringify(tokens, null, 4));
    session = await newSession(app, systemFolder);
    await app.setExtensionEnabled(owner(app), "locale-pages.ts", true);
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const response = await fetch(`${base}/api/x/locale-pages/make`, {
        method: "POST",
        headers: {
            authorization: `Bearer ${app.config.ownerToken}`,
            "x-pocket": "1",
            "content-type": "application/json",
        },
        body: "{}",
    });

    assert.equal(response.status, 200);
    publicPath = ((await response.json()) as { path: string }).path;
    assert.match(publicPath, /^\/l\/[0-9a-f]{32}$/);
});

after(async () => {
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test("one public link keeps overlapping English and French requests isolated", async () => {
    let release!: () => void;

    gates.requestLocaleEntered = 0;
    gates.requestLocaleGate = new Promise<void>((resolve) => (release = resolve));
    const get = (locale: string) =>
        fetch(`${base}${publicPath}`, { headers: { cookie: `pocket_locale=${locale}` } });
    const english = get("en");
    const french = get("fr");

    english.catch(() => {});
    french.catch(() => {});

    try {
        await until(
            () => gates.requestLocaleEntered === 2,
            "both public handlers are waiting",
            5000,
        );
    } finally {
        release();
    }

    const [enResponse, frResponse] = await Promise.all([english, french]);
    const [en, fr] = await Promise.all([enResponse.json(), frResponse.json()]);

    assert.equal(enResponse.status, 200);
    assert.equal(frResponse.status, 200);
    assert.equal(enResponse.headers.get("content-type")?.startsWith("text/html"), true);
    assert.equal(frResponse.headers.get("content-type")?.startsWith("text/html"), true);
    assert.equal(gates.requestLocaleEntered, 2, "both requests overlap at the real handler");
    assert.deepEqual(
        fr,
        { lang: "fr", text: "Menu français", own: true, frozen: true },
        "French request receives its own locale",
    );
    assert.deepEqual(en, { lang: "en", text: "Menu", own: true, frozen: true });
});

test("overlapping en/fr/fr-CA requests stay isolated in a larger batch", async () => {
    let release!: () => void;

    gates.requestLocaleEntered = 0;
    gates.requestLocaleGate = new Promise<void>((resolve) => (release = resolve));
    const wanted = ["en", "fr", "fr-CA", "fr"];
    const pending = wanted.map((locale) =>
        fetch(`${base}${publicPath}`, { headers: { cookie: `pocket_locale=${locale}` } }),
    );

    for (const item of pending) {
        item.catch(() => {});
    }

    try {
        await until(
            () => gates.requestLocaleEntered === wanted.length,
            "four handlers overlap",
            5000,
        );
    } finally {
        release();
    }

    const responses = await Promise.all(pending);
    const bodies = await Promise.all(responses.map((response) => response.json()));

    assert.deepEqual(
        responses.map((response) => response.status),
        [200, 200, 200, 200],
    );
    assert.deepEqual(bodies, [
        { lang: "en", text: "Menu", own: true, frozen: true },
        { lang: "fr", text: "Menu français", own: true, frozen: true },
        { lang: "en", text: "Menu", own: true, frozen: true },
        { lang: "fr", text: "Menu français", own: true, frozen: true },
    ]);
});

test("public and authenticated module routes use exact, validated locale preferences", async () => {
    for (const [cookie, expected] of [
        [undefined, { lang: "en", text: "Menu" }],
        ["pocket_locale=invalid_tag", { lang: "en", text: "Menu" }],
        ["pocket_locale=fr-CA", { lang: "en", text: "Menu" }],
        ["pocket_locale=fr-x-test", { lang: "en", text: "Menu" }],
        ["pocket_locale=de", { lang: "en", text: "Menu" }],
        ["pocket_locale=%E0%A4%A", { lang: "en", text: "Menu" }],
        ["pocket_locale=FR", { lang: "fr", text: "Menu français" }],
    ] as const) {
        for (const authenticated of [false, true]) {
            const response = await fetch(
                `${base}${authenticated ? "/api/x/locale-pages/locale" : publicPath}`,
                {
                    headers: {
                        ...(cookie === undefined ? {} : { cookie }),
                        ...(authenticated
                            ? { authorization: `Bearer ${app.config.ownerToken}`, "x-pocket": "1" }
                            : {}),
                    },
                },
            );

            assert.equal(response.status, 200);

            if (!authenticated) {
                assert.match(
                    response.headers.get("content-security-policy") ?? "",
                    /sandbox allow-forms/,
                );
                assert.equal(response.headers.get("cache-control"), "no-store");
            }

            assert.deepEqual(
                await response.json(),
                authenticated
                    ? {
                          ...expected,
                          own: true,
                          frozen: true,
                          fallback: "Explicit English $& {other}",
                          formatted:
                              expected.lang === "fr"
                                  ? "Compte $& {other}"
                                  : "Sign in as $& {other}",
                      }
                    : { ...expected, own: true, frozen: true },
                `${cookie ?? "no cookie"}; authenticated=${authenticated}`,
            );
        }
    }

    const frenchUser = app.config.addUser("French route viewer", "viewer");
    const concurrent = await Promise.all(
        ["en", "fr"].map(async (locale) => {
            const response = await fetch(`${base}/api/x/locale-pages/locale`, {
                headers: {
                    authorization: `Bearer ${frenchUser.token}`,
                    "x-pocket": "1",
                    cookie: `pocket_locale=${locale}`,
                },
            });

            return { status: response.status, body: await response.json() };
        }),
    );

    assert.deepEqual(concurrent, [
        {
            status: 200,
            body: {
                lang: "en",
                text: "Menu",
                own: true,
                frozen: true,
                fallback: "Explicit English $& {other}",
                formatted: "Sign in as $& {other}",
            },
        },
        {
            status: 200,
            body: {
                lang: "fr",
                text: "Menu français",
                own: true,
                frozen: true,
                fallback: "Explicit English $& {other}",
                formatted: "Compte $& {other}",
            },
        },
    ]);
    const conversation = await fetch(`${base}/api/x/locale-pages/session/${session}`, {
        headers: {
            authorization: `Bearer ${app.config.ownerToken}`,
            "x-pocket": "1",
            cookie: "pocket_locale=fr",
        },
    });

    assert.equal(conversation.status, 200);
    assert.deepEqual(await conversation.json(), {
        lang: "fr",
        text: "Menu français",
        own: true,
        frozen: true,
    });
    const conversationEnglish = await fetch(`${base}/api/x/locale-pages/session/${session}`, {
        headers: {
            authorization: `Bearer ${app.config.ownerToken}`,
            "x-pocket": "1",
            cookie: "pocket_locale=fr-CA",
        },
    });

    assert.equal(conversationEnglish.status, 200);
    assert.deepEqual(await conversationEnglish.json(), {
        lang: "en",
        text: "Menu",
        own: true,
        frozen: true,
    });
    const isolated = app.config.addUser("Single session", "viewer", [String(session)]);
    const forbidden = await fetch(`${base}/api/x/locale-pages/locale`, {
        headers: {
            authorization: `Bearer ${isolated.token}`,
            "x-pocket": "1",
            cookie: "pocket_locale=fr",
        },
    });

    assert.equal(forbidden.status, 404, "locale propagation does not widen module access");
    const post = await fetch(`${base}${publicPath}`, {
        method: "POST",
        headers: {
            cookie: "pocket_locale=fr",
            "content-type": "application/x-www-form-urlencoded",
        },
        body: "answer=Bonjour",
    });

    assert.equal(post.status, 200);
    assert.deepEqual(await post.json(), {
        lang: "fr",
        text: "Menu français",
        own: true,
        frozen: true,
        answer: "Bonjour",
    });
});

test("authenticated request locale is captured before a delayed POST body", async () => {
    const source = join(extensions, "locale-pages.ts");
    const original = readFileSync(source, "utf8");
    const viewer = app.config.addUser("Delayed locale viewer", "viewer");
    const catalogBefore = app.webs.locales.snapshot().revision;
    const visibleBefore = app.webs.locales.snapshot().locales.find((item) => item.id === "fr")
        ?.messages["app.menu"];

    assert.equal(visibleBefore, "Menu français");
    let sent!: () => void;
    let finish!: () => void;
    let client!: ReturnType<typeof httpRequest>;
    let finished = false;
    const started = new Promise<void>((resolve) => (sent = resolve));
    const response = new Promise<{ status: number; body: string }>((resolve, reject) => {
        const request = httpRequest(
            `${base}/api/x/locale-pages/hold`,
            {
                method: "POST",
                headers: {
                    authorization: `Bearer ${viewer.token}`,
                    "x-pocket": "1",
                    cookie: "pocket_locale=fr",
                    "content-type": "application/json",
                    "content-length": "2",
                },
            },
            (answer) => {
                let body = "";

                answer.setEncoding("utf8");
                answer.on("data", (chunk: string) => (body += chunk));
                answer.on("end", () => resolve({ status: answer.statusCode ?? 0, body }));
            },
        );

        client = request;
        request.on("error", reject);
        request.write("{");

        finish = () => {
            if (!finished) {
                finished = true;
                request.end("}");
            }
        };

        request.once("socket", () => sent());
    });

    response.catch(() => {});
    await started;

    // shortcut: 100 ms approximates server body-read entry; use a server-side barrier if scheduling becomes unreliable.
    await new Promise((resolve) => setTimeout(resolve, 100));

    try {
        assert.equal(
            client.destroyed,
            false,
            "the viewer POST remains in flight while its body is incomplete",
        );
        writeFileSync(source, original.replace("Menu français", "Menu après"));
        await app.reloadExtension("locale-pages.ts");
        assert.ok(app.webs.locales.snapshot().revision > catalogBefore);
        assert.equal(
            app.webs.locales.snapshot().locales.find((item) => item.id === "fr")?.messages[
                "app.menu"
            ],
            "Menu après",
        );
        assert.equal(
            client.destroyed,
            false,
            "the original POST is still awaiting its body after reload",
        );
        finish();
        const held = await response;

        assert.equal(held.status, 200);
        assert.deepEqual(
            JSON.parse(held.body),
            { lang: "fr", text: "Menu français" },
            "POST keeps the catalog from before its body was read",
        );
    } finally {
        finish();
        await response.catch(() => {});
        writeFileSync(source, original);
        await app.reloadExtension("locale-pages.ts");
    }
});

test("public page authors can escape translated text as HTML", async () => {
    const file = join(extensions, "locale-pages.ts");
    const original = readFileSync(file, "utf8");
    const hostile = 'Menu "<img src=x onerror=alert(1)>';

    try {
        writeFileSync(
            file,
            original.replace(JSON.stringify("Menu français"), JSON.stringify(hostile)),
        );
        await app.reloadExtension("locale-pages.ts");
        const response = await fetch(`${base}${publicPath}?html=1`, {
            headers: { cookie: "pocket_locale=fr" },
        });
        const body = await response.text();
        const policy = response.headers.get("content-security-policy") ?? "";
        const escaped = hostile.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

        assert.equal(response.status, 200);
        assert.match(body, /<html lang="fr">/);
        assert.ok(body.includes(escaped), "translated content is escaped by the public page");
        assert.ok(!body.includes("<img"));
        assert.match(policy, /sandbox allow-forms/);
        assert.doesNotMatch(policy, /allow-scripts|allow-same-origin/);
    } finally {
        writeFileSync(file, original);
        await app.reloadExtension("locale-pages.ts");
    }
});

test("the old one-argument design documentation API remains English", () => {
    const system = loadDesignSystem(systemFolder);

    assert.ok(system, "the real project design system loads");
    assert.equal(system.name, 'Harbor "<img src=x onerror=alert(2)>');
    const html = renderSystemDoc(system).html;

    assert.match(html, /<html lang="en"/);
    assert.match(html, /aria-label="Menu"/);
    assert.ok(
        html.includes("Harbor &quot;&lt;img src=x onerror=alert(2)&gt;") ||
            html.includes("Harbor &#34;&#60;img src=x onerror=alert(2)&#62;"),
    );
    assert.ok(!html.includes('Harbor "<img'));
    assert.match(html, /Content-Security-Policy/);
});

test("the design docs publish route stores separate English and French artifacts", async () => {
    const publish = async (locale: string | undefined, key: string) => {
        const response = await fetch(`${base}/api/x/design/c/${session}/system/docs`, {
            method: "POST",
            headers: {
                authorization: `Bearer ${app.config.ownerToken}`,
                "x-pocket": "1",
                ...(locale === undefined ? {} : { cookie: `pocket_locale=${locale}` }),
                "content-type": "application/json",
            },
            body: JSON.stringify({ key }),
        });
        const result = (await response.json()) as { id?: string; version?: number; error?: string };

        assert.equal(response.status, 200, result.error ?? "the documentation route succeeds");
        assert.equal(result.id, DOCS_ID);
        assert.equal(typeof result.version, "number");
        assert.ok(result.version! > 0);
        const stored = await app.harness.snapshot(
            ArtifactBodyDoc,
            session,
            `${DOCS_ID}@${result.version}`,
            context,
        );

        assert.ok(stored, "the published artifact body is stored by the real route");

        return stored.content;
    };

    const english = await publish("en", "locale-docs-en-001");
    const french = await publish("fr", "locale-docs-fr-001");

    assert.notEqual(english, french, "different request locales produce different stored pages");
    const unavailable = await publish("fr-CA", "locale-docs-fallback-001");
    const invalid = await publish("invalid_tag", "locale-docs-invalid-001");
    const missing = await publish(undefined, "locale-docs-missing-001");
    const canonical = await publish("FR", "locale-docs-canonical-001");

    assert.match(canonical, /<html lang="fr"/);
    assert.match(canonical, /aria-label="Menu français"/);

    assert.match(missing, /<html lang="en"/);
    assert.match(missing, /aria-label="Menu"/);
    assert.match(invalid, /<html lang="en"/);
    assert.match(invalid, /aria-label="Menu"/);
    assert.match(unavailable, /<html lang="en"/);
    assert.match(unavailable, /aria-label="Menu"/);
    assert.match(english, /<html lang="en"/);
    assert.match(french, /<html lang="fr"/);
    assert.match(english, /aria-label="Menu"/);
    assert.match(french, /aria-label="Menu français"/);

    for (const html of [english, french]) {
        assert.match(html, /Content-Security-Policy/);
        assert.match(html, /script-src/);
        assert.ok(
            html.includes("Harbor &quot;&lt;img src=x onerror=alert(2)&gt;") ||
                html.includes("Harbor &#34;&#60;img src=x onerror=alert(2)&#62;"),
            "the project name remains literal and escaped",
        );
        assert.ok(!html.includes('Harbor "<img'));
    }

    const source = join(extensions, "locale-pages.ts");
    const original = readFileSync(source, "utf8");
    const hostile = 'Menu "<img src=x onerror=alert(1)>';

    try {
        writeFileSync(
            source,
            original.replace(JSON.stringify("Menu français"), JSON.stringify(hostile)),
        );
        await app.reloadExtension("locale-pages.ts");
        const escaped = await publish("fr", "locale-docs-fr-hostile-001");
        const retained = await app.harness.snapshot(
            ArtifactBodyDoc,
            session,
            `${DOCS_ID}@2`,
            context,
        );

        assert.equal(retained?.content, french, "earlier published artifact bytes stay unchanged");
        const publicResponse = await fetch(`${base}${publicPath}?html=1`, {
            headers: { cookie: "pocket_locale=fr" },
        });
        const publicHtml = await publicResponse.text();

        assert.equal(publicResponse.status, 200);
        assert.match(publicHtml, /<html lang="fr">/);
        assert.ok(publicHtml.includes("Menu &#34;&#60;img src=x onerror=alert(1)&#62;"));
        assert.ok(!publicHtml.includes(hostile));
        assert.match(escaped, /<html lang="fr"/);
        assert.ok(
            escaped.includes("Menu &quot;&lt;img src=x onerror=alert(1)&gt;") ||
                escaped.includes("Menu &#34;&#60;img src=x onerror=alert(1)&#62;"),
            "translated menu text is escaped in the artifact",
        );
        assert.ok(!escaped.includes(hostile));
        assert.ok(
            !escaped.includes("<img src=x onerror=alert(1)>"),
            "the translated label cannot inject an image element",
        );
    } finally {
        writeFileSync(source, original);
        await app.reloadExtension("locale-pages.ts");
    }
});

test("a public request retains its locale snapshot while its handler waits", async () => {
    let release!: () => void;
    const file = join(extensions, "locale-pages.ts");
    const original = readFileSync(file, "utf8");

    gates.requestLocaleEntered = 0;
    gates.requestLocaleGate = new Promise<void>((resolve) => (release = resolve));
    const pending = fetch(`${base}${publicPath}`, { headers: { cookie: "pocket_locale=fr" } });

    pending.catch(() => {});

    try {
        await until(() => gates.requestLocaleEntered === 1, "the public handler is waiting", 5000);
        writeFileSync(file, original.replace("Menu français", "Menu modifié"));
        await app.reloadExtension("locale-pages.ts");
        release();
        const previous = await pending;

        assert.equal(previous.status, 200);
        assert.deepEqual(
            await previous.json(),
            { lang: "fr", text: "Menu français", own: true, frozen: true },
            "the held request retains its original catalog",
        );
        const current = await fetch(`${base}${publicPath}`, {
            headers: { cookie: "pocket_locale=fr" },
        });

        assert.equal(current.status, 200);
        assert.deepEqual(await current.json(), {
            lang: "fr",
            text: "Menu modifié",
            own: true,
            frozen: true,
        });
    } finally {
        release();
        await pending.catch(() => {});
        writeFileSync(file, original);
        await app.reloadExtension("locale-pages.ts");
    }
});
