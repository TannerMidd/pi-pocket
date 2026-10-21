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

// A web module, loaded as the browser loads it; its path as a value keeps the type checker from looking for types.
const MODULE: string = "../web/diff-parse.js";
const { parseDiff } = (await import(MODULE)) as {
    parseDiff(text: string, path?: string): { files: File[] };
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
`;

test("a git diff of several files reads into files, hunks, and numbered lines", () => {
    const { files } = parseDiff(GIT);

    assert.deepEqual(
        files.map((file) => [file.kind, file.path, file.added, file.removed, file.hunks.length]),
        [
            ["modified", "src/app.ts", 3, 2, 2],
            ["added", "new.txt", 2, 0, 1],
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
