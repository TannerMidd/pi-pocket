import { cleanUp, newSession, openApp, say, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";

/** About 4,000 tokens. Raise it only on purpose, in the pull request that needs more. */
const LIMIT = 16_000;
/** Pi's own tools, and the owner's AGENTS.md and skills: not Pi Pocket's to count. */
const NOT_OURS = new Set(["read", "bash", "edit", "write", "project_context", "skills"]);

type Tool = { name: string; description: string; parameters: unknown };
type System = { sections?: Record<string, string>; toolsAdded?: Tool[] };

test("a new session's sections and tool schemas fit the prompt budget", async () => {
    let first: { messages: System[] } | undefined;
    const app = await openApp(
        scriptedModel((request) => {
            first ??= request as never;

            return fauxAssistantMessage([fauxText("ok")]);
        }),
    );

    await say(app, await newSession(app), "hello");
    await app.close();
    cleanUp();
    const items = first!.messages.flatMap((message) => [
        ...Object.entries(message.sections ?? {}).map(
            ([name, text]) => [name, String(text).length] as const,
        ),
        ...(message.toolsAdded ?? []).map(
            ({ name, description, parameters }) =>
                [name, JSON.stringify({ name, description, parameters }).length] as const,
        ),
    ]);
    const ours = items.filter(([name]) => !NOT_OURS.has(name)).sort((a, b) => b[1] - a[1]);
    const total = ours.reduce((sum, [, size]) => sum + size, 0);
    const names = ours.map(([name]) => name);

    // A change in the request's shape must fail here, not pass with nothing counted.
    for (const name of ["preamble", "guidelines", "artifacts", "artifact", "subagent"]) {
        assert.ok(names.includes(name), `the first request has ${name}`);
    }

    const biggest = ours.slice(0, 5).map(([name, size]) => `${name} ${size}`);

    assert.ok(
        total <= LIMIT,
        `Pi Pocket's prompt is ${total} characters, over the budget of ${LIMIT}. Biggest: ${biggest.join(", ")}. Make it smaller, or defer a tool (tool-search.ts); raise the limit only on purpose.`,
    );
});
