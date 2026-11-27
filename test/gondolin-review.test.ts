// Fixes of the second review round, with a fake VM: stricter settings reach a VM that runs or starts, parallel
// background starts keep their records, ended tasks leave memory, and the owner's list follows the VMs.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
import { context, until } from "./helpers.ts";
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
async function openSheet(
    markup?: (strings: TemplateStringsArray, ...values: unknown[]) => unknown,
    answer?: object,
) {
    const listeners = new Map<string, Set<() => void>>();
    let host = 0;
    const effects: (() => (() => void) | undefined)[] = [];
    const states = new Map<number, unknown>();
    let slot = 0;
    const html =
        markup ?? ((strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }));
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
        launcher: () => ({ remove: () => {} }),
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

            return answer ?? { admin: true, session: { on: false } };
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

        if (typeof node !== "object" || node === null) {
            return undefined;
        }

        const parts = Array.isArray(node)
            ? node
            : [
                  ...((node as { values?: unknown[] } | null)?.values ?? []),
                  ...((node as { kids?: unknown[] } | null)?.kids ?? []),
                  (node as { fn?: unknown } | null)?.fn,
              ];

        for (const value of parts) {
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
        /** The owner's part of the sheet as text, with the host's answer and the confirm that is open. */
        render: async (input: {
            host: unknown;
            sure: string | null;
            flat: (node: unknown) => string;
        }) => {
            slot = 0;
            states.set(1, input.host);
            states.set(4, input.sure);
            effects.length = 0;

            return input.flat(Host());
        },
        /** One component of the sheet, drawn with the host's answer and the confirm that is open. */
        component: (name: string, hostAnswer: unknown, sure: string | null) => {
            slot = 0;
            states.clear();
            states.set(1, hostAnswer);
            states.set(4, sure);
            effects.length = 0;

            return find(sheet, name)!({ close: () => {} });
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

// ─── A VM that is replaced does not end a task that starts in the new one ───

test("a task that starts while the stricter rules replace the VM runs in the new VM, and the task in the old VM ends", async () => {
    const driver = new FakeDriver();
    const directory = temp();
    const current = { value: settings({ network: "open" }) };

    let ended: (rootId: number, reason: string) => void = () => {};

    const vms = new SandboxManager({
        driver,
        log: () => {},
        pidFile: join(directory, "vms.json"),
        settings: () => current.value,
        onEnded: (rootId, reason) => ended(rootId, reason),
    });
    const instance = new VmJobs({
        file: join(directory, "jobs.json"),
        spawn: (target, command, options) => vms.spawnShell(target, command, options),
        hold: (target) => vms.hold(target),
        limits: () => ({ running: 5, taskQuietMs: 0 }),
        log: () => {},
    });
    const target = { rootId: 9, cwd: directory, uploadDir: undefined };
    const api = instance.for({ ...target, own: true });

    ended = (rootId, reason) => instance.vmEnded(rootId, reason);

    try {
        assert.match(
            await api.start({ command: "echo old; tail -f /dev/null", key: "old" }),
            /Started vm-1/,
        );
        await until(async () => (await api.output("vm-1")).includes("old"), "the first task");

        // The rules get stricter; the next start replaces the VM, and its call is the one that ends the old one.
        current.value = settings({ network: "off" });
        driver.startDelay = 100;
        const started = await api.start({
            command: "echo fresh; tail -f /dev/null",
            key: "new",
        });

        assert.match(started, /Started vm-2/);
        assert.doesNotMatch(started, /since/);
        assert.equal(driver.log.started.length, 2);
        assert.equal(driver.log.closed.length, 1, "the old VM ended");
        await later(300);
        const list = await api.list();

        assert.match(list, /vm-1: ended/, "the task in the old VM ended with it");
        assert.match(list, /vm-2: running/, "the task in the new VM runs");
        assert.match(await api.output("vm-2"), /fresh/);

        // A task whose VM ends while it runs still ends.
        await vms.stop(9, "the test");
        await later(300);
        assert.match(await api.list(), /vm-2: ended/);
    } finally {
        await vms.stopAll("the test ended");
    }
});

test("a stop that comes while the process starts waits for it and then ends it, with nothing left running", async () => {
    const { api, started } = jobs({ spawnDelay: 80 });
    const first = api.start({ command: "wait", key: "slow" });

    await later(10);
    const stopped = await api.stop("vm-1");

    assert.match(await first, /Started vm-1/);
    assert.match(stopped, /Stopped vm-1/);
    assert.match(await api.list(), /vm-1: stopped/);
    assert.equal(started.length, 1);
});

// ─── The sheet shows the VM that lives, with its own size ───────────────────

test("a VM that has stopped shows the settings, not the rules and the size it had", async () => {
    const driver = new FakeDriver();
    const directory = temp();
    const current = {
        value: settings({
            network: "allowlist",
            allowedHosts: ["example.com", "b.test"],
            memoryMb: 2048,
            cpus: 2,
        }),
    };
    const vms = manager(driver, directory, current);
    const env = vms.envFor(4, { rootId: 4, cwd: directory, uploadDir: undefined });

    assert.ok((await env.exec("true", undefined, context)).ok);
    const alive = vms.state(4)!;

    assert.equal(alive.network, "allowlist");
    assert.deepEqual(alive.allowedHosts, ["example.com", "b.test"]);
    assert.equal(alive.memoryMb, 2048);
    assert.equal(alive.cpus, 2);

    // The size settings change: the VM that lives keeps its own size, and says so.
    current.value = settings({ ...current.value, memoryMb: 1024, cpus: 1 });
    assert.equal(vms.state(4)!.memoryMb, 2048);
    assert.equal(vms.state(4)!.cpus, 2);

    // Stricter rules end it: it shows the rules the settings give now.
    current.value = settings({
        ...current.value,
        network: "off",
        mount: "ro",
        allowedHosts: [],
    });
    assert.deepEqual(await vms.enforce(), [4]);
    const stopped = vms.state(4)!;

    assert.equal(stopped.phase, "stopped");
    assert.equal(stopped.network, "off");
    assert.equal(stopped.mount, "ro");
    assert.deepEqual(stopped.allowedHosts, []);
    assert.equal(stopped.memoryMb, 1024);
    assert.equal(stopped.cpus, 1);
    assert.equal(stopped.stale, false);
    await vms.stopAll("the test ended");
});

// ─── The words of the sheet, as the app's htm makes them ────────────────────

test("the sheet's text keeps its spaces and lays each VM out as a title, a folder, and a state", async () => {
    const { default: htm } = (await import("htm")) as unknown as {
        default: { bind: (h: never) => unknown };
    };
    const flat = (node: unknown): string =>
        Array.isArray(node)
            ? node.map(flat).join("")
            : typeof node === "object" && node !== null
              ? `${(node as { open: string }).open}${flat((node as { kids: unknown }).kids)}${(node as { close: string }).close}`
              : node === null || node === undefined || node === false
                ? ""
                : String(node);
    const h = (type: unknown, props: Record<string, unknown> | null, ...kids: unknown[]) =>
        typeof type === "function"
            ? { open: "", kids: [], close: "", fn: type }
            : { open: `<${String(type)}>`, kids, close: `</${String(type)}>`, props };
    const html = htm.bind(h as never) as (...args: unknown[]) => unknown;
    const sheet = await openSheet(html as never);
    const text = await sheet.render({
        sure: "browser",
        host: {
            check: { lines: [] },
            running: 0,
            max: 3,
            vms: [
                { rootId: 3, title: "Fix the build", cwd: "/tmp/gdl/w1", busy: 1 },
                { rootId: 13, title: "", cwd: "/tmp/gdl/w2", busy: 0 },
            ],
            setup: { running: false, lines: [], error: null, done: false },
            estimate: {
                plain: { download: "about 110 MB", disk: "about 330 MB", time: "a minute or two" },
                browser: {
                    download: "about 250 MB",
                    disk: "about 1.2 GB",
                    time: "two to five minutes",
                },
            },
        },
        flat,
    });

    assert.match(text, /0 of 3 VMs running\./);
    assert.match(
        text,
        /folder "gondolin" of the data folder, downloads the standard image, and builds an image with Chromium on this machine: about 250 MB, about 1\.2 GB on disk, two to five minutes\./,
    );
    // Each VM: the title (or the id when there is none), the folder, and the state, as parts.
    assert.match(
        text,
        /<strong>Fix the build<\/strong><span>\/tmp\/gdl\/w1<\/span><span>Working<\/span>/,
    );
    assert.match(
        text,
        /<strong>Session 13<\/strong><span>\/tmp\/gdl\/w2<\/span><span>Idle<\/span>/,
    );

    // Off Linux no Set up is offered.
    const unsupported = await sheet.render({
        sure: "browser",
        host: {
            check: {
                lines: [
                    {
                        name: "Operating system",
                        ok: false,
                        detail: "The sandbox runs on Linux only for now.",
                    },
                ],
            },
            supported: false,
            running: 0,
            max: 3,
            vms: [],
            setup: { running: false, lines: [], error: null, done: false },
            estimate: { plain: {}, browser: {} },
        },
        flat,
    });

    assert.match(unsupported, /The sandbox runs on Linux only for now\./);
    assert.doesNotMatch(unsupported, /Set up/);
});

// ─── Guard: running text of the sheet keeps its spaces ──────────────────────

/** The `html` templates of a source, each with its expressions replaced by NUL (nested ones as templates too). */
function htmlTemplates(source: string): string[] {
    const found: string[] = [];
    const open = (from: number) => source.slice(from).search(/(?<![`\w])html`/);
    let at = open(0) === -1 ? -1 : open(0);

    while (at !== -1) {
        let index = at + 5;
        let text = "";

        while (index < source.length && source[index] !== "`") {
            if (source[index] === "\\") {
                text += source.slice(index, index + 2);
                index += 2;
            } else if (source.startsWith("${", index)) {
                let depth = 1;
                const start = index + 2;

                index = start;

                while (index < source.length && depth > 0) {
                    if (source[index] === "{") {
                        depth++;
                    } else if (source[index] === "}") {
                        depth--;
                    } else if (source[index] === "`") {
                        // a template inside the expression: skip it as a whole, and check it by itself
                        index++;

                        while (index < source.length && source[index] !== "`") {
                            index += source[index] === "\\" ? 2 : 1;
                        }
                    }

                    index++;
                }

                found.push(...htmlTemplates(source.slice(start, index - 1)));
                text += "\0";
            } else {
                text += source[index++];
            }
        }

        found.push(text);
        const again = open(index + 1);

        at = again === -1 ? -1 : index + 1 + again;
    }

    return found;
}

const INLINE = /^<(span|b|strong|code|a|em|i|kbd|small)[\s>]/;

test("the sheet's source has no running text that a line break could split from its neighbours", () => {
    const source = readFileSync(
        new URL("../src/server/extensions/gondolin/index.js", import.meta.url),
        "utf8",
    );
    const flagged: string[] = [];

    for (const template of htmlTemplates(source)) {
        const lines = template
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line !== "");
        const isText = (line: string | undefined) =>
            line !== undefined && /^[^<>=\0{}$]+$/.test(line) && /[A-Za-z]/.test(line);

        lines.forEach((line, row) => {
            if (!isText(line)) {
                return;
            }

            const next = lines[row + 1];
            const before = lines[row - 1];

            if (
                isText(next) ||
                next?.startsWith("\0") === true ||
                (next !== undefined && INLINE.test(next)) ||
                (before !== undefined && (isText(before) || before.endsWith("\0")))
            ) {
                flagged.push(`${line} (next: ${next ?? "-"})`);
            }
        });
    }

    assert.deepEqual(flagged, [], "running text across lines: use one string");
});

test("each state of the sheet renders with no two words run together", async () => {
    const { default: htm } = (await import("htm")) as unknown as {
        default: { bind: (h: never) => unknown };
    };

    type Node = { tag: string; kids: unknown[] } | string | number | boolean | null | undefined;
    const h = (type: unknown, _props: unknown, ...kids: unknown[]) =>
        typeof type === "function"
            ? { tag: "component", kids: [], fn: type }
            : { tag: String(type), kids };
    const html = htm.bind(h as never) as (...args: unknown[]) => unknown;
    const problems: string[] = [];
    const wordEnd = /[A-Za-z0-9,.:;)'"]$/;
    const wordStart = /^[A-Za-z0-9(]/;

    const check = (node: unknown, where: string): void => {
        if (Array.isArray(node)) {
            node.forEach((each) => check(each, where));

            return;
        }

        if (typeof node !== "object" || node === null) {
            return;
        }

        const kids = (node as { kids: unknown[] }).kids.flat(Infinity) as Node[];

        kids.forEach((kid, index) => {
            const next = kids[index + 1];
            const texty = (value: Node) => typeof value === "string" || typeof value === "number";

            if (texty(kid) && String(kid).trim() !== "") {
                const a = String(kid);

                // text, then text from an expression, with nothing between: "GB" and "on disk"
                if (texty(next) && wordEnd.test(a) && wordStart.test(String(next))) {
                    problems.push(
                        `${where}: "${a.slice(-20)}" runs into "${String(next).slice(0, 20)}"`,
                    );
                }

                // text, then an inline element at once: "folder's" and <span>
                if (
                    typeof next === "object" &&
                    next !== null &&
                    ["span", "b", "strong", "code"].includes(next.tag) &&
                    /[A-Za-z0-9,:']$/.test(a)
                ) {
                    problems.push(`${where}: "${a.slice(-20)}" runs into <${next.tag}>`);
                }
            }

            if (
                typeof kid === "object" &&
                kid !== null &&
                ["span", "b", "strong", "code"].includes(kid.tag) &&
                texty(next) &&
                wordStart.test(String(next))
            ) {
                problems.push(`${where}: <${kid.tag}> runs into "${String(next).slice(0, 20)}"`);
            }

            check(kid, where);
        });
    };

    const estimate = {
        plain: { download: "about 110 MB", disk: "about 330 MB", time: "a minute or two" },
        browser: { download: "about 250 MB", disk: "about 1.2 GB", time: "two to five minutes" },
    };
    const host = (over: object = {}) => ({
        check: {
            lines: [
                { name: "Node.js", ok: true, detail: "26 (needs 22)" },
                { name: "QEMU", ok: false, optional: true, detail: "Not installed." },
                { name: "Image", ok: false, detail: "Tap Set up." },
            ],
        },
        running: 1,
        max: 3,
        vms: [
            { rootId: 3, title: "A title", cwd: "/work/a", busy: 1 },
            { rootId: 4, title: "", cwd: "/work/b", busy: 0 },
        ],
        setup: { running: false, lines: ["one", "two"], error: null, done: true },
        estimate,
        ...over,
    });
    const session = (over: object = {}) => ({
        admin: true,
        mayChoose: true,
        problem: null,
        ready: true,
        session: { on: true, by: "owner", at: 1 },
        settings: {
            network: "allowlist",
            allowedHosts: ["a.test", "b.test"],
            mount: "rw",
            cpus: 2,
            memoryMb: 2048,
            hostTools: "block",
        },
        where: [{ what: "bash", where: "sandbox", note: "Runs in the VM." }],
        vm: null,
        ...over,
    });
    const vm = (over: object = {}) => ({
        phase: "running",
        cwd: "/work/a",
        mount: "rw",
        network: "allowlist",
        allowedHosts: ["a.test", "b.test"],
        cpus: 2,
        memoryMb: 2048,
        stale: false,
        busy: 0,
        ...over,
    });
    const states: {
        name: string;
        component: string;
        state: object;
        host?: object;
        sure?: string | null;
    }[] = [
        { name: "switch on", component: "Switcher", state: session() },
        { name: "switch off", component: "Switcher", state: session({ session: { on: false } }) },
        { name: "switch refused", component: "Switcher", state: session({ mayChoose: false }) },
        { name: "vm none", component: "Vm", state: session() },
        { name: "vm running", component: "Vm", state: session({ vm: vm() }) },
        {
            name: "vm stale",
            component: "Vm",
            state: session({ vm: vm({ stale: true, mount: "ro" }) }),
        },
        {
            name: "vm off",
            component: "Vm",
            state: session({ vm: vm({ network: "off", note: "Stopped." }) }),
        },
        { name: "vm open", component: "Vm", state: session({ vm: vm({ network: "open" }) }) },
        { name: "where", component: "Where", state: session() },
        { name: "host", component: "Host", state: session(), host: host() },
        { name: "host plain", component: "Host", state: session(), host: host(), sure: "plain" },
        {
            name: "host browser",
            component: "Host",
            state: session(),
            host: host(),
            sure: "browser",
        },
        { name: "host remove", component: "Host", state: session(), host: host(), sure: "remove" },
        {
            name: "host running",
            component: "Host",
            state: session(),
            host: host({
                vms: [],
                setup: { running: true, lines: ["x"], error: null, done: false },
            }),
        },
        {
            name: "host error",
            component: "Host",
            state: session(),
            host: host({ setup: { running: false, lines: [], error: "It failed.", done: false } }),
        },
    ];

    for (const each of states) {
        const sheet = await openSheet(html as never, each.state);

        check(sheet.component(each.component, each.host, each.sure ?? null), each.name);
    }

    assert.deepEqual(problems, []);
});
