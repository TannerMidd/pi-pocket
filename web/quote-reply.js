import { useEffect, useState } from "preact/hooks";
import { pipAvailable, quotePip } from "./pip.js";
import { rangeText } from "./quote-text.js";
import { quoteReply, showsPip, store } from "./store.js";
import { prefs } from "./theme.js";
import { html, Icon } from "./ui.js";

/** Which of the pill's buttons show: each has its own switch in Appearance, and PiP's orb needs PiP on. */
const buttons = () => ({
    // Whoever cannot write to Pi has no message box to put the quote in.
    reply:
        prefs().quoteReply !== false &&
        Boolean(document.querySelector('[data-part="composer"] textarea')),
    // Never in PiP's own conversation (as a board, or opened as one): Reply already goes to PiP there.
    pip: prefs().askPipQuote !== false && pipAvailable() && !showsPip(),
});

const coarse = matchMedia("(pointer: coarse)").matches;
const REPLY_WIDTH = 84;
// The orb, and the line between it and Reply.
const PIP_WIDTH = 41;
const HEIGHT = 32;

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

    const shown = buttons();

    if (!from || from !== to || (!shown.reply && !shown.pip)) {
        return null;
    }

    const text = rangeText(range).trim();

    if (text === "") {
        return null;
    }

    const rects = [...range.getClientRects()].filter((rect) => rect.width > 0);

    if (rects.length === 0) {
        return null;
    }

    const first = rects[0];
    const last = rects[rects.length - 1];
    // The button must stay inside the scrolling area, not over the top bar or the message box.
    const view = from.closest(".scroller")?.getBoundingClientRect() ?? {
        top: 0,
        bottom: visualViewport?.height ?? innerHeight,
    };
    const above = first.top - HEIGHT - 8;
    // On a touch screen the system's selection handle hangs under the last line: sit below it.
    const under = last.bottom + (coarse ? 26 : 8);
    let below = coarse || above < view.top;
    let top = below ? under : above;

    if (below && top + HEIGHT > view.bottom) {
        below = false;
        top = above;
    }

    if (top < view.top || top + HEIGHT > view.bottom) {
        return null;
    }

    const anchor = below ? last.right : first.left;
    const width = (shown.reply ? REPLY_WIDTH : 0) + (shown.pip ? PIP_WIDTH : 0);
    const left = Math.max(8, Math.min(anchor - (below ? width : 0), innerWidth - width - 8));

    return { text, top, left, shown };
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

        // Appearance's switches and PiP turned on or off change which buttons show: measured again, at once.
        let was = buttons();
        const unsubscribe = store.subscribe(() => {
            const now = buttons();

            if (now.reply !== was.reply || now.pip !== was.pip) {
                was = now;
                setAt(selected());
            }
        });

        document.addEventListener("selectionchange", look);
        addEventListener("scroll", look, true);
        addEventListener("resize", look);

        return () => {
            clearTimeout(timer);
            unsubscribe();
            document.removeEventListener("selectionchange", look);
            removeEventListener("scroll", look, true);
            removeEventListener("resize", look);
        };
    }, []);

    if (!at) {
        return null;
    }

    const done = () => {
        getSelection()?.removeAllRanges();
        setAt(null);
    };

    const reply = () => {
        if (!buttons().reply) {
            return done();
        }

        quoteReply(at.text);
        done();

        if (!coarse) {
            requestAnimationFrame(() =>
                document.querySelector('[data-part="composer"] textarea')?.focus(),
            );
        }
    };

    // The passage goes over PiP's box as a quote instead, with the session it came from (unless that is PiP's own).
    const askPip = () => {
        if (!buttons().pip) {
            return done();
        }

        const text = at.text;
        const { conversationId, sessions } = store.state;
        // Only a session of the list (never a subagent's conversation, nor PiP's own) is named: PiP can read it.
        const session = sessions.some((each) => each.id === conversationId)
            ? conversationId
            : undefined;

        done();
        quotePip(text, session);
    };

    // Pressing a button must not take the selection away before the click reads it.
    const keep = (event) => event.preventDefault();

    return html`<div
        class="quote-reply-button"
        data-part="quote-reply-button"
        style=${`top:${at.top}px;left:${at.left}px`}
        onPointerDown=${keep}
        onMouseDown=${keep}
    >
        ${
            at.shown.reply &&
            html`<button type="button" class="quote-reply-action" onClick=${reply}>
                <${Icon} name="reply" size=${14} stroke=${2} />
                <span>Reply</span>
            </button>`
        }
        ${
            at.shown.pip &&
            html`<button
                type="button"
                class="quote-reply-action quote-reply-pip"
                aria-label="Ask PiP"
                title="Ask PiP"
                onClick=${askPip}
            >
                <${Icon} name="pip" size=${16} />
            </button>`
        }
    </div>`;
}
