// The page script walks the DOM once. It is plain JavaScript in a string, run with `Runtime.evaluate` as `(<script>)(input)`.
// Its output is untrusted data (the page can lie), so `lint.ts` checks the shape and bounds every string before it uses it.
import { PAGE_SETUP } from "./lint-page-setup.ts";
import { PAGE_VALUES } from "./lint-page-values.ts";
import { PAGE_LITERALS } from "./lint-page-literals.ts";
import { PAGE_STATES } from "./lint-page-states.ts";
import { PAGE_ELEMENTS } from "./lint-page-elements.ts";
import { PAGE_CHECKS } from "./lint-page-checks.ts";
import { PAGE_FOCUS } from "./lint-page-focus.ts";

export interface PageInput {
    tokenColors: string[];
    tokenLengths: { css: string; kind: string }[];
    deck: boolean;
    literals: boolean;
}

export interface RawElement {
    selector: string;
    pid: string;
    rect: { x: number; y: number; width: number; height: number };
}

interface RawGroup {
    count: number;
    el: RawElement;
}

export interface RawPage {
    elements: number;
    viewport: { width: number; height: number };
    hasViewportMeta: boolean;
    resolvedColors: (number[] | null)[];
    resolvedLengths: (number | null)[];
    colors: (RawGroup & { rgba: number[]; roles: Record<string, number>; literal?: boolean })[];
    fonts: (RawGroup & { family: string; list: string; literal?: boolean })[];
    sizes: (RawGroup & { kind: string; px: number; props: string[]; literal?: boolean })[];
    contrast: (RawGroup & {
        fg: number[];
        bg: number[];
        size: number;
        large: boolean;
        ui: boolean;
        ratio?: number;
        edges?: number[][];
        what?: string;
        tag?: string;
    })[];
    targets: (RawGroup & { level: string; width: number; height: number; tag: string })[];
    overflow?: {
        scrollWidth: number;
        clientWidth: number;
        clipped: boolean;
        offenders: number;
        el?: RawElement;
    };
    images: (RawGroup & { tag: string; why: string })[];
    headings: (RawGroup & { level: number; previous: number })[];
    fontFaces: (RawGroup & { family: string; why: string; failed: boolean })[];
    focus: (RawGroup & { tag: string; outlineNone: boolean })[];
    pids: (RawGroup & { tag: string })[];
    notJudged?: { count: number; elements: string[] };
    semantics?: { lang: boolean; main: boolean; html: RawElement; body: RawElement };
    labels?: (RawGroup & { kind: string })[];
    names?: (RawGroup & { kind: string })[];
    zoom?: (RawGroup & { kind: string; px: number })[];
    motion?: {
        count: number;
        longest: number;
        override: boolean;
        unreadable: boolean;
        el?: RawElement;
    };
}
export const PAGE_SCRIPT = [
    PAGE_SETUP,
    PAGE_VALUES,
    PAGE_LITERALS,
    PAGE_STATES,
    PAGE_ELEMENTS,
    PAGE_CHECKS,
    PAGE_FOCUS,
].join("\n");
