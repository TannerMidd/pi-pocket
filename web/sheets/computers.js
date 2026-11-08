// Runners (`src/server/runners.ts`): other computers of the owner's that run sessions' tools. Link one with a
// one-time code, see which are online, start a session on one, remove one, and choose whether others may use those
// sessions. The owner's alone.
import { useEffect, useState } from "preact/hooks";
import { api, attempt, closeSheet, notify, openSheet, store } from "../store.js";
import { copyText, html, Icon, Loader, Sheet, Switch, timeAgo } from "../ui.js";

/** What a computer is doing now, in a few words. */
function status(runner) {
    if (runner.online) {
        return "Online";
    }

    if (runner.away) {
        return "Offline, its work waits";
    }

    if (!runner.lastSeen) {
        return "Waiting to connect";
    }

    const ago = timeAgo(runner.lastSeen);

    return `Offline · seen ${ago === "now" ? "just now" : `${ago} ago`}`;
}

/** Its system, in words people use: macOS, not darwin. */
function system(runner) {
    const name = { macos: "macOS", darwin: "macOS", linux: "Linux", windows: "Windows" }[runner.os];

    return name ?? runner.os ?? "";
}

/** A line to copy: a command, the address, or the code, with its copy button. */
function Copyable({ text, label }) {
    return html`<div class="runner-copy">
        ${label && html`<span class="runner-copy-label">${label}</span>`}
        <code class="runner-copy-text">${text}</code>
        <button
            class="icon-button"
            aria-label=${`Copy ${label ?? "command"}`}
            title="Copy"
            onClick=${() => copyText(text).then(() => notify("info", "Copied."))}
        >
            <${Icon} name="copy" size=${16} />
        </button>
    </div>`;
}

/** The address and code for the runner on that computer, and how to get a runner there. */
function LinkSteps({ made, onDone }) {
    const server = location.origin;
    const minutes = Math.max(1, Math.round((made.expiresAt - Date.now()) / 60000));

    return html`<div class="runner-page runner-link">
        <h3 class="runner-page-title">Link ${made.name}</h3>
        <${TrustNote} />
        <p class="muted small">Give the runner on ${made.name} this address and code:</p>
        <${Copyable} label="Address" text=${server} />
        <${Copyable} label="Code" text=${made.code} />
        <div class="group-title">No runner there yet?</div>
        <ol class="runner-steps">
            <li>
                <div>Install Pi Pocket (Node.js 22.19 or newer):</div>
                <${Copyable} text=${`npm install -g ${made.package ?? "pi-pocket@latest"}`} />
            </li>
            <li>
                <div>Run the runner, choose Link this computer, and enter the address and code:</div>
                <${Copyable} text="pi-pocket runner" />
            </li>
        </ol>
        <p class="muted small">
            ${`The code works once and expires in ${minutes} minutes. ${made.name} shows as online here when it connects. Before a session starts there, it asks the person at ${made.name}.`}
        </p>
        <div class="row">
            <button class="button" onClick=${onDone}>Done</button>
        </div>
    </div>`;
}

/** What linking means for that computer, said where people link: before the code, and with it. */
export function TrustNote() {
    return html`<p class="runner-trust small">
        <strong>The linked computer trusts this server fully.</strong> Sessions you start there run commands and change
        files as that computer's user, with everything that user can reach. Nothing runs in a sandbox.
    </p>`;
}

/**
 * Linking paused, for one address or the whole server, and the addresses banned for guessing codes, which the owner can
 * lift (`link-limits.ts`). Only the owner opens Runners.
 */
function LinkLocks({ locks, reload }) {
    const intro = html`<h3 class="runner-page-title">Linking limits</h3>
        <p class="muted small">
            Redeeming a link code is the one thing anyone can try without signing in. Wrong codes are limited for each
            address, and in total; an address locked out 3 times in a week is banned.
        </p>`;

    if (!locks) {
        return html`<div class="runner-page">${intro}<${Loader} /></div>`;
    }

    if (!locks.server && locks.addresses.length === 0 && locks.bans.length === 0) {
        return html`<div class="runner-page">
            ${intro}
            <p class="muted small">Nothing is locked or banned.</p>
        </div>`;
    }

    const until = (time) =>
        new Date(time).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const since = (time) =>
        new Date(time).toLocaleString([], {
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
        });
    const lift = (address) =>
        attempt(async () => {
            await api(`runners/bans?address=${encodeURIComponent(address)}`, undefined, {
                method: "DELETE",
            });
            reload();
        });

    return html`<div class="runner-page runner-locks">
        ${intro}
        ${
            (locks.server || locks.addresses.length > 0) &&
            html`<div class="runner-trust small" role="status">
                ${
                    locks.server &&
                    html`<p>
                        <strong>New linking is paused until ${until(locks.server)}.</strong> Too many wrong link codes
                        reached this server from many addresses, so every open code was voided. Get a new one after
                        that. Linked computers keep working.
                    </p>`
                }
                ${locks.addresses.map(
                    (lock) => html`<p key=${lock.address}>
                        <strong>${lock.address}</strong> is locked out of linking until ${until(lock.until)}: it sent
                        too many wrong link codes. Lockout ${lock.blocks} of 3 this week; the third bans it.
                    </p>`,
                )}
            </div>`
        }
        ${
            locks.bans.length > 0 &&
            html`<div class="runner-bans">
                <div class="group-title">Banned from linking</div>
                <p class="muted small">
                    These addresses were locked out 3 times for guessing link codes. They get the same answer as a
                    wrong code. Lift a ban to let one link again.
                </p>
                ${locks.bans.map(
                    (ban) => html`<div class="runner-ban" key=${ban.address}>
                        <span class="mono">${ban.address}</span>
                        <span class="muted small">since ${since(ban.since)}</span>
                        <button class="button ghost" onClick=${() => lift(ban.address)}>Lift</button>
                    </div>`,
                )}
            </div>`
        }
    </div>`;
}

/** Link a computer: name it, get a one-time code, and run the runner there with this address and code. */
function LinkComputer({ onDone }) {
    const [name, setName] = useState("");
    const [made, setMade] = useState(null);
    const [busy, setBusy] = useState(false);
    const clean = name.trim();

    const make = () =>
        attempt(async () => {
            setBusy(true);

            try {
                setMade({ ...(await api("runners/code", { name: clean })), name: clean });
            } finally {
                setBusy(false);
            }
        });

    if (made) {
        return html`<${LinkSteps} made=${made} onDone=${onDone} />`;
    }

    return html`<div class="runner-page runner-link">
        <h3 class="runner-page-title">Link a computer</h3>
        <${TrustNote} />
        <label class="field">
            <span class="label">Name</span>
            <input
                type="text"
                value=${name}
                placeholder="For example: MacBook, Build server"
                maxlength="60"
                autofocus
                onInput=${(event) => setName(event.currentTarget.value)}
                onKeyDown=${(event) => event.key === "Enter" && clean && !busy && make()}
            />
        </label>
        <div class="row wrap">
            <button class="button primary" disabled=${busy || !clean} onClick=${make}>
                Get a link code
            </button>
        </div>
    </div>`;
}

/** Readiness is a hint, not a requirement: tools and sign-ins can be installed later. */
function Tools({ runner }) {
    const { tools, os } = runner;

    if (!tools) {
        return null;
    }

    const windows = os === "windows" || os === "win32";
    const git =
        os === "darwin"
            ? "xcode-select --install"
            : windows
              ? "winget install Git.Git"
              : "sudo apt install git";
    const gh = os === "darwin" ? "brew install gh" : windows ? "winget install GitHub.cli" : null;

    return html`<div class="muted small">
        ${tools.git ? "git ✓" : html`git not found: <code>${git}</code>`} · ${
            !tools.gh
                ? gh
                    ? html`GitHub: gh not found: <code>${gh}</code>`
                    : html`GitHub: gh not found: <a href="https://github.com/cli/cli#installation" target="_blank" rel="noopener noreferrer">Install gh</a>`
                : tools.github
                  ? "GitHub ✓"
                  : html`GitHub: sign in with <code>gh auth login</code>`
        }
    </div>`;
}

/** One setting change: one code. Cancel leaves the control where it was. */
function CodeModal({ runner, change, onDone }) {
    const [code, setCode] = useState("");
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);

    const submit = async (event) => {
        event.preventDefault();
        setBusy(true);
        setError("");

        try {
            await api(`runners/${encodeURIComponent(runner.id)}/permissions`, {
                request: { action: "settings", code, change },
            });
            onDone();
        } catch (failure) {
            setError(failure.message);
            setCode("");
        } finally {
            setBusy(false);
        }
    };

    return html`<div class="overlay runner-wait-overlay runner-code-modal">
        <section class="runner-wait" role="dialog" aria-modal="true" aria-labelledby="runner-code-title">
            <h2 id="runner-code-title">Enter the code from your authenticator for ${runner.name}</h2>
            <form onSubmit=${submit}>
                <input
                    type="text"
                    inputmode="numeric"
                    autocomplete="one-time-code"
                    pattern="[0-9]{6}"
                    maxlength="6"
                    autofocus
                    aria-label="6-digit code"
                    value=${code}
                    onInput=${(event) => setCode(event.currentTarget.value.replace(/\D/g, ""))}
                />
                ${error && html`<p class="runner-code-error" role="alert">${error}</p>`}
                <div class="row">
                    <button type="button" class="button ghost" onClick=${onDone}>Cancel</button>
                    <button class="button primary" disabled=${busy || code.length !== 6}>Confirm</button>
                </div>
            </form>
        </section>
    </div>`;
}

const APPROVED_BY = {
    computer: "approved at the computer",
    automatic: "approved without a question",
    totp: "approved with a code",
};

/** When an approved session's permission expires, as its row says it. */
function expiry(session) {
    if (session.inUse) {
        return "in use";
    }

    return session.expiresAt === null
        ? "does not expire"
        : `expires ${new Date(session.expiresAt).toLocaleString()}`;
}

/** Whether this person may change `runner`'s settings now: an authenticator there, their computer, and online. */
function canChange(runner) {
    const state = runner.approvals;

    return Boolean(state?.totp && runner.createdBy === store.state.me?.id && runner.online);
}

/** The runner is too old to report approvals, or offline: the panes that need its state say so. */
function NoApprovals({ runner }) {
    return runner.online
        ? html`<div class="runner-note warning">
              <div>
                  Update the runner on ${runner.name} to manage approvals here:
                  <code>npm install -g pi-pocket@latest</code>, then start <code>pi-pocket runner</code> again.
              </div>
          </div>`
        : html`<p class="muted small">Approvals show again when ${runner.name} reconnects.</p>`;
}

/** Whether an authenticator is set up there, and how to set one up: the settings change only with its codes. */
function Authenticator({ runner }) {
    const state = runner.approvals;

    if (!state) {
        return null;
    }

    return state.totp
        ? html`<p class="muted small">Authenticator set up. Settings change with a code from it.</p>`
        : html`<div class="runner-note warning">
              <div>
                  No authenticator on ${runner.name}. Its settings change only with a code from one. Set it up there:${" "}
                  <code>pi-pocket runner totp setup</code>
              </div>
          </div>`;
}

/** Saved folders and approved sessions, from this runner only. */
function Approvals({ runner }) {
    const state = runner.approvals;

    if (!state) {
        return html`<${NoApprovals} runner=${runner} />`;
    }

    const action = (request) =>
        attempt(() => api(`runners/${encodeURIComponent(runner.id)}/permissions`, { request }));

    return html`<div class="runner-pane">
        <div class="group-title">Saved folders</div>
        <p class="muted small">
            New sessions in these folders, and in their subfolders, start without the folder question.
        </p>
        ${state.folders.length === 0 && html`<p class="muted small">No saved folders.</p>`}
        <div class="runner-rows">
            ${state.folders.map(
                (folder) => html`<div class="runner-permission-row" key=${folder}>
                    <code>${folder}</code>
                    <button class="button small ghost" onClick=${() => action({ action: "remove-folder", folder })}>
                        Remove
                    </button>
                </div>`,
            )}
        </div>
        <div class="group-title">Approved sessions</div>
        ${state.sessions.length === 0 && html`<p class="muted small">No approved sessions.</p>`}
        <div class="runner-rows">
            ${state.sessions.map(
                (session) => html`<div class="runner-permission-row" key=${session.id}>
                    <div class="grow">
                        <code>${session.folder}</code>
                        <div class="muted small">
                            ${session.person} · ${APPROVED_BY[session.approvedBy] ?? session.approvedBy} · ${expiry(session)}
                        </div>
                    </div>
                    <button class="button small ghost" onClick=${() => action({ action: "revoke", session: session.id })}>
                        Revoke
                    </button>
                </div>`,
            )}
        </div>
        ${
            state.sessions.length > 0 &&
            html`<div>
                <button
                    class="button small ghost danger"
                    onClick=${() =>
                        confirm(`Revoke all sessions on ${runner.name}?`) &&
                        action({ action: "revoke", session: "all" })}
                >
                    Revoke all
                </button>
            </div>`
        }
    </div>`;
}

/** The runner's own settings: each change asks for a code from its authenticator (`CodeModal`). */
function Settings({ runner }) {
    const [change, setChange] = useState(null);
    const state = runner.approvals;

    if (!state) {
        return html`<${NoApprovals} runner=${runner} />`;
    }

    const active = canChange(runner);
    const ask = (next) => active && setChange(next);
    const settings = state.settings;
    const row = (
        label,
        detail,
        control,
    ) => html`<div class=${`setting wrap ${active ? "" : "disabled"}`}>
        <div class="grow">
            <div class="small">${label}</div>
            ${detail && html`<div class="muted small">${detail}</div>`}
        </div>
        ${control}
    </div>`;
    const toggle = (key, label, detail, on) =>
        row(
            label,
            detail,
            html`<${Switch}
                on=${on}
                disabled=${!active}
                label=${`${label}: ${on ? "on" : "off"}`}
                onChange=${() => ask({ [key]: !on })}
            />`,
        );

    return html`<div class="runner-pane">
        <${Authenticator} runner=${runner} />
        ${state.totp && !active && runner.createdBy !== store.state.me?.id && html`<p class="muted small">Only the person who linked ${runner.name} can change its settings.</p>`}
        <div class="runner-rows">
            ${toggle(
                "stopAsking",
                "Stop asking on new sessions",
                settings.stopAsking ? null : `${runner.name} asks before each new session.`,
                settings.stopAsking,
            )}
            ${row(
                "Session expiry with a code",
                null,
                html`<select
                    disabled=${!active}
                    aria-label="Session expiry with a code"
                    value=${settings.totpDays === null ? "never" : String(settings.totpDays)}
                    onChange=${(event) => {
                        const value = event.currentTarget.value;

                        event.currentTarget.value =
                            settings.totpDays === null ? "never" : String(settings.totpDays);
                        ask({ totpDays: value === "never" ? null : Number(value) });
                    }}
                >
                    <option value="1">1 day</option>
                    <option value="7">7 days</option>
                    <option value="14">14 days</option>
                    <option value="30">30 days</option>
                    <option value="never">No expiry</option>
                </select>`,
            )}
            ${toggle(
                "allowHttp",
                "Allow plain HTTP",
                "Off: plain http:// only to this computer itself or a tailnet device.",
                settings.allowHttp,
            )}
            ${toggle(
                "network",
                "Share the network with browsers",
                `The browser can reach ${runner.name}'s localhost and home network.`,
                settings.network,
            )}
            ${row(
                "Downloads",
                settings.downloads ??
                    "Temporary folder, which can be cleared when the computer restarts",
                html`<button
                    class="button small ghost"
                    disabled=${!active}
                    onClick=${() => {
                        const typed = prompt(
                            "Downloads folder, absolute; empty for the temporary folder",
                            settings.downloads ?? "",
                        );

                        if (typed !== null) {
                            ask({ downloads: typed.trim() === "" ? null : typed.trim() });
                        }
                    }}
                >
                    Change
                </button>`,
            )}
        </div>
        ${change && html`<${CodeModal} runner=${runner} change=${change} onDone=${() => setChange(null)} />`}
    </div>`;
}

/** The people this computer's linker grants access to, from the same list as the People sheet. */
function RunnerPeople({ runner }) {
    const people = store.state.users.filter(
        (person) => person.role !== "owner" && person.role !== "viewer" && !person.sessions,
    );
    const [choosing, setChoosing] = useState(false);
    const [selected, setSelected] = useState([]);
    const [busy, setBusy] = useState(false);
    const mine = runner.createdBy === store.state.me?.id;

    const choose = () => {
        setSelected((runner.users ?? []).map((person) => person.id));
        setChoosing(true);
    };

    const save = () =>
        attempt(async () => {
            setBusy(true);

            try {
                await api(`runners/${encodeURIComponent(runner.id)}/users`, { users: selected });
                setChoosing(false);
            } finally {
                setBusy(false);
            }
        });

    return html`<div class="runner-pane">
        <p class="muted small">
            They can start sessions on this computer. Their sessions run as this computer's user, like yours. Only
            people who can steer are listed.
        </p>
        <div class="row wrap">
            <span class="grow small">
                ${runner.users?.map((person) => person.name).join(", ") || html`<span class="muted">No people chosen</span>`}
            </span>
            ${
                mine &&
                !choosing &&
                html`<button class="button small ghost" onClick=${choose}>
                    Choose people
                </button>`
            }
        </div>
        ${
            choosing &&
            html`<div role="group" aria-label=${`People who may use ${runner.name}`}>
                ${people.length === 0 && html`<p class="muted small">No other people who can steer.</p>`}
                ${people.map(
                    (person) => html`<label class="check" key=${person.id}>
                        <input
                            type="checkbox"
                            checked=${selected.includes(person.id)}
                            disabled=${busy}
                            onChange=${(event) =>
                                setSelected(
                                    event.currentTarget.checked
                                        ? [...selected, person.id]
                                        : selected.filter((id) => id !== person.id),
                                )}
                        />
                        ${person.name}
                    </label>`,
                )}
                <div class="row">
                    <button class="button small primary" disabled=${busy} onClick=${save}>
                        Save
                    </button>
                    <button
                        class="button small ghost"
                        disabled=${busy}
                        onClick=${() => setChoosing(false)}
                    >
                        Cancel
                    </button>
                </div>
            </div>`
        }
    </div>`;
}

/** Its version, and its architecture, as a short line under its name. */
function details(runner) {
    return [
        status(runner),
        [system(runner), runner.arch].filter(Boolean).join(" "),
        runner.version && `runner ${runner.version}`,
    ]
        .filter(Boolean)
        .join(" · ");
}

/** Counts for the Overview: what is saved and approved there, and who else may use it. */
function Overview({ runner }) {
    const state = runner.approvals;
    const people = runner.users?.length ?? 0;
    const rows = [
        state && ["Saved folders", String(state.folders.length)],
        state && ["Approved sessions", String(state.sessions.length)],
        ["People who can start sessions", people === 0 ? "none" : String(people)],
        ["Asks before new sessions", runner.asks ? "yes" : "no"],
    ].filter(Boolean);

    return html`<div class="runner-pane">
        ${
            !runner.online &&
            html`<div class="runner-note">
                <div>
                    ${
                        runner.away
                            ? `${runner.name} is offline. Its sessions wait, and continue when it is back.`
                            : `${runner.name} is not connected. Start its runner: pi-pocket runner.`
                    }
                </div>
            </div>`
        }
        <div class="group-title">Tools on this computer</div>
        <${Tools} runner=${runner} />
        ${runner.online && runner.approvals && html`<div class="group-title">Authenticator</div>`}
        <${Authenticator} runner=${runner} />
        <div class="group-title">At a glance</div>
        <div class="runner-rows">
            ${rows.map(
                ([label, value]) => html`<div class="runner-glance" key=${label}>
                    <span class="grow">${label}</span>
                    <span class="muted">${value}</span>
                </div>`,
            )}
        </div>
    </div>`;
}

const TABS = [
    ["overview", "Overview"],
    ["people", "People"],
    ["approvals", "Approvals"],
    ["settings", "Settings"],
];

/** One linked computer: its state and actions, then its parts in tabs. */
function ComputerPage({ runner }) {
    const [tab, setTab] = useState("overview");
    const remove = () =>
        confirm(
            `Remove ${runner.name}? Its runner disconnects and its sessions stop working. You can link it again later.`,
        ) &&
        attempt(() =>
            api(`runners/${encodeURIComponent(runner.id)}`, undefined, { method: "DELETE" }),
        );
    const count = runner.approvals
        ? runner.approvals.folders.length + runner.approvals.sessions.length
        : 0;

    return html`<div class="runner-page">
        <div class="runner-page-head">
            <span
                class=${`runner-dot ${runner.online ? "on" : runner.away ? "away" : ""}`}
                aria-hidden="true"
            ></span>
            <h3 class="runner-page-title">${runner.name}</h3>
            <div class="runner-page-actions">
                <button
                    class="button small primary"
                    disabled=${!runner.online}
                    title=${runner.online ? "Pick a folder there" : `${runner.name} is not connected`}
                    onClick=${() => openSheet({ type: "cwd", mode: "new", runner: runner.id })}
                >
                    New session
                </button>
                <button class="button small ghost danger" onClick=${remove}>Remove</button>
            </div>
        </div>
        <div class="muted small">${details(runner)}</div>
        <div class="segmented runner-tabs" role="tablist" aria-label=${`${runner.name}: parts`}>
            ${TABS.map(
                ([id, label]) => html`<button
                    key=${id}
                    role="tab"
                    class=${tab === id ? "on" : ""}
                    aria-selected=${tab === id}
                    onClick=${() => setTab(id)}
                >
                    ${label}${id === "approvals" && count > 0 ? html` <span class="muted">${count}</span>` : ""}
                </button>`,
            )}
        </div>
        ${tab === "overview" && html`<${Overview} runner=${runner} />`}
        ${tab === "people" && html`<${RunnerPeople} runner=${runner} />`}
        ${tab === "approvals" && html`<${Approvals} runner=${runner} />`}
        ${tab === "settings" && html`<${Settings} runner=${runner} />`}
    </div>`;
}

/**
 * Who may use sessions on linked computers (`sharedRunnerSessions`): each its creator's alone (the default), or the
 * usual sharing rules. Starting one stays with the linker and granted people either way.
 */
function SharedSessions() {
    const shared = store.state.server?.sharedRunnerSessions === true;
    const change = () => attempt(() => api("settings", { sharedRunnerSessions: !shared }));

    return html`<div class="runner-page">
        <h3 class="runner-page-title">Sharing</h3>
        <div class="setting wrap">
            <div class="grow">
                <div class="small">Let others use these sessions</div>
                <div class="muted small">
                    Off: only the person who started a session on a computer can see or prompt it. On: sessions on
                    linked computers are shared like any other, and their commands run on that computer for
                    whoever prompts them.
                </div>
            </div>
            <${Switch}
                on=${shared}
                label=${`Let others use these sessions: ${shared ? "on" : "off"}`}
                onChange=${change}
            />
        </div>
    </div>`;
}

/** What runners are, for the About page. */
function AboutRunners() {
    return html`<div class="runner-page">
        <h3 class="runner-page-title">About runners</h3>
        <p>
            Run a session's tools on another of your computers: its files and commands are used there, while Pi,
            your models, and the history stay on this server.
        </p>
        <p class="muted">
            The computer connects out to this server, so it needs no open port. You and the people you choose can
            start sessions on computers you link. See <code>docs/runners.md</code> for everything else.
        </p>
    </div>`;
}

/** The Runners item's hint in the menu: how many linked computers are online. */
export function runnersHint() {
    const { runners } = store.state;

    if (runners.length === 0) {
        return "link a computer";
    }

    const online = runners.filter((runner) => runner.online).length;

    return `${online} of ${runners.length} online`;
}

/** A row in the list on the left: a computer, or a page about this server. */
function ListItem({ selected, onSelect, lead, title, detail, badge }) {
    return html`<button
        class=${`runner-item ${selected ? "on" : ""}`}
        aria-current=${selected ? "page" : undefined}
        onClick=${onSelect}
    >
        ${lead}
        <span class="runner-item-text">
            <span class="runner-item-title">${title}</span>
            ${detail && html`<span class="muted small">${detail}</span>`}
        </span>
        ${badge && html`<span class="runner-badge">${badge}</span>`}
    </button>`;
}

export function ComputersSheet() {
    const { runners } = store.state;
    const [loaded, setLoaded] = useState(false);
    const [view, setView] = useState(null);
    const [locks, setLocks] = useState(null);

    useEffect(() => {
        attempt(async () => {
            store.set({ runners: await api("runners") });
            setLoaded(true);
        });
    }, []);
    useEffect(() => {
        attempt(async () => setLocks(await api("runners/locks")));
    }, [store.state.runners, view]);

    // The first computer, or linking when there is none; a removed computer's page falls back the same way.
    const shown =
        view &&
        (view.startsWith("computer:")
            ? runners.some((runner) => `computer:${runner.id}` === view)
            : true)
            ? view
            : runners.length > 0
              ? `computer:${runners[0].id}`
              : loaded
                ? "link"
                : null;
    const lockCount = locks
        ? locks.addresses.length + locks.bans.length + (locks.server ? 1 : 0)
        : 0;
    const current = shown?.startsWith("computer:")
        ? runners.find((runner) => `computer:${runner.id}` === shown)
        : undefined;

    return html`<${Sheet} title="Runners" onClose=${closeSheet} className="runners-sheet">
        <div class="runners-split">
            <nav class="runners-list" aria-label="Runners">
                <div class="group-title">Computers</div>
                ${!loaded && runners.length === 0 && html`<${Loader} />`}
                ${loaded && runners.length === 0 && html`<p class="muted small runner-none">No computers linked yet.</p>`}
                ${runners.map(
                    (runner) => html`<${ListItem}
                        key=${runner.id}
                        selected=${shown === `computer:${runner.id}`}
                        onSelect=${() => setView(`computer:${runner.id}`)}
                        lead=${html`<span
                            class=${`runner-dot ${runner.online ? "on" : runner.away ? "away" : ""}`}
                            aria-hidden="true"
                        ></span>`}
                        title=${runner.name}
                        detail=${[
                            runner.online ? "Online" : runner.away ? "Offline" : "Not connected",
                            system(runner),
                        ]
                            .filter(Boolean)
                            .join(" · ")}
                        badge=${runner.online && !runner.approvals ? "update" : null}
                    />`,
                )}
                <div class="group-title">This server</div>
                <${ListItem}
                    selected=${shown === "link"}
                    onSelect=${() => setView("link")}
                    lead=${html`<${Icon} name="plus" size=${16} />`}
                    title="Link a computer"
                />
                <${ListItem}
                    selected=${shown === "limits"}
                    onSelect=${() => setView("limits")}
                    lead=${html`<${Icon} name="shield" size=${16} />`}
                    title="Linking limits"
                    badge=${lockCount > 0 ? String(lockCount) : null}
                />
                <${ListItem}
                    selected=${shown === "sharing"}
                    onSelect=${() => setView("sharing")}
                    lead=${html`<${Icon} name="users" size=${16} />`}
                    title="Sharing"
                />
                <${ListItem}
                    selected=${shown === "about"}
                    onSelect=${() => setView("about")}
                    lead=${html`<${Icon} name="monitor" size=${16} />`}
                    title="About runners"
                />
            </nav>
            <div class="runners-detail">
                ${current && html`<${ComputerPage} key=${current.id} runner=${current} />`}
                ${shown === "link" && html`<${LinkComputer} onDone=${() => setView(null)} />`}
                ${shown === "limits" && html`<${LinkLocks} locks=${locks} reload=${() => attempt(async () => setLocks(await api("runners/locks")))} />`}
                ${shown === "sharing" && html`<${SharedSessions} />`}
                ${shown === "about" && html`<${AboutRunners} />`}
            </div>
        </div>
    <//>`;
}
