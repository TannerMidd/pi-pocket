// Small pieces the workspace is made of: icons, a pop-up card, a segmented choice, a measure of an element's size.

import { DESIGN_PATH } from "./paths.js";

/** Icons of our own (24 × 24, stroked), for what the app's set lacks. */
export const PATHS = {
    design: DESIGN_PATH,
    comment: "M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z",
    text: "M4 20h4L19 9l-4-4L4 16v4z M13.5 6.5l4 4",
    sliders: "M4 6h9 M17 6h3 M4 12h3 M11 12h9 M4 18h11 M19 18h1 M13 4v4 M7 10v4 M15 16v4",
    compare: "M3 5h8v14H3z M13 5h8v14h-8z",
    play: "M7 4l13 8-13 8z",
    download: "M12 4v11 M7 11l5 5 5-5 M5 20h14",
    share: "M12 15V3 M7 8l5-5 5 5 M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6",
    swap: "M7 4L3 8l4 4 M3 8h14 M17 20l4-4-4-4 M21 16H7",
    left: "M15 6l-6 6 6 6",
    right: "M9 6l6 6-6 6",
    sun: "M12 8a4 4 0 100 8 4 4 0 000-8z M12 2v2 M12 20v2 M4.9 4.9l1.4 1.4 M17.7 17.7l1.4 1.4 M2 12h2 M20 12h2 M4.9 19.1l1.4-1.4 M17.7 6.3l1.4-1.4",
    moon: "M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z",
    contrast: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M12 3v18 M12 8h4 M12 12h4 M12 16h4",
    minus: "M5 12h14",
    trash: "M4 7h16 M10 11v6 M14 11v6 M6 7l1 13h10l1-13 M9 7V4h6v3",
    target: "M12 3v4 M12 17v4 M3 12h4 M17 12h4 M12 9a3 3 0 100 6 3 3 0 000-6z",
    history: "M3 12a9 9 0 1 0 3-6.7L3 8 M3 3v5h5 M12 7v5l3 2",
    layers: "M12 3l9 5-9 5-9-5 9-5z M3 13l9 5 9-5 M3 17l9 5 9-5",
    expand: "M4 9V4h5 M20 9V4h-5 M4 15v5h5 M20 15v5h-5",
    redo: "M15 14l5-5-5-5 M20 9H9a5 5 0 0 0 0 10h4",
    focus: "M4 4h16v16H4z M9 4v16 M16 9l-3 3 3 3",
    unfocus: "M4 4h16v16H4z M9 4v16 M13 9l3 3-3 3",
    alert: "M12 4l9 16H3z M12 10v4 M12 17.5h.01",
    box: "M3 7l9-4 9 4-9 4-9-4z M3 7v10l9 4 9-4V7 M12 11v10",
    book: "M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3V4z M5 17a3 3 0 0 1 3-3h11",
    link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1 M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
    flag: "M5 21V4 M5 4h12l-2 4 2 4H5",
    pen: "M4 20h4L19 9l-4-4L4 16v4z M13.5 6.5l4 4",
    stepper: "M6 12h12",
};

/** How long ago, short: "now", "5m", "3h", "2d", then the date. */
export function ago(at, now = Date.now()) {
    const seconds = Math.max(0, Math.round((now - at) / 1000));

    if (seconds < 45) {
        return "now";
    }

    const minutes = Math.round(seconds / 60);

    if (minutes < 60) {
        return `${minutes}m ago`;
    }

    const hours = Math.round(minutes / 60);

    if (hours < 24) {
        return `${hours}h ago`;
    }

    const days = Math.round(hours / 24);

    return days < 30 ? `${days}d ago` : new Date(at).toLocaleDateString();
}

export function createParts(pocket) {
    const { html, Icon, useEffect, useLayoutEffect, useRef, useState } = pocket;

    /** One of the app's icons, or one of ours. */
    function Ico({ name, size = 16, class: className }) {
        return PATHS[name]
            ? html`<${Icon} path=${PATHS[name]} size=${size} class=${className} />`
            : html`<${Icon} name=${name} size=${size} class=${className} />`;
    }

    /** The size of an element, kept up to date as it changes. */
    function useSize(ref) {
        const [size, setSize] = useState({ w: 0, h: 0 });

        useLayoutEffect(() => {
            const element = ref.current;

            if (!element) {
                return undefined;
            }

            // The layout size, not the drawn one: a panel that is still growing in (a transform) is as big as it will be.
            const measure = () => {
                const w = element.clientWidth;
                const h = element.clientHeight;

                setSize((old) => (old.w === w && old.h === h ? old : { w, h }));
            };

            measure();

            const watch = new ResizeObserver(measure);

            watch.observe(element);

            return () => watch.disconnect();
        }, [ref]);

        return size;
    }

    /**
     * A card over the workspace, with a scrim behind it that closes it. Esc closes it too. `sheet` makes it a bottom
     * sheet (narrow screens); otherwise it hangs from the top, at the left (`align="start"`) or the right.
     */
    function Popover({ label, onClose, children, align = "start", wide = false, sheet = false }) {
        const card = useRef(null);

        useEffect(() => {
            const onKey = (event) => {
                if (event.key === "Escape" && !event.isComposing) {
                    event.stopPropagation();
                    onClose();
                }
            };

            // Focus goes in, and comes back to what opened it.
            const opener = document.activeElement;

            document.addEventListener("keydown", onKey, true);
            card.current?.focus({ preventScroll: true });

            return () => {
                document.removeEventListener("keydown", onKey, true);

                if (opener instanceof HTMLElement && opener.isConnected) {
                    opener.focus({ preventScroll: true });
                }
            };
        }, []);

        return html`<div class="dsn-pop-layer" data-sheet=${sheet}>
            <div class="dsn-scrim" onClick=${onClose}></div>
            <div
                class=${`dsn-pop ${wide ? "wide" : ""}`}
                data-align=${align}
                data-sheet=${sheet}
                role="dialog"
                aria-label=${label}
                tabindex="-1"
                ref=${card}
            >
                ${children}
            </div>
        </div>`;
    }

    /** A row of choices, one on. `options`: `[{ value, label, icon, title, disabled }]`. */
    function Segmented({ value, options, onChange, label, iconOnly = false }) {
        return html`<div class="dsn-seg" role="group" aria-label=${label}>
            ${options.map(
                (option) =>
                    html`<button
                        type="button"
                        class=${value === option.value ? "on" : ""}
                        aria-pressed=${value === option.value}
                        title=${option.title ?? option.label}
                        aria-label=${option.title ?? option.label}
                        disabled=${option.disabled === true}
                        onClick=${() => onChange(option.value)}
                    >
                        ${option.icon && html`<${Ico} name=${option.icon} size=${15} />`}
                        ${!iconOnly && option.label && html`<span>${option.label}</span>`}
                    </button>`,
            )}
        </div>`;
    }

    return { Ico, useSize, Popover, Segmented, ago };
}
