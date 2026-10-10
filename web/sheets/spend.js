// Spend: what each session and person cost, and their limits.
import { useEffect, useState } from "preact/hooks";
import { t } from "../i18n.js";
import { api, attempt, closeSheet, store } from "../store.js";
import { html, Loader, Sheet } from "../ui.js";

const money = (amount) => `$${amount.toFixed(2)}`;

/** A spend limit, and (for the owner) a way to change it. */
function SpendLimit({ budget, editable, save }) {
    const [draft, setDraft] = useState(null);

    if (draft === null) {
        return html`<span class="muted small">
            ${budget === undefined ? t("no limit") : t("limit {{amount}}", { amount: money(budget) })}
        </span>
        ${
            editable &&
            html`<button
                class="link small"
                onClick=${() => setDraft(budget === undefined ? "" : String(budget))}
            >
                ${t("Change")}
            </button>`
        }`;
    }

    const done = (value) =>
        attempt(async () => {
            await save(value);
            setDraft(null);
        });

    return html`<span class="limit-edit">
        $<input type="number" inputmode="decimal" min="0.01" step="0.01" autofocus value=${draft} onInput=${(event) => setDraft(event.currentTarget.value)} />
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
    </span>`;
}

/** What Pi spent, by person and by session, with the owner's limits. */
export function SpendSheet() {
    const owner = store.state.me?.role === "owner";
    const [data, setData] = useState(null);

    useEffect(() => {
        attempt(async () => setData(await api("spend")));
    }, []);
    const save = (target) => async (budget) => setData(await api("spend", { ...target, budget }));

    return html`<${Sheet} title=${t("Spend")} onClose=${closeSheet}>
        ${data === null && html`<${Loader} label=${t("Adding it up")} />`}
        ${
            data?.total !== undefined &&
            html`<p>${t("Pi spent {{amount}} on this server so far.", { amount: money(data.total) })}</p>`
        }
        <p class="muted small">
            ${t("Spend goes to whoever asked for the work. Past a limit, Pi takes no new messages there, a run that crosses it stops, and subagents' reports wait until it is raised.")}

        </p>
        ${
            data &&
            html`<div class="group">
                <div class="group-title">${t("People")}</div>
                ${data.people.map(
                    (person) => html`<div class="spend-row" key=${person.id}>
                        <span class="grow">${person.name}</span>
                        <span class="mono">${money(person.spent)}</span>
                        <${SpendLimit}
                            budget=${person.budget}
                            editable=${owner && person.id !== store.state.me?.id}
                            save=${save({ person: person.id })}
                        />
                    </div>`,
                )}
            </div>
            <div class="group">
                <div class="group-title">${t("Sessions")}</div>
                ${data.sessions.map(
                    (session) => html`<div class="spend-row" key=${session.id}>
                        <span class="grow">${session.title}</span>
                        <span class="mono">${money(session.spent)}</span>
                        <${SpendLimit}
                            budget=${session.budget}
                            editable=${owner}
                            save=${save({ session: session.id })}
                        />
                    </div>`,
                )}
            </div>`
        }
    <//>`;
}
