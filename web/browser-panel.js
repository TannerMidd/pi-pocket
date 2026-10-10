import { t } from "./i18n.js";
// The Browser panel: the session's page in the server's browser, the same one Pi uses with its browser tool. Frames
// come as JPEGs by long polling (which passes any tunnel); taps, drags, scrolls, and keys go back as input events. Wide
// screens show it as a window beside the conversation; phones show it full screen.

import { useEffect, useRef, useState } from "preact/hooks";
import { useBack } from "./back.js";
import {
    browserApi,
    browserAvailable,
    displayUrl,
    openInBrowser,
    reportNavigation,
    setBrowserOpen,
    toggleBrowser,
} from "./browser.js";
import { api, attempt, canSteer, notify, panelsBeside, store } from "./store.js";
import { APPLE, html, Icon, Spinner } from "./ui.js";

const WIDTH_KEY = "pocket.browserWidth";

/** Sizes the size button steps through. Fit makes the page the panel's size, as a browser window is. */
const PRESETS = [
    { id: "fit", icon: "fit", label: "Fit the panel" },
    { id: "desktop", icon: "monitor", label: "Desktop 1280×800" },
    { id: "mobile", icon: "phone", label: "Phone 390×844" },
    { id: "tablet", icon: "tablet", label: "Tablet 820×1180" },
];

/** The panel's own size as a viewport, pixel for pixel. */
function fitViewport(stage) {
    const width = Math.round(stage.clientWidth);
    const height = Math.round(stage.clientHeight);

    if (width < 240 || height < 240) {
        return undefined;
    }

    const touch = matchMedia("(pointer: coarse)").matches;

    return {
        width,
        height,
        scale: Math.min(2, Math.max(1, Math.round(devicePixelRatio * 4) / 4)),
        mobile: touch && width < 820,
    };
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Whether this tab is in front: hidden tabs fetch no frames. */
function useVisible() {
    const [visible, setVisible] = useState(document.visibilityState === "visible");

    useEffect(() => {
        const update = () => setVisible(document.visibilityState === "visible");

        document.addEventListener("visibilitychange", update);

        return () => document.removeEventListener("visibilitychange", update);
    }, []);

    return visible;
}

/** The page's newest frame, `{ src, width, height }` (CSS pixels), while `active`. Each answer asks for the next. */
function useFrames(conversationId, active) {
    const [frame, setFrame] = useState(null);

    useEffect(() => {
        if (!active) {
            return undefined;
        }

        let stopped = false;
        let request = null;
        let shown = null;
        let seq = 0;

        (async () => {
            let failures = 0;

            while (!stopped) {
                request = new AbortController();

                try {
                    const response = await fetch(
                        `/api/c/${conversationId}/browser/frame?after=${seq}`,
                        { signal: request.signal, cache: "no-store" },
                    );

                    if (stopped) {
                        return;
                    }

                    if (response.status === 204) {
                        // Closed pages have no frames: wait for one to open.
                        if (response.headers.get("x-closed")) {
                            await sleep(1000);
                        }

                        continue;
                    }

                    if (!response.ok) {
                        throw new Error(`HTTP ${response.status}`);
                    }

                    const blob = await response.blob();

                    seq = Number(response.headers.get("x-seq")) || seq;
                    const src = URL.createObjectURL(blob);
                    const image = new Image();

                    image.src = src;
                    // Decoded before it shows, so frames swap without a flash.
                    await image.decode().catch(() => {});

                    if (stopped) {
                        URL.revokeObjectURL(src);

                        return;
                    }

                    const previous = shown;

                    shown = src;
                    setFrame({
                        src,
                        width: Number(response.headers.get("x-width")) || image.naturalWidth,
                        height: Number(response.headers.get("x-height")) || image.naturalHeight,
                    });

                    if (previous) {
                        setTimeout(() => URL.revokeObjectURL(previous), 1000);
                    }

                    failures = 0;
                } catch {
                    if (stopped) {
                        return;
                    }

                    failures++;
                    await sleep(Math.min(5000, 400 * failures));
                }
            }
        })();

        return () => {
            stopped = true;
            request?.abort();
            const last = shown;

            if (last) {
                setTimeout(() => URL.revokeObjectURL(last), 1000);
            }
        };
    }, [conversationId, active]);

    return frame;
}

/**
 * Input events go out in order, one request at a time; what piles up meanwhile goes in the next one, with moves and
 * scrolls merged. An error shows once, not for every move.
 */
function useSender(conversationId) {
    const ref = useRef(null);

    if (ref.current?.conversationId !== conversationId) {
        let queue = [];
        let busy = false;
        let lastError = { message: "", at: 0 };

        const flush = async () => {
            if (busy || queue.length === 0) {
                return;
            }

            busy = true;
            const events = queue;

            queue = [];

            try {
                await api(`c/${conversationId}/browser/input`, { events });
            } catch (error) {
                queue = [];

                if (error.message !== lastError.message || Date.now() - lastError.at > 5000) {
                    notify("error", error.message);
                }

                lastError = { message: error.message, at: Date.now() };
            }

            busy = false;
            flush();
        };

        const send = (event) => {
            const last = queue.at(-1);

            if (
                last &&
                event.type === "mouse" &&
                event.action === "move" &&
                last.type === "mouse" &&
                last.action === "move" &&
                Boolean(last.pressed) === Boolean(event.pressed)
            ) {
                queue[queue.length - 1] = event;
            } else if (last && event.type === "wheel" && last.type === "wheel") {
                last.dx += event.dx;
                last.dy += event.dy;
            } else {
                queue.push(event);
            }

            flush();
        };

        ref.current = { conversationId, send };
    }

    return ref.current.send;
}

/** Keys the app keeps even while the page has the keyboard: the launcher, the sidebar, and Alt shortcuts. */
function appKey(event) {
    const mod = event.ctrlKey || event.metaKey;

    if (mod && !event.altKey && ["k", "b"].includes(event.key.toLowerCase())) {
        return true;
    }

    return (
        event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        /^(Digit[1-9]|ArrowUp|ArrowDown|KeyN|KeyB)$/.test(event.code)
    );
}

/** The page itself: a frame to look at, which takes taps, drags, the wheel, and (once focused) the keyboard. */
function Screen({ frame, interactive, send }) {
    const ref = useRef(null);
    const drag = useRef(null);
    const lastDown = useRef({ at: 0, x: 0, y: 0, count: 0 });
    const size = useRef(frame);

    size.current = frame;

    const toPage = (event) => {
        const box = ref.current.getBoundingClientRect();
        const { width, height } = size.current;

        return {
            x: Math.round(
                Math.min(width, Math.max(0, ((event.clientX - box.left) / box.width) * width)),
            ),
            y: Math.round(
                Math.min(height, Math.max(0, ((event.clientY - box.top) / box.height) * height)),
            ),
        };
    };

    const scale = () => size.current.width / ref.current.getBoundingClientRect().width;

    // The wheel scrolls the page, not the app: a listener that may prevent the default.
    useEffect(() => {
        const element = ref.current;

        if (!element || !interactive) {
            return undefined;
        }

        const wheel = (event) => {
            event.preventDefault();
            const unit =
                event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? size.current.height : 1;

            send({
                type: "wheel",
                ...toPage(event),
                dx: event.deltaX * unit,
                dy: event.deltaY * unit,
            });
        };

        element.addEventListener("wheel", wheel, { passive: false });

        return () => element.removeEventListener("wheel", wheel);
    }, [interactive, send]);

    if (!interactive) {
        return html`<img
            class="browser-screen"
            src=${frame.src}
            alt="The page"
            draggable="false"
        />`;
    }

    const down = (event) => {
        ref.current.focus({ preventScroll: true });
        const at = toPage(event);

        ref.current.setPointerCapture?.(event.pointerId);

        if (event.pointerType === "mouse") {
            if (event.button !== 0) {
                return;
            }

            event.preventDefault();
            const previous = lastDown.current;
            const count =
                Date.now() - previous.at < 400 &&
                Math.hypot(at.x - previous.x, at.y - previous.y) < 6
                    ? Math.min(previous.count + 1, 3)
                    : 1;

            lastDown.current = { at: Date.now(), ...at, count };
            drag.current = { mouse: true, count };
            send({ type: "mouse", action: "down", ...at, count });

            return;
        }

        drag.current = {
            startX: event.clientX,
            startY: event.clientY,
            lastX: event.clientX,
            lastY: event.clientY,
            at,
            scrolling: false,
        };
    };

    const move = (event) => {
        if (event.pointerType === "mouse") {
            send({
                type: "mouse",
                action: "move",
                ...toPage(event),
                ...(drag.current?.mouse ? { pressed: true } : {}),
            });

            return;
        }

        const touch = drag.current;

        if (!touch || touch.mouse) {
            return;
        }

        if (
            !touch.scrolling &&
            Math.hypot(event.clientX - touch.startX, event.clientY - touch.startY) > 8
        ) {
            touch.scrolling = true;
        }

        if (!touch.scrolling) {
            return;
        }

        const by = scale();

        send({
            type: "wheel",
            ...touch.at,
            dx: (touch.lastX - event.clientX) * by,
            dy: (touch.lastY - event.clientY) * by,
        });
        touch.lastX = event.clientX;
        touch.lastY = event.clientY;
    };

    const up = (event) => {
        const held = drag.current;

        drag.current = null;

        if (!held) {
            return;
        }

        if (held.mouse) {
            send({ type: "mouse", action: "up", ...toPage(event), count: held.count });
        } else if (!held.scrolling) {
            send({ type: "click", ...held.at });
        }
    };

    const key = (event) => {
        if (event.isComposing || appKey(event)) {
            return;
        }

        // Pasting is this device's clipboard: let the paste event come, and send its text.
        if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "v") {
            return;
        }

        event.preventDefault();
        event.stopPropagation();
        // AltGr (Ctrl+Alt on Windows layouts) and Option on a Mac type characters such as @ and €: text, not shortcuts.
        const option = APPLE && event.altKey && !event.ctrlKey && !event.metaKey;

        if (
            event.key.length === 1 &&
            (option || event.getModifierState?.("AltGraph") || (event.ctrlKey && event.altKey))
        ) {
            send({ type: "text", text: event.key });

            return;
        }

        const modifiers =
            (event.altKey ? 1 : 0) |
            (event.ctrlKey ? 2 : 0) |
            (event.metaKey ? 4 : 0) |
            (event.shiftKey ? 8 : 0);

        send({ type: "key", key: event.key, modifiers });
    };

    const paste = (event) => {
        const text = event.clipboardData?.getData("text") ?? "";

        if (text === "") {
            return;
        }

        event.preventDefault();
        send({ type: "text", text });
    };

    return html`<img
        ref=${ref}
        class="browser-screen live"
        src=${frame.src}
        alt="The page. Click to use it; once focused, keys go to the page."
        tabindex="0"
        draggable="false"
        onPointerDown=${down}
        onPointerMove=${move}
        onPointerUp=${up}
        onPointerCancel=${() => (drag.current = null)}
        onContextMenu=${(event) => event.preventDefault()}
        onKeyDown=${key}
        onPaste=${paste}
    />`;
}

/**
 * Text for the page on touch screens, whose keyboards only open for a text field of the app's own. It stays in the page
 * while hidden: iOS opens the keyboard only for a field focused during the tap that shows it.
 */
function TypeBar({ send, onClose, input, shown }) {
    const submit = (event) => {
        event.preventDefault();
        const text = input.current.value;

        if (text !== "") {
            send({ type: "text", text });
        }

        input.current.value = "";
    };

    return html`<form
        class=${`browser-type ${shown ? "" : "hidden"}`}
        aria-hidden=${shown ? "false" : "true"}
        onSubmit=${submit}
    >
        <input
            ref=${input}
            tabindex=${shown ? "0" : "-1"}
            placeholder=${t("Type into the page…")}
            autocapitalize="off"
            autocomplete="off"
            autocorrect="off"
            spellcheck="false"
            enterkeyhint="send"
        />
        <button type="submit" class="button small">${t("Send")}</button>
        <button
            type="button"
            class="key"
            title=${t("Enter")}
            onClick=${() => send({ type: "key", key: "Enter" })}
        >
            ⏎
        </button>
        <button
            type="button"
            class="key"
            title=${t("Backspace")}
            onClick=${() => send({ type: "key", key: "Backspace" })}
        >
            ⌫
        </button>
        <button
            type="button"
            class="key"
            title=${t("Tab")}
            onClick=${() => send({ type: "key", key: "Tab" })}
        >
            ⇥
        </button>
        <button
            type="button"
            class="icon-button small"
            aria-label=${t("Close the keyboard bar")}
            onClick=${onClose}
        >
            <${Icon} name="close" size=${14} />
        </button>
    </form>`;
}

/** The page's console: logs, errors, failed loads, and dialogs, with a line where each page began. */
function ConsolePane({ conversationId, logs, steer, onClose }) {
    const [entries, setEntries] = useState(null);
    const list = useRef(null);
    const pending = useRef(null);
    const mounted = useRef(true);

    useEffect(
        () => () => {
            mounted.current = false;
            clearTimeout(pending.current);
        },
        [],
    );
    // A page that logs all the time changes this often: fetch at most every 400 ms, never waiting for it to stop.
    useEffect(() => {
        if (pending.current) {
            return;
        }

        pending.current = setTimeout(
            () => {
                pending.current = null;
                api(`c/${conversationId}/browser/console`).then(
                    (data) => mounted.current && setEntries(data.entries),
                    () => mounted.current && setEntries([]),
                );
            },
            entries === null ? 0 : 400,
        );
    }, [conversationId, logs]);
    useEffect(() => {
        const element = list.current;

        if (element) {
            element.scrollTop = element.scrollHeight;
        }
    }, [entries]);
    const source = (text) => text?.replace(/^https?:\/\/[^/]+/, "");

    return html`<section class="browser-console" aria-label=${t("Console")}>
        <header>
            <strong>${t("Console")}</strong>
            <span class="muted small">
                ${entries ? `${entries.filter((entry) => entry.level !== "nav").length} lines` : ""}
            </span>
            <span class="spacer"></span>
            ${
                steer &&
                html`<button class="link" onClick=${() => attempt(() => browserApi("clear", {}))}>
                    ${t("Clear")}
                </button>`
            }
            <button class="icon-button small" aria-label=${t("Close the console")} onClick=${onClose}>
                <${Icon} name="close" size=${14} />
            </button>
        </header>
        <div class="browser-console-lines mono" ref=${list}>
            ${
                entries === null
                    ? html`<div class="muted small">${t("Loading…")}</div>`
                    : entries.length === 0
                      ? html`<div class="muted small">
                          ${t("Nothing yet. Logs, errors, and failed loads show here.")}
                      </div>`
                      : entries.map((entry) =>
                            entry.level === "nav"
                                ? html`<div key=${entry.seq} class="console-nav">
                                    ${displayUrl(entry.text) || entry.text}
                                </div>`
                                : html`<div key=${entry.seq} class=${`console-line ${entry.level}`}>
                                    <span class="console-text">${entry.text}</span>
                                    ${
                                        entry.source &&
                                        html`<span class="console-source">
                                            ${source(entry.source)}
                                        </span>`
                                    }
                                </div>`,
                        )
            }
        </div>
    </section>`;
}

/** What shows on a blank page: where to go, with the web servers running on this machine. */
function StartScreen({ steer }) {
    const [servers, setServers] = useState(null);
    const owner = store.state.me?.role === "owner";

    useEffect(() => {
        if (!owner) {
            return;
        }

        browserApi("servers").then(
            (data) => setServers(data.servers),
            () => setServers([]),
        );
    }, []);

    return html`<div class="browser-start">
        <${Icon} name="globe" size=${28} />
        <p>
            ${steer ? t("Type an address above, such as {{address}}, or ask Pi to open one.", { address: "localhost:5173" }) : t("Nothing is open yet. Pi, or someone who can steer, opens pages here.")}
        </p>
        ${owner && servers === null && html`<${Spinner} label=${t("Looking for servers")} />`}
        ${
            servers?.length > 0 &&
            html`<div class="browser-servers">
                <div class="muted small">${t("Running on this machine")}</div>
                ${servers.slice(0, 8).map(
                    (server) => html`<button
                        key=${server.port}
                        class="chip"
                        onClick=${() => openInBrowser(server.url)}
                    >
                        <span class="mono">localhost:${server.port}</span>
                        ${server.title && html`<span class="muted"> · ${server.title}</span>`}
                    </button>`,
                )}
            </div>`
        }
    </div>`;
}

/** Drag the panel's left edge to resize it on wide screens; double-click goes back to half. */
function ResizeEdge() {
    const start = (event) => {
        if (event.button !== 0) {
            return;
        }

        event.preventDefault();
        const root = document.documentElement;
        const right = event.currentTarget.parentElement.getBoundingClientRect().right;
        let width = 0;

        root.classList.add("resizing");

        const move = (each) => {
            width = Math.round(Math.min(innerWidth - 420, Math.max(360, right - each.clientX)));
            root.style.setProperty("--browser-w", `${width}px`);
        };

        const stop = () => {
            root.classList.remove("resizing");
            removeEventListener("pointermove", move);
            removeEventListener("pointerup", stop);
            removeEventListener("pointercancel", stop);

            if (width > 0) {
                localStorage.setItem(WIDTH_KEY, String(width));
            }
        };

        addEventListener("pointermove", move);
        addEventListener("pointerup", stop);
        addEventListener("pointercancel", stop);
    };

    const reset = () => {
        localStorage.removeItem(WIDTH_KEY);
        document.documentElement.style.removeProperty("--browser-w");
    };

    return html`<div
        class="resize-handle browser-resize"
        role="separator"
        aria-orientation="vertical"
        title=${t("Drag to resize")}
        onPointerDown=${start}
        onDblClick=${reset}
    ></div>`;
}

const savedWidth = Number(localStorage.getItem(WIDTH_KEY));

if (savedWidth > 0) {
    document.documentElement.style.setProperty("--browser-w", `${savedWidth}px`);
}

/** The page may close again after it opens (a crash, a long while unused): open it by itself at most this often. */
const REOPEN_MS = 2 * 60_000;

export function BrowserPanel({ leaving = false }) {
    const { conversationId, browser: state, me, view } = store.state;
    // Using the page takes what steering Pi takes: while take turns is on, the wheel.
    const turns = view.turns;
    const steer = canSteer() && (!turns?.on || turns.driver === me?.id);
    const visible = useVisible();
    const open = state?.open === true;
    const frame = useFrames(conversationId, open && visible);
    const send = useSender(conversationId);
    const [address, setAddress] = useState(null);
    const [showConsole, setShowConsole] = useState(false);
    const [typing, setTyping] = useState(false);
    const [problem, setProblem] = useState(null);
    const [tries, setTries] = useState(0);
    const opened = useRef(0);
    const wasOpen = useRef(false);
    const stageRef = useRef(null);
    const typeInput = useRef(null);

    // Over the conversation, back closes the panel.
    useBack(!panelsBeside() && !leaving, () => setBrowserOpen(false));

    if (open) {
        wasOpen.current = true;
    }

    // Open the page when the panel shows in a tab in front, and again after it closed (a restart), but not over and over:
    // a page that closes again soon after waits for a tap.
    const waiting = !open && wasOpen.current && Date.now() - opened.current < REOPEN_MS;

    useEffect(() => {
        if (!state || open || !steer || !state.available || !visible) {
            return;
        }

        if (Date.now() - opened.current < REOPEN_MS) {
            return;
        }

        opened.current = Date.now();
        setProblem(null);
        // The size of a page that has none yet: a phone's, or the panel's.
        const phone = matchMedia("(max-width: 700px)").matches;
        const viewport = phone ? "mobile" : stageRef.current && fitViewport(stageRef.current);

        browserApi("open", viewport ? { viewport } : {}).catch((error) =>
            setProblem(error.message),
        );
    }, [conversationId, open, state?.available, steer, visible, tries]);

    const retry = () => {
        opened.current = 0;
        wasOpen.current = false;
        setProblem(null);
        store.set({ browser: { ...state, problem: undefined } });
        setTries(tries + 1);
    };

    const go = (event) => {
        event.preventDefault();
        const url = (address ?? "").trim();

        if (url === "") {
            return;
        }

        setAddress(null);
        event.currentTarget.querySelector("input")?.blur();
        attempt(() => browserApi("navigate", { url }).then(reportNavigation));
    };

    const run = (action, body = {}) => attempt(() => browserApi(action, body));
    // A size that is no preset is a fitted (or Pi's own) one.
    const preset = PRESETS.find((each) => each.id === (state?.preset ?? "fit"));
    const nextPreset = PRESETS[(PRESETS.indexOf(preset) + 1) % PRESETS.length];

    const resize = () => {
        const viewport =
            nextPreset.id === "fit"
                ? stageRef.current && fitViewport(stageRef.current)
                : nextPreset.id;

        if (viewport) {
            run("viewport", { viewport });
        }
    };

    const blank = open && (state.url === "" || state.url === "about:blank");
    const touch = matchMedia("(pointer: coarse)").matches;
    const why = problem ?? state?.problem;

    let stage;

    if (!state) {
        stage = html`<div class="browser-note"><${Spinner} /></div>`;
    } else if (!state.available) {
        stage = html`<div class="browser-note">
            <${Icon} name="globe" size=${28} />
            <p>
                No browser was found on the machine Pi Pocket runs on. Install Chromium or Google Chrome there (or set <code>PI_POCKET_BROWSER</code> to a browser's path), then restart Pi Pocket.
            </p>
        </div>`;
    } else if (!open && why) {
        stage = html`<div class="browser-note">
            <p>${why}</p>
            ${steer && html`<button class="button small" onClick=${retry}>${t("Try again")}</button>`}
        </div>`;
    } else if (!open && !steer) {
        stage = html`<div class="browser-note"><${StartScreen} steer=${false} /></div>`;
    } else if (waiting) {
        stage = html`<div class="browser-note">
            <p>${t("The page closed.")}</p>
            <button class="button small" onClick=${retry}>${t("Open it again")}</button>
        </div>`;
    } else if (!open || !frame) {
        stage = html`<div class="browser-note">
            <${Spinner} label=${t("Starting the browser")} />
            <span class="muted small">${t("Starting the browser…")}</span>
        </div>`;
    } else {
        stage = html`<div class="browser-frame">
            <${Screen} frame=${frame} interactive=${steer} send=${send} />
            ${blank && html`<${StartScreen} steer=${steer} />`}
            ${
                state.problem &&
                html`<div class="browser-crashed">
                    <span>${state.problem}</span>
                    ${
                        steer &&
                        html`<button class="button small" onClick=${() => run("reload")}>
                            ${t("Reload")}
                        </button>`
                    }
                </div>`
            }
        </div>`;
    }

    return html`<section
        class=${`browser window ${leaving ? "leaving" : ""}`}
        aria-label=${t("Browser")}
        inert=${leaving}
    >
        <${ResizeEdge} />
        <header class="browser-bar">
            <button
                class="icon-button"
                aria-label=${t("Back")}
                title=${t("Back")}
                disabled=${!steer || !state?.canGoBack}
                onClick=${() => run("back")}
            >
                <${Icon} name="back" size=${18} />
            </button>
            <button
                class="icon-button browser-forward"
                aria-label=${t("Forward")}
                title=${t("Forward")}
                disabled=${!steer || !state?.canGoForward}
                onClick=${() => run("forward")}
            >
                <${Icon} name="chevron" size=${18} />
            </button>
            ${
                state?.loading && open
                    ? html`<button
                        class="icon-button"
                        aria-label=${t("Stop loading")}
                        title=${t("Stop")}
                        disabled=${!steer}
                        onClick=${() => run("stop")}
                    >
                        <${Icon} name="close" size=${18} />
                    </button>`
                    : html`<button
                        class="icon-button"
                        aria-label=${t("Reload")}
                        title=${t("Reload")}
                        disabled=${!steer || !open}
                        onClick=${() => run("reload")}
                    >
                        <${Icon} name="reload" size=${18} />
                    </button>`
            }
            <form class="browser-address" onSubmit=${go}>
                <input
                    value=${address ?? displayUrl(state?.url)}
                    placeholder=${steer ? "Address, such as localhost:5173" : ""}
                    title=${state?.title || state?.url || ""}
                    readonly=${!steer}
                    autocapitalize="off"
                    autocomplete="off"
                    autocorrect="off"
                    spellcheck="false"
                    enterkeyhint="go"
                    inputmode="url"
                    onFocus=${(event) => {
                        setAddress(event.currentTarget.value);
                        event.currentTarget.select();
                    }}
                    onInput=${(event) => setAddress(event.currentTarget.value)}
                    onBlur=${() => setTimeout(() => setAddress(null), 150)}
                    onKeyDown=${(event) => {
                        if (event.key === "Escape") {
                            event.currentTarget.blur();
                        }
                    }}
                />
            </form>
            <button
                class="icon-button"
                aria-label=${`Size: ${preset.id === "fit" ? `${state?.viewport?.width ?? ""}×${state?.viewport?.height ?? ""}` : preset.label}. Switch to ${nextPreset.label}`}
                title=${`${preset.id === "fit" ? `${state?.viewport?.width}×${state?.viewport?.height}` : preset.label} · tap for ${nextPreset.label}`}
                disabled=${!steer || !open}
                onClick=${resize}
            >
                <${Icon} name=${preset.icon} size=${18} />
            </button>
            <button
                class=${`icon-button badge-host ${showConsole ? "on" : ""}`}
                aria-label=${t("Console")}
                title=${t("Console")}
                onClick=${() => setShowConsole(!showConsole)}
            >
                <${Icon} name="terminal" size=${18} />
                ${
                    state?.errors > 0 &&
                    html`<span class="badge err">${state.errors > 99 ? "99+" : state.errors}</span>`
                }
            </button>
            ${
                steer &&
                touch &&
                open &&
                html`<button
                    class=${`icon-button ${typing ? "on" : ""}`}
                    aria-label=${t("Type into the page")}
                    title=${t("Type into the page")}
                    onClick=${() => {
                        setTyping(!typing);

                        // Focused in the tap itself, so the phone's keyboard opens; let go of, so it closes.
                        if (typing) {
                            typeInput.current?.blur();
                        } else {
                            typeInput.current?.focus();
                        }
                    }}
                >
                    <${Icon} name="keyboard" size=${18} />
                </button>`
            }
            <button
                class="icon-button browser-close"
                aria-label=${t("Close the browser")}
                title=${t("Close the browser (Alt+B)")}
                onClick=${() => setBrowserOpen(false)}
            >
                <${Icon} name="close" size=${18} />
            </button>
        </header>
        <div class=${`browser-progress ${state?.loading ? "on" : ""}`}></div>
        <div class="browser-stage" ref=${stageRef}>${stage}</div>
        ${
            steer &&
            touch &&
            open &&
            html`<${TypeBar}
                send=${send}
                input=${typeInput}
                shown=${typing}
                onClose=${() => {
                    typeInput.current?.blur();
                    setTyping(false);
                }}
            />`
        }
        ${
            showConsole &&
            html`<${ConsolePane}
                conversationId=${conversationId}
                logs=${state?.logs ?? 0}
                steer=${steer}
                onClose=${() => setShowConsole(false)}
            />`
        }
        ${
            me &&
            !steer &&
            open &&
            html`<div class="browser-foot muted small">
                ${canSteer() ? "Take turns is on: the driver uses the page." : "You can watch; people who can steer use the page."}
            </div>`
        }
    </section>`;
}

/** The top bar's button: shows and hides the panel, marked while a page is open. */
export function BrowserButton() {
    const { browser: state, browserOpen } = store.state;

    if (!browserAvailable()) {
        return null;
    }

    const live = state?.open && state.url !== "" && state.url !== "about:blank";

    // Quiet with no page open: the menu has the browser. On a phone a page open is a dot on the places button (by the
    // message box) instead, so the top bar keeps room.
    return html`<button
        class=${`icon-button badge-host ${browserOpen ? "on" : live ? "quiet-phone" : "quiet"}`}
        aria-label=${t("Browser")}
        title=${t("Browser (Alt+B)")}
        onClick=${toggleBrowser}
    >
        <${Icon} name="globe" />
        ${live && html`<span class="browser-dot" aria-hidden="true"></span>`}
    </button>`;
}
