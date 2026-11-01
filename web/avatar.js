// People's avatars: their initials in a color of the theme, the same color for the same person everywhere; and the
// colors of folders, which mark their sessions the same way.

import { store } from "./store.js";
import { html } from "./ui.js";

// The theme's own colors, so people keep their colors in every theme and each one fits it.
const COLORS = [
    "var(--o-blue)",
    "var(--o-green)",
    "var(--o-yellow)",
    "var(--o-magenta)",
    "var(--o-cyan)",
    "var(--o-red)",
    "var(--o-orange)",
    "var(--o-fg-bright)",
];

/** Folders' colors: the same, without yellow and red, which mark sessions waiting for you and subagents that failed. */
const FOLDER_COLORS = [
    "var(--o-blue)",
    "var(--o-green)",
    "var(--o-magenta)",
    "var(--o-cyan)",
    "var(--o-orange)",
    "var(--o-fg-bright)",
];

function hashOf(text) {
    let hash = 0;

    for (const char of String(text)) {
        hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    }

    return hash;
}

/** A steady color per person, so the same person looks the same on every device. */
export function personColor(id) {
    return COLORS[hashOf(id) % COLORS.length];
}

/** Each folder's color, by path: the list asks for every row as it draws, and a few folders hold most sessions. */
const folderColors = new Map();

/** A steady color per folder, from its last part, for the mark on its sessions' rows. */
export function folderColor(path) {
    const key = String(path ?? "");
    let color = folderColors.get(key);

    if (color === undefined) {
        const name = key.replace(/\/+$/, "").split("/").pop();

        color = FOLDER_COLORS[hashOf(name) % FOLDER_COLORS.length];
        folderColors.set(key, color);
    }

    return color;
}

/** "Tanner - Mac" → "TM", "alex" → "AL". */
export function initials(name) {
    const words = String(name ?? "?")
        .trim()
        .split(/[\s\-_.]+/)
        .filter(Boolean);
    const first = words[0] ?? "?";

    return (first[0] + (words.length > 1 ? words[1][0] : (first[1] ?? ""))).toUpperCase();
}

/** The address of a person's picture, or undefined without one. Its version keeps a changed picture from showing stale. */
export function avatarSrc(person) {
    // Presence and a few other lists carry no picture: the people list is where its version is.
    const version =
        person?.avatar ?? store.state.users.find((each) => each.id === person?.id)?.avatar;

    return version ? `/api/avatar/${encodeURIComponent(person.id)}?v=${version}` : undefined;
}

/** A picture file as the small square PNG that is sent: its middle, cropped, at 192px. */
export async function avatarBlob(file, side = 192) {
    const bitmap = await createImageBitmap(file);
    const crop = Math.min(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");

    canvas.width = canvas.height = side;
    canvas
        .getContext("2d")
        .drawImage(
            bitmap,
            (bitmap.width - crop) / 2,
            (bitmap.height - crop) / 2,
            crop,
            crop,
            0,
            0,
            side,
            side,
        );
    bitmap.close?.();

    return await new Promise((resolve, reject) =>
        canvas.toBlob(
            (blob) => (blob ? resolve(blob) : reject(new Error("That picture could not be read"))),
            "image/png",
        ),
    );
}

export function Avatar({ person, size = 24 }) {
    const state = person.typing ? "typing" : person.away ? "away" : "";
    const title = person.typing
        ? `${person.name} is typing`
        : person.away
          ? `${person.name} (away)`
          : person.name;

    const src = avatarSrc(person);
    // Initials grow with a big avatar; small ones keep the stylesheet's size.
    const font = size > 30 ? `;font-size:${Math.round(size * 0.4)}px` : "";

    return html`<span
        class=${`avatar ${state}`}
        style=${`--who:${personColor(person.id)};width:${size}px;height:${size}px${font}`}
        title=${title}
    >
        ${src ? html`<img class="avatar-img" src=${src} alt="" />` : initials(person.name)}
    </span>`;
}
