// The conversation, as a column of turns: a person's message, then what Pi did (its thinking and tool calls folded
// into one line that opens into a timeline), then Pi's reply, any approval, and the live line while Pi works.
import { Component } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { personColor } from "./avatar.js";
import { browserAvailable, setBrowserOpen } from "./browser.js";
import { describeCall } from "./calls.js";
import { DiffBlock } from "./diff.js";
import { fromServer } from "./peeks.js";
import { Highlighted } from "./rich.js";
import {
    actions,
    attempt,
    canSteer,
    collab,
    discuss,
    isRow,
    navigate,
    notify,
    openSheet,
    store,
    TRANSCRIPT_ROWS,
} from "./store.js";
import { stateOf } from "./subagents.js";
import {
    diffCounts,
    itemsOf,
    lineCount,
    matchCount,
    plural,
    rowsBefore,
    says,
    short,
    shortError,
    STOPPED,
    summarize,
    testOutcome,
    withoutNotes,
} from "./turns.js";
import {
    ATTACHMENTS_HEADING,
    Boot,
    copyText,
    entryImageUrl,
    fileUrl,
    html,
    Icon,
    Markdown,
    openFile,
    plainText,
    replyText,
    Spinner,
    Thumb,
} from "./ui.js";

const REPORT = /^\[subagent (\S+) (answered|failed)([^\]]*)\]\s?([\s\S]*)$/;
/** Where the next report starts, in a message of several that arrived together (`extensions/subagents.ts`). */
const NEXT_REPORT = /\n\n(?=\[subagent \S+ (?:answered|failed))/;

/** How a scheduled message starts (see src/server/schedules.ts). */
const SCHEDULED = "[scheduled] ";

/** A goal's check that did not pass, as Pi is told about it (see src/server/extensions/goals.ts): what, then its output. */
const GOAL_CHECK =
    /^\[goal\] `([\s\S]*?)` (still fails|was cut off by a server restart) \(([^)]*)\)\. ([\s\S]*)$/;

/** A skill run with `/skill:name`, as Pi gets it (see `expandSkillCommand` in src/server/prompts.ts): its name, file, and the request. */
const SKILL = /^<skill name="([^"]+)" location="([^"]+)">\n[\s\S]*?\n<\/skill>(?:\n\n([\s\S]+))?$/;

/** An @mention of a file or folder in a message, as the message box writes it. */
const MENTION = /(^|[\s([{])@(?:"([^"\n]+)"|([^\s"]+))/g;

/** One line of the attachment list the server adds to a message: `- path (name, mime, size bytes)`. */
const ATTACHED = /^- (.*) \(([^,]*), ([^,]*), (\d+) bytes\)$/;

function parseAttachments(block) {
    return block
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => {
            const match = ATTACHED.exec(line);

            return match
                ? { path: match[1], name: match[2], mime: match[3] }
                : { name: line.replace(/^- /, ""), mime: "" };
        });
}

function EntryImages({ entryId, count, label }) {
    return html`<div class="thumbs">
        ${Array.from(
            { length: count },
            (_, index) => html`<${Thumb}
                src=${entryImageUrl(entryId, index)}
                alt=${`${label} ${index + 1}`}
            />`,
        )}
    </div>`;
}

function authorName(entryId, view, users) {
    const userId = view.authors?.[entryId];

    if (userId) {
        const user = users.find((each) => each.id === userId);

        return user ? user.name : "Someone";
    }

    return undefined;
}

/** Tapping a message opens what can be done with it, unless the tap was on a link, an image, or a button in it, or ended a text selection. */
function openMessage(event, entryId) {
    if (event.target.closest("a, button") || getSelection()?.toString()) {
        return;
    }

    openSheet({ type: "message", entryId });
}

/**
 * The conversation whose first rows have rendered: rows that mount after that are new (a message sent, a report
 * arriving) and slide into place. Rows already there when a session opens just appear.
 */
let settledFor = null;

/** A message's text with its @mentions of files as buttons that open them. Mentions of people stay text. */
function MentionedText({ text }) {
    const parts = [];
    let last = 0;

    for (const match of text.matchAll(MENTION)) {
        const quoted = match[2] !== undefined;
        const path = quoted ? match[2] : match[3].replace(/[.,;:!?)\]}'`]+$/, "");

        if (!quoted && !/[./]/.test(path)) {
            continue;
        }

        const at = match.index + match[1].length;
        const written = quoted ? `@"${path}"` : `@${path}`;

        parts.push(text.slice(last, at));
        parts.push(
            html`<button
                class="file-mention"
                title=${`Open ${path}`}
                onClick=${() => openFile(path)}
            >
                ${written}
            </button>`,
        );
        last = at + written.length;
    }

    parts.push(text.slice(last));

    return parts;
}

/** A subagent's report: who, whether it answered or failed, and what it said. */
function Report({ report, view, fresh }) {
    const [, name, verb, after, text] = report;
    const child = view.subagents.find((agent) => agent.name === name);
    // A failed one says why: "failed: stopped before it answered", "failed: Bad request".
    const why = verb === "failed" ? after.replace(/^:\s*/, "") : "";

    return html`<div
        class=${`report ${verb === "failed" ? "failed" : ""} ${fresh ? "enter" : ""}`}
    >
        <div class="report-head">
            <span class="report-name">${name}</span> ${verb}
            ${
                child &&
                html`<button class="link" onClick=${() => navigate(child.conversationId)}>
                    Open →
                </button>`
            }
        </div>
        ${why && html`<div class="report-why">${why}</div>`}
        ${text && html`<${Collapsible} text=${text} />`}
    </div>`;
}

/** A span of time: "18s", "2m 04s", "1h 02m". */
function span(ms) {
    const seconds = Math.max(0, Math.round(ms / 1000));

    if (seconds < 60) {
        return `${seconds}s`;
    }

    if (seconds < 3600) {
        return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
    }

    return `${Math.floor(seconds / 3600)}h ${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}m`;
}

/** When a message was sent, from the server's time: "10:42" today, "Oct 3 10:42" before. */
function clock(at) {
    const date = new Date(fromServer(at));
    const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

    return date.toDateString() === new Date().toDateString()
        ? time
        : `${date.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

/**
 * A person's message: a filled row with a prompt mark, the accent's for your own and the author's color for someone
 * else's, then who sent it and when, and what they wrote.
 */
function UserEntry({ entry, view, users }) {
    const [fresh] = useState(() => settledFor !== null && settledFor === view.conversation?.id);

    // A report has nobody's name on it: a person's message that looks like one is theirs.
    if (REPORT.test(entry.text) && entry.from === undefined && !view.authors?.[entry.id]) {
        // Several that arrived together came as one message: a card each. A part that is not a report's start is
        // more of the report before it.
        const parts = [];

        for (const part of entry.text.split(NEXT_REPORT)) {
            if (parts.length > 0 && !REPORT.test(part)) {
                parts[parts.length - 1] += `\n\n${part}`;
            } else {
                parts.push(part);
            }
        }

        const reports = parts.map((part) => REPORT.exec(part)).filter(Boolean);

        return reports.length === 1
            ? html`<${Report} report=${reports[0]} view=${view} fresh=${fresh} />`
            : html`<div class="report-group">
                  ${reports.map((report) => html`<${Report} report=${report} view=${view} fresh=${fresh} />`)}
              </div>`;
    }

    const check = GOAL_CHECK.exec(entry.text);

    if (check) {
        const [, command, what, how, output] = check;

        return html`<div class="report failed">
            <div class="report-head">
                <span class="report-name mono">${command}</span> ${what} · ${how}
            </div>
            <${Collapsible} text=${output} limit=${300} />
        </div>`;
    }

    const authorId = view.authors?.[entry.id];
    const author =
        authorName(entry.id, view, users) ??
        entry.from ??
        (view.conversation?.kind === "subagent" ? "Main agent" : undefined);
    const [written, attachments] = entry.text.split(ATTACHMENTS_HEADING);
    // Set up earlier to go out now: by a person (who shows as its author) or by Pi.
    const scheduled = written.startsWith(SCHEDULED);
    const body = scheduled ? written.slice(SCHEDULED.length) : written;
    const files = attachments ? parseAttachments(attachments) : [];
    // `/skill:name request`: the skill by name, and the request.
    const skill = SKILL.exec(body);
    const pictures = files.filter((file) => file.path && file.mime.startsWith("image/"));
    const others = files.filter((file) => !pictures.includes(file));
    const name = author ?? (scheduled ? "Pi" : undefined);
    // Your own messages take the accent; someone else's, their color; one from someone the app does not know (a name
    // the message carries, the main agent, Pi's own schedule), a quiet one.
    const mark =
        authorId === store.state.me?.id || (authorId === undefined && name === undefined)
            ? "var(--accent)"
            : authorId === undefined
              ? "var(--muted)"
              : personColor(authorId);

    return html`<div class=${`user-row ${fresh ? "enter" : ""}`} id=${`entry-${entry.id}`}>
        <div
            class="prompt tappable"
            title="Edit, send again, or copy"
            onClick=${(event) => openMessage(event, entry.id)}
        >
            <span class="prompt-mark" style=${`color:${mark}`} aria-hidden="true">›</span>
            ${
                (name || entry.at || scheduled) &&
                html`<span class="prompt-head">
                    ${
                        name &&
                        html`<b
                            class="prompt-author"
                            style=${authorId ? `color:${personColor(authorId)}` : ""}
                        >
                            ${name}
                        </b>`
                    }
                    ${entry.at && html`<span>${clock(entry.at)}</span>`}
                    ${scheduled && html`<span>· scheduled</span>`}
                </span>`
            }
            <div class="prompt-body">
                ${
                    skill &&
                    html`<button
                        class="chip skill-chip"
                        title=${skill[2]}
                        onClick=${() => openFile(skill[2])}
                    >
                        ⚡ ${skill[1]}
                    </button>`
                }
                ${
                    (skill ? skill[3] : body) &&
                    html`<div class="user-text">
                        <${MentionedText} text=${skill ? skill[3] : body} />
                    </div>`
                }
                ${
                    entry.files?.length > 0 &&
                    html`<div class="attachments">
                        ${entry.files.map(
                            (path) =>
                                html`<button
                                    class="chip"
                                    title=${`Sent with the message: ${path}`}
                                    onClick=${() => openFile(path)}
                                >
                                    📄 ${path.split("/").pop()}
                                </button>`,
                        )}
                    </div>`
                }
                ${
                    pictures.length > 0 &&
                    html`<div class="thumbs">
                        ${pictures.map(
                            (file) => html`<${Thumb} src=${fileUrl(file.path)} alt=${file.name} />`,
                        )}
                    </div>`
                }
                ${
                    others.length > 0 &&
                    html`<div class="attachments">
                        ${others.map((file) => html`<span class="chip">📎 ${file.name}</span>`)}
                    </div>`
                }
                ${
                    entry.images > 0 &&
                    !attachments &&
                    html`<${EntryImages} entryId=${entry.id} count=${entry.images} label="Image" />`
                }
            </div>
        </div>
    </div>`;
}

function Collapsible({ text, limit = 600 }) {
    const [open, setOpen] = useState(false);

    if (text.length <= limit) {
        return html`<${Markdown} text=${text} />`;
    }

    return html`<div class=${`collapsible ${open ? "open" : ""}`}>
        <${Markdown} text=${open ? text : `${text.slice(0, limit)}…`} />
        <button class="link" onClick=${() => setOpen(!open)}>
            ${open ? "Show less" : "Show more"}
        </button>
    </div>`;
}

// ─── What Pi did: its thinking and tool calls, a line each on a timeline ───────────────

/** The mark a call's line starts with; the rest take theirs from `describeCall`. */
const GLYPHS = { read: "→", edit: "✎", write: "+", bash: "$", grep: "⌕", find: "⌕", subagent: "⑂" };

/** A call's line: its label (the tool, or a subagent's name) and what it acts on. */
function stepWords(call) {
    const args = call.args ?? {};

    switch (call.name) {
        case "grep":
        case "find":
            return {
                label: call.name,
                subject: [args.pattern, args.path].filter(Boolean).join("  "),
            };
        case "subagent":
            return {
                label: args.name ?? "subagent",
                subject: args.message ? short(args.message) : (args.action ?? ""),
            };
        case "browser":
            return {
                label: "browser",
                subject: `${args.action ?? ""} ${describeCall(call).subject}`.trim(),
            };
        default:
            return { label: call.name, subject: describeCall(call).subject };
    }
}

/**
 * What a call came to, on the right of its line: `{ text, tone }`, or null while it runs or when there is nothing to
 * say.
 */
function outcome({ call, result, details, status }) {
    if (status === "approval") {
        return { text: "needs approval", tone: "warn" };
    }

    if (status === "denied" || status === "stopped") {
        return {
            text: /was interrupted/.test(result?.text ?? "") ? "cut off by a restart" : status,
            tone: "",
        };
    }

    if (status === "error") {
        return { text: shortError(result?.text ?? ""), tone: "err" };
    }

    // A call whose result is not stored yet has nothing to count.
    if (status !== "done" || !result) {
        return null;
    }

    const text = result.text ?? "";
    const args = call.args ?? {};

    switch (call.name) {
        case "edit": {
            const counts = diffCounts(details?.diff);

            return counts && { text: `+${counts.added} −${counts.removed}`, tone: "ok" };
        }

        case "write":
            return typeof args.content === "string" && !call.clipped?.content
                ? { text: `+${lineCount(args.content)}`, tone: "ok" }
                : null;

        case "read": {
            // Without the notes a long file's read ends with: "[120 more lines in file. Use offset=…]".
            const read = withoutNotes(text).replace(
                /\n*\[[^\]\n]*(?:more lines|offset=)[^\]\n]*\]\s*$/,
                "",
            );

            return result.images > 0
                ? { text: "image", tone: "" }
                : !result.clipped && { text: plural(lineCount(read), "line"), tone: "" };
        }

        // A long result reaches the browser cut short (its start and end): its lines cannot be counted.
        case "grep":
            return /^No matches/.test(text)
                ? { text: "no matches", tone: "" }
                : {
                      text: result.clipped
                          ? "many matches"
                          : plural(matchCount(withoutNotes(text)), "match").replace(
                                "matchs",
                                "matches",
                            ),
                      tone: "",
                  };
        case "find":
        case "ls":
            return /^(?:No files|\(empty directory\))/.test(text)
                ? { text: "none", tone: "" }
                : {
                      text: result.clipped
                          ? "many"
                          : plural(
                                lineCount(withoutNotes(text)),
                                call.name === "ls" ? "entry" : "file",
                            ).replace("entrys", "entries"),
                      tone: "",
                  };

        case "bash": {
            const tests = testOutcome(text, args.command);

            if (tests) {
                return { text: tests, tone: "ok" };
            }

            const lines = lineCount(withoutNotes(text).trim());

            return {
                text: result.clipped
                    ? "long output"
                    : lines === 0
                      ? "no output"
                      : plural(lines, "line"),
                tone: "",
            };
        }

        case "artifact":
            return details?.version !== undefined
                ? { text: `v${details.version}`, tone: "" }
                : null;
        case "codemode":
            return Array.isArray(details?.calls)
                ? { text: plural(details.calls.length, "call"), tone: "" }
                : null;

        case "subagent": {
            const agent = store.state.view.subagents?.find((each) => each.name === args.name);

            if (
                !agent ||
                (args.action !== undefined && args.action !== "spawn" && args.action !== "send")
            ) {
                return null;
            }

            const state = stateOf(agent);
            const took =
                state !== "working" && agent.askedAt && agent.answeredAt
                    ? ` ${span(agent.answeredAt - agent.askedAt)}`
                    : "";

            return { text: `${state}${took}`, tone: state === "failed" ? "err" : "" };
        }

        default:
            return null;
    }
}

/**
 * Where a call is: waiting for approval, denied, running, done, failed, or stopped before it finished. A call with
 * nothing to say for it yet runs while it is being written, or while Pi works on the answer that asked for it
 * (`canRun`); any other never will.
 */
function callStatus({ result, slot, approval, decision, streaming, canRun, busy }) {
    if (approval) {
        return "approval";
    }

    if (decision?.allow === false) {
        return "denied";
    }

    if (result) {
        // Stopped with the run, or cut off by a restart: the harness says so in its own words.
        if (result.isError && STOPPED.test(result.text ?? "")) {
            return "stopped";
        }

        return result.isError ? "error" : "done";
    }

    if (slot) {
        return slot.status === "done" ? "done" : "running";
    }

    return streaming || (busy && canRun) ? "running" : "stopped";
}

/** A thought, on the timeline: open it to read it. */
function ThoughtStep({ block, streaming }) {
    const [open, setOpen] = useState(false);

    return html`<div
        class=${`step ${open ? "open" : ""}`}
        data-status=${streaming ? "running" : "done"}
    >
        <span class="step-node" aria-hidden="true"></span>
        <div class="step-line">
            <button class="step-head" aria-expanded=${open} onClick=${() => setOpen(!open)}>
                <span class="step-glyph thought" aria-hidden="true">✦</span>
                <span class="step-label">
                    ${streaming ? "Thinking" : block.redacted ? "Thought (redacted)" : "Thought"}
                </span>
                <span class="step-subject"></span>
                ${streaming && html`<${Spinner} label="Thinking" />`}
            </button>
        </div>
        ${
            open &&
            html`<div class="step-body">
                <div class="thought-body">${block.text}</div>
            </div>`
        }
    </div>`;
}

/** One tool call on the timeline: what it did and how it went, and tapped, its input and output. */
function ToolStep({ call, result, slot, approval, entryId, streaming, canRun, busy }) {
    const [open, setOpen] = useState(false);
    const [full, setFull] = useState(null);
    const view = store.state.view;
    const decision = view.decisions?.[call.id];
    const status = callStatus({ result, slot, approval, decision, streaming, canRun, busy });
    // A call that finishes while on screen flashes once.
    const [settled, setSettled] = useState(false);
    const was = useRef(status);

    useEffect(() => {
        const before = was.current;

        was.current = status;

        if (status !== "done" || before !== "running") {
            return;
        }

        setSettled(true);
        const timer = setTimeout(() => setSettled(false), 900);

        return () => clearTimeout(timer);
    }, [status]);
    const details = full?.result?.details ?? result?.details ?? slot?.details;
    const args = (full?.call ?? call).args ?? {};
    const resultText = full?.result?.text ?? result?.text;
    // A long edit's diff reaches the browser cut short, as its start and end (`projection.ts`), with no other sign.
    const diffClipped =
        typeof details?.diff === "string" &&
        /\n\n… \d+ characters not shown …\n\n/.test(details.diff);
    const loadFull = () =>
        attempt(async () => {
            const assistant = await actions.fullEntry(entryId);
            const fullCall = assistant.blocks?.find(
                (block) => block.type === "toolCall" && block.id === call.id,
            );
            const fullResult =
                (result?.clipped || diffClipped) && result
                    ? await actions.fullEntry(result.id)
                    : null;

            setFull({ call: fullCall ?? call, result: fullResult });
        });

    let body = null;

    if (open) {
        const clipped = (call.clipped || result?.clipped || diffClipped) && !full;
        const parts = [];

        if (
            (call.name === "read" || call.name === "write" || call.name === "edit") &&
            typeof args.path === "string" &&
            args.path !== ""
        ) {
            const at = call.name === "read" && args.offset ? `:${args.offset}` : "";

            parts.push(
                html`<button
                    class="link small tool-open"
                    onClick=${() => openFile(`${args.path}${at}`)}
                >
                    Open ${args.path.split("/").pop()} →
                </button>`,
            );
        }

        if (call.name === "bash") {
            parts.push(html`<pre class="cmd">$ ${args.command}</pre>`);
        }

        if (call.name === "write" && args.content) {
            parts.push(
                html`<${Highlighted} class="output" text=${args.content} lang=${args.path} />`,
            );
        }

        if (call.name === "edit") {
            if (details?.diff) {
                parts.push(
                    html`<${DiffBlock} text=${details.diff} path=${args.path ?? ""} bare=${true} />`,
                );
            } else if (Array.isArray(args.edits)) {
                parts.push(
                    html`<pre class="output">
                        ${args.edits.map((edit) => `- ${edit.oldText}\n+ ${edit.newText}`).join("\n\n")}
                    </pre>`,
                );
            }
        }

        if (call.name === "subagent" && args.message) {
            parts.push(html`<div class="tool-note">${args.message}</div>`);
        }

        if (call.name === "codemode") {
            if (args.code) {
                parts.push(html`<pre class="cmd">${args.code}</pre>`);
            }

            // The script's own tool calls, live while it runs.
            const nested = Array.isArray(details?.calls) ? details.calls : [];

            if (nested.length > 0) {
                parts.push(
                    html`<div class="nested-calls">
                        ${nested.map(
                            (each) => html`<div class=${`nested-call ${each.status}`}>
                                <span class="nested-status">
                                    ${each.status === "ok" ? "✓" : each.status === "running" ? "…" : each.status === "cancelled" ? "–" : "!"}
                                </span>
                                <span class="mono">${each.name}</span>
                                ${
                                    each.durationMs !== undefined &&
                                    html`<span class="muted">${each.durationMs} ms</span>`
                                }
                                ${
                                    each.error &&
                                    html`<span class="nested-error">${each.error}</span>`
                                }
                            </div>`,
                        )}
                    </div>`,
                );
            }
        }

        if (call.name === "artifact" && (args.content || args.edits)) {
            parts.push(
                html`<pre class="output">
                    ${args.content ?? JSON.stringify(args.edits, null, 2)}
                </pre>`,
            );
        }

        if (call.name === "browser") {
            parts.push(
                args.script
                    ? html`<pre class="cmd">${args.script}</pre>`
                    : html`<pre class="output">${JSON.stringify(args, null, 2)}</pre>`,
            );
        }

        if (
            ![
                "read",
                "write",
                "edit",
                "bash",
                "subagent",
                "artifact",
                "codemode",
                "browser",
            ].includes(call.name)
        ) {
            parts.push(html`<pre class="output">${JSON.stringify(args, null, 2)}</pre>`);
        }

        const output = resultText ?? slot?.output;

        if (output && !(call.name === "edit" && details?.diff && !result?.isError)) {
            parts.push(
                html`<pre class=${`output ${result?.isError ? "error" : ""}`}>${output}</pre>`,
            );
        }

        // A call still streaming has no stored entry to load yet.
        if (clipped && entryId !== undefined) {
            parts.push(html`<button class="link" onClick=${loadFull}>Load everything</button>`);
        }

        body = html`<div class="step-body">${parts}</div>`;
    }

    const artifact = call.name === "artifact" && details?.id ? details : null;
    const artifactType = artifact
        ? view.artifacts.find((each) => each.id === artifact.id)?.type
        : undefined;
    const artifactSrc = artifact
        ? `/a/${view.conversation.id}/${encodeURIComponent(artifact.id)}/${artifact.version}`
        : null;
    const child =
        call.name === "subagent"
            ? (details?.conversationId ??
              view.subagents.find((agent) => agent.name === args.name)?.conversationId)
            : undefined;
    const glyph = GLYPHS[call.name] ?? describeCall(call).icon;
    const { label, subject } = stepWords(call);
    // Counted from everything once it is loaded: a long write's lines, a long edit's whole diff.
    const said = outcome({
        call: full?.call ?? call,
        result: full?.result ?? result,
        details,
        status,
    });
    const watch = call.name === "browser" && browserAvailable() && !store.state.browserOpen;
    // What a call made shows under its line, as on today's cards: what it returned as images, an artifact, the browser.
    const extras = result?.images > 0 || artifact || watch;

    return html`<div
        class=${`step ${open ? "open" : ""} ${settled ? "settled" : ""}`}
        data-status=${status}
    >
        <span class="step-node" aria-hidden="true"></span>
        <div class="step-line">
            <button class="step-head" aria-expanded=${open} onClick=${() => setOpen(!open)}>
                <span
                    class=${`step-glyph ${call.name === "subagent" ? "agent" : ""}`}
                    aria-hidden="true"
                >
                    ${glyph}
                </span>
                <span class="step-label">${label}</span>
                <span class="step-subject">${subject}</span>
                ${status === "running" && html`<${Spinner} />`}
                ${said && html`<span class=${`step-meta ${said.tone}`}>${said.text}</span>`}
            </button>
            ${
                child !== undefined &&
                html`<button
                    class="step-open"
                    title=${`Open ${args.name ?? "the subagent"}`}
                    onClick=${() => navigate(child)}
                >
                    Open →
                </button>`
            }
        </div>
        ${
            decision &&
            html`<div class="step-decision" title=${new Date(decision.at).toLocaleString()}>
                <${Icon} name="shield" size=${12} /> ${decision.allow ? "Allowed" : "Denied"} by ${decision.by}
            </div>`
        }
        ${
            extras &&
            html`<div class="step-extras">
                ${
                    result?.images > 0 &&
                    html`<${EntryImages}
                        entryId=${result.id}
                        count=${result.images}
                        label=${`${call.name} image`}
                    />`
                }
                ${
                    artifactType === "svg" &&
                    html`<button
                        class="artifact-preview"
                        type="button"
                        onClick=${() => openSheet({ type: "image", src: artifactSrc, alt: artifact.title })}
                    >
                        <img
                            src=${artifactSrc}
                            alt=${artifact.title}
                            loading="lazy"
                            decoding="async"
                        />
                    </button>`
                }
                ${
                    artifact &&
                    html`<button
                        class="artifact-link"
                        onClick=${() => openSheet({ type: "viewer", id: artifact.id, version: artifact.version })}
                    >
                        Open ${artifact.title} · version ${artifact.version} →
                    </button>`
                }
                ${
                    watch &&
                    html`<button class="artifact-link" onClick=${() => setBrowserOpen(true)}>
                        Watch in the browser${details?.address ? ` · ${details.address}` : ""} →
                    </button>`
                }
            </div>`
        }
        ${body}
    </div>`;
}

/** Groups opened or closed by hand, per conversation and group, for as long as the page is open. */
const openedGroups = new Map();
/**
 * The answer a jump asked to see last (`jumpToEntry` in chat.js says so with a `pocket:reveal` event), and when: a group
 * that shows only after the jump moved the rows shown opens when it first draws. Groups already shown hear the event.
 */
let revealing = { entryId: null, at: 0 };

document.addEventListener("pocket:reveal", (event) => {
    revealing = { entryId: event.detail, at: Date.now() };
});
/** When this page first saw a group that began before any of its entries was stored: the start of its clock. */
const groupSeen = new Map();
/** Where a group's clock stood when it last ticked: the end of a group whose stored times do not say. */
const groupTicked = new Map();

/** Keep `value` in one of the maps above, the oldest going once there are many. */
function keep(map, key, value) {
    map.delete(key);
    map.set(key, value);

    if (map.size > 500) {
        map.delete(map.keys().next().value);
    }
}

/**
 * How long a group took, from when its first answer began to its last result; ticking while it is live, without
 * drawing the group again. A group whose stored times do not say how long (a thought, then words) keeps what its clock
 * showed, or shows nothing.
 */
function GroupTime({ id, start, end, live }) {
    const [, tick] = useState(0);

    useEffect(() => {
        if (!live) {
            return;
        }

        const timer = setInterval(() => tick((n) => n + 1), 1000);

        return () => clearInterval(timer);
    }, [live]);

    if (start === undefined) {
        return null;
    }

    let until = end;

    if (live) {
        until = Date.now();
        keep(groupTicked, id, until);
    } else if (!(until > start)) {
        until = groupTicked.get(id);
    }

    if (until === undefined || !Number.isFinite(until) || until < start) {
        return null;
    }

    return html`<span class=${`activity-time ${live ? "live" : ""}`}>${span(until - start)}</span>`;
}

/**
 * Pi's thinking and tool calls between two of its words, as one line: what they did, and how long they took. It opens
 * into a timeline, a line per call, each drawn again only when what it shows changes. Open while it is live or in the
 * newest turn, closed before, unless opened or closed by hand.
 */
function ActivityGroup({ item, live, newest, busy, results, slots, approvals, conversationId }) {
    const id = `${conversationId}:${item.key}`;
    const [, redraw] = useState(0);
    const [fresh] = useState(() => settledFor !== null && settledFor === conversationId);

    if (
        revealing.entryId !== null &&
        Date.now() - revealing.at < 2000 &&
        item.anchors.includes(revealing.entryId)
    ) {
        keep(openedGroups, id, true);
    }

    const chosen = openedGroups.get(id);
    const open = chosen ?? (live || newest);
    const all = item.before.length === 0 ? item.steps : [...item.before, ...item.steps];
    const first = all[0];
    let start = first.entry?.at === undefined ? undefined : fromServer(first.entry.at);

    if (start === undefined && first.entry === undefined) {
        if (!groupSeen.has(id)) {
            keep(groupSeen, id, Date.now());
        }

        start = groupSeen.get(id);
    }

    // The last result, or the last answer when the group ends with a thought.
    const times = all
        .flatMap((step) => [
            step.entry?.at,
            step.block.type === "toolCall" ? results.get(step.block.id)?.at : undefined,
        ])
        .filter((at) => at !== undefined);
    const end = times.length === 0 ? undefined : fromServer(Math.max(...times));
    const thinking =
        live && item.steps.at(-1).streaming && item.steps.at(-1).block.type === "thinking";
    // The steps' names, as the timeline draws them (below).
    const keys = new Set();
    // Begun in rows not shown, it goes on from their last call: a thought keeps its name when they show.
    const earlier = item.before.findLast((step) => step.block.type === "toolCall");
    let lastCall = earlier ? `c:${earlier.block.id || "#"}` : "start";
    let thoughts = 0;
    // A jump to one of its answers (Find, a pin, Changes) opens it: `jumpToEntry` says which.
    const anchors = item.anchors.join();

    useEffect(() => {
        if (anchors === "") {
            return;
        }

        const reveal = (event) => {
            if (item.anchors.includes(event.detail)) {
                keep(openedGroups, id, true);
                redraw((n) => n + 1);
            }
        };

        document.addEventListener("pocket:reveal", reveal);

        return () => document.removeEventListener("pocket:reveal", reveal);
    }, [anchors, id]);

    return html`<div class=${`activity ${open ? "open" : ""} ${fresh ? "enter" : ""}`}>
        ${item.anchors.map(
            (entryId) => html`<span class="entry-anchor" id=${`entry-${entryId}`}></span>`,
        )}
        <button
            class="activity-head"
            aria-expanded=${open}
            onClick=${() => {
                keep(openedGroups, id, !open);
                redraw((n) => n + 1);
            }}
        >
            <${Icon} name="chevron" size=${14} class="chev" />
            <span class="activity-summary">${summarize(all, thinking)}</span>
            <${GroupTime} id=${id} start=${start} end=${end} live=${live} />
        </button>
        ${
            open &&
            html`<div class="timeline">
                ${item.steps.map(({ block, entry, streaming, canRun }, index) => {
                    // A call is named by its id, the same streamed and stored; a thought by the call before it. Not by
                    // place: earlier steps join the front when earlier messages show.
                    if (block.type === "thinking") {
                        return html`<${Memo} key=${`t:${lastCall}:${thoughts++}`} deps=${[block, streaming]}>
                            <${ThoughtStep} block=${block} streaming=${streaming} />
                        <//>`;
                    }

                    const slot = slots.get(block.id);
                    const approval =
                        slot?.taskId === undefined
                            ? undefined
                            : approvals.find((each) => each.taskId === slot.taskId);
                    let key = `c:${block.id || `#${index}`}`;

                    // A provider can use an id twice, or none.
                    if (keys.has(key)) {
                        key = `${key}#${index}`;
                    }

                    keys.add(key);
                    lastCall = key;
                    thoughts = 0;

                    return html`<${Memo}
                        key=${key}
                        deps=${[
                            block,
                            entry,
                            canRun,
                            busy,
                            conversationId,
                            ...callDeps(block, results, slots, approvals),
                        ]}
                    >
                        <${ToolStep}
                            call=${block}
                            result=${results.get(block.id)}
                            slot=${slot}
                            approval=${approval}
                            entryId=${entry?.id}
                            streaming=${entry === undefined}
                            canRun=${canRun}
                            busy=${busy}
                        />
                    <//>`;
                })}
            </div>`
        }
    </div>`;
}

/** Whether a step is still at work: a thought being written, or a call that has not finished. */
function stepLive(step, results, slots, approvals, busy) {
    if (step.block.type === "thinking") {
        return step.streaming;
    }

    const slot = slots.get(step.block.id);
    const approval =
        slot?.taskId === undefined
            ? undefined
            : approvals.find((each) => each.taskId === slot.taskId);
    const status = callStatus({
        result: results.get(step.block.id),
        slot,
        approval,
        decision: store.state.view.decisions?.[step.block.id],
        streaming: step.entry === undefined,
        canRun: step.canRun,
        busy,
    });

    return status === "running" || status === "approval";
}

function ApprovalCard({ approval }) {
    const { me, server } = store.state;
    const [busy, setBusy] = useState(false);

    const answer = (allow) => {
        setBusy(true);
        attempt(() => actions.approve(approval.id, allow)).finally(() => setBusy(false));
    };

    // With approvals that need someone else, a guest cannot allow a call their own message led to (the server checks too).
    const ownCall =
        server?.approvalRule === "others" &&
        me?.role !== "owner" &&
        approval.requestedBy === me?.id;

    return html`<div class="approval">
        <div class="approval-head">
            <${Icon} name="shield" size=${16} /> Lancet Guard asks before this ${approval.tool} call
        </div>
        <div class="approval-reason">${approval.reason}</div>
        <pre class="cmd">${approval.subject}</pre>
        ${
            !canSteer()
                ? html`<div class="muted small">Waiting for someone who can steer to answer.</div>`
                : html`${
                      ownCall &&
                      html`<div class="muted small">
                          Someone else has to allow this: it came from your message. You can deny it.
                      </div>`
                  }
                <div class="approval-actions">
                    <button class="button deny" disabled=${busy} onClick=${() => answer(false)}>
                        Deny
                    </button>
                    ${
                        !ownCall &&
                        html`<button
                            class="button primary"
                            disabled=${busy}
                            onClick=${() => answer(true)}
                        >
                            Allow
                        </button>`
                    }
                </div>`
        }
    </div>`;
}

// ─── Pi's words ───────────────────────────────────────────────────────────────────────

/** Under Pi's answers: reactions, and ways to talk about the answer with the people here. */
function AnswerActions({ entry }) {
    const { view, me, users, server } = store.state;
    const [picking, setPicking] = useState(false);
    const reactions = view.reactions?.[entry.id] ?? {};
    const pinned = (view.pins ?? []).some((pin) => pin.entryId === entry.id);
    const text = replyText(entry);
    const names = (ids) =>
        ids
            .map((id) =>
                id === me?.id ? "you" : (users.find((user) => user.id === id)?.name ?? "someone"),
            )
            .join(", ");

    const react = (emoji) => {
        setPicking(false);
        attempt(() => actions.react(entry.id, emoji));
    };

    return html`<div class=${`answer-actions ${picking ? "picking" : ""}`}>
        ${Object.entries(reactions).map(
            ([emoji, ids]) =>
                html`<button
                    class=${`reaction ${ids.includes(me?.id) ? "mine" : ""}`}
                    title=${`${emoji} ${names(ids)}`}
                    onClick=${() => react(emoji)}
                >
                    ${emoji} <span>${ids.length}</span>
                </button>`,
        )}
        <span class="reaction-host answer-tool">
            <button
                class="reaction add"
                aria-label="React"
                title="React"
                onClick=${() => setPicking(!picking)}
            >
                ☺+
            </button>
            ${
                picking &&
                html`<span class="reaction-picker">
                    ${(server?.reactions ?? []).map(
                        (emoji) => html`<button onClick=${() => react(emoji)}>${emoji}</button>`,
                    )}
                </span>`
            }
        </span>
        <button
            class="answer-tool"
            onClick=${() => discuss(entry.id, plainText(text).replace(/\s+/g, " ").slice(0, 280))}
        >
            Discuss
        </button>
        <button
            class="answer-tool"
            onClick=${() => attempt(() => actions.pin({ entryId: entry.id }))}
        >
            ${pinned ? "📌 Pinned" : "Pin"}
        </button>
        <button
            class="answer-tool"
            onClick=${() =>
                copyText(text).then(
                    () => notify("info", "Copied."),
                    () => notify("error", "Could not copy."),
                )}
        >
            Copy
        </button>
        <button
            class="answer-tool"
            title="Fork, retry"
            onClick=${() => openSheet({ type: "message", entryId: entry.id })}
        >
            More
        </button>
    </div>`;
}

/** How one of Pi's answers ended, under its last words: a failed request, a stop, or the answer's actions. */
function AnswerEnd({ entry }) {
    // A final answer (not a step between tool calls) with something to say gets reactions and the discuss row.
    const answer = collab() && entry.stopReason !== "toolUse" && entry.blocks.some(says);

    return html`${
        entry.stopReason === "error" &&
        html`<div class="error-box">${entry.error ?? "The model request failed."}</div>`
    }
    ${entry.stopReason === "aborted" && html`<div class="muted small">Stopped.</div>`}
    ${answer && html`<${AnswerActions} entry=${entry} />`}`;
}

/** A run of Pi's words: plain prose, and how the answer ended when they are its last. */
function Reply({ item, conversationId }) {
    const [fresh] = useState(() => settledFor !== null && settledFor === conversationId);
    const { entry, blocks } = item;

    return html`<div
        class=${`reply ${fresh ? "enter" : ""}`}
        id=${item.anchor ? `entry-${entry.id}` : undefined}
    >
        ${blocks.map(({ block, growing }, index) => {
            // The block still growing changes on every update: caching each version would only push out finished ones.
            return html`<${Markdown}
                key=${index}
                text=${block.text}
                class=${growing ? "streaming" : ""}
                cache=${!growing}
            />`;
        })}
        ${item.end && html`<${AnswerEnd} entry=${entry} />`}
    </div>`;
}

function Divider({ entry }) {
    const [open, setOpen] = useState(false);

    // A session continued from Pi in the terminal: what is above is Pi's, from that session's file.
    if (entry.kind === "fromPi") {
        return html`<div class="divider">
            <span>Continued from Pi in the terminal</span>
            <div class="muted small mono">${entry.file}</div>
        </div>`;
    }

    if (entry.kind === "reset") {
        return html`<div class="divider">
            <span>New context</span>
            ${entry.text && html`<div class="divider-body"><${Markdown} text=${entry.text} /></div>`}
        </div>`;
    }

    return html`<div class="divider">
        <button class="link" onClick=${() => setOpen(!open)}>
            Context compacted ${open ? "▾" : "▸"}
        </button>
        ${open && html`<div class="divider-body"><${Markdown} text=${entry.summary} /></div>`}
    </div>`;
}

function History({ firstId, results, keepPlace, conversationId }) {
    const history = store.state.history;

    if (history === null) {
        return html`<div class="divider">
            <button
                class="link"
                onClick=${() =>
                    attempt(async () => {
                        const earlier = await actions.history(firstId);

                        keepPlace();
                        store.set({ history: earlier });
                    })}
            >
                Show earlier messages
            </button>
        </div>`;
    }

    return html`<div class="history">
        <${Items}
            items=${itemsOf(history.filter(isRow), null, { prefix: "h", talk: collab() })}
            results=${results}
            slots=${NO_SLOTS}
            approvals=${NO_APPROVALS}
            busy=${false}
            past=${true}
            conversationId=${conversationId}
        />
    </div>`;
}

/** How a command someone ran ended, when that is worth saying. */
const SHELL_ENDS = {
    timeout: "timed out",
    failed: "could not run",
    interrupted: "cut off by a restart",
    stopped: "stopped",
};

/** How many of a command's last lines show before "Show all". */
const SHELL_LINES = 12;

/** A command someone ran with `!` (or `!!`, which Pi does not see): what it printed, and how it ended. */
function ShellEntry({ entry }) {
    const [open, setOpen] = useState(false);
    const [full, setFull] = useState(null);
    const output = (full ?? entry.output).replace(/\s+$/, "");
    const lines = output.split("\n");
    const long = lines.length > SHELL_LINES;
    // A long command (a paste in it, say) shows its first lines until opened.
    const longCommand = entry.command.split("\n").length > 3 || entry.command.length > 240;
    const end =
        entry.status === "done"
            ? entry.code === 0
                ? ""
                : `exit ${entry.code}`
            : SHELL_ENDS[entry.status];

    return html`<div class="shell-row" id=${`entry-${entry.id}`}>
        <div class=${`shell-card ${end ? "failed" : ""} ${open ? "open" : ""}`}>
            <div class="shell-head">
                <span class="mono shell-command">$ ${entry.command}</span>
                <span class="muted small">
                    ${entry.name}
                    ${end ? ` · ${end}` : ""}
                    ${entry.context ? "" : " · not shown to Pi"}
                </span>
            </div>
            ${
                output !== "" &&
                html`<pre class="output">
                    ${long && !open ? `…\n${lines.slice(-SHELL_LINES).join("\n")}` : output}
                </pre>`
            }
            ${
                (long || longCommand) &&
                html`<button class="link small" onClick=${() => setOpen(!open)}>
                    ${open ? "Show less" : long ? `Show all ${lines.length} lines` : "Show all"}
                </button>`
            }
            ${
                entry.truncated &&
                full === null &&
                html`<button
                    class="link small"
                    onClick=${() =>
                        attempt(async () => {
                            setFull((await actions.fullEntry(entry.id)).output);
                            setOpen(true);
                        })}
                >
                    Load everything
                </button>`
            }
        </div>
    </div>`;
}

/** Something a person did that Pi was told about, such as undoing a file. */
function NoteEntry({ entry }) {
    return html`<div class="note-line" id=${`entry-${entry.id}`}>
        ${entry.name} ${entry.text}. <span class="muted">Pi was told.</span>
    </div>`;
}

/** How long a `!` command's row may wait for its entry: past the server's limit for a command, something went wrong. */
const PENDING_MS = 11 * 60_000;

/** How long a scroller may glide on after a finger lets go of it, at most. */
const GLIDE_MS = 3000;

/** A touch screen, where scrollers glide on after a flick and their scroll bars take no room. */
const COARSE = matchMedia("(pointer: coarse)");

/**
 * Straight to the bottom of `element`. On an iPhone a scroller can still be gliding from a flick when the way to the
 * bottom is tapped, and WebKit keeps the glide's place over one set from script: the screen goes blank, and the next
 * touch carries on from where it was. Not scrolling for two frames ends the glide, so the jump holds. (Elsewhere a
 * scroll bar that went for a moment would shift the page.)
 */
function toBottom(element) {
    element.scrollTop = element.scrollHeight;

    if (!COARSE.matches) {
        return;
    }

    element.style.overflowY = "hidden";
    requestAnimationFrame(() =>
        requestAnimationFrame(() => {
            element.style.overflowY = "";
            element.scrollTop = element.scrollHeight;
        }),
    );
}

/** `!` commands this tab started that have no entry yet: still running, or waiting for Pi to finish its turn. */
function PendingShells({ conversationId, rows }) {
    const pending = store.state.pendingShells.filter(
        (each) =>
            each.conversationId === conversationId &&
            Date.now() - each.at < PENDING_MS &&
            !rows.some((row) => row.kind === "shell" && row.taskId === each.taskId),
    );

    return pending.map(
        (each) => html`<div class="shell-row pending" key=${each.taskId}>
            <div class="shell-card">
                <div class="shell-head">
                    <span class="mono shell-command">$ ${each.command}</span>
                    <span class="muted small"><${Spinner} /> running</span>
                    <button
                        class="link small"
                        onClick=${() => attempt(() => actions.stopShell(each.taskId))}
                    >
                        Stop
                    </button>
                </div>
            </div>
        </div>`,
    );
}

function EntryView({ entry }) {
    const { view, users } = store.state;

    if (entry.kind === "shell") {
        return html`<${ShellEntry} entry=${entry} />`;
    }

    if (entry.kind === "note") {
        return html`<${NoteEntry} entry=${entry} />`;
    }

    if (entry.kind === "user") {
        return html`<${UserEntry} entry=${entry} view=${view} users=${users} />`;
    }

    if (entry.kind === "compaction" || entry.kind === "reset" || entry.kind === "fromPi") {
        return html`<${Divider} entry=${entry} />`;
    }

    return null;
}

const NO_SLOTS = new Map();

const NO_APPROVALS = [];

/** The subagents as their rows and lines show them: who, where, and how they stand. */
const agentsKey = (view) =>
    (view.subagents ?? [])
        .map(
            (agent) =>
                `${agent.name}:${agent.conversationId}:${stateOf(agent)}:${agent.askedAt ?? ""}:${agent.answeredAt ?? ""}`,
        )
        .join();

/**
 * Everything a row shows besides its entry, as values that compare with Object.is. Each update from the server builds
 * new objects for the whole view, so this picks out the parts one row uses: a row whose parts did not change skips
 * rendering, and a long thread stays cheap while Pi streams into its newest message.
 */
function rowDeps(entry) {
    const { view, users, me, server } = store.state;
    const deps = [entry, users, me, server, view.conversation?.id, view.conversation?.kind];

    if (entry.kind === "user") {
        deps.push(view.authors?.[entry.id]);

        if (entry.text.startsWith("[subagent ")) {
            deps.push(agentsKey(view));
        }
    }

    return deps;
}

/** What a tool call's line shows besides the call: its result, its live slot, who decided on it, what it made. */
function callDeps(block, results, slots, approvals) {
    const { view } = store.state;
    const slot = slots.get(block.id);
    const decision = view.decisions?.[block.id];
    const deps = [
        results.get(block.id),
        slot === undefined ? "" : JSON.stringify(slot),
        decision === undefined ? "" : JSON.stringify(decision),
    ];

    if (slot?.taskId !== undefined) {
        deps.push(approvals.find((each) => each.taskId === slot.taskId)?.id);
    }

    if (block.name === "artifact") {
        deps.push((view.artifacts ?? []).map((each) => `${each.id}:${each.type}`).join());
    }

    if (block.name === "subagent") {
        deps.push(agentsKey(view));
    }

    // Whether the browser is there to watch (`browserAvailable`), and open already.
    if (block.name === "browser") {
        deps.push(store.state.browserOpen, store.state.server);
    }

    return deps;
}

/** What a run of Pi's words shows besides its text: the answer's reactions and pin, and who is looking. */
function replyDeps(item) {
    const { view, users, me, server } = store.state;
    const { entry } = item;
    const reactions = view.reactions?.[entry.id];

    return [
        entry,
        item.blocks.length,
        item.end,
        item.anchor,
        users,
        me,
        server,
        view.conversation?.id,
        reactions === undefined ? "" : JSON.stringify(reactions),
        (view.pins ?? []).some((pin) => pin.entryId === entry.id),
    ];
}

/** One item of the transcript, rendered again only when its `deps` change. Its cards keep their open state. */
class Memo extends Component {
    shouldComponentUpdate(next) {
        const before = this.props.deps;
        const after = next.deps;

        return (
            before.length !== after.length ||
            before.some((value, index) => !Object.is(value, after[index]))
        );
    }

    render({ children }) {
        return children;
    }
}

/** The answer being written, as an entry: the same object for as long as its blocks stay the same. */
const partials = new WeakMap();

function partialEntry(blocks) {
    if (blocks.length === 0) {
        return null;
    }

    if (!partials.has(blocks)) {
        partials.set(blocks, { kind: "assistant", blocks });
    }

    return partials.get(blocks);
}

/**
 * The transcript's items, each rendered again only when what it shows changed. A group is live while one of its calls
 * works or waits, or while it is the last thing in a run; groups after the last person's message are the newest turn.
 */
function Items({ items, results, slots, approvals, busy, past = false, conversationId }) {
    let lastMessage = -1;

    items.forEach((item, index) => {
        if (item.type === "row" && item.entry.kind === "user") {
            lastMessage = index;
        }
    });

    return items.map((item, index) => {
        if (item.type === "row") {
            return html`<${Memo} key=${item.key} deps=${rowDeps(item.entry)}>
                <${EntryView} entry=${item.entry} />
            <//>`;
        }

        // An answer with nothing to show (blank words): only where a jump to it lands.
        if (item.type === "mark") {
            return html`<span
                key=${item.key}
                class="entry-anchor entry-mark"
                id=${`entry-${item.entry.id}`}
            ></span>`;
        }

        if (item.type === "reply") {
            return html`<${Memo} key=${item.key} deps=${replyDeps(item)}>
                <${Reply} item=${item} conversationId=${conversationId} />
            <//>`;
        }

        const live =
            !past &&
            (item.steps.some((step) => stepLive(step, results, slots, approvals, busy)) ||
                (busy && index === items.length - 1));
        const newest = !past && index > lastMessage;
        const deps = [
            item.steps.length,
            item.before.length,
            item.before[0]?.block,
            item.before.at(-1)?.block,
            item.anchors.join(),
            live,
            newest,
            busy,
            conversationId,
        ];

        // The calls before the rows shown count in the group's line: their results, for its time.
        for (const step of item.before) {
            if (step.block.type === "toolCall") {
                deps.push(results.get(step.block.id));
            }
        }

        for (const step of item.steps) {
            deps.push(step.block, step.entry, step.streaming, step.canRun);

            if (step.block.type === "toolCall") {
                deps.push(...callDeps(step.block, results, slots, approvals));
            }
        }

        return html`<${Memo} key=${item.key} deps=${deps}>
            <${ActivityGroup}
                item=${item}
                live=${live}
                newest=${newest}
                busy=${busy}
                results=${results}
                slots=${slots}
                approvals=${approvals}
                conversationId=${conversationId}
            />
        <//>`;
    });
}

/** When the runs this tab saw started, per conversation: the newest message then, and the time. */
const runsSeen = new Map();

/**
 * When the running work started: when the newest message was sent, if this run is its answer; otherwise when this tab
 * first saw it run (a retry, or a run this tab opened in the middle of). A steer joins the run on the clock; a message
 * queued for after a run starts the clock again, once that run gave its answer.
 */
function runStart(conversationId, entries, busy) {
    if (!busy) {
        runsSeen.delete(conversationId);

        return undefined;
    }

    const at = entries.findLastIndex((entry) => entry.kind === "user");
    const newest = entries[at];
    const finished = (from, to) =>
        entries
            .slice(from, to)
            .some((entry) => entry.kind === "assistant" && entry.stopReason !== "toolUse");

    const begin = () => {
        // Pi answered it already (stopped, failed, or done): this run is not that message's.
        const sent =
            newest?.at === undefined || finished(at + 1)
                ? undefined
                : Math.min(Date.now(), fromServer(newest.at));

        return { message: newest?.id, at: sent ?? Date.now() };
    };

    let seen = runsSeen.get(conversationId);

    if (seen === undefined) {
        seen = begin();
    } else if (seen.message !== newest?.id) {
        const before = entries.findIndex((entry) => entry.id === seen.message);

        seen = finished(before + 1, at) ? begin() : { ...seen, message: newest?.id };
    }

    keep(runsSeen, conversationId, seen);

    return seen.at;
}

/** Whether this person can answer one of the approvals waiting: one who can steer, and for a call not of their own asking where that needs someone else. */
function canAnswer(approvals) {
    const { me, server } = store.state;

    return (
        canSteer() &&
        approvals.some(
            (approval) =>
                !(
                    server?.approvalRule === "others" &&
                    me?.role !== "owner" &&
                    approval.requestedBy === me?.id
                ),
        )
    );
}

/**
 * The end of the live turn, in one line: what Pi does (thinks, works, waits for an approval, retries a failed request,
 * compacts its context), for how long, and how to stop it. Screen readers hear what it does when that changes, not the
 * seconds counting.
 */
function LiveLine({ live, approvals, start }) {
    const [, tick] = useState(0);

    useEffect(() => {
        const timer = setInterval(() => tick((n) => n + 1), 1000);

        return () => clearInterval(timer);
    }, []);

    const partial = live.generation?.message?.blocks ?? [];
    const retry = live.generation?.retry;
    const working = (live.tools ?? []).some((slot) => slot.status !== "done");
    const waiting = approvals.length > 0;
    const seconds = retry ? Math.ceil((fromServer(retry.at) - Date.now()) / 1000) : 0;
    let state;

    if (waiting) {
        state = canAnswer(approvals) ? "Waiting for your approval" : "Waiting for approval";
    } else if (retry) {
        state = "Retrying";
    } else if ((live.compactions ?? []).length > 0) {
        state = "Compacting context";
    } else if (working || (partial.length > 0 && partial.at(-1).type !== "thinking")) {
        state = "Working";
    } else {
        state = "Thinking";
    }

    return html`<div class=${`live-line ${waiting ? "waiting" : ""}`}>
        ${
            waiting
                ? html`<span class="live-wait" aria-hidden="true"></span>`
                : html`<${Spinner} hidden=${true} />`
        }
        <span class="live-state" role="status">
            ${state}${retry && !waiting && seconds > 0 && html`<span aria-hidden="true"> in ${seconds}s</span>`}
        </span>
        ${start !== undefined && html`<span aria-hidden="true">${span(Date.now() - start)}</span>`}
        ${
            retry &&
            !waiting &&
            html`<span
                class="live-why"
                title=${`Attempt ${live.generation.attempt + 1}, after: ${retry.error}`}
            >
                ${retry.error}
            </span>`
        }
        ${
            live.busy &&
            canSteer() &&
            !COARSE.matches &&
            html`<span class="live-esc" title="Press Esc twice">Esc stops</span>`
        }
    </div>`;
}

/**
 * Which rows to render: from the row `store.state.transcriptFrom` names down. Older rows wait behind "Show earlier
 * messages", so opening a long session and streaming into it stay fast on a phone. Without that row (none chosen yet,
 * or gone after a compaction), the newest `TRANSCRIPT_ROWS`.
 */
function windowStart(rows, from) {
    const index = from === null ? -1 : rows.findIndex((row) => row.id === from);

    return index === -1 ? Math.max(0, rows.length - TRANSCRIPT_ROWS) : index;
}

export function Transcript() {
    const { view, missing, history, transcriptFrom } = store.state;
    const scroller = useRef(null);
    const stick = useRef(true);
    /** Distance from the bottom to restore after rows are added above, so the reader stays in place. */
    const keep = useRef(null);
    const counted = useRef(0);
    const [showJump, setShowJump] = useState(false);

    const entries = view.order.map((id) => view.entries.get(id)).filter(Boolean);
    const rows = entries.filter(isRow);
    const start = windowStart(rows, transcriptFrom);

    useLayoutEffect(() => {
        const element = scroller.current;

        if (!element) {
            return;
        }

        if (keep.current !== null) {
            element.scrollTop = element.scrollHeight - keep.current;
            keep.current = null;
        } else if (stick.current) {
            element.scrollTop = element.scrollHeight;
        }

        const grew = rows.length > counted.current;

        counted.current = rows.length;

        if (rows.length === 0) {
            return;
        }

        // Fix the first row shown, so rows arriving below never push the ones being read off the top. While the reader
        // follows along at the bottom, drop the oldest once there are twice as many as a fresh open shows.
        if (rows[start].id !== transcriptFrom) {
            store.set({ transcriptFrom: rows[start].id });
        } else if (grew && stick.current && rows.length - start > 2 * TRANSCRIPT_ROWS) {
            store.set({ transcriptFrom: rows[rows.length - TRANSCRIPT_ROWS].id });
        }
    });

    // Once the rows a session opens with are on screen, rows that mount later are new and animate in.
    const conversationId = view.conversation?.id;
    const hasRows = rows.length > 0;

    useEffect(() => {
        settledFor = null;

        if (conversationId === undefined) {
            return;
        }

        const timer = setTimeout(() => (settledFor = conversationId), hasRows ? 350 : 0);

        return () => clearTimeout(timer);
    }, [conversationId, hasRows]);

    // The conversation gets shorter or taller as what is above the message box changes (the queue, the subagents' list,
    // a message box that grows): stay at the bottom if we were there, before the change shows.
    useEffect(() => {
        const element = scroller.current;

        if (!element) {
            return;
        }

        // Not while a finger moves it, or it glides after one: where it goes is the person's, and on an iPhone a scroll
        // set from script mid-glide does not hold (see `toBottom`).
        let touching = false;
        // Never yet: the page's clock starts at 0 when it loads, so 0 would read as a finger let go just now.
        let released = -Infinity;
        let moved = -Infinity;

        const down = () => {
            touching = true;
        };

        const up = () => {
            touching = false;
            released = performance.now();
        };

        const scrolled = () => {
            moved = performance.now();
        };

        const gliding = () =>
            touching ||
            (performance.now() - released < GLIDE_MS && performance.now() - moved < 100);
        const observer = new ResizeObserver(() => {
            if (stick.current && !gliding()) {
                element.scrollTop = element.scrollHeight;
            }
        });

        element.addEventListener("touchstart", down, { passive: true });
        element.addEventListener("touchend", up, { passive: true });
        element.addEventListener("touchcancel", up, { passive: true });
        element.addEventListener("scroll", scrolled, { passive: true });
        observer.observe(element);

        return () => {
            observer.disconnect();
            element.removeEventListener("touchstart", down);
            element.removeEventListener("touchend", up);
            element.removeEventListener("touchcancel", up);
            element.removeEventListener("scroll", scrolled);
        };
    }, [view.conversation?.id]);

    // Images finish loading after the transcript renders and make it taller: stay at the bottom if we were there.
    useEffect(() => {
        const element = scroller.current;

        if (!element) {
            return;
        }

        const onLoad = (event) => {
            if (event.target?.tagName === "IMG" && stick.current) {
                element.scrollTop = element.scrollHeight;
            }
        };

        element.addEventListener("load", onLoad, true);

        return () => element.removeEventListener("load", onLoad, true);
    }, [view.conversation?.id]);

    // A `!` command whose entry arrived is no longer pending.
    const shells = rows.filter((row) => row.kind === "shell").length;

    useEffect(() => {
        const pending = store.state.pendingShells;
        const left = pending.filter(
            (each) =>
                Date.now() - each.at < PENDING_MS &&
                !rows.some((row) => row.kind === "shell" && row.taskId === each.taskId),
        );

        if (left.length !== pending.length) {
            store.set({ pendingShells: left });
        }
    }, [shells]);

    const onScroll = () => {
        const element = scroller.current;
        const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 60;

        stick.current = atBottom;

        if (showJump === atBottom) {
            setShowJump(!atBottom);
        }
    };

    if (missing) {
        return html`<main class="scroller">
            <div class="empty">
                <p>${missing}</p>
                <button class="button" onClick=${() => navigate(null)}>All sessions</button>
            </div>
        </main>`;
    }

    if (!view.conversation) {
        const { connection, sessions, conversationId } = store.state;
        const title = sessions.find((session) => session.id === conversationId)?.title;
        const caption =
            connection === "connecting"
                ? "connecting"
                : connection === "open"
                  ? "loading session"
                  : "reconnecting";

        return html`<main class="scroller">
            <${Boot} inline caption=${caption} detail=${title ?? ""} />
        </main>`;
    }

    const keepPlace = () => {
        // Earlier rows arriving above are not new: they appear without sliding in.
        const id = view.conversation?.id;

        settledFor = null;
        setTimeout(() => (settledFor = id), 400);
        const element = scroller.current;

        if (!element) {
            return;
        }

        keep.current = element.scrollHeight - element.scrollTop;
        stick.current = false;
    };

    const showEarlier = () => {
        keepPlace();
        store.set({ transcriptFrom: rows[Math.max(0, start - TRANSCRIPT_ROWS)].id });
    };

    const results = new Map();

    for (const entry of [...(history ?? []), ...entries]) {
        if (entry.kind === "toolResult") {
            results.set(entry.callId, entry);
        }
    }

    const slots = new Map((view.live.tools ?? []).map((slot) => [slot.callId, slot]));
    const approvals = view.approvals ?? [];
    const first = entries[0];
    const partial = partialEntry(view.live.generation?.message?.blocks ?? []);
    const busy = view.live.busy;
    const compacting = (view.live.compactions ?? []).length > 0;
    const conversation = view.conversation;
    const started = runStart(conversation.id, entries, busy);
    // Only a session this person can see is in their list.
    const { sessions, sessionsLoaded } = store.state;
    const source =
        conversation.forkedFrom && sessions.find((each) => each.id === conversation.forkedFrom.id);

    return html`<main class="scroller" ref=${scroller} onScroll=${onScroll}>
        <div class="transcript">
            ${
                conversation.parent &&
                html`<button class="breadcrumb" onClick=${() => navigate(conversation.parent.id)}>
                    <${Icon} name="back" size=${14} /> ${conversation.parent.title}
                </button>`
            }
            ${
                conversation.forkedFrom &&
                sessionsLoaded &&
                (source
                    ? html`<button class="breadcrumb" onClick=${() => navigate(source.id)}>
                        <${Icon} name="fork" size=${14} /> Forked from ${source.title ?? "New session"}
                    </button>`
                    : html`<p class="muted small">
                        <${Icon} name="fork" size=${14} /> Forked from another session
                    </p>`)
            }
            ${
                start > 0
                    ? html`<div class="divider">
                        <button class="link" onClick=${showEarlier}>Show earlier messages</button>
                    </div>`
                    : first &&
                      (first.kind === "compaction" || first.kind === "reset") &&
                      html`<${History}
                          firstId=${first.id}
                          results=${results}
                          keepPlace=${keepPlace}
                          conversationId=${conversation.id}
                      />`
            }
            ${
                entries.length === 0 &&
                !view.live.busy &&
                html`<div class="empty hint">
                    <div class="pi">π</div>
                    <p>
                        ${conversation.kind === "subagent" ? "This subagent has no messages yet." : "Ask anything. Pi works in this session's folder, and keeps working if the server restarts."}
                    </p>
                </div>`
            }
            <${Items}
                items=${itemsOf(rows.slice(start), partial, {
                    from: rowsBefore(rows, start, collab()),
                    talk: collab(),
                })}
                results=${results}
                slots=${slots}
                approvals=${approvals}
                busy=${busy}
                conversationId=${conversation.id}
            />
            <${PendingShells} conversationId=${conversation.id} rows=${rows} />
            ${approvals.map(
                (approval) => html`<${ApprovalCard} key=${approval.id} approval=${approval} />`,
            )}
            ${
                (busy || compacting) &&
                html`<${LiveLine} live=${view.live} approvals=${approvals} start=${started} />`
            }
        </div>
        ${
            showJump &&
            html`<button
                class="jump"
                aria-label="To the bottom"
                onClick=${() => {
                    stick.current = true;
                    toBottom(scroller.current);
                    setShowJump(false);
                }}
            >
                <${Icon} name="down" />
            </button>`
        }
    </main>`;
}
