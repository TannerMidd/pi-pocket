// Sandboxed sessions (`sandbox.ts`) and the Gondolin module (`extensions/gondolin.ts`), with a fake VM
// (`gondolin-fake.ts`): off by default, tools routed into the VM, host tools named and stopped, no secrets in the VM,
// a VM that cannot start fails the call with no fallback to the host, restarts, and who may choose.
import assert from "node:assert/strict";
import {
    cpSync,
    existsSync,
    mkdirSync,
    rmSync,
    mkdtempSync,
    readFileSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { SandboxDoc } from "../src/server/docs.ts";
import { FakeDriver } from "./gondolin-fake.ts";
import {
    cleanUp,
    context,
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

/** Each test has a data folder of its own: settings and sessions of one must not reach the next. */
const openFresh = (model: ReturnType<typeof scriptedModel>) =>
    openApp(model, join(root, `data-fresh-${++opened}`));

const SEAM = Symbol.for("pi-pocket.gondolin.test-driver");
const MODULE = "gondolin.ts";

function useDriver(driver: FakeDriver | undefined): void {
    (globalThis as Record<symbol, unknown>)[SEAM] = driver;
}

/** A folder for a session, so each test's marker files are its own. */
function folder(name: string): string {
    const path = join(root, `work-${name}`);

    mkdirSync(path, { recursive: true });

    return path;
}

/** A model that calls `tool` with `args` for each message, then says "done". */
function calls(
    tool: string,
    args: Record<string, unknown> | ((text: string) => Record<string, unknown>),
) {
    return scriptedModel((request) => {
        const { messages } = request as { messages: { role: string; content: unknown }[] };
        const last = JSON.stringify(
            messages.findLast((message) => message.role === "user")?.content,
        );

        return messages.at(-1)?.role === "toolResult"
            ? fauxAssistantMessage([fauxText("done")])
            : fauxAssistantMessage(
                  [fauxToolCall(tool, (typeof args === "function" ? args(last) : args) as never)],
                  { stopReason: "toolUse" },
              );
    });
}

async function sandboxed(app: App, id: ConversationId, user = owner(app)): Promise<void> {
    await app.sandboxes.set(id, user, true);
}

test("it is off by default: nothing runs in a VM, and a session cannot choose a sandbox", async () => {
    const driver = new FakeDriver();

    useDriver(driver);
    const app = await openFresh(scriptedModel());

    try {
        assert.equal(app.loader.enabled(MODULE), false);
        const id = await newSession(app, folder("off"));

        await assert.rejects(app.sandboxes.set(id, owner(app), true), /turned off in Extensions/);
        assert.equal((await app.sandboxes.get(id)).on, false);
        assert.equal(driver.log.started.length, 0);
    } finally {
        await app.close();
    }
});

test("a sandboxed session runs bash in the VM, not on the host", async () => {
    const driver = new FakeDriver();
    const work = folder("route");

    useDriver(driver);
    process.env.POCKET_TEST_SECRET = "hunter2";
    const app = await openFresh(
        calls("bash", { command: "echo in-vm; echo $POCKET_TEST_SECRET; pwd" }),
    );

    try {
        await app.setExtensionEnabled(owner(app), MODULE, true);
        // A secret that an extension gives to every host command must not reach a VM.
        app.commandEnvs.add(() => ({ GH_TOKEN: "ghp_secret" }));
        const id = await newSession(app, work);

        await sandboxed(app, id);
        await say(app, id, "run it");
        const texts = (await modelTexts(app, id)).join("\n");

        assert.match(texts, /in-vm/);
        assert.ok(!texts.includes("hunter2"), "the host's environment is not in the VM");
        assert.ok(
            !texts.includes("ghp_secret"),
            "what extensions add to host commands is not in the VM",
        );
        assert.equal(driver.log.started.length, 1);
        assert.equal(driver.log.started[0]!.cwd, work);
        assert.equal(driver.log.started[0]!.mount, "rw");
        assert.deepEqual(driver.log.started[0]!.protect, ["git"]);
        assert.ok(driver.log.commands.some((argv) => argv.join(" ").includes("echo in-vm")));
        assert.ok(
            driver.log.envs.every(
                (env) => env.GH_TOKEN === undefined && env.POCKET_TEST_SECRET === undefined,
            ),
        );
    } finally {
        delete process.env.POCKET_TEST_SECRET;
        await app.close();
    }
});

test("the VM mounts the session's folder and its uploads, and nothing of the data folder", async () => {
    const driver = new FakeDriver();
    const work = folder("mount");

    useDriver(driver);
    const app = await openFresh(calls("bash", { command: "true" }));

    try {
        await app.setExtensionEnabled(owner(app), MODULE, true);
        const id = await newSession(app, work);

        await sandboxed(app, id);
        await say(app, id, "go");
        const spec = driver.log.started[0]!;
        const everything = [spec.cwd, ...spec.readOnlyMounts];

        assert.ok(
            everything.every((path) => !path.startsWith(app.dataDir) || path.includes("uploads")),
        );
        assert.ok(everything.every((path) => !/\.pi\b|\.ssh|config\.json/.test(path)));
        assert.equal(spec.network.mode, "allowlist");
        assert.ok(spec.network.allowedHosts.includes("registry.npmjs.org"));
    } finally {
        await app.close();
    }
});

test("read, write, and edit go to the VM too", async () => {
    const driver = new FakeDriver();
    const work = folder("files");

    useDriver(driver);
    const app = await openFresh(
        scriptedModel((request) => {
            const { messages } = request as { messages: { role: string }[] };
            const results = messages.filter((message) => message.role === "toolResult").length;

            return results >= 3
                ? fauxAssistantMessage([fauxText("done")])
                : fauxAssistantMessage(
                      [
                          results === 0
                              ? fauxToolCall("write", {
                                    path: join(work, "a.txt"),
                                    content: "one\n",
                                })
                              : results === 1
                                ? fauxToolCall("edit", {
                                      path: join(work, "a.txt"),
                                      edits: [{ oldText: "one", newText: "two" }],
                                  })
                                : fauxToolCall("read", { path: join(work, "a.txt") }),
                      ],
                      { stopReason: "toolUse" },
                  );
        }),
    );

    try {
        await app.setExtensionEnabled(owner(app), MODULE, true);
        const id = await newSession(app, work);

        await sandboxed(app, id);
        await say(app, id, "go");
        assert.equal(readFileSync(join(work, "a.txt"), "utf8"), "two\n");
        assert.match((await modelTexts(app, id)).join("\n"), /two/);
        assert.equal(driver.log.started.length, 1);
    } finally {
        await app.close();
    }
});

test("host tools are stopped in a sandboxed session, named as host tools, and allowed when the owner says", async () => {
    const driver = new FakeDriver();

    useDriver(driver);
    const app = await openFresh(calls("background", { action: "list" }));

    try {
        await app.setExtensionEnabled(owner(app), MODULE, true);
        const id = await newSession(app, folder("host"));
        const plain = await newSession(app, folder("host-plain"));

        await loadTools(app, id, "background");
        await loadTools(app, plain, "background");

        await sandboxed(app, id);
        await say(app, id, "list");
        assert.match(
            (await modelTexts(app, id)).join("\n"),
            /runs on the host, outside the sandbox/,
        );
        // A session that is not sandboxed is unchanged.
        await say(app, plain, "list");
        assert.ok(!(await modelTexts(app, plain)).join("\n").includes("outside the sandbox"));
        // The gate's own table: routed and inert tools pass, anything else is a host tool.
        assert.equal(app.sandboxes.gate("bash", {}), undefined);
        assert.equal(app.sandboxes.gate("ask", {}), undefined);
        assert.equal(app.sandboxes.gate("artifact", { content: "<p>" }), undefined);
        assert.match(app.sandboxes.gate("artifact", { path: "/etc/passwd" }) ?? "", /host/);
        assert.match(
            app.sandboxes.gate("browser", {}) ?? "",
            /browser of this sandbox is not known/,
        );
        assert.match(app.sandboxes.gate("some_extension_tool", {}) ?? "", /host/);
        // The owner allows host tools: they run, on the host, as the owner said.
        app.setExtensionSettings(owner(app), "gondolin", { hostTools: "allow" });
        assert.equal(app.sandboxes.gate("some_extension_tool", {}), undefined);
        await say(app, id, "list again");
        assert.ok(!(await modelTexts(app, id)).at(-2)!.includes("outside the sandbox"));
    } finally {
        await app.close();
    }
});

test("a VM that cannot start fails the call, and nothing runs on the host", async () => {
    const driver = new FakeDriver();
    const work = folder("fail");
    const marker = join(work, "ran-on-host");

    driver.failStart = "KVM is not available";
    useDriver(driver);
    const app = await openFresh(calls("bash", { command: `touch ${marker}` }));

    try {
        await app.setExtensionEnabled(owner(app), MODULE, true);
        const id = await newSession(app, work);

        await sandboxed(app, id);
        await say(app, id, "go");
        const texts = (await modelTexts(app, id)).join("\n");

        assert.match(texts, /The sandbox could not start: KVM is not available/);
        assert.equal(existsSync(marker), false, "the command did not run on the host");
        // The next call tries again, and works once the host is fixed.
        driver.failStart = undefined;
        await say(app, id, "again");
        assert.equal(existsSync(marker), true, "it ran in the VM, whose guest here is the folder");
        assert.equal(driver.log.started.length, 2);
    } finally {
        await app.close();
    }
});

test("with the module off, a sandboxed session runs nothing at all", async () => {
    const driver = new FakeDriver();
    const work = folder("module-off");
    const marker = join(work, "ran-on-host");

    useDriver(driver);
    const app = await openFresh(calls("bash", { command: `touch ${marker}` }));

    try {
        await app.setExtensionEnabled(owner(app), MODULE, true);
        const id = await newSession(app, work);

        await sandboxed(app, id);
        await app.setExtensionEnabled(owner(app), MODULE, false);
        await say(app, id, "go");
        assert.match(
            (await modelTexts(app, id)).join("\n"),
            /sandbox module is off, so nothing ran/,
        );
        assert.equal(existsSync(marker), false);
        // A `!` command and a Done when check fail the same way.
        const goalEnv = await app.envForRun(id);
        const result = await goalEnv.exec(`touch ${marker}`, undefined, context);

        assert.equal(result.ok, false);
        assert.equal(existsSync(marker), false);
        // The setting is stored: it is still there, and the owner can turn it off.
        assert.equal((await app.sandboxes.get(id)).on, true);
        await app.sandboxes.set(id, owner(app), false);
        await say(app, id, "go on the host");
        assert.equal(existsSync(marker), true);
    } finally {
        await app.close();
    }
});

test("a server that dies mid-call: the call comes back interrupted, and runs once", async () => {
    const driver = new FakeDriver();
    const work = folder("restart");
    const marker = join(work, "runs");
    const dataDir = join(root, "data-restart");
    const crashed = join(root, "data-crashed");
    const model = () => calls("bash", { command: `echo run >> ${marker}; tail -f /dev/null` });

    useDriver(driver);
    const first = await openApp(model(), dataDir);
    let id: ConversationId;

    try {
        await first.setExtensionEnabled(owner(first), MODULE, true);
        id = await newSession(first, work);
        await sandboxed(first, id);
        await first.commands.submit(id, owner(first), { text: "go", requestId: "restart-1" });
        await until(() => existsSync(marker), "the command to start in the VM");
        // What a crash leaves on disk: the data folder as it is while the call runs. (A graceful close ends the VM
        // first, and the call then ends with the VM's exit code instead.)
        cpSync(dataDir, crashed, { recursive: true });
        rmSync(join(crashed, "harness.lock"), { force: true });
    } finally {
        await first.close();
    }

    useDriver(new FakeDriver());
    const second = await openApp(model(), crashed);

    try {
        await until(
            async () => /interrupted/i.test((await modelTexts(second, id)).join("\n")),
            "the cut-off call to come back as interrupted",
            15_000,
        );
        assert.equal(
            readFileSync(marker, "utf8"),
            "run\n",
            "the cut-off command was not run again",
        );
        assert.equal((await second.sandboxes.get(id)).on, true, "the session is still sandboxed");
    } finally {
        await second.close();
    }
});

test("a graceful stop ends the VM, and the call it ran ends with the VM's exit code, once", async () => {
    const driver = new FakeDriver();
    const work = folder("stop");
    const marker = join(work, "runs");

    useDriver(driver);
    const app = await openFresh(
        calls("bash", { command: `echo run >> ${marker}; tail -f /dev/null` }),
    );

    try {
        await app.setExtensionEnabled(owner(app), MODULE, true);
        const id = await newSession(app, work);

        await sandboxed(app, id);
        await app.commands.submit(id, owner(app), { text: "go", requestId: "stop-1" });
        await until(() => existsSync(marker), "the command to start in the VM");
        await app.setExtensionEnabled(owner(app), MODULE, false);
        await until(
            async () =>
                /exited with code 137|nothing ran|stopped/i.test(
                    (await modelTexts(app, id)).join("\n"),
                ),
            "the call to end",
        );
        assert.equal(readFileSync(marker, "utf8"), "run\n");
    } finally {
        await app.close();
    }
});

test("who may choose: the owner; guests who steer only when the owner allows; viewers never", async () => {
    const driver = new FakeDriver();

    useDriver(driver);
    const app = await openFresh(scriptedModel());

    try {
        await app.setExtensionEnabled(owner(app), MODULE, true);
        const guest = app.config.addUser("Gale", "guest").user;
        const viewer = app.config.addUser("Vic", "viewer").user;
        const id = await newSession(app, folder("people"));

        await assert.rejects(app.sandboxes.set(id, guest, true), /Only the owner/);
        await assert.rejects(
            app.sandboxes.set(id, viewer, true),
            /view this session but not steer/,
        );
        assert.equal((await app.sandboxes.get(id)).on, false);
        // The owner allows it: a setting of the module.
        app.setExtensionSettings(owner(app), "gondolin", { steerChoose: true });
        await app.sandboxes.set(id, guest, true);
        assert.equal((await app.sandboxes.get(id)).by, guest.id);
        // A guest cannot take away a sandbox that the owner chose.
        await app.sandboxes.set(id, owner(app), false);
        await app.sandboxes.set(id, owner(app), true);
        await assert.rejects(app.sandboxes.set(id, guest, false), /only the owner can turn it off/);
        assert.equal((await app.sandboxes.get(id)).on, true);
        // A person invited to one session who does not see this one cannot set it.
        const sid = app.config.addUser("Sid", "guest", [String(id) + "0"]).user;

        await assert.rejects(app.sandboxes.set(id, sid, false));
    } finally {
        await app.close();
    }
});

test("a sandbox follows the session to its subagents, forks, and linked sessions; new sessions can start in it", async () => {
    const driver = new FakeDriver();

    useDriver(driver);
    const app = await openFresh(scriptedModel());

    try {
        await app.setExtensionEnabled(owner(app), MODULE, true);
        const id = await newSession(app, folder("inherit"));

        await sandboxed(app, id);
        // A session made from it (a new session in its place) stays in the sandbox.
        const copy = await app.commands.fork(id, owner(app), {});

        assert.equal((await app.sandboxes.get(copy.id)).on, true);
        // The setting is the session's: a subagent's conversation cannot change it on its own.
        await app.harness.commit(async (tx) => {
            Object.assign(await tx.doc(SandboxDoc, id), { on: true });
        }, context);
        // New sessions start in the sandbox when the module says so.
        app.setExtensionSettings(owner(app), "gondolin", { newSessions: true });
        const fresh = await newSession(app, folder("inherit-new"));

        assert.equal((await app.sandboxes.get(fresh)).on, true);
    } finally {
        await app.close();
    }
});

test("the VM stops when idle, when the session is archived, and when the module goes off", async () => {
    const driver = new FakeDriver();

    useDriver(driver);
    const app = await openFresh(calls("bash", { command: "true" }));

    try {
        await app.setExtensionEnabled(owner(app), MODULE, true);
        const id = await newSession(app, folder("lifecycle"));

        await sandboxed(app, id);
        assert.equal(driver.log.started.length, 0, "no VM starts until a call needs one");
        await say(app, id, "go");
        assert.equal(driver.log.started.length, 1);
        await say(app, id, "again");
        assert.equal(driver.log.started.length, 1, "one VM serves the session");
        await app.commands.updateSession(id, owner(app), { archived: true });
        await until(() => driver.log.closed.length === 1, "the archived session's VM to stop");
        // Turning the sandbox off for the session stops it too.
        await app.commands.updateSession(id, owner(app), { archived: false });
        await say(app, id, "once more");
        assert.equal(driver.log.started.length, 2);
        await app.setExtensionEnabled(owner(app), MODULE, false);
        await until(() => driver.log.closed.length === 2, "the VM to stop with the module");
    } finally {
        await app.close();
    }
});

test("too many sandboxes at once fail the call with the limit", async () => {
    const driver = new FakeDriver();

    useDriver(driver);
    const app = await openFresh(calls("bash", { command: "true" }));

    try {
        await app.setExtensionEnabled(owner(app), MODULE, true);
        app.setExtensionSettings(owner(app), "gondolin", { maxVms: 1 });
        const one = await newSession(app, folder("limit-1"));
        const two = await newSession(app, folder("limit-2"));

        await sandboxed(app, one);
        await sandboxed(app, two);
        await say(app, one, "go");
        await say(app, two, "go");
        assert.match(
            (await modelTexts(app, two)).join("\n"),
            /1 sandboxes already run \(the most is 1\)/,
        );
        assert.equal(driver.log.started.length, 1);
    } finally {
        await app.close();
    }
});

void mkdtempSync;
void tmpdir;
void writeFileSync;

// ─── The browser of a sandboxed session ─────────────────────────────────────

import { PocketApp } from "../src/server/app.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import { home } from "./helpers.ts";

/** An app with no browser on this machine: whatever opens a page must have used the VM's. */
function openWithoutHostBrowser(dataDir: string): Promise<App> {
    return PocketApp.open({
        dataDir,
        defaultCwd: join(root, "work"),
        supervised: false,
        log: () => {},
        configureModels: (models) => models.registerNativeProvider(scriptedModel().provider),
        home,
        browser: null,
    });
}

const withBrowser = { name: "alpine-base:latest", browser: true } as const;

test(
    "a sandboxed session's browser runs in the VM, never on this machine",
    { skip: findBrowser() === undefined },
    async () => {
        const driver = new FakeDriver();
        const work = folder("browser");

        writeFileSync(join(work, "page.html"), "<title>from the shared folder</title><h1>hi</h1>");
        driver.checkResult = { ...driver.checkResult, images: [withBrowser] };
        useDriver(driver);
        const app = await openWithoutHostBrowser(join(root, "data-browser"));

        try {
            await app.setExtensionEnabled(owner(app), MODULE, true);
            await until(() => app.sandboxes.provider !== undefined, "the module");
            const plain = await newSession(app, folder("browser-plain"));
            const id = await newSession(app, work);

            await sandboxed(app, id);
            // This machine has no browser (as set here): a session that is not sandboxed cannot open a page…
            assert.equal(app.browsers.state(Number(plain)).available, false);
            // …and the sandboxed one can, in its VM.
            assert.equal(app.browsers.state(Number(id)).available, true);
            const page = await app.browsers.open(Number(id));

            await page.navigate(`file://${join(work, "page.html")}`, { timeoutMs: 15_000 });
            assert.match(page.state(true).title, /from the shared folder/);
            assert.ok(driver.log.commands.some((argv) => argv.includes("chromium-browser")));
            assert.ok(
                driver.log.commands.some((argv) => argv.join(" ").includes("certutil")),
                "the network's CA is trusted",
            );
            assert.ok(
                driver.log.commands.some((argv) => argv.includes("--remote-debugging-pipe")),
                "the DevTools pipe is the command's own streams",
            );
            // Pi's browser tool is allowed for a sandboxed session now, and the host-tools setting does not matter for it.
            assert.equal(app.sandboxes.gate("browser", {}, id), undefined);
        } finally {
            await app.close();
        }
    },
);

test("a sandbox without a browser has none: not this machine's", async () => {
    const driver = new FakeDriver();

    useDriver(driver);
    const app = await openFresh(scriptedModel());

    try {
        await app.setExtensionEnabled(owner(app), MODULE, true);
        await until(() => app.sandboxes.provider !== undefined, "the module");
        const id = await newSession(app, folder("no-browser"));

        await sandboxed(app, id);
        // The image the fake VM has is the standard one: no Chromium in it. (The module looks at the host first.)
        await until(
            () => app.sandboxes.gate("browser", {}, id) !== undefined,
            "the first look at the host",
        );
        assert.match(app.sandboxes.gate("browser", {}, id) ?? "", /image has no browser/);
        const state = app.browsers.state(Number(id));

        assert.equal(state.available, false);
        assert.match(state.problem ?? "", /image has no browser/);
        await assert.rejects(app.browsers.open(Number(id)), /image has no browser/);
        // The owner turns it off for sandboxed sessions: the words say so.
        app.setExtensionSettings(owner(app), "gondolin", { browser: "off" });
        assert.match(app.sandboxes.gate("browser", {}, id) ?? "", /turned off the browser/);
        // Even with host tools allowed, this machine's browser is not an option.
        app.setExtensionSettings(owner(app), "gondolin", { hostTools: "allow" });
        assert.match(app.sandboxes.gate("browser", {}, id) ?? "", /turned off the browser/);
        assert.equal(
            app.sandboxes.gate("background", {}, id),
            undefined,
            "host tools are allowed now",
        );
    } finally {
        await app.close();
    }
});

// ─── The module's routes ────────────────────────────────────────────────────

import { createServer } from "node:http";
import { createHandler } from "../src/server/http.ts";

test("the routes: who sees the sandbox, who chooses, and the owner's set-up", async () => {
    const driver = new FakeDriver();

    useDriver(driver);
    const app = await openFresh(scriptedModel());
    const server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/x/gondolin`;
    const tokens = {
        owner: app.config.ownerToken,
        guest: app.config.addUser("Gale", "guest").token,
        viewer: app.config.addUser("Vic", "viewer").token,
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
        await app.setExtensionEnabled(owner(app), MODULE, true);
        const id = Number(await newSession(app, folder("routes")));

        // The owner sees the state and may choose; the VM has not started.
        const first = await call("owner", `state?c=${id}`);

        assert.equal(first.status, 200);
        assert.equal(first.body.session.on, false);
        assert.equal(first.body.mayChoose, true);
        assert.equal(first.body.admin, true);
        assert.equal(first.body.vm, null);
        assert.ok(first.body.where.some((row: { where: string }) => row.where === "blocked"));
        // A guest who steers sees it, but may not choose; a viewer does not see the module's routes at all.
        const guest = await call("guest", `state?c=${id}`);

        assert.equal(guest.status, 200);
        assert.equal(guest.body.mayChoose, false);
        assert.equal(guest.body.admin, false);
        assert.equal((await call("viewer", `state?c=${id}`)).status, 404);
        assert.equal((await call("guest", "session", { c: id, on: true })).status, 403);
        assert.equal((await call("guest", "host")).status, 404, "the owner's page is the owner's");
        assert.equal((await call("guest", "setup", { browser: false })).status, 404);
        assert.equal((await call("owner", "session", { c: id, on: "yes" })).status, 400);
        assert.equal((await call("owner", "session", { c: 999999, on: true })).status, 404);
        // The owner chooses; then the guest sees it, and cannot take it away.
        assert.equal((await call("owner", "session", { c: id, on: true })).status, 200);
        assert.equal((await call("guest", `state?c=${id}`)).body.session.on, true);
        assert.equal((await call("guest", "session", { c: id, on: false })).status, 403);
        // When the host cannot run a VM, choosing is refused with the reason.
        await app.sandboxes.set(id as never, owner(app), false);
        driver.checkResult = {
            ok: false,
            lines: [
                { name: "Back end", ok: false, detail: "Neither libkrun nor QEMU can run here." },
            ],
            images: [],
        };
        const refused = await call("owner", "session", { c: id, on: true });

        assert.equal(refused.status, 409);
        assert.match(
            refused.body.error ?? refused.body.message ?? JSON.stringify(refused.body),
            /Neither libkrun nor QEMU/,
        );
        assert.equal((await app.sandboxes.get(id as never)).on, false);
        // The owner's page: what the host has, and Set up, which runs once and reports.
        const host = await call("owner", "host");

        assert.equal(host.body.check.ok, false);
        assert.equal((await call("owner", "setup", { browser: true })).status, 200);
        await until(
            async () => (await call("owner", "host")).body.setup.done === true,
            "Set up to finish",
        );
        assert.deepEqual(driver.log.setups, [{ browser: true }]);
        assert.equal(
            (await call("owner", "stop", { c: id })).body.stopped,
            false,
            "nothing to stop",
        );
    } finally {
        server.closeAllConnections();
        server.close();
        await app.close();
    }
});

test("a `!` command of a sandboxed session runs in the VM", async () => {
    const driver = new FakeDriver();
    const work = folder("shell");

    useDriver(driver);
    const app = await openFresh(scriptedModel());

    try {
        await app.setExtensionEnabled(owner(app), MODULE, true);
        const id = await newSession(app, work);

        await sandboxed(app, id);
        await app.shell.start(id, owner(app), { command: "echo shell-in-the-vm > shell.txt" });
        await until(() => existsSync(join(work, "shell.txt")), "the command to run");
        assert.equal(driver.log.started.length, 1, "the VM started for it");
        assert.ok(driver.log.commands.some((argv) => argv.join(" ").includes("shell-in-the-vm")));
    } finally {
        await app.close();
    }
});
