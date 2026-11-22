/** Jev Hub shows the owner recent classifier verdicts, counts, and deadlines without keeping inputs. */
import { trackClassifier } from "../classifier-activity.ts";
import type { ExtensionWeb, PocketHost } from "../host.ts";

export default function createJevHub(host: PocketHost, web?: ExtensionWeb): void {
    if (web === undefined || typeof host.classify !== "function") {
        return;
    }

    const activity = trackClassifier(host.classify);

    web.onDispose(activity.stop);
    web.route("GET", "activity", activity.snapshot, { access: "owner" });
    web.client("jev-hub", { access: "owner" });
}
