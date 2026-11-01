import type { SystemProblem, TokenType } from "./system-types.ts";

export const EXT = "com.pi-pocket";

export const TOKEN_TYPES: readonly TokenType[] = [
    "color",
    "dimension",
    "fontFamily",
    "fontWeight",
    "duration",
    "cubicBezier",
    "number",
    "shadow",
    "typography",
    "border",
    "transition",
    "gradient",
    "strokeStyle",
];

/** What the engine reads and keeps, so that a stray file or a hostile one stays cheap. */
export const LIMITS = {
    tokenFileBytes: 524_288,
    modes: 16,
    tokens: 5000,
    depth: 12,
    valueChars: 400,
    componentBytes: 131_072,
    components: 100,
    guidelinesBytes: 16_384,
    problems: 200,
} as const;

export const MODE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const NAME = /^[A-Za-z0-9_-]{1,64}$/;
export const RESERVED = new Set(["__proto__", "constructor", "prototype"]);

export interface RawSystem {
    folder: string;
    tokens: unknown;
    modes: Map<string, unknown>;
    components: Map<string, string>;
    guidelines: string;
    problems: SystemProblem[];
}

export type Obj = Record<string, unknown>;

export const isObject = (value: unknown): value is Obj =>
    typeof value === "object" && value !== null && !Array.isArray(value);
export const clip = (text: string, max = 60) =>
    text.length > max ? `${text.slice(0, max - 1)}…` : text;

// It writes no more than it shows: a value whose parts are shared (`[a, a]` on 20 levels) would be millions of characters as a whole.
export const show = (value: unknown, max = 60) => {
    const skipped = (part: unknown) =>
        part === undefined || typeof part === "function" || typeof part === "symbol";

    if (skipped(value)) {
        return clip(String(value), max);
    }

    let out = "";

    const put = (part: unknown) => {
        const proto = typeof part === "object" && part !== null && Object.getPrototypeOf(part);
        const plain =
            (Array.isArray(part) || proto === Object.prototype || proto === null) &&
            !("toJSON" in (part as object));

        if (!plain) {
            out += JSON.stringify(part) ?? "null";

            return;
        }

        const list = Array.isArray(part);
        const pairs = list
            ? Array.from(part, (item): [string | undefined, unknown] => [undefined, item])
            : Object.entries(part as object).filter(([, item]) => !skipped(item));

        out += list ? "[" : "{";

        for (const [at, [key, item]] of pairs.entries()) {
            if (out.length > max) {
                return;
            }

            out += `${at > 0 ? "," : ""}${key === undefined ? "" : `${JSON.stringify(key)}:`}`;
            put(item);
        }

        out += list ? "]" : "}";
    };

    put(value);

    return clip(out, max);
};

export const plain = (text: string) =>
    text
        .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ")
        .replace(/\s+/g, " ")
        .trim();

export const extensionOf = (node: Obj): Obj => {
    const extensions = node.$extensions;

    return isObject(extensions) && isObject(extensions[EXT]) ? extensions[EXT] : {};
};

/** Where `end` leaves a whole UTF-8 sequence: text cut there has no replacement character at its last character. */
export function utf8Cut(bytes: Buffer, end: number): number {
    let back = 0;

    if (end <= 0) {
        return 0;
    }

    while (back < 3 && end - back - 1 >= 0 && (bytes[end - back - 1]! & 0xc0) === 0x80) {
        back++;
    }

    const at = end - back - 1;

    // Only continuation bytes on the way back: the start of the text is one broken sequence, so keep none of it.
    if (at < 0) {
        return 0;
    }

    const lead = bytes[at]!;
    const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;

    return need <= back + 1 ? end : at;
}

export function boundedText(bytes: Buffer, max: number): { text: string; truncated: boolean } {
    const kept = bytes.length > max ? utf8Cut(bytes, max) : bytes.length;

    return {
        text: bytes.subarray(0, Math.max(0, kept)).toString("utf8"),
        truncated: bytes.length > kept,
    };
}
