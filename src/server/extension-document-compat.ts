/** The drop-in-only Pi Durable namespace: every export keeps its identity except the 2 document constructors. */
import * as durable from "@earendil-works/pi-durable";
import { reportCheckpointDefault } from "./extension-document-imports.ts";

export * from "@earendil-works/pi-durable";

/** Pi Durable 1.6 renamed `runEndTask` to `hookTask`: a drop-in written before still imports the old name. */
export const runEndTask = durable.hookTask;
export type RunEndTask = durable.HookTask;

/** Copy a missing policy, including frozen definitions, without changing any stored document semantics. */
function checkpointDefault<T extends { readonly kind: string; readonly checkpointWhen?: unknown }>(
    definition: T,
): T {
    if (definition.checkpointWhen !== undefined) {
        return definition;
    }

    reportCheckpointDefault(import.meta.url, definition.kind);

    return Object.create(Object.getPrototypeOf(definition), {
        ...Object.getOwnPropertyDescriptors(definition),
        checkpointWhen: {
            value: () => false,
            enumerable: true,
            writable: true,
            configurable: true,
        },
    }) as T;
}

export const defineDoc = ((definition: Parameters<typeof durable.defineDoc>[0]) =>
    durable.defineDoc(checkpointDefault(definition))) as typeof durable.defineDoc;

export const defineDocFamily = ((definition: Parameters<typeof durable.defineDocFamily>[0]) =>
    durable.defineDocFamily(checkpointDefault(definition))) as typeof durable.defineDocFamily;
