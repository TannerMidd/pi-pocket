// The keyboard shortcuts, as a list. The keys themselves are handled in app.js.
import { closeSheet } from "../store.js";
import { html, Keys, Sheet } from "../ui.js";

const SHORTCUTS = [
    ["Mod K", "Launcher: sessions, actions, themes"],
    ["Alt 1", "… Alt 9: jump to a session, like a workspace"],
    ["Alt ↑", "Alt ↓: previous or next session"],
    ["Alt N", "New session"],
    ["Alt B", "Open or close the browser"],
    ["Alt E", "Open or close the Files tile: the folder's files, and what changed"],
    ["j", "k: in Changes, the next or previous file"],
    ["n", "p: in Changes, the next or previous change"],
    ["v", "In Changes: mark the file viewed, or not"],
    ["s", "In Changes: the layout, auto, split, or unified"],
    ["w", "In Changes: wrap long lines, or not"],
    ["Alt P", "Show or hide peek tiles"],
    ["Mod B", "Fold or unfold the sidebar"],
    ["Mod Click", "In the sidebar: select a session; drag to select every one you pass"],
    ["Shift Click", "In the sidebar: select a run of sessions"],
    ["Alt", "Hold to see session numbers"],
    ["/", "In the message box: commands"],
    ["@", "In the message box: mention a file or folder"],
    ["!", "In the message box: run a command (!! keeps it from Pi)"],
    ["↑", "In an empty message box: what you sent before"],
    ["Ctrl R", "In the message box: search what you sent before"],
    ["Mod F", "Find in this session"],
    ["Esc Esc", "Stop Pi while it works"],
    ["?", "This list"],
    ["Esc", "Close what is open"],
];

export function ShortcutsSheet() {
    return html`<${Sheet} title="Keyboard shortcuts" onClose=${closeSheet}>
        <dl class="shortcuts">
            ${SHORTCUTS.map(
                ([keys, text]) => html`<dt><${Keys} keys=${keys} /></dt>
                <dd>${text}</dd>`,
            )}
        </dl>
        <p class="muted small">
            In the launcher, start with <kbd>></kbd> for actions, <kbd>@</kbd> for sessions, or <kbd>#</kbd> for themes. Arrowing onto a theme shows it; Enter keeps it.
        </p>
    <//>`;
}
