/**
 * A fake micro-VM for tests: the "guest" is the temp folder `guestRoot` of this machine, with the same paths, and
 * commands run in a real shell with only the variables the call gave. It has none of Gondolin's isolation. It is for
 * checking what Pi Pocket does around a VM: routing, lifecycle, failure, who may choose.
 */
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import * as fs from "node:fs/promises";
import { EventEmitter } from "node:events";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type {
    GuestChunk,
    GuestExecOptions,
    GuestFs,
    GuestProcess,
    GuestStat,
    GuestVm,
    HostCheck,
    SandboxDriver,
    SetupOptions,
    VmSpec,
} from "../src/server/extensions/gondolin/guest.ts";

// The tests that use a fake VM run on every OS: the gate that allows only Linux (`sandboxPlatformProblem`) is told so.
(globalThis as Record<symbol, unknown>)[Symbol.for("pi-pocket.sandbox.test-platform")] = "linux";

export interface FakeLog {
    started: VmSpec[];
    closed: string[];
    /** Every argv a guest ran. */
    commands: string[][];
    /** The environment each command got. */
    envs: Record<string, string>[];
    setups: SetupOptions[];
}

export class FakeDriver implements SandboxDriver {
    readonly log: FakeLog = { started: [], closed: [], commands: [], envs: [], setups: [] };
    /** Make `start` fail with this message. */
    failStart: string | undefined;
    /** What `check` answers. */
    checkResult: HostCheck = {
        ok: true,
        lines: [{ name: "fake", ok: true, detail: "a fake VM" }],
        backend: "krun",
        images: [{ name: "alpine-base:latest", browser: false }],
    };
    /** A delay before a VM is ready, in ms. */
    startDelay = 0;
    readonly vms: FakeVm[] = [];
    #next = 1;

    async check(): Promise<HostCheck> {
        return this.checkResult;
    }

    async setup(options: SetupOptions, progress: (line: string) => void): Promise<void> {
        this.log.setups.push(options);
        progress("fake set-up");
    }

    async remove(): Promise<void> {}

    async start(spec: VmSpec): Promise<GuestVm> {
        this.log.started.push(spec);

        if (this.startDelay > 0) {
            await new Promise((resolve) => setTimeout(resolve, this.startDelay));
        }

        if (this.failStart !== undefined) {
            throw new Error(this.failStart);
        }

        const vm = new FakeVm(`fake-${this.#next++}`, this.log);

        this.vms.push(vm);

        return vm;
    }
}

const fakeFs: GuestFs = {
    readFile: async (path) => new Uint8Array(await fs.readFile(path)),
    writeFile: async (path, data) => fs.writeFile(path, data),
    stat: async (path, follow): Promise<GuestStat> => {
        const stats = await (follow ? fs.stat(path) : fs.lstat(path));

        return {
            kind: stats.isSymbolicLink()
                ? "symlink"
                : stats.isDirectory()
                  ? "directory"
                  : stats.isFile()
                    ? "file"
                    : "other",
            size: stats.size,
            mtimeMs: stats.mtimeMs,
        };
    },
    list: (path) => fs.readdir(path),
    mkdir: async (path, recursive) => {
        await fs.mkdir(path, { recursive });
    },
    remove: (path, options) => fs.rm(path, options),
    rename: (from, to) => fs.rename(from, to),
};

export class FakeVm extends EventEmitter implements GuestVm {
    readonly id: string;
    readonly fs = fakeFs;
    closed = false;
    readonly #log: FakeLog;
    readonly #children = new Set<ReturnType<typeof spawn>>();

    constructor(id: string, log: FakeLog) {
        super();
        this.id = id;
        this.#log = log;
    }

    hostPid(): number | null {
        return null;
    }

    onExit(listener: (reason: string) => void): void {
        this.on("exit", listener);
    }

    /** End the VM as if its runner died. */
    crash(reason = "the runner died"): void {
        for (const child of this.#children) {
            killGroup(child);
        }

        this.closed = true;
        this.emit("exit", reason);
    }

    exec(argv: string[], options: GuestExecOptions = {}): GuestProcess {
        this.#log.commands.push(argv);
        this.#log.envs.push({ ...options.env });

        if (this.closed) {
            const failed = Promise.reject(new Error("The VM is closed."));

            failed.catch(() => {});

            return {
                output: async function* () {},
                result: failed,
                write() {},
                end() {},
            };
        }

        // The guest's Chromium is this machine's, so the DevTools pipe is real: `sh -c 'exec "$0" … 3<&0 4>&1'` works.
        const hostBrowser = findBrowser();
        const real = argv.map((word) =>
            word === "chromium-browser" && hostBrowser !== undefined ? hostBrowser : word,
        );
        const child = spawn(real[0]!, real.slice(1), {
            cwd: options.cwd,
            env: { PATH: "/usr/bin:/bin", HOME: tmpdir(), ...options.env },
            stdio: ["pipe", "pipe", "pipe"],
            detached: true,
        });

        this.#children.add(child);

        const stop = () => killGroup(child);

        options.signal?.addEventListener("abort", stop, { once: true });
        const chunks: GuestChunk[] = [];
        let wake: (() => void) | undefined;
        let ended = false;

        const push = (stream: "stdout" | "stderr") => (data: Buffer) => {
            chunks.push({ stream, data: new Uint8Array(data) });
            wake?.();
        };

        child.stdout.on("data", push("stdout"));
        child.stderr.on("data", push("stderr"));
        const result = new Promise<{ exitCode: number }>((resolve, reject) => {
            child.once("error", reject);
            child.once("close", (code, signal) => {
                this.#children.delete(child);
                ended = true;
                wake?.();
                resolve({ exitCode: code ?? (signal === null ? 1 : 137) });
            });
        });

        result.catch(() => {});

        return {
            output: async function* () {
                for (;;) {
                    while (chunks.length > 0) {
                        yield chunks.shift()!;
                    }

                    if (ended) {
                        return;
                    }

                    await new Promise<void>((resolve) => {
                        wake = resolve;
                    });
                }
            },
            result,
            write: (data) => {
                child.stdin.write(data);
            },
            end: () => {
                child.stdin.end();
            },
        };
    }

    async close(): Promise<void> {
        if (!this.closed) {
            this.closed = true;
            this.#log.closed.push(this.id);

            for (const child of this.#children) {
                killGroup(child);
            }
        }
    }
}

/**
 * End a command and everything it started, as a VM that stops does. Ending only the shell leaves a child (`tail -f` under
 * a shell that does not exec its last command) holding the output pipe open, so the command never reports its end.
 */
function killGroup(child: ReturnType<typeof spawn>): void {
    try {
        process.kill(-child.pid!, "SIGKILL");
    } catch {
        child.kill("SIGKILL");
    }
}
