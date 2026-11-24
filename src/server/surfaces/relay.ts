/**
 * Surfaces in a chat (the relay's text fallback). Out: `prepareRelay` makes the numbered text of a card and keeps, for
 * the card's revision, what each number does. In: `fromRelay` reads a message of the grammar `3`, `1 2 3`, `s3 2`, or
 * `5: text` as an action, only when a card is open for that connector, channel and thread, and only for the numbers
 * the card has. Who: an author in the connector's `ownerIds` acts as the connector's person; anyone else is a viewer,
 * so only controls that say `anyone` take their numbers. The route's checks (`act.ts`) apply the same.
 */
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { PocketApp } from "../app.ts";
import { SurfacesDoc } from "../docs.ts";
import { describe, HttpError } from "../errors.ts";
import { type Actor, actAs } from "./act.ts";
import { controlsFor } from "./bindings.ts";
import { cardAuthorized } from "./store.ts";
import { render } from "./text.ts";
import type { RelayView, Surface, Target } from "./types.ts";

const context = BACKGROUND_CONTEXT;

/** A message that is only numbers, or a number and a text to fill. */
const NUMBERS = /^(?:s(\d+)\s+)?(\d+(?:[ ,]+\d+)*)$/i;
const FILL = /^(?:s(\d+)\s+)?(\d+):\s*([^]+)$/i;

/** Where a card went in a chat. */
export type SurfaceWhere = {
    /** The immutable connector id, not its name. */
    connector: string;
    routeRevision: string;
    channel?: string;
    thread?: string;
};

export type PreparedRelay = RelayView & {
    generation: string;
    text: string;
    rev: number;
    where: SurfaceWhere;
};

export type RelayReceipt = { id?: string; channel?: string; thread?: string };

const present = (value: unknown): value is string =>
    typeof value === "string" && value.trim() !== "";

/** What a message from a chat says about a card, as `fromRelay` takes it. */
export type RelayMessage = SurfaceWhere & {
    isCurrent?: () => boolean;
    /** The id of the message it answers, when the service tells. */
    replyTo?: string;
    /** The relay's id of this message: one that is tried again after a restart acts once. */
    eventId?: string;
    text: string;
    author: { id: string; name?: string };
    /** The ids of the owner's own accounts on the service. */
    ownerIds: readonly string[];
    /** Only the relay vouches for an authenticated account, never the message text or name. */
    trusted?: boolean;
    /** The user id the connector works for. */
    by: string;
};

export type RelayEcho = RelayView & {
    generation: string;
    thread?: string;
    isCurrent: () => boolean;
};

/** The connector needs a current steering person even for a viewer operating an anyone control. */
export function relayActor(message: RelayMessage, person: Actor | undefined): Actor | undefined {
    if (person === undefined || person.id !== message.by) {
        return undefined;
    }

    return message.trusted === true && message.ownerIds.includes(message.author.id)
        ? { id: person.id, name: person.name, role: person.role }
        : {
              id: `relay:${message.author.id}`,
              name: message.author.name ?? message.author.id,
              role: "viewer",
          };
}

export type RelayOutcome =
    | { handled: true; reply: string; surface?: string; echo?: RelayEcho }
    | { handled: false; refusal?: string };

/** How many answers of the relay are kept for each card, for the replies that name them. */
const ECHOES = 5;

/** Prepare the numbered text. Only the latest preparation can be confirmed; until then the last delivery still stands. */
export async function prepareRelay(
    app: PocketApp,
    id: ConversationId,
    sid: string,
    where: SurfaceWhere,
): Promise<PreparedRelay> {
    if (!present(where.connector) || !present(where.routeRevision)) {
        throw new HttpError(
            409,
            "Cannot verify this connector: send the card again after a restart",
        );
    }

    return app.harness.commit(async (tx) => {
        const surface = (await tx.doc(SurfacesDoc, id)).items[sid];

        if (surface === undefined) {
            throw new HttpError(404, `No surface ${sid} here`);
        }

        if (surface.status !== "open") {
            throw new HttpError(409, `Surface ${sid} has ended (${surface.status})`);
        }

        const out = render(surface as Surface, "relay");
        const generation = randomUUID();

        surface.relayPreparation = generation;

        return {
            text: out.text,
            map: out.map,
            pv: surface.pv,
            rev: surface.rev,
            where,
            generation,
        };
    }, context);
}

/** Activate the numbering only for the matching complete send, in the destination the connector confirmed. */
export async function recordSent(
    app: PocketApp,
    id: ConversationId,
    sid: string,
    prepared: PreparedRelay,
    receipt: RelayReceipt,
    isCurrent: () => boolean,
): Promise<void> {
    await app.harness.commit(async (tx) => {
        const surface = (await tx.doc(SurfacesDoc, id)).items[sid];

        if (surface === undefined || surface.relayPreparation !== prepared.generation) {
            return;
        }

        delete surface.relayPreparation;

        const { where } = prepared;
        const { channel, thread } = receipt;

        if (
            !isCurrent() ||
            surface.status !== "open" ||
            surface.rev !== prepared.rev ||
            surface.pv !== prepared.pv ||
            !present(channel) ||
            (thread !== undefined && !present(thread)) ||
            (where.channel !== undefined && where.channel !== channel) ||
            ((where.channel !== undefined || where.thread !== undefined) &&
                where.thread !== thread) ||
            (receipt.id !== undefined && !present(receipt.id))
        ) {
            return;
        }

        surface.relay = {
            connector: where.connector,
            routeRevision: where.routeRevision,
            channel,
            ...(thread === undefined ? {} : { thread }),
            ...(present(receipt.id) ? { msgId: receipt.id } : {}),
            generation: prepared.generation,
            pv: prepared.pv,
            map: prepared.map,
        };
    }, context);
}

/**
 * The id of a message the relay sent to say what a card is now (the echo of an action): a reply to it acts on the card
 * as a reply to the card's own message does. Only the last few are kept.
 */
export async function recordEcho(
    app: PocketApp,
    id: ConversationId,
    sid: string,
    msgId: string,
    echo: RelayEcho,
): Promise<void> {
    await app.harness.commit(async (tx) => {
        const surface = (await tx.doc(SurfacesDoc, id)).items[sid];

        if (
            surface?.relay === undefined ||
            surface.relay.msgId === msgId ||
            echo === undefined ||
            !present(msgId) ||
            echo.isCurrent?.() !== true ||
            !cardAuthorized(surface, (by) => app.steeringUser(id, by) !== undefined) ||
            !present(echo.generation) ||
            surface.relay.generation !== echo.generation
        ) {
            return;
        }

        const kept = surface.relay.echoes ?? [];

        if (kept.some((each) => (typeof each === "string" ? each : each.id) === msgId)) {
            return;
        }

        const view = {
            id: msgId,
            map: echo.map,
            pv: echo.pv,
            ...(echo.thread === undefined ? {} : { thread: echo.thread }),
        };

        surface.relay.echoes = [...kept, view].slice(-ECHOES);
    }, context);
}

/** What a reply to an ended card is told: one text, for every sender. */
const ENDED = "That card has ended. Look at the newest one.";

type CardMatch = { surface: Surface; view: RelayView; messageId?: string };

/** A direct reply may start a thread rooted at this very message (Slack qualifies its ids with the channel). */
function inThread(message: RelayMessage, thread: string | undefined, msgId?: string): boolean {
    return (
        thread === message.thread ||
        (thread === undefined &&
            present(msgId) &&
            present(message.thread) &&
            message.replyTo === msgId &&
            (message.thread === msgId || `${message.channel}:${message.thread}` === msgId))
    );
}

/** Select only a view delivered by this connector instance to this exact place. Legacy records have no verified revision. */
function cardFor(
    items: Record<string, Surface>,
    message: RelayMessage,
    named: string | undefined,
): CardMatch | undefined {
    if (
        !present(message.channel) ||
        !present(message.connector) ||
        !present(message.routeRevision)
    ) {
        return undefined;
    }

    const matches: CardMatch[] = [];

    for (const surface of Object.values(items)) {
        const relay = surface.relay;

        if (
            relay === undefined ||
            !present(relay.generation) ||
            relay.connector !== message.connector ||
            relay.channel !== message.channel ||
            relay.routeRevision !== message.routeRevision ||
            (named !== undefined && surface.id !== `s${named}`)
        ) {
            continue;
        }

        const views = [
            { view: relay as RelayView, id: relay.msgId, thread: relay.thread },
            ...(relay.echoes ?? []).flatMap((echo) =>
                typeof echo === "string"
                    ? []
                    : [{ view: echo as RelayView, id: echo.id, thread: echo.thread }],
            ),
        ];
        const direct = present(message.replyTo)
            ? views.find((each) => each.id === message.replyTo)
            : undefined;
        const view =
            direct !== undefined
                ? inThread(message, direct.thread, direct.id)
                    ? direct
                    : undefined
                : named !== undefined && surface.status === "open"
                  ? views.findLast((each) => each.thread === message.thread)
                  : undefined;

        if (view !== undefined) {
            matches.push({
                surface,
                view: view.view,
                ...(view.id === undefined ? {} : { messageId: view.id }),
            });
        }
    }

    return matches.length === 1 ? matches[0] : undefined;
}

/** What the numbers of a message do: the body of an act, and the values worked out from the card as it is then. */
type Planned = {
    body: { pv: number; set: Record<string, JsonValue>; event?: string };
    /** A toggle or a multiple pick depends on the value now: the commit works it out (`act.ts`), never an earlier read. */
    derive: Record<string, (current: unknown) => JsonValue>;
    label?: string;
};

/** Which controls the numbers press, and what to set: the body of an act, or a refusal. */
function plan(
    surface: Surface,
    view: RelayView,
    numbers: string[],
    fill: string | undefined,
): Planned | string {
    const map = view.map;
    const set: Record<string, JsonValue> = {};
    const derive: Planned["derive"] = {};
    let event: string | undefined;

    for (const number of new Set(numbers)) {
        const target: Target | undefined = Object.hasOwn(map, number) ? map[number] : undefined;

        if (target === undefined) {
            return `There is no ${number} on card ${surface.id}.`;
        }

        if (target.kind === "text") {
            if (fill === undefined) {
                return `${number} takes a text: write "${surface.id} ${number}: your text".`;
            }

            set[target.path] = fill;
        } else if (fill !== undefined) {
            return `${number} takes no text: write "${surface.id} ${number}".`;
        } else if (target.kind === "toggle") {
            const before = derive[target.path];

            derive[target.path] = (now) => !(before === undefined ? now === true : before(now));
        } else if (target.kind === "pick") {
            if (target.multiple === true) {
                // Each number works on the value the one before it made.
                const before = derive[target.path];

                derive[target.path] = (current) => {
                    const now = before === undefined ? current : before(current);

                    return Array.isArray(now) && now.includes(target.value)
                        ? now.filter((each) => each !== target.value)
                        : [...(Array.isArray(now) ? now : []), target.value];
                };
            } else {
                set[target.path] = target.value;
            }
        } else if (event !== undefined) {
            return "One button at a time.";
        } else {
            event = target.control;
        }
    }

    return {
        body: { pv: view.pv, set, ...(event === undefined ? {} : { event }) },
        derive,
        ...(event === undefined
            ? {}
            : { label: String(surface.components[event]?.label ?? event) }),
    };
}

/**
 * A message from a chat as an action on a card, or not: `handled` says the relay answered it itself (`reply` goes to
 * the chat) and Pi hears nothing of it; a `refusal` is for a message that looked like an action on an open card but
 * could not be one; the message still goes to Pi, as data. A sender who may use no control of the card is not handled
 * at all: the message goes to Pi like any other, and the relay says nothing of the card to them.
 */
export async function fromRelay(
    app: PocketApp,
    id: ConversationId,
    message: RelayMessage,
): Promise<RelayOutcome> {
    const text = typeof message.text === "string" ? message.text.trim() : "";
    const fill = FILL.exec(text);
    const numbers = fill === null ? NUMBERS.exec(text) : null;

    if (fill === null && numbers === null) {
        return { handled: false };
    }

    const named = (fill ?? numbers)![1];
    const picked = fill === null ? numbers![2]!.split(/[ ,]+/) : [fill[2]!];
    const surfaces = (await app.harness.snapshot(SurfacesDoc, id, context))?.items ?? {};
    const matched = cardFor(surfaces, message, named);
    const resolveActor = () => relayActor(message, app.steeringUser(id, message.by));
    const actor = resolveActor();

    if (matched === undefined || message.isCurrent?.() !== true || actor === undefined) {
        return { handled: false };
    }

    const { surface, view } = matched;
    const generation = surface.relay!.generation!;

    if (surface.status !== "open") {
        return { handled: false, refusal: ENDED };
    }

    // Permission first: a sender who may use no control learns nothing of the card, and Pi hears the message.
    if (!Object.values(controlsFor(surface, actor)).some(Boolean)) {
        return { handled: false };
    }

    // Only the owner's own accounts hear why: others get the same short refusal whatever went wrong.
    const said = (detail: string) =>
        actor.role === "viewer" ? `That did not work on card ${surface.id}.` : detail;

    if (view.pv !== surface.pv) {
        return { handled: false, refusal: `Card ${surface.id} changed. Look at the new one.` };
    }

    const made = plan(surface, view, picked, fill === null ? undefined : fill[3]!.trim());

    if (typeof made === "string") {
        return actor.role === "viewer" ? { handled: false } : { handled: false, refusal: made };
    }

    try {
        const result = await actAs(app, id, actor, surface.id, made.body, {
            derive: made.derive,
            once: message.eventId,
            checkRoute: (items) => {
                const still = cardFor(items, message, named);

                if (
                    message.isCurrent?.() !== true ||
                    still?.surface.relay?.generation !== generation ||
                    still.messageId !== matched.messageId
                ) {
                    throw new HttpError(409, "This chat route changed");
                }
            },
            resolveActor: () => {
                const current = resolveActor();

                if (current === undefined) {
                    throw new HttpError(403, "This connector can no longer steer here.");
                }

                return current;
            },
        });

        // A service can return the original message id on a retry. Never bind it to a freshly rendered echo.
        if (result.replayed === true) {
            return { handled: true, surface: surface.id, reply: `${surface.id}: already handled.` };
        }

        if (made.label !== undefined) {
            return {
                handled: true,
                surface: surface.id,
                reply: `${surface.id}: ${made.label} pressed${result.status === "done" ? ", and the card is done" : ""}.`,
            };
        }

        const after = (await app.harness.snapshot(SurfacesDoc, id, context))?.items[surface.id];

        const canEcho = () => {
            const current = resolveActor();

            return (
                message.isCurrent?.() === true &&
                current?.id === actor.id &&
                current.role === actor.role &&
                after !== undefined &&
                cardAuthorized(after, (by) => app.steeringUser(id, by) !== undefined)
            );
        };

        if (after?.relay?.generation !== generation || !canEcho()) {
            return { handled: true, surface: surface.id, reply: `${surface.id}: done.` };
        }

        const out = render(after as Surface, "relay");

        return {
            handled: true,
            surface: surface.id,
            reply: out.text,
            echo: {
                pv: after.pv,
                map: out.map,
                generation,
                isCurrent: canEcho,
                ...(message.thread === undefined ? {} : { thread: message.thread }),
            },
        };
    } catch (error) {
        if (resolveActor() === undefined) {
            return { handled: false };
        }

        const status = error instanceof HttpError ? error.status : 500;

        return {
            handled: false,
            refusal: said(
                status === 403
                    ? `You may not use card ${surface.id} from here.`
                    : status === 409
                      ? `Card ${surface.id}: ${describe(error)}.`
                      : `Card ${surface.id}: ${describe(error)}`,
            ),
        };
    }
}

/** What the relay's module uses (`PocketHost.surfaces`). */
export interface SurfacesRelayApi {
    prepare(
        conversationId: ConversationId,
        surface: string,
        where: SurfaceWhere,
    ): Promise<PreparedRelay>;
    confirm(
        conversationId: ConversationId,
        surface: string,
        prepared: PreparedRelay,
        receipt: RelayReceipt,
        isCurrent: () => boolean,
    ): Promise<void>;
    /** The relay answered an action on a card with a message of this id: a reply to it acts on the card too. */
    echoed(
        conversationId: ConversationId,
        surface: string,
        messageId: string,
        echo: RelayEcho,
    ): Promise<void>;
    fromRelay(conversationId: ConversationId, message: RelayMessage): Promise<RelayOutcome>;
}
