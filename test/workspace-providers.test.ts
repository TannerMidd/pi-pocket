import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { IncomingMessage, ServerResponse } from "node:http";
import { Duplex } from "node:stream";
import { once } from "node:events";
import { join } from "node:path";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
    cleanUp,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
    work,
} from "./helpers.ts";

after(cleanUp);

function fakeEnv(): ExecutionEnv {
    return { cwd: "ssh://host/work" } as ExecutionEnv;
}

test("workspace providers fail closed and preserve registration ownership", async () => {
    const app = await openApp(scriptedModel());
    const uri = "ssh://host/work";
    const env1 = fakeEnv();
    const env2 = fakeEnv();
    const first = app.registerWorkspaceProvider("ssh", {
        env: () => env1,
        resolveCwd: async (cwd) => cwd,
    });
    const second = app.registerWorkspaceProvider("ssh", {
        env: () => env2,
        resolveCwd: async (cwd) => cwd,
    });

    try {
        const session = await app.commands.createSession(owner(app), { cwd: uri });

        first();
        assert.equal(app.envFor(session.id), env2);
        second();
        assert.throws(() => app.envFor(session.id), /provider/i);
        await assert.rejects(app.resolveCwd("removed://host/path"), { status: 400 });
    } finally {
        first();
        second();
        await app.close();
    }
});

test("workspace resolution rejects changed providers, wrong schemes, and aborts", async () => {
    const app = await openApp(scriptedModel());
    const uri = "ssh://host/work";
    const env = fakeEnv();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const remove = app.registerWorkspaceProvider("ssh", {
        env: () => env,
        resolveCwd: async () => {
            entered.resolve();
            await release.promise;

            return uri;
        },
    });

    try {
        const pending = app.resolveCwd(uri);

        await entered.promise;
        remove();
        release.resolve();
        await assert.rejects(pending, /changed|provider/i);
        const wrongScheme = app.registerWorkspaceProvider("ssh", {
            env: () => env,
            resolveCwd: async () => "file:///tmp/work",
        });

        await assert.rejects(app.resolveCwd(uri), /canonical|scheme/i);
        wrongScheme();
        const controller = new AbortController();
        const cancelled = app.registerWorkspaceProvider("cancel", {
            env: () => env,
            resolveCwd: async (_cwd, signal) => {
                await new Promise((resolve) => setTimeout(resolve, 20));
                signal?.throwIfAborted();

                return "cancel://host/work";
            },
        });
        const resolving = app.resolveCwd("cancel://host/work", controller.signal);

        controller.abort();
        await assert.rejects(resolving, { name: "AbortError" });
        cancelled();
    } finally {
        remove();
        await app.close();
    }
});

test("remote addresses never enter local path or Git operations", async () => {
    const app = await openApp(scriptedModel());
    const uri = "ssh://host/work";
    const remove = app.registerWorkspaceProvider("ssh", {
        env: fakeEnv,
        resolveCwd: async (cwd) => cwd,
    });

    try {
        const { id } = await app.commands.createSession(owner(app), { cwd: uri });

        assert.equal(app.cwdOf(id), uri);
        assert.equal(app.workspace.inRepository(uri), false);
        assert.equal(app.workspace.head(id), undefined);
        assert.throws(() => app.workspace.conversationPath(id, "secret"), /remote workspaces/i);
        await assert.rejects(app.workspace.changes(id, owner(app)), /remote workspaces/i);
        await assert.rejects(app.workspace.branches(id, owner(app)), /remote workspaces/i);
        assert.equal(app.workspace.checkDirectory(work), work);
    } finally {
        remove();
        await app.close();
    }
});

test("owner-only route session creation rejects guests and creates no extra session", async () => {
    const app = await openApp(scriptedModel());
    const uri = "ssh://host/work";
    const file = join(app.dataDir, "extensions", "workspace-route.ts");

    writeFileSync(
        file,
        `/** Tests workspace route session creation. */
export default (host, web) => {
    host.registerWorkspaceProvider("ssh", {
        env: () => ({ cwd: ${JSON.stringify(uri)} }),
        resolveCwd: async (cwd) => cwd,
    });
    web.route("POST", "session", (request) => request.createSession({ cwd: request.body.cwd }), { access: "owner" });
};`,
    );
    await app.setExtensionEnabled(owner(app), "workspace-route.ts", true);

    const call = async (token: string) => {
        const chunks: Buffer[] = [];
        const socket = new Duplex({
            read() {},
            write(chunk, _encoding, done) {
                chunks.push(Buffer.from(chunk));
                done();
            },
        });
        const request = new IncomingMessage(socket as never);

        request.url = "/api/x/workspace-route/session";
        request.method = "POST";
        request.headers = {
            authorization: `Bearer ${token}`,
            "x-pocket": "1",
            "content-type": "application/json",
        };
        request.push(Buffer.from(JSON.stringify({ cwd: uri })));
        request.push(null);
        request.complete = true;
        const response = new ServerResponse(request);

        response.assignSocket(socket as never);
        const finished = once(response, "finish");
        const { createHandler } = await import("../src/server/http.ts");

        await createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} })(
            request,
            response,
        );
        await finished;

        const raw = Buffer.concat(chunks).toString();

        return { status: response.statusCode, text: raw.split("\r\n\r\n").at(-1) ?? "" };
    };

    try {
        const guest = app.config.addUser("Workspace guest", "guest");
        const before = app.sessions().length;

        assert.equal((await call(guest.token)).status, 404);
        assert.equal(app.sessions().length, before);
        const answer = await call(app.config.ownerToken);

        assert.equal(answer.status, 200);
        assert.equal(app.sessions().length, before + 1);
        assert.equal(app.cwdOf(JSON.parse(answer.text).id), uri);
    } finally {
        await app.close();
    }
});

test("only the owner can start or move a session to a workspace URI", async () => {
    const app = await openApp(scriptedModel());
    const uri = "ssh://host/work";
    const remove = app.registerWorkspaceProvider("ssh", {
        env: fakeEnv,
        resolveCwd: async (cwd) => cwd,
    });

    try {
        const { user } = app.config.addUser("Workspace guest", "guest");
        const before = app.sessions().length;

        await assert.rejects(app.commands.createSession(user, { cwd: uri }), /owner/i);
        assert.equal(app.sessions().length, before);

        const local = await app.commands.createSession(user, { cwd: work });

        await assert.rejects(app.commands.configure(local.id, user, { cwd: uri }), /owner/i);
        assert.equal(app.cwdOf(local.id), work);
    } finally {
        remove();
        await app.close();
    }
});

test("a remote session's prompt has no AGENTS.md from this machine", async () => {
    const remote = join(root, "remote-prompt");
    let sections: string[] = [];

    mkdirSync(remote, { recursive: true });
    writeFileSync(join(remote, "AGENTS.md"), "LOCAL-ONLY-MARKER");
    const app = await openApp(
        scriptedModel((request) => {
            const messages = (request as { messages: { sections?: Record<string, string> }[] })
                .messages;

            sections = messages.flatMap((message) => Object.values(message.sections ?? {}));

            return fauxAssistantMessage([fauxText("ok")]);
        }),
    );
    const remove = app.registerWorkspaceProvider("ssh", {
        env: () => new NodeExecutionEnv({ cwd: remote }),
        resolveCwd: async (cwd) => cwd,
    });

    try {
        await say(app, await newSession(app, "ssh://host/work"), "hello");
        assert.ok(sections.length > 0, "the request has sections");
        assert.ok(!sections.some((text) => text.includes("LOCAL-ONLY-MARKER")));
    } finally {
        remove();
        await app.close();
    }
});

test("an edit of a queued message in a remote session gives the message back", async () => {
    const app = await openApp(
        scriptedModel((request) =>
            (request as { messages: { role: string }[] }).messages.at(-1)?.role === "toolResult"
                ? fauxAssistantMessage([fauxText("done")])
                : fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 30" })], {
                      stopReason: "toolUse",
                  }),
        ),
    );
    const remove = app.registerWorkspaceProvider("ssh", {
        env: () => new NodeExecutionEnv({ cwd: root }),
        resolveCwd: async (cwd) => cwd,
    });

    try {
        const id = await newSession(app, "ssh://host/work");

        await app.commands.submit(id, owner(app), { text: "wait", requestId: "wait-1" });
        await until(() => app.isBusy(id), "the long run");
        const { submissionId } = await app.commands.submit(id, owner(app), {
            text: "queued",
            mode: "followUp",
            requestId: "wait-2",
        });
        const edited = await app.commands.editQueued(id, owner(app), Number(submissionId));

        assert.equal(edited.text, "queued");
        await app.commands.abort(id, owner(app));
    } finally {
        remove();
        await app.close();
    }
});
