import { shapeRequest } from "../src/server/anthropic-shape.ts";
import { installRequestShaping } from "../src/server/app.ts";
import type { ModelRequestShaper } from "../src/server/host.ts";
import assert from "node:assert/strict";
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

test("request shapers run after the caller's, a faulty one is skipped, and a removed one stops", async () => {
    let seen: { onPayload?: (payload: unknown, model: unknown) => unknown } | undefined;
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
    assert.equal(await seen?.onPayload?.("built", {}), "caller+shaped");
    assert.match(logged[0] ?? "", /boom/);

    shapers.length = 0;
    models.streamSimple({} as never, {} as never, undefined);
    assert.equal(seen, undefined);
});
