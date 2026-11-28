// Usage: how much of each provider's limits remains, from its last response (the owner's `usage` events) or checked on
// demand for subscription providers when opened. A popover above the status line on wide screens, a bottom sheet on
// phones. The status line's item (`core:usage`, composer.js) and the model sheet's row open it.
import { useEffect, useRef, useState } from "preact/hooks";
import { api, closeSheet, openSheet, serverClockOffset, store } from "../store.js";
import { useDragToClose } from "../gestures.js";
import { BOTTOM_SHEETS, formatWhen, html, Icon, scrimPress, useMinute } from "../ui.js";
import {
    agoWords,
    inWords,
    modelHoldWords,
    percent,
    providerView,
    sortProviders,
    summary,
    USAGE_ICONS,
    usedShare,
    windowState,
} from "../usage.js";

/** The server's time now: what `usage` events' times are on. */
export const serverNow = () => Date.now() + serverClockOffset();

/** More others than this get a filter. */
const FILTER_AT = 6;

/** The open session's provider, as `usage.js` views it; null when usage is not the person's or the provider is not listed. */
export function sessionUsage(now = serverNow()) {
    const { usage, view } = store.state;
    const id = view.agent?.model?.provider;
    const provider = id === undefined ? undefined : usage?.providers.find((each) => each.id === id);

    return provider === undefined ? null : providerView(provider, now, view.agent?.model?.modelId);
}

/** Open the usage popover (or sheet); `from` is where, for the focus's way back. */
export const openUsage = (from) => openSheet({ type: "usage", from });

const KIND = { subscription: "Subscription", key: "API key" };

/** A short meter: how much is used, in a shape that says the state without color (solid, striped, hollow). */
export function UsageMeter({ state, used, big = false }) {
    return html`<span
        class=${`usage-meter ${big ? "big" : ""}`}
        data-state=${state}
        style=${`--used:${used ?? 0}%`}
        aria-hidden="true"
    >
        <i></i>
    </span>`;
}

const stateWord = (state) => (state === "limited" ? "Limited" : state === "low" ? "Low" : "");

function StateMark({ state }) {
    if (state !== "limited" && state !== "low") {
        return null;
    }

    return html`<${Icon}
            name=${state === "limited" ? "clock" : undefined}
            path=${state === "limited" ? undefined : USAGE_ICONS.warn}
            size=${12}
        />${stateWord(state)}`;
}

/** One window in full: its name, its state, how much is left, and when it resets. */
function WindowRow({ window, now }) {
    const state = windowState(window, now);
    const stale = state === "reset";
    const resetLocal =
        window.resetAt === undefined ? undefined : window.resetAt - serverClockOffset();
    const detail = window.detail === undefined ? "" : `${window.detail} · `;
    let sub = null;

    if (stale) {
        sub = `Reset at ${formatWhen(resetLocal)}. Newer numbers arrive with the next response.`;
    } else if (window.resetAt !== undefined) {
        sub = `${detail}Resets in ${inWords(window.resetAt - now)} · ${formatWhen(resetLocal)}`;
    } else if (detail !== "") {
        sub = detail.replace(/ · $/, "");
    }

    return html`<div class="usage-window" data-state=${state}>
        <div class="usage-window-top">
            <span class="usage-window-label">${window.label}</span>
            <span class="usage-window-state" data-state=${state}>
                <${StateMark} state=${state} />
            </span>
            <span class="usage-window-left">
                ${stale || window.left === undefined ? "—" : `${percent(window)} used`}
            </span>
        </div>
        <${UsageMeter} state=${state} used=${stale ? 0 : usedShare(window)} big />
        ${sub && html`<div class="usage-window-sub">${sub}</div>`}
    </div>`;
}

/** What a provider with no windows says. */
function Silent({ status, refreshable = false, refreshing = false }) {
    if (status === "no-data") {
        const text =
            refreshable && refreshing
                ? "Checking latest usage…"
                : refreshable
                  ? "No usage yet. Refresh or send a message to check."
                  : "No usage yet. It updates after the next request.";

        return html`<p class="usage-note">
            <${Icon} path=${USAGE_ICONS.dash} size=${12} />
            <span>${text}</span>
        </p>`;
    }

    return html`<p class="usage-note">
        <${Icon} path=${USAGE_ICONS.slash} size=${12} />
        <span>
            This provider does not report usage.
            <small>Its responses carry no limits, so there is nothing to read.</small>
        </span>
    </p>`;
}

/** A provider's windows in full, with the limit gate's hold when there is one, and the models it holds alone. */
function Windows({ view, now, refreshing = false }) {
    const { provider } = view;
    const held =
        provider.held !== undefined && provider.held.until > now ? provider.held : undefined;

    return html`${
        provider.status === "reported"
            ? provider.windows.map(
                  (window) => html`<${WindowRow} key=${window.id} window=${window} now=${now} />`,
              )
            : html`<${Silent}
                  status=${provider.status}
                  refreshable=${provider.refreshable === true}
                  refreshing=${refreshing}
              />`
    }${
        held &&
        html`<p class="usage-note usage-held">
            <${Icon} name="clock" size=${12} />
            <span>
                ${held.reason}. Runs wait here and try again at ${formatWhen(held.until - serverClockOffset())}.
            </span>
        </p>`
    }${modelHoldWords(view, now).map(
        (words) => html`<p class="usage-note usage-held" key=${words}>
            <${Icon} name="clock" size=${12} />
            <span>${words}</span>
        </p>`,
    )}`;
}

/** The open session's provider, in full. */
function Current({ view, now, refreshing = false }) {
    const { provider } = view;

    return html`<section class="usage-current" data-state=${view.state} aria-label=${provider.name}>
        <div class="usage-prov-head">
            <h3>${provider.name}</h3>
            <span class="usage-kind">${KIND[provider.kind]}</span>
            ${
                provider.asOf !== undefined &&
                html`<span class="usage-asof">as of ${agoWords(now - provider.asOf)}</span>`
            }
        </div>
        <${Windows} view=${view} now=${now} refreshing=${refreshing} />
    </section>`;
}

/** Another provider on one line; opened (one at a time), its windows in full. */
function Row({ view, now, open, onToggle }) {
    const { provider, window } = view;
    const none = view.state === "no-data" || view.state === "not-reported";
    const age =
        provider.asOf !== undefined && now - provider.asOf > 30 * 60_000
            ? ` · ${agoWords(now - provider.asOf)}`
            : "";
    const words = summary(view, now);
    const body = `usage-body-${provider.id}`;
    const models = modelHoldWords(view, now).join(", ");

    return html`<div class="usage-row" data-open=${open} data-state=${view.state}>
        <button
            class="usage-row-button"
            data-state=${view.state}
            aria-expanded=${open}
            aria-controls=${open ? body : undefined}
            onClick=${onToggle}
        >
            <span class="usage-row-name">
                <span class="usage-row-title">${provider.name}</span>
                <span class="usage-row-kind">
                    ${KIND[provider.kind]}${age}${models === "" ? "" : ` · ${models}`}
                </span>
            </span>
            ${!none && html`<${UsageMeter} state=${view.state} used=${usedShare(window)} />`}
            <span class="usage-row-left num">
                ${
                    none
                        ? ""
                        : view.state === "limited"
                          ? (words?.text ?? "").replace("Limited ", "")
                          : view.state === "reset" || window?.left === undefined
                            ? "— used"
                            : `${percent(window)} used`
                }
            </span>
            <span class="usage-row-state" data-state=${view.state}>
                ${
                    view.state === "limited" || view.state === "low"
                        ? html`<${StateMark} state=${view.state} />`
                        : view.state === "reset"
                          ? "Reset"
                          : view.state === "no-data"
                            ? "No data"
                            : view.state === "not-reported"
                              ? "Not reported"
                              : ""
                }
            </span>
            <${Icon} name="chevron" size=${12} class="usage-chevron" />
        </button>
        ${
            open &&
            html`<div
                class="usage-row-body"
                id=${body}
                role="group"
                aria-label=${`${provider.name} usage`}
            >
                ${
                    provider.asOf !== undefined &&
                    html`<div class="usage-row-meta">
                        <span>as of ${agoWords(now - provider.asOf)}</span>
                    </div>`
                }
                <${Windows} view=${view} now=${now} />
            </div>`
        }
    </div>`;
}

/**
 * Where the popover opens: centred on the status line's item (or the line), and above the message box, so it never
 * covers what someone is typing; null (the middle) when neither is on screen.
 */
function usageAnchor() {
    const rect = (
        document.querySelector(".usage-now") ?? document.querySelector(".status-line")
    )?.getBoundingClientRect();

    if (!rect || rect.width === 0) {
        return null;
    }

    const box = document.querySelector('[data-part="message-box"]')?.getBoundingClientRect();
    const floor = box && box.height > 0 && box.top < rect.top ? box.top : rect.top;

    const top = visualViewport?.offsetTop ?? 0;
    const width = Math.min(440, innerWidth - 16);
    const left = Math.max(
        8,
        Math.min(rect.left + rect.width / 2 - width / 2, innerWidth - width - 8),
    );
    const room = floor - top - 14;

    return room >= 260
        ? { left, bottom: innerHeight - floor + 10, width, height: Math.min(600, room) }
        : null;
}

/** The panel: the open session's provider, the others, and the way to Providers. */
function Panel({ onClose }) {
    const { usage } = store.state;
    const now = serverNow();
    const id = store.state.view.agent?.model?.provider;
    const modelId = store.state.view.agent?.model?.modelId;
    const [expanded, setExpanded] = useState(null);
    const [grouped, setGrouped] = useState(false);
    const [filter, setFilter] = useState("");
    const [refreshing, setRefreshing] = useState(false);
    const [refreshNote, setRefreshNote] = useState("");
    const alive = useRef(true);
    const canRefresh = (usage?.providers ?? []).some((provider) => provider.refreshable === true);

    const doRefresh = async (explicit) => {
        if (!canRefresh) {
            return;
        }

        setRefreshing(true);
        setRefreshNote("");

        try {
            const result = await api("usage/refresh", {});

            if (!alive.current) {
                return;
            }

            if (Array.isArray(result?.providers)) {
                store.set({ usage: { at: result.at, providers: result.providers } });
            }

            if (explicit && result.refreshed.length === 0 && result.cooldownMs > 0) {
                setRefreshNote(`Checked recently · try again in ${inWords(result.cooldownMs)}`);
            } else if (result.failed.length > 0 && result.refreshed.length === 0) {
                setRefreshNote("Couldn’t check right now · showing last known usage");
            }
        } catch {
            if (alive.current) {
                setRefreshNote("Couldn’t check right now · showing last known usage");
            }
        } finally {
            if (alive.current) {
                setRefreshing(false);
            }
        }
    };

    useEffect(() => {
        alive.current = true;

        if (canRefresh) {
            void doRefresh(false);
        }

        return () => {
            alive.current = false;
        };
    }, []);

    const views = (usage?.providers ?? []).map((provider) =>
        providerView(provider, now, provider.id === id ? modelId : undefined),
    );
    const current = views.find((view) => view.provider.id === id);
    const others = views.filter((view) => view !== current);
    const query = filter.trim().toLowerCase();
    const filtering = others.length > FILTER_AT;
    const hit = (view) =>
        query === "" ||
        !filtering ||
        `${view.provider.name} ${KIND[view.provider.kind]}`.toLowerCase().includes(query);
    const silent = (view) => view.state === "no-data" || view.state === "not-reported";
    const reporting = sortProviders(others.filter((view) => !silent(view) && hit(view)));
    const none = others
        .filter((view) => silent(view) && hit(view))
        .sort((a, b) => a.provider.name.localeCompare(b.provider.name));
    const groupOpen = query !== "" ? none.length > 0 : grouped;
    const toggle = (providerId) => setExpanded((open) => (open === providerId ? null : providerId));
    const subtitle = refreshing
        ? "Checking latest usage…"
        : refreshNote !== ""
          ? refreshNote
          : canRefresh
            ? "From each provider’s last response, or checked on demand."
            : "From each provider’s last response. Sends nothing.";

    return html`<header class="usage-head">
            <div class="grip" aria-hidden="true"></div>
            <div class="usage-head-text">
                <h2 id="usage-title">Usage</h2>
                <p>${subtitle}</p>
            </div>
            <div class="usage-head-actions">
                ${
                    canRefresh &&
                    html`<button
                        class=${`icon-button usage-refresh ${refreshing ? "spinning" : ""}`}
                        disabled=${refreshing}
                        onClick=${() => void doRefresh(true)}
                        aria-label="Refresh usage"
                        title="Refresh usage"
                    >
                        <${Icon} path=${USAGE_ICONS.refresh} size=${16} />
                    </button>`
                }
                <button class="icon-button" onClick=${onClose} aria-label="Close usage">
                    <${Icon} name="close" size=${18} />
                </button>
            </div>
        </header>
        <div class="usage-list" data-scroll>
            ${
                current &&
                html`<p class="usage-group">In this session</p>
                    <${Current} view=${current} now=${now} refreshing=${refreshing} />`
            }
            ${
                others.length > 0 &&
                html`<div class="usage-others-head">
                        <p class="usage-group">
                            Other providers <span class="num">${others.length}</span>
                        </p>
                        ${
                            filtering &&
                            html`<label class="search usage-filter">
                                <${Icon} name="search" size=${13} />
                                <input
                                    aria-label="Filter providers"
                                    type="search"
                                    placeholder="Filter providers"
                                    autocomplete="off"
                                    spellcheck="false"
                                    value=${filter}
                                    onInput=${(event) => setFilter(event.currentTarget.value)}
                                />
                            </label>`
                        }
                    </div>
                    <div class="usage-rows">
                        ${reporting.map(
                            (view) => html`<${Row}
                                key=${view.provider.id}
                                view=${view}
                                now=${now}
                                open=${expanded === view.provider.id}
                                onToggle=${() => toggle(view.provider.id)}
                            />`,
                        )}
                        ${
                            none.length > 0 &&
                            html`<div class="usage-row usage-group-row" data-open=${groupOpen}>
                                <button
                                    class="usage-row-button usage-fold"
                                    aria-expanded=${groupOpen}
                                    aria-controls="usage-fold-list"
                                    onClick=${() => setGrouped(!grouped)}
                                >
                                    <span class="usage-row-name">
                                        <span class="usage-row-title">
                                            ${none.length} without usage data
                                        </span>
                                        <span class="usage-row-kind">
                                            ${none.map((view) => view.provider.name).join(", ")}
                                        </span>
                                    </span>
                                    <${Icon} name="chevron" size=${12} class="usage-chevron" />
                                </button>
                                ${
                                    groupOpen &&
                                    html`<div class="usage-fold-list" id="usage-fold-list">
                                        ${none.map(
                                            (view) => html`<${Row}
                                                key=${view.provider.id}
                                                view=${view}
                                                now=${now}
                                                open=${expanded === view.provider.id}
                                                onToggle=${() => toggle(view.provider.id)}
                                            />`,
                                        )}
                                    </div>`
                                }
                            </div>`
                        }
                        ${
                            reporting.length === 0 &&
                            none.length === 0 &&
                            html`<div class="usage-empty" role="status">
                                <span>No provider matches “${filter.trim()}”.</span>
                                <button class="button small" onClick=${() => setFilter("")}>
                                    Clear filter
                                </button>
                            </div>`
                        }
                    </div>`
            }
            ${
                usage === null &&
                html`<p class="usage-note usage-pad"><span>No usage yet.</span></p>`
            }
        </div>
        <footer class="usage-foot">
            <button class="usage-foot-link" onClick=${() => openSheet({ type: "providers" })}>
                <span>Menu → Providers</span>
                <span class="usage-hint">Sign in, sign out, add</span>
                <${Icon} name="chevron" size=${12} />
            </button>
        </footer>`;
}

/** The sheet: a popover above the status line, a bottom sheet on a phone. */
export function UsageSheet() {
    const from = store.state.sheet?.from;
    const box = useRef(null);
    const phone = BOTTOM_SHEETS.matches;
    const [anchor, setAnchor] = useState(() => (phone ? null : usageAnchor()));

    // Times are read as it draws: ages and countdowns move on each minute.
    useMinute();
    useDragToClose(box, { dir: "down", onClose: closeSheet, enabled: phone });
    useEffect(() => {
        const place = () => setAnchor(BOTTOM_SHEETS.matches ? null : usageAnchor());

        const onKey = (event) => {
            if (event.key !== "Escape" || event.isComposing || event.defaultPrevented) {
                return;
            }

            closeSheet();

            // The item it came from takes the focus back, even where a click does not focus a button.
            if (from === "item") {
                queueMicrotask(() =>
                    document.querySelector(".usage-now")?.focus({ preventScroll: true }),
                );
            }
        };

        addEventListener("resize", place);
        visualViewport?.addEventListener("resize", place);
        addEventListener("keydown", onKey);
        // Keys go to the panel, not the message box behind it; a phone's keyboard stays down.
        box.current?.focus({ preventScroll: true });

        return () => {
            removeEventListener("resize", place);
            visualViewport?.removeEventListener("resize", place);
            removeEventListener("keydown", onKey);
        };
    }, []);

    const panel = html`<${Panel} onClose=${closeSheet} />`;

    if (phone) {
        return html`<div
            class="overlay"
            data-part="scrim"
            data-for="sheet"
            onMouseDown=${scrimPress(closeSheet)}
        >
            <section
                class="sheet usage-sheet"
                data-part="sheet usage-panel"
                data-sheet="usage"
                role="dialog"
                aria-modal="true"
                aria-labelledby="usage-title"
                tabindex="-1"
                ref=${box}
            >
                ${panel}
            </section>
        </div>`;
    }

    return html`<div class="overlay pop-overlay" onMouseDown=${scrimPress(closeSheet)}>
        <section
            class=${`pop-menu usage-pop ${anchor ? "" : "free"}`}
            data-part="usage-panel"
            data-sheet="usage"
            style=${
                anchor
                    ? `left:${anchor.left}px;bottom:${anchor.bottom}px;width:${anchor.width}px;max-height:${anchor.height}px`
                    : ""
            }
            role="dialog"
            aria-modal="true"
            aria-labelledby="usage-title"
            tabindex="-1"
            ref=${box}
        >
            ${panel}
        </section>
    </div>`;
}
