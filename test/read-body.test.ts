// A request body's deadline (`readBody` in `src/server/http/io.ts`): a caller that stops waiting ends it, so no timer
// is left behind to keep the process alive and close the connection a minute later.
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { readBody } from "../src/server/http/io.ts";

/** A body that sends a little and then nothing, as a slow client does. */
function slowBody(): IncomingMessage {
    const body = new PassThrough() as unknown as IncomingMessage;

    body.headers = { "content-length": "100" };
    (body as unknown as PassThrough).write("answer=slow");

    return body;
}

const timers = () => process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;

test("a body that is let go of leaves no deadline behind", async () => {
    const before = timers();
    const stop = new AbortController();
    const read = readBody(slowBody(), 1000, stop.signal);

    read.catch(() => {});
    assert.equal(timers(), before + 1, "the deadline runs while the body is read");

    stop.abort();
    assert.equal(timers(), before, "letting go of the body ends its deadline");
});

test("a whole body ends its deadline too", async () => {
    const before = timers();
    const body = new PassThrough() as unknown as IncomingMessage;

    body.headers = {};

    const read = readBody(body, 1000);

    (body as unknown as PassThrough).end("a=1");
    assert.equal((await read).toString(), "a=1");
    assert.equal(timers(), before);
});
