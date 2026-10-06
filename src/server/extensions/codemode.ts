/**
 * Codemode lets the agent write JavaScript that calls its other tools, to batch independent calls, chain them, or
 * filter large output before it reaches the model. Scripts run in a QuickJS sandbox without Node, files, network, or
 * timers; their only capability is calling tools. Every call a script makes goes through the same steps as a direct
 * call (argument checks, then every `beforeTool` and `afterTool` hook), so Lancet Guard judges each one and can ask
 * for approval. Only the script's output reaches the model. `store()` values are kept per conversation.
 */
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "@earendil-works/chord";
import { withAbortSignal } from "@earendil-works/chord/context";
import { type ToolCall, Type } from "@earendil-works/pi-ai";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import {
    type CodemodeResult,
    CodemodeSandbox,
    parseCodemodeSource,
} from "@earendil-works/pi-codemode";
import {
    defineExtension,
    defineTool,
    type Extension,
    type HookApi,
    type JsonObject,
    section,
    type ToolDiagnostic,
    type ToolExecutionApi,
    type ToolExecutionResult,
    type ToolHooks,
    type ToolRegistration,
    ToolTask,
} from "@earendil-works/pi-durable";
import { CodemodeStoreDoc } from "../docs.ts";
import type { PocketHost } from "../host.ts";

export const CODEMODE_TOOL = "codemode";
/** Output budget of a script, in estimated tokens (4 characters each), unless its options line sets another. */
const MAX_OUTPUT_TOKENS = 10_000;
const CHARS_PER_TOKEN = 4;
/** What a script gets of one nested call's text: enough to filter, not enough to exhaust the VM. */
const MAX_NESTED_CHARS = 1_000_000;
const MEMORY_LIMIT_BYTES = 256 * 1024 * 1024;

const DESCRIPTION = `Run JavaScript that calls your other tools. The input is raw JavaScript (not JSON, no code fence), run as an async function body in a QuickJS sandbox: top-level \`await\` and \`return\` work. No Node, file system, network, or timers.
- \`await tools.<name>({ ...args })\` takes the same arguments as calling the tool directly, resolves to its text output, and rejects with an Error when the call fails or is blocked. Calls still running when the script ends are cancelled.
- Each call is checked like a direct call: Lancet Guard may block it or wait for a person to approve it.
- Optional first line: \`// @options: {"max_output_tokens": 10000, "timeout_ms": 60000}\`
Globals:
- \`text(value)\`, \`image(dataUrlOrImageBlock)\`, \`console.log(...)\`, and top-level \`return\` add output; \`exit()\` ends the script.
- \`store(key, value)\` and \`load(key)\` keep JSON values across codemode calls in this conversation.
- \`ALL_TOOLS\` lists the tools a script can call.`;

/** One call a script made. `path`: the file it worked on, when it names one; the Changes sheet looks for writes. */
type CallRecord = {
    name: string;
    status: "running" | "ok" | "error" | "cancelled";
    path?: string;
    durationMs?: number;
    error?: string;
};
type CodemodeDetails = { calls: CallRecord[]; fullOutputPath?: string };

type BeforeTool = ToolHooks["beforeTool"];
type AfterTool = ToolHooks["afterTool"];

/** The `beforeTool` and `afterTool` handlers of the selected extensions, in the order the Harness runs them. */
function toolHooks(extensions: readonly Extension[]): { before: BeforeTool[]; after: AfterTool[] } {
    const before: BeforeTool[] = [];
    const after: AfterTool[] = [];

    for (const extension of extensions) {
        for (const registration of extension.hooks ?? []) {
            if (registration.task !== ToolTask.definition.name) {
                continue;
            }

            const handlers = registration.handlers as Partial<ToolHooks>;

            if (handlers.beforeTool !== undefined) {
                before.push(handlers.beforeTool.bind(handlers));
            }

            if (handlers.afterTool !== undefined) {
                after.push(handlers.afterTool.bind(handlers));
            }
        }
    }

    return { before, after };
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** A result's text as the model would read it: text parts, then its diagnostics. */
function resultText(result: ToolExecutionResult, diagnostics: readonly ToolDiagnostic[]): string {
    const parts = (result.content ?? []).flatMap((part) =>
        part.type === "text" ? [part.text] : [],
    );

    for (const diagnostic of [...diagnostics, ...(result.diagnostics ?? [])]) {
        parts.push(diagnostic.message);
    }

    return parts.join("\n");
}

function bound(text: string, retain: "head" | "tail"): string {
    if (text.length <= MAX_NESTED_CHARS) {
        return text;
    }

    const note = `[${text.length - MAX_NESTED_CHARS} characters not shown]`;

    return retain === "tail"
        ? `${note}\n${text.slice(-MAX_NESTED_CHARS)}`
        : `${text.slice(0, MAX_NESTED_CHARS)}\n${note}`;
}

/** Like the script's `text()`: strings as they are, anything else as JSON. */
function valueText(value: unknown): string {
    return typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
}

function formatError(
    result: Extract<CodemodeResult, { ok: false }>,
    calls: readonly CallRecord[],
): string {
    const { error } = result;
    const head =
        error.kind === "script"
            ? (error.stack ?? `${error.name ?? "Error"}: ${error.message}`)
            : error.kind === "timeout"
              ? `Script timed out: ${error.message}`
              : error.kind === "aborted"
                ? `Script aborted: ${error.message}`
                : `Script sandbox failed: ${error.message}`;
    const summary =
        calls.length === 0
            ? "No tool calls were made."
            : `Tool calls made before the failure (they are not undone): ${calls.map((call) => `${call.name} (${call.status})`).join(", ")}`;

    return `${head}\n\n${summary}`;
}

type OutputItem =
    { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

/** Keep the start and end of text over the budget; the whole text goes to a temporary file the agent can read. */
async function budget(
    items: OutputItem[],
    maxTokens: number,
): Promise<{ items: OutputItem[]; fullOutputPath?: string }> {
    const texts = items.flatMap((item) => (item.type === "text" ? [item.text] : []));
    const combined = texts.join("\n");
    const limit = maxTokens * CHARS_PER_TOKEN;

    if (combined.length <= limit) {
        return { items };
    }

    const head = combined.slice(0, Math.floor(limit / 2));
    const tail = combined.slice(-(limit - head.length));
    let text = `Warning: output truncated (about ${Math.ceil(combined.length / CHARS_PER_TOKEN)} tokens, ${combined.split("\n").length} lines)\n\n${head}\n… ${Math.ceil((combined.length - limit) / CHARS_PER_TOKEN)} tokens not shown …\n${tail}`;
    const path = join(tmpdir(), `pi-pocket-codemode-${randomBytes(8).toString("hex")}.txt`);

    try {
        await writeFile(path, combined, { mode: 0o600 });
        text += `\n\n[Full output: ${path} (read it with offset and limit)]`;
    } catch (error) {
        text += `\n\n[Could not save the full output: ${errorText(error)}]`;

        return {
            items: [{ type: "text", text }, ...items.filter((item) => item.type === "image")],
        };
    }

    return {
        items: [{ type: "text", text }, ...items.filter((item) => item.type === "image")],
        fullOutputPath: path,
    };
}

export default function createCodemode(_host: PocketHost) {
    const codemode = defineTool({
        name: CODEMODE_TOOL,
        description: DESCRIPTION,
        parameters: Type.Object({ code: Type.String({ description: "Raw JavaScript source." }) }),
        // A script's nested calls (bash, writes) are not safe to run twice.
        replay: "unsafe",
        execute: async (args, api: ToolExecutionApi<CodemodeDetails>, context) => {
            const started = performance.now();
            const { code, options } = parseCodemodeSource(args.code);
            const agent = await api.agent(context);
            const callable = agent.tools.filter(
                (tool) => tool.name !== CODEMODE_TOOL,
            ) as ToolRegistration[];
            const hooks = toolHooks(agent.extensions);
            const calls: CallRecord[] = [];
            const publish = () =>
                void api
                    .details({ calls: calls.map((call) => ({ ...call })) }, context)
                    .catch(() => {});
            let next = 0;

            /** One call from the script: the steps of a direct call, with its own memos and its own output. */
            const nested = async (
                tool: ToolRegistration,
                input: unknown,
                signal: AbortSignal,
            ): Promise<string> => {
                const n = ++next;
                const call: ToolCall = {
                    type: "toolCall",
                    id: `${api.callId}/${n}`,
                    name: tool.name,
                    arguments: (input ?? {}) as JsonObject,
                };
                const record: CallRecord = { name: tool.name, status: "running" };

                calls.push(record);
                publish();
                const callStarted = performance.now();
                const scope = withAbortSignal(signal, context);
                // Memos are per task; a script makes many calls in one task, so each call gets its own names.
                const memo = ((name: string, ...rest: unknown[]) =>
                    (api.memo as (...all: unknown[]) => unknown)(
                        `codemode/${n}/${name}`,
                        ...rest,
                    )) as ToolExecutionApi["memo"];
                const hookApi: HookApi = { ...api, memo };
                const check = (value: unknown): JsonObject =>
                    validateToolArguments(tool, {
                        ...call,
                        arguments: value as JsonObject,
                    }) as JsonObject;

                try {
                    let callArgs = check(
                        tool.prepareArguments === undefined
                            ? call.arguments
                            : tool.prepareArguments(call.arguments),
                    );

                    for (const before of hooks.before) {
                        let decision: Awaited<ReturnType<BeforeTool>>;

                        try {
                            decision = await before(
                                { ...call, arguments: callArgs },
                                hookApi,
                                scope,
                            );
                        } catch (error) {
                            if (scope.abortSignal?.aborted) {
                                throw error;
                            }

                            throw new Error(`Tool call blocked: ${errorText(error)}`);
                        }

                        if (decision?.block !== undefined) {
                            throw new Error(`Tool call blocked: ${decision.block}`);
                        }

                        if (decision?.arguments !== undefined) {
                            callArgs = decision.arguments;
                        }
                    }

                    callArgs = check(callArgs);

                    if (typeof callArgs.path === "string") {
                        record.path = callArgs.path;
                    }

                    const decoder = new TextDecoder();
                    const output: string[] = [];
                    const diagnostics: ToolDiagnostic[] = [];
                    const toolApi: ToolExecutionApi = {
                        ...api,
                        callId: call.id,
                        memo,
                        output: (chunk) =>
                            void output.push(
                                typeof chunk === "string"
                                    ? chunk
                                    : decoder.decode(chunk, { stream: true }),
                            ),
                        diagnostic: (diagnostic) => void diagnostics.push(diagnostic),
                        // The script gets text; a nested call's details stay with it.
                        details: async () => {},
                    };
                    let result = await tool.execute(callArgs, toolApi, scope);

                    if (result.content === undefined) {
                        result = {
                            ...result,
                            content: [{ type: "text", text: output.join("") + decoder.decode() }],
                        };
                    }

                    for (const after of hooks.after) {
                        result =
                            (await after(
                                { ...call, arguments: callArgs },
                                result,
                                hookApi,
                                scope,
                            )) ?? result;
                    }

                    const text = bound(
                        resultText(result, diagnostics),
                        tool.outputLimits?.retain ?? "head",
                    );

                    if (result.isError === true) {
                        throw new Error(text || `Tool ${tool.name} failed`);
                    }

                    record.status = "ok";

                    return text;
                } catch (error) {
                    record.status = signal.aborted ? "cancelled" : "error";
                    record.error = errorText(error).slice(0, 500);

                    throw error;
                } finally {
                    record.durationMs = Math.round(performance.now() - callStarted);
                    publish();
                }
            };

            const sandbox = new CodemodeSandbox({
                tools: callable.map((tool) => ({
                    name: tool.name,
                    description: tool.description,
                    inputSchema: tool.parameters as Record<string, unknown>,
                    outputSchema: { type: "string" },
                    execute: (input, { signal }) => nested(tool, input, signal),
                })),
                timeoutMs: options.timeoutMs ?? Number.POSITIVE_INFINITY,
                memoryLimitBytes: MEMORY_LIMIT_BYTES,
            });
            const stored =
                (await api.snapshot(CodemodeStoreDoc, api.conversationId, context))?.values ?? {};
            let result: CodemodeResult;

            try {
                result = await sandbox.execute(code, {
                    ...(context.abortSignal === undefined ? {} : { signal: context.abortSignal }),
                    store: stored,
                });
            } finally {
                await sandbox.close();
            }

            for (const call of calls) {
                if (call.status === "running") {
                    call.status = "cancelled";
                }
            }

            const items: OutputItem[] = result.output.map((item) =>
                item.type === "text" ? { type: "text", text: item.text } : item,
            );

            if (result.ok) {
                const { set, delete: removed } = result.storeWrites;

                if (Object.keys(set).length > 0 || removed.length > 0) {
                    await api.commit(async (tx) => {
                        const doc = await tx.doc(CodemodeStoreDoc, api.conversationId);

                        for (const key of removed) {
                            delete doc.values[key];
                        }

                        for (const [key, value] of Object.entries(set)) {
                            doc.values[key] = value as JsonValue;
                        }
                    }, context);
                }

                if (result.value !== undefined) {
                    items.push({ type: "text", text: valueText(result.value) });
                }
            } else {
                items.push({ type: "text", text: `Script error:\n${formatError(result, calls)}` });
            }

            const shown = await budget(items, options.maxOutputTokens ?? MAX_OUTPUT_TOKENS);
            const header = `${result.ok ? "Script completed" : "Script failed"}\nWall time ${((performance.now() - started) / 1000).toFixed(1)} seconds\nOutput:\n`;

            return {
                content: [{ type: "text", text: header }, ...shown.items],
                details: {
                    calls,
                    ...(shown.fullOutputPath === undefined
                        ? {}
                        : { fullOutputPath: shown.fullOutputPath }),
                },
                ...(result.ok ? {} : { isError: true }),
            };
        },
    });

    return defineExtension({
        name: "pocket-codemode",
        tools: [codemode],
        sections: [
            section("codemode", ({ agent }) => {
                const names = agent.tools
                    .map((tool) => tool.name)
                    .filter((name) => name !== CODEMODE_TOOL);

                if (
                    !agent.tools.some((tool) => tool.name === CODEMODE_TOOL) ||
                    names.length === 0
                ) {
                    return undefined;
                }

                return `Use codemode to batch independent tool calls (Promise.allSettled), chain them, or filter large output, instead of making many separate calls. Scripts can call: ${names.join(", ")}.`;
            }),
        ],
    });
}
