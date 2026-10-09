/**
 * Commands a person invokes on an extension, without sending a message to Pi. Each invocation is a durable task:
 * retried requests find the same task, and a restart does not repeat a handler that may have changed something.
 */
import { randomUUID } from "node:crypto";
import { awaitWithContext, BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
    type ConversationId,
    defineTask,
    type Task,
    type TaskId,
} from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import type { User } from "./config.ts";
import { CommandRequestDoc } from "./docs.ts";
import { COMMAND_ENTRY } from "./entry-format.ts";
import { describe, HttpError } from "./errors.ts";
import type { CommandResult } from "./host.ts";
import type { RegisteredCommand } from "./reload.ts";

const context = BACKGROUND_CONTEXT;
const TASK = "pocket.command";
const MAX_ARGS = 4000;

type CommandInput = {
    commandId: string;
    selection: string;
    command: string;
    scope: "conversation" | "global";
    args: string;
    by: string;
    name: string;
};

type CommandOutcome = CommandResult & {
    status: "done" | "failed" | "interrupted" | "stopped";
};

export type CommandRequest = { commandId?: unknown; args?: unknown; requestId?: unknown };
export type CommandReceipt = CommandOutcome & { taskId: number };

/** Keep only the declared feedback fields; an extension cannot supply an entry or a model message. */
function feedback(result: CommandResult): CommandResult {
    if (result?.type === "card" && typeof result.output === "string") {
        return { type: "card", output: result.output };
    }

    if (
        result?.type === "toast" &&
        ["info", "warning", "error"].includes(result.level) &&
        typeof result.message === "string"
    ) {
        return { type: "toast", level: result.level, message: result.message };
    }

    throw new Error(
        "A command must return a toast with a level and message, or a card with text output.",
    );
}

export class ExtensionCommands {
    readonly #app: PocketApp;
    /** An admitted invocation keeps the handler it selected, even if the module is reloaded. */
    readonly #selected = new Map<string, RegisteredCommand>();
    readonly task: Task<CommandInput, { phase: "run" }, CommandOutcome, object>;

    constructor(app: PocketApp) {
        this.#app = app;
        this.task = defineTask<CommandInput, { phase: "run" }, CommandOutcome>({
            name: TASK,
            version: 1,
            initial: () => ({ phase: "run" }),
            phases: {
                run: async (task, runtime, context) => {
                    let result = await runtime.memo<CommandOutcome>("result", context);

                    if (result === undefined) {
                        const started = await runtime.memo<boolean>("started", context);
                        const command = this.#selected.get(task.input.selection);

                        if (started || command === undefined) {
                            result = {
                                status: "interrupted",
                                type: "toast",
                                level: "warning",
                                message:
                                    "The command was interrupted by a server restart; it may have done part of its work. It was not run again.",
                            };
                        } else {
                            await runtime.memo("started", true, context);

                            try {
                                const user = this.#app.config.userById(task.input.by);

                                if (user === undefined) {
                                    throw new HttpError(
                                        403,
                                        "The person who requested this command no longer has access.",
                                    );
                                }

                                await this.#authorize(
                                    runtime.conversationId,
                                    user,
                                    task.input.scope,
                                );
                                const answer = await awaitWithContext(
                                    Promise.resolve(
                                        command.handler(task.input.args, {
                                            user: { id: user.id, name: user.name, role: user.role },
                                            conversationId: runtime.conversationId,
                                            cwd: this.#app.cwdOf(runtime.conversationId),
                                            signal: runtime.signal,
                                            snapshot: runtime.snapshot.bind(runtime),
                                            context,
                                            commit: (change) =>
                                                runtime.commit(async (tx) => {
                                                    await change(tx);

                                                    return undefined;
                                                }, context),
                                        }),
                                    ),
                                    context,
                                );

                                result = { ...feedback(answer), status: "done" };
                            } catch (error) {
                                if (runtime.signal.aborted) {
                                    throw error;
                                }

                                result = {
                                    status: "failed",
                                    type: "toast",
                                    level: "error",
                                    message: describe(error),
                                };
                            }
                        }

                        result = await runtime.memo("result", result, context);
                    }

                    if (result.type === "card") {
                        const conversation = await this.#app.conversation(runtime.conversationId);

                        await conversation.submit(
                            {
                                type: "write",
                                requestId: `extension-command:${task.id}`,
                                entry: {
                                    kind: COMMAND_ENTRY,
                                    data: {
                                        command: task.input.command,
                                        by: task.input.by,
                                        name: task.input.name,
                                        output: result.output,
                                        taskId: Number(task.id),
                                    },
                                },
                            },
                            context,
                        );
                    }

                    await runtime.commit(
                        () => ({
                            status: "terminal",
                            outcome: { status: "completed", result },
                        }),
                        context,
                    );
                },
            },
            abort: async (_task, runtime, context) => {
                await runtime.commit(
                    () => ({
                        status: "terminal",
                        outcome: {
                            status: "aborted",
                            result: {
                                status: "stopped",
                                type: "toast",
                                level: "warning",
                                message:
                                    "The command was stopped; it may have done part of its work.",
                            },
                        },
                    }),
                    context,
                );
            },
        });
    }

    async #authorize(
        id: ConversationId,
        user: User,
        scope: "conversation" | "global",
    ): Promise<void> {
        this.#app.requireSee(user, id);

        if (scope === "global") {
            if (user.role !== "owner") {
                throw new HttpError(403, "Only the owner can run global extension commands.");
            }
        } else {
            await this.#app.requireDriver(id, user);
        }
    }

    async run(id: ConversationId, user: User, request: CommandRequest): Promise<CommandReceipt> {
        const app = this.#app;

        app.requireSee(user, id);
        app.requireSteer(user);
        await app.conversation(id);

        if (
            request === null ||
            typeof request.commandId !== "string" ||
            typeof request.args !== "string" ||
            typeof request.requestId !== "string" ||
            !/^[a-zA-Z0-9_-]{1,64}$/.test(request.requestId)
        ) {
            throw new HttpError(
                400,
                "commandId, args, and a requestId of 1–64 letters, digits, hyphens, or underscores are required.",
            );
        }

        const { commandId, args, requestId } = request;

        if (args.length > MAX_ARGS) {
            throw new HttpError(413, `Command arguments are limited to ${MAX_ARGS} characters.`);
        }

        const command = app.loader.command(commandId);
        const selection = randomUUID();

        if (command !== undefined) {
            await this.#authorize(id, user, command.scope);
            this.#selected.set(selection, command);
        }

        try {
            const taskId = await app.harness.commit(async (tx) => {
                const request = await tx.doc(
                    CommandRequestDoc,
                    id,
                    `${user.id}:${requestId}`,
                    null,
                );

                if (request.taskId !== undefined) {
                    const previous = await tx.task(request.taskId);
                    const input = previous?.input as CommandInput | undefined;

                    if (
                        previous?.kind !== TASK ||
                        input?.commandId !== commandId ||
                        input.args !== args
                    ) {
                        throw new HttpError(
                            409,
                            "This requestId was already used for a different command invocation.",
                        );
                    }

                    return request.taskId as TaskId<CommandOutcome>;
                }

                if (command === undefined || app.loader.command(commandId) !== command) {
                    throw new HttpError(
                        404,
                        "This extension command is no longer available. Refresh the command list.",
                    );
                }

                const created = await tx.createTask(
                    this.task,
                    {
                        commandId,
                        selection,
                        command: command.name,
                        scope: command.scope,
                        args,
                        by: user.id,
                        name: user.name,
                    },
                    { ownership: { kind: "conversation" }, background: true, conversationId: id },
                );

                request.taskId = created;

                return created;
            }, context);
            const task = await app.harness.getTask(taskId, context);

            await this.#authorize(id, user, (task!.input as CommandInput).scope);
            const completed = await app.harness.waitForTask(taskId, context);
            const outcome = completed.state.outcome;

            if (outcome.result !== undefined) {
                return { taskId: Number(taskId), ...outcome.result };
            }

            throw new HttpError(500, "The command could not finish. It was not run again.");
        } finally {
            this.#selected.delete(selection);
        }
    }

    /** Stopping a conversation command is open to steerers; stopping global work stays owner-only. */
    async stop(id: ConversationId, user: User, taskId: number): Promise<void> {
        const app = this.#app;

        app.requireSee(user, id);
        app.requireSteer(user);
        const task = Number.isSafeInteger(taskId)
            ? await app.harness.getTask(taskId as TaskId, context)
            : undefined;

        if (task === undefined || task.kind !== TASK || task.conversationId !== id) {
            throw new HttpError(404, "No such extension command here.");
        }

        if ((task.input as CommandInput).scope !== "conversation" && user.role !== "owner") {
            throw new HttpError(403, "Only the owner can stop global extension commands.");
        }

        if (task.state.status !== "terminal") {
            await app.harness.abortTask(task.id, context);
        }
    }

    /** Running now uses the name and access scope, never the arguments. */
    async describe(taskId: TaskId): Promise<Pick<RegisteredCommand, "name" | "scope"> | undefined> {
        const task = await this.#app.harness.getTask(taskId, context);

        if (task?.kind !== TASK) {
            return undefined;
        }

        const input = task.input as CommandInput;

        return { name: input.command, scope: input.scope };
    }
}
