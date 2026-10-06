/** Page sizes for the built-in browser: the presets people pick and Pi names, and sizes read from either. */
export type ViewportPreset = "mobile" | "tablet" | "desktop";

/** A page's size in CSS pixels, its device pixel ratio, and whether it acts as a phone or tablet (touch, mobile layout). */
export type Viewport = { width: number; height: number; scale: number; mobile: boolean };

export const VIEWPORTS: Readonly<Record<ViewportPreset, Viewport>> = {
    mobile: { width: 390, height: 844, scale: 2, mobile: true },
    tablet: { width: 820, height: 1180, scale: 2, mobile: true },
    desktop: { width: 1280, height: 800, scale: 1, mobile: false },
};

export const clamp = (value: number, low: number, high: number) =>
    Math.min(high, Math.max(low, value));

/** A preset name, `WIDTHxHEIGHT`, or a viewport object, as a viewport; undefined when it is none of these. */
export function viewportFrom(value: unknown): Viewport | undefined {
    if (typeof value === "string") {
        const name = value.trim().toLowerCase();

        if (Object.hasOwn(VIEWPORTS, name)) {
            return { ...VIEWPORTS[name as ViewportPreset] };
        }

        const match = /^(\d{3,4})\s*[x×]\s*(\d{3,4})$/.exec(name);

        if (match === null) {
            return undefined;
        }

        const width = clamp(Number(match[1]), 240, 3840);

        return { width, height: clamp(Number(match[2]), 240, 3840), scale: 1, mobile: width < 600 };
    }

    if (typeof value !== "object" || value === null) {
        return undefined;
    }

    const raw = value as Record<string, unknown>;

    if (
        typeof raw.width !== "number" ||
        typeof raw.height !== "number" ||
        !Number.isFinite(raw.width) ||
        !Number.isFinite(raw.height)
    ) {
        return undefined;
    }

    return {
        width: clamp(Math.round(raw.width), 240, 3840),
        height: clamp(Math.round(raw.height), 240, 3840),
        scale:
            typeof raw.scale === "number" && Number.isFinite(raw.scale)
                ? clamp(raw.scale, 1, 3)
                : 1,
        mobile: raw.mobile === true,
    };
}

/** The preset a viewport is, if it is one. */
export function presetOf(viewport: Viewport): ViewportPreset | undefined {
    return (Object.keys(VIEWPORTS) as ViewportPreset[]).find((name) => {
        const preset = VIEWPORTS[name];

        return (
            preset.width === viewport.width &&
            preset.height === viewport.height &&
            preset.mobile === viewport.mobile
        );
    });
}
