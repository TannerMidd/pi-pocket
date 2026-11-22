/**
 * `launcher-running.json` says which launcher runs and where its server answers, for the desktop apps. It holds no
 * secret: the apps sign in with a one-time link. Installed apps read it across versions, so its fields only ever grow.
 */
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const RUNNING_FILE = "launcher-running.json";

export interface Running {
    version: 1;
    pid: number;
    /** The server's address for a browser on this machine, such as `http://127.0.0.1:8787`; null on a Unix socket. */
    url: string | null;
    /** Started by a desktop app (`--desktop`), which stops it when it quits. */
    desktop: boolean;
}

export function writeRunning(data: string, running: Running): void {
    const file = join(data, RUNNING_FILE);
    const temp = `${file}.${process.pid}.tmp`;

    writeFileSync(temp, `${JSON.stringify(running)}\n`, { mode: 0o600 });
    renameSync(temp, file);
}

export function readRunning(data: string): Running | undefined {
    try {
        const running = JSON.parse(readFileSync(join(data, RUNNING_FILE), "utf8")) as Running;

        return Number.isInteger(running?.pid) ? running : undefined;
    } catch {
        return undefined;
    }
}

/** Remove the file if launcher `pid` wrote it: a launcher that failed to start must not remove the running one's. */
export function removeRunning(data: string, pid: number): void {
    if (readRunning(data)?.pid === pid) {
        rmSync(join(data, RUNNING_FILE), { force: true });
    }
}
