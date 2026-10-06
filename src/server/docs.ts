/**
 * Pi Pocket's own durable documents. They live next to the transcripts in the same storage and change in the same
 * commits, so a crash never leaves them disagreeing with the conversation.
 *
 * Kinds are part of the stored data: rename one and old sessions lose it.
 */
import type { JsonValue } from "@earendil-works/chord";
import {
    type ConversationId,
    defineDoc,
    defineDocFamily,
    type EntryId,
    type TaskId,
} from "@earendil-works/pi-durable";
import type { Repeat } from "./when.ts";
import type { Worktree } from "./worktrees.ts";

export type SessionMeta = {
    title?: string;
    cwd: string;
    createdAt: number;
    updatedAt: number;
    createdBy?: string;
    archived?: boolean;
    /** The session this one was forked from, and the last entry it inherited; no entry: forked before the first message. */
    forkedFrom?: { id: number; entryId?: number };
    /** The most Pi may spend here, in dollars, subagents included. */
    budget?: number;
    /** The git worktree the session works in, when it has one of its own. */
    worktree?: Worktree;
};

/** The catalogue of user-facing sessions: ownerless conversations created by the app. Subagents are not listed. */
export const SessionsDoc = defineDoc<{ items: Record<string, SessionMeta> }>({
    kind: "pocket.sessions",
    version: 1,
    scope: "session",
    initial: () => ({ items: {} }),
});

/**
 * Who wrote each user message, by entry id. `requesters` holds, for a message no person wrote (a parent's message to
 * its subagent), whose work it is: the person the parent worked for then. `requests` is unused.
 */
export const AuthorsDoc = defineDoc<{
    requests: Record<string, string>;
    entries: Record<string, string>;
    requesters?: Record<string, string>;
}>({
    kind: "pocket.authors",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "current",
    initial: () => ({ requests: {}, entries: {} }),
});

export type ArtifactType = "html" | "markdown" | "svg";

export type ArtifactVersion = {
    version: number;
    /** The tool task that wrote it; a replayed call finds its version instead of writing another. */
    taskId: TaskId;
    /**
     * The call within that task. One codemode task makes many calls; versions from before this field match on the task
     * alone.
     */
    callId?: string;
    size: number;
    createdAt: number;
};

export type ArtifactMeta = {
    title: string;
    type: ArtifactType;
    versions: ArtifactVersion[];
};

/** The artifacts of one conversation, newest version last. Bodies live in `ArtifactBodyDoc`. */
export const ArtifactsDoc = defineDoc<{ items: Record<string, ArtifactMeta> }>({
    kind: "pocket.artifacts",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "current",
    initial: () => ({ items: {} }),
});

/** One artifact version's content, keyed `<artifactId>@<version>`. */
export const ArtifactBodyDoc = defineDocFamily<{ content: string }, { content: string }>({
    kind: "pocket.artifact-body",
    version: 1,
    family: true,
    scope: "conversation",
    history: "latest",
    fork: "current",
    initial: (seed) => ({ content: seed.content }),
});

export type SubagentRecord = {
    conversationId: ConversationId;
    /** Answers already reported to the parent: several messages can end in one answer, reported once. */
    reported: EntryId[];
};

/** Values codemode scripts keep with `store(key, value)`, read back with `load(key)` in later scripts. */
export const CodemodeStoreDoc = defineDoc<{ values: Record<string, JsonValue> }>({
    kind: "pocket.codemode-store",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "current",
    initial: () => ({ values: {} }),
});

/** A conversation's named background subagents, and the reporter task of each message sent to them. */
export const SubagentsDoc = defineDoc<{
    agents: Record<string, SubagentRecord>;
    reporters: Record<string, TaskId>;
}>({
    kind: "pocket.subagents",
    version: 1,
    scope: "conversation",
    history: "latest",
    // A fork starts without subagents: they belong to the conversation that spawned them.
    fork: "initial",
    initial: () => ({ agents: {}, reporters: {} }),
});

export type ChatMessage = {
    /** Made from the client's request id, so a retried send does not post twice. */
    id: string;
    userId: string;
    /** The sender's name when sent, for people removed since. */
    name: string;
    text: string;
    at: number;
    /** "event": a line of activity ("Alex stopped the run"), not something someone wrote. */
    kind?: "event";
    /** People named with `@Name` in the text. */
    mentions?: string[];
    /** A transcript message this one discusses. */
    quote?: { entryId: number; text: string };
};

/** The people's side chat in one conversation, oldest first, with activity lines. Pi does not see it. */
export const ChatDoc = defineDoc<{ messages: ChatMessage[] }>({
    kind: "pocket.chat",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "current",
    initial: () => ({ messages: [] }),
});

/** Messages a chat keeps; older ones drop off. */
export const CHAT_LIMIT = 500;

/** Emoji reactions to transcript entries: entry id → emoji → user ids. */
export const ReactionsDoc = defineDoc<{ entries: Record<string, Record<string, string[]>> }>({
    kind: "pocket.reactions",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "current",
    initial: () => ({ entries: {} }),
});

export type Pin = {
    /** `e<entryId>` or `c<chatId>`: pinning the same thing again unpins it. */
    id: string;
    entryId?: number;
    chatId?: string;
    /** A snippet of what was pinned, taken when pinned. */
    text: string;
    /** Who wrote the pinned message: a person's name or "Pi". */
    author: string;
    by: string;
    at: number;
};

/** Pinned messages of one conversation, newest last. */
export const PinsDoc = defineDoc<{ items: Pin[] }>({
    kind: "pocket.pins",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "current",
    initial: () => ({ items: [] }),
});

export type Notes = { text: string; rev: number; by?: string; at?: number };

/** One shared notes page per conversation. `rev` rises with every save, so two editors cannot overwrite each other unseen. */
export const NotesDoc = defineDoc<Notes>({
    kind: "pocket.notes",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "current",
    initial: () => ({ text: "", rev: 0 }),
});

export type Turns = { on: boolean; driver?: string; asks: string[] };

/** Take turns: while on, only the driver sends to Pi or changes its settings. */
export const TurnsDoc = defineDoc<Turns>({
    kind: "pocket.turns",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({ on: false, asks: [] }),
});

export type Decision = { allow: boolean; by: string; userId: string; at: number };

/** Who allowed or denied each tool call Lancet Guard asked about, by tool call id. */
export const DecisionsDoc = defineDoc<{ calls: Record<string, Decision> }>({
    kind: "pocket.decisions",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "current",
    initial: () => ({ calls: {} }),
});

/** The text a subagent report starts with; the UI renders these as report cards. */
export const REPORT_PREFIX = "[subagent ";

/** Plan mode: while on, Pi reads and proposes, and anything that would change something is blocked. */
export const PlanDoc = defineDoc<{ on: boolean; by?: string; at?: number }>({
    kind: "pocket.plan",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "current",
    initial: () => ({ on: false }),
});

export type Schedule = {
    /** Short and stable: what people and Pi use to cancel it. */
    id: string;
    /** What was asked for, as shown in the list. */
    text: string;
    /** What Pi gets: the text marked as scheduled, with who set it when several people use this server. */
    content: string;
    /** When it goes out next. */
    next: number;
    every?: Repeat;
    /** The time zone its clock times are in. */
    zone: string;
    /** Who set it; absent when Pi did. */
    by?: string;
    /** For one Pi set up: whom Pi worked for then. It goes out as Pi's, but as their work. */
    requestedBy?: string;
    createdAt: number;
    /** How many times it went out: each time sends with its own request id, so a restart never sends one twice. */
    runs: number;
    /** The durable task that sends it. */
    taskId: TaskId;
    /** Set by the same call already, when a tool call is replayed: its `taskId:callId`. */
    key?: string;
};

/** Messages that go to Pi later, or on repeat. A fork starts without them: they belong to who set them up. */
export const ScheduleDoc = defineDoc<{ items: Record<string, Schedule> }>({
    kind: "pocket.schedules",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({ items: {} }),
});

/** The last check of a goal: whether it passed, its exit code, and the end of its output. */
export type GoalCheck = { passed: boolean; code: number; at: number; tail: string };

/**
 * "Done when": Pi keeps working until a check command passes, up to `max` checks. `counted` holds the generation
 * tasks whose answer was checked already, so an answer replayed after a restart is not counted twice.
 */
export type Goal = {
    command: string;
    by: string;
    max: number;
    tries: number;
    status: "working" | "met" | "gave-up";
    last?: GoalCheck;
    counted: string[];
};

export const GoalDoc = defineDoc<{ goal?: Goal }>({
    kind: "pocket.goal",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({}),
});

/**
 * What Pi spent for each person, in dollars: the work goes to whoever asked for it. `counted` is how much of each
 * conversation's spend is in `people` already, so every dollar is counted once, also across restarts.
 */
export const SpendDoc = defineDoc<{
    people: Record<string, number>;
    counted: Record<string, number>;
}>({
    kind: "pocket.spend",
    version: 1,
    scope: "session",
    initial: () => ({ people: {}, counted: {} }),
});

/**
 * The page a conversation's browser last showed, and its size, to open it again after a restart. The page itself lives
 * in memory only (`browser.ts`).
 */
export const BrowserDoc = defineDoc<{
    url?: string;
    viewport?: { width: number; height: number; scale: number; mobile: boolean };
}>({
    kind: "pocket.browser",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "current",
    initial: () => ({}),
});

/**
 * The `!` commands people started here, by request id (`user:request`), oldest first: a request sent again after its
 * reply was lost runs its command once, also across a restart. A fork starts without them.
 */
export const ShellRequestsDoc = defineDoc<{ items: Record<string, number> }>({
    kind: "pocket.shell-requests",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({ items: {} }),
});
