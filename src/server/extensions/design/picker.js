// The design picker: the session's designs, variations together, with the design system pinned above them.
import { latestOf } from "./data.js";
import { unsavedOf } from "./unsaved.js";

export function createPicker(env) {
    const { pocket, parts } = env;
    const { html, useState } = pocket;
    const { Ico, Popover, ago } = parts;

    const listNote = (design) =>
        `${design.id} · v${latestOf(design)} · ${ago(design.versions.at(-1)?.createdAt ?? 0)}`;

    function systemNote(system, count) {
        if (system.status === "idle" || system.status === "loading") {
            return "Tokens, components, and guidelines";
        }

        if (system.data) {
            return `${system.data.name} · ${system.data.tokens.length} tokens${count > 0 ? ` · ${count} unsaved` : ""}`;
        }

        return system.legacy ? "A Markdown file, not yet tokens" : "Not set up yet";
    }

    function Picker({ s, designs, design, onClose }) {
        const [query, setQuery] = useState("");
        const words = query.trim().toLowerCase();
        const shown = designs.filter(
            (each) =>
                words === "" ||
                each.title.toLowerCase().includes(words) ||
                each.id.includes(words) ||
                (each.group ?? "").includes(words),
        );
        const rows = [];
        const grouped = new Set();
        const inSystem = s.view === "system";

        for (const each of shown) {
            if (each.group && !grouped.has(each.group)) {
                grouped.add(each.group);
                rows.push({ header: each.group });
                rows.push(...shown.filter((other) => other.group === each.group));
            } else if (!each.group) {
                rows.push(each);
            }
        }

        return html`<${Popover}
            label="Designs"
            onClose=${onClose}
            wide=${true}
            sheet=${env.sizeClass(s) === "narrow"}
        >
            ${
                designs.length > 7 &&
                html`<input
                    class="dsn-search"
                    type="search"
                    placeholder="Find a design"
                    value=${query}
                    onInput=${(event) => setQuery(event.currentTarget.value)}
                />`
            }
            <ul class="dsn-list" aria-label="Designs">
                ${
                    words === "" &&
                    html`<li>
                        <button
                            type="button"
                            aria-current=${inSystem}
                            class=${`dsn-list-item dsy-pinned ${inSystem ? "on" : ""}`}
                            onClick=${() => {
                                env.openSystem();
                                onClose();
                            }}
                        >
                            <span class="dsy-pinned-mark"
                                ><${Ico} name="palette" size=${16}
                            /></span>
                            <span class="dsn-list-main">
                                <strong>Design system</strong>
                                <span class="muted small"
                                    >${systemNote(s.system, unsavedOf(s.system.data, s.history))}</span
                                >
                            </span>
                            ${inSystem && html`<${Ico} name="check" size=${15} />`}
                        </button>
                    </li>`
                }
                ${rows.map((row) =>
                    row.header
                        ? html`<li class="dsn-list-head" key=${`g:${row.header}`}>
                              <${Ico} name="layers" size=${13} /> ${row.header}
                          </li>`
                        : html`<li key=${row.id}>
                              <button
                                  type="button"
                                  aria-current=${!inSystem && row.id === design?.id}
                                  class=${`dsn-list-item ${!inSystem && row.id === design?.id ? "on" : ""} ${row.group ? "in-group" : ""}`}
                                  onClick=${() => {
                                      env.open(row.id);
                                      onClose();
                                  }}
                              >
                                  <span class="dsn-list-main">
                                      <strong>${row.title}</strong>
                                      <span class="muted small mono">${listNote(row)}</span>
                                  </span>
                                  ${row.kind === "deck" && html`<span class="dsn-chip">deck</span>`}
                                  ${!inSystem && row.id === design?.id && html`<${Ico} name="check" size=${15} />`}
                              </button>
                          </li>`,
                )}
                ${shown.length === 0 && words !== "" && html`<li class="muted small dsn-empty">Nothing by that name.</li>`}
            </ul>
        <//>`;
    }

    return { Picker, listNote };
}
