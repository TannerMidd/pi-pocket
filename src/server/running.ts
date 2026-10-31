/**
 * Everything at work right now, from Pi Durable's task graph: answers being written, tool calls, compactions,
 * subagents, and scheduled messages, with the calls waiting for approval, grouped by the session they belong to.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type ConversationId, LiveDoc, type TaskGraphNode } from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import type { User } from "./config.ts";
import { projectEntry } from "./projection.ts";
import { FollowsDoc, RepoWatchesDoc, ScheduleDoc, SubagentsDoc, WatchDoc } from "./docs.ts";
import { COMMAND_TASK } from "./extension-commands.ts";
import { describeMoment, describeRepeat, nextRepeat, type Repeat } from "./when.ts";

const context = BACKGROUND_CONTEXT;

export type RunningTask = {
    id: number;
    /** The task kind as Pi Durable names it, such as `pi.tool`. */
    kind: string;
    /** What it does, in words. */
    label: string;
    status: string;
    /** The conversation it works in: the session, or one of its subagents. */
    conversationId: number;
    /** A subagent's name, when the task works in one. */
    subagent?: string;
    /** For a scheduled message: the schedule, to cancel it. */
    scheduleId?: string;
    /** When this server first saw the task at work: its start, or the server's, for one that ran on across a restart. */
    since?: number;
};

export type RunningSession = {
    id: number;
    title: string;
    busy: boolean;
    approvals: number;
    tasks: RunningTask[];
};

/** A session on the Running now board: what is at work there, with what the board says about the session. */
export type BoardSession = RunningSession & {
    cwd?: string;
    model?: string;
    /** What Pi spent in it, its subagents included. */
    spent: number;
    /** The oldest call waiting for approval there, as the session list shows it. */
    approval?: { tool: string; subject: string; since: number };
    /** The last message sent to it, which its run works on: who sent it, when, and its text, cut at `PROMPT_CHARS`. */
    prompt?: BoardPrompt;
};

export type BoardPrompt = { text: string; from?: string; at?: number };

/** How much of the last message the board sends: enough to read, not a whole pasted file. */
const PROMPT_CHARS = 2000;

/** How many of a session's newest entries the board looks through for its last message: a long run's tool calls. */
const PROMPT_SCAN = 400;

/** A scheduled message on the board, with what its sheet shows and the times it goes out next. */
export type BoardSchedule = {
    id: string;
    /** The session it goes to. */
    session: number;
    sessionTitle: string;
    /** The session's folder, for a session the board shows without a run. */
    sessionCwd?: string;
    text: string;
    next: number;
    every?: Repeat;
    /** Its repeat in words: "every 2 hours", "weekdays at 08:00"; absent for one that goes out once. */
    repeat?: string;
    zone: string;
    /** Who set it; absent when Pi did. */
    by?: string;
    /** For one Pi set up: whom Pi worked for then. */
    requestedBy?: string;
    createdAt: number;
    runs: number;
    /** The next times it goes out, the first being `next`: up to `UPCOMING`, within `UPCOMING_MS`. */
    upcoming: number[];
    /** Why it would not go out now (a spend limit, or nobody left to steer), when it would not. */
    held?: string;
};

export type RunningBoard = {
    sessions: BoardSession[];
    schedules: BoardSchedule[];
    now: number;
};

/** How many of a repeat's next times the board gets, and how far ahead it looks for them. */
const UPCOMING = 24;
const UPCOMING_MS = 8 * 24 * 60 * 60_000;

/**
 * When this server first saw each live task: the task graph keeps no start time, so the board's elapsed times count
 * from here. Tasks that ended are dropped on the next read.
 */
const firstSeen = new Map<string, number>();

function seenSince(nodes: TaskGraphNode[], now: number): Map<string, number> {
    const live = new Set(nodes.map((node) => String(node.id)));

    for (const id of firstSeen.keys()) {
        if (!live.has(id)) {
            firstSeen.delete(id);
        }
    }

    for (const id of live) {
        if (!firstSeen.has(id)) {
            firstSeen.set(id, now);
        }
    }

    return firstSeen;
}

/** The live tasks, as one read of the task graph. */
async function liveTasks(app: PocketApp): Promise<TaskGraphNode[]> {
    const graph = await app.harness.taskGraph(context);

    try {
        return Object.values(graph.value.tasks);
    } finally {
        graph.dispose();
    }
}

/** What a task does, in words, from what its conversation's documents say about it. */
async function describeTask(
    app: PocketApp,
    node: TaskGraphNode,
    user: User,
): Promise<Pick<RunningTask, "label" | "scheduleId"> | undefined> {
    const id = node.conversationId;

    switch (node.kind) {
        case "pi.generation":
            return { label: "writing an answer" };

        case "pi.tool": {
            const slot = (await app.harness.snapshot(LiveDoc, id, context))?.tools?.find(
                (each) => each.taskId === node.id,
            );

            return { label: slot === undefined ? "running a tool" : `running ${slot.name}` };
        }

        case "pi.compaction":
            return { label: "compacting the context" };
        case "pocket.subagent-reporter":
            return { label: "waiting for a subagent's answer" };
        case "pocket.follow-failure":
            return { label: "waiting for a failed subagent to answer a message" };

        case "pocket.subagent-courier": {
            const held = (await app.harness.snapshot(SubagentsDoc, id, context))?.held;

            return {
                label:
                    held === undefined
                        ? "taking subagents' reports to Pi at its next pause"
                        : `holding subagents' reports: ${held}`,
            };
        }

        case "pocket.schedule": {
            const schedule = Object.values(
                (await app.harness.snapshot(ScheduleDoc, id, context))?.items ?? {},
            ).find((each) => each.taskId === node.id);

            if (schedule === undefined) {
                return { label: "a scheduled message" };
            }

            return {
                label: `scheduled for ${describeMoment(schedule.next, schedule.zone)}: ${schedule.text}`,
                scheduleId: schedule.id,
            };
        }

        case COMMAND_TASK: {
            const command = await app.extensionCommands.named(node.id);

            if (command?.scope !== "conversation" && user.role !== "owner") {
                return undefined;
            }

            return {
                label:
                    command === undefined
                        ? "running an extension command"
                        : `running /${command.name}`,
            };
        }

        case "pocket.background": {
            const item = await app.background.byTask(id, String(node.id));

            return {
                label:
                    item === undefined
                        ? "running a command in the background"
                        : `running in the background: ${app.background.describe(id, item)}`,
            };
        }

        case "pocket.shell": {
            const command = await app.shell.describe(node.id);

            return { label: command === undefined ? "running a command" : `running ${command}` };
        }

        // PiP waiting for a session's run to end, from its list of follows.
        case "pocket.pip-follow": {
            const follow = Object.values(
                (await app.harness.snapshot(FollowsDoc, id, context))?.items ?? {},
            ).find((each) => each.taskId === Number(node.id));

            return {
                label:
                    follow === undefined
                        ? "following a session's run"
                        : `following “${app.sessionMeta(follow.session as unknown as ConversationId)?.title ?? "a session"}” until its run ends`,
            };
        }

        case "pocket.pr-watch": {
            const watch = (await app.harness.snapshot(WatchDoc, id, context))?.watch;

            return {
                label:
                    watch === undefined
                        ? "watching a pull request"
                        : `watching PR #${watch.number} until it is merged`,
            };
        }

        // PiP's (or a session's) standing order on a repository.
        case "pocket.repo-watch": {
            const watch = Object.values(
                (await app.harness.snapshot(RepoWatchesDoc, context))?.items ?? {},
            ).find((each) => each.taskId === node.id);

            return {
                label:
                    watch === undefined
                        ? "watching a repository"
                        : `watching ${watch.repo} for ${watch.events.join(", ")}`,
            };
        }

        default:
            return { label: node.kind };
    }
}

/** The sessions this person can see that have something at work, busiest first. */
export async function runningNow(app: PocketApp, user: User): Promise<RunningSession[]> {
    const sessions = new Map<ConversationId, RunningSession>();

    const session = async (conversationId: ConversationId): Promise<RunningSession> => {
        const root = app.rootOf(conversationId);
        let entry = sessions.get(root);

        if (entry === undefined) {
            entry = {
                id: Number(root),
                title: await app.conversationTitle(root),
                busy: false,
                approvals: 0,
                tasks: [],
            };
            sessions.set(root, entry);
        }

        if (app.isBusy(conversationId)) {
            entry.busy = true;
        }

        return entry;
    };

    const nodes = await liveTasks(app);
    const since = seenSince(nodes, Date.now());

    for (const node of nodes) {
        // A subagent's anchor stays for as long as the subagent does, doing nothing: its work shows on its own.
        if (node.kind === "pocket.subagent-anchor" || !app.canSee(user, node.conversationId)) {
            continue;
        }

        const description = await describeTask(app, node, user);

        if (description === undefined) {
            continue;
        }

        const parent = app.parentOf(node.conversationId);
        const subagent =
            parent === undefined
                ? undefined
                : Object.entries(
                      (await app.harness.snapshot(SubagentsDoc, parent, context))?.agents ?? {},
                  ).find(([, record]) => record.conversationId === node.conversationId)?.[0];

        (await session(node.conversationId)).tasks.push({
            id: Number(node.id),
            kind: node.kind,
            status: node.state.status,
            conversationId: Number(node.conversationId),
            since: since.get(String(node.id)) ?? Date.now(),
            ...(subagent === undefined ? {} : { subagent }),
            ...description,
        });
    }

    for (const approval of app.approvals.all()) {
        if (app.canSee(user, approval.conversationId)) {
            (await session(approval.conversationId)).approvals++;
        }
    }

    return [...sessions.values()].sort(
        (a, b) => Number(b.busy) - Number(a.busy) || b.tasks.length - a.tasks.length,
    );
}

/**
 * A schedule's next times, kept until it goes out (its `next` moves), changes, or ends: the board asks every 2 seconds,
 * and a clock repeat's times cost a time zone lookup each.
 */
const upcomingKept = new Map<string, { key: string; times: number[] }>();

/** Each session's last message, kept while its newest entry stays the same: a run adds entries, and the board asks often. */
const promptKept = new Map<number, { newest: number; prompt: BoardPrompt | undefined }>();

/** The last message sent to a session: the newest person's (or a schedule's) entry, looked for from the newest back. */
async function lastPrompt(app: PocketApp, id: ConversationId): Promise<BoardPrompt | undefined> {
    const conversation = await app.harness.conversation(id, context);

    if (conversation === undefined) {
        return undefined;
    }

    let page = await conversation.entries({}, 32, undefined, context);
    const newest = Number(page.items[0]?.id ?? 0);
    const kept = promptKept.get(Number(id));

    if (kept?.newest === newest) {
        return kept.prompt;
    }

    let prompt: BoardPrompt | undefined;
    let seen = 0;

    for (;;) {
        for (const entry of page.items) {
            // The entries up to the newest one seen last time held no newer message: it is still the one, however long
            // the run has gone on.
            if (kept?.prompt !== undefined && Number(entry.id) <= kept.newest) {
                prompt = kept.prompt;
                break;
            }

            if (entry.kind !== "pi.user") {
                continue;
            }

            const shown = projectEntry(entry);

            if (shown?.kind === "user") {
                prompt = {
                    text:
                        shown.text.length > PROMPT_CHARS
                            ? `${shown.text.slice(0, PROMPT_CHARS - 1)}…`
                            : shown.text,
                    ...(shown.from === undefined ? {} : { from: shown.from }),
                    ...(shown.at === undefined ? {} : { at: shown.at }),
                };
                break;
            }
        }

        seen += page.items.length;

        if (prompt !== undefined || page.next === undefined || seen >= PROMPT_SCAN) {
            break;
        }

        page = await conversation.entries({}, 64, page.next, context);
    }

    promptKept.set(Number(id), { newest, prompt });

    return prompt;
}

/** A repeat's next times after `next`, up to `UPCOMING` of them within `UPCOMING_MS`. */
function upcomingOf(id: string, next: number, every: Repeat | undefined, zone: string): number[] {
    if (every === undefined) {
        return [next];
    }

    const key = `${next} ${zone} ${JSON.stringify(every)}`;
    const kept = upcomingKept.get(id);

    if (kept?.key === key) {
        return kept.times;
    }

    const times = [next];

    let at = next;

    while (times.length < UPCOMING) {
        at = nextRepeat(every, at, zone);

        if (at - next > UPCOMING_MS) {
            break;
        }

        times.push(at);
    }

    upcomingKept.set(id, { key, times });

    return times;
}

/**
 * The Running now board: the sessions at work, with their folder, model, spend, and the call they wait on, and every
 * scheduled message this person may see, soonest first, with its next times and whether it is held.
 */
export async function runningBoard(app: PocketApp, user: User): Promise<RunningBoard> {
    const running = await runningNow(app, user);
    const listed = new Map(app.sessions(user).map((session) => [session.id, session]));
    const oldest = new Map<number, { tool: string; subject: string; since: number }>();

    for (const approval of app.approvals.all()) {
        if (!app.canSee(user, approval.conversationId)) {
            continue;
        }

        const root = Number(app.rootOf(approval.conversationId));
        const kept = oldest.get(root);

        if (kept === undefined || approval.createdAt < kept.since) {
            oldest.set(root, {
                tool: approval.tool,
                subject: approval.subject.slice(0, 200),
                since: approval.createdAt,
            });
        }
    }

    // Sessions no longer at work keep no last message.
    for (const id of promptKept.keys()) {
        if (!running.some((session) => session.id === id)) {
            promptKept.delete(id);
        }
    }

    const prompts = await Promise.all(
        running.map((session) =>
            lastPrompt(app, session.id as unknown as ConversationId).catch(() => undefined),
        ),
    );

    const sessions: BoardSession[] = running.map((session, index) => {
        const meta = listed.get(session.id);
        const id = session.id as unknown as ConversationId;
        const pip = app.sessionMeta(id)?.pip !== undefined;
        const approval = oldest.get(session.id);
        const prompt = prompts[index];

        return {
            ...session,
            ...(pip ? { title: "PiP" } : {}),
            ...(meta?.cwd === undefined ? {} : { cwd: meta.cwd }),
            ...(meta?.model === undefined ? {} : { model: meta.model }),
            spent: app.spend.sessionSpent(id),
            ...(approval === undefined ? {} : { approval }),
            ...(prompt === undefined ? {} : { prompt }),
        };
    });

    const schedules: BoardSchedule[] = [];
    // Every schedule is a live `pocket.schedule` task in its session: only those sessions are read.
    const scheduled = new Set(
        (await liveTasks(app))
            .filter((node) => node.kind === "pocket.schedule")
            .map((node) => String(node.conversationId)),
    );

    for (const [key, meta] of Object.entries(app.sessionCatalogue())) {
        const id = Number(key) as unknown as ConversationId;

        if (!scheduled.has(key) || !app.canSee(user, id)) {
            continue;
        }

        const title = meta.pip === undefined ? (meta.title ?? "New session") : "PiP";

        for (const schedule of await app.schedules.list(id)) {
            const held = app.schedules.held(id, schedule);

            schedules.push({
                id: schedule.id,
                session: Number(id),
                sessionTitle: title,
                ...(meta.cwd === undefined ? {} : { sessionCwd: meta.cwd }),
                text: schedule.text,
                next: schedule.next,
                ...(schedule.every === undefined
                    ? {}
                    : { every: schedule.every, repeat: describeRepeat(schedule.every) }),
                zone: schedule.zone,
                ...(schedule.by === undefined ? {} : { by: schedule.by }),
                ...(schedule.requestedBy === undefined
                    ? {}
                    : { requestedBy: schedule.requestedBy }),
                createdAt: schedule.createdAt,
                runs: schedule.runs,
                upcoming: upcomingOf(schedule.id, schedule.next, schedule.every, schedule.zone),
                ...(held === undefined ? {} : { held }),
            });
        }
    }

    schedules.sort((a, b) => a.next - b.next);

    // Schedules that ended (and those this person cannot see) keep no times: the next board makes them again.
    if (upcomingKept.size > schedules.length * 2 + 64) {
        const live = new Set(schedules.map((each) => each.id));

        for (const id of upcomingKept.keys()) {
            if (!live.has(id)) {
                upcomingKept.delete(id);
            }
        }
    }

    return { sessions, schedules, now: Date.now() };
}
