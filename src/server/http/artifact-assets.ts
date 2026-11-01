/** Bundle path validation, safe MIME types, and sandboxed asset responses. */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { User } from "../config.ts";
import { origin } from "../auth.ts";
import { conversationId } from "./io.ts";
import { posix } from "node:path";
import type { PocketApp } from "../app.ts";
import type { ConversationId } from "@earendil-works/pi-durable";
import { HttpError } from "../errors.ts";
import { send } from "./io.ts";
import { artifactResponse } from "./artifacts.ts";

/** Artifacts must keep an opaque origin, including assets opened in their own tabs. */
export const ARTIFACT_CSP =
    "sandbox allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-pointer-lock allow-downloads; frame-ancestors 'self'";

function signature(
    app: PocketApp,
    conversation: string,
    artifact: string,
    version: string,
    user: User,
    until: string,
): string {
    return createHmac("sha256", app.config.ownerToken)
        .update(
            JSON.stringify([
                "artifact-assets-v1",
                conversation,
                artifact,
                version,
                user.id,
                user.tokenHash,
                until,
            ]),
        )
        .digest("hex");
}

/** Opaque-origin subrequests have no SameSite cookie. This capability grants only one version's assets for 12 hours. */
export function assetRoot(
    app: PocketApp,
    conversation: string,
    artifact: string,
    version: number,
    user: User,
): string {
    const until = String(app.now() + 12 * 60 * 60 * 1000);
    const signed = `${version}~${user.id}~${until}~${signature(app, conversation, artifact, String(version), user, until)}`;

    return `/a/${encodeURIComponent(conversation)}/${encodeURIComponent(artifact)}/${encodeURIComponent(signed)}/`;
}

/** Recheck the person's current access. Removing the person or rotating either token revokes this capability. */
export function assetUser(
    app: PocketApp,
    conversation: string,
    artifact: string,
    signed: string,
): { user: User; version: number } | undefined {
    const [version, id, until, mac, extra] = signed.split("~");
    const user = app.config.users.find((each) => each.id === id);

    if (
        extra !== undefined ||
        user === undefined ||
        !/^[1-9][0-9]*$/.test(version ?? "") ||
        !/^[0-9]+$/.test(until ?? "") ||
        Number(until) <= app.now() ||
        !/^[0-9a-f]{64}$/.test(mac ?? "")
    ) {
        return undefined;
    }

    const expected = signature(app, conversation, artifact, version!, user, until!);

    if (!timingSafeEqual(Buffer.from(mac!, "hex"), Buffer.from(expected, "hex"))) {
        return undefined;
    }

    return { user, version: Number(version) };
}

export function assetName(name: string): boolean {
    return (
        name.length > 0 &&
        name.length <= 200 &&
        name
            .split("/")
            .every((part) => /^[A-Za-z0-9._-]+$/.test(part) && part !== "." && part !== "..")
    );
}

/** Safe bundle MIME types, shared with isolated design rendering. Unknown extensions must remain binary. */
export const ASSET_TYPES: Readonly<Record<string, string>> = Object.freeze({
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".json": "application/json",
    ".txt": "text/plain; charset=utf-8",
    ".csv": "text/csv; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".avif": "image/avif",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".pdf": "application/pdf",
    ".wasm": "application/wasm",
});

/** The extension, never file bytes or model input, decides the response type. */
export function assetType(name: string): string {
    return ASSET_TYPES[posix.extname(name).toLowerCase()] ?? "application/octet-stream";
}

/** A published bundle keeps its existing share token as the sole access capability. */
export async function publicArtifactBundle(
    app: PocketApp,
    request: IncomingMessage,
    response: ServerResponse,
    token: string | undefined,
    name = "",
    query = new URLSearchParams(),
): Promise<void> {
    if (request.method !== "GET" && request.method !== "HEAD") {
        response.setHeader("allow", "GET, HEAD");

        throw new HttpError(405, "Published artifacts are only read");
    }

    const published = token === undefined ? undefined : await app.shares.open(token);

    if (published === undefined) {
        throw new HttpError(404, "No such page");
    }

    const root = `${origin(request)}/pub/${encodeURIComponent(token!)}/`;
    const { found, share } = published;

    if (name !== "") {
        return artifactAssetResponse(
            app,
            response,
            conversationId(share.conversation),
            share.id,
            found.version,
            name,
            root + name.slice(0, name.lastIndexOf("/") + 1),
            false,
        );
    }

    const manifest = found.meta.versions.find((each) => each.version === found.version)!.assets;

    return artifactResponse(
        response,
        found,
        query,
        false,
        Object.keys(manifest ?? {}).length > 0 ? root : undefined,
    );
}

/** Resolve an asset only through the chosen version's manifest, never directly by a global hash. */
export async function artifactAssetResponse(
    app: PocketApp,
    response: ServerResponse,
    conversation: ConversationId,
    artifact: string,
    version: number,
    name: string,
    base: string,
    bridge = true,
): Promise<void> {
    if (!assetName(name)) {
        throw new HttpError(404, "No such asset");
    }

    const asset = await app.artifactAsset(conversation, artifact, version, name);
    const type = assetType(name);

    if (type.startsWith("text/html")) {
        return artifactResponse(
            response,
            {
                meta: { type: "html", title: asset.title },
                content: asset.bytes.toString("utf8"),
            },
            new URLSearchParams(),
            bridge,
            base,
        );
    }

    return send(response, 200, asset.bytes, type, {
        "content-security-policy": ARTIFACT_CSP,
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        // Sandboxed pages send an opaque Origin, including module and font requests.
        "access-control-allow-origin": "*",
    });
}
