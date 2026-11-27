/**
 * Opt-in Gondolin micro-VM sandboxes: run isolated coding sessions in disposable local Linux VMs with controlled
 * egress and reviewable patch export. Off by default.
 */
import { join } from "node:path";
import { defineExtension, section } from "@earendil-works/pi-durable";
import type { ExtensionWeb, PocketHost } from "../host.ts";
import { DEFAULT_IMAGE, GondolinDriver } from "./gondolin/driver.ts";
import {
    DEFAULT_ALLOWED_HOSTS,
    type Backend,
    type NetworkMode,
    type SandboxDriver,
    parseAllowedHosts,
} from "./gondolin/guest.ts";
import {
    SANDBOX_SCHEME,
    SandboxManager,
    type SandboxSettings,
    type SandboxSource,
    parseSandboxUri,
    sandboxUri,
} from "./gondolin/manager.ts";
import { applyPatchToNewBranch, validBranchName } from "./gondolin/patch.ts";

export const pocketApi = 2;

const EXTENSION_NAME = "pocket-gondolin";

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
    const n = typeof value === "number" ? value : Number(value);

    if (!Number.isFinite(n)) {
        return fallback;
    }

    return Math.min(max, Math.max(min, Math.round(n)));
}

function asBackend(value: unknown): Backend {
    return value === "krun" || value === "qemu" ? value : "auto";
}

function asNetworkMode(value: unknown): NetworkMode {
    return value === "off" || value === "open" ? value : "allowlist";
}

/** Optional test-only seam passed directly when calling the factory from unit tests. */
export interface GondolinOptions {
    driver?: SandboxDriver;
}

export default function createGondolin(
    host: PocketHost,
    web?: ExtensionWeb,
    options?: GondolinOptions,
) {
    if (typeof host.registerWorkspaceProvider !== "function") {
        return defineExtension({ name: EXTENSION_NAME });
    }

    const dir = join(host.dataDir, "gondolin");
    const driver = options?.driver ?? new GondolinDriver(dir);

    const readSettings = (): SandboxSettings => ({
        backend: asBackend(web?.setting("backend")),
        image: DEFAULT_IMAGE,
        networkMode: asNetworkMode(web?.setting("networkMode")),
        allowedHosts: parseAllowedHosts(
            typeof web?.setting("allowedHosts") === "string"
                ? (web.setting("allowedHosts") as string)
                : DEFAULT_ALLOWED_HOSTS.join(", "),
        ),
        memoryMb: clampInt(web?.setting("memoryMb"), 1024, 256, 16384),
        cpus: clampInt(web?.setting("cpus"), 2, 1, 16),
        diskMb: clampInt(web?.setting("diskMb"), 4096, 512, 65536),
        idleMinutes: clampInt(web?.setting("idleMinutes"), 30, 1, 480),
    });

    if (web !== undefined) {
        web.settings([
            {
                name: "backend",
                label: "VM backend",
                description:
                    "auto prefers libkrun (KVM on Linux, Hypervisor.framework on Apple Silicon) and falls back to QEMU.",
                type: "choice",
                choices: [
                    { value: "auto", label: "Auto (libkrun, then QEMU)" },
                    { value: "krun", label: "libkrun" },
                    { value: "qemu", label: "QEMU" },
                ],
                default: "auto",
            },
            {
                name: "networkMode",
                label: "Default network policy",
                description:
                    "allowlist permits only listed hostnames (default); off disables networking; open allows outbound internet (localhost/LAN stay blocked).",
                type: "choice",
                choices: [
                    { value: "allowlist", label: "Allow-list only" },
                    { value: "off", label: "Off (air-gapped)" },
                    { value: "open", label: "Open internet" },
                ],
                default: "allowlist",
            },
            {
                name: "allowedHosts",
                label: "Allowed hosts (allowlist mode)",
                description:
                    "Comma- or newline-separated hostnames reachable from sandboxes. Loopback and private IPs are always ignored.",
                type: "text",
                default: DEFAULT_ALLOWED_HOSTS.join(", "),
            },
            {
                name: "memoryMb",
                label: "VM memory (MiB)",
                description: "RAM allocated to each sandbox micro-VM (256–16384).",
                type: "number",
                default: 1024,
            },
            {
                name: "cpus",
                label: "VM vCPUs",
                description: "Virtual CPUs per sandbox micro-VM (1–16).",
                type: "number",
                default: 2,
            },
            {
                name: "diskMb",
                label: "VM root disk (MiB)",
                description: "Root filesystem size per sandbox micro-VM (512–65536).",
                type: "number",
                default: 4096,
            },
            {
                name: "idleMinutes",
                label: "Idle stop (minutes)",
                description:
                    "Minutes of inactivity before a VM snapshots /workspace and stops to free memory.",
                type: "number",
                default: 30,
            },
        ]);
    }

    const manager = new SandboxManager({
        dir,
        dataDir: host.dataDir,
        driver,
        settings: readSettings,
        onChange: () => web?.send("changed"),
    });

    const unregisterProvider = host.registerWorkspaceProvider(SANDBOX_SCHEME, {
        isolated: true,
        env: (cwd) => manager.env(cwd),
        resolveCwd: (cwd, signal) => manager.resolveCwd(cwd, signal),
        disposeWorkspace: (cwd) => manager.disposeWorkspace(cwd),
    });

    interface SetupState {
        promise: Promise<void>;
        lines: string[];
        abort: AbortController;
        error?: string;
    }

    let setupRunning: SetupState | null = null;

    if (web !== undefined) {
        web.onDispose(async () => {
            setupRunning?.abort.abort();
            unregisterProvider();
            await manager.closeAll();
        });

        web.client("gondolin", { access: "owner" });

        web.route(
            "GET",
            "status",
            async (request) => {
                const settings = readSettings();
                const check = await driver.check({
                    backend: settings.backend,
                    image: settings.image,
                });
                const sandboxByConversation: Record<number, string> = {};

                if (typeof request.sessions === "function") {
                    for (const session of request.sessions()) {
                        const sbId = parseSandboxUri(session.cwd);

                        if (sbId !== undefined) {
                            sandboxByConversation[session.id] = sbId;
                        }
                    }
                }

                return {
                    installed: driver.installed(),
                    check,
                    settings,
                    sandboxes: manager.list(),
                    sandboxByConversation,
                    setup:
                        setupRunning === null
                            ? { running: false }
                            : {
                                  running: true,
                                  lines: setupRunning.lines.slice(-40),
                                  ...(setupRunning.error === undefined
                                      ? {}
                                      : { error: setupRunning.error }),
                              },
                };
            },
            { access: "owner" },
        );

        web.route(
            "POST",
            "setup",
            async () => {
                if (setupRunning !== null) {
                    return { running: true, lines: setupRunning.lines.slice(-40) };
                }

                const abort = new AbortController();
                const state: SetupState = {
                    abort,
                    lines: [],
                    promise: Promise.resolve(),
                };

                setupRunning = state;
                web.send("changed");

                state.promise = driver
                    .setup((line) => {
                        state.lines.push(line);

                        if (state.lines.length > 200) {
                            state.lines.splice(0, state.lines.length - 200);
                        }

                        web.send("setup", { line });
                    }, abort.signal)
                    .catch((error: unknown) => {
                        state.error = error instanceof Error ? error.message : String(error);
                        host.notice("error", `Gondolin setup failed: ${state.error}`);
                    })
                    .finally(() => {
                        if (setupRunning === state) {
                            setupRunning = null;
                        }

                        web.send("changed");
                    });

                return { running: true, lines: state.lines };
            },
            { access: "owner" },
        );

        web.route("GET", "sandboxes", async () => ({ sandboxes: manager.list() }), {
            access: "owner",
        });

        web.route(
            "POST",
            "sandboxes",
            async (request) => {
                const body = request.body;
                const title =
                    typeof body.title === "string" && body.title.trim() !== ""
                        ? body.title.trim().slice(0, 80)
                        : undefined;
                const sourceKind =
                    body.source === "repo" || body.source === "git" ? body.source : "empty";
                let source: SandboxSource;

                if (sourceKind === "repo") {
                    if (typeof body.sourcePath !== "string" || body.sourcePath.trim() === "") {
                        throw web.error(400, "Enter a local project folder path to seed from.");
                    }

                    source = {
                        kind: "repo",
                        sourcePath: body.sourcePath.trim(),
                        ...(body.includeUncommitted === true ? { includeUncommitted: true } : {}),
                    };
                } else if (sourceKind === "git") {
                    if (typeof body.repoUrl !== "string" || body.repoUrl.trim() === "") {
                        throw web.error(400, "Enter an https:// git repository URL to clone.");
                    }

                    source = { kind: "git", repoUrl: body.repoUrl.trim() };
                } else {
                    source = { kind: "empty" };
                }

                const networkMode =
                    body.networkMode === "off" ||
                    body.networkMode === "allowlist" ||
                    body.networkMode === "open"
                        ? body.networkMode
                        : undefined;
                const allowedHosts =
                    typeof body.allowedHosts === "string"
                        ? parseAllowedHosts(body.allowedHosts)
                        : Array.isArray(body.allowedHosts)
                          ? parseAllowedHosts(
                                body.allowedHosts.filter(
                                    (each): each is string => typeof each === "string",
                                ),
                            )
                          : undefined;

                let record;

                try {
                    record = manager.create({
                        ...(title === undefined ? {} : { name: title }),
                        source,
                        ...(networkMode === undefined ? {} : { networkMode }),
                        ...(allowedHosts === undefined ? {} : { allowedHosts }),
                    });
                } catch (error) {
                    throw web.error(400, error instanceof Error ? error.message : String(error));
                }

                const cwd = sandboxUri(record.id);

                try {
                    const created = await request.createSession({
                        cwd,
                        title: title ?? `Sandbox · ${record.name}`,
                    });

                    return {
                        sandbox: manager.list().find((s) => s.id === record.id),
                        conversationId: Number(created.id),
                    };
                } catch (error) {
                    await manager.remove(record.id).catch(() => undefined);

                    throw error;
                }
            },
            { access: "owner" },
        );

        web.route(
            "POST",
            "sandboxes/:id/stop",
            async (request) => {
                const id = request.params.id!;

                if (manager.get(id) === undefined) {
                    throw web.error(404, "Sandbox not found.");
                }

                try {
                    await manager.stop(id, { saveSnapshot: true });
                } catch (error) {
                    throw web.error(
                        409,
                        `VM kept running because saving /workspace failed: ${error instanceof Error ? error.message : String(error)}`,
                    );
                }

                return { ok: true };
            },
            { access: "owner" },
        );

        web.route(
            "POST",
            "sandboxes/:id/reset",
            async (request) => {
                const id = request.params.id!;

                if (manager.get(id) === undefined) {
                    throw web.error(404, "Sandbox not found.");
                }

                await manager.reset(id);

                return { ok: true };
            },
            { access: "owner" },
        );

        web.route(
            "DELETE",
            "sandboxes/:id",
            async (request) => {
                const id = request.params.id!;

                if (manager.get(id) === undefined) {
                    throw web.error(404, "Sandbox not found.");
                }

                await manager.remove(id);

                return { ok: true };
            },
            { access: "owner" },
        );

        web.route(
            "GET",
            "sandboxes/:id/diff",
            async (request) => {
                const id = request.params.id!;
                const record = manager.get(id);

                if (record === undefined) {
                    throw web.error(404, "Sandbox not found.");
                }

                try {
                    const inspection = await manager.diff(id, request.signal);

                    return {
                        ...inspection,
                        sourceRepo:
                            record.source.kind === "repo" ? record.source.sourcePath : undefined,
                    };
                } catch (error) {
                    throw web.error(409, error instanceof Error ? error.message : String(error));
                }
            },
            { access: "owner" },
        );

        web.route(
            "POST",
            "sandboxes/:id/apply",
            async (request) => {
                const id = request.params.id!;
                const record = manager.get(id);

                if (record === undefined) {
                    throw web.error(404, "Sandbox not found.");
                }

                const repoPath =
                    typeof request.body.repoPath === "string" && request.body.repoPath.trim() !== ""
                        ? request.body.repoPath.trim()
                        : record.source.kind === "repo"
                          ? record.source.sourcePath
                          : undefined;

                if (repoPath === undefined) {
                    throw web.error(400, "Specify a target local git repository path.");
                }

                const branchName =
                    typeof request.body.branchName === "string" &&
                    request.body.branchName.trim() !== ""
                        ? request.body.branchName.trim()
                        : `sandbox/${id}`;

                if (!validBranchName(branchName)) {
                    throw web.error(400, `Invalid branch name "${branchName}".`);
                }

                const expectedPatchHash =
                    typeof request.body.patchHash === "string"
                        ? request.body.patchHash.trim().toLowerCase()
                        : "";

                if (!/^[0-9a-f]{64}$/.test(expectedPatchHash)) {
                    throw web.error(
                        400,
                        "Review the diff first: a valid patchHash is required to apply.",
                    );
                }

                const commitMessage =
                    typeof request.body.commitMessage === "string"
                        ? request.body.commitMessage.trim()
                        : undefined;

                let inspection;

                try {
                    inspection = await manager.diff(id, request.signal);
                } catch (error) {
                    throw web.error(409, error instanceof Error ? error.message : String(error));
                }

                if (inspection.patchHash !== expectedPatchHash) {
                    throw web.error(
                        409,
                        "Sandbox changes were modified after you opened the review. Refresh the diff and review it again before applying.",
                    );
                }

                if (!inspection.ok) {
                    throw web.error(
                        400,
                        `Patch blocked for safety: ${inspection.blocked.join(" ")}`,
                    );
                }

                if (inspection.files.length === 0) {
                    throw web.error(400, "There are no changes to apply.");
                }

                try {
                    return await applyPatchToNewBranch({
                        repoPath,
                        branchName,
                        patch: inspection.patch,
                        ...(commitMessage === undefined ? {} : { commitMessage }),
                    });
                } catch (error) {
                    throw web.error(409, error instanceof Error ? error.message : String(error));
                }
            },
            { access: "owner" },
        );
    }

    return defineExtension({
        name: EXTENSION_NAME,
        sections: [
            section("gondolin_sandbox", async (input) => {
                const cwd = input.agent.cwd ?? "";
                const id = parseSandboxUri(cwd);

                if (id === undefined) {
                    return undefined;
                }

                const record = manager.get(id);
                const settings = readSettings();
                const mode = record?.networkMode ?? settings.networkMode;
                const hosts = record?.allowedHosts ?? settings.allowedHosts;
                const netLine =
                    mode === "off"
                        ? "Network egress: disabled."
                        : mode === "open"
                          ? "Network egress: outbound internet allowed (host localhost and LAN blocked)."
                          : `Network egress: allow-list only (${hosts.join(", ") || "none"}).`;

                const parts = [
                    `You are running inside an isolated Gondolin Linux micro-VM sandbox (${id}).`,
                    "Your working directory inside the VM is /workspace on the VM's private disk.",
                    "Host files, host browser, host MCP servers, and host credentials are unreachable.",
                    netLine,
                    "Changes stay inside the VM until the owner reviews the diff and explicitly exports or applies them to a new branch.",
                ];

                const agentsMd = await manager.readGuestAgentsMd(cwd);

                if (agentsMd !== undefined) {
                    const fenced = host.text?.defang ? host.text.defang(agentsMd) : agentsMd;

                    parts.push(
                        `<sandbox_agents_md path="/workspace/AGENTS.md">\n${fenced}\n</sandbox_agents_md>`,
                    );
                }

                return parts.join("\n");
            }),
        ],
    });
}
