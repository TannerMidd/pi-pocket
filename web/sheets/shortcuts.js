// The keyboard shortcuts, as a list. The keys themselves are handled in app.js.
import { boxKeyRows } from "../box-keys.js";
import { closeSheet } from "../store.js";
import { html, Keys, Sheet } from "../ui.js";

// Each row: its keys, and what they do. An "or" between keys means either one, and a "…" a run from one to the other.
const SHORTCUTS = [
    [
        "Sessions",
        [
            ["Mod K", "Launcher: sessions, actions, themes"],
            ["Alt 1 … Alt 9", "Jump to a session, like a workspace"],
            ["Alt ↑ or Alt ↓", "Previous or next session"],
            ["Alt N", "New session"],
            ["Mod 1 … Mod 9", "In New session: start in a favorite folder"],
            ["Alt", "Hold to see session numbers"],
            ["Mod B", "Fold or unfold the sidebar"],
            ["Mod Click", "In the sidebar: select a session; drag to select every one you pass"],
            ["Shift Click", "In the sidebar: select a run of sessions"],
        ],
    ],
    [
        "Panels",
        [
            ["Alt B", "Open or close the browser"],
            ["Alt E", "Open or close the Files tile: the folder's files, and what changed"],
            ["Alt A", "Open or close PiP, your assistant"],
            ["Alt P", "Show or hide peek tiles"],
            ["Alt T", "Show thinking: turn the live disclosure on or off"],
            ["Mod F", "Find in this session"],
        ],
    ],
    [
        "Message box",
        [
            ["/", "Commands"],
            ["@", "Mention a file or folder"],
            ["!", "Run a command (!! keeps it from Pi)"],
            ["↑", "In an empty box: what you sent before"],
            ["Mod Enter", "Send the other way: queue when Steer is chosen, steer when Queue is"],
            ["Ctrl R", "Search what you sent before"],
            ["Alt V", "Dictate into the message box, or stop (where the browser can)"],
            ["Esc Esc", "Stop Pi while it works"],
        ],
    ],
    [
        "Changes",
        [
            ["j or k", "The next or previous file"],
            ["n or p", "The next or previous change"],
            ["v", "Mark the file viewed, or not"],
            ["s", "The layout: auto, split, or unified"],
            ["w", "Wrap long lines, or not"],
        ],
    ],
    [
        "Anywhere",
        [
            ["?", "This list"],
            ["Esc", "Close what is open"],
            ["Mod Click", "On a file path: show it in the server machine's file manager (owner)"],
        ],
    ],
];

/** Keys as chips, each key of a chord in its own, with the "or" and "…" between chords left plain. */
function Chords({ keys }) {
    return keys
        .split(" ")
        .map((key) =>
            key === "or" || key === "…"
                ? html`<span class="muted">${key}</span>`
                : html`<${Keys} keys=${key} />`,
        );
}

export function ShortcutsSheet() {
    // Extensions' keys in the message boxes (`pocket.composerKey`), right after the box's own.
    const keys = boxKeyRows();
    const groups = SHORTCUTS.flatMap((group) =>
        group[0] === "Message box" && keys.length > 0
            ? [group, ["Message box: from extensions", keys]]
            : [group],
    );

    return html`<${Sheet} title="Keyboard shortcuts" onClose=${closeSheet}>
        ${groups.map(
            ([title, rows]) => html`<div class="group" key=${title}>
                <div class="group-title">${title}</div>
                <dl class="shortcuts">
                    ${rows.map(
                        ([keys, text]) => html`<dt><${Chords} keys=${keys} /></dt>
                        <dd>${text}</dd>`,
                    )}
                </dl>
            </div>`,
        )}
        <p class="muted small">
            In the launcher, start with <kbd>></kbd> for actions, <kbd>@</kbd> for sessions, or <kbd>#</kbd> for themes. Arrowing onto colors shows them; Enter keeps them.
        </p>
    <//>`;
}
