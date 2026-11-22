/** The signal that wakes a `ui` call parked on a surface: an action delivers it in the commit that stores the action. */
import { defineSignal } from "@earendil-works/pi-durable";
import { num, obj, str, unknown } from "@earendil-works/pi-schema";

export const SurfaceActed = defineSignal({
    name: "pocket.surface-acted",
    version: 1,
    schema: obj({ name: str(), by: str(), at: num(), values: unknown() }),
});
