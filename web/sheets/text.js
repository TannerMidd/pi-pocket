// One text field and a button: renaming, resetting, instructions, compacting, and your name.
import { useState } from "preact/hooks";
import { attempt, closeSheet } from "../store.js";
import { html, Sheet } from "../ui.js";

export function TextSheet({
    title,
    label,
    hint = "",
    initial = "",
    placeholder = "",
    submit,
    multiline = false,
    button = "Save",
    header = null,
    footer = null,
}) {
    const [value, setValue] = useState(initial);
    const save = () =>
        attempt(async () => {
            await submit(value);
            closeSheet();
        });

    return html`<${Sheet} title=${title} onClose=${closeSheet}>
        ${header}
        ${hint && html`<p class="muted small">${hint}</p>`}
        <div class="field">
            <div class="label">${label}</div>
            ${
                multiline
                    ? html`<textarea
                        rows="4"
                        aria-label=${label}
                        value=${value}
                        placeholder=${placeholder}
                        onInput=${(event) => setValue(event.currentTarget.value)}
                    ></textarea>`
                    : html`<input
                        autofocus
                        aria-label=${label}
                        value=${value}
                        placeholder=${placeholder}
                        onInput=${(event) => setValue(event.currentTarget.value)}
                        onKeyDown=${(event) => event.key === "Enter" && save()}
                    />`
            }
        </div>
        <div class="sheet-actions">
            <button class="button" onClick=${closeSheet}>Cancel</button>
            <button class="button primary" onClick=${save}>${button}</button>
        </div>
        ${footer}
    <//>`;
}
