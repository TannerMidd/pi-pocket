/**
 * The runner, not the server, authorizes every pi-env request before the daemon sees it (`docs/runners.md`).
 *
 * A server that negotiated approvals (`welcome.approvals`) names the session of each request in `SESSION_FIELD`, which
 * is removed here. Without a valid session permission, only `hello` and folder listing (`lstat`, `realpath`,
 * `opendir`, and `readdir` and `close` on a listed folder) pass. Every other request needs a valid permission for the
 * session it names, and each path it carries must be in that permission's folder or below it, or in the runner's own
 * folders for attached files and browser downloads. Pi's context files above the folder and its skills there and in
 * the home folder can also be read (`piReads`). An expired permission makes the request wait while the computer
 * asks again.
 */
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { folderContains, realFolder } from "./folders.ts";
import type { Approvals, SessionScope } from "./approvals.ts";
import { FRAME, frame, readFrame, SESSION_FIELD } from "./protocol.ts";

type Request = {
    scope?: SessionScope;
    op: string;
    path?: string;
    directory: boolean;
    stop: AbortController;
    sent: boolean;
    finish?: () => void;
    /** For `close`: the handle it closes. pi-env's answer is `{}`, so it is known only from the request. */
    handle?: number;
};

type Handle = { scope?: SessionScope; path: string; directory: boolean; readOnly: boolean };

/**
 * Every request pi-env 1.5.0's client sends (protocol 1). Anything else is refused, so an op a later pi-env adds, with
 * a path in a field this gate does not read, cannot pass its folder check unseen.
 */
const KNOWN_OPS = new Set([
    "hello",
    "lstat",
    "realpath",
    "write",
    "writeChunk",
    "truncate",
    "fsync",
    "rename",
    "mkdir",
    "rm",
    "mkdtemp",
    "open",
    "pread",
    "fstat",
    "scanLines",
    "opendir",
    "readdir",
    "close",
    "listFiles",
    "exec",
    "watch",
    "pty",
    "ptyWrite",
    "ptyResize",
    "ptyForeground",
]);

/** What works without a session permission: the folder picker's listing. */
const LISTING = new Set(["hello", "lstat", "realpath", "opendir"]);

/** What only reads a file opened with `open`. */
const READING = new Set(["pread", "fstat", "scanLines", "close"]);

/** Pi's context files, as `remote-context.ts` on the server looks for them. */
const CONTEXT_FILES = new Set([
    "AGENTS.override.md",
    "AGENTS.md",
    "AGENTS.MD",
    "CLAUDE.md",
    "CLAUDE.MD",
]);

/**
 * What Pi reads for a session besides its folder: the context files in the folders above it, the `.agents/skills/`
 * folders there, and the skills in the home folder. A session may read these, never change them. Its commands could
 * read them anyway.
 */
function piReads(folder: string, home: string, path: string): boolean {
    const skills = [join(home, ".pi", "agent", "skills"), join(home, ".agents", "skills")];
    const parent = dirname(path);

    for (let current = folder; ; current = dirname(current)) {
        if (
            CONTEXT_FILES.has(basename(path)) &&
            folderContains(current, parent) &&
            folderContains(parent, current)
        ) {
            return true;
        }

        skills.push(join(current, ".agents", "skills"));

        if (dirname(current) === current) {
            break;
        }
    }

    return skills.some((root) => folderContains(root, path));
}

/** Resolve existing ancestors too: a missing child behind an outside symlink must not pass the path check. */
export async function canonical(path: string): Promise<string> {
    let at = resolve(path);
    const tail: string[] = [];

    for (;;) {
        try {
            return join(await realpath(at), ...tail);
        } catch (error) {
            const parent = dirname(at);
            const code = (error as NodeJS.ErrnoException).code ?? "";

            if (parent === at || !["ENOENT", "ENOTDIR"].includes(code)) {
                throw error;
            }

            tail.unshift(at.slice(parent.length).replace(/^[/\\]/, ""));
            at = parent;
        }
    }
}

/** A session scope as the server sends it; undefined when it is not one. */
/** One session's requests that wait for their check, and the question that asks for all of them. */
type Waiting = { requests: Set<Request>; question?: AbortController };

/**
 * A signal that aborts when every request of the session that waits was cancelled, also one that came later. A
 * session's question asks for all of them, so a cancelled one does not end it while another one still waits.
 */
function whileWaiting(waiting: Waiting): AbortSignal {
    const question = new AbortController();

    waiting.question = question;
    cancelled(waiting);

    return question.signal;
}

function cancelled(waiting: Waiting): void {
    if ([...waiting.requests].every((request) => request.stop.signal.aborted)) {
        waiting.question?.abort();
    }
}

/**
 * A permission id the server makes: a UUID, or a session number for a session from before UUIDs. It names folders on
 * this computer (`<temp>/pi-pocket-tasks/<id>`, `<downloads>/<id>`), so nothing else is taken: not `.ssh`, not `..`.
 */
export function permissionId(id: unknown): id is string {
    return (
        typeof id === "string" &&
        (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ||
            /^[1-9][0-9]{0,15}$/.test(id))
    );
}

export function sessionScope(value: unknown): SessionScope | undefined {
    if (typeof value !== "object" || value === null) {
        return undefined;
    }

    const scope = value as Record<string, unknown>;

    return permissionId(scope.id) &&
        typeof scope.folder === "string" &&
        isAbsolute(scope.folder) &&
        typeof scope.person === "string"
        ? (scope as SessionScope)
        : undefined;
}

export type GateOptions = {
    approvals: Approvals;
    /** Ask the computer again for a session without a valid permission; true when it was approved. */
    ask: (scope: SessionScope, signal: AbortSignal) => Promise<boolean>;
    /** Whole frames to the daemon. */
    send: (bytes: Buffer) => void;
    /** Whole frames back to the server, as if the daemon sent them. */
    reply: (bytes: Buffer) => void;
    /** The runner's own folders for session `id` (its permission): its attached files and browser downloads. */
    shared: (id: string) => Promise<string[]>;
    /** The real temporary folder, where `mkdtemp` may make a folder for a session. */
    tmpdir: () => Promise<string>;
    /** The computer's name, for refusals. */
    name: () => string;
    /** A request of a session in `folder` reaches the daemon; the result is called when it ended (`activity.ts`). */
    working?: (folder: string) => () => void;
};

export class RequestGate {
    readonly #options: GateOptions;
    readonly #requests = new Map<number, Request>();
    readonly #handles = new Map<number, Handle>();
    readonly #queues = new Map<string, Promise<void>>();
    /** Each session's requests that wait for their check: its question stands while one of them still waits. */
    readonly #waiting = new Map<string, Waiting>();
    /** The folders `mkdtemp` made for each session: codemode's work folders and temporary files. */
    readonly #temporary = new Map<string, Set<string>>();
    /** Exact real files, never folders, bound to this generation of a session's permission. */
    readonly #extraReads = new Map<string, { approvedAt: number; files: Map<string, number> }>();

    constructor(options: GateOptions) {
        this.#options = options;
    }

    /** Allow one listed Pi file for at most 5 minutes, only with the still-valid session permission. */
    async allowRead(session: string, path: string): Promise<void> {
        const permission = await this.#options.approvals.valid(session);

        if (permission === undefined) {
            throw new Error(`Session not approved on ${this.#options.name()}`);
        }

        const real = await realpath(path);
        const previous = this.#extraReads.get(session);
        const grant =
            previous?.approvedAt === permission.approvedAt
                ? previous
                : { approvedAt: permission.approvedAt, files: new Map<string, number>() };
        const until = Date.now() + 5 * 60_000;

        grant.files.set(real, until);
        this.#extraReads.set(session, grant);
        setTimeout(() => {
            if (grant.files.get(real) === until) {
                grant.files.delete(real);
            }

            if (grant.files.size === 0 && this.#extraReads.get(session) === grant) {
                this.#extraReads.delete(session);
            }
        }, 5 * 60_000).unref();
    }

    revokeReads(session: string): void {
        if (session === "all") {
            this.#extraReads.clear();
        } else {
            this.#extraReads.delete(session);
        }
    }

    /** A control request uses the same live permission and canonical path check as an exec request, without asking. */
    async task(id: string, cwd?: string): Promise<() => void> {
        const permission = await this.#options.approvals.valid(id);

        if (permission === undefined) {
            throw new Error(`Session not approved on ${this.#options.name()}`);
        }

        const paths = await this.#paths(cwd === undefined ? {} : { cwd }, undefined);

        if (!(await this.#inside(id, permission.folder, paths))) {
            throw new Error(
                `The path is outside the session's approved folder on ${this.#options.name()}`,
            );
        }

        const used = this.#options.approvals.begin(id);
        const working = this.#options.working?.(permission.folder);

        return () => {
            used();
            working?.();
        };
    }

    /** The daemon stopped, or the runner: what waits is dropped, and use ends. */
    stop(): void {
        for (const request of this.#requests.values()) {
            request.stop.abort();
            request.finish?.();
        }

        this.#requests.clear();
        this.#handles.clear();
        this.#temporary.clear();
        this.#extraReads.clear();
    }

    /** A whole frame from the server. Throws for a frame the protocol does not allow. */
    input(whole: Buffer): void {
        const { type, id, json, payload } = readFrame(whole);

        if (type === FRAME.ping) {
            return;
        }

        if (type === FRAME.cancel) {
            const request = this.#requests.get(id);
            // The session that sent the request cancels it; pi-env's client sends its own session with each frame.
            const from = sessionScope(json[SESSION_FIELD]);

            delete json[SESSION_FIELD];

            if (request !== undefined && from?.id === request.scope?.id) {
                request.stop.abort();

                if (request.sent) {
                    this.#options.send(frame(FRAME.cancel, id, json));
                } else {
                    // Not at the daemon yet: it ends now. Its session's question stays while another request waits.
                    this.#refuse(id, request, "The request was cancelled");
                }
            }

            return;
        }

        if (type !== FRAME.request || this.#requests.has(id)) {
            throw new Error("Invalid request frame");
        }

        const named = sessionScope(json[SESSION_FIELD]);
        const op = String(json.op);
        const request: Request = {
            ...(named === undefined ? {} : { scope: named }),
            op,
            directory: op === "opendir",
            stop: new AbortController(),
            sent: false,
            ...(op === "close" && typeof json.handle === "number" ? { handle: json.handle } : {}),
        };

        delete json[SESSION_FIELD];
        this.#requests.set(id, request);

        // One session's requests wait in order, so a question for it holds them all, and other sessions go on.
        const key = request.scope?.id ?? "";
        const waiting = this.#waiting.get(key) ?? { requests: new Set<Request>() };

        waiting.requests.add(request);
        this.#waiting.set(key, waiting);
        request.stop.signal.addEventListener("abort", () => cancelled(waiting), { once: true });

        const queued = (this.#queues.get(key) ?? Promise.resolve()).then(async () => {
            try {
                if (request.stop.signal.aborted) {
                    throw new Error("The request was cancelled");
                }

                await this.#authorize(request, json, waiting);

                if (request.stop.signal.aborted) {
                    throw new Error("The request was cancelled");
                }

                request.sent = true;
                waiting.requests.delete(request);
                this.#options.send(frame(type, id, json, payload));
            } catch (error) {
                waiting.requests.delete(request);
                this.#refuse(id, request, (error as Error).message);
            }
        });

        this.#queues.set(key, queued);
        void queued.finally(() => {
            if (this.#queues.get(key) === queued) {
                this.#queues.delete(key);
            }

            if (waiting.requests.size === 0 && this.#waiting.get(key) === waiting) {
                this.#waiting.delete(key);
            }
        });
    }

    /** Answer a request that does not reach the daemon, once. */
    #refuse(id: number, request: Request, message: string): void {
        if (this.#requests.get(id) === request) {
            this.#requests.delete(id);
            request.finish?.();
            this.#options.reply(frame(FRAME.error, id, { code: "EACCES", message }));
        }
    }

    /** Check a request; on success, it counts as use of its session until its result. */
    async #authorize(
        request: Request,
        json: Record<string, unknown>,
        waiting: Waiting,
    ): Promise<void> {
        if (!KNOWN_OPS.has(request.op)) {
            throw new Error(
                `The runner on ${this.#options.name()} does not know the request "${request.op}"`,
            );
        }

        const handle = typeof json.handle === "number" ? this.#handles.get(json.handle) : undefined;
        const listing =
            LISTING.has(request.op) ||
            (["readdir", "close"].includes(request.op) && handle?.directory === true);

        if (typeof json.path === "string" && isAbsolute(json.path)) {
            const path = json.path;

            // A folder the picker cannot resolve still lists as the daemon decides.
            request.path = await canonical(path).catch(() => resolve(path));
        }

        if (listing) {
            return;
        }

        const paths = await this.#paths(json, handle);
        const scope = request.scope;

        if (scope === undefined) {
            throw new Error(`A session permission on ${this.#options.name()} is required`);
        }

        let permission = await this.#options.approvals.valid(scope);

        if (permission === undefined && !request.stop.signal.aborted) {
            this.revokeReads(scope.id);

            // Expired, revoked, or never approved: ask again, and wait.
            if (await this.#options.ask(scope, whileWaiting(waiting))) {
                permission = await this.#options.approvals.valid(scope);
            }
        }

        if (permission === undefined) {
            throw new Error(`Session not approved on ${this.#options.name()}`);
        }

        // A command runs in a folder of its session: with none named, its approved folder (inside by definition),
        // never the runner's own.
        if ((request.op === "exec" || request.op === "pty") && typeof json.cwd !== "string") {
            json.cwd = permission.folder;
        }

        if (
            typeof json.handle === "number" &&
            (handle === undefined || handle.scope?.id !== scope.id)
        ) {
            throw new Error("The handle belongs to another session");
        }

        if (typeof json.target === "number") {
            const target = this.#requests.get(json.target);

            if (target?.scope?.id !== scope.id) {
                throw new Error("The request belongs to another session");
            }
        }

        // A new temporary folder: in the temporary folder itself, and from then on the session's own.
        const temporary =
            request.op === "mkdtemp" &&
            paths.length === 1 &&
            dirname(paths[0]!) === (await this.#options.tmpdir());

        // Pi's context files and skills: read only, in a file opened to read.
        const reading =
            request.op === "open" || (handle?.readOnly === true && READING.has(request.op));
        const home = reading ? await realFolder(homedir()) : "";
        const extra = this.#extraReads.get(scope.id);

        if (extra !== undefined && extra.approvedAt !== permission.approvedAt) {
            this.revokeReads(scope.id);
        }

        const extraReading =
            reading &&
            extra?.approvedAt === permission.approvedAt &&
            paths.length > 0 &&
            paths.every((path) => (extra.files.get(path) ?? 0) > Date.now());

        if (
            !temporary &&
            !(await this.#inside(scope.id, permission.folder, paths)) &&
            !(reading && paths.every((path) => piReads(permission.folder, home, path))) &&
            !extraReading
        ) {
            throw new Error(
                `The path is outside the session's approved folder on ${this.#options.name()}`,
            );
        }

        if (request.op !== "watch") {
            const used = this.#options.approvals.begin(scope.id);
            const working = this.#options.working?.(permission.folder);

            request.finish = () => {
                used();
                working?.();
            };
        }
    }

    /** Each path a request names, made absolute and real. A relative or non-text path is refused. */
    async #paths(json: Record<string, unknown>, handle: Handle | undefined): Promise<string[]> {
        const given: unknown[] = [json.path, json.cwd, json.to];

        if (Array.isArray(json.targets)) {
            for (const target of json.targets) {
                given.push((target as { path?: unknown } | null)?.path);
            }
        }

        const paths = handle === undefined ? [] : [handle.path];

        for (const path of given) {
            if (path === undefined) {
                continue;
            }

            if (typeof path !== "string" || !isAbsolute(path)) {
                throw new Error("A request path must be absolute");
            }

            paths.push(await canonical(path));
        }

        return paths;
    }

    async #inside(session: string, folder: string, paths: readonly string[]): Promise<boolean> {
        const shared = [
            ...(await this.#options.shared(session)),
            ...(this.#temporary.get(session) ?? []),
        ];

        return paths.every(
            (path) =>
                folderContains(folder, path) || shared.some((root) => folderContains(root, path)),
        );
    }

    /** A whole frame from the daemon: results end their request's use and keep their handle's session. */
    output(whole: Buffer): void {
        const { type, id, json } = readFrame(whole);
        const request = this.#requests.get(id);

        if (request === undefined || (type !== FRAME.result && type !== FRAME.error)) {
            return;
        }

        if (
            type === FRAME.result &&
            typeof json.handle === "number" &&
            request.path !== undefined
        ) {
            this.#handles.set(json.handle, {
                ...(request.scope === undefined ? {} : { scope: request.scope }),
                path: request.path,
                directory: request.directory,
                readOnly: request.op === "open",
            });
        }

        if (
            type === FRAME.result &&
            request.op === "mkdtemp" &&
            request.scope !== undefined &&
            typeof json.path === "string" &&
            request.path !== undefined
        ) {
            const made = this.#temporary.get(request.scope.id) ?? new Set<string>();

            // Its real path: the asked one, resolved, with the name the daemon chose.
            made.add(join(dirname(request.path), basename(json.path)));
            this.#temporary.set(request.scope.id, made);
        }

        if (request.handle !== undefined) {
            this.#handles.delete(request.handle);
        }

        request.finish?.();
        this.#requests.delete(id);
    }
}
