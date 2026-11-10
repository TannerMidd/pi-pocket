/** Authenticator codes stay on this computer. No secret or replay state goes to the server. */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export const STEP_MS = 30_000;
const WINDOW_MS = 10 * 60_000;

export function base32(bytes: Uint8Array): string {
    let bits = 0;
    let value = 0;
    let result = "";

    for (const byte of bytes) {
        value = (value << 8) | byte;
        bits += 8;

        while (bits >= 5) {
            bits -= 5;
            result += ALPHABET[(value >>> bits) & 31];
        }
    }

    if (bits > 0) {
        result += ALPHABET[(value << (5 - bits)) & 31];
    }

    return result;
}

export function unbase32(text: string): Buffer {
    const clean = text.toUpperCase().replace(/=+$/, "");
    let bits = 0;
    let value = 0;
    const bytes: number[] = [];

    if (!/^[A-Z2-7]+$/.test(clean) || ![0, 2, 4, 5, 7].includes(clean.length % 8)) {
        throw new Error("Invalid Base32 secret");
    }

    for (const char of clean) {
        value = (value << 5) | ALPHABET.indexOf(char);
        bits += 5;

        if (bits >= 8) {
            bits -= 8;
            bytes.push((value >>> bits) & 255);
        }
    }

    if ((value & ((1 << bits) - 1)) !== 0) {
        throw new Error("Invalid Base32 padding");
    }

    return Buffer.from(bytes);
}

export function newSecret(): string {
    return base32(randomBytes(20));
}

export function totp(secret: string, step: number): string {
    const counter = Buffer.alloc(8);

    counter.writeBigUInt64BE(BigInt(step));
    const digest = createHmac("sha1", unbase32(secret)).update(counter).digest();
    const offset = digest[digest.length - 1]! & 15;

    return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

export type TotpState = {
    secret: string;
    /** Highest accepted counter: replay, including an older code in the drift window, cannot succeed. */
    lastStep?: number;
    failures?: number[];
    lockedUntil?: number;
};

/** Mutates the caller's local state, which must be saved even for a wrong code. */
export function checkCode(state: TotpState, code: string, now = Date.now()): boolean {
    if ((state.lockedUntil ?? 0) > now) {
        return false;
    }

    const step = Math.floor(now / STEP_MS);
    const supplied = Buffer.from(code, "utf8");
    let accepted = -1;

    for (const candidate of [step - 1, step, step + 1]) {
        const expected = Buffer.from(totp(state.secret, Math.max(0, candidate)), "utf8");

        if (
            candidate > (state.lastStep ?? -1) &&
            supplied.length === expected.length &&
            timingSafeEqual(supplied, expected)
        ) {
            accepted = candidate;
        }
    }

    state.failures = (state.failures ?? []).filter((at) => at > now - WINDOW_MS);

    if (accepted >= 0) {
        state.lastStep = accepted;
        state.failures = [];
        delete state.lockedUntil;

        return true;
    }

    state.failures.push(now);

    if (state.failures.length >= 5) {
        state.lockedUntil = now + WINDOW_MS;
        state.failures = [];
    }

    return false;
}

export function authenticatorLink(secret: string, computer: string): string {
    return `otpauth://totp/Pi%20Pocket:${encodeURIComponent(computer)}?secret=${secret}&issuer=Pi%20Pocket`;
}
