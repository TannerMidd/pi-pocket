// Changes: what Pi edited and what git says changed in the session's folder, each with its diff.
import { useEffect, useState } from "preact/hooks";
import { jumpToEntry } from "../chat.js";
import { actions, api, attempt, canSteer, closeSheet, notify, store } from "../store.js";
import { Diff, html, item, Loader, openFile, Sheet, shortPath } from "../ui.js";

/** The letter git's short status uses for each kind of change. */
const CHANGE_LETTERS = { modified: "M", added: "A", deleted: "D", renamed: "R", new: "N" };

/** One changed file: tap it to see its diff, and from there open it or undo its changes. */
function ChangedFile({ file, root, onChanged }) {
    const [diff, setDiff] = useState(null);
    // Undo asks for a second tap: it throws the changes away.
    const [undoing, setUndoing] = useState(false);
    const undo = () =>
        undoing
            ? attempt(async () => {
                  await actions.revert(file.path);
                  notify("info", `${file.path} is as the last commit has it.`);
                  onChanged();
              })
            : setUndoing(true);
    const toggle = () =>
        diff !== null
            ? setDiff(null)
            : attempt(async () => {
                  const response = await fetch(
                      `/api/c/${store.state.conversationId}/changes/diff?path=${encodeURIComponent(file.path)}`,
                  );
                  const text = await response.text();

                  if (!response.ok) {
                      throw new Error(JSON.parse(text).error ?? `HTTP ${response.status}`);
                  }

                  setDiff(text);
              });

    return html`<div class="changed">
        <button class="changed-head" onClick=${toggle}>
            <span class=${`change-kind ${file.kind}`} title=${file.kind}>
                ${CHANGE_LETTERS[file.kind]}
            </span>
            <span class="mono grow">${file.path}</span>
            ${file.byPi && html`<span class="chip">Pi</span>`}
            ${
                file.added !== undefined &&
                html`<span class="mono small">
                    <span class="ok">+${file.added}</span> <span class="err">−${file.removed}</span>
                </span>`
            }
        </button>
        ${
            diff !== null &&
            html`<div class="changed-actions">
                ${
                    file.kind !== "deleted" &&
                    html`<button
                        class="link small"
                        onClick=${() => openFile(`${root}/${file.path}`)}
                    >
                        Open
                    </button>`
                }
                ${
                    canSteer() &&
                    file.kind !== "renamed" &&
                    html`<button class=${`link small ${undoing ? "danger" : ""}`} onClick=${undo}>
                        ${undoing ? (file.kind === "new" || file.kind === "added" ? "Tap again to delete it" : "Tap again to undo") : "Undo changes"}
                    </button>`
                }
            </div>
            <${Diff} diff=${diff || "No difference in text."} />`
        }
    </div>`;
}

/** What changed in the session's folder: uncommitted changes in its repository, and every file Pi wrote or edited. */
export function ChangesSheet() {
    const { server } = store.state;
    const [changes, setChanges] = useState(null);
    const load = () =>
        attempt(async () => setChanges(await api(`c/${store.state.conversationId}/changes`)));

    useEffect(() => {
        load();
    }, []);
    const refresh = html`<button
        class="icon-button"
        title="Refresh"
        aria-label="Refresh"
        onClick=${() => (setChanges(null), load())}
    >
        ↻
    </button>`;

    return html`<${Sheet} title="Changes" onClose=${closeSheet} actions=${refresh}>
        ${changes === null && html`<${Loader} label="Asking git" />`}
        ${
            changes?.repo &&
            html`<p class="muted small">
                Uncommitted changes in <span class="mono">${shortPath(changes.repo.root, server?.home)}</span>
                ${changes.repo.branch ? html` on <span class="mono">${changes.repo.branch}</span>` : ""}. Tap a file for its diff.
            </p>`
        }
        ${
            changes &&
            !changes.repo &&
            html`<p class="muted small">
                This folder is not in a git repository, so only the files Pi wrote or edited are listed.
            </p>`
        }
        ${
            changes?.repo &&
            changes.files.length === 0 &&
            html`<p class="muted">No uncommitted changes.</p>`
        }
        ${changes?.files.map(
            (file) => html`<${ChangedFile}
                key=${file.path}
                file=${file}
                root=${changes.repo.root}
                onChanged=${load}
            />`,
        )}
        ${
            changes?.more > 0 &&
            html`<p class="muted small">
                And ${changes.more} more changed ${changes.more === 1 ? "file" : "files"}, not listed here.
            </p>`
        }
        ${
            changes?.piOnly.length > 0 &&
            html`<div class="group">
                <div class="group-title">
                    ${changes.repo ? "Pi also edited" : "Pi wrote or edited"}
                </div>
                ${changes.piOnly.map((each) =>
                    item(
                        html`<span class="mono">${shortPath(each.path, server?.home)}</span>`,
                        () => jumpToEntry(each.entryId),
                        "show",
                    ),
                )}
            </div>`
        }
    <//>`;
}
