// The canvas: a design's page in the artifact sandbox frame (the same frame and bridge as the artifact viewer), scaled to
// fit, with the page's side of Design mode (inspect, edit text, tweaks, pins, slides) spoken through the bridge.
import { useArtifactBridge } from "/artifact-bridge.js";
import { nextZoom, percent, scaleOf, stepZoom, zoomOf, zoomWord } from "./devices.js";
import { checkOptions, pinsOfReport } from "./check.js";
import { pinsOf } from "./comments.js";
import { addEdit } from "./edits.js";
import { checkKey } from "./system-data.js";
import { forPage, normalizeKnobs, usable } from "./tweaks.js";

/** As the artifact viewer's frame (`web/sheets/viewers.js`): scripts and forms run; the app and its cookies are out of reach. */
export const SANDBOX =
    "allow-scripts allow-forms allow-modals allow-popups allow-pointer-lock allow-downloads";
export const ALLOW = "fullscreen; clipboard-write; accelerometer; gyroscope";

export const frameUrl = (conversation, id, version) =>
    `/a/${conversation}/${encodeURIComponent(id)}/${version}`;

const MIN_CROP = 160;
const CROP_PAD = 24;

/** The height of a frame of `size` that shows no more than the page's content (`crop`: 0 when it is not known). */
const shownHeight = (size, crop) => (crop > 0 && crop < size.h ? Math.max(crop, MIN_CROP) : size.h);
const NO_KNOBS = [];
const NO_VALUES = {};
/** The bridge takes at most 100 values in one message. */
const BATCH = 100;
const num = (value) => typeof value === "number" && Number.isFinite(value);

export function createCanvas(env) {
    const { pocket, store, data, parts } = env;
    const { html, useEffect, useRef, useState } = pocket;
    const { Ico, useSize } = parts;

    /** A page at its own size, scaled by `scale`: the box takes the scaled room, the frame inside the full one. */
    function Stage({ size, scale, children, label, crop }) {
        const shown = shownHeight(size, crop);

        return html`<div
            class="dsn-stage"
            style=${`width:${Math.round(size.w * scale)}px;height:${Math.round(shown * scale)}px`}
            title=${label}
        >
            <div
                class="dsn-stage-in"
                style=${`width:${size.w}px;height:${size.h}px;transform:scale(${scale})`}
            >
                ${children}
            </div>
        </div>`;
    }

    /** A frame that only shows (compare, thumbnails, the deck's present mode before it is wired): no bridge. */
    function Still({ src, title, interactive = true, lazy = false }) {
        return html`<iframe
            class="dsn-frame"
            src=${src}
            sandbox=${SANDBOX}
            allow=${ALLOW}
            title=${title}
            loading=${lazy ? "lazy" : "eager"}
            style=${interactive ? "" : "pointer-events:none"}
            tabindex=${interactive ? undefined : "-1"}
        ></iframe>`;
    }

    /** The zoom, the size, and the backdrop: a small bar over the canvas. */
    function ZoomBar({ s, size, scale }) {
        const dark = s.backdrop === "dark" || (s.backdrop === "auto" && env.darkTheme());
        const narrow = env.sizeClass(s) === "narrow";
        const zoom = zoomOf(s.zoom, narrow);
        const following = zoom === "width" || zoom === "fit";

        return html`<div class="dsn-zoom" role="group" aria-label="Zoom">
            <button
                type="button"
                title="Zoom out"
                aria-label="Zoom out"
                onClick=${() => env.setZoom(stepZoom(scale, -1))}
            >
                <${Ico} name="minus" size=${14} />
            </button>
            <button
                type="button"
                class="dsn-zoom-value"
                title=${
                    zoom === "width"
                        ? "The width of the room, the page scrolls. Tap for the whole page."
                        : zoom === "fit"
                          ? "The whole page in the room. Tap for 100%."
                          : "Tap to fit the room"
                }
                onClick=${() => env.setZoom(nextZoom(following ? zoom : 1, narrow))}
            >
                ${zoomWord(zoom)}${percent(scale)}
            </button>
            <button
                type="button"
                title="Zoom in"
                aria-label="Zoom in"
                onClick=${() => env.setZoom(stepZoom(scale, 1))}
            >
                <${Ico} name="plus" size=${14} />
            </button>
            <span class="dsn-zoom-size mono">${size.w}×${size.h}</span>
            <button
                type="button"
                title=${dark ? "Light backdrop" : "Dark backdrop"}
                aria-label=${dark ? "Light backdrop" : "Dark backdrop"}
                onClick=${() => env.setBackdrop(dark ? "light" : "dark")}
            >
                <${Ico} name=${dark ? "sun" : "moon"} size=${14} />
            </button>
        </div>`;
    }

    /** The design's page, in the frame with the bridge, scaled to the room. */
    function CanvasView({ s, design, version, size, readOnly }) {
        const room = useRef(null);
        const frame = useRef(null);
        const roomSize = useSize(room);
        const [ready, setReady] = useState(0);
        const [loaded, setLoaded] = useState(false);
        const [content, setContent] = useState(0);
        const sent = useRef({ at: "", values: {} });
        // The slide to go back to once a page that loads again says it is a deck (`pocket-deck`).
        const pendingSlide = useRef(0);
        // The zoom bar floats over the bottom of the room: the page fits above it.
        const zoom = zoomOf(s.zoom, env.sizeClass(s) === "narrow");
        const checking = s.dock === "check";
        const crop = checking && content > 0 ? content + CROP_PAD : 0;
        const scale = scaleOf(
            zoom,
            { w: size.w, h: shownHeight(size, crop) },
            { w: roomSize.w, h: roomSize.h - 40 },
        );
        const src = frameUrl(s.conversation, design.id, version);
        const key = `${src}#${s.reload}`;
        const notes = s.notes[design.id];
        const comments = notes?.comments ?? [];
        const check = checkOptions(s, env.canvasDark(s));
        const pins = s.mode === "comment" || s.dock === "comments" ? pinsOf(comments, version) : [];
        const targets = checking
            ? pinsOfReport(
                  s.checks[checkKey(design.id, version, check.mode, check.size)]?.report,
                  s.checkFocus,
              )
            : pins.map((comment, index) => ({
                  ...(comment.target.pid ? { pid: comment.target.pid } : {}),
                  selector: comment.target.selector,
                  label: index + 1,
              }));
        // The knobs are this frame's: a page that was just replaced has none until it says so.
        const knobs = s.knobsKey === key ? s.knobs : NO_KNOBS;
        const values = s.tweaks[design.id] ?? NO_VALUES;

        // What the page says: the module's own handlers, current at every call (the bridge keeps the latest ones).
        const hear = useRef(null);

        hear.current = (message) => {
            if (!message || typeof message !== "object") {
                return;
            }

            const state = store.get();

            if (message.type === "pocket-picked" && state.mode === "comment" && !readOnly) {
                store.set({
                    draft: { artifact: design.id, version, target: message.target },
                    dock: "comments",
                });
            } else if (
                message.type === "pocket-text-edited" &&
                state.mode === "edit" &&
                !readOnly &&
                message.target &&
                typeof message.before === "string" &&
                typeof message.after === "string"
            ) {
                const at = `${design.id}@${version}`;

                store.set((now) => ({
                    edits: {
                        ...now.edits,
                        [at]: addEdit(now.edits[at] ?? [], {
                            target: message.target,
                            before: message.before,
                            after: message.after,
                        }),
                    },
                }));
            } else if (message.type === "pocket-size") {
                setContent(message.height);
            } else if (message.type === "pocket-pin") {
                if (message.tap === true) {
                    const number = Number(message.label);

                    if (state.dock === "check" && Number.isInteger(number)) {
                        store.set({
                            checkFocus: { number, at: Date.now() },
                            checkSheet: Math.max(1, state.checkSheet),
                        });
                    }
                } else if (message.rect) {
                    // The room can be smaller than the frame: scroll it to the pin too.
                    const box = room.current?.querySelector(".dsn-scroll");
                    const stage = box?.querySelector(".dsn-stage");

                    if (box && stage) {
                        box.scrollTo({
                            top: Math.max(
                                0,
                                stage.offsetTop +
                                    (message.rect.y + message.rect.height / 2) * scale -
                                    box.clientHeight / 2,
                            ),
                            left: Math.max(
                                0,
                                stage.offsetLeft +
                                    (message.rect.x + message.rect.width / 2) * scale -
                                    box.clientWidth / 2,
                            ),
                            behavior: "smooth",
                        });
                    }
                }
            } else if (message.type === "pocket-tweaks") {
                store.set({ knobs: normalizeKnobs(message.knobs), knobsKey: key });
            } else if (
                message.type === "pocket-deck" &&
                num(message.slides) &&
                message.slides > 0 &&
                num(message.current)
            ) {
                const slides = Math.min(500, Math.round(message.slides));
                const want = pendingSlide.current;
                let current = Math.max(0, Math.round(message.current));

                // A page that loaded again starts on its first slide: go back to the one the person was on, once.
                pendingSlide.current = 0;

                if (
                    want > 0 &&
                    want < slides &&
                    current !== want &&
                    send({ type: "pocket-goto", slide: want })
                ) {
                    current = want;
                }

                store.set({ deck: { slides, current }, slide: current });
            }
        };

        const bridge = useArtifactBridge(frame, {
            artifact: design.id,
            source: `the design “${design.title}”`,
            enabled: true,
            onMessage: (message) => hear.current(message),
            onReady: () => setReady((count) => count + 1),
        });
        const supported = typeof bridge?.send === "function";
        const send = (message) => (supported ? bridge.send(message) === true : false);

        // For other parts of the workspace (the slide strip, the dock): a way to talk to this frame.
        env.frame.current = {
            send,
            supported,
            goto: (slide) => send({ type: "pocket-goto", slide }),
        };

        useEffect(() => () => (env.frame.current = null), []);
        useEffect(() => void store.set({ bridge: supported }), [supported]);

        // A new page: what it said about itself is gone until it says it again.
        useEffect(() => {
            setLoaded(false);
            setContent(0);
            pendingSlide.current = store.get().slide;
            store.set({ knobs: [], deck: null });
        }, [key]);

        // The mode: the page's inspector for a comment, contenteditable text for an edit.
        useEffect(() => {
            send({ type: "pocket-inspect", on: s.mode === "comment" && !readOnly });
            send({ type: "pocket-edit-text", on: s.mode === "edit" && !readOnly });
        }, [ready, s.mode, readOnly]);

        // Numbered pins on the elements that have open comments on this version.
        // (a tap on a finding again asks again: the key has the moment of it)
        const pinKey = `${checking ? (s.checkFocus?.at ?? "") : ""}\n${targets
            .map((target) => `${target.label}${target.selector}${target.reveal ? "!" : ""}`)
            .join("\n")}`;

        useEffect(() => {
            send({ type: "pocket-highlight", targets: targets.slice(0, 100) });
        }, [ready, pinKey]);

        // The saved tweaks, once the page has said what its knobs are and the server what was saved.
        useEffect(() => {
            if (knobs.length > 0 && notes?.loaded && s.tweaks[design.id] === undefined) {
                store.set((now) => ({
                    tweaks: { ...now.tweaks, [design.id]: usable(knobs, notes.tweaks) },
                }));
            }
        }, [knobs, notes?.loaded]);

        // Tweaks to the page: only what differs from what it was last told (a fresh page has been told nothing).
        useEffect(() => {
            if (sent.current.at !== `${key}:${ready}`) {
                sent.current = { at: `${key}:${ready}`, values: {} };
            }

            const out = {};
            const next = { ...sent.current.values };

            for (const knob of knobs) {
                const own = Object.hasOwn(values, knob.name);
                const want = own ? forPage(knob, values[knob.name]) : undefined;

                if (want !== sent.current.values[knob.name]) {
                    out[knob.name] = want === undefined ? forPage(knob, knob.value) : want;
                    next[knob.name] = want;
                }
            }

            if (Object.keys(out).length > 0 && send({ type: "pocket-tweak-set", values: out })) {
                sent.current.values = next;
            }
        }, [key, ready, knobs, values]);

        // Send only what differs from the last send; null removes a property.
        const sentVars = useRef({ at: "", vars: {} });
        const wanted = s.previewVars;

        useEffect(() => {
            if (sentVars.current.at !== `${key}:${ready}`) {
                sentVars.current = { at: `${key}:${ready}`, vars: {} };
            }

            const have = sentVars.current.vars;
            const out = {};

            for (const [name, css] of Object.entries(wanted)) {
                if (have[name] !== css) {
                    out[name] = css;
                }
            }

            for (const name of Object.keys(have)) {
                if (!Object.hasOwn(wanted, name)) {
                    out[name] = null;
                }
            }

            const names = Object.keys(out);

            if (names.length === 0) {
                return;
            }

            let all = true;

            for (let at = 0; at < names.length; at += BATCH) {
                const part = Object.fromEntries(
                    names.slice(at, at + BATCH).map((name) => [name, out[name]]),
                );

                all = send({ type: "pocket-tweak-set", values: part }) && all;
            }

            if (all) {
                sentVars.current.vars = { ...wanted };
            }
        }, [key, ready, wanted]);

        return html`<div
            class="dsn-canvas has-zoom"
            ref=${room}
            data-backdrop=${s.backdrop}
            data-mode=${s.mode}
        >
            <div class="dsn-scroll" data-no-swipe>
                <${Stage} size=${size} scale=${scale} label=${design.title} crop=${crop}>
                    <iframe
                        ref=${frame}
                        key=${key}
                        class=${`dsn-frame wait ${loaded ? "loaded" : ""}`}
                        src=${src}
                        style=${s.backdrop === "auto" ? undefined : `color-scheme:${s.backdrop}`}
                        sandbox=${SANDBOX}
                        allow=${ALLOW}
                        title=${design.title}
                        onLoad=${() => setLoaded(true)}
                    ></iframe>
                <//>
            </div>
            ${!loaded && html`<div class="dsn-loading"><${pocket.Spinner} label="Loading the design" /></div>`}
            ${
                s.mode === "comment" &&
                !s.draft &&
                html`<div class="dsn-hint" key=${s.mode}>
                    ${
                        supported
                            ? "Tap an element to comment"
                            : "Pointing needs the frame's inspector"
                    }
                </div>`
            }
            ${
                s.mode === "edit" &&
                html`<div class="dsn-hint" key=${s.mode}>
                    ${supported ? "Tap text to change it" : "Editing needs the frame's inspector"}
                </div>`
            }
            <${ZoomBar} s=${s} size=${size} scale=${scale} />
        </div>`;
    }

    return { Stage, Still, CanvasView, ZoomBar };
}
