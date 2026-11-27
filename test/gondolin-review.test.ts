// Fixes of the second review round, with a fake VM: stricter settings reach a VM that runs or starts, parallel
// background starts keep their records, ended tasks leave memory, and the owner's list follows the VMs.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type {
    GuestChunk,
    GuestExecOptions,
    GuestProcess,
    VmSpec,
} from "../src/server/extensions/gondolin/guest.ts";
import { VmJobs, type JobTarget } from "../src/server/extensions/gondolin/jobs.ts";
import { SandboxManager, type SandboxSettings } from "../src/server/extensions/gondolin/manager.ts";
import { context } from "./helpers.ts";
import { FakeDriver } from "./gondolin-fake.ts";

const roots: string[] = [];

const temp = () => {
    const path = mkdtempSync(join(tmpdir(), "gondolin-review-"));

    roots.push(path);

    return path;
};

after(() => {
    for (const path of roots) {
        rmSync(path, { recursive: true, force: true });
    }
});

const later = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function settings(over: Partial<SandboxSettings> = {}): SandboxSettings {
    return {
        backend: "auto",
        mount: "rw",
        network: "open",
        allowedHosts: [],
        cpus: 1,
        memoryMb: 512,
        diskMb: 1024,
        idleMinutes: 30,
        maxVms: 2,
        image: "alpine-base:latest",
        ...over,
    };
}

function manager(driver: FakeDriver, directory: string, current: { value: SandboxSettings }) {
    return new SandboxManager({
        driver,
        log: () => {},
        pidFile: join(directory, "vms.json"),
        settings: () => current.value,
    });
}

// ─── Stricter settings reach a VM before any call uses it ───────────────────

test("a VM made with looser rules is not used again once the settings are stricter, even before enforce runs", async () => {
    const driver = new FakeDriver();
    const directory = temp();
    const current = { value: settings({ network: "open" }) };
    const vms = manager(driver, directory, current);
    const env = vms.envFor(1, { rootId: 1, cwd: directory, uploadDir: undefined });

    assert.ok((await env.exec("true", undefined, context)).ok);
    assert.equal(driver.log.started[0]!.network.mode, "open");

    const steps: [Partial<SandboxSettings>, (spec: VmSpec) => boolean][] = [
        [
            { network: "allowlist", allowedHosts: ["example.com", "b.test"] },
            (spec) => spec.network.mode === "allowlist" && spec.network.allowedHosts.length === 2,
        ],
        [
            { allowedHosts: ["example.com"] },
            (spec) => spec.network.allowedHosts.join() === "example.com",
        ],
        [{ network: "off" }, (spec) => spec.network.mode === "off"],
        [{ mount: "ro" }, (spec) => spec.mount === "ro"],
    ];

    for (const [change, check] of steps) {
        const before = driver.log.started.length;

        // The settings changed; nothing called `enforce`.
        current.value = settings({ ...current.value, ...change });
        assert.ok((await env.exec("true", undefined, context)).ok);
        assert.equal(driver.log.started.length, before + 1, JSON.stringify(change));
        assert.equal(driver.log.closed.length, before, "the old VM ended");
        assert.ok(check(driver.log.started.at(-1)!), JSON.stringify(change));
    }

    // Looser settings change nothing until the VM starts again.
    const before = driver.log.started.length;

    current.value = settings({ network: "open", mount: "rw" });
    assert.ok((await env.exec("true", undefined, context)).ok);
    assert.equal(driver.log.started.length, before);
    assert.equal(vms.state(1)?.stale, true);
    await vms.stopAll("the test ended");
});

test("settings that get stricter while a VM starts do not leave it running with the old rules", async () => {
    const driver = new FakeDriver();
    const directory = temp();
    const current = { value: settings({ network: "open" }) };
    const vms = manager(driver, directory, current);
    const env = vms.envFor(2, { rootId: 2, cwd: directory, uploadDir: undefined });

    driver.startDelay = 150;
    const call = env.exec("true", undefined, context);

    await later(50);
    current.value = settings({ network: "off" });
    await vms.enforce();
    assert.ok((await call).ok);
    assert.equal(driver.log.started.length, 2, "a second VM started with the new rules");
    assert.equal(driver.log.started[1]!.network.mode, "off");
    assert.equal(driver.log.closed.length, 1, "the first one ended");
    assert.equal(vms.state(2)?.network, "off");
    assert.equal(vms.running, 1);
    await vms.stopAll("the test ended");
});

// ─── Background tasks ───────────────────────────────────────────────────────

/** A process that the test ends, and may feed output. */
function fakeProcess(options: GuestExecOptions) {
    const queue: GuestChunk[] = [];
    let wake: (() => void) | undefined;
    let closed = false;
    let finish!: (value: { exitCode: number }) => void;
    const result = new Promise<{ exitCode: number }>((resolve) => {
        finish = resolve;
    });

    const end = (exitCode: number) => {
        closed = true;
        wake?.();
        finish({ exitCode });
    };

    options.signal?.addEventListener("abort", () => end(143), { once: true });

    const process_: GuestProcess = {
        output: () => ({
            async *[Symbol.asyncIterator]() {
                while (true) {
                    const chunk = queue.shift();

                    if (chunk !== undefined) {
                        yield chunk;
                    } else if (closed) {
                        return;
                    } else {
                        await new Promise<void>((resolve) => {
                            wake = resolve;
                        });
                    }
                }
            },
        }),
        result,
        write: () => {},
        end: () => {},
    };

    return {
        process_,
        end,
        print: (text: string) => {
            queue.push({ stream: "stdout", data: new TextEncoder().encode(text) });
            wake?.();
        },
    };
}

function jobs(
    over: { running?: number; spawnDelay?: number; fail?: () => boolean; now?: () => number } = {},
) {
    const started: ReturnType<typeof fakeProcess>[] = [];
    let held = 0;
    let released = 0;
    const instance = new VmJobs({
        file: join(temp(), "jobs.json"),
        spawn: async (_target, _command, options) => {
            await later(over.spawnDelay ?? 20);

            if (over.fail?.() === true) {
                throw new Error("the VM would not start");
            }

            const one = fakeProcess(options);

            started.push(one);

            return one.process_;
        },
        hold: () => {
            held++;

            return () => {
                released++;
            };
        },
        limits: () => ({ running: over.running ?? 5, taskQuietMs: 0 }),
        log: () => {},
        ...(over.now === undefined ? {} : { now: over.now }),
    });
    const target: JobTarget = { rootId: 7, cwd: "/work", uploadDir: undefined, own: true };

    return { api: instance.for(target), started, counts: () => ({ held, released }) };
}

test("background tasks that start at the same time each keep a record, an ID, and a process", async () => {
    const { api, started } = jobs();
    const answers = await Promise.all(
        ["a", "b", "c"].map((key) => api.start({ command: `wait ${key}`, key })),
    );

    assert.deepEqual(
        answers.map((text) => /Started (vm-\d+)/.exec(text)?.[1]),
        ["vm-1", "vm-2", "vm-3"],
    );
    assert.equal(started.length, 3);
    const list = await api.list();

    for (const id of ["vm-1", "vm-2", "vm-3"]) {
        assert.match(list, new RegExp(`${id}: running`));
        assert.match(await api.output(id), new RegExp(`${id}: running`));
    }

    // Stopping one by ID ends its own process, not another.
    assert.match(await api.stop("vm-2"), /Stopped vm-2/);
    assert.match(await api.list(), /vm-1: running/);
    assert.match(await api.list(), /vm-2: stopped/);

    for (const each of started) {
        each.end(0);
    }
});

test("the same key at the same time starts one task", async () => {
    const { api, started } = jobs();
    const [first, second] = await Promise.all([
        api.start({ command: "wait 1", key: "same" }),
        api.start({ command: "wait 1", key: "same" }),
    ]);

    assert.match(first, /Started vm-1/);
    assert.match(second, /Started vm-1/);
    assert.equal(started.length, 1);
    started[0]!.end(0);
});

test("the running-task limit holds when starts happen at the same time", async () => {
    const { api, started } = jobs({ running: 2 });
    const results = await Promise.allSettled(
        ["a", "b", "c", "d"].map((key) => api.start({ command: "wait 9", key })),
    );

    assert.equal(results.filter((each) => each.status === "fulfilled").length, 2);
    assert.equal(results.filter((each) => each.status === "rejected").length, 2);
    assert.equal(started.length, 2, "no third process");

    for (const each of started) {
        each.end(0);
    }
});

test("a task whose process cannot start leaves no record and gives its ID and room back", async () => {
    let fail = true;
    const { api, started, counts } = jobs({ running: 1, fail: () => fail });

    await assert.rejects(api.start({ command: "x", key: "k" }), /would not start/);
    assert.equal(await api.list(), "No background tasks in this session.");
    assert.deepEqual(counts(), { held: 1, released: 1 });
    fail = false;
    assert.match(await api.start({ command: "x", key: "k" }), /Started vm-1/);
    started[0]!.end(0);
    await later(10);

    // A start that waited for the same key learns that it failed.
    fail = true;
    const both = await Promise.allSettled([
        api.start({ command: "y", key: "j" }),
        api.start({ command: "y", key: "j" }),
    ]);

    assert.deepEqual(
        both.map((each) => each.status),
        ["rejected", "rejected"],
    );
});

test("ended tasks leave the live list after the limit and after their time", async () => {
    let now = 1_000_000;
    const { api, started } = jobs({ spawnDelay: 0, now: () => now });

    for (let index = 0; index < 45; index++) {
        const text = await api.start({ command: `echo ${index}`, key: `k${index}` });

        assert.match(text, /Started vm-/);
        started[index]!.print(`out ${index}`);
        started[index]!.end(0);
        await later(5);
        now += 1000;
    }

    await later(20);
    const lines = (await api.list()).split("\n");

    assert.equal(lines.length, 40, "the 40 newest ended tasks stay");
    assert.match(lines.at(-1)!, /vm-45/);
    assert.match(await api.output("vm-1"), /There is no background task/);
    assert.match(await api.output("vm-45"), /out 44/);

    // After a week and one more task, the old ones are gone from the live list too.
    now += 8 * 24 * 60 * 60 * 1000;
    await api.start({ command: "echo last", key: "last" });
    started.at(-1)!.end(0);
    await later(20);
    assert.equal((await api.list()).split("\n").length, 1);
});

test("an ended task keeps only the end of its output", async () => {
    const { api, started } = jobs({ spawnDelay: 0 });

    await api.start({ command: "big", key: "big" });
    started[0]!.print("a".repeat(60_000));
    started[0]!.print("END");
    started[0]!.end(0);
    await later(30);
    const text = await api.output("vm-1");

    assert.ok(text.length < 21_000, String(text.length));
    assert.match(text, /END$/);
});

// ─── The owner's list of VMs follows them ───────────────────────────────────

test("the manager says when a VM goes from idle to working and back", async () => {
    const driver = new FakeDriver();
    const directory = temp();
    const seen: number[] = [];
    const vms = new SandboxManager({
        driver,
        log: () => {},
        pidFile: join(directory, "vms.json"),
        settings: () => settings(),
        onActivity: (rootId) => seen.push(rootId),
    });
    const target = { rootId: 3, cwd: directory, uploadDir: undefined };
    const release = vms.hold(target);
    const again = vms.hold(target);

    assert.deepEqual(seen, [3], "the first holder only");
    again();
    assert.deepEqual(seen, [3]);
    release();
    assert.deepEqual(seen, [3, 3], "the last one letting go");
    await vms.stopAll("the test ended");
});

/** The sheet's browser module, with a `pocket` that records what it listens to. */
async function openSheet() {
    const listeners = new Map<string, Set<() => void>>();
    let host = 0;
    const effects: (() => (() => void) | undefined)[] = [];
    const states = new Map<number, unknown>();
    let slot = 0;
    const html = (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values });
    const pocket = {
        html,
        useEffect: (effect: () => (() => void) | undefined) => effects.push(effect),
        useState: (initial: unknown) => {
            const index = slot++;

            if (!states.has(index)) {
                states.set(index, initial);
            }

            return [states.get(index), (value: unknown) => states.set(index, value)];
        },
        useCallback: (callback: unknown) => callback,
        style: () => {},
        status: () => ({ update: () => {}, remove: () => {} }),
        menu: () => ({ remove: () => {} }),
        Loader: () => null,
        on: (name: string, listener: () => void) => {
            const set = listeners.get(name) ?? new Set();

            listeners.set(name, set);
            set.add(listener);

            return () => set.delete(listener);
        },
        api: async (path: string) => {
            if (path.startsWith("host")) {
                host++;

                return {
                    check: { lines: [] },
                    running: 0,
                    max: 2,
                    vms: [],
                    setup: { running: false, lines: [], error: null },
                };
            }

            return { admin: true, session: { on: false } };
        },
        sheet: (spec: { component: (props: object) => unknown }) => {
            sheets.push(spec.component);
        },
        onConversation: (callback: (id: number) => void) => {
            conversation = callback;
        },
    };
    const sheets: ((props: object) => unknown)[] = [];
    let conversation: ((id: number) => void) | undefined;
    const module = "../src/server/extensions/gondolin/index.js";
    const { default: setup } = (await import(module)) as { default: (pocket: unknown) => void };

    setup(pocket);
    conversation!(5);
    await later(20);

    const find = (node: unknown, name: string): ((...args: unknown[]) => unknown) | undefined => {
        if (typeof node === "function" && node.name === name) {
            return node as never;
        }

        for (const value of (node as { values?: unknown[] } | null)?.values ?? []) {
            const found = find(value, name);

            if (found !== undefined) {
                return found;
            }
        }

        return undefined;
    };

    const sheet = sheets[0]!({ close: () => {} });
    const Host = find(sheet, "Host")!;

    return {
        mount: () => {
            slot = 0;
            effects.length = 0;
            Host();
            const cleanups = effects.map((effect) => effect());

            return () => cleanups.forEach((cleanup) => cleanup?.());
        },
        fire: (name: string) => listeners.get(name)?.forEach((listener) => listener()),
        hostReads: () => host,
        names: () => [...listeners.keys()],
    };
}

test("the owner's list of running sandboxes is read again when VMs change, not only after set-up", async () => {
    const sheet = await openSheet();
    const unmount = sheet.mount();

    await later(20);
    const first = sheet.hostReads();

    assert.ok(first >= 1);
    sheet.fire("changed");
    sheet.fire("changed");
    sheet.fire("vms");
    await later(300);
    assert.equal(sheet.hostReads(), first + 1, "events that come together make one read");
    sheet.fire("setup");
    await later(20);
    assert.equal(sheet.hostReads(), first + 2);
    unmount();
});
