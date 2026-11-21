// The runner link's own security (`secure-link.ts`): each attack a server in the middle could try, and that it fails.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { WebSocket as Raw, WebSocketServer } from "ws";
import { LINK_PATH, LINK_SUBPROTOCOL, CLOSE } from "../src/runner/protocol.ts";
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

        const link = new RunnerLinkSocket(raw, linked, () => {});

        try {
            await new Promise((resolve) => link.once("open", resolve));
            link.send(
                JSON.stringify({
                    type: "hello",
                    protocol: 1,
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

    it("refuses a server that cannot prove the pinned key, and the runner stops", async () => {
        const setup = await serve();
        const linked = linkInProcess(
            (request) => setup.runners.redeem(request),
            setup.runners.makeCode("Laptop", "owner").code,
        );
        // A server in the middle with a valid certificate but its own key, which knows the runner's public key.
        const fake = createServer();
        const sockets = new WebSocketServer({ server: fake });
        const lines: string[] = [];

        sockets.on(
            "connection",
            (ws) =>
                new ServerLinkSocket(ws, {
                    identity: newIdentity(),
                    runnerKey: () => setup.config.runnerById(linked.id)!.publicKey,
                    unknown: CLOSE.removed,
                }),
        );
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

        try {
            runner.start();
            await assert.rejects(runner.finished, RunnerStopped);
            assert.ok(lines.some((line) => /did not prove it is the server/.test(line)));
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
            protocol: 1,
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

                const link = new RunnerLinkSocket(raw, linked, () => {});
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
                    protocol: 1,
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
