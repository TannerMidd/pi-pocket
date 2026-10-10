// Data-only UI translations. Call only for application-owned labels, never user content.
let activeLocale = "en";
let activeStrings = Object.create(null);
let activeTemplates = Object.create(null);

function dictionary(value) {
    return Object.fromEntries(
        Object.entries(value ?? {}).filter(([, text]) => typeof text === "string"),
    );
}

/** Replace translations before store subscribers render a new hello. No persistent locale cache. */
export function setUiLocales(packs) {
    const available = Array.isArray(packs) ? packs : [];
    // Deterministic across browsers and restarts: preferred packs first, then language tag.
    const pack = [...available]
        .filter((item) => item && typeof item.locale === "string")
        .sort(
            (a, b) =>
                Number(b.default === true) - Number(a.default === true) ||
                (a.locale < b.locale ? -1 : a.locale > b.locale ? 1 : 0),
        )[0];

    activeLocale = pack?.locale ?? "en";
    activeStrings = dictionary(pack?.strings);
    activeTemplates = dictionary(pack?.templates);

    if (typeof document !== "undefined") {
        document.documentElement.lang = activeLocale;
    }

    return activeLocale;
}

export function currentLocale() {
    return activeLocale;
}

/** Explicit source keys only. Parameters remain verbatim, and are interpolated once as plain text. */
export function t(value, params) {
    if (typeof value !== "string") {
        return value;
    }

    const strings = params === undefined ? activeStrings : activeTemplates;
    const translated = Object.hasOwn(strings, value) ? strings[value] : value;

    if (params === undefined) {
        return translated;
    }

    return translated.replace(/\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g, (placeholder, name) =>
        Object.hasOwn(params, name) ? String(params[name]) : placeholder,
    );
}
