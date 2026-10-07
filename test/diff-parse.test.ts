// The diff viewer's parsing (web/diff-parse.js): git's diffs and Pi's edit cards as files, hunks, and lines, changed
// lines paired by likeness, and the words that changed between them.
import assert from "node:assert/strict";
import { test } from "node:test";

type Line = { type: string; text: string; old?: number; new?: number };
type Hunk = {
    oldStart: number;
    newStart: number;
    oldEnd: number;
    newEnd: number;
    context: string;
    lines: Line[];
};
type File = {
    path: string;
    oldPath: string | null;
    kind: string;
    binary: boolean;
    mode: boolean;
    truncated: boolean;
    hunks: Hunk[];
    added: number;
    removed: number;
};
type Row = { kind: string; left: Line | null; right: Line | null; words?: unknown };
type Ranges = [number, number][];

// A web module, loaded as the browser loads it; its path as a value keeps the type checker from looking for types.
const MODULE: string = "../web/diff-parse.js";
const { parseDiff, hunkRows, wordDiff, markRanges, changeCells } = (await import(MODULE)) as {
    parseDiff(text: string, path?: string): { files: File[] };
    hunkRows(hunk: { lines: Line[] }): Row[];
    wordDiff(before: string, after: string): { left: Ranges; right: Ranges } | null;
    markRanges(html: string, ranges: Ranges): string;
    changeCells(added: number, removed: number): string[];
};

const GIT = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -10,4 +10,5 @@ export class App {
     open() {
-        return 1;
+        return 2;
+        // and more
     }
 
@@ -40,2 +41,2 @@ function close() {
-    a();
+    b();
     done();
diff --git a/new.txt b/new.txt
new file mode 100644
index 0000000..e69de29
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+hello
+world
\\ No newline at end of file
diff --git a/gone.txt b/gone.txt
deleted file mode 100644
--- a/gone.txt
+++ /dev/null
@@ -1 +0,0 @@
-bye
diff --git a/old name.md b/new name.md
similarity index 100%
rename from old name.md
rename to new name.md
diff --git a/logo.png b/logo.png
Binary files a/logo.png and b/logo.png differ
diff --git a/run.sh b/run.sh
old mode 100644
new mode 100755
`;

test("a git diff of several files reads into files, hunks, and numbered lines", () => {
    const { files } = parseDiff(GIT);

    assert.deepEqual(
        files.map((file) => [file.kind, file.path, file.added, file.removed, file.hunks.length]),
        [
            ["modified", "src/app.ts", 3, 2, 2],
            ["added", "new.txt", 2, 0, 1],
            ["deleted", "gone.txt", 0, 1, 1],
            ["renamed", "new name.md", 0, 0, 0],
            ["modified", "logo.png", 0, 0, 0],
            ["modified", "run.sh", 0, 0, 0],
        ],
    );

    const [first, second] = files[0]!.hunks;

    assert.equal(first!.context, "export class App {");
    assert.deepEqual(
        first!.lines.map((line) => [line.type, line.old ?? null, line.new ?? null]),
        [
            ["ctx", 10, 10],
            ["del", 11, null],
            ["add", null, 11],
            ["add", null, 12],
            ["ctx", 12, 13],
            ["ctx", 13, 14],
        ],
    );
    assert.deepEqual(
        [first!.oldEnd, first!.newEnd, second!.newStart, second!.newEnd],
        [13, 14, 41, 42],
    );
    assert.equal(files[1]!.hunks[0]!.lines.at(-1)!.type, "note");
    assert.equal(files[3]!.oldPath, "old name.md");
    assert.equal(files[4]!.binary, true);
    assert.equal(files[5]!.mode, true);
});

test("a diff the server cut short says so", () => {
    const { files } = parseDiff(
        "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-x\n+y\n… the rest of the diff is left out …\n",
    );

    assert.equal(files[0]!.truncated, true);
    assert.equal(files[0]!.hunks[0]!.lines.length, 2);
});

test("Pi's edit cards read with each unchanged line's new number, and a hunk per gap", () => {
    const text = [
        " 10 const a = 1;",
        "-11 const b = 2;",
        "+11 const b = 3;",
        "+12 const c = 4;",
        " 12 return a;",
        "    ...",
        " 40 x",
        "-41 y",
        " 42 z",
    ].join("\n");
    const { files } = parseDiff(text, "src/x.ts");
    const file = files[0]!;

    assert.equal(file.path, "src/x.ts");
    assert.deepEqual([file.added, file.removed, file.hunks.length], [2, 2, 2]);
    assert.deepEqual(
        file.hunks.map((hunk) => hunk.lines.map((line) => `${line.old ?? ""}/${line.new ?? ""}`)),
        [
            ["10/10", "11/", "/11", "/12", "12/13"],
            ["40/41", "41/", "42/42"],
        ],
    );
});

test("a changed line pairs with the added line most like it, not the first", () => {
    const rows = hunkRows({
        lines: [
            { type: "del", text: "    const people = !browsing && peopleDocked(state);", old: 189 },
            {
                type: "add",
                text: "    const filing = inConversation && state.filesOpen && filesAvailable();",
                new: 191,
            },
            {
                type: "add",
                text: "    const people = !browsing && !filing && peopleDocked(state);",
                new: 192,
            },
        ],
    });

    assert.deepEqual(
        rows.map((row) => [row.left?.old ?? null, row.right?.new ?? null]),
        [
            [null, 191],
            [189, 192],
        ],
    );
    assert.deepEqual(rows[1]!.words, { left: [], right: [[32, 42]] });
});

test("word marks cover what changed, and stay away from lines that were rewritten", () => {
    assert.deepEqual(wordDiff("return user.name;", "return user.fullName;"), {
        left: [[12, 16]],
        right: [[12, 20]],
    });
    assert.equal(wordDiff("let total = 0;", "import { thing } from './elsewhere';"), null);
    assert.equal(wordDiff("same", "same"), null);
});

test("marks go around text inside highlighted markup, never across its tags", () => {
    const colored =
        '<span class="hl-kw">const</span> a <span class="hl-op">=</span> &quot;x&quot;;';

    // "st a" (characters 3 to 7) crosses the end of the keyword's span; the quote entity counts as one character.
    assert.equal(
        markRanges(colored, [
            [3, 7],
            [10, 11],
        ]),
        '<span class="hl-kw">con<mark>st</mark></span><mark> a</mark> <span class="hl-op">=</span> <mark>&quot;</mark>x&quot;;',
    );
    assert.equal(markRanges("a &lt; b", [[2, 3]]), "a <mark>&lt;</mark> b");
    assert.equal(markRanges("plain", []), "plain");
});

test("the change bar gives each side that changed a cell", () => {
    assert.deepEqual(changeCells(0, 0), ["", "", "", "", ""]);
    assert.deepEqual(changeCells(1, 0), ["add", "", "", "", ""]);
    assert.deepEqual(changeCells(10, 3), ["add", "del", "", "", ""]);
    assert.deepEqual(changeCells(500, 500), ["add", "add", "add", "del", "del"]);
});

test("a side with no lines (-U0) starts after the line its hunk names", () => {
    const { files } = parseDiff(
        "--- a/x\n+++ b/x\n@@ -4,0 +5,2 @@\n+one\n+two\n@@ -10 +11,0 @@\n-gone\n",
    );
    const [added, removed] = files[0]!.hunks;

    assert.deepEqual([added!.oldEnd, added!.newEnd], [4, 6]);
    assert.deepEqual(
        added!.lines.map((line) => line.new),
        [5, 6],
    );
    assert.deepEqual([removed!.oldEnd, removed!.newEnd], [10, 11]);
});

test("an emoji that changed is marked whole", () => {
    const words = wordDiff("the build is 😀 today", "the build is 😁 today");

    assert.deepEqual(words, { left: [[13, 15]], right: [[13, 15]] });
    assert.equal(
        markRanges("the build is 😁 today", words!.right),
        "the build is <mark>😁</mark> today",
    );
});

test("paths with spaces, quotes, or letters past ASCII read as git means them", () => {
    const { files } = parseDiff(`diff --git a/my pic.png b/my pic.png
index bdc955b..8835708 100644
Binary files a/my pic.png and b/my pic.png differ
diff --git a/run me.sh b/run me.sh
old mode 100644
new mode 100755
diff --git a/old name.txt b/new name.txt
similarity index 100%
rename from old name.txt
rename to new name.txt
diff --git "a/caf\\303\\251.txt" "b/th\\303\\251.txt"
similarity index 100%
rename from "caf\\303\\251.txt"
rename to "th\\303\\251.txt"
diff --git "a/quote\\"d.txt" "b/quote\\"d.txt"
index bca70f3..6178079 100644
--- "a/quote\\"d.txt"
+++ "b/quote\\"d.txt"
@@ -1 +1 @@
-q
+b
`);

    assert.deepEqual(
        files.map(({ path, oldPath, kind }) => [kind, oldPath, path]),
        [
            ["modified", "my pic.png", "my pic.png"],
            ["modified", "run me.sh", "run me.sh"],
            ["renamed", "old name.txt", "new name.txt"],
            ["renamed", "café.txt", "thé.txt"],
            ["modified", 'quote"d.txt', 'quote"d.txt'],
        ],
    );
    assert.deepEqual(
        files.map(({ binary, mode }) => [binary, mode]),
        [
            [true, false],
            [false, true],
            [false, false],
            [false, false],
            [false, false],
        ],
    );
});

test("any text parses without throwing, and changed words always fit their lines", () => {
    // A small seeded generator: the same cases on every run, so a failure can be run again.
    let seed = 7;
    const random = () => ((seed = (seed * 48271) % 2147483647) / 2147483647) as number;
    const pick = <T>(items: T[]) => items[Math.floor(random() * items.length)]!;
    const pieces = [
        "diff --git a/x b/x",
        "--- a/x",
        "+++ b/x",
        "--- /dev/null",
        "+++ /dev/null",
        "@@ -1,3 +1,3 @@",
        "@@ -0,0 +1 @@",
        "@@ -5 +5,0 @@ fn",
        "@@ broken",
        "\\ No newline at end of file",
        "rename from a b",
        'rename to "c\\303\\251"',
        "Binary files a/x and b/x differ",
        "old mode 100644",
        "+added",
        "-removed",
        " context",
        "",
        "+ 12 edit",
        "- 3 gone",
        "  4 kept",
        "...",
        "… the rest of the diff is left out …",
        "plain words",
    ];
    const words = ["a", "b", "const", "=", "😀", "x1", " ", "&", "<b>", "\t"];

    for (let round = 0; round < 2000; round++) {
        const text = Array.from({ length: 1 + Math.floor(random() * 14) }, () => pick(pieces)).join(
            random() < 0.2 ? "\r\n" : "\n",
        );
        const { files } = parseDiff(text, random() < 0.5 ? "x.js" : "");

        for (const file of files) {
            for (const hunk of file.hunks) {
                const rows = hunkRows(hunk);
                const shown = rows.flatMap((row) => [row.left, row.right]).filter(Boolean);

                assert.ok(
                    hunk.lines.every((line) => shown.includes(line)),
                    `every line drawn: ${JSON.stringify(text)}`,
                );
            }
        }

        const line = () =>
            Array.from({ length: Math.floor(random() * 12) }, () => pick(words)).join("");
        const [before, after] = [line(), line()];
        const marks = wordDiff(before, after);

        for (const [ranges, source] of marks
            ? [[marks.left, before] as const, [marks.right, after] as const]
            : []) {
            let end = 0;

            for (const [from, to] of ranges) {
                assert.ok(
                    from >= end && to > from && to <= source.length,
                    JSON.stringify({ before, after, marks }),
                );
                end = to;
            }

            // Escaped as the highlighter writes it, and as it is: a stray & or < is text too.
            for (const html of [source.replace(/&/g, "&amp;").replace(/</g, "&lt;"), source]) {
                if (html === source && /<[^>]*>|&[#a-z0-9]+;/i.test(source)) {
                    continue;
                }

                const plain = markRanges(html, ranges).replace(/<\/?mark>/g, "");

                assert.equal(plain, html, "marks add nothing but marks");
            }
        }
    }
});
