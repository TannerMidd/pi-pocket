/**
 * What people ask of Pi: start and rename sessions, send messages (steer or queue), stop, withdraw, and change the
 * model, thinking level, or folder of a conversation; compact or reset its context and set its instructions; fork it,
 * or send a message again; set plan mode, a goal, or scheduled messages; and remove a session's worktree. Every
 * command checks who may do it, and changes others should know about become activity lines in the session's chat.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { clampThinkingLevel, type ImageContent, type ModelThinkingLevel, type TextContent } from "@earendil-works/pi-ai";
import type { AgentChange, ConversationCreateOptions, ConversationId, EntryId, ModelRef, SubmissionId } from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import type { User } from "./config.ts";
import { AuthorsDoc, ChatDoc, NotesDoc, PinsDoc, PlanDoc, type Schedule, SessionsDoc, SubagentsDoc } from "./docs.ts";
import { describe, HttpError, optionalText } from "./errors.ts";
import { homePath } from "./paths.ts";
import { ATTACHMENTS_HEADING, FROM_PREFIX, snippet } from "./projection.ts";
import { expandPromptTemplate } from "./prompts.ts";
import { ownRequest } from "./requests.ts";
import { type Resend, resendContent, resendRequest, ResendTask, userContent } from "./resend.ts";
import { describeMoment, describeRepeat, knownZone } from "./when.ts";
import { createWorktree, discardWorktree, inWorktree, removeWorktree, sourceFolders, type Worktree } from "./worktrees.ts";

const context = BACKGROUND_CONTEXT;

export type Attachment = { path: string; name: string; mime: string; size: number };

export interface SubmitRequest {
	text: string;
	attachments?: Attachment[];
	/** `steer` joins the running work after its current tool round; anything else queues a follow-up while busy. */
	mode?: "steer" | "followUp";
	/** Client-generated, so a retried POST does not submit twice. */
	requestId: string;
}

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
/** Attached images that also go to the model itself, when it takes images. */
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_INLINE_IMAGE = 5 * 1024 * 1024;
const MAX_TITLE = 120;
/** The extension that makes plan mode block changes; without it, plan mode would do nothing. */
const PLAN_EXTENSION = "pocket-plan";
/** What Pi is told when someone approves its plan. */
const PLAN_APPROVED = "The plan is approved. Go ahead and carry it out.";
/** Longest handoff note for a new context, and longest instructions for Pi. */
const MAX_HANDOFF = 20_000;
const MAX_INSTRUCTIONS = 8000;

/** Where a new session works: a folder, and the worktree it is in when the session has one of its own. */
type Place = { cwd: string; worktree?: Worktree; skipped: string[] };

/** An entry id from a request, or a 400. */
function entryIdOf(value: unknown): number {
	const id = Number(value);
	if (!Number.isInteger(id) || id < 0) throw new HttpError(400, "entryId must be a message id");
	return id;
}

export class Commands {
	readonly #app: PocketApp;

	constructor(app: PocketApp) {
		this.#app = app;
	}

	/** Start a session in a folder; with `worktree`, in a git worktree of its own made from that folder. */
	async createSession(user: User, request: { cwd?: string; title?: string; worktree?: unknown }): Promise<{ id: ConversationId }> {
		const app = this.#app;
		app.requireSteer(user);
		if (user.sessions !== undefined) throw new HttpError(403, "You were invited to one session and cannot start new ones.");
		const title = optionalText(request.title, "title")?.trim().slice(0, MAX_TITLE) || undefined;
		const folder = app.checkDirectory(optionalText(request.cwd, "cwd") ?? app.defaultCwd);
		const initial = this.#defaultModel();
		const now = Date.now();
		return this.#inPlace(folder, request.worktree === true, title ?? basename(folder), async ({ cwd, worktree }) => {
			const conversation = await app.harness.createConversation(
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
							...(title === undefined ? {} : { title }),
							...(worktree === undefined ? {} : { worktree }),
						};
					},
				},
				context,
			);
			return { id: conversation.id };
		});
	}

	/**
	 * Run `create` with the folder a new session works in: `cwd` itself, or, when `isolated`, the matching folder in a
	 * new git worktree made from it, named after `label`. A worktree whose session `create` did not make is discarded.
	 */
	async #inPlace<T>(cwd: string, isolated: boolean, label: string, create: (place: Place) => Promise<T>): Promise<T> {
		if (!isolated) return create({ cwd, skipped: [] });
		const made = await createWorktree(cwd, join(this.#app.dataDir, "worktrees"), label);
		try {
			return await create(made);
		} catch (error) {
			await discardWorktree(made.worktree).catch((cleanup: unknown) => this.#app.log(`worktree ${made.worktree.path} left behind: ${describe(cleanup)}`));
			throw error;
		}
	}

	/** Remove a session's worktree folder; its branch stays. One with uncommitted changes stays too, unless `force`. */
	async removeWorktree(id: ConversationId, user: User, force: unknown): Promise<void> {
		const app = this.#app;
		app.requireSee(user, id);
		await app.requireDriver(id, user);
		const worktree = app.sessionMeta(id)?.worktree;
		if (worktree === undefined) throw new HttpError(404, "This session has no worktree");
		const inside = (cwd: string) => inWorktree(worktree, cwd);
		// Anything at work there would lose its folder: this session's runs, its subagents', or another session's.
		if (app.busyConversations().some((busy) => inside(app.cwdOf(busy)))) throw new HttpError(409, "Pi is working in the worktree: stop it first.");
		// A fork made without a worktree of its own works in this one.
		const sharing = app.sessions().find((session) => session.id !== Number(id) && inside(app.cwdOf(session.id as unknown as ConversationId)));
		if (sharing !== undefined) throw new HttpError(409, `“${sharing.title ?? "New session"}” works in this worktree too. Move it to another folder first.`);
		const back = await sourceFolders(worktree);
		const moves = app
			.conversationsOf(id)
			.filter((each) => inside(app.cwdOf(each)))
			.map((each) => ({ id: each, cwd: back(app.cwdOf(each)) }));
		await removeWorktree(worktree, force === true);
		// The session and its subagents go back to the folders the worktree came from.
		for (const move of moves) await (await app.conversation(move.id)).configure({ cwd: move.cwd }, context);
		const cwd = app.cwdOf(id);
		await app.harness.commit(async (tx) => {
			const meta = (await tx.doc(SessionsDoc)).items[String(id)];
			if (meta === undefined) return;
			delete meta.worktree;
			meta.cwd = cwd;
		}, context);
		await app.collab.activity(id, user, `removed the worktree; the branch ${worktree.branch} stays, and Pi works in ${homePath(cwd)} again`);
	}

	/** The model a new session starts with: the one last chosen here, else Pi's default, else any available one. */
	#defaultModel(): { model?: ModelRef; thinkingLevel?: ModelThinkingLevel } {
		const { models, config, settings } = this.#app;
		const available = models.getAvailableSnapshot();
		const pick = (provider: string | undefined, id: string | undefined) =>
			provider === undefined || id === undefined ? undefined : available.find((model) => model.provider === provider && model.id === id);
		const last = config.lastModel;
		const model = pick(last?.provider, last?.modelId) ?? pick(settings.getDefaultProvider(), settings.getDefaultModel()) ?? available[0];
		if (model === undefined) return {};
		const level = (last?.thinkingLevel ?? settings.getDefaultThinkingLevel() ?? "off") as ModelThinkingLevel;
		return { model: { provider: model.provider, modelId: model.id }, thinkingLevel: clampThinkingLevel(model, level) };
	}

	async updateSession(id: ConversationId, user: User, patch: { title?: string; archived?: boolean }): Promise<void> {
		const app = this.#app;
		app.requireSee(user, id);
		app.requireSteer(user);
		optionalText(patch.title, "title");
		if (patch.archived !== undefined && typeof patch.archived !== "boolean") throw new HttpError(400, "archived must be true or false");
		const before = app.sessionMeta(id);
		await app.harness.commit(async (tx) => {
			const sessions = await tx.doc(SessionsDoc);
			const meta = sessions.items[String(id)];
			if (meta === undefined) throw new HttpError(404, "Not a session");
			// A rename moves the session up the list. Archiving does not: brought back, or undone, it returns to where it was.
			if (patch.title !== undefined) {
				meta.title = patch.title.trim().slice(0, MAX_TITLE) || undefined;
				meta.updatedAt = Date.now();
			}
			if (patch.archived !== undefined) meta.archived = patch.archived;
		}, context);
		const title = patch.title?.trim().slice(0, MAX_TITLE);
		if (title !== undefined && title !== "" && title !== before?.title) await app.collab.activity(id, user, `renamed the session to “${title}”`);
		if (patch.archived !== undefined && patch.archived !== (before?.archived === true)) {
			await app.collab.activity(id, user, patch.archived ? "archived the session" : "brought the session back from the archive");
		}
	}

	async submit(id: ConversationId, user: User, request: SubmitRequest): Promise<{ submissionId: SubmissionId }> {
		const app = this.#app;
		app.requireSee(user, id);
		await app.requireDriver(id, user);
		const conversation = await app.conversation(id);
		const typed = request.text.trim();
		// `/name arguments` sends Pi's prompt template of that name, filled in.
		const text = typed.startsWith("/") ? (expandPromptTemplate(typed, app.promptTemplates(id)) ?? typed) : typed;
		const attachments = request.attachments ?? [];
		if (text === "" && attachments.length === 0) throw new HttpError(400, "Nothing to send");
		const agent = await app.agentState(id);
		const model = agent?.model === undefined ? undefined : app.models.getModel(agent.model.provider, agent.model.modelId);
		if (model === undefined) throw new HttpError(409, "Pick a model for this conversation first.");
		app.spend.check(user, id);

		const lines = attachments.map((file) => `- ${file.path} (${file.name}, ${file.mime || "unknown type"}, ${file.size} bytes)`);
		const body = this.messageText(user, lines.length === 0 ? text : `${text}${ATTACHMENTS_HEADING}${lines.join("\n")}`.trim());
		const parts: (TextContent | ImageContent)[] = [{ type: "text", text: body }];
		for (const file of attachments) {
			if (!model.input.includes("image") || !IMAGE_TYPES.has(file.mime) || file.size > MAX_INLINE_IMAGE) continue;
			try {
				parts.push({ type: "image", mimeType: file.mime, data: readFileSync(file.path).toString("base64") });
			} catch (error) {
				app.notice("warning", `Could not attach ${file.name}: ${describe(error)}`, id);
			}
		}
		const content = parts.length === 1 ? body : parts;
		const requestId = ownRequest(user.id, request.requestId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) || randomUUID());
		const submission = await conversation.submit(
			{ type: "input", content, whenBusy: request.mode === "steer" ? "steer" : "followUp", requestId },
			context,
		);
		app.collab.setTyping(id, user, null);
		await this.#touched(id, typed);
		this.#reportUnanswered(id, submission.wait(context));
		return { submissionId: submission.id };
	}

	/** A message to Pi as the model gets it: with more than one person on this server, it says who is talking. */
	messageText(user: Pick<User, "name">, text: string): string {
		return this.#app.config.users.length > 1 ? `[from: ${user.name.replace(/[[\]]/g, "")}] ${text}` : text;
	}

	/** A session just got a message: it moves up the list, and its first message names it. */
	async #touched(id: ConversationId, text: string): Promise<void> {
		if (this.#app.sessionMeta(id) === undefined) return;
		await this.#app.harness.commit(async (tx) => {
			const meta = (await tx.doc(SessionsDoc)).items[String(id)];
			if (meta === undefined) return;
			meta.updatedAt = Date.now();
			if (meta.title === undefined && text !== "") meta.title = text.replace(/\s+/g, " ").slice(0, 80);
		}, context);
	}

	/** A message Pi could not answer, other than one someone stopped, shows as an error to the people there. */
	#reportUnanswered(id: ConversationId, settled: Promise<{ status: string; reason?: string; detail?: unknown }>): void {
		const app = this.#app;
		void settled.then(
			(result) => {
				if (result.status === "unanswered" && result.reason !== "aborted") {
					const detail = result.detail === undefined ? "" : `: ${JSON.stringify(result.detail).slice(0, 400)}`;
					app.notice("error", `No answer (${result.reason})${detail}`, id);
				}
			},
			(error: unknown) => app.notice("error", describe(error), id),
		);
	}

	/** Stop the run. Anyone who can steer may, even while someone else drives: stopping is the safe direction. */
	async abort(id: ConversationId, user: User): Promise<void> {
		const app = this.#app;
		app.requireSee(user, id);
		app.requireSteer(user);
		const conversation = await app.conversation(id);
		const busy = app.isBusy(id);
		void conversation.abort(context).catch((error: unknown) => app.notice("error", `Abort failed: ${describe(error)}`, id));
		if (busy) await app.collab.activity(id, user, "stopped the run");
	}

	/** Take back a queued message. Anyone may take back their own; someone else's needs the right to drive. */
	async withdraw(id: ConversationId, user: User, submissionId: number): Promise<string> {
		const app = this.#app;
		app.requireSee(user, id);
		app.requireSteer(user);
		const by = app.knownSubmitter(submissionId);
		if (by !== user.id) await app.requireDriver(id, user);
		const result = await app.harness.abortSubmission(submissionId as unknown as SubmissionId, context, id);
		if (by !== undefined && by !== user.id) {
			const author = app.config.userById(by)?.name ?? "someone";
			await app.collab.activity(id, user, `withdrew ${author}’s queued message`);
		}
		return result;
	}

	async configure(
		id: ConversationId,
		user: User,
		request: { model?: { provider: string; modelId: string }; thinkingLevel?: string; cwd?: string },
	): Promise<void> {
		const app = this.#app;
		app.requireSee(user, id);
		await app.requireDriver(id, user);
		const asked = request.model as { provider?: unknown; modelId?: unknown } | undefined;
		if (asked !== undefined && (typeof asked !== "object" || asked === null || typeof asked.provider !== "string" || typeof asked.modelId !== "string")) {
			throw new HttpError(400, "model must name a provider and a model id");
		}
		if (optionalText(request.thinkingLevel, "thinkingLevel") !== undefined && !THINKING_LEVELS.has(request.thinkingLevel!)) {
			throw new HttpError(400, `thinkingLevel must be one of ${[...THINKING_LEVELS].join(", ")}`);
		}
		optionalText(request.cwd, "cwd");
		const conversation = await app.conversation(id);
		const current = await app.agentState(id);
		const ref = request.model ?? current?.model;
		const model = ref === undefined ? undefined : app.models.getModel(ref.provider, ref.modelId);
		if (request.model !== undefined && model === undefined) {
			throw new HttpError(400, `Unknown model ${request.model.provider}/${request.model.modelId}`);
		}
		const wanted = (request.thinkingLevel ?? current?.thinkingLevel ?? "off") as ModelThinkingLevel;
		const thinkingLevel = model === undefined ? wanted : clampThinkingLevel(model, wanted);
		const cwd = request.cwd === undefined ? undefined : app.checkDirectory(request.cwd);
		await conversation.configure(
			{
				...(request.model === undefined ? {} : { model: { provider: request.model.provider, modelId: request.model.modelId } }),
				thinkingLevel,
				...(cwd === undefined ? {} : { cwd }),
			},
			context,
		);
		if (cwd !== undefined && app.sessionMeta(id) !== undefined) {
			await app.harness.commit(async (tx) => {
				const meta = (await tx.doc(SessionsDoc)).items[String(id)];
				if (meta !== undefined) meta.cwd = cwd;
			}, context);
		}
		if (ref !== undefined) app.config.lastModel = { provider: ref.provider, modelId: ref.modelId, thinkingLevel };
		const changes: string[] = [];
		const modelChanged =
			request.model !== undefined && (request.model.provider !== current?.model?.provider || request.model.modelId !== current?.model?.modelId);
		if (modelChanged) changes.push(`switched the model to ${model?.name ?? request.model!.modelId}`);
		if (request.thinkingLevel !== undefined && thinkingLevel !== (current?.thinkingLevel ?? "off")) changes.push(`set thinking to ${thinkingLevel}`);
		if (cwd !== undefined && cwd !== current?.cwd) changes.push(`moved the session to ${homePath(cwd)}`);
		if (changes.length > 0) await app.collab.activity(id, user, changes.join(" and "));
	}

	/** Start a new context: Pi no longer sees what came before, though everyone still can. An optional note carries over. */
	async reset(id: ConversationId, user: User, note: unknown): Promise<void> {
		const app = this.#app;
		app.requireSee(user, id);
		await app.requireDriver(id, user);
		const handoff = optionalText(note, "note")?.trim() || undefined;
		if (handoff !== undefined && handoff.length > MAX_HANDOFF) throw new HttpError(413, `Handoff notes are limited to ${MAX_HANDOFF} characters`);
		await (await app.conversation(id)).reset(handoff, context);
		await app.collab.activity(id, user, handoff === undefined ? "started a new context" : "started a new context with a handoff note");
	}

	/**
	 * Set what Pi is told in every request of a session, after its own system prompt: ground rules everyone here shares.
	 * Empty text clears them. Subagents keep theirs: they say who the subagent is.
	 */
	async setInstructions(id: ConversationId, user: User, text: unknown): Promise<void> {
		const app = this.#app;
		app.requireSee(user, id);
		await app.requireDriver(id, user);
		if (app.sessionMeta(id) === undefined) throw new HttpError(400, "Only sessions have instructions for Pi");
		const instructions = (optionalText(text, "instructions") ?? "").trim();
		if (instructions.length > MAX_INSTRUCTIONS) throw new HttpError(413, `Instructions are limited to ${MAX_INSTRUCTIONS} characters`);
		const before = (await app.agentState(id))?.instructions ?? "";
		if (instructions === before) return;
		await (await app.conversation(id)).configure({ instructions: instructions === "" ? null : instructions }, context);
		await app.collab.activity(id, user, instructions === "" ? "cleared the instructions for Pi" : "changed the instructions for Pi");
	}

	/** Turn plan mode on or off: while it is on, Pi reads and proposes a plan, and anything that changes something is blocked. */
	async setPlan(id: ConversationId, user: User, on: unknown): Promise<void> {
		const app = this.#app;
		app.requireSee(user, id);
		await app.requireDriver(id, user);
		if (typeof on !== "boolean") throw new HttpError(400, "on must be true or false");
		this.#requireSession(id);
		if (on && !app.loader.extensionNames().includes(PLAN_EXTENSION)) throw new HttpError(409, "Plan mode is turned off in Extensions.");
		if (await this.#switchPlan(id, user, on)) await app.collab.activity(id, user, on ? "turned on plan mode" : "turned off plan mode");
	}

	/** Approve Pi's plan: plan mode goes off, and Pi is told to carry the plan out. */
	async approvePlan(id: ConversationId, user: User): Promise<{ submissionId: SubmissionId }> {
		const app = this.#app;
		app.requireSee(user, id);
		await app.requireDriver(id, user);
		this.#requireSession(id);
		if (!(await this.#switchPlan(id, user, false))) throw new HttpError(409, "Plan mode is not on.");
		await app.collab.activity(id, user, "approved the plan");
		return this.submit(id, user, { text: PLAN_APPROVED, requestId: randomUUID() });
	}

	/** Plan mode is set for a whole session, not for one of its subagents. */
	#requireSession(id: ConversationId): void {
		if (this.#app.parentOf(id) !== undefined) throw new HttpError(400, "Plan mode is set for the whole session, in its main conversation.");
	}

	/** Set plan mode for a session and the subagents under it; true when that changed it. */
	#switchPlan(id: ConversationId, user: User, on: boolean): Promise<boolean> {
		return this.#app.harness.commit(async (tx) => {
			if ((await tx.doc(PlanDoc, id)).on === on) return false;
			// Subagents follow their session: one already at work stops changing things too.
			const conversations = [id];
			for (let index = 0; index < conversations.length; index++) {
				for (const agent of Object.values((await tx.doc(SubagentsDoc, conversations[index]!)).agents)) conversations.push(agent.conversationId);
			}
			const at = Date.now();
			for (const each of conversations) Object.assign(await tx.doc(PlanDoc, each), { on, by: user.id, at });
			return true;
		}, context);
	}

	/** Set up a message to Pi for later, or on repeat: `when` is when, then what it says (`in 2h check the deploy`). */
	async schedule(id: ConversationId, user: User, request: { when?: unknown; zone?: unknown }): Promise<Schedule> {
		const app = this.#app;
		app.requireSee(user, id);
		await app.requireDriver(id, user);
		const zone = optionalText(request.zone, "zone");
		if (zone !== undefined && !knownZone(zone)) throw new HttpError(400, `Unknown time zone ${zone}`);
		app.spend.check(user, id);
		const schedule = await app.schedules.add(id, { when: optionalText(request.when, "when") ?? "", by: user, ...(zone === undefined ? {} : { zone }) });
		const when = schedule.every === undefined ? `for ${describeMoment(schedule.next, schedule.zone)}` : describeRepeat(schedule.every);
		await app.collab.activity(id, user, `scheduled “${snippet(schedule.text, 60)}” ${when}`);
		return schedule;
	}

	async cancelSchedule(id: ConversationId, user: User, scheduleId: string): Promise<void> {
		const app = this.#app;
		app.requireSee(user, id);
		await app.requireDriver(id, user);
		const schedule = await app.schedules.cancel(id, scheduleId);
		if (schedule === undefined) throw new HttpError(404, "No such scheduled message");
		await app.collab.activity(id, user, `cancelled the scheduled “${snippet(schedule.text, 60)}”`);
	}

	/** Pi keeps working until `command` passes, checked after each of its answers. */
	async setGoal(id: ConversationId, user: User, command: unknown): Promise<void> {
		const app = this.#app;
		app.requireSee(user, id);
		await app.requireDriver(id, user);
		if (app.sessionMeta(id) === undefined) throw new HttpError(400, "Only sessions can have a goal");
		const goal = await app.goals.set(id, user.id, optionalText(command, "command") ?? "");
		await app.collab.activity(id, user, `set a goal: keep going until \`${snippet(goal.command, 80)}\` passes`);
	}

	/** Drop the goal: Pi stops checking. Anyone who can steer may, as with stopping a run. */
	async clearGoal(id: ConversationId, user: User): Promise<void> {
		const app = this.#app;
		app.requireSee(user, id);
		app.requireSteer(user);
		const goal = await app.goals.get(id);
		if (!(await app.goals.clear(id)) || goal === undefined) return;
		if (goal.status === "working") await app.collab.activity(id, user, `dropped the goal \`${snippet(goal.command, 80)}\``);
	}

	/** A new session with this session's history through `entryId`, which then goes its own way. */
	async fork(id: ConversationId, user: User, request: { entryId?: unknown; worktree?: unknown }): Promise<{ id: ConversationId }> {
		this.#requireForkable(id, user);
		const entryId = entryIdOf(request.entryId);
		const entry = await this.#app.visibleEntry(id, entryId);
		if (entry === undefined) throw new HttpError(404, "No such message");
		// A fork goes on from one of Pi's replies. One that called tools would leave the fork waiting for their results.
		const reply = entry.model?.[0];
		if (entry.kind !== "pi.assistant" || (reply?.role === "assistant" && reply.stopReason === "toolUse")) {
			throw new HttpError(400, "Fork from one of Pi's finished replies.");
		}
		return { id: await this.#branch(id, user, { at: entryId, label: "fork", worktree: request.worktree === true }) };
	}

	/**
	 * Send one of this session's messages again in a fork that ends just before it: edited (`text`), or as it was, maybe
	 * to another model (`model`). The original stays as it is.
	 */
	async resend(id: ConversationId, user: User, request: { entryId?: unknown; text?: unknown; model?: unknown; worktree?: unknown }): Promise<{ id: ConversationId }> {
		const app = this.#app;
		this.#requireForkable(id, user);
		const entryId = entryIdOf(request.entryId);
		const edited = optionalText(request.text, "text")?.trim();
		const asked = request.model as { provider?: unknown; modelId?: unknown } | undefined;
		if (asked !== undefined && (typeof asked !== "object" || asked === null || typeof asked.provider !== "string" || typeof asked.modelId !== "string")) {
			throw new HttpError(400, "model must name a provider and a model id");
		}
		const entry = await app.visibleEntry(id, entryId);
		if (entry?.kind !== "pi.user") throw new HttpError(404, "No such message to Pi");
		app.spend.check(user, id);
		const source = await app.agentState(id);
		const ref = asked === undefined ? source?.model : { provider: asked.provider as string, modelId: asked.modelId as string };
		const model = ref === undefined ? undefined : app.models.getModel(ref.provider, ref.modelId);
		if (ref === undefined || model === undefined) throw new HttpError(400, ref === undefined ? "Pick a model first." : `Unknown model ${ref.provider}/${ref.modelId}`);

		const original = userContent(entry.model?.[0]);
		const [written = "", files] = original.text.split(ATTACHMENTS_HEADING);
		// An edit that changes nothing is the same as sending the message again.
		const edit = edited !== undefined && edited !== written.replace(FROM_PREFIX, "").trim() ? edited : undefined;
		if (edit === "" && files === undefined) throw new HttpError(400, "Nothing to send");
		// Sent again, edited or not, the message is from whoever sent it again, with the original's files attached: what
		// Pi does next is on them.
		const body = edit ?? written.replace(FROM_PREFIX, "").trim();
		const text = this.messageText(user, files === undefined ? body : `${body}${ATTACHMENTS_HEADING}${files}`.trim());
		const author = (await app.harness.snapshot(AuthorsDoc, id, context))?.entries[String(entryId)] ?? user.id;
		const images = model.input.includes("image") ? original.images : [];
		const resend: Resend = { text, by: user.id, ...(images.length === 0 ? {} : { images: { entry: entryId as unknown as EntryId } }) };

		const previous = (await (await app.conversation(id)).entries({ maxEntryId: (entryId - 1) as unknown as EntryId }, 1, undefined, context)).items[0];
		const agent: AgentChange =
			asked === undefined ? {} : { model: ref, thinkingLevel: clampThinkingLevel(model, (source?.thinkingLevel ?? "off") as ModelThinkingLevel) };
		const label = edit !== undefined ? "edit" : asked !== undefined ? model.name : "retry";
		const forked = await this.#branch(id, user, { at: previous?.id as unknown as number | undefined, label, agent, worktree: request.worktree === true, resend });
		const submission = await (await app.conversation(forked)).submit({ type: "input", content: resendContent(text, images), requestId: resendRequest(resend) }, context);
		const whose = author === user.id ? "a message" : `${app.config.userById(author)?.name ?? "someone"}’s message`;
		const line = edit !== undefined ? "edited a message and sent it again" : asked !== undefined ? `sent ${whose} again to ${model.name}` : `sent ${whose} again`;
		await app.collab.activity(forked, user, line, false);
		this.#reportUnanswered(forked, submission.wait(context));
		return { id: forked };
	}

	/** Forks are new sessions: who may start one may fork, from a session they can see. */
	#requireForkable(id: ConversationId, user: User): void {
		const app = this.#app;
		app.requireSee(user, id);
		app.requireSteer(user);
		if (user.sessions !== undefined) throw new HttpError(403, "You were invited to one session and cannot start new ones.");
		if (app.sessionMeta(id) === undefined) throw new HttpError(400, "Only sessions can be forked");
	}

	/**
	 * Start a session from this one's history through entry `at`, or from none of it, named after this one with
	 * `label`; in a git worktree of its own when asked.
	 */
	async #branch(id: ConversationId, user: User, branch: { at: number | undefined; label: string; agent?: AgentChange; worktree: boolean; resend?: Resend }): Promise<ConversationId> {
		const app = this.#app;
		const meta = app.sessionMeta(id)!;
		const source = await app.agentState(id);
		const sourceTitle = meta.title ?? "New session";
		const title = `${sourceTitle} · ${branch.label}`.slice(0, MAX_TITLE);
		return this.#inPlace(source?.cwd ?? meta.cwd, branch.worktree, title, (place) => this.#fork(id, user, { ...branch, title, sourceTitle, place }));
	}

	/**
	 * Make the fork in `place`. It starts its own chat, with the pins of messages it inherited; both sessions get an
	 * activity line about it. With `resend`, the fork comes with the task that sends that message.
	 */
	async #fork(
		id: ConversationId,
		user: User,
		fork: { at: number | undefined; title: string; sourceTitle: string; agent?: AgentChange; place: Place; resend?: Resend },
	): Promise<ConversationId> {
		const app = this.#app;
		const source = await app.agentState(id);
		const { at, title, place } = fork;
		const agent: AgentChange = { ...fork.agent, ...(place.worktree === undefined ? {} : { cwd: place.cwd }) };
		const now = Date.now();
		// A new session rather than a fork gets plan mode and the notes by hand.
		const plan = at === undefined ? await app.harness.snapshot(PlanDoc, id, context) : undefined;
		const notes = at === undefined ? await app.harness.snapshot(NotesDoc, id, context) : undefined;
		const init: ConversationCreateOptions["init"] = async (tx, forked) => {
			const sessions = await tx.doc(SessionsDoc);
			sessions.items[String(forked)] = {
				cwd: place.cwd,
				title,
				createdAt: now,
				updatedAt: now,
				createdBy: user.id,
				forkedFrom: { id: Number(id), ...(at === undefined ? {} : { entryId: at }) },
				...(place.worktree === undefined ? {} : { worktree: place.worktree }),
			};
			if (fork.resend !== undefined) await tx.createTask(ResendTask, fork.resend, { ownership: { kind: "conversation" }, background: true, conversationId: forked });
			if (at === undefined) {
				if (plan !== undefined) Object.assign(await tx.doc(PlanDoc, forked), structuredClone(plan));
				if (notes !== undefined) Object.assign(await tx.doc(NotesDoc, forked), structuredClone(notes));
				return;
			}
			// A fork copies its parent's documents. The chat is the parent's conversation, not this one's.
			const chat = await tx.doc(ChatDoc, forked);
			chat.messages.splice(0);
			const pins = await tx.doc(PinsDoc, forked);
			for (let index = pins.items.length - 1; index >= 0; index--) {
				const pin = pins.items[index]!;
				if (pin.entryId === undefined || pin.entryId > at) pins.items.splice(index, 1);
			}
			// Authors of the parent's later messages did not take part here.
			const authors = await tx.doc(AuthorsDoc, forked);
			for (const entryId of Object.keys(authors.entries)) if (Number(entryId) > at) delete authors.entries[entryId];
		};
		const ownership = { kind: "ownerless" } as const;
		const forked =
			at === undefined
				? // Before the first message there is nothing to fork: a new session that runs like this one.
					await app.harness.createConversation(
						{
							ownership,
							agent: {
								...(source?.model === undefined ? {} : { model: source.model }),
								...(source?.thinkingLevel === undefined ? {} : { thinkingLevel: source.thinkingLevel }),
								...(source?.instructions === undefined ? {} : { instructions: source.instructions }),
								cwd: place.cwd,
								...agent,
							},
							init,
						},
						context,
					)
				: await (await app.conversation(id)).fork(at as unknown as EntryId, { ownership, agent, init }, context);
		const where = place.worktree === undefined ? "" : ` into a worktree on ${place.worktree.branch}${place.skipped.length === 0 ? "" : ` (${place.skipped.length} big new files were not copied)`}`;
		await app.collab.activity(forked.id, user, `forked this from “${fork.sourceTitle}”${where}`, false);
		await app.collab.activity(id, user, `forked “${title}” from this session${where}`, false);
		return forked.id;
	}

	async compact(id: ConversationId, user: User, instructions: string | undefined): Promise<void> {
		const app = this.#app;
		app.requireSee(user, id);
		await app.requireDriver(id, user);
		// Compacting asks the model for a summary, which costs like any other request.
		app.spend.check(user, id);
		const conversation = await app.conversation(id);
		const taskId = await conversation.compact(instructions, context);
		app.notice("info", "Compacting…", id);
		await app.collab.activity(id, user, "started compacting the context", false);
		void app.harness.waitForTask(taskId, context).then(
			(receipt) => {
				const outcome = receipt.state.outcome;
				if (outcome.status === "completed") {
					const { entryId, submissionId } = outcome.result;
					app.notice(
						"info",
						entryId === undefined && submissionId === undefined ? "Nothing to compact: the context fits in the recent window." : "Compacted.",
						id,
					);
				} else if (outcome.status === "aborted") {
					app.notice("info", "Compaction aborted.", id);
				} else {
					app.notice("error", `Compaction ${outcome.status}`, id);
				}
			},
			(error: unknown) => app.notice("error", describe(error), id),
		);
	}
}
