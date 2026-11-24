// This session's git worktree: its branch, and removing it.
import { useState } from "preact/hooks";
import { actions, attempt, closeSheet, notify, store } from "../store.js";
import { html, Sheet, shortPath } from "../ui.js";
import { t } from "../ui-locale.js";

/** A session's own git worktree: where it is, and removing it (its branch stays). */
export function WorktreeSheet() {
    const { view, server } = store.state;
    const worktree = view.conversation?.worktree;
    const [dirty, setDirty] = useState(false);
    const remove = (force) =>
        attempt(async () => {
            try {
                await actions.removeWorktree(force);
                closeSheet();
                notify(
                    "info",
                    t(
                        "web.sheets.worktree.worktree-sheet.remove.removed-worktree-branch-stays",
                        "Removed the worktree. The branch {branch} stays.",
                        { branch: worktree.branch },
                    ),
                );
            } catch (error) {
                if (error.status !== 409) {
                    throw error;
                }

                setDirty(true);
            }
        });

    if (!worktree) {
        return html`<${Sheet} title=${t(
            "web.sheets.worktree.worktree-sheet.title.worktree",
            "Worktree",
        )} onClose=${closeSheet}>
            <p class="muted">${t(
                "web.sheets.worktree.worktree-sheet.p.session-works-folder-not",
                "This session works in its folder, not in a worktree.",
            )}</p>
        <//>`;
    }

    return html`<${Sheet} title=${t(
        "web.sheets.worktree.worktree-sheet.title.worktree",
        "Worktree",
    )} onClose=${closeSheet}>
        <p>
            ${t("web.sheets.worktree.worktree-sheet.p.session-works-branch", "This session works on the branch")} <span class="mono">${worktree.branch}</span>${t("web.sheets.worktree.worktree-sheet.span.checkout-own-changes-stay", ", in a checkout of its own: its changes stay apart from")} <span class="mono">${shortPath(worktree.source, server?.home)}</span>.
        </p>
        <p class="muted small">
            ${t("web.sheets.worktree.worktree-sheet.p.ask-pi-commit-merge", "Ask Pi to commit, merge, or open a pull request when it is done. Removing the worktree deletes its folder; the branch and its commits stay, and Pi works in the original folder again.")}
        </p>
        ${
            dirty
                ? html`<div class="error-box small">
                    ${t(
                        "web.sheets.worktree.worktree-sheet.div.worktree-uncommitted-changes-removing",
                        "The worktree has uncommitted changes. Removing it anyway loses them.",
                    )}
                </div>
                <button class="button wide" onClick=${() => remove(true)}>${t(
                    "web.sheets.worktree.worktree-sheet.button.remove-anyway",
                    "Remove anyway",
                )}</button>`
                : html`<button class="button wide" onClick=${() => remove(false)}>
                    ${t(
                        "web.sheets.worktree.worktree-sheet.button.remove-the-worktree",
                        "Remove the worktree",
                    )}
                </button>`
        }
    <//>`;
}
