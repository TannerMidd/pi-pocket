// Runner HTTP safety (`src/runner/transport.ts`): address-only loopback checks and checks without
// external DNS or the machine's Tailscale. Neither dependency can be injected into checkTransport.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkTransport, loopback } from "../src/runner/transport.ts";

describe("runner loopback addresses", () => {
    for (const address of [
        "127.0.0.1",
        "127.5.5.5",
        "::1",
        "0:0:0:0:0:0:0:1",
        "::ffff:127.0.0.1",
        "[::1]",
        "[::FFFF:127.0.0.1]",
    ]) {
        it(`recognizes ${address}`, () => {
            assert.equal(loopback(address), true);
        });
    }

    for (const address of [
        "10.0.0.1",
        "100.64.1.1",
        "203.0.113.5",
        "::ffff:10.0.0.1",
        "localhost",
    ]) {
        it(`does not treat ${address} as a loopback address`, () => {
            assert.equal(loopback(address), false);
        });
    }
});

describe("runner transport checks", () => {
    it("accepts HTTPS before resolving even a nonexistent name", async () => {
        assert.deepEqual(await checkTransport("https://runner-does-not-exist.invalid", false), {
            ok: true,
            why: "https",
        });
    });

    for (const host of ["127.0.0.1", "127.5.5.5", "[::1]"]) {
        it(`accepts HTTP to ${host} without asking Tailscale`, async () => {
            // The checked address is the only one the connection may use (`pinnedLookup`).
            assert.deepEqual(await checkTransport(`http://${host}:8899`, false), {
                ok: true,
                why: "loopback",
                address: host.replace(/^\[|\]$/g, ""),
                addresses: [host.replace(/^\[|\]$/g, "")],
            });
        });
    }

    for (const host of ["localhost", "localhost.localdomain", "ip6-localhost"]) {
        it(`accepts HTTP to the known loopback name ${host}`, async () => {
            assert.deepEqual(await checkTransport(`http://${host}:8899`, false), {
                ok: true,
                why: "loopback",
                address: host,
            });
        });
    }

    it("keeps the stronger reason when plain HTTP was explicitly allowed", async () => {
        assert.deepEqual(await checkTransport("http://127.0.0.1", true), {
            ok: true,
            why: "loopback",
            address: "127.0.0.1",
            addresses: ["127.0.0.1"],
        });
        assert.deepEqual(await checkTransport("https://203.0.113.5", true), {
            ok: true,
            why: "https",
        });
    });

    // Public HTTP addresses still invoke tailscalePeer even with allowHttp=true. Unresolved HTTP
    // names invoke the real DNS resolver. tailscalePeer's parser is not a separate pure export.
});
