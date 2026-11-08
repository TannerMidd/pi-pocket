// The quotes in the session's message box (Reply): each one drawn as a piece under the box's own text, which goes
// clear while there is one, with a × over its first line. The box stays a plain textarea, so typing, dictation, a
// keyboard's suggestions, and undo work as before; what goes to Pi is the text as written, quotes as Markdown.
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { quoteBlocks } from "./quote-text.js";
import { html, Icon } from "./ui.js";

/** How quotes look in the box (Appearance → Quotes in the message box). */
export const QUOTE_STYLES = [
    ["fade", "Fade"],
    ["tint", "Tint"],
    ["ghost", "Ghost"],
];

/**
 * What the drawing copies from the box, so that each word lands under its own place: anything that changes how wide
 * a letter is or where a line wraps. A theme may set any of them on the box.
 */
const COPIED = [
    "fontFamily",
    "fontSize",
    "fontWeight",
    "fontStyle",
    "fontStretch",
    "fontVariant",
    "fontFeatureSettings",
    "fontVariationSettings",
    "fontKerning",
    "fontOpticalSizing",
    "lineHeight",
    "letterSpacing",
    "wordSpacing",
    "textTransform",
    "textIndent",
    "tabSize",
    "textRendering",
    "paddingTop",
    "paddingRight",
    "paddingBottom",
    "paddingLeft",
    "direction",
];

/** The quotes of `text` that are pieces (Reply put them there), as `quoteBlocks` gives them. */
export function piecesIn(text, pieces) {
    return pieces.length === 0
        ? []
        : quoteBlocks(text).filter((block) => pieces.includes(block.text));
}

/** `pieces` without those `text` no longer has, each once. */
export function prunePieces(text, pieces) {
    const there = new Set(piecesIn(text, pieces).map((block) => block.text));

    return [...new Set(pieces)].filter((piece) => there.has(piece));
}

/** `text`'s lines as the drawing shows them: a quote's lines with its marks, the rest as they are. */
function Lines({ text, blocks, marked }) {
    let at = 0;

    return text.split("\n").map((line) => {
        const start = at;
        const block = blocks.find((each) => start >= each.start && start <= each.end);

        at += line.length + 1;

        if (!block) {
            // An empty line still takes a line's height, as in the box.
            return html`<span class="quote-box-line">${line || "\u200b"}</span>`;
        }

        const first = start === block.start;
        const last = start + line.length === block.end;
        const space = line.startsWith("> ") ? " " : "";

        return html`<span
            class=${`quote-box-line quote-line ${first ? "first" : ""} ${last ? "last" : ""} ${block.start === marked ? "marked" : ""}`}
            ><span class="quote-line-mark">></span>${space}<span class="quote-line-text"
                >${line.slice(1 + space.length)}</span
            ></span
        >`;
    });
}

/**
 * The drawing under the box (`box`, its textarea) and the ×s over it, for the quotes `blocks` of `text`: `marked`, the
 * start of the quote a first Backspace marked. `locked` while the message is on its way.
 */
export function QuoteLayer({ box, text, blocks, marked, locked, onRemove }) {
    const under = useRef(null);
    const over = useRef(null);
    const [tops, setTops] = useState([]);

    useLayoutEffect(() => {
        const measure = () => {
            const element = box.current;
            const drawing = under.current;

            if (!element || !drawing || !over.current) {
                return;
            }

            const style = getComputedStyle(element);

            for (const name of COPIED) {
                drawing.style[name] = style[name];
            }

            // Inside the box's border, and without its scrollbar: the text's own room.
            const place = `top:${element.offsetTop + element.clientTop}px;left:${element.offsetLeft + element.clientLeft}px;width:${element.clientWidth}px;height:${element.clientHeight}px`;

            drawing.style.cssText += `;${place}`;
            over.current.style.cssText = place;
            scrolled();
            // A line's place is within the text, which starts under the box's top padding.
            const pad = parseFloat(style.paddingTop) || 0;
            const next = [...drawing.querySelectorAll(".quote-line.first")].map(
                (line) => line.offsetTop + pad,
            );

            setTops((now) => (now.join() === next.join() ? now : next));
        };

        // Both layers move with the box's text as it scrolls.
        const scrolled = () =>
            box.current?.parentElement?.style.setProperty(
                "--quote-scroll",
                `${-(box.current?.scrollTop ?? 0)}px`,
            );
        const element = box.current;
        const sized = new ResizeObserver(measure);

        measure();
        sized.observe(element);
        element.addEventListener("scroll", scrolled);
        document.addEventListener("pocket:theme", measure);
        document.fonts?.addEventListener("loadingdone", measure);

        return () => {
            sized.disconnect();
            element.removeEventListener("scroll", scrolled);
            document.removeEventListener("pocket:theme", measure);
            document.fonts?.removeEventListener("loadingdone", measure);
        };
    }, [text, marked]);

    return html`<div class="quote-box-drawing" ref=${under} aria-hidden="true">
            <div class="quote-box-scroll">
                <${Lines} text=${text} blocks=${blocks} marked=${marked} />
            </div>
        </div>
        <div class="quote-box-over" ref=${over}>
            <div class="quote-box-scroll">
                ${blocks.map(
                    (block, index) =>
                        tops[index] !== undefined &&
                        html`<button
                            type="button"
                            class="quote-remove"
                            style=${`top:${tops[index]}px`}
                            aria-label="Remove the quote"
                            title="Remove the quote"
                            disabled=${locked}
                            onPointerDown=${(event) => event.preventDefault()}
                            onClick=${() => onRemove(block)}
                        >
                            <${Icon} name="close" size=${12} />
                        </button>`,
                )}
            </div>
        </div>`;
}
