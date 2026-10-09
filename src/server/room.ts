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
import type { Head } from "./branches.ts";
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
    STOPPED,
    SubagentsDoc,
    type Turns,
    TurnsDoc,
} from "./docs.ts";
import { SHELL_ENTRY } from "./entry-format.ts";
import { agentInfo } from "./models.ts";
import {
    type ClientEntry,
    PEEK_LINES,
    type PeekLine,
    peekLines,
    projectEntry,
    projectLive,
    projectStats,
} from "./projection.ts";
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
/** Peek tiles change at most this often: they are glanced at, and a streaming answer changes every 90 ms. */
const PEEK_MS = 1000;
/** Entries read from the end of a session for its peek tile: enough to find the results of the calls it shows. */
const PEEK_ENTRIES = PEEK_LINES * 3;
/** How often an open view looks at its folder's branch, for one switched outside the app while the session is quiet. */
const HEAD_MS = 3000;
/** How much of a waiting call's command and reason a tile gets: the tile allows only short commands anyway. */
const PEEK_SUBJECT = 500;
const PEEK_REASON = 300;

/** What a peek tile shows of a session: its last steps, and the calls waiting for approval. */
export type PeekSummary = {
    conversationId: ConversationId;
    lines: PeekLine[];
    approvals: {
        id: string;
        conversationId: ConversationId;
        tool: string;
        subject: string;
        reason: string;
        requestedBy?: string;
    }[];
};

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
    /**
     * This connection, apart from others of the same tab id: a duplicated browser tab keeps the id, and a reconnect
     * briefly overlaps the old connection. Sent in `hello`; peek lists name it.
     */
    readonly connection: string;
    /** Other sessions this tab shows as peek tiles on screen now; each gets `peek` events (`PocketApp.setPeeks`). */
    peeks?: Set<ConversationId>;
    /** The number of the last peek list taken, so one that arrives late does not undo a newer one. */
    peekSeq?: number;
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

/** The subagents with a report on its way: waiting in the outbox, or in the batch sent and still queued. */
function reportingOf(
    doc:
        | {
              outbox?: readonly { name: string }[];
              sending?: { reports: readonly { name: string }[] };
          }
        | null
        | undefined,
): Set<string> {
    return new Set(
        [...(doc?.outbox ?? []), ...(doc?.sending?.reports ?? [])].map((report) => report.name),
    );
}

/** The view of one conversation, shared by every client attached to it. */
export class Room {
    readonly id: ConversationId;
    readonly clients = new Set<Client>();
    /** Tabs that show this session as a peek tile. They are not here: they get only `peek` events, and no presence. */
    readonly peekers = new Set<Client>();
    /** The JSON of the peek each peeker last got, so an unchanged tile is not sent again. */
    readonly #peekSent = new WeakMap<Client, string>();
    #peekTimer: NodeJS.Timeout | undefined;
    readonly #app: PocketApp;
    #view: AttachedReplicatedState<ConversationView> | undefined;
    #unsubscribe: (() => void) | undefined;
    #timer: NodeJS.Timeout | undefined;
    #closeTimer: NodeJS.Timeout | undefined;
    #headTimer: NodeJS.Timeout | undefined;
    /** The branch this view last read, as JSON. */
    #head = "";
    readonly #projected = new Map<number, ClientEntry | null>();
    authors: Record<string, string> = {};
    artifacts: Record<string, ArtifactMeta> = {};
    subagents: Record<string, SubagentRecord> = {};
    /** The subagents whose reports are on their way to this conversation: waiting, or sent and still queued. */
    #reporting = new Set<string>();
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
        const subagents = await harness.snapshot(SubagentsDoc, this.id, context);

        this.subagents = { ...(subagents?.agents ?? {}) } as Record<string, SubagentRecord>;
        this.#reporting = reportingOf(subagents);
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

        // Every update reads the branch; this catches a switch made in a terminal while nothing else changes. Started
        // last, so a room that failed to open leaves no timer behind.
        this.#readHead();
        this.#headTimer = setInterval(() => {
            const before = this.#head;

            if (JSON.stringify(this.#readHead()) !== before) {
                this.schedule();
            }
        }, HEAD_MS);
        this.#headTimer.unref();
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
            this.#reporting = reportingOf(value as Parameters<typeof reportingOf>[0]);
        }

        this.schedule();
    }

    /** What the folder has checked out now, null outside a repository; kept as the branch this view last read. */
    #readHead(): Head | null {
        const head = this.#app.workspace.head(this.id) ?? null;

        this.#head = JSON.stringify(head);

        return head;
    }

    get value(): ConversationView | undefined {
        return this.#view?.value;
    }

    /** Coalesce bursts of commits (streaming commits land every 100 ms) into one update per client. */
    schedule(): void {
        this.schedulePeek();

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
                ...(record.asked === undefined ? {} : { asked: record.asked }),
                ...(record.askedAt === undefined ? {} : { askedAt: record.askedAt }),
                ...(record.answeredAt === undefined ? {} : { answeredAt: record.answeredAt }),
                ...(record.failed === true ? { failed: true } : {}),
                ...(record.failed === true && record.error === STOPPED ? { stopped: true } : {}),
                ...(record.failed === true && record.error !== undefined && record.error !== STOPPED
                    ? { error: record.error }
                    : {}),
                ...(this.#reporting.has(name) ? { reporting: true } : {}),
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
            // The branch is read from the repository each time, so one Pi or a person switched to shows on the next update.
            branch: this.#readHead(),
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
                          ...this.#app.attribution.submitterOf(item.id as unknown as number, this),
                      },
            ),
            agent: agentInfo(this.#app.models, agentState, this.#app.defaultCwd),
            stats: projectStats(view.docs["pi.usage"] as UsageState | undefined, view.entries),
            clients: [...new Set([...this.clients].map((each) => each.id))].length,
            viewers: [...new Set([...this.clients].map((each) => each.user.name))],
            approvals: this.#app.approvals.forConversation(this.id),
            ...fields,
        });
    }

    /** Update the peek tiles soon: at most once every `PEEK_MS`, and only for tabs whose tile changed. */
    schedulePeek(): void {
        if (this.#peekTimer !== undefined || this.peekers.size === 0) {
            return;
        }

        this.#peekTimer = setTimeout(() => {
            this.#peekTimer = undefined;
            const summary = this.peek();

            if (summary === undefined) {
                return;
            }

            const json = JSON.stringify(summary);

            for (const client of this.peekers) {
                this.#sendPeek(client, summary, json);
            }
        }, PEEK_MS);
        this.#peekTimer.unref();
    }

    /** Send one peeker the tile now, as it starts showing it. */
    pushPeek(client: Client): void {
        const summary = this.peek();

        if (summary !== undefined) {
            this.#peekSent.delete(client);
            this.#sendPeek(client, summary, JSON.stringify(summary));
        }
    }

    #sendPeek(client: Client, summary: PeekSummary, json: string): void {
        if (this.#peekSent.get(client) === json) {
            return;
        }

        this.#peekSent.set(client, json);
        client.send("peek", summary);
    }

    /** This session as a peek tile shows it, from the newest few entries: cheap however long the session is. */
    peek(): PeekSummary | undefined {
        const view = this.#view?.value;

        if (view === undefined) {
            return undefined;
        }

        const recent: ClientEntry[] = [];

        for (let index = view.entries.length - 1; index >= 0; index--) {
            const projected = this.#entry(view.entries[index]!);

            if (projected !== null) {
                recent.push(projected);

                if (recent.length === PEEK_ENTRIES) {
                    break;
                }
            }
        }

        return {
            conversationId: this.id,
            lines: peekLines(
                recent.reverse(),
                projectLive(view.docs["pi.live"] as LiveState | undefined),
            ),
            // Its own calls waiting for someone; for a session, its subagents' too, as they make the session wait.
            approvals: this.#app.approvals
                .all()
                .filter(
                    (request) =>
                        request.conversationId === this.id ||
                        this.#app.rootOf(request.conversationId) === this.id,
                )
                .map((request) => ({
                    id: request.id,
                    conversationId: request.conversationId,
                    tool: request.tool,
                    subject: request.subject.slice(0, PEEK_SUBJECT),
                    reason: request.reason.slice(0, PEEK_REASON),
                    ...(request.requestedBy === undefined
                        ? {}
                        : { requestedBy: request.requestedBy }),
                })),
        };
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

    /** Close shortly after the last client (and peeker) leaves, so a reload does not rebuild the view. */
    closeLater(onClose: () => void): void {
        clearTimeout(this.#closeTimer);
        this.#closeTimer = setTimeout(() => {
            if (this.clients.size === 0 && this.peekers.size === 0) {
                this.close();
                onClose();
            }
        }, 30_000);
        // Waiting to close keeps nothing running: a server that stops (its tabs leaving as it goes) exits at once.
        this.#closeTimer.unref();
    }

    close(): void {
        clearTimeout(this.#timer);
        clearTimeout(this.#closeTimer);
        clearInterval(this.#headTimer);
        clearTimeout(this.#peekTimer);
        this.#peekTimer = undefined;

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
