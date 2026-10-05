// The conversation: messages, thinking, tool cards, artifacts, subagents, approvals, and the live run.
import { Component } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { browserAvailable, setBrowserOpen } from "./browser.js";
import { personColor } from "./chat.js";
import { actions, attempt, canSteer, collab, discuss, isRow, navigate, openSheet, store, TRANSCRIPT_ROWS } from "./store.js";
import { ATTACHMENTS_HEADING, Boot, Diff, entryImageUrl, fileUrl, html, Icon, Markdown, plainText, replyText, Spinner, Thinking, Thumb } from "./ui.js";

const REPORT = /^\[subagent (\S+) (answered|failed)([^\]]*)\]\s?([\s\S]*)$/;
/** How a scheduled message starts (see src/server/schedules.ts). */
const SCHEDULED = "[scheduled] ";
/** A goal's check that did not pass, as Pi is told about it (see src/server/extensions/goals.ts): what, then its output. */
const GOAL_CHECK = /^\[goal\] `([\s\S]*?)` (still fails|was cut off by a server restart) \(([^)]*)\)\. ([\s\S]*)$/;
/** One line of the attachment list the server adds to a message: `- path (name, mime, size bytes)`. */
const ATTACHED = /^- (.*) \(([^,]*), ([^,]*), (\d+) bytes\)$/;

function parseAttachments(block) {
	return block
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => {
			const match = ATTACHED.exec(line);
			return match ? { path: match[1], name: match[2], mime: match[3] } : { name: line.replace(/^- /, ""), mime: "" };
		});
}

function EntryImages({ entryId, count, label }) {
	return html`<div class="thumbs">${Array.from({ length: count }, (_, index) => html`<${Thumb} src=${entryImageUrl(entryId, index)} alt=${`${label} ${index + 1}`} />`)}</div>`;
}

function authorName(entryId, view, users) {
	const userId = view.authors?.[entryId];
	if (userId) {
		const user = users.find((each) => each.id === userId);
		return user ? user.name : "Someone";
	}
	return undefined;
}

/** Tapping a message opens what can be done with it, unless the tap was on a link, an image, or a button in it, or ended a text selection. */
function openMessage(event, entryId) {
	if (event.target.closest("a, button") || getSelection()?.toString()) return;
	openSheet({ type: "message", entryId });
}

/**
 * The conversation whose first rows have rendered: rows that mount after that are new (a message sent, a report
 * arriving) and slide into place. Rows already there when a session opens just appear.
 */
let settledFor = null;

function UserEntry({ entry, view, users }) {
	const [fresh] = useState(() => settledFor !== null && settledFor === view.conversation?.id);
	const report = REPORT.exec(entry.text);
	if (report) {
		const [, name, verb, , text] = report;
		const child = view.subagents.find((agent) => agent.name === name);
		return html`<div class=${`report ${verb === "failed" ? "failed" : ""} ${fresh ? "enter" : ""}`}>
			<div class="report-head">
				<span class="report-name">${name}</span> ${verb}
				${child && html`<button class="link" onClick=${() => navigate(child.conversationId)}>Open →</button>`}
			</div>
			${text && html`<${Collapsible} text=${text} />`}
		</div>`;
	}
	const check = GOAL_CHECK.exec(entry.text);
	if (check) {
		const [, command, what, how, output] = check;
		return html`<div class="report failed">
			<div class="report-head"><span class="report-name mono">${command}</span> ${what} · ${how}</div>
			<${Collapsible} text=${output} limit=${300} />
		</div>`;
	}
	const author = authorName(entry.id, view, users) ?? entry.from ?? (view.conversation?.kind === "subagent" ? "Main agent" : undefined);
	const [written, attachments] = entry.text.split(ATTACHMENTS_HEADING);
	// Set up earlier to go out now: by a person (who shows as its author) or by Pi.
	const scheduled = written.startsWith(SCHEDULED);
	const body = scheduled ? written.slice(SCHEDULED.length) : written;
	const files = attachments ? parseAttachments(attachments) : [];
	const pictures = files.filter((file) => file.path && file.mime.startsWith("image/"));
	const others = files.filter((file) => !pictures.includes(file));
	return html`<div class=${`user-row ${fresh ? "enter" : ""}`} id=${`entry-${entry.id}`}>
		<div class="bubble tappable" title="Edit, send again, or copy" onClick=${(event) => openMessage(event, entry.id)}>
			${(author || scheduled) &&
			html`<div class="author" style=${view.authors?.[entry.id] ? `color:${personColor(view.authors[entry.id])}` : ""}>${author ?? "Pi"}${scheduled && html`<span class="muted"> · scheduled</span>`}</div>`}
			${body && html`<div class="user-text">${body}</div>`}
			${pictures.length > 0 && html`<div class="thumbs">${pictures.map((file) => html`<${Thumb} src=${fileUrl(file.path)} alt=${file.name} />`)}</div>`}
			${others.length > 0 && html`<div class="attachments">${others.map((file) => html`<span class="chip">📎 ${file.name}</span>`)}</div>`}
			${entry.images > 0 && !attachments && html`<${EntryImages} entryId=${entry.id} count=${entry.images} label="Image" />`}
		</div>
	</div>`;
}

function Collapsible({ text, limit = 600 }) {
	const [open, setOpen] = useState(false);
	if (text.length <= limit) return html`<${Markdown} text=${text} />`;
	return html`<div class=${`collapsible ${open ? "open" : ""}`}>
		<${Markdown} text=${open ? text : `${text.slice(0, limit)}…`} />
		<button class="link" onClick=${() => setOpen(!open)}>${open ? "Show less" : "Show more"}</button>
	</div>`;
}

function Thought({ block, streaming }) {
	const [open, setOpen] = useState(false);
	return html`<div class=${`thought ${open ? "open" : ""}`}>
		<button class="thought-head" onClick=${() => setOpen(!open)}>
			<${Icon} name="sparkle" size=${14} /> ${streaming ? "Thinking…" : block.redacted ? "Thought (redacted)" : "Thought"}
			<${Icon} name="chevron" size=${14} class=${`chev ${open ? "open" : ""}`} />
		</button>
		${open && html`<div class="thought-body">${block.text}</div>`}
	</div>`;
}

const short = (text, max = 90) => {
	const flat = String(text ?? "").replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

function describeCall(call) {
	const args = call.args ?? {};
	switch (call.name) {
		case "read": {
			const range = args.offset ? `:${args.offset}${args.limit ? `+${args.limit}` : ""}` : "";
			return { icon: "▤", label: "Read", subject: `${args.path ?? ""}${range}`, mono: true };
		}
		case "write":
			return { icon: "✎", label: "Write", subject: args.path ?? "", mono: true };
		case "edit":
			return { icon: "✎", label: "Edit", subject: args.path ?? "", mono: true };
		case "bash":
			return { icon: ">_", label: "", subject: short(args.command, 140), mono: true };
		case "artifact":
			return { icon: "✦", label: "Artifact", subject: args.title ?? args.id ?? "", mono: false };
		case "codemode": {
			// The first line that does something: not the options line, a comment, or blank.
			const line = String(args.code ?? "")
				.split("\n")
				.map((each) => each.trim())
				.find((each) => each !== "" && !each.startsWith("//"));
			return { icon: "{}", label: "Codemode", subject: short(line ?? "", 140), mono: true };
		}
		case "browser": {
			const firstLine = String(args.script ?? "")
				.split("\n")
				.find((each) => each.trim() !== "");
			const what =
				args.url ??
				(args.ref ? `[${String(args.ref).replace(/^\[|\]$/g, "")}]` : undefined) ??
				args.selector ??
				(args.label ? `“${args.label}”` : undefined) ??
				args.key ??
				args.viewport ??
				firstLine ??
				(args.text !== undefined ? `“${args.text}”` : "");
			const typed = args.action === "type" && args.text !== undefined && what !== `“${args.text}”` ? ` ← “${args.text}”` : "";
			return { icon: "◎", label: `Browser ${args.action ?? ""}`, subject: short(`${what}${typed}`, 120), mono: true };
		}
		case "subagent":
			return {
				icon: "⧉",
				label: `Subagent ${args.action ?? ""}`,
				subject: [args.name, args.message && short(args.message, 60)].filter(Boolean).join(" · "),
				mono: true,
			};
		default:
			return { icon: "⚙", label: call.name, subject: short(JSON.stringify(args), 100), mono: true };
	}
}

function ToolCard({ call, result, slot, approval, entryId }) {
	const [open, setOpen] = useState(false);
	const [full, setFull] = useState(null);
	const view = store.state.view;
	const meta = describeCall(full?.call ?? call);
	const status = approval ? "approval" : result ? (result.isError ? "error" : "done") : (slot?.status ?? "pending");
	// A call that finishes while on screen flashes once.
	const [settled, setSettled] = useState(false);
	const was = useRef(status);
	useEffect(() => {
		const before = was.current;
		was.current = status;
		if (status !== "done" || (before !== "running" && before !== "pending")) return;
		setSettled(true);
		const timer = setTimeout(() => setSettled(false), 900);
		return () => clearTimeout(timer);
	}, [status]);
	const details = result?.details ?? slot?.details;
	const args = (full?.call ?? call).args ?? {};
	const resultText = full?.result?.text ?? result?.text;
	const loadFull = () =>
		attempt(async () => {
			const assistant = await actions.fullEntry(entryId);
			const fullCall = assistant.blocks?.find((block) => block.type === "toolCall" && block.id === call.id);
			const fullResult = result?.clipped ? await actions.fullEntry(result.id) : null;
			setFull({ call: fullCall ?? call, result: fullResult });
		});

	let body = null;
	if (open) {
		const clipped = (call.clipped && !full) || (result?.clipped && !full);
		const parts = [];
		if (call.name === "bash") parts.push(html`<pre class="cmd">$ ${args.command}</pre>`);
		if (call.name === "write" && args.content) parts.push(html`<pre class="output">${args.content}</pre>`);
		if (call.name === "edit") {
			if (details?.diff) parts.push(html`<${Diff} diff=${details.diff} />`);
			else if (Array.isArray(args.edits)) parts.push(html`<pre class="output">${args.edits.map((edit) => `- ${edit.oldText}\n+ ${edit.newText}`).join("\n\n")}</pre>`);
		}
		if (call.name === "subagent" && args.message) parts.push(html`<div class="tool-note">${args.message}</div>`);
		if (call.name === "codemode") {
			if (args.code) parts.push(html`<pre class="cmd">${args.code}</pre>`);
			// The script's own tool calls, live while it runs.
			const nested = Array.isArray(details?.calls) ? details.calls : [];
			if (nested.length > 0) {
				parts.push(html`<div class="nested-calls">${nested.map(
					(each) => html`<div class=${`nested-call ${each.status}`}>
						<span class="nested-status">${each.status === "ok" ? "✓" : each.status === "running" ? "…" : each.status === "cancelled" ? "–" : "!"}</span>
						<span class="mono">${each.name}</span>
						${each.durationMs !== undefined && html`<span class="muted">${each.durationMs} ms</span>`}
						${each.error && html`<span class="nested-error">${each.error}</span>`}
					</div>`,
				)}</div>`);
			}
		}
		if (call.name === "artifact" && (args.content || args.edits)) {
			parts.push(html`<pre class="output">${args.content ?? JSON.stringify(args.edits, null, 2)}</pre>`);
		}
		if (call.name === "browser") parts.push(args.script ? html`<pre class="cmd">${args.script}</pre>` : html`<pre class="output">${JSON.stringify(args, null, 2)}</pre>`);
		if (!["read", "write", "edit", "bash", "subagent", "artifact", "codemode", "browser"].includes(call.name)) {
			parts.push(html`<pre class="output">${JSON.stringify(args, null, 2)}</pre>`);
		}
		const output = resultText ?? slot?.output;
		if (output && !(call.name === "edit" && details?.diff && !result?.isError)) {
			parts.push(html`<pre class=${`output ${result?.isError ? "error" : ""}`}>${output}</pre>`);
		}
		// A call still streaming has no stored entry to load yet.
		if (clipped && entryId !== undefined) parts.push(html`<button class="link" onClick=${loadFull}>Load everything</button>`);
		body = html`<div class="tool-body">${parts}</div>`;
	}

	const artifact = call.name === "artifact" && details?.id ? details : null;
	const artifactType = artifact ? view.artifacts.find((each) => each.id === artifact.id)?.type : undefined;
	const artifactSrc = artifact ? `/a/${view.conversation.id}/${encodeURIComponent(artifact.id)}/${artifact.version}` : null;
	const child = call.name === "subagent" ? (details?.conversationId ?? view.subagents.find((agent) => agent.name === args.name)?.conversationId) : undefined;
	const decision = view.decisions?.[call.id];
	return html`<div class=${`tool ${status} ${settled ? "settled" : ""}`}>
		<button class="tool-head" onClick=${() => setOpen(!open)}>
			<span class="tool-icon">${meta.icon}</span>
			${meta.label && html`<span class="tool-label">${meta.label}</span>`}
			<span class=${`tool-subject ${meta.mono ? "mono" : ""}`}>${meta.subject}</span>
			<span class="tool-status">
				${status === "running" || status === "pending" ? html`<${Spinner} />` : status === "approval" ? html`<${Icon} name="shield" size=${15} />` : status === "error" ? "!" : "✓"}
			</span>
			<${Icon} name="chevron" size=${14} class=${`tool-chevron chev ${open ? "open" : ""}`} />
		</button>
		${decision &&
		html`<div class=${`decision ${decision.allow ? "allowed" : "denied"}`} title=${new Date(decision.at).toLocaleString()}><${Icon} name="shield" size=${12} /> ${decision.allow ? "Allowed" : "Denied"} by ${decision.by}</div>`}
		${result?.images > 0 && html`<${EntryImages} entryId=${result.id} count=${result.images} label=${`${call.name} image`} />`}
		${artifactType === "svg" &&
		html`<button class="artifact-preview" type="button" onClick=${() => openSheet({ type: "image", src: artifactSrc, alt: artifact.title })}>
			<img src=${artifactSrc} alt=${artifact.title} loading="lazy" decoding="async" />
		</button>`}
		${artifact &&
		html`<button class="artifact-link" onClick=${() => openSheet({ type: "viewer", id: artifact.id, version: artifact.version })}>
			Open ${artifact.title} · version ${artifact.version}
		</button>`}
		${child !== undefined && html`<button class="artifact-link" onClick=${() => navigate(child)}>Open ${args.name ?? "subagent"} →</button>`}
		${call.name === "browser" && browserAvailable() && !store.state.browserOpen &&
		html`<button class="artifact-link" onClick=${() => setBrowserOpen(true)}>Watch in the browser${details?.address ? ` · ${details.address}` : ""} →</button>`}
		${body}
	</div>`;
}

function ApprovalCard({ approval }) {
	const { me, server } = store.state;
	const [busy, setBusy] = useState(false);
	const answer = (allow) => {
		setBusy(true);
		attempt(() => actions.approve(approval.id, allow)).finally(() => setBusy(false));
	};
	// With approvals that need someone else, a guest cannot allow a call their own message led to (the server checks too).
	const ownCall = server?.approvalRule === "others" && me?.role !== "owner" && approval.requestedBy === me?.id;
	return html`<div class="approval">
		<div class="approval-head"><${Icon} name="shield" size=${16} /> Lancet Guard asks before this ${approval.tool} call</div>
		<div class="approval-reason">${approval.reason}</div>
		<pre class="cmd">${approval.subject}</pre>
		${!canSteer()
			? html`<div class="muted small">Waiting for someone who can steer to answer.</div>`
			: html`${ownCall && html`<div class="muted small">Someone else has to allow this: it came from your message. You can deny it.</div>`}
					<div class="approval-actions">
						<button class="button" disabled=${busy} onClick=${() => answer(false)}>Deny</button>
						${!ownCall && html`<button class="button primary" disabled=${busy} onClick=${() => answer(true)}>Allow</button>`}
					</div>`}
	</div>`;
}

function AssistantBlocks({ blocks, entryId, results, slots, approvals, streaming }) {
	return blocks.map((block, index) => {
		if (block.type === "text") {
			// The block still growing changes on every update: caching each version would only push out finished ones.
			const growing = streaming && index === blocks.length - 1;
			return html`<${Markdown} text=${block.text} class=${growing ? "streaming" : ""} cache=${!growing} />`;
		}
		if (block.type === "thinking") return html`<${Thought} block=${block} streaming=${streaming && index === blocks.length - 1} />`;
		if (block.type === "toolCall") {
			const slot = slots.get(block.id);
			const approval = slot?.taskId === undefined ? undefined : approvals.find((each) => each.taskId === slot.taskId);
			return html`<${ToolCard} call=${block} result=${results.get(block.id)} slot=${slot} approval=${approval} entryId=${entryId} />`;
		}
		return null;
	});
}

/** Under Pi's answers: reactions, and ways to talk about the answer with the people here. */
function AnswerActions({ entry }) {
	const { view, me, users, server } = store.state;
	const [picking, setPicking] = useState(false);
	const reactions = view.reactions?.[entry.id] ?? {};
	const pinned = (view.pins ?? []).some((pin) => pin.entryId === entry.id);
	const text = replyText(entry);
	const names = (ids) => ids.map((id) => (id === me?.id ? "you" : (users.find((user) => user.id === id)?.name ?? "someone"))).join(", ");
	const react = (emoji) => {
		setPicking(false);
		attempt(() => actions.react(entry.id, emoji));
	};
	return html`<div class="answer-actions">
		${Object.entries(reactions).map(
			([emoji, ids]) => html`<button class=${`reaction ${ids.includes(me?.id) ? "mine" : ""}`} title=${`${emoji} ${names(ids)}`} onClick=${() => react(emoji)}>${emoji} <span>${ids.length}</span></button>`,
		)}
		<span class="reaction-host">
			<button class="reaction add" aria-label="React" title="React" onClick=${() => setPicking(!picking)}>☺+</button>
			${picking && html`<span class="reaction-picker">${(server?.reactions ?? []).map((emoji) => html`<button onClick=${() => react(emoji)}>${emoji}</button>`)}</span>`}
		</span>
		<button class="link small" onClick=${() => discuss(entry.id, plainText(text).replace(/\s+/g, " ").slice(0, 280))}>Discuss</button>
		<button class="link small" onClick=${() => attempt(() => actions.pin({ entryId: entry.id }))}>${pinned ? "📌 Pinned" : "Pin"}</button>
		<button class="link small" title="Fork, retry, or copy" onClick=${() => openSheet({ type: "message", entryId: entry.id })}>More</button>
	</div>`;
}

function AssistantEntry({ entry, results, slots, approvals }) {
	// A final answer (not a step between tool calls) with something to say gets reactions and the discuss row.
	const answer = collab() && entry.stopReason !== "toolUse" && entry.blocks.some((block) => block.type === "text");
	return html`<div class="assistant" id=${`entry-${entry.id}`}>
		<${AssistantBlocks} blocks=${entry.blocks} entryId=${entry.id} results=${results} slots=${slots} approvals=${approvals} />
		${entry.stopReason === "error" && html`<div class="error-box">${entry.error ?? "The model request failed."}</div>`}
		${entry.stopReason === "aborted" && html`<div class="muted small">Stopped.</div>`}
		${answer && html`<${AnswerActions} entry=${entry} />`}
	</div>`;
}

function Divider({ entry }) {
	const [open, setOpen] = useState(false);
	if (entry.kind === "reset") {
		return html`<div class="divider"><span>New context</span>${entry.text && html`<div class="divider-body"><${Markdown} text=${entry.text} /></div>`}</div>`;
	}
	return html`<div class="divider">
		<button class="link" onClick=${() => setOpen(!open)}>Context compacted ${open ? "▾" : "▸"}</button>
		${open && html`<div class="divider-body"><${Markdown} text=${entry.summary} /></div>`}
	</div>`;
}

function History({ firstId, results, keepPlace }) {
	const history = store.state.history;
	if (history === null) {
		return html`<div class="divider"><button class="link" onClick=${() =>
			attempt(async () => {
				const earlier = await actions.history(firstId);
				keepPlace();
				store.set({ history: earlier });
			})}>Show earlier messages</button></div>`;
	}
	return html`<div class="history">${history.filter(isRow).map((entry) => html`<${Row} key=${entry.id} entry=${entry} results=${results} slots=${NO_SLOTS} approvals=${NO_APPROVALS} deps=${rowDeps(entry, results, NO_SLOTS, NO_APPROVALS)} />`)}</div>`;
}

function EntryView({ entry, results, slots, approvals }) {
	const { view, users } = store.state;
	if (entry.kind === "user") return html`<${UserEntry} entry=${entry} view=${view} users=${users} />`;
	if (entry.kind === "assistant") return html`<${AssistantEntry} entry=${entry} results=${results} slots=${slots} approvals=${approvals} />`;
	if (entry.kind === "compaction" || entry.kind === "reset") return html`<${Divider} entry=${entry} />`;
	return null;
}

const NO_SLOTS = new Map();
const NO_APPROVALS = [];
const agentsKey = (view) => (view.subagents ?? []).map((agent) => `${agent.name}:${agent.conversationId}`).join();

/**
 * Everything a row shows besides its entry, as values that compare with Object.is. Each update from the server builds
 * new objects for the whole view, so this picks out the parts one row uses: a row whose parts did not change skips
 * rendering, and a long thread stays cheap while Pi streams into its newest message.
 */
function rowDeps(entry, results, slots, approvals) {
	const { view, users, me, server } = store.state;
	const deps = [entry, users, me, server, view.conversation?.id, view.conversation?.kind];
	if (entry.kind === "user") {
		deps.push(view.authors?.[entry.id]);
		if (entry.text.startsWith("[subagent ")) deps.push(agentsKey(view));
	} else if (entry.kind === "assistant") {
		const reactions = view.reactions?.[entry.id];
		deps.push(reactions === undefined ? "" : JSON.stringify(reactions), (view.pins ?? []).some((pin) => pin.entryId === entry.id));
		for (const block of entry.blocks) {
			if (block.type !== "toolCall") continue;
			const slot = slots.get(block.id);
			const decision = view.decisions?.[block.id];
			deps.push(results.get(block.id), slot === undefined ? "" : JSON.stringify(slot), decision === undefined ? "" : JSON.stringify(decision));
			if (slot?.taskId !== undefined) deps.push(approvals.find((each) => each.taskId === slot.taskId)?.id);
			if (block.name === "artifact") deps.push((view.artifacts ?? []).map((each) => `${each.id}:${each.type}`).join());
			if (block.name === "subagent") deps.push(agentsKey(view));
			if (block.name === "browser") deps.push(store.state.browserOpen);
		}
	}
	return deps;
}

/** One transcript row, rendered again only when its `deps` change (see `rowDeps`). Its cards keep their open state. */
class Row extends Component {
	shouldComponentUpdate(next) {
		const before = this.props.deps;
		const after = next.deps;
		return before.length !== after.length || before.some((value, index) => !Object.is(value, after[index]));
	}

	render({ entry, results, slots, approvals }) {
		return html`<${EntryView} entry=${entry} results=${results} slots=${slots} approvals=${approvals} />`;
	}
}

/**
 * Which rows to render: from the row `store.state.transcriptFrom` names down. Older rows wait behind "Show earlier
 * messages", so opening a long session and streaming into it stay fast on a phone. Without that row (none chosen yet,
 * or gone after a compaction), the newest `TRANSCRIPT_ROWS`.
 */
function windowStart(rows, from) {
	const index = from === null ? -1 : rows.findIndex((row) => row.id === from);
	return index === -1 ? Math.max(0, rows.length - TRANSCRIPT_ROWS) : index;
}

export function Transcript() {
	const { view, missing, history, transcriptFrom } = store.state;
	const scroller = useRef(null);
	const stick = useRef(true);
	/** Distance from the bottom to restore after rows are added above, so the reader stays in place. */
	const keep = useRef(null);
	const counted = useRef(0);
	const [showJump, setShowJump] = useState(false);

	const entries = view.order.map((id) => view.entries.get(id)).filter(Boolean);
	const rows = entries.filter(isRow);
	const start = windowStart(rows, transcriptFrom);

	useLayoutEffect(() => {
		const element = scroller.current;
		if (!element) return;
		if (keep.current !== null) {
			element.scrollTop = element.scrollHeight - keep.current;
			keep.current = null;
		} else if (stick.current) element.scrollTop = element.scrollHeight;
		const grew = rows.length > counted.current;
		counted.current = rows.length;
		if (rows.length === 0) return;
		// Fix the first row shown, so rows arriving below never push the ones being read off the top. While the reader
		// follows along at the bottom, drop the oldest once there are twice as many as a fresh open shows.
		if (rows[start].id !== transcriptFrom) store.set({ transcriptFrom: rows[start].id });
		else if (grew && stick.current && rows.length - start > 2 * TRANSCRIPT_ROWS) store.set({ transcriptFrom: rows[rows.length - TRANSCRIPT_ROWS].id });
	});

	// Once the rows a session opens with are on screen, rows that mount later are new and animate in.
	const conversationId = view.conversation?.id;
	const hasRows = rows.length > 0;
	useEffect(() => {
		settledFor = null;
		if (conversationId === undefined) return;
		const timer = setTimeout(() => (settledFor = conversationId), hasRows ? 350 : 0);
		return () => clearTimeout(timer);
	}, [conversationId, hasRows]);

	// Images finish loading after the transcript renders and make it taller: stay at the bottom if we were there.
	useEffect(() => {
		const element = scroller.current;
		if (!element) return;
		const onLoad = (event) => {
			if (event.target?.tagName === "IMG" && stick.current) element.scrollTop = element.scrollHeight;
		};
		element.addEventListener("load", onLoad, true);
		return () => element.removeEventListener("load", onLoad, true);
	}, [view.conversation?.id]);

	const onScroll = () => {
		const element = scroller.current;
		const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 60;
		stick.current = atBottom;
		if (showJump === atBottom) setShowJump(!atBottom);
	};

	if (missing) return html`<main class="scroller"><div class="empty"><p>${missing}</p><button class="button" onClick=${() => navigate(null)}>All sessions</button></div></main>`;
	if (!view.conversation) {
		const { connection, sessions, conversationId } = store.state;
		const title = sessions.find((session) => session.id === conversationId)?.title;
		const caption = connection === "connecting" ? "connecting" : connection === "open" ? "loading session" : "reconnecting";
		return html`<main class="scroller"><${Boot} inline caption=${caption} detail=${title ?? ""} /></main>`;
	}

	const keepPlace = () => {
		// Earlier rows arriving above are not new: they appear without sliding in.
		const id = view.conversation?.id;
		settledFor = null;
		setTimeout(() => (settledFor = id), 400);
		const element = scroller.current;
		if (!element) return;
		keep.current = element.scrollHeight - element.scrollTop;
		stick.current = false;
	};
	const showEarlier = () => {
		keepPlace();
		store.set({ transcriptFrom: rows[Math.max(0, start - TRANSCRIPT_ROWS)].id });
	};

	const results = new Map();
	for (const entry of [...(history ?? []), ...entries]) if (entry.kind === "toolResult") results.set(entry.callId, entry);
	const slots = new Map((view.live.tools ?? []).map((slot) => [slot.callId, slot]));
	const approvals = view.approvals ?? [];
	const first = entries[0];
	const partial = view.live.generation?.message?.blocks ?? [];
	const runningTools = (view.live.tools ?? []).some((slot) => slot.status !== "done");
	const thinking = view.live.busy && partial.length === 0 && !runningTools;
	const retry = view.live.generation?.retry;
	const compactions = view.live.compactions ?? [];
	const conversation = view.conversation;
	// Only a session this person can see is in their list.
	const { sessions, sessionsLoaded } = store.state;
	const source = conversation.forkedFrom && sessions.find((each) => each.id === conversation.forkedFrom.id);

	return html`<main class="scroller" ref=${scroller} onScroll=${onScroll}>
		<div class="transcript">
			${conversation.parent &&
			html`<button class="breadcrumb" onClick=${() => navigate(conversation.parent.id)}><${Icon} name="back" size=${14} /> ${conversation.parent.title}</button>`}
			${conversation.forkedFrom &&
			sessionsLoaded &&
			(source
				? html`<button class="breadcrumb" onClick=${() => navigate(source.id)}><${Icon} name="fork" size=${14} /> Forked from ${source.title ?? "New session"}</button>`
				: html`<p class="muted small"><${Icon} name="fork" size=${14} /> Forked from another session</p>`)}
			${start > 0
				? html`<div class="divider"><button class="link" onClick=${showEarlier}>Show earlier messages</button></div>`
				: first && (first.kind === "compaction" || first.kind === "reset") && html`<${History} firstId=${first.id} results=${results} keepPlace=${keepPlace} />`}
			${entries.length === 0 && !view.live.busy && html`<div class="empty hint">
				<div class="pi">π</div>
				<p>${conversation.kind === "subagent" ? "This subagent has no messages yet." : "Ask anything. Pi works in this session's folder, and keeps working if the server restarts."}</p>
			</div>`}
			${rows.slice(start).map((entry) => html`<${Row} key=${entry.id} entry=${entry} results=${results} slots=${slots} approvals=${approvals} deps=${rowDeps(entry, results, slots, approvals)} />`)}
			${partial.length > 0 &&
			html`<div class="assistant live"><${AssistantBlocks} blocks=${partial} results=${results} slots=${slots} approvals=${approvals} streaming=${true} /></div>`}
			${approvals.map((approval) => html`<${ApprovalCard} key=${approval.id} approval=${approval} />`)}
			${retry && html`<div class="muted small">Retrying (attempt ${view.live.generation.attempt + 1}) after: ${retry.error}</div>`}
			${compactions.map((compaction) => html`<div class="muted small"><${Spinner} /> Compacting context (${compaction.reason})…</div>`)}
			${thinking && html`<${Thinking} />`}
		</div>
		${showJump && html`<button class="jump" onClick=${() => {
			stick.current = true;
			scroller.current.scrollTop = scroller.current.scrollHeight;
			setShowJump(false);
		}}><${Icon} name="down" /></button>`}
	</main>`;
}
