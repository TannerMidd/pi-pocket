// Spend: what each session and person cost, and their limits.
import { useEffect, useRef, useState } from "preact/hooks";
import { t } from "../i18n.js";
import { api, attempt, closeSheet, store } from "../store.js";
import { html, Icon, Loader, Sheet } from "../ui.js";

const money = (amount) => `$${amount.toFixed(2)}`;
const largest = (rows) => rows.reduce((max, row) => Math.max(max, row.spent), 1);

/** A spend limit, and (for the owner) a way to change it. */
function SpendLimit({ budget, editable, save }) {
    const [draft, setDraft] = useState(null);
    const field = useRef(null);
    const change = useRef(null);
    const edited = useRef(false);
    const editing = draft !== null;

    // Into the field as it opens; back to Change as it closes, so the keyboard keeps its place.
    useEffect(() => {
        if (editing) {
            field.current?.focus();
        } else if (edited.current) {
            change.current?.focus();
        }

        edited.current = editing;
    }, [editing]);

    if (draft === null) {
        return html`<span class="muted small">
            ${budget === undefined ? t("no limit") : t("limit {{amount}}", { amount: money(budget) })}
        </span>
        ${
            editable
                ? html`<button
                    class="link small spend-change"
                    ref=${change}
                    onClick=${() => setDraft(budget === undefined ? "" : String(budget))}
                >
                    ${t("Change")}
                </button>`
                : html`<span class="spend-change" aria-hidden="true"></span>`
        }`;
    }

    const done = (value) =>
        attempt(async () => {
            await save(value);
            setDraft(null);
        });

    return html`<span class="limit-edit">
        $<input type="number" inputmode="decimal" min="0.01" step="0.01" aria-label=${t("Limit in dollars")} ref=${field} value=${draft} onInput=${(event) => setDraft(event.currentTarget.value)} onKeyDown=${(
            event,
        ) => {
            // Esc lets go of the limit, not the whole sheet.
            if (event.key === "Escape") {
                event.stopPropagation();
                setDraft(null);
            }
        }} />
        <button
            class="button small primary"
            disabled=${!(Number(draft) > 0)}
            onClick=${() => done(Number(draft))}
        >
            ${t("Set")}
        </button>
        ${
            budget !== undefined &&
            html`<button class="button small ghost" onClick=${() => done(null)}>${t("No limit")}</button>`
        }
        <button class="icon-button" aria-label=${t("Cancel")} onClick=${() => setDraft(null)}>
            <${Icon} name="close" size=${16} />
        </button>
    </span>`;
}

/** Usage against a limit, or the largest spend in the group when there is no limit. */
function Usage({ row, max }) {
    const percent = Math.min(100, Math.max(0, (row.spent / (row.budget ?? max)) * 100));

    return html`<span
        class=${`spend-usage ${row.budget !== undefined && percent >= 80 ? "warn" : ""}`}
        style=${`--usage:${percent}%`}
        aria-hidden="true"
    ><span></span></span>`;
}

/** What Pi spent, by person and by session, with the owner's limits. */
export function SpendSheet() {
    const owner = store.state.me?.role === "owner";
    const [data, setData] = useState(null);

    useEffect(() => {
        attempt(async () => setData(await api("spend")));
    }, []);
    const save = (target) => async (budget) => setData(await api("spend", { ...target, budget }));
    const peopleMax = largest(data?.people ?? []);
    const sessionsMax = largest(data?.sessions ?? []);

    return html`<${Sheet} title=${t("Spend")} onClose=${closeSheet} wide=${true}>
        ${data === null && html`<${Loader} label=${t("Adding it up")} />`}
        ${
            data?.total !== undefined &&
            html`<p class="spend-total">${t("Pi spent {{amount}} on this server so far.", { amount: money(data.total) })}</p>`
        }
        <p class="muted small">
            ${t("Spend goes to whoever asked for the work. Past a limit, Pi takes no new messages there, a run that crosses it stops, and subagents' reports wait until it is raised.")}

        </p>
        ${
            data &&
            html`<div class="group">
                <div class="group-title">${t("People")}</div>
                <div class="sheet-list">
                    ${data.people.map(
                        (person) => html`<div class="spend-row" key=${person.id}>
                            <span class="grow">${person.name}</span>
                            <${Usage} row=${person} max=${peopleMax} />
                            <span class="mono">${money(person.spent)}</span>
                            <${SpendLimit}
                                budget=${person.budget}
                                editable=${owner && person.id !== store.state.me?.id}
                                save=${save({ person: person.id })}
                            />
                        </div>`,
                    )}
                </div>
            </div>
            <div class="group">
                <div class="group-title">${t("Sessions")}</div>
                <div class="sheet-list">
                    ${data.sessions.map(
                        (session) => html`<div class="spend-row" key=${session.id}>
                            <span class="grow">${session.title}</span>
                            <${Usage} row=${session} max=${sessionsMax} />
                            <span class="mono">${money(session.spent)}</span>
                            <${SpendLimit}
                                budget=${session.budget}
                                editable=${owner}
                                save=${save({ session: session.id })}
                            />
                        </div>`,
                    )}
                </div>
            </div>`
        }
    <//>`;
}
