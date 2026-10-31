import { contrastRatio, parseColor } from "./color.ts";
import type { ContrastExemption, ResolvedToken } from "./system-types.ts";
import { isObject } from "./tokens-base.ts";
import type { Def } from "./tokens-model-defs.ts";
import type { Report } from "./tokens-model-report.ts";
import { rampProblems } from "./tokens-ramps.ts";
import { refName, wholeRef, WHOLE_REF } from "./tokens-values.ts";

type Schemes = Record<string, "light" | "dark">;

// A token named for its own value (`space.16` = 16px, `duration.140` = 140ms) is renamed whenever the value changes.
export function warnValueNamedTokens(
    tokens: ResolvedToken[],
    modes: string[],
    report: Report,
): void {
    const named = new Map<string, string[]>();

    for (const token of tokens) {
        const step = /^\d+(?:\.\d+)?$/.exec(token.path.at(-1)!);
        const literal = token.modes[modes[0]!]?.literal ?? "";
        const amount = (type: string) =>
            type === "dimension"
                ? /^(\d*\.?\d+)(px|rem)?$/.exec(literal)
                : /^(\d*\.?\d+)(ms|s)$/.exec(literal);
        const found =
            step === null || (token.type !== "dimension" && token.type !== "duration")
                ? null
                : amount(token.type);

        if (found !== null && step !== null && found[1] !== "0") {
            const number = Number(found[1]);
            const value =
                token.type === "dimension"
                    ? found[2] === "rem"
                        ? number * 16
                        : found[2] === "px"
                          ? number
                          : undefined
                    : found[2] === "s"
                      ? number * 1000
                      : number;

            if (value !== undefined && value === Number(step[0])) {
                const group = token.path.slice(0, -1).join(".");

                named.set(group, [...(named.get(group) ?? []), token.name]);
            }
        }
    }

    for (const [group, names] of named) {
        const first = names[0]!;

        report.warn(
            `${names.length === 1 ? `"${first}" is` : `${names.length} tokens in "${group}" are`} named for ${names.length === 1 ? "its" : "their"} own value (${names
                .slice(0, 4)
                .map((each) => each.split(".").at(-1))
                .join(
                    ", ",
                )}${names.length > 4 ? ", …" : ""}): the name has to change when the value does.`,
            "tokens.json",
            first,
            `Rename ${names.length === 1 ? `"${first}"` : "each"} to a role (for example "${group}.card"), or to a step of a scale ("${group}.4", "${group}.5"), and point the tokens that use ${names.length === 1 ? "it" : "them"} at the new name.`,
        );
    }
}

export function warnRampOrder(tokens: ResolvedToken[], modes: string[], report: Report): void {
    for (const problem of rampProblems(tokens, modes)) {
        report.warn(problem.message, "tokens.json", problem.second, problem.fix);
    }
}

// Semantic colors should name a primitive, so that a mode can change the palette in one place.
export function warnRawSemanticColors(
    tokens: ResolvedToken[],
    defs: Map<string, Def>,
    report: Report,
): void {
    if (tokens.some((token) => token.type === "color" && token.tier === "primitive")) {
        const raws = tokens.filter(
            (token) =>
                token.type === "color" &&
                token.tier === "semantic" &&
                wholeRef(defs.get(token.name)!.base.value) === undefined,
        );

        if (raws.length > 0) {
            report.warn(
                `${raws.length} semantic color${raws.length === 1 ? " holds a raw value" : "s hold raw values"} instead of references (${raws
                    .slice(0, 4)
                    .map((token) => token.name)
                    .join(
                        ", ",
                    )}${raws.length > 4 ? ", …" : ""}). Reference a primitive, such as {color.gray.900}, so that a mode changes the palette in one place.`,
                "tokens.json",
            );
        }
    }
}

function checkTokenContrast(
    token: ResolvedToken,
    defs: Map<string, Def>,
    byName: Map<string, ResolvedToken>,
    modes: string[],
    schemes: Schemes,
    report: Report,
): void {
    const spec = defs.get(token.name)!.base.ext.contrast;
    const pairs = (Array.isArray(spec) ? spec : spec === undefined ? [] : [spec]).slice(0, 4);
    const failing: string[] = [];
    const exempted: string[] = [];
    let exemptWord = "";

    for (const [at, pair] of pairs.entries()) {
        const target =
            isObject(pair) && typeof pair.on === "string"
                ? refName(WHOLE_REF.exec(pair.on)?.[1] ?? pair.on)
                : undefined;
        const on = target === undefined ? undefined : byName.get(target);
        const min = isObject(pair) && typeof pair.min === "number" ? pair.min : 4.5;
        const exempt: ContrastExemption | undefined =
            isObject(pair) && (pair.exempt === "disabled" || pair.exempt === "decorative")
                ? pair.exempt
                : undefined;

        if (isObject(pair) && pair.exempt !== undefined && exempt === undefined) {
            report.error(
                `The contrast pair of "${token.name}" has exempt ${JSON.stringify(pair.exempt)}; it must be "disabled" or "decorative".`,
                "tokens.json",
                token.name,
            );

            break;
        }

        // The color it sits on failed: that error says why, and this one would only repeat it.
        if (on === undefined && target !== undefined && defs.has(target)) {
            break;
        }

        if (
            token.type !== "color" ||
            on === undefined ||
            on.type !== "color" ||
            !(min >= 1 && min <= 21)
        ) {
            report.error(
                token.type !== "color"
                    ? `"${token.name}" declares a contrast pair, but it is a ${token.type}, not a color.`
                    : `The contrast pair of "${token.name}" must be { "on": "{color.bg.surface}", "min": 4.5 } with "on" an existing color token and "min" from 1 to 21.`,
                "tokens.json",
                token.name,
            );

            break;
        }

        const entry = { on: on.name, min, ...(exempt === undefined ? {} : { exempt }) };

        if (at === 0) {
            token.contrast = entry;
        }

        (token.contrasts ??= []).push(entry);

        for (const mode of modes) {
            const front = parseColor(token.modes[mode]!.literal ?? "");
            const back = parseColor(on.modes[mode]!.literal ?? "");

            if (front === undefined || back === undefined) {
                continue;
            }

            const ratio = contrastRatio(
                front,
                back,
                schemes[mode] === "dark" ? { r: 0, g: 0, b: 0, a: 1 } : { r: 1, g: 1, b: 1, a: 1 },
            );
            const pass = ratio >= min;

            if (at === 0) {
                token.modes[mode]!.contrast = {
                    on: on.name,
                    ratio: Math.floor(ratio * 100) / 100,
                    min,
                    pass,
                    ...(exempt === undefined ? {} : { exempt }),
                };
            }

            if (!pass) {
                (exempt === undefined ? failing : exempted).push(
                    `${mode} ${(Math.floor(ratio * 100) / 100).toFixed(2)}:1 on ${on.name} (needs ${min})`,
                );
                exemptWord = exempt ?? exemptWord;
            }
        }
    }

    if (failing.length > 0) {
        report.warn(
            `Contrast of "${token.name}" is too low: ${failing.join("; ")}. Make the two colors further apart in lightness.`,
            "tokens.json",
            token.name,
            `Raise the contrast, or declare the pair exempt if it is a disabled or decorative color: "contrast": { "on": …, "min": …, "exempt": "disabled" }.`,
        );
    }

    if (exempted.length > 0) {
        report.info(
            `Contrast of "${token.name}" is below its minimum (${exempted.join("; ")}), and the pair is exempt (${exemptWord}).`,
            "tokens.json",
            token.name,
        );
    }
}

export function checkContrast(
    tokens: ResolvedToken[],
    defs: Map<string, Def>,
    modes: string[],
    schemes: Schemes,
    report: Report,
): void {
    const byName = new Map(tokens.map((token) => [token.name, token]));

    for (const token of tokens) {
        checkTokenContrast(token, defs, byName, modes, schemes, report);
    }
}

export function warnDeprecatedUses(tokens: ResolvedToken[], report: Report): void {
    for (const token of tokens) {
        if (token.deprecated === undefined) {
            continue;
        }

        const users = tokens.filter(
            (other) =>
                other.name !== token.name &&
                Object.values(other.modes).some((value) => value.alias === token.name),
        );

        if (users.length > 0) {
            report.warn(
                `"${token.name}" is deprecated${typeof token.deprecated === "string" ? ` (${token.deprecated})` : ""} but ${users
                    .slice(0, 3)
                    .map((user) => user.name)
                    .join(
                        ", ",
                    )}${users.length > 3 ? ", …" : ""} still ${users.length === 1 ? "uses" : "use"} it.`,
                "tokens.json",
                token.name,
            );
        }
    }
}
