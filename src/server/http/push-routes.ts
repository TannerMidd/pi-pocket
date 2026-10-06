/** `/api/push`: phone notifications. */
import { describe, HttpError } from "../errors.ts";
import { type ApiRequest, json, readJson } from "./io.ts";

/** Phone notifications: this device's subscription, what to notify about, and a test. */
export async function pushRoutes(api: ApiRequest, action: string | undefined): Promise<void> {
    const { app, request, response, user } = api;
    const store = app.pushStore;

    if (store === undefined) {
        throw new HttpError(503, "Push notifications are not available on this server.");
    }

    const method = request.method ?? "GET";

    if (action === undefined && method === "GET") {
        return json(response, 200, {
            publicKey: store.publicKey,
            prefs: store.prefs(user.id),
            devices: store.subscriptions(user.id).length,
        });
    }

    if (method !== "POST") {
        throw new HttpError(404, "Unknown push route");
    }

    if (action === "subscribe") {
        const body = await readJson<{
            subscription?: { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
        }>(request);
        const sub = body.subscription;

        try {
            store.subscribe(
                user.id,
                {
                    endpoint: String(sub?.endpoint ?? ""),
                    keys: {
                        p256dh: String(sub?.keys?.p256dh ?? ""),
                        auth: String(sub?.keys?.auth ?? ""),
                    },
                },
                String(request.headers["user-agent"] ?? "").slice(0, 200),
            );
        } catch (error) {
            throw new HttpError(400, describe(error));
        }

        return json(response, 200, { ok: true, devices: store.subscriptions(user.id).length });
    }

    if (action === "unsubscribe") {
        const body = await readJson<{ endpoint?: unknown }>(request);

        store.unsubscribe(String(body.endpoint ?? ""), user.id);

        return json(response, 200, { ok: true, devices: store.subscriptions(user.id).length });
    }

    if (action === "prefs") {
        const body = await readJson<Record<string, unknown>>(request);
        const patch: Record<string, boolean> = {};

        for (const key of ["done", "approval", "chat", "mention"]) {
            if (typeof body[key] === "boolean") {
                patch[key] = body[key] as boolean;
            }
        }

        return json(response, 200, { prefs: store.setPrefs(user.id, patch) });
    }

    if (action === "test") {
        const sent = await store.notify(user.id, {
            title: "Pi Pocket",
            body: `Notifications work on this device, ${user.name}.`,
            url: "/",
            tag: "test",
        });

        if (sent === 0) {
            throw new HttpError(
                409,
                "No device took the test notification. Turn notifications on again on this device.",
            );
        }

        return json(response, 200, { sent });
    }

    throw new HttpError(404, "Unknown push route");
}
