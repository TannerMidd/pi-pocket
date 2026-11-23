// Whether a browser runs on the server's machine (`src/server/local-browser.ts`), for "Show in the file manager":
// loopback and this machine's own addresses are, other addresses are not, and a proxy's headers take it away unless
// the client they name is this machine too.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { User } from "../src/server/config.ts";
import {
    isLocalRequest,
    type LocalRequest,
    type Machine,
    ownAddress,
    requireLocalBrowser,
    revealOffered,
} from "../src/server/local-browser.ts";
import { hasDesktop } from "../src/server/reveal.ts";

/** A machine on a LAN (192.168.1.20) and a tailnet (100.101.102.103), named `box`. */
const machine: Machine = {
    hostname: "box",
    interfaces: {
        eth0: [{ address: "192.168.1.20" }, { address: "fe80::1234" }],
        tailscale0: [{ address: "100.101.102.103" }, { address: "fd7a:115c:a1e0::1" }],
    },
};

const request = (
    remoteAddress: string | undefined,
    headers: Record<string, string | string[]> = {},
): LocalRequest => ({
    socket: { remoteAddress },
    headers: { host: "localhost:8787", ...headers },
});
const local = (remote: string | undefined, headers?: Record<string, string | string[]>) =>
    isLocalRequest(request(remote, headers), machine);

test("loopback, in each way a socket writes it, is this machine", () => {
    for (const address of ["127.0.0.1", "127.8.9.10", "::1", "::ffff:127.0.0.1"]) {
        assert.equal(ownAddress(address, machine), true, address);
        assert.equal(local(address), true, address);
    }
});

test("an address of one of this machine's interfaces is this machine", () => {
    for (const address of [
        "192.168.1.20",
        "::ffff:192.168.1.20",
        "100.101.102.103",
        "fe80::1234%eth0",
    ]) {
        assert.equal(ownAddress(address, machine), true, address);
    }

    assert.equal(local("192.168.1.20", { host: "192.168.1.20:8787" }), true, "its LAN address");
    assert.equal(
        local("100.101.102.103", { host: "100.101.102.103:8787" }),
        true,
        "its tailnet one",
    );
});

test("another device on the LAN or the tailnet is not this machine", () => {
    for (const address of [
        "192.168.1.21",
        "::ffff:192.168.1.21",
        "100.101.102.104",
        "203.0.113.5",
    ]) {
        assert.equal(ownAddress(address, machine), false, address);
        assert.equal(local(address), false, address);
    }

    assert.equal(local(undefined), false, "a socket with no address");
    assert.equal(ownAddress("not an address", machine), false);
});

test("a proxy's headers make loopback not local: tailscale serve, cloudflared, nginx", () => {
    const signs: Record<string, string>[] = [
        { "x-forwarded-for": "100.64.0.9" },
        { "x-forwarded-proto": "https", "x-forwarded-host": "box.tail1234.ts.net" },
        { "tailscale-user-login": "me@example.com" },
        { "cf-connecting-ip": "203.0.113.5" },
        { "cf-ray": "8a1b2c3d4e5f-AMS" },
        { "x-real-ip": "192.168.1.21" },
        { forwarded: "for=192.0.2.60;proto=https" },
        { forwarded: "proto=https;host=example.com" },
        { via: "1.1 nginx" },
    ];

    for (const headers of signs) {
        assert.equal(local("127.0.0.1", headers), false, JSON.stringify(headers));
    }
});

test("a forwarded client that is this machine stays local, but every one named must be", () => {
    assert.equal(local("127.0.0.1", { "x-forwarded-for": "127.0.0.1" }), true);
    assert.equal(local("127.0.0.1", { "x-forwarded-for": "192.168.1.20", via: "1.1 nginx" }), true);
    assert.equal(local("::1", { forwarded: 'for="[::1]:51234";proto=https' }), true);
    assert.equal(local("127.0.0.1", { "x-real-ip": "100.101.102.103:4433" }), true);
    assert.equal(
        local("127.0.0.1", { "x-forwarded-for": "203.0.113.5, 127.0.0.1" }),
        false,
        "a proxy chain from elsewhere",
    );
    assert.equal(
        local("127.0.0.1", { "x-forwarded-for": "127.0.0.1", "cf-connecting-ip": "203.0.113.5" }),
        false,
    );
    assert.equal(local("127.0.0.1", { "x-forwarded-for": "unknown" }), false);
    assert.equal(local("127.0.0.1", { forwarded: "for=_hidden" }), false, "an obfuscated client");
});

test("headers never make a connection from elsewhere local", () => {
    assert.equal(local("192.168.1.21", { "x-forwarded-for": "127.0.0.1" }), false);
    assert.equal(local("203.0.113.5", { forwarded: "for=127.0.0.1", host: "localhost" }), false);
});

test("without a proxy's headers, the browser must ask for this machine by a name only it has", () => {
    for (const host of [
        "localhost:8787",
        "app.localhost",
        "127.0.0.1:8787",
        "[::1]:8787",
        "box",
        "box:8787",
        "box.local:8787",
        "box.tail1234.ts.net",
        "192.168.1.20:8787",
    ]) {
        assert.equal(local("127.0.0.1", { host }), true, host);
    }

    // A proxy that adds no headers still passes on the public name a browser elsewhere asked for.
    for (const host of ["pocket.example.com", "other.tail1234.ts.net", "192.168.1.21:8787", ""]) {
        assert.equal(local("127.0.0.1", { host }), false, host);
    }

    assert.equal(
        isLocalRequest({ socket: { remoteAddress: "127.0.0.1" }, headers: {} }, machine),
        false,
    );
});

test("reveal is offered to the owner in a local browser, with a desktop; refused elsewhere with a 403", () => {
    const owner = { role: "owner" } as User;
    const guest = { role: "guest" } as User;

    assert.equal(revealOffered(owner, true), hasDesktop());
    assert.equal(revealOffered(owner, false), false);
    assert.equal(revealOffered(guest, true), false);
    assert.throws(() => requireLocalBrowser(request("203.0.113.5")), {
        status: 403,
        message: "Show in file manager works only in a browser on the server's machine",
    });
});
