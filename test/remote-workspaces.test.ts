import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { IncomingMessage, ServerResponse } from "node:http";
import { Duplex } from "node:stream";
import { once } from "node:events";
import { join } from "node:path";
import { AgentDoc } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
    cleanUp,
    context,
    fakeTab,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
    work,
} from "./helpers.ts";
import { SessionsDoc } from "../src/server/docs.ts";

const scheme = "testremote";
const cwd = `${scheme}://box/work`;
const MODULE = `/** Tests remote workspace isolation. */
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
export default (host, web) => {
    const remote = ${JSON.stringify("REMOTE_ROOT")};
    const unregister = host.registerWorkspaceProvider("testremote", {
        env: () => new NodeExecutionEnv({ cwd: remote }),
        resolveCwd: async (value) => value === "testremote://box/work" ? value : (() => { throw new Error("Unknown workspace"); })(),
    });
    web.onDispose(unregister);
    web.route("POST", "session", async (request) => {
        const { cwd, title } = request.body;
        const session = await request.createSession({ cwd, ...(title === undefined ? {} : { title }) });
        return { id: session.id };
    });
};`;

after(cleanUp);

test("a remote conversation opens without local Git metadata, even with its provider offline", async () => {
    const app = await openApp(scriptedModel());
    const uri = "viewremote://host/work";
    const remove = app.registerWorkspaceProvider("viewremote", {
        env: () => new NodeExecutionEnv({ cwd: work }),
        resolveCwd: async () => uri,
    });
    const { id } = await app.commands.createSession(owner(app), { cwd: uri });
    const tab = fakeTab(id, owner(app));

    try {
        remove();
        await app.attach(tab.client);
        assert.equal(
            tab.last("missing"),
            undefined,
            "opening the remote conversation must not fail",
        );
        await until(() => tab.last("view") !== undefined, "the remote conversation view");
        assert.equal(tab.field("branch"), null);
        assert.equal(
            (tab.last("view")!.conversation as { inRepository: boolean }).inRepository,
            false,
        );
        assert.equal(app.workspace.head(id), undefined);
        assert.equal(app.workspace.inRepository(uri), false);
        await assert.rejects(app.workspace.branches(id, owner(app)), /remote workspaces/i);
        await assert.rejects(app.workspace.changes(id, owner(app)), /remote workspaces/i);
        await assert.rejects(
            app.workspace.switchBranch(id, owner(app), { name: "main" }),
            /remote workspaces/i,
        );
    } finally {
        app.detach(tab.client);
        remove();
        await app.close();
    }
});

test("workspace provider replacement preserves the current provider and rejects stale resolution", async () => {
    const app = await openApp(scriptedModel());
    const uri = "replacement://host/work";
    const firstEnv = new NodeExecutionEnv({ cwd: work });
    const secondEnv = new NodeExecutionEnv({ cwd: root });
    const first = app.registerWorkspaceProvider("replacement", {
        env: () => firstEnv,
        resolveCwd: async () => uri,
    });
    const second = app.registerWorkspaceProvider("replacement", {
        env: () => secondEnv,
        resolveCwd: async () => uri,
    });

    try {
        const session = await app.commands.createSession(owner(app), { cwd: uri });

        first();
        assert.equal(app.envFor(session.id), secondEnv);
        second();
        assert.throws(() => app.envFor(session.id), /provider/i);
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const remove = app.registerWorkspaceProvider("replacement", {
            env: () => firstEnv,
            resolveCwd: async () => {
                entered.resolve();
                await release.promise;

                return uri;
            },
        });
        const resolving = app.resolveCwd(uri);

        await entered.promise;
        remove();
        release.resolve();
        await assert.rejects(resolving, /changed|provider/i);
    } finally {
        first();
        second();
        await app.close();
    }
});

test("an extension route cannot create a remote session after its client disconnects", async () => {
    const app = await openApp(scriptedModel());
    const marker = join(root, `remote-route-resolving-${crypto.randomUUID()}`);
    const uri = "routecancel://host/work";
    const source = `/** Tests canceled remote session admission. */
import { writeFileSync } from "node:fs";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
export default (host, web) => {
    host.registerWorkspaceProvider("routecancel", {
        env: () => new NodeExecutionEnv({ cwd: ${JSON.stringify(work)} }),
        resolveCwd: async (cwd) => {
            writeFileSync(${JSON.stringify(marker)}, "entered");
            await new Promise((resolve) => setTimeout(resolve, 150));
            return cwd;
        },
    });
    web.route("POST", "session", async (request) =>
        request.createSession({ cwd: request.body.cwd }),
    );
};`;
    const extension = join(app.dataDir, "extensions", "remote-route-cancel.ts");

    writeFileSync(extension, source);
    await app.setExtensionEnabled(owner(app), "remote-route-cancel.ts", true);

    const socket = new Duplex({
        read() {},
        write(_chunk, _encoding, done) {
            done();
        },
    });
    const request = new IncomingMessage(socket as never);

    request.url = "/api/x/remote-route-cancel/session";
    request.method = "POST";
    request.headers = {
        authorization: `Bearer ${app.config.ownerToken}`,
        "x-pocket": "1",
        "content-type": "application/json",
    };
    request.push(Buffer.from(JSON.stringify({ cwd: uri })));
    request.push(null);
    request.complete = true;
    const response = new ServerResponse(request);

    response.assignSocket(socket as never);
    const handle = await import("../src/server/http.ts");
    const serve = handle.createHandler({
        app,
        listen: { host: "127.0.0.1", port: 0 },
        restart: () => {},
    });
    const count = app.sessions().length;
    const handling = serve(request, response);

    try {
        await until(() => {
            try {
                return readFileSync(marker, "utf8") === "entered";
            } catch {
                return false;
            }
        }, "the delayed workspace resolution");
        socket.destroy();
        await handling;
        await new Promise((resolve) => setTimeout(resolve, 200));

        assert.equal(app.sessions().length, count);
    } finally {
        socket.destroy();
        await app.close();
    }
});

test("configure keeps agent and session cwd together when cancellation follows publication", async () => {
    const app = await openApp(scriptedModel());
    const uri = "configurecancel://host/work";
    const remove = app.registerWorkspaceProvider("configurecancel", {
        env: () => new NodeExecutionEnv({ cwd: work }),
        resolveCwd: async () => uri,
    });
    const session = await app.commands.createSession(owner(app), { cwd: work });
    const controller = new AbortController();
    const unsubscribe = app.harness.subscribeCommits((publication) => {
        if (
            publication.changes.some(
                (change) =>
                    change.type === "document" &&
                    change.conversationId === session.id &&
                    change.value?.cwd === uri,
            )
        ) {
            controller.abort();
        }
    });

    try {
        await assert.rejects(
            app.commands.configure(
                session.id,
                owner(app),
                { cwd: uri },
                { signal: controller.signal },
            ),
        );

        assert.equal((await app.harness.snapshot(AgentDoc, session.id, context))?.cwd, uri);
        assert.equal(
            (await app.harness.snapshot(SessionsDoc, context))?.items[String(session.id)]?.cwd,
            uri,
        );
    } finally {
        unsubscribe();
        remove();
        await app.close();
    }
});

test("remote resolution cannot create after cancellation or configure after access revocation", async () => {
    const app = await openApp(scriptedModel());
    const uri = "cancelremote://host/work";
    let entered = Promise.withResolvers<void>();
    let release = Promise.withResolvers<void>();
    const remove = app.registerWorkspaceProvider("cancelremote", {
        env: () => new NodeExecutionEnv({ cwd: work }),
        resolveCwd: async () => {
            entered.resolve();
            await release.promise;

            return uri;
        },
    });

    try {
        const count = app.sessions().length;
        const controller = new AbortController();
        const creating = app.commands.createSession(
            owner(app),
            { cwd: uri },
            { signal: controller.signal },
        );

        await entered.promise;
        controller.abort();
        release.resolve();
        await assert.rejects(creating);
        assert.equal(app.sessions().length, count);
        const local = await app.commands.createSession(owner(app), { cwd: work });
        const { user } = app.config.addUser("Temporary remote driver", "guest");

        entered = Promise.withResolvers<void>();
        release = Promise.withResolvers<void>();
        const configuring = app.commands.configure(local.id, user, { cwd: uri });

        await entered.promise;
        app.config.removeUser(user.id);
        release.resolve();
        await assert.rejects(configuring, /access|user|session/i);
        assert.equal(app.cwdOf(local.id), work);
    } finally {
        remove();
        await app.close();
    }
});

test("remote workspaces isolate tools, persist, fail closed, and preserve local sessions", async () => {
    const modelCalls = [
        [fauxToolCall("write", { path: "created.txt", content: "remote-write" })],
        [fauxToolCall("read", { path: "created.txt" })],
        [
            fauxToolCall("edit", {
                path: "created.txt",
                oldText: "remote-write",
                newText: "remote-edit",
            }),
        ],
        [
            fauxToolCall("bash", {
                command: [
                    "printf remote-bash > bash.txt",
                    "git init -q",
                    "git add created.txt",
                    "git -c user.name=Test -c user.email=test@example.com commit -qm 'Remote fixture'",
                    "git switch -qc remote-branch",
                    "git rev-parse --show-toplevel > git-root.txt",
                    "git branch --show-current > git-branch.txt",
                    "git status --porcelain > git-status.txt",
                ].join(" && "),
            }),
        ],
        [fauxToolCall("bash", { command: "printf local-leak > forbidden.txt" })],
    ];
    let nextCall = 0;
    const model = scriptedModel(() => {
        const calls = modelCalls[nextCall++];

        return calls === undefined
            ? fauxAssistantMessage([])
            : fauxAssistantMessage(calls, { stopReason: "toolUse" });
    });
    let app = await openApp(model);
    const remoteRoot = join(root, "remote-fixture");

    mkdirSync(remoteRoot, { recursive: true });
    const extFile = join(app.dataDir, "extensions", "remote-workspaces.ts");

    writeFileSync(extFile, MODULE.replace("REMOTE_ROOT", remoteRoot));
    await app.setExtensionEnabled(owner(app), "remote-workspaces.ts", true);

    const call = async (token: string, route: string, body?: unknown) => {
        const chunks: Buffer[] = [];
        const socket = new Duplex({
            read() {},
            write(chunk, _encoding, done) {
                chunks.push(Buffer.from(chunk));
                done();
            },
        });
        const request = new IncomingMessage(socket as never);

        request.url = `/api/x/remote-workspaces/${route}`;
        request.method = body === undefined ? "GET" : "POST";
        request.headers = {
            authorization: `Bearer ${token}`,
            "x-pocket": "1",
            "content-type": "application/json",
        };

        if (body !== undefined) {
            request.push(Buffer.from(JSON.stringify(body)));
        }

        request.push(null);
        request.complete = true;
        const response = new ServerResponse(request);

        response.assignSocket(socket as never);
        const finished = once(response, "finish");

        await (
            await import("../src/server/http.ts")
        ).createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} })(
            request,
            response,
        );
        await finished;
        const raw = Buffer.concat(chunks).toString();

        return { status: response.statusCode, text: raw.split("\r\n\r\n").at(-1) ?? "" };
    };

    try {
        const created = await call(app.config.ownerToken, "session", { cwd, title: "Remote root" });

        assert.equal(created.status, 200);
        const id = JSON.parse(created.text).id;

        assert.ok(id);
        assert.equal(app.cwdOf(id), cwd);

        app.config.lastModel ??= { provider: "faux", modelId: "faux-1", thinkingLevel: "off" };
        await app.commands.configure(id, owner(app), {
            model: { provider: "faux", modelId: "faux-1" },
            thinkingLevel: "off",
        });

        for (const instruction of ["write", "read", "edit", "bash"]) {
            const { submissionId } = await app.commands.submit(id, owner(app), {
                text: instruction,
                requestId: crypto.randomUUID(),
            });

            await (await app.harness.submission(submissionId, context))!.wait(context);
        }

        assert.equal(readFileSync(join(remoteRoot, "created.txt"), "utf8"), "remote-edit");
        assert.equal(readFileSync(join(remoteRoot, "bash.txt"), "utf8"), "remote-bash");
        assert.equal(readFileSync(join(remoteRoot, "git-root.txt"), "utf8").trim(), remoteRoot);
        assert.equal(
            readFileSync(join(remoteRoot, "git-branch.txt"), "utf8").trim(),
            "remote-branch",
        );
        assert.match(readFileSync(join(remoteRoot, "git-status.txt"), "utf8"), /bash\.txt/);
        assert.equal((await import("node:fs")).existsSync(join(work, ".git")), false);
        assert.equal((await import("node:fs")).existsSync(join(work, "created.txt")), false);
        assert.equal((await import("node:fs")).existsSync(join(work, "bash.txt")), false);

        await app.close();
        app = await openApp(model, app.dataDir);
        assert.equal(app.cwdOf(id), cwd);
        const guest = app.config.addUser("Remote guest", "guest");

        assert.equal((await call(guest.token, "session", { cwd })).status, 404);

        await app.setExtensionEnabled(owner(app), "remote-workspaces.ts", false);
        assert.throws(() => app.envFor(id), /workspace|provider|remote|directory/i);
        const { submissionId } = await app.commands.submit(id, owner(app), {
            text: "Attempt a command without its provider",
            requestId: crypto.randomUUID(),
        });

        await (await app.harness.submission(submissionId, context))!.wait(context);
        assert.ok(nextCall > 8, "the session attempted the scripted command after reopening");
        assert.equal((await import("node:fs")).existsSync(join(work, "forbidden.txt")), false);
        assert.equal((await import("node:fs")).existsSync(join(work, "bash.txt")), false);

        const local = await app.commands.createSession(owner(app), { cwd: work });

        assert.equal(app.cwdOf(local.id), work);
        const localEnv = app.envFor(local.id);

        assert.ok(localEnv instanceof NodeExecutionEnv);
    } finally {
        await app.close();
    }
});
