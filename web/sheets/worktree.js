// This session's git worktree: its branch, and removing it.
import { useState } from "preact/hooks";
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
                notify("info", `Removed the worktree. The branch ${worktree.branch} stays.`);
            } catch (error) {
                if (error.status !== 409) {
                    throw error;
                }

                setDirty(true);
            }
        });

    if (!worktree) {
        return html`<${Sheet} title="Worktree" onClose=${closeSheet}>
            <p class="muted">This session works in its folder, not in a worktree.</p>
        <//>`;
    }

    return html`<${Sheet} title="Worktree" onClose=${closeSheet}>
        <p>
            This session works on the branch <span class="mono">${worktree.branch}</span>, in a checkout of its own: its changes stay apart from <span class="mono">${shortPath(worktree.source, server?.home)}</span>.
        </p>
        <p class="muted small">
            Ask Pi to commit, merge, or open a pull request when it is done. Removing the worktree deletes its folder; the branch and its commits stay, and Pi works in the original folder again.
        </p>
        ${
            dirty
                ? html`<div class="error-box small">
                    The worktree has uncommitted changes. Removing it anyway loses them.
                </div>
                <button class="button wide" onClick=${() => remove(true)}>Remove anyway</button>`
                : html`<button class="button wide" onClick=${() => remove(false)}>
                    Remove the worktree
                </button>`
        }
    <//>`;
}
