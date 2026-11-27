// What the Gondolin sandbox does around private folders, rules that get stricter, browser pages, provider
// registrations, the first shell, linked sessions (team), background tasks in the VM, git, and skills, with a fake VM
// (`gondolin-fake.ts`). The real VM runs the same in `gondolin-real.test.ts`.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { after, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { SandboxDoc } from "../src/server/docs.ts";
import { Browsers } from "../src/server/browser.ts";
import { createHandler } from "../src/server/http.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import {
    gitMounts,
    guestGitConfig,
    NO_CREDENTIALS,
} from "../src/server/extensions/gondolin/git.ts";
import { folderProblem } from "../src/server/extensions/gondolin/policy.ts";
import { FakeDriver } from "./gondolin-fake.ts";
import {
    cleanUp,
    context,
    home,
    loadTools,
    modelTexts,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
    type App,
} from "./helpers.ts";

after(cleanUp);

let opened = 0;
const openFresh = (model: ReturnType<typeof scriptedModel>) =>
    openApp(model, join(root, `data-parity-${++opened}`));
const SEAM = Symbol.for("pi-pocket.gondolin.test-driver");
const MODULE = "gondolin.ts";

const useDriver = (driver: FakeDriver | undefined) => {
    (globalThis as Record<symbol, unknown>)[SEAM] = driver;
};

function folder(name: string): string {
    const path = join(root, `parity-${name}`);

    mkdirSync(path, { recursive: true });

    return path;
}

function calls(tool: string, args: Record<string, unknown>) {
    return scriptedModel((request) => {
        const { messages } = request as { messages: { role: string }[] };

        return messages.at(-1)?.role === "toolResult"
            ? fauxAssistantMessage([fauxText("done")])
            : fauxAssistantMessage([fauxToolCall(tool, args as never)], { stopReason: "toolUse" });
    });
}

async function enable(app: App): Promise<void> {
    await app.setExtensionEnabled(owner(app), MODULE, true);
    await until(() => app.sandboxes.provider !== undefined, "the module");
}

const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        env: {
            ...process.env,
            GIT_AUTHOR_NAME: "t",
            GIT_AUTHOR_EMAIL: "t@t",
            GIT_COMMITTER_NAME: "t",
            GIT_COMMITTER_EMAIL: "t@t",
        },
    });

// ─── 1. Private folders are never mounted ───────────────────────────────────

test("a sandbox folder may not be, hold, or lie inside the home folder's private places", () => {
    const base = realpathSync(mkdtempSync(join(root, "places-")));
    const places = {
        home: join(base, "me"),
        dataDir: join(base, "me", ".pi-pocket"),
        agentDir: join(base, "me", ".pi", "agent"),
    };

    for (const dir of [
        places.home,
        join(places.home, ".ssh"),
        join(places.home, ".ssh", "keys"),
        join(places.home, ".gnupg"),
        join(places.home, ".aws"),
        join(places.home, ".config"),
        join(places.home, ".pi"),
        join(places.home, ".pi", "agent"),
        places.dataDir,
        join(places.dataDir, "uploads"),
        base,
        "/",
    ]) {
        mkdirSync(dir, { recursive: true });
        assert.match(folderProblem(dir, places) ?? "", /cannot share it/, dir);
    }

    // A project in the home folder is the normal case; so are the data folder's own worktrees, and a folder in .config.
    for (const dir of [
        join(places.home, "src", "app"),
        join(places.dataDir, "worktrees", "feature"),
        join(places.home, ".config", "hypr"),
    ]) {
        mkdirSync(dir, { recursive: true });
        assert.equal(folderProblem(dir, places), undefined, dir);
    }

    // A skill folder inside Pi's own folder is read only and allowed; one that holds Pi's folder is not.
    mkdirSync(join(places.agentDir, "skills", "probe"), { recursive: true });
    assert.equal(
        folderProblem(join(places.agentDir, "skills", "probe"), places, "skill"),
        undefined,
    );
    assert.match(folderProblem(join(places.home, ".pi"), places, "skill") ?? "", /cannot share/);
    rmSync(base, { recursive: true, force: true });
});

test("a session whose folder is the home folder cannot choose a sandbox, and one that already has it runs nothing", async () => {
    const driver = new FakeDriver();
    const previous = process.env.HOME;

    useDriver(driver);
    const app = await openFresh(calls("bash", { command: "echo ran" }));

    try {
        process.env.HOME = home;
        mkdirSync(join(home, ".ssh", "proj"), { recursive: true });
        await enable(app);
        const owns = await newSession(app, home);
        const inside = await newSession(app, join(home, ".ssh", "proj"));

        for (const id of [owns, inside]) {
            await assert.rejects(app.sandboxes.set(id, owner(app), true), /cannot share it/);
        }

        // Stored before the rule, or by a fork: the VM never starts, and the call says why.
        await app.harness.commit(async (tx) => {
            Object.assign(await tx.doc(SandboxDoc, owns), { on: true });
        }, context);
        await say(app, owns, "go");
        assert.match((await modelTexts(app, owns)).join("\n"), /cannot share it/);
        assert.equal(driver.log.started.length, 0);
        assert.equal(homedir(), home);
    } finally {
        process.env.HOME = previous;
        await app.close();
    }
});

// ─── 2. Stricter settings end the VMs that run with looser ones ─────────────

test("rules that get stricter end the running VM; looser ones wait for the next start and are shown as stale", async () => {
    const driver = new FakeDriver();

    useDriver(driver);
    const app = await openFresh(calls("bash", { command: "true" }));

    try {
        await enable(app);
        const settings = (value: Record<string, unknown>) =>
            app.setExtensionSettings(owner(app), "gondolin", value);
        const id = await newSession(app, folder("stricter"));

        await app.sandboxes.set(id, owner(app), true);
        await say(app, id, "go");
        assert.equal(driver.log.started.length, 1);

        // Looser: nothing ends; the VM keeps its rules.
        settings({ network: "open" });
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.equal(driver.log.closed.length, 0);
        settings({ network: "allowlist", allowedHosts: "example.com registry.npmjs.org" });
        await until(() => driver.log.closed.length === 1, "a narrower list to end the VM");

        // The next call starts a VM with the new list; fewer hosts now ends it again.
        await say(app, id, "go again");
        assert.deepEqual(driver.log.started[1]!.network.allowedHosts, [
            "example.com",
            "registry.npmjs.org",
        ]);
        settings({ allowedHosts: "example.com" });
        await until(() => driver.log.closed.length === 2, "fewer hosts to end the VM");

        await say(app, id, "go once more");
        settings({ network: "off" });
        await until(() => driver.log.closed.length === 3, "no network to end the VM");

        await say(app, id, "and again");
        settings({ mount: "ro" });
        await until(() => driver.log.closed.length === 4, "a read-only folder to end the VM");
        await say(app, id, "last");
        assert.equal(driver.log.started.at(-1)!.mount, "ro");
        assert.equal(driver.log.started.at(-1)!.network.mode, "off");
    } finally {
        await app.close();
    }
});

// ─── 3. Host browser pages end when the session is sandboxed ────────────────

test(
    "turning the sandbox on closes the session's pages of this machine's browser at once",
    { skip: findBrowser() === undefined },
    async () => {
        const driver = new FakeDriver();

        useDriver(driver);
        const app = await openFresh(scriptedModel());

        try {
            await enable(app);
            const id = await newSession(app, folder("pages"));
            const page = await app.browsers.open(Number(id));

            assert.equal(page.closed, false);
            await app.sandboxes.set(id, owner(app), true);
            assert.equal(page.closed, true, "closed by the change, not when someone next looks");
        } finally {
            await app.close();
        }
    },
);

test(
    "a page that is still opening when the browser choice changes does not stay",
    { skip: findBrowser() === undefined },
    async () => {
        const dir = mkdtempSync(join(root, "browsers-"));
        let calls_ = 0;
        const browsers = new Browsers({
            dataDir: dir,
            // The first two looks (the open, and the choice of browser) see this machine's browser; later ones see a VM's.
            remote: () =>
                ++calls_ <= 2
                    ? undefined
                    : {
                          key: "vm:1",
                          problem: () => undefined,
                          launch: () => Promise.reject(new Error("no VM here")),
                      },
        });

        try {
            await assert.rejects(
                browsers.open(1, { restore: false }),
                /browser changed while the page opened/,
            );
            assert.equal(browsers.page(1), undefined);
        } finally {
            await browsers.closeAll?.();
            rmSync(dir, { recursive: true, force: true });
        }
    },
);

// ─── 5. Registrations of providers ──────────────────────────────────────────

test("a provider registration that ends never brings back one that ended before it", async () => {
    const app = await openFresh(scriptedModel());

    try {
        const provider = (name: string) => ({ name }) as never;
        const a = app.sandboxes.register(provider("a"));
        const b = app.sandboxes.register(provider("b"));

        assert.equal((app.sandboxes.provider as unknown as { name: string }).name, "b");
        a();
        assert.equal((app.sandboxes.provider as unknown as { name: string }).name, "b");
        b();
        assert.equal(
            app.sandboxes.provider,
            undefined,
            "the ended registration `a` does not return",
        );

        const c = app.sandboxes.register(provider("c"));
        const d = app.sandboxes.register(provider("d"));

        d();
        assert.equal((app.sandboxes.provider as unknown as { name: string }).name, "c");
        c();
        assert.equal(app.sandboxes.provider, undefined);
    } finally {
        await app.close();
    }
});

// ─── 6. The first command uses bash ─────────────────────────────────────────

test("the first bash call of a session runs in bash, not in sh", async () => {
    const driver = new FakeDriver();

    useDriver(driver);
    const app = await openFresh(calls("bash", { command: "echo first-call" }));

    try {
        await enable(app);
        const id = await newSession(app, folder("shell"));

        await app.sandboxes.set(id, owner(app), true);
        await say(app, id, "go");
        const run = driver.log.commands.find((argv) => argv.at(-1) === "echo first-call");

        assert.ok(run, "the command ran in the VM");
        assert.match(run[0]!, /bash$/);
        assert.equal(run[1], "-lc");
    } finally {
        await app.close();
    }
});

// ─── Linked sessions (team) ─────────────────────────────────────────────────

test("a sandboxed session starts linked sessions that stay in its sandbox and its folder", async () => {
    const driver = new FakeDriver();

    useDriver(driver);
    const app = await openFresh(scriptedModel());

    try {
        await enable(app);
        const work = folder("team");
        const elsewhere = folder("team-elsewhere");
        const lead = await newSession(app, work);

        await app.sandboxes.set(lead, owner(app), true);
        await say(app, lead, "hello");
        // The tool is allowed in a sandboxed session, whatever the owner says of host tools.
        assert.equal(app.sandboxes.gate("team", {}, lead), undefined);

        const { session } = await app.linkedSessions.start(lead, { message: "work" }, "one");

        assert.equal((await app.sandboxes.get(session)).on, true, "the child is sandboxed");
        assert.equal(app.cwdOf(session), work, "in the parent's folder");
        // Another folder is refused, with the reason, and nothing starts.
        await assert.rejects(
            app.linkedSessions.start(lead, { message: "work", cwd: elsewhere }, "two"),
            /runs in a sandbox, so a linked session it starts works in its folder/,
        );
        // The owner can allow other folders: still sandboxed, still never a private folder.
        app.setExtensionSettings(owner(app), "gondolin", { teamFolders: true });
        const other = await app.linkedSessions.start(
            lead,
            { message: "work", cwd: elsewhere },
            "three",
        );

        assert.equal((await app.sandboxes.get(other.session)).on, true);
        assert.equal(app.cwdOf(other.session), elsewhere);
        await assert.rejects(
            app.linkedSessions.start(lead, { message: "work", cwd: homedir() }, "four"),
            /cannot share it/,
        );
    } finally {
        await app.close();
    }
});

test("a sandboxed session messages only sandboxed linked sessions and the one that started it", async () => {
    const driver = new FakeDriver();

    useDriver(driver);
    const app = await openFresh(scriptedModel());

    try {
        await enable(app);
        const lead = await newSession(app, folder("send"));

        await say(app, lead, "hello");
        const { session: child } = await app.linkedSessions.start(lead, { message: "work" }, "c1");
        const { session: sibling } = await app.linkedSessions.start(
            lead,
            { message: "work" },
            "c2",
        );

        await until(() => !app.isBusy(child) && !app.isBusy(sibling), "the children to be idle");
        // Only the child is put in the sandbox: it may not write to its sibling that runs on the host.
        await app.sandboxes.set(child, owner(app), true);
        assert.equal(await app.sandboxes.mayMessage(child, sibling), false);
        // The one that started it may be answered: its answer goes there anyway.
        assert.equal(await app.sandboxes.mayMessage(child, lead), true);
        await app.sandboxes.set(sibling, owner(app), true);
        assert.equal(await app.sandboxes.mayMessage(child, sibling), true);
        // A session that is not sandboxed is unchanged.
        assert.equal(await app.sandboxes.mayMessage(lead, child), true);
    } finally {
        await app.close();
    }
});

// ─── Background tasks in the VM ─────────────────────────────────────────────

const quiet = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a sandboxed session's background tasks run in the VM, keep it up, and end with it", async () => {
    const driver = new FakeDriver();
    const work = folder("jobs");

    useDriver(driver);
    const app = await openFresh(scriptedModel());

    try {
        await enable(app);
        app.setExtensionSettings(owner(app), "gondolin", { idleMinutes: 0.02 });
        const id = await newSession(app, work);

        await app.sandboxes.set(id, owner(app), true);
        const jobs = (await app.sandboxes.jobs(id))!;

        assert.ok(jobs, "a sandboxed session has VM jobs");
        const started = await jobs.start({
            command: `echo up > ${join(work, "up")}; echo line-one; sleep 30`,
            key: "k1",
            notify: false,
        });

        assert.match(started, /Started vm-1 in the sandbox/);
        // Not on the host's own list.
        assert.deepEqual(await app.background.list(id), []);
        assert.equal(driver.log.started.length, 1);
        await until(() => existsSync(join(work, "up")), "the task to run");
        assert.match(await jobs.output("vm-1"), /line-one/);
        assert.match(await jobs.output("vm-1"), /Nothing new/);
        assert.match(await jobs.list(), /vm-1: running/);
        // The same key is the same task (a replayed call starts nothing again).
        assert.match(await jobs.start({ command: "echo other", key: "k1" }), /vm-1/);
        assert.equal(JSON.parse(await jobs.jobs()).tasks.length, 1);
        // While a task runs the VM is not idle: it outlives the idle limit (1.2 s here).
        await quiet(2000);
        assert.equal(driver.log.closed.length, 0, "the VM is held while a task runs");
        // Stop ends the guest process.
        assert.match(await jobs.stop("vm-1"), /Stopped vm-1/);
        assert.match(await jobs.list(), /vm-1: stopped/);
        assert.match(await jobs.stop("vm-1"), /had already ended/);
        assert.match(await jobs.stop("vm-9"), /no background task/);
        await until(() => driver.log.closed.length === 1, "the idle VM to stop");
    } finally {
        await app.close();
    }
});

test("a task ends when its VM does, and Pi is told it ended, never that it resumed", async () => {
    const driver = new FakeDriver();
    const work = folder("jobs-end");

    useDriver(driver);
    const app = await openFresh(scriptedModel());

    try {
        await enable(app);
        const id = await newSession(app, work);

        await app.sandboxes.set(id, owner(app), true);
        await say(app, id, "hello");
        const jobs = (await app.sandboxes.jobs(id))!;

        await jobs.start({
            command: "echo server; sleep 60",
            key: "k2",
            requestedBy: owner(app).id,
        });
        await until(() => driver.vms.length === 1, "the VM");
        driver.vms[0]!.crash("the runner died");
        await until(
            async () => /vm-1: ended: the sandbox ended/.test(await jobs.list()),
            "the task to end",
        );
        await until(
            async () => (await modelTexts(app, id)).join("\n").includes("Task vm-1 ended"),
            "Pi to be told",
        );
        assert.ok(!(await modelTexts(app, id)).join("\n").includes("resumed"));
        // The next call starts a new VM, and the old task stays ended.
        assert.match(await jobs.start({ command: "echo again", key: "k3", notify: false }), /vm-2/);
        assert.equal(driver.vms.length, 2);
    } finally {
        await app.close();
    }
});

test("a task that prints nothing for its limit is stopped, and a task limit holds", async () => {
    const driver = new FakeDriver();

    useDriver(driver);
    const app = await openFresh(scriptedModel());

    try {
        await enable(app);
        const id = await newSession(app, folder("jobs-quiet"));

        await app.sandboxes.set(id, owner(app), true);
        const jobs = (await app.sandboxes.jobs(id))!;

        await jobs.start({ command: "sleep 60", key: "q", quietMinutes: 0.02, notify: false });
        await until(
            async () => /vm-1: stopped after printing nothing/.test(await jobs.list()),
            "the quiet stop",
        );
        const limit = app.background.limits.running;

        for (let n = 0; n < limit; n++) {
            await jobs.start({
                command: "sleep 60",
                key: `many-${n}`,
                quietMinutes: 0,
                notify: false,
            });
        }

        await assert.rejects(
            jobs.start({ command: "sleep 60", key: "one-more", notify: false }),
            /already runs \d+ background tasks/,
        );
    } finally {
        await app.close();
    }
});

test("the background tool of a sandboxed session never starts a host process", async () => {
    const driver = new FakeDriver();
    const work = folder("jobs-tool");
    const marker = join(work, "on-host");

    useDriver(driver);
    const app = await openFresh(
        calls("background", {
            action: "start",
            command: `echo $$ > ${marker}; echo hi`,
            notify: false,
        }),
    );

    try {
        await enable(app);
        const id = await newSession(app, work);

        await loadTools(app, id, "background");
        await app.sandboxes.set(id, owner(app), true);
        await say(app, id, "start it");
        await until(
            async () => /Started vm-1 in the sandbox/.test((await modelTexts(app, id)).join("\n")),
            "the tool's answer",
        );
        assert.deepEqual(await app.background.list(id), [], "nothing on the host's list");
        assert.ok(driver.log.commands.some((argv) => argv.at(-1)?.includes("echo hi")));
        // With the module off, the tool fails: it does not fall back to the host.
        await app.setExtensionEnabled(owner(app), MODULE, false);
        await say(app, id, "again");
        assert.deepEqual(await app.background.list(id), []);
    } finally {
        await app.close();
    }
});

// ─── Git, worktrees, skills ─────────────────────────────────────────────────

test("a worktree's main repository is mounted at its host path, and a .git file that is not a git directory or a worktree's record mounts nothing", async () => {
    const base = realpathSync(mkdtempSync(join(root, "git-")));
    const main = join(base, "main");
    const tree = join(base, "tree");
    const forged = join(base, "forged");

    mkdirSync(main);
    git(main, "init", "-q", "-b", "main");
    writeFileSync(join(main, "a.txt"), "a\n");
    git(main, "add", ".");
    git(main, "commit", "-q", "-m", "first");
    git(main, "worktree", "add", "-q", tree, "-b", "feature");

    const mounts = await gitMounts(tree);

    assert.deepEqual(mounts.gitDirs, [join(main, ".git")]);
    assert.deepEqual(mounts.safeDirectories, [tree, main]);
    assert.deepEqual(
        (await gitMounts(main)).gitDirs,
        [join(main, ".git")],
        "a plain repository's own directory is inside its folder",
    );

    // A `.git` file that names something else (not written by git, no back-pointer) mounts nothing.
    mkdirSync(forged);
    writeFileSync(join(forged, ".git"), `gitdir: ${join(main, ".git")}\n`);
    assert.deepEqual(
        (await gitMounts(forged)).gitDirs,
        [join(main, ".git")],
        "a .git file that names a git directory shares it, read only (the file is the host's, the guest cannot write one)",
    );
    writeFileSync(join(forged, ".git"), `gitdir: ${home}\n`);
    assert.deepEqual((await gitMounts(forged)).gitDirs, []);
    writeFileSync(join(forged, ".git"), `gitdir: ${join(main, ".git", "worktrees", "tree")}\n`);
    assert.deepEqual(
        (await gitMounts(forged)).gitDirs,
        [],
        "the worktree's back-pointer names another folder",
    );

    // The guest's own configuration trusts the folders, has an author, and cannot sign in.
    const config = guestGitConfig(mounts.safeDirectories);

    assert.match(config, new RegExp(`directory = "${tree}"`));
    assert.match(config, new RegExp(`directory = "${main}"`));
    assert.ok(config.includes(NO_CREDENTIALS));
    assert.match(config, /\[credential\]/);
    assert.match(config, /sshCommand/);
    rmSync(base, { recursive: true, force: true });
});

test("a sandboxed session's VM gets the worktree's repository and the skills it uses, read only, and nothing else", async () => {
    const driver = new FakeDriver();
    const base = realpathSync(mkdtempSync(join(root, "mounts-")));
    const main = join(base, "main");
    const tree = join(base, "tree");
    const skill = join(home, ".agents", "skills", "probe");

    mkdirSync(main);
    git(main, "init", "-q", "-b", "main");
    writeFileSync(join(main, "a.txt"), "a\n");
    git(main, "add", ".");
    git(main, "commit", "-q", "-m", "first");
    git(main, "worktree", "add", "-q", tree, "-b", "feature");
    mkdirSync(skill, { recursive: true });
    writeFileSync(
        join(skill, "SKILL.md"),
        "---\nname: probe\ndescription: A probe skill for the sandbox test.\n---\nUse it.\n",
    );
    useDriver(driver);
    const app = await openFresh(calls("bash", { command: "true" }));

    try {
        await enable(app);
        const id = await newSession(app, tree);

        await app.sandboxes.set(id, owner(app), true);
        await say(app, id, "go");
        const spec = driver.log.started[0]!;

        assert.deepEqual(spec.gitDirs, [join(main, ".git")]);
        assert.ok(spec.safeDirectories.includes(tree) && spec.safeDirectories.includes(main));
        assert.ok(spec.readOnlyMounts.includes(skill), "the skill folder is mounted read only");
        assert.ok(
            spec.readOnlyMounts.every(
                (path) => !path.includes(".pi/agent") || path.includes("skills"),
            ),
            "nothing else of Pi's folder",
        );
        assert.ok(!spec.readOnlyMounts.includes(home));
    } finally {
        await app.close();
        rmSync(base, { recursive: true, force: true });
    }
});

test("the sheet lists the VMs, the owner stops any of them, and each VM shows its own rules", async () => {
    const driver = new FakeDriver();

    useDriver(driver);
    const app = await openFresh(calls("bash", { command: "true" }));
    const server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/x/gondolin`;
    const tokens = {
        owner: app.config.ownerToken,
        guest: app.config.addUser("Gale", "guest").token,
    };

    const call = async (who: keyof typeof tokens, path: string, body?: unknown) => {
        const response = await fetch(`${base}/${path}`, {
            method: body === undefined ? "GET" : "POST",
            headers: {
                authorization: `Bearer ${tokens[who]}`,
                "x-pocket": "1",
                ...(body === undefined ? {} : { "content-type": "application/json" }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });

        return {
            status: response.status,
            body: (await response.json().catch(() => ({}))) as Record<string, any>,
        };
    };

    try {
        await enable(app);
        const id = await newSession(app, folder("sheet"));

        await app.sandboxes.set(id, owner(app), true);
        await say(app, id, "go");
        // A looser setting: the VM keeps the rules it started with, and the sheet says so.
        app.setExtensionSettings(owner(app), "gondolin", { network: "open" });
        const state = await call("owner", `state?c=${Number(id)}`);

        assert.equal(state.body.vm.network, "allowlist", "the VM's own rules, not the settings'");
        assert.equal(state.body.vm.stale, true);
        assert.ok(state.body.vm.allowedHosts.includes("registry.npmjs.org"));
        const host = await call("owner", "host");

        assert.deepEqual(
            host.body.vms.map((vm: { rootId: number }) => vm.rootId),
            [Number(id)],
        );
        assert.equal(host.body.max, 3);
        assert.equal((await call("guest", "stop-vm", { c: Number(id) })).status, 404, "owner only");
        assert.equal((await call("owner", "stop-vm", { c: Number(id) })).body.stopped, true);
        assert.equal(driver.log.closed.length, 1);
        assert.deepEqual((await call("owner", "host")).body.vms, []);
        assert.equal((await call("owner", "stop-vm", { c: Number(id) })).body.stopped, false);
    } finally {
        server.closeAllConnections();
        server.close();
        await app.close();
    }
});

void ((_: ConversationId) => undefined);
