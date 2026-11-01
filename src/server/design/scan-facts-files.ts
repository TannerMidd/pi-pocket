import { colorsIn, pageStyles, parseStyles, stripComments } from "./scan-parse.ts";
import { importTokens } from "./scan-import.ts";
import { bump, emptyKinds, entry, type Facts, modeOf } from "./scan-facts.ts";
import { colorFact, ingestStyles } from "./scan-facts-use.ts";
import { tailwindConfig } from "./scan-tailwind.ts";

const CLASS_USE =
    /(?<![\w-])(?:bg|text|border|ring|fill|stroke|outline|from|to|via|divide|decoration|accent|caret|placeholder|shadow)-([a-z][a-z0-9]*(?:-[a-z0-9]+)*)(?:\/\d+)?(?![\w-])/g;

const DEFAULT_COLOR_CLASS =
    /(?<![\w-])(bg|text|border|ring|outline|fill|stroke|divide|from|to|via|decoration|accent|caret|placeholder)-((?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:50|[1-9]00|950)|white|black)(?:\/\d+)?(?![\w-])/g;

const CLASS_KIND: Record<string, "bg" | "text" | "border" | "fill"> = {
    bg: "bg",
    from: "bg",
    to: "bg",
    via: "bg",
    text: "text",
    placeholder: "text",
    decoration: "text",
    caret: "text",
    accent: "text",
    border: "border",
    ring: "border",
    outline: "border",
    divide: "border",
    fill: "fill",
    stroke: "fill",
};

const TEXT_CLASS = /(?<![\w-])text-(xs|sm|base|lg|xl|[2-9]xl)(?![\w-])/g;

const ROUNDED_CLASS = /(?<![\w-])rounded(?:-(none|xs|sm|md|lg|xl|2xl|3xl|full))?(?![\w-])/g;

const SPACING_CLASS =
    /(?<![\w-])(?:p|px|py|pt|pr|pb|pl|ps|pe|m|mx|my|mt|mr|mb|ml|ms|me|gap|gap-x|gap-y|space-x|space-y)-(\d+(?:\.\d+)?)(?![\w-])/g;

const ARBITRARY_COLOR_CLASS =
    /(?<![\w-])(bg|text|border|fill|stroke|ring|outline|from|to|via)-\[(#[0-9a-fA-F]{3,8}|(?:rgba?|hsla?|oklch|oklab)\([^\])]*\))\]/g;

const ROOT_CLASS = /<(?:body|html)\b[^>]*?\bclass(?:Name)?\s*=\s*["'`{]+([^"'`}]*)/gi;

const MARKUP_CLASS = /\bclass(?:Name)?\s*=\s*(?:["'`]|\{\s*["'`])([^"'`}]*)/g;

// The caps bound the work on a large bundle.
function eachMatch(
    text: string,
    pattern: RegExp,
    cap: number,
    each: (match: RegExpMatchArray) => void,
): void {
    let seen = 0;

    for (const match of text.matchAll(pattern)) {
        if (++seen > cap) {
            break;
        }

        each(match);
    }
}

function classNames(list: string, max: number): string[] {
    return list
        .split(/\s+/)
        .slice(0, max)
        .filter((name) => /^[\w-]{1,40}$/.test(name));
}

function lineOfBlock(raw: string, block: string): number | undefined {
    const at = raw.indexOf(block);

    return at === -1 ? undefined : 1 + (raw.slice(0, at).match(/\n/g)?.length ?? 0);
}

export function ingestFile(facts: Facts, rel: string, extension: string, raw: string): void {
    const text = stripComments(raw);
    const parts = rel.split("/");
    const named = modeOf(parts.at(-1)!.replace(/\.[^.]+$/, ""));
    const mode = named ?? (parts.length > 1 ? modeOf(parts.at(-2)!) : undefined);

    facts.fileMode = mode === "dark" || mode === "light" ? mode : undefined;
    facts.file = rel;

    const useVar = (match: RegExpMatchArray) => bump(facts.varUse, match[1]!);

    if (extension === ".scss" || extension === ".less") {
        eachMatch(text, /[$@]([A-Za-z_][\w-]*)(?!\s*:)/g, Infinity, useVar);
    }

    eachMatch(text, /var\(\s*--([\w-]+)/g, Infinity, useVar);

    if (
        /@import\s+["']tailwindcss|@tailwind\s+base|@theme\b|tailwind\.config/.test(text) ||
        /(?:^|\/)tailwind\.config\./.test(rel)
    ) {
        facts.tailwind = true;
    }

    if (/@import\s+["']tailwindcss|@theme\b/.test(text)) {
        facts.tailwindVersion = 4;
    }

    if (extension === ".json") {
        importTokens(facts.imported, rel, raw);

        return;
    }

    const isStyle = /^\.(?:css|scss|less|pcss|postcss)$/.test(extension);
    const isPage = /^\.(?:html|htm|vue|svelte|astro|mdx|php|erb|hbs|njk)$/.test(extension);
    const isScript = /^\.(?:[cm]?[jt]s|[jt]sx)$/.test(extension);

    if (isStyle) {
        ingestStyles(facts, rel, parseStyles(raw, 1));
    } else if (isPage) {
        const { blocks, inline } = pageStyles(raw);

        // Each block is looked for in the page from its start: a page with thousands of them is cut.
        for (const block of blocks.slice(0, 200)) {
            ingestStyles(facts, rel, parseStyles(block, lineOfBlock(raw, block)));
        }

        ingestStyles(facts, rel, inline);
    } else if (isScript && /(?:^|\/)tailwind\.config\.[cm]?[jt]s$/.test(rel)) {
        tailwindConfig(facts, rel, raw);
    }

    if (!isPage && !isScript) {
        return;
    }

    eachMatch(text, DEFAULT_COLOR_CLASS, 8000, (match) => {
        entry(facts.classColors, match[2]!, emptyKinds)[CLASS_KIND[match[1]!] ?? "other"] += 1;
    });
    eachMatch(text, ARBITRARY_COLOR_CLASS, 2000, (match) => {
        const kind = CLASS_KIND[match[1]!] ?? "border";

        for (const color of colorsIn(match[2]!.replace(/_/g, " "))) {
            colorFact(facts.colors, color.hex, color.text)[kind] += 1;
        }
    });
    eachMatch(text, ROOT_CLASS, Infinity, (match) => {
        for (const name of classNames(match[1]!, 20)) {
            facts.rootClasses.add(name);
        }
    });
    eachMatch(text, MARKUP_CLASS, 4000, (match) => {
        for (const name of classNames(match[1]!, 40)) {
            bump(facts.classCount, name);
        }
    });
    eachMatch(text, CLASS_USE, 8000, (match) => bump(facts.classUse, match[1]!));
    eachMatch(text, SPACING_CLASS, 8000, (match) => bump(facts.classSpacing, Number(match[1]) * 4));
    eachMatch(text, TEXT_CLASS, 8000, (match) => bump(facts.classText, match[1]!));
    eachMatch(text, ROUNDED_CLASS, 8000, (match) => {
        bump(facts.classRadius, match[1] ?? "default");
    });
}
