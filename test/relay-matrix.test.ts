import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import matrix from "../src/server/extensions/pocket-relay/connectors/matrix.ts";

const room = "!fixture:example.invalid";
const roomPath = `/_matrix/client/v3/rooms/${encodeURIComponent(room)}`;
const context = {
    values: { homeserver: "https://example.invalid", replyRoom: room, token: "fixture" },
    signal: new AbortController().signal,
    log() {},
};
const file = { name: "fixture.txt", type: "text/plain", data: Uint8Array.of(65) };
const send = matrix.reply!;
const absent = () => Response.json({ errcode: "M_NOT_FOUND" }, { status: 404 });

function adapter(
    t: TestContext,
    state: () => Response,
    ack = () => Response.json({ event_id: "$fixture" }),
    joined = [room],
) {
    const writes: { method: string; body?: unknown }[] = [];

    t.mock.method(globalThis, "fetch", async (input: string, init: RequestInit) => {
        const path = new URL(input).pathname;

        if (init.method === "GET" && path === "/_matrix/client/v3/joined_rooms") {
            return Response.json({ joined_rooms: joined });
        }

        if (init.method === "GET" && path === `${roomPath}/state/m.room.encryption`) {
            return state();
        }

        if (init.method === "POST" && path === "/_matrix/media/v3/upload") {
            writes.push({ method: "POST" });

            return Response.json({ content_uri: "mxc://example.invalid/fixture" });
        }

        assert.equal(init.method, "PUT");
        assert.ok(path.startsWith(`${roomPath}/send/m.room.message/`));
        writes.push({ method: "PUT", body: JSON.parse(String(init.body)) });

        return ack();
    });

    return writes;
}

for (const [label, answer] of Object.entries({
    encrypted: () => Response.json({ algorithm: "m.megolm.v1.aes-sha2" }),
    redacted: () => Response.json({}),
    unknown: () => Response.json({ errcode: "M_UNRECOGNIZED" }, { status: 404 }),
    malformed: () => new Response("bad", { status: 404 }),
    forbidden: () => Response.json({ errcode: "M_FORBIDDEN" }, { status: 403 }),
    offline: () => {
        throw new Error("fixture");
    },
})) {
    test(`Matrix blocks messages and uploads for ${label} encryption state`, async (t) => {
        const writes = adapter(t, answer);

        for (const text of ["fixture", ""]) {
            await assert.rejects(send(context, { text, files: [file], key: "fixture" }));
        }

        assert.deepEqual(writes, []);
    });
}

test("Matrix stops before sending if the route is disabled while checking the room", async (t) => {
    const controller = new AbortController();
    const writes = adapter(t, () => {
        controller.abort();

        return absent();
    });

    await assert.rejects(
        send(
            { ...context, signal: controller.signal },
            { text: "fixture", files: [file], key: "fixture" },
        ),
    );
    assert.deepEqual(writes, []);
});

test("Matrix refuses stale state from a room the account left", async (t) => {
    const writes = adapter(t, absent, undefined, []);

    await assert.rejects(send(context, { text: "", files: [file], key: "fixture" }), /membership/);
    assert.deepEqual(writes, []);
});

test("Matrix checks the room again between upload and event", async (t) => {
    let count = 0;
    const writes = adapter(t, () => (++count === 1 ? absent() : Response.json({})));

    await assert.rejects(send(context, { text: "", files: [file], key: "fixture" }), /encrypted/);
    assert.deepEqual(writes, [{ method: "POST" }]);
});

test("Matrix confirms the actual room and thread after sending the whole reply", async (t) => {
    const writes = adapter(t, absent);
    const text = "fixture\n".repeat(1500);
    const reply = {
        text,
        key: "fixture",
        channel: "!unused:example.invalid",
        thread: "$unused",
        to: {
            id: "$prior",
            text: "",
            author: { id: "u", name: "u" },
            channel: room,
            thread: "$thread",
        },
        files: [file],
    };

    assert.deepEqual(await send(context, { ...reply, confirmDestination: true }), {
        id: "$fixture",
        channel: room,
        thread: "$thread",
    });
    assert.deepEqual(
        writes.map((write) => write.method),
        ["PUT", "POST", "PUT"],
    );
    assert.equal((writes[0]!.body as { body: string }).body, text);
    assert.deepEqual(await send(context, reply), { id: "$fixture" });
});

test("Matrix does not confirm partial or unacknowledged delivery", async (t) => {
    let count = 0;
    const writes = adapter(t, absent, () =>
        Response.json(++count === 1 ? { event_id: "$text" } : {}),
    );

    assert.deepEqual(
        await send(context, {
            text: "fixture",
            key: "fixture",
            files: [file],
            confirmDestination: true,
        }),
        {},
    );
    assert.equal(writes.length, 3);
});

test("Matrix refuses oversized card text before any send or upload", async (t) => {
    const writes = adapter(t, absent);

    await assert.rejects(
        send(context, {
            text: "😃".repeat(17000),
            files: [file],
            key: "fixture",
            confirmDestination: true,
        }),
        /size limit/,
    );
    assert.deepEqual(writes, []);
});
