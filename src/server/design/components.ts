// Specimen markup and CSS are untrusted: they reach people only in a sandboxed frame, and `components.css` only as a style asset.
// The parser keeps scripts, event handlers, `@import`, and markup inside the CSS out.
import type { ComponentSpec, SystemProblem } from "./system-types.ts";

export const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const STATE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

interface KnownTokens {
    byVar: ReadonlyMap<string, string>;
    names: ReadonlySet<string>;
}

const clip = (text: string, max = 60) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const plain = (text: string) =>
    // Single line, without control or invisible characters: these strings reach the prompt and the UI.
    text
        .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ")
        .replace(/\s+/g, " ")
        .trim();

function templates(html: string): { attributes: string; inner: string }[] {
    const found: { attributes: string; inner: string }[] = [];
    const tag = /<(\/?)template\b([^>]*)>/gi;
    let depth = 0;
    let start = 0;
    let attributes = "";

    for (const match of html.matchAll(tag)) {
        if (match[1] === "") {
            if (depth === 0) {
                start = match.index + match[0].length;
                attributes = match[2]!;
            }

            depth += 1;
        } else if (depth > 0) {
            depth -= 1;

            if (depth === 0) {
                found.push({ attributes, inner: html.slice(start, match.index) });
            }
        }
    }

    return found;
}

function selectors(css: string): string[] {
    const text = css.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, " ");
    const found: string[] = [];
    const stack: boolean[] = [];
    let prelude = "";

    for (const char of text) {
        if (char === "{") {
            const head = prelude.trim();

            if (head.startsWith("@")) {
                stack.push(/^@(media|supports|layer|container|scope)\b/i.test(head));
            } else {
                if (stack.length === 0 || stack.at(-1) === true) {
                    found.push(head);
                }

                stack.push(false);
            }

            prelude = "";
        } else if (char === "}") {
            stack.pop();
            prelude = "";
        } else if (char === ";") {
            prelude = "";
        } else {
            prelude += char;
        }
    }

    return found;
}

const UNSCOPED = (selector: string) =>
    selector
        .split(",")
        .map((part) => part.trim())
        .some((part) => part !== "" && !/[.#[]/.test(part.replace(/:(root|host)\b/g, "")));

export function parseComponent(
    slug: string,
    html: string,
    known: KnownTokens,
): { spec?: ComponentSpec; problems: SystemProblem[] } {
    const file = `components/${slug}.html`;
    const problems: SystemProblem[] = [];
    const error = (message: string) => problems.push({ level: "error", file, message });
    const warn = (message: string) => problems.push({ level: "warning", file, message });

    if (!SLUG.test(slug)) {
        error(`The component name "${clip(slug)}" must be lowercase letters, digits, and hyphens.`);

        return { problems };
    }

    // Scripts: only the description block, which is data.
    let meta: unknown;
    let metaCount = 0;

    for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
        if (/\bid\s*=\s*["']?pocket-component\b/i.test(match[1]!)) {
            metaCount += 1;

            try {
                meta = JSON.parse(match[2]!);
            } catch (cause) {
                error(
                    `The pocket-component JSON is not valid (${(cause as Error).message}). Fix it, or remove the block.`,
                );
            }
        } else {
            error(
                'A specimen is static markup: remove the <script> (only <script type="application/json" id="pocket-component"> is allowed).',
            );
        }
    }

    if (metaCount > 1) {
        error('Keep one <script id="pocket-component"> block.');
    }

    const css = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)]
        .map((match) => match[1]!.trim())
        .filter((block) => block !== "")
        .join("\n\n");

    if (/<\/|<!--/.test(css)) {
        error("The CSS contains markup (`</` or `<!--`). A style block holds only CSS.");
    }

    if (/@import\b/i.test(css)) {
        error(
            "The CSS uses @import. A specimen is self-contained: put the rules in its style block.",
        );
    }

    if (/url\(\s*["']?\s*(?:https?:)?\/\//i.test(css)) {
        warn("The CSS loads a remote url(): a specimen should not depend on the network.");
    }

    const markup: Record<string, string> = {};
    const order: string[] = [];

    for (const { attributes, inner } of templates(html)) {
        const state = /\bdata-state\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attributes);
        const name = state?.[1] ?? state?.[2] ?? state?.[3];

        if (name === undefined) {
            warn(
                'A <template> has no data-state attribute; it is ignored. Write <template data-state="default">.',
            );
        } else if (!STATE.test(name)) {
            error(
                `The state name "${clip(name)}" must be letters, digits, hyphens, or underscores.`,
            );
        } else if (Object.hasOwn(markup, name)) {
            error(`The state "${name}" has two templates.`);
        } else if (/<script\b|\son[a-z]+\s*=/i.test(inner)) {
            error(
                `The state "${name}" has a script or an inline event handler. A specimen is static markup.`,
            );
        } else {
            markup[name] = inner.trim();
            order.push(name);
        }
    }

    if (order.length === 0 && !problems.some((problem) => problem.level === "error")) {
        error(
            'The specimen has no <template data-state="default">…</template>. Add one for each state.',
        );
    }

    const object =
        typeof meta === "object" && meta !== null && !Array.isArray(meta)
            ? (meta as Record<string, unknown>)
            : undefined;

    if (meta !== undefined && object === undefined) {
        error(
            "The pocket-component JSON must be an object: { name, description, states, usage, tokens }.",
        );
    }

    if (meta === undefined && metaCount === 0) {
        warn(
            'No <script type="application/json" id="pocket-component"> block: add { "name", "description", "states", "usage", "tokens" }.',
        );
    }

    const text = (value: unknown, max: number) =>
        typeof value === "string" ? plain(value).slice(0, max) : "";
    const list = (value: unknown, max: number, each: number) =>
        Array.isArray(value)
            ? value
                  .filter((item): item is string => typeof item === "string")
                  .map((item) => plain(item).slice(0, each))
                  .filter((item) => item !== "")
                  .slice(0, max)
            : [];
    const name =
        text(object?.name, 80) ||
        slug
            .split("-")
            .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
            .join(" ");
    let states = list(object?.states, 12, 32).filter((state) => STATE.test(state));

    if (states.length === 0) {
        states = order;
    } else {
        for (const state of states) {
            if (!Object.hasOwn(markup, state)) {
                error(
                    `The state "${state}" is listed but has no <template data-state="${state}">.`,
                );
            }
        }

        for (const state of order) {
            if (!states.includes(state)) {
                warn(
                    `The template for the state "${state}" is not in "states". Add it to the list.`,
                );
                states.push(state);
            }
        }
    }

    const used = new Set<string>();
    const unknownVars = new Set<string>();
    // A variable the component sets itself (`--notice-bg: …`) is its own, not a missing token.
    const own = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map((match) => match[1]!));

    for (const match of css.matchAll(/var\(\s*(--[\w-]+)/g)) {
        const token = known.byVar.get(match[1]!);

        if (token !== undefined) {
            used.add(token);
        } else if (!own.has(match[1]!) && !/^--(?:pocket|_|local|tw)\b/.test(match[1]!)) {
            unknownVars.add(match[1]!);
        }
    }

    const declared = list(object?.tokens, 60, 80);

    for (const token of declared) {
        if (!known.names.has(token)) {
            warn(`The tokens list names "${token}", which is not a token.`);
        }
    }

    if (unknownVars.size > 0) {
        const names = [...unknownVars].slice(0, 5).join(", ");

        warn(
            `The CSS uses ${unknownVars.size} variable${unknownVars.size === 1 ? "" : "s"} that ${unknownVars.size === 1 ? "is" : "are"} not tokens (${names}${unknownVars.size > 5 ? ", …" : ""}). Use tokens, or add them.`,
        );
    }

    const raw = css.match(/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/gi);

    if (raw !== null) {
        warn(
            `The CSS has ${raw.length} raw color${raw.length === 1 ? "" : "s"} (${clip([...new Set(raw)].slice(0, 3).join(", "), 40)}). Use color tokens, so the component follows every mode.`,
        );
    }

    const loose = selectors(css).filter(UNSCOPED);

    if (loose.length > 0) {
        warn(
            `The CSS has selectors with no class (${clip(loose.slice(0, 3).join(" | "), 60)}). They restyle every such element on a page: scope them with a class.`,
        );
    }

    if (problems.some((problem) => problem.level === "error")) {
        return { problems };
    }

    const usage = object?.usage;
    const usageObject =
        typeof usage === "object" && usage !== null && !Array.isArray(usage)
            ? (usage as Record<string, unknown>)
            : undefined;
    const spec: ComponentSpec = {
        slug,
        name,
        description: text(object?.description, 500),
        states: states.length > 0 ? states : order,
        markup,
        css,
        tokens: [...new Set([...declared, ...used])],
    };

    if (usageObject !== undefined) {
        spec.usage = { do: list(usageObject.do, 12, 200), dont: list(usageObject.dont, 12, 200) };
    }

    return { spec, problems };
}
