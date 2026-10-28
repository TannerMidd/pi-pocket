import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import createSshSessions from "./ssh-sessions.ts";
import type { Host, Web } from "./_pocket.d.ts";
import {
    configWords,
    parseWorkspace,
    sshAliases,
    validAlias,
    workspaceUri,
} from "./_ssh-sessions/config.ts";
import { SshWorkspaces } from "./_ssh-sessions/runtime.ts";
import {
    Connection,
    localDaemon,
    RemoteExecutionEnv,
} from "./_ssh-sessions/node_modules/@earendil-works/pi-env/dist/index.js";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";

test("module load rejects servers without both required workspace APIs", () => {
    const web = {} as Web;

    assert.throws(
        () => createSshSessions({ registerWorkspaceProvider() {} } as unknown as Host, web),
        /remote workspace API/,
    );
    assert.throws(
        () => createSshSessions({ cwdOf() {} } as unknown as Host, web),
        /remote workspace API/,
    );
});

test("SSH aliases include quoted names, Include files and cycles, not wildcard patterns", async () => {
    const home = await mkdtemp(join(tmpdir(), "pocket-ssh-config-"));

    try {
        await mkdir(join(home, ".ssh", "hosts"), { recursive: true });
        await writeFile(
            join(home, ".ssh", "config"),
            'Host=hextech "gpu-box" # comment\nHost * !private *.lab\nInclude hosts/*.conf\n',
        );
        await writeFile(
            join(home, ".ssh", "hosts", "work.conf"),
            "Host remote_2\nInclude config\nHost hextech\n",
        );
        assert.deepEqual(await sshAliases(home), ["gpu-box", "hextech", "remote_2"]);
        assert.deepEqual(configWords('Include "hosts/work file.conf" # comment'), [
            "Include",
            "hosts/work file.conf",
        ]);
        assert.deepEqual(await sshAliases(join(home, "missing")), []);
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});

test("SSH workspace paths round-trip without shell interpolation or URL normalization", () => {
    const path = "/home/pierre/a #?%é/'$(touch nope)'/../file";

    assert.deepEqual(parseWorkspace(workspaceUri("hextech", path)), { alias: "hextech", path });
    assert.deepEqual(parseWorkspace("ssh://hextech/~"), { alias: "hextech", path: "/~" });
    assert.equal(validAlias("-oProxyCommand=evil"), false);
    assert.equal(validAlias("user@host"), false);

    for (const value of [
        "ssh://-option/x",
        "ssh://host/x?query",
        "ssh://host/%00",
        "ssh://host/%0a",
        "ssh://host/%ZZ",
        "file:///etc/passwd",
    ]) {
        assert.throws(() => parseWorkspace(value));
    }

    assert.throws(() => workspaceUri("host", "relative"));
    assert.throws(() => workspaceUri("host", "/path\0"));
});

test("SSH environments are lazy, stable per workspace, and unusable after disposal", () => {
    const manager = new SshWorkspaces("/tmp/pocket-not-created");
    const env = manager.env("ssh://hextech/home/pierre");

    assert.equal(env.cwd, "/home/pierre");
    assert.equal(env.id, "ssh:hextech");
    assert.equal(manager.env("ssh://hextech/home/pierre"), env);
    assert.equal(manager.target("hextech").hostKeyAlias, "pi-pocket-hextech");
    assert.throws(() => manager.target("-oBad"));
    manager.close();
    assert.throws(() => manager.env("ssh://hextech/home/pierre"), /disabled/);
});

test("pinned pi-env daemon implements remote file reads, writes, shell and cancellation", async () => {
    const root = await mkdtemp(join(tmpdir(), "pocket-remote-env-"));
    const connection = new Connection({ command: [localDaemon()] });
    const env = new RemoteExecutionEnv({ connection, cwd: root, id: "ssh-fixture" });
    const context = BACKGROUND_CONTEXT;

    try {
        getOrThrow(await env.writeFile("test.txt", "remote contents\n", context));
        assert.equal(getOrThrow(await env.readTextFile("test.txt", context)), "remote contents\n");
        let output = "";
        const result = getOrThrow(
            await env.exec(
                ["pwd"],
                {
                    onOutput: (chunk) => {
                        output += chunk;
                    },
                },
                context,
            ),
        );

        assert.equal(result.exitCode, 0);
        assert.equal(output.trim(), root);
        const controller = new AbortController();

        controller.abort();
        const canceled = await env.exec("touch canceled.txt", undefined, {
            ...context,
            abortSignal: controller.signal,
        });

        assert.equal(canceled.ok, false);
        assert.equal(getOrThrow(await env.exists("canceled.txt", context)), false);
    } finally {
        connection.close();
        await rm(root, { recursive: true, force: true });
    }
});
