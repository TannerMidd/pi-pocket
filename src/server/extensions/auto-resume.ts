/**
 * Auto-resume continues a chat that a provider's usage or rate limit stopped: at the reset time the provider gives,
 * or after a fixed delay when it gives none. Nothing happens until the owner turns it on for all chats, or someone
 * turns it on in one.
 */
import type { Context } from "@earendil-works/chord";
import {
    defineDoc,
    defineExtension,
    GenerationTask,
    hook,
    type ConversationId,
    type DocumentReader,
} from "@earendil-works/pi-durable";
import type { Schedule } from "../docs.ts";
import type { ConversationWebRequest, ExtensionWeb, PocketHost, WebRequest } from "../host.ts";
import { classify, durationMs } from "./_usage-limits.ts";

/** Its schedules' keys start with this, then the tries before it and the failed generation: `x.auto-resume:2:41`. */
const KEY = "x.auto-resume:";
const CONTINUE =
    "[usage reset] The provider's limit should be over now. Continue the unfinished request in this chat from where " +
    "you stopped. Check the existing progress first: do not repeat completed work or rerun tool calls merely because " +
    "of the limit.";
/** Schedules repeat at most every 10 minutes; a five-hour window is the longest wait. */
const MIN_DELAY = 10;
const MAX_DELAY = 300;

type Settings = { defaultOn: boolean; delayMinutes: number };

const DEFAULTS: Settings = { defaultOn: false, delayMinutes: 60 };

/** A chat's own choice; absent, it follows the owner's default. A fork follows the default again. */
const ChoiceDoc = defineDoc<{ on?: boolean }>({
    kind: "x.auto-resume.chat",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({}),
});

/** The owner's default for every chat, and the delay when a provider gives no reset time. */
const SettingsDoc = defineDoc<Partial<Settings>>({
    kind: "x.auto-resume.settings",
    version: 1,
    scope: "session",
    initial: () => ({}),
});

/** Tries before giving up: as many fixed delays as fit in a five-hour window. */
const maxTries = (settings: Settings) => Math.ceil(MAX_DELAY / settings.delayMinutes);

const triesOf = (schedule: Schedule) =>
    Number(schedule.key?.slice(KEY.length).split(":")[0] ?? 0) + schedule.runs;

const clock = (at: number) =>
    new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

const minutes = (count: number) =>
    count % 60 === 0
        ? `${count / 60} h`
        : count > 60
          ? `${Math.floor(count / 60)} h ${count % 60} min`
          : `${count} min`;

/** "45m", "1h", "1 h 30 min", or a bare number of minutes, from 10 minutes to 5 hours. */
export function parseDelay(text: string): number | undefined {
    const trimmed = text.trim();
    const ms = /^\d+$/.test(trimmed) ? Number(trimmed) * 60_000 : durationMs(trimmed);
    const count = ms === undefined ? NaN : Math.round(ms / 60_000);

    return count >= MIN_DELAY && count <= MAX_DELAY ? count : undefined;
}

export default function createAutoResume(host: PocketHost, web: ExtensionWeb) {
    const settingsOf = async (snapshot: DocumentReader["snapshot"], context: Context) => ({
        ...DEFAULTS,
        ...(await snapshot(SettingsDoc, context)),
    });

    /** The chat's own choice, or the owner's default for chats that are not PiP's. */
    const enabled = (
        id: ConversationId,
        choice: { on?: boolean } | undefined,
        settings: Settings,
    ) => choice?.on ?? (settings.defaultOn && host.pip.ownerOf(id) === undefined);

    const pending = async (id: ConversationId) =>
        (await host.schedules.list(id)).find((schedule) => schedule.key?.startsWith(KEY));

    const stop = async (id: ConversationId) => {
        const schedule = await pending(id);

        if (schedule !== undefined) {
            await host.schedules.cancel(id, schedule.id);
        }
    };

    async function state(
        id: ConversationId,
        snapshot: DocumentReader["snapshot"],
        context: Context,
    ) {
        const settings = await settingsOf(snapshot, context);
        const choice = await snapshot(ChoiceDoc, id, context);
        const schedule = await pending(id);

        return {
            on: enabled(id, choice, settings),
            choice: choice?.on ?? null,
            ...settings,
            maxTries: maxTries(settings),
            pending:
                schedule === undefined ? null : { next: schedule.next, tries: triesOf(schedule) },
        };
    }

    /** A chat's choice: true, false, or null for the default. Turned off, its pending retry stops too. */
    async function choose(
        id: ConversationId,
        on: unknown,
        commit: WebRequest["commit"],
        snapshot: DocumentReader["snapshot"],
        context: Context,
    ) {
        if (on !== true && on !== false && on !== null) {
            throw web.error(400, "on must be true, false, or null (the app's default)");
        }

        await commit(async (tx) => {
            const doc = await tx.doc(ChoiceDoc, id);

            if (on === null) {
                delete doc.on;
            } else {
                doc.on = on;
            }
        });

        if (!enabled(id, on === null ? {} : { on }, await settingsOf(snapshot, context))) {
            await stop(id);
        }
    }

    async function configure(
        body: Readonly<Record<string, unknown>>,
        commit: WebRequest["commit"],
    ) {
        const { defaultOn, delayMinutes } = body;

        if (defaultOn !== undefined && typeof defaultOn !== "boolean") {
            throw web.error(400, "defaultOn must be true or false");
        }

        if (
            delayMinutes !== undefined &&
            (typeof delayMinutes !== "number" || parseDelay(String(delayMinutes)) === undefined)
        ) {
            throw web.error(
                400,
                `The delay is from ${MIN_DELAY} minutes to ${MAX_DELAY / 60} hours.`,
            );
        }

        await commit(async (tx) => {
            const doc = await tx.doc(SettingsDoc);

            if (defaultOn !== undefined) {
                doc.defaultOn = defaultOn;
            }

            if (delayMinutes !== undefined) {
                doc.delayMinutes = delayMinutes as number;
            }
        });
    }

    const conversation = { conversation: "id" } as const;

    web.conversationRoute(
        "GET",
        "chat/:id",
        (request: ConversationWebRequest) =>
            state(request.conversation.id, request.snapshot, request.context),
        { ...conversation, access: "view" },
    );
    web.conversationRoute(
        "POST",
        "chat/:id",
        async (request: ConversationWebRequest) => {
            const id = request.conversation.id;

            if (request.body.cancel === true) {
                // An empty commit checks that this person may change the chat now (steering, taking turns).
                await request.commit(() => undefined);
                await stop(id);
            } else {
                await choose(
                    id,
                    request.body.on,
                    request.commit,
                    request.snapshot,
                    request.context,
                );
            }

            return state(id, request.snapshot, request.context);
        },
        { ...conversation, access: "steer" },
    );
    web.route("POST", "settings", (request) => configure(request.body, request.commit), {
        access: "owner",
    });
    web.client("auto-resume.js", { access: "view" });

    web.command("auto-resume", {
        description: "Continue this chat by itself after a provider's usage limit",
        args: "[on|off|default|cancel] · owner: [all on|off] [delay 1h]",
        scope: "conversation",
        handler: async (args, ctx) => {
            const [word = "", ...rest] = args.trim().toLowerCase().split(/\s+/);
            const id = ctx.conversationId;

            const owner = () => {
                if (ctx.user.role !== "owner") {
                    throw web.error(403, "Only the owner changes this for all chats.");
                }
            };

            if (word === "on" || word === "off" || word === "default") {
                await choose(
                    id,
                    word === "default" ? null : word === "on",
                    ctx.commit,
                    ctx.snapshot,
                    ctx.context,
                );
            } else if (word === "cancel") {
                await stop(id);
            } else if (word === "all" && (rest[0] === "on" || rest[0] === "off")) {
                owner();
                await configure({ defaultOn: rest[0] === "on" }, ctx.commit);
            } else if (word === "delay") {
                owner();

                const delay = parseDelay(rest.join(" "));

                if (delay === undefined) {
                    throw web.error(
                        400,
                        "Say a delay from 10m to 5h, such as /auto-resume delay 1h.",
                    );
                }

                await configure({ delayMinutes: delay }, ctx.commit);
            } else if (word !== "") {
                throw web.error(
                    400,
                    "Use /auto-resume on, off, default, cancel, all on|off, or delay 1h.",
                );
            }

            const now = await state(id, ctx.snapshot, ctx.context);
            const source = now.choice === null ? "the app's default" : "this chat";
            const waiting =
                now.pending === null
                    ? ""
                    : ` · next try at ${clock(now.pending.next)} (${now.pending.tries + 1} of ${now.maxTries})`;

            return {
                type: "toast",
                level: "info",
                message: `Auto-resume is ${now.on ? "on" : "off"} (${source})${waiting}. Without a reset time, it tries again after ${minutes(now.delayMinutes)}.`,
            };
        },
    });

    const afterResponse = hook(GenerationTask, {
        afterResponse: async (message, api, context) => {
            const id = api.conversationId;

            if (message.stopReason === "aborted") {
                return;
            }

            const current = await pending(id);

            // An answer came: the chat is not stuck anymore.
            if (message.stopReason !== "error") {
                if (current !== undefined) {
                    await host.schedules.cancel(id, current.id);
                }

                return;
            }

            const settings = await settingsOf(api.snapshot, context);

            if (!enabled(id, await api.snapshot(ChoiceDoc, id, context), settings)) {
                return;
            }

            const now = Date.now();
            const verdict = classify(message.errorMessage ?? "", host.responseLimits(message), now);
            const tries = current === undefined ? 0 : triesOf(current);
            const key = `${KEY}${tries}:${String(api.taskId)}`;
            const say = (text: string) => host.notice("info", text, id);

            // Run again after a restart: this generation planned it already.
            if (current?.key === key) {
                return;
            }

            if (verdict.kind === "skip" || tries >= maxTries(settings)) {
                if (current !== undefined) {
                    await host.schedules.cancel(id, current.id);
                }

                say(
                    verdict.kind === "skip"
                        ? `Auto-resume does not apply: ${verdict.reason}.`
                        : `Auto-resume gave up after ${tries} tries.`,
                );

                return;
            }

            const delay =
                verdict.kind === "reset"
                    ? Math.max(MIN_DELAY, Math.ceil((verdict.at - now) / 60_000))
                    : settings.delayMinutes;

            // Still no reset time: the same retry goes on, and counts its tries.
            if (
                verdict.kind === "retry" &&
                current?.every !== undefined &&
                "minutes" in current.every &&
                current.every.minutes === delay
            ) {
                return;
            }

            try {
                if (current !== undefined) {
                    await host.schedules.cancel(id, current.id);
                }

                const requestedBy = host.requesterOf(id);
                const schedule = await host.schedules.add(id, {
                    when: `every ${delay}m`,
                    text: CONTINUE,
                    key,
                    ...(requestedBy === undefined ? {} : { requestedBy }),
                });

                say(
                    verdict.kind === "reset"
                        ? `Auto-resume at ${clock(schedule.next)}, when the provider's limit resets.`
                        : `Auto-resume at ${clock(schedule.next)}: no reset time given, try ${tries + 1} of ${maxTries(settings)}.`,
                );
            } catch (error) {
                // A subagent's conversation has no schedules: it stops as before.
                if ((error as { status?: unknown }).status === 400) {
                    return;
                }

                host.notice(
                    "warning",
                    `Auto-resume could not plan a retry: ${error instanceof Error ? error.message : String(error)}`,
                    id,
                );
            }
        },
    });

    return defineExtension({ name: "pocket-auto-resume", hooks: [afterResponse] });
}
