/**
 * The people beside Pi: their side chat with mentions and quotes, activity lines ("Alex stopped the run"), typing,
 * reactions, pins, shared notes, and take turns. Pi sees none of it.
 */
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import type { User } from "./config.ts";
import {
    AuthorsDoc,
    CHAT_LIMIT,
    ChatDoc,
    type ChatMessage,
    type Notes,
    NotesDoc,
    type Pin,
    PinsDoc,
    ReactionsDoc,
    TurnsDoc,
} from "./docs.ts";
import { describe, HttpError } from "./errors.ts";
import { entryText, snippet } from "./projection.ts";
import { clientKey } from "./requests.ts";
import type { TypingPlace } from "./room.ts";

const context = BACKGROUND_CONTEXT;

const MAX_CHAT_TEXT = 4000;
const MAX_NOTES = 20_000;
const MAX_PINS = 100;
/** The same activity line from the same person within this time is one line, not many. */
const ACTIVITY_MERGE_MS = 10 * 60_000;

/** Reactions people can leave on a message. */
export const REACTIONS = ["👍", "❤️", "🎉", "👀", "❓", "👎"];

/**
 * Add an activity line to a chat, within a commit: `who` did `text`. The same line from the same person again soon is
 * one line, not many.
 */
export function addActivity(
    chat: { messages: ChatMessage[] },
    who: Pick<User, "id" | "name">,
    text: string,
    now = Date.now(),
): void {
    const last = chat.messages.at(-1);

    if (
        last?.kind === "event" &&
        last.userId === who.id &&
        last.text === text &&
        now - last.at < ACTIVITY_MERGE_MS
    ) {
        last.at = now;

        return;
    }

    chat.messages.push({
        id: `ev-${randomUUID()}`,
        userId: who.id,
        name: who.name,
        text,
        at: now,
        kind: "event",
    });

    if (chat.messages.length > CHAT_LIMIT) {
        chat.messages.splice(0, chat.messages.length - CHAT_LIMIT);
    }
}

export class Collab {
    readonly #app: PocketApp;

    constructor(app: PocketApp) {
        this.#app = app;
    }

    /** Post to the people's side chat of a conversation. Pi does not see it. */
    async postChat(
        id: ConversationId,
        user: User,
        request: { text: string; requestId: string; quote?: { entryId?: unknown } },
    ): Promise<ChatMessage> {
        const app = this.#app;

        app.requireSee(user, id);
        await app.conversation(id);
        const text = request.text.trim();

        if (text === "") {
            throw new HttpError(400, "Message is empty");
        }

        if (text.length > MAX_CHAT_TEXT) {
            throw new HttpError(413, `Chat messages are limited to ${MAX_CHAT_TEXT} characters`);
        }

        let quote: ChatMessage["quote"];

        if (request.quote !== undefined) {
            const entryId = Number(request.quote.entryId);
            const entry = Number.isInteger(entryId)
                ? await app.transcripts.fullEntry(id, entryId)
                : undefined;

            if (entry === undefined) {
                throw new HttpError(400, "The quoted message is not in this conversation");
            }

            quote = { entryId, text: snippet(entryText(entry)) };
        }

        const mentions = this.#mentions(text, user.id);
        const messageId = `${user.id.slice(0, 8)}-${clientKey(request.requestId)}`;
        let created = false;
        const message = await app.harness.commit(async (tx) => {
            const doc = await tx.doc(ChatDoc, id);
            const existing = doc.messages.find((each) => each.id === messageId);

            if (existing !== undefined) {
                return JSON.parse(JSON.stringify(existing)) as ChatMessage;
            }

            const fresh: ChatMessage = {
                id: messageId,
                userId: user.id,
                name: user.name,
                text,
                at: Date.now(),
                ...(mentions.length === 0 ? {} : { mentions }),
                ...(quote === undefined ? {} : { quote }),
            };

            doc.messages.push(fresh);

            if (doc.messages.length > CHAT_LIMIT) {
                doc.messages.splice(0, doc.messages.length - CHAT_LIMIT);
            }

            created = true;

            return fresh;
        }, context);

        this.setTyping(id, user, null);

        if (created) {
            void this.#chatPosted(id, user, message);
        }

        return message;
    }

    /** People named as `@Name` in a chat message, by id: the name must end at a word boundary. */
    #mentions(text: string, author: string): string[] {
        const lower = text.toLowerCase();
        const found: string[] = [];

        for (const person of this.#app.config.users) {
            if (person.id === author) {
                continue;
            }

            const name = `@${person.name.toLowerCase()}`;

            for (let at = lower.indexOf(name); at !== -1; at = lower.indexOf(name, at + 1)) {
                if (!/[\p{L}\p{N}_]/u.test(lower[at + name.length] ?? "")) {
                    found.push(person.id);
                    break;
                }
            }
        }

        return found;
    }

    /** After a chat message: tell mentioned people wherever they are, and push to those away. */
    async #chatPosted(id: ConversationId, user: User, message: ChatMessage): Promise<void> {
        const app = this.#app;
        const title = await app.conversationTitle(app.rootOf(id));
        const mentioned = new Set(message.mentions ?? []);

        for (const client of app.clients) {
            // People in the conversation see the message arrive; mentioned people elsewhere get a notice that opens it.
            if (
                !mentioned.has(client.user.id) ||
                client.conversationId === id ||
                !app.canSee(client.user, id)
            ) {
                continue;
            }

            client.send("notice", {
                level: "info",
                message: `${user.name} mentioned you in “${title}”: ${snippet(message.text, 120)}`,
                link: { conversationId: id, sheet: "chat" },
            });
        }

        const url = `/s/${String(id)}?chat=1`;

        for (const userId of mentioned) {
            void app.alerts.push(userId, id, "mention", {
                title: `${user.name} mentioned you · ${title}`,
                body: snippet(message.text, 400),
                url,
                tag: `chat-${String(id)}`,
            });
        }

        for (const userId of await app.alerts.participants(id)) {
            if (userId === user.id || mentioned.has(userId)) {
                continue;
            }

            void app.alerts.push(userId, id, "chat", {
                title: `${user.name} · ${title}`,
                body: snippet(message.text, 400),
                url,
                tag: `chat-${String(id)}`,
            });
        }
    }

    /**
     * A line of activity in the chat ("Alex stopped the run"), and a notice to the others here. Activity is how people
     * learn who changed what; it never reaches Pi.
     */
    async activity(id: ConversationId, user: User, text: string, notify = true): Promise<void> {
        try {
            await this.#app.harness.commit(
                async (tx) => addActivity(await tx.doc(ChatDoc, id), user, text),
                context,
            );
        } catch (error) {
            this.#app.log(`activity not recorded: ${describe(error)}`);
        }

        if (notify) {
            this.#tell(id, user.id, `${user.name} ${text}`);
        }
    }

    /** A notice for the people in a conversation, except whoever caused it. */
    #tell(id: ConversationId, except: string | undefined, message: string): void {
        const app = this.#app;

        for (const client of app.clients) {
            if (
                client.conversationId === id &&
                client.user.id !== except &&
                app.canSee(client.user, id)
            ) {
                client.send("notice", { level: "info", message });
            }
        }
    }

    /** Show others that this person is typing, in the chat or to Pi, or that they stopped. */
    setTyping(id: ConversationId, user: User, where: unknown): void {
        const place: TypingPlace | null =
            where === "chat" || (where === "pi" && user.role !== "viewer") ? where : null;

        if (place !== null && !this.#app.canSee(user, id)) {
            return;
        }

        void this.#app.openRoom(id)?.then(
            (room) => room.setTyping(user.id, place),
            () => {},
        );
    }

    /** Add or take back a reaction to a transcript entry. */
    async react(id: ConversationId, user: User, entryId: number, emoji: string): Promise<void> {
        const app = this.#app;

        app.requireSee(user, id);

        if (!REACTIONS.includes(emoji)) {
            throw new HttpError(400, `Pick one of ${REACTIONS.join(" ")}`);
        }

        if ((await app.transcripts.fullEntry(id, entryId)) === undefined) {
            throw new HttpError(404, "No such message");
        }

        await app.harness.commit(async (tx) => {
            const doc = await tx.doc(ReactionsDoc, id);
            const key = String(entryId);

            // Read back through the draft after creating: the assigned plain values are not the tracked ones.
            if (doc.entries[key] === undefined) {
                doc.entries[key] = {};
            }

            const byEmoji = doc.entries[key]!;

            if (byEmoji[emoji] === undefined) {
                byEmoji[emoji] = [];
            }

            const people = byEmoji[emoji]!;
            const at = people.indexOf(user.id);

            if (at === -1) {
                people.push(user.id);
            } else {
                people.splice(at, 1);
            }

            if (people.length === 0) {
                delete byEmoji[emoji];
            }

            if (Object.keys(byEmoji).length === 0) {
                delete doc.entries[key];
            }
        }, context);
    }

    /** Pin a transcript entry or a chat message, or unpin it when it is pinned already. */
    async pin(
        id: ConversationId,
        user: User,
        target: { entryId?: unknown; chatId?: unknown },
    ): Promise<{ pinned: boolean }> {
        const app = this.#app;

        app.requireSee(user, id);
        let pin: Pin;

        if (target.entryId !== undefined) {
            const entryId = Number(target.entryId);
            const entry = Number.isInteger(entryId)
                ? await app.transcripts.fullEntry(id, entryId)
                : undefined;

            if (entry === undefined || (entry.kind !== "user" && entry.kind !== "assistant")) {
                throw new HttpError(404, "No such message");
            }

            const authorId = (await app.harness.snapshot(AuthorsDoc, id, context))?.entries[
                String(entryId)
            ];
            const author =
                entry.kind === "assistant"
                    ? "Pi"
                    : (app.config.userById(authorId ?? "")?.name ?? entry.from ?? "Someone");

            pin = {
                id: `e${entryId}`,
                entryId,
                text: snippet(entryText(entry)),
                author,
                by: user.id,
                at: Date.now(),
            };
        } else if (typeof target.chatId === "string") {
            const chat = (await app.harness.snapshot(ChatDoc, id, context))?.messages.find(
                (each) => each.id === target.chatId,
            );

            if (chat === undefined || chat.kind === "event") {
                throw new HttpError(404, "No such chat message");
            }

            pin = {
                id: `c${chat.id}`,
                chatId: chat.id,
                text: snippet(chat.text),
                author: app.config.userById(chat.userId)?.name ?? chat.name,
                by: user.id,
                at: Date.now(),
            };
        } else {
            throw new HttpError(400, "entryId or chatId is required");
        }

        const pinned = await app.harness.commit(async (tx) => {
            const doc = await tx.doc(PinsDoc, id);
            const at = doc.items.findIndex((each) => each.id === pin.id);

            if (at !== -1) {
                doc.items.splice(at, 1);

                return false;
            }

            doc.items.push(pin);

            if (doc.items.length > MAX_PINS) {
                doc.items.splice(0, doc.items.length - MAX_PINS);
            }

            return true;
        }, context);

        if (pinned) {
            await this.activity(id, user, `pinned “${snippet(pin.text, 60)}”`, false);
        }

        return { pinned };
    }

    /** Save the shared notes. `rev` is the version the editor started from: a newer one means someone saved meanwhile. */
    async saveNotes(id: ConversationId, user: User, text: string, rev: number): Promise<Notes> {
        const app = this.#app;

        app.requireSee(user, id);

        if (text.length > MAX_NOTES) {
            throw new HttpError(413, `Notes are limited to ${MAX_NOTES} characters`);
        }

        await app.conversation(id);
        const saved = await app.harness.commit(async (tx) => {
            const doc = await tx.doc(NotesDoc, id);

            if (doc.rev !== rev) {
                const by = doc.by === undefined ? undefined : app.config.userById(doc.by)?.name;

                throw new HttpError(
                    409,
                    `${by ?? "Someone"} changed the notes while you were editing.`,
                );
            }

            doc.text = text;
            doc.rev = rev + 1;
            doc.by = user.id;
            doc.at = Date.now();

            return { text: doc.text, rev: doc.rev, by: doc.by, at: doc.at };
        }, context);

        await this.activity(id, user, "updated the notes", false);

        return saved;
    }

    /** Take turns: turn it on or off, take the wheel, ask for it, hand it over, or let go. */
    async turns(
        id: ConversationId,
        user: User,
        request: { action?: unknown; to?: unknown },
    ): Promise<void> {
        const app = this.#app;

        app.requireSee(user, id);
        app.requireSteer(user);
        const root = app.rootOf(id);
        const room = await app.room(root);
        const action = String(request.action ?? "");
        const name = (userId: string | undefined) =>
            userId === undefined ? "someone" : (app.config.userById(userId)?.name ?? "someone");
        let line: string | undefined;

        try {
            await app.harness.commit(async (tx) => {
                const doc = await tx.doc(TurnsDoc, root);
                const isDriver = doc.driver === user.id;

                if (action === "on") {
                    if (doc.on) {
                        return;
                    }

                    doc.on = true;
                    doc.driver = user.id;
                    doc.asks.splice(0);
                    line = "turned on take turns and is driving";
                } else if (action === "off") {
                    if (!doc.on) {
                        return;
                    }

                    if (
                        !isDriver &&
                        user.role !== "owner" &&
                        doc.driver !== undefined &&
                        room.has(doc.driver)
                    ) {
                        throw new HttpError(
                            409,
                            `${name(doc.driver)} is driving. Ask them to turn take turns off.`,
                        );
                    }

                    doc.on = false;
                    delete doc.driver;
                    doc.asks.splice(0);
                    line = "turned off take turns";
                } else if (action === "claim") {
                    if (!doc.on || isDriver) {
                        return;
                    }

                    if (doc.driver !== undefined && room.has(doc.driver) && user.role !== "owner") {
                        throw new HttpError(
                            409,
                            `${name(doc.driver)} is driving. Ask to drive instead.`,
                        );
                    }

                    doc.driver = user.id;
                    const at = doc.asks.indexOf(user.id);

                    if (at !== -1) {
                        doc.asks.splice(at, 1);
                    }

                    line = "took the wheel";
                } else if (action === "ask") {
                    if (!doc.on || isDriver || doc.asks.includes(user.id)) {
                        return;
                    }

                    doc.asks.push(user.id);
                    line = "asked to drive";
                } else if (action === "handover") {
                    const to = String(request.to ?? "");
                    const target = app.config.userById(to);

                    if (!doc.on) {
                        throw new HttpError(409, "Take turns is off");
                    }

                    if (!isDriver && user.role !== "owner") {
                        throw new HttpError(403, "Only the driver can hand over the wheel");
                    }

                    if (
                        target === undefined ||
                        target.role === "viewer" ||
                        !app.canSee(target, root)
                    ) {
                        throw new HttpError(400, "They cannot drive this session");
                    }

                    doc.driver = target.id;
                    const at = doc.asks.indexOf(target.id);

                    if (at !== -1) {
                        doc.asks.splice(at, 1);
                    }

                    line = `handed the wheel to ${target.name}`;
                } else if (action === "release") {
                    if (!doc.on || !isDriver) {
                        return;
                    }

                    delete doc.driver;
                    line = "let go of the wheel";
                } else {
                    throw new HttpError(400, "Unknown take turns action");
                }
            }, context);
        } finally {
            // Opened only to see who is here (the request came from a subagent's view): close it again like any other.
            app.releaseRoom(room);
        }

        if (line !== undefined) {
            await this.activity(root, user, line);
        }
    }
}
