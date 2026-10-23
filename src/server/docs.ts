/**
 * Pi Pocket's own durable documents. They live next to the transcripts in the same storage and change in the same
 * commits, so a crash never leaves them disagreeing with the conversation.
 *
 * Kinds are part of the stored data: rename one and old sessions lose it.
 */
import type { JsonValue } from "@earendil-works/chord";
import {
    type CheckpointInfo,
    type ConversationId,
    defineDoc,
    defineDocFamily,
    type EntryId,
    type TaskId,
} from "@earendil-works/pi-durable";
import type { Repeat } from "./when.ts";
import type { Worktree } from "./worktrees.ts";

/**
 * Every document here keeps only its current value, so its stored history is one base and the deltas after it, and a
 * cold read replays them all: without a new base now and then, a busy one (spend, the sessions list) replays tens of
 * thousands. Writing a base drops the revisions before it. Not part of the stored semantics, so safe to change.
 */
const rebased = {
    checkpointWhen: (_value: unknown, _ops: unknown, info: CheckpointInfo) =>
        info.deltasSinceBase >= 64,
};

export type SessionMeta = {
    title?: string;
    cwd: string;
    createdAt: number;
    updatedAt: number;
    createdBy?: string;
    archived?: boolean;
    /** The session this one was forked from, and the last entry it inherited; no entry: forked before the first message. */
    forkedFrom?: { id: number; entryId?: number };
    /** The session that started this one (`linked-sessions.ts`): a link only, which gives no access and owns nothing. */
    linkedFrom?: { id: number };
    /** The most Pi may spend here, in dollars, subagents included. */
    budget?: number;
    /** The git worktree the session works in, when it has one of its own. */
    worktree?: Worktree;
    /** The session of Pi's in the terminal this one continues, and how many messages its file had then. */
    fromPi?: { session: string; count: number };
    /**
     * The id of the person whose PiP this is: their assistant, which looks after their other sessions (`pip.ts`). PiP is
     * kept out of the session list; an older Pi Pocket, which does not know this field, lists it as a session.
     */
    pip?: string;
};

/** The catalogue of user-facing sessions: ownerless conversations created by the app. Subagents are not listed. */
export const SessionsDoc = defineDoc<{ items: Record<string, SessionMeta> }>({
    kind: "pocket.sessions",
    version: 1,
    ...rebased,
    scope: "session",
    initial: () => ({ items: {} }),
});

/** Favorite working folders in shortcut order, private to each person and shared by their devices. */
export const FolderFavoritesDoc = defineDoc<{ users: Record<string, string[]> }>({
    kind: "pocket.folder-favorites",
    version: 1,
    ...rebased,
    scope: "session",
    initial: () => ({ users: {} }),
});

/**
 * The addresses this session knows its linked sessions by, so no session id goes into its transcript. A fork starts with
 * none, so it leaves the team: the addresses in the history it inherited do not resolve there.
 */
export const LinkedSessionPeersDoc = defineDoc<{ peers: Record<string, number> }>({
    kind: "pocket.linked-session-peers",
    version: 1,
    ...rebased,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({ peers: {} }),
});

/**
 * Messages between the linked sessions of one team since a person last wrote in any of them, kept on the team's top
 * session (`linked-sessions.ts`). Since 0.19.0 no count stops them: before, sessions stopped past 20 until a person wrote.
 */
export const LinkedSessionRelayDoc = defineDoc<{ sent: number }>({
    kind: "pocket.linked-session-relay",
    version: 1,
    ...rebased,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({ sent: 0 }),
});

/**
 * What each call to start or message a linked session did, by its key hashed with the session: the session it made or
 * messaged, whom Pi worked for, and when. A call run again finds it, so it acts once. `linked-sessions.ts` keeps them
 * 30 days, and the newest 1000, as `shell.ts` keeps its requests. (Not a document family: those cannot be pruned.)
 */
export const LinkedSessionCallsDoc = defineDoc<{
    items: Record<string, { conversationId?: number; by?: string; at: number }>;
}>({
    kind: "pocket.linked-session-calls",
    version: 1,
    ...rebased,
    scope: "conversation",
    history: "latest",
    fork: "initial",
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
    ...rebased,
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
    /**
     * Made by `artifact_inline`: a card in a reply shows this version, so its artifact stays HTML (`type` is per
     * artifact, and would change every version's page).
     */
    inline?: true;
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
    ...rebased,
    scope: "conversation",
    history: "latest",
    fork: "current",
    initial: () => ({ items: {} }),
});

/** One artifact version's content, keyed `<artifactId>@<version>`. */
export const ArtifactBodyDoc = defineDocFamily<{ content: string }, { content: string }>({
    kind: "pocket.artifact-body",
    version: 1,
    ...rebased,
    family: true,
    scope: "conversation",
    history: "latest",
    fork: "current",
    initial: (seed) => ({ content: seed.content }),
});

/** What one person saved for one artifact (`artifact-state.ts`): a JSON value, the page's schema label, and when. */
export type ArtifactStateValue = { value: JsonValue; schema?: string; at: number };

/**
 * What artifact pages save for the people who use them, by artifact id, then person id: a filter, a form's inputs. It is
 * not in the model's context, and a fork starts with none: each person's state stays in the session it was saved in.
 */
export const ArtifactStateDoc = defineDoc<{
    items: Record<string, Record<string, ArtifactStateValue>>;
}>({
    kind: "pocket.artifact-state",
    version: 1,
    ...rebased,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({ items: {} }),
});

/**
 * One artifact version published to anyone with its address (`share.ts`), under a token that is the whole of the access:
 * no sign-in. `version` is the version it shows, or absent to follow the artifact's newest.
 */
export type ArtifactShare = {
    /** The conversation the artifact is in. */
    conversation: string;
    id: string;
    version?: number;
    /** Who published it, and when. */
    by: string;
    createdAt: number;
    /** When it closes; absent: never. */
    expiresAt?: number;
};

/** The artifact shares of the whole app, by their token. */
export const ArtifactSharesDoc = defineDoc<{ items: Record<string, ArtifactShare> }>({
    kind: "pocket.artifact-shares",
    version: 1,
    ...rebased,
    scope: "session",
    initial: () => ({ items: {} }),
});

export type SubagentRecord = {
    conversationId: ConversationId;
    /** Answers already reported to the parent: several messages can end in one answer, reported once. */
    reported: EntryId[];
    /** What the parent asked it last, the start of it, and when. */
    asked?: string;
    askedAt?: number;
    /**
     * When it last answered, or failed to (`failed`), what the parent asked, or, once it failed, a person's own message to
     * it; and why it failed, or that it was stopped.
     */
    answeredAt?: number;
    failed?: boolean;
    error?: string;
    /**
     * The failure a person dealt with (seen, or dismissed), by its `answeredAt`: it needs nobody now. A later failure has
     * a later time, so it needs them again.
     */
    dealtAt?: number;
};

/** A subagent's report waiting to go to its parent: all those waiting go together, as one message. */
export type PendingReport = { name: string; text: string };

/** Values codemode scripts keep with `store(key, value)`, read back with `load(key)` in later scripts. */
export const CodemodeStoreDoc = defineDoc<{ values: Record<string, JsonValue> }>({
    kind: "pocket.codemode-store",
    version: 1,
    ...rebased,
    scope: "conversation",
    history: "latest",
    fork: "current",
    initial: () => ({ values: {} }),
});

/** A conversation's named background subagents, and the reporter task of each message sent to them. */
export const SubagentsDoc = defineDoc<{
    agents: Record<string, SubagentRecord>;
    reporters: Record<string, TaskId>;
    /** Reports not yet sent to the parent. */
    outbox?: PendingReport[];
    /** The task sending them, while there is one. */
    courier?: TaskId;
    /**
     * The batch taken from the outbox, kept until it has left the parent's queue, with the request id it goes with: a
     * courier that stops before then leaves it to the next, which sends it again under that id, so it goes once.
     */
    sending?: {
        request: string;
        reports: PendingReport[];
        /** A person took it out of the parent's queue (the queue's ×, or Stop): it is gone, not sent again. */
        discarded?: true;
    };
    /** How many batches went so far, for their request ids. */
    batches?: number;
    /**
     * Why the reports wait, while a spend limit holds them back: the parent would start a turn for them that its
     * session, or whoever pays there, may not pay for. They go when the limit is raised.
     */
    held?: string;
    /** An earlier build's names of the batch in the queue: no longer written, and cleared where found. */
    delivering?: string[];
}>({
    kind: "pocket.subagents",
    version: 1,
    ...rebased,
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
    ...rebased,
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
    ...rebased,
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
    ...rebased,
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
    ...rebased,
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
    ...rebased,
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
    ...rebased,
    scope: "conversation",
    history: "latest",
    fork: "current",
    initial: () => ({ calls: {} }),
});

/** The text a subagent report starts with; the UI renders these as report cards. */
export const REPORT_PREFIX = "[subagent ";

/** Why a subagent that was stopped did not answer, in its report and its record. */
export const STOPPED = "stopped before it answered";

/** Plan mode: while on, Pi reads and proposes, and anything that would change something is blocked. */
export const PlanDoc = defineDoc<{ on: boolean; by?: string; at?: number }>({
    kind: "pocket.plan",
    version: 1,
    ...rebased,
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
    ...rebased,
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
    ...rebased,
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
    ...rebased,
    scope: "session",
    initial: () => ({ people: {}, counted: {} }),
});

export type Lesson = {
    /** Short and stable: what Pi and people use to change or remove it. */
    id: string;
    text: string;
    /** The project it is for (`memory.ts`: the repository's shared git folder, or the folder); absent: everywhere. */
    project?: string;
    /** The project's folder name, for people to read. */
    projectName?: string;
    /** The session it came from: a subagent's lesson is its session's. */
    from?: { conversationId: number; title: string };
    /** Who saved it, or whom Pi worked for when it did. */
    by: string;
    byPi: boolean;
    createdAt: number;
    updatedAt?: number;
    /** Saved by Pi, or by someone who is not the owner: unused until the owner approves it. */
    pending?: boolean;
    /**
     * A change to it in force that waits for the owner, as Pi or a guest proposed it: new text, or forgetting it. The
     * lesson stays as it is until then.
     */
    proposal?: { text?: string; forget?: boolean; by: string; byPi: boolean; at: number };
    /** The tool call that made it, `taskId:callId`: the call run again finds it instead of saving another. */
    key?: string;
};

/**
 * Memory: short lessons Pi keeps across sessions, by id, for one project or everywhere. Pi gets those that apply in
 * its system prompt (`extensions/memory.ts`).
 */
export const MemoryDoc = defineDoc<{ items: Record<string, Lesson> }>({
    kind: "pocket.memory",
    version: 1,
    ...rebased,
    scope: "session",
    initial: () => ({ items: {} }),
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
    ...rebased,
    scope: "conversation",
    history: "latest",
    fork: "current",
    initial: () => ({}),
});

/**
 * The extensions' commands one person ran here, keyed by the person's id: each request id with its task, oldest first.
 * A request sent again, also after a restart, finds its task. A fork starts without them.
 */
export const CommandRequestsDoc = defineDocFamily<{ items: Record<string, number> }, null>({
    kind: "pocket.extension-command-request",
    version: 1,
    ...rebased,
    family: true,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({ items: {} }),
});

/**
 * The `!` commands people started here, by request id (`user:request`), oldest first: a request sent again after its
 * reply was lost runs its command once, also across a restart. A fork starts without them.
 */
export const ShellRequestsDoc = defineDoc<{ items: Record<string, number> }>({
    kind: "pocket.shell-requests",
    version: 1,
    ...rebased,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({ items: {} }),
});

/**
 * PiP's follows (`pip.ts`), by the key of the tool call that made each, so a call run again finds the follow it made.
 * `doneAt` marks one that reported (or was stopped); it stays a day, then goes.
 */
export const FollowsDoc = defineDoc<{
    items: Record<string, { taskId: number; session: number; at: number; doneAt?: number }>;
}>({
    kind: "pocket.pip-follows",
    version: 1,
    ...rebased,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({ items: {} }),
});

/**
 * Which provider pays, as PiP was last told to ask its person (`pip.ts`): the models their words named, at more than one
 * provider, and the newest entry of PiP's conversation then (`at`). Their next message answers it when it is just one of
 * those providers' whole name or id, in the same context.
 */
export const PipAskedDoc = defineDoc<{
    asked?: { models: { provider: string; id: string }[]; at: number };
}>({
    kind: "pocket.pip-asked",
    version: 1,
    ...rebased,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({}),
});

/**
 * PiP's compactions whose summary PiP wrote itself (`pip-compact.ts`), by task id: their cost is in `pi.usage`, added
 * once. The newest few are kept.
 */
export const PipCompactionDoc = defineDoc<{ counted: number[] }>({
    kind: "pocket.pip-compaction",
    version: 1,
    ...rebased,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({ counted: [] }),
});

/** Whether a PR watch still looks (`watching`), or why it stopped. */
export type WatchStatus = "watching" | "merged" | "closed" | "gave-up" | "failed" | "expired";

/** A session's watch of its pull request (`watches.ts`). */
export type PrWatch = {
    /** `owner/name`, or `host/owner/name` for GitHub Enterprise. */
    repo: string;
    number: number;
    url: string;
    title: string;
    branch: string;
    /** The PR is in another repository than the session's folder: Pi is told to work in a checkout of it. */
    elsewhere?: boolean;
    /**
     * `gh`'s account could not push to the PR's repository when the watch began, so GitHub does not tell it who can
     * write there: members' and collaborators' remarks do not count, only the owner's (and bots' reviews).
     */
    unchecked?: boolean;
    /** Whose work it is: messages go to Pi for them, and their checks and spend limit apply. */
    by: string;
    /** Pi set it up, for `by`. */
    byPi?: boolean;
    createdAt: number;
    /** The durable task that looks. */
    taskId: TaskId;
    status: WatchStatus;
    /** When it looks next. */
    next: number;
    /** Messages sent to Pi, and the most it sends. */
    sent: number;
    max: number;
    /** Comments older than this were there before the watch: ISO time, as GitHub gives it. */
    since: string;
    /** Comments, reviews, and review comments told already, by id. */
    seen: string[];
    /** The commit whose failed checks Pi was told about, and the one whose conflicts. */
    failedSha?: string;
    conflictSha?: string;
    /** What the last look found, for the bar: the checks of the PR's last commit. */
    checks?: "pending" | "passed" | "failed" | "none";
    lastAt?: number;
    /** When it last found something to tell: two weeks with nothing and it stops. */
    lastNewsAt: number;
    /** Looks or sends in a row that failed, and why the last did: it stops after a while of them. */
    errors: number;
    note?: string;
    /** The tool call that set it up, so a replayed call finds it. */
    key?: string;
};

/** A session's PR watch. A fork starts without it: the PR is the session's. */
export const WatchDoc = defineDoc<{ watch?: PrWatch }>({
    kind: "pocket.pr-watch",
    version: 1,
    ...rebased,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({}),
});

/** A webhook (`hooks.ts`): an address that turns each post to it into a message to a session's Pi, or to PiP. */
export type Hook = {
    /** In its address, with the secret. */
    id: string;
    secret: string;
    name: string;
    /** What Pi should do with each post: the message's first part. */
    instructions: string;
    /** The session (or PiP) it messages. */
    target: number;
    /**
     * For GitHub: a post gets in only with GitHub's signature made with the secret, which is not in the address, so
     * whoever sees the address (a repository's admins do) cannot post as the hook. Absent: the secret is in the address.
     */
    signed?: boolean;
    /**
     * For GitHub: posts about what people outside the repository wrote (not its owner, nor members or collaborators who
     * can write to it) reach Pi too. Absent: they are dropped. Only a person sets it, in the hooks sheet.
     */
    anyone?: boolean;
    /** Who made it: posts go as their work, with their checks and spend limit. */
    by: string;
    createdAt: number;
    /** Posts that became messages, and when the last did. */
    count: number;
    lastAt?: number;
};

/** Every webhook, by id. */
export const HooksDoc = defineDoc<{ items: Record<string, Hook> }>({
    kind: "pocket.hooks",
    version: 1,
    ...rebased,
    scope: "session",
    initial: () => ({ items: {} }),
});

/** What a repository watch looks for (`repo-watches.ts`). */
export type RepoEvent = "issues" | "pulls" | "ci" | "releases" | "mentions";

/**
 * A watch of a GitHub repository `gh`'s account can push to: what happens there (new issues and PRs, CI failing on a
 * branch, releases, @pi mentions) goes, with its person's standing instructions, to PiP or a session.
 */
export type RepoWatch = {
    /** Short and stable: what PiP and people use to remove it. */
    id: string;
    /** `owner/name`, or `host/owner/name` off github.com, as GitHub spells it. */
    repo: string;
    events: RepoEvent[];
    /** What to do when something comes: the message's first part. */
    instructions: string;
    /** Issues and PRs with this label only. */
    label?: string;
    /** Issues and PRs assigned to `gh`'s account only. */
    assigned?: boolean;
    /** The branch whose failing CI counts; the repository's default branch. */
    branch: string;
    /**
     * Issues and PRs from anyone, not only from the repository's owner, and members and collaborators who can write to
     * it (and bots' PRs).
     * Only a person turns it on, in the hooks sheet; PiP cannot.
     */
    anyone?: boolean;
    /** The conversation it messages: its person's PiP, or a session. */
    target: number;
    /** Whose work it is: messages go for them, with their checks and spend limit. */
    by: string;
    /** PiP set it up, for `by`. */
    byPi: boolean;
    createdAt: number;
    /** What happened before this (ISO, as GitHub writes times) was there before the watch. */
    since: string;
    taskId: TaskId;
    /** When it looks next. */
    next: number;
    /** What was told already, by kind and id (`i12`, `p7`, `r123`, `v9`, `c456`, `l789`). */
    seen: string[];
    /** Messages sent, and when the last one went. */
    count: number;
    lastNewsAt?: number;
    /** When it last looked, and how many looks in a row failed, with why the last did. */
    lastAt?: number;
    errors: number;
    note?: string;
    /** The tool call that set it up, so a replayed call finds it. */
    key?: string;
};

/** Every repository watch, by id. */
export const RepoWatchesDoc = defineDoc<{ items: Record<string, RepoWatch> }>({
    kind: "pocket.repo-watches",
    version: 1,
    ...rebased,
    scope: "session",
    initial: () => ({ items: {} }),
});
