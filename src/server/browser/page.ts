/**
 * One conversation's page in the built-in browser: its events, screencast frames, console, and navigation, and what Pi
 * and people do to it.
 */
import { BrowserError, type Connection, type Json } from "./cdp.ts";
import { KEYS, keyEvents, parseKeys } from "./keys.ts";
import {
    DESCRIBE_FUNCTION,
    LOCATE_SCRIPT,
    SELECT_ALL_SCRIPT,
    SELECT_OPTION_SCRIPT,
    SNAPSHOT_SCRIPT,
} from "./page-scripts.ts";
import { clamp, presetOf, type Viewport, type ViewportPreset } from "./viewport.ts";

export type BrowserState = {
    /** A browser to run was found on this machine. */
    available: boolean;
    /** The conversation's page is open. */
    open: boolean;
    url: string;
    title: string;
    loading: boolean;
    viewport: Viewport;
    preset?: ViewportPreset;
    canGoBack: boolean;
    canGoForward: boolean;
    /** Console errors since the page last loaded. */
    errors: number;
    /** How many console lines there are, to know when to fetch them again. */
    logs: number;
    /** Why the page could not open, or that it crashed. */
    problem?: string;
};

export type LogEntry = { seq: number; at: number; level: string; text: string; source?: string };

export type Frame = { seq: number; data: Buffer; width: number; height: number };

/** Where Pi points: a ref from the last snapshot, a CSS selector, visible text, or a point. */
export type Target = { ref?: string; selector?: string; label?: string; x?: number; y?: number };

export type Saved = { url?: string; viewport?: Viewport };

const MAX_LOGS = 300;
/** Frame numbers, for every page: a page opened again goes on from where the last one was. */
let frameCount = 0;
/** At most one screencast frame per this many milliseconds. */
const FRAME_GAP_MS = 40;
/** Frames stop this long after the last viewer asked for one. */
const WATCH_MS = 15_000;
const FRAME_WAIT_MS = 25_000;
/**
 * Across sites, a navigation moves the page to a new process, and for a moment Chromium refuses commands without running
 * them. These ones are sent again then, for up to `SWAP_WAIT_MS` (the last try still gets the command's own timeout):
 * reloading and stopping act on whatever document is there. Others are not: a script, a selection, or a place to click
 * meant for the old document must not act on the new one, and a navigation sent again could overtake a newer one.
 */
const RETRY_WHILE_SWAPPING = new Set(["Page.reload", "Page.stopLoading"]);
const SWAP_WAIT_MS = 3000;

/**
 * The longest side of a screenshot's image, in pixels. Models refuse larger images once a conversation holds many of
 * them, and that refusal breaks every turn after it; they shrink anything past about 1600 pixels themselves anyway.
 */
export const SHOT_MAX = 2000;

/** The scale that brings an image of `width` × `height` pixels within `SHOT_MAX`. */
const fit = (width: number, height: number) => Math.min(1, SHOT_MAX / Math.max(width, height, 1));

/** A console argument as text: strings as they are, other values as DevTools would show them in one line. */
function formatArg(arg: Json): string {
    if (arg === undefined || arg === null) {
        return "";
    }

    if (arg.type === "string") {
        return String(arg.value);
    }

    if (arg.type === "undefined") {
        return "undefined";
    }

    if (arg.unserializableValue !== undefined) {
        return String(arg.unserializableValue);
    }

    if (Object.hasOwn(arg, "value")) {
        return JSON.stringify(arg.value);
    }

    const preview = arg.preview;

    if (preview !== undefined && Array.isArray(preview.properties)) {
        const items = preview.properties.map((property: Json) =>
            preview.subtype === "array" ? property.value : `${property.name}: ${property.value}`,
        );
        const body = `${items.join(", ")}${preview.overflow ? ", …" : ""}`;

        return preview.subtype === "array"
            ? `[${body}]`
            : `${arg.className && arg.className !== "Object" ? `${arg.className} ` : ""}{${body}}`;
    }

    return String(arg.description ?? arg.className ?? arg.type);
}

export const wait = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

function aborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted) {
        throw new BrowserError("Stopped.");
    }
}

/** A page script's result, or its exception as an error. */
function evaluated(response: Json): Json {
    if (response.exceptionDetails !== undefined) {
        const details = response.exceptionDetails;
        const message =
            details.exception?.description ??
            details.exception?.value ??
            details.text ??
            "The script failed";

        throw new BrowserError(String(message).split("\n    at ")[0] ?? "The script failed");
    }

    return response.result?.value;
}

/** One conversation's page. Everything it knows comes from the browser's events; nothing here is stored. */
export class BrowserPage {
    readonly conversationId: number;
    readonly #connection: Connection;
    readonly #session: string;
    readonly #target: string;
    readonly #context: string;
    readonly #baseAgent: string;
    readonly #changed: () => void;
    readonly #saved: (saved: Saved) => void;
    #frameId = "";
    #url = "about:blank";
    #title = "";
    #loading = false;
    #starts = 0;
    #stops = 0;
    readonly #stopWaiters = new Set<() => void>();
    #viewport: Viewport;
    #canGoBack = false;
    #canGoForward = false;
    #logs: LogEntry[] = [];
    #logSeq = 0;
    #errors = 0;
    #crashed = false;
    #closed = false;
    #frame: Frame | undefined;
    readonly #frameWaiters = new Set<() => void>();
    #watchers = 0;
    #watchedAt = 0;
    #casting = false;
    #castTimer: NodeJS.Timeout | undefined;
    #historyTimer: NodeJS.Timeout | undefined;
    #saveTimer: NodeJS.Timeout | undefined;
    /** Last time Pi or a person used this page; idle pages close. */
    usedAt = Date.now();
    readonly #popups = new Map<string, NodeJS.Timeout>();
    /** Tabs already sent here or closed, until the browser says they are gone: their later updates change nothing. */
    readonly #handled = new Set<string>();

    constructor(options: {
        conversationId: number;
        connection: Connection;
        session: string;
        target: string;
        context: string;
        userAgent: string;
        viewport: Viewport;
        changed: () => void;
        saved: (saved: Saved) => void;
    }) {
        this.conversationId = options.conversationId;
        this.#connection = options.connection;
        this.#session = options.session;
        this.#target = options.target;
        this.#context = options.context;
        this.#baseAgent = options.userAgent;
        this.#viewport = options.viewport;
        this.#changed = options.changed;
        this.#saved = options.saved;
        this.#connection.listen(this.#session, (method, params) => this.#event(method, params));
    }

    get targetId(): string {
        return this.#target;
    }

    get contextId(): string {
        return this.#context;
    }

    get closed(): boolean {
        return this.#closed || this.#connection.closed;
    }

    get url(): string {
        return this.#url;
    }

    get title(): string {
        return this.#title;
    }

    get viewport(): Viewport {
        return { ...this.#viewport };
    }

    /** Send a command to the page; a reload or stop again while a navigation swaps its document (`RETRY_WHILE_SWAPPING`). */
    async #send(
        method: string,
        params: Record<string, unknown> = {},
        timeoutMs?: number,
    ): Promise<Json> {
        const started = Date.now();

        for (;;) {
            if (this.#closed) {
                throw new BrowserError("This page is closed.");
            }

            try {
                return await this.#connection.send(method, params, this.#session, timeoutMs);
            } catch (error) {
                if (
                    !(error instanceof BrowserError) ||
                    error.message !== "Not attached to an active page" ||
                    !RETRY_WHILE_SWAPPING.has(method) ||
                    Date.now() - started > SWAP_WAIT_MS
                ) {
                    throw error;
                }

                await wait(25);
            }
        }
    }

    async init(): Promise<void> {
        await Promise.all([
            this.#send("Page.enable"),
            this.#send("Runtime.enable"),
            this.#send("Log.enable"),
        ]);
        const tree = await this.#send("Page.getFrameTree");

        this.#frameId = String(tree.frameTree?.frame?.id ?? "");
        await this.#applyViewport();
    }

    state(available: boolean): BrowserState {
        return {
            available,
            open: !this.closed,
            url: this.#url,
            title: this.#title,
            loading: this.#loading,
            viewport: { ...this.#viewport },
            ...(presetOf(this.#viewport) === undefined ? {} : { preset: presetOf(this.#viewport) }),
            canGoBack: this.#canGoBack,
            canGoForward: this.#canGoForward,
            errors: this.#errors,
            logs: this.#logSeq,
            ...(this.#crashed ? { problem: "The page crashed. Reload it." } : {}),
        };
    }

    // ─── Events ─────────────────────────────────────────────────────────────

    #event(method: string, params: Json): void {
        switch (method) {
            case "Page.frameNavigated": {
                const frame = params.frame;

                if (frame === undefined || frame.parentId !== undefined) {
                    return;
                }

                this.#frameId = frame.id;
                // A page that failed to load shows Chromium's error page; the address is still the one asked for.
                this.#url = String(
                    frame.unreachableUrl ?? `${frame.url}${frame.urlFragment ?? ""}`,
                );
                this.#errors = 0;
                this.#crashed = false;
                this.#log("nav", this.#url);
                this.#navigated();

                return;
            }

            case "Page.navigatedWithinDocument":
                if (params.frameId !== this.#frameId) {
                    return;
                }

                this.#url = String(params.url);
                this.#navigated();

                return;
            case "Page.frameStartedLoading":
                if (params.frameId !== this.#frameId) {
                    return;
                }

                this.#starts++;

                if (this.#loading) {
                    return;
                }

                this.#loading = true;
                this.#changed();

                return;
            case "Page.frameStoppedLoading":
                if (params.frameId !== this.#frameId) {
                    return;
                }

                this.#loading = false;
                this.#stops++;

                for (const wake of this.#stopWaiters) {
                    wake();
                }

                this.#stopWaiters.clear();
                this.#changed();

                return;

            case "Page.javascriptDialogOpening": {
                // Nobody can answer a dialog in a headless page, and it would stop the page: accept it, and say so.
                this.#log("dialog", `${params.type}: ${params.message}`);
                void this.#send("Page.handleJavaScriptDialog", {
                    accept: true,
                    ...(params.type === "prompt"
                        ? { promptText: String(params.defaultPrompt ?? "") }
                        : {}),
                }).catch(() => {});

                return;
            }

            case "Page.screencastFrame":
                this.#onFrame(params);

                return;

            case "Runtime.consoleAPICalled": {
                const level =
                    params.type === "warning"
                        ? "warn"
                        : params.type === "assert"
                          ? "error"
                          : String(params.type);

                if (level === "clear") {
                    return;
                }

                const frame = params.stackTrace?.callFrames?.[0];

                this.#log(
                    level,
                    (params.args ?? []).map(formatArg).join(" "),
                    frame === undefined ? undefined : `${frame.url}:${frame.lineNumber + 1}`,
                );

                return;
            }

            case "Runtime.exceptionThrown": {
                const details = params.exceptionDetails ?? {};
                const text =
                    String(
                        details.exception?.description ?? details.text ?? "Uncaught error",
                    ).split("\n    at ")[0] ?? "";

                this.#log(
                    "error",
                    text.startsWith("Uncaught") ? text : `Uncaught ${text}`,
                    details.url ? `${details.url}:${(details.lineNumber ?? 0) + 1}` : undefined,
                );

                return;
            }

            case "Log.entryAdded": {
                const entry = params.entry ?? {};

                // The browser asks every site for an icon by itself; most dev servers have none. Not the page's error.
                if (
                    entry.source === "network" &&
                    /\/favicon\.ico([?#]|$)/.test(String(entry.url ?? ""))
                ) {
                    return;
                }

                const level =
                    entry.level === "warning"
                        ? "warn"
                        : entry.level === "verbose"
                          ? "debug"
                          : String(entry.level ?? "info");

                this.#log(
                    level,
                    String(entry.text ?? ""),
                    entry.url ? String(entry.url) : undefined,
                );

                return;
            }

            case "Inspector.targetCrashed":
                this.#crashed = true;
                this.#loading = false;
                this.#changed();

                return;
        }
    }

    /** The browser's own events about this page's target, and popups it opened. */
    targetEvent(method: string, info: Json): void {
        if (info?.targetId === this.#target) {
            if (method === "Target.targetInfoChanged") {
                const title = String(info.title ?? "");
                // Until a page has a title, Chromium reports its address as one.
                const next =
                    title === info.url || title === this.#url.replace(/^https?:\/\//, "")
                        ? ""
                        : title;

                if (next !== this.#title) {
                    this.#title = next;
                    this.#changed();
                }
            }

            return;
        }

        const id = String(info?.targetId);

        // The browser says only which tab is gone.
        if (method === "Target.targetDestroyed") {
            clearTimeout(this.#popups.get(id));
            this.#popups.delete(id);
            this.#handled.delete(id);

            return;
        }

        if (info?.type !== "page" || info.browserContextId !== this.#context) {
            return;
        }

        // Pages the browser prerenders on a site's hint are its guesses, not tabs; and only this page's tabs come here.
        if (
            (info.subtype ?? "") !== "" ||
            (info.openerId !== undefined && info.openerId !== this.#target) ||
            this.#handled.has(id)
        ) {
            return;
        }

        // One page per conversation: a popup or new tab opens here instead, once it has an address.
        const url = String(info.url ?? "");

        if (method === "Target.targetCreated" || method === "Target.targetInfoChanged") {
            if (!this.#popups.has(id)) {
                const timer = setTimeout(() => this.#closePopup(id), 5000);

                timer.unref();
                this.#popups.set(id, timer);
            }

            if (url !== "" && url !== "about:blank") {
                this.#closePopup(id);
                // Opened from here, the address would skip the browser's own rules (a web page may not open a file): only
                // web addresses follow, and files from a page that is a file itself.
                const web =
                    /^https?:/i.test(url) || (/^file:/i.test(url) && /^file:/i.test(this.#url));

                if (web) {
                    void this.navigate(url, { wait: false }).catch(() => {});
                } else {
                    this.#log("warn", `A new tab for ${url} was not opened.`);
                }
            }
        }
    }

    #closePopup(targetId: string): void {
        clearTimeout(this.#popups.get(targetId));
        this.#popups.delete(targetId);
        this.#handled.add(targetId);
        void this.#connection.send("Target.closeTarget", { targetId }).catch(() => {});
    }

    #log(level: string, text: string, source?: string): void {
        const entry: LogEntry = {
            seq: ++this.#logSeq,
            at: Date.now(),
            level,
            text: text.length > 2000 ? `${text.slice(0, 1999)}…` : text,
            ...(source === undefined || source === "" ? {} : { source }),
        };

        this.#logs.push(entry);

        if (this.#logs.length > MAX_LOGS) {
            this.#logs.splice(0, this.#logs.length - MAX_LOGS);
        }

        if (level === "error") {
            this.#errors++;
        }

        this.#changed();
    }

    #navigated(): void {
        this.#changed();
        clearTimeout(this.#historyTimer);
        this.#historyTimer = setTimeout(() => void this.#refreshHistory(), 50);
        this.#historyTimer.unref();
        clearTimeout(this.#saveTimer);
        this.#saveTimer = setTimeout(() => this.#save(), 1000);
        this.#saveTimer.unref();
    }

    #save(): void {
        if (this.#closed) {
            return;
        }

        const url = this.#url;

        this.#saved({
            ...(url === "about:blank" || url.startsWith("chrome-error:") ? {} : { url }),
            viewport: { ...this.#viewport },
        });
    }

    async #refreshHistory(): Promise<void> {
        try {
            const history = await this.#send("Page.getNavigationHistory");
            const back = history.currentIndex > 0;
            const forward = history.currentIndex < history.entries.length - 1;
            const entry = history.entries[history.currentIndex];
            // A page without a title has its address as one.
            const title =
                entry === undefined || entry.title === entry.url ? "" : String(entry.title ?? "");

            if (
                back !== this.#canGoBack ||
                forward !== this.#canGoForward ||
                title !== this.#title
            ) {
                this.#canGoBack = back;
                this.#canGoForward = forward;
                this.#title = title;
                this.#changed();
            }
        } catch {
            // Closed meanwhile.
        }
    }

    // ─── Frames for the Browser panel ─────────────────────────────────────

    #onFrame(params: Json): void {
        const meta = params.metadata ?? {};

        this.#frame = {
            seq: ++frameCount,
            data: Buffer.from(String(params.data ?? ""), "base64"),
            width: Math.round(meta.deviceWidth ?? this.#viewport.width),
            height: Math.round(meta.deviceHeight ?? this.#viewport.height),
        };

        for (const wake of this.#frameWaiters) {
            wake();
        }

        this.#frameWaiters.clear();
        // The next frame comes after this one is acknowledged: acknowledging a little later caps the frame rate.
        const timer = setTimeout(() => {
            if (this.#casting) {
                void this.#send("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(
                    () => {},
                );
            }
        }, FRAME_GAP_MS);

        timer.unref();
    }

    async #startCast(): Promise<void> {
        if (this.#casting || this.closed) {
            return;
        }

        this.#casting = true;
        const scale = Math.min(this.#viewport.scale, 2);

        try {
            await this.#send("Page.startScreencast", {
                format: "jpeg",
                quality: 65,
                maxWidth: Math.round(this.#viewport.width * scale),
                maxHeight: Math.round(this.#viewport.height * scale),
            });
        } catch {
            this.#casting = false;

            return;
        }

        clearInterval(this.#castTimer);
        this.#castTimer = setInterval(() => {
            if (this.#watchers === 0 && Date.now() - this.#watchedAt > WATCH_MS) {
                void this.#stopCast();
            }
        }, 5000);
        this.#castTimer.unref();
    }

    async #stopCast(): Promise<void> {
        clearInterval(this.#castTimer);
        this.#castTimer = undefined;

        if (!this.#casting) {
            return;
        }

        this.#casting = false;
        await this.#send("Page.stopScreencast").catch(() => {});
    }

    /** The newest frame after `after`, waiting for one up to 25 seconds; undefined if none came. */
    async frame(after: number, signal?: AbortSignal): Promise<Frame | undefined> {
        // A number from before a restart: this tab has none of these frames.
        if (after > frameCount) {
            after = 0;
        }

        this.#watchedAt = Date.now();
        this.usedAt = Date.now();
        this.#watchers++;

        try {
            await this.#startCast();

            if (this.#frame !== undefined && this.#frame.seq > after) {
                return this.#frame;
            }

            if (this.closed) {
                return undefined;
            }

            await new Promise<void>((done) => {
                const finish = () => {
                    clearTimeout(timer);
                    signal?.removeEventListener("abort", finish);
                    this.#frameWaiters.delete(finish);
                    done();
                };

                const timer = setTimeout(finish, FRAME_WAIT_MS);

                signal?.addEventListener("abort", finish, { once: true });
                this.#frameWaiters.add(finish);
            });

            return this.#frame !== undefined && this.#frame.seq > after ? this.#frame : undefined;
        } finally {
            this.#watchers--;
            this.#watchedAt = Date.now();
        }
    }

    /**
     * Taps, drags, scrolls, and keys from the Browser panel, in order: `click`, `mouse` (down, up, or move), `wheel`, `key`,
     * and `text`, at CSS pixels of the viewport. They come from browsers, so each is checked as it is read.
     */
    async input(events: readonly unknown[]): Promise<void> {
        this.usedAt = Date.now();
        const { width, height } = this.#viewport;
        const point = (raw: Record<string, unknown>) => ({
            x: clamp(Number(raw.x) || 0, 0, width),
            y: clamp(Number(raw.y) || 0, 0, height),
        });
        const button = (raw: unknown) => (raw === "right" || raw === "middle" ? raw : "left");

        for (const item of events) {
            if (typeof item !== "object" || item === null) {
                continue;
            }

            const event = item as Record<string, unknown>;

            switch (event.type) {
                case "click":
                    await this.#click(
                        point(event),
                        button(event.button),
                        clamp(Number(event.count) || 1, 1, 3),
                    );
                    break;

                case "mouse": {
                    const at = point(event);
                    const pressed = button(event.button);
                    const type =
                        event.action === "down"
                            ? "mousePressed"
                            : event.action === "up"
                              ? "mouseReleased"
                              : "mouseMoved";
                    const count = clamp(Number(event.count) || 1, 1, 3);

                    await this.#send("Input.dispatchMouseEvent", {
                        type,
                        ...at,
                        button: type === "mouseMoved" && event.pressed !== true ? "none" : pressed,
                        buttons: event.pressed === true || type === "mousePressed" ? 1 : 0,
                        clickCount: type === "mouseMoved" ? 0 : count,
                    });
                    break;
                }

                case "wheel":
                    await this.#send("Input.dispatchMouseEvent", {
                        type: "mouseWheel",
                        ...point(event),
                        deltaX: clamp(Number(event.dx) || 0, -5000, 5000),
                        deltaY: clamp(Number(event.dy) || 0, -5000, 5000),
                    });
                    break;

                case "key": {
                    const key = String(event.key ?? "");

                    if (
                        key === "" ||
                        key === "Unidentified" ||
                        key === "Dead" ||
                        key === "Process"
                    ) {
                        break;
                    }

                    if (key.length !== 1 && KEYS[key] === undefined) {
                        break;
                    }

                    await this.#key(key, clamp(Number(event.modifiers) || 0, 0, 15));
                    break;
                }

                case "text": {
                    const text = String(event.text ?? "").slice(0, 10_000);

                    if (text !== "") {
                        await this.#send("Input.insertText", { text });
                    }

                    break;
                }
            }
        }
    }

    async #click(at: { x: number; y: number }, button: string, count: number): Promise<void> {
        await this.#send("Input.dispatchMouseEvent", { type: "mouseMoved", ...at, button: "none" });

        for (let index = 1; index <= count; index++) {
            await this.#send("Input.dispatchMouseEvent", {
                type: "mousePressed",
                ...at,
                button,
                buttons: 1,
                clickCount: index,
            });
            await this.#send("Input.dispatchMouseEvent", {
                type: "mouseReleased",
                ...at,
                button,
                buttons: 0,
                clickCount: index,
            });
        }
    }

    async #key(key: string, modifiers: number): Promise<void> {
        const { down, up } = keyEvents(key, modifiers);

        await this.#send("Input.dispatchKeyEvent", down);
        await this.#send("Input.dispatchKeyEvent", up);
    }

    // ─── Navigation ───────────────────────────────────────────────────────────

    /** Where loading stands before an action, to tell the loads it started from those already going on. */
    #mark(): { starts: number; stops: number } {
        return { starts: this.#starts, stops: this.#stops };
    }

    /**
     * Wait for the load an action started, until it stops; false when that took longer than `timeoutMs`. A load that was
     * going on before (a request that never ends) does not count. With `started`, the action surely started one.
     */
    async #settle(
        mark: { starts: number; stops: number },
        timeoutMs: number,
        signal?: AbortSignal,
        started = false,
    ): Promise<boolean> {
        if (!started) {
            // A navigation a click starts begins a moment later.
            await wait(150);

            if (this.#starts === mark.starts) {
                return true;
            }
        }

        if (this.#stops > mark.stops && !this.#loading) {
            return true;
        }

        return new Promise((done) => {
            const finish = (ok: boolean) => {
                clearTimeout(timer);
                signal?.removeEventListener("abort", stop);
                this.#stopWaiters.delete(wake);
                done(ok);
            };

            const wake = () => finish(true);
            const stop = () => finish(false);
            const timer = setTimeout(stop, timeoutMs);

            signal?.addEventListener("abort", stop, { once: true });
            this.#stopWaiters.add(wake);
        });
    }

    /**
     * Open an address. With `wait`, until it has loaded (or `timeoutMs` passed); without, only as long as it takes to
     * hear whether it failed at once (nothing answers there), at most a few seconds. The result says how it went.
     */
    async navigate(
        url: string,
        options: { wait?: boolean; timeoutMs?: number; signal?: AbortSignal } = {},
    ): Promise<{ error?: string; status?: number; slow?: boolean }> {
        this.usedAt = Date.now();
        const mark = this.#mark();
        const budget = options.wait === false ? 3000 : (options.timeoutMs ?? 30_000);
        // The browser answers once the page starts to arrive: a server that never responds keeps it waiting, while the
        // navigation goes on.
        const answer = this.#send("Page.navigate", { url }, 120_000);

        answer.catch(() => {});
        let timer: NodeJS.Timeout | undefined;
        const late = new Promise<undefined>((done) => {
            timer = setTimeout(() => done(undefined), budget);
        });
        const result = await Promise.race([answer, late]).finally(() => clearTimeout(timer));

        if (result === undefined) {
            return options.wait === false ? {} : { slow: true };
        }

        if (result.errorText) {
            return { error: String(result.errorText) };
        }

        if (options.wait === false || result.loaderId === undefined) {
            return {};
        }

        const loaded = await this.#settle(mark, options.timeoutMs ?? 30_000, options.signal, true);

        aborted(options.signal);
        // Apps fetch their data after the load event; give them a moment.
        await wait(300);
        const status = await this.#send("Runtime.evaluate", {
            expression: `performance.getEntriesByType("navigation")[0]?.responseStatus ?? 0`,
            returnByValue: true,
        }).then(evaluated, () => 0);

        return {
            ...(typeof status === "number" && status > 0 ? { status } : {}),
            ...(loaded ? {} : { slow: true }),
        };
    }

    async go(
        delta: -1 | 1,
        options: { wait?: boolean; signal?: AbortSignal } = {},
    ): Promise<boolean> {
        this.usedAt = Date.now();
        const history = await this.#send("Page.getNavigationHistory");
        const entry = history.entries?.[history.currentIndex + delta];

        if (entry === undefined) {
            return false;
        }

        const mark = this.#mark();

        await this.#send("Page.navigateToHistoryEntry", { entryId: entry.id });

        if (options.wait !== false) {
            await this.#settle(mark, 30_000, options.signal);
        }

        return true;
    }

    async reload(options: { wait?: boolean; signal?: AbortSignal } = {}): Promise<void> {
        this.usedAt = Date.now();
        this.#crashed = false;
        const mark = this.#mark();

        await this.#send("Page.reload", { ignoreCache: false });

        if (options.wait !== false) {
            await this.#settle(mark, 30_000, options.signal, true);
        }
    }

    async stop(): Promise<void> {
        await this.#send("Page.stopLoading");
    }

    async #applyViewport(): Promise<void> {
        const viewport = this.#viewport;
        const agent = viewport.mobile
            ? `Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${/Chrome\/([\d.]+)/.exec(this.#baseAgent)?.[1] ?? "130.0.0.0"} Mobile Safari/537.36`
            : this.#baseAgent;

        await Promise.all([
            this.#send("Emulation.setDeviceMetricsOverride", {
                width: viewport.width,
                height: viewport.height,
                deviceScaleFactor: viewport.scale,
                mobile: viewport.mobile,
            }),
            this.#send("Emulation.setTouchEmulationEnabled", {
                enabled: viewport.mobile,
                maxTouchPoints: viewport.mobile ? 5 : 1,
            }),
            agent === ""
                ? Promise.resolve()
                : this.#send("Emulation.setUserAgentOverride", { userAgent: agent }),
        ]);
    }

    async setViewport(viewport: Viewport): Promise<void> {
        this.usedAt = Date.now();
        this.#viewport = { ...viewport };
        await this.#applyViewport();

        if (this.#casting) {
            await this.#stopCast();
            await this.#startCast();
        }

        this.#changed();
        this.#save();
    }

    // ─── What Pi does ─────────────────────────────────────────────────────────

    async #evaluate(expression: string, timeoutMs = 15_000): Promise<Json> {
        return evaluated(
            await this.#send(
                "Runtime.evaluate",
                { expression, returnByValue: true, awaitPromise: true, userGesture: true },
                timeoutMs,
            ),
        );
    }

    /** Where a target is on screen, scrolled into view. */
    async locate(
        target: Target,
    ): Promise<{ x: number; y: number; label: string; covered?: string; editable?: boolean }> {
        if (typeof target.x === "number" && typeof target.y === "number") {
            return {
                x: target.x,
                y: target.y,
                label: `the point ${Math.round(target.x)},${Math.round(target.y)}`,
            };
        }

        if (
            target.ref === undefined &&
            target.selector === undefined &&
            target.label === undefined
        ) {
            throw new BrowserError(
                "Say what to act on: a ref from the snapshot, a selector, a label, or x and y.",
            );
        }

        return await this.#evaluate(`(${LOCATE_SCRIPT})(${JSON.stringify(target)})`);
    }

    async click(
        target: Target,
        options: { count?: number; signal?: AbortSignal } = {},
    ): Promise<{ label: string; covered?: string; navigated: boolean }> {
        this.usedAt = Date.now();
        const found = await this.locate(target);
        const url = this.#url;
        const mark = this.#mark();

        await this.#click({ x: found.x, y: found.y }, "left", options.count ?? 1);
        await this.#settle(mark, 10_000, options.signal);

        return {
            label: found.label,
            ...(found.covered === undefined ? {} : { covered: found.covered }),
            navigated: this.#url !== url,
        };
    }

    async hover(target: Target): Promise<string> {
        this.usedAt = Date.now();
        const found = await this.locate(target);

        await this.#send("Input.dispatchMouseEvent", {
            type: "mouseMoved",
            x: found.x,
            y: found.y,
            button: "none",
        });
        await wait(150);

        return found.label;
    }

    /** Type into a target (clicking it first), or into what has focus. Replaces what the field holds unless `append`. */
    async type(
        target: Target | undefined,
        text: string,
        options: { append?: boolean; submit?: boolean; signal?: AbortSignal } = {},
    ): Promise<string> {
        this.usedAt = Date.now();
        let label = "the focused element";

        if (
            target !== undefined &&
            (target.ref ?? target.selector ?? target.label ?? target.x) !== undefined
        ) {
            const found = await this.locate(target);

            await this.#click({ x: found.x, y: found.y }, "left", 1);
            label = found.label;
        }

        if (options.append !== true) {
            const field = await this.#evaluate(SELECT_ALL_SCRIPT);

            // Some fields (email, number) cannot be selected by script: the editor's select-all works on them.
            if (field === "keys") {
                await this.#key("a", 2);
            }

            if ((field === "selected" || field === "keys") && text === "") {
                await this.#key("Backspace", 0);
            }
        }

        if (text !== "") {
            await this.#send("Input.insertText", { text });
        }

        if (options.submit === true) {
            const mark = this.#mark();

            await this.#key("Enter", 0);
            await this.#settle(mark, 10_000, options.signal);
        }

        return label;
    }

    async press(combo: string, options: { signal?: AbortSignal } = {}): Promise<void> {
        this.usedAt = Date.now();
        const { key, modifiers } = parseKeys(combo);
        const mark = this.#mark();

        await this.#key(key, modifiers);
        await this.#settle(mark, 10_000, options.signal);
    }

    async select(target: Target, value: string): Promise<string> {
        this.usedAt = Date.now();

        return String(
            await this.#evaluate(
                `(${SELECT_OPTION_SCRIPT})(${JSON.stringify(target)}, ${JSON.stringify(value)})`,
            ),
        );
    }

    /** Scroll a target into view, or the page by `dy` pixels (a screen down by default). */
    async scroll(target: Target | undefined, dy?: number): Promise<string> {
        this.usedAt = Date.now();

        if (target !== undefined && (target.ref ?? target.selector ?? target.label) !== undefined) {
            return (await this.locate(target)).label;
        }

        const amount = dy ?? Math.round(this.#viewport.height * 0.8);

        await this.#send("Input.dispatchMouseEvent", {
            type: "mouseWheel",
            x: this.#viewport.width / 2,
            y: this.#viewport.height / 2,
            deltaX: 0,
            deltaY: amount,
        });
        await wait(250);

        return `${amount >= 0 ? "down" : "up"} ${Math.abs(amount)}px`;
    }

    async snapshot(): Promise<{
        lines: string;
        truncated: boolean;
        controls: number;
        scrollY: number;
        scrollHeight: number;
        innerHeight: number;
    }> {
        this.usedAt = Date.now();

        return await this.#evaluate(SNAPSHOT_SCRIPT, 20_000);
    }

    /**
     * A JPEG of the viewport, or of the whole page (up to 8000 CSS pixels tall). The size it reports is in CSS pixels;
     * the image itself is at most `SHOT_MAX` pixels on its longer side (`shrunk` when that made it smaller).
     */
    async screenshot(
        options: { fullPage?: boolean } = {},
    ): Promise<{ data: string; width: number; height: number; shrunk: boolean }> {
        this.usedAt = Date.now();
        const scale = 1 / this.#viewport.scale;

        if (options.fullPage === true) {
            const metrics = await this.#send("Page.getLayoutMetrics");
            const size = metrics.cssContentSize ?? metrics.contentSize;
            const width = Math.ceil(size.width);
            const height = Math.min(Math.ceil(size.height), 8000);
            const shot = await this.#send(
                "Page.captureScreenshot",
                {
                    format: "jpeg",
                    quality: 80,
                    captureBeyondViewport: true,
                    clip: { x: 0, y: 0, width, height, scale: scale * fit(width, height) },
                },
                60_000,
            );

            return { data: String(shot.data), width, height, shrunk: fit(width, height) < 1 };
        }

        const metrics = await this.#send("Page.getLayoutMetrics");
        const view = metrics.cssVisualViewport ?? {
            pageX: 0,
            pageY: 0,
            clientWidth: this.#viewport.width,
            clientHeight: this.#viewport.height,
            scale: 1,
        };
        const zoom = view.scale ?? 1;
        const shot = await this.#send(
            "Page.captureScreenshot",
            {
                format: "jpeg",
                quality: 80,
                clip: {
                    x: view.pageX,
                    y: view.pageY,
                    width: view.clientWidth,
                    height: view.clientHeight,
                    scale: scale * zoom * fit(view.clientWidth, view.clientHeight),
                },
            },
            60_000,
        );

        return {
            data: String(shot.data),
            width: this.#viewport.width,
            height: this.#viewport.height,
            shrunk: fit(view.clientWidth, view.clientHeight) < 1,
        };
    }

    /** Run JavaScript in the page: an expression or statements (top-level await works), or a body that uses `return`. */
    async evaluate(script: string, options: { timeoutMs?: number } = {}): Promise<string> {
        this.usedAt = Date.now();
        const run = (expression: string, replMode: boolean) =>
            this.#send(
                "Runtime.evaluate",
                {
                    expression,
                    replMode,
                    awaitPromise: true,
                    userGesture: true,
                    objectGroup: "pi-pocket",
                    generatePreview: false,
                    timeout: options.timeoutMs ?? 30_000,
                },
                (options.timeoutMs ?? 30_000) + 5000,
            );
        // REPL mode, as in DevTools' console: top-level await works and names can be declared again. A body that returns
        // its result is not a script there; it runs as a function, outside REPL mode, which would not await its promise.
        let response = await run(script, true);

        if (
            /Illegal return statement/.test(
                String(response.exceptionDetails?.exception?.description ?? ""),
            )
        ) {
            response = await run(`(async () => {\n${script}\n})()`, false);
        }

        try {
            if (response.exceptionDetails !== undefined) {
                evaluated(response);
            }

            const result = response.result ?? {};

            if (result.type === "undefined") {
                return "undefined";
            }

            if (result.objectId === undefined) {
                if (result.unserializableValue !== undefined) {
                    return String(result.unserializableValue);
                }

                return typeof result.value === "string"
                    ? result.value
                    : JSON.stringify(result.value);
            }

            const described = await this.#send("Runtime.callFunctionOn", {
                objectId: result.objectId,
                functionDeclaration: DESCRIBE_FUNCTION,
                returnByValue: true,
            });

            return String(described.result?.value ?? result.description ?? "");
        } finally {
            void this.#send("Runtime.releaseObjectGroup", { objectGroup: "pi-pocket" }).catch(
                () => {},
            );
        }
    }

    /** Wait for text or an element to show up, or a number of milliseconds. */
    async waitFor(options: {
        text?: string;
        selector?: string;
        ms?: number;
        timeoutMs?: number;
        signal?: AbortSignal;
    }): Promise<boolean> {
        this.usedAt = Date.now();

        if (options.text === undefined && options.selector === undefined) {
            await wait(clamp(options.ms ?? 1000, 0, 30_000));

            return true;
        }

        const check =
            options.selector !== undefined
                ? `(() => { const el = document.querySelector(${JSON.stringify(options.selector)}); return !!el && el.getClientRects().length > 0; })()`
                : `(document.body?.innerText ?? "").toLowerCase().includes(${JSON.stringify(options.text!.toLowerCase())})`;
        const until = Date.now() + clamp(options.timeoutMs ?? 10_000, 0, 60_000);

        while (true) {
            aborted(options.signal);

            if ((await this.#evaluate(check).catch(() => false)) === true) {
                return true;
            }

            if (Date.now() >= until) {
                return false;
            }

            await wait(200);
        }
    }

    /** Console lines after `after` (all of them by default). */
    logs(after = 0): LogEntry[] {
        return this.#logs.filter((entry) => entry.seq > after);
    }

    get logSeq(): number {
        return this.#logSeq;
    }

    clearLogs(): void {
        this.#logs = [];
        this.#errors = 0;
        // Counted as a change, so the panel fetches the (empty) console again.
        this.#logSeq++;
        this.#changed();
    }

    close(): void {
        if (this.#closed) {
            return;
        }

        this.#closed = true;
        this.#casting = false;
        clearInterval(this.#castTimer);
        clearTimeout(this.#historyTimer);
        clearTimeout(this.#saveTimer);

        for (const timer of this.#popups.values()) {
            clearTimeout(timer);
        }

        for (const wake of this.#frameWaiters) {
            wake();
        }

        for (const wake of this.#stopWaiters) {
            wake();
        }

        this.#connection.unlisten(this.#session);
        this.#changed();
    }
}
