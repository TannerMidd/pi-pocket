import { t } from "../i18n.js";
// Extensions: the modules the owner can turn on and off, Lancet Guard, who may allow risky calls, and when PiP compacts
// its context.
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { browserModuleState, leaveSafeMode, safeMode } from "../extension-ui.js";
import { api, attempt, closeSheet, openSheet, store } from "../store.js";
import { html, Icon, Loader, Sheet, shortPath, Switch } from "../ui.js";
import { ACCESS_WORDS, galleryApi, galleryAvailable } from "./gallery.js";

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
            text: t("Off in Pi's own settings ({{path}}), so it does not run here either.", {
                path: "~/.pi/lancet-guard.json",
            }),
        };
    }

    if (!module.enabled) {
        return {
            warn: true,
            text: t(
                "Off in Pi Pocket: bash, write, and edit calls run unchecked here. Pi itself still uses it.",
            ),
        };
    }

    return {
        warn: false,
        text: t(
            "Checks bash, write, and edit calls. Risky ones wait for someone in the session to allow them.",
        ),
    };
}

/** Who may allow a risky call: anyone who can steer, or (for guests) someone other than whoever asked for it. */
function ApprovalRule({ owner }) {
    const others = store.state.server?.approvalRule === "others";
    const change = () =>
        attempt(() => api("settings", { approvalRule: others ? "anyone" : "others" }));

    return html`<div class="setting">
        <div class="grow">
            <div class="small">${t("Approvals need someone else")}</div>
            <div class="muted small">
                ${t("A guest cannot allow a call that their own message led to. You always can.")}
            </div>
        </div>
        <${Switch}
            on=${others}
            disabled=${!owner}
            label=${t("Approvals need someone else: {{state}}", { state: t(others ? "on" : "off") })}
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
        web.routes.length > 0 && t("routes: {{routes}}", { routes: web.routes.join(", ") }),
        web.commands?.length > 0 &&
            t("commands: {{commands}}", { commands: web.commands.join(", ") }),
        web.client &&
            t("browser module for {{word}}", { word: t(ACCESS_WORDS[web.client] ?? web.client) }),
        here?.status === "loading" && t("loading here"),
        here?.status === "off" && t("off in this tab"),
    ].filter(Boolean);

    return html`${parts.length > 0 && html`<div class="muted small mono">${parts.join(" · ")}</div>`}
    ${
        here?.status === "failed" &&
        html`<div class="error-box small">
            ${t("In this browser: {{error}}. An edit to it, or reloading the page, tries again.", { error: here.error })}
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
        <div class="grow small">${t("Extensions' browser parts are off in this tab, and so is the theme.")}</div>
        <button class="button" onClick=${leaveSafeMode}>${t("Turn them back on")}</button>
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
                ${t("Share…")}
            </button>
        </div>`;
    }

    return html`${
        installed.revoked !== null &&
        html`<div class="error-box small">
            ${t("The gallery revoked this version: {{reason}}", { reason: installed.revoked })}
            ${
                module.enabled &&
                html`<div class="sheet-actions">
                    <button class="button small primary" disabled=${busy} onClick=${turnOff}>
                        ${t("Turn it off")}
                    </button>
                </div>`
            }
        </div>`
    }
    <div class="extension-gallery">
        <span class="pi-tag gallery-plain">${t("from the gallery · {{version}}", { version: installed.version })}</span>
        ${installed.update && html`<span class="pi-tag behind">${t("update available")}</span>`}
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
            ${t("Details")}
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
            <div class="small">${t("Compact PiP's context")}</div>
            <div class="muted small">
                ${t("Once PiP is idle above this, older messages become a short summary.")}
            </div>
        </div>
        <div class="segmented" role="group" aria-label=${t("Compact PiP's context")}>
            ${PIP_COMPACT.map(
                ([value, label]) => html`<button
                    class=${at === value ? "on" : ""}
                    aria-pressed=${at === value}
                    disabled=${!owner}
                    onClick=${() => change(value)}
                >
                    ${t(label)}
                </button>`,
            )}
        </div>
    </div>`;
}

export function ExtensionsSheet() {
    return html`<${Sheet} title=${t("Extensions")} onClose=${closeSheet} wide=${true}>
        <${ExtensionsContent} />
    <//>`;
}

/** The same management controls standalone or in the hub's Installed tab. */
export function ExtensionsContent({ galleryInstalled, query = "", onChanged = () => {} }) {
    const { me } = store.state;
    const owner = me?.role === "owner";
    const [data, setData] = useState(null);
    const [problem, setProblem] = useState(null);
    const [busy, setBusy] = useState(null);
    const [confirmGuard, setConfirmGuard] = useState(false);
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
                        ? t(
                              "Restart the server (menu → Restart server) to manage extensions from here.",
                          )
                        : error.message,
                ),
        );

    useEffect(() => {
        load();
    }, [galleryInstalled]);
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

        if (
            module.source === "drop-in" &&
            !module.enabled &&
            !confirm(
                t(
                    "Turn on {{title}}?\n\nA drop-in extension runs inside the server with your rights, in every session.",
                    { title: module.title },
                ),
            )
        ) {
            return;
        }

        setConfirmGuard(false);
        change(module, "", { enabled: !module.enabled });
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

    return html`<div class="extension-management">
        <p class="muted small">
            ${t("Extensions give Pi its tools and checks in Pi Pocket, and can add pages and buttons to the app. A change applies to every session right away and stays after restarts.")}${owner ? "" : ` ${t("Only the owner can change them.")}`}
        </p>
        <${SafeMode} />
        ${
            owner &&
            html`<div class="sheet-list">
                ${
                    galleryInstalled === undefined &&
                    galleryAvailable() &&
                    html`<button class="list-item" onClick=${() => openSheet({ type: "gallery" })}>
                        <span><${Icon} name="search" size=${16} /> ${t("Find extensions")}</span>
                        <span class="muted small">${t("extensions and themes other people made")}</span>
                    </button>`
                }
                <a class="list-item" href=${GUIDE} target="_blank" rel="noopener noreferrer">
                    <span><${Icon} name="external" size=${16} /> ${t("How to write one")}</span>
                    <span class="muted small">${t("the guide (latest release)")}</span>
                </a>
            </div>`
        }
        ${problem && html`<div class="error-box">${problem}</div>`}
        ${!data && !problem && html`<${Loader} label=${t("Loading extensions")} />`}
        ${
            data &&
            [
                ["Built in", managed.filter((module) => module.source !== "drop-in")],
                ["Yours", managed.filter((module) => module.source === "drop-in")],
            ]
                .filter(([, modules]) => modules.length > 0)
                .map(
                    ([title, modules]) => html`<div class="group">
                        <div class="group-title">${t(title)}</div>
                        <div class="sheet-list">
                            ${modules.map((module) => {
                                const tools = module.extensions.flatMap(
                                    (extension) => extension.tools,
                                );
                                const note =
                                    module.file === "guard.ts"
                                        ? guardNote(module, data.guard)
                                        : null;

                                return html`<div class=${`extension ${module.enabled ? "" : "off"}`}>
                                    <div class="extension-main">
                                        <div class="extension-title">
                                            ${module.source === "built-in" ? t(module.title) : module.title}
                                            ${module.error && html` <span class="warn small">· ${t("failed to load")}</span>`}
                                        </div>
                                        ${module.summary && html`<div class="muted small">${module.source === "built-in" ? t(module.summary) : module.summary}</div>`}
                                        ${
                                            note &&
                                            html`<div class=${`small ${note.warn ? "warn" : "ok"}`}>${note.text}</div>`
                                        }
                                        ${
                                            module.file === "guard.ts" &&
                                            module.enabled &&
                                            html`<${ApprovalRule} owner=${owner} />`
                                        }
                                        ${
                                            module.file === "pip.ts" &&
                                            module.enabled &&
                                            html`<${PipCompactAt} owner=${owner} />`
                                        }
                                        ${
                                            module.file === "guard.ts" &&
                                            module.enabled &&
                                            confirmGuard &&
                                            html`<div
                                                class="guard-confirm"
                                                role="alertdialog"
                                                aria-label=${t("Turn off Lancet Guard?")}
                                                aria-describedby="guard-confirm-warning"
                                                onKeyDown=${(event) => {
                                                    if (
                                                        event.key === "Escape" &&
                                                        !event.isComposing &&
                                                        event.keyCode !== 229
                                                    ) {
                                                        event.preventDefault();
                                                        event.stopPropagation();
                                                        setConfirmGuard(false);
                                                    }
                                                }}
                                            >
                                                <span id="guard-confirm-warning">${t("bash, write, and edit calls will run without checks in every session here. Pi's own setting stays as it is.")}</span>
                                                <div class="sheet-actions">
                                                    <button
                                                        class="button small"
                                                        ref=${guardCancel}
                                                        onClick=${() => setConfirmGuard(false)}
                                                    >
                                                        ${t("Keep it on")}
                                                    </button>
                                                    <button
                                                        class="button small primary"
                                                        disabled=${busy !== null}
                                                        onClick=${() => {
                                                            setConfirmGuard(false);
                                                            change(module, "", { enabled: false });
                                                        }}
                                                    >
                                                        ${t("Turn off")}
                                                    </button>
                                                </div>
                                            </div>`
                                        }
                                        ${module.error && html`<div class="error-box small">${module.error}</div>`}
                                        <${WebPart} module=${module} />
                                        <${GalleryPart}
                                            module=${module}
                                            installed=${installedByFile.get(module.file)}
                                            busy=${busy !== null}
                                            turnOff=${() => change(module, "", { enabled: false })}
                                        />
                                        <div class="muted small mono">
                                            ${module.source === "drop-in" ? `${t("drop-in")}${module.path ? ` · ${shortPath(module.path, store.state.server?.home)}` : ""}` : module.file}
                                            ${tools.length > 0 ? ` · ${t("tools: {{tools}}", { tools: tools.join(", ") })}` : ""}
                                            ${module.required ? ` · ${t("required")}` : ""}
                                        </div>
                                    </div>
                                    <div class="extension-actions">
                                        <${Switch}
                                            on=${module.enabled}
                                            disabled=${!owner || module.required || busy !== null}
                                            label=${t("{{title}}: {{state}}", { title: module.source === "built-in" ? t(module.title) : module.title, state: t(module.enabled ? "on" : "off") })}
                                            onChange=${(event) => toggle(module, event.currentTarget)}
                                        />
                                        ${
                                            owner &&
                                            module.enabled &&
                                            html`<button
                                                class="link small"
                                                disabled=${busy !== null}
                                                onClick=${() => change(module, "/reload", {})}
                                            >
                                                ${t("Reload")}
                                            </button>`
                                        }
                                    </div>
                                </div>`;
                            })}
                        </div>
                    </div>`,
                )
        }
        ${
            data?.dropIns &&
            html`<p class="muted small">
                ${t("Add your own:")} ${t("Put a .ts extension module in")} <span class="mono">${shortPath(data.dropIns, store.state.server?.home)}</span>. ${t("Drop-ins stay off until the owner turns them on, and run inside the server with the owner's rights.")}
            </p>`
        }
    </div>`;
}
