/**
 * A surface as one person's tab gets it (the room's `surfaces` field): the layout, the data, and which controls this
 * person may use. Never the task, the wait's key, or the relay's map. Pure.
 */
import type { JsonValue } from "@earendil-works/chord/json";
import { controlsFor } from "./bindings.ts";
import type { Component, JsonObject, Surface, SurfaceStatus, Who } from "./types.ts";

export type SurfaceView = {
    id: string;
    title: string;
    status: SurfaceStatus;
    who: Who;
    /** The name of the person Pi worked for. */
    by: string;
    callId: string;
    rev: number;
    pv: number;
    root: string;
    components: Record<string, Component>;
    data: JsonObject;
    computed?: Record<string, JsonValue>;
    /** A call waits for an action. */
    waiting: boolean;
    last?: { name: string; by: string; at: number };
    final?: { text: string };
    /** The controls this person may use. */
    can: Record<string, boolean>;
    updatedAt: number;
};

/** One surface for one person; `nameOf` gives a person's name from an id. */
export function viewOf(
    surface: Surface,
    person: { id: string; role: string },
    nameOf: (id: string) => string,
): SurfaceView {
    return {
        id: surface.id,
        title: surface.title,
        status: surface.status,
        who: surface.who,
        by: nameOf(surface.by),
        callId: surface.callId,
        rev: surface.rev,
        pv: surface.pv,
        root: surface.root,
        components: surface.components,
        data: surface.data,
        ...(surface.computed === undefined ? {} : { computed: surface.computed }),
        waiting: surface.wait !== undefined,
        ...(surface.last === undefined
            ? {}
            : {
                  last: {
                      name: surface.last.name,
                      by: nameOf(surface.last.by),
                      at: surface.last.at,
                  },
              }),
        ...(surface.final === undefined ? {} : { final: { text: surface.final.text } }),
        can: surface.status === "open" ? controlsFor(surface, person) : {},
        updatedAt: surface.updatedAt,
    };
}
