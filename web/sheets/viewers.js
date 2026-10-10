// Artifacts and images, each in a viewer of its own.
import { useEffect, useState } from "preact/hooks";
import { t } from "../i18n.js";
import { closeSheet, openSheet, store } from "../store.js";
import { formatBytes, html, Icon, Sheet, timeAgo } from "../ui.js";

export function ArtifactsSheet() {
    const { artifacts } = store.state.view;
    const items = [...artifacts].sort(
        (a, b) => (b.versions.at(-1)?.createdAt ?? 0) - (a.versions.at(-1)?.createdAt ?? 0),
    );

    return html`<${Sheet} title=${t("Artifacts")} onClose=${closeSheet}>
        ${
            items.length === 0 &&
            html`<p class="muted">
                ${t("No artifacts yet. Ask Pi to build something you can look at: a chart, a demo, a game.")}
            </p>`
        }
        ${items.map((artifact) =>
            [...artifact.versions].reverse().map(
                (version) => html`<button
                    class="list-item"
                    onClick=${() => openSheet({ type: "viewer", id: artifact.id, version: version.version })}
                >
                    <span>
                        ${artifact.title}
                        <br />
                        <span class="muted small mono">${artifact.id}</span>
                    </span>
                    <span class="muted small mono">
                        ${artifact.type} v${version.version} · ${formatBytes(version.size)} · ${timeAgo(version.createdAt)}
                    </span>
                </button>`,
            ),
        )}
    <//>`;
}

export function ArtifactViewer({ id, version }) {
    const { view } = store.state;
    const artifact = view.artifacts.find((each) => each.id === id);
    const [shown, setShown] = useState(version ?? artifact?.versions.at(-1)?.version);
    const [nonce, setNonce] = useState(0);
    const latest = artifact?.versions.at(-1)?.version;
    const src = `/a/${view.conversation.id}/${encodeURIComponent(id)}/${shown ?? "latest"}`;

    return html`<div class="viewer">
        <header class="viewer-head">
            <div class="viewer-title">
                <strong>${artifact?.title ?? id}</strong>
                <span class="muted small">
                    ${artifact?.type ?? ""} · version ${shown}
                    ${latest && shown !== latest ? html` · <button class="link" onClick=${() => setShown(latest)}>${t("latest is v{{version}}", { version: latest })}</button>` : ""}
                </span>
            </div>
            ${
                artifact &&
                artifact.versions.length > 1 &&
                html`<select
                    aria-label=${t("Version")}
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
            <button class="icon-button" title=${t("Reload")} onClick=${() => setNonce(nonce + 1)}>
                ↻
            </button>
            <a class="button small" href=${src} target="_blank" rel="noopener">${t("Open tab")}</a>
            <button class="icon-button" onClick=${closeSheet} aria-label=${t("Close")}>
                <${Icon} name="close" />
            </button>
        </header>
        <iframe
            key=${`${src}#${nonce}`}
            src=${src}
            sandbox="allow-scripts allow-forms allow-modals allow-popups allow-pointer-lock allow-downloads"
            allow="fullscreen; clipboard-write; accelerometer; gyroscope"
            title=${artifact?.title ?? id}
        ></iframe>
    </div>`;
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
        aria-label=${alt || t("Image")}
        onClick=${closeSheet}
    >
        <img src=${src} alt=${alt ?? ""} />
        <div class="lightbox-bar" onClick=${(event) => event.stopPropagation()}>
            <span class="lightbox-title">${alt ?? ""}</span>
            <a class="button small" href=${src} target="_blank" rel="noopener">${t("Open")}</a>
            <button class="icon-button" onClick=${closeSheet} aria-label=${t("Close")}>
                <${Icon} name="close" />
            </button>
        </div>
    </div>`;
}
