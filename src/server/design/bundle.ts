/** A design's bundle, read from the artifact documents: the page, and every asset of the version. */
import type { Context } from "@earendil-works/chord";
import type { ConversationId, DocumentReader } from "@earendil-works/pi-durable";
import { ArtifactAssetDoc, ArtifactBodyDoc, ArtifactsDoc, type ArtifactMeta } from "../docs.ts";
import type { PocketHost } from "../host.ts";

export type DesignBundle = {
    meta: ArtifactMeta;
    version: number;
    content: string;
    assets: { name: string; type: string; bytes: Buffer }[];
};

export async function readBundle(
    _host: PocketHost,
    snapshot: DocumentReader["snapshot"],
    conversation: ConversationId,
    id: string,
    version: number | undefined,
    context: Context,
): Promise<DesignBundle> {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) {
        throw new Error("Use the artifact's kebab-case id.");
    }

    if (version !== undefined && (!Number.isSafeInteger(version) || version < 1)) {
        throw new Error("Version must be a positive integer.");
    }

    // The same documents `PocketApp.artifactBundle` reads: the index, the version's body, and its assets by hash.
    const index = await snapshot(ArtifactsDoc, conversation, context);
    const meta =
        index !== undefined && Object.hasOwn(index.items, id) ? index.items[id] : undefined;
    const record = meta?.versions.find(
        (item) => item.version === (version ?? meta.versions.at(-1)?.version),
    );

    if (meta === undefined || record === undefined) {
        throw new Error("The artifact or version does not exist.");
    }

    if (meta.type !== "html") {
        throw new Error("Design tools require an HTML artifact.");
    }

    const body = await snapshot(ArtifactBodyDoc, conversation, `${id}@${record.version}`, context);

    if (body === undefined) {
        throw new Error("The artifact content is missing.");
    }

    const assets = await Promise.all(
        Object.entries(record.assets ?? {}).map(async ([name, asset]) => {
            const stored = await snapshot(ArtifactAssetDoc, asset.hash, context);

            if (stored === undefined) {
                throw new Error(`The artifact asset ${name} is missing.`);
            }

            return { name, type: asset.type, bytes: Buffer.from(stored.base64, "base64") };
        }),
    );

    return { meta, version: record.version, content: body.content, assets };
}
