import assert from "node:assert/strict";
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
