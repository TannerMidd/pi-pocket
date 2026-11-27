// The message box's ⋯ button and its sheet. In a box up to 480px wide the row is always one row: Plan and the buttons
// that extensions added fold into one ⋯ button after the last item that stays, and Attach joins them where the model's
// name would show less than eight characters. The items keep their order from the slot (Appearance sets it).
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { slotItems, slotMore } from "./slots.js";
import { closeSheet, openSheet, store } from "./store.js";
import { html, Icon, Sheet } from "./ui.js";

/** The widest box (its content, as the stylesheet's container query sees it) whose row folds. */
export const NARROW = 480;
/** The model's name, cut, shows less than this (about eight characters) when Attach folds too. */
const NAME_MIN = 52;

/** What the row last decided, for the sheet: how far it folds (0 none, 1 Plan and extensions, 2 Attach too), and its file picker. */
const shared = { fold: 0, picker: null };

/** The items that fold at `fold`, with what the sheet and ⋯ say of each: `{ id, name, icon, iconPath, toggle, on, badge, run }`. */
function foldedEntries(fold, picker) {
    return fold === 0
        ? []
        : slotMore("composer", { picker, view: store.state.view }).filter(
              (entry) => entry.fold <= fold,
          );
}

/** ⋯'s name for a screen reader: "More actions, Plan on, Ask someone 2". */
function moreLabel(entries) {
    const notes = entries.flatMap((entry) => [
        entry.on && `${entry.name} on`,
        entry.badge && `${entry.name} ${entry.badge}`,
    ]);

    return ["More actions", ...notes].filter(Boolean).join(", ");
}

/**
 * Whether the row is too tight: the model's name cut to less than `NAME_MIN`, or the row wider than its box. Both
 * states of Send and the mic count (while Pi works one shows, by whether there is text), so typing never moves a button.
 */
function tight(row) {
    const box = row.closest(".composer");
    const was = box.classList.contains("filled");
    const result = [true, false].some((filled) => {
        box.classList.toggle("filled", filled);

        const name = row.querySelector(".model-name");

        return (
            (name && name.scrollWidth > name.clientWidth && name.clientWidth < NAME_MIN) ||
            row.scrollWidth > row.clientWidth
        );
    });

    box.classList.toggle("filled", was);

    return result;
}

/**
 * The message box's row: the `composer` slot's items, then ⋯ with those that fold, then `children` (Steer and Queue,
 * the mic, Send, and Stop, which stay). `context` is what the slot's items get; `fits` is a string of what changes the
 * items' widths: the row measures again when it changes.
 */
export function ComposerRow({ context, fits, children }) {
    const row = useRef(null);
    const [width, setWidth] = useState(0);
    const [grown, setGrown] = useState(false);
    const [fonts, setFonts] = useState(0);
    const narrow = width > 0 && width <= NARROW;
    const first = narrow ? foldedEntries(1, context.picker) : [];
    const fold = first.length > 0 ? (grown ? 2 : 1) : 0;
    const entries = fold === 2 ? foldedEntries(2, context.picker) : first;
    const gone = new Set(entries.map((entry) => entry.id));
    const key = `${narrow}|${width}|${fits}|${fonts}|${first.map((entry) => entry.id)}`;

    useLayoutEffect(() => {
        const box = row.current.closest(".composer");
        const watch = new ResizeObserver(([entry]) =>
            setWidth(Math.round(entry.contentRect.width)),
        );
        const fontsChanged = () => setFonts((count) => count + 1);

        setWidth(Math.round(box.clientWidth));
        watch.observe(box);
        document.fonts?.ready.then(fontsChanged);
        document.fonts?.addEventListener("loadingdone", fontsChanged);

        return () => {
            watch.disconnect();
            document.fonts?.removeEventListener("loadingdone", fontsChanged);
        };
    }, []);

    // Something changed the widths: start from Plan and the extensions alone, and measure.
    useLayoutEffect(() => setGrown(false), [key]);
    useLayoutEffect(() => {
        if (fold === 1 && tight(row.current)) {
            setGrown(true);
        }
    }, [key, fold]);

    // The sheet shows what the row folds now; a row that folds nothing closes it.
    shared.fold = fold;
    shared.picker = context.picker;

    useLayoutEffect(() => {
        if (fold === 0 && store.state.sheet?.type === "composer-more") {
            closeSheet();
        }
    }, [fold]);
    useLayoutEffect(
        () => () => {
            shared.fold = 0;

            if (store.state.sheet?.type === "composer-more") {
                closeSheet();
            }
        },
        [],
    );

    return html`<div class="composer-row" data-part="composer-tools" ref=${row}>
        ${slotItems("composer", context)
            .filter(({ id }) => !gone.has(id))
            .map(({ node }) => node)}
        ${entries.length > 0 && html`<${MoreButton} entries=${entries} />`} ${children}
    </div>`;
}

/** ⋯: opens the sheet of what the row folded. A dot says that one of them is on or has a count. */
function MoreButton({ entries }) {
    const news = entries.some((entry) => entry.on || entry.badge);

    return html`<button
        class=${`icon-button more-button ${news ? "on" : ""}`}
        data-part="composer-button composer-more"
        aria-label=${moreLabel(entries)}
        aria-haspopup="dialog"
        title="More actions"
        onClick=${() => openSheet({ type: "composer-more" })}
    >
        <${Icon} name="more" size=${18} stroke=${2.6} />
        ${news && html`<span class="more-dot" aria-hidden="true"></span>`}
    </button>`;
}

/** What an item says of itself, on the right of its row. */
function State({ entry }) {
    const on = html`<span class="more-state on">
        <${Icon} name="check" size=${13} stroke=${2.4} />
        On
    </span>`;

    if (entry.toggle) {
        return entry.on ? on : html`<span class="more-state">Off</span>`;
    }

    return html`${entry.on && on}${
        entry.badge &&
        html`<span class="more-state">
            <span class="more-count" aria-hidden="true">${entry.badge}</span>
        </span>`
    }`;
}

/** The sheet ⋯ opens: each folded item by its icon and name, in the row's order, with its state. */
export function ComposerMoreSheet() {
    const entries = foldedEntries(shared.fold, shared.picker);

    const close = () => {
        closeSheet();
        // The ⋯ takes focus again, not the text box behind it (Escape, the close button, a tap outside).
        document.querySelector('[data-part~="composer-more"]')?.focus({ preventScroll: true });
    };

    if (entries.length === 0) {
        return null;
    }

    return html`<${Sheet} title="More actions" onClose=${close} className="more-sheet">
        <p class="muted small more-lead">From the message box, in its order.</p>
        <div class="more-list" data-part="composer-more-sheet">
            ${entries.map(
                (entry) => html`<button
                    key=${entry.id}
                    type="button"
                    class="list-item more-item"
                    data-item=${entry.id}
                    aria-label=${
                        !entry.toggle && entry.badge
                            ? `${entry.name}, ${entry.badge}`
                            : !entry.toggle && entry.on
                              ? `${entry.name}, on`
                              : entry.name
                    }
                    aria-pressed=${entry.toggle ? (entry.on ? "true" : "false") : undefined}
                    onClick=${() => {
                        closeSheet();
                        entry.run();
                    }}
                >
                    <span>
                        <${Icon} name=${entry.icon} path=${entry.iconPath} size=${18} />
                        ${entry.name}
                    </span>
                    <${State} entry=${entry} />
                </button>`,
            )}
        </div>
        <p class="muted small more-foot">Appearance sets the order and what shows.</p>
    <//>`;
}
