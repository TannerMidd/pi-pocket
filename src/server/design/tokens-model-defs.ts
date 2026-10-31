import type { TokenType } from "./system-types.ts";
import {
    LIMITS,
    MODE_NAME,
    NAME,
    RESERVED,
    clip,
    extensionOf,
    isObject,
    plain,
    type Obj,
    type RawSystem,
} from "./tokens-base.ts";
import { nearest, type Report, type SuggestionBudget } from "./tokens-model-report.ts";

export interface RawToken {
    name: string;
    path: string[];
    file: string;
    value: unknown;
    type?: string;
    description?: string;
    deprecated?: boolean | string;
    ext: Obj;
}

function collect(root: unknown, file: string, report: Report): RawToken[] {
    const found: RawToken[] = [];

    if (!isObject(root)) {
        report.error(
            `The file must hold one JSON object (a DTCG token group), not ${Array.isArray(root) ? "an array" : typeof root}.`,
            file,
        );

        return found;
    }

    const token = (node: Obj, path: string[], inherited: { type?: string; tier?: string }) => {
        const name = path.join(".");

        for (const key of Object.keys(node)) {
            if (!key.startsWith("$")) {
                report.error(
                    `"${name}" has a $value, so it is a token and cannot hold "${clip(key, 30)}". Put tokens in a group, beside each other.`,
                    file,
                    name,
                );

                return;
            }
        }

        const own = node.$type;
        const ext = {
            ...(inherited.tier === undefined ? {} : { tier: inherited.tier }),
            ...extensionOf(node),
        };

        if (own !== undefined && typeof own !== "string") {
            report.error(`$type of "${name}" must be a string such as "color".`, file, name);

            return;
        }

        const raw: RawToken = {
            name,
            path,
            file,
            value: node.$value,
            ext,
        };
        const type = own ?? inherited.type;

        if (type !== undefined) {
            raw.type = type;
        }

        if (typeof node.$description === "string") {
            raw.description = plain(node.$description).slice(0, 300);
        }

        if (typeof node.$deprecated === "boolean" || typeof node.$deprecated === "string") {
            raw.deprecated =
                typeof node.$deprecated === "string"
                    ? plain(node.$deprecated).slice(0, 200)
                    : node.$deprecated;
        }

        found.push(raw);
    };

    const group = (node: Obj, path: string[], inherited: { type?: string; tier?: string }) => {
        if (path.length > LIMITS.depth) {
            report.error(
                `Groups nest more than ${LIMITS.depth} levels deep at "${path.join(".")}".`,
                file,
            );

            return;
        }

        const type = typeof node.$type === "string" ? node.$type : inherited.type;
        const tier = extensionOf(node).tier ?? inherited.tier;
        const next = {
            ...(type === undefined ? {} : { type }),
            ...(typeof tier === "string" ? { tier } : {}),
        };

        if (node.$extends !== undefined) {
            report.warn(
                `$extends on "${path.join(".") || "the root"}" is not supported; it is ignored. Copy the tokens instead.`,
                file,
            );
        }

        for (const key of Object.keys(node)) {
            const child = node[key];

            if (key === "$root") {
                if (isObject(child) && Object.hasOwn(child, "$value")) {
                    token(child, path, next);
                } else {
                    report.error('"$root" must be a token: { "$value": … }.', file, path.join("."));
                }

                continue;
            }

            if (key.startsWith("$")) {
                continue;
            }

            const here = [...path, key];
            const name = here.join(".");

            if (!NAME.test(key) || RESERVED.has(key)) {
                report.error(
                    `The name "${clip(key, 30)}" in "${path.join(".") || "the root"}" must use letters, digits, "-" or "_" (1 to 64 characters), not a dot, space, or symbol. Rename it, for example "${clip(
                        key
                            .slice(0, 64)
                            .replace(/[^A-Za-z0-9_-]+/g, "-")
                            .replace(/^-+|-+$/g, "") || "x",
                        30,
                    )}".`,
                    file,
                );

                continue;
            }

            if (!isObject(child)) {
                report.error(
                    `"${name}" is ${Array.isArray(child) ? "an array" : `a plain ${typeof child}`}. A token is an object: { "$value": ${typeof child === "string" ? JSON.stringify(clip(child, 20)) : "…"} }. A group holds tokens or groups.`,
                    file,
                    name,
                );
            } else if (Object.hasOwn(child, "$value")) {
                token(child, here, next);
            } else if (
                Object.hasOwn(child, "value") &&
                !Object.keys(child).some((each) => isObject(child[each]) && !each.startsWith("$"))
            ) {
                report.error(
                    `"${name}" uses "value"${Object.hasOwn(child, "type") ? ' and "type"' : ""}. DTCG writes "$value" and "$type" with a dollar sign.`,
                    file,
                    name,
                );
            } else {
                group(child, here, next);
            }
        }
    };

    group(root, [], {});

    return found;
}

export interface Def {
    name: string;
    path: string[];
    cssVar: string;
    base: RawToken;
    over: Map<string, RawToken>;
    type?: TokenType;
}

export function collectDefinitions(
    raw: RawSystem,
    report: Report,
): { defs: Map<string, Def>; byVar: Map<string, string> } {
    const defs = new Map<string, Def>();
    const byVar = new Map<string, string>();

    if (raw.tokens === undefined) {
        report.warn(
            "There is no tokens.json yet. Add tokens with set, or write the whole file with init.",
            "tokens.json",
        );
    }

    for (const token of raw.tokens === undefined
        ? []
        : collect(raw.tokens, "tokens.json", report)) {
        if (defs.size >= LIMITS.tokens) {
            report.error(
                `tokens.json has more than ${LIMITS.tokens} tokens; the rest are ignored.`,
                "tokens.json",
            );

            break;
        }

        if (defs.has(token.name)) {
            report.error(
                `"${token.name}" is defined twice (as a token and as $root of a group).`,
                token.file,
                token.name,
            );

            continue;
        }

        const cssVar = `--${token.path.join("-")}`;
        const clash = byVar.get(cssVar);

        if (clash !== undefined) {
            report.error(
                `"${token.name}" and "${clash}" both become ${cssVar}. Rename one of them.`,
                token.file,
                token.name,
            );

            continue;
        }

        byVar.set(cssVar, token.name);
        defs.set(token.name, {
            name: token.name,
            path: token.path,
            cssVar,
            base: token,
            over: new Map(),
        });
    }

    return { defs, byVar };
}

export function collectModes(
    raw: RawSystem,
    defaultMode: string,
    defs: Map<string, Def>,
    report: Report,
    suggestionBudget: SuggestionBudget,
): { modes: string[]; modeMeta: Map<string, unknown> } {
    const modeNames: string[] = [];
    const modeMeta = new Map<string, unknown>();

    for (const [mode, file] of [...raw.modes].sort((a, b) => a[0].localeCompare(b[0]))) {
        const label = `tokens.${mode}.json`;

        if (!MODE_NAME.test(mode) || mode === defaultMode) {
            report.error(
                mode === defaultMode
                    ? `${label} has the name of the default mode ("${mode}"). Rename the file, or change the default mode in tokens.json.`
                    : `The mode name "${clip(mode, 30)}" must be lowercase letters, digits, and hyphens.`,
                label,
            );

            continue;
        }

        if (modeNames.length >= LIMITS.modes) {
            report.error(`There are more than ${LIMITS.modes} modes; ${label} is ignored.`, label);

            continue;
        }

        modeNames.push(mode);
        modeMeta.set(mode, isObject(file) ? extensionOf(file).colorScheme : undefined);

        for (const token of collect(file, label, report)) {
            const def = defs.get(token.name);

            if (def === undefined) {
                const close = nearest(token.name, defs.keys(), suggestionBudget);

                report.error(
                    `"${token.name}" is not in tokens.json, so it has no default value.${close === undefined ? " Add it to tokens.json first." : ` Did you mean "${close}"?`}`,
                    label,
                    token.name,
                );
            } else {
                def.over.set(mode, token);
            }
        }
    }

    // Dark mode first, after the default; the rest in name order.
    modeNames.sort((a, b) => (a === "dark" ? -1 : b === "dark" ? 1 : a.localeCompare(b)));

    return { modes: [defaultMode, ...modeNames], modeMeta };
}
