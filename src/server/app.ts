/**
 * The Pi Pocket server core: one durable Harness over one SQLite file, shared by every session, every subagent, and
 * every connected browser. Browsers attach to a conversation's committed view; nothing a browser sees exists only in
 * memory, except who is connected, who is typing, and which tool calls wait for approval.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { AttachedReplicatedState } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	type AuthPrompt,
	clampThinkingLevel,
	getSupportedThinkingLevels,
	type ImageContent,
	type ModelThinkingLevel,
	type TextContent,
} from "@earendil-works/pi-ai";
import { getAgentDir, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import {
	AgentDoc,
	type AgentState,
	type Conversation,
	type ConversationId,
	type ConversationView,
	type Cursor,
	createRegistry,
	type EntryId,
	type EntryRecord,
	Harness,
	type HarnessSettings,
	type InboxState,
	LiveDoc,
	type LiveState,
	type ModelRef,
	type SubmissionId,
	type UsageState,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { APP_ROOT, ConfigStore, type User } from "./config.ts";
import {
	ArtifactBodyDoc,
	type ArtifactMeta,
	ArtifactsDoc,
	AuthorsDoc,
	CHAT_LIMIT,
	ChatDoc,
	type ChatMessage,
	DecisionsDoc,
	NotesDoc,
	type Pin,
	PinsDoc,
	ReactionsDoc,
	type SessionMeta,
	SessionsDoc,
	type SubagentRecord,
	SubagentsDoc,
	TurnsDoc,
} from "./docs.ts";
import { Approvals, type PocketHost } from "./host.ts";
import { LancetGuard } from "./lancet.ts";
import { configureHttp } from "./net.ts";
import { type PushMessage, type PushPrefs, PushStore } from "./push.ts";
import type { GuardStatus } from "./lancet.ts";
import { type ClientEntry, plainText, projectEntry, projectLive, projectStats } from "./projection.ts";
import { type ExtensionInfo, ExtensionLoader } from "./reload.ts";

const context = BACKGROUND_CONTEXT;

export class HttpError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

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
}

export type Attachment = { path: string; name: string; mime: string; size: number };

export interface SubmitRequest {
	text: string;
	attachments?: Attachment[];
	/** `steer` joins the running work after its current tool round; anything else queues a follow-up while busy. */
	mode?: "steer" | "followUp";
	/** Client-generated, so a retried POST does not submit twice. */
	requestId: string;
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
const ROOM_DOCS = new Set(
	[AuthorsDoc, ArtifactsDoc, SubagentsDoc, ChatDoc, ReactionsDoc, PinsDoc, NotesDoc, TurnsDoc, DecisionsDoc].map((doc) => doc.definition.kind),
);
/** A typing indicator lasts this long unless the browser renews it. */
const TYPING_MS = 6000;
const MAX_CHAT_TEXT = 4000;
const MAX_NOTES = 20_000;
/** Reactions people can leave on a message. */
export const REACTIONS = ["👍", "❤️", "🎉", "👀", "❓", "👎"];
/** How long a run must stay finished before "Pi finished" is pushed: a queued follow-up often starts right away. */
const DONE_DELAY_MS = 3000;

export type TypingPlace = "chat" | "pi";

export type Person = { id: string; name: string; role: string; tabs: number; typing?: TypingPlace; away?: boolean };

type Notes = { text: string; rev: number; by?: string; at?: number };
type Turns = { on: boolean; driver?: string; asks: string[] };
type Decision = { allow: boolean; by: string; userId: string; at: number };

/** A short single-line snippet of a message. */
function snippet(text: string, max = 280): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The visible text of a projected entry, as plain text: what a person or Pi wrote. */
function entryText(entry: ClientEntry): string {
	if (entry.kind === "user") return entry.text.split("\n\nAttached files (saved on the server):\n")[0] ?? "";
	if (entry.kind === "assistant") return plainText(entry.blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n"));
	return "";
}

/** `~/x` for paths under home, in activity lines. */
function homePath(path: string): string {
	const home = homedir();
	return path === home || path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
}
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_INLINE_IMAGE = 5 * 1024 * 1024;

function expandHome(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path;
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The view of one conversation, shared by every client attached to it. */
class Room {
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
		this.authors = { ...((await harness.snapshot(AuthorsDoc, this.id, context))?.entries ?? {}) };
		this.artifacts = { ...((await harness.snapshot(ArtifactsDoc, this.id, context))?.items ?? {}) } as Record<string, ArtifactMeta>;
		this.subagents = { ...((await harness.snapshot(SubagentsDoc, this.id, context))?.agents ?? {}) } as Record<string, SubagentRecord>;
		this.chat = [...((await harness.snapshot(ChatDoc, this.id, context))?.messages ?? [])] as ChatMessage[];
		this.reactions = { ...((await harness.snapshot(ReactionsDoc, this.id, context))?.entries ?? {}) };
		this.pins = [...((await harness.snapshot(PinsDoc, this.id, context))?.items ?? [])] as Pin[];
		this.notes = { ...((await harness.snapshot(NotesDoc, this.id, context)) ?? { text: "", rev: 0 }) };
		this.turns = { ...((await harness.snapshot(TurnsDoc, this.id, context)) ?? { on: false, asks: [] }) } as Turns;
		this.decisions = { ...((await harness.snapshot(DecisionsDoc, this.id, context))?.calls ?? {}) };
		const owner = this.#view.value.conversation.owner;
		if (owner !== undefined) {
			const siblings = (await harness.snapshot(SubagentsDoc, owner.conversationId, context))?.agents ?? {};
			this.subagentName = Object.entries(siblings).find(([, record]) => record.conversationId === this.id)?.[0];
			this.parent = { id: owner.conversationId, title: await this.#app.conversationTitle(owner.conversationId) };
		}
	}

	setDoc(kind: string, value: Record<string, unknown> | null): void {
		if (kind === ChatDoc.definition.kind) {
			// Chat goes out on its own: new messages only, without resending the view.
			const messages = [...((value?.messages as ChatMessage[]) ?? [])];
			const known = new Set(this.chat.map((message) => message.id));
			const added = messages.filter((message) => !known.has(message.id));
			this.chat = messages;
			if (added.length > 0) for (const client of this.clients) client.send("chat", { conversationId: this.id, messages: added });
			return;
		}
		if (kind === NotesDoc.definition.kind) {
			this.notes = { ...((value as Notes | null) ?? { text: "", rev: 0 }) };
			for (const client of this.clients) client.send("notes", { conversationId: this.id, ...this.notes });
			return;
		}
		if (kind === ReactionsDoc.definition.kind) this.reactions = { ...((value?.entries as Room["reactions"]) ?? {}) };
		else if (kind === PinsDoc.definition.kind) this.pins = [...((value?.items as Pin[]) ?? [])];
		else if (kind === TurnsDoc.definition.kind) this.turns = { on: false, asks: [], ...((value as Turns | null) ?? {}) };
		else if (kind === DecisionsDoc.definition.kind) this.decisions = { ...((value?.calls as Record<string, Decision>) ?? {}) };
		if (kind === AuthorsDoc.definition.kind) this.authors = { ...((value?.entries as Record<string, string>) ?? {}) };
		else if (kind === ArtifactsDoc.definition.kind) this.artifacts = { ...((value?.items as Record<string, ArtifactMeta>) ?? {}) };
		else if (kind === SubagentsDoc.definition.kind) this.subagents = { ...((value?.agents as Record<string, SubagentRecord>) ?? {}) };
		this.schedule();
	}

	get value(): ConversationView | undefined {
		return this.#view?.value;
	}

	/** Coalesce bursts of commits (streaming commits land every 100 ms) into one update per client. */
	schedule(): void {
		if (this.#timer !== undefined) return;
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			for (const client of this.clients) this.push(client, false);
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
		if (view === undefined) return;
		if (full) {
			client.sentEntries.clear();
			client.orderKey = "";
		}
		const entries: ClientEntry[] = [];
		const order: number[] = [];
		for (const entry of view.entries) {
			const projected = this.#entry(entry);
			if (projected === null) continue;
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
		client.send("view", {
			full,
			conversation: this.#app.conversationInfo(this),
			entries,
			...(orderChanged || full ? { order } : {}),
			live: projectLive(live),
			inbox: inbox.items.map((item) =>
				item.mode === "write"
					? { id: item.id, mode: item.mode }
					: {
							id: item.id,
							mode: item.mode,
							text: typeof item.content === "string" ? item.content : JSON.stringify(item.content).slice(0, 500),
							...this.#app.submitterOf(item.id as unknown as number, this),
						},
			),
			agent: this.#app.agentInfo(agentState),
			stats: projectStats(view.docs["pi.usage"] as UsageState | undefined, view.entries),
			clients: [...new Set([...this.clients].map((each) => each.id))].length,
			viewers: [...new Set([...this.clients].map((each) => each.user.name))],
			approvals: this.#app.approvals.forConversation(this.id),
			artifacts: Object.entries(this.artifacts).map(([id, meta]) => ({
				id,
				title: meta.title,
				type: meta.type,
				versions: meta.versions.map((version) => ({ version: version.version, size: version.size, createdAt: version.createdAt })),
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
		});
	}

	/** Is this person here, in any tab? */
	has(userId: string): boolean {
		for (const client of this.clients) if (client.user.id === userId) return true;
		return false;
	}

	/** The people here, one row per person however many tabs they have open, and where each is typing. */
	presence(): { conversationId: ConversationId; people: Person[] } {
		const people = new Map<string, Person>();
		const visible = new Set<string>();
		for (const client of this.clients) {
			if (client.visible !== false) visible.add(client.user.id);
			const person = people.get(client.user.id);
			if (person !== undefined) person.tabs++;
			else people.set(client.user.id, { id: client.user.id, name: client.user.name, role: client.user.role, tabs: 1 });
		}
		for (const person of people.values()) if (!visible.has(person.id)) person.away = true;
		for (const [userId, state] of this.#typing) {
			const person = people.get(userId);
			if (person !== undefined) person.typing = state.where;
		}
		return { conversationId: this.id, people: [...people.values()] };
	}

	pushPresence(): void {
		const presence = this.presence();
		for (const client of this.clients) client.send("presence", presence);
	}

	/** Someone started, kept, or stopped typing. Only changes are sent; a renewal just extends the timer. */
	setTyping(userId: string, where: TypingPlace | null): void {
		const current = this.#typing.get(userId);
		clearTimeout(current?.timer);
		if (where === null) {
			if (current === undefined) return;
			this.#typing.delete(userId);
		} else {
			const timer = setTimeout(() => {
				this.#typing.delete(userId);
				this.pushPresence();
			}, TYPING_MS);
			timer.unref();
			this.#typing.set(userId, { where, timer });
			if (current?.where === where) return;
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
		for (const state of this.#typing.values()) clearTimeout(state.timer);
		this.#typing.clear();
		this.#unsubscribe?.();
		this.#view?.dispose();
		this.#view = undefined;
		this.#projected.clear();
	}
}

interface AuthFlow {
	id: string;
	userId: string;
	prompts: Map<string, { resolve: (value: string) => void; reject: (error: Error) => void }>;
	abort: AbortController;
}

export interface OpenOptions {
	dataDir: string;
	defaultCwd: string;
	supervised: boolean;
	log?: (line: string) => void;
	/** Tests register scripted providers here. */
	configureModels?: (models: ModelRuntime) => void;
}

export class PocketApp {
	readonly config: ConfigStore;
	/** Push subscriptions and their keys; undefined until the server opened. */
	pushStore: PushStore | undefined;
	readonly approvals = new Approvals();
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
	readonly #clients = new Set<Client>();
	readonly #rooms = new Map<ConversationId, Promise<Room>>();
	readonly #envs = new Map<string, NodeExecutionEnv>();
	readonly #busy = new Set<ConversationId>();
	readonly #agents = new Map<ConversationId, AgentState>();
	readonly #flows = new Map<string, AuthFlow>();
	readonly #authored = new Set<string>();
	/** The newest chat message (not activity) of each conversation, for unread dots in the session list. */
	readonly #lastChat = new Map<string, { at: number; userId: string }>();
	/** Subagent conversation → the conversation that spawned it. */
	readonly #parents = new Map<ConversationId, ConversationId>();
	/** Who sent each submission, for queued messages. Filled from commits, or looked up once when missing. */
	readonly #submitters = new Map<number, string>();
	readonly #lookups = new Set<number>();
	/** Approvals already announced, so each one is pushed once. */
	#approvalIds = new Set<string>();
	readonly #doneTimers = new Map<ConversationId, NodeJS.Timeout>();
	#sessions: Record<string, SessionMeta> = {};
	#sessionsTimer: NodeJS.Timeout | undefined;
	#unsubscribeCommits: (() => void) | undefined;
	#unsubscribeApprovals: (() => void) | undefined;
	#lockFile: string;
	#closing: Promise<void> | undefined;
	readonly #log: (line: string) => void;
	readonly #configureModels: ((models: ModelRuntime) => void) | undefined;

	private constructor(options: OpenOptions) {
		this.#configureModels = options.configureModels;
		this.dataDir = options.dataDir;
		this.defaultCwd = options.defaultCwd;
		this.supervised = options.supervised;
		this.config = new ConfigStore(options.dataDir);
		this.#lockFile = join(options.dataDir, "harness.lock");
		this.#log = options.log ?? ((line) => console.log(line));
	}

	static async open(options: OpenOptions): Promise<PocketApp> {
		const app = new PocketApp(options);
		await app.#open();
		return app;
	}

	#lock(): void {
		if (existsSync(this.#lockFile)) {
			const pid = Number(readFileSync(this.#lockFile, "utf8").trim());
			let alive = false;
			if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
				try {
					process.kill(pid, 0);
					alive = true;
				} catch {
					alive = false;
				}
			}
			if (alive) throw new Error(`Pi Pocket is already running on this data directory (pid ${pid}).`);
		}
		writeFileSync(this.#lockFile, `${process.pid}\n`);
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
			configureHttp(this.settings.getHttpIdleTimeoutMs() || 2_147_483_647, this.settings.getGlobalSettings().httpProxy);
		} catch (error) {
			this.#log(`HTTP setup failed, using Node defaults: ${describe(error)}`);
		}
		this.models = await ModelRuntime.create();
		this.#configureModels?.(this.models);
		await this.models.getAvailable().catch(() => []);

		const registry = createRegistry();
		registry.install(CodingTools);
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
			notice: (level, message) => this.notice(level, message),
		};
		this.loader = new ExtensionLoader(registry, host, join(APP_ROOT, "src", "server", "extensions"), (file) =>
			this.config.disabledExtensions.includes(file),
		);
		await this.loader.loadAll();

		this.harness = await Harness.open(
			await openNodeSqliteStorage(join(this.dataDir, "pocket.sqlite")),
			{
				models: this.models,
				registry,
				settings: this.#harnessSettings(),
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
		let cursor: Cursor | undefined;
		do {
			const page = await this.harness.commit((tx) => tx.scanConversations({}, 256, cursor), context);
			for (const { id } of page.items) {
				const live = await this.harness.snapshot(LiveDoc, id, context);
				if (live?.run !== undefined) this.#busy.add(id);
				const agent = await this.harness.snapshot(AgentDoc, id, context);
				if (agent !== undefined) this.#agents.set(id, agent as AgentState);
				this.#noteChat(id, (await this.harness.snapshot(ChatDoc, id, context))?.messages);
				this.#noteSubagents(id, (await this.harness.snapshot(SubagentsDoc, id, context))?.agents);
			}
			cursor = page.next;
		} while (cursor !== undefined);

		this.#unsubscribeCommits = this.harness.subscribeCommits((publication) => {
			let sessionsChanged = false;
			for (const change of publication.changes) {
				if (change.type === "document") {
					const kind = change.record.kind;
					const id = change.conversationId;
					if (kind === "pi.live" && id !== undefined) {
						const busy = (change.value as LiveState | null)?.run !== undefined;
						if (busy !== this.#busy.has(id)) {
							if (busy) this.#busy.add(id);
							else this.#busy.delete(id);
							sessionsChanged = true;
							this.#runChanged(id, busy);
							// A parent shows its subagents' busy state.
							for (const pending of this.#rooms.values()) void pending.then((room) => {
								if (Object.values(room.subagents).some((record) => record.conversationId === id)) room.schedule();
							});
						}
					} else if (kind === "pi.agent" && id !== undefined) {
						if (change.value !== null) this.#agents.set(id, change.value as AgentState);
						sessionsChanged = true;
					} else if (kind === SessionsDoc.definition.kind) {
						this.#sessions = { ...(((change.value as { items?: Record<string, SessionMeta> } | null)?.items) ?? {}) };
						sessionsChanged = true;
					} else if (ROOM_DOCS.has(kind) && id !== undefined) {
						if (kind === ChatDoc.definition.kind) {
							if (this.#noteChat(id, (change.value as { messages?: ChatMessage[] } | null)?.messages)) sessionsChanged = true;
						} else if (kind === SubagentsDoc.definition.kind) {
							this.#noteSubagents(id, (change.value as { agents?: Record<string, SubagentRecord> } | null)?.agents);
						}
						void this.#rooms.get(id)?.then(
							(room) => room.setDoc(kind, change.value as Record<string, unknown> | null),
							() => {},
						);
					}
				} else if (change.type === "submission") {
					const record = change.value;
					if (record.requestId?.startsWith("u:")) this.#submitters.set(record.id as unknown as number, record.requestId.split(":")[1] ?? "");
					if (record.type === "input" && record.entry !== undefined && record.requestId?.startsWith("u:")) {
						const key = `${record.conversationId}:${String(record.entry)}`;
						if (!this.#authored.has(key)) {
							this.#authored.add(key);
							const userId = record.requestId.split(":")[1] ?? "";
							const entry = record.entry;
							const conversationId = record.conversationId;
							// Commit listeners may not call Session APIs; record the author right after.
							setImmediate(() => {
								this.harness
									.commit(async (tx) => {
										const doc = await tx.doc(AuthorsDoc, conversationId);
										if (doc.entries[String(entry)] === undefined) doc.entries[String(entry)] = userId;
									}, context)
									.catch((error: unknown) => this.#log(`author not recorded: ${describe(error)}`));
							});
						}
					}
				}
			}
			if (sessionsChanged) this.#scheduleSessions();
		});
		this.#unsubscribeApprovals = this.approvals.subscribe((id) => {
			void this.#rooms.get(id)?.then(
				(room) => room.schedule(),
				() => {},
			);
			this.#scheduleSessions();
			this.#announceApprovals();
		});

		if (this.loader.enabled(GUARD_FILE)) void this.guard.warm().catch(() => {});
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
					...(provider?.maxRetryDelayMs === undefined ? {} : { maxRetryDelayMs: provider.maxRetryDelayMs }),
					...(provider?.maxRetries === undefined ? {} : { maxRetries: provider.maxRetries }),
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

	#env(cwd: string): NodeExecutionEnv {
		let env = this.#envs.get(cwd);
		if (env === undefined) {
			env = new NodeExecutionEnv({ cwd });
			this.#envs.set(cwd, env);
		}
		return env;
	}

	// ─── Clients ────────────────────────────────────────────────────────────

	notice(level: "info" | "warning" | "error", message: string, conversationId?: ConversationId): void {
		this.#log(`[${level}] ${message}`);
		for (const client of this.#clients) {
			// Server-wide notices can name other sessions' folders: people invited to one session do not get them.
			const reaches = conversationId === undefined ? client.user.sessions === undefined : client.conversationId === conversationId && this.canSee(client.user, conversationId);
			if (reaches) client.send("notice", { level, message });
		}
	}

	/** A notice for the people in a conversation, except whoever caused it. */
	#tell(id: ConversationId, except: string | undefined, message: string, extra: Record<string, unknown> = {}): void {
		for (const client of this.#clients) {
			if (client.conversationId === id && client.user.id !== except && this.canSee(client.user, id)) client.send("notice", { level: "info", message, ...extra });
		}
	}

	/** Tell every browser to reload, after a web file changed. */
	reloadClients(file: string): void {
		for (const client of this.#clients) client.send("reload", { file });
	}

	async attach(client: Client): Promise<void> {
		const arriving = !this.#online(client.user.id);
		this.#clients.add(client);
		client.send("hello", await this.hello(client.user));
		client.send("sessions", this.sessions(client.user));
		if (arriving) this.#peopleChanged(client.user.id);
		if (client.conversationId === undefined) return;
		if (!this.canSee(client.user, client.conversationId)) {
			client.send("missing", { conversationId: client.conversationId, message: "This session is not shared with you." });
			// Keep the tab for app-wide events only: nothing about that conversation reaches it, and it is not "there".
			client.conversationId = undefined;
			return;
		}
		try {
			const room = await this.#room(client.conversationId);
			room.keepOpen();
			room.clients.add(client);
			room.push(client, true);
			client.send("chat", { conversationId: room.id, full: true, messages: room.chat });
			client.send("notes", { conversationId: room.id, ...room.notes });
			for (const other of room.clients) if (other !== client) room.push(other, false);
			room.pushPresence();
			this.#scheduleSessions();
		} catch (error) {
			client.send("missing", { conversationId: client.conversationId, message: describe(error) });
		}
	}

	detach(client: Client): void {
		if (!this.#clients.delete(client)) return;
		if (!this.#online(client.user.id)) this.#peopleChanged(client.user.id);
		if (client.conversationId === undefined) return;
		const id = client.conversationId;
		void this.#rooms.get(id)?.then(
			(room) => {
				if (!room.clients.delete(client)) return;
				if (!room.has(client.user.id)) room.setTyping(client.user.id, null);
				room.pushPresence();
				room.schedule();
				this.#scheduleSessions();
				if (room.clients.size === 0) room.closeLater(() => this.#rooms.delete(id));
			},
			() => {},
		);
	}

	/** A tab was hidden or shown: hidden tabs show their person as away, and let push notifications through. */
	setVisible(user: User, tab: string, visible: boolean): void {
		for (const client of this.#clients) {
			if (client.user.id !== user.id || client.id !== tab || client.visible === visible) continue;
			client.visible = visible;
			const id = client.conversationId;
			if (id !== undefined) void this.#rooms.get(id)?.then((room) => room.pushPresence(), () => {});
		}
	}

	#online(userId: string): boolean {
		for (const client of this.#clients) if (client.user.id === userId) return true;
		return false;
	}

	/** Is this person looking at this conversation right now, in a visible tab? */
	#watching(userId: string, id: ConversationId): boolean {
		for (const client of this.#clients) {
			if (client.user.id === userId && client.conversationId === id && client.visible !== false) return true;
		}
		return false;
	}

	/** Change someone's name: shown at once on their messages, in the people lists, and on their avatar. */
	rename(user: User, name: string): void {
		this.config.updateUser(user.id, { name });
		this.#peopleChanged();
		for (const pending of this.#rooms.values()) void pending.then((room) => room.has(user.id) && room.pushPresence(), () => {});
	}

	/** Someone came, went, or changed: remember when they were last here and tell everyone. */
	#peopleChanged(userId?: string): void {
		if (userId !== undefined && this.config.userById(userId) !== undefined) this.config.updateUser(userId, { lastSeen: Date.now() });
		const people = this.people();
		for (const client of this.#clients) client.send("users", people);
	}

	/** Everyone with access to this server: who is online now, and when the others were last here. */
	people() {
		return this.config.users.map((each) => ({
			id: each.id,
			name: each.name,
			role: each.role,
			online: this.#online(each.id),
			...(each.lastSeen === undefined ? {} : { lastSeen: each.lastSeen }),
			...(each.sessions === undefined ? {} : { sessions: each.sessions.map(Number) }),
		}));
	}

	// ─── Access ─────────────────────────────────────────────────────────────

	/** The session a conversation belongs to: itself, or the session its subagent chain started from. */
	rootOf(id: ConversationId): ConversationId {
		let current = id;
		for (let depth = 0; depth < 32; depth++) {
			const parent = this.#parents.get(current);
			if (parent === undefined) return current;
			current = parent;
		}
		return current;
	}

	/** People invited to one session see only that session and its subagents. */
	canSee(user: User, id: ConversationId): boolean {
		return user.sessions === undefined || user.sessions.includes(String(this.rootOf(id)));
	}

	requireSee(user: User, id: ConversationId): void {
		if (!this.canSee(user, id)) throw new HttpError(404, "This session is not shared with you.");
	}

	/** Viewers read, chat, and react; they never make Pi do anything. */
	requireSteer(user: User): void {
		if (user.role === "viewer") throw new HttpError(403, "You can view this session but not steer Pi. Ask the owner for steering rights.");
	}

	/** While take turns is on, only the driver sends to Pi or changes its settings. */
	async #requireDriver(id: ConversationId, user: User): Promise<void> {
		this.requireSteer(user);
		const turns = await this.harness.snapshot(TurnsDoc, this.rootOf(id), context);
		if (turns?.on !== true || turns.driver === user.id) return;
		const driver = turns.driver === undefined ? undefined : this.config.userById(turns.driver);
		throw new HttpError(409, driver === undefined ? "Take turns is on: take the wheel first." : `${driver.name} is driving. Ask to drive first.`);
	}

	#noteChat(id: ConversationId, messages: readonly ChatMessage[] | undefined): boolean {
		const last = messages?.findLast((message) => message.kind !== "event");
		const key = String(id);
		const before = this.#lastChat.get(key);
		if (last === undefined) return this.#lastChat.delete(key);
		if (before?.at === last.at && before.userId === last.userId) return false;
		this.#lastChat.set(key, { at: last.at, userId: last.userId });
		return true;
	}

	#noteSubagents(id: ConversationId, agents: Record<string, SubagentRecord> | undefined): void {
		for (const record of Object.values(agents ?? {})) this.#parents.set(record.conversationId, id);
	}

	/** Who queued a message: `{ by }` when known. Unknown ones (from before a restart) are looked up once. */
	submitterOf(submissionId: number, room: Room): { by?: string } {
		const by = this.#submitters.get(submissionId);
		if (by !== undefined) return { by };
		if (!this.#lookups.has(submissionId)) {
			this.#lookups.add(submissionId);
			void this.harness
				.submission(submissionId as unknown as SubmissionId, context)
				.then((submission) => submission?.status(context))
				.then((record) => {
					if (record?.requestId?.startsWith("u:")) {
						this.#submitters.set(submissionId, record.requestId.split(":")[1] ?? "");
						room.schedule();
					}
				})
				.catch(() => {});
		}
		return {};
	}

	async #room(id: ConversationId): Promise<Room> {
		let pending = this.#rooms.get(id);
		if (pending === undefined) {
			pending = (async () => {
				const conversation = await this.harness.conversation(id, context);
				if (conversation === undefined) throw new HttpError(404, `Conversation ${String(id)} does not exist`);
				const room = new Room(this, id);
				await room.open(conversation);
				return room;
			})();
			this.#rooms.set(id, pending);
			pending.catch(() => this.#rooms.delete(id));
		}
		return pending;
	}

	async hello(user: User) {
		return {
			user: { id: user.id, name: user.name, role: user.role, ...(user.sessions === undefined ? {} : { sessions: user.sessions.map(Number) }) },
			users: this.people(),
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
			},
		};
	}

	#scheduleSessions(): void {
		if (this.#sessionsTimer !== undefined) return;
		this.#sessionsTimer = setTimeout(() => {
			this.#sessionsTimer = undefined;
			const all = this.sessions();
			for (const client of this.#clients) {
				const scope = client.user.sessions;
				client.send("sessions", scope === undefined ? all : all.filter((session) => scope.includes(String(session.id))));
			}
		}, 400);
	}

	/** The session list, with who is in each session and its newest chat message. Scoped people see only theirs. */
	sessions(user?: User) {
		const waiting = new Set(this.approvals.all().map((approval) => String(this.rootOf(approval.conversationId))));
		const people = new Map<string, Map<string, string>>();
		for (const client of this.#clients) {
			if (client.conversationId === undefined) continue;
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
				const here = [...(people.get(id) ?? new Map<string, string>())].map(([userId, name]) => ({ id: userId, name }));
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

	async conversationTitle(id: ConversationId): Promise<string> {
		const meta = this.#sessions[String(id)];
		if (meta !== undefined) return meta.title ?? "New session";
		return `Conversation ${String(id)}`;
	}

	conversationInfo(room: Room) {
		const meta = this.#sessions[String(room.id)];
		const agent = (room.value?.docs["pi.agent"] ?? {}) as AgentState;
		return {
			id: room.id,
			kind: meta === undefined ? (room.parent === undefined ? "conversation" : "subagent") : "session",
			title: meta?.title ?? room.subagentName ?? (meta === undefined ? `Conversation ${String(room.id)}` : "New session"),
			cwd: agent.cwd ?? meta?.cwd ?? this.defaultCwd,
			archived: meta?.archived === true,
			...(room.parent === undefined ? {} : { parent: room.parent }),
			...(room.subagentName === undefined ? {} : { subagentName: room.subagentName }),
		};
	}

	agentInfo(agent: AgentState) {
		const model = agent.model === undefined ? undefined : this.models.getModel(agent.model.provider, agent.model.modelId);
		return {
			model: agent.model ?? null,
			thinkingLevel: agent.thinkingLevel ?? "off",
			cwd: agent.cwd ?? this.defaultCwd,
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
				? available.find((model) => model.provider === trimmed.slice(0, slash) && model.id === trimmed.slice(slash + 1))
				: available.find((model) => model.id === trimmed);
		if (found === undefined) {
			const names = available.slice(0, 30).map((model) => `${model.provider}/${model.id}`);
			throw new Error(`Model ${spec} is not available. Available: ${names.join(", ")}`);
		}
		return { provider: found.provider, modelId: found.id };
	}

	#defaultModel(): { model?: ModelRef; thinkingLevel?: ModelThinkingLevel } {
		const available = this.models.getAvailableSnapshot();
		const pick = (provider: string | undefined, id: string | undefined) =>
			provider === undefined || id === undefined ? undefined : available.find((model) => model.provider === provider && model.id === id);
		const last = this.config.lastModel;
		const model =
			pick(last?.provider, last?.modelId) ??
			pick(this.settings.getDefaultProvider(), this.settings.getDefaultModel()) ??
			available[0];
		if (model === undefined) return {};
		const level = (last?.thinkingLevel ?? this.settings.getDefaultThinkingLevel() ?? "off") as ModelThinkingLevel;
		return { model: { provider: model.provider, modelId: model.id }, thinkingLevel: clampThinkingLevel(model, level) };
	}

	// ─── Commands ───────────────────────────────────────────────────────────

	async #conversation(id: ConversationId): Promise<Conversation> {
		const conversation = await this.harness.conversation(id, context);
		if (conversation === undefined) throw new HttpError(404, `Conversation ${String(id)} does not exist`);
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
		if (!ok) throw new HttpError(400, `${absolute} is not a directory`);
		return absolute;
	}

	async createSession(user: User, request: { cwd?: string; title?: string }): Promise<{ id: ConversationId }> {
		this.requireSteer(user);
		if (user.sessions !== undefined) throw new HttpError(403, "You were invited to one session and cannot start new ones.");
		const cwd = this.checkDirectory(request.cwd ?? this.defaultCwd);
		const initial = this.#defaultModel();
		const now = Date.now();
		const conversation = await this.harness.createConversation(
			{
				ownership: { kind: "ownerless" },
				agent: {
					cwd,
					...(initial.model === undefined ? {} : { model: initial.model }),
					...(initial.thinkingLevel === undefined ? {} : { thinkingLevel: initial.thinkingLevel }),
				},
				init: async (tx, id) => {
					const sessions = await tx.doc(SessionsDoc);
					sessions.items[String(id)] = {
						cwd,
						createdAt: now,
						updatedAt: now,
						createdBy: user.id,
						...(request.title === undefined || request.title.trim() === "" ? {} : { title: request.title.trim().slice(0, 120) }),
					};
				},
			},
			context,
		);
		return { id: conversation.id };
	}

	async updateSession(id: ConversationId, user: User, patch: { title?: string; archived?: boolean }): Promise<void> {
		this.requireSee(user, id);
		this.requireSteer(user);
		const before = this.#sessions[String(id)];
		await this.harness.commit(async (tx) => {
			const sessions = await tx.doc(SessionsDoc);
			const meta = sessions.items[String(id)];
			if (meta === undefined) throw new HttpError(404, "Not a session");
			if (patch.title !== undefined) meta.title = patch.title.trim().slice(0, 120) || undefined;
			if (patch.archived !== undefined) meta.archived = patch.archived;
			meta.updatedAt = Date.now();
		}, context);
		const title = patch.title?.trim().slice(0, 120);
		if (title !== undefined && title !== "" && title !== before?.title) await this.#activity(id, user, `renamed the session to “${title}”`);
		if (patch.archived !== undefined && patch.archived !== (before?.archived === true)) {
			await this.#activity(id, user, patch.archived ? "archived the session" : "brought the session back from the archive");
		}
	}

	async submit(id: ConversationId, user: User, request: SubmitRequest): Promise<{ submissionId: SubmissionId }> {
		this.requireSee(user, id);
		await this.#requireDriver(id, user);
		const conversation = await this.#conversation(id);
		const text = request.text.trim();
		const attachments = request.attachments ?? [];
		if (text === "" && attachments.length === 0) throw new HttpError(400, "Nothing to send");
		const agent = this.#agents.get(id) ?? ((await this.harness.snapshot(AgentDoc, id, context)) as AgentState | undefined);
		const model = agent?.model === undefined ? undefined : this.models.getModel(agent.model.provider, agent.model.modelId);
		if (model === undefined) throw new HttpError(409, "Pick a model for this conversation first.");

		const parts: (TextContent | ImageContent)[] = [];
		let body = text;
		if (attachments.length > 0) {
			const lines = attachments.map((file) => `- ${file.path} (${file.name}, ${file.mime || "unknown type"}, ${file.size} bytes)`);
			body = `${text}\n\nAttached files (saved on the server):\n${lines.join("\n")}`.trim();
		}
		// With more than one person on this server, the model needs to know who is talking.
		if (this.config.users.length > 1) body = `[from: ${user.name.replace(/[\[\]]/g, "")}] ${body}`;
		parts.push({ type: "text", text: body });
		for (const file of attachments) {
			if (!model.input.includes("image") || !IMAGE_TYPES.has(file.mime) || file.size > MAX_INLINE_IMAGE) continue;
			try {
				parts.push({ type: "image", mimeType: file.mime, data: readFileSync(file.path).toString("base64") });
			} catch (error) {
				this.notice("warning", `Could not attach ${file.name}: ${describe(error)}`, id);
			}
		}
		const content = parts.length === 1 ? body : parts;
		const requestId = `u:${user.id}:${request.requestId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) || randomUUID()}`;
		const submission = await conversation.submit(
			{ type: "input", content, whenBusy: request.mode === "steer" ? "steer" : "followUp", requestId },
			context,
		);
		this.setTyping(id, user, null);
		if (this.#sessions[String(id)] !== undefined) {
			await this.harness.commit(async (tx) => {
				const meta = (await tx.doc(SessionsDoc)).items[String(id)];
				if (meta === undefined) return;
				meta.updatedAt = Date.now();
				if (meta.title === undefined && text !== "") meta.title = text.replace(/\s+/g, " ").slice(0, 80);
			}, context);
		}
		void submission.wait(context).then(
			(settled) => {
				if (settled.status === "unanswered" && settled.reason !== "aborted") {
					const detail = settled.detail === undefined ? "" : `: ${JSON.stringify(settled.detail).slice(0, 400)}`;
					this.notice("error", `No answer (${settled.reason})${detail}`, id);
				}
			},
			(error: unknown) => this.notice("error", describe(error), id),
		);
		return { submissionId: submission.id };
	}

	/** Stop the run. Anyone who can steer may, even while someone else drives: stopping is the safe direction. */
	async abort(id: ConversationId, user: User): Promise<void> {
		this.requireSee(user, id);
		this.requireSteer(user);
		const conversation = await this.#conversation(id);
		const busy = this.#busy.has(id);
		void conversation.abort(context).catch((error: unknown) => this.notice("error", `Abort failed: ${describe(error)}`, id));
		if (busy) await this.#activity(id, user, "stopped the run");
	}

	async withdraw(id: ConversationId, user: User, submissionId: number): Promise<string> {
		this.requireSee(user, id);
		this.requireSteer(user);
		const by = this.#submitters.get(submissionId);
		if (by !== user.id) await this.#requireDriver(id, user);
		const result = await this.harness.abortSubmission(submissionId as unknown as SubmissionId, context, id);
		if (by !== undefined && by !== user.id) {
			const author = this.config.userById(by)?.name ?? "someone";
			await this.#activity(id, user, `withdrew ${author}’s queued message`);
		}
		return result;
	}

	async configure(
		id: ConversationId,
		user: User,
		request: { model?: { provider: string; modelId: string }; thinkingLevel?: string; cwd?: string },
	): Promise<void> {
		this.requireSee(user, id);
		await this.#requireDriver(id, user);
		const conversation = await this.#conversation(id);
		const current = (await this.harness.snapshot(AgentDoc, id, context)) as AgentState | undefined;
		const ref = request.model ?? current?.model;
		const model = ref === undefined ? undefined : this.models.getModel(ref.provider, ref.modelId);
		if (request.model !== undefined && model === undefined) {
			throw new HttpError(400, `Unknown model ${request.model.provider}/${request.model.modelId}`);
		}
		const wanted = (request.thinkingLevel ?? current?.thinkingLevel ?? "off") as ModelThinkingLevel;
		const thinkingLevel = model === undefined ? wanted : clampThinkingLevel(model, wanted);
		const cwd = request.cwd === undefined ? undefined : this.checkDirectory(request.cwd);
		await conversation.configure(
			{
				...(request.model === undefined ? {} : { model: { provider: request.model.provider, modelId: request.model.modelId } }),
				thinkingLevel,
				...(cwd === undefined ? {} : { cwd }),
			},
			context,
		);
		if (cwd !== undefined && this.#sessions[String(id)] !== undefined) {
			await this.harness.commit(async (tx) => {
				const meta = (await tx.doc(SessionsDoc)).items[String(id)];
				if (meta !== undefined) meta.cwd = cwd;
			}, context);
		}
		if (ref !== undefined) this.config.lastModel = { provider: ref.provider, modelId: ref.modelId, thinkingLevel };
		const changes: string[] = [];
		const modelChanged =
			request.model !== undefined && (request.model.provider !== current?.model?.provider || request.model.modelId !== current?.model?.modelId);
		if (modelChanged) changes.push(`switched the model to ${model?.name ?? request.model!.modelId}`);
		if (request.thinkingLevel !== undefined && thinkingLevel !== (current?.thinkingLevel ?? "off")) changes.push(`set thinking to ${thinkingLevel}`);
		if (cwd !== undefined && cwd !== current?.cwd) changes.push(`moved the session to ${homePath(cwd)}`);
		if (changes.length > 0) await this.#activity(id, user, changes.join(" and "));
	}

	async compact(id: ConversationId, user: User, instructions: string | undefined): Promise<void> {
		this.requireSee(user, id);
		await this.#requireDriver(id, user);
		const conversation = await this.#conversation(id);
		const taskId = await conversation.compact(instructions, context);
		this.notice("info", "Compacting…", id);
		await this.#activity(id, user, "started compacting the context", false);
		void this.harness.waitForTask(taskId, context).then(
			(receipt) => {
				const outcome = receipt.state.outcome;
				if (outcome.status === "completed") {
					const { entryId, submissionId } = outcome.result;
					this.notice(
						"info",
						entryId === undefined && submissionId === undefined
							? "Nothing to compact: the context fits in the recent window."
							: "Compacted.",
						id,
					);
				} else if (outcome.status === "aborted") {
					this.notice("info", "Compaction aborted.", id);
				} else {
					this.notice("error", `Compaction ${outcome.status}`, id);
				}
			},
			(error: unknown) => this.notice("error", describe(error), id),
		);
	}

	// ─── People ─────────────────────────────────────────────────────────────

	/** Post to the people's side chat of a conversation. Pi does not see it. */
	async postChat(id: ConversationId, user: User, request: { text: string; requestId: string; quote?: { entryId?: unknown } }): Promise<ChatMessage> {
		this.requireSee(user, id);
		await this.#conversation(id);
		const text = request.text.trim();
		if (text === "") throw new HttpError(400, "Message is empty");
		if (text.length > MAX_CHAT_TEXT) throw new HttpError(413, `Chat messages are limited to ${MAX_CHAT_TEXT} characters`);
		let quote: ChatMessage["quote"];
		if (request.quote !== undefined) {
			const entryId = Number(request.quote.entryId);
			const entry = Number.isInteger(entryId) ? await this.fullEntry(id, entryId) : undefined;
			if (entry === undefined) throw new HttpError(400, "The quoted message is not in this conversation");
			quote = { entryId, text: snippet(entryText(entry)) };
		}
		const mentions = this.#mentions(text, user.id);
		const messageId = `${user.id.slice(0, 8)}-${request.requestId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) || randomUUID()}`;
		let created = false;
		const message = await this.harness.commit(async (tx) => {
			const doc = await tx.doc(ChatDoc, id);
			const existing = doc.messages.find((each) => each.id === messageId);
			if (existing !== undefined) return JSON.parse(JSON.stringify(existing)) as ChatMessage;
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
			if (doc.messages.length > CHAT_LIMIT) doc.messages.splice(0, doc.messages.length - CHAT_LIMIT);
			created = true;
			return fresh;
		}, context);
		this.setTyping(id, user, null);
		if (created) void this.#chatPosted(id, user, message);
		return message;
	}

	/** People named as `@Name` in a chat message, by id: the name must end at a word boundary. */
	#mentions(text: string, author: string): string[] {
		const lower = text.toLowerCase();
		const found: string[] = [];
		for (const person of this.config.users) {
			if (person.id === author) continue;
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
		const title = await this.conversationTitle(this.rootOf(id));
		const mentioned = new Set(message.mentions ?? []);
		for (const client of this.#clients) {
			// People in the conversation see the message arrive; mentioned people elsewhere get a notice that opens it.
			if (!mentioned.has(client.user.id) || client.conversationId === id || !this.canSee(client.user, id)) continue;
			client.send("notice", { level: "info", message: `${user.name} mentioned you in “${title}”: ${snippet(message.text, 120)}`, link: { conversationId: id, sheet: "chat" } });
		}
		const url = `/s/${String(id)}?chat=1`;
		for (const userId of mentioned) {
			void this.#push(userId, id, "mention", { title: `${user.name} mentioned you · ${title}`, body: snippet(message.text, 400), url, tag: `chat-${String(id)}` });
		}
		for (const userId of await this.#participants(id)) {
			if (userId === user.id || mentioned.has(userId)) continue;
			void this.#push(userId, id, "chat", { title: `${user.name} · ${title}`, body: snippet(message.text, 400), url, tag: `chat-${String(id)}` });
		}
	}

	/**
	 * A line of activity in the chat ("Alex stopped the run"), and a notice to the others here. Activity is how people
	 * learn who changed what; it never reaches Pi.
	 */
	async #activity(id: ConversationId, user: User, text: string, notify = true): Promise<void> {
		try {
			await this.harness.commit(async (tx) => {
				const doc = await tx.doc(ChatDoc, id);
				const last = doc.messages.at(-1);
				// Saving notes ten times in a row is one line, not ten.
				if (last?.kind === "event" && last.userId === user.id && last.text === text && Date.now() - last.at < 10 * 60_000) {
					last.at = Date.now();
					return;
				}
				doc.messages.push({ id: `ev-${randomUUID()}`, userId: user.id, name: user.name, text, at: Date.now(), kind: "event" });
				if (doc.messages.length > CHAT_LIMIT) doc.messages.splice(0, doc.messages.length - CHAT_LIMIT);
			}, context);
		} catch (error) {
			this.#log(`activity not recorded: ${describe(error)}`);
		}
		if (notify) this.#tell(id, user.id, `${user.name} ${text}`);
	}

	/** Show others that this person is typing, in the chat or to Pi, or that they stopped. */
	setTyping(id: ConversationId, user: User, where: unknown): void {
		const place = where === "chat" || (where === "pi" && user.role !== "viewer") ? where : null;
		if (place !== null && !this.canSee(user, id)) return;
		void this.#rooms.get(id)?.then(
			(room) => room.setTyping(user.id, place),
			() => {},
		);
	}

	/** Add or take back a reaction to a transcript entry. */
	async react(id: ConversationId, user: User, entryId: number, emoji: string): Promise<void> {
		this.requireSee(user, id);
		if (!REACTIONS.includes(emoji)) throw new HttpError(400, `Pick one of ${REACTIONS.join(" ")}`);
		if ((await this.fullEntry(id, entryId)) === undefined) throw new HttpError(404, "No such message");
		await this.harness.commit(async (tx) => {
			const doc = await tx.doc(ReactionsDoc, id);
			const key = String(entryId);
			// Read back through the draft after creating: the assigned plain values are not the tracked ones.
			if (doc.entries[key] === undefined) doc.entries[key] = {};
			const byEmoji = doc.entries[key]!;
			if (byEmoji[emoji] === undefined) byEmoji[emoji] = [];
			const people = byEmoji[emoji]!;
			const at = people.indexOf(user.id);
			if (at === -1) people.push(user.id);
			else people.splice(at, 1);
			if (people.length === 0) delete byEmoji[emoji];
			if (Object.keys(byEmoji).length === 0) delete doc.entries[key];
		}, context);
	}

	/** Pin a transcript entry or a chat message, or unpin it when it is pinned already. */
	async pin(id: ConversationId, user: User, target: { entryId?: unknown; chatId?: unknown }): Promise<{ pinned: boolean }> {
		this.requireSee(user, id);
		let pin: Pin;
		if (target.entryId !== undefined) {
			const entryId = Number(target.entryId);
			const entry = Number.isInteger(entryId) ? await this.fullEntry(id, entryId) : undefined;
			if (entry === undefined || (entry.kind !== "user" && entry.kind !== "assistant")) throw new HttpError(404, "No such message");
			const authorId = (await this.harness.snapshot(AuthorsDoc, id, context))?.entries[String(entryId)];
			const author = entry.kind === "assistant" ? "Pi" : (this.config.userById(authorId ?? "")?.name ?? (entry.kind === "user" ? (entry.from ?? "Someone") : "Someone"));
			pin = { id: `e${entryId}`, entryId, text: snippet(entryText(entry)), author, by: user.id, at: Date.now() };
		} else if (typeof target.chatId === "string") {
			const chat = (await this.harness.snapshot(ChatDoc, id, context))?.messages.find((each) => each.id === target.chatId);
			if (chat === undefined || chat.kind === "event") throw new HttpError(404, "No such chat message");
			pin = { id: `c${chat.id}`, chatId: chat.id, text: snippet(chat.text), author: this.config.userById(chat.userId)?.name ?? chat.name, by: user.id, at: Date.now() };
		} else {
			throw new HttpError(400, "entryId or chatId is required");
		}
		const pinned = await this.harness.commit(async (tx) => {
			const doc = await tx.doc(PinsDoc, id);
			const at = doc.items.findIndex((each) => each.id === pin.id);
			if (at !== -1) {
				doc.items.splice(at, 1);
				return false;
			}
			doc.items.push(pin);
			if (doc.items.length > 100) doc.items.splice(0, doc.items.length - 100);
			return true;
		}, context);
		if (pinned) await this.#activity(id, user, `pinned “${snippet(pin.text, 60)}”`, false);
		return { pinned };
	}

	/** Save the shared notes. `rev` is the version the editor started from: a newer one means someone saved meanwhile. */
	async saveNotes(id: ConversationId, user: User, text: string, rev: number): Promise<Notes> {
		this.requireSee(user, id);
		if (text.length > MAX_NOTES) throw new HttpError(413, `Notes are limited to ${MAX_NOTES} characters`);
		await this.#conversation(id);
		const saved = await this.harness.commit(async (tx) => {
			const doc = await tx.doc(NotesDoc, id);
			if (doc.rev !== rev) {
				const by = doc.by === undefined ? undefined : this.config.userById(doc.by)?.name;
				throw new HttpError(409, `${by ?? "Someone"} changed the notes while you were editing.`);
			}
			doc.text = text;
			doc.rev = rev + 1;
			doc.by = user.id;
			doc.at = Date.now();
			return { text: doc.text, rev: doc.rev, by: doc.by, at: doc.at };
		}, context);
		await this.#activity(id, user, "updated the notes", false);
		return saved;
	}

	/** Take turns: turn it on or off, take the wheel, ask for it, hand it over, or let go. */
	async turns(id: ConversationId, user: User, request: { action?: unknown; to?: unknown }): Promise<void> {
		this.requireSee(user, id);
		this.requireSteer(user);
		const root = this.rootOf(id);
		const room = await this.#room(root);
		const action = String(request.action ?? "");
		const name = (userId: string | undefined) => (userId === undefined ? "someone" : (this.config.userById(userId)?.name ?? "someone"));
		let line: string | undefined;
		await this.harness.commit(async (tx) => {
			const doc = await tx.doc(TurnsDoc, root);
			const isDriver = doc.driver === user.id;
			if (action === "on") {
				if (doc.on) return;
				doc.on = true;
				doc.driver = user.id;
				doc.asks.splice(0);
				line = "turned on take turns and is driving";
			} else if (action === "off") {
				if (!doc.on) return;
				if (!isDriver && user.role !== "owner" && doc.driver !== undefined && room.has(doc.driver)) {
					throw new HttpError(409, `${name(doc.driver)} is driving. Ask them to turn take turns off.`);
				}
				doc.on = false;
				delete doc.driver;
				doc.asks.splice(0);
				line = "turned off take turns";
			} else if (action === "claim") {
				if (!doc.on || isDriver) return;
				if (doc.driver !== undefined && room.has(doc.driver) && user.role !== "owner") {
					throw new HttpError(409, `${name(doc.driver)} is driving. Ask to drive instead.`);
				}
				doc.driver = user.id;
				const at = doc.asks.indexOf(user.id);
				if (at !== -1) doc.asks.splice(at, 1);
				line = "took the wheel";
			} else if (action === "ask") {
				if (!doc.on || isDriver || doc.asks.includes(user.id)) return;
				doc.asks.push(user.id);
				line = "asked to drive";
			} else if (action === "handover") {
				const to = String(request.to ?? "");
				const target = this.config.userById(to);
				if (!doc.on) throw new HttpError(409, "Take turns is off");
				if (!isDriver && user.role !== "owner") throw new HttpError(403, "Only the driver can hand over the wheel");
				if (target === undefined || target.role === "viewer" || !this.canSee(target, root)) throw new HttpError(400, "They cannot drive this session");
				doc.driver = target.id;
				const at = doc.asks.indexOf(target.id);
				if (at !== -1) doc.asks.splice(at, 1);
				line = `handed the wheel to ${target.name}`;
			} else if (action === "release") {
				if (!doc.on || !isDriver) return;
				delete doc.driver;
				line = "let go of the wheel";
			} else {
				throw new HttpError(400, "Unknown take turns action");
			}
		}, context);
		if (line !== undefined) await this.#activity(root, user, line);
	}

	async answerApproval(id: string, allow: boolean, user: User): Promise<boolean> {
		this.requireSteer(user);
		const request = this.approvals.all().find((each) => each.id === id);
		if (request === undefined || !this.canSee(user, request.conversationId)) return false;
		if (!this.approvals.answer(id, { allow, by: user.name })) return false;
		const conversationId = request.conversationId;
		if (request.callId !== undefined) {
			const callId = request.callId;
			await this.harness
				.commit(async (tx) => {
					(await tx.doc(DecisionsDoc, conversationId)).calls[callId] = { allow, by: user.name, userId: user.id, at: Date.now() };
				}, context)
				.catch((error: unknown) => this.#log(`decision not recorded: ${describe(error)}`));
		}
		await this.#activity(conversationId, user, `${allow ? "allowed" : "denied"} the ${request.tool} call: ${snippet(request.subject, 120)}`);
		return true;
	}

	/** The owner changes what someone may do: their role, or which session they may open. */
	setAccess(owner: User, userId: string, patch: { role?: unknown; sessions?: unknown }): void {
		if (owner.role !== "owner") throw new HttpError(403, "Only the owner can do that");
		const target = this.config.userById(userId);
		if (target === undefined) throw new HttpError(404, "No such person");
		if (target.role === "owner") throw new HttpError(400, "The owner can do everything");
		const change: { role?: "guest" | "viewer"; sessions?: string[] | undefined } = {};
		if (patch.role !== undefined) {
			if (patch.role !== "guest" && patch.role !== "viewer") throw new HttpError(400, "role must be guest or viewer");
			change.role = patch.role;
		}
		if (patch.sessions !== undefined) {
			if (patch.sessions === null) change.sessions = undefined;
			else if (Array.isArray(patch.sessions) && patch.sessions.every((each) => this.#sessions[String(each)] !== undefined)) {
				change.sessions = patch.sessions.map(String);
			} else throw new HttpError(400, "sessions must be null or a list of session ids");
		}
		this.config.updateUser(userId, change);
		const updated = this.config.userById(userId);
		for (const client of [...this.#clients]) {
			if (client.user.id === userId && client.conversationId !== undefined && updated !== undefined && !this.canSee(updated, client.conversationId)) {
				this.#evict(client, "This session is no longer shared with you.");
			}
		}
		void this.#refreshUser(userId);
		this.#peopleChanged();
	}

	removeUser(owner: User, userId: string): void {
		if (owner.role !== "owner") throw new HttpError(403, "Only the owner can do that");
		if (this.config.userById(userId)?.role === "owner") throw new HttpError(400, "The owner cannot be removed");
		this.config.removeUser(userId);
		this.pushStore?.removeUser(userId);
		// Their open tabs end now; reconnecting fails, so they land on the sign-in screen.
		for (const client of [...this.#clients]) {
			if (client.user.id !== userId) continue;
			client.send("closing", {});
			this.detach(client);
			client.close?.();
		}
		this.#peopleChanged();
	}

	/** Take a tab out of a conversation it may no longer see; it keeps app-wide events. */
	#evict(client: Client, message: string): void {
		const id = client.conversationId;
		if (id === undefined) return;
		client.conversationId = undefined;
		client.send("missing", { conversationId: id, message });
		void this.#rooms.get(id)?.then(
			(room) => {
				if (!room.clients.delete(client)) return;
				if (!room.has(client.user.id)) room.setTyping(client.user.id, null);
				room.pushPresence();
				room.schedule();
				this.#scheduleSessions();
				if (room.clients.size === 0) room.closeLater(() => this.#rooms.delete(id));
			},
			() => {},
		);
	}

	/** Someone's rights changed: their tabs get a fresh hello and session list. */
	async #refreshUser(userId: string): Promise<void> {
		const user = this.config.userById(userId);
		if (user === undefined) return;
		for (const client of this.#clients) {
			if (client.user.id !== userId) continue;
			client.send("hello", await this.hello(user));
			client.send("sessions", this.sessions(user));
		}
	}

	// ─── Push notifications ─────────────────────────────────────────────────

	/** Push to one person about a conversation, unless they cannot see it, turned that kind off, or are looking at it. */
	async #push(userId: string, id: ConversationId, kind: keyof PushPrefs, message: PushMessage, urgency: "normal" | "high" = "normal"): Promise<void> {
		const store = this.pushStore;
		const user = this.config.userById(userId);
		if (store === undefined || user === undefined || !this.canSee(user, id)) return;
		if (!store.prefs(userId)[kind] || this.#watching(userId, id) || store.subscriptions(userId).length === 0) return;
		// Push services want a real contact; Apple rejects placeholders. A tunnel's https address will do.
		const subject = this.access?.url?.startsWith("https://") ? this.access.url : undefined;
		await store.notify(userId, message, { urgency, ...(subject === undefined ? {} : { subject }) });
	}

	/** A run started or ended. "Pi finished" goes out once it has stayed finished for a moment. */
	#runChanged(id: ConversationId, busy: boolean): void {
		clearTimeout(this.#doneTimers.get(id));
		this.#doneTimers.delete(id);
		if (busy || this.#sessions[String(id)] === undefined || this.pushStore === undefined) return;
		const timer = setTimeout(() => {
			this.#doneTimers.delete(id);
			void this.#pushDone(id).catch((error: unknown) => this.#log(`push failed: ${describe(error)}`));
		}, DONE_DELAY_MS);
		timer.unref();
		this.#doneTimers.set(id, timer);
	}

	async #pushDone(id: ConversationId): Promise<void> {
		if (this.#busy.has(id)) return;
		const conversation = await this.harness.conversation(id, context);
		if (conversation === undefined) return;
		const page = await conversation.entries({}, 12, undefined, context);
		const last = page.items.map((entry) => projectEntry(entry)).find((entry) => entry?.kind === "assistant");
		if (last?.kind !== "assistant" || last.stopReason === "aborted") return;
		const title = await this.conversationTitle(id);
		const failed = last.stopReason === "error";
		const message: PushMessage = {
			title: failed ? `Pi stopped with an error · ${title}` : `Pi finished · ${title}`,
			body: snippet(failed ? (last.error ?? "The model request failed.") : entryText(last) || "Done.", 400),
			url: `/s/${String(id)}`,
			tag: `done-${String(id)}`,
		};
		for (const userId of await this.#participants(id)) void this.#push(userId, id, "done", message);
	}

	/** New approvals go out to everyone in the session who can answer them. */
	#announceApprovals(): void {
		const pending = this.approvals.all();
		const fresh = pending.filter((approval) => !this.#approvalIds.has(approval.id));
		this.#approvalIds = new Set(pending.map((approval) => approval.id));
		if (this.pushStore === undefined) return;
		for (const approval of fresh) {
			void (async () => {
				const root = this.rootOf(approval.conversationId);
				const title = await this.conversationTitle(root);
				const message: PushMessage = {
					title: `Pi needs approval · ${title}`,
					body: snippet(`${approval.tool}: ${approval.subject}`, 400),
					url: `/s/${String(approval.conversationId)}`,
					tag: `approval-${approval.id}`,
				};
				let people = await this.#participants(root);
				if (people.size === 0) people = new Set(this.config.users.map((each) => each.id));
				for (const userId of people) {
					if (this.config.userById(userId)?.role === "viewer") continue;
					void this.#push(userId, approval.conversationId, "approval", message, "high");
				}
			})().catch((error: unknown) => this.#log(`push failed: ${describe(error)}`));
		}
	}

	/** People who take part in a session: whoever started it, wrote to Pi, or chatted there. */
	async #participants(id: ConversationId): Promise<Set<string>> {
		const root = this.rootOf(id);
		const people = new Set<string>();
		const meta = this.#sessions[String(root)];
		if (meta?.createdBy !== undefined) people.add(meta.createdBy);
		for (const userId of Object.values((await this.harness.snapshot(AuthorsDoc, root, context))?.entries ?? {})) people.add(userId);
		for (const message of (await this.harness.snapshot(ChatDoc, root, context))?.messages ?? []) if (message.kind !== "event") people.add(message.userId);
		return people;
	}

	async artifactBody(id: ConversationId, artifact: string, version: number | undefined) {
		const index = await this.harness.snapshot(ArtifactsDoc, id, context);
		const meta = index?.items[artifact] as ArtifactMeta | undefined;
		if (meta === undefined) throw new HttpError(404, "No such artifact");
		const chosen = version === undefined ? meta.versions.at(-1) : meta.versions.find((each) => each.version === version);
		if (chosen === undefined) throw new HttpError(404, "No such version");
		const body = await this.harness.snapshot(ArtifactBodyDoc, id, `${artifact}@${chosen.version}`, context);
		if (body === undefined) throw new HttpError(404, "Artifact content is missing");
		return { meta, version: chosen.version, content: body.content };
	}

	/** An image part of a stored message: a pasted image, or an image a tool returned. */
	async entryImage(id: ConversationId, entryId: number, index: number): Promise<{ mimeType: string; data: Buffer } | undefined> {
		if (!Number.isInteger(entryId) || !Number.isInteger(index) || index < 0) return undefined;
		const entry = await this.harness.commit((tx) => tx.entry(entryId as unknown as EntryId), context);
		if (entry === undefined || entry.conversationId !== id) return undefined;
		const content = (entry.model?.[0] as { content?: unknown } | undefined)?.content;
		if (!Array.isArray(content)) return undefined;
		const part = (content as { type?: string; data?: unknown; mimeType?: unknown }[]).filter((each) => each?.type === "image")[index];
		if (typeof part?.data !== "string" || typeof part.mimeType !== "string") return undefined;
		return { mimeType: part.mimeType, data: Buffer.from(part.data, "base64") };
	}

	/** A path as a conversation means it: absolute, `~/…`, or relative to the conversation's working directory. */
	conversationPath(id: ConversationId, path: string): string {
		const cwd = this.#agents.get(id)?.cwd ?? this.#sessions[String(id)]?.cwd ?? this.defaultCwd;
		return resolve(cwd, expandHome(path.trim()));
	}

	/**
	 * A file a person may load through a conversation. People who can steer reach the whole machine through Pi anyway;
	 * viewers and people invited to one session get only files under the conversation's folder or its uploads.
	 */
	conversationFile(user: User, id: ConversationId, path: string): string {
		const file = this.conversationPath(id, path);
		if (user.role !== "viewer" && user.sessions === undefined) return file;
		const real = (target: string) => {
			try {
				return realpathSync(target);
			} catch {
				return undefined;
			}
		};
		const target = real(file);
		const cwd = this.#agents.get(id)?.cwd ?? this.#sessions[String(id)]?.cwd ?? this.defaultCwd;
		const roots = [cwd, join(this.dataDir, "uploads", String(id))].map(real).filter((root): root is string => root !== undefined);
		if (target === undefined || !roots.some((root) => target === root || target.startsWith(root + sep))) {
			throw new HttpError(404, "Image not found");
		}
		return target;
	}

	async fullEntry(id: ConversationId, entryId: number): Promise<ClientEntry | undefined> {
		const entry = await this.harness.commit((tx) => tx.entry(entryId as unknown as EntryId), context);
		if (entry === undefined || entry.conversationId !== id) return undefined;
		return projectEntry(entry, true);
	}

	/** Entries before the active context: what compaction or a reset hid from the model. Oldest first. */
	async history(id: ConversationId, before: number, limit = 400): Promise<ClientEntry[]> {
		const conversation = await this.#conversation(id);
		const out: ClientEntry[] = [];
		let cursor: Cursor | undefined;
		do {
			const page = await conversation.entries({}, 256, cursor, context);
			for (const entry of page.items) {
				if ((entry.id as unknown as number) >= before) continue;
				const projected = projectEntry(entry);
				if (projected !== undefined) out.push(projected);
			}
			cursor = page.next;
		} while (cursor !== undefined && out.length < limit);
		return out.slice(0, limit).reverse();
	}

	// ─── Provider login ─────────────────────────────────────────────────────

	providers() {
		return this.models.getProviders().map((provider) => {
			const status = this.models.getProviderAuthStatus(provider.id);
			const auth = (provider as { auth?: { apiKey?: unknown; oauth?: { name?: string; loginLabel?: string } } }).auth;
			return {
				id: provider.id,
				name: provider.name,
				configured: status.configured,
				source: status.source ?? null,
				label: status.label ?? null,
				apiKey: auth?.apiKey !== undefined,
				oauth: auth?.oauth === undefined ? null : (auth.oauth.loginLabel ?? auth.oauth.name ?? "Subscription"),
				models: this.models.getModels(provider.id).length,
			};
		});
	}

	startLogin(user: User, providerId: string, type: "api_key" | "oauth"): string {
		const flow: AuthFlow = { id: randomUUID(), userId: user.id, prompts: new Map(), abort: new AbortController() };
		this.#flows.set(flow.id, flow);
		const send = (data: Record<string, unknown>) => {
			for (const client of this.#clients) if (client.user.id === user.id) client.send("auth", { flowId: flow.id, providerId, ...data });
		};
		const interaction = {
			signal: flow.abort.signal,
			prompt: (prompt: AuthPrompt) =>
				new Promise<string>((resolvePrompt, rejectPrompt) => {
					const promptId = randomUUID();
					flow.prompts.set(promptId, { resolve: resolvePrompt, reject: rejectPrompt });
					const { signal, ...shown } = prompt;
					signal?.addEventListener("abort", () => {
						flow.prompts.delete(promptId);
						send({ step: "prompt-closed", promptId });
						rejectPrompt(new Error("cancelled"));
					});
					send({ step: "prompt", promptId, prompt: shown });
				}),
			notify: (event: unknown) => send({ step: "event", event }),
		};
		void this.models
			.login(providerId, type, interaction)
			.then(
				async () => {
					await this.models.getAvailable().catch(() => []);
					send({ step: "done", ok: true });
					const models = this.modelList();
					for (const client of this.#clients) client.send("models", models);
				},
				(error: unknown) => send({ step: "done", ok: false, error: describe(error) }),
			)
			.finally(() => this.#flows.delete(flow.id));
		return flow.id;
	}

	answerLogin(user: User, flowId: string, promptId: string, value: string | undefined): void {
		const flow = this.#flows.get(flowId);
		if (flow === undefined || flow.userId !== user.id) throw new HttpError(404, "No such login");
		const prompt = flow.prompts.get(promptId);
		if (prompt === undefined) throw new HttpError(404, "No such prompt");
		flow.prompts.delete(promptId);
		if (value === undefined) {
			prompt.reject(new Error("cancelled"));
			flow.abort.abort();
		} else {
			prompt.resolve(value);
		}
	}

	async logout(providerId: string): Promise<void> {
		await this.models.logout(providerId);
		await this.models.getAvailable().catch(() => []);
		const models = this.modelList();
		for (const client of this.#clients) client.send("models", models);
	}

	// ─── Extensions ─────────────────────────────────────────────────────────

	/** Lancet Guard as it applies here: Pi's own setting, unless the guard extension is off in Pi Pocket. */
	async guardStatus(): Promise<GuardStatus> {
		const status = await this.guard.status();
		if (this.loader.enabled(GUARD_FILE)) return status;
		return { available: status.available, enabled: false, detail: "Lancet Guard is off in Pi Pocket: bash, write, and edit calls run unchecked here." };
	}

	async extensions(): Promise<{ modules: ExtensionInfo[]; guard: GuardStatus }> {
		// The guard row shows Pi's own setting, so the owner can tell "off here" from "off everywhere".
		return { modules: this.loader.list(), guard: await this.guard.status() };
	}

	/** Turn an extension module on or off for every session, now and after restarts. */
	async setExtensionEnabled(user: User, file: string, enabled: boolean): Promise<void> {
		const module = this.loader.list().find((each) => each.file === file);
		if (module === undefined) throw new HttpError(404, `There is no extension module ${file}`);
		if (module.required && !enabled) throw new HttpError(400, `${module.title} is required and cannot be turned off`);
		if (module.enabled === enabled) return;
		this.config.setExtensionEnabled(file, enabled);
		try {
			await this.loader.apply(file);
		} catch (error) {
			throw new HttpError(500, `${module.title} is on but failed to load: ${describe(error)}`);
		} finally {
			await this.#refreshClients();
		}
		if (file === GUARD_FILE && enabled) void this.guard.warm().catch(() => {});
		this.notice(enabled ? "info" : "warning", `${user.name} turned ${module.title} ${enabled ? "on" : "off"}.`);
	}

	async reloadExtension(file: string): Promise<void> {
		const module = this.loader.list().find((each) => each.file === file);
		if (module === undefined) throw new HttpError(404, `There is no extension module ${file}`);
		if (!module.enabled) throw new HttpError(409, `${module.title} is off`);
		try {
			await this.loader.reload(file);
		} catch (error) {
			throw new HttpError(500, `${module.title} failed to load: ${describe(error)}`);
		} finally {
			await this.#refreshClients();
		}
	}

	/** Send every client a fresh hello: the guard's status and the extension names changed. */
	async #refreshClients(): Promise<void> {
		for (const client of this.#clients) client.send("hello", await this.hello(client.user));
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
			for (const timer of this.#doneTimers.values()) clearTimeout(timer);
			this.#unsubscribeCommits?.();
			this.#unsubscribeApprovals?.();
			this.loader?.close();
			for (const client of this.#clients) client.send("closing", {});
			for (const pending of this.#rooms.values()) void pending.then((room) => room.close(), () => {});
			for (const flow of this.#flows.values()) flow.abort.abort();
			try {
				// Close writes no outcome: running work resumes when the next process opens the storage.
				await this.harness?.close(context);
				for (const env of this.#envs.values()) await env.cleanup(context);
			} finally {
				rmSync(this.#lockFile, { force: true });
			}
		})();
		return this.#closing;
	}
}
