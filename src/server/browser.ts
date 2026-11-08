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
 *
 * Sessions on another computer get their pages in a second Chromium, started when one of them first needs it, whose
 * pages load through that computer (`browser/proxy.ts`): each context's own proxy credentials name its computer, and
 * the browser's own proxy refuses everything else, so nothing these pages load leaves from this server. Downloads go
 * where the session works (`browser/downloads.ts`).
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { BrowserError, Chromium, type Connection } from "./browser/cdp.ts";
import { findBrowser, profileFolder } from "./browser/discovery.ts";
import {
    type Computer,
    copyToComputer,
    Downloads,
    moveToFolder,
    privateFolder,
} from "./browser/downloads.ts";
import { BrowserPage, type BrowserState, type Saved, wait } from "./browser/page.ts";
import { BrowserProxy, type Connect, PRIME_HOST } from "./browser/proxy.ts";
import { type Viewport, VIEWPORTS, viewportFrom } from "./browser/viewport.ts";
import { describe } from "./errors.ts";

/**
 * Flags of the browser for sessions on another computer, after the usual ones: every request goes to a proxy (the
 * refusing one, unless its context has its own), loopback too; WebRTC sends no UDP around the proxy; no QUIC.
 */
function remoteArgs(denyPort: number): string[] {
    return [
        `--proxy-server=http://127.0.0.1:${denyPort}`,
        "--proxy-bypass-list=<-loopback>",
        "--webrtc-ip-handling-policy=disable_non_proxied_udp",
        "--disable-quic",
    ];
}

/** Where sessions on other computers run, for the browser: their pages load there, and downloads go there. */
export type RemoteBrowsing = {
    /** The computer a conversation's session runs on; undefined: this server. */
    runnerOf(conversationId: number): string | undefined;
    /** A computer's name, for what the browser tool says. */
    name(runner: string): string;
    /** Open a connection from the computer (`RunnerLink.openNetwork`). */
    connect: Connect;
    /** The computer's environment and temporary folder, to copy downloads to. */
    computer(runner: string, conversationId?: number): Promise<Computer>;
};

type Kind = "local" | "remote";

/** A page's browser context, and what this server keeps for it. */
type ContextInfo = { kind: Kind; incoming: string; proxyKey?: string };

export type OpenOptions = {
    /** The size of a page that has no saved size. */
    viewport?: Viewport;
    /** Open the saved address again (default), or (false) start blank. */
    restore?: boolean;
    /** Wait for the saved address to load (default), or (false) only start loading it. */
    wait?: boolean;
};

export interface BrowsersOptions {
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
    /** Sessions on other computers; without it, every page is this server's. */
    remote?: RemoteBrowsing;
}

/**
 * The browser and every conversation's page. The browser starts with the first page and stops a while after the last
 * one closes; pages close after a while unused.
 */
export class Browsers {
    readonly #options: BrowsersOptions;
    #executable: string | null | undefined;
    readonly #chromium: Record<Kind, Promise<Chromium> | undefined> = {
        local: undefined,
        remote: undefined,
    };
    readonly #pages = new Map<number, BrowserPage>();
    readonly #contexts = new Map<number, ContextInfo>();
    /** The proxy of sessions on other computers, made when the first of them opens a page. */
    #proxy: BrowserProxy | undefined;
    readonly downloads: Downloads;
    readonly #opening = new Map<number, Promise<BrowserPage>>();
    readonly #listeners = new Set<(conversationId: number, state: BrowserState) => void>();
    readonly #pending = new Map<number, NodeJS.Timeout>();
    readonly #problems = new Map<number, string>();
    readonly #reaper: NodeJS.Timeout;
    readonly #idleSince: Record<Kind, number> = { local: Date.now(), remote: Date.now() };
    #closing = false;
    /** Counts every closeAll: a page that began opening before one must not open after it. */
    #generation = 0;

    constructor(options: BrowsersOptions) {
        this.#options = options;
        this.#executable = options.executable;
        this.#reaper = setInterval(() => this.#reap(), 60_000);
        this.#reaper.unref();
        this.downloads = new Downloads({
            place: (conversationId, file, name) => this.#place(conversationId, file, name),
            cancel: (guid, context) => {
                for (const kind of ["local", "remote"] as const) {
                    void this.#chromium[kind]
                        ?.then((chromium) =>
                            chromium.connection.send("Browser.cancelDownload", {
                                guid,
                                browserContextId: context,
                            }),
                        )
                        .catch(() => {});
                }
            },
            ...(options.log === undefined ? {} : { log: options.log }),
        });
        // Downloads a stopped server left behind: none may stay.
        rmSync(this.#incomingRoot, { recursive: true, force: true });
    }

    /** Where Chromium saves downloads while they arrive, a folder per browser context. */
    get #incomingRoot(): string {
        return join(this.#options.dataDir, "browser", "incoming");
    }

    /** The port of the proxy of sessions on other computers, once it listens; for tests. */
    get proxyPort(): number | undefined {
        return this.#proxy?.port || undefined;
    }

    /** The name of the computer a conversation's session runs on; undefined for this server. */
    computerOf(conversationId: number): string | undefined {
        const runner = this.#options.remote?.runnerOf(conversationId);

        return runner === undefined ? undefined : this.#options.remote!.name(runner);
    }

    /** Why the computer last failed a connection of this conversation's page, since `since` (ms). */
    networkProblem(conversationId: number, since: number): string | undefined {
        const key = this.#contexts.get(conversationId)?.proxyKey;

        // Without its last period: the browser tool ends its sentences itself.
        return key === undefined ? undefined : this.#proxy?.problem(key, since)?.replace(/\.$/, "");
    }

    /** A finished download, where its session works: this server's private folder, or the computer's folder. */
    async #place(conversationId: number, file: string, name: string): Promise<string> {
        const runner = this.#options.remote?.runnerOf(conversationId);

        if (runner === undefined) {
            return moveToFolder(file, join(await privateFolder(), String(conversationId)), name);
        }

        const computer = await this.#options.remote!.computer(runner, conversationId);

        return copyToComputer(computer, file, name);
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

    subscribe(listener: (conversationId: number, state: BrowserState) => void): () => void {
        this.#listeners.add(listener);

        return () => this.#listeners.delete(listener);
    }

    /** A conversation's page as it is now; a closed one has no address. */
    state(conversationId: number): BrowserState {
        const page = this.#pages.get(conversationId);

        if (page !== undefined && !page.closed) {
            return page.state(this.available);
        }

        const problem = this.#problems.get(conversationId);

        return {
            available: this.available,
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

        return page === undefined || page.closed ? undefined : page;
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

    async #browser(kind: Kind): Promise<Chromium> {
        const executable = this.executable;

        if (executable === undefined) {
            throw new BrowserError(
                "No Chromium-based browser was found on this machine. Install Chromium or Google Chrome, or set PI_POCKET_BROWSER to a browser's path.",
            );
        }

        if (this.#chromium[kind] !== undefined) {
            const running = await this.#chromium[kind].catch(() => undefined);

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
        const profile = profileFolder(executable, this.#options.dataDir);
        const launching =
            kind === "local"
                ? Chromium.launch(executable, profile, extra)
                : this.#startProxy().then((proxy) =>
                      // Its flags last: they win over the same ones in `extra`.
                      Chromium.launch(executable, `${profile}-remote`, [
                          ...extra,
                          ...remoteArgs(proxy.denyPort),
                      ]),
                  );

        this.#chromium[kind] = launching;
        launching.catch(() => {
            if (this.#chromium[kind] === launching) {
                this.#chromium[kind] = undefined;
            }
        });
        const chromium = await launching;

        // The server began stopping while the browser started: nothing will stop this one later.
        if (this.#closing) {
            chromium.kill();

            throw new BrowserError("The server is stopping.");
        }

        this.#options.log?.(
            `Browser started${kind === "remote" ? " for sessions on other computers" : ""}: ${executable}`,
        );

        chromium.connection.onEvent = (method, params) => {
            if (method === "Browser.downloadProgress") {
                this.downloads.progress(params);

                return;
            }

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
                if (this.#contexts.get(id)?.kind !== kind) {
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
            if (this.#chromium[kind] === launching) {
                this.#chromium[kind] = undefined;
            }

            for (const [id, page] of this.#pages) {
                if (this.#contexts.get(id)?.kind === kind) {
                    page.close();
                }
            }
        };

        return chromium;
    }

    async #startProxy(): Promise<BrowserProxy> {
        const remote = this.#options.remote;

        if (remote === undefined) {
            throw new BrowserError("This server has no sessions on other computers.");
        }

        this.#proxy ??= new BrowserProxy(remote.connect);
        await this.#proxy.start();

        return this.#proxy;
    }

    /**
     * Give a context's page its proxy credentials once: Chromium asks for them on the first request (407), and then
     * sends them with every request of the context, its workers' too, without being asked. Only this first request
     * pauses for the DevTools protocol.
     */
    async #prime(
        connection: Connection,
        session: string,
        credentials: { username: string; password: string; key: string },
    ): Promise<void> {
        connection.listen(session, (method, params) => {
            if (method === "Fetch.authRequired") {
                const proxy = params.authChallenge?.source === "Proxy";

                void connection
                    .send(
                        "Fetch.continueWithAuth",
                        {
                            requestId: params.requestId,
                            authChallengeResponse: proxy
                                ? {
                                      response: "ProvideCredentials",
                                      username: credentials.username,
                                      password: credentials.password,
                                  }
                                : { response: "CancelAuth" },
                        },
                        session,
                    )
                    .catch(() => {});
            } else if (method === "Fetch.requestPaused") {
                void connection
                    .send("Fetch.continueRequest", { requestId: params.requestId }, session)
                    .catch(() => {});
            }
        });

        try {
            await connection.send(
                "Fetch.enable",
                { handleAuthRequests: true, patterns: [{ urlPattern: "*" }] },
                session,
            );
            await connection.send(
                "Page.navigate",
                { url: `http://${PRIME_HOST}/` },
                session,
                15_000,
            );
            await connection.send("Fetch.disable", {}, session);
        } finally {
            connection.unlisten(session);
        }

        if (this.#proxy?.primed(credentials.key) !== true) {
            throw new BrowserError("The browser did not take its proxy credentials.");
        }
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

        const runner = this.#options.remote?.runnerOf(conversationId);
        const kind: Kind = runner === undefined ? "local" : "remote";
        const chromium = await this.#browser(kind);
        const connection = chromium.connection;
        const credentials =
            runner === undefined ? undefined : this.#proxy!.add(runner, conversationId);
        const created = await connection
            .send("Target.createBrowserContext", {
                disposeOnDetach: false,
                ...(credentials === undefined
                    ? {}
                    : {
                          proxyServer: `http://127.0.0.1:${this.#proxy!.port}`,
                          proxyBypassList: "<-loopback>",
                      }),
            })
            .catch((error: unknown) => {
                if (credentials !== undefined) {
                    this.#proxy?.remove(credentials.key);
                }

                throw error;
            });
        const browserContextId = String(created.browserContextId);
        const incoming = join(this.#incomingRoot, randomBytes(8).toString("hex"));
        const info: ContextInfo = {
            kind,
            incoming,
            ...(credentials === undefined ? {} : { proxyKey: credentials.key }),
        };
        let page: BrowserPage | undefined;

        try {
            mkdirSync(incoming, { recursive: true, mode: 0o700 });
            await connection.send("Browser.setDownloadBehavior", {
                behavior: "allowAndName",
                browserContextId,
                downloadPath: incoming,
                eventsEnabled: true,
            });
            const { targetId } = await connection.send("Target.createTarget", {
                url: "about:blank",
                browserContextId,
            });
            const { sessionId } = await connection.send("Target.attachToTarget", {
                targetId,
                flatten: true,
            });

            if (credentials !== undefined) {
                await this.#prime(connection, sessionId, credentials);
            }

            page = new BrowserPage({
                conversationId,
                connection,
                session: sessionId,
                target: targetId,
                context: browserContextId,
                userAgent: chromium.userAgent,
                viewport: viewportFrom(saved?.viewport) ??
                    options.viewport ?? { ...VIEWPORTS.desktop },
                changed: () => this.#changed(conversationId),
                saved: (value) => this.#options.save?.(conversationId, value),
                download: (params) =>
                    this.downloads.began(conversationId, browserContextId, incoming, params),
            });
            await page.init();

            if (stale()) {
                page.close();

                throw new BrowserError("The browser was closed.");
            }

            this.#pages.set(conversationId, page);
            this.#contexts.set(conversationId, info);
            this.#idleSince[kind] = Date.now();

            // A session on another computer opens no files of this server, not even a saved address.
            const address = saved?.url ?? "";
            const restorable =
                address !== "" &&
                (runner === undefined || /^(https?|data):|^about:blank$/i.test(address));

            if (options.restore !== false && restorable) {
                const restoring = page.navigate(address, { timeoutMs: 15_000 }).catch(() => {});

                if (options.wait !== false) {
                    await restoring;
                }
            }

            return page;
        } catch (error) {
            page?.close();

            if (this.#contexts.get(conversationId) === info) {
                this.#contexts.delete(conversationId);
            }

            void this.#dispose(connection, browserContextId, info);

            throw error;
        }
    }

    /** Free a browser context: its cookies and storage, its proxy credentials, and its downloads in progress. */
    async #dispose(
        connection: Connection,
        browserContextId: string,
        info: ContextInfo,
    ): Promise<void> {
        if (info.proxyKey !== undefined) {
            this.#proxy?.remove(info.proxyKey);
        }

        this.downloads.closed(browserContextId);
        await connection.send("Target.disposeBrowserContext", { browserContextId }).catch(() => {});
        // What was still arriving goes too; finished ones were moved or are being copied.
        await this.downloads.settled(browserContextId);
        rmSync(info.incoming, { recursive: true, force: true });
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
        const info = this.#contexts.get(conversationId);

        if (this.#pages.get(conversationId) === page) {
            this.#pages.delete(conversationId);
            this.#contexts.delete(conversationId);
        }

        page.close();

        const kind = info?.kind ?? "local";

        if (this.#count(kind) === 0) {
            this.#idleSince[kind] = Date.now();
        }

        this.#changed(conversationId);
        const chromium = await this.#chromium[kind]?.catch(() => undefined);

        if (chromium !== undefined && info !== undefined) {
            await this.#dispose(chromium.connection, page.contextId, info);
        }
    }

    /** Open pages of a kind. */
    #count(kind: Kind): number {
        let count = 0;

        for (const id of this.#pages.keys()) {
            if (this.#contexts.get(id)?.kind === kind) {
                count++;
            }
        }

        return count;
    }

    #reap(): void {
        const idle = this.#options.idleMs ?? 30 * 60_000;

        for (const [id, page] of this.#pages) {
            if (page.closed || Date.now() - page.usedAt > idle) {
                void this.#discard(id, page);
            }
        }

        // Each browser stops a few minutes after its last page closed.
        for (const kind of ["local", "remote"] as const) {
            if (
                this.#count(kind) === 0 &&
                this.#opening.size === 0 &&
                this.#chromium[kind] !== undefined &&
                Date.now() - this.#idleSince[kind] > 5 * 60_000
            ) {
                void this.#stopBrowser(kind);
            }
        }
    }

    async #stopBrowser(kind: Kind): Promise<void> {
        const pending = this.#chromium[kind];

        this.#chromium[kind] = undefined;
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
        const contexts = [...this.#contexts.values()];

        for (const page of this.#pages.values()) {
            page.close();
        }

        this.#pages.clear();
        this.#contexts.clear();

        for (const info of contexts) {
            if (info.proxyKey !== undefined) {
                this.#proxy?.remove(info.proxyKey);
            }
        }

        if (options.final === true) {
            // After the pages closed, which announces them: nobody listens any more.
            for (const timer of this.#pending.values()) {
                clearTimeout(timer);
            }

            this.#pending.clear();
        }

        await Promise.all([this.#stopBrowser("local"), this.#stopBrowser("remote")]);
        // Their downloads in progress end with them; none of their files stay.
        await this.downloads.settledAll();
        rmSync(this.#incomingRoot, { recursive: true, force: true });

        if (options.final === true) {
            this.#proxy?.close();
        }

        if (options.final !== true) {
            for (const id of ids) {
                this.#changed(id);
            }
        }
    }
}
