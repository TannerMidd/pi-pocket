// What an artifact's page may ask of the app, through `parent.postMessage`: put a follow-up in the person's message
// box, for them to review and send (#88); and load or save a small JSON value of its own, for that person (#89). The
// page keeps its sandbox: it never gets the app, its cookies, or a way to make Pi act. Only the frame's first page is
// heard (over a channel it opens as it starts), only while its session shows, and the app's rights decide, not the page.
import { useLayoutEffect } from "preact/hooks";
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

/** The pages using the bridge now: `{ ref, handle(frame, data) }`. */
const hooks = new Set();
/** The line to each frame's first page: a `MessagePort` that page gave us when it started. */
const ports = new WeakMap();

const hookOf = (frame) => [...hooks].find((hook) => hook.ref.current === frame);

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
});

/**
 * Hear the first page of the frame `ref`: follow-ups always, saved state only for an artifact (`artifact`, its id).
 * `source` names the page in the box ("the artifact “Plan”"). `enabled` is false for a page that has no bridge (SVG,
 * Markdown). The page asks with `parent.postMessage`, as a page does, but the frame page it starts with (`ARTIFACT_BRIDGE`)
 * takes the call, checks that a person tapped the page (a real tap, which the page cannot make), and sends it down the
 * line. A follow-up so reaches us only after a tap; a frame inside PiP's panel adds nothing to the session's box.
 */
export function useArtifactBridge(ref, { artifact = null, source, enabled = true }) {
    useLayoutEffect(() => {
        if (!enabled) {
            return undefined;
        }

        const conversationId = store.state.conversationId;
        let lastFollowUp = 0;

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
            notify(
                "info",
                `${capital(source)} added a message to your box: read it, then send it.`,
            );
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
            if (
                data.schema !== undefined &&
                data.schema !== null &&
                typeof data.schema !== "string"
            ) {
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

        const hook = {
            ref,
            handle: (frame, data) => {
                if (data.type === "pocket-follow-up") {
                    followUp(frame, data);
                } else if (data.type === "pocket-state-get" || data.type === "pocket-state-set") {
                    void state(frame, data);
                }
            },
        };

        hooks.add(hook);

        return () => hooks.delete(hook);
    }, [artifact, source, enabled]);
}

const capital = (text) => text.charAt(0).toUpperCase() + text.slice(1);
