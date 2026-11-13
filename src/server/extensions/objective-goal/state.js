// The Goal UI's one live view. Late reads and writes never follow the person into another session.
export function createGoalState(api, options = {}) {
    const schedule = options.schedule ?? setTimeout;
    const cancel = options.cancel ?? clearTimeout;
    const requestId = options.requestId ?? (() => crypto.randomUUID());
    const visible = options.visible ?? (() => true);
    const listeners = new Set();
    let state = { id: null, goal: null, loaded: false, canSteer: false, busy: false, error: null };
    let scope = new AbortController();
    let generation = 0;
    let read = 0;
    let timer;
    let pending;
    let commandError = null;
    let readFailures = 0;
    let readDenied = false;
    let disposed = false;

    const publish = (patch) => {
        state = { ...state, ...patch };

        for (const listener of listeners) {
            listener(state);
        }
    };

    const next = () => {
        cancel(timer);

        if (!disposed && state.id !== null && !readDenied) {
            timer = schedule(() => void refresh(), Math.min(30000, 2000 * 2 ** readFailures));
        }
    };

    const current = (id, epoch) => !disposed && state.id === id && generation === epoch;

    async function refresh(clearError = false) {
        if (disposed || state.id === null || state.busy) {
            return;
        }

        if (clearError) {
            commandError = null;
        }

        if (!visible()) {
            next();

            return;
        }

        const { id } = state;
        const epoch = generation;
        const version = ++read;

        cancel(timer);

        try {
            const answer = await api(`goals/${id}`, undefined, { signal: scope.signal });

            if (current(id, epoch) && version === read) {
                readFailures = 0;
                readDenied = false;
                publish({ ...answer, loaded: true, error: commandError });
            }
        } catch (error) {
            if (current(id, epoch) && version === read) {
                readFailures = Math.min(readFailures + 1, 4);
                readDenied = [400, 401, 403, 404].includes(error.status);
                publish({ loaded: true, canSteer: false, error: error.message });
            }
        } finally {
            if (current(id, epoch) && version === read) {
                next();
            }
        }
    }

    return {
        get: () => state,
        subscribe(listener) {
            listeners.add(listener);

            return () => listeners.delete(listener);
        },
        follow(id) {
            if (disposed || id === state.id) {
                return;
            }

            scope.abort();
            scope = new AbortController();
            generation++;
            read++;
            pending = undefined;
            commandError = null;
            readFailures = 0;
            readDenied = false;
            cancel(timer);
            publish({ id, goal: null, loaded: false, canSteer: false, busy: false, error: null });
            void refresh();
        },
        refresh,
        async change(args, revision) {
            if (disposed || state.id === null || state.busy || !state.canSteer) {
                return false;
            }

            const { id } = state;
            const epoch = generation;

            read++;
            cancel(timer);

            // A lost response can be retried with the same admission key, not a second goal submission.
            if (pending?.args !== args || pending.revision !== revision) {
                pending = { args, revision, requestId: requestId() };
            }

            const body = pending;

            commandError = null;
            publish({ busy: true, error: null });

            try {
                const answer = await api(`goals/${id}`, body, { signal: scope.signal });

                if (!current(id, epoch)) {
                    return false;
                }

                pending = undefined;
                publish({ ...answer, loaded: true, error: null });

                return true;
            } catch (error) {
                if (current(id, epoch)) {
                    commandError = error.message;
                    publish({ error: commandError });
                }

                return false;
            } finally {
                if (current(id, epoch)) {
                    publish({ busy: false });
                    next();
                }
            }
        },
        dispose() {
            disposed = true;
            scope.abort();
            cancel(timer);
            listeners.clear();
        },
    };
}

export const goalLabels = {
    active: "Active",
    paused: "Paused",
    blocked: "Blocked",
    completed: "Completed",
    budget: "Budget reached",
};

export function goalNeedsBudget(goal) {
    return goal.status === "budget" && goal.budget !== null && goal.tokens >= goal.budget;
}

export function goalSummary(goal) {
    return [
        `Goal: ${goal.objective}`,
        `Status: ${goalLabels[goal.status] ?? goal.status}`,
        `Turns evaluated: ${goal.turns}`,
        `Tokens: ${goal.tokens}${goal.budget === null ? "" : ` / ${goal.budget}`}`,
        ...(goal.reason ? [`Latest result: ${goal.reason}`] : []),
    ].join("\n");
}
