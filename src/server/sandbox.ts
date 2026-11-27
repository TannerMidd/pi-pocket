/**
 * Sandboxed sessions: a session whose file and shell tools run in a micro-VM instead of on this machine.
 *
 * Core keeps what an extension cannot keep safe: the session's setting (`SandboxDoc`, stored data), who may change it,
 * the gate that stops tools which would run on the host, and the rule that a sandboxed session never runs anything on
 * the host: when no sandbox module is on, or it cannot start, each file and shell call of the session fails with the
 * reason. The sandbox itself (the VM, its files, its network, its lifecycle) is a module's (`extensions/gondolin.ts`)
 * and comes in through `host.sandbox.register`.
 */
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import { ExecutionError, FileError, type ExecutionEnv, err } from "@earendil-works/pi-durable/env";
import type { PocketApp } from "./app.ts";
import type { RemoteBrowser } from "./browser.ts";
import type { Role, User } from "./config.ts";
import { SandboxDoc, SubagentsDoc } from "./docs.ts";
import { LiveDoc } from "@earendil-works/pi-durable";
import { within } from "./confined.ts";
import { HttpError } from "./errors.ts";

const context = BACKGROUND_CONTEXT;

/** What a sandbox module needs to know to give a conversation its environment. */
export interface SandboxTarget {
    /** The conversation whose call this is: a session, or one of its subagents. */
    readonly conversationId: ConversationId;
    /** The session: one VM serves it and its subagents. */
    readonly rootId: ConversationId;
    /** The folder the session works in, as a path on this machine. */
    readonly cwd: string;
    /** The session's own upload folder, which the VM may read; undefined when it has none. */
    readonly uploadDir: string | undefined;
}

/**
 * Commands that run in the sandbox's VM and outlive the call that started them (the `background` tool of a sandboxed
 * session). Each method answers with the words Pi reads. They end with the VM: a restart of the server ends the VM, so
 * a task never resumes.
 */
export interface SandboxJobs {
    start(request: {
        command: string;
        key: string;
        notify?: boolean;
        quietMinutes?: number;
        /** The person Pi works for: a message about the task goes as their work. */
        requestedBy?: string;
    }): Promise<string>;
    output(id: string): Promise<string>;
    list(): Promise<string>;
    jobs(): Promise<string>;
    stop(id: string): Promise<string>;
}

export interface SandboxPerson {
    readonly id: string;
    readonly role: Role;
}

/** A browser in a VM: a Chromium that speaks the DevTools protocol over a pipe that only this server holds. */
export type SandboxBrowser = Pick<RemoteBrowser, "problem" | "launch">;

/** What a module gives core so that sessions can run in its sandbox. */
export interface SandboxProvider {
    /** Whether this person may choose a sandbox for a session (the owner always may turn it off if they chose it). */
    mayChoose(person: SandboxPerson): boolean;
    /** Whether new sessions start in the sandbox. */
    newSessions(): boolean;
    /** What the sandbox does with tools that run on the host: stop them (the default) or let them run. */
    hostTools(): "block" | "allow";
    /** Why a session cannot be put in the sandbox now (the host lacks something), or undefined when it can. */
    problem(): string | undefined;
    /** Why a folder may not be the working folder of a sandboxed session (it holds sign-ins or keys), or undefined. */
    folderProblem?(cwd: string): string | undefined;
    /** Whether a session that a sandboxed session starts may work in a folder other than its parent's. */
    otherFolders?(): boolean;
    /** The commands of this session that run in its VM. Without it, a sandboxed session has no background tasks. */
    jobs?(target: SandboxTarget): SandboxJobs;
    /** The environment of one conversation's tools. It starts the VM on first use and fails each call it cannot run. */
    env(target: SandboxTarget): ExecutionEnv;
    /**
     * The browser that runs in this conversation's VM, for the built-in browser to drive. Without it, a sandboxed
     * session has no browser: it never gets this machine's.
     */
    browser?(target: SandboxTarget): SandboxBrowser;
    /** A session's setting changed. Runs after the change is stored; it cannot stop it. */
    changed?(conversationId: ConversationId, on: boolean): void;
}

/** The tool that starts and messages linked sessions: it runs in the server, and core keeps its sessions in the sandbox. */
const TEAM = "team";

/** Tools that run through the execution environment, so they run in the VM. */
const ROUTED = new Set(["read", "write", "edit", "bash"]);

/**
 * Tools that touch only Pi Pocket's own state, or whose own calls pass this gate again (codemode's, a subagent's):
 * they may run in a sandboxed session. Any other tool counts as a host tool, so a new tool is stopped until it is
 * listed here.
 */
const INERT = new Set(["ask", "ui", "tool_search", "memory", "schedule", "subagent", "codemode"]);

export const SANDBOX_ROUTED_TOOLS: ReadonlySet<string> = ROUTED;
export const SANDBOX_INERT_TOOLS: ReadonlySet<string> = INERT;

/** Why this machine cannot run a sandbox, or undefined: the guarantee is kept only where it can be enforced. */
export function sandboxPlatformProblem(): string | undefined {
    return process.platform === "linux" ? undefined : "The sandbox runs on Linux only for now.";
}

/** The words that a call stopped by the gate gets. */
export function hostToolBlocked(tool: string): string {
    return `${tool} runs on the host, outside the sandbox, so this sandboxed session cannot use it. The owner can allow host tools in Menu → Extensions → Gondolin sandbox.`;
}

/** What an `ExecutionEnv` can be asked to do with files (everything else it has is `exec`, `cleanup`, `id`, and `cwd`). */
const FILE_CALLS = new Set([
    "absolutePath",
    "joinPath",
    "readTextFile",
    "openTextLineReader",
    "readTextLines",
    "readBinaryFile",
    "openBinaryReader",
    "writeFile",
    "appendFile",
    "truncateFile",
    "flushFile",
    "renameFile",
    "fileInfo",
    "listDir",
    "openDirReader",
    "watch",
    "canonicalPath",
    "exists",
    "createDir",
    "remove",
    "createTempDir",
    "createTempFile",
]);

/**
 * Whether a tool's arguments name a path anywhere: a `path` field at any depth (an artifact's own, an asset's) that is
 * not empty. A tool that reads a path reads it on the host.
 */
export function namesPath(args: unknown, depth = 0): boolean {
    if (depth > 8 || typeof args !== "object" || args === null) {
        return false;
    }

    for (const [key, value] of Object.entries(args)) {
        if (key === "path" && value !== undefined && value !== null && value !== "") {
            return true;
        }

        if (namesPath(value, depth + 1)) {
            return true;
        }
    }

    return false;
}

function canonical(path: string): string {
    try {
        return realpathSync(path);
    } catch {
        return resolve(path);
    }
}

/**
 * Why a folder may not be shared with a guest whatever the mode (even read only), or undefined when it may. The server
 * reloads its own code from the folders in `codeFolders`, and keeps its sign-ins and every session in the data folder:
 * a folder that is, holds, or lies in one of them would let the guest run code as the server, or read and change
 * what it keeps. Only the sessions' own worktrees (`worktrees/` of the data folder) are project folders.
 */
export function reloadedFolderProblem(
    path: string,
    codeFolders: readonly string[],
    dataDir: string,
): string | undefined {
    const target = canonical(path);
    const data = canonical(dataDir);
    const say = (what: string) =>
        `${path} is, holds, or lies in ${what}, which this server loads code from or keeps its data in: a sandbox cannot share it. Use a project folder somewhere else.`;

    for (const folder of codeFolders.map(canonical)) {
        if (within(folder, target) || within(target, folder)) {
            return say(folder);
        }
    }

    if (
        within(target, data) ||
        (within(data, target) && !within(join(data, "worktrees"), target))
    ) {
        return say(data);
    }

    return undefined;
}

/** The environment of a sandboxed session that cannot run anything: every call fails, and says why. */
export function failedEnv(cwd: string, message: string): ExecutionEnv {
    const file = () => Promise.resolve(err(new FileError("permission_denied", message)));
    const handlers: Record<string, unknown> = {
        id: "pocket-sandbox-unavailable",
        cwd,
        listFiles: undefined,
        cleanup: () => Promise.resolve(),
        exec: () => Promise.resolve(err(new ExecutionError("spawn_error", message))),
    };

    return new Proxy({} as ExecutionEnv, {
        // Only the calls of an environment: a `then` here would make the environment look like a promise that never ends.
        get: (_target, property) =>
            typeof property !== "string"
                ? undefined
                : Object.hasOwn(handlers, property)
                  ? handlers[property]
                  : FILE_CALLS.has(property)
                    ? file
                    : undefined,
    });
}

export class Sandboxes {
    readonly #app: PocketApp;
    /** Live registrations, newest last: the newest serves. A registration that ends leaves the list, whatever its order. */
    readonly #providers: { token: symbol; provider: SandboxProvider }[] = [];

    constructor(app: PocketApp) {
        this.#app = app;
    }

    /** Use `provider` for sandboxed sessions until the returned function is called. The last registration wins. */
    register(provider: SandboxProvider): () => void {
        const token = Symbol("sandbox");

        this.#providers.push({ token, provider });

        return () => {
            const at = this.#providers.findIndex((each) => each.token === token);

            if (at !== -1) {
                this.#providers.splice(at, 1);
            }
        };
    }

    get provider(): SandboxProvider | undefined {
        return this.#providers.at(-1)?.provider;
    }

    /** Why `cwd` may not be a sandbox's folder: the server's own (`reloadedFolderProblem`), or the module's. */
    #folderProblem(cwd: string): string | undefined {
        const app = this.#app;

        return (
            reloadedFolderProblem(cwd, app.codeFolders, app.dataDir) ??
            this.provider?.folderProblem?.(cwd)
        );
    }

    /**
     * Whether a sandboxed session uses `folder`, or a folder that holds it or lies in it: what a guest wrote can be
     * there. A folder shared by a sandboxed and an ordinary session counts, as the guest writes it all the same.
     */
    usesFolder(folder: string): boolean {
        const here = canonical(folder);

        for (const id of this.#on) {
            try {
                const used = canonical(this.#app.cwdOf(id as unknown as ConversationId));

                if (within(here, used) || within(used, here)) {
                    return true;
                }
            } catch {
                // A session that is gone uses no folder.
            }
        }

        return false;
    }

    /** Which conversations are sandboxed, kept in step with their documents: the browser asks without waiting. */
    readonly #on = new Set<number>();

    /** A conversation's setting is as stored now (`app.ts` calls this as documents commit). */
    noted(id: ConversationId, on: boolean): void {
        if (on) {
            this.#on.add(Number(id));
        } else {
            this.#on.delete(Number(id));
        }
    }

    /**
     * The browser of a sandboxed conversation, as `Browsers` asks for it: its sandbox's, or one that says there is
     * none. Undefined for a conversation that is not sandboxed, which uses this machine's browser.
     */
    browserFor(conversationId: number): RemoteBrowser | undefined {
        if (!this.#on.has(conversationId)) {
            return undefined;
        }

        const id = conversationId as unknown as ConversationId;
        const app = this.#app;
        const provider = this.provider;
        const root = Number(app.rootOf(id));
        const none = (problem: string): RemoteBrowser => ({
            key: `none:${root}`,
            problem: () => problem,
            launch: () => Promise.reject(new Error(problem)),
        });

        if (provider?.browser === undefined) {
            return none(
                "This session runs in a sandbox, and the sandbox has no browser (this machine's browser is never used for it).",
            );
        }

        const problem = this.#folderProblem(app.cwdOf(id));

        if (problem !== undefined) {
            return none(problem);
        }

        try {
            const browser = provider.browser({
                conversationId: id,
                rootId: app.rootOf(id),
                cwd: app.cwdOf(id),
                uploadDir: app.workspace.uploadDirectory(app.rootOf(id)),
            });

            return {
                key: `vm:${root}`,
                problem: () => browser.problem(),
                launch: (flags) => browser.launch(flags),
            };
        } catch (error) {
            return none(error instanceof Error ? error.message : String(error));
        }
    }

    /** Whether sessions start in the sandbox, as the module says; false without a module. */
    get newSessions(): boolean {
        try {
            return sandboxPlatformProblem() === undefined && this.provider?.newSessions() === true;
        } catch {
            return false;
        }
    }

    /** The environment for a sandboxed conversation: the module's, or one that fails every call with the reason. */
    env(id: ConversationId, cwd: string): ExecutionEnv {
        const app = this.#app;
        const provider = this.provider;

        if (app.workspaceScheme(cwd) !== undefined) {
            return failedEnv(cwd, "A sandbox does not support a remote workspace.");
        }

        if (provider === undefined) {
            return failedEnv(
                cwd,
                "This session runs in a sandbox, but the sandbox module is off, so nothing ran. Turn on Gondolin sandbox in Menu → Extensions, or ask the owner to turn the sandbox off for this session.",
            );
        }

        const problem = this.#folderProblem(cwd);

        if (problem !== undefined) {
            return failedEnv(
                cwd,
                `The sandbox cannot share this folder, so nothing ran: ${problem}`,
            );
        }

        try {
            return provider.env({
                conversationId: id,
                rootId: app.rootOf(id),
                cwd,
                uploadDir: app.workspace.uploadDirectory(app.rootOf(id)),
            });
        } catch (error) {
            return failedEnv(
                cwd,
                `The sandbox could not start, so nothing ran: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }

    /**
     * What runs on this machine for these conversations, in words: background tasks and `!` commands, and the file and
     * shell calls that are in the middle of a run. A call that began before the session was sandboxed ran on the host.
     */
    async #hostWork(conversations: readonly ConversationId[]): Promise<string[]> {
        const app = this.#app;
        const graph = await app.harness.watchTaskGraph(context);
        let nodes;

        try {
            nodes = Object.values(graph.value.tasks);
        } finally {
            await graph.stop();
        }

        const ours = new Set(conversations.map(Number));
        const found: string[] = [];

        for (const node of nodes) {
            if (!ours.has(Number(node.conversationId))) {
                continue;
            }

            const id = node.conversationId;

            if (node.kind === "pocket.shell") {
                found.push(`a ! command (${(await app.shell.describe(node.id)) ?? "a command"})`);
            } else if (node.kind === "pi.tool") {
                const name =
                    (await app.harness.snapshot(LiveDoc, id, context))?.tools?.find(
                        (each) => each.taskId === node.id,
                    )?.name ?? "a tool";

                if (name === "a tool" || ROUTED.has(name)) {
                    found.push(`a ${name} call that is running`);
                }
            }
        }

        // Background tasks come from their own records: a task counts while it runs, and after it ended when a process
        // of it (a daemon) still runs.
        for (const conversation of conversations) {
            for (const item of await app.background.list(conversation)) {
                if (
                    item.status === "starting" ||
                    item.status === "running" ||
                    (item.left?.length ?? 0) > 0
                ) {
                    found.push(
                        `a background task (${app.background.describe(conversation, item, 80)}${item.status === "starting" || item.status === "running" ? "" : ", which left a process running"})`,
                    );
                }
            }
        }

        return found;
    }

    /** Why a tool call of a sandboxed session may not run, or undefined when it may. */
    gate(tool: string, args: unknown, conversationId?: ConversationId): string | undefined {
        if (ROUTED.has(tool) || INERT.has(tool)) {
            return undefined;
        }

        // Linked sessions a sandboxed session starts inherit its sandbox, in its own folder (`linked-sessions.ts`).
        if (tool === TEAM) {
            return undefined;
        }

        // Background tasks of a sandboxed session run in its VM, or not at all: the tool never starts a host process.
        if (tool === "background") {
            return this.provider?.jobs === undefined
                ? `${hostToolBlocked(tool)} The sandbox module here cannot run background tasks in the VM.`
                : undefined;
        }

        // The browser tool drives the browser of the session's VM. This machine's browser is never used for a sandboxed
        // session, whatever the owner allows for host tools: its pages would run next to this machine's services.
        if (tool === "browser") {
            const remote =
                conversationId === undefined ? undefined : this.browserFor(Number(conversationId));

            return remote === undefined
                ? "The browser of this sandbox is not known here, so the browser did not run."
                : remote.problem();
        }

        // An artifact made from content stays in Pi Pocket; one that names a path (its own, or an asset's) reads a
        // file on the host.
        if (tool === "artifact" && !namesPath(args)) {
            return undefined;
        }

        let allow = false;

        try {
            allow = this.provider?.hostTools() === "allow";
        } catch {
            allow = false;
        }

        return allow ? undefined : hostToolBlocked(tool);
    }

    /**
     * The background tasks of a sandboxed session, in its VM. Undefined for a session that is not sandboxed (the tool
     * uses this machine, as always). A sandboxed session never gets this machine's: with no sandbox module, or one that
     * cannot run tasks, this throws.
     */
    async jobs(id: ConversationId): Promise<SandboxJobs | undefined> {
        if (!(await this.get(id)).on) {
            return undefined;
        }

        const app = this.#app;
        const provider = this.provider;

        if (provider?.jobs === undefined) {
            throw new HttpError(
                409,
                "This session runs in a sandbox, and the sandbox cannot run background tasks now, so nothing ran.",
            );
        }

        const cwd = app.cwdOf(id);

        if (app.workspaceScheme(cwd) !== undefined) {
            throw new HttpError(409, "A sandbox does not support a remote workspace.");
        }

        const problem = this.#folderProblem(cwd);

        if (problem !== undefined) {
            throw new HttpError(409, problem);
        }

        return provider.jobs({
            conversationId: id,
            rootId: app.rootOf(id),
            cwd,
            uploadDir: app.workspace.uploadDirectory(app.rootOf(id)),
        });
    }

    /**
     * Why a session that a session starts may not work in `cwd`, when the starter is sandboxed: the child runs in the
     * starter's sandbox, so its folder is the starter's own, unless the owner allowed others; and a folder that holds
     * sign-ins or keys never mounts. Undefined when it may.
     */
    async linkedFolder(source: ConversationId, cwd: string): Promise<string | undefined> {
        if (!(await this.get(source)).on) {
            return undefined;
        }

        const provider = this.provider;
        const own = this.#app.cwdOf(source);

        if (resolve(cwd) !== resolve(own) && provider?.otherFolders?.() !== true) {
            return `This session runs in a sandbox, so a linked session it starts works in its folder (${own}), not in ${cwd}. The owner can allow other folders in Menu → Extensions → Gondolin sandbox.`;
        }

        return this.#folderProblem(cwd);
    }

    /**
     * Whether a sandboxed session may message `target`: a session that also runs in a sandbox, or the one that started
     * it (a reply: its answer goes there anyway). A message to any other session would be work on this machine.
     */
    async mayMessage(source: ConversationId, target: ConversationId): Promise<boolean> {
        if (!(await this.get(source)).on) {
            return true;
        }

        return (
            (await this.get(target)).on ||
            this.#app.sessionMeta(source)?.linkedFrom?.id === Number(target)
        );
    }

    /** A session's setting, as stored. */
    async get(id: ConversationId): Promise<{ on: boolean; by?: string; at?: number }> {
        return {
            on: false,
            ...((await this.#app.harness.snapshot(SandboxDoc, id, context)) ?? {}),
        };
    }

    /**
     * Put a session in the sandbox, or take it out, for the session and the subagents under it. It acts for `user`,
     * who must see the session and be allowed to drive it. Turning it on needs the module, which says who may choose,
     * and a host that can run it. Taking it off needs the module's `mayChoose` too, except for the owner, who always
     * may; and nobody else takes away a sandbox the owner chose.
     */
    async set(id: ConversationId, person: SandboxPerson, on: unknown): Promise<void> {
        const app = this.#app;
        const user: User | undefined = app.config.userById(person.id);

        if (user === undefined) {
            throw new HttpError(403, "Only people of this server choose a sandbox.");
        }

        app.requireSee(user, id);
        await app.requireDriver(id, user);

        if (typeof on !== "boolean") {
            throw new HttpError(400, "on must be true or false");
        }

        if (app.parentOf(id) !== undefined) {
            throw new HttpError(
                400,
                "The sandbox is set for the whole session, in its main conversation.",
            );
        }

        const provider = this.provider;
        const owner = user.role === "owner";

        if (on) {
            const platform = sandboxPlatformProblem();

            if (platform !== undefined) {
                throw new HttpError(409, platform);
            }

            if (provider === undefined) {
                throw new HttpError(409, "The sandbox is turned off in Extensions.");
            }

            if (app.workspaceScheme(app.cwdOf(id)) !== undefined) {
                throw new HttpError(409, "A sandbox does not support a remote workspace.");
            }

            const folder = this.#folderProblem(app.cwdOf(id));

            if (folder !== undefined) {
                throw new HttpError(409, folder);
            }
        }

        if (!owner && provider?.mayChoose(user) !== true) {
            throw new HttpError(403, "Only the owner can choose the sandbox for a session.");
        }

        if (on) {
            const problem = provider?.problem();

            if (problem !== undefined) {
                throw new HttpError(409, problem);
            }
        }

        const touched: ConversationId[] = [];
        const before = new Map<ConversationId, { on: boolean; by?: string; at?: number }>();
        const changed = await app.harness.commit(async (tx) => {
            const current = await tx.doc(SandboxDoc, id);

            touched.length = 0;
            before.clear();

            if (current.on === on) {
                return false;
            }

            if (
                !on &&
                !owner &&
                current.by !== undefined &&
                app.config.userById(current.by)?.role === "owner"
            ) {
                throw new HttpError(
                    403,
                    "The owner chose this sandbox: only the owner can turn it off.",
                );
            }

            const conversations = [id];

            for (let index = 0; index < conversations.length; index++) {
                for (const agent of Object.values(
                    (await tx.doc(SubagentsDoc, conversations[index]!)).agents,
                )) {
                    conversations.push(agent.conversationId);
                }
            }

            const at = Date.now();

            for (const each of conversations) {
                const doc = await tx.doc(SandboxDoc, each);

                before.set(each, { ...doc });
                Object.assign(doc, { on, by: user.id, at });
            }

            touched.push(...conversations);

            return true;
        }, context);

        if (changed && on) {
            // Work that runs on this machine keeps running there. The setting is stored first: what starts from now on
            // is the VM's, so what is found now began before it, and the change is refused until it ends.
            const running = await this.#hostWork(touched);

            if (running.length > 0) {
                await app.harness.commit(async (tx) => {
                    for (const [each, was] of before) {
                        const doc = await tx.doc(SandboxDoc, each);

                        doc.on = was.on;

                        for (const key of ["by", "at"] as const) {
                            if (was[key] === undefined) {
                                delete doc[key];
                            } else {
                                Object.assign(doc, { [key]: was[key] });
                            }
                        }
                    }
                }, context);

                throw new HttpError(
                    409,
                    `This session still runs work on this machine: ${running.join("; ")}. A sandbox cannot take that work over, and it could go on running files that Pi now changes in the VM. Stop it, or wait until it ends, and then turn the sandbox on.`,
                );
            }
        }

        if (changed) {
            // Pages of this machine's browser end now, not when someone next looks: a sandboxed session has none of
            // its own (and the other way round: a page of the VM's browser ends when the sandbox goes off).
            await Promise.all(
                touched.map((each) => app.browsers.close(Number(each)).catch(() => undefined)),
            );

            try {
                provider?.changed?.(id, on);
            } catch (error) {
                this.#app.notice(
                    "warning",
                    `The sandbox module failed to note a change: ${error instanceof Error ? error.message : String(error)}`,
                    id,
                );
            }

            await app.collab.activity(
                id,
                user,
                on ? "turned on the sandbox" : "turned off the sandbox",
            );
        }
    }
}
