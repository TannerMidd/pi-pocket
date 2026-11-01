// What can fill the canvas besides the live page: two versions side by side, a group's variations as a grid, the slide
// strip of a deck, and the full-screen present mode.
import { useArtifactBridge } from "/artifact-bridge.js";
import { scaleOf, zoomOf } from "./devices.js";
import { ALLOW, frameUrl, SANDBOX } from "./canvas.js";

export function createViews(env, canvas) {
    const { pocket, store, parts } = env;
    const { html, useEffect, useRef, useState } = pocket;
    const { Ico, useSize, ago } = parts;
    const { Stage, Still } = canvas;

    // ─── Compare ─────────────────────────────────────────────────────────────

    function ComparePane({ s, design, version, size, scale, onPick, side, onSwap }) {
        const box = useRef(null);

        return html`<section class="dsn-compare-pane" aria-label=${`Version ${version}`}>
            <header>
                <span class="dsn-compare-side">${side}</span>
                <select
                    aria-label=${`Version for ${side}`}
                    value=${version}
                    onChange=${(event) => onPick(Number(event.currentTarget.value))}
                >
                    ${[...design.versions]
                        .reverse()
                        .map(
                            (each) =>
                                html`<option value=${each.version}>
                                    v${each.version} · ${ago(each.createdAt)}
                                </option>`,
                        )}
                </select>
                ${
                    onSwap &&
                    html`<button
                        type="button"
                        class="icon-button"
                        title="Swap the two versions"
                        aria-label="Swap the two versions"
                        onClick=${onSwap}
                    >
                        <${Ico} name="swap" size=${15} />
                    </button>`
                }
            </header>
            <div class="dsn-compare-room dsn-canvas" data-backdrop=${s.backdrop} ref=${box}>
                <div class="dsn-scroll" data-no-swipe>
                    <${Stage} size=${size} scale=${scale} label=${`Version ${version}`}>
                        <${Still}
                            key=${`${version}#${s.reload}`}
                            src=${frameUrl(s.conversation, design.id, version)}
                            title=${`${design.title}, version ${version}`}
                        />
                    <//>
                </div>
            </div>
        </section>`;
    }

    function CompareView({ s, design, size }) {
        const probe = useRef(null);
        const room = useSize(probe);
        const latest = design.versions.at(-1)?.version ?? 1;
        const has = (version) => design.versions.some((each) => each.version === version);
        const a = has(s.compare?.a) ? s.compare.a : Math.max(1, latest - 1);
        const b = has(s.compare?.b) ? s.compare.b : latest;
        const stacked = env.sizeClass(s) === "narrow";
        // Each pane gets half of the room, less its header.
        const pane = stacked
            ? { w: room.w, h: Math.max(0, room.h / 2 - 40) }
            : { w: room.w / 2, h: Math.max(0, room.h - 40) };
        const scale = scaleOf(zoomOf(s.zoom, false), size, pane);

        return html`<div class=${`dsn-compare ${stacked ? "stacked" : ""}`} ref=${probe}>
            <${ComparePane}
                s=${s}
                design=${design}
                version=${a}
                size=${size}
                scale=${scale}
                side="Before"
                onSwap=${() => store.set({ compare: { a: b, b: a } })}
                onPick=${(version) => store.set({ compare: { a: version, b } })}
            />
            <${ComparePane}
                s=${s}
                design=${design}
                version=${b}
                size=${size}
                scale=${scale}
                side="After"
                onPick=${(version) => store.set({ compare: { a, b: version } })}
            />
        </div>`;
    }

    // ─── Variations ──────────────────────────────────────────────────────────

    function Thumb({ s, each, size, current, canEdit, others }) {
        const box = useRef(null);
        const { w } = useSize(box);
        const latest = each.versions.at(-1)?.version ?? 1;
        const scale = w > 0 ? w / size.w : 0.2;

        return html`<article class=${`dsn-thumb ${current ? "on" : ""}`}>
            <button
                type="button"
                class="dsn-thumb-shot"
                ref=${box}
                style=${`aspect-ratio:${size.w} / ${size.h}`}
                title=${`Open ${each.title}`}
                onClick=${() => env.open(each.id)}
            >
                <span
                    class="dsn-thumb-in"
                    style=${`width:${size.w}px;height:${size.h}px;transform:scale(${scale})`}
                >
                    <${Still}
                        src=${frameUrl(s.conversation, each.id, latest)}
                        title=${each.title}
                        interactive=${false}
                        lazy=${true}
                    />
                </span>
            </button>
            <div class="dsn-thumb-foot">
                <div class="dsn-thumb-title">
                    <strong>${each.title}</strong>
                    <span class="muted small mono">${each.id} · v${latest}</span>
                </div>
                <div class="dsn-thumb-actions">
                    <button type="button" class="button small" onClick=${() => env.open(each.id)}>
                        Open
                    </button>
                    ${
                        canEdit &&
                        html`<button
                            type="button"
                            class="button small primary"
                            onClick=${() => env.useVariation(each, others)}
                        >
                            Use this one
                        </button>`
                    }
                </div>
            </div>
        </article>`;
    }

    function GridView({ s, design, designs, size, canEdit }) {
        const members = designs.filter((each) => each.group && each.group === design.group);
        // Thumbnails show the whole page in a cell: a tall phone page in a narrow cell, by the device's own shape.
        const shape = { w: size.w, h: Math.min(size.h, size.w * 1.8) };

        return html`<div class="dsn-grid-view" data-no-swipe>
            <header class="dsn-grid-head">
                <strong>${design.group}</strong>
                <span class="muted small"
                    >${members.length} variations. Open one, or choose the one to carry on
                    with.</span
                >
            </header>
            <div class="dsn-grid">
                ${members.map(
                    (each) =>
                        html`<${Thumb}
                            key=${each.id}
                            s=${s}
                            each=${each}
                            size=${shape}
                            current=${each.id === design.id}
                            canEdit=${canEdit}
                            others=${members.filter((other) => other.id !== each.id)}
                        />`,
                )}
            </div>
        </div>`;
    }

    // ─── Decks ───────────────────────────────────────────────────────────────

    function DeckStrip({ s }) {
        const deck = s.deck;

        if (!deck) {
            return null;
        }

        const go = (slide) => {
            const to = Math.max(0, Math.min(deck.slides - 1, slide));

            store.set({ deck: { ...deck, current: to }, slide: to });
            env.frame.current?.goto(to);
        };

        return html`<div class="dsn-deck" role="group" aria-label="Slides">
            <button
                type="button"
                class="icon-button"
                title="Previous slide"
                aria-label="Previous slide"
                disabled=${deck.current <= 0}
                onClick=${() => go(deck.current - 1)}
            >
                <${Ico} name="left" size=${16} />
            </button>
            <div class="dsn-deck-chips" data-no-swipe>
                ${Array.from(
                    { length: deck.slides },
                    (_, index) =>
                        html`<button
                            type="button"
                            key=${index}
                            class=${`dsn-slide ${index === deck.current ? "on" : ""}`}
                            aria-label=${`Slide ${index + 1}`}
                            aria-current=${index === deck.current}
                            onClick=${() => go(index)}
                        >
                            ${index + 1}
                        </button>`,
                )}
            </div>
            <button
                type="button"
                class="icon-button"
                title="Next slide"
                aria-label="Next slide"
                disabled=${deck.current >= deck.slides - 1}
                onClick=${() => go(deck.current + 1)}
            >
                <${Ico} name="right" size=${16} />
            </button>
        </div>`;
    }

    /** The deck full screen: the page fills the screen (the bridge scales a slide to fit); a small bar steps and leaves. */
    function Present({ s, design, version }) {
        const frame = useRef(null);
        const wrap = useRef(null);
        const [ready, setReady] = useState(0);
        const deck = s.deck;
        const bridge = useArtifactBridge(frame, {
            artifact: design.id,
            source: `the design “${design.title}”`,
            enabled: true,
            onMessage: (message) => {
                if (
                    message?.type === "pocket-deck" &&
                    Number.isFinite(message.slides) &&
                    Number.isFinite(message.current)
                ) {
                    store.set({
                        deck: { slides: message.slides, current: message.current },
                        slide: message.current,
                    });
                }
            },
            onReady: () => setReady((count) => count + 1),
        });

        const go = (slide) => {
            const to = Math.max(0, Math.min((store.get().deck?.slides ?? 1) - 1, slide));

            if (bridge?.send?.({ type: "pocket-goto", slide: to })) {
                store.set((now) => ({ deck: now.deck && { ...now.deck, current: to }, slide: to }));
            }
        };

        const leave = () => store.set({ present: false });

        // Start at the slide the canvas showed.
        useEffect(() => {
            if (ready > 0 && (store.get().deck?.current ?? 0) > 0) {
                bridge?.send?.({ type: "pocket-goto", slide: store.get().deck.current });
            }
        }, [ready]);

        // The browser's own full screen where there is one; leaving it leaves present mode.
        useEffect(() => {
            const element = wrap.current;

            const left = () => {
                if (!document.fullscreenElement) {
                    leave();
                }
            };

            document.addEventListener("fullscreenchange", left);
            element?.requestFullscreen?.().catch(() => {});

            return () => {
                document.removeEventListener("fullscreenchange", left);

                if (document.fullscreenElement === element) {
                    document.exitFullscreen?.().catch(() => {});
                }
            };
        }, []);

        useEffect(() => {
            const onKey = (event) => {
                if (event.key === "Escape") {
                    event.stopPropagation();
                    leave();
                } else if (
                    event.key === "ArrowRight" ||
                    event.key === "PageDown" ||
                    event.key === " "
                ) {
                    event.preventDefault();
                    go((store.get().deck?.current ?? 0) + 1);
                } else if (event.key === "ArrowLeft" || event.key === "PageUp") {
                    event.preventDefault();
                    go((store.get().deck?.current ?? 0) - 1);
                }
            };

            document.addEventListener("keydown", onKey, true);

            return () => document.removeEventListener("keydown", onKey, true);
        }, [bridge]);

        return html`<div
            class="dsn-present"
            ref=${wrap}
            role="dialog"
            aria-label="Present"
            aria-modal="true"
        >
            <iframe
                ref=${frame}
                key=${frameUrl(s.conversation, design.id, version)}
                class="dsn-present-frame"
                src=${frameUrl(s.conversation, design.id, version)}
                sandbox=${SANDBOX}
                allow=${ALLOW}
                title=${design.title}
            ></iframe>
            <div class="dsn-present-bar">
                <button
                    type="button"
                    class="icon-button"
                    title="Previous slide"
                    aria-label="Previous slide"
                    onClick=${() => go((deck?.current ?? 0) - 1)}
                >
                    <${Ico} name="left" size=${18} />
                </button>
                <span class="mono">${deck ? `${deck.current + 1} / ${deck.slides}` : ""}</span>
                <button
                    type="button"
                    class="icon-button"
                    title="Next slide"
                    aria-label="Next slide"
                    onClick=${() => go((deck?.current ?? 0) + 1)}
                >
                    <${Ico} name="right" size=${18} />
                </button>
                <button
                    type="button"
                    class="icon-button"
                    title="Leave (Esc)"
                    aria-label="Leave present mode"
                    onClick=${leave}
                >
                    <${Ico} name="close" size=${18} />
                </button>
            </div>
        </div>`;
    }

    return { CompareView, GridView, DeckStrip, Present };
}
