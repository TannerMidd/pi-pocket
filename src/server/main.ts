#!/usr/bin/env node
/**
 * Pi Pocket server. Run it through `bin/pi-pocket.js`, which restarts it when the app asks to (exit code 75).
 *
 *   node bin/pi-pocket.js [--host 127.0.0.1] [--port 8787] [--cwd DIR] [--data DIR] [--rotate-token]
 *
 * Under the launcher (PI_POCKET_LAUNCHER=1 with an IPC channel) the server reports `ready` instead of printing its
 * sign-in links, and takes `access` messages that say how other devices reach it (a tunnel's public URL).
 */
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { join, resolve } from "node:path";
import { type AccessInfo, PocketApp } from "./app.ts";
import { APP_ROOT, dataDir } from "./config.ts";
import { createHandler } from "./http.ts";
import { watchTree } from "./reload.ts";

const RESTART_CODE = 75;
/** Tells the launcher not to retry: the server cannot start as configured (for example, the port is taken). */
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
const app = await PocketApp.open({
	dataDir: options.data,
	defaultCwd: options.cwd,
	supervised: process.env.PI_POCKET_SUPERVISED === "1",
});
if (options.rotateToken) {
	app.config.rotateOwnerToken();
	console.log("Rotated the owner token; old owner links no longer work.");
}

let stopping = false;
const stop = async (code: number) => {
	if (stopping) return;
	stopping = true;
	stopWatching();
	server.close();
	server.closeAllConnections();
	try {
		await app.close();
	} catch (error) {
		console.error("Close failed:", error);
	}
	process.exit(code);
};

const server = createServer(
	createHandler({ app, listen: { host: options.host, port: options.port }, restart: () => void stop(RESTART_CODE) }),
);
server.requestTimeout = 0;
server.headersTimeout = 60_000;
server.on("error", (error: NodeJS.ErrnoException) => {
	const message =
		error.code === "EADDRINUSE"
			? `Port ${options.port} is already in use on ${options.host}. Is Pi Pocket already running? Pick another with --port.`
			: `Could not listen on ${options.host}:${options.port}: ${error.message}`;
	console.error(message);
	void stop(CONFIG_ERROR_CODE);
});
server.listen(options.port, options.host, () => {
	const token = encodeURIComponent(app.config.ownerToken);
	if (launcher) {
		process.send?.({ type: "ready", host: options.host, port: options.port, loginPath: `/login?token=${token}` });
		return;
	}
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
});

const stopWatching = (() => {
	const stops = [watchTree(join(APP_ROOT, "web"), (file) => app.reloadClients(file))];
	app.loader.watch();
	return () => {
		for (const each of stops) each();
	};
})();

if (launcher) {
	process.on("message", (message: { type?: string; access?: AccessInfo }) => {
		if (message?.type === "access") app.access = message.access;
	});
	// The launcher is gone (killed, or its terminal closed): stop instead of holding the port and the database.
	process.on("disconnect", () => void stop(0));
}

process.on("SIGINT", () => void stop(0));
process.on("SIGTERM", () => void stop(0));
process.on("SIGUSR2", () => void stop(RESTART_CODE));
process.on("unhandledRejection", (error) => console.error("Unhandled rejection:", error));
