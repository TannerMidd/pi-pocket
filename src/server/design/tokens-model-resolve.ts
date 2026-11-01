import type { TokenType } from "./system-types.ts";
import { TOKEN_TYPES, clip } from "./tokens-base.ts";
import type { Def } from "./tokens-model-defs.ts";
import { nearest, type Report, type SuggestionBudget } from "./tokens-model-report.ts";
import { convert, inferType, refName, wholeRef, type Ctx, type Out } from "./tokens-values.ts";

/** The longest chain of references that is followed; a longer one is a problem, not a stack overflow. */
const MAX_REFERENCE_CHAIN = 200;

export function assignTypes(defs: Map<string, Def>, report: Report): void {
    const types = new Map<string, TokenType | null>();

    const typeOf = (def: Def, visiting: string[] = []): TokenType | undefined => {
        if (types.has(def.name)) {
            return types.get(def.name) ?? undefined;
        }

        // A reference loop has no type to take; the loop is reported when the values are resolved.
        if (visiting.includes(def.name)) {
            return undefined;
        }

        const declared = def.base.type;
        const target = wholeRef(def.base.value);
        let type: TokenType | undefined;

        if (declared !== undefined) {
            if ((TOKEN_TYPES as readonly string[]).includes(declared)) {
                type = declared as TokenType;
            } else {
                report.error(
                    `Unknown $type "${clip(declared, 30)}". Use one of ${TOKEN_TYPES.join(", ")}.`,
                    def.base.file,
                    def.name,
                );
            }
        } else if (target !== undefined) {
            // A missing target is reported when the value is resolved.
            const other = defs.get(refName(target));

            type =
                other === undefined || visiting.length >= MAX_REFERENCE_CHAIN
                    ? undefined
                    : typeOf(other, [...visiting, def.name]);
        } else {
            type = inferType(def.base.value);

            if (type === undefined) {
                report.error(
                    `"${def.name}" has no $type and its value does not show one. Add "$type" to the token or its group: one of ${TOKEN_TYPES.join(", ")}.`,
                    def.base.file,
                    def.name,
                );
            } else {
                report.warn(
                    `"${def.name}" has no $type; it is read as ${type} from its value. Add "$type": "${type}".`,
                    def.base.file,
                    def.name,
                );
            }
        }

        // A type cut short by a loop is not final: leave it for the loop's first token to settle.
        if (type !== undefined || visiting.length === 0) {
            types.set(def.name, type ?? null);
        }

        return type;
    };

    for (const def of defs.values()) {
        def.type = typeOf(def);

        for (const [mode, over] of def.over) {
            if (over.type !== undefined && def.type !== undefined && over.type !== def.type) {
                report.error(
                    `"${def.name}" is ${def.type} in tokens.json but ${over.type} in tokens.${mode}.json. A mode changes values, not types.`,
                    over.file,
                    def.name,
                );
                def.over.delete(mode);
            }
        }
    }
}

function resolveMode(
    mode: string,
    defs: Map<string, Def>,
    report: Report,
    suggestionBudget: SuggestionBudget,
): Map<string, Out | null> {
    const memo = new Map<string, Out | null>();
    const stack: string[] = [];

    const resolve = (key: string): Out | null => {
        const cached = memo.get(key);

        if (cached !== undefined) {
            return cached;
        }

        const def = defs.get(key)!;
        const source = def.over.get(mode) ?? def.base;

        stack.push(key);

        const ctx: Ctx = {
            error: (message) => report.error(message, source.file, def.name),
            warn: (message) => report.warn(message, source.file, def.name),
            ref(text, expect) {
                const targetName = refName(text);
                const target = defs.get(targetName);

                if (target === undefined) {
                    const close = nearest(targetName, defs.keys(), suggestionBudget);

                    return report.error(
                        `The reference {${clip(targetName)}} does not exist.${close === undefined ? "" : ` Did you mean {${close}}?`}`,
                        source.file,
                        def.name,
                    );
                }

                if (stack.includes(targetName)) {
                    const loop = stack.slice(stack.indexOf(targetName));
                    const at = loop.indexOf([...loop].sort()[0]!);
                    const turned = [...loop.slice(at), ...loop.slice(0, at)];

                    return report.error(
                        `Reference cycle: ${[...turned, turned[0]!].join(" → ")}. Make one of them a real value.`,
                        source.file,
                        turned[0],
                    );
                }

                if (stack.length >= MAX_REFERENCE_CHAIN) {
                    return report.error(
                        `A chain of more than ${MAX_REFERENCE_CHAIN} references is not resolved. Make one of them a real value.`,
                        source.file,
                        def.name,
                    );
                }

                const out = resolve(targetName);

                if (out === null || target.type === undefined) {
                    // The cause is reported where it is.
                    return undefined;
                }

                if (expect !== undefined && !expect.includes(target.type)) {
                    return report.error(
                        `{${targetName}} is a ${target.type}, but a ${expect.join(" or ")} is needed here.`,
                        source.file,
                        def.name,
                    );
                }

                return { ...out, name: targetName, type: target.type, cssVar: target.cssVar };
            },
        };
        let out: Out | null = null;

        if (def.type !== undefined) {
            out = convert(def.type, source.value, ctx) ?? null;
        } else if (wholeRef(source.value) !== undefined) {
            // No type to take from the target: look at the reference, to report a missing target or a loop.
            ctx.ref(refName(wholeRef(source.value)!));
        }

        stack.pop();
        memo.set(key, out);

        return out;
    };

    for (const key of defs.keys()) {
        resolve(key);
    }

    return memo;
}

export function resolveModes(
    modes: string[],
    defs: Map<string, Def>,
    report: Report,
    suggestionBudget: SuggestionBudget,
): Map<string, Map<string, Out | null>> {
    const results = new Map<string, Map<string, Out | null>>();

    for (const mode of modes) {
        results.set(mode, resolveMode(mode, defs, report, suggestionBudget));
    }

    return results;
}
