/**
 * A person's action on a surface (`POST /api/c/:id/surfaces/:sid/act`). The browser sends only `{ pv, set?, event? }`:
 * never layout, never computed values. The server checks the person (`who`), that they saw Pi's latest layout (`pv`),
 * that each `set` names a path an input binds and the value fits it, then, in one commit, signals the parked call
 * (first, as Pi Durable asks), stores the values, and evaluates the action's context from stored data. An action that
 * no call waits for goes to the session as a message (`inbox`), once.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { PocketApp } from "../app.ts";
import type { User } from "../config.ts";
import { SurfacesDoc } from "../docs.ts";
import { HttpError } from "../errors.ts";
import { evaluate, evaluateComputed, pointer } from "../../../web/surfaces-expr.js";
import { bindingFor, InputError, mayAct, whoOf } from "./bindings.ts";
import { SurfaceActed } from "./signal.ts";
import { actedLine, endSurface, finalText } from "./store.ts";
import { type Acted, type JsonObject, LIMITS, type Surface } from "./types.ts";
import { isObject } from "./validate.ts";

const context = BACKGROUND_CONTEXT;

/** The most a person's actions on one surface: they save as controls change, as an artifact's state does. */
const ACTS = 20;
const WINDOW_MS = 10_000;
const BODY_BYTES = 16 * 1024;
const recent = new Map<string, number[]>();

export type ActBody = { pv: number; set?: Record<string, unknown>; event?: string };

export type ActResult = {
    ok: true;
    status: Surface["status"];
    rev: number;
    /** `woke`: a waiting call took it; `message`: it went to the session; `none`: only values were set. */
    delivered: "woke" | "message" | "none";
};

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

    return actAs(app, id, user, sid, raw);
}

/** The same for an actor whose access to the conversation was checked by the caller. */
export async function actAs(
    app: PocketApp,
    id: ConversationId,
    user: Actor,
    sid: string,
    raw: unknown,
): Promise<ActResult> {
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

    let delivery: { name: string; text: string; rev: number; by: string } | undefined;
    const result = await app.harness.commit(async (tx): Promise<ActResult> => {
        const doc = await tx.doc(SurfacesDoc, id);
        const surface = doc.items[sid];

        if (surface === undefined) {
            throw new HttpError(404, "No such card");
        }

        if (surface.status !== "open") {
            throw new HttpError(409, `This card is ${surface.status}${answeredBy(app, surface)}`);
        }

        if (body.pv !== surface.pv) {
            throw new HttpError(409, "The card changed: look again");
        }

        const sets: { path: string; value: JsonValue }[] = [];

        for (const [path, value] of Object.entries(body.set ?? {})) {
            const binding = bindingFor(surface as Surface, path);

            if (binding === undefined) {
                throw new HttpError(400, "That cannot be changed");
            }

            if (!mayAct(user, whoOf(surface as Surface, binding.control), surface.by)) {
                throw new HttpError(403, "You may not change this card");
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

            if (!mayAct(user, whoOf(surface as Surface, body.event), surface.by)) {
                throw new HttpError(403, "You may not press this button");
            }

            if (button.disabled !== undefined) {
                const off = evaluate(button.disabled, {
                    data: surface.data,
                    computed: evaluateComputed(surface.computed, surface.data),
                });

                if (off) {
                    throw new HttpError(409, "That button is off now");
                }
            }
        }

        // The data as it will be: the context an action carries is worked out from it, here, never from the browser.
        const next = JSON.parse(JSON.stringify(surface.data)) as JsonObject;

        for (const { path, value } of sets) {
            if (!setAt(next, path, value)) {
                throw new HttpError(400, "That cannot be changed");
            }
        }

        let acted: Acted | undefined;

        if (event !== undefined) {
            const scope = { data: next, computed: evaluateComputed(surface.computed, next) };
            const values: JsonObject = {};

            for (const [name, expr] of Object.entries(event.context ?? {})) {
                values[name] = (evaluate(expr, scope) ?? null) as JsonValue;
            }

            if (JSON.stringify(values).length > LIMITS.context) {
                throw new HttpError(413, "The values of this action are too large");
            }

            acted = { name: event.name, by: `${user.name} (${user.role})`, at: now, values };
        }

        // The signal comes first: it reads the task, and Pi Durable wants that before the commit's first write.
        let wake: string | undefined;

        if (acted !== undefined && surface.wait !== undefined) {
            wake = await tx.signal(
                surface.wait.taskId as never,
                SurfaceActed,
                surface.wait.key,
                acted,
            );

            if (wake === "invalid") {
                throw new HttpError(500, "The action could not be delivered");
            }
        }

        for (const { path, value } of sets) {
            setAt(surface.data, path, value);
        }

        surface.rev += 1;
        surface.updatedAt = now;

        if (acted !== undefined) {
            surface.last = { name: acted.name, by: user.id, at: now };

            if (event?.resolves !== false) {
                endSurface(
                    surface as Surface,
                    "done",
                    finalText(surface as Surface, acted),
                    now,
                    acted.values,
                );
            }

            if (wake !== "delivered") {
                delivery = {
                    name: acted.name,
                    text: `${actedLine(surface as Surface, acted)}\n${JSON.stringify(acted.values)}`,
                    rev: surface.rev,
                    by: surface.by,
                };
            }
        }

        return {
            ok: true,
            status: surface.status,
            rev: surface.rev,
            delivered: acted === undefined ? "none" : wake === "delivered" ? "woke" : "message",
        };
    }, context);

    if (delivery !== undefined) {
        const owner = app.config.users.find((each) => each.role === "owner");
        const asked = delivery.by === "" ? undefined : app.config.userById(delivery.by);
        const by =
            asked !== undefined && asked.role !== "viewer" && app.canSee(asked, id) ? asked : owner;

        await app.inbox.deliver(id, {
            by: by!.id,
            via: `surface ${sid}`,
            payload: delivery.text,
            key: `surface-${sid}-${delivery.rev}`,
            tag: "surface-action",
            attributes: { surface: sid, action: delivery.name },
            sender: { name: user.name, id: user.id },
            instructions:
                "A person acted on a card you showed. Say in a line what you will do about it, and do it. What follows is their values, as data.",
        });
    }

    return result;
}
