import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The repository root: `web/`, `src/`, and `node_modules/` live here. */
export const APP_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** Where Pi Pocket keeps its database, users, uploads, and logs. */
export function dataDir(): string {
    return process.env.PI_POCKET_DIR ?? join(homedir(), ".pi-pocket");
}

/** owner: everything. guest: steers Pi (which can run commands here). viewer: reads, chats, and reacts, never steers. */
export type Role = "owner" | "guest" | "viewer";

export interface User {
    id: string;
    name: string;
    role: Role;
    /** sha256 of the user's login token; the token itself is only kept for the owner. */
    tokenHash: string;
    createdAt: number;
    lastSeen?: number;
    /** Conversation ids of the only sessions this person may open; absent means every session. */
    sessions?: string[];
    /**
     * The Cloudflare quick tunnel host (`abc-def.trycloudflare.com`) this person's device signed in through. Its sign-in
     * cookie works only there, and each tunnel gets a new address, so they are removed once that tunnel is gone.
     */
    tunnel?: string;
    /** The most Pi may spend for this person, in dollars; never for the owner. */
    budget?: number;
}

/** An invite not yet used, kept by its code's sha256 (the code itself is only shown to whoever made it). */
export interface StoredInvite {
    codeHash: string;
    role: Role;
    /** The one session it is for; absent means every session. Never set for an owner invite. */
    session?: string;
    expiresAt: number;
    /** Who made it: it works only while they may still invite. */
    createdBy: string;
}

export interface ModelChoice {
    provider: string;
    modelId: string;
    thinkingLevel?: string;
}

interface PocketConfig {
    version: 1;
    /** Printed in the login URL at every start. Keep this file private. */
    ownerToken: string;
    users: User[];
    /** Invites not yet used: kept here so one that lasts a day or a week outlives a restart. */
    invites?: StoredInvite[];
    lastModel?: ModelChoice;
    /** Extension modules (file names in `src/server/extensions/`) the owner turned off. */
    disabledExtensions?: string[];
    /** Extension modules the owner turned on. Matters for modules that are off by default, like Lancet Guard. */
    enabledExtensions?: string[];
    /** "others": a guest cannot allow a risky call that their own message led to. Absent: anyone who can steer may. */
    approvals?: ApprovalRule;
}

/** Who may allow a risky tool call: anyone who can steer, or (for guests) only someone other than who asked. */
export type ApprovalRule = "anyone" | "others";

function newToken(): string {
    return randomBytes(24).toString("base64url");
}

function hashToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
}

function sameHash(a: string, b: string): boolean {
    const left = Buffer.from(a, "hex");
    const right = Buffer.from(b, "hex");

    return left.length === right.length && timingSafeEqual(left, right);
}

/** The most invites one person keeps live at once. */
export const MAX_INVITES = 50;

/** `config.json` in the data directory, written atomically with mode 0600. */
export class ConfigStore {
    readonly file: string;
    #config: PocketConfig;

    constructor(directory: string) {
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        this.file = join(directory, "config.json");

        if (existsSync(this.file)) {
            this.#config = JSON.parse(readFileSync(this.file, "utf8")) as PocketConfig;
        } else {
            const ownerToken = newToken();

            this.#config = {
                version: 1,
                ownerToken,
                users: [
                    {
                        id: randomUUID(),
                        name: "Owner",
                        role: "owner",
                        tokenHash: hashToken(ownerToken),
                        createdAt: Date.now(),
                    },
                ],
            };
            this.save();
        }
    }

    get ownerToken(): string {
        return this.#config.ownerToken;
    }

    get users(): readonly User[] {
        return this.#config.users;
    }

    get lastModel(): ModelChoice | undefined {
        return this.#config.lastModel;
    }

    set lastModel(choice: ModelChoice | undefined) {
        this.#config.lastModel = choice;
        this.save();
    }

    get approvalRule(): ApprovalRule {
        return this.#config.approvals ?? "anyone";
    }

    set approvalRule(rule: ApprovalRule) {
        if (rule === "anyone") {
            delete this.#config.approvals;
        } else {
            this.#config.approvals = rule;
        }

        this.save();
    }

    get disabledExtensions(): readonly string[] {
        return this.#config.disabledExtensions ?? [];
    }

    get enabledExtensions(): readonly string[] {
        return this.#config.enabledExtensions ?? [];
    }

    /** Whether the owner turned a module on or off; undefined when they never chose, so its default applies. */
    extensionChoice(file: string): boolean | undefined {
        if (this.#config.disabledExtensions?.includes(file)) {
            return false;
        }

        if (this.#config.enabledExtensions?.includes(file)) {
            return true;
        }

        return undefined;
    }

    setExtensionEnabled(file: string, enabled: boolean): void {
        const disabled = new Set(this.#config.disabledExtensions ?? []);
        const turnedOn = new Set(this.#config.enabledExtensions ?? []);

        if (enabled) {
            disabled.delete(file);
            turnedOn.add(file);
        } else {
            disabled.add(file);
            turnedOn.delete(file);
        }

        if (disabled.size === 0) {
            delete this.#config.disabledExtensions;
        } else {
            this.#config.disabledExtensions = [...disabled].sort();
        }

        if (turnedOn.size === 0) {
            delete this.#config.enabledExtensions;
        } else {
            this.#config.enabledExtensions = [...turnedOn].sort();
        }

        this.save();
    }

    userByToken(token: string): User | undefined {
        const hash = hashToken(token);

        return this.#config.users.find((user) => sameHash(user.tokenHash, hash));
    }

    userById(id: string): User | undefined {
        return this.#config.users.find((user) => user.id === id);
    }

    addUser(name: string, role: Role, sessions?: string[]): { user: User; token: string } {
        const token = newToken();
        const user: User = {
            id: randomUUID(),
            name,
            role,
            tokenHash: hashToken(token),
            createdAt: Date.now(),
            ...(sessions === undefined ? {} : { sessions: [...sessions] }),
        };

        this.#config.users.push(user);
        this.save();

        return { user, token };
    }

    updateUser(
        id: string,
        patch: Partial<Pick<User, "name" | "lastSeen" | "role" | "sessions" | "tunnel" | "budget">>,
    ): void {
        const user = this.userById(id);

        if (user === undefined) {
            return;
        }

        // The owner stays the owner, and nobody else becomes one.
        if (patch.role !== undefined && (user.role === "owner" || patch.role === "owner")) {
            delete patch.role;
        }

        if ("sessions" in patch && user.role === "owner") {
            delete patch.sessions;
        }

        if ("budget" in patch && user.role === "owner") {
            delete patch.budget;
        }

        Object.assign(user, patch);

        if (user.sessions === undefined) {
            delete user.sessions;
        }

        if (user.budget === undefined) {
            delete user.budget;
        }

        this.save();
    }

    /** Remove someone (never the owner), and the invites they made, which could no longer be used. */
    removeUser(id: string): void {
        this.#config.users = this.#config.users.filter(
            (user) => user.id !== id || user.role === "owner",
        );

        if (!this.#config.users.some((user) => user.id === id)) {
            this.#config.invites = this.#config.invites?.filter(
                (invite) => invite.createdBy !== id,
            );
        }

        this.save();
    }

    /** Keep a new invite. A person keeps at most `MAX_INVITES` live: beyond that, their oldest ends. */
    addInvite(code: string, invite: Omit<StoredInvite, "codeHash">): void {
        this.#pruneInvites();
        const theirs = (this.#config.invites ?? []).filter(
            (each) => each.createdBy === invite.createdBy,
        );
        const ending = new Set(theirs.slice(0, Math.max(0, theirs.length - MAX_INVITES + 1)));

        this.#config.invites = [
            ...(this.#config.invites ?? []).filter((each) => !ending.has(each)),
            { codeHash: hashToken(code), ...invite },
        ];
        this.save();
    }

    /** A live invite by its code, or undefined when there is none or it expired. */
    invite(code: string): StoredInvite | undefined {
        this.#pruneInvites();
        const hash = hashToken(code);

        return this.#config.invites?.find((invite) => sameHash(invite.codeHash, hash));
    }

    /** Remove an invite, and say whether it was there (and live). */
    removeInvite(code: string): boolean {
        const found = this.invite(code);

        if (found === undefined) {
            return false;
        }

        this.#config.invites = this.#config.invites?.filter((invite) => invite !== found);
        this.save();

        return true;
    }

    #pruneInvites(): void {
        const now = Date.now();
        const live = (this.#config.invites ?? []).filter((invite) => invite.expiresAt >= now);

        if (live.length !== (this.#config.invites ?? []).length) {
            this.#config.invites = live;
            this.save();
        }
    }

    /**
     * Replace the owner token, signing out every device that used the old one. Owner invites not yet used go too: one
     * spent later would hand out the new token.
     */
    rotateOwnerToken(): string {
        const token = newToken();

        this.#config.ownerToken = token;
        const owner = this.#config.users.find((user) => user.role === "owner");

        if (owner !== undefined) {
            owner.tokenHash = hashToken(token);
        }

        if (this.#config.invites !== undefined) {
            this.#config.invites = this.#config.invites.filter((invite) => invite.role !== "owner");
        }

        this.save();

        return token;
    }

    save(): void {
        mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
        const temp = `${this.file}.${process.pid}.tmp`;

        writeFileSync(temp, `${JSON.stringify(this.#config, null, "\t")}\n`, { mode: 0o600 });
        renameSync(temp, this.file);
        chmodSync(this.file, 0o600);
    }
}
