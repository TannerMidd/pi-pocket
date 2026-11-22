/**
 * Surfaces in a chat (the relay's text fallback). Out: `prepareRelay` makes the numbered text of a card and keeps, for
 * the card's revision, what each number does. In: `fromRelay` reads a message of the grammar `3`, `1 2 3`, `s3 2`, or
 * `5: text` as an action, only when a card is open for that connector, channel and thread, and only for the numbers
 * the card has. Who: an author in the connector's `ownerIds` acts as the connector's person; anyone else is a viewer,
 * so only controls that say `anyone` take their numbers. The route's checks (`act.ts`) apply the same.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import type { ConversationId } from "@earendil-works/pi-durable";
import { readPath } from "../../../web/surfaces-expr.js";
import type { PocketApp } from "../app.ts";
import { SurfacesDoc } from "../docs.ts";
import { describe, HttpError } from "../errors.ts";
import { type Actor, actAs } from "./act.ts";
import { render } from "./text.ts";
import type { Surface, Target } from "./types.ts";

const context = BACKGROUND_CONTEXT;

/** A message that is only numbers, or a number and a text to fill. */
const NUMBERS = /^(?:s(\d+)\s+)?(\d+(?:[ ,]+\d+)*)$/i;
const FILL = /^(?:s(\d+)\s+)?(\d+):\s*([^]+)$/i;

/** Where a card went in a chat. */
export type SurfaceWhere = { connector: string; channel?: string; thread?: string };

/** What a message from a chat says about a card, as `fromRelay` takes it. */
export type RelayMessage = {
    connector: string;
    channel?: string;
    thread?: string;
    /** The id of the message it answers, when the service tells. */
    replyTo?: string;
    text: string;
    author: { id: string; name?: string };
    /** The ids of the owner's own accounts on the service. */
    ownerIds: readonly string[];
    /** The user id the connector works for. */
    by: string;
};

export type RelayOutcome = { handled: true; reply: string } | { handled: false; refusal?: string };

/**
 * The relay's text of an open card, and a record of where it goes: its connector, channel and thread, the card's `pv`,
 * and the target of each number. A card shown again to the same place replaces the record.
 */
export async function prepareRelay(
    app: PocketApp,
    id: ConversationId,
    sid: string,
    where: SurfaceWhere,
): Promise<{ text: string }> {
    return app.harness.commit(async (tx) => {
        const doc = await tx.doc(SurfacesDoc, id);
        const surface = doc.items[sid];

        if (surface === undefined) {
            throw new HttpError(404, `No surface ${sid} here`);
        }

        if (surface.status !== "open") {
            throw new HttpError(409, `Surface ${sid} has ended (${surface.status})`);
        }

        const out = render(surface as Surface, "relay");

        surface.relay = {
            connector: where.connector,
            channel: where.channel ?? "",
            ...(where.thread === undefined ? {} : { thread: where.thread }),
            pv: surface.pv,
            map: out.map,
        };

        return { text: out.text };
    }, context);
}

/** The id of the message that carries a card, for the replies that name it. */
export async function recordSent(
    app: PocketApp,
    id: ConversationId,
    sid: string,
    msgId: string | undefined,
): Promise<void> {
    if (msgId === undefined) {
        return;
    }

    await app.harness.commit(async (tx) => {
        const surface = (await tx.doc(SurfacesDoc, id)).items[sid];

        if (surface?.relay !== undefined) {
            surface.relay.msgId = msgId;
        }
    }, context);
}

/** The card an incoming message is about: open, for this connector, channel and thread. */
function cardFor(
    items: Record<string, Surface>,
    message: RelayMessage,
    named: string | undefined,
): Surface | undefined {
    const open = Object.values(items).filter(
        (surface) =>
            surface.status === "open" &&
            surface.relay !== undefined &&
            surface.relay.connector === message.connector &&
            (surface.relay.channel === "" ||
                message.channel === undefined ||
                surface.relay.channel === message.channel) &&
            (surface.relay.thread === undefined ||
                message.thread === undefined ||
                surface.relay.thread === message.thread) &&
            (named === undefined || surface.id === `s${named}`),
    );

    return (
        open.find(
            (surface) => message.replyTo !== undefined && surface.relay!.msgId === message.replyTo,
        ) ?? open.sort((a, b) => b.createdAt - a.createdAt)[0]
    );
}

/** Which controls the numbers press, and what to set: the body of an act, or a refusal. */
function plan(
    surface: Surface,
    numbers: string[],
    fill: string | undefined,
):
    | { body: { pv: number; set?: Record<string, JsonValue>; event?: string }; label?: string }
    | string {
    const map = surface.relay!.map;
    const set: Record<string, JsonValue> = {};
    let event: string | undefined;

    for (const number of new Set(numbers)) {
        const target: Target | undefined = Object.hasOwn(map, number) ? map[number] : undefined;

        if (target === undefined) {
            return `There is no ${number} on card ${surface.id}.`;
        }

        const current = (path: string) => readPath(path, { data: surface.data });

        if (target.kind === "text") {
            if (fill === undefined) {
                return `${number} takes a text: write "${number}: your text".`;
            }

            set[target.path] = fill;
        } else if (fill !== undefined) {
            return `${number} takes no text: write just "${number}".`;
        } else if (target.kind === "toggle") {
            set[target.path] = current(target.path) !== true;
        } else if (target.kind === "pick") {
            const now = current(target.path);

            set[target.path] =
                target.multiple === true
                    ? Array.isArray(now) && now.includes(target.value)
                        ? now.filter((each) => each !== target.value)
                        : [...(Array.isArray(now) ? now : []), target.value]
                    : target.value;
        } else if (event !== undefined) {
            return "One button at a time.";
        } else {
            event = target.control;
        }
    }

    return {
        body: {
            pv: surface.pv,
            ...(Object.keys(set).length === 0 ? {} : { set }),
            ...(event === undefined ? {} : { event }),
        },
        ...(event === undefined
            ? {}
            : { label: String(surface.components[event]?.label ?? event) }),
    };
}

/**
 * A message from a chat as an action on a card, or not: `handled` says the relay answered it itself (`reply` goes to
 * the chat) and Pi hears nothing of it; a `refusal` is for a message that looked like an action on an open card but
 * could not be one; the message still goes to Pi, as data.
 */
export async function fromRelay(
    app: PocketApp,
    id: ConversationId,
    message: RelayMessage,
): Promise<RelayOutcome> {
    const text = message.text.trim();
    const fill = FILL.exec(text);
    const numbers = fill === null ? NUMBERS.exec(text) : null;

    if (fill === null && numbers === null) {
        return { handled: false };
    }

    const named = (fill ?? numbers)![1];
    const picked = fill === null ? numbers![2]!.split(/[ ,]+/) : [fill[2]!];
    const surfaces = (await app.harness.snapshot(SurfacesDoc, id, context))?.items ?? {};
    const surface = cardFor(surfaces, message, named);

    if (surface === undefined) {
        return { handled: false };
    }

    const owner = message.ownerIds.includes(message.author.id)
        ? app.config.userById(message.by)
        : undefined;
    const actor: Actor =
        owner !== undefined
            ? { id: owner.id, name: owner.name, role: owner.role }
            : {
                  id: `relay:${message.author.id}`,
                  name: message.author.name ?? message.author.id,
                  role: "viewer",
              };

    if (surface.relay!.pv !== surface.pv) {
        return { handled: false, refusal: `Card ${surface.id} changed. Look at the new one.` };
    }

    const made = plan(surface, picked, fill === null ? undefined : fill[3]!.trim());

    if (typeof made === "string") {
        return { handled: false, refusal: made };
    }

    try {
        const result = await actAs(app, id, actor, surface.id, made.body);

        if (made.label !== undefined) {
            return {
                handled: true,
                reply: `${surface.id}: ${made.label} pressed${result.status === "done" ? ", and the card is done" : ""}.`,
            };
        }

        const after = (await app.harness.snapshot(SurfacesDoc, id, context))?.items[surface.id];

        return {
            handled: true,
            reply:
                after === undefined
                    ? `${surface.id}: done.`
                    : render(after as Surface, "relay").text,
        };
    } catch (error) {
        const status = error instanceof HttpError ? error.status : 500;

        return {
            handled: false,
            refusal:
                status === 403
                    ? `You may not use card ${surface.id} from here.`
                    : status === 409
                      ? `Card ${surface.id}: ${describe(error)}.`
                      : `Card ${surface.id}: ${describe(error)}`,
        };
    }
}

/** What the relay's module uses (`PocketHost.surfaces`). */
export interface SurfacesRelayApi {
    prepare(
        conversationId: ConversationId,
        surface: string,
        where: SurfaceWhere,
    ): Promise<{ text: string }>;
    sent(
        conversationId: ConversationId,
        surface: string,
        messageId: string | undefined,
    ): Promise<void>;
    fromRelay(conversationId: ConversationId, message: RelayMessage): Promise<RelayOutcome>;
}
