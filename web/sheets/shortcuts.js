// The keyboard shortcuts, as a list. The keys themselves are handled in app.js.
import { boxKeyRows } from "../box-keys.js";
import { closeSheet } from "../store.js";
import { html, Keys, Sheet } from "../ui.js";
import { t } from "../ui-locale.js";

/**
 * Each row: its keys, and what they do. An "or" between keys means either one, and a "…" a run from one to the other.
 * Built at draw time, so a change of language draws the list again.
 */
const shortcuts = () => [
    [
        t("web.sheets.shortcuts.shortcuts.sessions", "Sessions"),
        [
            [
                "Mod K",
                t(
                    "web.sheets.shortcuts.shortcuts.launcher-sessions-actions-themes",
                    "Launcher: sessions, actions, themes",
                ),
            ],
            [
                "Alt 1 … Alt 9",
                t(
                    "web.sheets.shortcuts.shortcuts.jump-session-like-workspace",
                    "Jump to a session, like a workspace",
                ),
            ],
            [
                "Alt ↑ or Alt ↓",
                t(
                    "web.sheets.shortcuts.shortcuts.previous-next-session",
                    "Previous or next session",
                ),
            ],
            ["Alt N", t("web.sheets.shortcuts.shortcuts.new-session", "New session")],
            [
                "Mod 1 … Mod 9",
                t(
                    "web.sheets.shortcuts.shortcuts.new-session-start-favorite",
                    "In New session: start in a favorite folder",
                ),
            ],
            [
                "Alt",
                t(
                    "web.sheets.shortcuts.shortcuts.hold-see-session-numbers",
                    "Hold to see session numbers",
                ),
            ],
            [
                "Mod B",
                t(
                    "web.sheets.shortcuts.shortcuts.fold-unfold-sidebar",
                    "Fold or unfold the sidebar",
                ),
            ],
            [
                "Mod Click",
                t(
                    "web.sheets.shortcuts.shortcuts.sidebar-select-session-drag",
                    "In the sidebar: select a session; drag to select every one you pass",
                ),
            ],
            [
                "Shift Click",
                t(
                    "web.sheets.shortcuts.shortcuts.sidebar-select-run-sessions",
                    "In the sidebar: select a run of sessions",
                ),
            ],
        ],
    ],
    [
        t("web.sheets.shortcuts.shortcuts.panels", "Panels"),
        [
            [
                "Alt B",
                t("web.sheets.shortcuts.shortcuts.open-close-browser", "Open or close the browser"),
            ],
            [
                "Alt E",
                t(
                    "web.sheets.shortcuts.shortcuts.open-close-files-tile",
                    "Open or close the Files tile: the folder's files, and what changed",
                ),
            ],
            [
                "Alt A",
                t(
                    "web.sheets.shortcuts.shortcuts.open-close-pi-p-assistant",
                    "Open or close PiP, your assistant",
                ),
            ],
            [
                "Alt P",
                t("web.sheets.shortcuts.shortcuts.show-hide-peek-tiles", "Show or hide peek tiles"),
            ],
            [
                "Alt T",
                t(
                    "web.sheets.shortcuts.shortcuts.show-thinking-turn-live",
                    "Show thinking: turn the live disclosure on or off",
                ),
            ],
            ["Mod F", t("web.sheets.shortcuts.shortcuts.find-session", "Find in this session")],
        ],
    ],
    [
        t("web.sheets.shortcuts.shortcuts.message-box", "Message box"),
        [
            ["/", t("web.sheets.shortcuts.shortcuts.commands", "Commands")],
            [
                "@",
                t("web.sheets.shortcuts.shortcuts.mention-file-folder", "Mention a file or folder"),
            ],
            [
                "!",
                t(
                    "web.sheets.shortcuts.shortcuts.run-command-keeps-pi",
                    "Run a command (!! keeps it from Pi)",
                ),
            ],
            [
                "↑",
                t(
                    "web.sheets.shortcuts.shortcuts.empty-box-sent-before",
                    "In an empty box: what you sent before",
                ),
            ],
            [
                "Mod Enter",
                t(
                    "web.sheets.shortcuts.send-other-way",
                    "Send the other way: queue when Steer is chosen, steer when Queue is",
                ),
            ],
            [
                "Ctrl R",
                t(
                    "web.sheets.shortcuts.shortcuts.search-sent-before",
                    "Search what you sent before",
                ),
            ],
            [
                "Alt V",
                t(
                    "web.sheets.shortcuts.shortcuts.dictate-message-box-stop",
                    "Dictate into the message box, or stop (where the browser can)",
                ),
            ],
            [
                "Esc Esc",
                t("web.sheets.shortcuts.shortcuts.stop-pi-while-works", "Stop Pi while it works"),
            ],
        ],
    ],
    [
        t("web.sheets.shortcuts.shortcuts.changes", "Changes"),
        [
            [
                "j or k",
                t("web.sheets.shortcuts.shortcuts.next-previous-file", "The next or previous file"),
            ],
            [
                "n or p",
                t(
                    "web.sheets.shortcuts.shortcuts.next-previous-change",
                    "The next or previous change",
                ),
            ],
            [
                "v",
                t(
                    "web.sheets.shortcuts.shortcuts.mark-file-viewed-not",
                    "Mark the file viewed, or not",
                ),
            ],
            [
                "s",
                t(
                    "web.sheets.shortcuts.shortcuts.layout-auto-split-unified",
                    "The layout: auto, split, or unified",
                ),
            ],
            [
                "w",
                t("web.sheets.shortcuts.shortcuts.wrap-long-lines-not", "Wrap long lines, or not"),
            ],
        ],
    ],
    [
        t("web.sheets.shortcuts.shortcuts.anywhere", "Anywhere"),
        [
            ["?", t("web.sheets.shortcuts.shortcuts.list", "This list")],
            ["Esc", t("web.sheets.shortcuts.shortcuts.close-open", "Close what is open")],
            [
                "Mod Click",
                t(
                    "web.sheets.shortcuts.shortcuts.file-path-show-server",
                    "On a file path: show it in the server machine's file manager (owner)",
                ),
            ],
        ],
    ],
];

/** Keys as chips, each key of a chord in its own, with the "or" and "…" between chords left plain. */
function Chords({ keys }) {
    return keys
        .split(" ")
        .map((key) =>
            key === "or" || key === "…"
                ? html`<span class="muted">${key === "or" ? t("web.shortcuts.or", "or") : key}</span>`
                : key === "Click"
                  ? html`<span class="muted">${t("web.shortcuts.click", "Click")}</span>`
                  : html`<${Keys} keys=${key} />`,
        );
}

export function ShortcutsSheet() {
    // Extensions' keys in the message boxes (`pocket.composerKey`), right after the box's own.
    const keys = boxKeyRows();
    const groups = shortcuts().flatMap((group) =>
        group[0] === t("web.sheets.shortcuts.shortcuts.message-box", "Message box") &&
        keys.length > 0
            ? [
                  group,
                  [
                      t(
                          "web.sheets.shortcuts.shortcuts-sheet.groups.message-box-extensions",
                          "Message box: from extensions",
                      ),
                      keys,
                  ],
              ]
            : [group],
    );

    return html`<${Sheet} title=${t(
        "web.sheets.shortcuts.shortcuts-sheet.title.keyboard-shortcuts",
        "Keyboard shortcuts",
    )} onClose=${closeSheet}>
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
            ${t("web.sheets.shortcuts.shortcuts-sheet.p.launcher-start", "In the launcher, start with")} <kbd>></kbd> ${t("web.sheets.shortcuts.shortcuts-sheet.kbd.for-actions", "for actions,")} <kbd>@</kbd> ${t("web.sheets.shortcuts.shortcuts-sheet.kbd.for-sessions-or", "for sessions, or")} <kbd>#</kbd> ${t("web.sheets.shortcuts.shortcuts-sheet.kbd.themes-arrowing-onto-colors", "for themes. Arrowing onto colors shows them; Enter keeps them.")}
        </p>
    <//>`;
}
