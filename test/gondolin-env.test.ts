import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createEnvConformance } from "@earendil-works/pi-durable/testing";
import { GuestEnv } from "../src/server/extensions/gondolin/guest-env.ts";
import { FakeDriver } from "./gondolin-fake.ts";

const roots: string[] = [];

after(() => {
    for (const root of roots) {
        rmSync(root, { recursive: true, force: true });
    }
});

async function withEnv(use: (env: GuestEnv, driver: FakeDriver) => Promise<void>): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), "gondolin-env-"));
    const driver = new FakeDriver();
    const vm = await driver.start({} as never);

    roots.push(root);
    await use(
        new GuestEnv(
            "fake:test",
            root,
            { ready: async () => vm, busy: () => () => {}, touch() {} },
            () => "/bin/sh",
        ),
        driver,
    );
}

// The sandbox does not report file changes (`watch` says it is not supported), so the watch cases do not apply.
for (const each of createEnvConformance({
    assertions: {
        ok: (value, message) => assert.ok(value, message as string),
        strictEqual: (actual, expected) => assert.strictEqual(actual, expected),
        deepEqual: (actual, expected) => assert.deepStrictEqual(actual, expected),
        partialDeepEqual: (actual, expected) => assert.partialDeepStrictEqual(actual, expected),
        greaterThan: (actual, expected) => assert.ok(actual > expected, `${actual} > ${expected}`),
        rejects: async (operation, messageIncludes) => {
            await assert.rejects(operation, (error: Error) =>
                error.message.includes(messageIncludes),
            );
        },
    },
    withEnv: (use) => withEnv((env) => use(env)),
    shell: ["/bin/sh", "-c"],
})) {
    if (each.name.startsWith("watch")) {
        continue;
    }

    test(`guest env conformance: ${each.name}`, { timeout: each.timeoutMs }, () => each.run());
}
