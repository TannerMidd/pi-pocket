// The check compares Oklch lightness, which follows what the eye sees, so it finds a step that a contrast check does not.
import { parseColor, toOklch } from "./color.ts";
import type { ResolvedToken } from "./system-types.ts";

interface RampProblem {
    group: string;
    mode: string;
    first: string;
    second: string;
    message: string;
    fix: string;
}

/** Lightness steps smaller than this are not a break: two steps may be the same lightness. */
const TOLERANCE = 0.004;
/** A ramp whose first and last step differ by less than this is flat: it has no direction. */
const FLAT = 0.05;

const percent = (lightness: number) => `${Math.round(lightness * 100)}%`;

export function rampProblems(tokens: ResolvedToken[], modes: string[]): RampProblem[] {
    const groups = new Map<string, ResolvedToken[]>();

    for (const token of tokens) {
        const step = token.path.at(-1)!;

        if (token.type === "color" && token.path.length >= 2 && /^\d{1,4}$/.test(step)) {
            const group = token.path.slice(0, -1).join(".");

            groups.set(group, [...(groups.get(group) ?? []), token]);
        }
    }

    const problems: RampProblem[] = [];

    for (const [group, steps] of groups) {
        if (steps.length < 3) {
            continue;
        }

        const ordered = [...steps].sort((a, b) => Number(a.path.at(-1)) - Number(b.path.at(-1)));
        // The first mode that breaks is named; a ramp that breaks in every mode says it once.
        const broken = new Set<string>();

        for (const mode of modes) {
            const lights: { token: ResolvedToken; l: number }[] = [];

            for (const token of ordered) {
                const text = token.modes[mode]?.hex;
                const color = text === undefined ? undefined : parseColor(text);

                // A translucent step has the lightness of what is behind it: it is not part of a ramp of solid colors.
                if (color !== undefined && color.a >= 0.999) {
                    lights.push({ token, l: toOklch(color).l });
                }
            }

            if (lights.length < 3) {
                continue;
            }

            const span = lights.at(-1)!.l - lights[0]!.l;

            if (Math.abs(span) < FLAT) {
                continue;
            }

            const direction = Math.sign(span);

            for (let at = 1; at < lights.length; at++) {
                const before = lights[at - 1]!;
                const after = lights[at]!;

                if ((after.l - before.l) * direction < -TOLERANCE) {
                    const key = `${before.token.name}|${after.token.name}`;

                    if (broken.has(key)) {
                        break;
                    }

                    broken.add(key);

                    const inMode = mode === modes[0] ? "" : ` in the ${mode} mode`;
                    const word = direction > 0 ? "darker" : "lighter";
                    const trend = direction > 0 ? "lighter" : "darker";

                    problems.push({
                        group,
                        mode,
                        first: before.token.name,
                        second: after.token.name,
                        message: `The ramp "${group}" is not steady in lightness${inMode}: step ${after.token.path.at(-1)} (${percent(after.l)}) is ${word} than step ${before.token.path.at(-1)} (${percent(before.l)}), but the ramp gets ${trend} as its numbers rise.`,
                        fix: `Swap the values of ${before.token.name} and ${after.token.name}, or recolor one of them so that lightness changes in one direction along "${group}".`,
                    });

                    break;
                }
            }
        }
    }

    return problems;
}
