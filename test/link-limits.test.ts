// Wrong runner link codes (`src/server/link-limits.ts`): per client address, bans after repeated lockouts, a ceiling for
// the server that voids the open codes, and which address counts.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { ConfigStore } from "../src/server/config.ts";
import {
    ADDRESS_WRONG,
    BLOCK_MEMORY_MS,
    BLOCKS_TO_BAN,
    clientAddress,
    LinkLimits,
    LOCK_MS,
    memoryStore,
    SERVER_WRONG,
    WINDOW_MS,
    WRONG_CODE,
} from "../src/server/link-limits.ts";
import { Runners } from "../src/server/runners.ts";

const root = mkdtempSync(join(tmpdir(), "pi-pocket-link-limits-"));

after(() => rmSync(root, { recursive: true, force: true }));

/** A clock the test moves. */
function clock(start = 1_000_000) {
    let now = start;

    return { now: () => now, move: (ms: number) => (now += ms) };
}

const request = (address: string, headers: Record<string, string> = {}) => ({
    headers,
    socket: { remoteAddress: address },
});

/** `ADDRESS_WRONG` wrong codes from `address`: one lockout. */
function lockOut(limits: LinkLimits, address: string) {
    let result;

    for (let each = 0; each < ADDRESS_WRONG; each++) {
        result = limits.wrong(address);
    }

    return result!;
}

describe("link code limits", () => {
    it("locks one address after too many wrong codes, for a while, and not the others", () => {
        const time = clock();
        const limits = new LinkLimits(time.now);

        for (let each = 0; each < ADDRESS_WRONG - 1; each++) {
            limits.check("203.0.113.5");
            limits.wrong("203.0.113.5");
        }

        limits.check("203.0.113.5");
        assert.equal(limits.wrong("203.0.113.5").locked, true);
        assert.throws(
            () => limits.check("203.0.113.5"),
            /Too many wrong link codes from this address/,
        );
        limits.check("203.0.113.6");
        assert.deepEqual(limits.locks().addresses, [
            { address: "203.0.113.5", until: time.now() + LOCK_MS, blocks: 1 },
        ]);

        time.move(LOCK_MS + 1);
        limits.check("203.0.113.5");
        assert.deepEqual(limits.locks().addresses, []);
    });

    it("forgets wrong codes older than the window", () => {
        const time = clock();
        const limits = new LinkLimits(time.now);

        for (let each = 0; each < ADDRESS_WRONG - 1; each++) {
            limits.wrong("198.51.100.1");
        }

        time.move(WINDOW_MS + 1);
        limits.wrong("198.51.100.1");
        limits.check("198.51.100.1");
    });

    it("bans an address at its third lockout, with the wrong code's answer, until the owner lifts it", () => {
        const time = clock();
        const store = memoryStore();
        const limits = new LinkLimits(time.now, store);

        for (let block = 1; block < BLOCKS_TO_BAN; block++) {
            assert.deepEqual(lockOut(limits, "203.0.113.7"), {
                locked: true,
                banned: false,
                ceiling: false,
            });
            assert.equal(limits.locks().addresses[0]?.blocks, block);
            time.move(LOCK_MS + 1);
        }

        assert.equal(lockOut(limits, "203.0.113.7").banned, true);

        // The same refusal as a wrong code, and for good: no lockout ends it.
        assert.throws(
            () => limits.check("203.0.113.7"),
            (error: Error & { status?: number }) =>
                error.message === WRONG_CODE && error.status === 403,
        );
        time.move(BLOCK_MEMORY_MS * 4);
        assert.throws(() => limits.check("203.0.113.7"), { message: WRONG_CODE });
        assert.deepEqual(
            limits.locks().bans.map((ban) => ban.address),
            ["203.0.113.7"],
        );
        assert.deepEqual(limits.locks().addresses, [], "a ban is not also shown as a lockout");

        // A new LinkLimits (a restart) reads the ban back.
        const restarted = new LinkLimits(time.now, store);

        assert.throws(() => restarted.check("203.0.113.7"), { message: WRONG_CODE });
        assert.equal(restarted.lift("203.0.113.7"), true);
        restarted.check("203.0.113.7");
        assert.equal(restarted.lift("203.0.113.7"), false);

        // Lifted: it starts over, so one lockout does not ban it again.
        assert.equal(lockOut(restarted, "203.0.113.7").banned, false);
    });

    it("forgets an address's lockouts a week after its last one", () => {
        const time = clock();
        const limits = new LinkLimits(time.now);

        for (let block = 1; block < BLOCKS_TO_BAN; block++) {
            lockOut(limits, "198.51.100.9");
            time.move(LOCK_MS + 1);
        }

        time.move(BLOCK_MEMORY_MS);
        assert.equal(lockOut(limits, "198.51.100.9").banned, false);
        assert.equal(limits.locks().addresses[0]?.blocks, 1);
    });

    it("never bans the loopback address, which every client of a nameless proxy shares", () => {
        const time = clock();
        const limits = new LinkLimits(time.now);

        for (let block = 0; block < BLOCKS_TO_BAN + 1; block++) {
            assert.equal(lockOut(limits, "127.0.0.1").banned, false);
            time.move(LOCK_MS + 1);
        }

        limits.check("127.0.0.1");
        assert.deepEqual(limits.locks().bans, []);
    });

    it("pauses new linking when wrong codes from many addresses pass the server's ceiling", () => {
        const time = clock();
        const limits = new LinkLimits(time.now);
        let tripped = false;

        for (let each = 0; each < SERVER_WRONG; each++) {
            tripped = limits.wrong(`192.0.2.${each}`).ceiling || tripped;
        }

        assert.ok(tripped);
        assert.throws(() => limits.check("192.0.2.250"), /linking is paused/);
        assert.ok(limits.locks().server !== undefined);
        time.move(LOCK_MS + 1);
        limits.check("192.0.2.250");
    });

    it("takes the client address from the socket, and a proxy's header only where the proxy is", async () => {
        const header = { "cf-connecting-ip": "203.0.113.9", "x-forwarded-for": "100.88.1.2" };
        const peer = async (address: string) =>
            address === "100.88.1.2" ? ("peer" as const) : ("not-a-peer" as const);

        assert.equal(
            await clientAddress(request("::ffff:127.0.0.1", header), "cloudflare", peer),
            "203.0.113.9",
        );
        // Behind Tailscale Serve: the forwarded address, when Tailscale says it is a device of the tailnet.
        assert.equal(
            await clientAddress(request("127.0.0.1", header), "tailscale-serve", peer),
            "100.88.1.2",
        );
        assert.equal(
            await clientAddress(
                request("127.0.0.1", { "x-forwarded-for": "100.88.9.9" }),
                "tailscale-serve",
                peer,
            ),
            "127.0.0.1",
        );
        // No working tailscale command: nothing is a device of the tailnet.
        assert.equal(
            await clientAddress(
                request("127.0.0.1", header),
                "tailscale-serve",
                async () => "unavailable",
            ),
            "127.0.0.1",
        );
        // Not behind that proxy, or not from this machine: the header is a client's own claim.
        assert.equal(await clientAddress(request("127.0.0.1", header), "lan", peer), "127.0.0.1");
        assert.equal(
            await clientAddress(request("100.101.102.103", header), "cloudflare", peer),
            "100.101.102.103",
        );
        assert.equal(
            await clientAddress(
                request("127.0.0.1", { "cf-connecting-ip": "nonsense" }),
                "cloudflare",
                peer,
            ),
            "127.0.0.1",
        );
    });

    it("refuses a right code from a locked or banned address, and voids open codes at the ceiling, never linked computers", () => {
        const time = clock();
        const data = mkdtempSync(join(root, "data-"));
        const config = new ConfigStore(data);
        const runners = new Runners({ config, log: () => {}, now: time.now });
        const linked = runners.redeem(runners.makeCode("Server", "owner").code, "198.51.100.200");
        const good = runners.makeCode("Laptop", "owner").code;

        for (let each = 0; each < ADDRESS_WRONG; each++) {
            assert.throws(
                () => runners.redeem("WRONG-CODE-0000", "203.0.113.5"),
                /wrong, already used/,
            );
        }

        assert.throws(() => runners.redeem(good, "203.0.113.5"), /Too many wrong link codes/);

        // Banned: a right code gets the wrong code's answer, and the ban is saved with the config.
        for (let block = 1; block < BLOCKS_TO_BAN; block++) {
            time.move(LOCK_MS + 1);

            for (let each = 0; each < ADDRESS_WRONG; each++) {
                assert.throws(() => runners.redeem("WRONG-CODE-0000", "203.0.113.5"));
            }
        }

        time.move(LOCK_MS + 1);
        assert.throws(() => runners.redeem(good, "203.0.113.5"), { message: WRONG_CODE });
        assert.deepEqual(
            new ConfigStore(data).runnerLinkLimits?.bans.map((ban) => ban.address),
            ["203.0.113.5"],
        );
        runners.liftLinkBan("203.0.113.5");
        assert.throws(() => runners.liftLinkBan("203.0.113.5"), /not banned/);

        // Another address still links with it, until the ceiling voids it.
        const other = runners.makeCode("Desktop", "owner").code;

        for (let each = 0; each < SERVER_WRONG; each++) {
            assert.throws(() => runners.redeem("WRONG-CODE-0000", `192.0.2.${each % 200}`));
        }

        assert.throws(() => runners.redeem(other, "198.51.100.1"), /linking is paused/);
        time.move(LOCK_MS + 1);
        assert.throws(() => runners.redeem(other, "198.51.100.1"), /wrong, already used/);
        assert.deepEqual(
            config.runners.map((runner) => runner.id),
            [linked.id],
            "the linked computer and its key stay",
        );
        assert.equal(config.runnerByKey(linked.key)?.id, linked.id);
        runners.close();
    });
});
