// The runner link's own security (`secure-link.ts`): each attack a server in the middle could try, and that it fails.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { WebSocket as Raw, WebSocketServer } from "ws";
import {
    CLOSE,
    LINK_PATH,
    LINK_PROTOCOL,
    LINK_SUBPROTOCOL,
    parseControl,
} from "../src/runner/protocol.ts";
import { Runner, RunnerStopped } from "../src/runner/runner.ts";
import {
    checkLinkAnswer,
    checkLinkRequest,
    CLOSE_IDENTITY,
    codeHash,
    fingerprint,
    linkAnswerProof,
    linkInProcess,
    linkRequest,
    linkWithCode,
    newIdentity,
    openLink,
    publicOf,
    RunnerLinkSocket,
    ServerLinkSocket,
} from "../src/runner/secure-link.ts";
import { ConfigStore } from "../src/server/config.ts";
import { Runners } from "../src/server/runners.ts";

const root = mkdtempSync(join(tmpdir(), "pocket-secure-link-"));

after(() => rmSync(root, { recursive: true, force: true }));

async function until(check: () => boolean, what: string): Promise<void> {
    const end = Date.now() + 5000;

    while (!check()) {
        assert.ok(Date.now() < end, `timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

/** Whether `runner` stopped for good, and why. */
function watch(runner: Runner): { stopped: Error | undefined } {
    const state: { stopped: Error | undefined } = { stopped: undefined };

    runner.finished.catch((error: Error) => (state.stopped = error));

    return state;
}

/** A real server's runner side: its `Runners`, on HTTP, with the link path and the link code route. */
async function serve(): Promise<{
    runners: Runners;
    config: ConfigStore;
    server: Server;
    address: string;
    close: () => Promise<void>;
}> {
    const config = new ConfigStore(mkdtempSync(join(root, "data-")));
    const runners = new Runners({ config, log: () => {} });
    const server = createServer((request, response) => {
        let body = "";

        request.on("data", (chunk: Buffer) => (body += chunk.toString()));
        request.on("end", () => {
            try {
                const answer = runners.redeem(JSON.parse(body) as never);

                response.writeHead(200, { "content-type": "application/json" });
                response.end(JSON.stringify(answer));
            } catch (error) {
                response.writeHead(403, { "content-type": "application/json" });
                response.end(JSON.stringify({ error: (error as Error).message }));
            }
        });
    });

    server.on("upgrade", (request, socket, head) => {
        if (!runners.upgrade(request, socket, head)) {
            socket.destroy();
        }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    return {
        runners,
        config,
        server,
        address: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        close: async () => {
            runners.close();
            server.closeAllConnections();
            await new Promise((resolve) => server.close(resolve));
        },
    };
}

describe("linking with a code", () => {
    it("never sends the code, and both sides prove they know it", () => {
        const code = "ABCD-EFGH-JKMN";
        const runner = newIdentity();
        const request = linkRequest(code, runner.publicKey);

        assert.ok(!JSON.stringify(request).includes("ABCD"), "the code is not in the request");
        // Typed in lower case, it is the same code.
        assert.equal(checkLinkRequest(codeHash("abcd-efgh-jkmn"), request), true);
        assert.equal(checkLinkRequest(codeHash("ABCD-EFGH-JKMP"), request), false);

        const answer = { id: "id", name: "Laptop", serverKey: newIdentity().publicKey };
        const proof = linkAnswerProof(codeHash(code), runner.publicKey, answer);

        assert.equal(checkLinkAnswer(code, runner.publicKey, { ...answer, proof }), true);
    });

    it("a server in the middle at link time can swap neither key", async () => {
        const setup = await serve();
        const { code } = setup.runners.makeCode("Laptop", "owner");
        const runner = newIdentity();
        const request = linkRequest(code, runner.publicKey);

        try {
            // Its own key in place of the runner's: the proof was made over the runner's key, so the code does not count.
            assert.throws(
                () => setup.runners.redeem({ ...request, runnerKey: newIdentity().publicKey }),
                /wrong, already used, or expired/,
            );

            // The real answer, with the server's key swapped for its own: the runner sees the proof does not hold.
            const second = setup.runners.makeCode("Desktop", "owner").code;
            const real = setup.runners.redeem(linkRequest(second, runner.publicKey));

            assert.equal(checkLinkAnswer(second, runner.publicKey, real), true);
            assert.equal(
                checkLinkAnswer(second, runner.publicKey, {
                    ...real,
                    serverKey: newIdentity().publicKey,
                }),
                false,
            );
        } finally {
            await setup.close();
        }
    });

    it("refuses an answer from a server that does not know the code, and saves nothing", async () => {
        // A fake server that answers with its own key, without the code.
        const fake = createServer((_request, response) => {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(
                JSON.stringify({
                    id: "id",
                    name: "Laptop",
                    serverKey: newIdentity().publicKey,
                    proof: "made-up",
                }),
            );
        });

        await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));

        try {
            const port = (fake.address() as AddressInfo).port;

            await assert.rejects(
                linkWithCode(`http://127.0.0.1:${port}/runner/link`, "ABCD-EFGH-JKMN"),
                (error: Error & { kind?: string }) => error.kind === "unproven",
            );
        } finally {
            await new Promise((resolve) => fake.close(resolve));
        }
    });

    it("links over HTTP, keeps only the runner's public key, and shows both fingerprints", async () => {
        const setup = await serve();

        try {
            const made = setup.runners.makeCode("Laptop", "owner");
            const linked = await linkWithCode(`${setup.address}/runner/link`, made.code);
            const stored = setup.config.runnerById(linked.id)!;

            assert.equal(stored.publicKey, publicOf(linked.key));
            assert.ok(!JSON.stringify(setup.config.runners).includes(linked.key));
            assert.equal(linked.serverKey, setup.config.serverIdentity.publicKey);
            // The Runners sheet shows the server's fingerprint where the code is made, as the runner shows it.
            assert.equal(made.fingerprint, fingerprint(linked.serverKey));
            assert.match(made.fingerprint, /^SHA256:[A-Za-z0-9+/]{43}$/);
            assert.equal(setup.runners.list()[0]?.fingerprint, fingerprint(stored.publicKey!));
        } finally {
            await setup.close();
        }
    });
});

describe("each connection", () => {
    it("a runner with the pinned key connects, and every message is sealed", async () => {
        const setup = await serve();
        const linked = linkInProcess(
            (request) => setup.runners.redeem(request),
            setup.runners.makeCode("Laptop", "owner").code,
        );
        // A tap on the wire: the WebSocket under the link, as someone in the middle sees it.
        const raw = new Raw(`${setup.address.replace("http", "ws")}${LINK_PATH}`, LINK_SUBPROTOCOL);
        const seen: string[] = [];

        raw.on("message", (data) => seen.push(String(data)));

        const link = new RunnerLinkSocket(raw, linked);

        try {
            await new Promise((resolve) => link.once("open", resolve));
            link.send(
                JSON.stringify({
                    type: "hello",
                    protocol: LINK_PROTOCOL,
                    session: null,
                    received: 0,
                    version: "secret-version-text",
                    tools: { git: true, gh: false, github: false },
                }),
            );
            await until(() => setup.runners.list()[0]?.online === true, "the runner online");
            // After the handshake, nothing readable: the welcome is sealed.
            assert.ok(seen.length >= 2);
            assert.ok(seen.slice(1).every((each) => !each.includes("welcome")));
        } finally {
            link.close();
            await setup.close();
        }
    });

    it("sends nothing to a server that cannot prove the pinned key, and keeps trying", async () => {
        const setup = await serve();
        const linked = linkInProcess(
            (request) => setup.runners.redeem(request),
            setup.runners.makeCode("Laptop", "owner").code,
        );
        // A server in the middle with a valid certificate but its own key, which knows the runner's public key.
        const fake = createServer();
        const sockets = new WebSocketServer({ server: fake });
        const lines: string[] = [];
        // How many messages each connection got from the runner.
        const got: number[] = [];
        const links: ServerLinkSocket[] = [];

        sockets.on("connection", (ws) => {
            const at = got.push(0) - 1;

            ws.on("message", () => got[at]!++);
            links.push(
                new ServerLinkSocket(ws, {
                    identity: newIdentity(),
                    runnerKey: () => setup.config.runnerById(linked.id)!.publicKey,
                    unknown: CLOSE.removed,
                }),
            );
        });
        await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));

        const runner = new Runner({
            link: {
                server: `http://127.0.0.1:${(fake.address() as AddressInfo).port}`,
                ...linked,
            },
            version: "test",
            cwd: root,
            retryMs: [50],
            log: (line) => lines.push(line),
        });
        const state = watch(runner);

        try {
            runner.start();
            await until(() => got.length >= 3, "the runner to try again");
            // Anything at this address can fail to prove the key: that stops no runner (it would be a way to stop
            // every runner of a server). It says so once, and tries again.
            assert.equal(state.stopped, undefined, "what proved nothing does not stop the runner");
            assert.equal(
                lines.filter((line) => /did not prove it is the server/.test(line)).length,
                1,
            );
            // The first handshake message alone: no proof of its own key, no hello.
            assert.deepEqual(got.slice(0, 2), [1, 1]);
        } finally {
            await runner.stop().catch(() => {});
            sockets.close();
            fake.closeAllConnections();
            await new Promise((resolve) => fake.close(resolve));
            await setup.close();
        }
    });

    it("refuses a runner that cannot prove its key, and one whose computer was removed", async () => {
        const setup = await serve();
        const linked = linkInProcess(
            (request) => setup.runners.redeem(request),
            setup.runners.makeCode("Laptop", "owner").code,
        );
        const url = `${setup.address.replace("http", "ws")}${LINK_PATH}`;

        try {
            // Its id and the server's key, but another private key.
            await assert.rejects(
                openLink(url, LINK_SUBPROTOCOL, { ...linked, key: newIdentity().privateKey }),
                new RegExp(`Closed ${CLOSE_IDENTITY}`),
            );
            // Someone else's id.
            await assert.rejects(
                openLink(url, LINK_SUBPROTOCOL, { ...linked, id: "not-a-computer" }),
                new RegExp(`Closed ${CLOSE.removed}`),
            );
            setup.runners.remove(linked.id);
            await assert.rejects(
                openLink(url, LINK_SUBPROTOCOL, linked),
                new RegExp(`Closed ${CLOSE.removed}`),
            );
        } finally {
            await setup.close();
        }
    });

    it("drops the link when a message is changed, replayed, or not sealed", async () => {
        const setup = await serve();
        const linked = linkInProcess(
            (request) => setup.runners.redeem(request),
            setup.runners.makeCode("Laptop", "owner").code,
        );
        const url = `${setup.address.replace("http", "ws")}${LINK_PATH}`;
        const hello = JSON.stringify({
            type: "hello",
            protocol: LINK_PROTOCOL,
            session: null,
            received: 0,
            version: "test",
            tools: { git: true, gh: false, github: false },
        });

        try {
            for (const attack of ["change", "replay", "plain"] as const) {
                const raw = new Raw(url, LINK_SUBPROTOCOL);
                const sent: Buffer[] = [];
                const send = raw.send.bind(raw);

                // Keep a copy of each sealed message the runner sends.
                raw.send = ((data: Buffer, ...rest: never[]) => {
                    sent.push(Buffer.from(data));

                    return send(data, ...rest);
                }) as typeof raw.send;

                const link = new RunnerLinkSocket(raw, linked);
                const closed = new Promise<number>((resolve) =>
                    raw.once("close", (code) => resolve(code)),
                );

                await new Promise((resolve) => link.once("open", resolve));
                link.send(hello);
                await until(() => setup.runners.list()[0]?.online === true, "online");

                const last = sent.at(-1)!;

                if (attack === "change") {
                    const changed = Buffer.from(last);

                    changed[3] = changed[3]! ^ 1;
                    send(changed, { binary: true });
                } else if (attack === "replay") {
                    send(last, { binary: true });
                } else {
                    send(hello);
                }

                assert.equal(await closed, 1002, `a ${attack}d message ends the link`);
                await until(() => setup.runners.list()[0]?.online === false, "offline");
            }
        } finally {
            await setup.close();
        }
    });

    it("linking a computer again keeps its id and ends the old key's connection", async () => {
        const setup = await serve();
        const first = linkInProcess(
            (request) => setup.runners.redeem(request),
            setup.runners.makeCode("Laptop", "owner").code,
        );
        const url = `${setup.address.replace("http", "ws")}${LINK_PATH}`;
        const old = await openLink(url, LINK_SUBPROTOCOL, first);
        const ended = new Promise((resolve) => old.once("close", resolve));

        try {
            old.send(
                JSON.stringify({
                    type: "hello",
                    protocol: LINK_PROTOCOL,
                    session: null,
                    received: 0,
                    version: "t",
                    tools: { git: true, gh: false, github: false },
                }),
            );
            await until(() => setup.runners.list()[0]?.online === true, "online");

            const again = setup.runners.makeCode("", "owner", first.id);
            const second = linkInProcess((request) => setup.runners.redeem(request), again.code);

            assert.equal(second.id, first.id);
            assert.equal(second.name, "Laptop");
            await ended;
            // The old key no longer opens it; the new one does.
            await assert.rejects(openLink(url, LINK_SUBPROTOCOL, first), /Closed 4003/);
            (await openLink(url, LINK_SUBPROTOCOL, second)).close();
        } finally {
            await setup.close();
        }
    });

    it("a connection that proved the old key does not outlive linking the computer again", async () => {
        const setup = await serve();
        const first = linkInProcess(
            (request) => setup.runners.redeem(request),
            setup.runners.makeCode("Laptop", "owner").code,
        );
        const url = `${setup.address.replace("http", "ws")}${LINK_PATH}`;
        const hello = JSON.stringify({
            type: "hello",
            protocol: LINK_PROTOCOL,
            session: null,
            received: 0,
            version: "t",
            tools: { git: true, gh: false, github: false },
        });
        const online = () => setup.runners.list()[0]?.online;

        try {
            // Nothing changes between its handshake and its hello: the link is taken.
            const kept = await openLink(url, LINK_SUBPROTOCOL, first);

            kept.send(hello);
            await until(() => online() === true, "online");
            kept.close();
            await until(() => online() === false, "offline");

            // The handshake is done with the old key. Then the computer is linked again, before this one says hello:
            // linking again finds no connection of it to end.
            const old = await openLink(url, LINK_SUBPROTOCOL, first);
            const closed = new Promise<number>((resolve) =>
                old.once("close", (code: number) => resolve(code)),
            );
            const second = linkInProcess(
                (request) => setup.runners.redeem(request),
                setup.runners.makeCode("", "owner", first.id).code,
            );

            old.send(hello);
            assert.equal(
                await Promise.race([
                    closed,
                    new Promise<number>((resolve) => setTimeout(() => resolve(0), 3000)),
                ]),
                CLOSE_IDENTITY,
                "the old key's connection is ended, not taken",
            );
            assert.equal(online(), false);

            // The new key's is taken.
            const fresh = await openLink(url, LINK_SUBPROTOCOL, second);

            fresh.send(hello);
            await until(() => online() === true, "online with the new key");
            fresh.close();
        } finally {
            await setup.close();
        }
    });

    it("a computer linked before the secure link is asked to link again", async () => {
        const setup = await serve();

        try {
            const runner = setup.config.addRunner("Old laptop", "owner", "x".repeat(43));

            delete (runner as { publicKey?: string }).publicKey;
            assert.equal(setup.runners.list()[0]?.relink, true);
        } finally {
            await setup.close();
        }
    });
});

// A runner that stops for good stays stopped (its service is not started again), so only its own server may say so,
// with proof. Anything else at the server's address, or on the path to it, can only make it try again.
describe("what stops a runner for good", () => {
    it("is not an HTTP answer, a close code, or a refusal its server did not sign for this connection", async () => {
        const setup = await serve();
        const linked = linkInProcess(
            (request) => setup.runners.redeem(request),
            setup.runners.makeCode("Laptop", "owner").code,
        );
        // A refusal the real server signed for this computer, but for another key and another connection.
        const replayed = await new Promise<string>((resolve, reject) => {
            const raw = new Raw(
                `${setup.address.replace("http", "ws")}${LINK_PATH}`,
                LINK_SUBPROTOCOL,
            );

            raw.once("open", () =>
                raw.send(
                    JSON.stringify({
                        type: "hs1",
                        id: linked.id,
                        key: newIdentity().publicKey,
                        eph: "e",
                        nonce: "n",
                    }),
                ),
            );
            raw.once("message", (data) => resolve(String(data)));
            raw.once("error", reject);
        });

        assert.equal((JSON.parse(replayed) as { why?: string }).why, "relinked");

        // What answers at the server's address: an HTTP status, a close code, a refusal, or the server itself.
        let answer: "http" | number | "forged" | "replayed" | "server" = "http";
        let tries = 0;
        const fake = createServer();
        const sockets = new WebSocketServer({ noServer: true });

        fake.on("upgrade", (request, socket, head) => {
            const how = answer;

            tries++;

            if (how === "server") {
                setup.runners.upgrade(request, socket, head);

                return;
            }

            if (how === "http") {
                socket.end(
                    "HTTP/1.1 401 Unauthorized\r\nconnection: close\r\ncontent-length: 0\r\n\r\n",
                );

                return;
            }

            sockets.handleUpgrade(request, socket, head, (ws) => {
                ws.on("error", () => {});

                if (typeof how === "number") {
                    ws.close(how, "Removed");

                    return;
                }

                ws.once("message", () => {
                    ws.send(
                        how === "replayed"
                            ? replayed
                            : JSON.stringify({
                                  type: "refused",
                                  why: "removed",
                                  sig: randomBytes(64).toString("base64url"),
                              }),
                    );
                    ws.close(CLOSE.removed, "Removed");
                });
            });
        });
        await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));

        const lines: string[] = [];
        const runner = new Runner({
            link: {
                server: `http://127.0.0.1:${(fake.address() as AddressInfo).port}`,
                ...linked,
            },
            version: "test",
            cwd: root,
            retryMs: [50],
            log: (line) => lines.push(line),
        });
        const state = watch(runner);

        try {
            runner.start();

            for (const each of [
                "http",
                CLOSE.replaced,
                CLOSE.removed,
                CLOSE.protocol,
                CLOSE_IDENTITY,
                "forged",
                "replayed",
            ] as const) {
                const from = tries;

                answer = each;
                // Two more tries: one at least was answered this way, and the runner came back after it.
                await until(() => tries >= from + 2, `another try after ${String(each)}`);
                assert.equal(state.stopped, undefined, `${String(each)} does not stop the runner`);
            }

            // Each reason is said once, not on every try.
            assert.equal(lines.filter((line) => /returned HTTP 401/.test(line)).length, 1);
            assert.ok(lines.some((line) => /did not prove it is the server/.test(line)));

            // Its own server answers at last: it connects, as if nothing had happened.
            answer = "server";
            await until(() => runner.connected, "the runner to connect to its server");
            await until(() => setup.runners.list()[0]?.online === true, "the computer online");
        } finally {
            await runner.stop().catch(() => {});
            sockets.close();
            fake.closeAllConnections();
            await new Promise((resolve) => fake.close(resolve));
            await setup.close();
        }
    });

    it("is its own server's word that the computer was removed, linked again, or taken by another runner", async () => {
        const setup = await serve();
        const link = (name: string, again?: string) =>
            linkInProcess(
                (request) => setup.runners.redeem(request),
                setup.runners.makeCode(name, "owner", again).code,
            );
        const started: Runner[] = [];

        const start = (linked: ReturnType<typeof link>) => {
            const runner = new Runner({
                link: { server: setup.address, ...linked },
                version: "test",
                cwd: root,
                retryMs: [50],
            });

            started.push(runner);
            runner.finished.catch(() => {});
            runner.start();

            return runner;
        };

        try {
            // Removed while it was away: no link can be sealed with a computer that is gone, so the server signs its
            // refusal of this very connection.
            const gone = link("Gone");

            setup.runners.remove(gone.id);
            await assert.rejects(start(gone).finished, /removed this computer/);

            // Linked again while it was away: the old key gets a signed refusal too.
            const first = link("Laptop");
            const second = link("", first.id);

            await assert.rejects(start(first).finished, (error: Error) => {
                assert.ok(error instanceof RunnerStopped);
                assert.match(error.message, /linked this computer again with a new key/);

                return true;
            });

            // Linked again while it is connected: said inside the sealed link.
            const kept = start(second);

            await until(() => kept.connected, "the runner to connect");
            await until(() => setup.runners.list()[0]?.online === true, "the computer online");

            const third = link("", first.id);

            await assert.rejects(kept.finished, /linked this computer again with a new key/);

            // Another runner takes the link: the one it replaced stops, and the two do not fight for it.
            const one = start(third);

            await until(() => one.connected, "the first runner to connect");
            await until(
                () => setup.runners.list()[0]?.online === true,
                "the computer online again",
            );

            const two = start(third);

            await assert.rejects(one.finished, /Another runner is using this computer's link/);
            await until(() => two.connected, "the newer runner to keep the link");
        } finally {
            await Promise.all(started.map((each) => each.stop().catch(() => {})));
            await setup.close();
        }
    });

    it("is its own server's word that the protocols differ, said inside the sealed link", async () => {
        const setup = await serve();
        const linked = linkInProcess(
            (request) => setup.runners.redeem(request),
            setup.runners.makeCode("Laptop", "owner").code,
        );
        const reason = `This server speaks link protocol ${LINK_PROTOCOL}, the runner ${LINK_PROTOCOL + 1}`;
        // A server that holds the pinned key, and sends the runner away as the real one does.
        const fake = createServer();
        const sockets = new WebSocketServer({ server: fake });

        sockets.on("connection", (ws) => {
            const sealed = new ServerLinkSocket(ws, {
                identity: setup.config.serverIdentity,
                runnerKey: () => publicOf(linked.key),
                unknown: CLOSE.removed,
            });

            sealed.once("open", () => {
                sealed.send(JSON.stringify({ type: "bye", reason, stop: "protocol" }));
                sealed.close(CLOSE.protocol, "Protocol");
            });
        });
        await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));

        const runner = new Runner({
            link: {
                server: `http://127.0.0.1:${(fake.address() as AddressInfo).port}`,
                ...linked,
            },
            version: "test",
            cwd: root,
            retryMs: [50],
        });

        try {
            // The server's side: a hello in another protocol gets the word, sealed, before the close.
            const mine = await openLink(
                `${setup.address.replace("http", "ws")}${LINK_PATH}`,
                LINK_SUBPROTOCOL,
                linked,
            );
            const said = new Promise<string>((resolve) =>
                mine.once("message", (data: Buffer) => resolve(data.toString("utf8"))),
            );

            mine.send(
                JSON.stringify({
                    type: "hello",
                    protocol: LINK_PROTOCOL + 1,
                    session: null,
                    received: 0,
                    version: "t",
                    tools: { git: true, gh: false, github: false },
                }),
            );
            assert.deepEqual(JSON.parse(await said), { type: "bye", reason, stop: "protocol" });

            // The runner's side: it stops on that word, with what to do.
            runner.start();
            await assert.rejects(
                runner.finished,
                new RegExp(`the runner ${LINK_PROTOCOL + 1}\\. Update Pi Pocket on this computer`),
            );
            // A word it does not know is no message at all: it stops nothing.
            assert.equal(
                parseControl(JSON.stringify({ type: "bye", reason, stop: "anything" })),
                undefined,
            );
        } finally {
            await runner.stop().catch(() => {});
            sockets.close();
            fake.closeAllConnections();
            await new Promise((resolve) => fake.close(resolve));
            await setup.close();
        }
    });
});
