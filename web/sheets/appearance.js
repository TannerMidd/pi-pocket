import { t } from "../i18n.js";
// Appearance: themes, and how the app looks and moves.
import { closeSheet, openSheet, store } from "../store.js";
import {
    chooseTheme,
    paletteOf,
    prefs,
    setPrefs,
    themeIds,
    THEMES,
    themeVars,
    varsStyle,
} from "../theme.js";
import { html, Icon, Sheet, Switch } from "../ui.js";

/** A theme as a card: a tiny Hyprland desktop drawn in its own colors. */
function ThemeCard({ id, index, desktop = false }) {
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
        ${desktop ? t("Desktop · {{theme}}", { theme: palette.name }) : THEMES[id].name}
        ${palette.colors.mode === "light" && html`<small>${t("light")}</small>`}
    </div>`;

    return html`<button
        class=${`theme-card ${on ? "on" : ""} ${desktop ? "theme-desktop" : ""}`}
        style=${`${vars};--i:${index}`}
        title=${desktop ? t("Follow the Omarchy theme of the machine Pi Pocket runs on") : THEMES[id].name}
        onClick=${(event) => chooseTheme(id, event)}
    >
        ${desk}
        ${
            desktop
                ? html`<div class="tc-text">
                    ${name}
                    <div class="tc-note">
                        ${t("Running Pi Pocket on an Omarchy desktop adds “Desktop”: the app follows the theme the desktop uses.")}
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

function SettingRow({ title, detail, children }) {
    return html`<div class="setting-row">
        <div class="setting-text">
            <span>${title}</span>
            ${detail && html`<span>${detail}</span>`}
        </div>
        ${children}
    </div>`;
}

export function AppearanceSheet() {
    const p = prefs();
    const desktop = store.state.desktopTheme;

    return html`<${Sheet} title=${t("Appearance")} onClose=${closeSheet} wide=${true}>
        <div class="label">${t("Theme")}</div>
        <div class="theme-grid">
            ${desktop && html`<${ThemeCard} id="desktop" index=${0} desktop=${true} />`}
            ${themeIds().map(
                (id, index) => html`<${ThemeCard} key=${id} id=${id} index=${index + 1} />`,
            )}
        </div>
        ${
            !desktop &&
            html`<p class="muted small">
                ${t("Running Pi Pocket on an Omarchy desktop adds “Desktop”: the app follows the theme the desktop uses.")}
            </p>`
        }
        <div class="label">${t("Layout and motion")}</div>
        <div>
            <${SettingRow}
                title=${t("Tiled windows")}
                detail=${t("Wide screens: the sidebar and the session as Hyprland windows, with gaps and the active border")}
            >
                <${Switch}
                    on=${p.tiling}
                    label=${t("Tiled windows")}
                    onChange=${() => setPrefs({ tiling: !p.tiling })}
                />
            <//>
            <${SettingRow}
                title=${t("Peek tiles")}
                detail=${t("Other sessions beside this one, live while on screen: working, waiting for you, done since you looked, and pinned. Also the tiles button in the top bar, or Alt+P")}
            >
                <${Switch}
                    on=${p.peeks}
                    label=${t("Peek tiles")}
                    onChange=${() => setPrefs({ peeks: !p.peeks })}
                />
            <//>
            ${
                desktop?.wallpaper &&
                html`<${SettingRow}
                    title=${t("Desktop wallpaper")}
                    detail=${t("Your wallpaper in the gaps between windows, while following the desktop")}
                >
                    <${Switch}
                        on=${p.wallpaper}
                        disabled=${!p.tiling || p.theme !== "desktop"}
                        label=${t("Desktop wallpaper")}
                        onChange=${() => setPrefs({ wallpaper: !p.wallpaper })}
                    />
                <//>`
            }
            <${SettingRow}
                title=${t("Sidebar")}
                detail=${t("Folded, it shows numbered sessions like workspaces")}
            >
                <div class="segmented">
                    ${[
                        ["open", t("Open")],
                        ["rail", t("Folded")],
                    ].map(
                        ([value, label]) =>
                            html`<button
                                class=${p.sidebar === value ? "on" : ""}
                                onClick=${() => setPrefs({ sidebar: value })}
                            >
                                ${label}
                            </button>`,
                    )}
                </div>
            <//>
            <${SettingRow}
                title=${t("Motion")}
                detail=${t("Auto follows your system's reduced-motion setting")}
            >
                <div class="segmented">
                    ${[
                        ["auto", t("Auto")],
                        ["full", t("Full")],
                        ["reduced", t("Reduced")],
                    ].map(
                        ([value, label]) =>
                            html`<button
                                class=${p.motion === value ? "on" : ""}
                                onClick=${() => setPrefs({ motion: value })}
                            >
                                ${label}
                            </button>`,
                    )}
                </div>
            <//>
            <${SettingRow} title=${t("Text size")}>
                <div class="segmented">
                    ${[12, 13, 14, 15, 16].map(
                        (size) => html`<button
                            class=${p.text === size ? "on" : ""}
                            onClick=${() => setPrefs({ text: size })}
                        >
                            ${size}
                        </button>`,
                    )}
                </div>
            <//>
        </div>
        <button class="button wide" onClick=${() => openSheet({ type: "shortcuts" })}>
            <${Icon} name="keyboard" size=${16} /> ${t("Keyboard shortcuts")}
        </button>
    <//>`;
}
