/** The server issues upload descriptors. Only a placed input's references can pass on to a fork. */
import { createHash, randomUUID } from "node:crypto";
import { linkSync, lstatSync, realpathSync, unlinkSync } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { basename, join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import { IssuedUploadsDoc } from "./docs.ts";
import { UPLOAD_INPUT } from "./entry-format.ts";
import { HttpError } from "./errors.ts";
import { openNoFollow } from "./no-follow.ts";
import type { BoundUpload } from "./upload-content.ts";

export type Attachment = { path: string; name: string; mime: string; size: number };

const validRef = (ref: unknown): ref is string =>
    typeof ref === "string" && /^[1-9]\d*\/(?!\.{1,2}$)[^/\\\x00-\x1f]+$/u.test(ref);

export function uploadInput(refs: readonly string[]) {
    return refs.length === 0
        ? {}
        : {
              entry: { kind: UPLOAD_INPUT, data: { uploads: [...refs] } },
          };
}

export function uploadData(entry: unknown) {
    const input = entry as { kind?: unknown; data?: { uploads?: unknown } } | null | undefined;

    return input?.kind === UPLOAD_INPUT ? input.data : undefined;
}

export function uploadRefs(entry: unknown): string[] {
    const refs = uploadData(entry)?.uploads;

    return Array.isArray(refs) ? refs.filter(validRef) : [];
}

function notIssued(): HttpError {
    return new HttpError(400, "Not a file uploaded to this session. Attach the file again.");
}

type UploadStore = Pick<PocketApp, "dataDir" | "canonicalDataDir" | "managedStorage">;

function intact(path: string, expected: string) {
    try {
        return realpathSync.native(path) === expected;
    } catch {
        return false;
    }
}

function pinnedFolder(app: UploadStore, id: ConversationId, create = false): string {
    try {
        const folder = app.managedStorage.uploadFolder(Number(id), create);

        if (folder === join(app.canonicalDataDir, "uploads", String(id))) {
            return folder;
        }
    } catch {
        // Do not accept a directory that no longer has the identity recorded by the store.
    }

    throw notIssued();
}

export function uploadDirectory(app: UploadStore, id: ConversationId): string {
    pinnedFolder(app, id, true);

    return join(app.dataDir, "uploads", String(id));
}

/** Keep the bytes outside the published upload tree until the receipt admits them. */
export async function createUpload(app: PocketApp, id: ConversationId, name: string) {
    if (name !== basename(name) || !validRef(String(id) + "/" + name)) {
        throw notIssued();
    }

    const dir = uploadDirectory(app, id);
    const targetDir = pinnedFolder(app, id);
    const target = join(targetDir, name);
    const path = join(dir, name);
    const stage = join(app.canonicalDataDir, ".upload-" + randomUUID());
    const handle = await open(stage, "wx", 0o600);

    try {
        const original = await handle.stat({ bigint: true });

        const ours = (file: string) => {
            if (!intact(file, file)) {
                return false;
            }

            const found = lstatSync(file, { bigint: true, throwIfNoEntry: false });

            return found?.isFile() && found.dev === original.dev && found.ino === original.ino;
        };

        if (!ours(stage)) {
            throw notIssued();
        }

        return {
            handle,
            async accept(by: string, metadata: Omit<Attachment, "path">, received: string) {
                const file = { ...metadata, path };
                const sha256 = await fileDigest(stage, stage, file.size);

                if (sha256 !== received) {
                    throw notIssued();
                }

                const authorize = () => {
                    if (!app.steeringUser(id, by)) {
                        throw new HttpError(403, "You can no longer upload to this session.");
                    }

                    app.workspace.requireLocal(id);

                    if (
                        pinnedFolder(app, id) !== targetDir ||
                        !intact(dir, targetDir) ||
                        !ours(stage)
                    ) {
                        throw notIssued();
                    }

                    if (lstatSync(target, { throwIfNoEntry: false })) {
                        throw new HttpError(409, "An upload with this name already exists.");
                    }
                };

                await recordUpload(app, id, file, sha256, authorize);

                try {
                    authorize();
                    // Only link complete bytes after their receipt is durable. Never fall back to an overwriting rename or a partial copy.
                    linkSync(stage, target);

                    if (!ours(target)) {
                        throw notIssued();
                    }
                } catch (error) {
                    await app.harness.commit(async (tx) => {
                        const issued = await tx.doc(IssuedUploadsDoc, id);
                        const receipt = issued.files[name];

                        if (
                            receipt?.name === file.name &&
                            receipt.mime === file.mime &&
                            receipt.size === file.size &&
                            receipt.sha256 === sha256
                        ) {
                            delete issued.files[name];
                        }
                    }, BACKGROUND_CONTEXT);

                    if (
                        ["EXDEV", "ENOTSUP", "EOPNOTSUPP"].includes(
                            (error as NodeJS.ErrnoException).code ?? "",
                        )
                    ) {
                        throw new HttpError(
                            500,
                            "The upload store must support hard links on the same filesystem as the data folder.",
                        );
                    }

                    throw error;
                }

                return file;
            },
            async close() {
                try {
                    if (ours(stage)) {
                        unlinkSync(stage);
                    }
                } catch {
                    app.log("Could not remove a private upload staging file.");
                } finally {
                    await handle.close();
                }
            },
        };
    } catch (error) {
        await handle.close();

        throw error;
    }
}

function digest(app: UploadStore, id: ConversationId, path: string, size: number): Promise<string> {
    const parts = ["uploads", String(id), basename(path)];

    if (path !== join(app.dataDir, ...parts)) {
        throw notIssued();
    }

    return fileDigest(path, join(pinnedFolder(app, id), basename(path)), size);
}

async function fileDigest(path: string, target: string, size: number): Promise<string> {
    try {
        if ((await realpath(path)) !== target) {
            throw notIssued();
        }

        const file = await openNoFollow(target);

        try {
            const stat = await file.stat();

            if (!stat.isFile() || stat.size !== size) {
                throw notIssued();
            }

            const hash = createHash("sha256");

            for await (const chunk of file.createReadStream()) {
                hash.update(chunk);
            }

            return hash.digest("hex");
        } finally {
            await file.close();
        }
    } catch {
        throw notIssued();
    }
}

/** Trusted setup of an existing file. An HTTP upload must go through createUpload().accept(). */
export async function issueUpload(
    app: PocketApp,
    id: ConversationId,
    file: Attachment,
): Promise<void> {
    await recordUpload(app, id, file, await digest(app, id, file.path, file.size));
}

async function recordUpload(
    app: PocketApp,
    id: ConversationId,
    file: Attachment,
    sha256: string,
    admit?: () => void,
): Promise<void> {
    const key = basename(file.path);
    const { name, mime, size } = file;

    await app.harness.commit(async (tx) => {
        const issued = await tx.doc(IssuedUploadsDoc, id);

        if (Object.hasOwn(issued.files, key)) {
            throw new HttpError(409, "Upload already issued.");
        }

        admit?.();
        issued.files[key] = { name, mime, size, sha256 };
    }, BACKGROUND_CONTEXT);
}

/** Submission keeps the receipt for conversion. Editing gets only the public descriptors. */
export function checkedUploads(
    app: PocketApp,
    id: ConversationId,
    request: { attachments: Attachment[] },
): Promise<(Attachment & BoundUpload)[]>;
export function checkedUploads(
    app: PocketApp,
    id: ConversationId,
    request: { refs: string[] },
): Promise<Attachment[]>;

export async function checkedUploads(
    app: PocketApp,
    id: ConversationId,
    request: { attachments: Attachment[] } | { refs: string[] },
): Promise<Attachment[]> {
    const inputs = "refs" in request ? request.refs : request.attachments;

    if (inputs.length === 0) {
        return [];
    }

    const files = (await app.harness.snapshot(IssuedUploadsDoc, id, BACKGROUND_CONTEXT))?.files;
    const attachments: Attachment[] = [];
    const checked = new Set<string>();

    for (const input of inputs) {
        if (typeof input === "string" && !("refs" in request)) {
            throw notIssued();
        }

        const key =
            typeof input === "string"
                ? input.split("/")[1]
                : typeof input?.path === "string"
                  ? basename(input.path)
                  : undefined;

        if (!key || !validRef(String(id) + "/" + key) || !files || !Object.hasOwn(files, key)) {
            throw notIssued();
        }

        const path = join(app.dataDir, "uploads", String(id), key);
        const { name, mime, size, sha256 } = files[key]!;

        if (
            (typeof input === "string"
                ? input !== String(id) + "/" + key
                : input.path !== path ||
                  input.name !== name ||
                  input.mime !== mime ||
                  input.size !== size) ||
            (!checked.has(key) && (await digest(app, id, path, size)) !== sha256)
        ) {
            throw notIssued();
        }

        checked.add(key);
        const file = { path, name, mime, size };
        const checkedFile = "refs" in request ? file : { ...file, content: { size, sha256 } };

        attachments.push(checkedFile);
    }

    return attachments;
}
