/**
 * The runner link's own security, on top of HTTPS: like SSH, each side holds a key, and every message between them is
 * encrypted and signed with keys only they hold. A server in the middle, even one with a valid certificate, can
 * neither read nor change what passes, nor pass itself off as the server this computer linked to.
 *
 * Keys. The server has one Ed25519 identity key, made once and kept in its data folder (`config.ts`
 * `serverIdentity`). Each runner makes its own Ed25519 key when it links, and keeps it in its link file. Each side keeps
 * the other's public key: the runner pins the server's, the server keeps each runner's (`StoredRunner.publicKey`).
 *
 * Linking. The one-time code never travels: the runner proves it knows it with an HMAC over its public key, keyed by
 * the code's SHA-256 (the hash the server keeps of it), and the server answers with an HMAC over both keys. Someone in
 * the middle who does not know the code can swap neither key. The key fingerprints (`fingerprint`) let a person check
 * by eye, as SSH's do.
 *
 * Each connection. Over the WebSocket, before anything else:
 *   1. runner → server  `{ type: "hs1", id, eph, nonce }`           its computer id, a new X25519 key, 32 random bytes
 *   2. server → runner  `{ type: "hs2", eph, nonce, sig }`          its new X25519 key, 32 random bytes, and its
 *                                                                    identity's signature of the transcript
 *   3. runner → server  `{ type: "hs3", sig }`                      the runner identity's signature of the transcript
 * The transcript is every value of steps 1 and 2 and both identity keys. HKDF-SHA256 makes one AES-256-GCM key for
 * each direction from the X25519 secret and the transcript. Every message after that is one binary WebSocket message:
 * the sealed `[kind byte][payload]`, its nonce the message's number in its direction, so a message dropped, replayed,
 * or moved breaks the link.
 */
import type { LookupFunction } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import {
    createCipheriv,
    createDecipheriv,
    createHash,
    createHmac,
    createPrivateKey,
    createPublicKey,
    diffieHellman,
    generateKeyPairSync,
    hkdfSync,
    randomBytes,
    sign,
    timingSafeEqual,
    verify,
    type KeyObject,
} from "node:crypto";
import { EventEmitter } from "node:events";
import type WebSocket from "ws";

/** The version of this handshake, in every transcript and HMAC. */
const VERSION = "pi-pocket-link-2";

/** How long the handshake may take before the link is dropped. */
export const HANDSHAKE_MS = 15_000;
/** WebSocket close code: the other side did not prove its key. The runner stops; the server just drops it. */
export const CLOSE_IDENTITY = 4003;

/** Ready states, as the `ws` package numbers them. */
const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;

/** A side's long-lived key: its public half (raw, base64url) and its private half (PKCS#8 DER, base64url). */
export type Identity = { publicKey: string; privateKey: string };

/** A new Ed25519 key. */
export function newIdentity(): Identity {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");

    return {
        publicKey: rawPublic(publicKey),
        privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url"),
    };
}

/** A public key in a form a person can compare by eye, as SSH shows them: `SHA256:` and the hash's start. */
export function fingerprint(publicKey: string): string {
    return `SHA256:${createHash("sha256").update(Buffer.from(publicKey, "base64url")).digest("base64").replace(/=+$/, "")}`;
}

/** Whether `value` is a raw Ed25519 public key, base64url: 32 bytes. */
export function isPublicKey(value: unknown): value is string {
    return (
        typeof value === "string" &&
        /^[A-Za-z0-9_-]{43}$/.test(value) &&
        Buffer.from(value, "base64url").length === 32
    );
}

function rawPublic(key: KeyObject): string {
    const jwk = key.export({ format: "jwk" });

    return String(jwk.x);
}

function publicKeyOf(raw: string, curve: "Ed25519" | "X25519"): KeyObject {
    return createPublicKey({ key: { kty: "OKP", crv: curve, x: raw }, format: "jwk" });
}

function privateKeyOf(identity: Identity): KeyObject {
    return createPrivateKey({
        key: Buffer.from(identity.privateKey, "base64url"),
        format: "der",
        type: "pkcs8",
    });
}

/** The SHA-256 of a link code as people type it, hex: the key of its HMACs, and what the server keeps of it. */
export function codeHash(code: string): string {
    return createHash("sha256").update(code.trim().toUpperCase()).digest("hex");
}

function hmac(hash: string, ...parts: string[]): string {
    return createHmac("sha256", Buffer.from(hash, "hex"))
        .update([VERSION, ...parts].join("\0"))
        .digest("base64url");
}

function same(a: string, b: string): boolean {
    const left = Buffer.from(a);
    const right = Buffer.from(b);

    return left.length === right.length && timingSafeEqual(left, right);
}

/** What a runner sends to link, instead of the code: its public key, and proof that it knows the code. */
export type LinkRequest = { runnerKey: string; proof: string };
/** What the server answers: the computer, the server's public key, and proof that it knows the code too. */
export type LinkAnswer = { id: string; name: string; serverKey: string; proof: string };

/** The runner's side of linking: what to send for `code`, and the check of the server's answer. */
export function linkRequest(code: string, runnerKey: string): LinkRequest {
    return { runnerKey, proof: hmac(codeHash(code), "request", runnerKey) };
}

/** Whether the server's answer proves it knows `code`, and keeps both keys as they were sent. */
export function checkLinkAnswer(code: string, runnerKey: string, answer: LinkAnswer): boolean {
    return same(
        answer.proof,
        hmac(codeHash(code), "answer", runnerKey, answer.serverKey, answer.id, answer.name),
    );
}

/** The server's side: whether `request` proves knowledge of the code kept as `hash`. */
export function checkLinkRequest(hash: string, request: LinkRequest): boolean {
    return same(request.proof, hmac(hash, "request", request.runnerKey));
}

/** The server's proof for its answer, with the code kept as `hash`. */
export function linkAnswerProof(
    hash: string,
    runnerKey: string,
    answer: Omit<LinkAnswer, "proof">,
): string {
    return hmac(hash, "answer", runnerKey, answer.serverKey, answer.id, answer.name);
}

/** What linking gives a computer: its id and name, its own private key, and the server's pinned public key. */
export type Linked = { id: string; name: string; key: string; serverKey: string };

/**
 * Link with a one-time code: make this computer's key, prove the code to the server at `linkUrl`, and check the
 * server's proof. Throws an `Error` whose message says what went wrong, for a person.
 */
export async function linkWithCode(
    linkUrl: string,
    code: string,
    lookup?: LookupFunction,
): Promise<Linked> {
    const identity = newIdentity();
    const request = linkRequest(code, identity.publicKey);
    // Over plain HTTP to this computer or a tailnet device: only to the addresses checked (`pinnedLookup`).
    const dispatcher = lookup === undefined ? undefined : new Agent({ connect: { lookup } });
    let response: Response;

    try {
        response = (await undiciFetch(linkUrl, {
            method: "POST",
            headers: { "content-type": "application/json", "x-pocket": "1" },
            body: JSON.stringify(request),
            signal: AbortSignal.timeout(15_000),
            ...(dispatcher === undefined ? {} : { dispatcher }),
        })) as unknown as Response;
    } catch (error) {
        throw new LinkProblem("unreachable", (error as Error).message);
    }

    const body = await response.text();

    if (!response.ok) {
        let message = body;

        try {
            message = (JSON.parse(body) as { error?: string }).error ?? body;
        } catch {
            // As it is.
        }

        throw new LinkProblem("refused", message || response.statusText);
    }

    let answer: Partial<LinkAnswer> = {};

    try {
        answer = JSON.parse(body) as Partial<LinkAnswer>;
    } catch {
        // Below.
    }

    if (
        typeof answer.id !== "string" ||
        typeof answer.name !== "string" ||
        !isPublicKey(answer.serverKey) ||
        typeof answer.proof !== "string"
    ) {
        throw new LinkProblem("invalid", "");
    }

    if (!checkLinkAnswer(code, identity.publicKey, answer as LinkAnswer)) {
        throw new LinkProblem("unproven", "");
    }

    return {
        id: answer.id,
        name: answer.name,
        key: identity.privateKey,
        serverKey: answer.serverKey,
    };
}

/**
 * Link in one process, as `linkWithCode` does over HTTP: for tests and anything that holds the server's `redeem`. It
 * checks the server's proof as a runner would.
 */
export function linkInProcess(redeem: (request: LinkRequest) => LinkAnswer, code: string): Linked {
    const identity = newIdentity();
    const answer = redeem(linkRequest(code, identity.publicKey));

    if (!checkLinkAnswer(code, identity.publicKey, answer)) {
        throw new LinkProblem("unproven", "");
    }

    return {
        id: answer.id,
        name: answer.name,
        key: identity.privateKey,
        serverKey: answer.serverKey,
    };
}

/** Why linking failed: the server was not reached, refused the code, answered nonsense, or did not prove the code. */
export class LinkProblem extends Error {
    readonly kind: "unreachable" | "refused" | "invalid" | "unproven";

    constructor(kind: LinkProblem["kind"], detail: string) {
        super(detail);
        this.kind = kind;
    }
}

/** The public half of a private key kept in a link file. */
export function publicOf(privateKey: string): string {
    return rawPublic(createPublicKey(privateKeyOf({ publicKey: "", privateKey })));
}

/** One direction's cipher: AES-256-GCM, its nonce the message's number. */
class Seal {
    readonly #key: Buffer;
    #count = 0n;

    constructor(key: Buffer) {
        this.#key = key;
    }

    #nonce(): Buffer {
        const nonce = Buffer.alloc(12);

        nonce.writeBigUInt64BE(this.#count++, 4);

        return nonce;
    }

    seal(plain: Buffer): Buffer {
        const cipher = createCipheriv("aes-256-gcm", this.#key, this.#nonce());
        const body = Buffer.concat([cipher.update(plain), cipher.final()]);

        return Buffer.concat([body, cipher.getAuthTag()]);
    }

    /** The plain message, or undefined when it was changed, replayed, or is out of order. */
    open(sealed: Buffer): Buffer | undefined {
        if (sealed.length < 16) {
            return undefined;
        }

        try {
            const decipher = createDecipheriv("aes-256-gcm", this.#key, this.#nonce());

            decipher.setAuthTag(sealed.subarray(sealed.length - 16));

            return Buffer.concat([
                decipher.update(sealed.subarray(0, sealed.length - 16)),
                decipher.final(),
            ]);
        } catch {
            return undefined;
        }
    }
}

function keys(
    shared: Buffer,
    transcript: string,
    side: "runner" | "server",
): { send: Seal; receive: Seal } {
    const salt = createHash("sha256").update(transcript).digest();
    const toServer = Buffer.from(
        hkdfSync("sha256", shared, salt, `${VERSION} runner to server`, 32),
    );
    const toRunner = Buffer.from(
        hkdfSync("sha256", shared, salt, `${VERSION} server to runner`, 32),
    );

    return side === "runner"
        ? { send: new Seal(toServer), receive: new Seal(toRunner) }
        : { send: new Seal(toRunner), receive: new Seal(toServer) };
}

function transcript(parts: {
    id: string;
    runnerEph: string;
    runnerNonce: string;
    serverEph: string;
    serverNonce: string;
    serverKey: string;
    runnerKey: string;
}): string {
    return [
        VERSION,
        parts.id,
        parts.runnerEph,
        parts.runnerNonce,
        parts.serverEph,
        parts.serverNonce,
        parts.serverKey,
        parts.runnerKey,
    ].join("\0");
}

function newEphemeral(): { publicKey: string; privateKey: KeyObject } {
    const pair = generateKeyPairSync("x25519");

    return { publicKey: rawPublic(pair.publicKey), privateKey: pair.privateKey };
}

function parse(data: WebSocket.RawData, binary: boolean): Record<string, unknown> | undefined {
    if (binary) {
        return undefined;
    }

    try {
        const value = JSON.parse(toBuffer(data).toString("utf8")) as unknown;

        return typeof value === "object" && value !== null
            ? (value as Record<string, unknown>)
            : undefined;
    } catch {
        return undefined;
    }
}

function toBuffer(data: WebSocket.RawData): Buffer {
    return Buffer.isBuffer(data)
        ? data
        : Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.from(data);
}

function text(value: unknown): value is string {
    return typeof value === "string" && value.length > 0 && value.length < 200;
}

/** Kinds of message inside the link, as the first byte of each sealed one. */
const TEXT = 0;
const BINARY = 1;

/**
 * A WebSocket whose messages are sealed with the link's keys, used as a `ws` WebSocket is: `send`, and `message`
 * events of `(data, isBinary)`. It says `open` when the handshake is done, and is `OPEN` from then.
 */
export class LinkSocket extends EventEmitter {
    readonly OPEN = OPEN;
    readonly #ws: WebSocket;
    #send: Seal | undefined;
    #receive: Seal | undefined;
    #failed = false;

    constructor(ws: WebSocket) {
        super();
        this.#ws = ws;
        ws.on("close", (code, reason) => this.emit("close", code, reason));
        ws.on("error", (error) => this.emit("error", error));
        ws.on("pong", () => this.emit("pong"));
        ws.on("unexpected-response", (request, response) =>
            this.emit("unexpected-response", request, response),
        );
    }

    /** The state of the link: `CONNECTING` until the handshake is done. */
    get readyState(): number {
        if (this.#ws.readyState === OPEN) {
            return this.#send === undefined ? CONNECTING : OPEN;
        }

        return this.#ws.readyState;
    }

    /** Begin sealing: called once, by the handshake. */
    protected start(keys: { send: Seal; receive: Seal }): void {
        this.#send = keys.send;
        this.#receive = keys.receive;
        this.#ws.on("message", (data, binary) => {
            if (!binary) {
                this.fail("A message was not sealed");

                return;
            }

            const plain = this.#receive!.open(toBuffer(data));

            if (plain === undefined || plain.length === 0) {
                this.fail("A message was changed, replayed, or out of order");

                return;
            }

            const kind = plain[0];

            if (kind !== TEXT && kind !== BINARY) {
                this.fail("A message of no known kind");

                return;
            }

            this.emit("message", plain.subarray(1), kind === BINARY);
        });
        this.emit("open");
    }

    /** The socket under the link, for the handshake alone. */
    protected get raw(): WebSocket {
        return this.#ws;
    }

    /** Close as a broken link: no message after this one counts. */
    protected fail(reason: string, code = 1002): void {
        if (this.#failed) {
            return;
        }

        this.#failed = true;
        this.#ws.close(code, reason);
    }

    send(data: string | Buffer, done?: (error?: Error) => void): void {
        if (this.#send === undefined || this.#ws.readyState !== OPEN) {
            done?.(new Error("The link is not open"));

            return;
        }

        const binary = typeof data !== "string";
        const body = binary ? data : Buffer.from(data, "utf8");
        const plain = Buffer.allocUnsafe(body.length + 1);

        plain[0] = binary ? BINARY : TEXT;
        body.copy(plain, 1);
        this.#ws.send(this.#send.seal(plain), { binary: true }, done);
    }

    ping(): void {
        this.#ws.ping();
    }

    close(code?: number, reason?: string): void {
        this.#ws.close(code, reason);
    }

    terminate(): void {
        this.#ws.terminate();
    }

    /** Whether the socket under it is closed: for checks that the link is gone. */
    get closed(): boolean {
        return this.#ws.readyState === CLOSED;
    }
}

/** The runner's end: proves its key, and checks the server's against the pinned one. */
export class RunnerLinkSocket extends LinkSocket {
    constructor(
        ws: WebSocket,
        link: { id: string; key: string; serverKey: string },
        onIdentity: () => void,
    ) {
        super(ws);

        const identity = (() => {
            try {
                const privateKey = privateKeyOf({ publicKey: "", privateKey: link.key });

                return { privateKey, publicKey: rawPublic(createPublicKey(privateKey)) };
            } catch {
                return undefined;
            }
        })();
        const eph = newEphemeral();
        const nonce = randomBytes(32).toString("base64url");
        const timer = setTimeout(() => this.fail("No handshake"), HANDSHAKE_MS);

        ws.once("open", () => {
            if (identity === undefined) {
                this.fail("This computer's key is not valid");

                return;
            }

            ws.send(JSON.stringify({ type: "hs1", id: link.id, eph: eph.publicKey, nonce }));
        });
        ws.once("close", () => clearTimeout(timer));
        ws.once("message", (data, binary) => {
            const answer = parse(data, binary);

            if (
                identity === undefined ||
                answer?.type !== "hs2" ||
                !text(answer.eph) ||
                !text(answer.nonce) ||
                !text(answer.sig)
            ) {
                clearTimeout(timer);
                this.fail("The server did not answer the handshake");

                return;
            }

            const said = transcript({
                id: link.id,
                runnerEph: eph.publicKey,
                runnerNonce: nonce,
                serverEph: answer.eph,
                serverNonce: answer.nonce,
                serverKey: link.serverKey,
                runnerKey: identity.publicKey,
            });
            let proven = false;
            let shared: Buffer | undefined;

            try {
                proven = verify(
                    null,
                    Buffer.from(said),
                    publicKeyOf(link.serverKey, "Ed25519"),
                    Buffer.from(answer.sig, "base64url"),
                );
                shared = diffieHellman({
                    privateKey: eph.privateKey,
                    publicKey: publicKeyOf(answer.eph, "X25519"),
                });
            } catch {
                proven = false;
            }

            clearTimeout(timer);

            if (!proven || shared === undefined) {
                onIdentity();
                this.fail("The server did not prove its key", CLOSE_IDENTITY);

                return;
            }

            ws.send(
                JSON.stringify({
                    type: "hs3",
                    sig: sign(null, Buffer.from(`${said}\0runner`), identity.privateKey).toString(
                        "base64url",
                    ),
                }),
            );
            this.start(keys(shared, said, "runner"));
        });
    }
}

/**
 * Open a link to `url` as a runner would, for tests that speak the protocol by hand: resolves once the handshake is
 * done, with a socket that sends and receives plain messages.
 */
export function openLink(
    url: string,
    protocol: string,
    link: { id: string; key: string; serverKey: string },
): Promise<LinkSocket> {
    // `ws` is a dependency of the runner anyway; loaded here so this module stays light for the server's import.
    return import("ws").then(
        ({ WebSocket: Raw }) =>
            new Promise((resolve, reject) => {
                const socket = new RunnerLinkSocket(new Raw(url, protocol), link, () => {});

                socket.once("open", () => resolve(socket));
                socket.once("close", (code: number, reason: Buffer) =>
                    reject(new Error(`Closed ${code}: ${reason.toString()}`)),
                );
                socket.on("error", () => {});
            }),
    );
}

/** What the server knows to check a runner's handshake: its identity, and a runner's public key by computer id. */
export type ServerHandshake = {
    identity: Identity;
    runnerKey: (id: string) => string | undefined;
    /** No computer with this id (removed): the runner is told so, and stops. */
    unknown: number;
};

/**
 * The server's end. It says `ready` with the computer's id once the runner proved its key, then `open`; a runner that
 * does not prove it is dropped.
 */
export class ServerLinkSocket extends LinkSocket {
    /** The computer this link is from, once proven. */
    id: string | undefined;
    /**
     * The public key it proved, once proven. The key is read when the handshake starts, so the computer can be linked
     * again, with a new key, before the link is used: who takes the link compares this with the key kept now.
     */
    key: string | undefined;

    constructor(ws: WebSocket, handshake: ServerHandshake) {
        super(ws);

        const identity = privateKeyOf(handshake.identity);
        const timer = setTimeout(() => this.fail("No handshake"), HANDSHAKE_MS);

        ws.once("close", () => clearTimeout(timer));
        ws.once("message", (data, binary) => {
            const hello = parse(data, binary);

            if (
                hello?.type !== "hs1" ||
                !text(hello.id) ||
                !text(hello.eph) ||
                !text(hello.nonce)
            ) {
                clearTimeout(timer);
                this.fail("Start with the handshake");

                return;
            }

            const runnerKey = handshake.runnerKey(hello.id);

            if (runnerKey === undefined) {
                clearTimeout(timer);
                this.fail("Removed", handshake.unknown);

                return;
            }

            const eph = newEphemeral();
            const nonce = randomBytes(32).toString("base64url");
            const said = transcript({
                id: hello.id,
                runnerEph: hello.eph,
                runnerNonce: hello.nonce,
                serverEph: eph.publicKey,
                serverNonce: nonce,
                serverKey: handshake.identity.publicKey,
                runnerKey,
            });
            let shared: Buffer;

            try {
                shared = diffieHellman({
                    privateKey: eph.privateKey,
                    publicKey: publicKeyOf(hello.eph, "X25519"),
                });
            } catch {
                clearTimeout(timer);
                this.fail("Start with the handshake");

                return;
            }

            this.raw.send(
                JSON.stringify({
                    type: "hs2",
                    eph: eph.publicKey,
                    nonce,
                    sig: sign(null, Buffer.from(said), identity).toString("base64url"),
                }),
            );
            this.raw.once("message", (proof, proofBinary) => {
                const answer = parse(proof, proofBinary);
                let proven = false;

                clearTimeout(timer);

                try {
                    proven =
                        answer?.type === "hs3" &&
                        text(answer.sig) &&
                        verify(
                            null,
                            Buffer.from(`${said}\0runner`),
                            publicKeyOf(runnerKey, "Ed25519"),
                            Buffer.from(answer.sig, "base64url"),
                        );
                } catch {
                    proven = false;
                }

                if (!proven) {
                    this.fail("This computer did not prove its key", CLOSE_IDENTITY);

                    return;
                }

                this.id = hello.id as string;
                this.key = runnerKey;
                this.start(keys(shared, said, "server"));
            });
        });
    }
}
