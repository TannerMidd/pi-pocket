// A session waits for the person at its computer. Cancel ends the request, so the server withdraws its question.
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { addLayer, removeLayer } from "./back.js";
import { api, store } from "./store.js";
import { html, Spinner } from "./ui.js";

const WRONG = "That code is wrong or used. Try the next one.";

/** When this page first saw each question: its countdown starts there, and does not restart on a new render. */
const seen = new Map();

function seenAt(id) {
    if (!seen.has(id)) {
        seen.set(id, Date.now());
    }

    return seen.get(id);
}

/** The computer's question for a new session in `folder`, or its newest question when the path changed there. */
function questionFor(runner, folder) {
    const questions = runner?.questions ?? [];

    return questions.findLast((question) => question.folder === folder) ?? questions.at(-1);
}

/** A 6-digit authenticator code for one runner question. It is sent once and never kept here. */
export function ApprovalCode({ runner, question }) {
    const [code, setCode] = useState("");
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);

    // Owners see all computers; other people receive only the computers they may use.
    const permitted =
        store.state.me?.role === "owner"
            ? runner?.createdBy === store.state.me.id
            : store.state.runners.some((each) => each.id === runner?.id);

    if (!question?.totp || !permitted) {
        return null;
    }

    const send = async (event) => {
        event.preventDefault();
        setBusy(true);
        setError("");

        try {
            await api(`runners/${encodeURIComponent(runner.id)}/approval`, {
                id: question.id,
                code,
            });
            setCode("");
        } catch (failure) {
            setError(failure.message === WRONG ? WRONG : failure.message);
            setCode("");
        } finally {
            setBusy(false);
        }
    };

    return html`<form class="runner-code" onSubmit=${send}>
        <label class="field">
            <span class="label">Code from your authenticator</span>
            <input
                type="text"
                inputmode="numeric"
                autocomplete="one-time-code"
                pattern="[0-9]{6}"
                maxlength="6"
                value=${code}
                onInput=${(event) => setCode(event.currentTarget.value.replace(/\D/g, ""))}
            />
        </label>
        ${error && html`<p class="runner-code-error" role="alert">${error}</p>`}
        <button class="button primary" disabled=${busy || code.length !== 6}>Approve</button>
    </form>`;
}

/** The text and code field of a question on `computer`. */
function Approval({ computer, folder, question, since, cancel }) {
    const limit = question?.totp ? 300_000 : 120_000;
    const seconds = Math.max(0, Math.ceil((limit - (Date.now() - since)) / 1000));

    return html`<section
        class="runner-wait"
        role="dialog"
        aria-modal="true"
        aria-labelledby="runner-wait-title"
        aria-describedby="runner-wait-help"
    >
        <h2 id="runner-wait-title">Waiting for ${computer.name}</h2>
        <p id="runner-wait-help">
            ${`${computer.name} needs your approval: approve it there${question?.totp ? ", or enter the code from your authenticator" : ""}.`}
        </p>
        <p class="runner-wait-folder">Folder: <bdi dir="ltr">${folder}</bdi></p>
        <${ApprovalCode} runner=${computer} question=${question} />
        <p class="runner-wait-countdown">
            <${Spinner} label="Waiting for the computer" />
            Nobody answered? It stops in ${seconds} s.
        </p>
        <button type="button" class="button wide" onClick=${cancel}>Cancel</button>
    </section>`;
}

/** A small modal over the folder or copy sheet; it must not replace that sheet. */
function waiting(runnerId, folder, since, cancel) {
    const host = document.createElement("div");
    const app = document.getElementById("app");
    const focused = document.activeElement;
    const wasInert = app?.inert;
    const layer = addLayer(cancel);

    if (app) {
        app.inert = true;
    }

    document.body.append(host);

    const draw = () => {
        const computer = store.state.runners.find((each) => each.id === runnerId);

        render(
            html`<div class="overlay runner-wait-overlay">
                <${Approval}
                    computer=${computer}
                    folder=${folder}
                    question=${questionFor(computer, folder)}
                    since=${since}
                    cancel=${cancel}
                />
            </div>`,
            host,
        );
    };

    const onKey = (event) => {
        if (event.key === "Escape" && !event.isComposing && event.keyCode !== 229) {
            event.preventDefault();
            event.stopImmediatePropagation();
            cancel();
        }
    };

    draw();
    host.querySelector("button:last-child")?.focus({ preventScroll: true });
    addEventListener("keydown", onKey, true);

    const timer = setInterval(draw, 1000);
    const unsubscribe = store.subscribe(draw);

    return () => {
        clearInterval(timer);
        unsubscribe?.();
        removeEventListener("keydown", onKey, true);
        removeLayer(layer);
        render(null, host);
        host.remove();

        if (app) {
            app.inert = wasInert;
        }

        if (focused?.isConnected) {
            focused.focus({ preventScroll: true });
        }
    };
}

/** Run `start(signal)` and show where to answer after 400 ms. A person's Cancel returns no session and no error. */
export async function waitOnComputer(runnerId, folder, kind, start) {
    const computer = store.state.runners.find((each) => each.id === runnerId);

    if (!computer?.asks) {
        return start(undefined);
    }

    const controller = new AbortController();
    const since = Date.now();
    let close;
    const timer = setTimeout(() => {
        close = waiting(runnerId, folder, since, () => controller.abort());
    }, 400);

    try {
        const result = await start(controller.signal);

        return controller.signal.aborted ? undefined : result;
    } catch (error) {
        if (!controller.signal.aborted) {
            throw error;
        }

        return undefined;
    } finally {
        clearTimeout(timer);
        close?.();
    }
}

/** A running session's request waits for its expired permission: the prompt shows above its composer. */
export function SessionApproval() {
    const conversation = store.state.view.conversation;
    const computer = store.state.runners.find((each) => each.id === conversation?.runner);
    const question = computer?.questions?.find(
        (each) => each.session === conversation?.runnerPermission,
    );
    const [, tick] = useState(0);

    // The countdown moves each second while the question stands.
    useEffect(() => {
        if (!question) {
            return undefined;
        }

        const timer = setInterval(() => tick((n) => n + 1), 1000);

        return () => clearInterval(timer);
    }, [question?.id]);

    if (!computer || !question) {
        return null;
    }

    const since = seenAt(question.id);

    const withdraw = () =>
        api(`runners/${encodeURIComponent(computer.id)}/approval`, {
            id: question.id,
            withdraw: true,
        }).catch(() => {});

    return html`<div class="runner-session-approval">
        <${Approval}
            computer=${computer}
            folder=${question.folder}
            question=${question}
            since=${since}
            cancel=${withdraw}
        />
    </div>`;
}
