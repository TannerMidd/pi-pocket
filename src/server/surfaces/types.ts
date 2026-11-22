/**
 * The shapes of Pocket Surfaces: a surface Pi shows in the transcript (`docs/design/surfaces.md`), stored in
 * `SurfacesDoc` (`../docs.ts`). Stored data: a surface's `v` is its vocabulary's version, and the code never drops a
 * component type that stored surfaces use.
 */
import type { JsonValue } from "@earendil-works/chord/json";

export type JsonObject = { [key: string]: JsonValue };

/** Who may act on a control: the owner always; `requester` also the person Pi worked for; `steer` also guests; `anyone` also viewers. */
export type Who = "owner" | "requester" | "steer" | "anyone";

export const WHO: readonly Who[] = ["owner", "requester", "steer", "anyone"];

/** An expression (`web/surfaces-expr.js`) or a literal. */
export type Expr = JsonValue;

/** A stored component: its type and props; its id is its key in `Surface.components`. */
export type Component = { type: string } & { [prop: string]: JsonValue };

/** What one number of the relay's text form does (`relay`, slice 2). */
export type Target =
    | { kind: "toggle"; path: string }
    | { kind: "pick"; path: string; value: string; multiple?: boolean }
    | { kind: "press"; control: string }
    | { kind: "text"; path: string };

export type SurfaceStatus = "open" | "done" | "closed" | "expired" | "cancelled";

export type Surface = {
    /** The surface format version (the vocabulary of components). */
    v: 1;
    id: string;
    title: string;
    status: SurfaceStatus;
    /** The default permission for its controls. */
    who: Who;
    /** The user id Pi worked for when it was made. */
    by: string;
    taskId: string;
    /** The `ui` call that made it: the transcript card finds the surface by it. */
    callId: string;
    createdAt: number;
    updatedAt: number;
    /** Every change. */
    rev: number;
    /** Pi's changes (layout, patches) only: an action must name the one the person saw. */
    pv: number;
    root: string;
    components: Record<string, Component>;
    data: JsonObject;
    computed?: Record<string, Expr>;
    /** How many waits this surface has had: never reset, so a signal key (`<id>.<gen>`) serves one wait only. */
    gen?: number;
    /** The wait a `ui` call is parked in: a signal under `key` wakes it. `gen` is this wait's number. */
    wait?: { taskId: string; key: string; gen: number; until?: number };
    /** The plain text of each extension component, kept while its module is on: it still shows when the module is off. */
    fallbacks?: Record<string, string>;
    /** Actions waiting to reach the session as a message: written with the action, cleared when delivered. */
    pending?: PendingDelivery[];
    /** The latest action delivered. */
    last?: { name: string; by: string; at: number };
    /** Set when the status leaves `open`: the text the transcript, an export, and a fork show. */
    final?: { text: string; values?: JsonValue };
    /** The id A2UI messages call this surface by (`a2ui.ts`), when it came from them. */
    a2ui?: string;
    /** The A2UI components as sent, by id: an update that repeats only some of them is read with the others. */
    a2uiRaw?: Record<string, JsonObject>;
    relay?: {
        connector: string;
        channel: string;
        thread?: string;
        msgId?: string;
        pv: number;
        map: Record<string, Target>;
    };
};

/** An action for the session that is recorded but not yet delivered (`pending.ts`). */
export type PendingDelivery = {
    rev: number;
    name: string;
    text: string;
    /** The user id Pi worked for when the card was made: who the message is from, when they can still reach the session. */
    by: string;
    sender: { name: string; id: string; trusted: boolean };
};

export type SurfacesState = { seq: number; items: Record<string, Surface> };

/** What an action delivers to the parked tool, and what the session reads. */
export type Acted = {
    name: string;
    by: string;
    at: number;
    values: JsonValue;
};

/** The limits of a surface. */
export const LIMITS = {
    surfaces: 40,
    open: 12,
    bytes: 48 * 1024,
    components: 200,
    depth: 8,
    actions: 20,
    items: 500,
    string: 2000,
    text: 4000,
    title: 80,
    label: 40,
    fieldLabel: 120,
    ops: 50,
    url: 2000,
    image: 64 * 1024,
    context: 16 * 1024,
    rowsKeys: 40,
} as const;
