// Changes as a sheet: the same review as the Files tile's Changes tab, for places that open a sheet.
import { DiffReview } from "../diff.js";
import { closeSheet } from "../store.js";
import { html, Sheet } from "../ui.js";

/** What changed in the session's folder: uncommitted changes in its repository, and every file Pi wrote or edited. */
export function ChangesSheet() {
    return html`<${Sheet} title="Changes" onClose=${closeSheet} wide=${true}>
        <${DiffReview} autoFocus=${true} />
    <//>`;
}
