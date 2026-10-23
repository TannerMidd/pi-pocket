// Provider options, ordered routing, and observed usage for Web access.
export default function createOptions({ html, useState }) {
    function RouteEditor({ label, routes, providers, modes, disabled, onChange }) {
        const move = (index, delta) => {
            const next = [...routes];

            [next[index], next[index + delta]] = [next[index + delta], next[index]];
            onChange(next);
        };

        return html`<fieldset class="web-options-group" disabled=${disabled}>
            <legend>${label}</legend>
            ${routes.map(
                (route, index) =>
                    html`<div class="web-route-row" key=${index}>
                        <span>${index + 1}.</span>
                        <select
                            aria-label=${`${label} provider ${index + 1}`}
                            value=${route.provider}
                            onChange=${(e) => onChange(routes.map((r, i) => (i === index ? { provider: e.currentTarget.value } : r)))}
                        >
                            ${providers.map((p) => html`<option value=${p}>${p}</option>`)}
                        </select>
                        ${
                            modes &&
                            html`<select
                                aria-label=${`${label} mode ${index + 1}`}
                                value=${route.mode ?? ""}
                                onChange=${(e) => onChange(routes.map((r, i) => (i === index ? { provider: r.provider, ...(e.currentTarget.value ? { mode: e.currentTarget.value } : {}) } : r)))}
                            >
                                <option value="">Provider default</option>
                                ${(modes[route.provider] ?? []).map((m) => html`<option value=${m}>${m}</option>`)}
                            </select>`
                        }
                        <div class="web-route-actions">
                            <button
                                type="button"
                                class="button"
                                aria-label=${`Move ${label} route ${index + 1} up`}
                                disabled=${index === 0}
                                onClick=${() => move(index, -1)}
                            >
                                ↑
                            </button>
                            <button
                                type="button"
                                class="button"
                                aria-label=${`Move ${label} route ${index + 1} down`}
                                disabled=${index === routes.length - 1}
                                onClick=${() => move(index, 1)}
                            >
                                ↓
                            </button>
                            <button
                                type="button"
                                class="button"
                                aria-label=${`Remove ${label} route ${index + 1}`}
                                disabled=${routes.length === 1}
                                onClick=${() => onChange(routes.filter((_, i) => i !== index))}
                            >
                                Remove
                            </button>
                        </div>
                    </div>`,
            )}
            <button
                type="button"
                class="button"
                disabled=${routes.length >= (modes ? 20 : providers.length)}
                onClick=${() => onChange([...routes, { provider: modes ? providers[0] : providers.find((p) => !routes.some((r) => r.provider === p)) }])}
            >
                Add ${label} fallback
            </button>
        </fieldset>`;
    }

    function ProviderOptions({ provider, fields, values, disabled, save }) {
        const [selected, setSelected] = useState(values);

        const submit = (event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const settings = Object.fromEntries(
                fields.map((f) => {
                    const raw = form.get(f.key);
                    const value =
                        f.type === "boolean"
                            ? raw === "on"
                            : f.type === "number"
                              ? Number(raw)
                              : f.type === "domains"
                                ? String(raw)
                                      .split(",")
                                      .map((v) => v.trim())
                                      .filter(Boolean)
                                : raw;

                    return [f.key, value];
                }),
            );

            save({ providerSettings: { [provider]: settings } });
        };

        return html`<details class="web-options-group">
            <summary>${provider} options</summary>
            <form onSubmit=${submit}>
                <fieldset disabled=${disabled} class="web-options-fields">
                    ${provider === "exa" && html`<p class="muted small">Lite serves cached content. Tier entries with an explicit mode override the provider default.</p>`}
                    ${fields.map(
                        (f) =>
                            html`<label class="web-option-field" key=${f.key}>
                                <span
                                    >${f.label}
                                    <span class="muted small">(${f.operation})</span></span
                                >
                                ${
                                    f.type === "select"
                                        ? html`<select
                                              name=${f.key}
                                              value=${selected[f.key]}
                                              onChange=${(e) => {
                                                  const value = e.currentTarget.value;

                                                  setSelected((was) => ({
                                                      ...was,
                                                      [f.key]: value,
                                                  }));
                                              }}
                                          >
                                              ${f.options.map((v) => html`<option value=${v}>${v}</option>`)}
                                          </select>`
                                        : f.type === "boolean"
                                          ? html`<input
                                                name=${f.key}
                                                type="checkbox"
                                                defaultChecked=${values[f.key]}
                                            />`
                                          : html`<input
                                                name=${f.key}
                                                type=${f.type === "number" ? "number" : "text"}
                                                min=${f.min}
                                                max=${f.max}
                                                step=${f.type === "number" ? 1 : undefined}
                                                defaultValue=${Array.isArray(values[f.key]) ? values[f.key].join(", ") : values[f.key]}
                                            />`
                                }
                            </label>`,
                    )}
                    <button type="submit" class="button">Save ${provider} options</button>
                </fieldset>
            </form>
        </details>`;
    }

    function WebAccessOptions({ data, disabled, save, refresh }) {
        const [period, setPeriod] = useState("month");
        const today = new Date().toISOString().slice(0, 10);
        const counters = {};

        for (const [day, rows] of Object.entries(data.usage.days)) {
            if (
                (period === "today" && day !== today) ||
                (period === "month" && !day.startsWith(today.slice(0, 7)))
            ) {
                continue;
            }

            for (const [key, row] of Object.entries(rows)) {
                const merged = (counters[key] ??= {
                    ...row,
                    requests: 0,
                    successes: 0,
                    failures: 0,
                    unknown: 0,
                    fallback: 0,
                    credits: 0,
                    dollars: 0,
                    creditReports: 0,
                    dollarReports: 0,
                });

                for (const field of [
                    "requests",
                    "successes",
                    "failures",
                    "unknown",
                    "fallback",
                    "credits",
                    "dollars",
                    "creditReports",
                    "dollarReports",
                ]) {
                    merged[field] += row[field] ?? 0;
                }
            }
        }

        const rows = Object.values(counters).sort((a, b) =>
            `${a.provider}:${a.operation}:${a.mode}:${a.purpose}`.localeCompare(
                `${b.provider}:${b.operation}:${b.mode}:${b.purpose}`,
            ),
        );
        const jobs = Object.values(data.usage.jobs).filter(
            (j) =>
                period === "all" ||
                (period === "today"
                    ? j.createdAt.startsWith(today)
                    : j.createdAt.startsWith(today.slice(0, 7))),
        );

        return html`<div class="web-access-options">
            <div class="label">Routing by search tier</div>
            <p class="muted small">
                Pi chooses quick, standard (default), or deep. Fallback stays within that tier. An
                explicit provider uses only that provider.
            </p>
            ${!data.tierRoutingEnabled && html`<p class="muted small">Standard currently follows your legacy primary/order. Editing a tier saves all three chains.</p>`}
            ${Object.entries(data.tierRouting).map(
                ([tier, routes]) =>
                    html`<${RouteEditor}
                        key=${tier}
                        label=${tier}
                        routes=${routes}
                        providers=${data.providers.map((p) => p.id)}
                        modes=${data.searchModes}
                        disabled=${disabled}
                        onChange=${(next) => save({ tierRouting: { ...data.tierRouting, [tier]: next } })}
                    />`,
            )}
            <${RouteEditor}
                label="extraction"
                routes=${data.extractOrder.map((provider) => ({ provider }))}
                providers=${["direct", "tavily", "exa"]}
                disabled=${disabled}
                onChange=${(next) => save({ extractOrder: [...new Set(next.map((r) => r.provider))] })}
            />
            <details class="web-options-group">
                <summary>Enabled operations</summary>
                ${Object.entries(data.capabilities).map(
                    ([provider, operations]) =>
                        html`<fieldset disabled=${disabled} class="web-options-fields">
                            <legend>${provider}</legend>
                            ${operations.map(
                                (op) =>
                                    html`<label class="web-option-field">
                                        <span>${op}</span>
                                        <input
                                            type="checkbox"
                                            checked=${data.operations[provider].includes(op)}
                                            onChange=${(e) => save({ operations: { ...data.operations, [provider]: e.currentTarget.checked ? [...data.operations[provider], op] : data.operations[provider].filter((v) => v !== op) } })}
                                        />
                                    </label>`,
                            )}
                        </fieldset>`,
                )}
            </details>
            ${Object.entries(data.settingFields).map(
                ([provider, fields]) =>
                    html`<${ProviderOptions}
                        key=${provider + JSON.stringify(data.providerSettings[provider])}
                        provider=${provider}
                        fields=${fields}
                        values=${data.providerSettings[provider]}
                        disabled=${disabled}
                        save=${save}
                    />`,
            )}
            <div class="label">Observed requests</div>
            <p class="muted small">
                Pi Pocket requests since ${data.usage.since.slice(0, 10)}. UTC dates; excludes usage
                outside this app. Missing provider usage means unknown cost.
            </p>
            <div class="web-route-row">
                <select
                    aria-label="Usage period"
                    value=${period}
                    onChange=${(e) => setPeriod(e.currentTarget.value)}
                >
                    <option value="today">Today</option>
                    <option value="month">This month</option>
                    <option value="all">All time</option>
                </select>
                <button type="button" class="button" onClick=${refresh}>Refresh usage</button>
            </div>
            <p class="small">
                ${rows.reduce((sum, row) => sum + row.requests, 0)} requests · ${jobs.length}
                research jobs (${jobs.filter((j) => j.status === "completed").length} completed,
                ${jobs.filter((j) => j.status === "failed").length} failed)
            </p>
            ${rows.map(
                (row) =>
                    html`<div class="web-usage-row small">
                        <strong>${row.provider} · ${row.operation} / ${row.mode}</strong>
                        <span
                            >${row.purpose} · ${row.requests} requests · ${row.successes} OK ·
                            ${row.failures} failed · ${row.unknown} pending/unknown ·
                            ${row.fallback} fallback</span
                        >
                        <span class="muted"
                            >${row.creditReports ? `${row.credits} reported credits` : "Credits unknown"}
                            ·
                            ${row.dollarReports ? `$${row.dollars.toFixed(4)} reported cost` : "Dollar cost unknown"}</span
                        >
                    </div>`,
            )}
            ${
                jobs.length > 0 &&
                html`<details class="web-options-group">
                    <summary>Research jobs</summary>
                    ${jobs
                        .slice(-20)
                        .reverse()
                        .map(
                            (job) =>
                                html`<p class="small">
                                    <code>${job.id}</code> · ${job.mode} · ${job.status}
                                </p>`,
                        )}
                </details>`
            }
        </div>`;
    }

    return WebAccessOptions;
}
