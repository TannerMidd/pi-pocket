/**
 * A person's action on a surface (`POST /api/c/:id/surfaces/:sid/act`). The browser sends only `{ pv, set?, event? }`:
 * never layout, never computed values. The server checks the person (`who`), that they saw Pi's latest layout (`pv`),
 * that each `set` names a path an input binds and the value fits it, then, in one commit, signals the parked call
 * (first, as Pi Durable asks), stores the values, and evaluates the action's context from stored data. An action that
 * no call waits for goes to the session as a message (`inbox`), once: the commit writes a mark (`pending.ts`), and the
 * delivery clears it, or is tried again.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import type { ConversationId, TaskId } from "@earendil-works/pi-durable";
import type { PocketApp } from "../app.ts";
import type { User } from "../config.ts";
import { SurfacesDoc } from "../docs.ts";
import { describe, HttpError } from "../errors.ts";
import { evaluate, evaluateComputed, pointer, readPath } from "../../../web/surfaces-expr.js";
import { bindingFor, InputError, mayAct, whoOf } from "./bindings.ts";
import { keepFallbacks } from "./components.ts";
import { MAX_PAYLOAD } from "../inbox.ts";
import { deliverPending, MAX_PENDING } from "./pending.ts";
import { SurfaceActed } from "./signal.ts";
import { ACCESS_ENDED, actedLine, cardAuthorized, endSurface, finalText } from "./store.ts";
import { type Acted, type ActResult, type JsonObject, LIMITS, type Surface } from "./types.ts";
import { isObject } from "./validate.ts";

const context = BACKGROUND_CONTEXT;

/** The most a person's actions on one surface: they save as controls change, as an artifact's state does. */
const ACTS = 20;
const WINDOW_MS = 10_000;
const BODY_BYTES = 16 * 1024;
const recent = new Map<string, number[]>();

export type ActBody = { pv: number; set?: Record<string, unknown>; event?: string };

export type { ActResult };

type ActorResult = ActResult & { replayed?: true };

/** The chat messages a card remembers, to answer one that is tried again. */
const MAX_SEEN = 50;

function readBody(raw: unknown): ActBody {
    if (!isObject(raw) || JSON.stringify(raw).length > BODY_BYTES) {
        throw new HttpError(400, "An action is { pv, set?, event? }, up to 16 KB");
    }

    if (typeof raw.pv !== "number" || !Number.isInteger(raw.pv)) {
        throw new HttpError(400, "pv is the number of the card you saw");
    }

    // Anything else a browser sends (a context, a copy of the data) is ignored: only the server's own values count.

    if (raw.set !== undefined && (!isObject(raw.set) || Object.keys(raw.set).length > 20)) {
        throw new HttpError(400, "set is an object of up to 20 paths");
    }

    if (raw.event !== undefined && typeof raw.event !== "string") {
        throw new HttpError(400, "event is the id of a button");
    }

    if (raw.set === undefined && raw.event === undefined) {
        throw new HttpError(400, "An action sets a value or presses a button");
    }

    return raw as unknown as ActBody;
}

/** Put a value in the data at a path whose parent exists; false when it does not. */
function setAt(data: JsonObject, path: string, value: JsonValue): boolean {
    const parts = pointer(path)!;
    let at: JsonValue | undefined = data;

    for (const part of parts.slice(0, -1)) {
        at = Array.isArray(at)
            ? at[/^(0|[1-9]\d*)$/.test(part) ? Number(part) : -1]
            : isObject(at) && Object.hasOwn(at, part)
              ? (at as JsonObject)[part]
              : undefined;
    }

    const last = parts.at(-1)!;

    if (Array.isArray(at)) {
        const index = /^(0|[1-9]\d*)$/.test(last) ? Number(last) : -1;

        if (index < 0 || index >= at.length) {
            return false;
        }

        at[index] = value;

        return true;
    }

    if (!isObject(at) || last === "__proto__") {
        return false;
    }

    (at as JsonObject)[last] = value;

    return true;
}

/** The name of whoever answered, for the 409 of a second action. */
function answeredBy(app: PocketApp, surface: Surface): string {
    const by =
        surface.last?.by === undefined ? undefined : app.config.userById(surface.last.by)?.name;

    return by === undefined ? "" : ` by ${by}`;
}

/** Who acts: a person of the app, or a person of a chat the relay brings (`relay.ts`), who is a viewer at most. */
export type Actor = Pick<User, "id" | "name" | "role">;

/** The action of a surface for a person: see the file's comment. Throws `HttpError` for each refusal. */
export async function actOnSurface(
    app: PocketApp,
    id: ConversationId,
    user: User,
    sid: string,
    raw: unknown,
): Promise<ActResult> {
    app.requireSee(user, id);

    return actAs(app, id, user, sid, raw, {
        resolveActor: () => {
            const current = app.config.userById(user.id);

            if (current === undefined || !app.canSee(current, id)) {
                throw new HttpError(403, "You may not act on this card");
            }

            return current;
        },
    });
}

type ActOptions = {
    derive?: Record<string, (current: unknown) => JsonValue>;
    once?: string;
    checkRoute?: (items: Record<string, Surface>) => void;
    resolveActor?: () => Actor;
};

/**
 * The same for an actor whose access to the conversation was checked by the caller. `derive` is for the server's own
 * callers (the relay's toggles): each value is worked out from the card's data inside the commit, so two quick
 * actions do not both read the same earlier value. `once` is the id of the chat message behind the action: the card
 * keeps its result, so the same message tried again (after a restart cut the relay off) returns it and acts no more.
 */
export async function actAs(
    app: PocketApp,
    id: ConversationId,
    user: Actor,
    sid: string,
    raw: unknown,
    { derive = {}, once, checkRoute, resolveActor }: ActOptions = {},
): Promise<ActorResult> {
    const body = readBody(raw);
    const now = Date.now();
    const key = `${id}\n${user.id}\n${sid}`;
    const acts = (recent.get(key) ?? []).filter((at) => at > now - WINDOW_MS);

    if (acts.length >= ACTS) {
        throw new HttpError(429, "Too many actions at once: wait a moment");
    }

    recent.set(key, [...acts, now]);

    if (recent.size > 5000) {
        for (const [each, times] of recent) {
            if (times.at(-1)! <= now - WINDOW_MS) {
                recent.delete(each);
            }
        }
    }

    let queued = false;
    const result = await app.harness.commit(async (tx): Promise<ActorResult> => {
        const doc = await tx.doc(SurfacesDoc, id);
        const surface = doc.items[sid];

        if (surface === undefined) {
            throw new HttpError(404, "No such card");
        }

        const checkedActor = () => {
            checkRoute?.(doc.items);

            if (!cardAuthorized(surface, (by) => app.steeringUser(id, by) !== undefined)) {
                throw new HttpError(403, ACCESS_ENDED);
            }

            return resolveActor === undefined ? user : resolveActor();
        };

        const actor = checkedActor();

        const seen =
            once === undefined ? undefined : surface.seen?.find((each) => each.key === once);

        if (seen !== undefined) {
            return { ...seen.result, replayed: true };
        }

        if (surface.status !== "open") {
            throw new HttpError(409, `This card is ${surface.status}${answeredBy(app, surface)}`);
        }

        if (body.pv !== surface.pv) {
            throw new HttpError(409, "The card changed: look again");
        }

        const sets: { path: string; value: JsonValue }[] = [];

        const wanted: [string, unknown][] = [
            ...Object.entries(body.set ?? {}),
            ...Object.entries(derive).map(([path, make]): [string, unknown] => [
                path,
                make(readPath(path, { data: surface.data })),
            ]),
        ];

        for (const [path, value] of wanted) {
            const binding = bindingFor(surface as Surface, path);

            if (binding === undefined) {
                throw new HttpError(400, "That cannot be changed");
            }

            if (!mayAct(actor, whoOf(surface as Surface, binding.control), surface.by)) {
                throw new HttpError(403, "You may not change this card");
            }

            // A control the card shows as locked takes no value, from the app or a chat.
            const control = surface.components[binding.control];

            if (
                control?.disabled !== undefined &&
                evaluate(control.disabled, {
                    data: surface.data,
                    computed: evaluateComputed(surface.computed, surface.data),
                })
            ) {
                throw new HttpError(409, "That field is off now");
            }

            try {
                sets.push({ path, value: binding.check(value) });
            } catch (error) {
                if (error instanceof InputError) {
                    throw new HttpError(400, error.message);
                }

                throw error;
            }
        }

        const button = body.event === undefined ? undefined : surface.components[body.event];
        const event =
            button?.type === "Button" && isObject(button.action) && isObject(button.action.event)
                ? (button.action.event as {
                      name: string;
                      context?: Record<string, JsonValue>;
                      resolves?: boolean;
                  })
                : undefined;

        if (body.event !== undefined) {
            if (button === undefined || event === undefined) {
                throw new HttpError(400, "That is not a button that acts");
            }

            if (!mayAct(actor, whoOf(surface as Surface, body.event), surface.by)) {
                throw new HttpError(403, "You may not press this button");
            }
        }

        // The data as it will be: disabled checks and action context both read the post-set values, never the browser's.
        const next = JSON.parse(JSON.stringify(surface.data)) as JsonObject;

        for (const { path, value } of sets) {
            if (!setAt(next, path, value)) {
                throw new HttpError(400, "That cannot be changed");
            }
        }

        // Filled in, the card must still fit its limit: else every patch of Pi's would fail on its size.
        if (
            sets.length > 0 &&
            JSON.stringify({
                components: surface.components,
                data: next,
                computed: surface.computed,
                ...(surface.a2uiRaw === undefined ? {} : { a2uiRaw: surface.a2uiRaw }),
            }).length > LIMITS.bytes
        ) {
            throw new HttpError(413, "That would make the card too large: shorten the values");
        }

        let acted: Acted | undefined;

        if (event !== undefined) {
            const scope = { data: next, computed: evaluateComputed(surface.computed, next) };

            if (button?.disabled !== undefined && evaluate(button.disabled, scope)) {
                throw new HttpError(409, "That button is off now");
            }

            const values: JsonObject = {};

            for (const [name, expr] of Object.entries(event.context ?? {})) {
                values[name] = (evaluate(expr, scope) ?? null) as JsonValue;
            }

            if (JSON.stringify(values).length > LIMITS.context) {
                throw new HttpError(413, "The values of this action are too large");
            }

            acted = { name: event.name, by: `${actor.name} (${actor.role})`, at: now, values };
        }

        // The signal comes first: it reads the task, and Pi Durable wants that before the commit's first write.
        let wake: string | undefined;

        if (acted !== undefined && surface.wait !== undefined) {
            wake = await tx.signal(
                Number(surface.wait.taskId) as TaskId,
                SurfaceActed,
                surface.wait.key,
                acted,
            );

            const current = checkedActor();

            if (current.id !== actor.id || current.role !== actor.role) {
                throw new HttpError(403, "Access changed before this action was recorded");
            }

            if (wake === "delivered") {
                surface.checkedSignal = surface.wait.key;
            }

            if (wake === "invalid") {
                throw new HttpError(500, "The action could not be delivered");
            }
        }

        // An action for the session is kept until delivered: a full queue refuses a new one, and so does a text the
        // inbox would clip. Both refuse before the card changes.
        let said: string | undefined;

        if (acted !== undefined && wake !== "delivered") {
            if ((surface.pending?.length ?? 0) >= MAX_PENDING) {
                throw new HttpError(
                    429,
                    "Too many answers on this card wait to reach Pi: try again in a moment",
                );
            }

            said = `${actedLine(surface as Surface, acted)}\n${JSON.stringify(acted.values)}`;

            if (said.trim().length > MAX_PAYLOAD) {
                throw new HttpError(
                    413,
                    `The values of this action are too long to send to Pi (${MAX_PAYLOAD} characters at most)`,
                );
            }
        }

        for (const { path, value } of sets) {
            setAt(surface.data, path, value);
        }

        keepFallbacks(surface);
        surface.rev += 1;
        surface.updatedAt = now;

        if (acted !== undefined) {
            surface.last = { name: acted.name, by: actor.id, at: now };

            if (event?.resolves !== false) {
                endSurface(
                    surface as Surface,
                    "done",
                    finalText(surface as Surface, acted),
                    now,
                    acted.values,
                );
            }

            // The mark is written with the action: a failed delivery, or a restart, leaves it to try again.
            if (said !== undefined) {
                surface.pending = [
                    ...(surface.pending ?? []),
                    {
                        rev: surface.rev,
                        name: acted.name,
                        text: said,
                        by: surface.by,
                        actorChecked: true,
                        sender: { name: actor.name, id: actor.id, trusted: actor.role === "owner" },
                    },
                ];
                queued = true;
            }
        }

        const answer: ActResult = {
            ok: true,
            status: surface.status,
            rev: surface.rev,
            delivered: acted === undefined ? "none" : wake === "delivered" ? "woke" : "message",
        };

        if (once !== undefined) {
            surface.seen = [...(surface.seen ?? []), { key: once, result: answer }].slice(
                -MAX_SEEN,
            );
        }

        return answer;
    }, context);

    if (queued) {
        // The action is recorded whatever this does: a delivery that fails is tried again (`pending.ts`).
        await deliverPending(app, id, sid).catch((error: unknown) =>
            app.log(`surface ${sid}: ${describe(error)}`),
        );
    }

    return result;
}
