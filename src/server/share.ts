/**
 * Artifacts published to anyone with the address (`/pub/:token`): a token that needs no sign-in, which shows one artifact
 * version, or follows its newest. Each share closes at its time, or stays until it is ended.
 */
import { randomBytes } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import type { User } from "./config.ts";
import { type ArtifactShare, ArtifactSharesDoc, ArtifactsDoc } from "./docs.ts";
import { HttpError } from "./errors.ts";

/** How long a share may last, in hours: a day, a week, a month, or, as `undefined`, until it is ended. */
export const SHARE_HOURS = [24, 7 * 24, 30 * 24] as const;

/** The most shares one conversation keeps at once. */
const MAX_SHARES = 100;

/** A token that names nothing else: 16 random bytes, 32 characters of hex. */
function newToken(): string {
    return randomBytes(16).toString("hex");
}

/** Whether a share has closed: one with no time stays until it is ended. */
function closed(share: ArtifactShare, now: number): boolean {
    return share.expiresAt !== undefined && share.expiresAt <= now;
}

/** A share as its people see it: the address of the page, and what it shows. */
export type ShareView = {
    token: string;
    path: string;
    id: string;
    title: string;
    type: string;
    /** The version it shows, or null for the artifact's newest. */
    version: number | null;
    createdAt: number;
    expiresAt: number | null;
};

export class Shares {
    readonly #app: PocketApp;

    constructor(app: PocketApp) {
        this.#app = app;
    }

    /**
     * Whether someone may publish, end, and see the addresses of shares: only those who see every session and steer. A
     * public page is out of the reach of whatever an invite to one session gave, and so is its address.
     */
    mayManage(user: User): boolean {
        return user.role !== "viewer" && user.sessions === undefined;
    }

    /** Refuse someone who may not publish or end a share (`mayManage`). */
    #requireManage(user: User, message: string): void {
        this.#app.requireSteer(user);

        if (!this.mayManage(user)) {
            throw new HttpError(403, message);
        }
    }

    /**
     * Every share of a conversation that is in force, newest first. One that has closed is left out. Someone who may not
     * manage shares gets none: a share's address is its whole access.
     */
    async list(conversation: ConversationId, user: User): Promise<ShareView[]> {
        const app = this.#app;

        if (!this.mayManage(user)) {
            return [];
        }

        const doc = await app.harness.snapshot(ArtifactSharesDoc, BACKGROUND_CONTEXT);
        const artifacts =
            (await app.harness.snapshot(ArtifactsDoc, conversation, BACKGROUND_CONTEXT))?.items ??
            {};
        const now = app.now();
        const shares: ShareView[] = [];

        for (const [token, share] of Object.entries(doc?.items ?? {})) {
            if (share.conversation !== String(conversation) || closed(share, now)) {
                continue;
            }

            const meta = artifacts[share.id];

            if (meta === undefined) {
                continue;
            }

            shares.push({
                token,
                path: `/pub/${token}`,
                id: share.id,
                title: meta.title,
                type: meta.type,
                version: share.version ?? null,
                createdAt: share.createdAt,
                expiresAt: share.expiresAt ?? null,
            });
        }

        return shares.sort((a, b) => b.createdAt - a.createdAt);
    }

    /**
     * Publish one artifact version, or its newest, to anyone with the address. Only someone who sees every session may: a
     * public page is out of the reach of whatever an invite to one session gave.
     */
    async create(
        conversation: ConversationId,
        user: User,
        request: { id?: unknown; version?: unknown; hours?: unknown },
    ): Promise<ShareView> {
        const app = this.#app;

        this.#requireManage(user, "Only people who see every session can publish one to anyone.");

        const id = String(request.id ?? "");
        const pinned = request.version !== undefined && request.version !== null;
        const found = await app.artifactBody(
            conversation,
            id,
            pinned ? Number(request.version) : undefined,
        );
        let hours: number | undefined;

        if (request.hours !== undefined && request.hours !== null) {
            hours = SHARE_HOURS.find((each) => each === request.hours);

            if (hours === undefined) {
                throw new HttpError(
                    400,
                    "A share lasts a day, a week, a month, or until you end it.",
                );
            }
        }

        const now = app.now();
        const expiresAt = hours === undefined ? undefined : now + hours * 60 * 60 * 1000;
        let token = "";

        await app.harness.commit(async (tx) => {
            const doc = await tx.doc(ArtifactSharesDoc);

            // Shares that closed show nothing and are listed nowhere: they go, and count for nothing.
            for (const [old, share] of Object.entries(doc.items)) {
                if (closed(share, now)) {
                    delete doc.items[old];
                }
            }

            const mine = Object.values(doc.items).filter(
                (share) => share.conversation === String(conversation),
            );

            if (mine.length >= MAX_SHARES) {
                throw new HttpError(409, `One session keeps ${MAX_SHARES} shares at most.`);
            }

            token = newToken();

            const share: ArtifactShare = {
                conversation: String(conversation),
                id,
                by: user.id,
                createdAt: now,
                ...(pinned ? { version: found.version } : {}),
                ...(expiresAt === undefined ? {} : { expiresAt }),
            };

            doc.items[token] = share;
        }, BACKGROUND_CONTEXT);

        return {
            token,
            path: `/pub/${token}`,
            id,
            title: found.meta.title,
            type: found.meta.type,
            version: pinned ? found.version : null,
            createdAt: now,
            expiresAt: expiresAt ?? null,
        };
    }

    /**
     * End a share of this conversation: its address answers nothing after. Only someone who sees every session may. A
     * share of another conversation is not found here.
     */
    async revoke(user: User, conversation: ConversationId, token: string): Promise<void> {
        this.#requireManage(user, "Only people who see every session end one.");

        const gone = await this.#app.harness.commit(async (tx) => {
            const doc = await tx.doc(ArtifactSharesDoc);

            if (
                !Object.hasOwn(doc.items, token) ||
                doc.items[token]!.conversation !== String(conversation)
            ) {
                return false;
            }

            delete doc.items[token];

            return true;
        }, BACKGROUND_CONTEXT);

        if (!gone) {
            throw new HttpError(404, "No such share");
        }
    }

    /** What a published token shows now, for a request with no sign-in: undefined when it is gone or has closed. */
    async open(token: string) {
        const app = this.#app;
        const doc = await app.harness.snapshot(ArtifactSharesDoc, BACKGROUND_CONTEXT);
        const share = Object.hasOwn(doc?.items ?? {}, token) ? doc!.items[token] : undefined;

        if (share === undefined || closed(share, app.now())) {
            return undefined;
        }

        try {
            const found = await app.artifactBody(
                Number(share.conversation) as unknown as ConversationId,
                share.id,
                share.version,
            );

            return { share, found };
        } catch (error) {
            // The artifact, or the version it shows, is gone: the address shows nothing, as one that closed does.
            if (error instanceof HttpError) {
                return undefined;
            }

            throw error;
        }
    }
}
