/**
 * Web Push notifications without third-party packages. It encrypts a message for one browser subscription
 * (RFC 8291, aes128gcm), signs a VAPID token that identifies this server to the push service (RFC 8292), and POSTs
 * the result (RFC 8030). PushStore keeps the server's VAPID keys, each user's browser subscriptions, and which kinds
 * of notification they want in `push.json` in the data directory.
 */
import { createCipheriv, createECDH, createHash, createHmac, createPrivateKey, randomBytes, sign } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type PushKeys = { p256dh: string; auth: string };
export type PushSubscriptionJson = { endpoint: string; keys: PushKeys };
/** `publicKey`: base64url uncompressed P-256 point (65 bytes); `privateKey`: base64url 32-byte scalar. */
export type VapidKeys = { publicKey: string; privateKey: string };
export type PushPrefs = { done: boolean; approval: boolean; chat: boolean; mention: boolean };
export const DEFAULT_PREFS: PushPrefs = Object.freeze({ done: true, approval: true, chat: true, mention: true });
export type StoredSubscription = PushSubscriptionJson & { userId: string; createdAt: number; userAgent?: string };
export type PushMessage = { title: string; body: string; url: string; tag?: string };
export type Urgency = "very-low" | "low" | "normal" | "high";

const DEFAULT_SUBJECT = "mailto:pi-pocket@example.com";
const DEFAULT_RECORD_SIZE = 4096;
const MAX_BODY = 1000;
const MAX_TITLE = 200;

function hmac(key: Buffer, ...data: Buffer[]): Buffer {
	const mac = createHmac("sha256", key);
	for (const part of data) mac.update(part);
	return mac.digest();
}

/** Decode base64url (padding and standard base64 characters tolerated, as some browsers send them). */
function decode(value: string): Buffer {
	return Buffer.from(value.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_"), "base64url");
}

/** Left-pad a big-endian scalar to 32 bytes (a private key can have leading zero bytes). */
function pad32(value: Buffer): Buffer {
	return value.length >= 32 ? value : Buffer.concat([Buffer.alloc(32 - value.length), value]);
}

export function generateVapidKeys(): VapidKeys {
	const ecdh = createECDH("prime256v1");
	ecdh.generateKeys();
	return {
		publicKey: ecdh.getPublicKey().toString("base64url"),
		privateKey: pad32(ecdh.getPrivateKey()).toString("base64url"),
	};
}

/** RFC 8291 aes128gcm body for one record. `salt` and `serverKeys` are only for tests; normally random. */
export function encryptPayload(
	plaintext: Buffer | string,
	keys: PushKeys,
	options: { salt?: Buffer; serverKeys?: { publicKey: Buffer; privateKey: Buffer }; recordSize?: number } = {},
): Buffer {
	const data = typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext;
	const uaPublic = decode(keys.p256dh);
	const authSecret = decode(keys.auth);
	if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) throw new Error("p256dh must be an uncompressed P-256 point");
	if (authSecret.length !== 16) throw new Error("auth must be 16 bytes");
	const recordSize = options.recordSize ?? DEFAULT_RECORD_SIZE;
	if (data.length + 1 + 16 > recordSize) {
		throw new Error(`push payload too large: ${data.length} bytes does not fit one ${recordSize}-byte record`);
	}
	const salt = options.salt ?? randomBytes(16);
	if (salt.length !== 16) throw new Error("salt must be 16 bytes");

	const ecdh = createECDH("prime256v1");
	if (options.serverKeys === undefined) ecdh.generateKeys();
	else ecdh.setPrivateKey(options.serverKeys.privateKey);
	const asPublic = ecdh.getPublicKey();
	const ecdhSecret = ecdh.computeSecret(uaPublic);

	const prkKey = hmac(authSecret, ecdhSecret);
	const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0", "latin1"), uaPublic, asPublic]);
	const ikm = hmac(prkKey, keyInfo, Buffer.from([1]));
	const prk = hmac(salt, ikm);
	const cek = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01", "latin1")).subarray(0, 16);
	const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01", "latin1")).subarray(0, 12);

	const cipher = createCipheriv("aes-128-gcm", cek, nonce);
	const padded = Buffer.concat([data, Buffer.from([2])]);
	const ciphertext = Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()]);

	const header = Buffer.alloc(16 + 4 + 1);
	salt.copy(header, 0);
	header.writeUInt32BE(recordSize, 16);
	header.writeUInt8(asPublic.length, 20);
	return Buffer.concat([header, asPublic, ciphertext]);
}

/** The Authorization header value `vapid t=<jwt>, k=<publicKey>` for an endpoint (ES256, raw r||s signature). */
export function vapidAuthorization(endpoint: string, vapid: VapidKeys, subject: string, now = Date.now()): string {
	const publicKey = decode(vapid.publicKey);
	if (publicKey.length !== 65 || publicKey[0] !== 0x04) {
		throw new Error("VAPID public key must be an uncompressed P-256 point");
	}
	const key = createPrivateKey({
		key: {
			kty: "EC",
			crv: "P-256",
			x: publicKey.subarray(1, 33).toString("base64url"),
			y: publicKey.subarray(33, 65).toString("base64url"),
			d: pad32(decode(vapid.privateKey)).toString("base64url"),
		},
		format: "jwk",
	});
	const header = Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })).toString("base64url");
	const claims = { aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 60 * 60, sub: subject };
	const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
	const signingInput = `${header}.${payload}`;
	const signature = sign("sha256", Buffer.from(signingInput), { key, dsaEncoding: "ieee-p1363" });
	return `vapid t=${signingInput}.${signature.toString("base64url")}, k=${publicKey.toString("base64url")}`;
}

/** A Topic header value (at most 32 base64url characters) for a tag; long or unusual tags are hashed. */
export function topicFor(tag: string): string {
	if (/^[A-Za-z0-9_-]{1,32}$/.test(tag)) return tag;
	return createHash("sha256").update(tag).digest("base64url").slice(0, 32);
}

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** POST an encrypted message to the push service. Resolves to the HTTP status. */
export async function sendPush(
	subscription: PushSubscriptionJson,
	message: PushMessage,
	vapid: VapidKeys,
	options: { subject?: string; ttl?: number; urgency?: Urgency; fetch?: typeof fetch } = {},
): Promise<number> {
	const payload: PushMessage = {
		title: clip(message.title, MAX_TITLE),
		body: clip(message.body, MAX_BODY),
		url: message.url,
	};
	if (message.tag !== undefined) payload.tag = message.tag;
	const body = encryptPayload(JSON.stringify(payload), subscription.keys);
	const headers: Record<string, string> = {
		"Content-Encoding": "aes128gcm",
		"Content-Type": "application/octet-stream",
		TTL: String(options.ttl ?? 24 * 60 * 60),
		Urgency: options.urgency ?? "normal",
		Authorization: vapidAuthorization(subscription.endpoint, vapid, options.subject ?? DEFAULT_SUBJECT),
	};
	if (message.tag !== undefined && message.tag !== "") headers.Topic = topicFor(message.tag);
	const doFetch = options.fetch ?? fetch;
	const response = await doFetch(subscription.endpoint, { method: "POST", headers, body: new Uint8Array(body) });
	await response.arrayBuffer().catch(() => undefined);
	return response.status;
}

/** Throw a clear Error unless the subscription looks like one a browser produced. */
export function validateSubscription(subscription: PushSubscriptionJson): PushSubscriptionJson {
	const value = subscription as Partial<PushSubscriptionJson> | null | undefined;
	if (value === null || typeof value !== "object") throw new Error("subscription must be an object");
	if (typeof value.endpoint !== "string") throw new Error("subscription endpoint is missing");
	let url: URL;
	try {
		url = new URL(value.endpoint);
	} catch {
		throw new Error("subscription endpoint is not a valid URL");
	}
	if (url.protocol !== "https:") throw new Error("subscription endpoint must be an https URL");
	const keys = value.keys;
	if (keys === null || typeof keys !== "object" || typeof keys.p256dh !== "string" || typeof keys.auth !== "string") {
		throw new Error("subscription keys.p256dh and keys.auth are required");
	}
	const p256dh = decode(keys.p256dh);
	if (p256dh.length !== 65 || p256dh[0] !== 0x04) {
		throw new Error("subscription keys.p256dh must be a 65-byte uncompressed P-256 public key");
	}
	if (decode(keys.auth).length !== 16) throw new Error("subscription keys.auth must be 16 bytes");
	return { endpoint: value.endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } };
}

interface PushFile {
	version: 1;
	vapid: VapidKeys;
	subscriptions: StoredSubscription[];
	prefs: Record<string, Partial<PushPrefs>>;
}

/** `push.json` in the data directory, written atomically with mode 0600. Creates VAPID keys on first use. */
export class PushStore {
	readonly file: string;
	#data: PushFile;

	constructor(directory: string) {
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		this.file = join(directory, "push.json");
		if (existsSync(this.file)) {
			const loaded = JSON.parse(readFileSync(this.file, "utf8")) as Partial<PushFile>;
			this.#data = {
				version: 1,
				vapid: loaded.vapid ?? generateVapidKeys(),
				subscriptions: loaded.subscriptions ?? [],
				prefs: loaded.prefs ?? {},
			};
			if (loaded.vapid === undefined) this.save();
		} else {
			this.#data = { version: 1, vapid: generateVapidKeys(), subscriptions: [], prefs: {} };
			this.save();
		}
	}

	get publicKey(): string {
		return this.#data.vapid.publicKey;
	}

	get vapid(): VapidKeys {
		return { ...this.#data.vapid };
	}

	subscriptions(userId?: string): StoredSubscription[] {
		return this.#data.subscriptions.filter((sub) => userId === undefined || sub.userId === userId).map((sub) => ({ ...sub }));
	}

	/** Add a browser subscription; one with the same endpoint is replaced (it may move to another user). */
	subscribe(userId: string, subscription: PushSubscriptionJson, userAgent?: string): void {
		const clean = validateSubscription(subscription);
		const stored: StoredSubscription = { ...clean, userId, createdAt: Date.now() };
		if (userAgent !== undefined && userAgent !== "") stored.userAgent = userAgent.slice(0, 300);
		this.#data.subscriptions = this.#data.subscriptions.filter((sub) => sub.endpoint !== clean.endpoint);
		this.#data.subscriptions.push(stored);
		this.save();
	}

	/** Remove a subscription; when `userId` is given, only if it belongs to them. */
	unsubscribe(endpoint: string, userId?: string): boolean {
		const before = this.#data.subscriptions.length;
		this.#data.subscriptions = this.#data.subscriptions.filter(
			(sub) => sub.endpoint !== endpoint || (userId !== undefined && sub.userId !== userId),
		);
		if (this.#data.subscriptions.length === before) return false;
		this.save();
		return true;
	}

	removeUser(userId: string): void {
		this.#data.subscriptions = this.#data.subscriptions.filter((sub) => sub.userId !== userId);
		delete this.#data.prefs[userId];
		this.save();
	}

	prefs(userId: string): PushPrefs {
		return { ...DEFAULT_PREFS, ...this.#data.prefs[userId] };
	}

	setPrefs(userId: string, patch: Partial<PushPrefs>): PushPrefs {
		const stored = { ...this.#data.prefs[userId] };
		for (const name of Object.keys(DEFAULT_PREFS) as (keyof PushPrefs)[]) {
			const value = patch[name];
			if (typeof value === "boolean") stored[name] = value;
		}
		this.#data.prefs[userId] = stored;
		this.save();
		return this.prefs(userId);
	}

	/** Send to every subscription of the user; drops ones the service reports gone. Never throws; returns 2xx count. */
	async notify(
		userId: string,
		message: PushMessage,
		options: { urgency?: Urgency; fetch?: typeof fetch; subject?: string } = {},
	): Promise<number> {
		const targets = this.subscriptions(userId);
		if (targets.length === 0) return 0;
		const vapid = this.vapid;
		const results = await Promise.allSettled(
			targets.map((sub) =>
				sendPush(sub, message, vapid, { urgency: options.urgency, fetch: options.fetch, subject: options.subject }),
			),
		);
		let accepted = 0;
		const gone = new Set<string>();
		results.forEach((result, index) => {
			if (result.status !== "fulfilled") return;
			if (result.value >= 200 && result.value < 300) accepted++;
			else if (result.value === 404 || result.value === 410) gone.add(targets[index]?.endpoint ?? "");
		});
		if (gone.size > 0) {
			try {
				this.#data.subscriptions = this.#data.subscriptions.filter((sub) => !(sub.userId === userId && gone.has(sub.endpoint)));
				this.save();
			} catch {
				// Saving failed (disk full, permissions); the stale subscription is retried and dropped next time.
			}
		}
		return accepted;
	}

	save(): void {
		mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
		const temp = `${this.file}.${process.pid}.tmp`;
		writeFileSync(temp, `${JSON.stringify(this.#data, null, "\t")}\n`, { mode: 0o600 });
		renameSync(temp, this.file);
		chmodSync(this.file, 0o600);
	}
}
