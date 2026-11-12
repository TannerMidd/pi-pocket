import { shapeRequest } from "../src/server/anthropic-shape.ts";
import { installRequestShaping } from "../src/server/app.ts";
import type { ModelRequestShaper } from "../src/server/host.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("a request gains one Claude Code billing header ahead of its system blocks", () => {
    const identity = { type: "text", text: "You are Claude Code, Anthropic's official CLI." };
    const payload = {
        model: "claude-opus-5-5",
        system: [identity],
        messages: [{ role: "user", content: "Please fix the failing test." }],
    };
    const shaped = shapeRequest(payload);

    assert.ok(shaped !== undefined);
    assert.match(
        shaped.system[0]?.text ?? "",
        /^x-anthropic-billing-header: cc_version=\d+\.\d+\.\d+\.\w{3}; cc_entrypoint=sdk-cli; cch=\w{5};$/,
    );
    assert.deepEqual(shaped.system.slice(1), [identity]);
    assert.equal(shapeRequest(shaped), undefined);
    assert.equal(shapeRequest({ ...payload, system: undefined }), undefined);
});

test("the billing header names the Claude Code version that pi-ai's user-agent reports", (t) => {
    if (process.env.PI_POCKET_ANTHROPIC_CC_VERSION !== undefined) {
        t.skip("PI_POCKET_ANTHROPIC_CC_VERSION overrides the version");

        return;
    }

    const entry = import.meta.resolve("@earendil-works/pi-ai");
    const transport = readFileSync(new URL("api/anthropic-messages.js", entry), "utf8");
    const reported = /claudeCodeVersion = "([\d.]+)"/.exec(transport)?.[1];
    const shaped = shapeRequest({
        system: [{ type: "text", text: "You are Claude Code, Anthropic's official CLI." }],
        messages: [{ role: "user", content: "hello" }],
    });
    const header = /cc_version=([\d.]+)\.\w{3};/.exec(shaped?.system[0]?.text ?? "")?.[1];

    assert.ok(reported !== undefined, "pi-ai's transport no longer names claudeCodeVersion");
    assert.equal(header, reported);
});

test("request shapers run after the caller's, a faulty one is skipped, and a removed one stops", async () => {
    let seen:
        | {
              onPayload?: (payload: unknown, model: unknown) => unknown;
              disableContinuation?: boolean;
          }
        | undefined;
    const models = {
        streamSimple: ((_model: unknown, _context: unknown, options: typeof seen) => {
            seen = options;

            return undefined;
        }) as never as (model: never, context: never, options?: typeof seen) => never,
    };
    const shapers: ModelRequestShaper[] = [];
    const logged: string[] = [];

    installRequestShaping(models, shapers, (line) => logged.push(line));
    shapers.push(
        () => {
            throw new Error("boom");
        },
        async (payload) => `${payload}+shaped`,
    );
    models.streamSimple({} as never, {} as never, { onPayload: () => "caller" });
    assert.equal(seen?.disableContinuation, true);
    assert.equal(await seen?.onPayload?.("built", {}), "caller+shaped");
    assert.match(logged[0] ?? "", /boom/);

    shapers.length = 0;
    models.streamSimple({} as never, {} as never, undefined);
    assert.equal(seen, undefined);
});
