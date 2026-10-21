// The extension gallery: drop-ins and themes other people wrote, from a reviewed index. Browse and search them, read
// one's code before it is installed, install it (a drop-in off; a theme into Appearance's list, not applied), ask Pi to
// review a drop-in, turn it on, update it with a diff, remove it; and share your own as a draft index entry. The
// owner's alone; the server side is src/server/gallery.ts.
//
// Everything the index says is untrusted: it shows as text only, and links go only to addresses the server built.
import { useEffect, useRef, useState } from "preact/hooks";
import { t } from "../i18n.js";
import { planAvailable } from "../commands.js";
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
import { BASE_LOOK, prefs, setPrefs } from "../theme.js";
import { copyText, formatBytes, html, Icon, Loader, Sheet, timeAgo } from "../ui.js";

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
const incompatibleEntries = (count) =>
    t(
        count === 1
            ? "{{count}} entry needs a newer Pi Pocket."
            : "{{count}} entries need a newer Pi Pocket.",
        { count },
    );
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

        return t("/{{command}} ({{scope}})", {
            command: name,
            scope: t(scope === "global" ? "owner" : "who can steer"),
        });
    });

const RISK =
    "A drop-in runs inside the server with your rights, in every session. Lancet Guard does not see what its code does.";
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

/** How an installed extension stands, as small pills. */
function StatePills({ installed }) {
    if (!installed) {
        return null;
    }

    return html`<span class="gallery-pills">
        ${installed.revoked !== null && html`<span class="pi-tag gallery-bad">${t("revoked")}</span>`}
        ${installed.update && html`<span class="pi-tag behind">${t("update available")}</span>`}
        ${installed.enabled ? html`<span class="pi-tag gallery-on">${t("on")}</span>` : html`<span class="pi-tag gallery-plain">${t("installed")}</span>`}
    </span>`;
}

function EntryRow({ entry, selected, onOpen, onChanged, updates }) {
    const [busy, setBusy] = useState(false);
    const going = useRef(false);
    const installed = entry.installed ?? (entry.listed === false ? entry : null);

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

    return html`<div class=${`gallery-card ${selected ? "selected" : ""}`}>
        <button
            class="gallery-card-open"
            aria-current=${selected ? "true" : undefined}
            onClick=${onOpen}
        >
            <span class="gallery-row-text">
                <span class="gallery-row-head">
                    <span class="gallery-row-title">${entry.title}</span>
                    <span class="gallery-row-name mono">${entry.name}</span>
                    ${isTheme(entry) && html`<span class="pi-tag gallery-plain">${t("Theme")}</span>`}
                </span>
                ${entry.description && html`<span class="gallery-row-desc">${entry.description}</span>`}
                <span class="gallery-row-meta">
                    ${(entry.tags ?? []).map((tag) => html`<span class="gallery-tag-text" key=${tag}>#${tag}</span>`)}
                    <span>${entry.author ? `${entry.author.name} · ` : ""}v${entry.version}${entry.unlisted ? ` · ${entry.unlisted}` : ""}</span>
                </span>
                <${StatePills} installed=${installed} />
            </span>
        </button>
        <div class="gallery-card-actions">
            ${
                !installed &&
                html`<button class="button small primary" disabled=${busy} onClick=${install}>
                    ${
                        busy
                            ? t("Installing…")
                            : isTheme(entry)
                              ? t("Install theme")
                              : t("Install (stays off)")
                    }
                </button>`
            }
            ${
                installed?.update &&
                html`<button
                    class=${`button small ${updates ? "primary" : ""}`}
                    onClick=${() => openGallerySheet("gallery-update", entry.name)}
                >
                    ${t("Review update")}
                </button>`
            }
        </div>
    </div>`;
}

/** The most common tags first, at most `limit`. */
function topTags(entries, limit) {
    const counts = new Map();

    for (const entry of entries) {
        for (const tag of entry.tags) {
            counts.set(tag, (counts.get(tag) ?? 0) + 1);
        }
    }

    return [...counts]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, limit)
        .map(([tag]) => tag);
}

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
                <div class="muted">${t("Index")}</div>
                <div class="mono gallery-address">${address}</div>
            </div>
            <button
                class="button small"
                onClick=${() => {
                    setValue(address);
                    setEditing(true);
                }}
            >
                ${t("Change")}
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
            ${t("Index: a GitHub repository (owner/name), or the https address of an index.json")}
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
                    ${t("Use the default ({{fallback}})", { fallback })}
                </button>`
            }
            <button type="button" class="button small" onClick=${() => setEditing(false)}>${t("Cancel")}</button>
            <button class="button small primary" disabled=${busy}>${t("Save")}</button>
        </div>
    </form>`;
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
    const [query, setQuery] = useState("");
    const [tag, setTag] = useState(null);
    const [kind, setKind] = useState(null);
    const needle = query.trim().toLowerCase();
    const installed = data?.installed ?? [];
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
    const tags = topTags(offered, 10);
    const kinds = offered.some(isTheme) && !offered.every(isTheme) ? ["extension", "theme"] : [];
    const matches = entries.filter(
        (entry) =>
            (kind === null || (kind === "theme") === isTheme(entry)) &&
            (tag === null || entry.tags?.includes(tag)) &&
            (needle === "" ||
                [entry.name, entry.title, entry.description ?? "", ...(entry.tags ?? [])].some(
                    (text) => text.toLowerCase().includes(needle),
                )),
    );
    const detailName = selected ?? (tab === "discover" ? matches[0]?.name : null);
    const hidden = data?.hidden ?? { incompatible: 0, invalid: [] };
    const select = (name) => openSheet({ type: "gallery-entry", id: name, tab, origin });

    const changeTab = (next) => {
        setQuery("");
        setTag(null);
        setKind(null);
        openSheet({ type: origin, tab: next });
    };

    return html`<${Sheet}
        title=${t("Extensions")}
        onClose=${closeSheet}
        wide=${true}
        className="extension-hub gallery"
    >
        <div class="extension-hub-tabs" role="tablist" aria-label=${t("Extensions")}>
            ${[
                ["discover", "Discover"],
                ["installed", "Installed extensions"],
                ["updates", "Updates"],
            ].map(
                ([value, label]) => html`<button
                    key=${value}
                    class=${`extension-hub-tab ${tab === value ? "on" : ""}`}
                    role="tab"
                    aria-selected=${tab === value}
                    onClick=${() => changeTab(value)}
                >
                    ${t(label)}${
                        value === "updates" && installed.filter((item) => item.update).length > 0
                            ? ` (${installed.filter((item) => item.update).length})`
                            : ""
                    }
                </button>`,
            )}
        </div>
        <div class="extension-hub-toolbar">
            <input
                class="find-input"
                type="search"
                placeholder=${t("Search extensions and themes")}
                aria-label=${t("Search extensions and themes")}
                value=${query}
                onInput=${(event) => setQuery(event.currentTarget.value)}
            />
            <button class="button small" disabled=${loading} onClick=${() => load(true)}>
                <${Icon} name="reload" size=${14} /> ${t("Refresh")}
            </button>
            ${
                (tags.length > 1 || kinds.length > 0) &&
                html`<div class="gallery-tags" role="group" aria-label=${t("Kinds and tags")}>
                    ${kinds.map(
                        (each) => html`<button
                            key=${`kind-${each}`}
                            class=${`gallery-tag ${kind === each ? "on" : ""}`}
                            aria-pressed=${kind === each}
                            onClick=${() => setKind(kind === each ? null : each)}
                        >
                            ${t(each === "theme" ? "Themes" : "Extensions")}
                        </button>`,
                    )}
                    ${(tags.length > 1 ? tags : []).map(
                        (each) => html`<button
                            key=${each}
                            class=${`gallery-tag ${tag === each ? "on" : ""}`}
                            aria-pressed=${tag === each}
                            onClick=${() => setTag(tag === each ? null : each)}
                        >
                            ${each}
                        </button>`,
                    )}
                </div>`
            }
        </div>
        <div class=${`extension-hub-layout ${tab} ${selected ? "has-selection" : ""}`}>
            <div class="extension-hub-list">
                ${problem && html`<div class="error-box small">${problem}</div>`}
                ${data?.error && html`<div class="error-box small">${data.error}</div>`}
                ${!data && !problem && html`<${Loader} label=${t("Reading the index")} />`}
                ${
                    tab === "discover" &&
                    html`<p class="muted small">
                        ${t("Extensions and themes from a reviewed index. Extensions install turned off; read their source or ask Pi to review them before turning them on.")}
                    </p>`
                }
                ${
                    matches.length > 0 &&
                    html`<div class="gallery-list">
                        ${matches.map(
                            (entry) => html`<${EntryRow}
                                key=${entry.name}
                                entry=${entry}
                                selected=${detailName === entry.name}
                                onOpen=${() => select(entry.name)}
                                onChanged=${load}
                                updates=${tab === "updates"}
                            />`,
                        )}
                    </div>`
                }
                ${
                    data &&
                    matches.length === 0 &&
                    html`<p class="extension-hub-empty muted">
                        ${
                            needle || tag || kind
                                ? tab === "installed"
                                    ? t("No gallery extensions or themes match these filters.")
                                    : t("Nothing matches these filters.")
                                : tab === "updates"
                                  ? t("Everything is up to date.")
                                  : tab === "installed"
                                    ? t("No gallery extensions or themes installed yet.")
                                    : t("The index has nothing for this Pi Pocket yet.")
                        }
                    </p>`
                }
                ${
                    tab === "installed" &&
                    kind !== "theme" &&
                    tag === null &&
                    Management &&
                    html`<${Management}
                        galleryInstalled=${installed}
                        query=${query}
                        onChanged=${load}
                    />`
                }
                ${
                    tab === "discover" &&
                    data &&
                    html`<details class="gallery-technical">
                        <summary>${t("Index settings and status")}</summary>
                        <${IndexAddress} address=${data.address} onChanged=${() => load(true)} />
                        <p class="muted small">
                            ${
                                data.fetchedAt
                                    ? t("Read {{time}}", { time: timeAgo(data.fetchedAt) })
                                    : t("Not read yet")
                            }
                        </p>
                        ${
                            hidden.incompatible > 0 &&
                            html`<p class="muted small">
                                ${incompatibleEntries(hidden.incompatible)}
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
                                ${t("Submit yours")} <${Icon} name="external" size=${14} />
                            <//>`
                        }
                    </details>`
                }
            </div>
            <div class="extension-hub-detail">
                ${
                    detailName
                        ? html`
                            <button
                                class="button small extension-hub-detail-back"
                                onClick=${() => openSheet({ type: origin, tab })}
                            >
                                <${Icon} name="back" size=${16} /> ${t("Back to {{tab}}", {
                                    tab: t(
                                        tab === "discover"
                                            ? "Discover"
                                            : tab === "installed"
                                              ? "Installed extensions"
                                              : "Updates",
                                    ),
                                })}
                            </button>
                            <${GalleryEntrySheet}
                                key=${detailName}
                                name=${detailName}
                                listing=${listing}
                                embedded=${true}
                            />
                        `
                        : html`<div class="extension-hub-empty muted">${t("Choose an extension or theme to see its details.")}</div>`
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
                <dt>${t(label)}</dt>
                ${
                    declared(declares, key).length > 0
                        ? html`<dd class="mono">${declared(declares, key).join(", ")}</dd>`
                        : html`<dd class="muted">${t("nothing")}</dd>`
                }
            </div>`,
        )}
        <div>
            <dt>${t("Browser module")}</dt>
            ${
                declares.client === null
                    ? html`<dd class="muted">${t("nothing")}</dd>`
                    : html`<dd>${t("for {{access}}", {
                          access: ACCESS_WORDS[declares.client]
                              ? t(ACCESS_WORDS[declares.client])
                              : declares.client,
                      })}</dd>`
            }
        </div>
        <div>
            <dt>${t("Widest access")}</dt>
            <dd>${ACCESS_WORDS[declares.access] ? t(ACCESS_WORDS[declares.access]) : declares.access}</dd>
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
            t("The review runs in plan mode, which is off: turn Plan mode on in Extensions first."),
        );
    }

    const { cwd, prompt } = await galleryApi(`review/${encodeURIComponent(name)}`);
    const { id } = await actions.createSession(cwd);

    try {
        await api(`c/${id}/plan`, { on: true });
    } catch (error) {
        navigate(id);

        throw new Error(
            t("Plan mode did not turn on ({{error}}), so the review was not sent.", {
                error: error.message,
            }),
        );
    }

    await api(`c/${id}/submit`, { text: prompt, requestId: uid() });
    closeSheet();
    navigate(id);
    notify(
        "info",
        t(
            "Pi reviews it in plan mode: it reads the files, and plan mode keeps it from changing them.",
        ),
    );
}

/** Turn an installed extension on (after the owner confirms the risk) or off. */
async function setEnabled(installed, title, enabled) {
    if (
        enabled &&
        !confirm(
            t(
                "Turn on {{title}}?\n\n{{risk}}\n\nTurn it on only if you read its source, or Pi's review of it, and trust it.",
                { title, risk: t(RISK) },
            ),
        )
    ) {
        return false;
    }

    await api(`extensions/${encodeURIComponent(installed.file)}`, { enabled });
    notify("info", t("{{title}} is {{state}}.", { title, state: t(enabled ? "on" : "off") }));

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

/** One entry: what it is, where it comes from, what it declares, and what the owner can do with it here. */
export function GalleryEntrySheet({ name, listing, embedded = false }) {
    const { data, problem, load } = useListing(listing);
    const [busy, setBusy] = useState(false);
    // Set at once, not at the next render: a second tap in the same moment must not run it twice.
    const going = useRef(false);
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
        return html`<${EntryFrame} title=${t("Extension")} embedded=${embedded}>
            ${problem && html`<div class="error-box small">${problem}</div>`}
            ${
                data === null
                    ? !problem && html`<${Loader} label=${t("Reading the index")} />`
                    : html`<p class="muted">${t("The index does not list {{name}}, and it is not installed.", { name })}</p>`
            }
        <//>`;
    }

    if (isTheme(entry ?? installed)) {
        return html`<${ThemeEntry}
            name=${name}
            entry=${entry}
            installed=${installed}
            problem=${problem}
            busy=${busy}
            run=${run}
            embedded=${embedded}
        />`;
    }

    const title = installed?.title ?? entry.title;
    const declares = installed?.declares ?? entry.declares;
    // The index's files are these when it offers the version here, or nothing is installed.
    const files =
        entry && (!installed || entry.source.commit === installed.commit) ? entry.files : null;
    const offeredRevoked = !installed && entry ? revocation(entry, entry.source.commit) : undefined;

    // Bound to the manifest the owner saw (`pin`): when the index changed since, the server refuses with 409, and the
    // entry is read again (run's reload) for the owner to look at once more.
    const install = () =>
        run(() => galleryApi(`install/${encodeURIComponent(name)}`, { pin: entry.pin }));
    const toggle = (enabled) => run(() => setEnabled(installed, title, enabled));

    const uninstall = () => {
        const effect = installed.enabled
            ? t("It is turned off first, then its files are deleted from the extensions folder.")
            : t("Its files are deleted from the extensions folder.");

        if (confirm(t("Remove {{title}}?\n\n{{effect}}", { title, effect }))) {
            run(() => galleryApi(`uninstall/${encodeURIComponent(name)}`, {}));
        }
    };

    const review = () => run(() => askForReview(name), false);

    return html`<${EntryFrame} title=${title} embedded=${embedded}>
        ${problem && html`<div class="error-box small">${problem}</div>`}
        ${
            installed &&
            installed.revoked !== null &&
            html`<div class="error-box gallery-revoked" role="alert">
                <strong>${t("The gallery revoked this version.")}</strong> ${t("Its reason:")} ${installed.revoked}
                ${
                    installed.enabled &&
                    html`<div class="sheet-actions">
                        <button class="button small primary" disabled=${busy} onClick=${() => toggle(false)}>
                            ${t("Turn it off")}
                        </button>
                    </div>`
                }
            </div>`
        }
        ${
            offeredRevoked !== undefined &&
            html`<div class="error-box gallery-revoked" role="alert">
                <strong>${t("The gallery revoked this version.")}</strong> ${t("Its reason:")} ${offeredRevoked}
            </div>`
        }
        <div class="gallery-head">
            <h3 class="pi-title">${title}</h3>
            <span class="mono muted small">${name}</span>
            <${StatePills} installed=${installed} />
        </div>
        ${entry?.description && html`<p class="gallery-description">${entry.description}</p>`}
        ${
            entry &&
            entry.tags.length > 0 &&
            html`<div class="gallery-row-meta">
                ${entry.tags.map((tag) => html`<span class="gallery-tag-text" key=${tag}>#${tag}</span>`)}
            </div>`
        }
        <p class="gallery-warn small">${t(RISK)} ${t("Read its code before you turn it on.")}</p>
        <div class="gallery-actions">
            ${
                !installed &&
                html`<button
                    class="button primary"
                    disabled=${busy || offeredRevoked !== undefined}
                    onClick=${install}
                >
                    ${t("Install (it stays off)")}
                </button>`
            }
            ${
                installed &&
                installed.revoked === null &&
                !installed.enabled &&
                html`<button class="button primary" disabled=${busy} onClick=${() => toggle(true)}>
                    ${t("Turn on")}
                </button>`
            }
            ${
                installed &&
                installed.update &&
                html`<button
                    class="button primary"
                    disabled=${busy}
                    onClick=${() => openGallerySheet("gallery-update", name)}
                >
                    ${t("Update to {{version}}", { version: installed.update.version })}
                </button>`
            }
            <button
                class="button"
                disabled=${busy}
                onClick=${() => openGallerySheet("gallery-source", name)}
            >
                ${t("View source")}
            </button>
            ${
                installed &&
                html`<button class="button" disabled=${busy} onClick=${review}>
                    <${Icon} name="sparkle" size=${14} /> ${t("Ask Pi to review")}
                </button>`
            }
            ${
                installed &&
                installed.enabled &&
                installed.revoked === null &&
                html`<button
                    class="button"
                    disabled=${busy}
                    onClick=${() => toggle(false)}
                >
                    ${t("Turn off")}
                </button>
                <button
                    class="button"
                    disabled=${busy}
                    onClick=${() => run(() => api(`extensions/${encodeURIComponent(installed.file)}/reload`, {}))}
                >
                    ${t("Reload")}
                </button>`
            }
            ${
                installed &&
                html`<button class="button ghost" disabled=${busy} onClick=${uninstall}>${t("Uninstall")}</button>`
            }
        </div>
        ${
            installed?.changed.length > 0 &&
            html`<div class="gallery-warn small">
                ${t("Not as installed (edited since, or gone): {{files}}", { files: installed.changed.join(", ") })}
            </div>`
        }
        <details class="gallery-technical">
            <summary>${t("Technical details")}</summary>
            <${EntryFacts}
                entry=${entry}
                installed=${installed}
                needs=${entry && t("Pi Pocket {{version}} or newer · extension API {{api}}", { version: entry.minPocket, api: entry.pocketApi })}
            />
            ${
                files &&
                html`<div class="group">
                    <div class="group-title">${t("Files")}</div>
                    <div class="sheet-list gallery-files">
                        ${files.map(
                            (file) => html`<div class="gallery-file" key=${file.name}>
                                <span class="mono">${file.name}</span>
                                <span class="muted small">${formatBytes(file.size)}</span>
                            </div>`,
                        )}
                    </div>
                </div>`
            }
            <div class="group">
                <div class="group-title">${t("What it declares")}</div>
                <${Declares} declares=${declares} />
            </div>
        </details>
    <//>`;
}

/** The facts both kinds of entry show: who made it, its version, where its files are, what it needs, and when. */
function EntryFacts({ entry, installed, needs }) {
    const version = installed?.version ?? entry.version;
    const repo = installed?.repo ?? entry.source.repo;
    const commit = installed?.commit ?? entry.source.commit;

    return html`<dl class="pi-facts">
        ${
            entry &&
            html`<div>
                <dt>${t("Author")}</dt>
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
            <dt>${t("Version")}</dt>
            <dd>
                ${version}${installed?.update ? html`<span class="warn"> · ${t("{{version}} available", { version: installed.update.version })}</span>` : ""}
            </dd>
        </div>
        <div>
            <dt>${t("Source")}</dt>
            <dd class="mono">
                <${Out} href=${installed?.sourceUrl ?? entry.sourceUrl}>${repo} @ ${short(commit)}<//>
            </dd>
        </div>
        ${
            entry &&
            html`<div>
                <dt>${t("Needs")}</dt>
                <dd>${needs}</dd>
            </div>`
        }
        ${
            installed &&
            html`<div>
                <dt>${t("Installed")}</dt>
                <dd>
                    ${timeAgo(installed.installedAt)}${installed.unlisted ? ` · ${installed.unlisted}` : ""}
                </dd>
            </div>`
        }
    </dl>`;
}

/**
 * A theme's entry: what it is, its files, and installing, updating, and removing it. Installing puts it in the list in
 * Appearance; it changes nothing until someone chooses it there.
 */
function ThemeEntry({ name, entry, installed, problem, busy, run, embedded }) {
    const title = installed?.title ?? entry.title;
    const files =
        entry && (!installed || entry.source.commit === installed.commit) ? entry.files : null;
    const offeredRevoked = !installed && entry ? revocation(entry, entry.source.commit) : undefined;

    const install = () =>
        run(() => galleryApi(`install/${encodeURIComponent(name)}`, { pin: entry.pin }));

    const uninstall = () => {
        if (
            confirm(
                t(
                    "Remove the theme {{title}}?\n\nIts folder moves to themes/.removed/ in the data folder. Browsers that use it go back to Pocket.",
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
                <strong>${t("The gallery revoked this version.")}</strong> ${t("Its reason:")} ${installed?.revoked ?? offeredRevoked}
            </div>`
        }
        <div class="gallery-head">
            <h3 class="pi-title">${title}</h3>
            <span class="mono muted small">${name}</span>
            <span class="pi-tag gallery-plain">${t("Theme")}</span>
            <${StatePills} installed=${installed} />
        </div>
        ${entry?.description && html`<p class="gallery-description">${entry.description}</p>`}
        ${
            entry &&
            entry.tags.length > 0 &&
            html`<div class="gallery-row-meta">
                ${entry.tags.map((tag) => html`<span class="gallery-tag-text" key=${tag}>#${tag}</span>`)}
            </div>`
        }
        <p class="gallery-warn small">${t(THEME_RISK)}</p>
        <div class="gallery-actions">
            ${
                !installed &&
                html`<button
                    class="button primary"
                    disabled=${busy || offeredRevoked !== undefined}
                    onClick=${install}
                >
                    ${t("Install")}
                </button>`
            }
            ${
                installed &&
                installed.update &&
                html`<button
                    class="button primary"
                    disabled=${busy}
                    onClick=${() => openGallerySheet("gallery-update", name)}
                >
                    ${t("Update to {{version}}", { version: installed.update.version })}
                </button>`
            }
            ${
                installed &&
                html`<button class="button" onClick=${() => openSheet({ type: "appearance" })}>
                    ${t("Choose it in Appearance")}
                </button>`
            }
            <button
                class="button"
                disabled=${busy}
                onClick=${() => openGallerySheet("gallery-source", name)}
            >
                ${t("View source")}
            </button>
            ${
                installed &&
                html`<button class="button ghost" disabled=${busy} onClick=${uninstall}>${t("Remove")}</button>`
            }
        </div>
        ${
            installed?.problem &&
            html`<div class="gallery-warn small">${t("Appearance does not offer it as it is: {{problem}}", { problem: installed.problem })}</div>`
        }
        ${
            installed?.changed.length > 0 &&
            html`<div class="gallery-warn small">
                ${t("Not as installed (edited since, or gone): {{files}}", { files: installed.changed.join(", ") })}
            </div>`
        }
        <details class="gallery-technical">
            <summary>${t("Technical details")}</summary>
            <${EntryFacts}
                entry=${entry}
                installed=${installed}
                needs=${entry && t("Pi Pocket {{version}} or newer · theme API {{api}}", { version: entry.minPocket, api: entry.themeApi })}
            />
            ${
                files &&
                html`<div class="group">
                    <div class="group-title">${t("Files")}</div>
                    <div class="sheet-list gallery-files">
                        ${files.map(
                            (file) => html`<div class="gallery-file" key=${file.name}>
                                <span class="mono">${file.name}</span>
                                <span class="muted small">${formatBytes(file.size)}</span>
                            </div>`,
                        )}
                    </div>
                </div>`
            }
        </details>
    <//>`;
}

/** An extension's files, to read: as installed, or downloaded from the pinned commit before it is. */
export function GallerySourceSheet({ name }) {
    const [data, setData] = useState(null);
    const [problem, setProblem] = useState(null);

    useRoute(`source/${encodeURIComponent(name)}`, setData, setProblem);

    return html`<${Sheet}
        title=${data ? t("Source: {{title}}", { title: data.title }) : t("Source")}
        onClose=${closeSheet}
        wide=${true}
        className="gallery extension-detail-sheet"
    >
        ${problem && html`<div class="error-box small">${problem}</div>`}
        ${!data && !problem && html`<${Loader} label=${t("Getting its files")} />`}
        ${
            data &&
            html`<p class="muted small">
                ${t(data.from === "installed" ? "The files as they are in your extensions folder." : "Downloaded from the commit the index pins, and checked against its hashes. Nothing is installed.")}
            </p>`
        }
        ${data?.files.map(
            (file) => html`<section class="gallery-source" key=${file.name}>
                <div class="gallery-source-head">
                    <span class="mono gallery-source-name">${file.name}</span>
                    <span class="muted small">${formatBytes(file.size)}</span>
                    ${
                        file.missing
                            ? html`<span class="pi-tag gallery-bad">${t("missing")}</span>`
                            : file.pinned
                              ? html`<span class="pi-tag gallery-on" title=${t("Matches the hash the index pins")}>✓ ${t("pinned")}</span>`
                              : html`<span class="pi-tag behind" title=${t("Not the file the index pins")}>${t("changed")}</span>`
                    }
                    ${file.binary && html`<span class="pi-tag gallery-plain">${t("binary")}</span>`}
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

    const words = (client) =>
        client === null
            ? t("none")
            : t("for {{access}}", {
                  access: ACCESS_WORDS[client] ? t(ACCESS_WORDS[client]) : client,
              });

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
            from: ACCESS_WORDS[before.access] ? t(ACCESS_WORDS[before.access]) : before.access,
            to: ACCESS_WORDS[after.access] ? t(ACCESS_WORDS[after.access]) : after.access,
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
                t(
                    "Apply the update to {{title}}?\n\nIt is on, so the new code runs as soon as it is in place.",
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
                        "{{title}}'s helper files changed while it is on: restart the server (Menu → Restart server) to load them.",
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
            title=${t("Update")}
            onClose=${closeSheet}
            wide=${true}
            className="gallery extension-detail-sheet"
        >
            ${
                problem
                    ? html`<div class="error-box small">${problem}</div>`
                    : html`<${Loader} label=${t("Getting the new version")} />`
            }
        <//>`;
    }

    const changes =
        data.declares === null ? [] : declarationChanges(data.declares.before, data.declares.after);

    return html`<${Sheet}
        title=${t("Update {{title}}", { title: data.title })}
        onClose=${closeSheet}
        wide=${true}
        className="gallery extension-detail-sheet"
    >
        <dl class="pi-facts">
            <div>
                <dt>${t("From")}</dt>
                <dd class="mono">${data.from.version} · ${short(data.from.commit)}</dd>
            </div>
            <div>
                <dt>${t("To")}</dt>
                <dd class="mono">
                    ${data.to.version} · <${Out} href=${data.sourceUrl}>${short(data.to.commit)}<//>
                </dd>
            </div>
        </dl>
        ${
            data.from.repo !== data.to.repo &&
            html`<div class="gallery-warn small" role="alert">
                ${t("It now comes from another repository: {{from}} → {{to}}. Make sure you trust the new one.", { from: data.from.repo, to: data.to.repo })}
            </div>`
        }
        ${
            data.edited.length > 0 &&
            html`<div class="gallery-warn small" role="alert">
                ${t("Yours here, edited since it was installed or never part of it: {{files}}. The diff is against your files, and the update replaces them.", { files: data.edited.join(", ") })}
            </div>`
        }
        ${
            data.declares === null
                ? html`<p class="muted small">
                      ${t("It is checked as every theme is before it is in place. The version you have now goes to themes/.removed/ in the data folder.")}
                  </p>`
                : html`<div class="group">
                      <div class="group-title">${t("What it declares")}</div>
                      ${
                          changes.length === 0
                              ? html`<p class="muted small">${t("The same as before.")}</p>`
                              : html`<dl class="pi-facts gallery-declares">
                                    ${changes.map(
                                        (change) => html`<div key=${t(change.label)}>
                                            <dt>${t(change.label)}</dt>
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
            <div class="group-title">${t("Files")}</div>
            <div class="sheet-list gallery-files">
                ${data.files.map(
                    (file) => html`<div class="gallery-file" key=${file.name}>
                        <span class="mono">${file.name}</span>
                        <span class=${`small gallery-change ${file.change}`}>${["added", "removed", "changed", "unchanged"].includes(file.change) ? t(file.change) : file.change}</span>
                    </div>`,
                )}
            </div>
        </div>
        ${data.diff && html`<${DiffBlock} text=${data.diff} />`}
        ${
            data.enabled &&
            html`<p class="gallery-warn small">${t("It is on: the new code runs as soon as it is in place.")}</p>`
        }
        <div class="gallery-actions">
            <button class="button primary" disabled=${busy} onClick=${apply}>${t("Apply update")}</button>
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
                ? t("Give the GitHub repository with its files.")
                : rest.length > 0 ||
                    !OWNER.test(owner ?? "") ||
                    !REPO_NAME.test(repository ?? "") ||
                    repository === "." ||
                    repository === ".."
                  ? t("Write it as owner/name, such as tannermidd/pocket-clock.")
                  : null,
        commit:
            commit === ""
                ? t("Give the commit with its files.")
                : /^[0-9a-f]{40}$/.test(commit)
                  ? null
                  : t("Write the full commit ID: 40 letters and digits, from a to f and 0 to 9."),
        path:
            parts.length > 4 || parts.some((part) => !PART.test(part))
                ? t("Write a folder of the repository, such as extension, four deep at most.")
                : null,
        tags:
            tags.length > 10 || tags.some((tag) => !TAG.test(tag))
                ? t("Use up to 10 tags of lowercase letters, digits, and -.")
                : null,
        github: github === "" || OWNER.test(github) ? null : t("Write your GitHub name only."),
        name: name === "" || name.length > 60 ? t("Give your name, 60 characters at most.") : null,
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
        return html`<${Sheet} title=${t("Share {{name}}", { name: shareName })} onClose=${closeSheet} wide=${true} className="gallery">
            ${problem ? html`<div class="error-box small">${problem}</div>` : html`<${Loader} label=${t("Checking it")} />`}
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
            ? t("Fix the problems above first.")
            : !data.declaresKnown
              ? t("Turn it on once, so what it declares is known, then look again.")
              : (Object.values(wrong).find((each) => each !== null) ?? null);
    const filled = data.newEntryPage && `${data.newEntryPage}&value=${encodeURIComponent(text)}`;
    const link = filled && filled.length <= LINK_LIMIT ? filled : data.newEntryPage;

    return html`<${Sheet} title=${t("Share {{name}}", { name: shareName })} onClose=${closeSheet} wide=${true} className="gallery">
        <p class="muted small">
            ${t("To share it, add its entry to the gallery's index with a pull request. Pi Pocket makes no GitHub calls: you put its files on GitHub and open the pull request yourself.")}
        </p>
        ${
            data.problems.length > 0
                ? html`<div class="gallery-warn small" role="alert">
                      <strong>${t("Fix these first:")}</strong>
                      <ul>
                          ${data.problems.map((each, index) => html`<li key=${index}>${each}</li>`)}
                      </ul>
                  </div>`
                : html`<p class="ok small">
                      <${Icon} name="check" size=${14} /> ${t("It stands on its own.")}
                  </p>`
        }
        ${
            data.notes.length > 0 &&
            html`<ul class="muted small gallery-notes">
                ${data.notes.map((each, index) => html`<li key=${index}>${each}</li>`)}
            </ul>`
        }
        <div class="group">
            <div class="group-title">${t("1. Put its files on GitHub")}</div>
            <p class="small">
                ${t("Make a public GitHub repository, and commit these files to it with the same names, at its top or in one folder:")}
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
            <div class="group-title">${t("2. Say where they are")}</div>
            <div class="gallery-form">
                <${Field}
                    id="share-repo"
                    label=${t("Repository")}
                    placeholder="owner/name"
                    value=${form.repo}
                    onInput=${set("repo")}
                    problem=${wrong.repo}
                />
                <${Field}
                    id="share-commit"
                    label=${t("Commit")}
                    hint=${t("The full ID of the commit with these files (git rev-parse HEAD).")}
                    placeholder=${t("40 letters and digits")}
                    value=${form.commit}
                    onInput=${set("commit")}
                    problem=${wrong.commit}
                />
                <${Field}
                    id="share-path"
                    label=${t("Folder (optional)")}
                    hint=${t("Only when the files are not at the top of the repository.")}
                    placeholder=${theme ? "theme" : "extension"}
                    value=${form.path}
                    onInput=${set("path")}
                    problem=${wrong.path}
                />
                <${Field}
                    id="share-tags"
                    label=${t("Tags")}
                    hint=${t(theme ? "A few words people search for, such as dark, calm." : "A few words people search for, such as usage, time.")}
                    placeholder=${theme ? "dark, minimal" : "usage, limits"}
                    value=${form.tags}
                    onInput=${set("tags")}
                    problem=${wrong.tags}
                />
                <${Field}
                    id="share-name"
                    label=${t("Your name")}
                    value=${form.name ?? data.entry.author.name}
                    onInput=${set("name")}
                    problem=${wrong.name}
                    mono=${false}
                />
                <${Field}
                    id="share-github"
                    label=${t("Your GitHub name (optional)")}
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
                    ${t("3. Its entry, {{path}}", { path: `entries/${data.name}.json` })}
                </div>
                <button
                    class="button small"
                    onClick=${() =>
                        attempt(() =>
                            copyText(text).then(() => notify("info", t("Entry copied."))),
                        )}
                >
                    <${Icon} name="copy" size=${14} /> ${t("Copy")}
                </button>
            </div>
            <${Highlighted} class="gallery-code" text=${text} lang="json" />
        </div>
        <div class="gallery-actions">
            ${
                link &&
                (blocked === null
                    ? html`<${Out} class="button primary" href=${link}>
                          ${t("Open a pull request")} <${Icon} name="external" size=${14} />
                      <//>`
                    : html`<button class="button primary" disabled=${true}>${t("Open a pull request")}</button>`)
            }
            ${
                data.contributingUrl &&
                html`<${Out} class="button" href=${data.contributingUrl}>
                    ${t("How to submit")} <${Icon} name="external" size=${14} />
                <//>`
            }
        </div>
        ${blocked !== null && link && html`<p class="muted small">${blocked}</p>`}
        ${
            blocked === null &&
            link !== filled &&
            html`<p class="muted small">
                ${t("Its entry is too long for the link: copy it, and paste it on GitHub's page.")}
            </p>`
        }
        ${
            !data.repoUrl &&
            html`<p class="muted small">
                ${t("This index does not say where to submit: ask whoever keeps it.")}
            </p>`
        }
    <//>`;
}
