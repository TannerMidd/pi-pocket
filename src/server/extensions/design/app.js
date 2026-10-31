// The workspace of Design: `index.js` loads this file when the panel first opens, not at the app's start.
import { openSheet, store as app } from "/store.js";
import { createData, designsOf } from "./data.js";
import { clampSize } from "./devices.js";
import { variationMessage } from "./messages.js";
import { createParts } from "./parts.js";
import { createSystemData } from "./system-data.js";
import { createWorkspace } from "./workspace.js";

/** The most the message box takes (`insertText`). */
const BOX_LIMIT = 90_000;

/** `shell.style(name)` loads a stylesheet of the module and resolves when it applies. */
export function createApp(pocket, store, shell) {
    const data = createData(pocket, store);
    const systemData = createSystemData(pocket, store, data);
    const parts = createParts(pocket);
    const canEdit = () => app.state.me?.role !== undefined && app.state.me.role !== "viewer";
    /** The mode goes off, so an editor's comments or edits dock goes too, or its tab stays lit. */
    const modeless = () =>
        canEdit() && ["comments", "edits"].includes(store.get().dock) ? { dock: null } : {};

    const env = {
        pocket,
        store,
        style: shell.style,
        data,
        systemData,
        parts,
        app,
        /** The page's frame, for the parts that talk to it (the slide strip): `{ send, goto, supported }`, or null. */
        frame: { current: null },
        canEdit,
        darkTheme: () => store.get().appDark,
        canvasDark: (state) =>
            state.backdrop === "dark" || (state.backdrop === "auto" && state.appDark),
        sizeClass: (state) => {
            const width = state.width || 1000;

            return width < 560 ? "narrow" : width < 900 ? "medium" : "wide";
        },
        beside: () => matchMedia("(min-width: 1100px)").matches,
        designs: () => designsOf(app.state.view, store.get().listed),
        current: () => env.designs().find((each) => each.id === store.get().artifact) ?? null,
        /** The design a person means by a name: its id, else the start of an id, else words of its title. */
        find(designs, query) {
            const words = String(query ?? "")
                .trim()
                .toLowerCase();

            if (words === "") {
                return designs[0];
            }

            return (
                designs.find((each) => each.id === words) ??
                designs.find((each) => each.id.startsWith(words)) ??
                designs.find((each) => each.title.toLowerCase().includes(words))
            );
        },

        /** Put a message in the message box for the person to read and send. On a phone the chat comes back to show it. */
        sendToBox(text) {
            if (text.length > BOX_LIMIT) {
                pocket.notify(
                    "error",
                    "That is too much for one message. Mark some comments done, and send the rest.",
                );

                return;
            }

            pocket.insertText(text);
            pocket.notify("info", "In your message box: read it, then send it.");

            if (!env.beside()) {
                pocket.closePanel();
            }
        },

        open(id, version = null) {
            const same = store.get().artifact === id;

            // The page's own knobs and slides go when its frame does (`CanvasView`): the same design's frame stays.
            store.set({
                artifact: id,
                version,
                view: "canvas",
                compare: null,
                mode: "view",
                ...modeless(),
                draft: null,
                present: false,
                checkFocus: null,
                ...(same ? {} : { slide: 0 }),
            });
        },
        showVersion(version) {
            store.set({ version, view: "canvas", draft: null });
        },
        compare(a, b) {
            const design = env.current();
            const latest = design?.versions.at(-1)?.version ?? 1;

            store.set({
                view: "compare",
                compare: { a: a ?? Math.max(1, latest - 1), b: b ?? latest },
                mode: "view",
                ...modeless(),
                draft: null,
            });
        },
        setView(view) {
            store.set({
                view,
                mode: view === "canvas" ? store.get().mode : "view",
                draft: null,
                ...(view === "grid" ? { dock: null } : {}),
            });
        },
        setDock(dock) {
            store.set(
                dock === null
                    ? { dock: null, mode: "view", draft: null, checkFocus: null }
                    : { dock },
            );
        },
        setTab(tab) {
            const s = store.get();
            const edit = canEdit();
            const tabs = {
                view: { mode: "view", dock: null },
                comment: { mode: edit ? "comment" : "view", dock: "comments" },
                edit: { mode: "edit", dock: "edits" },
                tweaks: { mode: "view", dock: "tweaks" },
                versions: { mode: "view", dock: "versions" },
                check: { mode: "view", dock: "check" },
            };
            const next = tabs[tab] ?? tabs.view;
            const same = s.mode === next.mode && s.dock === next.dock;
            const to = same ? tabs.view : next;

            store.set({
                ...to,
                draft: to.mode === "comment" ? s.draft : null,
                view: tab === "versions" || s.view === "canvas" ? s.view : "canvas",
            });

            // Others comment as this tab looks: read them when the list opens, as well as when they say so.
            if (to.dock === "comments" && s.artifact !== null) {
                void data.notes(s.artifact);
            }
        },
        setDevice(device) {
            store.set({ device });
        },
        setCustom(size) {
            const custom = { ...store.get().custom };

            for (const [key, value] of Object.entries(size)) {
                custom[key] = clampSize(value, custom[key]);
            }

            store.set({ custom, device: "custom" });
        },
        setZoom(zoom) {
            store.set({ zoom });
        },
        setBackdrop(backdrop) {
            store.set({ backdrop });
        },
        reloadFrame() {
            store.set((s) => ({ reload: s.reload + 1 }));
        },

        setTweak(artifact, knob, value) {
            const s = store.get();
            const values = { ...(s.tweaks[artifact] ?? {}), [knob.name]: value };

            if (value === knob.value) {
                delete values[knob.name];
            }

            store.set({ tweaks: { ...s.tweaks, [artifact]: values } });
            data.saveTweaks(artifact, values);
        },
        resetTweaks(artifact) {
            store.set((s) => ({ tweaks: { ...s.tweaks, [artifact]: {} } }));
            data.saveTweaks(artifact, null);
        },

        useVariation(each, others) {
            env.sendToBox(
                variationMessage({ title: each.title, id: each.id, group: each.group, others }),
            );
            env.open(each.id);
        },
        share(id, version) {
            openSheet({ type: "artifact-share", id, version, back: "design" });
        },
    };

    Object.assign(env, {
        toggleFocus() {
            store.set((s) => ({ focus: !s.focus }));
        },
        previewDesign(id) {
            store.set({ artifact: id, version: null, slide: 0 });
        },
        openSystem() {
            store.set({
                view: "system",
                mode: "view",
                dock: null,
                draft: null,
                present: false,
                compare: null,
                sysPane: "system",
            });
            void systemData.load({ quiet: store.get().system.status === "ready" });
        },
        focusFinding(number) {
            store.set({ checkFocus: { number, at: Date.now() } });
        },
        openCheck() {
            store.set({ view: "canvas", mode: "view", dock: "check", draft: null });
        },
    });

    const { Workspace } = createWorkspace(env);

    let signature = "";
    let seen = null;
    let later = 0;
    const stopApp = app.subscribe((state) => {
        const list = state.view.artifacts;

        // The app tells this on every change while Pi writes: most leave the list as it was.
        if (!list || list === seen || state.conversationId !== store.get().conversation) {
            return;
        }

        seen = list;

        const next = list.map((each) => `${each.id}@${each.versions.at(-1)?.version}`).join();

        if (next !== signature) {
            signature = next;
            clearTimeout(later);
            later = setTimeout(() => void data.list(), 150);
        }
    });

    return {
        Workspace,
        data,
        systemData,
        stop() {
            clearTimeout(later);
            stopApp();
        },
    };
}
