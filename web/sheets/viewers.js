// Artifacts and images, each in a viewer of its own; and sharing an artifact to anyone with a link.
import { useEffect, useRef, useState } from "preact/hooks";
import { useArtifactBridge } from "../artifact-bridge.js";
import { browserModuleState, openExtPanel } from "../extension-ui.js";
import { api, attempt, closeSheet, notify, openSheet, store } from "../store.js";
import { modeOf, paletteOf, themeVars } from "../theme.js";
import { copyText, formatBytes, formatWhen, html, Icon, Loader, Sheet, timeAgo } from "../ui.js";
import { t } from "../ui-locale.js";

/**
 * The app's theme for a Markdown artifact's page, in its address: in its sandbox, the page cannot see the app's look,
 * and would otherwise take the browser's light or dark (`src/server/http/artifacts.ts`).
 */
function themeQuery() {
    const palette = paletteOf();
    const vars = themeVars(palette);
    const hex = (name) => vars[name].replace(/^#/, "");

    return `?${new URLSearchParams({
        mode: modeOf(palette),
        bg: hex("--o-bg"),
        fg: hex("--o-fg"),
        text: hex("--o-fg-bright"),
        accent: hex("--o-accent"),
        code: hex("--o-bg-dark"),
    })}`;
}

export function ArtifactsSheet() {
    const { artifacts } = store.state.view;
    const items = [...artifacts].sort(
        (a, b) => (b.versions.at(-1)?.createdAt ?? 0) - (a.versions.at(-1)?.createdAt ?? 0),
    );

    return html`<${Sheet} title=${t(
        "web.sheets.viewers.artifacts-sheet.title.artifacts",
        "Artifacts",
    )} onClose=${closeSheet} wide=${true}>
        ${
            items.length === 0 &&
            html`<p class="muted">
                ${t("web.sheets.viewers.artifacts-sheet.p.no-artifacts-yet-ask", "No artifacts yet. Ask Pi to build something you can look at: a chart, a demo, a game.")}
            </p>`
        }
        <div class="artifact-grid">
            ${items.map((artifact) =>
                [...artifact.versions].reverse().map(
                    (version) => html`<button
                        class="artifact-card"
                        onClick=${() => openSheet({ type: "viewer", id: artifact.id, version: version.version })}
                    >
                        <span class="artifact-cover" aria-hidden="true">
                            <${Icon} name="file" size=${28} />
                            <span>${artifact.type}</span>
                        </span>
                        <span class="artifact-info">
                            <span class="artifact-name">${artifact.title}</span>
                            <span class="muted small mono">${artifact.id}</span>
                            <span class="muted small mono">
                                ${artifact.type} v${version.version} · ${formatBytes(version.size)} · ${timeAgo(version.createdAt)}
                            </span>
                        </span>
                    </button>`,
                ),
            )}
        </div>
    <//>`;
}

export function ArtifactViewer({ id, version }) {
    const { view, me } = store.state;
    const artifact = view.artifacts.find((each) => each.id === id);
    const frame = useRef(null);

    // What its page may ask: a follow-up in the message box, and its own saved state (`artifact-bridge.js`). Only an HTML
    // page has the bridge: a Markdown or SVG page has no script of the app's to open the line.
    useArtifactBridge(frame, {
        artifact: id,
        source: `the artifact “${artifact?.title ?? id}”`,
        enabled: artifact?.type === "html",
    });
    const [shown, setShown] = useState(version ?? artifact?.versions.at(-1)?.version);
    const [nonce, setNonce] = useState(0);
    const latest = artifact?.versions.at(-1)?.version;
    const theme = artifact?.type === "markdown" ? themeQuery() : "";
    const src = `/a/${view.conversation.id}/${encodeURIComponent(id)}/${shown ?? "latest"}${theme}`;
    // A published page is out of the reach of an invite to one session, so only those who see every session publish.
    const shareable = me?.role !== "viewer" && me?.sessions === undefined && me?.role !== undefined;
    // The Design canvas (a built-in module) shows an HTML page with its versions, comments, and tweaks.
    const designable =
        artifact?.type === "html" && browserModuleState("design")?.status === "ready";

    const openInDesign = () => {
        dispatchEvent(
            new CustomEvent("pocket:design-open", {
                detail: { artifact: id, version: shown === latest ? null : shown },
            }),
        );
        openExtPanel("design", "design");
    };

    return html`<div class="viewer">
        <header class="viewer-head">
            <div class="viewer-title">
                <strong>${artifact?.title ?? id}</strong>
                <span class="muted small">
                    ${artifact?.type ?? ""}${t(
                        "web.sheets.viewers.artifact-viewer.span.version-shown",
                        " · version {shown}",
                        { shown },
                    )}
                    ${
                        latest && shown !== latest
                            ? html` · <button class="link" onClick=${() => setShown(latest)}>
                              ${t(
                                  "web.sheets.viewers.artifact-viewer.button.latest-is",
                                  "latest is v{version}",
                                  { version: latest },
                              )}
                          </button>`
                            : ""
                    }
                </span>
            </div>
            ${
                artifact &&
                artifact.versions.length > 1 &&
                html`<select
                    aria-label=${t(
                        "web.sheets.viewers.artifact-viewer.aria-label.version",
                        "Version",
                    )}
                    value=${shown}
                    onChange=${(event) => setShown(Number(event.currentTarget.value))}
                >
                    ${[...artifact.versions]
                        .reverse()
                        .map(
                            (each) => html`<option value=${each.version}>v${each.version}</option>`,
                        )}
                </select>`
            }
            <button class="icon-button" title=${t(
                "web.sheets.viewers.artifact-viewer.title.reload",
                "Reload",
            )} onClick=${() => setNonce(nonce + 1)}>
                ↻
            </button>
            ${
                designable &&
                html`<button
                    class="button small"
                    title=${t(
                        "web.sheets.viewers.artifact-viewer.title.open-design-canvas",
                        "Open it in the Design canvas",
                    )}
                    onClick=${openInDesign}
                >
                    ${t("web.sheets.viewers.artifact-viewer.button.open-design", "Open in Design")}
                </button>`
            }
            ${
                shareable &&
                artifact &&
                html`<button
                    class="button small"
                    title=${t(
                        "web.sheets.viewers.artifact-viewer.title.publish-anyone-link",
                        "Publish it to anyone with a link",
                    )}
                    onClick=${() => openSheet({ type: "artifact-share", id, version: shown })}
                >
                    ${t("web.sheets.viewers.artifact-viewer.button.share", "Share")}
                </button>`
            }
            <a class="button small" href=${src} target="_blank" rel="noopener">${t(
                "web.sheets.viewers.artifact-viewer.a.open-tab",
                "Open tab",
            )}</a>
            <button class="icon-button" onClick=${closeSheet} aria-label=${t(
                "web.sheets.viewers.artifact-viewer.aria-label.close",
                "Close",
            )}>
                <${Icon} name="close" />
            </button>
        </header>
        <iframe
            ref=${frame}
            key=${`${src}#${nonce}`}
            src=${src}
            sandbox="allow-scripts allow-forms allow-modals allow-popups allow-pointer-lock allow-downloads"
            allow="fullscreen; clipboard-write; accelerometer; gyroscope"
            title=${artifact?.title ?? id}
        ></iframe>
    </div>`;
}

/** How long a new share lasts: until it is ended, a day, a week, or a month; built at draw time for its words. */
const shareLife = () => [
    [0, t("web.sheets.viewers.share-life.until-i-end", "Until I end it")],
    [24, t("web.sheets.viewers.share-life.day", "A day")],
    [168, t("web.sheets.viewers.share-life.week", "A week")],
    [720, t("web.sheets.viewers.share-life.month", "A month")],
];

/** A share's full address: the server's public one when it has one, else the one this browser uses. */
const shareAddress = (base, share) =>
    `${(base ?? location.origin).replace(/\/$/, "")}${share.path}`;

/** One published page: what it shows, how long it has left, its address and a button to end it. */
function ShareRow({ share, base, fresh, canEnd, onRevoke }) {
    const copy = () =>
        copyText(shareAddress(base, share)).then(
            () =>
                notify(
                    "info",
                    t(
                        "web.sheets.viewers.share-row.copy.link-copied-anyone-open",
                        "Link copied. Anyone with it can open the page.",
                    ),
                ),
            () =>
                notify("error", t("web.sheets.viewers.share-row.copy.not-copy", "Could not copy.")),
        );

    return html`<div class=${`hook ${fresh ? "fresh" : ""}`}>
        <div class="hook-head">
            <strong class="grow">${share.title}</strong>
            <span class="muted small">
                ${share.type}${
                    share.version === null
                        ? t(
                              "web.sheets.viewers.share-row.span.follows-newest-version",
                              " · follows the newest version",
                          )
                        : t(
                              "web.sheets.viewers.share-row.span.version-pinned",
                              " · version {version}, pinned",
                              { version: share.version },
                          )
                }
            </span>
        </div>
        <div class="mono small hook-address">${shareAddress(base, share)}</div>
        <div class="hook-actions">
            <span class="muted small grow">
                ${
                    share.expiresAt === null
                        ? t(
                              "web.sheets.viewers.share-row.span.stays-until-end",
                              "stays until you end it",
                          )
                        : t("web.sheets.viewers.share-row.span.ends-at", "ends {when}", {
                              when: formatWhen(share.expiresAt),
                          })
                }
            </span>
            <button class="button small" onClick=${copy}>${t(
                "web.sheets.viewers.share-row.button.copy-link",
                "Copy link",
            )}</button>
            <a class="button small" href=${share.path} target="_blank" rel="noopener">${t(
                "web.sheets.viewers.share-row.a.open",
                "Open",
            )}</a>
            ${
                canEnd &&
                html`<button class="button small ghost" onClick=${onRevoke}>${t(
                    "web.sheets.viewers.share-row.button.end",
                    "End",
                )}</button>`
            }
        </div>
    </div>`;
}

/**
 * Share one artifact version: publish it to anyone with a link, which needs no sign-in. A version that is named stays as
 * it is; the newest one follows the artifact. Give both up by ending the link.
 */
export function ArtifactShareSheet({ id, version }) {
    const { view, me } = store.state;
    const artifact = view.artifacts.find((each) => each.id === id);
    // Opened from the Design canvas, closing it goes back there, not to the viewer.
    const fromDesign = store.state.sheet?.back === "design";
    const [list, setList] = useState(null);
    const [base, setBase] = useState(null);
    const [life, setLife] = useState(0);
    const [pin, setPin] = useState(true);
    const [making, setMaking] = useState(false);
    const [fresh, setFresh] = useState(null);
    const makingNow = useRef(false);
    // As the server checks: only people who steer and see every session publish or end a link.
    const steer = me?.role !== undefined && me.role !== "viewer" && me.sessions === undefined;

    const load = () =>
        attempt(async () => {
            const result = await api(`c/${view.conversation.id}/shares`);

            setList(result.shares);
            setBase(result.base ?? null);
        });

    useEffect(() => void load(), []);

    // One share per tap: a second tap while the first is on its way would publish another.
    const make = () => {
        if (makingNow.current) {
            return;
        }

        makingNow.current = true;
        setMaking(true);
        attempt(async () => {
            const share = await api(`c/${view.conversation.id}/shares`, {
                id,
                ...(pin && version !== undefined && version !== null ? { version } : {}),
                ...(life === 0 ? {} : { hours: life }),
            });

            setFresh(share.token);
            await load();
        }).finally(() => {
            makingNow.current = false;
            setMaking(false);
        });
    };

    const revoke = (share) =>
        attempt(async () => {
            if (
                !confirm(
                    t(
                        "web.sheets.viewers.artifact-share-sheet.revoke.confirm.end-link-anyone-who",
                        "End the link to {title}? Anyone who has it can no longer open it.",
                        { title: share.title },
                    ),
                )
            ) {
                return;
            }

            await api(`c/${view.conversation.id}/shares/${share.token}`, {});
            setFresh(null);
            await load();
        });

    return html`<${Sheet}
        title=${t("web.sheets.viewers.artifact-share-sheet.title.share", "Share {title}", {
            title: artifact?.title ?? id,
        })}
        onClose=${() => (fromDesign ? closeSheet() : openSheet({ type: "viewer", id, version }))}
        wide=${true}
    >
        <p class="muted small">
            ${t(
                "web.sheets.viewers.artifact-share-sheet.p.published-page-needs-no",
                "A published page needs no sign-in: anyone with its address can open it. It is the artifact's own sandboxed page, which still cannot reach this app or its cookies.",
            )}
        </p>
        ${
            steer &&
            html`<div class="hook-form">
                <div class="field">
                    <div class="label">${t(
                        "web.sheets.viewers.artifact-share-sheet.div.shows",
                        "Shows",
                    )}</div>
                    <div class="segmented">
                        <button
                            class=${pin ? "on" : ""}
                            aria-pressed=${pin}
                            onClick=${() => setPin(true)}
                        >
                            ${t(
                                "web.sheets.viewers.artifact-share-sheet.button.version",
                                "Version {detail}",
                                {
                                    detail: version ?? artifact?.versions.at(-1)?.version ?? 1,
                                },
                            )}
                        </button>
                        <button
                            class=${pin ? "" : "on"}
                            aria-pressed=${!pin}
                            onClick=${() => setPin(false)}
                        >
                            ${t("web.sheets.viewers.artifact-share-sheet.button.newest", "Newest")}
                        </button>
                    </div>
                    <div class="muted small">
                        ${
                            pin
                                ? t(
                                      "web.sheets.viewers.artifact-share-sheet.div.stays-version-whatever-publish",
                                      "Stays at this version, whatever you publish after.",
                                  )
                                : t(
                                      "web.sheets.viewers.artifact-share-sheet.div.follows-artifact-every-new",
                                      "Follows the artifact: every new version shows here too.",
                                  )
                        }
                    </div>
                </div>
                <div class="field">
                    <div class="label">${t(
                        "web.sheets.viewers.artifact-share-sheet.div.lasts",
                        "Lasts",
                    )}</div>
                    <div class="segmented">
                        ${shareLife().map(
                            ([hours, label]) => html`<button
                                class=${life === hours ? "on" : ""}
                                aria-pressed=${life === hours}
                                onClick=${() => setLife(hours)}
                            >
                                ${label}
                            </button>`,
                        )}
                    </div>
                </div>
                <button class="button primary" disabled=${making} onClick=${make}>
                    ${
                        making
                            ? t(
                                  "web.sheets.viewers.artifact-share-sheet.button.publishing",
                                  "Publishing…",
                              )
                            : t(
                                  "web.sheets.viewers.artifact-share-sheet.button.publish-link",
                                  "Publish link",
                              )
                    }
                </button>
            </div>`
        }
        ${
            !list &&
            html`<${Loader}
                label=${t(
                    "web.sheets.viewers.artifact-share-sheet.label.reading-the-links",
                    "Reading the links",
                )}
            />`
        }
        ${
            list?.length === 0 &&
            html`<p class="muted small">${t("web.sheets.viewers.artifact-share-sheet.p.no-link-yet-published", "No link yet. A published page stays out of the app, and out of everything an invite to this session gave.")}</p>`
        }
        ${list?.map((share) =>
            ShareRow({
                share,
                base,
                fresh: fresh === share.token,
                canEnd: steer,
                onRevoke: () => revoke(share),
            }),
        )}
        ${
            base
                ? ""
                : html`<p class="muted small">
                  ${t(
                      "web.sheets.viewers.artifact-share-sheet.p.links-start-whoever-opens",
                      "Links start at {origin}, so whoever opens one must be able to reach it: a tunnel's address works for anyone.",
                      { origin: location.origin },
                  )}
              </p>`
        }
    <//>`;
}

/** An image full screen. Tap anywhere to close; Open shows it in its own tab to zoom, save, or share. */
export function ImageViewer({ src, alt }) {
    useEffect(() => {
        const onKey = (event) => event.key === "Escape" && closeSheet();

        addEventListener("keydown", onKey);

        return () => removeEventListener("keydown", onKey);
    }, []);

    return html`<div
        class="lightbox"
        role="dialog"
        aria-modal="true"
        aria-label=${alt || t("web.sheets.viewers.image-viewer.text.image", "Image")}
        onClick=${closeSheet}
    >
        <img src=${src} alt=${alt ?? ""} />
        <div class="lightbox-bar" onClick=${(event) => event.stopPropagation()}>
            <span class="lightbox-title">${alt ?? ""}</span>
            <a class="button small" href=${src} target="_blank" rel="noopener">${t(
                "web.sheets.viewers.image-viewer.a.open",
                "Open",
            )}</a>
            <button class="icon-button" onClick=${closeSheet} aria-label=${t(
                "web.sheets.viewers.image-viewer.aria-label.close",
                "Close",
            )}>
                <${Icon} name="close" />
            </button>
        </div>
    </div>`;
}
