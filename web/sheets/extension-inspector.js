import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { browserModuleState, leaveSafeMode, safeMode } from "../extension-ui.js";
import { useBack } from "../back.js";
import { api, attempt, openSheet, store } from "../store.js";
import { html, Icon, Loader, shortPath, Switch } from "../ui.js";
import { ACCESS_WORDS, galleryAvailable } from "./gallery.js";
import { iconOf, stateOf, summaryOf } from "./extension-library-model.js";

/** What Lancet Guard does here, given the module's switch and Pi's own setting. */
function guardNote(module, guard) {
    if (!guard.available) {
        return { warn: true, text: guard.detail };
    }

    if (!guard.enabled) {
        return {
            warn: true,
            text: "Off in Pi's own settings (~/.pi/lancet-guard.json), so it does not run here either.",
        };
    }

    if (!module.enabled) {
        return {
            warn: true,
            text: "Off in Pi Pocket: bash, background, write, and edit calls run unchecked here. Pi itself still uses it.",
        };
    }

    return {
        warn: false,
        text: "Checks bash, background, write, and edit calls. Risky ones wait for someone in the session to allow them.",
    };
}

/** The LANCET model Lancet Guard scores commands with: a one-time download the owner starts here. */
function GuardModel({ owner, model, onStart }) {
    if (!model || model.state === "ready") {
        return null;
    }

    const downloading = model.state === "downloading";

    return html`<div class="setting">
        <div class="grow">
            <div class="small">LANCET model</div>
            <div class=${`small ${model.state === "failed" ? "warn" : "muted"}`}>
                ${
                    model.state === "missing"
                        ? "Not downloaded yet. The guard needs it to score commands. The download (about 109 MB) comes from the LANCET-model GitHub release, is checked against fixed checksums, and Pi uses it too."
                        : model.detail
                }
            </div>
        </div>
        ${
            downloading
                ? html`<${Loader} label="Downloading" />`
                : owner &&
                  html`<button class="button small primary" onClick=${onStart}>
                      ${model.state === "failed" ? "Try again" : "Download"}
                  </button>`
        }
    </div>`;
}

/** Who may allow a risky call: anyone who can steer, or (for guests) someone other than whoever asked for it. */
function ApprovalRule({ owner, onChanged }) {
    const others = store.state.server?.approvalRule === "others";
    const change = () =>
        attempt(async () => {
            await api("settings", { approvalRule: others ? "anyone" : "others" });
            await onChanged();
        });

    return html`<div class="setting">
        <div class="grow">
            <div class="small">Approvals need someone else</div>
            <div class="muted small">
                A guest cannot allow a call that their own message led to. You always can.
            </div>
        </div>
        <${Switch}
            on=${others}
            disabled=${!owner}
            label=${`Approvals need someone else: ${others ? "on" : "off"}`}
            onChange=${change}
        />
    </div>`;
}

/**
 * A module's settings (`web.settings`), for the owner: each field as the module declared it, saved together. A secret
 * shows only whether it is set; typing a new one replaces it, and Clear puts its default back.
 */
function ModuleSettings({ module, onChanged }) {
    const [shown, setShown] = useState(null);
    const [draft, setDraft] = useState({});
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(false);
    const path = `extension-settings/${encodeURIComponent(module)}`;

    useEffect(() => {
        // Only the answer for the module shown now: a slower one for another module never takes its place.
        let live = true;

        setShown(null);
        setDraft({});
        setError(null);
        api(path).then(
            (answer) => live && setShown(answer),
            (failure) => live && setError(failure.message),
        );

        return () => {
            live = false;
        };
    }, [module]);

    if (error && !shown) {
        return html`<div class="error-box small">${error}</div>`;
    }

    if (!shown) {
        return html`<${Loader} label="Settings" />`;
    }

    // What a field shows: the owner's change, the default when they asked for it back (null), or the value now.
    const value = (field) => {
        if (!Object.hasOwn(draft, field.name)) {
            return shown.values[field.name] ?? "";
        }

        return draft[field.name] === null ? (field.default ?? "") : draft[field.name];
    };

    const set = (name, next) => setDraft({ ...draft, [name]: next });

    const save = async () => {
        setError(null);

        // A number is typed as text ("-", "1."), and becomes a number only now; an empty one puts the default back.
        const unreadable = shown.fields.find(
            (field) =>
                field.type === "number" &&
                typeof draft[field.name] === "string" &&
                draft[field.name].trim() !== "" &&
                !Number.isFinite(Number(draft[field.name])),
        );

        if (unreadable !== undefined) {
            setError(`${unreadable.label} must be a number.`);

            return;
        }

        setBusy(true);

        const change = Object.fromEntries(
            Object.entries(draft).map(([name, next]) => {
                const field = shown.fields.find((each) => each.name === name);

                if (field?.type !== "number" || typeof next !== "string") {
                    return [name, next];
                }

                return [name, next.trim() === "" ? null : Number(next)];
            }),
        );

        try {
            setShown(await api(path, change, { method: "PUT" }));
            setDraft({});
            await onChanged();
        } catch (failure) {
            setError(failure.message);
        } finally {
            setBusy(false);
        }
    };

    return html`<div class="ext-settings">
        ${shown.fields.map((field) => {
            const secret = field.type === "text" && field.secret;
            const id = `ext-setting-${module}-${field.name}`;
            const range =
                field.type === "number" && (field.min !== undefined || field.max !== undefined)
                    ? `From ${field.min ?? "any"} to ${field.max ?? "any"}`
                    : undefined;
            const hint =
                secret && shown.set.includes(field.name)
                    ? "Set: type to replace"
                    : (field.placeholder ?? "");

            return html`<div class="setting wrap" key=${field.name}>
                <div class="grow">
                    <label class="small" for=${id}>${field.label}</label>
                    ${
                        field.description &&
                        html`<div class="muted small">${field.description}</div>`
                    }
                </div>
                ${
                    field.type === "boolean"
                        ? html`<${Switch}
                              on=${value(field) === true}
                              disabled=${busy}
                              label=${field.label}
                              onChange=${() => set(field.name, value(field) !== true)}
                          />`
                        : field.type === "choice"
                          ? html`<select
                                id=${id}
                                disabled=${busy}
                                value=${value(field)}
                                onChange=${(event) => set(field.name, event.currentTarget.value)}
                            >
                                ${field.choices.map(
                                    (choice) =>
                                        html`<option value=${choice.value}>${choice.label}</option>`,
                                )}
                            </select>`
                          : html`<input
                                id=${id}
                                class="ext-setting-input"
                                disabled=${busy}
                                type=${secret ? "password" : "text"}
                                inputmode=${field.type === "number" ? "decimal" : undefined}
                                autocomplete="off"
                                placeholder=${hint}
                                value=${secret ? (draft[field.name] ?? "") : value(field)}
                                title=${range}
                                onInput=${(event) => set(field.name, event.currentTarget.value)}
                            />`
                }
                ${
                    shown.set.includes(field.name) &&
                    html`<button
                        class="button small"
                        title="Put its default back"
                        disabled=${busy}
                        onClick=${() => set(field.name, null)}
                    >
                        ${secret ? "Clear" : "Default"}
                    </button>`
                }
            </div>`;
        })}
        ${error && html`<div class="error-box small">${error}</div>`}
        <div class="ext-step-actions">
            <button
                class="button small primary"
                disabled=${busy || Object.keys(draft).length === 0}
                onClick=${save}
            >
                ${busy ? "Saving…" : "Save settings"}
            </button>
        </div>
    </div>`;
}

/** What the running module registered with the app. */
function WebPart({ module }) {
    const web = module.web;

    if (!web || !module.enabled) {
        return null;
    }

    const parts = [
        web.routes.length > 0 && `routes: ${web.routes.join(", ")}`,
        web.commands?.length > 0 && `commands: ${web.commands.join(", ")}`,
        web.client && `browser module for ${ACCESS_WORDS[web.client] ?? web.client}`,
        web.publicPage && "pages for anyone with a link, no sign-in",
        web.service && "a service for other modules",
    ].filter(Boolean);

    return parts.length > 0 && html`<div class="muted small mono">${parts.join(" · ")}</div>`;
}

/**
 * Safe mode (`?noext=1`): this tab loads no browser parts of extensions, so one that breaks the app can be turned off
 * here. The button loads them again.
 */
export function SafeMode() {
    if (!safeMode()) {
        return null;
    }

    return html`<div class="setting wrap safe-mode">
        <div class="grow small">Extensions' browser parts are off in this tab, and so is the theme.</div>
        <button class="button" onClick=${leaveSafeMode}>Turn them back on</button>
    </div>`;
}

/** When PiP compacts its own context: once idle above so many tokens (`pip-compact.ts`), or only as sessions do. */
const PIP_COMPACT = [
    [0, "As sessions do"],
    [40000, "Above 40k tokens"],
    [60000, "Above 60k tokens"],
    [100000, "Above 100k tokens"],
];

function PipCompactAt({ owner, onChanged }) {
    const at = store.state.server?.pipCompactAt ?? 0;
    const change = (value) =>
        attempt(async () => {
            await api("settings", { pipCompactAt: value });
            await onChanged();
        });

    return html`<div class="setting wrap">
        <div class="grow">
            <div class="small">Compact PiP's context</div>
            <div class="muted small">
                When PiP's older messages become a short summary: as a session's do, or sooner,
                once PiP is idle above a limit, which keeps each reply cheaper.
            </div>
        </div>
        <div class="segmented" role="group" aria-label="Compact PiP's context">
            ${PIP_COMPACT.map(
                ([value, label]) => html`<button
                    class=${at === value ? "on" : ""}
                    aria-pressed=${at === value}
                    disabled=${!owner}
                    onClick=${() => change(value)}
                >
                    ${label}
                </button>`,
            )}
        </div>
    </div>`;
}

/** Claude subscription billing: what the owner must know before it is on, and a line while it is. */
const CLAUDE_BILLING = "anthropic-subscription.ts";
const CLAUDE_RISK =
    "Anthropic's terms forbid using Claude through scripts or other automated means, except with an API key or where Anthropic explicitly allows it. Its help pages say third-party apps can use your subscription limits, but its servers often bill such requests as extra usage. This makes Pi Pocket's requests look like Claude Code's. Anthropic could refuse them, bill them, or act on your account. Turn it on only if you accept that risk.";
const CLAUDE_ON =
    "On at your own risk: Anthropic's terms and its help pages disagree on using a subscription in third-party apps.";

const NEW_PROFILE_NOTES = {
    "agent-teams.ts":
        "Pi can start linked sessions when work needs them. Turning this on does not start a session or make a model call.",
    "pocket-relay.ts":
        "No connection starts until you add a connector in Menu → Relay. Installation adds no connectors and uses no credentials.",
    "relay-triage.ts":
        "No screening or classifier calls happen until you choose a classifier in Providers or here. A provider sign-in alone selects nothing. Then messages from unmarked senders and replies to them go to its provider, including secrets in reply text. Screening is best effort, not a boundary.",
    "run-outcomes.ts":
        "Reports and notifications stay unchanged, with no classifier calls, until you choose a classifier in Providers or here. A provider sign-in alone selects nothing. Then final-answer excerpts go to its provider, including linked-session and subagent reports without watchers. Labels are not proof of success.",
};

export function ModuleInspector(props) {
    return html`<${Inspector} key=${props.module.file} ...${props} />`;
}

function Inspector({ module, data, onChanged, installed, galleryManaged = false }) {
    const owner = store.state.me?.role === "owner";
    const [busy, setBusy] = useState(false);
    const [confirm, setConfirm] = useState(false);
    const cancel = useRef(null);
    const trigger = useRef(null);
    const dropIn = module.source === "drop-in";
    const guard = !dropIn && module.file === "guard.ts";
    const claude = !dropIn && module.file === CLAUDE_BILLING;
    const pip = !dropIn && module.file === "pip.ts";
    const guardOff = guard && module.enabled;
    const unknown = dropIn && galleryAvailable() && installed === undefined;
    const restrictEnable = unknown || installed?.revoked != null;
    const state = stateOf(module);
    const source = !dropIn
        ? "Built in"
        : installed
          ? "Gallery"
          : installed === null
            ? "Local drop-in"
            : "Drop-in";
    const slug = module.file.replace(/\.ts$/, "");
    const here = browserModuleState(slug);
    const note = guard && data?.guard ? guardNote(module, data.guard) : null;
    const profileNote = !dropIn && NEW_PROFILE_NOTES[module.file];
    const settings = owner && module.enabled && (guard || pip || module.web?.settings);
    const showConfirm =
        confirm &&
        !galleryManaged &&
        owner &&
        !module.required &&
        (guardOff || (!module.enabled && !restrictEnable && (dropIn || claude)));

    useBack(showConfirm, () => setConfirm(false));
    useEffect(() => {
        if (confirm && !showConfirm) {
            setConfirm(false);
        }
    }, [confirm, showConfirm]);
    useLayoutEffect(() => {
        if (showConfirm) {
            cancel.current?.focus();
        } else if (!busy) {
            trigger.current?.focus({ preventScroll: true });
            trigger.current = null;
        }
    }, [showConfirm, busy]);

    const mutate = (path, body) => {
        setBusy(true);
        setConfirm(false);
        attempt(() => api(path, body))
            .finally(onChanged)
            .finally(() => setBusy(false));
    };

    const path = `extensions/${encodeURIComponent(module.file)}`;

    const toggle = (event) => {
        if (guardOff || (!module.enabled && (dropIn || claude))) {
            trigger.current = event.currentTarget;
            setConfirm(!confirm);
        } else {
            mutate(path, { enabled: !module.enabled });
        }
    };

    const icon = iconOf(module);

    return html`<div class="ext-inspector">
        ${
            !galleryManaged &&
            html`<header class="ext-inspector-hero">
            <span class="ext-inspector-icon" aria-hidden="true">
                ${icon ? html`<${Icon} name=${icon} size=${24} />` : module.title.charAt(0)}
            </span>
            ${
                !dropIn &&
                module.file === "agent-teams.ts" &&
                html`<svg class="ext-team-branches" viewBox="0 0 160 72" aria-hidden="true">
                <path stroke-dasharray="2 5" opacity=".45" d="M0 12h160M0 36h160M0 60h160" />
                <path
                    d="M8 36h28q9 0 17-9l5-6q8-9 17-9h48M8 36h142M37 36q9 0 17 9l5 6q8 9 17 9h47"
                />
                <g fill="var(--card)">
                    <circle cx="8" cy="36" r="4" />
                    <rect x="119" y="8" width="8" height="8" rx="2" />
                    <rect x="146" y="32" width="8" height="8" rx="2" />
                    <rect x="119" y="56" width="8" height="8" rx="2" />
                </g>
            </svg>`
            }
            <h3>${module.title}</h3>
            <div class="ext-inspector-pills">
                <span class="pi-tag">${source}</span>
                <span class="pi-tag">${state}</span>
            </div>
            ${module.summary && html`<p>${summaryOf(module)}</p>`}
        </header>`
        }
        ${
            !galleryManaged &&
            html`<div class="ext-inspector-toggle setting">
            <div class="grow">
                <div>${module.required ? "Always enabled" : "Enable extension"}</div>
                <div class="small muted">Every session · saved after restart.${owner ? "" : " Only the owner can change this."}</div>
            </div>
            <span class="small">${state}</span>
            ${
                !module.required &&
                html`<${Switch}
                on=${module.enabled}
                disabled=${!owner || busy || (!module.enabled && restrictEnable)}
                label=${`${module.title}: ${module.enabled ? "on" : "off"}`}
                onChange=${toggle}
            />`
            }
        </div>`
        }
        ${
            unknown &&
            !galleryManaged &&
            html`<div class="setting wrap">
            <p class="small muted grow">Gallery install information is unavailable. Refresh it before turning this extension on or sharing it.</p>
            <button class="button small" onClick=${() => attempt(onChanged)}>Refresh</button>
        </div>`
        }
        ${
            !galleryManaged &&
            installed?.revoked != null &&
            html`<p class="error-box small">The gallery revoked this version: ${installed.revoked}</p>`
        }
        ${
            showConfirm &&
            html`<div
            class=${guardOff ? "guard-confirm" : "ext-confirm"}
            role="alertdialog"
            aria-label=${`Turn ${guardOff ? "off" : "on"} ${module.title}?`}
            aria-describedby="ext-confirm-description"
            onKeyDown=${(event) => {
                if (event.key === "Escape" && !event.isComposing && event.keyCode !== 229) {
                    event.preventDefault();
                    event.stopPropagation();
                    setConfirm(false);
                }
            }}
        >
            <strong>Turn ${guardOff ? "off" : "on"} ${module.title}?</strong>
            <span id="ext-confirm-description">${
                guardOff
                    ? "bash, background, write, and edit calls will run without checks in every session here. Pi's own setting stays as it is."
                    : claude
                      ? CLAUDE_RISK
                      : "It runs inside the server with your rights, in every session. Lancet Guard does not check its code. Turn it on only if you trust its code."
            }</span>
            <div class="sheet-actions">
                <button class="button small" ref=${cancel} onClick=${() => setConfirm(false)}>
                    ${guardOff ? "Keep it on" : "Not now"}
                </button>
                <button
                    class="button small primary"
                    disabled=${busy}
                    onClick=${() => mutate(path, { enabled: !guardOff })}
                >
                    ${guardOff ? "Turn off" : "Turn on"}
                </button>
            </div>
        </div>`
        }
        ${module.error && html`<div class="error-box small">${module.error}</div>`}
        ${module.enabled && here?.status === "failed" && html`<div class="error-box small">In this browser: ${here.error}. Edit the module or reload the page to try again.</div>`}
        ${claude && module.enabled && html`<p class="small warn">${CLAUDE_ON}</p>`}
        ${
            (note || profileNote) &&
            html`<section class="ext-inspector-section">
            <h4>What enabling does</h4>
            ${note && html`<p class=${`small ${note.warn ? "warn" : "muted"}`}>${note.text}</p>`}
            ${profileNote && html`<p class="small muted workflow-default-note">${profileNote} On for new profiles. Existing profiles keep their previous setting.</p>`}
        </section>`
        }
        ${
            guard &&
            html`<${GuardModel}
            owner=${owner && !busy}
            model=${store.state.guard?.model ?? data?.guard?.model}
            onStart=${() => mutate("guard/model", {})}
        />`
        }
        ${
            settings &&
            html`<details class="ext-inspector-details">
            <summary><${Icon} name="command" size=${15} /> Settings</summary>
            ${guard && html`<${ApprovalRule} owner=${owner} onChanged=${onChanged} />`}
            ${pip && html`<${PipCompactAt} owner=${owner} onChanged=${onChanged} />`}
            ${
                owner &&
                module.web?.settings &&
                html`<${ModuleSettings} module=${slug} onChanged=${onChanged} />`
            }
        </details>`
        }
        <details class="ext-inspector-details">
            <summary><${Icon} name="terminal" size=${15} /> Technical details</summary>
            <div class="small mono">${
                module.path ? shortPath(module.path, store.state.server?.home) : module.file
            }</div>
            <${WebPart} module=${module} />
            ${
                module.enabled &&
                ["loading", "off"].includes(here?.status) &&
                html`<div class="small muted">Browser module: ${here.status} in this tab</div>`
            }
            ${(module.extensions ?? []).map(
                (ext) => html`<div class="small muted mono" key=${ext.name}>
                ${ext.name}
                ${["tools", "hooks", "sections", "wraps"]
                    .filter((key) => ext[key]?.length)
                    .map((key) => html`<div>${key}: ${ext[key].join(", ")}</div>`)}
            </div>`,
            )}
            <div class="ext-step-actions">
                ${
                    owner &&
                    module.enabled &&
                    html`<button
                        class="button small"
                        disabled=${busy}
                        onClick=${() => mutate(`${path}/reload`, {})}
                    >
                        <${Icon} name="reload" size=${14} /> Reload
                    </button>`
                }
                ${
                    owner &&
                    !galleryManaged &&
                    dropIn &&
                    installed === null &&
                    galleryAvailable() &&
                    html`<button
                        class="button small"
                        onClick=${() => openSheet({ type: "gallery-share", id: module.file })}
                    >
                        Share…
                    </button>`
                }
                ${
                    !galleryManaged &&
                    html`<a
                        class="link small"
                        href=${
                            dropIn
                                ? "https://tannermidd.github.io/pi-pocket/docs/extensions/modules/"
                                : "https://tannermidd.github.io/pi-pocket/docs/features/"
                        }
                        target="_blank"
                        rel="noopener noreferrer"
                    >
                        ${dropIn ? "Module guide" : "Feature guide"} <${Icon} name="external" size=${13} />
                    </a>`
                }
            </div>
        </details>
    </div>`;
}
