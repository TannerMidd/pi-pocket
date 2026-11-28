import assert from "node:assert/strict";
import {
    createDecipheriv,
    createECDH,
    createHmac,
    createPublicKey,
    randomBytes,
    verify,
} from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { runInNewContext } from "node:vm";
import { Auth } from "../src/server/auth.ts";
import { ConfigStore } from "../src/server/config.ts";
import { Readable } from "node:stream";
import { test } from "node:test";
import {
    encryptPayload,
    generateVapidKeys,
    PushStore,
    sendPush,
    vapidAuthorization,
    type PushKeys,
} from "../src/server/push.ts";
import { createApi } from "../src/server/http/api.ts";
import { login } from "../src/server/http/sign-in.ts";
import { pushRoutes } from "../src/server/http/push-routes.ts";

// RFC 8291 Section 5 and Appendix A.
const RFC = {
    plaintext: "When I grow up, I want to be a watermelon",
    asPublic:
        "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
    asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
    uaPublic:
        "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
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

    for (const part of data) {
        mac.update(part);
    }

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
    const padded = Buffer.concat([
        decipher.update(record.subarray(0, record.length - 16)),
        decipher.final(),
    ]);
    let end = padded.length - 1;

    while (end >= 0 && padded[end] === 0) {
        end--;
    }

    assert.equal(padded[end], 2, "last record ends with the 0x02 delimiter");

    return padded.subarray(0, end);
}

function browser(): { keys: PushKeys; privateKey: Buffer } {
    const ecdh = createECDH("prime256v1");

    ecdh.generateKeys();

    return {
        keys: {
            p256dh: ecdh.getPublicKey().toString("base64url"),
            auth: randomBytes(16).toString("base64url"),
        },
        privateKey: ecdh.getPrivateKey(),
    };
}

test("encryptPayload matches the RFC 8291 example byte for byte", () => {
    const body = encryptPayload(
        RFC.plaintext,
        { p256dh: RFC.uaPublic, auth: RFC.auth },
        {
            salt: b64(RFC.salt),
            serverKeys: { publicKey: b64(RFC.asPublic), privateKey: b64(RFC.asPrivate) },
            recordSize: 4096,
        },
    );

    assert.equal(body.toString("base64url"), RFC.output);
    // 86-byte header + 41 + 1 + 16 (the RFC's "Content-Length: 145" is off by one; its bytes are 144).
    assert.equal(body.length, 144);
    // The receiver side in this test decrypts the RFC example too.
    assert.equal(
        decrypt(b64(RFC.output), b64(RFC.uaPrivate), b64(RFC.auth)).toString(),
        RFC.plaintext,
    );
});

test("vapidAuthorization signs a valid ES256 JWT for the endpoint origin", () => {
    const vapid = generateVapidKeys();

    assert.equal(b64(vapid.publicKey).length, 65);
    assert.equal(b64(vapid.privateKey).length, 32);
    const now = Date.now();
    const header = vapidAuthorization(
        "https://push.example.net/push/abc?x=1",
        vapid,
        "mailto:me@example.com",
        now,
    );
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
    assert.ok(
        verify("sha256", Buffer.from(`${h}.${p}`), { key, dsaEncoding: "ieee-p1363" }, signature),
    );
});

test("sendPush posts an encrypted body with the right headers", async () => {
    const ua = browser();
    const vapid = generateVapidKeys();
    let seen: { url: string; init: RequestInit } | undefined;
    const stub = (async (url: string, init: RequestInit) => {
        seen = { url, init };

        return new Response(null, { status: 201 });
    }) as unknown as typeof fetch;
    const message = {
        title: "Hi",
        body: "x".repeat(5000),
        url: "/c/2",
        tag: "conversation:2/done",
    };
    const status = await sendPush(
        { endpoint: "https://push.example.net/p/1", keys: ua.keys },
        message,
        vapid,
        {
            fetch: stub,
            urgency: "high",
            device: "fixture-device",
            ttl: 60,
        },
    );

    assert.equal(status, 201);
    assert.ok(seen);
    assert.equal(seen.url, "https://push.example.net/p/1");
    const headers = seen.init.headers as Record<string, string>;

    assert.equal(headers["Content-Encoding"], "aes128gcm");
    assert.match(headers.Authorization ?? "", /^vapid t=.+, k=/);
    const plain = decrypt(
        Buffer.from(seen.init.body as Uint8Array),
        ua.privateKey,
        b64(ua.keys.auth),
    );
    const payload = JSON.parse(plain.toString()) as {
        body: string;
        tag: string;
        device: string;
    };

    assert.equal(payload.device, "fixture-device");
    assert.ok(payload.body.length <= 1000);
    assert.equal(payload.tag, "conversation:2/done");
});

test("PushStore persists, validates, and notify drops gone subscriptions", async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "pp-push-"));

    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const credential = (id: string) => `fixture:${id}`;
    const store = new PushStore(directory, credential);
    const file = join(directory, "push.json");
    // Windows has no Unix permission bits.
    const private600 = () =>
        process.platform === "win32" || (statSync(file).mode & 0o777) === 0o600;

    assert.ok(private600());

    const a = browser();
    const b = browser();

    store.subscribe(
        "u1",
        { endpoint: "https://fcm.googleapis.com/fcm/send/a", keys: a.keys },
        "Firefox",
    );
    store.subscribe("u1", { endpoint: "https://fcm.googleapis.com/fcm/send/b", keys: b.keys });
    assert.ok(private600());

    const reopened = new PushStore(directory, credential);

    assert.deepEqual(reopened.vapid, store.vapid);
    assert.equal(reopened.publicKey, store.publicKey);
    assert.deepEqual(reopened.subscriptions("u1"), store.subscriptions("u1"));
    assert.equal(reopened.subscriptions("u1").length, 2);
    // Validation.
    const bad = (endpoint: string, keys: PushKeys) => () =>
        reopened.subscribe("u1", { endpoint, keys });

    assert.throws(bad("http://fcm.googleapis.com/fcm/send/x", a.keys), /https/);

    // Only browser push services: the endpoint must not aim the server at its own network.
    for (const endpoint of [
        "https://127.0.0.1/internal",
        "https://169.254.169.254/latest",
        "https://push.example.net/x",
        "https://evilfcm.googleapis.com.example/x",
    ]) {
        assert.throws(bad(endpoint, a.keys), /not a browser push service/, endpoint);
    }

    // Same endpoint moves to another user; unsubscribe respects ownership.
    reopened.subscribe("u2", { endpoint: "https://fcm.googleapis.com/fcm/send/b", keys: b.keys });
    assert.equal(reopened.subscriptions("u1").length, 1);
    assert.equal(reopened.subscriptions("u2").length, 1);
    assert.equal(reopened.unsubscribe("https://fcm.googleapis.com/fcm/send/b", "u1"), false);
    assert.equal(reopened.unsubscribe("https://fcm.googleapis.com/fcm/send/b", "u2"), true);
    reopened.subscribe("u1", { endpoint: "https://fcm.googleapis.com/fcm/send/b", keys: b.keys });

    // notify: /a is gone (410), /b accepts (201), and a throwing fetch never escapes.
    const calls: string[] = [];
    const stub = (async (url: string) => {
        calls.push(url);

        return new Response(null, { status: url.endsWith("/a") ? 410 : 201 });
    }) as unknown as typeof fetch;
    const accepted = await reopened.notify(
        "u1",
        { title: "Done", body: "Finished", url: "/c/1", tag: "c1" },
        { fetch: stub },
    );

    assert.equal(accepted, 1);
    assert.deepEqual(calls.sort(), [
        "https://fcm.googleapis.com/fcm/send/a",
        "https://fcm.googleapis.com/fcm/send/b",
    ]);
    assert.deepEqual(
        new PushStore(directory, credential).subscriptions("u1").map((sub) => sub.endpoint),
        ["https://fcm.googleapis.com/fcm/send/b"],
    );
    // removeUser drops subscriptions.
    reopened.removeUser("u1");
    assert.equal(reopened.subscriptions("u1").length, 0);
});

const sub = (label: string) => ({
    endpoint: `https://fcm.googleapis.com/fcm/send/${label}`,
    keys: { p256dh: RFC.uaPublic, auth: RFC.auth },
});
const browserRequest = (device?: string) =>
    ({ headers: { cookie: device ? `pocket_push=${device}` : "" }, socket: {} }) as IncomingMessage;

test("push follows the browser sign-in across revocation and restart", async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "push-revocation-"));

    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const config = new ConfigStore(directory);
    const owner = config.users[0]!;
    const guest = config.addUser("Guest", "viewer").user;
    const credential = (id: string) => config.pushCredential(id);
    const store = new PushStore(directory, credential);
    const auth = new Auth(config, store);
    const device = store.subscribe(owner.id, sub("a"));
    const other = store.subscribe(owner.id, sub("b"));
    const guestDevice = store.subscribe(guest.id, sub("c"));
    const message = { title: "Test", body: "Test", url: "/" };
    const received: string[] = [];

    const deliver = async (url: RequestInfo | URL) => {
        received.push(String(url));

        return new Response(null, { status: 201 });
    };

    store.setPrefs(owner.id, { done: false });
    auth.endBrowserPush(owner, browserRequest(device));
    assert.equal(await store.notify(owner.id, message, { fetch: deliver }), 1);
    assert.deepEqual(received.splice(0), [sub("b").endpoint]);
    assert.deepEqual(
        new PushStore(directory, credential).subscriptions(owner.id).map((s) => s.device),
        [other],
    );
    assert.equal(store.prefs(owner.id).done, false);

    config.rotateOwnerToken();
    assert.equal(await store.notify(owner.id, message, { fetch: deliver }), 0);
    assert.equal(await store.notify(guest.id, message, { fetch: deliver }), 1);
    assert.deepEqual(received.splice(0), [sub("c").endpoint]);
    const restored = new ConfigStore(directory);
    const reopened = new PushStore(directory, (id) => restored.pushCredential(id));

    assert.deepEqual(
        reopened.subscriptions().map((s) => s.device),
        [guestDevice],
    );
    reopened.subscribe(owner.id, sub("fresh"));
    reopened.subscribe(owner.id, sub("fresh-other"));
    new Auth(restored, reopened).endBrowserPush(owner, browserRequest());
    assert.deepEqual(
        reopened.subscriptions().map((s) => s.device),
        [guestDevice],
    );
    // A successful account switch also ends the departing device's registration.
    const switched = reopened.subscribe(owner.id, sub("switch"));
    const ownerCookie = `pocket_auth=${restored.ownerToken}; pocket_push=${switched}`;

    new Auth(restored, reopened).switchBrowser(
        { headers: { cookie: ownerCookie } } as IncomingMessage,
        guest,
    );
    assert.deepEqual(
        reopened.subscriptions().map((s) => s.device),
        [guestDevice],
    );
    // The push store could not open at sign-out. Its old file must not resume delivery later.
    new Auth(restored).endBrowserPush(guest, browserRequest(guestDevice));
    const reloaded = new ConfigStore(directory);

    assert.equal(
        new PushStore(directory, (id) => reloaded.pushCredential(id)).subscriptions().length,
        0,
    );
});

test("a surviving device cookie requires a known push state before sign-in", async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "push-switch-"));

    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const config = new ConfigStore(directory);
    const owner = config.users[0]!;
    const { user: guest, token } = config.addUser("Guest", "guest");
    const store = new PushStore(directory, (id) => config.pushCredential(id));
    const auth = new Auth(config, store);
    const device = store.subscribe(owner.id, sub("a"));
    const other = store.subscribe(owner.id, sub("b"));
    const unaffected = store.subscribe(guest.id, sub("c"));
    const request = browserRequest(device);

    const fail = () => {
        throw new Error("fixture storage failure");
    };

    const unavailable = {
        status: 503,
        message: "Cannot verify this browser's notifications. Try again later.",
    };

    const url = new URL("http://fixture.invalid/login");
    const cookieHeaders: string[] = [];
    const response = {
        setHeader: (name: string) => cookieHeaders.push(name),
        writeHead() {},
        end() {},
    } as unknown as ServerResponse;

    url.searchParams.set("token", token);
    // No surviving cookie needs no store. A real cookie needs a successful lookup, even on a retry.
    new Auth(config).switchBrowser(browserRequest(), guest);
    await assert.rejects(login(new Auth(config), request, response, url), unavailable);
    const lookup = t.mock.method(store, "deviceUser", fail);

    await assert.rejects(login(auth, request, response, url), unavailable);
    assert.deepEqual(cookieHeaders, []);
    lookup.mock.restore();
    auth.switchBrowser(request, owner);
    assert.deepEqual(
        store.subscriptions(owner.id).map((s) => s.device),
        [device, other],
    );
    auth.switchBrowser(request, guest);
    assert.deepEqual(
        store.subscriptions(owner.id).map((s) => s.device),
        [other],
    );
    auth.switchBrowser(request, guest); // The lookup now confirms the binding is gone.

    // A failed write in both stores must not turn into an apparently successful second attempt.
    const remaining = browserRequest(other);

    store.subscribe(owner.id, sub("another"));
    t.mock.method(store, "save", fail);
    const fallback = t.mock.method(config, "save", fail);

    for (let attempt = 0; attempt < 2; attempt++) {
        await assert.rejects(login(auth, remaining, response, url), { status: 503 });
    }

    assert.deepEqual(cookieHeaders, []);
    fallback.mock.restore();
    await login(auth, remaining, response, url);
    assert.deepEqual(cookieHeaders, ["set-cookie"]);
    const restored = new ConfigStore(directory);
    const reopened = new PushStore(directory, (id) => restored.pushCredential(id));

    assert.deepEqual(
        reopened.subscriptions().map((s) => s.device),
        [unaffected],
    );
});

test("push, approval, and logout routes use the server-issued browser binding", async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "push-route-"));

    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const config = new ConfigStore(directory);
    const user = config.users[0]!;
    const store = new PushStore(directory, (id) => config.pushCredential(id));
    const auth = new Auth(config, store);
    const decisions: string[] = [];
    const app = {
        config,
        pushStore: store,
        answerApproval: (id: string) => {
            decisions.push(id);

            return true;
        },
    };
    const api = createApi({ app } as never, auth);
    const endpoint = "https://fcm.googleapis.com/fcm/send/route";
    const sub = { endpoint, keys: { p256dh: RFC.uaPublic, auth: RFC.auth } };
    const authCookie = `pocket_auth=${config.ownerToken}`;

    const call = async (
        parts: string[],
        cookie: string,
        body?: AsyncIterable<Buffer> | Buffer[],
        authorization?: string,
    ) => {
        const request = Object.assign(Readable.from(body ?? []), {
            method: body ? "POST" : "GET",
            headers: { cookie, authorization, "x-pocket": "1" },
            socket: {},
        }) as unknown as IncomingMessage;
        let payload = "";
        let setCookie = "";
        const response = {
            setHeader(name: string, value: string | string[]) {
                if (name === "set-cookie") {
                    setCookie = [value].flat().join(", ");
                }
            },
            writeHead() {},
            end(value: string) {
                payload = value;
            },
        } as unknown as ServerResponse;

        await api(request, response, new URL("http://fixture.invalid"), parts);

        return { payload: JSON.parse(payload), setCookie };
    };

    const body = [Buffer.from(JSON.stringify({ subscription: sub }))];
    const { setCookie } = await call(["push", "subscribe"], authCookie, body);
    const deviceCookie = setCookie.split(";")[0];
    const cookies = `${authCookie}; ${deviceCookie}`;

    assert.match(setCookie, /^pocket_push=.*HttpOnly/);
    assert.equal((await call(["push"], cookies)).payload.endpoint, endpoint);
    assert.equal((await call(["push", "device"], authCookie)).payload.device, null);

    const approval = ["approvals", "fixture"];
    const device = (await call(["push", "device"], cookies)).payload.device;
    const answer = (source?: string, expected?: string) => [
        Buffer.from(JSON.stringify({ allow: false, source, device: expected })),
    ];

    assert.equal((await call(approval, cookies, answer("push", device))).payload.ok, true);
    assert.equal((await call(approval, authCookie, answer("app"))).payload.ok, true);
    assert.equal(
        (await call(approval, "", answer(), `Bearer ${config.ownerToken}`)).payload.ok,
        true,
    );
    await assert.rejects(call(approval, authCookie, answer("push", device)), { status: 409 });
    await assert.rejects(call(approval, cookies, answer("push")), { status: 409 });
    await assert.rejects(call(approval, cookies, answer()), { status: 409 });
    await assert.rejects(call(approval, deviceCookie!, answer("push", device)), { status: 401 });
    const guest = config.addUser("Guest", "guest");

    await assert.rejects(
        call(approval, `pocket_auth=${guest.token}; ${deviceCookie}`, answer("push", device)),
        { status: 409 },
    );

    const renewed = async function* () {
        await call(["push", "subscribe"], cookies, body);
        yield answer("push", device)[0]!;
    };

    await assert.rejects(call(approval, cookies, renewed()), { status: 409 });
    assert.deepEqual(decisions, ["fixture", "fixture", "fixture"]);

    const replacement = async function* () {
        // Sign-out finishes while another registration's body is still arriving.
        const out = await call(["logout"], cookies, []);

        assert.match(out.setCookie, /pocket_auth=;.*Max-Age=0/);
        assert.match(out.setCookie, /pocket_push=;.*Max-Age=0/);
        yield body[0]!;
    };

    await assert.rejects(call(["push", "subscribe"], cookies, replacement()), /sign-in changed/);
    assert.deepEqual(store.subscriptions(user.id), []);
    assert.equal((await call(["push", "device"], cookies)).payload.device, null);
});

test("legacy registrations stop without losing the server key or notification preferences", (t) => {
    const directory = mkdtempSync(join(tmpdir(), "push-migration-"));

    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const store = new PushStore(directory, () => "fixture");
    const data = JSON.parse(readFileSync(store.file, "utf8"));

    data.subscriptions = [{ userId: "fixture", endpoint: "legacy", createdAt: 1 }];
    data.prefs = { fixture: { chat: false } };
    writeFileSync(store.file, JSON.stringify(data));
    const reopened = new PushStore(directory, () => "fixture");

    assert.deepEqual(reopened.subscriptions(), []);
    assert.deepEqual(JSON.parse(readFileSync(store.file, "utf8")).subscriptions, []);
    assert.equal(reopened.publicKey, store.publicKey);
    assert.equal(reopened.prefs("fixture").chat, false);
});

test("a late delivery result cannot retire a replacement registration", async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "push-inflight-"));

    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const store = new PushStore(directory, () => "fixture");
    const sub = {
        endpoint: "https://fcm.googleapis.com/fcm/send/test",
        keys: { p256dh: RFC.uaPublic, auth: RFC.auth },
    };
    const first = store.subscribe("user", sub);
    let finish!: (response: Response) => void;
    const delivery = store.notify(
        "user",
        { title: "Title", body: "Body", url: "/" },
        {
            fetch: () =>
                new Promise<Response>((resolve) => {
                    finish = resolve;
                }),
        },
    );

    store.revokeDevice("user", first);
    const fresh = store.subscribe("user", sub);

    finish(new Response(null, { status: 410 }));
    assert.equal(await delivery, 0);
    assert.deepEqual(
        store.subscriptions("user").map((s) => s.device),
        [fresh],
    );
});

test("a worker shows queued push content only for the active device", async () => {
    let push: (event: object) => void;
    let current: string | null = "active";
    const shown: string[] = [];
    const self = {
        addEventListener: (name: string, fn: typeof push) => {
            if (name === "push") {
                push = fn;
            }
        },
        registration: { showNotification: (title: string) => shown.push(title) },
        navigator: {},
    };

    runInNewContext(readFileSync(new URL("../web/sw.js", import.meta.url), "utf8"), {
        self,
        fetch: async () => ({ ok: current !== null, json: () => ({ device: current }) }),
    });

    const deliver = async (device?: string) => {
        let done: Promise<void> | undefined;

        push({
            data: { json: () => ({ title: "Test", device }) },
            waitUntil: (work: Promise<void>) => {
                done = work;
            },
        });
        await done;
    };

    await deliver("active");
    await deliver("expired");
    await deliver();
    current = null;
    await deliver("active");
    assert.deepEqual(shown, ["Test"]);
});

test("the worker includes the displayed binding with the approval decision", async () => {
    let click!: (event: object) => void;
    let done!: Promise<void>;
    const posts: { path: string; body: unknown }[] = [];
    const self = {
        addEventListener: (name: string, fn: typeof click) => {
            if (name === "notificationclick") {
                click = fn;
            }
        },
    };

    runInNewContext(readFileSync(new URL("../web/sw.js", import.meta.url), "utf8"), {
        self,
        fetch: async (path: string, options: { body?: string }) => {
            if (options.body !== undefined) {
                posts.push({ path, body: JSON.parse(options.body) });
            }

            return { ok: true, json: () => ({ device: "current" }) };
        },
    });
    click({
        action: "deny",
        notification: { close() {}, data: { device: "current", approval: { id: "one/two" } } },
        waitUntil: (work: Promise<void>) => {
            done = work;
        },
    });
    await done;
    assert.deepEqual(posts, [
        {
            path: "/api/approvals/one%2Ftwo",
            body: { source: "push", device: "current", allow: false },
        },
    ]);
});

test("every push kind, the limit wait too, can be turned off through the prefs route", async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "push-prefs-"));

    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const store = new PushStore(directory, () => "fixture");
    let answer = "";
    const request = Object.assign(
        Readable.from([Buffer.from(JSON.stringify({ limit: false, done: false }))]),
        {
            method: "POST",
            headers: {},
        },
    );
    const response = { writeHead: () => {}, end: (body: string) => (answer = body) };

    await pushRoutes(
        { app: { pushStore: store }, request, response, user: { id: "u" } } as never,
        "prefs",
    );
    assert.deepEqual(
        [JSON.parse(answer).prefs.limit, JSON.parse(answer).prefs.done, store.prefs("u").limit],
        [false, false, false],
    );
});
