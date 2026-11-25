/**
 * A stop must never hit a process that is not the task's: each process is known by its pid and its start time.
 * Linux and macOS run a task as the leader of its own process group; its marker in the environment finds what left it.
 * Windows has no groups, signals, or readable environments: a task is its first process, its descendants, and a job
 * object, and a PowerShell helper ends a process only through a handle whose start time it checked.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { win32 } from "node:path";

export const BACKGROUND_MARKER = "PI_POCKET_BACKGROUND";

export type TaskRef = {
    /** 0 while it is not known. */
    pid: number;
    startTicks?: number;
    boot?: string;
    marker: string;
    files: string;
    startedAt: number;
};

export type Signal = "SIGTERM" | "SIGKILL";

export interface TaskProcesses {
    /** A task from another boot has no process left. */
    readonly boot: string | undefined;
    unsupported(): Promise<string | undefined>;
    shell(): string | undefined;
    spawn(
        script: string,
        cwd: string,
        env: NodeJS.ProcessEnv,
        task: TaskRef,
        authorize?: () => void,
    ): Promise<{ pid: number; start?: number }>;
    /** Undefined when the process table cannot establish whether the task has members. */
    members(task: TaskRef, fresh?: boolean): Promise<number[] | undefined>;
    /** At once, from what is known now: for a count while the watches are off. */
    aliveSync(task: TaskRef): boolean;
    /** The processes with the task's marker that run outside its group. */
    left(task: TaskRef): Promise<number[]>;
    stillLeft(task: TaskRef, pids: readonly number[]): Promise<number[]>;
    signal(task: TaskRef, name: Signal, authorize?: () => void): Promise<void>;
    /** Before the task's record: a stop came first, or the record failed. */
    killSpawned(task: TaskRef, pid: number): Promise<void>;
    /** A start a crash cut off. Null means no process; undefined means the backend cannot tell. */
    find(task: TaskRef): Promise<{ pid: number; start?: number } | null | undefined>;
    close(): void;
}

function kill(pid: number, name: Signal | 0): boolean {
    try {
        process.kill(pid, name);

        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM" && name === 0;
    }
}

function spawnDetached(
    shell: string,
    script: string,
    cwd: string,
    env: NodeJS.ProcessEnv,
): ChildProcess {
    const child = spawn(shell, ["-c", script], {
        cwd,
        detached: true,
        stdio: "ignore",
        env,
        windowsHide: true,
    });

    child.on("error", () => {});

    if (child.pid === undefined) {
        throw new Error("The command could not start: no bash on this machine?");
    }

    child.unref();

    return child;
}

type Proc = { pid: number; pgid: number; state: string; start: number };

const gone = (info: Proc) => info.state === "Z" || info.state === "X";

/** A read the view cannot answer yet (macOS) is noted; `fill` fetches it, and the look runs again. */
interface ProcTable {
    readonly boot: string | undefined;
    /** Start times in whole seconds (macOS): a reused pid can have the same start, so a leader needs the marker too. */
    readonly coarse: boolean;
    unsupported(): string | undefined;
    begin(): void;
    stat(pid: number, fresh?: boolean): Proc | undefined;
    list(fresh: boolean): Proc[];
    /** `guess`: the answer while the environment is not read yet (macOS). */
    marked(pid: number, marker: string, guess?: boolean): boolean;
    /** False when the reads since `begin` missed nothing. */
    fill(): Promise<boolean>;
    known(): boolean;
    forget(): void;
}

class LinuxTable implements ProcTable {
    readonly coarse = false;
    readonly boot = (() => {
        try {
            return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
        } catch {
            return undefined;
        }
    })();

    #scan: { at: number; all: Proc[] } | undefined;

    unsupported(): string | undefined {
        return existsSync("/proc/self/stat")
            ? undefined
            : "Background tasks need Linux with /proc, macOS, or Windows: they follow their processes through /proc here.";
    }

    begin(): void {}

    stat(pid: number): Proc | undefined {
        try {
            const text = readFileSync(`/proc/${pid}/stat`, "utf8");
            // After the name, which can hold spaces and parentheses: state (3), ppid (4), pgrp (5), …, starttime (22).
            const rest = text.slice(text.lastIndexOf(")") + 2).split(" ");

            return { pid, pgid: Number(rest[2]), state: rest[0] ?? "", start: Number(rest[19]) };
        } catch {
            return undefined;
        }
    }

    /** Shared by the watches that look in the same moment. */
    list(fresh: boolean): Proc[] {
        const now = Date.now();

        if (!fresh && this.#scan !== undefined && now - this.#scan.at < 250) {
            return this.#scan.all;
        }

        const all: Proc[] = [];

        for (const name of readdirSync("/proc")) {
            if (/^\d+$/.test(name)) {
                const info = this.stat(Number(name));

                if (info !== undefined && !gone(info)) {
                    all.push(info);
                }
            }
        }

        this.#scan = { at: now, all };

        return all;
    }

    marked(pid: number, marker: string): boolean {
        try {
            return readFileSync(`/proc/${pid}/environ`, "utf8")
                .split("\0")
                .includes(`${BACKGROUND_MARKER}=${marker}`);
        } catch {
            return false;
        }
    }

    async fill(): Promise<boolean> {
        return false;
    }

    known(): boolean {
        return true;
    }

    forget(): void {
        this.#scan = undefined;
    }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `ps`'s `lstart` in the C locale and UTC, such as `Thu Nov 20 20:01:02 2026`, in seconds since 1970. */
function parseLstart(text: string): number | undefined {
    const parts = /^\w{3}\s+(\w{3})\s+(\d+)\s+(\d+):(\d+):(\d+)\s+(\d+)$/.exec(text.trim());
    const month = MONTHS.indexOf(parts?.[1] ?? "");

    if (parts === null || month < 0) {
        return undefined;
    }

    const [, , day, hours, minutes, seconds, year] = parts.map(Number);

    return Date.UTC(year!, month, day, hours, minutes, seconds) / 1000;
}

function run(file: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn(file, args, {
            stdio: ["ignore", "pipe", "ignore"],
            env: { ...process.env, LC_ALL: "C", TZ: "UTC0" },
        });
        const chunks: Buffer[] = [];
        const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);

        child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
        child.on("error", (error) => {
            clearTimeout(timer);
            reject(error);
        });
        child.on("close", (code) => {
            clearTimeout(timer);

            // `ps -p` exits 1 when a process it was asked about is gone: what it printed still holds.
            if (code === 0 || code === 1) {
                resolve(Buffer.concat(chunks).toString("utf8"));
            } else {
                reject(new Error(`${file} exited with code ${code}`));
            }
        });
    });
}

function byProcess(text: string): Map<string, string> {
    const lines = new Map<string, string>();

    for (const line of text.split("\n")) {
        const parts = /^\s*(\d+) (\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d+) (.*)$/.exec(line);
        const start = parts === null ? undefined : parseLstart(parts[2]!);

        if (parts !== null && start !== undefined) {
            lines.set(`${parts[1]}:${start}`, parts[3]!);
        }
    }

    return lines;
}

class DarwinTable implements ProcTable {
    readonly coarse = true;
    readonly boot = (() => {
        const read = spawnSync("sysctl", ["-n", "kern.bootsessionuuid"], {
            encoding: "utf8",
            timeout: 5000,
        });

        return read.status === 0 && read.stdout.trim() !== "" ? read.stdout.trim() : undefined;
    })();

    #scan: { at: number; all: Proc[]; byPid: Map<number, Proc> } | undefined;
    /** By `pid:start`: an environment cannot change once the process runs. */
    #env = new Map<string, string>();
    #epoch = 0;
    #wantScan = false;
    #wantEnv = new Set<number>();
    #failed: string | undefined;

    unsupported(): string | undefined {
        return this.#failed;
    }

    begin(): void {
        this.#epoch = performance.now();
        this.#wantScan = false;
        this.#wantEnv.clear();
    }

    #table(fresh: boolean): Map<number, Proc> {
        const scan = this.#scan;

        if (
            scan === undefined ||
            (fresh ? scan.at < this.#epoch : performance.now() - scan.at >= 250)
        ) {
            this.#wantScan = true;
        }

        return scan?.byPid ?? new Map();
    }

    stat(pid: number, fresh = false): Proc | undefined {
        const found = this.#table(fresh).get(pid);

        // Not in a table from before this look: it may have started since.
        if (found === undefined && (this.#scan?.at ?? 0) < this.#epoch) {
            this.#wantScan = true;
        }

        return found;
    }

    list(fresh: boolean): Proc[] {
        this.#table(fresh);

        return this.#scan?.all ?? [];
    }

    marked(pid: number, marker: string, guess?: boolean): boolean {
        const info = this.#scan?.byPid.get(pid);

        if (info === undefined) {
            return false;
        }

        const env = this.#env.get(`${pid}:${info.start}`);

        if (env === undefined) {
            if (guess !== undefined) {
                return guess;
            }

            this.#wantEnv.add(pid);

            return false;
        }

        const entry = ` ${BACKGROUND_MARKER}=${marker}`;
        let at = env.indexOf(entry);

        while (at >= 0) {
            const end = at + entry.length;

            if (end === env.length || env[end] === " ") {
                return true;
            }

            at = env.indexOf(entry, at + 1);
        }

        return false;
    }

    async fill(): Promise<boolean> {
        let filled = false;

        if (this.#wantScan) {
            await this.#rescan();
            filled = true;
        }

        if (this.#wantEnv.size > 0) {
            await this.#readEnv([...this.#wantEnv]);
            filled = true;
        }

        this.#wantScan = false;
        this.#wantEnv.clear();

        return filled;
    }

    async #rescan(): Promise<void> {
        const at = performance.now();
        let text: string;

        try {
            text = await run("/bin/ps", ["-A", "-o", "pid=,pgid=,stat=,lstart="]);
            this.#failed = undefined;
        } catch (error) {
            this.#failed = `Background tasks could not read the process table with ps: ${(error as Error).message}`;

            throw error;
        }

        const all: Proc[] = [];
        const table = new Map<number, Proc>();

        for (const line of text.split("\n")) {
            const parts = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line);
            const start = parts === null ? undefined : parseLstart(parts[4]!);

            if (parts !== null && start !== undefined) {
                const info = {
                    pid: Number(parts[1]),
                    pgid: Number(parts[2]),
                    state: parts[3]![0] ?? "",
                    start,
                };

                if (!gone(info)) {
                    all.push(info);
                    table.set(info.pid, info);
                }
            }
        }

        this.#scan = { at, all, byPid: table };

        for (const key of this.#env.keys()) {
            const [pid, start] = key.split(":").map(Number);

            if (table.get(pid!)?.start !== start) {
                this.#env.delete(key);
            }
        }
    }

    /**
     * `ps -E` adds the environment to the command; the command alone, from a second `ps`, is cut off, so an argument
     * that names the marker is no marker. A process of another user shows no environment.
     */
    async #readEnv(pids: number[]): Promise<void> {
        const list = pids.join(",");
        const [withEnv, plain] = await Promise.all([
            run("/bin/ps", ["-E", "-ww", "-o", "pid=,lstart=,command=", "-p", list]),
            run("/bin/ps", ["-ww", "-o", "pid=,lstart=,command=", "-p", list]),
        ]);
        const envs = byProcess(withEnv);
        const commands = byProcess(plain);

        // Kept by the start each line says, so an environment is never taken for that of a process that had the pid.
        for (const pid of pids) {
            const info = this.#scan?.byPid.get(pid);

            if (info === undefined) {
                continue;
            }

            const key = `${pid}:${info.start}`;
            const full = envs.get(key);
            const command = commands.get(key);

            // A process that ran `exec` between the two reads shows two commands: it is read again at the next look.
            if (full !== undefined && command !== undefined && full.startsWith(command)) {
                this.#env.set(key, full.slice(command.length));
            } else if (full === undefined && command === undefined) {
                this.#env.set(key, "");
            }
        }
    }

    known(): boolean {
        return this.#scan !== undefined;
    }

    forget(): void {
        this.#scan = undefined;
        this.#env.clear();
    }
}

/** Once the leader is gone, a member counts only while one carries the marker: a group id can be reused. */
function groupMembers(
    table: ProcTable,
    item: TaskRef,
    fresh: boolean,
    guess?: boolean,
): number[] | undefined {
    if (item.pid <= 0 || (item.boot !== undefined && item.boot !== table.boot)) {
        return [];
    }

    if (!kill(-item.pid, 0)) {
        return [];
    }

    const first = table.stat(item.pid, fresh);

    const own = (leader: Proc) =>
        leader.start === item.startTicks &&
        (!table.coarse || table.marked(leader.pid, item.marker, guess));

    if (
        first !== undefined &&
        !gone(first) &&
        first.pgid === item.pid &&
        item.startTicks !== undefined &&
        own(first)
    ) {
        return [item.pid];
    }

    let group = table.list(fresh).filter((each) => each.pgid === item.pid);

    // A scan from before the task started does not know it yet.
    if (group.length === 0 && !fresh) {
        group = table.list(true).filter((each) => each.pgid === item.pid);
    }

    const leader = group.find((each) => each.pid === item.pid);

    if (leader !== undefined && item.startTicks !== undefined && leader.start !== item.startTicks) {
        // A marked process in a reused group can be stopped individually, but never signal this group.
        return group.some((each) => table.marked(each.pid, item.marker, guess)) ? undefined : [];
    }

    if (
        (leader !== undefined && own(leader)) ||
        group.some((each) => table.marked(each.pid, item.marker, guess))
    ) {
        return group.map((each) => each.pid);
    }

    // An unmarked child can outlive the leader. The numeric group alone proves neither ownership nor absence.
    return group.length > 0 || item.startTicks === undefined ? undefined : [];
}

function markedProcesses(table: ProcTable, marker: string): Proc[] {
    return table.list(true).filter((each) => table.marked(each.pid, marker));
}

class PosixProcesses implements TaskProcesses {
    readonly #table: ProcTable;

    constructor(table: ProcTable) {
        this.#table = table;
    }

    get boot(): string | undefined {
        return this.#table.boot;
    }

    /** Looks take turns: each one's view is the shared table. */
    #turn: Promise<unknown> = Promise.resolve();

    #look<T>(read: () => T, forSignal = false): Promise<T> {
        const look = this.#turn.then(async () => {
            // Two macOS processes can have the same PID and start second. Never signal from a cached environment.
            if (forSignal && this.#table.coarse) {
                this.#table.forget();
            }

            this.#table.begin();

            for (let round = 0; round < 4; round++) {
                const result = read();

                if (!(await this.#table.fill())) {
                    return result;
                }
            }

            return read();
        });

        this.#turn = look.catch(() => undefined);

        return look;
    }

    async unsupported(): Promise<string | undefined> {
        if (this.#table.unsupported() === undefined && !this.#table.known()) {
            await this.#look(() => this.#table.list(true)).catch(() => undefined);
        }

        return this.#table.unsupported();
    }

    shell(): string | undefined {
        return "bash";
    }

    async spawn(
        script: string,
        cwd: string,
        env: NodeJS.ProcessEnv,
        task: TaskRef,
    ): Promise<{ pid: number; start?: number }> {
        const child = spawnDetached("bash", script, cwd, env);
        const pid = child.pid!;
        // Linux can read this child before Node can reap it. An asynchronous ps must also identify the launcher.
        const start = this.#table.coarse
            ? await this.#look(() => {
                  const info = this.#table.stat(pid, true);

                  return info?.pgid === pid && this.#table.marked(pid, task.marker)
                      ? info.start
                      : undefined;
              }).catch(() => undefined)
            : this.#table.stat(pid)?.start;

        return start === undefined || child.exitCode !== null || child.signalCode !== null
            ? { pid }
            : { pid, start };
    }

    members(task: TaskRef, fresh = false): Promise<number[] | undefined> {
        return this.#look(() => groupMembers(this.#table, task, fresh));
    }

    aliveSync(task: TaskRef): boolean {
        if (!this.#table.known()) {
            return task.pid > 0 && kill(-task.pid, 0);
        }

        // At once, from the table as it is, outside the looks' turns: an environment not read yet counts as the task's.
        return (groupMembers(this.#table, task, true, true)?.length ?? 0) > 0;
    }

    async left(task: TaskRef): Promise<number[]> {
        return (await this.#look(() => markedProcesses(this.#table, task.marker)))
            .filter((each) => each.pgid !== task.pid)
            .map((each) => each.pid);
    }

    stillLeft(task: TaskRef, pids: readonly number[]): Promise<number[]> {
        return this.#look(() => {
            // macOS reads an environment by the process's start: a table first, then those.
            this.#table.list(false);

            return pids.filter((pid) => this.#table.marked(pid, task.marker));
        });
    }

    async signal(task: TaskRef, name: Signal, authorize?: () => void): Promise<void> {
        if ((await this.#look(() => groupMembers(this.#table, task, true), true))?.length) {
            authorize?.();
            kill(-task.pid, name);
        }

        const marked = await this.#look(() => markedProcesses(this.#table, task.marker), true);

        for (const each of marked) {
            authorize?.();
            kill(each.pid === each.pgid && each.pid !== task.pid ? -each.pid : each.pid, name);
        }

        this.#table.forget();
    }

    async killSpawned(task: TaskRef): Promise<void> {
        await this.signal(task, "SIGKILL");
    }

    async find(task: TaskRef): Promise<{ pid: number; start?: number } | null> {
        return this.#look(() => {
            const found = markedProcesses(this.#table, task.marker);

            if (found.length === 0) {
                return null;
            }

            const leader =
                found.find((each) => each.pid === each.pgid) ?? this.#table.stat(found[0]!.pgid);

            // A leader that carries the marker is known for sure; a group whose leader is gone counts by its members.
            return {
                pid: leader?.pid ?? found[0]!.pgid,
                ...(leader !== undefined && this.#table.marked(leader.pid, task.marker)
                    ? { start: leader.start }
                    : {}),
            };
        });
    }

    close(): void {}
}

/**
 * A job has no limits: one that allows a breakaway lets Git Bash's runtime leave it, and one that ends its processes
 * when its handle closes would end the tasks at a restart of the server.
 */
const HELPER_CS = String.raw`
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class PiPocketProcesses {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct Entry {
        public uint dwSize; public uint cntUsage; public uint th32ProcessID; public IntPtr th32DefaultHeapID;
        public uint th32ModuleID; public uint cntThreads; public uint th32ParentProcessID; public int pcPriClassBase;
        public uint dwFlags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
    }

    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snapshot, ref Entry entry);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr snapshot, ref Entry entry);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint ms);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr OpenJobObjectW(uint access, bool inherit, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess, out IntPtr target, uint access, bool inherit, uint options);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, IntPtr info, int length, out int returned);

    const uint QUERY = 0x1000, SYNCHRONIZE = 0x100000, TERMINATE = 0x1, SET_QUOTA = 0x100, DUP_HANDLE = 0x40;
    static readonly Dictionary<string, IntPtr> jobs = new Dictionary<string, IntPtr>();
    sealed class Monitor { public IntPtr file, lease; public int failures; }
    static readonly Dictionary<string, Monitor> monitors = new Dictionary<string, Monitor>();

    [StructLayout(LayoutKind.Sequential)]
    struct Accounting {
        public long user, kernel, periodUser, periodKernel;
        public uint faults, total, active, terminated;
    }
    [DllImport("kernel32.dll", SetLastError = true, EntryPoint = "QueryInformationJobObject")]
    static extern bool QueryAccounting(IntPtr job, int kind, out Accounting info, int length, out int returned);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr CreateFileW(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool WriteFile(IntPtr file, byte[] data, int size, out int written, IntPtr overlapped);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr CreateMutexW(IntPtr attributes, bool owner, string name);

    // Keep one monitor across restarts. Only the existence of the mutex matters, not thread ownership.
    // Hold the file handle until publication: never look up the receipt path after the server disconnects.
    static string Watch(string key, string encodedPath, bool create) {
        if (!jobs.ContainsKey(key)) { return "no"; }
        if (monitors.ContainsKey(key)) { return "ok"; }
        string path = Encoding.UTF8.GetString(Convert.FromBase64String(encodedPath));
        IntPtr lease = CreateMutexW(IntPtr.Zero, false, "Local\\pi-pocket-watch-" + key);
        int error = Marshal.GetLastWin32Error();
        if (lease == IntPtr.Zero) { return "error monitor " + error; }
        if (error == 183) { CloseHandle(lease); return "held"; } // ERROR_ALREADY_EXISTS
        // FILE_APPEND_DATA; share read, write and delete; OPEN_ALWAYS or OPEN_EXISTING; FILE_FLAG_WRITE_THROUGH.
        IntPtr file = CreateFileW(path, 4, 7, IntPtr.Zero, create ? 4u : 3u, 0x80000000, IntPtr.Zero);
        if (file == new IntPtr(-1)) {
            error = Marshal.GetLastWin32Error();
            CloseHandle(lease);
            return "error receipt " + error;
        }
        monitors.Add(key, new Monitor { file = file, lease = lease });
        return "ok";
    }

    static void Drop(string key) {
        IntPtr handle;
        if (jobs.TryGetValue(key, out handle)) { CloseHandle(handle); jobs.Remove(key); }
        Monitor monitor;
        if (monitors.TryGetValue(key, out monitor)) {
            CloseHandle(monitor.file); CloseHandle(monitor.lease); monitors.Remove(key);
        }
    }

    // EOF includes a server crash. Once the covered job reaches zero, none of its processes can start another.
    // Only a successful kernel query of zero permits a receipt. The leading newline separates it from a torn pid record.
    public static void Drain() {
        foreach (string key in new List<string>(jobs.Keys)) {
            if (!monitors.ContainsKey(key)) { Drop(key); }
        }
        while (monitors.Count > 0) {
            foreach (string key in new List<string>(monitors.Keys)) {
                Monitor monitor = monitors[key];
                Accounting info;
                int returned, size = Marshal.SizeOf(typeof(Accounting));
                if (QueryAccounting(jobs[key], 1, out info, size, out returned) && returned == size) {
                    if (info.active > 0) { monitor.failures = 0; continue; }
                    byte[] data = Encoding.ASCII.GetBytes("\nempty " + key + "\n");
                    int written;
                    if (WriteFile(monitor.file, data, data.Length, out written, IntPtr.Zero) && written == data.Length) {
                        Drop(key); continue;
                    }
                }
                if (++monitor.failures >= 5) { Drop(key); } // No receipt: recovery must stay uncertain.
            }
            if (monitors.Count > 0) { System.Threading.Thread.Sleep(1000); }
        }
    }

    // The start of a live process in ms since 1601; -1 when it is gone, 0 when it is not ours to read.
    static long Start(IntPtr process) {
        if (WaitForSingleObject(process, 0) == 0) { return -1; }
        long creation, exit, kernel, user;
        return GetProcessTimes(process, out creation, out exit, out kernel, out user) ? creation / 10000 : 0;
    }

    // Each process's pid and parent from one snapshot. A handle opened on each pid of a first snapshot holds that
    // pid, so the second snapshot's parent of it is its own, not one of a process that ended and gave up the pid.
    static Dictionary<uint, uint> Parents(out string error) {
        error = null;
        Dictionary<uint, uint> parents = new Dictionary<uint, uint>();
        IntPtr snapshot = CreateToolhelp32Snapshot(2, 0);
        if (snapshot == new IntPtr(-1)) { error = "error snapshot " + Marshal.GetLastWin32Error(); return parents; }
        try {
            Entry entry = new Entry();
            entry.dwSize = (uint)Marshal.SizeOf(typeof(Entry));
            for (bool more = Process32FirstW(snapshot, ref entry); more; more = Process32NextW(snapshot, ref entry)) {
                if (entry.th32ProcessID != 0) { parents[entry.th32ProcessID] = entry.th32ParentProcessID; }
            }
            int last = Marshal.GetLastWin32Error();
            if (last != 18) { error = "error snapshot enumeration " + last; } // ERROR_NO_MORE_FILES is the normal end.
        } finally { CloseHandle(snapshot); }
        return parents;
    }

    static string List() {
        string error;
        Dictionary<uint, uint> first = Parents(out error);
        if (error != null) { return error; }
        Dictionary<uint, IntPtr> held = new Dictionary<uint, IntPtr>();
        try {
            foreach (uint pid in first.Keys) {
                IntPtr process = OpenProcess(QUERY | SYNCHRONIZE, false, pid);
                if (process != IntPtr.Zero) { held[pid] = process; }
            }
            Dictionary<uint, uint> second = Parents(out error);
            if (error != null) { return error; }
            StringBuilder text = new StringBuilder("list");
            foreach (KeyValuePair<uint, uint> each in second) {
                // A process new to this snapshot has no held handle: report its start as unknown.
                long start = 0;
                IntPtr process;
                if (held.TryGetValue(each.Key, out process)) { start = Start(process); }
                if (start < 0) { continue; }
                text.Append(' ').Append(each.Key).Append(',').Append(each.Value).Append(',').Append(start);
            }
            return text.ToString();
        } finally {
            foreach (IntPtr process in held.Values) { CloseHandle(process); }
        }
    }

    // Opens a process only when it still has the start it is known by: the handle holds its pid while it is open.
    static IntPtr Open(uint pid, long start, uint access) {
        IntPtr process = OpenProcess(access | QUERY | SYNCHRONIZE, false, pid);
        if (process == IntPtr.Zero) { return IntPtr.Zero; }
        if (Start(process) != start || start <= 0) { CloseHandle(process); return IntPtr.Zero; }
        return process;
    }

    static string Kill(uint pid, long start) {
        IntPtr process = Open(pid, start, TERMINATE);
        if (process == IntPtr.Zero) { return "no"; }
        try { return TerminateProcess(process, 1) ? "ok" : "no"; } finally { CloseHandle(process); }
    }

    // A job by its name, which stays while a handle to it is open: this helper's, or the one its task's first process
    // holds, so a helper after a restart of the server finds it again.
    static IntPtr Find(string key) {
        IntPtr job;
        if (jobs.TryGetValue(key, out job)) { return job; }
        job = OpenJobObjectW(0x1F001F, false, "Local\\pi-pocket-" + key);
        if (job != IntPtr.Zero) { jobs[key] = job; }
        else {
            int error = Marshal.GetLastWin32Error();
            if (error != 2) { throw new System.ComponentModel.Win32Exception(error); }
        }
        return job;
    }

    static string Job(string key, uint pid, long start, bool hold) {
        IntPtr job;
        if (!jobs.TryGetValue(key, out job)) {
            job = CreateJobObjectW(IntPtr.Zero, "Local\\pi-pocket-" + key);
            if (job == IntPtr.Zero) { return "error job " + Marshal.GetLastWin32Error(); }
            jobs[key] = job;
        }
        IntPtr process = Open(pid, start, SET_QUOTA | TERMINATE | DUP_HANDLE);
        if (process == IntPtr.Zero) { return "no"; }
        try {
            if (!AssignProcessToJobObject(job, process)) { return "error assign " + Marshal.GetLastWin32Error(); }
            IntPtr copy;
            if (hold && !DuplicateHandle(GetCurrentProcess(), job, process, out copy, 0, false, 2)) {
                return "error hold " + Marshal.GetLastWin32Error();
            }
            return "ok";
        } finally { CloseHandle(process); }
    }

    static string Members(string key) {
        IntPtr job = Find(key);
        if (job == IntPtr.Zero) { return "none"; }
        for (int size = 1024; ; size *= 4) {
            int bytes = 8 + size * IntPtr.Size, returned;
            IntPtr buffer = Marshal.AllocHGlobal(bytes);
            try {
                bool ok = QueryInformationJobObject(job, 3, buffer, bytes, out returned);
                int assigned = Marshal.ReadInt32(buffer), listed = Marshal.ReadInt32(buffer, 4);
                if (!ok && Marshal.GetLastWin32Error() != 234) { return "error members " + Marshal.GetLastWin32Error(); }
                if (listed < assigned || !ok) {
                    if (size < 1 << 20) { continue; }
                    return "error incomplete job membership";
                }
                // Each with its start, read through a handle that is still in the job: a pid that a process outside it
                // took since the job's list is left out.
                StringBuilder text = new StringBuilder("members");
                for (int at = 0; at < listed; at++) {
                    uint pid = (uint)Marshal.ReadIntPtr(buffer, 8 + at * IntPtr.Size).ToInt64();
                    IntPtr process = OpenProcess(QUERY | SYNCHRONIZE, false, pid);
                    if (process == IntPtr.Zero) { text.Append(' ').Append(pid).Append(",0"); continue; }
                    try {
                        bool inJob;
                        long start = Start(process);
                        if (!IsProcessInJob(process, job, out inJob)) { text.Append(' ').Append(pid).Append(",0"); }
                        else { text.Append(' ').Append(pid).Append(',').Append(inJob && start > 0 ? start : 0); }
                    } finally { CloseHandle(process); }
                }
                return text.ToString();
            } finally { Marshal.FreeHGlobal(buffer); }
        }
    }

    public static string Run(string line) {
        string[] words = line.Split(' ');
        IntPtr job;
        switch (words[0]) {
            case "list": return List();
            case "kill": return Kill(uint.Parse(words[1]), long.Parse(words[2]));
            case "job": return Job(words[1], uint.Parse(words[2]), long.Parse(words[3]), words.Length > 4);
            case "watch": return Watch(words[1], words[2], true);
            case "members":
                string members = Members(words[1]);
                if (words.Length == 3 && (members == "members" || members.StartsWith("members "))) {
                    Watch(words[1], words[2], false);
                }
                return members;
            case "killjob":
                job = Find(words[1]);
                return job != IntPtr.Zero && TerminateJobObject(job, 1) ? "ok" : "no";
            case "drop":
                Drop(words[1]);
                return "ok";
            default: return "error unknown " + words[0];
        }
    }
}
`;

/** The helper's script. Its C# comes in an environment variable: a command line holds at most 32,767 characters. */
const HELPER_PS = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { Add-Type -TypeDefinition $env:PI_POCKET_PROCESSES_CS } catch {
    [Console]::Out.WriteLine('fatal ' + ($_.Exception.Message -replace '\\s+', ' '))
    exit 1
}
[Console]::Out.WriteLine('ready')
[Console]::Out.Flush()
try {
    while ($null -ne ($line = [Console]::In.ReadLine())) {
        try { $answer = [PiPocketProcesses]::Run($line) } catch { $answer = 'error ' + ($_.Exception.Message -replace '\\s+', ' ') }
        [Console]::Out.WriteLine($answer)
        [Console]::Out.Flush()
    }
} finally { [PiPocketProcesses]::Drain() }
`;

type Waiting = { resolve: (line: string) => void; reject: (error: Error) => void };
type HelperRun = { child: ChildProcess; ready: Promise<void>; waiting: Waiting[] };

class Helper {
    #current: HelperRun | undefined;
    #idle: ReturnType<typeof setTimeout> | undefined;
    /** Whether it holds jobs: then it stays, or their tasks could no longer be ended by their jobs. */
    holds: () => boolean = () => false;
    failed: string | undefined;
    /** Asks in a row with no answer in time: a helper that hangs is started again (its jobs have names). */
    #late = 0;

    #start(): HelperRun {
        const powershell = win32.join(
            process.env.SystemRoot ?? "C:\\Windows",
            "System32",
            "WindowsPowerShell",
            "v1.0",
            "powershell.exe",
        );
        const child = spawn(
            powershell,
            [
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-EncodedCommand",
                Buffer.from(HELPER_PS, "utf16le").toString("base64"),
            ],
            {
                stdio: ["pipe", "pipe", "pipe"],
                windowsHide: true,
                detached: true,
                env: { ...process.env, PI_POCKET_PROCESSES_CS: HELPER_CS },
            },
        );
        const waiting: Waiting[] = [];
        let errors = "";
        let buffer = "";

        child.stdout!.setEncoding("utf8");
        child.stderr!.setEncoding("utf8");
        child.stderr!.on("data", (text: string) => (errors = (errors + text).slice(-2000)));
        child.stdin!.on("error", () => {});
        child.unref();

        for (const stream of [child.stdin, child.stdout, child.stderr]) {
            (stream as unknown as { unref?: () => void }).unref?.();
        }

        const ready = new Promise<void>((resolve, reject) => {
            const fail = (error: Error) => {
                if (this.#current?.child === child) {
                    this.#current = undefined;
                }

                for (const each of waiting.splice(0)) {
                    each.reject(error);
                }

                reject(error);
            };

            child.on("error", (error) => fail(error));
            child.on("exit", (code) =>
                fail(
                    new Error(
                        `The process helper (PowerShell) exited with code ${code}: ${errors.trim()}`,
                    ),
                ),
            );
            child.stdout!.on("data", (text: string) => {
                buffer += text;

                for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
                    const line = buffer.slice(0, end).trim();

                    buffer = buffer.slice(end + 1);

                    if (line === "ready") {
                        resolve();
                    } else if (line.startsWith("fatal ")) {
                        fail(new Error(`The process helper could not load: ${line.slice(6)}`));
                    } else {
                        waiting.shift()?.resolve(line);
                    }
                }
            });
        });

        ready.catch(() => undefined);

        return { child, ready, waiting };
    }

    async ask(line: string, authorize?: () => void): Promise<string> {
        clearTimeout(this.#idle);

        const current = (this.#current ??= this.#start());

        try {
            await withTimeout(
                current.ready,
                60_000,
                "The process helper (PowerShell) did not start",
            );
            this.failed = undefined;
        } catch (error) {
            this.failed = `Background tasks on Windows need Windows PowerShell with Add-Type, to follow and stop their processes: ${(error as Error).message}`;
            this.close(true);

            throw error;
        }

        try {
            authorize?.();
            const answer = new Promise<string>((resolve, reject) =>
                current.waiting.push({ resolve, reject }),
            );

            current.child.stdin!.write(`${line}\n`);
            const text = await withTimeout(answer, 30_000, "The process helper did not answer");

            this.#late = 0;

            if (text.startsWith("error ")) {
                throw new Error(text.slice(6));
            }

            return text;
        } catch (error) {
            // A late answer still goes to its own ask, which stays in the queue: the answers after it keep their order.
            // A helper that hangs is closed after a second one; a new one opens the jobs again by their names.
            if (
                (error as Error).message === "The process helper did not answer" &&
                ++this.#late >= 2
            ) {
                this.#late = 0;
                this.close(true);
            }

            throw error;
        } finally {
            clearTimeout(this.#idle);
            this.#idle = setTimeout(() => {
                if (!this.holds() && this.#current?.waiting.length === 0) {
                    this.close();
                }
            }, 60_000);
            this.#idle.unref?.();
        }
    }

    close(stuck = false): void {
        clearTimeout(this.#idle);

        const current = this.#current;

        this.#current = undefined;
        current?.child.stdin?.end();

        if (stuck) {
            current?.child.kill();
        }
    }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;

    return Promise.race([
        promise,
        new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(message)), ms);
        }),
    ]).finally(() => clearTimeout(timer));
}

type WinProc = { pid: number; ppid: number; start: number };

/** Git Bash: Git for Windows' launcher first, as Pi's own bash tool looks for it, then a `bash.exe` on PATH. */
function findGitBash(): string | undefined {
    const candidates = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]
        .filter((folder) => folder !== undefined)
        .map((folder) => win32.join(folder!, "Git", "bin", "bash.exe"));

    for (const candidate of candidates) {
        if (existsSync(candidate)) {
            return candidate;
        }
    }

    const where = spawnSync("where", ["bash.exe"], { encoding: "utf8", timeout: 5000 });
    const system = (process.env.SystemRoot ?? "C:\\Windows").toLowerCase();

    // WSL's launcher in System32 runs Linux, which cannot run this wrapper for a Windows folder.
    return where.stdout
        ?.split(/\r?\n/)
        .map((line) => line.trim())
        .find(
            (line) =>
                line !== "" &&
                !line.toLowerCase().startsWith(win32.join(system, "system32")) &&
                !line.toLowerCase().startsWith(win32.join(system, "sysnative")),
        );
}

/**
 * The Windows wrapper writes the Windows pid of its bash (the one under Git's launcher) to a file before the command
 * runs, for a start a crash cut off, and waits for a line on its input: the job holds it before it starts anything.
 */
const WINDOWS_GATE =
    'pidf=$PI_POCKET_BACKGROUND_PIDFILE; unset PI_POCKET_BACKGROUND_PIDFILE; read -r winpid < /proc/$$/winpid; printf "%s\\n" "$winpid" > "$pidf"; IFS= read -r _gate; [ "$_gate" = go ] || exit 1; exec 0< /dev/null; ';

type WindowsHelper = Pick<Helper, "ask" | "close" | "failed" | "holds">;

export class WindowsProcesses implements TaskProcesses {
    readonly boot = undefined;
    readonly #helper: WindowsHelper;
    #shell: string | undefined | null = null;
    #scan: { at: number; all: Map<number, WinProc> } | undefined;
    /** Pid to start, also in `<files>.pids`. */
    #known = new Map<string, Map<number, number>>();
    #jobs = new Set<string>();
    /** Only a job that held the gated command before release can prove it left no survivors. */
    #coverage = new Map<string, "job" | "empty">();
    /** What this server spawned: a handle Node keeps while the process runs, so its pid cannot be another's. */
    #children = new Map<string, ChildProcess>();

    constructor(helper: WindowsHelper = new Helper()) {
        this.#helper = helper;
        this.#helper.holds = () => this.#jobs.size > 0;
    }

    async unsupported(): Promise<string | undefined> {
        if (this.shell() === undefined) {
            return "Background tasks on Windows need Git for Windows (Git Bash), or another bash.exe on PATH.";
        }

        try {
            await this.#list(true);

            return undefined;
        } catch {
            return this.#helper.failed ?? "Background tasks could not read the process table.";
        }
    }

    shell(): string | undefined {
        if (this.#shell === null) {
            this.#shell = findGitBash();
        }

        return this.#shell;
    }

    #key(task: TaskRef): string {
        return createHash("sha256").update(task.marker).digest("hex").slice(0, 32);
    }

    async #list(fresh: boolean): Promise<Map<number, WinProc>> {
        if (!fresh && this.#scan !== undefined && Date.now() - this.#scan.at < 250) {
            return this.#scan.all;
        }

        const at = Date.now();
        const answer = await this.#helper.ask("list");

        if (!/^list(?: \d+,\d+,\d+)*$/.test(answer)) {
            throw new Error("Invalid process table from the process helper.");
        }

        const all = new Map<number, WinProc>();

        for (const word of answer.split(" ").slice(1)) {
            const [pid, ppid, start] = word.split(",").map(Number);

            all.set(pid!, { pid: pid!, ppid: ppid!, start: start! });
        }

        this.#scan = { at, all };

        return all;
    }

    #knownOf(task: TaskRef): Map<number, number> {
        let known = this.#known.get(task.marker);

        if (known === undefined) {
            known = new Map();

            try {
                const key = this.#key(task);

                for (const line of readFileSync(`${task.files}.pids`, "utf8")
                    .split("\n")
                    .slice(0, -1)) {
                    if (line === `job ${key}` || line === `empty ${key}`) {
                        this.#coverage.set(task.marker, line.startsWith("job ") ? "job" : "empty");
                        continue;
                    }

                    const [pid, start] = line.split(" ").map(Number);

                    if (pid! > 0 && start! > 0) {
                        known.set(pid!, start!);
                    }
                }
            } catch {}

            this.#known.set(task.marker, known);
        }

        // Also when a look before its start (a stop with no pid yet) made the map: the first process is always known.
        if (task.pid > 0 && task.startTicks !== undefined && task.startTicks > 0) {
            known.set(task.pid, task.startTicks);
        }

        return known;
    }

    /**
     * What it knew, what its job holds, and each process whose parent is one of them and that started after that
     * parent: a later process that took a parent's pid is not the parent.
     */
    #members(
        task: TaskRef,
        all: Map<number, WinProc>,
        job: { pid: number; start: number }[],
    ): number[] | undefined {
        const known = this.#knownOf(task);
        const found: string[] = [];
        let uncertain = all.has(task.pid) && !known.has(task.pid);

        const add = (pid: number, start: number) => {
            known.set(pid, start);
            found.push(`${pid} ${start}\n`);
        };

        // A pid the task had before, now another process's: that one is new, and may be the task's too.
        const knownNow = (pid: number, start: number) => known.get(pid) === start;

        for (const each of job) {
            if (each.start <= 0 || all.get(each.pid)?.start !== each.start) {
                uncertain = true;
            } else if (!knownNow(each.pid, each.start)) {
                add(each.pid, each.start);
            }
        }

        for (const info of [...all.values()].sort((a, b) => a.start - b.start)) {
            const parent = known.get(info.ppid);

            if (info.start === 0 && known.has(info.pid)) {
                uncertain = true;
            }

            if (parent !== undefined && all.get(info.ppid)?.start === parent) {
                if (info.start === 0) {
                    uncertain = true;
                } else if (!knownNow(info.pid, info.start) && info.start >= parent) {
                    add(info.pid, info.start);
                }
            }
        }

        if (found.length > 0) {
            try {
                appendFileSync(`${task.files}.pids`, found.join(""));
            } catch {
                // Its folder is gone: the task's files went with it.
            }
        }

        const members = [...known]
            .filter(([pid, start]) => all.get(pid)?.start === start)
            .map(([pid]) => pid);

        return uncertain && members.length === 0 ? undefined : members;
    }

    #receipt(task: TaskRef): string {
        return Buffer.from(`${task.files}.pids`).toString("base64");
    }

    async #job(
        task: TaskRef,
        covered: boolean,
    ): Promise<{ pid: number; start: number }[] | undefined> {
        const key = this.#key(task);
        const answer = await this.#helper.ask(
            `members ${key}${covered ? ` ${this.#receipt(task)}` : ""}`,
        );

        // A job that a helper before a restart made is found again by its name, while the task's first process runs.
        if (answer === "none") {
            return undefined;
        }

        if (!/^members(?: \d+,\d+)*$/.test(answer)) {
            throw new Error("Invalid job membership from the process helper.");
        }

        this.#jobs.add(key);

        return answer
            .split(" ")
            .slice(1)
            .map((word) => word.split(",").map(Number))
            .map(([pid, start]) => ({ pid: pid!, start: start! }));
    }

    async spawn(
        script: string,
        cwd: string,
        env: NodeJS.ProcessEnv,
        task: TaskRef,
        authorize?: () => void,
    ): Promise<{ pid: number; start: number }> {
        const shell = this.shell();

        if (shell === undefined) {
            throw new Error("No Git Bash on this machine.");
        }

        // Do not run environment startup hooks before job assignment. The command gets its own bash after the gate.
        const child = spawn(shell, ["-p", "-c", WINDOWS_GATE + script], {
            cwd,
            detached: true,
            windowsHide: true,
            stdio: ["pipe", "ignore", "ignore"],
            env: { ...env, PI_POCKET_BACKGROUND_PIDFILE: `${task.files}.pid` },
        });

        child.on("error", () => {});
        child.stdin!.on("error", () => {});

        if (child.pid === undefined) {
            throw new Error("The command could not start: no bash on this machine?");
        }

        const pid = child.pid;

        this.#children.set(task.marker, child);
        child.once("exit", () => this.#children.delete(task.marker));
        child.unref();
        (child.stdin as unknown as { unref?: () => void }).unref?.();

        let start: number | undefined;

        try {
            // Its bash runs under Git's launcher: once the bash wrote its pid, both wait at the gate, started before the
            // job was there, so each goes into it before the command starts. While it waits, Node's handle on the
            // launcher holds its pid: the start read now is its own.
            let gatedPid: number | undefined;

            for (let tries = 0; tries < 400; tries++) {
                const pidFile = `${task.files}.pid`;

                if (existsSync(pidFile)) {
                    const line = readFileSync(pidFile, "utf8");

                    if (/^[1-9]\d*\r?\n$/.test(line)) {
                        gatedPid = Number(line);
                        break;
                    }
                }

                if (child.exitCode !== null) {
                    break;
                }

                await new Promise((resolve) => setTimeout(resolve, 25));
            }

            const all = await this.#list(true);

            start = all.get(pid)?.start;

            if (start === undefined || start <= 0) {
                throw new Error("The command's start time could not be read.");
            }

            const key = this.#key(task);
            const ref = { ...task, pid, startTicks: start };
            const known = this.#knownOf(ref);
            const members = this.#members(ref, all, []) ?? [];
            let covered = gatedPid !== undefined && members.includes(gatedPid);

            // A failed assignment can still create a job handle. Drop it on rollback too.
            this.#jobs.add(key);

            for (const each of members) {
                // The first process holds a handle to its job too, so its name stays across a restart of the server.
                const answer = await this.#helper
                    .ask(`job ${key} ${each} ${known.get(each)}${each === pid ? " hold" : ""}`)
                    .catch(() => "no");

                if (answer !== "ok") {
                    covered = false;
                }
            }

            if (!covered) {
                throw new Error(
                    "The process helper could not cover the gated command with its Windows job.",
                );
            }

            if ((await this.#helper.ask(`watch ${key} ${this.#receipt(task)}`)) !== "ok") {
                throw new Error(
                    "The process helper could not monitor the Windows job through a server restart.",
                );
            }

            this.#recordCoverage(task, "job");

            authorize?.();
            child.stdin!.end("go\n");
        } catch (error) {
            // No word at the gate: the wrapper exits without running the command.
            child.stdin!.end();
            child.kill();
            this.#done(task);

            throw error;
        }

        return { pid, start };
    }

    #recordCoverage(task: TaskRef, state: "job" | "empty"): void {
        appendFileSync(`${task.files}.pids`, `\n${state} ${this.#key(task)}\n`, { flush: true });
        this.#coverage.set(task.marker, state);
    }

    async members(task: TaskRef, fresh = false): Promise<number[] | undefined> {
        // A query sent before assignment cannot prove absence, even if assignment finishes during the query.
        this.#knownOf(task);

        const coverage = this.#coverage.get(task.marker);
        let all: Map<number, WinProc>;
        let job: { pid: number; start: number }[] | undefined;

        try {
            [job, all] = await Promise.all([
                this.#job(task, coverage === "job"),
                this.#list(fresh),
            ]);
        } catch {
            // The helper could not check identity. A PID probe proves neither membership nor absence.
            return undefined;
        }

        const members = this.#members(task, all, job ?? []);

        if (members !== undefined && members.length > 0) {
            return members;
        }

        if (job !== undefined && job.length > 0) {
            return undefined;
        }

        let empty = coverage === "empty";

        if (!empty && job === undefined) {
            // The previous helper can publish after this server loaded the pid file.
            try {
                empty = readFileSync(`${task.files}.pids`, "utf8")
                    .split("\n")
                    .slice(0, -1)
                    .includes(`empty ${this.#key(task)}`);
            } catch {}
        }

        if (!empty && (coverage !== "job" || job?.length !== 0)) {
            // A vanished parent or job name cannot exclude an unobserved descendant.
            return undefined;
        }

        if (fresh) {
            if (!empty) {
                try {
                    this.#recordCoverage(task, "empty");
                } catch {
                    // Keep the job handle if later looks cannot recover the proof from disk.
                    return [];
                }
            }

            this.#done(task);
        }

        return [];
    }

    #done(task: TaskRef): void {
        const key = this.#key(task);

        this.#known.delete(task.marker);
        this.#coverage.delete(task.marker);

        if (this.#jobs.delete(key)) {
            void this.#helper.ask(`drop ${key}`).catch(() => undefined);
        }
    }

    aliveSync(task: TaskRef): boolean {
        if (task.pid <= 0) {
            return false;
        }

        if (this.#scan === undefined || Date.now() - this.#scan.at > 5000) {
            return false;
        }

        return (this.#members(task, this.#scan.all, [])?.length ?? 0) > 0;
    }

    async left(): Promise<number[]> {
        return [];
    }

    async stillLeft(): Promise<number[]> {
        return [];
    }

    /** Both signals end the processes by force: Windows has no polite stop for a program without a window. */
    async signal(task: TaskRef, _name: Signal, authorize?: () => void): Promise<void> {
        await this.#helper.ask(`killjob ${this.#key(task)}`, authorize).catch(() => undefined);

        // Then each process found, parents first, checked against its start time by the helper as it ends it; a pass
        // again for what they started in the meantime.
        for (let pass = 0; pass < 3; pass++) {
            const all = await this.#list(true).catch(() => undefined);

            if (all === undefined) {
                return;
            }

            const known = this.#knownOf(task);
            const members = this.#members(task, all, []);

            if (members === undefined || members.length === 0) {
                return;
            }

            for (const pid of members.sort((a, b) => known.get(a)! - known.get(b)!)) {
                await this.#helper
                    .ask(`kill ${pid} ${known.get(pid)}`, authorize)
                    .catch(() => undefined);
            }
        }
    }

    async killSpawned(task: TaskRef, pid: number): Promise<void> {
        const child = this.#children.get(task.marker);

        if (child !== undefined && child.pid === pid) {
            child.kill();
        }

        await this.#helper.ask(`killjob ${this.#key(task)}`).catch(() => undefined);

        // Without a job, what the start found of it: each checked against its start as it ends.
        for (const [each, start] of this.#known.get(task.marker) ?? []) {
            await this.#helper.ask(`kill ${each} ${start}`).catch(() => undefined);
        }
    }

    /** A crash can leave the PID file behind. Its timestamp does not identify the current holder of that PID. */
    async find(task: TaskRef): Promise<{ pid: number; start?: number } | null | undefined> {
        const members = await this.members(task, true);

        if (members?.length === 0) {
            return null;
        }

        const pid = members?.[0];
        const start = pid === undefined ? undefined : this.#known.get(task.marker)?.get(pid);

        return pid !== undefined && start !== undefined ? { pid, start } : undefined;
    }

    close(): void {
        this.#helper.close();
    }
}

export function taskProcesses(platform: NodeJS.Platform = process.platform): TaskProcesses {
    switch (platform) {
        case "win32":
            return new WindowsProcesses();
        case "darwin":
            return new PosixProcesses(new DarwinTable());
        default:
            return new PosixProcesses(new LinuxTable());
    }
}
