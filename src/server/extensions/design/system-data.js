import { downloadFile, splitReport } from "./data.js";
import { changeNow } from "./unsaved.js";

// Not imported from system.js: that loads only with the System view.
const emptyHistory = () => ({ past: [], future: [] });

export const checkKey = (artifact, version, mode, size) => `${artifact}@${version}:${mode}:${size}`;

export function createSystemData(pocket, store, data) {
    const conversationOf = () => store.get().conversation;
    const current = (conversation) => store.get().conversation === conversation;
    const fail = (error) => pocket.notify("error", `Design system: ${error?.message ?? error}`);
    let reading = 0;
    let noteTimer = 0;

    const note = (text) => {
        clearTimeout(noteTimer);
        store.set({ save: { status: "saved", error: "", problems: [], note: text } });
        noteTimer = setTimeout(() => {
            if (store.get().save.status === "saved") {
                store.set({ save: { status: "idle", error: "", problems: [], note: "" } });
            }
        }, 4000);
    };

    const took = (result, extra = {}) =>
        store.set({
            system: {
                status: "ready",
                data: result.system ?? null,
                legacy: result.legacy ?? null,
                error: "",
            },
            ...extra,
        });

    const api = {
        async load({ quiet = false } = {}) {
            const conversation = conversationOf();

            if (conversation === null) {
                return;
            }

            const mine = ++reading;
            const have = store.get().system;
            const revision = have.data?.revision;

            if (!quiet || have.status === "idle") {
                store.set({
                    system: { ...have, status: have.data ? "ready" : "loading", error: "" },
                });
            }

            try {
                const result = await pocket.api(
                    `c/${conversation}/system${quiet && revision ? `?revision=${encodeURIComponent(revision)}` : ""}`,
                );

                if (!current(conversation) || mine !== reading) {
                    return;
                }

                if (result.unchanged) {
                    if (have.status !== "ready") {
                        store.set({ system: { ...store.get().system, status: "ready" } });
                    }

                    return;
                }

                took(result);
            } catch (error) {
                if (current(conversation) && mine === reading) {
                    store.set({
                        system: {
                            ...store.get().system,
                            status: store.get().system.data ? "ready" : "failed",
                            error: error?.message ?? "The design system could not be read.",
                        },
                    });
                }
            }
        },

        async save() {
            const state = store.get();
            const conversation = state.conversation;
            const system = state.system.data;

            if (!system || state.save.status === "saving") {
                return false;
            }

            const { set, remove, guidelines, count } = changeNow(system, state.history);

            if (count === 0) {
                store.set({ history: emptyHistory() });

                return true;
            }

            store.set({ save: { status: "saving", error: "", problems: [], note: "" } });

            try {
                const result = await pocket.api(`c/${conversation}/system`, {
                    ...(set.length > 0 ? { set } : {}),
                    ...(remove === undefined ? {} : { remove }),
                    ...(guidelines === undefined ? {} : { guidelines }),
                    baseRevision: system.revision,
                });

                if (!current(conversation)) {
                    return false;
                }

                if (!result.ok) {
                    store.set({
                        save: {
                            status: "failed",
                            error: result.error ?? "The save failed.",
                            problems: result.problems ?? [],
                            note: "",
                        },
                    });

                    return false;
                }

                took(result, { history: emptyHistory(), sysWriting: false });

                const css = result.system?.dist?.["tokens.css"];

                note(
                    `Saved ${count} change${count === 1 ? "" : "s"}${css > 0 ? ` · tokens.css ${(css / 1024).toFixed(1)} KB` : ""}`,
                );

                return true;
            } catch (error) {
                if (current(conversation)) {
                    store.set({
                        save: {
                            status: error?.status === 409 ? "conflict" : "failed",
                            error: error?.message ?? "The save failed.",
                            problems: [],
                            note: "",
                        },
                    });
                }

                return false;
            }
        },

        async reload() {
            store.set({ save: { status: "idle", error: "", problems: [], note: "" } });
            await api.load();
        },

        async changeModes(name, value) {
            const conversation = conversationOf();
            const system = store.get().system.data;

            try {
                const result = await pocket.api(`c/${conversation}/system`, {
                    modes: { [name]: value },
                    baseRevision: system?.revision,
                });

                if (!current(conversation)) {
                    return false;
                }

                if (!result.ok) {
                    fail(new Error(result.error));

                    return false;
                }

                took(result, {
                    history:
                        value === null
                            ? {
                                  past: store.get().history.past.filter((op) => op.mode !== name),
                                  future: [],
                              }
                            : store.get().history,
                    sysMode: store.get().sysMode === name ? null : store.get().sysMode,
                });
                note(value === null ? `Removed ${name}` : `Added the ${name} mode`);

                return true;
            } catch (error) {
                fail(error);

                return false;
            }
        },

        async check({ artifact, version, mode, scheme, size }) {
            const conversation = conversationOf();
            const key = checkKey(artifact, version, mode, size);
            const put = (value) => store.set((s) => ({ checks: { ...s.checks, [key]: value } }));

            put({ status: "running" });

            try {
                const result = await pocket.api(`c/${conversation}/system/check`, {
                    id: artifact,
                    version,
                    colorScheme: scheme,
                    ...(mode === undefined ? {} : { mode }),
                    viewport: size,
                });

                if (current(conversation)) {
                    // The notes may be newer than the check: split with the current accepted list.
                    const accepted = store.get().notes[artifact]?.accepted;

                    put({
                        status: "done",
                        report: accepted ? splitReport(result.report, accepted) : result.report,
                        at: Date.now(),
                    });
                }
            } catch (error) {
                if (current(conversation)) {
                    put({ status: "failed", error: error?.message ?? "The check failed." });
                }
            }
        },

        async fix({ artifact, version, mode, scheme, size }) {
            const conversation = conversationOf();

            try {
                const made = await pocket.api(`c/${conversation}/system/fix`, {
                    id: artifact,
                    version,
                    colorScheme: scheme,
                    ...(mode === undefined ? {} : { mode }),
                    viewport: size,
                    key: crypto.randomUUID(),
                });

                pocket.notify(
                    "info",
                    `Fixed ${made.fixed} exact match${made.fixed === 1 ? "" : "es"}: version ${made.version}.`,
                );

                return current(conversation) ? made : null;
            } catch (error) {
                fail(error);

                return null;
            }
        },

        async publishDocs() {
            const conversation = conversationOf();

            try {
                const made = await pocket.api(`c/${conversation}/system/docs`, {
                    key: crypto.randomUUID(),
                });

                await data.list();

                return made;
            } catch (error) {
                fail(error);

                return null;
            }
        },

        async exportCode() {
            const conversation = conversationOf();

            try {
                const made = await pocket.api(`c/${conversation}/system/export`, {});

                downloadFile(conversation, made);
                pocket.notify("info", `Saved ${made.name}. It is also at ${made.path}`);

                return true;
            } catch (error) {
                fail(error);

                return false;
            }
        },
    };

    return api;
}
