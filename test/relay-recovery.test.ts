import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { Relay, type ConnectorConfig } from "../src/server/extensions/pocket-relay/runtime.ts";

const config: ConnectorConfig = {
    id: "c-fixture",
    kind: "fixture",
    name: "Fixture",
    by: "owner",
    target: 1,
    enabled: true,
    mentionOnly: false,
    instructions: "",
    ownerIds: [],
    perHour: 30,
    perAuthor: 10,
    values: {},
    createdAt: 1,
    updatedAt: 1,
};
const state = {
    own: {},
    pending: [],
    recent: [],
    replies: {},
    authors: {},
    delivered: 0,
    dropped: 0,
};
const envelope = (connectors: object) => JSON.stringify({ version: 1, connectors });

async function folder(t: TestContext): Promise<string> {
    const where = await mkdtemp(join(tmpdir(), "relay-recovery-"));

    t.after(() => rm(where, { recursive: true, force: true }));

    return where;
}

function open(where: string, log: (line: string) => void = () => {}): Relay {
    return new Relay({
        folder: where,
        inbox: () => undefined,
        hide: () => () => {},
        onStatus: () => {},
        log,
    });
}

function register(relay: Relay, poll: () => void) {
    return relay.register({
        kind: "fixture",
        label: "Fixture",
        fields: [],
        shape: "poll",
        poll: async () => poll(),
    });
}

test("Recovery preserves route-scoped account records without adding proof to older events", async (t) => {
    const where = await folder(t);
    const revision = "fixture-revision";
    const ref = (id: string) =>
        "e-" +
        createHash("sha256")
            .update(JSON.stringify([revision, id, "room", null]))
            .digest("base64url")
            .slice(0, 24);
    const event = (id: string) => ({
        id,
        channel: "room",
        author: { id: "a", name: "Author" },
        text: "message",
    });
    const heard = (id: string) => ({ id, channel: "room", author: "a", reference: ref(id), at: 1 });
    const stored = {
        ...state,
        revision,
        pending: [event("p1"), event("p2")],
        pendingAccounts: { [ref("p1")]: "a" },
        recent: [{ ...heard("r1"), authenticatedAccount: "a" }, heard("r2")],
    };

    await writeFile(
        join(where, "connectors.json"),
        envelope({ [config.id]: { ...config, revision } }),
    );
    const path = join(where, "state.json");

    await writeFile(path, envelope({ [config.id]: stored }));
    const relay = open(where);

    try {
        await relay.ready;
        assert.deepEqual(relay.stateOf(config.id), stored);
    } finally {
        await relay.stop();
    }

    assert.deepEqual(JSON.parse(await readFile(path, "utf8")).connectors[config.id], stored);
});

for (const legacy of [false, true]) {
    test(`The first poll sees its stored revision after ${legacy ? "legacy recovery" : "a first save"}`, async (t) => {
        const where = await folder(t);
        const settings = join(where, "connectors.json");
        const saved = join(where, "state.json");

        if (legacy) {
            await writeFile(settings, envelope({ [config.id]: config }));
            await writeFile(
                saved,
                envelope({
                    [config.id]: {
                        ...state,
                        delivered: 7,
                        replies: { previous: { at: 1 } },
                        pending: [{ id: "old", text: "old", author: { id: "remote" } }],
                        recent: [{ id: "heard", author: "remote", at: 1 }],
                    },
                }),
            );
        }

        const relay = open(where);
        const snapshots: { config: string; state: string }[] = [];

        try {
            register(relay, () =>
                snapshots.push({
                    config: readFileSync(settings, "utf8"),
                    state: readFileSync(saved, "utf8"),
                }),
            );
            await relay.ready;

            if (!legacy) {
                assert.deepEqual(relay.configs(), []);
                await relay.put(config);
            }

            const revision = relay.config(config.id)?.revision;

            assert.ok(revision);
            assert.equal(snapshots.length, 1);
            assert.equal(JSON.parse(snapshots[0]!.config).connectors[config.id].revision, revision);
            const stored = JSON.parse(snapshots[0]!.state).connectors[config.id];

            assert.equal(stored.revision, revision);
            assert.equal(stored.delivered, legacy ? 7 : 0);

            if (legacy) {
                assert.deepEqual(stored.replies.previous, { at: 1, retired: true });
            }
        } finally {
            await relay.stop();
        }
    });
}

for (const [label, content] of Object.entries({
    "missing file": undefined,
    "invalid JSON": "not-json-private-fixture",
    "unknown format": "{}",
    "missing connector state": envelope({}),
    "orphan state": envelope({ [config.id]: state, orphan: state }),
    "invalid reply record": envelope({
        [config.id]: { ...state, replies: { previous: { at: "yesterday" } } },
    }),
    "invalid reply flag": envelope({
        [config.id]: { ...state, replies: { previous: { at: 1, retired: "yes" } } },
    }),
    "invalid count": envelope({ [config.id]: { ...state, delivered: "7" } }),
    "invalid time": envelope({ [config.id]: { ...state, lastEventAt: false } }),
})) {
    test(`Recovery preserves the saved settings and reports ${label}`, async (t) => {
        const where = await folder(t);
        const text = envelope({ [config.id]: config });
        const settings = join(where, "connectors.json");
        const saved = join(where, "state.json");

        await writeFile(settings, text);

        if (content !== undefined) {
            await writeFile(saved, content);
        }

        const messages: string[] = [];
        const relay = open(where, (line) => messages.push(line));

        try {
            register(relay, () => {});
            await assert.rejects(relay.ready, (error: Error) => {
                assert.match(error.message, /[Rr]estore/);
                assert.doesNotMatch(error.message, /private-fixture/);

                return true;
            });
            assert.doesNotMatch(messages.join("\n"), /private-fixture/);
            await assert.rejects(relay.put(config), /[Rr]estore/);
            await assert.rejects(relay.remove(config.id), /[Rr]estore/);
            relay.start();
            assert.equal(relay.running(), 0);
            await relay.persist();
        } finally {
            await relay.stop();
        }

        assert.equal(await readFile(settings, "utf8"), text);

        if (content === undefined) {
            assert.deepEqual(await readdir(where), ["connectors.json"]);
        } else {
            assert.equal(await readFile(saved, "utf8"), content);
        }
    });
}

test("An unreadable state path preserves the configuration and stays untouched", async (t) => {
    const where = await folder(t);
    const text = envelope({ [config.id]: config });
    const settings = join(where, "connectors.json");
    const saved = join(where, "state.json");

    await writeFile(settings, text);
    await mkdir(saved);
    const relay = open(where);

    try {
        await assert.rejects(relay.ready, /state\.json/);
        assert.equal(relay.running(), 0);
    } finally {
        await relay.stop();
    }

    assert.equal(await readFile(settings, "utf8"), text);
    assert.deepEqual(await readdir(saved), []);
});

test("Only a successful write admits an edited connector to startup", async (t) => {
    const where = await folder(t);
    const relay = open(where);

    try {
        const unregister = register(relay, () => {});

        await relay.ready;
        await mkdir(join(where, "state.json"));
        await assert.rejects(relay.put(config), /could not write/);
        relay.start();
        unregister();
        register(relay, () => {});
        assert.equal(relay.running(), 0);
    } finally {
        await relay.stop();
    }
});
