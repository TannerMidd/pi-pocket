// Diffs as data: git's unified diffs and Pi's edit cards parsed into files, hunks, and lines, and the words that
// changed between a removed line and the line that replaced it. No DOM here: web/diff.js draws what this returns.

/**
 * A parsed diff: `{ files }`, each file `{ path, oldPath, kind, binary, mode, truncated, hunks, added, removed }`, with
 * `kind` "modified", "added", "deleted", or "renamed". Each hunk is `{ oldStart, oldCount, newStart, newCount, oldEnd,
 * newEnd, context, lines }`: its `@@` header, and the last line it shows on each side. Each line is `{ type: "ctx" |
 * "add" | "del" | "note", text, old, new }`, `old` and `new` its numbers in the old and new file; a note ("\ No newline
 * at end of file") has neither.
 */

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;
/** The line the server puts where it cut a long diff short (`src/server/changes.ts`). */
const TRUNCATED = /^… the rest of the diff is left out …$/;

/** The C escapes git writes in a quoted path, besides `\"`, `\\`, and bytes in octal. */
const ESCAPES = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 };

/** A path as git writes it: in C quotes when it holds odd characters (`"caf\303\251.txt"`), else bare. */
function unquote(path) {
    if (!/^".*"$/.test(path)) {
        return path;
    }

    const encoder = new TextEncoder();
    // Pieces of text, and between them the escapes, each one byte.
    const bytes = path
        .slice(1, -1)
        .split(/(\\[0-7]{3}|\\.)/)
        .flatMap((piece, index) => {
            if (index % 2 === 0) {
                return [...encoder.encode(piece)];
            }

            const code = piece.slice(1);

            return code.length === 3 ? parseInt(code, 8) : (ESCAPES[code] ?? code.charCodeAt(0));
        });

    return new TextDecoder().decode(new Uint8Array(bytes));
}

/** A path from a `---` or `+++` line, or a `diff --git` header: without its `a/` or `b/`, and unquoted. */
function cleanPath(raw) {
    const path = unquote(raw.replace(/\t.*$/, "").trim());

    if (path === "/dev/null") {
        return null;
    }

    return path.replace(/^[ab]\//, "");
}

/**
 * The two paths of a `diff --git` line, as written. Bare paths can hold spaces, so this splits as git does: where the
 * halves name the same file, which they do unless the file was renamed, and then its `rename` lines say the paths.
 */
function headerPaths(rest) {
    const quoted =
        /^("(?:[^"\\]|\\.)*") (.+)$/.exec(rest) ?? /^(.+) ("(?:[^"\\]|\\.)*")$/.exec(rest);

    if (quoted) {
        return [quoted[1], quoted[2]];
    }

    const half = (rest.length - 1) / 2;
    const [left, right] = [rest.slice(0, half), rest.slice(half + 1)];

    if (rest[half] === " " && cleanPath(left) === cleanPath(right)) {
        return [left, right];
    }

    const at = rest.indexOf(" b/");

    return at > 0 ? [rest.slice(0, at), rest.slice(at + 1)] : rest.split(" ", 2);
}

function newFile() {
    return {
        path: "",
        oldPath: null,
        kind: "modified",
        binary: false,
        /** Its mode changed: made executable, say. */
        mode: false,
        /** The server left the end of the diff out: it was too long. */
        truncated: false,
        hunks: [],
        added: 0,
        removed: 0,
    };
}

/**
 * The line a hunk starts at on one side. A side with no lines (`@@ -4,0 +5,2 @@`) names the line it comes after, so
 * it starts one later.
 */
export const firstLine = (start, count) => (count === 0 ? start + 1 : start);

/** Where each hunk ends, once its lines are in: the last line number it shows on each side. */
function closeHunk(hunk) {
    let oldEnd = Math.max(0, firstLine(hunk.oldStart, hunk.oldCount) - 1);
    let newEnd = Math.max(0, firstLine(hunk.newStart, hunk.newCount) - 1);

    for (const line of hunk.lines) {
        oldEnd = line.old ?? oldEnd;
        newEnd = line.new ?? newEnd;
    }

    hunk.oldEnd = oldEnd;
    hunk.newEnd = newEnd;
}

/** A unified diff (`git diff`, `diff -u`, a patch with several files) as files and hunks. */
export function parseUnified(text) {
    const files = [];
    let file = null;
    let hunk = null;
    let oldAt = 0;
    let newAt = 0;
    /** Lines the open hunk still has on each side, by its header: past them, the hunk is over. */
    let oldLeft = 0;
    let newLeft = 0;

    const startFile = () => {
        file = newFile();
        files.push(file);
        hunk = null;
    };

    for (const line of text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n")) {
        if (line.startsWith("\\") && file?.hunks.length > 0) {
            file.hunks.at(-1).lines.push({ type: "note", text: line.slice(1).trim() });
            continue;
        }

        if (line.startsWith("diff --git ")) {
            startFile();
            const [before, after = before] = headerPaths(line.slice(11));

            file.oldPath = cleanPath(before);
            file.path = cleanPath(after) ?? "";
            continue;
        }

        if (hunk !== null && (oldLeft > 0 || newLeft > 0)) {
            const sign = line[0];

            // Tools that trim trailing spaces leave an unchanged empty line with no space at all.
            if (sign === " " || line === "") {
                hunk.lines.push({ type: "ctx", text: line.slice(1), old: oldAt++, new: newAt++ });
                oldLeft--;
                newLeft--;
                continue;
            }

            if (sign === "+") {
                hunk.lines.push({ type: "add", text: line.slice(1), new: newAt++ });
                file.added++;
                newLeft--;
                continue;
            }

            if (sign === "-") {
                hunk.lines.push({ type: "del", text: line.slice(1), old: oldAt++ });
                file.removed++;
                oldLeft--;
                continue;
            }
        }

        hunk = null;

        const header = HUNK.exec(line);

        if (header) {
            if (file === null) {
                startFile();
            }

            oldLeft = header[2] === undefined ? 1 : Number(header[2]);
            newLeft = header[4] === undefined ? 1 : Number(header[4]);
            oldAt = firstLine(Number(header[1]), oldLeft);
            newAt = firstLine(Number(header[3]), newLeft);
            // The starts as git writes them; the lines are numbered from where each side starts.
            hunk = {
                oldStart: Number(header[1]),
                newStart: Number(header[3]),
                oldCount: oldLeft,
                newCount: newLeft,
                context: header[5] ?? "",
                lines: [],
            };
            file.hunks.push(hunk);
            continue;
        }

        if (line.startsWith("--- ")) {
            if (file === null || file.hunks.length > 0) {
                startFile();
            }

            const path = cleanPath(line.slice(4));

            file.oldPath = path;

            if (path === null) {
                file.kind = "added";
            }

            continue;
        }

        if (line.startsWith("+++ ") && file !== null) {
            const path = cleanPath(line.slice(4));

            if (path === null) {
                file.kind = "deleted";
                file.path = file.oldPath ?? file.path;
            } else {
                file.path = path;
            }

            continue;
        }

        if (file === null) {
            continue;
        }

        if (line.startsWith("new file mode")) {
            file.kind = "added";
        } else if (line.startsWith("deleted file mode")) {
            file.kind = "deleted";
        } else if (line.startsWith("rename from ")) {
            file.kind = "renamed";
            file.oldPath = unquote(line.slice(12));
        } else if (line.startsWith("rename to ")) {
            file.kind = "renamed";
            file.path = unquote(line.slice(10));
        } else if (line.startsWith("Binary files ") || line === "GIT binary patch") {
            file.binary = true;
        } else if (line.startsWith("old mode ") || line.startsWith("new mode ")) {
            file.mode = true;
        } else if (TRUNCATED.test(line)) {
            file.truncated = true;
        }
    }

    for (const each of files) {
        each.path ||= each.oldPath ?? "";

        if (each.kind === "modified" && each.oldPath && each.oldPath !== each.path) {
            each.kind = "renamed";
        }

        for (const part of each.hunks) {
            closeHunk(part);
        }
    }

    return { files };
}

/**
 * Pi's edit cards: `+12 text` added at new line 12, `-12 text` removed from old line 12, ` 12 text` unchanged at old
 * line 12, and a line of only `...` where unchanged lines are left out. Every change is shown, so an unchanged line's
 * new number is its old one moved by the lines added and removed above it.
 */
export function parseEditDiff(text, path = "") {
    const file = { ...newFile(), path };
    let hunk = null;
    let shift = 0;

    for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
        const match = /^([+\- ])\s*(\d+) (.*)$/.exec(line) ?? /^([+\- ])\s*(\d+)$/.exec(line);

        if (!match) {
            // A line of `...` is a gap: the next line starts a new hunk. Any other line is not part of the diff.
            if (hunk !== null && /^\s*\.\.\.\s*$/.test(line)) {
                hunk = null;
            }

            continue;
        }

        const [, sign, number, body = ""] = match;
        const at = Number(number);
        let entry;

        if (sign === "+") {
            entry = { type: "add", text: body, new: at };
            shift++;
            file.added++;
        } else if (sign === "-") {
            entry = { type: "del", text: body, old: at };
            shift--;
            file.removed++;
        } else {
            entry = { type: "ctx", text: body, old: at, new: at + shift };
        }

        if (hunk === null) {
            const oldStart = entry.old ?? at - shift + (sign === "+" ? 1 : 0);
            const newStart = entry.new ?? at + shift + (sign === "-" ? 1 : 0);

            hunk = { oldStart, newStart, context: "", lines: [] };
            file.hunks.push(hunk);
        }

        hunk.lines.push(entry);
    }

    for (const part of file.hunks) {
        closeHunk(part);
    }

    return { files: [file] };
}

/** Whether text reads as a unified diff rather than Pi's edit format. */
export const isUnified = (text) => /^(diff --git |--- |\+\+\+ |@@ -\d)/m.test(text);

/** Any diff text as files: a unified diff, or Pi's edit format for `path`. */
export function parseDiff(text, path = "") {
    const parsed = isUnified(text) ? parseUnified(text) : parseEditDiff(text, path);

    if (path !== "") {
        for (const file of parsed.files) {
            file.path ||= path;
        }
    }

    return parsed;
}

// ─── Rows: how a hunk lines up ──────────────────────────────────────────────────────

/**
 * A hunk's lines as rows: unchanged lines alone, and each run of removed lines next to the added lines after it, paired
 * in order. Split view draws a pair side by side; unified view draws the removed lines, then the added ones. Paired
 * lines get the words that changed between them.
 */
export function hunkRows(hunk) {
    const rows = [];
    const lines = hunk.lines;

    for (let at = 0; at < lines.length;) {
        const line = lines[at];

        if (line.type !== "del" && line.type !== "add") {
            rows.push({ kind: line.type, left: line, right: line });
            at++;
            continue;
        }

        const dels = [];
        const adds = [];

        while (lines[at]?.type === "del") {
            dels.push(lines[at++]);
        }

        while (lines[at]?.type === "add") {
            adds.push(lines[at++]);
        }

        for (const [left, right] of alignRun(dels, adds)) {
            const words = left && right ? wordDiff(left.text, right.text) : null;

            rows.push({ kind: "change", left, right, words });
        }
    }

    return rows;
}

/** Past this many lines on a side, a run pairs its lines in order instead of by likeness. */
const MAX_ALIGN = 40;
/** How alike two lines must be to pair them, from 0 to 1. */
const PAIR_FROM = 0.45;

/** Pairs of letters in a line, counted: what `likeness` compares. */
function bigrams(text) {
    const counts = new Map();
    const value = text.trim();

    for (let index = 0; index < value.length - 1; index++) {
        const pair = value.slice(index, index + 2);

        counts.set(pair, (counts.get(pair) ?? 0) + 1);
    }

    return { counts, size: Math.max(0, value.length - 1) };
}

/** How alike two lines are, from 0 to 1: the share of letter pairs they have in common (Dice's coefficient). */
function likeness(a, b) {
    if (a.size === 0 || b.size === 0) {
        return a.size === b.size ? 1 : 0;
    }

    let shared = 0;

    for (const [pair, count] of a.counts) {
        shared += Math.min(count, b.counts.get(pair) ?? 0);
    }

    return (2 * shared) / (a.size + b.size);
}

/**
 * A run of removed lines and the added lines after it, paired in order where they are alike, as `[removed, added]`
 * with null for a line that pairs with none. Pairing by likeness, not position, puts a changed line next to its new
 * version when lines were also added or removed around it.
 */
function alignRun(dels, adds) {
    if (
        dels.length === 0 ||
        adds.length === 0 ||
        dels.length * adds.length > MAX_ALIGN * MAX_ALIGN
    ) {
        const count = Math.max(dels.length, adds.length);

        return Array.from({ length: count }, (_, index) => [
            dels[index] ?? null,
            adds[index] ?? null,
        ]);
    }

    const a = dels.map((line) => bigrams(line.text));
    const b = adds.map((line) => bigrams(line.text));
    const width = adds.length + 1;
    const score = new Float64Array((dels.length + 1) * width);
    const alike = (i, j) => likeness(a[i], b[j]);

    for (let i = 1; i <= dels.length; i++) {
        for (let j = 1; j <= adds.length; j++) {
            const pair = alike(i - 1, j - 1);

            score[i * width + j] = Math.max(
                score[(i - 1) * width + j],
                score[i * width + j - 1],
                pair >= PAIR_FROM ? score[(i - 1) * width + j - 1] + pair : 0,
            );
        }
    }

    const pairs = [];

    for (let i = dels.length, j = adds.length; i > 0 || j > 0;) {
        if (i > 0 && j > 0) {
            const pair = alike(i - 1, j - 1);

            if (
                pair >= PAIR_FROM &&
                score[i * width + j] === score[(i - 1) * width + j - 1] + pair
            ) {
                pairs.push([dels[--i], adds[--j]]);
                continue;
            }
        }

        if (j > 0 && (i === 0 || score[i * width + j - 1] >= score[(i - 1) * width + j])) {
            pairs.push([null, adds[--j]]);
        } else {
            pairs.push([dels[--i], null]);
        }
    }

    pairs.reverse();

    // Lines left unpaired next to each other still share a row in split view: a removed line, then an added one.
    const rows = [];

    for (const pair of pairs) {
        const last = rows.at(-1);

        if (pair[0] === null && last && last[1] === null && last.unpaired) {
            last[1] = pair[1];
            delete last.unpaired;
            continue;
        }

        const row = [...pair];

        if (pair[1] === null) {
            row.unpaired = true;
        }

        rows.push(row);
    }

    return rows.map(([left, right]) => [left, right]);
}

// ─── Words ───────────────────────────────────────────────────────────────────────

// With `u`, a character outside the basic plane (an emoji) is one token, not two halves.
const TOKENS = /\w+|\s+|[^\w\s]/gu;
/** Past this many tokens on a side, a line pair is not compared word by word: it costs too much for what it shows. */
const MAX_TOKENS = 300;

/**
 * The ranges of each line that changed, as `{ left: [[from, to]…], right: […] }` in characters, or null when the lines
 * share too little for word marks to help (then the whole line's color says enough).
 */
export function wordDiff(before, after) {
    if (before === after) {
        return null;
    }

    const a = before.match(TOKENS) ?? [];
    const b = after.match(TOKENS) ?? [];

    if (a.length > MAX_TOKENS || b.length > MAX_TOKENS) {
        return null;
    }

    // Longest common subsequence of tokens, as a table of suffix lengths.
    const width = b.length + 1;
    const table = new Uint16Array((a.length + 1) * width);

    for (let i = a.length - 1; i >= 0; i--) {
        for (let j = b.length - 1; j >= 0; j--) {
            table[i * width + j] =
                a[i] === b[j]
                    ? table[(i + 1) * width + j + 1] + 1
                    : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
        }
    }

    const left = [];
    const right = [];
    let same = 0;
    let i = 0;
    let j = 0;
    let atA = 0;
    let atB = 0;

    const mark = (ranges, from, to) => {
        const last = ranges.at(-1);

        if (last && last[1] === from) {
            last[1] = to;
        } else {
            ranges.push([from, to]);
        }
    };

    while (i < a.length || j < b.length) {
        if (i < a.length && j < b.length && a[i] === b[j]) {
            same += a[i].trim() === "" ? 0 : a[i].length;
            atA += a[i++].length;
            atB += b[j++].length;
        } else if (
            j < b.length &&
            (i === a.length || table[i * width + j + 1] >= table[(i + 1) * width + j])
        ) {
            mark(right, atB, (atB += b[j++].length));
        } else {
            mark(left, atA, (atA += a[i++].length));
        }
    }

    const visible = Math.max(before.trim().length, after.trim().length, 1);

    // Mostly rewritten: marking nearly every word is noise.
    if (same / visible < 0.35) {
        return null;
    }

    return { left: trimRanges(left, before), right: trimRanges(right, after) };
}

/** Ranges without the spaces at their ends, and without ranges of only spaces, unless that is all that changed. */
function trimRanges(ranges, text) {
    const out = [];

    for (const [from, to] of ranges) {
        let start = from;
        let end = to;

        while (start < end && /\s/.test(text[start])) {
            start++;
        }

        while (end > start && /\s/.test(text[end - 1])) {
            end--;
        }

        out.push(start < end ? [start, end] : [from, to]);
    }

    return out;
}

// ─── Marking words in highlighted code ──────────────────────────────────────────────

/** Highlighted HTML in pieces: tags, entities (one character of text each), and text, a lone `&` or `<` included. */
const PIECES = /(<[^>]+>)|(&[#a-z0-9]+;)|([^<&]+|[<&])/gi;

/**
 * Highlighted HTML with the character ranges `ranges` (of its text, not its markup) wrapped in `<mark>`. A mark closes
 * before each tag and opens again after it, so the markup stays well nested.
 */
export function markRanges(source, ranges) {
    if (!ranges || ranges.length === 0) {
        return source;
    }

    let out = "";
    let at = 0;
    let index = 0;
    let open = false;

    const step = () => {
        if (open && at >= ranges[index][1]) {
            out += "</mark>";
            open = false;
            index++;
        }

        if (!open && index < ranges.length && at >= ranges[index][0]) {
            out += "<mark>";
            open = true;
        }
    };

    for (const [, tag, entity, text] of source.matchAll(PIECES)) {
        if (tag) {
            out += open ? `</mark>${tag}<mark>` : tag;
            continue;
        }

        if (entity) {
            step();
            out += entity;
            at++;
            continue;
        }

        for (let from = 0; from < text.length;) {
            step();
            const edge =
                index < ranges.length ? (open ? ranges[index][1] : ranges[index][0]) : Infinity;
            const take = Math.max(1, Math.min(text.length - from, edge - at));

            out += text.slice(from, from + take);
            from += take;
            at += take;
        }
    }

    step();

    return open ? `${out}</mark>` : out;
}

// ─── Small helpers ───────────────────────────────────────────────────────────────

/** A short, stable fingerprint of text (FNV-1a), to tell whether a file's diff changed since it was marked viewed. */
export function fingerprint(text) {
    let hash = 0x811c9dc5;

    for (let index = 0; index < text.length; index++) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }

    return (hash >>> 0).toString(36);
}

/** The five cells of a change bar, as GitHub draws it: added, removed, and unchanged cells, in proportion. */
export function changeCells(added = 0, removed = 0) {
    const total = added + removed;

    if (total === 0) {
        return ["", "", "", "", ""];
    }

    const cells = Math.min(5, Math.max(1, Math.ceil(Math.log10(total + 1) * 1.6)));
    // Each side that changed at all gets a cell, when there are two to share.
    const green = Math.min(
        cells - (removed > 0 && cells > 1 ? 1 : 0),
        Math.max(added > 0 ? 1 : 0, Math.round((added / total) * cells)),
    );
    const red = cells - green;

    return [...Array(green).fill("add"), ...Array(red).fill("del"), ...Array(5 - cells).fill("")];
}
