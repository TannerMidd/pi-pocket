// Frame sizes and zoom for the canvas: pure functions, no DOM, so a test can run them.

/** The sizes the canvas shows a design at. `slide` is for decks. */
export const DEVICES = {
    mobile: { label: "Phone", w: 390, h: 844, icon: "phone" },
    tablet: { label: "Tablet", w: 820, h: 1180, icon: "tablet" },
    desktop: { label: "Desktop", w: 1280, h: 800, icon: "monitor" },
    slide: { label: "Slide", w: 1280, h: 720, icon: "monitor" },
};

/** The sizes an export asks for (`viewport` of `design_export`): a custom or slide size exports as the nearest. */
export function exportViewport(device, size) {
    if (device === "mobile" || device === "tablet" || device === "desktop") {
        return device;
    }

    return size.w <= 500 ? "mobile" : size.w <= 1000 ? "tablet" : "desktop";
}

export const MIN_SIZE = 200;
export const MAX_SIZE = 4000;

export const clampSize = (value, fallback = 800) => {
    const number = Math.round(Number(value));

    return Number.isFinite(number) ? Math.min(MAX_SIZE, Math.max(MIN_SIZE, number)) : fallback;
};

/** The pixels a device name stands for: `custom` is the person's own. */
export function sizeOf(device, custom) {
    if (device === "custom") {
        return { w: clampSize(custom?.w, 800), h: clampSize(custom?.h, 600) };
    }

    const known = DEVICES[device] ?? DEVICES.desktop;

    return { w: known.w, h: known.h };
}

/** The zoom steps the buttons walk through. */
export const ZOOMS = [0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2];

/**
 * How much a frame of `size` is scaled in an area of `room` pixels: `zoom` is "fit" (as large as fits, never past
 * 100%) or a number. `gap` is the margin kept around the frame when it fits.
 */
export function scaleOf(zoom, size, room, gap = 16) {
    if (zoom === "width") {
        if (!(room.w > 0)) {
            return 1;
        }

        return Math.max(0.1, Math.floor(Math.min((room.w - gap * 2) / size.w, 1) * 100) / 100);
    }

    if (zoom !== "fit") {
        return Number(zoom) > 0 ? Number(zoom) : 1;
    }

    if (!(room.w > 0) || !(room.h > 0)) {
        return 1;
    }

    const fit = Math.min((room.w - gap * 2) / size.w, (room.h - gap * 2) / size.h, 1);

    return Math.max(0.1, Math.floor(fit * 100) / 100);
}

/** `auto` is the room's width on a narrow panel (read the text, scroll), the whole page elsewhere. */
export const zoomOf = (zoom, narrow) => (zoom === "auto" ? (narrow ? "width" : "fit") : zoom);

/** The label before the percent of a zoom that follows the room: `Width 95%`, `Fit 44%`. */
export const zoomWord = (zoom) => (zoom === "width" ? "Width " : zoom === "fit" ? "Fit " : "");

export function nextZoom(zoom, narrow) {
    const steps = narrow ? ["width", "fit", 1] : ["fit", 1];
    const at = steps.indexOf(zoom);

    return steps[(at + 1) % steps.length];
}

/** The next zoom step up (`direction` 1) or down (-1) from `scale`, as a number: it leaves "fit". */
export function stepZoom(scale, direction) {
    if (direction > 0) {
        return ZOOMS.find((step) => step > scale + 0.005) ?? ZOOMS.at(-1);
    }

    return [...ZOOMS].reverse().find((step) => step < scale - 0.005) ?? ZOOMS[0];
}

export const percent = (scale) => `${Math.round(scale * 100)}%`;
