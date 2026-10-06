// Codemode: scripts call the conversation's tools through the same steps as direct calls, hooks included.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import {
    defineExtension,
    defineTool,
    hook,
    ToolTask,
    type ToolRegistration,
} from "@earendil-works/pi-durable";
import { CodemodeStoreDoc } from "../src/server/docs.ts";
import createCodemode from "../src/server/extensions/codemode.ts";
import createGuard from "../src/server/extensions/guard.ts";
import { Approvals, type PocketHost } from "../src/server/host.ts";

const context = BACKGROUND_CONTEXT;

const echo = defineTool({
    name: "echo",
    description: "Echo text",
    parameters: Type.Object({ text: Type.String() }),
    execute: async (args) => ({ content: [{ type: "text", text: `echo:${args.text}` }] }),
});
/** Streams its output and returns no content, like bash. */
const shell = defineTool({
    name: "bash",
    description: "Run a command",
    parameters: Type.Object({ command: Type.String() }),
    outputLimits: { retain: "tail" },
    execute: async (args, api) => {
        api.output(`ran ${args.command}`);
        api.output(new TextEncoder().encode(" ✓"));

        return args.command === "fail" ? { isError: true } : {};
    },
});

type Fake = ReturnType<typeof fakeApi>;

/** Just enough of a tool invocation for codemode: memos, the store document, and the agent's tools and hooks. */
function fakeApi(tools: ToolRegistration[], extensions: ReturnType<typeof defineExtension>[] = []) {
    const memos = new Map<string, unknown>();
    const store = { values: {} as Record<string, unknown> };

    const memo = async (name: string, ...rest: unknown[]) => {
        if (rest.length === 1) {
            return memos.get(name);
        }

        if (!memos.has(name)) {
            memos.set(name, rest[0]);
        }

        return memos.get(name);
    };

    return {
        memos,
        store,
        api: {
            taskId: 41,
            conversationId: 3,
            callId: "call-1",
            env: undefined,
            agent: async () => ({
                tools: [...tools, codemodeTool],
                extensions,
                sections: [],
                thinkingLevel: "off",
            }),
            output: () => {},
            diagnostic: () => {},
            details: async () => {},
            memo,
            snapshot: async (doc: { definition?: { kind: string } }) =>
                doc === CodemodeStoreDoc ? store : undefined,
            commit: async (change: (tx: unknown) => unknown) => change({ doc: async () => store }),
        },
    };
}

const host = { approvals: new Approvals(() => undefined) } as unknown as PocketHost;
const codemodeTool = createCodemode(host).tools![0]!;

const run = async (fake: Fake, code: string) => {
    const result = await codemodeTool.execute({ code } as never, fake.api as never, context);

    return {
        ...result,
        text: (result.content ?? [])
            .map((part) => (part.type === "text" ? part.text : ""))
            .join(""),
    };
};

test("a script calls tools, gets their text, and returns a value", async () => {
    const fake = fakeApi([echo, shell]);
    const result = await run(
        fake,
        `const a = await tools.echo({ text: "hi" }); const b = await tools.bash({ command: "ls" }); text(ALL_TOOLS.map((t) => t.name).join(",")); return [a, b];`,
    );

    assert.equal(result.isError, undefined);
    assert.match(result.text, /^Script completed\nWall time [\d.]+ seconds\nOutput:\n/);
    assert.match(result.text, /echo,bash/, "codemode cannot call itself");
    assert.match(result.text, /\["echo:hi","ran ls ✓"\]/);
    assert.deepEqual(
        (result.details as { calls: { name: string; status: string }[] }).calls.map((call) => [
            call.name,
            call.status,
        ]),
        [
            ["echo", "ok"],
            ["bash", "ok"],
        ],
    );
});

test("nested calls are checked like direct ones: bad arguments, errors, and hooks that rewrite or block", async () => {
    const seen: string[] = [];
    const policy = defineExtension({
        name: "policy",
        hooks: [
            hook(ToolTask, {
                beforeTool: async (call, api, ctx) => {
                    // Each nested call has its own memos.
                    seen.push(String(await api.memo("visit", call.id, ctx)));
                    const command = (call.arguments as { command?: string }).command;

                    if (command === "rm -rf /") {
                        return { block: "not that" };
                    }

                    if (command === "boom") {
                        throw new Error("hook failed");
                    }

                    if (command === "short") {
                        return { arguments: { command: "rewritten" } };
                    }

                    return undefined;
                },
                afterTool: async (call, result) =>
                    call.name === "echo"
                        ? { ...result, content: [{ type: "text", text: "replaced" }] }
                        : undefined,
            }),
        ],
    });
    const fake = fakeApi([echo, shell], [policy]);
    const result = await run(
        fake,
        `const outcomes = await Promise.allSettled([
			tools.bash({ command: "rm -rf /" }),
			tools.bash({ command: "boom" }),
			tools.bash({ command: "short" }),
			tools.bash({ command: "fail" }),
			tools.bash({ nope: 1 }),
			tools.echo({ text: "x" }),
		]);
		return outcomes.map((o) => o.status === "fulfilled" ? o.value : "ERR " + o.reason.message);`,
    );
    const values = JSON.parse(result.text.split("Output:\n")[1]!) as string[];

    assert.equal(values[0], "ERR Tool call blocked: not that");
    assert.equal(values[1], "ERR Tool call blocked: hook failed");
    assert.equal(values[2], "ran rewritten ✓");
    assert.equal(values[3], "ERR ran fail ✓");
    assert.match(
        values[4]!,
        /^ERR Validation failed for tool "bash":[\s\S]*required properties command/,
    );
    assert.equal(values[5], "replaced");
    assert.deepEqual(
        new Set(seen),
        new Set(["call-1/1", "call-1/2", "call-1/3", "call-1/4", "call-1/6"]),
        "the invalid call never reached the hooks",
    );
    assert.ok([...fake.memos.keys()].every((key) => /^codemode\/\d+\/visit$/.test(key)));
});

test("store() values last across scripts; failed scripts keep their output and change nothing", async () => {
    const fake = fakeApi([echo]);

    await run(
        fake,
        `store("count", (load("count") ?? 0) + 1); store("gone", 1); store("gone", undefined);`,
    );
    await run(fake, `store("count", load("count") + 1);`);
    assert.deepEqual(fake.store.values, { count: 2 });
    const failed = await run(
        fake,
        `store("count", 99); text("partial"); await tools.echo({ text: "y" }); throw new Error("oops");`,
    );

    assert.equal(failed.isError, true);
    assert.match(
        failed.text,
        /^Script failed[\s\S]*partial[\s\S]*Script error:\nError: oops[\s\S]*Tool calls made before the failure \(they are not undone\): echo \(ok\)/,
    );
    assert.deepEqual(fake.store.values, { count: 2 });
});

test("output over the budget keeps its start and end, and saves the whole", async () => {
    const fake = fakeApi([]);
    const result = await run(
        fake,
        `// @options: {"max_output_tokens": 50}\ntext("A".repeat(150) + "B".repeat(150));`,
    );

    assert.match(result.text, /Warning: output truncated/);
    assert.match(
        result.text,
        /^[\s\S]*A{20}[\s\S]*B{20}[\s\S]*\[Full output: [^\]]*pi-pocket-codemode-[0-9a-f]+\.txt/,
    );
});

test("with Lancet Guard asking, each nested call waits for its own answer, even in parallel", async () => {
    const approvals = new Approvals(() => undefined);
    const guardHost = {
        approvals,
        guard: {
            judge: async (_tool: string, args: { command: string }) => ({
                subject: args.command,
                decision: { action: "ask", source: "test", reason: "risky" },
            }),
        },
    } as unknown as PocketHost;
    const guard = createGuard(guardHost);
    const fake = fakeApi([shell], [guard]);
    const running = run(
        fake,
        `const [a, b] = await Promise.allSettled([tools.bash({ command: "one" }), tools.bash({ command: "two" })]);
		return [a.status === "fulfilled" ? a.value : a.reason.message, b.status === "fulfilled" ? b.value : b.reason.message];`,
    );
    let pending = approvals.all();

    for (let index = 0; index < 200 && pending.length < 2; index++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        pending = approvals.all();
    }

    assert.equal(pending.length, 2, "both calls ask");
    assert.notEqual(pending[0]!.id, pending[1]!.id);
    const one = pending.find((request) => request.subject === "one")!;
    const two = pending.find((request) => request.subject === "two")!;

    assert.ok(approvals.answer(one.id, { allow: true, by: "Alex" }));
    assert.ok(approvals.answer(two.id, { allow: false, by: "Sam" }));
    const result = await running;
    const [first, second] = JSON.parse(result.text.split("Output:\n")[1]!) as string[];

    assert.equal(first, "ran one ✓");
    assert.match(
        second!,
        /^Tool call blocked: Sam denied this bash call after Lancet Guard asked \(risky\)/,
    );
});
