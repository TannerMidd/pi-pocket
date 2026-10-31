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
import type { ProviderConfig, Skill } from "@earendil-works/pi-coding-agent";
import type {
    ConversationId,
    DocumentReader,
    Extension,
    ModelRef,
    TaskId,
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
    modelInfo(spec: string):
        | {
              model: ModelRef;
              name: string;
              thinkingLevels: ModelThinkingLevel[];
              /** @since 0.20.0, tokens; 0 when unknown */
              contextWindow?: number;
              /** @since 0.20.0, dollars per million tokens; left out when unknown or free */
              cost?: { input: number; output: number };
          }
        | undefined;
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
     * Registers a model provider with Pi's model runtime, as a Pi extension does. `config` is Pi's own provider
     * configuration, including the models it starts with and how it refreshes them. The last registration of a name
     * wins. The return value removes it again and puts back the registration before it; pass it to `web.onDispose`. A
     * removal of a registration that is not the last one changes nothing.
     * @since 0.20.0
     * @experimental
     */
    registerModelProvider(provider: string, config: ProviderConfig): () => void;
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
     * The role of a person by id: `"owner"`, `"guest"`, or `"viewer"`. It is `undefined` for an id that is not a person here.
     * @since 0.27.0
     * @experimental
     */
    roleOf(personId: string): Role | undefined;
    /**
     * Listens to what happens in the app: sessions made, renamed, and archived, messages people send to Pi, and runs that start and end. Returns how to stop: pass it to `web.onDispose`. PiP's conversations send none.
     * @since 0.22.0
     * @experimental
     */
    on<E extends AppEventName>(event: E, listener: (data: AppEvents[E]) => unknown): () => void;
    /**
     * Asks the person Pi works for on a card in the session: their answer, with what they typed, goes to the extension, never to Pi or into the transcript. Do not keep the values in a memo or a document.
     * @since 0.22.0
     * @experimental
     */
    ask(request: AskRequest, context: Context): Promise<AskAnswer>;
    /**
     * Hides a value from what Pi and people read: command output as it streams, each tool's result, and people's messages to Pi. It shows as `[label]`. Returns how to stop: pass it to `web.onDispose`.
     * @since 0.22.0
     * @experimental
     */
    hide(value: HiddenValue): () => void;
    /**
     * Adds environment variables to the commands that run in sessions (bash, `!` commands, checks), chosen for each command. Returns how to stop: pass it to `web.onDispose`.
     * @since 0.22.0
     * @experimental
     */
    commandEnv(provider: CommandEnvProvider): () => void;
    /**
     * A session's browser page, the one Pi and people use: opened when `open` is true, else only when it is open already. Undefined while the Browser module is off.
     * @since 0.22.0
     * @experimental
     */
    browser(
        conversationId: ConversationId,
        options?: { open?: boolean },
    ): Promise<BrowserPageHandle | undefined>;
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
     * Fetches an address from outside (from Pi, a page, or a person) as `fetch` does, but refuses non-public ranges
     * and current local interface addresses. It checks literal addresses, every DNS answer, and each redirect.
     * Public addresses routed back into the network (NAT reflection or internal public ranges) are not detected.
     * A refusal throws an `Error` with a `code`: `"POCKET_NOT_PUBLIC"`, `"POCKET_TOO_LARGE"`, or
     * `"POCKET_REDIRECTS"`.
     * @since 0.20.0
     * @experimental
     */
    fetchPublic(url: string | URL, init?: PublicFetchInit): Promise<Response>;
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
 * The events of `host.on`, and what each listener gets.
 * @since 0.22.0
 * @experimental
 */
export interface AppEvents {
    /**
     * A session was made: by a person, a fork, a linked start, or a resend.
     * @since 0.22.0
     * @experimental
     */
    "session.created": {
        conversationId: number;
        cwd: string;
        createdBy?: string;
        forkedFrom?: number;
        linkedFrom?: number;
    };
    /**
     * A session got a new title.
     * @since 0.22.0
     * @experimental
     */
    "session.renamed": { conversationId: number; title: string };
    /**
     * A session was archived, or brought back.
     * @since 0.22.0
     * @experimental
     */
    "session.archived": { conversationId: number; archived: boolean };
    /**
     * A person sent Pi a message: its words as stored, attachments left out. `via` names what sent it for them.
     * @since 0.22.0
     * @experimental
     */
    "message.sent": {
        conversationId: number;
        by: string;
        submissionId: string;
        text: string;
        via?: string;
    };
    /**
     * Pi started to work in a conversation, a session's or a subagent's. `session` is its session.
     * @since 0.22.0
     * @experimental
     */
    "run.started": { conversationId: number; session: number };
    /**
     * Pi stopped working in a conversation.
     * @since 0.22.0
     * @experimental
     */
    "run.ended": { conversationId: number; session: number };
}

/**
 * The name of an event of `host.on`.
 * @since 0.22.0
 * @experimental
 */
export type AppEventName = keyof AppEvents;

/**
 * One setting that a module declares (`web.settings`).
 * @since 0.22.0
 * @experimental
 */
export type SettingField =
    | { name: string; label: string; description?: string; type: "boolean"; default?: boolean }
    | {
          name: string;
          label: string;
          description?: string;
          type: "text";
          default?: string;
          placeholder?: string;
          secret?: boolean;
      }
    | {
          name: string;
          label: string;
          description?: string;
          type: "number";
          default?: number;
          min?: number;
          max?: number;
      }
    | {
          name: string;
          label: string;
          description?: string;
          type: "choice";
          default?: string;
          choices: { value: string; label: string }[];
      };

/**
 * A setting's value.
 * @since 0.22.0
 * @experimental
 */
export type SettingValue = string | number | boolean;

/**
 * A question for the person Pi works for, on a card in the session (`host.ask`).
 * @since 0.22.0
 * @experimental
 */
export interface AskRequest {
    /**
     * The session to ask in.
     * @since 0.22.0
     * @experimental
     */
    readonly conversationId: ConversationId;
    /**
     * Unique while it waits, and the same when the call asks again: `${api.taskId}:${api.callId}`.
     * @since 0.22.0
     * @experimental
     */
    readonly id: string;
    /**
     * The task that asks, so the card shows with its call.
     * @since 0.22.0
     * @experimental
     */
    readonly taskId: TaskId;
    /**
     * The model's tool call id, to show the answer on the call's card.
     * @since 0.22.0
     * @experimental
     */
    readonly callId?: string;
    /**
     * One line: what is asked, such as "Sign in to example.com".
     * @since 0.22.0
     * @experimental
     */
    readonly title: string;
    /**
     * More words, up to 2000 characters.
     * @since 0.22.0
     * @experimental
     */
    readonly text?: string;
    /**
     * Up to 6 fields; none for a question answered with the button alone.
     * @since 0.22.0
     * @experimental
     */
    readonly fields?: readonly AskField[];
    /**
     * The button's words: "Send" by default, "Done" with no fields.
     * @since 0.22.0
     * @experimental
     */
    readonly submit?: string;
}

/**
 * One field of an ask's card.
 * @since 0.22.0
 * @experimental
 */
export interface AskField {
    /**
     * The value's key in the answer: letters, digits, and _, starting with a letter.
     * @since 0.22.0
     * @experimental
     */
    name: string;
    /**
     * What the card says above the field: one line of up to 80 characters, or 300 for a field with `choices`.
     * @since 0.22.0
     * @experimental
     */
    label: string;
    /**
     * A short tag over the field, such as "Database": up to 12 characters.
     * @since 0.27.0
     * @experimental
     */
    header?: string;
    /**
     * 2 to 4 answers to pick, with different labels, shown as buttons: the value is the label chosen. `secret` and
     * `autocomplete` do not apply to such a field; its `placeholder` is for its `other` text.
     * @since 0.27.0
     * @experimental
     */
    choices?: AskChoice[];
    /**
     * With `choices`: one or more can be chosen, and the value is their labels, one per line.
     * @since 0.27.0
     * @experimental
     */
    multiple?: boolean;
    /**
     * With `choices`: the person can type an answer of their own instead, which is then the value.
     * @since 0.27.0
     * @experimental
     */
    other?: boolean;
    /**
     * A hidden input, as for a password.
     * @since 0.22.0
     * @experimental
     */
    secret?: boolean;
    /**
     * What the field shows while empty.
     * @since 0.22.0
     * @experimental
     */
    placeholder?: string;
    /**
     * A hint for the browser and the phone's keyboard, such as `current-password` or `one-time-code`.
     * @since 0.22.0
     * @experimental
     */
    autocomplete?: string;
}

/**
 * An answer to pick on an ask's card (`AskField.choices`).
 * @since 0.27.0
 * @experimental
 */
export interface AskChoice {
    /**
     * One line of up to 60 characters: the field's value when it is chosen.
     * @since 0.27.0
     * @experimental
     */
    label: string;
    /**
     * One line of up to 160 characters, under the label.
     * @since 0.27.0
     * @experimental
     */
    description?: string;
}

/**
 * What the person did with an ask: answered, with what they typed in each field, or declined.
 * @since 0.22.0
 * @experimental
 */
export type AskAnswer =
    | {
          readonly answered: true;
          readonly by: string;
          readonly values: Readonly<Record<string, string>>;
      }
    | { readonly answered: false; readonly by: string };

/**
 * A value core hides (`host.hide`).
 * @since 0.22.0
 * @experimental
 */
export interface HiddenValue {
    /**
     * The text to hide: 4 to 4096 characters.
     * @since 0.22.0
     * @experimental
     */
    value: string;
    /**
     * What shows in its place, as `[label]`: letters, digits, spaces, and _ . : -.
     * @since 0.22.0
     * @experimental
     */
    label: string;
    /**
     * Only in this session; absent: in every session.
     * @since 0.22.0
     * @experimental
     */
    conversationId?: number;
}

/**
 * A command about to run, as a `host.commandEnv` provider gets it.
 * @since 0.22.0
 * @experimental
 */
export interface CommandRun {
    /**
     * The session it runs in.
     * @since 0.22.0
     * @experimental
     */
    readonly conversationId: number;
    /**
     * The command as the shell gets it, or a program and its arguments.
     * @since 0.22.0
     * @experimental
     */
    readonly command: string | readonly string[];
    /**
     * The folder it runs in.
     * @since 0.22.0
     * @experimental
     */
    readonly cwd: string;
}

/**
 * Gives the environment variables to add to one command, or nothing.
 * @since 0.22.0
 * @experimental
 */
export type CommandEnvProvider = (
    run: CommandRun,
) => Record<string, string> | undefined | Promise<Record<string, string> | undefined>;

/**
 * What an extension points at on a page: a ref from the snapshot, a CSS selector, a visible label, or a point.
 * @since 0.22.0
 * @experimental
 */
export interface BrowserTarget {
    /**
     * A ref from the last snapshot, such as `e12`.
     * @since 0.22.0
     * @experimental
     */
    readonly ref?: string;
    /**
     * A CSS selector.
     * @since 0.22.0
     * @experimental
     */
    readonly selector?: string;
    /**
     * The element's visible text or label.
     * @since 0.22.0
     * @experimental
     */
    readonly label?: string;
    /**
     * A point in CSS pixels of the viewport, with `y`.
     * @since 0.22.0
     * @experimental
     */
    readonly x?: number;
    /**
     * A point in CSS pixels of the viewport, with `x`.
     * @since 0.22.0
     * @experimental
     */
    readonly y?: number;
}

/**
 * One control of a page's snapshot, as data. A password field's value is `••••` when it holds one.
 * @since 0.22.0
 * @experimental
 */
export interface BrowserControl {
    /**
     * Its ref, until the next snapshot.
     * @since 0.22.0
     * @experimental
     */
    ref: string;
    /**
     * Its role: `button`, `link`, `textbox`, `checkbox`, …, or `clickable`.
     * @since 0.22.0
     * @experimental
     */
    role: string;
    /**
     * Its accessible name.
     * @since 0.22.0
     * @experimental
     */
    name: string;
    /**
     * An input's type (`text`, `password`, `email`, …), `textarea`, `select`, or the element's tag.
     * @since 0.22.0
     * @experimental
     */
    kind: string;
    /**
     * Whether it is disabled.
     * @since 0.22.0
     * @experimental
     */
    disabled: boolean;
    /**
     * Whether it is in the viewport now.
     * @since 0.22.0
     * @experimental
     */
    inView: boolean;
    /**
     * A field's or a select's value.
     * @since 0.22.0
     * @experimental
     */
    value?: string;
    /**
     * A field's placeholder.
     * @since 0.22.0
     * @experimental
     */
    placeholder?: string;
    /**
     * A checkbox's or radio button's state.
     * @since 0.22.0
     * @experimental
     */
    checked?: boolean;
    /**
     * A select's options, up to 50.
     * @since 0.22.0
     * @experimental
     */
    options?: string[];
    /**
     * A link's address.
     * @since 0.22.0
     * @experimental
     */
    href?: string;
}

/**
 * A session's browser page, as extensions use it (`host.browser`).
 * @since 0.22.0
 * @experimental
 */
export interface BrowserPageHandle {
    /**
     * The page's address now.
     * @since 0.22.0
     * @experimental
     */
    readonly url: string;
    /**
     * The page's title now.
     * @since 0.22.0
     * @experimental
     */
    readonly title: string;
    /**
     * The page as Pi reads it, with refs such as `[e12]`, and its controls as data. Refs last until the next snapshot.
     * @since 0.22.0
     * @experimental
     */
    snapshot(): Promise<{
        text: string;
        controls: BrowserControl[];
        truncated: boolean;
        /**
         * Where the page is scrolled, in CSS pixels: `y` is the top of the viewport, `viewport` its height, and `height` the page's.
         * @since 0.27.0
         * @experimental
         */
        scroll: { y: number; viewport: number; height: number };
    }>;
    /**
     * What a target is: its description, its kind, and whether it is a field or a password field.
     * @since 0.22.0
     * @experimental
     */
    inspect(
        target: BrowserTarget,
    ): Promise<{ label: string; kind: string; editable: boolean; password: boolean }>;
    /**
     * Opens an http(s) address, host:port, or a file path.
     * @since 0.22.0
     * @experimental
     */
    navigate(url: string): Promise<void>;
    /**
     * Clicks a target.
     * @since 0.22.0
     * @experimental
     */
    click(target: BrowserTarget): Promise<{ label: string; navigated: boolean }>;
    /**
     * Types into a target as Pi types.
     * @since 0.22.0
     * @experimental
     */
    type(target: BrowserTarget, text: string, options?: { submit?: boolean }): Promise<string>;
    /**
     * Puts a person's value into a field, such as a password: the value is not in what comes back.
     * @since 0.22.0
     * @experimental
     */
    fill(target: BrowserTarget, value: string): Promise<string>;
    /**
     * Picks an option of a select element by its value or text.
     * @since 0.22.0
     * @experimental
     */
    select(target: BrowserTarget, value: string): Promise<string>;
    /**
     * Presses a key or a combination, such as `Enter`.
     * @since 0.22.0
     * @experimental
     */
    press(key: string): Promise<void>;
    /**
     * Scrolls a target into view, or the page by `dy` pixels.
     * @since 0.22.0
     * @experimental
     */
    scroll(target?: BrowserTarget, dy?: number): Promise<string>;
    /**
     * Waits until text or a selector shows: true when it did in time.
     * @since 0.22.0
     * @experimental
     */
    waitFor(options: { text?: string; selector?: string; timeoutMs?: number }): Promise<boolean>;
}

/**
 * What `host.fetchPublic` takes besides the address: a part of `fetch`'s own init, and its limits.
 * @since 0.20.0
 * @experimental
 */
export interface PublicFetchInit {
    /** `GET` by default. */
    method?: string;
    headers?: Record<string, string> | [string, string][] | Headers;
    /** Kept as it is, so a 307 or 308 redirect can send it again. */
    body?: string | Uint8Array;
    signal?: AbortSignal;
    /** `"follow"` (default) checks each address it goes to; `"manual"` gives the redirect; `"error"` throws on one. */
    redirect?: "follow" | "manual" | "error";
    /** Redirects to follow at most: 5 by default, 20 at most. */
    maxRedirects?: number;
    /** The body's size at most, decoded, in bytes: 10 MiB by default. A larger body errors when it is read. */
    maxBytes?: number;
    /** The whole request at most, body included, in milliseconds: 30 s by default. */
    timeoutMs?: number;
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
     * message. `model` is `provider/modelId`; `thinking` is any level (since 0.25.0; before, no higher than the source's). `cwd` is since 0.19.0:
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
     * Explicit thinking must be a level the model supports; since 0.25.0 it can be above the source's.
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
    /**
     * The sessions that the person who asked can see now, as their session list shows them, archived ones too.
     * @since 0.20.0
     * @experimental
     */
    sessions(): readonly WebSession[];
}

/**
 * A session in a person's session list, as `WebRequest.sessions` gives it.
 * @since 0.20.0
 * @experimental
 */
export interface WebSession {
    /**
     * The session's id, a number as in its address (`/s/12`).
     * @since 0.20.0
     * @experimental
     */
    readonly id: number;
    /**
     * Its title.
     * @since 0.20.0
     * @experimental
     */
    readonly title: string;
    /**
     * Its folder.
     * @since 0.20.0
     * @experimental
     */
    readonly cwd: string;
    /**
     * Whether it is archived.
     * @since 0.20.0
     * @experimental
     */
    readonly archived: boolean;
    /**
     * When it last moved up the list, in milliseconds since 1970.
     * @since 0.20.0
     * @experimental
     */
    readonly updatedAt: number;
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
 * What a module asks for when it makes a public link (`web.links.create`).
 * @since 0.22.0
 * @experimental
 */
export interface PublicLinkRequest {
    /**
     * How long the link stays open, in hours: more than 0, and 720 (30 days) at most.
     * @since 0.22.0
     * @experimental
     */
    hours: number;
    /**
     * How many answered posts it takes before it closes. Without it, any number until its time.
     * @since 0.22.0
     * @experimental
     */
    uses?: number;
    /**
     * Who it is for: a person's id, such as a route's `user.id`.
     * @since 0.22.0
     * @experimental
     */
    by?: string;
    /**
     * The session it is about.
     * @since 0.22.0
     * @experimental
     */
    conversation?: number;
    /**
     * A small JSON value of the module's own, up to 4 KB, given back with the link.
     * @since 0.22.0
     * @experimental
     */
    data?: unknown;
}

/**
 * A public link, as its module sees it.
 * @since 0.22.0
 * @experimental
 */
export interface PublicLinkInfo {
    /**
     * The link's token: 32 hex characters, the whole of its access.
     * @since 0.22.0
     * @experimental
     */
    readonly token: string;
    /**
     * Its address on this server: `/l/<token>`.
     * @since 0.22.0
     * @experimental
     */
    readonly path: string;
    /**
     * Its whole address on the server's public one (a tunnel's), or null when the server has none.
     * @since 0.22.0
     * @experimental
     */
    readonly url: string | null;
    /**
     * When it was made, in milliseconds since 1970.
     * @since 0.22.0
     * @experimental
     */
    readonly createdAt: number;
    /**
     * When it closes, in milliseconds since 1970.
     * @since 0.22.0
     * @experimental
     */
    readonly expiresAt: number;
    /**
     * How many answers it takes still, or null for any number.
     * @since 0.22.0
     * @experimental
     */
    readonly uses: number | null;
    /**
     * Who it is for, as the module said, or null.
     * @since 0.22.0
     * @experimental
     */
    readonly by: string | null;
    /**
     * The session it is about, as the module said, or null.
     * @since 0.22.0
     * @experimental
     */
    readonly conversation: number | null;
    /**
     * The module's own value, or null.
     * @since 0.22.0
     * @experimental
     */
    readonly data: unknown;
}

/**
 * A module's public links: pages at `/l/<token>` for anyone with the address, which `web.publicPage` draws.
 * @since 0.22.0
 * @experimental
 */
export interface PublicLinks {
    /**
     * Makes a link. It always closes: at its time, after its uses, or when the module ends it.
     * @since 0.22.0
     * @experimental
     */
    create(link: PublicLinkRequest): Promise<PublicLinkInfo>;
    /**
     * One of this module's open links, or undefined.
     * @since 0.22.0
     * @experimental
     */
    get(token: string): Promise<PublicLinkInfo | undefined>;
    /**
     * This module's open links, newest first.
     * @since 0.22.0
     * @experimental
     */
    list(): Promise<PublicLinkInfo[]>;
    /**
     * Ends one of this module's links at once. It gives whether there was one to end.
     * @since 0.22.0
     * @experimental
     */
    end(token: string): Promise<boolean>;
}

/**
 * A request to a public link's page, from anyone with its address. There is no person and no sign-in.
 * @since 0.22.0
 * @experimental
 */
export interface PublicPageRequest {
    /**
     * `GET` shows the page; `POST` is a form on it, sent back to the same address.
     * @since 0.22.0
     * @experimental
     */
    readonly method: "GET" | "POST";
    /**
     * The link that the address names. It is still open.
     * @since 0.22.0
     * @experimental
     */
    readonly link: PublicLinkInfo;
    /**
     * The query string.
     * @since 0.22.0
     * @experimental
     */
    readonly query: URLSearchParams;
    /**
     * The fields of a posted form. Empty for `GET`.
     * @since 0.22.0
     * @experimental
     */
    readonly form: Readonly<Record<string, string>>;
    /**
     * Aborted when the browser stops waiting.
     * @since 0.22.0
     * @experimental
     */
    readonly signal: AbortSignal;
    /**
     * The context for document reads and writes. It ends when the handler returns.
     * @since 0.22.0
     * @experimental
     */
    readonly context: Context;
    /**
     * Reads committed documents.
     * @since 0.22.0
     * @experimental
     */
    readonly snapshot: DocumentReader["snapshot"];
    /**
     * Changes the module's own documents. Refused after the handler returns.
     * @since 0.22.0
     * @experimental
     */
    commit<T>(change: (tx: Tx) => T | Promise<T>): Promise<T>;
}

/**
 * A public page's answer: its HTML, or its HTML with a status (200 when not given).
 * @since 0.22.0
 * @experimental
 */
export type PublicPageAnswer = string | { html: string; status?: number };

/**
 * Draws a module's public pages.
 * @since 0.22.0
 * @experimental
 */
export type PublicPageHandler = (
    request: PublicPageRequest,
) => PublicPageAnswer | Promise<PublicPageAnswer>;

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
    /**
     * Draws the module's public pages: what anyone with one of its links sees at `/l/<token>`, with no sign-in. One
     * handler for each module.
     * @since 0.22.0
     * @experimental
     */
    publicPage(handle: PublicPageHandler): void;
    /**
     * Makes, lists, and ends the module's public links. It works while the module runs, not only while it loads.
     * @since 0.22.0
     * @experimental
     */
    readonly links: PublicLinks;
    /**
     * Offers other modules an object of this module's own, which they get with `web.use(module)`. One for each module, while it loads.
     * @since 0.22.0
     * @experimental
     */
    provide(service: object): void;
    /**
     * The service that a module that is on offers now, or `undefined`. Ask again each time that you need it: a reload replaces it.
     * @since 0.22.0
     * @experimental
     */
    use(module: string): unknown;
    /**
     * Calls `listener` when a module's service comes, changes, or goes. Returns how to stop. It stops when this version of the module goes.
     * @since 0.22.0
     * @experimental
     */
    onService(module: string, listener: () => void): () => void;
    /**
     * Declares the module's settings, while it loads. Core keeps the owner's values, and shows the settings in the Extensions sheet.
     * @since 0.22.0
     * @experimental
     */
    settings(fields: readonly SettingField[]): void;
    /**
     * A setting's value now: the owner's, or its default.
     * @since 0.22.0
     * @experimental
     */
    setting(name: string): SettingValue | undefined;
    /**
     * Calls `listener` when the owner changes the module's settings. Returns how to stop. It stops when this version of the module goes.
     * @since 0.22.0
     * @experimental
     */
    onSettings(listener: () => void): () => void;
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
 * A row in the menu's App or Session group.
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
    /**
     * The menu group. Defaults to "app"; "session" shows only in a session.
     * Older apps ignore this field and use the App group.
     * @since 0.21.0
     * @experimental
     */
    group?: "app" | "session";
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
 * A session as the session list's extension points get it.
 * @since 0.20.0
 * @experimental
 */
export interface SessionInfo {
    /**
     * The session's id, a number as in its address (`/s/12`).
     * @since 0.20.0
     * @experimental
     */
    readonly id: number;
    /**
     * Its title.
     * @since 0.20.0
     * @experimental
     */
    readonly title: string;
    /**
     * Its folder.
     * @since 0.20.0
     * @experimental
     */
    readonly cwd: string;
    /**
     * Whether it is archived.
     * @since 0.20.0
     * @experimental
     */
    readonly archived: boolean;
    /**
     * When it last moved up the list, in milliseconds since 1970.
     * @since 0.20.0
     * @experimental
     */
    readonly updatedAt: number;
}

/**
 * A chip under a session's title.
 * @since 0.20.0
 * @experimental
 */
export interface SessionChip {
    /**
     * Its words, cut to 32 characters.
     * @since 0.20.0
     * @experimental
     */
    label: string;
    /**
     * Its tooltip. By default, its label.
     * @since 0.20.0
     * @experimental
     */
    title?: string;
    /**
     * What a tap on it does. Without it, the chip only shows, and a tap opens the session.
     * @since 0.20.0
     * @experimental
     */
    run?: () => unknown;
}

/**
 * Chips under the titles of session rows. Each row calls `chips` when it draws; unchanged rows can skip a draw.
 * @since 0.20.0
 * @experimental
 */
export interface SessionChipsSpec {
    /**
     * The chips' id in the module.
     * @since 0.20.0
     * @experimental
     */
    id: string;
    /**
     * The chips for a session: up to 6 show. Keep it fast, and do not call `pocket` in it.
     * @since 0.20.0
     * @experimental
     */
    chips: (session: SessionInfo) => readonly SessionChip[];
}

/**
 * An action on one or more sessions. `run` gets their ids; a sheet gets them as the prop `sessions`.
 * @since 0.20.0
 * @experimental
 */
export type SessionActionSpec = (
    | { run: (sessions: readonly number[]) => unknown; sheet?: never }
    | { sheet: string; run?: never }
) & {
    /**
     * The action's id in the module.
     * @since 0.20.0
     * @experimental
     */
    id: string;
    /**
     * The action's words, cut to 24 characters.
     * @since 0.20.0
     * @experimental
     */
    label: string;
    /**
     * Who it shows to: `"steer"` (by default), people who can steer, or `"view"`, viewers too.
     * @since 0.20.0
     * @experimental
     */
    access?: "steer" | "view";
    /**
     * The name of one of the app's icons. An action with an icon is also a button on rows, where a mouse hovers.
     * @since 0.20.0
     * @experimental
     */
    icon?: string;
    /**
     * An icon of your own: a stroked path in a 24 × 24 box.
     * @since 0.20.0
     * @experimental
     */
    iconPath?: string;
};

/**
 * A filter button beside the session search. A tap does its one thing, such as open a sheet that sets `match`.
 * @since 0.20.0
 * @experimental
 */
export type SessionFilterSpec = Action & {
    /**
     * The button's id in the module.
     * @since 0.20.0
     * @experimental
     */
    id: string;
    /**
     * The button's label.
     * @since 0.20.0
     * @experimental
     */
    title: string;
    /**
     * The name of one of the app's icons.
     * @since 0.20.0
     * @experimental
     */
    icon?: string;
    /**
     * An icon of your own: a stroked path in a 24 × 24 box.
     * @since 0.20.0
     * @experimental
     */
    iconPath?: string;
    /**
     * A short count or word on the button, such as how many choices are on.
     * @since 0.20.0
     * @experimental
     */
    badge?: number | string | null | false;
    /**
     * Whether the list keeps a session. While it is set, the filter is on and the button is lit; null turns it off.
     * @since 0.20.0
     * @experimental
     */
    match?: ((session: SessionInfo) => boolean) | null;
    /**
     * Runs when a person starts a session with New in the session list while the filter is on. It gets the new
     * session's id, so that the module can make it meet the filter.
     * @since 0.20.0
     * @experimental
     */
    started?: (id: number) => unknown;
};

/**
 * Words that find sessions. The session list's search and the launcher call `words` for each session as they search.
 * @since 0.20.0
 * @experimental
 */
export interface SessionSearchSpec {
    /**
     * The words' id in the module.
     * @since 0.20.0
     * @experimental
     */
    id: string;
    /**
     * The words for a session: up to 32. Keep it fast, and do not call `pocket` in it.
     * @since 0.20.0
     * @experimental
     */
    words: (session: SessionInfo) => readonly string[];
}

/**
 * What `pocket.messages` reads.
 * @since 0.20.0
 * @experimental
 */
export interface MessagesOptions {
    /**
     * The cursor a page gave, for the messages before it. Null or none: the newest.
     * @since 0.20.0
     * @experimental
     */
    before?: string | null;
    /**
     * How many messages, from 1 to 200. Default 50.
     * @since 0.20.0
     * @experimental
     */
    limit?: number;
    /**
     * Stops the read: the promise rejects with an AbortError.
     * @since 0.20.0
     * @experimental
     */
    signal?: AbortSignal;
}

/**
 * A page of the people's messages in a session, oldest first.
 * @since 0.20.0
 * @experimental
 */
export interface MessagePage {
    /**
     * The session the page is from: the one the tab showed when it was asked for.
     * @since 0.20.0
     * @experimental
     */
    readonly conversationId: number | null;
    /**
     * The messages, oldest first.
     * @since 0.20.0
     * @experimental
     */
    readonly messages: readonly MessageInfo[];
    /**
     * The cursor for the page before this one, or null at the start.
     * @since 0.20.0
     * @experimental
     */
    readonly before: string | null;
}

/**
 * A person's message in a session.
 * @since 0.20.0
 * @experimental
 */
export interface MessageInfo {
    /**
     * The message's id, for `pocket.reveal`. It names this message only, also after a reload.
     * @since 0.20.0
     * @experimental
     */
    readonly id: string;
    /**
     * What the person wrote, without attached files: up to 1,000 characters.
     * @since 0.20.0
     * @experimental
     */
    readonly text: string;
    /**
     * Whether `text` was cut.
     * @since 0.20.0
     * @experimental
     */
    readonly clipped: boolean;
    /**
     * Who wrote it, when known.
     * @since 0.20.0
     * @experimental
     */
    readonly by: { readonly id: string | null; readonly name: string | null };
    /**
     * When it was sent, in milliseconds since 1970 on the server's clock, when known.
     * @since 0.20.0
     * @experimental
     */
    readonly at: number | null;
}

/**
 * A message box, as a key's `run` gets it: its text and selection when the key came, and `set`.
 * @since 0.20.0
 * @experimental
 */
export interface ComposerBox {
    /**
     * Which box: the session's message box, or PiP's.
     * @since 0.20.0
     * @experimental
     */
    readonly where: "session" | "pip";
    /**
     * The box's text when the key came.
     * @since 0.20.0
     * @experimental
     */
    readonly text: string;
    /**
     * Where the selection starts: the caret, when nothing is selected.
     * @since 0.20.0
     * @experimental
     */
    readonly start: number;
    /**
     * Where the selection ends: `start`, when nothing is selected.
     * @since 0.20.0
     * @experimental
     */
    readonly end: number;
    /**
     * Writes new text, as typing does, so the draft is kept, and puts the caret at `start` (default: the end), or
     * selects up to `end`.
     * @since 0.20.0
     * @experimental
     */
    set(text: string, start?: number, end?: number): void;
}

/**
 * A key in the message boxes, the session's and PiP's. It comes before the box's own keys.
 * @since 0.20.0
 * @experimental
 */
export interface ComposerKeySpec {
    /**
     * The key's id in the module.
     * @since 0.20.0
     * @experimental
     */
    id: string;
    /**
     * The key, such as `"Ctrl+W"`, `"Alt+Backspace"`, or `"Mod+Shift+K"`, or a list of up to 8.
     * @since 0.20.0
     * @experimental
     */
    keys: string | readonly string[];
    /**
     * What it does, for the Keyboard shortcuts sheet.
     * @since 0.20.0
     * @experimental
     */
    label: string;
    /**
     * Runs when the key is pressed in a box. Return `false` to let the key through; anything else takes it.
     * @since 0.20.0
     * @experimental
     */
    run: (box: ComposerBox) => unknown;
}

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
 * What `pocket.pip.ask` answers. It does not throw when PiP is not there: `reason` tells why nothing happened. `sent` is
 * false when the text waits in PiP's message box.
 * @since 0.26.0
 * @experimental
 */
export type PipAskResult = { ok: true; sent: boolean } | { ok: false; reason: string };

/**
 * The part of `pocket` that talks to PiP.
 * @since 0.26.0
 * @experimental
 */
export interface PipApi {
    /**
     * Gives PiP text as the person's own message. By default it opens PiP and puts the text in its message box, after
     * what is there, for the person to read, edit, and send. With `send: true` it sends the text at once, but only just
     * after the person tapped or pressed a key: one tap serves for 5 seconds and for one send. The text starts with the
     * module's title, so the person and PiP see where it came from. It resolves with `{ ok: false, reason }` when the
     * person has no PiP, and when `send` has no tap to use. Text that is empty or past 100,000 characters throws.
     * @since 0.26.0
     * @experimental
     */
    ask(text: string, options?: { send?: boolean }): Promise<PipAskResult>;
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
     * Hears which session the tab shows: the listener gets its id, or null, now and on each change. Returns how to stop.
     * @since 0.20.0
     * @experimental
     */
    onConversation(listener: (conversationId: number | null) => void): () => void;
    /**
     * Reads a page of the people's messages in the session the tab shows, oldest first.
     * @since 0.20.0
     * @experimental
     */
    messages(options?: MessagesOptions): Promise<MessagePage>;
    /**
     * Scrolls the transcript to a message, loading earlier entries first when needed. Resolves whether it shows.
     * @since 0.20.0
     * @experimental
     */
    reveal(id: string): Promise<boolean>;
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
     * The module's settings as the person in this tab may read them. A secret's value is left out: `set` says whether it is set.
     * @since 0.22.0
     * @experimental
     */
    settings(): Promise<{
        fields: SettingField[];
        values: Record<string, SettingValue | null>;
        set: string[];
    }>;
    /**
     * Calls `run` when the owner changes the module's settings. Returns a function that stops it.
     * @since 0.22.0
     * @experimental
     */
    onSettings(run: () => void): () => void;
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
     * Adds chips under the titles of rows in the session list.
     * @since 0.20.0
     * @experimental
     */
    sessionChips(spec: SessionChipsSpec): Added<SessionChipsSpec>;
    /**
     * Adds an action on sessions: in a row's sheet on a touch screen, and in the bar for selected sessions.
     * @since 0.20.0
     * @experimental
     */
    sessionAction(spec: SessionActionSpec): Added<SessionActionSpec>;
    /**
     * Adds a filter button beside the session search (the first 3 show). While its `match` is set, the list shows only what it keeps.
     * @since 0.20.0
     * @experimental
     */
    sessionFilter(spec: SessionFilterSpec): Added<SessionFilterSpec>;
    /**
     * Adds words that find sessions in the session list's search and the launcher.
     * @since 0.20.0
     * @experimental
     */
    sessionSearch(spec: SessionSearchSpec): Added<SessionSearchSpec>;
    /**
     * Adds a key in the message boxes, the session's and PiP's, before the box's own keys.
     * @since 0.20.0
     * @experimental
     */
    composerKey(spec: ComposerKeySpec): Added<ComposerKeySpec>;
    /**
     * Puts text into the message box, after what is there, for the person to send. It never sends.
     * @since 0.19.0
     * @experimental
     */
    insertText(text: string, options?: { inline?: boolean }): void;
    /**
     * Gives text to the person's PiP, their assistant.
     * @since 0.26.0
     * @experimental
     */
    readonly pip: PipApi;
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
