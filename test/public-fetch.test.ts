// host.fetchPublic reaches only public addresses: literal IPs, names, and redirects are checked where they connect.
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { isIP, type AddressInfo } from "node:net";
import type { networkInterfaces } from "node:os";
import { after, before, test } from "node:test";
import { gzipSync } from "node:zlib";
import { createPublicFetch, isPublicAddress } from "../src/server/public-fetch.ts";

test("public addresses are the public internet alone", () => {
    for (const address of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700:4700::1111"]) {
        assert.equal(isPublicAddress(address), true, address);
    }

    for (const address of [
        "127.0.0.1",
        "127.1.2.3",
        "0.0.0.0",
        "10.0.0.1",
        "172.16.5.4",
        "192.168.1.1",
        "169.254.169.254",
        "100.64.0.1",
        "198.18.0.1",
        "224.0.0.1",
        "255.255.255.255",
        "::",
        "::1",
        "fe80::1",
        "fe80::1%eth0",
        "fc00::1",
        "fd12:3456::1",
        "ff02::1",
        "::ffff:127.0.0.1",
        "::ffff:7f00:1",
        "::ffff:169.254.169.254",
        "64:ff9b::a00:1",
        "2001:db8::1",
        "2002:7f00:1::",
        "localhost",
        "",
    ]) {
        assert.equal(isPublicAddress(address), false, address);
    }

    assert.equal(isPublicAddress("::ffff:8.8.8.8"), true);
});

test("the real fetch refuses this machine and private networks without connecting", async () => {
    const fetchPublic = createPublicFetch();

    for (const url of [
        "http://127.0.0.1:9999/",
        "http://0x7f.1:9999/",
        "http://2130706433:9999/",
        "http://[::1]:9999/",
        "http://[::ffff:127.0.0.1]:9999/",
        "http://169.254.169.254/latest/meta-data/",
        "http://192.168.0.1/",
        "http://localhost:9999/",
    ]) {
        await assert.rejects(fetchPublic(url), { code: "POCKET_NOT_PUBLIC" }, url);
    }

    for (const url of ["file:///etc/passwd", "ftp://example.com/", "http://me:pw@example.com/"]) {
        await assert.rejects(fetchPublic(url), { code: "POCKET_NOT_PUBLIC" }, url);
    }
});

function interfaceList(addresses: string[]): ReturnType<typeof networkInterfaces> {
    return {
        eth0: addresses.map((address) => ({
            address,
            family: isIP(address) === 4 ? "IPv4" : "IPv6",
            scopeid: 0,
            netmask: "",
            mac: "00:00:00:00:00:00",
            internal: false,
            cidr: null,
        })),
        absent: undefined,
    };
}

test("public interface literals are refused, including equivalent and mapped addresses", async () => {
    const fetchPublic = createPublicFetch({
        networkInterfaces: () => interfaceList(["8.8.8.8", "2606:4700:4700:0:0:0:0:1111"]),
    });

    for (const host of [
        "8.8.8.8",
        "[::ffff:8.8.8.8]",
        "[::ffff:808:808]",
        "[2606:4700:4700::1111]",
        "[2606:4700:4700:0:0:0:0:1111]",
    ]) {
        await assert.rejects(fetchPublic(`http://${host}/`), { code: "POCKET_NOT_PUBLIC" });
    }
});

test("each DNS answer is checked against fresh IPv4 and IPv6 interface addresses", async () => {
    for (const address of ["8.8.8.8", "2606:4700:4700::1111", "::ffff:808:808"]) {
        let addresses: string[] = [];
        const fetchPublic = createPublicFetch({
            networkInterfaces: () => interfaceList(addresses),
            resolve: async () => {
                // An interface can change after the fetch was created, even while DNS resolves.
                addresses = [address === "::ffff:808:808" ? "8.8.8.8" : address];

                return [
                    { address: "1.1.1.1", family: 4 },
                    { address, family: isIP(address) },
                ];
            },
        });

        await assert.rejects(fetchPublic("http://interface.test/"), {
            code: "POCKET_NOT_PUBLIC",
            message: /interface\.test resolves to/,
        });
    }
});

// The test server is on 127.0.0.1, which these fetches count as public. Names resolve as the test says.
let server: Server;
let port = 0;
const seen: { url: string; method: string; headers: IncomingMessage["headers"]; body: string }[] =
    [];

before(async () => {
    server = createServer((request, response) => {
        let body = "";

        request.on("data", (chunk: Buffer) => (body += chunk.toString()));
        request.on("end", () => {
            const url = request.url ?? "/";

            seen.push({ url, method: request.method ?? "", headers: request.headers, body });

            if (url === "/gzip") {
                response.writeHead(200, {
                    "content-type": "text/plain",
                    "content-encoding": "gzip",
                });
                response.end(gzipSync("hello, compressed"));
            } else if (url.startsWith("/to/")) {
                const target = decodeURIComponent(url.slice(4));

                response.writeHead(
                    Number(new URL(target, "http://x").searchParams.get("s") ?? 302),
                    {
                        location: target,
                    },
                );
                response.end();
            } else if (url === "/slow") {
                response.writeHead(200, { "content-type": "text/plain" });
                response.write("start");
                setTimeout(() => response.end(), 2_000).unref();
            } else if (url === "/big") {
                response.writeHead(200, { "content-type": "text/plain" });
                response.write("x".repeat(1000));
                response.end("x".repeat(1000));
            } else if (url === "/long") {
                response.writeHead(200, { "content-length": "5000" });
                response.end("x".repeat(5000));
            } else {
                response.writeHead(200, { "content-type": "text/plain" });
                response.end(`${request.method} ${url}`);
            }
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
});

after(() => new Promise<void>((resolve) => server.close(() => resolve())));

const names: Record<string, string[]> = {
    "site.test": ["127.0.0.1"],
    "other.test": ["127.0.0.1"],
    "inside.test": ["10.0.0.7"],
    "mixed.test": ["127.0.0.1", "192.168.1.9"],
};

/** A fetch for the test: 127.0.0.1 counts as public, and names resolve from `names`, counting each lookup. */
function testFetch() {
    const lookups: string[] = [];
    const fetchPublic = createPublicFetch({
        isPublic: (address) => address === "127.0.0.1" || isPublicAddress(address),
        networkInterfaces: () => ({}),
        resolve: async (hostname) => {
            lookups.push(hostname);
            const addresses = names[hostname];

            if (addresses === undefined) {
                throw Object.assign(new Error(`no such name ${hostname}`), { code: "ENOTFOUND" });
            }

            return addresses.map((address) => ({ address, family: 4 }));
        },
    });

    return { fetchPublic, lookups };
}

const at = (host: string, path: string) => `http://${host}:${port}${path}`;
const via = (target: string) => `/to/${encodeURIComponent(target)}`;

test("a public name fetches, and its body is decoded", async () => {
    const { fetchPublic, lookups } = testFetch();
    const response = await fetchPublic(at("site.test", "/gzip"));

    assert.equal(response.status, 200);
    assert.equal(await response.text(), "hello, compressed");
    assert.equal(response.url, at("site.test", "/gzip"));
    assert.equal(response.redirected, false);
    assert.deepEqual(lookups, ["site.test"]);
});

test("interface changes are read again for literals, DNS answers, and redirects", async () => {
    let addresses: string[] = [];
    const fetchPublic = createPublicFetch({
        isPublic: (address) => address === "127.0.0.1" || isPublicAddress(address),
        networkInterfaces: () => interfaceList(addresses),
        resolve: async () => {
            addresses = ["127.0.0.1"];

            return [{ address: "127.0.0.1", family: 4 }];
        },
    });

    // The literal initially passes. The redirect's DNS lookup sees the changed interface list.
    await assert.rejects(fetchPublic(at("127.0.0.1", via(at("changed.test", "/")))), {
        code: "POCKET_NOT_PUBLIC",
    });
    await assert.rejects(fetchPublic(at("127.0.0.1", "/")), { code: "POCKET_NOT_PUBLIC" });

    addresses = [];
    assert.equal(await (await fetchPublic(at("127.0.0.1", "/removed"))).text(), "GET /removed");
});

test("a name with any address that is not public is refused where it connects", async () => {
    const { fetchPublic } = testFetch();

    await assert.rejects(fetchPublic(at("inside.test", "/")), {
        code: "POCKET_NOT_PUBLIC",
        message: /inside\.test resolves to 10\.0\.0\.7/,
    });
    await assert.rejects(fetchPublic(at("mixed.test", "/")), { code: "POCKET_NOT_PUBLIC" });
    assert.ok(!seen.some((each) => each.headers.host?.startsWith("inside.test")));
});

test("redirects are checked at each address, and to a private one are refused", async () => {
    const { fetchPublic } = testFetch();
    const fine = await fetchPublic(at("site.test", via(at("other.test", "/done"))));

    const copy = fine.clone();

    assert.equal(await fine.text(), "GET /done");
    assert.equal(fine.url, at("other.test", "/done"));
    assert.equal(fine.redirected, true);
    assert.equal(copy.url, at("other.test", "/done"));
    assert.equal(copy.redirected, true);

    await assert.rejects(fetchPublic(at("site.test", via("http://169.254.169.254/"))), {
        code: "POCKET_NOT_PUBLIC",
    });
    await assert.rejects(fetchPublic(at("site.test", via(at("inside.test", "/")))), {
        code: "POCKET_NOT_PUBLIC",
    });
    await assert.rejects(fetchPublic(at("site.test", via("file:///etc/passwd"))), {
        code: "POCKET_NOT_PUBLIC",
    });
});

test("redirect modes, their limit, and what a redirect sends on", async () => {
    const { fetchPublic } = testFetch();
    const manual = await fetchPublic(at("site.test", via("/done")), { redirect: "manual" });

    assert.equal(manual.status, 302);
    assert.equal(manual.headers.get("location"), "/done");
    await assert.rejects(fetchPublic(at("site.test", via("/done")), { redirect: "error" }), {
        code: "POCKET_REDIRECTS",
    });

    const loop = at("site.test", via(at("site.test", via(at("site.test", via("/done"))))));

    await assert.rejects(fetchPublic(loop, { maxRedirects: 1 }), { code: "POCKET_REDIRECTS" });
    assert.equal(await (await fetchPublic(loop, { maxRedirects: 3 })).text(), "GET /done");

    // A 303 turns a POST (written "post": fetch's own methods go to capitals) into a GET, without the body's headers;
    // a 307 sends the POST and its body again.
    seen.length = 0;
    const post = {
        method: "post",
        body: "q=1",
        headers: { authorization: "Bearer secret", "content-language": "en" },
    };

    await fetchPublic(at("site.test", via("/after?s=303")), post);
    assert.deepEqual(
        seen.map((each) => [each.method, each.body, each.headers["content-language"]]),
        [
            ["POST", "q=1", "en"],
            ["GET", "", undefined],
        ],
    );

    seen.length = 0;
    await fetchPublic(at("site.test", via("/after?s=307")), post);
    assert.deepEqual(
        seen.map((each) => [each.method, each.body, each.headers.authorization]),
        [
            ["POST", "q=1", "Bearer secret"],
            ["POST", "q=1", "Bearer secret"],
        ],
    );

    // Another origin gets no credentials.
    seen.length = 0;
    await fetchPublic(at("site.test", via(at("other.test", "/x?s=307"))), post);
    assert.equal(seen[1]?.headers.authorization, undefined);
});

test("a body past maxBytes errors, before or while it is read", async () => {
    const { fetchPublic } = testFetch();

    await assert.rejects(fetchPublic(at("site.test", "/long"), { maxBytes: 1000 }), {
        code: "POCKET_TOO_LARGE",
    });

    const response = await fetchPublic(at("site.test", "/big"), { maxBytes: 1500 });

    await assert.rejects(response.text(), { code: "POCKET_TOO_LARGE" });

    // Content-Length is the encoded size: a small compressed body is checked as it decodes, not by it.
    const small = await fetchPublic(at("site.test", "/gzip"), { maxBytes: 17 });

    assert.equal(await small.text(), "hello, compressed");
    await assert.rejects((await fetchPublic(at("site.test", "/gzip"), { maxBytes: 16 })).text(), {
        code: "POCKET_TOO_LARGE",
    });
    assert.equal(
        (await fetchPublic(at("site.test", "/long"), { method: "HEAD", maxBytes: 10 })).status,
        200,
    );
    assert.equal(
        (await (await fetchPublic(at("site.test", "/big"), { maxBytes: 2000 })).text()).length,
        2000,
    );
});

test("a timeout and the caller's signal stop it", async () => {
    const { fetchPublic } = testFetch();
    const stop = new AbortController();

    stop.abort();
    await assert.rejects(fetchPublic(at("site.test", "/"), { signal: stop.signal }));

    const started = Date.now();
    const slow = await fetchPublic(at("site.test", "/slow"), { timeoutMs: 200 });

    await assert.rejects(slow.text());
    assert.ok(Date.now() - started < 1_500, "the timeout covers the body too");
    await assert.rejects(fetchPublic(at("nowhere.test", "/")), /fetch failed|no such name/);
});
