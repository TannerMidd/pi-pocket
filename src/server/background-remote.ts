/** Background processes and their files on a session's computer, never on the server's disk. */
import { posix } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import type { BackgroundTask } from "./docs.ts";
import type { RunnerEnv } from "./runners.ts";

const context = BACKGROUND_CONTEXT;

/** No marker on the inspecting shell itself: only the detached wrapper and its children inherit it. */
const INSPECT = `
needle=PI_POCKET_BACKGROUND=$1; group=$2; signal=$3; mode=$4
if [ -d /proc/self ]; then
    for file in /proc/[0-9]*/stat; do
        { IFS= read -r text < "$file"; } 2>/dev/null || continue
        rest=\${text##*) }; read -r state parent pgid rest <<< "$rest"
        [ "$state" = Z ] || [ "$state" = X ] && continue
        [ "$mode" = group ] && [ "$pgid" != "$group" ] && continue
        pid=\${file#/proc/}; pid=\${pid%/stat}
        found=false
        while IFS= read -r -d '' value; do
            if [ "$value" = "$needle" ]; then found=true; break; fi
        done 2>/dev/null < /proc/$pid/environ
        $found || continue
        printf '%s %s\\n' "$pid" "$pgid"
    done
else
    while read -r pid pgid state; do
        [[ "$state" = Z* ]] && continue
        [ "$mode" = group ] && [ "$pgid" != "$group" ] && continue
        text=$(ps eww -p "$pid" -o command= 2>/dev/null)
        [[ " $text " = *" $needle "* ]] || continue
        printf '%s %s\\n' "$pid" "$pgid"
    done < <(ps -axo pid=,pgid=,stat=)
fi | while read -r pid pgid; do
    if [ -n "$signal" ]; then
        if [ "$pgid" = "$group" ] || [ "$pid" = "$pgid" ]; then
            kill -s "$signal" -- "-$pgid" 2>/dev/null || true
        else
            kill -s "$signal" "$pid" 2>/dev/null || true
        fi
    else
        printf '%s %s\\n' "$pid" "$pgid"
    fi
done`;

const LAUNCH = `
command -v split >/dev/null || { echo 'Background tasks need the split command (coreutils) on this computer.' >&2; exit 1; }
if command -v setsid >/dev/null; then
    setsid bash -c "$1" </dev/null >/dev/null 2>&1 &
else
    command -v perl >/dev/null || { echo 'Background tasks need setsid or perl on this computer.' >&2; exit 1; }
    nohup perl -e 'setpgrp(0,0) or die "setpgrp: $!"; exec @ARGV or die "exec: $!"' bash -c "$1" </dev/null >/dev/null 2>&1 &
fi
printf '%s' "$!"`;

export class RemoteBackground {
    readonly env: RunnerEnv;
    readonly permission: string;

    constructor(env: RunnerEnv, permission: string) {
        this.env = env;
        this.permission = permission;
    }

    async dir(): Promise<string> {
        // The runner applies the same id check before granting this folder in RequestGate.
        if (!/^[A-Za-z0-9._-]+$/.test(this.permission) || [".", ".."].includes(this.permission)) {
            throw new Error("Invalid background task permission id.");
        }

        return posix.join(
            (await this.env.connection.info()).tmpdir,
            "pi-pocket-tasks",
            this.permission,
        );
    }

    async supported(): Promise<void> {
        await this.env.connection.info();
    }

    async exec(script: string, args: string[], env?: Record<string, string>): Promise<string> {
        let text = "";
        const result = getOrThrow(
            await this.env.exec(
                ["bash", "-c", script, "background", ...args],
                {
                    ...(env === undefined ? {} : { env }),
                    onOutput: (chunk) => {
                        text += chunk;
                    },
                },
                context,
            ),
        );

        if (result.exitCode !== 0) {
            throw new Error(
                text.trim() || `Background task command exited with code ${result.exitCode}.`,
            );
        }

        return text;
    }

    async spawn(
        item: BackgroundTask,
        marker: string,
        wrapper: string,
        added: Record<string, string>,
        segment: number,
    ): Promise<number> {
        if (this.env.link.tasks) {
            return this.env.link.taskStart({
                permission: this.permission,
                task: item.id,
                command: item.command,
                cwd: item.cwd,
                env: added,
                segment: item.segment ?? segment,
            });
        }

        const dir = await this.dir();

        getOrThrow(await this.env.createDir(dir, { recursive: true }, context));
        const pid = Number(
            await this.exec(LAUNCH, [wrapper], {
                ...added,
                PI_POCKET_BACKGROUND: marker,
                PI_POCKET_BACKGROUND_COMMAND: item.command,
                PI_POCKET_BACKGROUND_EXIT: posix.join(dir, `${item.id}.exit`),
                PI_POCKET_BACKGROUND_LOG: posix.join(dir, `${item.id}.log.`),
                PI_POCKET_BACKGROUND_SEGMENT: String(item.segment ?? segment),
            }),
        );

        if (!Number.isSafeInteger(pid) || pid <= 0) {
            throw new Error("The background task did not return its process id.");
        }

        return pid;
    }

    async processes(
        marker: string,
        group = 0,
        signal = "",
        onlyGroup = false,
    ): Promise<{ pid: number; pgid: number }[]> {
        if (this.env.link.tasks) {
            const task = marker.slice(marker.lastIndexOf("/") + 1);
            // Its shell ending ends the task, as a group's leader does on a server: what it left running is named and
            // stopped then (`background.ts`, `#left`), while the host stays until it is gone or the runner stops.
            const tasks = (await this.env.link.taskList(this.permission)).filter(
                (item) =>
                    item.task === task &&
                    (!onlyGroup || (item.pid === group && item.ended !== true)),
            );

            // What an ended task left: outside its leader's group (`#left` takes those). The runner names the processes
            // that still run; an older one names only the task's shell, which has ended.
            if (signal === "" && !onlyGroup) {
                return tasks.flatMap(({ pid, ended, left }) =>
                    ended !== true
                        ? [{ pid, pgid: pid }]
                        : (left ?? [pid]).map((each) => ({ pid: each, pgid: 0 })),
                );
            }

            if (signal !== "" && tasks.length > 0) {
                if (signal !== "TERM" && signal !== "KILL") {
                    throw new Error("Invalid background task signal.");
                }

                await this.env.link.taskSignal(this.permission, task, signal);

                return [];
            }

            return tasks.map(({ pid }) => ({ pid, pgid: pid }));
        }

        // kill -0 alone also counts zombies and reused ids. Always check a live process's exact marker too.
        const script = onlyGroup ? `kill -0 -- "-$2" 2>/dev/null || exit 0; ${INSPECT}` : INSPECT;
        const text = await this.exec(script, [
            marker,
            String(group),
            signal,
            onlyGroup ? "group" : "all",
        ]);

        return text
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => {
                const [pid, pgid] = line.split(" ").map(Number);

                if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(pgid)) {
                    throw new Error("Invalid background process information.");
                }

                return { pid: pid!, pgid: pgid! };
            });
    }

    async files() {
        const result = await this.env.listDir(await this.dir(), context);

        if (!result.ok && result.error.code === "not_found") {
            return [];
        }

        return getOrThrow(result);
    }

    async bytes(path: string, from: number, to: number): Promise<Buffer> {
        const opened = await this.env.openBinaryReader(path, { noFollow: true }, context);

        if (!opened.ok && opened.error.code === "not_found") {
            return Buffer.alloc(0);
        }

        const reader = getOrThrow(opened);

        try {
            return Buffer.from(
                getOrThrow(await reader.read(from, Math.max(0, to - from), context)),
            );
        } finally {
            void reader.close(context).catch(() => {});
        }
    }

    async remove(path: string): Promise<void> {
        getOrThrow(await this.env.remove(path, { force: true }, context));
    }

    async exitCodes(id: string): Promise<{ code: number; log: number; at: number } | undefined> {
        const path = posix.join(await this.dir(), `${id}.exit`);
        const info = await this.env.fileInfo(path, context);

        if (!info.ok && info.error.code === "not_found") {
            return undefined;
        }

        const at = getOrThrow(info).mtimeMs;
        const codes = /^(\d+)(?: (\d+))?$/.exec((await this.bytes(path, 0, 64)).toString().trim());

        return codes === null
            ? undefined
            : { code: Number(codes[1]), log: Number(codes[2] ?? 0), at };
    }
}
