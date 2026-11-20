/**
 * How background tasks (`background.ts`) find, follow, and stop their processes, on each platform. A stop must never
 * hit a process that is not the task's, so each process is known by its pid and its start time together: a pid that
 * another process took later has another start time.
 *
 * - Linux reads `/proc`: each process's group, state, and start time, and its environment for the task's marker.
 * - macOS reads the same from `ps`: the process table in one call, and the environment of the user's own processes
 *   only at the moments that need it (an end, a stop, a recovery), kept for each process, as it cannot change.
 * - Both run a task as the leader of its own process group, and stop it with signals to the group, and to each process
 *   with its marker that left the group (`setsid`, a daemon).
 * - Windows has no process groups or signals, and one process cannot read another's environment. A task's processes
 *   are its first process and its descendants, by parent pid and start time, and the members of a job object that
 *   holds them all while this server runs. A small PowerShell helper reads the table, keeps the jobs, and ends a
 *   process only through a handle it opened and checked the start time of, so no pid taken in between can be hit. The
 *   processes found are written to a file next to the task's log, so a restarted server knows them again. A stop ends
 *   them by force at once: Windows has no polite stop for a program without a window.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { win32 } from "node:path";

/** The environment variable that marks each process of a task: `<data folder>#<conversation>/<id>`. */
export const BACKGROUND_MARKER = "PI_POCKET_BACKGROUND";

/** What a task's processes are known by. */
export type TaskRef = {
    /** The first process, the group's leader on Linux and macOS; 0 while it is not known. */
    pid: number;
    /** When it started, in the platform's clock: with `pid`, what says it is still the same process. */
    startTicks?: number;
    boot?: string;
    /** The value of `BACKGROUND_MARKER` in its processes. */
    marker: string;
    /** Its files, without an extension: `<folder>/<id>`. */
    files: string;
    /** When its start was reserved (ms since 1970). */
    startedAt: number;
};

export type Signal = "SIGTERM" | "SIGKILL";

export interface TaskProcesses {
    /** This boot of the machine: a task from another boot has no process left. */
    readonly boot: string | undefined;
    /** Why tasks cannot run on this machine, or undefined when they can. */
    unsupported(): Promise<string | undefined>;
    /** The bash that runs the wrapper; undefined when there is none. */
    shell(): string | undefined;
    /** Start the wrapper detached, as its own group or job; its pid. */
    spawn(script: string, cwd: string, env: NodeJS.ProcessEnv, task: TaskRef): Promise<number>;
    /** The start time of a process, for a task's record. */
    startOf(pid: number): Promise<number | undefined>;
    /** The live processes of a task's group (Linux, macOS) or tree (Windows). */
    members(task: TaskRef, fresh?: boolean): Promise<number[]>;
    /** Whether a task has a live process, at once, from what is known now: for a count while the watches are off. */
    aliveSync(task: TaskRef): boolean;
    /** The processes with a task's marker that run outside its group: what it left behind. */
    left(task: TaskRef): Promise<number[]>;
    /** Of `pids` a task left, those that still run and are still its. */
    stillLeft(task: TaskRef, pids: readonly number[]): Promise<number[]>;
    /** Send a signal to every process of a task, found afresh. */
    signal(task: TaskRef, name: Signal): Promise<void>;
    /** End the process a start just spawned, before its record: a stop came first, or the record failed. */
    killSpawned(task: TaskRef, pid: number): Promise<void>;
    /** A start a crash cut off: the first process it finds of the task, with its start when that is sure. */
    find(task: TaskRef): Promise<{ pid: number; start?: number } | undefined>;
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

// ─── Linux and macOS ────────────────────────────────────────────────────────

type Proc = { pid: number; pgid: number; state: string; start: number };

const gone = (info: Proc) => info.state === "Z" || info.state === "X";

/**
 * A view of the process table that answers at once. A read the view cannot answer yet (macOS: a table older than the
 * look, or an environment not read yet) is noted, and `fill` fetches it; the look then runs again.
 */
interface ProcTable {
    readonly boot: string | undefined;
    unsupported(): string | undefined;
    /** A new look starts: what is fresh is from after this moment. */
    begin(): void;
    stat(pid: number): Proc | undefined;
    list(fresh: boolean): Proc[];
    marked(pid: number, marker: string): boolean;
    /** Fetch what the reads since `begin` missed; false when they missed nothing. */
    fill(): Promise<boolean>;
    /** Whether the view has a table at all, however old. */
    known(): boolean;
    forget(): void;
}

class LinuxTable implements ProcTable {
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

    /** A process's group, state, and start time, from `/proc/<pid>/stat`. */
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

    /** Every process's stat, read once for all the watches that look in the same moment. */
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

    /** Whether a process carries a marker in its environment; false for a process not ours to read. */
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
export function parseLstart(text: string): number | undefined {
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

/** The parts of `ps -o pid=,command=` output by pid. */
function byPid(text: string): Map<number, string> {
    const lines = new Map<number, string>();

    for (const line of text.split("\n")) {
        const parts = /^\s*(\d+) (.*)$/.exec(line);

        if (parts !== null) {
            lines.set(Number(parts[1]), parts[2]!);
        }
    }

    return lines;
}

class DarwinTable implements ProcTable {
    readonly boot = (() => {
        const read = spawnSync("sysctl", ["-n", "kern.bootsessionuuid"], {
            encoding: "utf8",
            timeout: 5000,
        });

        return read.status === 0 && read.stdout.trim() !== "" ? read.stdout.trim() : undefined;
    })();

    #scan: { at: number; all: Proc[]; byPid: Map<number, Proc> } | undefined;
    /** The environment of each process, by `pid:start`: it cannot change once the process runs. */
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

    stat(pid: number): Proc | undefined {
        const found = this.#table(false).get(pid);

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

    marked(pid: number, marker: string): boolean {
        const info = this.#scan?.byPid.get(pid);

        if (info === undefined) {
            return false;
        }

        const env = this.#env.get(`${pid}:${info.start}`);

        if (env === undefined) {
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

        // What was kept for processes that are gone goes.
        for (const key of this.#env.keys()) {
            const [pid, start] = key.split(":").map(Number);

            if (table.get(pid!)?.start !== start) {
                this.#env.delete(key);
            }
        }
    }

    /**
     * The environments of some processes. `ps -E` adds the environment to the command, joined by spaces, so the part
     * after the command alone (from a second `ps` without `-E`) is the environment: an argument that names the marker
     * is no marker. A process of another user shows no environment.
     */
    async #readEnv(pids: number[]): Promise<void> {
        const list = pids.join(",");
        const [withEnv, plain] = await Promise.all([
            run("/bin/ps", ["-E", "-ww", "-o", "pid=,command=", "-p", list]),
            run("/bin/ps", ["-ww", "-o", "pid=,command=", "-p", list]),
        ]);
        const envs = byPid(withEnv);
        const commands = byPid(plain);

        for (const pid of pids) {
            const info = this.#scan?.byPid.get(pid);

            if (info === undefined) {
                continue;
            }

            const full = envs.get(pid) ?? "";
            const command = commands.get(pid);
            const env =
                command !== undefined && full.startsWith(command) ? full.slice(command.length) : "";

            this.#env.set(`${pid}:${info.start}`, env);
        }
    }

    known(): boolean {
        return this.#scan !== undefined;
    }

    forget(): void {
        this.#scan = undefined;
    }
}

/**
 * The live processes of a task's group. While its leader runs (the same pid, started at the same time), the group is
 * the task's; once the leader is gone, a member counts only while one carries the task's marker, so a group id that a
 * new process took after the task's ended is not taken for it.
 */
function groupMembers(table: ProcTable, item: TaskRef, fresh: boolean): number[] {
    if (item.pid <= 0 || (item.boot !== undefined && item.boot !== table.boot)) {
        return [];
    }

    // Cheap first, as most looks go: no process in the group at all, or its leader still the same.
    if (!kill(-item.pid, 0)) {
        return [];
    }

    const first = table.stat(item.pid);

    if (
        first !== undefined &&
        !gone(first) &&
        first.pgid === item.pid &&
        item.startTicks !== undefined &&
        first.start === item.startTicks
    ) {
        return [item.pid];
    }

    // The leader is gone and the group is not: what is left of it, from a scan.
    let group = table.list(fresh).filter((each) => each.pgid === item.pid);

    // A scan from before the task started does not know it yet.
    if (group.length === 0 && !fresh) {
        group = table.list(true).filter((each) => each.pgid === item.pid);
    }

    const leader = group.find((each) => each.pid === item.pid);

    if (
        leader !== undefined &&
        (item.startTicks === undefined || leader.start === item.startTicks)
    ) {
        return group.map((each) => each.pid);
    }

    return group.some((each) => table.marked(each.pid, item.marker))
        ? group.map((each) => each.pid)
        : [];
}

/** Every live process that carries a task's marker, wherever it is: its group, or one that left it. */
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

    /** Run a look until the view had all it read. */
    async #look<T>(read: () => T): Promise<T> {
        this.#table.begin();

        for (let round = 0; round < 4; round++) {
            const result = read();

            if (!(await this.#table.fill())) {
                return result;
            }
        }

        return read();
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

    async spawn(script: string, cwd: string, env: NodeJS.ProcessEnv): Promise<number> {
        return spawnDetached("bash", script, cwd, env).pid!;
    }

    startOf(pid: number): Promise<number | undefined> {
        return this.#look(() => this.#table.stat(pid)?.start);
    }

    members(task: TaskRef, fresh = false): Promise<number[]> {
        return this.#look(() => groupMembers(this.#table, task, fresh));
    }

    aliveSync(task: TaskRef): boolean {
        if (!this.#table.known()) {
            return task.pid > 0 && kill(-task.pid, 0);
        }

        this.#table.begin();

        return groupMembers(this.#table, task, true).length > 0;
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

    async signal(task: TaskRef, name: Signal): Promise<void> {
        const { group, marked } = await this.#look(() => ({
            group: groupMembers(this.#table, task, true).length > 0,
            marked: markedProcesses(this.#table, task.marker),
        }));

        if (group) {
            kill(-task.pid, name);
        }

        for (const each of marked) {
            kill(each.pid === each.pgid ? -each.pid : each.pid, name);
        }

        this.#table.forget();
    }

    async killSpawned(_task: TaskRef, pid: number): Promise<void> {
        kill(-pid, "SIGKILL");
    }

    async find(task: TaskRef): Promise<{ pid: number; start?: number } | undefined> {
        return this.#look(() => {
            const found = markedProcesses(this.#table, task.marker);

            if (found.length === 0) {
                return undefined;
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

// ─── Windows ────────────────────────────────────────────────────────────────

/** Milliseconds from 1601, Windows' epoch of its process times, to 1970. */
const WINDOWS_EPOCH_MS = 11_644_473_600_000;

/**
 * The helper's code: the process table (pid, parent, start time in ms since 1601) from one Toolhelp snapshot, jobs that
 * hold each task's processes, and ends of processes through a handle whose start time it checked first. A job lets its
 * processes leave it (`BREAKAWAY_OK`), so a program that asks to leave still starts, and does not end them when its
 * handle closes, so a task runs on after a restart of the server.
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
    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimits {
        public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit;
        public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct IoCounters { public ulong A; public ulong B; public ulong C; public ulong D; public ulong E; public ulong F; }
    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimits {
        public BasicLimits Basic; public IoCounters Io; public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed;
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
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits info, int length);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, IntPtr info, int length, out int returned);

    const uint QUERY = 0x1000, SYNCHRONIZE = 0x100000, TERMINATE = 0x1, SET_QUOTA = 0x100;
    static readonly Dictionary<string, IntPtr> jobs = new Dictionary<string, IntPtr>();

    // The start of a live process in ms since 1601; -1 when it is gone, 0 when it is not ours to read.
    static long Start(IntPtr process) {
        if (WaitForSingleObject(process, 0) == 0) { return -1; }
        long creation, exit, kernel, user;
        return GetProcessTimes(process, out creation, out exit, out kernel, out user) ? creation / 10000 : 0;
    }

    static string List() {
        StringBuilder text = new StringBuilder("list");
        IntPtr snapshot = CreateToolhelp32Snapshot(2, 0);
        if (snapshot == new IntPtr(-1)) { return "error snapshot " + Marshal.GetLastWin32Error(); }
        try {
            Entry entry = new Entry();
            entry.dwSize = (uint)Marshal.SizeOf(typeof(Entry));
            for (bool more = Process32FirstW(snapshot, ref entry); more; more = Process32NextW(snapshot, ref entry)) {
                if (entry.th32ProcessID == 0) { continue; }
                long start = 0;
                IntPtr process = OpenProcess(QUERY | SYNCHRONIZE, false, entry.th32ProcessID);
                if (process != IntPtr.Zero) { start = Start(process); CloseHandle(process); }
                if (start < 0) { continue; }
                text.Append(' ').Append(entry.th32ProcessID).Append(',').Append(entry.th32ParentProcessID).Append(',').Append(start);
            }
        } finally { CloseHandle(snapshot); }
        return text.ToString();
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

    static string Job(string key, uint pid, long start) {
        IntPtr job;
        if (!jobs.TryGetValue(key, out job)) {
            job = CreateJobObjectW(IntPtr.Zero, null);
            if (job == IntPtr.Zero) { return "error job " + Marshal.GetLastWin32Error(); }
            ExtendedLimits limits = new ExtendedLimits();
            limits.Basic.LimitFlags = 0x800;
            SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(typeof(ExtendedLimits)));
            jobs[key] = job;
        }
        IntPtr process = Open(pid, start, SET_QUOTA | TERMINATE);
        if (process == IntPtr.Zero) { return "no"; }
        try { return AssignProcessToJobObject(job, process) ? "ok" : "error assign " + Marshal.GetLastWin32Error(); }
        finally { CloseHandle(process); }
    }

    static string Members(string key) {
        IntPtr job;
        if (!jobs.TryGetValue(key, out job)) { return "none"; }
        for (int size = 1024; ; size *= 4) {
            int bytes = 8 + size * IntPtr.Size, returned;
            IntPtr buffer = Marshal.AllocHGlobal(bytes);
            try {
                bool ok = QueryInformationJobObject(job, 3, buffer, bytes, out returned);
                int assigned = Marshal.ReadInt32(buffer), listed = Marshal.ReadInt32(buffer, 4);
                if (!ok && Marshal.GetLastWin32Error() != 234) { return "error members " + Marshal.GetLastWin32Error(); }
                if (listed < assigned && size < 1 << 20) { continue; }
                StringBuilder text = new StringBuilder("members");
                for (int at = 0; at < listed; at++) { text.Append(' ').Append(Marshal.ReadIntPtr(buffer, 8 + at * IntPtr.Size).ToInt64()); }
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
            case "job": return Job(words[1], uint.Parse(words[2]), long.Parse(words[3]));
            case "members": return Members(words[1]);
            case "killjob": return jobs.TryGetValue(words[1], out job) && TerminateJobObject(job, 1) ? "ok" : "no";
            case "drop":
                if (jobs.TryGetValue(words[1], out job)) { CloseHandle(job); jobs.Remove(words[1]); }
                return "ok";
            default: return "error unknown " + words[0];
        }
    }
}
`;

const HELPER_PS = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
${HELPER_CS}
'@
[Console]::Out.WriteLine('ready')
[Console]::Out.Flush()
while ($null -ne ($line = [Console]::In.ReadLine())) {
    try { $answer = [PiPocketProcesses]::Run($line) } catch { $answer = 'error ' + ($_.Exception.Message -replace '\\s+', ' ') }
    [Console]::Out.WriteLine($answer)
    [Console]::Out.Flush()
}
`;

type Waiting = { resolve: (line: string) => void; reject: (error: Error) => void };
type HelperRun = { child: ChildProcess; ready: Promise<void>; waiting: Waiting[] };

/** One PowerShell process that answers a line for each line it is sent, started when first needed. */
class Helper {
    #current: HelperRun | undefined;
    #idle: ReturnType<typeof setTimeout> | undefined;
    /** Whether it holds jobs: then it stays, or their tasks could no longer be ended by their jobs. */
    holds: () => boolean = () => false;
    failed: string | undefined;

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
            { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
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
                    } else {
                        waiting.shift()?.resolve(line);
                    }
                }
            });
        });

        ready.catch(() => undefined);

        return { child, ready, waiting };
    }

    async ask(line: string): Promise<string> {
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
            this.close();

            throw error;
        }

        const answer = new Promise<string>((resolve, reject) =>
            current.waiting.push({ resolve, reject }),
        );

        current.child.stdin!.write(`${line}\n`);

        try {
            const text = await withTimeout(answer, 15_000, "The process helper did not answer");

            if (text.startsWith("error ")) {
                throw new Error(text.slice(6));
            }

            return text;
        } catch (error) {
            // A helper that does not answer in time is out of step with its answers: a new one starts next time.
            if ((error as Error).message === "The process helper did not answer") {
                this.close();
            }

            throw error;
        } finally {
            this.#idle = setTimeout(() => {
                if (!this.holds()) {
                    this.close();
                }
            }, 60_000);
            this.#idle.unref?.();
        }
    }

    close(): void {
        clearTimeout(this.#idle);

        const current = this.#current;

        this.#current = undefined;
        current?.child.stdin?.end();
        current?.child.kill();
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
    'pidf=$PI_POCKET_BACKGROUND_PIDFILE; unset PI_POCKET_BACKGROUND_PIDFILE; read -r winpid < /proc/$$/winpid; printf "%s" "$winpid" > "$pidf"; IFS= read -r _gate; exec 0< /dev/null; ';

class WindowsProcesses implements TaskProcesses {
    readonly boot = undefined;
    readonly #helper = new Helper();
    #shell: string | undefined | null = null;
    #scan: { at: number; all: Map<number, WinProc> } | undefined;
    /** Each task's processes found so far, pid to start, also in `<files>.pids`. */
    #known = new Map<string, Map<number, number>>();
    /** The jobs the helper holds, by key. */
    #jobs = new Set<string>();
    /** What this server spawned: a handle Node keeps while the process runs, so its pid cannot be another's. */
    #children = new Map<number, ChildProcess>();

    constructor() {
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
        const all = new Map<number, WinProc>();

        for (const word of answer.split(" ").slice(1)) {
            const [pid, ppid, start] = word.split(",").map(Number);

            all.set(pid!, { pid: pid!, ppid: ppid!, start: start! });
        }

        this.#scan = { at, all };

        return all;
    }

    /** The processes found of a task: its first one, and those in its file. */
    #knownOf(task: TaskRef): Map<number, number> {
        let known = this.#known.get(task.marker);

        if (known === undefined) {
            known = new Map();

            if (task.pid > 0 && task.startTicks !== undefined) {
                known.set(task.pid, task.startTicks);
            }

            try {
                for (const line of readFileSync(`${task.files}.pids`, "utf8").split("\n")) {
                    const [pid, start] = line.split(" ").map(Number);

                    if (pid! > 0 && start! > 0) {
                        known.set(pid!, start!);
                    }
                }
            } catch {
                // None found yet.
            }

            this.#known.set(task.marker, known);
        }

        return known;
    }

    /**
     * A task's live processes in a table: what it knew, what its job holds, and each process whose parent is one of
     * them, still running with its start time, and that started after it (a parent's pid that a later process took
     * is not that process's parent).
     */
    #members(task: TaskRef, all: Map<number, WinProc>, job: number[]): number[] {
        if (task.pid <= 0 || task.startTicks === undefined) {
            return [];
        }

        const known = this.#knownOf(task);
        const found: string[] = [];

        const add = (pid: number, start: number) => {
            known.set(pid, start);
            found.push(`${pid} ${start}\n`);
        };

        for (const pid of job) {
            const info = all.get(pid);

            if (info !== undefined && info.start > 0 && !known.has(pid)) {
                add(pid, info.start);
            }
        }

        for (const info of [...all.values()].sort((a, b) => a.start - b.start)) {
            const parent = known.get(info.ppid);

            if (
                parent !== undefined &&
                !known.has(info.pid) &&
                info.start > 0 &&
                all.get(info.ppid)?.start === parent &&
                info.start >= parent
            ) {
                add(info.pid, info.start);
            }
        }

        if (found.length > 0) {
            try {
                appendFileSync(`${task.files}.pids`, found.join(""));
            } catch {
                // Its folder is gone: the task's files went with it.
            }
        }

        return [...known]
            .filter(([pid, start]) => all.get(pid)?.start === start)
            .map(([pid]) => pid);
    }

    async #job(task: TaskRef): Promise<number[]> {
        const key = this.#key(task);

        if (!this.#jobs.has(key)) {
            return [];
        }

        const answer = await this.#helper.ask(`members ${key}`);

        return answer === "none" ? [] : answer.split(" ").slice(1).map(Number);
    }

    async spawn(
        script: string,
        cwd: string,
        env: NodeJS.ProcessEnv,
        task: TaskRef,
    ): Promise<number> {
        const shell = this.shell();

        if (shell === undefined) {
            throw new Error("No Git Bash on this machine.");
        }

        const child = spawn(shell, ["-c", WINDOWS_GATE + script], {
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

        this.#children.set(pid, child);
        child.once("exit", () => this.#children.delete(pid));
        child.unref();
        (child.stdin as unknown as { unref?: () => void }).unref?.();

        try {
            // Its bash runs under Git's launcher: once the bash wrote its pid, both wait at the gate, started before the
            // job was there, so each goes into it before the command starts.
            for (let tries = 0; tries < 400 && !existsSync(`${task.files}.pid`); tries++) {
                if (child.exitCode !== null) {
                    break;
                }

                await new Promise((resolve) => setTimeout(resolve, 25));
            }

            const all = await this.#list(true);
            const start = all.get(pid)?.start;

            if (start === undefined || start <= 0) {
                throw new Error("The command's start time could not be read.");
            }

            const key = this.#key(task);
            const known = this.#knownOf({ ...task, pid, startTicks: start });

            for (const each of this.#members({ ...task, pid, startTicks: start }, all, [])) {
                const answer = await this.#helper
                    .ask(`job ${key} ${each} ${known.get(each)}`)
                    .catch(() => "no");

                // Without a job, its tree alone holds it: a process whose parent ended before a look found it is not
                // followed.
                if (answer === "ok") {
                    this.#jobs.add(key);
                }
            }
        } catch (error) {
            child.kill();

            throw error;
        } finally {
            child.stdin!.end();
        }

        return pid;
    }

    async startOf(pid: number): Promise<number | undefined> {
        return (await this.#list(true)).get(pid)?.start;
    }

    async members(task: TaskRef, fresh = false): Promise<number[]> {
        if (task.pid <= 0) {
            return [];
        }

        let all: Map<number, WinProc>;
        let job: number[];

        try {
            [job, all] = await Promise.all([this.#job(task), this.#list(fresh)]);
        } catch {
            // The helper failed: a task whose first process is there is taken to run, and nothing is ended for it.
            return kill(task.pid, 0) ? [task.pid] : [];
        }

        const members = this.#members(task, all, job);

        if (members.length === 0 && fresh) {
            this.#done(task);
        }

        return members;
    }

    /** A task with no process left: its job goes, and what was kept for it. */
    #done(task: TaskRef): void {
        const key = this.#key(task);

        this.#known.delete(task.marker);

        if (this.#jobs.delete(key)) {
            void this.#helper.ask(`drop ${key}`).catch(() => undefined);
        }
    }

    aliveSync(task: TaskRef): boolean {
        if (task.pid <= 0) {
            return false;
        }

        if (this.#scan === undefined || Date.now() - this.#scan.at > 5000) {
            return kill(task.pid, 0);
        }

        return this.#members(task, this.#scan.all, []).length > 0;
    }

    async left(): Promise<number[]> {
        return [];
    }

    async stillLeft(): Promise<number[]> {
        return [];
    }

    /** Both signals end the processes by force: Windows has no polite stop for a program without a window. */
    async signal(task: TaskRef, _name: Signal): Promise<void> {
        const key = this.#key(task);

        if (this.#jobs.has(key)) {
            await this.#helper.ask(`killjob ${key}`).catch(() => undefined);
        }

        // Then each process found, parents first, checked against its start time by the helper as it ends it; a pass
        // again for what they started in the meantime.
        for (let pass = 0; pass < 3; pass++) {
            const all = await this.#list(true).catch(() => undefined);

            if (all === undefined) {
                return;
            }

            const known = this.#knownOf(task);
            const members = this.#members(task, all, []);

            if (members.length === 0) {
                return;
            }

            for (const pid of members.sort((a, b) => known.get(a)! - known.get(b)!)) {
                await this.#helper.ask(`kill ${pid} ${known.get(pid)}`).catch(() => undefined);
            }
        }
    }

    async killSpawned(task: TaskRef, pid: number): Promise<void> {
        this.#children.get(pid)?.kill();

        const key = this.#key(task);

        if (this.#jobs.has(key)) {
            await this.#helper.ask(`killjob ${key}`).catch(() => undefined);
        }
    }

    /** A start cut off: the bash whose pid its wrapper wrote, if it started after the reservation and before the file. */
    async find(task: TaskRef): Promise<{ pid: number; start?: number } | undefined> {
        let pid: number;
        let written: number;

        try {
            pid = Number(readFileSync(`${task.files}.pid`, "utf8").trim());
            written = statSync(`${task.files}.pid`).mtimeMs + WINDOWS_EPOCH_MS;
        } catch {
            return undefined;
        }

        const info = (await this.#list(true)).get(pid);

        if (
            info === undefined ||
            info.start <= 0 ||
            info.start > written + 2000 ||
            info.start < task.startedAt + WINDOWS_EPOCH_MS - 2000
        ) {
            return undefined;
        }

        return { pid, start: info.start };
    }

    close(): void {
        this.#helper.close();
    }
}

/** The processes of this platform. */
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
