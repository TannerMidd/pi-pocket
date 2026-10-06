/**
 * The Pi Pocket server core: one durable Harness over one SQLite file, shared by every session, every subagent, and
 * every connected browser. Browsers attach to a conversation's committed view; nothing a browser sees exists only in
 * memory, except who is connected, who is typing, and which tool calls wait for approval.
 *
 * What people ask of Pi lives in `commands.ts`, the people's side of a session in `collab.ts`, push notifications in
 * `alerts.ts`, provider sign-ins in `providers.ts`, and each conversation's shared live view in `room.ts`.
 */
import {
    existsSync,
    mkdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { getAgentDir, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import {
    AgentDoc,
    type AgentState,
    type Conversation,
    type ConversationId,
    type ConversationRecord,
    type Cursor,
    createRegistry,
    defineExtension,
    type EntryId,
    type EntryRecord,
    Harness,
    type HarnessSettings,
    LiveDoc,
    type LiveState,
    type ModelRef,
    type Storage,
    type SubmissionId,
    UsageDoc,
    type UsageState,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { Alerts } from "./alerts.ts";
import { type BrowserState, Browsers } from "./browser.ts";
import { type Changes, changesIn, diffOf, revertFile } from "./changes.ts";
import { Collab, REACTIONS } from "./collab.ts";
import { Commands } from "./commands.ts";
import { APP_ROOT, ConfigStore, type User } from "./config.ts";
import {
    ArtifactBodyDoc,
    type ArtifactMeta,
    ArtifactsDoc,
    AuthorsDoc,
    BrowserDoc,
    ChatDoc,
    type ChatMessage,
    DecisionsDoc,
    type SessionMeta,
    SessionsDoc,
    type SubagentRecord,
    SubagentsDoc,
    TurnsDoc,
} from "./docs.ts";
import { describe, HttpError } from "./errors.ts";
import { transcriptMarkdown } from "./export.ts";
import { FileLists, type FileListing, type FileView, viewFile } from "./files.ts";
import { Goals } from "./goals.ts";
import { type ApprovalRequest, Approvals, type PocketHost } from "./host.ts";
import { type GuardStatus, LancetGuard } from "./lancet.ts";
import { configureHttp } from "./net.ts";
import { displayPath, expandHome, homePath } from "./paths.ts";
import { type ClientEntry, projectEntry, snippet } from "./projection.ts";
import {
    loadPromptTemplates,
    loadSkillCommands,
    type PromptTemplate,
    type SkillCommand,
} from "./prompts.ts";
import { Providers } from "./providers.ts";
import { PushStore } from "./push.ts";
import { type ExtensionInfo, ExtensionLoader, prepareDropInFolder } from "./reload.ts";
import { requestPerson } from "./requests.ts";
import { ResendTask } from "./resend.ts";
import { type Client, Room, ROOM_DOCS } from "./room.ts";
import { Schedules } from "./schedules.ts";
import { Shell } from "./shell.ts";
import { Spend } from "./spend.ts";
import { inRepository } from "./worktrees.ts";

const context = BACKGROUND_CONTEXT;

/** Note in an authors document who wrote an entry, or (`wrote` false) whose work it is; a note stays once made. */
function noteAuthor(
    doc: { entries: Record<string, string>; requesters?: Record<string, string> },
    entry: EntryId,
    userId: string,
    wrote: boolean,
): void {
    // A draft copies what is assigned to it: the map is read back from the draft before it changes.
    if (!wrote) {
        doc.requesters ??= {};
    }

    (wrote ? doc.entries : doc.requesters!)[String(entry)] ??= userId;
}

/** How other devices reach this server, as reported by the launcher (`bin/pi-pocket.js`). */
export type AccessInfo = {
    mode: string;
    label: string;
    /** The address other devices should use, such as a tunnel's public https URL. */
    url?: string;
};

type ModelSummary = {
    provider: string;
    id: string;
    name: string;
    contextWindow: number;
    reasoning: boolean;
    images: boolean;
    levels: string[];
};

/** The extension module that runs Lancet Guard on tool calls. */
const GUARD_FILE = "guard.ts";
/** The extension module with the browser tool. While it is off, the Browser panel is off too. */
const BROWSER_FILE = "browser.ts";
const BROWSER_EXTENSION = "pocket-browser";

/**
 * Whether a lock file's process is still running Pi Pocket. A process id can be reused after a crash, so on Linux
 * (and Android) a live process must also be Node; where that cannot be read, a live process counts.
 */
function lockHolder(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) {
        return false;
    }

    try {
        process.kill(pid, 0);
    } catch {
        // Gone, or (EPERM) another user's process: Pi Pocket runs as this user, so not a holder either way.
        return false;
    }

    try {
        return /(^|\/)node[^/\0]*\0/.test(readFileSync(`/proc/${pid}/cmdline`, "latin1"));
    } catch {
        return true;
    }
}

export interface OpenOptions {
    dataDir: string;
    defaultCwd: string;
    supervised: boolean;
    log?: (line: string) => void;
    /** Tests register scripted providers here. */
    configureModels?: (models: ModelRuntime) => void;
    /** The clock durable work runs by, such as scheduled messages. Tests move it ahead. */
    now?: () => number;
    /** The browser to run for the Browser panel and tool; null for none. Undefined finds one on this machine. */
    browser?: string | null;
}

export class PocketApp {
    readonly config: ConfigStore;
    /** Push subscriptions and their keys; undefined until the server opened. */
    pushStore: PushStore | undefined;
    readonly approvals = new Approvals((id) => this.requesterOf(id));
    readonly guard = new LancetGuard();
    readonly dataDir: string;
    readonly defaultCwd: string;
    readonly supervised: boolean;
    readonly startedAt = Date.now();
    /** Set by the launcher over IPC; undefined when the server runs on its own. */
    access: AccessInfo | undefined;
    harness!: Harness;
    models!: ModelRuntime;
    settings!: SettingsManager;
    loader!: ExtensionLoader;
    readonly commands = new Commands(this);
    readonly collab = new Collab(this);
    readonly alerts = new Alerts(this);
    readonly providers = new Providers(this);
    readonly schedules = new Schedules(this);
    readonly goals = new Goals(this);
    readonly shell = new Shell(this);
    readonly spend = new Spend(this);
    /** Each conversation's browser page, which Pi and the people in the conversation share. */
    readonly browsers: Browsers;
    readonly #clients = new Set<Client>();
    readonly #rooms = new Map<ConversationId, Promise<Room>>();
    readonly #envs = new Map<string, NodeExecutionEnv>();
    readonly #busy = new Set<ConversationId>();
    readonly #agents = new Map<ConversationId, AgentState>();
    readonly #authored = new Set<string>();
    /**
     * Store who wrote an entry, or (`wrote` false) whose work it is. Commit listeners may not call Session APIs, so
     * this commits right after.
     */
    #noteAuthor(
        conversationId: ConversationId,
        entry: EntryId,
        userId: string,
        wrote: boolean,
    ): void {
        setImmediate(() => {
            this.harness
                .commit(
                    async (tx) =>
                        noteAuthor(await tx.doc(AuthorsDoc, conversationId), entry, userId, wrote),
                    context,
                )
                .catch((error: unknown) => this.#log(`author not recorded: ${describe(error)}`));
        });
    }

    /**
     * Messages in a conversation whose person the authors document misses, from Pi Durable's records of them: it is
     * written just after a message enters, and a crash in between loses that.
     */
    async #unrecordedAuthors(
        storage: Storage,
        id: ConversationId,
        known: Readonly<Record<string, string>>,
    ): Promise<{ entry: EntryId; userId: string; wrote: boolean }[]> {
        const missing: { entry: EntryId; userId: string; wrote: boolean }[] = [];
        let cursor: Cursor | undefined;

        do {
            const page = await storage.scanSubmissions(
                { conversationId: id },
                256,
                cursor,
                context,
            );

            for (const record of page.items) {
                // Writes too: a `!` command Pi sees, or a note, is its person's (`shell.ts`, `Commands.note`).
                const entry = record.entry;
                const person = requestPerson(record.requestId);

                if (
                    entry !== undefined &&
                    person !== undefined &&
                    known[String(entry)] === undefined
                ) {
                    missing.push({ entry, ...person });
                }
            }

            cursor = page.next;
        } while (cursor !== undefined);

        return missing;
    }

    /** Who wrote to Pi last in each conversation: whoever asked for what Pi is doing there now. */
    readonly #lastAuthor = new Map<ConversationId, string>();
    /**
     * The entry `#lastAuthor` comes from. Pi works for whoever wrote the newest message: an older one that settles
     * later (after a restart, say) does not take that back.
     */
    readonly #lastAuthorEntry = new Map<ConversationId, number>();
    /** The files in each folder, for `@` mentions. */
    readonly #files = new FileLists();
    /** Folders known to be in a git repository or not, for a minute: views ask on every update. */
    readonly #repositories = new Map<string, { inside: boolean; at: number }>();
    /** The newest chat message (not activity) of each conversation, for unread dots in the session list. */
    readonly #lastChat = new Map<string, { at: number; userId: string }>();
    /** Subagent conversation → the conversation that spawned it. */
    readonly #parents = new Map<ConversationId, ConversationId>();
    /** Who sent each submission, for queued messages. Filled from commits, or looked up once when missing. */
    readonly #submitters = new Map<number, string>();
    readonly #lookups = new Set<number>();
    #sessions: Record<string, SessionMeta> = {};
    #sessionsTimer: NodeJS.Timeout | undefined;
    #unsubscribeCommits: (() => void) | undefined;
    #unsubscribeApprovals: (() => void) | undefined;
    #unsubscribeBrowsers: (() => void) | undefined;
    #lockFile: string;
    #closing: Promise<void> | undefined;
    readonly #log: (line: string) => void;
    readonly #configureModels: ((models: ModelRuntime) => void) | undefined;
    /** The clock durable work runs by. */
    readonly now: () => number;

    private constructor(options: OpenOptions) {
        this.#configureModels = options.configureModels;
        this.now = options.now ?? Date.now;
        this.dataDir = options.dataDir;
        this.defaultCwd = options.defaultCwd;
        this.supervised = options.supervised;
        this.config = new ConfigStore(options.dataDir);
        this.#lockFile = join(options.dataDir, "harness.lock");
        this.#log = options.log ?? ((line) => console.log(line));
        this.browsers = new Browsers({
            dataDir: options.dataDir,
            ...(options.browser === undefined ? {} : { executable: options.browser }),
            log: (line) => this.#log(line),
            load: async (id) =>
                (await this.harness.snapshot(
                    BrowserDoc,
                    id as unknown as ConversationId,
                    context,
                )) ?? undefined,
            save: (id, saved) => {
                void this.harness
                    .commit(async (tx) => {
                        const doc = await tx.doc(BrowserDoc, id as unknown as ConversationId);

                        if (saved.url !== undefined && doc.url !== saved.url) {
                            doc.url = saved.url;
                        }

                        const viewport = saved.viewport;

                        if (
                            viewport !== undefined &&
                            JSON.stringify(doc.viewport) !== JSON.stringify(viewport)
                        ) {
                            doc.viewport = { ...viewport };
                        }
                    }, context)
                    .catch((error: unknown) =>
                        this.#log(`browser page not saved: ${describe(error)}`),
                    );
            },
        });
    }

    /** Write a line to the server log. */
    log(line: string): void {
        this.#log(line);
    }

    static async open(options: OpenOptions): Promise<PocketApp> {
        const app = new PocketApp(options);

        await app.#open();

        return app;
    }

    /**
     * One process per data directory. A lock left by a process that died (killed, or its phone stopped it) is taken
     * over; created with `wx`, so of two processes starting at once only one gets it.
     */
    #lock(): void {
        if (existsSync(this.#lockFile)) {
            const pid = Number(readFileSync(this.#lockFile, "utf8").trim());

            if (lockHolder(pid)) {
                throw new Error(
                    `Pi Pocket is already running on this data directory (pid ${pid}). If it is not, delete ${this.#lockFile}.`,
                );
            }

            rmSync(this.#lockFile, { force: true });
        }

        try {
            writeFileSync(this.#lockFile, `${process.pid}\n`, { flag: "wx" });
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
                throw error;
            }

            throw new Error(
                "Pi Pocket is already running on this data directory: another one started at the same moment.",
            );
        }
    }

    async #open(): Promise<void> {
        this.#lock();

        try {
            this.pushStore = new PushStore(this.dataDir);
        } catch (error) {
            this.#log(`Push notifications are off: ${describe(error)}`);
        }

        this.settings = SettingsManager.create(this.defaultCwd);

        try {
            configureHttp(
                this.settings.getHttpIdleTimeoutMs() || 2_147_483_647,
                this.settings.getGlobalSettings().httpProxy,
            );
        } catch (error) {
            this.#log(`HTTP setup failed, using Node defaults: ${describe(error)}`);
        }

        this.models = await ModelRuntime.create();
        this.#configureModels?.(this.models);
        await this.models.getAvailable().catch(() => []);

        const registry = createRegistry();

        registry.install(CodingTools);
        // Durable work of the app itself, whatever extension modules are on.
        registry.install(
            defineExtension({ name: "pocket-core", tasks: [ResendTask, this.shell.task] }),
        );
        const host: PocketHost = {
            guard: this.guard,
            approvals: this.approvals,
            agentDir: getAgentDir(),
            dataDir: this.dataDir,
            skillPaths: () => {
                try {
                    return this.settings.getSkillPaths();
                } catch {
                    return [];
                }
            },
            resolveModel: (spec) => this.resolveModel(spec),
            requesterOf: (conversationId) => this.requesterOf(conversationId),
            notice: (level, message) => this.notice(level, message),
            schedules: this.schedules,
            goals: this.goals,
            browsers: this.browsers,
        };
        const dropIn = join(this.dataDir, "extensions");

        try {
            prepareDropInFolder(dropIn, join(APP_ROOT, "node_modules"));
        } catch (error) {
            this.#log(`Drop-in extensions cannot import Pi Pocket's packages: ${describe(error)}`);
        }

        this.loader = new ExtensionLoader(
            registry,
            host,
            { builtIn: join(APP_ROOT, "src", "server", "extensions"), dropIn },
            (file) => this.config.extensionChoice(file),
        );
        await this.loader.loadAll();

        const storage = await openNodeSqliteStorage(join(this.dataDir, "pocket.sqlite"));

        this.harness = await Harness.open(
            storage,
            {
                models: this.models,
                registry,
                settings: this.#harnessSettings(),
                now: this.now,
                env: ({ cwd }) => this.#env(cwd ?? this.defaultCwd),
                conversationCreated: async (tx, conversation) => {
                    // Every conversation gets the app's documents up front, so views can read them from the start.
                    await tx.doc(AuthorsDoc, conversation.id);
                    await tx.doc(ArtifactsDoc, conversation.id);
                    await tx.doc(SubagentsDoc, conversation.id);
                },
                onReport: (error) => this.notice("warning", describe(error)),
            },
            context,
        );

        this.#sessions = { ...((await this.harness.snapshot(SessionsDoc, context))?.items ?? {}) };
        const conversations: ConversationId[] = [];
        const unrecorded = new Map<
            ConversationId,
            { entry: EntryId; userId: string; wrote: boolean }[]
        >();
        let cursor: Cursor | undefined;

        do {
            const page = await this.harness.commit(
                (tx) => tx.scanConversations({}, 256, cursor),
                context,
            );

            for (const { id } of page.items) {
                conversations.push(id);
                const live = await this.harness.snapshot(LiveDoc, id, context);

                if (live?.run !== undefined) {
                    this.#busy.add(id);
                }

                const agent = await this.harness.snapshot(AgentDoc, id, context);

                if (agent !== undefined) {
                    this.#agents.set(id, agent as AgentState);
                }

                this.#noteChat(id, (await this.harness.snapshot(ChatDoc, id, context))?.messages);
                const authorsDoc = await this.harness.snapshot(AuthorsDoc, id, context);
                const known: Record<string, string> = {
                    ...authorsDoc?.requesters,
                    ...authorsDoc?.entries,
                };
                const missing = await this.#unrecordedAuthors(storage, id, known);

                for (const { entry, userId } of missing) {
                    known[String(entry)] = userId;
                }

                if (missing.length > 0) {
                    unrecorded.set(id, missing);
                }

                const newest = Object.entries(known).reduce<[string, string] | undefined>(
                    (best, each) =>
                        best === undefined || Number(each[0]) > Number(best[0]) ? each : best,
                    undefined,
                );

                if (newest !== undefined) {
                    this.#lastAuthor.set(id, newest[1]);
                    this.#lastAuthorEntry.set(id, Number(newest[0]));
                }

                // Their authors are known: a message settling after the restart is not noted again.
                for (const entry of Object.keys(known)) {
                    this.#authored.add(`${String(id)}:${entry}`);
                }

                this.#noteSubagents(
                    id,
                    (await this.harness.snapshot(SubagentsDoc, id, context))?.agents,
                );
            }

            cursor = page.next;
        } while (cursor !== undefined);

        if (unrecorded.size > 0) {
            await this.harness.commit(async (tx) => {
                for (const [id, missing] of unrecorded) {
                    const doc = await tx.doc(AuthorsDoc, id);

                    for (const { entry, userId, wrote } of missing) {
                        noteAuthor(doc, entry, userId, wrote);
                    }
                }
            }, context);
        }

        await this.spend.load(conversations);

        this.#unsubscribeCommits = this.harness.subscribeCommits((publication) => {
            let sessionsChanged = false;

            // Usage in a commit is from the work that was going on before it: it is counted before a message the same
            // commit places changes whom Pi works for.
            for (const change of publication.changes) {
                if (
                    change.type === "document" &&
                    change.record.kind === UsageDoc.definition.kind &&
                    change.conversationId !== undefined
                ) {
                    this.spend.usageChanged(
                        change.conversationId,
                        change.value as UsageState | null,
                    );
                }
            }

            for (const change of publication.changes) {
                if (change.type === "document") {
                    const kind = change.record.kind;
                    const id = change.conversationId;

                    if (kind === "pi.live" && id !== undefined) {
                        const busy = (change.value as LiveState | null)?.run !== undefined;

                        if (busy !== this.#busy.has(id)) {
                            if (busy) {
                                this.#busy.add(id);
                            } else {
                                this.#busy.delete(id);
                            }

                            sessionsChanged = true;
                            this.alerts.runChanged(id, busy);

                            if (!busy) {
                                this.spend.runEnded(id);
                            }

                            // A parent shows its subagents' busy state.
                            for (const pending of this.#rooms.values()) {
                                void pending.then((room) => {
                                    if (
                                        Object.values(room.subagents).some(
                                            (record) => record.conversationId === id,
                                        )
                                    ) {
                                        room.schedule();
                                    }
                                });
                            }
                        }
                    } else if (kind === "pi.agent" && id !== undefined) {
                        if (change.value !== null) {
                            this.#agents.set(id, change.value as AgentState);
                        }

                        sessionsChanged = true;
                    } else if (kind === SessionsDoc.definition.kind) {
                        this.#sessions = {
                            ...((change.value as { items?: Record<string, SessionMeta> } | null)
                                ?.items ?? {}),
                        };
                        sessionsChanged = true;

                        // Views show a session's title, limit, and worktree from here.
                        for (const pending of this.#rooms.values()) {
                            void pending.then(
                                (room) => room.schedule(),
                                () => {},
                            );
                        }
                    } else if (ROOM_DOCS.has(kind) && id !== undefined) {
                        if (kind === ChatDoc.definition.kind) {
                            if (
                                this.#noteChat(
                                    id,
                                    (change.value as { messages?: ChatMessage[] } | null)?.messages,
                                )
                            ) {
                                sessionsChanged = true;
                            }
                        } else if (kind === SubagentsDoc.definition.kind) {
                            this.#noteSubagents(
                                id,
                                (change.value as { agents?: Record<string, SubagentRecord> } | null)
                                    ?.agents,
                            );
                        }

                        void this.#rooms.get(id)?.then(
                            (room) =>
                                room.setDoc(kind, change.value as Record<string, unknown> | null),
                            () => {},
                        );

                        if (kind === TurnsDoc.definition.kind) {
                            for (const pending of this.#rooms.values()) {
                                void pending.then(
                                    (room) => {
                                        if (room.id !== id && this.rootOf(room.id) === id) {
                                            room.setDoc(
                                                kind,
                                                change.value as Record<string, unknown> | null,
                                            );
                                        }
                                    },
                                    () => {},
                                );
                            }
                        }
                    }
                } else if (change.type === "submission") {
                    const record = change.value;
                    const person = requestPerson(record.requestId);

                    if (person?.wrote === true) {
                        this.#submitters.set(record.id as unknown as number, person.userId);
                    }

                    // A message's submission changes as it is placed and answered; its author is noted once, when it enters.
                    // A write that is a person's (a `!` command Pi sees, a note) counts as theirs too: it speaks to Pi.
                    const key = `${record.conversationId}:${String(record.entry)}`;

                    if (
                        (record.type === "input" || person !== undefined) &&
                        record.entry !== undefined &&
                        !this.#authored.has(key)
                    ) {
                        const conversationId = record.conversationId;
                        const parent = this.parentOf(conversationId);
                        // Subagent tasks started before they carried their person are the work of whoever the parent works for.
                        const requester =
                            person?.userId ??
                            (record.requestId?.startsWith("subagent:") && parent !== undefined
                                ? this.requesterOf(parent)
                                : undefined);

                        if (requester !== undefined) {
                            this.#authored.add(key);
                            const entry = Number(record.entry);

                            if (entry >= (this.#lastAuthorEntry.get(conversationId) ?? -1)) {
                                this.#lastAuthorEntry.set(conversationId, entry);
                                this.#lastAuthor.set(conversationId, requester);
                            }

                            this.#noteAuthor(
                                conversationId,
                                record.entry,
                                requester,
                                person?.wrote === true,
                            );
                        }
                    }
                }
            }

            if (sessionsChanged) {
                this.#scheduleSessions();
            }
        });
        this.#unsubscribeApprovals = this.approvals.subscribe((id) => {
            void this.#rooms.get(id)?.then(
                (room) => room.schedule(),
                () => {},
            );
            this.#scheduleSessions();
            this.alerts.announceApprovals();
        });
        // A browser page's address, title, and loading go to the tabs watching its conversation, as they change.
        this.#unsubscribeBrowsers = this.browsers.subscribe((id, state) => {
            const conversationId = id as unknown as ConversationId;

            void this.#rooms.get(conversationId)?.then(
                (room) => {
                    for (const client of room.clients) {
                        client.send("browser", this.#browserEvent(conversationId, state));
                    }
                },
                () => {},
            );
        });

        if (this.guardOn()) {
            void this.guard.warm().catch(() => {});
        }

        // Work a previous process left unfinished continues now.
        this.harness.resume();
    }

    #harnessSettings(): HarnessSettings {
        const settings = this.settings;

        const safe = <T>(read: () => T): T | undefined => {
            try {
                return read();
            } catch {
                return undefined;
            }
        };

        return {
            get stream() {
                const provider = safe(() => settings.getProviderRetrySettings());
                const idle = safe(() => settings.getHttpIdleTimeoutMs()) ?? 300_000;

                return {
                    timeoutMs: provider?.timeoutMs ?? (idle === 0 ? 2_147_483_647 : idle),
                    ...(provider?.maxRetryDelayMs === undefined
                        ? {}
                        : { maxRetryDelayMs: provider.maxRetryDelayMs }),
                    ...(provider?.maxRetries === undefined
                        ? {}
                        : { maxRetries: provider.maxRetries }),
                };
            },
            get compaction() {
                return safe(() => settings.getCompactionSettings()) ?? {};
            },
            get retry() {
                return safe(() => settings.getRetrySettings()) ?? {};
            },
            get steeringMode() {
                return safe(() => settings.getSteeringMode());
            },
            get followUpMode() {
                return safe(() => settings.getFollowUpMode());
            },
        } as HarnessSettings;
    }

    /** Where a conversation's commands run: its folder on this machine. */
    envFor(id: ConversationId): NodeExecutionEnv {
        return this.#env(this.cwdOf(id));
    }

    #env(cwd: string): NodeExecutionEnv {
        let env = this.#envs.get(cwd);

        if (env === undefined) {
            env = new NodeExecutionEnv({ cwd });
            this.#envs.set(cwd, env);
        }

        return env;
    }

    // ─── Clients ────────────────────────────────────────────────────────────

    notice(
        level: "info" | "warning" | "error",
        message: string,
        conversationId?: ConversationId,
    ): void {
        this.#log(`[${level}] ${message}`);

        for (const client of this.#clients) {
            // Server-wide notices can name other sessions' folders: people invited to one session do not get them.
            const reaches =
                conversationId === undefined
                    ? client.user.sessions === undefined
                    : client.conversationId === conversationId &&
                      this.canSee(client.user, conversationId);

            if (reaches) {
                client.send("notice", { level, message });
            }
        }
    }

    /** Every connected tab. */
    get clients(): ReadonlySet<Client> {
        return this.#clients;
    }

    /** Tell every browser to reload, after a web file changed. */
    reloadClients(file: string): void {
        for (const client of this.#clients) {
            client.send("reload", { file });
        }
    }

    /**
     * Start sending a tab its events. The tab may close during the waits here (opening a room, or the guard's status
     * right after a restart, when every browser reconnects at once): `detach` has then run, and the tab must not be added.
     */
    async attach(client: Client): Promise<void> {
        const arriving = !this.#online(client.user.id);

        this.#clients.add(client);
        const hello = await this.hello(client.user);

        if (!this.#clients.has(client)) {
            return;
        }

        client.send("hello", hello);
        client.send("sessions", this.sessions(client.user));

        if (arriving) {
            this.#peopleChanged(client.user.id);
        }

        if (client.conversationId === undefined) {
            return;
        }

        if (!this.canSee(client.user, client.conversationId)) {
            client.send("missing", {
                conversationId: client.conversationId,
                message: "This session is not shared with you.",
            });
            // Keep the tab for app-wide events only: nothing about that conversation reaches it, and it is not "there".
            client.conversationId = undefined;

            return;
        }

        try {
            const id = client.conversationId;
            const room = await this.room(id);

            if (!this.#clients.has(client)) {
                this.releaseRoom(room);

                return;
            }

            room.keepOpen();
            room.clients.add(client);
            room.push(client, true);
            client.send("chat", { conversationId: room.id, full: true, messages: room.chat });
            client.send("notes", { conversationId: room.id, ...room.notes });
            // Also while the browser is off: turned on later, the panel has its state at once.
            client.send(
                "browser",
                this.#browserEvent(room.id, this.browsers.state(Number(room.id))),
            );

            for (const other of room.clients) {
                if (other !== client) {
                    room.push(other, false);
                }
            }

            room.pushPresence();
            this.#scheduleSessions();
        } catch (error) {
            client.send("missing", {
                conversationId: client.conversationId,
                message: describe(error),
            });
        }
    }

    detach(client: Client): void {
        if (!this.#clients.delete(client)) {
            return;
        }

        if (!this.#online(client.user.id)) {
            this.#peopleChanged(client.user.id);
        }

        if (client.conversationId === undefined) {
            return;
        }

        this.#leaveRoom(client, client.conversationId);
    }

    /** Take a tab out of a conversation's room: the others see it go, and the room closes once no tab is left. */
    #leaveRoom(client: Client, id: ConversationId): void {
        void this.#rooms.get(id)?.then(
            (room) => {
                if (!room.clients.delete(client)) {
                    return;
                }

                if (!room.has(client.user.id)) {
                    room.setTyping(client.user.id, null);
                }

                room.pushPresence();
                room.schedule();
                this.#scheduleSessions();
                this.releaseRoom(room);
            },
            () => {},
        );
    }

    /** A tab was hidden or shown: hidden tabs show their person as away, and let push notifications through. */
    setVisible(user: User, tab: string, visible: boolean): void {
        for (const client of this.#clients) {
            if (client.user.id !== user.id || client.id !== tab || client.visible === visible) {
                continue;
            }

            client.visible = visible;
            const id = client.conversationId;

            if (id !== undefined) {
                void this.#rooms.get(id)?.then(
                    (room) => room.pushPresence(),
                    () => {},
                );
            }
        }
    }

    #online(userId: string): boolean {
        for (const client of this.#clients) {
            if (client.user.id === userId) {
                return true;
            }
        }

        return false;
    }

    /** Is this person looking at this conversation right now, in a visible tab? */
    watching(userId: string, id: ConversationId): boolean {
        for (const client of this.#clients) {
            if (
                client.user.id === userId &&
                client.conversationId === id &&
                client.visible !== false
            ) {
                return true;
            }
        }

        return false;
    }

    /** Change someone's name: shown at once on their messages, in the people lists, and on their avatar. */
    rename(user: User, name: string): void {
        this.config.updateUser(user.id, { name });
        this.#peopleChanged();

        for (const pending of this.#rooms.values()) {
            void pending.then(
                (room) => room.has(user.id) && room.pushPresence(),
                () => {},
            );
        }
    }

    /** Someone came, went, or changed: remember when they were last here and tell everyone. */
    #peopleChanged(userId?: string): void {
        if (userId !== undefined && this.config.userById(userId) !== undefined) {
            this.config.updateUser(userId, { lastSeen: Date.now() });
        }

        for (const client of this.#clients) {
            client.send("users", this.people(client.user));
        }
    }

    /**
     * The people with access to this server as `viewer` may see them: who is online now, and when the others were last
     * here. People invited to one session see only those who share it, and not which sessions others are limited to.
     */
    people(viewer: User) {
        const scope = viewer.sessions;

        return this.config.users
            .filter(
                (each) =>
                    scope === undefined ||
                    each.sessions === undefined ||
                    each.sessions.some((id) => scope.includes(id)),
            )
            .map((each) => ({
                id: each.id,
                name: each.name,
                role: each.role,
                online: this.#online(each.id),
                ...(each.lastSeen === undefined ? {} : { lastSeen: each.lastSeen }),
                ...(each.sessions === undefined || scope !== undefined
                    ? {}
                    : { sessions: each.sessions.map(Number) }),
            }));
    }

    // ─── Access ─────────────────────────────────────────────────────────────

    /** A session's conversations: itself and the subagents under it that are known here. */
    conversationsOf(root: ConversationId): ConversationId[] {
        return [
            ...new Set([
                root,
                ...[...this.#agents.keys()].filter((id) => this.rootOf(id) === root),
            ]),
        ];
    }

    /** The conversation that spawned a subagent's; undefined for any other conversation. */
    parentOf(id: ConversationId): ConversationId | undefined {
        return this.#parents.get(id);
    }

    /** The session a conversation belongs to: itself, or the session its subagent chain started from. */
    rootOf(id: ConversationId): ConversationId {
        let current = id;

        for (let depth = 0; depth < 32; depth++) {
            const parent = this.#parents.get(current);

            if (parent === undefined) {
                return current;
            }

            current = parent;
        }

        return current;
    }

    /** People invited to one session see only that session and its subagents. */
    canSee(user: User, id: ConversationId): boolean {
        return user.sessions === undefined || user.sessions.includes(String(this.rootOf(id)));
    }

    requireSee(user: User, id: ConversationId): void {
        if (!this.canSee(user, id)) {
            throw new HttpError(404, "This session is not shared with you.");
        }
    }

    /** Viewers read, chat, and react; they never make Pi do anything. */
    requireSteer(user: User): void {
        if (user.role === "viewer") {
            throw new HttpError(
                403,
                "You can view this session but not steer Pi. Ask the owner for steering rights.",
            );
        }
    }

    /** While take turns is on, only the driver sends to Pi or changes its settings. */
    async requireDriver(id: ConversationId, user: User): Promise<void> {
        this.requireSteer(user);
        const turns = await this.harness.snapshot(TurnsDoc, this.rootOf(id), context);

        if (turns?.on !== true || turns.driver === user.id) {
            return;
        }

        const driver = turns.driver === undefined ? undefined : this.config.userById(turns.driver);

        throw new HttpError(
            409,
            driver === undefined
                ? "Take turns is on: take the wheel first."
                : `${driver.name} is driving. Ask to drive first.`,
        );
    }

    #noteChat(id: ConversationId, messages: readonly ChatMessage[] | undefined): boolean {
        const last = messages?.findLast((message) => message.kind !== "event");
        const key = String(id);
        const before = this.#lastChat.get(key);

        if (last === undefined) {
            return this.#lastChat.delete(key);
        }

        if (before?.at === last.at && before.userId === last.userId) {
            return false;
        }

        this.#lastChat.set(key, { at: last.at, userId: last.userId });

        return true;
    }

    #noteSubagents(id: ConversationId, agents: Record<string, SubagentRecord> | undefined): void {
        for (const record of Object.values(agents ?? {})) {
            this.#parents.set(record.conversationId, id);
        }
    }

    /** Who queued a message, when known without a lookup. */
    knownSubmitter(submissionId: number): string | undefined {
        return this.#submitters.get(submissionId);
    }

    /** Who queued a message: `{ by }` when known. Unknown ones (from before a restart) are looked up once. */
    submitterOf(submissionId: number, room: Room): { by?: string } {
        const by = this.#submitters.get(submissionId);

        if (by !== undefined) {
            return { by };
        }

        if (!this.#lookups.has(submissionId)) {
            this.#lookups.add(submissionId);
            void this.harness
                .submission(submissionId as unknown as SubmissionId, context)
                .then((submission) => submission?.status(context))
                .then((record) => {
                    const person = requestPerson(record?.requestId);

                    if (person?.wrote === true) {
                        this.#submitters.set(submissionId, person.userId);
                        room.schedule();
                    }
                })
                .catch(() => {});
        }

        return {};
    }

    /** A conversation's shared view, opened when no tab has it open. Hand it to `releaseRoom` when done with it. */
    async room(id: ConversationId): Promise<Room> {
        let pending = this.#rooms.get(id);

        if (pending === undefined) {
            pending = (async () => {
                const conversation = await this.harness.conversation(id, context);

                if (conversation === undefined) {
                    throw new HttpError(404, `Conversation ${String(id)} does not exist`);
                }

                const room = new Room(this, id);

                await room.open(conversation);

                return room;
            })();
            this.#rooms.set(id, pending);
            pending.catch(() => this.#rooms.delete(id));
        }

        return pending;
    }

    /** A conversation's shared view if it is open now; undefined otherwise, without opening it. */
    openRoom(id: ConversationId): Promise<Room> | undefined {
        return this.#rooms.get(id);
    }

    /** Close a room shortly after its last tab left, unless a tab comes back first. */
    releaseRoom(room: Room): void {
        if (room.clients.size === 0) {
            room.closeLater(() => this.#rooms.delete(room.id));
        }
    }

    async hello(user: User) {
        return {
            user: {
                id: user.id,
                name: user.name,
                role: user.role,
                ...(user.sessions === undefined ? {} : { sessions: user.sessions.map(Number) }),
            },
            users: this.people(user),
            models: this.modelList(),
            guard: await this.guardStatus(),
            server: {
                supervised: this.supervised,
                startedAt: this.startedAt,
                home: homedir(),
                defaultCwd: this.defaultCwd,
                extensions: this.loader.extensionNames(),
                // Tells the web app this server has people chat and typing indicators.
                chat: true,
                // Collaboration features: 2 adds roles, take turns, reactions, pins, notes, mentions, and push.
                collab: 2,
                reactions: REACTIONS,
                approvalRule: this.config.approvalRule,
            },
        };
    }

    #scheduleSessions(): void {
        if (this.#sessionsTimer !== undefined) {
            return;
        }

        this.#sessionsTimer = setTimeout(() => {
            this.#sessionsTimer = undefined;
            const all = this.sessions();

            for (const client of this.#clients) {
                const scope = client.user.sessions;

                client.send(
                    "sessions",
                    scope === undefined
                        ? all
                        : all.filter((session) => scope.includes(String(session.id))),
                );
            }
        }, 400);
    }

    /** The session list, with who is in each session and its newest chat message. Scoped people see only theirs. */
    sessions(user?: User) {
        const waiting = new Set(
            this.approvals.all().map((approval) => String(this.rootOf(approval.conversationId))),
        );
        const people = new Map<string, Map<string, string>>();

        for (const client of this.#clients) {
            if (client.conversationId === undefined) {
                continue;
            }

            const key = String(client.conversationId);
            const here = people.get(key) ?? new Map<string, string>();

            here.set(client.user.id, client.user.name);
            people.set(key, here);
        }

        return Object.entries(this.#sessions)
            .filter(([id]) => user?.sessions === undefined || user.sessions.includes(id))
            .map(([id, meta]) => {
                const model = this.#agents.get(Number(id) as unknown as ConversationId)?.model;
                const busy = this.#busy.has(Number(id) as unknown as ConversationId);
                const here = [...(people.get(id) ?? new Map<string, string>())].map(
                    ([userId, name]) => ({ id: userId, name }),
                );
                const chat = this.#lastChat.get(id);

                return {
                    id: Number(id),
                    ...meta,
                    busy,
                    waiting: waiting.has(id),
                    ...(model === undefined ? {} : { model: model.modelId }),
                    ...(here.length === 0 ? {} : { people: here }),
                    ...(chat === undefined ? {} : { chatAt: chat.at, chatBy: chat.userId }),
                };
            })
            .sort((a, b) => b.updatedAt - a.updatedAt);
    }

    isBusy(id: ConversationId): boolean {
        return this.#busy.has(id);
    }

    /** The conversations with a run going. */
    busyConversations(): ConversationId[] {
        return [...this.#busy];
    }

    /** The catalogue entry of a session; undefined for subagents and other conversations. */
    sessionMeta(id: ConversationId): SessionMeta | undefined {
        return this.#sessions[String(id)];
    }

    async conversationTitle(id: ConversationId): Promise<string> {
        const meta = this.#sessions[String(id)];

        if (meta !== undefined) {
            return meta.title ?? "New session";
        }

        return `Conversation ${String(id)}`;
    }

    conversationInfo(room: Room) {
        const meta = this.#sessions[String(room.id)];
        const agent = (room.value?.docs["pi.agent"] ?? {}) as AgentState;
        const forkedFrom = meta?.forkedFrom;
        const root = this.rootOf(room.id);
        const budget = this.#sessions[String(root)]?.budget;

        return {
            id: room.id,
            kind:
                meta === undefined
                    ? room.parent === undefined
                        ? "conversation"
                        : "subagent"
                    : "session",
            title:
                meta?.title ??
                room.subagentName ??
                (meta === undefined ? `Conversation ${String(room.id)}` : "New session"),
            cwd: agent.cwd ?? meta?.cwd ?? this.defaultCwd,
            archived: meta?.archived === true,
            ...(room.parent === undefined ? {} : { parent: room.parent }),
            ...(room.subagentName === undefined ? {} : { subagentName: room.subagentName }),
            // Each browser finds the source's title in its own session list, so only people who can open it get a link.
            ...(forkedFrom === undefined ? {} : { forkedFrom }),
            // The session's spend with its subagents', and its limit.
            spend: {
                spent: this.spend.sessionSpent(root),
                ...(budget === undefined ? {} : { budget }),
            },
            ...(meta?.worktree === undefined
                ? {}
                : { worktree: { branch: meta.worktree.branch, source: meta.worktree.source } }),
            // Whether a fork could get a worktree of its own.
            ...(meta === undefined
                ? {}
                : { inRepository: this.#inRepository(agent.cwd ?? meta.cwd) }),
        };
    }

    #inRepository(cwd: string): boolean {
        const known = this.#repositories.get(cwd);

        if (known !== undefined && Date.now() - known.at < 60_000) {
            return known.inside;
        }

        const inside = inRepository(cwd);

        this.#repositories.set(cwd, { inside, at: Date.now() });

        return inside;
    }

    agentInfo(agent: AgentState) {
        const model =
            agent.model === undefined
                ? undefined
                : this.models.getModel(agent.model.provider, agent.model.modelId);

        return {
            model: agent.model ?? null,
            thinkingLevel: agent.thinkingLevel ?? "off",
            cwd: agent.cwd ?? this.defaultCwd,
            ...(agent.instructions === undefined ? {} : { instructions: agent.instructions }),
            available: model !== undefined && this.models.hasConfiguredAuth(model.provider),
            ...(model === undefined
                ? {}
                : {
                      modelName: model.name,
                      contextWindow: model.contextWindow,
                      reasoning: model.reasoning === true,
                      images: model.input.includes("image"),
                      levels: model.reasoning ? getSupportedThinkingLevels(model) : ["off"],
                  }),
        };
    }

    modelList(): ModelSummary[] {
        return this.models.getAvailableSnapshot().map((model) => ({
            provider: model.provider,
            id: model.id,
            name: model.name,
            contextWindow: model.contextWindow,
            reasoning: model.reasoning === true,
            images: model.input.includes("image"),
            levels: model.reasoning ? getSupportedThinkingLevels(model) : ["off"],
        }));
    }

    resolveModel(spec: string): ModelRef {
        const trimmed = spec.trim();
        const available = this.models.getAvailableSnapshot();
        const slash = trimmed.indexOf("/");
        const found =
            slash > 0
                ? available.find(
                      (model) =>
                          model.provider === trimmed.slice(0, slash) &&
                          model.id === trimmed.slice(slash + 1),
                  )
                : available.find((model) => model.id === trimmed);

        if (found === undefined) {
            const names = available.slice(0, 30).map((model) => `${model.provider}/${model.id}`);

            throw new Error(`Model ${spec} is not available. Available: ${names.join(", ")}`);
        }

        return { provider: found.provider, modelId: found.id };
    }

    /** What a conversation runs with: its model, thinking level, folder, and instructions. */
    async agentState(id: ConversationId): Promise<AgentState | undefined> {
        return (
            this.#agents.get(id) ??
            ((await this.harness.snapshot(AgentDoc, id, context)) as AgentState | undefined)
        );
    }

    /** A conversation's handle; 404 when it does not exist. */
    async conversation(id: ConversationId): Promise<Conversation> {
        const conversation = await this.harness.conversation(id, context);

        if (conversation === undefined) {
            throw new HttpError(404, `Conversation ${String(id)} does not exist`);
        }

        return conversation;
    }

    checkDirectory(path: string): string {
        const absolute = resolve(expandHome(path.trim() === "" ? "~" : path.trim()));
        let ok = false;

        try {
            ok = statSync(absolute).isDirectory();
        } catch {
            ok = false;
        }

        if (!ok) {
            throw new HttpError(400, `${absolute} is not a directory`);
        }

        return absolute;
    }

    /**
     * Who Pi works for in a conversation: the last person who wrote to it, or, for a subagent, whoever its parent worked
     * for when it sent the subagent its last message.
     */
    requesterOf(id: ConversationId): string | undefined {
        return this.#lastAuthor.get(id) ?? this.#lastAuthor.get(this.rootOf(id));
    }

    /**
     * Why this person may not allow a call, or undefined when they may. With the "others" rule, a guest cannot allow a
     * call their own message led to; the owner always can. Denying is open to anyone who can steer.
     */
    cannotAllow(user: User, request: ApprovalRequest): string | undefined {
        if (user.role === "viewer") {
            return "You can view this session but not steer Pi.";
        }

        if (this.config.approvalRule !== "others" || user.role === "owner") {
            return undefined;
        }

        // Not knowing who asked is not knowing that it was someone else.
        if (request.requestedBy === undefined) {
            return "Nobody is known to have asked for this call, so only the owner can allow it.";
        }

        return request.requestedBy === user.id
            ? "Someone else has to allow a call that your message led to."
            : undefined;
    }

    async answerApproval(id: string, allow: boolean, user: User): Promise<boolean> {
        this.requireSteer(user);
        const request = this.approvals.all().find((each) => each.id === id);

        if (request === undefined || !this.canSee(user, request.conversationId)) {
            return false;
        }

        const refused = allow ? this.cannotAllow(user, request) : undefined;

        if (refused !== undefined) {
            throw new HttpError(403, refused);
        }

        if (!this.approvals.answer(id, { allow, by: user.name })) {
            return false;
        }

        const conversationId = request.conversationId;

        if (request.callId !== undefined) {
            const callId = request.callId;

            await this.harness
                .commit(async (tx) => {
                    (await tx.doc(DecisionsDoc, conversationId)).calls[callId] = {
                        allow,
                        by: user.name,
                        userId: user.id,
                        at: Date.now(),
                    };
                }, context)
                .catch((error: unknown) => this.#log(`decision not recorded: ${describe(error)}`));
        }

        await this.collab.activity(
            conversationId,
            user,
            `${allow ? "allowed" : "denied"} the ${request.tool} call: ${snippet(request.subject, 120)}`,
        );

        return true;
    }

    /** The owner changes what someone may do: their role, or which session they may open. */
    setAccess(owner: User, userId: string, patch: { role?: unknown; sessions?: unknown }): void {
        if (owner.role !== "owner") {
            throw new HttpError(403, "Only the owner can do that");
        }

        const target = this.config.userById(userId);

        if (target === undefined) {
            throw new HttpError(404, "No such person");
        }

        if (target.role === "owner") {
            throw new HttpError(400, "The owner can do everything");
        }

        const change: { role?: "guest" | "viewer"; sessions?: string[] | undefined } = {};

        if (patch.role !== undefined) {
            if (patch.role !== "guest" && patch.role !== "viewer") {
                throw new HttpError(400, "role must be guest or viewer");
            }

            change.role = patch.role;
        }

        if (patch.sessions !== undefined) {
            if (patch.sessions === null) {
                change.sessions = undefined;
            } else if (
                Array.isArray(patch.sessions) &&
                patch.sessions.every((each) => this.#sessions[String(each)] !== undefined)
            ) {
                change.sessions = patch.sessions.map(String);
            } else {
                throw new HttpError(400, "sessions must be null or a list of session ids");
            }
        }

        this.config.updateUser(userId, change);
        const updated = this.config.userById(userId);

        for (const client of [...this.#clients]) {
            if (
                client.user.id === userId &&
                client.conversationId !== undefined &&
                updated !== undefined &&
                !this.canSee(updated, client.conversationId)
            ) {
                this.#evict(client, "This session is no longer shared with you.");
            }
        }

        void this.#refreshUser(userId);
        this.#peopleChanged();
    }

    removeUser(owner: User, userId: string): void {
        if (owner.role !== "owner") {
            throw new HttpError(403, "Only the owner can do that");
        }

        if (this.config.userById(userId)?.role === "owner") {
            throw new HttpError(400, "The owner cannot be removed");
        }

        this.#forget(userId);
    }

    /**
     * How other devices reach this server, from the launcher. People who signed in through another Cloudflare quick
     * tunnel can never sign in again (its address is gone, and their cookie works only there), so they are removed.
     */
    setReach(access: AccessInfo | undefined): void {
        this.access = access;
        let current: string | undefined;

        try {
            current = access?.url === undefined ? undefined : new URL(access.url).host;
        } catch {}

        for (const user of [...this.config.users]) {
            if (user.role !== "owner" && user.tunnel !== undefined && user.tunnel !== current) {
                this.#forget(user.id);
            }
        }
    }

    #forget(userId: string): void {
        this.config.removeUser(userId);
        this.pushStore?.removeUser(userId);

        // Their open tabs end now; reconnecting fails, so they land on the sign-in screen.
        for (const client of [...this.#clients]) {
            if (client.user.id !== userId) {
                continue;
            }

            client.send("closing", {});
            this.detach(client);
            client.close?.();
        }

        this.#peopleChanged();
    }

    /** Take a tab out of a conversation it may no longer see; it keeps app-wide events. */
    #evict(client: Client, message: string): void {
        const id = client.conversationId;

        if (id === undefined) {
            return;
        }

        client.conversationId = undefined;
        client.send("missing", { conversationId: id, message });
        this.#leaveRoom(client, id);
    }

    /** Someone's rights changed: their tabs get a fresh hello and session list. */
    async #refreshUser(userId: string): Promise<void> {
        const user = this.config.userById(userId);

        if (user === undefined) {
            return;
        }

        for (const client of this.#clients) {
            if (client.user.id !== userId) {
                continue;
            }

            client.send("hello", await this.hello(user));
            client.send("sessions", this.sessions(user));
        }
    }

    async artifactBody(id: ConversationId, artifact: string, version: number | undefined) {
        const index = await this.harness.snapshot(ArtifactsDoc, id, context);
        const meta = index?.items[artifact] as ArtifactMeta | undefined;

        if (meta === undefined) {
            throw new HttpError(404, "No such artifact");
        }

        const chosen =
            version === undefined
                ? meta.versions.at(-1)
                : meta.versions.find((each) => each.version === version);

        if (chosen === undefined) {
            throw new HttpError(404, "No such version");
        }

        const body = await this.harness.snapshot(
            ArtifactBodyDoc,
            id,
            `${artifact}@${chosen.version}`,
            context,
        );

        if (body === undefined) {
            throw new HttpError(404, "Artifact content is missing");
        }

        return { meta, version: chosen.version, content: body.content };
    }

    /** An image part of a stored message: a pasted image, or an image a tool returned. */
    async entryImage(
        id: ConversationId,
        entryId: number,
        index: number,
    ): Promise<{ mimeType: string; data: Buffer } | undefined> {
        if (!Number.isInteger(entryId) || !Number.isInteger(index) || index < 0) {
            return undefined;
        }

        const entry = await this.visibleEntry(id, entryId);

        if (entry === undefined) {
            return undefined;
        }

        const content = (entry.model?.[0] as { content?: unknown } | undefined)?.content;

        if (!Array.isArray(content)) {
            return undefined;
        }

        const part = (content as { type?: string; data?: unknown; mimeType?: unknown }[]).filter(
            (each) => each?.type === "image",
        )[index];

        if (typeof part?.data !== "string" || typeof part.mimeType !== "string") {
            return undefined;
        }

        return { mimeType: part.mimeType, data: Buffer.from(part.data, "base64") };
    }

    /** The folder a conversation works in. */
    cwdOf(id: ConversationId): string {
        return this.#agents.get(id)?.cwd ?? this.#sessions[String(id)]?.cwd ?? this.defaultCwd;
    }

    /** A path as a conversation means it: absolute, `~/…`, or relative to the conversation's working directory. */
    conversationPath(id: ConversationId, path: string): string {
        return resolve(this.cwdOf(id), expandHome(path.trim()));
    }

    /** Pi's skills in a conversation's folder, to run as `/skill:name`. */
    skillCommands(id: ConversationId): SkillCommand[] {
        let paths: string[] = [];

        try {
            paths = this.settings.getSkillPaths();
        } catch {
            // Unreadable settings: the default folders still count.
        }

        return loadSkillCommands(this.cwdOf(id), getAgentDir(), paths);
    }

    /** Pi's prompt templates, as a conversation in its folder offers them. */
    promptTemplates(id: ConversationId): PromptTemplate[] {
        let paths: string[] = [];

        try {
            paths = this.settings.getPromptTemplatePaths();
        } catch {
            // Unreadable settings: the default folders still count.
        }

        return loadPromptTemplates(this.cwdOf(id), getAgentDir(), paths);
    }

    /**
     * A file a person may load through a conversation. People who can steer reach the whole machine through Pi anyway;
     * viewers and people invited to one session get only files under the conversation's folder or its uploads.
     */
    conversationFile(user: User, id: ConversationId, path: string): string {
        const file = this.conversationPath(id, path);

        if (user.role !== "viewer" && user.sessions === undefined) {
            return file;
        }

        const real = (target: string) => {
            try {
                return realpathSync(target);
            } catch {
                return undefined;
            }
        };

        const target = real(file);
        const cwd = this.cwdOf(id);
        // A fork shows the messages it inherited, with the files attached to them in the sessions it came from. Their
        // later uploads are in the same folders, but an upload's name has random bits in it and shows only in its
        // message, so nobody who cannot read that message can name the file.
        const uploads = this.#lineage(id).map((each) =>
            join(this.dataDir, "uploads", String(each)),
        );
        const roots = [cwd, ...uploads]
            .map(real)
            .filter((root): root is string => root !== undefined);

        if (
            target === undefined ||
            !roots.some((root) => target === root || target.startsWith(root + sep))
        ) {
            throw new HttpError(404, "Image not found");
        }

        return target;
    }

    /**
     * A file a person may read whole through a session: the viewer, and files sent along with a message. As
     * `conversationFile`, but Pi's own folder (sign-ins, settings) and this app's data (people, tokens, the database)
     * are the owner's alone. Uploads and worktrees, which sessions use, are not kept back.
     */
    readableFile(user: User, id: ConversationId, path: string): string {
        const file = this.conversationFile(user, id, path);

        if (user.role === "owner") {
            return file;
        }

        const real = (target: string) => {
            try {
                return realpathSync(target);
            } catch {
                return resolve(target);
            }
        };

        const target = real(file);
        const inside = (root: string) => target === root || target.startsWith(root + sep);
        const data = real(this.dataDir);

        if (
            inside(real(getAgentDir())) ||
            (inside(data) && !inside(join(data, "uploads")) && !inside(join(data, "worktrees")))
        ) {
            throw new HttpError(404, "Not found");
        }

        return file;
    }

    /** This session and the sessions it was forked from, nearest first. */
    #lineage(id: ConversationId): ConversationId[] {
        const lineage = [id];

        for (
            let meta = this.sessionMeta(id);
            meta?.forkedFrom !== undefined && lineage.length < 64;
        ) {
            const parent = meta.forkedFrom.id as unknown as ConversationId;

            if (lineage.includes(parent)) {
                break;
            }

            lineage.push(parent);
            meta = this.sessionMeta(parent);
        }

        return lineage;
    }

    async fullEntry(id: ConversationId, entryId: number): Promise<ClientEntry | undefined> {
        const entry = await this.visibleEntry(id, entryId);

        return entry === undefined ? undefined : projectEntry(entry, true);
    }

    /**
     * An entry of a conversation's history: its own, or one it inherited as a fork (the fork's parent's entries up to
     * the fork point, and so on up the line). Undefined for an entry of any other conversation.
     */
    async visibleEntry(id: ConversationId, entryId: number): Promise<EntryRecord | undefined> {
        if (!Number.isInteger(entryId)) {
            return undefined;
        }

        return this.harness.commit(async (tx) => {
            const entry = await tx.entry(entryId as unknown as EntryId);

            if (entry === undefined) {
                return undefined;
            }

            // Walk up the forks: each one inherits its parent's entries through `parent.at`, and no later ones.
            let conversation = id;
            let through = Number.POSITIVE_INFINITY;

            for (;;) {
                if (entry.conversationId === conversation) {
                    return entryId <= through ? entry : undefined;
                }

                const parent: ConversationRecord["parent"] = (await tx.conversation(conversation))
                    ?.parent;

                if (parent === undefined) {
                    return undefined;
                }

                through = Math.min(through, parent.at as unknown as number);
                conversation = parent.conversationId;
            }
        }, context);
    }

    /** Entries before the active context: what compaction or a reset hid from the model. Oldest first. */
    async history(id: ConversationId, before: number, limit = 400): Promise<ClientEntry[]> {
        const conversation = await this.conversation(id);
        const out: ClientEntry[] = [];
        let cursor: Cursor | undefined;

        do {
            const page = await conversation.entries(
                { maxEntryId: (before - 1) as unknown as EntryId },
                256,
                cursor,
                context,
            );

            for (const entry of page.items) {
                const projected = projectEntry(entry);

                if (projected !== undefined) {
                    out.push(projected);
                }
            }

            cursor = page.next;
        } while (cursor !== undefined && out.length < limit);

        return out.slice(0, limit).reverse();
    }

    /** A conversation's whole history, oldest first, as browsers get it (`full`: nothing clipped). */
    async #allEntries(id: ConversationId, full: boolean): Promise<ClientEntry[]> {
        const conversation = await this.conversation(id);
        const entries: ClientEntry[] = [];
        let cursor: Cursor | undefined;

        do {
            const page = await conversation.entries({}, 256, cursor, context);

            for (const entry of page.items) {
                const projected = projectEntry(entry, full);

                if (projected !== undefined) {
                    entries.push(projected);
                }
            }

            cursor = page.next;
        } while (cursor !== undefined);

        return entries.reverse();
    }

    /**
     * The files in a conversation's folder, for `@` mentions in the message box: for people who can write to Pi. It lists
     * names under the folder only, so someone invited to one session sees no more than `conversationFile` lets them load.
     */
    async fileList(id: ConversationId, user: User): Promise<FileListing> {
        this.requireSee(user, id);
        this.requireSteer(user);
        await this.conversation(id);

        return this.#files.get(this.cwdOf(id));
    }

    /**
     * A file or folder for the viewer, as a person who can steer may load it through the session (`conversationFile`):
     * its text, or that it is an image, a folder's entries, or binary.
     */
    async viewFile(
        id: ConversationId,
        user: User,
        path: string,
    ): Promise<{ path: string; display: string } & FileView> {
        this.requireSee(user, id);
        this.requireSteer(user);
        await this.conversation(id);
        let file: string;

        try {
            file = this.readableFile(user, id, path);

            return {
                path: file,
                display: displayPath(file, this.cwdOf(id)),
                ...(await viewFile(file)),
            };
        } catch (error) {
            if (error instanceof HttpError || (error as NodeJS.ErrnoException).code === "ENOENT") {
                throw new HttpError(404, `${path} is not there.`);
            }

            throw new HttpError(409, describe(error));
        }
    }

    /**
     * Undo the uncommitted changes to one file of a session's repository. It changes files under Pi, so it takes the
     * right to drive and waits until Pi is not working; Pi is told, with its next message.
     */
    async revertChange(id: ConversationId, user: User, path: string): Promise<void> {
        this.requireSee(user, id);
        await this.requireDriver(id, user);

        if (this.isBusy(id)) {
            throw new HttpError(
                409,
                "Pi is working here: wait for it, or stop it, before undoing a file.",
            );
        }

        const kind = await revertFile(this.cwdOf(id), path, user.sessions !== undefined).catch(
            (error: unknown) => {
                throw new HttpError(409, describe(error));
            },
        );
        const what =
            kind === "new" || kind === "added"
                ? `deleted ${path}, which was new since the last commit`
                : `undid the uncommitted changes to ${path}`;

        await this.commands.note(id, user, what);
        await this.collab.activity(id, user, what);
    }

    /** What changed in a session's folder: Pi's edits, and the uncommitted changes of its git repository. */
    async changes(id: ConversationId, user: User): Promise<Changes> {
        this.requireSee(user, id);
        this.requireSteer(user);

        // Someone invited to this session only sees the files in its folder, here as in `conversationFile`.
        return changesIn(
            this.cwdOf(id),
            await this.#allEntries(id, false),
            user.sessions !== undefined,
        );
    }

    /** The diff of one changed file in a session's repository. */
    async changeDiff(id: ConversationId, user: User, path: string): Promise<string> {
        this.requireSee(user, id);
        this.requireSteer(user);

        try {
            return await diffOf(this.cwdOf(id), path, user.sessions !== undefined);
        } catch (error) {
            throw new HttpError(404, describe(error));
        }
    }

    /** A session as a Markdown file: its whole history, with who wrote what. */
    async exportMarkdown(
        id: ConversationId,
        user: User,
    ): Promise<{ filename: string; markdown: string }> {
        this.requireSee(user, id);
        const entries = await this.#allEntries(id, true);
        const authors: Record<number, string> = {};

        for (const [entryId, userId] of Object.entries(
            (await this.harness.snapshot(AuthorsDoc, id, context))?.entries ?? {},
        )) {
            authors[Number(entryId)] = this.config.userById(userId)?.name ?? "Someone";
        }

        const agent = await this.agentState(id);
        const title = await this.conversationTitle(id);
        const markdown = transcriptMarkdown({
            title,
            cwd: homePath(this.cwdOf(id)),
            ...(agent?.model === undefined
                ? {}
                : { model: `${agent.model.provider}/${agent.model.modelId}` }),
            exportedAt: new Date(),
            entries,
            authors,
        });
        const slug =
            title
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "-")
                .replace(/^-+|-+$/g, "")
                .slice(0, 60) || "session";

        return { filename: `${slug}.md`, markdown };
    }

    // ─── Extensions ─────────────────────────────────────────────────────────

    /** Whether Lancet Guard's module is on here; Pi's own setting may still turn the guard off. */
    guardOn(): boolean {
        return this.loader.enabled(GUARD_FILE);
    }

    /** Lancet Guard as it applies here: Pi's own setting, unless the guard extension is off in Pi Pocket. */
    async guardStatus(): Promise<GuardStatus> {
        const status = await this.guard.status();

        if (this.guardOn()) {
            return status;
        }

        return {
            available: status.available,
            enabled: false,
            detail: "Lancet Guard is off in Pi Pocket: bash, write, and edit calls run unchecked here.",
        };
    }

    /** The extension modules, as this person may see them: where the server keeps files is for the owner only. */
    async extensions(
        user: User,
    ): Promise<{ modules: ExtensionInfo[]; guard: GuardStatus; dropIns?: string }> {
        const owner = user.role === "owner";
        // A load error can name the server's folders too.
        const modules = this.loader.list().map(({ path, error, ...module }) =>
            owner
                ? {
                      ...module,
                      ...(path === undefined ? {} : { path }),
                      ...(error === undefined ? {} : { error }),
                  }
                : {
                      ...module,
                      ...(error === undefined ? {} : { error: "It failed to load." }),
                  },
        );

        // The guard row shows Pi's own setting, so the owner can tell "off here" from "off everywhere".
        return {
            modules,
            guard: await this.guard.status(),
            ...(owner ? { dropIns: join(this.dataDir, "extensions") } : {}),
        };
    }

    /** Turn an extension module on or off for every session, now and after restarts. */
    async setExtensionEnabled(user: User, file: string, enabled: boolean): Promise<void> {
        const module = this.loader.list().find((each) => each.file === file);

        if (module === undefined) {
            throw new HttpError(404, `There is no extension module ${file}`);
        }

        if (module.required && !enabled) {
            throw new HttpError(400, `${module.title} is required and cannot be turned off`);
        }

        if (module.enabled === enabled) {
            return;
        }

        this.config.setExtensionEnabled(file, enabled);

        try {
            await this.loader.apply(file);
        } catch (error) {
            throw new HttpError(
                500,
                `${module.title} is on but failed to load: ${describe(error)}`,
            );
        } finally {
            await this.#refreshClients();
        }

        if (file === GUARD_FILE && enabled) {
            void this.guard.warm().catch(() => {});
        }

        if (file === BROWSER_FILE && !enabled) {
            await this.browsers.closeAll();
        }

        this.notice(
            enabled ? "info" : "warning",
            `${user.name} turned ${module.title} ${enabled ? "on" : "off"}.`,
        );
    }

    async reloadExtension(file: string): Promise<void> {
        const module = this.loader.list().find((each) => each.file === file);

        if (module === undefined) {
            throw new HttpError(404, `There is no extension module ${file}`);
        }

        if (!module.enabled) {
            throw new HttpError(409, `${module.title} is off`);
        }

        try {
            await this.loader.reload(file);
        } catch (error) {
            throw new HttpError(500, `${module.title} failed to load: ${describe(error)}`);
        } finally {
            await this.#refreshClients();
        }
    }

    /** The owner changes who may allow risky calls. */
    async setApprovalRule(user: User, rule: unknown): Promise<void> {
        if (user.role !== "owner") {
            throw new HttpError(403, "Only the owner can do that");
        }

        if (rule !== "anyone" && rule !== "others") {
            throw new HttpError(400, "approvalRule must be anyone or others");
        }

        if (rule === this.config.approvalRule) {
            return;
        }

        this.config.approvalRule = rule;
        await this.#refreshClients();
        this.notice(
            "info",
            rule === "others"
                ? `${user.name} made approvals need someone other than who asked.`
                : `${user.name} let anyone who can steer allow risky calls.`,
        );
    }

    /** Send every client a fresh hello: the guard's status and the extension names changed. */
    async #refreshClients(): Promise<void> {
        for (const client of this.#clients) {
            client.send("hello", await this.hello(client.user));
        }
    }

    // ─── Browser ────────────────────────────────────────────────────────────

    /** The browser is on while its extension module is: the owner turns both off together in Extensions. */
    browserOn(): boolean {
        return this.loader.extensionNames().includes(BROWSER_EXTENSION);
    }

    #browserEvent(conversationId: ConversationId, state: BrowserState) {
        return { conversationId: Number(conversationId), ...state };
    }

    // ─── Uploads ────────────────────────────────────────────────────────────

    uploadDirectory(id: ConversationId): string {
        const directory = join(this.dataDir, "uploads", String(id));

        mkdirSync(directory, { recursive: true });

        return directory;
    }

    // ─── Shutdown ───────────────────────────────────────────────────────────

    close(): Promise<void> {
        this.#closing ??= (async () => {
            clearTimeout(this.#sessionsTimer);
            this.alerts.close();
            this.spend.close();
            this.#unsubscribeCommits?.();
            this.#unsubscribeApprovals?.();
            this.#unsubscribeBrowsers?.();
            this.loader?.close();

            for (const client of this.#clients) {
                client.send("closing", {});
            }

            for (const pending of this.#rooms.values()) {
                void pending.then(
                    (room) => room.close(),
                    () => {},
                );
            }

            this.providers.close();

            try {
                // Close writes no outcome: running work resumes when the next process opens the storage.
                await this.harness?.close(context);

                for (const env of this.#envs.values()) {
                    await env.cleanup(context);
                }
            } finally {
                // After the harness: a browser call cut off by the stop resumes as interrupted, not as failed.
                await this.browsers.closeAll({ final: true }).catch(() => {});
                rmSync(this.#lockFile, { force: true });
            }
        })();

        return this.#closing;
    }
}
