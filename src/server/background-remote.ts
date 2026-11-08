/** Background processes and their files on a session's computer, never on the server's disk. */
import { posix } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import type { BackgroundTask } from "./docs.ts";
import type { RunnerEnv } from "./runners.ts";

const context = BACKGROUND_CONTEXT;

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

    async spawn(
        item: BackgroundTask,
        added: Record<string, string>,
        segment: number,
    ): Promise<number> {
        return this.env.link.taskStart({
            permission: this.permission,
            task: item.id,
            command: item.command,
            cwd: item.cwd,
            env: added,
            segment: item.segment ?? segment,
        });
    }

    async processes(
        marker: string,
        group = 0,
        signal = "",
        onlyGroup = false,
    ): Promise<{ pid: number; pgid: number }[]> {
        const task = marker.slice(marker.lastIndexOf("/") + 1);
        // Its shell ending ends the task, as a group's leader does on a server: what it left running is named and
        // stopped then (`background.ts`, `#left`), while the host stays until it is gone or the runner stops.
        const tasks = (await this.env.link.taskList(this.permission)).filter(
            (item) =>
                item.task === task && (!onlyGroup || (item.pid === group && item.ended !== true)),
        );

        // What an ended task left: outside its leader's group (`#left` takes those). If its host cannot list them,
        // the task's shell stands for them until the host ends.
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
