// The real Gondolin driver with a real VM, for git, worktrees, skills, a killed runner, background tasks, and linked
// sessions. It runs only when `PI_POCKET_GONDOLIN_REAL` names a folder that has the Gondolin package and the images that
// Set up builds (`pocket-base:latest` with git, and `pocket-browser:latest` for the dev-server test), and the host can run a
// VM. Otherwise every test here is skipped.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test, type TestContext } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Browsers } from "../src/server/browser.ts";
import type { HostCheck } from "../src/server/extensions/gondolin/guest.ts";
import { VmJobs } from "../src/server/extensions/gondolin/jobs.ts";
import { SandboxManager, type VmTarget } from "../src/server/extensions/gondolin/manager.ts";
import { GondolinDriver } from "../src/server/extensions/gondolin/real-driver.ts";
import {
    context,
    modelTexts,
    newSession,
    openApp,
    owner,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";

const dir = process.env.PI_POCKET_GONDOLIN_REAL;
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "gondolin-real-parity-")));
const SEAM = Symbol.for("pi-pocket.gondolin.test-driver");
let driver: GondolinDriver | undefined;
let manager: SandboxManager | undefined;
let check: HostCheck | undefined;

const settings =
    (image: string, over: Record<string, unknown> = {}) =>
    () => ({
        backend: "auto" as const,
        mount: "rw" as const,
        network: "allowlist" as const,
        allowedHosts: ["example.com"],
        cpus: 1,
        memoryMb: 768,
        diskMb: 2048,
        idleMinutes: 0,
        maxVms: 8,
        image,
        ...over,
    });

before(async () => {
    if (dir === undefined) {
        return;
    }

    driver = new GondolinDriver(dir);
    check = await driver.check({ backend: "auto", image: "alpine-base:latest" });

    if (check.ok) {
        manager = new SandboxManager({
            driver,
            log: () => {},
            pidFile: join(scratch, "vms.json"),
            settings: settings("alpine-base:latest"),
        });
    }
});

after(async () => {
    await manager?.stopAll("the test ended");
    rmSync(scratch, { recursive: true, force: true });
});

function unavailable(t: TestContext, image = "pocket-base:latest"): boolean {
    const why =
        dir === undefined
            ? "PI_POCKET_GONDOLIN_REAL is not set"
            : check?.ok !== true
              ? "this host cannot run a VM"
              : !check.images.some((each) => each.name === image)
                ? `the image ${image} is not in the store`
                : undefined;

    if (why !== undefined) {
        t.skip(why);
    }

    return why !== undefined;
}

const author = {
    GIT_AUTHOR_NAME: "host",
    GIT_AUTHOR_EMAIL: "host@host",
    GIT_COMMITTER_NAME: "host",
    GIT_COMMITTER_EMAIL: "host@host",
};
const onHost = (cwd: string, ...args: string[]): string =>
    execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...author } });

/** A repository on the host with one commit and a remote, in a folder of its own. */
function repository(prefix: string): string {
    const path = realpathSync(mkdtempSync(join(scratch, `${prefix}-`)));

    onHost(path, "init", "-q", "-b", "main");
    writeFileSync(join(path, "a.txt"), "a\n");
    onHost(path, "add", ".");
    onHost(path, "commit", "-q", "-m", "first");
    onHost(path, "remote", "add", "origin", "https://example.com/some/repo.git");

    return path;
}

let numbers = 100;

/** Run a command in a VM for `cwd` (a session of its own) and give its output. */
function inVm(cwd: string, command: string, extra: Partial<VmTarget> = {}, vms = manager!) {
    const rootId = ++numbers;
    const env = vms.envFor(rootId, { rootId, cwd, uploadDir: undefined, ...extra });
    let output = "";

    // Each call has a VM of its own, and ends it: the most that run at once is a limit of the manager's.
    return env
        .exec(command, { onOutput: (text) => (output += text), timeout: 90 }, context)
        .then(async (result) => {
            await vms.stop(rootId, "the call ended");

            return { result, output };
        });
}

test("git says there are no credentials for a remote that needs them: push is a host job", async (t) => {
    if (unavailable(t)) {
        return;
    }

    const repo = repository("push");
    const vms = new SandboxManager({
        driver: driver!,
        log: () => {},
        pidFile: join(scratch, "push.json"),
        settings: settings("alpine-base:latest", {
            allowedHosts: ["github.com", "*.github.com"],
            maxVms: 1,
        }),
    });

    try {
        const { output } = await inVm(
            repo,
            "git ls-remote https://github.com/pi-pocket-sandbox-test/no-such-private-repo.git 2>&1; echo ---; git ls-remote git@github.com:pi-pocket-sandbox-test/x.git 2>&1",
            {},
            vms,
        );
        const [https, ssh] = output.split("---");

        if (/Could not resolve|timed out|Connection refused/i.test(https!)) {
            t.skip(`no network to github.com here: ${https!.slice(0, 120)}`);

            return;
        }

        assert.match(https!, /no credentials/, output);
        assert.match(https!, /from the host/);
        assert.match(ssh!, /no credentials/, output);
    } finally {
        await vms.stopAll("the test ended");
    }
});

test("the skills a session uses are read only in the VM, and nothing else of Pi's folder is there", async (t) => {
    if (unavailable(t)) {
        return;
    }

    const home = join(scratch, "home");
    const skill = join(home, ".pi", "agent", "skills", "probe");
    const secret = join(home, ".pi", "agent", "auth.json");
    const work = join(scratch, "skills-work");

    mkdirSync(skill, { recursive: true });
    mkdirSync(work);
    writeFileSync(join(skill, "SKILL.md"), "---\nname: probe\ndescription: x\n---\nhello\n");
    writeFileSync(secret, '{"token":"sign-in"}');
    const { output } = await inVm(
        work,
        `tail -1 ${skill}/SKILL.md; { echo x >> ${skill}/SKILL.md; } 2>/dev/null; echo write=$?; cat ${secret} 2>&1 | grep -c sign-in; ls ${home}/.pi/agent | grep -c auth`,
        { skillDirs: [skill] } as never,
    );

    assert.match(output, /hello/);
    assert.match(output, /write=[1-9]/);
    assert.match(output, /\n0\n0\n$/, output);
    assert.equal(readFileSync(join(skill, "SKILL.md"), "utf8").trim().endsWith("hello"), true);
});

test("a runner that is killed is noticed: the VM is dropped, its slot is free, and the next call starts a new one", async (t) => {
    if (unavailable(t)) {
        return;
    }

    const pidFile = join(scratch, "kill.json");
    const dropped: string[] = [];
    const vms = new SandboxManager({
        driver: driver!,
        log: () => {},
        pidFile,
        onEnded: (rootId, reason) => dropped.push(`${rootId}: ${reason}`),
        settings: settings("alpine-base:latest", { mount: "ro", network: "off", maxVms: 1 }),
    });
    const target = { rootId: 11, cwd: scratch, uploadDir: undefined };

    try {
        assert.ok((await vms.envFor(11, target).exec("echo one", {}, context)).ok);
        const [first] = JSON.parse(readFileSync(pidFile, "utf8")) as { pid: number }[];

        assert.equal(vms.running, 1);
        process.kill(first!.pid, "SIGKILL");
        await until(() => vms.running === 0, "the dead VM to be dropped");
        assert.equal(vms.state(11)?.phase, "stopped");
        assert.match(dropped.join("\n"), /11: the sandbox ended/);
        // The slot is free (the limit is 1), and the next call of the same session starts a new VM that works.
        const again = await vms.envFor(11, target).exec("echo two", {}, context);

        assert.ok(again.ok && again.value.exitCode === 0, JSON.stringify(again));
        assert.equal(vms.running, 1);
    } finally {
        await vms.stopAll("the test ended").catch(() => undefined);
    }
});

test("a background task runs in the VM: its server is reached by the browser in the sandbox at localhost, and a restart ends it", async (t) => {
    if (unavailable(t, "pocket-browser:latest")) {
        return;
    }

    const folder = realpathSync(mkdtempSync(join(scratch, "jobs-")));
    const file = join(folder, "jobs.json");
    const vms = new SandboxManager({
        driver: driver!,
        log: () => {},
        pidFile: join(folder, "vms.json"),
        settings: settings("pocket-browser:latest", {
            cpus: 2,
            memoryMb: 2048,
            idleMinutes: 0.05,
            maxVms: 1,
        }),
    });
    const told: string[] = [];
    const options = {
        file,
        spawn: (target: VmTarget, command: string, spawnOptions: object) =>
            vms.spawnShell(target, command, spawnOptions),
        hold: (target: VmTarget) => vms.hold(target),
        limits: () => ({ running: 5, taskQuietMs: 0 }),
        tell: async (_root: number, _by: string, _key: string, text: string) => {
            told.push(text);
        },
        log: () => {},
    };
    const jobs = new VmJobs(options);
    const target = { rootId: 21, cwd: folder, uploadDir: undefined };
    const api = jobs.for({ ...target, own: true });
    const browsers = new Browsers({
        dataDir: folder,
        executable: null,
        remote: () => ({
            key: "vm:21",
            problem: () => undefined,
            launch: (flags) => vms.launchBrowser(target, flags),
        }),
    });

    try {
        writeFileSync(join(folder, "index.html"), "<title>the dev server</title>");
        const started = await api.start({
            command: "python3 -m http.server 5174 --bind 127.0.0.1",
            key: "dev",
            requestedBy: "owner",
        });

        assert.match(started, /Started vm-1/);
        assert.equal(vms.state(21)?.busy, 1, "the task holds the VM");
        // The idle limit is 3 s: the VM outlives it while the task runs.
        await new Promise((resolve) => setTimeout(resolve, 4500));
        assert.equal(vms.running, 1);
        const page = await browsers.open(21);

        const title = async (url: string) => {
            for (let attempt = 0; attempt < 10; attempt++) {
                await page.navigate(url, { timeoutMs: 15_000 }).catch(() => {});

                if (page.state(true).title !== "") {
                    break;
                }

                await new Promise((resolve) => setTimeout(resolve, 500));
            }

            return page.state(true).title;
        };

        assert.match(await title("http://localhost:5174/index.html"), /the dev server/);
        assert.match(await api.output("vm-1"), /GET \/index\.html/);
        assert.match(await api.stop("vm-1"), /Stopped vm-1/);
        const rootId = 21;
        const gone = vms.envFor(rootId, target);
        let output = "";

        await gone.exec(
            "curl -s -m 3 http://127.0.0.1:5174/ || echo down",
            { onOutput: (text) => (output += text) },
            context,
        );
        assert.match(output, /down/, "the stop ended the guest's process");
        assert.equal(told.length, 0, "a stop Pi asked for is no surprise");

        // A restart: the VM ends with the server, and the task that ran is reported as ended, never resumed.
        await api.start({ command: "tail -f /dev/null", key: "long", requestedBy: "owner" });
        const second = new VmJobs(options);

        second.resume();
        await second.retell();
        const list = await second.for({ ...target, own: true }).list();

        assert.match(list, /vm-2: ended: the server restarted/);
        assert.doesNotMatch(list, /resumed|vm-2: running/);
        assert.match(told.join("\n"), /Task vm-2 ended: the server restarted/);
    } finally {
        await browsers.closeAll({ final: true });
        await vms.stopAll("the test ended");
    }
});

test("team: a sandboxed session's linked session runs in a VM of its own, in its folder; another folder is refused; a full house names who holds a VM", async (t) => {
    if (unavailable(t)) {
        return;
    }

    (globalThis as Record<symbol, unknown>)[SEAM] = driver;
    const model = scriptedModel((request) => {
        const { messages } = request as { messages: { role: string }[] };

        return messages.at(-1)?.role === "toolResult"
            ? fauxAssistantMessage([fauxText("done")])
            : fauxAssistantMessage(
                  [
                      fauxToolCall("bash", {
                          command: "echo BOOT=$(cat /proc/sys/kernel/random/boot_id); pwd",
                      } as never),
                  ],
                  { stopReason: "toolUse" },
              );
    });
    const base = realpathSync(mkdtempSync(join(scratch, "team-")));
    const folder = join(base, "project");
    const elsewhere = join(base, "elsewhere");

    mkdirSync(folder);
    mkdirSync(elsewhere);
    const app = await openApp(model, join(base, "data"));

    try {
        await app.setExtensionEnabled(owner(app), "gondolin.ts", true);
        await until(() => app.sandboxes.provider !== undefined, "the module");
        app.setExtensionSettings(owner(app), "gondolin", {
            maxVms: 1,
            memoryMb: 512,
            cpus: 1,
            idleMinutes: 0,
        });
        const lead = await newSession(app, folder);

        await app.sandboxes.set(lead, owner(app), true);
        await say(app, lead, "boot");
        const boot = (text: string) => /BOOT=([0-9a-f-]{36})/.exec(text)?.[1];
        const leadBoot = boot((await modelTexts(app, lead)).join("\n"));

        assert.ok(leadBoot, "the lead ran in a VM");
        await assert.rejects(
            app.linkedSessions.start(lead, { message: "go", cwd: elsewhere }, "away"),
            /works in its folder/,
        );
        // One VM may run: the child's call fails, and the message names the session that holds it.
        const { session: child } = await app.linkedSessions.start(
            lead,
            { message: "boot" },
            "child",
        );

        assert.equal((await app.sandboxes.get(child)).on, true);
        await until(
            async () => /already run/.test((await modelTexts(app, child)).join("\n")),
            "the full-house message",
        );
        assert.match(
            (await modelTexts(app, child)).join("\n"),
            new RegExp(`most is 1: session #${Number(lead)}`),
        );
        // Room is made, and the child's next call runs in a VM of its own.
        app.setExtensionSettings(owner(app), "gondolin", { maxVms: 2 });
        await say(app, child, "boot again");
        const childBoot = boot((await modelTexts(app, child)).join("\n"));

        assert.ok(childBoot && childBoot !== leadBoot, "a VM of its own");
        assert.ok((await modelTexts(app, child)).join("\n").includes(folder));
    } finally {
        (globalThis as Record<symbol, unknown>)[SEAM] = undefined;
        await app.close();
    }
});

test("in a real VM, tasks that start together each keep a process, and a stricter network ends the VM before the next call uses it", async (t) => {
    if (unavailable(t)) {
        return;
    }

    const folder = realpathSync(mkdtempSync(join(scratch, "review-")));
    let network: "allowlist" | "off" = "allowlist";
    const vms = new SandboxManager({
        driver: driver!,
        log: () => {},
        pidFile: join(folder, "vms.json"),
        settings: () => settings("pocket-base:latest", { network, idleMinutes: 0, maxVms: 1 })(),
    });
    const jobs = new VmJobs({
        file: join(folder, "jobs.json"),
        spawn: (target: VmTarget, command: string, spawnOptions: object) =>
            vms.spawnShell(target, command, spawnOptions),
        hold: (target: VmTarget) => vms.hold(target),
        limits: () => ({ running: 5, taskQuietMs: 0 }),
        log: () => {},
    });
    const target = { rootId: 31, cwd: folder, uploadDir: undefined };
    const api = jobs.for({ ...target, own: true });

    try {
        const answers = await Promise.all(
            ["one", "two", "three"].map((word) =>
                api.start({ command: `echo ${word}; tail -f /dev/null`, key: word }),
            ),
        );

        assert.deepEqual(
            answers.map((text) => /Started (vm-\d)/.exec(text)?.[1]),
            ["vm-1", "vm-2", "vm-3"],
        );

        for (const [id, word] of [
            ["vm-1", "one"],
            ["vm-2", "two"],
            ["vm-3", "three"],
        ] as const) {
            await until(async () => (await api.output(id)).includes(word), `the task ${id}`);
        }

        assert.equal(vms.running, 1);

        // The settings get stricter and nothing calls `enforce`: the next call gets a VM with the new rules.
        for (const id of ["vm-1", "vm-2", "vm-3"]) {
            await api.stop(id);
        }

        const env = vms.envFor(31, target);
        const before = await env.exec("echo first", { timeout: 60 }, context);

        assert.ok(before.ok);
        assert.equal(vms.state(31)?.network, "allowlist");
        network = "off";
        const after = await env.exec("echo second", { timeout: 60 }, context);

        assert.ok(after.ok);
        assert.equal(vms.state(31)?.network, "off");
        assert.equal(vms.state(31)?.stale, false);
        assert.equal(vms.running, 1);
    } finally {
        await vms.stopAll("the test ended").catch(() => undefined);
    }
});

test("in a real VM, a task that starts while stricter rules replace the VM runs in the new VM", async (t) => {
    if (unavailable(t)) {
        return;
    }

    const folder = realpathSync(mkdtempSync(join(scratch, "replace-")));
    let network: "allowlist" | "off" = "allowlist";
    let jobs: VmJobs | undefined;
    const vms = new SandboxManager({
        driver: driver!,
        log: () => {},
        pidFile: join(folder, "vms.json"),
        settings: () => settings("pocket-base:latest", { network, idleMinutes: 0, maxVms: 1 })(),
        onEnded: (rootId, reason) => jobs?.vmEnded(rootId, reason),
    });

    jobs = new VmJobs({
        file: join(folder, "jobs.json"),
        spawn: (target: VmTarget, command: string, spawnOptions: object) =>
            vms.spawnShell(target, command, spawnOptions),
        hold: (target: VmTarget) => vms.hold(target),
        limits: () => ({ running: 5, taskQuietMs: 0 }),
        log: () => {},
    });
    const api = jobs.for({ rootId: 32, cwd: folder, uploadDir: undefined, own: true });

    try {
        await api.start({ command: "echo old; tail -f /dev/null", key: "old" });
        await until(async () => (await api.output("vm-1")).includes("old"), "the first task");
        network = "off";
        assert.match(
            await api.start({ command: "echo fresh; tail -f /dev/null", key: "new" }),
            /Started vm-2/,
        );
        await until(async () => (await api.output("vm-2")).includes("fresh"), "the new task");
        assert.match(await api.list(), /vm-1: ended/);
        assert.match(await api.list(), /vm-2: running/);
        assert.equal(vms.state(32)?.network, "off");
    } finally {
        await vms.stopAll("the test ended").catch(() => undefined);
    }
});

test("a session that moves to another folder while a task holds its VM runs in the new folder", async (t) => {
    if (unavailable(t)) {
        return;
    }

    const first = realpathSync(mkdtempSync(join(scratch, "move-a-")));
    const second = realpathSync(mkdtempSync(join(scratch, "move-b-")));

    writeFileSync(join(first, "only-in-a.txt"), "a");
    writeFileSync(join(second, "only-in-b.txt"), "b");
    const vms = new SandboxManager({
        driver: driver!,
        log: () => {},
        pidFile: join(scratch, "move-vms.json"),
        settings: settings("pocket-base:latest", { idleMinutes: 0, maxVms: 1 }),
    });
    const target = (cwd: string) => ({ rootId: 41, cwd, uploadDir: undefined });

    try {
        const env = vms.envFor(41, target(first));
        let output = "";

        assert.ok((await env.exec("ls", { onOutput: (text) => (output += text) }, context)).ok);
        assert.match(output, /only-in-a\.txt/);
        const release = vms.hold(target(first));
        const moved = vms.envFor(41, target(second));

        output = "";
        const result = await moved.exec(
            "pwd; ls; test -e only-in-a.txt; echo old=$?",
            { onOutput: (text) => (output += text), timeout: 60 },
            context,
        );

        assert.ok(result.ok, output);
        assert.match(output, new RegExp(`${second}\\n`));
        assert.match(output, /only-in-b\.txt/);
        assert.doesNotMatch(output, /only-in-a\.txt\n/);
        assert.match(output, /old=1/);
        assert.equal(vms.running, 1);
        release();
    } finally {
        await vms.stopAll("the test ended").catch(() => undefined);
    }
});
