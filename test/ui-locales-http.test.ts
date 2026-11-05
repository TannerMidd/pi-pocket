// Stage 2: the locale catalog uses a real temporary app and HTTP server, including each person's existing ACL.
import { type App, cleanUp, newSession, openApp, owner, root, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createHandler } from "../src/server/http.ts";
import { Auth } from "../src/server/auth.ts";
import type { ConversationId } from "@earendil-works/pi-durable";

const data = join(root, "locale-http");
const dropIns = join(data, "extensions");
const people: Record<string, string> = {};
let app: App;
let server: Server;
let base = "";
let session: ConversationId;
let auth: Auth;
const hostile = 'Ada "<img src=x onerror=alert(1)>';

before(async () => {
    mkdirSync(dropIns, { recursive: true });
    writeFileSync(
        join(dropIns, "synthetic-locale.ts"),
        `/** Public test language; the route is still restricted by its own access. */
export default (_host, web) => {
    web.uiLocales([{ id: "fr", label: "Français", messages: {
        "ui.close": "Fermer",
        "signin.switch-title": "Changer de compte ?",
        "signin.switch-page-title": "Changer de compte ? · Pi Pocket",
        "signin.switch-body": "Compte {current} vers {next}.",
        "signin.switch-as": "Continuer comme {name}",
        "signin.stay-as": "Rester comme {name}",
        "signin.link-expired-title": "Lien expiré",
        "signin.invite-expired-title": "Invitation expirée",
        "signin.invite-expired": "Demandez une nouvelle invitation.",
        "signin.invite-used": "Cette invitation est expirée ou utilisée.",
        "signin.owner-page-title": "Connexion propriétaire · Pi Pocket",
        "signin.owner-title": "Connexion propriétaire",
        "signin.owner-body": "Le propriétaire contrôle cet appareil.",
        "signin.owner-switch": "Compte {name} remplacé par le propriétaire.",
        "signin.owner-sign-in": "Connexion propriétaire",
        "signin.join-title": "Rejoindre Pi Pocket",
        "signin.join-body": "Vous pouvez {can}.",
        "signin.join-any": "toutes les sessions",
        "signin.join-one": "la session «{title}»",
        "signin.join-read": "lire {where} sans piloter Pi",
        "signin.join-steer": "lire et piloter {where}",
        "signin.name-label": "Votre nom",
        "signin.name-placeholder": "ex. Alex",
        "signin.join": "Rejoindre",
        "signin.share-page-title": "Partager avec Pi",
        "signin.share-title": "Ouvrir Pi Pocket",
        "signin.share-body": "Ouvrez Pi Pocket sur cet appareil.",
        "signin.share-open": "Ouvrir Pi Pocket"
    } }]);
    web.route("GET", "view", () => ({ marker: "module-view" }), { access: "view" });
};
`,
    );
    app = await openApp(scriptedModel(), data);
    session = await newSession(app);
    auth = new Auth(app.config);

    people.owner = app.config.ownerToken;
    people.guest = app.config.addUser("Guest", "guest").token;
    people.viewer = app.config.addUser("Viewer", "viewer").token;
    people.single = app.config.addUser("Single viewer", "viewer", [String(session)]).token;
    await app.setExtensionEnabled(owner(app), "synthetic-locale.ts", true);
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

async function request(path: string, who?: string, method = "GET"): Promise<Response> {
    return fetch(`${base}${path}`, {
        method,
        headers: {
            ...(who === undefined ? {} : { authorization: `Bearer ${people[who]}` }),
            "x-pocket": "1",
        },
    });
}

/** Send real requests with a per-request locale preference and no automatic redirect. */
function page(path: string, locale?: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);

    if (locale !== undefined) {
        headers.set(
            "cookie",
            [headers.get("cookie"), `pocket_locale=${encodeURIComponent(locale)}`]
                .filter(Boolean)
                .join("; "),
        );
    }

    return fetch(`${base}${path}`, { ...init, headers, redirect: "manual" });
}

const escape = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
const loginPath = (token: string, next = "/") =>
    `/login?token=${encodeURIComponent(token)}&next=${encodeURIComponent(next)}`;
const invite = (grant: Parameters<Auth["createInvite"]>[1]) =>
    auth.createInvite(owner(app), grant).code;

test("R23: the real catalog is public to every role without exposing private fields or changing module ACL", async () => {
    const results = await Promise.all(
        [undefined, "owner", "guest", "viewer", "single"].map(async (who) => {
            const response = await request("/ui-locales.json", who);

            assert.equal(response.status, 200, `catalog is public to ${who ?? "anonymous"}`);
            assert.match(response.headers.get("content-type") ?? "", /^application\/json\b/);
            assert.match(response.headers.get("cache-control") ?? "", /\bno-store\b/);

            return response.json() as Promise<{
                revision: number;
                locales: { id: string; label: string; messages: Record<string, string> }[];
            }>;
        }),
    );
    const catalog = results[0]!;

    assert.ok(Number.isInteger(catalog.revision));
    assert.deepEqual(Object.keys(catalog).sort(), ["locales", "revision"]);
    assert.deepEqual(
        catalog.locales.map((each) => each.id),
        ["en", "fr", "zh-CN"],
    );
    assert.equal(catalog.locales[1]?.messages["ui.close"], "Fermer");

    for (const each of catalog.locales) {
        assert.deepEqual(Object.keys(each).sort(), ["id", "label", "messages"]);
    }

    assert.ok(results.every((value) => JSON.stringify(value) === JSON.stringify(catalog)));
    const encoded = JSON.stringify(catalog);

    for (const token of Object.values(people)) {
        assert.ok(!encoded.includes(token), "catalog does not contain credentials");
    }

    assert.ok(!encoded.includes(data), "catalog does not contain the temporary data path");
    assert.equal((await request("/api/x/synthetic-locale/view", "owner")).status, 200);
    assert.equal((await request("/api/x/synthetic-locale/view", "guest")).status, 200);
    assert.equal((await request("/api/x/synthetic-locale/view", "viewer")).status, 200);
    assert.equal((await request("/api/x/synthetic-locale/view", "single")).status, 404);
    assert.equal((await request("/api/x/synthetic-locale/view")).status, 401);
});

test("the public app bridge and locale catalog coexist without opening other API routes", async () => {
    const [info, catalog, me, wrongMethod, wrongPath] = await Promise.all([
        request("/api/pocket/info"),
        request("/ui-locales.json"),
        request("/api/me"),
        request("/api/pocket/info", undefined, "POST"),
        request("/api/pocket/info/extra"),
    ]);

    assert.equal(info.status, 200);
    assert.deepEqual(await info.json(), { name: "pi-pocket", bridge: 1 });
    assert.equal(catalog.status, 200);
    assert.ok((await catalog.json()).locales.some((each: { id: string }) => each.id === "zh-CN"));
    assert.equal(me.status, 401);
    assert.equal(wrongMethod.status, 401);
    assert.equal(wrongPath.status, 401);
    assert.equal((await request("/ui-locales.json", undefined, "POST")).status, 405);
});

test("R25: the installed pack supplies the same text to the catalog and SSR, and removal falls back", async () => {
    const getCatalog = async () =>
        (await (await page("/ui-locales.json")).json()) as {
            locales: { id: string; messages: Record<string, string> }[];
        };
    const french = (await getCatalog()).locales.find((each) => each.id === "fr")!;
    const response = await page("/login?token=expired", "fr");
    const body = await response.text();

    assert.equal(response.status, 401);
    assert.match(body, /<html lang="fr">/);
    assert.ok(
        body.includes(escape(french.messages["signin.link-expired-title"]!)),
        "SSR uses the installed catalog wording",
    );

    try {
        await app.setExtensionEnabled(owner(app), "synthetic-locale.ts", false);
        assert.equal(
            (await getCatalog()).locales.some((each) => each.id === "fr"),
            false,
        );
        const fallback = await (await page("/login?token=expired", "fr")).text();

        assert.match(fallback, /<html lang="en">/);
        assert.match(fallback, /Link expired/);
    } finally {
        await app.setExtensionEnabled(owner(app), "synthetic-locale.ts", true);
    }
});

test("R26: concurrent login, join and share requests keep each cookie's language", async () => {
    const code = invite({ role: "viewer", session: String(session) });
    const paths = ["/login?token=expired", `/join/${code}`, "/share"];
    const expected = [
        { en: "Link expired", fr: "Lien expiré" },
        { en: "Join Pi Pocket", fr: "Rejoindre Pi Pocket" },
        { en: "Open Pi Pocket first", fr: "Ouvrir Pi Pocket" },
    ];
    const results = await Promise.all(
        Array.from({ length: 36 }, async (_, index) => {
            const at = index % paths.length;
            const locale: "fr" | "en" = index % 2 ? "fr" : "en";
            const response = await page(paths[at]!, locale, at === 2 ? { method: "POST" } : {});

            return { locale, at, status: response.status, body: await response.text() };
        }),
    );

    for (const result of results) {
        assert.equal(result.status, result.at === 0 ? 401 : 200);
        assert.match(result.body, new RegExp(`<html lang="${result.locale}">`));
        assert.ok(
            result.body.includes(expected[result.at]![result.locale]),
            `${result.locale} request has its own wording`,
        );
    }
});

test("R26: invalid, missing and unavailable cookies use English, with exact canonical matching", async () => {
    for (const locale of [undefined, "invalid_tag", "fr-CA", "de"]) {
        const body = await (await page("/login?token=expired", locale)).text();

        assert.match(body, /<html lang="en">/);
        assert.match(body, /Link expired/);
    }

    const french = await (await page("/login?token=expired", "FR")).text();

    assert.match(french, /<html lang="fr">/);
    assert.match(french, /Lien expiré/);
    const safeResponse = await page("/login?token=expired&noext=1", "fr");
    const safe = await safeResponse.text();

    assert.match(safe, /<html lang="en">/);
    assert.match(safe, /Link expired/);
    assert.equal(
        safeResponse.headers.get("set-cookie"),
        null,
        "safe SSR does not erase the preference",
    );
});

test("R26: one request keeps its captured catalog while a title lookup waits", async (t) => {
    const code = invite({ role: "viewer", session: String(session) });
    const originalTitle = app.conversationTitle.bind(app);
    const raw = app as unknown as { conversationTitle: (id: ConversationId) => Promise<string> };
    let started!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => (started = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));

    // Delay the real title lookup at its asynchronous boundary; the request, loader and snapshots stay real.
    t.after(() => {
        raw.conversationTitle = originalTitle;
    });

    raw.conversationTitle = async (id: ConversationId) => {
        started();
        await gate;

        return originalTitle(id);
    };

    const file = join(dropIns, "synthetic-locale.ts");
    const old = readFileSync(file, "utf8");
    const pending = page(`/join/${code}`, "fr");

    await entered;

    try {
        writeFileSync(
            file,
            old
                .replace("Rejoindre Pi Pocket", "Rejoindre version deux")
                .replace("Vous pouvez {can}.", "Version deux : {can}."),
        );
        await app.reloadExtension("synthetic-locale.ts");
        const intervening = await (await page("/login?token=expired", "fr")).text();

        assert.match(intervening, /Lien expiré/);
        release();
        const body = await (await pending).text();

        assert.ok(body.includes("Rejoindre Pi Pocket"), "the request retains its earlier snapshot");
        assert.ok(!body.includes("Rejoindre version deux"));
        assert.ok(body.includes("Vous pouvez"), "the body also retains its earlier snapshot");
        assert.ok(!body.includes("Version deux"));
        const after = await (await page(`/join/${code}`, "fr")).text();

        assert.ok(
            after.includes("Rejoindre version deux"),
            "a later request sees the new snapshot",
        );
    } finally {
        release();
        writeFileSync(file, old);
        await app.reloadExtension("synthetic-locale.ts");
    }
});

test("R27: translation text and attribute values are escaped, never parsed as HTML", async () => {
    const file = join(dropIns, "synthetic-locale.ts");
    const original = readFileSync(file, "utf8");
    const title = 'Changer "<img src=x onerror=alert(1)>';
    const placeholder = 'Nom "<img src=x onerror=alert(2)>';

    writeFileSync(
        file,
        original
            .replace(JSON.stringify("Changer de compte ?"), JSON.stringify(title))
            .replace(JSON.stringify("ex. Alex"), JSON.stringify(placeholder)),
    );

    try {
        await app.reloadExtension("synthetic-locale.ts");
        const current = app.config.addUser("Plain", "guest");
        const switched = await (
            await page(loginPath(people.owner!), "fr", {
                headers: { cookie: `pocket_auth=${current.token}` },
            })
        ).text();
        const code = invite({ role: "guest" });
        const joined = await (await page(`/join/${code}`, "fr")).text();

        assert.ok(switched.includes(escape(title)), "translation in the heading is escaped");
        assert.ok(
            joined.includes(`placeholder="${escape(placeholder)}"`),
            "translation in the placeholder attribute is escaped",
        );
        assert.ok(!switched.includes("<img") && !joined.includes("<img"));
    } finally {
        writeFileSync(file, original);
        await app.reloadExtension("synthetic-locale.ts");
    }
});

test("R27: switch-account names and session titles are escaped as text and attributes", async () => {
    const current = app.config.addUser(hostile, "guest");
    const next = app.config.addUser(`Bob "<img src=x onerror=alert(2)>`, "viewer");
    const response = await page(loginPath(next.token, "/s/1?x=1&y=2"), "fr", {
        headers: { cookie: `pocket_auth=${encodeURIComponent(current.token)}` },
    });
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.ok(body.includes(escape(hostile)));
    assert.ok(body.includes(escape(next.user.name)));
    assert.ok(!body.includes("<img"), "dynamic names never create markup");
    assert.match(body, /name="token"/);
    assert.match(body, /name="next"/);
    await app.commands.updateSession(session, owner(app), { title: hostile });
    const code = invite({ role: "viewer", session: String(session) });
    const joined = await (await page(`/join/${code}`, "fr")).text();

    assert.ok(joined.includes(escape(hostile)));
    assert.ok(!joined.includes("<img"), "the real session title never creates markup");
});

test("R28: authentication, invite and redirect branches are identical in English and French", async () => {
    const guest = app.config.addUser("Switch guest", "guest");
    const hidden = (body: string, name: string) =>
        new RegExp(`name="${name}" value="([^"]*)"`).exec(body)?.[1];

    for (const locale of ["en", "fr"]) {
        const switchResponse = await page(loginPath(people.owner!, "/safe?x=1&y=2"), locale, {
            headers: { cookie: `pocket_auth=${encodeURIComponent(guest.token)}` },
        });
        const switched = await switchResponse.text();

        assert.equal(switchResponse.status, 200);
        assert.equal(hidden(switched, "token"), escape(people.owner!));
        assert.equal(hidden(switched, "next"), escape("/safe?x=1&y=2"));
        const hostileNext = '/safe?value="<img src=x onerror=alert(4)>&x=1';
        const nextBody = await (
            await page(loginPath(people.owner!, hostileNext), locale, {
                headers: { cookie: `pocket_auth=${guest.token}` },
            })
        ).text();

        assert.equal(
            hidden(nextBody, "next"),
            escape(hostileNext),
            "the next attribute is escaped without changing its value",
        );
        assert.ok(!nextBody.includes("<img"));
        assert.ok(switched.includes(locale === "fr" ? "Changer de compte" : "Switch account"));
        const cross = await page("/login", locale, {
            method: "POST",
            headers: {
                "sec-fetch-site": "cross-site",
                "content-type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({ token: people.owner!, next: "/safe" }),
        });

        assert.equal(cross.status, 403);
        assert.equal(cross.headers.get("set-cookie"), null);

        for (const next of [
            "//attacker.example/path",
            "/\\attacker.example",
            "https://attacker.example",
        ]) {
            const response = await page("/login", locale, {
                method: "POST",
                headers: {
                    "sec-fetch-site": "same-origin",
                    "content-type": "application/x-www-form-urlencoded",
                },
                body: new URLSearchParams({ token: people.owner!, next }),
            });

            assert.equal(response.status, 303);
            assert.equal(response.headers.get("location"), "/");
            assert.match(response.headers.get("set-cookie") ?? "", /pocket_auth=/);
        }

        const expired = await page("/join/not-an-invite", locale);

        assert.equal(expired.status, 410);
        assert.ok(
            (await expired.text()).includes(
                locale === "fr" ? "Invitation expirée" : "Invite expired",
            ),
        );

        const expiredPost = await page("/join/not-an-invite", locale, {
            method: "POST",
            body: "name=Nobody",
        });

        assert.equal(expiredPost.status, 410);
        assert.equal(expiredPost.headers.get("set-cookie"), null);
        const invalidLogin = await page("/login", locale, {
            method: "POST",
            body: "token=expired&next=%2F",
        });

        assert.equal(invalidLogin.status, 401);
        assert.equal(invalidLogin.headers.get("set-cookie"), null);

        for (const role of ["owner", "viewer", "guest"] as const) {
            const code = invite(role === "owner" ? { role } : { role, session: String(session) });
            const preview = await page(`/join/${code}`, locale);
            const body = await preview.text();

            assert.equal(preview.status, 200);
            assert.ok(
                body.includes(
                    locale === "fr"
                        ? role === "owner"
                            ? "Connexion propriétaire"
                            : "Rejoindre Pi Pocket"
                        : role === "owner"
                          ? "Sign in as owner"
                          : "Join Pi Pocket",
                ),
            );

            if (role === "viewer") {
                assert.ok(body.includes(locale === "fr" ? "sans piloter Pi" : "but not steer Pi"));
            } else if (role === "guest") {
                assert.ok(body.includes(locale === "fr" ? "piloter" : "read and steer"));
            } else {
                const switchingOwner = await (
                    await page(`/join/${code}`, locale, {
                        headers: { cookie: `pocket_auth=${guest.token}` },
                    })
                ).text();

                assert.ok(
                    switchingOwner.includes(guest.user.name),
                    "the owner invite names the current account",
                );
            }

            const crossJoin = await page(`/join/${code}`, locale, {
                method: "POST",
                headers: { "sec-fetch-site": "cross-site" },
                body: "name=Denied",
            });

            assert.equal(crossJoin.status, 403);
            assert.notEqual(
                auth.invite(code),
                undefined,
                "a cross-site POST does not spend an invite",
            );
            const accepted = await page(`/join/${code}`, locale, {
                method: "POST",
                headers: {
                    "sec-fetch-site": "same-origin",
                    "content-type": "application/x-www-form-urlencoded",
                },
                body: "name=Accepted",
            });

            assert.equal(accepted.status, 303);
            assert.equal(accepted.headers.get("location"), "/");
            const used = await page(`/join/${code}`, locale);

            assert.equal(used.status, 410);
            assert.equal(auth.invite(code), undefined);
            const token = decodeURIComponent(
                /pocket_auth=([^;]+)/.exec(accepted.headers.get("set-cookie") ?? "")![1]!,
            );
            const user = app.config.userByToken(token);

            assert.equal(user?.role, role);
            assert.deepEqual(user?.sessions, role === "owner" ? undefined : [String(session)]);
        }
    }
});

test("R24: GET is read-only and other methods cannot change configuration or the catalog", async () => {
    const beforeConfig = readFileSync(join(data, "config.json"));
    const before = app.webs.locales.snapshot();
    const get = await request("/ui-locales.json");

    assert.equal(get.status, 200, "the catalog GET exists");
    assert.deepEqual(await get.json(), JSON.parse(JSON.stringify(before)));

    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        const response = await request("/ui-locales.json", "owner", method);

        assert.ok(response.status >= 400, `${method} is rejected`);
    }

    assert.deepEqual(readFileSync(join(data, "config.json")), beforeConfig);
    assert.deepEqual(app.webs.locales.snapshot(), before);
});
