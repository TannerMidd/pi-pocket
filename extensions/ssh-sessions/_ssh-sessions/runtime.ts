import {
    BACKGROUND_CONTEXT,
    withAbortSignal,
    awaitWithContext,
} from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import {
    RemoteExecutionEnv,
    sshConnection,
    scanHostKey,
    acceptHostKey,
    nodePlatform,
} from "@earendil-works/pi-env";
import { join, posix } from "node:path";
import { homedir } from "node:os";
import { parseWorkspace, sshAliases, validAlias, workspaceUri } from "./config.ts";

export { parseWorkspace, workspaceUri, sshAliases };

export class SshWorkspaces {
    readonly knownHostsFile: string;
    readonly #connections = new Map<string, ReturnType<typeof sshConnection>>();
    readonly #envs = new Map<string, RemoteExecutionEnv>();
    #closed = false;

    constructor(dataDir: string) {
        this.knownHostsFile = join(dataDir, "ssh-sessions", "known_hosts");
    }

    target(alias: string) {
        if (!validAlias(alias)) {
            throw new Error("Invalid SSH alias.");
        }

        return {
            host: alias,
            configFile: join(homedir(), ".ssh", "config"),
            knownHostsFile: this.knownHostsFile,
            hostKeyAlias: `pi-pocket-${alias}`,
        };
    }

    async requireAlias(alias: string) {
        if (!(await sshAliases()).includes(alias)) {
            throw new Error("Choose a Host alias from ~/.ssh/config or its Include files.");
        }
    }

    #connection(alias: string) {
        if (this.#closed) {
            throw new Error("The SSH extension is disabled.");
        }

        let connection = this.#connections.get(alias);

        if (!connection) {
            connection = sshConnection({ ...this.target(alias), loginShell: true });
            this.#connections.set(alias, connection);
        }

        return connection.connection;
    }

    env(cwd: string): RemoteExecutionEnv {
        const { alias, path } = parseWorkspace(cwd);
        let env = this.#envs.get(cwd);

        if (this.#closed) {
            throw new Error("The SSH extension is disabled.");
        }

        if (!env) {
            env = new RemoteExecutionEnv({
                connection: this.#connection(alias),
                id: `ssh:${alias}`,
                cwd: path,
            });
            this.#envs.set(cwd, env);
        }

        return env;
    }

    async resolveCwd(cwd: string, signal?: AbortSignal): Promise<string> {
        const { alias, path } = parseWorkspace(cwd);

        await this.requireAlias(alias);
        const context = signal ? withAbortSignal(signal, BACKGROUND_CONTEXT) : BACKGROUND_CONTEXT;
        const connection = this.#connection(alias);
        const info = await awaitWithContext(connection.info(), context);

        if (info.separator !== "/") {
            throw new Error("This version supports Linux and macOS SSH hosts, not Windows.");
        }

        const requested =
            path === "/~"
                ? info.home
                : path.startsWith("/~/")
                  ? posix.join(info.home, path.slice(3))
                  : path;
        const env = this.env(workspaceUri(alias, requested));
        const canonical = getOrThrow(await env.canonicalPath(requested, context));
        const stat = getOrThrow(await env.fileInfo(canonical, context));

        if (stat.kind !== "directory") {
            throw new Error("The remote path is not a directory.");
        }

        signal?.throwIfAborted();

        return workspaceUri(alias, canonical);
    }

    async scan(alias: string) {
        await this.requireAlias(alias);

        return scanHostKey(this.target(alias));
    }

    async trust(alias: string, lines: unknown) {
        await this.requireAlias(alias);

        if (
            !Array.isArray(lines) ||
            lines.length < 1 ||
            lines.length > 10 ||
            lines.some(
                (line) => typeof line !== "string" || line.length > 4096 || /[\r\n]/.test(line),
            )
        ) {
            throw new Error("Invalid SSH host key.");
        }

        await acceptHostKey(this.target(alias), lines);
    }

    async system(cwd: string, context: Context) {
        const { alias } = parseWorkspace(cwd);
        const info = await awaitWithContext(this.#connection(alias).info(), context);

        return { ...nodePlatform(info), home: info.home };
    }

    async projectContext(cwd: string, context: Context): Promise<{ path: string; text: string }[]> {
        const env = this.env(cwd);
        const { home } = await this.system(cwd, context);
        const files: { path: string; text: string }[] = [];
        let bytes = 0;

        const add = async (path: string): Promise<boolean> => {
            const info = await env.fileInfo(path, context);

            if (!info.ok && info.error.code === "not_found") {
                return false;
            }

            const stat = getOrThrow(info);

            if (stat.size > 262_144 || bytes + stat.size > 524_288) {
                throw new Error(`Instructions distantes trop volumineuses : ${path}`);
            }

            const text = getOrThrow(await env.readTextFile(path, context));

            bytes += Buffer.byteLength(text);
            files.push({ path, text });

            return true;
        };

        await add(posix.join(home, ".pi", "agent", "AGENTS.md"));
        const parents: string[] = [];
        let directory = env.cwd;

        for (let count = 0; count < 64; count++) {
            parents.unshift(directory);
            const parent = posix.dirname(directory);

            if (parent === directory) {
                break;
            }

            directory = parent;
        }

        for (const parent of parents) {
            for (const name of [
                "AGENTS.override.md",
                "AGENTS.md",
                "AGENTS.MD",
                "CLAUDE.md",
                "CLAUDE.MD",
            ]) {
                if (await add(posix.join(parent, name))) {
                    break;
                }
            }
        }

        return files;
    }

    close() {
        this.#closed = true;

        for (const { connection } of this.#connections.values()) {
            connection.close();
        }

        this.#connections.clear();
        this.#envs.clear();
    }
}
