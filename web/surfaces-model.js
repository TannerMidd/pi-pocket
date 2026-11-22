// The pure parts of a Pocket Surfaces card (`surfaces.js`): which controls a person may use, the data path of a table
// cell, how an image or a link is shown, and what a card's footer says. No DOM and no store, so Node can test them.

import { pointer } from "./surfaces-expr.js";

/** A path into the data for a table cell: the rows' path, the row's index, and the field (`/rows/0/picked`). */
export function cellPath(rows, index, field) {
    return `${String(rows).replace(/\/+$/, "")}/${index}/${field}`;
}

/** The options of a picker as `{ label, value }`: a string is both. */
export function optionsOf(options) {
    return (Array.isArray(options) ? options : []).map((option) =>
        typeof option === "string"
            ? { label: option, value: option }
            : { label: String(option?.label ?? ""), value: String(option?.value ?? "") },
    );
}

/** Who may use a control, as the words of "Only <who> can use this". */
function whoWord(who, by) {
    switch (who) {
        case "requester":
            return by ? `${by} and the owner` : "the person Pi works for and the owner";
        case "steer":
            return "guests who can steer and the owner";
        case "anyone":
            return "someone else";
        default:
            return "the owner";
    }
}

/**
 * Whether the person may use a control now, and why not. A control is live only while the surface is open and the
 * server's `can` says this person may use it.
 */
export function controlState(surface, id) {
    if (surface.status !== "open") {
        return { enabled: false, why: "This card has ended" };
    }

    if (surface.can?.[id] !== true) {
        const own = surface.components?.[id]?.who;

        return {
            enabled: false,
            why: `Only ${whoWord(typeof own === "string" ? own : surface.who, surface.by)} can use this`,
        };
    }

    return { enabled: true, why: "" };
}

/**
 * The data with what a person just set (`pending`: path → `{ value }`) laid over it, copying only along each path, so
 * the card shows the change, and what is computed from it, before the server's next revision arrives.
 */
export function withPending(data, pending) {
    let out = data;

    for (const [path, { value }] of Object.entries(pending)) {
        const parts = pointer(path);

        if (parts === undefined || parts.length === 0) {
            continue;
        }

        const put = (at, depth) => {
            const key = parts[depth];

            if (depth === parts.length) {
                return value;
            }

            if (Array.isArray(at)) {
                const index = /^(0|[1-9]\d*)$/.test(key) ? Number(key) : -1;

                if (index < 0 || index >= at.length) {
                    return at;
                }

                const copy = at.slice();

                copy[index] = put(at[index], depth + 1);

                return copy;
            }

            if (
                typeof at === "object" &&
                at !== null &&
                (Object.hasOwn(at, key) || depth === parts.length - 1)
            ) {
                return { ...at, [key]: put(at[key], depth + 1) };
            }

            return at;
        };

        out = put(out, 0);
    }

    return out;
}

/** Drops each pending value that the surface's revision has caught up with (`until`), and returns the same object. */
export function prunePending(pending, rev) {
    for (const [path, each] of Object.entries(pending)) {
        if (each.until !== undefined && rev >= each.until) {
            delete pending[path];
        }
    }

    return pending;
}

/** `https:` and nothing else, no user name: the URL of a link or an image chip; undefined for any other. */
export function httpsUrl(value) {
    if (typeof value !== "string") {
        return undefined;
    }

    try {
        const url = new URL(value);

        return url.protocol === "https:" && url.username === "" && url.password === ""
            ? url
            : undefined;
    } catch {
        return undefined;
    }
}

const RASTER = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

/**
 * How an image shows: `img` for a small `data:` raster picture, `link` for an https address (the app's CSP forbids
 * loading it: a link chip with its host), `none` for anything else.
 */
export function imageKind(value) {
    if (typeof value === "string" && RASTER.test(value)) {
        return { kind: "img", src: value };
    }

    const url = httpsUrl(value);

    return url === undefined ? { kind: "none" } : { kind: "link", href: url.href, host: url.host };
}

const WORDS = {
    open: "Open",
    done: "Done",
    closed: "Closed",
    expired: "Expired",
    cancelled: "Cancelled",
};

/** The line under a live card, or undefined: waiting for a person, or how it ended. */
export function footerOf(surface) {
    if (surface.status === "open") {
        return surface.waiting ? "Pi is waiting for you" : undefined;
    }

    const word = WORDS[surface.status] ?? String(surface.status);
    const text = surface.final?.text;

    return text ? `${word}: ${text}` : word;
}

/** A card's text copy (the tool result's `details.text`) without its first line when that is the title. */
export function bodyOfText(text, title) {
    const lines = String(text ?? "").split("\n");

    return (lines[0] === title ? lines.slice(1) : lines).join("\n");
}

/** The surface a call made: the one whose `callId` is the call's id. */
export function surfaceOfCall(surfaces, callId) {
    return Object.values(surfaces ?? {}).find((each) => each.callId === callId);
}

/** The body of an action: only `pv` and what the person did, never layout or computed values. */
export function actBody(surface, { set, event }) {
    return {
        pv: surface.pv,
        ...(set === undefined ? {} : { set }),
        ...(event === undefined ? {} : { event }),
    };
}

/** A list of picked values with one value added or removed, in the order of the options. */
export function toggled(current, options, value, on) {
    const have = new Set(Array.isArray(current) ? current : []);

    if (on) {
        have.add(value);
    } else {
        have.delete(value);
    }

    return optionsOf(options)
        .map((option) => option.value)
        .filter((each) => have.has(each));
}
