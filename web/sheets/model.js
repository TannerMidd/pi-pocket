// The model picker: a menu under the model chip, searchable once there are many models.
import { useEffect, useRef, useState } from "preact/hooks";
import { actions, attempt, closeSheet, openSheet, store } from "../store.js";
import { anchorStyle, formatTokens, html, Icon, popAnchor } from "../ui.js";

/** Models past this many get a search box in the picker. */
const MODEL_SEARCH_AT = 8;

const coarsePointer = matchMedia("(pointer: coarse)").matches;

/** Where the picker opens: above the message box's model chip (`popAnchor`). */
const modelAnchor = () => popAnchor(".model-chip");

/**
 * The model picker: a menu that opens up from the message box's model chip, with the current model first and checked,
 * and how hard Pi thinks below. Arrows and Enter pick; a search box shows when there are many models, or when
 * `/model son` opened it already searching.
 */
export function ModelPicker() {
    const { models, view } = store.state;
    // While the picker animates out, the store has no sheet any more.
    const [query, setQuery] = useState(store.state.sheet?.query ?? "");
    // Decided once: a search box that went away when emptied would take the caret with it.
    const [searchable] = useState(() => models.length > MODEL_SEARCH_AT || query !== "");
    const [picked, setPicked] = useState(0);
    const [anchor, setAnchor] = useState(modelAnchor);
    const box = useRef(null);
    const search = useRef(null);
    const list = useRef(null);
    // Arrows scroll the list to the model they reach; the mouse does not, or the list would run away under it.
    const keyed = useRef(false);
    const agent = view.agent;
    const current = agent?.model;
    const isCurrent = (model) =>
        current?.provider === model.provider && current?.modelId === model.id;
    const needle = query.trim().toLowerCase();
    const shown = models
        .filter(
            (model) =>
                needle === "" ||
                `${model.provider}/${model.id} ${model.name}`.toLowerCase().includes(needle),
        )
        .sort((a, b) => Number(isCurrent(b)) - Number(isCurrent(a)));
    // The list can change while the picker is open.
    const active = Math.max(0, Math.min(picked, shown.length - 1));
    const levels = agent?.levels ?? ["off"];

    useEffect(() => {
        const place = () => setAnchor(modelAnchor());
        const onKey = (event) => event.key === "Escape" && closeSheet();

        addEventListener("resize", place);
        visualViewport?.addEventListener("resize", place);
        addEventListener("keydown", onKey);
        // Keys go to the picker, not the message box behind it. Phones keep their keyboard down until the search is tapped.
        (searchable && !coarsePointer ? search.current : box.current)?.focus({
            preventScroll: true,
        });

        return () => {
            removeEventListener("resize", place);
            visualViewport?.removeEventListener("resize", place);
            removeEventListener("keydown", onKey);
        };
    }, []);
    useEffect(() => {
        if (!keyed.current) {
            return;
        }

        keyed.current = false;
        list.current?.querySelector(".pop-menu-row.on")?.scrollIntoView({ block: "nearest" });
    }, [active]);

    const pick = (model) =>
        attempt(async () => {
            if (!isCurrent(model)) {
                await actions.configure({ model: { provider: model.provider, modelId: model.id } });
            }

            closeSheet();
        });

    // Arrows and Enter move through the models from the search box or the picker itself, not from its other buttons.
    const onKeyDown = (event) => {
        if (
            event.isComposing ||
            shown.length === 0 ||
            (event.target !== search.current && event.target !== box.current)
        ) {
            return;
        }

        const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;

        if (step !== 0) {
            event.preventDefault();
            keyed.current = true;
            setPicked((active + step + shown.length) % shown.length);
        } else if (event.key === "Enter" && shown[active]) {
            event.preventDefault();
            pick(shown[active]);
        }
    };

    return html`<div
        class="overlay pop-overlay"
        onClick=${(event) => event.target === event.currentTarget && closeSheet()}
    >
        <section
            class=${`pop-menu ${anchor ? "" : "free"}`}
            style=${anchorStyle(anchor)}
            ref=${box}
            role="dialog"
            aria-label="Model"
            tabindex="-1"
            onKeyDown=${onKeyDown}
        >
            <header class="pop-menu-head">
                <span>Model</span>
                <button class="pop-menu-link" onClick=${() => openSheet({ type: "providers" })}>
                    <${Icon} name="key" size=${13} /> Providers
                </button>
            </header>
            ${
                searchable &&
                html`<label class="search pop-menu-search">
                    <${Icon} name="search" size=${15} />
                    <input
                        ref=${search}
                        placeholder="Search models"
                        value=${query}
                        onInput=${(event) => {
                            setQuery(event.currentTarget.value);
                            setPicked(0);
                        }}
                    />
                </label>`
            }
            <div class="pop-menu-list" ref=${list} role="listbox" aria-label="Models">
                ${
                    models.length === 0 &&
                    html`<p class="muted pop-menu-note">
                        No models are available. Add a provider first.
                    </p>`
                }
                ${
                    models.length > 0 &&
                    shown.length === 0 &&
                    html`<p class="muted pop-menu-note">No model matches “${query.trim()}”.</p>`
                }
                ${shown.map(
                    (model, index) => html`<button
                        key=${`${model.provider}/${model.id}`}
                        class=${`pop-menu-row ${index === active ? "on" : ""}`}
                        role="option"
                        aria-selected=${isCurrent(model)}
                        title=${`${model.provider}/${model.id} · ${formatTokens(model.contextWindow)} context${model.images ? " · images" : ""}`}
                        onMouseMove=${() => index !== active && setPicked(index)}
                        onClick=${() => pick(model)}
                    >
                        <span class="pop-menu-row-text">
                            <span class="pop-menu-row-name">${model.name}</span>
                            <span class="pop-menu-row-sub">${model.provider}</span>
                        </span>
                        ${isCurrent(model) && html`<${Icon} name="check" size=${14} />`}
                    </button>`,
                )}
            </div>
            ${
                agent?.reasoning &&
                html`<div class="pop-menu-foot">
                    <div class="label">Thinking</div>
                    <div class="segmented model-levels" role="radiogroup" aria-label="Thinking">
                        ${levels.map(
                            (level) =>
                                html`<button
                                    role="radio"
                                    aria-checked=${agent.thinkingLevel === level}
                                    class=${agent.thinkingLevel === level ? "on" : ""}
                                    onClick=${() => attempt(() => actions.configure({ thinkingLevel: level }))}
                                >
                                    ${level}
                                </button>`,
                        )}
                    </div>
                </div>`
            }
        </section>
    </div>`;
}
