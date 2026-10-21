/**
 * What an update changes in a file, as a unified diff (`git diff`'s form, which the web app's diff viewer reads):
 * Myers' algorithm over lines, after the lines both versions start and end with are set aside. It compares lines only:
 * a change of a file's last line break, or of CRLF to LF, shows as a file with no changed lines.
 */

/** Unchanged lines shown around each change. */
const CONTEXT = 3;
/**
 * The most lines added and removed that are worked out one by one: past it, the file shows as replaced whole. The
 * search keeps a row of numbers for each edit, so its memory grows with the square of this.
 */
const MAX_EDITS = 2000;

type Op = { kind: " " | "-" | "+"; line: string };

function lines(text: string): string[] {
    if (text === "") {
        return [];
    }

    const parts = text.replace(/\r\n/g, "\n").split("\n");

    if (parts.at(-1) === "") {
        parts.pop();
    }

    return parts;
}

/** The shortest edit from `a` to `b`, or the whole of `a` removed and `b` added past `MAX_EDITS`. */
function edits(a: string[], b: string[]): Op[] {
    const n = a.length;
    const m = b.length;
    const max = Math.min(n + m, MAX_EDITS);
    // The furthest point on each diagonal k (x - y), at k + offset.
    const offset = max + 1;
    const v = new Int32Array(2 * max + 3);
    /** After each round d, the diagonals -(d + 1) to d + 1: what the way back reads. */
    const trace: Int32Array[] = [];
    let found = -1;

    for (let d = 0; d <= max && found === -1; d++) {
        for (let k = -d; k <= d; k += 2) {
            let x =
                k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)
                    ? v[offset + k + 1]!
                    : v[offset + k - 1]! + 1;
            let y = x - k;

            while (x < n && y < m && a[x] === b[y]) {
                x++;
                y++;
            }

            v[offset + k] = x;

            if (x >= n && y >= m) {
                found = d;
                break;
            }
        }

        trace.push(v.slice(offset - d - 1, offset + d + 2));
    }

    if (found === -1) {
        return [
            ...a.map((line) => ({ kind: "-" as const, line })),
            ...b.map((line) => ({ kind: "+" as const, line })),
        ];
    }

    const ops: Op[] = [];
    let x = n;
    let y = m;

    for (let d = found; d > 0; d--) {
        // Round d - 1 kept the diagonals -d to d, at k + d.
        const before = trace[d - 1]!;
        const at = (k: number) => before[k + d]!;
        const k = x - y;
        const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
        const fromK = down ? k + 1 : k - 1;
        const fromX = at(fromK);
        const fromY = fromX - fromK;
        const midX = down ? fromX : fromX + 1;
        const midY = down ? fromY + 1 : fromY;

        while (x > midX && y > midY) {
            ops.push({ kind: " ", line: a[--x]! });
            y--;
        }

        ops.push(down ? { kind: "+", line: b[--y]! } : { kind: "-", line: a[--x]! });
        x = fromX;
        y = fromY;
    }

    while (x > 0 && y > 0) {
        ops.push({ kind: " ", line: a[--x]! });
        y--;
    }

    return ops.reverse();
}

/**
 * A file's change as a unified diff, `""` when nothing changed. `before` null is a file the update adds, `after` null
 * one it removes; text undefined on either side is a file that is not text.
 */
export function fileDiff(
    name: string,
    before: string | null | undefined,
    after: string | null | undefined,
): string {
    if (before === after) {
        return "";
    }

    const head = [
        `diff --git a/${name} b/${name}`,
        ...(before === null ? ["new file mode 100644"] : []),
        ...(after === null ? ["deleted file mode 100644"] : []),
    ];

    if (before === undefined || after === undefined) {
        return [...head, `Binary files a/${name} and b/${name} differ`, ""].join("\n");
    }

    const a = lines(before ?? "");
    const b = lines(after ?? "");
    // The lines both start and end with are set aside first: an update mostly changes a little in the middle.
    let start = 0;

    while (start < a.length && start < b.length && a[start] === b[start]) {
        start++;
    }

    let end = 0;

    while (
        end < a.length - start &&
        end < b.length - start &&
        a[a.length - 1 - end] === b[b.length - 1 - end]
    ) {
        end++;
    }

    const ops: Op[] = [
        ...a.slice(0, start).map((line) => ({ kind: " " as const, line })),
        ...edits(a.slice(start, a.length - end), b.slice(start, b.length - end)),
        ...a.slice(a.length - end).map((line) => ({ kind: " " as const, line })),
    ];

    return [
        ...head,
        `--- ${before === null ? "/dev/null" : `a/${name}`}`,
        `+++ ${after === null ? "/dev/null" : `b/${name}`}`,
        ...hunks(ops),
        "",
    ].join("\n");
}

/** The edit as hunks: each change with `CONTEXT` unchanged lines around it, changes close together in one hunk. */
function hunks(ops: Op[]): string[] {
    const out: string[] = [];
    const changed = ops.flatMap((op, at) => (op.kind === " " ? [] : [at]));
    let next = 0;

    while (next < changed.length) {
        const from = Math.max(0, changed[next]! - CONTEXT);
        let to = changed[next]!;

        // Changes whose context would meet go in one hunk.
        while (next + 1 < changed.length && changed[next + 1]! - to <= 2 * CONTEXT) {
            to = changed[++next]!;
        }

        to = Math.min(ops.length - 1, to + CONTEXT);
        next++;

        const slice = ops.slice(from, to + 1);
        // Where the hunk starts on each side: the lines of that side before it, plus one.
        const before = ops.slice(0, from);
        const oldBefore = before.filter((op) => op.kind !== "+").length;
        const newBefore = before.filter((op) => op.kind !== "-").length;
        const oldCount = slice.filter((op) => op.kind !== "+").length;
        const newCount = slice.filter((op) => op.kind !== "-").length;

        out.push(
            `@@ -${oldCount === 0 ? oldBefore : oldBefore + 1},${oldCount} +${newCount === 0 ? newBefore : newBefore + 1},${newCount} @@`,
        );

        // One at a time: a long hunk spread into one call would pass more arguments than a call takes.
        for (const op of slice) {
            out.push(`${op.kind}${op.line}`);
        }
    }

    return out;
}
