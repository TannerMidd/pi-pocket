import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createHandler } from "../src/server/http.ts";
import {
    cleanUp,
    context,
    fakeTab,
    modelTexts,
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

const uri = "ssh://host/work";
const remote = join(root, "remote");
const provider = (env: () => ExecutionEnv = () => new NodeExecutionEnv({ cwd: remote })) => ({
    env,
    resolveCwd: async (cwd: string) => cwd,
});

mkdirSync(remote, { recursive: true });
writeFileSync(join(remote, "AGENTS.md"), "LOCAL-ONLY-MARKER");

/** A model that runs `command` with bash for each message (`sleep` for WAIT); it keeps the prompt sections. */
function runs(command: string, sections: string[] = []) {
    return scriptedModel((request) => {
        const { messages } = request as {
            messages: { role: string; content: unknown; sections?: Record<string, string> }[];
        };
        const asked = JSON.stringify(messages.findLast((message) => message.role === "user"));

        sections.push(...messages.flatMap((message) => Object.values(message.sections ?? {})));

        return messages.at(-1)?.role === "toolResult"
            ? fauxAssistantMessage([fauxText("done")])
            : fauxAssistantMessage(
                  [
                      fauxToolCall("bash", {
                          command: asked.includes("WAIT") ? "sleep 30" : command,
                      }),
                  ],
                  { stopReason: "toolUse" },
              );
    });
}

test("a URI cwd runs in its provider, without local AGENTS.md; a local cwd stays", async () => {
    const sections: string[] = [];
    const app = await openApp(runs("pwd", sections));
    const remove = app.registerWorkspaceProvider("ssh", provider());

    try {
        const id = await newSession(app, uri);

        await say(app, id, "run");
        assert.ok((await modelTexts(app, id)).some((text) => text.includes(`${remote}\\n`)));
        assert.ok(sections.length > 0);
        assert.ok(!sections.some((text) => text.includes("LOCAL-ONLY-MARKER")));
        // An edit takes a queued message back to the composer: in a remote session too.
        await app.commands.submit(id, owner(app), { text: "WAIT", requestId: "wait-1" });
        await until(() => app.isBusy(id), "the long run");
        const queued = await app.commands.submit(id, owner(app), {
            text: "queued",
            mode: "followUp",
            requestId: "wait-2",
        });

        assert.equal(
            (await app.commands.editQueued(id, owner(app), Number(queued.submissionId))).text,
            "queued",
        );
        await app.commands.abort(id, owner(app));
        assert.ok(app.envFor(await newSession(app)) instanceof NodeExecutionEnv);
    } finally {
        remove();
        await app.close();
    }
});

test("after a restart without its provider, a remote session opens and runs nothing", async () => {
    const first = await openApp(scriptedModel());
    const remove = first.registerWorkspaceProvider("ssh", provider());
    const id = await newSession(first, uri);

    remove();
    await first.close();
    const app = await openApp(runs("pwd"), first.dataDir);
    const tab = fakeTab(id, owner(app));

    try {
        await app.attach(tab.client);
        await until(() => tab.last("view") !== undefined, "the remote session's view");
        assert.equal(tab.last("missing"), undefined);
        assert.equal(tab.field("branch"), null);
        assert.equal(app.cwdOf(id), uri);
        assert.equal(app.workspace.head(id), undefined);
        assert.throws(() => app.workspace.conversationPath(id, "secret"), /remote workspaces/);
        await assert.rejects(app.workspace.changes(id, owner(app)), /remote workspaces/);
        await assert.rejects(app.workspace.branches(id, owner(app)), /remote workspaces/);
        assert.throws(() => app.envFor(id), /No workspace provider/);
        await say(app, id, "run");
        assert.match((await modelTexts(app, id)).at(-2)!, /No workspace provider/);
    } finally {
        app.detach(tab.client);
        await app.close();
    }
});

test("the last provider wins; a disposer removes its own; a stale answer fails", async () => {
    const app = await openApp(scriptedModel());
    const [env1, env2] = [{ cwd: uri }, { cwd: uri }] as ExecutionEnv[];
    const first = app.registerWorkspaceProvider(
        "ssh",
        provider(() => env1!),
    );
    const second = app.registerWorkspaceProvider(
        "ssh",
        provider(() => env2!),
    );

    try {
        const { id } = await app.commands.createSession(owner(app), { cwd: uri });

        first();
        assert.equal(app.envFor(id), env2);
        second();
        assert.throws(() => app.envFor(id), /No workspace provider/);
        await assert.rejects(app.resolveCwd(uri), { status: 400 });

        for (const path of ["C:\\work", "D:", "c:foo", "ssh:host"]) {
            assert.equal(app.workspaceScheme(path), undefined, path);
        }

        const release = Promise.withResolvers<void>();
        const slow = app.registerWorkspaceProvider("ssh", {
            env: () => env1!,
            resolveCwd: async () => (await release.promise, uri),
        });
        const pending = app.resolveCwd(uri);

        slow();
        release.resolve();
        await assert.rejects(pending, /changed/);
        const wrong = app.registerWorkspaceProvider("ssh", {
            env: () => env1!,
            resolveCwd: async () => "file:///tmp/work",
        });

        await assert.rejects(app.resolveCwd(uri), /invalid canonical/);
        wrong();
    } finally {
        first();
        second();
        await app.close();
    }
});

test("only the owner can start, move, or link a session to a workspace URI", async () => {
    const app = await openApp(scriptedModel());
    const remove = app.registerWorkspaceProvider("ssh", provider());

    try {
        const { user } = app.config.addUser("Guest", "guest");
        const before = app.sessions().length;

        await assert.rejects(app.commands.createSession(user, { cwd: uri }), /owner/);
        assert.equal(app.sessions().length, before);
        const id = await newSession(app);
        const { submissionId } = await app.commands.submit(id, user, {
            text: "hello",
            requestId: "guest-1",
        });

        await (await app.harness.submission(submissionId, context))!.wait(context);
        await assert.rejects(app.commands.configure(id, user, { cwd: uri }), /owner/);
        assert.equal(app.cwdOf(id), work);
        await assert.rejects(
            app.linkedSessions.start(id, { message: "go", cwd: uri }, "guest-link"),
            /owner/,
        );
    } finally {
        remove();
        await app.close();
    }
});

test("a route starts a session with request.createSession only on an owner route", async () => {
    const app = await openApp(scriptedModel());

    writeFileSync(
        join(app.dataDir, "extensions", "workspace-route.ts"),
        `/** Starts sessions. */
export default (host, web) => {
    web.onDispose(host.registerWorkspaceProvider("ssh", {
        env: () => ({ cwd: ${JSON.stringify(uri)} }),
        resolveCwd: async (cwd) => cwd,
    }));
    const start = (request) => request.createSession({ cwd: request.body.cwd });
    web.route("POST", "owner", start);
    web.route("POST", "steer", start, { access: "steer" });
};`,
    );
    await app.setExtensionEnabled(owner(app), "workspace-route.ts", true);
    const server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const call = (token: string, route: string, cwd: string) =>
        fetch(`http://127.0.0.1:${port}/api/x/workspace-route/${route}`, {
            method: "POST",
            headers: {
                authorization: `Bearer ${token}`,
                "x-pocket": "1",
                "content-type": "application/json",
            },
            body: JSON.stringify({ cwd }),
        });

    try {
        const guest = app.config.addUser("Guest", "guest");
        const before = app.sessions().length;

        assert.equal((await call(guest.token, "steer", work)).status, 403);
        assert.equal(app.sessions().length, before);
        const answer = await call(app.config.ownerToken, "owner", uri);

        assert.equal(answer.status, 200);
        assert.equal(app.cwdOf(((await answer.json()) as { id: number }).id as never), uri);
    } finally {
        server.closeAllConnections();
        server.close();
        await app.close();
    }
});
