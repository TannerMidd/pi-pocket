// How the launcher chooses its access mode, and what it does with one that is not ready, such as Tailscale while it is
// not connected.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
    type AccessChoice,
    type AccessMode,
    ACCESS_MODES,
    chooseAccess,
    findTailscale,
    isAccessMode,
    listenHost,
    serveBailOut,
    serveWithoutTailscale,
    staleServePorts,
} from "../src/launcher/access.ts";

/** A launch where only `ready` modes can be used. */
function launch(
    choice: Partial<AccessChoice> & { ready: AccessMode[]; picks?: (AccessMode | undefined)[] },
) {
    const tried: AccessMode[] = [];
    const picks = [...(choice.picks ?? [])];

    const result = chooseAccess({
        given: choice.given,
        saved: choice.saved,
        ask: choice.ask ?? false,
        menu: async () => {
            if (picks.length === 0) {
                throw new Error("the menu showed more often than the test expected");
            }

            return picks.shift();
        },
        prepare: async (mode) => {
            tried.push(mode);

            // Before 0.13.1, -y with a saved mode that was not ready tried it again forever.
            if (tried.length > 10) {
                throw new Error(`tried ${mode} over and over`);
            }

            return choice.ready.includes(mode)
                ? mode === "cloudflare"
                    ? "/bin/cloudflared"
                    : true
                : false;
        },
    });

    return { result };
}

test("-y with a saved mode that is not ready ends the start instead of trying it forever", async () => {
    for (const saved of ["tailscale", "tailscale-serve"] as const) {
        const run = launch({ saved, ask: false, ready: ["local", "lan"] });

        assert.equal(await run.result, "unready");
    }
});

test("a mode from the menu that is not ready goes back to the menu", async () => {
    const run = launch({
        saved: "tailscale",
        ask: true,
        ready: ["lan"],
        picks: ["tailscale", "lan"],
    });

    assert.deepEqual(await run.result, { mode: "lan" });
});

test("a ready mode starts, with the cloudflared to run for a tunnel", async () => {
    assert.deepEqual(await launch({ given: "cloudflare", ready: ["cloudflare"] }).result, {
        mode: "cloudflare",
        binary: "/bin/cloudflared",
    });
});

test("serve without tailscale stops the start when nobody is there to choose another mode", () => {
    const cases: { given?: AccessMode; saved?: AccessMode; ask: boolean; stops: boolean }[] = [
        { given: "tailscale-serve", ask: false, stops: true },
        { given: "tailscale-serve", ask: true, stops: true },
        { saved: "tailscale-serve", ask: false, stops: true },
        { saved: "tailscale-serve", ask: true, stops: false },
        { given: "lan", saved: "tailscale-serve", ask: false, stops: false },
        { given: undefined, saved: "local", ask: false, stops: false },
    ];

    for (const each of cases) {
        assert.equal(
            serveWithoutTailscale({ given: each.given, saved: each.saved, ask: each.ask }),
            each.stops,
            JSON.stringify(each),
        );
    }
});

test("--host starts where it is told even with a saved serve choice", () => {
    const cases: {
        access?: AccessMode;
        saved?: AccessMode;
        host?: string;
        ask: boolean;
        bails: boolean;
    }[] = [
        { access: "tailscale-serve", ask: false, bails: true },
        { saved: "tailscale-serve", ask: false, bails: true },
        { saved: "tailscale-serve", ask: true, bails: false },
        { saved: "local", ask: false, bails: false },
        { saved: "tailscale-serve", host: "0.0.0.0", ask: false, bails: false },
    ];

    for (const each of cases) {
        assert.equal(
            serveBailOut({
                access: each.access,
                saved: each.saved,
                host: each.host,
                ask: each.ask,
            }),
            each.bails,
            JSON.stringify(each),
        );
    }
});

test("findTailscale finds only a tailscale that is on PATH", (t) => {
    if (process.platform === "win32") {
        t.skip("an executable file needs the execute bit, which this platform does not have");

        return;
    }

    const empty = mkdtempSync(join(tmpdir(), "pi-pocket-empty-"));
    const installed = mkdtempSync(join(tmpdir(), "pi-pocket-tailscale-"));
    const original = process.env.PATH;

    try {
        const binary = join(installed, "tailscale");

        writeFileSync(binary, "#!/bin/sh\n", { mode: 0o755 });
        process.env.PATH = installed;
        assert.equal(findTailscale(), binary);

        process.env.PATH = empty;
        assert.equal(findTailscale(), undefined);
    } finally {
        if (original === undefined) {
            delete process.env.PATH;
        } else {
            process.env.PATH = original;
        }

        rmSync(empty, { recursive: true, force: true });
        rmSync(installed, { recursive: true, force: true });
    }
});

test("the serve mode is spelled the way systemd's unit and its guide spell it", () => {
    // contrib/systemd/pi-pocket@.service runs `--access %i`, and docs/systemd.md lists the instance names.
    assert.equal(isAccessMode("tailscale-serve"), true);
    assert.equal(isAccessMode("serve"), false);
    assert.deepEqual([...ACCESS_MODES].sort(), [
        "cloudflare",
        "lan",
        "local",
        "tailscale",
        "tailscale-serve",
    ]);
});

test("--host is where the server listens, whatever the access mode", () => {
    assert.equal(listenHost("lan", "127.0.0.2"), "127.0.0.2");
    assert.equal(listenHost("local", "::1"), "::1");
    assert.equal(listenHost("lan", undefined), "0.0.0.0");
    assert.equal(listenHost("custom", undefined), "127.0.0.1");
});

test("stale cleanup covers only a mount this launcher made, whatever port this run uses", () => {
    // A killed run on --port 9000 left its mount, and its receipt, pointing at 9000.
    assert.deepEqual(staleServePorts("local", 9000), [9000]);
    assert.deepEqual(staleServePorts("lan", 8787), [8787]);
    assert.deepEqual(staleServePorts("custom", 8787), [8787]);
    // No receipt: a mount at this run's port is the owner's own `tailscale serve`, as 0.27's docs suggested.
    assert.deepEqual(staleServePorts("local", undefined), []);
    // In serve mode, prepareServe() made or adopted the mount for this run's port: nothing is stale.
    assert.deepEqual(staleServePorts("tailscale-serve", 9000), []);
});
