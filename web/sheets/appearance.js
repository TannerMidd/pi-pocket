// Appearance: the theme and the colors, and how the app looks and moves.
import { useEffect, useRef, useState } from "preact/hooks";
import {
    actions,
    api,
    attempt,
    closeSheet,
    drafts,
    navigate,
    notify,
    openSheet,
    store,
} from "../store.js";
import {
    BASE_LOOK,
    chooseLook,
    chooseTheme,
    colorsOnly,
    folderPaletteIds,
    lookIds,
    paletteOf,
    prefs,
    preview,
    setPrefs,
    themeDefault,
    themeIds,
    themeVars,
    varsStyle,
} from "../theme.js";
import { arranged, move, resetSlot, setShown, SLOTS } from "../slots.js";
import { html, Icon, Sheet, Switch } from "../ui.js";
import { galleryAvailable } from "./gallery.js";

// Key hints are for people with a keyboard: a touch screen has none.
const touch = matchMedia("(pointer: coarse)").matches;

/** A theme as a card: a tiny Hyprland desktop drawn in its own colors. */
function ThemeCard({ id, desktop = false }) {
    const palette = paletteOf(id);
    const vars = varsStyle(themeVars(palette));
    // "Desktop" on a server without an Omarchy desktop shows Tokyo Night.
    const on =
        prefs().theme === id ||
        (id === "tokyo-night" && prefs().theme === "desktop" && !store.state.desktopTheme);
    const dots = ["--o-red", "--o-yellow", "--o-green", "--o-cyan", "--o-blue", "--o-magenta"];
    const desk = html`<div class="tc-desk">
        <div class="tc-win"><i></i><i></i><i class="lit"></i></div>
        <div class="tc-win"><i></i><i></i><i class="lit"></i></div>
    </div>`;
    const name = html`<div class="tc-name">
        ${desktop ? `Desktop · ${palette.name}` : palette.name}
        ${palette.pair ? html`<small>light and dark</small>` : palette.colors.mode === "light" && html`<small>light</small>`}
    </div>`;

    return html`<button
        class=${`theme-card ${on ? "on" : ""} ${desktop ? "theme-desktop" : ""}`}
        aria-pressed=${on}
        style=${vars}
        title=${desktop ? "Follow the Omarchy theme of the machine Pi Pocket runs on" : palette.name}
        onMouseEnter=${() => matchMedia("(hover: hover)").matches && preview(id)}
        onMouseLeave=${() => preview(null)}
        onFocus=${() => preview(id)}
        onBlur=${() => preview(null)}
        onClick=${(event) => chooseTheme(id, event)}
    >
        ${desk}
        ${
            desktop
                ? html`<div class="tc-text">
                    ${name}
                    <div class="tc-note">
                        Follows your desktop: change the Omarchy theme and Pi Pocket changes with it.
                    </div>
                    <div class="tc-dots">
                        ${dots.map((dot) => html`<i style=${`background:var(${dot})`}></i>`)}
                    </div>
                </div>`
                : html`${name}
                <div class="tc-dots">
                    ${dots.map((dot) => html`<i style=${`background:var(${dot})`}></i>`)}
                </div>`
        }
    </button>`;
}

/** A theme folder as the server lists it, or the app's own look. */
const lookInfo = (id) =>
    store.state.themeList?.find((each) => each.id === id) ??
    (id === BASE_LOOK ? { id, name: "Pocket", builtIn: true, usable: true, css: [] } : undefined);

/** A theme as a card: its name, what it says it is, and why it cannot be used, if it cannot. */
function LookCard({ id }) {
    const look = lookInfo(id);
    const on = (prefs().look ?? BASE_LOOK) === id;

    if (!look) {
        return null;
    }

    return html`<button
        class=${`look-card ${on ? "on" : ""} ${look.usable ? "" : "broken"}`}
        aria-pressed=${on}
        disabled=${!look.usable}
        onClick=${(event) => chooseLook(id, event)}
    >
        <span class="look-name">
            ${look.name}
            ${look.builtIn && html`<small>built in</small>`}
            ${look.colors && html`<small>own colors</small>`}
        </span>
        ${look.description && html`<span class="look-detail">${look.description}</span>`}
        ${look.problem && html`<span class="look-problem">${look.problem}</span>`}
    </button>`;
}

/** Settles once the server's list of themes has `id` in it, or after two seconds. */
function listed(id) {
    return new Promise((resolve) => {
        const done = () => {
            clearTimeout(timer);
            stop();
            resolve();
        };

        const timer = setTimeout(done, 2000);
        const stop = store.subscribe((state) => {
            if (state.themeList?.some((each) => each.id === id)) {
                done();
            }
        });

        if (store.state.themeList?.some((each) => each.id === id)) {
            done();
        }
    });
}

/** Ask for a new theme's name, and make it from `from`: its id, or a palette's. */
function Duplicate({ from, label, colors = false, onDone }) {
    const [name, setName] = useState(`My ${label}`);
    const [busy, setBusy] = useState(false);
    const field = useRef(null);

    // Ready to type a name each time (`autofocus` works once a page load), where a keyboard is at hand: on a touch
    // screen, one would pop up over the sheet.
    useEffect(() => {
        if (!matchMedia("(pointer: coarse)").matches) {
            field.current?.focus();
            field.current?.select();
        }
    }, []);

    const make = async (event) => {
        event.preventDefault();
        setBusy(true);
        const made = await attempt(() => api("themes/duplicate", { from, name, colors }));

        setBusy(false);

        if (made) {
            // The server lists it a moment after it answers: choose it once this tab has heard.
            await listed(made.id);
            notify(
                "info",
                `Made “${name}”: its folder is in the data folder's themes/. Edit with Pi changes it.`,
            );
            onDone(made.id);
        }
    };

    return html`<form class="look-duplicate" onSubmit=${make}>
        <input
            ref=${field}
            value=${name}
            aria-label="The new theme's name"
            maxlength="60"
            onInput=${(event) => setName(event.currentTarget.value)}
        />
        <button class="button primary" disabled=${busy || name.trim() === ""}>Make</button>
        <button class="button ghost" type="button" onClick=${() => onDone(null)}>Cancel</button>
    </form>`;
}

/** Start a session in one of the owner's themes, with a message that says where its guide is. */
async function editWithPi(id) {
    const { cwd, draft } = await api(`themes/${encodeURIComponent(id)}/edit`);
    const { id: conversationId } = await actions.createSession(cwd);

    drafts.set(conversationId, draft);
    closeSheet();
    navigate(conversationId);
}

/** The owner's tools for the theme in use: copy it, change it with Pi, or remove it. */
function LookTools() {
    const [naming, setNaming] = useState(false);
    const id = prefs().look ?? BASE_LOOK;
    const look = lookInfo(id);

    if (naming) {
        return html`<${Duplicate}
            from=${id}
            label=${look?.name ?? "theme"}
            onDone=${(made) => {
                setNaming(false);

                if (made) {
                    chooseLook(made);
                }
            }}
        />`;
    }

    const remove = () =>
        confirm(
            `Remove the theme “${look.name}”?\n\nIts folder moves to themes/.removed/ in the data folder, so you can get it back from there.`,
        ) &&
        attempt(async () => {
            await api(`themes/${encodeURIComponent(id)}`, undefined, { method: "DELETE" });
            setPrefs({ look: BASE_LOOK });
        });

    return html`<div class="look-tools">
        <button class="button" disabled=${!look?.usable} onClick=${() => setNaming(true)}>
            <${Icon} name="copy" size=${14} /> Duplicate
        </button>
        ${
            look && !look.builtIn
                ? html`<button class="button" onClick=${() => attempt(() => editWithPi(id))}>
                        <${Icon} name="sparkle" size=${14} /> Edit with Pi
                    </button>
                    ${
                        galleryAvailable() &&
                        html`<button
                            class="button"
                            onClick=${() => openSheet({ type: "gallery-share", id, theme: true })}
                        >
                            Share…
                        </button>`
                    }
                    <button class="button ghost" onClick=${remove}>Remove</button>`
                : html`<span class="muted small">Duplicate it to make a theme of your own.</span>`
        }
    </div>`;
}

/**
 * The owner's tools for the colors in use: a copy of them as a theme folder of colors, and for colors of their own, Edit
 * with Pi and Remove.
 */
function ColorsTools() {
    const [naming, setNaming] = useState(false);
    const id = prefs().theme;
    const palette = paletteOf(id);
    // The owner's own folder of colors alone (a theme with colors of its own has these in the Theme row).
    const own = palette.folder
        ? store.state.themeList?.find(
              (each) => each.id === palette.id.split("@")[0] && colorsOnly(each) && !each.builtIn,
          )
        : undefined;

    if (naming) {
        return html`<${Duplicate}
            from=${palette.id}
            label=${palette.name}
            colors=${true}
            onDone=${(made) => {
                setNaming(false);

                if (made) {
                    chooseTheme(made);
                }
            }}
        />`;
    }

    const remove = () =>
        confirm(
            `Remove the colors “${own.name}”?\n\nTheir folder moves to themes/.removed/ in the data folder, so you can get them back from there.`,
        ) &&
        attempt(async () => {
            await api(`themes/${encodeURIComponent(own.id)}`, undefined, { method: "DELETE" });
            setPrefs({ theme: "desktop" });
        });

    return html`<div class="look-tools">
        <button class="button" onClick=${() => setNaming(true)}>
            <${Icon} name="copy" size=${14} /> Duplicate colors
        </button>
        ${
            own &&
            html`<button class="button" onClick=${() => attempt(() => editWithPi(own.id))}>
                    <${Icon} name="sparkle" size=${14} /> Edit with Pi
                </button>
                <button class="button ghost" onClick=${remove}>Remove</button>`
        }
    </div>`;
}

/**
 * The owner's default: the theme and colors of every browser whose person has not chosen their own, guests' included.
 * It takes the ones in use here.
 */
function DefaultTools() {
    const current = themeDefault();
    const p = prefs();
    // The theme and colors in use as the server knows them, as Appearance shows them: a theme that is gone or broken
    // shows Pocket, and "desktop" colors only where there is a desktop's.
    const look = store.state.themeList?.some((each) => each.id === p.look && each.usable)
        ? p.look
        : BASE_LOOK;
    const colors = paletteOf(p.theme).id;
    // What new browsers get already: the default, or with none, Pocket and the desktop's colors.
    const same = current
        ? current.look === look && current.colors === colors
        : look === BASE_LOOK && p.theme === "desktop";
    // A theme with its own colors is named once: "My Lantern", not "My Lantern with My Lantern". The desktop's colors
    // are Tokyo Night where the server has no desktop.
    const name = (look, colors) =>
        colors.split("@")[0] === look
            ? (lookInfo(look)?.name ?? look)
            : `${lookInfo(look)?.name ?? look} with ${paletteOf(colors).desktop ? "the desktop's colors" : paletteOf(colors).name}`;
    const set = (value) =>
        attempt(async () => {
            await api("themes/default", { default: value }, { method: "PUT" });
            notify(
                "info",
                value
                    ? `Browsers that have not chosen start with ${name(value.look, value.colors)}.`
                    : "Browsers that have not chosen start with Pocket.",
            );
        });

    return html`<div class="look-tools">
        <span class="muted small grow">
            ${current ? `For new browsers: ${name(current.look, current.colors)}.` : `New browsers start with ${name(BASE_LOOK, "desktop")}.`}
        </span>
        ${
            !same &&
            html`<button class="button" onClick=${() => set({ look, colors })}>
                Use these for new browsers
            </button>`
        }
        ${current && html`<button class="button ghost" onClick=${() => set(null)}>Reset</button>`}
    </div>`;
}

/** A new density, with the choice tapped kept where it was: the rows above it grow or shrink with the change. */
function chooseDensity(density, event) {
    const button = event.currentTarget;
    const before = button.getBoundingClientRect().top;

    setPrefs({ density });
    requestAnimationFrame(() => {
        const body = button.closest(".sheet-body");

        if (body) {
            body.scrollTop += button.getBoundingClientRect().top - before;
        }
    });
}

function SettingRow({ title, detail, children }) {
    return html`<div class="setting-row">
        <div class="setting-text">
            <span>${title}</span>
            ${detail && html`<span>${detail}</span>`}
        </div>
        ${children}
    </div>`;
}

/**
 * One slot's items, as Layout lists them: each with a switch to show or hide it and arrows to move it, the app's own and
 * extensions' alike. Fixed ones (the menu, Lancet Guard) always show, in their place. Saved in this browser.
 */
function SlotLayout({ slot }) {
    const list = arranged(slot);
    const movable = list.filter(({ item }) => !item.fixed).map(({ item }) => item.id);
    const changed = Object.keys(prefs().layout?.[slot] ?? {}).length > 0;

    return html`<div class="label slot-label">
            <span>${SLOTS[slot].label}</span>
            ${
                changed &&
                html`<button class="button ghost small" onClick=${() => resetSlot(slot)}>
                    Reset
                </button>`
            }
        </div>
        <div class="sheet-list slot-layout" data-slot=${slot}>
            ${list.map(({ item, hidden, hiddenBy }) => {
                const at = movable.indexOf(item.id);
                const detail = [
                    item.module && `From ${item.module}`,
                    hiddenBy && `Hidden by ${hiddenBy}`,
                    item.fixed && "Always shown",
                ]
                    .filter(Boolean)
                    .join(" · ");

                return html`<${SettingRow} key=${item.id} title=${item.label} detail=${detail}>
                    ${
                        !item.fixed &&
                        html`<div class="slot-moves">
                            <button
                                class="icon-button"
                                aria-label=${`Move ${item.label} earlier`}
                                disabled=${at <= 0}
                                onClick=${() => move(slot, item.id, -1)}
                            >
                                <${Icon} name="chevron" size=${16} class="slot-earlier" />
                            </button>
                            <button
                                class="icon-button"
                                aria-label=${`Move ${item.label} later`}
                                disabled=${at === movable.length - 1}
                                onClick=${() => move(slot, item.id, 1)}
                            >
                                <${Icon} name="chevron" size=${16} />
                            </button>
                        </div>
                        <${Switch}
                            on=${!hidden}
                            label=${`Show ${item.label}`}
                            onChange=${() => setShown(slot, item.id, hidden)}
                        />`
                    }
                <//>`;
            })}
        </div>`;
}

export function AppearanceSheet() {
    const p = prefs();
    const desktop = store.state.desktopTheme;

    useEffect(() => () => preview(null), []);

    return html`<${Sheet} title="Appearance" onClose=${closeSheet} wide=${true}>
        <div class="label">Theme</div>
        <div class="look-grid">
            ${lookIds().map((id) => html`<${LookCard} key=${id} id=${id} />`)}
        </div>
        ${store.state.me?.role === "owner" && html`<${LookTools} />`}
        <div class="label">Colors</div>
        <div class="theme-grid">
            ${desktop && html`<${ThemeCard} id="desktop" desktop=${true} />`}
            ${[...themeIds(), ...folderPaletteIds()].map(
                (id) => html`<${ThemeCard} key=${id} id=${id} />`,
            )}
        </div>
        ${store.state.me?.role === "owner" && html`<${ColorsTools} />`}
        ${store.state.me?.role === "owner" && html`<${DefaultTools} />`}
        ${
            !desktop &&
            html`<p class="muted small">
                Running Pi Pocket on an Omarchy desktop adds “Desktop”: the app follows the theme the desktop uses.
            </p>`
        }
        <div class="label">Layout and motion</div>
        <div class="sheet-list">
            <${SettingRow}
                title="Tiled windows"
                detail="Wide screens: the sidebar and the session as Hyprland windows, with gaps and the active border"
            >
                <${Switch}
                    on=${p.tiling}
                    label="Tiled windows"
                    onChange=${() => setPrefs({ tiling: !p.tiling })}
                />
            <//>
            <${SettingRow}
                title="Peek tiles"
                detail=${`Other sessions beside this one, live while on screen: working, waiting for you, done since you looked, and pinned. Also the tiles button in the top bar${touch ? "" : ", or Alt+P"}`}
            >
                <${Switch}
                    on=${p.peeks}
                    label="Peek tiles"
                    onChange=${() => setPrefs({ peeks: !p.peeks })}
                />
            <//>
            ${
                desktop?.wallpaper &&
                html`<${SettingRow}
                    title="Desktop wallpaper"
                    detail="Your wallpaper in the gaps between windows, while following the desktop"
                >
                    <${Switch}
                        on=${p.wallpaper}
                        disabled=${!p.tiling || p.theme !== "desktop"}
                        label="Desktop wallpaper"
                        onChange=${() => setPrefs({ wallpaper: !p.wallpaper })}
                    />
                <//>`
            }
            <${SettingRow}
                title="Sidebar"
                detail="Folded, it shows numbered sessions like workspaces"
            >
                <div class="segmented">
                    ${[
                        ["open", "Open"],
                        ["rail", "Folded"],
                    ].map(
                        ([value, label]) =>
                            html`<button
                                class=${p.sidebar === value ? "on" : ""}
                                aria-pressed=${p.sidebar === value}
                                onClick=${() => setPrefs({ sidebar: value })}
                            >
                                ${label}
                            </button>`,
                    )}
                </div>
            <//>
            <${SettingRow}
                title="Motion"
                detail="Auto follows your system's reduced-motion setting"
            >
                <div class="segmented">
                    ${[
                        ["auto", "Auto"],
                        ["full", "Full"],
                        ["reduced", "Reduced"],
                    ].map(
                        ([value, label]) =>
                            html`<button
                                class=${p.motion === value ? "on" : ""}
                                aria-pressed=${p.motion === value}
                                onClick=${() => setPrefs({ motion: value })}
                            >
                                ${label}
                            </button>`,
                    )}
                </div>
            <//>
            <${SettingRow} title="Text size">
                <div class="segmented">
                    ${[13, 14, 15, 16, 17].map(
                        (size) => html`<button
                            class=${p.text === size ? "on" : ""}
                            aria-pressed=${p.text === size}
                            onClick=${() => setPrefs({ text: size })}
                        >
                            ${size}
                        </button>`,
                    )}
                </div>
            <//>
            <${SettingRow}
                title="Width"
                detail="Wide screens: how much of the window the conversation and the message box take. Comfortable grows with the window"
            >
                <div class="segmented">
                    ${[
                        ["comfortable", "Comfortable"],
                        ["wide", "Wide"],
                        ["full", "Full"],
                    ].map(
                        ([value, label]) =>
                            html`<button
                                class=${(p.width ?? "comfortable") === value ? "on" : ""}
                                aria-pressed=${(p.width ?? "comfortable") === value}
                                onClick=${() => setPrefs({ width: value })}
                            >
                                ${label}
                            </button>`,
                    )}
                </div>
            <//>
            <${SettingRow}
                title="Density"
                detail="Less room around messages, rows, and the message box, to fit more on a screen"
            >
                <div class="segmented">
                    ${[
                        ["comfortable", "Comfortable"],
                        ["compact", "Compact"],
                        ["tight", "Tight"],
                    ].map(
                        ([value, label]) =>
                            html`<button
                                class=${p.density === value ? "on" : ""}
                                aria-pressed=${p.density === value}
                                onClick=${(event) => chooseDensity(value, event)}
                            >
                                ${label}
                            </button>`,
                    )}
                </div>
            <//>
        </div>
        <div class="label">Conversation</div>
        <div class="sheet-list">
            <${SettingRow}
                title="Show thinking"
                detail=${`Shows Pi's current thought above the live line as it comes, and its finished thoughts. The chevron before the line folds the live one${touch ? "" : ". Also Alt+T"}`}
            >
                <${Switch}
                    on=${p.showThinking}
                    label="Show thinking"
                    onChange=${() => setPrefs({ showThinking: !p.showThinking })}
                />
            <//>
        </div>
        <div class="label">Status line</div>
        <div class="sheet-list">
            <${SettingRow}
                title="Reply speed"
                detail="Under the message box: how fast the last answer came, in tokens a second, and how long its first token took"
            >
                <${Switch}
                    on=${p.speed}
                    label="Reply speed"
                    onChange=${() => setPrefs({ speed: !p.speed })}
                />
            <//>
        </div>
        ${Object.keys(SLOTS).map((slot) => html`<${SlotLayout} key=${slot} slot=${slot} />`)}
        ${
            !touch &&
            html`<button
                class="button ghost wide sheet-footer"
                onClick=${() => openSheet({ type: "shortcuts" })}
            >
                <${Icon} name="keyboard" size=${16} /> Keyboard shortcuts
            </button>`
        }
    <//>`;
}
