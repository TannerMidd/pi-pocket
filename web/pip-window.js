// PiP's remembered floating size. CSS alone clamps it when the viewport shrinks, without losing the preference.
import { useEffect } from "preact/hooks";

export function usePipResize(ref, account) {
    useEffect(() => {
        const panel = ref.current;

        if (!panel || !account) {
            return;
        }

        const key = `pocket.pip.size.${account}`;

        panel.style.removeProperty("--pip-width");
        panel.style.removeProperty("--pip-height");

        // Each dimension apart: a drag on the left edge chose a width only, and the height stays the default, which
        // follows the window's height.
        const size = ({ width, height }) => {
            if (Number.isFinite(width)) {
                panel.style.setProperty("--pip-width", `${Math.max(420, Math.min(800, width))}px`);
            }

            if (Number.isFinite(height)) {
                panel.style.setProperty("--pip-height", `${Math.max(360, height)}px`);
            }
        };

        const saved = () => {
            try {
                return JSON.parse(localStorage.getItem(key)) ?? {};
            } catch {
                // A missing or invalid preference uses the normal CSS size.
                return {};
            }
        };

        size(saved());

        let drag = null;

        const stop = () => {
            if (drag) {
                const { id, selection } = drag;

                drag = null;
                document.documentElement.style.userSelect = selection;

                if (panel.hasPointerCapture(id)) {
                    panel.releasePointerCapture(id);
                }
            }
        };

        const down = (event) => {
            const edge = event.target.closest("[data-pip-resize]")?.dataset.pipResize;

            if (!edge || event.button !== 0 || innerWidth < 768 || drag) {
                return;
            }

            event.preventDefault();
            const rect = panel.getBoundingClientRect();
            const style = getComputedStyle(panel);

            drag = {
                id: event.pointerId,
                x: event.clientX,
                y: event.clientY,
                width: rect.width,
                height: rect.height,
                maxWidth: parseFloat(style.maxWidth),
                maxHeight: parseFloat(style.maxHeight),
                edge,
                selection: document.documentElement.style.userSelect,
            };
            document.documentElement.style.userSelect = "none";
            panel.setPointerCapture(event.pointerId);
        };

        const move = (event) => {
            if (!drag || event.pointerId !== drag.id) {
                return;
            }

            drag.moved = true;

            size({
                ...(drag.edge === "top"
                    ? {}
                    : { width: Math.min(drag.maxWidth, drag.width + drag.x - event.clientX) }),
                ...(drag.edge === "left"
                    ? {}
                    : { height: Math.min(drag.maxHeight, drag.height + drag.y - event.clientY) }),
            });
        };

        const up = (event) => {
            if (!drag || event.pointerId !== drag.id) {
                return;
            }

            // Only a size someone chose: a tap on an edge keeps the default, which follows the window's height.
            if (drag.moved) {
                const rect = panel.getBoundingClientRect();

                try {
                    localStorage.setItem(
                        key,
                        JSON.stringify({
                            ...saved(),
                            ...(drag.edge === "top" ? {} : { width: rect.width }),
                            ...(drag.edge === "left" ? {} : { height: rect.height }),
                        }),
                    );
                } catch {
                    // Resizing still works when browser storage is unavailable.
                }
            }

            stop();
        };

        addEventListener("resize", stop);
        panel.addEventListener("pointerdown", down);
        panel.addEventListener("pointermove", move);
        panel.addEventListener("pointerup", up);
        panel.addEventListener("lostpointercapture", stop);
        panel.addEventListener("pointercancel", stop);

        return () => {
            stop();
            removeEventListener("resize", stop);
            panel.removeEventListener("pointerdown", down);
            panel.removeEventListener("pointermove", move);
            panel.removeEventListener("pointerup", up);
            panel.removeEventListener("lostpointercapture", stop);
            panel.removeEventListener("pointercancel", stop);
        };
    }, [account]);
}
