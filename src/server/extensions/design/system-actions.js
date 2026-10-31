import { systemRequest, tokenRequest } from "./messages.js";
import {
    editsOf,
    emptyHistory,
    groupsOf,
    guidelinesEdit,
    push,
    redo,
    sectionOf,
    tokenEdit,
    undo,
} from "./system.js";

const IDLE = { status: "idle", error: "", problems: [], note: "" };

export function createSystemActions(env) {
    const { store } = env;
    const fresh = (s) => (s.save.status === "saving" ? s.save : IDLE);

    return {
        editToken(name, mode, raw) {
            store.set((s) => ({
                history: push(s.history, tokenEdit(mode, name, raw)),
                save: fresh(s),
            }));
        },

        editGuidelines(text) {
            store.set((s) => ({ history: push(s.history, guidelinesEdit(text)), save: fresh(s) }));
        },

        resetToken(name) {
            const { system, history } = store.get();
            const token = system.data?.tokens.find((each) => each.name === name);

            if (token === undefined) {
                return;
            }

            let next = history;

            for (const [, op] of editsOf(history)) {
                if (op.kind === "token" && op.token === name) {
                    const saved = token.modes[op.mode];
                    const own = system.data.overrides?.[op.mode];
                    // A token that the mode's file does not set inherits the default again.
                    const raw =
                        op.mode !== system.data.modes[0] &&
                        Array.isArray(own) &&
                        !own.includes(name)
                            ? { inherit: true }
                            : saved.alias === undefined
                              ? { value: saved.value }
                              : { alias: saved.alias };

                    next = push(next, tokenEdit(op.mode, name, raw), Date.now(), false);
                }
            }

            store.set({ history: next });
        },

        // A removal, not a copy of the default's value: a copy would stop following the default.
        inheritToken(name, mode) {
            env.editToken(name, mode, { inherit: true });
        },

        pickPart(token, mode, part) {
            store.set({ sysPick: { token, mode, part } });
        },

        undo() {
            store.set((s) => ({ history: undo(s.history), save: fresh(s) }));
        },

        redo() {
            store.set((s) => ({ history: redo(s.history), save: fresh(s) }));
        },

        discard() {
            store.set((s) => ({ history: emptyHistory(), save: fresh(s), sysWriting: false }));
        },

        setSysMode(sysMode) {
            store.set({ sysMode });
        },

        setSection(sysSection) {
            store.set({ sysSection, sysOpen: null, sysPick: null });
        },

        pickAlias(token, mode) {
            store.set({ sysPick: { token, mode } });
        },

        closePick() {
            store.set({ sysPick: null });
        },

        toggleToken(name) {
            const opening = store.get().sysOpen !== name;

            store.set((s) => ({ sysOpen: s.sysOpen === name ? null : name }));

            if (opening) {
                requestAnimationFrame(() =>
                    requestAnimationFrame(() => {
                        const scroll = document.querySelector(".dsy-scroll");
                        const editor = scroll?.querySelector(
                            `.dsy-ramp-editor[data-token="${CSS.escape(name)}"], .dsy-row.open[data-token="${CSS.escape(name)}"]`,
                        );

                        if (!scroll || !editor) {
                            return;
                        }

                        const room = scroll.getBoundingClientRect();
                        const box = editor.getBoundingClientRect();
                        const need = Math.min(box.height, 280);

                        if (box.top < room.top || box.top + need > room.bottom) {
                            scroll.scrollBy({ top: box.top - room.top - 8, behavior: "smooth" });
                        }
                    }),
                );
            }
        },

        toggleGroup(id, fold) {
            store.set((s) => ({ sysFolded: { ...s.sysFolded, [id]: fold } }));
        },

        showAll(id) {
            store.set((s) => ({ sysAll: { ...s.sysAll, [id]: true } }));
        },

        openToken(name) {
            const system = store.get().system.data;
            const token = system?.tokens.find((each) => each.name === name);

            if (token === undefined) {
                return;
            }

            const section = sectionOf(token);
            const group = groupsOf(system.tokens, section).find((each) =>
                each.tokens.some((other) => other.name === name),
            );

            store.set((s) => ({
                view: "system",
                sysSection: section,
                sysOpen: name,
                sysQuery: "",
                sysPane: "system",
                sysFolded: {
                    ...s.sysFolded,
                    ...(group ? { [group.id]: false } : {}),
                    ...(section === "colors" && token.tier === "primitive"
                        ? { "colors:palette": false }
                        : {}),
                    ...(section === "colors" && token.tier === "component"
                        ? { "colors:components": false }
                        : {}),
                },
                sysAll: group ? { ...s.sysAll, [group.id]: true } : s.sysAll,
            }));

            // Two frames: the section must draw first.
            requestAnimationFrame(() =>
                requestAnimationFrame(() =>
                    document
                        .querySelector(`.dsy-scroll [data-token="${CSS.escape(name)}"]`)
                        ?.scrollIntoView({ block: "center", behavior: "smooth" }),
                ),
            );
        },

        askPi(kind) {
            env.sendToBox(systemRequest(kind));
        },

        askPiAbout(token) {
            env.sendToBox(
                tokenRequest({
                    token,
                    values: Object.fromEntries(
                        Object.entries(token.modes).map(([mode, each]) => [mode, each.value]),
                    ),
                }),
            );
        },
    };
}
