/** Ordinary sessions an extension starts: a top-level session, like New session, made once for a key. */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { AgentDoc, type ConversationId, type ModelRef, type Tx } from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import type { User } from "./config.ts";
import { LinkedSessionCallsDoc } from "./docs.ts";
import { HttpError } from "./errors.ts";
import type { SessionsApi } from "./host.ts";
import { callKey } from "./linked-sessions.ts";
import { isThinkingLevel, levelFor, resolveModel, THINKING_LEVELS } from "./models.ts";
import { clientKey, ownRequest } from "./requests.ts";

const context = BACKGROUND_CONTEXT;

export class ExtensionSessions implements SessionsApi {
    readonly #app: PocketApp;

    constructor(app: PocketApp) {
        this.#app = app;
    }

    /**
     * Start an ordinary session for the person Pi works for in `source`, like New session.
     *
     * @experimental In 0.29.
     */
    async start(
        source: ConversationId,
        request: {
            title?: string;
            cwd?: string;
            model?: string;
            thinking?: string;
            message?: string;
        },
        key: string,
    ): Promise<{ session: ConversationId }> {
        const app = this.#app;
        const meta = app.sessionMeta(source);
        const requester = app.attribution.requesterOf(source);
        const user = requester === undefined ? undefined : app.config.userById(requester);

        if (meta === undefined || meta.pip !== undefined || user === undefined) {
            throw new HttpError(403, "A session starts only where Pi works for someone.");
        }

        app.requireSee(user, source);

        const chosen = await this.#chosen(request.model, request.thinking);

        // Before anything is made: a source past its spend limit starts nothing.
        app.spend.check(user, source);

        const token = callKey(source, key);
        const previous = (await app.harness.snapshot(LinkedSessionCallsDoc, source, context))
            ?.items[token];
        const session =
            previous?.conversationId === undefined
                ? await this.#create(source, user, request, chosen, token)
                : (previous.conversationId as unknown as ConversationId);

        if (request.message !== undefined) {
            await this.#message(session, user, request.message, token);
        }

        return { session };
    }

    /**
     * The model and thinking to apply, checked before anything is made. No model: the session keeps what a new
     * session starts with. The owner's list of models for subagents does not apply.
     */
    async #chosen(
        spec: string | undefined,
        level: string | undefined,
    ): Promise<{ model?: ModelRef; thinking?: ModelThinkingLevel } | undefined> {
        const app = this.#app;
        const named = spec?.trim() || undefined;
        const asked = level?.trim() || undefined;

        if (asked !== undefined && !isThinkingLevel(asked)) {
            throw new HttpError(400, `Thinking must be one of: ${THINKING_LEVELS.join(", ")}.`);
        }

        if (named === undefined) {
            return asked === undefined ? undefined : { thinking: asked };
        }

        let model: ModelRef;

        try {
            model = resolveModel(app.models, named, app.signInNeeded);
        } catch (error) {
            throw new HttpError(400, error instanceof Error ? error.message : String(error));
        }

        const problem = await app.providers.problem(model, true);

        if (problem !== undefined) {
            throw new HttpError(
                400,
                `The model ${model.provider}/${model.modelId} cannot be used now: ${problem}.`,
            );
        }

        const selected = app.models.getModel(model.provider, model.modelId)!;
        const thinking = asked === undefined ? undefined : levelFor(selected, asked);

        return { model, ...(thinking === undefined ? {} : { thinking }) };
    }

    /** Make the session and the call's record in one commit. A repeat of that commit returns the first. */
    async #create(
        source: ConversationId,
        user: User,
        request: { title?: string; cwd?: string },
        chosen: { model?: ModelRef; thinking?: ModelThinkingLevel } | undefined,
        token: string,
    ): Promise<ConversationId> {
        const app = this.#app;
        const now = Date.now();
        let session: ConversationId | undefined;
        const { id } = await app.commands.createSession(
            user,
            {
                ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
                ...(request.title === undefined ? {} : { title: request.title }),
            },
            {
                projectDefaults: chosen?.model === undefined,
                ...(chosen?.model === undefined ? {} : { model: chosen.model }),
                ...(chosen?.thinking === undefined ? {} : { thinkingLevel: chosen.thinking }),
                init: async (tx, made) => {
                    // After the harness writes the starting agent: a model that cannot think at the asked level
                    // would otherwise keep the level it started with.
                    if (chosen?.model !== undefined || chosen?.thinking !== undefined) {
                        Object.assign(await tx.doc(AgentDoc, made), {
                            ...(chosen.model === undefined ? {} : { model: chosen.model }),
                            ...(chosen.thinking === undefined
                                ? {}
                                : { thinkingLevel: chosen.thinking }),
                        });
                    }

                    session = await this.#receipt(tx, source, made, user, token, now);
                },
            },
        );

        return session ?? id;
    }

    /** Record this call, or return the session a repeat of this commit already recorded. */
    async #receipt(
        tx: Tx,
        source: ConversationId,
        made: ConversationId,
        user: User,
        token: string,
        now: number,
    ): Promise<ConversationId> {
        const calls = await tx.doc(LinkedSessionCallsDoc, source);
        const receipt = calls.items[token];

        if (receipt?.conversationId !== undefined) {
            return receipt.conversationId as unknown as ConversationId;
        }

        calls.items[token] = { conversationId: Number(made), by: user.id, at: now };

        return made;
    }

    /** Send the first message as the person wrote it, once: a submission already stored for this key is the first. */
    async #message(id: ConversationId, user: User, message: string, token: string): Promise<void> {
        const app = this.#app;
        const requestId = ownRequest(user.id, clientKey(token));
        const sent =
            (await app.harness.commit((tx) => tx.submissionByRequest(id, requestId), context)) !==
            undefined;

        if (sent) {
            return;
        }

        await app.commands.submit(id, user, { text: message, requestId: token });
    }
}
