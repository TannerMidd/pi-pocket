/**
 * Pi Pocket's public extension API: what a module gets on the server (`Host`, `Web`, `CommandContext`), and what its
 * browser module gets in the app (`Pocket`).
 *
 * Import these types with `import type`. Node erases that import, so it has no effect when the module runs. Do not use
 * `import { type … }`: the gallery's check reads it as an import that runs.
 *
 * ```ts
 * import type { Host, Web } from "./_pocket.d.ts";
 * ```
 *
 * `@since` gives the first Pi Pocket release that has a member. `@experimental` marks a member that can change in any
 * release. A member without it is stable. The reference is in `docs/extensions/reference/`. `test/public-types.ts`
 * fails when this file and Pi Pocket's code do not agree.
 */
import type { Context } from "@earendil-works/chord";
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { Skill } from "@earendil-works/pi-coding-agent";
import type {
    ConversationId,
    DocumentReader,
    Extension,
    ModelRef,
    Tx,
} from "@earendil-works/pi-durable";
import type { ComponentType, Fragment, FunctionComponent, h, VNode } from "preact";
import type {
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useReducer,
    useRef,
    useState,
} from "preact/hooks";

// ─── Common ──────────────────────────────────────────────────────────────────

/**
 * A person's role in Pi Pocket.
 * @since 0.14.0
 */
export type Role = "owner" | "guest" | "viewer";

/**
 * A person: who sent a request, ran a command, or uses a tab.
 * @since 0.14.0
 */
export interface Person {
    /**
     * The person's id.
     * @since 0.14.0
     */
    readonly id: string;
    /**
     * The person's name, as the app shows it.
     * @since 0.14.0
     */
    readonly name: string;
    /**
     * The person's role.
     * @since 0.14.0
     */
    readonly role: Role;
}

/**
 * How important a notice is.
 * @since 0.1.0
 */
export type NoticeLevel = "info" | "warning" | "error";

// ─── The module ──────────────────────────────────────────────────────────────

/**
 * A module: one `.ts` file in the drop-in folder (or `src/server/extensions/`) that default-exports a setup function.
 * @since 0.1.0
 */
export interface Module {
    /**
     * Sets up the module. Returns its extensions: one, a list, or nothing when it only adds to the app. It can be async.
     * @since 0.1.0
     */
    default(
        host: Host,
        web: Web,
    ): Extension | readonly Extension[] | void | Promise<Extension | readonly Extension[] | void>;
    /**
     * The version of the extension API that the module needs. An older Pi Pocket does not set it up.
     * @since 0.14.0
     */
    pocketApi?: number;
}

// ─── The host ────────────────────────────────────────────────────────────────

/**
 * What the app gives a module: the first argument of its default export. The host stays the same while modules reload.
 * It changes only when the server restarts.
 * @since 0.1.0
 */
export interface Host {
    /**
     * Pi Pocket's data folder.
     * @since 0.1.0
     */
    readonly dataDir: string;
    /**
     * The running server's Pi Pocket package version, not the extension API level.
     * @since 0.16.0
     */
    readonly pocketVersion: string;
    /**
     * Local metadata for an exact provider/modelId, without network or sign-in information.
     * @since 0.16.0
     */
    modelInfo(
        spec: string,
    ): { model: ModelRef; name: string; thinkingLevels: ModelThinkingLevel[] } | undefined;
    /**
     * Pi's own folder, usually `~/.pi/agent`.
     * @since 0.1.0
     */
    readonly agentDir: string;
    /**
     * The extra skill folders in Pi's settings.
     * @since 0.1.0
     */
    skillPaths(): string[];
    /**
     * Pi's skills for a session that works in `cwd`, from all the places where Pi looks.
     * @since 0.12.0
     */
    skills(cwd: string): Skill[];
    /**
     * Finds a model by `provider/modelId` (or a model id alone) that is signed in and whose sign-in works. Throws an
     * error when there is none. The error names no other models.
     * @since 0.1.0
     */
    resolveModel(spec: string): ModelRef;
    /**
     * The models that the owner lets subagents use, as `provider/modelId`. Empty by default.
     * @since 0.13.1
     */
    subagentModels(): readonly string[];
    /**
     * Why Pi cannot use a model now (not known, not signed in, or the sign-in expired), or undefined when it can. With
     * `fresh`, it asks the provider again first.
     * @since 0.13.1
     */
    modelProblem(ref: ModelRef, fresh?: boolean): Promise<string | undefined>;
    /**
     * Shapes the request every model call sends: `shape` returns a replacement payload, or undefined to keep it. It runs
     * after Pi and the caller shaped the request, closest to the wire. The return value stops the shaping.
     * @since 0.18.0
     * @experimental
     */
    shapeModelRequests(
        shape: (payload: unknown, model: Model<Api>) => unknown | undefined,
    ): () => void;
    /**
     * The id of the person that Pi works for in a session now: the person whose message started its current work.
     * @since 0.3.0
     */
    requesterOf(conversationId: ConversationId): string | undefined;
    /**
     * Reports something to the server log and to the app. With `conversationId` (since 0.13.1), only that session's
     * tabs show it.
     * @since 0.1.0
     */
    notice(level: NoticeLevel, message: string, conversationId?: ConversationId): void;
    /**
     * Why Pi cannot start work in a session when nobody asked for it (a spend limit), or undefined when it can.
     * @since 0.12.0
     */
    heldBack(conversationId: ConversationId): string | undefined;
    /**
     * Calls `listener` when the owner changes a spend limit. Returns a function that stops it.
     * @since 0.12.0
     */
    onLimitsChanged(listener: () => void): () => void;
    /**
     * Sessions that a session starts and sends messages to, as Agent Teams does.
     * @since 0.14.0
     * @experimental
     */
    readonly linkedSessions: LinkedSessions;
    /**
     * Makes text from other places safe for Pi to read.
     * @since 0.14.0
     */
    readonly text: SafeText;
    /**
     * The thinking levels, lowest first, with the names that models and sessions use.
     * @since 0.14.0
     */
    readonly thinkingLevels: readonly ModelThinkingLevel[];
}

/**
 * Makes text from other places safe for Pi to read. Tell Pi in the same place that the text is data.
 * @since 0.14.0
 */
export interface SafeText {
    /**
     * The text as one line in quotes that it cannot close, cut to `max` characters, without invisible characters or
     * tags.
     * @since 0.14.0
     */
    quoted(text: string, max?: number): string;
    /**
     * The text with its lines, but with no closing tag left in it: for text between tags of your own.
     * @since 0.14.0
     */
    defang(text: string): string;
}

/**
 * Sessions that a session starts and sends messages to. Each call acts as the person that Pi works for in `source`,
 * with that person's checks. A call again with the same `key` acts once, and returns what the first call returned.
 * @since 0.14.0
 * @experimental
 */
export interface LinkedSessions {
    /**
     * Starts a session linked to `source`, in `cwd` or the source's folder, and sends it `message` as its first
     * message. `model` is `provider/modelId`; `thinking` is a level no higher than the source's. `cwd` is since 0.19.0:
     * an older Pi Pocket ignores it, and starts the session in the source's folder. A blank `cwd` counts as none; a
     * relative one resolves against the server process's folder, not the source's.
     * @since 0.14.0
     * @experimental
     */
    start(
        source: ConversationId,
        request: {
            title?: string;
            message: string;
            model?: string;
            thinking?: string;
            cwd?: string;
        },
        key: string,
    ): Promise<{ session: ConversationId; address: string }>;
    /**
     * Sends `message` to the linked session at the address `to`: as a follow-up, or with `steer` at its next pause.
     * @since 0.14.0
     * @experimental
     */
    send(
        source: ConversationId,
        request: { to: string; message: string; steer?: boolean },
        key: string,
    ): Promise<void>;
    /**
     * The sessions linked to `source`, at any distance, that the person Pi works for there can see.
     * @since 0.14.0
     * @experimental
     */
    list(source: ConversationId): Promise<LinkedSession[]>;
}

/**
 * A linked session, as `list` gives it to the session that asks.
 * @since 0.14.0
 * @experimental
 */
export interface LinkedSession {
    /**
     * The asking session's address for it. It is never the session's id.
     * @since 0.14.0
     * @experimental
     */
    address: string;
    /**
     * Its title: only when everyone who sees the asking session also sees this one.
     * @since 0.14.0
     * @experimental
     */
    title?: string;
    /**
     * Its folder, with the same condition as `title`.
     * @since 0.14.0
     * @experimental
     */
    cwd?: string;
    /**
     * Whether Pi works in it now, with the same condition as `title`.
     * @since 0.14.0
     * @experimental
     */
    busy?: boolean;
    /**
     * Whether it is archived, with the same condition as `title`.
     * @since 0.14.0
     * @experimental
     */
    archived?: boolean;
}

/**
 * A human-facing linked session that the authenticated person can see.
 * @since 0.16.0
 */
export interface HumanLinkedSession extends LinkedSession {
    /**
     * Its id, for pocket.openConversation. Other metadata keeps LinkedSession's audience rules.
     * @since 0.16.0
     */
    conversationId: ConversationId;
}

/**
 * Linked sessions bound to the authenticated person and source of one route request.
 * @since 0.16.0
 */
export interface HumanLinkedSessions {
    /**
     * Starts once for this key, as the clicking person. Optional `cwd` (since 0.19.0) selects an existing folder: blank
     * counts as none, and a relative one resolves against the server process's folder.
     * Explicit thinking must be supported and no higher than source.
     * @since 0.16.0
     */
    start(
        request: {
            title?: string;
            message: string;
            model?: string;
            thinking?: ModelThinkingLevel;
            cwd?: string;
        },
        key: string,
    ): Promise<{ session: ConversationId; address: string }>;
    /**
     * Visible linked sessions, with ids for human navigation. Valid only during this request.
     * @since 0.16.0
     */
    list(): Promise<HumanLinkedSession[]>;
}

// ─── web: the module's part of the app ───────────────────────────────────────

/**
 * Who can use a route or a browser module: the owner alone, people who can steer every session, or people who can see
 * every session. People invited to one session never can.
 * @since 0.14.0
 */
export type WebAccess = "owner" | "steer" | "view";

/**
 * The HTTP methods of routes.
 * @since 0.14.0
 */
export type WebMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * A request to a route, as its handler gets it.
 * @since 0.14.0
 */
export interface WebRequest {
    /**
     * The request's method.
     * @since 0.14.0
     */
    readonly method: WebMethod;
    /**
     * The values of the path's `:name` parts, by name.
     * @since 0.14.0
     */
    readonly params: Readonly<Record<string, string>>;
    /**
     * The query string.
     * @since 0.14.0
     */
    readonly query: URLSearchParams;
    /**
     * The JSON object that the browser sent. It is empty for GET and DELETE.
     * @since 0.14.0
     */
    readonly body: Readonly<Record<string, unknown>>;
    /**
     * The person who sent the request.
     * @since 0.14.0
     */
    readonly user: Person;
    /**
     * Aborts when the browser stops waiting for the answer.
     * @since 0.14.0
     */
    readonly signal: AbortSignal;
    /**
     * Fresh committed document reads; use this request's context.
     * @since 0.16.0
     */
    readonly snapshot: DocumentReader["snapshot"];
    /**
     * Request-scoped context, cancelled on disconnect or handler return.
     * @since 0.16.0
     */
    readonly context: Context;
    /**
     * Changes the module's documents atomically. Refused for viewers and after this request ends.
     * @since 0.16.0
     */
    commit<T>(change: (tx: Tx) => T | Promise<T>): Promise<T>;
}

/**
 * A request whose named path parameter resolved to an authorized conversation.
 * @since 0.16.0
 */
export interface ConversationWebRequest extends WebRequest {
    /**
     * Authoritative source settings for this request; omitted model means none is selected.
     * @since 0.16.0
     */
    readonly conversation: {
        readonly id: ConversationId;
        readonly title: string;
        readonly cwd: string;
        readonly model?: ModelRef;
        readonly thinkingLevel: ModelThinkingLevel;
    };
    /**
     * Starts and lists linked sessions as the authenticated person, never the source's last requester.
     * @since 0.16.0
     */
    readonly linkedSessions: HumanLinkedSessions;
}

/**
 * Answers a route's requests. The value it returns goes back as JSON (`undefined` as `{}`).
 * @since 0.14.0
 */
export type WebHandler = (request: WebRequest) => unknown;

/**
 * What a module adds to the app: the second argument of its default export. Register routes, the browser module, and
 * commands while the module loads. They go when this version of the module goes.
 * @since 0.14.0
 */
export interface Web {
    /**
     * The version of the extension API.
     * @since 0.14.0
     */
    readonly api: number;
    /**
     * The module's name: its file's name without `.ts`.
     * @since 0.14.0
     */
    readonly module: string;
    /**
     * Adds a route at `/api/x/<module>/<path>`. A part of `path` written `:name` matches any one part.
     * @since 0.14.0
     */
    route(
        method: WebMethod,
        path: string,
        handle: WebHandler,
        options?: { access?: WebAccess },
    ): void;
    /**
     * Binds the path parameter named by options.conversation to a visible source before calling the handler.
     * GET requires seeing; all other methods also require steering and the turn.
     * @since 0.16.0
     */
    conversationRoute(
        method: WebMethod,
        path: string,
        handle: (request: ConversationWebRequest) => unknown,
        options: { conversation: string; access?: WebAccess },
    ): void;
    /**
     * Sets the browser module: a `.js` file beside the module, or a folder with an `index.js`.
     * @since 0.14.0
     */
    client(entry: string, options?: { access?: WebAccess }): void;
    /**
     * Adds the command `/name` to the message box.
     * @since 0.14.0
     */
    command(name: string, command: Command): void;
    /**
     * Sends an event to the browser module: to everyone it loads for, or to the person `to`. It never throws.
     * @since 0.14.0
     */
    send(event: string, data?: unknown, options?: { to?: string }): void;
    /**
     * Makes an error for a route or command to throw. The person who asked gets `status` and `message` as they are.
     * @since 0.14.0
     */
    error(status: number, message: string): Error;
    /**
     * Runs `dispose` when this version of the module goes. It can return a promise.
     * @since 0.14.0
     */
    onDispose(dispose: () => unknown): void;
}

// ─── Commands ────────────────────────────────────────────────────────────────

/**
 * A command that people run from the message box, without asking Pi.
 * @since 0.14.0
 */
export interface Command {
    /**
     * What the command does, for the message box's suggestions.
     * @since 0.14.0
     */
    description: string;
    /**
     * A hint for the arguments, in words, such as `"[zone]"`.
     * @since 0.14.0
     */
    args?: string;
    /**
     * Who can run it: `"conversation"`, a person who can steer the session; `"global"`, the owner alone.
     * @since 0.14.0
     */
    scope: "conversation" | "global";
    /**
     * Runs the command. `args` is all the text after the name.
     * @since 0.14.0
     */
    handler(args: string, context: CommandContext): CommandResult | Promise<CommandResult>;
}

/**
 * Who ran a command and where, with the durable task that runs it.
 * @since 0.14.0
 */
export interface CommandContext {
    /**
     * The person who ran the command.
     * @since 0.14.0
     */
    readonly user: Person;
    /**
     * The session where the person ran it.
     * @since 0.14.0
     */
    readonly conversationId: ConversationId;
    /**
     * The session's folder.
     * @since 0.14.0
     */
    readonly cwd: string;
    /**
     * Aborts when a person stops the command.
     * @since 0.14.0
     */
    readonly signal: AbortSignal;
    /**
     * Reads a document: `ctx.snapshot(Doc, ctx.conversationId, ctx.context)`.
     * @since 0.14.0
     */
    readonly snapshot: DocumentReader["snapshot"];
    /**
     * The task's context, for `snapshot` and other calls to Pi Durable.
     * @since 0.14.0
     */
    readonly context: Context;
    /**
     * Changes documents in one commit, and returns what `change` returns.
     * @since 0.14.0
     */
    commit<T>(change: (tx: Tx) => T | Promise<T>): Promise<T>;
}

/**
 * What a command returns: a notice for the person who ran it, or a card of plain text in the session.
 * @since 0.14.0
 */
export type CommandResult =
    { type: "toast"; level: NoticeLevel; message: string } | { type: "card"; output: string };

// ─── pocket: the browser module's API ────────────────────────────────────────

/**
 * A browser module: the `.js` file that the app loads in the tabs of the people it is for.
 * @since 0.14.0
 */
export interface BrowserModule {
    /**
     * Sets up the browser module. A function that it returns runs when this version goes.
     * @since 0.14.0
     */
    default(pocket: Pocket): void | (() => void) | Promise<void | (() => void)>;
    /**
     * The version of the extension API that the browser module needs.
     * @since 0.14.0
     */
    pocketApi?: number;
}

/**
 * What a rail button, menu row, or launcher action does when a person uses it: exactly one of these. `panel` (since
 * 0.19.0) opens one of the module's panels.
 * @since 0.14.0
 */
export type Action =
    | { page: string; sheet?: never; panel?: never; run?: never }
    | { sheet: string; page?: never; panel?: never; run?: never }
    | { panel: string; page?: never; sheet?: never; run?: never }
    | { run: () => unknown; page?: never; sheet?: never; panel?: never };

/**
 * A button on the rail.
 * @since 0.14.0
 */
export type RailSpec = Action & {
    /**
     * The button's id in the module.
     * @since 0.14.0
     */
    id: string;
    /**
     * The button's label.
     * @since 0.14.0
     */
    title: string;
    /**
     * The name of one of the app's icons.
     * @since 0.14.0
     */
    icon?: string;
    /**
     * An icon of your own: a stroked path in a 24 × 24 box.
     * @since 0.14.0
     */
    iconPath?: string;
    /**
     * A short count or word on the button.
     * @since 0.14.0
     */
    badge?: number | string | null | false;
};

/**
 * A row in the menu's App group.
 * @since 0.14.0
 */
export type MenuSpec = Action & {
    /**
     * The row's id in the module.
     * @since 0.14.0
     */
    id: string;
    /**
     * The row's label.
     * @since 0.14.0
     */
    label: string;
    /**
     * A short hint on the right of the row.
     * @since 0.14.0
     */
    hint?: string;
};

/**
 * An action in the launcher.
 * @since 0.14.0
 */
export type LauncherSpec = Action & {
    /**
     * The action's id in the module.
     * @since 0.14.0
     */
    id: string;
    /**
     * The action's label.
     * @since 0.14.0
     */
    label: string;
    /**
     * A line under the label. By default, the module's title.
     * @since 0.14.0
     */
    detail?: string;
    /**
     * The name of one of the app's icons.
     * @since 0.14.0
     */
    icon?: string;
    /**
     * An icon of your own: a stroked path in a 24 × 24 box.
     * @since 0.14.0
     */
    iconPath?: string;
    /**
     * More words that find the action when a person types them.
     * @since 0.14.0
     */
    keywords?: string[];
};

/**
 * What the component of a page or sheet gets.
 * @since 0.14.0
 */
export interface PageProps {
    /**
     * The `pocket` of the module's version that added the page or sheet.
     * @since 0.14.0
     */
    pocket: Pocket;
    /**
     * Closes this page or sheet while it shows. Later, it closes nothing.
     * @since 0.14.0
     */
    close(): void;
}

/**
 * What a sheet's component gets: the props that `openSheet` gave, and `pocket` and `close`.
 * @since 0.14.0
 */
export type SheetProps<P extends object = object> = P & PageProps;

/**
 * A page in the place of the session.
 * @since 0.14.0
 */
export interface PageSpec {
    /**
     * The page's id in the module.
     * @since 0.14.0
     */
    id: string;
    /**
     * The page's title.
     * @since 0.14.0
     */
    title: string;
    /**
     * What the page shows.
     * @since 0.14.0
     */
    component: ComponentType<PageProps>;
    /**
     * With `false`, Esc does not close the page.
     * @since 0.14.0
     */
    escape?: boolean;
    /**
     * With `false`, no swipe on the page goes back.
     * @since 0.14.0
     */
    swipe?: boolean;
}

/**
 * A sheet, as the app's own sheets.
 * @since 0.14.0
 */
export interface SheetSpec<P extends object = object> {
    /**
     * The sheet's id in the module.
     * @since 0.14.0
     */
    id: string;
    /**
     * The sheet's title.
     * @since 0.14.0
     */
    title: string;
    /**
     * What the sheet shows.
     * @since 0.14.0
     */
    component: ComponentType<SheetProps<P>>;
    /**
     * With `true`, the sheet is wider.
     * @since 0.14.0
     */
    wide?: boolean;
}

/**
 * A panel beside the conversation, where the Browser and Files panels dock; over the conversation on a narrow screen.
 * The top bar and the places get a button that opens it.
 * @since 0.19.0
 * @experimental
 */
export interface PanelSpec {
    /**
     * The panel's id in the module.
     * @since 0.19.0
     * @experimental
     */
    id: string;
    /**
     * The panel's title, and its buttons' label.
     * @since 0.19.0
     * @experimental
     */
    title: string;
    /**
     * What the panel shows.
     * @since 0.19.0
     * @experimental
     */
    component: ComponentType<PageProps>;
    /**
     * The name of one of the app's icons, for its buttons.
     * @since 0.19.0
     * @experimental
     */
    icon?: string;
    /**
     * An icon of your own: a stroked path in a 24 × 24 box.
     * @since 0.19.0
     * @experimental
     */
    iconPath?: string;
    /**
     * A short count or word on its buttons, as on a rail button.
     * @since 0.19.0
     * @experimental
     */
    badge?: number | string | null | false;
    /**
     * With `true`, the panel is wider beside the conversation.
     * @since 0.19.0
     * @experimental
     */
    wide?: boolean;
}

/**
 * An item in the status line under the message box, before the spend. With an action, it is a button.
 * @since 0.19.0
 * @experimental
 */
export type StatusSpec = (Action | { page?: never; sheet?: never; panel?: never; run?: never }) & {
    /**
     * The item's id in the module.
     * @since 0.19.0
     * @experimental
     */
    id: string;
    /**
     * What the item says: `"46W · 74° · 95%"`.
     * @since 0.19.0
     * @experimental
     */
    text: string;
    /**
     * What it says on a line too narrow for `text`: `"46W"`.
     * @since 0.19.0
     * @experimental
     */
    short?: string;
    /**
     * Its tooltip, and what a tap on the line says on a touch screen.
     * @since 0.19.0
     * @experimental
     */
    title?: string;
    /**
     * Its color: `"warn"`, `"error"`, or `"muted"` (greyed, as for a service that is out of reach).
     * @since 0.19.0
     * @experimental
     */
    tone?: "warn" | "error" | "muted";
    /**
     * Its name in Appearance → Layout. By default, the module's title.
     * @since 0.19.0
     * @experimental
     */
    label?: string;
} & Placement;

/**
 * Where an item goes in its slot: just before or just after another item, such as `"core:spend"`. Without either, it
 * goes in the place the slot keeps for extensions. A person's own order wins.
 * @since 0.19.0
 * @experimental
 */
export type Placement = { before?: string; after?: never } | { after?: string; before?: never };

/**
 * A button in the top bar, after `core:browser` and before `core:artifacts`, `core:people`, and the menu.
 * @since 0.19.0
 * @experimental
 */
export type TopbarSpec = Action &
    Placement & {
        /**
         * The button's id in the module.
         * @since 0.19.0
         * @experimental
         */
        id: string;
        /**
         * The button's label.
         * @since 0.19.0
         * @experimental
         */
        title: string;
        /**
         * The name of one of the app's icons.
         * @since 0.19.0
         * @experimental
         */
        icon?: string;
        /**
         * An icon of your own: a stroked path in a 24 × 24 box.
         * @since 0.19.0
         * @experimental
         */
        iconPath?: string;
        /**
         * A short count or word on the button.
         * @since 0.19.0
         * @experimental
         */
        badge?: number | string | null | false;
    };

/**
 * A button on the left of the message box's row, after the app's own (Attach, the model, Plan).
 * @since 0.19.0
 * @experimental
 */
export type ComposerButtonSpec = TopbarSpec;

/**
 * One of Pi's answers, as an action under it gets it.
 * @since 0.19.0
 * @experimental
 */
export interface Reply {
    /**
     * The answer's id in its session.
     * @since 0.19.0
     * @experimental
     */
    readonly id: string;
    /**
     * Its words, as Markdown.
     * @since 0.19.0
     * @experimental
     */
    readonly text: string;
    /**
     * The session it is in.
     * @since 0.19.0
     * @experimental
     */
    readonly conversationId: number;
}

/**
 * An action under Pi's answers, before More. `run` gets the answer; a sheet gets it as the prop `reply`.
 * @since 0.19.0
 * @experimental
 */
export type ReplyActionSpec = (
    { run: (reply: Reply) => unknown; sheet?: never } | { sheet: string; run?: never }
) &
    Placement & {
        /**
         * The action's id in the module.
         * @since 0.19.0
         * @experimental
         */
        id: string;
        /**
         * The action's words.
         * @since 0.19.0
         * @experimental
         */
        label: string;
        /**
         * The name of one of the app's icons, before the words.
         * @since 0.19.0
         * @experimental
         */
        icon?: string;
        /**
         * An icon of your own: a stroked path in a 24 × 24 box.
         * @since 0.19.0
         * @experimental
         */
        iconPath?: string;
    };

/**
 * A place in the app built from named items: `"topbar"` (the buttons after the session's title), `"status"` (the
 * status line under the message box), `"places"` (the tiles of the places and the menu), `"composer"` (the buttons on
 * the left of the message box's row), or `"reply"` (the actions under Pi's answers).
 * @since 0.19.0
 * @experimental
 */
export type SlotName = "topbar" | "status" | "places" | "composer" | "reply";

/**
 * How a module arranges a slot: items to hide, and an order for some of them. The named items take the places those
 * items had, in this order; the rest stay. The app's items are `core:…`, extensions' `ext:<module>:<id>`.
 * @since 0.19.0
 * @experimental
 */
export interface Arrangement {
    /**
     * Ids of items to hide. Fixed items (the menu, Lancet Guard, the connection's warning) always show.
     * @since 0.19.0
     * @experimental
     */
    hide?: string[];
    /**
     * Ids of items, in the order they show.
     * @since 0.19.0
     * @experimental
     */
    order?: string[];
}

/**
 * How a group of tool calls counts a call: "messaged 2 sessions".
 * @since 0.14.0
 */
export interface CallSummary {
    /**
     * The verb: `"messaged"`.
     * @since 0.14.0
     */
    verb: string;
    /**
     * The noun that the calls count: `"session"`.
     * @since 0.14.0
     */
    noun?: string;
    /**
     * The argument whose values the calls count by: `"to"`.
     * @since 0.14.0
     */
    by?: string;
}

/**
 * How the calls of one of the module's tools show in transcripts and peek tiles. Each function gets a copy of the
 * call's arguments.
 * @since 0.14.0
 */
export interface ToolCallSpec<A = Record<string, unknown>> {
    /**
     * The tool's name, as Pi calls it. It must be a tool of the module's own extensions.
     * @since 0.14.0
     */
    tool: string;
    /**
     * The name of one of the app's icons, for peek tiles.
     * @since 0.14.0
     */
    icon?: string;
    /**
     * An icon of your own, for peek tiles: a stroked path in a 24 × 24 box.
     * @since 0.14.0
     */
    iconPath?: string;
    /**
     * The words of the call's line: `"start session"`.
     * @since 0.14.0
     */
    label: (args: A) => string;
    /**
     * What the call acts on.
     * @since 0.14.0
     */
    subject?: (args: A) => string;
    /**
     * How a group of calls counts this call.
     * @since 0.14.0
     */
    summary?: (args: A) => CallSummary;
}

/**
 * What `rail`, `menu`, `launcher`, `page`, and `sheet` return.
 * @since 0.14.0
 */
export interface Added<S> {
    /**
     * Changes some of its fields.
     * @since 0.14.0
     */
    update(patch: Partial<S>): void;
    /**
     * Removes it.
     * @since 0.14.0
     */
    remove(): void;
}

/**
 * The props of `pocket.Icon`.
 * @since 0.14.0
 */
export interface IconProps {
    /**
     * The name of one of the app's icons.
     * @since 0.14.0
     */
    name?: string;
    /**
     * An icon of your own: a stroked path in a 24 × 24 box.
     * @since 0.14.0
     */
    path?: string;
    /**
     * Its width and height, in pixels.
     * @since 0.14.0
     */
    size?: number;
}

/**
 * The props of `pocket.Loader` and `pocket.Spinner`.
 * @since 0.14.0
 */
export interface LoaderProps {
    /**
     * What is loading, in words.
     * @since 0.14.0
     */
    label?: string;
}

/**
 * The props of `pocket.Markdown`.
 * @since 0.14.0
 */
export interface MarkdownProps {
    /**
     * The Markdown to show.
     * @since 0.14.0
     */
    text: string;
}

/**
 * The props of `pocket.Switch`.
 * @since 0.14.0
 */
export interface SwitchProps {
    /**
     * Whether it is on.
     * @since 0.14.0
     */
    on: boolean;
    /**
     * Its name, for screen readers.
     * @since 0.14.0
     */
    label: string;
    /**
     * Runs when a person turns it.
     * @since 0.14.0
     */
    onChange: () => void;
    /**
     * Whether it cannot be turned now.
     * @since 0.14.0
     */
    disabled?: boolean;
}

/**
 * The app's API for a browser module: the argument of its default export.
 * @since 0.14.0
 */
export interface Pocket {
    /**
     * The version of the extension API.
     * @since 0.14.0
     */
    readonly version: number;
    /**
     * The connected server's Pi Pocket package version; undefined with a server older than 0.16.0.
     * @since 0.16.0
     */
    readonly pocketVersion: string | undefined;
    /**
     * The module's name.
     * @since 0.14.0
     */
    readonly module: string;
    /**
     * The module's title.
     * @since 0.14.0
     */
    readonly title: string;
    /**
     * The app's Preact `h`.
     * @since 0.14.0
     */
    readonly h: typeof h;
    /**
     * The app's htm, bound to its Preact.
     * @since 0.14.0
     */
    html(strings: TemplateStringsArray, ...values: unknown[]): VNode | VNode[];
    /**
     * The app's Preact `Fragment`.
     * @since 0.14.0
     */
    readonly Fragment: typeof Fragment;
    /**
     * Preact's `useState`.
     * @since 0.14.0
     */
    readonly useState: typeof useState;
    /**
     * Preact's `useEffect`.
     * @since 0.14.0
     */
    readonly useEffect: typeof useEffect;
    /**
     * Preact's `useLayoutEffect`.
     * @since 0.14.0
     */
    readonly useLayoutEffect: typeof useLayoutEffect;
    /**
     * Preact's `useRef`.
     * @since 0.14.0
     */
    readonly useRef: typeof useRef;
    /**
     * Preact's `useMemo`.
     * @since 0.14.0
     */
    readonly useMemo: typeof useMemo;
    /**
     * Preact's `useCallback`.
     * @since 0.14.0
     */
    readonly useCallback: typeof useCallback;
    /**
     * Preact's `useReducer`.
     * @since 0.14.0
     */
    readonly useReducer: typeof useReducer;
    /**
     * One of the app's icons, or an icon of your own.
     * @since 0.14.0
     */
    readonly Icon: FunctionComponent<IconProps>;
    /**
     * The app's spinner.
     * @since 0.14.0
     */
    readonly Spinner: FunctionComponent<LoaderProps>;
    /**
     * The app's spinner with a line of text.
     * @since 0.14.0
     */
    readonly Loader: FunctionComponent<LoaderProps>;
    /**
     * Markdown, cleaned as the app cleans Pi's replies.
     * @since 0.14.0
     */
    readonly Markdown: FunctionComponent<MarkdownProps>;
    /**
     * The app's on and off switch.
     * @since 0.14.0
     */
    readonly Switch: FunctionComponent<SwitchProps>;
    /**
     * The person who uses this tab, or null before sign-in.
     * @since 0.14.0
     */
    me(): Person | null;
    /**
     * The id of the session that this tab shows, a number as in its address (`/s/12`), or null.
     * @since 0.14.0
     */
    conversationId(): number | null;
    /**
     * Opens a conversation through normal navigation. The server still checks access.
     * @since 0.16.0
     */
    openConversation(id: number | string): void;
    /**
     * Calls one of the module's routes: a GET without `body`, a POST with it.
     * @since 0.14.0
     */
    api<T = unknown>(
        path: string,
        body?: object,
        options?: { method?: WebMethod; signal?: AbortSignal },
    ): Promise<T>;
    /**
     * Listens for an event that the module sends. Returns a function that stops it.
     * @since 0.14.0
     */
    on<T = unknown>(event: string, run: (data: T) => void): () => void;
    /**
     * Shows a notice, as the app's own.
     * @since 0.14.0
     */
    notify(level: NoticeLevel, message: string): void;
    /**
     * Adds a button on the rail.
     * @since 0.14.0
     */
    rail(spec: RailSpec): Added<RailSpec>;
    /**
     * Adds a row in the menu.
     * @since 0.14.0
     */
    menu(spec: MenuSpec): Added<MenuSpec>;
    /**
     * Adds an action in the launcher.
     * @since 0.14.0
     */
    launcher(spec: LauncherSpec): Added<LauncherSpec>;
    /**
     * Adds a page.
     * @since 0.14.0
     */
    page(spec: PageSpec): Added<PageSpec>;
    /**
     * Adds a sheet.
     * @since 0.14.0
     */
    sheet<P extends object = object>(spec: SheetSpec<P>): Added<SheetSpec<P>>;
    /**
     * Adds a panel beside the conversation, with a button in the top bar and in the places.
     * @since 0.19.0
     * @experimental
     */
    panel(spec: PanelSpec): Added<PanelSpec>;
    /**
     * Adds an item in the status line under the message box.
     * @since 0.19.0
     * @experimental
     */
    status(spec: StatusSpec): Added<StatusSpec>;
    /**
     * Adds a button in the top bar.
     * @since 0.19.0
     * @experimental
     */
    topbar(spec: TopbarSpec): Added<TopbarSpec>;
    /**
     * Adds a button on the left of the message box's row.
     * @since 0.19.0
     * @experimental
     */
    composerButton(spec: ComposerButtonSpec): Added<ComposerButtonSpec>;
    /**
     * Adds an action under Pi's answers.
     * @since 0.19.0
     * @experimental
     */
    replyAction(spec: ReplyActionSpec): Added<ReplyActionSpec>;
    /**
     * Puts text into the message box, after what is there, for the person to send. It never sends.
     * @since 0.19.0
     * @experimental
     */
    insertText(text: string, options?: { inline?: boolean }): void;
    /**
     * Hides or reorders a slot's items, the app's own too. A person's own choices in Appearance → Layout win.
     * @since 0.19.0
     * @experimental
     */
    arrange(slot: SlotName, arrangement: Arrangement): { remove(): void };
    /**
     * Sets how the calls of one of the module's tools show.
     * @since 0.14.0
     */
    toolCall<A = Record<string, unknown>>(spec: ToolCallSpec<A>): { remove(): void };
    /**
     * Opens one of the module's pages.
     * @since 0.14.0
     */
    openPage(id: string): void;
    /**
     * Closes the module's page that shows.
     * @since 0.14.0
     */
    closePage(): void;
    /**
     * Opens one of the module's sheets. Its component gets `props`.
     * @since 0.14.0
     */
    openSheet(id: string, props?: object): void;
    /**
     * Closes the module's sheet that shows.
     * @since 0.14.0
     */
    closeSheet(): void;
    /**
     * Opens one of the module's panels. It takes the place of the panel that shows.
     * @since 0.19.0
     * @experimental
     */
    openPanel(id: string): void;
    /**
     * Closes the module's panel that shows.
     * @since 0.19.0
     * @experimental
     */
    closePanel(): void;
    /**
     * Loads a stylesheet from the browser module's folder.
     * @since 0.14.0
     */
    style(path: string): void;
    /**
     * Runs `dispose` when this version of the browser module goes.
     * @since 0.14.0
     */
    onDispose(dispose: () => void): void;
}
