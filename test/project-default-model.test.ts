// Only the model-choice risks of project defaults; the UI was checked live.
import { type App, cleanUp, openApp, owner, root } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";

let app: App;
const pin = { defaultProvider: "faux", defaultModel: "project", defaultThinkingLevel: "high" };
const fallback = { provider: "faux", modelId: "fallback", thinkingLevel: "low" as const };

before(async () => {
    app = await openApp(
        fauxProvider({
            models: [
                { id: "project", reasoning: true },
                { id: "fallback", reasoning: true },
            ],
        }),
    );
    app.config.lastModel = { ...fallback };
});

after(async () => {
    await app?.close();
    cleanUp();
});

function project(settings: object | string, trusted = true): string {
    const cwd = mkdtempSync(join(root, "project-"));

    mkdirSync(join(cwd, ".pi"));
    writeFileSync(
        join(cwd, ".pi", "settings.json"),
        typeof settings === "string" ? settings : JSON.stringify(settings),
    );

    if (trusted) {
        new ProjectTrustStore(process.env.PI_CODING_AGENT_DIR!).set(cwd, true);
    }

    return cwd;
}

async function startsWith(cwd: string) {
    const { id } = await app.commands.createSession(owner(app), { cwd });
    const agent = await app.agentState(id);

    return { model: agent?.model?.modelId, thinking: agent?.thinkingLevel };
}

test("trusted project model and thinking apply without leaking to another project", async () => {
    const a = project(pin);
    const b = project({ ...pin, defaultModel: "fallback", defaultThinkingLevel: "medium" });

    assert.deepEqual(await startsWith(a), { model: "project", thinking: "high" });
    assert.deepEqual(await startsWith(b), { model: "fallback", thinking: "medium" });
    assert.deepEqual(await startsWith(a), { model: "project", thinking: "high" });
});

test("the explicit owner model and thinking still win", async () => {
    await app.setDefaultModel(owner(app), fallback);

    try {
        assert.deepEqual(await startsWith(project(pin)), { model: "fallback", thinking: "low" });
    } finally {
        await app.setDefaultModel(owner(app), null);
    }
});

test("untrusted settings are ignored and cannot grant themselves trust", async () => {
    const cwd = project({ ...pin, defaultProjectTrust: "always" }, false);

    assert.deepEqual(await startsWith(cwd), { model: "fallback", thinking: "low" });
});

test("broken settings and unknown models fail without creating a fallback session", async () => {
    for (const settings of ["{ broken JSON", { ...pin, defaultModel: "unknown" }]) {
        const count = app.sessions().length;

        await assert.rejects(app.commands.createSession(owner(app), { cwd: project(settings) }), {
            status: 400,
        });
        assert.equal(app.sessions().length, count);
    }
});
