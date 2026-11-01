// The workspace itself: the picker, the toolbar, the modes, and what fills the room under them.
import { openOf } from "./comments.js";
import { createCanvas, frameUrl } from "./canvas.js";
import { designsOf, latestOf, siblingsOf } from "./data.js";
import { clampSize, DEVICES, exportViewport, sizeOf } from "./devices.js";
import { createPicker } from "./picker.js";
import { checkOptions } from "./check.js";
import { checkKey } from "./system-data.js";
import { changed } from "./tweaks.js";
import { resolveDevice, useStore } from "./state.js";
import { unsavedOf } from "./unsaved.js";

/** The sheet's own width classes: below 560 px it stacks; from 900 px the side panel sits beside the canvas. */
const NARROW = 560;
const SIDE = 900;
const STACK = 560;

export function createWorkspace(env) {
    const { pocket, store, data, parts, app } = env;
    const { html, useEffect, useMemo, useRef, useState } = pocket;
    const { Ico, Popover, Segmented, useSize } = parts;
    const canvas = createCanvas(env);
    const { Picker } = createPicker(env);

    // Parts a person may never use: loaded when first needed.
    const LAZY = {
        docks: () => import("./docks.js").then((module) => module.createDocks(env)),
        views: () => import("./views.js").then((module) => module.createViews(env, canvas)),
        system: () => import("./system-ui.js").then((module) => module.createSystemUi(env, canvas)),
    };
    const loaded = {};
    const loading = {};

    /** A lazy part, or null while it loads; it starts loading when `wanted` first is true. */
    function useLazy(name, wanted) {
        const [, draw] = useState(0);

        useEffect(() => {
            if (wanted && loaded[name] === undefined && loading[name] === undefined) {
                loading[name] = LAZY[name]().then(
                    (part) => {
                        loaded[name] = part;
                        draw((count) => count + 1);
                    },
                    (error) => {
                        loading[name] = undefined;
                        pocket.notify(
                            "error",
                            `Design: a part did not load (${error?.message ?? error}).`,
                        );
                    },
                );
            }
        }, [wanted]);

        return loaded[name] ?? null;
    }

    /** Parts of the app's own state this reads: the session's artifacts, who the person is. Redraws only when they change. */
    function useApp() {
        const [, draw] = useState(0);

        useEffect(() => {
            let last = [app.state.view.artifacts, app.state.me, app.state.conversationId];

            return app.subscribe((state) => {
                const next = [state.view.artifacts, state.me, state.conversationId];

                if (next.some((each, index) => each !== last[index])) {
                    last = next;
                    draw((count) => count + 1);
                }
            });
        }, []);

        return app.state;
    }

    /** The designs of the session, with the server's list of their groups and kinds. */
    function useDesigns(appState, s) {
        const ours = appState.conversationId === s.conversation;

        return useMemo(
            () => (ours ? designsOf(appState.view, s.listed) : []),
            [ours, appState.view.artifacts, s.listed],
        );
    }

    // ─── Pop-ups ─────────────────────────────────────────────────────────────

    function CustomSize({ s }) {
        return html`<div class="dsn-custom">
            <label>
                <span>W</span>
                <input
                    type="number"
                    inputmode="numeric"
                    min="200"
                    max="4000"
                    value=${s.custom.w}
                    onChange=${(event) => env.setCustom({ w: clampSize(event.currentTarget.value, s.custom.w) })}
                />
            </label>
            <button
                type="button"
                class="icon-button"
                title="Swap width and height"
                aria-label="Swap width and height"
                onClick=${() => env.setCustom({ w: s.custom.h, h: s.custom.w })}
            >
                <${Ico} name="swap" size=${14} />
            </button>
            <label>
                <span>H</span>
                <input
                    type="number"
                    inputmode="numeric"
                    min="200"
                    max="4000"
                    value=${s.custom.h}
                    onChange=${(event) => env.setCustom({ h: clampSize(event.currentTarget.value, s.custom.h) })}
                />
            </label>
            <span class="muted small">px</span>
        </div>`;
    }

    function MenuItem({ icon, label, hint, onClick, disabled, href, on }) {
        const inner = html`<${Ico} name=${icon} size=${16} /><span class="grow">${label}</span>${
                hint && html`<span class="muted small">${hint}</span>`
            }${on && html`<${Ico} name="check" size=${15} />`}`;

        return href
            ? html`<a
                  class="dsn-menu-item"
                  href=${href}
                  target="_blank"
                  rel="noopener"
                  onClick=${onClick}
                  >${inner}</a
              >`
            : html`<button
                  type="button"
                  class="dsn-menu-item"
                  disabled=${disabled}
                  onClick=${onClick}
              >
                  ${inner}
              </button>`;
    }

    function Menu({ s, device, size, design, shown, group, deck, canShare, canEdit, onClose }) {
        const [busy, setBusy] = useState(null);

        const run = async (format) => {
            setBusy(format);

            await data.download({
                artifact: design.id,
                version: shown,
                format,
                viewport: exportViewport(device, size),
                slide: s.deck?.current,
            });

            setBusy(null);
            onClose();
        };

        const exporting = (format, label, hint) =>
            html`<${MenuItem}
                icon="download"
                label=${busy === format ? `Making the ${label}…` : label}
                hint=${hint}
                disabled=${busy !== null}
                onClick=${() => run(format)}
            />`;

        return html`<${Popover}
            label="More"
            onClose=${onClose}
            align="end"
            sheet=${env.sizeClass(s) === "narrow"}
        >
            <div class="dsn-menu">
                <div class="dsn-menu-label">Backdrop</div>
                <${Segmented}
                    label="Backdrop"
                    value=${s.backdrop}
                    onChange=${env.setBackdrop}
                    options=${[
                        { value: "auto", label: "Theme" },
                        { value: "light", label: "Light", icon: "sun" },
                        { value: "dark", label: "Dark", icon: "moon" },
                    ]}
                />
                <${MenuItem}
                    icon="reload"
                    label="Load the page again"
                    onClick=${() => {
                        env.reloadFrame();
                        onClose();
                    }}
                />
                <${MenuItem}
                    icon="monitor"
                    label="Custom size…"
                    on=${device === "custom"}
                    onClick=${() => {
                        env.setDevice("custom");
                        onClose();
                    }}
                />
                <div class="dsn-menu-label">Design</div>
                <${MenuItem}
                    icon="palette"
                    label="Design system"
                    onClick=${() => {
                        env.openSystem();
                        onClose();
                    }}
                />
                <${MenuItem}
                    icon="compare"
                    label="Compare versions"
                    disabled=${design.versions.length < 2}
                    onClick=${() => {
                        env.compare();
                        onClose();
                    }}
                />
                ${
                    group.length > 1 &&
                    html`<${MenuItem}
                        icon="grid"
                        label="Variations"
                        hint=${`${group.length}`}
                        onClick=${() => {
                            env.setView("grid");
                            onClose();
                        }}
                    />`
                }
                ${
                    deck &&
                    html`<${MenuItem}
                        icon="play"
                        label="Present"
                        onClick=${() => {
                            store.set({ present: true });
                            onClose();
                        }}
                    />`
                }
                <div class="dsn-menu-label">${canEdit ? "Export and share" : "Open"}</div>
                ${canEdit && exporting("png", "PNG image", `v${shown}`)}
                ${canEdit && exporting("pdf", "PDF", `v${shown}`)}
                ${
                    canEdit &&
                    deck &&
                    exporting("pptx", "PowerPoint (PPTX)", `${s.deck?.slides ?? ""} slides`)
                }
                ${canEdit && exporting("html", "HTML bundle (zip)", "for code")}
                ${
                    canShare &&
                    html`<${MenuItem}
                        icon="share"
                        label="Share a link…"
                        onClick=${() => {
                            onClose();
                            env.share(design.id, shown);
                        }}
                    />`
                }
                <${MenuItem}
                    icon="external"
                    label="Open in its own tab"
                    href=${frameUrl(s.conversation, design.id, shown)}
                    onClick=${onClose}
                />
            </div>
        <//>`;
    }

    // ─── The toolbar ─────────────────────────────────────────────────────────

    function Bar({
        s,
        device,
        size,
        designs,
        design,
        shown,
        latest,
        group,
        deck,
        canShare,
        canEdit,
    }) {
        const [open, setOpen] = useState(null);
        const narrow = env.sizeClass(s) === "narrow";
        const devices = [
            { value: "mobile", icon: DEVICES.mobile.icon, title: "Phone, 390 × 844" },
            { value: "tablet", icon: DEVICES.tablet.icon, title: "Tablet, 820 × 1180" },
            deck
                ? { value: "slide", icon: "monitor", title: "Slide, 1280 × 720" }
                : { value: "desktop", icon: DEVICES.desktop.icon, title: "Desktop, 1280 × 800" },
            ...(narrow ? [] : [{ value: "custom", icon: "fit", title: "Custom size" }]),
        ];
        const open_ = openOf(s.notes[design.id]?.comments ?? []).length;
        const edits = (s.edits[`${design.id}@${shown}`] ?? []).length;
        const moved = changed(s.knobs, s.tweaks[design.id] ?? {}).length;
        const check = checkOptions(s, env.canvasDark(s));
        const report = s.checks[checkKey(design.id, shown, check.mode, check.size)]?.report;
        const found = report ? report.summary.errors + report.summary.warnings : 0;
        const tabs = [
            { id: "view", label: "Preview", icon: "eye" },
            {
                id: "comment",
                label: canEdit ? "Comment" : "Comments",
                icon: "comment",
                badge: open_,
            },
            ...(canEdit ? [{ id: "edit", label: "Edit text", icon: "text", badge: edits }] : []),
            ...(canEdit ? [{ id: "tweaks", label: "Tweaks", icon: "sliders", badge: moved }] : []),
            ...(canEdit ? [{ id: "check", label: "Check", icon: "shield", badge: found }] : []),
            { id: "versions", label: "Versions", icon: "history", badge: design.versions.length },
        ];
        const active =
            s.mode === "comment"
                ? "comment"
                : s.mode === "edit"
                  ? "edit"
                  : s.dock === "comments"
                    ? "comment"
                    : s.dock === "tweaks"
                      ? "tweaks"
                      : s.dock === "check"
                        ? "check"
                        : s.dock === "versions"
                          ? "versions"
                          : "view";

        return html`<div class="dsn-bars">
            <div class="dsn-bar">
                <button
                    type="button"
                    class="dsn-picker"
                    aria-haspopup="dialog"
                    onClick=${() => setOpen("designs")}
                >
                    <${Ico} name="design" size=${16} />
                    <span class="dsn-picker-title">${design.title}</span>
                    <span class=${`dsn-version-tag mono ${shown !== latest ? "old" : ""}`}
                        >v${shown}</span
                    >
                    <${Ico} name="down" size=${14} />
                </button>
                <${Segmented}
                    label="Size"
                    iconOnly=${true}
                    value=${device}
                    options=${devices.map((device) => ({ ...device, label: device.title }))}
                    onChange=${env.setDevice}
                />
                ${
                    env.beside() &&
                    html`<button
                        type="button"
                        class=${`icon-button ${s.focus ? "on" : ""}`}
                        title=${s.focus ? "Show the conversation" : "Hide the conversation"}
                        aria-label=${s.focus ? "Show the conversation" : "Hide the conversation"}
                        aria-pressed=${s.focus}
                        onClick=${env.toggleFocus}
                    >
                        <${Ico} name=${s.focus ? "unfocus" : "focus"} size=${17} />
                    </button>`
                }
                <button
                    type="button"
                    class="icon-button"
                    title="More"
                    aria-label="More"
                    aria-haspopup="dialog"
                    onClick=${() => setOpen("more")}
                >
                    <${Ico} name="more" size=${18} />
                </button>
            </div>
            ${device === "custom" && html`<${CustomSize} s=${s} />`}
            <div class="dsn-tabs" role="group" aria-label="Mode">
                ${tabs.map(
                    (tab) =>
                        html`<button
                            type="button"
                            key=${tab.id}
                            class=${`dsn-tab ${active === tab.id ? "on" : ""}`}
                            aria-pressed=${active === tab.id}
                            aria-label=${tab.label}
                            title=${tab.label}
                            onClick=${() => env.setTab(tab.id)}
                        >
                            <${Ico} name=${tab.icon} size=${16} />
                            <span class="dsn-tab-label">${tab.label}</span>
                            ${tab.badge > 0 && html`<span class="dsn-count">${tab.badge}</span>`}
                        </button>`,
                )}
                <span class="grow"></span>
                ${
                    design.versions.length > 1 &&
                    html`<button
                        type="button"
                        class=${`icon-button ${s.view === "compare" ? "on" : ""}`}
                        title="Compare versions"
                        aria-label="Compare versions"
                        aria-pressed=${s.view === "compare"}
                        onClick=${() => (s.view === "compare" ? env.setView("canvas") : env.compare())}
                    >
                        <${Ico} name="compare" size=${16} />
                    </button>`
                }
                ${
                    group.length > 1 &&
                    html`<button
                        type="button"
                        class=${`icon-button ${s.view === "grid" ? "on" : ""}`}
                        title=${`Variations (${group.length})`}
                        aria-label=${`Variations, ${group.length}`}
                        aria-pressed=${s.view === "grid"}
                        onClick=${() => env.setView(s.view === "grid" ? "canvas" : "grid")}
                    >
                        <${Ico} name="grid" size=${16} />
                    </button>`
                }
                ${
                    deck &&
                    html`<button
                        type="button"
                        class="icon-button"
                        title="Present"
                        aria-label="Present"
                        onClick=${() => store.set({ present: true })}
                    >
                        <${Ico} name="play" size=${16} />
                    </button>`
                }
            </div>
            ${
                open === "designs" &&
                html`<${Picker}
                    s=${s}
                    designs=${designs}
                    design=${design}
                    onClose=${() => setOpen(null)}
                />`
            }
            ${
                open === "more" &&
                html`<${Menu}
                    s=${s}
                    device=${device}
                    size=${size}
                    design=${design}
                    shown=${shown}
                    group=${group}
                    deck=${deck}
                    canShare=${canShare}
                    canEdit=${canEdit}
                    onClose=${() => setOpen(null)}
                />`
            }
        </div>`;
    }

    // ─── The whole ───────────────────────────────────────────────────────────

    function Empty({ canEdit }) {
        const ideas = [
            "Design a landing page for a small coffee roaster. Make it a single page with a hero, three products, and a signup form.",
            "Make a clickable prototype of a habit tracker app: today, history, and settings screens.",
            "Make a 6-slide deck that pitches a weekend project, with a title, problem, solution, demo, and next steps.",
        ];

        return html`<div class="dsn-empty-state">
            <${Ico} name="design" size=${34} />
            <h3>No designs yet</h3>
            <p class="muted">
                Ask Pi to design something: a prototype, a screen, a one-pager, or a slide deck. It
                shows up here, where you can point at things, comment, tweak, and compare versions.
            </p>
            ${
                canEdit &&
                html`<div class="dsn-ideas">
                    ${ideas.map(
                        (idea) =>
                            html`<button
                                type="button"
                                class="dsn-idea"
                                onClick=${() => env.sendToBox(idea)}
                            >
                                ${idea}
                            </button>`,
                    )}
                </div>`
            }
            <button type="button" class="dsn-link dsy-empty-system" onClick=${env.openSystem}>
                <${Ico} name="palette" size=${15} /> The design system
            </button>
        </div>`;
    }

    function Workspace() {
        const s = useStore(pocket, store);
        const appState = useApp();
        const root = useRef(null);
        const { w: width } = useSize(root);
        const designs = useDesigns(appState, s);
        const design = designs.find((each) => each.id === s.artifact) ?? null;
        const docks = useLazy("docks", s.dock !== null);
        const views = useLazy(
            "views",
            s.view === "compare" ||
                s.view === "grid" ||
                s.present ||
                s.deck !== null ||
                design?.kind === "deck",
        );
        const system = useLazy("system", s.view === "system");
        const me = appState.me;
        const canEdit = me?.role !== undefined && me.role !== "viewer";
        const canShare = canEdit && me?.sessions === undefined;
        const seen = useRef(null);
        const seenFor = useRef(null);
        const lastLatest = useRef({ id: null, version: 0 });

        // The width classes, for the bars, the dock, and the compare view.
        useEffect(() => {
            if (width > 0 && Math.abs(width - (store.get().width ?? 0)) >= 1) {
                store.set({ width });
            }
        }, [width]);

        // Which design is open: one asked for, else the one before, else the newest. A design that is new while the panel is
        // open comes forward, unless the person is in the middle of something.
        useEffect(() => {
            if (s.conversation === null) {
                return;
            }

            if (s.wanted?.system) {
                store.set({ wanted: null });
                env.openSystem();

                return;
            }

            if (s.wanted) {
                const found = env.find(designs, s.wanted.artifact);

                if (found) {
                    env.open(found.id, s.wanted.version ?? null);
                    store.set({ wanted: null });

                    return;
                }

                if (s.listed !== null) {
                    store.set({ wanted: null });
                    pocket.notify("info", `No design matches “${s.wanted.artifact}”.`);
                }

                return;
            }

            const ids = designs.map((each) => each.id);

            // The designs a session had when it opened are not new ones; only those after it are.
            if (seenFor.current !== s.conversation) {
                seenFor.current = s.conversation;
                seen.current = null;
            }

            if (seen.current === null && designs.length > 0) {
                seen.current = new Set(ids);
            }

            const added = seen.current === null ? [] : ids.filter((id) => !seen.current.has(id));

            for (const id of added) {
                seen.current.add(id);
            }

            if (design === null && designs.length > 0) {
                if (s.view === "system") {
                    store.set({ artifact: designs[0].id, version: null });
                } else {
                    env.open(designs[0].id);
                }
            } else if (
                added.length > 0 &&
                design !== null &&
                s.mode === "view" &&
                s.draft === null &&
                s.view === "canvas" &&
                !(s.edits[`${design.id}@${latestOf(design)}`]?.length > 0)
            ) {
                const fresh = designs.find((each) => each.id === added[0]);

                // Variations of what is open are for the grid, not for the canvas to jump to.
                if (fresh && !(fresh.group && fresh.group === design.group)) {
                    env.open(fresh.id);
                }
            }
        }, [designs, s.wanted, s.conversation]);

        // Its comments and this person's tweaks, whenever the open design changes.
        useEffect(() => {
            if (s.artifact !== null) {
                void data.notes(s.artifact);
            }
        }, [s.artifact, s.conversation]);

        useEffect(() => {
            if (s.conversation !== null && s.system.status === "idle") {
                void env.systemData.load({ quiet: true });
            }
        }, [s.conversation]);

        // A deck is shown at slide size by default, and a page is never shown at it.
        const deck = design?.kind === "deck" || s.deck !== null;
        const chosen = resolveDevice(s.device, store.get().width || width);
        const device =
            deck && chosen === "desktop"
                ? "slide"
                : !deck && chosen === "slide"
                  ? "desktop"
                  : chosen;
        const size = sizeOf(device, s.custom);
        const latest = design ? latestOf(design) : 1;
        const shown = design
            ? design.versions.some((each) => each.version === s.version)
                ? s.version
                : latest
            : 1;
        const group = design ? siblingsOf(designs, design) : [];
        const unsaved = unsavedOf(s.system.data, s.history);

        // Pi makes a new version while the person is in the middle of something (a mode, a draft, text edits): the page they
        // work on stays, with the way to the new one, instead of loading under them.
        useEffect(() => {
            const before = lastLatest.current;

            lastLatest.current = { id: design?.id ?? null, version: latest };

            if (
                design &&
                before.id === design.id &&
                latest > before.version &&
                s.version === null &&
                s.view === "canvas" &&
                (s.mode !== "view" ||
                    s.draft !== null ||
                    s.edits[`${design.id}@${before.version}`]?.length > 0)
            ) {
                store.set({ version: before.version });
            }
        }, [design?.id, latest]);
        // Beside the canvas on a wide panel, or a narrower one that shows a tall page (a phone or a tablet): under it otherwise.
        const room = store.get().width || width;
        const side = room >= SIDE || (room >= STACK && size.h > size.w);

        if (s.conversation === null) {
            return html`<div class="dsn" ref=${root}>
                <${pocket.Loader} label="Opening Design" />
            </div>`;
        }

        if (s.view === "system" && system === null) {
            return html`<div
                class="dsn dsy"
                ref=${root}
                data-size=${env.sizeClass(s)}
                data-view="system"
            >
                <${pocket.Loader} label="Opening the design system" />
            </div>`;
        }

        if (s.view === "system") {
            return html`<div
                class="dsn dsy"
                ref=${root}
                data-size=${env.sizeClass(s)}
                data-view="system"
                data-focus=${s.focus}
            >
                <${system.SystemBar}
                    s=${s}
                    designs=${designs}
                    design=${design}
                    shown=${shown}
                    room=${room}
                    canEdit=${canEdit}
                    Picker=${Picker}
                />
                <${system.SystemView}
                    s=${s}
                    designs=${designs}
                    design=${design}
                    shown=${shown}
                    size=${size}
                    room=${room}
                    canEdit=${canEdit}
                />
            </div>`;
        }

        if (!design) {
            return html`<div class="dsn" ref=${root} data-size=${env.sizeClass(s)}>
                ${s.listed === null && appState.view.artifacts?.length > 0 ? html`<${pocket.Loader} label="Reading the designs" />` : html`<${Empty} canEdit=${canEdit} />`}
            </div>`;
        }

        const wantsViews =
            (s.view === "compare" && design.versions.length > 1) ||
            (s.view === "grid" && group.length > 1);
        const view =
            wantsViews && views === null
                ? html`<${pocket.Loader} label="Opening the versions" />`
                : s.view === "compare" && design.versions.length > 1
                  ? html`<${views.CompareView} s=${s} design=${design} size=${size} />`
                  : s.view === "grid" && group.length > 1
                    ? html`<${views.GridView}
                          s=${s}
                          design=${design}
                          designs=${designs}
                          size=${size}
                          canEdit=${canEdit}
                      />`
                    : html`<${canvas.CanvasView}
                          s=${s}
                          design=${design}
                          version=${shown}
                          size=${size}
                          readOnly=${!canEdit}
                      />`;

        return html`<div
            class="dsn"
            ref=${root}
            data-size=${env.sizeClass(s)}
            data-side=${side}
            data-dock=${s.dock ?? "none"}
        >
            <${Bar}
                s=${s}
                device=${device}
                size=${size}
                designs=${designs}
                design=${design}
                shown=${shown}
                latest=${latest}
                group=${group}
                deck=${deck}
                canShare=${canShare}
                canEdit=${canEdit}
            />
            ${
                shown !== latest &&
                s.view === "canvas" &&
                html`<div class="dsn-old">
                    ${`Version ${shown} of ${latest}. `}
                    <button type="button" class="dsn-link" onClick=${() => env.showVersion(null)}>
                        Show the newest
                    </button>
                </div>`
            }
            ${
                unsaved > 0 &&
                s.view === "canvas" &&
                html`<div class="dsn-old dsy-unsaved">
                    ${`The design system has ${unsaved} unsaved change${unsaved === 1 ? "" : "s"}, shown here. `}
                    <button type="button" class="dsn-link" onClick=${env.openSystem}>
                        Open the system
                    </button>
                </div>`
            }
            <div class="dsn-main">
                <div class="dsn-center">
                    ${s.present ? null : view}
                    ${s.view === "canvas" && !s.present && deck && views && html`<${views.DeckStrip} s=${s} />`}
                </div>
                ${
                    docks
                        ? html`<${docks.Dock}
                              s=${s}
                              design=${design}
                              shown=${shown}
                              canEdit=${canEdit}
                              me=${me}
                          />`
                        : s.dock !== null &&
                          html`<aside class="dsn-dock" data-dock=${s.dock}>
                              <${pocket.Loader} label="Opening" />
                          </aside>`
                }
            </div>
            ${s.present && views && html`<${views.Present} s=${s} design=${design} version=${shown} />`}
        </div>`;
    }

    return { Workspace };
}
