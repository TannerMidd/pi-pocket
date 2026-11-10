// Withdrawing session questions over the real runner link.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { it } from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import {
    LINK_PATH,
    LINK_PROTOCOL,
    LINK_SUBPROTOCOL,
    parseControl,
    type ControlMessage,
    type Confirm,
} from "../src/runner/protocol.ts";
import { Runner, type SessionAnswer, type SessionQuestion } from "../src/runner/runner.ts";
import { ConfigStore } from "../src/server/config.ts";
import { Runners } from "../src/server/runners.ts";

async function until(check: () => boolean): Promise<void> {
    const end = Date.now() + 5000;

    while (!check()) {
        assert.ok(Date.now() < end, "the runner link did not answer in time");
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

it("requires runner tools and accepts unknown hello fields", () => {
    const hello = {
        type: "hello",
        protocol: LINK_PROTOCOL,
        session: null,
        received: 0,
        version: "test",
        tools: { git: true, gh: false, github: false },
        extra: true,
    };

    assert.deepEqual(parseControl(JSON.stringify(hello)), hello);
    assert.equal(parseControl(JSON.stringify({ ...hello, tools: undefined })), undefined);
    assert.equal(parseControl(JSON.stringify({ ...hello, tools: { git: true } })), undefined);
});

it("parses a withdrawal without changing the link protocol", () => {
    assert.equal(LINK_PROTOCOL, 1);
    assert.deepEqual(parseControl('{"type":"withdraw","id":"question"}'), {
        type: "withdraw",
        id: "question",
    });
    assert.equal(parseControl('{"type":"withdraw","id":1}'), undefined);
});

it("cancels a server question without dropping the link", async () => {
    const root = mkdtempSync(join(tmpdir(), "pocket-confirm-"));
    const runners = new Runners({ config: new ConfigStore(root), log: () => {} });
    const server = createServer();
    const got: ControlMessage[] = [];
    let ws: WebSocket | undefined;

    server.on("upgrade", (request, socket, head) => runners.upgrade(request, socket, head));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
        const { code } = runners.makeCode("Laptop", "owner");
        const linked = runners.redeem(code);
        const port = (server.address() as AddressInfo).port;

        ws = new WebSocket(`ws://127.0.0.1:${port}${LINK_PATH}`, LINK_SUBPROTOCOL, {
            headers: { authorization: `Bearer ${linked.key}` },
        });
        const peer = ws;

        peer.on("message", (data, binary) => {
            if (!binary) {
                const message = parseControl(data.toString());

                if (message) {
                    got.push(message);
                }
            }
        });
        await new Promise<void>((resolve) => peer.once("open", resolve));
        peer.send(
            JSON.stringify({
                type: "hello",
                protocol: LINK_PROTOCOL,
                session: null,
                received: 0,
                version: "test",
                tools: { git: true, gh: false, github: false },
            }),
        );
        await until(() => runners.list()[0]?.online === true);

        const controller = new AbortController();
        const result = runners.link(linked.id).confirm(
            {
                kind: "new",
                person: "Owner",
                folder: root,
                session: "cancelled",
            },
            controller.signal,
        );
        const rejected = assert.rejects(result, { status: 409, message: "Cancelled." });

        await until(() => got.some((each) => each.type === "confirm"));
        const first = got.find((each): each is Confirm => each.type === "confirm")!;

        controller.abort();
        await rejected;

        // A late Allow cannot restore a removed question. A fresh question still works on the same link.
        peer.send(JSON.stringify({ type: "confirmed", id: first.id, allow: true }));
        const next = runners.link(linked.id).confirm({
            kind: "fork",
            person: "Owner",
            folder: root,
            session: "next",
        });

        await until(() => got.filter((each) => each.type === "confirm").length === 2);
        const second = got.filter((each): each is Confirm => each.type === "confirm")[1]!;

        peer.send(JSON.stringify({ type: "confirmed", id: second.id, allow: true }));
        await next;
        assert.deepEqual(
            got.filter((each) => each.type === "withdraw"),
            [{ type: "withdraw", id: first.id }],
        );
        assert.equal(peer.readyState, WebSocket.OPEN);
        assert.equal(runners.list()[0]?.online, true);
        await assert.rejects(
            runners.link(linked.id).confirm(
                {
                    kind: "new",
                    person: "Owner",
                    folder: root,
                    session: "aborted",
                },
                AbortSignal.abort(),
            ),
            { status: 409, message: "Cancelled." },
        );
    } finally {
        ws?.terminate();
        runners.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        rmSync(root, { recursive: true, force: true });
    }
});

it("withdraw aborts the runner's ask, logs cancellation, and sends no confirmed even after a late Allow", async () => {
    const server = createServer();
    const sockets = new WebSocketServer({ server });
    const got: ControlMessage[] = [];
    const lines: string[] = [];
    const asked: SessionQuestion[] = [];
    let peer: WebSocket | undefined;
    let late: ((answer: SessionAnswer) => void) | undefined;
    let runner: Runner | undefined;

    sockets.on("connection", (ws) => {
        peer = ws;
        ws.on("message", (data, binary) => {
            if (binary) {
                return;
            }

            const message = parseControl(data.toString());

            if (message) {
                got.push(message);
            }

            if (message?.type === "hello") {
                ws.send(
                    JSON.stringify({
                        type: "welcome",
                        session: "test",
                        resume: false,
                        received: 0,
                    }),
                );
            }
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
        const port = (server.address() as AddressInfo).port;

        runner = new Runner({
            link: { server: `http://127.0.0.1:${port}`, id: "test", name: "Laptop", key: "test" },
            version: "test",
            log: (line) => lines.push(line),
            ask: (question) => {
                asked.push(question);

                return asked.length === 1
                    ? new Promise((resolve) => {
                          late = resolve;
                      })
                    : Promise.resolve({ allow: true });
            },
        });
        runner.start();
        await until(() => runner!.connected);
        assert.ok(got.some((each) => each.type === "hello"));
        peer!.send(
            JSON.stringify({
                type: "confirm",
                id: "cancelled",
                session: "cancelled",
                kind: "fork",
                person: "Owner",
                folder: "/project",
            }),
        );
        await until(() => asked.length === 1);
        peer!.send(JSON.stringify({ type: "withdraw", id: "cancelled" }));
        await until(() => asked[0]!.signal.aborted);
        assert.equal(asked[0]!.signal.reason, "Withdrawn by the server.");
        late!({ allow: true });
        peer!.send(
            JSON.stringify({
                type: "confirm",
                id: "allowed",
                session: "allowed",
                kind: "new",
                person: "Owner",
                folder: "/project",
            }),
        );
        await until(() => got.some((each) => each.type === "confirmed" && each.id === "allowed"));
        assert.ok(!got.some((each) => each.type === "confirmed" && each.id === "cancelled"));
        assert.equal(
            lines.filter((line) => line === "Owner cancelled a copy of a session in /project.")
                .length,
            1,
        );
        assert.ok(!lines.some((line) => line.startsWith("Denied")));
        assert.equal(peer!.readyState, WebSocket.OPEN);
    } finally {
        await runner?.stop();
        sockets.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});
