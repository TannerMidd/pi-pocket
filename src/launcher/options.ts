/** The launcher's command line: its options, from arguments and the environment, and its help. */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { ACCESS_MODES, type AccessMode, isAccessMode } from "./access.ts";
import { restoreTerminal } from "./term.ts";

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

export interface Options {
    access: AccessMode | undefined;
    yes: boolean;
    host: string | undefined;
    port: number;
    cwd: string;
    data: string;
    rotateToken: boolean;
}

export function parseArgs(argv: string[]): Options {
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

            if (next === undefined) {
                fail(`${arg} needs a value`);
            }

            return next!;
        };

        if (arg === "--access" || arg === "-a") {
            const mode = value();

            if (!isAccessMode(mode)) {
                fail(`--access must be one of: ${ACCESS_MODES.join(", ")}`);
            }

            options.access = mode as AccessMode;
        } else if (arg === "--yes" || arg === "-y") {
            options.yes = true;
        } else if (arg === "--host") {
            options.host = value();
        } else if (arg === "--port" || arg === "-p") {
            options.port = Number(value());
        } else if (arg === "--cwd") {
            options.cwd = resolve(value());
        } else if (arg === "--data") {
            options.data = resolve(value());
        } else if (arg === "--rotate-token") {
            options.rotateToken = true;
        } else if (arg === "--help" || arg === "-h") {
            console.log(HELP);
            process.exit(0);
        } else {
            fail(`Unknown argument: ${arg}\n\n${HELP}`);
        }
    }

    if (!Number.isInteger(options.port) || options.port <= 0 || options.port > 65535) {
        fail("--port must be a port number");
    }

    return options;
}

export function fail(message: string): never {
    restoreTerminal();
    console.error(message);
    process.exit(1);
}
