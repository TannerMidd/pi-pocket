import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
    cleanUp,
    modelTexts,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    work,
} from "./helpers.ts";
import { isolatedToolBlock } from "../src/server/isolated-workspace.ts";

const { createHandler } = await import("../src/server/http.ts");

after(cleanUp);

const isolatedDir = join(root, "isolated-backing");

mkdirSync(isolatedDir, { recursive: true });

function makeIsolatedProvider(options?: { onDispose?: (cwd: string) => void }) {
    return {
        isolated: true as const,
        env: (): ExecutionEnv => new NodeExecutionEnv({ cwd: isolatedDir }),
        resolveCwd: async (cwd: string) => cwd,
        ...(options?.onDispose === undefined ? {} : { disposeWorkspace: options.onDispose }),
    };
}

function callToolOnce(name: string, args: Record<string, string | number | boolean>) {
    return scriptedModel((request) => {
        const { messages } = request as { messages: { role: string }[] };

        return messages.at(-1)?.role === "toolResult"
            ? fauxAssistantMessage([fauxText("done")])
            : fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
    });
}

test("isolatedToolBlock allows env and pure tools and blocks host-reaching tools", () => {
    for (const tool of ["read", "write", "edit", "bash", "ask", "ui", "subagent", "codemode"]) {
        assert.equal(isolatedToolBlock(tool, {}), undefined, `${tool} should be allowed`);
    }

    assert.equal(isolatedToolBlock("memory", { action: "list" }), undefined);
    assert.equal(
        isolatedToolBlock("memory", { action: "add", scope: "session", text: "note" }),
        undefined,
    );
    assert.match(
        isolatedToolBlock("memory", { action: "add", scope: "project", text: "bad" }) ?? "",
        /session-scoped/,
    );
    assert.match(
        isolatedToolBlock("memory", { action: "add", scope: "everywhere", text: "bad" }) ?? "",
        /session-scoped/,
    );
    assert.match(
        isolatedToolBlock("memory", { action: "remove", id: "1" }) ?? "",
        /session-scoped/,
    );

    assert.equal(isolatedToolBlock("artifact", { title: "Demo", html: "<p>hi</p>" }), undefined);
    assert.match(
        isolatedToolBlock("artifact", { title: "Bad", path: "/etc/passwd" }) ?? "",
        /host file paths/,
    );
    assert.match(
        isolatedToolBlock("artifact", {
            title: "Bad",
            assets: [{ name: "a", path: "/etc/passwd" }],
        }) ?? "",
        /host file paths/,
    );

    for (const blocked of [
        "browser",
        "team",
        "background",
        "watch_pr",
        "design_export",
        "relay_reply",
        "mcp_custom_tool",
    ]) {
        assert.match(isolatedToolBlock(blocked, {}) ?? "", /blocked in an isolated sandbox/);
    }
});

test("isolated workspace blocks host tools, host browser, and host commandEnv while allowing env tools", async () => {
    const app = await openApp(
        callToolOnce("browser", { action: "navigate", url: "http://127.0.0.1" }),
    );
    const removeProvider = app.registerWorkspaceProvider("sandbox", makeIsolatedProvider());
    const removeEnv = app.commandEnvs.add(() => ({ HOST_SECRET_TOKEN: "top-secret-value" }));

    try {
        // Offer all tools directly (without tool_search deferral) so `browser` reaches core's beforeTool gate.
        await app.setExtensionEnabled(owner(app), "tool-search.ts", false);
        const uri = "sandbox://sb1/workspace";
        const id = await newSession(app, uri);

        assert.equal(app.isIsolatedWorkspace(uri), true);
        assert.equal(app.isIsolatedConversation(id), true);

        // Host browser tool is blocked by core beforeTool hook even when guard is off.
        await say(app, id, "open localhost");
        const texts = await modelTexts(app, id);

        assert.ok(
            texts.some((t) => /blocked in an isolated sandbox/i.test(t)),
            `expected browser block in ${JSON.stringify(texts)}`,
        );

        // Host commandEnv is NOT injected into isolated ExecutionEnv, but IS injected into plain sessions.
        const isoEnv = app.envFor(id);
        let isoOut = "";
        const isoRes = await isoEnv.exec(
            'printf "%s" "${HOST_SECRET_TOKEN:-unset}"',
            { onOutput: (chunk) => (isoOut += chunk) },
            { abortSignal: undefined } as never,
        );

        assert.equal(isoRes.ok, true);
        assert.equal(isoOut, "unset");

        const plainId = await newSession(app, work);
        const plainEnv = app.envFor(plainId);
        let plainOut = "";
        const plainRes = await plainEnv.exec(
            'printf "%s" "${HOST_SECRET_TOKEN:-unset}"',
            { onOutput: (chunk) => (plainOut += chunk) },
            { abortSignal: undefined } as never,
        );

        assert.equal(plainRes.ok, true);
        assert.equal(plainOut, "top-secret-value");

        // HTTP host browser routes fail closed for isolated sessions.
        const server = createServer(
            createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
        );

        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

        try {
            const addr = server.address() as { port: number };
            const base = `http://127.0.0.1:${addr.port}`;
            const token = app.config.ownerToken;
            const headers = {
                cookie: `pocket_auth=${token}`,
                "x-pocket": "1",
                "content-type": "application/json",
            };

            const stateRes = await fetch(`${base}/api/c/${id}/browser`, { headers });

            assert.equal(stateRes.status, 200);
            const stateBody = (await stateRes.json()) as { available: boolean; problem?: string };

            assert.equal(stateBody.available, false);
            assert.match(stateBody.problem ?? "", /isolated sandbox/);

            const navRes = await fetch(`${base}/api/c/${id}/browser/navigate`, {
                method: "POST",
                headers,
                body: JSON.stringify({ url: "http://127.0.0.1" }),
            });

            assert.equal(navRes.status, 403);
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    } finally {
        removeEnv();
        removeProvider();
        await app.close();
    }
});

test("isolated sessions cannot be moved across the boundary or escape via linked sessions", async () => {
    const app = await openApp(scriptedModel());
    const disposed: string[] = [];
    const remove = app.registerWorkspaceProvider(
        "sandbox",
        makeIsolatedProvider({ onDispose: (cwd) => disposed.push(cwd) }),
    );

    try {
        const uri = "sandbox://sb2/workspace";
        const isoId = await newSession(app, uri);
        const plainId = await newSession(app, work);

        // Moving isolated -> host is refused.
        await assert.rejects(
            app.commands.configure(isoId, owner(app), { cwd: work }),
            /Isolated sandbox sessions cannot be moved/,
        );

        // Moving host -> isolated is refused.
        await assert.rejects(
            app.commands.configure(plainId, owner(app), { cwd: uri }),
            /Isolated sandbox sessions cannot be moved/,
        );

        // Unregistered provider fails closed as isolated.
        remove();
        assert.equal(app.isIsolatedWorkspace(uri), true);
        assert.throws(() => app.envFor(isoId), /No workspace provider/);
    } finally {
        remove();
        await app.close();
    }

    // Re-test disposeWorkspace on archive when no other active session shares the URI.
    const app2 = await openApp(scriptedModel());
    const disposed2: string[] = [];
    const remove2 = app2.registerWorkspaceProvider(
        "sandbox",
        makeIsolatedProvider({ onDispose: (cwd) => disposed2.push(cwd) }),
    );

    try {
        const uri = "sandbox://sb3/workspace";
        const first = await newSession(app2, uri);
        const second = await newSession(app2, uri);

        await app2.commands.updateSession(first, owner(app2), { archived: true });
        assert.deepEqual(disposed2, []);

        await app2.commands.updateSession(second, owner(app2), { archived: true });
        assert.deepEqual(disposed2, [uri]);
    } finally {
        remove2();
        await app2.close();
    }
});

test("isolated workspace restricts memory tool to session scope only", async () => {
    const app = await openApp(
        callToolOnce("memory", {
            action: "add",
            scope: "everywhere",
            text: "poison global memory",
        }),
    );
    const remove = app.registerWorkspaceProvider("sandbox", makeIsolatedProvider());

    try {
        const id = await newSession(app, "sandbox://sb-mem/workspace");

        await say(app, id, "remember globally");
        const texts = await modelTexts(app, id);

        assert.ok(
            texts.some((t) => /session-scoped/i.test(t)),
            `expected session-scoped memory block in ${JSON.stringify(texts)}`,
        );
    } finally {
        remove();
        await app.close();
    }
});
