#!/usr/bin/env node
/**
 * Pi Pocket server. Run it through `bin/pi-pocket.js`, which restarts it when the app asks to (exit code 75).
 *
 *   node bin/pi-pocket.js [--host 127.0.0.1] [--port 8787] [--cwd DIR] [--data DIR] [--rotate-token]
 *
 * Under the launcher (PI_POCKET_LAUNCHER=1 with an IPC channel) the server reports `ready` instead of printing its
 * sign-in links, and takes `access` messages that say how other devices reach it (a tunnel's public URL).
 */
import { chmodSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { join, resolve } from "node:path";
// Only types from the app here: its modules load below, after the signal handlers (loading takes a moment).
import type { AccessInfo, PocketApp } from "./app.ts";
import { APP_ROOT, dataDir } from "./config.ts";
import type { createHandler } from "./http.ts";

const RESTART_CODE = 75;
/**
 * The server cannot start as configured (for example, the port is taken). On a first start the launcher gives up; after
 * the server has run, it keeps trying, since the port may still be closing or the address may come back.
 */
const CONFIG_ERROR_CODE = 78;
const launcher = process.env.PI_POCKET_LAUNCHER === "1" && typeof process.send === "function";

function parseArgs(argv: string[]) {
	const options = {
		host: process.env.PI_POCKET_HOST ?? "127.0.0.1",
		port: Number(process.env.PI_POCKET_PORT ?? 8787),
		cwd: process.cwd(),
		data: dataDir(),
		rotateToken: false,
	};
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index]!;
		const value = () => {
			const next = argv[++index];
			if (next === undefined) throw new Error(`${arg} needs a value`);
			return next;
		};
		if (arg === "--host") options.host = value();
		else if (arg === "--port" || arg === "-p") options.port = Number(value());
		else if (arg === "--cwd") options.cwd = resolve(value());
		else if (arg === "--data") options.data = resolve(value());
		else if (arg === "--rotate-token") options.rotateToken = true;
		else if (arg === "--help" || arg === "-h") {
			console.log("pi-pocket [--host 127.0.0.1] [--port 8787] [--cwd DIR] [--data DIR] [--rotate-token]");
			process.exit(0);
		} else throw new Error(`Unknown argument: ${arg}`);
	}
	if (!Number.isInteger(options.port) || options.port <= 0) throw new Error("--port must be a number");
	return options;
}

const options = parseArgs(process.argv.slice(2));
process.env.PI_POCKET_DIR = options.data;
// The data folder holds the database, sign-in tokens, push keys, and uploads: only this user may open it, also when
// --data named a folder that already existed.
mkdirSync(options.data, { recursive: true, mode: 0o700 });
chmodSync(options.data, 0o700);

/** How long stopping may wait for running work to stop. What is still running then resumes in the next process. */
const STOP_LIMIT_MS = 10_000;

let app: PocketApp | undefined;
let stopWatching = () => {};
let stopping = false;
/** A stop asked for while starting, done once the start finishes. */
let stopWhenStarted: number | undefined;

const stop = async (code: number) => {
	if (app === undefined) {
		stopWhenStarted ??= code;
		return;
	}
	if (stopping) return;
	stopping = true;
	stopWatching();
	server.close();
	server.closeAllConnections();
	try {
		// A tool or model stream that ignores its abort must not hold a restart (and the phone's only way in) forever.
		const limit = new Promise<void>((resolve) => setTimeout(resolve, STOP_LIMIT_MS).unref());
		await Promise.race([app.close(), limit]);
	} catch (error) {
		console.error("Close failed:", error);
	}
	process.exit(code);
};

// Signals before anything slow (loading the app, opening the database): Node's default for SIGUSR2 and SIGHUP ends
// the process mid-start.
process.on("SIGINT", () => void stop(0));
process.on("SIGTERM", () => void stop(0));
// The terminal closed.
process.on("SIGHUP", () => void stop(0));
process.on("SIGUSR2", () => void stop(RESTART_CODE));
process.on("unhandledRejection", (error) => console.error("Unhandled rejection:", error));
if (launcher) {
	// The launcher is gone (killed, or its terminal closed): stop instead of holding the port and the database.
	process.on("disconnect", () => void stop(0));
	process.on("message", (message: { type?: string; access?: AccessInfo }) => {
		if (message?.type === "access" && app !== undefined) app.setReach(message.access);
	});
}

/** Answers requests once the app is open; until then, a short "starting". */
let handle: ReturnType<typeof createHandler> | undefined;
const server = createServer((request, response) => {
	if (handle !== undefined) return void handle(request, response);
	response.writeHead(503, { "content-type": "text/plain; charset=utf-8", "retry-after": "2", "cache-control": "no-store" });
	response.end("Pi Pocket is starting…");
});
// The whole request must arrive within this: long enough for a 50 MB upload on a slow phone connection. Event streams
// and long polls are GET requests without a body, so their time on the connection does not count.
server.requestTimeout = 15 * 60_000;
server.headersTimeout = 60_000;

// Take the port before opening the database: opening resumes interrupted work, which must not start in a process
// that then exits because it cannot serve.
try {
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.port, options.host, () => {
			server.off("error", reject);
			resolve();
		});
	});
} catch (error) {
	const code = (error as NodeJS.ErrnoException).code;
	console.error(
		code === "EADDRINUSE"
			? `Port ${options.port} is already in use on ${options.host}. Is Pi Pocket already running? Pick another with --port.`
			: `Could not listen on ${options.host}:${options.port}: ${(error as Error).message}`,
	);
	process.exit(CONFIG_ERROR_CODE);
}
server.on("error", (error) => console.error("Server error:", error));

const [{ PocketApp: App }, { createHandler: makeHandler }, { watchTree }] = await Promise.all([
	import("./app.ts"),
	import("./http.ts"),
	import("./reload.ts"),
]);
const opened = await App.open({
	dataDir: options.data,
	defaultCwd: options.cwd,
	supervised: process.env.PI_POCKET_SUPERVISED === "1",
});
app = opened;
if (options.rotateToken) {
	opened.config.rotateOwnerToken();
	console.log("Rotated the owner token; old owner links no longer work.");
}
handle = makeHandler({ app: opened, listen: { host: options.host, port: options.port }, restart: () => void stop(RESTART_CODE) });
stopWatching = (() => {
	const stops = [watchTree(join(APP_ROOT, "web"), (file) => opened.reloadClients(file))];
	opened.loader.watch();
	return () => {
		for (const each of stops) each();
	};
})();

const token = encodeURIComponent(opened.config.ownerToken);
if (launcher) {
	process.send?.({ type: "ready", host: options.host, port: options.port, loginPath: `/login?token=${token}` });
} else {
	const hosts = new Set<string>([options.host === "0.0.0.0" || options.host === "::" ? "127.0.0.1" : options.host]);
	if (options.host === "0.0.0.0" || options.host === "::") {
		for (const list of Object.values(networkInterfaces())) {
			for (const net of list ?? []) if (net.family === "IPv4" && !net.internal) hosts.add(net.address);
		}
	}
	console.log("\nPi Pocket is running.");
	console.log(`  data:     ${options.data}`);
	console.log(`  sessions: new sessions start in ${options.cwd}`);
	console.log("  Open one of these once per browser to sign in as the owner (keep them private):");
	for (const host of hosts) console.log(`    http://${host}:${options.port}/login?token=${token}`);
	console.log("  Other devices: open the app's menu and use “Sign in another device”.\n");
}
if (stopWhenStarted !== undefined) void stop(stopWhenStarted);
