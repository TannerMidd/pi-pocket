// Runner framing and reconnect byte accounting (`src/runner/protocol.ts`), without a WebSocket.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
    dataMessage,
    FRAME,
    frame,
    FrameSplitter,
    Inbox,
    MAX_FRAME,
    Outbox,
    readData,
    readFrame,
} from "../src/runner/protocol.ts";

describe("runner frames", () => {
    it("round-trips a frame's type, id, JSON, and binary payload", () => {
        const json = { op: "write", path: "/project/🐈", count: 2 };
        const payload = Uint8Array.of(0, 255, 1, 128);
        const whole = frame(FRAME.request, 0xffffffff, json, payload);

        assert.equal(whole.readUInt32BE(0), whole.length - 4);
        assert.deepEqual(readFrame(whole), {
            type: FRAME.request,
            id: 0xffffffff,
            json,
            payload,
        });
    });

    it("round-trips a frame without a payload and replaces lone surrogates", () => {
        assert.deepEqual(readFrame(frame(FRAME.result, 7, { text: "a\ud800b" })), {
            type: FRAME.result,
            id: 7,
            json: { text: "a�b" },
            payload: new Uint8Array(),
        });
    });

    it("rejects a JSON length beyond the frame body", () => {
        const whole = frame(FRAME.result, 1, {});

        whole.writeUInt32BE(whole.length, 9);
        assert.throws(() => readFrame(whole), {
            message: "Corrupt pi-env frame (JSON length out of range)",
        });
    });

    for (const value of [null, [], "not an object"]) {
        it(`rejects JSON that is ${JSON.stringify(value)}`, () => {
            const body = Buffer.from(JSON.stringify(value));
            const whole = Buffer.alloc(13 + body.length);

            whole.writeUInt32BE(whole.length - 4, 0);
            whole.writeUInt8(FRAME.result, 4);
            whole.writeUInt32BE(body.length, 9);
            body.copy(whole, 13);
            assert.throws(() => readFrame(whole), {
                message: "Corrupt pi-env frame (JSON is not an object)",
            });
        });
    }
});

describe("runner FrameSplitter", () => {
    const whole = frame(FRAME.request, 17, { op: "hello" }, Uint8Array.of(1, 2, 3));

    for (const split of [1, 2, 3, 4, 9, whole.length - 1]) {
        it(`reassembles two chunks split at byte ${split}`, () => {
            const splitter = new FrameSplitter();

            assert.equal(splitter.partial, false);
            assert.deepEqual(splitter.push(whole.subarray(0, split)), []);
            assert.equal(splitter.partial, true);
            assert.deepEqual(splitter.push(whole.subarray(split)), [whole]);
            assert.equal(splitter.partial, false);
        });
    }

    it("reassembles three chunks with the length header split twice", () => {
        const splitter = new FrameSplitter();

        assert.deepEqual(splitter.push(whole.subarray(0, 1)), []);
        assert.deepEqual(splitter.push(whole.subarray(1, 3)), []);
        assert.equal(splitter.partial, true);
        assert.deepEqual(splitter.push(whole.subarray(3)), [whole]);
        assert.equal(splitter.partial, false);
    });

    it("returns several frames from one chunk in order", () => {
        const splitter = new FrameSplitter();
        const second = frame(FRAME.result, 18, { ok: true });
        const third = frame(FRAME.error, 19, { code: "ENOENT" });

        assert.deepEqual(splitter.push(Buffer.concat([whole, second, third])), [
            whole,
            second,
            third,
        ]);
        assert.equal(splitter.partial, false);
    });

    it("retains a partial next frame and ignores empty chunks", () => {
        const splitter = new FrameSplitter();
        const next = frame(FRAME.result, 20, {});

        assert.deepEqual(splitter.push(Buffer.alloc(0)), []);
        assert.equal(splitter.partial, false);
        assert.deepEqual(splitter.push(Buffer.concat([whole, next.subarray(0, 2)])), [whole]);
        assert.equal(splitter.partial, true);
        assert.deepEqual(splitter.push(Buffer.alloc(0)), []);
        assert.equal(splitter.partial, true);
        assert.deepEqual(splitter.push(next.subarray(2)), [next]);
        assert.equal(splitter.partial, false);
    });

    for (const length of [0, 8, MAX_FRAME + 1]) {
        it(`rejects a length of ${length} as soon as the header is complete`, () => {
            const splitter = new FrameSplitter();
            const header = Buffer.alloc(4);

            header.writeUInt32BE(length);
            assert.deepEqual(splitter.push(header.subarray(0, 2)), []);
            assert.throws(() => splitter.push(header.subarray(2)), {
                message: `Corrupt pi-env frame (length ${length})`,
            });
        });
    }

    it("accepts the largest allowed length header while waiting for its body", () => {
        const splitter = new FrameSplitter();
        const header = Buffer.alloc(4);

        header.writeUInt32BE(MAX_FRAME);
        assert.deepEqual(splitter.push(header), []);
        assert.equal(splitter.partial, true);
    });
});

describe("runner binary data messages", () => {
    it("round-trips offsets including those above 32 bits and arbitrary bytes", () => {
        const bytes = Buffer.from([0, 255, 128, 1]);

        for (const offset of [0, 2 ** 32 + 7, Number.MAX_SAFE_INTEGER]) {
            const message = dataMessage(offset, bytes);

            assert.equal(message.length, 8 + bytes.length);
            assert.equal(message.readBigUInt64BE(0), BigInt(offset));
            assert.deepEqual(readData(message), { offset, bytes });
        }
    });

    it("accepts empty data but rejects a truncated header and an unsafe offset", () => {
        const unsafe = Buffer.alloc(8);

        unsafe.writeBigUInt64BE(BigInt(Number.MAX_SAFE_INTEGER) + 1n);
        assert.deepEqual(readData(dataMessage(0, new Uint8Array())), {
            offset: 0,
            bytes: Buffer.alloc(0),
        });
        assert.equal(readData(Buffer.alloc(7)), undefined);
        assert.equal(readData(unsafe), undefined);
    });
});

describe("runner Inbox", () => {
    it("refuses a gap without advancing its counters", () => {
        const inbox = new Inbox();

        assert.equal(inbox.take(dataMessage(1, Buffer.from("later"))), undefined);
        assert.equal(inbox.received, 0);
        assert.equal(inbox.unacknowledged, 0);
        assert.deepEqual(inbox.take(dataMessage(0, Buffer.from("abc"))), Buffer.from("abc"));
        assert.equal(inbox.take(dataMessage(4, Buffer.from("gap"))), undefined);
        assert.equal(inbox.received, 3);
        assert.equal(inbox.unacknowledged, 3);
    });

    it("returns only the fresh bytes of an overlap and drops complete duplicates", () => {
        const inbox = new Inbox();

        inbox.take(dataMessage(0, Buffer.from("abcde")));
        assert.deepEqual(inbox.take(dataMessage(3, Buffer.from("defgh"))), Buffer.from("fgh"));
        assert.deepEqual(inbox.take(dataMessage(0, Buffer.from("abc"))), Buffer.alloc(0));
        assert.deepEqual(inbox.take(dataMessage(8, Buffer.from("i"))), Buffer.from("i"));
        assert.equal(inbox.received, 9);
        assert.equal(inbox.unacknowledged, 9);
        inbox.acknowledged();
        assert.equal(inbox.received, 9);
        assert.equal(inbox.unacknowledged, 0);
        inbox.take(dataMessage(9, Buffer.from("j")));
        assert.equal(inbox.unacknowledged, 1);
    });

    it("ignores malformed data without changing its counters", () => {
        const inbox = new Inbox();

        assert.equal(inbox.take(Buffer.alloc(7)), undefined);
        assert.equal(inbox.received, 0);
        assert.equal(inbox.unacknowledged, 0);
    });
});

describe("runner Outbox", () => {
    it("numbers writes and keeps its own copy of the bytes", () => {
        const outbox = new Outbox();
        const bytes = Buffer.from("abc");
        const first = outbox.write(bytes);
        const second = outbox.write(Buffer.from("de"));

        bytes.fill(0);
        assert.deepEqual(readData(first), { offset: 0, bytes: Buffer.from("abc") });
        assert.deepEqual(readData(second), { offset: 3, bytes: Buffer.from("de") });
        assert.equal(outbox.end, 5);
        assert.equal(outbox.unacknowledged, 5);
        assert.deepEqual(outbox.resend(0)?.map(readData), [
            { offset: 0, bytes: Buffer.from("abc") },
            { offset: 3, bytes: Buffer.from("de") },
        ]);
    });

    it("rejects an acknowledgement past the end without losing bytes", () => {
        const outbox = new Outbox();

        outbox.write(Buffer.from("abc"));
        assert.equal(outbox.acknowledge(4), false);
        assert.equal(outbox.end, 3);
        assert.equal(outbox.unacknowledged, 3);
        assert.equal(outbox.resend(4), undefined);
        assert.deepEqual(outbox.resend(0)?.map(readData), [
            { offset: 0, bytes: Buffer.from("abc") },
        ]);
    });

    it("slices a resend inside a chunk and preserves subsequent chunks", () => {
        const outbox = new Outbox();

        outbox.write(Buffer.from("abcde"));
        outbox.write(Buffer.from("fgh"));
        assert.deepEqual(outbox.resend(2)?.map(readData), [
            { offset: 2, bytes: Buffer.from("cde") },
            { offset: 5, bytes: Buffer.from("fgh") },
        ]);
        assert.equal(outbox.unacknowledged, 6);
        assert.equal(outbox.acknowledge(1), true);
        assert.equal(outbox.unacknowledged, 6);
        assert.equal(outbox.resend(1), undefined);
    });

    it("cannot resend discarded chunks and returns nothing at the end", () => {
        const outbox = new Outbox();

        outbox.write(Buffer.from("abc"));
        outbox.write(Buffer.from("de"));
        assert.equal(outbox.acknowledge(3), true);
        assert.equal(outbox.resend(2), undefined);
        assert.deepEqual(outbox.resend(3)?.map(readData), [
            { offset: 3, bytes: Buffer.from("de") },
        ]);
        assert.deepEqual(outbox.resend(outbox.end), []);
        assert.equal(outbox.unacknowledged, 0);
        assert.equal(outbox.resend(3), undefined);
    });
});
