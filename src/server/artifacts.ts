/**
 * Deleting an artifact (`DELETE /api/c/:id/artifacts/:artifact`). One commit takes its index entry, its version
 * bodies, its share links, what its page saved, and its design comments, so after a restart it is either all there or
 * all gone. Each of those documents then stores a base, which drops the stored revisions that held them. Asset bytes
 * are shared by content hash with every version and session that has the same file: the commit puts the deleted
 * artifact's hashes on a durable list, and a sweep retires the bytes of each that no artifact in any conversation names
 * any more. The sweep runs after each delete and at startup, so one that a restart cut off finishes later.
 *
 * What stays: Pi's own messages, whose tool calls hold the text Pi sent, as the transcript is history.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, Cursor, Tx } from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import type { User } from "./config.ts";
import {
    ArtifactAssetDoc,
    ArtifactBodyDoc,
    ArtifactSharesDoc,
    ArtifactStateDoc,
    ArtifactSweepDoc,
    ArtifactsDoc,
    DesignCommentsDoc,
} from "./docs.ts";
import { HttpError } from "./errors.ts";

const context = BACKGROUND_CONTEXT;

/**
 * The number of an artifact's next version: one past its newest, or past the last one it had before it was deleted, so
 * a number never names two pages.
 */
export function nextVersion(
    doc: {
        items: Record<string, { versions: { version: number }[] }>;
        ended?: Record<string, number>;
    },
    id: string,
): number {
    const newest = Object.hasOwn(doc.items, id)
        ? (doc.items[id]!.versions.at(-1)?.version ?? 0)
        : 0;
    const ended = doc.ended !== undefined && Object.hasOwn(doc.ended, id) ? doc.ended[id]! : 0;

    return Math.max(newest, ended) + 1;
}

/**
 * For a commit that stores asset bytes for a new version: those hashes are in use again, so a sweep that read them as
 * unused before this commit leaves them.
 */
export async function keepAssets(tx: Tx, hashes: Iterable<string>): Promise<void> {
    const sweep = await tx.doc(ArtifactSweepDoc);

    for (const hash of hashes) {
        if (Object.hasOwn(sweep.hashes, hash)) {
            delete sweep.hashes[hash];
        }
    }
}

/**
 * Delete one artifact of a conversation with all its versions. Anyone who sees the session and steers may; the API
 * checked the seeing. Its share links stop at once.
 */
export async function deleteArtifact(
    app: PocketApp,
    conversation: ConversationId,
    user: User,
    artifact: string,
): Promise<{ versions: number }> {
    app.requireSteer(user);

    const versions = await app.harness.commit(async (tx) => {
        const index = await tx.doc(ArtifactsDoc, conversation);
        const meta = Object.hasOwn(index.items, artifact) ? index.items[artifact] : undefined;

        if (meta === undefined) {
            throw new HttpError(404, "No such artifact");
        }

        const last = nextVersion(index, artifact) - 1;
        const hashes = new Set(
            meta.versions.flatMap((each) => Object.values(each.assets ?? {}).map((a) => a.hash)),
        );
        const count = meta.versions.length;

        for (const each of meta.versions) {
            await tx.retireDoc(ArtifactBodyDoc, conversation, `${artifact}@${each.version}`);
        }

        delete index.items[artifact];
        // An own key of `items`, so a slug the tool made: never `__proto__`.
        index.ended ??= {};
        index.ended[artifact] = last;

        const shares = await tx.doc(ArtifactSharesDoc);

        for (const [token, share] of Object.entries(shares.items)) {
            if (share.conversation === String(conversation) && share.id === artifact) {
                delete shares.items[token];
            }
        }

        const state = await tx.doc(ArtifactStateDoc, conversation);

        if (Object.hasOwn(state.items, artifact)) {
            delete state.items[artifact];
        }

        const design = await tx.doc(DesignCommentsDoc, conversation);

        if (Object.hasOwn(design.items, artifact)) {
            delete design.items[artifact];
        }

        if (hashes.size > 0) {
            const sweep = await tx.doc(ArtifactSweepDoc);

            for (const hash of hashes) {
                sweep.seq += 1;
                sweep.hashes[hash] = sweep.seq;
            }
        }

        return count;
    }, context);

    await sweepAssets(app).catch((error: unknown) => {
        console.error("Unused artifact assets could not be removed:", error);
    });

    return { versions };
}

/**
 * Retire the bytes of each listed asset that no artifact in any conversation names: every conversation's index is
 * read, archived ones and subagents' too. A hash that a commit stored again, or listed again, while this read keeps its
 * bytes, or waits for the next sweep. Returns how many went.
 */
export async function sweepAssets(app: PocketApp): Promise<number> {
    const listed = { ...((await app.harness.snapshot(ArtifactSweepDoc, context))?.hashes ?? {}) };

    if (Object.keys(listed).length === 0) {
        return 0;
    }

    const used = new Set<string>();
    let cursor: Cursor | undefined;

    do {
        const page = await app.harness.commit(
            (tx) => tx.scanConversations({}, 256, cursor),
            context,
        );

        for (const { id } of page.items) {
            const index = await app.harness.snapshot(ArtifactsDoc, id, context);

            for (const meta of Object.values(index?.items ?? {})) {
                for (const version of meta.versions) {
                    for (const asset of Object.values(version.assets ?? {})) {
                        if (Object.hasOwn(listed, asset.hash)) {
                            used.add(asset.hash);
                        }
                    }
                }
            }
        }

        cursor = page.next;
    } while (cursor !== undefined);

    return app.harness.commit(async (tx) => {
        const sweep = await tx.doc(ArtifactSweepDoc);
        let gone = 0;

        for (const [hash, seq] of Object.entries(listed)) {
            if (!Object.hasOwn(sweep.hashes, hash) || sweep.hashes[hash] !== seq) {
                continue;
            }

            if (!used.has(hash)) {
                await tx.retireDoc(ArtifactAssetDoc, hash);
                gone += 1;
            }

            delete sweep.hashes[hash];
        }

        return gone;
    }, context);
}
