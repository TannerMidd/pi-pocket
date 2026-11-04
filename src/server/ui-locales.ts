/**
 * UI locales: the app's fixed text in other languages. A module declares its languages with `web.uiLocales` while it
 * loads (`extension-web.ts`); core checks them, copies and freezes them, and merges them over the English catalog
 * (`web/locales/en.js`). English is Pi Pocket's own and the fallback of every key: a module adds a language, and never
 * changes English. The server and the browser read the same catalog and the same lookup (`web/locale.js`), so a label
 * reads the same on a sign-in page as in the app.
 *
 * A declaration is data: a language tag, the language's own name, and text by message key. Nothing in it is run, and
 * nothing of it reaches a browser or a sign-in page before the version of the module that declared it is committed.
 */

import { EN, EN_LABEL } from "../../web/locales/en.js";
import { placeholders } from "../../web/locale.js";

/** One language's UI text, as a module declares it: its tag, its own name, and its messages by key. */
export interface UiLocalePack {
    readonly id: string;
    readonly label: string;
    readonly messages: Readonly<Record<string, string>>;
}

/** The catalog at one moment: English, which is Pi Pocket's own, then each language that a module declared, by id. */
export interface UiLocaleSnapshot {
    readonly revision: number;
    readonly locales: readonly UiLocalePack[];
}

/** What one declaration may hold, and what all the committed languages but English may hold together. */
export const UI_LOCALE_LIMITS = {
    /** Languages that one module declares at most. */
    locales: 16,
    /** Characters of a language's tag, as it is written. */
    id: 64,
    /** Characters of a language's own name. */
    label: 80,
    /** Messages of one language. */
    messages: 10_000,
    /** Characters of a message's key. */
    key: 160,
    /** UTF-8 bytes of one message's text. */
    value: 8 * 1024,
    /** UTF-8 bytes of one module's whole declaration, as JSON. */
    declaration: 1024 * 1024,
    /** UTF-8 bytes of every committed language but English, as JSON. */
    total: 4 * 1024 * 1024,
} as const;

/** A message's key: lowercase words, joined by `.`, `_`, or `-` (`sessions.mark-read`). */
const MESSAGE_KEY = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
/** The fields of one language, and the only ones: a declaration is data, not a place for options. */
const PACK_FIELDS: ReadonlySet<string> = new Set(["id", "label", "messages"]);
/** What each checked language was declared as, as JSON: a committed total counts what its module declared. */
const DECLARED = new WeakMap<UiLocalePack, string>();
/** Words that a message's key must not have: they would name a part of a JavaScript object, not a message. */
const DANGEROUS: ReadonlySet<string> = new Set(["__proto__", "prototype", "constructor"]);
const WORD = /[._-]/;

/** Whether `value` is a plain object: the shape a declaration's parts have, and not an array or a class. */
function plain(value: unknown): value is object {
    return (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
    );
}

/**
 * A value's own data properties, by key. A getter is refused, never run, also a hidden one: a declaration is data, so
 * what it means must not depend on code that runs while it is read. Properties of its prototype are not read at all.
 */
function ownData(value: object, where: string): Map<string, unknown> {
    const found = new Map<string, unknown>();

    for (const key of Object.getOwnPropertyNames(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);

        if (descriptor === undefined || !("value" in descriptor)) {
            throw new Error(
                `web.uiLocales: ${where}: ${key} is a getter, and a declaration is data`,
            );
        }

        found.set(key, descriptor.value);
    }

    return found;
}

/** A language's tag, as `Intl` writes it: `zh-cn` is `zh-CN`. English is Pi Pocket's own, so a module cannot declare it. */
function languageId(value: unknown, where: string): string {
    if (
        typeof value !== "string" ||
        value === "" ||
        value.length > UI_LOCALE_LIMITS.id ||
        value.includes("\0")
    ) {
        throw new Error(
            `web.uiLocales: ${where}: id is a language tag of 1 to ${UI_LOCALE_LIMITS.id} characters, such as "zh-CN"`,
        );
    }

    let canonical: readonly string[];

    try {
        canonical = Intl.getCanonicalLocales(value);
    } catch {
        throw new Error(
            `web.uiLocales: ${where}: ${value} is not a language tag that Intl.getCanonicalLocales takes`,
        );
    }

    const id = canonical[0];

    if (id === undefined) {
        throw new Error(`web.uiLocales: ${where}: ${value} is not a language tag`);
    }

    if (id.toLowerCase() === "en") {
        throw new Error(`web.uiLocales: ${where}: "en" is Pi Pocket's own: add another language`);
    }

    return id;
}

/** A language's own name, as the language list shows it: one line, as plain text, of 80 characters at most. */
function languageLabel(value: unknown, where: string): string {
    if (
        typeof value !== "string" ||
        value.trim() === "" ||
        value.length > UI_LOCALE_LIMITS.label ||
        value.includes("\0") ||
        /[\r\n]/.test(value)
    ) {
        throw new Error(
            `web.uiLocales: ${where}: label is the language's own name, one line of 1 to ${UI_LOCALE_LIMITS.label} characters`,
        );
    }

    return value.trim();
}

/** A message's key, checked: it names a message of the app, and never a part of a JavaScript object. */
function messageKey(key: string, where: string): void {
    if (
        key.length > UI_LOCALE_LIMITS.key ||
        !MESSAGE_KEY.test(key) ||
        key.split(WORD).some((word) => DANGEROUS.has(word))
    ) {
        throw new Error(
            `web.uiLocales: ${where}: ${key.slice(0, 24)} is not a message key: lowercase words of ${UI_LOCALE_LIMITS.key} characters at most, joined by . _ or -, and no ${[...DANGEROUS].join(", ")}`,
        );
    }
}

/** The placeholder names of two texts, as sets: a language says the same ones as English, in any order. */
function sameNames(one: readonly string[], other: readonly string[]): boolean {
    const wanted = new Set(one);
    const said = new Set(other);

    return wanted.size === said.size && [...wanted].every((name) => said.has(name));
}

/** Placeholder names in words, for a message about a mistake: `{name}, {count}`. */
function shownNames(names: readonly string[]): string {
    const unique = [...new Set(names)];

    return unique.length === 0 ? "none" : unique.map((name) => `{${name}}`).join(", ");
}

/**
 * A language's messages, checked and copied. Only text is read: a value that is not a string, a key that is not a
 * message key, and a message larger than the limit all throw. A key that English does not have says nothing, and is
 * left out later, after the size of the declaration counted it. A translation of a key that English has says the same
 * placeholder names as English.
 */
function languageMessages(value: unknown, where: string): Record<string, string> {
    if (!plain(value)) {
        throw new Error(`web.uiLocales: ${where}: messages is an object of message keys and text`);
    }

    const fields = ownData(value, where);

    if (fields.size === 0) {
        throw new Error(`web.uiLocales: ${where}: messages is empty: give it at least one key`);
    }

    if (fields.size > UI_LOCALE_LIMITS.messages) {
        throw new Error(
            `web.uiLocales: ${where}: messages has ${fields.size} keys, and ${UI_LOCALE_LIMITS.messages} at most`,
        );
    }

    const messages: Record<string, string> = Object.create(null);

    for (const [key, text] of fields) {
        messageKey(key, where);

        if (typeof text !== "string") {
            throw new Error(`web.uiLocales: ${where}: ${key} is text, and not a ${typeof text}`);
        }

        if (text.includes("\0") || Buffer.byteLength(text) > UI_LOCALE_LIMITS.value) {
            throw new Error(
                `web.uiLocales: ${where}: ${key} is text of ${UI_LOCALE_LIMITS.value} UTF-8 bytes at most, without NUL`,
            );
        }

        const english = EN[key];

        if (
            english !== undefined &&
            text.trim() !== "" &&
            !sameNames(placeholders(english), placeholders(text))
        ) {
            throw new Error(
                `web.uiLocales: ${where}: ${key} says the placeholders ${shownNames(placeholders(text))}, and English says ${shownNames(placeholders(english))}`,
            );
        }

        messages[key] = text;
    }

    return messages;
}

/** One language of a declaration: as the catalog keeps it, and as it was declared, for the size. */
interface Declared {
    /** The language as the catalog keeps it: its tag as `Intl` writes it, its own name trimmed, and only what English has. */
    readonly pack: UiLocalePack;
    /** The language's own values, as JSON: a declaration's size counts what it declares, before anything is dropped. */
    readonly json: string;
}

/** A language of a declaration: its tag, its own name, and its messages, and nothing else. */
function checkPack(module: string, given: unknown, at: number): Declared {
    const where = `${module}, language ${String(at + 1)}`;

    if (!plain(given)) {
        throw new Error(`web.uiLocales: ${where}: give an object with id, label, and messages`);
    }

    const fields = ownData(given, where);
    const other = [...fields.keys()].find((key) => !PACK_FIELDS.has(key));

    // A field of its own that a language does not have (a `priority`, say) is a mistake, not something to ignore.
    if (other !== undefined) {
        throw new Error(
            `web.uiLocales: ${where}: ${other} is not a field of a language: give id, label, and messages`,
        );
    }

    const declaredId = fields.get("id");
    const declaredLabel = fields.get("label");
    const messages = languageMessages(fields.get("messages"), where);

    const pack = Object.freeze({
        id: languageId(declaredId, where),
        label: languageLabel(declaredLabel, where),
        messages: Object.freeze(onlySaid(messages)),
    });
    // A language's own values, as JSON: a size counts what the module declared, before anything is left out:
    // messages that English does not have, blank ones, and the tag's and the name's own spelling.
    const json = JSON.stringify({ id: declaredId, label: declaredLabel, messages });

    DECLARED.set(pack, json);

    return { pack, json };
}

/**
 * The elements of a declaration, each as it is. An element with no value of its own (a hole, or a getter) is refused: a
 * declaration is data, so reading it never runs code.
 */
function declared(module: string, packs: readonly unknown[]): readonly unknown[] {
    const given: unknown[] = [];

    for (let at = 0; at < packs.length; at++) {
        const descriptor = Object.getOwnPropertyDescriptor(packs, String(at));
        const where = `${module}, language ${String(at + 1)}`;

        if (descriptor === undefined) {
            throw new Error(`web.uiLocales: ${where}: the declaration has no language there`);
        }

        if (!("value" in descriptor)) {
            throw new Error(
                `web.uiLocales: ${where}: the language is a getter, and a declaration is data`,
            );
        }

        given.push(descriptor.value);
    }

    return given;
}

/** What a language says, without the keys English does not have and without blank messages: those fall back. */
function onlySaid(messages: Readonly<Record<string, string>>): Record<string, string> {
    const said: Record<string, string> = Object.create(null);

    for (const [key, text] of Object.entries(messages)) {
        if (EN[key] !== undefined && text.trim() !== "") {
            said[key] = text;
        }
    }

    return said;
}

/**
 * A module's declaration (`web.uiLocales`), checked and copied: any mistake throws, so the module does not load and the
 * version before it stays. The copies are frozen, so what the module does to its own objects afterwards changes
 * nothing. A declaration of 1 to 16 languages, and of at most 1 MiB as JSON, is a whole version's: it is taken or
 * refused all at once. The size is the declaration's own, as it is written, before anything is normalized or left out.
 */
export function checkUiLocales(module: string, packs: unknown): readonly UiLocalePack[] {
    if (!Array.isArray(packs) || packs.length === 0 || packs.length > UI_LOCALE_LIMITS.locales) {
        throw new Error(
            `web.uiLocales: ${module}: give 1 to ${UI_LOCALE_LIMITS.locales} languages, as an array of { id, label, messages }`,
        );
    }

    const checked = declared(module, packs).map((each, at) => checkPack(module, each, at));
    const ids = checked.map((each) => each.pack.id);

    if (new Set(ids).size !== ids.length) {
        throw new Error(
            `web.uiLocales: ${module}: two languages have the same id: ${ids.join(", ")}`,
        );
    }

    // The declaration as JSON: `[` and `]`, and a comma between two languages, as JSON.stringify writes them.
    const bytes = Buffer.byteLength(`[${checked.map((each) => each.json).join(",")}]`);

    if (bytes > UI_LOCALE_LIMITS.declaration) {
        throw new Error(
            `web.uiLocales: ${module}: the declaration is ${bytes} UTF-8 bytes as JSON, and ${UI_LOCALE_LIMITS.declaration} at most`,
        );
    }

    return Object.freeze(checked.map((each) => each.pack));
}

/** A language as the layers made it: the last layer's name for the language, and each key from the last layer that has it. */
function merged(id: string, layers: readonly UiLocalePack[]): UiLocalePack {
    const messages: Record<string, string> = Object.create(null);
    let label = id;

    for (const layer of layers) {
        label = layer.label;

        for (const [key, text] of Object.entries(layer.messages)) {
            messages[key] = text;
        }
    }

    return Object.freeze({ id, label, messages: Object.freeze(messages) });
}

/**
 * The committed languages, by module: what each module that is on declared, in the loader's order, merged into one
 * catalog with English under it. A version's languages come in, change, and go with the version, in one step
 * (`extension-web.ts`).
 */
export class UiLocales {
    /** Each module's languages, by the module's file. */
    readonly #packs = new Map<string, readonly UiLocalePack[]>();
    /** The loader's list of modules: the layers follow it, not the order that loads happened to finish in. */
    #order: () => readonly string[] = () => [];
    #revision = 0;

    /** Follow `order`, the loader's list of modules, when the layers are merged. */
    orderedBy(order: () => readonly string[]): void {
        this.#order = order;
    }

    /** The number of the catalog now: it goes up each time a module's languages come, change, or go. */
    get revision(): number {
        return this.#revision;
    }

    /**
     * A module that just loaded declares these languages, or none: its previous version's layers go, in one step.
     * Answers whether the catalog changed.
     */
    set(file: string, packs: readonly UiLocalePack[] | undefined): boolean {
        const before = this.#packs.get(file);

        if (packs === undefined) {
            if (before === undefined) {
                return false;
            }

            this.#packs.delete(file);
        } else {
            this.#packs.set(file, packs);
        }

        this.#revision++;

        return true;
    }

    /**
     * Check a module's languages against the catalog that they would join, before it is committed: the committed
     * languages, with this module's in place of its previous version's, are within the total. Throws, so the version
     * before stays and nothing is half published.
     */
    check(file: string, packs: readonly UiLocalePack[] | undefined): void {
        if (packs === undefined) {
            return;
        }

        const all: UiLocalePack[] = [];

        for (const [other, each] of this.#packs) {
            all.push(...(other === file ? packs : each));
        }

        if (!this.#packs.has(file)) {
            all.push(...packs);
        }

        const bytes = Buffer.byteLength(`[${all.map(declaredJson).join(",")}]`);

        if (bytes > UI_LOCALE_LIMITS.total) {
            throw new Error(
                `web.uiLocales: ${file}: the committed languages are ${bytes} UTF-8 bytes as JSON, and ${UI_LOCALE_LIMITS.total} at most, together`,
            );
        }
    }

    /**
     * The catalog now: English, then each language by its tag, with the layers merged in the loader's order. English is
     * the shared catalog itself; a language's messages are a frozen copy of what its layers said.
     */
    snapshot(): UiLocaleSnapshot {
        const layers = new Map<string, UiLocalePack[]>();

        for (const file of this.#order()) {
            for (const pack of this.#packs.get(file) ?? []) {
                const layer = layers.get(pack.id);

                if (layer === undefined) {
                    layers.set(pack.id, [pack]);
                } else {
                    layer.push(pack);
                }
            }
        }

        const locales: UiLocalePack[] = [
            Object.freeze({ id: "en", label: EN_LABEL, messages: EN }),
            ...[...layers.keys()]
                .sort((one, other) => (one < other ? -1 : one > other ? 1 : 0))
                .map((id) => merged(id, layers.get(id) ?? [])),
        ];

        return Object.freeze({ revision: this.#revision, locales: Object.freeze(locales) });
    }
}

/** A language as it was declared, as JSON: what the committed total counts. */
function declaredJson(pack: UiLocalePack): string {
    return DECLARED.get(pack) ?? JSON.stringify(pack);
}
