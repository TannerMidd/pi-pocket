// Spend: what each session and person cost, and their limits.
import { useEffect, useRef, useState } from "preact/hooks";
import { api, attempt, closeSheet, store } from "../store.js";
import { html, Icon, Loader, Sheet } from "../ui.js";

const money = (amount) => `$${amount.toFixed(2)}`;
const largest = (rows) => rows.reduce((max, row) => Math.max(max, row.spent), 1);

/** A spend limit, and (for the owner) a way to change it. */
function SpendLimit({ budget, editable, save, label }) {
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
            ${budget === undefined ? "no limit" : `limit ${money(budget)}`}
        </span>
        ${
            editable
                ? html`<button
                    class="link small spend-change"
                    aria-label=${label}
                    ref=${change}
                    onClick=${() => setDraft(budget === undefined ? "" : String(budget))}
                >
                    Change
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
        $<input type="number" inputmode="decimal" min="0.01" step="0.01" aria-label="Limit in dollars" ref=${field} value=${draft} onInput=${(event) => setDraft(event.currentTarget.value)} onKeyDown=${(
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
            Set
        </button>
        ${
            budget !== undefined &&
            html`<button class="button small ghost" onClick=${() => done(null)}>No limit</button>`
        }
        <button class="icon-button" aria-label="Cancel" onClick=${() => setDraft(null)}>
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

function SessionRow({ session, max, budget, lead, owner, save }) {
    return html`<div class="spend-row">
        <span class="grow" title=${session.title}>${session.title}</span>
        <${Usage} row=${{ spent: session.spent, budget }} max=${max} />
        <span class="mono">${money(session.spent)}</span>
        ${
            lead
                ? html`<span class="muted small">Team lead</span>
                  <span class="spend-change" aria-hidden="true"></span>`
                : html`<${SpendLimit}
                    budget=${budget}
                    editable=${owner}
                    save=${save({ session: session.id })}
                    label=${`Change limit for ${session.title}`}
                />`
        }
    </div>`;
}

function SessionSpend({ data, owner, save }) {
    const teams = data.teams ?? [];
    const members = new Set(teams.flatMap((team) => team.members.map((member) => member.id)));
    const budgets = new Map(data.sessions.map((session) => [session.id, session.budget]));
    const single = data.sessions.filter((session) => !members.has(session.id));
    const max = Math.max(largest(data.sessions), largest(teams));

    return html`${
        teams.length > 0 &&
        html`<div class="group spend-teams">
            <div class="group-title">Teams</div>
            <p class="muted small">
                Team totals cover the sessions you can see, including their subagents. The lead's limit applies to the whole team.
            </p>
            ${teams.map((team) => {
                const title = team.members[0].title;
                const budget = budgets.get(team.lead);

                return html`<section
                    class="sheet-list spend-team"
                    key=${team.lead}
                    aria-label=${`Team led by ${title}`}
                >
                    <div class="spend-row spend-team-total">
                        <h3 class="grow">Team total</h3>
                        <${Usage} row=${{ spent: team.spent, budget }} max=${max} />
                        <strong class="mono">${money(team.spent)}</strong>
                        <${SpendLimit}
                            budget=${budget}
                            editable=${owner}
                            save=${save({ session: team.lead })}
                            label=${`Change team limit for ${title}`}
                        />
                    </div>
                    ${team.members.map(
                        (member) => html`<${SessionRow}
                            key=${member.id}
                            session=${member}
                            max=${max}
                            budget=${member.id === team.lead ? undefined : budgets.get(member.id)}
                            lead=${member.id === team.lead}
                            owner=${owner}
                            save=${save}
                        />`,
                    )}
                </section>`;
            })}
        </div>`
    }
    ${
        (single.length > 0 || teams.length === 0) &&
        html`<div class="group">
            <div class="group-title">${teams.length ? "Other sessions" : "Sessions"}</div>
            <div class="sheet-list">
                ${single.map(
                    (session) => html`<${SessionRow}
                        key=${session.id}
                        session=${session}
                        max=${max}
                        budget=${session.budget}
                        owner=${owner}
                        save=${save}
                    />`,
                )}
            </div>
        </div>`
    }`;
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

    return html`<${Sheet} title="Spend" onClose=${closeSheet} wide=${true}>
        ${data === null && html`<${Loader} label="Adding it up" />`}
        ${
            data?.total !== undefined &&
            html`<p class="spend-total">
                <span>Pi spent</span> <strong>${money(data.total)}</strong> <span>on this server so far.</span>
            </p>`
        }
        <p class="muted small">
            Spend goes to whoever asked for the work. Past a limit, Pi takes no new messages there, a run that crosses it stops, and subagents' reports wait until it is raised.
        </p>
        ${
            data &&
            html`<div class="group">
                <div class="group-title">People</div>
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
            <${SessionSpend} data=${data} owner=${owner} save=${save} />`
        }
    <//>`;
}
