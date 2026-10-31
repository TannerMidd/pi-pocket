/**
 * Extensions' web parts. While a module loads, the `web` its default export gets registers its routes (under
 * `/api/x/<module>/`), its browser module (served from `/x/<module>/<rev>/`), and its commands for the message box. They
 * count only once the module installed, and they replace the previous version's in one step, as its extensions do;
 * turning the module off removes them. The browser module loads in the tabs of the people its access lets in, and gets
 * the events the module sends.
 */
import { createHash, randomUUID } from "node:crypto";
import {
    type Dirent,
    type FSWatcher,
    lstatSync,
    readdirSync,
    realpathSync,
    statSync,
    watch,
} from "node:fs";
import { extname, join } from "node:path";
import type { User } from "./config.ts";
import { describe } from "./errors.ts";
import type {
    CommandInfo,
    ConversationWebRequest,
    ExtensionCommand,
    ExtensionWeb,
    PublicLinks as ModuleLinks,
    PublicPageHandler,
    WebAccess,
    WebHandler,
    WebMethod,
} from "./host.ts";
import type { PublicLinks } from "./public-links.ts";
import {
    checkSettings,
    type SettingField,
    type SettingValue,
    settingValue,
} from "./extension-settings.ts";

/**
 * The version of the extension API: the server's `web` and the app's `pocket`. It goes up only when something modules
 * use changes in a way that breaks them; additions keep it. 2 since 0.19.0: Pi Durable 1.2 renamed a tool result's
 * `content` to `output`, which breaks a hook or a wrap that returns `content`.
 */
export const POCKET_API = 2;
/** The oldest version that modules can still be written for: they load (rule A9 of api-stability.md). */
export const OLDEST_POCKET_API = 1;

const METHODS: ReadonlySet<string> = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const ACCESS: ReadonlySet<string> = new Set(["owner", "steer", "view"]);
/** A module with a web part needs a name that is one part of an address as it is. */
const MODULE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SEGMENT = /^(?::[A-Za-z_][A-Za-z0-9_]*|[A-Za-z0-9._~-]+)$/;
/** A browser module's file or folder: a name that is one part of an address as it is. */
const ENTRY = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
const EVENT = /^[A-Za-z0-9._:-]{1,64}$/;
/** An event's data, as JSON, at most: the app's event streams carry it to every tab it is for. */
const MAX_EVENT = 256 * 1024;
/** How many events, and how many bytes of them, a module may send each second; more are dropped and logged. */
const MAX_EVENTS_PER_SECOND = 100;
const MAX_EVENT_BYTES_PER_SECOND = 1024 * 1024;

/** The largest file a browser module serves: each request reads it whole, and anyone it is for may ask often. */
export const MAX_FILE_BYTES = 8 * 1024 * 1024;
/** How many served files of a browser module's folder count for its version; more are not looked at. */
const MAX_FILES = 2000;
/** How many folders of it are looked through for them. */
const MAX_FOLDERS = 500;
/** How many of a browser module's folders are watched for edits; deeper or more are seen at the module's next load. */
const MAX_WATCHED = 64;

/**
 * The message box's own commands: a module's command may not take their names, whether they show now or not. Keep it
 * the same as `COMMANDS` in `web/commands.js`. They are one word each, and a module's command names have a `-`, so a new
 * built-in never takes a module's name.
 */
export const BUILT_IN_COMMANDS: ReadonlySet<string> = new Set([
    "compact",
    "reset",
    "instructions",
    "model",
    "thinking",
    "new",
    "name",
    "cwd",
    "plan",
    "schedule",
    "remember",
    "until",
    "watch",
    "stop",
    "copy",
    "find",
    "session",
    "export",
    "resume",
    "chat",
    "browser",
    "files",
    "changes",
    "branch",
    "pip",
    "peek",
    "artifacts",
    "login",
    "settings",
    "trust",
    "theme",
]);
/** A module's command name: lowercase, starting with a letter, with at least one `-` (`clock-zone`). */
const COMMAND_NAME = /^(?=[^-]*-)[a-z][a-z0-9_-]{0,63}$/;

/** The most commands a module may register, and the longest description or `args` hint each may have. */
const MAX_COMMANDS = 50;
const MAX_COMMAND_TEXT = 200;

/** A command with its handler and its module's file, which stay on the server. */
export type RegisteredCommand = CommandInfo & Pick<ExtensionCommand, "handler"> & { file: string };

/** Marks the errors a module made with `web.error`: only their status and words reach the browser as they are. */
const EXPOSED = Symbol("pocket.webError");

/** An error a module made with `web.error`, to answer with: its status and its words, for whoever asked. */
export function exposedError(error: unknown): { status: number; message: string } | undefined {
    if (typeof error !== "object" || error === null || !(EXPOSED in error)) {
        return undefined;
    }

    const { status, message } = error as { status?: unknown; message?: unknown };

    return typeof status === "number"
        ? { status, message: typeof message === "string" ? message : "The extension failed." }
        : undefined;
}

/** The files a browser module's folder serves, by type. Never `.ts`: server code can hold secrets. */
const WEB_FILE_TYPES: Readonly<Record<string, string>> = {
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".woff2": "font/woff2",
};

/** Whether someone may use a web part open to `access`. The owner always may; people invited to one session never. */
export function mayUse(user: Pick<User, "role" | "sessions">, access: WebAccess): boolean {
    if (user.role === "owner") {
        return true;
    }

    if (user.sessions !== undefined) {
        return false;
    }

    return access === "view" || (access === "steer" && user.role === "guest");
}

/** A module's name, from its file: `server-status.ts` is `server-status`. */
function moduleName(file: string): string {
    return file.replace(/\.ts$/, "");
}

interface Route {
    method: WebMethod;
    /** The path as registered, for the Extensions sheet. */
    path: string;
    segments: string[];
    access: WebAccess;
    handle: WebHandler | ((request: ConversationWebRequest) => unknown);
    conversation?: string;
}

interface Client {
    access: WebAccess;
    /** The entry file's or the folder's name, right beside the module. */
    name: string;
    /** The entry file, or the folder everything is served from. */
    root: string;
    folder: boolean;
    /** The entry's path in the browser module's address: `index.js` in a folder, else the file's name. */
    entry: string;
    /** Changes with the files, so browsers import the new version. */
    rev: string;
}

/** What one version of a module registered. Nothing counts until the loader commits it. */
export class WebPart {
    readonly file: string;
    readonly module: string;
    readonly title: string;
    readonly directory: string;
    readonly routes: Route[] = [];
    client: Client | undefined;
    /** What draws the module's public pages (`web.publicPage`), for anyone with one of its links. */
    page: PublicPageHandler | undefined;
    /** What the module offers other modules (`web.provide`), and the settings it declares (`web.settings`). */
    service: object | undefined;
    settings: SettingField[] | undefined;
    /** What the module listens to: other modules' services, and its own settings. They go with this version. */
    readonly serviceListeners: { module: string; listener: () => void }[] = [];
    readonly settingsListeners: (() => void)[] = [];
    readonly commands: RegisteredCommand[] = [];
    /** The tools the module installed with this version: its browser module may describe only their calls. */
    tools: readonly string[] = [];
    readonly disposers: (() => void)[] = [];
    /** The browser module's folders that are watched, by path. */
    readonly watchers = new Map<string, FSWatcher>();
    /** Registering ends when the module's default export returns. */
    sealed = false;
    disposed = false;
    /** What `web.send` already logged for this version, so a module in a loop does not fill the log. */
    readonly warned = new Set<string>();
    /** This second's sending, for the limit on events. */
    sending = { second: 0, events: 0, bytes: 0 };

    constructor(file: string, directory: string, title: string) {
        this.file = file;
        this.module = moduleName(file);
        this.directory = directory;
        this.title = title;
    }

    /** Whether it added nothing to the app: no routes, browser module, public pages, or commands (cleanups do not count). */
    get empty(): boolean {
        return (
            this.routes.length === 0 &&
            this.client === undefined &&
            this.page === undefined &&
            this.service === undefined &&
            this.settings === undefined &&
            this.commands.length === 0
        );
    }
}

/** The routes a request to a module could mean. */
export type RouteMatch =
    { route: Route; part: WebPart; params: Record<string, string> } | { allow: WebMethod[] };

interface Options {
    /** Browser modules for the people `access` lets in changed: their tabs must hear which to load. */
    changed?: (access: WebAccess[]) => void;
    /** Send a browser module's event to the tabs it loads in (`to`: one person's). */
    deliver?: (part: WebPart, access: WebAccess, event: string, data: unknown, to?: string) => void;
    log?: (message: string) => void;
    /** Tell the owner something wrong with a module that they can mend (its browser module gone, say). */
    warn?: (message: string) => void;
    /** The modules' commands changed: tabs must hear the new list. */
    commandsChanged?: () => void;
    /** Where public links are kept (`public-links.ts`). Without it, `web.links` refuses. */
    links?: PublicLinks;
    /** The owner's values for modules' settings (config.json). Without it, every setting has its default. */
    settings?: (module: string) => Record<string, SettingValue>;
}

export class ExtensionWebs {
    /** The web part of every module that has one, by module name. */
    readonly #parts = new Map<string, WebPart>();
    readonly #options: Options;
    #watching = false;
    #closed = false;
    readonly #timers = new Map<WebPart, NodeJS.Timeout>();
    /** Versions still loading: the server stopping runs their cleanups too. */
    readonly #staged = new Set<WebPart>();
    /** Cleanups that wait, still running (of a version replaced or turned off): the server stopping waits for them. */
    readonly #settling = new Set<Promise<void>>();

    constructor(options: Options = {}) {
        this.#options = options;
    }

    /** What a module registers while `file` (in `directory`) loads, and the `web` its default export gets. */
    stage(file: string, directory: string, title: string): { part: WebPart; web: ExtensionWeb } {
        const part = new WebPart(file, directory, title);

        this.#staged.add(part);

        const sealed = (what: string) => {
            if (part.sealed) {
                throw new Error(
                    `web.${what}: register routes, the browser module, and commands while the module loads`,
                );
            }
        };

        const open = (what: string) => {
            sealed(what);

            if (!MODULE_NAME.test(part.module)) {
                throw new Error(
                    `web.${what}: rename ${file}: a module with a web part needs a name of letters, digits, - and _`,
                );
            }
        };

        const web: ExtensionWeb = {
            api: POCKET_API,
            module: part.module,
            route: (method, path, handle, options) => {
                open("route");
                part.routes.push(checkRoute(part, method, path, handle, options?.access));
            },
            conversationRoute: (method, path, handle, options) => {
                open("conversationRoute");

                const route = checkRoute(part, method, path, handle, options?.access);
                const parameter = options?.conversation;

                if (typeof parameter !== "string" || !route.segments.includes(`:${parameter}`)) {
                    throw new Error(
                        "web.conversationRoute: conversation must name a path parameter",
                    );
                }

                route.conversation = parameter;
                part.routes.push(route);
            },
            client: (entry, options) => {
                open("client");

                if (part.client !== undefined) {
                    throw new Error("web.client: a module has one browser module");
                }

                part.client = checkClient(part, entry, options?.access);
            },
            // Never throws: it is mostly called from timers, where a throw would take the whole server down. What it
            // cannot send goes to the log.
            send: (event, data, options) => {
                try {
                    this.#send(part, event, data, options);
                } catch (error) {
                    try {
                        this.#warn(part, "failed", `web.send failed: ${safeDescribe(error)}`);
                    } catch {
                        // Nothing to tell it with: it still must not throw.
                    }
                }
            },
            error: (status, message) => {
                if (!Number.isInteger(status) || status < 400 || status > 599) {
                    throw new Error(`web.error: a status is from 400 to 599, not ${status}`);
                }

                const words =
                    typeof message === "string" || typeof message === "number"
                        ? String(message)
                        : "The extension failed.";

                return Object.assign(new Error(words), { status, [EXPOSED]: true });
            },
            command: (name, command) => {
                sealed("command");
                part.commands.push(this.#checkCommand(part, name, command));
            },
            publicPage: (handle) => {
                open("publicPage");

                if (typeof handle !== "function") {
                    throw new Error("web.publicPage: give it a function that draws the page");
                }

                if (part.page !== undefined) {
                    throw new Error("web.publicPage: a module has one public page handler");
                }

                part.page = handle;
            },
            links: this.#links(part),
            provide: (service) => {
                open("provide");

                if (typeof service !== "object" || service === null) {
                    throw new Error("web.provide: give it an object of what the module offers");
                }

                if (part.service !== undefined) {
                    throw new Error("web.provide: a module provides one service");
                }

                part.service = service;
            },
            use: (module) => {
                if (typeof module !== "string") {
                    throw new Error("web.use: name a module");
                }

                // Only a version that is on: one still loading, or replaced, offers nothing.
                return this.#parts.get(module)?.service;
            },
            onService: (module, listener) => {
                if (typeof module !== "string" || typeof listener !== "function") {
                    throw new Error("web.onService: name a module, and give a function");
                }

                const entry = { module, listener };

                if (part.disposed) {
                    return () => {};
                }

                part.serviceListeners.push(entry);

                return () => {
                    const at = part.serviceListeners.indexOf(entry);

                    if (at >= 0) {
                        part.serviceListeners.splice(at, 1);
                    }
                };
            },
            settings: (fields) => {
                open("settings");

                if (part.settings !== undefined) {
                    throw new Error("web.settings: declare a module's settings once");
                }

                part.settings = checkSettings(fields);
            },
            setting: (name) => {
                const field = part.settings?.find((each) => each.name === name);

                if (field === undefined) {
                    throw new Error(
                        `web.setting: ${String(name)} is not one of the module's settings`,
                    );
                }

                return settingValue(field, this.#options.settings?.(part.module) ?? {});
            },
            onSettings: (listener) => {
                if (typeof listener !== "function") {
                    throw new Error("web.onSettings: give it a function");
                }

                if (part.disposed) {
                    return () => {};
                }

                part.settingsListeners.push(listener);

                return () => {
                    const at = part.settingsListeners.indexOf(listener);

                    if (at >= 0) {
                        part.settingsListeners.splice(at, 1);
                    }
                };
            },
            onDispose: (dispose) => {
                if (typeof dispose !== "function") {
                    throw new Error("web.onDispose: give it a function");
                }

                // After it went: at once, and a stop waits for it too.
                if (part.disposed) {
                    this.#track(runDispose(dispose, part, this.#options.log));

                    return;
                }

                part.disposers.push(dispose);
            },
        };

        return { part, web: Object.freeze(web) };
    }

    /**
     * A module's public links: only its own, and only while this version runs. A version that went makes, lists, and ends
     * none, as a turned-off module's links answer nothing.
     */
    #links(part: WebPart): ModuleLinks {
        const store = (what: string): PublicLinks => {
            if (part.disposed) {
                throw new Error(`web.links.${what}: this version of the module has gone`);
            }

            if (!MODULE_NAME.test(part.module)) {
                throw new Error(
                    `web.links.${what}: rename ${part.file}: a module with a web part needs a name of letters, digits, - and _`,
                );
            }

            const links = this.#options.links;

            if (links === undefined) {
                throw new Error(`web.links.${what}: this server keeps no public links`);
            }

            return links;
        };

        return Object.freeze({
            create: async (request) => store("create").create(part.module, request),
            get: async (token) => store("get").get(part.module, token),
            list: async () => store("list").list(part.module),
            end: async (token) => store("end").end(part.module, token),
        } satisfies ModuleLinks);
    }

    /** The page handler of a module that is on, for a public link it made; none while it is off or has none. */
    publicPage(module: string): { part: WebPart; handle: PublicPageHandler } | undefined {
        const part = this.#parts.get(module);

        return part?.page === undefined ? undefined : { part, handle: part.page };
    }

    #send(part: WebPart, event: unknown, data: unknown, options: unknown): void {
        // Never the event as text when it is not text: an object's own `toString` could throw.
        const name = typeof event === "string" ? event.slice(0, 64) : `a ${typeof event}`;
        const problem = (key: string, why: string) =>
            this.#warn(part, key, `web.send(${name}) sent nothing: ${why}`);

        if (typeof event !== "string" || !EVENT.test(event)) {
            return problem("name", "name the event with up to 64 letters, digits, and . _ : -");
        }

        const to = (options as { to?: unknown } | undefined)?.to;

        if (to !== undefined && typeof to !== "string") {
            return problem("to", "`to` is a person's id");
        }

        // A replaced or removed version sends nothing, and says nothing: its timers may still run for a moment.
        if (part.disposed) {
            return;
        }

        if (!part.sealed || this.#parts.get(part.module) !== part) {
            return problem("loading", "send events once the module has loaded");
        }

        if (part.client === undefined) {
            return problem("client", "the module has no browser module to send them to");
        }

        let json: string | undefined;

        try {
            json = JSON.stringify(data ?? null) as string | undefined;
        } catch (error) {
            return problem("json", `its data is not JSON: ${safeDescribe(error)}`);
        }

        if (json === undefined) {
            return problem("json", "its data is not JSON");
        }

        const bytes = Buffer.byteLength(json);

        if (bytes > MAX_EVENT) {
            return problem("size", `its data is larger than ${MAX_EVENT} bytes`);
        }

        // A module that sends without end would fill every tab's queue: past the limit, events are dropped.
        const second = Math.floor(Date.now() / 1000);

        if (part.sending.second !== second) {
            part.sending = { second, events: 0, bytes: 0 };
        }

        if (
            part.sending.events >= MAX_EVENTS_PER_SECOND ||
            part.sending.bytes + bytes > MAX_EVENT_BYTES_PER_SECOND
        ) {
            return problem(
                "rate",
                `more than ${MAX_EVENTS_PER_SECOND} events, or ${MAX_EVENT_BYTES_PER_SECOND} bytes of them, in a second: the rest of each such second is dropped`,
            );
        }

        part.sending.events++;
        part.sending.bytes += bytes;
        this.#options.deliver?.(part, part.client.access, event, JSON.parse(json), to);
    }

    /** A command as registered, checked: its name must not take a built-in command's, or another module's. */
    #checkCommand(part: WebPart, name: unknown, command: unknown): RegisteredCommand {
        if (typeof name !== "string" || !COMMAND_NAME.test(name)) {
            throw new Error(
                `web.command: ${String(name).slice(0, 64)}: a name is up to 64 lowercase letters, digits, - and _, starting with a letter, with at least one - (clock-zone), without the /`,
            );
        }

        if (typeof command !== "object" || command === null) {
            throw new Error(`web.command: /${name}: give it { description, scope, handler }`);
        }

        const { description, args, scope, handler } = command as Partial<ExtensionCommand>;

        if (typeof description !== "string" || description.trim() === "") {
            throw new Error(`web.command: /${name} needs a description`);
        }

        if (args !== undefined && typeof args !== "string") {
            throw new Error(`web.command: /${name}: args is a hint in words, such as "[zone]"`);
        }

        if (description.length > MAX_COMMAND_TEXT || (args?.length ?? 0) > MAX_COMMAND_TEXT) {
            throw new Error(
                `web.command: /${name}: its description and args are ${MAX_COMMAND_TEXT} characters at most`,
            );
        }

        if (part.commands.length >= MAX_COMMANDS) {
            throw new Error(`web.command: a module has ${MAX_COMMANDS} commands at most`);
        }

        if (scope !== "conversation" && scope !== "global") {
            throw new Error(`web.command: /${name}: scope is "conversation" or "global"`);
        }

        if (typeof handler !== "function") {
            throw new Error(`web.command: /${name} needs a handler`);
        }

        if (BUILT_IN_COMMANDS.has(name)) {
            throw new Error(`web.command: /${name} is one of the app's own commands`);
        }

        if (part.commands.some((each) => each.name === name)) {
            throw new Error(`web.command: /${name} is registered twice`);
        }

        this.#clash(part, name);

        return {
            id: randomUUID(),
            file: part.file,
            name,
            description,
            scope,
            handler,
            ...(args === undefined ? {} : { args }),
        };
    }

    /** Throw when another module has a command named `name`: the first one in keeps it. */
    #clash(part: WebPart, name: string): void {
        for (const other of this.#parts.values()) {
            if (other.module !== part.module && other.commands.some((each) => each.name === name)) {
                throw new Error(`web.command: ${other.file} already has a command named /${name}`);
            }
        }
    }

    /**
     * Check a version before it installs: another module may have taken one of its commands' names while it loaded.
     * Throws, so the version before stays.
     */
    check(part: WebPart): void {
        for (const command of part.commands) {
            this.#clash(part, command.name);
        }
    }

    /** Every installed module's commands, without their handlers. */
    commands(): CommandInfo[] {
        return [...this.#parts.values()].flatMap((part) =>
            part.commands.map(({ handler: _handler, file: _file, ...info }) => info),
        );
    }

    /** One command by its id: the very version a browser chose, never another module's or a newer version's. */
    command(id: string): RegisteredCommand | undefined {
        for (const part of this.#parts.values()) {
            const found = part.commands.find((each) => each.id === id);

            if (found !== undefined) {
                return found;
            }
        }

        return undefined;
    }

    /** Log a problem with a module's use of `web`, once per version and kind, so a loop does not fill the log. */
    #warn(part: WebPart, key: string, message: string): void {
        if (part.warned.has(key)) {
            return;
        }

        part.warned.add(key);
        this.#options.log?.(`${part.file}: ${message}`);
    }

    /** The module installed, with these tools: what it registered replaces what its previous version had. */
    commit(part: WebPart, tools: readonly string[] = []): void {
        part.sealed = true;
        part.tools = [...tools];
        this.#staged.delete(part);

        // Loaded while the server stopped: it goes at once.
        if (this.#closed) {
            void this.#dispose(part);

            return;
        }

        const previous = this.#parts.get(part.module);

        // Kept even when it added nothing to the app: cleanups it adds later run when it goes.
        this.#parts.set(part.module, part);
        this.#rewatch(part);

        if (previous !== undefined) {
            void this.#dispose(previous);
        }

        if (clientKey(previous) !== clientKey(part)) {
            this.#changed(previous, part);
        }

        if ((previous?.commands.length ?? 0) > 0 || part.commands.length > 0) {
            this.#options.commandsChanged?.();
        }

        if (previous?.service !== undefined || part.service !== undefined) {
            this.#serviceChanged(part.module);
        }
    }

    /** Tell the modules that listen that a module's service came, changed, or went. */
    #serviceChanged(module: string): void {
        for (const part of this.#parts.values()) {
            for (const entry of [...part.serviceListeners]) {
                if (entry.module !== module || part.disposed) {
                    continue;
                }

                try {
                    entry.listener();
                } catch (error) {
                    this.#options.log?.(
                        `${part.file}: web.onService(${module}) failed: ${safeDescribe(error)}`,
                    );
                }
            }
        }
    }

    /** The owner changed a module's settings: its version that is on hears it, and its tabs (`pocket.onSettings`). */
    settingsChanged(module: string): void {
        const part = this.#parts.get(module);

        if (part?.client !== undefined) {
            this.#options.deliver?.(part, part.client.access, "pocket:settings", null);
        }

        for (const listener of [...(part?.settingsListeners ?? [])]) {
            try {
                listener();
            } catch (error) {
                this.#options.log?.(`${part!.file}: web.onSettings failed: ${safeDescribe(error)}`);
            }
        }
    }

    /** The settings a module that is on declares, for the owner's sheet and its browser module. */
    settingsOf(module: string): SettingField[] | undefined {
        return this.#parts.get(module)?.settings;
    }

    /** Whose tabs load a module's browser module, when it has one: they may read its settings, secrets left out. */
    clientAccess(module: string): WebAccess | undefined {
        return this.#parts.get(module)?.client?.access;
    }

    /** The module failed to load: what it registered goes, and the version before stays. */
    discard(part: WebPart): void {
        part.sealed = true;
        this.#staged.delete(part);
        void this.#dispose(part);
    }

    /** The module was turned off or deleted. */
    remove(file: string): void {
        const part = this.#parts.get(moduleName(file));

        if (part === undefined || part.file !== file) {
            return;
        }

        this.#parts.delete(part.module);
        void this.#dispose(part);

        if (part.client !== undefined) {
            this.#changed(part);
        }

        if (part.commands.length > 0) {
            this.#options.commandsChanged?.();
        }

        if (part.service !== undefined) {
            this.#serviceChanged(part.module);
        }
    }

    /**
     * The route a request from `user` to `module` means, the methods its path takes when none matches, or none. Only the
     * routes `user` may use count: of the others they learn nothing, not even that they are there. Of the routes that
     * match, the most specific wins: a fixed part before a `:name` part, from the left.
     */
    match(
        module: string,
        method: string,
        path: readonly string[],
        user: Pick<User, "role" | "sessions">,
    ): RouteMatch | undefined {
        const part = this.#parts.get(module);

        if (part === undefined) {
            return undefined;
        }

        const found = part.routes.flatMap((route) => {
            const params = mayUse(user, route.access) ? matchPath(route.segments, path) : undefined;

            return params === undefined ? [] : [{ route, params }];
        });

        if (found.length === 0) {
            return undefined;
        }

        const best = found
            .filter((each) => each.route.method === method)
            .sort((a, b) => specificity(a.route).localeCompare(specificity(b.route)))[0];

        return best === undefined
            ? { allow: [...new Set(found.map((each) => each.route.method))] }
            : { route: best.route, part, params: best.params };
    }

    /** The browser modules someone's tabs load: each module's name, title, and address. */
    clients(
        user: Pick<User, "role" | "sessions">,
    ): { module: string; title: string; url: string }[] {
        return [...this.#parts.values()]
            .filter((part) => part.client !== undefined && mayUse(user, part.client.access))
            .map((part) => ({
                module: part.module,
                title: part.title,
                url: `/x/${part.module}/${part.client!.rev}/${part.client!.entry}`,
            }));
    }

    /**
     * A file of a module's browser module that someone may load, by its path under the module's address, with its type;
     * none for anything else. A folder serves its own regular files of the web types, never hidden ones or
     * `node_modules`, and nothing reached through a link: a link could lead to a file those rules leave out, or out of
     * the folder.
     */
    file(
        module: string,
        path: readonly string[],
        user: Pick<User, "role" | "sessions">,
    ): { file: string; type: string; dev: number; ino: number } | undefined {
        const part = this.#parts.get(module);
        const client = part?.client;

        if (
            part === undefined ||
            client === undefined ||
            !mayUse(user, client.access) ||
            path.length === 0
        ) {
            return undefined;
        }

        if (
            path.some(
                (each) =>
                    each === "" ||
                    each.startsWith(".") ||
                    each === "node_modules" ||
                    each.includes("\\") ||
                    each.includes("\0"),
            )
        ) {
            return undefined;
        }

        const type = WEB_FILE_TYPES[extname(path.at(-1)!).toLowerCase()];

        if (
            type === undefined ||
            (!client.folder && (path.length > 1 || path[0] !== client.entry))
        ) {
            return undefined;
        }

        try {
            // The file or folder itself, right beside the module, then the file in it, with no link on the way.
            const root = join(realpathSync(part.directory), client.name);
            const wanted = client.folder ? join(root, ...path) : root;
            const file = realpathSync(client.folder ? join(client.root, ...path) : client.root);

            const stats = statSync(file);

            // The file as checked, which the one opened must be: a folder on the way swapped for a link after this check
            // would lead to another file.
            return isItself(part.directory, client) && file === wanted && stats.isFile()
                ? { file, type, dev: stats.dev, ino: stats.ino }
                : undefined;
        } catch {
            return undefined;
        }
    }

    /** What a module's web part has, for the Extensions sheet. */
    describe(file: string):
        | {
              routes: string[];
              client?: WebAccess;
              access: WebAccess;
              commands: string[];
              publicPage: boolean;
              service: boolean;
              settings: boolean;
          }
        | undefined {
        const part = this.#parts.get(moduleName(file));

        if (part === undefined || part.file !== file || part.empty) {
            return undefined;
        }

        // The widest of its routes' and its browser module's: who can reach any of it.
        const reach: WebAccess[] = [
            ...part.routes.map((route) => route.access),
            ...(part.client === undefined ? [] : [part.client.access]),
        ];
        const access = (["view", "steer"] as const).find((each) => reach.includes(each)) ?? "owner";

        return {
            routes: part.routes.map((route) => `${route.method} ${route.path}`),
            ...(part.client === undefined ? {} : { client: part.client.access }),
            access,
            commands: part.commands.map((command) => `${command.scope} /${command.name}`),
            publicPage: part.page !== undefined,
            service: part.service !== undefined,
            settings: part.settings !== undefined,
        };
    }

    /** While an update moves Pi Pocket's checkout, browser modules' edits reach no tab: the restart after it does. */
    #paused = false;

    pause(paused: boolean): void {
        this.#paused = paused;

        if (paused) {
            for (const timer of this.#timers.values()) {
                clearTimeout(timer);
            }

            this.#timers.clear();
        }
    }

    /** Look again at browser modules' files when they change: a new version reaches the tabs. */
    watch(): void {
        this.#watching = true;

        for (const part of this.#parts.values()) {
            this.#rewatch(part);
        }
    }

    /** Something changed in a folder of modules: a browser module that is that file or folder has a new version. */
    touched(directory: string, name: string): void {
        for (const part of this.#parts.values()) {
            const client = part.client;

            if (client !== undefined && client.root === join(directory, name)) {
                this.#recheck(part);
            }
        }
    }

    /**
     * The server stops: the cleanups of every version run, the ones in force and the ones still loading. Settles once
     * they all finished, the ones that wait included, and the ones of versions that went before still running.
     */
    close(): Promise<void> {
        this.#closed = true;

        const running = [...this.#parts.values(), ...this.#staged].map((part) =>
            this.#dispose(part),
        );

        this.#parts.clear();
        this.#staged.clear();

        return this.#settled(running);
    }

    /** Wait for these cleanups and every other still running, also those a cleanup adds as it runs, until none is left. */
    async #settled(running: Promise<void>[]): Promise<void> {
        await Promise.allSettled(running);

        while (this.#settling.size > 0) {
            await Promise.allSettled([...this.#settling]);
        }
    }

    /** Tell the tabs of the people who load either part's browser module. */
    #changed(...parts: (WebPart | undefined)[]): void {
        const access = parts.flatMap((part) => (part?.client ? [part.client.access] : []));

        if (access.length > 0) {
            this.#options.changed?.(access);
        }
    }

    #recheck(part: WebPart): void {
        if (this.#paused) {
            return;
        }

        clearTimeout(this.#timers.get(part));
        this.#timers.set(
            part,
            setTimeout(() => {
                this.#timers.delete(part);
                const client = part.client;

                if (client === undefined || this.#parts.get(part.module) !== part) {
                    return;
                }

                // Watch first, then look: an edit after the look is seen by the new watches.
                this.#rewatch(part);

                // Replaced by a link, or gone: nothing of it is served now, and the owner should know why.
                if (!isItself(part.directory, client) && !part.warned.has("client gone")) {
                    const message = `${part.file}: its browser module ${client.name} is gone or became a link: tabs cannot load it until it is a file or folder again`;

                    // The owner's notice goes to the log too: once is enough.
                    part.warned.add("client gone");

                    if (this.#options.warn === undefined) {
                        this.#options.log?.(message);
                    } else {
                        this.#options.warn(message);
                    }
                }

                const rev = revision(client.root, client.folder);

                if (rev !== client.rev) {
                    client.rev = rev;
                    this.#changed(part);
                }
            }, 150),
        );
    }

    /**
     * Watch a browser module's folder and the folders in it, each on its own: a recursive watch would walk and watch
     * everything, `node_modules` included. Watched again after each change, as folders come and go, and one replaced by
     * another needs a watch of its own. Hidden folders, `node_modules`, and links are left out, as `revision` leaves
     * them out, and at most `MAX_WATCHED` folders are watched.
     */
    #rewatch(part: WebPart): void {
        const client = part.client;

        if (
            !this.#watching ||
            part.disposed ||
            client?.folder !== true ||
            this.#parts.get(part.module) !== part
        ) {
            return;
        }

        for (const watcher of part.watchers.values()) {
            watcher.close();
        }

        part.watchers.clear();

        for (const folder of folders(client.root).slice(0, MAX_WATCHED)) {
            try {
                const watcher = watch(folder, () => this.#recheck(part));

                watcher.on("error", () => {});
                part.watchers.set(folder, watcher);
            } catch (error) {
                this.#warn(
                    part,
                    `watch ${folder}`,
                    `its browser module is not reloaded when ${folder} is edited: ${safeDescribe(error)}`,
                );
            }
        }
    }

    /** A version goes: its watches stop and its cleanups run. Settles once the ones that wait finished too. */
    #dispose(part: WebPart): Promise<void> {
        if (part.disposed) {
            return Promise.resolve();
        }

        part.disposed = true;
        part.serviceListeners.length = 0;
        part.settingsListeners.length = 0;

        for (const watcher of part.watchers.values()) {
            watcher.close();
        }

        part.watchers.clear();
        clearTimeout(this.#timers.get(part));
        this.#timers.delete(part);

        // Last registered first, as cleanups nest.
        const running = part.disposers
            .splice(0)
            .reverse()
            .map((dispose) => runDispose(dispose, part, this.#options.log));

        return this.#track(Promise.allSettled(running).then(() => {}));
    }

    /** Keep a cleanup's promise until it settles: a stop that comes meanwhile waits for it. */
    #track(settled: Promise<void>): Promise<void> {
        this.#settling.add(settled);
        void settled.then(() => this.#settling.delete(settled));

        return settled;
    }
}

/** Run a cleanup, which may wait: never throws, and what fails goes to the log. */
function runDispose(
    dispose: () => void,
    part: WebPart,
    log?: (message: string) => void,
): Promise<void> {
    const failed = (error: unknown) =>
        log?.(`${part.file}: a cleanup failed: ${safeDescribe(error)}`);

    try {
        const result = dispose() as unknown;

        if (
            typeof result === "object" &&
            result !== null &&
            typeof (result as { then?: unknown }).then === "function"
        ) {
            return Promise.resolve(result).then(() => {}, failed);
        }
    } catch (error) {
        failed(error);
    }

    return Promise.resolve();
}

function checkRoute(
    part: WebPart,
    method: unknown,
    path: unknown,
    handle: unknown,
    access: unknown = "owner",
): Route {
    const verb = typeof method === "string" ? method.toUpperCase() : "";

    if (!METHODS.has(verb)) {
        throw new Error(`web.route: the method is GET, POST, PUT, PATCH, or DELETE, not ${method}`);
    }

    if (typeof path !== "string") {
        throw new Error('web.route: give the path as a string, such as "status" or "items/:id"');
    }

    const segments = path.split("/").filter((segment) => segment !== "");

    if (segments.length === 0) {
        throw new Error('web.route: give the route a path, such as "status"');
    }

    for (const segment of segments) {
        if (
            !SEGMENT.test(segment) ||
            segment === "." ||
            segment === ".." ||
            segment === ":__proto__"
        ) {
            throw new Error(
                `web.route: ${path}: each part of a path is letters, digits, and . _ ~ - (not . or .. alone), or :name`,
            );
        }
    }

    const names = segments.filter((segment) => segment.startsWith(":"));

    if (new Set(names).size !== names.length) {
        throw new Error(`web.route: ${path} names a part twice`);
    }

    if (typeof handle !== "function") {
        throw new Error(`web.route: ${verb} ${path} needs a function to answer it`);
    }

    if (typeof access !== "string" || !ACCESS.has(access)) {
        throw new Error(`web.route: access is "owner", "steer", or "view", not ${String(access)}`);
    }

    const shape = (each: string[]) =>
        each.map((segment) => (segment.startsWith(":") ? ":" : segment)).join("/");

    if (
        part.routes.some(
            (route) => route.method === verb && shape(route.segments) === shape(segments),
        )
    ) {
        throw new Error(`web.route: ${verb} ${path} is registered twice`);
    }

    return {
        method: verb as WebMethod,
        path: segments.join("/"),
        segments,
        access: access as WebAccess,
        handle: handle as WebHandler,
    };
}

function checkClient(part: WebPart, entry: unknown, access: unknown = "owner"): Client {
    // Right beside it, and named so its address needs no escaping: the folder of modules is watched for edits, not
    // what is deeper in it.
    if (typeof entry !== "string" || !ENTRY.test(entry) || entry === "node_modules") {
        throw new Error(
            'web.client: name a file or folder right beside the module, such as "status.js": letters, digits, and . _ -',
        );
    }

    if (typeof access !== "string" || !ACCESS.has(access)) {
        throw new Error(`web.client: access is "owner", "steer", or "view", not ${String(access)}`);
    }

    const root = join(part.directory, entry);

    // The file or folder itself: links are not served.
    const kind = (path: string) => {
        try {
            const stats = lstatSync(path);

            return stats.isSymbolicLink()
                ? "link"
                : stats.isDirectory()
                  ? "folder"
                  : stats.isFile()
                    ? "file"
                    : "other";
        } catch {
            return "none";
        }
    };

    const found = kind(root);

    if (found === "none") {
        throw new Error(`web.client: there is no ${entry} beside the module`);
    }

    if (found === "link") {
        throw new Error(`web.client: ${entry} is a link: give the file or folder itself`);
    }

    const folder = found === "folder";

    if (folder && kind(join(root, "index.js")) !== "file") {
        throw new Error(`web.client: the folder ${entry} has no index.js`);
    }

    if (!folder && (found !== "file" || ![".js", ".mjs"].includes(extname(root).toLowerCase()))) {
        throw new Error(`web.client: ${entry} is not a .js file`);
    }

    return {
        access: access as WebAccess,
        name: entry,
        root,
        folder,
        entry: folder ? "index.js" : entry,
        rev: revision(root, folder),
    };
}

/** Whether a browser module's file or folder is still itself, right beside its module: not a link, and there. */
function isItself(directory: string, client: Client): boolean {
    try {
        return realpathSync(client.root) === join(realpathSync(directory), client.name);
    } catch {
        return false;
    }
}

/** An error in words, from anything thrown: never a throw itself (an object's own `toString` may throw). */
function safeDescribe(error: unknown): string {
    try {
        return describe(error);
    } catch {
        return "an error that cannot be shown";
    }
}

/** How specific a route is, to sort by: a fixed part sorts before a `:name` part, from the left. */
function specificity(route: Route): string {
    return route.segments.map((segment) => (segment.startsWith(":") ? "1" : "0")).join("");
}

/** The values of a path's `:name` parts, or none when it does not match. */
function matchPath(
    segments: readonly string[],
    path: readonly string[],
): Record<string, string> | undefined {
    if (segments.length !== path.length) {
        return undefined;
    }

    const params: Record<string, string> = {};

    for (const [index, segment] of segments.entries()) {
        if (segment.startsWith(":")) {
            params[segment.slice(1)] = path[index]!;
        } else if (segment !== path[index]) {
            return undefined;
        }
    }

    return params;
}

/**
 * What tabs must know of a module's browser module: whether it loads, for whom, which version, and the tools whose calls
 * it may describe.
 */
function clientKey(part: WebPart | undefined): string {
    const client = part?.client;

    return client === undefined
        ? ""
        : `${client.access}:${client.rev}:${client.entry}:${part!.tools.join(",")}`;
}

/** A folder and the folders in it, as `revision` walks them: not hidden ones, nor `node_modules`. */
function folders(root: string): string[] {
    const found = [root];

    for (let at = 0; at < found.length && found.length < MAX_WATCHED; at++) {
        let entries: Dirent[];

        try {
            entries = readdirSync(found[at]!, { withFileTypes: true });
        } catch {
            continue;
        }

        for (const entry of entries) {
            if (
                entry.isDirectory() &&
                !entry.name.startsWith(".") &&
                entry.name !== "node_modules"
            ) {
                found.push(join(found[at]!, entry.name));
            }
        }
    }

    return found;
}

/**
 * A browser module's version: from the sizes and times of the files it serves, so an edit to any of them gives a new
 * one. Other files (a log or a cache the module writes beside them) and links are left out, as they are not served.
 */
function revision(root: string, folder: boolean): string {
    const hash = createHash("sha256");
    let files = 0;
    let folders = 0;

    /** Count a file, unless it is too large to serve: then it takes none of the files looked at. */
    const add = (path: string): boolean => {
        try {
            const stats = statSync(path);

            if (stats.size > MAX_FILE_BYTES) {
                return false;
            }

            hash.update(`${path}\0${stats.size}\0${stats.mtimeMs}\0`);
        } catch {
            hash.update(`${path}\0gone\0`);
        }

        return true;
    };

    const walk = (directory: string) => {
        let entries: Dirent[];

        try {
            entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
                a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
            );
        } catch {
            return;
        }

        for (const entry of entries) {
            if (entry.name.startsWith(".") || entry.name === "node_modules") {
                continue;
            }

            const path = join(directory, entry.name);

            // Only folders and the files it serves count toward the limits: a thousand logs beside them change nothing.
            if (entry.isDirectory()) {
                if (folders < MAX_FOLDERS) {
                    folders++;
                    walk(path);
                }
            } else if (
                entry.isFile() &&
                WEB_FILE_TYPES[extname(entry.name).toLowerCase()] &&
                files < MAX_FILES &&
                add(path)
            ) {
                files++;
            }
        }
    };

    if (folder) {
        walk(root);
    } else {
        add(root);
    }

    return hash.digest("hex").slice(0, 12);
}
