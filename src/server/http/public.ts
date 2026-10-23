/**
 * `/pub/:token`: an artifact published to anyone with the address, with no sign-in. The token is the whole of the access;
 * what it shows is a version pinned when it was published, or the artifact's newest (`share.ts`).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { PocketApp } from "../app.ts";
import { HttpError } from "../errors.ts";
import { artifactResponse } from "./artifacts.ts";

export async function publicArtifact(
    app: PocketApp,
    request: IncomingMessage,
    response: ServerResponse,
    token: string | undefined,
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

    await artifactResponse(response, published.found, query, false);
}
