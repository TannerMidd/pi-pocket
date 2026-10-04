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
	lastModel?: ModelChoice;
	/** Extension modules (file names in `src/server/extensions/`) the owner turned off. */
	disabledExtensions?: string[];
}

export function newToken(): string {
	return randomBytes(24).toString("base64url");
}

export function hashToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

function sameHash(a: string, b: string): boolean {
	const left = Buffer.from(a, "hex");
	const right = Buffer.from(b, "hex");
	return left.length === right.length && timingSafeEqual(left, right);
}

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
				users: [{ id: randomUUID(), name: "Owner", role: "owner", tokenHash: hashToken(ownerToken), createdAt: Date.now() }],
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

	get disabledExtensions(): readonly string[] {
		return this.#config.disabledExtensions ?? [];
	}

	setExtensionEnabled(file: string, enabled: boolean): void {
		const disabled = new Set(this.#config.disabledExtensions ?? []);
		if (enabled) disabled.delete(file);
		else disabled.add(file);
		if (disabled.size === 0) delete this.#config.disabledExtensions;
		else this.#config.disabledExtensions = [...disabled].sort();
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

	updateUser(id: string, patch: Partial<Pick<User, "name" | "lastSeen" | "role" | "sessions" | "tunnel">>): void {
		const user = this.userById(id);
		if (user === undefined) return;
		// The owner stays the owner, and nobody else becomes one.
		if (patch.role !== undefined && (user.role === "owner" || patch.role === "owner")) delete patch.role;
		if ("sessions" in patch && user.role === "owner") delete patch.sessions;
		Object.assign(user, patch);
		if (user.sessions === undefined) delete user.sessions;
		this.save();
	}

	removeUser(id: string): void {
		this.#config.users = this.#config.users.filter((user) => user.id !== id || user.role === "owner");
		this.save();
	}

	/** Replace the owner token, signing out every device that used the old one. */
	rotateOwnerToken(): string {
		const token = newToken();
		this.#config.ownerToken = token;
		const owner = this.#config.users.find((user) => user.role === "owner");
		if (owner !== undefined) owner.tokenHash = hashToken(token);
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
