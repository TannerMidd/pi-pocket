/**
 * The Pi Pocket launcher. Pick how your devices reach this server (this device only, the local network, a Cloudflare
 * quick tunnel, or Tailscale), then it runs the server and the tunnel. The server restarts when the app asks (exit code
 * 75) or after a crash; the tunnel stays up across those restarts, so its address does not change.
 *
 *   pi-pocket [--access local|lan|cloudflare|tailscale] [-y] [--port 8787] [--cwd DIR] [--data DIR] [--rotate-token]
 */
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
	ACCESS_LABELS,
	ACCESS_MODES,
	type AccessMode,
	bindHost,
	CloudflareTunnel,
	cloudflaredSource,
	downloadCloudflared,
	findCloudflared,
	isAccessMode,
	lanAddresses,
	tailscaleAddress,
} from "./access.ts";
import { accent, bold, type Choice, choose, columns, confirm, cut, cyan, dim, green, interactive, onKeys, qrLines, red, restoreTerminal, yellow } from "./term.ts";

const SERVER = fileURLToPath(new URL("../server/main.ts", import.meta.url));
const RESTART_CODE = 75;
const CONFIG_ERROR_CODE = 78;

// ─── Options ────────────────────────────────────────────────────────────

const HELP = `Pi Pocket: a durable, multiplayer, mobile-first web app for Pi agents.

Usage: pi-pocket [options]

  -a, --access MODE   How other devices reach this server:
                        local       this device only
                        lan         devices on the same network (http)
                        cloudflare  anywhere, through a Cloudflare quick tunnel (https)
                        tailscale   devices on your tailnet
                      Without it, a menu asks (in a terminal) or the last choice is used.
  -y, --yes           Use the last choice without asking
  -p, --port N        Port (default 8787)
      --cwd DIR       Folder for new sessions (default: the current folder)
      --data DIR      Data folder (default ~/.pi-pocket)
      --host HOST     Listen on this address instead of choosing an access mode
      --rotate-token  Replace the owner sign-in link, signing out the devices that used it
  -h, --help          Show this help

Environment: PI_POCKET_ACCESS, PI_POCKET_PORT, PI_POCKET_DIR, PI_POCKET_HOST, PI_POCKET_GUARD=off`;

interface Options {
	access: AccessMode | undefined;
	yes: boolean;
	host: string | undefined;
	port: number;
	cwd: string;
	data: string;
	rotateToken: boolean;
}

function parseArgs(argv: string[]): Options {
	const envAccess = process.env.PI_POCKET_ACCESS;
	const options: Options = {
		access: isAccessMode(envAccess) ? envAccess : undefined,
		yes: false,
		host: process.env.PI_POCKET_HOST || undefined,
		port: Number(process.env.PI_POCKET_PORT ?? 8787),
		cwd: process.cwd(),
		data: resolve(process.env.PI_POCKET_DIR ?? join(homedir(), ".pi-pocket")),
		rotateToken: false,
	};
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index]!;
		const value = () => {
			const next = argv[++index];
			if (next === undefined) fail(`${arg} needs a value`);
			return next!;
		};
		if (arg === "--access" || arg === "-a") {
			const mode = value();
			if (!isAccessMode(mode)) fail(`--access must be one of: ${ACCESS_MODES.join(", ")}`);
			options.access = mode as AccessMode;
		} else if (arg === "--yes" || arg === "-y") options.yes = true;
		else if (arg === "--host") options.host = value();
		else if (arg === "--port" || arg === "-p") options.port = Number(value());
		else if (arg === "--cwd") options.cwd = resolve(value());
		else if (arg === "--data") options.data = resolve(value());
		else if (arg === "--rotate-token") options.rotateToken = true;
		else if (arg === "--help" || arg === "-h") {
			console.log(HELP);
			process.exit(0);
		} else fail(`Unknown argument: ${arg}\n\n${HELP}`);
	}
	if (!Number.isInteger(options.port) || options.port <= 0 || options.port > 65535) fail("--port must be a port number");
	return options;
}

function fail(message: string): never {
	restoreTerminal();
	console.error(message);
	process.exit(1);
}

const options = parseArgs(process.argv.slice(2));
mkdirSync(options.data, { recursive: true, mode: 0o700 });
const settingsFile = join(options.data, "launcher.json");

function loadSettings(): { access?: AccessMode } {
	try {
		const parsed = JSON.parse(readFileSync(settingsFile, "utf8")) as { access?: string };
		return isAccessMode(parsed.access) ? { access: parsed.access } : {};
	} catch {
		return {};
	}
}

function saveSettings(access: AccessMode): void {
	writeFileSync(settingsFile, `${JSON.stringify({ access }, null, "\t")}\n`, { mode: 0o600 });
}

const home = homedir();
const tilde = (path: string) => (path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path);

// ─── Output ─────────────────────────────────────────────────────────────

/** Server and tunnel lines wait here while a menu or question is on screen. */
let held: string[] | undefined;

function log(line: string): void {
	if (held !== undefined) held.push(line);
	else process.stdout.write(`${line}\n`);
}

function hold(): void {
	held ??= [];
}

function release(): void {
	const lines = held ?? [];
	held = undefined;
	for (const line of lines) log(line);
}

function pipeLines(stream: NodeJS.ReadableStream | null, each: (line: string) => void): void {
	if (stream !== null) createInterface({ input: stream }).on("line", each);
}

// ─── Choosing access ────────────────────────────────────────────────────

function accessChoices(): { mode: AccessMode; choice: Choice }[] {
	const port = options.port;
	const lan = lanAddresses()[0];
	const tailnet = tailscaleAddress();
	const cloudflared = findCloudflared(options.data);
	const source = cloudflaredSource();
	return [
		{ mode: "local", choice: { label: ACCESS_LABELS.local, detail: `http://127.0.0.1:${port}` } },
		{
			mode: "lan",
			choice:
				lan === undefined
					? { label: ACCESS_LABELS.lan, detail: "no network connection found", disabled: true }
					: { label: ACCESS_LABELS.lan, detail: `http://${lan}:${port} · same Wi-Fi, not encrypted` },
		},
		{
			mode: "cloudflare",
			choice: {
				label: ACCESS_LABELS.cloudflare,
				detail: cloudflared
					? "public https link from anywhere · no account needed"
					: "url" in source
						? "public https link · downloads cloudflared first"
						: `needs cloudflared: ${source.install}`,
				disabled: cloudflared === undefined && !("url" in source),
			},
		},
		{
			mode: "tailscale",
			choice:
				tailnet === undefined
					? { label: ACCESS_LABELS.tailscale, detail: "not connected on this machine", disabled: true }
					: { label: ACCESS_LABELS.tailscale, detail: `http://${tailnet}:${port} · your tailnet only` },
		},
	];
}

async function pickAccess(current: AccessMode | undefined): Promise<AccessMode | undefined> {
	const options = accessChoices();
	const initial = Math.max(0, options.findIndex((each) => each.mode === current));
	const picked = await choose(
		"How should your devices reach Pi Pocket?",
		options.map((each) => each.choice),
		initial,
	);
	return picked === undefined ? undefined : options[picked]!.mode;
}

/** cloudflared's path, downloading it first when the user agrees. */
async function ensureCloudflared(): Promise<string | undefined> {
	const found = findCloudflared(options.data);
	if (found !== undefined) return found;
	const source = cloudflaredSource();
	if (!("url" in source)) {
		log(yellow(`  cloudflared is not installed. Install it with: ${source.install}`));
		return undefined;
	}
	if (!interactive) {
		log(yellow("  cloudflared is not installed. Install it, or run pi-pocket once in a terminal to download it."));
		return undefined;
	}
	log("");
	const yes = await confirm(`Download cloudflared (Cloudflare's official release, about 40 MB) to ${tilde(join(options.data, "bin"))}?`, true);
	if (!yes) return undefined;
	let last = 0;
	try {
		const file = await downloadCloudflared(options.data, source.url, (done, total) => {
			if (Date.now() - last < 120 && done !== total) return;
			last = Date.now();
			const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);
			process.stdout.write(`\r  ${dim(`Downloading… ${mb(done)}${total ? ` / ${mb(total)}` : ""} MB`)}\x1b[K`);
		});
		process.stdout.write(`\r  ${green("✓")} cloudflared is ready.\x1b[K\n`);
		return file;
	} catch (error) {
		process.stdout.write("\n");
		log(red(`  Could not download cloudflared: ${error instanceof Error ? error.message : String(error)}`));
		return undefined;
	}
}

// ─── State ──────────────────────────────────────────────────────────────

type Mode = AccessMode | "custom";

const state = {
	mode: "local" as Mode,
	host: "127.0.0.1",
	loginPath: undefined as string | undefined,
	serverReady: false,
	everReady: false,
	/** Show the panel once the server (and the tunnel, if any) is up. */
	panelPending: true,
	publicUrl: undefined as string | undefined,
	tunnelTrouble: false,
	tunnelFailures: 0,
};

let child: ChildProcess | undefined;
let tunnel: CloudflareTunnel | undefined;
let quitting = false;
const crashes: number[] = [];

const wildcard = (host: string) => host === "0.0.0.0" || host === "::";
const loopback = (host: string) => host === "localhost" || host === "::1" || host.startsWith("127.");

/** The address other devices should open. */
function appUrl(): string {
	const port = options.port;
	if (state.mode === "cloudflare" && state.publicUrl !== undefined) return state.publicUrl;
	if (wildcard(state.host)) return `http://${lanAddresses()[0] ?? "127.0.0.1"}:${port}`;
	return `http://${state.host.includes(":") ? `[${state.host}]` : state.host}:${port}`;
}

/** The address a browser on this machine should open. */
function localUrl(): string {
	return wildcard(state.host) || loopback(state.host) ? `http://127.0.0.1:${options.port}` : appUrl();
}

function modeLabel(): string {
	if (state.mode === "custom") return `Listening on ${state.host}`;
	return ACCESS_LABELS[state.mode];
}

function modeNote(): string {
	switch (state.mode) {
		case "local":
			return "other devices cannot connect";
		case "lan":
			return "devices on this network, not encrypted";
		case "cloudflare":
			return state.publicUrl === undefined ? "tunnel not up yet" : "public https link, new each launch";
		case "tailscale":
			return "devices on your tailnet";
		default:
			return "";
	}
}

/** Other devices can open the app at `appUrl()`. */
function reachable(): boolean {
	if (state.mode === "cloudflare") return state.publicUrl !== undefined;
	return !loopback(state.host);
}

function sendAccess(): void {
	if (child?.connected !== true) return;
	const access = {
		mode: state.mode,
		label: modeLabel(),
		...(state.mode === "cloudflare" && state.publicUrl !== undefined ? { url: state.publicUrl } : {}),
	};
	child.send({ type: "access", access });
}

// ─── The panel ──────────────────────────────────────────────────────────

const KEYS_HINT = "q quit · r restart server · a access · o open here · s sign-in QR";

async function showPanel(withQr: boolean): Promise<void> {
	const width = columns();
	const row = (label: string, value: string) => `  ${dim(label.padEnd(9))}${value}`;
	const lines = ["", `  ${accent("π")} ${bold("Pi Pocket")}  ${green("● running")}`, ""];
	lines.push(row("Access", `${modeLabel()}${modeNote() ? dim(` · ${modeNote()}`) : ""}`));
	lines.push(row("Open", cyan(appUrl())));
	if (state.mode === "lan") for (const address of lanAddresses().slice(1)) lines.push(row("", cyan(`http://${address}:${options.port}`)));
	lines.push(row("Folder", tilde(options.cwd)));
	lines.push(row("Data", tilde(options.data)));
	lines.push("");
	const login = state.loginPath === undefined ? undefined : `${reachable() ? appUrl() : localUrl()}${state.loginPath}`;
	if (login !== undefined) {
		if (withQr && reachable()) {
			lines.push(`  ${bold("Scan to sign in on your phone.")} ${dim("It is your owner link: keep it private.")}`, "");
			for (const line of await qrLines(login)) lines.push(`  ${line}`);
			lines.push("");
		} else if (!reachable()) {
			lines.push(
				dim(interactive ? `  Only this machine can connect. Press ${bold("a")} to let your phone in.` : "  Only this machine can connect. Use --access lan, cloudflare, or tailscale to let other devices in."),
				"",
			);
		}
		lines.push(row("Sign in", login));
		lines.push("");
	}
	if (interactive) lines.push(dim(`  ${cut(KEYS_HINT, width - 3)}`), "");
	log(lines.join("\n"));
}

function maybeShowPanel(): void {
	if (!state.panelPending || !state.serverReady) return;
	if (state.mode === "cloudflare" && state.publicUrl === undefined && !state.tunnelTrouble) return;
	state.panelPending = false;
	void showPanel(true);
}

// ─── The server ─────────────────────────────────────────────────────────

function startServer(first: boolean): void {
	const args = [SERVER, "--host", state.host, "--port", String(options.port), "--cwd", options.cwd, "--data", options.data];
	if (first && options.rotateToken) args.push("--rotate-token");
	const proc = spawn(process.execPath, args, {
		stdio: ["ignore", "pipe", "pipe", "ipc"],
		env: { ...process.env, PI_POCKET_SUPERVISED: "1", PI_POCKET_LAUNCHER: "1" },
	});
	child = proc;
	pipeLines(proc.stdout, (line) => log(line));
	pipeLines(proc.stderr, (line) => log(line));
	proc.on("message", (message: { type?: string; loginPath?: string }) => {
		if (message?.type !== "ready" || child !== proc) return;
		state.loginPath = message.loginPath;
		state.serverReady = true;
		const restarted = state.everReady;
		state.everReady = true;
		sendAccess();
		if (state.panelPending) maybeShowPanel();
		else if (restarted) log(green("  ✓ Server restarted. Running work continues."));
	});
	proc.on("exit", (code, signal) => {
		if (child !== proc) return;
		child = undefined;
		state.serverReady = false;
		if (quitting) return;
		if (code === RESTART_CODE) {
			log(dim("  ↻ Restarting the server…"));
			startServer(false);
			return;
		}
		if (code === CONFIG_ERROR_CODE || !state.everReady) {
			log(red("  Pi Pocket could not start (see above)."));
			void quit(code ?? 1);
			return;
		}
		if (code === 0 && signal === null) {
			void quit(0);
			return;
		}
		const now = Date.now();
		crashes.push(now);
		while (crashes.length > 0 && now - crashes[0]! > 60_000) crashes.shift();
		if (crashes.length > 4) {
			log(red("  The server crashed 5 times in a minute; giving up."));
			void quit(code ?? 1);
			return;
		}
		log(yellow(`  The server stopped (${signal ?? `code ${code}`}); starting it again in 2 seconds…`));
		setTimeout(() => !quitting && child === undefined && startServer(false), 2000);
	});
}

function restartServer(): void {
	if (child === undefined) return;
	if (process.platform === "win32") {
		log(dim("  ↻ Restarting the server…"));
		// No SIGUSR2 on Windows: stop it, and start it again from the exit handler.
		child.once("exit", () => !quitting && startServer(false));
		const proc = child;
		child = undefined;
		proc.kill();
		return;
	}
	child.kill("SIGUSR2");
}

// ─── The tunnel ─────────────────────────────────────────────────────────

function startTunnel(binary: string): void {
	log(dim("  Starting a Cloudflare quick tunnel…"));
	const current: CloudflareTunnel = new CloudflareTunnel(binary, options.port, join(options.data, "cloudflared.log"), {
		ready(url) {
			if (tunnel !== current) return;
			const changed = state.publicUrl !== undefined && state.publicUrl !== url;
			state.publicUrl = url;
			state.tunnelTrouble = false;
			state.tunnelFailures = 0;
			sendAccess();
			if (state.panelPending) maybeShowPanel();
			else {
				log(green(`  ✓ Tunnel is up${changed ? " at a new address" : ""}: ${url}`));
				state.panelPending = true;
				maybeShowPanel();
			}
		},
		problem(line) {
			if (tunnel === current) log(yellow(`  cloudflared: ${line}`));
		},
		exit(code) {
			if (tunnel !== current || quitting) return;
			state.publicUrl = undefined;
			state.tunnelTrouble = true;
			state.tunnelFailures++;
			sendAccess();
			const delay = Math.min(60, 2 ** state.tunnelFailures) * 1000;
			log(yellow(`  The tunnel stopped (code ${code}); trying again in ${delay / 1000} seconds. Log: ${tilde(join(options.data, "cloudflared.log"))}`));
			maybeShowPanel();
			setTimeout(() => {
				if (tunnel === current && !quitting) startTunnel(binary);
			}, delay);
		},
	});
	tunnel = current;
	current.start();
}

async function stopTunnel(): Promise<void> {
	const current = tunnel;
	tunnel = undefined;
	state.publicUrl = undefined;
	state.tunnelTrouble = false;
	state.tunnelFailures = 0;
	await current?.stop();
}

/** Switch to `mode`: start or stop the tunnel, and restart the server when it has to listen somewhere else. */
async function applyAccess(mode: AccessMode, binary: string | undefined): Promise<void> {
	await stopTunnel();
	state.mode = mode;
	saveSettings(mode);
	const host = bindHost(mode);
	state.panelPending = true;
	if (host !== state.host) {
		state.host = host;
		restartServer();
	} else {
		sendAccess();
	}
	if (mode === "cloudflare" && binary !== undefined) startTunnel(binary);
	maybeShowPanel();
}

// ─── Keys and shutdown ──────────────────────────────────────────────────

function openInBrowser(url: string): void {
	const command =
		process.platform === "darwin"
			? ["open", url]
			: process.platform === "win32"
				? ["cmd", "/c", "start", "", url]
				: process.platform === "android"
					? ["termux-open-url", url]
					: ["xdg-open", url];
	try {
		const proc = spawn(command[0]!, command.slice(1), { stdio: "ignore", detached: true });
		proc.on("error", () => log(yellow(`  Could not open a browser. Open this: ${url}`)));
		proc.unref();
	} catch {
		log(yellow(`  Could not open a browser. Open this: ${url}`));
	}
}

async function changeAccess(): Promise<void> {
	hold();
	log("");
	try {
		const current = state.mode === "custom" ? undefined : state.mode;
		const next = await pickAccess(current);
		if (next === undefined || next === state.mode) return;
		const binary = next === "cloudflare" ? await ensureCloudflared() : undefined;
		if (next === "cloudflare" && binary === undefined) return;
		await applyAccess(next, binary);
	} finally {
		release();
	}
}

let busyWithKey = false;

function onRunKey(key: string): void {
	if (busyWithKey) return;
	if (key === "q" || key === "ctrl-c") void quit(0);
	else if (key === "r") restartServer();
	else if (key === "o" && state.loginPath !== undefined) openInBrowser(`${localUrl()}${state.loginPath}`);
	else if (key === "s") void showPanel(true);
	else if (key === "a") {
		busyWithKey = true;
		void changeAccess().finally(() => {
			busyWithKey = false;
		});
	} else if (key === "h" || key === "?" || key === "enter") log(dim(`  ${KEYS_HINT}`));
}

async function quit(code: number): Promise<void> {
	if (quitting) return;
	quitting = true;
	release();
	log(dim("  Stopping Pi Pocket…"));
	await stopTunnel();
	const proc = child;
	if (proc !== undefined && proc.exitCode === null) {
		proc.kill("SIGTERM");
		const timer = setTimeout(() => proc.kill("SIGKILL"), 10_000);
		await once(proc, "exit").catch(() => {});
		clearTimeout(timer);
	}
	restoreTerminal();
	process.exit(code);
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => void quit(0));
if (process.platform !== "win32") process.on("SIGUSR2", () => restartServer());
process.on("exit", () => restoreTerminal());

// ─── Start ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	// Until the server runs, Ctrl+C (raw mode turns off the terminal's own) still quits, even mid-download.
	onKeys((key) => key === "ctrl-c" && void quit(130));
	const settings = loadSettings();
	let mode: Mode | undefined = options.access;
	if (mode === undefined && options.host !== undefined) {
		mode = loopback(options.host) ? "local" : wildcard(options.host) ? "lan" : "custom";
	}
	if (interactive && mode === undefined && !options.yes) {
		log("");
		log(`  ${accent("π")} ${bold("Pi Pocket")}  ${dim(tilde(options.cwd))}`);
		log("");
	}
	let binary: string | undefined;
	for (;;) {
		if (mode === undefined) {
			mode = interactive && !options.yes ? await pickAccess(settings.access) : (settings.access ?? "local");
			if (mode === undefined) {
				restoreTerminal();
				process.exit(0);
			}
		}
		if (mode === "tailscale" && tailscaleAddress() === undefined) {
			log(yellow("  Tailscale is not connected on this machine."));
		} else if (mode === "cloudflare") {
			binary = await ensureCloudflared();
			if (binary !== undefined) break;
		} else {
			break;
		}
		if (!interactive || options.access !== undefined) fail("Pick another access mode, or fix the problem above.");
		mode = undefined;
	}
	state.mode = mode;
	state.host = options.host ?? (mode === "custom" ? "127.0.0.1" : bindHost(mode));
	if (mode !== "custom") saveSettings(mode);

	if (!existsSync(SERVER)) fail(`Missing ${SERVER}`);
	log(dim(`  Starting Pi Pocket (${modeLabel()})…`));
	startServer(true);
	if (mode === "cloudflare" && binary !== undefined) startTunnel(binary);
	onKeys(onRunKey);
}

await main();
