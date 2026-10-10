// The model picker: a menu over the model chip, searchable once there are many models; and the same menu for the model
// and thinking level new sessions start with.
import { useEffect, useRef, useState } from "preact/hooks";
import { actions, attempt, closeSheet, openSheet, store } from "../store.js";
import { anchorStyle, formatTokens, html, Icon, popAnchor } from "../ui.js";

/** Models past this many get a search box in the picker. */
const MODEL_SEARCH_AT = 8;

const coarsePointer = matchMedia("(pointer: coarse)").matches;

/** Where the picker opens: above the message box's model chip (`popAnchor`). */
const modelAnchor = () => popAnchor(".model-chip");

/** Whether the server keeps a default model: one started before it did sends none, and would ignore one. */
export const defaultsKept = () => store.state.server?.defaultModel !== undefined;

/** A model chosen as the default (`server.defaultModel`) and its thinking level, in a few words: "Opus 4.5 · high". */
export function defaultLabel(chosen, models) {
    if (!chosen) {
        return "";
    }

    const model = models.find(
        (each) => each.provider === chosen.provider && each.id === chosen.modelId,
    );

    // Not signed in any more, or gone from its provider: new sessions start with the last model picked instead.
    if (!model) {
        return `${chosen.modelId} (not available: the last model picked)`;
    }

    return `${model.name}${model.reasoning ? ` · ${chosen.thinkingLevel ?? "off"}` : ""}`;
}

/**
 * The model picker: a menu that opens up from the message box's model chip, with the current model first and checked,
 * and how hard Pi thinks below, then what new sessions start with. Arrows and Enter pick; a search box shows when there
 * are many models, or when `/model son` opened it already searching. Opened for the default (`forDefault`, from the
 * menu), it picks the model and thinking level new sessions start with instead, and stays open for both.
 */
export function ModelPicker() {
    const { models, view, server, me } = store.state;
    // While the picker animates out, the store has no sheet any more.
    const [query, setQuery] = useState(store.state.sheet?.query ?? "");
    const [forDefault] = useState(() => store.state.sheet?.forDefault === true);
    // Decided once: a search box that went away when emptied would take the caret with it.
    const [searchable] = useState(() => models.length > MODEL_SEARCH_AT || query !== "");
    const [picked, setPicked] = useState(0);
    const [anchor, setAnchor] = useState(() => (forDefault ? null : modelAnchor()));
    const box = useRef(null);
    const search = useRef(null);
    const list = useRef(null);
    // Arrows scroll the list to the model they reach; the mouse does not, or the list would run away under it.
    const keyed = useRef(false);
    const agent = view.agent;
    const owner = me?.role === "owner";
    const chosen = server?.defaultModel ?? null;
    const isDefault = (model) =>
        chosen?.provider === model?.provider && chosen?.modelId === (model?.id ?? model?.modelId);
    const defaultModel = models.find(isDefault);
    // The model and thinking level this picker sets: the session's, or the default's.
    const current = forDefault ? chosen : agent?.model;
    const isCurrent = (model) =>
        current?.provider === model.provider && current?.modelId === model.id;
    const levels = (forDefault ? defaultModel?.levels : agent?.levels) ?? ["off"];
    // Before there is a default, the first one picked thinks as hard as this session does.
    const level = forDefault
        ? (chosen?.thinkingLevel ?? agent?.thinkingLevel ?? "off")
        : agent?.thinkingLevel;
    const reasoning = forDefault ? defaultModel?.reasoning : agent?.reasoning;
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
    // The session's model and level are the default already.
    const sessionIsDefault =
        !forDefault &&
        isDefault(agent?.model) &&
        (chosen?.thinkingLevel ?? "off") === (agent?.thinkingLevel ?? "off");
    const setDefault = (model, thinkingLevel) =>
        attempt(() =>
            actions.setDefaultModel({
                provider: model.provider,
                modelId: model.id ?? model.modelId,
                thinkingLevel,
            }),
        );

    useEffect(() => {
        // The default's picker has no chip to open from: it stays in the middle.
        const place = () => setAnchor(forDefault ? null : modelAnchor());
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

    const pick = (model) => {
        // The default's picker stays open, for its thinking level.
        if (forDefault) {
            return isCurrent(model) ? undefined : setDefault(model, level);
        }

        attempt(async () => {
            if (!isCurrent(model)) {
                await actions.configure({ model: { provider: model.provider, modelId: model.id } });
            }

            closeSheet();
        });
    };

    const think = (each) =>
        forDefault
            ? setDefault(defaultModel, each)
            : attempt(() => actions.configure({ thinkingLevel: each }));

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
            class=${`pop-menu ${anchor ? (anchor.down ? "down" : "") : "free"}`}
            style=${anchorStyle(anchor)}
            ref=${box}
            role="dialog"
            aria-label=${forDefault ? "Default model" : "Model"}
            tabindex="-1"
            onKeyDown=${onKeyDown}
        >
            <header class="pop-menu-head">
                <span>
                    ${forDefault ? "Default model" : "Model"}
                    ${forDefault && html`<span class="pop-menu-head-sub">for new sessions</span>`}
                </span>
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
                            <span class="pop-menu-row-sub">
                                ${model.provider}${!forDefault && isDefault(model) ? " · default" : ""}
                            </span>
                        </span>
                        ${isCurrent(model) && html`<${Icon} name="check" size=${14} />`}
                    </button>`,
                )}
            </div>
            ${
                reasoning &&
                html`<div class="pop-menu-foot">
                    <div class="label">Thinking</div>
                    <div class="segmented model-levels" role="radiogroup" aria-label="Thinking">
                        ${levels.map(
                            (each) =>
                                html`<button
                                    role="radio"
                                    aria-checked=${level === each}
                                    class=${level === each ? "on" : ""}
                                    onClick=${() => think(each)}
                                >
                                    ${each}
                                </button>`,
                        )}
                    </div>
                </div>`
            }
            ${
                !defaultsKept()
                    ? null
                    : forDefault
                      ? html`<div class="pop-menu-foot pop-menu-default">
                          ${
                              chosen
                                  ? html`<button
                                        class="pop-menu-link"
                                        onClick=${() => attempt(() => actions.setDefaultModel(null))}
                                    >
                                        Start with the last model picked instead
                                    </button>`
                                  : html`<span class="muted">
                                        None chosen: new sessions start with the last model picked.
                                    </span>`
                          }
                      </div>`
                      : html`<div class="pop-menu-foot pop-menu-default">
                          <span class="pop-menu-default-text">
                              <span class="muted">New sessions:</span>
                              ${" "}${chosen ? defaultLabel(chosen, models) : "the last model picked"}
                          </span>
                          ${
                              owner &&
                              models.some((model) => isCurrent(model)) &&
                              (sessionIsDefault
                                  ? html`<span class="pop-menu-default-mark">
                                        <${Icon} name="check" size=${13} /> Default
                                    </span>`
                                  : html`<button
                                        class="pop-menu-link"
                                        title="New sessions start with this model and thinking level"
                                        onClick=${() => setDefault(agent.model, agent.thinkingLevel ?? "off")}
                                    >
                                        Make default
                                    </button>`)
                          }
                      </div>`
            }
        </section>
    </div>`;
}
