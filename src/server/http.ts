import { createHash, randomUUID } from "node:crypto";
import { closeSync, createReadStream, createWriteStream, openSync, readdirSync, readFileSync, readSync, rmSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir, networkInterfaces } from "node:os";
import { basename, dirname, extname, join, normalize, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import type { ConversationId } from "@earendil-works/pi-durable";
import { marked } from "marked";
import QRCode from "qrcode";
import type { PocketApp } from "./app.ts";
import { Auth, COOKIE, clearAuthCookie, type InviteGrant, origin, parseCookies, quickTunnelHost, setAuthCookie } from "./auth.ts";
import type { Attachment, SubmitRequest } from "./commands.ts";
import { APP_ROOT, type User } from "./config.ts";
import { HttpError } from "./errors.ts";
import { desktopTheme, wallpaperFile } from "./omarchy.ts";
import type { Client } from "./room.ts";
import { runningNow } from "./running.ts";

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

/**
 * The app page's policy. Replies show markdown that Pi wrote, and what Pi writes can be steered by any file or page it
 * reads: nothing on the page may load from, send to, or post to another site. The inline import map is allowed by hash.
 */
export function appPolicy(html: string): string {
	// Browsers hash script text after turning CRLF and CR into LF, as their HTML parser does.
	const hashes = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(
		(match) => `'sha256-${createHash("sha256").update(match[1]!.replace(/\r\n?/g, "\n")).digest("base64")}'`,
	);
	return [
		"default-src 'self'",
		["script-src 'self'", ...hashes].join(" "),
		"style-src 'self' 'unsafe-inline'",
		"img-src 'self' data: blob:",
		"media-src 'self' data: blob:",
		"connect-src 'self'",
		"frame-src 'self'",
		"worker-src 'self'",
		"object-src 'none'",
		"base-uri 'none'",
		"form-action 'self'",
		"frame-ancestors 'self'",
	].join("; ");
}

/** A form posted from another site, as browsers report it. Such a post must not sign this browser in or out. */
function crossSite(request: IncomingMessage): boolean {
	const site = request.headers["sec-fetch-site"];
	return site !== undefined && site !== "same-origin" && site !== "none";
}

/** Where to go after signing in: a path on this server, never `//host` or `/\host`, which browsers read as another site. */
function localPath(next: string | null): string {
	return next !== null && /^\/(?![/\\])/.test(next) ? next : "/";
}

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

/** How long a JSON or form body may take to arrive: a client that stops sending must not hold the connection. */
const BODY_TIMEOUT_MS = 60_000;

async function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
	if (Number(request.headers["content-length"] ?? 0) > limit) throw new HttpError(413, "Request too large");
	const timer = setTimeout(() => request.destroy(new HttpError(408, "The request body took too long")), BODY_TIMEOUT_MS);
	try {
		const chunks: Buffer[] = [];
		let size = 0;
		for await (const chunk of request) {
			size += (chunk as Buffer).length;
			if (size > limit) throw new HttpError(413, "Request too large");
			chunks.push(chunk as Buffer);
		}
		return Buffer.concat(chunks);
	} finally {
		clearTimeout(timer);
	}
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

	/** The app page, with its content security policy. */
	const serveApp = (response: ServerResponse): void => {
		let body: string;
		try {
			body = readFileSync(join(WEB, "index.html"), "utf8");
		} catch {
			send(response, 404, "Not found");
			return;
		}
		send(response, 200, body, "text/html; charset=utf-8", { "cache-control": "no-cache", "content-security-policy": appPolicy(body) });
	};

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

	/** A guest signed in by a cookie set on a Cloudflare quick tunnel can only come back through it: remember which one. */
	const noteTunnel = (request: IncomingMessage, user: User): void => {
		if (user.role === "owner" || user.tunnel !== undefined || !parseCookies(request.headers.cookie)[COOKIE]) return;
		const tunnel = quickTunnelHost(request);
		if (tunnel !== undefined) app.config.updateUser(user.id, { tunnel });
	};

	const api = async (request: IncomingMessage, response: ServerResponse, url: URL, parts: string[]): Promise<void> => {
		const method = request.method ?? "GET";
		const user = requireUser(request);
		noteTunnel(request, user);
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
		if (first === "users" && second === undefined && method === "GET") return json(response, 200, app.people(user));
		if (first === "users" && second !== undefined && third === "remove" && method === "POST") {
			app.removeUser(user, second);
			return json(response, 200, { ok: true });
		}
		if (first === "users" && second !== undefined && third === undefined && method === "POST") {
			app.setAccess(user, second, await readJson(request));
			return json(response, 200, app.people(user));
		}
		if (first === "visibility" && method === "POST") {
			const body = await readJson<{ tab?: unknown; visible?: unknown }>(request);
			app.setVisible(user, String(body.tab ?? ""), body.visible !== false);
			return json(response, 200, { ok: true });
		}
		if (first === "push") return pushRoute(request, response, user, second);
		// The Omarchy desktop's theme, for the app's "Follow desktop" look: colors say nothing about the sessions here, so
		// everyone signed in gets them. The wallpaper may be a personal photo: only the owner gets that.
		if (first === "theme" && second === undefined && method === "GET") {
			const theme = await desktopTheme();
			return json(response, 200, { theme: theme === null ? null : { ...theme, wallpaper: theme.wallpaper && user.role === "owner" } });
		}
		if (first === "theme" && second === "wallpaper" && method === "GET") {
			if (user.role !== "owner") throw new HttpError(403, "Only the owner sees the desktop's wallpaper");
			const file = await wallpaperFile();
			if (file === undefined) throw new HttpError(404, "No wallpaper");
			return serveImage(request, response, file);
		}
		if (first === "running" && method === "GET") return json(response, 200, await runningNow(app, user));
		if (first === "spend" && method === "GET") return json(response, 200, app.spend.summary(user));
		if (first === "spend" && method === "POST") {
			const body = await readJson<{ session?: unknown; person?: unknown; budget?: unknown }>(request);
			if (body.session !== undefined) await app.spend.setSessionBudget(user, conversationId(String(body.session)), body.budget);
			else if (typeof body.person === "string") app.spend.setPersonBudget(user, body.person, body.budget);
			else throw new HttpError(400, "Say which session or person");
			return json(response, 200, app.spend.summary(user));
		}
		if (first === "sessions" && second === undefined && method === "GET") return json(response, 200, app.sessions(user));
		if (first === "sessions" && second === undefined && method === "POST") {
			const body = await readJson<{ cwd?: string; title?: string; worktree?: unknown }>(request);
			return json(response, 200, await app.commands.createSession(user, body));
		}
		if (first === "sessions" && second !== undefined && method === "POST") {
			const body = await readJson<{ title?: string; archived?: boolean }>(request);
			await app.commands.updateSession(conversationId(second), user, body);
			return json(response, 200, { ok: true });
		}
		if (first === "c" && second !== undefined) {
			const id = conversationId(second);
			app.requireSee(user, id);
			if (third === "submit" && method === "POST") {
				const body = await readJson<SubmitRequest>(request);
				if (typeof body.text !== "string" || typeof body.requestId !== "string") throw new HttpError(400, "text and requestId are required");
				if (body.attachments !== undefined && !Array.isArray(body.attachments)) throw new HttpError(400, "attachments must be a list");
				const attachments = (body.attachments ?? []).filter((file): file is Attachment => {
					// Only files this server stored for this conversation.
					return typeof file?.path === "string" && resolve(file.path).startsWith(app.uploadDirectory(id) + sep);
				});
				return json(response, 200, await app.commands.submit(id, user, { ...body, attachments }));
			}
			if (third === "chat" && method === "POST") {
				const body = await readJson<{ text?: unknown; requestId?: unknown; quote?: { entryId?: unknown } }>(request);
				if (typeof body.text !== "string" || typeof body.requestId !== "string") throw new HttpError(400, "text and requestId are required");
				const quote = typeof body.quote === "object" && body.quote !== null ? { entryId: body.quote.entryId } : undefined;
				return json(response, 200, await app.collab.postChat(id, user, { text: body.text, requestId: body.requestId, ...(quote === undefined ? {} : { quote }) }));
			}
			if (third === "react" && method === "POST") {
				const body = await readJson<{ entryId?: unknown; emoji?: unknown }>(request);
				await app.collab.react(id, user, Number(body.entryId), String(body.emoji ?? ""));
				return json(response, 200, { ok: true });
			}
			if (third === "pin" && method === "POST") {
				return json(response, 200, await app.collab.pin(id, user, await readJson(request)));
			}
			if (third === "notes" && method === "POST") {
				const body = await readJson<{ text?: unknown; rev?: unknown }>(request);
				if (typeof body.text !== "string" || typeof body.rev !== "number") throw new HttpError(400, "text and rev are required");
				return json(response, 200, await app.collab.saveNotes(id, user, body.text, body.rev));
			}
			if (third === "turns" && method === "POST") {
				await app.collab.turns(id, user, await readJson(request));
				return json(response, 200, { ok: true });
			}
			if (third === "typing" && method === "POST") {
				const body = await readJson<{ where?: unknown }>(request);
				app.collab.setTyping(id, user, body.where);
				return json(response, 200, { ok: true });
			}
			if (third === "abort" && method === "POST") {
				await app.commands.abort(id, user);
				return json(response, 200, { ok: true });
			}
			if (third === "withdraw" && method === "POST") {
				const body = await readJson<{ submissionId?: number }>(request);
				return json(response, 200, { result: await app.commands.withdraw(id, user, Number(body.submissionId)) });
			}
			if (third === "configure" && method === "POST") {
				await app.commands.configure(id, user, await readJson(request));
				return json(response, 200, { ok: true });
			}
			if (third === "reset" && method === "POST") {
				const body = await readJson<{ note?: unknown }>(request);
				await app.commands.reset(id, user, body.note);
				return json(response, 200, { ok: true });
			}
			if (third === "instructions" && method === "POST") {
				const body = await readJson<{ text?: unknown }>(request);
				await app.commands.setInstructions(id, user, body.text);
				return json(response, 200, { ok: true });
			}
			if (third === "plan" && method === "POST") {
				const body = await readJson<{ on?: unknown; approve?: unknown }>(request);
				if (body.approve === true) return json(response, 200, await app.commands.approvePlan(id, user));
				await app.commands.setPlan(id, user, body.on);
				return json(response, 200, { ok: true });
			}
			if (third === "schedules" && fourth === undefined && method === "POST") return json(response, 200, await app.commands.schedule(id, user, await readJson(request)));
			if (third === "schedules" && fourth !== undefined && parts[4] === "cancel" && method === "POST") {
				await app.commands.cancelSchedule(id, user, fourth);
				return json(response, 200, { ok: true });
			}
			if (third === "goal" && method === "POST") {
				const body = await readJson<{ command?: unknown; clear?: unknown }>(request);
				if (body.clear === true) await app.commands.clearGoal(id, user);
				else await app.commands.setGoal(id, user, body.command);
				return json(response, 200, { ok: true });
			}
			if (third === "worktree" && method === "POST") {
				const body = await readJson<{ remove?: unknown; force?: unknown }>(request);
				if (body.remove !== true) throw new HttpError(400, "Only removing a worktree is asked for here");
				await app.commands.removeWorktree(id, user, body.force);
				return json(response, 200, { ok: true });
			}
			if (third === "fork" && method === "POST") return json(response, 200, await app.commands.fork(id, user, await readJson(request)));
			if (third === "resend" && method === "POST") return json(response, 200, await app.commands.resend(id, user, await readJson(request)));
			if (third === "compact" && method === "POST") {
				const body = await readJson<{ instructions?: unknown }>(request);
				if (body.instructions !== undefined && body.instructions !== null && typeof body.instructions !== "string") throw new HttpError(400, "instructions must be text");
				await app.commands.compact(id, user, (body.instructions as string | null | undefined)?.trim() || undefined);
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
			if (third === "export" && method === "GET") {
				const { filename, markdown } = await app.exportMarkdown(id, user);
				return send(response, 200, markdown, "text/markdown; charset=utf-8", { "content-disposition": `attachment; filename="${filename}"` });
			}
			if (third === "changes" && fourth === undefined && method === "GET") return json(response, 200, await app.changes(id, user));
			if (third === "changes" && fourth === "diff" && method === "GET") {
				return send(response, 200, await app.changeDiff(id, user, url.searchParams.get("path") ?? ""), "text/plain; charset=utf-8");
			}
			if (third === "prompts" && method === "GET") {
				return json(response, 200, app.promptTemplates(id).map(({ name, description, argumentHint }) => ({ name, description, ...(argumentHint === undefined ? {} : { argumentHint }) })));
			}
			if (third === "history" && method === "GET") {
				return json(response, 200, await app.history(id, Number(url.searchParams.get("before") ?? Number.MAX_SAFE_INTEGER)));
			}
			if (third === "upload" && method === "POST") {
				app.requireSteer(user);
				if (Number(request.headers["content-length"] ?? 0) > MAX_UPLOAD) throw new HttpError(413, "Files can be up to 50 MB");
				await app.conversation(id);
				const name = safeName(url.searchParams.get("name") ?? "upload");
				const directory = app.uploadDirectory(id);
				// Unique, and never written over: pasted images all arrive as image.png, often at once.
				const file = join(directory, `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}-${name}`);
				let size = 0;
				request.on("data", (chunk: Buffer) => {
					size += chunk.length;
					if (size > MAX_UPLOAD) request.destroy(new HttpError(413, "Files can be up to 50 MB"));
				});
				try {
					await pipeline(request, createWriteStream(file, { mode: 0o600, flags: "wx" }));
				} catch (error) {
					// A cut-off or oversized upload leaves nothing behind (and a name already taken was never this upload's).
					// Cut off is the client's doing, not a server error.
					if ((error as NodeJS.ErrnoException).code !== "EEXIST") rmSync(file, { force: true });
					if (error instanceof HttpError || request.complete) throw error;
					throw new HttpError(400, "The upload stopped before it finished");
				}
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
		if (first === "settings" && method === "POST") {
			const body = await readJson<{ approvalRule?: unknown }>(request);
			if (body.approvalRule !== undefined) await app.setApprovalRule(user, body.approvalRule);
			return json(response, 200, { ok: true });
		}
		if (first === "extensions" && second === undefined && method === "GET") return json(response, 200, await app.extensions(user));
		if (first === "extensions" && second !== undefined && third === undefined && method === "POST") {
			requireOwner(user);
			const body = await readJson<{ enabled?: unknown }>(request);
			if (typeof body.enabled !== "boolean") throw new HttpError(400, "enabled must be true or false");
			await app.setExtensionEnabled(user, second, body.enabled);
			return json(response, 200, await app.extensions(user));
		}
		if (first === "extensions" && second !== undefined && third === "reload" && method === "POST") {
			requireOwner(user);
			await app.reloadExtension(second);
			return json(response, 200, await app.extensions(user));
		}
		if (first === "providers" && second === undefined && method === "GET") return json(response, 200, app.providers.list());
		if (first === "providers" && second !== undefined && third === "login" && method === "POST") {
			requireOwner(user);
			const body = await readJson<{ type?: string }>(request);
			return json(response, 200, { flowId: app.providers.startLogin(user, second, body.type === "oauth" ? "oauth" : "api_key") });
		}
		if (first === "providers" && second !== undefined && third === "logout" && method === "POST") {
			requireOwner(user);
			await app.providers.logout(second);
			return json(response, 200, { ok: true });
		}
		if (first === "auth" && second !== undefined && third === "cancel" && method === "POST") {
			app.providers.cancelLogin(user, second);
			return json(response, 200, { ok: true });
		}
		if (first === "auth" && second !== undefined && third !== undefined && method === "POST") {
			const body = await readJson<{ value?: string; cancel?: boolean }>(request);
			app.providers.answerLogin(user, second, third, body.cancel === true ? undefined : String(body.value ?? ""));
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
			if (parts[0] === "login" && (request.method === "GET" || request.method === "POST")) {
				const posted = request.method === "POST";
				if (posted && crossSite(request)) throw new HttpError(403, "Sign in from Pi Pocket's own page.");
				const form = posted ? new URLSearchParams((await readBody(request, 10_000)).toString("utf8")) : url.searchParams;
				const token = form.get("token") ?? "";
				const next = localPath(form.get("next"));
				const signingIn = auth.tokenUser(token);
				if (signingIn === undefined) {
					return send(response, 401, page("Pi Pocket", `<h1>Link expired</h1><p>That login link is not valid. Use the link Pi Pocket prints when it starts, or ask someone signed in for a new invite.</p>`), "text/html; charset=utf-8");
				}
				const current = auth.user(request);
				if (!posted && current !== undefined && current.id !== signingIn.id) {
					// Signed in as someone else: switching takes a tap, so a link on another site cannot do it unnoticed.
					return send(
						response,
						200,
						page(
							"Switch account? · Pi Pocket",
							`<h1>Switch account?</h1><p>This browser is signed in as ${escapeHtml(current.name)}. The link you opened signs it in as ${escapeHtml(signingIn.name)} instead.</p><form method="post" action="/login"><input type="hidden" name="token" value="${escapeHtml(token)}"><input type="hidden" name="next" value="${escapeHtml(next)}"><button type="submit">Sign in as ${escapeHtml(signingIn.name)}</button></form><p><a href="/">Stay signed in as ${escapeHtml(current.name)}</a></p>`,
						),
						"text/html; charset=utf-8",
						{ "referrer-policy": "no-referrer" },
					);
				}
				setAuthCookie(request, response, token);
				response.writeHead(303, { location: next });
				response.end();
				return;
			}
			if (parts[0] === "join" && parts[1] !== undefined) {
				const code = parts[1];
				if (request.method === "POST") {
					if (crossSite(request)) throw new HttpError(403, "Join from Pi Pocket's own page.");
					const form = new URLSearchParams((await readBody(request, 10_000)).toString("utf8"));
					const redeemed = auth.redeem(code, form.get("name") ?? "");
					if (redeemed === undefined) {
						return send(response, 410, page("Pi Pocket", "<h1>Invite expired</h1><p>Ask for a new one.</p>"), "text/html; charset=utf-8");
					}
					const tunnel = quickTunnelHost(request);
					if (tunnel !== undefined) app.config.updateUser(redeemed.user.id, { tunnel });
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
			// Shares from other apps go to the service worker (web/sw.js). One that reaches the server came before the
			// worker was installed on this device; nothing here knows where it should go.
			if (parts[0] === "share" && request.method === "POST") {
				return send(
					response,
					200,
					page("Share to Pi", `<h1>Open Pi Pocket first</h1><p>Sharing works once Pi Pocket has been opened on this device over https. Open it, then share again.</p><p><a href="/">Open Pi Pocket</a></p>`),
					"text/html; charset=utf-8",
				);
			}
			// The web app: index.html for app routes, files from web/ otherwise.
			if (parts.length === 0 || parts[0] === "s") return serveApp(response);
			const file = normalize(join(WEB, ...parts));
			if (!file.startsWith(WEB + sep)) throw new HttpError(404, "Not found");
			if (file === join(WEB, "index.html")) return serveApp(response);
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
