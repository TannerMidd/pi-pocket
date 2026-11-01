// The page is untrusted text and a wrong rewrite breaks a design, so the scanner skips comments, scripts, strings, and `url()`.
// Only `<style>` elements and `style` attributes are edited, only a whole value token (a color, a `px` length, a `font-family` list) in a declaration the finding names,
// and never a `var()`, a custom property, `@font-face`, or `@keyframes`.
import { colorObjectCss, parseColor } from "./color.ts";
import type {
    CheckFinding,
    CheckFix,
    DesignSystem,
    ModeValue,
    ResolvedToken,
} from "./system-types.ts";

export interface FixResult {
    content: string;
    applied: number;
    skipped: { id: string; reason: string }[];
}

interface Region {
    start: number;
    end: number;
    pid?: string;
    inline: boolean;
}

interface Declaration {
    property: string;
    masked: string;
    start: number;
    end: number;
    selector?: string;
    inline: boolean;
    pid?: string;
}

interface Match {
    start: number;
    end: number;
    declaration: Declaration;
}

const MAX_CONTENT = 2_000_000;
const SKIPPED_AT_RULES =
    /^@(-webkit-)?(font-face|keyframes|property|page|counter-style|font-feature-values)\b/i;
const RAW_TEXT = new Set(["script", "style", "textarea", "title", "xmp", "noscript"]);
const COLOR_FUNCTIONS = /^(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)$/i;

function regions(content: string): { regions: Region[]; pids: Map<string, number> } {
    const found: Region[] = [];
    const pids = new Map<string, number>();
    const lower = content.toLowerCase();
    let at = 0;

    while (at < content.length) {
        const open = content.indexOf("<", at);

        if (open === -1) {
            break;
        }

        if (content.startsWith("<!--", open)) {
            const close = content.indexOf("-->", open + 4);

            at = close === -1 ? content.length : close + 3;

            continue;
        }

        if (content.startsWith("<![CDATA[", open)) {
            const close = content.indexOf("]]>", open + 9);

            at = close === -1 ? content.length : close + 3;

            continue;
        }

        const named = /^<([a-zA-Z][a-zA-Z0-9:-]*)/.exec(content.slice(open, open + 40));

        if (named === null) {
            const close = content.indexOf(">", open + 1);

            at = close === -1 ? content.length : close + 1;

            continue;
        }

        const name = named[1]!.toLowerCase();
        let index = open + named[0].length;
        let styleValue: { start: number; end: number } | undefined;
        let pid: string | undefined;

        for (;;) {
            while (index < content.length && /[\s/]/.test(content[index]!)) {
                index++;
            }

            if (index >= content.length || content[index] === ">") {
                break;
            }

            const attribute = /^[^\s=>/]+/.exec(content.slice(index, index + 200));

            if (attribute === null) {
                index++;

                continue;
            }

            const attributeName = attribute[0].toLowerCase();

            index += attribute[0].length;

            while (index < content.length && /\s/.test(content[index]!)) {
                index++;
            }

            if (content[index] !== "=") {
                continue;
            }

            index++;

            while (index < content.length && /\s/.test(content[index]!)) {
                index++;
            }

            const quote = content[index];
            let start = index;
            let end: number;

            if (quote === '"' || quote === "'") {
                start = index + 1;
                end = content.indexOf(quote, start);
                end = end === -1 ? content.length : end;
                index = end + 1;
            } else {
                end = start;

                while (end < content.length && !/[\s>]/.test(content[end]!)) {
                    end++;
                }

                index = end;
            }

            if (attributeName === "style") {
                styleValue = { start, end };
            } else if (attributeName === "data-pid") {
                pid = decode(content.slice(start, end));
            }
        }

        const tagEnd = index >= content.length ? content.length : index + 1;

        if (pid !== undefined) {
            pids.set(pid, (pids.get(pid) ?? 0) + 1);
        }

        if (styleValue !== undefined) {
            found.push({ ...styleValue, pid, inline: true });
        }

        at = tagEnd;

        if (RAW_TEXT.has(name)) {
            const close = lower.indexOf(`</${name}`, tagEnd);
            const end = close === -1 ? content.length : close;

            if (name === "style") {
                found.push({ start: tagEnd, end, inline: false });
            }

            at = end;
        }
    }

    return { regions: found, pids };
}

function decode(text: string): string {
    return text
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&apos;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&");
}

/** The text with comments, the insides of strings, and unquoted `url()` blanked to `x` (or a space): the same length, so that offsets stay true. */
function mask(text: string): string {
    const out = text.split("");
    let i = 0;

    while (i < text.length) {
        const ch = text[i]!;

        if (ch === "/" && text[i + 1] === "*") {
            const close = text.indexOf("*/", i + 2);
            const end = close === -1 ? text.length : close + 2;

            for (let j = i; j < end; j++) {
                out[j] = " ";
            }

            i = end;
        } else if (ch === '"' || ch === "'") {
            let j = i + 1;

            while (j < text.length && text[j] !== ch && text[j] !== "\n") {
                if (text[j] === "\\") {
                    out[j] = "x";
                    j++;
                }

                if (j < text.length) {
                    out[j] = "x";
                }

                j++;
            }

            i = j + 1;
        } else if (
            /^url\(/i.test(text.slice(i, i + 4)) &&
            text[i + 4] !== '"' &&
            text[i + 4] !== "'"
        ) {
            const close = text.indexOf(")", i + 4);
            const end = close === -1 ? text.length : close;

            for (let j = i + 4; j < end; j++) {
                out[j] = "x";
            }

            i = end;
        } else {
            i++;
        }
    }

    return out.join("");
}

function declarations(content: string, region: Region): Declaration[] {
    // In a `style` attribute a quote may be an entity: `&quot;` stands for `"` (same length, so that offsets stay true).
    const text = region.inline
        ? content
              .slice(region.start, region.end)
              .replace(/&quot;/g, `"${" ".repeat(5)}`)
              .replace(/&#39;|&apos;/g, (entity) => `'${" ".repeat(entity.length - 1)}`)
        : content.slice(region.start, region.end);
    const masked = mask(text);
    const out: Declaration[] = [];
    const stack: string[] = [];
    // The same rules' selectors as written (the masked text hides the insides of strings, such as `[data-pid="x"]`).
    const written: string[] = [];
    let segment = 0;
    let depth = 0;

    const declaration = (from: number, to: number) => {
        const colon = masked.indexOf(":", from);

        if (colon === -1 || colon >= to) {
            return;
        }

        const property = masked.slice(from, colon).trim().toLowerCase();

        if (property === "" || /[\s{}@]/.test(property) || property.startsWith("--")) {
            return;
        }

        if (stack.some((each) => SKIPPED_AT_RULES.test(each))) {
            return;
        }

        let end = to;
        const important = /!\s*important\s*$/i.exec(masked.slice(colon + 1, to));

        if (important !== null) {
            end = colon + 1 + important.index;
        }

        const plain = written.filter((_, index) => !stack[index]!.startsWith("@"));
        const selector =
            region.inline || plain.length !== 1 || /&/.test(plain[0]!)
                ? undefined
                : normalizeSelector(plain[0]!);

        out.push({
            property,
            masked: masked.slice(colon + 1, end),
            start: region.start + colon + 1,
            end: region.start + end,
            selector,
            inline: region.inline,
            pid: region.pid,
        });
    };

    for (let i = 0; i < masked.length; i++) {
        const ch = masked[i]!;

        if (ch === "(") {
            depth++;
        } else if (ch === ")") {
            depth = Math.max(0, depth - 1);
        } else if (depth === 0 && ch === "{") {
            stack.push(masked.slice(segment, i).trim());
            written.push(
                text
                    .slice(segment, i)
                    .replace(/\/\*[^]*?\*\//g, " ")
                    .trim(),
            );
            segment = i + 1;
        } else if (depth === 0 && ch === "}") {
            declaration(segment, i);
            stack.pop();
            written.pop();
            segment = i + 1;
        } else if (depth === 0 && ch === ";") {
            declaration(segment, i);
            segment = i + 1;
        }
    }

    declaration(segment, masked.length);

    return out;
}

function normalizeSelector(selector: string): string {
    return selector
        .replace(/\s+/g, " ")
        .replace(/\s*([>+~,])\s*/g, "$1")
        .trim();
}

function tokens(masked: string): { text: string; start: number; end: number }[] {
    const out: { text: string; start: number; end: number }[] = [];
    let i = 0;

    while (i < masked.length) {
        const ch = masked[i]!;

        if (/\s|,|\//.test(ch)) {
            i++;

            continue;
        }

        let end = i;

        while (end < masked.length && /[^\s,/(]/.test(masked[end]!)) {
            end++;
        }

        if (masked[end] === "(") {
            let depth = 0;
            const name = masked.slice(i, end);

            for (; end < masked.length; end++) {
                if (masked[end] === "(") {
                    depth++;
                } else if (masked[end] === ")" && --depth === 0) {
                    end++;
                    break;
                }
            }

            if (COLOR_FUNCTIONS.test(name)) {
                out.push({ text: masked.slice(i, end), start: i, end });
            }
        } else if (end > i) {
            out.push({ text: masked.slice(i, end), start: i, end });
        }

        i = Math.max(end, i + 1);
    }

    return out;
}

const sameColor = (
    a: { r: number; g: number; b: number; a: number },
    b: { r: number; g: number; b: number; a: number },
) =>
    Math.abs(a.r - b.r) <= 0.5 / 255 &&
    Math.abs(a.g - b.g) <= 0.5 / 255 &&
    Math.abs(a.b - b.b) <= 0.5 / 255 &&
    Math.abs(a.a - b.a) <= 0.006;

function colorIn(entry: ModeValue) {
    const css = entry.css.startsWith("var(")
        ? typeof entry.value === "string"
            ? entry.value
            : (() => {
                  const made = colorObjectCss(entry.value);

                  return "css" in made ? made.css : undefined;
              })()
        : entry.css;

    return css === undefined ? undefined : parseColor(css);
}

export function sameInEveryMode(token: ResolvedToken, modes: string[]): boolean {
    const [first, ...rest] = modes.map((mode) => token.modes[mode]);

    if (first === undefined || rest.some((entry) => entry === undefined)) {
        return false;
    }

    if (token.type === "color") {
        const color = colorIn(first);

        return (
            color !== undefined &&
            rest.every((entry) => {
                const other = colorIn(entry!);

                return other !== undefined && sameColor(color, other);
            })
        );
    }

    return rest.every((entry) => JSON.stringify(entry!.value) === JSON.stringify(first.value));
}

// The page stays the same only if the token is the literal in every mode, not in the checked mode alone.
function verify(fix: CheckFix, system: DesignSystem): string | undefined {
    for (const mode of new Set([fix.mode, ...system.modes])) {
        const problem = verifyIn(fix, system, mode);

        if (problem !== undefined) {
            return problem;
        }
    }

    return undefined;
}

function verifyIn(fix: CheckFix, system: DesignSystem, mode: string): string | undefined {
    const token = system.tokens.find(
        (each) => each.name === fix.token && each.cssVar === fix.cssVar,
    );
    const entry = token?.modes[mode];

    if (token === undefined || entry === undefined) {
        return "The token is not in the design system any more.";
    }

    if (fix.kind === "color") {
        const color = colorIn(entry);
        const literal = parseColor(fix.literal);

        if (color === undefined || literal === undefined || !sameColor(color, literal)) {
            return `The token ${fix.token} is not ${fix.literal} in ${mode}.`;
        }
    } else if (fix.kind === "length") {
        const value = entry.value;
        const px =
            typeof value === "object" &&
            value !== null &&
            (value as { unit?: unknown }).unit === "px"
                ? (value as { value?: unknown }).value
                : typeof value === "string" && /^-?[\d.]+px$/.test(value)
                  ? Number.parseFloat(value)
                  : undefined;

        // A `rem` or other unit is trusted from the check (the browser resolved it); a `px` one is compared.
        if (px !== undefined && px !== Number.parseFloat(fix.literal)) {
            return `The token ${fix.token} is not ${fix.literal} in ${mode}.`;
        }
    } else {
        const wanted = families(fix.literal);
        const list = Array.isArray(entry.value)
            ? entry.value.map((each) => String(each).toLowerCase())
            : typeof entry.value === "string"
              ? families(entry.value)
              : [];

        if (wanted.length === 0 || wanted.join(",") !== list.join(",")) {
            return `The token ${fix.token} is not ${fix.literal} in ${mode}.`;
        }
    }

    return undefined;
}

function families(text: string): string[] {
    return decode(text)
        .split(",")
        .map((name) =>
            name
                .trim()
                .replace(/^["']|["']$/g, "")
                .toLowerCase(),
        )
        .filter((name) => name !== "");
}

interface Piece {
    text: string;
    start: number;
    end: number;
    color: ReturnType<typeof parseColor> | null | false;
}

const pieces = new WeakMap<Declaration, Piece[]>();

function piecesOf(declaration: Declaration): Piece[] {
    let found = pieces.get(declaration);

    if (found === undefined) {
        found = tokens(declaration.masked).map((token) => ({ ...token, color: false as const }));
        pieces.set(declaration, found);
    }

    return found;
}

function colorOf(piece: Piece) {
    if (piece.color === false) {
        piece.color = parseColor(piece.text) ?? null;
    }

    return piece.color ?? undefined;
}

type Color = NonNullable<ReturnType<typeof parseColor>>;

const byteOf = (channel: number) => Math.round(channel * 255);
const colorIndexes = new WeakMap<Declaration[], Map<string, [number, number][]>>();

// A color that `sameColor` takes is at most half a byte step away: in this bucket or a next one.
function colorIndexOf(all: Declaration[]): Map<string, [number, number][]> {
    let index = colorIndexes.get(all);

    if (index === undefined) {
        const made = new Map<string, [number, number][]>();

        all.forEach((declaration, at) => {
            piecesOf(declaration).forEach((piece, place) => {
                const color = colorOf(piece);

                if (color !== undefined) {
                    const key = `${byteOf(color.r)},${byteOf(color.g)},${byteOf(color.b)}`;
                    const list = made.get(key);

                    if (list === undefined) {
                        made.set(key, [[at, place]]);
                    } else {
                        list.push([at, place]);
                    }
                }
            });
        });
        index = made;
        colorIndexes.set(all, index);
    }

    return index;
}

// The same places, in the same order, as a scan of every declaration of the properties, piece by piece.
function colorMatches(all: Declaration[], literal: Color, properties: Set<string>): Match[] {
    const index = colorIndexOf(all);
    const keys = new Set<string>();
    const [r, g, b] = [byteOf(literal.r), byteOf(literal.g), byteOf(literal.b)];

    for (const dr of [-1, 0, 1]) {
        for (const dg of [-1, 0, 1]) {
            for (const db of [-1, 0, 1]) {
                keys.add(`${r + dr},${g + dg},${b + db}`);
            }
        }
    }

    const found: [number, number][] = [];

    for (const key of keys) {
        for (const item of index.get(key) ?? []) {
            const declaration = all[item[0]]!;

            if (
                properties.has(declaration.property) &&
                sameColor(colorOf(piecesOf(declaration)[item[1]]!)!, literal)
            ) {
                found.push(item);
            }
        }
    }

    return found
        .sort((x, y) => x[0] - y[0] || x[1] - y[1])
        .map(([at, place]) => {
            const declaration = all[at]!;
            const piece = piecesOf(declaration)[place]!;

            return {
                start: declaration.start + piece.start,
                end: declaration.start + piece.end,
                declaration,
            };
        });
}

function placesIn(
    content: string,
    declaration: Declaration,
    fix: CheckFix,
): { start: number; end: number }[] {
    const base = declaration.start;

    if (fix.kind === "font") {
        const original = content.slice(declaration.start, declaration.end);
        const trimmed = original.trim();
        const lead = original.length - original.trimStart().length;

        return trimmed === "" ? [] : [{ start: base + lead, end: base + lead + trimmed.length }];
    }

    const found: { start: number; end: number }[] = [];
    const pixels = fix.kind === "length" ? Number.parseFloat(fix.literal) : Number.NaN;
    let first = true;

    for (const token of piecesOf(declaration)) {
        if (/^\d*\.?\d+px$/i.test(token.text)) {
            // In the `font` shorthand only the first length is the size; the next, after a slash, is the line height.
            if (
                Number.parseFloat(token.text) === pixels &&
                (declaration.property !== "font" || first)
            ) {
                found.push({ start: base + token.start, end: base + token.end });
            }

            first = false;
        }
    }

    return found;
}

// A finding is fixed where the place is certain: the inline style of the one element with the finding's `data-pid`, a rule with the finding's selector, or the only place that sets the property to the literal.
export function applyExactFixes(
    content: string,
    findings: CheckFinding[],
    system: DesignSystem,
): FixResult {
    const skipped: FixResult["skipped"] = [];
    const edits = new Map<number, { start: number; end: number; text: string }>();
    const skip = (finding: CheckFinding, reason: string) =>
        skipped.push({ id: finding.id ?? "", reason });

    if (typeof content !== "string" || content.length > MAX_CONTENT) {
        for (const finding of findings) {
            skip(finding, "The page is too large to rewrite.");
        }

        return { content, applied: 0, skipped };
    }

    const scanned = regions(content);
    const all = scanned.regions.flatMap((region) => declarations(content, region));
    const byProperty = new Map<string, number[]>();

    all.forEach((declaration, index) => {
        const list = byProperty.get(declaration.property);

        if (list === undefined) {
            byProperty.set(declaration.property, [index]);
        } else {
            list.push(index);
        }
    });
    const fixable = findings.filter((finding) => finding.fix !== undefined);

    for (const finding of findings) {
        const fix = finding.fix;

        if (fix === undefined) {
            skip(finding, "Not fixable: the value is not exactly a token's.");

            continue;
        }

        const problem = verify(fix, system);

        if (problem !== undefined) {
            skip(finding, problem);

            continue;
        }

        const properties = new Set(fix.properties.map((property) => property.toLowerCase()));
        const matches: Match[] = [];

        if (fix.kind === "color") {
            const literal = parseColor(fix.literal);

            for (const match of literal === undefined
                ? []
                : colorMatches(all, literal, properties)) {
                matches.push(match);
            }
        } else {
            const order = [...properties]
                .flatMap((property) => byProperty.get(property) ?? [])
                .sort((a, b) => a - b);

            for (const index of order) {
                const declaration = all[index]!;

                for (const place of placesIn(content, declaration, fix)) {
                    matches.push({ ...place, declaration });
                }
            }
        }

        const real =
            fix.kind === "font"
                ? matches.filter(
                      (match) =>
                          families(content.slice(match.start, match.end)).join(",") ===
                          families(fix.literal).join(","),
                  )
                : matches;

        if (real.length === 0) {
            skip(
                finding,
                "The literal is not in a style element or a style attribute of the page: it may come from a script or a file.",
            );

            continue;
        }

        const where = finding.elements ?? [{ selector: finding.selector, pid: finding.pid }];
        const owns = new Set(
            where
                .map((item) => item.pid)
                .filter((pid): pid is string => pid !== undefined && scanned.pids.get(pid) === 1),
        );
        const wanted = new Set(
            where
                .filter((item) => item.selector !== "")
                .map((item) => normalizeSelector(item.selector)),
        );
        const certain = real.filter(
            (match) =>
                (match.declaration.inline &&
                    match.declaration.pid !== undefined &&
                    owns.has(match.declaration.pid)) ||
                (!match.declaration.inline &&
                    match.declaration.selector !== undefined &&
                    match.declaration.selector.split(",").some((each) => wanted.has(each))),
        );
        const together = fixable
            .filter(
                (other) =>
                    other.fix?.literal === fix.literal &&
                    other.fix.token === fix.token &&
                    other.fix.properties.some((property) => properties.has(property.toLowerCase())),
            )
            .reduce((total, other) => total + (other.elements?.length ?? 1), 0);
        // Every place is accounted for when there are as many elements in the findings given as places (they are the same
        // defect: fix them together); else the places that are certain; else the only place there is.
        const chosen = together >= real.length || real.length === 1 ? real : certain;

        if (chosen.length === 0) {
            skip(
                finding,
                `${real.length} places set ${fix.properties[0]} to ${fix.literal} and none is certain to be this element's: fix them together.`,
            );

            continue;
        }

        for (const match of chosen) {
            edits.set(match.start, {
                start: match.start,
                end: match.end,
                text: `var(${fix.cssVar})`,
            });
        }
    }

    // Apply from the end, so that offsets stay true.
    let result = content;

    for (const edit of [...edits.values()].sort((a, b) => b.start - a.start)) {
        result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
    }

    return { content: result, applied: edits.size, skipped };
}
