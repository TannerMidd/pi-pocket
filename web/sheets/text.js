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
}) {
    const [value, setValue] = useState(initial);
    const save = () =>
        attempt(async () => {
            await submit(value);
            closeSheet();
        });

    return html`<${Sheet} title=${title} onClose=${closeSheet}>
        ${hint && html`<p class="muted small">${hint}</p>`}
        <div class="field">
            <div class="label">${label}</div>
            ${
                multiline
                    ? html`<textarea
                        rows="4"
                        value=${value}
                        placeholder=${placeholder}
                        onInput=${(event) => setValue(event.currentTarget.value)}
                    ></textarea>`
                    : html`<input
                        autofocus
                        value=${value}
                        placeholder=${placeholder}
                        onInput=${(event) => setValue(event.currentTarget.value)}
                        onKeyDown=${(event) => event.key === "Enter" && save()}
                    />`
            }
        </div>
        <button class="button primary wide" onClick=${save}>${button}</button>
    <//>`;
}
