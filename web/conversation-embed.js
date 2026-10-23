// The public component owns only a frame. The native document owns the conversation and all actions.
import { useEffect, useRef, useState } from "preact/hooks";
import { html } from "./ui.js";
import { uid } from "./store.js";

export function Conversation({ conversationId, draft, title = "Conversation", onClose }) {
    const frame = useRef(null);
    const channel = useRef(uid()).current;
    const close = useRef(onClose);

    close.current = onClose;
    const [status, setStatus] = useState("Loading conversation…");
    const valid = Number.isSafeInteger(conversationId) && conversationId > 0;

    useEffect(() => {
        setStatus("Loading conversation…");

        if (!valid) {
            return undefined;
        }

        const receive = (event) => {
            if (
                event.origin !== location.origin ||
                event.source !== frame.current?.contentWindow ||
                event.data?.channel !== channel ||
                event.data.conversationId !== conversationId
            ) {
                return;
            }

            if (event.data.type === "pocket:conversation:ready") {
                setStatus("");
            } else if (
                event.data.type === "pocket:conversation:close" &&
                typeof close.current === "function"
            ) {
                close.current();
            }
        };

        addEventListener("message", receive);
        const timeout = setTimeout(
            () =>
                setStatus((value) =>
                    value ? "Conversation unavailable. Check your connection and access." : value,
                ),
            20000,
        );

        return () => {
            removeEventListener("message", receive);
            clearTimeout(timeout);
        };
    }, [conversationId, valid]);

    useEffect(() => {
        if (!status && typeof draft === "string" && draft.length <= 100000) {
            frame.current?.contentWindow?.postMessage(
                { type: "pocket:conversation:draft", channel, conversationId, draft },
                location.origin,
            );
        }
    }, [conversationId, draft, status]);

    if (!valid) {
        return html`<div class="error-box" role="alert">Give a positive, safe integer conversationId.</div>`;
    }

    return html`<div style="position:relative;display:flex;flex-direction:column;width:100%;height:100%;min-height:0;border:0">
        ${status && html`<div role="status" style="padding:12px">${status}</div>`}
        <iframe key=${conversationId} ref=${frame} title=${title} src=${`/s/${conversationId}?pocketEmbed=1&embedChannel=${encodeURIComponent(channel)}`} style="display:block;flex:1;width:100%;min-height:0;border:0" />
    </div>`;
}
