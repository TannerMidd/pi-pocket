import type { LengthKind, RgbaTuple, TokenSet } from "./lint-color.ts";
import type { RawElement } from "./lint-page.ts";
import type { CheckFinding } from "./system-types.ts";

export type WeightedFinding = CheckFinding & { weight: number };

export const weighted = (finding: CheckFinding, weight = 1): WeightedFinding => ({
    ...finding,
    weight,
});

const MAX_TEXT = 300;

export const clip = (value: unknown, length = MAX_TEXT): string =>
    typeof value === "string" ? value.slice(0, length) : "";
export const num = (value: unknown, fallback = 0): number =>
    typeof value === "number" && Number.isFinite(value) ? value : fallback;
export const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
export const more = (count: number) =>
    count > 1 ? ` (and ${plural(count - 1, "more element")})` : "";

export function elementOf(raw: RawElement | undefined): {
    selector: string;
    pid?: string;
    rect?: CheckFinding["rect"];
} {
    const rect = raw?.rect;

    return {
        selector: clip(raw?.selector, 500),
        ...(typeof raw?.pid === "string" && raw.pid !== "" ? { pid: clip(raw.pid, 200) } : {}),
        ...(rect === undefined
            ? {}
            : {
                  rect: {
                      x: num(rect.x),
                      y: num(rect.y),
                      width: num(rect.width),
                      height: num(rect.height),
                  },
              }),
    };
}

export const rgbaOf = (value: unknown): RgbaTuple | undefined =>
    Array.isArray(value) && value.length === 4 && value.every((item) => Number.isFinite(item))
        ? [value[0], value[1], value[2], value[3]]
        : undefined;
export const rgbOf = (value: unknown): [number, number, number] | undefined =>
    Array.isArray(value) && value.length >= 3 && value.slice(0, 3).every(Number.isFinite)
        ? [value[0], value[1], value[2]]
        : undefined;

export const lengthsOf = (set: TokenSet, kind: LengthKind) =>
    set.lengths.filter(
        (token): token is typeof token & { px: number } =>
            token.kind === kind && token.px !== undefined,
    );

export const tokenRef = (token: { cssVar: string }) => `var(${token.cssVar})`;
