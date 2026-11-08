// Real app, runner, and pi-env: task lifetime belongs only to the runner process.
import {
    type App,
    cleanUp,
    context,
    loadTools,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    lastText,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Runner, type RunnerOptions } from "../src/runner/runner.ts";
import { taskImports } from "../src/runner/tasks.ts";
import { RemoteBackground } from "../src/server/background-remote.ts";
import { BackgroundDoc } from "../src/server/docs.ts";
import { createHandler } from "../src/server/http.ts";
import { StartCutOff } from "../src/server/background.ts";

const there = join(root, "computer");
let app: App;
let server: Server;
let runner: Runner;
let options: RunnerOptions;
let computer: string;
let childRunner: ChildProcess | undefined;
const folders = new Set<string>();
const pids = new Set<number>();
const model = scriptedModel((request) => {
    const { role, text } = lastText(request as never);

    return role === "user" && text.startsWith("bg ")
        ? fauxAssistantMessage([fauxToolCall("background", JSON.parse(text.slice(3)))], {
              stopReason: "toolUse",
          })
        : fauxAssistantMessage([fauxText("ok")]);
});

before(async () => {
    mkdirSync(there);
    app = await openApp(model);
    app.background.timing.grace = 300;
    app.background.timing.starting = 300;
    app.config.lastModel = { provider: "faux", modelId: "faux-1", thinkingLevel: "off" };
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    server.on("upgrade", (request, socket, head) => {
        if (!app.runners.upgrade(request, socket, head)) {
            socket.destroy();
        }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const linked = app.runners.redeem(app.runners.makeCode("Task computer", owner(app).id).code);

    computer = linked.id;
    options = {
        link: { server: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, ...linked },
        version: "test",
        cwd: there,
        retryMs: [300],
        ask: () => Promise.resolve({ allow: true }),
    };
    await startRunner();
});

after(async () => {
    childRunner?.stdin?.end();
    await runner?.stop();

    for (const pid of pids) {
        if (living(pid)) {
            try {
                process.kill(pid, "SIGKILL");
            } catch {
                /* Already gone. */
            }
        }
    }

    await app?.close();
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));

    for (const folder of folders) {
        rmSync(folder, { recursive: true, force: true });
    }

    cleanUp();
});

async function startRunner(): Promise<void> {
    runner = new Runner(options);
    runner.start();
    await app.runners.link(computer).whenOnline();
    assert.equal(app.runners.link(computer).tasks, true);
}

async function session() {
    const id = (await app.commands.createSession(owner(app), { cwd: there, runner: computer })).id;

    await loadTools(app, id, "background");
    const scope = app.runnerScope(id);

    folders.add(
        await new RemoteBackground(app.runners.env(computer, there, scope), scope.id).dir(),
    );

    return id;
}

const items = async (id: ConversationId) =>
    Object.values((await app.harness.snapshot(BackgroundDoc, id, context))?.items ?? {});

async function userTexts(id: ConversationId): Promise<string> {
    const page = await (await app.harness.conversation(id, context))!.entries(
        {},
        200,
        undefined,
        context,
    );

    return page.items
        .filter((entry) => entry.kind === "pi.user")
        .map((entry) => JSON.stringify(entry.model))
        .join("\n");
}

function living(pid: number): boolean {
    try {
        process.kill(pid, 0);

        return (
            process.platform !== "linux" ||
            !/[)] [ZX] /.test(readFileSync(`/proc/${pid}/stat`, "utf8"))
        );
    } catch {
        return false;
    }
}

async function tree(
    id: ConversationId,
    command = 'sleep 300 & printf \'%s %s\\n\' "$$" "$!"; wait',
) {
    const item = await app.background.start(id, { command, notify: false });
    let found: number[] = [];

    await until(async () => {
        const text = (await app.background.output(id, item.id))!.text;

        found = text.trim().split(/\s+/).map(Number);

        return found.length === 2 && found.every((pid) => Number.isSafeInteger(pid) && pid > 0);
    }, "task and grandchild ids");

    for (const pid of found) {
        pids.add(pid);
        assert.equal(living(pid), true);
    }

    return { item, found };
}

/** The shell has exited, but its redirected descendant still belongs to the runner. */
async function endedTree(id: ConversationId) {
    const item = await app.background.start(id, {
        command: "sleep 300 >/dev/null 2>&1 & printf '%s\\n' \"$!\"",
        notify: false,
    });
    let pid = 0;

    await until(async () => {
        pid = Number((await app.background.output(id, item.id))!.text.trim());

        return Number.isSafeInteger(pid) && pid > 0;
    }, "redirected descendant id");
    pids.add(pid);
    assert.equal(living(pid), true);
    const scope = app.runnerScope(id);
    const io = new RemoteBackground(app.runners.env(computer, there, scope), scope.id);

    await until(async () => (await io.exitCodes(item.id))?.code === 0, "shell exit file");
    await until(
        async () =>
            (await app.runners.link(computer).taskList(scope.id)).some(
                (task) => task.task === item.id && "ended" in task && task.ended === true,
            ),
        "ended task in the runner registry",
    );
    assert.equal(living(pid), true, "the shell exit does not kill the descendant");

    return { item, pid };
}

test("the background tool reads segmented task logs and the real exit code through the session", async () => {
    const id = await session();
    const saved = app.background.sizes.segment;

    app.background.sizes.segment = 8192;

    try {
        await say(
            app,
            id,
            `bg ${JSON.stringify({ action: "start", command: "printf 'task output\\n'; printf '%020000d' 1; printf 'stderr output\\n' >&2; exit 7", notify: false })}`,
        );
        const item = (await items(id))[0]!;

        await until(async () => (await items(id))[0]?.status === "exited", "task exit");
        const scope = app.runnerScope(id);
        const io = new RemoteBackground(app.runners.env(computer, there, scope), scope.id);
        const logs = (await io.files())
            .filter((file) => file.name.includes(".log."))
            .sort((a, b) => a.name.localeCompare(b.name));

        assert.equal(logs.length, 3);
        assert.deepEqual(
            logs.map((file) => file.name.slice(-6)),
            ["aaaaaa", "aaaaab", "aaaaac"],
        );

        for (const file of logs) {
            assert.ok((await io.bytes(file.path, 0, 30_000)).length <= 8192);
        }

        assert.equal((await io.exitCodes(item.id))?.code, 7);
        assert.equal((await io.exitCodes(item.id))?.log, 0);
        const output = (await app.background.output(id, item.id, { chars: 30_000 }))!.text;

        assert.match(output, /task output/);
        assert.match(output, /stderr output/);
        assert.equal(existsSync(join(app.dataDir, "background", String(id))), false);
    } finally {
        app.background.sizes.segment = saved;
    }
});

test("a link drop and a real pi-env daemon restart do not stop a task or lose output", async () => {
    const id = await session();
    const item = await app.background.start(id, {
        command: "printf 'before reconnect\\n'; sleep 2; printf 'after reconnect\\n'; sleep 30",
        notify: false,
    });

    await until(
        async () => (await app.background.output(id, item.id))!.text.includes("before reconnect"),
        "first output",
    );
    runner.drop();
    await until(() => !app.runners.link(computer).online, "link offline");
    const waiting = app.runners.link(computer).taskList(app.runnerScope(id).id);

    assert.ok((await waiting).some((task) => task.task === item.id && task.pid === item.pid));
    const daemon = runner.daemonPid!;
    const daemonSession = await app.runners.link(computer).session();

    process.kill(daemon, "SIGKILL");
    await until(() => runner.daemonPid !== daemon, "fresh daemon");
    await until(
        async () => (await app.runners.link(computer).session()) !== daemonSession,
        "daemon reconnected",
    );
    await until(
        async () => (await app.background.output(id, item.id))!.text.includes("after reconnect"),
        "output after reconnect",
    );
    assert.equal(await app.background.alive(id, item), true);
    assert.ok(
        (await app.runners.link(computer).taskList(app.runnerScope(id).id)).some(
            (task) => task.task === item.id && task.pid === item.pid,
        ),
    );
    await app.background.stop(id, item.id);
});

test("background output, list, and stop tools use the runner task controls", async () => {
    const id = await session();

    await say(
        app,
        id,
        `bg ${JSON.stringify({ action: "start", command: "printf 'tool controls\\n'; sleep 30", notify: false })}`,
    );
    const item = (await items(id))[0]!;

    for (const action of ["list", "output", "stop"]) {
        await say(app, id, `bg ${JSON.stringify({ action, id: item.id })}`);
    }

    assert.equal((await items(id))[0]?.status, "stopped");
    assert.match((await app.background.output(id, item.id))!.text, /tool controls/);
});

test("a missing Bash falls back to sh, and task environment is kept", async () => {
    const id = await session();
    const scope = app.runnerScope(id);
    const bin = join(there, "shell-bin");

    mkdirSync(bin);
    symlinkSync("/bin/sh", join(bin, "sh"));
    await app.runners.link(computer).taskStart({
        permission: scope.id,
        task: "fallback",
        command: "printf '%s' \"$TASK_VALUE\"; exit 9",
        cwd: there,
        env: { PATH: bin, TASK_VALUE: "fallback value" },
        segment: 8192,
    });
    const io = new RemoteBackground(app.runners.env(computer, there, scope), scope.id);

    await until(async () => (await io.exitCodes("fallback"))?.code === 9, "fallback exit");
    assert.equal(
        (await io.bytes(join(await io.dir(), "fallback.log.aaaaaa"), 0, 100)).toString(),
        "fallback value",
    );
});

test("server state can reopen while the runner and its task continue", async () => {
    await app.harness.waitForIdle(context);
    const id = await session();
    const item = await app.background.start(id, {
        command:
            "printf 'before server reopen\\n'; sleep 3; printf 'after server reopen\\n'; exit 4",
    });

    await app.close();
    app = await openApp(model);
    app.background.timing.grace = 300;
    app.background.timing.starting = 300;
    server.removeAllListeners("request");
    server.on(
        "request",
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await app.runners.link(computer).whenOnline();
    await until(async () => (await items(id))[0]?.status === "exited", "task after server reopen");
    assert.equal((await items(id))[0]?.pid, item.pid);
    assert.equal((await items(id))[0]?.code, 4);
    await until(
        async () => (await items(id))[0]?.toldAt !== undefined,
        "completion delivered after server reopen",
        15_000,
    );
    assert.match(await userTexts(id), /exited with code 4/);
    assert.match(await userTexts(id), /after server reopen/);
    assert.match(
        (await app.background.output(id, item.id))!.text,
        /before server reopen\nafter server reopen/,
    );
});

test("a start interrupted before recording is adopted from the runner task list", async () => {
    const id = await session();

    app.background.beforeRecord = () => Promise.reject(new StartCutOff());

    try {
        await assert.rejects(
            app.background.start(id, {
                command: "printf 'once\\n'; sleep 30",
                key: "once",
                notify: false,
            }),
            StartCutOff,
        );
    } finally {
        app.background.beforeRecord = undefined;
    }

    await until(async () => (await items(id))[0]?.status === "running", "task adoption");
    const item = await app.background.start(id, { command: "printf duplicate", key: "once" });

    assert.equal((await items(id)).length, 1);
    assert.match((await app.background.output(id, item.id))!.text, /^once/);
    await app.background.stop(id, item.id);
});

test("the task gate refuses unapproved permissions and outside or symlinked cwd; permissions isolate signals", async () => {
    const id = await session();
    const other = await session();
    const link = app.runners.link(computer);
    const permission = app.runnerScope(id).id;
    const request = {
        permission,
        task: "gate-test",
        command: "sleep 30",
        cwd: there,
        env: {},
        segment: 8192,
    };

    await assert.rejects(
        link.taskStart({ ...request, permission: "not-approved" }),
        /Session not approved/,
    );
    await assert.rejects(
        link.taskStart({ ...request, cwd: root }),
        /outside the session's approved folder/,
    );
    const outside = join(there, "outside-link");

    symlinkSync(root, outside);
    await assert.rejects(
        link.taskStart({ ...request, cwd: outside }),
        /outside the session's approved folder/,
    );
    const [pid, duplicate] = await Promise.all([link.taskStart(request), link.taskStart(request)]);

    pids.add(pid);
    assert.equal(duplicate, pid);
    assert.equal(await link.taskStart(request), pid);
    assert.equal(
        (await link.taskList(app.runnerScope(other).id)).some((task) => task.task === request.task),
        false,
    );
    await link.taskSignal(app.runnerScope(other).id, request.task, "KILL");
    assert.equal(living(pid), true);
    await link.taskSignal(permission, request.task, "KILL");
    await until(() => !living(pid), "own signal");
    const otherScope = app.runnerScope(other);
    const ownDir = await new RemoteBackground(
        app.runners.env(computer, there, otherScope),
        otherScope.id,
    ).dir();
    const targetDir = await new RemoteBackground(
        app.runners.env(computer, there, app.runnerScope(id)),
        permission,
    ).dir();

    symlinkSync(targetDir, ownDir);
    await assert.rejects(
        link.taskStart({ ...request, permission: otherScope.id }),
        /outside its permitted folder/,
    );
    await link.action({ action: "revoke", session: permission });
    await assert.rejects(link.taskStart({ ...request, task: "revoked" }), /Session not approved/);
});

test("a task whose shell ended counts as ended while what it started still runs, as on a server", async () => {
    const id = await session();
    const { item, pid } = await endedTree(id);

    await until(
        async () => (await items(id))[0]?.status === "exited",
        "the task recorded as ended",
    );
    assert.equal(living(pid), true, "the task's child still runs");
    assert.equal((await items(id))[0]?.code, 0);
    // The process that still runs, by its own id: not the task's shell, which has ended.
    assert.deepEqual((await items(id))[0]?.left, [pid], "what it left is named");

    await app.runners.link(computer).taskSignal(app.runnerScope(id).id, item.id, "KILL");
    await until(() => !living(pid), "the child stopped");
});

test("signals still reach descendants of an ended task", async () => {
    const id = await session();
    const { item, pid } = await endedTree(id);

    await app.runners.link(computer).taskSignal(app.runnerScope(id).id, item.id, "KILL");
    await until(() => !living(pid), "signalled descendant of an ended task");
});

test("runner.stop stops running and ended task groups within 7 seconds, including TERM-resistant commands", async () => {
    const id = await session();
    const { item, found } = await tree(
        id,
        "trap '' TERM; sleep 300 & printf '%s %s\\n' \"$$\" \"$!\"; wait",
    );
    const ended = await endedTree(id);

    found.push(ended.pid);
    const started = Date.now();

    await runner.stop();
    await until(
        () => found.every((pid) => !living(pid)),
        "stopped process tree",
        Math.max(1, 7000 - (Date.now() - started)),
    );
    assert.ok(Date.now() - started < 7000);
    await until(() => !app.runners.link(computer).online, "runner stopped");
    await startRunner();
    const permission = app.runnerScope(id);
    const io = new RemoteBackground(app.runners.env(computer, there, permission), permission.id);

    assert.equal((await io.exitCodes(item.id))?.code, 137);
    assert.equal((await io.exitCodes(ended.item.id))?.code, 0, "the shell's result stays final");
});

test("SIGKILL of a separate runner stops running and ended task groups within 7 seconds", async () => {
    await runner.stop();
    await until(() => !app.runners.link(computer).online, "runner offline");
    const source = `
        import { Runner } from ${JSON.stringify(new URL("../src/runner/runner.ts", import.meta.url).href)};
        const runner = new Runner({ ...${JSON.stringify(options)}, ask: async () => ({ allow: true }) });
        process.stdin.resume();
        process.stdin.once("end", () => void runner.stop());
        process.on("SIGTERM", () => void runner.stop());
        runner.start();
        await runner.finished;
        process.exit(0);
    `;

    childRunner = spawn(process.execPath, [...taskImports(), "--input-type=module", "-e", source], {
        stdio: ["pipe", "ignore", "inherit"],
    });
    const exited = new Promise<void>((resolve) => childRunner!.once("exit", () => resolve()));

    await app.runners.link(computer).whenOnline();
    const id = await session();
    const { found } = await tree(
        id,
        "trap '' TERM; sleep 300 & printf '%s %s\\n' \"$$\" \"$!\"; wait",
    );
    const ended = await endedTree(id);

    found.push(ended.pid);
    const started = Date.now();

    childRunner.kill("SIGKILL");
    await exited;
    childRunner = undefined;
    await until(
        () => found.every((pid) => !living(pid)),
        "crashed runner process tree",
        Math.max(1, 7000 - (Date.now() - started)),
    );
    assert.ok(Date.now() - started < 7000);
    await until(() => !app.runners.link(computer).online, "crashed runner offline");
    await startRunner();
});
