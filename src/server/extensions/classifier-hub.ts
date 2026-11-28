/** Classifier Hub shows the owner recent classifier verdicts, counts, and deadlines without keeping inputs. */
import { trackClassifier } from "../classifier-activity.ts";
import type { ExtensionWeb, PocketHost } from "../host.ts";

export default function createClassifierHub(host: PocketHost, web?: ExtensionWeb): void {
    if (web === undefined || typeof host.classify !== "function") {
        return;
    }

    const activity = trackClassifier(host.classify);

    web.onDispose(activity.stop);
    // The shared choice rides along, so the sheet can say when none is chosen (a server that is not restarted yet has none).
    web.route(
        "GET",
        "activity",
        () => ({
            ...activity.snapshot(),
            classifierModel:
                (typeof host.classifierModel === "function" ? host.classifierModel() : undefined) ??
                null,
        }),
        { access: "owner" },
    );
    web.client("classifier-hub", { access: "owner" });
}
