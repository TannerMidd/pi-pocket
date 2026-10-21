/** Favorite working folders: private to each person, saved in SQLite, and sent to all their connected devices. */
import { isAbsolute, normalize } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { PocketApp } from "./app.ts";
import type { User } from "./config.ts";
import { FolderFavoritesDoc } from "./docs.ts";
import { HttpError } from "./errors.ts";

const MAX_FAVORITES = 100;

export class FolderFavorites {
    readonly #app: PocketApp;

    constructor(app: PocketApp) {
        this.#app = app;
    }

    async list(user: User): Promise<string[]> {
        const doc = await this.#app.harness.snapshot(FolderFavoritesDoc, BACKGROUND_CONTEXT);

        return [...(doc?.users[user.id] ?? [])];
    }

    /** Explicit star/unstar, not toggle: retries and two devices cannot undo one another's request. */
    async set(user: User, request: { path?: unknown; starred?: unknown }): Promise<void> {
        const app = this.#app;

        app.requireSteer(user);

        if (user.sessions !== undefined) {
            throw new HttpError(403, "You were invited to one session and cannot start new ones.");
        }

        if (
            typeof request.path !== "string" ||
            !isAbsolute(request.path) ||
            request.path.length > 4096 ||
            /[\u0000-\u001f\u007f]/.test(request.path) ||
            typeof request.starred !== "boolean"
        ) {
            throw new HttpError(
                400,
                "A favorite needs an absolute folder path and a starred boolean.",
            );
        }

        const path = normalize(request.path).replace(/\/$/, "") || "/";

        await app.harness.commit(async (tx) => {
            const doc = await tx.doc(FolderFavoritesDoc);
            const folders = [...(doc.users[user.id] ?? [])];

            if (request.starred) {
                if (folders.includes(path)) {
                    return;
                }

                if (folders.length >= MAX_FAVORITES) {
                    throw new HttpError(409, "You can keep up to 100 favorite folders.");
                }

                folders.push(path);
                doc.users[user.id] = folders;
            } else {
                doc.users[user.id] = folders.filter((folder) => folder !== path);
            }
        }, BACKGROUND_CONTEXT);
    }

    /** Only committed lists reach browsers, and only the list belonging to the signed-in person. */
    committed(value: { users: Record<string, string[]> } | null): void {
        for (const client of this.#app.clients) {
            client.send("folder-favorites", [...(value?.users[client.user.id] ?? [])]);
        }
    }
}
