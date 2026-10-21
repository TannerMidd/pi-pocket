// Extensions: the modules the owner can turn on and off, Lancet Guard, who may allow risky calls, and when PiP compacts
// its context.
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { browserModuleState, leaveSafeMode, safeMode } from "../extension-ui.js";
import { api, attempt, closeSheet, openSheet, store } from "../store.js";
import { html, Icon, Loader, Sheet, shortPath, Switch } from "../ui.js";
import { ACCESS_WORDS, galleryApi, galleryAvailable, Tile } from "./gallery.js";

/** The guide for people who write extensions: its first page, on the docs site, which describes the latest release. */
const GUIDE = "https://tannermidd.github.io/pi-pocket/docs/extensions/first-extension/";

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
            text: "Off in Pi Pocket: bash, write, and edit calls run unchecked here. Pi itself still uses it.",
        };
    }

    return {
        warn: false,
        text: "Checks bash, write, and edit calls. Risky ones wait for someone in the session to allow them.",
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
function ApprovalRule({ owner }) {
    const others = store.state.server?.approvalRule === "others";
    const change = () =>
        attempt(() => api("settings", { approvalRule: others ? "anyone" : "others" }));

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

/** What a module adds to the app: its routes, commands, and browser module with how it stands in this browser. */
function WebPart({ module }) {
    const web = module.web;

    if (!web || !module.enabled) {
        return null;
    }

    const here = browserModuleState(module.file.replace(/\.ts$/, ""));
    const parts = [
        web.routes.length > 0 && `routes: ${web.routes.join(", ")}`,
        web.commands?.length > 0 && `commands: ${web.commands.join(", ")}`,
        web.client && `browser module for ${ACCESS_WORDS[web.client] ?? web.client}`,
        here?.status === "loading" && "loading here",
        here?.status === "off" && "off in this tab",
    ].filter(Boolean);

    return html`${parts.length > 0 && html`<div class="muted small mono">${parts.join(" · ")}</div>`}
    ${
        here?.status === "failed" &&
        html`<div class="error-box small">
            In this browser: ${here.error}. An edit to it, or reloading the page, tries again.
        </div>`
    }`;
}

/**
 * Safe mode (`?noext=1`): this tab loads no browser parts of extensions, so one that breaks the app can be turned off
 * here. The button loads them again.
 */
function SafeMode() {
    if (!safeMode()) {
        return null;
    }

    return html`<div class="setting wrap safe-mode">
        <div class="grow small">Extensions' browser parts are off in this tab, and so is the theme.</div>
        <button class="button" onClick=${leaveSafeMode}>Turn them back on</button>
    </div>`;
}

/**
 * How a drop-in the gallery installed stands (`installed`: the gallery's word on it), or, for one of the owner's own, a
 * way to share it. Nothing for the rest.
 */
function GalleryPart({ module, installed, busy, turnOff }) {
    if (!galleryAvailable() || module.source !== "drop-in") {
        return null;
    }

    if (!installed) {
        return html`<div class="extension-gallery">
            <button
                class="link small"
                onClick=${() => openSheet({ type: "gallery-share", id: module.file })}
            >
                Share…
            </button>
        </div>`;
    }

    return html`${
        installed.revoked !== null &&
        html`<div class="error-box small">
            The gallery revoked this version: ${installed.revoked}
            ${
                module.enabled &&
                html`<div class="sheet-actions">
                    <button class="button small primary" disabled=${busy} onClick=${turnOff}>
                        Turn it off
                    </button>
                </div>`
            }
        </div>`
    }
    <div class="extension-gallery">
        <span class="pi-tag gallery-plain">from the gallery · ${installed.version}</span>
        ${installed.update && html`<span class="pi-tag behind">update available</span>`}
        <button
            class="link small"
            onClick=${() =>
                openSheet({
                    type: "gallery-entry",
                    id: installed.name,
                    tab: "installed",
                    origin: store.state.sheet?.origin ?? "extensions",
                })}
        >
            Details
        </button>
    </div>`;
}

/** When PiP compacts its own context: once idle above so many tokens (`pip-compact.ts`), or only as sessions do. */
const PIP_COMPACT = [
    [40000, "Above 40k tokens"],
    [60000, "Above 60k tokens"],
    [100000, "Above 100k tokens"],
    [0, "As sessions do"],
];

function PipCompactAt({ owner }) {
    const at = store.state.server?.pipCompactAt ?? 60000;
    const change = (value) => attempt(() => api("settings", { pipCompactAt: value }));

    return html`<div class="setting wrap">
        <div class="grow">
            <div class="small">Compact PiP's context</div>
            <div class="muted small">
                Once PiP is idle above this, older messages become a short summary.
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

export function ExtensionsSheet() {
    return html`<${Sheet} title="Extensions" onClose=${closeSheet} wide=${true}>
        <${ExtensionsContent} />
    <//>`;
}

/** Built-in modules' marks, by file; drop-ins show their first letter. */
const ICONS = {
    "prompt.ts": "chat",
    "artifacts.ts": "artifact",
    "browser.ts": "globe",
    "subagents.ts": "users",
    "schedules.ts": "clock",
    "goals.ts": "check",
    "plan.ts": "eye",
    "codemode.ts": "terminal",
    "memory.ts": "pin",
    "pip.ts": "pip",
    "triggers.ts": "pulse",
    "gallery.ts": "grid",
    "agent-teams.ts": "fork",
    "guard.ts": "shield",
    "anthropic-subscription.ts": "key",
};

/** A module's summary without the name it starts with ("Browser: Pi opens…" → "Pi opens…"), as its row shows the name. */
function summaryOf(module) {
    const name = module.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const rest = (module.summary ?? "").replace(new RegExp(`^(the )?${name}: `, "i"), "");

    return rest.charAt(0).toUpperCase() + rest.slice(1);
}

/** The same management controls standalone or in the hub's Installed tab. */
export function ExtensionsContent({ galleryInstalled, query = "", onChanged = () => {} }) {
    const { me } = store.state;
    const owner = me?.role === "owner";
    const [data, setData] = useState(null);
    const [problem, setProblem] = useState(null);
    const [busy, setBusy] = useState(null);
    const [confirmGuard, setConfirmGuard] = useState(false);
    // The drop-in waiting for the owner's word before it turns on, by file.
    const [confirmOn, setConfirmOn] = useState(null);
    // The rows opened to show their settings and details, by file.
    const [open, setOpen] = useState(new Set());
    const guardCancel = useRef(null);
    const guardSwitch = useRef(null);
    // What the gallery installed, by module file: read after the list, and never in the way of it.
    const [fromGallery, setFromGallery] = useState(new Map());
    const load = () =>
        api("extensions").then(
            (result) => {
                setData(result);
                setProblem(null);

                if (
                    galleryInstalled === undefined &&
                    galleryAvailable() &&
                    result.modules.some((each) => each.source === "drop-in")
                ) {
                    galleryApi("installed").then(
                        ({ items }) =>
                            setFromGallery(new Map(items.map((each) => [each.file, each]))),
                        () => {},
                    );
                }
            },
            (error) =>
                setProblem(
                    error.status === 404
                        ? "Restart the server (menu → Restart server) to manage extensions from here."
                        : error.message,
                ),
        );

    useEffect(() => {
        load();
    }, [galleryInstalled]);
    // The model download changes the guard's status in every tab (the server pushes it): read the list again.
    const modelState = store.state.guard?.model?.state;

    useEffect(() => {
        if (data) {
            load();
        }
    }, [modelState]);
    useLayoutEffect(() => {
        if (confirmGuard) {
            guardCancel.current?.focus();
        } else if (busy === null) {
            // Accepting disables switches until the request ends; restore focus only once it can take it.
            guardSwitch.current?.focus({ preventScroll: true });
            guardSwitch.current = null;
        }
    }, [confirmGuard, busy]);

    const change = (module, path, body) => {
        setBusy(module.file);
        attempt(async () =>
            setData(await api(`extensions/${encodeURIComponent(module.file)}${path}`, body)),
        ).finally(() => {
            setBusy(null);
            load();
            onChanged();
        });
    };

    const toggle = (module, button) => {
        if (module.file === "guard.ts" && module.enabled) {
            guardSwitch.current = button;
            guardCancel.current?.focus();
            setConfirmGuard(true);

            return;
        }

        // A drop-in runs with the owner's rights: it asks first, in its own row, not in a dialog over the app.
        if (module.source === "drop-in" && !module.enabled) {
            setConfirmOn(confirmOn === module.file ? null : module.file);

            return;
        }

        setConfirmGuard(false);
        change(module, "", { enabled: !module.enabled });
    };

    const flip = (file) => {
        const next = new Set(open);

        if (next.has(file)) {
            next.delete(file);
        } else {
            next.add(file);
        }

        setOpen(next);
    };

    const installedByFile =
        galleryInstalled === undefined
            ? fromGallery
            : new Map(galleryInstalled.map((item) => [item.file, item]));
    const needle = query.trim().toLowerCase();
    const managed = (data?.modules ?? []).filter(
        (module) =>
            (galleryInstalled === undefined ||
                !installedByFile.has(module.file) ||
                // Keep failed gallery modules here too: their loader/browser errors are management data.
                module.error ||
                browserModuleState(module.file.replace(/\.ts$/, ""))?.status === "failed") &&
            (!needle ||
                [
                    module.title,
                    module.file,
                    module.summary ?? "",
                    ...module.extensions.flatMap((extension) => extension.tools),
                ].some((text) => text.toLowerCase().includes(needle))),
    );

    const row = (module) => {
        const tools = module.extensions.flatMap((extension) => extension.tools);
        const guard = module.file === "guard.ts";
        const note = guard ? guardNote(module, data.guard) : null;
        const installed = installedByFile.get(module.file);
        const isOpen = open.has(module.file);
        const id = `ext-more-${module.file.replace(/[^a-z0-9]/gi, "-")}`;

        return html`<div
            key=${module.file}
            class=${`ext-row module ${module.enabled ? "" : "off"} ${isOpen ? "open" : ""}`}
        >
            <button
                class="ext-row-open"
                aria-expanded=${isOpen ? "true" : "false"}
                aria-controls=${id}
                onClick=${() => flip(module.file)}
            >
                <${Tile} name=${module.file} title=${module.title} icon=${ICONS[module.file] ?? null} />
                <span class="ext-row-text">
                    <span class="ext-row-title">
                        ${module.title}
                        <${Icon} name="down" size=${14} class="ext-row-chevron" />
                    </span>
                    ${module.summary && html`<span class="ext-row-desc">${summaryOf(module)}</span>`}
                    ${module.error && html`<span class="ext-row-meta warn">Did not load</span>`}
                    ${installed?.revoked && html`<span class="ext-row-meta warn">The gallery revoked this version</span>`}
                    ${installed?.update && html`<span class="ext-row-meta accent">An update is ready</span>`}
                </span>
            </button>
            <div class="ext-row-end">
                ${
                    module.required
                        ? html`<span class="ext-state">Always on</span>`
                        : html`<${Switch}
                              on=${module.enabled}
                              disabled=${!owner || busy !== null}
                              label=${`${module.title}: ${module.enabled ? "on" : "off"}`}
                              onChange=${(event) => toggle(module, event.currentTarget)}
                          />`
                }
            </div>
            ${note?.warn && html`<div class="ext-row-under small warn">${note.text}</div>`}
            ${
                guard &&
                html`<div class="ext-row-under">
                    <${GuardModel}
                        owner=${owner}
                        model=${store.state.guard?.model ?? data.guard.model}
                        onStart=${() => attempt(async () => setData(await api("guard/model", {})))}
                    />
                </div>`
            }
            ${
                guard &&
                module.enabled &&
                confirmGuard &&
                html`<div
                    class="guard-confirm ext-row-under"
                    role="alertdialog"
                    aria-label="Turn off Lancet Guard?"
                    aria-describedby="guard-confirm-warning"
                    onKeyDown=${(event) => {
                        if (event.key === "Escape" && !event.isComposing && event.keyCode !== 229) {
                            event.preventDefault();
                            event.stopPropagation();
                            setConfirmGuard(false);
                        }
                    }}
                >
                    <span id="guard-confirm-warning">bash, write, and edit calls will run without checks in every session here. Pi's own setting stays as it is.</span>
                    <div class="sheet-actions">
                        <button
                            class="button small"
                            ref=${guardCancel}
                            onClick=${() => setConfirmGuard(false)}
                        >
                            Keep it on
                        </button>
                        <button
                            class="button small primary"
                            disabled=${busy !== null}
                            onClick=${() => {
                                setConfirmGuard(false);
                                change(module, "", { enabled: false });
                            }}
                        >
                            Turn off
                        </button>
                    </div>
                </div>`
            }
            ${
                confirmOn === module.file &&
                !module.enabled &&
                html`<div class="ext-confirm ext-row-under" role="group" aria-label=${`Turn on ${module.title}?`}>
                    <span>It runs inside the server with your rights, in every session. Turn it on only if you trust its code.</span>
                    <div class="sheet-actions">
                        <button class="button small" onClick=${() => setConfirmOn(null)}>Not now</button>
                        <button
                            class="button small primary"
                            disabled=${busy !== null}
                            onClick=${() => {
                                setConfirmOn(null);
                                change(module, "", { enabled: true });
                            }}
                        >
                            Turn on
                        </button>
                    </div>
                </div>`
            }
            ${module.error && html`<div class="error-box small ext-row-under">${module.error}</div>`}
            ${
                isOpen &&
                html`<div class="ext-row-more ext-row-under" id=${id}>
                    ${note && !note.warn && html`<div class="small ok">${note.text}</div>`}
                    ${guard && module.enabled && html`<${ApprovalRule} owner=${owner} />`}
                    ${module.file === "pip.ts" && module.enabled && html`<${PipCompactAt} owner=${owner} />`}
                    <${WebPart} module=${module} />
                    <${GalleryPart}
                        module=${module}
                        installed=${installed}
                        busy=${busy !== null}
                        turnOff=${() => change(module, "", { enabled: false })}
                    />
                    <div class="muted small mono">
                        ${module.source === "drop-in" ? `drop-in${module.path ? ` · ${shortPath(module.path, store.state.server?.home)}` : ""}` : module.file}
                        ${tools.length > 0 ? ` · tools: ${tools.join(", ")}` : ""}
                    </div>
                    ${
                        owner &&
                        module.enabled &&
                        html`<div class="ext-step-actions">
                            <button
                                class="button small"
                                disabled=${busy !== null}
                                onClick=${() => change(module, "/reload", {})}
                            >
                                <${Icon} name="reload" size=${14} /> Reload
                            </button>
                        </div>`
                    }
                </div>`
            }
        </div>`;
    };

    return html`<div class="extension-management">
        <p class="ext-intro">
            Tools, checks, and app features. A change reaches every session at once and stays after restarts.${owner ? "" : " Only the owner can change them."}
        </p>
        <${SafeMode} />
        ${problem && html`<div class="error-box">${problem}</div>`}
        ${!data && !problem && html`<${Loader} label="Loading extensions" />`}
        ${
            data &&
            [
                ["Built in", managed.filter((module) => module.source !== "drop-in")],
                ["Yours", managed.filter((module) => module.source === "drop-in")],
            ]
                .filter(([, modules]) => modules.length > 0)
                .map(
                    ([title, modules]) => html`<div class="group" key=${title}>
                        <div class="group-title">${title}</div>
                        <div class="ext-list">${modules.map(row)}</div>
                    </div>`,
                )
        }
        ${
            data &&
            needle &&
            managed.length === 0 &&
            html`<p class="muted small">No built-in extensions or drop-ins match.</p>`
        }
        ${
            owner &&
            html`<footer class="ext-footer">
                ${
                    galleryInstalled === undefined &&
                    galleryAvailable() &&
                    html`<button class="link small" onClick=${() => openSheet({ type: "gallery" })}>
                        <${Icon} name="search" size=${14} /> Find extensions
                    </button>`
                }
                ${
                    data?.dropIns &&
                    html`<span>
                        Make your own: put a <span class="mono">.ts</span> module in <span class="mono">${shortPath(data.dropIns, store.state.server?.home)}</span>. It stays off until you turn it on.
                    </span>`
                }
                <a class="link small" href=${GUIDE} target="_blank" rel="noopener noreferrer">
                    How to write one <${Icon} name="external" size=${13} />
                </a>
            </footer>`
        }
    </div>`;
}
