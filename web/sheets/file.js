// The file viewer: a file's text, an image, or a folder's entries. `FileView` draws it in the Files tile and in the
// file sheet alike.
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { browserAvailable, openInBrowser } from "../browser.js";
import { mentionText } from "../files.js";
import { highlightLines, langOf } from "../highlight.js";
import { HtmlPreview } from "../rich.js";
import { RunFrame } from "../run-frame.js";
import { actions, canSteer, closeSheet, insertIntoComposer, notify, store } from "../store.js";
import {
    copyText,
    fileUrl,
    formatBytes,
    html,
    Icon,
    item,
    Loader,
    Markdown,
    openFile,
    Sheet,
} from "../ui.js";

/** How many lines of a file show at first: a long file draws the rest on request. */
const FILE_LINES = 3000;
/** Past this many bytes, a file shows without colors: coloring it would hold up the page. */
const COLOR_BYTES = 256 * 1024;

const isMarkdown = (path) => /\.(md|markdown|mdx)$/i.test(path);
const isPage = (path) => /\.(html?|xhtml)$/i.test(path);

/** A file's lines, colored for its language when it is not too big to. */
function useLines(file, path) {
    return useMemo(() => {
        if (file?.kind !== "text") {
            return { lines: [], colored: null };
        }

        const lines = file.text.replace(/\n$/, "").split("\n");
        const lang = langOf(path);
        const colored =
            lang && file.text.length <= COLOR_BYTES ? highlightLines(lines, lang) : null;

        return { lines, colored };
    }, [file, path]);
}

/**
 * A file of the session, read-only: text with line numbers and colors (Markdown shows rendered too), an image, or a
 * folder to browse. `line` scrolls to and marks that line. `onOpen` opens an entry of a folder; `tools` shows the
 * viewer's buttons (copy, mention, preview) in a bar of its own, for places without a header to put them in.
 */
export function FileView({ path, line, onOpen = openFile, tools = true, onLoad }) {
    const [file, setFile] = useState(null);
    const [error, setError] = useState(null);
    const markdown = isMarkdown(path);
    const page = isPage(path);
    const [preview, setPreview] = useState(markdown && line === undefined);
    const [running, setRunning] = useState(false);
    const [all, setAll] = useState(line !== undefined && line > FILE_LINES);
    const body = useRef(null);
    const { lines, colored } = useLines(file, file?.path ?? path);
    // The same element while the file and the marked line stay the same: Preact then skips its rows on every update of
    // the app, instead of comparing thousands of them.
    const rows = useMemo(
        () => html`<${FileLines} lines=${lines} colored=${colored} all=${all} line=${line} />`,
        [lines, colored, all, line],
    );

    useEffect(() => {
        let live = true;

        setFile(null);
        setError(null);
        actions.view(path).then(
            (each) => {
                if (live) {
                    setFile(each);
                    onLoad?.(each);
                }
            },
            (failure) => live && setError(failure.message),
        );

        return () => {
            live = false;
        };
    }, [path]);
    useEffect(() => {
        setPreview(markdown && line === undefined);
        setRunning(false);
    }, [path, line]);
    useEffect(() => {
        if (file?.kind === "text" && line !== undefined && !preview) {
            body.current
                ?.querySelector(`[data-line="${line}"]`)
                ?.scrollIntoView({ block: "center" });
        }
    }, [file, preview, line]);
    const shown = file?.display ?? path;
    const name = shown.replace(/\/$/, "").split("/").pop() || shown;

    return html`<div class="file-viewer">
        ${
            tools &&
            html`<div class="file-tools">
                <span class="muted small mono file-path" title=${file?.path ?? path}>
                    ${shown}
                    ${file?.size !== undefined ? ` · ${formatBytes(file.size)}` : ""}
                    ${file?.kind === "text" ? ` · ${lines.length} lines` : ""}
                </span>
                <${FileActions}
                    file=${file}
                    shown=${shown}
                    previewable=${markdown || page}
                    preview=${preview}
                    onPreview=${setPreview}
                    running=${page && preview ? running : null}
                    onRun=${setRunning}
                />
            </div>`
        }
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
                        () => onOpen(`${file.path}/${entry.name}`),
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
        ${file?.kind === "text" && preview && markdown && html`<${Markdown} text=${file.text} />`}
        ${
            file?.kind === "text" &&
            preview &&
            page &&
            html`${
                running
                    ? html`<${RunFrame} source=${file.text} title=${name} />`
                    : html`<${HtmlPreview} source=${file.text} title=${name} />`
            }
            <p class="muted small file-note">
                The files it links to (styles, scripts, images) do not load here.
                ${
                    store.state.me?.role === "owner" &&
                    browserAvailable() &&
                    html` <button class="link small" onClick=${() => openInBrowser(file.path)}>
                        Open it in the browser
                    </button>`
                }
            </p>`
        }
        ${
            file?.kind === "text" &&
            !preview &&
            html`<div class=${`file-view ${colored ? "hl" : ""}`} ref=${body}>${rows}</div>
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
    </div>`;
}

/** A file's lines, numbered, colored when there are colors, the first `FILE_LINES` of them unless `all`. */
function FileLines({ lines, colored, all, line }) {
    return (all ? lines : lines.slice(0, FILE_LINES)).map(
        (text, index) =>
            html`<div
                class=${`file-line ${index + 1 === line ? "on" : ""}`}
                data-line=${index + 1}
            >
                <span class="ln">${index + 1}</span>
                ${
                    colored
                        ? html`<span
                              class="lt"
                              dangerouslySetInnerHTML=${{ __html: colored[index] || " " }}
                          ></span>`
                        : html`<span class="lt">${text || " "}</span>`
                }
            </div>`,
    );
}

/**
 * The viewer's buttons: Preview or Source for Markdown and pages, Run for a previewed page (`running` is null where it
 * does not apply), Copy, and @ Mention.
 */
function FileActions({ file, shown, previewable, preview, onPreview, running, onRun }) {
    return html`${
        file?.kind === "text" &&
        running !== null &&
        html`<button
            class=${`button small ${running ? "on" : ""}`}
            title=${running ? "Stop its scripts" : "Run its scripts in a sandbox, as an artifact runs: it can reach the internet, not the app"}
            onClick=${() => onRun(!running)}
        >
            ${running ? "■ Stop" : "▶ Run"}
        </button>`
    }
    ${
        file?.kind === "text" &&
        previewable &&
        html`<button class="button small" onClick=${() => onPreview(!preview)}>
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
}

/** The viewer as a sheet: opened from a path in a reply, a tool card, a mention, or Changes. */
export function FileSheet({ path, line }) {
    const [name, setName] = useState(path.replace(/\/$/, "").split("/").pop() || path);

    return html`<${Sheet} title=${name} onClose=${closeSheet} wide=${true}>
        <${FileView}
            path=${path}
            line=${line}
            onLoad=${(file) => setName((file.display ?? path).replace(/\/$/, "").split("/").pop() || path)}
        />
    <//>`;
}
