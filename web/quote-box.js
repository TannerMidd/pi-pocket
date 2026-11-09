// The quotes in the session's message box (Reply): each one drawn as a piece under the box's own text, which goes
// clear while there is one, with a × over its first line. The box stays a plain textarea, so typing, dictation, a
// keyboard's suggestions, and undo work as before; what goes to Pi is the text as written, quotes as Markdown.
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { html, Icon } from "./ui.js";

/**
 * How Reply's quotes show (Appearance → Quotes in the message box): in the box's text, drawn as Fade, Tint, or Ghost;
 * or Separate, each in a strip over the box, apart from its words (composer.js).
 */
export const QUOTE_STYLES = [
    ["fade", "Fade"],
    ["tint", "Tint"],
    ["ghost", "Ghost"],
    ["separate", "Separate"],
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

/** One line of the box as the drawing shows it; an empty one still takes a line's height, as in the box. */
const Line = ({ line }) => html`<span class="quote-box-line">${line || "\u200b"}</span>`;

/**
 * `text` as the drawing shows it: the words as they are, and each quote of `blocks` as one block (its lines, empty
 * ones too, inside it), its marks drawn.
 */
function Lines({ text, blocks, marked }) {
    const parts = [];
    let at = 0;

    for (const block of blocks) {
        for (const line of text.slice(at, block.start).replace(/\n$/, "").split("\n")) {
            if (block.start > at) {
                parts.push(html`<${Line} line=${line} />`);
            }
        }

        parts.push(html`<span class=${`quote-block ${block.start === marked ? "marked" : ""}`}
            >${block.text.split("\n").map((line) => {
                const space = line.startsWith("> ") ? " " : "";

                return html`<span class="quote-box-line quote-line"
                    ><span class="quote-line-mark">></span>${space}<span class="quote-line-text"
                        >${line.slice(1 + space.length)}</span
                    ></span
                >`;
            })}</span
        >`);
        at = block.end + 1;
    }

    if (at <= text.length) {
        for (const line of text.slice(at).split("\n")) {
            parts.push(html`<${Line} line=${line} />`);
        }
    }

    return parts;
}

/**
 * The drawing under the box (`box`, its textarea) and the ×s over it, for the quotes `blocks` of `text`: `marked`, the
 * start of the quote a first Backspace marked. `locked` while the message is on its way.
 */
export function QuoteLayer({ box, text, blocks, marked, locked, onRemove }) {
    const under = useRef(null);
    const over = useRef(null);
    const [tops, setTops] = useState([]);
    const measured = useRef(() => {});

    // Measured again after each render too: a file row or a line over the box moves it without resizing it.
    useLayoutEffect(() => measured.current());
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
            const next = [...drawing.querySelectorAll(".quote-block")].map(
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

        measured.current = measure;
        measure();
        sized.observe(element);
        // The message box around it, which grows when something comes in over the text.
        sized.observe(element.closest(".composer") ?? element);
        element.addEventListener("scroll", scrolled);
        document.addEventListener("pocket:theme", measure);
        document.fonts?.addEventListener("loadingdone", measure);

        return () => {
            measured.current = () => {};

            sized.disconnect();
            element.removeEventListener("scroll", scrolled);
            document.removeEventListener("pocket:theme", measure);
            document.fonts?.removeEventListener("loadingdone", measure);
        };
    }, []);

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
