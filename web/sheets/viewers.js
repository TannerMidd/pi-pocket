// Artifacts and images, each in a viewer of its own; and sharing an artifact to anyone with a link.
import { useEffect, useRef, useState } from "preact/hooks";
import { useArtifactBridge } from "../artifact-bridge.js";
import { browserModuleState, openExtPanel } from "../extension-ui.js";
import { api, attempt, closeSheet, notify, openSheet, store } from "../store.js";
import { modeOf, paletteOf, themeVars } from "../theme.js";
import { copyText, formatBytes, formatWhen, html, Icon, Loader, Sheet, timeAgo } from "../ui.js";

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

    return html`<${Sheet} title="Artifacts" onClose=${closeSheet} wide=${true}>
        ${
            items.length === 0 &&
            html`<p class="muted">
                No artifacts yet. Ask Pi to build something you can look at: a chart, a demo, a game.
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
                    ${artifact?.type ?? ""} · version ${shown}
                    ${latest && shown !== latest ? html` · <button class="link" onClick=${() => setShown(latest)}>latest is v${latest}</button>` : ""}
                </span>
            </div>
            ${
                artifact &&
                artifact.versions.length > 1 &&
                html`<select
                    aria-label="Version"
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
            <button class="icon-button" title="Reload" onClick=${() => setNonce(nonce + 1)}>
                ↻
            </button>
            ${
                designable &&
                html`<button
                    class="button small"
                    title="Open it in the Design canvas"
                    onClick=${openInDesign}
                >
                    Open in Design
                </button>`
            }
            ${
                shareable &&
                artifact &&
                html`<button
                    class="button small"
                    title="Publish it to anyone with a link"
                    onClick=${() => openSheet({ type: "artifact-share", id, version: shown })}
                >
                    Share
                </button>`
            }
            <a class="button small" href=${src} target="_blank" rel="noopener">Open tab</a>
            <button class="icon-button" onClick=${closeSheet} aria-label="Close">
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

/** How long a new share lasts: until it is ended, a day, a week, or a month. */
const SHARE_LIFE = [
    [0, "Until I end it"],
    [24, "A day"],
    [168, "A week"],
    [720, "A month"],
];

/** A share's full address: the server's public one when it has one, else the one this browser uses. */
const shareAddress = (base, share) =>
    `${(base ?? location.origin).replace(/\/$/, "")}${share.path}`;

/** One published page: what it shows, how long it has left, its address and a button to end it. */
function ShareRow({ share, base, fresh, canEnd, onRevoke }) {
    const copy = () =>
        copyText(shareAddress(base, share)).then(
            () => notify("info", "Link copied. Anyone with it can open the page."),
            () => notify("error", "Could not copy."),
        );

    return html`<div class=${`hook ${fresh ? "fresh" : ""}`}>
        <div class="hook-head">
            <strong class="grow">${share.title}</strong>
            <span class="muted small">
                ${share.type}${share.version === null ? " · follows the newest version" : ` · version ${share.version}, pinned`}
            </span>
        </div>
        <div class="mono small hook-address">${shareAddress(base, share)}</div>
        <div class="hook-actions">
            <span class="muted small grow">
                ${share.expiresAt === null ? "stays until you end it" : `ends ${formatWhen(share.expiresAt)}`}
            </span>
            <button class="button small" onClick=${copy}>Copy link</button>
            <a class="button small" href=${share.path} target="_blank" rel="noopener">Open</a>
            ${canEnd && html`<button class="button small ghost" onClick=${onRevoke}>End</button>`}
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
                !confirm(`End the link to ${share.title}? Anyone who has it can no longer open it.`)
            ) {
                return;
            }

            await api(`c/${view.conversation.id}/shares/${share.token}`, {});
            setFresh(null);
            await load();
        });

    return html`<${Sheet}
        title=${`Share ${artifact?.title ?? id}`}
        onClose=${() => (fromDesign ? closeSheet() : openSheet({ type: "viewer", id, version }))}
        wide=${true}
    >
        <p class="muted small">
            A published page needs no sign-in: anyone with its address can open it. It is the artifact's own sandboxed
            page, which still cannot reach this app or its cookies.
        </p>
        ${
            steer &&
            html`<div class="hook-form">
                <div class="field">
                    <div class="label">Shows</div>
                    <div class="segmented">
                        <button
                            class=${pin ? "on" : ""}
                            aria-pressed=${pin}
                            onClick=${() => setPin(true)}
                        >
                            Version ${version ?? artifact?.versions.at(-1)?.version ?? 1}
                        </button>
                        <button
                            class=${pin ? "" : "on"}
                            aria-pressed=${!pin}
                            onClick=${() => setPin(false)}
                        >
                            Newest
                        </button>
                    </div>
                    <div class="muted small">
                        ${pin ? "Stays at this version, whatever you publish after." : "Follows the artifact: every new version shows here too."}
                    </div>
                </div>
                <div class="field">
                    <div class="label">Lasts</div>
                    <div class="segmented">
                        ${SHARE_LIFE.map(
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
                    ${making ? "Publishing…" : "Publish link"}
                </button>
            </div>`
        }
        ${!list && html`<${Loader} label="Reading the links" />`}
        ${
            list?.length === 0 &&
            html`<p class="muted small">No link yet. A published page stays out of the app, and out of everything an invite to this session gave.</p>`
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
        ${base ? "" : html`<p class="muted small">Links start at ${location.origin}, so whoever opens one must be able to reach it: a tunnel's address works for anyone.</p>`}
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
        aria-label=${alt || "Image"}
        onClick=${closeSheet}
    >
        <img src=${src} alt=${alt ?? ""} />
        <div class="lightbox-bar" onClick=${(event) => event.stopPropagation()}>
            <span class="lightbox-title">${alt ?? ""}</span>
            <a class="button small" href=${src} target="_blank" rel="noopener">Open</a>
            <button class="icon-button" onClick=${closeSheet} aria-label="Close">
                <${Icon} name="close" />
            </button>
        </div>
    </div>`;
}
