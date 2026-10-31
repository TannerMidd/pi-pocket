// Extensions' browser modules. An extension module can give the app one (`web.client` on the server): it loads here, in
// the tabs of the people it is for, and its default export gets `pocket`, the app's API for extensions. With it, it adds
// rail buttons, menu rows, launcher actions, pages in the conversation's place, sheets, panels beside the conversation,
// items in the status line, and how its own tools' calls show, calls its own routes, and hears its module's events.
// What it added goes when it reloads or is turned off; one that fails says why, and the app goes on without it. A tab
// opened with `?noext=1` loads none of them (safe mode), for as long as the tab stays open.
import { Component, Fragment, h, options } from "preact";
import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useReducer,
    useRef,
    useState,
} from "preact/hooks";
import { useBack } from "./back.js";
import { parseKeys, setBoxKeys } from "./box-keys.js";
import { describersChanged, setCallDescriber } from "./calls.js";
import { jumpToEntry } from "./chat.js";
import { leaveSafeMode, onSafeModeEnd, safeMode } from "./safe-mode.js";
import {
    api,
    canSteer,
    closePeople,
    closeSheet,
    EXT_PANEL_KEY,
    insertIntoComposer,
    navigate,
    notify,
    onExtensionEvent,
    openSheet,
    panelsBeside,
    store,
} from "./store.js";
import { askPipFrom } from "./pip.js";
import { fromExtensions, SLOTS, slotsChanged } from "./slots.js";
import { setCallSummary } from "./turns.js";
import {
    html,
    Icon,
    iconPath,
    Loader,
    Markdown,
    PlaceTile,
    railState,
    Sheet,
    Spinner,
    Switch,
    writtenText,
} from "./ui.js";

/**
 * The version of `pocket`. It goes up only when something extensions use changes in a way that breaks them; additions
 * keep it. The server's `web.api` is the same number: 2 since 0.19.0 (`extension-web.ts`).
 */
export const POCKET_API = 2;
/** The oldest version that browser modules can still be written for: they load. */
const OLDEST_POCKET_API = 1;

/** What a browser module can add, each kept by its id. */
const KINDS = [
    "rail",
    "menu",
    "launcher",
    "page",
    "sheet",
    "panel",
    "status",
    "topbar",
    "composerButton",
    "replyAction",
    "sessionChips",
    "sessionAction",
    "sessionFilter",
    "sessionSearch",
    "composerKey",
];
/** What a rail button, menu row, launcher action, or status item can open: one of the module's own. */
const OPENS = ["page", "sheet", "panel"];
/** The event core sends a module's tabs when the owner changes its settings (`app.setExtensionSettings`). */
const SETTINGS_EVENT = "pocket:settings";
/** The most text `pocket.insertText` puts into the message box at once, and `pocket.pip.ask` gives PiP. */
const INSERT_MAX = 100_000;
/** The most of a message's text `pocket.messages` gives, and the most messages in a page. */
const MESSAGE_TEXT = 1000;
const MESSAGES_MAX = 200;
/** A status item's tones, as the line's own items show them. */
const TONES = new Set(["warn", "error", "muted"]);
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const isId = (value) => typeof value === "string" && ID.test(value);
const LEVELS = new Set(["info", "warning", "error"]);

/**
 * Each browser module this tab loads, by module name: its address and title, whether it is `loading`, `ready`, or
 * `failed` (and why), what it added, its cleanups, the events it listens to, and its `pocket`. One that failed stays,
 * for the Extensions sheet, but adds nothing more (`dead`).
 */
const modules = new Map();

/** The modules' names in the order the server lists them: what they add shows in that order. */
let order = [];

const liveRecord = (record) =>
    record !== undefined && !record.gone && !record.dead && modules.get(record.module) === record;

// ─── Drawing again, within bounds ────────────────────────────────────────────

/**
 * How often a module may make the app draw again. What it adds, changes, or removes draws at the next frame, once for
 * every change since: whatever it does, its changes cost the app no more than a redraw a frame, as an animation does.
 * What could hold the page is a loop that never lets a task through; and pages and sheets, which show at once. Past
 * these bounds, the module stops, as one that failed to load does:
 *
 * - Calls to `pocket`'s methods (all but `h`, `html`, the hooks, and the components) with no task between them (a loop
 *   of microtasks, which holds the page): more than 1000, over more than a second. Its calls then throw until the next
 *   task, so that such a loop ends.
 * - Pages and sheets opened or closed: more than 300 within any second; or, with no task between them, more than 1000,
 *   or 5 or more over more than a second.
 */
const HELD_CALLS = 1000;
const HELD_MS = 1000;
const OPENS_PER_SECOND = 300;
const HELD_OPENS = 1000;
const SLOW_OPENS = 5;
/** And how many notices a module may show, across its versions: past these, the rest are dropped. */
const NOTICES = 5;
const NOTICES_MS = 5000;
/** When a hidden tab draws no frames: its redraws wait this long at most (and longer, as such tabs' timers do). */
const FRAME_FALLBACK_MS = 100;

/**
 * The page's tasks, counted by a message that gets through only between them: a loop that holds the page lets none
 * through. A message rather than a timer: a hidden tab's timers wait up to a minute.
 */
let turn = 0;
let posted = false;
const tasks = new MessageChannel();

tasks.port1.onmessage = () => {
    posted = false;
    turn++;
};

function nextTurn() {
    if (!posted) {
        posted = true;
        tasks.port2.postMessage(null);
    }
}

/**
 * What a module spent lately: its calls in this task and since when (`tick`), and the pages and sheets it opened or
 * closed, within the last second and in this task (`chargeOpen`).
 */
const spending = () => ({
    calls: 0,
    callsTurn: -1,
    callsSince: 0,
    held: -1,
    opens: [],
    turn: -1,
    inTurn: 0,
    turnSince: 0,
});

/**
 * Count a call a module makes to `pocket`. Past the bound with no task between them (a loop of microtasks holds the
 * page), the module stops, and its calls throw until the next task, so that the loop making them ends. Any version
 * counts, even one that went: its calls do nothing, but its loop would hold the page all the same.
 */
function tick(record) {
    const spent = record.spent;
    const now = performance.now();
    const stopped = () =>
        new Error(`${record.title} was stopped in this browser: it redraws without end`);

    if (spent.held === turn) {
        throw stopped();
    }

    if (spent.callsTurn !== turn) {
        spent.callsTurn = turn;
        spent.calls = 0;
        spent.callsSince = now;
        nextTurn();
    }

    spent.calls++;

    if (spent.calls > HELD_CALLS && now - spent.callsSince > HELD_MS) {
        spent.held = turn;

        if (liveRecord(record)) {
            fail(record, new Error("it redraws without end"), "was stopped");
        }

        throw stopped();
    }
}

/** Count a page or sheet a module opened or closed; false, once that stopped the module for going past its bounds. */
function chargeOpen(record) {
    const now = performance.now();
    const spent = record.spent;

    spent.opens.push(now);

    while (now - spent.opens[0] >= 1000) {
        spent.opens.shift();
    }

    if (spent.turn !== turn) {
        spent.turn = turn;
        spent.inTurn = 0;
        spent.turnSince = now;
    }

    spent.inTurn++;
    nextTurn();

    if (
        spent.opens.length > OPENS_PER_SECOND ||
        spent.inTurn > HELD_OPENS ||
        (spent.inTurn >= SLOW_OPENS && now - spent.turnSince > HELD_MS)
    ) {
        fail(record, new Error("it redraws without end"), "was stopped");

        return false;
    }

    return true;
}

/** Whether a redraw is due at the next frame, for every change made until then. */
let due = false;

/**
 * Draw what extensions add again at the next frame: every change until then goes in the same redraw. The slots' orders
 * (`slots.js`) are worked out again at once, for a draw that comes before then.
 */
function redraw() {
    slotsChanged();

    if (due) {
        return;
    }

    due = true;

    // A hidden tab draws no frames: a timer then, whichever comes first.
    const frame = requestAnimationFrame(() => {
        clearTimeout(timer);
        flush();
    });
    const timer = setTimeout(() => {
        cancelAnimationFrame(frame);
        flush();
    }, FRAME_FALLBACK_MS);
}

function flush() {
    if (!due) {
        return;
    }

    due = false;
    store.set((state) => ({ extensionsRev: state.extensionsRev + 1 }));
}

/** Each module's recent notices, by name, so that a new version does not start afresh: `{ times, droppedAt }`. */
const noticeBudgets = new Map();

/**
 * A notice from a module, as many as its bound lets through; the rest are dropped, with a word in the console. None from
 * a version that went or failed (an action of it that fails late): it would use up the next version's.
 */
function noticeFrom(record, level, message, action) {
    if (!liveRecord(record)) {
        return;
    }

    const now = performance.now();
    const budget = noticeBudgets.get(record.module) ?? { times: [], droppedAt: -Infinity };

    budget.times = budget.times.filter((at) => now - at < NOTICES_MS);
    noticeBudgets.set(record.module, budget);

    if (budget.times.length >= NOTICES) {
        // Once a burst: a drop soon after another is the same one.
        if (now - budget.droppedAt >= NOTICES_MS) {
            console.warn(`${record.title}: too many notices; dropping the rest for a few seconds`);
        }

        budget.droppedAt = now;

        return;
    }

    budget.times.push(now);
    notify(level, message, action);
}

/** What was thrown, as text for a notice or an error box: an Error's message, a string, or a word that it gave none. */
function reason(error) {
    let text = "";

    try {
        if (error instanceof Error) {
            text = error.message || error.name;
        } else if (typeof error?.message === "string") {
            text = error.message;
        } else if (error !== undefined && error !== null) {
            text = String(error);
        }
    } catch {
        text = "";
    }

    return text.trim() === "" ? "it gave no reason" : text;
}

/** Run a cleanup; one that fails says so in the console, and the rest still run. */
function cleanUp(record, dispose) {
    try {
        dispose();
    } catch (error) {
        console.error(`${record.title}: a cleanup failed`, error);
    }
}

// ─── Safe mode ───────────────────────────────────────────────────────────────

/** Safe mode was told once in this page: a reconnect does not tell it again. */
let safeTold = false;

export { leaveSafeMode, safeMode };

// Leaving safe mode loads the browser modules again.
onSafeModeEnd(() => follow(store.state));

// ─── Loading ─────────────────────────────────────────────────────────────────

/** The list the tab loaded last, as a key: the server sends hello again for many reasons. */
let loadedKey = null;

/** Load what the server lists now, when it changed. */
function follow(state) {
    const listed = state.me ? state.server?.ui : [];
    const list = Array.isArray(listed) ? listed : [];
    // Signed in or not counts too: safe mode says so once someone is.
    const key = [
        safeMode() ? "safe" : "",
        state.me ? "in" : "",
        ...list.map(
            (each) =>
                `${each.module}@${each.url}@${Array.isArray(each.tools) ? each.tools.join(",") : ""}`,
        ),
    ].join("\n");

    if (key === loadedKey) {
        return;
    }

    loadedKey = key;
    // Not inside the store's own round of listeners: loading changes the store too. Only a list the server sent says
    // which modules went: before it comes, a panel kept from before a reload waits for its module.
    const known = Boolean(state.me) && Array.isArray(listed);

    queueMicrotask(() => sync(list, known));
}

store.subscribe(follow);

/** Who hears which modules went: `sheets.js`, which takes their sheets out of the ones back goes through. */
const goneListeners = new Set();

/** Hear when modules go: `listener(gone)`, where `gone(module)` says whether that module went. */
export function onExtensionsGone(listener) {
    goneListeners.add(listener);

    return () => goneListeners.delete(listener);
}

/** Load what the server lists, and unload what it no longer does or lists at a new address (a new version). */
function sync(list, known = true) {
    order = list.map((each) => each.module);
    const wanted = new Map(safeMode() ? [] : list.map((each) => [each.module, each]));

    for (const record of [...modules.values()]) {
        const entry = wanted.get(record.module);
        const tools = Array.isArray(entry?.tools) ? entry.tools : null;
        // A module reloaded on the server may install other tools, with the same browser module.
        const retooled = tools !== null && String(tools) !== String(record.tools);

        // One that failed (describing a tool its server module did not have yet, say) gets another go.
        if (entry?.url !== record.url || (retooled && record.dead)) {
            unload(record);
        } else if (retooled) {
            record.tools = tools;
            describersChanged();
        }
    }

    for (const entry of wanted.values()) {
        if (!modules.has(entry.module)) {
            void load(entry);
        }
    }

    // A page or sheet of a module that went closes, and back does not bring back the sheets it had under the one open.
    // One of a module coming back in a new version waits for it.
    const { page, sheet } = store.state;
    const gone = (module) => !wanted.has(module);

    if (page && gone(page.module)) {
        closePage();
    }

    if (sheet?.type === "ext" && gone(sheet.module)) {
        closeSheet();
    }

    if (known && store.state.extPanel && gone(store.state.extPanel.module)) {
        closeExtPanel();
    }

    for (const listener of goneListeners) {
        listener(gone);
    }

    // A module the server no longer lists has no notices to count.
    for (const module of noticeBudgets.keys()) {
        if (!order.includes(module)) {
            noticeBudgets.delete(module);
        }
    }

    if (safeMode() && !safeTold && store.state.me) {
        safeTold = true;
        notify(
            "warning",
            "Extensions' browser parts are off in this tab, and so is the theme. Menu → Extensions turns them back on.",
            () => openSheet({ type: "extensions", tab: "installed", show: "built-in" }),
        );
    }

    redraw();
}

async function load(entry) {
    const record = {
        module: entry.module,
        title: entry.title,
        url: entry.url,
        status: "loading",
        error: null,
        adds: Object.fromEntries(KINDS.map((kind) => [kind, new Map()])),
        // What it arranged in each slot (`pocket.arrange`), by slot.
        arrangements: new Map(),
        // How its own tools' calls show (`pocket.toolCall`), by tool.
        calls: new Map(),
        // The tools its module installs, whose calls it may describe; none known from a server before that list.
        tools: Array.isArray(entry.tools) ? entry.tools : null,
        disposers: [],
        listeners: new Set(),
        // Replaced or turned off.
        gone: false,
        // Failed, or stopped: what it set up went, and what it tries later (a timer) does nothing.
        dead: false,
        // How it failed, for its page and sheets: "failed to load", or "was stopped".
        how: null,
        // Its calls in this task, and the pages and sheets it opened and closed lately (`tick`, `chargeOpen`).
        spent: spending(),
    };

    record.pocket = pocketFor(record);
    modules.set(entry.module, record);
    redraw();

    try {
        const loaded = await import(entry.url);

        if (record.gone) {
            return;
        }

        const needs = loaded.pocketApi;

        if (
            needs !== undefined &&
            !(
                typeof needs === "number" &&
                Number.isInteger(needs) &&
                needs >= OLDEST_POCKET_API &&
                needs <= POCKET_API
            )
        ) {
            throw new Error(
                typeof needs === "number" && needs < OLDEST_POCKET_API
                    ? `it was written for version ${needs} of the app's extension API, and this app loads ${OLDEST_POCKET_API} to ${POCKET_API}`
                    : `it needs version ${needs} of the app's extension API, and this app has ${POCKET_API}`,
            );
        }

        if (typeof loaded.default !== "function") {
            throw new Error("it has no default export function");
        }

        const dispose = await loaded.default(record.pocket);

        if (typeof dispose === "function") {
            record.disposers.push(dispose);
        }

        // Replaced or turned off while it started, or stopped already: what it set up goes.
        if (record.gone || record.dead) {
            teardown(record);

            return;
        }

        record.status = "ready";
    } catch (error) {
        if (!record.gone && !record.dead) {
            fail(record, error, "failed to load");
        }

        return;
    }

    redraw();
}

/**
 * A module failed, while it loaded or later (`how`): what it added goes, its cleanups run, what it tries next does
 * nothing, and a notice, its page or sheet, and the Extensions sheet say why.
 */
function fail(record, error, how) {
    record.dead = true;
    teardown(record);
    record.status = "failed";
    record.error = reason(error);
    record.how = how;
    console.error(`${record.title}'s browser module ${how}`, error);
    notify("error", `${record.title} ${how} in this browser: ${record.error}`);
    redraw();
}

function unload(record) {
    record.gone = true;
    modules.delete(record.module);
    teardown(record);
}

/** Take away what a browser module added, and run its cleanups, last first. */
function teardown(record) {
    for (const kind of KINDS) {
        record.adds[kind].clear();
    }

    record.arrangements.clear();
    slotsChanged();

    if (record.calls.size > 0) {
        record.calls.clear();
        describersChanged();
    }

    record.listeners.clear();

    for (const dispose of record.disposers.splice(0).reverse()) {
        cleanUp(record, dispose);
    }
}

// Events from the server: to the listeners of the module that sent them.
onExtensionEvent(({ module, event, data }) => {
    const record = modules.get(module);

    for (const listener of [...(record?.listeners ?? [])]) {
        if (listener.event !== event) {
            continue;
        }

        try {
            listener.run(data);
        } catch (error) {
            console.error(`${record.title}: a listener for ${event} failed`, error);
        }
    }
});

// ─── pocket: the app's API for a browser module ──────────────────────────────

/** A copy of what a module gives to add, once it holds: read once, so what is checked is what is kept. */
function specOf(kind, spec) {
    if (typeof spec !== "object" || spec === null) {
        throw new Error(`pocket.${kind}: give it an object`);
    }

    const copy = { ...spec };

    check(kind, copy);

    return copy;
}

/** What each kind needs besides its `id`, and the one thing it does when used, if it is used. */
function check(kind, spec) {
    const name = `pocket.${kind}`;

    if (!isId(spec.id)) {
        throw new Error(`${name}: an id is up to 64 letters, digits, and . _ : -`);
    }

    // Chips on session rows and words for the session search are only a function the session list calls.
    const reads = { sessionChips: "chips", sessionSearch: "words" }[kind];

    if (reads !== undefined) {
        if (typeof spec[reads] !== "function") {
            throw new Error(`${name} ${spec.id}: give it a ${reads} function`);
        }

        return;
    }

    const text = (field) => {
        if (typeof spec[field] !== "string" || spec[field].trim() === "") {
            throw new Error(`${name} ${spec.id}: give it a ${field}`);
        }
    };

    // A key in the message boxes: only a run, which gets the box.
    if (kind === "composerKey") {
        text("label");

        if (parseKeys(spec.keys) === null) {
            throw new Error(
                `${name} ${spec.id}: keys is a key such as "Ctrl+W" or "Alt+Backspace", or a list of up to 8`,
            );
        }

        if (typeof spec.run !== "function") {
            throw new Error(`${name} ${spec.id}: give it a run function, which gets the box`);
        }

        return;
    }

    if (
        ["rail", "page", "sheet", "panel", "topbar", "composerButton", "sessionFilter"].includes(
            kind,
        )
    ) {
        text("title");
    } else if (kind === "status") {
        text("text");
    } else {
        text("label");
    }

    // What the app's own screens draw must be what they expect: a wrong type would fail where no boundary catches it.
    for (const field of [
        "hint",
        "detail",
        "icon",
        "iconPath",
        "short",
        "before",
        "after",
        ...(kind === "status" ? ["title", "label"] : []),
    ]) {
        if (spec[field] !== undefined && typeof spec[field] !== "string") {
            throw new Error(`${name} ${spec.id}: ${field} is text`);
        }
    }

    if (
        spec.badge !== undefined &&
        spec.badge !== null &&
        spec.badge !== false &&
        typeof spec.badge !== "string" &&
        typeof spec.badge !== "number"
    ) {
        throw new Error(`${name} ${spec.id}: a badge is a number or short text`);
    }

    if (
        spec.keywords !== undefined &&
        !(Array.isArray(spec.keywords) && spec.keywords.every((each) => typeof each === "string"))
    ) {
        throw new Error(`${name} ${spec.id}: keywords are a list of words`);
    }

    if (kind === "menu" && spec.group !== undefined && !["app", "session"].includes(spec.group)) {
        throw new Error(`${name} ${spec.id}: group is "app" or "session"`);
    }

    if (spec.before !== undefined && spec.after !== undefined) {
        throw new Error(`${name} ${spec.id}: give before or after, not both`);
    }

    if (spec.tone !== undefined && !TONES.has(spec.tone)) {
        throw new Error(`${name} ${spec.id}: tone is "warn", "error", or "muted"`);
    }

    // A page can keep Esc and sideways swipes for itself; a sheet and a panel can be wide.
    const flags = { page: ["escape", "swipe"], sheet: ["wide"], panel: ["wide"] }[kind] ?? [];

    for (const field of flags) {
        if (spec[field] !== undefined && typeof spec[field] !== "boolean") {
            throw new Error(`${name} ${spec.id}: ${field} is true or false`);
        }
    }

    if (kind === "page" || kind === "sheet" || kind === "panel") {
        if (typeof spec.component !== "function") {
            throw new Error(`${name} ${spec.id}: give it a component to show`);
        }

        return;
    }

    const does = [...OPENS, "run"].filter((field) => spec[field] !== undefined);

    // A status item may only show; the others do one thing.
    if (
        does.length > 1 ||
        (does.length === 0 && kind !== "status") ||
        (spec.run !== undefined && typeof spec.run !== "function")
    ) {
        throw new Error(
            `${name} ${spec.id}: say what it does: page, sheet, panel, or a run function`,
        );
    }

    // An action under an answer gets the answer: its run as an argument, its sheet as `reply`.
    if (kind === "replyAction" && spec.run === undefined && spec.sheet === undefined) {
        throw new Error(`${name} ${spec.id}: it does run or sheet, which get the answer`);
    }

    // An action on sessions gets their ids: its run as an argument, its sheet as `sessions`.
    if (kind === "sessionAction" && spec.run === undefined && spec.sheet === undefined) {
        throw new Error(`${name} ${spec.id}: it does run or sheet, which get the sessions`);
    }

    if (
        kind === "sessionAction" &&
        spec.access !== undefined &&
        !["steer", "view"].includes(spec.access)
    ) {
        throw new Error(`${name} ${spec.id}: access is "steer" or "view"`);
    }

    if (
        kind === "sessionFilter" &&
        spec.started !== undefined &&
        typeof spec.started !== "function"
    ) {
        throw new Error(`${name} ${spec.id}: started is a function`);
    }

    if (
        kind === "sessionFilter" &&
        spec.match !== undefined &&
        spec.match !== null &&
        typeof spec.match !== "function"
    ) {
        throw new Error(`${name} ${spec.id}: match is a function, or null while the filter is off`);
    }

    for (const field of OPENS) {
        if (spec[field] !== undefined && !isId(spec[field])) {
            throw new Error(`${name} ${spec.id}: ${field} is the id of one of its ${field}s`);
        }
    }
}

/** Two specs that would show the same: the same fields, each the very same value. */
function sameSpec(a, b) {
    if (a === undefined || b === undefined) {
        return false;
    }

    const keys = Object.keys(a);

    return (
        keys.length === Object.keys(b).length &&
        keys.every((key) => Object.hasOwn(b, key) && Object.is(a[key], b[key]))
    );
}

/**
 * A route's path under the module's own address (`/api/x/<module>/`): no `.` or `..` parts, no address of its own (a
 * leading `//`, or a scheme such as `https:`), so a call never reaches anything else.
 */
function routeOf(module, path) {
    const given = String(path);
    const refuse = (why) => new Error(`pocket.api: ${JSON.stringify(given)} ${why}`);

    if (/^[\\/]{2}/.test(given) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(given)) {
        throw refuse('is not one of its routes: give a path such as "status"');
    }

    const relative = given.replace(/^[\\/]/, "");
    const parts = relative.split(/[?#]/, 1)[0].split(/[\\/]/);

    if (parts.some((part) => /^(\.|%2e){1,2}$/i.test(part))) {
        throw refuse("has a . or .. part: give the route's own path");
    }

    const prefix = `/api/x/${module}/`;
    const url = new URL(`${prefix}${relative}`, location.origin);

    if (url.origin !== location.origin || !url.pathname.startsWith(prefix)) {
        throw refuse("leads out of the module's routes");
    }

    return `x/${module}/${relative}`;
}

function pocketFor(record) {
    const live = () => liveRecord(record);

    // A page or sheet opened or closed shows at once: it counts toward bounds of its own.
    const change = () => live() && chargeOpen(record);

    /** Add something, or replace what has its id; what comes back changes or removes it. */
    const add = (kind, spec) => {
        tick(record);

        let current = specOf(kind, spec);
        // A panel's top bar button has the panel's id: a top bar button of the same id would be a second item of it.
        const sharing = { panel: "topbar", topbar: "panel" }[kind];

        if (sharing !== undefined && record.adds[sharing].has(current.id)) {
            throw new Error(
                `pocket.${kind} ${current.id}: a panel and a top bar button share their ids in the top bar: give another`,
            );
        }

        if (live()) {
            const before = record.adds[kind].get(current.id);

            // The same again (a component that adds as it draws) keeps what is there and draws nothing again: a new
            // object would get a new revision (`revisionOf`), and the actions under answers would draw again.
            // The 2 handles then share 1 item: either one's update or remove changes it.
            if (sameSpec(before, current)) {
                current = before;
            } else {
                record.adds[kind].set(current.id, current);
                redraw();
            }
        }

        return Object.freeze({
            update(patch) {
                tick(record);

                if (typeof patch !== "object" || patch === null) {
                    throw new Error(`pocket.${kind} ${current.id}: update takes an object`);
                }

                if (!live() || record.adds[kind].get(current.id) !== current) {
                    return;
                }

                const next = { ...current, ...patch, id: current.id };

                // Nothing changed (an update on every draw): nothing draws again.
                if (sameSpec(current, next)) {
                    return;
                }

                check(kind, next);
                current = next;
                record.adds[kind].set(current.id, current);
                redraw();
            },
            remove() {
                tick(record);

                if (live() && record.adds[kind].get(current.id) === current) {
                    record.adds[kind].delete(current.id);
                    redraw();
                }
            },
        });
    };

    /** Its own folder's address, `/x/<module>/<version>/`, where its stylesheets are. */
    const folder = () => new URL(".", new URL(record.url, location.href));

    return Object.freeze({
        version: POCKET_API,
        get pocketVersion() {
            return store.state.server?.pocketVersion;
        },
        module: record.module,
        title: record.title,
        // Drawing: the app's own Preact and htm, so components and hooks work with its renderer.
        h,
        html,
        Fragment,
        useState,
        useEffect,
        useLayoutEffect,
        useRef,
        useMemo,
        useCallback,
        useReducer,
        // The app's pieces, so an extension looks like the rest of the app.
        Icon,
        Spinner,
        Loader,
        Markdown,
        Switch,
        /** Who uses this tab. */
        me: () => {
            tick(record);

            const me = store.state.me;

            return me ? { id: me.id, name: me.name, role: me.role } : null;
        },
        /** The session open in this tab, or null. */
        conversationId: () => {
            tick(record);

            return store.state.conversationId;
        },
        /**
         * Hear which session the tab shows: `listener` gets its id (or null) now, and again each time it changes. Returns
         * how to stop; it stops with this version of the module too.
         */
        onConversation(listener) {
            tick(record);

            if (typeof listener !== "function") {
                throw new Error("pocket.onConversation: give it a function");
            }

            if (!live()) {
                return () => {};
            }

            let shown = store.state.conversationId;

            const hear = (id) => {
                try {
                    listener(id);
                } catch (error) {
                    console.error(`${record.title}: an onConversation listener failed`, error);
                }
            };

            const stop = store.subscribe((state) => {
                if (state.conversationId !== shown && liveRecord(record)) {
                    shown = state.conversationId;
                    hear(shown);
                }
            });

            record.disposers.push(stop);
            hear(shown);

            return stop;
        },
        /**
         * A page of the people's messages in the session the tab shows, oldest first: the newest `limit` (50 by default,
         * up to 200), or those before the cursor `before` that a page gave. Its `before` is null at the start. Rejects
         * with `status` 409 when the cursor is stale (the context changed), and with an AbortError when `signal` aborts.
         */
        async messages(options = {}) {
            tick(record);

            const { before = null, limit = 50, signal } = options ?? {};

            if (before !== null && !(typeof before === "string" && /^[1-9]\d*$/.test(before))) {
                throw new Error("pocket.messages: before is a cursor that a page gave, or null");
            }

            if (!Number.isInteger(limit) || limit < 1 || limit > MESSAGES_MAX) {
                throw new Error(
                    `pocket.messages: limit is a whole number from 1 to ${MESSAGES_MAX}`,
                );
            }

            const conversationId = store.state.conversationId;

            if (!live() || conversationId === null) {
                return Object.freeze({ conversationId, messages: [], before: null });
            }

            const query = new URLSearchParams({ limit: String(limit) });

            if (before !== null) {
                query.set("before", before);
            }

            const page = await api(`c/${conversationId}/messages?${query}`, undefined, { signal });
            const { view, users, me } = store.state;
            // Who wrote each: known only while the tab still shows that session.
            const authors = view.conversation?.id === conversationId ? view.authors : undefined;

            return Object.freeze({
                conversationId,
                before: page.before === null ? null : String(page.before),
                messages: page.messages.map((entry) => {
                    const text = writtenText(entry);
                    const userId = authors?.[entry.id];
                    const person = users.find((user) => user.id === userId);

                    return Object.freeze({
                        id: String(entry.id),
                        text: text.slice(0, MESSAGE_TEXT),
                        clipped: text.length > MESSAGE_TEXT,
                        by: Object.freeze({
                            id: userId ?? null,
                            name:
                                person?.name ??
                                entry.from ??
                                (userId === me?.id ? me?.name : null) ??
                                null,
                        }),
                        at: entry.at ?? null,
                    });
                }),
            });
        },
        /**
         * Scroll the transcript of the session the tab shows to a message, loading earlier entries first when needed,
         * and highlight it. Resolves true once it shows; false when it is not in this session's transcript, the session
         * changed, or a newer reveal came first. A sheet that shows closes.
         */
        reveal(id) {
            tick(record);

            const entryId = typeof id === "string" && /^[1-9]\d*$/.test(id) ? Number(id) : id;

            if (typeof entryId !== "number" || !Number.isSafeInteger(entryId) || entryId <= 0) {
                throw new Error("pocket.reveal: give it the id of a message");
            }

            if (!live() || store.state.conversationId === null) {
                return Promise.resolve(false);
            }

            return jumpToEntry(entryId, { quiet: true });
        },
        /** Open through the app's normal navigation; the server checks access on connection. */
        openConversation: (id) => {
            tick(record);

            const value = typeof id === "string" && /^[1-9]\d*$/.test(id) ? Number(id) : id;

            if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
                throw new Error("pocket.openConversation: give a positive conversation id");
            }

            navigate(value);
        },
        /**
         * Call one of the module's routes: `api("status")` gets, `api("items", { name })` posts, and
         * `api("items/3", undefined, { method: "DELETE" })` deletes. Rejects with an error with the server's words, or
         * for a path that would lead out of the module's routes.
         */
        api: (path, body, options) => {
            // Counted at once, so that a loop of calls that holds the page is stopped; once it is, the call throws, as
            // the others do, so that a loop that only calls this ends too.
            tick(record);

            return (async () => api(routeOf(record.module, path), body, options))();
        },
        /**
         * The module's settings (`web.settings` on the server) as the person in this tab may read them: `{ fields,
         * values, set }`, with a secret's value left out (only whether it is `set`).
         */
        settings: () => {
            tick(record);

            return (async () => api(`extension-settings/${encodeURIComponent(record.module)}`))();
        },
        /** Hear when the owner changes the module's settings; returns how to stop. */
        onSettings(run) {
            tick(record);

            if (typeof run !== "function") {
                throw new Error("pocket.onSettings: give it a function");
            }

            const listener = { event: SETTINGS_EVENT, run: () => run() };

            if (live()) {
                record.listeners.add(listener);
            }

            return () => record.listeners.delete(listener);
        },
        /** Hear an event the module sends (`web.send` on the server); returns how to stop. */
        on(event, run) {
            tick(record);

            if (typeof event !== "string" || typeof run !== "function") {
                throw new Error("pocket.on: give it an event name and a function");
            }

            const listener = { event, run };

            if (live()) {
                record.listeners.add(listener);
            }

            return () => record.listeners.delete(listener);
        },
        /** A short notice, as the app's own: `info`, `warning`, or `error`. A few at a time (`NOTICES`). */
        notify(level, message) {
            tick(record);

            if (live()) {
                noticeFrom(record, LEVELS.has(level) ? level : "info", String(message));
            }
        },
        rail: (spec) => add("rail", spec),
        menu: (spec) => add("menu", spec),
        launcher: (spec) => add("launcher", spec),
        page: (spec) => add("page", spec),
        sheet: (spec) => add("sheet", spec),
        panel: (spec) => add("panel", spec),
        status: (spec) => add("status", spec),
        topbar: (spec) => add("topbar", spec),
        composerButton: (spec) => add("composerButton", spec),
        replyAction: (spec) => add("replyAction", spec),
        sessionChips: (spec) => add("sessionChips", spec),
        sessionAction: (spec) => add("sessionAction", spec),
        sessionFilter: (spec) => add("sessionFilter", spec),
        sessionSearch: (spec) => add("sessionSearch", spec),
        composerKey: (spec) => add("composerKey", spec),
        /** Put text into the message box, after what is there, for the person to send: never sent by itself. */
        insertText(text, options) {
            tick(record);

            if (typeof text !== "string" || text.length > INSERT_MAX) {
                throw new Error(`pocket.insertText: give it text, up to ${INSERT_MAX} characters`);
            }

            if (live() && store.state.conversationId !== null) {
                insertIntoComposer(text, [], { inline: options?.inline === true });
            }
        },
        pip: Object.freeze({
            /** Give PiP text as the person's message: in its box to review, or sent after a tap (`askPipFrom`). */
            ask(text, options) {
                tick(record);

                if (typeof text !== "string" || text.trim() === "" || text.length > INSERT_MAX) {
                    throw new Error(`pocket.pip.ask: give it text, up to ${INSERT_MAX} characters`);
                }

                if (!live()) {
                    return Promise.resolve({
                        ok: false,
                        reason: "This version of the module is not loaded",
                    });
                }

                return askPipFrom(`the extension “${record.title}”`, text, options?.send === true);
            },
        }),
        /**
         * Hide or reorder a slot's items, the app's own too, for the people who load this module: what a person chooses
         * in Appearance → Layout wins. Again for the same slot replaces it; `remove` takes it back.
         */
        arrange(slot, arrangement) {
            tick(record);

            const current = arrangementOf(slot, arrangement);

            if (live()) {
                record.arrangements.set(slot, current);
                redraw();
            }

            return Object.freeze({
                remove() {
                    tick(record);

                    if (live() && record.arrangements.get(slot) === current) {
                        record.arrangements.delete(slot);
                        redraw();
                    }
                },
            });
        },
        /** How calls of one of its tools show: in a line in transcripts and peek tiles, and in a group's summary. */
        toolCall(spec) {
            tick(record);

            const current = toolCallOf(record, spec);

            if (current === null) {
                return Object.freeze({ remove() {} });
            }

            if (live()) {
                record.calls.set(current.tool, current);
                describersChanged();
                redraw();
            }

            return Object.freeze({
                remove() {
                    tick(record);

                    if (live() && record.calls.get(current.tool) === current) {
                        record.calls.delete(current.tool);
                        describersChanged();
                        redraw();
                    }
                },
            });
        },
        // Its own page and sheet only, and only while this version is loaded: a timer that outlived it opens or closes
        // nothing, not even the page of the version after it.
        openPage(id) {
            tick(record);

            if (!isId(id)) {
                throw new Error("pocket.openPage: give it the id of one of its pages");
            }

            if (change()) {
                openPage(record.module, id);
            }
        },
        closePage() {
            tick(record);

            if (live() && store.state.page?.module === record.module && change()) {
                closePage();
            }
        },
        openPanel(id) {
            tick(record);

            if (!isId(id)) {
                throw new Error("pocket.openPanel: give it the id of one of its panels");
            }

            if (change()) {
                openExtPanel(record.module, id);
            }
        },
        closePanel() {
            tick(record);

            if (live() && store.state.extPanel?.module === record.module && change()) {
                closeExtPanel();
            }
        },
        openSheet(id, props) {
            tick(record);

            if (!isId(id)) {
                throw new Error("pocket.openSheet: give it the id of one of its sheets");
            }

            if (props !== undefined && (typeof props !== "object" || props === null)) {
                throw new Error("pocket.openSheet: its props are an object");
            }

            if (change()) {
                openExtensionSheet(record.module, id, props);
            }
        },
        closeSheet() {
            tick(record);

            const sheet = store.state.sheet;

            if (live() && sheet?.type === "ext" && sheet.module === record.module && change()) {
                closeSheet();
            }
        },
        /**
         * Load a stylesheet from the browser module's folder (`look.css`); it goes with this version. One that does
         * not load says so in a notice.
         */
        style(path) {
            tick(record);

            if (!live()) {
                return;
            }

            const base = folder();
            let href;

            try {
                href = new URL(String(path), base);
            } catch {
                href = null;
            }

            if (
                href === null ||
                href.origin !== base.origin ||
                !href.pathname.startsWith(base.pathname)
            ) {
                throw new Error(
                    `pocket.style: ${JSON.stringify(String(path))} is not in the module's own folder`,
                );
            }

            // In the app's own layer (index.html), after its rules: it wins and loses against them by specificity and
            // order, as a stylesheet of its own would, and the theme's layer stays above both. The address is the URL
            // parser's, so it holds no quote or backslash to end the string early.
            const sheet = document.createElement("style");

            sheet.textContent = `@import url("${href.href.replace(/["\\\n]/g, encodeURIComponent)}") layer(pocket);`;
            sheet.dataset.extension = record.module;
            sheet.addEventListener("error", () => {
                if (live() && sheet.isConnected) {
                    console.warn(`${record.title}: ${href.href} did not load`);
                    noticeFrom(
                        record,
                        "warning",
                        `${record.title}: its stylesheet ${String(path)} did not load`,
                    );
                }
            });
            document.head.append(sheet);
            record.disposers.push(() => sheet.remove());
        },
        /** Run `dispose` when this version goes: an edit, or the module turned off. Gone or failed already: now. */
        onDispose(dispose) {
            tick(record);

            if (typeof dispose !== "function") {
                throw new Error("pocket.onDispose: give it a function");
            }

            if (!live()) {
                cleanUp(record, dispose);

                return;
            }

            record.disposers.push(dispose);
        },
    });
}

// ─── Tool calls: how a module's own tools show ───────────────────────────────

/**
 * A copy of what `pocket.toolCall` was given, once it holds; null from a server that does not say which tools are the
 * module's, where calls keep the default display. A module describes only the tools its own module installs, by the
 * very names Pi runs them by, so it never changes how another's calls show (a command shown as something else).
 */
function toolCallOf(record, spec) {
    if (typeof spec !== "object" || spec === null) {
        throw new Error("pocket.toolCall: give it an object");
    }

    const copy = { ...spec };
    const name = `pocket.toolCall ${String(copy.tool)}`;

    if (typeof copy.tool !== "string") {
        throw new Error("pocket.toolCall: give it the name of one of its tools");
    }

    if (record.tools === null) {
        return null;
    }

    if (!record.tools.includes(copy.tool)) {
        throw new Error(`${name}: it is not one of this module's tools`);
    }

    if (typeof copy.label !== "function") {
        throw new Error(`${name}: give it a label function`);
    }

    for (const field of ["subject", "summary"]) {
        if (copy[field] !== undefined && typeof copy[field] !== "function") {
            throw new Error(`${name}: ${field} is a function`);
        }
    }

    for (const field of ["icon", "iconPath"]) {
        if (copy[field] !== undefined && typeof copy[field] !== "string") {
            throw new Error(`${name}: ${field} is text`);
        }
    }

    return copy;
}

/** The module that describes a tool's calls, first in the server's order, and what it gave. */
function describerOf(tool) {
    for (const module of order) {
        const record = modules.get(module);

        // Only a tool its module still installs: one a newer version took away is no longer its own.
        if (
            liveRecord(record) &&
            record.calls.has(tool) &&
            (record.tools === null || record.tools.includes(tool))
        ) {
            return { record, spec: record.calls.get(tool) };
        }
    }

    return undefined;
}

/** Describers that failed, said once each in the console: they are asked again at every draw. */
const toldFailures = new Set();

/**
 * What a describer gives for a call's arguments (a copy, so it cannot change them), as one line of text up to `max`
 * long; undefined when it throws or gives anything else.
 */
function described(record, tool, field, run, args, max) {
    let value;

    try {
        value = run(structuredClone(args));
    } catch (error) {
        const key = `${record.module}:${tool}:${field}`;

        if (!toldFailures.has(key)) {
            toldFailures.add(key);
            console.error(`${record.title}: describing a ${tool} call (${field}) failed`, error);
        }

        return undefined;
    }

    if (typeof value !== "string") {
        return undefined;
    }

    const line = value.replace(/\s+/g, " ").trim();

    return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

setCallDescriber((tool, args) => {
    const found = describerOf(tool);

    if (found === undefined) {
        return undefined;
    }

    const { record, spec } = found;
    const label = described(record, tool, "label", spec.label, args, 80);
    const subject =
        spec.subject === undefined
            ? ""
            : described(record, tool, "subject", spec.subject, args, 160);

    if (!label || subject === undefined) {
        return undefined;
    }

    return {
        label,
        subject,
        ...(spec.icon === undefined && spec.iconPath === undefined
            ? {}
            : { iconPath: pathOf(spec) }),
    };
});

setCallSummary((tool, args) => {
    const found = describerOf(tool);

    if (found?.spec.summary === undefined) {
        return undefined;
    }

    const { record, spec } = found;
    let kind;

    try {
        kind = spec.summary(structuredClone(args));
    } catch (error) {
        const key = `${record.module}:${tool}:summary`;

        if (!toldFailures.has(key)) {
            toldFailures.add(key);
            console.error(`${record.title}: summing up a ${tool} call failed`, error);
        }

        return undefined;
    }

    const word = (value) => typeof value === "string" && value.trim() !== "" && value.length <= 60;

    if (
        typeof kind !== "object" ||
        kind === null ||
        !word(kind.verb) ||
        (kind.noun !== undefined && !word(kind.noun)) ||
        (kind.by !== undefined && !word(kind.by))
    ) {
        return undefined;
    }

    return {
        verb: kind.verb.trim(),
        ...(kind.noun === undefined ? {} : { noun: kind.noun.trim() }),
        ...(kind.by === undefined ? {} : { by: kind.by }),
    };
});

// ─── Opening what extensions added ───────────────────────────────────────────

/**
 * Show a module's page in the conversation's place, where the subagents board shows. What is over that place (a sheet,
 * the launcher) closes, so that back closes first what shows on top.
 */
export function openPage(module, id) {
    if (!isId(id)) {
        return;
    }

    store.set({
        page: { module, id },
        sheet: null,
        launcher: false,
        board: false,
        boardAgents: null,
        drawer: false,
    });
}

export const closePage = () => store.set({ page: null });

/**
 * The `close` a page's component gets: it closes that page, of that version of its module, while it shows, and nothing
 * else (another page, the next version's) when called later.
 */
function pageCloser(record, id) {
    return () => {
        const { page } = store.state;

        if (liveRecord(record) && page?.module === record.module && page.id === id) {
            closePage();
        }
    };
}

/** The `close` a sheet's component gets: it closes that sheet of that version while it shows, and no other sheet. */
function sheetCloser(record, id) {
    return () => {
        const { sheet } = store.state;

        if (
            liveRecord(record) &&
            sheet?.type === "ext" &&
            sheet.module === record.module &&
            sheet.sheetId === id
        ) {
            closeSheet();
        }
    };
}

/**
 * Show a module's panel beside the conversation, in the place the Browser, Files, and People panels take (one of them at
 * a time); where the screen is narrow, it covers the conversation. A page or the board in the conversation's place, and
 * what is over it, close, so the panel shows.
 */
export function openExtPanel(module, id) {
    if (!isId(id)) {
        return;
    }

    sessionStorage.setItem(EXT_PANEL_KEY, JSON.stringify({ module, id }));
    sessionStorage.removeItem("pocket.browser");
    sessionStorage.removeItem("pocket.files");
    closePeople();
    store.set({
        extPanel: { module, id },
        browserOpen: false,
        filesOpen: false,
        page: null,
        board: false,
        boardAgents: null,
        sheet: null,
        launcher: false,
        drawer: false,
    });
}

export function closeExtPanel() {
    sessionStorage.removeItem(EXT_PANEL_KEY);

    // Its active border goes to the conversation, not nowhere.
    if (document.documentElement.dataset.focus === "extension-panel") {
        document.documentElement.dataset.focus = "pane";
    }

    store.set({ extPanel: null });
}

/** The extension panel shows now: one asked for, in a conversation that is there. `App` draws it by this. */
export function extPanelShown(state = store.state) {
    return state.extPanel !== null && state.conversationId !== null && !state.missing;
}

/** The `close` a panel's component gets: it closes that panel of that version while it shows, and no other panel. */
function panelCloser(record, id) {
    return () => {
        const { extPanel } = store.state;

        if (liveRecord(record) && extPanel?.module === record.module && extPanel.id === id) {
            closeExtPanel();
        }
    };
}

/** Whether what a button opens shows now: its page or its panel. A second tap then closes it. */
function opened(record, spec) {
    const { page, extPanel } = store.state;

    if (spec.page !== undefined) {
        return page?.module === record.module && page.id === spec.page;
    }

    return (
        spec.panel !== undefined && extPanel?.module === record.module && extPanel.id === spec.panel
    );
}

/** Open a module's sheet. From the session list (`over`), over the drawer, which stays, as a held row's sheet does. */
function openExtensionSheet(module, id, props = {}, over = false) {
    const sheet = { type: "ext", module, sheetId: id, id: `${module}:${id}`, props };

    if (over) {
        store.set({ sheet });
    } else {
        openSheet(sheet);
    }
}

/**
 * Do what a rail button, menu row, or launcher action says: open its page or sheet, or run its function. A function that
 * fails, at once or later (an async one), says so in a notice.
 */
function activate(record, spec, input, over = false) {
    const failed = (error) => {
        console.error(`${record.title}: ${spec.id} failed`, error);
        noticeFrom(record, "error", `${record.title}: ${reason(error)}`);
    };

    try {
        if (spec.page !== undefined) {
            openPage(record.module, spec.page);
        } else if (spec.sheet !== undefined) {
            openExtensionSheet(record.module, spec.sheet, input, over);
        } else if (spec.panel !== undefined) {
            openExtPanel(record.module, spec.panel);
        } else if (spec.run !== undefined) {
            Promise.resolve(input === undefined ? spec.run() : spec.run(input)).catch(failed);
        }
    } catch (error) {
        failed(error);
    }
}

/** What every loaded module added of a kind: modules in the order the server lists them, each's in the order added. */
function added(kind) {
    const at = (record) => {
        const index = order.indexOf(record.module);

        return index === -1 ? order.length : index;
    };

    return [...modules.values()]
        .sort((a, b) => at(a) - at(b))
        .flatMap((record) => [...record.adds[kind].values()].map((spec) => ({ record, spec })));
}

// The keys modules give the message boxes (`box-keys.js`), each run as its module: a failure says so in a notice.
setBoxKeys(() =>
    added("composerKey")
        .filter(({ record }) => liveRecord(record))
        .map(({ record, spec }) => ({
            keys: parseKeys(spec.keys),
            keysText: spec.keys,
            label: spec.label,
            module: record.title,
            run: (box) => spec.run(box),
            failed: (error) => {
                console.error(`${record.title}: ${spec.id} failed`, error);
                noticeFrom(record, "error", `${record.title}: ${reason(error)}`);
            },
        })),
);

/** An extension's icon: its own path, one of the app's by name, or a square of four when it gave none it knows. */
const pathOf = (spec) => spec.iconPath ?? (iconPath(spec.icon ?? "") || iconPath("grid"));

/** The most of a badge's text kept (its button shows less, cut with an ellipsis), for its button's label. */
const BADGE_TEXT = 24;

/** What tells the characters a reader sees as one (an emoji with its joiners, a letter with its accent), made once. */
const segmenter =
    typeof Intl.Segmenter === "function"
        ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
        : null;
/** How much of a badge's text is looked at: all that can show, and far more. */
const BADGE_HEAD = 1000;

/** The first `count` characters of `text` as a reader sees them, looking at its start only. */
function firstCharacters(text, count) {
    const head = text.slice(0, BADGE_HEAD);
    const characters = [];

    for (const piece of segmenter === null ? head : segmenter.segment(head)) {
        characters.push(typeof piece === "string" ? piece : piece.segment);

        if (characters.length >= count) {
            break;
        }
    }

    return characters;
}

/** What each button's badge shows, worked out once for each version of the button: a draw that changes none reads it. */
const shownBadges = new WeakMap();

function badgeFor(spec) {
    let shown = shownBadges.get(spec);

    if (shown === undefined) {
        shown = badgeOf(spec.badge);
        shownBadges.set(spec, shown);
    }

    return shown;
}

/**
 * A rail button's badge as it shows: as the app's own counts, none at 0 and "99+" above 99 (Infinity too); NaN and
 * -Infinity show nothing, other numbers as they are; text, trimmed, with "" and "0" as nothing, and long text cut whole
 * characters at a time.
 */
function badgeOf(badge) {
    if (typeof badge === "number") {
        if (Number.isNaN(badge) || badge === 0 || badge === -Infinity) {
            return "";
        }

        return badge > 99 ? "99+" : String(badge);
    }

    // Trimmed first, so spaces before it never hide or cut it; only then is its start looked at, which bounds the cost
    // of a huge one without changing what shows of one that fits.
    const text = typeof badge === "string" ? badge.trim() : "";

    if (text === "" || text === "0") {
        return "";
    }

    const characters = firstCharacters(text, BADGE_TEXT + 1);

    return characters.length > BADGE_TEXT || text.length > BADGE_HEAD
        ? `${characters.slice(0, BADGE_TEXT - 1).join("")}…`
        : text;
}

/**
 * How this tab's copy of a module's browser module stands, for the Extensions sheet: `loading`, `ready`, `failed` (with
 * its `error`), or `off` in safe mode; undefined when this tab loads none.
 */
export function browserModuleState(module) {
    const record = modules.get(module);

    if (record === undefined) {
        return safeMode() && order.includes(module) ? { status: "off", error: null } : undefined;
    }

    return { status: record.status, error: record.error };
}

// ─── Where they show ─────────────────────────────────────────────────────────

/**
 * The rail's buttons that extensions added, after the app's own tools. They take the room they need: a rail with more
 * buttons than room scrolls as a whole, and fades the edge where more is (`useScrollMore`).
 */
export function ExtensionRailButtons() {
    const buttons = added("rail");

    if (buttons.length === 0) {
        return null;
    }

    return html`<div class="rail-exts">
        ${buttons.map(({ record, spec }) => {
            const open = opened(record, spec);
            const toggles = spec.page !== undefined || spec.panel !== undefined;
            const badge = badgeFor(spec);

            return html`<button
                key=${`${record.module}:${spec.id}`}
                class=${`rail-button rail-ext ${open ? "open" : ""}`}
                data-part="rail-button"
                data-state=${railState(open)}
                title=${spec.title}
                aria-label=${badge === "" ? spec.title : `${spec.title}, ${badge}`}
                aria-pressed=${toggles ? open : undefined}
                onClick=${() => (open ? closeOf(spec) : activate(record, spec))}
            >
                <${Icon} path=${pathOf(spec)} size=${18} />
                ${badge !== "" && html`<span class="rail-count">${badge}</span>`}
            </button>`;
        })}
    </div>`;
}

/** Close what a button opened: its page or its panel. */
const closeOf = (spec) => (spec.page !== undefined ? closePage() : closeExtPanel());

/** The menu's rows that extensions added: `{ key, label, hint, run }`, run closing the menu first. */
export function extensionMenuItems(group = "app") {
    return added("menu")
        .filter(({ spec }) => (spec.group ?? "app") === group)
        .map(({ record, spec }) => ({
            key: `${record.module}:${spec.id}`,
            label: spec.label,
            hint: spec.hint ?? "",
            run: () => {
                // A page or panel shows under the menu, which closes; a sheet takes the menu's place.
                if (spec.sheet === undefined) {
                    closeSheet();
                }

                activate(record, spec);
            },
        }));
}

/** The launcher's actions that extensions added, as launcher items. */
export function extensionLauncherItems() {
    return added("launcher").map(({ record, spec }) => ({
        key: `action:ext:${record.module}:${spec.id}`,
        label: spec.label,
        detail: spec.detail ?? record.title,
        iconPath: pathOf(spec),
        keywords: Array.isArray(spec.keywords) ? spec.keywords.join(" ") : "",
        run: () => activate(record, spec),
    }));
}

// ─── The session list ────────────────────────────────────────────────────────

/** The most chips one module puts on a row, the longest a chip's text shows, and the most search words per session. */
const CHIPS_MAX = 6;
const CHIP_TEXT = 32;
const WORDS_MAX = 32;
const WORD_TEXT = 100;
/** The most filter buttons the search field holds, and the longest an action's label shows. */
const FILTERS_MAX = 3;
const ACTION_TEXT = 24;

/** What extensions see of a session: a frozen copy, made once for each version of the session the server sent. */
const infos = new WeakMap();

function sessionInfo(session) {
    let info = infos.get(session);

    if (info === undefined) {
        info = Object.freeze({
            id: session.id,
            title: session.title ?? "New session",
            cwd: session.cwd,
            archived: Boolean(session.archived),
            updatedAt: session.updatedAt,
        });
        infos.set(session, info);
    }

    return info;
}

/**
 * Call a function a module gave the session list, as the list draws. One that throws stops its module, after this draw:
 * the list draws without it.
 */
function drawCall(record, run, session, fallback, name) {
    if (!liveRecord(record)) {
        return fallback;
    }

    try {
        const value = run(sessionInfo(session));

        if (value && typeof value.then === "function") {
            // These readers run during rendering. Consume a rejected promise too, before stopping the module.
            Promise.resolve(value).catch(() => {});

            throw new Error(`${name} must return its value directly, not a promise`);
        }

        return value;
    } catch (error) {
        queueMicrotask(() => liveRecord(record) && fail(record, error, "failed"));

        return fallback;
    }
}

/** Text cut to `max` characters as a reader sees them, with "…". */
function cutText(text, max) {
    const characters = firstCharacters(text.trim(), max + 1);

    return characters.length > max
        ? `${characters.slice(0, max - 1).join("")}…`
        : characters.join("");
}

/** The chips that extensions put on a session's row: `{ key, label, title, run }`, `run` only for one that does something. */
export function sessionChips(session) {
    return added("sessionChips").flatMap(({ record, spec }) => {
        const chips = drawCall(record, spec.chips, session, [], "sessionChips.chips");

        if (!Array.isArray(chips)) {
            return [];
        }

        return chips
            .filter((chip) => typeof chip?.label === "string" && chip.label.trim() !== "")
            .slice(0, CHIPS_MAX)
            .map((chip, index) => ({
                key: `${record.module}:${spec.id}:${index}`,
                label: cutText(chip.label, CHIP_TEXT),
                title: typeof chip.title === "string" ? chip.title : chip.label,
                run:
                    typeof chip.run === "function"
                        ? () => activate(record, { id: spec.id, run: chip.run })
                        : undefined,
            }));
    });
}

/** Words stay valid until the server replaces the session or an extension changes what it adds. */
const cachedWords = new WeakMap();

/** The words that extensions give a session for the session list's search and the launcher's, lowercased. */
export function sessionWords(session) {
    const revision = store.state.extensionsRev;
    const cached = cachedWords.get(session);

    if (cached?.revision === revision) {
        return cached.words;
    }

    const words = added("sessionSearch").flatMap(({ record, spec }) => {
        const words = drawCall(record, spec.words, session, [], "sessionSearch.words");

        return Array.isArray(words)
            ? words
                  .filter((word) => typeof word === "string" && word.trim() !== "")
                  .slice(0, WORDS_MAX)
                  .map((word) => word.trim().slice(0, WORD_TEXT).toLowerCase())
            : [];
    });

    cachedWords.set(session, { revision, words });

    return words;
}

/** The actions extensions offer on sessions: `run(ids)` does the action on those sessions. */
export function sessionActions() {
    const steer = canSteer();

    return added("sessionAction")
        .filter(({ spec }) => steer || spec.access === "view")
        .map(({ record, spec }) => ({
            key: itemId(record, spec),
            label: cutText(spec.label, ACTION_TEXT),
            title: spec.label,
            module: record.title,
            // One with an icon is also a button on rows, where a mouse hovers (`sessions.js`).
            iconPath: spec.icon !== undefined || spec.iconPath !== undefined ? pathOf(spec) : null,
            run: (ids) => {
                const sessions = Object.freeze([...ids]);

                activate(record, spec, spec.sheet === undefined ? sessions : { sessions }, true);
            },
        }));
}

/**
 * The filters extensions add beside the session search, the first few of them (the field keeps its room): a button
 * each, `on` while its `match` narrows the list.
 */
export function sessionFilters() {
    return added("sessionFilter")
        .slice(0, FILTERS_MAX)
        .map(({ record, spec }) => ({
            key: itemId(record, spec),
            title: spec.title,
            iconPath: pathOf(spec),
            badge: badgeFor(spec),
            on: typeof spec.match === "function",
            run: () => activate(record, spec, undefined, true),
        }));
}

/**
 * A person started a session with New in the session list: the filters that are on and have `started` get its id, so
 * that it meets them (Session tags gives it the chosen tags). One that fails says so in a notice.
 */
export function sessionStarted(id) {
    for (const { record, spec } of added("sessionFilter").slice(0, FILTERS_MAX)) {
        if (typeof spec.match === "function" && typeof spec.started === "function") {
            activate(record, { id: spec.id, run: spec.started }, id);
        }
    }
}

/** Whether every filter that is on keeps a session in the list; null while none is on. Only those with a button count. */
export function sessionFilterTest() {
    const on = added("sessionFilter")
        .slice(0, FILTERS_MAX)
        .filter(({ spec }) => typeof spec.match === "function");

    if (on.length === 0) {
        return null;
    }

    return (session) =>
        on.every(
            ({ record, spec }) =>
                drawCall(record, spec.match, session, true, "sessionFilter.match") === true,
        );
}

/** The longest a status item's text shows, in characters as a reader sees them: past it, cut with "…". */
const STATUS_TEXT = 40;
/** What each status item's text shows, worked out once for each version of it. */
const shownStatus = new WeakMap();

function statusText(spec) {
    let shown = shownStatus.get(spec);

    if (shown === undefined) {
        const cut = (text) => {
            const characters = firstCharacters(text.trim(), STATUS_TEXT + 1);

            return characters.length > STATUS_TEXT
                ? `${characters.slice(0, STATUS_TEXT - 1).join("")}…`
                : characters.join("");
        };

        shown = { text: cut(spec.text), short: spec.short === undefined ? "" : cut(spec.short) };
        shownStatus.set(spec, shown);
    }

    return shown;
}

/** A copy of what `pocket.arrange` was given, once it holds. */
function arrangementOf(slot, arrangement) {
    if (!Object.hasOwn(SLOTS, slot)) {
        throw new Error(
            `pocket.arrange: ${JSON.stringify(slot)} is not a slot: give one of ${Object.keys(SLOTS).join(", ")}`,
        );
    }

    if (typeof arrangement !== "object" || arrangement === null) {
        throw new Error("pocket.arrange: give it an object with hide or order");
    }

    const ids = (field) => {
        const value = arrangement[field];

        if (value === undefined) {
            return [];
        }

        if (!Array.isArray(value) || !value.every((each) => typeof each === "string")) {
            throw new Error(`pocket.arrange: ${field} is a list of item ids, such as "core:files"`);
        }

        return [...value];
    };

    return { hide: ids("hide"), order: ids("order") };
}

/** An extension's item's name in its slot. */
const itemId = (record, spec) => `ext:${record.module}:${spec.id}`;

/** A number for each version of a spec: an update makes a new one, so what draws only on a change draws it again. */
const revisions = new WeakMap();
let lastRevision = 0;

function revisionOf(spec) {
    if (!revisions.has(spec)) {
        revisions.set(spec, ++lastRevision);
    }

    return revisions.get(spec);
}

/**
 * The status line's items that extensions added. One that opens or runs something is a button. A narrow line shows
 * each one's `short` form, after it gives up "1 here" and before the guard's word (`SHORTER`, composer.js).
 */
function statusItems() {
    return added("status").map(({ record, spec }) => ({
        id: itemId(record, spec),
        label: spec.label ?? record.title,
        module: record.title,
        before: spec.before,
        after: spec.after,
        render: () => statusNode(record, spec),
        detail: () => spec.title ?? statusText(spec).text,
    }));
}

function statusNode(record, spec) {
    const { text, short } = statusText(spec);
    const acts = [...OPENS, "run"].some((field) => spec[field] !== undefined);
    const words =
        short === ""
            ? text
            : html`<span class="long">${text}</span><span class="short">${short}</span>`;
    const open = opened(record, spec);
    const toggles = spec.page !== undefined || spec.panel !== undefined;
    const toggle = () => (open ? closeOf(spec) : activate(record, spec));

    // One that acts is a button; a tap on it does not explain the line (composer.js).
    return html`<${acts ? "button" : "span"}
        type=${acts ? "button" : undefined}
        class=${`ext-status ${spec.tone ?? ""} ${open ? "on" : ""}`}
        data-part="status-item"
        data-module=${record.module}
        title=${spec.title}
        aria-pressed=${toggles ? open : undefined}
        onClick=${acts ? toggle : undefined}
    >
        ${words}
    <//>`;
}

/**
 * The top bar's items that extensions added: a button for each panel, which toggles it, and each `pocket.topbar`
 * action. On a phone, and in a narrow pane, they go, as the Files button does: the places open the panels there.
 */
function topbarItems() {
    const panels = added("panel").map(({ record, spec }) => ({
        id: itemId(record, spec),
        label: spec.title,
        module: record.title,
        render: () => topbarButton(record, spec, { panel: spec.id }),
    }));
    const actions = added("topbar").map(({ record, spec }) => ({
        id: itemId(record, spec),
        label: spec.title,
        module: record.title,
        before: spec.before,
        after: spec.after,
        render: () => topbarButton(record, spec, spec),
    }));

    return [...panels, ...actions];
}

function topbarButton(record, spec, action) {
    const on = opened(record, action);
    const toggles = action.page !== undefined || action.panel !== undefined;
    const badge = badgeFor(spec);

    return html`<button
        class=${`icon-button badge-host top-toggle quiet-phone ext-top-button ${on ? "on" : ""}`}
        data-module=${record.module}
        aria-label=${badge === "" ? spec.title : `${spec.title}, ${badge}`}
        aria-pressed=${toggles ? on : undefined}
        title=${spec.title}
        onClick=${() => (on ? closeOf(action) : activate(record, action))}
    >
        <${Icon} path=${pathOf(spec)} size=${18} />
        ${badge !== "" && html`<span class="badge">${badge}</span>`}
    </button>`;
}

/** The places that extensions added: a tile for each panel. */
function placeItems() {
    return added("panel").map(({ record, spec }) => ({
        id: itemId(record, spec),
        label: spec.title,
        module: record.title,
        render: () =>
            html`<${PlaceTile}
                place=${{
                    id: itemId(record, spec),
                    label: spec.title,
                    iconPath: pathOf(spec),
                    badge: badgeFor(spec),
                    on: opened(record, { panel: spec.id }),
                    run: () => openExtPanel(record.module, spec.id),
                }}
            />`,
    }));
}

/** The buttons that extensions added to the message box's row, after the app's own on its left. */
function composerItems() {
    return added("composerButton").map(({ record, spec }) => ({
        id: itemId(record, spec),
        label: spec.title,
        module: record.title,
        before: spec.before,
        after: spec.after,
        render: () => {
            const on = opened(record, spec);
            const badge = badgeFor(spec);

            return html`<button
                class=${`icon-button badge-host ext-composer-button ${on ? "on" : ""}`}
                data-part="composer-button"
                data-module=${record.module}
                aria-label=${badge === "" ? spec.title : `${spec.title}, ${badge}`}
                title=${spec.title}
                onMouseDown=${(event) => event.preventDefault()}
                onClick=${() => (on ? closeOf(spec) : activate(record, spec))}
            >
                <${Icon} path=${pathOf(spec)} size=${17} />
                ${badge !== "" && html`<span class="badge">${badge}</span>`}
            </button>`;
        },
    }));
}

/**
 * The actions that extensions added under Pi's answers, before More. Each gets the answer as `{ id, text,
 * conversationId }`: its run as an argument, its sheet as the prop `reply`.
 */
function replyItems() {
    return added("replyAction").map(({ record, spec }) => ({
        id: itemId(record, spec),
        revision: `@${revisionOf(spec)}`,
        label: spec.label,
        module: record.title,
        before: spec.before,
        after: spec.after,
        render: ({ entry, text }) => {
            const reply = Object.freeze({
                id: String(entry.id),
                text,
                conversationId: store.state.conversationId,
            });

            return html`<button
                class="answer-tool ext-reply-action"
                data-module=${record.module}
                onClick=${() =>
                    spec.sheet === undefined
                        ? activate(record, spec, reply)
                        : activate(record, spec, { reply })}
            >
                ${
                    (spec.icon !== undefined || spec.iconPath !== undefined) &&
                    html`<${Icon} path=${pathOf(spec)} size=${12} />`
                }
                ${spec.label}
            </button>`;
        },
    }));
}

const sources = {
    status: statusItems,
    topbar: topbarItems,
    places: placeItems,
    composer: composerItems,
    reply: replyItems,
};

fromExtensions(
    (slot) => sources[slot]?.() ?? [],
    (slot) =>
        order
            .map((module) => modules.get(module))
            .filter((record) => liveRecord(record) && record.arrangements.has(slot))
            .map((record) => ({ title: record.title, ...record.arrangements.get(slot) })),
);

/**
 * Something an extension draws, which may fail: it says so in its place, and the rest of the app goes on. Whatever was
 * thrown (an empty string, nothing at all) counts.
 */
class Guard extends Component {
    state = { failed: false, message: "" };

    constructor(props) {
        super(props);
        guards++;
    }

    componentWillUnmount() {
        guards--;
    }

    componentDidCatch(error) {
        console.error(`${this.props.name} failed`, error);
        this.setState({ failed: true, message: reason(error) });
    }

    render({ children, name }, { failed, message }) {
        return failed ? html`<div class="error-box">${name} failed: ${message}</div>` : children;
    }
}

// Preact reads `.then` of whatever a component throws while it draws, to tell a pause from a failure, so a thrown `null`
// or `undefined` breaks Preact itself, past every boundary (and, from a component that drew again alone, out of its
// queue, which then drops what else waited to draw). So under a Guard, what Preact calls of a component while it draws
// turns those into an Error first: its render and the lifecycle methods called with it, its class's
// getDerivedStateFromProps, and the effects hooks run before it draws again. Checked again each time it draws, so a
// method it replaces is covered too. A method given by a getter is left as it is, and so is a class's constructor, which
// Preact calls only when its parent draws: what that throws stays under the Guard, in Preact's own words.
//
// Preact's hooks (`_diff`, `_render`) and a vnode's component and parent go by these short names in its build, as
// preact/hooks uses them; the app's own components are left as they are. Should the names change, this does nothing,
// and `Drawn` still keeps such a failure under the Guard, in Preact's own words.
const DIFF_HOOK = "__b";
const RENDER_HOOK = "__r";
const COMPONENT = "__c";
const PARENT = "__";
const NO_REASON = "it gave no reason";
/** What Preact calls of a component while it draws, besides its class's getDerivedStateFromProps. */
const DRAWING = [
    "render",
    "componentWillMount",
    "componentWillReceiveProps",
    "shouldComponentUpdate",
    "componentWillUpdate",
    "getChildContext",
    "getSnapshotBeforeUpdate",
];
/** The wrappers made here, so none is wrapped again. */
const wrappers = new WeakSet();
/** Each component instance, and each class, once known: whether it draws under a Guard. */
const guardedComponents = new WeakMap();
const guardedClasses = new WeakSet();
/** The instances whose inherited methods were checked too, at their first draw: after it, only their own change. */
const scanned = new WeakSet();
/** How many Guards there are: with none, nothing draws under one, and no vnode's parents need a look. */
let guards = 0;
/** The instance whose own methods were checked as its vnode began to draw, so not again right before it draws. */
let checkedNow = null;

/** `run`, but what it throws is never `null` or `undefined`. */
function throwsSomething(run) {
    const wrapped = function (...args) {
        try {
            return run.apply(this, args);
        } catch (error) {
            throw error ?? new Error(NO_REASON);
        }
    };

    wrappers.add(wrapped);

    return wrapped;
}

/**
 * Wrap the methods `names` of `target`, its own, or inherited too, where they are plain functions that can be
 * replaced.
 */
function wrapMethods(target, names, inherited = true) {
    for (const name of names) {
        let owner = target;
        let found = Object.getOwnPropertyDescriptor(owner, name);

        while (found === undefined && inherited) {
            owner = Object.getPrototypeOf(owner);

            if (owner === null || owner === Object.prototype) {
                break;
            }

            found = Object.getOwnPropertyDescriptor(owner, name);
        }

        // None; a getter (left as it is); or one wrapped already.
        if (found === undefined || !("value" in found)) {
            continue;
        }

        if (typeof found.value !== "function" || wrappers.has(found.value)) {
            continue;
        }

        try {
            Object.defineProperty(target, name, {
                value: throwsSomething(found.value),
                writable: true,
                configurable: true,
                enumerable: owner === target ? found.enumerable : false,
            });
        } catch {
            // Frozen, or a property that cannot change: left as it is.
        }
    }
}

const isClass = (type) =>
    typeof type === "function" && typeof type.prototype?.render === "function";

/** Whether a vnode draws under a Guard (not counting a Guard itself). */
function underGuard(vnode) {
    if (guards === 0) {
        return false;
    }

    for (let above = vnode?.[PARENT]; above; above = above[PARENT]) {
        if (above.type === Guard) {
            return true;
        }
    }

    return false;
}

/** Whether a component instance draws under a Guard, worked out once. */
function guarded(component, vnode) {
    if (typeof component !== "object" || component === null) {
        return false;
    }

    let inside = guardedComponents.get(component);

    if (inside === undefined) {
        inside = underGuard(vnode);
        guardedComponents.set(component, inside);
    }

    return inside;
}

/** A class drawn under a Guard: its methods, and its getDerivedStateFromProps, before any of its instances draws. */
function guardClass(type) {
    if (guardedClasses.has(type)) {
        return;
    }

    guardedClasses.add(type);
    wrapMethods(type.prototype, DRAWING);
    wrapMethods(type, ["getDerivedStateFromProps"]);
}

const beforeDiff = options[DIFF_HOOK];
const beforeRender = options[RENDER_HOOK];

// Before a vnode draws: a class under a Guard is guarded before its first instance is made, and its
// getDerivedStateFromProps again if it was replaced since; a component drawing again alone (its own state changed) has
// the methods it may have replaced since wrapped again.
options[DIFF_HOOK] = (vnode) => {
    if (typeof beforeDiff === "function") {
        beforeDiff(vnode);
    }

    checkedNow = null;

    const type = vnode?.type;

    if (isClass(type)) {
        if (guardedClasses.has(type)) {
            wrapMethods(type, ["getDerivedStateFromProps"]);
        } else if (underGuard(vnode)) {
            guardClass(type);
        }
    }

    const component = vnode?.[COMPONENT];

    if (component && guardedComponents.get(component) === true) {
        wrapMethods(component, DRAWING, false);
        checkedNow = component;
    }
};

// Right before a component draws: its methods, and the effects hooks run first when it draws again before they ran.
options[RENDER_HOOK] = (vnode) => {
    const component = vnode?.[COMPONENT];

    if (!guarded(component, vnode)) {
        if (typeof beforeRender === "function") {
            beforeRender(vnode);
        }

        return;
    }

    if (checkedNow !== component) {
        wrapMethods(component, DRAWING, !scanned.has(component));
        scanned.add(component);
    }

    checkedNow = null;

    if (isClass(component.constructor)) {
        guardClass(component.constructor);
    }

    if (typeof beforeRender === "function") {
        try {
            beforeRender(vnode);
        } catch (error) {
            throw error ?? new Error(NO_REASON);
        }
    }
};

/** Between the Guard and an extension's component: what goes wrong in it, however Preact takes it, stays under the Guard. */
function Drawn({ component, props }) {
    return h(component, props);
}

/** Each extension component's number, for its Guard's key: a new component starts with a new Guard. */
const componentIds = new WeakMap();
let nextComponentId = 1;

function componentId(component) {
    if (!componentIds.has(component)) {
        componentIds.set(component, nextComponentId++);
    }

    return componentIds.get(component);
}

/** What a page or sheet shows: its component once its module is ready, else why not. */
function Body({ record, spec, title, props, close }) {
    if (record === undefined) {
        return html`<p class="muted">This extension is off.</p>`;
    }

    if (record.status === "failed") {
        return html`<div class="error-box">
            ${record.title} ${record.how ?? "failed to load"} in this browser: ${record.error}
        </div>`;
    }

    if (spec === undefined) {
        return record.status === "ready"
            ? html`<p class="muted">${record.title} no longer has this.</p>`
            : html`<${Loader} label=${`Loading ${title}`} />`;
    }

    // A Guard that caught a failure stays with it until its component changes (the page added again, or updated).
    return html`<${Guard} key=${`${record.url}#${componentId(spec.component)}`} name=${title}>
        <${Drawn}
            component=${spec.component}
            props=${{ ...props, pocket: record.pocket, close }}
        />
    <//>`;
}

/** An extension's page in the conversation's place: its title, a close button, and what it draws. */
export function ExtensionPage() {
    const target = store.state.page;
    const record = modules.get(target?.module);
    const spec = record?.adds.page.get(target?.id);
    const title = spec?.title ?? record?.title ?? "Extension";
    // A page that keeps Esc for itself (`escape: false`): read as the key comes, as it may change.
    const keepsEscape = useRef(false);
    const close = useMemo(() => pageCloser(record, target?.id), [record, target?.id]);

    keepsEscape.current = spec?.escape === false;
    useBack(true, closePage);

    // Esc closes it, as it does the subagents board, unless something over it takes Esc first, or the page keeps Esc.
    // Heard before the others (capturing): a sheet over it closes on the same key, and would be gone by the time this
    // heard it. Not while a character is being composed (an input method's Esc cancels that).
    useEffect(() => {
        const onKey = (event) => {
            const { sheet, launcher, pipOpen } = store.state;

            if (
                event.key === "Escape" &&
                !event.isComposing &&
                event.keyCode !== 229 &&
                !event.defaultPrevented &&
                !sheet &&
                !launcher &&
                !pipOpen &&
                !keepsEscape.current
            ) {
                event.preventDefault();
                closePage();
            }
        };

        addEventListener("keydown", onKey, true);

        return () => removeEventListener("keydown", onKey, true);
    }, []);

    // A page that keeps sideways swipes (`swipe: false`) starts no swipe back anywhere on it (`gestures.js`).
    return html`<section
        class="ext-page"
        data-part="extension-page"
        aria-label=${title}
        data-module=${target?.module}
        data-no-swipe=${spec?.swipe === false ? "" : undefined}
    >
        <header class="board-head">
            <div class="board-title">
                <h2>${title}</h2>
                ${
                    record &&
                    record.title !== title &&
                    html`<div class="board-sub">${record.title}</div>`
                }
            </div>
            <button
                class="icon-button"
                title="Back to the conversation (Esc)"
                aria-label="Close"
                onClick=${closePage}
            >
                <${Icon} name="close" />
            </button>
        </header>
        <div class="ext-page-body">
            <${Body} record=${record} spec=${spec} title=${title} props=${{}} close=${close} />
        </div>
    </section>`;
}

/** An extension's sheet (`{ type: "ext", module, sheetId, props }`). */
export function ExtensionSheet({ sheet }) {
    const record = modules.get(sheet.module);
    const spec = record?.adds.sheet.get(sheet.sheetId);
    const title = spec?.title ?? record?.title ?? "Extension";
    const close = useMemo(() => sheetCloser(record, sheet.sheetId), [record, sheet.sheetId]);

    return html`<${Sheet} title=${title} onClose=${closeSheet} wide=${spec?.wide === true}>
        <${Body}
            record=${record}
            spec=${spec}
            title=${title}
            props=${sheet.props ?? {}}
            close=${close}
        />
    <//>`;
}

/**
 * An extension's panel (`store.state.extPanel`): beside the conversation on wide screens, where the Browser and Files
 * panels dock, with its title and a close button; elsewhere a screen pushed over the conversation, with a way back,
 * which back closes too. `leaving`: it slides away (`PanelHost`, app.js).
 */
export function ExtensionPanel({ leaving = false }) {
    // While it slides away, what it showed: the store no longer names it.
    const last = useRef(store.state.extPanel);

    if (store.state.extPanel !== null) {
        last.current = store.state.extPanel;
    }

    const target = last.current;
    const record = modules.get(target?.module);
    const spec = record?.adds.panel.get(target?.id);
    const title = spec?.title ?? record?.title ?? "Extension";
    const close = useMemo(() => panelCloser(record, target?.id), [record, target?.id]);
    const beside = panelsBeside();

    useBack(!beside && !leaving, closeExtPanel);

    return html`<section
        class=${`ext-panel window ${spec?.wide === true ? "wide" : ""} ${leaving ? "leaving" : ""}`}
        data-part="extension-panel"
        data-module=${target?.module}
        data-state=${leaving ? "closing" : undefined}
        role=${beside ? undefined : "dialog"}
        aria-modal=${beside ? undefined : "true"}
        aria-label=${title}
        tabindex="-1"
        inert=${leaving}
    >
        <header class="ext-panel-bar">
            ${
                !beside &&
                html`<button
                    class="icon-button ext-panel-back"
                    type="button"
                    aria-label="Back to the conversation"
                    title="Back"
                    onClick=${closeExtPanel}
                >
                    <${Icon} name="back" size=${22} />
                </button>`
            }
            <div class="ext-panel-title">
                <h2>${title}</h2>
                ${
                    record &&
                    record.title !== title &&
                    html`<div class="ext-panel-sub">${record.title}</div>`
                }
            </div>
            ${
                beside &&
                html`<button
                    class="icon-button"
                    type="button"
                    aria-label=${`Close ${title}`}
                    title="Close"
                    onClick=${closeExtPanel}
                >
                    <${Icon} name="close" size=${17} />
                </button>`
            }
        </header>
        <div class="ext-panel-body">
            <${Body} record=${record} spec=${spec} title=${title} props=${{}} close=${close} />
        </div>
    </section>`;
}
