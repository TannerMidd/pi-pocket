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
const plural = (count, word) =>
    `${count} ${count === 1 ? word : word.endsWith("y") ? `${word.slice(0, -1)}ies` : `${word}s`}`;
const revocation = (entry, commit) => entry.revoked.find((each) => each.commit === commit)?.reason;

/** Who a browser module or a route is for, in words. */
export const ACCESS_WORDS = {
    owner: "the owner",
    steer: "people who can steer",
    view: "everyone who sees every session",
};

/** What a module declares, by group, in the order the entry and the review list them. */
const GROUPS = [
    ["extensions", "Extensions"],
    ["tools", "Tools"],
    ["readOnlyTools", "Read-only tools"],
    ["hooks", "Hooks"],
    ["sections", "Prompt sections"],
    ["wraps", "Wraps"],
    ["routes", "Routes"],
    ["commands", "Slash commands"],
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

        return `/${name} (${scope === "global" ? "owner" : "who can steer"})`;
    });

const RISK =
    "It runs inside the server with your rights, in every session. Lancet Guard does not see what its code does.";
const THEME_RISK =
    "A theme is CSS, fonts, and images. It runs no code, and it loads nothing from other sites. But it can hide or relabel what people see, approvals too: install only themes you trust.";

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
    items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items.at(-1)}` : (items[0] ?? "");

const HOOK_WORDS = {
    beforeTool: "tool calls, before they run",
    afterTool: "tool results",
    beforeRequest: "what goes to the model",
    afterResponse: "the model's replies",
    onYield: "the end of each turn",
};

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
                        ? "What its code reaches shows after a server restart (menu → Restart server)."
                        : `Its code could not be read: ${error.message}`,
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
            ["network", "globe", (items) => `Talks to ${sentence(items)}`],
            [
                "keys",
                "key",
                (items) =>
                    `Uses ${sentence(items.map((item) => item.replace(/^(.+) key from Pi$/, "your $1 key, from Pi")))}`,
            ],
            ["programs", "terminal", (items) => `Runs ${sentence(items)}`],
            ["files", "folder", (items) => `Uses ${sentence(items)}`],
        ]) {
            if (scanned[key]?.length > 0) {
                rows.push({ key, glyph, text: words(scanned[key]), from: "In its code" });
            }
        }
    }

    if ((declares.hooks ?? []).length > 0) {
        rows.push({
            key: "sees",
            glyph: "eye",
            text: `Sees ${sentence(declares.hooks.map((hook) => HOOK_WORDS[hook] ?? hook))}`,
            from: "Declared",
        });
    }

    const changes = [
        (declares.sections ?? []).length > 0 && "Adds to Pi's instructions",
        ...(declares.wraps ?? []).map((wrap) => `Wraps the ${wrap.replace(/^tool /, "")} tool`),
    ].filter(Boolean);

    if (changes.length > 0) {
        rows.push({ key: "changes", glyph: "chat", text: changes.join("; "), from: "Declared" });
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
                ? `${s.network.length} hosts`
                : RUN_TIME.test(s.network[0])
                  ? "network"
                  : s.network[0],
        ],
        s?.keys.length > 0 && ["key", s.keys.length > 1 ? `${s.keys.length} keys` : "a key"],
        s?.programs.length > 0 && [
            "terminal",
            RUN_TIME.test(s.programs.join()) ? "programs" : s.programs.join(", "),
        ],
        (d.hooks ?? []).length > 0 && ["eye", "sees turns"],
        ((d.sections ?? []).length > 0 || (d.wraps ?? []).length > 0) && ["chat", "changes Pi"],
        tools > 0 && ["sparkle", plural(tools, "tool")],
        d.client !== null && ["tiles", "in the app"],
    ]
        .filter(Boolean)
        .slice(0, 3);
}

function newReach(before, after) {
    const added = (key) =>
        declared(after, key).filter((each) => !declared(before, key).includes(each));
    const tools = [...new Set([...added("tools"), ...added("readOnlyTools")])];

    return [
        added("hooks").length > 0 &&
            `sees ${sentence(added("hooks").map((hook) => HOOK_WORDS[hook] ?? hook))}`,
        added("sections").length > 0 && "adds to Pi's instructions",
        ...added("wraps").map((wrap) => `wraps the ${wrap.replace(/^tool /, "")} tool`),
        tools.length > 0 && plural(tools.length, "new tool"),
        added("commands").length > 0 && plural(added("commands").length, "new command"),
        (added("routes").length > 0 || (before.client === null && after.client !== null)) &&
            "adds to the app",
        before.access !== after.access && `now for ${ACCESS_WORDS[after.access] ?? after.access}`,
    ].filter(Boolean);
}

function liveStatus(item, module, tab) {
    if (item.revoked !== null && item.revoked !== undefined) {
        return { kind: "bad", text: "Revoked" };
    }

    if (module?.error) {
        return { kind: "bad", text: "Did not load" };
    }

    if (module && browserModuleState(module.file.replace(/\.ts$/, ""))?.status === "failed") {
        return { kind: "warn", text: "Off in this tab" };
    }

    if (item.changed?.length > 0) {
        return { kind: "warn", text: "Edited since install" };
    }

    if (item.enabled) {
        return { kind: "on", text: "On" };
    }

    return { kind: "off", text: tab === "discover" ? "Installed" : "Off" };
}

const Status = ({ status }) =>
    html`<span class=${`ext-state ${status.kind}`}>
        <span class="ext-mark" aria-hidden="true"></span>${status.text}
    </span>`;

function statusWhy(item, module) {
    if (module?.error) {
        return { kind: "bad", text: `Did not load: ${module.error}` };
    }

    const here = module && browserModuleState(module.file.replace(/\.ts$/, ""));

    if (here?.status === "failed") {
        return {
            kind: "warn",
            text: `In this browser: ${here.error}. Reloading the page tries again.`,
        };
    }

    if (item?.revoked) {
        return { kind: "bad", text: `The gallery revoked this version: ${item.revoked}` };
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
              ${busy ? "Installing…" : "Install"}
          </button>`
        : installed.update && tab !== "installed"
          ? html`<button
                class=${`button small ${added?.length > 0 ? "" : "primary"}`}
                onClick=${() => openGallerySheet("gallery-update", entry.name)}
            >
                ${added?.length > 0 ? "Review" : "Update"}
            </button>`
          : theme
            ? html`<span class="ext-state on"><${Icon} name="check" size=${13} stroke=${2.5} />Installed</span>`
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
                                          <${Icon} name="eye" size=${12} /><span>Declares more: ${added.join("; ")}</span>
                                      </span>`
                                    : html`<span class="ext-fact"><${Icon} name="check" size=${12} /><span>Declares nothing new</span></span>`
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
        ? "theme"
        : palette.colorsLight
          ? "dark and light"
          : palette.colors.mode === "light"
            ? "light"
            : "dark";

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
        <span class="ext-theme-meta">${modeWords(palette)} · ${entry.author?.name ?? entry.author ?? "yours"}</span>
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
                <div class="muted">Index</div>
                <div class="mono gallery-address">${address}</div>
            </div>
            <button
                class="button small"
                onClick=${() => {
                    setValue(address);
                    setEditing(true);
                }}
            >
                Change
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
            Index: a GitHub repository (owner/name), or the https address of an index.json
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
                    Use the default (${fallback})
                </button>`
            }
            <button type="button" class="button small" onClick=${() => setEditing(false)}>Cancel</button>
            <button class="button small primary" disabled=${busy}>Save</button>
        </div>
    </form>`;
}

const TABS = [
    ["discover", "Discover"],
    ["installed", "Installed"],
    ["updates", "Updates"],
];

const KINDS = [
    ["all", "All", null],
    ["extensions", "Extensions", null],
    ["themes", "Themes", "palette"],
];
const WANTS = [
    ["tools", "Tools for Pi", "sparkle"],
    ["app", "In the app", "tiles"],
    ["changes", "Changes Pi", "chat"],
];

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
    show = null,
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
        state=${tab === "discover" && entry.installed ? "Installed" : null}
        onOpen=${() => select(entry.name)}
    />`;

    const tabs = html`<div class="ext-tabs" role="tablist" aria-label="Extensions">
        ${TABS.map(
            ([value, label]) => html`<button
                key=${value}
                class=${tab === value ? "on" : ""}
                role="tab"
                aria-selected=${tab === value}
                onClick=${() => changeTab(value)}
            >
                ${label}
                ${
                    value === "updates" &&
                    updates > 0 &&
                    html`<span class="ext-count" aria-label=${`${updates} available`}>${updates}</span>`
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
        html`<${Section} title="Themes" count=${themesHere.length}>
            <div class="ext-themes">
                ${themesHere.map((entry) =>
                    entry.own
                        ? html`<${ThemeCard}
                              key=${entry.name}
                              entry=${entry}
                              palette=${entry.colors ? { colors: entry.colors, colorsLight: entry.colorsLight ?? null } : null}
                              state="Yours"
                              onOpen=${() => openSheet({ type: "appearance" })}
                          />`
                        : card(entry),
                )}
            </div>
        <//>`;

    return html`<${Sheet}
        title="Extensions"
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
                                        ? "Search installed"
                                        : tab === "updates"
                                          ? "Search updates"
                                          : `Search ${offered.length || ""} extensions and themes`.replace(
                                                "  ",
                                                " ",
                                            )
                                }
                                aria-label="Search extensions and themes"
                                value=${query}
                                onInput=${(event) => setQuery(event.currentTarget.value)}
                            />
                        </label>
                        ${
                            tab !== "installed" &&
                            html`<button
                                class="button small ext-icon-button"
                                aria-label="Refresh"
                                title="Read the index again"
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
                        html`<div class="gallery-tags ext-filters" role="group" aria-label="Filters">
                            ${KINDS.map(([value, label, glyph]) =>
                                chip(`kind-${value}`, label, glyph, kind === value, () =>
                                    setKind(value),
                                ),
                            )}
                            <span class="ext-filters-gap"></span>
                            ${WANTS.map(([value, label, glyph]) =>
                                chip(value, label, glyph, want === value, () =>
                                    setWant(want === value ? null : value),
                                ),
                            )}
                        </div>`
                    }
                </div>
                ${problem && html`<div class="error-box small">${problem}</div>`}
                ${data?.error && html`<div class="error-box small">${data.error}</div>`}
                ${!data && !problem && html`<${Loader} label="Reading the index" />`}
                ${
                    tab === "discover" &&
                    extensionMatches.length > 0 &&
                    html`<${Section} title="Extensions" count=${extensionMatches.length}>
                        <div class="ext-list">${extensionMatches.map(row)}</div>
                    <//>`
                }
                ${
                    tab === "discover" &&
                    themeMatches.length > 0 &&
                    html`<${Section} title="Themes" count=${themeMatches.length}>
                        <div class="ext-themes">${themeMatches.map(card)}</div>
                    <//>`
                }
                ${
                    tab === "updates" &&
                    matches.length > 0 &&
                    html`<${Section} title="Updates" count=${matches.length}>
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
                                      <span>Everything is up to date.</span>`
                                : needle || kind !== "all" || want
                                  ? "Nothing matches. Try other words, or All."
                                  : "The index has nothing for this Pi Pocket yet."
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
                        show=${show}
                        before=${extensionMatches.length > 0 && html`<div class="ext-list">${extensionMatches.map(row)}</div>`}
                        beforeCount=${extensionMatches.length}
                        between=${installedThemes}
                    />`
                }
                ${
                    tab === "discover" &&
                    data &&
                    html`<details class="gallery-technical ext-where">
                        <summary>Where these come from</summary>
                        <${IndexAddress} address=${data.address} onChanged=${() => load(true)} />
                        <p class="muted small">
                            ${data.fetchedAt ? `Read ${timeAgo(data.fetchedAt)}` : "Not read yet"}
                        </p>
                        ${
                            hidden.incompatible > 0 &&
                            html`<p class="muted small">
                                ${plural(hidden.incompatible, "entry")} need a newer Pi Pocket.
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
                                Submit yours <${Icon} name="external" size=${14} />
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
                                  <${Icon} name="back" size=${16} /> Back to ${TABS.find(([value]) => value === tab)[1]}
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
                        : html`<div class="extension-hub-empty">Choose one to see what it does.</div>`
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
                <dt>${label}</dt>
                ${
                    declared(declares, key).length > 0
                        ? html`<dd class="mono">${declared(declares, key).join(", ")}</dd>`
                        : html`<dd class="muted">nothing</dd>`
                }
            </div>`,
        )}
        <div>
            <dt>Browser module</dt>
            ${
                declares.client === null
                    ? html`<dd class="muted">nothing</dd>`
                    : html`<dd>for ${ACCESS_WORDS[declares.client] ?? declares.client}</dd>`
            }
        </div>
        <div>
            <dt>Widest access</dt>
            <dd>${ACCESS_WORDS[declares.access] ?? declares.access}</dd>
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
            "The review runs in plan mode, which is off: turn Plan mode on in Extensions first.",
        );
    }

    const { cwd, prompt } = await galleryApi(`review/${encodeURIComponent(name)}`);
    const { id } = await actions.createSession(cwd);

    try {
        await api(`c/${id}/plan`, { on: true });
    } catch (error) {
        navigate(id);

        throw new Error(
            `Plan mode did not turn on (${error.message}), so the review was not sent.`,
        );
    }

    await api(`c/${id}/submit`, { text: prompt, requestId: uid() });
    closeSheet();
    navigate(id);
    notify(
        "info",
        "Pi reviews it in plan mode: it reads the files, and plan mode keeps it from changing them.",
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
        <span class="grow">Version ${installed.update.version} is ready. See what changes first.</span>
        <button
            class="button small primary"
            disabled=${busy}
            onClick=${() => openGallerySheet("gallery-update", name)}
        >
            Review update
        </button>
    </div>`;

/** Files that are not as installed: edited since, or gone. */
const Changed = ({ installed }) =>
    installed?.changed.length > 0 &&
    html`<div class="gallery-warn small">
        Not as installed (edited since, or gone): <span class="mono">${installed.changed.join(", ")}</span>
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
        <div class="group-title">Files</div>
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
                <dt>Author</dt>
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
            <dt>Version</dt>
            <dd>
                ${version}${installed?.update ? html`<span class="warn"> · ${installed.update.version} available</span>` : ""}
            </dd>
        </div>
        <div>
            <dt>Source</dt>
            <dd class="mono">
                <${Out} href=${installed?.sourceUrl ?? entry.sourceUrl}>${repo} @ ${short(commit)}<//>
            </dd>
        </div>
        ${
            entry &&
            html`<div>
                <dt>Needs</dt>
                <dd>${needs}</dd>
            </div>`
        }
        ${
            installed &&
            html`<div>
                <dt>Installed</dt>
                <dd>
                    ${timeAgo(installed.installedAt)}${installed.unlisted ? ` · ${installed.unlisted}` : ""}
                </dd>
            </div>`
        }
    </dl>`;
}

function ReachSection({ declares, found, problem, edited = false }) {
    const rows = reachRows(declares, found);
    const missing = found?.scanned
        ? ["network", "keys", "programs", "files"].filter((key) => found.scanned[key].length === 0)
        : [];

    return html`<section class="ext-block">
        <h4 class="ext-label">What it can reach</h4>
        ${
            edited &&
            html`<p class="ext-why warn">
                Its files were edited since it was installed: this is what the pinned version reaches, not what runs
                here. Read its source.
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
                <span class="ext-reach-text">${RISK}</span>
                <span class="ext-reach-from">Always</span>
            </li>
        </ul>
        ${
            missing.length > 0 &&
            html`<p class="ext-quiet">
                The scan found nothing for ${sentence(missing)}. It reads the code's text for addresses, keys, programs,
                and files, so the code can still reach more than it finds.
            </p>`
        }
        ${
            !found &&
            html`<p class="ext-quiet">
                ${problem ?? "Its code is not read yet for this version: what it reaches in its code shows here once it is."}
            </p>`
        }
    </section>`;
}

function AddsSection({ declares: d }) {
    const readOnly = d.readOnlyTools ?? [];
    const tools = [...new Set([...(d.tools ?? []), ...readOnly])];
    const commands = (d.commands ?? []).map((each) => {
        const [scope, name] = each.split(" ");

        return [`/${name}`, scope === "global" ? "owner" : "who can steer"];
    });
    const app = [
        d.client !== null && "pages and buttons",
        (d.routes ?? []).length > 0 && plural(d.routes.length, "server route"),
    ].filter(Boolean);

    if (tools.length + commands.length + app.length === 0) {
        return html`<section class="ext-block">
            <h4 class="ext-label">What it adds</h4>
            <p class="ext-quiet">No tools, commands, or pages.</p>
        </section>`;
    }

    return html`<section class="ext-block">
        <h4 class="ext-label">What it adds</h4>
        ${
            tools.length > 0 &&
            html`<div class="ext-codes">
                ${tools.map(
                    (tool) => html`<code key=${tool}>
                        ${tool}${readOnly.includes(tool) && html`<span>reads only</span>`}
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
                ${`${sentence(app).charAt(0).toUpperCase()}${sentence(app).slice(1)} in the app, for ${ACCESS_WORDS[d.access] ?? d.access}`}
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
            <h3 id="ext-dialog-title">${installed ? "Turn on" : "Install and turn on"} ${title}?</h3>
            <p>${RISK}</p>
            ${
                installed?.changed.length > 0 &&
                html`<p class="ext-why warn">
                    Its files were edited since it was installed: this is what the pinned version reaches, not what
                    runs here.
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
                          The scan reads text, so the code can still reach more.
                      </p>`
                    : found
                      ? html`<p class="ext-quiet">
                            The scan of its code found no address, key, program, or file, and it declares no hooks.
                            The scan reads text, so the code can still reach more.
                        </p>`
                      : html`<p class="ext-quiet">Its code is not read yet: read it with View source first.</p>`
            }
            <div class="ext-dialog-actions">
                <button class="button small" data-cancel disabled=${busy} onClick=${cancel}>Cancel</button>
                ${
                    !installed &&
                    html`<button class="button small" disabled=${busy} onClick=${onOff}>
                        Install turned off
                    </button>`
                }
                <button class="button small primary" disabled=${busy} onClick=${onOn}>
                    ${installed ? "Turn on" : "Install and turn on"}
                </button>
            </div>
        </div>
    </div>`;
}

function EntryHead({ name, title, entry, installed, theme, size }) {
    const meta = [
        entry?.author?.name ?? (installed?.unlisted ? "not in the index" : null),
        `v${installed?.version ?? entry?.version}`,
        entry && plural(entry.files.length, "file"),
        size > 0 && formatBytes(size),
        theme && "theme",
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
        return html`<${EntryFrame} title="Extension" embedded=${embedded}>
            ${problem && html`<div class="error-box small">${problem}</div>`}
            ${
                data === null
                    ? !problem && html`<${Loader} label="Reading the index" />`
                    : html`<p class="muted">The index does not list ${name}, and it is not installed.</p>`
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
                `Remove ${title}?\n\n${installed.enabled ? "It is turned off first, then its" : "Its"} files are deleted from the extensions folder.`,
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
        View source
    </button>`;
    const askPi = html`<button class="button small" disabled=${busy} onClick=${() => run(() => askForReview(name), false)}>
        <${Icon} name="sparkle" size=${14} /> Ask Pi to review
    </button>`;
    const revoked = installed?.revoked ?? offeredRevoked;

    return html`<${EntryFrame} title=${title} embedded=${embedded}>
        ${problem && html`<div class="error-box small">${problem}</div>`}
        ${
            revoked !== null &&
            revoked !== undefined &&
            html`<div class="error-box gallery-revoked" role="alert">
                <strong>The gallery revoked this version.</strong> Its reason: ${revoked}
                ${
                    installed?.enabled &&
                    html`<div class="sheet-actions">
                        <button class="button small primary" disabled=${busy} onClick=${() => toggle(false)}>
                            Turn it off
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
                    ${on ? "Runs in every session." : installed.revoked === null ? "Installed, turned off: nothing runs." : ""}
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
                              Install and turn on
                          </button>
                          <button
                              class="button small"
                              disabled=${busy || offeredRevoked !== undefined}
                              onClick=${() => install(false)}
                          >
                              Install turned off
                          </button>
                          ${source}`
                    : on
                      ? html`<button class="button small" disabled=${busy} onClick=${() => toggle(false)}>
                                Turn off
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
                                <${Icon} name="reload" size=${14} /> Reload
                            </button>
                            ${source} ${askPi}`
                      : html`${
                            installed.revoked === null &&
                            html`<button class="button small primary" disabled=${busy} onClick=${() => setAsking(true)}>
                                Turn on
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
            <summary>Technical details</summary>
            <${EntryFacts}
                entry=${entry}
                installed=${installed}
                needs=${entry && `Pi Pocket ${entry.minPocket} or newer · extension API ${entry.pocketApi}`}
            />
            <${Files} files=${files} />
            <div class="group">
                <div class="group-title">Everything it declares</div>
                <${Declares} declares=${declares} />
            </div>
        </details>
        ${
            installed &&
            html`<${Remove}
                label="Uninstall"
                text=${installed.enabled ? "Turns it off and deletes its files." : "Deletes its files."}
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
        ["swatch", palette ? `Colors, ${modeWords(palette)}` : "Its own colors"],
        names.some((file) => file.endsWith("layout.css")) && [
            "tiles",
            "A layout of its own: it moves and restyles parts of the app",
        ],
        fonts.length > 0 && [
            "file",
            `Its own ${fonts.length === 1 ? "font" : "fonts"}: ${sentence(fonts)}`,
        ],
        images.length > 0 && ["artifact", plural(images.length, "image")],
    ].filter(Boolean);
}

const Swatches = ({ colors }) =>
    html`<div class="ext-swatches">
        ${["background", "foreground", "accent", ...THEME_DOTS]
            .filter((key) => HEX.test(colors[key] ?? ""))
            .map(
                (key) =>
                    html`<i key=${key} style=${`background:${colors[key]}`} title=${`${key} ${colors[key]}`}></i>`,
            )}
        <span class="mono">
            ${[
                ["background", "background"],
                ["foreground", "text"],
                ["accent", "accent"],
            ]
                .filter(([key]) => HEX.test(colors[key] ?? ""))
                .map(([key, label]) => `${label} ${colors[key]}`)
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
                `Remove the theme ${title}?\n\nIts folder moves to themes/.removed/ in the data folder. Browsers that use it go back to Pocket.`,
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
                <strong>The gallery revoked this version.</strong> Its reason: ${installed?.revoked ?? offeredRevoked}
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
                <figcaption>${palette ? (palette.colorsLight || palette.colors.mode !== "light" ? "Dark" : "Light") : "Its colors show once the gallery reads them"}</figcaption>
            </figure>
            ${
                palette?.colorsLight &&
                html`<figure>
                    <${ThemeDesk} colors=${palette.colorsLight} big=${true} />
                    <figcaption>Light</figcaption>
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
                          Install
                      </button>`
                    : html`<button
                              class="button small primary"
                              disabled=${!usable || inUse}
                              onClick=${(event) => chooseLook(name, event)}
                          >
                              ${inUse ? "In use in this browser" : "Use it in this browser"}
                          </button>
                          <button class="button small" onClick=${() => openSheet({ type: "appearance" })}>
                              Open Appearance
                          </button>`
            }
            <button
                class="button small"
                disabled=${busy}
                onClick=${() => openGallerySheet("gallery-source", name)}
            >
                View source
            </button>
        </div>
        <p class="ext-quiet">
            ${installed ? "Each person picks a theme for their own browser: using it here changes nothing for anyone else." : "Installing adds it to Appearance. Nothing changes until someone picks it."}
        </p>
        ${
            installed?.problem &&
            html`<div class="gallery-warn small">Appearance does not offer it as it is: ${installed.problem}</div>`
        }
        <${Changed} installed=${installed} />
        <section class="ext-block">
            <h4 class="ext-label">What it changes</h4>
            <ul class="ext-reach">
                ${themeChanges(entry?.files, palette).map(
                    ([glyph, text]) => html`<li key=${glyph}>
                        <${Icon} name=${glyph} size=${14} />
                        <span class="ext-reach-text">${text}</span>
                        <span class="ext-reach-from">In its files</span>
                    </li>`,
                )}
                <li class="always">
                    <${Icon} name="shield" size=${14} />
                    <span class="ext-reach-text">${THEME_RISK}</span>
                    <span class="ext-reach-from">Always</span>
                </li>
            </ul>
        </section>
        ${
            palette &&
            html`<section class="ext-block">
                <h4 class="ext-label">Palette</h4>
                <${Swatches} colors=${palette.colors} />
                ${palette.colorsLight && html`<${Swatches} colors=${palette.colorsLight} />`}
            </section>`
        }
        ${
            entry?.tags.length > 0 &&
            html`<p class="ext-tags">${entry.tags.map((tag) => html`<span key=${tag}>#${tag}</span>`)}</p>`
        }
        <details class="gallery-technical">
            <summary>Technical details</summary>
            <${EntryFacts}
                entry=${entry}
                installed=${installed}
                needs=${entry && `Pi Pocket ${entry.minPocket} or newer · theme API ${entry.themeApi}`}
            />
            <${Files} files=${files} />
        </details>
        ${
            installed &&
            html`<${Remove}
                label="Remove"
                text="Moves it to themes/.removed/ in the data folder."
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
        title=${data ? `Source: ${data.title}` : "Source"}
        onClose=${closeSheet}
        wide=${true}
        className="gallery extension-detail-sheet"
    >
        ${problem && html`<div class="error-box small">${problem}</div>`}
        ${!data && !problem && html`<${Loader} label="Getting its files" />`}
        ${
            data &&
            html`<p class="muted small">
                ${data.from === "installed" ? "The files as they are in your extensions folder." : "Downloaded from the commit the index pins, and checked against its hashes. Nothing is installed."}
            </p>`
        }
        ${data?.files.map(
            (file) => html`<section class="gallery-source" key=${file.name}>
                <div class="gallery-source-head">
                    <span class="mono gallery-source-name">${file.name}</span>
                    <span class="muted small">${formatBytes(file.size)}</span>
                    ${
                        file.missing
                            ? html`<span class="pi-tag gallery-bad">missing</span>`
                            : file.pinned
                              ? html`<span class="pi-tag gallery-on" title="Matches the hash the index pins">✓ pinned</span>`
                              : html`<span class="pi-tag behind" title="Not the file the index pins">changed</span>`
                    }
                    ${file.binary && html`<span class="pi-tag gallery-plain">binary</span>`}
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
            lines.push({ label, added, removed });
        }
    }

    const words = (client) => (client === null ? "none" : `for ${ACCESS_WORDS[client] ?? client}`);

    if (before.client !== after.client) {
        lines.push({
            label: "Browser module",
            from: words(before.client),
            to: words(after.client),
        });
    }

    if (before.access !== after.access) {
        lines.push({
            label: "Widest access",
            from: ACCESS_WORDS[before.access] ?? before.access,
            to: ACCESS_WORDS[after.access] ?? after.access,
        });
    }

    return lines;
}

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
                `Apply the update to ${data.title}?\n\nIt is on, so the new code runs as soon as it is in place.`,
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
                    `${data.title}'s helper files changed while it is on: restart the server (Menu → Restart server) to load them.`,
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
            title="Update"
            onClose=${closeSheet}
            wide=${true}
            className="gallery extension-detail-sheet"
        >
            ${
                problem
                    ? html`<div class="error-box small">${problem}</div>`
                    : html`<${Loader} label="Getting the new version" />`
            }
        <//>`;
    }

    const changes =
        data.declares === null ? [] : declarationChanges(data.declares.before, data.declares.after);

    return html`<${Sheet}
        title=${`Update ${data.title}`}
        onClose=${closeSheet}
        wide=${true}
        className="gallery extension-detail-sheet"
    >
        <dl class="pi-facts">
            <div>
                <dt>From</dt>
                <dd class="mono">${data.from.version} · ${short(data.from.commit)}</dd>
            </div>
            <div>
                <dt>To</dt>
                <dd class="mono">
                    ${data.to.version} · <${Out} href=${data.sourceUrl}>${short(data.to.commit)}<//>
                </dd>
            </div>
        </dl>
        ${
            data.from.repo !== data.to.repo &&
            html`<div class="gallery-warn small" role="alert">
                It now comes from another repository: <span class="mono">${data.from.repo}</span> → <span class="mono">${data.to.repo}</span>. Make sure you trust the new one.
            </div>`
        }
        ${
            data.edited.length > 0 &&
            html`<div class="gallery-warn small" role="alert">
                Yours here, edited since it was installed or never part of it: <span class="mono">${data.edited.join(", ")}</span>. The diff is against your files, and the update replaces them.
            </div>`
        }
        ${
            data.declares === null
                ? html`<p class="muted small">
                      It is checked as every theme is before it is in place. The version you have now goes to themes/.removed/ in the data folder.
                  </p>`
                : html`<div class="group">
                      <div class="group-title">What it declares</div>
                      ${
                          changes.length === 0
                              ? html`<p class="muted small">The same as before.</p>`
                              : html`<dl class="pi-facts gallery-declares">
                                    ${changes.map(
                                        (change) => html`<div key=${change.label}>
                                            <dt>${change.label}</dt>
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
            <div class="group-title">Files</div>
            <div class="sheet-list gallery-files">
                ${data.files.map(
                    (file) => html`<div class="gallery-file" key=${file.name}>
                        <span class="mono">${file.name}</span>
                        <span class=${`small gallery-change ${file.change}`}>${file.change}</span>
                    </div>`,
                )}
            </div>
        </div>
        ${data.diff && html`<${DiffBlock} text=${data.diff} />`}
        ${
            data.enabled &&
            html`<p class="gallery-warn small">It is on: the new code runs as soon as it is in place.</p>`
        }
        <div class="gallery-actions">
            <button class="button primary" disabled=${busy} onClick=${apply}>Apply update</button>
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
                ? "Give the GitHub repository with its files."
                : rest.length > 0 ||
                    !OWNER.test(owner ?? "") ||
                    !REPO_NAME.test(repository ?? "") ||
                    repository === "." ||
                    repository === ".."
                  ? "Write it as owner/name, such as tannermidd/pocket-clock."
                  : null,
        commit:
            commit === ""
                ? "Give the commit with its files."
                : /^[0-9a-f]{40}$/.test(commit)
                  ? null
                  : "Write the full commit ID: 40 letters and digits, from a to f and 0 to 9.",
        path:
            parts.length > 4 || parts.some((part) => !PART.test(part))
                ? "Write a folder of the repository, such as extension, four deep at most."
                : null,
        tags:
            tags.length > 10 || tags.some((tag) => !TAG.test(tag))
                ? "Use up to 10 tags of lowercase letters, digits, and -."
                : null,
        github: github === "" || OWNER.test(github) ? null : "Write your GitHub name only.",
        name: name === "" || name.length > 60 ? "Give your name, 60 characters at most." : null,
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
        return html`<${Sheet} title=${`Share ${shareName}`} onClose=${closeSheet} wide=${true} className="gallery">
            ${problem ? html`<div class="error-box small">${problem}</div>` : html`<${Loader} label="Checking it" />`}
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
            ? "Fix the problems above first."
            : !data.declaresKnown
              ? "Turn it on once, so what it declares is known, then look again."
              : (Object.values(wrong).find((each) => each !== null) ?? null);
    const filled = data.newEntryPage && `${data.newEntryPage}&value=${encodeURIComponent(text)}`;
    const link = filled && filled.length <= LINK_LIMIT ? filled : data.newEntryPage;

    return html`<${Sheet} title=${`Share ${shareName}`} onClose=${closeSheet} wide=${true} className="gallery">
        <p class="muted small">
            To share it, add its entry to the gallery's index with a pull request. Pi Pocket makes no GitHub calls: you put its files on GitHub and open the pull request yourself.
        </p>
        ${
            data.problems.length > 0
                ? html`<div class="gallery-warn small" role="alert">
                      <strong>Fix these first:</strong>
                      <ul>
                          ${data.problems.map((each, index) => html`<li key=${index}>${each}</li>`)}
                      </ul>
                  </div>`
                : html`<p class="ok small">
                      <${Icon} name="check" size=${14} /> It stands on its own.
                  </p>`
        }
        ${
            data.notes.length > 0 &&
            html`<ul class="muted small gallery-notes">
                ${data.notes.map((each, index) => html`<li key=${index}>${each}</li>`)}
            </ul>`
        }
        <div class="group">
            <div class="group-title">1. Put its files on GitHub</div>
            <p class="small">
                Make a public GitHub repository, and commit these files to it with the same names, at its top or in one folder:
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
            <div class="group-title">2. Say where they are</div>
            <div class="gallery-form">
                <${Field}
                    id="share-repo"
                    label="Repository"
                    placeholder="owner/name"
                    value=${form.repo}
                    onInput=${set("repo")}
                    problem=${wrong.repo}
                />
                <${Field}
                    id="share-commit"
                    label="Commit"
                    hint="The full ID of the commit with these files (git rev-parse HEAD)."
                    placeholder="40 letters and digits"
                    value=${form.commit}
                    onInput=${set("commit")}
                    problem=${wrong.commit}
                />
                <${Field}
                    id="share-path"
                    label="Folder (optional)"
                    hint="Only when the files are not at the top of the repository."
                    placeholder=${theme ? "theme" : "extension"}
                    value=${form.path}
                    onInput=${set("path")}
                    problem=${wrong.path}
                />
                <${Field}
                    id="share-tags"
                    label="Tags"
                    hint=${`A few words people search for, such as ${theme ? "dark, calm" : "usage, time"}.`}
                    placeholder=${theme ? "dark, minimal" : "usage, limits"}
                    value=${form.tags}
                    onInput=${set("tags")}
                    problem=${wrong.tags}
                />
                <${Field}
                    id="share-name"
                    label="Your name"
                    value=${form.name ?? data.entry.author.name}
                    onInput=${set("name")}
                    problem=${wrong.name}
                    mono=${false}
                />
                <${Field}
                    id="share-github"
                    label="Your GitHub name (optional)"
                    placeholder="octocat"
                    value=${form.github}
                    onInput=${set("github")}
                    problem=${wrong.github}
                />
            </div>
        </div>
        <div class="group">
            <div class="gallery-entry-head">
                <div class="group-title">
                    3. Its entry, <span class="mono">entries/${data.name}.json</span>
                </div>
                <button
                    class="button small"
                    onClick=${() =>
                        attempt(() => copyText(text).then(() => notify("info", "Entry copied.")))}
                >
                    <${Icon} name="copy" size=${14} /> Copy
                </button>
            </div>
            <${Highlighted} class="gallery-code" text=${text} lang="json" />
        </div>
        <div class="gallery-actions">
            ${
                link &&
                (blocked === null
                    ? html`<${Out} class="button primary" href=${link}>
                          Open a pull request <${Icon} name="external" size=${14} />
                      <//>`
                    : html`<button class="button primary" disabled=${true}>Open a pull request</button>`)
            }
            ${
                data.contributingUrl &&
                html`<${Out} class="button" href=${data.contributingUrl}>
                    How to submit <${Icon} name="external" size=${14} />
                <//>`
            }
        </div>
        ${blocked !== null && link && html`<p class="muted small">${blocked}</p>`}
        ${
            blocked === null &&
            link !== filled &&
            html`<p class="muted small">
                Its entry is too long for the link: copy it, and paste it on GitHub's page.
            </p>`
        }
        ${
            !data.repoUrl &&
            html`<p class="muted small">
                This index does not say where to submit: ask whoever keeps it.
            </p>`
        }
    <//>`;
}
