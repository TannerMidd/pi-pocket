// Owner settings, provider options, routing and request observations through the public browser API.
import createOptions from "./options.js";
export const pocketApi = 2;

export default function setup(pocket) {
    const { html, useEffect, useState, Icon, Loader, Switch } = pocket;
    const WebAccessOptions = createOptions(pocket);
    const api = (...args) => pocket.api(...args);

    const publicLink = (value) => {
        try {
            const u = new URL(value);

            return ["https:", "http:"].includes(u.protocol) ? u.href : undefined;
        } catch {
            return undefined;
        }
    };

    pocket.style("look.css");

    function WebAccessSheet() {
        const owner = true;

        const attempt = async (run) => {
            try {
                return await run();
            } catch (error) {
                pocket.notify("error", error.message || "Web search request failed");

                return undefined;
            }
        };

        const [data, setData] = useState(null);
        const [loading, setLoading] = useState(true);
        const [saving, setSaving] = useState(false);
        const [keys, setKeys] = useState({});
        const [showKey, setShowKey] = useState({});
        const [testResults, setTestResults] = useState({});
        const [testing, setTesting] = useState({});
        const [configuringKey, setConfiguringKey] = useState({});

        // Live search testing
        const [searchQuery, setSearchQuery] = useState("");
        const [searching, setSearching] = useState(false);
        const [searchOutput, setSearchOutput] = useState(null);
        const [searchError, setSearchError] = useState("");
        const [searchTier, setSearchTier] = useState("standard");
        const [searchProvider, setSearchProvider] = useState("auto");
        const [searchMode, setSearchMode] = useState("");

        const load = async () => {
            setLoading(true);
            const res = await attempt(() => api("state"));

            if (res) {
                setData(res);
            }

            setLoading(false);
        };

        useEffect(() => {
            load();
        }, []);

        const saveOptions = async (updates) => {
            setSaving(true);
            const updated = await attempt(() => api("state", updates));

            if (updated) {
                setData(updated);
            }

            setSaving(false);
        };

        const refreshUsage = async () => {
            const updated = await attempt(() => api("state"));

            if (updated) {
                setData((was) => (was ? { ...was, usage: updated.usage } : updated));
            }
        };

        const toggleConfiguring = (providerId) => {
            setConfiguringKey((was) => ({ ...was, [providerId]: !was[providerId] }));
        };

        const saveKey = async (providerId) => {
            const key = keys[providerId] ?? "";

            if (!key.trim()) {
                return;
            }

            setSaving(true);
            const updated = await attempt(() =>
                api("state", { apiKey: { provider: providerId, key } }),
            );

            if (updated) {
                setData(updated);
                setKeys((was) => ({ ...was, [providerId]: "" }));
                setConfiguringKey((was) => ({ ...was, [providerId]: false }));
                // Automatically test after saving
                testProvider(providerId);
            }

            setSaving(false);
        };

        const clearKey = async (providerId) => {
            setSaving(true);
            const updated = await attempt(() =>
                api("state", { apiKey: { provider: providerId, key: "" } }),
            );

            if (updated) {
                setData(updated);
                setKeys((was) => ({ ...was, [providerId]: "" }));
                setConfiguringKey((was) => ({ ...was, [providerId]: false }));
                setTestResults((was) => ({ ...was, [providerId]: null }));
            }

            setSaving(false);
        };

        const setPrimary = async (providerId) => {
            setSaving(true);
            const updated = await attempt(() => api("state", { primaryProvider: providerId }));

            if (updated) {
                setData(updated);
            }

            setSaving(false);
        };

        const toggleEnabled = async (enabled) => {
            setSaving(true);
            const updated = await attempt(() => api("state", { enabled }));

            if (updated) {
                setData(updated);
            }

            setSaving(false);
        };

        const updateMaxResults = async (maxResults) => {
            setSaving(true);
            const updated = await attempt(() => api("state", { maxResults }));

            if (updated) {
                setData(updated);
            }

            setSaving(false);
        };

        const testProvider = async (providerId) => {
            setTesting((was) => ({ ...was, [providerId]: true }));
            const currentInput = keys[providerId];
            const res = await attempt(() =>
                api("test", {
                    provider: providerId,
                    apiKey: currentInput || undefined,
                }),
            );

            if (res) {
                setTestResults((was) => ({ ...was, [providerId]: res }));
            }

            setTesting((was) => ({ ...was, [providerId]: false }));
            refreshUsage();
        };

        const runLiveSearch = async (event) => {
            event?.preventDefault();
            const q = searchQuery.trim();

            if (!q) {
                return;
            }

            setSearching(true);
            setSearchError("");
            setSearchOutput(null);

            try {
                const res = await api("search", {
                    query: q,
                    provider: searchProvider,
                    numResults: data?.maxResults ?? 5,
                    tier: searchTier,
                    ...(searchProvider !== "auto" && searchMode ? { mode: searchMode } : {}),
                });

                setSearchOutput(res);
            } catch (err) {
                setSearchError(err?.message || String(err));
            } finally {
                setSearching(false);
                refreshUsage();
            }
        };

        return html`<>
        <div class="web-access-sheet">
            <p class="muted small">
                Configure live web access and search providers for Pi. When enabled, Pi can use
                <span class="mono"> web_search</span> and
                <span class="mono"> fetch_content</span> to browse recent documentation, current
                events, and online articles.
            </p>

            ${loading && !data && html`<${Loader} label="Loading web access configuration" />`}

            ${
                data &&
                html`
                    <div class="label">Preferences</div>
                    <div class="sheet-list">
                        <div class="setting-row">
                            <div class="setting-text">
                                <span>Enable web tools for Pi</span>
                                <span>
                                    Offers <span class="mono">web_search</span> and
                                    <span class="mono"> fetch_content</span> in sessions.
                                </span>
                            </div>
                            <${Switch}
                                on=${data.enabled}
                                disabled=${!owner || saving}
                                label=${`Web tools: ${data.enabled ? "on" : "off"}`}
                                onChange=${(e) => toggleEnabled(e.currentTarget.checked)}
                            />
                        </div>

                        <div class="setting-row">
                            <div class="setting-text">
                                <span>Primary search provider</span>
                                <span>
                                    Used by legacy standard routing until tier chains are saved.
                                </span>
                            </div>
                            <select
                                class="web-select-primary"
                                disabled=${!owner || saving || data.tierRoutingEnabled}
                                value=${data.primaryProvider}
                                onChange=${(e) => setPrimary(e.currentTarget.value)}
                            >
                                ${data.providers.map(
                                    (p) =>
                                        html`<option key=${p.id} value=${p.id}>
                                            ${p.name}
                                            ${
                                                p.keyConfigured
                                                    ? p.apiKeyRequired
                                                        ? " (configured)"
                                                        : " (ready)"
                                                    : " (needs key)"
                                            }
                                        </option>`,
                                )}
                            </select>
                        </div>

                        <div class="setting-row">
                            <div class="setting-text">
                                <span>Results per query</span>
                                <span>Number of search results Pi retrieves (3 to 15).</span>
                            </div>
                            <div class="segmented" role="group" aria-label="Search results depth">
                                ${[3, 5, 10, 15].map(
                                    (n) =>
                                        html`<button
                                            type="button"
                                            class=${data.maxResults === n ? "on" : ""}
                                            aria-pressed=${data.maxResults === n}
                                            disabled=${!owner || saving}
                                            onClick=${() => updateMaxResults(n)}
                                        >
                                            ${n}
                                        </button>`,
                                )}
                            </div>
                        </div>
                    </div>

                    ${
                        data.tierRouting &&
                        html`<${WebAccessOptions}
                            data=${data}
                            disabled=${!owner || saving}
                            save=${saveOptions}
                            refresh=${refreshUsage}
                        />`
                    }

                    <div class="label">Search Providers (${data.providers.length})</div>
                    <div class="sheet-list">
                        ${data.providers.map((p) => {
                            const isPrimary = data.primaryProvider === p.id;
                            const test = testResults[p.id];
                            const isTesting = testing[p.id];
                            const hasKey = p.keyConfigured;
                            const isShow = showKey[p.id];
                            const inputValue = keys[p.id] ?? "";
                            const isConfiguring = configuringKey[p.id] ?? false;

                            return html`<div
                                class=${`web-provider-row ${isPrimary ? "is-primary" : ""}`}
                                key=${p.id}
                            >
                                <div class="web-provider-main">
                                    <div class="web-provider-info">
                                        <div class="web-provider-name-row">
                                            <span class="web-provider-title">${p.name}</span>
                                            ${
                                                isPrimary &&
                                                html`<span class="badge primary">Primary</span>`
                                            }
                                            ${
                                                hasKey
                                                    ? html`<span class="badge ok">✓ Ready</span>`
                                                    : p.apiKeyRequired
                                                      ? html`<span class="badge warn"
                                                            >Needs Key</span
                                                        >`
                                                      : html`<span class="badge muted"
                                                            >Free · No Key</span
                                                        >`
                                            }
                                        </div>
                                        <div class="muted small web-provider-desc">
                                            ${p.description}
                                        </div>
                                        <div class="web-provider-meta small">
                                            <a
                                                href=${p.website}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                class="link small"
                                            >
                                                Documentation & Keys
                                                <${Icon} name="external" size=${11} />
                                            </a>
                                            ${hasKey && p.maskedKey && html`<span class="muted mono">· key: ${p.maskedKey}</span>`}
                                            ${hasKey && p.keySource && p.keySource !== "none" && html`<span class="muted">· source: ${p.keySource}</span>`}
                                        </div>
                                    </div>

                                    <div class="web-provider-actions">
                                        ${
                                            !isPrimary &&
                                            html`<button
                                                class="button small"
                                                disabled=${!owner || saving}
                                                onClick=${() => setPrimary(p.id)}
                                                title="Set as primary search provider"
                                            >
                                                Make primary
                                            </button>`
                                        }
                                        <button
                                            class="button small ghost"
                                            disabled=${isTesting || (!hasKey && !inputValue)}
                                            onClick=${() => testProvider(p.id)}
                                            title="Test provider connection"
                                        >
                                            ${
                                                isTesting
                                                    ? html`<${Loader} label="Testing" />`
                                                    : "Test"
                                            }
                                        </button>
                                        ${
                                            owner &&
                                            p.apiKeyRequired &&
                                            html`<button
                                                class="button small ghost"
                                                onClick=${() => toggleConfiguring(p.id)}
                                            >
                                                ${
                                                    isConfiguring
                                                        ? "Close"
                                                        : hasKey
                                                          ? "Change key"
                                                          : "Add key"
                                                }
                                            </button>`
                                        }
                                    </div>
                                </div>

                                ${
                                    test &&
                                    html`<div
                                        class=${`web-test-status small ${test.ok ? "ok" : "warn"}`}
                                    >
                                        ${
                                            test.ok
                                                ? `✓ Connection verified (${test.latencyMs ?? 0} ms)`
                                                : `✗ Error: ${test.error || "Connection failed"}`
                                        }
                                    </div>`
                                }
                                ${
                                    owner &&
                                    p.apiKeyRequired &&
                                    isConfiguring &&
                                    html`<div class="web-key-drawer">
                                        <div class="web-key-input-wrap">
                                            <input
                                                type=${isShow ? "text" : "password"}
                                                class="input small mono"
                                                placeholder=${
                                                    p.maskedKey
                                                        ? `New key (current: ${p.maskedKey})`
                                                        : `Enter ${p.name} API key`
                                                }
                                                value=${inputValue}
                                                onInput=${(e) =>
                                                    setKeys((was) => ({
                                                        ...was,
                                                        [p.id]: e.currentTarget.value,
                                                    }))}
                                            />
                                            <button
                                                type="button"
                                                class="button icon-only ghost small"
                                                onClick=${() =>
                                                    setShowKey((was) => ({
                                                        ...was,
                                                        [p.id]: !was[p.id],
                                                    }))}
                                                title=${isShow ? "Hide key" : "Show key"}
                                            >
                                                <${Icon} name="eye" size=${13} />
                                            </button>
                                        </div>
                                        <button
                                            class="button small primary"
                                            disabled=${saving || !inputValue.trim()}
                                            onClick=${() => saveKey(p.id)}
                                        >
                                            Save
                                        </button>
                                        ${
                                            hasKey &&
                                            p.keySource === "web-search.json" &&
                                            html`<button
                                                class="button small ghost"
                                                disabled=${saving}
                                                onClick=${() => clearKey(p.id)}
                                                title="Clear stored API key"
                                            >
                                                Clear
                                            </button>`
                                        }
                                        <button
                                            class="button small ghost"
                                            type="button"
                                            onClick=${() => toggleConfiguring(p.id)}
                                        >
                                            Cancel
                                        </button>
                                    </div>`
                                }
                            </div>`;
                        })}
                    </div>

                    <div class="label">Live Search Verification</div>
                    <div class="web-search-card">
                        <p class="muted small" style="margin: 0;">
                            Test queries with your primary provider (${data.primaryProvider}) to
                            verify search results and snippets.
                        </p>

                        <form class="web-live-search-form" onSubmit=${runLiveSearch}>
                            <div class="web-route-row">
                                <select
                                    aria-label="Search tier"
                                    value=${searchTier}
                                    onChange=${(e) => setSearchTier(e.currentTarget.value)}
                                >
                                    ${["quick", "standard", "deep"].map((tier) => html`<option value=${tier}>${tier}</option>`)}
                                </select>
                                <select
                                    aria-label="Search provider override"
                                    value=${searchProvider}
                                    onChange=${(e) => {
                                        setSearchProvider(e.currentTarget.value);
                                        setSearchMode("");
                                    }}
                                >
                                    <option value="auto">Automatic routing</option>
                                    ${data.providers.map((p) => html`<option value=${p.id}>${p.name}</option>`)}
                                </select>
                                <select
                                    aria-label="Search mode override"
                                    value=${searchMode}
                                    disabled=${searchProvider === "auto"}
                                    onChange=${(e) => setSearchMode(e.currentTarget.value)}
                                >
                                    <option value="">Provider default</option>
                                    ${(data.searchModes?.[searchProvider] ?? []).map((m) => html`<option value=${m}>${m}</option>`)}
                                </select>
                            </div>
                            <div class="search">
                                <${Icon} name="search" size=${16} />
                                <input
                                    type="text"
                                    placeholder="e.g. Node 24 features, Pi Pocket, or weather in Tokyo..."
                                    value=${searchQuery}
                                    onInput=${(e) => setSearchQuery(e.currentTarget.value)}
                                />
                                ${
                                    searchQuery &&
                                    html`<button
                                        type="button"
                                        class="search-clear icon-button"
                                        onClick=${() => setSearchQuery("")}
                                        title="Clear search query"
                                    >
                                        <${Icon} name="close" size=${13} />
                                    </button>`
                                }
                            </div>
                            <button
                                type="submit"
                                class="button primary"
                                disabled=${searching || !searchQuery.trim()}
                            >
                                ${searching ? html`<${Loader} label="Searching" />` : "Search"}
                            </button>
                        </form>

                        ${searchError && html`<div class="error-box small">${searchError}</div>`}
                        ${
                            searchOutput &&
                            html`<div class="web-search-results">
                                <div class="web-search-meta small muted">
                                    Provider:
                                    <b class="web-meta-bold"
                                        >${searchOutput.provider}/${searchOutput.mode ?? "default"}
                                        (${searchOutput.tier ?? "standard"})</b
                                    >
                                    · Query:
                                    <i class="web-meta-query">"${searchOutput.query}"</i>
                                    ·
                                    <b>${searchOutput.results.length}</b>
                                    results
                                </div>
                                <p class="muted small">
                                    ${searchOutput.attempts?.map((a) => `${a.provider}: ${a.outcome}`).join(" → ")}
                                </p>

                                ${
                                    searchOutput.synthesis &&
                                    html`<div class="web-synthesis-box">
                                        <div class="web-synthesis-head">
                                            <${Icon} name="sparkle" size=${14} />
                                            <strong>AI Summary</strong>
                                        </div>
                                        <p class="small">${searchOutput.synthesis}</p>
                                    </div>`
                                }

                                <div class="web-results-list">
                                    ${searchOutput.results.map(
                                        (item, idx) =>
                                            html`<div class="web-result-item" key=${idx}>
                                                <div class="web-result-head">
                                                    <span class="web-result-index"
                                                        >${idx + 1}.</span
                                                    >
                                                    <a
                                                        href=${item.url}
                                                        target="_blank"
                                                        rel="noopener noreferrer"
                                                        class="link web-result-link"
                                                    >
                                                        ${item.title || item.url}
                                                    </a>
                                                    ${
                                                        item.publishedDate &&
                                                        html`<span class="muted small"
                                                            >· ${item.publishedDate}</span
                                                        >`
                                                    }
                                                </div>
                                                <div class="web-result-url mono muted">
                                                    ${item.url}
                                                </div>
                                                ${
                                                    (item.content || item.snippet) &&
                                                    html`<div class="web-result-snippet small">
                                                        ${item.content || item.snippet}
                                                    </div>`
                                                }
                                            </div>`,
                                    )}
                                </div>
                            </div>`
                        }
                    </div>
                `
            }
        </div>
    </>`;
    }

    pocket.sheet({ id: "settings", title: "Web search", wide: true, component: WebAccessSheet });
    pocket.menu({ id: "settings", label: "Web search", sheet: "settings" });
    pocket.launcher({
        id: "settings",
        label: "Web search settings",
        icon: "globe",
        sheet: "settings",
        keywords: ["web", "search", "exa", "tavily", "routing", "usage"],
    });
}
