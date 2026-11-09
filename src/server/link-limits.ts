/**
 * Limits on wrong runner link codes (`runners.ts` `redeem`), the one way in that needs no sign-in: a code is the whole
 * of the access, so guessing must stay slow.
 *
 * - Per client address: `ADDRESS_WRONG` wrong codes within `WINDOW_MS` lock that address out for `LOCK_MS`.
 * - Bans: an address locked out `BLOCKS_TO_BAN` times is banned until the owner lifts it in the Runners sheet. Its count
 *   of lockouts starts over once `BLOCK_MEMORY_MS` passed since its last one. A banned address gets the answer a wrong
 *   code gets, with no hint that it is banned, and its tries count nowhere: the code is not even looked at.
 * - For the whole server, a ceiling for guessing from many changing addresses, which the count per address cannot
 *   catch: `SERVER_WRONG` wrong codes from all addresses together within `WINDOW_MS` pause new linking for `LOCK_MS`,
 *   and the caller voids every open code, so the owner makes a new one. It never touches linked computers or their
 *   keys.
 *
 * The client address is the socket's own. A proxy's word is taken only where it cannot be the client's:
 * - Cloudflare's tunnel (access mode "cloudflare"): from this machine, where its connector runs, `CF-Connecting-IP`.
 * - Tailscale Serve (access mode "tailscale-serve"): from this machine, `X-Forwarded-For`, which Serve sets to the
 *   tailnet client's address, and only when Tailscale itself (`tailscale whois`) says it is a device of the tailnet.
 *   No address range is taken for a tailnet; without a working `tailscale` command, nothing is a tailnet device.
 * Every other header is ignored, so a client cannot pick its own address.
 *
 * The loopback address is never banned: clients of a proxy that names none (Tailscale Funnel, another local proxy)
 * all come from it, so a ban would shut everyone out, the owner too. It is still locked out for a while.
 *
 * Lockouts and the 10-minute counts are kept in memory; the lockout counts toward a ban, and the bans, are saved
 * (`LinkLimitStore`), so a restart lifts no ban.
 */
import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";
import {
    loopback as runnerLoopback,
    tailscalePeer,
    type TailscaleAnswer,
} from "../runner/transport.ts";
import { HttpError } from "./errors.ts";

export const ADDRESS_WRONG = 5;
export const SERVER_WRONG = 50;
export const WINDOW_MS = 10 * 60_000;
export const LOCK_MS = 10 * 60_000;
export const BLOCKS_TO_BAN = 3;
export const BLOCK_MEMORY_MS = 7 * 24 * 60 * 60_000;

/** What a wrong code gets, and a banned address for any code. */
export const WRONG_CODE =
    "This code is wrong, already used, or expired. Get a new one in Menu → Runners.";

/** A lockout for the Runners sheet: who, until when, and which of `BLOCKS_TO_BAN` it is. */
export type LinkLock = { address: string; until: number; blocks: number };

/** A ban for the Runners sheet: who, since when. */
export type LinkBan = { address: string; since: number };

export type LinkLocks = { server?: number; addresses: LinkLock[]; bans: LinkBan[] };

/** What is saved: the lockouts of each address toward a ban, and the bans. */
export type StoredLinkLimits = {
    blocks: { address: string; count: number; last: number }[];
    bans: LinkBan[];
};

export interface LinkLimitStore {
    read(): StoredLinkLimits | undefined;
    write(value: StoredLinkLimits): void;
}

/** A store in memory only, for tests and a server without config. */
export function memoryStore(): LinkLimitStore {
    let value: StoredLinkLimits | undefined;

    return {
        read: () => value,
        write: (next) => {
            value = structuredClone(next);
        },
    };
}

/** An address as compared: IPv4 mapped into IPv6 written as IPv4, IPv6 in lower case. */
function bare(address: string): string {
    return address.replace(/^::ffff:/i, "").toLowerCase();
}

/** Whether `address` is this machine's loopback address: the runner's own check (`transport.ts`), one for both. */
export const loopback = runnerLoopback;

/** One header's single value, or undefined when it is missing or given more than once. */
function single(header: string | string[] | undefined): string | undefined {
    const value = Array.isArray(header) ? (header.length === 1 ? header[0] : undefined) : header;

    return value?.trim();
}

/** `tailscale whois`, remembered a minute per address, so a guesser cannot make the server run it for each try. */
const peers = new Map<string, { answer: Promise<TailscaleAnswer>; at: number }>();

function cachedPeer(address: string): Promise<TailscaleAnswer> {
    const now = Date.now();
    const known = peers.get(address);

    if (known !== undefined && now - known.at < 60_000) {
        return known.answer;
    }

    for (const [each, entry] of peers) {
        if (now - entry.at >= 60_000) {
            peers.delete(each);
        }
    }

    const answer = tailscalePeer(address);

    peers.set(address, { answer, at: now });

    return answer;
}

/**
 * The address a request came from, as said above. `accessMode`: how the server is reached (`AccessInfo.mode`). `peer`:
 * asks Tailscale about an address (tests give their own).
 */
export async function clientAddress(
    request: Pick<IncomingMessage, "headers"> & { socket: { remoteAddress?: string | undefined } },
    accessMode: string | undefined,
    peer: (address: string) => Promise<TailscaleAnswer> = cachedPeer,
): Promise<string> {
    const direct = bare(request.socket.remoteAddress ?? "unknown");

    if (!loopback(direct)) {
        return direct;
    }

    if (accessMode === "cloudflare") {
        const named = single(request.headers["cf-connecting-ip"]) ?? "";

        if (isIP(bare(named)) !== 0) {
            return bare(named);
        }
    }

    if (accessMode === "tailscale-serve") {
        const named = single(request.headers["x-forwarded-for"]) ?? "";

        if (isIP(bare(named)) !== 0 && (await peer(bare(named))) === "peer") {
            return bare(named);
        }
    }

    return direct;
}

const minutes = (ms: number) => Math.max(1, Math.ceil(ms / 60_000));

/** What a wrong code led to, for the log. */
export type WrongResult = { locked: boolean; banned: boolean; ceiling: boolean };

export class LinkLimits {
    readonly #now: () => number;
    readonly #store: LinkLimitStore;
    /** The times of recent wrong codes, by address. */
    readonly #wrong = new Map<string, number[]>();
    readonly #locked = new Map<string, number>();
    #all: number[] = [];
    #serverUntil = 0;

    constructor(now: () => number = Date.now, store: LinkLimitStore = memoryStore()) {
        this.#now = now;
        this.#store = store;
    }

    /** Refuse a redeem from `address` while it is banned or locked out, or linking is paused. */
    check(address: string): void {
        const now = this.#now();

        this.#prune(now);

        if (this.#saved(now).bans.some((ban) => ban.address === bare(address))) {
            throw new HttpError(403, WRONG_CODE);
        }

        if (this.#serverUntil > now) {
            throw new HttpError(
                429,
                `Too many wrong link codes reached this server, so linking is paused for ${minutes(this.#serverUntil - now)} min, and the open codes were voided. Get a new code in Menu → Runners after that.`,
            );
        }

        const until = this.#locked.get(bare(address));

        if (until !== undefined && until > now) {
            throw new HttpError(
                429,
                `Too many wrong link codes from this address. Try again in ${minutes(until - now)} min.`,
            );
        }
    }

    /** Count a wrong code from `address`. `ceiling`: it tripped the server's ceiling, so void every open code. */
    wrong(given: string): WrongResult {
        const address = bare(given);
        const now = this.#now();
        const result: WrongResult = { locked: false, banned: false, ceiling: false };

        this.#prune(now);

        const times = [...(this.#wrong.get(address) ?? []), now];

        this.#wrong.set(address, times);

        if (times.length >= ADDRESS_WRONG) {
            this.#wrong.delete(address);
            this.#locked.set(address, now + LOCK_MS);
            result.locked = true;

            if (!loopback(address)) {
                result.banned = this.#block(address, now);
            }
        }

        this.#all.push(now);

        if (this.#all.length >= SERVER_WRONG) {
            this.#serverUntil = now + LOCK_MS;
            this.#all = [];
            result.ceiling = true;
        }

        return result;
    }

    /** Lift `address`'s ban, its lockout, and its count toward a ban. False when it was neither banned nor counted. */
    lift(given: string): boolean {
        const address = bare(given);
        const now = this.#now();
        const saved = this.#saved(now);
        const next = {
            blocks: saved.blocks.filter((each) => each.address !== address),
            bans: saved.bans.filter((each) => each.address !== address),
        };
        const changed =
            next.blocks.length !== saved.blocks.length || next.bans.length !== saved.bans.length;

        this.#wrong.delete(address);
        this.#locked.delete(address);

        if (changed) {
            this.#store.write(next);
        }

        return changed;
    }

    /** The lockouts and bans now, for the Runners sheet. */
    locks(): LinkLocks {
        const now = this.#now();

        this.#prune(now);

        const saved = this.#saved(now);
        const blocks = new Map(saved.blocks.map((each) => [each.address, each.count]));

        return {
            ...(this.#serverUntil > now ? { server: this.#serverUntil } : {}),
            addresses: [...this.#locked].map(([address, until]) => ({
                address,
                until,
                blocks: blocks.get(address) ?? 1,
            })),
            bans: saved.bans,
        };
    }

    /** One more lockout for `address`; a ban at `BLOCKS_TO_BAN`. True when that banned it. */
    #block(address: string, now: number): boolean {
        const saved = this.#saved(now);
        const count = (saved.blocks.find((each) => each.address === address)?.count ?? 0) + 1;
        const others = saved.blocks.filter((each) => each.address !== address);

        if (count >= BLOCKS_TO_BAN) {
            this.#locked.delete(address);
            this.#store.write({
                blocks: others,
                bans: [
                    ...saved.bans.filter((each) => each.address !== address),
                    { address, since: now },
                ],
            });

            return true;
        }

        this.#store.write({ blocks: [...others, { address, count, last: now }], bans: saved.bans });

        return false;
    }

    /** What is saved, without lockout counts a week old. */
    #saved(now: number): StoredLinkLimits {
        const stored = this.#store.read();

        return {
            blocks: (stored?.blocks ?? []).filter((each) => now - each.last < BLOCK_MEMORY_MS),
            bans: stored?.bans ?? [],
        };
    }

    #prune(now: number): void {
        const since = now - WINDOW_MS;

        for (const [address, times] of this.#wrong) {
            const recent = times.filter((time) => time > since);

            if (recent.length === 0) {
                this.#wrong.delete(address);
            } else {
                this.#wrong.set(address, recent);
            }
        }

        for (const [address, until] of this.#locked) {
            if (until <= now) {
                this.#locked.delete(address);
            }
        }

        this.#all = this.#all.filter((time) => time > since);
    }
}
