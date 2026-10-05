// Sheets: model picker, working directory, artifacts, providers and login, invites, the session menu.
import { useEffect, useState } from "preact/hooks";
import { browserAvailable, displayUrl, setBrowserOpen } from "./browser.js";
import { Avatar, ChatSheet, jumpToEntry } from "./chat.js";
import { schedulesAvailable } from "./commands.js";
import { NotificationsSheet } from "./notify.js";
import { ShareSheet } from "./share.js";
import { actions, api, attempt, canSteer, closeSheet, collab, navigate, notify, openSheet, scoped, store } from "./store.js";
import { chooseTheme, isPinned, paletteOf, prefs, setPrefs, THEMES, themeIds, themeVars, togglePin, varsStyle } from "./theme.js";
import { Boundary, copyText, Diff, formatBytes, formatTokens, formatWhen, html, Icon, Keys, Loader, modelLabel, replyText, shortPath, Sheet, Spinner, timeAgo, usePresence, writtenText } from "./ui.js";

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
	const [worktree, setWorktree] = useState(false);
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
				const created = await actions.createSession(target, { worktree });
				navigate(created.id);
			}
		});
	return html`<${Sheet} title=${mode === "change" ? "Working directory" : "New session"} onClose=${closeSheet}>
		<div class="row">
			<input class="mono" value=${path} onInput=${(event) => setPath(event.currentTarget.value)} onKeyDown=${(event) => event.key === "Enter" && load(path)} />
			<button class="button" onClick=${() => (browse ? setBrowse(false) : (setBrowse(true), load(path)))}>${browse ? "Hide" : "Browse"}</button>
		</div>
		${mode === "new" &&
		html`<label class="check"><input type="checkbox" checked=${worktree} onChange=${(event) => setWorktree(event.currentTarget.checked)} /> In a git worktree of its own: a branch, apart from this folder</label>`}
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

/** Who may allow a risky call: anyone who can steer, or (for guests) someone other than whoever asked for it. */
function ApprovalRule({ owner }) {
	const others = store.state.server?.approvalRule === "others";
	const change = () => attempt(() => api("settings", { approvalRule: others ? "anyone" : "others" }));
	return html`<div class="setting">
		<div class="grow">
			<div class="small">Approvals need someone else</div>
			<div class="muted small">A guest cannot allow a call that their own message led to. You always can.</div>
		</div>
		<${Switch} on=${others} disabled=${!owner} label=${`Approvals need someone else: ${others ? "on" : "off"}`} onChange=${change} />
	</div>`;
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
		if (module.source === "drop-in" && !module.enabled && !confirm(`Turn on ${module.title}?\n\nA drop-in extension runs inside the server with your rights, in every session.`)) return;
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
					${module.file === "guard.ts" && module.enabled && html`<${ApprovalRule} owner=${owner} />`}
					${module.error && html`<div class="error-box small">${module.error}</div>`}
					<div class="muted small mono">${module.source === "drop-in" ? `drop-in${module.path ? ` · ${shortPath(module.path, store.state.server?.home)}` : ""}` : module.file}${tools.length > 0 ? ` · tools: ${tools.join(", ")}` : ""}${module.required ? " · required" : ""}</div>
				</div>
				<div class="extension-actions">
					<${Switch} on=${module.enabled} disabled=${!owner || module.required || busy !== null} label=${`${module.title}: ${module.enabled ? "on" : "off"}`} onChange=${() => toggle(module)} />
					${owner && module.enabled && html`<button class="link small" disabled=${busy !== null} onClick=${() => change(module, "/reload", {})}>Reload</button>`}
				</div>
			</div>`;
		})}
		${data?.dropIns && html`<p class="muted small">Add your own: put a <span class="mono">.ts</span> extension module in <span class="mono">${shortPath(data.dropIns, store.state.server?.home)}</span>. Drop-ins stay off until the owner turns them on, and run inside the server with the owner's rights.</p>`}
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
					<div class="invite-code">
						<div class="invite-code-head"><span>Invite code</span>
						<button class="link small" onClick=${() => copyText(invite.code).then(() => notify("info", "Code copied."), () => notify("error", "Could not copy."))}>Copy</button></div>
						<div class="invite-code-value" aria-label=${`Invite code ${invite.code.split("").join(" ")}`}><span>${invite.code.slice(0, 5)}</span><span>${invite.code.slice(5)}</span></div>
						<div class="muted small">Or enter it on the other device's sign-in screen.</div>
					</div>
					<div class="row"><input class="mono" readonly value=${invite.url} onFocus=${(event) => event.currentTarget.select()} />
					<button class="button" onClick=${() => copyText(invite.url).then(() => notify("info", "Link copied."), () => notify("error", "Could not copy."))}>Copy</button></div>
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

function TextSheet({ title, label, hint = "", initial = "", placeholder = "", submit, multiline = false, button = "Save" }) {
	const [value, setValue] = useState(initial);
	const save = () => attempt(async () => {
		await submit(value);
		closeSheet();
	});
	return html`<${Sheet} title=${title} onClose=${closeSheet}>
		${hint && html`<p class="muted small">${hint}</p>`}
		<div class="field">
			<div class="label">${label}</div>
			${multiline
				? html`<textarea rows="4" value=${value} placeholder=${placeholder} onInput=${(event) => setValue(event.currentTarget.value)}></textarea>`
				: html`<input autofocus value=${value} placeholder=${placeholder} onInput=${(event) => setValue(event.currentTarget.value)} onKeyDown=${(event) => event.key === "Enter" && save()} />`}
		</div>
		<button class="button primary wide" onClick=${save}>${button}</button>
	<//>`;
}

/** A row in a menu: a label, an optional hint on the right, and what a tap does. */
function item(label, run, hint) {
	return html`<button class="list-item" onClick=${run}><span>${label}</span>${hint && html`<span class="muted small">${hint}</span>`}</button>`;
}

/** The message to Pi a reply answers: the newest one before it. */
function promptBefore(entryId) {
	const { view } = store.state;
	for (let index = view.order.indexOf(entryId) - 1; index >= 0; index--) {
		const entry = view.entries.get(view.order[index]);
		if (entry?.kind === "user") return entry;
	}
	return undefined;
}

/** Open a session made from this one, and say so. */
let branching = false;
/** Make a new session from this one and open it. A second tap while the first is on its way does nothing. */
const openBranch = (run) => {
	if (branching) return;
	branching = true;
	attempt(async () => {
		const created = await run();
		navigate(created.id);
		notify("info", "Opened the new session. The original is unchanged.");
	}).finally(() => {
		branching = false;
	});
};

/** Send a message to Pi again in a fork: with this session's model, or another one. */
function SendAgain({ prompt, worktree }) {
	const { models, view } = store.state;
	const [choosing, setChoosing] = useState(false);
	const [query, setQuery] = useState("");
	const current = view.agent?.model;
	const needle = query.trim().toLowerCase();
	const others = models.filter(
		(model) => !(model.provider === current?.provider && model.id === current?.modelId) && (needle === "" || `${model.provider}/${model.id} ${model.name}`.toLowerCase().includes(needle)),
	);
	return html`<div class="group">
		<div class="group-title">Send again in a new session</div>
		${item(`With ${modelLabel(view.agent)}`, () => openBranch(() => actions.resend(prompt.id, { worktree })), "same model")}
		${choosing
			? html`<label class="search"><${Icon} name="search" size=${16} /><input autofocus placeholder="Search models" value=${query} onInput=${(event) => setQuery(event.currentTarget.value)} /></label>
					${others.map((model) =>
						item(model.name, () => openBranch(() => actions.resend(prompt.id, { model: { provider: model.provider, modelId: model.id }, worktree })), html`<span class="mono">${model.provider}</span>`),
					)}`
			: item("With another model…", () => setChoosing(true))}
	</div>`;
}

/** The letter git's short status uses for each kind of change. */
const CHANGE_LETTERS = { modified: "M", added: "A", deleted: "D", renamed: "R", new: "N" };

/** One changed file: tap it to see its diff. */
function ChangedFile({ file }) {
	const [diff, setDiff] = useState(null);
	const toggle = () =>
		diff !== null
			? setDiff(null)
			: attempt(async () => {
					const response = await fetch(`/api/c/${store.state.conversationId}/changes/diff?path=${encodeURIComponent(file.path)}`);
					const text = await response.text();
					if (!response.ok) throw new Error(JSON.parse(text).error ?? `HTTP ${response.status}`);
					setDiff(text);
				});
	return html`<div class="changed">
		<button class="changed-head" onClick=${toggle}>
			<span class=${`change-kind ${file.kind}`} title=${file.kind}>${CHANGE_LETTERS[file.kind]}</span>
			<span class="mono grow">${file.path}</span>
			${file.byPi && html`<span class="chip">Pi</span>`}
			${file.added !== undefined && html`<span class="mono small"><span class="ok">+${file.added}</span> <span class="err">−${file.removed}</span></span>`}
		</button>
		${diff !== null && html`<${Diff} diff=${diff || "No difference in text."} />`}
	</div>`;
}

/** What changed in the session's folder: uncommitted changes in its repository, and every file Pi wrote or edited. */
function ChangesSheet() {
	const { server } = store.state;
	const [changes, setChanges] = useState(null);
	const load = () => attempt(async () => setChanges(await api(`c/${store.state.conversationId}/changes`)));
	useEffect(() => {
		load();
	}, []);
	const refresh = html`<button class="icon-button" title="Refresh" aria-label="Refresh" onClick=${() => (setChanges(null), load())}>↻</button>`;
	return html`<${Sheet} title="Changes" onClose=${closeSheet} actions=${refresh}>
		${changes === null && html`<${Loader} label="Asking git" />`}
		${changes?.repo &&
		html`<p class="muted small">Uncommitted changes in <span class="mono">${shortPath(changes.repo.root, server?.home)}</span>${changes.repo.branch ? html` on <span class="mono">${changes.repo.branch}</span>` : ""}. Tap a file for its diff.</p>`}
		${changes && !changes.repo && html`<p class="muted small">This folder is not in a git repository, so only the files Pi wrote or edited are listed.</p>`}
		${changes?.repo && changes.files.length === 0 && html`<p class="muted">No uncommitted changes.</p>`}
		${changes?.files.map((file) => html`<${ChangedFile} key=${file.path} file=${file} />`)}
		${changes?.more > 0 && html`<p class="muted small">And ${changes.more} more changed ${changes.more === 1 ? "file" : "files"}, not listed here.</p>`}
		${changes?.piOnly.length > 0 &&
		html`<div class="group">
			<div class="group-title">${changes.repo ? "Pi also edited" : "Pi wrote or edited"}</div>
			${changes.piOnly.map((each) => item(html`<span class="mono">${shortPath(each.path, server?.home)}</span>`, () => jumpToEntry(each.entryId), "show"))}
		</div>`}
	<//>`;
}

const money = (amount) => `$${amount.toFixed(2)}`;

/** A spend limit, and (for the owner) a way to change it. */
function SpendLimit({ budget, editable, save }) {
	const [draft, setDraft] = useState(null);
	if (draft === null) {
		return html`<span class="muted small">${budget === undefined ? "no limit" : `limit ${money(budget)}`}</span>
			${editable && html`<button class="link small" onClick=${() => setDraft(budget === undefined ? "" : String(budget))}>Change</button>`}`;
	}
	const done = (value) =>
		attempt(async () => {
			await save(value);
			setDraft(null);
		});
	return html`<span class="limit-edit">
		$<input type="number" inputmode="decimal" min="0.01" step="0.01" autofocus value=${draft} onInput=${(event) => setDraft(event.currentTarget.value)} />
		<button class="button small primary" disabled=${!(Number(draft) > 0)} onClick=${() => done(Number(draft))}>Set</button>
		${budget !== undefined && html`<button class="button small ghost" onClick=${() => done(null)}>No limit</button>`}
	</span>`;
}

/** What Pi spent, by person and by session, with the owner's limits. */
function SpendSheet() {
	const owner = store.state.me?.role === "owner";
	const [data, setData] = useState(null);
	useEffect(() => {
		attempt(async () => setData(await api("spend")));
	}, []);
	const save = (target) => async (budget) => setData(await api("spend", { ...target, budget }));
	return html`<${Sheet} title="Spend" onClose=${closeSheet}>
		${data === null && html`<${Loader} label="Adding it up" />`}
		${data?.total !== undefined && html`<p>Pi spent <strong>${money(data.total)}</strong> on this server so far.</p>`}
		<p class="muted small">Spend goes to whoever asked for the work. Past a limit, Pi takes no new messages there, and a run that crosses it stops.</p>
		${data &&
		html`<div class="group">
				<div class="group-title">People</div>
				${data.people.map(
					(person) => html`<div class="spend-row" key=${person.id}>
						<span class="grow">${person.name}</span>
						<span class="mono">${money(person.spent)}</span>
						<${SpendLimit} budget=${person.budget} editable=${owner && person.id !== store.state.me?.id} save=${save({ person: person.id })} />
					</div>`,
				)}
			</div>
			<div class="group">
				<div class="group-title">Sessions</div>
				${data.sessions.map(
					(session) => html`<div class="spend-row" key=${session.id}>
						<span class="grow">${session.title}</span>
						<span class="mono">${money(session.spent)}</span>
						<${SpendLimit} budget=${session.budget} editable=${owner} save=${save({ session: session.id })} />
					</div>`,
				)}
			</div>`}
	<//>`;
}

/** How often the Running now sheet asks again while it is open. */
const RUNNING_EVERY_MS = 2000;

/** Everything at work in the sessions you can see: open one, stop a run, or cancel a scheduled message. */
function RunningSheet() {
	const [sessions, setSessions] = useState(null);
	useEffect(() => {
		let open = true;
		const load = () => api("running").then((list) => open && setSessions(list), (error) => open && notify("error", error.message));
		load();
		const timer = setInterval(load, RUNNING_EVERY_MS);
		return () => {
			open = false;
			clearInterval(timer);
		};
	}, []);
	const steer = canSteer();
	const go = (id) => {
		closeSheet();
		navigate(id);
	};
	return html`<${Sheet} title="Running now" onClose=${closeSheet}>
		${sessions === null && html`<${Loader} label="Looking" />`}
		${sessions?.length === 0 && html`<p class="muted">Nothing is running.</p>`}
		${sessions?.map(
			(session) => html`<div class="running" key=${session.id}>
				<div class="running-head">
					<button class="link grow" onClick=${() => go(session.id)}>${session.title}</button>
					${session.approvals > 0 && html`<span class="warn small">${session.approvals} waiting for approval</span>`}
					${steer && session.busy && html`<button class="button small" onClick=${() => attempt(() => api(`c/${session.id}/abort`, {}))}>Stop</button>`}
				</div>
				${session.tasks.map(
					(task) => html`<div class="running-task" key=${task.id}>
						${task.status === "running" ? html`<${Spinner} />` : html`<span class="muted">·</span>`}
						<span class="grow">${task.subagent && html`<span class="mono">${task.subagent}</span>: `}${task.label}</span>
						${steer && task.scheduleId && html`<button class="link small" onClick=${() => attempt(() => api(`c/${task.conversationId}/schedules/${encodeURIComponent(task.scheduleId)}/cancel`, {}))}>Cancel</button>`}
						${steer && task.subagent && task.kind === "pi.generation" && html`<button class="link small" onClick=${() => attempt(() => api(`c/${task.conversationId}/abort`, {}))}>Stop</button>`}
						<span class="muted small mono">${task.status}</span>
					</div>`,
				)}
			</div>`,
		)}
	<//>`;
}

/** Messages that go to Pi later or on repeat: set one up, see what is coming, cancel one. */
function SchedulesSheet() {
	const { view, users, me } = store.state;
	const [when, setWhen] = useState("");
	const steer = canSteer();
	const setBy = (id) => (id === undefined ? "Pi" : id === me?.id ? "you" : (users.find((user) => user.id === id)?.name ?? "someone"));
	const add = () =>
		attempt(async () => {
			await actions.schedule(when);
			setWhen("");
		});
	return html`<${Sheet} title="Scheduled messages" onClose=${closeSheet}>
		<p class="muted small">Pi gets these at their time, also when nobody is here, and the people in this session get a notification when it is done.</p>
		${steer &&
		html`<div class="row">
				<input placeholder="in 2h check the deploy" value=${when} onInput=${(event) => setWhen(event.currentTarget.value)} onKeyDown=${(event) => event.key === "Enter" && add()} />
				<button class="button primary" disabled=${when.trim() === ""} onClick=${add}>Add</button>
			</div>
			<p class="muted small">Start with when: in 30m, 7:00, tomorrow 9am, fri 17:30, every 2h, every weekday 8:00. Then what Pi gets.</p>`}
		${view.schedules.length === 0 && html`<p class="muted">Nothing is scheduled.</p>`}
		${view.schedules.map(
			(schedule) => html`<div class="schedule" key=${schedule.id}>
				<div class="grow">
					<div>${schedule.text}</div>
					<div class="muted small">${schedule.repeat ? `${schedule.repeat} · next ${formatWhen(schedule.next)}` : formatWhen(schedule.next)} · set by ${setBy(schedule.by)}</div>
				</div>
				${steer && html`<button class="button small ghost" onClick=${() => attempt(() => actions.cancelSchedule(schedule.id))}>Cancel</button>`}
			</div>`,
		)}
	<//>`;
}

/** A session's own git worktree: where it is, and removing it (its branch stays). */
function WorktreeSheet() {
	const { view, server } = store.state;
	const worktree = view.conversation?.worktree;
	const [dirty, setDirty] = useState(false);
	const remove = (force) =>
		attempt(async () => {
			try {
				await actions.removeWorktree(force);
				closeSheet();
				notify("info", `Removed the worktree. The branch ${worktree.branch} stays.`);
			} catch (error) {
				if (error.status !== 409) throw error;
				setDirty(true);
			}
		});
	if (!worktree) return html`<${Sheet} title="Worktree" onClose=${closeSheet}><p class="muted">This session works in its folder, not in a worktree.</p><//>`;
	return html`<${Sheet} title="Worktree" onClose=${closeSheet}>
		<p>This session works on the branch <span class="mono">${worktree.branch}</span>, in a checkout of its own: its changes stay apart from <span class="mono">${shortPath(worktree.source, server?.home)}</span>.</p>
		<p class="muted small">Ask Pi to commit, merge, or open a pull request when it is done. Removing the worktree deletes its folder; the branch and its commits stay, and Pi works in the original folder again.</p>
		${dirty
			? html`<div class="error-box small">The worktree has uncommitted changes. Removing it anyway loses them.</div>
					<button class="button wide" onClick=${() => remove(true)}>Remove anyway</button>`
			: html`<button class="button wide" onClick=${() => remove(false)}>Remove the worktree</button>`}
	<//>`;
}

/** What can be done with one message: fork from it, edit it, send it again, or copy it. */
function MessageSheet({ entryId }) {
	const { view } = store.state;
	const entry = view.entries.get(entryId) ?? store.state.history?.find((each) => each.id === entryId);
	const [draft, setDraft] = useState(null);
	const [worktree, setWorktree] = useState(false);
	if (entry?.kind !== "user" && entry?.kind !== "assistant") {
		return html`<${Sheet} title="Message" onClose=${closeSheet}><p class="muted">This message is not here anymore.</p><//>`;
	}
	// Forks are new sessions: who may start one may fork.
	const canBranch = canSteer() && !scoped() && view.conversation?.kind === "session";
	// A message to Pi (from anyone), or one of its replies.
	const toPi = entry.kind === "user";
	const text = toPi ? writtenText(entry) : replyText(entry);
	const prompt = toPi ? entry : promptBefore(entryId);
	const copy = () => copyText(text).then(() => notify("info", "Copied."), () => notify("error", "Could not copy."));
	if (draft !== null) {
		return html`<${Sheet} title="Edit and send again" onClose=${closeSheet}>
			<p class="muted small">Pi gets the edited message in a new session that forks just before the original. The original stays as it is.</p>
			<textarea rows="6" autofocus value=${draft} onInput=${(event) => setDraft(event.currentTarget.value)}></textarea>
			<div class="row">
				<button class="button" onClick=${() => setDraft(null)}>Back</button>
				<button class="button primary grow" onClick=${() => openBranch(() => actions.resend(entry.id, { text: draft, worktree }))}>Send in a new session</button>
			</div>
		<//>`;
	}
	return html`<${Sheet} title=${toPi ? "Message" : "Reply"} onClose=${closeSheet}>
		${canBranch && view.conversation.inRepository &&
		html`<label class="check"><input type="checkbox" checked=${worktree} onChange=${(event) => setWorktree(event.currentTarget.checked)} /> New sessions get a git worktree of their own</label>`}
		${canBranch && !toPi && item("Fork from here", () => openBranch(() => actions.fork(entry.id, { worktree })), "everything up to this reply")}
		${canBranch && toPi && item("Edit and send again…", () => setDraft(text))}
		${canBranch && prompt && html`<${SendAgain} prompt=${prompt} worktree=${worktree} />`}
		${item("Copy text", copy)}
	<//>`;
}

/** A theme as a card: a tiny Hyprland desktop drawn in its own colors. */
function ThemeCard({ id, index, desktop = false }) {
	const palette = paletteOf(id);
	const vars = varsStyle(themeVars(palette));
	// "Desktop" on a server without an Omarchy desktop shows Tokyo Night.
	const on = prefs().theme === id || (id === "tokyo-night" && prefs().theme === "desktop" && !store.state.desktopTheme);
	const dots = ["--o-red", "--o-yellow", "--o-green", "--o-cyan", "--o-blue", "--o-magenta"];
	const desk = html`<div class="tc-desk">
		<div class="tc-win"><i></i><i></i><i class="lit"></i></div>
		<div class="tc-win"><i></i><i></i><i class="lit"></i></div>
	</div>`;
	const name = html`<div class="tc-name">${desktop ? `Desktop · ${palette.name}` : THEMES[id].name}${palette.colors.mode === "light" && html`<small>light</small>`}</div>`;
	return html`<button class=${`theme-card ${on ? "on" : ""} ${desktop ? "theme-desktop" : ""}`} style=${`${vars};--i:${index}`} title=${desktop ? "Follow the Omarchy theme of the machine Pi Pocket runs on" : THEMES[id].name} onClick=${(event) => chooseTheme(id, event)}>
		${desk}
		${desktop
			? html`<div class="tc-text">${name}<div class="tc-note">Follows your desktop: change the Omarchy theme and Pi Pocket changes with it.</div><div class="tc-dots">${dots.map((dot) => html`<i style=${`background:var(${dot})`}></i>`)}</div></div>`
			: html`${name}<div class="tc-dots">${dots.map((dot) => html`<i style=${`background:var(${dot})`}></i>`)}</div>`}
	</button>`;
}

function SettingRow({ title, detail, children }) {
	return html`<div class="setting-row"><div class="setting-text"><span>${title}</span>${detail && html`<span>${detail}</span>`}</div>${children}</div>`;
}

function AppearanceSheet() {
	const p = prefs();
	const desktop = store.state.desktopTheme;
	return html`<${Sheet} title="Appearance" onClose=${closeSheet} wide=${true}>
		<div class="label">Theme</div>
		<div class="theme-grid">
			${desktop && html`<${ThemeCard} id="desktop" index=${0} desktop=${true} />`}
			${themeIds().map((id, index) => html`<${ThemeCard} key=${id} id=${id} index=${index + 1} />`)}
		</div>
		${!desktop && html`<p class="muted small">Running Pi Pocket on an Omarchy desktop adds “Desktop”: the app follows the theme the desktop uses.</p>`}
		<div class="label">Layout and motion</div>
		<div>
			<${SettingRow} title="Tiled windows" detail="Wide screens: the sidebar and the session as Hyprland windows, with gaps and the active border">
				<${Switch} on=${p.tiling} label="Tiled windows" onChange=${() => setPrefs({ tiling: !p.tiling })} />
			<//>
			${desktop?.wallpaper &&
			html`<${SettingRow} title="Desktop wallpaper" detail="Your wallpaper in the gaps between windows, while following the desktop">
				<${Switch} on=${p.wallpaper} disabled=${!p.tiling || p.theme !== "desktop"} label="Desktop wallpaper" onChange=${() => setPrefs({ wallpaper: !p.wallpaper })} />
			<//>`}
			<${SettingRow} title="Sidebar" detail="Folded, it shows numbered sessions like workspaces">
				<div class="segmented">${[
					["open", "Open"],
					["rail", "Folded"],
				].map(([value, label]) => html`<button class=${p.sidebar === value ? "on" : ""} onClick=${() => setPrefs({ sidebar: value })}>${label}</button>`)}</div>
			<//>
			<${SettingRow} title="Motion" detail="Auto follows your system's reduced-motion setting">
				<div class="segmented">${[
					["auto", "Auto"],
					["full", "Full"],
					["reduced", "Reduced"],
				].map(([value, label]) => html`<button class=${p.motion === value ? "on" : ""} onClick=${() => setPrefs({ motion: value })}>${label}</button>`)}</div>
			<//>
			<${SettingRow} title="Text size">
				<div class="segmented">${[12, 13, 14, 15, 16].map((size) => html`<button class=${p.text === size ? "on" : ""} onClick=${() => setPrefs({ text: size })}>${size}</button>`)}</div>
			<//>
		</div>
		<button class="button wide" onClick=${() => openSheet({ type: "shortcuts" })}><${Icon} name="keyboard" size=${16} /> Keyboard shortcuts</button>
	<//>`;
}

const SHORTCUTS = [
	["Mod K", "Launcher: sessions, actions, themes"],
	["Alt 1", "… Alt 9: jump to a session, like a workspace"],
	["Alt ↑", "Alt ↓: previous or next session"],
	["Alt N", "New session"],
	["Alt B", "Open or close the browser"],
	["Mod B", "Fold or unfold the sidebar"],
	["Alt", "Hold to see session numbers"],
	["/", "In the message box: commands"],
	["?", "This list"],
	["Esc", "Close what is open"],
];

function ShortcutsSheet() {
	return html`<${Sheet} title="Keyboard shortcuts" onClose=${closeSheet}>
		<dl class="shortcuts">${SHORTCUTS.map(([keys, text]) => html`<dt><${Keys} keys=${keys} /></dt><dd>${text}</dd>`)}</dl>
		<p class="muted small">In the launcher, start with <kbd>></kbd> for actions, <kbd>@</kbd> for sessions, or <kbd>#</kbd> for themes. Arrowing onto a theme shows it; Enter keeps it.</p>
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
	const instructions = view.agent?.instructions;
	return html`<${Sheet} title=${conversation?.title ?? "Menu"} onClose=${closeSheet}>
		${conversation && collab() && item("People here", () => openSheet({ type: "chat" }), "chat, pinned, notes")}
		${conversation && collab() && steer && (!turns?.on || canStopTurns) &&
		item(turns?.on ? "Turn off take turns" : "Take turns", () =>
			attempt(async () => {
				await actions.turns(turns?.on ? "off" : "on");
				closeSheet();
			}), turns?.on ? "anyone here can send to Pi again" : "one person drives Pi at a time")}
		${session && steer && item("Rename", () => openSheet({ type: "rename" }))}
		${session && item(isPinned(conversation.id) ? "Unpin from the top" : "Pin to the top", () => {
			togglePin(conversation.id);
			closeSheet();
		}, "this browser")}
		${conversation?.worktree && steer
			? item("Worktree", () => openSheet({ type: "worktree" }), conversation.worktree.branch)
			: conversation && steer && driving && !scoped() && item("Working directory", () => openSheet({ type: "cwd", mode: "change" }), shortPath(view.agent?.cwd, server?.home))}
		${conversation && browserAvailable() &&
		item(store.state.browserOpen ? "Close the browser" : "Browser", () => {
			setBrowserOpen(!store.state.browserOpen);
			closeSheet();
		}, (store.state.browser?.open && displayUrl(store.state.browser.url)) || "see and test pages with Pi")}
		${conversation && steer && item("Changes", () => openSheet({ type: "changes" }), "what Pi changed")}
		${session && steer && driving && item("Instructions for Pi", () => openSheet({ type: "instructions" }), instructions ? "on" : "none")}
		${conversation && steer && driving && item("Compact context", () => openSheet({ type: "compact" }), "summarize older messages")}
		${conversation && steer && driving && item("New context", () => openSheet({ type: "reset" }), "Pi starts fresh; history stays")}
		${schedulesAvailable() && item("Scheduled messages", () => openSheet({ type: "schedules" }), view.schedules.length === 0 ? "none" : `${view.schedules.length} coming`)}
		${conversation &&
		item("Copy link", () => copyText(location.href).then(() => notify("info", "Link copied. Other signed-in devices can open it."), () => notify("error", "Could not copy.")))}
		${conversation && html`<a class="list-item" href=${`/api/c/${conversation.id}/export`} download><span>Export as Markdown</span><span class="muted small">the whole history</span></a>`}
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
			${item("Appearance", () => openSheet({ type: "appearance" }), paletteOf().name)}
			${item("Your name", () => openSheet({ type: "name" }), me?.name)}
			${collab() ? item("People", () => openSheet({ type: "people" }), me?.role === "viewer" ? "you can view" : "") : item("Sign in another device", () => openSheet({ type: "invite" }))}
			${collab() && item("Notifications", () => openSheet({ type: "notifications" }), "Pi finished, approvals, chat")}
			${item("Running now", () => openSheet({ type: "running" }), "everything Pi is doing")}
			${item("Spend", () => openSheet({ type: "spend" }), me?.role === "owner" ? "by person and session, limits" : "yours")}
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

/**
 * The open sheet, if any. A sheet that closes stays a moment longer, marked as leaving, so it can animate out; one sheet
 * replacing another swaps at once.
 */
export function Sheets() {
	const [sheet, leaving] = usePresence(store.state.sheet, 200);
	const auth = store.state.auth ? html`<${AuthDialog} />` : null;
	if (!sheet) return auth;
	const key = `${sheet.type}:${sheet.entryId ?? sheet.id ?? ""}`;
	return html`<div class=${`sheet-host ${leaving ? "leaving" : ""}`} inert=${leaving}><${Boundary} key=${key} reset=${sheet}>${sheetBody(sheet)}<//></div>${auth}`;
}

function sheetBody(sheet) {
	const { view, me } = store.state;
	let body = null;
	switch (sheet.type) {
		case "appearance":
			body = html`<${AppearanceSheet} />`;
			break;
		case "shortcuts":
			body = html`<${ShortcutsSheet} />`;
			break;
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
		case "worktree":
			body = html`<${WorktreeSheet} />`;
			break;
		case "changes":
			body = view.conversation ? html`<${ChangesSheet} />` : null;
			break;
		case "spend":
			body = html`<${SpendSheet} />`;
			break;
		case "running":
			body = html`<${RunningSheet} />`;
			break;
		case "schedules":
			body = view.conversation ? html`<${SchedulesSheet} />` : null;
			break;
		case "share":
			body = html`<${ShareSheet} share=${sheet.share} />`;
			break;
		case "message":
			body = view.conversation ? html`<${MessageSheet} key=${sheet.entryId} entryId=${sheet.entryId} />` : null;
			break;
		case "reset":
			body = html`<${TextSheet}
				title="New context"
				hint="Pi starts fresh: it no longer sees the messages so far, though everyone here still does."
				label="Handoff note (optional)"
				placeholder="e.g. We fixed the login bug; next is the signup form."
				multiline=${true}
				button="Start a new context"
				submit=${(value) => actions.reset(value)}
			/>`;
			break;
		case "instructions":
			body = html`<${TextSheet}
				title="Instructions for Pi"
				hint="Pi gets these with every message in this session, after its own instructions. Everyone here can see them. Leave empty for none."
				label="Instructions"
				initial=${view.agent?.instructions ?? ""}
				placeholder="e.g. Use pnpm, not npm. Ask before adding dependencies."
				multiline=${true}
				submit=${(value) => actions.setInstructions(value)}
			/>`;
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
	return body;
}
