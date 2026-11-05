// The app's language: the catalog that the server publishes (`GET /ui-locales.json`), this browser's choice (the
// `pocket_locale` cookie), and the words the app shows. English is built in (`locales/en.js`) and is the fallback of
// every key; a language that a module declares (`web.uiLocales`) comes over it, key by key. The cookie is the one copy
// of the choice, and safe mode shows English and keeps it (`safe-mode.js`).
//
// A tab reads the catalog when it starts, on each new connection, and when the server's revision changes; a fetch that
// is not the latest is dropped, and so is one that comes after the server said it has no catalog. Text is looked up as
// it draws (`t`), never at load, so a change of language draws again without a reload: `store.set` changes
// `localeRevision`, which the parts that draw text compare (`ui.js`'s `memo` and `drawnFor`).
import { EN, EN_LABEL } from "./locales/en.js";
import { translate } from "./locale.js";
import { onSafeModeEnd, safeMode } from "./safe-mode.js";
import { onHello, setFixedText, store } from "./store.js";

/** This browser's choice of language: this cookie, and no other copy of it. */
const COOKIE = "pocket_locale";
/** A year: the choice stays until the person changes it. */
const MAX_AGE = 31536000;

/** Each language that the server published but English, by its id, with its merged messages. Empty until one arrives. */
let catalog = new Map();
/** The revision of the catalog here, as the server numbers it: -1 while this tab has none. */
let catalogRevision = -1;
/** The catalog and the language this tab last drew, so an answer with the same words draws nothing again. */
let publishedWords;
let publishedId;
/** The hello whose catalog this tab read: a new connection reads it again, whether the revision changed or not. */
let askedConnection;
let askedRevision;
/** Counts the fetches: an answer that is not the latest is dropped, as one after English-only is. */
let generation = 0;

/** A language tag as `Intl` writes it, or undefined when it is not one. Only an exact tag matches a language. */
function canonical(id) {
    if (typeof id !== "string" || id === "") {
        return undefined;
    }

    try {
        return Intl.getCanonicalLocales(id)[0];
    } catch {
        return undefined;
    }
}

/** The id the cookie names, as `Intl` writes it: "en" when there is none, or it is not a language tag. */
function readPreference() {
    let raw;

    try {
        for (const each of document.cookie.split(";")) {
            const at = each.indexOf("=");

            if (at > 0 && each.slice(0, at).trim() === COOKIE) {
                raw = each.slice(at + 1).trim();
            }
        }
    } catch {
        return "en";
    }

    if (raw === undefined) {
        return "en";
    }

    try {
        return canonical(decodeURIComponent(raw)) ?? "en";
    } catch {
        return "en";
    }
}

/** Keep the choice in the cookie. A browser that keeps none still switches this page, and forgets it on the next. */
function writePreference(id) {
    const secure = location.protocol === "https:" ? "; Secure" : "";

    try {
        document.cookie = `${COOKIE}=${encodeURIComponent(id)}; Path=/; SameSite=Lax; Max-Age=${MAX_AGE}${secure}`;
    } catch {
        // Nothing kept, nothing to take away.
    }
}

/** The language this browser prefers: kept when its language goes, so that it can come back. */
let preferred = readPreference();

/** The language that shows: the preferred one while the catalog has it, else English. */
function effectiveId() {
    if (safeMode() || preferred === "en") {
        return "en";
    }

    return catalog.has(preferred) ? preferred : "en";
}

/** The words of a language: English itself until the catalog arrives, and for a language that is not in it. */
function messagesOf(id) {
    return id === "en" ? EN : (catalog.get(id)?.messages ?? EN);
}

/** The app's words for `key`: this language's, else English, else the words of the place that asks. */
export function t(key, english, values) {
    return translate(messagesOf(effectiveId()), key, english, values);
}

/** The language that shows now: a tag that the catalog has, or "en". */
export function localeId() {
    return effectiveId();
}

/** The languages a person can choose: English first, then each one that the server published, by its own name. */
export function languages() {
    return [
        { id: "en", label: EN_LABEL },
        ...[...catalog].map(([id, each]) => ({ id, label: each.label })),
    ];
}

/** Choose this browser's language, for this page at once and for its next too. An unknown tag means English. */
export function setLocale(id) {
    preferred = canonical(id) ?? "en";
    writePreference(preferred);
    publish();
}

/**
 * The catalog's own data as one string: its revision, then each language's tag, name, and messages. It changes when the
 * words change, also at the same numeric revision, and stays equal when a connection brings the same catalog again.
 */
function signature() {
    let words = `v${catalogRevision}`;

    for (const [id, each] of catalog) {
        words += `\u0000${id}\u0000${each.label}\u0000${JSON.stringify(each.messages)}`;
    }

    return words;
}

/** Draw again if the language or its words changed, and keep the page's `lang` with it. */
function publish() {
    const id = effectiveId();
    const words = signature();

    if (words === publishedWords && id === publishedId) {
        return;
    }

    publishedWords = words;
    publishedId = id;
    document.documentElement.lang = id;
    setFixedText(t);
    store.set({ localeRevision: store.state.localeRevision + 1 });
}

/** Take the catalog the server answered with: `undefined` when it failed, which leaves English only. */
function apply(body) {
    const locales = new Map();
    const revision = body?.revision;
    const ok = typeof revision === "number" && Array.isArray(body.locales);

    if (ok) {
        for (const each of body.locales) {
            if (
                typeof each?.id === "string" &&
                typeof each.label === "string" &&
                typeof each.messages === "object" &&
                each.messages !== null &&
                !locales.has(each.id)
            ) {
                locales.set(each.id, { label: each.label, messages: each.messages });
            }
        }
    }

    // English is built in, whatever the server says of it.
    locales.delete("en");

    catalog = ok ? locales : new Map();
    catalogRevision = ok ? revision : -1;
    publish();
}

/** Read the catalog. The last fetch to start is the only one that counts. */
function fetchCatalog() {
    const mine = ++generation;

    const use = (body) => {
        if (mine === generation) {
            apply(body);
        }
    };

    fetch("/ui-locales.json", { headers: { accept: "application/json" }, cache: "no-store" }).then(
        (response) => {
            // A server that does not answer the catalog (404, 503) is a server without one: English only.
            if (!response.ok) {
                use(undefined);

                return;
            }

            response.json().then(use, () => use(undefined));
        },
        () => use(undefined),
    );
}

/** The cookie can change in another tab, or when this one comes back: read it again, and draw for it if it changed. */
function rereadPreference() {
    const next = readPreference();

    if (next !== preferred) {
        preferred = next;
        publish();
    }
}

addEventListener("focus", rereadPreference);
document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
        rereadPreference();
    }
});

// Each hello names the catalog's revision, and each connection reads it again, whether that number changed or not.
onHello((server, connection) => {
    if (safeMode()) {
        return;
    }

    if (typeof server?.localeRevision !== "number") {
        // A server without the marker has no catalog to read: English only, and every answer still on its way is
        // dropped, the first one too.
        askedConnection = undefined;
        askedRevision = undefined;
        generation++;
        catalog = new Map();
        catalogRevision = -1;
        publish();

        return;
    }

    if (connection === askedConnection && server.localeRevision === askedRevision) {
        return;
    }

    askedConnection = connection;
    askedRevision = server.localeRevision;
    fetchCatalog();
});

// Leaving safe mode: English is no longer forced, so the cookie's choice comes back if the catalog still has it.
onSafeModeEnd(() => {
    rereadPreference();
    fetchCatalog();
});

publish();

if (!safeMode()) {
    fetchCatalog();
}
