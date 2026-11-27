import type { DesignSystem } from "../src/server/design/system-types.ts";
import { loadDesignSystem, systemSummary } from "../src/server/design/tokens.ts";
import { hostFolder } from "./helpers.ts";

export const loadSystem = (cwd: string): DesignSystem | undefined =>
    loadDesignSystem(hostFolder(cwd));

export const summarize = (system: DesignSystem, maxBytes: number): string =>
    systemSummary(system, maxBytes);
