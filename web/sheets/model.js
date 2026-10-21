import { t } from "../i18n.js";
// The model picker: a menu over the model chip, searchable once there are many models; and the same menu for the model
// and thinking level new sessions start with.

import { useEffect, useRef, useState } from "preact/hooks";
import { actions, api, attempt, closeSheet, openSheet, store } from "../store.js";
import { useDragToClose } from "../gestures.js";
import {
    anchorStyle,
    BOTTOM_SHEETS,
    formatTokens,
    html,
    Icon,
    popAnchor,
    scrimPress,
} from "../ui.js";

/** Models past this many get a search box in the picker. */
const MODEL_SEARCH_AT = 8;

/** Over the message box the picker is 330px wide; on a phone, the width `popAnchor` gives. */
const widthOf = (anchor) =>
    matchMedia("(min-width: 700px)").matches ? Math.min(anchor.width, 330) : anchor.width;

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

    // Not signed in any more, or gone from its provider: new sessions start with it anyway, and say so, rather than
    // with a model nobody chose for them.
    if (!model) {
        return t("{{model}} (not signed in)", { model: chosen.modelId });
    }

    return `${model.name}${model.reasoning ? ` · ${t(chosen.thinkingLevel ?? "off")}` : ""}${model.signIn ? ` ${t("(needs sign-in)")}` : ""}`;
}

/** Whether a model is one the picker's search finds: each word in its id or name, as `/model` finds them. */
const matches = (model, query) => {
    const haystack = `${model.provider}/${model.id} ${model.name}`.toLowerCase();

    return query
        .trim()
        .toLowerCase()
        .split(/\s+/)
        .every((word) => haystack.includes(word));
};

/**
 * The model picker: a menu that opens up from the message box's model chip, with the current model first and checked,
 * and how hard Pi thinks below, then, for the owner, Make default. Arrows and Enter pick, and Tab switches between the
 * scoped models (Pi's `enabledModels`) and all of them; a search box shows when there are many models, or when
 * `/model son` opened it already searching. Opened for the default (`forDefault`, from the menu), it picks the model
 * and thinking level new sessions start with instead, and stays open for both.
 */
export function ModelPicker() {
    const { models, server, me } = store.state;
    const [pipId] = useState(() => store.state.sheet?.pipId);
    const view = pipId === undefined ? store.state.view : store.state.pipView;
    const locked =
        pipId !== undefined &&
        (view.conversation?.id !== pipId ||
            view.live?.busy === true ||
            (view.live?.compactions?.length ?? 0) > 0);
    const configure = (change) =>
        pipId === undefined
            ? actions.configure(change)
            : api(`c/${pipId}/configure`, { ...change, pipPanel: true });
    // While the picker animates out, the store has no sheet any more.
    const [query, setQuery] = useState(store.state.sheet?.query ?? "");
    const [forDefault] = useState(() => store.state.sheet?.forDefault === true);
    const scopedModels = models.filter((model) => model.scoped);
    // Opened already searching (`/model gem`) for models only outside the scope: it starts with all of them.
    const [showAll, setShowAll] = useState(
        () => query.trim() !== "" && !scopedModels.some((model) => matches(model, query)),
    );
    const choices = showAll || scopedModels.length === 0 ? models : scopedModels;
    // Decided once: a search box that went away when emptied would take the caret with it.
    const [searchable] = useState(() => models.length > MODEL_SEARCH_AT || query !== "");
    const [picked, setPicked] = useState(0);
    const [anchor, setAnchor] = useState(() =>
        forDefault || pipId !== undefined ? null : modelAnchor(),
    );
    const box = useRef(null);
    const search = useRef(null);
    const list = useRef(null);
    // Arrows scroll the list to the model they reach; the mouse does not, or the list would run away under it.
    const keyed = useRef(false);
    const agent = view.agent;

    // On a phone, a swipe away from where it opens closes it, as a sheet's does.
    useDragToClose(box, {
        dir: anchor?.down ? "up" : "down",
        onClose: closeSheet,
        enabled: BOTTOM_SHEETS.matches,
    });
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
    const shown = choices
        .filter((model) => matches(model, query))
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
        const place = () => setAnchor(forDefault || pipId !== undefined ? null : modelAnchor());
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
        if (locked) {
            return;
        }

        // The default's picker stays open, for its thinking level.
        if (forDefault) {
            return isCurrent(model) ? undefined : setDefault(model, level);
        }

        attempt(async () => {
            if (!isCurrent(model)) {
                await configure({ model: { provider: model.provider, modelId: model.id } });
            }

            closeSheet();
        });
    };

    const think = (each) =>
        forDefault
            ? setDefault(defaultModel, each)
            : attempt(() => configure({ thinkingLevel: each }));

    // Arrows and Enter move through the models, and Tab switches scoped and all, from the search box or the picker
    // itself, not from its other buttons: there Tab and Shift+Tab move the focus as anywhere else.
    const onKeyDown = (event) => {
        if (
            event.isComposing ||
            (event.target !== search.current && event.target !== box.current)
        ) {
            return;
        }

        if (
            event.key === "Tab" &&
            scopedModels.length > 0 &&
            !(event.shiftKey || event.altKey || event.ctrlKey || event.metaKey)
        ) {
            event.preventDefault();
            setShowAll((all) => !all);
            setPicked(0);
            list.current?.scrollTo({ top: 0 });

            return;
        }

        if (shown.length === 0) {
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
        onMouseDown=${scrimPress(closeSheet)}
    >
        <section
            class=${`pop-menu model-menu ${anchor ? (anchor.down ? "down" : "") : "free"}`}
            style=${anchorStyle(anchor && { ...anchor, width: widthOf(anchor) })}
            ref=${box}
            role="dialog"
            aria-modal="true"
            aria-label=${forDefault ? t("Default model") : t("Model")}
            aria-keyshortcuts=${scopedModels.length > 0 ? "Tab" : undefined}
            tabindex="-1"
            onKeyDown=${onKeyDown}
        >
            <div class="grip" aria-hidden="true"></div>
            <header class="pop-menu-head">
                <span>
                    ${forDefault ? t("Default model") : t("Model")}
                    ${forDefault && html`<span class="pop-menu-head-sub">${t("for new sessions")}</span>`}
                    ${
                        scopedModels.length > 0 &&
                        html`<span
                            class="model-scope"
                            role="group"
                            aria-label=${t("Model scope")}
                            title=${t("Tab switches between scoped and all models")}
                        >
                            <span aria-hidden="true">[</span>
                            <button
                                class=${!showAll ? "on" : ""}
                                aria-pressed=${!showAll}
                                title=${t("Models from Pi’s enabledModels setting")}
                                onClick=${() => {
                                    setShowAll(false);
                                    setPicked(0);
                                }}
                            >
                                ${t("scoped")}
                            </button>
                            <span aria-hidden="true">|</span>
                            <button
                                class=${showAll ? "on" : ""}
                                aria-pressed=${showAll}
                                title=${t("All models with a configured sign-in")}
                                onClick=${() => {
                                    setShowAll(true);
                                    setPicked(0);
                                }}
                            >
                                ${t("all")}
                            </button>
                            <span aria-hidden="true">]</span>
                        </span>`
                    }
                </span>

                <button class="pop-menu-link" onClick=${() => openSheet({ type: "providers" })}>
                    <${Icon} name="key" size=${13} /> ${t("Providers")}
                </button>
            </header>
            ${
                searchable &&
                html`<label class="search pop-menu-search">
                    <${Icon} name="search" size=${15} />
                    <input
                        ref=${search}
                        placeholder=${t("Search models")}
                        aria-keyshortcuts=${scopedModels.length > 0 ? "Tab" : undefined}
                        value=${query}
                        onInput=${(event) => {
                            setQuery(event.currentTarget.value);
                            setPicked(0);
                        }}
                    />
                </label>`
            }
            <div class="pop-menu-list" ref=${list} role="listbox" aria-label=${t("Models")}>
                ${
                    models.length === 0 &&
                    html`<p class="muted pop-menu-note">
                        ${t("No models are available. Add a provider first.")}
                    </p>`
                }
                ${
                    models.length > 0 &&
                    shown.length === 0 &&
                    html`<p class="muted pop-menu-note">${t("No model matches “{{query}}”.", { query: query.trim() })}</p>`
                }
                ${shown.map(
                    (model, index) => html`<button
                        key=${`${model.provider}/${model.id}`}
                        class=${`pop-menu-row ${index === active ? "on" : ""} ${isCurrent(model) ? "current" : ""}`}
                        role="option"
                        aria-selected=${isCurrent(model)}
                        disabled=${locked}
                        title=${`${model.provider}/${model.id} · ${t("{{tokens}} context", { tokens: formatTokens(model.contextWindow) })}${model.images ? ` · ${t("images")}` : ""}`}
                        onMouseMove=${() => index !== active && setPicked(index)}
                        onClick=${() => pick(model)}
                    >
                        <span class="pop-menu-row-text">
                            <span class="pop-menu-row-name">${model.name}</span>
                            <span class="pop-menu-row-sub">
                                ${model.provider}${!forDefault && isDefault(model) ? ` · ${t("default")}` : ""}${model.signIn ? ` · ${t("needs sign-in")}` : ""}
                            </span>
                        </span>
                        ${isCurrent(model) && html`<${Icon} name="check" size=${14} />`}
                    </button>`,
                )}
            </div>
            ${
                reasoning &&
                html`<div class="pop-menu-foot">
                    <div class="label">${t("Thinking")}</div>
                    <div class="segmented model-levels" role="radiogroup" aria-label=${t("Thinking")}>
                        ${levels.map(
                            (each) =>
                                html`<button
                                    role="radio"
                                    aria-checked=${level === each}
                                    disabled=${locked}
                                    class=${level === each ? "on" : ""}
                                    onClick=${() => think(each)}
                                >
                                    ${t(each)}
                                </button>`,
                        )}
                    </div>
                </div>`
            }
            ${
                pipId !== undefined || !defaultsKept()
                    ? null
                    : forDefault
                      ? html`<div class="pop-menu-foot pop-menu-default">
                          <span class="muted">
                              ${t("The owner default wins over project settings. Clear it to use a trusted project's model and thinking defaults for later new sessions. Existing sessions do not change.")}
                          </span>
                          ${
                              chosen
                                  ? html`<button
                                        class="pop-menu-link"
                                        onClick=${() => attempt(() => actions.setDefaultModel(null))}
                                    >
                                        ${t("Clear owner default: use project defaults, then last picked")}
                                    </button>`
                                  : html`<span class="muted">
                                        ${t("No owner default: new sessions use trusted project defaults, then the last model picked, then Pi's global default.")}
                                    </span>`
                          }
                      </div>`
                      : // Only the owner makes a default: no one else gets an empty footer.
                        owner &&
                        models.some((model) => isCurrent(model)) &&
                        html`<div class="pop-menu-foot pop-menu-default">
                            ${
                                sessionIsDefault
                                    ? html`<span class="pop-menu-default-mark">
                                          <${Icon} name="check" size=${13} /> ${t("Default")}
                                      </span>`
                                    : html`<button
                                          class="pop-menu-link"
                                          title=${t("New sessions start with this model and thinking level")}
                                          onClick=${() => setDefault(agent.model, agent.thinkingLevel ?? "off")}
                                      >
                                          ${t("Make default")}
                                      </button>`
                            }
                        </div>`
            }
        </section>
    </div>`;
}
