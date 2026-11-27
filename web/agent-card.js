// A message that an agent or the app sent to Pi, as a card: a linked session's answer, a subagent's report, a
// background task's end, a schedule, a message from outside. `agent-messages.js` reads the text into a card's
// pieces; this draws them: a head (what it is, who sent it, when, and Open), the content as Markdown, and a quiet
// footer (the reported outcome, exit codes, durations, and Show raw for the exact text Pi received).
import { useState } from "preact/hooks";
import { html, Icon, Markdown, readable } from "./ui.js";
import { OUTCOME_NOTE } from "./agent-messages.js";

/** A message folds past this many lines, or this many characters; output (a task's, a check's) to its last lines. */
const FOLD_LINES = 10;
const FOLD_CHARS = 900;
const OUTPUT_LINES = 8;

/** The pieces of a card's body that run longer than it folds to. */
function folding(body) {
    const lines = body.text.split("\n").length;

    if (body.type === "code") {
        return lines > OUTPUT_LINES ? lines : 0;
    }

    return body.type === "quiet" || (lines <= FOLD_LINES && body.text.length <= FOLD_CHARS)
        ? 0
        : lines;
}

function Body({ body, open, renderFenced }) {
    switch (body.type) {
        case "markdown":
            return html`<${Markdown} text=${body.text} />`;
        case "fenced":
            // Its text between the data blocks keeps its line breaks and indents, as a message's text does.
            return html`<div class="acard-fenced">${renderFenced(body.text)}</div>`;

        case "code": {
            const lines = body.text.split("\n");
            const shown = lines.length > OUTPUT_LINES && !open ? lines.slice(-OUTPUT_LINES) : lines;

            return html`<pre class="acard-code" data-part="acard-code">${shown.join("\n")}</pre>`;
        }

        case "quiet":
            return html`<p class="acard-quiet">${body.text}</p>`;
        default:
            return html`<div class="acard-plain">${readable(body.text)}</div>`;
    }
}

/**
 * One card. `who` is the sender as the app shows them (a linked session's title, never its address; `unknown` when
 * this person cannot see it), `go` what Open does, `onRaw` opens the message sheet with the exact text, and
 * `renderFenced` draws a message from the app with the data it fenced.
 */
export function AgentCard({ card, id, time, who, unknown, go, extras, onRaw, renderFenced }) {
    const [open, setOpen] = useState(false);
    const folded = card.body === undefined ? 0 : folding(card.body);
    const bodyId = `acard-body-${id}`;
    const tail = card.body?.type === "code";

    const tap = (event) => {
        if (event.target.closest("a, button") || getSelection()?.toString()) {
            return;
        }

        onRaw();
    };

    return html`<article
        class=${`acard ${folded > 0 && !tail ? "folds" : ""} ${open ? "open" : ""}`}
        data-part="acard"
        data-kind=${card.kind}
        data-tone=${card.tone}
        data-from=${card.kind === "linked" ? "linked" : "other"}
        tabindex="0"
        onClick=${tap}
        onKeyDown=${(event) => {
            if (
                (event.key === "Enter" || event.key === " ") &&
                event.target === event.currentTarget
            ) {
                event.preventDefault();
                onRaw();
            }
        }}
    >
        <header class="acard-head" data-part="acard-head linked-head">
            <span class="acard-mark" data-part="acard-mark linked-mark" aria-hidden="true">
                <${Icon} name=${card.icon} size=${16} />
            </span>
            <span class="acard-who">
                <span class="acard-kicker" data-part="acard-kicker">
                    <span class="acard-state" data-part="acard-state">${card.state}</span>
                    <span class="acard-source">· ${card.source}</span>
                    ${
                        time &&
                        html`<span class="acard-time" data-part="acard-time">· ${time}</span>`
                    }
                </span>
                <span
                    class=${`acard-name ${unknown ? "unknown" : ""} ${card.mono ? "mono" : ""}`}
                    data-part="acard-name linked-name"
                >
                    ${who}
                </span>
            </span>
            ${
                go &&
                html`<button
                    class="acard-open"
                    data-part="acard-open linked-open"
                    aria-label=${go.label}
                    onClick=${go.run}
                >
                    Open
                    <${Icon} path="M5 12h14M13 6l6 6-6 6" size=${14} />
                </button>`
            }
        </header>
        ${
            (card.lead || card.command || card.body || extras) &&
            html`<div class="acard-body" data-part="acard-body linked-body" id=${bodyId}>
                ${
                    card.lead &&
                    html`<p class="acard-lead" data-tone=${card.lead.tone}>
                        ${readable(card.lead.text)}
                    </p>`
                }
                ${
                    card.command &&
                    html`<div class="acard-command" data-part="acard-command">
                        ${card.command}
                    </div>`
                }
                ${
                    card.body &&
                    html`<${Body}
                        body=${card.body}
                        open=${open}
                        renderFenced=${renderFenced}
                    />`
                }
                ${extras}
            </div>`
        }
        ${
            folded > 0 &&
            html`<button
                class="acard-more"
                data-part="acard-more linked-more"
                aria-expanded=${open ? "true" : "false"}
                aria-controls=${bodyId}
                onClick=${() => setOpen(!open)}
            >
                ${open ? "Show less" : `Show all · ${folded} lines`}
            </button>`
        }
        <footer class="acard-foot" data-part="acard-foot">
            <span class="acard-facts">
                ${
                    card.outcome &&
                    html`<span
                        class="acard-outcome"
                        data-part="acard-outcome"
                        data-outcome=${card.outcome.key}
                    >
                        Outcome: ${card.outcome.label}
                    </span>`
                }
                ${card.outcome && html`<span class="acard-note">${OUTCOME_NOTE}</span>`}
                ${card.meta.map((fact) => html`<span class="acard-fact">${fact}</span>`)}
            </span>
            <button
                class="acard-raw"
                data-part="acard-raw"
                aria-label="Show the exact text Pi received"
                onClick=${onRaw}
            >
                Show raw
            </button>
        </footer>
    </article>`;
}
