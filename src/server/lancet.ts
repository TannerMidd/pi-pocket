/**
 * Lancet Guard, borrowed from the user's Pi install.
 *
 * Pi Pocket runs its tools outside Pi, so Pi's extensions do not see them. This module loads the gate, rules, and
 * classifier of the installed `specpi-lancet-guard` package and exposes one `judge()` call. The guard's own settings
 * file (`~/.pi/lancet-guard.json`) decides whether it is on, exactly as it does inside Pi.
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";
import { describe } from "./errors.ts";

export type GateDecision =
    | { action: "allow"; source: string; reason: string; audited: boolean; score?: number }
    | { action: "block"; source: string; reason: string; score?: number; terminate: boolean }
    | { action: "ask"; source: string; reason: string; score?: number };

interface GuardSettings {
    enabled: boolean;
    [key: string]: unknown;
}

interface LancetModules {
    judgeCommand(
        command: string,
        shell: "bash",
        settings: GuardSettings,
        score: Scorer,
    ): Promise<GateDecision>;
    judgePath(target: string, cwd: string, settings: GuardSettings): GateDecision | undefined;
    loadSettings(globalFile: string, projectFile?: string): GuardSettings;
    classifier(): Promise<{ score: Scorer }>;
}

type Scorer = (
    command: string,
    shell: string,
) => Promise<{
    classification: "risky" | "not_flagged" | "review";
    score: number | null;
    reason: string | null;
    windows?: number;
}>;

export interface GuardStatus {
    available: boolean;
    enabled: boolean;
    detail: string;
}

export interface ToolJudgement {
    decision: GateDecision;
    /** What the decision is about, for the approval card: a command or a path. */
    subject: string;
}

const SHELL_TOOLS = new Set(["bash"]);
const FILE_TOOLS = new Set(["write", "edit"]);

export class LancetGuard {
    readonly directory: string | undefined;
    readonly settingsFile = join(homedir(), ".pi", "lancet-guard.json");
    #modules: Promise<LancetModules> | undefined;
    #loadError: string | undefined;
    readonly #verdicts = new Map<string, Awaited<ReturnType<Scorer>>>();

    /** True when PI_POCKET_GUARD=off turned the guard off for this process. */
    readonly disabled = process.env.PI_POCKET_GUARD === "off";

    constructor() {
        const candidates = [
            process.env.PI_POCKET_LANCET_DIR,
            join(getAgentDir(), "npm", "node_modules", "specpi-lancet-guard"),
            join(
                getAgentDir(),
                "git",
                "github.com",
                "TannerMidd",
                "SpecPi",
                "packages",
                "lancet-guard",
            ),
        ].filter((candidate): candidate is string => candidate !== undefined && candidate !== "");

        this.directory = candidates.find((candidate) =>
            existsSync(join(candidate, "src", "gate.ts")),
        );
    }

    #load(): Promise<LancetModules> {
        if (this.directory === undefined) {
            return Promise.reject(new Error("specpi-lancet-guard is not installed in Pi"));
        }

        this.#modules ??= (async () => {
            const src = join(this.directory!, "src");
            // The package ships TypeScript inside node_modules, which Node will not strip; jiti can.
            const jiti = createJiti(import.meta.url, { moduleCache: true });
            const gate = (await jiti.import(join(src, "gate.ts"))) as Pick<
                LancetModules,
                "judgeCommand" | "judgePath"
            >;
            const settings = (await jiti.import(join(src, "settings.ts"))) as Pick<
                LancetModules,
                "loadSettings"
            >;
            const runtime = (await import(pathToFileURL(join(src, "runtime.mjs")).href)) as {
                classifier(): Promise<{ score: Scorer }>;
                useRuntimeImporter(importer: () => Promise<unknown>): void;
            };
            const onnx = createRequire(join(src, "index.ts")).resolve("onnxruntime-node");

            runtime.useRuntimeImporter(() => import(pathToFileURL(onnx).href));

            return {
                judgeCommand: gate.judgeCommand,
                judgePath: gate.judgePath,
                loadSettings: settings.loadSettings,
                classifier: () => runtime.classifier(),
            };
        })();
        this.#modules.catch((error: unknown) => {
            this.#loadError = describe(error);
            this.#modules = undefined;
        });

        return this.#modules;
    }

    /**
     * Whether the settings file turns the guard on, read as the guard reads it: off unless `enabled` is true, and off
     * when the file is missing or unreadable. Needs none of the guard's code, so it answers when the guard cannot load.
     */
    #switchedOn(): boolean {
        try {
            const parsed: unknown = JSON.parse(
                readFileSync(this.settingsFile, "utf8").replace(/^\uFEFF/, ""),
            );

            return (
                typeof parsed === "object" &&
                parsed !== null &&
                (parsed as { enabled?: unknown }).enabled === true
            );
        } catch {
            return false;
        }
    }

    async status(): Promise<GuardStatus> {
        if (this.disabled) {
            return {
                available: false,
                enabled: false,
                detail: "Lancet Guard is off (PI_POCKET_GUARD=off); tools run unguarded.",
            };
        }

        if (this.directory === undefined) {
            return {
                available: false,
                enabled: false,
                detail: "Lancet Guard is not installed in Pi; tools run unguarded.",
            };
        }

        try {
            const modules = await this.#load();
            const settings = modules.loadSettings(this.settingsFile);

            return {
                available: true,
                enabled: settings.enabled === true,
                detail: settings.enabled
                    ? "Lancet Guard checks bash, write, and edit calls."
                    : `Lancet Guard is off in ${this.settingsFile}.`,
            };
        } catch (error) {
            const reason = this.#loadError ?? describe(error);

            return this.#switchedOn()
                ? {
                      available: false,
                      enabled: true,
                      detail: `Lancet Guard is on but failed to load, so bash, write, and edit calls are blocked: ${reason}`,
                  }
                : {
                      available: false,
                      enabled: false,
                      detail: `Lancet Guard failed to load (it is off in ${this.settingsFile}): ${reason}`,
                  };
        }
    }

    /** Warm the classifier so the first gated call does not pay for loading it. */
    async warm(): Promise<void> {
        if (this.disabled) {
            return;
        }

        const modules = await this.#load();

        if (modules.loadSettings(this.settingsFile).enabled) {
            await modules.classifier();
        }
    }

    /**
     * The guard's decision for one tool call, or undefined when the guard does not apply (another tool, or off).
     * Fails closed: a guard that is on but cannot load blocks the call. One that is off stays out of the way.
     */
    async judge(
        tool: string,
        args: Record<string, unknown>,
        cwd: string,
    ): Promise<ToolJudgement | undefined> {
        if (!SHELL_TOOLS.has(tool) && !FILE_TOOLS.has(tool)) {
            return undefined;
        }

        if (this.disabled || this.directory === undefined) {
            return undefined;
        }

        let modules: LancetModules;

        try {
            modules = await this.#load();
        } catch (error) {
            if (!this.#switchedOn()) {
                return undefined;
            }

            return {
                subject: tool,
                decision: {
                    action: "block",
                    source: "unavailable",
                    reason: `Lancet Guard could not load: ${describe(error)}`,
                    terminate: false,
                },
            };
        }

        const settings = modules.loadSettings(this.settingsFile);

        if (settings.enabled !== true) {
            return undefined;
        }

        if (SHELL_TOOLS.has(tool)) {
            const command = typeof args.command === "string" ? args.command : "";

            const score: Scorer = async (text, shell) => {
                const key = `${shell}\0${text}`;
                const hit = this.#verdicts.get(key);

                if (hit !== undefined) {
                    return hit;
                }

                const verdict = await (await modules.classifier()).score(text, shell);

                this.#verdicts.set(key, verdict);

                if (this.#verdicts.size > 200) {
                    this.#verdicts.delete(this.#verdicts.keys().next().value!);
                }

                return verdict;
            };

            return {
                subject: command,
                decision: await modules.judgeCommand(command, "bash", settings, score),
            };
        }

        const target = typeof args.path === "string" ? args.path : "";
        const decision = modules.judgePath(target, cwd, settings);

        return decision === undefined
            ? undefined
            : { subject: `${tool} ${target || "(missing path)"}`, decision };
    }
}
