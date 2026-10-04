import { randomUUID } from "node:crypto";
import { closeSync, createReadStream, createWriteStream, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir, networkInterfaces } from "node:os";
import { basename, dirname, extname, join, normalize, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import type { ConversationId } from "@earendil-works/pi-durable";
import { marked } from "marked";
import QRCode from "qrcode";
import { type Attachment, type Client, HttpError, type PocketApp, type SubmitRequest } from "./app.ts";
import { Auth, clearAuthCookie, type InviteGrant, origin, setAuthCookie } from "./auth.ts";
import { APP_ROOT, type User } from "./config.ts";

const WEB = join(APP_ROOT, "web");
const MODULES = join(APP_ROOT, "node_modules");
const MAX_JSON = 1_000_000;
const MAX_UPLOAD = 50 * 1024 * 1024;

const VENDOR: Record<string, string> = {
	"preact.mjs": join(MODULES, "preact", "dist", "preact.mjs"),
	"preact-hooks.mjs": join(MODULES, "preact", "hooks", "dist", "hooks.mjs"),
	"htm.mjs": join(MODULES, "htm", "dist", "htm.module.js"),
	"marked.mjs": join(MODULES, "marked", "lib", "marked.esm.js"),
	"purify.mjs": join(MODULES, "dompurify", "dist", "purify.es.mjs"),
};

const TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".json": "application/json",
	".webmanifest": "application/manifest+json",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".woff2": "font/woff2",
	".pdf": "application/pdf",
	".txt": "text/plain; charset=utf-8",
	".md": "text/markdown; charset=utf-8",
};

/** File types the image route shows; the bytes must match too (see `sniffImage`). */
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp", ".ico", ".svg"]);
const MAX_IMAGE_FILE = 25 * 1024 * 1024;
/** Opened on its own, an SVG could run script: give it an opaque origin and nothing to load. */
const IMAGE_CSP = "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:";

/** The image type of a file's first bytes, or undefined when it is not an image this app shows. */
export function sniffImage(head: Buffer): string | undefined {
	const ascii = (start: number, text: string) => head.subarray(start, start + text.length).toString("latin1") === text;
	if (head[0] === 0x89 && ascii(1, "PNG\r\n\x1a\n")) return "image/png";
	if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
	if (ascii(0, "GIF87a") || ascii(0, "GIF89a")) return "image/gif";
	if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";
	if (ascii(4, "ftypavif") || ascii(4, "ftypavis")) return "image/avif";
	if (ascii(0, "BM")) return "image/bmp";
	if (head[0] === 0 && head[1] === 0 && head[2] === 1 && head[3] === 0) return "image/x-icon";
	const text = head.toString("utf8").replace(/^\uFEFF/, "").trimStart();
	if (text.startsWith("<") && /<svg[\s>]/i.test(text)) return "image/svg+xml";
	return undefined;
}

const ENTRY_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp"]);

/** Artifacts get an opaque origin even when opened in their own tab: no cookies, no access to the app. */
const ARTIFACT_CSP =
	"sandbox allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-pointer-lock allow-downloads; frame-ancestors 'self'";

/** How long a poll waits for events before answering empty, and how long an unpolled session lives. */
const POLL_HOLD_MS = 25_000;
const POLL_EXPIRE_MS = 60_000;

/** One browser tab that receives events by long polling instead of an event stream. */
interface Poller {
	id: string;
	userId: string;
	client: Client;
	queue: { seq: number; event: string; data: unknown }[];
	seq: number;
	waiting: ServerResponse | undefined;
	timer: NodeJS.Timeout | undefined;
	expiry: NodeJS.Timeout | undefined;
}

export interface HttpOptions {
	app: PocketApp;
	/** Where the server listens, to offer reachable invite links when the browser uses a loopback address. */
	listen: { host: string; port: number };
	/** Restart the process (exit code 75 under the launcher). */
	restart(): void;
}

function send(response: ServerResponse, status: number, body: string | Buffer, type = "text/plain; charset=utf-8", headers: Record<string, string> = {}): void {
	response.writeHead(status, { "content-type": type, "cache-control": "no-store", ...headers });
	response.end(body);
}

function json(response: ServerResponse, status: number, value: unknown): void {
	send(response, status, JSON.stringify(value), "application/json");
}

async function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		size += (chunk as Buffer).length;
		if (size > limit) throw new HttpError(413, "Request too large");
		chunks.push(chunk as Buffer);
	}
	return Buffer.concat(chunks);
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
	const body = await readBody(request, MAX_JSON);
	if (body.length === 0) return {} as T;
	try {
		return JSON.parse(body.toString("utf8")) as T;
	} catch {
		throw new HttpError(400, "Invalid JSON");
	}
}

function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function page(title: string, body: string): string {
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="dark"><title>${escapeHtml(title)}</title><link rel="stylesheet" href="/style.css"></head><body class="plain-page"><main class="plain">${body}</main></body></html>`;
}

function conversationId(value: string | undefined): ConversationId {
	const id = Number(value);
	if (!Number.isInteger(id) || id < 0) throw new HttpError(400, "Bad conversation id");
	return id as unknown as ConversationId;
}

function lanAddresses(): string[] {
	return Object.values(networkInterfaces())
		.flat()
		.filter((net) => net !== undefined && net.family === "IPv4" && !net.internal)
		.map((net) => net!.address);
}

function safeName(name: string): string {
	const base = basename(name).replace(/[^\w.\- ()]+/g, "_").trim();
	return base === "" || base.startsWith(".") ? `upload${base}` : base.slice(0, 120);
}

export function createHandler(options: HttpOptions) {
	const { app } = options;
	const auth = new Auth(app.config);

	const serveFile = (response: ServerResponse, file: string, fallbackType?: string): void => {
		let body: Buffer;
		try {
			body = readFileSync(file);
		} catch {
			send(response, 404, "Not found");
			return;
		}
		// No caching: the app is edited live, and a reload should always get the newest files.
		send(response, 200, body, fallbackType ?? TYPES[extname(file).toLowerCase()] ?? "application/octet-stream", {
			"cache-control": "no-cache",
		});
	};

	/** An image file from this machine, for `![alt](path)` in replies and for uploaded attachments. */
	const serveImage = (request: IncomingMessage, response: ServerResponse, file: string): void => {
		if (!IMAGE_EXTENSIONS.has(extname(file).toLowerCase())) throw new HttpError(415, "Only image files can be shown");
		let size: number;
		let mtime: number;
		let type: string | undefined;
		try {
			const stats = statSync(file);
			if (!stats.isFile()) throw new Error("not a file");
			size = stats.size;
			mtime = stats.mtimeMs;
			const head = Buffer.alloc(1024);
			const fd = openSync(file, "r");
			try {
				type = sniffImage(head.subarray(0, readSync(fd, head, 0, head.length, 0)));
			} finally {
				closeSync(fd);
			}
		} catch {
			throw new HttpError(404, "Image not found");
		}
		if (type === undefined) throw new HttpError(415, "That file is not an image");
		if (size > MAX_IMAGE_FILE) throw new HttpError(413, "Image too large to show");
		const etag = `"${size.toString(36)}-${Math.floor(mtime).toString(36)}"`;
		const headers = { etag, "cache-control": "private, no-cache", "content-security-policy": IMAGE_CSP };
		if (request.headers["if-none-match"] === etag) {
			response.writeHead(304, headers);
			response.end();
			return;
		}
		response.writeHead(200, { ...headers, "content-type": type, "content-length": String(size) });
		createReadStream(file)
			.on("error", () => response.destroy())
			.pipe(response);
	};

	const requireUser = (request: IncomingMessage): User => {
		const user = auth.user(request);
		if (user === undefined) throw new HttpError(401, "Sign in first");
		return user;
	};

	const requireOwner = (user: User): void => {
		if (user.role !== "owner") throw new HttpError(403, "Only the owner can do that");
	};

	const newClient = (url: URL, user: User, send: Client["send"]): Client => {
		const raw = url.searchParams.get("c");
		return {
			id: (url.searchParams.get("tab") ?? randomUUID()).slice(0, 64),
			user,
			conversationId: raw === null || raw === "" ? undefined : conversationId(raw),
			sentEntries: new Set(),
			orderKey: "",
			send,
		};
	};

	const events = async (request: IncomingMessage, response: ServerResponse, url: URL, user: User): Promise<void> => {
		const client = newClient(url, user, (event, data) => {
			if (!response.writableEnded) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
		});
		client.close = () => response.end();
		response.writeHead(200, {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-cache, no-transform",
			connection: "keep-alive",
			"x-accel-buffering": "no",
		});
		response.write("retry: 1500\n\n");
		const ping = setInterval(() => response.write(": ping\n\n"), 15_000);
		request.on("close", () => {
			clearInterval(ping);
			app.detach(client);
		});
		await app.attach(client);
	};

	// ─── Long polling: the same events as /api/events, for connections that hold back event streams (Cloudflare
	// quick tunnels do). Each answer carries every event after the client's `ack`, so a lost answer is sent again.
	const pollers = new Map<string, Poller>();

	const answerPoll = (poller: Poller): void => {
		clearTimeout(poller.timer);
		poller.timer = undefined;
		const response = poller.waiting;
		poller.waiting = undefined;
		if (response !== undefined && !response.writableEnded) json(response, 200, { session: poller.id, events: poller.queue });
	};

	const closePoller = (poller: Poller): void => {
		clearTimeout(poller.expiry);
		if (!pollers.delete(poller.id)) return;
		answerPoll(poller);
		app.detach(poller.client);
	};

	const keepPoller = (poller: Poller): void => {
		clearTimeout(poller.expiry);
		poller.expiry = setTimeout(() => (poller.waiting === undefined ? closePoller(poller) : keepPoller(poller)), POLL_EXPIRE_MS);
		poller.expiry.unref();
	};

	const poll = async (request: IncomingMessage, response: ServerResponse, url: URL, user: User): Promise<void> => {
		let poller = pollers.get(url.searchParams.get("session") ?? "");
		if (poller !== undefined && poller.userId !== user.id) poller = undefined;
		if (url.searchParams.get("close") === "1") {
			if (poller !== undefined) closePoller(poller);
			return json(response, 200, { ok: true });
		}
		if (poller === undefined) {
			// A new tab, or one whose session ended (the server restarted): attach afresh, which sends hello and a full view.
			const created: Poller = { id: randomUUID(), userId: user.id, client: undefined as unknown as Client, queue: [], seq: 0, waiting: undefined, timer: undefined, expiry: undefined };
			created.client = newClient(url, user, (event, data) => {
				created.queue.push({ seq: ++created.seq, event, data });
				// A short pause lets a burst of events go out in one answer.
				if (created.waiting !== undefined) {
					clearTimeout(created.timer);
					created.timer = setTimeout(() => answerPoll(created), 30);
				}
			});
			created.client.close = () => closePoller(created);
			pollers.set(created.id, created);
			keepPoller(created);
			await app.attach(created.client);
			poller = created;
		} else {
			const ack = Number(url.searchParams.get("ack") ?? 0);
			poller.queue = poller.queue.filter((item) => item.seq > ack);
			keepPoller(poller);
		}
		const current = poller;
		// One waiting request per tab: an older one answers now.
		if (current.waiting !== undefined) answerPoll(current);
		current.waiting = response;
		current.timer = setTimeout(() => answerPoll(current), current.queue.length > 0 ? 30 : POLL_HOLD_MS);
		// Closes when answered, or when the browser gives up on this request.
		response.on("close", () => {
			if (current.waiting !== response) return;
			clearTimeout(current.timer);
			current.waiting = undefined;
		});
	};

	/** What an invite may grant: viewers and people invited to one session cannot invite anyone. */
	const inviteGrant = (user: User, body: { role?: unknown; session?: unknown }): InviteGrant => {
		if (user.role === "viewer" || user.sessions !== undefined) throw new HttpError(403, "Only people with access to every session can invite others.");
		const role = body.role === "viewer" ? "viewer" : "guest";
		if (body.session === undefined || body.session === null) return { role };
		const session = conversationId(String(body.session));
		if (!app.sessions(user).some((each) => each.id === Number(session))) throw new HttpError(400, "No such session");
		return { role, session: String(session) };
	};

	/** Phone notifications: this device's subscription, what to notify about, and a test. */
	const pushRoute = async (request: IncomingMessage, response: ServerResponse, user: User, action: string | undefined): Promise<void> => {
		const store = app.pushStore;
		if (store === undefined) throw new HttpError(503, "Push notifications are not available on this server.");
		const method = request.method ?? "GET";
		if (action === undefined && method === "GET") {
			return json(response, 200, { publicKey: store.publicKey, prefs: store.prefs(user.id), devices: store.subscriptions(user.id).length });
		}
		if (method !== "POST") throw new HttpError(404, "Unknown push route");
		if (action === "subscribe") {
			const body = await readJson<{ subscription?: { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } }>(request);
			const sub = body.subscription;
			try {
				store.subscribe(
					user.id,
					{ endpoint: String(sub?.endpoint ?? ""), keys: { p256dh: String(sub?.keys?.p256dh ?? ""), auth: String(sub?.keys?.auth ?? "") } },
					String(request.headers["user-agent"] ?? "").slice(0, 200),
				);
			} catch (error) {
				throw new HttpError(400, error instanceof Error ? error.message : String(error));
			}
			return json(response, 200, { ok: true, devices: store.subscriptions(user.id).length });
		}
		if (action === "unsubscribe") {
			const body = await readJson<{ endpoint?: unknown }>(request);
			store.unsubscribe(String(body.endpoint ?? ""), user.id);
			return json(response, 200, { ok: true, devices: store.subscriptions(user.id).length });
		}
		if (action === "prefs") {
			const body = await readJson<Record<string, unknown>>(request);
			const patch: Record<string, boolean> = {};
			for (const key of ["done", "approval", "chat", "mention"]) if (typeof body[key] === "boolean") patch[key] = body[key] as boolean;
			return json(response, 200, { prefs: store.setPrefs(user.id, patch) });
		}
		if (action === "test") {
			const sent = await store.notify(user.id, { title: "Pi Pocket", body: `Notifications work on this device, ${user.name}.`, url: "/", tag: "test" });
			if (sent === 0) throw new HttpError(409, "No device took the test notification. Turn notifications on again on this device.");
			return json(response, 200, { sent });
		}
		throw new HttpError(404, "Unknown push route");
	};

	const api = async (request: IncomingMessage, response: ServerResponse, url: URL, parts: string[]): Promise<void> => {
		const method = request.method ?? "GET";
		const user = requireUser(request);
		if (method !== "GET" && request.headers["x-pocket"] !== "1") throw new HttpError(403, "Missing X-Pocket header");
		const [first, second, third, fourth] = parts;

		if (first === "events" && method === "GET") return events(request, response, url, user);
		if (first === "poll" && method === "GET") return poll(request, response, url, user);
		if (first === "me" && method === "GET") return json(response, 200, await app.hello(user));
		if (first === "me" && method === "POST") {
			const body = await readJson<{ name?: string }>(request);
			const name = String(body.name ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
			if (name === "") throw new HttpError(400, "Name is empty");
			app.rename(user, name);
			return json(response, 200, { ok: true });
		}
		if (first === "logout" && method === "POST") {
			clearAuthCookie(response);
			return json(response, 200, { ok: true });
		}
		if (first === "users" && second === undefined && method === "GET") return json(response, 200, app.people());
		if (first === "users" && second !== undefined && third === "remove" && method === "POST") {
			app.removeUser(user, second);
			return json(response, 200, { ok: true });
		}
		if (first === "users" && second !== undefined && third === undefined && method === "POST") {
			app.setAccess(user, second, await readJson(request));
			return json(response, 200, app.people());
		}
		if (first === "visibility" && method === "POST") {
			const body = await readJson<{ tab?: unknown; visible?: unknown }>(request);
			app.setVisible(user, String(body.tab ?? ""), body.visible !== false);
			return json(response, 200, { ok: true });
		}
		if (first === "push") return pushRoute(request, response, user, second);
		if (first === "sessions" && second === undefined && method === "GET") return json(response, 200, app.sessions(user));
		if (first === "sessions" && second === undefined && method === "POST") {
			const body = await readJson<{ cwd?: string; title?: string }>(request);
			return json(response, 200, await app.createSession(user, body));
		}
		if (first === "sessions" && second !== undefined && method === "POST") {
			const body = await readJson<{ title?: string; archived?: boolean }>(request);
			await app.updateSession(conversationId(second), user, body);
			return json(response, 200, { ok: true });
		}
		if (first === "c" && second !== undefined) {
			const id = conversationId(second);
			app.requireSee(user, id);
			if (third === "submit" && method === "POST") {
				const body = await readJson<SubmitRequest>(request);
				if (typeof body.text !== "string" || typeof body.requestId !== "string") throw new HttpError(400, "text and requestId are required");
				const attachments = (body.attachments ?? []).filter((file): file is Attachment => {
					// Only files this server stored for this conversation.
					return typeof file?.path === "string" && resolve(file.path).startsWith(app.uploadDirectory(id) + sep);
				});
				return json(response, 200, await app.submit(id, user, { ...body, attachments }));
			}
			if (third === "chat" && method === "POST") {
				const body = await readJson<{ text?: unknown; requestId?: unknown; quote?: { entryId?: unknown } }>(request);
				if (typeof body.text !== "string" || typeof body.requestId !== "string") throw new HttpError(400, "text and requestId are required");
				const quote = typeof body.quote === "object" && body.quote !== null ? { entryId: body.quote.entryId } : undefined;
				return json(response, 200, await app.postChat(id, user, { text: body.text, requestId: body.requestId, ...(quote === undefined ? {} : { quote }) }));
			}
			if (third === "react" && method === "POST") {
				const body = await readJson<{ entryId?: unknown; emoji?: unknown }>(request);
				await app.react(id, user, Number(body.entryId), String(body.emoji ?? ""));
				return json(response, 200, { ok: true });
			}
			if (third === "pin" && method === "POST") {
				return json(response, 200, await app.pin(id, user, await readJson(request)));
			}
			if (third === "notes" && method === "POST") {
				const body = await readJson<{ text?: unknown; rev?: unknown }>(request);
				if (typeof body.text !== "string" || typeof body.rev !== "number") throw new HttpError(400, "text and rev are required");
				return json(response, 200, await app.saveNotes(id, user, body.text, body.rev));
			}
			if (third === "turns" && method === "POST") {
				await app.turns(id, user, await readJson(request));
				return json(response, 200, { ok: true });
			}
			if (third === "typing" && method === "POST") {
				const body = await readJson<{ where?: unknown }>(request);
				app.setTyping(id, user, body.where);
				return json(response, 200, { ok: true });
			}
			if (third === "abort" && method === "POST") {
				await app.abort(id, user);
				return json(response, 200, { ok: true });
			}
			if (third === "withdraw" && method === "POST") {
				const body = await readJson<{ submissionId?: number }>(request);
				return json(response, 200, { result: await app.withdraw(id, user, Number(body.submissionId)) });
			}
			if (third === "configure" && method === "POST") {
				await app.configure(id, user, await readJson(request));
				return json(response, 200, { ok: true });
			}
			if (third === "compact" && method === "POST") {
				const body = await readJson<{ instructions?: string }>(request);
				await app.compact(id, user, body.instructions?.trim() || undefined);
				return json(response, 200, { ok: true });
			}
			if (third === "image" && fourth !== undefined && method === "GET") {
				const image = await app.entryImage(id, Number(fourth), Number(parts[4] ?? 0));
				if (image === undefined || !ENTRY_IMAGE_TYPES.has(image.mimeType)) throw new HttpError(404, "No such image");
				// Stored entries never change.
				return send(response, 200, image.data, image.mimeType, { "cache-control": "private, max-age=31536000, immutable" });
			}
			if (third === "file" && method === "GET") {
				const requested = url.searchParams.get("path") ?? "";
				if (requested.trim() === "") throw new HttpError(400, "path is required");
				return serveImage(request, response, app.conversationFile(user, id, requested));
			}
			if (third === "entry" && fourth !== undefined && method === "GET") {
				const entry = await app.fullEntry(id, Number(fourth));
				if (entry === undefined) throw new HttpError(404, "No such entry");
				return json(response, 200, entry);
			}
			if (third === "history" && method === "GET") {
				return json(response, 200, await app.history(id, Number(url.searchParams.get("before") ?? Number.MAX_SAFE_INTEGER)));
			}
			if (third === "upload" && method === "POST") {
				app.requireSteer(user);
				const name = safeName(url.searchParams.get("name") ?? "upload");
				const directory = app.uploadDirectory(id);
				const file = join(directory, `${Date.now().toString(36)}-${name}`);
				let size = 0;
				request.on("data", (chunk: Buffer) => {
					size += chunk.length;
					if (size > MAX_UPLOAD) request.destroy(new Error("too large"));
				});
				await pipeline(request, createWriteStream(file, { mode: 0o600 }));
				const mime = String(request.headers["content-type"] ?? "") || TYPES[extname(name).toLowerCase()] || "application/octet-stream";
				const attachment: Attachment = { path: file, name, mime: mime.split(";")[0]!.trim(), size };
				return json(response, 200, attachment);
			}
		}
		if (first === "approvals" && second !== undefined && method === "POST") {
			const body = await readJson<{ allow?: boolean }>(request);
			if (!(await app.answerApproval(second, body.allow === true, user))) throw new HttpError(404, "That approval is no longer pending");
			return json(response, 200, { ok: true });
		}
		if (first === "fs" && method === "GET") {
			app.requireSteer(user);
			if (user.sessions !== undefined) throw new HttpError(403, "You were invited to one session.");
			const requested = url.searchParams.get("path") || "~";
			const path = app.checkDirectory(requested);
			const showHidden = url.searchParams.get("hidden") === "1";
			const dirs: { name: string; path: string }[] = [];
			for (const entry of readdirSync(path, { withFileTypes: true })) {
				if (!showHidden && entry.name.startsWith(".")) continue;
				let isDir = entry.isDirectory();
				if (entry.isSymbolicLink()) {
					try {
						isDir = statSync(join(path, entry.name)).isDirectory();
					} catch {
						isDir = false;
					}
				}
				if (isDir) dirs.push({ name: entry.name, path: join(path, entry.name) });
			}
			dirs.sort((a, b) => a.name.localeCompare(b.name));
			const recent = [...new Set(app.sessions(user).map((session) => session.cwd))].slice(0, 8);
			return json(response, 200, { path, parent: dirname(path) === path ? null : dirname(path), home: homedir(), dirs: dirs.slice(0, 1000), recent });
		}
		if (first === "extensions" && second === undefined && method === "GET") return json(response, 200, await app.extensions());
		if (first === "extensions" && second !== undefined && third === undefined && method === "POST") {
			requireOwner(user);
			const body = await readJson<{ enabled?: unknown }>(request);
			if (typeof body.enabled !== "boolean") throw new HttpError(400, "enabled must be true or false");
			await app.setExtensionEnabled(user, second, body.enabled);
			return json(response, 200, await app.extensions());
		}
		if (first === "extensions" && second !== undefined && third === "reload" && method === "POST") {
			requireOwner(user);
			await app.reloadExtension(second);
			return json(response, 200, await app.extensions());
		}
		if (first === "providers" && second === undefined && method === "GET") return json(response, 200, app.providers());
		if (first === "providers" && second !== undefined && third === "login" && method === "POST") {
			requireOwner(user);
			const body = await readJson<{ type?: string }>(request);
			return json(response, 200, { flowId: app.startLogin(user, second, body.type === "oauth" ? "oauth" : "api_key") });
		}
		if (first === "providers" && second !== undefined && third === "logout" && method === "POST") {
			requireOwner(user);
			await app.logout(second);
			return json(response, 200, { ok: true });
		}
		if (first === "auth" && second !== undefined && third !== undefined && method === "POST") {
			const body = await readJson<{ value?: string; cancel?: boolean }>(request);
			app.answerLogin(user, second, third, body.cancel === true ? undefined : String(body.value ?? ""));
			return json(response, 200, { ok: true });
		}
		if (first === "invite" && method === "POST") {
			const grant = inviteGrant(user, await readJson(request));
			const invite = auth.createInvite(user, grant);
			const here = origin(request);
			const loopback = /^https?:\/\/(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?$/.test(here);
			const wildcard = options.listen.host === "0.0.0.0" || options.listen.host === "::";
			const lan = loopback && wildcard ? lanAddresses().map((address) => `http://${address}:${options.listen.port}`) : [];
			// A tunnel the launcher started is the way in for other devices.
			const tunnel = loopback ? app.access?.url : undefined;
			const base = tunnel ?? lan[0] ?? here;
			const link = `${base}/join/${invite.code}`;
			const svg = await QRCode.toString(link, { type: "svg", margin: 1, color: { dark: "#000000", light: "#ffffff" } });
			return json(response, 200, {
				...invite,
				grant,
				url: link,
				svg,
				alternatives: (tunnel === undefined ? lan.slice(1) : lan).map((address) => `${address}/join/${invite.code}`),
				// Only this device can open a loopback link.
				local: loopback && lan.length === 0 && tunnel === undefined,
				...(app.access === undefined ? {} : { access: app.access }),
			});
		}
		if (first === "restart" && method === "POST") {
			requireOwner(user);
			if (!app.supervised) throw new HttpError(409, "Start Pi Pocket with bin/pi-pocket.js to restart from the app.");
			json(response, 200, { ok: true });
			setTimeout(() => options.restart(), 100);
			return;
		}
		throw new HttpError(404, "Unknown API route");
	};

	const artifact = async (response: ServerResponse, parts: string[], user: User | undefined): Promise<void> => {
		if (user === undefined) throw new HttpError(401, "Sign in first");
		const [conv, id, version] = parts;
		if (id === undefined) throw new HttpError(404, "No artifact");
		app.requireSee(user, conversationId(conv));
		const found = await app.artifactBody(conversationId(conv), id, version === undefined || version === "latest" ? undefined : Number(version));
		const headers = { "content-security-policy": ARTIFACT_CSP, "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };
		if (found.meta.type === "svg") return send(response, 200, found.content, "image/svg+xml", headers);
		if (found.meta.type === "markdown") {
			const rendered = await marked.parse(found.content);
			const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(found.meta.title)}</title><style>body{font:16px/1.6 system-ui,sans-serif;max-width:46rem;margin:0 auto;padding:1.2rem;color:#a9b1d6;background:#13141c}h1,h2,h3,strong{color:#c0caf5}a{color:#7aa2f7}pre{background:#0e0e14;border:1px solid #292e42;padding:.8rem;overflow:auto}code{font-family:ui-monospace,monospace;color:#c0caf5}table{border-collapse:collapse}td,th{border:1px solid #292e42;padding:.3rem .5rem}blockquote{border-left:2px solid #3b4261;margin-left:0;padding-left:.8rem;color:#7a82ad}img{max-width:100%}</style></head><body>${rendered}</body></html>`;
			return send(response, 200, html, "text/html; charset=utf-8", headers);
		}
		return send(response, 200, found.content, "text/html; charset=utf-8", headers);
	};

	return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
		const url = new URL(request.url ?? "/", "http://pocket.local");
		try {
			let path: string;
			try {
				path = decodeURIComponent(url.pathname);
			} catch {
				throw new HttpError(400, "Bad path");
			}
			const parts = path.split("/").filter((part) => part !== "");
			response.setHeader("x-content-type-options", "nosniff");
			if (parts[0] === "api") return await api(request, response, url, parts.slice(1));
			if (parts[0] === "a") return await artifact(response, parts.slice(1), auth.user(request));
			if (parts[0] === "vendor" && parts[1] !== undefined && VENDOR[parts[1]] !== undefined) {
				return serveFile(response, VENDOR[parts[1]]!, "text/javascript; charset=utf-8");
			}
			if (parts[0] === "login" && request.method === "GET") {
				const token = url.searchParams.get("token") ?? "";
				if (auth.tokenUser(token) === undefined) {
					return send(response, 401, page("Pi Pocket", `<h1>Link expired</h1><p>That login link is not valid. Use the link Pi Pocket prints when it starts, or ask someone signed in for a new invite.</p>`), "text/html; charset=utf-8");
				}
				setAuthCookie(request, response, token);
				response.writeHead(303, { location: url.searchParams.get("next")?.startsWith("/") ? url.searchParams.get("next")! : "/" });
				response.end();
				return;
			}
			if (parts[0] === "join" && parts[1] !== undefined) {
				const code = parts[1];
				if (request.method === "POST") {
					const form = new URLSearchParams((await readBody(request, 10_000)).toString("utf8"));
					const redeemed = auth.redeem(code, form.get("name") ?? "");
					if (redeemed === undefined) {
						return send(response, 410, page("Pi Pocket", "<h1>Invite expired</h1><p>Ask for a new one.</p>"), "text/html; charset=utf-8");
					}
					setAuthCookie(request, response, redeemed.token);
					response.writeHead(303, { location: "/" });
					response.end();
					return;
				}
				const grant = auth.invite(code);
				if (grant === undefined) {
					return send(response, 410, page("Pi Pocket", "<h1>Invite expired</h1><p>Invites last 15 minutes and work once. Ask for a new one.</p>"), "text/html; charset=utf-8");
				}
				const where = grant.session === undefined ? "every session on this server" : `the session “${escapeHtml(await app.conversationTitle(conversationId(grant.session)))}”`;
				const can =
					grant.role === "viewer"
						? `read ${where} and chat with the people there, but not steer Pi`
						: `read and steer ${where}. Pi can run commands on this machine`;
				return send(
					response,
					200,
					page(
						"Join Pi Pocket",
						`<h1>Join Pi Pocket</h1><p>This device will be able to ${can}.</p><form method="post"><label>Your name<input name="name" maxlength="40" autofocus required placeholder="e.g. Alex"></label><button type="submit">Join</button></form>`,
					),
					"text/html; charset=utf-8",
				);
			}
			// The web app: index.html for app routes, files from web/ otherwise.
			if (parts.length === 0 || parts[0] === "s") return serveFile(response, join(WEB, "index.html"));
			const file = normalize(join(WEB, ...parts));
			if (!file.startsWith(WEB + sep)) throw new HttpError(404, "Not found");
			return serveFile(response, file);
		} catch (error) {
			const status = error instanceof HttpError ? error.status : 500;
			if (status === 500) console.error(error);
			if (response.headersSent) {
				response.end();
				return;
			}
			json(response, status, { error: error instanceof Error ? error.message : String(error) });
		}
	};
}
