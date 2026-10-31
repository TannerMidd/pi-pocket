import type { Context } from "@earendil-works/chord";
import { awaitWithContext } from "@earendil-works/chord/context";
import type { ProviderConfig, Skill } from "@earendil-works/pi-coding-agent";
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type {
    ConversationId,
    DocumentReader,
    Extension,
    ModelRef,
    TaskId,
    Tx,
} from "@earendil-works/pi-durable";
import type { Browsers } from "./browser.ts";
import type { Gallery } from "./gallery.ts";
import type { Role, User } from "./config.ts";
import type { Goals } from "./goals.ts";
import type { LancetGuard } from "./lancet.ts";
import type { Memory } from "./memory.ts";
import type { Pip } from "./pip.ts";
import type { PipCompaction } from "./pip-compact.ts";
import type { Schedules } from "./schedules.ts";
import type { BackgroundTasks } from "./background.ts";
import type { Updates } from "./updates.ts";
import type { RepoWatches } from "./repo-watches.ts";
import type { Watches } from "./watches.ts";
import type { FetchPublic } from "./public-fetch.ts";
import type { BrowserControl } from "./browser/page.ts";
import type { CommandEnvProvider, HiddenValue } from "./hidden.ts";
import type { AppEventName, AppEvents } from "./app-events.ts";
import type { SettingField, SettingValue } from "./extension-settings.ts";

export type { SettingField, SettingValue } from "./extension-settings.ts";

export type { AppEventName, AppEvents } from "./app-events.ts";

export type { BrowserControl } from "./browser/page.ts";
export type { CommandEnvProvider, CommandRun, HiddenValue } from "./hidden.ts";

/** A session linked to another, as `host.linkedSessions.list` gives it to the session that asks. */
export interface LinkedSession {
    /** What the asking session calls it: an address of its own, never the session's id. */
    address: string;
    /** Only when everyone who sees the asking session sees this one too. */
    title?: string;
    cwd?: string;
    busy?: boolean;
    archived?: boolean;
}

/**
 * Sessions that a session starts and messages (`linked-sessions.ts`). Each acts as the person Pi works for in `source`,
 * with their checks; a call made again with the same `key` acts once, and returns what the first did.
 */
export interface LinkedSessionsApi {
    /**
     * Start a session linked to `source`, in `cwd` or its folder, with a copy of its agent settings but not its history,
     * and send it `message` as its first message. `model` is `provider/modelId`; `thinking` any level; one the model lacks becomes its nearest lower one, else its lowest.
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
    /** Send `message` to the linked session at address `to`: a follow-up, or with `steer` at its next pause. */
    send(
        source: ConversationId,
        request: { to: string; message: string; steer?: boolean },
        key: string,
    ): Promise<void>;
    /** The sessions linked to `source`, at any distance, that the person Pi works for there sees. */
    list(source: ConversationId): Promise<LinkedSession[]>;
}

/** Human-facing linked sessions, bound to the signed-in person and source of one route request. */
export interface HumanLinkedSession extends LinkedSession {
    conversationId: ConversationId;
}

export interface HumanLinkedSessions {
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
    list(): Promise<HumanLinkedSession[]>;
}

export interface ApprovalRequest {
    id: string;
    conversationId: ConversationId;
    taskId: TaskId;
    /** The model's tool call id, to show the decision on the call's card afterwards. */
    callId?: string;
    tool: string;
    subject: string;
    reason: string;
    score?: number;
    createdAt: number;
    /** Who Pi was working for when the call asked: set by `Approvals`, not by the asker. */
    requestedBy?: string;
    /**
     * A question for a person instead of a call to allow (`host.ask`): what the card asks, and its fields. Only the
     * person Pi works for answers it; anyone who can steer can decline it. Its values go to the asker, never here.
     */
    form?: AskForm;
}

/** What an ask's card shows (`ApprovalRequest.form`). */
export type AskForm = { title: string; text?: string; fields: AskField[]; submit: string };

/** The answer to an approval; an ask's also carries what the person typed, which no one else sees. */
export type ApprovalAnswer = { allow: boolean; by: string; values?: Record<string, string> };

/** An answer to pick on an ask's card (`AskField.choices`): a button with its label, and a line under it. */
export interface AskChoice {
    /** Up to 60 characters, one line: the value when it is chosen. */
    label: string;
    /** Up to 160 characters, one line. */
    description?: string;
}

/** One field of an ask's card. */
export interface AskField {
    /** The value's key in the answer: letters, digits, and _, starting with a letter. */
    name: string;
    /** What the card says above the field: up to 80 characters, or 300 for a field with `choices` (its question). */
    label: string;
    /** A short tag over the field, such as "Database": up to 12 characters. Since 0.27.0. */
    header?: string;
    /**
     * 2 to 4 answers to pick, with different labels, shown as buttons; the value is the label chosen. Since 0.27.0.
     * `secret` and `autocomplete` do not apply to such a field; `placeholder` is for its `other` text.
     */
    choices?: AskChoice[];
    /** With `choices`: one or more can be chosen, and the value is their labels, one per line. Since 0.27.0. */
    multiple?: boolean;
    /** With `choices`: the person can type an answer of their own instead, which is then the value. Since 0.27.0. */
    other?: boolean;
    /** A hidden input, as for a password. */
    secret?: boolean;
    /** What the field shows while empty. */
    placeholder?: string;
    /** A hint for the browser and the phone's keyboard: `username`, `current-password`, `one-time-code`, … */
    autocomplete?: string;
}

/** A question for the person Pi works for, on a card in the session (`host.ask`). */
export interface AskRequest {
    readonly conversationId: ConversationId;
    /** Unique while it waits, and the same when the call asks again: `${api.taskId}:${api.callId}`. */
    readonly id: string;
    /** The task that asks, so the card shows on its call. */
    readonly taskId: TaskId;
    /** The model's tool call id, to show the answer on the call's card. */
    readonly callId?: string;
    /** One line: what is asked, such as "Sign in to example.com". */
    readonly title: string;
    /** More words, such as what to do first. */
    readonly text?: string;
    /** Up to 6 fields; none for a question answered with the button alone ("Done"). */
    readonly fields?: readonly AskField[];
    /** The button's words: "Send" by default, or "Done" with no fields. */
    readonly submit?: string;
}

/** What the person did: answered, with the values they typed, or declined. */
export type AskAnswer =
    | {
          readonly answered: true;
          readonly by: string;
          readonly values: Readonly<Record<string, string>>;
      }
    | { readonly answered: false; readonly by: string };

/** What an extension points at on a page: a ref from the snapshot, a CSS selector, a visible label, or a point. */
export interface BrowserTarget {
    readonly ref?: string;
    readonly selector?: string;
    readonly label?: string;
    readonly x?: number;
    readonly y?: number;
}

/** A session's browser page, as extensions use it (`host.browser`). */
export interface BrowserPageHandle {
    /** The page's address and title now. */
    readonly url: string;
    readonly title: string;
    /** The page as Pi reads it (`text`, with refs such as `[e12]`) and its controls as data. Refs last until the next. */
    snapshot(): Promise<{
        text: string;
        controls: BrowserControl[];
        truncated: boolean;
        /** Where the page is scrolled, in CSS pixels: the viewport's top and height, and the page's height. */
        scroll: { y: number; viewport: number; height: number };
    }>;
    /** What a target is: its description, its kind (an input's type, or a tag), and whether it is a field or a password. */
    inspect(
        target: BrowserTarget,
    ): Promise<{ label: string; kind: string; editable: boolean; password: boolean }>;
    navigate(url: string): Promise<void>;
    click(target: BrowserTarget): Promise<{ label: string; navigated: boolean }>;
    /** Type as Pi types: what is typed can be seen in the page. */
    type(target: BrowserTarget, text: string, options?: { submit?: boolean }): Promise<string>;
    /** Put a person's value into a field, such as a password: core never shows it, and it is not in what comes back. */
    fill(target: BrowserTarget, value: string): Promise<string>;
    select(target: BrowserTarget, value: string): Promise<string>;
    press(key: string): Promise<void>;
    scroll(target?: BrowserTarget, dy?: number): Promise<string>;
    /** Wait until text or a selector shows: true when it did in time. */
    waitFor(options: { text?: string; selector?: string; timeoutMs?: number }): Promise<boolean>;
}

/**
 * Tool calls waiting for a human. In memory on purpose: the guard hook runs before a call's intent is stored, so after
 * a restart the hook runs again and asks again, unless its memo already holds the answer.
 */
export class Approvals {
    readonly #pending = new Map<
        string,
        { request: ApprovalRequest; resolve: (answer: ApprovalAnswer) => void }
    >();
    readonly #listeners = new Set<(conversationId: ConversationId) => void>();
    readonly #requesterOf: (conversationId: ConversationId) => string | undefined;

    /** `requesterOf`: who Pi works for in a conversation right now. */
    constructor(requesterOf: (conversationId: ConversationId) => string | undefined) {
        this.#requesterOf = requesterOf;
    }

    request(asked: ApprovalRequest, context: Context): Promise<ApprovalAnswer> {
        // Who asked is fixed now: someone writing to Pi while the call waits does not become its requester.
        const { requestedBy: _ignored, ...rest } = asked;
        const requestedBy = this.#requesterOf(asked.conversationId);
        const request: ApprovalRequest =
            requestedBy === undefined ? rest : { ...rest, requestedBy };
        const existing = this.#pending.get(request.id);

        if (existing !== undefined) {
            existing.resolve({ allow: false, by: "superseded" });
        }

        const answered = new Promise<ApprovalAnswer>((resolve) => {
            this.#pending.set(request.id, { request, resolve });
        });

        this.#emit(request.conversationId);

        return awaitWithContext(answered, context).finally(() => {
            if (this.#pending.get(request.id)?.request === request) {
                this.#pending.delete(request.id);
                this.#emit(request.conversationId);
            }
        });
    }

    answer(id: string, answer: ApprovalAnswer): boolean {
        const pending = this.#pending.get(id);

        if (pending === undefined) {
            return false;
        }

        this.#pending.delete(id);
        pending.resolve(answer);
        this.#emit(pending.request.conversationId);

        return true;
    }

    forConversation(conversationId: ConversationId): ApprovalRequest[] {
        return [...this.#pending.values()]
            .map((pending) => pending.request)
            .filter((request) => request.conversationId === conversationId);
    }

    all(): ApprovalRequest[] {
        return [...this.#pending.values()].map((pending) => pending.request);
    }

    subscribe(listener: (conversationId: ConversationId) => void): () => void {
        this.#listeners.add(listener);

        return () => this.#listeners.delete(listener);
    }

    #emit(conversationId: ConversationId): void {
        for (const listener of this.#listeners) {
            listener(conversationId);
        }
    }
}

/** What a command gives back: a notice for the person who ran it alone, or a card of plain text for everyone here. */
export type CommandResult =
    | { type: "toast"; level: "info" | "warning" | "error"; message: string }
    | { type: "card"; output: string };

/** Who ran a command and where, with the durable task that runs it: read and change documents through it. */
export interface CommandContext {
    readonly user: Readonly<Pick<User, "id" | "name" | "role">>;
    readonly conversationId: ConversationId;
    readonly cwd: string;
    readonly signal: AbortSignal;
    readonly snapshot: DocumentReader["snapshot"];
    readonly context: Context;
    /** Change documents in one commit; answers what `change` returns. */
    commit<T>(change: (tx: Tx) => T | Promise<T>): Promise<T>;
}

/**
 * A command people run from the message box (`web.command(name, command)`), without asking Pi. `scope` says who may run
 * it: `"conversation"`, whoever may drive the session; `"global"`, the owner alone. Either way it runs in the session it
 * was typed in, and its card goes there.
 */
export interface ExtensionCommand {
    description: string;
    args?: string;
    scope: "conversation" | "global";
    handler(args: string, context: CommandContext): CommandResult | Promise<CommandResult>;
}

/** What browsers know about a command: no handler, and no file. The id changes with each version of its module. */
export type CommandInfo = Omit<ExtensionCommand, "handler"> & { id: string; name: string };

/**
 * Shapes one model request: the payload Pi built and the model. Returns a replacement payload, or undefined to keep
 * it.
 */
export type ModelRequestShaper = (payload: unknown, model: Model<Api>) => unknown | undefined;

/** What the app gives its extensions. Extensions are reloaded on edit; the host is not. */
export interface PocketHost {
    readonly guard: LancetGuard;
    readonly approvals: Approvals;
    readonly agentDir: string;
    readonly dataDir: string;
    /** The running server's Pi Pocket package version, not the extension API level. */
    readonly pocketVersion: string;
    /** Local metadata for an exact provider/modelId; no sign-in check or network request. */
    modelInfo(spec: string):
        | {
              model: ModelRef;
              name: string;
              thinkingLevels: ModelThinkingLevel[];
              contextWindow?: number;
              cost?: { input: number; output: number };
          }
        | undefined;
    /** Pi's configured extra skill paths, from its settings. */
    skillPaths(): string[];
    /** Pi's skills for a session working in `cwd`, from the places Pi looks (`skills.ts`). */
    skills(cwd: string): Skill[];
    /**
     * `provider/modelId` (or a bare model id) to a signed-in model whose sign-in has not expired, or an error that says
     * it is not available. The error names no other models: models are a person's to choose.
     */
    resolveModel(spec: string): ModelRef;
    /**
     * The models Pi may start subagents on, as the owner allowed them (`provider/modelId`).
     * Empty, the default: none.
     */
    subagentModels(): readonly string[];
    /**
     * Why Pi may not use a model now, in words for Pi to pass on (not known here, its provider not signed in, or its
     * sign-in expired), or undefined when it may. `fresh` asks the provider's sign-in again first.
     */
    modelProblem(ref: ModelRef, fresh?: boolean): Promise<string | undefined>;
    /**
     * Register a model provider with Pi's model runtime, as a Pi extension does: `config` is Pi's own provider
     * configuration, including the models it starts with and how it refreshes them. The last registration of a name
     * wins. Returns how to remove it again, which puts back the registration before it; a removal of a registration
     * that is not the last one changes nothing.
     */
    registerModelProvider(provider: string, config: ProviderConfig): () => void;
    /**
     * Shape the request every model call sends: `shape` returns a replacement payload, or undefined to keep it. It runs
     * after Pi and the caller shaped the request, closest to the wire. Returns how to stop shaping. Only the modules
     * the owner turned on shape requests.
     */
    shapeModelRequests(shape: ModelRequestShaper): () => void;
    /**
     * Fetch for an address from outside (a model, a page, a person): it reaches only public internet addresses, checked
     * where each connection is made and at each redirect (`public-fetch.ts`).
     *
     * @experimental In 0.20: it can change in a minor release (docs/extensions/policies/api-stability.md).
     */
    readonly fetchPublic: FetchPublic;
    /** Who Pi works for in a conversation now: whose message led to its current work. */
    requesterOf(conversationId: ConversationId): string | undefined;
    /**
     * The role of a person by id, as core decides it; undefined for an id that is not a person here.
     *
     * @experimental In 0.27: it can change in a minor release (docs/extensions/policies/api-stability.md).
     */
    roleOf(personId: string): Role | undefined;
    /**
     * Listen to what happens in the app: sessions made, renamed, and archived, messages people send to Pi, and
     * runs that start and end. Returns how to stop; pass that to `web.onDispose`. PiP's conversations send none.
     *
     * @experimental In 0.22: it can change in a minor release (docs/extensions/policies/api-stability.md).
     */
    on<E extends AppEventName>(event: E, listener: (data: AppEvents[E]) => unknown): () => void;
    /**
     * Ask the person Pi works for on a card in the session, as an approval asks: their answer, with the values they
     * typed, goes to the extension, never to Pi or into the transcript. Do not keep the values in a memo or a document.
     *
     * @experimental In 0.22: it can change in a minor release (docs/extensions/policies/api-stability.md).
     */
    ask(request: AskRequest, context: Context): Promise<AskAnswer>;
    /**
     * Hide a value from what Pi and people read: command output as it streams, every tool's result, and people's
     * messages to Pi. It shows as `[label]`. Returns how to stop; pass that to `web.onDispose`.
     *
     * @experimental In 0.22: it can change in a minor release (docs/extensions/policies/api-stability.md).
     */
    hide(value: HiddenValue): () => void;
    /**
     * Add environment variables to the commands Pi and people run in sessions (bash, `!` commands, checks), chosen for
     * each command. Returns how to stop; pass that to `web.onDispose`.
     *
     * @experimental In 0.22: it can change in a minor release (docs/extensions/policies/api-stability.md).
     */
    commandEnv(provider: CommandEnvProvider): () => void;
    /**
     * A session's browser page, the one Pi and people use: opened when `open` is true, else only when it is open
     * already. Undefined while the Browser module is off, or with no page.
     *
     * @experimental In 0.22: it can change in a minor release (docs/extensions/policies/api-stability.md).
     */
    browser(
        conversationId: ConversationId,
        options?: { open?: boolean },
    ): Promise<BrowserPageHandle | undefined>;
    /** Report something odd to the log and the connected clients: with `conversationId`, to that session's tabs only. */
    notice(
        level: "info" | "warning" | "error",
        message: string,
        conversationId?: ConversationId,
    ): void;
    /**
     * Why work Pi would start in a conversation with nobody asking (a subagent's report, say) may not start now: the
     * spend limit its session or whoever pays there reached. Undefined when it may.
     */
    heldBack(conversationId: ConversationId): string | undefined;
    /** Call `listener` whenever the owner changes a spend limit; returns how to stop. */
    onLimitsChanged(listener: () => void): () => void;
    /**
     * Sessions that a session starts and messages (`linked-sessions.ts`): each one is an ordinary session, linked to the
     * one that started it. The checks of the person Pi works for apply, and a call repeated with its key acts once.
     *
     * @experimental In 0.14: it can change in a minor release (docs/extensions/policies/api-stability.md).
     */
    readonly linkedSessions: LinkedSessionsApi;
    /** Messages to Pi for later: the schedule tool sets up Pi's own. */
    readonly schedules: Pick<Schedules, "add" | "cancel" | "limits" | "list" | "task">;
    /** Commands Pi runs in the background: the background tool starts, reads, and stops them. */
    readonly background: Pick<
        BackgroundTasks,
        "start" | "read" | "stop" | "list" | "limits" | "task" | "describe"
    >;
    /** Sessions' goals: the goals extension runs their checks and counts them. */
    readonly goals: Pick<Goals, "get" | "run" | "record" | "mayContinue">;
    /** The built-in browser: a page per conversation, which the people in it watch and use too. */
    readonly browsers: Pick<Browsers, "open">;
    /** PiP, the owner's assistant: what its tools do, each as PiP's person (`pip.ts`). */
    readonly pip: Pick<
        Pip,
        | "ownerOf"
        | "ownerName"
        | "task"
        | "sessions"
        | "read"
        | "start"
        | "send"
        | "stop"
        | "archive"
        | "approvals"
        | "deny"
        | "status"
        | "schedules"
        | "schedule"
        | "countSchedule"
        | "cancelSchedule"
        | "follow"
        | "watchPr"
        | "prWatch"
        | "addRepoWatch"
        | "repoWatches"
        | "removeRepoWatch"
    >;
    /** PiP's compactions: its extension's hook has PiP write its own summaries. */
    readonly pipCompaction: Pick<PipCompaction, "summarize">;
    /** Sessions' watches of their pull requests: Pi's watch_pr tool starts and stops them. */
    readonly watches: Pick<Watches, "task" | "start" | "stop" | "get">;
    /** Repository watches: the triggers extension runs their task; PiP's repo_watch tool sets them up. */
    readonly repoWatches: Pick<RepoWatches, "task">;
    /** Lessons Pi keeps across sessions (`memory.ts`): the memory tool saves them, and its section lists them. */
    readonly memory: Pick<Memory, "project" | "applying" | "inForce" | "add" | "change">;
    /**
     * Text from elsewhere made safe for Pi to read (`fence.ts`): `quoted` gives one line, cut to `max`, without
     * invisible characters or any tag, in quotes it cannot close; `defang` keeps the lines, but no closing tag survives,
     * for text put between tags of your own. Tell Pi in the same place that it is data.
     */
    readonly text: { quoted(text: string, max?: number): string; defang(text: string): string };
    /** The thinking levels, lowest first, as a model and a session name them. */
    readonly thinkingLevels: readonly ModelThinkingLevel[];
    /** The extension gallery (`gallery.ts`): its extension's routes are the owner's way to it. */
    readonly gallery: Pick<
        Gallery,
        | "settings"
        | "setIndex"
        | "listing"
        | "installed"
        | "check"
        | "source"
        | "install"
        | "updatePreview"
        | "update"
        | "uninstall"
        | "review"
        | "share"
        | "shareTheme"
        | "reach"
    >;
    /** Updates of Pi Pocket itself (`updates.ts`): its extension's routes are the owner's way to them. */
    readonly updates: Pick<
        Updates,
        "status" | "check" | "apply" | "subscribe" | "setBeta" | "beta"
    >;
}

/**
 * Who may use a module's web part: the owner alone (the default), anyone who can steer, or anyone who can view. People
 * invited to one session never may: a web part belongs to the whole app.
 */
export type WebAccess = "owner" | "steer" | "view";

export type WebMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** A request to a module's route, as its handler gets it. */
export interface WebRequest {
    readonly method: WebMethod;
    /** The path's `:name` parts, by name. */
    readonly params: Readonly<Record<string, string>>;
    readonly query: URLSearchParams;
    /** The JSON object the browser sent; empty for GET and DELETE. */
    readonly body: Readonly<Record<string, unknown>>;
    /** Who asked. */
    readonly user: { readonly id: string; readonly name: string; readonly role: Role };
    /** Aborted when the browser stops waiting for the answer. */
    readonly signal: AbortSignal;
    /** Fresh committed document reads. Use the request's context. */
    readonly snapshot: DocumentReader["snapshot"];
    readonly context: Context;
    /** Change the module's documents; refused for viewers and after this request ends. */
    commit<T>(change: (tx: Tx) => T | Promise<T>): Promise<T>;
    /** The sessions the person who asked can see now, as their session list shows them (archived ones too). */
    sessions(): readonly WebSession[];
}

/** A session in a person's session list, as `WebRequest.sessions` gives it. */
export interface WebSession {
    readonly id: number;
    readonly title: string;
    readonly cwd: string;
    readonly archived: boolean;
    readonly updatedAt: number;
}

/** A route request whose named path parameter resolved to a visible conversation. */
export interface ConversationWebRequest extends WebRequest {
    readonly conversation: {
        readonly id: ConversationId;
        readonly title: string;
        readonly cwd: string;
        readonly model?: ModelRef;
        readonly thinkingLevel: ModelThinkingLevel;
    };
    readonly linkedSessions: HumanLinkedSessions;
}

/**
 * What a route answers: a value sent as JSON (undefined sends `{}`). An error made with `web.error` answers with its
 * status and words; any other throw is a 500, whose words only the owner sees.
 */
export type WebHandler = (request: WebRequest) => unknown;

/** What a module asks for when it makes a public link (`web.links.create`). */
export interface PublicLinkRequest {
    /** How long the link stays open, in hours: more than 0, and 720 (30 days) at most. */
    hours: number;
    /** How many answered posts it takes before it closes; absent: any number until its time. */
    uses?: number;
    /** Who it is for: a person's id, such as the route's `user.id`. */
    by?: string;
    /** The session it is about. */
    conversation?: number;
    /** A small JSON value of the module's own (4 KB at most), given back with the link. */
    data?: unknown;
}

/** A public link, as its module sees it. */
export interface PublicLinkInfo {
    readonly token: string;
    /** `/l/<token>`, on this server. */
    readonly path: string;
    /** The whole address on the server's public one (a tunnel's), when it has one; else null. */
    readonly url: string | null;
    readonly createdAt: number;
    readonly expiresAt: number;
    /** How many answers it takes still, or null for any number. */
    readonly uses: number | null;
    readonly by: string | null;
    readonly conversation: number | null;
    readonly data: unknown;
}

/** A module's public links: pages at `/l/<token>` for anyone with the address, drawn by `web.publicPage`. */
export interface PublicLinks {
    /** Make a link. It always closes: at its time, after its uses, or when the module ends it. */
    create(link: PublicLinkRequest): Promise<PublicLinkInfo>;
    /** One of this module's open links, or undefined. */
    get(token: string): Promise<PublicLinkInfo | undefined>;
    /** This module's open links, newest first. */
    list(): Promise<PublicLinkInfo[]>;
    /** End one of this module's links at once. Whether there was one to end. */
    end(token: string): Promise<boolean>;
}

/** A request to a public link's page, from anyone with its address: there is no person and no sign-in. */
export interface PublicPageRequest {
    readonly method: "GET" | "POST";
    /** The link the address names, still open. */
    readonly link: PublicLinkInfo;
    readonly query: URLSearchParams;
    /** The fields of a posted form; empty for GET. */
    readonly form: Readonly<Record<string, string>>;
    /** Aborted when the browser stops waiting. */
    readonly signal: AbortSignal;
    readonly context: Context;
    readonly snapshot: DocumentReader["snapshot"];
    /** Change the module's own documents; refused after the handler returns. */
    commit<T>(change: (tx: Tx) => T | Promise<T>): Promise<T>;
}

/** A public page's answer: its HTML, with a status (200 when not given). */
export type PublicPageAnswer = string | { html: string; status?: number };

export type PublicPageHandler = (
    request: PublicPageRequest,
) => PublicPageAnswer | Promise<PublicPageAnswer>;

/**
 * A module's own part of the app, the second argument of its default export: routes under `/api/x/<module>/`, a browser
 * module that adds to the app's screens, events from here to that browser module, and commands for the message box.
 * Routes, the browser module, and commands are registered while the module loads; they go with it when it reloads or
 * is turned off.
 */
export interface ExtensionWeb {
    /** The version of this API (`POCKET_API` in `extension-web.ts`). */
    readonly api: number;
    /** The module's name: its file's, without `.ts`. Its routes are under `/api/x/<module>/`. */
    readonly module: string;
    /** Answer `method` requests to `/api/x/<module>/<path>`. A part of `path` written `:name` matches any one part. */
    route(
        method: WebMethod,
        path: string,
        handle: WebHandler,
        options?: { access?: WebAccess },
    ): void;
    /** Bind a named path parameter to a conversation before calling the handler. */
    conversationRoute(
        method: WebMethod,
        path: string,
        handle: (request: ConversationWebRequest) => unknown,
        options: { conversation: string; access?: WebAccess },
    ): void;
    /**
     * The browser module that adds to the app: a `.js` file beside this module, or a folder with an `index.js` and the
     * files it imports. Browsers of the people `access` lets in load it.
     */
    client(entry: string, options?: { access?: WebAccess }): void;
    /**
     * Send the browser module an event (`pocket.on(event, …)` there): to everyone it loads for, or to one person. Never
     * throws: an event it cannot send (not JSON, too large) goes to the server's log instead.
     */
    send(event: string, data?: unknown, options?: { to?: string }): void;
    /** An error for a route to throw: whoever asked gets `status` (400 to 599) and `message` as they are. */
    error(status: number, message: string): Error;
    /**
     * Run `dispose` when this version of the module goes: replaced by an edit, turned off, or the server stopping. It
     * may return a promise: a stopping server waits for it, up to 3 s.
     */
    onDispose(dispose: () => unknown): void;
    /**
     * A command people run from the message box as `/name`, while the module loads. It goes with this version of the
     * module, as routes do. `scope: "conversation"` is for whoever may drive the session; `"global"` is the owner's.
     */
    command(name: string, command: ExtensionCommand): void;
    /**
     * Draw the module's public pages: what anyone with one of its links (`web.links`) sees, with no sign-in, at
     * `/l/<token>`. GET shows the page; a form on it posts back to the same address. One handler for each module.
     */
    publicPage(handle: PublicPageHandler): void;
    /** Make, list, and end the module's public links. Usable while the module runs, not only while it loads. */
    readonly links: PublicLinks;
    /** Offer other modules an object of the module's own (`web.use(module)` there). One for each module, while it loads. */
    provide(service: object): void;
    /** The service a module that is on offers now, or undefined. Ask again each time: a reload replaces it. */
    use(module: string): unknown;
    /** Hear when a module's service comes, changes, or goes. Returns how to stop; it stops when this version goes. */
    onService(module: string, listener: () => void): () => void;
    /** Declare the module's settings, while it loads: core keeps the owner's values and shows them in Extensions. */
    settings(fields: readonly SettingField[]): void;
    /** A setting's value now: the owner's, or its default. */
    setting(name: string): SettingValue | undefined;
    /** Hear when the owner changes the module's settings. Returns how to stop; it stops when this version goes. */
    onSettings(listener: () => void): () => void;
}

/** The shape of every module in `src/server/extensions/`: a default export building one or more extensions. */
export type ExtensionModule = {
    /** Builds the module's extensions; a module that only adds to the app returns nothing. It may be async. */
    default: (
        host: PocketHost,
        web: ExtensionWeb,
    ) => Extension | readonly Extension[] | void | Promise<Extension | readonly Extension[] | void>;
    /** The version of the extension API the module needs, when it says: a newer one than the app's is not loaded. */
    pocketApi?: unknown;
};
