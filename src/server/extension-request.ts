/** Request-lifetime document access and conversation authorization for extension routes. */
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { AgentState, ConversationId, DocumentReader, Tx } from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import type { User } from "./config.ts";
import { TurnsDoc } from "./docs.ts";
import { HttpError } from "./errors.ts";
import { mayUse } from "./extension-web.ts";
import type { WebAccess, WebRequest } from "./host.ts";

/** Internal only: no extension can select an actor through the public host. */
export interface RequestActor {
    readonly context: Context;
    current(): User;
    checkSource(agent: AgentState): void;
    authorize(tx: Tx, mutation: boolean): Promise<User>;
}

export class ExtensionRequest implements RequestActor {
    readonly context: Context;
    readonly #stopped = new AbortController();
    readonly #app: PocketApp;
    readonly #by: string;
    readonly #access: WebAccess;
    readonly #source?: ConversationId;
    #settings: string | undefined;

    constructor(app: PocketApp, by: string, access: WebAccess, source?: ConversationId) {
        this.#app = app;
        this.#by = by;
        this.#access = access;
        this.#source = source;
        this.context = withAbortSignal(this.#stopped.signal, BACKGROUND_CONTEXT);
    }

    get signal(): AbortSignal {
        return this.#stopped.signal;
    }

    async createSession(request: { cwd: string; title?: string }): Promise<{ id: number }> {
        if (this.#access !== "owner" || this.current().role !== "owner") {
            throw new HttpError(403, "Only the owner can start an app-wide session here.");
        }

        if (typeof request?.cwd !== "string" || request.cwd.trim() === "") {
            throw new HttpError(400, "A workspace URI or folder path is required.");
        }

        await this.#app.harness.commit((tx) => this.authorize(tx, true), this.context);
        const cwd = await this.#app.resolveCwd(request.cwd, this.signal);
        const user = await this.#app.harness.commit((tx) => this.authorize(tx, true), this.context);

        return this.#app.commands.createSession(
            user,
            { cwd, ...(request.title === undefined ? {} : { title: request.title }) },
            { actor: this, resolvedCwd: cwd },
        );
    }

    close = (): void => {
        this.#stopped.abort(new HttpError(409, "This extension request has ended."));
    };

    current(): User {
        this.signal.throwIfAborted();

        const user = this.#app.config.userById(this.#by);

        if (user === undefined || !mayUse(user, this.#access)) {
            throw new HttpError(403, "You no longer have access to this extension route.");
        }

        if (this.#source !== undefined) {
            const meta = this.#app.sessionMeta(this.#source);

            if (meta === undefined || meta.pip !== undefined) {
                throw new HttpError(404, "No such source conversation.");
            }

            this.#app.requireSee(user, this.#source);
        }

        return user;
    }

    bindSource(agent: AgentState): void {
        this.#settings = this.#sourceSettings(agent);
    }

    #sourceSettings(agent: AgentState): string {
        return JSON.stringify({
            cwd: agent.cwd ?? this.#app.cwdOf(this.#source!),
            model: agent.model,
            thinkingLevel: agent.thinkingLevel ?? "off",
        });
    }

    checkSource(agent: AgentState): void {
        this.current();

        if (this.#settings !== this.#sourceSettings(agent)) {
            throw new HttpError(409, "The source settings changed. Review them and try again.");
        }
    }

    async authorize(tx: Tx, mutation: boolean): Promise<User> {
        this.current();

        const turns =
            mutation && this.#source !== undefined
                ? await tx.doc(TurnsDoc, this.#app.rootOf(this.#source))
                : undefined;
        const user = this.current();

        if (mutation) {
            this.#app.requireSteer(user);

            if (turns?.on === true && turns.driver !== user.id) {
                throw new HttpError(409, "Take turns is on: take the wheel first.");
            }
        }

        return user;
    }

    readonly snapshot: DocumentReader["snapshot"] = (async (...args: unknown[]) => {
        this.current();
        args[args.length - 1] = this.context;

        const answer = await Reflect.apply(this.#app.harness.snapshot, this.#app.harness, args);

        this.current();

        return answer;
    }) as DocumentReader["snapshot"];

    readonly commit: WebRequest["commit"] = async (change) => {
        this.current();

        return this.#app.harness.commit(async (tx) => {
            await this.authorize(tx, true);

            const result = await change(tx);

            // A handler may have returned or the person may have lost access while its callback waited.
            await this.authorize(tx, true);

            return result;
        }, this.context);
    };
}
