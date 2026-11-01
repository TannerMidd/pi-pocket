// What an artifact's page may ask of the app, through `parent.postMessage`: put a follow-up in the person's message
// box, for them to review and send (#88); and load or save a small JSON value of its own, for that person (#89). The
// page keeps its sandbox: it never gets the app, its cookies, or a way to make Pi act. Only the frame's first page is
// heard (over a channel it opens as it starts), only while its session shows, and the app's rights decide, not the page.
//
// Design mode (`docs/design/design-mode.md`) adds a line the other way, for the workspace: `send` puts the app's
// messages to a frame (inspect, text edit, tweaks, pins, goto), and `onMessage` hears what the frame's inspector says
// (a pick, a text edit, the tweaks manifest, a deck's slides). The page's own script cannot send those four: they come
// from the inspector (`src/server/http/artifact-inspect.ts`) down the line, and the app checks their shape and length
// (`checkPageMessage`) before it hands them on as data.
import { useLayoutEffect, useRef } from "preact/hooks";
import { api, canSteer, insertIntoComposer, notify, store } from "./store.js";

/** The most a follow-up's text and its selection (as JSON) may take, and how often a frame may send one. */
const TEXT_MAX = 2000;
const SELECTION_MAX = 2000;
const FOLLOW_UP_MS = 2000;
const REQUEST_ID = /^[\w.:-]{1,64}$/;

/**
 * A follow-up as it goes into the box: what it is from first, so the box never takes it for a command (`!`, `/`), then
 * the page's words, then its selection as data.
 */
export function followUpText(text, selection, source) {
    const from = `From ${source}:`;

    if (selection === undefined) {
        return `${from}\n${text}`;
    }

    // A fence longer than any run of backticks in the selection: nothing in it can end the fence early.
    const json = JSON.stringify(selection, null, 2);
    const fence = "`".repeat(
        Math.max(3, ...(json.match(/`+/g) ?? []).map((run) => run.length + 1)),
    );

    return `${from}\n${text}\n\n${fence}json\n${json}\n${fence}`;
}

/** Why a follow-up cannot go in, or null when it can: its text and selection, checked. */
export function followUpProblem(data) {
    if (typeof data.text !== "string" || data.text.trim() === "") {
        return "A follow-up needs text";
    }

    if (data.text.length > TEXT_MAX) {
        return `A follow-up's text is up to ${TEXT_MAX} characters`;
    }

    if (data.selection !== undefined) {
        let json;

        try {
            json = JSON.stringify(data.selection);
        } catch {
            return "A selection is JSON";
        }

        if (json === undefined || json.length > SELECTION_MAX) {
            return `A selection is JSON, up to ${SELECTION_MAX} characters`;
        }
    }

    return null;
}

/** How many pages each frame has loaded: only a frame that has not loaded one yet may still say hello. */
const loads = new WeakMap();

// Loads do not bubble, but they pass through the document on their way down to each frame.
addEventListener(
    "load",
    (event) => {
        if (event.target instanceof HTMLIFrameElement) {
            loads.set(event.target, (loads.get(event.target) ?? 0) + 1);
        }
    },
    true,
);

/** The pages using the bridge now: `{ ref, handle(frame, data), ready(frame) }`. */
const hooks = new Set();
/** The line to each frame's first page: a `MessagePort` that page gave us when it started. */
const ports = new WeakMap();
/** What the app said to a frame before its page opened the line: the newest of each kind, sent once it does. */
const waiting = new WeakMap();

const hookOf = (frame) => [...hooks].find((hook) => hook.ref.current === frame);

// ─── Design mode: the messages, and their checks ─────────────────────────────────────────────────────────────────────

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value, max) => typeof value === "string" && value.length <= max;
const isCount = (value, max) => Number.isInteger(value) && value >= 0 && value <= max;
const isNumber = (value) =>
    typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1e7;
const clip = (value, max) => (typeof value === "string" ? value.slice(0, max) : undefined);

/** The most a tweak, a pin, and the like may take, as the page side keeps to them (`artifact-inspect.ts`). */
export const LIMITS = {
    selector: 500,
    pid: 200,
    text: 200,
    html: 1000,
    style: 200,
    edit: 2000,
    knobs: 40,
    options: 50,
    tweakValues: 100,
    pins: 100,
    slides: 1000,
};
const STYLE_KEYS = [
    "color",
    "background-color",
    "font-family",
    "font-size",
    "font-weight",
    "line-height",
    "padding",
    "margin",
    "border-radius",
    "gap",
];
const KNOB_TYPES = ["range", "color", "select", "toggle", "text"];
const TAG = /^[a-z][a-z0-9-]{0,39}$/i;
const CSS_VARIABLE = /^--[A-Za-z0-9_-]{1,78}$/;

/**
 * A page's `Target`, rebuilt from the fields it may have: `{ pid?, selector, tag, text, html, rect, styles }`. Text and
 * html are cut to their limits; a selector that is too long or a field of the wrong kind makes it null.
 */
export function checkTarget(raw) {
    if (
        !isRecord(raw) ||
        typeof raw.selector !== "string" ||
        raw.selector === "" ||
        raw.selector.length > LIMITS.selector ||
        typeof raw.tag !== "string" ||
        !TAG.test(raw.tag) ||
        typeof raw.text !== "string" ||
        typeof raw.html !== "string" ||
        !isRecord(raw.rect) ||
        !["x", "y", "width", "height"].every((key) => isNumber(raw.rect[key]))
    ) {
        return null;
    }

    const styles = {};

    for (const key of STYLE_KEYS) {
        if (isRecord(raw.styles) && typeof raw.styles[key] === "string") {
            styles[key] = clip(raw.styles[key], LIMITS.style);
        }
    }

    const target = {
        selector: raw.selector,
        tag: raw.tag.toLowerCase(),
        text: clip(raw.text, LIMITS.text),
        html: clip(raw.html, LIMITS.html),
        rect: { x: raw.rect.x, y: raw.rect.y, width: raw.rect.width, height: raw.rect.height },
        styles,
    };

    if (typeof raw.pid === "string" && raw.pid !== "") {
        target.pid = clip(raw.pid, LIMITS.pid);
    }

    return target;
}

/** A knob of the page's tweaks manifest, or null: `{ name, label?, type, value, min?, max?, step?, unit?, options? }`. */
function checkKnob(raw) {
    if (
        !isRecord(raw) ||
        !isText(raw.name, 80) ||
        raw.name === "" ||
        !KNOB_TYPES.includes(raw.type) ||
        !(isText(raw.value, LIMITS.style) || typeof raw.value === "boolean" || isNumber(raw.value))
    ) {
        return null;
    }

    const knob = { name: raw.name, type: raw.type, value: raw.value };

    if (isText(raw.label, 80)) {
        knob.label = raw.label;
    }

    for (const key of ["min", "max", "step"]) {
        if (isNumber(raw[key])) {
            knob[key] = raw[key];
        }
    }

    if (isText(raw.unit, 10)) {
        knob.unit = raw.unit;
    }

    if (Array.isArray(raw.options)) {
        knob.options = raw.options.filter((option) => isText(option, 80)).slice(0, LIMITS.options);
    }

    return knob;
}

/**
 * What the frame's inspector said, as clean data the app may use, or null when it is not one of the messages or
 * has the wrong shape. A new object is built from the known fields only, whatever else the message had.
 */
export function checkPageMessage(data) {
    if (!isRecord(data)) {
        return null;
    }

    switch (data.type) {
        case "pocket-picked": {
            const target = checkTarget(data.target);

            return target && { type: data.type, target };
        }

        case "pocket-text-edited": {
            const target = checkTarget(data.target);

            return target && isText(data.before, LIMITS.edit) && isText(data.after, LIMITS.edit)
                ? { type: data.type, target, before: data.before, after: data.after }
                : null;
        }

        case "pocket-tweaks": {
            if (!Array.isArray(data.knobs)) {
                return null;
            }

            const seen = new Set();
            const knobs = data.knobs
                .slice(0, LIMITS.knobs)
                .map(checkKnob)
                .filter((knob) => {
                    if (knob === null || seen.has(knob.name)) {
                        return false;
                    }

                    seen.add(knob.name);

                    return true;
                });

            return { type: data.type, knobs };
        }

        case "pocket-pin": {
            const rect = data.rect;
            const finite = (value) =>
                typeof value === "number" && Number.isFinite(value) && Math.abs(value) < 1e6;

            if (!isText(data.label, 8)) {
                return null;
            }

            if (isRecord(rect)) {
                return finite(rect.x) && finite(rect.y) && finite(rect.width) && finite(rect.height)
                    ? {
                          type: data.type,
                          label: data.label,
                          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
                      }
                    : null;
            }

            return data.tap === true ? { type: data.type, label: data.label, tap: true } : null;
        }

        case "pocket-size":
            // 0: the page was too big to measure.
            return isCount(data.height, 100_000) ? { type: data.type, height: data.height } : null;

        case "pocket-deck":
            return isCount(data.slides, LIMITS.slides) &&
                isCount(data.current, Math.max(data.slides - 1, 0))
                ? { type: data.type, slides: data.slides, current: data.current }
                : null;

        default:
            return null;
    }
}

/** The one reason a message to a page is refused, or a clean copy of it: `{ message }` or `{ error }`. */
export function checkAppMessage(raw) {
    if (!isRecord(raw)) {
        return { error: "A message is an object" };
    }

    switch (raw.type) {
        case "pocket-inspect":
        case "pocket-edit-text":
            return typeof raw.on === "boolean"
                ? { message: { type: raw.type, on: raw.on } }
                : { error: "`on` is true or false" };

        case "pocket-tweak-set": {
            if (!isRecord(raw.values)) {
                return { error: "`values` is an object" };
            }

            const names = Object.keys(raw.values);

            if (names.length > LIMITS.tweakValues) {
                return { error: `At most ${LIMITS.tweakValues} values` };
            }

            const values = {};

            for (const name of names) {
                const value = raw.values[name];

                if (
                    name === "" ||
                    name.length > 80 ||
                    (name.startsWith("--") && !CSS_VARIABLE.test(name)) ||
                    !(
                        value === null ||
                        isText(value, LIMITS.style) ||
                        typeof value === "boolean" ||
                        isNumber(value)
                    )
                ) {
                    return { error: `Not a tweak value: ${name.slice(0, 40)}` };
                }

                values[name] = value;
            }

            return { message: { type: raw.type, values } };
        }

        case "pocket-highlight": {
            if (!Array.isArray(raw.targets) || raw.targets.length > LIMITS.pins) {
                return { error: `\`targets\` is a list of up to ${LIMITS.pins}` };
            }

            const targets = [];

            for (const target of raw.targets) {
                if (
                    !isRecord(target) ||
                    !isText(target.selector, LIMITS.selector) ||
                    (target.pid !== undefined && !isText(target.pid, LIMITS.pid)) ||
                    (target.reveal !== undefined && typeof target.reveal !== "boolean") ||
                    !(
                        target.label === undefined ||
                        isText(target.label, 8) ||
                        isCount(target.label, 99_999)
                    )
                ) {
                    return { error: "A pin needs a selector (and a short label, if any)" };
                }

                const pin = { selector: target.selector };

                if (target.pid !== undefined) {
                    pin.pid = target.pid;
                }

                if (target.label !== undefined) {
                    pin.label = target.label;
                }

                if (target.reveal === true) {
                    pin.reveal = true;
                }

                targets.push(pin);
            }

            return { message: { type: raw.type, targets } };
        }

        case "pocket-goto":
            return isCount(raw.slide, LIMITS.slides)
                ? { message: { type: raw.type, slide: raw.slide } }
                : { error: "`slide` is a number from 0" };

        default:
            return { error: "Not a message for a page" };
    }
}

/** A message to a page that waits for its line keeps only the newest of its kind; tweak values add up. */
function queue(frame, message) {
    const held = waiting.get(frame) ?? new Map();
    const before = held.get(message.type);

    if (message.type === "pocket-tweak-set" && before) {
        message = { ...message, values: { ...before.values, ...message.values } };
    }

    held.delete(message.type);
    held.set(message.type, message);
    waiting.set(frame, held);
}

/**
 * Say `message` to the page in `frame` (a design message: `checkAppMessage`). True when it went down the line, or waits
 * for the line to open (the frame has not loaded a page yet); false when it is refused or nobody can hear it.
 */
export function sendToFrame(frame, message, { wait = true } = {}) {
    const { message: clean } = checkAppMessage(message);
    const hook = frame && hookOf(frame);

    if (!clean || !hook) {
        return false;
    }

    if (
        (clean.type === "pocket-inspect" || clean.type === "pocket-edit-text") &&
        clean.on &&
        !canSteer()
    ) {
        return false;
    }

    const port = ports.get(frame);

    if (port) {
        port.postMessage(clean);

        return true;
    }

    if (!wait || (loads.get(frame) ?? 0) > 0) {
        return false;
    }

    queue(frame, clean);

    return true;
}

// The first page in a frame says hello as it starts (`ARTIFACT_BRIDGE` in `src/server/http/artifacts.ts`) and hands over
// one end of a channel. That channel is the only way in: a page the frame goes on to gets no line, so it is not heard,
// and an answer goes down the line, so it reaches no page but the first. Only a frame that is still on its first load
// and has no line yet is heard, and only while a page of the app uses the bridge for it.
addEventListener("message", (event) => {
    const hook = [...hooks].find((each) => each.ref.current?.contentWindow === event.source);
    const frame = hook?.ref.current;

    if (
        !frame ||
        event.data?.type !== "pocket-bridge" ||
        event.ports.length !== 1 ||
        ports.has(frame) ||
        (loads.get(frame) ?? 0) > 0
    ) {
        return;
    }

    const [port] = event.ports;

    ports.set(frame, port);

    port.onmessage = (message) => {
        const data = message.data;

        if (typeof data === "object" && data) {
            hookOf(frame)?.handle(frame, data);
        }
    };

    // What was said before the line opened goes first; then the workspace may say the rest.
    for (const held of waiting.get(frame)?.values() ?? []) {
        port.postMessage(held);
    }

    waiting.delete(frame);
    hook.ready(frame);
});

/** How many messages from one page the app hears in a second: the inspector sends when a person acts, so this is plenty. */
const RATE = 60;

/**
 * Hear the first page of the frame `ref`: follow-ups always, saved state only for an artifact (`artifact`, its id).
 * `source` names the page in the box ("the artifact “Plan”"). `enabled` is false for a page that has no bridge (SVG,
 * Markdown). The page asks with `parent.postMessage`, as a page does, but the frame page it starts with (`ARTIFACT_BRIDGE`)
 * takes the call, checks that a person tapped the page (a real tap, which the page cannot make), and sends it down the
 * line. A follow-up so reaches us only after a tap; a frame inside PiP's panel adds nothing to the session's box.
 *
 * Design mode (stream B) adds, in `settings` (read each time, so they may change):
 * - `onMessage(message, frame)`: a checked `pocket-picked`, `pocket-text-edited`, `pocket-tweaks`, or `pocket-deck`
 *   (`checkPageMessage`). Not for a viewer's frame in PiP's panel, nor once the session is another.
 * - `onReady(frame)`: the frame's page opened its line. Its page has just started: say the modes again.
 *
 * Returns `{ send(message), ready(), detach() }`. `send` is `sendToFrame` for this frame (see there); `ready` is true
 * once the page opened its line. Use it in a component with `useArtifactBridge`.
 */
export function attachBridge(ref, settings = {}) {
    const { artifact = null, source = "the page" } = settings;
    const conversationId = store.state.conversationId;
    let lastFollowUp = 0;
    let windowStart = 0;
    let heard = 0;

    const reply = (frame, fields) => ports.get(frame)?.postMessage(fields);

    const followUp = (frame, data) => {
        const answer = (fields) => reply(frame, { type: "pocket-follow-up", ...fields });
        const problem = followUpProblem(data);
        const now = Date.now();

        if (problem !== null) {
            return answer({ ok: false, error: problem });
        }

        if (store.state.conversationId !== conversationId || frame.closest(".pip-panel")) {
            return answer({ ok: false, error: "Not in this session" });
        }

        if (now - lastFollowUp < FOLLOW_UP_MS) {
            return answer({ ok: false, error: "Too soon" });
        }

        lastFollowUp = now;

        if (!canSteer()) {
            notify("info", `${capital(source)} offered a message, but you can only view here.`);

            return answer({ ok: false, error: "View only" });
        }

        insertIntoComposer(followUpText(data.text.trim(), data.selection, source));
        notify("info", `${capital(source)} added a message to your box: read it, then send it.`);
        answer({ ok: true });
    };

    const state = async (frame, data) => {
        const requestId = data.requestId;

        const answer = (fields) => {
            if (ref.current === frame) {
                reply(frame, { type: "pocket-state", requestId, ...fields });
            }
        };

        if (!REQUEST_ID.test(String(requestId ?? ""))) {
            return;
        }

        if (artifact === null) {
            return answer({ ok: false, error: "Only a saved artifact keeps state" });
        }

        if (store.state.conversationId !== conversationId) {
            return answer({ ok: false, error: "Not in this session" });
        }

        // The same for a get and a set: a schema is a string, or none.
        if (data.schema !== undefined && data.schema !== null && typeof data.schema !== "string") {
            return answer({ ok: false, error: "A schema is a string" });
        }

        const path = `c/${conversationId}/artifact-state/${encodeURIComponent(artifact)}`;

        try {
            if (data.type === "pocket-state-get") {
                const query = data.schema ? `?schema=${encodeURIComponent(data.schema)}` : "";
                const result = await api(`${path}${query}`);

                answer({ ok: true, state: result.state, at: result.at });
            } else {
                const result = await api(path, {
                    state: data.state ?? null,
                    schema: data.schema ?? undefined,
                });

                answer({ ok: true, at: result.at });
            }
        } catch (error) {
            answer({ ok: false, error: error.message ?? String(error) });
        }
    };

    const design = (frame, data) => {
        const now = Date.now();

        if (now - windowStart > 1000) {
            windowStart = now;
            heard = 0;
        }

        heard += 1;

        const message = heard <= RATE ? checkPageMessage(data) : null;

        if (
            message &&
            store.state.conversationId === conversationId &&
            !frame.closest(".pip-panel")
        ) {
            settings.onMessage?.(message, frame);
        }
    };

    const hook = {
        ref,
        handle: (frame, data) => {
            if (data.type === "pocket-follow-up") {
                followUp(frame, data);
            } else if (data.type === "pocket-state-get" || data.type === "pocket-state-set") {
                void state(frame, data);
            } else {
                design(frame, data);
            }
        },
        ready: (frame) => {
            if (store.state.conversationId === conversationId) {
                settings.onReady?.(frame);
            }
        },
    };

    hooks.add(hook);

    return {
        send: (message) => sendToFrame(ref.current, message),
        ready: () => Boolean(ref.current && ports.has(ref.current)),
        detach: () => hooks.delete(hook),
    };
}

/**
 * `attachBridge` for a component: `useArtifactBridge(ref, { artifact, source, enabled, onMessage, onReady })`. It
 * returns one `{ send, ready }` that stays the same between renders; `send` says no (false) while `enabled` is false.
 * The callbacks may change between renders; the bridge is made again only when `artifact`, `source`, or `enabled` do.
 */
export function useArtifactBridge(ref, settings) {
    const live = useRef({});
    const control = useRef(null);

    Object.assign(live.current, settings);

    if (control.current === null) {
        const attached = { current: null };

        control.current = {
            attached,
            api: {
                send: (message) => attached.current?.send(message) ?? false,
                ready: () => attached.current?.ready() ?? false,
            },
        };
    }

    const { artifact = null, source, enabled = true } = settings;

    useLayoutEffect(() => {
        if (!enabled) {
            return undefined;
        }

        // The settings are read live: a new callback needs no new line.
        const bridge = attachBridge(ref, {
            artifact,
            source,
            get onMessage() {
                return live.current.onMessage;
            },
            get onReady() {
                return live.current.onReady;
            },
        });

        control.current.attached.current = bridge;

        return () => {
            control.current.attached.current = null;
            bridge.detach();
        };
    }, [artifact, source, enabled]);

    return control.current.api;
}

const capital = (text) => text.charAt(0).toUpperCase() + text.slice(1);
