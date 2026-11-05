// The extension gallery: drop-ins and themes other people wrote, from a reviewed index. Browse and search them, read
// one's code before it is installed, install it (a drop-in off; a theme into Appearance's list, not applied), ask Pi to
// review a drop-in, turn it on, update it with a diff, remove it; and share your own as a draft index entry. The
// owner's alone; the server side is src/server/gallery.ts.
//
// Everything the index says is untrusted: it shows as text only, and links go only to addresses the server built.
import { useContext, useEffect, useRef, useState } from "preact/hooks";
import { personColor } from "../avatar.js";
import { planAvailable } from "../commands.js";
import { browserModuleState } from "../extension-ui.js";
import { DiffBlock } from "../diff.js";
import { Highlighted } from "../rich.js";
import {
    actions,
    api,
    attempt,
    closeSheet,
    navigate,
    notify,
    openSheet,
    store,
    uid,
} from "../store.js";
import { BASE_LOOK, chooseLook, prefs, setPrefs } from "../theme.js";
import { copyText, formatBytes, html, Icon, Loader, Sheet, SheetBack, timeAgo } from "../ui.js";
import { t } from "../ui-locale.js";

/** The owner's, while its module is on. */
export const galleryAvailable = () =>
    store.state.me?.role === "owner" &&
    store.state.server?.extensions?.includes("pocket-gallery") === true;

/** The gallery's routes: GET without a body, POST with one; `options.signal` stops it. */
export const galleryApi = (path, body, options) => api(`x/gallery/${path}`, body, options);

/**
 * Read a route while a sheet shows, and stop when it closes: a download of an extension's files goes no further, and
 * its answer reaches no sheet that is gone.
 */
function useRoute(path, setData, setProblem) {
    useEffect(() => {
        const stop = new AbortController();

        galleryApi(path, undefined, { signal: stop.signal }).then(
            (result) => !stop.signal.aborted && setData(result),
            (error) => !stop.signal.aborted && setProblem(error.message),
        );

        return () => stop.abort();
    }, [path]);
}

const short = (commit) => (commit ?? "").slice(0, 7);
/** One form for a count of one, another for the rest: English's two, and a language's own. */
const counted = (count, one, many) => (count === 1 ? one : many);
const revocation = (entry, commit) => entry.revoked.find((each) => each.commit === commit)?.reason;

/** Who a browser module or a route is for, in words. */
export function accessWords(access) {
    if (access === "owner") {
        return t("web.sheets.gallery.owner.owner", "the owner");
    }

    if (access === "steer") {
        return t("web.sheets.gallery.steer.people-who-steer", "people who can steer");
    }

    if (access === "view") {
        return t(
            "web.sheets.gallery.view.everyone-who-sees-every",
            "everyone who sees every session",
        );
    }

    return access;
}

/** What a module declares, by group, in the order the entry and the review list them. */
const GROUPS = [
    ["extensions", () => t("web.sheets.gallery.groups.extensions.extensions", "Extensions")],
    ["tools", () => t("web.sheets.gallery.groups.tools", "Tools")],
    ["readOnlyTools", () => t("web.sheets.gallery.groups.read-tools", "Read-only tools")],
    ["hooks", () => t("web.sheets.gallery.groups.hooks", "Hooks")],
    ["sections", () => t("web.sheets.gallery.groups.prompt-sections", "Prompt sections")],
    ["wraps", () => t("web.sheets.gallery.groups.wraps", "Wraps")],
    ["routes", () => t("web.sheets.gallery.groups.routes", "Routes")],
    ["commands", () => t("web.sheets.gallery.groups.slash-commands", "Slash commands")],
];

/**
 * One group of what a module declares, as names to show: a command with its slash, and who may run it. Older entries
 * lack some groups.
 */
const declared = (declares, key) =>
    (declares[key] ?? []).map((each) => {
        if (key !== "commands") {
            return each;
        }

        const [scope, name] = each.split(" ");

        return `/${name} (${
            scope === "global"
                ? t("web.sheets.gallery.declared.owner", "owner")
                : t("web.sheets.gallery.declared.who-steer", "who can steer")
        })`;
    });

const isTheme = (item) => item?.kind === "theme";

/** A link out, to an address the server built (or a GitHub profile): never one the index wrote. */
const Out = ({ href, class: className = "", children }) =>
    html`<a class=${className} href=${href} target="_blank" rel="noopener noreferrer">${children}</a>`;

/** The last index read, so an entry opened from the list shows at once while it is read again. */
let lastListing = null;

/** Preserve the hub tab through source/update sheets and their return to an entry. */
function openGallerySheet(type, name) {
    const sheet = store.state.sheet;

    openSheet({
        type,
        id: name,
        tab: sheet?.tab,
        origin: sheet?.origin ?? (sheet?.type === "gallery" ? "gallery" : "extensions"),
    });
}

function useListing(shared) {
    const [data, setData] = useState(lastListing);
    const [problem, setProblem] = useState(null);
    const [loading, setLoading] = useState(true);
    const live = useRef(true);

    const load = (refresh = false) => {
        setLoading(true);

        return galleryApi(`index${refresh ? "?refresh=1" : ""}`)
            .then(
                (result) => {
                    lastListing = result;

                    if (live.current) {
                        setData(result);
                        setProblem(null);
                    }
                },
                (error) => live.current && setProblem(error.message),
            )
            .finally(() => live.current && setLoading(false));
    };

    useEffect(() => {
        live.current = true;

        if (!shared) {
            load();
        }

        return () => {
            live.current = false;
        };
    }, []);

    return shared ?? { data, problem, loading, load };
}

export function Tile({ name, title, icon = null, large = false }) {
    const letter = (title ?? name ?? "?").trim().charAt(0).toUpperCase() || "?";

    return html`<span
        class=${`ext-tile ${large ? "large" : ""}`}
        style=${`--tint:${personColor(name ?? title ?? "")}`}
        aria-hidden="true"
    >
        ${icon ? html`<${Icon} name=${icon} size=${large ? 17 : 11} />` : letter}
    </span>`;
}

const sentence = (items) =>
    items.length > 1
        ? t("web.sheets.gallery.sentence.text.and", "{head} and {last}", {
              head: items.slice(0, -1).join(", "),
              last: items.at(-1),
          })
        : (items[0] ?? "");

const HOOK_WORDS = {
    beforeTool: () =>
        t("web.sheets.gallery.before-tool.tool-calls-before-they", "tool calls, before they run"),
    afterTool: () => t("web.sheets.gallery.after-tool.tool-results", "tool results"),
    beforeRequest: () =>
        t("web.sheets.gallery.before-request.goes-model", "what goes to the model"),
    afterResponse: () =>
        t("web.sheets.gallery.after-response.model-s-replies", "the model's replies"),
    onYield: () => t("web.sheets.gallery.on-yield.end-turn", "the end of each turn"),
};

/** What a hook sees, in words; one the index names and this does not know stays as it is. */
const hookWords = (hook) => (Object.hasOwn(HOOK_WORDS, hook) ? HOOK_WORDS[hook]() : hook);

let lastReach = null;

/** A server from before the reach route answers 404: the facts then wait for a restart. */
function useReach(data) {
    const [reach, setReach] = useState(lastReach);
    const [problem, setProblem] = useState(null);

    useEffect(() => {
        if (!data) {
            return;
        }

        const stop = new AbortController();

        galleryApi("reach", undefined, { signal: stop.signal }).then(
            (result) => {
                if (!stop.signal.aborted) {
                    lastReach = result.entries ?? {};
                    setReach(lastReach);
                    setProblem(null);
                }
            },
            (error) =>
                !stop.signal.aborted &&
                setProblem(
                    error.status === 404 || error.status === 503
                        ? t(
                              "web.sheets.gallery.use-reach.text.code-reaches-shows-after",
                              "What its code reaches shows after a server restart (menu → Restart server).",
                          )
                        : t(
                              "web.sheets.gallery.use-reach.text.code-not-read",
                              "Its code could not be read: {error}",
                              { error: error.message },
                          ),
                ),
        );

        return () => stop.abort();
    }, [data?.fetchedAt, data?.address, data?.installed.length]);

    return { reach, problem };
}

/** A scan counts only for the same commit and pinned files, and the version installed here. */
function foundFor(reach, entry, installed) {
    const found = entry?.source ? reach?.[entry.name] : undefined;

    if (
        !found ||
        found.error ||
        found.commit !== entry.source.commit ||
        found.pin !== entry.pin ||
        (installed && installed.commit !== entry.source.commit)
    ) {
        return undefined;
    }

    return found;
}

function useModules(on, round) {
    const [modules, setModules] = useState(null);

    useEffect(() => {
        if (!on) {
            return;
        }

        let live = true;

        api("extensions").then(
            (result) => live && setModules(result.modules),
            () => {},
        );

        return () => {
            live = false;
        };
    }, [on, round]);

    return modules;
}

function reachRows(declares, found) {
    const scanned = found?.scanned;
    const rows = [];

    if (scanned) {
        for (const [key, glyph, words] of [
            [
                "network",
                "globe",
                (items) =>
                    t("web.sheets.gallery.reach-rows.text.talks", "Talks to {detail}", {
                        detail: sentence(items),
                    }),
            ],
            [
                "keys",
                "key",
                (items) =>
                    t("web.sheets.gallery.reach-rows.text.uses", "Uses {detail}", {
                        detail: sentence(
                            items.map((item) =>
                                item.replace(/^(.+) key from Pi$/, (_, name) =>
                                    t(
                                        "web.sheets.gallery.reach-rows.text.your-key-from-pi",
                                        "your {name} key, from Pi",
                                        { name },
                                    ),
                                ),
                            ),
                        ),
                    }),
            ],
            [
                "programs",
                "terminal",
                (items) =>
                    t("web.sheets.gallery.reach-rows.text.runs", "Runs {detail}", {
                        detail: sentence(items),
                    }),
            ],
            [
                "files",
                "folder",
                (items) =>
                    t("web.sheets.gallery.reach-rows.text.uses", "Uses {detail}", {
                        detail: sentence(items),
                    }),
            ],
        ]) {
            if (scanned[key]?.length > 0) {
                rows.push({
                    key,
                    glyph,
                    text: words(scanned[key]),
                    from: t("web.sheets.gallery.reach-rows.from.code", "In its code"),
                });
            }
        }
    }

    if ((declares.hooks ?? []).length > 0) {
        rows.push({
            key: "sees",
            glyph: "eye",
            text: t("web.sheets.gallery.reach-rows.text.sees", "Sees {detail}", {
                detail: sentence(declares.hooks.map(hookWords)),
            }),
            from: t("web.sheets.gallery.reach-rows.from.declared", "Declared"),
        });
    }

    const changes = [
        (declares.sections ?? []).length > 0 &&
            t(
                "web.sheets.gallery.reach-rows.changes.adds-pi-s-instructions",
                "Adds to Pi's instructions",
            ),
        ...(declares.wraps ?? []).map((wrap) =>
            t("web.sheets.gallery.reach-rows.changes.wraps-tool", "Wraps the {detail} tool", {
                detail: wrap.replace(/^tool /, ""),
            }),
        ),
    ].filter(Boolean);

    if (changes.length > 0) {
        rows.push({
            key: "changes",
            glyph: "chat",
            text: changes.join("; "),
            from: t("web.sheets.gallery.reach-rows.from.declared", "Declared"),
        });
    }

    return rows;
}

const RUN_TIME = /at run time/;

function rowFacts(entry, found) {
    if (isTheme(entry) || !entry.declares) {
        return [];
    }

    const d = entry.declares;
    const s = found?.scanned;
    const tools = new Set([...(d.tools ?? []), ...(d.readOnlyTools ?? [])]).size;

    return [
        s?.network.length > 0 && [
            "globe",
            s.network.length > 1
                ? t("web.sheets.gallery.row-facts.text.hosts", "{count} hosts", {
                      count: s.network.length,
                  })
                : RUN_TIME.test(s.network[0])
                  ? t("web.sheets.gallery.row-facts.text.network", "network")
                  : s.network[0],
        ],
        s?.keys.length > 0 && [
            "key",
            s.keys.length > 1
                ? t("web.sheets.gallery.row-facts.text.keys", "{count} keys", {
                      count: s.keys.length,
                  })
                : t("web.sheets.gallery.row-facts.text.key", "a key"),
        ],
        s?.programs.length > 0 && [
            "terminal",
            RUN_TIME.test(s.programs.join())
                ? t("web.sheets.gallery.row-facts.text.programs", "programs")
                : s.programs.join(", "),
        ],
        (d.hooks ?? []).length > 0 && [
            "eye",
            t("web.sheets.gallery.row-facts.text.sees-turns", "sees turns"),
        ],
        ((d.sections ?? []).length > 0 || (d.wraps ?? []).length > 0) && [
            "chat",
            t("web.sheets.gallery.row-facts.text.changes-pi", "changes Pi"),
        ],
        tools > 0 && [
            "sparkle",
            counted(
                tools,
                t("web.sheets.gallery.row-facts.text.tool", "1 tool"),
                t("web.sheets.gallery.row-facts.text.tools", "{count} tools", { count: tools }),
            ),
        ],
        d.client !== null && ["tiles", t("web.sheets.gallery.row-facts.text.app", "in the app")],
    ]
        .filter(Boolean)
        .slice(0, 3);
}

function newReach(before, after) {
    const added = (key) =>
        declared(after, key).filter((each) => !declared(before, key).includes(each));
    const tools = [...new Set([...added("tools"), ...added("readOnlyTools")])];
    const commands = added("commands").length;

    return [
        added("hooks").length > 0 &&
            t("web.sheets.gallery.new-reach.text.sees", "sees {detail}", {
                detail: sentence(added("hooks").map(hookWords)),
            }),
        added("sections").length > 0 &&
            t(
                "web.sheets.gallery.new-reach.text.adds-pi-s-instructions",
                "adds to Pi's instructions",
            ),
        ...added("wraps").map((wrap) =>
            t("web.sheets.gallery.new-reach.text.wraps-tool", "wraps the {detail} tool", {
                detail: wrap.replace(/^tool /, ""),
            }),
        ),
        tools.length > 0 &&
            counted(
                tools.length,
                t("web.sheets.gallery.new-reach.text.one-new-tool", "1 new tool", {
                    count: tools.length,
                }),
                t("web.sheets.gallery.new-reach.text.new-tools", "{count} new tools", {
                    count: tools.length,
                }),
            ),
        commands > 0 &&
            counted(
                commands,
                t("web.sheets.gallery.new-reach.text.one-new-command", "1 new command", {
                    count: commands,
                }),
                t("web.sheets.gallery.new-reach.text.new-commands", "{count} new commands", {
                    count: commands,
                }),
            ),
        (added("routes").length > 0 || (before.client === null && after.client !== null)) &&
            t("web.sheets.gallery.new-reach.text.adds-app", "adds to the app"),
        before.access !== after.access &&
            t("web.sheets.gallery.new-reach.text.content", "now for {access}", {
                access: accessWords(after.access),
            }),
    ].filter(Boolean);
}

function liveStatus(item, module, tab) {
    if (item.revoked !== null && item.revoked !== undefined) {
        return { kind: "bad", text: t("web.sheets.gallery.live-status.text.revoked", "Revoked") };
    }

    if (module?.error) {
        return {
            kind: "bad",
            text: t("web.sheets.gallery.live-status.text.not-load", "Did not load"),
        };
    }

    if (module && browserModuleState(module.file.replace(/\.ts$/, ""))?.status === "failed") {
        return {
            kind: "warn",
            text: t("web.sheets.gallery.live-status.text.off-tab", "Off in this tab"),
        };
    }

    if (item.changed?.length > 0) {
        return {
            kind: "warn",
            text: t(
                "web.sheets.gallery.live-status.text.edited-since-install",
                "Edited since install",
            ),
        };
    }

    if (item.enabled) {
        return { kind: "on", text: t("web.sheets.gallery.live-status.text.content", "On") };
    }

    return {
        kind: "off",
        text:
            tab === "discover"
                ? t("web.sheets.gallery.live-status.text.installed", "Installed")
                : t("web.sheets.gallery.live-status.text.off", "Off"),
    };
}

const Status = ({ status }) =>
    html`<span class=${`ext-state ${status.kind}`}>
        <span class="ext-mark" aria-hidden="true"></span>${status.text}
    </span>`;

function statusWhy(item, module) {
    if (module?.error) {
        return {
            kind: "bad",
            text: t("web.sheets.gallery.status-why.text.not-load", "Did not load: {error}", {
                error: module.error,
            }),
        };
    }

    const here = module && browserModuleState(module.file.replace(/\.ts$/, ""));

    if (here?.status === "failed") {
        return {
            kind: "warn",
            text: t(
                "web.sheets.gallery.status-why.text.browser-reloading-page-tries",
                "In this browser: {error}. Reloading the page tries again.",
                { error: here.error },
            ),
        };
    }

    if (item?.revoked) {
        return {
            kind: "bad",
            text: t(
                "web.sheets.gallery.status-why.text.gallery-revoked-version",
                "The gallery revoked this version: {revoked}",
                { revoked: item.revoked },
            ),
        };
    }

    return null;
}

function EntryRow({ entry, found, module, tab, selected, onOpen, onChanged }) {
    const [busy, setBusy] = useState(false);
    const going = useRef(false);
    const installed = entry.installed ?? (entry.listed === false ? entry : null);
    const theme = isTheme(entry);
    const update = tab === "updates" && installed?.update;
    const added =
        update && !theme && entry.declares && installed.declares
            ? newReach(installed.declares, entry.declares)
            : null;
    const facts = rowFacts(entry, found);
    const why = tab !== "discover" && installed && !theme ? statusWhy(installed, module) : null;

    const install = () => {
        if (going.current) {
            return;
        }

        going.current = true;
        setBusy(true);
        attempt(() =>
            galleryApi(`install/${encodeURIComponent(entry.name)}`, { pin: entry.pin }),
        ).finally(() => {
            going.current = false;
            setBusy(false);
            onChanged();
        });
    };

    const end = !installed
        ? html`<button class="button small ext-get" disabled=${busy} onClick=${install}>
              ${
                  busy
                      ? t("web.sheets.gallery.entry-row.button.installing", "Installing…")
                      : t("web.sheets.gallery.entry-row.button.install", "Install")
              }
          </button>`
        : installed.update && tab !== "installed"
          ? html`<button
                class=${`button small ${added?.length > 0 ? "" : "primary"}`}
                onClick=${() => openGallerySheet("gallery-update", entry.name)}
            >
                ${
                    added?.length > 0
                        ? t("web.sheets.gallery.entry-row.button.review", "Review")
                        : t("web.sheets.gallery.entry-row.button.update", "Update")
                }
            </button>`
          : theme
            ? html`<span class="ext-state on"><${Icon} name="check" size=${13} stroke=${2.5} />${t("web.sheets.gallery.entry-row.text.installed", "Installed")}</span>`
            : html`<${Status} status=${liveStatus(installed, module, tab)} />`;

    return html`<div
        class=${`ext-row ${selected ? "selected" : ""} ${installed && !theme && !installed.enabled ? "off" : ""}`}
    >
        <button class="ext-row-open" aria-current=${selected ? "true" : undefined} onClick=${onOpen}>
            <span class="ext-row-line">
                <${Tile} name=${entry.name} title=${entry.title} icon=${theme ? "palette" : null} />
                <span class="ext-row-title">${entry.title}</span>
                <span class="ext-row-by">
                    ${update ? `${installed.version} → ${installed.update.version}` : (entry.author?.name ?? entry.unlisted ?? "")}
                </span>
            </span>
            ${entry.description && html`<span class="ext-row-desc">${entry.description}</span>`}
            ${
                why
                    ? html`<span class=${`ext-why ${why.kind}`}>${why.text}</span>`
                    : added !== null
                      ? html`<span class="ext-facts">
                            ${
                                added.length > 0
                                    ? html`<span class="ext-fact new">
                                          <${Icon} name="eye" size=${12} /><span>${t(
                                              "web.sheets.gallery.entry-row.span.declares-more",
                                              "Declares more: {detail}",
                                              { detail: added.join("; ") },
                                          )}</span>
                                      </span>`
                                    : html`<span class="ext-fact"><${Icon} name="check" size=${12} /><span>${t("web.sheets.gallery.entry-row.span.declares-nothing-new", "Declares nothing new")}</span></span>`
                            }
                        </span>`
                      : facts.length > 0 &&
                        html`<span class="ext-facts">
                            ${facts.map(
                                ([glyph, text]) => html`<span class="ext-fact" key=${glyph}>
                                    <${Icon} name=${glyph} size=${12} /><span>${text}</span>
                                </span>`,
                            )}
                        </span>`
            }
        </button>
        <div class="ext-row-end">${end}</div>
    </div>`;
}

/** Only a color written as #rgb to #rrggbbaa reaches a style: a theme's palette is the index's text. */
const HEX = /^#[0-9a-f]{3,8}$/i;
const THEME_DOTS = ["red", "yellow", "green", "cyan", "blue", "magenta"];

function paletteStyle(colors) {
    if (!colors) {
        return "";
    }

    const pick = (...keys) => keys.map((key) => colors[key]).find((value) => HEX.test(value ?? ""));

    return [
        ["--t-bg", pick("background")],
        ["--t-bg-dark", pick("dark_background", "background")],
        ["--t-bg-darker", pick("darker_background", "background")],
        ["--t-bg-light", pick("lighter_background", "background")],
        ["--t-fg", pick("foreground")],
        ["--t-accent", pick("accent")],
        ...THEME_DOTS.map((color) => [`--t-${color}`, pick(color)]),
    ]
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => `${key}:${value}`)
        .join(";");
}

function paletteOf(entry, found) {
    const listed = store.state.themeList?.find((each) => each.id === entry.name);

    if (entry.installed && listed?.colors) {
        return { colors: listed.colors, colorsLight: listed.colorsLight ?? null };
    }

    return found?.palette?.colors ? found.palette : null;
}

const modeWords = (palette) =>
    !palette
        ? t("web.sheets.gallery.mode-words.theme", "theme")
        : palette.colorsLight
          ? t("web.sheets.gallery.mode-words.dark-light", "dark and light")
          : palette.colors.mode === "light"
            ? t("web.sheets.gallery.mode-words.light", "light")
            : t("web.sheets.gallery.mode-words.dark", "dark");

const ThemeDesk = ({ colors, big = false }) =>
    html`<span
        class=${`ext-desk ${big ? "big" : ""} ${colors ? "" : "unknown"}`}
        style=${paletteStyle(colors)}
        aria-hidden="true"
    >
        <span class="ext-win side"><i></i><i></i><i></i></span>
        <span class="ext-win main">
            ${big ? html`<i></i><i></i><i class="bubble"></i><i></i>` : html`<i></i><i></i>`}
            <i class="lit"></i>
        </span>
    </span>`;

function ThemeCard({ entry, palette, selected, state = null, onOpen }) {
    return html`<button
        class=${`ext-theme ${selected ? "selected" : ""}`}
        aria-current=${selected ? "true" : undefined}
        onClick=${onOpen}
    >
        <${ThemeDesk} colors=${palette?.colors ?? null} />
        <span class="ext-theme-name">
            <span>${entry.title ?? entry.name}</span>
            ${state && html`<small><${Icon} name="check" size=${11} stroke=${2.5} />${state}</small>`}
        </span>
        <span class="ext-theme-meta">${modeWords(palette)} · ${entry.author?.name ?? entry.author ?? t("web.sheets.gallery.theme-card.text.yours", "yours")}</span>
        <span class="ext-theme-dots" style=${paletteStyle(palette?.colors)} aria-hidden="true">
            ${THEME_DOTS.map((color) => html`<i key=${color} style=${`background:var(--t-${color}, var(--hair-2))`}></i>`)}
        </span>
    </button>`;
}

const Section = ({ title, count, children }) =>
    html`<section class="ext-section">
        <h3 class="ext-section-title">${title} <span>${count}</span></h3>
        ${children}
    </section>`;

/** Where the index is read from, and changing it (empty is the default). */
function IndexAddress({ address, onChanged }) {
    const [editing, setEditing] = useState(false);
    const [value, setValue] = useState(address);
    const [fallback, setFallback] = useState(null);
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState(null);

    useEffect(() => {
        if (editing && fallback === null) {
            galleryApi("settings").then(
                (result) => setFallback(result.default),
                () => {},
            );
        }
    }, [editing]);

    const save = async (index) => {
        setBusy(true);
        setProblem(null);

        try {
            const result = await galleryApi("settings", { index });

            setValue(result.index);
            setEditing(false);
            onChanged();
        } catch (error) {
            setProblem(error.message);
        } finally {
            setBusy(false);
        }
    };

    if (!editing) {
        return html`<div class="setting wrap">
            <div class="grow small">
                <div class="muted">${t("web.sheets.gallery.index-address.div.index", "Index")}</div>
                <div class="mono gallery-address">${address}</div>
            </div>
            <button
                class="button small"
                onClick=${() => {
                    setValue(address);
                    setEditing(true);
                }}
            >
                ${t("web.sheets.gallery.index-address.button.change", "Change")}
            </button>
        </div>`;
    }

    return html`<form
        class="field gallery-index-form"
        onSubmit=${(event) => {
            event.preventDefault();
            save(value.trim());
        }}
    >
        <label class="label" for="gallery-index">
            ${t(
                "web.sheets.gallery.index-address.label.index-git-hub-repository-owner",
                "Index: a GitHub repository (owner/name), or the https address of an index.json",
            )}
        </label>
        <input
            id="gallery-index"
            class="mono"
            value=${value}
            autofocus
            spellcheck=${false}
            autocapitalize="off"
            onInput=${(event) => setValue(event.currentTarget.value)}
        />
        ${problem && html`<div class="error-box small">${problem}</div>`}
        <div class="sheet-actions gallery-wrap">
            ${
                fallback !== null &&
                fallback !== address &&
                html`<button type="button" class="button small ghost" disabled=${busy} onClick=${() => save("")}>
                    ${t(
                        "web.sheets.gallery.index-address.button.default",
                        "Use the default ({fallback})",
                        { fallback },
                    )}
                </button>`
            }
            <button type="button" class="button small" onClick=${() => setEditing(false)}>${t("web.sheets.gallery.index-address.button.cancel", "Cancel")}</button>
            <button class="button small primary" disabled=${busy}>${t(
                "web.sheets.gallery.index-address.button.save",
                "Save",
            )}</button>
        </div>
    </form>`;
}

const TABS = ["discover", "installed", "updates"];

const KINDS = [
    ["all", null],
    ["extensions", null],
    ["themes", "palette"],
];
const WANTS = [
    ["tools", "sparkle"],
    ["app", "tiles"],
    ["changes", "chat"],
];

/** The tab's name, and the filter's, as the sheet draws them. */
const tabLabel = (value) => {
    if (value === "installed") {
        return t("web.sheets.gallery.tabs.installed.installed", "Installed");
    }

    if (value === "updates") {
        return t("web.sheets.gallery.tabs.updates", "Updates");
    }

    return t("web.sheets.gallery.tabs.discover", "Discover");
};

const kindLabel = (value) => {
    if (value === "extensions") {
        return t("web.sheets.gallery.kinds.extensions.extensions", "Extensions");
    }

    if (value === "themes") {
        return t("web.sheets.gallery.kinds.themes.themes", "Themes");
    }

    return t("web.sheets.gallery.kinds.content.kinds", "All");
};

const wantLabel = (value) => {
    if (value === "tools") {
        return t("web.sheets.gallery.wants.tools-pi", "Tools for Pi");
    }

    if (value === "app") {
        return t("web.sheets.gallery.wants.app", "In the app");
    }

    return t("web.sheets.gallery.wants.changes-pi", "Changes Pi");
};

function wanted(entry, want) {
    const d = entry.declares;

    if (want === null) {
        return true;
    }

    if (isTheme(entry) || !d) {
        return false;
    }

    if (want === "tools") {
        return (d.tools ?? []).length + (d.readOnlyTools ?? []).length > 0;
    }

    if (want === "app") {
        return d.client !== null || (d.routes ?? []).length > 0;
    }

    return (d.hooks ?? []).length + (d.sections ?? []).length + (d.wraps ?? []).length > 0;
}

/** One hub, whether opened from Extensions or Appearance's gallery link. */
export function GallerySheet({
    selected = null,
    tab = "discover",
    origin = "extensions",
    Management,
}) {
    const listing = useListing();
    const { data, problem, loading, load } = listing;
    const { reach, problem: reachProblem } = useReach(data);
    // The sheet's own Back returns to the list on a phone; this one is for an entry opened on its own.
    const sheetBack = useContext(SheetBack);
    const modules = useModules(tab !== "discover" || selected !== null, data);
    const [query, setQuery] = useState("");
    const [kind, setKind] = useState("all");
    const [want, setWant] = useState(null);
    const needle = query.trim().toLowerCase();
    const installed = data?.installed ?? [];
    const updates = installed.filter((item) => item.update).length;
    // Revoked offered versions stay hidden unless one is already installed here.
    const offered = (data?.entries ?? []).filter(
        (entry) => entry.installed !== null || revocation(entry, entry.source.commit) === undefined,
    );
    const entries =
        tab === "discover"
            ? offered
            : [
                  ...offered.filter(
                      (entry) => entry.installed && (tab !== "updates" || entry.installed.update),
                  ),
                  ...installed.filter((item) => !item.listed && (tab !== "updates" || item.update)),
              ];
    const foundOf = (entry) =>
        foundFor(reach, entry.listed === false ? null : entry, entry.installed ?? null);
    const matches = entries.filter(
        (entry) =>
            (tab !== "discover" || kind === "all" || (kind === "themes") === isTheme(entry)) &&
            (tab !== "discover" || wanted(entry, want)) &&
            (needle === "" ||
                [entry.name, entry.title, entry.description ?? "", ...(entry.tags ?? [])].some(
                    (text) => text.toLowerCase().includes(needle),
                )),
    );
    const extensionMatches = matches.filter((entry) => !isTheme(entry));
    const themeMatches = matches.filter(isTheme);
    const ownThemes =
        tab === "installed"
            ? (store.state.themeList ?? []).filter(
                  (look) =>
                      !look.builtIn &&
                      !installed.some((item) => item.name === look.id) &&
                      (needle === "" ||
                          `${look.name} ${look.description ?? ""}`.toLowerCase().includes(needle)),
              )
            : [];
    const detailName =
        selected ??
        extensionMatches[0]?.name ??
        (tab === "discover" ? themeMatches[0]?.name : null);
    const hidden = data?.hidden ?? { incompatible: 0, invalid: [] };
    const select = (name) => openSheet({ type: "gallery-entry", id: name, tab, origin });
    const moduleOf = (entry) =>
        modules?.find((each) => each.file === (entry.installed ?? entry).file) ?? null;

    const changeTab = (next) => {
        setQuery("");
        setKind("all");
        setWant(null);
        openSheet({ type: origin, tab: next });
    };

    const chip = (key, label, glyph, on, onClick) => html`<button
        key=${key}
        class=${`gallery-tag ${on ? "on" : ""}`}
        aria-pressed=${on}
        onClick=${onClick}
    >
        ${glyph && html`<${Icon} name=${glyph} size=${12} />`}${label}
    </button>`;

    const row = (entry) => html`<${EntryRow}
        key=${entry.name}
        entry=${entry}
        found=${foundOf(entry)}
        module=${moduleOf(entry)}
        tab=${tab}
        selected=${detailName === entry.name}
        onOpen=${() => select(entry.name)}
        onChanged=${load}
    />`;

    const card = (entry) => html`<${ThemeCard}
        key=${entry.name}
        entry=${entry}
        palette=${paletteOf(entry, foundOf(entry))}
        selected=${detailName === entry.name}
        state=${
            tab === "discover" && entry.installed
                ? t("web.sheets.gallery.entry-row.text.installed", "Installed")
                : null
        }
        onOpen=${() => select(entry.name)}
    />`;

    const tabs = html`<div class="ext-tabs" role="tablist" aria-label=${t(
        "web.sheets.gallery.gallery-sheet.aria-label.extensions",
        "Extensions",
    )}>
        ${TABS.map(
            (value) => html`<button
                key=${value}
                class=${tab === value ? "on" : ""}
                role="tab"
                aria-selected=${tab === value}
                onClick=${() => changeTab(value)}
            >
                ${tabLabel(value)}
                ${
                    value === "updates" &&
                    updates > 0 &&
                    html`<span
                        class="ext-count"
                        aria-label=${t(
                            "web.sheets.gallery.gallery-sheet.aria-label.available",
                            "{count} available",
                            { count: updates },
                        )}
                    >${updates}</span>`
                }
            </button>`,
        )}
    </div>`;

    const themesHere = [
        ...themeMatches,
        ...ownThemes.map((look) => ({ ...look, name: look.id, title: look.name, own: true })),
    ];
    const installedThemes =
        themesHere.length > 0 &&
        html`<${Section} title=${t(
            "web.sheets.gallery.gallery-sheet.title.themes",
            "Themes",
        )} count=${themesHere.length}>
            <div class="ext-themes">
                ${themesHere.map((entry) =>
                    entry.own
                        ? html`<${ThemeCard}
                              key=${entry.name}
                              entry=${entry}
                              palette=${entry.colors ? { colors: entry.colors, colorsLight: entry.colorsLight ?? null } : null}
                              state=${t(
                                  "web.sheets.extensions.extensions-content.text.yours",
                                  "Yours",
                              )}
                              onOpen=${() => openSheet({ type: "appearance" })}
                          />`
                        : card(entry),
                )}
            </div>
        <//>`;

    return html`<${Sheet}
        title=${t("web.sheets.gallery.gallery-sheet.title.extensions", "Extensions")}
        onClose=${closeSheet}
        wide=${true}
        className="extension-hub gallery"
        actions=${tabs}
    >
        <div class=${`extension-hub-layout ${tab} ${selected ? "has-selection" : ""}`}>
            <div class="extension-hub-list">
                <div class="ext-toolbar">
                    <div class="extension-hub-toolbar">
                        <label class="ext-search">
                            <${Icon} name="search" size=${15} />
                            <input
                                type="search"
                                placeholder=${
                                    tab === "installed"
                                        ? t(
                                              "web.sheets.gallery.gallery-sheet.placeholder.search-installed",
                                              "Search installed",
                                          )
                                        : tab === "updates"
                                          ? t(
                                                "web.sheets.gallery.gallery-sheet.placeholder.search-updates",
                                                "Search updates",
                                            )
                                          : offered.length > 0
                                            ? t(
                                                  "web.sheets.gallery.gallery-sheet.placeholder.search-counted",
                                                  "Search {count} extensions and themes",
                                                  { count: offered.length },
                                              )
                                            : t(
                                                  "web.sheets.gallery.gallery-sheet.aria-label.search-extensions-and-themes",
                                                  "Search extensions and themes",
                                              )
                                }
                                aria-label=${t(
                                    "web.sheets.gallery.gallery-sheet.aria-label.search-extensions-and-themes",
                                    "Search extensions and themes",
                                )}
                                value=${query}
                                onInput=${(event) => setQuery(event.currentTarget.value)}
                            />
                        </label>
                        ${
                            tab !== "installed" &&
                            html`<button
                                class="button small ext-icon-button"
                                aria-label=${t(
                                    "web.sheets.gallery.gallery-sheet.aria-label.refresh",
                                    "Refresh",
                                )}
                                title=${t(
                                    "web.sheets.gallery.gallery-sheet.title.read-the-index-again",
                                    "Read the index again",
                                )}
                                disabled=${loading}
                                onClick=${() => load(true)}
                            >
                                <${Icon} name="reload" size=${15} />
                            </button>`
                        }
                    </div>
                    ${
                        tab === "discover" &&
                        data &&
                        html`<div class="gallery-tags ext-filters" role="group" aria-label=${t("web.sheets.gallery.gallery-sheet.aria-label.filters", "Filters")}>
                            ${KINDS.map(([value, glyph]) =>
                                chip(`kind-${value}`, kindLabel(value), glyph, kind === value, () =>
                                    setKind(value),
                                ),
                            )}
                            <span class="ext-filters-gap"></span>
                            ${WANTS.map(([value, glyph]) =>
                                chip(value, wantLabel(value), glyph, want === value, () =>
                                    setWant(want === value ? null : value),
                                ),
                            )}
                        </div>`
                    }
                </div>
                ${problem && html`<div class="error-box small">${problem}</div>`}
                ${data?.error && html`<div class="error-box small">${data.error}</div>`}
                ${
                    !data &&
                    !problem &&
                    html`<${Loader} label=${t(
                        "web.sheets.gallery.gallery-sheet.label.reading-the-index",
                        "Reading the index",
                    )} />`
                }
                ${
                    tab === "discover" &&
                    extensionMatches.length > 0 &&
                    html`<${Section} title=${t(
                        "web.sheets.gallery.gallery-sheet.title.extensions",
                        "Extensions",
                    )} count=${extensionMatches.length}>
                        <div class="ext-list">${extensionMatches.map(row)}</div>
                    <//>`
                }
                ${
                    tab === "discover" &&
                    themeMatches.length > 0 &&
                    html`<${Section} title=${t(
                        "web.sheets.gallery.gallery-sheet.title.themes",
                        "Themes",
                    )} count=${themeMatches.length}>
                        <div class="ext-themes">${themeMatches.map(card)}</div>
                    <//>`
                }
                ${
                    tab === "updates" &&
                    matches.length > 0 &&
                    html`<${Section} title=${t(
                        "web.sheets.gallery.gallery-sheet.title.updates",
                        "Updates",
                    )} count=${matches.length}>
                        <div class="ext-list">${matches.map(row)}</div>
                    <//>`
                }
                ${
                    data &&
                    matches.length === 0 &&
                    tab !== "installed" &&
                    html`<div class="extension-hub-empty">
                        ${
                            tab === "updates" && !needle
                                ? html`<span class="ext-empty-mark"><${Icon} name="check" size=${20} /></span>
                                      <span>${t(
                                          "web.sheets.gallery.gallery-sheet.span.everything-up-date",
                                          "Everything is up to date.",
                                      )}</span>`
                                : needle || kind !== "all" || want
                                  ? t(
                                        "web.sheets.gallery.gallery-sheet.text.nothing-matches-try-other",
                                        "Nothing matches. Try other words, or All.",
                                    )
                                  : t(
                                        "web.sheets.gallery.gallery-sheet.text.index-nothing-pi-pocket",
                                        "The index has nothing for this Pi Pocket yet.",
                                    )
                        }
                    </div>`
                }
                ${
                    tab === "installed" &&
                    Management &&
                    html`<${Management}
                        galleryInstalled=${installed}
                        query=${query}
                        onChanged=${load}
                        hub=${true}
                        before=${extensionMatches.length > 0 && html`<div class="ext-list">${extensionMatches.map(row)}</div>`}
                        beforeCount=${extensionMatches.length}
                        between=${installedThemes}
                    />`
                }
                ${
                    tab === "discover" &&
                    data &&
                    html`<details class="gallery-technical ext-where">
                        <summary>${t(
                            "web.sheets.gallery.gallery-sheet.summary.where-these-come-from",
                            "Where these come from",
                        )}</summary>
                        <${IndexAddress} address=${data.address} onChanged=${() => load(true)} />
                        <p class="muted small">
                            ${
                                data.fetchedAt
                                    ? t(
                                          "web.sheets.gallery.gallery-sheet.p.read",
                                          "Read {detail}",
                                          { detail: timeAgo(data.fetchedAt) },
                                      )
                                    : t(
                                          "web.sheets.gallery.gallery-sheet.p.not-read-yet",
                                          "Not read yet",
                                      )
                            }
                        </p>
                        ${
                            hidden.incompatible > 0 &&
                            html`<p class="muted small">
                                ${counted(
                                    hidden.incompatible,
                                    t(
                                        "web.sheets.gallery.gallery-sheet.p.one-entry-needs-newer",
                                        "1 entry needs a newer Pi Pocket.",
                                    ),
                                    t(
                                        "web.sheets.gallery.gallery-sheet.p.entries-need-newer",
                                        "{count} entries need a newer Pi Pocket.",
                                        { count: hidden.incompatible },
                                    ),
                                )}
                            </p>`
                        }
                        ${
                            hidden.invalid.length > 0 &&
                            html`<ul class="gallery-problems small">
                                ${hidden.invalid.map(
                                    (each, index) => html`<li key=${index}>
                                        ${each.name ? `${each.name}: ` : ""}${each.problem}
                                    </li>`,
                                )}
                            </ul>`
                        }
                        ${
                            data.repoUrl &&
                            html`<${Out} class="button small" href=${data.repoUrl}>
                                ${t(
                                    "web.sheets.gallery.gallery-sheet.text.submit-yours",
                                    "Submit yours",
                                )} <${Icon} name="external" size=${14} />
                            <//>`
                        }
                    </details>`
                }
            </div>
            <div class="extension-hub-detail">
                ${
                    detailName
                        ? html`${
                              !sheetBack &&
                              html`<button class="ext-back" onClick=${() => openSheet({ type: origin, tab })}>
                                  <${Icon} name="back" size=${16} /> ${t(
                                      "web.sheets.gallery.gallery-sheet.text.back",
                                      "Back to {detail}",
                                      {
                                          detail: tabLabel(tab),
                                      },
                                  )}
                              </button>`
                          }
                          <${GalleryEntrySheet}
                              key=${detailName}
                              name=${detailName}
                              listing=${listing}
                              reach=${reach}
                              reachProblem=${reachProblem}
                              module=${modules?.find((each) => each.file === `${detailName}.ts`) ?? null}
                              embedded=${true}
                          />`
                        : html`<div class="extension-hub-empty">${t("web.sheets.gallery.gallery-sheet.div.choose-one-see", "Choose one to see what it does.")}</div>`
                }
            </div>
        </div>
    <//>`;
}

/** What a module declares, group by group: "nothing" for an empty one. */
function Declares({ declares }) {
    return html`<dl class="pi-facts gallery-declares">
        ${GROUPS.map(
            ([key, label]) => html`<div key=${key}>
                <dt>${label()}</dt>
                ${
                    declared(declares, key).length > 0
                        ? html`<dd class="mono">${declared(declares, key).join(", ")}</dd>`
                        : html`<dd class="muted">${t(
                              "web.sheets.gallery.declares.dd.nothing",
                              "nothing",
                          )}</dd>`
                }
            </div>`,
        )}
        <div>
            <dt>${t("web.sheets.gallery.declares.dt.browser-module", "Browser module")}</dt>
            ${
                declares.client === null
                    ? html`<dd class="muted">${t(
                          "web.sheets.gallery.declares.dd.nothing",
                          "nothing",
                      )}</dd>`
                    : html`<dd>${t("web.sheets.gallery.declares.dd.for-access", "for {who}", {
                          who: accessWords(declares.client),
                      })}</dd>`
            }
        </div>
        <div>
            <dt>${t("web.sheets.gallery.declares.dt.widest-access", "Widest access")}</dt>
            <dd>${accessWords(declares.access)}</dd>
        </div>
    </dl>`;
}

/**
 * Ask Pi to review an installed extension: a new session in the drop-in folder, in plan mode, with the review prompt.
 * Pi reads code that may hold instructions to it: without plan mode, which blocks its edits and commands that change
 * things, the review is not sent.
 */
async function askForReview(name) {
    if (!planAvailable()) {
        throw new Error(
            t(
                "web.sheets.gallery.ask-for-review.text.review-runs-plan-mode",
                "The review runs in plan mode, which is off: turn Plan mode on in Extensions first.",
            ),
        );
    }

    const { cwd, prompt } = await galleryApi(`review/${encodeURIComponent(name)}`);
    const { id } = await actions.createSession(cwd);

    try {
        await api(`c/${id}/plan`, { on: true });
    } catch (error) {
        navigate(id);

        throw new Error(
            t(
                "web.sheets.gallery.ask-for-review.text.plan-mode-not-turn",
                "Plan mode did not turn on ({error}), so the review was not sent.",
                { error: error.message },
            ),
        );
    }

    await api(`c/${id}/submit`, { text: prompt, requestId: uid() });
    closeSheet();
    navigate(id);
    notify(
        "info",
        t(
            "web.sheets.gallery.ask-for-review.text.pi-reviews-plan-mode",
            "Pi reviews it in plan mode: it reads the files, and plan mode keeps it from changing them.",
        ),
    );
}

/** Turn an installed extension on (once the owner said they trust it, in its entry) or off. */
async function setEnabled(installed, enabled) {
    // The server tells every tab who turned it on or off, this one too.
    await api(`extensions/${encodeURIComponent(installed.file)}`, { enabled });

    return true;
}

/** Embedded detail is content, not a second dialog inside the hub. */
function EntryFrame({ embedded, title, children }) {
    return embedded
        ? html`<div class="gallery-entry-content">${children}</div>`
        : html`<${Sheet}
              title=${title}
              onClose=${closeSheet}
              wide=${true}
              className="gallery extension-detail-sheet"
          >
              ${children}
          <//>`;
}

/** A newer version waits: one calm line, and the review that shows what it changes. */
const UpdateCallout = ({ installed, name, busy }) =>
    installed?.update &&
    html`<div class="ext-callout">
        <span class="grow">${t(
            "web.sheets.gallery.update-callout.span.version-ready-see-changes",
            "Version {version} is ready. See what changes first.",
            { version: installed.update.version },
        )}</span>
        <button
            class="button small primary"
            disabled=${busy}
            onClick=${() => openGallerySheet("gallery-update", name)}
        >
            ${t("web.sheets.gallery.update-callout.button.review-update", "Review update")}
        </button>
    </div>`;

/** Files that are not as installed: edited since, or gone. */
const Changed = ({ installed }) =>
    installed?.changed.length > 0 &&
    html`<div class="gallery-warn small">
        ${t("web.sheets.gallery.changed.div.not-installed-edited-since", "Not as installed (edited since, or gone):")} <span class="mono">${installed.changed.join(", ")}</span>
    </div>`;

/** Removing it, kept apart at the end and quiet, with what it does. */
const Remove = ({ label, text, busy, onClick }) =>
    html`<div class="ext-remove">
        <button class="button small ghost" disabled=${busy} onClick=${onClick}>${label}</button>
        <span class="muted small">${text}</span>
    </div>`;

/** The files the index pins, with their sizes. */
const Files = ({ files }) =>
    files &&
    html`<div class="group">
        <div class="group-title">${t("web.sheets.gallery.files.div.files", "Files")}</div>
        <div class="sheet-list gallery-files">
            ${files.map(
                (file) => html`<div class="gallery-file" key=${file.name}>
                    <span class="mono">${file.name}</span>
                    <span class="muted small">${formatBytes(file.size)}</span>
                </div>`,
            )}
        </div>
    </div>`;

/** The facts both kinds of entry show: who made it, its version, where its files are, what it needs, and when. */
function EntryFacts({ entry, installed, needs }) {
    const version = installed?.version ?? entry.version;
    const repo = installed?.repo ?? entry.source.repo;
    const commit = installed?.commit ?? entry.source.commit;

    return html`<dl class="pi-facts">
        ${
            entry &&
            html`<div>
                <dt>${t("web.sheets.gallery.entry-facts.dt.author", "Author")}</dt>
                <dd>
                    ${entry.author.name}
                    ${
                        entry.author.github &&
                        html` · <${Out} href=${`https://github.com/${entry.author.github}`}>@${entry.author.github}<//>`
                    }
                </dd>
            </div>`
        }
        <div>
            <dt>${t("web.sheets.gallery.entry-facts.dt.version", "Version")}</dt>
            <dd>
                ${version}${
                    installed?.update
                        ? html`<span class="warn">${t(
                              "web.sheets.gallery.entry-facts.span.available",
                              "· {version} available",
                              { version: installed.update.version },
                          )}</span>`
                        : ""
                }
            </dd>
        </div>
        <div>
            <dt>${t("web.sheets.gallery.entry-facts.dt.source", "Source")}</dt>
            <dd class="mono">
                <${Out} href=${installed?.sourceUrl ?? entry.sourceUrl}>${repo} @ ${short(commit)}<//>
            </dd>
        </div>
        ${
            entry &&
            html`<div>
                <dt>${t("web.sheets.gallery.entry-facts.dt.needs", "Needs")}</dt>
                <dd>${needs}</dd>
            </div>`
        }
        ${
            installed &&
            html`<div>
                <dt>${t("web.sheets.gallery.entry-facts.dt.installed", "Installed")}</dt>
                <dd>
                    ${timeAgo(installed.installedAt)}${installed.unlisted ? ` · ${installed.unlisted}` : ""}
                </dd>
            </div>`
        }
    </dl>`;
}

/** What the scan reads, in words: the categories it reports finding nothing in. */
const missingWords = (key) => {
    if (key === "network") {
        return t("web.sheets.gallery.reach-section.missing.network", "network");
    }

    if (key === "keys") {
        return t("web.sheets.gallery.reach-section.missing.keys", "keys");
    }

    if (key === "programs") {
        return t("web.sheets.gallery.reach-section.missing.programs", "programs");
    }

    return t("web.sheets.gallery.reach-section.missing.files", "files");
};

function ReachSection({ declares, found, problem, edited = false }) {
    const rows = reachRows(declares, found);
    const missing = found?.scanned
        ? ["network", "keys", "programs", "files"].filter((key) => found.scanned[key].length === 0)
        : [];

    return html`<section class="ext-block">
        <h4 class="ext-label">${t(
            "web.sheets.gallery.reach-section.h4.reach",
            "What it can reach",
        )}</h4>
        ${
            edited &&
            html`<p class="ext-why warn">
                ${t(
                    "web.sheets.gallery.reach-section.p.files-edited-since-installed",
                    "Its files were edited since it was installed: this is what the pinned version reaches, not what runs here. Read its source.",
                )}
            </p>`
        }
        <ul class="ext-reach">
            ${rows.map(
                (row) => html`<li key=${row.key}>
                    <${Icon} name=${row.glyph} size=${14} />
                    <span class="ext-reach-text">${row.text}</span>
                    <span class="ext-reach-from">${row.from}</span>
                </li>`,
            )}
            <li class="always">
                <${Icon} name="shield" size=${14} />
                <span class="ext-reach-text">${t(
                    "web.sheets.gallery.risk.runs-inside-server-rights",
                    "It runs inside the server with your rights, in every session. Lancet Guard does not see what its code does.",
                )}</span>
                <span class="ext-reach-from">${t(
                    "web.sheets.gallery.reach-section.span.always",
                    "Always",
                )}</span>
            </li>
        </ul>
        ${
            missing.length > 0 &&
            html`<p class="ext-quiet">
                ${t(
                    "web.sheets.gallery.reach-section.p.scan-found-nothing-reads",
                    "The scan found nothing for {detail}. It reads the code's text for addresses, keys, programs, and files, so the code can still reach more than it finds.",
                    { detail: sentence(missing.map(missingWords)) },
                )}
            </p>`
        }
        ${
            !found &&
            html`<p class="ext-quiet">
                ${
                    problem ??
                    t(
                        "web.sheets.gallery.reach-section.text.code-not-read-yet",
                        "Its code is not read yet for this version: what it reaches in its code shows here once it is.",
                    )
                }
            </p>`
        }
    </section>`;
}

function AddsSection({ declares: d }) {
    const readOnly = d.readOnlyTools ?? [];
    const tools = [...new Set([...(d.tools ?? []), ...readOnly])];
    const commands = (d.commands ?? []).map((each) => {
        const [scope, name] = each.split(" ");

        return [
            `/${name}`,
            scope === "global"
                ? t("web.sheets.gallery.adds-section.commands.owner", "owner")
                : t("web.sheets.gallery.adds-section.commands.who-steer", "who can steer"),
        ];
    });
    const routes = (d.routes ?? []).length;
    const app = [
        d.client !== null &&
            t("web.sheets.gallery.adds-section.app.pages-buttons", "pages and buttons"),
        routes > 0 &&
            counted(
                routes,
                t("web.sheets.gallery.adds-section.app.one-server-route", "1 server route"),
                t("web.sheets.gallery.adds-section.app.server-routes", "{count} server routes", {
                    count: routes,
                }),
            ),
    ].filter(Boolean);

    if (tools.length + commands.length + app.length === 0) {
        return html`<section class="ext-block">
            <h4 class="ext-label">${t(
                "web.sheets.gallery.adds-section.h4.what-it-adds",
                "What it adds",
            )}</h4>
            <p class="ext-quiet">${t(
                "web.sheets.gallery.adds-section.p.no-tools-commands-pages",
                "No tools, commands, or pages.",
            )}</p>
        </section>`;
    }

    return html`<section class="ext-block">
        <h4 class="ext-label">${t(
            "web.sheets.gallery.adds-section.h4.what-it-adds",
            "What it adds",
        )}</h4>
        ${
            tools.length > 0 &&
            html`<div class="ext-codes">
                ${tools.map(
                    (tool) => html`<code key=${tool}>
                        ${tool}${
                            readOnly.includes(tool) &&
                            html`<span>${t(
                                "web.sheets.gallery.adds-section.span.reads",
                                "reads only",
                            )}</span>`
                        }
                    </code>`,
                )}
            </div>`
        }
        ${
            commands.length > 0 &&
            html`<div class="ext-codes">
                ${commands.map(([name, who]) => html`<code key=${name}>${name}<span>${who}</span></code>`)}
            </div>`
        }
        ${
            app.length > 0 &&
            html`<p class="ext-quiet">
                <${Icon} name="tiles" size=${13} />
                ${t(
                    "web.sheets.gallery.adds-section.text.app",
                    "{detail}{detail2} in the app, for {access}",
                    {
                        detail: `${sentence(app).charAt(0).toUpperCase()}${sentence(app).slice(1)}`,
                        detail2: "",
                        access: accessWords(d.access),
                    },
                )}
            </p>`
        }
    </section>`;
}

function TurnOnDialog({ title, declares, found, installed, busy, onCancel, onOff, onOn }) {
    const box = useRef(null);
    const rows = reachRows(declares, found);
    // While it installs or turns on, the question stays: closing it would hide code about to run.
    const cancel = () => !busy && onCancel();

    useEffect(() => {
        const opener = document.activeElement;

        box.current?.querySelector("[data-cancel]")?.focus();

        return () => opener?.isConnected && opener.focus({ preventScroll: true });
    }, []);

    const onKeyDown = (event) => {
        if (event.key === "Escape" && !event.isComposing && event.keyCode !== 229) {
            event.preventDefault();
            event.stopPropagation();
            cancel();

            return;
        }

        if (event.key === "Tab") {
            const stops = [...box.current.querySelectorAll("button:not(:disabled)")];
            const at = stops.indexOf(document.activeElement);
            const next = event.shiftKey
                ? at <= 0
                    ? stops.at(-1)
                    : stops[at - 1]
                : at === stops.length - 1
                  ? stops[0]
                  : stops[at + 1];

            event.preventDefault();
            event.stopPropagation();
            next?.focus();
        }
    };

    return html`<div
        class="ext-dialog-scrim"
        onMouseDown=${(event) => event.target === event.currentTarget && cancel()}
    >
        <div
            class="ext-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ext-dialog-title"
            ref=${box}
            onKeyDown=${onKeyDown}
        >
            <h3 id="ext-dialog-title">${
                installed
                    ? t("web.sheets.gallery.turn-on-dialog.h3.turn-title", "Turn on {title}?", {
                          title,
                      })
                    : t(
                          "web.sheets.gallery.turn-on-dialog.h3.install-turn-title",
                          "Install and turn on {title}?",
                          { title },
                      )
            }</h3>
            <p>${t(
                "web.sheets.gallery.risk.runs-inside-server-rights",
                "It runs inside the server with your rights, in every session. Lancet Guard does not see what its code does.",
            )}</p>
            ${
                installed?.changed.length > 0 &&
                html`<p class="ext-why warn">
                    ${t(
                        "web.sheets.gallery.turn-on-dialog.p.files-edited-since-installed",
                        "Its files were edited since it was installed: this is what the pinned version reaches, not what runs here.",
                    )}
                </p>`
            }
            ${
                rows.length > 0
                    ? html`<ul class="ext-reach compact">
                          ${rows.map(
                              (row) => html`<li key=${row.key}>
                                  <${Icon} name=${row.glyph} size=${14} />
                                  <span class="ext-reach-text">${row.text}</span>
                              </li>`,
                          )}
                      </ul>
                      <p class="ext-quiet">
                          ${t(
                              "web.sheets.gallery.turn-on-dialog.p.scan-reads-text-code",
                              "The scan reads text, so the code can still reach more.",
                          )}
                      </p>`
                    : found
                      ? html`<p class="ext-quiet">
                            ${t(
                                "web.sheets.gallery.turn-on-dialog.p.scan-code-found-no",
                                "The scan of its code found no address, key, program, or file, and it declares no hooks. The scan reads text, so the code can still reach more.",
                            )}
                        </p>`
                      : html`<p class="ext-quiet">${t("web.sheets.gallery.turn-on-dialog.p.code-not-read-yet", "Its code is not read yet: read it with View source first.")}</p>`
            }
            <div class="ext-dialog-actions">
                <button class="button small" data-cancel disabled=${busy} onClick=${cancel}>${t("web.sheets.gallery.turn-on-dialog.button.cancel", "Cancel")}</button>
                ${
                    !installed &&
                    html`<button class="button small" disabled=${busy} onClick=${onOff}>
                        ${t(
                            "web.sheets.gallery.turn-on-dialog.button.install-turned-off",
                            "Install turned off",
                        )}
                    </button>`
                }
                <button class="button small primary" disabled=${busy} onClick=${onOn}>
                    ${
                        installed
                            ? t("web.sheets.gallery.turn-on-dialog.button.turn", "Turn on")
                            : t(
                                  "web.sheets.gallery.turn-on-dialog.button.install-turn",
                                  "Install and turn on",
                              )
                    }
                </button>
            </div>
        </div>
    </div>`;
}

function EntryHead({ name, title, entry, installed, theme, size }) {
    const meta = [
        entry?.author?.name ??
            (installed?.unlisted
                ? t("web.sheets.gallery.entry-head.meta.not-index", "not in the index")
                : null),
        `v${installed?.version ?? entry?.version}`,
        entry &&
            counted(
                entry.files.length,
                t("web.sheets.gallery.entry-head.meta.one-file", "1 file"),
                t("web.sheets.gallery.entry-head.meta.files", "{count} files", {
                    count: entry.files.length,
                }),
            ),
        size > 0 && formatBytes(size),
        theme && t("web.sheets.gallery.entry-head.meta.theme", "theme"),
    ].filter(Boolean);

    return html`<header class="ext-detail-head">
        <${Tile} name=${name} title=${title} icon=${theme ? "palette" : null} large=${true} />
        <div class="ext-detail-name">
            <h3 class="pi-title">${title}</h3>
            <div class="ext-detail-by">${meta.join(" · ")}</div>
        </div>
    </header>`;
}

export function GalleryEntrySheet({
    name,
    listing,
    reach = null,
    reachProblem = null,
    module = null,
    embedded = false,
}) {
    const { data, problem, load } = useListing(listing);
    const [busy, setBusy] = useState(false);
    // Set at once, not at the next render: a second tap in the same moment must not run it twice.
    const going = useRef(false);
    const [asking, setAsking] = useState(false);
    const entry = data?.entries.find((each) => each.name === name) ?? null;
    const installed =
        entry?.installed ?? data?.installed.find((each) => each.name === name) ?? null;

    const run = (work, reload = true) => {
        if (going.current) {
            return;
        }

        going.current = true;
        setBusy(true);
        attempt(work).finally(() => {
            going.current = false;
            setBusy(false);

            if (reload) {
                load();
            }
        });
    };

    if (!entry && !installed) {
        return html`<${EntryFrame} title=${t(
            "web.sheets.gallery.gallery-entry-sheet.title.extension",
            "Extension",
        )} embedded=${embedded}>
            ${problem && html`<div class="error-box small">${problem}</div>`}
            ${
                data === null
                    ? !problem &&
                      html`<${Loader} label=${t(
                          "web.sheets.gallery.gallery-entry-sheet.label.reading-the-index",
                          "Reading the index",
                      )} />`
                    : html`<p class="muted">${t(
                          "web.sheets.gallery.gallery-entry-sheet.p.index-not-list-installed",
                          "The index does not list {name}, and it is not installed.",
                          { name },
                      )}</p>`
            }
        <//>`;
    }

    const found = foundFor(reach, entry, installed);

    if (isTheme(entry ?? installed)) {
        return html`<${ThemeEntry}
            name=${name}
            entry=${entry}
            installed=${installed}
            palette=${paletteOf(entry ?? installed, found)}
            problem=${problem}
            busy=${busy}
            run=${run}
            embedded=${embedded}
        />`;
    }

    const title = installed?.title ?? entry.title;
    const declares = installed?.declares ?? entry.declares;
    const files =
        entry && (!installed || entry.source.commit === installed.commit) ? entry.files : null;
    const offeredRevoked = !installed && entry ? revocation(entry, entry.source.commit) : undefined;
    const on = installed?.enabled && installed.revoked === null;
    const status = installed ? liveStatus(installed, module, "installed") : null;
    const why = installed ? statusWhy(installed, module) : null;

    // Bound to the manifest the owner saw (`pin`): when the index changed since, the server refuses with 409, and the
    // entry is read again (run's reload) for the owner to look at once more.
    const install = (andOn) =>
        run(async () => {
            const result = await galleryApi(`install/${encodeURIComponent(name)}`, {
                pin: entry.pin,
            });

            if (andOn) {
                await setEnabled(result, true);
            }

            setAsking(false);
        });

    const toggle = (enabled) =>
        run(async () => {
            await setEnabled(installed, enabled);
            setAsking(false);
        });

    const uninstall = () => {
        if (
            confirm(
                t(
                    "web.sheets.gallery.gallery-entry-sheet.uninstall.confirm.remove-files-deleted-extensions",
                    "Remove {title}?\n\n{detail} files are deleted from the extensions folder.",
                    {
                        title,
                        detail: installed.enabled
                            ? t(
                                  "web.sheets.gallery.gallery-entry-sheet.uninstall.confirm.turned-off-first",
                                  "It is turned off first, then its",
                              )
                            : t(
                                  "web.sheets.gallery.gallery-entry-sheet.uninstall.confirm.content",
                                  "Its",
                              ),
                    },
                ),
            )
        ) {
            run(() => galleryApi(`uninstall/${encodeURIComponent(name)}`, {}));
        }
    };

    const source = html`<button
        class="button small"
        disabled=${busy}
        onClick=${() => openGallerySheet("gallery-source", name)}
    >
        ${t("web.sheets.gallery.gallery-entry-sheet.button.view-source", "View source")}
    </button>`;
    const askPi = html`<button class="button small" disabled=${busy} onClick=${() => run(() => askForReview(name), false)}>
        <${Icon} name="sparkle" size=${14} /> ${t(
            "web.sheets.gallery.gallery-entry-sheet.text.ask-pi-to-review",
            "Ask Pi to review",
        )}
    </button>`;
    const revoked = installed?.revoked ?? offeredRevoked;

    return html`<${EntryFrame} title=${title} embedded=${embedded}>
        ${problem && html`<div class="error-box small">${problem}</div>`}
        ${
            revoked !== null &&
            revoked !== undefined &&
            html`<div class="error-box gallery-revoked" role="alert">
                <strong>${t(
                    "web.sheets.gallery.gallery-entry-sheet.strong.gallery-revoked-version",
                    "The gallery revoked this version.",
                )}</strong> ${t(
                    "web.sheets.gallery.gallery-entry-sheet.strong.reason",
                    "Its reason: {revoked} {detail}",
                    { revoked, detail: "" },
                )}
                ${
                    installed?.enabled &&
                    html`<div class="sheet-actions">
                        <button class="button small primary" disabled=${busy} onClick=${() => toggle(false)}>
                            ${t(
                                "web.sheets.gallery.gallery-entry-sheet.button.turn-it-off",
                                "Turn it off",
                            )}
                        </button>
                    </div>`
                }
            </div>`
        }
        <${EntryHead} name=${name} title=${title} entry=${entry} installed=${installed} />
        ${entry?.description && html`<p class="gallery-description">${entry.description}</p>`}
        <${UpdateCallout} installed=${installed} name=${name} busy=${busy} />
        ${
            status &&
            html`<div class="ext-standing">
                <${Status} status=${status} />
                <span class="muted small">
                    ${
                        on
                            ? t(
                                  "web.sheets.gallery.gallery-entry-sheet.span.runs-every-session",
                                  "Runs in every session.",
                              )
                            : installed.revoked === null
                              ? t(
                                    "web.sheets.gallery.gallery-entry-sheet.span.installed-turned-off-nothing",
                                    "Installed, turned off: nothing runs.",
                                )
                              : ""
                    }
                </span>
            </div>`
        }
        ${why && html`<div class=${`ext-why ${why.kind} small`}>${why.text}</div>`}
        <div class="ext-actions">
            ${
                !installed
                    ? html`<button
                              class="button small primary"
                              disabled=${busy || offeredRevoked !== undefined}
                              onClick=${() => setAsking(true)}
                          >
                              ${t(
                                  "web.sheets.gallery.gallery-entry-sheet.button.install-turn",
                                  "Install and turn on",
                              )}
                          </button>
                          <button
                              class="button small"
                              disabled=${busy || offeredRevoked !== undefined}
                              onClick=${() => install(false)}
                          >
                              ${t(
                                  "web.sheets.gallery.turn-on-dialog.button.install-turned-off",
                                  "Install turned off",
                              )}
                          </button>
                          ${source}`
                    : on
                      ? html`<button class="button small" disabled=${busy} onClick=${() => toggle(false)}>
                                ${t(
                                    "web.sheets.gallery.gallery-entry-sheet.button.turn-off",
                                    "Turn off",
                                )}
                            </button>
                            <button
                                class="button small"
                                disabled=${busy}
                                onClick=${() =>
                                    run(() =>
                                        api(
                                            `extensions/${encodeURIComponent(installed.file)}/reload`,
                                            {},
                                        ),
                                    )}
                            >
                                <${Icon} name="reload" size=${14} /> ${t(
                                    "web.sheets.gallery.gallery-entry-sheet.text.reload",
                                    "Reload",
                                )}
                            </button>
                            ${source} ${askPi}`
                      : html`${
                            installed.revoked === null &&
                            html`<button class="button small primary" disabled=${busy} onClick=${() => setAsking(true)}>
                                ${t(
                                    "web.sheets.gallery.gallery-entry-sheet.button.turn-on",
                                    "Turn on",
                                )}
                            </button>`
                        }
                        ${source} ${askPi}`
            }
        </div>
        <${Changed} installed=${installed} />
        <${ReachSection}
            declares=${declares}
            found=${found}
            problem=${reachProblem}
            edited=${installed?.changed.length > 0}
        />
        <${AddsSection} declares=${declares} />
        ${
            entry?.tags.length > 0 &&
            html`<p class="ext-tags">${entry.tags.map((tag) => html`<span key=${tag}>#${tag}</span>`)}</p>`
        }
        <details class="gallery-technical">
            <summary>${t(
                "web.sheets.gallery.gallery-entry-sheet.summary.technical-details",
                "Technical details",
            )}</summary>
            <${EntryFacts}
                entry=${entry}
                installed=${installed}
                needs=${
                    entry &&
                    t(
                        "web.sheets.gallery.entry-facts.text.needs-extension-api",
                        "Pi Pocket {pocket} or newer · extension API {api}",
                        { pocket: entry.minPocket, api: entry.pocketApi },
                    )
                }
            />
            <${Files} files=${files} />
            <div class="group">
                <div class="group-title">${t(
                    "web.sheets.gallery.gallery-entry-sheet.div.everything-it-declares",
                    "Everything it declares",
                )}</div>
                <${Declares} declares=${declares} />
            </div>
        </details>
        ${
            installed &&
            html`<${Remove}
                label=${t("web.sheets.gallery.gallery-entry-sheet.label.uninstall", "Uninstall")}
                text=${
                    installed.enabled
                        ? t(
                              "web.sheets.gallery.gallery-entry-sheet.text.turns-off-deletes",
                              "Turns it off and deletes its files.",
                          )
                        : t(
                              "web.sheets.gallery.gallery-entry-sheet.text.deletes-files",
                              "Deletes its files.",
                          )
                }
                busy=${busy}
                onClick=${uninstall}
            />`
        }
        ${
            asking &&
            html`<${TurnOnDialog}
                title=${title}
                declares=${declares}
                found=${found}
                installed=${installed}
                busy=${busy}
                onCancel=${() => setAsking(false)}
                onOff=${() => install(false)}
                onOn=${() => (installed ? toggle(true) : install(true))}
            />`
        }
    <//>`;
}

function themeChanges(files, palette) {
    const names = (files ?? []).map((file) => file.name);
    const fonts = [
        ...new Set(
            names
                .filter((file) => /\.(woff2?|ttf|otf)$/i.test(file))
                .map((file) =>
                    file
                        .split("/")
                        .pop()
                        .replace(/\.(woff2?|ttf|otf)$/i, "")
                        .replace(/[-_](Roman|Italic|Regular|Bold|Variable|VF).*$/i, "")
                        .replace(/([a-z])([A-Z0-9])/g, "$1 $2"),
                ),
        ),
    ];
    const images = names.filter((file) => /\.(png|jpe?g|webp|avif|gif|svg)$/i.test(file));

    return [
        [
            "swatch",
            palette
                ? t("web.sheets.gallery.theme-changes.text.colors", "Colors, {detail}", {
                      detail: modeWords(palette),
                  })
                : t("web.sheets.gallery.theme-changes.text.own-colors", "Its own colors"),
        ],
        names.some((file) => file.endsWith("layout.css")) && [
            "tiles",
            t(
                "web.sheets.gallery.theme-changes.text.layout-own-moves-restyles",
                "A layout of its own: it moves and restyles parts of the app",
            ),
        ],
        fonts.length > 0 && [
            "file",
            t("web.sheets.gallery.theme-changes.text.own", "Its own {count}: {detail}", {
                count:
                    fonts.length === 1
                        ? t("web.sheets.gallery.theme-changes.text.font", "font")
                        : t("web.sheets.gallery.theme-changes.text.fonts", "fonts"),
                detail: sentence(fonts),
            }),
        ],
        images.length > 0 && [
            "artifact",
            counted(
                images.length,
                t("web.sheets.gallery.theme-changes.text.one-image", "1 image", {
                    count: images.length,
                }),
                t("web.sheets.gallery.theme-changes.text.images", "{count} images", {
                    count: images.length,
                }),
            ),
        ],
    ].filter(Boolean);
}

/** A palette role's name as the sheet shows it; a role this does not know stays as the palette key. */
const roleLabel = (key) => {
    if (key === "background") {
        return t("web.sheets.gallery.swatches.text.background", "background");
    }

    if (key === "foreground") {
        return t("web.sheets.gallery.swatches.text.foreground", "foreground");
    }

    if (key === "accent") {
        return t("web.sheets.gallery.swatches.text.accent", "accent");
    }

    if (key === "red") {
        return t("web.sheets.gallery.swatches.text.red", "red");
    }

    if (key === "yellow") {
        return t("web.sheets.gallery.swatches.text.yellow", "yellow");
    }

    if (key === "green") {
        return t("web.sheets.gallery.swatches.text.green", "green");
    }

    if (key === "cyan") {
        return t("web.sheets.gallery.swatches.text.cyan", "cyan");
    }

    if (key === "blue") {
        return t("web.sheets.gallery.swatches.text.blue", "blue");
    }

    if (key === "magenta") {
        return t("web.sheets.gallery.swatches.text.magenta", "magenta");
    }

    return key;
};

/** The mono line's word for a role: the same names, with "text" for the foreground. */
const textLabel = (key) =>
    key === "foreground" ? t("web.sheets.gallery.swatches.text.text", "text") : roleLabel(key);

const Swatches = ({ colors }) =>
    html`<div class="ext-swatches">
        ${["background", "foreground", "accent", ...THEME_DOTS]
            .filter((key) => HEX.test(colors[key] ?? ""))
            .map(
                (key) =>
                    html`<i key=${key} style=${`background:${colors[key]}`} title=${`${roleLabel(key)} ${colors[key]}`}></i>`,
            )}
        <span class="mono">
            ${["background", "foreground", "accent"]
                .filter((key) => HEX.test(colors[key] ?? ""))
                .map((key) => `${textLabel(key)} ${colors[key]}`)
                .join(" · ")}
        </span>
    </div>`;

function ThemeEntry({ name, entry, installed, palette, problem, busy, run, embedded }) {
    const title = installed?.title ?? entry.title;
    const files =
        entry && (!installed || entry.source.commit === installed.commit) ? entry.files : null;
    const offeredRevoked = !installed && entry ? revocation(entry, entry.source.commit) : undefined;
    const usable = store.state.themeList?.some((each) => each.id === name && each.usable);
    const inUse = (prefs().look ?? BASE_LOOK) === name;
    const size = (entry?.files ?? []).reduce((sum, file) => sum + file.size, 0);

    const install = () =>
        run(() => galleryApi(`install/${encodeURIComponent(name)}`, { pin: entry.pin }));

    const uninstall = () => {
        if (
            confirm(
                t(
                    "web.sheets.gallery.theme-entry.uninstall.confirm.remove-theme-folder-moves",
                    "Remove the theme {title}?\n\nIts folder moves to themes/.removed/ in the data folder. Browsers that use it go back to Pocket.",
                    { title },
                ),
            )
        ) {
            run(async () => {
                await galleryApi(`uninstall/${encodeURIComponent(name)}`, {});

                if (prefs().look === name) {
                    setPrefs({ look: BASE_LOOK });
                }
            });
        }
    };

    return html`<${EntryFrame} title=${title} embedded=${embedded}>
        ${problem && html`<div class="error-box small">${problem}</div>`}
        ${
            (installed?.revoked ?? offeredRevoked) &&
            html`<div class="error-box gallery-revoked" role="alert">
                <strong>${t("web.sheets.gallery.theme-entry.strong.gallery-revoked-version", "The gallery revoked this version.")}</strong> ${t(
                    "web.sheets.gallery.theme-entry.strong.reason",
                    "Its reason: {offeredRevoked}",
                    { offeredRevoked: installed?.revoked ?? offeredRevoked },
                )}
            </div>`
        }
        <${EntryHead}
            name=${name}
            title=${title}
            entry=${entry}
            installed=${installed}
            theme=${true}
            size=${size}
        />
        <div class=${`ext-preview ${palette?.colorsLight ? "pair" : ""}`}>
            <figure>
                <${ThemeDesk} colors=${palette?.colors ?? null} big=${true} />
                <figcaption>${
                    palette
                        ? palette.colorsLight || palette.colors.mode !== "light"
                            ? t("web.sheets.gallery.theme-entry.figcaption.dark", "Dark")
                            : t("web.sheets.gallery.theme-entry.figcaption.light", "Light")
                        : t(
                              "web.sheets.gallery.theme-entry.figcaption.colors-show-once-gallery",
                              "Its colors show once the gallery reads them",
                          )
                }</figcaption>
            </figure>
            ${
                palette?.colorsLight &&
                html`<figure>
                    <${ThemeDesk} colors=${palette.colorsLight} big=${true} />
                    <figcaption>${t(
                        "web.sheets.gallery.theme-entry.figcaption.light",
                        "Light",
                    )}</figcaption>
                </figure>`
            }
        </div>
        ${entry?.description && html`<p class="gallery-description">${entry.description}</p>`}
        <${UpdateCallout} installed=${installed} name=${name} busy=${busy} />
        <div class="ext-actions">
            ${
                !installed
                    ? html`<button
                          class="button small primary"
                          disabled=${busy || offeredRevoked !== undefined}
                          onClick=${install}
                      >
                          ${t("web.sheets.gallery.theme-entry.button.install", "Install")}
                      </button>`
                    : html`<button
                              class="button small primary"
                              disabled=${!usable || inUse}
                              onClick=${(event) => chooseLook(name, event)}
                          >
                              ${
                                  inUse
                                      ? t(
                                            "web.sheets.gallery.theme-entry.button.browser",
                                            "In use in this browser",
                                        )
                                      : t(
                                            "web.sheets.gallery.theme-entry.button.browser.browser",
                                            "Use it in this browser",
                                        )
                              }
                          </button>
                          <button class="button small" onClick=${() => openSheet({ type: "appearance" })}>
                              ${t(
                                  "web.sheets.gallery.theme-entry.button.open-appearance",
                                  "Open Appearance",
                              )}
                          </button>`
            }
            <button
                class="button small"
                disabled=${busy}
                onClick=${() => openGallerySheet("gallery-source", name)}
            >
                ${t("web.sheets.gallery.theme-entry.button.view-source", "View source")}
            </button>
        </div>
        <p class="ext-quiet">
            ${
                installed
                    ? t(
                          "web.sheets.gallery.theme-entry.p.person-picks-theme-their",
                          "Each person picks a theme for their own browser: using it here changes nothing for anyone else.",
                      )
                    : t(
                          "web.sheets.gallery.theme-entry.p.installing-adds-appearance-nothing",
                          "Installing adds it to Appearance. Nothing changes until someone picks it.",
                      )
            }
        </p>
        ${
            installed?.problem &&
            html`<div class="gallery-warn small">${t(
                "web.sheets.gallery.theme-entry.div.appearance-not-offer",
                "Appearance does not offer it as it is: {problem}",
                { problem: installed.problem },
            )}</div>`
        }
        <${Changed} installed=${installed} />
        <section class="ext-block">
            <h4 class="ext-label">${t(
                "web.sheets.gallery.theme-entry.h4.changes",
                "What it changes",
            )}</h4>
            <ul class="ext-reach">
                ${themeChanges(entry?.files, palette).map(
                    ([glyph, text]) => html`<li key=${glyph}>
                        <${Icon} name=${glyph} size=${14} />
                        <span class="ext-reach-text">${text}</span>
                        <span class="ext-reach-from">${t(
                            "web.sheets.gallery.theme-entry.span.files",
                            "In its files",
                        )}</span>
                    </li>`,
                )}
                <li class="always">
                    <${Icon} name="shield" size=${14} />
                    <span class="ext-reach-text">${t(
                        "web.sheets.gallery.theme-risk.theme-css-fonts-images",
                        "A theme is CSS, fonts, and images. It runs no code, and it loads nothing from other sites. But it can hide or relabel what people see, approvals too: install only themes you trust.",
                    )}</span>
                    <span class="ext-reach-from">${t(
                        "web.sheets.gallery.theme-entry.span.always",
                        "Always",
                    )}</span>
                </li>
            </ul>
        </section>
        ${
            palette &&
            html`<section class="ext-block">
                <h4 class="ext-label">${t(
                    "web.sheets.gallery.theme-entry.h4.palette",
                    "Palette",
                )}</h4>
                <${Swatches} colors=${palette.colors} />
                ${palette.colorsLight && html`<${Swatches} colors=${palette.colorsLight} />`}
            </section>`
        }
        ${
            entry?.tags.length > 0 &&
            html`<p class="ext-tags">${entry.tags.map((tag) => html`<span key=${tag}>#${tag}</span>`)}</p>`
        }
        <details class="gallery-technical">
            <summary>${t(
                "web.sheets.gallery.theme-entry.summary.technical-details",
                "Technical details",
            )}</summary>
            <${EntryFacts}
                entry=${entry}
                installed=${installed}
                needs=${
                    entry &&
                    t(
                        "web.sheets.gallery.entry-facts.text.needs-theme-api",
                        "Pi Pocket {pocket} or newer · theme API {api}",
                        { pocket: entry.minPocket, api: entry.themeApi },
                    )
                }
            />
            <${Files} files=${files} />
        </details>
        ${
            installed &&
            html`<${Remove}
                label=${t("web.sheets.gallery.theme-entry.label.remove", "Remove")}
                text=${t(
                    "web.sheets.gallery.theme-entry.text.moves-it-themes-removed",
                    "Moves it to themes/.removed/ in the data folder.",
                )}
                busy=${busy}
                onClick=${uninstall}
            />`
        }
    <//>`;
}

/** An extension's files, to read: as installed, or downloaded from the pinned commit before it is. */
export function GallerySourceSheet({ name }) {
    const [data, setData] = useState(null);
    const [problem, setProblem] = useState(null);

    useRoute(`source/${encodeURIComponent(name)}`, setData, setProblem);

    return html`<${Sheet}
        title=${
            data
                ? t("web.sheets.gallery.gallery-source-sheet.title.source", "Source: {title}", {
                      title: data.title,
                  })
                : t("web.sheets.gallery.gallery-source-sheet.title.source.source", "Source")
        }
        onClose=${closeSheet}
        wide=${true}
        className="gallery extension-detail-sheet"
    >
        ${problem && html`<div class="error-box small">${problem}</div>`}
        ${
            !data &&
            !problem &&
            html`<${Loader} label=${t(
                "web.sheets.gallery.gallery-source-sheet.label.getting-its-files",
                "Getting its files",
            )} />`
        }
        ${
            data &&
            html`<p class="muted small">
                ${
                    data.from === "installed"
                        ? t(
                              "web.sheets.gallery.gallery-source-sheet.p.files-they-extensions-folder",
                              "The files as they are in your extensions folder.",
                          )
                        : t(
                              "web.sheets.gallery.gallery-source-sheet.p.downloaded-commit-index-pins",
                              "Downloaded from the commit the index pins, and checked against its hashes. Nothing is installed.",
                          )
                }
            </p>`
        }
        ${data?.files.map(
            (file) => html`<section class="gallery-source" key=${file.name}>
                <div class="gallery-source-head">
                    <span class="mono gallery-source-name">${file.name}</span>
                    <span class="muted small">${formatBytes(file.size)}</span>
                    ${
                        file.missing
                            ? html`<span class="pi-tag gallery-bad">${t(
                                  "web.sheets.gallery.gallery-source-sheet.span.missing",
                                  "missing",
                              )}</span>`
                            : file.pinned
                              ? html`<span class="pi-tag gallery-on" title=${t("web.sheets.gallery.gallery-source-sheet.title.matches-hash-index-pins", "Matches the hash the index pins")}>${t(
                                    "web.sheets.gallery.gallery-source-sheet.span.pinned",
                                    "✓ pinned",
                                )}</span>`
                              : html`<span class="pi-tag behind" title=${t("web.sheets.gallery.gallery-source-sheet.title.not-file-index-pins", "Not the file the index pins")}>${t("web.sheets.gallery.gallery-source-sheet.span.changed", "changed")}</span>`
                    }
                    ${
                        file.binary &&
                        html`<span class="pi-tag gallery-plain">${t(
                            "web.sheets.gallery.gallery-source-sheet.span.binary",
                            "binary",
                        )}</span>`
                    }
                </div>
                ${file.text !== null && html`<${Highlighted} class="gallery-code" text=${file.text} lang=${file.name} />`}
            </section>`,
        )}
    <//>`;
}

/** What changed in each group of declarations: lines like "Hooks: + after_tool_call". */
function declarationChanges(before, after) {
    const lines = [];

    for (const [key, label] of GROUPS) {
        const added = declared(after, key).filter((each) => !declared(before, key).includes(each));
        const removed = declared(before, key).filter(
            (each) => !declared(after, key).includes(each),
        );

        if (added.length > 0 || removed.length > 0) {
            lines.push({ key, label, added, removed });
        }
    }

    const words = (client) =>
        client === null
            ? t("web.sheets.gallery.declaration-changes.words.none", "none")
            : t("web.sheets.gallery.declaration-changes.words.content", "for {client}", {
                  client: accessWords(client),
              });

    if (before.client !== after.client) {
        lines.push({
            key: "client",
            label: () =>
                t("web.sheets.gallery.declaration-changes.label.browser-module", "Browser module"),
            from: words(before.client),
            to: words(after.client),
        });
    }

    if (before.access !== after.access) {
        lines.push({
            key: "access",
            label: () =>
                t("web.sheets.gallery.declaration-changes.label.widest-access", "Widest access"),
            from: accessWords(before.access),
            to: accessWords(after.access),
        });
    }

    return lines;
}

/** A file's change in an update, in words; a kind this does not know stays as the server wrote it. */
const changeLabel = (change) => {
    if (change === "added") {
        return t("web.sheets.gallery.gallery-update-sheet.span.change-added", "added");
    }

    if (change === "removed") {
        return t("web.sheets.gallery.gallery-update-sheet.span.change-removed", "removed");
    }

    if (change === "changed") {
        return t("web.sheets.gallery.gallery-update-sheet.span.change-changed", "changed");
    }

    if (change === "same") {
        return t("web.sheets.gallery.gallery-update-sheet.span.change-same", "same");
    }

    return change;
};

/** An update the index offers: what changes, the diff, and applying it. */
export function GalleryUpdateSheet({ name }) {
    const [data, setData] = useState(null);
    const [problem, setProblem] = useState(null);
    const [busy, setBusy] = useState(false);
    const going = useRef(false);

    const path = `update/${encodeURIComponent(name)}`;
    // Read again after the index changed: the sheet shows the update it offers now.
    const [round, setRound] = useState(0);

    useRoute(
        `${path}?round=${round}`,
        (result) => {
            setData(result);
            setProblem(null);
        },
        setProblem,
    );

    const apply = () => {
        if (going.current) {
            return;
        }

        if (
            data.enabled &&
            !confirm(
                t(
                    "web.sheets.gallery.gallery-update-sheet.apply.confirm.apply-update-new-code",
                    "Apply the update to {title}?\n\nIt is on, so the new code runs as soon as it is in place.",
                    { title: data.title },
                ),
            )
        ) {
            return;
        }

        going.current = true;
        setBusy(true);
        attempt(async () => {
            let result;

            try {
                // Bound to the manifest shown here (`pin`), and to whether it was on, as the question above said.
                result = await galleryApi(path, { pin: data.to.pin, enabled: data.enabled });
            } catch (error) {
                // The index, or the switch, changed since this preview: show the update as it stands now instead.
                if (error.status === 409) {
                    setData(null);
                    setRound(round + 1);
                }

                throw error;
            }

            if (result.restart) {
                notify(
                    "warning",
                    t(
                        "web.sheets.gallery.gallery-update-sheet.apply.s-helper-files-changed",
                        "{title}'s helper files changed while it is on: restart the server (Menu → Restart server) to load them.",
                        { title: data.title },
                    ),
                );
            }

            // A row can open review without an entry beneath it. Drop the completed review before
            // showing the entry, so Back never returns to an obsolete update preview.
            openSheet({
                type: store.state.sheet.origin ?? "extensions",
                tab: store.state.sheet.tab ?? "updates",
            });
            openGallerySheet("gallery-entry", name);
        }).finally(() => {
            going.current = false;
            setBusy(false);
        });
    };

    if (data === null) {
        return html`<${Sheet}
            title=${t("web.sheets.gallery.gallery-update-sheet.title.update", "Update")}
            onClose=${closeSheet}
            wide=${true}
            className="gallery extension-detail-sheet"
        >
            ${
                problem
                    ? html`<div class="error-box small">${problem}</div>`
                    : html`<${Loader} label=${t(
                          "web.sheets.gallery.gallery-update-sheet.label.getting-the-new-version",
                          "Getting the new version",
                      )} />`
            }
        <//>`;
    }

    const changes =
        data.declares === null ? [] : declarationChanges(data.declares.before, data.declares.after);

    return html`<${Sheet}
        title=${t("web.sheets.gallery.gallery-update-sheet.title.update.update", "Update {title}", {
            title: data.title,
        })}
        onClose=${closeSheet}
        wide=${true}
        className="gallery extension-detail-sheet"
    >
        <dl class="pi-facts">
            <div>
                <dt>${t("web.sheets.gallery.gallery-update-sheet.dt.from", "From")}</dt>
                <dd class="mono">${data.from.version} · ${short(data.from.commit)}</dd>
            </div>
            <div>
                <dt>${t("web.sheets.gallery.gallery-update-sheet.dt.to", "To")}</dt>
                <dd class="mono">
                    ${data.to.version} · <${Out} href=${data.sourceUrl}>${short(data.to.commit)}<//>
                </dd>
            </div>
        </dl>
        ${
            data.from.repo !== data.to.repo &&
            html`<div class="gallery-warn small" role="alert">
                ${t("web.sheets.gallery.gallery-update-sheet.div.comes-another-repository", "It now comes from another repository:")} <span class="mono">${data.from.repo}</span> → <span class="mono">${data.to.repo}</span>. ${t(
                    "web.sheets.gallery.gallery-update-sheet.text.make-sure-trust-new",
                    "Make sure you trust the new one.",
                )}
            </div>`
        }
        ${
            data.edited.length > 0 &&
            html`<div class="gallery-warn small" role="alert">
                ${t("web.sheets.gallery.gallery-update-sheet.div.yours-edited-since-installed", "Yours here, edited since it was installed or never part of it:")} <span class="mono">${data.edited.join(", ")}</span>. ${t(
                    "web.sheets.gallery.gallery-update-sheet.text.diff-against-your-files",
                    "The diff is against your files, and the update replaces them.",
                )}
            </div>`
        }
        ${
            data.declares === null
                ? html`<p class="muted small">
                      ${t("web.sheets.gallery.gallery-update-sheet.p.checked-every-theme-before", "It is checked as every theme is before it is in place. The version you have now goes to themes/.removed/ in the data folder.")}
                  </p>`
                : html`<div class="group">
                      <div class="group-title">${t(
                          "web.sheets.gallery.gallery-update-sheet.div.what-it-declares",
                          "What it declares",
                      )}</div>
                      ${
                          changes.length === 0
                              ? html`<p class="muted small">${t(
                                    "web.sheets.gallery.gallery-update-sheet.p.the-same-as-before",
                                    "The same as before.",
                                )}</p>`
                              : html`<dl class="pi-facts gallery-declares">
                                    ${changes.map(
                                        (change) => html`<div key=${change.key}>
                                            <dt>${change.label()}</dt>
                                            <dd>
                                                ${change.added?.length > 0 && html`<div class="mono gallery-added">+ ${change.added.join(", ")}</div>`}
                                                ${change.removed?.length > 0 && html`<div class="mono gallery-removed">− ${change.removed.join(", ")}</div>`}
                                                ${change.from !== undefined && html`<div>${change.from} → ${change.to}</div>`}
                                            </dd>
                                        </div>`,
                                    )}
                                </dl>`
                      }
                  </div>`
        }
        <div class="group">
            <div class="group-title">${t(
                "web.sheets.gallery.gallery-update-sheet.div.files",
                "Files",
            )}</div>
            <div class="sheet-list gallery-files">
                ${data.files.map(
                    (file) => html`<div class="gallery-file" key=${file.name}>
                        <span class="mono">${file.name}</span>
                        <span class=${`small gallery-change ${file.change}`}>${changeLabel(file.change)}</span>
                    </div>`,
                )}
            </div>
        </div>
        ${data.diff && html`<${DiffBlock} text=${data.diff} />`}
        ${
            data.enabled &&
            html`<p class="gallery-warn small">${t("web.sheets.gallery.gallery-update-sheet.p.new-code-runs-soon", "It is on: the new code runs as soon as it is in place.")}</p>`
        }
        <div class="gallery-actions">
            <button class="button primary" disabled=${busy} onClick=${apply}>${t(
                "web.sheets.gallery.gallery-update-sheet.button.apply-update",
                "Apply update",
            )}</button>
        </div>
    <//>`;
}

/** The rules an index entry keeps for what only its author fills in (`gallery/entry.ts`, which the index checks with). */
const OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;
const PART = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;
const TAG = /^[a-z0-9][a-z0-9-]{0,23}$/;
/** Past this, GitHub's page would refuse the link with the entry in it: the owner copies the entry instead. */
const LINK_LIMIT = 6000;

/** Why what the owner typed for each of the author's fields would not pass the index's checks, by field. */
function fieldProblems({ repo, commit, path, tags, github, name }) {
    const [owner, repository, ...rest] = repo.split("/");
    const parts = path === "" ? [] : path.split("/");

    return {
        repo:
            repo === ""
                ? t(
                      "web.sheets.gallery.field-problems.repo.give-git-hub-repository-files",
                      "Give the GitHub repository with its files.",
                  )
                : rest.length > 0 ||
                    !OWNER.test(owner ?? "") ||
                    !REPO_NAME.test(repository ?? "") ||
                    repository === "." ||
                    repository === ".."
                  ? t(
                        "web.sheets.gallery.field-problems.repo.write-owner-name-such",
                        "Write it as owner/name, such as tannermidd/pocket-clock.",
                    )
                  : null,
        commit:
            commit === ""
                ? t(
                      "web.sheets.gallery.field-problems.commit.give-commit-files",
                      "Give the commit with its files.",
                  )
                : /^[0-9a-f]{40}$/.test(commit)
                  ? null
                  : t(
                        "web.sheets.gallery.field-problems.commit.write-full-commit-id",
                        "Write the full commit ID: 40 letters and digits, from a to f and 0 to 9.",
                    ),
        path:
            parts.length > 4 || parts.some((part) => !PART.test(part))
                ? t(
                      "web.sheets.gallery.field-problems.path.write-folder-repository-such",
                      "Write a folder of the repository, such as extension, four deep at most.",
                  )
                : null,
        tags:
            tags.length > 10 || tags.some((tag) => !TAG.test(tag))
                ? t(
                      "web.sheets.gallery.field-problems.tags.up-tags-lowercase-letters",
                      "Use up to 10 tags of lowercase letters, digits, and -.",
                  )
                : null,
        github:
            github === "" || OWNER.test(github)
                ? null
                : t(
                      "web.sheets.gallery.field-problems.github.write-git-hub-name",
                      "Write your GitHub name only.",
                  ),
        name:
            name === "" || name.length > 60
                ? t(
                      "web.sheets.gallery.field-problems.name.give-name-characters-most",
                      "Give your name, 60 characters at most.",
                  )
                : null,
    };
}

/** One of the author's fields, with what is wrong with it once something is typed. */
function Field({ id, label, hint, value, onInput, problem, placeholder, mono = true }) {
    return html`<div class="field gallery-field">
        <label class="label" for=${id}>${label}</label>
        <input
            id=${id}
            class=${mono ? "mono" : ""}
            value=${value}
            placeholder=${placeholder}
            spellcheck=${false}
            autocapitalize="off"
            autocomplete="off"
            aria-invalid=${problem !== null && value !== ""}
            onInput=${(event) => onInput(event.currentTarget.value)}
        />
        ${
            problem !== null && value !== ""
                ? html`<div class="small warn">${problem}</div>`
                : hint && html`<div class="muted small">${hint}</div>`
        }
    </div>`;
}

/**
 * Share one of your own drop-ins, or with `theme`, one of your theme folders (`file` is its id): the checks, where its
 * files are on GitHub (only its author knows), its index entry made from both, and the pull request, which opens only
 * once the entry can pass the index's checks.
 */
export function GalleryShareSheet({ file, theme = false }) {
    const [data, setData] = useState(null);
    const [problem, setProblem] = useState(null);
    const [form, setForm] = useState({
        repo: "",
        commit: "",
        path: "",
        tags: "",
        github: "",
        name: null,
    });

    useRoute(`${theme ? "share-theme" : "share"}/${encodeURIComponent(file)}`, setData, setProblem);
    // A theme by its name, as Appearance shows it; a drop-in by its file.
    const shareName = theme
        ? (store.state.themeList?.find((each) => each.id === file)?.name ?? file)
        : file;

    if (!data) {
        return html`<${Sheet}
            title=${t("web.sheets.gallery.gallery-share-sheet.title.share", "Share {name}", {
                name: shareName,
            })}
            onClose=${closeSheet}
            wide=${true}
            className="gallery"
        >
            ${
                problem
                    ? html`<div class="error-box small">${problem}</div>`
                    : html`<${Loader} label=${t(
                          "web.sheets.gallery.gallery-share-sheet.label.checking-it",
                          "Checking it",
                      )} />`
            }
        <//>`;
    }

    const set = (field) => (value) => setForm({ ...form, [field]: value });
    const typed = {
        repo: form.repo
            .trim()
            .replace(/^https:\/\/github\.com\//, "")
            .replace(/(\.git)?\/*$/, ""),
        commit: form.commit.trim().toLowerCase(),
        path: form.path.trim().replace(/^\/+|\/+$/g, ""),
        tags: form.tags
            .split(/[\s,]+/)
            .map((tag) => tag.trim().toLowerCase())
            .filter(Boolean),
        github: form.github.trim().replace(/^@/, ""),
        name: (form.name ?? data.entry.author.name).trim(),
    };
    const wrong = fieldProblems(typed);
    const entry = {
        ...data.entry,
        tags: typed.tags,
        author: { name: typed.name, ...(typed.github === "" ? {} : { github: typed.github }) },
        source: {
            repo: typed.repo,
            commit: typed.commit,
            ...(typed.path === "" ? {} : { path: typed.path }),
        },
    };
    const text = `${JSON.stringify(entry, null, 4)}\n`;
    // What keeps the pull request closed, first to last: the drop-in itself, then what is still to fill in.
    const blocked =
        data.problems.length > 0
            ? t(
                  "web.sheets.gallery.gallery-share-sheet.blocked.fix-problems-above-first",
                  "Fix the problems above first.",
              )
            : !data.declaresKnown
              ? t(
                    "web.sheets.gallery.gallery-share-sheet.blocked.turn-once-declares-known",
                    "Turn it on once, so what it declares is known, then look again.",
                )
              : (Object.values(wrong).find((each) => each !== null) ?? null);
    const filled = data.newEntryPage && `${data.newEntryPage}&value=${encodeURIComponent(text)}`;
    const link = filled && filled.length <= LINK_LIMIT ? filled : data.newEntryPage;

    return html`<${Sheet}
        title=${t("web.sheets.gallery.gallery-share-sheet.title.share", "Share {name}", {
            name: shareName,
        })}
        onClose=${closeSheet}
        wide=${true}
        className="gallery"
    >
        <p class="muted small">
            ${t("web.sheets.gallery.gallery-share-sheet.p.share-add-entry-gallery", "To share it, add its entry to the gallery's index with a pull request. Pi Pocket makes no GitHub calls: you put its files on GitHub and open the pull request yourself.")}
        </p>
        ${
            data.problems.length > 0
                ? html`<div class="gallery-warn small" role="alert">
                      <strong>${t(
                          "web.sheets.gallery.gallery-share-sheet.strong.fix-these-first",
                          "Fix these first:",
                      )}</strong>
                      <ul>
                          ${data.problems.map((each, index) => html`<li key=${index}>${each}</li>`)}
                      </ul>
                  </div>`
                : html`<p class="ok small">
                      <${Icon} name="check" size=${14} /> ${t(
                          "web.sheets.gallery.gallery-share-sheet.text.stands-own",
                          "It stands on its own.",
                      )}
                  </p>`
        }
        ${
            data.notes.length > 0 &&
            html`<ul class="muted small gallery-notes">
                ${data.notes.map((each, index) => html`<li key=${index}>${each}</li>`)}
            </ul>`
        }
        <div class="group">
            <div class="group-title">${t(
                "web.sheets.gallery.gallery-share-sheet.div.put-files-git-hub",
                "1. Put its files on GitHub",
            )}</div>
            <p class="small">
                ${t("web.sheets.gallery.gallery-share-sheet.p.make-public-git-hub-repository", "Make a public GitHub repository, and commit these files to it with the same names, at its top or in one folder:")}
            </p>
            <div class="sheet-list gallery-files">
                ${data.entry.files.map(
                    (each) => html`<div class="gallery-file" key=${each.name}>
                        <span class="mono">${each.name}</span>
                        <span class="muted small">${formatBytes(each.size)}</span>
                    </div>`,
                )}
            </div>
        </div>
        <div class="group">
            <div class="group-title">${t(
                "web.sheets.gallery.gallery-share-sheet.div.say-where-they",
                "2. Say where they are",
            )}</div>
            <div class="gallery-form">
                <${Field}
                    id="share-repo"
                    label=${t("web.sheets.gallery.gallery-share-sheet.label.repository", "Repository")}
                    placeholder="owner/name"
                    value=${form.repo}
                    onInput=${set("repo")}
                    problem=${wrong.repo}
                />
                <${Field}
                    id="share-commit"
                    label=${t("web.sheets.gallery.gallery-share-sheet.label.commit", "Commit")}
                    hint=${t(
                        "web.sheets.gallery.gallery-share-sheet.hint.full-id-commit-files",
                        "The full ID of the commit with these files (git rev-parse HEAD).",
                    )}
                    placeholder=${t(
                        "web.sheets.gallery.gallery-share-sheet.placeholder.letters-digits",
                        "40 letters and digits",
                    )}
                    value=${form.commit}
                    onInput=${set("commit")}
                    problem=${wrong.commit}
                />
                <${Field}
                    id="share-path"
                    label=${t(
                        "web.sheets.gallery.gallery-share-sheet.label.folder-optional",
                        "Folder (optional)",
                    )}
                    hint=${t(
                        "web.sheets.gallery.gallery-share-sheet.hint.only-files-not-top",
                        "Only when the files are not at the top of the repository.",
                    )}
                    placeholder=${
                        theme
                            ? t("web.sheets.gallery.gallery-share-sheet.placeholder.theme", "theme")
                            : t(
                                  "web.sheets.gallery.gallery-share-sheet.placeholder.extension",
                                  "extension",
                              )
                    }
                    value=${form.path}
                    onInput=${set("path")}
                    problem=${wrong.path}
                />
                <${Field}
                    id="share-tags"
                    label=${t("web.sheets.gallery.gallery-share-sheet.label.tags", "Tags")}
                    hint=${t(
                        "web.sheets.gallery.gallery-share-sheet.hint.few-words-people-search",
                        "A few words people search for, such as {words}.",
                        {
                            words: theme
                                ? t(
                                      "web.sheets.gallery.gallery-share-sheet.hint.dark-calm",
                                      "dark, calm",
                                  )
                                : t(
                                      "web.sheets.gallery.gallery-share-sheet.hint.usage-time",
                                      "usage, time",
                                  ),
                        },
                    )}
                    placeholder=${
                        theme
                            ? t(
                                  "web.sheets.gallery.gallery-share-sheet.placeholder.dark-minimal",
                                  "dark, minimal",
                              )
                            : t(
                                  "web.sheets.gallery.gallery-share-sheet.placeholder.usage-limits",
                                  "usage, limits",
                              )
                    }
                    value=${form.tags}
                    onInput=${set("tags")}
                    problem=${wrong.tags}
                />
                <${Field}
                    id="share-name"
                    label=${t("web.sheets.gallery.gallery-share-sheet.label.your-name", "Your name")}
                    value=${form.name ?? data.entry.author.name}
                    onInput=${set("name")}
                    problem=${wrong.name}
                    mono=${false}
                />
                <${Field}
                    id="share-github"
                    label=${t(
                        "web.sheets.gallery.gallery-share-sheet.label.your-git-hub-name-optional",
                        "Your GitHub name (optional)",
                    )}
                    placeholder=${t(
                        "web.sheets.gallery.gallery-share-sheet.placeholder.octocat",
                        "octocat",
                    )}
                    value=${form.github}
                    onInput=${set("github")}
                    problem=${wrong.github}
                />
            </div>
        </div>
        <div class="group">
            <div class="gallery-entry-head">
                <div class="group-title">
                    ${t(
                        "web.sheets.gallery.gallery-share-sheet.div.entry",
                        "3. Its entry,",
                    )} <span class="mono">entries/${data.name}.json</span>
                </div>
                <button
                    class="button small"
                    onClick=${() =>
                        attempt(() =>
                            copyText(text).then(() =>
                                notify(
                                    "info",
                                    t(
                                        "web.sheets.gallery.gallery-share-sheet.text.entry-copied",
                                        "Entry copied.",
                                    ),
                                ),
                            ),
                        )}
                >
                    <${Icon} name="copy" size=${14} /> ${t(
                        "web.sheets.gallery.gallery-share-sheet.text.copy",
                        "Copy",
                    )}
                </button>
            </div>
            <${Highlighted} class="gallery-code" text=${text} lang="json" />
        </div>
        <div class="gallery-actions">
            ${
                link &&
                (blocked === null
                    ? html`<${Out} class="button primary" href=${link}>
                          ${t(
                              "web.sheets.gallery.gallery-share-sheet.text.open-a-pull-request",
                              "Open a pull request",
                          )} <${Icon} name="external" size=${14} />
                      <//>`
                    : html`<button class="button primary" disabled=${true}>${t("web.sheets.gallery.gallery-share-sheet.button.open-a-pull-request", "Open a pull request")}</button>`)
            }
            ${
                data.contributingUrl &&
                html`<${Out} class="button" href=${data.contributingUrl}>
                    ${t(
                        "web.sheets.gallery.gallery-share-sheet.text.how-to-submit",
                        "How to submit",
                    )} <${Icon} name="external" size=${14} />
                <//>`
            }
        </div>
        ${blocked !== null && link && html`<p class="muted small">${blocked}</p>`}
        ${
            blocked === null &&
            link !== filled &&
            html`<p class="muted small">
                ${t(
                    "web.sheets.gallery.gallery-share-sheet.p.entry-too-long-link",
                    "Its entry is too long for the link: copy it, and paste it on GitHub's page.",
                )}
            </p>`
        }
        ${
            !data.repoUrl &&
            html`<p class="muted small">
                ${t(
                    "web.sheets.gallery.gallery-share-sheet.p.index-not-say-where",
                    "This index does not say where to submit: ask whoever keeps it.",
                )}
            </p>`
        }
    <//>`;
}
