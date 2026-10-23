/**
 * What an artifact's page saves for the person using it (`pocket.state` in the page, `web/artifact-bridge.js`): one
 * JSON value for each artifact, person, and session, kept apart from the artifact's versions and from Pi's context.
 * A page names a schema to tell old values from new ones: a value saved under another schema reads as none.
 */
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import type { User } from "./config.ts";
import { ArtifactStateDoc, ArtifactsDoc } from "./docs.ts";
import { HttpError } from "./errors.ts";

/** The most one value may take, as JSON. */
export const STATE_BYTES = 16 * 1024;
/**
 * The most values one session keeps, artifacts times the people who saved for them: with `STATE_BYTES`, under 5 MB.
 * A person removed from the app keeps their values until the session goes, counted here.
 */
const MAX_VALUES = 300;
/** How many saves one person may make for one artifact within `WINDOW_MS`: a page saves as its controls change. */
const SAVES = 20;
const WINDOW_MS = 10_000;
const SCHEMA = /^[A-Za-z0-9._:-]{1,64}$/;

/** The recent saves of each person, artifact, and session: memory only, as a limit needs no more. */
const recent = new Map<string, number[]>();

/** The schema label a page gives, checked: up to 64 letters, digits, and `. _ : -`. */
function schemaOf(schema: unknown): string | undefined {
    if (schema === undefined || schema === null || schema === "") {
        return undefined;
    }

    if (typeof schema !== "string" || !SCHEMA.test(schema)) {
        throw new HttpError(400, "A schema is up to 64 letters, digits, and . _ : -");
    }

    return schema;
}

/** The artifact must be one of the session's own: an id names no other session's, nor `__proto__`. */
async function requireArtifact(app: PocketApp, id: ConversationId, artifact: string) {
    const index = await app.harness.snapshot(ArtifactsDoc, id, BACKGROUND_CONTEXT);

    if (index === undefined || !Object.hasOwn(index.items, artifact)) {
        throw new HttpError(404, "No such artifact");
    }
}

/** What this person saved for the artifact, or null: none, or saved under another schema. */
export async function readState(
    app: PocketApp,
    id: ConversationId,
    user: User,
    artifact: string,
    schema: unknown,
): Promise<{ state: JsonValue | null; at: number | null }> {
    const wanted = schemaOf(schema);

    await requireArtifact(app, id, artifact);

    const doc = await app.harness.snapshot(ArtifactStateDoc, id, BACKGROUND_CONTEXT);
    const mine =
        doc !== undefined && Object.hasOwn(doc.items, artifact)
            ? doc.items[artifact]![user.id]
            : undefined;

    if (mine === undefined || mine.schema !== wanted) {
        return { state: null, at: null };
    }

    return { state: mine.value, at: mine.at };
}

/**
 * Save this person's value for the artifact, or clear it with null. Throws 413 past `STATE_BYTES`, 429 past `SAVES` in
 * `WINDOW_MS`, and 409 when the session keeps `MAX_VALUES` already.
 */
export async function writeState(
    app: PocketApp,
    id: ConversationId,
    user: User,
    artifact: string,
    body: { state?: unknown; schema?: unknown },
): Promise<{ at: number | null }> {
    const schema = schemaOf(body.schema);
    const value = (body.state ?? null) as JsonValue;

    if (Buffer.byteLength(JSON.stringify(value)) > STATE_BYTES) {
        throw new HttpError(413, `A page may save up to ${STATE_BYTES / 1024} KB`);
    }

    await requireArtifact(app, id, artifact);

    const now = Date.now();
    const key = `${id}\n${user.id}\n${artifact}`;
    const saves = (recent.get(key) ?? []).filter((at) => at > now - WINDOW_MS);

    if (saves.length >= SAVES) {
        throw new HttpError(429, "The page saves too often: wait a moment");
    }

    recent.set(key, [...saves, now]);

    // Keep the memory small: forget those with no save in the window.
    if (recent.size > 5000) {
        for (const [each, times] of recent) {
            if (times.at(-1)! <= now - WINDOW_MS) {
                recent.delete(each);
            }
        }
    }

    return app.harness.commit(async (tx) => {
        const doc = await tx.doc(ArtifactStateDoc, id);
        const own = Object.hasOwn(doc.items, artifact);

        if (value === null) {
            if (own) {
                delete doc.items[artifact]![user.id];

                if (Object.keys(doc.items[artifact]!).length === 0) {
                    delete doc.items[artifact];
                }
            }

            return { at: null };
        }

        const count = Object.values(doc.items).reduce(
            (sum, people) => sum + Object.keys(people).length,
            0,
        );
        const fresh = !own || doc.items[artifact]![user.id] === undefined;

        if (fresh && count >= MAX_VALUES) {
            throw new HttpError(409, "This session keeps no more saved pages");
        }

        if (!own) {
            doc.items[artifact] = {};
        }

        doc.items[artifact]![user.id] = {
            value,
            ...(schema === undefined ? {} : { schema }),
            at: now,
        };

        return { at: now };
    }, BACKGROUND_CONTEXT);
}
