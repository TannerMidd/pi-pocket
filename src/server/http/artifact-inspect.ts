/**
 * The page side of Design mode (`docs/design/design-mode.md`, stream B): inspect, text edit, tweaks, pins, and decks.
 * `ARTIFACT_INSPECT` is a function expression, as a string, that `ARTIFACT_BRIDGE` (`artifacts.ts`) calls as it starts,
 * with the line to the app. It changes nothing in the page until the app turns a mode on (inspect, text edit, pins), and
 * undoes all of it when the app turns it off. Two things work from the page's own markup, with no mode: it reads the
 * tweaks manifest (`<script type="application/json" id="pocket-tweaks">`) and tells the app, and it shows a deck
 * (`<meta name="pocket-kind" content="deck">`, slides as `<section class="slide">`) one slide at a time.
 *
 * Nothing here is reachable from the page: the code runs in a closure, and the only line to the app is the one the
 * bridge made. What it sends is data about the page's own elements, which the app checks (`web/artifact-bridge.js`).
 * Styles go in by CSSOM and constructable sheets, and nodes by DOM calls, never by markup or `innerHTML`, so a page
 * that sets a strict CSP or Trusted Types still works. The code has no backtick, and no dollar-brace but the one that
 * sets the slide size, as it sits in a script tag inside a template string.
 */

/** Deck slides are laid out at this size (16:9) and scaled to fit; `<meta name="pocket-slide-size" content="1280x720">` changes it. */
export const DECK_SLIDE_SIZE = { width: 1920, height: 1080 };

export const ARTIFACT_INSPECT = String.raw`(send, standalone) => {
    "use strict";

    const doc = document;
    const win = window;
    const raf = (callback) => win.requestAnimationFrame(callback);
    const later = (callback, ms) => win.setTimeout(callback, ms);
    const unlater = (id) => win.clearTimeout(id);
    const fire = (event) => win.dispatchEvent(event);
    const CustomEvt = (name, detail) => new win.CustomEvent(name, { detail });
    const now = performance.now.bind(performance);
    // The page's own scripts have not run yet: keep the native listener functions, so a page that replaces
    // addEventListener cannot get hold of the handlers and call them with events it made up.
    const real = typeof EventTarget === "function" && win instanceof EventTarget;
    const addListener = real ? EventTarget.prototype.addEventListener.bind(win) : (...args) => win.addEventListener(...args);
    const removeListener = real ? EventTarget.prototype.removeEventListener.bind(win) : (...args) => win.removeEventListener(...args);
    const ACCENT = "#7aa2f7";
    const SLIDE_W = ${DECK_SLIDE_SIZE.width};
    const SLIDE_H = ${DECK_SLIDE_SIZE.height};
    const STYLE_PROPS = ["color", "background-color", "font-family", "font-size", "font-weight", "line-height", "padding", "margin", "border-radius", "gap"];
    const INLINE = new Set(["a", "abbr", "b", "bdi", "bdo", "br", "cite", "code", "del", "dfn", "em", "i", "ins", "kbd", "label", "mark", "q", "s", "samp", "small", "span", "strong", "sub", "sup", "time", "u", "var", "wbr"]);
    const NOT_TEXT = new Set(["script", "style", "noscript", "textarea", "select", "option", "svg", "canvas", "video", "audio", "iframe", "object", "embed", "input", "template", "head", "meta", "link", "title", "pocket-overlay"]);
    const KNOB_TYPES = ["range", "color", "select", "toggle", "text"];
    const squash = (text) => String(text).replace(/\s+/g, " ").trim();
    const clip = (text, max) => String(text).slice(0, max);
    const isEl = (node) => node instanceof Element;
    const css = (el, props) => {
        for (const name in props) {
            el.style.setProperty(name, props[name]);
        }

        return el;
    };

    /** Window listeners that one part sets and clears together. */
    const group = () => {
        const held = [];

        return {
            add(type, handler, options) {
                addListener(type, handler, options);
                held.push([type, handler, options]);
            },
            clear() {
                for (const [type, handler, options] of held.splice(0)) {
                    removeListener(type, handler, options);
                }
            },
        };
    };

    // ---------------------------------------------------------------------------------------------------------------
    // What an element is, as data: a short unique selector, its look, and where it sits.

    const unique = (selector) => {
        try {
            return doc.querySelectorAll(selector).length === 1;
        } catch {
            return false;
        }
    };

    const idSelector = (el) => (el.id ? "#" + CSS.escape(el.id) : "");
    const pidSelector = (value) => "[data-pid=" + JSON.stringify(value) + "]";

    /** One step of a selector: the tag, up to two plain classes, and a place among its siblings when those do not tell it apart. */
    const step = (el) => {
        const classes = [...el.classList].filter((name) => name.length <= 30 && !/\d{3,}/.test(name)).slice(0, 2);
        let selector = el.localName + classes.map((name) => "." + CSS.escape(name)).join("");
        const parent = el.parentElement;

        if (parent) {
            const same = [...parent.children].filter((child) => child.matches(selector));

            if (same.length > 1) {
                const ofType = [...parent.children].filter((child) => child.localName === el.localName);

                selector += ":nth-of-type(" + (ofType.indexOf(el) + 1) + ")";
            }
        }

        return selector;
    };

    const selectorOf = (el) => {
        if (el === doc.documentElement) {
            return "html";
        }

        if (el === doc.body) {
            return "body";
        }

        if (el.id && unique(idSelector(el))) {
            return idSelector(el);
        }

        const pid = el.getAttribute("data-pid");

        if (pid && unique(pidSelector(pid))) {
            return pidSelector(pid);
        }

        const parts = [];

        for (let node = el; isEl(node) && node !== doc.documentElement; node = node.parentElement) {
            if (node !== el && node.id && unique(idSelector(node))) {
                parts.unshift(idSelector(node));
                break;
            }

            parts.unshift(step(node));

            if (unique(parts.join(" > "))) {
                break;
            }
        }

        while (parts.join(" > ").length > 500 && parts.length > 1) {
            parts.shift();
        }

        return parts.join(" > ");
    };

    const records = new Map();

    const targetOf = (el) => {
        const rect = el.getBoundingClientRect();
        const computed = win.getComputedStyle(el);
        const styles = {};
        const near = el.closest("[data-pid]");
        const round = (value) => Math.round(value * 10) / 10;
        const copy = el.cloneNode(true);
        const was = records.get(el);

        for (const name of STYLE_PROPS) {
            styles[name] = clip(computed.getPropertyValue(name), 200);
        }

        // The page as it was written: not the attributes that text edit mode put on.
        if (was && isEl(copy)) {
            if (was.ce === null) {
                copy.removeAttribute("contenteditable");
            } else {
                copy.setAttribute("contenteditable", was.ce);
            }

            if (was.sc === null) {
                copy.removeAttribute("spellcheck");
            } else {
                copy.setAttribute("spellcheck", was.sc);
            }
        }

        const target = {
            selector: selectorOf(el),
            tag: el.localName,
            text: clip(squash(el.textContent), 200),
            html: clip(copy.outerHTML ?? "", 1000),
            rect: {
                x: round(rect.x + win.scrollX),
                y: round(rect.y + win.scrollY),
                width: round(rect.width),
                height: round(rect.height),
            },
            styles,
        };

        if (near) {
            target.pid = clip(near.getAttribute("data-pid"), 200);
        }

        return target;
    };

    // ---------------------------------------------------------------------------------------------------------------
    // The overlay: outlines and pins, in a closed shadow root on a fixed layer that takes no pointer. It is in the page
    // only while it shows something.

    let overlay = null;
    let hoverEl = null;
    let pickedEl = null;
    let pins = [];
    let looping = false;

    const makeBox = (parent, dashed) => {
        const box = css(doc.createElement("div"), {
            position: "absolute",
            display: "none",
            "box-sizing": "border-box",
            border: "2px " + (dashed ? "dashed" : "solid") + " " + ACCENT,
            background: dashed ? "rgba(122,162,247,.08)" : "rgba(122,162,247,.16)",
            "border-radius": "2px",
        });
        const label = css(doc.createElement("div"), {
            position: "absolute",
            left: "-2px",
            bottom: "100%",
            "white-space": "nowrap",
            font: "11px/1.4 ui-monospace, monospace",
            color: "#1a1b26",
            background: ACCENT,
            padding: "0 5px",
            "border-radius": "3px 3px 0 0",
        });

        box.append(label);
        parent.append(box);

        return { box, label };
    };

    const ensureOverlay = () => {
        if (overlay && overlay.host.isConnected) {
            return overlay;
        }

        const host = css(doc.createElement("pocket-overlay"), {
            all: "initial",
            position: "fixed",
            inset: "0",
            "pointer-events": "none",
            "z-index": "2147483647",
            display: "block",
        });
        const root = host.attachShadow({ mode: "closed" });
        const hover = makeBox(root, true);
        const picked = makeBox(root, false);
        const layer = doc.createElement("div");

        root.append(layer);
        doc.documentElement.append(host);
        overlay = { host, hover, picked, layer };

        return overlay;
    };

    const labelOf = (el) => {
        const rect = el.getBoundingClientRect();

        return (
            el.localName +
            (el.id ? "#" + el.id : "") +
            ([...el.classList][0] ? "." + [...el.classList][0] : "") +
            "  " +
            Math.round(rect.width) +
            "\u00d7" +
            Math.round(rect.height)
        );
    };

    const place = (shape, el, keepLabel) => {
        if (!el || !el.isConnected) {
            shape.box.style.setProperty("display", "none");

            return;
        }

        const rect = el.getBoundingClientRect();

        css(shape.box, {
            display: rect.width === 0 && rect.height === 0 ? "none" : "block",
            left: rect.left + "px",
            top: rect.top + "px",
            width: rect.width + "px",
            height: rect.height + "px",
        });
        shape.label.style.setProperty("top", rect.top < 20 ? "100%" : "auto");
        shape.label.style.setProperty("bottom", rect.top < 20 ? "auto" : "100%");

        if (keepLabel) {
            shape.label.textContent = labelOf(el);
        }
    };

    const findPinTarget = (target) => {
        try {
            const found = target.selector ? doc.querySelector(target.selector) : null;

            if (found) {
                return found;
            }

            return target.pid ? doc.querySelector(pidSelector(target.pid)) : null;
        } catch {
            return null;
        }
    };

    // A pin's badge goes where no text or picture of the page lies under it.
    const REPLACED = /^(IMG|SVG|VIDEO|CANVAS|INPUT|SELECT|TEXTAREA|BUTTON|IFRAME|PICTURE)$/i;

    const covered = (x, y, w, h) => {
        const points = [[x + 2, y + 2], [x + w - 2, y + 2], [x + 2, y + h - 2], [x + w - 2, y + h - 2], [x + w / 2, y + h / 2]];

        for (const [px, py] of points) {
            if (px < 0 || py < 0 || px >= win.innerWidth || py >= win.innerHeight) {
                continue;
            }

            for (const el of doc.elementsFromPoint(px, py)) {
                if (el === doc.documentElement || (overlay && el === overlay.host)) {
                    continue;
                }

                if (REPLACED.test(el.tagName)) {
                    return true;
                }

                for (const node of el.childNodes) {
                    if (node.nodeType === 3 && node.textContent.trim() !== "") {
                        const range = doc.createRange();

                        range.selectNodeContents(node);

                        for (const box of range.getClientRects()) {
                            if (box.right > x && box.left < x + w && box.bottom > y && box.top < y + h) {
                                return true;
                            }
                        }
                    }
                }
            }
        }

        return false;
    };

    const BADGE_H = 22;

    const placesOf = (rect, w) => [
        [rect.left, rect.top - BADGE_H - 3],
        [rect.left - w - 3, rect.top],
        [rect.right + 3, rect.top],
        [rect.right - w, rect.top - BADGE_H - 3],
        [rect.left, rect.bottom + 3],
        [rect.right - w - 2, rect.top + 2],
    ];

    const onScreen = ([x, y], w) => x >= 0 && y >= 0 && x + w <= win.innerWidth && y + BADGE_H <= win.innerHeight;

    // Each place costs a hit test: work it out when a pin first shows or its layout changes, not every frame.
    const findPlace = (rect, w) => {
        const places = placesOf(rect, w);
        let first = -1;

        for (let at = 0; at < places.length; at += 1) {
            if (onScreen(places[at], w)) {
                first = first === -1 ? at : first;

                if (!covered(places[at][0], places[at][1], w, BADGE_H)) {
                    return at;
                }
            }
        }

        return first === -1 ? 0 : first;
    };

    // A throttled stamp of what may have changed the layout; a pin compares it with its own.
    let layoutStamp = 0;
    let layoutDirty = false;
    let stampedAt = 0;
    let layoutWatch = null;
    // How long one frame may spend finding places: the rest wait for the next frame (a pin is hidden until it has one).
    const PLACE_BUDGET = 3;

    const watchLayout = () => {
        if (layoutWatch !== null || typeof win.ResizeObserver !== "function") {
            return;
        }

        const dirty = () => {
            layoutDirty = true;
        };

        layoutWatch = [new win.ResizeObserver(() => {
            layoutStamp += 1;
        }), typeof win.MutationObserver === "function" ? new win.MutationObserver(dirty) : null];
        layoutWatch[0].observe(doc.documentElement);
        layoutWatch[1]?.observe(doc.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
    };

    const unwatchLayout = () => {
        if (layoutWatch !== null) {
            layoutWatch[0].disconnect();
            layoutWatch[1]?.disconnect();
            layoutWatch = null;
        }
    };

    // All the reads first, then all the writes, so the layout is worked out once, not once for each pin.
    const updatePins = () => {
        const started = now();
        const sx = win.scrollX;
        const sy = win.scrollY;
        const vw = win.innerWidth;
        const vh = win.innerHeight;

        // After a mutation of the page, re-place at most once a second.
        if (layoutDirty && started - stampedAt > 1000) {
            layoutDirty = false;
            stampedAt = started;
            layoutStamp += 1;
        }

        const drawn = [];

        for (const pin of pins) {
            if (!pin.el || !pin.el.isConnected) {
                pin.el = findPinTarget(pin.target);
                pin.stamp = -1;
            }

            const rect = pin.el ? pin.el.getBoundingClientRect() : null;
            const real = rect !== null && (rect.width > 0 || rect.height > 0);
            const near = real && rect.bottom > -40 && rect.top < vh + 40 && rect.right > -40 && rect.left < vw + 40;
            let at = null;

            if (near) {
                const key = rect.left + sx + "," + (rect.top + sy) + "," + rect.width + "," + rect.height;
                const known =
                    pin.place !== undefined &&
                    pin.key === key &&
                    pin.stamp === layoutStamp &&
                    (pin.fallback === true || onScreen(placesOf(rect, pin.w)[pin.place], pin.w));

                // A pin with a place moves at once; one without waits when the frame's time is spent.
                if (!known && (pin.place !== undefined || now() - started < PLACE_BUDGET)) {
                    pin.place = findPlace(rect, pin.w);
                    pin.key = key;
                    pin.stamp = layoutStamp;
                    pin.fallback = !onScreen(placesOf(rect, pin.w)[pin.place], pin.w);
                }

                if (pin.place !== undefined) {
                    at = placesOf(rect, pin.w)[pin.place];
                }
            }

            drawn.push([pin, near ? rect : null, at]);
        }

        for (const [pin, rect, at] of drawn) {
            const mine = pin.drawn;
            const shown = rect !== null && at !== null;
            const move = shown
                ? "translate(" + Math.round(Math.min(Math.max(at[0], 2), vw - pin.w - 2)) + "px," + Math.round(Math.min(Math.max(at[1], 2), vh - BADGE_H - 2)) + "px)"
                : "";
            const box = shown
                ? "translate(" + Math.round(rect.left) + "px," + Math.round(rect.top) + "px)"
                : "";
            const size = shown ? Math.round(rect.width) + "x" + Math.round(rect.height) : "";

            if (mine.node !== move) {
                css(pin.node, shown ? { display: "flex", transform: move } : { display: "none" });
                mine.node = move;
            }

            if (pin.outline && (mine.box !== box || mine.size !== size)) {
                css(
                    pin.outline,
                    shown
                        ? { display: "block", transform: box, width: Math.round(rect.width) + "px", height: Math.round(rect.height) + "px" }
                        : { display: "none" },
                );
                mine.box = box;
                mine.size = size;
            }
        }
    };

    const update = () => {
        if (!hoverEl && !pickedEl && pins.length === 0) {
            if (overlay) {
                overlay.host.remove();
                overlay = null;
            }

            unwatchLayout();

            return false;
        }

        const shown = ensureOverlay();

        place(shown.hover, hoverEl && hoverEl !== pickedEl ? hoverEl : null, true);
        place(shown.picked, pickedEl, true);

        updatePins();

        return true;
    };

    const loop = () => {
        looping = false;

        if (update()) {
            looping = true;
            raf(loop);
        }
    };

    const paint = () => {
        if (update() && !looping) {
            looping = true;
            raf(loop);
        }
    };

    const setHover = (el) => {
        const next = isEl(el) && el.localName !== "pocket-overlay" ? el : null;

        if (next !== hoverEl) {
            hoverEl = next;
            paint();
        }
    };

    const highlight = (targets) => {
        pins = [];
        unwatchLayout();

        if (overlay) {
            overlay.layer.replaceChildren();
        }

        const list = Array.isArray(targets) ? targets.slice(0, 100) : [];

        if (list.length > 0) {
            const shown = ensureOverlay();

            list.forEach((target, index) => {
                if (typeof target !== "object" || target === null || typeof target.selector !== "string") {
                    return;
                }

                const text = typeof target.label === "string" || typeof target.label === "number" ? clip(target.label, 8) : String(index + 1);
                const outline = css(doc.createElement("div"), {
                    position: "absolute",
                    left: "0",
                    top: "0",
                    display: "none",
                    "box-sizing": "border-box",
                    border: "1px solid " + ACCENT,
                    "border-radius": "2px",
                    opacity: ".55",
                });
                const node = css(doc.createElement("div"), {
                    position: "absolute",
                    left: "0",
                    top: "0",
                    display: "none",
                    "align-items": "center",
                    "justify-content": "center",
                    "box-sizing": "border-box",
                    "min-width": "22px",
                    height: "22px",
                    padding: "0 6px",
                    "border-radius": "11px",
                    background: ACCENT,
                    color: "#1a1b26",
                    font: "700 12px/1 system-ui, sans-serif",
                    "box-shadow": "0 1px 4px rgba(0,0,0,.45)",
                    "pointer-events": "auto",
                    cursor: "pointer",
                });

                node.addEventListener("click", (event) => {
                    event.stopPropagation();
                    send({ type: "pocket-pin", label: text, tap: true });
                });

                node.textContent = text;
                shown.layer.append(outline, node);

                const pin = { selector: clip(target.selector, 500), pid: typeof target.pid === "string" ? clip(target.pid, 200) : "" };

                // w: the badge's width (words and padding), to find a place before it is drawn.
                pins.push({ target: pin, el: null, node, outline, w: Math.max(22, 12 + 8 * text.length), drawn: {} });

                if (target.reveal === true) {
                    const el = findPinTarget(pin);

                    css(outline, { border: "2px solid " + ACCENT, opacity: "1" });
                    css(node, { "box-shadow": "0 0 0 2px #fff, 0 1px 6px rgba(0,0,0,.6)", "z-index": "1" });

                    if (el && typeof el.scrollIntoView === "function") {
                        el.scrollIntoView({ block: "center", inline: "nearest" });

                        // The canvas can be bigger than its room: tell the app where the pin is.
                        const at = el.getBoundingClientRect();

                        send({
                            type: "pocket-pin",
                            label: text,
                            rect: { x: at.left, y: at.top, width: at.width, height: at.height },
                        });
                    }
                }
            });
            watchLayout();
        }

        paint();
    };

    // ---------------------------------------------------------------------------------------------------------------
    // Inspect mode: outline the element under the pointer; a click or tap picks it, and the page's handlers do not run.

    let inspectOn = false;

    const BLOCKED = ["click", "dblclick", "auxclick", "contextmenu", "mousedown", "mouseup", "pointerdown", "pointerup", "submit"];

    const onInspect = (event) => {
        if (!inspectOn || !event.isTrusted) {
            return;
        }

        const type = event.type;

        if (type === "pointermove" || type === "pointerover") {
            setHover(event.target);

            return;
        }

        if (type === "pointerdown") {
            setHover(event.target);
        }

        if (type !== "pointerdown" && type !== "pointerup") {
            event.preventDefault();
        }

        event.stopImmediatePropagation();

        if (type === "click" && isEl(event.target) && event.target.localName !== "pocket-overlay") {
            pickedEl = event.target;
            paint();
            send({ type: "pocket-picked", target: targetOf(event.target) });
        }
    };

    const setInspect = (on) => {
        inspectOn = on;

        if (on) {
            setEdit(false);
        } else {
            hoverEl = null;
            pickedEl = null;
            paint();
        }
    };

    // ---------------------------------------------------------------------------------------------------------------
    // Text edit mode: text blocks become editable (plain text only); a change is reported when the block loses focus.

    let editOn = false;
    let hint = null;

    /** A faint dashed line round what can be edited, so a phone (which has no hover) shows it. A constructable sheet, so a page CSP cannot stop it. */
    const hintEdits = (on) => {
        if (on && hint === null) {
            try {
                hint = new CSSStyleSheet();
                hint.replaceSync("[contenteditable]:not(:focus){outline:1px dashed rgba(122,162,247,.8)!important;outline-offset:2px!important}");
                doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, hint];
            } catch {
                hint = null;
            }
        } else if (!on && hint !== null) {
            doc.adoptedStyleSheets = doc.adoptedStyleSheets.filter((sheet) => sheet !== hint);
            hint = null;
        }
    };

    const editableOf = (node) => {
        if (records.size === 0) {
            return null;
        }

        for (let el = isEl(node) ? node : node && node.parentElement; el; el = el.parentElement) {
            if (records.has(el)) {
                return el;
            }
        }

        return null;
    };

    const textBlocks = () => {
        const found = [];

        const walk = (el) => {
            if (found.length >= 2000 || NOT_TEXT.has(el.localName) || el.isContentEditable) {
                return;
            }

            if (el.getClientRects().length === 0) {
                return;
            }

            const own = [...el.childNodes].some((node) => node.nodeType === 3 && node.nodeValue.trim() !== "");

            if (own && [...el.querySelectorAll("*")].every((child) => INLINE.has(child.localName))) {
                if (squash(el.textContent).length <= 2000) {
                    found.push(el);
                }

                return;
            }

            for (const child of el.children) {
                walk(child);
            }
        };

        if (doc.body) {
            walk(doc.body);
        }

        return found;
    };

    const commit = (el) => {
        const record = records.get(el);

        if (!record) {
            return;
        }

        const after = squash(el.textContent);

        if (after === record.last || after.length > 2000) {
            return;
        }

        record.last = after;
        send({ type: "pocket-text-edited", target: targetOf(el), before: record.before, after });
    };

    const onEditKey = (event) => {
        const el = editableOf(event.target);

        if (!el) {
            return;
        }

        event.stopImmediatePropagation();

        if (event.type !== "keydown") {
            return;
        }

        if (event.key === "Enter") {
            event.preventDefault();
            el.blur();
        } else if (event.key === "Escape") {
            const record = records.get(el);

            event.preventDefault();

            if (record && record.nodes) {
                el.replaceChildren(...record.nodes.map((node) => node.cloneNode(true)));
            }

            el.blur();
        } else if (event.key === " " && (el.localName === "button" || el.localName === "summary")) {
            event.preventDefault();
            doc.execCommand("insertText", false, " ");
        }
    };

    const onEditFocus = (event) => {
        const el = editableOf(event.target);
        const record = el && records.get(el);

        if (record) {
            record.nodes = [...el.childNodes].map((node) => node.cloneNode(true));
        }
    };

    const onEditBlur = (event) => {
        const el = editableOf(event.target);

        if (el) {
            commit(el);
        }
    };

    const onEditPaste = (event) => {
        if (editableOf(event.target)) {
            event.preventDefault();
            doc.execCommand("insertText", false, (event.clipboardData ? event.clipboardData.getData("text/plain") : "").replace(/\s*\n\s*/g, " "));
        }
    };

    const onEditPointer = (event) => {
        if (!editOn || !event.isTrusted) {
            return;
        }

        if (event.type === "pointermove" || event.type === "pointerover") {
            setHover(editableOf(event.target));

            return;
        }

        // The page's own click handlers (a link, a button's action) do not run while text is edited.
        event.stopImmediatePropagation();

        if (event.type === "click" || event.type === "submit" || event.type === "drop" || event.type === "dragstart") {
            event.preventDefault();
        }
    };

    /** Make the text blocks that show now editable: also those of a slide that came into view after the mode went on. */
    const makeEditable = () => {
        for (const el of textBlocks()) {
            if (records.has(el)) {
                continue;
            }

            records.set(el, { ce: el.getAttribute("contenteditable"), sc: el.getAttribute("spellcheck"), before: squash(el.textContent), last: squash(el.textContent), nodes: null });
            el.setAttribute("contenteditable", "plaintext-only");
            el.setAttribute("spellcheck", "false");

            // A browser without plain-text editing makes it plain editing.
            if (el.contentEditable !== "plaintext-only") {
                el.setAttribute("contenteditable", "true");
            }
        }
    };

    const setEdit = (on) => {
        hintEdits(on);

        if (!on) {
            for (const [el, record] of [...records]) {
                commit(el);

                if (record.ce === null) {
                    el.removeAttribute("contenteditable");
                } else {
                    el.setAttribute("contenteditable", record.ce);
                }

                if (record.sc === null) {
                    el.removeAttribute("spellcheck");
                } else {
                    el.setAttribute("spellcheck", record.sc);
                }
            }

            records.clear();

            if (editOn) {
                hoverEl = null;
                paint();
            }

            editOn = false;

            return;
        }

        if (inspectOn) {
            setInspect(false);
        }

        editOn = true;

        makeEditable();
    };

    // ---------------------------------------------------------------------------------------------------------------
    // The listeners of both modes sit on the window in the capture phase from the start, so they run before any the page
    // adds. Each does nothing, and changes nothing, until its mode is on.

    const always = group();

    const onTouch = (event) => {
        if (deck) {
            onDeckTouch(event);
        }

        // A touch handler of the page does not run while inspecting; scrolling is not touched.
        if (inspectOn && event.isTrusted) {
            event.stopImmediatePropagation();
        }
    };

    const install = () => {
        always.clear();

        for (const type of ["pointermove", "pointerover", ...BLOCKED]) {
            always.add(type, onInspect, true);
        }

        for (const type of ["keydown", "keyup", "keypress"]) {
            always.add(type, onEditKey, true);
        }

        always.add("focusin", onEditFocus, true);
        always.add("focusout", onEditBlur, true);
        always.add("paste", onEditPaste, true);

        for (const type of ["pointermove", "pointerover", "click", "dblclick", "auxclick", "submit", "drop", "dragstart"]) {
            always.add(type, onEditPointer, true);
        }

        for (const type of ["touchstart", "touchend"]) {
            always.add(type, onTouch, { capture: true, passive: true });
        }
    };

    // ---------------------------------------------------------------------------------------------------------------
    // Tweaks: the page's manifest goes to the app; the app's values go into the page as custom properties and events.

    let knobs = [];
    let manifestText = null;

    const knobOf = (raw) => {
        if (typeof raw !== "object" || raw === null || typeof raw.name !== "string" || raw.name === "" || raw.name.length > 80) {
            return null;
        }

        const type = KNOB_TYPES.includes(raw.type) ? raw.type : "text";
        const scalar = (value) => (typeof value === "string" ? clip(value, 200) : typeof value === "boolean" ? value : Number.isFinite(value) ? value : "");
        const knob = { name: raw.name, type, value: scalar(raw.value) };
        const number = (value) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

        if (typeof raw.label === "string") {
            knob.label = clip(raw.label, 80);
        }

        for (const key of ["min", "max", "step"]) {
            if (number(raw[key]) !== undefined) {
                knob[key] = raw[key];
            }
        }

        if (typeof raw.unit === "string") {
            knob.unit = clip(raw.unit, 10);
        }

        if (Array.isArray(raw.options)) {
            knob.options = raw.options
                .slice(0, 50)
                .map((option) => (typeof option === "object" && option !== null ? option.value : option))
                .filter((option) => typeof option === "string" || typeof option === "number")
                .map((option) => clip(option, 80));
        }

        return knob;
    };

    const readTweaks = () => {
        const node = doc.getElementById("pocket-tweaks");
        const text = node ? node.textContent : null;

        if (text === manifestText) {
            return;
        }

        const first = manifestText === null;

        manifestText = text;

        let list = [];

        try {
            const parsed = text === null ? [] : JSON.parse(text);

            list = Array.isArray(parsed) ? parsed : [];
        } catch {
            list = [];
        }

        const seen = new Set();

        knobs = list.slice(0, 40).map(knobOf).filter((knob) => {
            if (knob === null || seen.has(knob.name)) {
                return false;
            }

            seen.add(knob.name);

            return true;
        });

        if (!first || knobs.length > 0) {
            send({ type: "pocket-tweaks", knobs });
        }
    };

    const setTweaks = (values) => {
        if (typeof values !== "object" || values === null) {
            return;
        }

        for (const name of Object.keys(values).slice(0, 100)) {
            const value = values[name];

            if (name.length > 80 || !(value === null || ["string", "number", "boolean"].includes(typeof value))) {
                continue;
            }

            if (/^--[A-Za-z0-9_-]{1,78}$/.test(name)) {
                const knob = knobs.find((each) => each.name === name);

                if (value === null) {
                    doc.documentElement.style.removeProperty(name);
                } else if (typeof value === "number") {
                    if (Number.isFinite(value)) {
                        doc.documentElement.style.setProperty(name, value + (knob && knob.unit ? knob.unit : ""));
                    }
                } else {
                    doc.documentElement.style.setProperty(name, typeof value === "boolean" ? (value ? "1" : "0") : clip(value, 200));
                }
            }

            fire(CustomEvt("pocket:tweak", { name, value }));
        }
    };

    // ---------------------------------------------------------------------------------------------------------------
    // Decks: one slide at a time, at a size of its own, scaled to fit; arrow keys and swipes move between slides.

    const deckEvents = group();
    let deck = null;
    let touch = null;

    const isDeck = () => {
        const meta = doc.querySelector('meta[name="pocket-kind"]');

        return meta !== null && meta.getAttribute("content") === "deck";
    };

    const slideSize = () => {
        const meta = doc.querySelector('meta[name="pocket-slide-size"]');
        const match = meta && /^\s*(\d{3,4})\s*[x×]\s*(\d{3,4})\s*$/i.exec(meta.getAttribute("content") || "");
        const width = match ? Number(match[1]) : 0;
        const height = match ? Number(match[2]) : 0;

        // The same sizes as the exports take (parseSlideSize in design/render.ts): 320 to 3840 on each side.
        return width >= 320 && height >= 320 && width <= 3840 && height <= 3840 ? { width, height } : { width: SLIDE_W, height: SLIDE_H };
    };

    const deckSheet = () => {
        const { width, height } = deck.size;
        const scale = Math.min(win.innerWidth / width, win.innerHeight / height) || 1;

        // A frame not laid out at the start gets no resize event for its first size: the watch below compares with this.
        deck.fit = [win.innerWidth, win.innerHeight];

        return (
            "html,body{margin:0!important;padding:0!important;width:100%!important;height:100%!important;overflow:hidden!important}" +
            (deck.bare ? "html{background:#000}" : "") +
            "section.slide:not([data-pocket-current]){display:none!important}" +
            "section.slide[data-pocket-current]{position:fixed!important;left:50%!important;top:50%!important;width:" + width + "px!important;height:" + height +
            "px!important;min-width:0!important;max-width:none!important;min-height:0!important;max-height:none!important;margin:0!important;box-sizing:border-box!important;overflow:hidden!important;" +
            "transform-origin:center center!important;transform:translate(-50%,-50%) scale(" + scale + ")!important}" +
            "@media print{@page{size:" + width + "px " + height + "px;margin:0}html,body{overflow:visible!important;height:auto!important}" +
            "section.slide:not([data-pocket-current]),section.slide[data-pocket-current]{display:block!important;position:relative!important;left:auto!important;top:auto!important;" +
            "transform:none!important;break-after:page;page-break-after:always}}"
        );
    };

    const paintDeck = () => {
        if (!deck) {
            return;
        }

        deck.slides.forEach((slide, index) => {
            if (index === deck.index) {
                slide.setAttribute("data-pocket-current", "");
            } else {
                slide.removeAttribute("data-pocket-current");
                unshow(slide);
            }
        });

        if (deck.sheet) {
            deck.sheet.replaceSync(deckSheet());
        } else {
            deck.node.textContent = deckSheet();
        }

        // A page that hides its other slides itself (".slide:not(:first-child){display:none}"): the current one must
        // still show, in the layout the page gives its slides (flex, grid), so it gets that display inline until it goes.
        const current = deck.slides[deck.index];

        if (current && !deck.shownInline.has(current) && win.getComputedStyle(current).display === "none") {
            deck.shownInline.set(current, {
                value: current.style.getPropertyValue("display"),
                priority: current.style.getPropertyPriority("display"),
            });
            current.style.setProperty("display", deck.display, "important");
        }

        // Text edit mode goes on to the slide that shows now.
        if (editOn) {
            makeEditable();
        }
    };

    /** Give back a slide's own inline display, if the deck changed it to show the slide. */
    const unshow = (slide) => {
        const before = deck && deck.shownInline.get(slide);

        if (!before) {
            return;
        }

        deck.shownInline.delete(slide);

        if (before.value === "") {
            slide.style.removeProperty("display");
        } else {
            slide.style.setProperty("display", before.value, before.priority);
        }
    };

    const tellDeck = () => {
        send({ type: "pocket-deck", slides: deck.slides.length, current: deck.index });
        fire(CustomEvt("pocket:slide", { index: deck.index, count: deck.slides.length }));
    };

    const goTo = (index) => {
        if (!deck || !Number.isFinite(index)) {
            return;
        }

        const next = Math.min(Math.max(Math.trunc(index), 0), deck.slides.length - 1);

        if (next !== deck.index) {
            deck.index = next;
            paintDeck();
            tellDeck();
        }
    };

    const onDeckKey = (event) => {
        const target = event.target;

        if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || editOn) {
            return;
        }

        if (isEl(target) && (target.isContentEditable || ["input", "textarea", "select"].includes(target.localName))) {
            return;
        }

        const key = event.key;
        const plain = target === doc.body || target === doc.documentElement || !isEl(target);
        const to = { ArrowRight: deck.index + 1, ArrowDown: deck.index + 1, PageDown: deck.index + 1, ArrowLeft: deck.index - 1, ArrowUp: deck.index - 1, PageUp: deck.index - 1, Home: 0, End: deck.slides.length - 1 }[key];

        if (to !== undefined) {
            event.preventDefault();
            goTo(to);
        } else if (key === " " && plain) {
            event.preventDefault();
            goTo(deck.index + (event.shiftKey ? -1 : 1));
        }
    };

    const onDeckTouch = (event) => {
        if (event.type === "touchstart") {
            touch = event.touches.length === 1 ? { x: event.touches[0].clientX, y: event.touches[0].clientY, at: now() } : null;

            return;
        }

        const swipe = touch;

        touch = null;

        if (!swipe || editOn || event.changedTouches.length !== 1) {
            return;
        }

        const dx = event.changedTouches[0].clientX - swipe.x;
        const dy = event.changedTouches[0].clientY - swipe.y;

        if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5 && now() - swipe.at < 800) {
            goTo(deck.index + (dx < 0 ? 1 : -1));
        }
    };

    const stopDeck = () => {
        deckEvents.clear();

        if (!deck) {
            return;
        }

        deck.watch?.disconnect();

        for (const slide of deck.slides) {
            slide.removeAttribute("data-pocket-current");
            unshow(slide);
        }

        if (deck.sheet) {
            doc.adoptedStyleSheets = doc.adoptedStyleSheets.filter((sheet) => sheet !== deck.sheet);
        } else {
            deck.node.remove();
        }

        if (deck.view) {
            deck.view.remove();
        }

        deck = null;
    };

    const syncDeck = () => {
        const slides = isDeck() ? [...doc.querySelectorAll("section.slide")] : [];

        if (slides.length === 0) {
            stopDeck();

            return;
        }

        if (deck && deck.slides.length === slides.length && deck.slides.every((slide, index) => slide === slides[index])) {
            return;
        }

        const started = deck === null;

        if (started) {
            // Black around the slide, unless the page paints its own ground (read before the sheet is in).
            const bare = [doc.documentElement, doc.body].every((el) => {
                const color = win.getComputedStyle(el).backgroundColor;

                return color === "rgba(0, 0, 0, 0)" || color === "transparent";
            });

            // The display the page gives its slides, read before the sheet is in: the first one that shows, else block.
            const shown = slides.map((slide) => win.getComputedStyle(slide).display).find((each) => each !== "none");

            deck = {
                slides,
                index: 0,
                size: slideSize(),
                bare,
                sheet: null,
                node: null,
                view: null,
                display: shown || "block",
                shownInline: new Map(),
                fit: [0, 0],
                watch: null,
            };

            // A phone lays a page with no viewport out at 980 pixels wide: a deck needs the real width to fit it.
            if (!doc.querySelector('meta[name="viewport"]') && doc.head) {
                deck.view = doc.createElement("meta");
                deck.view.setAttribute("name", "viewport");
                deck.view.setAttribute("content", "width=device-width, initial-scale=1");
                doc.head.append(deck.view);
            }

            try {
                deck.sheet = new CSSStyleSheet();
                doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, deck.sheet];
            } catch {
                deck.sheet = null;
                deck.node = doc.createElement("style");
                (doc.head || doc.documentElement).append(deck.node);
            }

            deckEvents.add("keydown", onDeckKey);
            deckEvents.add("resize", paintDeck);

            // A window sized after the deck started fires no resize: the root is as big as the window, so watch it.
            if (typeof win.ResizeObserver === "function") {
                deck.watch = new win.ResizeObserver(() => {
                    if (deck && (deck.fit[0] !== win.innerWidth || deck.fit[1] !== win.innerHeight)) {
                        paintDeck();
                    }
                });
                deck.watch.observe(doc.documentElement);
            }
        } else {
            deck.slides = slides;
            deck.index = Math.min(deck.index, slides.length - 1);
        }

        paintDeck();
        tellDeck();
    };

    // ---------------------------------------------------------------------------------------------------------------
    // Watching the page's own markup for a manifest or slides that come, change, or go.

    let watcher = null;
    let pending = null;

    const watch = () => {
        if (pending !== null) {
            return;
        }

        pending = later(() => {
            pending = null;

            if (!standalone) {
                readTweaks();
            }

            syncDeck();
        }, 100);
    };

    const start = () => {
        watch();

        if (watcher === null) {
            watcher = new MutationObserver(watch);
            watcher.observe(doc.documentElement, { childList: true, subtree: true, characterData: true });
        }
    };

    // The height of the page's content, so that a Check can shorten a frame with more room than its page.

    const SIZE_SCAN = 1500;
    let sizeWatch = null;
    let sizeTimer = null;
    let sizeSent = -1;

    /** Null when the page is too big to scan: the frame then keeps its room. */
    const contentBottom = () => {
        const body = doc.body;

        if (!body) {
            return null;
        }

        const all = body.querySelectorAll("*");

        if (all.length > SIZE_SCAN) {
            return null;
        }

        const scrolled = win.scrollY || 0;
        let bottom = Math.max(doc.documentElement.getBoundingClientRect().bottom, body.getBoundingClientRect().bottom) + scrolled;

        for (const el of all) {
            if (el.localName !== "pocket-overlay") {
                bottom = Math.max(bottom, el.getBoundingClientRect().bottom + scrolled);
            }
        }

        return bottom;
    };

    const reportSize = () => {
        sizeTimer = null;

        const bottom = contentBottom();
        const height = bottom === null ? 0 : Math.ceil(bottom);

        if (Math.abs(height - sizeSent) >= 2) {
            sizeSent = height;
            send({ type: "pocket-size", height });
        }
    };

    const sizeLater = () => {
        if (sizeTimer === null) {
            sizeTimer = later(reportSize, 150);
        }
    };

    const watchSize = () => {
        sizeSent = -1;
        sizeLater();

        if (sizeWatch === null && typeof win.ResizeObserver === "function") {
            sizeWatch = new win.ResizeObserver(sizeLater);
            sizeWatch.observe(doc.documentElement);

            if (doc.body) {
                sizeWatch.observe(doc.body);
            }
        }
    };

    const unwatchSize = () => {
        if (sizeTimer !== null) {
            unlater(sizeTimer);
            sizeTimer = null;
        }

        if (sizeWatch !== null) {
            sizeWatch.disconnect();
            sizeWatch = null;
        }
    };

    // What the app asked for, so a replaced document (a reply's HTML run again) can be given it again.
    const desired = { inspect: false, edit: false, targets: [], tweaks: {} };
    // The app may speak before the page is parsed (it says hello as the page starts): what needs the page waits.
    let ready = false;
    let backlog = [];

    const apply = (data) => {
        switch (data.type) {
            case "pocket-inspect":
                desired.inspect = data.on === true;
                desired.edit = desired.edit && !desired.inspect;
                setInspect(desired.inspect);
                break;
            case "pocket-edit-text":
                desired.edit = data.on === true;
                desired.inspect = desired.inspect && !desired.edit;
                setEdit(desired.edit);
                break;
            case "pocket-tweak-set":
                if (typeof data.values === "object" && data.values !== null) {
                    for (const name of Object.keys(data.values).slice(0, 100)) {
                        if (data.values[name] === null) {
                            delete desired.tweaks[name];
                        } else {
                            desired.tweaks[name] = data.values[name];
                        }
                    }
                }

                setTweaks(data.values);
                break;
            case "pocket-highlight":
                desired.targets = Array.isArray(data.targets) ? data.targets : [];
                highlight(desired.targets);
                break;
            case "pocket-goto":
                goTo(data.slide);
                break;
        }
    };

    const begin = () => {
        if (!standalone) {
            readTweaks();
        }

        syncDeck();
        start();

        if (!standalone) {
            watchSize();
            addListener("load", sizeLater, { once: true });
        }

        ready = true;

        for (const data of backlog.splice(0)) {
            apply(data);
        }
    };

    const whenParsed = () => {
        if (doc.readyState === "loading") {
            addListener("DOMContentLoaded", begin, { once: true });
        } else {
            begin();
        }
    };

    install();
    whenParsed();

    return {
        /** True when the message is one of the app's design messages (it is then not the page's to see). */
        message(data) {
            if (standalone || typeof data !== "object" || data === null) {
                return false;
            }

            if (
                !["pocket-inspect", "pocket-edit-text", "pocket-tweak-set", "pocket-highlight", "pocket-goto"].includes(data.type)
            ) {
                return false;
            }

            if (ready) {
                apply(data);
            } else {
                backlog.push(data);
            }

            return true;
        },

        /** The page's document was replaced (a reply's HTML run again): put the listeners back, and what was asked for. */
        restart() {
            if (pending !== null) {
                unlater(pending);
                pending = null;
            }

            if (watcher !== null) {
                watcher.disconnect();
                watcher = null;
            }

            if (overlay) {
                overlay.host.remove();
                overlay = null;
            }

            stopDeck();
            hintEdits(false);
            records.clear();
            manifestText = null;
            knobs = [];
            hoverEl = null;
            pickedEl = null;
            pins = [];
            unwatchLayout();
            unwatchSize();
            inspectOn = false;
            editOn = false;
            ready = false;
            touch = null;
            backlog = [
                { type: "pocket-tweak-set", values: { ...desired.tweaks } },
                { type: "pocket-highlight", targets: desired.targets },
                { type: "pocket-inspect", on: desired.inspect },
                { type: "pocket-edit-text", on: desired.edit },
            ];
            install();
            whenParsed();
        },
    };
}`;

/** A page that declares itself a deck, in its markup: `<meta name="pocket-kind" content="deck">`. */
export function isDeckPage(html: string): boolean {
    return [...html.matchAll(/<meta\b[^>]*>/gi)].some(
        ([tag]) =>
            /\bname\s*=\s*["']?pocket-kind\b/i.test(tag) &&
            /\bcontent\s*=\s*["']?deck\b/i.test(tag),
    );
}

/**
 * A deck as its own page (a tab of its own, a published link): the deck part of the inspector, with no line to an app,
 * so it shows one slide at a time with keys and swipes, and prints one slide to a page. Any other page stays as written.
 */
export function withDeck(html: string): string {
    if (!isDeckPage(html)) {
        return html;
    }

    const start = /^\uFEFF?[\t\n\f\r ]*(?:<!doctype[^>]*>)?/i.exec(html)![0];

    return `${start}<script>(${ARTIFACT_INSPECT})(function () {}, true);</script>${html.slice(start.length)}`;
}
