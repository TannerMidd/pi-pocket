/**
 * Commands a person runs on an extension, without sending a message to Pi. Each run is a durable task: a request sent
 * again finds the same task, and a restart never runs a handler again, as it may have changed something.
 */
import { randomUUID } from "node:crypto";
import {
    awaitWithContext,
    BACKGROUND_CONTEXT,
    withAbortSignal,
} from "@earendil-works/chord/context";
import {
    type ConversationId,
    defineTask,
    type Task,
    type TaskId,
    type TaskRuntime,
} from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import type { User } from "./config.ts";
import { CommandRequestsDoc } from "./docs.ts";
import { COMMAND_ENTRY, type CommandData } from "./entry-format.ts";
import { describe, HttpError } from "./errors.ts";
import { exposedError, type RegisteredCommand } from "./extension-web.ts";
import type { CommandResult } from "./host.ts";

const context = BACKGROUND_CONTEXT;

/** The task of each run of an extension's command. Stored data: never rename it. */
export const COMMAND_TASK = "pocket.extension-command";
const TASK = COMMAND_TASK;
const MAX_ARGS = 4000;

/** How much of a card is kept: its end, as a `!` command keeps the end of what it printed. */
const MAX_CARD = 30_000;
/** How much of a notice is kept. */
const MAX_TOAST = 500;
/** How many runs one person may have going at once, over every session. */
const MAX_RUNNING = 4;
/** How many request ids of finished runs a person keeps in a conversation. A run that still goes keeps its id. */
const KEEP_REQUESTS = 100;
/** What anyone but the owner hears of a handler's own error: its words can name the server's folders or secrets. */
const FAILED = "The command failed.";

/**
 * What a run keeps. `commandId` (the registration a browser chose) and `selection` (the handler kept in memory for this
 * run) are only compared, never looked up after a restart: both are new with each version and each process.
 */
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
    clipped?: boolean;
};

export type CommandRequest = { commandId?: unknown; args?: unknown; requestId?: unknown };
export type CommandReceipt = CommandOutcome & { taskId: number };

const cut = (text: string, max: number) =>
    text.length <= max ? text : `${text.slice(0, max - 1)}…`;

/**
 * Only what a command may give back: a notice or a card, of a bounded size. An extension cannot add a model message
 * or anything else to the entry.
 */
function feedback(result: CommandResult): CommandResult & { clipped?: boolean } {
    if (result?.type === "card" && typeof result.output === "string") {
        return result.output.length <= MAX_CARD
            ? { type: "card", output: result.output }
            : { type: "card", output: result.output.slice(-MAX_CARD), clipped: true };
    }

    if (
        result?.type === "toast" &&
        ["info", "warning", "error"].includes(result.level) &&
        typeof result.message === "string"
    ) {
        return { type: "toast", level: result.level, message: cut(result.message, MAX_TOAST) };
    }

    throw new Error(
        "it gave back neither a toast with a level and a message nor a card with text output",
    );
}

export class ExtensionCommands {
    readonly #app: PocketApp;
    /** Handlers chosen for runs whose task has not started yet, by the run's `selection`. */
    readonly #pending = new Map<string, { command: RegisteredCommand; by: string }>();
    /** Who started each handler still running, by task. */
    readonly #running = new Map<string, string>();
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
                        const picked = this.#pending.get(task.input.selection);

                        this.#pending.delete(task.input.selection);

                        // After a restart the handler is gone: a command never runs again, as it may have changed
                        // something before the restart cut it off.
                        if (started || picked === undefined) {
                            result = {
                                status: "interrupted",
                                type: "toast",
                                level: "warning",
                                message: started
                                    ? "A server restart cut the command off, and it was not run again: it may have done part of its work."
                                    : "A server restart came before the command ran: it did not run. Run it again.",
                            };
                        } else {
                            await runtime.memo("started", true, context);
                            this.#running.set(String(task.id), task.input.by);

                            try {
                                result = await this.#handle(picked.command, task.input, runtime);
                            } catch (error) {
                                if (runtime.signal.aborted) {
                                    throw error;
                                }

                                result = this.#failed(picked.command, error);
                            } finally {
                                this.#running.delete(String(task.id));
                            }
                        }

                        result = await runtime.memo("result", result, context);
                    }

                    if (result.type === "card") {
                        const conversation = await this.#app.conversation(runtime.conversationId);
                        const data: CommandData = {
                            command: task.input.command,
                            by: task.input.by,
                            name: task.input.name,
                            output: result.output,
                            taskId: Number(task.id),
                            ...(result.clipped ? { clipped: true } : {}),
                        };

                        // No person's prefix in the request id: the card does not change whom Pi works for.
                        await conversation.submit(
                            {
                                type: "write",
                                requestId: `extension-command:${task.id}`,
                                entry: { kind: COMMAND_ENTRY, data },
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
            // A stop that comes after the card was written leaves the card: the run still answers "stopped".
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

    /** Run a handler as the person who asked, and check what it gives back. */
    async #handle(
        command: RegisteredCommand,
        input: CommandInput,
        runtime: TaskRuntime<CommandInput, { phase: "run" }, CommandOutcome, object>,
    ): Promise<CommandOutcome> {
        const user = this.#app.config.userById(input.by);

        if (user === undefined) {
            throw new HttpError(403, "The person who ran this command no longer has access.");
        }

        const answer = await awaitWithContext(
            Promise.resolve(
                command.handler(input.args, {
                    user: { id: user.id, name: user.name, role: user.role },
                    conversationId: runtime.conversationId,
                    cwd: this.#app.cwdOf(runtime.conversationId),
                    signal: runtime.signal,
                    snapshot: runtime.snapshot.bind(runtime),
                    context,
                    commit: async (change) => {
                        let answer: Awaited<ReturnType<typeof change>>;

                        // The callback's own answer would be a new state for the task: keep `change`'s apart.
                        await runtime.commit(async (tx) => {
                            answer = await change(tx);

                            return undefined;
                        }, context);

                        return answer!;
                    },
                }),
            ),
            context,
        );

        return { ...feedback(answer), status: "done" };
    }

    /**
     * A handler that failed. Its words reach the person only from an error made for them (`web.error`, or the app's own
     * `HttpError`); the owner reads any other in a notice.
     */
    #failed(command: RegisteredCommand, error: unknown): CommandOutcome {
        const shown =
            exposedError(error)?.message ??
            (error instanceof HttpError ? error.message : undefined);

        if (shown === undefined) {
            this.#app.ownerNotice(
                "warning",
                `/${command.name} (${command.file}) failed: ${describe(error)}`,
            );
        }

        return {
            status: "failed",
            type: "toast",
            level: "error",
            message: cut(shown ?? FAILED, MAX_TOAST),
        };
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

    /** How many runs a person has going: chosen and not started yet, or running. */
    #runningFor(user: string): number {
        return (
            [...this.#pending.values()].filter((each) => each.by === user).length +
            [...this.#running.values()].filter((by) => by === user).length
        );
    }

    /**
     * Run a command, or find the run of a request sent before, and wait for its result. `signal` ends the wait when the
     * browser stops waiting; the run itself goes on.
     */
    async run(
        id: ConversationId,
        user: User,
        request: CommandRequest,
        signal?: AbortSignal,
    ): Promise<CommandReceipt> {
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

        // A request sent before: check that it is the same, and that its person may still run it, then wait for it.
        const sent = (await app.harness.snapshot(CommandRequestsDoc, id, user.id, context))?.items[
            requestId
        ];
        let taskId = sent === undefined ? undefined : await this.#same(sent, commandId, args);

        if (taskId !== undefined) {
            const input = (await app.harness.getTask(taskId, context))!.input as CommandInput;

            await this.#authorize(id, user, input.scope);
        } else {
            taskId = await this.#start(id, user, commandId, args, requestId);
        }

        const completed = await app.harness.waitForTask(
            taskId,
            signal === undefined ? context : withAbortSignal(signal, context),
        );
        const outcome = completed.state.outcome;

        if (outcome.result !== undefined) {
            return { taskId: Number(taskId), ...outcome.result };
        }

        throw new HttpError(500, "The command could not finish. It was not run again.");
    }

    /** The task of a request sent before, when it asked for the same; a 409 when the request id was used otherwise. */
    async #same(
        taskId: number,
        commandId: string,
        args: string,
        tx?: { task(id: TaskId): Promise<{ kind: string; input: unknown } | undefined> },
    ): Promise<TaskId<CommandOutcome>> {
        const previous = await (tx === undefined
            ? this.#app.harness.getTask(taskId as unknown as TaskId, context)
            : tx.task(taskId as unknown as TaskId));
        const input = previous?.input as CommandInput | undefined;

        if (previous?.kind !== TASK || input?.commandId !== commandId || input.args !== args) {
            throw new HttpError(409, "This requestId was already used for another command run.");
        }

        return taskId as unknown as TaskId<CommandOutcome>;
    }

    /** Check who may run it, then make its task: nothing that can refuse it comes after the task is made. */
    async #start(
        id: ConversationId,
        user: User,
        commandId: string,
        args: string,
        requestId: string,
    ): Promise<TaskId<CommandOutcome>> {
        const app = this.#app;
        const command = app.webs.command(commandId);

        if (command === undefined) {
            throw new HttpError(
                404,
                "This extension command is no longer available. Refresh the command list.",
            );
        }

        await this.#authorize(id, user, command.scope);

        if (this.#runningFor(user.id) >= MAX_RUNNING) {
            throw new HttpError(
                429,
                `You have ${MAX_RUNNING} extension commands running: wait for one to finish, or stop one in Running now.`,
            );
        }

        const selection = randomUUID();
        let made = false;

        this.#pending.set(selection, { command, by: user.id });

        try {
            return await app.harness.commit(async (tx) => {
                made = false;
                const requests = await tx.doc(CommandRequestsDoc, id, user.id, null);
                const known = requests.items[requestId];

                // The same request, sent twice at once: the one that came first made the task.
                if (known !== undefined) {
                    return this.#same(known, commandId, args, tx);
                }

                // Past the most kept, the oldest finished ones make room; a run that still goes keeps its id. Tasks
                // are read before the new one is made: a commit reads tables before it writes.
                const finished: string[] = [];
                const extra = Object.keys(requests.items).length + 1 - KEEP_REQUESTS;

                for (const [old, oldTask] of Object.entries(requests.items)) {
                    if (finished.length >= extra) {
                        break;
                    }

                    const record = await tx.task(oldTask as unknown as TaskId);

                    if (record === undefined || record.state.status === "terminal") {
                        finished.push(old);
                    }
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

                for (const old of finished) {
                    delete requests.items[old];
                }

                requests.items[requestId] = Number(created);
                made = true;

                return created;
            }, context);
        } finally {
            // No task took this handler: it is not kept.
            if (!made) {
                this.#pending.delete(selection);
            }
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

    /** A run's command name and scope, for Running now: never its arguments. */
    async named(taskId: TaskId): Promise<Pick<RegisteredCommand, "name" | "scope"> | undefined> {
        const task = await this.#app.harness.getTask(taskId, context);

        if (task?.kind !== TASK) {
            return undefined;
        }

        const input = task.input as CommandInput;

        return { name: input.command, scope: input.scope };
    }
}
