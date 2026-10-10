// The diff viewer: one file's diff (unified or side by side, with line numbers, syntax colors, the words that changed,
// and hidden lines a tap away), and Review, which walks every uncommitted change of a session's folder file by file.
// Parsing is web/diff-parse.js.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { useBack } from "./back.js";
import { jumpToEntry } from "./chat.js";
import {
    changeCells,
    fingerprint,
    firstLine,
    hunkRows,
    markRanges,
    parseDiff,
} from "./diff-parse.js";
import { highlight, highlightLines, langOf } from "./highlight.js";
import { branchAvailable } from "./sheets/branch.js";
import { actions, attempt, canSteer, notify, openSheet, store } from "./store.js";
import { html, Icon, Loader, openFile, shortPath } from "./ui.js";

// ─── Preferences ────────────────────────────────────────────────────────────────────

const PREFS_KEY = "pocket.diff";
/** Side by side from this width of the viewer, when the layout is left to the app. */
const SPLIT_FROM = 880;

function readPrefs() {
    try {
        return { layout: "auto", wrap: true, ...JSON.parse(localStorage.getItem(PREFS_KEY)) };
    } catch {
        return { layout: "auto", wrap: true };
    }
}

let diffPrefs = readPrefs();

/** How diffs show on this device: `layout` is auto, split, or unified; `wrap` breaks long lines instead of scrolling. */
function setDiffPrefs(patch) {
    diffPrefs = { ...diffPrefs, ...patch };
    localStorage.setItem(PREFS_KEY, JSON.stringify(diffPrefs));
    store.set({});
}

/** The width of an element, kept current as it resizes. */
export function useWidth(ref) {
    const [width, setWidth] = useState(0);

    useLayoutEffect(() => {
        const element = ref.current;

        if (!element) {
            return;
        }

        setWidth(element.clientWidth);
        const observer = new ResizeObserver(([entry]) =>
            setWidth(Math.round(entry.contentRect.width)),
        );

        observer.observe(element);

        return () => observer.disconnect();
    }, []);

    return width;
}

/** Split or unified, for a viewer this wide. */
const layoutFor = (width) =>
    diffPrefs.layout === "auto" ? (width >= SPLIT_FROM ? "split" : "unified") : diffPrefs.layout;

/** The layout after `layout`, as the layout button and `s` step through them. */
const nextLayout = (layout) => ({ auto: "split", split: "unified", unified: "auto" })[layout];

// ─── One file ──────────────────────────────────────────────────────────────────────

/** A change's kind as one letter, as git status writes it; `new` is a file git does not track yet. */
export const KIND_LETTERS = { modified: "M", added: "A", deleted: "D", renamed: "R", new: "N" };
/** A file with more changed lines than this waits for a tap before it draws. */
const BIG_DIFF = 1200;
/** Hidden lines shown per tap on a long gap. */
const EXPAND_STEP = 20;

/** The highlighted HTML of each line of a file's hunks, by line object: each side of a hunk colored as one run. */
function highlightHunks(file, lang) {
    const out = new Map();

    for (const hunk of file.hunks) {
        for (const side of ["old", "new"]) {
            const lines = hunk.lines.filter(
                (line) => line.type === "ctx" || line.type === (side === "old" ? "del" : "add"),
            );
            const colored = highlightLines(
                lines.map((line) => line.text),
                lang,
            );

            lines.forEach((line, index) => {
                if (side === "new" || line.type === "del") {
                    out.set(line, colored[index]);
                }
            });
        }
    }

    return out;
}

/** The words that changed on each line, by line object. */
function wordMarks(rows) {
    const marks = new Map();

    for (const row of rows) {
        if (row.words) {
            marks.set(row.left, row.words.left);
            marks.set(row.right, row.words.right);
        }
    }

    return marks;
}

/** Files' lines as they are now, per conversation, path, and diff: null until read, false when they cannot be. */
const fileTexts = new Map();
/** How many files' lines are kept: the oldest go first. */
const FILE_TEXTS = 40;

/**
 * A file's lines in the folder now, for the lines a diff leaves out: read once per path while its diff stays the same.
 * null until read, and false when the file cannot give them (not text, or too big to read whole).
 */
function useFileText(path, key, wanted) {
    const id = `${store.state.conversationId}\u0000${path}\u0000${key}`;
    const [, setRead] = useState(0);

    useEffect(() => {
        if (!wanted || !path || fileTexts.has(id)) {
            return;
        }

        let live = true;

        const keep = (lines) => {
            if (fileTexts.size >= FILE_TEXTS) {
                fileTexts.delete(fileTexts.keys().next().value);
            }

            fileTexts.set(id, lines);

            if (live) {
                setRead((count) => count + 1);
            }
        };

        // Cut short (a big file), the text cannot say what the lines past its end are.
        actions.view(path).then(
            (file) =>
                keep(
                    file.kind === "text" && !file.truncated
                        ? file.text.replace(/\n$/, "").split("\n")
                        : false,
                ),
            () => keep(false),
        );

        return () => {
            live = false;
        };
    }, [wanted, id]);

    return fileTexts.get(id) ?? null;
}

/** Hidden lines a gap has shown so far: `top` from the hunk above, `bottom` toward the hunk below. */
function gapLines(gap, shown, text) {
    const top = [];
    const bottom = [];
    const total = gap.to - gap.from + 1;
    const fromTop = Math.min(shown?.top ?? 0, total);
    const fromBottom = Math.min(shown?.bottom ?? 0, total - fromTop);

    const line = (number) => ({
        type: "ctx",
        text: text?.[number - 1] ?? "",
        old: number - gap.shift,
        new: number,
    });

    for (let number = gap.from; number < gap.from + fromTop; number++) {
        top.push(line(number));
    }

    for (let number = gap.to - fromBottom + 1; number <= gap.to; number++) {
        bottom.push(line(number));
    }

    return { top, bottom, left: total - fromTop - fromBottom };
}

/**
 * A diff that is a whole file, with nothing around it: a new or deleted one. By its kind, not its hunk: `-U0` writes an
 * insertion at the top of a file as `@@ -0,0 +1 @@` too.
 */
const wholeFile = (file) => file.kind === "added" || file.kind === "new" || file.kind === "deleted";

/** Unchanged lines a review's diff shows around each change (`src/server/changes.ts` asks git for that many). */
const CONTEXT = 3;

/**
 * Where a file ends, when its diff says: its last hunk shows fewer unchanged lines after its last change than a diff
 * shows around one, or a note that the file has no newline at its end.
 */
function endOf(file) {
    const lines = file.hunks.at(-1).lines;
    const changed = lines.findLastIndex((line) => line.type === "add" || line.type === "del");
    const after = lines.slice(changed + 1);

    return after.some((line) => line.type === "note") ||
        after.filter((line) => line.type === "ctx").length < CONTEXT
        ? file.hunks.at(-1).newEnd
        : undefined;
}

/** The unchanged runs between hunks, in new-file line numbers, with how far old numbers are behind there. */
function gapsOf(file, length) {
    const gaps = [];
    let next = 1;
    let shift = 0;

    for (const hunk of file.hunks) {
        const start = firstLine(hunk.newStart, hunk.newCount);

        shift = start - firstLine(hunk.oldStart, hunk.oldCount);
        gaps.push({ from: next, to: start - 1, shift });
        next = hunk.newEnd + 1;
        shift = hunk.newEnd - hunk.oldEnd;
    }

    // After the last hunk, as far as the file goes, once that is known.
    gaps.push({ from: next, to: length ?? next - 1, shift, open: length === undefined });

    return gaps;
}

/** A line-number cell. New-side numbers open the file at that line, when there is a file to open. */
function LineNo({ line, side, onLine, kind = "" }) {
    const go = side === "new" && onLine && line?.new !== undefined;

    return html`<td
        class=${`dv-n ${line ? kind : "none"} ${go ? "go" : ""}`}
        data-n=${(side === "old" ? line?.old : line?.new) ?? ""}
        onClick=${go ? () => onLine(line.new) : undefined}
    ></td>`;
}

/** The two number cells of a unified row. */
const Numbers = ({ left, right, onLine, kind = "" }) =>
    html`<${LineNo} line=${left} side="old" onLine=${onLine} kind=${kind} /><${LineNo}
            line=${right}
            side="new"
            onLine=${onLine}
            kind=${kind}
        />`;

/** One line's code cell: its sign, its colors, and the words that changed. */
function Code({ line, colored, marks, kind }) {
    const source = colored.get(line);
    const body = markRanges(source ?? escapeText(line?.text ?? ""), marks.get(line));

    return html`<td
        class=${`dv-code ${kind}`}
        data-sign=${kind === "add" ? "+" : kind === "del" ? "−" : ""}
        dangerouslySetInnerHTML=${{ __html: body }}
    ></td>`;
}

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeText = (text) => text.replace(/[&<>"']/g, (char) => ESCAPES[char]);

/** The rows of one hunk, unified: unchanged lines, then each run of removed lines before the lines that replaced it. */
function UnifiedRows({ rows, colored, marks, onLine }) {
    const out = [];

    for (let at = 0; at < rows.length; at++) {
        const row = rows[at];

        if (row.kind === "note") {
            out.push(html`<tr class="dv-note">
                <td colspan="3"><span>${row.left.text}</span></td>
            </tr>`);
            continue;
        }

        if (row.kind !== "change") {
            out.push(html`<tr class="dv-row">
                <${Numbers} left=${row.left} right=${row.right} onLine=${onLine} />
                <${Code} line=${row.left} colored=${colored} marks=${marks} kind="ctx" />
            </tr>`);
            continue;
        }

        // A run of paired rows: every removed line first, then every added one.
        let end = at;

        while (rows[end + 1]?.kind === "change") {
            end++;
        }

        const run = rows.slice(at, end + 1);

        for (const each of run) {
            if (each.left) {
                out.push(html`<tr class="dv-row del">
                    <${Numbers} left=${each.left} right=${null} onLine=${onLine} kind="del" />
                    <${Code} line=${each.left} colored=${colored} marks=${marks} kind="del" />
                </tr>`);
            }
        }

        for (const each of run) {
            if (each.right) {
                out.push(html`<tr class="dv-row add">
                    <${Numbers} left=${null} right=${each.right} onLine=${onLine} kind="add" />
                    <${Code} line=${each.right} colored=${colored} marks=${marks} kind="add" />
                </tr>`);
            }
        }

        at = end;
    }

    return out;
}

/** The rows of one hunk side by side: old on the left, new on the right, changed lines paired across. */
function SplitRows({ rows, colored, marks, onLine }) {
    return rows.map((row) => {
        if (row.kind === "note") {
            return html`<tr class="dv-note">
                <td colspan="4"><span>${row.left.text}</span></td>
            </tr>`;
        }

        const change = row.kind === "change";
        const { left, right } = row;

        return html`<tr class=${`dv-row ${change ? "change" : ""}`}>
            <${LineNo} line=${left} side="old" onLine=${onLine} kind=${change ? "del" : ""} />
            ${
                left
                    ? html`<${Code}
                          line=${left}
                          colored=${colored}
                          marks=${marks}
                          kind=${change ? "del" : "ctx"}
                      />`
                    : html`<td class="dv-code none"></td>`
            }
            <${LineNo} line=${right} side="new" onLine=${onLine} kind=${change ? "add" : ""} />
            ${
                right
                    ? html`<${Code}
                          line=${right}
                          colored=${colored}
                          marks=${marks}
                          kind=${change ? "add" : "ctx"}
                      />`
                    : html`<td class="dv-code none"></td>`
            }
        </tr>`;
    });
}

/** A run of hidden lines: how many, and buttons to show them, a step at a time from either end, or all at once. */
function GapRow({ left, columns, onShow, first, last }) {
    if (left <= 0) {
        return null;
    }

    const all = left <= EXPAND_STEP * 1.5;

    return html`<tr class="dv-gap">
        <td colspan=${columns}>
            ${
                all
                    ? html`<button type="button" onClick=${() => onShow("all")}>
                          ${first ? "↑" : last ? "↓" : "↕"} Show ${left} hidden ${left === 1 ? "line" : "lines"}
                      </button>`
                    : html`${
                          !first &&
                          html`<button
                              type="button"
                              title="Show more below the hunk above"
                              onClick=${() => onShow("top")}
                          >
                              ↓ ${EXPAND_STEP}
                          </button>`
                      }
                      <button type="button" onClick=${() => onShow("all")}>
                          Show all ${left} hidden lines
                      </button>
                      ${
                          !last &&
                          html`<button
                              type="button"
                              title="Show more above the hunk below"
                              onClick=${() => onShow("bottom")}
                          >
                              ↑ ${EXPAND_STEP}
                          </button>`
                      }`
            }
        </td>
    </tr>`;
}

/**
 * One file's diff. `path` is where the file is now, for opening it at a line and for the lines the diff leaves out
 * (`expand`, read again whenever `version` changes); `head` draws its header bar, with `tools` (buttons) at its end;
 * `open` and `onToggle` fold it; `loading` says its lines are on their way. Colors, pairs, and rows are worked out only
 * for a diff that is drawn, and the table is made again only when what it shows changes.
 */
function DiffFile({
    file,
    path = "",
    version = "",
    expand = false,
    head = true,
    tools = null,
    viewed = null,
    onViewed = null,
    open = true,
    onToggle = null,
    note = null,
    loading = false,
}) {
    const ref = useRef(null);
    const width = useWidth(ref);
    const split = layoutFor(width) === "split";
    const lang = langOf(file.path);
    const size = file.added + file.removed;
    const [force, setForce] = useState(false);
    const [shown, setShown] = useState({});
    const drawn =
        open && !loading && !file.binary && file.hunks.length > 0 && (size <= BIG_DIFF || force);
    const colored = useMemo(
        () => (drawn ? highlightHunks(file, lang) : new Map()),
        [drawn, file, lang],
    );
    const rowsByHunk = useMemo(() => (drawn ? file.hunks.map(hunkRows) : []), [drawn, file]);
    const marks = useMemo(() => wordMarks(rowsByHunk.flat()), [rowsByHunk]);

    // Another version of the diff has other gaps: what was shown of the old ones does not apply.
    useEffect(() => setShown({}), [file]);
    // A diff cut short cannot say where its last hunk ends, so the lines after it are not known either.
    const canExpand =
        expand && path !== "" && file.hunks.length > 0 && !wholeFile(file) && !file.truncated;
    const asked = Object.values(shown).some((each) => each.top + each.bottom > 0);
    const fetched = useFileText(
        path,
        version || `${file.added}:${file.removed}`,
        canExpand && asked,
    );
    // The file as it is now must still read as the diff says, or its other lines would be shown in the wrong places.
    const matches = useMemo(
        () =>
            fetched === null ||
            (fetched !== false &&
                file.hunks.every((hunk) =>
                    hunk.lines.every(
                        (line) =>
                            line.type === "del" ||
                            line.type === "note" ||
                            fetched[line.new - 1] === line.text,
                    ),
                )),
        [fetched, file],
    );
    const text = matches && fetched !== null ? fetched : null;
    const expandable = canExpand && matches;
    const gaps = useMemo(
        () => (expandable ? gapsOf(file, text?.length ?? endOf(file)) : []),
        [file, expandable, text?.length],
    );

    const table = useMemo(() => {
        if (!drawn) {
            return null;
        }

        const columns = split ? 4 : 3;
        const Rows = split ? SplitRows : UnifiedRows;
        const onLine = path ? (line) => openFile(`${path}:${line}`) : null;
        const none = new Map();

        const show = (index, how) =>
            setShown((all) => {
                const gap = gaps[index];
                const before = all[index] ?? { top: 0, bottom: 0 };

                const next =
                    how === "all"
                        ? { top: gap.to - gap.from + 1, bottom: 0 }
                        : how === "top"
                          ? { ...before, top: before.top + EXPAND_STEP }
                          : { ...before, bottom: before.bottom + EXPAND_STEP };

                return { ...all, [index]: next };
            });

        /** Context rows for lines a gap shows, colored as one run. */
        const contextRows = (lines) => {
            const colors = highlightLines(
                lines.map((line) => line.text),
                lang,
            );
            const extra = new Map(lines.map((line, index) => [line, colors[index]]));

            return html`<${Rows}
                rows=${lines.map((line) => ({ kind: "ctx", left: line, right: line }))}
                colored=${extra}
                marks=${none}
                onLine=${onLine}
            />`;
        };

        const gapRows = (index) => {
            const gap = gaps[index];

            if (!gap) {
                return null;
            }

            const wanted = (shown[index]?.top ?? 0) + (shown[index]?.bottom ?? 0) > 0;

            if (text === null && wanted) {
                return html`<tr class="dv-gap">
                    <td colspan=${columns}><span class="dv-reading">Reading the file…</span></td>
                </tr>`;
            }

            // Where the file ends is not known until it is read: offer to show what follows the last hunk.
            if (gap.open) {
                return html`<tr class="dv-gap">
                    <td colspan=${columns}>
                        <button type="button" onClick=${() => show(index, "top")}>↓ Show more</button>
                    </td>
                </tr>`;
            }

            const { top, bottom, left } = gapLines(gap, shown[index], text);

            return html`${contextRows(top)}
                <${GapRow}
                    left=${left}
                    columns=${columns}
                    first=${index === 0}
                    last=${index === gaps.length - 1}
                    onShow=${(how) => show(index, how)}
                />
                ${contextRows(bottom)}`;
        };

        /** Hidden lines still hidden before hunk `index`: none once a gap is shown whole, so its header goes too. */
        const hiddenBefore = (index) =>
            gaps[index] ? gapLines(gaps[index], shown[index], text).left : 0;

        return html`<table class=${`dv-table ${split ? "split" : "unified"}`}>
            ${
                split
                    ? html`<colgroup>
                          <col class="dv-col-n" />
                          <col />
                          <col class="dv-col-n" />
                          <col />
                      </colgroup>`
                    : html`<colgroup>
                          <col class="dv-col-n" />
                          <col class="dv-col-n" />
                          <col />
                      </colgroup>`
            }
            ${file.hunks.map(
                (hunk, index) => html`<tbody key=${index}>
                    ${expandable && gapRows(index)}
                    ${
                        !wholeFile(file) &&
                        (!expandable || (hunk.context && hiddenBefore(index) > 0)) &&
                        html`<tr class="dv-hunk">
                            <td colspan=${columns}>
                                <span class="dv-at">${`@@ −${hunk.oldStart} +${hunk.newStart} @@`}</span>
                                ${hunk.context && html`<span class="dv-context">${hunk.context}</span>`}
                            </td>
                        </tr>`
                    }
                    <${Rows}
                        rows=${rowsByHunk[index]}
                        colored=${colored}
                        marks=${marks}
                        onLine=${onLine}
                    />
                </tbody>`,
            )}
            ${expandable && html`<tbody>${gapRows(gaps.length - 1)}</tbody>`}
        </table>`;
    }, [drawn, split, file, colored, rowsByHunk, marks, gaps, shown, text, expandable, path, lang]);

    let body;

    if (loading) {
        body = null;
    } else if (file.binary) {
        body = html`<p class="dv-empty">A binary file: no lines to compare.</p>`;
    } else if (file.hunks.length === 0) {
        body = html`<p class="dv-empty">
            ${file.kind === "renamed" ? "Renamed, with no change to its text." : file.mode ? "Only its mode changed." : "No difference in text."}
        </p>`;
    } else if (!drawn) {
        body = html`<p class="dv-empty">
            ${`A large diff: ${size.toLocaleString()} changed lines. `}
            <button class="link" type="button" onClick=${() => setForce(true)}>Show it</button>
        </p>`;
    } else {
        body = html`<div class="dv-scroll">
            ${table}
            ${
                file.truncated &&
                html`<p class="dv-empty small">
                    ${"The diff is too long to show whole: the rest is left out."}
                </p>`
            }
            ${
                canExpand &&
                !matches &&
                html`<p class="dv-empty small">
                    ${fetched === false ? "This file is too big to show its other lines here." : "The file changed after this diff was read, so its other lines cannot be shown. Refresh to see them."}
                </p>`
            }
        </div>`;
    }

    return html`<section
        class=${`dv ${diffPrefs.wrap ? "wrap" : ""} ${open ? "" : "folded"} ${viewed ? "viewed" : ""}`}
        ref=${ref}
    >
        ${head && html`<${FileHead} file=${file} tools=${tools} viewed=${viewed} onViewed=${onViewed} open=${open} onToggle=${onToggle} note=${note} />`}
        ${open && body}
    </section>`;
}

/** The path as a folder and a name, the name brighter: what changed is easier to find at the end of a long path. */
function PathLabel({ path }) {
    const at = path.lastIndexOf("/");

    return html`<span class="dv-path" title=${path}>
        ${at >= 0 && html`<span class="dv-dir">${path.slice(0, at + 1)}</span>`}
        <span class="dv-name">${path.slice(at + 1)}</span>
    </span>`;
}

/** A change bar's five cells; none for a file with no lines counted, binary say. */
function ChangeBar({ added, removed }) {
    if (added + removed === 0) {
        return null;
    }

    return html`<span class="dv-bar" aria-hidden="true">
        ${changeCells(added, removed).map((cell) => html`<i class=${cell}></i>`)}
    </span>`;
}

/** Lines added and removed, as +12 −3. */
function ChangeCounts({ added, removed }) {
    return html`<span class="dv-counts">
        ${added > 0 && html`<span class="ok">+${added}</span>`}
        ${removed > 0 && html`<span class="err">−${removed}</span>`}
    </span>`;
}

/** A file's header bar: fold, what kind of change, its path, the counts, and Viewed. */
function FileHead({ file, tools, viewed, onViewed, open, onToggle, note }) {
    const kind = file.kind;
    const title =
        kind === "renamed" && file.oldPath && file.oldPath !== file.path
            ? html`<span class="dv-dir dv-was">${file.oldPath} →</span><${PathLabel} path=${file.path} />`
            : html`<${PathLabel} path=${file.path} />`;

    return html`<header class="dv-head">
        ${
            onToggle &&
            html`<button
                class="dv-fold"
                type="button"
                aria-expanded=${open ? "true" : "false"}
                aria-label=${open ? "Fold" : "Unfold"}
                onClick=${onToggle}
            >
                <${Icon} name="chevron" size=${14} class=${`chev ${open ? "open" : ""}`} />
            </button>`
        }
        <span class=${`change-kind ${kind}`} title=${kind}>${KIND_LETTERS[kind] ?? "M"}</span>
        ${
            onToggle
                ? html`<button class="dv-title" type="button" onClick=${onToggle}>${title}</button>`
                : html`<span class="dv-title">${title}</span>`
        }
        ${note}
        <${ChangeCounts} added=${file.added} removed=${file.removed} />
        <${ChangeBar} added=${file.added} removed=${file.removed} />
        ${tools}
        ${
            onViewed &&
            html`<label class=${`dv-viewed ${viewed ? "on" : ""}`} title="Mark as viewed (v)">
                <input
                    type="checkbox"
                    checked=${Boolean(viewed)}
                    onChange=${(event) => onViewed(event.currentTarget.checked)}
                />
                <span>Viewed</span>
            </label>`
        }
    </header>`;
}

/** Diff text from a tool call or a reply: each file it holds, with a header unless `bare` (the call names the file). */
export function DiffBlock({ text, path = "", bare = false }) {
    const parsed = useMemo(() => parseDiff(text, path), [text, path]);
    const files = parsed.files.filter((file) => file.hunks.length > 0 || file.binary);

    // Lines without numbered hunks (as in a diff written by hand) are colored as a diff, not drawn as one.
    if (files.length === 0) {
        return html`<pre class="diff" dangerouslySetInnerHTML=${{ __html: highlight(text, "diff") }}></pre>`;
    }

    return html`<div class="dv-block">
        ${files.map(
            (file) => html`<${DiffFile}
                file=${file}
                path=${bare ? path : ""}
                head=${!bare}
            />`,
        )}
    </div>`;
}

// ─── Settings bar ────────────────────────────────────────────────────────────────────

/** Unified or split, and wrapping: the same on every diff of this device. */
function DiffSettings() {
    const { layout, wrap } = diffPrefs;
    const next = nextLayout(layout);

    return html`<span class="dv-settings">
        <button
            type="button"
            class="chip toggle"
            title=${`Layout: ${layout}. Tap for ${next} (s)`}
            onClick=${() => setDiffPrefs({ layout: next })}
        >
            ${layout === "auto" ? "Auto" : layout === "split" ? "Split" : "Unified"}
        </button>
        <button
            type="button"
            class=${`chip toggle ${wrap ? "on" : ""}`}
            title="Wrap long lines (w)"
            aria-pressed=${wrap ? "true" : "false"}
            onClick=${() => setDiffPrefs({ wrap: !wrap })}
        >
            Wrap
        </button>
    </span>`;
}

// ─── Review: every change in the folder ───────────────────────────────────────────────

const VIEWED_KEY = "pocket.viewed";

function readViewed(id) {
    try {
        return JSON.parse(localStorage.getItem(`${VIEWED_KEY}.${id}`)) ?? {};
    } catch {
        return {};
    }
}

function writeViewed(id, viewed) {
    localStorage.setItem(`${VIEWED_KEY}.${id}`, JSON.stringify(viewed));
}

/** How long after the conversation moves on the changes are read again: soon when quiet, less often while Pi works. */
const QUIET_WAIT = 1200;
const BUSY_WAIT = 4000;
/** While Pi works, the longest the changes go without being read again. */
const BUSY_MAX = 8000;

/** What changed, per conversation: the last answer, and the request on its way, shared by everything that shows it. */
const changesCache = new Map();

/** Ask again for what changed in a conversation's folder, at most once at a time. */
export function reloadChanges(id = store.state.conversationId) {
    const known = changesCache.get(id) ?? { data: null, error: null, pending: null };

    if (known.pending) {
        return known.pending;
    }

    known.pending = actions.changes(id).then(
        (data) => Object.assign(known, { data, error: null, pending: null, at: Date.now() }),
        (failure) => Object.assign(known, { error: failure.message, pending: null }),
    );
    changesCache.set(id, known);
    known.pending.finally(() => store.set({}));

    return known.pending;
}

/**
 * What changed in this conversation's folder, `{ changes, error }`, fetched when first wanted and again a moment after
 * the conversation moves on (Pi's edits show up on their own) while `live`.
 */
export function useChanges(live = true) {
    const id = store.state.conversationId;
    const known = changesCache.get(id);
    const lastEntry = store.state.view.order?.at(-1);
    const busy = store.state.view.live?.busy;

    useEffect(() => {
        if (!changesCache.get(id)?.data) {
            reloadChanges(id);
        }
    }, [id]);
    useEffect(() => {
        if (!live) {
            return;
        }

        // While Pi works, entries come quickly: look less often then, but at least every few seconds.
        const since = Date.now() - (changesCache.get(id)?.at ?? 0);
        const wait = busy ? Math.max(0, Math.min(BUSY_WAIT, BUSY_MAX - since)) : QUIET_WAIT;
        const timer = setTimeout(() => reloadChanges(id), wait);

        return () => clearTimeout(timer);
    }, [lastEntry, busy, live, id]);

    return { changes: known?.data ?? null, error: known?.error ?? null };
}

/** Diffs fetched per conversation and file, until the file changes (its version, from the server). */
const diffCache = new Map();
/** How many diffs are kept: the oldest go first. */
const DIFF_CACHE = 200;
/** Refreshes per conversation: each one makes every diff's key new, so diffs on screen are read again too. */
const refreshes = new Map();

/**
 * What a diff depends on: the file (its version, and its counts), the commit it is against, and the last Refresh. Any
 * of them changing reads the diff again.
 */
const diffKey = (id, file, base) =>
    [
        id,
        file.path,
        file.kind,
        file.version ?? "",
        `${file.added}:${file.removed}`,
        base ?? "",
        refreshes.get(id) ?? 0,
    ].join("\u0000");

function keepDiff(key, made) {
    if (diffCache.size >= DIFF_CACHE) {
        diffCache.delete(diffCache.keys().next().value);
    }

    diffCache.set(key, made);
}

/** Forget a conversation's diffs and files, so Refresh reads every one again, those on screen included. */
function forgetDiffs(id) {
    refreshes.set(id, (refreshes.get(id) ?? 0) + 1);

    for (const cache of [diffCache, fileTexts]) {
        for (const key of cache.keys()) {
            if (key.startsWith(`${id}\u0000`)) {
                cache.delete(key);
            }
        }
    }
}

/** Fetches of diffs at once: a folder of 300 changed files asks for them a few at a time. */
const DIFF_FETCHES = 4;
let fetching = 0;
const waiting = [];

function fetchDiff(id, path) {
    return new Promise((resolve, reject) => {
        const run = async () => {
            fetching++;

            try {
                const response = await fetch(
                    `/api/c/${id}/changes/diff?path=${encodeURIComponent(path)}`,
                );
                const text = await response.text();

                if (!response.ok) {
                    let failure;

                    try {
                        failure = JSON.parse(text).error;
                    } catch {
                        // Not the server's answer (a proxy's page, say): the status says enough.
                    }

                    throw new Error(failure ?? `HTTP ${response.status}`);
                }

                resolve(text);
            } catch (error) {
                reject(error);
            } finally {
                fetching--;
                waiting.shift()?.();
            }
        };

        if (fetching < DIFF_FETCHES) {
            run();
        } else {
            waiting.push(run);
        }
    });
}

/** Paths in the order the tree shows them: at each level, folders before files, each by name. */
function treeOrder(a, b) {
    const left = a.path.split("/");
    const right = b.path.split("/");

    for (let index = 0; index < Math.min(left.length, right.length); index++) {
        const leftDir = index < left.length - 1;
        const rightDir = index < right.length - 1;

        if (leftDir !== rightDir) {
            return leftDir ? -1 : 1;
        }

        if (left[index] !== right[index]) {
            return left[index].localeCompare(right[index]);
        }
    }

    return left.length - right.length;
}

/** The folders and files of a list of changed paths, as a tree whose single-child folders are joined: `src/server/`. */
function treeOf(files) {
    const root = { name: "", dirs: new Map(), files: [] };

    for (const file of files) {
        const parts = file.path.split("/");
        let node = root;

        for (const part of parts.slice(0, -1)) {
            if (!node.dirs.has(part)) {
                node.dirs.set(part, { name: part, dirs: new Map(), files: [] });
            }

            node = node.dirs.get(part);
        }

        node.files.push(file);
    }

    const join = (node) => {
        for (const [key, child] of node.dirs) {
            let each = child;

            while (each.files.length === 0 && each.dirs.size === 1) {
                const [only] = each.dirs.values();

                each = { ...only, name: `${each.name}/${only.name}` };
            }

            node.dirs.set(key, each);
            join(each);
        }
    };

    join(root);

    return root;
}

/** A folder of the review's tree, which folds on its own. */
function TreeDir({ dir, depth, current, viewed, onPick }) {
    const [open, setOpen] = useState(true);

    return html`<div class="dr-dir">
        <button
            type="button"
            class="dr-row dir"
            style=${`--depth:${depth}`}
            aria-expanded=${open ? "true" : "false"}
            onClick=${() => setOpen(!open)}
        >
            <${Icon} name="chevron" size=${11} class=${`chev ${open ? "open" : ""}`} />
            <span class="dr-name">${dir.name}</span>
        </button>
        ${
            open &&
            html`<${TreeNode}
                node=${dir}
                depth=${depth + 1}
                current=${current}
                viewed=${viewed}
                onPick=${onPick}
            />`
        }
    </div>`;
}

function TreeNode({ node, depth, current, viewed, onPick }) {
    return html`${[...node.dirs.values()]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(
            (dir) => html`<${TreeDir}
                key=${dir.name}
                dir=${dir}
                depth=${depth}
                current=${current}
                viewed=${viewed}
                onPick=${onPick}
            />`,
        )}
    ${node.files.map(
        (file) => html`<button
            type="button"
            key=${file.path}
            class=${`dr-row file ${current === file.path ? "on" : ""} ${viewed(file) ? "seen" : ""}`}
            aria-current=${current === file.path ? "true" : undefined}
            style=${`--depth:${depth}`}
            title=${file.path}
            onClick=${() => onPick(file.path)}
        >
            <span class=${`change-kind ${file.kind}`}>${KIND_LETTERS[file.kind]}</span>
            <span class="dr-name">${file.path.split("/").pop()}</span>
            ${file.byPi && html`<span class="dr-pi" title="Pi edited it">π</span>`}
            <span class="dr-tail">${viewed(file) ? html`<${Icon} name="check" size=${13} />` : html`<${ChangeCounts} added=${file.added ?? 0} removed=${file.removed ?? 0} />`}</span>
        </button>`,
    )}`;
}

/** One file of the review: fetches its diff once it nears the screen, then draws it. */
function ReviewFile({
    id,
    file,
    root,
    base,
    open,
    viewedAs,
    onToggle,
    onViewed,
    onLoaded,
    onChanged,
}) {
    const ref = useRef(null);
    const key = diffKey(id, file, base);
    const [entry, setEntry] = useState(() => diffCache.get(key) ?? null);
    const [error, setError] = useState(null);
    const [near, setNear] = useState(false);
    const [undoing, setUndoing] = useState(false);

    useEffect(() => {
        const element = ref.current;

        if (!element || near) {
            return;
        }

        const observer = new IntersectionObserver(
            (seen) => seen.some((each) => each.isIntersecting) && setNear(true),
            { rootMargin: "900px 0px" },
        );

        observer.observe(element);

        return () => observer.disconnect();
    }, [near]);

    useEffect(() => {
        const cached = diffCache.get(key);

        if (cached) {
            setEntry(cached);
            onLoaded(file.path, cached.print);

            return;
        }

        if (!near) {
            return;
        }

        let live = true;

        setEntry(null);
        fetchDiff(id, file.path).then(
            (text) => {
                const parsed = parseDiff(text, file.path).files[0] ?? null;
                const made = { parsed, print: fingerprint(text) };

                keepDiff(key, made);

                if (live) {
                    setEntry(made);
                    onLoaded(file.path, made.print);
                }
            },
            (failure) => live && setError(failure.message),
        );

        return () => {
            live = false;
        };
    }, [key, near]);

    // The same object while nothing changed: the diff's colors and rows are worked out once per version.
    const shown = useMemo(
        () =>
            entry?.parsed
                ? { ...entry.parsed, kind: file.kind, path: file.path }
                : { ...file, hunks: [], added: file.added ?? 0, removed: file.removed ?? 0 },
        [entry, key],
    );
    const viewed = viewedAs !== undefined && (!entry || viewedAs === entry.print);
    const stale = viewedAs !== undefined && entry && viewedAs !== entry.print;

    // Undoing a file that is new since the last commit deletes it: the buttons say so.
    const fresh = file.kind === "new" || file.kind === "added";

    // The first tap asks; a second within a few seconds undoes.
    useEffect(() => {
        if (!undoing) {
            return;
        }

        const timer = setTimeout(() => setUndoing(false), 4000);

        return () => clearTimeout(timer);
    }, [undoing]);

    const undo = () =>
        undoing
            ? attempt(async () => {
                  await actions.revert(file.path);
                  notify(
                      "info",
                      fresh
                          ? `Deleted ${file.path}.`
                          : `${file.path} is as the last commit has it.`,
                  );
                  onChanged();
              })
            : setUndoing(true);

    const tools = html`${
        file.kind !== "deleted" &&
        html`<button
            class="icon-button dv-tool"
            type="button"
            title="Open the file"
            aria-label="Open the file"
            onClick=${() => openFile(`${root}/${file.path}`)}
        >
            <${Icon} name="file" size=${15} />
        </button>`
    }
    ${
        canSteer() &&
        file.kind !== "renamed" &&
        html`<button
            class=${`icon-button dv-tool ${undoing ? "danger" : ""}`}
            type="button"
            title=${undoing ? (fresh ? "Tap again to delete this new file" : "Tap again to throw these changes away") : fresh ? "Delete this new file" : "Undo the changes to this file"}
            aria-label="Undo changes"
            onClick=${undo}
        >
            ${undoing ? (fresh ? "Delete?" : "Undo?") : "↺"}
        </button>`
    }`;

    return html`<div class="dr-file" ref=${ref} data-path=${file.path}>
        <${DiffFile}
            file=${shown}
            path=${`${root}/${file.path}`}
            version=${file.version ?? ""}
            loading=${!entry}
            expand=${true}
            tools=${tools}
            viewed=${viewed}
            onViewed=${(on) => onViewed(file.path, on ? (entry?.print ?? "?") : undefined)}
            open=${open && !viewed}
            onToggle=${onToggle}
            note=${html`${file.byPi && html`<span class="chip dv-chip">Pi</span>`}${stale && html`<span class="chip dv-chip warn" title="It changed after you marked it viewed">changed</span>`}`}
        />
        ${open && !viewed && !entry && !error && html`<div class="dv-wait"><${Loader} label="Reading the diff" /></div>`}
        ${error && html`<p class="dv-empty err">${error}</p>`}
    </div>`;
}

/**
 * Review: every uncommitted change in the session's folder, as a tree of files beside their diffs (or above them, when
 * narrow). Files fold, mark as viewed (kept per device until the file's diff changes), and fetch their diffs as they
 * near the screen. Keys: j and k go to the next and previous file, n and p to the next and previous hunk, v marks the
 * file at the top as viewed, s switches the layout, w wrapping.
 */
export function DiffReview({ active = true, autoFocus = false, covering = false }) {
    const id = store.state.conversationId;
    const { server } = store.state;
    const { changes, error } = useChanges(active);
    const load = () => reloadChanges(id);

    const refresh = () => {
        forgetDiffs(id);
        load();
    };

    const [viewed, setViewedState] = useState(() => readViewed(id));
    const [folded, setFolded] = useState({});
    const [filter, setFilter] = useState("");
    const [onlyPi, setOnlyPi] = useState(false);
    const [current, setCurrent] = useState(null);
    const [treeOpen, setTreeOpen] = useState(false);
    const prints = useRef({});
    const ref = useRef(null);
    const width = useWidth(ref);
    const wide = width >= 720;

    // The tree of changed files over the diffs, where they do not fit side by side, in a tile that covers the screen:
    // back folds it away.
    useBack(covering && active && treeOpen && width > 0 && !wide, () => setTreeOpen(false));

    const wasActive = useRef(active);

    useEffect(() => {
        setViewedState(readViewed(id));
    }, [id]);
    // Keys reach the review when someone asks for it (its tab picked, the tile opened on it, the sheet), away from touch
    // screens: not on a reload, nor on a phone, where it would only move the page.
    const ask = store.state.filesAsk;
    const focus = () =>
        !matchMedia("(pointer: coarse)").matches && ref.current?.focus({ preventScroll: true });

    useEffect(() => {
        if (active && !wasActive.current) {
            focus();
        }

        wasActive.current = active;
    }, [active]);
    useEffect(() => {
        if (active && (autoFocus || (ask?.tab === "changes" && Date.now() - ask.at < 1500))) {
            focus();
        }
    }, [ask, changes !== null]);

    /** Mark a file viewed as of the diff `print` names, or not viewed (undefined), kept for this device. */
    const setViewed = (path, print) =>
        setViewedState((before) => {
            const next = { ...before };

            if (print === undefined) {
                delete next[path];
            } else {
                next[path] = print;
            }

            writeViewed(id, next);

            return next;
        });

    // Marks of files that are no longer changed (committed, or put back) go: they would never be seen again.
    useEffect(() => {
        if (!changes?.repo || changes.more > 0) {
            return;
        }

        const listed = new Set(changes.files.map((file) => file.path));

        setViewedState((before) => {
            const kept = Object.fromEntries(
                Object.entries(before).filter(([path]) => listed.has(path)),
            );

            if (Object.keys(kept).length === Object.keys(before).length) {
                return before;
            }

            writeViewed(id, kept);

            return kept;
        });
    }, [changes]);

    const files = (changes?.files ?? [])
        .filter(
            (file) =>
                (!onlyPi || file.byPi) &&
                (filter === "" || file.path.toLowerCase().includes(filter.toLowerCase())),
        )
        .sort(treeOrder);

    const isViewed = (file) => {
        const mark = viewed[file.path];

        return mark !== undefined && (prints.current[file.path] ?? mark) === mark;
    };

    const seen = files.filter(isViewed).length;
    const added = files.reduce((sum, file) => sum + (file.added ?? 0), 0);
    const removed = files.reduce((sum, file) => sum + (file.removed ?? 0), 0);
    const tree = useMemo(() => treeOf(files), [changes, filter, onlyPi]);

    const scrollTo = (path) => {
        const element = ref.current?.querySelector(`.dr-file[data-path="${CSS.escape(path)}"]`);

        setCurrent(path);
        setFolded((all) => ({ ...all, [path]: false }));

        if (!wide) {
            setTreeOpen(false);
        }

        requestAnimationFrame(() =>
            element?.scrollIntoView({ block: "start", behavior: "smooth" }),
        );
    };

    /** The file whose diff is at the top of the scroller now. */
    const atTop = () => {
        const scroller =
            ref.current?.closest(".files-body, .sheet-body") ?? document.scrollingElement;
        const top = scroller.getBoundingClientRect().top + 8;
        const sections = [...(ref.current?.querySelectorAll(".dr-file") ?? [])];

        return (
            sections.find((each) => each.getBoundingClientRect().bottom > top + 40) ?? sections[0]
        );
    };

    const onKey = (event) => {
        if (
            event.defaultPrevented ||
            event.ctrlKey ||
            event.metaKey ||
            event.altKey ||
            /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)
        ) {
            return;
        }

        const sections = [...(ref.current?.querySelectorAll(".dr-file") ?? [])];
        // The file last gone to, while it is on screen; otherwise the one at the top. A smooth scroll still on its
        // way would otherwise make a second press go to the same file.
        const chosen = sections.find((each) => each.dataset.path === current);
        const box = chosen?.getBoundingClientRect();
        const here = box && box.bottom > 0 && box.top < innerHeight ? chosen : atTop();
        const index = sections.indexOf(here);
        const key = event.key;

        if (key === "j" || key === "k") {
            const next =
                sections[
                    Math.max(0, Math.min(sections.length - 1, index + (key === "j" ? 1 : -1)))
                ];

            if (next) {
                scrollTo(next.dataset.path);
            }
        } else if (key === "n" || key === "p") {
            // The first row of each run of changes, in either layout, and where a row lands when gone to: below the
            // file's header, by the rows' scroll margin.
            const changed = ".dv-row.add, .dv-row.del, .dv-row.change";
            const starts = [...ref.current.querySelectorAll(changed)].filter(
                (row) => !row.previousElementSibling?.matches(changed),
            );
            const scroller = ref.current.closest(".files-body, .sheet-body");
            const margin = starts[0] ? parseFloat(getComputedStyle(starts[0]).scrollMarginTop) : 0;
            const top = (scroller?.getBoundingClientRect().top ?? 0) + (margin || 0);
            const target =
                key === "n"
                    ? starts.find((row) => row.getBoundingClientRect().top > top + 2)
                    : starts.findLast((row) => row.getBoundingClientRect().top < top - 2);

            target?.scrollIntoView({ block: "start", behavior: "smooth" });
        } else if (key === "v" && here) {
            const path = here.dataset.path;

            setViewed(path, isViewed({ path }) ? undefined : (prints.current[path] ?? "?"));
        } else if (key === "s") {
            const next = nextLayout(diffPrefs.layout);

            setDiffPrefs({ layout: next });
            notify("info", `Diffs: ${next}.`);
        } else if (key === "w") {
            setDiffPrefs({ wrap: !diffPrefs.wrap });
        } else {
            return;
        }

        event.preventDefault();
    };

    if (error && !changes) {
        return html`<div class="dr" ref=${ref}><p class="dv-empty err">${error}</p></div>`;
    }

    if (!changes) {
        return html`<div class="dr" ref=${ref}><${Loader} label="Asking git" /></div>`;
    }

    const all = changes.files;
    const progress = files.length === 0 ? 0 : seen / files.length;

    return html`<div class=${`dr ${wide ? "wide" : ""}`} ref=${ref} tabindex="-1" onKeyDown=${onKey}>
        <div class="dr-summary">
            ${
                changes.repo
                    ? html`<span class="dr-where mono">
                          <span class="dr-path">${shortPath(changes.repo.root, server?.home)}</span>${
                              changes.repo.branch && " · "
                          }${
                              changes.repo.branch &&
                              (branchAvailable()
                                  ? html`<button
                                        class="link dr-branch"
                                        type="button"
                                        title="Switch or make a branch"
                                        onClick=${() => openSheet({ type: "branch" })}
                                    >
                                        ⎇ ${changes.repo.branch}
                                    </button>`
                                  : html`<span title="Branch">⎇ ${changes.repo.branch}</span>`)
                          }
                      </span>`
                    : html`<span class="muted small">Not a git repository: only Pi's edits are listed.</span>`
            }
            ${
                all.length > 0 &&
                html`<span class="dr-stats">
                    <strong>${files.length}</strong> ${files.length === 1 ? "file" : "files"}
                    <${ChangeCounts} added=${added} removed=${removed} />
                    <span class="dr-progress" title=${`${seen} of ${files.length} viewed`}>
                        <i style=${`width:${progress * 100}%`}></i>
                    </span>
                    <span class="muted">${seen}/${files.length} viewed</span>
                </span>`
            }
            <button
                class="icon-button dv-tool"
                type="button"
                title="Look again"
                aria-label="Refresh"
                onClick=${refresh}
            >
                <${Icon} name="reload" size=${15} />
            </button>
        </div>
        ${
            all.length > 0 &&
            html`<div class="dr-tools">
                <input
                    class="dr-filter"
                    type="search"
                    placeholder="Filter files"
                    value=${filter}
                    onInput=${(event) => setFilter(event.currentTarget.value)}
                    autocapitalize="off"
                    autocomplete="off"
                    spellcheck="false"
                />
                ${
                    all.some((file) => file.byPi) &&
                    html`<button
                        type="button"
                        class=${`chip toggle ${onlyPi ? "on" : ""}`}
                        aria-pressed=${onlyPi ? "true" : "false"}
                        title="Only the files Pi edited"
                        onClick=${() => setOnlyPi(!onlyPi)}
                    >
                        π only
                    </button>`
                }
                <${DiffSettings} />
                ${
                    !wide &&
                    html`<button
                        type="button"
                        class=${`chip toggle ${treeOpen ? "on" : ""}`}
                        onClick=${() => setTreeOpen(!treeOpen)}
                    >
                        Files
                    </button>`
                }
            </div>`
        }
        ${
            changes.repo &&
            all.length === 0 &&
            html`<div class="dr-clean">
                <${Icon} name="check" size=${22} />
                <p>No uncommitted changes${changes.repo.branch ? ` on ${changes.repo.branch}` : ""}.</p>
            </div>`
        }
        ${
            all.length > 0 &&
            html`<div class="dr-main">
                ${
                    (wide || treeOpen) &&
                    html`<nav class="dr-tree" aria-label="Changed files">
                        <${TreeNode}
                            node=${tree}
                            depth=${0}
                            current=${current}
                            viewed=${isViewed}
                            onPick=${scrollTo}
                        />
                        ${files.length === 0 && html`<p class="muted small">No file matches.</p>`}
                    </nav>`
                }
                <div class="dr-files">
                    ${files.map(
                        (file) => html`<${ReviewFile}
                            key=${file.path}
                            id=${id}
                            file=${file}
                            root=${changes.repo.root}
                            base=${changes.repo.head}
                            open=${!folded[file.path]}
                            viewedAs=${viewed[file.path]}
                            onToggle=${() => {
                                if (isViewed(file)) {
                                    setViewed(file.path, undefined);
                                    setFolded((each) => ({ ...each, [file.path]: false }));
                                } else {
                                    setFolded((each) => ({
                                        ...each,
                                        [file.path]: !each[file.path],
                                    }));
                                }
                            }}
                            onViewed=${setViewed}
                            onLoaded=${(path, print) => {
                                prints.current[path] = print;
                                // Marked viewed before its diff arrived: as of this one.
                                setViewedState((before) => {
                                    if (before[path] !== "?") {
                                        return before;
                                    }

                                    const next = { ...before, [path]: print };

                                    writeViewed(id, next);

                                    return next;
                                });
                            }}
                            onChanged=${load}
                        />`,
                    )}
                    ${
                        changes.more > 0 &&
                        html`<p class="muted small">
                            And ${changes.more} more changed ${changes.more === 1 ? "file" : "files"}, not listed here.
                        </p>`
                    }
                </div>
            </div>`
        }
        ${
            changes.piOnly.length > 0 &&
            html`<div class="dr-pionly">
                <div class="group-title">${changes.repo ? "Pi also edited (no uncommitted change)" : "Pi wrote or edited"}</div>
                ${changes.piOnly.map(
                    (
                        each,
                    ) => html`<button type="button" class="list-item" onClick=${() => jumpToEntry(each.entryId)}>
                        <span class="mono">${shortPath(each.path, server?.home)}</span>
                        <span class="muted small">show</span>
                    </button>`,
                )}
            </div>`
        }
    </div>`;
}
