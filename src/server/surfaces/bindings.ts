/**
 * What a person may change on a surface and who may do it. A person's `set` must name a path that an input control
 * binds (a text field, a check box, a choice, a table's selection or editable column), and the value must fit that
 * control. A `pattern` is never run here: it comes from Pi, and a regular expression that Pi chose could stall the
 * server on what a person typed; the browser tests it in the form. `mayAct` decides by role. Pure functions: the `act` route and the room's per-person projection use them.
 */
import type { JsonValue } from "@earendil-works/chord/json";
import { pointer, readPath } from "../../../web/surfaces-expr.js";
import { type Component, LIMITS, type Surface, type Who } from "./types.ts";
import { extensionComponent } from "./components.ts";
import { isObject, optionValues } from "./validate.ts";

/** A person's problem with what they sent: the route answers it as 400. */
export class InputError extends Error {}

export type Binding = {
    /** The control that binds the path. */
    control: string;
    /** The cleaned value to store. */
    check(value: unknown): JsonValue;
};

const UNSEEN =
    /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;

function oneOf(options: unknown, value: unknown): string {
    const allowed = optionValues(options);

    if (typeof value !== "string" || !allowed.includes(value)) {
        throw new InputError("That is not one of the choices");
    }

    return value;
}

function text(component: Component, value: unknown): string {
    const max = typeof component.max === "number" ? component.max : LIMITS.string;

    if (typeof value !== "string") {
        throw new InputError("A text is needed");
    }

    const cleaned = value.replace(UNSEEN, "");

    if (cleaned.length > max) {
        throw new InputError(`Keep it to ${max} characters`);
    }

    if (component.multiline !== true && /[\r\n]/.test(cleaned)) {
        throw new InputError("One line only");
    }

    return cleaned;
}

const boolean = (value: unknown): boolean => {
    if (typeof value !== "boolean") {
        throw new InputError("True or false is needed");
    }

    return value;
};

/** The control that binds `path`, with a check for its value, or undefined when no input control binds it. */
export function bindingFor(surface: Surface, path: string): Binding | undefined {
    const found = pointer(path);

    if (found === undefined || path.startsWith("/$")) {
        return undefined;
    }

    for (const [id, component] of Object.entries(surface.components)) {
        if (component.type.startsWith("x.") && component.bind === path) {
            const bound = extensionComponent(component.type)?.bind;

            if (bound !== undefined) {
                return {
                    control: id,
                    check: (value) => {
                        const result = bound.validate(value);

                        if (!result.ok) {
                            throw new InputError("That value does not fit this control");
                        }

                        return JSON.parse(JSON.stringify(result.value)) as JsonValue;
                    },
                };
            }
        }

        if (component.type === "TextField" && component.bind === path) {
            return { control: id, check: (value) => text(component, value) };
        }

        if (component.type === "CheckBox" && component.bind === path) {
            return { control: id, check: boolean };
        }

        if (component.type === "ChoicePicker" && component.bind === path) {
            return {
                control: id,
                check: (value) => {
                    if (component.multiple === true) {
                        if (!Array.isArray(value) || new Set(value).size !== value.length) {
                            throw new InputError("A list of choices is needed");
                        }

                        return value.map((each) => oneOf(component.options, each));
                    }

                    return oneOf(component.options, value);
                },
            };
        }

        if (component.type === "Table" && typeof component.rows === "string") {
            const rows = pointer(component.rows)!;

            if (found.length === rows.length + 2 && rows.every((part, at) => found[at] === part)) {
                const index = found[rows.length]!;
                const name = found[rows.length + 1]!;
                const list = readPath(component.rows, { data: surface.data });

                if (
                    !Array.isArray(list) ||
                    !/^(0|[1-9]\d*)$/.test(index) ||
                    !isObject(list[Number(index)])
                ) {
                    continue;
                }

                if (component.select === name) {
                    return { control: id, check: boolean };
                }

                const column = (component.columns as Record<string, JsonValue>[]).find(
                    (each) => each.bind === name,
                );

                if (column !== undefined) {
                    return {
                        control: id,
                        check: (value) =>
                            column.options === undefined
                                ? text({ type: "TextField", max: 500 }, value)
                                : oneOf(column.options, value),
                    };
                }
            }
        }
    }

    return undefined;
}

/** The `who` of a control: its own wins over the surface's. */
export function whoOf(surface: Surface, control: string): Who {
    const own = surface.components[control]?.who;

    return typeof own === "string" ? (own as Who) : surface.who;
}

/** Whether a person may act: the owner always; `requester` also the person Pi worked for; `steer` guests; `anyone` viewers. */
export function mayAct(person: { id: string; role: string }, who: Who, by: string): boolean {
    if (person.role === "owner") {
        return true;
    }

    if (who === "anyone") {
        return true;
    }

    if (person.role === "viewer") {
        return false;
    }

    return who === "steer" || (who === "requester" && person.id === by);
}

/** Every control of a surface that a person with `can` may use: the ids the browser enables. */
export function controlsFor(
    surface: Surface,
    person: { id: string; role: string },
): Record<string, boolean> {
    const out: Record<string, boolean> = {};

    for (const [id, component] of Object.entries(surface.components)) {
        if (
            component.type === "Button" ||
            component.type === "TextField" ||
            component.type === "CheckBox" ||
            component.type === "ChoicePicker" ||
            component.type === "Table" ||
            (component.type.startsWith("x.") && typeof component.bind === "string")
        ) {
            out[id] = mayAct(person, whoOf(surface, id), surface.by);
        }
    }

    return out;
}
