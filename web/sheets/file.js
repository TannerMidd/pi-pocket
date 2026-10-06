// The file viewer: a file's text, an image, or a folder's entries.
import { useEffect, useRef, useState } from "preact/hooks";
import { mentionText } from "../files.js";
import { actions, canSteer, closeSheet, insertIntoComposer, notify } from "../store.js";
import {
    copyText,
    fileUrl,
    formatBytes,
    html,
    Icon,
    item,
    Loader,
    markdown,
    Markdown,
    openFile,
    Sheet,
} from "../ui.js";

/** How many lines of a file show at first: a long file draws the rest on request. */
const FILE_LINES = 3000;

/**
 * A file of the session, read-only: text with line numbers (Markdown shows rendered too), an image, or a folder to
 * browse. Opened from a path in a reply, a tool card, a mention, or Changes; `line` scrolls to and marks that line.
 */
export function FileSheet({ path, line }) {
    const [file, setFile] = useState(null);
    const [error, setError] = useState(null);
    const markdown = /\.(md|markdown|mdx)$/i.test(path);
    const [preview, setPreview] = useState(markdown && line === undefined);
    const [all, setAll] = useState(line !== undefined && line > FILE_LINES);
    const body = useRef(null);

    useEffect(() => {
        actions.view(path).then(setFile, (failure) => setError(failure.message));
    }, [path]);
    useEffect(() => {
        if (file?.kind === "text" && line !== undefined && !preview) {
            body.current
                ?.querySelector(`[data-line="${line}"]`)
                ?.scrollIntoView({ block: "center" });
        }
    }, [file, preview]);
    const shown = file?.display ?? path;
    const name = shown.replace(/\/$/, "").split("/").pop() || shown;
    const lines = file?.kind === "text" ? file.text.replace(/\n$/, "").split("\n") : [];
    const actionsBar = html`${
        file?.kind === "text" &&
        markdown &&
        html`<button class="button small" onClick=${() => setPreview(!preview)}>
            ${preview ? "Source" : "Preview"}
        </button>`
    }
    ${
        file?.kind === "text" &&
        html`<button
            class="icon-button"
            title="Copy"
            aria-label="Copy"
            onClick=${() => copyText(file.text).then(() => notify("info", "Copied."))}
        >
            ⧉
        </button>`
    }
    ${
        file &&
        canSteer() &&
        html`<button
            class="button small"
            title="Mention it in the message box"
            onClick=${() => insertIntoComposer(`${mentionText(shown)} `, [], { inline: true })}
        >
            @ Mention
        </button>`
    }`;

    return html`<${Sheet} title=${name} onClose=${closeSheet} wide=${true} actions=${actionsBar}>
        <p class="muted small mono file-path">
            ${shown}
            ${file?.size !== undefined ? ` · ${formatBytes(file.size)}` : ""}
            ${file?.kind === "text" ? ` · ${lines.length} lines` : ""}
        </p>
        ${error && html`<p class="muted">${error}</p>`}
        ${!file && !error && html`<${Loader} label="Opening" />`}
        ${
            file?.kind === "image" &&
            html`<img class="file-image" src=${fileUrl(file.path)} alt=${name} />`
        }
        ${
            file?.kind === "binary" &&
            html`<p class="muted">A binary file: nothing to show as text.</p>`
        }
        ${
            file?.kind === "other" &&
            html`<p class="muted">Not a regular file (a pipe or a device, say): nothing to show.</p>`
        }
        ${
            file?.kind === "folder" &&
            html`<div class="group">
                ${file.entries.length === 0 && html`<p class="muted">An empty folder.</p>`}
                ${file.entries.map((entry) =>
                    item(
                        html`<span class="file-entry">
                            <${Icon} name=${entry.dir ? "folder" : "file"} size=${15} /> ${entry.name}
                            ${entry.dir ? "/" : ""}
                        </span>`,
                        () => openFile(`${file.path}/${entry.name}`),
                    ),
                )}
                ${
                    file.truncated &&
                    html`<p class="muted small">
                        Only the first ${file.entries.length} are listed.
                    </p>`
                }
            </div>`
        }
        ${file?.kind === "text" && preview && html`<${Markdown} text=${file.text} />`}
        ${
            file?.kind === "text" &&
            !preview &&
            html`<div class="file-view" ref=${body}>
                ${(all ? lines : lines.slice(0, FILE_LINES)).map(
                    (text, index) =>
                        html`<div
                            class=${`file-line ${index + 1 === line ? "on" : ""}`}
                            data-line=${index + 1}
                        >
                            <span class="ln">${index + 1}</span>
                            <span class="lt">${text || " "}</span>
                        </div>`,
                )}
            </div>
            ${
                !all &&
                lines.length > FILE_LINES &&
                html`<button class="link" onClick=${() => setAll(true)}>
                    Show all ${lines.length} lines
                </button>`
            }`
        }
        ${
            file?.kind === "text" &&
            file.truncated &&
            html`<p class="muted small">
                Only the first ${formatBytes(file.text.length)} are shown.
            </p>`
        }
    <//>`;
}
