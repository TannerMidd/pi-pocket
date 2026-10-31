/**
 * PiP, "Pi in Pocket": the owner's assistant, which looks after their other sessions. PiP is a conversation of its own,
 * kept out of the session list and shown in a small panel over whatever is open (`web/pip.js`). Its extension
 * (`extensions/pip.ts`) is selected there only, and gives it tools to list, read, start, message, stop, archive, and
 * schedule sessions, to see the calls waiting for approval and deny them (never allow: that stays a person's), and to
 * follow a session until its run ends. Every tool acts as PiP's person, with exactly their rights: the checks are the
 * ones their own requests meet.
 *
 * A follow is a durable task in PiP's conversation: it waits for the message PiP sent (or for the session to go idle),
 * then sends PiP a report. Request ids keep a restart from sending a message or a report twice.
 *
 * PiP checks before it acts: it messages, stops, archives, schedules in, or watches a PR from a session only after it
 * looked at that session lately (read it, started it, or had a report from it). And it never chooses a model: it passes
 * one, or names one in what it sends, only when its person named that model in their own words to it.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
    AgentDoc,
    AssistantEntry,
    CompactionEntry,
    type ConversationId,
    type Cursor,
    defineTask,
    InboxDoc,
    LiveDoc,
    ResetEntry,
    type Task,
    type TaskRuntime,
    type Tx,
} from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import type { User } from "./config.ts";
import { AuthorsDoc, FollowsDoc, PipAskedDoc, SessionsDoc } from "./docs.ts";
import { NOTE_ENTRY } from "./entry-format.ts";
import { describe, HttpError } from "./errors.ts";
import { clip, defang, quoted } from "./fence.ts";
import { git } from "./git.ts";
import { originRepo, parseRepo, requirePush, sameRepo } from "./github.ts";
import { indexed, modelsNamed, personNamed, sharePhrase, words } from "./model-names.ts";
import { findModel } from "./models.ts";
import { homePath } from "./paths.ts";
import { type ClientEntry, projectEntry, snippet } from "./projection.ts";
import type { RepoWatchRequest, RepoWatchView } from "./repo-watches.ts";
import { clientKey, requestFor } from "./requests.ts";
import { describeMoment, describeRepeat } from "./when.ts";

const context = BACKGROUND_CONTEXT;

/** PiP's extension: its tools, its prompt, and the follow task. Selected in PiP's conversation only. */
export const PIP_EXTENSION = "pocket-pip";
/** What PiP is called, in the app and in what it sends. */
export const PIP_NAME = "PiP";
/**
 * The extensions PiP runs with, in order. Not the system prompt (PiP's extension has its own) nor anything that works
 * on files and commands beyond reading: PiP hands hands-on work to sessions.
 */
export const PIP_EXTENSIONS = [
    "coding-tools",
    // Core's own: its hook takes the values extensions hide (`host.hide`) out of PiP's tool results too.
    "pocket-core",
    PIP_EXTENSION,
    "pocket-artifacts",
    "pocket-schedules",
    "pocket-guard",
    "pocket-codemode",
    "pocket-memory",
];
/**
 * The tools PiP goes without: Pi Durable's coding tools (it reads files, and changes nothing itself), and the artifact
 * card, which its small panel does not draw (`artifact` still opens in the viewer).
 */
export const PIP_WITHOUT = ["bash", "write", "edit", "artifact_inline"];
/** How reports from followed sessions start, so PiP knows what they are. */
export const REPORT_HEAD = "[report] ";
/** Sessions PiP may start in an hour, so a confused loop cannot fill the list. */
const STARTS_PER_HOUR = 20;
/**
 * Messages, follows, and schedules PiP may make in an hour. Reports start PiP's runs with nobody watching: this keeps
 * a loop (follow, report, follow; or PiP and a session messaging each other) from spending without end.
 */
const ACTIONS_PER_HOUR = 60;
/** How long a clone may take, and how long a folder's repository is kept before git is asked again. */
const CLONE_TIMEOUT_MS = 15 * 60_000;
const ORIGIN_FOR_MS = 5 * 60_000;
/** How long a follow that reported is remembered, so a replayed call that made it does not make another. */
const FOLLOW_MEMORY_MS = 24 * 3_600_000;
/** How long PiP's look at a session (a read, its start, a report from it) counts as knowing what it is doing. */
const CHECKED_FOR_MS = 15 * 60_000;
/**
 * How many of PiP's newest entries are searched for the models its person named, at most, and how many at a time: its
 * context (since its last compaction or new context) is searched whole, up to this many.
 */
const NAMED_IN_ENTRIES = 2_000;
const NAMED_IN_PAGE = 200;
/**
 * How long after a follow reported its session's "Pi finished" stays muted: long enough for the push of the same run's
 * end, which comes a few seconds later, and short enough not to mute the next run's.
 */
const REPORTED_JUST_NOW_MS = 60_000;

/** How what a session said reaches PiP: fenced, so it reads as data, not as instructions. */
export const SESSION_OPEN = "<session-output>";
export const SESSION_CLOSE = "</session-output>";
/** Follows waiting at once, at most. */
const MAX_FOLLOWS = 50;
const ANSWER_CHARS = 12_000;
const LINE_CHARS = 600;

type FollowInput = {
    sessionId: ConversationId;
    /** PiP's person: the report is sent for them. */
    userId: string;
    title: string;
    /** The message PiP sent, whose answer the report carries; absent: report when the session is next idle. */
    requestId?: string;
};
type FollowState = { phase: "wait" } | { phase: "report"; text: string };
type FollowRuntime = TaskRuntime<FollowInput, FollowState, null, object>;

/** One session as PiP lists it. */
export type PipSession = {
    id: number;
    title: string;
    state: "working" | "needs approval" | "idle";
    folder: string;
    archived: boolean;
    model?: string;
    branch?: string;
    updatedAt: number;
    subagents?: string;
};

/** What a tab's PiP button shows: whether PiP works, and when it last answered. */
export type PipState = { id: number; busy: boolean; endedAt?: number };

const finished = { status: "terminal", outcome: { status: "completed", result: null } } as const;

/** A session's words, fenced for PiP; a fence inside them cannot end the fence early. */
export function fenced(text: string): string {
    return `${SESSION_OPEN}\n${defang(text)}\n${SESSION_CLOSE}`;
}

/** A tool call's key made into a request id's: short and safe whatever the call ids look like. */
function requestKey(key: string): string {
    return createHash("sha256").update(key).digest("base64url").slice(0, 40);
}

// The note is ours, so it goes outside the fence.
function answerPart(
    text: string,
    from: number,
    session: ConversationId,
): { text: string; note?: string } {
    let end = Math.min(text.length, from + ANSWER_CHARS);

    // Never split a surrogate pair.
    if (end < text.length && /[\uD800-\uDBFF]/.test(text.charAt(end - 1))) {
        end -= 1;
    }

    const left = text.length - end;

    return {
        text: text.slice(from, end),
        note:
            left === 0
                ? undefined
                : `[… ${left} more characters: read them with session_read, session ${String(session)}, answerFrom ${end}]`,
    };
}

function textOf(message: AssistantMessage | undefined): string {
    return (message?.content ?? [])
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("")
        .trim();
}

/** A tool call in a few words: its name and its first short argument. */
function callLine(name: string, args: Record<string, unknown>): string {
    const first = Object.values(args).find(
        (value) => typeof value === "string" && value.trim() !== "",
    ) as string | undefined;

    return first === undefined ? name : `${name} ${snippet(first, 120)}`;
}

/** How long ago, in a word or two. */
export function ago(moment: number, now: number): string {
    const minutes = Math.round((now - moment) / 60_000);

    if (minutes < 1) {
        return "just now";
    }

    if (minutes < 60) {
        return `${minutes}m ago`;
    }

    const hours = Math.round(minutes / 60);

    return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

export class Pip {
    readonly #app: PocketApp;
    /** A PiP being made, by person, so two tabs opening it at once make one. */
    readonly #creating = new Map<string, Promise<ConversationId>>();
    /** When each PiP started its recent sessions, and made its recent messages and follows: for the hourly limits. */
    readonly #recent = new Map<string, number[]>();
    /** Clones under way, by repository, so two asks clone once; and folders' repositories, kept a few minutes. */
    readonly #cloning = new Map<string, Promise<string>>();
    readonly #origins = new Map<string, { repo: string | undefined; at: number }>();
    /**
     * When each PiP last looked at each session (`pip:session`): read it, started it, or had a report from it. In
     * memory: after a restart PiP looks again before it acts.
     */
    readonly #checked = new Map<string, number>();
    /** The durable task behind each follow; PiP's extension installs it. */
    readonly task: Task<FollowInput, FollowState, null, object>;
    /** How long a report waits before it looks again whether PiP is back on (tests shorten it). */
    holdMs = 60_000;

    constructor(app: PocketApp) {
        this.#app = app;
        this.task = defineTask<FollowInput, FollowState, null>({
            name: "pocket.pip-follow",
            version: 1,
            initial: () => ({ phase: "wait" }),
            phases: {
                wait: (task, runtime, context) => this.#wait(task.input, runtime, context),
                report: (task, runtime, context) =>
                    this.#report(task.input, task.state.checkpoint.text, runtime, context),
            },
            abort: (_task, runtime, context) =>
                runtime.commit(async (tx) => {
                    await this.#settleFollow(tx, runtime.conversationId, Number(runtime.taskId));

                    return { status: "terminal", outcome: { status: "aborted" } } as const;
                }, context),
        });
    }

    // ─── Whose PiP ──────────────────────────────────────────────────────────

    /** Whether this person may have a PiP: the owner, while its extension is on. */
    available(user: User): boolean {
        return user.role === "owner" && this.#app.loader.extensionNames().includes(PIP_EXTENSION);
    }

    /** The conversation of this person's PiP, once they have one. */
    idOf(userId: string): ConversationId | undefined {
        for (const [id, meta] of Object.entries(this.#app.sessionCatalogue())) {
            if (meta.pip === userId) {
                return Number(id) as unknown as ConversationId;
            }
        }

        return undefined;
    }

    /**
     * PiP turned off: each one's run stops, and any compaction of its context, which would go on without PiP's own
     * summary (`pip-compact.ts`) and read what came from outside as it is. Nothing new reaches it until it is back.
     */
    async stopAll(): Promise<void> {
        const app = this.#app;

        for (const user of app.config.users) {
            const id = this.idOf(user.id);

            if (id === undefined) {
                continue;
            }

            try {
                await (await app.conversation(id)).abort(context);

                for (const compaction of (await app.harness.snapshot(LiveDoc, id, context))
                    ?.compactions ?? []) {
                    await app.harness.abortTask(compaction.taskId, context);
                }
            } catch (error) {
                app.log(`PiP ${String(id)} was not stopped: ${describe(error)}`);
            }
        }
    }

    /** The person whose PiP a conversation is; undefined for every other conversation. */
    ownerOf(conversationId: ConversationId): string | undefined {
        return this.#app.sessionMeta(conversationId)?.pip;
    }

    /** The name of the person whose PiP a conversation is; undefined for every other conversation. */
    ownerName(conversationId: ConversationId): string | undefined {
        const userId = this.ownerOf(conversationId);

        return userId === undefined
            ? undefined
            : (this.#app.config.userById(userId)?.name ?? "the owner");
    }

    /** What this person's PiP button shows; null when they have no PiP. */
    state(user: User): PipState | null {
        const id = this.available(user) ? this.idOf(user.id) : undefined;

        if (id === undefined) {
            return null;
        }

        const endedAt = this.#app.endedAt(id);

        return {
            id: Number(id),
            busy: this.#app.isBusy(id),
            ...(endedAt === undefined ? {} : { endedAt }),
        };
    }

    /** This person's PiP, made the first time they open it. Its agent is set to what PiP runs with each time. */
    async ensure(user: User): Promise<ConversationId> {
        if (user.role !== "owner") {
            throw new HttpError(403, "PiP is the owner's for now.");
        }

        if (!this.available(user)) {
            throw new HttpError(409, "PiP is turned off in Extensions.");
        }

        const existing = this.idOf(user.id);

        if (existing !== undefined) {
            await this.#tune(existing);

            return existing;
        }

        let pending = this.#creating.get(user.id);

        if (pending === undefined) {
            pending = this.#create(user).finally(() => this.#creating.delete(user.id));
            this.#creating.set(user.id, pending);
        }

        return pending;
    }

    async #create(user: User): Promise<ConversationId> {
        const app = this.#app;
        const initial = app.commands.defaultModel();
        const now = Date.now();
        const cwd = app.defaultCwd;
        const conversation = await app.harness.createConversation(
            {
                ownership: { kind: "ownerless" },
                agent: {
                    cwd,
                    ...(initial.model === undefined ? {} : { model: initial.model }),
                    ...(initial.thinkingLevel === undefined
                        ? {}
                        : { thinkingLevel: initial.thinkingLevel }),
                },
                init: async (tx, id) => {
                    const agent = await tx.doc(AgentDoc, id);

                    agent.extensions = [...PIP_EXTENSIONS];
                    agent.tools = { remove: [...PIP_WITHOUT] };
                    (await tx.doc(SessionsDoc)).items[String(id)] = {
                        title: PIP_NAME,
                        cwd,
                        createdAt: now,
                        updatedAt: now,
                        createdBy: user.id,
                        pip: user.id,
                    };
                },
            },
            context,
        );

        return conversation.id;
    }

    /**
     * Give every PiP what this version runs it with, before work resumes: a run or a report that comes before anyone opens
     * the panel then runs with it too (its hook that hides values, say).
     */
    async tuneAll(log: (line: string) => void): Promise<void> {
        for (const [id, meta] of Object.entries(this.#app.sessionCatalogue())) {
            if (meta.pip === undefined) {
                continue;
            }

            // One that fails is logged, and the others still get theirs.
            try {
                await this.#tune(Number(id) as unknown as ConversationId);
            } catch (error) {
                log(
                    `PiP ${id} could not be brought up to date: ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        }
    }

    /** Give PiP the extensions and tools this version runs it with, when it has others (made by an older one). */
    async #tune(id: ConversationId): Promise<void> {
        const agent = await this.#app.agentState(id);
        const want = JSON.stringify({ extensions: PIP_EXTENSIONS, tools: { remove: PIP_WITHOUT } });

        if (JSON.stringify({ extensions: agent?.extensions, tools: agent?.tools }) === want) {
            return;
        }

        await this.#app.harness.commit(async (tx) => {
            const state = await tx.doc(AgentDoc, id);

            state.extensions = [...PIP_EXTENSIONS];
            state.tools = { remove: [...PIP_WITHOUT] };
        }, context);
    }

    /** Count one more of PiP's actions of a kind, or refuse when it made `max` in the last hour. */
    #count(user: User, kind: "start" | "act", max: number): void {
        const key = `${user.id}:${kind}`;
        const now = Date.now();
        const recent = (this.#recent.get(key) ?? []).filter((at) => now - at < 3_600_000);

        if (recent.length >= max) {
            throw new Error(
                kind === "start"
                    ? `You started ${String(max)} sessions in the last hour; wait, or ask the person to start more themselves.`
                    : `You made ${String(max)} messages, follows, schedules, and watches in the last hour; wait before making more.`,
            );
        }

        this.#recent.set(key, [...recent, now]);
    }

    /**
     * A schedule set up in `conversationId` under `key` by `make`, counted as one of PiP's actions when PiP sets it up:
     * in its own conversation (its schedule tool), or for `user` in a session. A key already used finds its schedule
     * without counting again; a schedule `make` refuses (a `when` it cannot read) gives its count back.
     */
    async countSchedule<T>(
        conversationId: ConversationId,
        key: string,
        make: () => Promise<T>,
        user?: User,
    ): Promise<T> {
        const app = this.#app;
        const counted =
            user ??
            (this.ownerOf(conversationId) === undefined ? undefined : this.#person(conversationId));

        if (
            counted === undefined ||
            (await app.schedules.list(conversationId)).some((item) => item.key === key)
        ) {
            return make();
        }

        return this.#counted(counted, make);
    }

    /** Do `make`, counted as one of PiP's actions; refused (nothing made), it gives its count back. */
    async #counted<T>(user: User, make: () => Promise<T>): Promise<T> {
        this.#count(user, "act", ACTIONS_PER_HOUR);

        try {
            return await make();
        } catch (error) {
            this.#recent.get(`${user.id}:act`)?.pop();

            throw error;
        }
    }

    /**
     * Send a message for PiP's person, once for a key however often the call runs: a message already sent under it is
     * found, not sent again (nor checked again: a limit reached since does not undo it).
     */
    async #submit(
        id: ConversationId,
        user: User,
        text: string,
        key: string,
        steer: boolean,
        checks: () => Promise<void> = async () => {},
    ): Promise<string> {
        const app = this.#app;
        const asked = requestKey(key);
        const requestId = requestFor(user.id, clientKey(asked));
        let sent = false;

        await app.harness.commit(async (tx) => {
            sent = (await tx.submissionByRequest(id, requestId)) !== undefined;
        }, context);

        if (sent) {
            return requestId;
        }

        // Only a message not sent yet: a replayed call finds the one it sent, whatever PiP knows after a restart.
        await checks();
        this.#count(user, "act", ACTIONS_PER_HOUR);

        return (
            await app.commands.submit(
                id,
                user,
                { text, requestId: asked, ...(steer ? { mode: "steer" as const } : {}) },
                PIP_NAME,
            )
        ).requestId;
    }

    /** PiP's person, from its conversation; an error when the conversation is no PiP, or its person is gone. */
    #person(pipId: ConversationId): User {
        const userId = this.ownerOf(pipId);
        const user = userId === undefined ? undefined : this.#app.config.userById(userId);

        if (user === undefined) {
            throw new Error("Only PiP has these tools.");
        }

        return user;
    }

    /** A session PiP may act on: one its person can see, and not PiP itself. */
    #session(pipId: ConversationId, user: User, sessionId: number): ConversationId {
        const id = sessionId as unknown as ConversationId;

        if (id === pipId) {
            throw new Error("That is your own conversation.");
        }

        if (this.#app.sessionMeta(id)?.pip !== undefined) {
            throw new Error(`There is no session ${String(sessionId)}.`);
        }

        if (this.#app.sessionMeta(id) === undefined) {
            throw new Error(`There is no session ${sessionId}. List them with the sessions tool.`);
        }

        this.#app.requireSee(user, id);

        return id;
    }

    /** PiP just looked at a session, and knows what it is doing. */
    #looked(pipId: ConversationId, sessionId: ConversationId | number): void {
        this.#checked.set(`${String(pipId)}:${String(sessionId)}`, Date.now());
    }

    /**
     * Refuse to act on a session PiP has not looked at lately: what it would send or stop may be what the session does
     * not need. `doing` says what in a few words ("message", "stop").
     */
    #requireLooked(pipId: ConversationId, sessionId: number, doing: string): void {
        const at = this.#checked.get(`${String(pipId)}:${String(sessionId)}`);

        if (at === undefined || Date.now() - at > CHECKED_FOR_MS) {
            throw new Error(
                `Check /s/${String(sessionId)} first with session_read (a few entries may be enough): see what it is doing now, and ${doing} it only if it needs that.`,
            );
        }
    }

    /**
     * What PiP's person said to it in their own words: their messages in its context now, newest first (since its last
     * new context, and those its last compaction kept), and the standing instructions of the watches and webhooks to it
     * that they set up. Never the instructions of a watch PiP set up (its own words, checked against the models signed
     * in then), what was posted to a webhook, what GitHub said, a report, or anything else sent for them. Each message
     * apart: a short name's family word counts in its own message only. `messages`: their messages alone, with their
     * entries, newest first. `newest`: the newest entry of PiP's conversation; `since`: where its context starts, as far
     * as this read (its new context's entry, the oldest its last compaction kept, or the oldest read).
     */
    async #personWords(
        pipId: ConversationId,
        user: User,
    ): Promise<{
        words: string[];
        messages: { id: number; text: string }[];
        newest: number | undefined;
        since: number;
    }> {
        const app = this.#app;
        const own = (await app.harness.snapshot(AuthorsDoc, pipId, context))?.entries ?? {};
        const conversation = await app.conversation(pipId);
        const messages: { id: number; text: string }[] = [];
        // A compaction keeps the newest messages before it as they were: down to its head, they are still in context.
        let keptFrom: number | undefined;
        let cursor: Cursor | undefined;
        let read = 0;
        let newest: number | undefined;
        let since = 0;

        scan: do {
            const page = await conversation.entries({}, NAMED_IN_PAGE, cursor, context);

            for (const entry of page.items) {
                newest ??= Number(entry.id);

                if (entry.kind === ResetEntry.kind) {
                    since = Number(entry.id);

                    break scan;
                }

                if (keptFrom !== undefined && entry.id < keptFrom) {
                    since = keptFrom;

                    break scan;
                }

                since = Number(entry.id);

                if (entry.kind === CompactionEntry.kind) {
                    keptFrom ??= entry.head ?? Number(entry.id);

                    continue;
                }

                const shown = projectEntry(entry);

                if (shown?.kind === "user" && own[String(shown.id)] === user.id) {
                    messages.push({ id: shown.id, text: shown.text });
                }
            }

            read += page.items.length;
            cursor = page.next;
        } while (cursor !== undefined && read < NAMED_IN_ENTRIES);

        const target = Number(pipId);
        const standing = [
            ...(await app.repoWatches.list(user)).filter(
                (watch) => watch.by === user.id && !watch.byPi && watch.target === target,
            ),
            ...(await app.hooks.list(user)).filter(
                (hook) => hook.by === user.id && hook.target === target,
            ),
        ];

        return {
            words: [
                ...messages.map((each) => each.text),
                ...standing.map((each) => each.instructions ?? ""),
            ],
            messages,
            newest,
            since,
        };
    }

    /**
     * Whether the person's newest message (`person`'s) answers the question PiP was last told to ask, which provider pays
     * (`PipAskedDoc`), with `model`'s: asked in PiP's context now, it is their first message since, and just the whole
     * name or id of the provider of one of the models asked about, `model` among them, and of no other provider asked
     * about. Everyday words ("sure", "go") answer nothing, and no question from before PiP's context began is answered:
     * one from before Start fresh (whenever that came: sent while PiP works, it waits for its next pause), one from
     * before what its last compaction kept, or one an earlier build kept (without `at`).
     */
    async #answered(
        pipId: ConversationId,
        model: { provider: string; id: string },
        person: { messages: readonly { id: number; text: string }[]; since: number },
        providerName: (provider: string) => string,
    ): Promise<boolean> {
        const asked = (await this.#app.harness.snapshot(PipAskedDoc, pipId, context))?.asked;
        const [newest, before] = person.messages;

        if (
            typeof asked?.at !== "number" ||
            asked.at < person.since ||
            newest === undefined ||
            newest.id <= asked.at ||
            (before !== undefined && before.id > asked.at) ||
            !asked.models.some((each) => each.provider === model.provider && each.id === model.id)
        ) {
            return false;
        }

        const answer = words(newest.text).join(" ");
        const answering = [...new Set(asked.models.map((each) => each.provider))].filter(
            (provider) =>
                answer !== "" &&
                [provider, providerName(provider)].some((full) => words(full).join(" ") === answer),
        );

        return answering.length === 1 && answering[0] === model.provider;
    }

    /**
     * The signed-in model PiP may start a session on: one its person named, whose sign-in works now. Anything else is
     * refused, telling PiP to leave the model out or ask, never to pick another.
     */
    async #personsModel(pipId: ConversationId, user: User, spec: string) {
        const app = this.#app;
        const model = findModel(app.models, spec);

        if (model === undefined) {
            throw new Error(
                `${spec} is not a model signed in here. Leave model out (the session starts on the default model), or ask your person which model they mean; do not pick another.`,
            );
        }

        // Read once for the checks below: it can be long.
        const person = await this.#personWords(pipId, user);
        const said = indexed(person.words);
        const available = app.models.getAvailableSnapshot();
        // Every model Pi knows: words that name one not signed in name no shorter one that is.
        const known = app.models.getModels();
        const providerName = (provider: string) =>
            app.models.getProvider(provider)?.name ?? provider;
        const theirs = modelsNamed(said, [model], true, [...available, ...known]).includes(model);
        const named =
            personNamed(said, model, available, providerName, known) ||
            (theirs && (await this.#answered(pipId, model, person, providerName)));

        // Their words name it, but at more than one provider: which one pays is theirs to say. What PiP asks about is kept,
        // for their answer (`#answered`).
        if (!named && theirs) {
            const asked = [
                model,
                ...available.filter(
                    (other) => other.provider !== model.provider && sharePhrase(said, model, other),
                ),
            ];

            await app.harness.commit(async (tx) => {
                (await tx.doc(PipAskedDoc, pipId)).asked = {
                    models: asked.map((each) => ({ provider: each.provider, id: each.id })),
                    at: person.newest ?? 0,
                };
            }, context);

            throw new Error(
                `Your person named ${model.name}, which more than one signed-in provider has: ${[...new Set(asked.map((each) => providerName(each.provider)))].join(", ")}. Ask them which one to use (their answer may be just its name); do not pick one.`,
            );
        }

        if (!named) {
            throw new Error(
                `Your person did not name ${model.provider}/${model.id}. Models are theirs to choose: leave model out (the session starts on the default model), or ask them which model to use.`,
            );
        }

        const problem = await app.providers.problem(
            { provider: model.provider, modelId: model.id },
            true,
        );

        if (problem !== undefined) {
            throw new Error(
                `${model.provider}/${model.id} cannot be used now: ${problem}. Tell your person; do not pick another model.`,
            );
        }

        return { provider: model.provider, modelId: model.id };
    }

    /**
     * Refuse text from PiP that names a model its person did not name: which model to use is theirs to say. Words that
     * name the same model at two providers pass when the person named either: text picks no provider (a subagent's
     * model must be one the owner allows anyway).
     */
    async #requireNoModelChoice(pipId: ConversationId, user: User, text: string): Promise<void> {
        const app = this.#app;
        const available = app.models.getAvailableSnapshot();
        const known = app.models.getModels();
        const written = indexed(text);
        const named = modelsNamed(written, available, true, known, false);

        if (named.length === 0) {
            return;
        }

        const theirs = modelsNamed(
            indexed((await this.#personWords(pipId, user)).words),
            available,
            true,
            known,
        );
        const chosen = named.filter(
            (model) =>
                !theirs.includes(model) &&
                !theirs.some((other) => sharePhrase(written, model, other)),
        );

        if (chosen.length > 0) {
            throw new Error(
                `This names ${chosen.map((model) => `${model.provider}/${model.id}`).join(", ")}, which your person did not name. Which model to use is theirs to say: take it out (a session uses its default model, and its subagents and linked sessions the owner's allowed ones), or ask them first.`,
            );
        }
    }

    /** A session's state now, in a few words, for the results of PiP's tools that act on it. */
    async status(pipId: ConversationId, sessionId: number): Promise<string> {
        const app = this.#app;
        const user = this.#person(pipId);
        const id = this.#session(pipId, user, sessionId);
        const meta = app.sessionMeta(id)!;
        // Messages not taken yet, PiP's just now among them: a session about to start is not idle.
        const waiting = (await app.harness.snapshot(InboxDoc, id, context))?.items.length ?? 0;
        const state = app.approvals
            .all()
            .some((request) => app.rootOf(request.conversationId) === id)
            ? "needs approval"
            : app.isBusy(id)
              ? "working"
              : waiting > 0
                ? "about to start"
                : "idle";

        return `/s/${String(sessionId)} now: ${state}${waiting > 0 ? `, ${String(waiting)} message${waiting === 1 ? "" : "s"} waiting` : ""}${meta.archived === true ? ", archived" : ""}, last active ${ago(meta.updatedAt, Date.now())}.`;
    }

    // ─── What PiP's tools do ────────────────────────────────────────────────

    /** The sessions PiP's person can see, newest first. */
    sessions(
        pipId: ConversationId,
        filter: { query?: string; state?: string; archived?: boolean; limit?: number } = {},
    ): { sessions: PipSession[]; more: number; folders: string[] } {
        const app = this.#app;
        const user = this.#person(pipId);
        const words = (filter.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
        const all = app.sessions(user).map((session): PipSession => {
            const counts = session.subagents;

            return {
                id: session.id,
                title: session.title ?? "New session",
                state: session.waiting ? "needs approval" : session.busy ? "working" : "idle",
                folder: homePath(app.cwdOf(session.id as unknown as ConversationId)),
                archived: session.archived === true,
                ...(session.model === undefined ? {} : { model: session.model }),
                ...(session.worktree === undefined ? {} : { branch: session.worktree.branch }),
                updatedAt: session.updatedAt,
                ...(counts === undefined
                    ? {}
                    : {
                          // "2 failed (1 dismissed)": failures a person dealt with need nobody now.
                          subagents: Object.entries(counts)
                              .filter(
                                  ([kind, count]) =>
                                      kind !== "dealt" && typeof count === "number" && count > 0,
                              )
                              .map(
                                  ([kind, count]) =>
                                      `${String(count)} ${kind}${kind === "failed" && counts.dealt !== undefined ? ` (${String(counts.dealt)} dismissed)` : ""}`,
                              )
                              .join(", "),
                      }),
            };
        });
        const folders = [
            ...new Set(all.filter((each) => !each.archived).map((each) => each.folder)),
        ];
        const matching = all.filter(
            (session) =>
                (filter.archived === true ? session.archived : !session.archived) &&
                (filter.state === undefined || session.state === filter.state) &&
                words.every((word) =>
                    `${session.title} ${session.folder} ${session.branch ?? ""}`
                        .toLowerCase()
                        .includes(word),
                ),
        );
        const limit =
            filter.limit !== undefined && Number.isFinite(filter.limit)
                ? Math.max(1, Math.min(Math.round(filter.limit), 100))
                : 25;

        return {
            sessions: matching.slice(0, limit),
            more: Math.max(0, matching.length - limit),
            folders: folders.slice(0, 12),
        };
    }

    async read(pipId: ConversationId, sessionId: number, entries = 40, from = 0): Promise<string> {
        const answerFrom = Number.isFinite(from) ? Math.max(0, Math.floor(from)) : 0;
        const app = this.#app;
        const user = this.#person(pipId);
        const id = this.#session(pipId, user, sessionId);
        const meta = app.sessionMeta(id)!;
        const conversation = await app.conversation(id);
        const page = await conversation.entries(
            {},
            Math.max(4, Math.min(entries, 200)),
            undefined,
            context,
        );
        const projected = page.items
            .map((entry) => projectEntry(entry))
            .filter((entry): entry is ClientEntry => entry !== undefined)
            .reverse();
        const last = projected.findLast(
            (entry) =>
                entry.kind === "assistant" && entry.blocks.some((block) => block.type === "text"),
        );
        const lastAnswer = last?.id;
        const answer =
            last?.kind === "assistant"
                ? last.blocks
                      .flatMap((block) =>
                          block.type === "text" && block.text.trim() !== "" ? [block.text] : [],
                      )
                      .join("\n")
                      .trim()
                : "";

        if (answerFrom > answer.length) {
            throw new Error(`The last answer has only ${answer.length} characters.`);
        }

        const failed = new Set(
            projected.flatMap((entry) =>
                entry.kind === "toolResult" && entry.isError ? [entry.callId] : [],
            ),
        );
        const lines: string[] = [];
        const part = answerPart(answer, answerFrom, id);
        let shown = false;

        for (const entry of projected) {
            if (entry.kind === "user") {
                lines.push(`▸ ${entry.from ?? "Someone"}: ${clip(entry.text, LINE_CHARS)}`);
            } else if (entry.kind === "assistant") {
                for (const block of entry.blocks) {
                    if (block.type === "text" && block.text.trim() !== "") {
                        if (entry.id !== lastAnswer) {
                            lines.push(`Pi: ${clip(block.text, LINE_CHARS)}`);
                        } else if (!shown) {
                            shown = true;
                            lines.push(`Pi: ${part.text}`);
                        }
                    } else if (block.type === "toolCall") {
                        lines.push(
                            `  · ${callLine(block.name, block.args)}${failed.has(block.id) ? " (failed)" : ""}`,
                        );
                    }
                }

                if (entry.stopReason === "aborted") {
                    lines.push("  (stopped)");
                } else if (entry.error !== undefined) {
                    lines.push(`  (error: ${snippet(entry.error, 200)})`);
                }
            } else if (entry.kind === "note") {
                lines.push(`[note] ${entry.name} ${snippet(entry.text, 300)}`);
            } else if (entry.kind === "shell") {
                lines.push(`$ ${snippet(entry.command, 200)}`);
            } else if (entry.kind === "compaction") {
                lines.push("(earlier messages were summarized)");
            } else if (entry.kind === "reset") {
                lines.push("(a new context started here)");
            }
        }

        const waiting = app.approvals
            .all()
            .filter((request) => app.rootOf(request.conversationId) === id)
            .map((request) => `- ${request.id}: ${request.tool} ${snippet(request.subject, 200)}`);
        const schedules = await app.schedules.list(id);
        const state = app.approvals
            .all()
            .some((request) => app.rootOf(request.conversationId) === id)
            ? "needs approval"
            : app.isBusy(id)
              ? "working"
              : "idle";
        // What waits there and what is scheduled were written by the session's Pi or people: inside the fence too.
        const pending = [
            ...(waiting.length === 0 ? [] : ["Waiting for approval:", ...waiting]),
            ...(schedules.length === 0
                ? []
                : [
                      `Scheduled: ${schedules
                          .map(
                              (item) =>
                                  `${item.every === undefined ? describeMoment(item.next, item.zone) : describeRepeat(item.every)} · ${snippet(item.text, 80)}`,
                          )
                          .join("; ")}`,
                  ]),
        ];

        this.#looked(pipId, id);
        const body = answerFrom > 0 ? [`Pi: ${part.text}`] : [...pending, ...lines];
        const head = [
            `#${String(sessionId)} ${quoted(meta.title ?? "New session")} · ${state}${meta.archived === true ? " · archived" : ""}`,
            `Folder: ${snippet(homePath(app.cwdOf(id)), 300)}${meta.worktree === undefined ? "" : ` (worktree, branch ${snippet(meta.worktree.branch, 120)})`}`,
            "",
            body.length === 0 ? "(no messages yet)" : fenced(body.join("\n")),
            ...(part.note === undefined ? [] : [part.note]),
        ];

        return head.join("\n");
    }

    /**
     * Start a session for PiP's person, in a folder (the default one when absent), with a model only when its person
     * named it. Its first message goes with `send`, so a replayed call that made the session sends it once; it is checked
     * here first (`message`), so a message that names a model nobody chose leaves no session behind.
     */
    async start(
        pipId: ConversationId,
        request: {
            folder?: string;
            repo?: string;
            title?: string;
            worktree?: boolean;
            model?: string;
            message?: string;
        },
    ): Promise<ConversationId> {
        const app = this.#app;
        const user = this.#person(pipId);
        // Before anything is made: a model that is not there, or that nobody chose, leaves no session behind.
        const model =
            request.model === undefined
                ? undefined
                : await this.#personsModel(pipId, user, request.model);

        await this.#requireNoModelChoice(
            pipId,
            user,
            `${request.title ?? ""}\n${request.message ?? ""}`,
        );

        if (request.folder !== undefined && request.repo !== undefined) {
            throw new Error("Give a folder or a repository, not both.");
        }

        this.#count(user, "start", STARTS_PER_HOUR);
        const folder =
            request.repo === undefined ? request.folder : await this.checkout(pipId, request.repo);
        const { id } = await app.commands.createSession(
            user,
            {
                ...(folder === undefined ? {} : { cwd: folder }),
                ...(request.title === undefined ? {} : { title: request.title }),
                worktree: request.worktree === true,
            },
            { projectDefaults: model === undefined },
        );

        if (model !== undefined) {
            await app.commands.configure(id, user, { model });
        }

        // PiP made it, and knows what it is doing: nothing yet.
        this.#looked(pipId, id);

        return id;
    }

    /**
     * Send a session a message for PiP's person: queued behind its work, or steering it. Once for a key: a replayed call
     * finds the message it sent.
     */
    async send(
        pipId: ConversationId,
        sessionId: number,
        message: string,
        steer: boolean,
        key: string,
        options: { started?: boolean } = {},
    ): Promise<{ requestId: string }> {
        const user = this.#person(pipId);
        const id = this.#session(pipId, user, sessionId);

        return {
            requestId: await this.#submit(id, user, message, key, steer, async () => {
                // The first message of a session the same call started (`started`) needs no look, there being nothing to
                // see, and was checked for model names as the session started.
                if (options.started !== true) {
                    this.#requireLooked(pipId, sessionId, "message");
                    await this.#requireNoModelChoice(pipId, user, message);
                }
            }),
        };
    }

    // ─── GitHub ─────────────────────────────────────────────────────────────

    /**
     * Where PiP's person works on a GitHub repository: the checkout a session they started works in (its `origin` is
     * the repository), or else a clone, made now, in the data folder's `repos/`. Only their own sessions' folders: one
     * a guest made could hold the guest's instructions (an AGENTS.md). Only a repository gh's account can push to:
     * someone else's would bring its own instructions into a session that can run commands. A clone is made beside its
     * place and moved there once complete, so a clone cut off midway is never taken for one.
     */
    async checkout(pipId: ConversationId, repo: string): Promise<string> {
        const app = this.#app;
        const user = this.#person(pipId);
        const named = parseRepo(repo);

        if (named === undefined) {
            throw new Error(`${repo} is not a repository: say owner/name, or its address.`);
        }

        const info = await requirePush(app.watches.gh, named);

        // What GitHub answered becomes a path: nothing in it may climb out of `repos/`.
        if (parseRepo(info.repo) !== info.repo) {
            throw new Error(`${info.repo} is not a repository name this server can clone.`);
        }

        const clone = join(app.dataDir, "repos", ...info.repo.split("/"));
        const folders = new Set<string>();

        for (const meta of Object.values(app.sessionCatalogue())) {
            if (meta.pip === undefined && meta.createdBy === user.id) {
                folders.add(meta.worktree?.source ?? meta.cwd);
            }
        }

        folders.add(app.defaultCwd);

        for (const folder of [clone, ...[...folders].slice(0, 200)]) {
            if (existsSync(folder) && sameRepo(await this.#origin(folder), info.repo)) {
                return (
                    await git(folder, ["rev-parse", "--show-toplevel"]).catch(() => folder)
                ).trim();
            }
        }

        let cloning = this.#cloning.get(info.repo);

        if (cloning === undefined) {
            // Not the repository's checkout, or the loop above had taken it: never clone into it.
            if (existsSync(clone)) {
                throw new Error(
                    `${clone} is there but is not a checkout of ${info.repo}: move it away, then ask again.`,
                );
            }

            mkdirSync(dirname(clone), { recursive: true });
            this.#clearParts(clone);
            // `~` is in no GitHub repository's name: no clone of another repository is ever taken for a part.
            const part = `${clone}~part-${randomUUID().slice(0, 8)}`;

            cloning = app.watches
                .gh(["repo", "clone", info.repo, part], undefined, CLONE_TIMEOUT_MS)
                .then(() => {
                    renameSync(part, clone);
                    this.#origins.delete(clone);

                    return clone;
                })
                .catch((error: unknown) => {
                    // A git still writing there after a timeout fails once the folder is gone: harmless.
                    rmSync(part, { recursive: true, force: true });

                    throw error;
                })
                .finally(() => this.#cloning.delete(info.repo));
            this.#cloning.set(info.repo, cloning);
        }

        try {
            return await cloning;
        } catch (error) {
            throw new Error(`${info.repo} could not be cloned: ${describe(error)}`);
        }
    }

    /**
     * Remove what clones of this repository left behind when the server stopped midway: their `~part-*` folders, once
     * older than a clone may take (a git cut off by a restart may still write to a newer one).
     */
    #clearParts(clone: string): void {
        const folder = dirname(clone);
        const prefix = `${basename(clone)}~part-`;
        const before = Date.now() - CLONE_TIMEOUT_MS;

        for (const name of readdirSync(folder)) {
            const part = join(folder, name);

            try {
                if (name.startsWith(prefix) && statSync(part).mtimeMs < before) {
                    rmSync(part, { recursive: true, force: true });
                }
            } catch (error) {
                this.#app.log(`could not remove ${part}: ${describe(error)}`);
            }
        }
    }

    /** A folder's GitHub repository, kept a few minutes: PiP asks of many folders. */
    async #origin(folder: string): Promise<string | undefined> {
        const now = Date.now();
        const known = this.#origins.get(folder);

        if (known !== undefined && now - known.at < ORIGIN_FOR_MS) {
            return known.repo;
        }

        const repo = await originRepo(folder);

        this.#origins.set(folder, { repo, at: now });

        return repo;
    }

    /** Watch a session's pull request for PiP's person: its branch's, or `pr` (a number, address, or owner/name#12). */
    async watchPr(pipId: ConversationId, sessionId: number, pr: string | undefined, key: string) {
        const user = this.#person(pipId);
        const id = this.#session(pipId, user, sessionId);

        // A replayed call finds the watch it started; anything else is looked at first.
        if ((await this.#app.watches.get(id))?.key !== key) {
            this.#requireLooked(pipId, sessionId, "watch a pull request from");
        }

        // Counted even when refused: it asked GitHub, which the hourly count also keeps in bounds.
        this.#count(user, "act", ACTIONS_PER_HOUR);

        return this.#app.watches.start(id, user.id, {
            ...(pr === undefined || pr.trim() === "" ? {} : { pr }),
            byPi: true,
            key,
        });
    }

    /** A session's PR watch, or stopping it. */
    async prWatch(pipId: ConversationId, sessionId: number, stop: boolean) {
        const user = this.#person(pipId);
        const id = this.#session(pipId, user, sessionId);

        if (stop) {
            this.#requireLooked(pipId, sessionId, "stop the PR watch of");
        }

        return stop ? this.#app.watches.stop(id) : this.#app.watches.get(id);
    }

    /** Watch a repository for PiP's person: what happens there comes to PiP, or to session `to`. */
    async addRepoWatch(
        pipId: ConversationId,
        request: Omit<RepoWatchRequest, "target" | "byPi" | "key"> & { to?: number },
        key: string,
    ): Promise<RepoWatchView> {
        const user = this.#person(pipId);
        const { to, ...rest } = request;

        // Strangers' issues and pull requests are let in by a person, in the hooks sheet, never by PiP.
        if (rest.anyone === true) {
            throw new Error(
                "Only your person can let a watch take issues and pull requests from anyone: ask them to turn it on in Menu → Webhooks and watches once the watch is made.",
            );
        }

        const target = to === undefined ? pipId : this.#session(pipId, user, to);

        // What each event will have done: no model in it that its person did not name.
        await this.#requireNoModelChoice(pipId, user, rest.instructions ?? "");

        // Counted even when refused: it asked GitHub, which the hourly count also keeps in bounds.
        this.#count(user, "act", ACTIONS_PER_HOUR);

        return this.#app.repoWatches.add(user, { ...rest, target, byPi: true, key });
    }

    /** PiP's person's repository watches, each with where it sends. */
    async repoWatches(pipId: ConversationId): Promise<(RepoWatchView & { to: string })[]> {
        const app = this.#app;
        const user = this.#person(pipId);

        return (await app.repoWatches.list(user))
            .filter((watch) => watch.by === user.id)
            .map((watch) => ({
                ...watch,
                to:
                    watch.target === Number(pipId)
                        ? "you"
                        : `session ${watch.target} (${quoted(app.sessionMeta(watch.target as unknown as ConversationId)?.title ?? "untitled", 80)})`,
            }));
    }

    async removeRepoWatch(pipId: ConversationId, id: string): Promise<RepoWatchView> {
        return this.#app.repoWatches.remove(this.#person(pipId), id);
    }

    /** Stop a session's run. */
    async stop(pipId: ConversationId, sessionId: number): Promise<boolean> {
        const user = this.#person(pipId);
        const id = this.#session(pipId, user, sessionId);

        this.#requireLooked(pipId, sessionId, "stop");
        const busy = this.#app.isBusy(id);

        await this.#app.commands.abort(id, this.#through(user));

        return busy;
    }

    /** Archive a session, or bring it back. */
    async archive(pipId: ConversationId, sessionId: number, archived: boolean): Promise<void> {
        const user = this.#person(pipId);
        const id = this.#session(pipId, user, sessionId);

        // Bringing one back hides nothing; archiving it hides what may still need its person.
        if (archived && this.#app.sessionMeta(id)?.archived !== true) {
            this.#requireLooked(pipId, sessionId, "archive");
        }

        await this.#app.commands.updateSession(id, this.#through(user), { archived });
    }

    /** The calls waiting for approval in the sessions PiP's person can see. */
    approvals(pipId: ConversationId) {
        const app = this.#app;
        const user = this.#person(pipId);

        return app.approvals
            .all()
            .filter((request) => app.canSee(user, request.conversationId))
            .map((request) => {
                const root = app.rootOf(request.conversationId);

                return {
                    id: request.id,
                    session: Number(root),
                    // Written by the session's Pi or people: quoted, as data.
                    title: quoted(app.sessionMeta(root)?.title ?? "New session"),
                    subagent: root !== request.conversationId,
                    tool: request.tool,
                    subject: quoted(request.subject, 300),
                    reason: quoted(request.reason, 200),
                };
            });
    }

    /** Deny a waiting call. PiP never allows one: that stays a person's decision. */
    async deny(pipId: ConversationId, approvalId: string): Promise<boolean> {
        const user = this.#person(pipId);

        return this.#app.answerApproval(approvalId, false, this.#through(user));
    }

    /** A session's scheduled messages; or one set up there, for PiP's person, marked as sent through PiP. */
    async schedules(pipId: ConversationId, sessionId: number) {
        const user = this.#person(pipId);

        return this.#app.schedules.list(this.#session(pipId, user, sessionId));
    }

    async schedule(
        pipId: ConversationId,
        sessionId: number,
        when: string,
        message: string,
        key: string,
    ) {
        const app = this.#app;
        const user = this.#person(pipId);
        const id = this.#session(pipId, user, sessionId);

        await app.requireDriver(id, user);

        // A replayed call finds the schedule it made; a new one is for a session PiP looked at, naming no model nobody
        // chose.
        if (!(await app.schedules.list(id)).some((item) => item.key === key)) {
            this.#requireLooked(pipId, sessionId, "schedule messages in");
            await this.#requireNoModelChoice(pipId, user, message);
        }

        // A schedule is work to come, counted like a message.
        return this.countSchedule(
            id,
            key,
            () =>
                app.schedules.add(id, {
                    when,
                    text: `[via ${PIP_NAME}] ${message}`,
                    requestedBy: user.id,
                    key,
                }),
            user,
        );
    }

    async cancelSchedule(pipId: ConversationId, sessionId: number, scheduleId: string) {
        const app = this.#app;
        const user = this.#person(pipId);
        const id = this.#session(pipId, user, sessionId);

        await app.requireDriver(id, user);
        this.#requireLooked(pipId, sessionId, "cancel schedules in");

        return app.schedules.cancel(id, scheduleId);
    }

    /**
     * Report to PiP when a session's run ends: the answer to the message PiP sent under `requestId`, or, without one,
     * what the session says once its run ends. A session that is idle now, with no message to wait for, is answered at
     * once in `now`, rather than by a report: a report starts a run of PiP's. `key` makes the follow once, however
     * often its call runs, also after it reported.
     */
    async follow(
        pipId: ConversationId,
        sessionId: number,
        requestId: string | undefined,
        key: string,
    ): Promise<{ now?: string }> {
        const app = this.#app;
        const user = this.#person(pipId);
        const id = this.#session(pipId, user, sessionId);
        const title = app.sessionMeta(id)?.title ?? "New session";

        if (requestId === undefined && !app.isBusy(id)) {
            const now = await this.#lastWords(id, title, "is idle");

            this.#looked(pipId, id);

            return { now };
        }

        // Following a run of its own (no message of PiP's to wait for) is for a session PiP looked at: a report starts a
        // run of PiP's. A replayed call finds the follow it made.
        if (
            requestId === undefined &&
            (await app.harness.snapshot(FollowsDoc, pipId, context))?.items[key] === undefined
        ) {
            this.#requireLooked(pipId, sessionId, "follow");
        }

        await app.harness.commit(async (tx) => {
            const follows = (await tx.doc(FollowsDoc, pipId)).items;

            if (follows[key] !== undefined) {
                return;
            }

            // Forget follows that reported long ago, and any whose task ended without saying so. Reads first: a commit
            // reads the tables only before it writes one.
            const now = Date.now();
            const forget: string[] = [];

            for (const [each, follow] of Object.entries(follows)) {
                if (follow.doneAt !== undefined) {
                    if (now - follow.doneAt > FOLLOW_MEMORY_MS) {
                        forget.push(each);
                    }

                    continue;
                }

                const status = (await tx.task(follow.taskId as never))?.state.status;

                if (status === undefined || status === "terminal") {
                    forget.push(each);
                }
            }

            for (const each of forget) {
                delete follows[each];
            }

            if (
                Object.values(follows).filter((each) => each.doneAt === undefined).length >=
                MAX_FOLLOWS
            ) {
                throw new Error(
                    `You follow ${String(MAX_FOLLOWS)} runs already; wait for some to report.`,
                );
            }

            this.#count(user, "act", ACTIONS_PER_HOUR);
            const taskId = await tx.createTask(
                this.task,
                {
                    sessionId: id,
                    userId: user.id,
                    title,
                    ...(requestId === undefined ? {} : { requestId }),
                },
                { ownership: { kind: "conversation" }, background: true, conversationId: pipId },
            );

            follows[key] = { taskId: Number(taskId), session: sessionId, at: now };
        }, context);

        return {};
    }

    /**
     * Whether a session's person hears of its run's end from their PiP: a live follow waits on it, or one reported just
     * now. Its own "Pi finished" would say the same twice. Not while PiP is off or a spend limit holds it back: its
     * report would then start no run, and push nothing.
     */
    async reportsOn(sessionId: ConversationId, userId: string): Promise<boolean> {
        const app = this.#app;
        const user = app.config.userById(userId);
        const pip = this.idOf(userId);

        if (
            user === undefined ||
            pip === undefined ||
            !this.available(user) ||
            app.spend.heldBack(pip, userId) !== undefined
        ) {
            return false;
        }

        const now = Date.now();
        const follows = Object.values(
            (await app.harness.snapshot(FollowsDoc, pip, context))?.items ?? {},
        ).filter((follow) => follow.session === Number(sessionId));

        if (
            follows.some(
                (follow) =>
                    follow.doneAt !== undefined && now - follow.doneAt < REPORTED_JUST_NOW_MS,
            )
        ) {
            return true;
        }

        const waiting = follows.filter((follow) => follow.doneAt === undefined);
        let live = false;

        if (waiting.length > 0) {
            // Only a follow whose task still runs reports: one that faulted, or is gone, never will.
            await app.harness.commit(async (tx) => {
                for (const follow of waiting) {
                    const status = (await tx.task(follow.taskId as never))?.state.status;

                    live ||= status !== undefined && status !== "terminal";
                }
            }, context);
        }

        return live;
    }

    /** What PiP's person does through PiP, so activity lines and decisions say so. */
    #through(user: User): User {
        return { ...user, name: `${user.name} via ${PIP_NAME}` };
    }

    // ─── Follows ────────────────────────────────────────────────────────────

    /** A session's last words, for PiP: how its run ended, and Pi's last answer, fenced. */
    async #lastWords(id: ConversationId, title: string, state: string): Promise<string> {
        const name = `${quoted(title, 80)} (/s/${String(id)})`;
        const page = await (await this.#app.conversation(id)).entries({}, 16, undefined, context);
        const last = page.items
            .map((entry) => projectEntry(entry))
            .find((entry) => entry?.kind === "assistant");

        if (last?.kind !== "assistant") {
            return `${name} ${state}, with no answer from Pi yet.`;
        }

        if (last.stopReason === "aborted") {
            return `${name} was stopped.`;
        }

        if (last.error !== undefined) {
            return `${name} stopped with an error: ${snippet(last.error, 300)}`;
        }

        const text = last.blocks
            .flatMap((block) => (block.type === "text" ? [block.text] : []))
            .join("\n");

        const part = answerPart(text.trim(), 0, id);

        return `${name} ${state}. Pi's last answer:\n${fenced(part.text)}${part.note === undefined ? "" : `\n${part.note}`}`;
    }

    /**
     * Wait for the session's run to end, then go on to report what came of it. A follow that cannot wait (the session
     * is gone, a read fails) reports that instead, so PiP is never left waiting for nothing.
     */
    async #wait(input: FollowInput, runtime: FollowRuntime, context: Context): Promise<void> {
        let text: string;

        try {
            text = await this.#outcome(input, runtime, context);
        } catch (error) {
            // Stopped or closing: not a failure to report. The abort, or the next process, takes it from here.
            if (runtime.signal.aborted) {
                throw error;
            }

            text = `Could not follow ${quoted(input.title, 80)} (/s/${String(input.sessionId)}): ${snippet(describe(error), 300)}`;
        }

        await runtime.commit(
            () =>
                ({
                    status: "running",
                    checkpoint: { phase: "report", text: `${REPORT_HEAD}${text}` },
                }) as const,
            context,
        );
    }

    /** What came of the run PiP follows, once it ended. */
    async #outcome(input: FollowInput, runtime: FollowRuntime, context: Context): Promise<string> {
        const session = await runtime.conversation(input.sessionId, context);
        const name = `${quoted(input.title, 80)} (/s/${String(input.sessionId)})`;

        if (session === undefined) {
            return `${name} is gone.`;
        }

        if (input.requestId === undefined) {
            await session.waitForIdle(context);

            return this.#lastWords(input.sessionId, input.title, "finished");
        }

        const requestId = input.requestId;
        let known = false;

        await runtime.commit(async (tx) => {
            known = (await tx.submissionByRequest(input.sessionId, requestId)) !== undefined;

            return undefined;
        }, context);

        if (!known) {
            return `Your message to ${name} never arrived.`;
        }

        // The submission PiP made: a request id already known finds it without sending anything.
        const submission = await session.submit({ type: "input", content: "", requestId }, context);
        // Pi Durable leaves a failed run's queue alone, so a queued message waits for a boundary that never comes: once
        // the session is idle with it still queued, withdraw it, which ends the wait below.
        const watch = await runtime.watchDoc(LiveDoc, input.sessionId, context);
        let withdrawn = false;
        let withdrawing: Promise<unknown> = Promise.resolve();
        let settled: Awaited<ReturnType<typeof submission.wait>>;

        try {
            if (watch !== undefined) {
                const strand = async (live: NonNullable<typeof watch>["value"]) => {
                    if (live !== null && live.run === undefined) {
                        const abort = submission.abort(context);

                        withdrawing = abort;

                        if ((await abort) === "aborted") {
                            withdrawn = true;
                        }
                    }
                };

                await strand(watch.value);
                watch.start(strand);
            }

            settled = await submission.wait(context);
        } finally {
            await watch?.stop();
            await withdrawing.catch(() => {});
        }

        if (settled.status === "unanswered") {
            return withdrawn
                ? `${name} went idle without taking your message; send it again if it still matters.`
                : settled.reason === "aborted"
                  ? `${name} was stopped before it answered your message.`
                  : `${name} could not answer your message: ${snippet(String(settled.detail ?? settled.reason), 300)}`;
        }

        if (settled.type !== "input") {
            return `${name} took your message.`;
        }

        const answerId = settled.answer;
        let text = "";

        await runtime.commit(async (tx) => {
            text = textOf(
                (await tx.entry(AssistantEntry, answerId))?.model?.[0] as
                    AssistantMessage | undefined,
            );

            return undefined;
        }, context);

        const part = answerPart(text.trim(), 0, input.sessionId);

        return `${name} answered your message:\n${fenced(part.text || "(no text)")}${part.note === undefined ? "" : `\n${part.note}`}`;
    }

    /** Mark this follow as reported in PiP's list, where it stays a while so a replayed call does not follow again. */
    async #settleFollow(tx: Tx, pipId: ConversationId, taskId: number): Promise<void> {
        const follows = (await tx.doc(FollowsDoc, pipId)).items;

        for (const follow of Object.values(follows)) {
            if (follow.taskId === taskId && follow.doneAt === undefined) {
                follow.doneAt = Date.now();
            }
        }
    }

    /**
     * Give PiP the report: as a message that it answers, or, while a spend limit holds work back, as a note it sees with
     * its next message. Either way under a request id of its own, so a restart does not send it twice.
     */
    async #report(
        input: FollowInput,
        text: string,
        runtime: FollowRuntime,
        context: Context,
    ): Promise<void> {
        const pipId = runtime.conversationId;

        // PiP turned off keeps its follows: a report waits until it is on again, as its schedules, watches, and hooks
        // do, so no run starts in its conversation without its rules and tools.
        const person = this.#app.config.userById(input.userId);

        if (person !== undefined && !this.available(person)) {
            return runtime.sleepUntil(
                runtime.now() + this.holdMs,
                { phase: "report", text },
                context,
            );
        }

        const pip = await this.#app.harness.conversation(pipId, context);
        const requestId = requestFor(input.userId, `pip-report-${String(runtime.taskId)}`);

        // The report says what the session did: PiP has looked at it.
        this.#looked(pipId, input.sessionId);

        if (pip !== undefined) {
            try {
                if (this.#app.spend.heldBack(pipId, input.userId) === undefined) {
                    await pip.submit(
                        { type: "input", content: text, whenBusy: "followUp", requestId },
                        context,
                    );
                } else {
                    await pip.submit(
                        {
                            type: "write",
                            entry: {
                                kind: NOTE_ENTRY,
                                data: { text, by: "pip", name: PIP_NAME },
                                model: [
                                    {
                                        role: "user",
                                        content: [{ type: "text", text }],
                                        timestamp: Date.now(),
                                    },
                                ],
                            },
                            requestId,
                        },
                        context,
                    );
                }
            } catch (error) {
                runtime.report(new Error(`PiP's report was not delivered: ${describe(error)}`));
            }
        }

        await runtime.commit(async (tx) => {
            await this.#settleFollow(tx, pipId, Number(runtime.taskId));

            return finished;
        }, context);
    }
}
