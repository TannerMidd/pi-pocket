/**
 * What extensions add to the commands Pi runs, and hide from what comes back (since 0.22.0, experimental):
 *
 * - `CommandEnvs`: environment variables an extension gives one command, by what it runs and where (`host.commandEnv`).
 *   A secrets extension puts a key into `$NAME` for the commands that name it, so the value never goes through Pi.
 * - `HiddenValues`: values core takes out of what Pi and people read (`host.hide`): the output of commands as it streams
 *   (in the tool's live output, its result, and a `!` command's card), every tool's result, before it is stored, and
 *   people's messages to Pi (`Commands.submit`, `resend`).
 *   Each becomes `[label]`. A value split across two chunks of output is held back until it can be told apart.
 *
 * Both act through the execution environment the harness builds for each conversation (`wrapEnv`), so the bash tool,
 * `!` commands, codemode, and checks run the same way, and through an `afterTool` hook of core's own extension. This
 * keeps values out of transcripts by accident and by default: it is no boundary against a command that transforms a
 * value on purpose.
 */
import type { Context } from "@earendil-works/chord";
import type { ConversationId, ToolExecutionResult } from "@earendil-works/pi-durable";
import type {
    ExecutionEnv,
    ShellExecOptions,
    ShellOutputInfo,
} from "@earendil-works/pi-durable/env";

/** The shortest value core hides: shorter ones would turn up by chance in ordinary output. */
export const MIN_HIDDEN = 4;
/** The longest. */
export const MAX_HIDDEN = 4096;
/** The most values hidden at once, across the app. */
export const MAX_HIDDEN_VALUES = 2000;
const LABEL = /^[A-Za-z0-9 _.:-]{1,60}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** How long a `host.commandEnv` provider may take for one command. Tests shorten it. */
export const commandEnvLimits = { providerMs: 5000 };
/** The most bytes of variables extensions add to one command. */
const MAX_ENV_BYTES = 256 * 1024;

export interface HiddenValue {
    /** The text to hide. */
    value: string;
    /** What shows in its place, as `[label]`, such as `secret GITHUB_TOKEN`. */
    label: string;
    /** Only in this session; absent: in every session. */
    conversationId?: number;
}

type Hidden = { value: string; replacement: string; conversationId?: number };

export class HiddenValues {
    readonly #values = new Set<Hidden>();
    /** The session a conversation belongs to: a subagent's values are its session's. */
    readonly #rootOf: (conversationId: number) => number;

    constructor(rootOf: (conversationId: number) => number = (id) => id) {
        this.#rootOf = rootOf;
    }

    /** Hide a value until the returned function is called. A value out of bounds throws. */
    add(hidden: HiddenValue): () => void {
        const { value, label, conversationId } = hidden ?? ({} as HiddenValue);

        if (typeof value !== "string" || value.length < MIN_HIDDEN || value.length > MAX_HIDDEN) {
            throw new Error(
                `host.hide: a value is ${MIN_HIDDEN} to ${MAX_HIDDEN} characters of text`,
            );
        }

        if (typeof label !== "string" || !LABEL.test(label)) {
            throw new Error("host.hide: a label is 1 to 60 letters, digits, spaces, and _ . : -");
        }

        if (
            conversationId !== undefined &&
            (!Number.isSafeInteger(conversationId) || conversationId < 1)
        ) {
            throw new Error("host.hide: conversationId is a session's id");
        }

        if (this.#values.size >= MAX_HIDDEN_VALUES) {
            throw new Error(`host.hide: ${MAX_HIDDEN_VALUES} values are hidden already`);
        }

        const entry: Hidden = {
            value,
            replacement: `[${label}]`,
            ...(conversationId === undefined ? {} : { conversationId }),
        };

        this.#values.add(entry);

        return () => {
            this.#values.delete(entry);
        };
    }

    /** The values hidden in a session, longest first, so a value inside a longer one does not split it. */
    for(conversationId: ConversationId | number): Hidden[] {
        const id = Number(conversationId);
        const root = this.#rootOf(id);

        return [...this.#values]
            .filter(
                (each) =>
                    each.conversationId === undefined ||
                    each.conversationId === id ||
                    each.conversationId === root,
            )
            .sort((a, b) => b.value.length - a.value.length);
    }

    /** Whether anything is hidden in a session. */
    any(conversationId: ConversationId | number): boolean {
        const id = Number(conversationId);
        const root = this.#rootOf(id);

        for (const each of this.#values) {
            if (
                each.conversationId === undefined ||
                each.conversationId === id ||
                each.conversationId === root
            ) {
                return true;
            }
        }

        return false;
    }

    /** `text` with each value hidden in the session replaced. */
    replace(text: string, conversationId: ConversationId | number): string {
        return replaceAll(text, this.for(conversationId));
    }

    /**
     * How much of `text` can be shown before the rest comes, in characters: up to where its end could be the start of a
     * value hidden in the session, and never inside a whole value, so output read in parts still hides a value split
     * between two reads. Values can overlap themselves (`ABAB` in `ABABAB`): a cut is moved back to the start of any
     * value it would fall inside, until none.
     */
    safe(text: string, conversationId: ConversationId | number): number {
        const values = this.for(conversationId).map((each) => each.value);
        let cut = text.length;

        for (const value of values) {
            for (let length = Math.min(value.length - 1, text.length); length > 0; length--) {
                if (text.endsWith(value.slice(0, length))) {
                    cut = Math.min(cut, text.length - length);
                    break;
                }
            }
        }

        for (let moved = true; moved;) {
            moved = false;

            for (const value of values) {
                for (
                    let at = text.indexOf(value);
                    at !== -1 && at < cut;
                    at = text.indexOf(value, at + 1)
                ) {
                    if (at + value.length > cut) {
                        cut = at;
                        moved = true;
                    }
                }
            }
        }

        return cut;
    }

    /**
     * A tool's result with each value replaced, in what the model reads, what programs read, and its details: in strings
     * and in object keys. The same object when nothing changed, found without copying it.
     */
    result(
        result: ToolExecutionResult,
        conversationId: ConversationId | number,
    ): ToolExecutionResult {
        const values = this.for(conversationId);

        return values.length === 0 ? result : (deep(result, values) as ToolExecutionResult);
    }

    /**
     * An output callback that hides values as they stream. It holds back the end of each stream that could still be the
     * start of a value, and `flush` sends it once the command ends.
     */
    stream(
        conversationId: ConversationId | number,
        onOutput: NonNullable<ShellExecOptions["onOutput"]>,
    ): { onOutput: NonNullable<ShellExecOptions["onOutput"]>; flush: () => void } {
        const values = this.for(conversationId);
        const hold = Math.max(0, ...values.map((each) => each.value.length)) - 1;
        const pending = new Map<
            string,
            { text: string; context: Context; info: ShellOutputInfo }
        >();

        const emit = (text: string, context: Context, info: ShellOutputInfo) => {
            if (text !== "" || info.skipped !== undefined) {
                onOutput(text, context, info);
            }
        };

        const flushOne = (stream: string) => {
            const held = pending.get(stream);

            pending.delete(stream);

            if (held !== undefined && held.text !== "") {
                emit(replaceAll(held.text, values), held.context, { stream: held.info.stream });
            }
        };

        return {
            onOutput: (text, context, info) => {
                // Output keeps its order: what the other stream holds back goes out before this chunk. A value one
                // stream writes in two pieces, with the other stream's output between them, is then not joined.
                flushOne(info.stream === "stdout" ? "stderr" : "stdout");

                // What came before an omission is not joined to what comes after it.
                if (info.skipped !== undefined) {
                    flushOne(info.stream);
                }

                const before = pending.get(info.stream)?.text ?? "";
                const joined = replaceAll(before + text, values);
                const cut = Math.max(0, joined.length - hold);

                pending.set(info.stream, { text: joined.slice(cut), context, info });
                emit(joined.slice(0, cut), context, info);
            },
            flush: () => {
                flushOne("stdout");
                flushOne("stderr");
            },
        };
    }
}

function replaceAll(text: string, values: readonly Hidden[]): string {
    let out = text;

    for (const each of values) {
        if (out.includes(each.value)) {
            out = out.split(each.value).join(each.replacement);
        }
    }

    return out;
}

/**
 * A JSON value with every string replaced, object keys too (a key that becomes another's takes its place): the same
 * value, not a copy, when nothing in it changed.
 */
function deep(value: unknown, values: readonly Hidden[]): unknown {
    if (typeof value === "string") {
        return replaceAll(value, values);
    }

    if (Array.isArray(value)) {
        let changed = false;
        const out = value.map((each) => {
            const next = deep(each, values);

            changed ||= next !== each;

            return next;
        });

        return changed ? out : value;
    }

    if (typeof value === "object" && value !== null) {
        let changed = false;
        const out: Record<string, unknown> = {};

        for (const [key, each] of Object.entries(value)) {
            const name = replaceAll(key, values);
            const next = deep(each, values);

            changed ||= name !== key || next !== each;
            Object.defineProperty(out, name, {
                value: next,
                enumerable: true,
                writable: true,
                configurable: true,
            });
        }

        return changed ? out : value;
    }

    return value;
}

/** What a command-environment provider gets: the command, where it runs, and for which session. */
export interface CommandRun {
    readonly conversationId: number;
    /** The command as the shell gets it, or the program and its arguments. */
    readonly command: string | readonly string[];
    readonly cwd: string;
}

export type CommandEnvProvider = (
    run: CommandRun,
) => Record<string, string> | undefined | Promise<Record<string, string> | undefined>;

export class CommandEnvs {
    readonly #providers = new Set<CommandEnvProvider>();
    readonly #log: (line: string) => void;

    constructor(log: (line: string) => void) {
        this.#log = log;
    }

    get any(): boolean {
        return this.#providers.size > 0;
    }

    /** Add a provider until the returned function is called. */
    add(provider: CommandEnvProvider): () => void {
        if (typeof provider !== "function") {
            throw new Error("host.commandEnv: give it a function");
        }

        this.#providers.add(provider);

        return () => {
            this.#providers.delete(provider);
        };
    }

    /**
     * The variables every provider gives a command, later ones over earlier ones. A provider that throws, or gives
     * something that is not a set of variables, adds nothing, and the log says why: the command runs as it would.
     */
    async for(run: CommandRun, signal?: AbortSignal): Promise<Record<string, string>> {
        const env: Record<string, string> = {};
        let bytes = 0;

        for (const provider of [...this.#providers]) {
            let given: unknown;
            let timer: NodeJS.Timeout | undefined;
            let stopped: (() => void) | undefined;

            try {
                signal?.throwIfAborted();
                // A provider has a few seconds, and stops with the command: one that hangs must not hold every command.
                given = await Promise.race([
                    Promise.resolve().then(() => provider(Object.freeze({ ...run }))),
                    new Promise<never>((_, reject) => {
                        timer = setTimeout(
                            () =>
                                reject(
                                    new Error(`took more than ${commandEnvLimits.providerMs} ms`),
                                ),
                            commandEnvLimits.providerMs,
                        );
                        stopped = () => reject(new Error("the command was stopped"));
                        signal?.addEventListener("abort", stopped, { once: true });
                    }),
                ]);
            } catch (error) {
                // The command was stopped: it runs no more, and the environment says so as it always does.
                if (signal?.aborted) {
                    return env;
                }

                this.#log(
                    `host.commandEnv: a provider failed: ${error instanceof Error ? error.message : String(error)}`,
                );
                continue;
            } finally {
                clearTimeout(timer);

                if (stopped !== undefined) {
                    signal?.removeEventListener("abort", stopped);
                }
            }

            if (given === undefined || given === null) {
                continue;
            }

            if (typeof given !== "object" || Array.isArray(given)) {
                this.#log("host.commandEnv: a provider gave something that is not variables");
                continue;
            }

            for (const [name, value] of Object.entries(given)) {
                if (!ENV_NAME.test(name) || typeof value !== "string" || value.includes("\0")) {
                    this.#log(
                        `host.commandEnv: skipped a variable that is not NAME=text: ${name.slice(0, 64)}`,
                    );
                    continue;
                }

                bytes += name.length + value.length;

                if (bytes > MAX_ENV_BYTES) {
                    this.#log("host.commandEnv: the variables for one command are too large");

                    return env;
                }

                env[name] = value;
            }
        }

        return env;
    }
}

/**
 * The environment a conversation's commands run in: `base`, with what extensions add to each command's environment
 * and the values hidden in that session taken out of its output. `base` itself when neither applies.
 */
export function wrapEnv(
    base: ExecutionEnv,
    conversationId: number,
    cwd: string,
    envs: CommandEnvs,
    hidden: HiddenValues,
): ExecutionEnv {
    if (!envs.any && !hidden.any(conversationId)) {
        return base;
    }

    const exec: ExecutionEnv["exec"] = async (command, options, context) => {
        const added = envs.any
            ? await envs.for(
                  { conversationId, command, cwd: options?.cwd ?? cwd },
                  context.abortSignal,
              )
            : {};
        const stream =
            options?.onOutput !== undefined && hidden.any(conversationId)
                ? hidden.stream(conversationId, options.onOutput)
                : undefined;
        const next: ShellExecOptions = {
            ...options,
            ...(Object.keys(added).length === 0 ? {} : { env: { ...options?.env, ...added } }),
            ...(stream === undefined ? {} : { onOutput: stream.onOutput }),
        };

        try {
            return await base.exec(command, next, context);
        } finally {
            stream?.flush();
        }
    };

    return new Proxy(base, {
        get(target, property) {
            if (property === "exec") {
                return exec;
            }

            const value = Reflect.get(target, property, target) as unknown;

            return typeof value === "function"
                ? (value as (...args: unknown[]) => unknown).bind(target)
                : value;
        },
    });
}
