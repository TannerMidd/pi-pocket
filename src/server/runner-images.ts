/** Images copied from a session's computer. Only server-owned uploads are read or written on this disk. */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { FolderAccess } from "./folder-access.ts";
import { isImagePath, MAX_IMAGE_FILE, peekRemoteImage, readRemoteImage } from "./http/assets.ts";
import { HttpError } from "./errors.ts";

export const MAX_RUNNER_IMAGES = 500 * 1024 * 1024;

/** Bind a copy to the computer and working folder that granted the read, not just its spelling. */
export type ImageSource = { runner: string; cwd: string; file: string };
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const prefix = (source: ImageSource) => hash([source.runner, source.cwd, source.file]);
const COPY_NAME = /^[a-f0-9]{64}-[a-f0-9]{64}\.(?:png|jpe?g|gif|webp|avif|bmp|ico|svg)$/;

export class RunnerImages {
    readonly #dataDir: string;
    readonly #queues = new Map<ConversationId, Promise<unknown>>();
    #lastSeen = 0;

    constructor(dataDir: string) {
        this.#dataDir = dataDir;
    }

    directory(id: ConversationId): string {
        return join(this.#dataDir, "uploads", String(id), "runner");
    }

    /** The newest saved copy, also after a restart. Guests get only copies verified under the session's folder. */
    async latest(
        id: ConversationId,
        source: ImageSource,
        shared: boolean,
    ): Promise<string | undefined> {
        const directory = this.directory(id);
        const names = await readdir(directory).catch(() => [] as string[]);
        let newest: { file: string; at: number } | undefined;

        for (const name of names) {
            if (!COPY_NAME.test(name) || !name.startsWith(prefix(source) + "-")) {
                continue;
            }

            const file = join(directory, name);

            try {
                const meta = JSON.parse(await readFile(file + ".json", "utf8")) as {
                    shared?: boolean;
                    seen?: number;
                };
                const info = await stat(file);

                if (
                    (!shared || meta.shared === true) &&
                    info.isFile() &&
                    info.size <= MAX_IMAGE_FILE &&
                    typeof meta.seen === "number" &&
                    Number.isFinite(meta.seen) &&
                    (newest === undefined || meta.seen > newest.at)
                ) {
                    newest = { file, at: meta.seen };
                }
            } catch {
                // An interrupted write, an evicted copy, or damaged metadata is not an offline copy.
            }
        }

        return newest?.file;
    }

    /** Check the computer's version, then keep that version once. Every remote read still uses FolderAccess. */
    copy(
        id: ConversationId,
        source: ImageSource,
        access: FolderAccess,
        shared: boolean,
        target = source.file,
    ): Promise<string> {
        return this.#serial(id, async () => {
            if (!isImagePath(source.file)) {
                throw new HttpError(415, "Only image files can be shown");
            }

            const head = await peekRemoteImage(target, access);
            const nameFor = (size: number, mtimeMs: number) =>
                `${prefix(source)}-${hash([source.file, size, mtimeMs])}${extname(source.file).toLowerCase()}`;
            const directory = this.directory(id);
            let name = nameFor(head.size, head.mtimeMs);
            let file = join(directory, name);
            const existing = await stat(file).catch(() => undefined);

            await mkdir(directory, { recursive: true, mode: 0o700 });

            if (!existing?.isFile() || existing.size !== head.size) {
                const whole = await readRemoteImage(target, access, head);

                // The image can change between its header and its body: name the version actually copied.
                name = nameFor(whole.size, whole.mtimeMs);
                file = join(directory, name);
                await this.#atomic(file, whole.bytes);
            }

            // This flag comes from real paths on the computer. Lexical containment alone would trust a symlink.
            this.#lastSeen = Math.max(Date.now(), this.#lastSeen + 1);
            await this.#atomic(file + ".json", JSON.stringify({ shared, seen: this.#lastSeen }));
            await this.#prune(directory);

            return file;
        });
    }

    async #atomic(file: string, bytes: Buffer | string): Promise<void> {
        const temporary = `${file}.${randomUUID()}.tmp`;

        try {
            await writeFile(temporary, bytes, { mode: 0o600 });
            await rename(temporary, file);
        } finally {
            await rm(temporary, { force: true });
        }
    }

    /** Serialize writes and eviction per session, so simultaneous image requests cannot exceed its budget. */
    #serial<T>(id: ConversationId, run: () => Promise<T>): Promise<T> {
        const before = this.#queues.get(id) ?? Promise.resolve();
        const next = before.catch(() => {}).then(run);

        this.#queues.set(id, next);
        void next
            .finally(() => {
                if (this.#queues.get(id) === next) {
                    this.#queues.delete(id);
                }
            })
            .catch(() => {});

        return next;
    }

    async #prune(directory: string): Promise<void> {
        const copies: { file: string; size: number; at: number }[] = [];
        let total = 0;

        for (const name of await readdir(directory)) {
            if (!COPY_NAME.test(name)) {
                continue;
            }

            const file = join(directory, name);
            const info = await stat(file);

            total += info.size;
            copies.push({ file, size: info.size, at: info.mtimeMs });
        }

        copies.sort((a, b) => a.at - b.at || a.file.localeCompare(b.file));

        for (const copy of copies) {
            if (total <= MAX_RUNNER_IMAGES) {
                break;
            }

            await rm(copy.file, { force: true });
            await rm(copy.file + ".json", { force: true });
            total -= copy.size;
        }
    }
}
