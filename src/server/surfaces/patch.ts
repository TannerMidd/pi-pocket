/**
 * Patch ops on a surface (`ui` with `action: "patch"`): data ops (`set`, `push`, `remove`) and layout ops (`props`,
 * `add`, `drop`). All or nothing: the ops apply to a copy, the whole result is checked, and only then does it replace
 * the surface. Pure functions.
 */
import type { JsonValue } from "@earendil-works/chord/json";
import { pointer } from "../../../web/surfaces-expr.js";
import { type Component, type JsonObject, LIMITS } from "./types.ts";
import {
    checkSurface,
    childrenOf,
    clean,
    flatten,
    isObject,
    type Parts,
    SurfaceError,
} from "./validate.ts";

const FORBIDDEN = new Set(["__proto__", "constructor", "prototype"]);

/** A data path as its parts, never a computed one, never a prototype's. */
function parts(path: unknown, where: string): string[] {
    const found = typeof path === "string" && path.startsWith("/") ? pointer(path) : undefined;

    if (
        found === undefined ||
        found.length === 0 ||
        path === "/$" ||
        (path as string).startsWith("/$/")
    ) {
        throw new SurfaceError(
            `${where}: path must be a data path such as /rows/0/picked ("/$" is computed: read-only)`,
        );
    }

    if (found.some((part) => FORBIDDEN.has(part))) {
        throw new SurfaceError(`${where}: path is not allowed`);
    }

    return found;
}

/** The container a path's last part lives in. */
function parentOf(data: JsonObject, found: string[], where: string): JsonObject | JsonValue[] {
    let at: JsonValue = data;

    for (const part of found.slice(0, -1)) {
        if (Array.isArray(at)) {
            const index = /^(0|[1-9]\d*)$/.test(part) ? Number(part) : -1;

            at = at[index] as JsonValue;
        } else if (isObject(at) && Object.hasOwn(at, part)) {
            at = (at as JsonObject)[part]!;
        } else {
            throw new SurfaceError(`${where}: nothing at /${part}`);
        }

        if (typeof at !== "object" || at === null) {
            throw new SurfaceError(
                `${where}: nothing to put it in at /${found.slice(0, -1).join("/")}`,
            );
        }
    }

    return at as JsonObject | JsonValue[];
}

function index(list: JsonValue[], part: string, where: string, append = false): number {
    const at = /^(0|[1-9]\d*)$/.test(part) ? Number(part) : -1;

    if (at < 0 || at > list.length || (at === list.length && !append)) {
        throw new SurfaceError(
            `${where}: index ${part} is outside the list (${list.length} items)`,
        );
    }

    return at;
}

function dataOp(data: JsonObject, op: Record<string, unknown>, where: string): void {
    const found = parts(op.path, where);
    const parent = parentOf(data, found, where);
    const last = found.at(-1)!;

    if (op.op === "set") {
        if (op.value === undefined) {
            throw new SurfaceError(`${where}: set needs a value`);
        }

        const value = clean(op.value, `${where}.value`);

        if (Array.isArray(parent)) {
            parent[index(parent, last, where)] = value;
        } else {
            parent[last] = value;
        }

        return;
    }

    if (op.op === "push") {
        if (op.value === undefined) {
            throw new SurfaceError(`${where}: push needs a value`);
        }

        const target = Array.isArray(parent)
            ? parent[index(parent, last, where)]
            : Object.hasOwn(parent, last)
              ? parent[last]
              : undefined;

        if (!Array.isArray(target)) {
            throw new SurfaceError(`${where}: ${op.path} is not a list`);
        }

        if (target.length >= LIMITS.items) {
            throw new SurfaceError(`${where}: a list holds at most ${LIMITS.items} items`);
        }

        target.push(clean(op.value, `${where}.value`));

        return;
    }

    if (Array.isArray(parent)) {
        parent.splice(index(parent, last, where), 1);
    } else if (Object.hasOwn(parent, last)) {
        delete parent[last];
    } else {
        throw new SurfaceError(`${where}: nothing at ${op.path}`);
    }
}

function parentIdOf(components: Record<string, Component>, id: string): string | undefined {
    return Object.keys(components).find((each) => childrenOf(components[each]!).includes(id));
}

function layoutOp(state: Parts, op: Record<string, unknown>, where: string): void {
    const { components } = state;

    if (op.op === "props") {
        const id = op.id;

        if (typeof id !== "string" || !Object.hasOwn(components, id)) {
            throw new SurfaceError(`${where}: no component ${JSON.stringify(id)}`);
        }

        if (!isObject(op.props)) {
            throw new SurfaceError(`${where}: props must be an object (a null value drops a prop)`);
        }

        const next: Record<string, JsonValue> = { ...components[id]! };

        for (const [key, value] of Object.entries(op.props)) {
            if (key === "type" || key === "id") {
                throw new SurfaceError(
                    `${where}: ${key} cannot change; drop the component and add another`,
                );
            }

            if (FORBIDDEN.has(key)) {
                throw new SurfaceError(`${where}: the prop ${key} is not allowed`);
            }

            if (value === null) {
                delete next[key];
            } else {
                next[key] = clean(value, `${where}.props.${key}`);
            }
        }

        components[id] = next as Component;

        return;
    }

    if (op.op === "add") {
        const parent = op.parent;

        if (typeof parent !== "string" || !Object.hasOwn(components, parent)) {
            throw new SurfaceError(`${where}: no component ${JSON.stringify(parent)} to add to`);
        }

        const holder = components[parent]!;

        if (!Array.isArray(holder.children)) {
            throw new SurfaceError(`${where}: ${parent} (${holder.type}) holds no children`);
        }

        const made = flatten(op.component, { taken: new Set(Object.keys(components)) });
        const children = [...(holder.children as string[])];
        const at = op.index === undefined ? children.length : Number(op.index);

        if (!Number.isInteger(at) || at < 0 || at > children.length) {
            throw new SurfaceError(`${where}: index must be from 0 to ${children.length}`);
        }

        children.splice(at, 0, made.root);
        Object.assign(components, made.components);
        components[parent] = { ...holder, children };

        return;
    }

    const id = op.id;

    if (typeof id !== "string" || !Object.hasOwn(components, id)) {
        throw new SurfaceError(`${where}: no component ${JSON.stringify(id)}`);
    }

    if (id === state.root) {
        throw new SurfaceError(`${where}: the root cannot be dropped; show a new layout instead`);
    }

    const holder = parentIdOf(components, id);

    if (holder !== undefined) {
        components[holder] = {
            ...components[holder]!,
            children: (components[holder]!.children as string[]).filter((child) => child !== id),
        };
    }

    const drop = (each: string) => {
        childrenOf(components[each]!).forEach(drop);
        delete components[each];
    };

    drop(id);
}

/** What a patch changed: layout ops make `layout` true (its `pv` rises either way). */
export type Patched = { parts: Parts; layout: boolean };

/**
 * The surface after `ops`, or an error naming the op that failed and nothing else changed: the ops run on a copy, and
 * the whole result is checked before it is returned.
 */
export function applyOps(parts: Parts, ops: unknown): Patched {
    if (!Array.isArray(ops) || ops.length === 0 || ops.length > LIMITS.ops) {
        throw new SurfaceError(`ops must be a list of 1 to ${LIMITS.ops} ops`);
    }

    const state: Parts = JSON.parse(JSON.stringify(parts));
    let layout = false;

    for (const [at, op] of ops.entries()) {
        const where = `ops[${at}]`;

        if (!isObject(op)) {
            throw new SurfaceError(`${where}: must be an op, such as { op: "set", path, value }`);
        }

        if (op.op === "set" || op.op === "push" || op.op === "remove") {
            dataOp(state.data, op, where);
        } else if (op.op === "props" || op.op === "add" || op.op === "drop") {
            layoutOp(state, op, where);
            layout = true;
        } else {
            throw new SurfaceError(
                `${where}: unknown op ${JSON.stringify(op.op)}. The ops are set, push, remove, props, add, drop`,
            );
        }
    }

    checkSurface(state);

    return { parts: state, layout };
}
