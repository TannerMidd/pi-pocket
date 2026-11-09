// Runner network stream flow control (`src/runner/tunnels.ts`) with half-open in-memory sockets.
import assert from "node:assert/strict";
import { once } from "node:events";
import { Duplex } from "node:stream";
import { describe, it, type TestContext } from "node:test";
import { type NetMessage, readStreamData } from "../src/runner/protocol.ts";
import { MAX_STREAMS, StreamLink, WINDOW } from "../src/runner/tunnels.ts";

/** Reading and writing are independent; a held write models a socket that has not consumed bytes. */
class Socket extends Duplex {
    readonly writes: Buffer[] = [];
    readonly pending: (() => void)[] = [];
    readonly #hold: boolean;

    constructor(hold = false) {
        super({ allowHalfOpen: true });
        this.#hold = hold;
    }

    _read(): void {}

    _write(bytes: Buffer, _encoding: BufferEncoding, done: () => void): void {
        this.writes.push(Buffer.from(bytes));

        if (this.#hold) {
            this.pending.push(done);
        } else {
            done();
        }
    }
}

function fixture(t: TestContext, accept = true) {
    const sent: Buffer[] = [];
    const controls: NetMessage[] = [];
    const closed: { id: number; error: string | undefined }[] = [];
    const link = new StreamLink({
        send(message, done) {
            sent.push(message);

            if (accept) {
                done();
            }

            return accept;
        },
        control: (message) => controls.push(message),
        closed: (id, error) => closed.push({ id, error }),
    });

    t.after(() => link.dropAll());

    return { link, sent, controls, closed };
}

describe("runner StreamLink", () => {
    it("resets only the stream that sends past its receive window", (t) => {
        const { link, controls, closed } = fixture(t);
        const slow = new Socket(true);
        const other = new Socket();

        link.attach(1, slow);
        link.attach(2, other);
        link.data(1, Buffer.alloc(WINDOW));
        assert.equal(link.has(1), true, "exactly WINDOW bytes are allowed");
        assert.equal(slow.pending.length, 1);
        assert.deepEqual(controls, [], "a pending write has not earned credit");
        link.data(1, Buffer.from([1]));
        assert.equal(link.has(1), false);
        assert.equal(slow.destroyed, true);
        assert.equal(link.has(2), true);
        assert.equal(other.destroyed, false);
        assert.equal(link.size, 1);
        assert.deepEqual(controls, [
            { type: "net-reset", id: 1, message: "Stream data out of order" },
        ]);
        assert.deepEqual(closed, [{ id: 1, error: "Stream data out of order" }]);
        link.data(2, Buffer.from("still live"));
        assert.deepEqual(other.writes, [Buffer.from("still live")]);
    });

    it("returns receive credit only when the socket consumes the bytes", (t) => {
        const { link, controls } = fixture(t);
        const socket = new Socket(true);

        link.attach(1, socket);
        link.data(1, Buffer.alloc(WINDOW));
        assert.deepEqual(controls, []);
        socket.pending.shift()!();
        assert.deepEqual(controls, [{ type: "net-credit", id: 1, bytes: WINDOW }]);
        link.data(1, Buffer.from([1]));
        assert.equal(link.has(1), true, "consumed bytes no longer count against the window");
    });

    it("resets only the stream whose credit grows above WINDOW", (t) => {
        const { link, controls, closed } = fixture(t);
        const socket = new Socket();
        const other = new Socket();

        link.attach(1, socket);
        link.attach(2, other);
        link.message({ type: "net-credit", id: 1, bytes: 1 });
        assert.equal(socket.destroyed, true);
        assert.equal(other.destroyed, false);
        assert.equal(link.has(1), false);
        assert.equal(link.has(2), true);
        assert.deepEqual(controls, [{ type: "net-reset", id: 1, message: "Too much credit" }]);
        assert.deepEqual(closed, [{ id: 1, error: "Too much credit" }]);
    });

    it("holds outgoing bytes at WINDOW and resumes with exactly the returned credit", (t) => {
        const { link, sent, controls } = fixture(t);
        const socket = new Socket();
        const bytes = Buffer.alloc(WINDOW + 3, 7);

        link.attach(1, socket, [bytes]);
        const before = sent.map((message) => readStreamData(message)!);

        assert.ok(before.every((message) => message.id === 1));
        assert.deepEqual(
            Buffer.concat(before.map((message) => message.bytes)),
            bytes.subarray(0, WINDOW),
        );
        assert.deepEqual(controls, []);
        sent.length = 0;
        link.message({ type: "net-credit", id: 1, bytes: 3 });
        assert.deepEqual(sent.map(readStreamData), [{ id: 1, bytes: bytes.subarray(WINDOW) }]);
        assert.equal(link.has(1), true);
        assert.deepEqual(controls, []);
    });

    it("drops every stream when send reports the link is down", (t) => {
        const { link, sent, controls, closed } = fixture(t, false);
        const first = new Socket();
        const second = new Socket();

        link.attach(1, first);
        link.attach(2, second, [Buffer.from("cannot send")]);
        assert.equal(sent.length, 1);
        assert.equal(link.size, 0);
        assert.equal(first.destroyed, true);
        assert.equal(second.destroyed, true);
        assert.deepEqual(closed, [
            { id: 1, error: "The link dropped" },
            { id: 2, error: "The link dropped" },
        ]);
        assert.deepEqual(controls, [], "a dead link gets no reset messages");
    });

    it("allows the peer to keep writing after the local reading half ends", async (t) => {
        const { link, sent, controls, closed } = fixture(t);
        const socket = new Socket();

        link.attach(1, socket);
        const ended = once(socket, "end");

        socket.push(Buffer.from("last bytes"));
        socket.push(null);
        await ended;
        assert.deepEqual(sent.map(readStreamData), [{ id: 1, bytes: Buffer.from("last bytes") }]);
        assert.deepEqual(controls, [{ type: "net-end", id: 1 }]);
        assert.equal(link.has(1), true);
        assert.equal(socket.writableEnded, false);
        link.data(1, Buffer.from("response"));
        assert.deepEqual(socket.writes, [Buffer.from("response")]);
        const gone = once(socket, "close");

        link.message({ type: "net-end", id: 1 });
        await gone;
        assert.equal(link.size, 0);
        assert.deepEqual(closed, [{ id: 1, error: undefined }]);
        assert.deepEqual(controls, [{ type: "net-end", id: 1 }]);
    });

    it("allows local bytes after the peer ends its writing half", async (t) => {
        const { link, sent, controls } = fixture(t);
        const socket = new Socket();

        link.attach(1, socket);
        const finished = once(socket, "finish");

        link.message({ type: "net-end", id: 1 });
        await finished;
        assert.equal(link.has(1), true);
        assert.equal(socket.readableEnded, false);
        const gone = once(socket, "close");

        socket.push(Buffer.from("last response"));
        socket.push(null);
        await gone;
        assert.deepEqual(sent.map(readStreamData), [
            { id: 1, bytes: Buffer.from("last response") },
        ]);
        assert.deepEqual(controls, [{ type: "net-end", id: 1 }]);
        assert.equal(link.size, 0);
    });

    it("resets data received after the peer's half-close", (t) => {
        const { link, controls } = fixture(t);
        const socket = new Socket();

        link.attach(1, socket);
        link.message({ type: "net-end", id: 1 });
        link.data(1, Buffer.from("too late"));
        assert.equal(link.has(1), false);
        assert.equal(socket.destroyed, true);
        assert.deepEqual(controls, [
            { type: "net-reset", id: 1, message: "Stream data out of order" },
        ]);
    });

    it("accepts a peer reset without echoing it and ignores unknown stream ids", (t) => {
        const { link, controls, closed } = fixture(t);
        const socket = new Socket();

        link.attach(1, socket);
        link.message({ type: "net-reset", id: 1, message: "peer closed" });
        link.data(1, Buffer.from("late"));
        link.message({ type: "net-credit", id: 999, bytes: WINDOW });
        link.reset(999);
        assert.equal(link.size, 0);
        assert.equal(socket.destroyed, true);
        assert.deepEqual(closed, [{ id: 1, error: "peer closed" }]);
        assert.deepEqual(controls, []);
    });

    it("keeps MAX_STREAMS independent and drops them all without resets", (t) => {
        const { link, controls, closed } = fixture(t);
        const sockets: Socket[] = [];

        // The callers enforce the admission limit. StreamLink must support every admitted stream.
        for (let id = 0; id < MAX_STREAMS; id++) {
            const socket = new Socket();

            sockets.push(socket);
            link.attach(id, socket);
        }

        assert.equal(link.size, MAX_STREAMS);

        for (let id = 0; id < MAX_STREAMS; id++) {
            assert.equal(link.has(id), true);
            link.data(id, Buffer.from([id % 256]));
            assert.deepEqual(sockets[id]!.writes, [Buffer.from([id % 256])]);
        }

        link.dropAll();
        assert.equal(link.size, 0);
        assert.ok(sockets.every((socket) => socket.destroyed));
        assert.equal(closed.length, MAX_STREAMS);
        assert.ok(closed.every((entry) => entry.error === "The link dropped"));
        assert.deepEqual(controls, []);
        link.dropAll();
        assert.equal(closed.length, MAX_STREAMS, "dropping twice does not close twice");
    });
});
