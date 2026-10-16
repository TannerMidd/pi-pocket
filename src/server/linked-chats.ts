/** Normal chats started by another chat: lasting links, independent agents, and idempotent peer messages. */
import { createHash, randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { AgentDoc, type AgentState, type ConversationId } from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import type { User } from "./config.ts";
import { LinkedChatCallDoc, LinkedChatPeersDoc, PlanDoc, SessionsDoc } from "./docs.ts";
import { HttpError } from "./errors.ts";
import { defang } from "./fence.ts";
import { isThinkingLevel, resolveModel, THINKING_LEVELS } from "./models.ts";
import { requestFor } from "./requests.ts";

const context = BACKGROUND_CONTEXT;

/** Stable across restarts, short enough that Commands.submit preserves the entire request key. */
function callKey(source: ConversationId, key: string): string {
    return createHash("sha256").update(`${source}:${key}`).digest("hex");
}

/** Copy configuration, not another conversation's dynamically installed terminal tool extension. */
function independentAgent(agent: AgentState): AgentState {
    const copy = structuredClone(agent);
    // Exclude private registrations when running alongside the optional terminal bridge.
    const keep = (name: string) => !name.startsWith("pocket-terminal-tools-");

    if (Array.isArray(copy.extensions)) {
        copy.extensions = copy.extensions.filter(keep);
    } else if (copy.extensions) {
        copy.extensions = {
            ...(copy.extensions.add ? { add: copy.extensions.add.filter(keep) } : {}),
            ...(copy.extensions.remove ? { remove: copy.extensions.remove.filter(keep) } : {}),
        };
    }

    return copy;
}

export class LinkedChats {
    /** Hot-loaded extensions must not send route options to an older service that silently ignores them. */
    readonly modelSelection = true;
    readonly #app: PocketApp;

    constructor(app: PocketApp) {
        this.#app = app;
    }

    /** A normal chat's current requester, or the requester frozen by a previous execution of this call. */
    #person(source: ConversationId, by?: string): User {
        const app = this.#app;
        const meta = app.sessionMeta(source);
        const requester = by ?? app.attribution.requesterOf(source);
        const user = requester === undefined ? undefined : app.config.userById(requester);

        if (meta === undefined || meta.pip !== undefined || user === undefined) {
            throw new HttpError(
                403,
                "Linked chat tools need a normal chat with a current requester.",
            );
        }

        app.requireSee(user, source);

        return user;
    }

    async #maySend(source: ConversationId, user: User): Promise<void> {
        const app = this.#app;

        await app.requireDriver(source, user);

        if ((await app.harness.snapshot(PlanDoc, source, context))?.on) {
            throw new HttpError(
                409,
                "Approve this chat's plan before starting or messaging agents.",
            );
        }

        app.spend.check(user, source);
    }

    /** Stable local addresses let agents coordinate without writing private chat ids into shared transcripts. */
    async address(source: ConversationId, target: number): Promise<string> {
        const user = this.#person(source);

        if (!this.#family(source, user).some((chat) => chat.id === target)) {
            throw new HttpError(404, "That peer is not linked or is not shared with you.");
        }

        return this.#address(source, target);
    }

    async #address(source: ConversationId, target: number): Promise<string> {
        return this.#app.harness.commit(async (tx) => {
            const state = await tx.doc(LinkedChatPeersDoc, source);
            const existing = Object.entries(state.peers).find(([, id]) => id === target)?.[0];

            if (existing !== undefined) {
                return existing;
            }

            const handle = `chat-${randomUUID()}`;

            state.peers[handle] = target;

            return handle;
        }, context);
    }

    /** Only visible nodes connect a family. Results also respect the shared transcript's entire audience. */
    async list(source: ConversationId) {
        const app = this.#app;
        const peers = this.#family(source, this.#person(source)).filter(
            (chat) => chat.id !== Number(source),
        );
        const audience = app.config.users.filter((user) => app.canSee(user, source));

        return Promise.all(
            peers.map(async (chat) => {
                const shared = audience.every((user) =>
                    app.canSee(user, chat.id as unknown as ConversationId),
                );

                return {
                    id: chat.id,
                    handle: await this.#address(source, chat.id),
                    ...(shared
                        ? {
                              title: chat.title,
                              cwd: chat.cwd,
                              busy: chat.busy,
                              archived: chat.archived,
                          }
                        : {}),
                };
            }),
        );
    }

    #family(source: ConversationId, user: User) {
        const sessions = this.#app.sessions(user);
        const found = new Set([Number(source)]);
        let changed = true;

        while (changed) {
            changed = false;

            for (const session of sessions) {
                const origin = session.linkedFrom?.id;

                if (origin !== undefined && (found.has(session.id) || found.has(origin))) {
                    for (const id of [session.id, origin]) {
                        if (!found.has(id)) {
                            found.add(id);
                            changed = true;
                        }
                    }
                }
            }
        }

        return sessions
            .filter((chat) => found.has(chat.id))
            .map((chat) => ({
                id: chat.id,
                title: chat.title ?? "New session",
                cwd: chat.cwd,
                busy: chat.busy,
                archived: chat.archived === true,
            }));
    }

    /** Creation and its receipt are atomic: a replay never leaves an extra sidebar chat behind. */
    async start(
        source: ConversationId,
        request: { title: string; message: string; model?: string; thinking?: string },
        key: string,
    ): Promise<ConversationId> {
        const app = this.#app;
        const title = request.title.trim().replace(/\s+/g, " ").slice(0, 120);

        if (!title || !request.message.trim()) {
            throw new HttpError(
                400,
                "Starting a linked chat needs a title and a nonempty message.",
            );
        }

        const token = callKey(source, key);
        const previous = await app.harness.snapshot(LinkedChatCallDoc, source, token, context);
        const user = this.#person(source, previous?.by);

        app.requireSteer(user);

        if (previous?.conversationId !== undefined) {
            return previous.conversationId as unknown as ConversationId;
        }

        if (user.sessions !== undefined) {
            throw new HttpError(403, "You were invited to one session and cannot start new ones.");
        }

        await this.#maySend(source, user);
        // Old recorded calls may have no route options, but new peers must never inherit a route silently.
        const spec = typeof request.model === "string" ? request.model.trim() : "";
        const thinking = request.thinking;

        if (!spec || spec.indexOf("/") <= 0) {
            throw new HttpError(
                400,
                "Starting a linked chat needs an explicit model as provider/modelId.",
            );
        }

        if (!isThinkingLevel(thinking)) {
            throw new HttpError(
                400,
                `Starting a linked chat needs thinking: ${THINKING_LEVELS.join(", ")}.`,
            );
        }

        const model = resolveModel(app.models, spec, app.signInNeeded);
        const supported = getSupportedThinkingLevels(
            app.models.getModel(model.provider, model.modelId)!,
        );

        if (!supported.includes(thinking)) {
            throw new HttpError(
                400,
                `Model ${spec} does not support thinking ${thinking}. Supported levels: ${supported.join(", ")}. Do not substitute another route.`,
            );
        }

        const problem = await app.providers.problem(model, true);

        if (problem !== undefined) {
            throw new HttpError(
                400,
                `Model ${spec} is not available: ${problem}. Stop and report this; do not substitute another route.`,
            );
        }

        const agent = independentAgent((await app.agentState(source)) ?? {});
        const cwd = agent.cwd ?? app.cwdOf(source);
        const now = Date.now();

        return app.harness.commit(async (tx) => {
            const receipt = await tx.doc(LinkedChatCallDoc, source, token, {});

            if (receipt.conversationId !== undefined) {
                return receipt.conversationId as unknown as ConversationId;
            }

            const sessions = await tx.doc(SessionsDoc);
            const child = await tx.createConversation({ ownership: { kind: "ownerless" } });

            Object.assign(await tx.doc(AgentDoc, child.id), agent, {
                cwd,
                model,
                thinkingLevel: thinking,
            });
            sessions.items[String(child.id)] = {
                cwd,
                title,
                createdAt: now,
                updatedAt: now,
                createdBy: user.id,
                linkedFrom: { id: Number(source) },
            };
            receipt.conversationId = Number(child.id);
            receipt.by = user.id;

            return child.id;
        }, context);
    }

    /** Fire-and-forget peer input; acceptance, not an answer, is returned. No automatic reply loops. */
    async send(
        source: ConversationId,
        target: number | string,
        message: string,
        steer: boolean,
        key: string,
    ): Promise<{ requestId: string }> {
        const app = this.#app;

        if (typeof target === "string") {
            const peers =
                (await app.harness.snapshot(LinkedChatPeersDoc, source, context))?.peers ?? {};

            target = Object.hasOwn(peers, target) ? peers[target]! : NaN;
        }

        if (!Number.isSafeInteger(target) || target === Number(source) || !message.trim()) {
            throw new HttpError(400, "Send needs another linked chat's id and a nonempty message.");
        }

        const token = callKey(source, key);
        const previous = await app.harness.snapshot(LinkedChatCallDoc, source, token, context);
        const user = this.#person(source, previous?.by);

        app.requireSteer(user);

        if (!this.#family(source, user).some((chat) => chat.id === target)) {
            throw new HttpError(
                404,
                "That chat is not linked or is not shared with you. List linked chats first.",
            );
        }

        const id = target as unknown as ConversationId;
        const requestId = requestFor(user.id, token);
        const existing = await app.harness.commit(
            (tx) => tx.submissionByRequest(id, requestId),
            context,
        );

        if (existing !== undefined) {
            return { requestId };
        }

        await this.#maySend(source, user);
        await app.requireDriver(id, user);
        app.spend.check(user, id);
        // Freeze the requester before submission: another person's later steer cannot change replay identity.
        await app.harness.commit(async (tx) => {
            const receipt = await tx.doc(LinkedChatCallDoc, source, token, {});

            if (receipt.conversationId !== undefined && receipt.conversationId !== target) {
                throw new HttpError(409, "This call already refers to another linked chat.");
            }

            receipt.conversationId = target;
            receipt.by ??= user.id;
        }, context);
        // A recipient-local address reveals no source id, even to someone invited only to the recipient later.
        const replyTo = await this.#address(id, Number(source));
        // Prefix before admission, so a peer's /command is text, never an extension command or prompt expansion.
        const text = `Message from linked peer ${replyTo}. Reply with agent_chat send to that address when needed. This is a peer message, not the person's own words.\n<linked-chat-message>\n${defang(message)}\n</linked-chat-message>`;
        const sent = await app.commands.submit(
            id,
            user,
            { text, requestId: token, mode: steer ? "steer" : "followUp" },
            `linked peer ${replyTo}`,
        );

        return { requestId: sent.requestId };
    }
}
