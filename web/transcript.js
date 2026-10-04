// The conversation: messages, thinking, tool cards, artifacts, subagents, approvals, and the live run.
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { personColor } from "./chat.js";
import { actions, attempt, canSteer, collab, discuss, navigate, openSheet, store } from "./store.js";
import { entryImageUrl, fileUrl, html, Icon, Markdown, plainText, Spinner, Thumb } from "./ui.js";

const REPORT = /^\[subagent (\S+) (answered|failed)([^\]]*)\]\s?([\s\S]*)$/;
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

function UserEntry({ entry, view, users }) {
	const report = REPORT.exec(entry.text);
	if (report) {
		const [, name, verb, , text] = report;
		const child = view.subagents.find((agent) => agent.name === name);
		return html`<div class=${`report ${verb === "failed" ? "failed" : ""}`}>
			<div class="report-head">
				<span class="report-name">${name}</span> ${verb}
				${child && html`<button class="link" onClick=${() => navigate(child.conversationId)}>Open →</button>`}
			</div>
			${text && html`<${Collapsible} text=${text} />`}
		</div>`;
	}
	const author = authorName(entry.id, view, users) ?? entry.from ?? (view.conversation?.kind === "subagent" ? "Main agent" : undefined);
	const [body, attachments] = entry.text.split("\n\nAttached files (saved on the server):\n");
	const files = attachments ? parseAttachments(attachments) : [];
	const pictures = files.filter((file) => file.path && file.mime.startsWith("image/"));
	const others = files.filter((file) => !pictures.includes(file));
	return html`<div class="user-row" id=${`entry-${entry.id}`}>
		<div class="bubble">
			${author && html`<div class="author" style=${view.authors?.[entry.id] ? `color:${personColor(view.authors[entry.id])}` : ""}>${author}</div>`}
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
			<${Icon} name=${open ? "down" : "chevron"} size=${14} />
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

function Diff({ diff }) {
	return html`<pre class="diff">${diff.split("\n").map((line) => {
		const kind = line.startsWith("+") && !line.startsWith("+++") ? "add" : line.startsWith("-") && !line.startsWith("---") ? "del" : "";
		return html`<span class=${kind}>${line}\n</span>`;
	})}</pre>`;
}

function ToolCard({ call, result, slot, approval, entryId }) {
	const [open, setOpen] = useState(false);
	const [full, setFull] = useState(null);
	const view = store.state.view;
	const meta = describeCall(full?.call ?? call);
	const status = approval ? "approval" : result ? (result.isError ? "error" : "done") : (slot?.status ?? "pending");
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
		if (call.name === "artifact" && (args.content || args.edits)) {
			parts.push(html`<pre class="output">${args.content ?? JSON.stringify(args.edits, null, 2)}</pre>`);
		}
		if (!["read", "write", "edit", "bash", "subagent", "artifact"].includes(call.name)) {
			parts.push(html`<pre class="output">${JSON.stringify(args, null, 2)}</pre>`);
		}
		const output = resultText ?? slot?.output;
		if (output && !(call.name === "edit" && details?.diff && !result?.isError)) {
			parts.push(html`<pre class=${`output ${result?.isError ? "error" : ""}`}>${output}</pre>`);
		}
		if (clipped) parts.push(html`<button class="link" onClick=${loadFull}>Load everything</button>`);
		body = html`<div class="tool-body">${parts}</div>`;
	}

	const artifact = call.name === "artifact" && details?.id ? details : null;
	const artifactType = artifact ? view.artifacts.find((each) => each.id === artifact.id)?.type : undefined;
	const artifactSrc = artifact ? `/a/${view.conversation.id}/${encodeURIComponent(artifact.id)}/${artifact.version}` : null;
	const child = call.name === "subagent" ? (details?.conversationId ?? view.subagents.find((agent) => agent.name === args.name)?.conversationId) : undefined;
	const decision = view.decisions?.[call.id];
	return html`<div class=${`tool ${status}`}>
		<button class="tool-head" onClick=${() => setOpen(!open)}>
			<span class="tool-icon">${meta.icon}</span>
			${meta.label && html`<span class="tool-label">${meta.label}</span>`}
			<span class=${`tool-subject ${meta.mono ? "mono" : ""}`}>${meta.subject}</span>
			<span class="tool-status">
				${status === "running" || status === "pending" ? html`<${Spinner} />` : status === "approval" ? html`<${Icon} name="shield" size=${15} />` : status === "error" ? "!" : "✓"}
			</span>
			<${Icon} name=${open ? "down" : "chevron"} size=${14} class="tool-chevron" />
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
		${body}
	</div>`;
}

function ApprovalCard({ approval }) {
	const [busy, setBusy] = useState(false);
	const answer = (allow) => {
		setBusy(true);
		attempt(() => actions.approve(approval.id, allow)).finally(() => setBusy(false));
	};
	return html`<div class="approval">
		<div class="approval-head"><${Icon} name="shield" size=${16} /> Lancet Guard asks before this ${approval.tool} call</div>
		<div class="approval-reason">${approval.reason}</div>
		<pre class="cmd">${approval.subject}</pre>
		${canSteer()
			? html`<div class="approval-actions">
					<button class="button" disabled=${busy} onClick=${() => answer(false)}>Deny</button>
					<button class="button primary" disabled=${busy} onClick=${() => answer(true)}>Allow</button>
				</div>`
			: html`<div class="muted small">Waiting for someone who can steer to answer.</div>`}
	</div>`;
}

function AssistantBlocks({ blocks, entryId, results, slots, approvals, streaming }) {
	return blocks.map((block, index) => {
		if (block.type === "text") return html`<${Markdown} text=${block.text} class=${streaming && index === blocks.length - 1 ? "streaming" : ""} />`;
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
	const text = entry.blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
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

function History({ firstId }) {
	const history = store.state.history;
	if (history === null) {
		return html`<div class="divider"><button class="link" onClick=${() =>
			attempt(async () => store.set({ history: await actions.history(firstId) }))}>Show earlier messages</button></div>`;
	}
	return html`<div class="history">${history.map((entry) => html`<${EntryView} entry=${entry} results=${new Map()} slots=${new Map()} approvals=${[]} />`)}</div>`;
}

function EntryView({ entry, results, slots, approvals }) {
	const { view, users } = store.state;
	if (entry.kind === "user") return html`<${UserEntry} entry=${entry} view=${view} users=${users} />`;
	if (entry.kind === "assistant") return html`<${AssistantEntry} entry=${entry} results=${results} slots=${slots} approvals=${approvals} />`;
	if (entry.kind === "compaction" || entry.kind === "reset") return html`<${Divider} entry=${entry} />`;
	return null;
}

export function Transcript() {
	const { view, missing } = store.state;
	const scroller = useRef(null);
	const stick = useRef(true);
	const [showJump, setShowJump] = useState(false);

	useLayoutEffect(() => {
		const element = scroller.current;
		if (element && stick.current) element.scrollTop = element.scrollHeight;
	});

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
	if (!view.conversation) return html`<main class="scroller"><div class="empty"><${Spinner} /></div></main>`;

	const results = new Map();
	for (const id of view.order) {
		const entry = view.entries.get(id);
		if (entry?.kind === "toolResult") results.set(entry.callId, entry);
	}
	const slots = new Map((view.live.tools ?? []).map((slot) => [slot.callId, slot]));
	const approvals = view.approvals ?? [];
	const entries = view.order.map((id) => view.entries.get(id)).filter(Boolean);
	const first = entries[0];
	const partial = view.live.generation?.message?.blocks ?? [];
	const runningTools = (view.live.tools ?? []).some((slot) => slot.status !== "done");
	const thinking = view.live.busy && partial.length === 0 && !runningTools;
	const retry = view.live.generation?.retry;
	const compactions = view.live.compactions ?? [];
	const conversation = view.conversation;

	return html`<main class="scroller" ref=${scroller} onScroll=${onScroll}>
		<div class="transcript">
			${conversation.parent &&
			html`<button class="breadcrumb" onClick=${() => navigate(conversation.parent.id)}><${Icon} name="back" size=${14} /> ${conversation.parent.title}</button>`}
			${first && (first.kind === "compaction" || first.kind === "reset") && html`<${History} firstId=${first.id} />`}
			${entries.length === 0 && !view.live.busy && html`<div class="empty hint">
				<div class="pi">π</div>
				<p>${conversation.kind === "subagent" ? "This subagent has no messages yet." : "Ask anything. Pi works in this session's folder, and keeps working if the server restarts."}</p>
			</div>`}
			${entries.map((entry) => html`<${EntryView} key=${entry.id} entry=${entry} results=${results} slots=${slots} approvals=${approvals} />`)}
			${partial.length > 0 &&
			html`<div class="assistant live"><${AssistantBlocks} blocks=${partial} results=${results} slots=${slots} approvals=${approvals} streaming=${true} /></div>`}
			${approvals.map((approval) => html`<${ApprovalCard} key=${approval.id} approval=${approval} />`)}
			${retry && html`<div class="muted small">Retrying (attempt ${view.live.generation.attempt + 1}) after: ${retry.error}</div>`}
			${compactions.map((compaction) => html`<div class="muted small"><${Spinner} /> Compacting context (${compaction.reason})…</div>`)}
			${thinking && html`<div class="typing"><span></span><span></span><span></span></div>`}
		</div>
		${showJump && html`<button class="jump" onClick=${() => {
			stick.current = true;
			scroller.current.scrollTop = scroller.current.scrollHeight;
			setShowJump(false);
		}}><${Icon} name="down" /></button>`}
	</main>`;
}
