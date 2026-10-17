// How the launcher chooses its access mode, and what it does with one that is not ready, such as Tailscale while it is
// not connected.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type AccessChoice, type AccessMode, chooseAccess } from "../src/launcher/access.ts";

/** A launch where only `ready` modes can be used; it records what was tried and how often the menu showed. */
function launch(
    choice: Partial<AccessChoice> & { ready: AccessMode[]; picks?: (AccessMode | undefined)[] },
) {
    const tried: AccessMode[] = [];
    const picks = [...(choice.picks ?? [])];
    let menus = 0;

    const result = chooseAccess({
        given: choice.given,
        saved: choice.saved,
        ask: choice.ask ?? false,
        menu: async () => {
            menus++;

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

    return { result, tried, menus: () => menus };
}

test("-y with a saved mode that is not ready ends the start instead of trying it forever", async () => {
    for (const saved of ["tailscale", "cloudflare"] as const) {
        const run = launch({ saved, ask: false, ready: ["local", "lan"] });

        assert.equal(await run.result, "unready");
        assert.deepEqual(run.tried, [saved]);
        assert.equal(run.menus(), 0);
    }
});

test("--access with a mode that is not ready ends the start, even in a terminal", async () => {
    const run = launch({ given: "tailscale", saved: "local", ask: true, ready: ["local"] });

    assert.equal(await run.result, "unready");
    assert.deepEqual(run.tried, ["tailscale"]);
    assert.equal(run.menus(), 0);
});

test("a mode from the menu that is not ready goes back to the menu", async () => {
    const run = launch({
        saved: "tailscale",
        ask: true,
        ready: ["lan"],
        picks: ["tailscale", "lan"],
    });

    assert.deepEqual(await run.result, { mode: "lan" });
    assert.deepEqual(run.tried, ["tailscale", "lan"]);
    assert.equal(run.menus(), 2);
});

test("closing the menu ends the start", async () => {
    const run = launch({ ask: true, ready: ["local"], picks: [undefined] });

    assert.equal(await run.result, "closed");
    assert.deepEqual(run.tried, []);
});

test("a ready mode starts, with the cloudflared to run for a tunnel", async () => {
    assert.deepEqual(await launch({ saved: "tailscale", ready: ["tailscale"] }).result, {
        mode: "tailscale",
    });
    assert.deepEqual(await launch({ given: "cloudflare", ready: ["cloudflare"] }).result, {
        mode: "cloudflare",
        binary: "/bin/cloudflared",
    });
    assert.deepEqual(await launch({ ready: ["local"] }).result, { mode: "local" });
});
