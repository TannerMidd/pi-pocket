import { lstatSync, mkdirSync, opendirSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";

export type ManagedStore = "uploads" | "background" | "worktrees";
type FolderScope = {
    version: 1;
    dataPath: string;
    dataId: string;
    store: ManagedStore;
    rootId: string;
    name: string;
};

export type ManagedFolderProof =
    | { state: "unknown" | "changed" }
    | (FolderScope & ({ state: "absent" } | { state: "verified"; childId: string }));

const stores: ManagedStore[] = ["uploads", "background", "worktrees"];
/** Unknown existing folders past this startup budget cannot be collected or issued from. */
const STARTUP_ENTRIES = 8192;

class UnexpectedFolder extends Error {}

function refused(): Error {
    return new UnexpectedFolder("Not the expected managed storage folder.");
}

function identity(path: string, requirePersistent = false): string | undefined {
    const stat = lstatSync(path, { bigint: true, throwIfNoEntry: false });

    if (stat === undefined) {
        return undefined;
    }

    if (!stat.isDirectory() || realpathSync.native(path) !== path) {
        throw refused();
    }

    const id = `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;

    if (stat.ino === 0n || (requirePersistent && !persistent(id))) {
        throw new Error("Managed folder identity unavailable.");
    }

    return id;
}

/** Device and inode alone can be reused. Never persist an identity without a birth time. */
function persistent(id: unknown): id is string {
    return typeof id === "string" && /^[1-9]\d*:[1-9]\d*:[1-9]\d*$/.test(id);
}

function observeChild(
    scope: FolderScope,
    path: string,
    pin: string | undefined,
): ManagedFolderProof {
    if (pin === undefined) {
        return lstatSync(path, { throwIfNoEntry: false })
            ? { state: "unknown" }
            : { ...scope, state: "absent" };
    }

    const childId = identity(path, true);

    if (childId === undefined) {
        return { ...scope, state: "absent" };
    }

    if (!persistent(pin)) {
        return { state: "unknown" };
    }

    return pin === childId ? { ...scope, state: "verified", childId } : { state: "changed" };
}

function validName(store: ManagedStore, name: string): boolean {
    return store === "worktrees"
        ? name !== "" && name !== "." && name !== ".." && basename(name) === name
        : /^[1-9]\d*$/.test(name) && Number.isSafeInteger(Number(name));
}

/** Pin existing folders only at startup. Later, trust a new child only at its creation site. */
export class ManagedStorage {
    readonly canonicalDataDir: string;
    readonly #dataDir: string;
    readonly #ids = new Map<string, string>();

    constructor(dataDir: string) {
        this.#dataDir = dataDir;
        this.canonicalDataDir = realpathSync.native(dataDir);
        const id = identity(this.canonicalDataDir);

        if (!id) {
            throw refused();
        }

        this.#ids.set(this.canonicalDataDir, id);

        for (const store of stores) {
            const path = join(this.canonicalDataDir, store);

            try {
                this.#verifyData();

                if (!lstatSync(path, { throwIfNoEntry: false })) {
                    mkdirSync(path, { mode: 0o700 });
                }

                this.#pin(path);
                const dir = opendirSync(this.root(store));

                try {
                    for (let i = 0; i < STARTUP_ENTRIES; i++) {
                        const entry = dir.readSync();

                        if (entry === null) {
                            break;
                        }

                        if (entry.isDirectory() && validName(store, entry.name)) {
                            try {
                                this.#pin(join(path, entry.name));
                            } catch {
                                // An unverified child stays out of the trusted set.
                            }
                        }
                    }
                } finally {
                    dir.closeSync();
                }
            } catch {
                // An inaccessible store must not prevent startup or be adopted on first use.
                this.#ids.delete(path);
            }
        }
    }

    #pin(path: string): void {
        const id = identity(path);

        if (id === undefined || (this.#ids.has(path) && this.#ids.get(path) !== id)) {
            throw refused();
        }

        this.#ids.set(path, id);
    }

    #verifyData(requirePersistent = false): void {
        if (
            realpathSync.native(this.#dataDir) !== this.canonicalDataDir ||
            identity(this.canonicalDataDir, requirePersistent) !==
                this.#ids.get(this.canonicalDataDir)
        ) {
            throw refused();
        }
    }

    root(store: ManagedStore, requirePersistent = false): string {
        this.#verifyData(requirePersistent);
        const path = join(this.canonicalDataDir, store);
        const id = this.#ids.get(path);

        if (id === undefined || identity(path, requirePersistent) !== id) {
            throw refused();
        }

        return path;
    }

    folder(store: ManagedStore, name: string, create = false): string | undefined {
        if (!validName(store, name)) {
            throw refused();
        }

        const path = join(this.root(store), name);
        const id = identity(path);

        if (id !== undefined) {
            if (id !== this.#ids.get(path)) {
                throw refused();
            }
        } else if (!create) {
            return undefined;
        } else {
            if (this.#ids.has(path)) {
                throw refused();
            }

            mkdirSync(path, { mode: 0o700 });
            this.root(store);
            this.#pin(path);
        }

        return path;
    }

    /** Observe process pins without adding any. Only the observation at authorization is saved. */
    capture(store: ManagedStore, name: string): ManagedFolderProof {
        try {
            if (!stores.includes(store) || typeof name !== "string" || !validName(store, name)) {
                return { state: "unknown" };
            }

            const dataPath = this.canonicalDataDir;
            const dataId = this.#ids.get(dataPath);
            const rootId = this.#ids.get(join(dataPath, store));

            if (!persistent(dataId) || !persistent(rootId)) {
                return { state: "unknown" };
            }

            const path = join(this.root(store, true), name);
            const scope: FolderScope = { version: 1, dataPath, dataId, store, rootId, name };
            const proof = observeChild(scope, path, this.#ids.get(path));

            this.root(store, true);

            return proof;
        } catch (error) {
            const changed =
                error instanceof UnexpectedFolder ||
                (error as NodeJS.ErrnoException)?.code === "ENOENT";

            return { state: changed ? "changed" : "unknown" };
        }
    }

    verifiedFolder(
        store: ManagedStore,
        name: string,
        proof: ManagedFolderProof | undefined,
    ): string | undefined {
        if (
            (proof?.state !== "verified" && proof?.state !== "absent") ||
            proof.version !== 1 ||
            proof.dataPath !== this.canonicalDataDir ||
            proof.store !== store ||
            !stores.includes(store) ||
            proof.name !== name ||
            typeof name !== "string" ||
            !persistent(proof.dataId) ||
            !persistent(proof.rootId) ||
            (proof.state === "verified" ? !persistent(proof.childId) : "childId" in proof)
        ) {
            throw refused();
        }

        const root = join(this.canonicalDataDir, store);
        const pin = this.#ids.get(join(root, name));

        if (
            this.#ids.get(this.canonicalDataDir) !== proof.dataId ||
            this.#ids.get(root) !== proof.rootId ||
            (proof.state === "verified" && pin !== undefined && pin !== proof.childId)
        ) {
            throw refused();
        }

        let folder;

        try {
            folder = this.folder(store, name);

            if (folder === undefined) {
                // A missing ancestor must not count as an absent child.
                this.root(store);
            }
        } catch {
            throw refused();
        }

        if (folder !== undefined && proof.state !== "verified") {
            throw refused();
        }

        return folder;
    }

    uploadFolder(id: number, create = false): string | undefined {
        return this.folder("uploads", String(id), create);
    }

    /** Called only after git creates a new Pocket worktree. */
    recordWorktree(name: string): void {
        if (!validName("worktrees", name)) {
            throw refused();
        }

        this.#pin(join(this.root("worktrees"), name));
    }
}
