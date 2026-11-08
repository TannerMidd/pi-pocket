// Sessions on another computer, end to end (`src/server/runners.ts`, `src/runner/`): the app links a computer, its runner
// connects over a real WebSocket to a real pi-env daemon, and Pi's tools in a session there run there. Here the "other
// computer" is this one, in a folder of its own that the server's sessions never use.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
    fauxAssistantMessage,
    fauxText,
    fauxToolCall,
    type FauxResponseStep,
} from "@earendil-works/pi-ai/providers/faux";
import {
    Runner,
    type RunnerOptions,
    type SessionAnswer,
    type SessionQuestion,
} from "../src/runner/runner.ts";
import { REMOTE_EXTENSIONS } from "../src/server/runners.ts";
import { AgentDoc } from "@earendil-works/pi-durable";
import { SubagentsDoc } from "../src/server/docs.ts";
import type { Lesson } from "../src/server/docs.ts";
import { ExtensionRequest } from "../src/server/extension-request.ts";
import { createHandler } from "../src/server/http.ts";
import {
    type App,
    cleanUp,
    context,
    lastText,
    loadTools,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";

/** The remote computer's folder: the server's own sessions work in `work`, never here. */
const there = join(root, "there");
let app: App;
let server: Server;
let runner: Runner;
let runnerOptions: RunnerOptions;
let runnerId: string;
/** The system sections of the newest request to the model. */
let sections: Record<string, string> = {};

const route: FauxResponseStep = (context) => {
    const { role, text } = lastText(context as never);

    sections = Object.assign(
        {},
        ...(context.messages as { role: string; sections?: Record<string, string> }[])
            .filter((message) => message.role === "system")
            .map((message) => message.sections ?? {}),
    ) as Record<string, string>;

    const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
        fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

    if (role === "toolResult") {
        return fauxAssistantMessage([fauxText(`tool said: ${text}`)]);
    }

    if (text.includes("spawn runner subagent")) {
        return call("subagent", {
            action: "spawn",
            name: "remote-probe",
            message: "run runner directory probe",
        });
    }

    if (text.includes("start runner team")) {
        return call("team", { action: "start", message: "run runner directory probe" });
    }

    if (text.includes("run runner directory probe")) {
        return call("bash", { command: "pwd" });
    }

    if (text.includes("long runner codemode")) {
        return call("codemode", { code: 'text("remote-output-".repeat(6000));' });
    }

    if (text.includes("write the note")) {
        return call("write", { path: "note.txt", content: "made on the runner\n" });
    }

    if (text.includes("run pwd")) {
        return call("bash", { command: "pwd && cat note.txt" });
    }

    return fauxAssistantMessage([fauxText("ok")]);
};

/** The runner's settings, as its link file would hold them. */
const runnerSettings: { confirm?: boolean } = {};

/** What the computer was asked, and how its person answers: yes, unless a test says otherwise. */
const asked: SessionQuestion[] = [];
let answer: (question: SessionQuestion) => Promise<SessionAnswer> = () =>
    Promise.resolve({ allow: true });

/** The newest tool result's text in a conversation. */
async function lastToolText(id: number): Promise<string> {
    const view = await (await app.harness.conversation(id as never, context))!.context(context);
    const result = view.messages.findLast((message) => message.role === "toolResult");

    return JSON.stringify(result?.content ?? "");
}

before(async () => {
    mkdirSync(there, { recursive: true });
    app = await openApp(scriptedModel(route));
    await app.setExtensionEnabled(owner(app), "agent-teams.ts", true);
    app.config.lastModel ??= { provider: "faux", modelId: "faux-1", thinkingLevel: "off" };

    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    server.on("upgrade", (request, socket, head) => {
        if (!app.runners.upgrade(request, socket, head)) {
            socket.destroy();
        }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    const { port } = server.address() as AddressInfo;
    const { code } = app.runners.makeCode("Laptop", owner(app).id);
    const linked = app.runners.redeem(code);

    runnerId = linked.id;
    runnerOptions = {
        link: { server: `http://127.0.0.1:${port}`, ...linked },
        version: "test",
        cwd: there,
        log: () => {},
        retryMs: [50, 100, 200],
        settings: () => runnerSettings,
        // The person at the computer: asked before each session, answering as `answer` says.
        ask: (question) => {
            asked.push(question);

            return answer(question);
        },
    };
    runner = new Runner(runnerOptions);
    runner.start();
    await until(() => app.runners.list()[0]?.online === true, "the runner to connect");
});

after(async () => {
    await runner?.stop();
    await app?.close();
    server?.closeAllConnections();
    await new Promise((resolve) => server?.close(resolve));
    cleanUp();
});

describe("a session on another computer", () => {
    let id: number;

    it("starts in a folder there, owner only, and keeps the computer", async () => {
        const created = await app.commands.createSession(owner(app), {
            cwd: there,
            runner: runnerId,
        });

        id = created.id;
        assert.equal(app.runnerOf(created.id), runnerId);
        assert.equal(app.sessionMeta(created.id)?.runner, runnerId);
        assert.match(app.sessionMeta(created.id)?.title ?? "", /on Laptop$/);

        await assert.rejects(
            app.commands.createSession(owner(app), { cwd: join(there, "nope"), runner: runnerId }),
            /is not a folder on Laptop/,
        );
        await assert.rejects(
            app.commands.createSession(owner(app), { cwd: there, runner: "nobody" }),
            /not linked to this server/,
        );
        await assert.rejects(
            app.commands.createSession(owner(app), {
                cwd: there,
                runner: runnerId,
                worktree: true,
            }),
            /is not in a git repository/,
        );
    });

    it("runs Pi's tools there, and tells Pi where it is", async () => {
        await say(app, id as never, "write the note");
        assert.equal(readFileSync(join(there, "note.txt"), "utf8"), "made on the runner\n");
        assert.ok(!existsSync(join(root, "work", "note.txt")));

        await say(app, id as never, "run pwd");
        assert.match(await lastToolText(id), /made on the runner/);
        assert.ok((await lastToolText(id)).includes(there));

        assert.match(sections.environment ?? "", /on the computer "Laptop"/);
        assert.match(
            sections.environment ?? "",
            /run on that computer, not on the Pi Pocket server/,
        );
        assert.equal(sections.project_context, undefined);
    });

    it("offers only the tools that work there", async () => {
        const tools = (await (await app.conversation(id as never)).agent(context)).tools.map(
            (tool) => tool.name,
        );

        for (const name of [
            "read",
            "write",
            "edit",
            "bash",
            "team",
            "codemode",
            "memory",
            "artifact",
        ]) {
            assert.ok(tools.includes(name), `${name} is offered`);
        }

        // Subagents and the browser too, loaded when Pi asks for them (tool search): the browser's pages load through
        // that computer (`browser/proxy.ts`).
        const deferred = (await (await app.conversation(id as never)).agent(context)).deferred.map(
            (tool) => tool.name,
        );

        assert.ok(deferred.includes("subagent"), "subagent waits to be loaded");
        assert.ok(deferred.includes("browser"), "browser waits to be loaded");

        for (const name of ["background", "design_preview"]) {
            assert.ok(!tools.includes(name), `${name} is not offered`);
        }
    });

    it("reads its folder there for Files and Changes, not this server's disk", async () => {
        // Not in a repository there: Pi's edits only, by where they are there.
        const changes = await app.workspace.changes(id as never, owner(app));

        assert.equal(changes.repo, undefined);
        assert.deepEqual(
            changes.piOnly.map((each) => each.path),
            [join(there, "note.txt")],
        );
        assert.deepEqual((await app.workspace.fileList(id as never, owner(app))).files, [
            "note.txt",
        ]);
        assert.equal(app.workspace.head(id as never), undefined);
    });

    it("is its creator's alone: others on the server neither see nor start, fork, or prompt one", async () => {
        const { user: other } = app.config.addUser("Someone", "guest");
        const { user: anotherOwner } = app.config.addUser("Co-owner", "owner");

        for (const person of [other, anotherOwner]) {
            assert.equal(app.canSee(person, id as never), false, `${person.name} cannot see it`);
            assert.ok(
                !app.sessions(person).some((each) => each.id === Number(id)),
                `${person.name}'s list has no such session`,
            );
            assert.throws(() => app.requireSee(person, id as never), /not shared with you/);
            await assert.rejects(
                app.commands.createSession(person, { cwd: there, runner: runnerId }),
                /Only the person who linked this computer/,
            );
            await assert.rejects(
                app.commands.fork(id as never, person, {}),
                /not shared|Only the person/,
            );
        }

        assert.equal(app.canSee(owner(app), id as never), true);
    });

    it("follows the usual rules when the owner shares them, but starting one stays the linker's", async () => {
        const other = app.config.users.find((each) => each.name === "Co-owner")!;

        await assert.rejects(
            app.setSharedRunnerSessions(
                app.config.users.find((each) => each.name === "Someone")!,
                true,
            ),
            /Only the owner/,
        );
        await app.setSharedRunnerSessions(owner(app), true);

        try {
            assert.equal(app.canSee(other, id as never), true);
            assert.ok(app.sessions(other).some((each) => each.id === Number(id)));
            await assert.rejects(
                app.commands.createSession(other, { cwd: there, runner: runnerId }),
                /Only the person who linked this computer/,
            );
            await assert.rejects(
                app.commands.fork(id as never, other, {}),
                /Only the person who linked/,
            );
        } finally {
            await app.setSharedRunnerSessions(owner(app), false);
        }

        assert.equal(app.canSee(other, id as never), false);
        assert.equal(app.config.sharedRunnerSessions, false);
    });

    it("keeps the computer in a fork", async () => {
        const fork = await app.commands.fork(id as never, owner(app), {});

        assert.equal(app.runnerOf(fork.id), runnerId);
    });

    it("asks the computer first, and does not start a session its person denies", async () => {
        asked.length = 0;
        answer = () =>
            Promise.resolve({ allow: false, reason: "The person at this computer denied it." });

        try {
            const before = app.sessions(owner(app)).length;

            await assert.rejects(
                app.commands.createSession(owner(app), { cwd: there, runner: runnerId }),
                /denied it/,
            );
            await assert.rejects(app.commands.fork(id as never, owner(app), {}), /denied it/);
            assert.equal(app.sessions(owner(app)).length, before, "no session was made");
            assert.deepEqual(
                asked.map((each) => [each.kind, each.person, each.folder]),
                [
                    ["new", "Owner", there],
                    ["fork", "Owner", there],
                ],
            );
        } finally {
            answer = () => Promise.resolve({ allow: true });
        }
    });

    it("cancels new sessions and whole-session forks, even when their person allows them late", async () => {
        for (const kind of ["new", "fork"] as const) {
            const before = app.sessions(owner(app)).length;
            const controller = new AbortController();
            let late!: (answer: SessionAnswer) => void;

            asked.length = 0;
            answer = () =>
                new Promise((resolve) => {
                    late = resolve;
                });

            try {
                const result =
                    kind === "new"
                        ? app.commands.createSession(
                              owner(app),
                              { cwd: there, runner: runnerId },
                              { signal: controller.signal },
                          )
                        : app.commands.fork(id as never, owner(app), {}, controller.signal);
                const rejected = assert.rejects(result, { status: 409, message: "Cancelled." });

                await until(() => asked.length === 1, "the session question");
                controller.abort();
                await rejected;
                await until(() => asked[0]!.signal.aborted, "the runner question to be withdrawn");
                assert.equal(asked[0]!.signal.reason, "Withdrawn by the server.");
                late({ allow: true });
                await new Promise((resolve) => setTimeout(resolve, 50));
                assert.equal(
                    app.sessions(owner(app)).length,
                    before,
                    "no cancelled session was made",
                );
            } finally {
                controller.abort();
                answer = () => Promise.resolve({ allow: true });
            }
        }
    });

    it("still starts a session when its person allows it immediately", async () => {
        asked.length = 0;
        const before = app.sessions(owner(app)).length;
        const created = await app.commands.createSession(owner(app), {
            cwd: there,
            runner: runnerId,
        });

        assert.equal(asked.length, 1);
        assert.equal(app.runnerOf(created.id), runnerId);
        assert.equal(app.sessions(owner(app)).length, before + 1);
    });

    it("starts sessions without asking when its person turned asking off", async () => {
        asked.length = 0;
        answer = () => Promise.reject(new Error("must not be asked"));

        try {
            runnerSettings.confirm = false;
            await app.commands.createSession(owner(app), { cwd: there, runner: runnerId });
            assert.equal(asked.length, 0);
        } finally {
            runnerSettings.confirm = true;
            answer = () => Promise.resolve({ allow: true });
        }
    });

    it("checks a moved folder on the computer and asks before changing it", async () => {
        const folder = join(root, "move-destination");

        mkdirSync(folder, { recursive: true });
        const session = (
            await app.commands.createSession(owner(app), { cwd: there, runner: runnerId })
        ).id;

        asked.length = 0;
        await app.commands.configure(session as never, owner(app), { cwd: there });
        assert.equal(asked.length, 0, "the same folder is not a move");
        await assert.rejects(
            app.commands.configure(session as never, owner(app), { cwd: join(folder, "missing") }),
            /is not a folder on Laptop/,
        );
        assert.equal(asked.length, 0, "invalid folders do not ask");
        answer = () => Promise.resolve({ allow: false, reason: "Move denied here." });

        try {
            await assert.rejects(
                app.commands.configure(session as never, owner(app), { cwd: folder }),
                /Move denied here/,
            );
            assert.equal(app.cwdOf(session as never), there, "a denied move keeps the old folder");
            assert.deepEqual(
                asked.map((each) => [each.kind, each.person, each.folder]),
                [["move", owner(app).name, folder]],
            );
            answer = () => Promise.resolve({ allow: true });
            await app.commands.configure(session as never, owner(app), { cwd: folder });
            assert.equal(app.cwdOf(session as never), folder);
        } finally {
            answer = () => Promise.resolve({ allow: true });
        }
    });

    it("spawns a subagent with only remote extensions and runs its tools on the computer", async () => {
        // It waits for tool search: the scripted Pi calls it at once, as if it had loaded it.
        await loadTools(app, id as never, "subagent");
        await say(app, id as never, "spawn runner subagent");
        const spawned = (await app.harness.snapshot(SubagentsDoc, id as never, context))?.agents[
            "remote-probe"
        ];

        assert.ok(spawned, "the subagent was spawned");
        const child = spawned.conversationId;

        await until(
            async () => (await lastToolText(Number(child))).includes(there) && !app.isBusy(child),
            "the subagent's remote directory probe",
        );
        assert.equal(app.runnerOf(child), runnerId);
        assert.equal(app.cwdOf(child), there);
        const childAgent = await (await app.conversation(child)).agent(context);
        const parentAgent = await (await app.conversation(id as never)).agent(context);
        const remoteTools = new Set(parentAgent.callable.map((tool) => tool.name));

        for (const tool of childAgent.callable) {
            assert.ok(remoteTools.has(tool.name), `${tool.name} comes from a remote extension`);
        }

        for (const extension of childAgent.extensions) {
            assert.ok(
                (REMOTE_EXTENSIONS as readonly string[]).includes(extension.name),
                `${extension.name} is a remote extension`,
            );
        }

        for (const name of ["subagent", "team", "ask"]) {
            assert.ok(
                !childAgent.callable.some((tool) => tool.name === name),
                `${name} is removed`,
            );
        }
    });

    it("loads drop-ins that say remoteSessions, existing sessions too, and no others", async () => {
        // The list each one is saved with: built-ins that are off in tests (the guard) are on it too.
        const names = async (conversation: number) =>
            ((await app.harness.snapshot(AgentDoc, conversation as never, context))?.extensions ??
                []) as string[];
        const dropIns = join(app.dataDir, "extensions");
        const module = (name: string, remote: boolean) =>
            `export const pocketApi = 2;\n${remote ? "export const remoteSessions = true;\n" : ""}export default () => ({ name: "${name}" });\n`;

        try {
            writeFileSync(join(dropIns, "remote-ok.ts"), module("remote-ok", true));
            writeFileSync(join(dropIns, "server-only.ts"), module("server-only", false));
            await app.setExtensionEnabled(owner(app), "remote-ok.ts", true);
            await app.setExtensionEnabled(owner(app), "server-only.ts", true);

            // The session made before the drop-in came gets it, next to the built-in list; its subagent too.
            await until(
                async () => (await names(id)).includes("remote-ok"),
                "the existing session to get it",
            );
            assert.deepEqual(await names(id), [...REMOTE_EXTENSIONS, "remote-ok"]);
            assert.ok(!(await names(id)).includes("server-only"));

            const child = (await app.harness.snapshot(SubagentsDoc, id as never, context))!.agents[
                "remote-probe"
            ]!.conversationId;

            await until(
                async () => (await names(Number(child))).includes("remote-ok"),
                "its subagent to get it",
            );
            assert.ok(!(await names(Number(child))).includes("pocket-subagents"));

            // A new one has it from the start; a server session has both.
            const fresh = await app.commands.createSession(owner(app), {
                cwd: there,
                runner: runnerId,
            });

            assert.deepEqual(await names(fresh.id), [...REMOTE_EXTENSIONS, "remote-ok"]);

            // A session on the server saves no list: it runs with every extension that is on, both drop-ins too.
            const local = await newSession(app);
            const loaded = (await (await app.conversation(local)).agent(context)).extensions.map(
                (extension) => extension.name,
            );

            assert.ok(loaded.includes("remote-ok") && loaded.includes("server-only"));

            // Turned off, or no longer saying it: gone from sessions on the computer.
            writeFileSync(join(dropIns, "remote-ok.ts"), module("remote-ok", false));
            await app.loader.reload("remote-ok.ts");
            await until(
                async () => !(await names(id)).includes("remote-ok"),
                "the line taken out to count",
            );
            assert.deepEqual(await names(id), [...REMOTE_EXTENSIONS]);

            writeFileSync(join(dropIns, "remote-ok.ts"), module("remote-ok", true));
            await app.loader.reload("remote-ok.ts");
            await until(async () => (await names(id)).includes("remote-ok"), "the line back");
            await app.setExtensionEnabled(owner(app), "remote-ok.ts", false);
            await until(
                async () => !(await names(id)).includes("remote-ok"),
                "turned off to count",
            );
        } finally {
            // The tests after this one see only the built-in list again.
            for (const file of ["remote-ok.ts", "server-only.ts"]) {
                await app.setExtensionEnabled(owner(app), file, false).catch(() => {});
                rmSync(join(dropIns, file), { force: true });
            }

            await until(
                async () => JSON.stringify(await names(id)) === JSON.stringify(REMOTE_EXTENSIONS),
                "the drop-ins to be gone",
            );
        }
    });

    it("starts a team in the same folder without another question", async () => {
        asked.length = 0;
        await say(app, id as never, "start runner team");
        const linked = app.sessions(owner(app)).findLast((each) => each.linkedFrom?.id === id);

        assert.ok(linked, "the team started a linked session");
        assert.equal(app.sessionMeta(linked.id as never)?.runner, runnerId);
        assert.equal(app.cwdOf(linked.id as never), there);
        assert.deepEqual(
            (await app.harness.snapshot(AgentDoc, linked.id as never, context))?.extensions,
            [...REMOTE_EXTENSIONS],
        );
        assert.equal(asked.length, 0, "a team in the starting session folder does not ask");
        await until(
            async () =>
                (await lastToolText(linked.id)).includes(there) && !app.isBusy(linked.id as never),
            "the linked session's remote directory probe",
        );

        for (const cwd of ["", "   "]) {
            const { session } = await app.linkedSessions.start(
                id as never,
                { cwd, message: "hello" },
                crypto.randomUUID(),
            );

            assert.equal(app.cwdOf(session), there, `blank cwd ${JSON.stringify(cwd)}`);
            assert.equal(app.runnerOf(session), runnerId);
        }
    });

    it("checks an explicit team folder on the computer, and refuses a denied start", async () => {
        const before = app.sessions(owner(app)).length;
        const otherFolder = join(root, "different-team-folder");

        mkdirSync(otherFolder, { recursive: true });
        asked.length = 0;
        await assert.rejects(
            app.linkedSessions.start(
                id as never,
                { cwd: join(there, "missing-team-folder"), message: "hello" },
                crypto.randomUUID(),
            ),
            /missing-team-folder is not a folder on Laptop/,
        );
        assert.equal(asked.length, 0, "an invalid folder never asks");
        answer = () => Promise.resolve({ allow: false, reason: "Team start denied." });

        try {
            await assert.rejects(
                app.linkedSessions.start(
                    id as never,
                    { cwd: otherFolder, message: "hello" },
                    crypto.randomUUID(),
                ),
                /Team start denied/,
            );
            assert.equal(asked.length, 1, "the computer was asked");
            assert.equal(app.sessions(owner(app)).length, before, "no linked session was made");
        } finally {
            answer = () => Promise.resolve({ allow: true });
        }
    });

    it("keeps the runner for a human team start and restricts starts to people who may use it", async () => {
        const actor = new ExtensionRequest(app, owner(app).id, "owner", id as never);

        actor.bindSource((await app.agentState(id as never))!);

        try {
            const { session } = await app.linkedSessions
                .forRequest(id as never, actor)
                .start({ cwd: there, message: "hello" }, crypto.randomUUID());

            assert.equal(app.runnerOf(session), runnerId);
            assert.equal(app.cwdOf(session), there);
        } finally {
            actor.close();
        }

        const other = app.config.users.find((each) => each.name === "Co-owner")!;

        await app.setSharedRunnerSessions(owner(app), true);

        // A session of its own, where the co-owner writes last: the linked session above answers its own session by
        // itself (since 0.29.0), which would make the owner its last writer again.
        const shared = await app.commands.createSession(owner(app), {
            cwd: there,
            runner: runnerId,
        });

        try {
            const { submissionId } = await app.commands.submit(shared.id, other, {
                text: "hello from a co-owner",
                requestId: crypto.randomUUID(),
            });

            await (await app.harness.submission(submissionId, context))!.wait(context);
            assert.equal(app.attribution.requesterOf(shared.id), other.id);
            const before = app.sessions(owner(app)).length;

            asked.length = 0;
            await assert.rejects(
                app.linkedSessions.start(shared.id, { message: "hello" }, crypto.randomUUID()),
                /Only the person who linked this computer or the people they chose can start sessions on it/,
            );
            assert.equal(asked.length, 0, "an ungranted person cannot ask the computer");
            assert.equal(app.sessions(owner(app)).length, before);
        } finally {
            await app.setSharedRunnerSessions(owner(app), false);
        }
    });

    it("starts a server team without assigning a runner or asking the computer", async () => {
        const source = await newSession(app);

        asked.length = 0;
        await say(app, source, "start runner team");
        const linked = app.sessions(owner(app)).findLast((each) => each.linkedFrom?.id === source);

        assert.ok(linked);
        assert.equal(app.sessionMeta(linked.id as never)?.runner, undefined);
        assert.equal(app.cwdOf(linked.id as never), app.cwdOf(source));
        assert.equal(asked.length, 0);
    });

    it("does not save truncated codemode output in a file the remote session cannot read", async () => {
        const directory = join(root, "codemode-output");
        const previous = process.env.TMPDIR;

        mkdirSync(directory);
        process.env.TMPDIR = directory;

        try {
            await say(app, id as never, "long runner codemode");
            const result = await lastToolText(id);

            assert.match(result, /Warning: output truncated/);
            assert.ok(
                result.includes(
                    "[Full output not saved: this session runs on another computer. Make the script return less, or write the output to a file there.]",
                ),
            );
            assert.doesNotMatch(result, /Full output:|pi-pocket-codemode-/);
            assert.deepEqual(
                readdirSync(directory),
                [],
                "no output file was written on the server",
            );
        } finally {
            if (previous === undefined) {
                delete process.env.TMPDIR;
            } else {
                process.env.TMPDIR = previous;
            }
        }
    });

    it("keeps lessons on their computer and offers approved lessons from other copies to add", async () => {
        const localFolder = join(root, "local-memory");
        const remoteFolder = join(root, "runner-memory");

        for (const [folder, url] of [
            [localFolder, "git@github.com:Acme/Memory.git"],
            [remoteFolder, "https://github.com/acme/memory.git"],
        ]) {
            mkdirSync(folder!, { recursive: true });
            execFileSync("git", ["init", "-q"], { cwd: folder });
            execFileSync("git", ["remote", "add", "origin", url!], { cwd: folder });
        }

        const local = (await app.commands.createSession(owner(app), { cwd: localFolder })).id;
        const remote = (
            await app.commands.createSession(owner(app), { cwd: remoteFolder, runner: runnerId })
        ).id;
        const localProject = (await app.memory.project(local, localFolder))!;
        const remoteProject = (await app.memory.project(remote, remoteFolder))!;

        assert.match(remoteProject.key, new RegExp(`^runner:${runnerId}:`));
        assert.equal(localProject.key, join(localFolder, ".git"));
        assert.equal(remoteProject.runner, runnerId);
        assert.equal(localProject.repo?.toLowerCase(), remoteProject.repo?.toLowerCase());
        const localLesson = await app.memory.remember(local, owner(app), {
            text: "Build with make check.",
        });
        const remoteLesson = await app.memory.remember(remote, owner(app), {
            text: "Keep commands on the runner.",
        });

        await app.memory.remember(local, owner(app), { text: "Shared lesson." });
        await app.memory.remember(remote, owner(app), { text: "  Shared lesson.  " });
        await app.memory.remember(local, owner(app), { text: "Already pending there." });
        const pi = { userId: owner(app).id, byPi: true, name: "Pi" };

        await app.memory.add(remote, remoteFolder, pi, {
            text: "Already pending there.",
            scope: "project",
        });
        await app.memory.add(local, localFolder, pi, {
            text: "Unapproved source.",
            scope: "project",
        });
        assert.ok(
            (await app.memory.inForce(remote, remoteFolder)).lessons.some(
                (lesson) => lesson.id === remoteLesson.id,
            ),
        );
        assert.ok(
            !(await app.memory.inForce(local, localFolder)).lessons.some(
                (lesson) => lesson.id === remoteLesson.id,
            ),
        );
        assert.ok(
            !(await app.memory.inForce(remote, remoteFolder)).lessons.some(
                (lesson) => lesson.id === localLesson.id,
            ),
        );

        const view = await app.memory.view(remote, owner(app));

        assert.deepEqual(
            view.others?.map((other) => [
                other.project,
                other.name,
                other.computer,
                other.lessons.map((lesson) => lesson.id),
            ]),
            [[localProject.key, localProject.name, "this server", [localLesson.id]]],
        );
        const localView = await app.memory.view(local, owner(app));

        assert.deepEqual(
            localView.others?.map((other) => [
                other.computer,
                other.lessons.map((lesson) => lesson.id),
            ]),
            [["Laptop", [remoteLesson.id]]],
        );
        const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/c/${remote}/memory`;
        const copy = (lesson: string) =>
            fetch(url, {
                method: "POST",
                headers: {
                    authorization: `Bearer ${app.config.ownerToken}`,
                    "x-pocket": "1",
                    "content-type": "application/json",
                },
                body: JSON.stringify({ copy: lesson }),
            });

        for (const invalid of [remoteLesson.id, "missing"]) {
            const rejected = await copy(invalid);

            assert.equal(rejected.status, 404);
            assert.match(
                await rejected.text(),
                /That lesson is not in another copy of this repository\./,
            );
        }

        const response = await copy(localLesson.id);

        assert.equal(response.status, 200);
        const copied = (await response.json()) as Lesson;

        assert.notEqual(copied.id, localLesson.id);
        assert.equal(copied.text, localLesson.text);
        assert.equal(copied.project, remoteProject.key);
        assert.equal(copied.pending, undefined);
        assert.equal(copied.from?.conversationId, remote);
        assert.equal((await app.memory.view(remote, owner(app))).others, undefined);
        assert.equal((await copy(localLesson.id)).status, 404);

        await say(app, remote, "check my saved lessons");
        assert.match(sections.memory ?? "", /Keep commands on the runner/);
        assert.match(sections.memory ?? "", /Build with make check/);
    });

    it("starts PR watches using the runner's origin and branch but gh on the server", async () => {
        const folder = join(root, "runner-watch");

        mkdirSync(folder, { recursive: true });
        execFileSync("git", ["init", "-q", "-b", "runner-branch"], { cwd: folder });
        execFileSync(
            "git",
            [
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.com",
                "commit",
                "--allow-empty",
                "-qm",
                "initial",
            ],
            { cwd: folder },
        );
        execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/app.git"], {
            cwd: folder,
        });
        const session = (
            await app.commands.createSession(owner(app), { cwd: folder, runner: runnerId })
        ).id;
        const previous = app.watches.gh;
        const calls: { args: string[]; cwd?: string }[] = [];

        // The same server-side gh seam as triggers.test.ts, never a gh command sent to the runner.
        app.watches.gh = async (args, cwd) => {
            calls.push({ args, cwd });

            if (args[0] === "api") {
                return args[1] === "user"
                    ? "me\n"
                    : JSON.stringify({ full_name: "acme/app", permissions: { push: true } });
            }

            return JSON.stringify({
                number: 23,
                url: "https://github.com/acme/app/pull/23",
                title: "Runner PR",
                state: "OPEN",
                headRefName: "runner-branch",
            });
        };

        try {
            await loadTools(app, session, "watch_pr");
            const tools = (await (await app.conversation(session)).agent(context)).tools.map(
                (tool) => tool.name,
            );

            assert.ok(tools.includes("watch_pr"));

            for (const pr of [undefined, "23", "https://github.com/acme/app/pull/23"]) {
                calls.length = 0;
                await app.watches.start(session, owner(app).id, {
                    ...(pr === undefined ? {} : { pr }),
                    byPi: true,
                });
                const call = calls.find(({ args }) => args[0] === "pr" && args[1] === "view")!;

                assert.equal(call.cwd, undefined, "server gh never receives the runner's folder");
                assert.equal(call.args[call.args.indexOf("--repo") + 1], "acme/app");
                assert.equal(call.args[call.args.indexOf("--") + 1], pr ?? "runner-branch");
                await app.watches.stop(session);
            }
        } finally {
            await app.watches.stop(session);
            app.watches.gh = previous;
        }
    });

    it("offline is offline: a message waits for the computer, Stop ends the wait, and it goes on when back", async () => {
        await runner.stop();
        await until(() => app.runners.list()[0]?.online === false, "the runner to go");

        // Stop while it waits: the turn ends, and nothing failed on the server.
        const first = await app.commands.submit(id as never, owner(app), {
            text: "run pwd",
            requestId: crypto.randomUUID(),
        });
        const stopped = (await app.harness.submission(first.submissionId, context))!.wait(context);

        await new Promise((resolve) => setTimeout(resolve, 300));
        await app.commands.abort(id as never, owner(app));
        await stopped;

        // Sent again while offline: it waits, and runs there when the computer is back.
        const second = await app.commands.submit(id as never, owner(app), {
            text: "run pwd",
            requestId: crypto.randomUUID(),
        });
        const done = (await app.harness.submission(second.submissionId, context))!.wait(context);
        let answered = false;

        void done.then(() => (answered = true));
        await new Promise((resolve) => setTimeout(resolve, 500));
        assert.equal(answered, false);

        runner = new Runner(runnerOptions);
        runner.start();
        await done;
        assert.match(
            await lastToolText(id),
            new RegExp(there.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        );
    });
});

it("runs with exactly the remote extensions", () => {
    assert.ok(REMOTE_EXTENSIONS.includes("coding-tools"));
    assert.ok(REMOTE_EXTENSIONS.includes("pocket-background"));
});
