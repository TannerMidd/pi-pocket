// HTML from a reply, run: in the server's sandboxed frame page (`/a/frame`), only once someone taps Run. The frame has
// an opaque origin, as artifacts do: it can run scripts and reach the network, never the app or its cookies.
import { useEffect, useRef, useState } from "preact/hooks";
import { html } from "./ui.js";

/** The sandbox's permissions: those of the artifact viewer's frame (`sheets/viewers.js`), so its popups stay sandboxed. */
const SANDBOX =
    "allow-scripts allow-forms allow-modals allow-popups allow-pointer-lock allow-downloads";
/** How tall a frame may grow to fit its page: past it, the page scrolls inside. */
const MAX_HEIGHT = 900;
const MIN_HEIGHT = 48;

/**
 * The height that fits a page in a frame, from what it says it needs now. A page sized by its frame (`100vh`) asks
 * for a little more each time it gets it: a second step up by the same amount is that, not the page, so it stays.
 */
export function useFitHeight(initial, min, max) {
    const [height, setHeight] = useState(initial);
    const step = useRef(0);

    const fit = (wanted, fills) =>
        setHeight((current) => {
            const next = Math.max(min, Math.min(max, Math.ceil(wanted)));
            const grown = next - current;

            // Only a page as tall as its frame grows with it: one that grows by equal steps otherwise (a list adding
            // rows) is growing for real.
            if (fills && grown > 0 && grown === step.current) {
                return current;
            }

            step.current = Math.max(0, grown);

            return next;
        });

    const reset = () => {
        step.current = 0;
    };

    return [height, fit, reset];
}

/**
 * A frame running `source`. The frame page says when it is ready; then it gets the HTML and reports its height, and the
 * frame fits it. Messages count only from this frame's own window, and a height only when it is a sane number.
 */
export function RunFrame({ source, title = "Preview" }) {
    const ref = useRef(null);
    const [height, fitHeight, resetFit] = useFitHeight(240, MIN_HEIGHT, MAX_HEIGHT);

    useEffect(() => {
        const onMessage = (event) => {
            const frame = ref.current;
            const data = event.data;

            if (!frame || event.source !== frame.contentWindow || typeof data !== "object") {
                return;
            }

            if (data?.type === "pocket-run-ready") {
                resetFit();
                // The frame's origin is opaque, so no address can be named: it is this frame's window either way.
                frame.contentWindow.postMessage({ type: "pocket-run", html: source }, "*");
            } else if (data?.type === "pocket-run-size" && Number.isFinite(data.height)) {
                // The page's height, and the frame's own border around it.
                fitHeight(
                    data.height + (frame.offsetHeight - frame.clientHeight),
                    data.fills === true,
                );
            }
        };

        addEventListener("message", onMessage);

        return () => removeEventListener("message", onMessage);
    }, [source]);

    return html`<iframe
        class="run-frame"
        ref=${ref}
        key=${source}
        src="/a/frame"
        sandbox=${SANDBOX}
        allow="fullscreen; clipboard-write"
        referrerpolicy="no-referrer"
        title=${title}
        style=${`height:${height}px`}
    ></iframe>`;
}
