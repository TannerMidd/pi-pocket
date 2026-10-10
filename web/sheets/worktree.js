// This session's git worktree: its branch, and removing it.
import { useState } from "preact/hooks";
import { t } from "../i18n.js";
import { actions, attempt, closeSheet, notify, store } from "../store.js";
import { html, Sheet, shortPath } from "../ui.js";

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
                    t("Removed the worktree. The branch {{branch}} stays.", {
                        branch: worktree.branch,
                    }),
                );
            } catch (error) {
                if (error.status !== 409) {
                    throw error;
                }

                setDirty(true);
            }
        });

    if (!worktree) {
        return html`<${Sheet} title=${t("Worktree")} onClose=${closeSheet}>
            <p class="muted">${t("This session works in its folder, not in a worktree.")}</p>
        <//>`;
    }

    return html`<${Sheet} title=${t("Worktree")} onClose=${closeSheet}>
        <p>
            ${t("This session works on the branch {{branch}}, in a checkout of its own: its changes stay apart from {{source}}.", { branch: worktree.branch, source: shortPath(worktree.source, server?.home) })}
        </p>
        <p class="muted small">
            ${t("Ask Pi to commit, merge, or open a pull request when it is done. Removing the worktree deletes its folder; the branch and its commits stay, and Pi works in the original folder again.")}
        </p>
        ${
            dirty
                ? html`<div class="error-box small">
                    ${t("The worktree has uncommitted changes. Removing it anyway loses them.")}
                </div>
                <button class="button wide" onClick=${() => remove(true)}>${t("Remove anyway")}</button>`
                : html`<button class="button wide" onClick=${() => remove(false)}>
                    ${t("Remove the worktree")}
                </button>`
        }
    <//>`;
}
