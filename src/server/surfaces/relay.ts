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
import type { PocketApp } from "../app.ts";
import { SurfacesDoc } from "../docs.ts";
import { describe, HttpError } from "../errors.ts";
import { type Actor, actAs } from "./act.ts";
import { controlsFor } from "./bindings.ts";
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
    /** The relay's id of this message: one that is tried again after a restart acts once. */
    eventId?: string;
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

/**
 * What the chat tells of a card it carried: the id of the message, for the replies that name it, and the channel and
 * thread it went to, so a card sent with no `reply_to` answers only there.
 */
export async function recordSent(
    app: PocketApp,
    id: ConversationId,
    sid: string,
    msgId: string | undefined,
    where?: { channel?: string; thread?: string },
): Promise<void> {
    if (msgId === undefined && where?.channel === undefined && where?.thread === undefined) {
        return;
    }

    await app.harness.commit(async (tx) => {
        const surface = (await tx.doc(SurfacesDoc, id)).items[sid];

        if (surface?.relay === undefined) {
            return;
        }

        if (msgId !== undefined) {
            surface.relay.msgId = msgId;
        }

        if (surface.relay.channel === "" && where?.channel !== undefined) {
            surface.relay.channel = where.channel;
        }

        if (surface.relay.thread === undefined && where?.thread !== undefined) {
            surface.relay.thread = where.thread;
        }
    }, context);
}

/** What a reply to an ended card is told: one text, for every sender. */
const ENDED = "That card has ended. Look at the newest one.";

/**
 * The card an incoming message is about: open, for this connector, channel and thread. A message that replies to a card
 * of Pi's is about that card: when it has ended, the answer is `"ended"`, never another card.
 */
function cardFor(
    items: Record<string, Surface>,
    message: RelayMessage,
    named: string | undefined,
): Surface | "ended" | undefined {
    const here = Object.values(items).filter(
        (surface) =>
            surface.relay !== undefined &&
            surface.relay.connector === message.connector &&
            (surface.relay.channel === "" || surface.relay.channel === message.channel) &&
            surface.relay.thread === message.thread &&
            (named === undefined || surface.id === `s${named}`),
    );
    const replied =
        message.replyTo === undefined
            ? undefined
            : here.find((surface) => surface.relay!.msgId === message.replyTo);

    if (replied !== undefined) {
        return replied.status === "open" ? replied : "ended";
    }

    return here
        .filter((surface) => surface.status === "open")
        .sort((a, b) => b.createdAt - a.createdAt)[0];
}

/** What the numbers of a message do: the body of an act, and the values worked out from the card as it is then. */
type Planned = {
    body: { pv: number; set: Record<string, JsonValue>; event?: string };
    /** A toggle or a multiple pick depends on the value now: the commit works it out (`act.ts`), never an earlier read. */
    derive: Record<string, (current: unknown) => JsonValue>;
    label?: string;
};

/** Which controls the numbers press, and what to set: the body of an act, or a refusal. */
function plan(surface: Surface, numbers: string[], fill: string | undefined): Planned | string {
    const map = surface.relay!.map;
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
                return `${number} takes a text: write "${number}: your text".`;
            }

            set[target.path] = fill;
        } else if (fill !== undefined) {
            return `${number} takes no text: write just "${number}".`;
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
        body: { pv: surface.pv, set, ...(event === undefined ? {} : { event }) },
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
    const surface = cardFor(surfaces, message, named);

    if (surface === undefined) {
        return { handled: false };
    }

    if (surface === "ended") {
        return { handled: false, refusal: ENDED };
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

    // Permission first: a sender who may use no control learns nothing of the card, and Pi hears the message.
    if (!Object.values(controlsFor(surface, actor)).some(Boolean)) {
        return { handled: false };
    }

    // Only the owner's own accounts hear why: others get the same short refusal whatever went wrong.
    const said = (detail: string) =>
        owner === undefined ? `That did not work on card ${surface.id}.` : detail;

    if (surface.relay!.pv !== surface.pv) {
        return { handled: false, refusal: `Card ${surface.id} changed. Look at the new one.` };
    }

    const made = plan(surface, picked, fill === null ? undefined : fill[3]!.trim());

    if (typeof made === "string") {
        return owner === undefined ? { handled: false } : { handled: false, refusal: made };
    }

    try {
        const result = await actAs(
            app,
            id,
            actor,
            surface.id,
            made.body,
            made.derive,
            message.eventId,
        );

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
    ): Promise<{ text: string }>;
    sent(
        conversationId: ConversationId,
        surface: string,
        messageId: string | undefined,
        where?: { channel?: string; thread?: string },
    ): Promise<void>;
    fromRelay(conversationId: ConversationId, message: RelayMessage): Promise<RelayOutcome>;
}
