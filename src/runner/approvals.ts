/** Folder grants are permanent; session grants expire after runner-observed idle time. */
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import { broadFolder, coveredFolder, realFolder } from "./folders.ts";
import { checkCode } from "./totp.ts";
import type { RunnerSettings } from "./runner.ts";

export type ApprovalMethod = "computer" | "automatic" | "totp";
export type SessionPermission = {
    id: string;
    folder: string;
    person: string;
    approvedBy: ApprovalMethod;
    approvedAt: number;
    idleAt: number;
    ttlMs: number | null;
};
export type SessionScope = { id: string; folder: string; person: string };
export type ApprovalState = {
    totp: boolean;
    settings: {
        stopAsking: boolean;
        totpDays: number | null;
        allowHttp: boolean;
        network: boolean;
        downloads: string | null;
    };
    folders: string[];
    sessions: (SessionPermission & { inUse: boolean; expiresAt: number | null })[];
};
export type RunnerAction =
    | { action: "settings"; code: string; change: Record<string, unknown> }
    | { action: "remove-folder"; folder: string }
    | { action: "revoke"; session: string };

export class Approvals {
    readonly #read: () => RunnerSettings;
    readonly #save: (change: RunnerSettings) => void | Promise<void>;
    readonly #computerMs: number;
    readonly #active = new Map<string, number>();
    #writes = Promise.resolve();

    constructor(
        read: () => RunnerSettings,
        save: (change: RunnerSettings) => void | Promise<void>,
        computerMs = 30 * 60 * 60_000,
    ) {
        this.#read = read;
        this.#save = save;
        this.#computerMs = computerMs;
    }

    async change(make: (settings: RunnerSettings) => RunnerSettings): Promise<void> {
        const write = this.#writes.catch(() => {}).then(() => this.#save(make(this.#read())));

        this.#writes = write;
        await write;
    }

    async valid(named: SessionScope | string): Promise<SessionPermission | undefined> {
        // A failed save is reported where it was made; checks read what the file holds.
        await this.#writes.catch(() => {});
        const scope =
            typeof named === "string"
                ? (this.#read().sessions ?? []).find((entry) => entry.id === named)
                : named;

        if (scope === undefined) {
            return undefined;
        }

        const folder = await realFolder(scope.folder);
        const permission = (this.#read().sessions ?? []).find(
            (entry) => entry.id === scope.id && entry.folder === folder,
        );

        return permission !== undefined &&
            (this.#active.has(scope.id) ||
                permission.ttlMs === null ||
                Date.now() < permission.idleAt + permission.ttlMs)
            ? permission
            : undefined;
    }

    async approve(scope: SessionScope, method: ApprovalMethod): Promise<void> {
        await this.change((settings) => {
            const now = Date.now();
            const days = settings.totpDays === undefined ? 7 : settings.totpDays;
            const permission: SessionPermission = {
                ...scope,
                approvedBy: method,
                approvedAt: now,
                idleAt: now,
                ttlMs:
                    method === "totp"
                        ? days === null
                            ? null
                            : days * 86_400_000
                        : this.#computerMs,
            };

            return {
                sessions: [
                    ...(settings.sessions ?? []).filter((p) => p.id !== scope.id),
                    permission,
                ],
            };
        });
    }

    async saveFolder(folder: string): Promise<void> {
        const home = await realFolder(homedir());

        if (!broadFolder(folder, home)) {
            await this.change((settings) => ({
                folders: [...new Set([...(settings.folders ?? []), folder])],
            }));
        }
    }

    /** A live request keeps use until its terminal result, including a cancelled command's final result. */
    begin(id: string): () => void {
        this.#active.set(id, (this.#active.get(id) ?? 0) + 1);
        let ended = false;

        return () => {
            if (ended) {
                return;
            }

            ended = true;
            const active = (this.#active.get(id) ?? 1) - 1;

            if (active > 0) {
                this.#active.set(id, active);
            } else {
                this.#active.delete(id);
                void this.change((settings) => ({
                    sessions: (settings.sessions ?? []).map((p) =>
                        p.id === id ? { ...p, idleAt: Date.now() } : p,
                    ),
                })).catch(() => {});
            }
        };
    }

    async code(code: string): Promise<boolean> {
        let valid = false;

        await this.change((settings) => {
            if (settings.totp === undefined) {
                return {};
            }

            const totp = structuredClone(settings.totp);

            valid = checkCode(totp, code);

            return { totp };
        });

        return valid;
    }

    async state(): Promise<ApprovalState> {
        await this.#writes.catch(() => {});
        const settings = this.#read();
        const folders: string[] = [];

        for (const folder of settings.folders ?? []) {
            if (await coveredFolder(await realFolder(folder), [folder])) {
                folders.push(folder);
            }
        }

        return {
            totp: settings.totp !== undefined,
            settings: {
                stopAsking: settings.confirm === false,
                totpDays: settings.totpDays === undefined ? 7 : settings.totpDays,
                allowHttp: settings.allowHttp === true,
                network: settings.network !== false,
                downloads: settings.downloads ?? null,
            },
            folders,
            sessions: (settings.sessions ?? []).map((permission) => ({
                ...permission,
                inUse: this.#active.has(permission.id),
                expiresAt:
                    this.#active.has(permission.id) || permission.ttlMs === null
                        ? null
                        : permission.idleAt + permission.ttlMs,
            })),
        };
    }

    async action(action: RunnerAction): Promise<void> {
        if (action.action === "revoke") {
            await this.change((s) => ({
                sessions:
                    action.session === "all"
                        ? []
                        : (s.sessions ?? []).filter((p) => p.id !== action.session),
            }));
        } else if (action.action === "remove-folder") {
            await this.change((s) => ({
                folders: (s.folders ?? []).filter((p) => p !== action.folder),
            }));
        } else {
            const { change } = action;
            const settings: RunnerSettings = {};

            if (Object.keys(change).length !== 1) {
                throw new Error("Change one runner setting at a time.");
            }

            for (const [key, value] of Object.entries(change)) {
                if (key === "stopAsking" && typeof value === "boolean") {
                    settings.confirm = !value;
                } else if (key === "allowHttp" && typeof value === "boolean") {
                    settings.allowHttp = value;
                } else if (key === "network" && typeof value === "boolean") {
                    settings.network = value;
                } else if (
                    key === "totpDays" &&
                    (value === null || [1, 7, 14, 30].includes(value as number))
                ) {
                    settings.totpDays = value as number | null;
                } else if (
                    key === "downloads" &&
                    (value === null || (typeof value === "string" && isAbsolute(value)))
                ) {
                    settings.downloads = value ?? undefined;
                } else {
                    throw new Error(`Invalid runner setting: ${key}`);
                }
            }

            if (this.#read().totp === undefined) {
                throw new Error(
                    "Set up an authenticator on this computer to change its settings from Pi Pocket.",
                );
            }

            if (!(await this.code(action.code))) {
                throw new Error("That code is wrong or used. Try the next one.");
            }

            await this.change(() => settings);
        }
    }
}
