/** Task hosts belong to the runner, not its replaceable pi-env daemon or WebSocket. */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { canonical } from "./request-gate.ts";
import { folderContains } from "./folders.ts";
import type { TaskRequest, TaskResult } from "./protocol.ts";

export type TaskInput = {
    command: string;
    cwd: string;
    env: Record<string, string>;
    logPrefix: string;
    exitFile: string;
    segment: number;
    shell?: string;
};

/**
 * The task host's `--import` flags: this process's own (never its inspector or test-runner flags), and from an npm install
 * (a node_modules folder, where Node strips no types) the hook that does (`bin/strip-types.js`), which `bin/pi-pocket.js`
 * loads in its own process rather than with a flag, so `process.execArgv` does not have it.
 */
export function taskImports(root = fileURLToPath(new URL("../..", import.meta.url))): string[] {
    const hook = new URL("../../bin/strip-types.js", import.meta.url).href;
    const args: string[] = root.split(sep).includes("node_modules") ? ["--import", hook] : [];

    for (let index = 0; index < process.execArgv.length; index++) {
        const arg = process.execArgv[index]!;

        if (arg === "--import" && process.execArgv[index + 1] !== undefined) {
            const value = process.execArgv[++index]!;

            if (value !== hook) {
                args.push(arg, value);
            }
        } else if (arg.startsWith("--import=") && arg !== `--import=${hook}`) {
            args.push(arg);
        }
    }

    return args;
}

type Host = {
    child: ChildProcess;
    permission: string;
    task: string;
    pid: number;
    shellEnded: boolean;
    ended: Promise<void>;
    /** Who waits for the host's list of what the task left running (`#left`). */
    leftWaiting: ((pids: number[] | undefined) => void)[];
};

export class Tasks {
    readonly #hosts = new Map<string, Host>();
    readonly #starts = new Map<string, Promise<TaskResult>>();
    readonly #authorize: (permission: string, cwd?: string) => Promise<() => void>;
    readonly #log: (line: string) => void;
    #stopping = false;
    #warned = false;

    constructor(
        authorize: (permission: string, cwd?: string) => Promise<() => void>,
        log: (line: string) => void,
    ) {
        this.#authorize = authorize;
        this.#log = log;
    }

    async request(request: TaskRequest): Promise<TaskResult> {
        const key = request.op === "list" ? "" : `${request.permission}/${request.task}`;
        const pending =
            request.op === "list"
                ? [...this.#starts]
                      .filter(([key]) => key.startsWith(`${request.permission}/`))
                      .map(([, value]) => value)
                : [this.#starts.get(key)];
        const previous = Promise.allSettled(pending);

        if (request.op !== "start") {
            await previous;

            return this.#request(request);
        }

        const started = previous.then(() => this.#request(request));

        this.#starts.set(key, started);

        try {
            return await started;
        } finally {
            if (this.#starts.get(key) === started) {
                this.#starts.delete(key);
            }
        }
    }

    async #request(request: TaskRequest): Promise<TaskResult> {
        const finish = await this.#authorize(
            request.permission,
            request.op === "start" ? request.cwd : undefined,
        );
        let held = false;

        try {
            if (this.#stopping) {
                throw new Error("The runner is stopping.");
            }

            if (
                !/^[A-Za-z0-9._-]+$/.test(request.permission) ||
                [".", ".."].includes(request.permission)
            ) {
                throw new Error("Invalid background task permission id.");
            }

            if (request.op === "list") {
                return {
                    type: "task-result",
                    id: request.id,
                    ok: true,
                    tasks: await Promise.all(
                        [...this.#hosts.values()]
                            .filter((host) => host.permission === request.permission)
                            .map(async (host) => {
                                const left = host.shellEnded ? await this.#left(host) : undefined;

                                return {
                                    task: host.task,
                                    pid: host.pid,
                                    ...(host.shellEnded ? { ended: true as const } : {}),
                                    ...(left === undefined ? {} : { left }),
                                };
                            }),
                    ),
                };
            }

            const key = `${request.permission}/${request.task}`;
            const existing = this.#hosts.get(key);

            if (request.op === "signal") {
                // Unknown tasks and tasks of another permission are indistinguishable.
                if (existing?.child.connected) {
                    existing.child.send({ signal: request.signal }, () => {});
                }

                return { type: "task-result", id: request.id, ok: true };
            }

            if (existing !== undefined) {
                return { type: "task-result", id: request.id, ok: true, pid: existing.pid };
            }

            if (!/^[A-Za-z0-9._-]+$/.test(request.task) || [".", ".."].includes(request.task)) {
                throw new Error("Invalid background task id.");
            }

            const dir = join(await canonical(tmpdir()), "pi-pocket-tasks", request.permission);
            const real = await canonical(dir);

            if (!folderContains(dir, real) || !folderContains(real, dir)) {
                throw new Error("The background task folder is outside its permitted folder.");
            }

            await mkdir(dir, { recursive: true });

            if (this.#stopping) {
                throw new Error("The runner is stopping.");
            }

            const child = spawn(
                process.execPath,
                [...taskImports(), fileURLToPath(new URL("./task-host.ts", import.meta.url))],
                {
                    // IPC reports startup, or why the task could not start (no Windows Job Object); task output stays on disk.
                    stdio: ["pipe", "ignore", "ignore", "ipc"],
                    detached: process.platform !== "win32",
                    windowsHide: true,
                },
            );
            const ended = new Promise<void>((resolve) => {
                child.once("exit", () => resolve());
                child.once("error", () => resolve());
            });
            const host: Host = {
                child,
                permission: request.permission,
                task: request.task,
                pid: child.pid ?? 0,
                shellEnded: false,
                ended,
                leftWaiting: [],
            };

            this.#hosts.set(key, host);
            held = true;
            child.stdin!.on("error", () => {});
            void ended.then(() => {
                if (this.#hosts.get(key) === host) {
                    this.#hosts.delete(key);
                }

                finish();
            });

            const ready = new Promise<number>((resolve, reject) => {
                child.once("error", reject);
                child.once("exit", () =>
                    reject(new Error("The task host stopped before starting its command.")),
                );
                child.on(
                    "message",
                    (value: {
                        pid?: number;
                        ended?: boolean;
                        warning?: string;
                        error?: string;
                        left?: number[] | null;
                    }) => {
                        if (value.ended === true) {
                            host.shellEnded = true;
                        }

                        if ("left" in value) {
                            const waiting = host.leftWaiting;

                            host.leftWaiting = [];

                            for (const done of waiting) {
                                done(Array.isArray(value.left) ? value.left : undefined);
                            }

                            return;
                        }

                        if (value.warning !== undefined && !this.#warned) {
                            this.#warned = true;
                            this.#log(`Background tasks: ${value.warning}`);
                        }

                        if (value.error !== undefined) {
                            reject(new Error(value.error));
                        } else if (typeof value.pid === "number" && value.pid > 0) {
                            host.pid = value.pid;
                            resolve(value.pid);
                        }
                    },
                );
            });
            const input: TaskInput = {
                command: request.command,
                cwd: request.cwd,
                env: request.env,
                logPrefix: join(dir, `${request.task}.log.`),
                exitFile: join(dir, `${request.task}.exit`),
                segment: request.segment,
            };

            child.stdin!.write(`${JSON.stringify(input)}\n`);

            try {
                return { type: "task-result", id: request.id, ok: true, pid: await ready };
            } catch (error) {
                child.stdin!.end();

                throw error;
            }
        } finally {
            if (!held) {
                finish();
            }
        }
    }

    /**
     * What an ended task left running, as its host finds it: the processes themselves, not the shell that started them
     * and is gone. Undefined when the host cannot say (an older one, or no way to list them), within 4 seconds.
     */
    #left(host: Host): Promise<number[] | undefined> {
        if (!host.child.connected) {
            return Promise.resolve(undefined);
        }

        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                host.leftWaiting = host.leftWaiting.filter((each) => each !== done);
                resolve(undefined);
            }, 4000);

            const done = (pids: number[] | undefined) => {
                clearTimeout(timer);
                resolve(pids);
            };

            host.leftWaiting.push(done);
            host.child.send({ query: "left" }, () => {});
        });
    }

    async stop(): Promise<void> {
        this.#stopping = true;
        const hosts = [...this.#hosts.values()];

        for (const host of hosts) {
            host.child.stdin?.end();
        }

        let timer: NodeJS.Timeout | undefined;

        await Promise.race([
            Promise.all(hosts.map((host) => host.ended)),
            new Promise<void>((resolve) => {
                timer = setTimeout(resolve, 6000);
            }),
        ]);
        clearTimeout(timer);
    }
}
