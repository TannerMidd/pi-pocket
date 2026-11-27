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
import { linkInto, within } from "./confined.ts";
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
    /** Whether the guest may write the session's folder: "ro" for read only. Without it, it may (core asks the worst). */
    mount?(): "rw" | "ro";
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
    /**
     * A session's sandbox is about to go: stop its VM and what runs in it, and finish when they are gone. The setting
     * stays on until this ends, and a failure keeps it on.
     */
    release?(conversationId: ConversationId): Promise<void>;
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

/** Why `platform` cannot run a sandbox, or undefined: the guarantee is kept only where it can be enforced. */
export function sandboxPlatformProblem(platform: string = process.platform): string | undefined {
    return platform === "linux" ? undefined : "The sandbox runs on Linux only for now.";
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

const waiting = (cwd: string) =>
    `The places that this server loads code from are being looked at for links into ${cwd}: try again in a moment.`;

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
    readonly #platform: string;
    readonly #kept = new Map<number, string>();
    /** Live registrations, newest last: the newest serves. A registration that ends leaves the list, whatever its order. */
    readonly #providers: { token: symbol; provider: SandboxProvider }[] = [];

    /** `platform` is the machine's (`process.platform`); only tests name another. */
    constructor(app: PocketApp, platform: string = process.platform) {
        this.#app = app;
        this.#platform = platform;
    }

    /**
     * A VM of the session may still run, though its provider could not close it. Until a provider's `release` of the
     * session succeeds, its sandbox stays on: with no provider to ask, turning it off is refused.
     */
    keepOn(id: ConversationId, reason: string): void {
        this.#kept.set(Number(id), reason);
    }

    /** Why this machine cannot run a sandbox, or undefined. */
    unsupported(): string | undefined {
        return sandboxPlatformProblem(this.#platform);
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

    /** Why `cwd` may not be a sandbox's folder: the server's own (`reloadedFolderProblem`), the module's, or a link. */
    #folderProblem(cwd: string): string | undefined {
        const app = this.#app;

        return (
            reloadedFolderProblem(cwd, app.codeFolders, app.dataDir) ??
            this.provider?.folderProblem?.(cwd) ??
            this.#trustedLink(cwd)
        );
    }

    /** What the look for links under the trusted folders found, by session folder, and when; and a look under way. */
    readonly #linked = new Map<
        string,
        { at: number; problem: string | undefined; looking?: Promise<string | undefined> }
    >();

    /**
     * Why a folder that the guest may write cannot be shared: a link under a place that the server or Pi loads code or
     * trusted settings from leads into it, or through it (`app.trustedFolders`), so a guest could change what runs
     * there; or those places could not all be looked at. A folder shared read only is not written. The look walks whole
     * trees, so it does not hold the server (`#look`): a call that needs the sandbox uses the last answer, and starts a
     * new look when that one is a minute old. With no answer yet it fails and says the look is under way: a look that is
     * not done is never counted as clean.
     */
    #trustedLink(cwd: string): string | undefined {
        if (this.provider?.mount?.() === "ro") {
            return undefined;
        }

        const known = this.#linked.get(cwd);

        if (known === undefined || Date.now() - known.at > 60_000) {
            void this.#look(cwd);
        }

        return known === undefined ? waiting(cwd) : known.problem;
    }

    /** Look for links into `cwd` under the trusted folders: one look at a time for a folder, and its answer is kept. */
    #look(cwd: string): Promise<string | undefined> {
        const known = this.#linked.get(cwd);

        if (known?.looking !== undefined) {
            return known.looking;
        }

        const looking = linkInto(this.#app.trustedFolders, cwd).then(
            (found) =>
                found === undefined
                    ? undefined
                    : "link" in found
                      ? `${found.link} reaches into ${cwd} (it lies there, or it is a link that leads there), and this server or Pi loads code or settings from it: a sandbox that can write the folder could change what runs on this machine. Remove the link, or choose Read only for the session's folder.`
                      : `The places that this server or Pi loads code or settings from could not all be looked at for links into ${cwd} (${found.unfinished}), so a sandbox that can write the folder is not allowed. Choose Read only for the session's folder.`,
            (error: unknown) =>
                `The places that this server or Pi loads code or settings from could not be looked at for links into ${cwd} (${error instanceof Error ? error.message : String(error)}), so a sandbox that can write the folder is not allowed.`,
        );

        // With no answer yet, the answer meanwhile is the refusal: a look that has not finished is never clean.
        this.#linked.set(cwd, {
            at: known?.at ?? 0,
            problem: known === undefined ? waiting(cwd) : known.problem,
            looking,
        });
        void looking.then((problem) => {
            this.#linked.set(cwd, { at: Date.now(), problem });
        });

        return looking;
    }

    /** A session and the subagents under it, to any depth, as `agentsOf` lists them. */
    async #tree(
        id: ConversationId,
        agentsOf: (
            conversation: ConversationId,
        ) => Promise<Record<string, { conversationId: ConversationId }> | undefined>,
    ): Promise<ConversationId[]> {
        const found = [id];

        for (let index = 0; index < found.length; index++) {
            for (const agent of Object.values((await agentsOf(found[index]!)) ?? {})) {
                found.push(agent.conversationId);
            }
        }

        return found;
    }

    /** The folders that sandboxed sessions work in, as stated. */
    folders(): string[] {
        const found: string[] = [];

        for (const id of this.#on) {
            try {
                found.push(this.#app.cwdOf(id as unknown as ConversationId));
            } catch {
                // A session that is gone works in no folder.
            }
        }

        return found;
    }

    /** What runs for a session outside a tool call and may run on this machine (a goal's check), until it ends. */
    readonly #running = new Set<{ root: number; what: string }>();

    /**
     * Run `work`, which executes for the session and is not a tool call, as a tool call runs: it waits for a change of
     * the session's sandbox, and while it runs a turn-on is refused (`#hostWork` names it). `work` finds its
     * environment inside, so that it is the one the setting gives after the change.
     */
    async tracked<T>(id: ConversationId, what: string, work: () => Promise<T>): Promise<T> {
        const root = Number(this.#app.rootOf(id));

        do {
            await this.settled(id);
        } while (this.#changes.has(root));

        const mine = { root, what };

        this.#running.add(mine);

        try {
            return await work();
        } finally {
            this.#running.delete(mine);
        }
    }

    /** The change of each session's sandbox that is under way, by the session's number. */
    readonly #changes = new Map<number, Promise<void>>();

    /** Which conversations are sandboxed, kept in step with their documents: the browser asks without waiting. */
    readonly #on = new Set<number>();

    /** A conversation's setting is as stored now (`app.ts` calls this as documents commit). */
    noted(id: ConversationId, on: boolean): void {
        if (on) {
            this.#on.add(Number(id));

            // A session that was sandboxed before this start: its folder is looked at now, not at its first call.
            try {
                void this.#look(this.#app.cwdOf(id));
            } catch {
                // Not known yet: the first call looks.
            }
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
                // A launch starts the VM when there is none, so it is one more way to run work for the session: it waits
                // for a change of the sandbox, and refuses when the change turned the sandbox off.
                launch: (flags) =>
                    this.tracked(id, "a browser launch", async () => {
                        if (!this.#on.has(conversationId)) {
                            throw new Error(
                                "This session's sandbox was turned off, so its browser did not start.",
                            );
                        }

                        // What was asked when the launcher was made may have changed (the look for links ended).
                        const problem = this.#folderProblem(app.cwdOf(id));

                        if (problem !== undefined) {
                            throw new Error(problem);
                        }

                        return browser.launch(flags);
                    }),
            };
        } catch (error) {
            return none(error instanceof Error ? error.message : String(error));
        }
    }

    /** Whether sessions start in the sandbox, as the module says; false without a module. */
    get newSessions(): boolean {
        try {
            return this.unsupported() === undefined && this.provider?.newSessions() === true;
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
            const env = provider.env({
                conversationId: id,
                rootId: app.rootOf(id),
                cwd,
                uploadDir: app.workspace.uploadDirectory(app.rootOf(id)),
            });

            // Each call asks again before it can start the VM: what was clean when the environment was made may not be.
            return new Proxy(env, {
                get: (target, property) => {
                    const value: unknown = Reflect.get(target, property, target);

                    if (typeof value !== "function" || typeof property !== "string") {
                        return value;
                    }

                    return (...args: unknown[]) => {
                        const now = this.#folderProblem(cwd);

                        return now === undefined
                            ? (value as (...call: unknown[]) => unknown).apply(target, args)
                            : (
                                  Reflect.get(
                                      failedEnv(
                                          cwd,
                                          `The sandbox cannot share this folder, so nothing ran: ${now}`,
                                      ),
                                      property,
                                  ) as ((...call: unknown[]) => unknown) | undefined
                              )?.(...args);
                    };
                },
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

                // Any call but the ones that touch only Pi Pocket's own state may be running on this machine: not
                // only `bash` and the file tools, but `background`, which has not made its record yet, `browser`, and
                // the rest. One that begins from now on waits for this change (`settled`).
                if (!INERT.has(name)) {
                    found.push(`a ${name} call that is running`);
                }
            }
        }

        for (const { root, what } of this.#running) {
            if (ours.has(root)) {
                found.push(`${what} that is running`);
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
        await this.settled(id);

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

        const jobs = provider.jobs({
            conversationId: id,
            rootId: app.rootOf(id),
            cwd,
            uploadDir: app.workspace.uploadDirectory(app.rootOf(id)),
        });

        return {
            ...jobs,
            start: async (request) => {
                const now = this.#folderProblem(cwd);

                if (now !== undefined) {
                    throw new HttpError(409, now);
                }

                return jobs.start(request);
            },
        };
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

        return (
            reloadedFolderProblem(cwd, this.#app.codeFolders, this.#app.dataDir) ??
            provider?.folderProblem?.(cwd) ??
            (provider?.mount?.() === "ro" ? undefined : await this.#checked(cwd))
        );
    }

    /** The answer of the last look for links into `cwd`, or of a new one when there is none or it is old. */
    async #checked(cwd: string): Promise<string | undefined> {
        const known = this.#linked.get(cwd);

        return known !== undefined && known.looking === undefined && Date.now() - known.at <= 60_000
            ? known.problem
            : this.#look(cwd);
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
            const platform = this.unsupported();

            if (platform !== undefined) {
                throw new HttpError(409, platform);
            }

            if (provider === undefined) {
                throw new HttpError(409, "The sandbox is turned off in Extensions.");
            }

            if (app.workspaceScheme(app.cwdOf(id)) !== undefined) {
                throw new HttpError(409, "A sandbox does not support a remote workspace.");
            }

            const cwd = app.cwdOf(id);
            const folder =
                reloadedFolderProblem(cwd, app.codeFolders, app.dataDir) ??
                provider.folderProblem?.(cwd) ??
                (provider.mount?.() === "ro" ? undefined : await this.#look(cwd));

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

        // One change of a session's sandbox at a time, and no tool call runs while it does (`settled`): what starts
        // after it sees the setting that it leaves.
        const root = Number(id);
        const run = (this.#changes.get(root) ?? Promise.resolve())
            .catch(() => undefined)
            .then(() => this.#change(id, user, on));

        this.#changes.set(root, run);

        try {
            await run;
        } finally {
            if (this.#changes.get(root) === run) {
                this.#changes.delete(root);
            }
        }
    }

    /** Resolves when no change of the sandbox of this conversation's session is under way. Tool calls wait here. */
    async settled(id: ConversationId): Promise<void> {
        const root = Number(this.#app.rootOf(id));

        for (
            let under = this.#changes.get(root);
            under !== undefined;
            under = this.#changes.get(root)
        ) {
            await under.catch(() => undefined);
        }

        // A sandboxed session's first look at the trusted places is waited for here: its calls then find the answer.
        if (this.#on.has(Number(id))) {
            try {
                const cwd = this.#app.cwdOf(id);

                await (this.#linked.get(cwd)?.looking ??
                    (this.#linked.has(cwd) ? undefined : this.#look(cwd)));
            } catch {
                // A session that is gone has nothing to look at.
            }
        }
    }

    /**
     * The change itself. Turning on: what runs on this machine is looked for first, and the setting is stored only
     * when none does, so that no VM exists for a setting that was not kept. Turning off: the VM is stopped, and gone,
     * before the setting is stored: the folder stays confined until nothing can write it.
     */
    async #change(id: ConversationId, user: User, on: boolean): Promise<void> {
        const app = this.#app;
        const provider = this.provider;
        const current = await this.get(id);

        if (current.on === on) {
            return;
        }

        if (
            !on &&
            user.role !== "owner" &&
            current.by !== undefined &&
            app.config.userById(current.by)?.role === "owner"
        ) {
            throw new HttpError(
                403,
                "The owner chose this sandbox: only the owner can turn it off.",
            );
        }

        const looked = await this.#tree(
            id,
            async (each) => (await app.harness.snapshot(SubagentsDoc, each, context))?.agents,
        );

        if (on) {
            const running = await this.#hostWork(looked);

            if (running.length > 0) {
                throw new HttpError(
                    409,
                    `This session still runs work on this machine: ${running.join("; ")}. A sandbox cannot take that work over, and it could go on running files that Pi now changes in the VM. Stop it, or wait until it ends, and then turn the sandbox on.`,
                );
            }
        } else {
            const kept = this.#kept.get(Number(id));

            if (provider === undefined && kept !== undefined) {
                throw new HttpError(
                    409,
                    `The sandbox could not be stopped, so it stays on: ${kept}`,
                );
            }

            try {
                await provider?.release?.(id);
                this.#kept.delete(Number(id));
            } catch (error) {
                throw new HttpError(
                    409,
                    `The sandbox could not be stopped, so it stays on: ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        }

        // The subagents are found in the commit that changes them: one that is being started has its own commit, which
        // copies the setting it reads, so it is in this list or it copies the new setting.
        const conversations = await app.harness.commit(async (tx) => {
            const tree = await this.#tree(
                id,
                async (each) => (await tx.doc(SubagentsDoc, each)).agents,
            );
            const at = Date.now();

            for (const each of tree) {
                Object.assign(await tx.doc(SandboxDoc, each), { on, by: user.id, at });
            }

            return tree;
        }, context);

        // Pages of this machine's browser end now, not when someone next looks: a sandboxed session has none of its
        // own (and the other way round: a page of the VM's browser ends when the sandbox goes off).
        await Promise.all(
            conversations.map((each) => app.browsers.close(Number(each)).catch(() => undefined)),
        );

        try {
            provider?.changed?.(id, on);
        } catch (error) {
            app.notice(
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
