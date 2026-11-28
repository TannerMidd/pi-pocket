// Gondolin sandboxes browser module: owner-only Sandbox sheet (setup, create sandboxed session, manage VMs,
// and review/export/apply diffs onto a new host branch) plus a status indicator on sandboxed sessions.
export const pocketApi = 2;

const SHIELD_PATH = "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z M9 12l2 2 4-4";

export default function setup(pocket) {
    const { html, useEffect, useState } = pocket;

    if (typeof pocket.style === "function") {
        pocket.style("style.css");
    }

    let snapshot = null;
    const listeners = new Set();

    function emit() {
        for (const fn of [...listeners]) {
            fn();
        }
    }

    async function refresh() {
        try {
            snapshot = await pocket.api("status");
            emit();
        } catch (error) {
            pocket.notify("warning", `Gondolin: ${error.message}`);
        }
    }

    function useStatus() {
        const [, bump] = useState(0);

        useEffect(() => {
            const listener = () => bump((n) => n + 1);

            listeners.add(listener);

            if (snapshot === null) {
                void refresh();
            }

            return () => listeners.delete(listener);
        }, []);

        return snapshot;
    }

    void refresh();
    pocket.onDispose(pocket.on("changed", () => void refresh()));
    pocket.onDispose(
        pocket.on("setup", (data) => {
            if (snapshot !== null && data?.line) {
                const lines = [...(snapshot.setup?.lines ?? []), data.line].slice(-40);

                snapshot = { ...snapshot, setup: { running: true, lines } };
                emit();
            }
        }),
    );

    if (typeof pocket.menu === "function") {
        pocket.menu({
            id: "gondolin",
            label: "Sandbox (Gondolin)",
            group: "app",
            sheet: "main",
        });
    }

    if (typeof pocket.launcher === "function") {
        pocket.launcher({
            id: "gondolin",
            label: "Sandbox (Gondolin)",
            detail: "Create or manage isolated Gondolin micro-VM sandboxes",
            iconPath: SHIELD_PATH,
            keywords: ["sandbox", "gondolin", "vm", "isolated", "diff"],
            sheet: "main",
        });
    }

    let currentConversationId = null;
    let currentSandboxId = null;
    let statusHandle = null;

    function updateStatusBar() {
        currentSandboxId =
            currentConversationId === null
                ? null
                : (snapshot?.sandboxByConversation?.[currentConversationId] ?? null);

        if (typeof pocket.status !== "function") {
            return;
        }

        if (currentSandboxId === null) {
            statusHandle?.remove();
            statusHandle = null;

            return;
        }

        const found = snapshot?.sandboxes?.find((s) => s.id === currentSandboxId);
        const stateLabel = found?.state ? ` · ${found.state}` : "";
        const text = `Sandbox${stateLabel}`;
        const title = `Gondolin sandbox ${currentSandboxId}. Tap to review or apply changes.`;

        if (statusHandle === null) {
            statusHandle = pocket.status({
                id: "gondolin",
                text,
                short: "Sandbox",
                title,
                label: "Gondolin sandbox",
                sheet: "diff",
            });
        } else {
            statusHandle.update({ text, title });
        }
    }

    if (typeof pocket.onConversation === "function") {
        pocket.onDispose(
            pocket.onConversation((conversationId) => {
                currentConversationId = conversationId;
                updateStatusBar();

                if (
                    conversationId !== null &&
                    snapshot?.sandboxByConversation?.[conversationId] === undefined
                ) {
                    void refresh();
                }
            }),
        );
    }

    listeners.add(updateStatusBar);
    pocket.onDispose(() => {
        listeners.delete(updateStatusBar);
        statusHandle?.remove();
        statusHandle = null;
    });

    function DiffReview({ sandboxId, onBack }) {
        const [loading, setLoading] = useState(true);
        const [data, setData] = useState(null);
        const [error, setError] = useState("");
        const [repoPath, setRepoPath] = useState("");
        const [branchName, setBranchName] = useState(`sandbox/${sandboxId}`);
        const [commitMessage, setCommitMessage] = useState("");
        const [applying, setApplying] = useState(false);
        const [applied, setApplied] = useState(null);
        const [reloadCount, setReloadCount] = useState(0);

        useEffect(() => {
            let active = true;

            setLoading(true);
            setError("");
            pocket
                .api(`sandboxes/${encodeURIComponent(sandboxId)}/diff`)
                .then((res) => {
                    if (!active) {
                        return;
                    }

                    setData(res);

                    if (res.sourceRepo) {
                        setRepoPath((prev) => prev || res.sourceRepo);
                    }
                })
                .catch((err) => {
                    if (active) {
                        setError(err.message);
                    }
                })
                .finally(() => {
                    if (active) {
                        setLoading(false);
                    }
                });

            return () => {
                active = false;
            };
        }, [sandboxId, reloadCount]);

        async function handleApply(event) {
            event.preventDefault();
            setApplying(true);
            setError("");

            try {
                const res = await pocket.api(`sandboxes/${encodeURIComponent(sandboxId)}/apply`, {
                    repoPath,
                    branchName,
                    commitMessage,
                    patchHash: data?.patchHash,
                });

                setApplied(res);
                pocket.notify("info", `Applied to new branch ${res.branch}.`);
            } catch (err) {
                setError(err.message);
            } finally {
                setApplying(false);
            }
        }

        function downloadPatch() {
            if (!data?.patch) {
                return;
            }

            const blob = new Blob([data.patch], { type: "text/x-diff;charset=utf-8" });
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");

            link.href = url;
            link.download = `${sandboxId}.patch`;
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        }

        return html`<div class="gondolin-sheet">
            <div class="gondolin-row-between">
                <h3>Review changes · ${sandboxId}</h3>
                <div class="gondolin-actions">
                    <button
                        type="button"
                        class="gondolin-btn"
                        disabled=${loading}
                        onClick=${() => setReloadCount((n) => n + 1)}
                    >
                        Refresh
                    </button>
                    ${
                        onBack &&
                        html`<button type="button" class="gondolin-btn" onClick=${onBack}>
                            Back
                        </button>`
                    }
                </div>
            </div>
            ${loading && html`<p class="muted">Inspecting diff inside sandbox…</p>`}
            ${error && html`<p class="gondolin-error">${error}</p>`}
            ${
                applied &&
                html`<div class="gondolin-banner gondolin-ok">
                    Created branch <code>${applied.branch}</code> (${applied.commit.slice(0, 8)})
                    with ${applied.filesChanged} file(s). Your live working tree was not modified.
                </div>`
            }
            ${
                !loading &&
                data &&
                html`<div>
                    ${
                        data.blocked?.length > 0 &&
                        html`<div class="gondolin-banner gondolin-danger">
                            <strong>Patch blocked for safety:</strong>
                            <ul>
                                ${data.blocked.map((reason) => html`<li>${reason}</li>`)}
                            </ul>
                        </div>`
                    }
                    ${
                        data.riskyFiles?.length > 0 &&
                        html`<div class="gondolin-banner gondolin-warn">
                            <strong
                                >High-risk files changed — review carefully before running
                                code:</strong
                            >
                            <ul>
                                ${data.riskyFiles.map(
                                    (risk) =>
                                        html`<li><code>${risk.path}</code> — ${risk.reason}</li>`,
                                )}
                            </ul>
                        </div>`
                    }
                    ${
                        data.files?.length === 0
                            ? html`<p class="muted">No changes in /workspace.</p>`
                            : html`<div>
                                  <p class="muted">
                                      ${data.files.length} file(s) changed (+${data.totalAdded} /
                                      -${data.totalRemoved})
                                  </p>
                                  <ul class="gondolin-file-list">
                                      ${data.files.map(
                                          (f) =>
                                              html`<li>
                                                  <code>${f.path}</code>
                                                  <span class="muted">
                                                      (${f.status}, +${f.added}/-${f.removed})
                                                  </span>
                                              </li>`,
                                      )}
                                  </ul>
                                  <pre class="gondolin-diff">${data.patch}</pre>
                                  <div class="gondolin-actions">
                                      <button
                                          type="button"
                                          class="gondolin-btn"
                                          onClick=${downloadPatch}
                                      >
                                          Download .patch
                                      </button>
                                  </div>
                                  ${
                                      data.ok &&
                                      html`<form class="gondolin-form" onSubmit=${handleApply}>
                                          <h4>Apply to a new local git branch</h4>
                                          <p class="muted">
                                              Applies with hooks and filters disabled inside a
                                              temporary worktree. Your active checkout is never
                                              modified.
                                          </p>
                                          <label>
                                              Target repository
                                              <input
                                                  type="text"
                                                  required
                                                  value=${repoPath}
                                                  placeholder="/path/to/repo"
                                                  onInput=${(e) => setRepoPath(e.currentTarget.value)}
                                              />
                                          </label>
                                          <label>
                                              New branch name
                                              <input
                                                  type="text"
                                                  required
                                                  value=${branchName}
                                                  onInput=${(e) => setBranchName(e.currentTarget.value)}
                                              />
                                          </label>
                                          <label>
                                              Commit message (optional)
                                              <input
                                                  type="text"
                                                  value=${commitMessage}
                                                  placeholder="Apply sandbox changes"
                                                  onInput=${(e) => setCommitMessage(e.currentTarget.value)}
                                              />
                                          </label>
                                          <button
                                              type="submit"
                                              class="gondolin-btn gondolin-primary"
                                              disabled=${applying}
                                          >
                                              ${applying ? "Applying…" : "Apply to new branch"}
                                          </button>
                                      </form>`
                                  }
                              </div>`
                    }
                </div>`
            }
        </div>`;
    }

    function MainSheet({ close }) {
        const data = useStatus();
        const [reviewId, setReviewId] = useState(null);
        const [title, setTitle] = useState("");
        const [source, setSource] = useState("empty");
        const [sourcePath, setSourcePath] = useState("");
        const [includeUncommitted, setIncludeUncommitted] = useState(false);
        const [repoUrl, setRepoUrl] = useState("");
        const [networkMode, setNetworkMode] = useState("allowlist");
        const [busy, setBusy] = useState(false);
        const [error, setError] = useState("");

        if (reviewId !== null) {
            return html`<${DiffReview} sandboxId=${reviewId} onBack=${() => setReviewId(null)} />`;
        }

        async function runSetup() {
            setError("");

            try {
                await pocket.api("setup", {});
                await refresh();
            } catch (err) {
                setError(err.message);
            }
        }

        async function createSandbox(event) {
            event.preventDefault();
            setBusy(true);
            setError("");

            try {
                const res = await pocket.api("sandboxes", {
                    title,
                    source,
                    sourcePath,
                    includeUncommitted,
                    repoUrl,
                    networkMode,
                });

                await refresh();
                close();

                if (res?.conversationId && typeof pocket.openConversation === "function") {
                    pocket.openConversation(res.conversationId);
                }
            } catch (err) {
                setError(err.message);
            } finally {
                setBusy(false);
            }
        }

        async function action(id, path, method = "POST") {
            setError("");

            try {
                await pocket.api(
                    `sandboxes/${encodeURIComponent(id)}${path}`,
                    method === "DELETE" ? undefined : {},
                    { method },
                );
                await refresh();
            } catch (err) {
                setError(err.message);
            }
        }

        const ready = data?.check?.ok === true;
        const sandboxes = data?.sandboxes ?? [];

        return html`<div class="gondolin-sheet">
            <p class="muted">
                Run sessions inside isolated Gondolin micro-VMs. Host files, host browser, and host
                credentials stay unreachable; changes are exported via reviewable patches.
            </p>
            ${error && html`<p class="gondolin-error">${error}</p>`}

            <section class="gondolin-section">
                <div class="gondolin-row-between">
                    <h4>Host readiness</h4>
                    <button
                        type="button"
                        class="gondolin-btn"
                        disabled=${data?.setup?.running === true}
                        onClick=${runSetup}
                    >
                        ${data?.setup?.running ? "Setting up…" : ready ? "Re-check / Update" : "Set up Gondolin"}
                    </button>
                </div>
                ${
                    data?.check?.lines &&
                    html`<ul class="gondolin-checks">
                        ${data.check.lines.map(
                            (line) =>
                                html`<li class=${line.ok ? "ok" : line.optional ? "muted" : "bad"}>
                                    <strong>${line.name}:</strong> ${line.detail}
                                </li>`,
                        )}
                    </ul>`
                }
                ${
                    data?.setup?.lines?.length > 0 &&
                    html`<pre class="gondolin-log">${data.setup.lines.join("\n")}</pre>`
                }
            </section>

            <section class="gondolin-section">
                <h4>New sandboxed session</h4>
                <form class="gondolin-form" onSubmit=${createSandbox}>
                    <label>
                        Session title (optional)
                        <input
                            type="text"
                            value=${title}
                            placeholder="Isolated experiment"
                            onInput=${(e) => setTitle(e.currentTarget.value)}
                        />
                    </label>
                    <label>
                        Workspace source
                        <select value=${source} onChange=${(e) => setSource(e.currentTarget.value)}>
                            <option value="empty">Empty workspace</option>
                            <option value="repo">One-way snapshot from local repo/folder</option>
                            <option value="git">Clone HTTPS git URL inside VM</option>
                        </select>
                    </label>
                    ${
                        source === "repo" &&
                        html`<div>
                            <label>
                                Local folder path (copied one-way, never mounted RW)
                                <input
                                    type="text"
                                    required
                                    value=${sourcePath}
                                    placeholder="/path/to/project"
                                    onInput=${(e) => setSourcePath(e.currentTarget.value)}
                                />
                            </label>
                            <label class="gondolin-check">
                                <input
                                    type="checkbox"
                                    checked=${includeUncommitted}
                                    onChange=${(e) => setIncludeUncommitted(e.currentTarget.checked)}
                                />
                                Include uncommitted tracked changes
                            </label>
                        </div>`
                    }
                    ${
                        source === "git" &&
                        html`<label>
                            HTTPS repository URL
                            <input
                                type="url"
                                required
                                value=${repoUrl}
                                placeholder="https://github.com/owner/repo.git"
                                onInput=${(e) => setRepoUrl(e.currentTarget.value)}
                            />
                        </label>`
                    }
                    <label>
                        Network egress
                        <select
                            value=${networkMode}
                            onChange=${(e) => setNetworkMode(e.currentTarget.value)}
                        >
                            <option value="allowlist">Allow-list only (recommended)</option>
                            <option value="off">Off (air-gapped)</option>
                            <option value="open">Open internet (no localhost/LAN)</option>
                        </select>
                    </label>
                    <button type="submit" class="gondolin-btn gondolin-primary" disabled=${busy}>
                        ${busy ? "Creating…" : "Create sandboxed session"}
                    </button>
                </form>
            </section>

            <section class="gondolin-section">
                <h4>Sandboxes (${sandboxes.length})</h4>
                ${
                    sandboxes.length === 0
                        ? html`<p class="muted">No sandboxes created yet.</p>`
                        : html`<ul class="gondolin-list">
                              ${sandboxes.map(
                                  (sb) =>
                                      html`<li class="gondolin-item">
                                          <div class="gondolin-row-between">
                                              <div>
                                                  <strong>${sb.name}</strong>
                                                  <div class="muted">
                                                      <code>${sb.id}</code> · ${sb.state} · net:
                                                      ${sb.networkMode}
                                                  </div>
                                              </div>
                                              <div class="gondolin-actions">
                                                  <button
                                                      type="button"
                                                      class="gondolin-btn"
                                                      onClick=${() => setReviewId(sb.id)}
                                                  >
                                                      Diff
                                                  </button>
                                                  ${
                                                      sb.state !== "stopped" &&
                                                      html`<button
                                                          type="button"
                                                          class="gondolin-btn"
                                                          onClick=${() => action(sb.id, "/stop")}
                                                      >
                                                          Stop
                                                      </button>`
                                                  }
                                                  <button
                                                      type="button"
                                                      class="gondolin-btn"
                                                      onClick=${() => action(sb.id, "/reset")}
                                                  >
                                                      Reset
                                                  </button>
                                                  <button
                                                      type="button"
                                                      class="gondolin-btn"
                                                      onClick=${() => action(sb.id, "", "DELETE")}
                                                  >
                                                      Delete
                                                  </button>
                                              </div>
                                          </div>
                                      </li>`,
                              )}
                          </ul>`
                }
            </section>
        </div>`;
    }

    function DiffSheet() {
        if (currentSandboxId === null) {
            return html`<p class="muted">
                Open a Gondolin sandbox session to review its changes.
            </p>`;
        }

        return html`<${DiffReview} sandboxId=${currentSandboxId} />`;
    }

    pocket.sheet({
        id: "main",
        title: "Sandbox (Gondolin)",
        component: MainSheet,
        wide: true,
    });
    pocket.sheet({
        id: "diff",
        title: "Sandbox diff & export",
        component: DiffSheet,
        wide: true,
    });
}
