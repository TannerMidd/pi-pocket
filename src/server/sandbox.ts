/**
 * Sandboxed sessions: a session whose file and shell tools run in a micro-VM instead of on this machine.
 *
 * Core keeps what an extension cannot keep safe: the session's setting (`SandboxDoc`, stored data), who may change it,
 * the gate that stops tools which would run on the host, and the rule that a sandboxed session never runs anything on
 * the host: when no sandbox module is on, or it cannot start, each file and shell call of the session fails with the
 * reason. The sandbox itself (the VM, its files, its network, its lifecycle) is a module's (`extensions/gondolin.ts`)
 * and comes in through `host.sandbox.register`.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import { ExecutionError, FileError, type ExecutionEnv, err } from "@earendil-works/pi-durable/env";
import type { PocketApp } from "./app.ts";
import type { RemoteBrowser } from "./browser.ts";
import type { Role, User } from "./config.ts";
import { SandboxDoc, SubagentsDoc } from "./docs.ts";
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
    #provider: { token: symbol; provider: SandboxProvider } | undefined;

    constructor(app: PocketApp) {
        this.#app = app;
    }

    /** Use `provider` for sandboxed sessions until the returned function is called. The last registration wins. */
    register(provider: SandboxProvider): () => void {
        const token = Symbol("sandbox");
        const previous = this.#provider;

        this.#provider = { token, provider };

        return () => {
            if (this.#provider?.token === token) {
                this.#provider = previous?.token === token ? undefined : previous;
            }
        };
    }

    get provider(): SandboxProvider | undefined {
        return this.#provider?.provider;
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
        const provider = this.#provider?.provider;
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
            return this.#provider?.provider.newSessions() === true;
        } catch {
            return false;
        }
    }

    /** The environment for a sandboxed conversation: the module's, or one that fails every call with the reason. */
    env(id: ConversationId, cwd: string): ExecutionEnv {
        const app = this.#app;
        const provider = this.#provider?.provider;

        if (app.workspaceScheme(cwd) !== undefined) {
            return failedEnv(cwd, "A sandbox does not support a remote workspace.");
        }

        if (provider === undefined) {
            return failedEnv(
                cwd,
                "This session runs in a sandbox, but the sandbox module is off, so nothing ran. Turn on Gondolin sandbox in Menu → Extensions, or ask the owner to turn the sandbox off for this session.",
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

    /** Why a tool call of a sandboxed session may not run, or undefined when it may. */
    gate(tool: string, args: unknown, conversationId?: ConversationId): string | undefined {
        if (ROUTED.has(tool) || INERT.has(tool)) {
            return undefined;
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

        // An artifact made from content stays in Pi Pocket; one made from a path reads a file on the host.
        if (tool === "artifact") {
            const path = (args as { path?: unknown } | null)?.path;

            if (path === undefined || path === null || path === "") {
                return undefined;
            }
        }

        let allow = false;

        try {
            allow = this.#provider?.provider.hostTools() === "allow";
        } catch {
            allow = false;
        }

        return allow ? undefined : hostToolBlocked(tool);
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

        const provider = this.#provider?.provider;
        const owner = user.role === "owner";

        if (on) {
            if (provider === undefined) {
                throw new HttpError(409, "The sandbox is turned off in Extensions.");
            }

            if (app.workspaceScheme(app.cwdOf(id)) !== undefined) {
                throw new HttpError(409, "A sandbox does not support a remote workspace.");
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

        const changed = await app.harness.commit(async (tx) => {
            const current = await tx.doc(SandboxDoc, id);

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
                Object.assign(await tx.doc(SandboxDoc, each), { on, by: user.id, at });
            }

            return true;
        }, context);

        if (changed) {
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
