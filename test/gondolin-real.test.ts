// The real Gondolin driver, with a real VM. It runs only when `PI_POCKET_GONDOLIN_REAL` names a folder that has
// `node_modules/@earendil-works/gondolin` 0.14.0 and, in `PI_POCKET_GONDOLIN_IMAGES` (or its `images/`), the image
// `alpine-base:latest`; and the host can run a VM (KVM or QEMU). Otherwise every test here is skipped.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test, type TestContext } from "node:test";
import { context } from "./helpers.ts";
import { SandboxManager } from "../src/server/extensions/gondolin/manager.ts";
import { GondolinDriver } from "../src/server/extensions/gondolin/real-driver.ts";
import type { HostCheck } from "../src/server/extensions/gondolin/guest.ts";

const dir = process.env.PI_POCKET_GONDOLIN_REAL;
const work = mkdtempSync(join(tmpdir(), "gondolin-real-"));
let driver: GondolinDriver | undefined;
let manager: SandboxManager | undefined;
let check: HostCheck | undefined;
let network: "allowlist" | "off" = "allowlist";

const run = (command: string, cwd = work) => {
    const env = manager!.envFor(1, { rootId: 1, cwd, uploadDir: undefined });
    let output = "";

    return env
        .exec(command, { onOutput: (text) => (output += text), timeout: 60 }, context)
        .then((result) => ({ result, output }));
};

before(async () => {
    if (dir === undefined) {
        return;
    }

    driver = new GondolinDriver(dir);
    check = await driver.check({ backend: "auto", image: "alpine-base:latest" });

    if (!check.ok) {
        return;
    }

    mkdirSync(join(work, ".git", "hooks"), { recursive: true });
    writeFileSync(join(work, ".git", "config"), "[core]\n");
    writeFileSync(join(work, "hello.txt"), "hello from the host\n");
    manager = new SandboxManager({
        driver,
        log: () => {},
        pidFile: join(work, "..", `vms-${process.pid}.json`),
        settings: () => ({
            backend: "auto",
            mount: "rw",
            network,
            allowedHosts: ["example.com"],
            cpus: 2,
            memoryMb: 1024,
            diskMb: 2048,
            idleMinutes: 0,
            maxVms: 2,
            image: "alpine-base:latest",
        }),
    });
});

after(async () => {
    await manager?.stopAll("the test ended");
    rmSync(work, { recursive: true, force: true });
});

/** Skip the test (say why) when there is no real VM to run it on. */
function unavailable(t: TestContext, browser = false): boolean {
    const why =
        dir === undefined
            ? "PI_POCKET_GONDOLIN_REAL is not set"
            : check?.ok !== true
              ? "this host cannot run a VM"
              : browser && !check.images.some((image) => image.name === "pocket-browser:latest")
                ? "the image with a browser is not in the store"
                : undefined;

    if (why !== undefined) {
        t.skip(why);
    }

    return why !== undefined;
}

test("a real VM runs a command in the folder, and its writes reach the host", async (t) => {
    if (unavailable(t)) {
        return;
    }

    const { result, output } = await run("cat hello.txt && pwd && echo made > made.txt && id -u");

    assert.ok(result.ok, JSON.stringify(result));
    assert.equal(result.value.exitCode, 0);
    assert.match(output, /hello from the host/);
    assert.ok(output.includes(work));
    assert.equal(readFileSync(join(work, "made.txt"), "utf8"), "made\n");
});

test("the VM has no secrets: none of the host's variables, none of its files outside the folder", async (t) => {
    if (unavailable(t)) {
        return;
    }

    process.env.GONDOLIN_REAL_SECRET = "not-a-real-value";
    const { output } = await run(
        "env; ls -d /home /root /etc/passwd; ls /home; cat $HOME/.pi/agent/auth.json 2>&1; ls /mnt",
    );

    delete process.env.GONDOLIN_REAL_SECRET;
    assert.ok(!output.includes("not-a-real-value"));
    assert.ok(
        !output.includes(process.env.HOME ?? "/nonexistent-home") ||
            (process.env.HOME ?? "") === "/root",
    );
    assert.match(output, /No such file|can't open/);
});

test("git config and hooks cannot be written from the VM; other files can", async (t) => {
    if (unavailable(t)) {
        return;
    }

    const config = await run("echo '[core]\nfsmonitor = evil' >> .git/config; echo rc=$?");
    const hook = await run("echo evil > .git/hooks/pre-commit; echo rc=$?");

    assert.match(config.output, /rc=[1-9]/);
    assert.match(hook.output, /rc=[1-9]/);
    assert.equal(readFileSync(join(work, ".git", "config"), "utf8"), "[core]\n");
    assert.equal(existsSync(join(work, ".git", "hooks", "pre-commit")), false);
    assert.ok((await run("echo ok > .git/other && echo fine")).output.includes("fine"));
});

test("a command that is stopped ends in the guest too", async (t) => {
    if (unavailable(t)) {
        return;
    }

    const env = manager!.envFor(1, { rootId: 1, cwd: work, uploadDir: undefined });
    const stop = new AbortController();
    const started = env.exec("tail -f /dev/null", {}, {
        ...context,
        abortSignal: stop.signal,
    } as never);

    setTimeout(() => stop.abort(), 500);
    const result = await started;

    assert.equal(result.ok, false);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const left = await run("ps | grep -c '[t]ail -f'");

    assert.match(left.output.trim(), /^0$/);
    const timed = await env.exec("tail -f /dev/null", { timeout: 1 }, context);

    assert.equal(timed.ok === false && timed.error.code, "timeout");
});

test("the network follows the allow list, and never reaches this machine", async (t) => {
    if (unavailable(t)) {
        return;
    }

    const allowed = await run(
        "curl -sS -m 10 -o /dev/null -w '%{http_code}' https://example.com/; echo",
    );
    const other = await run(
        "curl -sS -m 10 -o /dev/null -w '%{http_code}' https://www.iana.org/; echo",
    );
    const local = await run(
        "curl -sS -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:1/; echo; curl -sS -m 5 -o /dev/null -w '%{http_code}' http://192.168.1.1/; echo",
    );

    assert.match(allowed.output, /200/);
    assert.match(other.output, /403|000|blocked/i);
    assert.ok(!/200/.test(local.output));
});

test("files go through the guest: read, write, list, stat, rename, remove", async (t) => {
    if (unavailable(t)) {
        return;
    }

    const env = manager!.envFor(1, { rootId: 1, cwd: work, uploadDir: undefined });

    assert.ok(
        (await env.writeFile("sub/a.txt", "x", context)).ok === false,
        "no parent folder yet",
    );
    assert.ok((await env.createDir("sub", { recursive: true }, context)).ok);
    assert.ok((await env.writeFile("sub/a.txt", "x", context)).ok);
    assert.equal(readFileSync(join(work, "sub", "a.txt"), "utf8"), "x");
    const read = await env.readTextFile("sub/a.txt", context);

    assert.ok(read.ok && read.value === "x");
    const info = await env.fileInfo("sub/a.txt", context);

    assert.ok(info.ok && info.value.kind === "file" && info.value.size === 1);
    const missing = await env.readTextFile("nope.txt", context);

    assert.ok(!missing.ok && missing.error.code === "not_found");
    assert.ok((await env.renameFile("sub/a.txt", "sub/b.txt", context)).ok);
    const list = await env.listDir("sub", context);

    assert.ok(list.ok && list.value.map((entry) => entry.name).join() === "b.txt");
    assert.ok((await env.remove("sub", { recursive: true }, context)).ok);
    assert.equal(existsSync(join(work, "sub")), false);
    // A file outside the folder is the guest's own, not this machine's.
    const outside = await env.readTextFile(join(process.env.HOME ?? "/root", ".bashrc"), context);

    assert.ok(!outside.ok || !outside.value.includes(process.env.HOME ?? "never"));
});

test("a VM that crashed leaves a runner that the next start ends", async (t) => {
    if (unavailable(t)) {
        return;
    }

    const vms = new SandboxManager({
        driver: driver!,
        log: () => {},
        pidFile: join(work, "..", `reap-${process.pid}.json`),
        settings: () => ({
            backend: "auto",
            mount: "ro",
            network: "off",
            allowedHosts: [],
            cpus: 1,
            memoryMb: 512,
            diskMb: 1024,
            idleMinutes: 0,
            maxVms: 1,
            image: "alpine-base:latest",
        }),
    });
    const env = vms.envFor(9, { rootId: 9, cwd: work, uploadDir: undefined });
    const result = await env.exec("echo up", {}, context);

    assert.ok(result.ok);
    const [first] = JSON.parse(
        readFileSync(join(work, "..", `reap-${process.pid}.json`), "utf8"),
    ) as { pid: number }[];
    const pid = first!.pid;

    // The server dies without closing the VM: a new manager reads the file.
    const next = new SandboxManager({
        ...{
            driver: driver!,
            log: () => {},
            pidFile: join(work, "..", `reap-${process.pid}.json`),
        },
        settings: () => ({}) as never,
    });

    assert.equal(await next.reapStale(), 1);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.throws(() => execFileSync("kill", ["-0", String(pid)], { stdio: "ignore" }));
    await vms.stopAll("done").catch(() => undefined);
    rmSync(join(work, "..", `reap-${process.pid}.json`), { force: true });
    rmSync(join(work, "..", `vms-${process.pid}.json`), { force: true });
    void network;
});

// ─── The browser in the VM (needs the image `pocket-browser:latest`, which Set up builds) ─────────

import { createServer } from "node:http";
import { Browsers } from "../src/server/browser.ts";

test("the browser runs in the VM: a file of the folder, the VM's own server, an allowed site; not this machine's servers", async (t) => {
    if (unavailable(t, true)) {
        return;
    }

    const browserWork = mkdtempSync(join(tmpdir(), "gondolin-real-browser-"));
    const hostServer = createServer((_request, response) =>
        response.end("<title>THE HOST</title>"),
    );

    await new Promise<void>((resolve) => hostServer.listen(0, "127.0.0.1", resolve));
    const hostPort = (hostServer.address() as { port: number }).port;

    writeFileSync(join(browserWork, "page.html"), "<title>from the shared folder</title><p>hi</p>");
    const vms = new SandboxManager({
        driver: driver!,
        log: () => {},
        pidFile: join(work, "..", `browser-${process.pid}.json`),
        settings: () => ({
            backend: "auto",
            mount: "rw",
            network: "allowlist",
            allowedHosts: ["example.com"],
            cpus: 2,
            memoryMb: 2048,
            diskMb: 4096,
            idleMinutes: 0,
            maxVms: 1,
            image: "pocket-browser:latest",
        }),
    });
    const target = { rootId: 5, cwd: browserWork, uploadDir: undefined };
    const browsers = new Browsers({
        dataDir: browserWork,
        executable: null,
        remote: () => ({
            key: "vm:5",
            problem: () => undefined,
            launch: (flags) => vms.launchBrowser(target, flags),
        }),
    });

    try {
        // A server that Pi starts in the VM listens on the VM's own localhost.
        const env = vms.envFor(5, target);

        await env.exec(
            "cd /tmp && (python3 -m http.server 5173 --bind 127.0.0.1 >/dev/null 2>&1 &) ; true",
            {},
            context,
        );
        const page = await browsers.open(5);

        const title = async (url: string) => {
            await page.navigate(url, { timeoutMs: 20_000 }).catch(() => {});

            return page.state(true).title;
        };

        assert.match(
            await title(`file://${join(browserWork, "page.html")}`),
            /from the shared folder/,
        );
        assert.match(await title("http://127.0.0.1:5173/"), /Directory listing/);
        assert.match(await title("https://example.com/"), /Example Domain/);
        assert.doesNotMatch(await title(`http://127.0.0.1:${hostPort}/`), /THE HOST/);
        assert.doesNotMatch(await title("https://www.iana.org/"), /IANA/);
    } finally {
        await browsers.closeAll({ final: true });
        await vms.stopAll("the test ended");
        await new Promise((resolve) => hostServer.close(resolve));
        rmSync(browserWork, { recursive: true, force: true });
    }
});
