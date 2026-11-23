/**
 * Whether a request comes from a browser on the machine the server runs on: what "Show in the file manager" needs
 * (`reveal.ts`), since the window opens on this machine. When unsure, the answer is no.
 *
 * The connection must come from one of this machine's own addresses: loopback, or an address of one of its network
 * interfaces (its LAN or Tailscale address, when the browser uses that). A proxy on this machine (`tailscale serve`,
 * a Cloudflare tunnel, nginx) also connects from loopback, for every browser it serves. So a request that carries a
 * proxy's headers is local only when every client address they name is one of this machine's too (none named: not
 * local); and one without them is local only when it asks for this machine by a name that only this machine answers
 * to: `localhost`, its host name (also as `.local` or its tailnet's `.ts.net` name), or one of its addresses (a proxy
 * that adds no headers still keeps a public name).
 * Headers only ever take "local" away: a connection from elsewhere is never local.
 */
import type { IncomingMessage } from "node:http";
import { BlockList, isIP } from "node:net";
import { hostname, networkInterfaces } from "node:os";
import type { User } from "./config.ts";
import { HttpError } from "./errors.ts";
import { hasDesktop } from "./reveal.ts";

/** What the check knows of this machine: its network interfaces, and its host name. */
export interface Machine {
    interfaces: NodeJS.Dict<{ address: string }[]>;
    hostname: string;
}

/** What of a request the check reads. */
export type LocalRequest = Pick<IncomingMessage, "headers"> & {
    socket: { remoteAddress?: string | undefined };
};

const LOOPBACK = new BlockList();

LOOPBACK.addSubnet("127.0.0.0", 8, "ipv4");
LOOPBACK.addAddress("::1", "ipv6");

/** Headers a proxy adds that name the client it serves. */
const CLIENT_HEADERS = [
    "x-forwarded-for",
    "x-real-ip",
    "cf-connecting-ip",
    "true-client-ip",
    "x-client-ip",
];

/** This machine as the system tells it now; no interfaces when it will not say, which leaves loopback. */
function thisMachine(): Machine {
    let interfaces: Machine["interfaces"] = {};

    try {
        interfaces = networkInterfaces();
    } catch {
        // Loopback only.
    }

    return { interfaces, hostname: hostname() };
}

/** Whether a header says the request came through a proxy, whether it names the client or not. */
function forwardingSign(name: string): boolean {
    return (
        name === "forwarded" ||
        name === "via" ||
        name.startsWith("x-forwarded-") ||
        name.startsWith("cf-") ||
        name.startsWith("tailscale-") ||
        CLIENT_HEADERS.includes(name)
    );
}

/** An address as a header or the socket writes it, without zone, port, brackets, or quotes. Undefined: not one. */
function plainAddress(text: string): string | undefined {
    let value = text.trim().replace(/^"(.*)"$/, "$1");
    const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(value);

    if (bracketed !== null) {
        value = bracketed[1]!;
    } else if (/^[\d.]+:\d+$/.test(value)) {
        value = value.slice(0, value.lastIndexOf(":"));
    }

    value = value.replace(/%.*$/, "").toLowerCase();

    return isIP(value) === 0 ? undefined : value;
}

const familyOf = (address: string) => (isIP(address) === 4 ? "ipv4" : "ipv6");

/** Whether an address is one of this machine's own: loopback, or an address of one of its network interfaces. */
export function ownAddress(text: string, machine: Machine = thisMachine()): boolean {
    const address = plainAddress(text);

    if (address === undefined) {
        return false;
    }

    if (LOOPBACK.check(address, familyOf(address))) {
        return true;
    }

    const own = new BlockList();

    for (const each of Object.values(machine.interfaces).flat()) {
        const mine = each === undefined ? undefined : plainAddress(each.address);

        if (mine !== undefined) {
            own.addAddress(mine, familyOf(mine));
        }
    }

    return own.check(address, familyOf(address));
}

/** The client addresses a proxy's headers name, as written: each `for=` of `Forwarded`, and each of the others. */
function forwardedClients(headers: IncomingMessage["headers"]): string[] {
    const listed = (name: string) => {
        const value = headers[name];
        const values = Array.isArray(value) ? value : value === undefined ? [] : [value];

        return values.flatMap((each) => each.split(","));
    };

    const forwarded = listed("forwarded").flatMap((element) =>
        element
            .split(";")
            .map((pair) => /^\s*for\s*=(.*)$/i.exec(pair)?.[1])
            .filter((each) => each !== undefined),
    );

    return [...forwarded, ...CLIENT_HEADERS.flatMap(listed)];
}

/** Whether a `Host` asks for this machine by a name only it answers to: `localhost`, its host name, or its address. */
function ownHost(host: string | undefined, machine: Machine): boolean {
    if (host === undefined) {
        return false;
    }

    if (plainAddress(host) !== undefined) {
        return ownAddress(host, machine);
    }

    const name = host.trim().toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
    const full = machine.hostname.toLowerCase();
    const self = full.split(".")[0] ?? "";

    // Its names on the local network (`.local`) and the tailnet (`<host>.<tailnet>.ts.net`) name only this machine.
    return (
        name === "localhost" ||
        name.endsWith(".localhost") ||
        (self !== "" &&
            (name === self ||
                name === full ||
                name === `${self}.local` ||
                (name.startsWith(`${self}.`) && name.endsWith(".ts.net"))))
    );
}

/** Whether the browser that sent `request` runs on this machine (see above). */
export function isLocalRequest(request: LocalRequest, machine: Machine = thisMachine()): boolean {
    const socket = request.socket.remoteAddress;

    if (socket === undefined || !ownAddress(socket, machine)) {
        return false;
    }

    if (!Object.keys(request.headers).some(forwardingSign)) {
        return ownHost(request.headers.host, machine);
    }

    const clients = forwardedClients(request.headers);

    return clients.length > 0 && clients.every((client) => ownAddress(client, machine));
}

/**
 * Whether this person's browser is offered "Show in the file manager" for sessions on this server: the owner's, in a
 * browser on this machine, when it has a desktop. A session on another computer shows it there instead (its runner).
 */
export function revealOffered(user: User, local: boolean): boolean {
    return user.role === "owner" && local && hasDesktop();
}

/** Refuse a reveal on this machine for a browser elsewhere, where nobody would see the window: a 403. */
export function requireLocalBrowser(request: LocalRequest): void {
    if (!isLocalRequest(request)) {
        throw new HttpError(
            403,
            "Show in file manager works only in a browser on the server's machine",
        );
    }
}

/** A `hello` with `server.canReveal` for one browser (`revealOffered`): `GET /api/me` and each tab's stream. */
export function withReveal<T extends { server: object }>(hello: T, user: User, local: boolean): T {
    return { ...hello, server: { ...hello.server, canReveal: revealOffered(user, local) } };
}
