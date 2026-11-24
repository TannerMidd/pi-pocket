// Real lookup coverage for the generated handoff; this does not claim an unpublished catalog key is live.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { placeholders, translate } from "../web/locale.js";
import { parseEntry } from "../src/server/gallery/entry.ts";

type Message = {
    key: string;
    english: string;
    chinese: string | null;
    chineseSource: string;
    placeholders: string[];
    values: Record<string, string>;
    catalog: string;
    sites: string[];
};
const messages: Message[] = JSON.parse(
    readFileSync(new URL("./wp4-messages.json", import.meta.url), "utf8"),
);

test("WP4 handoff preserves placeholder names and actual lookup behavior", () => {
    assert.ok(messages.length > 0);

    for (const message of messages) {
        assert.deepEqual(
            [...new Set(placeholders(message.english))].sort(),
            message.placeholders,
            message.key,
        );
        const en = message.english.replace(
            /\{([A-Za-z][A-Za-z0-9_]*)\}/g,
            (whole, name) => message.values[name] ?? whole,
        );

        assert.equal(translate({}, message.key, message.english, message.values), en, message.key);

        if (message.chinese === null) {
            continue;
        }

        assert.deepEqual(
            [...new Set(placeholders(message.chinese))].sort(),
            message.placeholders,
            message.key,
        );
        const zh = message.chinese.replace(
            /\{([A-Za-z][A-Za-z0-9_]*)\}/g,
            (whole, name) => message.values[name] ?? whole,
        );

        assert.equal(
            translate(
                { [message.key]: message.chinese },
                message.key,
                message.english,
                message.values,
            ),
            zh,
            message.key,
        );
    }
});

test("WP4 share examples satisfy the real folder and tag input grammar", () => {
    const translation = (key: string) => {
        const item = messages.find((entry) => entry.key === key);

        assert.ok(item?.chinese, key);

        return item.chinese;
    };

    const prefix = "web.sheets.gallery.gallery-share-sheet.";
    const folder = translation(prefix + "placeholder.theme");
    const entry = {
        name: "wp4-sample",
        title: "Sample",
        description: "Sample",
        tags: ["test"],
        author: { name: "Author" },
        version: "1.0.0",
        source: { repo: "author/sample", commit: "a".repeat(40), path: folder },
        files: [{ name: "wp4-sample.ts", sha256: "a".repeat(64), size: 1 }],
        pocketApi: 1,
        minPocket: "0.14.0",
        declares: {
            extensions: ["wp4-sample"],
            tools: [],
            readOnlyTools: [],
            hooks: [],
            sections: [],
            wraps: [],
            routes: [],
            client: null,
            access: "owner",
        },
    };

    assert.doesNotThrow(
        () => parseEntry(entry),
        "theme folder example accepted by real index parser",
    );

    for (const suffix of [
        "placeholder.dark-minimal",
        "placeholder.usage-limits",
        "hint.dark-calm",
        "hint.usage-time",
    ]) {
        const tags = translation(prefix + suffix)
            .split(/[\s,]+/)
            .filter(Boolean);

        assert.ok(tags.length > 0, suffix);
        assert.doesNotThrow(
            () => parseEntry({ ...entry, tags }),
            `${suffix} accepted by real index parser`,
        );
    }
});
