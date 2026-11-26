/**
 * An `ExecutionEnv` (the files and the shell that Pi's `read`, `write`, `edit`, and `bash` use) over a micro-VM. Every
 * call goes to the guest: a path outside the shared folder is a path in the guest, never on this machine. The VM is
 * started by the first call (`ready`), and a call that cannot get one fails with the reason, so nothing falls back to
 * the host.
 */
import { posix } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import {
    type BinaryReader,
    type DirReader,
    ExecutionError,
    type ExecutionEnv,
    FileError,
    type FileErrorCode,
    type FileInfo,
    type FileKind,
    type FileWatcher,
    type FileChange,
    type LineScan,
    type Result,
    type ShellExecOptions,
    type ShellExecResult,
    StreamDecoder,
    LineScanner,
    type TextLine,
    type TextLineReader,
    type WatchTarget,
    err,
    ok,
} from "@earendil-works/pi-durable/env";
import type { GuestError, GuestStat, GuestVm } from "./guest.ts";

/** What the env asks of its owner: a running VM, and notes of when commands start and end. */
export interface GuestEnvHost {
    /** The VM, started if it is not. Rejects with the reason it cannot start. */
    ready(signal?: AbortSignal): Promise<GuestVm>;
    /** A command starts; the returned function ends it. The VM is not idle while one runs. */
    busy(): () => void;
    /** Something touched the VM. */
    touch(): void;
}

const CHUNK = 64 * 1024;
/** The largest file a binary reader holds: it is read whole into memory, as the guest's files RPC gives whole files. */
const MAX_READER_BYTES = 64 * 1024 * 1024;

function fileError(error: unknown, path?: string): FileError {
    if (error instanceof FileError) {
        return error;
    }

    const cause = error instanceof Error ? error : new Error(String(error));
    const code = (error as GuestError | undefined)?.code;
    const map: Record<string, FileErrorCode> = {
        ENOENT: "not_found",
        EACCES: "permission_denied",
        EPERM: "permission_denied",
        EROFS: "permission_denied",
        ENOTDIR: "not_directory",
        EISDIR: "is_directory",
        EINVAL: "invalid",
        ABORT_ERR: "aborted",
    };

    return new FileError(
        (code !== undefined ? map[code] : undefined) ??
            (cause.name === "AbortError" ? "aborted" : "unknown"),
        cause.message,
        path,
        cause,
    );
}

function aborted(context: Context, path?: string): Result<never, FileError> | undefined {
    return context.abortSignal?.aborted === true
        ? err(new FileError("aborted", "aborted", path))
        : undefined;
}

function kindOf(stat: GuestStat): FileKind | undefined {
    return stat.kind === "other" ? undefined : stat.kind;
}

function infoOf(path: string, stat: GuestStat): Result<FileInfo, FileError> {
    const kind = kindOf(stat);

    return kind === undefined
        ? err(new FileError("invalid", "Unsupported file type", path))
        : ok({ name: posix.basename(path), path, kind, size: stat.size, mtimeMs: stat.mtimeMs });
}

/** Text lines of bytes held in memory, split at `\n` only, as the Node environment does. */
class MemoryLineReader implements TextLineReader {
    #text: string;
    #done = false;
    #closed = false;

    constructor(bytes: Uint8Array) {
        const decoder = new StreamDecoder();

        this.#text = decoder.decode(bytes) + decoder.decode();
    }

    async readLine(): Promise<Result<TextLine | undefined, FileError>> {
        if (this.#closed) {
            return err(new FileError("invalid", "Text line reader is closed"));
        }

        const newline = this.#text.indexOf("\n");

        if (newline !== -1) {
            const text = this.#text.slice(0, newline);

            this.#text = this.#text.slice(newline + 1);

            return ok({ text, terminated: true });
        }

        if (this.#done || this.#text.length === 0) {
            return ok(undefined);
        }

        const text = this.#text;

        this.#text = "";
        this.#done = true;

        return ok({ text, terminated: false });
    }

    async close(): Promise<void> {
        this.#closed = true;
    }
}

/** Positional reads of a file's bytes, read from the guest once when it opens: the same file, whatever its path becomes. */
class MemoryBinaryReader implements BinaryReader {
    readonly #path: string;
    readonly #info: FileInfo;
    readonly #bytes: Uint8Array;
    #closed = false;

    constructor(path: string, info: FileInfo, bytes: Uint8Array) {
        this.#path = path;
        this.#info = info;
        this.#bytes = bytes;
    }

    async #open(): Promise<Uint8Array> {
        return this.#bytes;
    }

    async info(): Promise<Result<FileInfo, FileError>> {
        return this.#closed
            ? err(new FileError("invalid", "Binary reader is closed", this.#path))
            : ok(this.#info);
    }

    async read(
        offset: number,
        length: number,
        context: Context,
    ): Promise<Result<Uint8Array, FileError>> {
        const stopped = aborted(context, this.#path);

        if (stopped) {
            return stopped;
        }

        if (this.#closed) {
            return err(new FileError("invalid", "Binary reader is closed", this.#path));
        }

        if (
            !Number.isSafeInteger(offset) ||
            offset < 0 ||
            !Number.isSafeInteger(length) ||
            length < 0
        ) {
            return err(
                new FileError(
                    "invalid",
                    "Offset and length must be non-negative safe integers",
                    this.#path,
                ),
            );
        }

        try {
            return ok((await this.#open()).subarray(offset, offset + length));
        } catch (error) {
            return err(fileError(error, this.#path));
        }
    }

    async scanLines(
        options: { startLine: number; endLine?: number },
        context: Context,
    ): Promise<Result<LineScan, FileError>> {
        const stopped = aborted(context, this.#path);

        if (stopped) {
            return stopped;
        }

        if (this.#closed) {
            return err(new FileError("invalid", "Binary reader is closed", this.#path));
        }

        const { startLine, endLine } = options;

        if (
            !Number.isSafeInteger(startLine) ||
            startLine < 0 ||
            (endLine !== undefined && (!Number.isSafeInteger(endLine) || endLine <= startLine))
        ) {
            return err(new FileError("invalid", "Invalid line range", this.#path));
        }

        try {
            const bytes = await this.#open();
            const scanner = new LineScanner(options.startLine, options.endLine);

            for (let at = 0; at < bytes.length; at += CHUNK) {
                scanner.push(bytes.subarray(at, at + CHUNK));
            }

            return ok(scanner.finish());
        } catch (error) {
            return err(fileError(error, this.#path));
        }
    }

    async close(): Promise<void> {
        this.#closed = true;
    }
}

/** Pages of a directory: each entry's metadata is read when its page is, and an entry that went is skipped. */
class ListReader implements DirReader {
    readonly #names: string[];
    readonly #info: (name: string, context: Context) => Promise<Result<FileInfo, FileError>>;
    #at = 0;
    #closed = false;

    constructor(
        names: string[],
        info: (name: string, context: Context) => Promise<Result<FileInfo, FileError>>,
    ) {
        this.#names = names;
        this.#info = info;
    }

    async next(
        maxEntries: number,
        context: Context,
    ): Promise<Result<{ entries: FileInfo[]; done: boolean }, FileError>> {
        const stopped = aborted(context);

        if (stopped) {
            return stopped;
        }

        if (this.#closed) {
            return err(new FileError("invalid", "Directory reader is closed"));
        }

        if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
            return err(new FileError("invalid", "maxEntries must be a positive integer"));
        }

        const entries: FileInfo[] = [];

        while (entries.length < maxEntries && this.#at < this.#names.length) {
            const info = await this.#info(this.#names[this.#at++]!, context);

            if (info.ok) {
                entries.push(info.value);
            } else if (info.error.code === "aborted") {
                this.#at--;

                return info;
            }
        }

        return ok({ entries, done: this.#at >= this.#names.length });
    }

    async close(): Promise<void> {
        this.#closed = true;
    }
}

export class GuestEnv implements ExecutionEnv {
    readonly id: string;
    readonly cwd: string;
    readonly #host: GuestEnvHost;
    readonly #shell: () => string;

    constructor(id: string, cwd: string, host: GuestEnvHost, shell: () => string) {
        this.id = id;
        this.cwd = cwd;
        this.#host = host;
        this.#shell = shell;
    }

    /** A path as the guest sees it: relative to the folder, `file://` and `~` as the host's environment reads them. */
    #resolve(path: string, base = this.cwd): string {
        let given = path;

        if (given.startsWith("file://")) {
            try {
                given = decodeURIComponent(new URL(given).pathname);
            } catch {
                // keep it as given
            }
        }

        if (given === "~") {
            return "/root";
        }

        if (given.startsWith("~/")) {
            return posix.join("/root", given.slice(2));
        }

        return posix.resolve(base, given);
    }

    async #fs<T>(
        path: string,
        context: Context,
        run: (vm: GuestVm, resolved: string, signal: AbortSignal | undefined) => Promise<T>,
    ): Promise<Result<T, FileError>> {
        const resolved = this.#resolve(path);
        const stopped = aborted(context, resolved);

        if (stopped) {
            return stopped;
        }

        try {
            const vm = await this.#host.ready(context.abortSignal);

            this.#host.touch();

            return ok(await run(vm, resolved, context.abortSignal));
        } catch (error) {
            return err(fileError(error, resolved));
        }
    }

    async absolutePath(path: string): Promise<Result<string, FileError>> {
        return ok(this.#resolve(path));
    }

    async joinPath(parts: string[]): Promise<Result<string, FileError>> {
        return ok(posix.join(...parts));
    }

    readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
        return this.#fs(path, context, async (vm, resolved, signal) =>
            Buffer.from(await vm.fs.readFile(resolved, signal)).toString("utf8"),
        );
    }

    readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
        return this.#fs(path, context, (vm, resolved, signal) => vm.fs.readFile(resolved, signal));
    }

    async openTextLineReader(
        path: string,
        context: Context,
    ): Promise<Result<TextLineReader, FileError>> {
        const bytes = await this.readBinaryFile(path, context);

        return bytes.ok ? ok(new MemoryLineReader(bytes.value)) : bytes;
    }

    async readTextLines(
        path: string,
        options: { maxLines?: number } | undefined,
        context: Context,
    ): Promise<Result<string[], FileError>> {
        if (options?.maxLines !== undefined && options.maxLines <= 0) {
            return ok([]);
        }

        const opened = await this.openTextLineReader(path, context);

        if (!opened.ok) {
            return opened;
        }

        const lines: string[] = [];

        while (options?.maxLines === undefined || lines.length < options.maxLines) {
            const line = await opened.value.readLine(context);

            if (!line.ok) {
                return line;
            }

            if (line.value === undefined) {
                break;
            }

            lines.push(line.value.text);
        }

        return ok(lines);
    }

    async openBinaryReader(
        path: string,
        options: { noFollow?: boolean } | undefined,
        context: Context,
    ): Promise<Result<BinaryReader, FileError>> {
        const resolved = this.#resolve(path);
        const opened = await this.#fs(path, context, async (vm, target, signal) => {
            const link = await vm.fs.stat(target, false, signal);

            if (link.kind === "symlink" && options?.noFollow === true) {
                throw new FileError("invalid", "Symbolic link", target);
            }

            return { vm, stat: await vm.fs.stat(target, true, signal) };
        });

        if (!opened.ok) {
            return opened;
        }

        const { vm, stat } = opened.value;

        if (stat.kind === "directory") {
            return err(new FileError("is_directory", "Is a directory", resolved));
        }

        const info = infoOf(resolved, stat);

        if (!info.ok) {
            return err(new FileError("invalid", "Not a regular file", resolved));
        }

        if (stat.size > MAX_READER_BYTES) {
            return err(
                new FileError(
                    "invalid",
                    `The file is larger than the sandbox reads at once (${MAX_READER_BYTES / 1024 / 1024} MB). Use bash to look at it.`,
                    resolved,
                ),
            );
        }

        try {
            return ok(
                new MemoryBinaryReader(
                    resolved,
                    info.value,
                    await vm.fs.readFile(resolved, context.abortSignal),
                ),
            );
        } catch (error) {
            return err(fileError(error, resolved));
        }
    }

    writeFile(
        path: string,
        content: string | Uint8Array,
        context: Context,
    ): Promise<Result<void, FileError>> {
        return this.#fs(path, context, (vm, resolved, signal) =>
            vm.fs.writeFile(
                resolved,
                typeof content === "string" ? Buffer.from(content, "utf8") : content,
                signal,
            ),
        );
    }

    appendFile(
        path: string,
        content: string | Uint8Array,
        context: Context,
    ): Promise<Result<void, FileError>> {
        return this.#fs(path, context, async (vm, resolved, signal) => {
            const existing = await vm.fs.readFile(resolved, signal).catch((error: unknown) => {
                if ((error as GuestError).code === "ENOENT") {
                    return new Uint8Array();
                }

                throw error;
            });
            const added = typeof content === "string" ? Buffer.from(content, "utf8") : content;

            await vm.fs.writeFile(resolved, Buffer.concat([existing, added]), signal);
        });
    }

    truncateFile(path: string, size: number, context: Context): Promise<Result<void, FileError>> {
        return this.#fs(path, context, async (vm, resolved, signal) => {
            const existing = await vm.fs.readFile(resolved, signal);
            const next = Buffer.alloc(size);

            Buffer.from(existing).copy(next, 0, 0, Math.min(size, existing.length));
            await vm.fs.writeFile(resolved, next, signal);
        });
    }

    async flushFile(path: string, context: Context): Promise<Result<void, FileError>> {
        return this.#fs(path, context, async (vm, resolved, signal) => {
            await vm.fs.stat(resolved, true, signal);
        });
    }

    async renameFile(
        sourcePath: string,
        destinationPath: string,
        context: Context,
    ): Promise<Result<void, FileError>> {
        const to = this.#resolve(destinationPath);

        return this.#fs(sourcePath, context, (vm, from, signal) => vm.fs.rename(from, to, signal));
    }

    async fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
        const stat = await this.#fs(path, context, (vm, resolved, signal) =>
            vm.fs.stat(resolved, false, signal),
        );

        return stat.ok ? infoOf(this.#resolve(path), stat.value) : stat;
    }

    async #entries(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
        const resolved = this.#resolve(path);
        const names = await this.#fs(path, context, (vm, target, signal) =>
            vm.fs.list(target, signal),
        );

        if (!names.ok) {
            return names;
        }

        const entries: FileInfo[] = [];

        for (const name of names.value) {
            const child = posix.join(resolved, name);
            const info = await this.fileInfo(child, context);

            if (info.ok) {
                entries.push(info.value);
            } else if (info.error.code === "aborted") {
                return info;
            }
        }

        return ok(entries);
    }

    listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
        return this.#entries(path, context);
    }

    async openDirReader(path: string, context: Context): Promise<Result<DirReader, FileError>> {
        const resolved = this.#resolve(path);
        const opened = await this.#fs(path, context, async (vm, target, signal) => {
            if ((await vm.fs.stat(target, true, signal)).kind !== "directory") {
                throw new FileError("not_directory", "Not a directory", target);
            }

            return vm.fs.list(target, signal);
        });

        return opened.ok
            ? ok(
                  new ListReader(opened.value, (name, each) =>
                      this.fileInfo(posix.join(resolved, name), each),
                  ),
              )
            : opened;
    }

    async watch(
        _targets: readonly WatchTarget[],
        _onChange: (change: FileChange) => void,
    ): Promise<Result<FileWatcher, FileError>> {
        return err(new FileError("not_supported", "The sandbox does not report file changes."));
    }

    async canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
        const resolved = this.#resolve(path);
        const found = await this.#capture(["readlink", "-f", "--", resolved], context);

        if (!found.ok) {
            return err(fileError(found.error, resolved));
        }

        const text = found.value.stdout.trim();

        if (found.value.exitCode !== 0 || text === "") {
            return err(
                new FileError("not_found", `No such file or directory: ${resolved}`, resolved),
            );
        }

        return ok(text);
    }

    async exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
        const info = await this.fileInfo(path, context);

        if (info.ok) {
            return ok(true);
        }

        return info.error.code === "not_found" ? ok(false) : err(info.error);
    }

    createDir(
        path: string,
        options: { recursive?: boolean } | undefined,
        context: Context,
    ): Promise<Result<void, FileError>> {
        return this.#fs(path, context, (vm, resolved, signal) =>
            vm.fs.mkdir(resolved, options?.recursive ?? true, signal),
        );
    }

    remove(
        path: string,
        options: { recursive?: boolean; force?: boolean } | undefined,
        context: Context,
    ): Promise<Result<void, FileError>> {
        return this.#fs(path, context, (vm, resolved, signal) =>
            vm.fs.remove(
                resolved,
                { recursive: options?.recursive ?? false, force: options?.force ?? false },
                signal,
            ),
        );
    }

    async createTempDir(
        prefix: string | undefined,
        context: Context,
    ): Promise<Result<string, FileError>> {
        const made = await this.#capture(
            ["mktemp", "-d", `/tmp/${prefix ?? "tmp-"}XXXXXX`],
            context,
        );

        if (!made.ok) {
            return err(fileError(made.error));
        }

        return made.value.exitCode === 0
            ? ok(made.value.stdout.trim())
            : err(new FileError("unknown", made.value.stderr.trim() || "mktemp failed"));
    }

    async createTempFile(
        options: { prefix?: string; suffix?: string } | undefined,
        context: Context,
    ): Promise<Result<string, FileError>> {
        const dir = await this.createTempDir("tmp-", context);

        if (!dir.ok) {
            return dir;
        }

        const path = posix.join(
            dir.value,
            `${options?.prefix ?? ""}${crypto.randomUUID()}${options?.suffix ?? ""}`,
        );
        const written = await this.writeFile(path, "", context);

        return written.ok ? ok(path) : written;
    }

    async cleanup(): Promise<void> {}

    /** A short command whose output is wanted whole (not a tool's). */
    async #capture(
        argv: string[],
        context: Context,
        cwd?: string,
    ): Promise<Result<{ exitCode: number; stdout: string; stderr: string }, ExecutionError>> {
        let stdout = "";
        let stderr = "";
        const result = await this.#run(
            argv,
            {
                ...(cwd === undefined ? {} : { cwd }),
                onOutput: (text, _context, info) => {
                    if (info.stream === "stderr") {
                        stderr += text;
                    } else {
                        stdout += text;
                    }
                },
            },
            context,
        );

        return result.ok ? ok({ exitCode: result.value.exitCode, stdout, stderr }) : result;
    }

    async exec(
        command: string | readonly string[],
        options: ShellExecOptions | undefined,
        context: Context,
    ): Promise<Result<ShellExecResult, ExecutionError>> {
        const signal = context.abortSignal;

        if (signal?.aborted) {
            return err(new ExecutionError("aborted", "aborted"));
        }

        const timeout = options?.timeout;

        if (timeout !== undefined && !(Number.isFinite(timeout) && timeout > 0)) {
            return err(
                new ExecutionError("unknown", "timeout must be a positive number of seconds"),
            );
        }

        if (typeof command !== "string") {
            if (command.length === 0 || command[0] === "") {
                return err(new ExecutionError("spawn_error", "No program to run."));
            }

            // `exec` of a program with no path searches only the guest's PATH, which `sh` does.
            const probe = await this.#capture(
                ["/bin/sh", "-c", 'command -v -- "$0"', command[0]!],
                context,
                options?.cwd,
            );

            if (!probe.ok || probe.value.exitCode !== 0) {
                return err(
                    new ExecutionError(
                        "spawn_error",
                        `spawn ${command[0]} ENOENT: not found in the sandbox`,
                    ),
                );
            }
        }

        return this.#run(
            typeof command === "string"
                ? [this.#shell(), "-lc", command]
                : ["/bin/sh", "-c", 'exec "$0" "$@"', ...command],
            options,
            context,
        );
    }

    /** Run `argv` in the guest, as is. */
    async #run(
        argv: string[],
        options: ShellExecOptions | undefined,
        context: Context,
    ): Promise<Result<ShellExecResult, ExecutionError>> {
        const signal = context.abortSignal;
        const timeout = options?.timeout;

        if (signal?.aborted) {
            return err(new ExecutionError("aborted", "aborted"));
        }

        let vm: GuestVm;

        try {
            vm = await this.#host.ready(signal);
        } catch (error) {
            if (signal?.aborted) {
                return err(new ExecutionError("aborted", "aborted"));
            }

            return err(
                new ExecutionError(
                    "spawn_error",
                    error instanceof Error ? error.message : String(error),
                    error instanceof Error ? error : undefined,
                ),
            );
        }

        const stop = new AbortController();
        const onAbort = () => stop.abort();
        let timedOut = false;
        const timer =
            timeout === undefined
                ? undefined
                : setTimeout(() => {
                      timedOut = true;
                      stop.abort();
                  }, timeout * 1000);
        const done = this.#host.busy();
        const decoders = { stdout: new StreamDecoder(), stderr: new StreamDecoder() };
        let callbackError: Error | undefined;

        signal?.addEventListener("abort", onAbort, { once: true });

        try {
            const env: Record<string, string> = {};

            for (const [name, value] of Object.entries(options?.env ?? {})) {
                if (typeof value === "string") {
                    env[name] = value;
                }
            }

            const process = vm.exec(argv, {
                cwd: options?.cwd === undefined ? this.cwd : this.#resolve(options.cwd),
                env,
                signal: stop.signal,
            });
            const pump = (async () => {
                for await (const chunk of process.output()) {
                    this.#host.touch();
                    const text = decoders[chunk.stream].decode(chunk.data);

                    if (text !== "" && callbackError === undefined) {
                        try {
                            options?.onOutput?.(text, context, { stream: chunk.stream });
                        } catch (error) {
                            callbackError =
                                error instanceof Error ? error : new Error(String(error));
                            stop.abort();
                        }
                    }
                }
            })();
            const [result] = await Promise.allSettled([process.result, pump]);

            for (const stream of ["stdout", "stderr"] as const) {
                const rest = decoders[stream].decode();

                if (rest !== "" && callbackError === undefined) {
                    options?.onOutput?.(rest, context, { stream });
                }
            }

            if (callbackError !== undefined) {
                return err(
                    new ExecutionError("callback_error", callbackError.message, callbackError),
                );
            }

            if (signal?.aborted) {
                return err(new ExecutionError("aborted", "aborted"));
            }

            if (timedOut) {
                return err(new ExecutionError("timeout", `timeout:${timeout}`));
            }

            if (result.status === "rejected") {
                const reason = result.reason as unknown;

                return err(
                    new ExecutionError(
                        "spawn_error",
                        `The sandbox stopped: ${reason instanceof Error ? reason.message : String(reason)}`,
                        reason instanceof Error ? reason : undefined,
                    ),
                );
            }

            return ok({ exitCode: result.value.exitCode });
        } catch (error) {
            if (signal?.aborted) {
                return err(new ExecutionError("aborted", "aborted"));
            }

            return err(
                new ExecutionError(
                    "spawn_error",
                    error instanceof Error ? error.message : String(error),
                    error instanceof Error ? error : undefined,
                ),
            );
        } finally {
            if (timer !== undefined) {
                clearTimeout(timer);
            }

            signal?.removeEventListener("abort", onAbort);
            done();
        }
    }
}
