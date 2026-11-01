export interface Rgba {
    r: number;
    g: number;
    b: number;
    a: number;
}

export declare const NAMED_COLORS: ReadonlyMap<string, string>;
export declare function decodeSrgb(v: number): number;
export declare function encodeSrgb(v: number): number;
export declare function fromOklab(l: number, a: number, b: number, alpha: number): Rgba;
export declare function parseColor(input: unknown): Rgba | undefined;
export declare function num(value: number, digits?: number): string;
export declare function toHex(color: Rgba): string;
export declare function over(color: Rgba, backdrop: Rgba): Rgba;
export declare function luminance(color: Rgba): number;
export declare function contrastRatio(foreground: Rgba, background: Rgba, page?: Rgba): number;
export declare function oklabOf(color: Rgba): [number, number, number];
export declare function toOklch(color: Rgba): { l: number; c: number; h: number };
export declare function colorObjectCss(value: unknown): { css: string } | { error: string };
export declare function toOklchText(color: Rgba): string;
export declare function toRgbText(color: Rgba): string;
export declare function swatchCss(value: unknown): string;
export declare function writeColor(color: Rgba, like: unknown): unknown;
export declare function grade(
    ratio: number,
    min?: number,
): { ratio: number; min: number; pass: boolean; level: string };
export declare function ratioText(ratio: number): string;
