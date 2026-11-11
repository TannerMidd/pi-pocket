/** Trusted project model defaults for new sessions only; resource paths and run policy stay app-wide. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { clampThinkingLevel, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
    getAgentDir,
    type ModelRuntime,
    ProjectTrustStore,
    SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { HttpError } from "./errors.ts";
import { isThinkingLevel } from "./models.ts";

/** Fresh global defaults and trust policy for this creation only. Never reload or replace the shared app reader. */
export function globalModelSettings(cwd: string): SettingsManager {
    const settings = piGlobalSettings(cwd);

    if (settings.drainErrors().length > 0) {
        throw new HttpError(
            400,
            "Pi global settings.json cannot be read. Check its JSON and file access. No session was created.",
        );
    }

    return settings;
}

/** The level a person last chose for a model, from Pi's global `modelThinkingLevels`, as Pi's TUI keeps it. */
export function rememberedLevel(
    settings: SettingsManager,
    provider: string,
    modelId: string,
): ModelThinkingLevel | undefined {
    const level = settings.getModelThinkingLevel(provider, modelId);

    return isThinkingLevel(level) ? level : undefined;
}

/** Read Pi's global settings fresh, so a level set in the TUI counts and a write keeps the TUI's other entries. */
export function piGlobalSettings(cwd: string): SettingsManager {
    return SettingsManager.create(cwd, getAgentDir(), { projectTrusted: false });
}

/** Remember a person's level for a model in Pi's own map. A failed save leaves the file and the session as they are. */
export async function rememberLevel(
    cwd: string,
    provider: string,
    modelId: string,
    level: ModelThinkingLevel,
): Promise<void> {
    try {
        const settings = piGlobalSettings(cwd);

        if (settings.getModelThinkingLevel(provider, modelId) !== level) {
            settings.setModelThinkingLevel(provider, modelId, level);
            await settings.flush();
        }

        settings.drainErrors();
    } catch {
        // Pi's settings stay as they were.
    }
}

/** No project setting, including defaultProjectTrust, can grant trust to itself. Unreadable trust fails closed. */
export function projectModelTrusted(cwd: string, settings: SettingsManager): boolean {
    try {
        const saved = new ProjectTrustStore(getAgentDir()).getEntry(cwd);

        return saved?.decision ?? settings.getDefaultProjectTrust() === "always";
    } catch {
        return false;
    }
}

/** Read at creation, without a cache. Errors contain no file contents and never lead to another paid model. */
export function projectModelDefault(cwd: string, settings: SettingsManager, models: ModelRuntime) {
    if (!projectModelTrusted(cwd, settings)) {
        return undefined;
    }

    const fail = (detail: string): never => {
        throw new HttpError(400, `Project .pi/settings.json: ${detail} No session was created.`);
    };

    let text: string;

    try {
        text = readFileSync(join(cwd, ".pi", "settings.json"), "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return undefined;
        }

        return fail("Cannot read the file.");
    }

    let value: unknown;

    try {
        value = JSON.parse(text.replace(/^\uFEFF/, ""));
    } catch {
        return fail("Invalid JSON. Check the file.");
    }

    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return fail("Expected a JSON object.");
    }

    const {
        defaultProvider: provider,
        defaultModel: id,
        defaultThinkingLevel: thinking,
    } = value as {
        defaultProvider?: unknown;
        defaultModel?: unknown;
        defaultThinkingLevel?: unknown;
    };

    if (thinking !== undefined && (typeof thinking !== "string" || !isThinkingLevel(thinking))) {
        return fail(
            "Invalid defaultThinkingLevel. Use off, minimal, low, medium, high, xhigh, or max.",
        );
    }

    // A thinking-only setting does not change an owner's or last-picked model/thinking pair.
    if (provider === undefined && id === undefined) {
        return undefined;
    }

    if (
        typeof provider !== "string" ||
        provider.trim() === "" ||
        typeof id !== "string" ||
        id.trim() === ""
    ) {
        return fail("Set both defaultProvider and defaultModel to non-empty strings.");
    }

    // Unlike availability, the catalog includes known models whose provider is not signed in now.
    const model = models.getModel(provider, id);

    if (model === undefined) {
        return fail("The provider or model is not known. Check defaultProvider and defaultModel.");
    }

    return {
        model,
        thinkingLevel: clampThinkingLevel(model, (thinking ?? "off") as ModelThinkingLevel),
    };
}
