// The knobs of a design's tweaks manifest (`<script type="application/json" id="pocket-tweaks">`), as the canvas keeps
// them. The page is untrusted data: every shape is checked and cut here, whatever the bridge checked before.

export const KNOB_TYPES = ["range", "color", "select", "toggle", "text"];
export const MAX_KNOBS = 40;

const label = (value, max) => String(value ?? "").slice(0, max);
const finite = (value) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

/** The knobs a page sent, cleaned: unknown types and nameless ones dropped, ranges given sane bounds. */
export function normalizeKnobs(raw) {
    if (!Array.isArray(raw)) {
        return [];
    }

    const seen = new Set();
    const knobs = [];

    for (const item of raw.slice(0, MAX_KNOBS)) {
        if (typeof item !== "object" || item === null) {
            continue;
        }

        const name = label(item.name, 100);

        // A custom property the bridge would refuse (it refuses a whole batch for one) is not a knob.
        const badName =
            name.length > 80 || (name.startsWith("--") && !/^--[A-Za-z0-9_-]{1,78}$/.test(name));

        if (name === "" || badName || seen.has(name) || !KNOB_TYPES.includes(item.type)) {
            continue;
        }

        seen.add(name);

        const knob = {
            name,
            label: label(item.label || name.replace(/^--/, ""), 60),
            type: item.type,
        };

        if (item.type === "range") {
            const min = finite(item.min) ?? 0;
            const max = finite(item.max) ?? Math.max(min + 1, 100);
            const step = finite(item.step) > 0 ? finite(item.step) : (max - min) / 100;

            Object.assign(knob, {
                min,
                max: Math.max(max, min),
                step,
                unit: label(item.unit, 8),
                value: clampRange(finite(item.value) ?? min, min, Math.max(max, min)),
            });
        } else if (item.type === "select") {
            const options = (Array.isArray(item.options) ? item.options : [])
                .slice(0, 50)
                .map((option) =>
                    typeof option === "object" && option !== null
                        ? {
                              value: label(option.value, 200),
                              label: label(option.label ?? option.value, 80),
                          }
                        : { value: label(option, 200), label: label(option, 80) },
                );

            Object.assign(knob, {
                options,
                value: label(item.value ?? options[0]?.value ?? "", 200),
            });
        } else if (item.type === "toggle") {
            knob.value = item.value === true;
        } else {
            knob.value = label(item.value ?? (item.type === "color" ? "#000000" : ""), 500);
            knob.unit = label(item.unit, 8);
        }

        knobs.push(knob);
    }

    return knobs;
}

const clampRange = (value, min, max) => Math.min(max, Math.max(min, value));

/** A value of the knob's own type, from any value, or undefined when it cannot be one (so a saved value of an older design drops). */
export function coerce(knob, value) {
    switch (knob.type) {
        case "range": {
            const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;

            return typeof number === "number" && Number.isFinite(number)
                ? clampRange(number, knob.min, knob.max)
                : undefined;
        }

        case "toggle":
            return typeof value === "boolean" ? value : undefined;
        case "select":
            return typeof value === "string" &&
                knob.options.some((option) => option.value === value)
                ? value
                : undefined;
        case "color":
            return typeof value === "string" && /^#[0-9a-f]{3,8}$/i.test(value) ? value : undefined;
        default:
            return typeof value === "string" ? value.slice(0, 500) : undefined;
    }
}

/** What was saved, kept for the knobs that still exist and still fit them. */
export function usable(knobs, saved) {
    const values = {};

    for (const knob of knobs) {
        if (saved && Object.hasOwn(saved, knob.name)) {
            const value = coerce(knob, saved[knob.name]);

            if (value !== undefined) {
                values[knob.name] = value;
            }
        }
    }

    return values;
}

/** The knobs whose value now is not the page's own. */
export function changed(knobs, values) {
    return knobs.filter(
        (knob) => Object.hasOwn(values, knob.name) && values[knob.name] !== knob.value,
    );
}

/**
 * What goes to the page for a knob: a CSS custom property (`--name`) gets its unit, as text; any other name gets the value
 * as it is, in the page's `pocket:tweak` event.
 */
export function forPage(knob, value) {
    if (knob.name.startsWith("--") && knob.type === "range" && knob.unit) {
        return `${value}${knob.unit}`;
    }

    if (knob.name.startsWith("--") && typeof value === "boolean") {
        return value ? "1" : "0";
    }

    return value;
}

/** A value for people to read: with its unit, "on"/"off" for a toggle. */
export function show(knob, value) {
    if (knob.type === "toggle") {
        return value ? "on" : "off";
    }

    if (knob.type === "range") {
        return `${Math.round(value * 1000) / 1000}${knob.unit ?? ""}`;
    }

    return String(value);
}
