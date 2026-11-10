/**
 * Favorite working folders: private to each person, saved in SQLite, and sent to all their connected devices. Each
 * computer has its own: this server's in `users` (as before computers had any, so older favorites stay this server's),
 * and a linked computer's (`runners.ts`) in `runners`, by the computer's id.
 */
import { posix, win32 } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { PocketApp } from "./app.ts";
import type { User } from "./config.ts";
import { type FolderFavorites as Stored, FolderFavoritesDoc } from "./docs.ts";
import { HttpError } from "./errors.ts";

const MAX_FAVORITES = 100;

/** Each linked computer's favorites of one person, by the computer's id. */
export type RunnerFavorites = Record<string, string[]>;

/**
 * A folder as a favorite keeps it: normalized, without a slash at its end. This server's are absolute here; another
 * computer's are absolute there, in its own form (`/Users/me/x`, `C:\x`). Undefined when it is no absolute path.
 */
function favoritePath(path: string, onRunner: boolean): string | undefined {
    if (posix.isAbsolute(path) && !(onRunner && path.startsWith("\\"))) {
        return posix.normalize(path).replace(/(.)\/$/, "$1");
    }

    if (onRunner && /^[A-Za-z]:[\\/]/.test(path)) {
        return win32.normalize(path).replace(/^(.:\\.*?)\\$/, "$1");
    }

    return undefined;
}

export class FolderFavorites {
    readonly #app: PocketApp;

    constructor(app: PocketApp) {
        this.#app = app;
    }

    /** This server's favorites of `user`. */
    async list(user: User): Promise<string[]> {
        const doc = await this.#app.harness.snapshot(FolderFavoritesDoc, BACKGROUND_CONTEXT);

        return [...(doc?.users[user.id] ?? [])];
    }

    /** The favorites of `user` on each linked computer: only the computers they may use. */
    async runners(user: User): Promise<RunnerFavorites> {
        const doc = await this.#app.harness.snapshot(FolderFavoritesDoc, BACKGROUND_CONTEXT);

        return this.#runnersOf(doc, user);
    }

    #runnersOf(doc: Stored | null | undefined, user: User): RunnerFavorites {
        const own: RunnerFavorites = {};

        for (const [runner, folders] of Object.entries(doc?.runners?.[user.id] ?? {})) {
            if (this.#app.runners.mayUse(runner, user) && folders.length > 0) {
                own[runner] = [...folders];
            }
        }

        return own;
    }

    /**
     * Explicit star/unstar, not toggle: retries and two devices cannot undo one another's request. `runner`: a folder
     * on that linked computer, only for people who may use it; absent or null: this server's.
     */
    async set(
        user: User,
        request: { path?: unknown; starred?: unknown; runner?: unknown },
    ): Promise<void> {
        const app = this.#app;

        app.requireSteer(user);

        if (user.sessions !== undefined) {
            throw new HttpError(403, "You were invited to one session and cannot start new ones.");
        }

        const runner = request.runner ?? undefined;

        if (runner !== undefined && (typeof runner !== "string" || runner === "")) {
            throw new HttpError(400, "runner must be a computer's id, or null for this server.");
        }

        if (runner !== undefined) {
            app.runners.require(runner);

            if (!app.runners.mayUse(runner, user)) {
                throw new HttpError(403, "You cannot use this computer.");
            }
        }

        const path =
            typeof request.path === "string" &&
            request.path.length <= 4096 &&
            !/[\u0000-\u001f\u007f]/.test(request.path)
                ? favoritePath(request.path, runner !== undefined)
                : undefined;

        if (path === undefined || typeof request.starred !== "boolean") {
            throw new HttpError(
                400,
                "A favorite needs an absolute folder path and a starred boolean.",
            );
        }

        await app.harness.commit(async (tx) => {
            const doc = await tx.doc(FolderFavoritesDoc);

            // Read back what was assigned: the draft records changes to its own objects, not to the literals put in.
            if (runner !== undefined) {
                doc.runners ??= {};
                doc.runners[user.id] ??= {};
            }

            const mine = runner === undefined ? undefined : doc.runners![user.id]!;

            const folders = [...((mine === undefined ? doc.users[user.id] : mine[runner!]) ?? [])];

            const save = (next: string[]) => {
                if (mine === undefined) {
                    doc.users[user.id] = next;
                } else if (next.length > 0) {
                    mine[runner!] = next;
                } else {
                    delete mine[runner!];
                }
            };

            if (request.starred) {
                if (folders.includes(path)) {
                    return;
                }

                if (folders.length >= MAX_FAVORITES) {
                    throw new HttpError(409, "You can keep up to 100 favorite folders.");
                }

                save([...folders, path]);
            } else {
                save(folders.filter((folder) => folder !== path));
            }
        }, BACKGROUND_CONTEXT);
    }

    /** Only committed lists reach browsers, and only the lists belonging to the signed-in person. */
    committed(value: Stored | null): void {
        for (const client of this.#app.clients) {
            client.send("folder-favorites", [...(value?.users[client.user.id] ?? [])]);
            client.send("runner-favorites", this.#runnersOf(value, client.user));
        }
    }
}
