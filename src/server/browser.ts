/**
 * The built-in browser: one headless Chromium on this machine, driven over the DevTools protocol through a pipe, with a
 * page per conversation that Pi (the `browser` tool) and the people in the conversation (the Browser panel) share.
 * People see the page as a stream of JPEG frames and send it taps, scrolls, and keys. The page runs on this machine, not
 * in their own browser: it does not share their app tab or its cookies, and pages only this machine can reach (a dev
 * server on localhost) work from a phone too.
 *
 * Each conversation's page lives in a browser context of its own: cookies and storage are not shared between
 * conversations. Pages are memory only: a restart closes them, and each conversation's last address and size come back
 * from its saved state when its page is next opened.
 */
import type { Readable, Writable } from "node:stream";
import { BrowserError, Chromium, LAUNCH_ARGS } from "./browser/cdp.ts";
import { findBrowser, profileFolder } from "./browser/discovery.ts";
import { BrowserPage, type BrowserState, type Saved, wait } from "./browser/page.ts";
import { type Viewport, VIEWPORTS, viewportFrom } from "./browser/viewport.ts";
import { describe } from "./errors.ts";

export type OpenOptions = {
    /** The size of a page that has no saved size. */
    viewport?: Viewport;
    /** Open the saved address again (default), or (false) start blank. */
    restore?: boolean;
    /** Wait for the saved address to load (default), or (false) only start loading it. */
    wait?: boolean;
};

/**
 * A Chromium that a sandbox runs for a session, in its VM, instead of one on this machine: sandboxed sessions never use
 * the host's browser. The sessions that share a VM share the browser, and keep their pages apart in contexts as ever.
 */
export interface RemoteBrowser {
    /** Names the browser (its VM): conversations with the same key share one Chromium. */
    readonly key: string;
    /** Why this sandbox has no browser, or undefined when one can start. */
    problem(): string | undefined;
    /**
     * Start the browser with the flags Pi Pocket gives every browser (`flags`: headless, DevTools over a pipe, and the
     * rest), and give the pipe it speaks the DevTools protocol over.
     */
    launch(flags: readonly string[]): Promise<{
        input: Readable;
        output: Writable;
        stop(): void;
        exited: Promise<void>;
    }>;
}

export interface BrowsersOptions {
    /** The browser that runs in a conversation's sandbox, or undefined when its session is not sandboxed. */
    remote?(conversationId: number): RemoteBrowser | undefined;
    /** Where the browser's profile goes: `browser/` in it. */
    dataDir: string;
    /** The browser to run. Undefined finds one; null means there is none (tests). */
    executable?: string | null;
    /** Extra Chromium flags, such as `--no-sandbox` where sandboxes are not available. */
    args?: readonly string[];
    /** A conversation's saved address and size, to open its page again. */
    load?(conversationId: number): Promise<Saved | undefined>;
    /** Called when a page's address or size changed. */
    save?(conversationId: number, saved: Saved): void;
    log?(line: string): void;
    /** A page nobody used or watched for this long closes. */
    idleMs?: number;
}

/**
 * The browser and every conversation's page. The browser starts with the first page and stops a while after the last
 * one closes; pages close after a while unused.
 */
export class Browsers {
    readonly #options: BrowsersOptions;
    #executable: string | null | undefined;
    #chromium: Promise<Chromium> | undefined;
    /** Sandboxes' browsers, by `RemoteBrowser.key`. */
    readonly #remotes = new Map<string, Promise<Chromium>>();
    /** Which browser each open page is in: a remote's key, or none for this machine's. */
    readonly #hosts = new Map<number, string>();
    /** When the last page of each remote browser closed. */
    readonly #remoteIdle = new Map<string, number>();
    readonly #pages = new Map<number, BrowserPage>();
    readonly #opening = new Map<number, Promise<BrowserPage>>();
    readonly #listeners = new Set<(conversationId: number, state: BrowserState) => void>();
    readonly #pending = new Map<number, NodeJS.Timeout>();
    readonly #problems = new Map<number, string>();
    readonly #reaper: NodeJS.Timeout;
    #idleSince = Date.now();
    #closing = false;
    /** Counts every closeAll: a page that began opening before one must not open after it. */
    #generation = 0;

    constructor(options: BrowsersOptions) {
        this.#options = options;
        this.#executable = options.executable;
        this.#reaper = setInterval(() => this.#reap(), 60_000);
        this.#reaper.unref();
    }

    /** The browser this machine has, if any. Looked up once. */
    get executable(): string | undefined {
        if (this.#executable === undefined) {
            this.#executable = findBrowser() ?? null;
        }

        return this.#executable ?? undefined;
    }

    get available(): boolean {
        return this.executable !== undefined;
    }

    /** Whether this conversation can have a browser: a sandboxed one asks its sandbox, never this machine. */
    #availableFor(conversationId: number): boolean {
        const remote = this.#options.remote?.(conversationId);

        return remote === undefined ? this.available : remote.problem() === undefined;
    }

    subscribe(listener: (conversationId: number, state: BrowserState) => void): () => void {
        this.#listeners.add(listener);

        return () => this.#listeners.delete(listener);
    }

    /** A conversation's page as it is now; a closed one has no address. */
    state(conversationId: number): BrowserState {
        const page = this.page(conversationId);

        if (page !== undefined) {
            return page.state(this.#availableFor(conversationId));
        }

        const problem =
            this.#options.remote?.(conversationId)?.problem() ?? this.#problems.get(conversationId);

        return {
            available: this.#availableFor(conversationId),
            open: false,
            url: "",
            title: "",
            loading: this.#opening.has(conversationId),
            viewport: { ...VIEWPORTS.desktop },
            preset: "desktop",
            canGoBack: false,
            canGoForward: false,
            errors: 0,
            logs: 0,
            ...(problem === undefined ? {} : { problem }),
        };
    }

    /** The conversation's page if it is open. */
    page(conversationId: number): BrowserPage | undefined {
        const page = this.#pages.get(conversationId);

        if (page === undefined || page.closed) {
            return undefined;
        }

        // A session that went into a sandbox since this page opened must not keep a page of this machine's browser,
        // nor one that left it a page of the sandbox's.
        if (
            (this.#hosts.get(conversationId) ?? "") !==
            (this.#options.remote?.(conversationId)?.key ?? "")
        ) {
            void this.#discard(conversationId, page);

            return undefined;
        }

        return page;
    }

    /** Coalesce a page's changes: frames of logs and loads arrive in bursts. */
    #changed(conversationId: number): void {
        if (this.#pending.has(conversationId)) {
            return;
        }

        const timer = setTimeout(() => {
            this.#pending.delete(conversationId);
            const state = this.state(conversationId);

            for (const listener of this.#listeners) {
                listener(conversationId, state);
            }
        }, 120);

        timer.unref();
        this.#pending.set(conversationId, timer);
    }

    async #browser(): Promise<Chromium> {
        const executable = this.executable;

        if (executable === undefined) {
            throw new BrowserError(
                "No Chromium-based browser was found on this machine. Install Chromium or Google Chrome, or set PI_POCKET_BROWSER to a browser's path.",
            );
        }

        if (this.#chromium !== undefined) {
            const running = await this.#chromium.catch(() => undefined);

            if (running !== undefined && !running.connection.closed) {
                return running;
            }
        }

        if (this.#closing) {
            throw new BrowserError("The server is stopping.");
        }

        const extra = [
            ...(this.#options.args ?? []),
            ...(process.env.PI_POCKET_BROWSER_ARGS?.split(/\s+/).filter(Boolean) ?? []),
        ];
        const launching = Chromium.launch(
            executable,
            profileFolder(executable, this.#options.dataDir),
            extra,
        );

        this.#chromium = launching;
        launching.catch(() => {
            if (this.#chromium === launching) {
                this.#chromium = undefined;
            }
        });
        const chromium = await launching;

        // The server began stopping while the browser started: nothing will stop this one later.
        if (this.#closing) {
            chromium.kill();

            throw new BrowserError("The server is stopping.");
        }

        this.#options.log?.(`Browser started: ${executable}`);

        this.#wire(chromium, "", () => {
            if (this.#chromium === launching) {
                this.#chromium = undefined;
            }
        });

        return chromium;
    }

    /** Hear a Chromium's targets for the pages that are in it (`key`: a remote's, "" for this machine's). */
    #wire(chromium: Chromium, key: string, closed: () => void): void {
        chromium.connection.onEvent = (method, params) => {
            if (!method.startsWith("Target.")) {
                return;
            }

            const info =
                params.targetInfo ??
                (method === "Target.targetDestroyed" ? { targetId: params.targetId } : undefined);

            if (info === undefined) {
                return;
            }

            for (const [id, page] of this.#pages) {
                if ((this.#hosts.get(id) ?? "") !== key) {
                    continue;
                }

                // A page closed by its own script (window.close()) is gone, with its browser context.
                if (method === "Target.targetDestroyed" && info.targetId === page.targetId) {
                    void this.#discard(id, page);
                } else {
                    page.targetEvent(method, info);
                }
            }
        };

        chromium.connection.onClose = () => {
            closed();

            for (const [id, page] of this.#pages) {
                if ((this.#hosts.get(id) ?? "") === key) {
                    page.close();
                }
            }
        };
    }

    /** A sandbox's browser: started in its VM the first time a page needs it, and found again while it runs. */
    async #remoteBrowser(remote: RemoteBrowser): Promise<Chromium> {
        const problem = remote.problem();

        if (problem !== undefined) {
            throw new BrowserError(problem);
        }

        const existing = this.#remotes.get(remote.key);

        if (existing !== undefined) {
            const running = await existing.catch(() => undefined);

            if (running !== undefined && !running.connection.closed) {
                return running;
            }
        }

        if (this.#closing) {
            throw new BrowserError("The server is stopping.");
        }

        const launching = (async () => {
            const link = await remote.launch(LAUNCH_ARGS);

            return Chromium.attach(link.input, link.output, link.stop, link.exited, "chromium");
        })();

        this.#remotes.set(remote.key, launching);
        launching.catch(() => {
            if (this.#remotes.get(remote.key) === launching) {
                this.#remotes.delete(remote.key);
            }
        });
        const chromium = await launching;

        if (this.#closing) {
            chromium.kill();

            throw new BrowserError("The server is stopping.");
        }

        this.#options.log?.(`Browser started in a sandbox: ${remote.key}`);
        this.#wire(chromium, remote.key, () => {
            if (this.#remotes.get(remote.key) === launching) {
                this.#remotes.delete(remote.key);
            }
        });

        return chromium;
    }

    /** The browser a conversation's page runs in: its sandbox's, or this machine's. */
    async #browserFor(conversationId: number): Promise<{ chromium: Chromium; key: string }> {
        const remote = this.#options.remote?.(conversationId);

        return remote === undefined
            ? { chromium: await this.#browser(), key: "" }
            : { chromium: await this.#remoteBrowser(remote), key: remote.key };
    }

    /**
     * The conversation's page, opened (and its saved address loaded again) if it was not. `viewport` sizes a page that
     * has no saved size.
     */
    async open(conversationId: number, options: OpenOptions = {}): Promise<BrowserPage> {
        if (this.#closing) {
            throw new BrowserError("The server is stopping.");
        }

        const open = this.page(conversationId);

        if (open !== undefined) {
            return open;
        }

        const opening = this.#opening.get(conversationId);

        if (opening !== undefined) {
            return opening;
        }

        const created = this.#create(conversationId, options);

        this.#opening.set(conversationId, created);
        this.#changed(conversationId);

        try {
            const page = await created;

            this.#problems.delete(conversationId);

            return page;
        } catch (error) {
            this.#problems.set(conversationId, describe(error));

            throw error;
        } finally {
            this.#opening.delete(conversationId);
            this.#changed(conversationId);
        }
    }

    async #create(conversationId: number, options: OpenOptions): Promise<BrowserPage> {
        const generation = this.#generation;
        const stale = () => this.#closing || this.#generation !== generation;
        const saved = await this.#options.load?.(conversationId).catch(() => undefined);

        if (stale()) {
            throw new BrowserError("The browser was closed.");
        }

        const { chromium, key } = await this.#browserFor(conversationId);
        const connection = chromium.connection;
        const { browserContextId } = await connection.send("Target.createBrowserContext", {
            disposeOnDetach: false,
        });
        let page: BrowserPage | undefined;

        try {
            await connection
                .send("Browser.setDownloadBehavior", { behavior: "deny", browserContextId })
                .catch(() => {});
            const { targetId } = await connection.send("Target.createTarget", {
                url: "about:blank",
                browserContextId,
            });
            const { sessionId } = await connection.send("Target.attachToTarget", {
                targetId,
                flatten: true,
            });

            page = new BrowserPage({
                conversationId,
                connection,
                session: sessionId,
                target: targetId,
                context: browserContextId,
                userAgent: chromium.userAgent,
                brand: { name: chromium.brand, version: chromium.version },
                viewport: viewportFrom(saved?.viewport) ??
                    options.viewport ?? { ...VIEWPORTS.desktop },
                changed: () => this.#changed(conversationId),
                saved: (value) => this.#options.save?.(conversationId, value),
            });
            await page.init();

            if (stale()) {
                page.close();

                throw new BrowserError("The browser was closed.");
            }

            this.#pages.set(conversationId, page);
            this.#hosts.set(conversationId, key);
            this.#remoteIdle.delete(key);
            this.#idleSince = Date.now();

            if (options.restore !== false && saved?.url !== undefined && saved.url !== "") {
                const restoring = page.navigate(saved.url, { timeoutMs: 15_000 }).catch(() => {});

                if (options.wait !== false) {
                    await restoring;
                }
            }

            return page;
        } catch (error) {
            page?.close();
            void connection
                .send("Target.disposeBrowserContext", { browserContextId })
                .catch(() => {});

            throw error;
        }
    }

    /** Close a conversation's page. Its saved address stays, to open it again later. */
    async close(conversationId: number): Promise<void> {
        const page = this.#pages.get(conversationId);

        if (page !== undefined) {
            await this.#discard(conversationId, page);
        }
    }

    /** Forget a page and free its browser context, which holds its cookies and storage. */
    async #discard(conversationId: number, page: BrowserPage): Promise<void> {
        if (this.#pages.get(conversationId) === page) {
            this.#pages.delete(conversationId);
        }

        page.close();
        const key = this.#hosts.get(conversationId) ?? "";

        this.#hosts.delete(conversationId);

        if (this.#pages.size === 0) {
            this.#idleSince = Date.now();
        }

        if (key !== "" && ![...this.#hosts.values()].includes(key)) {
            this.#remoteIdle.set(key, Date.now());
        }

        this.#changed(conversationId);
        const chromium = await (key === "" ? this.#chromium : this.#remotes.get(key))?.catch(
            () => undefined,
        );

        await chromium?.connection
            .send("Target.disposeBrowserContext", { browserContextId: page.contextId })
            .catch(() => {});
    }

    #reap(): void {
        const idle = this.#options.idleMs ?? 30 * 60_000;

        for (const [id, page] of this.#pages) {
            if (page.closed || Date.now() - page.usedAt > idle) {
                void this.#discard(id, page);
            }
        }

        // A sandbox's browser stops a few minutes after its last page closed: it holds memory in the VM.
        for (const [key, since] of this.#remoteIdle) {
            if (Date.now() - since > 5 * 60_000 && ![...this.#hosts.values()].includes(key)) {
                this.#remoteIdle.delete(key);
                void this.#stopRemote(key);
            }
        }

        // The browser itself stops a few minutes after its last page closed.
        if (
            this.#pages.size === 0 &&
            this.#opening.size === 0 &&
            this.#chromium !== undefined &&
            Date.now() - this.#idleSince > 5 * 60_000
        ) {
            void this.#stopBrowser();
        }
    }

    async #stopRemote(key: string): Promise<void> {
        const pending = this.#remotes.get(key);

        this.#remotes.delete(key);
        const chromium = await pending?.catch(() => undefined);

        if (chromium !== undefined) {
            chromium.kill();
            await Promise.race([chromium.exited, wait(4000)]);
        }
    }

    /** Close the pages of a sandbox's browser and stop it: its VM is going away. */
    async closeRemote(key: string): Promise<void> {
        for (const [id, page] of [...this.#pages]) {
            if (this.#hosts.get(id) === key) {
                await this.#discard(id, page);
            }
        }

        await this.#stopRemote(key);
    }

    async #stopBrowser(): Promise<void> {
        const pending = this.#chromium;

        this.#chromium = undefined;
        const chromium = await pending?.catch(() => undefined);

        if (chromium === undefined) {
            return;
        }

        chromium.kill();
        await Promise.race([chromium.exited, wait(4000)]);
    }

    /** Close every page and stop the browser, as the server stops or the browser is turned off. */
    async closeAll(options: { final?: boolean } = {}): Promise<void> {
        this.#generation++;

        if (options.final === true) {
            this.#closing = true;
            clearInterval(this.#reaper);
        }

        const ids = [...this.#pages.keys()];

        for (const page of this.#pages.values()) {
            page.close();
        }

        this.#pages.clear();
        this.#hosts.clear();

        if (options.final === true) {
            // After the pages closed, which announces them: nobody listens any more.
            for (const timer of this.#pending.values()) {
                clearTimeout(timer);
            }

            this.#pending.clear();
        }

        await Promise.all([
            this.#stopBrowser(),
            ...[...this.#remotes.keys()].map((key) => this.#stopRemote(key)),
        ]);

        if (options.final !== true) {
            for (const id of ids) {
                this.#changed(id);
            }
        }
    }
}
