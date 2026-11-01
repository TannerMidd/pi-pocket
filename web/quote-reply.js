import { useEffect, useState } from "preact/hooks";
import { quoteReply } from "./store.js";
import { html, Icon } from "./ui.js";

const coarse = matchMedia("(pointer: coarse)").matches;
const WIDTH = 92;
const HEIGHT = 36;

function selected() {
    const selection = getSelection();

    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
        return null;
    }

    const range = selection.getRangeAt(0);
    const within = (node) => (node.nodeType === 1 ? node : node.parentElement)?.closest(".reply");
    // A triple-click can end the range at the start of the next block: that end does not count.
    const end =
        range.endOffset === 0 && range.endContainer !== range.startContainer
            ? range.commonAncestorContainer
            : range.endContainer;
    const from = within(range.startContainer);
    const to = within(end) ?? (within(range.commonAncestorContainer) ? from : null);
    const text = selection.toString().trim();

    // Whoever cannot write to Pi has no message box to put the quote in.
    if (
        !from ||
        from !== to ||
        text === "" ||
        !document.querySelector('[data-part="composer"] textarea')
    ) {
        return null;
    }

    const rects = [...range.getClientRects()].filter((rect) => rect.width > 0);

    if (rects.length === 0) {
        return null;
    }

    const first = rects[0];
    const last = rects[rects.length - 1];
    const below = coarse || first.top < HEIGHT + 12;
    const top = below ? last.bottom + 10 : first.top - HEIGHT - 8;
    const anchor = below ? last.right : first.left;
    const left = Math.max(8, Math.min(anchor - (below ? WIDTH : 0), innerWidth - WIDTH - 8));

    if (top < 0 || top > (visualViewport?.height ?? innerHeight) - HEIGHT) {
        return null;
    }

    return { text, top, left };
}

export function QuoteReplyButton() {
    const [at, setAt] = useState(null);

    useEffect(() => {
        let timer = 0;

        const look = () => {
            clearTimeout(timer);
            // Dragging a handle changes the selection all the time: show the button once it holds still.
            timer = setTimeout(() => setAt(selected()), 160);
        };

        document.addEventListener("selectionchange", look);
        addEventListener("scroll", look, true);
        addEventListener("resize", look);

        return () => {
            clearTimeout(timer);
            document.removeEventListener("selectionchange", look);
            removeEventListener("scroll", look, true);
            removeEventListener("resize", look);
        };
    }, []);

    if (!at) {
        return null;
    }

    const reply = () => {
        quoteReply(at.text);
        getSelection()?.removeAllRanges();
        setAt(null);

        if (!coarse) {
            requestAnimationFrame(() =>
                document.querySelector('[data-part="composer"] textarea')?.focus(),
            );
        }
    };

    // Pressing the button must not take the selection away before the click reads it.
    return html`<button
        class="quote-reply-button"
        data-part="quote-reply-button"
        style=${`top:${at.top}px;left:${at.left}px`}
        onPointerDown=${(event) => event.preventDefault()}
        onMouseDown=${(event) => event.preventDefault()}
        onClick=${reply}
    >
        <${Icon} name="reply" size=${14} stroke=${2} />
        <span>Reply</span>
    </button>`;
}
