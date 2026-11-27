import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { test } from "node:test";
import { Hostfs } from "../src/server/hostfs.ts";
import { serveImage } from "../src/server/http/assets.ts";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

/** A response that records what is sent. */
function recorder() {
    const chunks: Buffer[] = [];
    const head: { status?: number; headers?: Record<string, unknown> } = {};
    const out = new Writable({
        write(chunk, _encoding, done) {
            chunks.push(Buffer.from(chunk));
            done();
        },
    }) as unknown as ServerResponse;

    (out as unknown as { writeHead: unknown }).writeHead = (
        status: number,
        headers: Record<string, unknown>,
    ) => {
        head.status = status;
        head.headers = headers;

        return out;
    };

    const finished = new Promise<void>((resolve) => out.on("finish", resolve).on("close", resolve));

    return { out, head, finished, sent: () => Buffer.concat(chunks).length };
}

test("an image is streamed from the descriptor that was checked, and no more than the size it declared", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "pocket-serve-image-"));
    const file = join(dir, "a.png");

    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(file, PNG);

    // The file grows after its size was read: reading the request headers is the first thing after it.
    const request = {
        get headers() {
            appendFileSync(file, Buffer.alloc(2 * 1024 * 1024, 1));

            return {};
        },
    } as unknown as IncomingMessage;
    const { out, head, finished, sent } = recorder();

    await serveImage(request, out, new Hostfs().at(file));
    await finished;
    assert.equal(head.status, 200);
    assert.equal(head.headers?.["content-length"], String(PNG.length));
    assert.equal(sent(), PNG.length, "not a byte past the declared size");
});

test("a pipe named like an image in a plain folder is refused, and does not hold the server", (t) => {
    const dir = mkdtempSync(join(tmpdir(), "pocket-serve-image-"));

    t.after(() => rmSync(dir, { recursive: true, force: true }));
    execFileSync("mkfifo", [join(dir, "image.png")]);

    // In a process of its own: a call that waits for a writer would hold the test too.
    const hostfs = new URL("../src/server/hostfs.ts", import.meta.url).href;
    const assets = new URL("../src/server/http/assets.ts", import.meta.url).href;
    const script = `import { Hostfs } from ${JSON.stringify(hostfs)};
import { serveImage } from ${JSON.stringify(assets)};
try { await serveImage({ headers: {} }, {}, new Hostfs().at(${JSON.stringify(join(dir, "image.png"))})); console.log("served"); }
catch (error) { console.log(error.status); }`;
    const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
        timeout: 15_000,
        encoding: "utf8",
    });

    assert.equal(run.error, undefined, "it did not wait for a writer");
    assert.equal(run.stdout.trim(), "404");
});
