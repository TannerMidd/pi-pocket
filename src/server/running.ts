/**
 * Everything at work right now, from Pi Durable's task graph: answers being written, tool calls, compactions,
 * subagents, and scheduled messages, with the calls waiting for approval, grouped by the session they belong to.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type ConversationId, LiveDoc, type TaskGraphNode } from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import type { User } from "./config.ts";
import { ScheduleDoc, SubagentsDoc } from "./docs.ts";
import { describeMoment } from "./when.ts";

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
};

export type RunningSession = { id: number; title: string; busy: boolean; approvals: number; tasks: RunningTask[] };

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
async function describeTask(app: PocketApp, node: TaskGraphNode): Promise<Pick<RunningTask, "label" | "scheduleId">> {
	const id = node.conversationId;
	switch (node.kind) {
		case "pi.generation":
			return { label: "writing an answer" };
		case "pi.tool": {
			const slot = (await app.harness.snapshot(LiveDoc, id, context))?.tools?.find((each) => each.taskId === node.id);
			return { label: slot === undefined ? "running a tool" : `running ${slot.name}` };
		}
		case "pi.compaction":
			return { label: "compacting the context" };
		case "pocket.subagent-reporter":
			return { label: "waiting for a subagent's answer" };
		case "pocket.schedule": {
			const schedule = Object.values((await app.harness.snapshot(ScheduleDoc, id, context))?.items ?? {}).find((each) => each.taskId === node.id);
			if (schedule === undefined) return { label: "a scheduled message" };
			return { label: `scheduled for ${describeMoment(schedule.next, schedule.zone)}: ${schedule.text}`, scheduleId: schedule.id };
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
			entry = { id: Number(root), title: await app.conversationTitle(root), busy: false, approvals: 0, tasks: [] };
			sessions.set(root, entry);
		}
		if (app.isBusy(conversationId)) entry.busy = true;
		return entry;
	};
	for (const node of await liveTasks(app)) {
		// A subagent's anchor stays for as long as the subagent does, doing nothing: its work shows on its own.
		if (node.kind === "pocket.subagent-anchor" || !app.canSee(user, node.conversationId)) continue;
		const parent = app.parentOf(node.conversationId);
		const subagent =
			parent === undefined
				? undefined
				: Object.entries((await app.harness.snapshot(SubagentsDoc, parent, context))?.agents ?? {}).find(([, record]) => record.conversationId === node.conversationId)?.[0];
		(await session(node.conversationId)).tasks.push({
			id: Number(node.id),
			kind: node.kind,
			status: node.state.status,
			conversationId: Number(node.conversationId),
			...(subagent === undefined ? {} : { subagent }),
			...(await describeTask(app, node)),
		});
	}
	for (const approval of app.approvals.all()) {
		if (app.canSee(user, approval.conversationId)) (await session(approval.conversationId)).approvals++;
	}
	return [...sessions.values()].sort((a, b) => Number(b.busy) - Number(a.busy) || b.tasks.length - a.tasks.length);
}
