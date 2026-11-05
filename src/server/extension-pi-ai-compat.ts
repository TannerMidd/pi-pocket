/**
 * The drop-in-only `@earendil-works/pi-ai`: pi-ai, plus TypeBox's `Type`, which pi-ai's main entry no longer exports
 * since Pi 1.5, and a `StringEnum` built with TypeBox, as Pi's own extension loader gives. Drop-ins and gallery
 * extensions written before it build their tool schemas with `Type`.
 */
import { type TUnsafe, Type } from "typebox";

export * from "@earendil-works/pi-ai";
export { Type };

/** `{ type: "string", enum }` as a TypeBox schema, so `Type.Optional` around it stays out of the JSON. */
export function StringEnum<const T extends readonly string[]>(
    values: T,
    options?: { description?: string; default?: T[number] },
): TUnsafe<T[number]> {
    return Type.Unsafe<T[number]>({
        type: "string",
        enum: values,
        ...(options?.description === undefined ? {} : { description: options.description }),
        ...(options?.default === undefined ? {} : { default: options.default }),
    });
}
