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
import type { Context } from "@earendil-works/chord/context";
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
        return safeCut(text, new Starts(this.for(conversationId).map((each) => each.value)));
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
     * An output callback that hides values as they stream. It holds back only the end of each stream that could still
     * be the start of a value, so output that starts none shows at once, and `flush` sends it once the command ends.
     */
    stream(
        conversationId: ConversationId | number,
        onOutput: NonNullable<ShellExecOptions["onOutput"]>,
    ): { onOutput: NonNullable<ShellExecOptions["onOutput"]>; flush: () => void } {
        const values = this.for(conversationId);
        const starts = new Starts(values.map((each) => each.value));
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
                const cut = safeCut(joined, starts);

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

/** Values by how they start, so a place in a text is checked only against the values that can start there. */
class Starts {
    /** Each value's first `MIN_HIDDEN` characters, and the values that start so. */
    readonly #byStart = new Map<string, string[]>();
    /** Each value's shorter starts; its first character, and its first two, by their codes. */
    readonly #short = new Set<string>();
    readonly #first = new Uint8Array(65536);
    readonly #pair = new Uint8Array(65536);
    readonly longest: number;

    constructor(values: readonly string[]) {
        let longest = 0;

        for (const value of values) {
            const key = value.slice(0, MIN_HIDDEN);
            const same = this.#byStart.get(key) ?? [];

            same.push(value);
            this.#byStart.set(key, same);
            this.#first[value.charCodeAt(0)] = 1;
            this.#pair[pair(value, 0)] = 1;
            longest = Math.max(longest, value.length);

            for (let length = 1; length < MIN_HIDDEN; length++) {
                this.#short.add(value.slice(0, length));
            }
        }

        this.longest = longest;
    }

    /** Whether a value may start at `at`, by its first two characters: most places in a text are told at once. */
    #may(text: string, at: number): boolean {
        return (
            this.#first[text.charCodeAt(at)] === 1 &&
            (at + 1 === text.length || this.#pair[pair(text, at)] === 1)
        );
    }

    /** Whether the end of `text` from `at` is the start of a value, not all of it. */
    starts(text: string, at: number): boolean {
        if (!this.#may(text, at)) {
            return false;
        }

        if (text.length - at < MIN_HIDDEN) {
            return this.#short.has(text.slice(at));
        }

        const values = this.#byStart.get(text.slice(at, at + MIN_HIDDEN));
        const rest = values === undefined ? "" : text.slice(at);

        return (values ?? []).some((value) => value.length > rest.length && value.startsWith(rest));
    }

    /** Whether a whole value starts at `at` in `text` and goes past `cut`. */
    spans(text: string, at: number, cut: number): boolean {
        return (
            this.#may(text, at) &&
            (this.#byStart.get(text.slice(at, at + MIN_HIDDEN)) ?? []).some(
                (value) => at + value.length > cut && text.startsWith(value, at),
            )
        );
    }
}

/** The first two characters of `text` at `at`, as one number. */
function pair(text: string, at: number): number {
    return ((text.charCodeAt(at) << 8) ^ text.charCodeAt(at + 1)) & 0xffff;
}

/**
 * How much of `text` can be shown before more comes: `HiddenValues.safe`, for these values. Only the last characters,
 * fewer than the longest value, can start one or hold one that the cut falls inside.
 */
function safeCut(text: string, starts: Starts): number {
    let cut = text.length;

    for (let at = Math.max(0, text.length - starts.longest + 1); at < text.length; at++) {
        if (starts.starts(text, at)) {
            cut = at;
            break;
        }
    }

    // A whole value in the text ends in it: one can go past the cut only when something is held back.
    for (let moved = cut < text.length; moved;) {
        moved = false;

        for (let at = Math.max(0, cut - starts.longest + 1); at < cut; at++) {
            if (starts.spans(text, at, cut)) {
                cut = at;
                moved = true;
                break;
            }
        }
    }

    return cut;
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
