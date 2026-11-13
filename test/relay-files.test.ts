import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { InboxApi, InboxDelivery } from "../src/server/host.ts";
import discord from "../src/server/extensions/pocket-relay/connectors/discord.ts";
import { readFiles } from "../src/server/extensions/pocket-relay/files.ts";
import { type ConnectorConfig, Relay } from "../src/server/extensions/pocket-relay/runtime.ts";
import type {
    RelayConnector,
    RelayContext,
    RelayEvent,
} from "../src/server/extensions/pocket-relay/types.ts";
import { mockServer } from "./relay-ws-mock.ts";

const TOKEN = "very-secret-token-value";
const folders: string[] = [];

after(() => folders.forEach((folder) => rmSync(folder, { recursive: true, force: true })));

const folder = () => {
    const made = mkdtempSync(join(tmpdir(), "pocket-relay-files-"));

    folders.push(made);

    return made;
};

async function until(check: () => boolean): Promise<void> {
    const started = Date.now();

    while (!check()) {
        assert.ok(Date.now() - started < 5000, "timed out");
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

const caps = { max: 2, maxBytes: 100 };

test("files go only from the session's folder: no escape, no link out, no hidden file, no server data", async () => {
    const root = folder();
    const outside = folder();

    writeFileSync(join(root, "a.png"), "png");
    writeFileSync(join(root, ".env"), `TOKEN=${TOKEN}`);
    writeFileSync(join(outside, "secret.txt"), TOKEN);
    symlinkSync(join(outside, "secret.txt"), join(root, "link.txt"));
    mkdirSync(join(root, "data"));
    writeFileSync(join(root, "data", "auth.json"), TOKEN);
    writeFileSync(join(root, "big.bin"), "x".repeat(101));

    const [sent] = await readFiles(root, join(root, "data"), ["a.png"], caps);

    assert.equal(sent!.name, "a.png");
    assert.equal(sent!.type, "image/png");

    for (const path of [
        "../" + join(outside.split("/").at(-1)!, "secret.txt"),
        join(outside, "secret.txt"),
        "link.txt",
        ".env",
        "data/auth.json",
        "big.bin",
        "missing.png",
    ]) {
        await assert.rejects(
            readFiles(root, join(root, "data"), [path], caps),
            /Nothing was sent|nothing was sent/,
            path,
        );
    }

    await assert.rejects(
        readFiles(root, outside, ["a.png", "a.png", "a.png"], caps),
        /2 files at most/,
    );
});

function fakeInbox() {
    const delivered: InboxDelivery[] = [];
    const inbox: InboxApi = {
        deliver: async (_target, delivery) => {
            delivered.push(delivery);

            return { sent: true };
        },
    };

    return { inbox, delivered };
}

const config = (kind: string): ConnectorConfig => ({
    id: `c-${kind}`,
    name: `${kind} one`,
    kind,
    enabled: true,
    target: 1,
    by: "owner",
    instructions: "",
    ownerIds: [],
    mentionOnly: false,
    perHour: 30,
    perAuthor: 10,
    values: { token: TOKEN },
    createdAt: 1,
    updatedAt: 1,
});

function connector(kind: string, more: Partial<RelayConnector> = {}) {
    const queue: RelayEvent[][] = [];
    const sent: number[] = [];

    let wake = () => {};

    const made: RelayConnector = {
        kind,
        label: kind,
        shape: "stream",
        fields: [{ name: "token", label: "Token", type: "secret" }],
        run: async (context: RelayContext) => {
            while (!context.signal.aborted) {
                const next = queue.shift();

                if (next === undefined) {
                    await new Promise<void>((resolve) => {
                        wake = resolve;
                        context.signal.addEventListener("abort", () => resolve(), { once: true });
                    });
                    continue;
                }

                await context.emit(next);
            }
        },
        reply: async (_context, reply) => {
            sent.push(reply.files?.length ?? 0);

            return {};
        },
        ...more,
    };

    return {
        made,
        sent,
        push: (events: RelayEvent[]) => {
            queue.push(events);
            wake();
        },
    };
}

const file = { name: "a.png", type: "image/png", data: new Uint8Array([1, 2, 3]) };

test("files go once across a replay; a kind without files refuses and sends nothing", async () => {
    const relay = new Relay({
        folder: folder(),
        inbox: () => fakeInbox().inbox,
        log: () => {},
        onStatus: () => {},
        hide: () => () => {},
    });
    const withFiles = connector("withfiles", { files: { max: 2, maxBytes: 10 } });
    const without = connector("plain");

    relay.register(withFiles.made);
    relay.register(without.made);
    await relay.put(config("withfiles"));
    await relay.put(config("plain"));

    const signal = new AbortController().signal;
    const request = { text: "here", key: "task:call", files: [file] };

    assert.equal(await relay.reply(config("withfiles"), request, signal), "Sent.");
    assert.equal(await relay.reply(config("withfiles"), request, signal), "Sent already.");
    assert.deepEqual(withFiles.sent, [1]);
    await assert.rejects(
        relay.reply(
            config("withfiles"),
            { ...request, key: "k2", files: [file, file, file] },
            signal,
        ),
        /2 files/,
    );
    await assert.rejects(
        relay.reply(config("plain"), { ...request, key: "k3" }, signal),
        /cannot send files yet/,
    );
    assert.deepEqual(without.sent, []);
    await relay.stop();
});

test("a fetch keeps its caps and type check, and shows no token or link", async () => {
    const { inbox, delivered } = fakeInbox();
    const relay = new Relay({
        folder: folder(),
        inbox: () => inbox,
        log: () => {},
        onStatus: () => {},
        hide: () => () => {},
    });
    const answers: (() => Promise<{ data: Uint8Array; type?: string }>)[] = [
        async () => ({ data: new Uint8Array(3), type: "text/html; charset=utf-8" }),
        async () => {
            throw new Error(`denied https://cdn.example/x?sig=abc for ${TOKEN}`);
        },
        async () => ({ data: new Uint8Array(3), type: "image/png" }),
    ];
    const fetching = connector("fetching", { fetch: () => answers.shift()!() });

    relay.register(fetching.made);
    await relay.put(config("fetching"));
    fetching.push([
        {
            id: "e1",
            text: "look",
            author: { id: "ann", name: "Ann" },
            files: [
                { name: "a.png", type: "image/png", size: 3, ref: "https://cdn.example/a?sig=1" },
            ],
        },
    ]);
    await until(() => delivered.length === 1);
    assert.match(delivered[0]!.payload, /1\. a\.png \(image\/png, 3 bytes\)/);
    assert.ok(!delivered[0]!.payload.includes("cdn.example"));

    const signal = new AbortController().signal;
    const c = config("fetching");

    await assert.rejects(relay.fetch(c, "e1", 1, signal), /came as text\/html/);
    await assert.rejects(relay.fetch(c, "e1", 1, signal), (error: Error) => {
        assert.ok(!error.message.includes(TOKEN), error.message);
        assert.ok(!error.message.includes("sig=abc"), error.message);

        return true;
    });
    assert.equal((await relay.fetch(c, "e1", 1, signal)).type, "image/png");
    await assert.rejects(relay.fetch(c, "e1", 2, signal), /1 attachments/);
    await relay.stop();

    // Discord's download stops at the cap, and never sends the token to the file host.
    const auths: string[] = [];
    const mock = await mockServer((request) => {
        auths.push(String(request.headers.authorization ?? ""));

        return { text: "x".repeat(50), headers: { "content-type": "image/png" } };
    });

    try {
        const context = {
            values: { token: TOKEN, apiUrl: `${mock.url}/api` },
            signal,
            log: () => {},
        };
        const ref = JSON.stringify({
            url: `${mock.url}/f/a.png`,
            id: "1",
            channel: "2",
            message: "3",
        });

        await assert.rejects(discord.fetch!(context, { name: "a.png", ref }, 10), /larger than/);
        assert.equal(
            (await discord.fetch!(context, { name: "a.png", ref }, 100)).data.byteLength,
            50,
        );
        await assert.rejects(
            discord.fetch!(
                context,
                { name: "a.png", ref: JSON.stringify({ url: "https://evil.example/a" }) },
                100,
            ),
            /not on Discord's file host/,
        );
        assert.ok(auths.every((auth) => auth === ""));

        // A reply with files is multipart, with the nonce in payload_json.
        const bodies: { type: string; body: string }[] = [];

        const posts = await mockServer((request, body) => {
            bodies.push({ type: String(request.headers["content-type"]), body });

            return { json: { id: "9" } };
        });

        try {
            await discord.reply!(
                { values: { token: TOKEN, apiUrl: `${posts.url}/api` }, signal, log: () => {} },
                { text: "pic", channel: "1001", key: "k", files: [file] },
            );
            assert.match(bodies[0]!.type, /^multipart\/form-data/);
            assert.match(bodies[0]!.body, /name="payload_json"[\s\S]*"enforce_nonce":true/);
            assert.match(bodies[0]!.body, /name="files\[0\]"; filename="a.png"/);
        } finally {
            posts.server.closeAllConnections();
            posts.server.close();
        }
    } finally {
        mock.server.closeAllConnections();
        mock.server.close();
    }
});
