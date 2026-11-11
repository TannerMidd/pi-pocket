/**
 * Public links: pages an extension module shows to anyone with the address (`/l/<token>`), with no sign-in. The module
 * makes a link with `web.links.create` and draws its page with `web.publicPage`; `http/link-routes.ts` serves it. The
 * token is the whole of the access, so every link closes at its time, can take a set number of answers, and can be
 * ended at once. A link belongs to its module: another module can neither see nor end it, and while its module is off
 * the address answers nothing.
 */
import { randomBytes } from "node:crypto";
import type { JsonValue } from "@earendil-works/chord/json";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { PocketApp } from "./app.ts";
import { type PublicLink, PublicLinksDoc } from "./docs.ts";
import { HttpError } from "./errors.ts";
import type { PublicLinkInfo, PublicLinkRequest } from "./host.ts";

/** The longest a link may stay open, in hours: 30 days. */
export const MAX_LINK_HOURS = 30 * 24;
/** The most links one module keeps open at once. */
export const MAX_LINKS = 200;
/** The most answers one link may take. */
export const MAX_USES = 1000;
/** The largest `data` a link keeps, as JSON. */
export const MAX_LINK_DATA = 4096;
/** How long a used-up link is kept, so a page that refuses its post can give the use back. */
const REFUND_MS = 10 * 60 * 1000;

/** A token: 16 random bytes, 32 characters of hex. Nothing else is one. */
export const TOKEN = /^[0-9a-f]{32}$/;

/** Whether a link answers no more: its time passed, or it took all its answers. */
function closed(link: PublicLink, now: number): boolean {
    return link.expiresAt <= now || link.uses === 0;
}

export class PublicLinks {
    readonly #app: PocketApp;

    constructor(app: PocketApp) {
        this.#app = app;
    }

    /** A link as its module sees it, with its address (the server's public one, when it knows it). */
    #info(token: string, link: PublicLink): PublicLinkInfo {
        const path = `/l/${token}`;
        const base = this.#app.access?.url;

        return {
            token,
            path,
            url: base === undefined ? null : `${base.replace(/\/$/, "")}${path}`,
            createdAt: link.createdAt,
            expiresAt: link.expiresAt,
            uses: link.uses ?? null,
            by: link.by ?? null,
            conversation: link.conversation ?? null,
            data: link.data === undefined ? null : structuredClone(link.data),
        };
    }

    /** Make a link for `module`, checked as a drop-in's call must be: what it asks for comes from module code. */
    async create(module: string, request: PublicLinkRequest): Promise<PublicLinkInfo> {
        const app = this.#app;
        const { hours, uses, by, conversation } = request ?? ({} as PublicLinkRequest);

        if (typeof hours !== "number" || !(hours > 0) || hours > MAX_LINK_HOURS) {
            throw new Error(`web.links.create: hours is more than 0 and ${MAX_LINK_HOURS} at most`);
        }

        if (
            uses !== undefined &&
            (!Number.isSafeInteger(uses) || (uses as number) < 1 || (uses as number) > MAX_USES)
        ) {
            throw new Error(`web.links.create: uses is a whole number from 1 to ${MAX_USES}`);
        }

        if (by !== undefined && (typeof by !== "string" || by === "" || by.length > 64)) {
            throw new Error("web.links.create: by is a person's id");
        }

        if (
            conversation !== undefined &&
            (!Number.isSafeInteger(conversation) || (conversation as number) < 1)
        ) {
            throw new Error("web.links.create: conversation is a session's id");
        }

        let data: JsonValue | undefined;

        if (request.data !== undefined) {
            const text = JSON.stringify(request.data);

            if (text === undefined || Buffer.byteLength(text) > MAX_LINK_DATA) {
                throw new Error(
                    `web.links.create: data is a JSON value of ${MAX_LINK_DATA} bytes at most`,
                );
            }

            data = JSON.parse(text) as JsonValue;
        }

        const now = app.now();
        const token = randomBytes(16).toString("hex");
        const link: PublicLink = {
            module,
            createdAt: now,
            expiresAt: now + Math.round(hours * 60 * 60 * 1000),
            ...(uses === undefined ? {} : { uses }),
            ...(by === undefined ? {} : { by }),
            ...(conversation === undefined ? {} : { conversation }),
            ...(data === undefined ? {} : { data }),
        };

        await app.harness.commit(async (tx) => {
            const doc = await tx.doc(PublicLinksDoc);

            // Links that closed answer nothing and are listed nowhere: they go, and count for nothing. One that took its
            // last use stays a while, in case its page refuses that post and gives the use back.
            for (const [old, each] of Object.entries(doc.items)) {
                if (
                    each.expiresAt <= now ||
                    (each.uses === 0 && (each.usedAt ?? 0) + REFUND_MS <= now)
                ) {
                    delete doc.items[old];
                }
            }

            const open = Object.values(doc.items).filter(
                (each) => each.module === module && !closed(each, now),
            );

            if (open.length >= MAX_LINKS) {
                throw new HttpError(409, `One module keeps ${MAX_LINKS} links open at most.`);
            }

            doc.items[token] = link;
        }, BACKGROUND_CONTEXT);

        return this.#info(token, link);
    }

    /** One of the module's links that is still open, or undefined. */
    async get(module: string, token: string): Promise<PublicLinkInfo | undefined> {
        const found = await this.#open(token);

        return found?.module === module ? this.#info(token, found) : undefined;
    }

    /** The module's open links, newest first. */
    async list(module: string): Promise<PublicLinkInfo[]> {
        const doc = await this.#app.harness.snapshot(PublicLinksDoc, BACKGROUND_CONTEXT);
        const now = this.#app.now();

        return Object.entries(doc?.items ?? {})
            .filter(([, link]) => link.module === module && !closed(link, now))
            .sort(([, a], [, b]) => b.createdAt - a.createdAt)
            .map(([token, link]) => this.#info(token, link));
    }

    /** End one of the module's links at once: its address answers nothing after. Whether there was one to end. */
    async end(module: string, token: string): Promise<boolean> {
        if (typeof token !== "string" || !TOKEN.test(token)) {
            return false;
        }

        return this.#app.harness.commit(async (tx) => {
            const doc = await tx.doc(PublicLinksDoc);

            if (!Object.hasOwn(doc.items, token) || doc.items[token]!.module !== module) {
                return false;
            }

            delete doc.items[token];

            return true;
        }, BACKGROUND_CONTEXT);
    }

    /** What an address names, for a request with no sign-in: undefined when it is not a link, or it closed. */
    async open(token: string): Promise<{ module: string; link: PublicLinkInfo } | undefined> {
        const link = await this.#open(token);

        return link === undefined
            ? undefined
            : { module: link.module, link: this.#info(token, link) };
    }

    async #open(token: string): Promise<PublicLink | undefined> {
        if (typeof token !== "string" || !TOKEN.test(token)) {
            return undefined;
        }

        const doc = await this.#app.harness.snapshot(PublicLinksDoc, BACKGROUND_CONTEXT);
        const link = Object.hasOwn(doc?.items ?? {}, token) ? doc!.items[token] : undefined;

        return link === undefined || closed(link, this.#app.now()) ? undefined : link;
    }

    /**
     * Count one answer to a link, before its module's page handler runs: the link as it leaves it, or undefined when it has closed, or took all it may
     * (two posts at once to a link for one answer: only one gets in). A link with no count of uses always lets one in.
     */
    async claim(token: string): Promise<PublicLinkInfo | undefined> {
        const now = this.#app.now();

        return this.#app.harness.commit(async (tx) => {
            const doc = await tx.doc(PublicLinksDoc);
            const link = Object.hasOwn(doc.items, token) ? doc.items[token] : undefined;

            if (link === undefined || closed(link, now)) {
                return undefined;
            }

            if (link.uses !== undefined) {
                link.uses -= 1;

                if (link.uses === 0) {
                    link.usedAt = now;
                }
            }

            // The link as this answer leaves it: its page sees the uses left after this one. A plain copy, since the
            // document's own object is the commit's, which a structured clone cannot take.
            return this.#info(token, JSON.parse(JSON.stringify(link)) as PublicLink);
        }, BACKGROUND_CONTEXT);
    }

    /** Give back an answer `claim` counted, when the page refused the post: the person can try again. */
    async refund(token: string): Promise<void> {
        await this.#app.harness.commit(async (tx) => {
            const doc = await tx.doc(PublicLinksDoc);
            const link = Object.hasOwn(doc.items, token) ? doc.items[token] : undefined;

            if (link?.uses !== undefined) {
                link.uses += 1;
                delete link.usedAt;
            }
        }, BACKGROUND_CONTEXT);
    }
}
