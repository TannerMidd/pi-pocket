import assert from "node:assert/strict";
import { createDecipheriv, createECDH, createHmac, createPublicKey, randomBytes, verify } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	DEFAULT_PREFS,
	encryptPayload,
	generateVapidKeys,
	PushStore,
	sendPush,
	vapidAuthorization,
	type PushKeys,
} from "../src/server/push.ts";

// RFC 8291 Section 5 and Appendix A.
const RFC = {
	plaintext: "When I grow up, I want to be a watermelon",
	asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
	asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
	uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
	uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
	salt: "DGv6ra1nlYgDCS1FRnbzlw",
	auth: "BTBZMqHH6r4Tts7J_aSIgg",
	output:
		"DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml" +
		"mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT" +
		"pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

const b64 = (value: string) => Buffer.from(value, "base64url");
const hmac = (key: Buffer, ...data: Buffer[]) => {
	const mac = createHmac("sha256", key);
	for (const part of data) mac.update(part);
	return mac.digest();
};

/** The receiving (browser) side of RFC 8291 for a single record. */
function decrypt(body: Buffer, uaPrivate: Buffer, auth: Buffer): Buffer {
	const salt = body.subarray(0, 16);
	const idlen = body.readUInt8(20);
	const asPublic = body.subarray(21, 21 + idlen);
	const record = body.subarray(21 + idlen);
	const ecdh = createECDH("prime256v1");
	ecdh.setPrivateKey(uaPrivate);
	const uaPublic = ecdh.getPublicKey();
	const prkKey = hmac(auth, ecdh.computeSecret(asPublic));
	const ikm = hmac(prkKey, Buffer.from("WebPush: info\0"), uaPublic, asPublic, Buffer.from([1]));
	const prk = hmac(salt, ikm);
	const cek = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16);
	const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12);
	const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
	decipher.setAuthTag(record.subarray(record.length - 16));
	const padded = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()]);
	let end = padded.length - 1;
	while (end >= 0 && padded[end] === 0) end--;
	assert.equal(padded[end], 2, "last record ends with the 0x02 delimiter");
	return padded.subarray(0, end);
}

function browser(): { keys: PushKeys; privateKey: Buffer } {
	const ecdh = createECDH("prime256v1");
	ecdh.generateKeys();
	return {
		keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") },
		privateKey: ecdh.getPrivateKey(),
	};
}

test("encryptPayload matches the RFC 8291 example byte for byte", () => {
	const body = encryptPayload(
		RFC.plaintext,
		{ p256dh: RFC.uaPublic, auth: RFC.auth },
		{ salt: b64(RFC.salt), serverKeys: { publicKey: b64(RFC.asPublic), privateKey: b64(RFC.asPrivate) }, recordSize: 4096 },
	);
	assert.equal(body.toString("base64url"), RFC.output);
	// 86-byte header + 41 + 1 + 16 (the RFC's "Content-Length: 145" is off by one; its bytes are 144).
	assert.equal(body.length, 144);
	// The receiver side in this test decrypts the RFC example too.
	assert.equal(decrypt(b64(RFC.output), b64(RFC.uaPrivate), b64(RFC.auth)).toString(), RFC.plaintext);
});

test("encryptPayload round-trips through the browser side and rejects oversize payloads", () => {
	const ua = browser();
	const message = JSON.stringify({ title: "Done", body: "ünïcödé ✓", url: "/c/1" });
	const body = encryptPayload(message, ua.keys);
	assert.equal(body.readUInt32BE(16), 4096);
	assert.equal(body.readUInt8(20), 65);
	assert.equal(decrypt(body, ua.privateKey, b64(ua.keys.auth)).toString("utf8"), message);
	assert.throws(() => encryptPayload(Buffer.alloc(4080), ua.keys), /too large/);
	assert.doesNotThrow(() => encryptPayload(Buffer.alloc(4079), ua.keys));
});

test("vapidAuthorization signs a valid ES256 JWT for the endpoint origin", () => {
	const vapid = generateVapidKeys();
	assert.equal(b64(vapid.publicKey).length, 65);
	assert.equal(b64(vapid.privateKey).length, 32);
	const now = Date.now();
	const header = vapidAuthorization("https://push.example.net/push/abc?x=1", vapid, "mailto:me@example.com", now);
	const match = /^vapid t=([^,]+), k=(.+)$/.exec(header);
	assert.ok(match);
	const [, jwt = "", k] = match;
	assert.equal(k, vapid.publicKey);
	const [h = "", p = "", s = ""] = jwt.split(".");
	assert.deepEqual(JSON.parse(b64(h).toString()), { typ: "JWT", alg: "ES256" });
	const claims = JSON.parse(b64(p).toString()) as { aud: string; exp: number; sub: string };
	assert.equal(claims.aud, "https://push.example.net");
	assert.equal(claims.sub, "mailto:me@example.com");
	assert.ok(claims.exp > now / 1000);
	assert.ok(claims.exp <= now / 1000 + 24 * 60 * 60);
	const point = b64(vapid.publicKey);
	const key = createPublicKey({
		key: {
			kty: "EC",
			crv: "P-256",
			x: point.subarray(1, 33).toString("base64url"),
			y: point.subarray(33).toString("base64url"),
		},
		format: "jwk",
	});
	const signature = b64(s);
	assert.equal(signature.length, 64);
	assert.ok(verify("sha256", Buffer.from(`${h}.${p}`), { key, dsaEncoding: "ieee-p1363" }, signature));
});

test("sendPush posts an encrypted body with the right headers", async () => {
	const ua = browser();
	const vapid = generateVapidKeys();
	let seen: { url: string; init: RequestInit } | undefined;
	const stub = (async (url: string, init: RequestInit) => {
		seen = { url, init };
		return new Response(null, { status: 201 });
	}) as unknown as typeof fetch;
	const message = { title: "Hi", body: "x".repeat(5000), url: "/c/2", tag: "conversation:2/done" };
	const status = await sendPush({ endpoint: "https://push.example.net/p/1", keys: ua.keys }, message, vapid, {
		fetch: stub,
		urgency: "high",
		ttl: 60,
	});
	assert.equal(status, 201);
	assert.ok(seen);
	assert.equal(seen.url, "https://push.example.net/p/1");
	const headers = seen.init.headers as Record<string, string>;
	assert.equal(headers["Content-Encoding"], "aes128gcm");
	assert.equal(headers["Content-Type"], "application/octet-stream");
	assert.equal(headers.TTL, "60");
	assert.equal(headers.Urgency, "high");
	assert.match(headers.Topic ?? "", /^[A-Za-z0-9_-]{1,32}$/);
	assert.match(headers.Authorization ?? "", /^vapid t=.+, k=/);
	const plain = decrypt(Buffer.from(seen.init.body as Uint8Array), ua.privateKey, b64(ua.keys.auth));
	const payload = JSON.parse(plain.toString()) as {
		body: string;
		tag: string;
	};
	assert.ok(payload.body.length <= 1000);
	assert.equal(payload.tag, "conversation:2/done");
});

test("PushStore persists, validates, prefs merge, and notify drops gone subscriptions", async (t) => {
	const directory = mkdtempSync(join(tmpdir(), "pp-push-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const store = new PushStore(directory);
	const file = join(directory, "push.json");
	assert.equal(statSync(file).mode & 0o777, 0o600);

	const a = browser();
	const b = browser();
	store.subscribe("u1", { endpoint: "https://push.example.net/a", keys: a.keys }, "Firefox");
	store.subscribe("u1", { endpoint: "https://push.example.net/b", keys: b.keys });
	assert.equal(statSync(file).mode & 0o777, 0o600);

	const reopened = new PushStore(directory);
	assert.deepEqual(reopened.vapid, store.vapid);
	assert.equal(reopened.publicKey, store.publicKey);
	assert.deepEqual(reopened.subscriptions("u1"), store.subscriptions("u1"));
	assert.equal(reopened.subscriptions("u1").length, 2);
	assert.equal(reopened.subscriptions("u1")[0]?.userAgent, "Firefox");

	// Validation.
	const bad = (endpoint: string, keys: PushKeys) => () => reopened.subscribe("u1", { endpoint, keys });
	assert.throws(bad("http://push.example.net/x", a.keys), /https/);
	assert.throws(bad("not a url", a.keys), /valid URL/);
	const randomKey = randomBytes(65).toString("base64url");
	const shortAuth = randomBytes(8).toString("base64url");
	assert.throws(bad("https://push.example.net/x", { p256dh: randomKey, auth: a.keys.auth }), /p256dh/);
	assert.throws(bad("https://push.example.net/x", { p256dh: a.keys.p256dh, auth: shortAuth }), /auth/);
	assert.equal(reopened.subscriptions().length, 2);

	// Same endpoint moves to another user; unsubscribe respects ownership.
	reopened.subscribe("u2", { endpoint: "https://push.example.net/b", keys: b.keys });
	assert.equal(reopened.subscriptions("u1").length, 1);
	assert.equal(reopened.subscriptions("u2").length, 1);
	assert.equal(reopened.unsubscribe("https://push.example.net/b", "u1"), false);
	assert.equal(reopened.unsubscribe("https://push.example.net/b", "u2"), true);
	reopened.subscribe("u1", { endpoint: "https://push.example.net/b", keys: b.keys });

	// Prefs.
	assert.deepEqual(reopened.prefs("u1"), DEFAULT_PREFS);
	assert.deepEqual(reopened.setPrefs("u1", { chat: false }), { ...DEFAULT_PREFS, chat: false });
	assert.deepEqual(new PushStore(directory).prefs("u1"), { done: true, approval: true, chat: false, mention: true });

	// notify: /a is gone (410), /b accepts (201), and a throwing fetch never escapes.
	const calls: string[] = [];
	const stub = (async (url: string) => {
		calls.push(url);
		return new Response(null, { status: url.endsWith("/a") ? 410 : 201 });
	}) as unknown as typeof fetch;
	const accepted = await reopened.notify("u1", { title: "Done", body: "Finished", url: "/c/1", tag: "c1" }, { fetch: stub });
	assert.equal(accepted, 1);
	assert.deepEqual(calls.sort(), ["https://push.example.net/a", "https://push.example.net/b"]);
	assert.deepEqual(
		new PushStore(directory).subscriptions("u1").map((sub) => sub.endpoint),
		["https://push.example.net/b"],
	);
	const failing = (async () => {
		throw new Error("network down");
	}) as unknown as typeof fetch;
	assert.equal(await reopened.notify("u1", { title: "x", body: "y", url: "/" }, { fetch: failing }), 0);
	assert.equal(reopened.subscriptions("u1").length, 1);

	// removeUser drops subscriptions and prefs.
	reopened.removeUser("u1");
	assert.equal(reopened.subscriptions("u1").length, 0);
	assert.deepEqual(reopened.prefs("u1"), DEFAULT_PREFS);
	assert.equal(JSON.parse(readFileSync(file, "utf8")).prefs.u1, undefined);
});
