// The design_system tool and its file core: bounded UTF-8 text, no symlink followed at the file, and an atomic write.
import assert from "node:assert/strict";
import {
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
    MAX_BYTES,
    SYSTEM_FILE,
    boundedText,
    designSystemTool,
    readDesignSystemText,
    utf8Cut,
} from "../src/server/design/system.ts";

const folders = new Set<string>();

after(async () => {
    for (const dir of folders) {
        rmSync(dir, { recursive: true, force: true });
    }
});

/** A fresh session folder for the test, with the design system's folder, gone when the file ends. */
function folder(): string {
    const dir = mkdtempSync(join(tmpdir(), "pi-pocket-design-system-"));

    folders.add(dir);
    mkdirSync(join(dir, SYSTEM_FILE, ".."), { recursive: true });

    return dir;
}

const tool = designSystemTool();

/** A execute call with just what the tool asks for: `api.agent` gives the session's folder, `context` is unused. */
const run = (dir: string, args: { action: "read" | "write"; content?: string }) =>
    tool.execute(args, { agent: async () => ({ cwd: dir }) } as never, undefined as never);

const text = async (
    call: Promise<{ output?: readonly { type: string; text?: string }[] }>,
): Promise<string> => {
    const result = await call;
    const part = result.output?.find((item) => item.type === "text" && item.text !== undefined);

    if (part === undefined) {
        throw new Error("the call returned no text");
    }

    return (part as { text: string }).text;
};

test("the tool is registered as named, without a read-only mark, and without a replay-safe mark", () => {
    assert.equal(tool.name, "design_system");
    // Write changes the session's files, so plan mode's read-only mark must be absent.
    const marks = tool as { annotations?: { readOnlyHint?: boolean } };

    assert.ok(marks.annotations?.readOnlyHint !== true);
    // A write is not proven idempotent, so an interrupted call must not run again.
    assert.ok(tool.replay === undefined);
});

test("a read with no file explains that it is absent, and names what a design system holds", async () => {
    const dir = folder();
    const reply = await text(run(dir, { action: "read" }));

    assert.match(reply, /no \.pi\/design-system\.md/);
    assert.match(reply, /tokens/);
});

test("a write puts the file at .pi/design-system.md, and a read gives the text back", async () => {
    const dir = folder();

    assert.match(
        await text(run(dir, { action: "write", content: "# Design system\n\nHello.\n" })),
        /Wrote \.pi\/design-system\.md/,
    );
    assert.equal(readFileSync(join(dir, SYSTEM_FILE), "utf8"), "# Design system\n\nHello.\n");

    const read = await text(run(dir, { action: "read" }));

    assert.match(read, /# Design system/);
    assert.match(read, /Hello\./);
});

test("write needs content, and too much content is refused with the file left alone", async () => {
    const dir = folder();

    await assert.rejects(run(dir, { action: "write" }), /write needs/);
    await assert.rejects(
        run(dir, { action: "write", content: " ".repeat(MAX_BYTES + 1) }),
        /bounded text/,
    );

    assert.throws(() => lstatSync(join(dir, SYSTEM_FILE)), "the refusal left no file");
    assert.deepEqual(
        readdirSync(join(dir, ".pi"), { recursive: true }),
        [],
        "nor any temporary file",
    );
});

test("an empty write is fine, leaves no temporary file, and reads as an empty design system, not absent", async () => {
    const dir = folder();

    await text(run(dir, { action: "write", content: "" }));

    assert.deepEqual(readDesignSystemText(dir), { text: "", truncated: false });
    assert.deepEqual(readdirSync(join(dir, ".pi")), ["design-system.md"], "only the file is there");
});

test("a read past the limit is cut before a character's middle, not after", async () => {
    const dir = folder();

    // One character whose bytes start one short of the limit: the cut lands inside its sequence.
    const across = `${"x".repeat(MAX_BYTES - 1)}😀`;

    writeFileSync(join(dir, SYSTEM_FILE), across, "utf8");

    const cut = readDesignSystemText(dir)!;

    assert.ok(cut.truncated);
    assert.ok(!cut.text.includes("�"));
    assert.ok(cut.text.endsWith("x".repeat(4)), "the cut stepped back to a whole sequence");

    // The exact limit is no truncation.
    const whole = "y".repeat(MAX_BYTES);

    writeFileSync(join(dir, SYSTEM_FILE), whole, "utf8");
    assert.deepEqual(readDesignSystemText(dir), { text: whole, truncated: false });
});

test("boundedText and utf8Cut cut without a replacement character", () => {
    assert.deepEqual(boundedText(Buffer.from("abc"), 5), { text: "abc", truncated: false });
    assert.equal(utf8Cut(Buffer.from("abc"), 2), 2);

    // A two-byte character split in half (é in UTF-8): the cut steps back before it.
    assert.equal(utf8Cut(Buffer.from([0x61, 0xc3, 0xa9, 0x62]), 2), 1);
    assert.deepEqual(boundedText(Buffer.from([0x61, 0xc3, 0xa9, 0x62]), 2), {
        text: "a",
        truncated: true,
    });
    assert.deepEqual(boundedText(Buffer.from([0xc3, 0xa9]), 1), { text: "", truncated: true });
});

test("a read never follows a symlink at the file, and a write replaces the symlink itself", async () => {
    const dir = folder();
    const aside = join(dir, "elsewhere.md");

    writeFileSync(aside, "kept text\n", "utf8");
    symlinkSync(aside, join(dir, SYSTEM_FILE));

    assert.throws(() => readDesignSystemText(dir), /symlink/);
    await assert.rejects(run(dir, { action: "read" }), /symlink/);
    assert.equal(readFileSync(aside, "utf8"), "kept text\n", "the link target keeps its bytes");

    await text(run(dir, { action: "write", content: "# real\n" }));

    assert.ok(
        !lstatSync(join(dir, SYSTEM_FILE)).isSymbolicLink(),
        "the write replaced the symlink",
    );
    assert.equal(readFileSync(aside, "utf8"), "kept text\n", "the write goes past the link");
    assert.equal(readDesignSystemText(dir)!.text, "# real\n");
});
