// The conversation, as a column of turns: a person's message, then what Pi did (its thinking and tool calls folded
// into one line that opens into a timeline), then Pi's reply, any approval, and the live line while Pi works.
import { Component } from "preact";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { activityOpen } from "./activity-fold.js";
import { initials, personColor } from "./avatar.js";
import { routeSliding } from "./back.js";
import { browserAvailable, setBrowserOpen } from "./browser.js";
import { describeCall, describersRevision } from "./calls.js";
import { DiffBlock } from "./diff.js";
import { LinkedSessions } from "./linked-sessions.js";
import { splitQuote } from "./quote-text.js";
import { fromServer } from "./seen.js";
import { defineItem, slotItems, slotKey } from "./slots.js";
import { Highlighted, InlineArtifact } from "./rich.js";
import {
    actions,
    attempt,
    canSteer,
    collab,
    discuss,
    isRow,
    loadEarlier,
    loadedFrom,
    navigate,
    notify,
    openSheet,
    store,
    TRANSCRIPT_ROWS,
} from "./store.js";
import { openSubagent, stateOf } from "./subagents.js";
import { prefs } from "./theme.js";
import {
    diffCounts,
    INLINE_TOOL,
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
    Boot,
    clockTime,
    copyText,
    entryImageUrl,
    fileUrl,
    html,
    Icon,
    Markdown,
    openFile,
    plainText,
    readable,
    replyText,
    Spinner,
    splitAttachments,
    Thumb,
} from "./ui.js";
import { LessonCall, memoryAvailable } from "./sheets/memory.js";

const REPORT = /^\[subagent (\S+) (answered|failed)([^\]]*)\]\s?([\s\S]*)$/;
/** Where the next report starts, in a message of several that arrived together (`extensions/subagents.ts`). */
const NEXT_REPORT = /\n\n(?=\[subagent \S+ (?:answered|failed))/;

/**
 * A background task's message to Pi (`background.ts`): its head line, its command, and the end of its output fenced.
 * Its time is short ("2m 04s"), which keeps a long line that is not one quick to turn down.
 */
const BACKGROUND =
    /^\[background\] Task (\S+) (.+?) after ([^.\n]{1,20})\.\nCommand: (.*)\n([\s\S]*)$/;
const OUTPUT_OPEN = "<background-output>\n";
const OUTPUT_CLOSE = "\n</background-output>";

/** The output fenced in a background task's message, or undefined when it printed nothing. */
function fencedOutput(rest) {
    const start = rest.indexOf(OUTPUT_OPEN);
    const end = start < 0 ? -1 : rest.indexOf(OUTPUT_CLOSE, start + OUTPUT_OPEN.length);

    return end < 0 ? undefined : rest.slice(start + OUTPUT_OPEN.length, end);
}

/** How a scheduled message starts (see src/server/schedules.ts). */
const SCHEDULED = "[scheduled] ";

/** A message the app sent for a person, and what sent it: PiP, a PR watch, a webhook (`submit` in src/server/commands.ts). */
const VIA = /^\[via ([^\]\n]{1,300})\] /;
/** What came from outside in such a message, fenced as data for Pi: a check's log, a webhook's post, GitHub's events. */
const FENCED =
    /<(ci-log|webhook-payload|github-event)((?: [a-z]+="[^"\n]*")*)>\n([\s\S]*?)\n<\/\1>/g;
const FENCE_LABELS = { "webhook-payload": "What was posted", "github-event": "On GitHub" };

/** A message from the app with what it fenced for Pi shown as blocks of its own, named after what each is. */
function FencedText({ text }) {
    const parts = [];
    let last = 0;

    for (const match of text.matchAll(FENCED)) {
        const name = /"([^"]*)"/.exec(match[2])?.[1];
        const label =
            match[1] === "ci-log"
                ? `Log of ${name ?? "a check"}`
                : match[1] === "github-event"
                  ? `On GitHub${name ? `: ${name}` : ""}`
                  : (name ?? FENCE_LABELS[match[1]]);

        parts.push(
            html`<${MentionedText} text=${text.slice(last, match.index).replace(/\n$/, "")} />`,
        );
        parts.push(html`<div class="fenced-data">
            <div class="fenced-label">${label}</div>
            <pre>${readable(match[3])}</pre>
        </div>`);
        last = match.index + match[0].length;
    }

    parts.push(html`<${MentionedText} text=${text.slice(last).replace(/^\n\n?/, "")} />`);

    return parts;
}

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
                html`<button class="link" onClick=${() => openSubagent(child.conversationId)}>
                    Open →
                </button>`
            }
        </div>
        ${why && html`<div class="report-why">${why}</div>`}
        ${text && html`<${Collapsible} text=${text} />`}
    </div>`;
}

/** A background task that ended, as a card for people: its id and outcome, its command, and its output folded away. */
function BackgroundReport({ match }) {
    const [, id, outcome, took, command, rest] = match;
    const output = fencedOutput(rest);

    return html`<div class="report background-report">
        <div class="report-head">
            <span class="report-name">${id}</span> ${outcome} · ${took}
        </div>
        ${command !== undefined && html`<div class="background-command muted small mono">${command}</div>`}
        ${
            output === undefined
                ? html`<div class="muted small">It printed nothing.</div>`
                : html`<${BackgroundOutput}
                      text=${output}
                      clipped=${rest.startsWith("The end of its output")}
                  />`
        }
    </div>`;
}

/** Lines of a background task's output shown while it is folded: its last ones, where an error usually is. */
const OUTPUT_LINES = 8;

/** A background task's output as it printed it, folded to its last lines; `clipped` when the task printed more. */
function BackgroundOutput({ text, clipped }) {
    const [open, setOpen] = useState(false);
    const lines = text.split("\n");
    const folds = lines.length > OUTPUT_LINES;
    const shown = folds && !open ? lines.slice(-OUTPUT_LINES).join("\n") : text;

    return html`<div class="background-output">
        ${clipped && html`<div class="muted small">The end of its output:</div>`}
        <pre>${shown}</pre>
        ${
            folds &&
            html`<button class="link" onClick=${() => setOpen(!open)}>
                ${open ? "Show less" : `Show all ${lines.length} lines`}
            </button>`
        }
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

/** Who a wait for a limit is for: the provider by the name people know it by, and the model when only it waits. */
function limitWho({ provider, modelId, scope }) {
    const names = {
        anthropic: "Claude",
        "openai-codex": "ChatGPT",
        openai: "OpenAI",
        "opencode-go": "OpenCode Go",
        openrouter: "OpenRouter",
    };
    const name = names[provider] ?? provider;

    return scope === "model" && modelId ? `${name} ${modelId}'s limit` : `${name}'s limit`;
}

/** When a message was sent, from the server's time: "10:42" today, "Oct 3 10:42" before. */
const clock = (at) => clockTime(new Date(fromServer(at)));

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

    // A background task's message: nobody typed it, so a person writing "[background]" themselves keeps it theirs.
    const background =
        entry.from === undefined && !view.authors?.[entry.id] ? BACKGROUND.exec(entry.text) : null;

    if (background) {
        return html`<${BackgroundReport} match=${background} />`;
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
    const [written, attachments] = splitAttachments(entry.text);
    // Set up earlier to go out now: by a person (who shows as its author) or by Pi.
    // Only a message nobody typed: someone writing "[via …]" themselves gets no label.
    const via = authorId === undefined ? VIA.exec(written) : null;
    const sent = via ? written.slice(via[0].length) : written;
    const scheduled = sent.startsWith(SCHEDULED);
    // A linked session's message: shown by its label and its fence alone, so the words before the fence (which tell Pi
    // how to read it) can change without changing how older messages show.
    const peerText =
        via && /^linked session \S+$/.test(via[1])
            ? /\n<linked-session-message>\n([\s\S]*)\n<\/linked-session-message>$/.exec(sent)?.[1]
            : undefined;
    const body = peerText ?? (scheduled ? sent.slice(SCHEDULED.length) : sent);
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

    // Who it is from, for themes: you, someone else, a linked session, or no one the app knows (Pi's schedule, the main
    // agent, a watch or a webhook).
    const from =
        peerText !== undefined
            ? "linked"
            : authorId === undefined
              ? "other"
              : authorId === store.state.me?.id
                ? "me"
                : "person";

    return html`<div
        class=${`user-row ${fresh ? "enter" : ""}`}
        data-part="prompt-row"
        id=${`entry-${entry.id}`}
    >
        <div
            class="prompt tappable"
            data-part="prompt"
            data-from=${from}
            title="Edit, send again, or copy"
            tabindex="0"
            onClick=${(event) => openMessage(event, entry.id)}
            onKeyDown=${(event) => {
                if (
                    (event.key === "Enter" || event.key === " ") &&
                    event.target === event.currentTarget
                ) {
                    event.preventDefault();
                    openMessage(event, entry.id);
                }
            }}
        >
            <span class="prompt-head" data-part="prompt-head">
                <span
                    class="prompt-avatar"
                    data-part="author-mark"
                    style=${`--who:${mark}`}
                    aria-hidden="true"
                >
                    ${name ? initials(name) : "›"}
                </span>
                ${name && html`<b class="prompt-author" data-part="prompt-author">${name}</b>`}
                ${entry.at && html`<span class="prompt-time">${clock(entry.at)}</span>`}
                ${scheduled && html`<span class="prompt-time">· scheduled</span>`}
                ${via && html`<span class="prompt-time">· via ${peerText === undefined ? via[1] : "a linked session"}</span>`}
            </span>
            <div class="prompt-body" data-part="prompt-text">
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
                        ${
                            via
                                ? html`<${FencedText} text=${body} />`
                                : html`<${QuotedText} text=${skill ? skill[3] : body} />`
                        }
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

function QuotedText({ text }) {
    const quote = splitQuote(text);

    if (!quote) {
        return html`<${MentionedText} text=${text} />`;
    }

    return html`<blockquote class="reply-quote" data-part="reply-quote">${quote.passage}</blockquote>
        ${quote.rest && html`<${MentionedText} text=${quote.rest} />`}`;
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

/** The tools that publish artifacts: `artifact_inline` also shows its page as a card in the reply. */
const isArtifactCall = (name) => name === "artifact" || name === INLINE_TOOL;

/** What a step's mark says, by how the call went; a call still running shows a spinner instead. */
const MARKS = { done: "✓", error: "×", denied: "×", stopped: "–", approval: "!" };

/**
 * The waiting and running calls' statuses as the mark's own look names: `approval` and `running` are also the card
 * classes in `style.css`, whose padding, border, and layout must not sit on the mark.
 */
const MARK_LOOKS = { approval: "asking", running: "spinning" };

/** A step's mark: a small circle that says how it went. A thought is ✦, and a subagent's call ⑂ unless it failed. */
function StepMark({ status, kind }) {
    const agent = kind === "agent" && (status === "done" || status === "running");
    const spinning = kind !== "thought" && !agent && status === "running";
    const look = kind === "thought" ? "thought" : agent ? "agent" : (MARK_LOOKS[status] ?? status);
    const mark = kind === "thought" ? "✦" : agent ? "⑂" : MARKS[status];

    return html`<span
        class=${`step-mark ${look}`}
        data-part="step-mark"
        aria-hidden=${spinning ? undefined : "true"}
    >
        ${spinning ? html`<${Spinner} />` : mark}
    </span>`;
}

/** What Pi did with its memory tool, as a step's label. */
const MEMORY_WORDS = {
    add: "saved a lesson",
    update: "changed a lesson",
    remove: "forgot a lesson",
    list: "read its lessons",
};

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
        case "memory":
            return {
                label: MEMORY_WORDS[args.action] ?? "memory",
                subject: args.text ? short(args.text) : (args.id ?? ""),
            };
        case "watch_pr":
            return { label: "watch PR", subject: [args.action, args.pr].filter(Boolean).join(" ") };

        default: {
            const described = describeCall(call);

            // An extension's own words for its tool, or the tool's name.
            return {
                label: described.own ? described.label : call.name,
                subject: described.subject,
            };
        }
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

    // A call whose result is not stored yet has nothing to count, nor one whose input or output came light, as a session
    // opens (`partial`): it is counted when it comes whole, an instant later.
    if (status !== "done" || !result || result.partial || call.partial) {
        return null;
    }

    const text = result.text ?? "";
    const args = call.args ?? {};

    switch (call.name) {
        case "edit": {
            const counts = diffCounts(details?.diff);

            return counts && { text: `+${counts.added} −${counts.removed}`, tone: "ok", counts };
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
        case "artifact_inline":
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

/** A call's state for themes (`data-state`), by its status: documented names that stay when the statuses change. */
const CALL_STATES = {
    approval: "waiting",
    denied: "denied",
    running: "running",
    done: "ok",
    error: "failed",
    stopped: "stopped",
};

/**
 * Who allowed or denied a call. A script's own calls are asked about one by one (`<call>/<n>`): for the script, the one
 * denied when it failed, or else the last one allowed.
 */
function decisionOf(decisions, call, result) {
    const own = decisions?.[call.id];

    if (own !== undefined || call.name !== "codemode") {
        return own;
    }

    const inner = Object.entries(decisions ?? {}).flatMap(([id, each]) =>
        id.startsWith(`${call.id}/`) ? [each] : [],
    );

    return (
        (result?.isError ? inner.find((each) => each.allow === false) : undefined) ??
        inner.findLast((each) => each.allow !== false)
    );
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

/**
 * `unrolling` for what a person opened just now (`unrolled`, when they tapped it): it unrolls (style.css). What opens by
 * itself, as a session opens or a group goes live, shows at once. Never tapped is -Infinity, not 0: the page's clock
 * starts at 0 as it loads, so 0 would read as a tap just now.
 */
const unrolling = (unrolled) => (performance.now() - unrolled.current < 600 ? "unrolling" : "");

/** A thought, on the timeline: open it to read it. */
function ThoughtStep({ block, streaming, reading }) {
    // With Show thinking on, a thought once written shows its words (the live line shows the one being written).
    const [chosen, setChosen] = useState(null);
    const unrolled = useRef(-Infinity);
    // One whose words have not come yet (`partial`, as a session opens) opens once they have, if it was asked to.
    const open =
        !block.partial && (chosen ?? (reading && !streaming && Boolean(block.text?.trim())));

    return html`<div
        class=${`step ${open ? "open" : ""}`}
        data-part="thinking"
        data-status=${streaming ? "running" : "done"}
    >
        <div class="step-line">
            <button
                class="step-head"
                data-part="step-head"
                aria-expanded=${open}
                onClick=${() => {
                    unrolled.current = open ? -Infinity : performance.now();
                    setChosen(!open);
                }}
            >
                <${StepMark} status=${streaming ? "running" : "done"} kind="thought" />
                <span class="step-label" data-part="step-label">
                    ${streaming ? "Thinking" : block.redacted ? "Thought (redacted)" : "Thought"}
                </span>
                <span class="step-subject"></span>
                ${streaming && html`<${Spinner} label="Thinking" />`}
            </button>
        </div>
        ${
            open &&
            html`<div class=${`step-body ${unrolling(unrolled)}`} data-part="step-detail">
                <div class="thought-body">${block.text}</div>
            </div>`
        }
    </div>`;
}

/** One tool call on the timeline: what it did and how it went, and tapped, its input and output. */
function ToolStep({
    call,
    result,
    slot,
    approval,
    entryId,
    streaming,
    canRun,
    busy,
    conversationId,
}) {
    const [open, setOpen] = useState(false);
    const unrolled = useRef(-Infinity);
    const [full, setFull] = useState(null);
    const view = store.state.view;
    const decision = decisionOf(view.decisions, call, result);
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

    // An image a read returned is already on screen elsewhere: it shows only when the call is opened.
    const imagesInside = call.name === "read";
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

        if (imagesInside && result?.images > 0) {
            parts.push(
                html`<${EntryImages}
                    entryId=${result.id}
                    count=${result.images}
                    label=${`${call.name} image`}
                />`,
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

        if (isArtifactCall(call.name) && (args.content || args.edits)) {
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
                "artifact_inline",
                "codemode",
                "browser",
            ].includes(call.name)
        ) {
            parts.push(html`<pre class="output">${JSON.stringify(args, null, 2)}</pre>`);
        }

        // The harness's own errors come wrapped in its tags, after the output if any: what it says is inside them.
        const output = (resultText ?? slot?.output)
            ?.replace(
                /(^|\n)<harness>([\s\S]*?)<\/harness>\s*$/,
                (_, before, note) => before + note.trim(),
            )
            .replace(/^<harness>\s*/, "");

        if (output && !(call.name === "edit" && details?.diff && !result?.isError)) {
            parts.push(
                html`<pre class=${`output ${result?.isError ? "error" : ""}`}>${output}</pre>`,
            );
        }

        // A call still streaming has no stored entry to load yet.
        if (clipped && entryId !== undefined) {
            parts.push(html`<button class="link" onClick=${loadFull}>Load everything</button>`);
        }

        body = html`<div class=${`step-body ${unrolling(unrolled)}`} data-part="step-detail">
            ${parts}
        </div>`;
    }

    const artifact = isArtifactCall(call.name) && details?.id ? details : null;
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
    // A lesson Pi saved, changed, or forgot: its state, and approving it where it happened.
    const lesson =
        call.name === "memory" &&
        typeof details?.lesson === "string" &&
        memoryAvailable(conversationId)
            ? details.lesson
            : null;
    const imagesUnder = result?.images > 0 && !imagesInside;
    const answers =
        call.name === "ask" && !result?.isError && Array.isArray(details?.answers)
            ? details.answers
            : null;
    const extras = imagesUnder || artifact || watch || lesson || answers;

    return html`<div
        class=${`step ${open ? "open" : ""} ${settled ? "settled" : ""}`}
        data-part="tool-call"
        data-state=${CALL_STATES[status]}
        data-status=${status}
    >
        <div class="step-line">
            <button
                class="step-head"
                data-part="step-head"
                aria-expanded=${open}
                onClick=${() => {
                    unrolled.current = open ? -Infinity : performance.now();
                    setOpen(!open);
                }}
            >
                <${StepMark} status=${status} kind=${call.name === "subagent" ? "agent" : ""} />
                <span class="step-label" data-part="step-label">${label}</span>
                <span class="step-subject">${subject}</span>
                ${
                    said &&
                    html`<span class=${`step-meta ${said.tone}`}>
                        ${
                            said.counts
                                ? html`<span class="ok">+${said.counts.added}</span>${" "}<span class="err">−${said.counts.removed}</span>`
                                : said.text
                        }
                    </span>`
                }
            </button>
            ${
                child !== undefined &&
                html`<button
                    class="step-open"
                    title=${`Open ${args.name ?? "the subagent"}`}
                    onClick=${() => openSubagent(child)}
                >
                    Open →
                </button>`
            }
        </div>
        ${
            decision &&
            html`<div
                class=${`step-decision ${decision.allow ? "allowed" : "denied"}`}
                title=${new Date(decision.at).toLocaleString()}
            >
                <${Icon} name="shield" size=${13} /> ${decided(decision)} by ${decision.by}
            </div>`
        }
        ${
            extras &&
            html`<div class="step-extras" data-part="step-detail">
                ${answers && html`<${AskAnswers} answers=${answers} />`}
                ${
                    lesson &&
                    html`<${LessonCall} lessonId=${lesson} conversationId=${conversationId} />`
                }
                ${
                    imagesUnder &&
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
 * An open group draws its newest steps, this many, and a button for the rest: a long run of Pi's alone can be hundreds of
 * steps, which made opening its session freeze on a phone. Groups shown in full, by hand or by a jump, are kept here.
 */
const GROUP_STEPS = 24;
const wholeGroups = new Map();
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
 * newest turn, closed before, unless opened or closed by hand; Appearance's Keep activity folded starts every group
 * closed.
 */
function ActivityGroup({
    item,
    live,
    newest,
    after,
    busy,
    results,
    slots,
    approvals,
    conversationId,
}) {
    const id = `${conversationId}:${item.key}`;
    const [, redraw] = useState(0);
    const [fresh] = useState(() => settledFor !== null && settledFor === conversationId);
    // When a click opened it: it unrolls, and with Fluid motion its first steps drop in one after another (style.css).
    const unrolled = useRef(-Infinity);

    if (
        revealing.entryId !== null &&
        Date.now() - revealing.at < 2000 &&
        item.anchors.includes(revealing.entryId)
    ) {
        keep(openedGroups, id, true);
        keep(wholeGroups, id, true);
    }

    const all = item.before.length === 0 ? item.steps : [...item.before, ...item.steps];
    // A thought alone is the group's own line, not a step under a line that says the same: it opens to its words,
    // which stay folded until asked for, as a thought on the timeline does.
    const lone = all.length === 1 && all[0].block.type === "thinking" ? all[0] : null;
    // Show thinking on: thoughts show their words once written.
    const reading = prefs().showThinking === true;
    const open = activityOpen({
        chosen: openedGroups.get(id),
        lone: lone && {
            partial: lone.block.partial,
            streaming: lone.streaming,
            text: lone.block.text,
        },
        live,
        newest,
        reading,
        // Appearance's Keep activity folded.
        fold: prefs().foldActivity === true,
    });
    // Calls that failed, said on the line too: folded, "edited 1" alone would read as done. A call someone denied did
    // not fail, nor a script stopped by a denial: its line says who denied it.
    const failed = all.filter((step) => {
        const result = step.block.type === "toolCall" ? results.get(step.block.id) : undefined;

        return (
            result?.isError === true &&
            !STOPPED.test(result.text ?? "") &&
            decisionOf(store.state.view.decisions, step.block, result)?.allow !== false
        );
    }).length;
    const first = all[0];
    let start = first.entry?.at === undefined ? undefined : fromServer(first.entry.at);

    if (start === undefined && first.entry === undefined) {
        if (!groupSeen.has(id)) {
            keep(
                groupSeen,
                id,
                after === undefined ? Date.now() : Math.min(Date.now(), fromServer(after)),
            );
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
    // The steps not drawn yet, the oldest: each still names the steps after it (below), so keys stay as they were.
    const hidden = wholeGroups.get(id) ? 0 : Math.max(0, item.steps.length - GROUP_STEPS);

    useEffect(() => {
        if (anchors === "") {
            return;
        }

        const reveal = (event) => {
            if (item.anchors.includes(event.detail)) {
                keep(openedGroups, id, true);
                keep(wholeGroups, id, true);
                redraw((n) => n + 1);
            }
        };

        document.addEventListener("pocket:reveal", reveal);

        return () => document.removeEventListener("pocket:reveal", reveal);
    }, [anchors, id]);

    return html`<div
        class=${`activity ${open ? "open" : ""} ${fresh ? "enter" : ""}`}
        data-part="activity"
        data-state=${open ? "open" : undefined}
    >
        ${item.anchors.map(
            (entryId) => html`<span class="entry-anchor" id=${`entry-${entryId}`}></span>`,
        )}
        <button
            class="activity-head"
            data-part="activity-head"
            aria-expanded=${open}
            onClick=${() => {
                unrolled.current = open ? -Infinity : performance.now();
                keep(openedGroups, id, !open);
                redraw((n) => n + 1);
            }}
        >
            <${Icon} name="chevron" size=${14} class="chev" part="activity-chevron" />
            <span class="activity-summary">${summarize(all, thinking)}</span>
            ${failed > 0 && html`<span class="activity-failed">${failed} failed</span>`}
            <${GroupTime} id=${id} start=${start} end=${end} live=${live} />
        </button>
        ${
            open &&
            lone &&
            html`<div class=${`activity-thought ${unrolling(unrolled)}`}>
                <div class="thought-body">${lone.block.text}</div>
            </div>`
        }
        ${
            open &&
            !lone &&
            html`<div
                class=${`timeline ${unrolling(unrolled)}`}
                data-part="timeline"
            >
                ${
                    hidden > 0 &&
                    html`<button
                        class="link timeline-earlier"
                        data-part="timeline-earlier"
                        onClick=${() => {
                            keep(wholeGroups, id, true);
                            redraw((n) => n + 1);
                        }}
                    >
                        Show ${hidden} earlier ${hidden === 1 ? "step" : "steps"}
                    </button>`
                }
                ${item.steps.map(({ block, entry, streaming, canRun }, index) => {
                    // A call is named by its id, the same streamed and stored; a thought by the call before it. Not by
                    // place: earlier steps join the front when earlier messages show.
                    if (block.type === "thinking") {
                        const key = `t:${lastCall}:${thoughts++}`;

                        return (
                            index >= hidden &&
                            html`<${Memo} key=${key} deps=${[block, streaming, reading]}>
                                <${ThoughtStep} block=${block} streaming=${streaming} reading=${reading} />
                            <//>`
                        );
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

                    if (index < hidden) {
                        return null;
                    }

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
                            conversationId=${conversationId}
                        />
                    <//>`;
                })}
            </div>`
        }
    </div>`;
}

/**
 * A page Pi showed in its reply (`artifact_inline`): its card once the call has published, between the words around
 * it. Until then, and if the call failed, was denied, or stopped, its step as the timeline draws it, so the reason shows.
 */
function InlineRow({ item, results, slots, approvals, busy, conversationId }) {
    const { block, entry, canRun } = item.step;
    const result = results.get(block.id);
    const details = result?.details;
    const slot = slots.get(block.id);
    const approval =
        slot?.taskId === undefined
            ? undefined
            : approvals.find((each) => each.taskId === slot.taskId);
    const published =
        result !== undefined &&
        !result.isError &&
        details?.inline === true &&
        typeof details.id === "string" &&
        Number.isInteger(details.version);

    return html`<div class="inline-row">
        ${item.anchors.map(
            (entryId) => html`<span class="entry-anchor" id=${`entry-${entryId}`}></span>`,
        )}
        ${
            published
                ? html`<${InlineArtifact}
                      conversationId=${conversationId}
                      id=${details.id}
                      title=${details.title ?? details.id}
                      version=${details.version}
                  />`
                : html`<div class="activity open">
                      <div class="timeline">
                          <${ToolStep}
                              call=${block}
                              result=${result}
                              slot=${slot}
                              approval=${approval}
                              entryId=${entry?.id}
                              streaming=${entry === undefined}
                              canRun=${canRun}
                              busy=${busy}
                              conversationId=${conversationId}
                          />
                      </div>
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

function AskChoices({ field, chosen, busy, onChange }) {
    const { picked, other } = chosen;

    const pick = (label) => {
        const on = picked.includes(label);
        const next = field.multiple
            ? on
                ? picked.filter((each) => each !== label)
                : [...picked, label]
            : [label];

        onChange({ picked: next, other: "" });
    };

    return html`<fieldset class="ask-choices" disabled=${busy}>
        <legend class="ask-question">
            ${field.header && html`<span class="ask-header">${field.header}</span>`}
            <span>${field.label}</span>
            ${field.multiple && html`<span class="ask-hint">Choose one or more</span>`}
        </legend>
        <div class="ask-options">
            ${field.choices.map(
                (choice) => html`<button
                    type="button"
                    class="ask-option"
                    key=${choice.label}
                    aria-pressed=${picked.includes(choice.label)}
                    onClick=${() => pick(choice.label)}
                >
                    <span class="ask-option-label">${choice.label}</span>
                    ${choice.description && html`<span class="ask-option-text">${choice.description}</span>`}
                </button>`,
            )}
        </div>
        ${
            field.other &&
            html`<input
                class="ask-other"
                type="text"
                aria-label=${`Your own answer to: ${field.label}`}
                placeholder=${field.placeholder ?? "Or type your own answer"}
                value=${other}
                onInput=${(event) => onChange({ picked: [], other: event.currentTarget.value })}
            />`
        }
    </fieldset>`;
}

function choiceValue(field, { picked, other }) {
    if (other.trim() !== "") {
        return other;
    }

    return field.choices
        .map((choice) => choice.label)
        .filter((label) => picked.includes(label))
        .join("\n");
}

/** Sent only by that person, and declined by anyone who can steer. Only the `ask` tool passes what is typed on to Pi. */
function AskCard({ approval }) {
    const { me, users } = store.state;
    const form = approval.form;
    const [values, setValues] = useState(() =>
        Object.fromEntries(
            form.fields.map((field) => [
                field.name,
                field.choices ? { picked: [], other: "" } : "",
            ]),
        ),
    );
    const [busy, setBusy] = useState(false);
    const owner = users?.find?.((each) => each.role === "owner")?.id;
    const mine = (approval.requestedBy ?? owner) === me?.id;
    const who =
        users?.find?.((each) => each.id === approval.requestedBy)?.name ??
        "the person Pi works for";
    const typed = Object.fromEntries(
        form.fields.map((field) => [
            field.name,
            field.choices ? choiceValue(field, values[field.name]) : values[field.name],
        ]),
    );
    const ready = form.fields.every((field) => typed[field.name] !== "");
    // Only a card of plain fields hides what is typed from Pi: the `ask` tool's answers are for Pi.
    const plain = form.fields.some((field) => !field.choices);

    const answer = (allow) => {
        setBusy(true);
        attempt(() => actions.approve(approval.id, allow, allow ? typed : undefined)).finally(() =>
            setBusy(false),
        );
    };

    return html`<form
        class="approval ask"
        data-part="approval"
        onSubmit=${(event) => {
            event.preventDefault();

            if (mine && ready && !busy) {
                answer(true);
            }
        }}
    >
        <div class="approval-head">
            <span class="approval-shield" aria-hidden="true"><${Icon} name="shield" size=${16} /></span>
            <div class="approval-title">
                <span class="approval-ask">${form.title}</span>
                ${form.text && html`<span class="approval-reason">${form.text}</span>`}
            </div>
        </div>
        ${
            mine
                ? html`${form.fields.map((field) =>
                      field.choices
                          ? html`<${AskChoices}
                                key=${field.name}
                                field=${field}
                                chosen=${values[field.name]}
                                busy=${busy}
                                onChange=${(chosen) => setValues({ ...values, [field.name]: chosen })}
                            />`
                          : html`<label class="ask-field" key=${field.name}>
                                <span>${field.label}</span>
                                <input
                                    type=${field.secret ? "password" : "text"}
                                    name=${field.name}
                                    value=${values[field.name]}
                                    placeholder=${field.placeholder ?? ""}
                                    autocomplete=${field.autocomplete ?? "off"}
                                    autocapitalize="off"
                                    spellcheck="false"
                                    disabled=${busy}
                                    onInput=${(event) =>
                                        setValues({
                                            ...values,
                                            [field.name]: event.currentTarget.value,
                                        })}
                                />
                            </label>`,
                  )}
                  ${
                      plain &&
                      html`<div class="muted small">
                          What you type goes to the page or tool that asked. Pi does not see it.
                      </div>`
                  }`
                : html`<div class="muted small">Waiting for ${who} to answer.</div>`
        }
        ${
            canSteer() &&
            html`<div class="approval-actions">
                <button type="button" class="button deny" disabled=${busy} onClick=${() => answer(false)}>
                    Decline
                </button>
                ${
                    mine &&
                    html`<button type="submit" class="button primary" disabled=${busy || !ready}>
                        ${form.submit}
                    </button>`
                }
            </div>`
        }
    </form>`;
}

function AskAnswers({ answers }) {
    return html`<dl class="ask-answers">
        ${answers.map(
            (each, at) => html`<div class="ask-answer" key=${at}>
                <dt>
                    <span class="ask-header">${each.header}</span>
                    <span>${each.question}</span>
                </dt>
                <dd>${each.answer}</dd>
            </div>`,
        )}
    </dl>`;
}

/** What someone did with a call that waited for them: an ask (`host.ask`) is answered or declined. */
function decided(decision) {
    if (decision.ask) {
        return decision.allow ? "Answered" : "Declined";
    }

    return decision.allow ? "Allowed" : "Denied";
}

function ApprovalCard({ approval }) {
    if (approval.form) {
        return html`<${AskCard} approval=${approval} />`;
    }

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

    return html`<div class="approval" data-part="approval">
        <div class="approval-head">
            <span class="approval-shield" aria-hidden="true"><${Icon} name="shield" size=${16} /></span>
            <div class="approval-title">
                <span class="approval-ask">Lancet Guard asks before this ${approval.tool} call</span>
                <span class="approval-reason">${approval.reason}</span>
            </div>
        </div>
        <pre class="cmd">${approval.tool === "bash" && html`<span class="cmd-sign">$ </span>`}${approval.subject}</pre>
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

// The actions under Pi's answers, after its reactions: the app's own items of the `reply` slot (slots.js), which a
// person can hide and reorder in Appearance, with extensions' before More, which stays last. Each gets the answer
// (`entry`, its `text`), whether it is pinned, and the reaction picker's state.
defineItem("reply", {
    id: "core:time",
    label: "Message time",
    order: 0,
    render: ({ entry }) => {
        if (!entry.at) {
            return null;
        }

        const at = new Date(fromServer(entry.at));

        return html`<time class="muted" dateTime=${at.toISOString()} title=${at.toLocaleString()}>
            ${clock(entry.at)}
        </time>`;
    },
});
defineItem("reply", {
    id: "core:react",
    label: "React",
    order: 100,
    render: ({ picking, setPicking, react }) =>
        html`<span class="reaction-host answer-tool">
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
                    ${(store.state.server?.reactions ?? []).map(
                        (emoji) => html`<button onClick=${() => react(emoji)}>${emoji}</button>`,
                    )}
                </span>`
            }
        </span>`,
});
defineItem("reply", {
    id: "core:discuss",
    label: "Discuss",
    order: 200,
    render: ({ entry, text }) =>
        html`<button
            class="answer-tool"
            onClick=${() => discuss(entry.id, plainText(text).replace(/\s+/g, " ").slice(0, 280))}
        >
            Discuss
        </button>`,
});
defineItem("reply", {
    id: "core:pin",
    label: "Pin",
    order: 300,
    render: ({ entry, pinned }) =>
        html`<button
            class="answer-tool"
            onClick=${() => attempt(() => actions.pin({ entryId: entry.id }))}
        >
            ${pinned ? html`<${Icon} name="pin" size=${12} /> Pinned` : "Pin"}
        </button>`,
});
defineItem("reply", {
    id: "core:copy",
    label: "Copy",
    order: 400,
    render: ({ text }) =>
        html`<button
            class="answer-tool"
            onClick=${() =>
                copyText(text).then(
                    () => notify("info", "Copied."),
                    () => notify("error", "Could not copy."),
                )}
        >
            Copy
        </button>`,
});
defineItem("reply", {
    id: "core:more",
    label: "More",
    order: 1000,
    fixed: true,
    render: ({ entry }) =>
        html`<button
            class="answer-tool"
            title="Fork, retry"
            onClick=${() => openSheet({ type: "message", entryId: entry.id })}
        >
            More
        </button>`,
});

/** Under Pi's answers: the message time, reactions, and ways to talk about it with the people here. */
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

    return html`<div class=${`answer-actions ${picking ? "picking" : ""}`} data-part="reply-actions">
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
        ${slotItems("reply", { entry, text, pinned, picking, setPicking, react }).map(({ node }) => node)}
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
        data-part="reply"
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
    const { entries } = store.state.view;
    const talk = collab();
    // Built again only when the history or the entries change, not on each draw of the transcript.
    const items = useMemo(
        () =>
            history === null
                ? []
                : itemsOf(
                      history.filter((entry) => isRow(entry) && !entries.has(entry.id)),
                      null,
                      { prefix: "h", talk },
                  ),
        [history, entries, talk],
    );

    if (history === null) {
        return html`<div class="divider">
            <button
                class="link"
                onClick=${() =>
                    attempt(async () => {
                        const earlier = await actions.history(firstId);
                        const current = store.state;

                        // A response belongs to the conversation and context that asked for it, not the one now open.
                        if (
                            current.conversationId !== conversationId ||
                            current.view.order[0] !== firstId
                        ) {
                            return;
                        }

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
            items=${items}
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

/**
 * What a command printed, as a card: a `!` command's, or an extension command's card. A long output shows its last lines
 * until opened, and one the server cut short loads in full on a tap.
 */
function OutputCard({ entry, command, meta, failed = false, longCommand = false, copy = false }) {
    const [open, setOpen] = useState(false);
    const [full, setFull] = useState(null);
    const output = (full ?? entry.output).replace(/\s+$/, "");
    const lines = output.split("\n");
    const long = lines.length > SHELL_LINES;
    const whole = async () =>
        full ?? (entry.truncated ? (await actions.fullEntry(entry.id)).output : entry.output);

    return html`<div class="shell-row" id=${`entry-${entry.id}`}>
        <div class=${`shell-card ${failed ? "failed" : ""} ${open ? "open" : ""}`}>
            <div class="shell-head">
                <span class="mono shell-command">${command}</span>
                <span class="muted small">${meta}</span>
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
                            setFull(await whole());
                            setOpen(true);
                        })}
                >
                    Load everything
                </button>`
            }
            ${
                copy &&
                html`<button
                    class="link small"
                    onClick=${() =>
                        attempt(async () => {
                            const text = await whole();

                            setFull(text);
                            await copyText(text);
                            notify("info", "Copied the output.");
                        })}
                >
                    Copy output
                </button>`
            }
        </div>
    </div>`;
}

/** An extension command's card: text for the people here, never in Pi's context. */
function CommandEntry({ entry }) {
    return html`<${OutputCard}
        entry=${entry}
        command=${`/${entry.command}`}
        meta=${`${entry.name} · not shown to Pi${entry.clipped ? " · only the end is kept" : ""}`}
        copy=${true}
    />`;
}

/** A command someone ran with `!` (or `!!`, which Pi does not see): what it printed, and how it ended. */
function ShellEntry({ entry }) {
    // A long command (a paste in it, say) shows its first lines until opened.
    const longCommand = entry.command.split("\n").length > 3 || entry.command.length > 240;
    const end =
        entry.status === "done"
            ? entry.code === 0
                ? ""
                : `exit ${entry.code}`
            : SHELL_ENDS[entry.status];

    return html`<${OutputCard}
        entry=${entry}
        command=${`$ ${entry.command}`}
        meta=${`${entry.name}${end ? ` · ${end}` : ""}${entry.context ? "" : " · not shown to Pi"}`}
        failed=${Boolean(end)}
        longCommand=${longCommand}
    />`;
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

/** How long after a tap or a key in the conversation what grows there is what the reader opened, not new rows. */
const OPENED_MS = 1000;

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

    if (entry.kind === "command") {
        return html`<${CommandEntry} entry=${entry} />`;
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

/** `agentsKey` for each list of subagents the server sent: every report and subagent call asks, on every draw. */
const agentsKeys = new WeakMap();
const NO_AGENTS = [];

/** The subagents as their rows and lines show them: who, where, and how they stand. */
function agentsKey(view) {
    const agents = view.subagents ?? NO_AGENTS;

    if (!agentsKeys.has(agents)) {
        agentsKeys.set(
            agents,
            agents
                .map(
                    (agent) =>
                        `${agent.name}:${agent.conversationId}:${stateOf(agent)}:${agent.askedAt ?? ""}:${agent.answeredAt ?? ""}`,
                )
                .join(),
        );
    }

    return agentsKeys.get(agents);
}

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
    const decision = decisionOf(view.decisions, block, results.get(block.id));
    const deps = [
        results.get(block.id),
        slot === undefined ? "" : JSON.stringify(slot),
        decision === undefined ? "" : JSON.stringify(decision),
        // How extensions describe their tools' calls (`pocket.toolCall`).
        describersRevision(),
    ];

    if (slot?.taskId !== undefined) {
        deps.push(approvals.find((each) => each.taskId === slot.taskId)?.id);
    }

    if (isArtifactCall(block.name)) {
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

/**
 * What a run of Pi's words shows besides its text: the answer's reactions and pin, who is looking, and the actions under
 * it (`actions`, the reply slot's `slotKey`, the same for every answer of a draw).
 */
function replyDeps(item, actions) {
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
        // The actions under it: the app's and extensions', as arranged (`slots.js`).
        actions,
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
    const actions = slotKey("reply");

    items.forEach((item, index) => {
        if (item.type === "row" && item.entry.kind === "user") {
            lastMessage = index;
        }
    });

    return items.flatMap((item, index) => {
        if (item.type === "row") {
            return html`<${Memo} key=${item.key} deps=${rowDeps(item.entry)}>
                <${EntryView} entry=${item.entry} />
            <//>`;
        }

        if (item.type === "inline") {
            const { block, entry, streaming, canRun } = item.step;

            return html`<${Memo}
                key=${item.key}
                deps=${[
                    block,
                    entry,
                    streaming,
                    canRun,
                    busy,
                    conversationId,
                    item.anchors.join(),
                    ...callDeps(block, results, slots, approvals),
                ]}
            >
                <${InlineRow}
                    item=${item}
                    results=${results}
                    slots=${slots}
                    approvals=${approvals}
                    busy=${busy}
                    conversationId=${conversationId}
                />
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
            return html`<${Memo} key=${item.key} deps=${replyDeps(item, actions)}>
                <${Reply} item=${item} conversationId=${conversationId} />
            <//>`;
        }

        const live =
            !past &&
            (item.steps.some((step) => stepLive(step, results, slots, approvals, busy)) ||
                (busy && index === items.length - 1));
        const newest = !past && index > lastMessage;
        // When what came before it was stored: a group still streaming began about then, also before a reload.
        const before = items[index - 1];
        const after = before?.entry?.at ?? before?.step?.entry?.at;
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
            after,
            prefs().showThinking === true,
            // Keep activity folded: a group drawn before the switch moved opens or folds with it.
            prefs().foldActivity === true,
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

        const group = html`<${Memo} key=${item.key} deps=${deps}>
            <${ActivityGroup}
                item=${item}
                live=${live}
                newest=${newest}
                after=${after}
                busy=${busy}
                results=${results}
                slots=${slots}
                approvals=${approvals}
                conversationId=${conversationId}
            />
        <//>`;
        const lastCall = item.steps.findLast((step) => step.block.type === "toolCall");

        // Stopped in a call, no answer follows to say so: the run ends here, as a stopped answer does.
        if (
            past ||
            busy ||
            index !== items.length - 1 ||
            !STOPPED.test(results.get(lastCall?.block.id)?.text ?? "")
        ) {
            return group;
        }

        return [
            group,
            html`<div key=${`${item.key}:stopped`} class="reply" data-part="reply">
                <div class="muted small">Stopped.</div>
            </div>`,
        ];
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
    const { me, server, users } = store.state;
    const owner = users?.find?.((each) => each.role === "owner")?.id;

    return (
        canSteer() &&
        approvals.some((approval) =>
            // An ask (`host.ask`) is for the person Pi works for, or the owner when nobody is known.
            approval.form
                ? (approval.requestedBy ?? owner) === me?.id
                : !(
                      server?.approvalRule === "others" &&
                      me?.role !== "owner" &&
                      approval.requestedBy === me?.id
                  ),
        )
    );
}

/**
 * The sessions whose live thinking is folded, in this tab. With Show thinking on, the thought shows until folded, and a
 * fold holds from one run to the next, and over a reload.
 */
const THINKING_FOLDED_KEY = "pocket.thinkingFolded";
const thinkingFolded = new Set(
    (() => {
        try {
            return JSON.parse(sessionStorage.getItem(THINKING_FOLDED_KEY) ?? "[]");
        } catch {
            return [];
        }
    })(),
);

/**
 * The active response is authoritative, even before it shares any thinking: never pass an old thought off as the new
 * one. While tools work, use only the latest response in this turn, even if it shared no thinking. Keys follow
 * responses and block positions, not text prefixes: two thoughts may start with the same words.
 */
function newestThought(generation, entries) {
    if (generation !== undefined) {
        const blocks = generation.message?.blocks ?? [];
        const index = blocks.findLastIndex((block) => block.type === "thinking");

        if (index === -1) {
            return null;
        }

        const previous = entries.findLast((entry) => entry.kind === "assistant")?.id;

        return {
            block: blocks[index],
            key: `live:${previous}:${generation.attempt}:${index}`,
            handoff: `${previous}:${index}`,
            writing: true,
            streaming: index === blocks.length - 1,
        };
    }

    for (let index = entries.length - 1; index >= 0; index--) {
        const entry = entries[index];

        if (entry.kind === "user") {
            break;
        }

        if (entry.kind !== "assistant") {
            continue;
        }

        const at = entry.blocks.findLastIndex((block) => block.type === "thinking");
        const previous = entries.findLast(
            (each, before) => before < index && each.kind === "assistant",
        )?.id;

        return at === -1
            ? null
            : {
                  block: entry.blocks[at],
                  key: `entry:${entry.id}:${at}`,
                  handoff: `${previous}:${at}`,
                  writing: false,
                  streaming: false,
              };
    }

    return null;
}

/**
 * A quiet reading area above the live line, separate from the timeline's Thought steps. Follow new words until the
 * reader scrolls up; follow again for a new thought, but not when the current response is saved for the tool phase.
 * Mounted only when open, and memoized away from the live timer: no selection, text diff, or layout work while hidden.
 */
function LiveThought({ generation, entries, id }) {
    const box = useRef(null);
    const follow = useRef(true);
    const previous = useRef(null);
    const thought = newestThought(generation, entries);
    const text = thought?.block.text ?? "";
    // A coalesced update can skip whole responses. Only the same response/block keeps the reader's scroll.
    const handedOff =
        previous.current?.writing === true &&
        thought?.writing === false &&
        previous.current.handoff === thought.handoff;

    if (thought?.key !== previous.current?.key && !handedOff) {
        follow.current = true;
    }

    previous.current = thought;

    useLayoutEffect(() => {
        if (follow.current) {
            box.current.scrollTop = box.current.scrollHeight;
        }
    }, [text, thought?.key]);

    const onScroll = () => {
        const element = box.current;

        follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 8;
    };

    const empty = text === "";
    const streaming = thought?.streaming && !empty;
    const label = empty ? "Thinking" : thought.writing ? "Current thought" : "Latest thought";
    const shown = !empty
        ? text
        : thought?.block.redacted
          ? "The model has hidden its thinking."
          : generation !== undefined && generation.message === undefined
            ? "Waiting for thinking text…"
            : "No thinking text shared for this response.";

    return html`<section class="live-thought" id=${id} aria-label="Pi's thinking">
        <div class="live-thought-label">${label}</div>
        <div
            class=${`live-thought-text ${empty ? "is-empty" : ""} ${streaming ? "streaming" : ""}`}
            ref=${box}
            onScroll=${onScroll}
            tabindex="0"
            role="region"
            aria-label=${label}
        >${shown}</div>
    </section>`;
}

/**
 * The end of the live turn, in one line: what Pi does (thinks, works, waits for an approval, retries a failed request,
 * compacts its context), for how long, and how to stop it. Screen readers hear what it does when that changes, not the
 * seconds counting. With Appearance → Show thinking on, Pi's newest thought shows above the line, and a chevron before
 * the line's dot folds it; folded, nothing of the thought is drawn or looked for.
 */
function LiveLine({ live, approvals, start, entries, conversationId }) {
    const [, tick] = useState(0);
    const line = useRef(null);
    /** Where the line was on screen as the thought above it opened or closed, to keep it there. */
    const was = useRef(null);

    useEffect(() => {
        const timer = setInterval(() => tick((n) => n + 1), 1000);

        return () => clearInterval(timer);
    }, []);

    const thinking = prefs().showThinking === true;
    const open = thinking && !thinkingFolded.has(conversationId);

    // Only as the thought opens or closes: not on the line's every tick.
    useLayoutEffect(() => {
        if (was.current === null) {
            return;
        }

        line.current.closest(".scroller").scrollTop +=
            line.current.getBoundingClientRect().top - was.current;
        was.current = null;
    }, [open]);

    const fold = () => {
        was.current = line.current.getBoundingClientRect().top;

        if (open) {
            thinkingFolded.add(conversationId);
        } else {
            thinkingFolded.delete(conversationId);
        }

        try {
            sessionStorage.setItem(THINKING_FOLDED_KEY, JSON.stringify([...thinkingFolded]));
        } catch {
            // Storage is full or off: the fold still holds in this page.
        }

        tick((n) => n + 1);
    };

    const partial = live.generation?.message?.blocks ?? [];
    const retry = live.generation?.retry;
    // Pi's request waits for the provider's limit to clear (`limit-gate.ts`): until a time, or a try.
    const limit = live.limit;
    const working = (live.tools ?? []).some((slot) => slot.status !== "done");
    const waiting = approvals.length > 0;
    const seconds = retry ? Math.ceil((fromServer(retry.at) - Date.now()) / 1000) : 0;
    let state;

    if (waiting) {
        // Questions from extensions (`host.ask`) wait for an answer, not an approval.
        const asks = approvals.every((approval) => approval.form);

        state = canAnswer(approvals)
            ? asks
                ? "Waiting for your answer"
                : "Waiting for your approval"
            : asks
              ? "Waiting for an answer"
              : "Waiting for approval";
    } else if (limit) {
        state = `Waiting for ${limitWho(limit)}`;
    } else if (retry) {
        state = "Retrying";
    } else if ((live.compactions ?? []).length > 0) {
        state = "Compacting context";
    } else if (working || (partial.length > 0 && partial.at(-1).type !== "thinking")) {
        state = "Working";
    } else {
        state = "Thinking";
    }

    const thoughtId = `live-thought-${conversationId}`;

    return html`${
        open &&
        html`<${Memo} deps=${[live.generation, entries, conversationId]}>
            <${LiveThought} generation=${live.generation} entries=${entries} id=${thoughtId} />
        <//>`
    }
        <div class=${`live-line ${waiting ? "waiting" : ""}`} data-part="live-line" ref=${line}>
        ${
            thinking &&
            html`<button
                class=${`live-fold ${open ? "open" : ""}`}
                aria-expanded=${open}
                aria-controls=${thoughtId}
                aria-label=${open ? "Hide Pi's thinking" : "Show Pi's thinking"}
                title=${open ? "Hide Pi's thinking" : "Show Pi's thinking"}
                onClick=${fold}
            ><${Icon} name="chevron" size=${14} class="chev" /></button>`
        }
        <span class="live-dot" data-part="live-mark" aria-hidden="true"></span>
        <span class="live-state" role="status">
            ${state}${retry && !waiting && seconds > 0 && html`<span aria-hidden="true"> in ${seconds}s</span>`}
        </span>
        ${
            limit &&
            !waiting &&
            html`<span class="live-limit" data-part="live-limit">
                ${limit.probing ? "trying now" : `next try in ${span(fromServer(limit.until) - Date.now())}`}${
                    limit.resetAt !== undefined && ` · resets ${clock(limit.resetAt)}`
                }
            </span>`
        }
        ${start !== undefined && html`<span class="live-time" aria-hidden="true">${span(Date.now() - start)}</span>`}
        ${
            limit &&
            !waiting &&
            html`<span class="live-why" title=${limit.reason}>
                ${limit.reason}
            </span>`
        }
        ${
            limit &&
            !waiting &&
            canSteer() &&
            !limit.probing &&
            html`<button
                class="live-retry"
                data-part="live-retry"
                title="Send the request now. Stop ends the wait."
                onClick=${() =>
                    attempt(async () => {
                        // The gate takes one try each 30 seconds: a press it ignores says so.
                        if ((await actions.retryLimit(conversationId))?.ok === false) {
                            notify("info", "Already trying: wait a moment.");
                        }
                    })}
            >Retry now</button>`
        }
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
    /** The column of rows in the scroller, whose growth keeps it at the bottom (below). */
    const column = useRef(null);
    const stick = useRef(true);
    /** A jump to a message is under way: the reader has not scrolled or tapped since. */
    const jumping = useRef(false);
    /** Distance from the bottom to restore after rows are added above, so the reader stays in place. */
    const keep = useRef(null);
    const counted = useRef(0);
    const [showJump, setShowJump] = useState(false);
    // Opened by a route on a phone, the scroller slides in with it: the column does not rise in as well, unless it comes
    // after the slide (a slow connection). Chosen as the column first draws, so a draw after does not start it.
    const entrance = useRef(null);

    if (entrance.current === null && view.conversation && !missing) {
        entrance.current = routeSliding() ? "" : "rising";
    }

    // Keep the snapshot's rows stable across unrelated UI updates, including scrolling the thought reading area. Only
    // the entries this tab has, which are the newest: earlier ones load as "Show earlier messages" shows them.
    const unloaded = useMemo(() => loadedFrom(view), [view.order, view.entries]);
    const entries = useMemo(
        () => view.order.slice(unloaded).map((id) => view.entries.get(id)),
        [view.order, view.entries, unloaded],
    );
    // Built again only when the entries change: the app draws for every change to the store, and a streamed answer's
    // updates bring no new entries (`mergeView`).
    const rows = useMemo(() => entries.filter(isRow), [entries]);
    const start = useMemo(() => windowStart(rows, transcriptFrom), [rows, transcriptFrom]);
    const talk = collab();
    const from = useMemo(() => rowsBefore(rows, start, talk), [rows, start, talk]);
    const partial = partialEntry(view.live.generation?.message?.blocks ?? []);
    const items = useMemo(
        () => itemsOf(rows.slice(start), partial, { from, talk }),
        [rows, start, partial, from, talk],
    );
    const results = useMemo(() => {
        const map = new Map();

        for (const entry of [...(history ?? []), ...entries]) {
            if (entry.kind === "toolResult") {
                map.set(entry.callId, entry);
            }
        }

        return map;
    }, [history, entries]);
    const slots = useMemo(
        () => new Map((view.live.tools ?? []).map((slot) => [slot.callId, slot])),
        [view.live.tools],
    );
    const [fetching, setFetching] = useState(false);

    // After a draw that can change the rows, not after every change to the store (each draws the app): to the bottom, or
    // back to where the reader was, before the draw shows. What grows between such draws is the ResizeObserver's below.
    useLayoutEffect(() => {
        const element = scroller.current;

        if (!element) {
            return;
        }

        const grew = rows.length > counted.current;
        const newest = rows.at(-1);

        // A message of your own just sent: the reader goes down to it, from wherever they had scrolled to.
        if (
            grew &&
            counted.current > 0 &&
            newest?.kind === "user" &&
            view.authors?.[newest.id] === store.state.me?.id &&
            !stick.current
        ) {
            stick.current = true;
            keep.current = null;
            setShowJump(false);
        }

        if (keep.current !== null) {
            element.scrollTop = element.scrollHeight - keep.current;
            keep.current = null;
        } else if (stick.current) {
            element.scrollTop = element.scrollHeight;
        }

        counted.current = rows.length;

        if (rows.length === 0) {
            return;
        }

        // Fix the first row shown, so rows arriving below never push the ones being read off the top: noted without a
        // draw, as this draw began there already (`revealEntry` and "Show earlier messages" read it). While the reader
        // follows along at the bottom, drop the oldest once there are twice as many as a fresh open shows.
        if (rows[start].id !== transcriptFrom) {
            store.note({ transcriptFrom: rows[start].id });
        } else if (grew && stick.current && rows.length - start > 2 * TRANSCRIPT_ROWS) {
            store.set({ transcriptFrom: rows[rows.length - TRANSCRIPT_ROWS].id });
        }
    }, [view, history, start]);

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
    // a message box that grows), and its rows grow between draws (a card that draws late, a font that loads, a line
    // under a reply): stay at the bottom if we were there, before the change shows.
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
        // Nor what a tap or a key there opened (a group, a step): it unrolls in place, where the reader looks. The next
        // draw of new rows takes them down again.
        let pressed = -Infinity;

        const press = () => {
            pressed = performance.now();
        };

        const opened = (changes) =>
            performance.now() - pressed < OPENED_MS &&
            changes.every((change) => change.target !== element);
        const observer = new ResizeObserver((changes) => {
            if (stick.current && !gliding() && !opened(changes)) {
                element.scrollTop = element.scrollHeight;
            }
        });

        element.addEventListener("touchstart", down, { passive: true });
        element.addEventListener("touchend", up, { passive: true });
        element.addEventListener("touchcancel", up, { passive: true });
        element.addEventListener("scroll", scrolled, { passive: true });
        element.addEventListener("pointerdown", press, { capture: true, passive: true });
        element.addEventListener("keydown", press, { capture: true, passive: true });
        observer.observe(element);

        if (column.current) {
            observer.observe(column.current);
        }

        return () => {
            observer.disconnect();
            element.removeEventListener("touchstart", down);
            element.removeEventListener("touchend", up);
            element.removeEventListener("touchcancel", up);
            element.removeEventListener("scroll", scrolled);
            element.removeEventListener("pointerdown", press, { capture: true });
            element.removeEventListener("keydown", press, { capture: true });
        };
    }, [view.conversation?.id]);

    // A jump to a message (`jumpToEntry`) leaves the bottom, until the reader scrolls or taps: its smooth scroll starts
    // near the bottom, where `onScroll` would follow along again, and the next update (earlier rows that load for it)
    // would take them back down.
    useEffect(() => {
        const away = () => {
            jumping.current = true;
            stick.current = false;
            keep.current = null;
        };

        const back = () => (jumping.current = false);
        const takes = ["wheel", "touchstart", "pointerdown", "keydown"];

        document.addEventListener("pocket:reveal", away);

        for (const name of takes) {
            document.addEventListener(name, back, { capture: true, passive: true });
        }

        return () => {
            document.removeEventListener("pocket:reveal", away);

            for (const name of takes) {
                document.removeEventListener(name, back, { capture: true });
            }
        };
    }, []);

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
    const shells = useMemo(() => rows.filter((row) => row.kind === "shell").length, [rows]);

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

        stick.current = atBottom && !jumping.current;

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
        if (start >= TRANSCRIPT_ROWS || unloaded === 0) {
            keepPlace();
            store.set({ transcriptFrom: rows[Math.max(0, start - TRANSCRIPT_ROWS)].id });

            return;
        }

        // Not here yet: load the rows to show (and as many more), then show them.
        const id = conversation.id;

        setFetching(true);
        attempt(async () => {
            await loadEarlier({ rows: 2 * TRANSCRIPT_ROWS });
            const { view: now } = store.state;

            if (now.conversation?.id !== id) {
                return;
            }

            const loaded = now.order
                .slice(loadedFrom(now))
                .map((entryId) => now.entries.get(entryId))
                .filter(isRow);
            const at = loaded.findIndex((row) => row.id === rows[start]?.id);

            keepPlace();
            store.set({ transcriptFrom: loaded[Math.max(0, at - TRANSCRIPT_ROWS)]?.id ?? null });
        }).finally(() => setFetching(false));
    };

    const approvals = view.approvals ?? [];
    const first = entries[0];
    const busy = view.live.busy;
    const compacting = (view.live.compactions ?? []).length > 0;
    const conversation = view.conversation;
    const started = runStart(conversation.id, entries, busy);
    // Only a session this person can see is in their list.
    const { sessions, sessionsLoaded } = store.state;
    const source =
        conversation.forkedFrom && sessions.find((each) => each.id === conversation.forkedFrom.id);

    return html`<main class="scroller" ref=${scroller} onScroll=${onScroll}>
        <div class=${`transcript ${entrance.current}`} data-part="transcript" ref=${column}>
            <${LinkedSessions} />
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
                start > 0 || unloaded > 0
                    ? html`<div class="divider">
                        <button class="link" disabled=${fetching} onClick=${showEarlier}>
                            ${fetching ? html`<${Spinner} /> Loading earlier messages` : "Show earlier messages"}
                        </button>
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
                items=${items}
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
                html`<${LiveLine}
                    live=${view.live}
                    approvals=${approvals}
                    start=${started}
                    entries=${entries}
                    conversationId=${conversation.id}
                />`
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
