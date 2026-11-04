// Stage 2 locale behavior in Chromium against a real temporary app and real extension modules.
import {
    type App,
    cleanUp,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";
import { Auth } from "../src/server/auth.ts";

const data = join(root, "locale-ui-data");
const dropIns = join(data, "extensions");
let app: App;
let server: Server;
let browsers: Browsers;
let base = "";
let session: ConversationId;
let nextPage = 0;

before(async () => {
    assert.ok(findBrowser(), "Chromium is required; locale UI tests never skip");
    mkdirSync(dropIns, { recursive: true });
    writeFileSync(
        join(dropIns, "a-locale.ts"),
        `/** Lower public language layer. */
export default (_host, web) => web.uiLocales([{ id: "fr", label: "Français", messages: {
    "ui.close": "Fermer", "ui.back": "Retour", "app.menu": "Menu français", "app.back-to-sessions": "Retour aux sessions", "app.files": "Fichiers",
    "menu.appearance": "Apparence", "appearance.title": "Apparence", "appearance.language": "Langue",
    "sessions.new": "Nouvelle session", "sessions.search": "Rechercher des sessions",
    "sessions.mark-read": "Marquer comme lu", "sessions.recent": "Récent", "sessions.selected": "Sélectionné", "sessions.not-read": "Non lu", "menu.mark-unread": "Marquer non lu",
    "slots.topbar": "Boutons du haut", "slots.places": "Emplacements",
    "signin.switch-title": "Changer de compte ?", "signin.switch-page-title": "Changer de compte ? · Pi Pocket",
    "signin.switch-body": "Compte {current} vers {next}.", "signin.switch-as": "Continuer comme {name}", "signin.stay-as": "Rester comme {name}",
    "signin.name-label": "Votre nom", "signin.name-placeholder": "ex. Alex", "signin.join-title": "Rejoindre Pi Pocket", "signin.join": "Rejoindre"
} }]);
`,
    );
    writeFileSync(
        join(dropIns, "z-locale.ts"),
        `/** Upper public language layer. */
export default (_host, web) => web.uiLocales([{ id: "fr", label: "Français supérieur", messages: {
    "app.menu": "Menu supérieur", "ui.close": "Fermer supérieur", "app.back-to-sessions": "Retour supérieur", "appearance.theme": "Thème supérieur", "appearance.colors": "Couleurs supérieures", "app.title": "Poche Pi"
} }]);
`,
    );
    app = await openApp(scriptedModel(), data);
    session = await newSession(app);
    await say(app, session, "Close");
    await app.setExtensionEnabled(owner(app), "a-locale.ts", true);
    await app.setExtensionEnabled(owner(app), "z-locale.ts", true);
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "locale-chromium-")),
        load: async () => undefined,
        save: () => {},
    });
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

async function pageScript<T>(page: BrowserPage, script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

async function see(
    page: BrowserPage,
    expression: string,
    what: string,
    timeout = 15000,
): Promise<void> {
    await until(
        () => pageScript<boolean>(page, `return JSON.stringify(Boolean(${expression}))`),
        what,
        timeout,
    );
}

async function openPage(
    viewport: "mobile" | "desktop",
    token = app.config.ownerToken,
): Promise<BrowserPage> {
    const page = await browsers.open(++nextPage);

    await page.setViewport(VIEWPORTS[viewport]);
    await page.navigate(`${base}/login?token=${encodeURIComponent(token)}`);
    await see(page, `(await import('/store.js')).store.state.me != null`, "a signed-in browser");
    await see(
        page,
        `document.querySelector('.session-row[data-id="${session}"]')`,
        "the real session row",
    );
    await page.evaluate(`(await import("/store.js")).navigate(${Number(session)})`);
    await see(
        page,
        `(await import("/store.js")).store.state.view.conversation?.id === ${Number(session)}`,
        "the real conversation view",
    );
    await see(
        page,
        `(await import("/store.js")).store.state.connection === "open"`,
        "the event stream",
    );
    await page.evaluate(`window.localePageMarker = { token: Math.random() }`);

    return page;
}

async function appearance(page: BrowserPage, installed = true): Promise<void> {
    await page.evaluate(`(await import('/store.js')).openSheet({ type: 'appearance' });`);
    await see(
        page,
        `(await import("/store.js")).store.state.sheet?.type === "appearance"`,
        "Appearance is open",
    );

    if (!installed) {
        return;
    }

    await until(
        () =>
            pageScript<boolean>(
                page,
                `return JSON.stringify([...document.querySelectorAll("select")].some((select) => [...select.options].some((option) => option.value === "fr")))`,
            ),
        "the installed French locale reaches Appearance",
        5000,
    ).catch(() => {});
    assert.ok(
        await pageScript<boolean>(
            page,
            `return JSON.stringify([...document.querySelectorAll("select")].some((select) => [...select.options].some((option) => option.value === "fr")))`,
        ),
        "the language selector offers the installed French locale",
    );
}

async function chooseFrench(page: BrowserPage): Promise<void> {
    if (
        !(await pageScript<boolean>(
            page,
            `return JSON.stringify((await import("/store.js")).store.state.sheet?.type === "appearance")`,
        ))
    ) {
        await appearance(page);
    }

    const index = await pageScript<number>(
        page,
        `return JSON.stringify([...document.querySelectorAll('select')].findIndex((select) => [...select.options].some((option) => option.value === 'fr')))`,
    );

    assert.ok(index >= 0, "the real selector offers the installed French locale");
    await page.evaluate(
        `const select = document.querySelectorAll('select')[${index}]; select.value = 'fr'; select.dispatchEvent(new Event('change', { bubbles: true }));`,
    );
    await see(page, `document.documentElement.lang === 'fr'`, "French selected");
    await see(
        page,
        `document.body.textContent.includes("Apparence")`,
        "the translated Appearance sheet redraws",
    );
}

for (const viewport of ["mobile", "desktop"] as const) {
    test(`R25: ${viewport} SSR and the browser use the same installed catalog and recover after disable`, async () => {
        const page = await openPage(viewport);
        const visitor = app.config.addUser(`SSR ${viewport}`, "guest");

        await chooseFrench(page);
        const response = await fetch(`${base}/ui-locales.json`);
        const catalog = (await response.json()) as {
            locales: { id: string; messages: Record<string, string> }[];
        };
        const message = catalog.locales.find((entry) => entry.id === "fr")!.messages[
            "signin.switch-title"
        ]!;

        await page.navigate(`${base}/login?token=${encodeURIComponent(visitor.token)}&next=%2F`);
        await see(
            page,
            `document.querySelector('main.plain h1')`,
            "the translated SSR switch-account page",
        );
        assert.equal(
            await pageScript<string>(page, `return JSON.stringify(document.documentElement.lang)`),
            "fr",
        );
        assert.equal(
            await pageScript<string>(
                page,
                `return JSON.stringify(document.querySelector('main.plain h1').textContent)`,
            ),
            message,
        );
        await page.evaluate(`document.querySelector('form button').click()`);
        await see(
            page,
            `(await import('/store.js')).store.state.me?.role === 'guest'`,
            "the signed-in guest reaches the main app",
        );
        assert.equal(
            await pageScript<string>(page, `return JSON.stringify(document.documentElement.lang)`),
            "fr",
            "SSR preference reaches the main app",
        );
        await appearance(page);
        assert.equal(
            await pageScript<string>(
                page,
                `return JSON.stringify(document.querySelector('[data-sheet=appearance] h2').textContent)`,
            ),
            "Apparence",
        );

        try {
            await app.setExtensionEnabled(owner(app), "a-locale.ts", false);
            await app.setExtensionEnabled(owner(app), "z-locale.ts", false);
            await see(
                page,
                `document.documentElement.lang === 'en'`,
                "the main app falls back after disable",
            );
            await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
            await see(
                page,
                `document.querySelector('main.plain h1')`,
                "the SSR switch-account page after disable",
            );
            assert.equal(
                await pageScript<string>(
                    page,
                    `return JSON.stringify(document.documentElement.lang)`,
                ),
                "en",
            );
            assert.equal(
                await pageScript<string>(
                    page,
                    `return JSON.stringify(document.querySelector('main.plain h1').textContent)`,
                ),
                "Switch account?",
            );
        } finally {
            await app.setExtensionEnabled(owner(app), "a-locale.ts", true);
            await app.setExtensionEnabled(owner(app), "z-locale.ts", true);
            page.close();
        }
    });
}

test("R27: real SSR translations and names render as literal text in Chromium", async () => {
    const file = join(dropIns, "a-locale.ts");
    const original = readFileSync(file, "utf8");
    const marker = 'Changer "<img src=x onerror=window.localeInjected=1>';
    const placeholder = 'Nom "<img src=x onerror=window.localeInjected=2>';
    const name = 'Guest "<img src=x onerror=window.localeInjected=3>';
    const page = await openPage("desktop");
    const visitor = app.config.addUser(name, "guest");

    try {
        await chooseFrench(page);
        writeFileSync(
            file,
            original
                .replace(JSON.stringify("Changer de compte ?"), JSON.stringify(marker))
                .replace(JSON.stringify("ex. Alex"), JSON.stringify(placeholder)),
        );
        await app.reloadExtension("a-locale.ts");
        await page.navigate(`${base}/login?token=${encodeURIComponent(visitor.token)}`);
        await see(
            page,
            `document.querySelector('main.plain h1')`,
            "the malicious switch text is rendered",
        );
        const switched = await pageScript<{
            heading: string;
            text: string;
            images: number;
            token: string;
            next: string;
        }>(
            page,
            `
            return JSON.stringify({ heading: document.querySelector('main.plain h1').textContent,
                text: document.querySelector('main.plain').textContent, images: document.querySelectorAll('main.plain img').length,
                token: document.querySelector('input[name=token]').value, next: document.querySelector('input[name=next]').value });
        `,
        );

        assert.equal(switched.heading, marker);
        assert.ok(switched.text.includes(name));
        assert.equal(switched.images, 0);
        assert.equal(
            await pageScript<boolean>(
                page,
                `return JSON.stringify(window.localeInjected === undefined)`,
            ),
            true,
            "no injected event ran",
        );
        assert.equal(switched.token, visitor.token);
        assert.equal(switched.next, "/");
        const code = new Auth(app.config).createInvite(owner(app), {
            role: "viewer",
            session: String(session),
        }).code;

        await app.commands.updateSession(session, owner(app), { title: name });
        await page.navigate(`${base}/join/${code}`);
        await see(
            page,
            `document.querySelector('main.plain input[name=name]')`,
            "the translated invite form",
        );
        const joined = await pageScript<{ placeholder: string; text: string; images: number }>(
            page,
            `
            return JSON.stringify({ placeholder: document.querySelector('input[name=name]').placeholder,
                text: document.querySelector('main.plain').textContent, images: document.querySelectorAll('main.plain img').length });
        `,
        );

        const catalog = (await (await fetch(`${base}/ui-locales.json`)).json()) as {
            locales: { id: string; messages: Record<string, string> }[];
        };
        const same = catalog.locales.find((item) => item.id === "fr")!.messages[
            "signin.name-placeholder"
        ];

        assert.equal(joined.placeholder, placeholder);
        assert.equal(
            joined.placeholder,
            same,
            "SSR and the public catalog share this translated attribute",
        );
        assert.ok(joined.text.includes(name));
        assert.equal(joined.images, 0);
        assert.equal(
            await pageScript<boolean>(
                page,
                `return JSON.stringify(window.localeInjected === undefined)`,
            ),
            true,
            "no injected event ran",
        );
        await page.navigate(`${base}/`);
        await see(
            page,
            `(await import("/store.js")).store.state.me?.role === "owner"`,
            "the main browser after SSR",
        );
        const browserWords = await pageScript<string>(
            page,
            `return JSON.stringify((await import("/ui-locale.js")).t("signin.name-placeholder", "e.g. Alex"))`,
        );

        assert.equal(
            browserWords,
            same,
            "the browser uses the same key and bytes as SSR and the catalog",
        );
    } finally {
        await app.commands.updateSession(session, owner(app), { title: "Close" });
        writeFileSync(file, original);
        await app.reloadExtension("a-locale.ts");
        page.close();
    }
});

test("R25: absent or blocked locale cookies leave SSR and the next main page in English", async () => {
    const page = await openPage("desktop");
    const guest = app.config.addUser("Cookie blocked guest", "guest");

    await appearance(page);
    await page.evaluate(`
        document.cookie = 'pocket_locale=; Max-Age=0; Path=/';
        const cookie = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
        Object.defineProperty(document, 'cookie', { configurable: true, get: () => cookie.get.call(document),
            set: () => { throw new DOMException('blocked', 'SecurityError'); } });
    `);
    await chooseFrench(page);
    assert.equal(
        await pageScript<string>(page, `return JSON.stringify(document.documentElement.lang)`),
        "fr",
    );
    await page.navigate(`${base}/login?token=${encodeURIComponent(guest.token)}`);
    await see(
        page,
        `document.querySelector('main.plain h1')`,
        "the SSR page without a saved cookie",
    );
    assert.equal(
        await pageScript<string>(page, `return JSON.stringify(document.documentElement.lang)`),
        "en",
    );
    assert.equal(
        await pageScript<string>(
            page,
            `return JSON.stringify(document.querySelector('main.plain h1').textContent)`,
        ),
        "Switch account?",
    );
    await page.evaluate(`document.querySelector('form button').click()`);
    await see(
        page,
        `(await import('/store.js')).store.state.me?.role === 'guest'`,
        "the new page opens after SSR",
    );
    assert.equal(
        await pageScript<string>(page, `return JSON.stringify(document.documentElement.lang)`),
        "en",
    );
});

test("R14: disabling and restoring real overlay modules updates every role and keeps each preference", async () => {
    const tokens = [
        app.config.ownerToken,
        app.config.addUser("Locale guest", "guest").token,
        app.config.addUser("Locale viewer", "viewer").token,
        app.config.addUser("Locale single", "viewer", [String(session)]).token,
    ];
    const pages = await Promise.all(tokens.map((token) => openPage("desktop", token)));

    await Promise.all(pages.map((page) => chooseFrench(page)));

    try {
        await app.setExtensionEnabled(owner(app), "z-locale.ts", false);

        for (const page of pages) {
            await until(
                () =>
                    pageScript<boolean>(
                        page,
                        `return JSON.stringify(!!document.querySelector('[aria-label="Retour aux sessions"]'))`,
                    ),
                "the lower layer reaches this role",
                4000,
            ).catch(() => {});
            assert.equal(
                await pageScript<boolean>(
                    page,
                    `return JSON.stringify(!!document.querySelector('[aria-label="Retour aux sessions"]'))`,
                ),
                true,
                "the lower layer reaches every role",
            );
        }

        await app.setExtensionEnabled(owner(app), "a-locale.ts", false);

        for (const page of pages) {
            await until(
                () =>
                    pageScript<boolean>(
                        page,
                        `return JSON.stringify(document.documentElement.lang === "en")`,
                    ),
                "the last provider is disabled",
                4000,
            ).catch(() => {});
            assert.equal(
                await pageScript<string>(
                    page,
                    `return JSON.stringify(document.documentElement.lang)`,
                ),
                "en",
                "every role falls back after the last provider is disabled",
            );
        }

        for (const page of pages) {
            assert.match(
                await pageScript<string>(page, `return JSON.stringify(document.cookie)`),
                /(?:^|; )pocket_locale=fr(?:;|$)/,
            );
        }

        await app.setExtensionEnabled(owner(app), "a-locale.ts", true);
        await Promise.all(
            pages.map((page) =>
                see(
                    page,
                    `document.documentElement.lang === 'fr' && document.querySelector('[aria-label="Retour aux sessions"]')`,
                    "the saved preference is restored",
                ),
            ),
        );
        await app.setExtensionEnabled(owner(app), "z-locale.ts", true);
        await Promise.all(
            pages.map((page) =>
                see(
                    page,
                    `document.querySelector('[aria-label="Retour supérieur"]')`,
                    "the upper layer is restored",
                ),
            ),
        );
    } finally {
        await app.setExtensionEnabled(owner(app), "a-locale.ts", true);
        await app.setExtensionEnabled(owner(app), "z-locale.ts", true);
        await Promise.all(pages.map((page) => page.close()));
    }
});

test("R15: missing, invalid and unavailable cookies fall back, and focus rereads a changed cookie", async () => {
    const page = await openPage("desktop");

    for (const cookie of [
        "pocket_locale=; Max-Age=0; Path=/",
        "pocket_locale=invalid_tag; Path=/",
        "pocket_locale=de; Path=/",
    ]) {
        await page.evaluate(`document.cookie = ${JSON.stringify(cookie)};`);
        await page.navigate(`${base}/s/${session}`);
        await see(
            page,
            `document.querySelector('.composer textarea')`,
            "the app after a cookie change",
        );
        assert.equal(
            await pageScript<string>(page, `return JSON.stringify(document.documentElement.lang)`),
            "en",
        );
    }

    await page.evaluate(
        `document.cookie = 'pocket_locale=fr; Path=/'; window.dispatchEvent(new Event('focus'));`,
    );
    await until(
        () =>
            pageScript<boolean>(
                page,
                `return JSON.stringify(document.documentElement.lang === "fr")`,
            ),
        "focus updates language",
        4000,
    ).catch(() => {});
    assert.equal(
        await pageScript<string>(page, `return JSON.stringify(document.documentElement.lang)`),
        "fr",
        "focus rereads the preferred language",
    );
    await page.evaluate(
        `document.cookie = 'pocket_locale=invalid_tag; Path=/'; window.dispatchEvent(new Event('focus'));`,
    );
    await see(page, `document.documentElement.lang === 'en'`, "focus rejects the invalid language");
});

test("R15: a blocked cookie write keeps the current page usable but not the next page", async () => {
    const page = await openPage("desktop");

    await appearance(page);
    await page.evaluate(`
        document.cookie = 'pocket_locale=; Max-Age=0; Path=/';
        const cookie = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
        Object.defineProperty(document, 'cookie', { configurable: true, get: () => cookie.get.call(document),
            set: () => { throw new DOMException('blocked', 'SecurityError'); } });
    `);
    await chooseFrench(page);
    assert.equal(
        await pageScript<string>(page, `return JSON.stringify(document.documentElement.lang)`),
        "fr",
    );
    assert.doesNotMatch(
        await pageScript<string>(page, `return JSON.stringify(document.cookie)`),
        /pocket_locale=fr/,
    );
    await page.navigate(`${base}/s/${session}`);
    await see(page, `document.querySelector('.composer textarea')`, "the next page");
    await see(
        page,
        `(await import("/store.js")).store.state.connection === "open"`,
        "the next page connection",
    );
    assert.equal(
        await pageScript<string>(page, `return JSON.stringify(document.documentElement.lang)`),
        "en",
    );
});

test("R20: safe mode uses English without erasing the preferred language", async () => {
    const page = await openPage("desktop");

    await chooseFrench(page);
    await page.navigate(`${base}/s/${session}?noext=1`);
    await see(page, `document.querySelector('.composer textarea')`, "safe mode page");
    assert.equal(
        await pageScript<string>(page, `return JSON.stringify(document.documentElement.lang)`),
        "en",
    );
    assert.match(
        await pageScript<string>(page, `return JSON.stringify(document.cookie)`),
        /pocket_locale=fr/,
    );
    await page.evaluate(`(await import('/safe-mode.js')).leaveSafeMode();`);
    await see(
        page,
        `document.documentElement.lang === 'fr'`,
        "French returns after leaving safe mode",
    );
});

test("R13: an older held real catalog response cannot replace a newer module update", async () => {
    const page = await openPage("desktop");

    await chooseFrench(page);
    await page.evaluate(`
        const fetchReal = window.fetch;
        window.localeGate = { started: false, release: null };
        window.fetch = async (input, init) => {
            const response = await fetchReal(input, init);
            if (String(input).includes('/ui-locales.json') && !window.localeGate.started) {
                window.localeGate.started = true;
                await new Promise((resolve) => window.localeGate.release = resolve);
            }
            return response;
        };
        (await import('/store.js')).connect();
    `);
    await see(
        page,
        `window.localeGate.started && window.localeGate.release`,
        "the first catalog response is held",
    );

    try {
        await app.setExtensionEnabled(owner(app), "z-locale.ts", false);
        await see(
            page,
            `document.querySelector('[aria-label="Retour aux sessions"]')`,
            "the newer catalog is shown",
        );
        await page.evaluate(`window.localeGate.release()`);
        await new Promise((resolve) => setTimeout(resolve, 300));
        assert.equal(
            await pageScript<string>(
                page,
                `return JSON.stringify(document.querySelector('.topbar-back')?.getAttribute('aria-label'))`,
            ),
            "Retour aux sessions",
        );
    } finally {
        await page.evaluate(`window.localeGate.release?.()`);
        await app.setExtensionEnabled(owner(app), "z-locale.ts", true);
    }
});

test("R13: reconnect rereads the catalog when its numeric revision is unchanged", async () => {
    const page = await openPage("desktop");

    await chooseFrench(page);
    await page.evaluate(`
        const fetchReal = window.fetch;
        window.localeFetches = 0;
        window.fetch = (input, init) => {
            if (String(input).includes('/ui-locales.json')) window.localeFetches++;
            return fetchReal(input, init);
        };
        window.localeRevisionBefore = (await import('/store.js')).store.state.server.localeRevision;
        (await import('/store.js')).connect();
    `);
    await see(page, `window.localeFetches > 0`, "a reconnect fetches the actual catalog");
    assert.equal(
        await pageScript<number>(
            page,
            `return JSON.stringify((await import('/store.js')).store.state.server.localeRevision)`,
        ),
        await pageScript<number>(page, `return JSON.stringify(window.localeRevisionBefore)`),
    );
    assert.equal(
        await pageScript<string>(page, `return JSON.stringify(document.documentElement.lang)`),
        "fr",
    );
});

test("R13: reconnect redraws changed server words even when the numeric revision repeats", async () => {
    const page = await openPage("desktop");

    await chooseFrench(page);
    assert.ok(
        await pageScript<boolean>(
            page,
            `return JSON.stringify(!!document.querySelector('[aria-label="Retour supérieur"]'))`,
        ),
    );
    await see(
        page,
        `document.querySelector("[data-sheet=appearance]")?.textContent.includes("Thème supérieur")`,
        "the open Appearance sheet has the original wording",
    );
    await page.evaluate(
        `window.localeRestartSheet = document.querySelector("[data-sheet=appearance]"); window.localeRestartObserver = new MutationObserver(() => { window.localeIntermediate = document.querySelector("[data-sheet=appearance]")?.textContent.includes("Thème redémarré") && !document.querySelector("[data-sheet=appearance]")?.textContent.includes("Couleurs redémarrées"); if (!window.localeIntermediate) return; window.localeSawPartial = true; }); window.localeRestartObserver.observe(window.localeRestartSheet, { subtree: true, childList: true, characterData: true });`,
    );
    const initialRevision = await pageScript<number>(
        page,
        `return JSON.stringify((await import('/store.js')).store.state.server.localeRevision)`,
    );
    const file = join(dropIns, "z-locale.ts");
    const oldSource = readFileSync(file, "utf8");
    const secondData = join(root, "locale-restart-data");
    const secondExtensions = join(secondData, "extensions");

    mkdirSync(secondExtensions, { recursive: true });
    writeFileSync(
        join(secondExtensions, "a-locale.ts"),
        readFileSync(join(dropIns, "a-locale.ts")),
    );
    writeFileSync(
        join(secondExtensions, "z-locale.ts"),
        oldSource
            .replace("Retour supérieur", "Retour redémarré")
            .replace("Thème supérieur", "Thème redémarré")
            .replace("Couleurs supérieures", "Couleurs redémarrées"),
    );
    writeFileSync(join(secondData, "config.json"), readFileSync(join(data, "config.json")));
    const secondApp = await openApp(scriptedModel(), secondData);
    const secondServer = createServer(
        createHandler({
            app: secondApp,
            listen: { host: "127.0.0.1", port: 0 },
            restart: () => {},
        }),
    );

    try {
        while (secondApp.webs.locales.revision < initialRevision) {
            await secondApp.reloadExtension("z-locale.ts");
        }

        assert.equal(
            secondApp.webs.locales.revision,
            initialRevision,
            "the restarted process uses the same numeric revision",
        );
        await new Promise<void>((resolve) => secondServer.listen(0, "127.0.0.1", resolve));
        const secondBase = `http://127.0.0.1:${(secondServer.address() as { port: number }).port}`;

        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
        );
        const proxy = createServer((request, response) => {
            const target = new URL(request.url ?? "/", secondBase);
            const headers = { ...request.headers, host: target.host };
            const upstream = httpRequest(target, { method: request.method, headers }, (reply) => {
                response.writeHead(reply.statusCode ?? 500, reply.headers);
                reply.pipe(response);
            });

            upstream.on("error", () => {
                if (!response.headersSent) {
                    response.writeHead(502);
                }

                response.end();
            });
            request.pipe(upstream);
        });
        const port = Number(new URL(base).port);

        server = proxy;
        await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
        await page.evaluate(
            `window.restartedFetch = false; const previousFetch = window.fetch; window.fetch = (...args) => { if (String(args[0]).includes("/ui-locales.json")) window.restartedFetch = true; return previousFetch(...args); }; (await import('/store.js')).connect()`,
        );
        await see(page, `window.restartedFetch`, "the restarted process catalog is requested");
        await see(
            page,
            `document.querySelector('[aria-label="Retour redémarré"]')`,
            "the same revision with new words redraws the live DOM",
        );
        await until(
            () =>
                pageScript<boolean>(
                    page,
                    `return JSON.stringify(document.querySelector("[data-sheet=appearance]")?.textContent.includes("Thème redémarré"))`,
                ),
            "the reconnected sheet redraw",
            4000,
        ).catch(() => {});
        assert.equal(
            await pageScript<boolean>(
                page,
                `return JSON.stringify(document.querySelector("[data-sheet=appearance]")?.textContent.includes("Thème redémarré"))`,
            ),
            true,
            "the existing Appearance sheet redraws the changed words",
        );
        assert.equal(
            await pageScript<boolean>(
                page,
                `return JSON.stringify(document.querySelector("[data-sheet=appearance]") === window.localeRestartSheet)`,
            ),
            true,
            "the sheet is not remounted",
        );
        assert.equal(
            await pageScript<boolean>(
                page,
                `return JSON.stringify(document.querySelector("[data-sheet=appearance]")?.textContent.includes("Couleurs redémarrées"))`,
            ),
            true,
            "all changed labels redraw",
        );
        assert.equal(
            await pageScript<boolean>(
                page,
                `return JSON.stringify(window.localeSawPartial === true)`,
            ),
            false,
            "no mixed catalog is drawn",
        );
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        secondServer.closeAllConnections();
        await new Promise<void>((resolve) => secondServer.close(() => resolve()));
        await secondApp.close();
        server = createServer(
            createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
        );
        await new Promise<void>((resolve) =>
            server.listen(Number(new URL(base).port), "127.0.0.1", resolve),
        );
    }
});

test("R13: same-revision catalog bytes redraw without any later unrelated store update", async () => {
    const page = await openPage("desktop");

    await chooseFrench(page);
    await see(
        page,
        `document.querySelector("[data-sheet=appearance]")?.textContent.includes("Thème supérieur")`,
        "the original catalog is displayed",
    );
    const revision = await pageScript<number>(
        page,
        `return JSON.stringify((await import('/store.js')).store.state.server.localeRevision)`,
    );
    const secondData = join(root, "locale-isolated-redraw");
    const secondExtensions = join(secondData, "extensions");

    mkdirSync(secondExtensions, { recursive: true });
    writeFileSync(
        join(secondExtensions, "a-locale.ts"),
        readFileSync(join(dropIns, "a-locale.ts")),
    );
    const changed = readFileSync(join(dropIns, "z-locale.ts"), "utf8")
        .replace("Thème supérieur", "Thème isolé")
        .replace("Couleurs supérieures", "Couleurs isolées");

    writeFileSync(join(secondExtensions, "z-locale.ts"), changed);
    const secondApp = await openApp(scriptedModel(), secondData);
    const secondServer = createServer(
        createHandler({
            app: secondApp,
            listen: { host: "127.0.0.1", port: 0 },
            restart: () => {},
        }),
    );

    try {
        await secondApp.setExtensionEnabled(owner(secondApp), "a-locale.ts", true);
        await secondApp.setExtensionEnabled(owner(secondApp), "z-locale.ts", true);

        while (secondApp.webs.locales.revision < revision) {
            await secondApp.reloadExtension("z-locale.ts");
        }

        assert.equal(
            secondApp.webs.locales.revision,
            revision,
            "the second real app has the same numeric revision",
        );
        await new Promise<void>((resolve) => secondServer.listen(0, "127.0.0.1", resolve));
        const secondBase = `http://127.0.0.1:${(secondServer.address() as { port: number }).port}`;
        const response = await fetch(`${secondBase}/ui-locales.json`);
        const raw = await response.text();
        const second = JSON.parse(raw) as {
            revision: number;
            locales: { id: string; messages: Record<string, string> }[];
        };
        const original = (await (await fetch(`${base}/ui-locales.json`)).json()) as {
            revision: number;
            locales: { id: string; messages: Record<string, string> }[];
        };

        assert.equal(response.status, 200);
        assert.equal(second.revision, revision);
        assert.equal(original.revision, revision);
        assert.equal(
            original.locales.find((each) => each.id === "fr")?.messages["appearance.theme"],
            "Thème supérieur",
        );
        assert.equal(
            second.locales.find((each) => each.id === "fr")?.messages["appearance.theme"],
            "Thème isolé",
        );
        await page.evaluate(`
            const originalFetch = window.fetch;
            const raw = ${JSON.stringify(raw)};
            const stopTransport = (await import('/store.js')).connect;
            // Leave the real page and catalog intact; hold only its next HTTP response until the event stream settles.
            window.isolatedCatalog = { requested: false, release: null };
            window.fetch = (input, init) => {
                if (!String(input).includes('/ui-locales.json')) return originalFetch(input, init);
                window.isolatedCatalog.requested = true;
                return new Promise((resolve) => window.isolatedCatalog.release = () => resolve(new Response(raw, { status: 200, headers: { 'content-type': 'application/json' } })));
            };
            stopTransport();
        `);
        await see(
            page,
            `window.isolatedCatalog.requested && window.isolatedCatalog.release`,
            "the reconnect has requested a catalog",
        );
        await see(
            page,
            `(await import('/store.js')).store.state.connection === 'open'`,
            "the reconnect has settled",
        );
        await new Promise((resolve) => setTimeout(resolve, 250));
        const before = await pageScript<{ revision: number; sheet: string; lang: string }>(
            page,
            `
            const store = (await import('/store.js')).store;
            window.isolatedStoreChanges = [];
            window.stopIsolatedChanges = store.subscribe((state) => window.isolatedStoreChanges.push(state.localeRevision));
            window.isolatedSheet = document.querySelector('[data-sheet=appearance]');
            return JSON.stringify({ revision: store.state.localeRevision, sheet: window.isolatedSheet.textContent, lang: document.documentElement.lang });
        `,
        );

        assert.equal(before.lang, "fr");
        assert.ok(before.sheet.includes("Thème supérieur"));
        await page.evaluate(`window.isolatedCatalog.release()`);
        await until(
            () =>
                pageScript<boolean>(
                    page,
                    `return JSON.stringify(document.querySelector('[data-sheet=appearance]')?.textContent.includes('Thème isolé'))`,
                ),
            "the changed catalog redraws without a later event",
            4000,
        ).catch(() => {});
        const after = await pageScript<{
            changed: boolean;
            sameSheet: boolean;
            draw: number;
            changes: number[];
            lang: string;
        }>(
            page,
            `
            const store = (await import('/store.js')).store;
            window.stopIsolatedChanges();
            return JSON.stringify({ changed: document.querySelector('[data-sheet=appearance]')?.textContent.includes('Thème isolé') && document.querySelector('[data-sheet=appearance]')?.textContent.includes('Couleurs isolées'),
                sameSheet: document.querySelector('[data-sheet=appearance]') === window.isolatedSheet,
                draw: store.state.localeRevision, changes: window.isolatedStoreChanges, lang: document.documentElement.lang });
        `,
        );

        assert.equal(after.changed, true, "the unchanged-revision catalog updates the live sheet");
        assert.equal(after.sameSheet, true, "the existing sheet stays mounted");
        assert.equal(after.lang, "fr");
        assert.equal(
            after.draw,
            before.revision + 1,
            "one accepted catalog response causes one locale invalidation",
        );
        assert.deepEqual(
            after.changes,
            [before.revision + 1],
            "no unrelated store update causes the redraw",
        );
    } finally {
        secondServer.closeAllConnections();
        await new Promise<void>((resolve) => secondServer.close(() => resolve()));
        await secondApp.close();
        page.close();
    }
});

test("R13: an initial held catalog cannot publish after an old-server hello", async () => {
    const page = await browsers.open(++nextPage);

    await page.setViewport(VIEWPORTS.desktop);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await see(
        page,
        `(await import('/store.js')).store.state.me?.role === 'owner'`,
        "signed in before the race",
    );
    await page.evaluate(`document.cookie = 'pocket_locale=fr; Path=/'`);
    await page.navigate(`${base}/s/${session}?noext=1`);
    await see(
        page,
        `(await import('/store.js')).store.state.view.conversation?.id === ${Number(session)}`,
        "safe mode opened before the race",
    );
    await page.evaluate(`
        const fetchReal = window.fetch;
        const Native = window.EventSource;
        window.pendingLocale = [];
        window.fetch = async (input, init) => {
            const response = await fetchReal(input, init);
            if (String(input).includes('/ui-locales.json')) await new Promise((resolve) => window.pendingLocale.push(resolve));
            return response;
        };
        window.EventSource = class extends Native {
            addEventListener(type, listener, options) {
                if (type !== 'hello') return super.addEventListener(type, listener, options);
                return super.addEventListener(type, (event) => {
                    const data = JSON.parse(event.data);
                    delete data.server.localeRevision;
                    window.oldHelloSeen = true;
                    listener(new MessageEvent('hello', { data: JSON.stringify(data) }));
                }, options);
            }
        };
        (await import('/safe-mode.js')).leaveSafeMode();
    `);
    await see(page, `window.pendingLocale.length > 0`, "the first real response is held");
    await page.evaluate(`(await import('/store.js')).connect()`);
    await see(page, `window.oldHelloSeen`, "an old-server hello arrives before the response");
    await page.evaluate(`for (const release of window.pendingLocale) release()`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(
        await pageScript<string>(page, `return JSON.stringify(document.documentElement.lang)`),
        "en",
        "the stale initial response cannot restore French",
    );
    assert.equal(
        await pageScript<boolean>(
            page,
            `return JSON.stringify([...document.querySelectorAll('select')].some((select) => [...select.options].some((option) => option.value === 'fr')))`,
        ),
        false,
    );
});

test("R13: an old-server hello without a locale revision restores English", async () => {
    const page = await openPage("desktop");

    await chooseFrench(page);
    await page.evaluate(`
        const Native = window.EventSource;
        window.EventSource = class extends Native {
            addEventListener(type, listener, options) {
                if (type !== 'hello') return super.addEventListener(type, listener, options);
                return super.addEventListener(type, (event) => {
                    const data = JSON.parse(event.data);
                    delete data.server.localeRevision;
                    listener(new MessageEvent('hello', { data: JSON.stringify(data) }));
                }, options);
            }
        };
        (await import('/store.js')).connect();
    `);
    await see(
        page,
        `document.documentElement.lang === 'en'`,
        "the old-server hello restores English",
    );
    assert.equal(
        await pageScript<boolean>(
            page,
            `return JSON.stringify([...document.querySelectorAll('select')].some((select) => [...select.options].some((option) => option.value === 'fr')))`,
        ),
        false,
        "an old server offers no locale selector",
    );
});

for (const status of [404, 503]) {
    test(`R13: catalog HTTP ${status} restores English and hides the selector`, async () => {
        const page = await openPage("desktop");

        await chooseFrench(page);
        await page.evaluate(`
            const fetchReal = window.fetch;
            window.fetch = (input, init) => String(input).includes('/ui-locales.json')
                ? Promise.resolve(new Response('', { status: ${status} })) : fetchReal(input, init);
            (await import('/store.js')).connect();
        `);
        await until(
            () =>
                pageScript<boolean>(
                    page,
                    `return JSON.stringify(document.documentElement.lang === "en")`,
                ),
            `HTTP ${status} fallback`,
            4000,
        ).catch(() => {});
        assert.equal(
            await pageScript<string>(page, `return JSON.stringify(document.documentElement.lang)`),
            "en",
            `HTTP ${status} restores English`,
        );
        assert.equal(
            await pageScript<boolean>(
                page,
                `return JSON.stringify([...document.querySelectorAll('select')].some((select) => [...select.options].some((option) => option.value === 'fr')))`,
            ),
            false,
            "the failed catalog hides the selector",
        );
    });
}

test("R13: a failed catalog request restores English and hides the language selector", async () => {
    const page = await openPage("desktop");

    await chooseFrench(page);
    await page.evaluate(`
        const fetchReal = window.fetch;
        window.fetch = (input, init) => String(input).includes('/ui-locales.json') ? Promise.reject(new TypeError('offline')) : fetchReal(input, init);
        (await import('/store.js')).connect();
    `);
    await see(
        page,
        `document.documentElement.lang === 'en'`,
        "English after the actual catalog request fails",
    );
    assert.equal(
        await pageScript<boolean>(
            page,
            `return JSON.stringify([...document.querySelectorAll('select')].some((select) => [...select.options].some((option) => option.value === 'fr')))`,
        ),
        false,
        "unavailable languages are not offered",
    );
});

test("R19: default English remains intact before a positive French switch", async () => {
    const page = await openPage("desktop");

    await appearance(page);
    assert.equal(
        await pageScript<string>(
            page,
            `return JSON.stringify(document.querySelector("[data-sheet=appearance] .sheet-head h2")?.textContent.trim())`,
        ),
        "Appearance",
        "the default Appearance title is English",
    );
    await chooseFrench(page);
    assert.ok(
        await pageScript<boolean>(
            page,
            `return JSON.stringify(document.querySelector('[data-sheet=appearance]')?.textContent.includes('Apparence'))`,
        ),
        "the same sheet changes to French",
    );
});

test("R19: the fixed part of the document title changes without translating the user's title", async () => {
    const page = await openPage("desktop");

    assert.equal(
        await pageScript<string>(page, `return JSON.stringify(document.title)`),
        "Close · Pi Pocket",
    );
    await chooseFrench(page);
    assert.equal(
        await pageScript<string>(page, `return JSON.stringify(document.title)`),
        "Close · Poche Pi",
    );
});

test("R22: user titles, drafts and messages stay literal after the fixed UI changes language", async () => {
    const page = await openPage("desktop");

    await page.evaluate(`
        const box = document.querySelector('.composer textarea');
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, 'Close');
        box.dispatchEvent(new Event('input', { bubbles: true }));
    `);
    await chooseFrench(page);
    assert.equal(
        await pageScript<string>(
            page,
            `return JSON.stringify(document.querySelector('.composer textarea').value)`,
        ),
        "Close",
    );
    assert.ok(
        await pageScript<boolean>(
            page,
            `return JSON.stringify(document.title.startsWith('Close · '))`,
        ),
        "the user title remains literal",
    );
    assert.ok(
        await pageScript<boolean>(
            page,
            `return JSON.stringify(document.body.textContent.includes('Close'))`,
        ),
        "the sent user text remains literal",
    );
    assert.ok(
        await pageScript<boolean>(
            page,
            `return JSON.stringify(document.body.textContent.includes('Apparence'))`,
        ),
        "the fixed interface did change language",
    );
});

test("R19: session-list fixed placeholder and ARIA change with the chosen language", async () => {
    const page = await openPage("desktop");

    const before = await pageScript<{ placeholder: string; label: string }>(
        page,
        `
        const input = document.querySelector('input[aria-label="Search sessions"]');
        return JSON.stringify({ placeholder: input?.placeholder, label: input?.getAttribute('aria-label') });
    `,
    );

    assert.deepEqual(before, { placeholder: "Search sessions", label: "Search sessions" });
    await chooseFrench(page);
    const after = await pageScript<{ placeholder: string; label: string }>(
        page,
        `
        const input = document.querySelector('input[aria-label="Rechercher des sessions"]');
        return JSON.stringify({ placeholder: input?.placeholder, label: input?.getAttribute('aria-label') });
    `,
    );

    assert.deepEqual(after, {
        placeholder: "Rechercher des sessions",
        label: "Rechercher des sessions",
    });
});

test("R21: the mobile language selector is keyboard accessible and has no horizontal overflow", async () => {
    const page = await openPage("mobile");

    await appearance(page);
    const selector = await pageScript<{
        label: string;
        disabled: boolean;
        focus: boolean;
        overflow: boolean;
    }>(
        page,
        `
        const select = [...document.querySelectorAll('select')].find((each) => [...each.options].some((option) => option.value === 'fr'));
        select.focus();
        return JSON.stringify({ label: select.getAttribute('aria-label') || select.labels?.[0]?.textContent?.trim() || '',
            disabled: select.disabled, focus: document.activeElement === select,
            overflow: document.documentElement.scrollWidth > innerWidth });
    `,
    );

    assert.ok(selector.label, "the selector has an accessible name");
    assert.equal(selector.disabled, false);
    assert.equal(selector.focus, true);
    assert.equal(selector.overflow, false);
    await page.press("End");
    await see(page, `document.documentElement.lang === 'fr'`, "keyboard selects French");
    assert.equal(
        await pageScript<boolean>(
            page,
            `return JSON.stringify(document.documentElement.scrollWidth <= innerWidth)`,
        ),
        true,
        "French does not overflow on mobile",
    );
    await page.press("Home");
    await see(page, `document.documentElement.lang === 'en'`, "keyboard selects English");
});

test("R11 and R22: switching preserves a live draft, attachment, selection, history, and user text", async () => {
    const page = await openPage("mobile");

    await see(page, `document.body.textContent.includes("Close")`, "the user's real message");
    await page.evaluate(`
        const input = document.querySelector('.composer input[type=file]');
        const files = new DataTransfer();
        files.items.add(new File(['fixture bytes'], 'locale-draft.txt', { type: 'text/plain' }));
        input.files = files.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
    `);
    await see(
        page,
        `document.querySelector('.composer .chip-name[title="locale-draft.txt"]') && !document.querySelector('.composer .files .spinner')`,
        "the real attachment upload",
    );
    await appearance(page);
    await page.evaluate(`
        const box = document.querySelector('.composer textarea');
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        setter.call(box, 'Close draft stays');
        box.dispatchEvent(new Event('input', { bubbles: true }));
        box.focus();
        box.setSelectionRange(2, 8);
        window.localeBefore = { box, marker: {}, path: location.pathname, layers: history.state?.pocket?.layers,
            length: history.length, sheet: (await import('/store.js')).store.state.sheet?.type };
    `);
    await chooseFrench(page);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(
        await pageScript<boolean>(page, `return JSON.stringify(!!window.localeBefore)`),
        true,
        "the app page instance is not reloaded",
    );
    const state = await pageScript<{
        sameNode: boolean;
        marker: boolean;
        draft: string;
        focus: boolean;
        start: number;
        end: number;
        attached: boolean;
        path: string;
        layers: number;
        length: number;
        sheet: string;
        title: string;
        userText: boolean;
    }>(
        page,
        `
        const box = document.querySelector('.composer textarea');
        return JSON.stringify({ sameNode: box === window.localeBefore.box, marker: !!window.localeBefore.marker,
            draft: box.value, focus: document.activeElement === box, start: box.selectionStart, end: box.selectionEnd,
            attached: !!document.querySelector('.composer .chip-name[title="locale-draft.txt"]'),
            path: location.pathname, layers: history.state?.pocket?.layers, length: history.length,
            sheet: (await import('/store.js')).store.state.sheet?.type, title: document.title,
            userText: document.body.textContent.includes('Close') });
    `,
    );

    assert.equal(state.sameNode, true, "switching keeps the same textarea node");
    assert.equal(state.marker, true, "switching does not reload the page");
    assert.equal(state.draft, "Close draft stays");
    assert.equal(state.focus, true);
    assert.deepEqual([state.start, state.end], [2, 8]);
    assert.equal(state.attached, true, "the unsent attachment remains");
    assert.equal(state.path, `/s/${session}`);
    assert.equal(state.sheet, "appearance");
    assert.equal(
        state.layers,
        await pageScript<number>(page, `return JSON.stringify(window.localeBefore.layers)`),
    );
    assert.equal(
        state.length,
        await pageScript<number>(page, `return JSON.stringify(window.localeBefore.length)`),
    );
    assert.ok(state.title.startsWith("Close · "), "the user-generated title is not translated");
    assert.equal(state.userText, true, "user-authored English remains unchanged");
});

test("R12: memoized session rows and slot labels redraw without session data changes", async () => {
    const page = await openPage("desktop");

    await see(
        page,
        `document.querySelector('.session-row[data-id="${session}"]')`,
        "the memoized session row",
    );
    await page.evaluate(`(await import("/store.js")).setUnread(${Number(session)}, true)`);
    await see(
        page,
        `document.querySelector('.session-row[data-id="${session}"] .state-mark[aria-label="Not read"]')`,
        "the marked row",
    );
    await appearance(page);
    assert.ok(
        await pageScript<boolean>(
            page,
            `return JSON.stringify(document.body.textContent.includes('Top bar buttons'))`,
        ),
        "the initial slot label is English",
    );
    await page.evaluate(`
        const { store } = await import('/store.js');
        window.memoBefore = { session: store.state.sessions.find((item) => item.id === ${Number(session)}),
            row: document.querySelector('.session-row[data-id="${session}"]'),
            marked: document.querySelector('.session-row[data-id="${session}"] .state-mark')?.getAttribute("aria-label") };
    `);
    await chooseFrench(page);
    const result = await pageScript<{
        sameSession: boolean;
        sameRow: boolean;
        rowMark: string;
        slots: boolean;
        itemLabel: boolean;
        placesItemLabel: boolean;
    }>(
        page,
        `
        const { store } = await import('/store.js');
        return JSON.stringify({ sameSession: window.memoBefore.session === store.state.sessions.find((item) => item.id === ${Number(session)}),
            sameRow: window.memoBefore.row === document.querySelector('.session-row[data-id="${session}"]'),
            rowMark: document.querySelector('.session-row[data-id="${session}"] .state-mark')?.getAttribute("aria-label"),
            slots: document.body.textContent.includes('Boutons du haut'),
            itemLabel: document.querySelector('.slot-layout[data-slot="topbar"]')?.textContent.includes("Fichiers"),
            placesItemLabel: document.querySelector('.slot-layout[data-slot="places"]')?.textContent.includes("Fichiers") });
    `,
    );

    assert.equal(result.sameSession, true, "no session update triggers the redraw");
    assert.equal(result.sameRow, true, "the session row is not rebuilt");
    assert.equal(
        await pageScript<string>(page, `return JSON.stringify(window.memoBefore.marked)`),
        "Not read",
    );
    assert.equal(result.rowMark, "Non lu", "the memoized row accessible label redraws");
    assert.equal(result.slots, true, "the cached slot label redraws");
    assert.equal(
        result.itemLabel,
        true,
        "the core Files item label redraws inside Appearance layout",
    );
    assert.equal(
        result.placesItemLabel,
        true,
        "the Places Files item label redraws inside Appearance layout",
    );
});

test("R12: a real Places tile changes its visible and accessible Files label", async () => {
    const page = await openPage("desktop");

    await page.evaluate(`(await import('/store.js')).openSheet({ type: 'menu' })`);
    await see(
        page,
        `document.querySelector('.place[data-place="files"]')`,
        "the English Files tile",
    );
    const before = await pageScript<{ text: string; label: string }>(
        page,
        `
        const tile = document.querySelector('.place[data-place="files"]');
        return JSON.stringify({ text: tile.querySelector('.place-label').textContent.trim(), label: tile.getAttribute('aria-label') });
    `,
    );

    assert.deepEqual(before, { text: "Files", label: "Files" });
    await appearance(page);
    await chooseFrench(page);
    const layout = await pageScript<string[]>(
        page,
        `
        return JSON.stringify([...document.querySelectorAll('.slot-layout[data-slot="places"] .setting-text > span:first-child')].map((item) => item.textContent.trim()));
    `,
    );

    assert.ok(layout.includes("Fichiers"), "Appearance lists the translated Places Files label");
    await page.evaluate(`(await import('/store.js')).openSheet({ type: 'menu' })`);
    await see(
        page,
        `document.querySelector('.place[data-place="files"]')`,
        "the French Files tile",
    );
    const after = await pageScript<{ text: string; label: string }>(
        page,
        `
        const tile = document.querySelector('.place[data-place="files"]');
        return JSON.stringify({ text: tile.querySelector('.place-label').textContent.trim(), label: tile.getAttribute('aria-label') });
    `,
    );

    assert.deepEqual(after, { text: "Fichiers", label: "Fichiers" });
});

for (const viewport of ["mobile", "desktop"] as const) {
    test(`R19 and R21: ${viewport} shows English first, then selectable French text and accessible labels`, async () => {
        const page = await openPage(viewport);
        const initial = await pageScript<{ lang: string; title: string; menu: boolean }>(
            page,
            `return JSON.stringify({ lang: document.documentElement.lang, title: document.title, menu: !!document.querySelector('[aria-label="Menu"]') })`,
        );

        assert.equal(initial.lang, "en");
        assert.equal(initial.title, "Close · Pi Pocket");
        assert.equal(initial.menu, true);
        await appearance(page);
        await page.evaluate(`(await import("/store.js")).closeSheet()`);
        await see(page, `!(await import("/store.js")).store.state.sheet`, "Appearance is closed");
        await chooseFrench(page);
        await see(
            page,
            `document.body.textContent.includes("Apparence")`,
            "French fixed text is visible",
        );
        assert.ok(
            await pageScript<boolean>(
                page,
                `return JSON.stringify(!!document.querySelector('[aria-label="Menu supérieur"]'))`,
            ),
            "the menu's accessible name is translated",
        );
        assert.ok(
            await pageScript<boolean>(
                page,
                `return JSON.stringify(document.body.textContent.includes('Apparence'))`,
            ),
            "visible fixed text changes",
        );
        assert.equal(
            await pageScript<string>(page, `return JSON.stringify(document.documentElement.lang)`),
            "fr",
        );
        assert.ok(
            await pageScript<boolean>(
                page,
                `return JSON.stringify(document.documentElement.scrollWidth <= innerWidth)`,
            ),
            "the viewport has no horizontal overflow",
        );
        const selector = await pageScript<{ label: string; disabled: boolean; focus: boolean }>(
            page,
            `
            const select = [...document.querySelectorAll("select")].find((each) => [...each.options].some((option) => option.value === "fr"));
            select.focus();
            return JSON.stringify({ label: select.getAttribute("aria-label") || select.labels?.[0]?.textContent?.trim() || "", disabled: select.disabled, focus: document.activeElement === select });
        `,
        );

        assert.ok(selector.label, "the language selector has an accessible name");
        assert.equal(selector.disabled, false);
        assert.equal(selector.focus, true, "the language selector accepts keyboard focus");
        await page.press("Home");
        await see(page, `document.documentElement.lang === "en"`, "the keyboard changes language");
        await page.press("End");
        await see(page, `document.documentElement.lang === "fr"`, "the keyboard restores French");
    });
}
