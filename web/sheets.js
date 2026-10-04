// Sheets: model picker, working directory, artifacts, providers and login, invites, the session menu.
import { useEffect, useState } from "preact/hooks";
import { Avatar, ChatSheet } from "./chat.js";
import { NotificationsSheet } from "./notify.js";
import { actions, api, attempt, canSteer, closeSheet, collab, navigate, notify, openSheet, scoped, store } from "./store.js";
import { copyText, formatBytes, formatTokens, html, Icon, Loader, shortPath, Sheet, timeAgo } from "./ui.js";

function ModelSheet() {
	const { models, view } = store.state;
	// `/model son` opens the picker already searching when several models match.
	const [query, setQuery] = useState(store.state.sheet?.query ?? "");
	const agent = view.agent;
	const needle = query.trim().toLowerCase();
	const shown = models.filter((model) => needle === "" || `${model.provider}/${model.id} ${model.name}`.toLowerCase().includes(needle));
	const providers = [...new Set(shown.map((model) => model.provider))];
	const current = agent?.model;
	const levels = agent?.levels ?? ["off"];
	return html`<${Sheet} title="Model" onClose=${closeSheet}>
		${agent?.reasoning &&
		html`<div class="field">
			<div class="label">Thinking</div>
			<div class="segmented">${levels.map(
				(level) => html`<button class=${agent.thinkingLevel === level ? "on" : ""} onClick=${() => attempt(() => actions.configure({ thinkingLevel: level }))}>${level}</button>`,
			)}</div>
		</div>`}
		<label class="search"><${Icon} name="search" size=${16} /><input placeholder="Search models" value=${query} onInput=${(event) => setQuery(event.currentTarget.value)} /></label>
		${models.length === 0 && html`<p class="muted">No models are available. Add a provider first.</p>`}
		${providers.map(
			(provider) => html`<div class="group">
				<div class="group-title">${provider}</div>
				${shown
					.filter((model) => model.provider === provider)
					.map(
						(model) => html`<button
							class=${`list-item ${current?.provider === model.provider && current?.modelId === model.id ? "active" : ""}`}
							onClick=${() =>
								attempt(async () => {
									await actions.configure({ model: { provider: model.provider, modelId: model.id } });
									closeSheet();
								})}
						>
							<span>${model.name}</span>
							<span class="muted small mono">${model.id} · ${formatTokens(model.contextWindow)}${model.images ? " · images" : ""}</span>
						</button>`,
					)}
			</div>`,
		)}
		<button class="button wide" onClick=${() => openSheet({ type: "providers" })}><${Icon} name="key" size=${16} /> Providers…</button>
	<//>`;
}

function CwdSheet({ mode }) {
	const { view, server } = store.state;
	const initial = mode === "change" ? (view.agent?.cwd ?? server?.defaultCwd) : (server?.defaultCwd ?? "~");
	const [path, setPath] = useState(initial ?? "~");
	const [listing, setListing] = useState(null);
	const [hidden, setHidden] = useState(false);
	const [browse, setBrowse] = useState(true);
	const load = (target, showHidden = hidden) =>
		attempt(async () => {
			const result = await api(`fs?path=${encodeURIComponent(target)}${showHidden ? "&hidden=1" : ""}`);
			setListing(result);
			setPath(result.path);
		});
	useEffect(() => {
		load(initial ?? "~");
	}, []);
	const use = (target) =>
		attempt(async () => {
			if (mode === "change") {
				await actions.configure({ cwd: target });
				closeSheet();
			} else {
				const created = await actions.createSession(target);
				navigate(created.id);
			}
		});
	return html`<${Sheet} title=${mode === "change" ? "Working directory" : "New session"} onClose=${closeSheet}>
		<div class="row">
			<input class="mono" value=${path} onInput=${(event) => setPath(event.currentTarget.value)} onKeyDown=${(event) => event.key === "Enter" && load(path)} />
			<button class="button" onClick=${() => (browse ? setBrowse(false) : (setBrowse(true), load(path)))}>${browse ? "Hide" : "Browse"}</button>
		</div>
		<button class="button primary wide" onClick=${() => use(path)}>Use ${shortPath(path, listing?.home ?? server?.home)}</button>
		${browse &&
		listing &&
		html`<div class="dir-list">
			<label class="check"><input type="checkbox" checked=${hidden} onChange=${(event) => {
				setHidden(event.currentTarget.checked);
				load(path, event.currentTarget.checked);
			}} /> Show hidden</label>
			${listing.parent && html`<button class="list-item" onClick=${() => load(listing.parent)}><span class="mono">..</span></button>`}
			${listing.dirs.map((dir) => html`<button class="list-item" onClick=${() => load(dir.path)}><span><${Icon} name="folder" size=${15} /> ${dir.name}</span><${Icon} name="chevron" size=${14} /></button>`)}
			${listing.dirs.length === 0 && html`<div class="muted pad">No folders here.</div>`}
		</div>`}
		${listing?.recent?.length > 0 &&
		html`<div class="group"><div class="group-title">Recent</div>${listing.recent.map(
			(dir) => html`<button class="list-item" onClick=${() => use(dir)}><span class="mono">${shortPath(dir, listing.home)}</span></button>`,
		)}</div>`}
	<//>`;
}

function ArtifactsSheet() {
	const { artifacts } = store.state.view;
	const items = [...artifacts].sort((a, b) => (b.versions.at(-1)?.createdAt ?? 0) - (a.versions.at(-1)?.createdAt ?? 0));
	return html`<${Sheet} title="Artifacts" onClose=${closeSheet}>
		${items.length === 0 && html`<p class="muted">No artifacts yet. Ask Pi to build something you can look at: a chart, a demo, a game.</p>`}
		${items.map((artifact) =>
			[...artifact.versions].reverse().map(
				(version) => html`<button class="list-item" onClick=${() => openSheet({ type: "viewer", id: artifact.id, version: version.version })}>
					<span>${artifact.title}<br /><span class="muted small mono">${artifact.id}</span></span>
					<span class="muted small mono">${artifact.type} v${version.version} · ${formatBytes(version.size)} · ${timeAgo(version.createdAt)}</span>
				</button>`,
			),
		)}
	<//>`;
}

function ArtifactViewer({ id, version }) {
	const { view } = store.state;
	const artifact = view.artifacts.find((each) => each.id === id);
	const [shown, setShown] = useState(version ?? artifact?.versions.at(-1)?.version);
	const [nonce, setNonce] = useState(0);
	const latest = artifact?.versions.at(-1)?.version;
	const src = `/a/${view.conversation.id}/${encodeURIComponent(id)}/${shown ?? "latest"}`;
	return html`<div class="viewer">
		<header class="viewer-head">
			<div class="viewer-title">
				<strong>${artifact?.title ?? id}</strong>
				<span class="muted small">${artifact?.type ?? ""} · version ${shown}${latest && shown !== latest ? html` · <button class="link" onClick=${() => setShown(latest)}>latest is v${latest}</button>` : ""}</span>
			</div>
			${artifact && artifact.versions.length > 1 &&
			html`<select aria-label="Version" value=${shown} onChange=${(event) => setShown(Number(event.currentTarget.value))}>${[...artifact.versions].reverse().map(
				(each) => html`<option value=${each.version}>v${each.version}</option>`,
			)}</select>`}
			<button class="icon-button" title="Reload" onClick=${() => setNonce(nonce + 1)}>↻</button>
			<a class="button small" href=${src} target="_blank" rel="noopener">Open tab</a>
			<button class="icon-button" onClick=${closeSheet} aria-label="Close"><${Icon} name="close" /></button>
		</header>
		<iframe key=${`${src}#${nonce}`} src=${src} sandbox="allow-scripts allow-forms allow-modals allow-popups allow-pointer-lock allow-downloads" allow="fullscreen; clipboard-write; accelerometer; gyroscope" title=${artifact?.title ?? id}></iframe>
	</div>`;
}

/** An image full screen. Tap anywhere to close; Open shows it in its own tab to zoom, save, or share. */
function ImageViewer({ src, alt }) {
	useEffect(() => {
		const onKey = (event) => event.key === "Escape" && closeSheet();
		addEventListener("keydown", onKey);
		return () => removeEventListener("keydown", onKey);
	}, []);
	return html`<div class="lightbox" role="dialog" aria-label=${alt || "Image"} onClick=${closeSheet}>
		<img src=${src} alt=${alt ?? ""} />
		<div class="lightbox-bar" onClick=${(event) => event.stopPropagation()}>
			<span class="lightbox-title">${alt ?? ""}</span>
			<a class="button small" href=${src} target="_blank" rel="noopener">Open</a>
			<button class="icon-button" onClick=${closeSheet} aria-label="Close"><${Icon} name="close" /></button>
		</div>
	</div>`;
}

function Switch({ on, disabled, label, onChange }) {
	return html`<button type="button" role="switch" aria-checked=${on ? "true" : "false"} aria-label=${label} class=${`switch ${on ? "on" : ""}`} disabled=${disabled} onClick=${onChange}><span></span></button>`;
}

/** What Lancet Guard does here, given the module's switch and Pi's own setting. */
function guardNote(module, guard) {
	if (!guard.available) return { warn: true, text: guard.detail };
	if (!guard.enabled) return { warn: true, text: "Off in Pi's own settings (~/.pi/lancet-guard.json), so it does not run here either." };
	if (!module.enabled) return { warn: true, text: "Off in Pi Pocket: bash, write, and edit calls run unchecked here. Pi itself still uses it." };
	return { warn: false, text: "Checks bash, write, and edit calls. Risky ones wait for someone in the session to allow them." };
}

function ExtensionsSheet() {
	const { me } = store.state;
	const owner = me?.role === "owner";
	const [data, setData] = useState(null);
	const [problem, setProblem] = useState(null);
	const [busy, setBusy] = useState(null);
	const load = () =>
		api("extensions").then(
			(result) => {
				setData(result);
				setProblem(null);
			},
			(error) => setProblem(error.status === 404 ? "Restart the server (menu → Restart server) to manage extensions from here." : error.message),
		);
	useEffect(() => {
		load();
	}, []);
	const change = (module, path, body) => {
		setBusy(module.file);
		attempt(async () => setData(await api(`extensions/${encodeURIComponent(module.file)}${path}`, body))).finally(() => {
			setBusy(null);
			load();
		});
	};
	const toggle = (module) => {
		if (module.file === "guard.ts" && module.enabled && !confirm("Turn off Lancet Guard in Pi Pocket?\n\nbash, write, and edit calls will run without checks in every session here. Pi's own setting stays as it is.")) return;
		change(module, "", { enabled: !module.enabled });
	};
	return html`<${Sheet} title="Extensions" onClose=${closeSheet}>
		<p class="muted small">Extensions give Pi its tools and checks in Pi Pocket. A change applies to every session right away and stays after restarts.${owner ? "" : " Only the owner can change them."}</p>
		${problem && html`<div class="error-box">${problem}</div>`}
		${!data && !problem && html`<${Loader} label="Loading extensions" />`}
		${data?.modules.map((module) => {
			const tools = module.extensions.flatMap((extension) => extension.tools);
			const note = module.file === "guard.ts" ? guardNote(module, data.guard) : null;
			return html`<div class=${`extension ${module.enabled ? "" : "off"}`}>
				<div class="extension-main">
					<div class="extension-title">${module.title}${module.error && html` <span class="warn small">· failed to load</span>`}</div>
					${module.summary && html`<div class="muted small">${module.summary}</div>`}
					${note && html`<div class=${`small ${note.warn ? "warn" : "ok"}`}>${note.text}</div>`}
					${module.error && html`<div class="error-box small">${module.error}</div>`}
					<div class="muted small mono">${module.file}${tools.length > 0 ? ` · tools: ${tools.join(", ")}` : ""}${module.required ? " · required" : ""}</div>
				</div>
				<div class="extension-actions">
					<${Switch} on=${module.enabled} disabled=${!owner || module.required || busy !== null} label=${`${module.title}: ${module.enabled ? "on" : "off"}`} onChange=${() => toggle(module)} />
					${owner && module.enabled && html`<button class="link small" disabled=${busy !== null} onClick=${() => change(module, "/reload", {})}>Reload</button>`}
				</div>
			</div>`;
		})}
	<//>`;
}

function ProvidersSheet() {
	const { me } = store.state;
	const [providers, setProviders] = useState(null);
	const [query, setQuery] = useState("");
	const load = () => attempt(async () => setProviders(await api("providers")));
	useEffect(() => {
		load();
	}, [store.state.models]);
	const owner = me?.role === "owner";
	const login = (provider, type) => attempt(() => api(`providers/${encodeURIComponent(provider.id)}/login`, { type }));
	const logout = (provider) =>
		confirm(`Log out of ${provider.name}? Pi uses the same sign-in, so it is signed out too.`) &&
		attempt(async () => {
			await api(`providers/${encodeURIComponent(provider.id)}/logout`, {});
			load();
		});
	const needle = query.trim().toLowerCase();
	const list = (providers ?? [])
		.filter((provider) => needle === "" || `${provider.id} ${provider.name}`.toLowerCase().includes(needle))
		.sort((a, b) => Number(b.configured) - Number(a.configured) || a.name.localeCompare(b.name));
	return html`<${Sheet} title="Providers" onClose=${closeSheet}>
		<p class="muted small">Pi Pocket shares Pi's sign-ins (<span class="mono">~/.pi/agent/auth.json</span>). ${owner ? "" : "Only the owner can change them."}</p>
		<label class="search"><${Icon} name="search" size=${16} /><input placeholder="Search providers" value=${query} onInput=${(event) => setQuery(event.currentTarget.value)} /></label>
		${providers === null && html`<${Loader} label="Loading providers" />`}
		${list.map(
			(provider) => html`<div class="provider">
				<div>
					<div>${provider.name} ${provider.configured && html`<span class="ok">✓</span>`}</div>
					<div class="muted small">${provider.configured ? `signed in${provider.label ? ` · ${provider.label}` : provider.source ? ` · ${provider.source}` : ""}` : "not configured"} · ${provider.models} models</div>
				</div>
				${owner &&
				html`<div class="provider-actions">
					${provider.oauth && html`<button class="button small" onClick=${() => login(provider, "oauth")}>${provider.oauth}</button>`}
					${provider.apiKey && html`<button class="button small" onClick=${() => login(provider, "api_key")}>API key</button>`}
					${provider.configured && provider.source === "stored" && html`<button class="button small ghost" onClick=${() => logout(provider)}>Log out</button>`}
				</div>`}
			</div>`,
		)}
	<//>`;
}

function AuthDialog() {
	const { auth } = store.state;
	const [value, setValue] = useState("");
	if (!auth) return null;
	const answer = (payload) =>
		attempt(async () => {
			await api(`auth/${auth.flowId}/${auth.prompt.id}`, payload);
			setValue("");
			store.set({ auth: { ...store.state.auth, prompt: null } });
		});
	const close = () => {
		// Stop the sign-in on the server too, also while it waits without a question (an OAuth callback holds a port).
		if (!auth.done) api(`auth/${encodeURIComponent(auth.flowId)}/cancel`, {}).catch(() => {});
		store.set({ auth: null });
	};
	const prompt = auth.prompt;
	return html`<${Sheet} title=${`Sign in: ${auth.providerId}`} onClose=${close}>
		${auth.events.map((event) => {
			if (event.type === "auth_url")
				return html`<div class="auth-event"><a class="button primary wide" href=${event.url} target="_blank" rel="noopener">Open the sign-in page</a>${event.instructions && html`<p class="muted small">${event.instructions}</p>`}</div>`;
			if (event.type === "device_code")
				return html`<div class="auth-event"><p>Enter this code at <a href=${event.verificationUri} target="_blank" rel="noopener">${event.verificationUri}</a></p><div class="code-big">${event.userCode}</div></div>`;
			return html`<p class="muted small">${event.message}${event.links?.map((link) => html` <a href=${link.url} target="_blank" rel="noopener">${link.label ?? link.url}</a>`)}</p>`;
		})}
		${prompt &&
		(prompt.type === "select"
			? html`<div class="field"><div class="label">${prompt.message}</div>${prompt.options.map(
					(option) => html`<button class="list-item" onClick=${() => answer({ value: option.id })}><span>${option.label}</span><span class="muted small">${option.description ?? ""}</span></button>`,
				)}</div>`
			: html`<div class="field">
					<div class="label">${prompt.message}</div>
					<div class="row">
						<input type=${prompt.type === "secret" ? "password" : "text"} autocomplete="off" placeholder=${prompt.placeholder ?? ""} value=${value} onInput=${(event) => setValue(event.currentTarget.value)} onKeyDown=${(event) => event.key === "Enter" && answer({ value })} />
						<button class="button primary" onClick=${() => answer({ value })}>Continue</button>
					</div>
				</div>`)}
		${!prompt && !auth.done && html`<${Loader} label="Waiting for the provider" />`}
		${auth.done && !auth.done.ok && html`<div class="error-box">${auth.done.error}</div>`}
	<//>`;
}

const ROLE_TEXT = {
	guest: "Can steer Pi, which can run commands on this machine",
	viewer: "Can read along, react, and chat, but not steer Pi",
};

function InviteSheet({ session = null }) {
	const { view } = store.state;
	const here = view.conversation?.kind === "session" ? view.conversation : null;
	const [role, setRole] = useState("guest");
	const [only, setOnly] = useState(session !== null);
	const [invite, setInvite] = useState(null);
	const create = () =>
		attempt(async () => {
			setInvite(null);
			setInvite(await api("invite", collab() ? { role, ...(only && here ? { session: here.id } : {}) } : {}));
		});
	useEffect(() => {
		create();
	}, [role, only]);
	const where = only && here ? `only “${here.title}”` : "every session";
	return html`<${Sheet} title="Invite someone" onClose=${closeSheet}>
		${collab() &&
		html`<div class="field">
			<div class="label">They can</div>
			<div class="segmented">
				<button class=${role === "guest" ? "on" : ""} onClick=${() => setRole("guest")}>Steer</button>
				<button class=${role === "viewer" ? "on" : ""} onClick=${() => setRole("viewer")}>View only</button>
			</div>
			<div class="muted small">${ROLE_TEXT[role]}.${role === "guest" && only ? " Seeing one session in the app does not limit what Pi can reach on the machine." : ""}</div>
		</div>
		${here &&
		html`<div class="field">
			<div class="label">In</div>
			<div class="segmented">
				<button class=${!only ? "on" : ""} onClick=${() => setOnly(false)}>Every session</button>
				<button class=${only ? "on" : ""} onClick=${() => setOnly(true)}>Only this session</button>
			</div>
		</div>`}`}
		<p class="muted small">Scan this on the other device, or send it the link. It works once and expires in 15 minutes. Whoever joins sees ${where}.</p>
		${invite?.access?.url && html`<p class="muted small">Other devices connect through ${invite.access.label}.</p>`}
		${invite
			? html`<div class="invite">
					${invite.local &&
					html`<div class="error-box">This link only works on this device. To let other devices in, press <span class="mono">a</span> in the Pi Pocket terminal (or start it with <span class="mono">--access</span>) and pick Local network, Cloudflare Tunnel, or Tailscale. Then make a new invite.</div>`}
					<div class="qr" dangerouslySetInnerHTML=${{ __html: invite.svg }}></div>
					<div class="row"><input class="mono" readonly value=${invite.url} onFocus=${(event) => event.currentTarget.select()} />
					<button class="button" onClick=${() => copyText(invite.url).then(() => notify("info", "Link copied."), () => notify("error", "Could not copy."))}>Copy</button></div>
					<p class="muted small">Code: <span class="mono">${invite.code}</span></p>
					${invite.alternatives?.length > 0 && html`<p class="muted small">Also reachable at: ${invite.alternatives.map((url) => html`<span class="mono">${url} </span>`)}</p>`}
				</div>`
			: html`<${Loader} label="Making an invite" />`}
		<button class="button wide" onClick=${create}>New invite</button>
		${!collab() && html`<${PeopleList} />`}
	<//>`;
}

function lastSeen(person) {
	if (person.online) return "here now";
	if (!person.lastSeen) return "not seen yet";
	return `seen ${timeAgo(person.lastSeen)}${timeAgo(person.lastSeen) === "now" ? "" : " ago"}`;
}

/** Everyone with access: who is online, when the others were last here, and (for the owner) what each may do. */
function PeopleList() {
	const { me, users, sessions } = store.state;
	const owner = me?.role === "owner";
	const sessionTitle = (id) => sessions.find((each) => each.id === id)?.title ?? `session ${id}`;
	const ordered = [...users].sort((a, b) => Number(Boolean(b.online)) - Number(Boolean(a.online)) || (b.lastSeen ?? 0) - (a.lastSeen ?? 0));
	const change = (person, patch) => attempt(async () => store.set({ users: await actions.setAccess(person.id, patch) }));
	return html`<div class="group">
		<div class="group-title">People</div>
		${ordered.map(
			(person) => html`<div class="person-row" key=${person.id}>
				<span class=${`online-dot ${person.online ? "on" : ""}`}></span>
				<${Avatar} person=${person} size=${26} />
				<div class="person-main">
					<div>${person.name}${person.id === me?.id ? html` <span class="muted small">(you)</span>` : ""}</div>
					<div class="muted small">${person.role === "owner" ? "owner" : person.role === "viewer" ? "view only" : "can steer"}${person.sessions ? ` · only ${person.sessions.map(sessionTitle).join(", ")}` : ""} · ${lastSeen(person)}</div>
				</div>
				${owner && person.role !== "owner" &&
				html`<div class="person-actions">
					${collab() && html`<button class="button small" title="Change what they can do" onClick=${() => change(person, { role: person.role === "viewer" ? "guest" : "viewer" })}>${person.role === "viewer" ? "Let steer" : "View only"}</button>`}
					${collab() && person.sessions && html`<button class="button small" title="Let them see every session" onClick=${() => change(person, { sessions: null })}>All sessions</button>`}
					<button class="button small ghost" onClick=${() =>
						confirm(`Remove ${person.name}? Their devices are signed out.`) &&
						attempt(async () => {
							await api(`users/${person.id}/remove`, {});
							store.set({ users: store.state.users.filter((each) => each.id !== person.id) });
						})}>Remove</button>
				</div>`}
			</div>`,
		)}
	</div>`;
}

function PeopleSheet() {
	const canInvite = canSteer() && !scoped();
	return html`<${Sheet} title="People" onClose=${closeSheet}>
		${canInvite && html`<button class="button primary wide" onClick=${() => openSheet({ type: "invite" })}><${Icon} name="plus" size=${16} /> Invite someone</button>`}
		<${PeopleList} />
		<button class="button wide" onClick=${() => openSheet({ type: "notifications" })}>Notifications on this device…</button>
	<//>`;
}

function TextSheet({ title, label, initial = "", placeholder = "", submit, multiline = false, button = "Save" }) {
	const [value, setValue] = useState(initial);
	const save = () => attempt(async () => {
		await submit(value);
		closeSheet();
	});
	return html`<${Sheet} title=${title} onClose=${closeSheet}>
		<div class="field">
			<div class="label">${label}</div>
			${multiline
				? html`<textarea rows="4" value=${value} placeholder=${placeholder} onInput=${(event) => setValue(event.currentTarget.value)}></textarea>`
				: html`<input autofocus value=${value} placeholder=${placeholder} onInput=${(event) => setValue(event.currentTarget.value)} onKeyDown=${(event) => event.key === "Enter" && save()} />`}
		</div>
		<button class="button primary wide" onClick=${save}>${button}</button>
	<//>`;
}

function MenuSheet() {
	const { view, me, server } = store.state;
	const conversation = view.conversation;
	const steer = canSteer();
	const session = conversation?.kind === "session";
	const turns = view.turns;
	// While take turns is on, settings belong to the driver. Turning it off also works for the owner, or when the
	// driver has left: the same rules the server applies.
	const driving = !turns?.on || turns.driver === me?.id;
	const canStopTurns = driving || me?.role === "owner" || !turns.driver || !store.state.presence.some((person) => person.id === turns.driver);
	const item = (label, run, hint) => html`<button class="list-item" onClick=${run}><span>${label}</span>${hint && html`<span class="muted small">${hint}</span>`}</button>`;
	return html`<${Sheet} title=${conversation?.title ?? "Menu"} onClose=${closeSheet}>
		${conversation && collab() && item("People here", () => openSheet({ type: "chat" }), "chat, pinned, notes")}
		${conversation && collab() && steer && (!turns?.on || canStopTurns) &&
		item(turns?.on ? "Turn off take turns" : "Take turns", () =>
			attempt(async () => {
				await actions.turns(turns?.on ? "off" : "on");
				closeSheet();
			}), turns?.on ? "anyone here can send to Pi again" : "one person drives Pi at a time")}
		${session && steer && item("Rename", () => openSheet({ type: "rename" }))}
		${conversation && steer && driving && !scoped() && item("Working directory", () => openSheet({ type: "cwd", mode: "change" }), shortPath(view.agent?.cwd, server?.home))}
		${conversation && steer && driving && item("Compact context", () => openSheet({ type: "compact" }), "summarize older messages")}
		${conversation &&
		item("Copy link", () => copyText(location.href).then(() => notify("info", "Link copied. Other signed-in devices can open it."), () => notify("error", "Could not copy.")))}
		${session && steer &&
		item(conversation.archived ? "Unarchive" : "Archive", () =>
			attempt(async () => {
				await actions.updateSession(conversation.id, { archived: !conversation.archived });
				closeSheet();
				if (!conversation.archived) navigate(null);
			}),
		)}
		${view.subagents.length > 0 &&
		html`<div class="group"><div class="group-title">Subagents</div>${view.subagents.map((agent) =>
			item(html`${agent.busy ? html`<span class="pulse"></span> ` : ""}${agent.name}`, () => navigate(agent.conversationId), agent.busy ? "working" : "idle"),
		)}</div>`}
		<div class="group"><div class="group-title">App</div>
			${item("Your name", () => openSheet({ type: "name" }), me?.name)}
			${collab() ? item("People", () => openSheet({ type: "people" }), me?.role === "viewer" ? "you can view" : "") : item("Sign in another device", () => openSheet({ type: "invite" }))}
			${collab() && item("Notifications", () => openSheet({ type: "notifications" }), "Pi finished, approvals, chat")}
			${item("Providers", () => openSheet({ type: "providers" }))}
			${item("Extensions", () => openSheet({ type: "extensions" }), store.state.guard?.enabled ? "Lancet Guard on" : store.state.guard?.available ? "Lancet Guard off" : "")}
			${me?.role === "owner" &&
			server?.supervised &&
			item("Restart server", () =>
				attempt(async () => {
					await api("restart", {});
					closeSheet();
					notify("info", "Restarting. Running work continues after the restart.");
				}), "running work resumes")}
			${item("Sign out", () => attempt(async () => {
				await api("logout", {});
				location.href = "/";
			}))}
		</div>
	<//>`;
}

export function Sheets() {
	const { sheet, view, me } = store.state;
	const auth = store.state.auth ? html`<${AuthDialog} />` : null;
	if (!sheet) return auth;
	let body = null;
	switch (sheet.type) {
		case "model":
			body = html`<${ModelSheet} />`;
			break;
		case "cwd":
			body = html`<${CwdSheet} mode=${sheet.mode} />`;
			break;
		case "artifacts":
			body = html`<${ArtifactsSheet} />`;
			break;
		case "viewer":
			body = view.conversation ? html`<${ArtifactViewer} id=${sheet.id} version=${sheet.version} />` : null;
			break;
		case "providers":
			body = html`<${ProvidersSheet} />`;
			break;
		case "extensions":
			body = html`<${ExtensionsSheet} />`;
			break;
		case "image":
			body = html`<${ImageViewer} src=${sheet.src} alt=${sheet.alt} />`;
			break;
		case "invite":
			body = html`<${InviteSheet} session=${sheet.session ?? null} />`;
			break;
		case "people":
			body = html`<${PeopleSheet} />`;
			break;
		case "notifications":
			body = html`<${NotificationsSheet} />`;
			break;
		case "menu":
			body = html`<${MenuSheet} />`;
			break;
		case "chat":
			body = view.conversation ? html`<${ChatSheet} />` : null;
			break;
		case "rename":
			body = html`<${TextSheet} title="Rename" label="Session title" initial=${view.conversation?.title ?? ""} submit=${(value) => actions.updateSession(view.conversation.id, { title: value })} />`;
			break;
		case "compact":
			body = html`<${TextSheet} title="Compact context" label="What should the summary keep? (optional)" placeholder="e.g. the failing test names" multiline=${true} button="Compact" submit=${(value) => actions.compact(value)} />`;
			break;
		case "name":
			body = html`<${TextSheet} title="Your name" label="Shown on your messages to others" initial=${me?.name ?? ""} submit=${async (value) => {
				await api("me", { name: value });
				const hello = await api("me");
				store.set({ me: hello.user, users: hello.users });
			}} />`;
			break;
	}
	return html`${body}${auth}`;
}
