/** One runner-owned command: stdin is its lifetime lease, and only this process writes its task files. */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { constants, closeSync, existsSync, openSync, writeFileSync, writeSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { win32 } from "node:path";
import { createInterface } from "node:readline";
import type { TaskInput } from "./tasks.ts";
import { windowsSystemProgram } from "./windows.ts";

/** The helper stays outside the job. Its pipe closes even if this host is killed without cleanup. */
const JOB = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class TaskJob {
    [StructLayout(LayoutKind.Sequential)] public struct Basic {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinWorkingSet, MaxWorkingSet;
        public uint ActiveProcesses;
        public UIntPtr Affinity;
        public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] public struct Io {
        public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
    }
    [StructLayout(LayoutKind.Sequential)] public struct Extended {
        public Basic Basic;
        public Io Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential)] public struct Accounting {
        public long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime;
        public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
    }
    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting info, uint size, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError=true, EntryPoint="QueryInformationJobObject")]
    public static extern bool QueryProcessIds(IntPtr job, int kind, IntPtr list, uint size, IntPtr returned);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern bool SetInformationJobObject(IntPtr job, int kind, ref Extended info, uint size);
    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
}
'@
$job = [TaskJob]::CreateJobObject([IntPtr]::Zero, $null)
if ($job -eq [IntPtr]::Zero) { throw 'CreateJobObject failed' }
$limits = New-Object TaskJob+Extended
$basic = New-Object TaskJob+Basic
$basic.Flags = 0x2000
$limits.Basic = $basic
if (-not [TaskJob]::SetInformationJobObject($job, 9, [ref]$limits, [uint32][Runtime.InteropServices.Marshal]::SizeOf([type][TaskJob+Extended]))) { throw 'SetInformationJobObject failed' }
$hostProcess = [TaskJob]::OpenProcess(0x101, $false, HOST_PID)
if ($hostProcess -eq [IntPtr]::Zero) { throw 'OpenProcess failed' }
$assigned = [TaskJob]::AssignProcessToJobObject($job, $hostProcess)
[void][TaskJob]::CloseHandle($hostProcess)
if (-not $assigned) { throw 'AssignProcessToJobObject failed' }
[Console]::Out.WriteLine('ok')
[Console]::Out.Flush()
while ($null -ne ($request = [Console]::In.ReadLine())) {
    if ($request -eq 'active') {
        $info = New-Object TaskJob+Accounting
        if ([TaskJob]::QueryInformationJobObject($job, 1, [ref]$info, [uint32][Runtime.InteropServices.Marshal]::SizeOf([type][TaskJob+Accounting]), [IntPtr]::Zero)) {
            [Console]::Out.WriteLine('active ' + $info.ActiveProcesses)
            [Console]::Out.Flush()
        }
    } elseif ($request -eq 'pids') {
        # JOBOBJECT_BASIC_PROCESS_ID_LIST: two DWORDs, then one ULONG_PTR per process, from offset 8.
        $size = 8 + 1024 * [IntPtr]::Size
        $list = [Runtime.InteropServices.Marshal]::AllocHGlobal($size)
        try {
            $ids = @()
            if ([TaskJob]::QueryProcessIds($job, 3, $list, [uint32]$size, [IntPtr]::Zero)) {
                $count = [Runtime.InteropServices.Marshal]::ReadInt32($list, 4)
                for ($i = 0; $i -lt $count; $i++) {
                    $ids += [Runtime.InteropServices.Marshal]::ReadIntPtr($list, 8 + $i * [IntPtr]::Size).ToInt64()
                }
            }
            [Console]::Out.WriteLine('pids ' + ($ids -join ','))
            [Console]::Out.Flush()
        } finally {
            [Runtime.InteropServices.Marshal]::FreeHGlobal($list)
        }
    }
}
[void][TaskJob]::CloseHandle($job)
`;

let job: ChildProcess | undefined;
let child: ChildProcess | undefined;
let input: TaskInput | undefined;
let stopping = false;
let closed = false;
let done = false;
let code = 1;
let killTimer: NodeJS.Timeout | undefined;
let groupTimer: NodeJS.Timeout | undefined;
/** The Windows job includes this host, so 1 means that the task has no processes left. */
let jobActive: number | undefined;
/** Who waits for the job's list of processes (`left`). */
let jobLists: ((pids: number[] | undefined) => void)[] = [];
let log: number | undefined;
let used = 0;
let segment = 0;
let logFailed = false;

function report(value: object): void {
    if (process.connected) {
        process.send?.(value, () => {});
    }
}

function suffix(index: number): string {
    if (index >= 26 ** 6) {
        throw new Error("The background task exhausted its log segment names.");
    }

    let name = "";

    for (let place = 0; place < 6; place++) {
        name = String.fromCharCode(97 + (index % 26)) + name;
        index = Math.floor(index / 26);
    }

    return name;
}

function output(bytes: Buffer): void {
    let offset = 0;

    while (offset < bytes.length) {
        if (log === undefined || used === input!.segment) {
            if (log !== undefined) {
                closeSync(log);
                log = undefined;
            }

            log = openSync(`${input!.logPrefix}${suffix(segment++)}`, "wx", 0o600);
            used = 0;
        }

        const count = Math.min(bytes.length - offset, input!.segment - used);
        const written = writeSync(log, bytes, offset, count);

        offset += written;
        used += written;
    }
}

/** The shell's result is final even when its descendants still need this host's lifetime lease. */
function complete(): void {
    if (done || input === undefined) {
        return;
    }

    done = true;

    try {
        const exit = openSync(
            input.exitFile,
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
            0o600,
        );

        try {
            writeFileSync(exit, `${code} 0`);
        } finally {
            closeSync(exit);
        }
    } catch (error) {
        report({ error: `Cannot write the background task files: ${(error as Error).message}` });
    }

    report({ ended: true });
    finish();
}

function groupAlive(): boolean {
    if (child?.pid === undefined) {
        return false;
    }

    if (process.platform === "win32") {
        // Without a queryable job, taskkill cannot reliably see a tree after its root exits. Keep the lease.
        return job === undefined || jobActive === undefined || jobActive > 1;
    }

    try {
        process.kill(-child.pid, 0);

        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
}

function finish(): void {
    if (!done || !closed || killTimer !== undefined) {
        return;
    }

    if (!stopping && groupAlive()) {
        groupTimer ??= setTimeout(() => {
            groupTimer = undefined;
            job?.stdin?.write("active\n");
            finish();
        }, 1000);

        return;
    }

    if (log !== undefined) {
        closeSync(log);
    }

    job?.stdin?.end();
    process.exit(0);
}

function signal(name: "TERM" | "KILL"): void {
    if (child?.pid === undefined) {
        return;
    }

    if (process.platform === "win32") {
        if (done && job !== undefined) {
            // The job still owns the descendants after taskkill loses their shell. Closing it kills the whole job.
            job.stdin?.end();

            return;
        }

        const killer = spawn(
            windowsSystemProgram("taskkill.exe"),
            ["/PID", String(child.pid), "/T", ...(name === "KILL" ? ["/F"] : [])],
            { stdio: "ignore", windowsHide: true },
        );

        killer.on("error", () => {});
    } else {
        try {
            process.kill(-child.pid, name === "TERM" ? "SIGTERM" : "SIGKILL");
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
                report({ error: `Cannot stop the background task: ${(error as Error).message}` });
            }
        }
    }
}

function stop(): void {
    if (stopping) {
        return;
    }

    stopping = true;
    signal(process.platform === "win32" ? "KILL" : "TERM");

    if (child === undefined) {
        if (input === undefined) {
            process.exit(0);
        }

        return;
    }

    // Keep the host alive for the full grace period even if the shell exits before one of its children.
    killTimer = setTimeout(() => {
        signal("KILL");
        killTimer = undefined;
        finish();
    }, 5000);
}

/**
 * The processes of the task that still run after its shell ended: what it left behind, which the session names. Its
 * group on Linux and macOS (`pgrep -g`), its Job Object's processes but this host on Windows. Undefined when they
 * cannot be listed (no `pgrep`, no job): the runner then names the task's shell, as before.
 */
async function left(): Promise<number[] | undefined> {
    if (child?.pid === undefined) {
        return [];
    }

    if (process.platform === "win32") {
        const helper = job;

        if (helper?.stdin === undefined || helper.stdin === null || helper.exitCode !== null) {
            return undefined;
        }

        const pids = await new Promise<number[] | undefined>((resolve) => {
            const timer = setTimeout(() => resolve(undefined), 3000);

            jobLists.push((found) => {
                clearTimeout(timer);
                resolve(found);
            });
            helper.stdin!.write("pids\n");
        });

        return pids?.filter((pid) => pid !== process.pid);
    }

    const group = child.pid;

    return new Promise((resolve) => {
        execFile("pgrep", ["-g", String(group)], { timeout: 3000 }, (error, stdout) => {
            // Its exit code, 1 when no process is in the group; a string (ENOENT) when there is no pgrep.
            const code: unknown = (error as { code?: unknown } | null)?.code;

            if (error !== null && code !== 1) {
                resolve(undefined);

                return;
            }

            resolve(
                stdout
                    .split(/\s+/)
                    .map(Number)
                    .filter((pid) => Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid),
            );
        });
    });
}

async function windowsJob(): Promise<void> {
    const helper = spawn(
        windowsSystemProgram("powershell.exe"),
        ["-NoProfile", "-NonInteractive", "-Command", JOB.replace("HOST_PID", String(process.pid))],
        { stdio: ["pipe", "pipe", "ignore"], windowsHide: true },
    );

    job = helper;
    helper.stdin!.on("error", () => {});

    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
            () => end(new Error("The Windows Job Object helper timed out.")),
            5000,
        );
        const lines = createInterface({ input: helper.stdout! });

        const end = (error?: Error) => {
            clearTimeout(timer);

            if (error === undefined) {
                resolve();
            } else {
                lines.close();
                reject(error);
            }
        };

        helper.once("error", end);
        helper.once("exit", () => end(new Error("The Windows Job Object helper stopped.")));
        lines.on("line", (line) => {
            if (line.startsWith("pids")) {
                const pids = line
                    .slice(4)
                    .split(",")
                    .map((each) => Number(each.trim()))
                    .filter((each) => Number.isSafeInteger(each) && each > 0);
                const waiting = jobLists;

                jobLists = [];

                for (const done of waiting) {
                    done(pids);
                }
            } else if (line.startsWith("active ")) {
                const count = Number(line.slice(7));

                if (Number.isSafeInteger(count) && count >= 1) {
                    jobActive = count;
                    finish();
                }
            } else {
                end(line === "ok" ? undefined : new Error(line));
            }
        });
    });
}

async function shell(): Promise<{ file: string; args: string[]; verbatim?: boolean }> {
    if (input!.shell !== undefined) {
        return { file: input!.shell, args: ["-c", input!.command] };
    }

    if (process.platform !== "win32") {
        return { file: "bash", args: ["-c", input!.command] };
    }

    const found = await new Promise<string>((resolve) => {
        const where = spawn(windowsSystemProgram("where.exe"), ["bash.exe"], {
            stdio: ["ignore", "pipe", "ignore"],
            windowsHide: true,
        });
        let text = "";
        const timer = setTimeout(() => {
            where.kill();
            resolve("");
        }, 5000);

        where.stdout!.on("data", (bytes) => {
            text += bytes.toString();
        });
        where.once("error", () => {
            clearTimeout(timer);
            resolve("");
        });
        where.once("close", () => {
            clearTimeout(timer);
            resolve(text);
        });
    });
    const root = process.env.SystemRoot ?? "C:\\Windows";
    const wsl = ["System32", "Sysnative"].map((dir) =>
        win32.join(root, dir, "bash.exe").toLowerCase(),
    );
    const candidates = [
        ...found.trim().split(/\r?\n/).filter(Boolean),
        ...[process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]
            .filter((dir): dir is string => dir !== undefined)
            .map((dir) => win32.join(dir, "Git", "bin", "bash.exe")),
    ];
    const bash = candidates.find(
        (file) => !wsl.includes(win32.normalize(file).toLowerCase()) && existsSync(file),
    );

    return bash === undefined
        ? {
              file: process.env.ComSpec ?? "cmd.exe",
              args: ["/d", "/s", "/c", `"${input!.command}"`],
              // Match Node's cmd.exe shell transport: CMD, not CreateProcess, must parse the command.
              verbatim: true,
          }
        : { file: bash, args: ["-c", input!.command] };
}

async function start(): Promise<void> {
    if (process.platform === "win32") {
        try {
            await windowsJob();
        } catch (error) {
            // Without the job, a task could outlive the runner: it does not start (`docs/runners.md`).
            report({
                error: `Background tasks need a Windows Job Object, which could not be set up (${(error as Error).message}). The task did not start.`,
            });
            const failed = job;

            job = undefined;

            if (
                failed?.pid !== undefined &&
                failed.exitCode === null &&
                failed.signalCode === null
            ) {
                const stopped = new Promise<void>((resolve) =>
                    failed.once("exit", () => resolve()),
                );

                failed.kill();
                await stopped;
            }

            code = 127;
            closed = true;
            complete();

            return;
        }
    }

    const config = stopping ? undefined : await shell();

    if (stopping || config === undefined) {
        closed = true;
        complete();

        return;
    }

    log = openSync(`${input!.logPrefix}${suffix(segment++)}`, "wx", 0o600);

    const launch = (file: string, args: string[], fallback: boolean): void => {
        child = spawn(file, args, {
            cwd: input!.cwd,
            env: { ...process.env, ...input!.env },
            stdio: ["ignore", "pipe", "pipe"],
            detached: process.platform !== "win32",
            windowsHide: true,
            windowsVerbatimArguments: config.verbatim === true,
        });
        const command = child;

        command.once("spawn", () => report({ pid: command.pid }));
        command.once("error", (error: NodeJS.ErrnoException) => {
            if (fallback && error.code === "ENOENT" && !stopping) {
                launch("sh", ["-c", input!.command], false);

                return;
            }

            report({ error: `Cannot start the background task: ${error.message}` });
            code = 127;
            closed = true;
            complete();
        });
        command.once("exit", (status, killed) => {
            code = status ?? 128 + (killed === null ? 0 : (osConstants.signals[killed] ?? 0));
            complete();
        });
        command.once("close", () => {
            if (child === command) {
                closed = true;
                finish();
            }
        });

        for (const stream of [command.stdout!, command.stderr!]) {
            stream.on("data", (bytes: Buffer) => {
                if (logFailed) {
                    return;
                }

                try {
                    output(bytes);
                } catch (error) {
                    logFailed = true;
                    report({ error: `Cannot write the task log: ${(error as Error).message}` });
                    stop();
                }
            });
        }
    };

    launch(config.file, config.args, process.platform !== "win32" && input!.shell === undefined);
}

const lines = createInterface({ input: process.stdin });

lines.on("line", (line) => {
    try {
        if (input === undefined) {
            input = JSON.parse(line) as TaskInput;
            void start().catch((error: Error) => {
                report({ error: error.message });
                code = 127;
                closed = true;
                complete();
            });
        }
    } catch (error) {
        report({ error: (error as Error).message });
        stop();
    }
});
process.on("message", (request: { signal?: string; query?: string }) => {
    if (request.signal === "TERM" || request.signal === "KILL") {
        signal(request.signal);
    } else if (request.query === "left") {
        void left().then((pids) => report({ left: pids ?? null }));
    }
});
lines.on("close", stop);
process.stdin.on("error", stop);
process.on("disconnect", stop);
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
