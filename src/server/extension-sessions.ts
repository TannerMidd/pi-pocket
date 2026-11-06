/** Ordinary sessions an extension starts: a top-level session, like New session, made once for a key. */
import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { AgentDoc, type ConversationId, type ModelRef, type Tx } from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import type { User } from "./config.ts";
import { LinkedSessionCallsDoc } from "./docs.ts";
import { HttpError } from "./errors.ts";
import type { SessionsApi } from "./host.ts";
import { recordOf } from "./linked-sessions.ts";
import { isThinkingLevel, levelFor, resolveModel, THINKING_LEVELS } from "./models.ts";
import { clientKey, ownRequest } from "./requests.ts";

const context = BACKGROUND_CONTEXT;

/**
 * This call's record in `LinkedSessionCallsDoc`, apart from those of linked sessions: `callKey` there hashes
 * `<source>:<key>`, which starts with a digit. A key a module also gives `linkedSessions.start` finds no linked one.
 */
const callToken = (source: ConversationId, key: string): string =>
    createHash("sha256").update(`session:${source}:${key}`).digest("hex");

/** Thrown inside the creation commit when a repeat already recorded this call, so that commit writes nothing. */
class AlreadyStarted extends Error {
    readonly session: ConversationId;

    constructor(session: ConversationId) {
        super("This call already started a session.");
        this.name = "AlreadyStarted";
        this.session = session;
    }
}

export class ExtensionSessions implements SessionsApi {
    readonly #app: PocketApp;

    constructor(app: PocketApp) {
        this.#app = app;
    }

    /**
     * Start an ordinary session for the person Pi works for in `source`, like New session.
     *
     * @experimental In 0.28.
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

        // `Commands.submit` sends no blank message: it is refused before anything is made.
        if (request.message !== undefined && request.message.trim() === "") {
            throw new HttpError(400, "The first message is empty.");
        }

        const token = callToken(source, key);
        const recorded = async () =>
            (await app.harness.snapshot(LinkedSessionCallsDoc, source, context))?.items[token];
        const previous = await recorded();
        const meta = app.sessionMeta(source);
        // A repeat acts for the person the first call acted for: the message is theirs, and goes once.
        const requester = previous?.by ?? app.attribution.requesterOf(source);
        const user = requester === undefined ? undefined : app.config.userById(requester);

        if (meta === undefined || meta.pip !== undefined || user === undefined) {
            throw new HttpError(403, "A session starts only where Pi works for someone.");
        }

        app.requireSee(user, source);

        // A repeat returns the session the first call made, even when a check below would refuse a new call now.
        let session = previous?.conversationId as ConversationId | undefined;
        let sender = user;

        if (session === undefined) {
            const chosen = await this.#chosen(request.model, request.thinking);

            // Before anything is made: a source past its spend limit starts nothing.
            app.spend.check(user, source);
            // A repeat that lost the race aborts its own creation and returns the session the winner recorded.
            session = await this.#create(source, user, request, chosen, token).catch(
                async (error) => {
                    if (!(error instanceof AlreadyStarted)) {
                        throw error;
                    }

                    const winner = await recorded();

                    // The message is the winner's: a call that wrote meanwhile does not send it again.
                    sender =
                        (winner?.by === undefined ? undefined : app.config.userById(winner.by)) ??
                        user;

                    return (winner?.conversationId as ConversationId | undefined) ?? error.session;
                },
            );
        }

        if (request.message !== undefined) {
            await this.#message(session, sender, request.message, token);
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

        return { model, ...(asked === undefined ? {} : { thinking: asked }) };
    }

    /** Make the session and the call's record in one commit. A repeat of that commit returns the first. */
    async #create(
        source: ConversationId,
        user: User,
        request: { title?: string; cwd?: string; message?: string },
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
                ...(chosen?.model === undefined ? {} : { model: chosen.model }),
                ...(chosen?.thinking === undefined ? {} : { thinkingLevel: chosen.thinking }),
                init: async (tx, made) => {
                    const agent = await tx.doc(AgentDoc, made);
                    const model =
                        agent.model &&
                        app.models.getModel(agent.model.provider, agent.model.modelId);

                    // `Commands.submit` refuses a first message on a session with no model. Refused here, in the
                    // commit that makes the session, it leaves no session.
                    if (request.message !== undefined && model === undefined) {
                        throw new HttpError(
                            409,
                            "Pick a model first: name one in `model`, or choose a default model.",
                        );
                    }

                    // Lowered to a level that the session's model has, named or the default.
                    if (chosen?.thinking !== undefined && model !== undefined) {
                        agent.thinkingLevel = levelFor(model, chosen.thinking);
                    }

                    await this.#receipt(tx, source, made, user, token, now);
                    session = made;
                },
            },
        );

        return session ?? id;
    }

    /** Record this call. A repeat of this commit already has a record: abort, so this commit writes nothing. */
    async #receipt(
        tx: Tx,
        source: ConversationId,
        made: ConversationId,
        user: User,
        token: string,
        now: number,
    ): Promise<void> {
        // Kept and pruned as the records of linked sessions are.
        const receipt = recordOf(await tx.doc(LinkedSessionCallsDoc, source), token, now);

        if (receipt.conversationId !== undefined) {
            throw new AlreadyStarted(receipt.conversationId as unknown as ConversationId);
        }

        Object.assign(receipt, { conversationId: Number(made), by: user.id });
    }

    /** Send the first message as the person wrote it, once: a submission already stored for this key is the first. */
    async #message(id: ConversationId, user: User, message: string, token: string): Promise<void> {
        const app = this.#app;
        const requestId = ownRequest(user.id, clientKey(token));
        // Looked up before `Commands.submit`: its checks (a spend limit reached since) would refuse a repeat.
        const sent =
            (await app.harness.commit((tx) => tx.submissionByRequest(id, requestId), context)) !==
            undefined;

        if (sent) {
            return;
        }

        await app.commands.submit(id, user, { text: message, requestId: token });
    }
}
