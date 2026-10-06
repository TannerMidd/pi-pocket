// People's avatars: their initials in a color of the theme, the same color for the same person everywhere.

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

/** A steady color per person, so the same person looks the same on every device. */
export function personColor(id) {
    let hash = 0;

    for (const char of String(id)) {
        hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    }

    return COLORS[hash % COLORS.length];
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

export function Avatar({ person, size = 24 }) {
    const state = person.typing ? "typing" : person.away ? "away" : "";
    const title = person.typing
        ? `${person.name} is typing`
        : person.away
          ? `${person.name} (away)`
          : person.name;

    return html`<span
        class=${`avatar ${state}`}
        style=${`--who:${personColor(person.id)};width:${size}px;height:${size}px`}
        title=${title}
    >
        ${initials(person.name)}
    </span>`;
}
