// How the transcript reads a conversation, without drawing it: Pi's answers split into runs of words and groups of
// thinking and tool calls (`itemsOf`), what a group did in a line (`summarize`), and what a call came to, read from what
// its tool printed. Pure functions with no imports, so `test/turns.test.ts` runs them in Node; transcript.js draws them.

export const short = (text, max = 160) => {
    const flat = String(text ?? "")
        .replace(/\s+/g, " ")
        .trim();

    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** How many lines a tool's text has, without a last empty one. */
export const lineCount = (text) => (text === "" ? 0 : text.replace(/\n$/, "").split("\n").length);

/**
 * A tool's result without the notes it can end with: the harness's own (`<harness> [info] Showing lines 1-100 of 500…
 * </harness>`), and a tool's ("[1000 results limit reached…]", "[Some lines truncated…]").
 */
export const withoutNotes = (text) =>
    text
        .replace(/\n*<harness>[\s\S]*?<\/harness>\s*$/, "")
        .replace(/(?:\n\n\[[^\]\n]*\])+\s*$/, "");

/**
 * Grep's matches: its lines are `path:12: text`, and with context around them, `path-11- text` too. Every line, when
 * none looks like either.
 */
export function matchCount(text) {
    const lines = text.split("\n").filter((line) => line !== "");
    const kinds = lines.map((line) => /^(.*?)([:-])(\d+)\2 /.exec(line)?.[2]);

    return kinds.some((kind) => kind === "-")
        ? kinds.filter((kind) => kind === ":").length
        : lines.length;
}

export const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** Lines added and removed in an edit's diff (`+12 text`, `-12 text`), or null without one. */
export function diffCounts(diff) {
    if (typeof diff !== "string") {
        return null;
    }

    let added = 0;
    let removed = 0;

    for (const line of diff.split("\n")) {
        if (/^\+(?!\+\+)/.test(line)) {
            added++;
        } else if (/^-(?!--)/.test(line)) {
            removed++;
        }
    }

    return { added, removed };
}

/** Commands that run tests, by the words in them. */
const TESTS = /\b(?:test|tests|spec|jest|vitest|pytest|mocha|ava|tap|rspec|phpunit|ctest)\b/i;

/**
 * A test run's outcome from what it printed, as in "48 passed · 3.1s": for a command that runs tests, or output with a
 * test runner's own summary. Null for anything else.
 */
export function testOutcome(text, command = "") {
    if (!TESTS.test(command) && !/^(?:# pass|ℹ pass|Tests:) /m.test(text)) {
        return null;
    }

    // A runner's own count of tests first: node's ("# pass 48", "ℹ pass 48"), then the line for tests that Jest
    // ("Tests: 1 failed, 47 passed") and Vitest ("Tests  3 passed") print after their files and suites; then any.
    const count = (node, word) =>
        new RegExp(`^(?:#|ℹ) ${node} (\\d+)`, "m").exec(text)?.[1] ??
        new RegExp(`^\\s*Tests:?\\s+(?:[^\\n]*?\\D)?(\\d+) ${word}`, "m").exec(text)?.[1] ??
        new RegExp(`\\b(\\d+) (?:${word}|${word === "passed" ? "passing" : "failing"})\\b`).exec(
            text,
        )?.[1];
    const passed = count("pass", "passed");

    if (passed === undefined) {
        return null;
    }

    const failed = count("fail", "failed");
    const ms = /duration_ms ([\d.]+)/.exec(text)?.[1];
    const seconds =
        ms !== undefined
            ? Number(ms) / 1000
            : Number(/\b(?:in|Duration|Time:)\s+([\d.]+)\s?s\b/.exec(text)?.[1] ?? NaN);

    return [
        `${passed} passed`,
        failed !== undefined && Number(failed) > 0 && `${failed} failed`,
        Number.isFinite(seconds) && `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`,
    ]
        .filter(Boolean)
        .join(" · ");
}

/** A failed call's error, short: a command's exit code, or the first line of what it said. */
export function shortError(text) {
    const exit = /(?:exited with code|exit code:?) (\d+)/i.exec(text);

    if (exit) {
        return `exit ${exit[1]}`;
    }

    if (/timed out/i.test(text)) {
        return "timed out";
    }

    if (/\b(?:Command|Operation|was) aborted\b/.test(text)) {
        return "stopped";
    }

    // The first line that says something: not a tag around the harness's own errors ("<harness>"), nor its "[error]".
    const line =
        text
            .split("\n")
            .map((each) => each.trim().replace(/^\[[\w -]+\]\s*/, ""))
            .find((each) => each !== "" && !/^<\/?[\w-]+>$/.test(each)) ?? "failed";

    return short(line.replace(/^error:\s*/i, ""), 48);
}

/**
 * How a call that ended before it finished says so: the harness's "Tool bash was aborted" or "… was interrupted and may
 * have partially run", a tool's own "Operation aborted", or bash's "Command aborted" under its output.
 */
export const STOPPED =
    /^<harness>\s*\[error\] Tool \S+ was (?:aborted|interrupted)\b|^(?:Operation|Command|The operation was) aborted\.?$/m;

/** What a kind of call did, for a group's summary: its verb, what it counts, and what makes two of them one. */
const DID = {
    read: { verb: "read", noun: "file", by: "path" },
    edit: { verb: "edited", noun: "file", by: "path" },
    write: { verb: "wrote", noun: "file", by: "path" },
    bash: { verb: "ran", noun: "command" },
    codemode: { verb: "ran", noun: "script" },
    subagent: { verb: "ran", noun: "subagent", by: "name" },
    grep: { verb: "searched" },
    find: { verb: "searched" },
    ls: { verb: "listed", noun: "folder", by: "path" },
    browser: { verb: "used the browser" },
    artifact: { verb: "published", noun: "artifact", by: "id" },
};

/** Nouns said with "a" when there is one. */
const ONE = { subagent: "a subagent", script: "a script", artifact: "an artifact" };

/** Several things in a sentence: "a, b and c". */
const sentence = (parts) =>
    parts.length < 2 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;

/**
 * A group's calls in a line, in the order Pi first did each kind: "Thought, searched, read 2 files, ran 1 command", or
 * "Edited 1 file, wrote 1, ran a subagent and 2 commands".
 */
export function summarize(steps, thinking) {
    /** verb → noun → the things counted. */
    const did = new Map();

    for (const step of steps) {
        if (step.block.type === "thinking") {
            if (!did.has("thought")) {
                did.set("thought", new Map());
            }

            continue;
        }

        const call = step.block;
        const args = call.args ?? {};
        const checking =
            call.name === "subagent" &&
            args.action !== undefined &&
            args.action !== "spawn" &&
            args.action !== "send";
        const kind = checking
            ? { verb: "checked on subagents" }
            : (DID[call.name] ?? { verb: `used ${call.name}` });
        const nouns = did.get(kind.verb) ?? new Map();

        did.set(kind.verb, nouns);

        if (kind.noun) {
            const things = nouns.get(kind.noun) ?? new Set();

            things.add(kind.by && typeof args[kind.by] === "string" ? args[kind.by] : call.id);
            nouns.set(kind.noun, things);
        }
    }

    let before = null;
    const parts = [...did].map(([verb, nouns]) => {
        const counted = [...nouns].map(([noun, things], index) => {
            const count = things.size;
            // "Edited 1 file, wrote 1": the noun just said is not said again.
            const bare = index === 0 && noun === before && !ONE[noun];

            return count === 1 && ONE[noun]
                ? ONE[noun]
                : bare
                  ? String(count)
                  : plural(count, noun);
        });

        before = [...nouns.keys()].at(-1) ?? null;

        // A thought still being written, with nothing else done yet.
        const said = verb === "thought" && thinking && did.size === 1 ? "thinking" : verb;

        return counted.length === 0 ? said : `${said} ${sentence(counted)}`;
    });
    const line = parts.join(", ");

    return line.charAt(0).toUpperCase() + line.slice(1);
}

/** Words worth showing: a model can send an empty or blank text block between its calls. */
export const says = (block) => block.type === "text" && block.text.trim() !== "";

/**
 * The rows as the transcript shows them. A person's message, a command, a note, and a divider are each a row; Pi's
 * answers split into runs of words and runs of thinking and tool calls. A run of thinking and calls goes on across Pi's
 * answers until words, or another row, end it: the calls Pi made one after another fold into one group. `partial` is
 * the answer being written, which joins the group before it while it is still thinking and calling tools.
 *
 * Groups and runs of words are named by the row before them and how many came since: the names stay the same as the
 * answer being written is stored, and `from` (`itemsOf(earlier).state`) carries them on from rows before these, so they
 * do not change when the rows shown start elsewhere. The returned list's `state` is where it left off. `talk`: people
 * react to and discuss Pi's answers here (`hasEnd`).
 */
export function itemsOf(rows, partial, { prefix = "", from = null, talk = false } = {}) {
    const items = [];
    let anchor = from?.anchor ?? "top";
    let groups = from?.groups ?? 0;
    let replies = from?.replies ?? 0;
    // A group the rows before left open goes on here, under its name.
    let open = from?.open ?? null;
    let group = null;
    // The answer whose calls can still run while Pi works: the newest, when it asked for tools. Calls of any other
    // answer that have no result never ran (it was stopped, or failed).
    const last = rows.at(-1);
    const asking =
        !partial && last?.kind === "assistant" && last.stopReason === "toolUse" ? last : null;

    const close = () => {
        group = null;
        open = null;
    };

    const answer = (entry, streaming) => {
        let words = null;
        // Where a jump to this answer lands: its first words, or its first step when it has none.
        const speaks = entry.blocks.some(says);
        let anchored = streaming;

        entry.blocks.forEach((block, index) => {
            const growing = streaming && index === entry.blocks.length - 1;

            if (block.type === "thinking" || block.type === "toolCall") {
                words = null;

                if (group === null) {
                    group = {
                        type: "activity",
                        key: open ?? `${prefix}a${anchor}:${groups++}`,
                        steps: [],
                        anchors: [],
                        // Begun in rows not shown: its line still says all it did, and since when.
                        before: open === null ? [] : (from?.before ?? []),
                    };
                    open = null;
                    items.push(group);
                }

                if (!anchored && !speaks) {
                    group.anchors.push(entry.id);
                    anchored = true;
                }

                group.steps.push({
                    block,
                    entry: streaming ? undefined : entry,
                    streaming: growing,
                    canRun: streaming || entry === asking,
                });
            } else if (says(block)) {
                close();

                if (words === null) {
                    words = {
                        type: "reply",
                        key: `${prefix}r${anchor}:${replies++}`,
                        entry,
                        blocks: [],
                        anchor: !anchored,
                        end: false,
                    };
                    anchored = true;
                    items.push(words);
                }

                words.blocks.push({ block, growing });
            }
        });

        if (streaming) {
            return;
        }

        if (!hasEnd(entry, talk)) {
            // Nothing of it shows (only blank words): a jump to it still finds it, where Pi was.
            if (!anchored) {
                if (group !== null) {
                    group.anchors.push(entry.id);
                } else {
                    items.push({ type: "mark", key: `${prefix}m${entry.id}`, entry });
                }
            }

            return;
        }

        if (words !== null) {
            words.end = true;
        } else {
            items.push({
                type: "reply",
                key: `${prefix}z${entry.id}`,
                entry,
                blocks: [],
                anchor: !anchored,
                end: true,
            });
        }

        // How it ended (its words, a failure, a stop) ends what Pi was doing.
        close();
    };

    for (const entry of rows) {
        if (entry.kind === "assistant") {
            answer(entry, false);
            continue;
        }

        close();
        anchor = entry.id;
        groups = 0;
        replies = 0;
        items.push({ type: "row", key: entry.id, entry });
    }

    if (partial) {
        answer(partial, true);
    }

    items.state = {
        anchor,
        groups,
        replies,
        open: group?.key ?? open,
        // The steps of a group still open here, for its line where the rows shown begin in it.
        before: group?.steps ?? from?.before ?? [],
    };

    return items;
}

/**
 * Where the rows shown from `start` take their names from (`itemsOf`): the rows before them, back to the last one that
 * is not Pi's. Null when they start at the top.
 */
export function rowsBefore(rows, start, talk = false) {
    if (start === 0) {
        return null;
    }

    let begin = start;

    while (begin > 0 && rows[begin - 1].kind === "assistant") {
        begin--;
    }

    return itemsOf(rows.slice(Math.max(0, begin - 1), start), null, { talk }).state;
}

/**
 * Whether an answer has anything to show after its last words: a failure, a stop, or (`talk`, where people react to
 * and discuss Pi's answers) a final answer's actions.
 */
const hasEnd = (entry, talk) =>
    entry.stopReason === "error" ||
    entry.stopReason === "aborted" ||
    (talk && entry.stopReason !== "toolUse" && entry.blocks.some(says));
