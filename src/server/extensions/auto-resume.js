// Auto-resume's browser module: a menu row that opens its sheet, with this chat's choice and next try, and the owner's
// default and delay for every chat.
export const pocketApi = 1;

const DELAYS = [15, 30, 60, 120, 180, 300];

const clock = (at) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const length = (minutes) => (minutes < 60 ? `${minutes} min` : `${minutes / 60} h`);

export default function setup(pocket) {
    const { html, useEffect, useState, Loader, Switch } = pocket;

    function AutoResume() {
        const id = pocket.conversationId();
        const owner = pocket.me()?.role === "owner";
        const [state, setState] = useState(null);
        const [error, setError] = useState(null);

        const run = async (call) => {
            try {
                setState(await call());
                setError(null);
            } catch (failure) {
                setError(failure.message);
            }
        };

        const read = () => pocket.api(`chat/${id}`);
        const chat = (body) => run(() => pocket.api(`chat/${id}`, body));
        const settings = (body) =>
            run(async () => {
                await pocket.api("settings", body);

                return read();
            });

        useEffect(() => {
            if (id !== null) {
                void run(read);
            }
        }, [id]);

        if (id === null) {
            return html`<div class="muted small">Open a chat first.</div>`;
        }

        if (error) {
            return html`<div class="error-box">${error}</div>`;
        }

        if (!state) {
            return html`<${Loader} label="Reading auto-resume" />`;
        }

        return html`<div class="setting">
                <div class="grow small">This chat</div>
                ${
                    state.choice !== null &&
                    html`<button class="button small" onClick=${() => chat({ on: null })}>
                        Use default
                    </button>`
                }
                <${Switch}
                    on=${state.on}
                    label=${`Auto-resume in this chat: ${state.on ? "on" : "off"}`}
                    onChange=${() => chat({ on: !state.on })}
                />
            </div>
            ${
                state.pending &&
                html`<div class="setting">
                    <div class="grow small">
                        Next try ${clock(state.pending.next)} ·
                        ${state.pending.tries + 1}/${state.maxTries}
                    </div>
                    <button class="button small" onClick=${() => chat({ cancel: true })}>
                        Cancel
                    </button>
                </div>`
            }
            ${
                owner &&
                html`<div class="setting">
                        <div class="grow small">All chats by default</div>
                        <${Switch}
                            on=${state.defaultOn}
                            label=${`Auto-resume by default: ${state.defaultOn ? "on" : "off"}`}
                            onChange=${() => settings({ defaultOn: !state.defaultOn })}
                        />
                    </div>
                    <div class="setting">
                        <div class="grow small">Retry without a reset time</div>
                        <select
                            style="width: auto; flex: none"
                            aria-label="Retry without a reset time"
                            value=${state.delayMinutes}
                            onChange=${(event) =>
                                settings({ delayMinutes: Number(event.currentTarget.value) })}
                        >
                            ${[...new Set([...DELAYS, state.delayMinutes])]
                                .sort((a, b) => a - b)
                                .map(
                                    (minutes) =>
                                        html`<option value=${minutes}>${length(minutes)}</option>`,
                                )}
                        </select>
                    </div>`
            }`;
    }

    pocket.sheet({ id: "auto-resume", title: "Auto-resume", component: AutoResume });
    pocket.menu({ id: "auto-resume", label: "Auto-resume", sheet: "auto-resume" });
}
