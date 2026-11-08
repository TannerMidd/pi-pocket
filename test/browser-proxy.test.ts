// The browser's proxy for sessions on another computer (`src/server/browser/proxy.ts`), with a stand-in for the
// computer's link; and the parts around it that need no browser: listening ports and download names.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { type AddressInfo, connect, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { after, before, test } from "node:test";
import { formatSize, numbered, safeName } from "../src/server/browser/downloads.ts";
import { parseListening } from "../src/server/browser/local-servers.ts";
import { BrowserProxy, parseHead, PRIME_HOST } from "../src/server/browser/proxy.ts";
import { normalizeUrl } from "../src/server/browser/urls.ts";

let origin: Server;
let originPort = 0;
/** Request heads that reached the origin, raw. */
const heads: string[] = [];
/** What the proxy asked the "computer" to open. */
const asked: { runner: string; host: string; port: number }[] = [];
let refuse: string | undefined;
let proxy: BrowserProxy;

before(async () => {
    origin = createServer((request, response) => {
        heads.push(
            `${request.method} ${request.url}\n${request.rawHeaders
                .map((each, i) => (i % 2 === 0 ? `${each}: ` : `${each}\n`))
                .join("")}`,
        );
        response.end(`hello ${request.url}`);
    });
    await new Promise<void>((done) => origin.listen(0, "127.0.0.1", done));
    originPort = (origin.address() as AddressInfo).port;

    // The computer: opens every connection to the origin, as a runner would to its host.
    proxy = new BrowserProxy(async (runner, host, port, socket: Duplex, options) => {
        asked.push({ runner, host, port });

        if (refuse !== undefined) {
            throw new Error(refuse);
        }

        const upstream = connect(originPort, "127.0.0.1");

        await new Promise<void>((done, fail) => {
            upstream.once("connect", done);
            upstream.once("error", fail);
        });
        options.opened?.();

        for (const bytes of options.first ?? []) {
            upstream.write(bytes);
        }

        socket.pipe(upstream);
        upstream.pipe(socket);
        socket.resume();
    });
    await proxy.start();
});

after(() => {
    proxy.close();
    origin.close();
});

/** Send raw bytes to a port; everything it answered until it closed. */
function raw(port: number, text: string): Promise<string> {
    return new Promise((done) => {
        const socket: Socket = connect(port, "127.0.0.1", () => socket.write(text));
        let answer = "";

        socket.on("data", (chunk) => (answer += chunk.toString("latin1")));
        socket.on("close", () => done(answer));
        socket.on("error", () => {});
    });
}

test("the proxy refuses wrong or missing credentials, and nothing is opened", async () => {
    const before = asked.length;

    for (const auth of ["", "Proxy-Authorization: Basic Zm9vOmJhcg==\r\n"]) {
        const answer = await raw(
            proxy.port,
            `GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\n${auth}\r\n`,
        );

        assert.match(answer, /^HTTP\/1\.1 407 /);
        assert.match(answer, /Proxy-Authenticate: Basic/i);
    }

    // Removed credentials are refused too.
    const removed = proxy.add("laptop");

    proxy.remove(removed.key);
    assert.match(
        await raw(
            proxy.port,
            `CONNECT example.com:443 HTTP/1.1\r\nProxy-Authorization: ${removed.key}\r\n\r\n`,
        ),
        /^HTTP\/1\.1 407 /,
    );
    assert.equal(asked.length, before);
});

test("plain http goes on in origin form with Connection: close, its proxy headers removed", async () => {
    const { key } = proxy.add("laptop");
    const answer = await raw(
        proxy.port,
        `GET http://site.test:8080/a?b=1 HTTP/1.1\r\nHost: site.test:8080\r\nProxy-Authorization: ${key}\r\nProxy-Connection: keep-alive\r\nConnection: keep-alive, X-Hop\r\nX-Hop: 1\r\nX-Kept: yes\r\n\r\n`,
    );

    assert.match(answer, /hello \/a\?b=1/);
    assert.deepEqual(asked.at(-1), { runner: "laptop", host: "site.test", port: 8080 });

    const head = heads.at(-1)!;

    assert.match(head, /^GET \/a\?b=1\n/);
    assert.match(head, /Connection: close/);
    assert.match(head, /X-Kept: yes/);
    assert.doesNotMatch(head, /Proxy-|X-Hop/i);
});

test("CONNECT is a tunnel; the prime address answers without the computer", async () => {
    const { key } = proxy.add("desk");
    const answer = await raw(
        proxy.port,
        `CONNECT [::1]:${originPort} HTTP/1.1\r\nProxy-Authorization: ${key}\r\n\r\nGET /tunnel HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`,
    );

    assert.match(answer, /^HTTP\/1\.1 200 Connection established\r\n\r\nHTTP\/1\.1 200 OK/);
    assert.match(answer, /hello \/tunnel/);
    assert.deepEqual(asked.at(-1), { runner: "desk", host: "::1", port: originPort });

    const before = asked.length;
    const primed = proxy.add("desk");

    assert.equal(proxy.primed(primed.key), false);
    assert.match(
        await raw(
            proxy.port,
            `GET http://${PRIME_HOST}/ HTTP/1.1\r\nProxy-Authorization: ${primed.key}\r\n\r\n`,
        ),
        /^HTTP\/1\.1 204 /,
    );
    assert.equal(proxy.primed(primed.key), true);
    assert.equal(asked.length, before);
});

test("when the computer cannot connect, the browser gets 502 and the reason", async () => {
    const { key } = proxy.add("laptop");
    const since = Date.now();

    refuse = "Laptop is offline. Start Pi Pocket's runner there, then try again.";

    try {
        const page = await raw(
            proxy.port,
            `GET http://localhost:3000/ HTTP/1.1\r\nProxy-Authorization: ${key}\r\n\r\n`,
        );

        assert.match(page, /^HTTP\/1\.1 502 /);
        assert.match(page, /text\/html/);
        assert.match(page, /Laptop is offline/);
        assert.match(
            await raw(
                proxy.port,
                `CONNECT localhost:443 HTTP/1.1\r\nProxy-Authorization: ${key}\r\n\r\n`,
            ),
            /^HTTP\/1\.1 502 [^]*Laptop is offline/,
        );
        assert.match(proxy.problem(key, since) ?? "", /Laptop is offline/);
        assert.equal(proxy.problem(key, Date.now() + 1000), undefined);
    } finally {
        refuse = undefined;
    }
});

test("the deny listener refuses everything", async () => {
    const before = asked.length;

    assert.match(
        await raw(proxy.denyPort, "GET http://example.com/ HTTP/1.1\r\n\r\n"),
        /^HTTP\/1\.1 502 /,
    );
    assert.match(
        await raw(proxy.denyPort, "CONNECT example.com:443 HTTP/1.1\r\n\r\n"),
        /^HTTP\/1\.1 502 /,
    );
    assert.equal(asked.length, before);
});

test("request heads parse strictly", () => {
    assert.deepEqual(parseHead("CONNECT a:1 HTTP/1.1\r\nX: y"), {
        method: "CONNECT",
        target: "a:1",
        version: "HTTP/1.1",
        headers: [["X", "y"]],
    });
    assert.equal(parseHead("GET / HTTP/2"), undefined);
    assert.equal(parseHead("GET / HTTP/1.1\r\nBad Header: x"), undefined);
});

test("a computer's listening ports come from its own tools' output", () => {
    // Linux /proc/net/tcp and tcp6: 127.0.0.1:5173 and 0.0.0.0:22 listen; 10.0.0.5:8080 is not loopback; one is ESTABLISHED.
    const proc = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1
   1: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 2
   2: 0500000A:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 3
   3: 0100007F:1F91 0100007F:9999 01 00000000:00000000 00:00000000 00000000     0        0 4
   0: 00000000000000000000000001000000:0BB8 00000000000000000000000000000000:0000 0A 0 0 0 0 0 5`;

    assert.deepEqual(parseListening(proc), [22, 3000, 5173]);

    const lsof = `COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME
node    123 me   20u  IPv4 0x1      0t0  TCP 127.0.0.1:5173 (LISTEN)
node    124 me   21u  IPv6 0x2      0t0  TCP *:3000 (LISTEN)
node    125 me   22u  IPv4 0x3      0t0  TCP 192.168.1.4:9000 (LISTEN)
node    126 me   23u  IPv4 0x4      0t0  TCP 127.0.0.1:5173->127.0.0.1:50000 (ESTABLISHED)`;

    assert.deepEqual(parseListening(lsof), [3000, 5173]);

    const ss = `State  Recv-Q Send-Q Local Address:Port Peer Address:Port Process
LISTEN 0      511        127.0.0.1:8080      0.0.0.0:*
LISTEN 0      4096            [::]:4000         [::]:*`;

    assert.deepEqual(parseListening(ss), [4000, 8080]);

    const netstat = `Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1000
  TCP    127.0.0.1:5173         0.0.0.0:0              LISTENING       2000
  TCP    127.0.0.1:5173         127.0.0.1:50001        ESTABLISHED     2000`;

    assert.deepEqual(parseListening(netstat), [135, 5173]);
});

test("a session on another computer opens no files of this server", () => {
    for (const input of ["/etc/hosts", "./index.html", "file:///etc/hosts"]) {
        assert.equal(normalizeUrl(input, { trusted: true, cwd: "/work", files: false }), undefined);
    }

    assert.equal(
        normalizeUrl("localhost:5173", { trusted: true, files: false }),
        "http://localhost:5173/",
    );
});

test("download names are safe and numbered", () => {
    assert.equal(safeName("../../etc/passwd"), "_.._etc_passwd");
    assert.equal(safeName("a\\b:c.txt"), "a_b_c.txt");
    assert.equal(safeName(".."), "download");
    assert.equal(safeName(""), "download");
    assert.equal(numbered("report.bin", 1), "report.bin");
    assert.equal(numbered("report.bin", 2), "report (2).bin");
    assert.equal(numbered("archive", 3), "archive (3)");
    assert.equal(formatSize(70_000), "68 KB");
});
