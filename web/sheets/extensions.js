import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { browserModuleState } from "../extension-ui.js";
import { api, closeSheet, store } from "../store.js";
import { html, Icon, Loader, Sheet, shortPath } from "../ui.js";
import { ModuleInspector, SafeMode } from "./extension-inspector.js";
import { groupOrder, iconOf, libraryRows, matchesRow } from "./extension-library-model.js";

const GUIDE = "https://tannermidd.github.io/pi-pocket/docs/extensions/first-extension/";
const split = matchMedia("(min-width: 1000px)");

function statusNote({ module, installed }) {
    if (installed?.revoked != null) {
        return "Revoked by the gallery";
    }

    if (module?.error) {
        return "Did not load";
    }

    const here = module && browserModuleState(module.file.replace(/\.ts$/, ""));

    if (module?.enabled && ["failed", "off"].includes(here?.status)) {
        return "Off in this tab";
    }

    if (installed?.changed.length) {
        return "Files changed since install";
    }

    return installed?.update ? "Update available" : null;
}

function LibraryRow({ row, current, select }) {
    const note = statusNote(row);

    return html`<button
        type="button"
        class="library-row"
        data-file=${row.file}
        aria-current=${current || undefined}
        onClick=${() => select(row)}
    >
        <span class="library-icon"><${Icon} name=${iconOf(row.module)} size=${18} /></span>
        <span class="library-copy">
            <span class="library-name">${row.title}</span>
            <span class=${`library-line ${note ? "warn" : ""}`}>${note ?? row.line}</span>
        </span>
        <span class=${`library-state ${row.enabled ? "enabled" : ""}`}>${row.state}</span>
        <${Icon} class="library-chevron" name="chevron" size=${13} />
    </button>`;
}

export function ExtensionsSheet(props) {
    return html`<${Sheet}
        title="Extensions"
        onClose=${closeSheet}
        wide=${true}
        className="extension-library-sheet"
        eyebrow="Pi Pocket / Settings"
    >
        <${ExtensionsContent} ...${props} />
    <//>`;
}

export function ExtensionsContent({
    galleryInstalled,
    galleryEntries,
    bookmark,
    selectedFile,
    selectedGallery,
    onSelect,
    onSelectGallery,
    onBack,
    onChanged,
    renderThemes,
    renderGalleryDetail,
    galleryProblem,
}) {
    const [data, setData] = useState(null);
    const [error, setError] = useState(null);
    const [query, setQuery] = useState(bookmark?.from?.query ?? "");
    const [filter, setFilter] = useState(bookmark?.from?.filter ?? "All");
    const [wide, setWide] = useState(split.matches);
    const root = useRef(null);
    const search = useRef(null);
    const groups = useRef(null);
    const detail = useRef(null);
    const localBookmark = useRef({});
    const position = bookmark ?? localBookmark.current;
    const pending = useRef(null);
    const owner = store.state.me?.role === "owner";
    const modelState = store.state.guard?.model?.state;
    const serverExtensions = store.state.server?.extensions?.join("\n");
    const selected = selectedFile || selectedGallery;

    const load = async () => {
        pending.current?.abort();
        const request = new AbortController();

        pending.current = request;

        try {
            const answer = await api("extensions", undefined, { signal: request.signal });

            if (!request.signal.aborted) {
                setData(answer);
                setError(null);
            }
        } catch (failure) {
            if (!request.signal.aborted) {
                setError(
                    failure.status === 404
                        ? "Restart the server to manage extensions here."
                        : failure.message,
                );
            }
        }
    };

    useEffect(() => {
        load();

        return () => pending.current?.abort();
    }, [modelState, serverExtensions, galleryInstalled]);
    useEffect(() => {
        const resize = () => setWide(split.matches);

        split.addEventListener("change", resize);

        return () => split.removeEventListener("change", resize);
    }, []);

    useLayoutEffect(() => {
        groups.current.scrollTop = 0;
    }, [query, filter]);

    useLayoutEffect(() => {
        if (selected) {
            detail.current.scrollTop = 0;
            detail.current.focus({ preventScroll: true });
        }
    }, [selected]);

    useLayoutEffect(() => {
        const from = position.from;

        if (!selected && from && data) {
            const button = groups.current.querySelector(from.selector);

            groups.current.scrollTop = from.top;
            (button ?? search.current).focus({ preventScroll: true });
            delete position.from;
        }
    }, [selected, data]);

    useEffect(() => {
        const sheet = root.current.closest(".sheet");

        const shortcut = (event) => {
            // A phone detail has its own Back step. Escape inside a confirmation belongs to that question.
            if (
                selected &&
                !wide &&
                event.key === "Escape" &&
                !event.isComposing &&
                event.keyCode !== 229 &&
                !event.defaultPrevented &&
                !sheet.querySelector('[role="alertdialog"], .ext-dialog')
            ) {
                event.preventDefault();
                event.stopPropagation();
                onBack();

                return;
            }

            if (
                event.key === "/" &&
                !event.altKey &&
                !event.metaKey &&
                !event.ctrlKey &&
                !event.isComposing &&
                !event.defaultPrevented &&
                (!selected || wide) &&
                !event.target.closest(
                    "input, textarea, select, [contenteditable], [role=alertdialog], .ext-dialog",
                )
            ) {
                event.preventDefault();
                event.stopPropagation();
                search.current.focus();
            }
        };

        sheet.addEventListener("keydown", shortcut);

        return () => sheet.removeEventListener("keydown", shortcut);
    }, [selected, wide]);

    const rows = libraryRows(data?.modules ?? [], galleryInstalled, galleryEntries);
    const visible = rows.filter((row) => matchesRow(row, query, filter));
    const row = selectedFile
        ? rows.find((row) => row.file === selectedFile)
        : selectedGallery
          ? rows.find((row) => row.installed?.name === selectedGallery)
          : wide && visible[0];
    const item = row?.installed ?? galleryInstalled?.find((each) => each.name === selectedGallery);
    const changed = () => Promise.all([load(), item && onChanged?.()]);
    const themes =
        filter === "All" &&
        renderThemes?.(query, (name) => {
            remember(`[data-theme-name="${CSS.escape(name)}"]`);
            onSelectGallery(name);
        });

    function remember(selector) {
        position.from = { query, filter, selector, top: groups.current.scrollTop };
    }

    const select = (row) => {
        remember(`[data-file="${CSS.escape(row.file)}"]`);
        onSelect(row.file);
    };

    const management =
        row?.module &&
        html`<${ModuleInspector}
        module=${row.module}
        data=${data}
        installed=${item ?? (galleryInstalled ? null : undefined)}
        galleryManaged=${Boolean(item && renderGalleryDetail)}
        onChanged=${changed}
    />`;

    const step = (event) => {
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing) {
            return;
        }

        const fromSearch = event.target === search.current;
        const buttons = [...groups.current.querySelectorAll(".library-row")];
        const at = buttons.indexOf(event.target);

        if (at < 0 && !(fromSearch && event.key === "ArrowDown")) {
            return;
        }

        const index = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: buttons.length - 1 }[
            event.key
        ];

        if (index !== undefined && buttons.length) {
            event.preventDefault();
            buttons[Math.max(0, Math.min(buttons.length - 1, index))].focus();
        }
    };

    return html`<div ref=${root} class=${`extension-library ${selected ? "has-selection" : ""}`}>
        <div class="library-list" onKeyDown=${step}>
            <div class="library-tools">
                <label class="library-search">
                    <${Icon} name="search" size=${16} />
                    <input
                        ref=${search}
                        type="search"
                        value=${query}
                        placeholder="Find an extension…"
                        aria-label="Search installed extensions and themes"
                        onInput=${(event) => setQuery(event.currentTarget.value)}
                    />
                    <kbd aria-hidden="true">/</kbd>
                </label>
                <div class="library-filters" role="group" aria-label="Extension state">
                    ${["All", "On", "Off"].map(
                        (value) => html`<button
                        key=${value}
                        aria-pressed=${value === filter}
                        onClick=${() => setFilter(value)}
                    >${value}</button>`,
                    )}
                </div>
            </div>
            <div ref=${groups} class="library-groups">
                <${SafeMode} />
                ${error && html`<div class="error-box small">${error} <button class="link" onClick=${load}>Retry</button></div>`}
                ${!data && !error && html`<${Loader} label="Loading extensions" />`}
                ${groupOrder.map((group) => {
                    const members = visible.filter((each) => each.group === group);

                    return (
                        members.length > 0 &&
                        html`<section key=${group} class="library-group">
                        <h3>${group}</h3>
                        ${members.map(
                            (each) => html`<${LibraryRow}
                            key=${each.file}
                            row=${each}
                            current=${(wide || selected) && each.file === row?.file}
                            select=${select}
                        />`,
                        )}
                    </section>`
                    );
                })}
                ${themes}
                ${data && !visible.length && !themes && html`<p class="library-empty">No installed extensions match.</p>`}
                ${galleryProblem}
                ${
                    owner &&
                    data?.dropIns &&
                    html`<details class="library-guide">
                    <summary>Add your own extension</summary>
                    <p>Put a <code>.ts</code> module in <code>${shortPath(data.dropIns, store.state.server?.home)}</code>. It stays off until you enable it.</p>
                    <a class="link" href=${GUIDE} target="_blank" rel="noopener noreferrer">Extension guide <${Icon} name="external" size=${13} /></a>
                </details>`
                }
            </div>
        </div>
        <section
            class="library-detail"
            ref=${detail}
            tabindex="-1"
            aria-label=${row?.title ?? item?.title ?? "Extension details"}
        >
            ${
                selected &&
                html`<button class="library-back" onClick=${onBack}>
                <${Icon} name="back" size=${16} /> Back to Installed
            </button>`
            }
            ${row || item ? html`<div class="library-crumb">Installed <span>/</span> ${row?.group ?? "Themes"}</div>` : null}
            ${
                item && renderGalleryDetail
                    ? renderGalleryDetail(item, row?.module, management)
                    : management ||
                      html`<p class="library-empty">${selected && data ? "This extension is no longer listed." : "Choose an extension to see its details."}</p>`
            }
        </section>
    </div>`;
}
