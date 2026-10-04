import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ConfigStore, Role, User } from "./config.ts";

export const COOKIE = "pocket_auth";
const INVITE_TTL_MS = 15 * 60_000;

export function parseCookies(header: string | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	for (const part of (header ?? "").split(";")) {
		const index = part.indexOf("=");
		if (index <= 0) continue;
		const key = part.slice(0, index).trim();
		const value = part.slice(index + 1).trim();
		try {
			out[key] = decodeURIComponent(value);
		} catch {
			out[key] = value;
		}
	}
	return out;
}

/** https when the request came through TLS or a TLS-terminating tunnel such as ngrok or Tailscale Funnel. */
export function isHttps(request: IncomingMessage): boolean {
	const forwarded = String(request.headers["x-forwarded-proto"] ?? "").split(",")[0]?.trim();
	return forwarded === "https" || (request.socket as { encrypted?: boolean }).encrypted === true;
}

export function origin(request: IncomingMessage): string {
	const host = String(request.headers["x-forwarded-host"] ?? request.headers.host ?? "localhost");
	return `${isHttps(request) ? "https" : "http"}://${host}`;
}

export function setAuthCookie(request: IncomingMessage, response: ServerResponse, token: string): void {
	const parts = [
		`${COOKIE}=${encodeURIComponent(token)}`,
		"Path=/",
		"HttpOnly",
		"SameSite=Lax",
		`Max-Age=${60 * 60 * 24 * 365}`,
		...(isHttps(request) ? ["Secure"] : []),
	];
	response.setHeader("set-cookie", parts.join("; "));
}

export function clearAuthCookie(response: ServerResponse): void {
	response.setHeader("set-cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/** What an invite grants: a role, and optionally a single session instead of all of them. */
export type InviteGrant = { role: Exclude<Role, "owner">; session?: string };

type Invite = InviteGrant & { expiresAt: number; createdBy: string };

export class Auth {
	readonly #config: ConfigStore;
	readonly #invites = new Map<string, Invite>();

	constructor(config: ConfigStore) {
		this.#config = config;
	}

	user(request: IncomingMessage): User | undefined {
		const token = parseCookies(request.headers.cookie)[COOKIE];
		if (token === undefined || token === "") {
			const bearer = String(request.headers.authorization ?? "");
			if (bearer.startsWith("Bearer ")) return this.#config.userByToken(bearer.slice(7).trim());
			return undefined;
		}
		return this.#config.userByToken(token);
	}

	tokenUser(token: string): User | undefined {
		return this.#config.userByToken(token);
	}

	createInvite(by: User, grant: InviteGrant = { role: "guest" }): { code: string; expiresAt: number } {
		this.#prune();
		// Unambiguous characters, easy to type on a phone.
		const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
		const bytes = randomBytes(10);
		let code = "";
		for (const byte of bytes) code += alphabet[byte % alphabet.length];
		const expiresAt = Date.now() + INVITE_TTL_MS;
		this.#invites.set(code, { ...grant, expiresAt, createdBy: by.id });
		return { code, expiresAt };
	}

	/** The grant of a live invite, or undefined when it expired or was used. */
	invite(code: string): InviteGrant | undefined {
		this.#prune();
		const invite = this.#invites.get(code);
		return invite === undefined ? undefined : { role: invite.role, ...(invite.session === undefined ? {} : { session: invite.session }) };
	}

	inviteValid(code: string): boolean {
		return this.invite(code) !== undefined;
	}

	/** Spend an invite on a new device: a user with the invite's role and scope, and its own token. */
	redeem(code: string, name: string): { user: User; token: string } | undefined {
		this.#prune();
		const invite = this.#invites.get(code);
		if (invite === undefined) return undefined;
		this.#invites.delete(code);
		// The person who made it must still be allowed to: not removed, not view only, not limited to one session.
		const creator = this.#config.userById(invite.createdBy);
		if (creator === undefined || creator.role === "viewer" || creator.sessions !== undefined) return undefined;
		const clean = name.replace(/\s+/g, " ").trim().slice(0, 40) || "Guest";
		return this.#config.addUser(clean, invite.role, invite.session === undefined ? undefined : [invite.session]);
	}

	#prune(): void {
		const now = Date.now();
		for (const [code, invite] of this.#invites) if (invite.expiresAt < now) this.#invites.delete(code);
	}
}
