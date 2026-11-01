import { escapeHtml as esc, plural } from "./docsite-markdown.ts";
import {
    type Ctx,
    clip,
    copyName,
    descOf,
    dimText,
    isObject,
    limiter,
    moreTokens,
    plain,
    rowOf,
    safeCss,
    stackOf,
    tokensOf,
    valueIn,
    varOf,
} from "./docsite-core.ts";
import type { ResolvedToken } from "./system-types.ts";

const FONT_ROOTS = /^(fonts?|type|typography|text)$/i;
const PANGRAM = "The quick brown fox jumps over the lazy dog";

function textStyle(value: unknown): string {
    if (!isObject(value)) {
        return "";
    }

    return (
        [
            ["font-family", stackOf(value.fontFamily)],
            ["font-size", dimText(value.fontSize)],
            ["font-weight", value.fontWeight === undefined ? undefined : String(value.fontWeight)],
            ["line-height", value.lineHeight === undefined ? undefined : String(value.lineHeight)],
            ["letter-spacing", dimText(value.letterSpacing)],
        ] as [string, string | undefined][]
    )
        .filter(([, text]) => safeCss(text) !== undefined)
        .map(([property, text]) => `${property}:${text}`)
        .join(";");
}

export function typographySection(ctx: Ctx): string | undefined {
    const mine = tokensOf(ctx, "typography");

    if (mine.length === 0) {
        return undefined;
    }

    const { take, note } = limiter(ctx);
    const own = mine.filter((token) => token.tier !== "component");
    const inFonts = (type: string, words: RegExp) =>
        own.filter(
            (token) =>
                token.type === type &&
                FONT_ROOTS.test(token.path[0]!) &&
                token.path.some((segment) => words.test(segment)),
        );
    const families = take(own.filter((token) => token.type === "fontFamily"));
    const weights = take(own.filter((token) => token.type === "fontWeight"));
    const styles = take(own.filter((token) => token.type === "typography"));
    const sizes = take(inFonts("dimension", /size/i));
    const rest = take([
        ...inFonts("number", /leading|line-?height/i),
        ...inFonts("dimension", /tracking|letter/i),
    ]);
    const base = families[0] === undefined ? "system-ui" : `var(${families[0].cssVar}, system-ui)`;
    const first = ctx.modes[0]!;
    const parts = [
        `<p class="intro">${plural(families.length, "typeface")}, ${plural(sizes.length, "size")}${styles.length > 0 ? `, and ${plural(styles.length, "text style")}` : ""}.</p>`,
    ];
    const rows = (list: ResolvedToken[], sample: (token: ResolvedToken) => string) =>
        `<div class="rows">${list.map((token) => rowOf(ctx, token, sample(token))).join("")}</div>`;

    if (families.length > 0) {
        parts.push(
            `<h3>Typefaces</h3><div class="cards">${families
                .map(
                    (token) =>
                        `<article class="family" data-s>${copyName(token)}<div class="big" style="font-family:${varOf(token, "system-ui")}, system-ui" aria-hidden="true">Aa</div><p class="abc" style="font-family:${varOf(token, "system-ui")}, system-ui">ABCDEFGHIJKLMNOPQRSTUVWXYZ<br>abcdefghijklmnopqrstuvwxyz<br>0123456789 &amp;?!@#</p><p class="desc">${esc(clip(plain("fontFamily", valueIn(token, first)), 200))}</p>${descOf(token)}</article>`,
                )
                .join("")}</div>`,
        );
    }

    if (weights.length > 0) {
        parts.push(
            `<h3>Weights</h3>${rows(weights, (token) => `<span style="font-family:${base};font-weight:${varOf(token, "400")}">${PANGRAM}</span>`)}`,
        );
    }

    if (styles.length > 0) {
        parts.push(
            `<h3>Text styles</h3><p class="sub">A style fixes the family, size, weight, line height, and tracking together.</p>${rows(styles, (token) => `<span style="${esc(textStyle(valueIn(token, first)?.value))}">${esc(token.description ?? PANGRAM)}</span>`)}`,
        );
    }

    if (sizes.length > 0) {
        parts.push(
            `<h3>Size scale</h3>${rows(sizes, (token) => `<span class="line" style="font-family:${base};font-size:${varOf(token, "inherit")}">${PANGRAM}</span>`)}`,
        );
    }

    if (rest.length > 0) {
        parts.push(`<h3>Line height and tracking</h3>${rows(rest, () => "")}`);
    }

    return `${parts.join("")}${note()}${moreTokens(ctx, "typography")}`;
}

function curvePath(value: unknown): string | undefined {
    if (
        !Array.isArray(value) ||
        value.length !== 4 ||
        value.some((n) => typeof n !== "number" || !Number.isFinite(n))
    ) {
        return undefined;
    }

    const [x1, y1, x2, y2] = value as number[];
    const x = (n: number) => (n * 76 + 12).toFixed(1);
    const y = (n: number) => (88 - n * 76).toFixed(1);

    return `M12,88 C${x(x1!)},${y(y1!)} ${x(x2!)},${y(y2!)} 88,12`;
}

const demo = (ctx: Ctx, token: ResolvedToken, style: string, lead = "") =>
    `<div class="demo" data-s style="${esc(style)}"><div class="row-head">${lead}${copyName(token)}<button class="play" type="button">Play</button></div><span class="desc">${esc(plain(token.type, valueIn(token, ctx.modes[0]!)))}</span><div class="track"><i></i></div></div>`;

export function motionSection(ctx: Ctx): string | undefined {
    const mine = tokensOf(ctx, "motion");

    if (mine.length === 0) {
        return undefined;
    }

    const { take, note } = limiter(ctx);
    const own = (type: string) =>
        take(mine.filter((token) => token.type === type && token.tier !== "component"));
    const durations = own("duration");
    const easings = own("cubicBezier");
    const transitions = own("transition");
    const ease = easings[0] === undefined ? "ease" : `var(${easings[0].cssVar}, ease)`;
    const parts = [
        `<p class="intro">Motion should explain a change, never decorate. Press Play to run a token.</p>`,
    ];

    if (durations.length > 0) {
        parts.push(
            `<h3>Durations</h3><div class="demos">${durations.map((token) => demo(ctx, token, `--dur:${varOf(token, "400ms")};--ease:${ease}`)).join("")}</div>`,
        );
    }

    if (easings.length > 0) {
        parts.push(
            `<h3>Easing</h3><div class="demos">${easings
                .map((token) => {
                    const path = curvePath(valueIn(token, ctx.modes[0]!)?.value);
                    const curve =
                        path === undefined
                            ? ""
                            : `<svg class="curve" viewBox="0 0 100 100" aria-hidden="true"><path d="${path}"/></svg>`;

                    return demo(ctx, token, `--dur:900ms;--ease:${varOf(token, "ease")}`, curve);
                })
                .join("")}</div>`,
        );
    }

    if (transitions.length > 0) {
        parts.push(
            `<h3>Transitions</h3><div class="demos">${transitions
                .map((token) => {
                    const value = valueIn(token, ctx.modes[0]!)?.value;
                    const duration = isObject(value) ? safeCss(dimText(value.duration)) : undefined;
                    const curve = safeCss(
                        plain("cubicBezier", {
                            value: isObject(value) ? (value.timingFunction ?? "ease") : "ease",
                            css: "",
                        }),
                    );

                    return demo(
                        ctx,
                        token,
                        `--dur:${duration ?? "200ms"};--ease:${curve ?? "ease"}`,
                    );
                })
                .join("")}</div>`,
        );
    }

    return `${parts.join("")}${note()}${moreTokens(ctx, "motion")}`;
}
