/**
 * A surface as plain text: the form the transcript, an export, and a fork show (`transcript`), the numbered form the
 * relay sends to a chat (`relay`, with the target of each number), and the short form of a push (`push`: the title
 * only, never values). One pure function, golden-tested.
 */
import type { JsonValue } from "@earendil-works/chord/json";
import { bytes, evaluate, evaluateComputed, readPath, textOf } from "../../../web/surfaces-expr.js";
import { componentText, extensionComponent, propsOf } from "./components.ts";
import { type Component, type Surface, type Target } from "./types.ts";
import { childrenOf, isObject, optionValues } from "./validate.ts";

export type TextForm = "transcript" | "relay" | "push";

type Scope = { data: JsonValue; computed: Record<string, unknown>; row?: unknown };

const SEPARATOR = "   ";

function labelOf(option: JsonValue): string {
    return typeof option === "string" ? option : textOf((option as { label: JsonValue }).label);
}

/** A table cell as text: a field of the row, in bytes when the column says so. */
function cell(row: unknown, column: Record<string, JsonValue>): string {
    const name = String(column.value ?? column.bind);
    const value = readPath(name, { data: {}, row });

    return column.format === "bytes" ? bytes(value) : textOf(value);
}

function stateWord(state: unknown): string {
    return textOf(state) || "idle";
}

/**
 * The text of a surface and, for the relay form, what each number does. A number is given to every control the person
 * may use in a chat: a check box or a table row toggles, a choice's option picks, a button presses, a text field
 * takes `N: text`.
 */
export function render(
    surface: Surface,
    form: TextForm,
): { text: string; map: Record<string, Target> } {
    if (form === "push") {
        return { text: surface.title, map: {} };
    }

    const numbered = form === "relay";
    const scope: Scope = {
        data: surface.data,
        computed: evaluateComputed(surface.computed, surface.data),
    };
    const map: Record<string, Target> = {};
    const hints: { first?: string; press?: string; text?: string } = {};
    const live = surface.status === "open";
    let number = 0;

    const next = (target: Target, hint?: "first" | "press" | "text", label = ""): string => {
        if (!numbered || !live) {
            return "";
        }

        number += 1;
        map[String(number)] = target;

        if (hint === "first") {
            hints.first ??= `"${number}" to toggle ${label}`;
        } else if (hint === "press") {
            hints.press ??= `"${number}" to press ${label}`;
        } else if (hint === "text") {
            hints.text ??= `"${number}: your text" to fill ${label}`;
        }

        return `${number} `;
    };

    const lines = (id: string): string[] => {
        const component = surface.components[id] as Component | undefined;

        if (component === undefined) {
            return [];
        }

        const value = (expr: unknown) => evaluate(expr, scope);
        const kids = () => childrenOf(component).map(lines);

        switch (component.type) {
            case "Column": {
                return kids().flat();
            }

            case "Card": {
                return [
                    ...(typeof component.title === "string" ? [component.title] : []),
                    ...kids().flat(),
                ];
            }

            case "Row": {
                const each = kids().filter((part) => part.length > 0);

                return each.every((part) => part.length === 1)
                    ? [each.map((part) => part[0]).join(SEPARATOR)]
                    : each.flat();
            }

            case "Text": {
                return textOf(value(component.text)).split("\n");
            }

            case "Divider": {
                return ["---"];
            }

            case "Image": {
                return [`[image: ${textOf(component.alt) || "no description"}]`];
            }

            case "Button": {
                const label = String(component.label);
                const disabled = Boolean(value(component.disabled));

                if (disabled || surface.status !== "open") {
                    return [numbered ? label : `[${label}]`];
                }

                const mark = next({ kind: "press", control: id }, "press", label);

                return [numbered ? `${mark}${label}` : `[${label}]`];
            }

            case "TextField": {
                const mark = next(
                    { kind: "text", path: String(component.bind) },
                    "text",
                    String(component.label),
                );
                const current = textOf(readPath(String(component.bind), scope));

                return [
                    `${mark}${String(component.label)}: ${current === "" ? "(empty)" : current}`,
                ];
            }

            case "CheckBox": {
                const on = readPath(String(component.bind), scope) === true;
                const mark = next(
                    { kind: "toggle", path: String(component.bind) },
                    "first",
                    String(component.label),
                );

                return [`${mark}[${on ? "x" : " "}] ${String(component.label)}`];
            }

            case "ChoicePicker": {
                const current = readPath(String(component.bind), scope);
                const picked = (option: string) =>
                    Array.isArray(current) ? current.includes(option) : current === option;
                const options = Array.isArray(component.options) ? component.options : [];
                const values = optionValues(options);

                return [
                    `${String(component.label)}:`,
                    ...options.map((option, at) => {
                        const mark = next(
                            {
                                kind: "pick",
                                path: String(component.bind),
                                value: values[at]!,
                                ...(component.multiple === true ? { multiple: true } : {}),
                            },
                            "first",
                            `${String(component.label)}: ${labelOf(option)}`,
                        );

                        return `${mark}[${picked(values[at]!) ? "x" : " "}] ${labelOf(option)}`;
                    }),
                ];
            }

            case "Table": {
                const rows = readPath(String(component.rows), scope);
                const columns = (component.columns ?? []) as Record<string, JsonValue>[];
                const select = typeof component.select === "string" ? component.select : undefined;

                return (Array.isArray(rows) ? rows : []).map((row, at) => {
                    const shown = columns.map((column) => cell(row, column)).join("  ");

                    if (select === undefined) {
                        return shown;
                    }

                    const on = isObject(row) && row[select] === true;
                    const mark = next(
                        { kind: "toggle", path: `${String(component.rows)}/${at}/${select}` },
                        "first",
                        `row ${at + 1}`,
                    );

                    return `${mark}[${on ? "x" : " "}] ${shown}`;
                });
            }

            case "Status": {
                const detail = textOf(value(component.detail));
                const progress = value(component.progress);
                const percent =
                    typeof progress === "number" ? ` ${Math.round(progress * 100)}%` : "";

                return [
                    `[${stateWord(value(component.state))}] ${String(component.label)}${detail === "" ? "" : `: ${detail}`}${percent}`,
                ];
            }

            default: {
                // An extension's component gives its own text; a type this code does not know (a later version's, or an
                // extension's whose module is off) shows what text it has.
                const registered = extensionComponent(component.type);
                const own =
                    registered === undefined
                        ? undefined
                        : componentText(registered, propsOf(component), surface.data);

                return [
                    own ??
                        surface.fallbacks?.[id] ??
                        textOf(component.text ?? component.label ?? component.type),
                ];
            }
        }
    };

    const body = lines(surface.root);
    const out: string[] = [];

    if (numbered) {
        out.push(`${surface.title} (${surface.id}).${live ? " Reply with numbers:" : ""}`);
    } else {
        out.push(surface.title);
    }

    out.push(...body);

    if (surface.status !== "open") {
        out.push(
            surface.final === undefined
                ? `(${surface.status})`
                : `(${surface.status}) ${surface.final.text}`,
        );
    } else if (numbered) {
        const hint = [hints.first, hints.press, hints.text].filter((each) => each !== undefined);

        if (hint.length > 0) {
            out.push(`Reply ${hint.join(", ")}.`);
        }
    }

    return { text: out.join("\n"), map };
}

/** The text of a surface in one of its forms. */
export function toText(surface: Surface, form: TextForm): string {
    return render(surface, form).text;
}
