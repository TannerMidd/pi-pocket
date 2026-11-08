/** Remote project files stay on their computer. Design runs here, in a bounded, per-session copy. */
import { lstat, mkdir, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { basename, dirname, join, posix, sep, win32 } from "node:path";
import type { Context } from "@earendil-works/chord";
import type { ConversationId, ToolRegistration } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { remoteAccess, type FolderAccess } from "../folder-access.ts";
import type { ExtensionWeb, PocketHost } from "../host.ts";
import { DOT_STYLE_FOLDERS, SCAN_SKIP, scanSource } from "./scan-files.ts";

export const MIRROR_BYTES = 200 * 1024 * 1024;
export const MIRROR_FILES = 5000;
const LIMIT =
    "The design mirror exceeds 200 MiB or 5000 files. Use a smaller project folder or scan path.";
const queues = new Map<string, Promise<unknown>>();

type Stamp = { size: number; mtimeMs: number };
type Inventory = Map<string, Stamp>;
type Host = Pick<PocketHost, "dataDir" | "runnerOf" | "envFor">;

const same = (a: Stamp | undefined, b: Stamp) =>
    a !== undefined && a.size === b.size && Math.abs(a.mtimeMs - b.mtimeMs) < 0.01;
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

function budget(files: Inventory): void {
    if (
        files.size > MIRROR_FILES ||
        [...files.values()].reduce((sum, file) => sum + file.size, 0) > MIRROR_BYTES
    ) {
        throw new Error(LIMIT);
    }
}

/** No links, devices, or unbounded directory lists enter the server copy. */
async function inventory(root: string): Promise<Inventory> {
    const files: Inventory = new Map();
    let entries = 0;

    const walk = async (rel: string): Promise<void> => {
        const path = join(root, rel);
        const info = await lstat(path);

        if (++entries > MIRROR_FILES * 2) {
            throw new Error(LIMIT);
        }

        if (info.isDirectory()) {
            for (const name of await readdir(path)) {
                await walk(join(rel, name));
            }
        } else if (info.isFile()) {
            files.set(rel, info);
            budget(files);
        } else {
            throw new Error("A design mirror must contain only regular files and folders.");
        }
    };

    await walk("");

    return files;
}

/** A remote path is checked before it is sent to the computer, including absolute tool arguments. */
function projectPath(access: FolderAccess, root: string, path: string): string {
    const target = access.path.resolve(root, path);
    const rel = access.path.relative(root, target);

    if (rel === ".." || rel.startsWith(`..${access.path.sep}`) || access.path.isAbsolute(rel)) {
        throw new Error("Design paths must stay inside the session folder.");
    }

    return rel.split(access.path.sep).join(sep);
}

/** Refuse links even when they lead to another approved folder or a runner-owned folder. */
async function noLinks(access: FolderAccess, root: string, rel: string): Promise<void> {
    let path = root;
    const parts = rel.split(sep).filter(Boolean);

    for (const part of parts) {
        path = access.path.join(path, part);
        const info = await access.info(path).catch((error: unknown) => {
            if (!missing(error)) {
                throw error;
            }

            return undefined;
        });

        if (info === undefined) {
            return;
        }

        if (info.kind === "symlink" || info.kind === "other") {
            throw new Error("Design paths must not contain symbolic links or special files.");
        }
    }
}

/** Copy the design system for every call; copy project sources only for an action which scans them. */
async function pull(
    access: FolderAccess,
    root: string,
    mirror: string,
    scan: string | undefined,
    extra: string[],
): Promise<void> {
    const wanted: Inventory = new Map();
    let entries = 0;

    const walk = async (rel: string, sources: boolean): Promise<void> => {
        if (++entries > MIRROR_FILES * 2) {
            throw new Error(LIMIT);
        }

        const path = access.path.join(root, ...rel.split(sep));
        const info = await access.info(path).catch((error: unknown) => {
            if (!missing(error)) {
                throw error;
            }

            return undefined;
        });

        if (info === undefined) {
            return;
        }

        if (info.kind === "directory") {
            const list = await access.list(path, MIRROR_FILES * 2);

            if (list.more) {
                throw new Error(LIMIT);
            }

            for (const entry of list.entries) {
                if (
                    entry.name === "." ||
                    entry.name === ".." ||
                    entry.name.includes("/") ||
                    entry.name.includes(access.path.sep) ||
                    entry.name.includes(sep)
                ) {
                    throw new Error("The computer returned an invalid design file name.");
                }

                if (
                    sources &&
                    entry.dir &&
                    (SCAN_SKIP.has(entry.name) ||
                        (entry.name.startsWith(".") && !DOT_STYLE_FOLDERS.has(entry.name)))
                ) {
                    continue;
                }

                await walk(join(rel, entry.name), sources);
            }
        } else if (
            info.kind === "file" &&
            (!sources ||
                scanSource(rel.split(sep).join("/"), basename(rel)) ||
                rel.endsWith(".json"))
        ) {
            wanted.set(rel, info);
            budget(wanted);
        } else if (!sources) {
            throw new Error("Design paths must not contain symbolic links or special files.");
        }
    };

    await noLinks(access, root, join(".pi", "design"));
    await noLinks(access, root, join(".pi", "design-system.md"));
    await walk(join(".pi", "design"), false);
    await walk(join(".pi", "design-system.md"), false);

    if (scan !== undefined) {
        await noLinks(access, root, scan);
        await walk(scan, true);
    }

    for (const rel of extra) {
        await noLinks(access, root, rel);
        await walk(rel, false);
    }

    const before = await inventory(mirror);

    for (const rel of before.keys()) {
        if (!wanted.has(rel)) {
            await rm(join(mirror, rel));
        }
    }

    // Remove empty folders too: a file can have replaced a folder on the computer.
    const prune = async (dir: string): Promise<void> => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
            if (entry.isDirectory()) {
                await prune(join(dir, entry.name));
            }
        }

        if (dir !== mirror && (await readdir(dir)).length === 0) {
            await rm(dir, { recursive: true });
        }
    };

    await prune(mirror);

    for (const [rel, info] of wanted) {
        if (same(before.get(rel), info)) {
            continue;
        }

        const read = await access.peek(access.path.join(root, ...rel.split(sep)), info.size + 1);

        if (read.kind !== "file" || !same(info, read) || read.bytes.length !== info.size) {
            throw new Error("A design file changed while it was copied. Try the call again.");
        }

        const target = join(mirror, rel);

        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, read.bytes);
        await utimes(target, info.mtimeMs / 1000, info.mtimeMs / 1000);
    }
}

async function push(
    env: ExecutionEnv,
    access: FolderAccess,
    root: string,
    mirror: string,
    before: Inventory,
    context: Context,
): Promise<void> {
    const after = await inventory(mirror);

    for (const rel of new Set([...before.keys(), ...after.keys()])) {
        const info = after.get(rel);

        if (info !== undefined && same(before.get(rel), info)) {
            continue;
        }

        await noLinks(access, root, rel);
        const target = access.path.join(root, ...rel.split(sep));
        const result =
            info === undefined
                ? await env.remove(target, { force: true }, context)
                : await env.createDir(access.path.dirname(target), { recursive: true }, context);

        if (!result.ok) {
            throw new Error(
                `Could not copy a design file back to the computer: ${result.error.message}`,
            );
        }

        if (info !== undefined) {
            const wrote = await env.writeFile(target, await readFile(join(mirror, rel)), context);

            if (!wrote.ok) {
                throw new Error(
                    `Could not copy a design file back to the computer: ${wrote.error.message}`,
                );
            }
        }
    }
}

/** Change paths in structured results as well as text, so neither downloads nor Pi get server-only paths. */
function paths<T>(value: T, from: string, to: string): T {
    if (typeof value === "string") {
        return value.replaceAll(from, to) as T;
    }

    if (Array.isArray(value)) {
        return value.map((each: unknown) => paths(each, from, to)) as T;
    }

    if (value !== null && typeof value === "object") {
        if (Object.getPrototypeOf(value) !== Object.prototype) {
            return value;
        }

        return Object.fromEntries(
            Object.entries(value).map(([key, each]) => [key, paths(each, from, to)]),
        ) as T;
    }

    return value;
}

export async function withDesignMirror<T>(
    host: Host,
    id: ConversationId,
    cwd: string | undefined,
    context: Context,
    work: (folder: string | undefined, path: (value: string) => string) => Promise<T>,
    scan?: string,
    extra: string[] = [],
): Promise<T> {
    if (host.runnerOf?.(id) === undefined) {
        return work(cwd, (value) => value);
    }

    const env = host.envFor(id);
    const kit = win32.isAbsolute(env.cwd) && !posix.isAbsolute(env.cwd) ? win32 : posix;
    const access = remoteAccess(env, { os: kit === win32 ? "windows" : "linux" });
    const name = String(id);

    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
        throw new Error("This session has no valid design mirror id.");
    }

    const mirror = join(host.dataDir, "design-mirrors", name);
    const previous = queues.get(mirror) ?? Promise.resolve();
    const run = previous.then(async () => {
        try {
            const root = await access.realpath(env.cwd);
            const local = (value: string) => join(mirror, projectPath(access, env.cwd, value));

            await mkdir(mirror, { recursive: true, mode: 0o700 });
            await pull(
                access,
                root,
                mirror,
                scan === undefined ? undefined : projectPath(access, env.cwd, scan),
                extra.map((path) => projectPath(access, env.cwd, path)),
            );
            const before = await inventory(mirror);

            try {
                return paths(await work(mirror, local), mirror, root);
            } finally {
                await push(env, access, root, mirror, before, context);
            }
        } catch (error) {
            if (error instanceof Error) {
                if (error.message === LIMIT) {
                    // Cleanup is part of the queue: it must finish before this session's next call can use the mirror.
                    await rm(mirror, { recursive: true, force: true });
                }

                error.message = error.message.replaceAll(mirror, cwd ?? env.cwd);
            }

            throw error;
        }
    });
    const tail = run.catch(() => undefined);

    queues.set(mirror, tail);
    void tail.then(() => queues.get(mirror) === tail && queues.delete(mirror));

    return run;
}

export function remoteDesignTool(host: Host, tool: ToolRegistration): ToolRegistration {
    return {
        ...tool,
        execute: async (args, api, context) => {
            const agent = await api.agent(context);
            const input = args as Record<string, unknown>;
            const scan =
                tool.name === "design_system" &&
                (input.action === "scan" ||
                    input.action === "resync" ||
                    (input.action === "init" && input.tokens === undefined))
                    ? typeof input.path === "string"
                        ? input.path
                        : "."
                    : undefined;

            return withDesignMirror(
                host,
                api.conversationId,
                agent.cwd,
                context,
                (cwd, path) =>
                    tool.execute(
                        typeof input.path === "string"
                            ? { ...input, path: path(input.path) }
                            : args,
                        { ...api, agent: async () => ({ ...agent, cwd }) },
                        context,
                    ),
                scan,
            );
        },
    };
}

/** All design panel requests use the same queue and mirror as the agent's tools. */
export function remoteDesignWeb(host: Host, web: ExtensionWeb): ExtensionWeb {
    return {
        ...web,
        conversationRoute: (method, path, handle, options) =>
            web.conversationRoute(
                method,
                path,
                async (request) => {
                    try {
                        return await withDesignMirror(
                            host,
                            request.conversation.id,
                            request.conversation.cwd,
                            request.context,
                            async (cwd) =>
                                handle({
                                    ...request,
                                    conversation: { ...request.conversation, cwd: cwd ?? "" },
                                }),
                        );
                    } catch (error) {
                        if (error instanceof Error && "status" in error) {
                            throw error;
                        }

                        throw web.error(
                            400,
                            error instanceof Error
                                ? error.message
                                : "The design mirror could not be copied.",
                        );
                    }
                },
                options,
            ),
    };
}
