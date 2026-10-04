/**
 * Pi Pocket's own durable documents. They live next to the transcripts in the same storage and change in the same
 * commits, so a crash never leaves them disagreeing with the conversation.
 *
 * Kinds are part of the stored data: rename one and old sessions lose it.
 */
import type { JsonValue } from "@earendil-works/chord";
import { type ConversationId, defineDoc, defineDocFamily, type EntryId, type TaskId } from "@earendil-works/pi-durable";

export type SessionMeta = {
	title?: string;
	cwd: string;
	createdAt: number;
	updatedAt: number;
	createdBy?: string;
	archived?: boolean;
};

/** The catalogue of user-facing sessions: ownerless conversations created by the app. Subagents are not listed. */
export const SessionsDoc = defineDoc<{ items: Record<string, SessionMeta> }>({
	kind: "pocket.sessions",
	version: 1,
	scope: "session",
	initial: () => ({ items: {} }),
});

/** Who wrote each user message: requests carry the author until the entry exists, then entries do. */
export const AuthorsDoc = defineDoc<{ requests: Record<string, string>; entries: Record<string, string> }>({
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
export const SubagentsDoc = defineDoc<{ agents: Record<string, SubagentRecord>; reporters: Record<string, TaskId> }>({
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

/** One shared notes page per conversation. `rev` rises with every save, so two editors cannot overwrite each other unseen. */
export const NotesDoc = defineDoc<{ text: string; rev: number; by?: string; at?: number }>({
	kind: "pocket.notes",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ text: "", rev: 0 }),
});

/** Take turns: while on, only the driver sends to Pi or changes its settings. */
export const TurnsDoc = defineDoc<{ on: boolean; driver?: string; asks: string[] }>({
	kind: "pocket.turns",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ on: false, asks: [] }),
});

/** Who allowed or denied each tool call Lancet Guard asked about, by tool call id. */
export const DecisionsDoc = defineDoc<{ calls: Record<string, { allow: boolean; by: string; userId: string; at: number }> }>({
	kind: "pocket.decisions",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ calls: {} }),
});

/** The text a subagent report starts with; the UI renders these as report cards. */
export const REPORT_PREFIX = "[subagent ";
