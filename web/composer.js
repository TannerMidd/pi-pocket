// The message box: send, steer or queue while busy, attach files, mention files with @, pick the model, stop.
import { useEffect, useRef, useState } from "preact/hooks";
import { Avatar, TypingLine } from "./chat.js";
import { loadTemplates, parseCommand, parseTemplate, planAvailable, suggestCommands } from "./commands.js";
import { loadFiles, mentionAt, mentionText, suggestFiles } from "./files.js";
import { actions, attempt, canSteer, collab, drafts, notify, openSheet, store, typing, uid } from "./store.js";
import { formatBytes, formatTokens, html, Icon, Marked, modelLabel, Spinner } from "./ui.js";

const coarse = matchMedia("(pointer: coarse)").matches;
/** The newest "Send to Pi" text already put into a message box (see `insertIntoComposer`). */
let insertedUpTo = 0;

/** Take turns: who drives, who asked, and the buttons to hand over, ask, or take the wheel. */
function DriverBar() {
	const { view, me, users, presence } = store.state;
	const turns = view.turns;
	const [handing, setHanding] = useState(false);
	if (!turns?.on) return null;
	const name = (id) => users.find((user) => user.id === id)?.name ?? "someone";
	const driving = turns.driver === me?.id;
	const driverHere = turns.driver !== undefined && presence.some((person) => person.id === turns.driver);
	const run = (action, to) => attempt(() => actions.turns(action, to)).then(() => setHanding(false));
	if (driving) {
		const others = presence.filter((person) => person.id !== me?.id && person.role !== "viewer");
		return html`<div class="driver-bar mine">
			<span class="driver-label">🚗 You're driving</span>
			${turns.asks.map((id) => html`<span class="driver-ask">${name(id)} asks to drive <button class="link small" onClick=${() => run("handover", id)}>Hand over</button></span>`)}
			<span class="grow"></span>
			${others.length > 0 && html`<button class="link small" onClick=${() => setHanding(!handing)}>Hand over…</button>`}
			<button class="link small" onClick=${() => run("release")}>Let go</button>
			${handing &&
			html`<div class="driver-pick">${others.map((person) => html`<button class="chip" onClick=${() => run("handover", person.id)}><${Avatar} person=${person} size=${16} /> ${person.name}</button>`)}</div>`}
		</div>`;
	}
	const asked = turns.asks.includes(me?.id);
	const canTake = !driverHere || me?.role === "owner";
	return html`<div class="driver-bar">
		<span class="driver-label">${turns.driver === undefined ? "🚗 No one is driving" : `🚗 ${name(turns.driver)} is driving${driverHere ? "" : " (away)"}`}</span>
		<span class="grow"></span>
		${turns.driver !== undefined && driverHere && html`<button class="button small" disabled=${asked} onClick=${() => run("ask")}>${asked ? "Asked ✓" : "Ask to drive"}</button>`}
		${canTake && html`<button class="button small primary" onClick=${() => run("claim")}>Take the wheel</button>`}
	</div>`;
}

/** Plan mode: Pi proposes and changes nothing until someone here approves its plan. */
function PlanBar({ blocked }) {
	const { view } = store.state;
	if (!view.plan?.on || !planAvailable()) return null;
	// A subagent follows its session's plan mode; it is approved there.
	const subagent = view.conversation?.kind === "subagent";
	return html`<div class="plan-bar">
		<span class="grow"><strong>Plan mode.</strong> ${subagent ? "This subagent follows its session: it reads, and changes nothing." : "Pi reads and proposes; nothing changes until you approve."}</span>
		${!blocked && !subagent &&
		html`<button class="link small" onClick=${() => attempt(() => actions.setPlan(false))}>Turn off</button>
			<button class="button small primary" disabled=${view.live.busy} onClick=${() => attempt(actions.approvePlan)}>Approve plan</button>`}
	</div>`;
}

/** Done when: the check Pi works toward, how many checks it took, and a way to drop it. */
function GoalBar() {
	const { goal } = store.state.view;
	if (!goal) return null;
	const command = html`<span class="mono">${goal.command}</span>`;
	const text =
		goal.status === "met"
			? html`<strong>Done:</strong> ${command} passes (check ${goal.tries} of ${goal.max}).`
			: goal.status === "gave-up"
				? html`<strong>Stopped:</strong> ${command} still fails after ${goal.max} checks.`
				: html`<strong>Until</strong> ${command} passes${goal.tries > 0 ? ` · check ${goal.tries} of ${goal.max} failed` : ""}.`;
	return html`<div class=${`goal-bar ${goal.status}`}>
		<span class="grow">${text}</span>
		${canSteer() && html`<button class="link small" onClick=${() => attempt(actions.clearGoal)}>${goal.status === "working" ? "Drop" : "Dismiss"}</button>`}
	</div>`;
}

export function Composer() {
	const { view, conversationId } = store.state;
	const [text, setText] = useState(() => drafts.get(conversationId));
	const [files, setFiles] = useState([]);
	const [steer, setSteer] = useState(true);
	const [sending, setSending] = useState(false);
	// Slash command suggestions: the highlighted one, and whether Escape hid the list.
	const [pick, setPick] = useState(0);
	const [hideCommands, setHideCommands] = useState(false);
	// File mentions: where the caret is, and the mention Escape hid (by where it starts).
	const [caret, setCaret] = useState(() => drafts.get(conversationId).length);
	const [hiddenMention, setHiddenMention] = useState(null);
	const box = useRef(null);
	const picker = useRef(null);
	const list = useRef(null);
	const busy = view.live.busy;
	const agent = view.agent;

	useEffect(() => {
		const draft = drafts.get(conversationId);
		setText(draft);
		setCaret(draft.length);
	}, [conversationId]);
	// Text sent here from the chat, the notes ("Send to Pi"), or another app (Share) goes after whatever is in the box,
	// once: the message box is made again for every session, and must not add the same text there. Shared files are
	// attached the same way.
	const insert = store.state.composerInsert;
	useEffect(() => {
		if (!insert || insert.n <= insertedUpTo) return;
		insertedUpTo = insert.n;
		if (insert.files?.length > 0) addFiles(insert.files);
		if (insert.text === "") return;
		const current = drafts.get(conversationId);
		update(current.trim() === "" ? insert.text : `${current.replace(/\s+$/, "")}\n\n${insert.text}`);
		requestAnimationFrame(() => {
			const element = box.current;
			if (!element) return;
			element.focus();
			element.setSelectionRange(element.value.length, element.value.length);
		});
	}, [insert?.n]);
	useEffect(() => {
		const element = box.current;
		if (!element) return;
		element.style.height = "auto";
		element.style.height = `${Math.min(element.scrollHeight, innerHeight * 0.4)}px`;
	}, [text]);

	const update = (value, at = value.length) => {
		setText(value);
		setCaret(at);
		drafts.set(conversationId, value);
		setPick(0);
		if (!value.startsWith("/") || value === "/") setHideCommands(false);
		if (value.startsWith("/")) loadTemplates();
		// A command is not a message to Pi: no "typing to Pi" for it.
		typing(value.trim() === "" || value.startsWith("/") ? null : "pi");
	};

	const suggestions = hideCommands ? [] : suggestCommands(text);
	const chosen = suggestions[Math.min(pick, suggestions.length - 1)];
	const parsed = parseCommand(text);
	const template = parsed ? null : parseTemplate(text);
	// The @path being typed at the caret, and the files that match it. Slash command names come first.
	const typed = suggestions.length === 0 ? mentionAt(text, caret) : null;
	const mention = typed && typed.start !== hiddenMention ? typed : null;
	const found = mention ? suggestFiles(mention.query) : null;
	const matches = found?.items ?? [];
	const chosenFile = matches[Math.min(pick, matches.length - 1)];
	// A new mention checks the folder's list again, in the background; a hidden one shows again once it is gone.
	useEffect(() => {
		if (mention) loadFiles();
	}, [mention?.start, conversationId]);
	useEffect(() => {
		if (!typed && hiddenMention !== null) setHiddenMention(null);
	}, [typed === null]);
	// Arrowing through a long list keeps the highlighted one in view.
	useEffect(() => list.current?.querySelector(".command.on")?.scrollIntoView({ block: "nearest" }), [pick]);

	const focusEnd = () =>
		requestAnimationFrame(() => {
			const element = box.current;
			if (!element) return;
			element.focus();
			element.setSelectionRange(element.value.length, element.value.length);
		});

	/** Run a slash command. The text goes away once it worked; attached files stay for the next message. */
	const runCommand = async ({ command, arg }) => {
		setSending(true);
		const ok = await attempt(async () => {
			await command.run(arg);
			return true;
		});
		setSending(false);
		if (ok) update("");
	};

	/**
	 * A picked file goes into the box in place of what was typed, with a space after it. A folder goes in with its "/",
	 * and its own files show next.
	 */
	const chooseFile = (item) => {
		const written = mentionText(item.path);
		const rest = text.slice(mention.end);
		const space = item.dir || /^\s/.test(rest) ? "" : " ";
		const at = mention.start + written.length + (item.dir ? 0 : 1);
		update(`${text.slice(0, mention.start)}${written}${space}${rest}`, at);
		requestAnimationFrame(() => {
			const element = box.current;
			if (!element) return;
			element.focus();
			element.setSelectionRange(at, at);
		});
	};

	/** A tapped suggestion: commands that take text, and prompt templates, fill the box; the others run at once. */
	const choose = (command) => {
		if (command.args || command.template) {
			update(`/${command.name} `);
			focusEnd();
		} else runCommand({ command, arg: "" });
	};

	const forget = (list) => {
		for (const file of list) if (file.preview) URL.revokeObjectURL(file.preview);
	};
	const uploading = files.some((file) => file.state === "uploading");
	const canSend = !sending && !uploading && (text.trim() !== "" || files.some((file) => file.state === "done"));

	const send = async () => {
		if (!canSend) return;
		if (parsed) return runCommand(parsed);
		setSending(true);
		const attachments = files.filter((file) => file.state === "done").map((file) => file.attachment);
		const ok = await attempt(() => actions.submit(text, attachments, busy && steer ? "steer" : "followUp"));
		setSending(false);
		if (ok) {
			update("");
			forget(files);
			setFiles([]);
			if (!coarse) box.current?.focus();
		}
	};

	const onKey = (event) => {
		if (matches.length > 0 && !event.isComposing) {
			const move = { ArrowDown: 1, ArrowUp: -1 }[event.key];
			if (move !== undefined) {
				event.preventDefault();
				setPick((Math.min(pick, matches.length - 1) + move + matches.length) % matches.length);
				return;
			}
			if (event.key === "Escape") {
				event.preventDefault();
				setHiddenMention(mention.start);
				return;
			}
			// Tab completes; Enter completes too, unless the file's path is typed out already, which sends.
			const typedOut = !chosenFile.dir && mention.query === chosenFile.path;
			if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey && !coarse && !typedOut)) {
				event.preventDefault();
				chooseFile(chosenFile);
				return;
			}
		}
		if (suggestions.length > 0 && !event.isComposing) {
			const move = { ArrowDown: 1, ArrowUp: -1 }[event.key];
			if (move !== undefined) {
				event.preventDefault();
				setPick((Math.min(pick, suggestions.length - 1) + move + suggestions.length) % suggestions.length);
				return;
			}
			if (event.key === "Escape") {
				event.preventDefault();
				setHideCommands(true);
				return;
			}
			// Tab completes; Enter completes too, unless the name is typed out already, which runs it.
			const typedOut = parsed && text.trim() === `/${chosen.name}`;
			if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey && !coarse && !typedOut)) {
				event.preventDefault();
				choose(chosen);
				return;
			}
		}
		if (event.key === "Enter" && !event.shiftKey && !coarse && !event.isComposing) {
			event.preventDefault();
			send();
		}
	};

	const addFiles = (list) => {
		for (const file of list) {
			const key = uid();
			const preview = file.type.startsWith("image/") ? URL.createObjectURL(file) : null;
			setFiles((current) => [...current, { key, name: file.name, size: file.size, state: "uploading", preview }]);
			actions.upload(file).then(
				(attachment) => setFiles((current) => current.map((each) => (each.key === key ? { ...each, state: "done", attachment } : each))),
				(error) => {
					notify("error", `Upload failed: ${error.message}`);
					if (preview) URL.revokeObjectURL(preview);
					setFiles((current) => current.filter((each) => each.key !== key));
				},
			);
		}
	};

	const onPaste = (event) => {
		const pasted = [...(event.clipboardData?.files ?? [])];
		if (pasted.length > 0) {
			event.preventDefault();
			addFiles(pasted);
		}
	};

	const placeholder = busy ? (steer ? "Steer the current run…" : "Queue a follow-up…") : coarse ? "Message Pi…" : "Message Pi… (/ for commands, @ for files)";
	const inbox = view.inbox ?? [];
	const { me, users } = store.state;
	const queuedBy = (item) => (item.by === undefined ? "" : item.by === me?.id ? " · you" : ` · ${users.find((user) => user.id === item.by)?.name ?? "someone"}`);

	if (collab() && !canSteer()) {
		return html`<footer class="composer-wrap">
			<${TypingLine} where="pi" />
			<div class="view-only">
				<span><strong>View only.</strong> You can read along, react, and chat with the people here.</span>
				<button class="button small" onClick=${() => openSheet({ type: "chat" })}><${Icon} name="chat" size=${15} /> Chat</button>
			</div>
			<${StatusLine} />
		</footer>`;
	}
	const turns = view.turns;
	const blocked = collab() && turns?.on && turns.driver !== me?.id;
	const level = agent?.thinkingLevel && agent.thinkingLevel !== "off" && agent.reasoning ? agent.thinkingLevel : null;

	return html`<footer class="composer-wrap">
		<${TypingLine} where="pi" />
		${inbox.length > 0 &&
		html`<div class="inbox">
			${inbox.map(
				(item) => html`<div class="queued">
					<span class="queued-mode">${item.mode === "steer" ? "Steer" : item.mode === "followUp" ? "Queued" : "Note"}<span class="muted">${queuedBy(item)}</span></span>
					<span class="queued-text">${item.text ?? ""}</span>
					${canSteer() && (!blocked || item.by === me?.id) &&
					html`<button class="icon-button small" aria-label="Withdraw" onClick=${() => attempt(() => actions.withdraw(item.id))}><${Icon} name="close" size=${14} /></button>`}
				</div>`,
			)}
		</div>`}
		${collab() && html`<${DriverBar} />`}
		<${PlanBar} blocked=${blocked} />
		<${GoalBar} />
		${blocked
			? html`${busy && html`<div class="composer-row stop-only"><span class="muted small grow">Pi is working…</span><button class="round stop" aria-label="Stop" onClick=${() => attempt(actions.abort)}><${Icon} name="stop" size=${16} /></button></div>`}`
			: html`${mention && (matches.length > 0 || found.loading) &&
			html`<div class="commands file-options" role="listbox" aria-label="Files" ref=${list}>${matches.map(
				(item) => html`<button
					key=${item.path}
					class=${`command file-option ${item === chosenFile ? "on" : ""}`}
					role="option"
					aria-selected=${item === chosenFile}
					onMouseDown=${(event) => event.preventDefault()}
					onClick=${() => chooseFile(item)}
				>
					<${Icon} name=${item.dir ? "folder" : "file"} size=${14} class="file-icon" />
					<span class="file-name"><${Marked} text=${item.name} hits=${item.nameHits} />${item.dir ? "/" : ""}</span>
					<span class="command-description"><${Marked} text=${item.parent} hits=${item.parentHits} /></span>
				</button>`,
			)}${matches.length === 0 && html`<div class="file-note">Finding files…</div>`}${found.truncated &&
			html`<div class="file-note">A large folder: only the files nearest its top are listed.</div>`}</div>`}
		${suggestions.length > 0 &&
			html`<div class="commands" role="listbox" ref=${list}>${suggestions.map(
				(command) => html`<button
					class=${`command ${command === chosen ? "on" : ""}`}
					role="option"
					aria-selected=${command === chosen}
					onMouseDown=${(event) => event.preventDefault()}
					onClick=${() => choose(command)}
				>
					<span class="command-name">/${command.name}</span>${command.args && html`<span class="command-args">${command.args}</span>`}
					<span class="command-description">${command.description}</span>
				</button>`,
			)}</div>`}
		${suggestions.length === 0 &&
		parsed &&
		html`<div class="command-hint"><span class="command-name">/${parsed.command.name}</span>${parsed.command.args && html` <span class="command-args">${parsed.command.args}</span>`} <span class="muted">· ${parsed.command.description} · not sent to Pi</span></div>`}
		${suggestions.length === 0 &&
		template &&
		html`<div class="command-hint"><span class="command-name">/${template.name}</span>${template.args && html` <span class="command-args">${template.args}</span>`} <span class="muted">· prompt template · Pi gets it filled in</span></div>`}
		<div class="composer" onDragOver=${(event) => event.preventDefault()} onDrop=${(event) => {
			event.preventDefault();
			addFiles([...(event.dataTransfer?.files ?? [])]);
		}}>
			${files.length > 0 &&
			html`<div class="files">${files.map(
				(file) => html`<span class=${`chip ${file.preview ? "with-thumb" : ""}`}>
					${file.preview && html`<img class="chip-thumb" src=${file.preview} alt="" />`}
					${file.state === "uploading" ? html`<${Spinner} />` : file.preview ? "" : "📎"} ${file.name} <span class="muted">${formatBytes(file.size)}</span>
					<button class="icon-button small" aria-label=${`Remove ${file.name}`} onClick=${() => {
						forget([file]);
						setFiles((current) => current.filter((each) => each.key !== file.key));
					}}><${Icon} name="close" size=${12} /></button>
				</span>`,
			)}</div>`}
			<textarea
				ref=${box}
				rows="1"
				value=${text}
				placeholder=${placeholder}
				onInput=${(event) => update(event.currentTarget.value, event.currentTarget.selectionStart)}
				onKeyDown=${onKey}
				onKeyUp=${(event) => setCaret(event.currentTarget.selectionStart)}
				onClick=${(event) => setCaret(event.currentTarget.selectionStart)}
				onFocus=${() => loadFiles({ ifMissing: true })}
				onPaste=${onPaste}
				enterkeyhint=${coarse ? "enter" : "send"}
			></textarea>
			<div class="composer-row">
				<button class="icon-button" aria-label="Attach files" onClick=${() => picker.current?.click()}><${Icon} name="clip" /></button>
				<input ref=${picker} type="file" multiple hidden onChange=${(event) => {
					addFiles([...event.currentTarget.files]);
					event.currentTarget.value = "";
				}} />
				<button class=${`chip model-chip ${agent?.available === false ? "warn" : ""}`} onClick=${() => openSheet({ type: "model" })}>
					<span class="glyph">✦</span> ${modelLabel(agent)}${level && html`<span class="muted"> ${level}</span>`}
				</button>
				${planAvailable() && view.conversation?.kind !== "subagent" &&
				html`<button class=${`chip toggle ${view.plan?.on ? "on" : ""}`} title="Plan mode: Pi reads and proposes, and changes nothing until you approve" onClick=${() => attempt(() => actions.setPlan(!view.plan?.on))}>Plan</button>`}
				${busy && html`<button class=${`chip toggle ${steer ? "on" : ""}`} onClick=${() => setSteer(!steer)} title="Steer joins the running work; off queues a follow-up">Steer</button>`}
				<span class="grow"></span>
				${busy && html`<button class="round stop" aria-label="Stop" onClick=${() => attempt(actions.abort)}><${Icon} name="stop" size=${16} /></button>`}
				${(!busy || text.trim() !== "" || files.length > 0) &&
				html`<button class="round send" aria-label="Send" disabled=${!canSend} onClick=${send}>${sending ? html`<${Spinner} />` : html`<${Icon} name="send" size=${18} />`}</button>`}
			</div>
		</div>`}
		<${StatusLine} />
	</footer>`;
}

export function StatusLine() {
	const { view, connection, guard } = store.state;
	const stats = view.stats ?? {};
	const window = view.agent?.contextWindow;
	const parts = [];
	if (connection !== "open") parts.push(html`<span class="warn">${connection === "connecting" ? "connecting…" : "reconnecting…"}</span>`);
	parts.push(html`<span title=${(view.viewers ?? []).join(", ")}>${view.clients} client${view.clients === 1 ? "" : "s"}</span>`);
	if (stats.cacheRate !== undefined) parts.push(html`<span>cache ${Math.round(stats.cacheRate * 100)}%</span>`);
	if (window) {
		const percent = stats.contextTokens ? Math.round((stats.contextTokens / window) * 100) : 0;
		parts.push(html`<span>${percent}%/${formatTokens(window)}</span>`);
	}
	// The session's spend, its subagents' included, and its limit when it has one.
	const spend = view.conversation?.spend;
	const spent = spend?.spent ?? stats.cost ?? 0;
	parts.push(html`<span class=${spend?.budget !== undefined && spent >= spend.budget ? "warn" : ""}>$${spent.toFixed(2)}${spend?.budget !== undefined ? `/$${spend.budget.toFixed(2)}` : ""}</span>`);
	// On but not loaded: the guard blocks bash, write, and edit until it loads or is turned off.
	if (guard?.enabled && guard.available === false) parts.push(html`<button class="guard off" title=${guard.detail} onClick=${() => openSheet({ type: "extensions" })}><${Icon} name="shield" size=${11} /> guard failed</button>`);
	else if (guard?.enabled) parts.push(html`<button class="guard" title=${guard.detail} onClick=${() => openSheet({ type: "extensions" })}><${Icon} name="shield" size=${11} /> guard</button>`);
	else if (guard?.available) parts.push(html`<button class="guard off" title=${guard.detail} onClick=${() => openSheet({ type: "extensions" })}><${Icon} name="shield" size=${11} /> guard off</button>`);
	return html`<div class="status-line">${parts.flatMap((part, index) => (index === 0 ? [part] : [html`<span class="dot">·</span>`, part]))}</div>`;
}
