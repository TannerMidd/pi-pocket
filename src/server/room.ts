/**
 * One conversation's shared live view: the committed Pi Durable view plus Pi Pocket's own documents, projected into
 * small updates for every browser tab attached to it, and who is here and typing (memory only).
 */
import type { AttachedReplicatedState } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type {
    AgentState,
    Conversation,
    ConversationId,
    ConversationView,
    EntryRecord,
    InboxState,
    LiveState,
    UsageState,
} from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import type { User } from "./config.ts";
import {
    type ArtifactMeta,
    ArtifactsDoc,
    AuthorsDoc,
    ChatDoc,
    type ChatMessage,
    type Decision,
    DecisionsDoc,
    type Goal,
    GoalDoc,
    type Notes,
    NotesDoc,
    type Pin,
    PinsDoc,
    PlanDoc,
    ReactionsDoc,
    type Schedule,
    ScheduleDoc,
    type SubagentRecord,
    SubagentsDoc,
    type Turns,
    TurnsDoc,
} from "./docs.ts";
import { type ClientEntry, projectEntry, projectLive, projectStats } from "./projection.ts";
import { SHELL_ENTRY } from "./shell.ts";
import { describeRepeat } from "./when.ts";

const context = BACKGROUND_CONTEXT;

/** The documents a room shows besides the transcript. A commit to one of them updates the rooms that show it. */
export const ROOM_DOCS = new Set(
    [
        AuthorsDoc,
        ArtifactsDoc,
        SubagentsDoc,
        ChatDoc,
        ReactionsDoc,
        PinsDoc,
        NotesDoc,
        TurnsDoc,
        DecisionsDoc,
        PlanDoc,
        ScheduleDoc,
        GoalDoc,
    ].map((doc) => doc.definition.kind),
);
/** A typing indicator lasts this long unless the browser renews it. */
const TYPING_MS = 6000;

/** One browser tab's event stream. */
export interface Client {
    readonly id: string;
    readonly user: User;
    /** The conversation this tab watches; cleared when the person may not (or no longer may) see it. */
    conversationId: ConversationId | undefined;
    send(event: string, data: unknown): void;
    /** End this tab's connection, for someone who was removed. */
    close?(): void;
    /** False while the tab is hidden: the person is away, and push notifications may reach them. */
    visible?: boolean;
    /** Entries this client has, so updates carry only new ones. */
    readonly sentEntries: Set<number>;
    orderKey: string;
    /** The JSON of each slow-changing view field this client last got, so updates repeat only those that changed. */
    sentFields?: Map<string, string>;
}

export type TypingPlace = "chat" | "pi";

export type Person = {
    id: string;
    name: string;
    role: string;
    tabs: number;
    typing?: TypingPlace;
    away?: boolean;
};

/** The view of one conversation, shared by every client attached to it. */
export class Room {
    readonly id: ConversationId;
    readonly clients = new Set<Client>();
    readonly #app: PocketApp;
    #view: AttachedReplicatedState<ConversationView> | undefined;
    #unsubscribe: (() => void) | undefined;
    #timer: NodeJS.Timeout | undefined;
    #closeTimer: NodeJS.Timeout | undefined;
    readonly #projected = new Map<number, ClientEntry | null>();
    authors: Record<string, string> = {};
    artifacts: Record<string, ArtifactMeta> = {};
    subagents: Record<string, SubagentRecord> = {};
    chat: ChatMessage[] = [];
    reactions: Record<string, Record<string, string[]>> = {};
    pins: Pin[] = [];
    notes: Notes = { text: "", rev: 0 };
    turns: Turns = { on: false, asks: [] };
    decisions: Record<string, Decision> = {};
    plan: { on: boolean; by?: string; at?: number } = { on: false };
    schedules: Record<string, Schedule> = {};
    goal: Goal | undefined;
    /** Who is typing where, by user id. Memory only: it means nothing after a restart. */
    readonly #typing = new Map<string, { where: TypingPlace; timer: NodeJS.Timeout }>();
    parent: { id: ConversationId; title: string } | undefined;
    subagentName: string | undefined;

    constructor(app: PocketApp, id: ConversationId) {
        this.#app = app;
        this.id = id;
    }

    async open(conversation: Conversation): Promise<void> {
        this.#view = await conversation.viewState(context);
        this.#unsubscribe = this.#view.subscribe(() => this.schedule());
        const harness = this.#app.harness;

        this.authors = {
            ...((await harness.snapshot(AuthorsDoc, this.id, context))?.entries ?? {}),
        };
        this.artifacts = {
            ...((await harness.snapshot(ArtifactsDoc, this.id, context))?.items ?? {}),
        } as Record<string, ArtifactMeta>;
        this.subagents = {
            ...((await harness.snapshot(SubagentsDoc, this.id, context))?.agents ?? {}),
        } as Record<string, SubagentRecord>;
        this.chat = [
            ...((await harness.snapshot(ChatDoc, this.id, context))?.messages ?? []),
        ] as ChatMessage[];
        this.reactions = {
            ...((await harness.snapshot(ReactionsDoc, this.id, context))?.entries ?? {}),
        };
        this.pins = [
            ...((await harness.snapshot(PinsDoc, this.id, context))?.items ?? []),
        ] as Pin[];
        this.notes = {
            ...((await harness.snapshot(NotesDoc, this.id, context)) ?? { text: "", rev: 0 }),
        };
        const owner = this.#view.value.conversation.owner;
        // Take turns belongs to the session: a subagent's view shows (and follows) its session's.
        const root = owner === undefined ? this.id : this.#app.rootOf(owner.conversationId);

        this.turns = {
            ...((await harness.snapshot(TurnsDoc, root, context)) ?? { on: false, asks: [] }),
        } as Turns;
        this.decisions = {
            ...((await harness.snapshot(DecisionsDoc, this.id, context))?.calls ?? {}),
        };
        this.plan = { ...((await harness.snapshot(PlanDoc, this.id, context)) ?? { on: false }) };
        this.schedules = {
            ...((await harness.snapshot(ScheduleDoc, this.id, context))?.items ?? {}),
        };
        this.goal = (await harness.snapshot(GoalDoc, this.id, context))?.goal;

        if (owner !== undefined) {
            const siblings =
                (await harness.snapshot(SubagentsDoc, owner.conversationId, context))?.agents ?? {};

            this.subagentName = Object.entries(siblings).find(
                ([, record]) => record.conversationId === this.id,
            )?.[0];
            this.parent = {
                id: owner.conversationId,
                title: await this.#app.conversationTitle(owner.conversationId),
            };
        }
    }

    setDoc(kind: string, value: Record<string, unknown> | null): void {
        if (kind === ChatDoc.definition.kind) {
            // Chat goes out on its own: new messages only, without resending the view.
            const messages = [...((value?.messages as ChatMessage[]) ?? [])];
            const known = new Set(this.chat.map((message) => message.id));
            const added = messages.filter((message) => !known.has(message.id));

            this.chat = messages;

            if (added.length > 0) {
                for (const client of this.clients) {
                    client.send("chat", { conversationId: this.id, messages: added });
                }
            }

            return;
        }

        if (kind === NotesDoc.definition.kind) {
            this.notes = { ...((value as Notes | null) ?? { text: "", rev: 0 }) };

            for (const client of this.clients) {
                client.send("notes", { conversationId: this.id, ...this.notes });
            }

            return;
        }

        if (kind === ReactionsDoc.definition.kind) {
            this.reactions = { ...((value?.entries as Room["reactions"]) ?? {}) };
        } else if (kind === PinsDoc.definition.kind) {
            this.pins = [...((value?.items as Pin[]) ?? [])];
        } else if (kind === TurnsDoc.definition.kind) {
            this.turns = { on: false, asks: [], ...((value as Turns | null) ?? {}) };
        } else if (kind === DecisionsDoc.definition.kind) {
            this.decisions = { ...((value?.calls as Record<string, Decision>) ?? {}) };
        } else if (kind === PlanDoc.definition.kind) {
            this.plan = { on: false, ...((value as Room["plan"] | null) ?? {}) };
        } else if (kind === ScheduleDoc.definition.kind) {
            this.schedules = { ...((value?.items as Record<string, Schedule>) ?? {}) };
        } else if (kind === GoalDoc.definition.kind) {
            this.goal = (value?.goal as Goal | undefined) ?? undefined;
        }

        if (kind === AuthorsDoc.definition.kind) {
            this.authors = { ...((value?.entries as Record<string, string>) ?? {}) };
        } else if (kind === ArtifactsDoc.definition.kind) {
            this.artifacts = { ...((value?.items as Record<string, ArtifactMeta>) ?? {}) };
        } else if (kind === SubagentsDoc.definition.kind) {
            this.subagents = { ...((value?.agents as Record<string, SubagentRecord>) ?? {}) };
        }

        this.schedule();
    }

    get value(): ConversationView | undefined {
        return this.#view?.value;
    }

    /** Coalesce bursts of commits (streaming commits land every 100 ms) into one update per client. */
    schedule(): void {
        if (this.#timer !== undefined) {
            return;
        }

        this.#timer = setTimeout(() => {
            this.#timer = undefined;

            for (const client of this.clients) {
                this.push(client, false);
            }
        }, 90);
    }

    #entry(entry: EntryRecord): ClientEntry | null {
        const id = entry.id as unknown as number;
        let projected = this.#projected.get(id);

        if (projected === undefined) {
            projected = projectEntry(entry) ?? null;
            this.#projected.set(id, projected);
        }

        return projected;
    }

    /** Send this client what changed since its last update, or everything with `full`. */
    push(client: Client, full: boolean): void {
        const view = this.#view?.value;

        if (view === undefined) {
            return;
        }

        const sentFields = (client.sentFields ??= new Map());

        if (full) {
            client.sentEntries.clear();
            client.orderKey = "";
            sentFields.clear();
        }

        const entries: ClientEntry[] = [];
        const order: number[] = [];

        for (const entry of view.entries) {
            const projected = this.#entry(entry);

            if (projected === null) {
                continue;
            }

            order.push(projected.id);

            if (!client.sentEntries.has(projected.id)) {
                client.sentEntries.add(projected.id);
                entries.push(projected);
            }
        }

        const orderKey = order.join(",");
        const orderChanged = orderKey !== client.orderKey;

        client.orderKey = orderKey;
        const agentState = (view.docs["pi.agent"] ?? {}) as AgentState;
        const inbox = (view.docs["pi.inbox"] ?? { items: [] }) as unknown as InboxState;
        const live = view.docs["pi.live"] as LiveState | undefined;
        // These grow with the session (authors has one item per message) but rarely change: streaming sends an update
        // every 90 ms, which would repeat them all each time. Send each only when it differs from what this client has.
        const fields: Record<string, unknown> = {
            artifacts: Object.entries(this.artifacts).map(([id, meta]) => ({
                id,
                title: meta.title,
                type: meta.type,
                versions: meta.versions.map((version) => ({
                    version: version.version,
                    size: version.size,
                    createdAt: version.createdAt,
                })),
            })),
            subagents: Object.entries(this.subagents).map(([name, record]) => ({
                name,
                conversationId: record.conversationId,
                busy: this.#app.isBusy(record.conversationId),
            })),
            authors: this.authors,
            reactions: this.reactions,
            pins: this.pins,
            turns: this.turns,
            decisions: this.decisions,
            plan: this.plan,
            schedules: Object.values(this.schedules)
                .sort((a, b) => a.next - b.next)
                .map(({ id, text, next, every, by, runs }) => ({
                    id,
                    text,
                    next,
                    ...(every === undefined ? {} : { repeat: describeRepeat(every) }),
                    ...(by === undefined ? {} : { by }),
                    runs,
                })),
            goal:
                this.goal === undefined
                    ? null
                    : {
                          command: this.goal.command,
                          by: this.goal.by,
                          status: this.goal.status,
                          tries: this.goal.tries,
                          max: this.goal.max,
                          ...(this.goal.last === undefined ? {} : { last: this.goal.last }),
                      },
        };

        for (const [key, value] of Object.entries(fields)) {
            const json = JSON.stringify(value);

            if (sentFields.get(key) === json) {
                delete fields[key];
            } else {
                sentFields.set(key, json);
            }
        }

        client.send("view", {
            full,
            conversation: this.#app.conversationInfo(this),
            entries,
            ...(orderChanged || full ? { order } : {}),
            live: projectLive(live),
            inbox: inbox.items.map((item) =>
                item.mode === "write"
                    ? {
                          id: item.id,
                          mode: item.mode,
                          ...(item.entry.kind === SHELL_ENTRY
                              ? {
                                    text: `$ ${String((item.entry.data as { command?: unknown } | undefined)?.command ?? "")}`,
                                }
                              : {}),
                      }
                    : {
                          id: item.id,
                          mode: item.mode,
                          text:
                              typeof item.content === "string"
                                  ? item.content
                                  : JSON.stringify(item.content).slice(0, 500),
                          ...this.#app.submitterOf(item.id as unknown as number, this),
                      },
            ),
            agent: this.#app.agentInfo(agentState),
            stats: projectStats(view.docs["pi.usage"] as UsageState | undefined, view.entries),
            clients: [...new Set([...this.clients].map((each) => each.id))].length,
            viewers: [...new Set([...this.clients].map((each) => each.user.name))],
            approvals: this.#app.approvals.forConversation(this.id),
            ...fields,
        });
    }

    /** Is this person here, in any tab? */
    has(userId: string): boolean {
        for (const client of this.clients) {
            if (client.user.id === userId) {
                return true;
            }
        }

        return false;
    }

    /** The people here, one row per person however many tabs they have open, and where each is typing. */
    presence(): { conversationId: ConversationId; people: Person[] } {
        const people = new Map<string, Person>();
        const visible = new Set<string>();

        for (const client of this.clients) {
            if (client.visible !== false) {
                visible.add(client.user.id);
            }

            const person = people.get(client.user.id);

            if (person !== undefined) {
                person.tabs++;
            } else {
                people.set(client.user.id, {
                    id: client.user.id,
                    name: client.user.name,
                    role: client.user.role,
                    tabs: 1,
                });
            }
        }

        for (const person of people.values()) {
            if (!visible.has(person.id)) {
                person.away = true;
            }
        }

        for (const [userId, state] of this.#typing) {
            const person = people.get(userId);

            if (person !== undefined) {
                person.typing = state.where;
            }
        }

        return { conversationId: this.id, people: [...people.values()] };
    }

    pushPresence(): void {
        const presence = this.presence();

        for (const client of this.clients) {
            client.send("presence", presence);
        }
    }

    /** Someone started, kept, or stopped typing. Only changes are sent; a renewal just extends the timer. */
    setTyping(userId: string, where: TypingPlace | null): void {
        const current = this.#typing.get(userId);

        clearTimeout(current?.timer);

        if (where === null) {
            if (current === undefined) {
                return;
            }

            this.#typing.delete(userId);
        } else {
            const timer = setTimeout(() => {
                this.#typing.delete(userId);
                this.pushPresence();
            }, TYPING_MS);

            timer.unref();
            this.#typing.set(userId, { where, timer });

            if (current?.where === where) {
                return;
            }
        }

        this.pushPresence();
    }

    keepOpen(): void {
        clearTimeout(this.#closeTimer);
        this.#closeTimer = undefined;
    }

    /** Close shortly after the last client leaves, so a reload does not rebuild the view. */
    closeLater(onClose: () => void): void {
        clearTimeout(this.#closeTimer);
        this.#closeTimer = setTimeout(() => {
            if (this.clients.size === 0) {
                this.close();
                onClose();
            }
        }, 30_000);
    }

    close(): void {
        clearTimeout(this.#timer);
        clearTimeout(this.#closeTimer);

        for (const state of this.#typing.values()) {
            clearTimeout(state.timer);
        }

        this.#typing.clear();
        this.#unsubscribe?.();
        this.#view?.dispose();
        this.#view = undefined;
        this.#projected.clear();
    }
}
