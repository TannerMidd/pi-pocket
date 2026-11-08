// Whether sessions work on the computer, for a program that runs the runner (`src/runner/activity.ts`): the smoothing
// on its own with a clock of its own, then a real runner with the server's `Runners` and the real pi-env daemon.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Activity, activityLine, type ActivityState } from "../src/runner/activity.ts";
import { realFolder } from "../src/runner/folders.ts";
import { Runner, type RunnerSettings } from "../src/runner/runner.ts";
import { ConfigStore } from "../src/server/config.ts";
import { Runners } from "../src/server/runners.ts";

const root = mkdtempSync(join(tmpdir(), "pi-pocket-activity-test-"));

after(() => rmSync(root, { recursive: true, force: true }));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check: () => boolean, what: string, ms = 10_000): Promise<void> {
    const end = Date.now() + ms;

    while (!check()) {
        if (Date.now() > end) {
            throw new Error(`Timed out waiting for ${what}`);
        }

        await sleep(10);
    }
}

describe("activity smoothing", () => {
    /** An `Activity` with short timings, and what it reported. */
    function watch(riseMs = 60, holdMs = 150) {
        const seen: ActivityState[] = [];
        const activity = new Activity((state) => seen.push(state), { riseMs, holdMs });

        return { activity, seen };
    }

    it("never shows a quick request", async () => {
        const { activity, seen } = watch();
        const end = activity.begin("/a");

        await sleep(20);
        end();
        await sleep(250);
        assert.deepEqual(seen, []);
        activity.stop();
    });

    it("shows work that lasts, holds it after, and says each change once", async () => {
        const { activity, seen } = watch();
        const end = activity.begin("/a");

        await sleep(100);
        assert.deepEqual(seen, [{ working: true, folders: ["/a"] }]);

        // Another folder, then the first one ends: still working, in the second only after the hold.
        const other = activity.begin("/b");

        await sleep(100);
        assert.deepEqual(seen.at(-1), { working: true, folders: ["/a", "/b"] });
        end();
        await sleep(40);
        assert.deepEqual(seen.at(-1), { working: true, folders: ["/a", "/b"] }, "held");
        await sleep(200);
        assert.deepEqual(seen.at(-1), { working: true, folders: ["/b"] });

        other();
        await sleep(250);
        assert.deepEqual(seen.at(-1), { working: false, folders: [] });
        assert.equal(seen.length, 4);
        activity.stop();
    });

    it("counts requests one after another, within the hold, as one stretch of work", async () => {
        const { activity, seen } = watch();

        activity.begin("/a")();
        await sleep(30);
        activity.begin("/a")();
        await sleep(30);

        // Work that lasts after quick ones: it shows once it lasted, and the next quick ones keep it.
        const long = activity.begin("/a");

        await sleep(100);
        long();

        for (let each = 0; each < 3; each++) {
            await sleep(60);
            activity.begin("/a")();
        }

        assert.deepEqual(seen, [{ working: true, folders: ["/a"] }], "no flicker");
        await sleep(250);
        assert.deepEqual(seen.at(-1), { working: false, folders: [] });
        activity.stop();
    });

    it("says idle at once when stopped, and nothing after", async () => {
        const { activity, seen } = watch();

        activity.begin("/a");
        await sleep(100);
        activity.stop();
        assert.deepEqual(seen.at(-1), { working: false, folders: [] });

        const count = seen.length;

        activity.begin("/b");
        await sleep(150);
        assert.equal(seen.length, count);
    });

    it("writes one line for a program", () => {
        assert.equal(
            activityLine({ working: true, folders: ["/a b"] }),
            'PI-POCKET-ACTIVITY {"working":true,"folders":["/a b"]}',
        );
    });
});

describe("a runner's activity", () => {
    it("reports a session's command in its folder, not folder listings, and idle when it stops", async () => {
        const config = new ConfigStore(mkdtempSync(join(root, "data-")));
        const runners = new Runners({ config, log: () => {} });
        const server: Server = createServer((_request, response) => response.writeHead(404).end());

        server.on("upgrade", (request, socket, head) => {
            if (!runners.upgrade(request, socket, head)) {
                socket.destroy();
            }
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

        const { port } = server.address() as AddressInfo;
        const { code } = runners.makeCode(`Computer ${randomUUID().slice(0, 6)}`, "owner");
        const linked = runners.redeem(code);
        const work = join(root, "project");

        mkdirSync(work);

        const real = await realFolder(work);
        const seen: ActivityState[] = [];
        const last = (): ActivityState | undefined => seen.at(-1);
        const settings: RunnerSettings = {};
        const runner = new Runner({
            link: { server: `http://127.0.0.1:${port}`, ...linked },
            version: "test",
            cwd: root,
            log: () => {},
            retryMs: [50, 100, 200],
            settings: () => settings,
            saveSettings: (change) => {
                Object.assign(settings, change);
            },
            ask: () => Promise.resolve({ allow: true }),
            activity: (state) => seen.push(state),
            activityTiming: { riseMs: 100, holdMs: 300 },
        });

        try {
            runner.start();
            await until(() => runner.connected, "the runner to connect");

            const link = runners.link(linked.id);

            await link.confirm({ kind: "new", person: "Owner", folder: work, session: "s" });

            // The folder picker lists folders without a session: no work.
            await runners.folders(linked.id, work, false);
            await sleep(400);
            assert.equal(seen.length, 0, "a listing is not work");

            const env = runners.env(linked.id, work, { id: "s", folder: work, person: "Owner" });
            const running = env.exec("sleep 0.6; echo done", {}, context);

            await until(() => last()?.working === true, "the command to show");
            assert.deepEqual(last(), { working: true, folders: [real] });
            assert.ok((await running).ok);
            await until(() => last()?.working === false, "idle after the hold");
            assert.deepEqual(last(), { working: false, folders: [] });

            // A command that runs when the runner stops: idle at once.
            void env.exec("sleep 5", {}, context).catch(() => {});
            await until(() => last()?.working === true, "the second command to show");
            await runner.stop();
            assert.deepEqual(last(), { working: false, folders: [] });
        } finally {
            await runner.stop();
            runners.close();
            server.closeAllConnections();
            await new Promise((resolve) => server.close(resolve));
        }
    });
});
