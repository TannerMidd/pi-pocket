/**
 * The two tool schema kinds that pi-schema's builders write differently from TypeBox: a string literal and a record.
 * These give the JSON Schema that TypeBox gave, so Pi Pocket's tools kept their schemas when they moved to pi-schema.
 */
import type { Annotations, Schema } from "@earendil-works/pi-schema";

/** Exactly the string `value`, as `{ type: "string", const }`: pi-schema's `lit` has no `type`. */
export function literal<const V extends string>(value: V, options?: Annotations<V>): Schema<V> {
    return { type: "string", const: value, ...options } as Schema<V>;
}

/** An object with any string keys and `value` values, as `patternProperties`: pi-schema's `map` uses `additionalProperties`. */
export function record<T>(
    value: Schema<T>,
    options?: Annotations<Record<string, T>> & { readonly maxProperties?: number },
): Schema<Record<string, T>> {
    return { type: "object", patternProperties: { "^.*$": value }, ...options } as Schema<
        Record<string, T>
    >;
}
