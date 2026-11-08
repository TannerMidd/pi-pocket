/**
 * Whether the runner may talk to its server over plain HTTP. HTTPS is always fine. Plain HTTP carries the computer's
 * key and every command in the clear, so it is allowed only where nobody else can read it:
 *
 * - this computer (loopback: `localhost`, 127.0.0.0/8, ::1), and
 * - a device of this computer's own tailnet, as Tailscale itself says (`tailscale whois`): WireGuard encrypts the
 *   traffic, and Tailscale has checked who the other end is. A 100.x address alone proves nothing, since internet
 *   providers and other VPNs use that range too.
 *
 * Anything else over HTTP needs the person's explicit "allow plain HTTP" for that server (`settings.http`).
 */
import { spawn } from "node:child_process";
import { lookup } from "node:dns/promises";
import { existsSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";

/** What the runner checked, for its log and its refusal. */
export type Transport =
    | { ok: true; why: "https" | "loopback" | "tailscale" | "allowed"; address?: string }
    | { ok: false; address: string; tailscale: TailscaleAnswer };

/** What `tailscale whois` said about an address. */
export type TailscaleAnswer = "peer" | "not-a-peer" | "unavailable";

const LOOPBACK_NAMES = new Set(["localhost", "localhost.localdomain", "ip6-localhost"]);

/** Whether an IP address is this computer's own (loopback). */
export function loopback(address: string): boolean {
    const bare = address.replace(/^\[|\]$/g, "").toLowerCase();

    if (isIP(bare) === 4) {
        return bare.startsWith("127.");
    }

    // ::1, also written out in full, and IPv4 loopback mapped into IPv6.
    return bare === "::1" || /^(0{1,4}:){7}0{0,3}1$/.test(bare) || /^::ffff:127\./.test(bare);
}

/** The places Tailscale's command is, beyond the PATH: the Mac app, and the Windows installer. */
function tailscaleCommands(): string[] {
    const found = ["tailscale"];

    if (process.platform === "darwin") {
        found.push("/Applications/Tailscale.app/Contents/MacOS/Tailscale");
    } else if (process.platform === "win32") {
        const programs = process.env.ProgramFiles ?? "C:\\Program Files";

        found.push(join(programs, "Tailscale", "tailscale.exe"));
    }

    return found.filter((each) => each === "tailscale" || existsSync(each));
}

/** Run a command; its exit code and output, or undefined when it cannot start. */
function run(
    command: string,
    args: string[],
): Promise<{ code: number | null; out: string } | undefined> {
    return new Promise((resolve) => {
        let out = "";
        let child;

        try {
            child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
        } catch {
            resolve(undefined);

            return;
        }

        const timer = setTimeout(() => child.kill(), 5000);

        child.stdout.on("data", (data: Buffer) => (out += data.toString("utf8")));
        child.stderr.on("data", (data: Buffer) => (out += data.toString("utf8")));
        child.on("error", () => {
            clearTimeout(timer);
            resolve(undefined);
        });
        child.on("close", (code) => {
            clearTimeout(timer);
            resolve({ code, out });
        });
    });
}

/**
 * Ask Tailscale on this computer whether `address` is a device of its tailnet. "unavailable": Tailscale is not
 * installed, not running, or did not answer, so nothing is assumed.
 */
export async function tailscalePeer(address: string): Promise<TailscaleAnswer> {
    for (const command of tailscaleCommands()) {
        const result = await run(command, ["whois", "--json", address]);

        if (result === undefined) {
            continue;
        }

        if (result.code === 0) {
            try {
                const answer = JSON.parse(result.out) as { Node?: { Addresses?: unknown } };
                const addresses = Array.isArray(answer.Node?.Addresses)
                    ? (answer.Node.Addresses as unknown[])
                    : [];

                // The device must own that very address, not merely route to it.
                if (
                    addresses.some(
                        (each) =>
                            typeof each === "string" &&
                            each.split("/")[0]!.toLowerCase() === address.toLowerCase(),
                    )
                ) {
                    return "peer";
                }
            } catch {
                // Below: whatever it printed, it did not name a peer.
            }
        }

        // It ran: "peer not found", or an error such as "Tailscale is stopped".
        return /not found|no match/i.test(result.out) ? "not-a-peer" : "unavailable";
    }

    return "unavailable";
}

/**
 * Check `server` before the runner sends it anything. `allowHttp`: the person allowed plain HTTP to it. Resolves the
 * name now, each time, so a name that once pointed into the tailnet and now points elsewhere is refused.
 */
export async function checkTransport(server: string, allowHttp: boolean): Promise<Transport> {
    const url = new URL(server);

    if (url.protocol === "https:") {
        return { ok: true, why: "https" };
    }

    const host = url.hostname.replace(/^\[|\]$/g, "");
    let addresses: string[];

    if (isIP(host) !== 0) {
        addresses = [host];
    } else if (LOOPBACK_NAMES.has(host.toLowerCase())) {
        return { ok: true, why: "loopback", address: host };
    } else {
        try {
            addresses = (await lookup(host, { all: true })).map((each) => each.address);
        } catch {
            addresses = [];
        }
    }

    if (addresses.length > 0 && addresses.every(loopback)) {
        return { ok: true, why: "loopback", address: addresses[0]! };
    }

    // Every address the name has must be a tailnet device: the connection could go to any of them.
    let answer: TailscaleAnswer = addresses.length === 0 ? "unavailable" : "peer";

    for (const address of addresses) {
        const each = loopback(address) ? "peer" : await tailscalePeer(address);

        if (each !== "peer") {
            answer = each;
            break;
        }
    }

    if (answer === "peer") {
        return { ok: true, why: "tailscale", address: addresses[0]! };
    }

    if (allowHttp) {
        return { ok: true, why: "allowed", address: addresses[0] ?? host };
    }

    return { ok: false, address: addresses[0] ?? host, tailscale: answer };
}

/** Why plain HTTP to `server` is not safe, in 2 lines: the risk, and what Tailscale said. */
export function unsafe(server: string, transport: Extract<Transport, { ok: false }>): string {
    const tailscale =
        transport.tailscale === "unavailable"
            ? "Tailscale is not installed or not running here, so the runner cannot check that the address is on your tailnet."
            : `Tailscale says ${transport.address} is not a device on your tailnet.`;

    return `${server} uses plain HTTP: anyone on the network could read this computer's key and the commands it runs.\n${tailscale}`;
}

/** Why the runner will not use plain HTTP to `server`, and what to do: for its log, `link`, and the desktop app. */
export function refusal(server: string, transport: Extract<Transport, { ok: false }>): string {
    return `${unsafe(server, transport)}\nUse an https:// address or Tailscale. To allow plain HTTP to this server anyway, run: pi-pocket runner settings http allow`;
}
