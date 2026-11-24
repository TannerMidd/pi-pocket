import assert from "node:assert/strict";
import { test } from "node:test";
import discord from "../src/server/extensions/pocket-relay/connectors/discord.ts";
import http, { toEvent } from "../src/server/extensions/pocket-relay/connectors/http.ts";
import matrix from "../src/server/extensions/pocket-relay/connectors/matrix.ts";
import rss from "../src/server/extensions/pocket-relay/connectors/rss.ts";
import slack from "../src/server/extensions/pocket-relay/connectors/slack.ts";
import telegram from "../src/server/extensions/pocket-relay/connectors/telegram.ts";
import {
    authenticatedAccount,
    isOwnerAccount,
} from "../src/server/extensions/pocket-relay/types.ts";

import { relayActor, type RelayMessage } from "../src/server/surfaces/relay.ts";

const owners = ["account-1"];

test("chat owner IDs match only authenticated accounts, never a display name", () => {
    for (const connector of [discord, matrix, slack, telegram]) {
        const account = (id: string, name: string, bot = false) =>
            authenticatedAccount(connector, { id, name, bot });

        assert.equal(isOwnerAccount(owners, account("account-1", "New name")), true);
        assert.equal(isOwnerAccount(owners, account("account-2", "account-1")), false);
        assert.equal(isOwnerAccount(owners, account("", "account-1")), false);
        assert.equal(isOwnerAccount(owners, account("account-1", "A bot", true)), false);
    }
});

test("an HTTP record has attribution, not an authenticated sender", () => {
    const fields = { authorIdField: "user", authorNameField: "label" };
    const url = "https://feed.invalid/items";
    const record = (item: object) => toEvent(item, fields, url).author;
    const withId = record({ user: "account-1", label: "A name" });
    const withoutId = record({ label: "account-1" });

    assert.deepEqual(withId, { id: "account-1", name: "A name" });
    assert.deepEqual(withoutId, { id: "feed.invalid", name: "account-1" });
    assert.equal(authenticatedAccount(http, withId), undefined);
    assert.equal(authenticatedAccount(http, withoutId), undefined);
});

test("a feed, a legacy connector, and a record without account evidence are untrusted", () => {
    const author = { id: "account-1", name: "A name" };
    const legacy = { ...discord, authenticatedAuthors: undefined };

    assert.equal(authenticatedAccount(rss, author), undefined);
    assert.equal(authenticatedAccount(legacy, author), undefined);
    assert.equal(isOwnerAccount(owners, undefined), false);
});

test("a card actor needs both authenticated identity and a current steering person", () => {
    const person = { id: "local-1", name: "A person", role: "owner" as const };
    const message: RelayMessage = {
        connector: "chat",
        routeRevision: "revision",
        author: { id: "account-1", name: "A name" },
        ownerIds: owners,
        by: person.id,
        text: "1",
    };

    assert.equal(relayActor(message, person)?.role, "viewer");
    assert.deepEqual(relayActor({ ...message, trusted: true }, person), person);
    assert.equal(relayActor(message, undefined), undefined);
    assert.equal(relayActor({ ...message, trusted: true }, undefined), undefined);
});
